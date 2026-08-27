"""Sequential runner for the LongPuzzleBench visual puzzle benchmark.

The runner intentionally keeps agent input and evaluator state on separate
code paths.  Agents receive the same screenshot/tool-call dictionary used by
the Android runner; only this module and :class:`MiniGameEvaluator` read the
private in-page benchmark bridge.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import time
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from statistics import fmean
from typing import Any, cast

from loguru import logger
from rich.console import Console
from rich.table import Table

from mobile_world.agents.base import BaseAgent
from mobile_world.agents.providers.catalog import resolve_provider_name
from mobile_world.agents.registry import create_agent
from mobile_world.benchmarks.catalog import MiniGameCatalog, load_catalog
from mobile_world.benchmarks.evaluator import MiniGameEvaluator, deadlock_diagnostic
from mobile_world.benchmarks.models import (
    CycleDetectionConfig,
    EpisodeResult,
    ExperimentSettings,
    MiniGameTaskSpec,
    PromptSetting,
    ScoreBreakdown,
    TerminationReason,
)
from mobile_world.benchmarks.progress import level_progress_from_state
from mobile_world.benchmarks.results import ResultWriter, comparable_metrics
from mobile_world.runtime.action_outcome import (
    LEVEL_PROGRESS_KEY,
    ActionOutcomeTracker,
)
from mobile_world.runtime.no_progress_cycle_detector import (
    NoProgressCycleDecision,
    NoProgressCycleDetector,
)
from mobile_world.runtime.utils.models import (
    CLICK,
    DOUBLE_TAP,
    DRAG,
    ENV_FAIL,
    LONG_PRESS,
    PRESS,
    RELEASE,
    SCROLL,
    SWIPE,
    UNKNOWN,
    WAIT,
    PublicActionFeedback,
)
from mobile_world.runtime.utils.trajectory_logger import TrajLogger
from mobile_world.runtime.web_game_client import (
    DEFAULT_HEADED_MAX_VIEWPORT_HEIGHT,
    DEFAULT_HEADED_MAX_VIEWPORT_WIDTH,
    WebGameEnvClient,
    game_state_fingerprint,
    screenshot_sha256,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG = Path("configs/longpuzzlebench.json")
DEFAULT_COCOS_CREATOR_MAC = Path(
    "/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/MacOS/CocosCreator"
)
WEB_GAME_ACTION_TYPES = {
    CLICK,
    "tap",
    DOUBLE_TAP,
    "double_click",
    LONG_PRESS,
    PRESS,
    RELEASE,
    DRAG,
    SWIPE,
    SCROLL,
    WAIT,
}


@dataclass(frozen=True, slots=True)
class _AgentEnvironmentView:
    """Least-privilege compatibility object supplied to Agent constructors."""

    tools: list[dict[str, Any]]


def _objective_progress_payload(state: dict[str, Any], *, game_id: str) -> dict[str, Any]:
    """Return the level-progress score used for no-progress termination.

    The score is the same white-box P(s) used for episode scoring.  Only a
    strictly larger value counts as the level getting better.  Accepted but
    unproductive board edits, rejected attempts, and elapsed-time telemetry
    stay out of this payload so they cannot reset no-progress counters.
    """

    score, process_metrics = level_progress_from_state(game_id, state)
    return {
        LEVEL_PROGRESS_KEY: score,
        "process_metrics": process_metrics,
    }


def _objective_progress_fingerprint(state: dict[str, Any], *, game_id: str) -> str:
    payload = json.dumps(
        _objective_progress_payload(state, game_id=game_id),
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def _state_diagnostic(state: dict[str, Any], *, game_id: str) -> dict[str, Any]:
    """Persist non-answer evaluator indicators and hashes for step alignment."""

    return {
        **_objective_progress_payload(state, game_id=game_id),
        "raw_metrics": state.get("raw_metrics", {}),
        "state_sha256": game_state_fingerprint(state),
        "objective_progress_sha256": _objective_progress_fingerprint(state, game_id=game_id),
    }


def _episode_deadlock_diagnostic(
    state: dict[str, Any],
    *,
    task: MiniGameTaskSpec,
    step: int,
) -> dict[str, Any]:
    """Add episode identity and a detached state signature to rule evidence."""

    diagnostic = deadlock_diagnostic(state, detected_at_step=step)
    if not diagnostic:
        return {}
    diagnostic.update(
        {
            "task_id": task.task_id,
            "level_id": task.level_id,
            "game_state_signature": game_state_fingerprint(state),
            "benchmark_terminates": bool(diagnostic.get("is_deadlocked")),
        }
    )
    return diagnostic


def _csv(value: str | None) -> list[str] | None:
    if value is None:
        return None
    items = [item.strip() for item in value.split(",") if item.strip()]
    return items or None


def _resolve_config(path: str | None) -> Path:
    candidate = Path(path).expanduser() if path else DEFAULT_CONFIG
    if candidate.is_file():
        return candidate.resolve()
    repository_candidate = REPOSITORY_ROOT / candidate
    if repository_candidate.is_file():
        return repository_candidate.resolve()
    raise FileNotFoundError(f"LongPuzzleBench config not found: {candidate}")


def _git_revision(path: Path) -> str | None:
    try:
        head = subprocess.check_output(
            ["git", "-C", str(path), "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        dirty = (
            subprocess.call(
                ["git", "-C", str(path), "diff", "--quiet", "--ignore-submodules", "HEAD"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            != 0
        )
        return head + ("+dirty" if dirty else "")
    except (OSError, subprocess.CalledProcessError):
        return None


def _file_digest(paths: list[Path], *, root: Path) -> str:
    digest = hashlib.sha256()
    resolved_root = root.resolve()
    for path in sorted({item.resolve() for item in paths if item.is_file()}):
        try:
            stable_name = path.relative_to(resolved_root).as_posix()
        except ValueError:
            stable_name = path.name
        digest.update(stable_name.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _benchmark_version(config_path: Path) -> str:
    repository = REPOSITORY_ROOT
    sources = [
        *repository.joinpath("src/mobile_world").rglob("*.py"),
        config_path,
    ]
    revision = _git_revision(repository) or "no-git"
    return f"{revision}:tree-{_file_digest(sources, root=repository)[:16]}"


def _environment_version(catalog: MiniGameCatalog) -> str:
    project_value = catalog.environment.project_path
    if not project_value:
        return f"external:{catalog.environment.base_url or 'unspecified'}"
    project = Path(project_value).expanduser()
    if not project.is_absolute():
        project = REPOSITORY_ROOT / project
    project = project.resolve()
    revision = _git_revision(project) or "no-git"
    build = project / catalog.environment.build_directory
    existing = [path for path in build.rglob("*") if path.is_file()]
    build_hash = _file_digest(existing, root=project)[:16] if existing else "missing-build"
    return f"{revision}:build-{build_hash}"


def _select_tasks(
    catalog: MiniGameCatalog, args: argparse.Namespace
) -> tuple[MiniGameTaskSpec, ...]:
    # Formal LongPuzzleBench evaluation is selected only by game x difficulty.  The
    # catalogue keeps level/task filters for explicit developer tooling, but
    # the public ``mw eval`` surface never populates these debug-only fields.
    task_ids = _csv(getattr(args, "debug_task", None))
    if task_ids and len(task_ids) == 1 and task_ids[0].upper() == "ALL":
        task_ids = None
    levels = _csv(getattr(args, "debug_level", None))
    selected = catalog.filter(
        game_id=_csv(getattr(args, "game", None)),
        difficulty=_csv(getattr(args, "difficulty", None)),
        level_id=levels,
        task_id=task_ids,
    )
    if not selected:
        raise ValueError("No LongPuzzleBench tasks matched the requested filters")

    seed_values = _csv(getattr(args, "seeds", None))
    if seed_values is None:
        task_seed_pairs = [(task, task.seed) for task in selected]
    else:
        try:
            seeds = [int(seed) for seed in seed_values]
        except ValueError as exc:
            raise ValueError(
                "--seeds must be a comma-separated list of non-negative integers"
            ) from exc
        if any(seed < 0 for seed in seeds):
            raise ValueError("--seeds values must be non-negative")
        # De-duplicate the catalogue's seed dimension before applying an
        # explicit seed set, so every level is evaluated once per requested
        # seed. Without --seeds, preserve the catalogue exactly as declared.
        templates: dict[tuple[str, str, int | str], MiniGameTaskSpec] = {}
        for task in selected:
            templates.setdefault((task.game_id, task.difficulty, task.level_id), task)
        task_seed_pairs = [(task, seed) for task in templates.values() for seed in seeds]

    max_steps = getattr(args, "max_round", None)
    timeout_seconds = getattr(args, "timeout", None)
    expanded: list[MiniGameTaskSpec] = []
    for task, seed in task_seed_pairs:
        update: dict[str, Any] = {"seed": seed, "task_id": ""}
        if max_steps is not None and max_steps > 0:
            update["max_steps"] = max_steps
        if timeout_seconds is not None and timeout_seconds > 0:
            update["timeout_seconds"] = float(timeout_seconds)
        expanded.append(MiniGameTaskSpec.model_validate({**task.model_dump(), **update}))
    return tuple(expanded)


def _validate_public_selection(args: argparse.Namespace) -> None:
    """Enforce one public leaderboard cell per formal benchmark invocation."""

    game = _csv(getattr(args, "game", None))
    difficulty = _csv(getattr(args, "difficulty", None))
    if not game or len(game) != 1 or not difficulty or len(difficulty) != 1:
        raise ValueError(
            "LongPuzzleBench evaluation requires exactly one --game and one --difficulty; "
            "all configured levels are run automatically"
        )
    if getattr(args, "task", None) is not None:
        raise ValueError(
            "--task is not a public LongPuzzleBench filter; use --game and --difficulty"
        )
    if getattr(args, "level", None) is not None or getattr(args, "all_levels", False):
        raise ValueError(
            "single-level selection is not available in formal LongPuzzleBench evaluation"
        )


def _task_chains(
    tasks: tuple[MiniGameTaskSpec, ...],
) -> tuple[tuple[MiniGameTaskSpec, ...], ...]:
    """Group ordered levels into independent game/difficulty/seed chains."""

    groups: dict[tuple[str, str, int], list[MiniGameTaskSpec]] = defaultdict(list)
    for task in tasks:
        groups[(task.game_id, task.difficulty, task.seed)].append(task)
    return tuple(tuple(group) for group in groups.values())


def _find_cocos_creator(configured: str | None) -> str | None:
    if configured:
        return str(Path(configured).expanduser())
    executable = shutil.which("CocosCreator") or shutil.which("cocos")
    if executable:
        return executable
    if DEFAULT_COCOS_CREATOR_MAC.is_file():
        return str(DEFAULT_COCOS_CREATOR_MAC)
    return None


def _make_environment(
    catalog: MiniGameCatalog,
    evaluator: MiniGameEvaluator,
    args: argparse.Namespace,
) -> WebGameEnvClient:
    config = catalog.environment
    cli_base_url = getattr(args, "base_url", None)
    configured_base_url = cli_base_url or config.base_url
    project_path = getattr(args, "game_project", None) or config.project_path
    if project_path:
        project = Path(project_path).expanduser()
        if not project.is_absolute():
            project = REPOSITORY_ROOT / project
        project_path = str(project.resolve())
    build_on_start = bool(
        getattr(args, "rebuild", False)
        or (config.auto_build and not getattr(args, "skip_build", False))
    )
    cocos_creator = _find_cocos_creator(
        getattr(args, "cocos_creator", None) or config.cocos_creator_binary
    )
    headed_viewport_width = getattr(args, "headed_viewport_width", None)
    headed_viewport_height = getattr(args, "headed_viewport_height", None)

    externally_managed = bool(
        cli_base_url or (config.base_url is not None and config.server_command is None)
    )
    if externally_managed:
        # Do not pass local-build settings: WebGameEnvClient then treats the
        # supplied URL as externally managed and never owns that server.
        project_path = None
        build_directory = None
        server_command = None
        build_on_start = False
    else:
        build_directory = config.build_directory
        server_command = config.server_command
        if build_on_start and cocos_creator is None and server_command is None:
            raise RuntimeError(
                "Cocos Creator executable was not found. Configure "
                "--cocos-creator, pass --base-url, or use the included web build."
            )

    return WebGameEnvClient(
        base_url=configured_base_url,
        project_path=project_path,
        build_directory=build_directory,
        cocos_creator_binary=cocos_creator,
        auto_build=build_on_start,
        server_command=server_command,
        server_ready_timeout_seconds=config.server_ready_timeout_seconds,
        task_catalog=catalog,
        evaluator=evaluator,
        headless=False if getattr(args, "headed", False) else config.headless,
        viewport_width=config.viewport_width,
        viewport_height=config.viewport_height,
        headed_max_viewport_width=(
            DEFAULT_HEADED_MAX_VIEWPORT_WIDTH
            if headed_viewport_width is None
            else headed_viewport_width
        ),
        headed_max_viewport_height=(
            DEFAULT_HEADED_MAX_VIEWPORT_HEIGHT
            if headed_viewport_height is None
            else headed_viewport_height
        ),
        device_scale_factor=config.device_scale_factor,
        game_viewport_selector=config.game_viewport_selector,
        per_game_viewport_selectors=config.per_game_viewport_selectors,
        action_effect_timeout_seconds=config.action_effect_timeout_seconds,
        visual_stability_timeout_seconds=config.visual_stability_timeout_seconds,
        visual_poll_interval_seconds=config.visual_poll_interval_seconds,
        visual_change_threshold=config.visual_change_threshold,
        step_wait_time=float(
            config.step_wait_time
            if getattr(args, "step_wait_time", None) is None
            else args.step_wait_time
        ),
    )


def _explicit_cli_value(args: argparse.Namespace, name: str) -> Any | None:
    """Return a CLI override only when the flag was explicitly provided."""

    return getattr(args, name, None)


def _resolve_experiment_settings(
    catalog: MiniGameCatalog,
    args: argparse.Namespace,
) -> ExperimentSettings:
    updates: dict[str, Any] = {}
    prompt_setting = _explicit_cli_value(args, "prompt_setting")
    eval_mode = _explicit_cli_value(args, "eval_mode")
    if prompt_setting is not None:
        updates["prompt_setting"] = prompt_setting
    if eval_mode is not None:
        updates["eval_mode"] = eval_mode
    elif catalog.experiment.eval_mode != catalog.execution.resolve_eval_mode():
        updates["eval_mode"] = catalog.execution.resolve_eval_mode()
    return catalog.experiment.model_copy(update=updates) if updates else catalog.experiment


def _effective_history_n_images(args: argparse.Namespace) -> int | None:
    """Return an optional image cap. ``None`` keeps every historical screenshot."""

    images = getattr(args, "history_n_images", None)
    if images is None:
        return None
    resolved = int(images)
    if resolved < 0:
        raise ValueError("--history-n-images must be non-negative")
    return resolved


def _agent_information(
    args: argparse.Namespace,
    *,
    experiment: ExperimentSettings | None = None,
    history_n_images: int | None = None,
) -> dict[str, Any]:
    agent_type = args.agent_type
    info: dict[str, Any] = {
        "name": agent_type,
        "agent_type": agent_type,
        "model": getattr(args, "model_name", None),
        "model_name": getattr(args, "model_name", None),
        "model_provider": resolve_provider_name(
            getattr(args, "provider", None),
            base_url=getattr(args, "llm_base_url", None),
        ),
        "agent_framework": "longpuzzlebench_native",
        "leaderboard_track": "native_agent",
    }
    if experiment is not None:
        info.update(experiment.public_metadata(history_n_images=history_n_images))
    return info


def _make_agent(
    args: argparse.Namespace,
    env: WebGameEnvClient,
    *,
    experiment: ExperimentSettings,
    history_n_images: int | None,
) -> BaseAgent:
    if _explicit_cli_value(args, "context_setting") is not None:
        raise ValueError("--context-setting is deprecated")
    if getattr(args, "history_turns", None) is not None:
        raise ValueError("--history-turns is deprecated; general_e2e keeps full text history")
    agent_environment = _AgentEnvironmentView(list(env.tools))
    agent_kwargs: dict[str, Any] = {
        "executor_llm_base_url": getattr(args, "executor_llm_base_url", None),
        "executor_model_name": getattr(args, "executor_model_name", None),
        "executor_agent_class": getattr(args, "executor_agent_class", None),
        "model_provider": resolve_provider_name(
            getattr(args, "provider", None),
            base_url=getattr(args, "llm_base_url", None),
        ),
    }
    if args.agent_type == "general_e2e":
        runtime_conf: dict[str, Any] = {
            "mini_game_mode": True,
            "history_n_images": history_n_images,
            "temperature": getattr(args, "temperature", 0.0),
            "max_tokens": getattr(args, "max_output_tokens", 1024),
            "reasoning_effort": getattr(args, "reasoning_effort", "medium"),
        }
        agent_kwargs["runtime_conf"] = runtime_conf
    agent = cast(
        BaseAgent,
        create_agent(
            args.agent_type,
            getattr(args, "model_name", None) or "",
            getattr(args, "llm_base_url", None) or "",
            getattr(args, "api_key", None) or os.getenv("OPENAI_API_KEY") or "",
            env=agent_environment,
            **agent_kwargs,
        ),
    )
    apply_image_cap = args.agent_type == "general_e2e" or history_n_images is not None
    history_key: str | None = None
    if apply_image_cap and hasattr(agent, "history_n_images"):
        setattr(agent, "history_n_images", history_n_images)
        history_key = "history_n_images"
    elif apply_image_cap and hasattr(agent, "history_n"):
        setattr(agent, "history_n", history_n_images)
        history_key = "history_n"
    framework_config = getattr(agent, "_framework_runtime_conf", None)
    if history_key and isinstance(framework_config, dict):
        framework_config[history_key] = history_n_images
    return agent


def _agent_metrics(agent: BaseAgent) -> dict[str, Any]:
    getter = getattr(agent, "get_benchmark_metrics", None)
    if callable(getter):
        metrics = getter()
        if isinstance(metrics, dict):
            return dict(metrics)
    tokens = agent.get_total_token_usage()
    return {
        "model_calls": None,
        "input_tokens": tokens.get("prompt_tokens", 0),
        "output_tokens": tokens.get("completion_tokens", 0),
        "cached_tokens": tokens.get("cached_tokens", 0),
        "total_tokens": tokens.get("total_tokens", 0),
        "model_latency_seconds": None,
        "estimated_cost": None,
        "auxiliary_models": [],
    }


def _metric_delta(after: dict[str, Any], before: dict[str, Any]) -> dict[str, Any]:
    delta: dict[str, Any] = {}
    for key in (
        "model_calls",
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "total_tokens",
        "model_latency_seconds",
        "estimated_cost",
        "parse_failures",
        "provider_failures",
    ):
        current = after.get(key)
        previous = before.get(key)
        if isinstance(current, (int, float)) and isinstance(previous, (int, float)):
            delta[key] = current - previous
        else:
            delta[key] = current
    return delta


def _toggle_simulation(env: Any, paused: bool) -> dict[str, Any] | None:
    """Pause or resume the in-game clock around a model call when supported."""

    method = getattr(env, "pause_simulation" if paused else "resume_simulation", None)
    if not callable(method):
        return None
    try:
        result = method()
    except Exception as exc:
        logger.warning(
            "Could not {} game simulation during model inference: {}",
            "pause" if paused else "resume",
            exc,
        )
        return {"applied": False, "error": str(exc)}
    return result if isinstance(result, Mapping) else {"applied": True}


def _episode_budget_reason(
    *,
    play_elapsed: float,
    wall_elapsed: float,
    timeout_seconds: float,
    wall_clock_limit: float,
) -> str | None:
    if play_elapsed >= timeout_seconds:
        return "play_timeout"
    if wall_elapsed >= wall_clock_limit:
        return "wall_clock_guard"
    return None


def _safe_state(env: WebGameEnvClient, errors: list[str]) -> dict[str, Any]:
    try:
        return env.get_game_state()
    except Exception as exc:
        message = f"Could not read evaluator state: {exc}"
        errors.append(message)
        logger.exception(message)
        return {}


def _scored_state(env: WebGameEnvClient, errors: list[str]) -> dict[str, Any]:
    """Return the state the episode must be scored against.

    A game that auto-advances to its next level replaces the solved board
    before the episode is scored.  The environment latches the first terminal
    snapshot it sees, so the level's own outcome is scored instead of whatever
    the game happens to display when the episode stops.
    """

    getter = getattr(env, "get_latched_terminal_state", None)
    if callable(getter):
        try:
            latched = getter()
        except Exception as exc:
            errors.append(f"Could not read latched terminal state: {exc}")
            logger.exception("Could not read latched terminal state")
        else:
            if latched:
                return dict(latched)
    return _safe_state(env, errors)


def _execute_episode(
    *,
    env: WebGameEnvClient,
    evaluator: MiniGameEvaluator,
    task: MiniGameTaskSpec,
    agent: BaseAgent,
    traj_logger: TrajLogger,
    agent_information: dict[str, Any],
    run_index: int,
    no_progress_recovery_steps: int = 3,
    no_progress_termination_steps: int = 6,
    no_progress_max_cycle_length: int = 4,
    no_progress_perceptual_hash_threshold: int = 0,
    no_progress_mean_color_threshold: int = 3,
    cycle_detection: CycleDetectionConfig | None = None,
    invalid_action_limit: int = 3,
    wall_clock_timeout_slack_seconds: float = 7200.0,
) -> EpisodeResult:
    started_at = datetime.now(UTC)
    started = time.monotonic()
    play_elapsed = 0.0
    model_elapsed = 0.0
    wall_clock_limit = float(task.timeout_seconds) + float(wall_clock_timeout_slack_seconds)
    step = 0
    environment_steps = 0
    errors: list[str] = []
    trajectory: list[dict[str, Any]] = []
    observation_metadata: list[dict[str, Any]] = []
    timeout = False
    timeout_before_dispatch = False
    game_ended_during_prediction = False
    simulation_pause: list[dict[str, Any]] = []
    budget_stop_reason: str | None = None
    max_step_reached = False
    agent_terminated = False
    no_progress = False
    repeated_action_cycle = False
    invalid_action_limit_reached = False
    environment_error: str | None = None
    agent_error: str | None = None
    termination_reason: TerminationReason | None = None
    invalid_action_count = 0
    consecutive_invalid_actions = 0
    initialized_agent = False
    phase = "environment_initialization"
    last_cycle_decision: NoProgressCycleDecision | None = None
    deadlock: dict[str, Any] = {}
    cycle_config = cycle_detection or CycleDetectionConfig(
        max_cycle_length=no_progress_max_cycle_length,
        no_progress_steps=no_progress_termination_steps,
    )
    progress_tracker = ActionOutcomeTracker(
        recovery_steps=no_progress_recovery_steps,
        termination_steps=no_progress_termination_steps,
        max_cycle_length=no_progress_max_cycle_length,
        perceptual_hash_threshold=no_progress_perceptual_hash_threshold,
        mean_color_threshold=no_progress_mean_color_threshold,
    )
    cycle_detector = NoProgressCycleDetector(
        enabled=cycle_config.enabled,
        action_window_size=cycle_config.action_window_size,
        min_cycle_length=cycle_config.min_cycle_length,
        max_cycle_length=cycle_config.max_cycle_length,
        required_repetitions=cycle_config.required_repetitions,
        no_progress_steps=cycle_config.no_progress_steps,
        coordinate_tolerance_px=cycle_config.coordinate_tolerance_px,
        perceptual_hash_threshold=no_progress_perceptual_hash_threshold,
        mean_color_threshold=no_progress_mean_color_threshold,
    )

    try:
        observation = env.initialize_task(task)
        observation_metadata.append({"step": 0, **env.get_observation_metadata()})
        traj_logger.log_metadata(
            {
                **agent_information,
                "max_steps": task.max_steps,
                "timeout_seconds": task.timeout_seconds,
                "timeout_scope": "play_time",
                "wall_clock_timeout_seconds": wall_clock_limit,
                "seed": task.seed,
            }
        )
        phase = "running"

        initial_state = _safe_state(env, errors)
        deadlock = _episode_deadlock_diagnostic(
            initial_state,
            task=task,
            step=0,
        )
        if deadlock.get("is_deadlocked"):
            termination_reason = "no_available_hole_deadlock"
            errors.append("Episode terminated: no available hole deadlock at step 0")
            trajectory.append(
                {
                    "step": 0,
                    "task_id": task.task_id,
                    "game_id": task.game_id,
                    "difficulty": task.difficulty,
                    "level_id": task.level_id,
                    "event": "deadlock_detected",
                    "deadlock": deadlock,
                }
            )
        else:
            phase = "agent_initialization"
            agent.initialize(task.instruction)
            initialized_agent = True
            phase = "running"

        while termination_reason is None:
            wall_elapsed = time.monotonic() - started
            budget_stop_reason = _episode_budget_reason(
                play_elapsed=play_elapsed,
                wall_elapsed=wall_elapsed,
                timeout_seconds=task.timeout_seconds,
                wall_clock_limit=wall_clock_limit,
            )
            if budget_stop_reason:
                if budget_stop_reason == "play_timeout":
                    timeout = True
                else:
                    environment_error = (
                        "Wall-clock safety guard expired before the play-time budget"
                    )
                    errors.append(environment_error)
                break
            if step >= task.max_steps:
                max_step_reached = True
                break

            step += 1
            model_started_at = datetime.now(UTC)
            model_started = time.monotonic()
            metrics_before = _agent_metrics(agent)
            phase = "agent_prediction"
            pause_result = _toggle_simulation(env, True) or {
                "applied": False,
                "reason": "unsupported",
            }
            resume_result: dict[str, Any] | None = None
            try:
                prediction, action = agent.predict(
                    {
                        "screenshot": observation.screenshot,
                        "tool_call": observation.tool_call,
                        "ask_user_response": observation.ask_user_response,
                        "action_feedback": (
                            observation.action_feedback.model_dump()
                            if observation.action_feedback is not None
                            else None
                        ),
                    }
                )
            finally:
                resume_result = _toggle_simulation(env, False) or {
                    "applied": False,
                    "reason": "unsupported",
                }
                simulation_pause.append(
                    {
                        "step": step,
                        "pause": pause_result,
                        "resume": resume_result,
                    }
                )
            phase = "running"
            model_finished_at = datetime.now(UTC)
            model_duration = time.monotonic() - model_started
            model_elapsed += model_duration
            metrics_after = _agent_metrics(agent)
            step_model_usage = _metric_delta(metrics_after, metrics_before)
            action_payload = action.model_dump(exclude_none=True)
            agent_diagnostics = getattr(agent, "last_action_diagnostics", {})
            if not isinstance(agent_diagnostics, dict):
                agent_diagnostics = {}
            parsed_action = agent_diagnostics.get("parsed_tool_call") or action_payload
            normalized_action = agent_diagnostics.get("normalized_action") or action_payload
            state_before = _safe_state(env, errors)
            trajectory_step: dict[str, Any] = {
                "step": step,
                "task_id": task.task_id,
                "game_id": task.game_id,
                "difficulty": task.difficulty,
                "level_id": task.level_id,
                "prediction": prediction,
                "raw_model_response": prediction,
                "action": action_payload,
                "parsed_action": parsed_action,
                "normalized_action": normalized_action,
                "parser_diagnostics": agent_diagnostics.get("parse_attempts"),
                "model_usage": step_model_usage,
                "simulation_pause": simulation_pause[-1],
                "pre_observation": {
                    "frame_id": observation.frame_id,
                    "screenshot_sha256": screenshot_sha256(observation.screenshot),
                    "evaluator": _state_diagnostic(state_before, game_id=task.game_id),
                },
                "timestamps": {
                    "model_started_at": model_started_at.isoformat(),
                    "model_finished_at": model_finished_at.isoformat(),
                    "model_duration_seconds": model_duration,
                },
            }
            trajectory.append(trajectory_step)
            traj_logger.log_traj(
                task.task_id,
                task.instruction,
                step,
                prediction,
                action_payload,
                observation,
                agent.get_total_token_usage(),
                parsed_action=parsed_action,
                normalized_action=normalized_action,
                parser_diagnostics=agent_diagnostics.get("parse_attempts"),
                model_usage=step_model_usage,
            )

            wall_elapsed = time.monotonic() - started
            budget_stop_reason = _episode_budget_reason(
                play_elapsed=play_elapsed,
                wall_elapsed=wall_elapsed,
                timeout_seconds=task.timeout_seconds,
                wall_clock_limit=wall_clock_limit,
            )
            if budget_stop_reason:
                timeout_before_dispatch = True
                if budget_stop_reason == "play_timeout":
                    timeout = True
                else:
                    environment_error = (
                        "Wall-clock safety guard expired before the play-time budget"
                    )
                    errors.append(environment_error)
                execution_result = {
                    "executed": False,
                    "reason": budget_stop_reason,
                }
                trajectory_step.update(
                    {"executed_action": None, "execution_result": execution_result}
                )
                traj_logger.log_action_result(
                    task.task_id,
                    step,
                    executed_action=None,
                    execution_result=execution_result,
                    post_observation=observation,
                    duration_seconds=0,
                    error=(
                        "Episode play-time budget reached before action dispatch"
                        if budget_stop_reason == "play_timeout"
                        else environment_error
                    ),
                )
                break

            is_terminal = getattr(env, "is_terminal", None)
            already_terminal = False
            if callable(is_terminal):
                try:
                    already_terminal = bool(is_terminal())
                except Exception:
                    already_terminal = False
            if already_terminal:
                game_ended_during_prediction = True
                state_now = _safe_state(env, errors)
                status = str(state_now.get("status", "")).lower()
                succeeded = bool(state_now.get("success")) or status in {
                    "success",
                    "completed",
                    "complete",
                    "won",
                }
                if not succeeded:
                    timeout_before_dispatch = True
                    environment_error = (
                        "Game ended during model prediction while timeout_scope=play_time"
                    )
                    errors.append(environment_error)
                execution_result = {
                    "executed": False,
                    "reason": (
                        "success_during_prediction" if succeeded else "game_ended_during_prediction"
                    ),
                }
                trajectory_step.update(
                    {"executed_action": None, "execution_result": execution_result}
                )
                traj_logger.log_action_result(
                    task.task_id,
                    step,
                    executed_action=None,
                    execution_result=execution_result,
                    post_observation=observation,
                    duration_seconds=0,
                    error=(
                        None if succeeded else "Game ended while the model was producing an action"
                    ),
                )
                break

            if action.action_type == ENV_FAIL:
                environment_error = "Agent reported an environment failure"
                execution_result = {"executed": False, "reason": "agent_environment_failure"}
                trajectory_step.update(
                    {"executed_action": None, "execution_result": execution_result}
                )
                traj_logger.log_action_result(
                    task.task_id,
                    step,
                    executed_action=None,
                    execution_result=execution_result,
                    post_observation=observation,
                    duration_seconds=0,
                    error=environment_error,
                )
                break
            if action.action_type == UNKNOWN:
                reason = (
                    "parser_error"
                    if str(action.text or "").startswith("parse_error:")
                    else "unknown_action"
                )
                invalid_action_count += 1
                consecutive_invalid_actions += 1
                error = str(action.text or "Agent returned an unknown action")
                errors.append(error)
                execution_result = {
                    "executed": False,
                    "reason": reason,
                    "invalid_action_count": invalid_action_count,
                    "consecutive_invalid_actions": consecutive_invalid_actions,
                }
                trajectory_step.update(
                    {"executed_action": None, "execution_result": execution_result}
                )
                traj_logger.log_action_result(
                    task.task_id,
                    step,
                    executed_action=None,
                    execution_result=execution_result,
                    post_observation=observation,
                    duration_seconds=0,
                    error=error,
                )
                if consecutive_invalid_actions >= invalid_action_limit:
                    invalid_action_limit_reached = True
                    termination_reason = "invalid_action_limit"
                    break
                observation = observation.model_copy(
                    update={
                        "action_feedback": PublicActionFeedback(
                            action_id=f"{task.task_id}:{step}",
                            status="dispatch_failed",
                            executed=False,
                            fresh_observation=False,
                            message=(
                                "The action could not be executed. Return one valid GUI "
                                "action using the visible interface."
                            ),
                        )
                    }
                )
                continue
            if action.action_type not in WEB_GAME_ACTION_TYPES:
                invalid_action_count += 1
                consecutive_invalid_actions += 1
                reason = "unsupported_environment_action"
                error = f"Web puzzle environment does not support {action.action_type!r}"
                errors.append(error)
                execution_result = {
                    "executed": False,
                    "reason": reason,
                    "invalid_action_count": invalid_action_count,
                    "consecutive_invalid_actions": consecutive_invalid_actions,
                }
                trajectory_step.update(
                    {"executed_action": None, "execution_result": execution_result}
                )
                traj_logger.log_action_result(
                    task.task_id,
                    step,
                    executed_action=None,
                    execution_result=execution_result,
                    post_observation=observation,
                    duration_seconds=0,
                    error=error,
                )
                if consecutive_invalid_actions >= invalid_action_limit:
                    invalid_action_limit_reached = True
                    termination_reason = "invalid_action_limit"
                    break
                observation = observation.model_copy(
                    update={
                        "action_feedback": PublicActionFeedback(
                            action_id=f"{task.task_id}:{step}",
                            status="dispatch_failed",
                            executed=False,
                            fresh_observation=False,
                            message=(
                                "This benchmark accepts only visible click, double-click, "
                                "long-press, press/release, drag/swipe, scroll, or wait actions. "
                                "Do not use answer or status; the game decides when the level is complete."
                            ),
                        )
                    }
                )
                continue

            action_started_at = datetime.now(UTC)
            action_started = time.monotonic()
            pre_action_observation = observation
            try:
                environment_steps += 1
                observation = env.execute_action(action)
                action_duration = time.monotonic() - action_started
                play_elapsed += action_duration
                action_result = env.get_last_action_result() or {
                    "executed": True,
                    "reason": "completed",
                }
                state_after = _safe_state(env, errors)
                trajectory_step.update(
                    {
                        "executed_action": normalized_action,
                        "execution_result": action_result,
                        "post_observation": {
                            "frame_id": observation.frame_id,
                            "screenshot_sha256": screenshot_sha256(observation.screenshot),
                            "evaluator": _state_diagnostic(state_after, game_id=task.game_id),
                        },
                    }
                )
                trajectory_step["timestamps"].update(
                    {
                        "action_started_at": action_started_at.isoformat(),
                        "action_finished_at": datetime.now(UTC).isoformat(),
                        "action_duration_seconds": action_duration,
                    }
                )
                observation_metadata.append({"step": step, **env.get_observation_metadata()})
            except Exception as exc:
                action_duration = time.monotonic() - action_started
                play_elapsed += action_duration
                environment_error = f"Action execution failed at step {step}: {exc}"
                errors.append(environment_error)
                execution_result = {
                    "executed": False,
                    "reason": "execution_error",
                    "error": str(exc),
                }
                trajectory_step.update(
                    {"executed_action": None, "execution_result": execution_result}
                )
                traj_logger.log_action_result(
                    task.task_id,
                    step,
                    executed_action=None,
                    execution_result=execution_result,
                    post_observation=None,
                    duration_seconds=action_duration,
                    error=environment_error,
                )
                logger.exception(environment_error)
                break

            deadlock = _episode_deadlock_diagnostic(
                state_after,
                task=task,
                step=step,
            )
            if deadlock.get("is_deadlocked"):
                termination_reason = cast(
                    TerminationReason,
                    deadlock.get("termination_reason") or "game_deadlock",
                )
                trajectory_step["deadlock"] = deadlock
                action_result["deadlock"] = deadlock
                traj_logger.log_action_result(
                    task.task_id,
                    step,
                    executed_action=normalized_action,
                    execution_result=action_result,
                    post_observation=observation,
                    duration_seconds=action_duration,
                )
                errors.append(
                    f"Episode terminated: {termination_reason} after stable action step {step}"
                )
                break

            effect = action_result.get("observation_effect", {})
            progress = progress_tracker.update(
                action_id=str(action_result.get("action_id", f"{task.task_id}:{step}")),
                action=action_payload,
                pre_image=pre_action_observation.screenshot,
                post_image=observation.screenshot,
                pre_frame_id=pre_action_observation.frame_id,
                post_frame_id=observation.frame_id,
                visual_changed=bool(
                    effect.get("visual_changed", action_result.get("visual_changed", False))
                ),
                visual_change_ratio=float(
                    effect.get(
                        "visual_change_ratio",
                        action_result.get("visual_change_ratio", 0.0),
                    )
                ),
                stable=effect.get("stable"),
                objective_before=_objective_progress_payload(state_before, game_id=task.game_id),
                objective_after=_objective_progress_payload(state_after, game_id=task.game_id),
            )
            last_cycle_decision = cycle_detector.update(
                step=step,
                action=action_payload,
                observation=observation.screenshot,
                state=state_after,
                objective_before=_objective_progress_payload(state_before, game_id=task.game_id),
                objective_after=_objective_progress_payload(state_after, game_id=task.game_id),
            )
            action_executed = bool(action_result.get("executed", True))
            if action_executed:
                consecutive_invalid_actions = 0
            else:
                invalid_action_count += 1
                consecutive_invalid_actions += 1
            no_progress_result = {
                "evidence_steps": last_cycle_decision.no_progress_steps,
                "recovery_required": progress.recovery_required,
                "terminate": last_cycle_decision.terminate,
                "recovery_epoch": progress.recovery_epoch,
                "reason": (last_cycle_decision.termination_reason or progress.reason),
                "cycle_length": (last_cycle_decision.cycle_length or progress.cycle_length),
                "cycle_repetitions": last_cycle_decision.cycle_repetitions,
                "cycle_actions": list(last_cycle_decision.cycle_actions),
                "no_progress_steps": last_cycle_decision.no_progress_steps,
                "last_progress_step": last_cycle_decision.last_progress_step,
                "objective_progressed": progress.objective_progressed,
            }
            trajectory_step["no_progress"] = no_progress_result
            trajectory_step["action_outcome"] = progress.diagnostic_dict()
            trajectory_step["cycle_detection"] = last_cycle_decision.diagnostic_dict()
            action_result["no_progress"] = no_progress_result
            action_result["cycle_detection"] = last_cycle_decision.diagnostic_dict()
            public_feedback = progress.public_feedback
            if not action_executed:
                public_feedback = PublicActionFeedback(
                    action_id=str(action_result.get("action_id", f"{task.task_id}:{step}")),
                    status="dispatch_failed",
                    executed=False,
                    fresh_observation=True,
                    message="The GUI action was not accepted by the environment.",
                )
            action_result["public_feedback"] = public_feedback.model_dump()
            observation = observation.model_copy(update={"action_feedback": public_feedback})
            traj_logger.log_action_result(
                task.task_id,
                step,
                executed_action=normalized_action,
                execution_result=action_result,
                post_observation=observation,
                duration_seconds=action_duration,
            )

            if env.is_terminal():
                break

            if consecutive_invalid_actions >= invalid_action_limit:
                invalid_action_limit_reached = True
                termination_reason = "invalid_action_limit"
                break

            if progress.recovery_required:
                refreshed = env.observe(wait_to_stabilize=True)
                observation = refreshed.model_copy(update={"action_feedback": public_feedback})
                observation_metadata.append(
                    {"step": step, "forced_refresh": True, **env.get_observation_metadata()}
                )
            if last_cycle_decision.terminate:
                termination_reason = last_cycle_decision.termination_reason
                repeated_action_cycle = termination_reason == "repeated_action_cycle"
                no_progress = termination_reason == "no_progress"
                message = (
                    f"Episode terminated: {termination_reason} after "
                    f"{last_cycle_decision.no_progress_steps} no-progress steps"
                )
                errors.append(message)
                break
            if progress.terminate and not cycle_config.enabled:
                no_progress = True
                termination_reason = "no_progress"
                errors.append(
                    "Episode terminated after "
                    f"{progress.evidence_steps} no-effect or cyclic visual transitions"
                )
                break
    except Exception as exc:
        if phase in {"agent_initialization", "agent_prediction"}:
            agent_error = f"Agent failure during {phase}: {exc}"
            errors.append(agent_error)
            termination_reason = "agent_error"
        else:
            environment_error = f"Episode environment failure during {phase}: {exc}"
            errors.append(environment_error)
            termination_reason = "environment_error"
        logger.exception("LongPuzzleBench episode {} failed", task.task_id)
    finally:
        if initialized_agent:
            try:
                agent.done()
            except Exception as exc:
                errors.append(f"Agent cleanup failed: {exc}")

    wall_elapsed = time.monotonic() - started
    elapsed = play_elapsed
    benchmark_metrics = _agent_metrics(agent)
    semantic_action_steps = [
        item for item in trajectory if isinstance(item.get("normalized_action"), dict)
    ]
    benchmark_metrics.update(
        {
            "parse_failures": max(
                int(benchmark_metrics.get("parse_failures") or 0),
                sum(
                    1
                    for item in trajectory
                    if str((item.get("execution_result") or {}).get("reason", "")) == "parser_error"
                ),
            ),
            "repeated_actions": sum(
                1
                for previous, current in zip(semantic_action_steps, semantic_action_steps[1:])
                if current["normalized_action"] == previous["normalized_action"]
                and not bool(
                    (current.get("action_outcome") or {}).get("objective_progressed", False)
                )
            ),
            "cycle_steps": sum(
                1
                for item in trajectory
                if (item.get("action_outcome") or {}).get("cycle_length") is not None
            ),
            "noop_actions": sum(
                1
                for item in trajectory
                if (item.get("action_outcome") or {}).get("reason") == "no_visible_effect"
            ),
        }
    )
    state = _scored_state(env, errors)
    if not state and environment_error is None:
        environment_error = errors[-1] if errors else "Evaluator state is unavailable"
    result = evaluator.evaluate(
        state,
        task,
        steps=step,
        elapsed=elapsed,
        timeout=timeout,
        timeout_before_dispatch=timeout_before_dispatch,
        max_step_reached=max_step_reached,
        agent_terminated=agent_terminated,
        no_progress=no_progress,
        repeated_action_cycle=repeated_action_cycle,
        invalid_action_limit_reached=invalid_action_limit_reached,
        environment_error=environment_error,
        agent_error=agent_error,
        termination_reason=termination_reason,
        deadlock=deadlock,
        invalid_action_count=invalid_action_count,
        agent_information=agent_information,
        trajectory=trajectory,
        observation_metadata=observation_metadata,
        runtime={
            "runner": "longpuzzlebench.runner",
            "run_index": run_index,
            "base_url": env.base_url,
            "started_at": started_at.isoformat(),
            "finished_at": datetime.now(UTC).isoformat(),
            "timeout_scope": "play_time",
            "play_time_seconds": play_elapsed,
            "model_duration_seconds": model_elapsed,
            "wall_clock_seconds": wall_elapsed,
            "wall_clock_timeout_seconds": wall_clock_limit,
            "timeout_before_dispatch": timeout_before_dispatch,
            "game_ended_during_prediction": game_ended_during_prediction,
            "simulation_pause": simulation_pause,
            "budget_stop_reason": budget_stop_reason,
            "no_progress_recovery_steps": no_progress_recovery_steps,
            "no_progress_termination_steps": no_progress_termination_steps,
            "no_progress_max_cycle_length": no_progress_max_cycle_length,
            "no_progress_perceptual_hash_threshold": (no_progress_perceptual_hash_threshold),
            "no_progress_mean_color_threshold": no_progress_mean_color_threshold,
            "invalid_action_limit": invalid_action_limit,
            "cycle_detection": cycle_config.model_dump(),
            "model_usage": benchmark_metrics,
            "agent_decisions": step,
            "environment_steps": environment_steps,
            "termination_diagnostics": (
                deadlock
                if termination_reason in {"no_available_hole_deadlock", "game_deadlock"}
                else last_cycle_decision.diagnostic_dict()
                if last_cycle_decision is not None and last_cycle_decision.terminate
                else None
            ),
        },
        errors=errors,
    )
    if trajectory:
        trajectory[-1]["episode_termination_reason"] = result.termination_reason
        result = result.model_copy(update={"trajectory": trajectory}, deep=True)
    traj_logger.log_termination(
        result.termination_reason,
        (
            deadlock
            if result.termination_reason in {"no_available_hole_deadlock", "game_deadlock"}
            else last_cycle_decision.diagnostic_dict()
            if last_cycle_decision is not None and last_cycle_decision.terminate
            else None
        ),
    )
    traj_logger.log_score(
        result.normalized_score,
        result.termination_reason or result.episode_status,
    )
    return result


def _print_progression(console: Console, summary: Mapping[str, Any]) -> None:
    """Report level progression separately from the whole-cell pass/fail."""

    table = Table(title="Level Progression")
    table.add_column("Levels Completed", justify="right")
    table.add_column("Levels Attempted", justify="right")
    table.add_column("Levels Planned", justify="right")
    table.add_column("Highest Level Reached", justify="right")
    table.add_column("Level Success Rate", justify="right")
    table.add_column("Overall Success", justify="right")
    highest = summary.get("highest_level_reached")
    table.add_row(
        str(summary.get("levels_completed", 0)),
        str(summary.get("levels_attempted", 0)),
        str(summary.get("levels_planned", 0)),
        "-" if highest is None else str(highest),
        f"{float(summary.get('level_success_rate', 0.0)):.2%}",
        "yes" if summary.get("overall_success") else "no",
    )
    console.print(table)


def _print_summary(
    output_directory: Path,
    report_files: dict[str, Path],
    benchmark_summary: Mapping[str, Any] | None = None,
) -> None:
    results = ResultWriter(output_directory).load_results()
    table = Table(title="LongPuzzleBench Evaluation")
    table.add_column("Task")
    table.add_column("Status")
    table.add_column("Score / 100", justify="right")
    table.add_column("Steps", justify="right")
    for result in results:
        table.add_row(
            result.task.task_id,
            result.episode_status,
            f"{result.overall_score:.2f}",
            str(result.step_count),
        )
    console = Console()
    console.print(table)
    if benchmark_summary is not None:
        _print_progression(console, benchmark_summary)
    difficulty_path = report_files.get("difficulty_results_json")
    if difficulty_path and difficulty_path.is_file():
        payload = json.loads(difficulty_path.read_text())
        entries = payload.get("entries", []) if isinstance(payload, dict) else []
        if entries:
            aggregate_table = Table(title="Game x Difficulty Results")
            aggregate_table.add_column("Game")
            aggregate_table.add_column("Difficulty")
            aggregate_table.add_column("Success Rate", justify="right")
            aggregate_table.add_column("Overall", justify="right")
            aggregate_table.add_column("Progress", justify="right")
            aggregate_table.add_column("Efficiency", justify="right")
            aggregate_table.add_column("Action Quality", justify="right")
            for entry in entries:
                metrics = entry.get("metrics", {})
                aggregate_table.add_row(
                    str(entry.get("game_id", "unknown")),
                    str(entry.get("difficulty", "unknown")),
                    f"{float(entry.get('success_rate', 0.0)):.2%}",
                    f"{float(entry.get('overall_score', 0.0)):.2f}",
                    f"{float(metrics.get('mean_progress', 0.0)):.3f}",
                    f"{float(metrics.get('mean_step_efficiency', 0.0)):.3f}",
                    f"{float(metrics.get('mean_action_quality', 0.0)):.3f}",
                )
            console.print(aggregate_table)
    console.print(f"Results: {report_files['episodes_jsonl']}")
    console.print(f"Summary: {report_files['summary_json']}")
    if difficulty_path:
        console.print(f"Difficulty results: {difficulty_path}")
    console.print(f"Leaderboard: {report_files['leaderboard_json']}")


def _benchmark_summary(
    *,
    planned: list[dict[str, Any]],
    executed: list[dict[str, Any]],
    successful_tasks: int,
    termination_reason: TerminationReason | None,
    failed_task_id: str | None,
    experiment: ExperimentSettings | None = None,
    chain_summaries: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build strict-run metadata without materializing fake not-run episodes.

    Planned records are matched explicitly rather than treated as one executed
    prefix.  This matters when one seed/difficulty chain fails while another
    independent chain continues.
    """

    executed_by_key = {(int(item["run_index"]), str(item["task_id"])): item for item in executed}
    not_run = [
        item
        for item in planned
        if (int(item["run_index"]), str(item["task_id"])) not in executed_by_key
    ]
    failure_reasons: dict[str, int] = defaultdict(int)
    for item in executed:
        if item.get("status") == "success":
            continue
        failure_reasons[str(item.get("termination_reason") or item.get("status") or "unknown")] += 1
    chains = list(chain_summaries or [])
    per_level_score = {
        str(item.get("level_id")): float(item.get("level_score") or 0.0)
        for item in executed
        if "level_id" in item
    }
    highest_levels = [
        item.get("highest_level_reached")
        for item in chains
        if item.get("highest_level_reached") is not None
    ]
    highest_completed_levels = [
        item.get("highest_level_completed")
        for item in chains
        if item.get("highest_level_completed") is not None
    ]
    levels_completed = sum(int(item.get("levels_completed") or 0) for item in chains)
    levels_attempted = (
        sum(int(item.get("levels_attempted") or 0) for item in chains) if chains else len(executed)
    )
    total_score = sum(float(item.get("total_score") or 0.0) for item in chains)
    overall_score = (
        fmean([float(item.get("overall_score") or 0.0) for item in chains])
        if chains
        else (
            fmean([float(item.get("level_score") or 0.0) for item in executed]) if executed else 0.0
        )
    )
    success_rate = successful_tasks / len(planned) if planned else 0.0
    level_success_rate = successful_tasks / levels_attempted if levels_attempted else 0.0
    summary: dict[str, Any] = {
        "benchmark_status": "terminated" if termination_reason else "completed",
        "termination_reason": termination_reason,
        "failed_task_id": failed_task_id,
        "completed_tasks": successful_tasks,
        "failed_tasks": sum(1 for item in executed if item.get("status") != "success"),
        "executed_tasks": len(executed),
        "total_tasks": len(planned),
        "remaining_tasks": len(not_run),
        "not_run_tasks": not_run,
        "planned_tasks": planned,
        "planned_episodes": planned,
        "failure_reasons": dict(sorted(failure_reasons.items())),
        "score_policy": (
            "Unexecuted tasks contribute zero; the denominator remains the complete "
            "configured task/run matrix."
        ),
        "metric_definitions": {
            "success_rate": "successful levels / planned levels (unrun levels score zero)",
            "level_success_rate": "successful levels / attempted levels",
            "comparable_success_rate": (
                "successful levels / comparable levels; agent_error and "
                "environment_error episodes, and levels they blocked, are excluded"
            ),
            "overall_success": "every planned level of the cell was completed",
            "highest_level_reached": "highest level an episode was run on",
            "highest_level_completed": "highest level an episode completed successfully",
        },
        "highest_level_reached": (
            max(highest_levels, key=_level_order_key) if highest_levels else None
        ),
        "highest_level_completed": (
            max(highest_completed_levels, key=_level_order_key)
            if highest_completed_levels
            else None
        ),
        "levels_completed": levels_completed,
        "levels_attempted": levels_attempted,
        "levels_planned": len(planned),
        "total_score": total_score,
        "overall_score": overall_score,
        "success_rate": success_rate,
        "level_success_rate": level_success_rate,
        "overall_success": bool(planned) and successful_tasks == len(planned),
        "per_level_score": per_level_score,
        "chains": chains,
        **comparable_metrics(executed, planned),
    }
    if experiment is not None:
        summary.update(experiment.public_metadata())
    return summary


def _level_order_key(level_id: Any) -> tuple[int, float, str]:
    """Order numeric level ids numerically and named ids lexicographically."""

    try:
        return (0, float(level_id), "")
    except (TypeError, ValueError):
        return (1, 0.0, str(level_id))


def _chain_progress_summary(
    *,
    chain: tuple[MiniGameTaskSpec, ...],
    chain_results: list[EpisodeResult],
) -> dict[str, Any]:
    completed = sum(1 for result in chain_results if result.task_success)
    attempted = len(chain_results)
    scores = [float(result.overall_score) for result in chain_results]
    highest_reached = (
        max((result.task.level_id for result in chain_results), key=_level_order_key)
        if chain_results
        else None
    )
    completed_levels = [result.task.level_id for result in chain_results if result.task_success]
    highest_completed = max(completed_levels, key=_level_order_key) if completed_levels else None
    return {
        "game_id": chain[0].game_id,
        "difficulty": chain[0].difficulty,
        "seed": chain[0].seed,
        "highest_level_reached": highest_reached,
        "highest_level_completed": highest_completed,
        "levels_completed": completed,
        "levels_attempted": attempted,
        "levels_planned": len(chain),
        "total_score": sum(scores),
        "overall_score": (sum(scores) / len(chain)) if chain else 0.0,
        "level_success_rate": (completed / attempted) if attempted else 0.0,
        "overall_success": bool(chain) and completed == len(chain),
        # Retained public field: completed levels over the complete configured
        # denominator, so levels skipped after a failure still count as zero.
        "success_rate": (completed / len(chain)) if chain else 0.0,
        "per_level_score": {
            str(result.task.level_id): float(result.overall_score) for result in chain_results
        },
    }


def run_mini_games_benchmark(args: argparse.Namespace) -> dict[str, Any]:
    """Run the selected Cocos tasks and persist per-episode/report artifacts."""

    _validate_public_selection(args)
    config_path = _resolve_config(getattr(args, "config", None))
    prompt_setting = cast(PromptSetting | None, _explicit_cli_value(args, "prompt_setting"))
    catalog = load_catalog(config_path, prompt_setting=prompt_setting)
    experiment = _resolve_experiment_settings(catalog, args)
    if experiment.prompt_setting != catalog.experiment.prompt_setting:
        catalog = load_catalog(config_path, prompt_setting=experiment.prompt_setting)
        catalog = catalog.model_copy(update={"experiment": experiment}, deep=True)
    else:
        catalog = catalog.model_copy(update={"experiment": experiment}, deep=True)
    history_n_images = _effective_history_n_images(args)
    stop_on_failure = catalog.execution.should_stop_on_failure(experiment.eval_mode)
    tasks = _select_tasks(catalog, args)
    num_runs = int(getattr(args, "num_runs", 1))
    if num_runs < 1:
        raise ValueError("--num-runs must be at least 1")

    output_value = getattr(args, "output", None) or getattr(args, "log_file_root", None)
    output_directory = (
        Path(output_value or (Path("results") / datetime.now().strftime("%Y%m%d_%H%M%S")))
        .expanduser()
        .resolve()
    )
    writer = ResultWriter(output_directory)
    evaluator = MiniGameEvaluator()
    agent_information = _agent_information(
        args,
        experiment=experiment,
        history_n_images=history_n_images,
    )
    agent_information.update(
        {
            "benchmark_version": _benchmark_version(config_path),
            "benchmark_config_hash": hashlib.sha256(config_path.read_bytes()).hexdigest(),
            "environment_version": _environment_version(catalog),
            "scoring_version": catalog.metadata.get("scoring_version"),
            "scoring_config_hash": catalog.metadata.get("scoring_config_hash"),
        }
    )
    planned = [
        {
            "run_index": run_index,
            "task_id": task.task_id,
            "game_id": task.game_id,
            "difficulty": task.difficulty,
            "level_id": task.level_id,
            "seed": task.seed,
            "status": "not_run",
            "prompt_setting": experiment.prompt_setting,
            "eval_mode": experiment.eval_mode,
        }
        for run_index in range(1, num_runs + 1)
        for task in tasks
    ]
    evaluation_matrix_hash = hashlib.sha256(
        json.dumps(planned, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    agent_information.update(
        {
            "evaluation_matrix_hash": evaluation_matrix_hash,
            "planned_episodes": len(planned),
            "planned_group_counts": dict(
                sorted(
                    {
                        f"{task.game_id}.{task.difficulty}": sum(
                            1
                            for item in planned
                            if item["game_id"] == task.game_id
                            and item["difficulty"] == task.difficulty
                        )
                        for task in tasks
                    }.items()
                )
            ),
        }
    )

    logger.info(
        "Selected {} LongPuzzleBench task(s), {} run(s), prompt={}, eval_mode={}, output {}",
        len(tasks),
        num_runs,
        experiment.prompt_setting,
        experiment.eval_mode,
        output_directory,
    )
    if getattr(args, "dry_run", False):
        for task in tasks:
            logger.info("Dry-run LongPuzzleBench task: {}", task.task_id)
        benchmark_summary = _benchmark_summary(
            planned=planned,
            executed=[],
            successful_tasks=0,
            termination_reason=None,
            failed_task_id=None,
            experiment=experiment,
        )
        files = writer.finalize(
            agent_information,
            expected_episode_count=len(planned),
            benchmark_summary=benchmark_summary,
            planned_episodes=planned,
        )
        return {
            "tasks": [task.task_id for task in tasks],
            "files": files,
            "dry_run": True,
            **benchmark_summary,
        }

    env = _make_environment(catalog, evaluator, args)
    executed: list[dict[str, Any]] = []
    chain_summaries: list[dict[str, Any]] = []
    successful_tasks = 0
    benchmark_termination_reason: TerminationReason | None = None
    failed_task_id: str | None = None
    try:
        try:
            env.start()
        except Exception as exc:
            first = tasks[0]
            message = f"Benchmark environment failed to start: {exc}"
            startup_result = evaluator.evaluate(
                {},
                first,
                steps=0,
                elapsed=0,
                environment_error=message,
                termination_reason="environment_error",
                agent_information=agent_information,
                errors=[message],
                runtime={"runner": "longpuzzlebench.runner", "run_index": 1},
            )
            writer.write_episode(startup_result)
            executed.append(
                {
                    "run_index": 1,
                    "task_id": first.task_id,
                    "game_id": first.game_id,
                    "difficulty": first.difficulty,
                    "level_id": first.level_id,
                    "seed": first.seed,
                    "status": "error",
                    "level_score": 0.0,
                    "success": False,
                    "progress_score": 0.0,
                    "steps": 0,
                }
            )
            benchmark_termination_reason = "environment_error"
            failed_task_id = first.task_id
        stop_requested = benchmark_termination_reason == "environment_error"
        for run_index in range(1, num_runs + 1):
            if stop_requested:
                break
            for chain in _task_chains(tasks):
                chain_failed = False
                chain_results: list[EpisodeResult] = []
                for task in chain:
                    if chain_failed:
                        continue
                    logger.info(
                        "Running LongPuzzleBench task {} (run {}/{})",
                        task.task_id,
                        run_index,
                        num_runs,
                    )
                    trajectory_root = output_directory / "trajectories" / f"run_{run_index:03d}"
                    traj_logger = TrajLogger(str(trajectory_root), task.task_id)
                    max_attempts = int(catalog.environment.max_episode_retries) + 1
                    result = None
                    attempts_used = 0
                    cleanup_error: str | None = None
                    for attempt in range(max_attempts):
                        attempts_used = attempt + 1
                        if attempt:
                            logger.warning(
                                "Retrying LongPuzzleBench task {} after agent_error (attempt {}/{})",
                                task.task_id,
                                attempts_used,
                                max_attempts,
                            )
                        try:
                            agent = _make_agent(
                                args,
                                env,
                                experiment=experiment,
                                history_n_images=history_n_images,
                            )
                            framework_getter = getattr(agent, "get_framework_metadata", None)
                            episode_agent_information = dict(agent_information)
                            if callable(framework_getter):
                                framework_metadata = framework_getter()
                                if isinstance(framework_metadata, dict):
                                    episode_agent_information.update(framework_metadata)
                            try:
                                result = _execute_episode(
                                    env=env,
                                    evaluator=evaluator,
                                    task=task,
                                    agent=agent,
                                    traj_logger=traj_logger,
                                    agent_information=episode_agent_information,
                                    run_index=run_index,
                                    no_progress_recovery_steps=(
                                        catalog.environment.no_progress_recovery_steps
                                    ),
                                    no_progress_termination_steps=(
                                        catalog.environment.no_progress_termination_steps
                                    ),
                                    no_progress_max_cycle_length=(
                                        catalog.environment.no_progress_max_cycle_length
                                    ),
                                    no_progress_perceptual_hash_threshold=(
                                        catalog.environment.no_progress_perceptual_hash_threshold
                                    ),
                                    no_progress_mean_color_threshold=(
                                        catalog.environment.no_progress_mean_color_threshold
                                    ),
                                    cycle_detection=catalog.environment.cycle_detection,
                                    invalid_action_limit=(catalog.environment.invalid_action_limit),
                                    wall_clock_timeout_slack_seconds=(
                                        catalog.environment.wall_clock_timeout_slack_seconds
                                    ),
                                )
                            except Exception as exc:
                                message = f"Could not run agent: {exc}"
                                result = evaluator.evaluate(
                                    _safe_state(env, []),
                                    task,
                                    steps=0,
                                    elapsed=0,
                                    agent_error=message,
                                    termination_reason="agent_error",
                                    agent_information=agent_information,
                                    errors=[message],
                                    runtime={
                                        "runner": "longpuzzlebench.runner",
                                        "run_index": run_index,
                                    },
                                )
                        except Exception as exc:
                            message = f"Could not create agent: {exc}"
                            result = evaluator.evaluate(
                                _safe_state(env, []),
                                task,
                                steps=0,
                                elapsed=0,
                                agent_error=message,
                                termination_reason="agent_error",
                                agent_information=agent_information,
                                errors=[message],
                                runtime={
                                    "runner": "longpuzzlebench.runner",
                                    "run_index": run_index,
                                },
                            )
                        finally:
                            try:
                                env.tear_down_task(task.task_id)
                            except Exception as exc:
                                cleanup_error = f"Episode cleanup failed: {exc}"
                                logger.exception(cleanup_error)
                        if cleanup_error:
                            break
                        if (
                            result is None
                            or result.termination_reason != "agent_error"
                            or attempts_used >= max_attempts
                        ):
                            break
                    if result is None:
                        message = "Episode produced no result"
                        result = evaluator.evaluate(
                            {},
                            task,
                            steps=0,
                            elapsed=0,
                            environment_error=message,
                            termination_reason="environment_error",
                            agent_information=agent_information,
                            errors=[message],
                            runtime={
                                "runner": "longpuzzlebench.runner",
                                "run_index": run_index,
                            },
                        )
                    result = result.model_copy(
                        update={
                            "runtime": {
                                **result.runtime,
                                "episode_attempts": attempts_used,
                            }
                        },
                        deep=True,
                    )
                    if cleanup_error:
                        result = result.model_copy(
                            update={
                                "task_success": False,
                                "normalized_score": 0.0,
                                "overall_score": 0.0,
                                "breakdown": ScoreBreakdown(),
                                "is_terminal": True,
                                "episode_status": "error",
                                "termination_reason": "environment_error",
                                "errors": [*result.errors, cleanup_error],
                                "raw_metrics": {
                                    **result.raw_metrics,
                                    "task_success": False,
                                    "episode_status": "error",
                                    "termination_reason": "environment_error",
                                },
                                "normalized_metrics": {
                                    **result.normalized_metrics,
                                    "score": 0.0,
                                    "task_success": 0.0,
                                },
                            },
                            deep=True,
                        )
                    writer.write_episode(result, trajectory_dir=traj_logger.log_file_dir)
                    chain_results.append(result)
                    executed.append(
                        {
                            "run_index": run_index,
                            "task_id": task.task_id,
                            "game_id": task.game_id,
                            "difficulty": task.difficulty,
                            "level_id": task.level_id,
                            "seed": task.seed,
                            "status": result.episode_status,
                            "termination_reason": result.termination_reason,
                            "success": result.task_success,
                            "final_success": result.task_success,
                            "progress_score": float(result.breakdown.progress_score),
                            "level_score": float(result.overall_score),
                            "steps": result.step_count,
                            "prompt_setting": experiment.prompt_setting,
                            "eval_mode": experiment.eval_mode,
                        }
                    )
                    if result.task_success:
                        successful_tasks += 1
                    elif stop_on_failure:
                        if benchmark_termination_reason is None:
                            benchmark_termination_reason = (
                                result.termination_reason or "environment_error"
                            )
                            failed_task_id = task.task_id
                        # Progressive mode applies inside one
                        # game/difficulty/seed/run chain.  Other seeds or public
                        # cells remain independent and may continue.
                        chain_failed = True
                if chain_results:
                    chain_summaries.append(
                        {
                            "run_index": run_index,
                            **_chain_progress_summary(
                                chain=chain,
                                chain_results=chain_results,
                            ),
                        }
                    )
    finally:
        try:
            env.close()
        except Exception:
            logger.exception("Benchmark environment cleanup failed")
            if benchmark_termination_reason is None:
                benchmark_termination_reason = "environment_error"
                failed_task_id = executed[-1]["task_id"] if executed else tasks[0].task_id

    benchmark_summary = _benchmark_summary(
        planned=planned,
        executed=executed,
        successful_tasks=successful_tasks,
        termination_reason=benchmark_termination_reason,
        failed_task_id=failed_task_id,
        experiment=experiment,
        chain_summaries=chain_summaries,
    )
    files = writer.finalize(
        agent_information,
        expected_episode_count=len(planned),
        benchmark_summary=benchmark_summary,
        planned_episodes=planned,
    )
    _print_summary(output_directory, files, benchmark_summary)
    return {
        "tasks": [task.task_id for task in tasks],
        "episode_count": len(executed),
        **benchmark_summary,
        "output_directory": output_directory,
        "files": files,
    }


__all__ = ["run_mini_games_benchmark"]
