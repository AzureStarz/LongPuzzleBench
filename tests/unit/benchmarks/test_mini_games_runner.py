import json
from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from PIL import Image

from mobile_world.benchmarks import ExperimentSettings, load_catalog, mini_games_runner
from mobile_world.benchmarks.evaluator import MiniGameEvaluator
from mobile_world.benchmarks.mini_games_runner import (
    _environment_version,
    _execute_episode,
    _file_digest,
    _make_agent,
    _objective_progress_payload,
    _select_tasks,
    _validate_public_selection,
    run_mini_games_benchmark,
)
from mobile_world.benchmarks.models import EnvironmentConfig, MiniGameTaskSpec
from mobile_world.core.cli import create_parser
from mobile_world.runtime.action_outcome import objective_improved
from mobile_world.runtime.utils.models import JSONAction, Observation, PublicActionFeedback
from mobile_world.runtime.utils.trajectory_logger import TrajLogger


def _args(**overrides):
    values = {
        "task": None,
        "debug_task": None,
        "game": None,
        "difficulty": None,
        "debug_level": None,
        "seeds": None,
        "max_round": None,
        "timeout": None,
        "prompt_setting": None,
        "context_setting": None,
        "eval_mode": None,
        "history_turns": None,
        "history_n_images": None,
    }
    values.update(overrides)
    return Namespace(**values)


def test_runner_filters_and_expands_seeded_stable_tasks() -> None:
    catalog = load_catalog("configs/longpuzzlebench.json")

    tasks = _select_tasks(
        catalog,
        _args(
            game="bolt_unscrew",
            difficulty="easy",
            debug_level="1,2",
            seeds="2,7",
            max_round=9,
            timeout=12,
        ),
    )

    assert [task.task_id for task in tasks] == [
        "bolt_unscrew.easy.level_01.seed_2",
        "bolt_unscrew.easy.level_01.seed_7",
        "bolt_unscrew.easy.level_02.seed_2",
        "bolt_unscrew.easy.level_02.seed_7",
    ]
    assert all(task.max_steps == 9 and task.timeout_seconds == 12 for task in tasks)


def test_runner_rejects_empty_selection() -> None:
    catalog = load_catalog("configs/longpuzzlebench.json")

    with pytest.raises(ValueError, match="No LongPuzzleBench tasks"):
        _select_tasks(catalog, _args(game="missing"))


def test_content_digest_is_stable_across_checkout_locations(tmp_path: Path) -> None:
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_file = first_root / "src" / "same.py"
    second_file = second_root / "src" / "same.py"
    first_file.parent.mkdir(parents=True)
    second_file.parent.mkdir(parents=True)
    first_file.write_text("value = 1\n")
    second_file.write_text("value = 1\n")

    assert _file_digest([first_file], root=first_root) == _file_digest(
        [second_file], root=second_root
    )


def test_environment_version_hashes_runtime_asset_bundles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "game"
    build = project / "build" / "web-mobile"
    runtime_bundle = build / "assets" / "main" / "index.js"
    runtime_bundle.parent.mkdir(parents=True)
    (build / "index.html").write_text("<script src='index.js'></script>\n")
    runtime_bundle.write_text("export const level = 'old';\n")
    catalog = load_catalog("configs/longpuzzlebench.json")
    environment = catalog.environment.model_copy(
        update={"project_path": str(project), "build_directory": "build/web-mobile"}
    )
    catalog = catalog.model_copy(update={"environment": environment})
    monkeypatch.setattr(mini_games_runner, "_git_revision", lambda _: "revision+dirty")

    before = _environment_version(catalog)
    runtime_bundle.write_text("export const level = 'calibrated';\n")
    after = _environment_version(catalog)

    assert before != after


def test_longpuzzlebench_cli_surface_parses_documented_filters() -> None:
    parser = create_parser()
    args = parser.parse_args(
        [
            "eval",
            "--agent-type",
            "visual_agent",
            "--game",
            "rush_hour_2",
            "--difficulty",
            "hard",
            "--seeds",
            "0,1",
            "--num-runs",
            "2",
        ]
    )

    assert args.game == "rush_hour_2"
    assert not hasattr(args, "level")
    assert not hasattr(args, "all_levels")
    assert args.seeds == "0,1"
    assert args.num_runs == 2


@pytest.mark.parametrize("legacy_filter", ["--level", "--all-levels"])
def test_longpuzzlebench_cli_does_not_expose_single_level_filters(legacy_filter: str) -> None:
    parser = create_parser()
    argv = [
        "eval",
        "--agent-type",
        "visual_agent",
        "--game",
        "bolt_unscrew",
        "--difficulty",
        "easy",
        legacy_filter,
    ]
    if legacy_filter == "--level":
        argv.append("1")

    with pytest.raises(SystemExit):
        parser.parse_args(argv)


def test_longpuzzlebench_cli_exposes_only_canonical_public_game_ids() -> None:
    parser = create_parser()

    with pytest.raises(SystemExit):
        parser.parse_args(
            [
                "eval",
                "--agent-type",
                "visual_agent",
                "--game",
                "truck_escape_2",
                "--difficulty",
                "easy",
            ]
        )


def test_public_mini_games_selection_requires_one_game_and_difficulty() -> None:
    _validate_public_selection(_args(game="bolt_unscrew", difficulty="easy"))

    with pytest.raises(ValueError, match="exactly one --game and one --difficulty"):
        _validate_public_selection(_args(game="bolt_unscrew"))
    with pytest.raises(ValueError, match="exactly one --game and one --difficulty"):
        _validate_public_selection(_args(game="bolt_unscrew,rush_hour_2", difficulty="easy"))
    with pytest.raises(ValueError, match="--task is not a public LongPuzzleBench filter"):
        _validate_public_selection(
            _args(
                game="bolt_unscrew",
                difficulty="easy",
                task="bolt_unscrew.easy.level_01.seed_0",
            )
        )


def test_unified_openai_agent_type_is_rejected() -> None:
    from mobile_world.agents.registry import create_agent

    with pytest.raises(ValueError, match="deprecated"):
        create_agent(
            "unified_openai",
            "example/model",
            "http://example.invalid",
            "test",
            env=SimpleNamespace(tools=[]),
        )


def test_general_e2e_cli_surface_exposes_sampling_controls() -> None:
    parser = create_parser()
    args = parser.parse_args(
        [
            "eval",
            "--agent-type",
            "general_e2e",
            "--model-name",
            "example/model",
            "--game",
            "bolt_unscrew",
            "--difficulty",
            "easy",
            "--provider",
            "openrouter",
            "--max-output-tokens",
            "512",
            "--reasoning-effort",
            "high",
        ]
    )

    assert args.agent_type == "general_e2e"
    assert args.provider == "openrouter"
    assert args.max_output_tokens == 512
    assert args.reasoning_effort == "high"
    assert args.history_n_images is None
    assert not hasattr(args, "history_turns")
    assert not hasattr(args, "context_setting")

    for effort in ("xhigh", "max"):
        parsed = parser.parse_args(
            [
                "eval",
                "--agent-type",
                "general_e2e",
                "--model-name",
                "example/model",
                "--game",
                "bolt_unscrew",
                "--difficulty",
                "easy",
                "--reasoning-effort",
                effort,
            ]
        )
        assert parsed.reasoning_effort == effort


def test_dry_run_generates_empty_machine_readable_reports(tmp_path: Path) -> None:
    args = _args(
        config="configs/longpuzzlebench.json",
        game="bolt_unscrew",
        difficulty="easy",
        agent_type="visual_agent",
        model_name=None,
        num_runs=1,
        output=str(tmp_path),
        log_file_root=None,
        dry_run=True,
    )

    report = run_mini_games_benchmark(args)

    assert report["dry_run"] is True
    assert report["tasks"] == [
        f"bolt_unscrew.easy.level_{level:02d}.seed_0" for level in range(1, 9)
    ]
    assert (tmp_path / "summary.json").is_file()
    assert (tmp_path / "leaderboard.csv").is_file()


def test_agent_constructor_receives_tools_only_environment_facade(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_create_agent(*args: Any, **kwargs: Any) -> object:
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(mini_games_runner, "create_agent", fake_create_agent)
    args = _args(
        agent_type="visual_agent",
        model_name=None,
        llm_base_url=None,
        api_key=None,
    )
    real_environment = SimpleNamespace(tools=[{"name": "tap"}], get_game_state=lambda: {})

    mini_games_runner._make_agent(
        args,
        cast(Any, real_environment),
        experiment=ExperimentSettings(),
        history_n_images=3,
    )

    agent_environment = captured["env"]
    assert agent_environment.tools == [{"name": "tap"}]
    assert not hasattr(agent_environment, "get_game_state")
    assert not hasattr(agent_environment, "page")
    assert not hasattr(agent_environment, "base_url")


def test_general_models_receive_responses_runtime_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_create_agent(*args: Any, **kwargs: Any) -> object:
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(mini_games_runner, "create_agent", fake_create_agent)
    args = _args(
        agent_type="general_e2e",
        model_name="qwen/qwen3-vl-235b-a22b-instruct",
        llm_base_url="https://openrouter.ai/api/v1",
        api_key="test",
        temperature=0.0,
        max_output_tokens=32768,
        reasoning_effort="high",
    )

    mini_games_runner._make_agent(
        args,
        cast(Any, SimpleNamespace(tools=[])),
        experiment=ExperimentSettings(),
        history_n_images=30,
    )

    assert captured["runtime_conf"] == {
        "history_n_images": 30,
        "temperature": 0.0,
        "max_tokens": 32768,
        "reasoning_effort": "high",
        "mini_game_mode": True,
    }


def test_claude_chat_models_receive_the_same_runtime_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_create_agent(*args: Any, **kwargs: Any) -> object:
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(mini_games_runner, "create_agent", fake_create_agent)
    args = _args(
        agent_type="general_e2e",
        model_name="claude-sonnet-5",
        llm_base_url="https://example.invalid/v1",
        api_key="test",
        temperature=0.0,
        max_output_tokens=16384,
        reasoning_effort="medium",
    )

    mini_games_runner._make_agent(
        args,
        cast(Any, SimpleNamespace(tools=[])),
        experiment=ExperimentSettings(),
        history_n_images=None,
    )

    assert captured["runtime_conf"] == {
        "history_n_images": None,
        "temperature": 0.0,
        "max_tokens": 16384,
        "reasoning_effort": "medium",
        "mini_game_mode": True,
    }


def test_mini_game_history_window_is_applied_to_native_agents(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    native_agent = SimpleNamespace(
        history_n=1,
        _framework_runtime_conf={"temperature": 0.0, "history_n": 1},
    )
    monkeypatch.setattr(
        mini_games_runner,
        "create_agent",
        lambda *args, **kwargs: native_agent,
    )
    args = _args(
        agent_type="gui_owl_1_5",
        model_name="example/model",
        llm_base_url="http://example.invalid",
        api_key="test",
        history_n_images=3,
    )

    result = mini_games_runner._make_agent(
        args,
        cast(Any, SimpleNamespace(tools=[])),
        experiment=ExperimentSettings(),
        history_n_images=3,
    )

    assert result.history_n == 3
    assert result._framework_runtime_conf["history_n"] == 3


def test_omitted_history_window_keeps_full_history() -> None:
    args = _args(agent_type="general_e2e")
    images = mini_games_runner._effective_history_n_images(args)

    assert images is None


def test_history_turns_is_rejected() -> None:
    args = _args(
        agent_type="general_e2e",
        model_name="example/model",
        llm_base_url="http://example.invalid",
        api_key="test",
        history_turns=8,
    )
    with pytest.raises(ValueError, match="deprecated"):
        _make_agent(
            args,
            cast(Any, SimpleNamespace(tools=[])),
            experiment=ExperimentSettings(),
            history_n_images=None,
        )


def test_context_setting_is_rejected() -> None:
    args = _args(
        agent_type="gui_owl_1_5",
        model_name="example/model",
        llm_base_url="http://example.invalid",
        api_key="test",
        context_setting="hybrid",
    )
    with pytest.raises(ValueError, match="deprecated"):
        _make_agent(
            args,
            cast(Any, SimpleNamespace(tools=[])),
            experiment=ExperimentSettings(),
            history_n_images=None,
        )


def test_episode_detects_visual_cycle_and_sends_only_public_recovery_feedback(
    tmp_path: Path,
) -> None:
    class CyclingEnvironment:
        base_url = "http://example.invalid"

        def __init__(self) -> None:
            self.frame_id = 0
            self.current = False
            self.last_result: dict[str, Any] | None = None

        def _observation(self, feedback=None) -> Observation:
            self.frame_id += 1
            color = "white" if self.current else "black"
            return Observation(
                screenshot=Image.new("RGB", (100, 200), color),
                frame_id=self.frame_id,
                action_feedback=feedback,
            )

        def initialize_task(self, task) -> Observation:
            return self._observation()

        def execute_action(self, action) -> Observation:
            pre_frame = self.frame_id
            self.current = not self.current
            action_id = f"action-{pre_frame}"
            feedback = PublicActionFeedback(
                action_id=action_id,
                status="screen_changed",
                executed=True,
                fresh_observation=True,
            )
            observation = self._observation(feedback)
            self.last_result = {
                "action_id": action_id,
                "executed": True,
                "visual_changed": True,
                "visual_change_ratio": 1.0,
                "observation_effect": {
                    "visual_changed": True,
                    "visual_change_ratio": 1.0,
                    "stable": True,
                },
                "public_feedback": feedback.model_dump(),
            }
            return observation

        def observe(self, wait_to_stabilize=True) -> Observation:
            return self._observation()

        def get_last_action_result(self):
            return dict(self.last_result or {})

        def get_game_state(self):
            return {
                "status": "running",
                "success": False,
                "failure": False,
                "terminal": False,
                "raw_metrics": {"removed": 0},
            }

        def get_observation_metadata(self):
            return {"frame_id": self.frame_id}

        def is_terminal(self):
            return False

    class JitteringAgent:
        def __init__(self) -> None:
            self.observations: list[dict[str, Any]] = []
            self.index = 0

        def initialize(self, instruction):
            return True

        def predict(self, observation):
            self.observations.append(observation)
            self.index += 1
            return "raw", JSONAction(
                action_type="click",
                x=50,
                y=100 + (self.index % 2) * 35,
            )

        def get_total_token_usage(self):
            return {"total_tokens": 0}

        def done(self):
            return None

    env = CyclingEnvironment()
    agent = JitteringAgent()
    task = MiniGameTaskSpec(
        game_id="bolt_unscrew",
        difficulty="easy",
        level_id=1,
        instruction="Complete the visible game.",
        max_steps=20,
        timeout_seconds=10,
    )

    result = _execute_episode(
        env=cast(Any, env),
        evaluator=MiniGameEvaluator(),
        task=task,
        agent=cast(Any, agent),
        traj_logger=TrajLogger(str(tmp_path), task.task_id),
        agent_information={"name": "scripted"},
        run_index=1,
        no_progress_recovery_steps=3,
        no_progress_termination_steps=6,
        no_progress_max_cycle_length=4,
    )

    assert result.episode_status == "repeated_action_cycle"
    assert result.termination_reason == "repeated_action_cycle"
    assert result.step_count == 6
    cycle = result.trajectory[-1]["cycle_detection"]
    assert cycle["cycle_length"] == 2
    assert cycle["cycle_repetitions"] == 3
    assert cycle["triggered_step"] == 6
    assert cycle["raw_action"]["action_type"] == "click"
    assert cycle["action_signature"]["action_type"] == "click"
    assert cycle["observation_hash"]
    assert cycle["state_signature"]
    recovery_feedback = [
        item["action_feedback"]
        for item in agent.observations
        if (item.get("action_feedback") or {}).get("recovery_required")
    ]
    assert recovery_feedback
    assert recovery_feedback[0]["status"] == "repeating_visual_cycle"
    assert "objective_progressed" not in recovery_feedback[0]
    assert "state_changed" not in recovery_feedback[0]


def test_rejected_attempt_telemetry_is_not_objective_progress() -> None:
    def _state(
        attempts: int,
        accepted: int,
        state_key: str,
        *,
        progress_ratio: float = 0.0,
    ) -> dict[str, Any]:
        return {
            "status": "running",
            "success": False,
            "failure": False,
            "terminal": False,
            "raw_metrics": {
                "final_progress": {
                    "stateKey": state_key,
                    "exactMovesRemaining": 4,
                    "progressRatio": progress_ratio,
                },
                "metrics": {
                    "acceptedMoves": accepted,
                    "currentProgressRatio": progress_ratio,
                    "totalOperationAttempts": attempts,
                    "invalidOperations": attempts - accepted,
                    "invalidOperationRate": (attempts - accepted) / attempts,
                    "totalDurationMs": 8630 * attempts,
                    "idleTimeMs": 8630 * attempts,
                },
                "score": {"dimensions": {"performanceCore": 18.5 - attempts}},
            },
        }

    rejected = _objective_progress_payload(_state(2, 0, "0,1|2,1"), game_id="rush_hour_2")
    stagnant = _objective_progress_payload(_state(1, 0, "0,1|2,1"), game_id="rush_hour_2")
    accepted_identity = _objective_progress_payload(_state(3, 1, "0,1|2,2"), game_id="rush_hour_2")
    improved = _objective_progress_payload(
        _state(3, 1, "0,1|2,3", progress_ratio=0.4), game_id="rush_hour_2"
    )

    assert rejected["level_progress"] == stagnant["level_progress"] == 0.0
    assert accepted_identity["level_progress"] == 0.0
    assert not objective_improved(stagnant, rejected)
    assert not objective_improved(stagnant, accepted_identity)
    assert objective_improved(stagnant, improved)


def test_episode_terminates_when_only_attempt_counters_advance(tmp_path: Path) -> None:
    class RejectingEnvironment:
        """Dispatch succeeds, but the game rejects every move."""

        base_url = "http://example.invalid"

        def __init__(self) -> None:
            self.frame_id = 0
            self.attempts = 0
            self.last_result: dict[str, Any] | None = None

        def _observation(self, feedback=None) -> Observation:
            self.frame_id += 1
            return Observation(
                screenshot=Image.new("RGB", (100, 200), "black"),
                frame_id=self.frame_id,
                action_feedback=feedback,
            )

        def initialize_task(self, task) -> Observation:
            return self._observation()

        def execute_action(self, action) -> Observation:
            self.attempts += 1
            action_id = f"action-{self.attempts}"
            feedback = PublicActionFeedback(
                action_id=action_id,
                status="no_visible_effect",
                executed=True,
                fresh_observation=True,
            )
            observation = self._observation(feedback)
            self.last_result = {
                "action_id": action_id,
                "executed": True,
                "visual_changed": False,
                "visual_change_ratio": 0.0,
                "observation_effect": {
                    "visual_changed": False,
                    "visual_change_ratio": 0.0,
                    "stable": True,
                },
                "public_feedback": feedback.model_dump(),
            }
            return observation

        def observe(self, wait_to_stabilize=True) -> Observation:
            return self._observation()

        def get_last_action_result(self):
            return dict(self.last_result or {})

        def get_game_state(self):
            return {
                "status": "running",
                "success": False,
                "failure": False,
                "terminal": False,
                "raw_metrics": {
                    "final_progress": {"stateKey": "0,1|2,1", "exactMovesRemaining": 4},
                    "metrics": {
                        "acceptedMoves": 0,
                        "currentProgressRatio": 0,
                        "totalOperationAttempts": self.attempts,
                        "invalidOperations": self.attempts,
                        "totalDurationMs": 1000 * self.attempts,
                        "idleTimeMs": 1000 * self.attempts,
                    },
                },
            }

        def get_observation_metadata(self):
            return {"frame_id": self.frame_id}

        def is_terminal(self):
            return False

    class RepeatingAgent:
        def __init__(self) -> None:
            self.feedback: list[Any] = []

        def initialize(self, instruction):
            return True

        def predict(self, observation):
            self.feedback.append(observation.get("action_feedback"))
            return "raw", JSONAction(
                action_type="drag",
                start_x=729,
                start_y=921,
                end_x=729,
                end_y=691,
            )

        def get_total_token_usage(self):
            return {"total_tokens": 0}

        def done(self):
            return None

    env = RejectingEnvironment()
    agent = RepeatingAgent()
    task = MiniGameTaskSpec(
        game_id="rush_hour_2",
        difficulty="easy",
        level_id=1,
        instruction="Drive the red car out.",
        max_steps=20,
        timeout_seconds=30,
    )

    result = _execute_episode(
        env=cast(Any, env),
        evaluator=MiniGameEvaluator(),
        task=task,
        agent=cast(Any, agent),
        traj_logger=TrajLogger(str(tmp_path), task.task_id),
        agent_information={"name": "scripted"},
        run_index=1,
        no_progress_recovery_steps=3,
        no_progress_termination_steps=6,
        no_progress_max_cycle_length=4,
    )

    assert result.episode_status == "repeated_action_cycle"
    assert result.step_count == 6
    assert result.trajectory[-1]["no_progress"]["no_progress_steps"] == 6
    assert not any(step["no_progress"]["objective_progressed"] for step in result.trajectory)
    assert any((item or {}).get("recovery_required") for item in agent.feedback if item is not None)


def test_episode_terminates_when_accepted_moves_do_not_improve_level_progress(
    tmp_path: Path,
) -> None:
    class OscillatingRushHour:
        """Accepts every drag, but only toggles board identity at progress 0."""

        base_url = "http://example.invalid"

        def __init__(self) -> None:
            self.frame_id = 0
            self.moves = 0
            self.current = False
            self.last_result: dict[str, Any] | None = None

        def _observation(self, feedback=None) -> Observation:
            self.frame_id += 1
            color = "white" if self.current else "black"
            return Observation(
                screenshot=Image.new("RGB", (100, 200), color),
                frame_id=self.frame_id,
                action_feedback=feedback,
            )

        def initialize_task(self, task) -> Observation:
            return self._observation()

        def execute_action(self, action) -> Observation:
            self.moves += 1
            self.current = not self.current
            action_id = f"action-{self.moves}"
            feedback = PublicActionFeedback(
                action_id=action_id,
                status="returned_to_recent_screen",
                executed=True,
                fresh_observation=True,
                cycle_length=2,
            )
            observation = self._observation(feedback)
            self.last_result = {
                "action_id": action_id,
                "executed": True,
                "visual_changed": True,
                "visual_change_ratio": 1.0,
                "observation_effect": {
                    "visual_changed": True,
                    "visual_change_ratio": 1.0,
                    "stable": True,
                },
                "public_feedback": feedback.model_dump(),
            }
            return observation

        def observe(self, wait_to_stabilize=True) -> Observation:
            return self._observation()

        def get_last_action_result(self):
            return dict(self.last_result or {})

        def get_game_state(self):
            flipped = self.moves % 2
            return {
                "status": "running",
                "success": False,
                "failure": False,
                "terminal": False,
                "raw_metrics": {
                    "final_progress": {
                        "stateKey": "0,1|2,2" if flipped else "0,1|2,1",
                        "exactMovesRemaining": 4,
                        "progressRatio": 0,
                    },
                    "metrics": {
                        "acceptedMoves": self.moves,
                        "movedCells": self.moves,
                        "currentProgressRatio": 0,
                        "maxProgressRatio": 0,
                        "uniqueVehiclesMoved": min(self.moves, 2),
                    },
                },
            }

        def get_observation_metadata(self):
            return {"frame_id": self.frame_id}

        def is_terminal(self):
            return False

    class RepeatingAgent:
        def initialize(self, instruction):
            return True

        def predict(self, observation):
            return "raw", JSONAction(
                action_type="drag",
                start_x=550,
                start_y=547,
                end_x=405 if observation.get("frame_id", 0) % 2 else 766,
                end_y=547,
            )

        def get_total_token_usage(self):
            return {"total_tokens": 0}

        def done(self):
            return None

    result = _execute_episode(
        env=cast(Any, OscillatingRushHour()),
        evaluator=MiniGameEvaluator(),
        task=MiniGameTaskSpec(
            game_id="rush_hour_2",
            difficulty="easy",
            level_id=3,
            instruction="Drive the red car out.",
            max_steps=20,
            timeout_seconds=30,
        ),
        agent=cast(Any, RepeatingAgent()),
        traj_logger=TrajLogger(str(tmp_path), "rush_hour_2.easy.level_03.seed_0"),
        agent_information={"name": "scripted"},
        run_index=1,
        no_progress_recovery_steps=3,
        no_progress_termination_steps=6,
        no_progress_max_cycle_length=4,
    )

    assert result.episode_status == "repeated_action_cycle"
    assert result.step_count == 6
    assert result.trajectory[-1]["no_progress"]["no_progress_steps"] == 6
    assert not any(step["no_progress"]["objective_progressed"] for step in result.trajectory)


def test_episode_stops_after_configured_consecutive_invalid_actions(tmp_path: Path) -> None:
    class Environment:
        base_url = "http://example.invalid"

        def __init__(self) -> None:
            self.frame_id = 0

        def initialize_task(self, task) -> Observation:
            self.frame_id += 1
            return Observation(
                screenshot=Image.new("RGB", (100, 200), "black"),
                frame_id=self.frame_id,
            )

        def get_observation_metadata(self):
            return {"frame_id": self.frame_id}

        def get_game_state(self):
            return {"status": "running", "raw_metrics": {}}

    class InvalidAgent:
        def __init__(self) -> None:
            self.feedback = []

        def initialize(self, instruction):
            return True

        def predict(self, observation):
            self.feedback.append(observation.get("action_feedback"))
            return "bad", JSONAction(action_type="unknown", text="parse_error: invalid")

        def get_total_token_usage(self):
            return {"total_tokens": 0}

        def done(self):
            return None

    task = MiniGameTaskSpec(
        game_id="bolt_unscrew",
        difficulty="easy",
        level_id=1,
        instruction="Complete the visible game.",
        max_steps=20,
        timeout_seconds=10,
    )
    agent = InvalidAgent()

    result = _execute_episode(
        env=cast(Any, Environment()),
        evaluator=MiniGameEvaluator(),
        task=task,
        agent=cast(Any, agent),
        traj_logger=TrajLogger(str(tmp_path), task.task_id),
        agent_information={"name": "invalid"},
        run_index=1,
        invalid_action_limit=3,
    )

    assert result.episode_status == "invalid_action_limit"
    assert result.termination_reason == "invalid_action_limit"
    assert result.invalid_action_count == 3
    assert result.step_count == 3
    assert result.runtime["agent_decisions"] == 3
    assert result.runtime["environment_steps"] == 0
    assert agent.feedback[1]["status"] == "dispatch_failed"
    assert result.trajectory[-1]["episode_termination_reason"] == "invalid_action_limit"


def test_unsupported_web_action_is_feedback_not_environment_crash(tmp_path: Path) -> None:
    class Environment:
        base_url = "http://example.invalid"

        def initialize_task(self, task) -> Observation:
            return Observation(
                screenshot=Image.new("RGB", (100, 200), "black"),
                frame_id=1,
            )

        def execute_action(self, action):
            raise AssertionError("unsupported actions must not reach the environment")

        def get_observation_metadata(self):
            return {"frame_id": 1}

        def get_game_state(self):
            return {"status": "running", "raw_metrics": {}}

    class UnsupportedAgent:
        def initialize(self, instruction):
            return True

        def predict(self, observation):
            return "back", JSONAction(action_type="navigate_back")

        def get_total_token_usage(self):
            return {"total_tokens": 0}

        def done(self):
            return None

    task = MiniGameTaskSpec(
        game_id="bolt_unscrew",
        difficulty="easy",
        level_id=1,
        instruction="Complete the visible game.",
        max_steps=5,
        timeout_seconds=10,
    )

    result = _execute_episode(
        env=cast(Any, Environment()),
        evaluator=MiniGameEvaluator(),
        task=task,
        agent=cast(Any, UnsupportedAgent()),
        traj_logger=TrajLogger(str(tmp_path), task.task_id),
        agent_information={"name": "unsupported"},
        run_index=1,
        invalid_action_limit=1,
    )

    assert result.termination_reason == "invalid_action_limit"
    assert result.trajectory[0]["executed_action"] is None
    assert result.trajectory[0]["execution_result"]["reason"] == ("unsupported_environment_action")


@pytest.mark.parametrize("action_type", ["answer", "status", "finished"])
def test_answer_and_status_do_not_end_a_mini_game_episode(tmp_path: Path, action_type: str) -> None:
    class Environment:
        base_url = "http://example.invalid"

        def initialize_task(self, task) -> Observation:
            return Observation(
                screenshot=Image.new("RGB", (100, 200), "black"),
                frame_id=1,
            )

        def execute_action(self, action):
            raise AssertionError("answer/status must not reach the environment")

        def get_observation_metadata(self):
            return {"frame_id": 1}

        def get_game_state(self):
            return {"status": "running", "raw_metrics": {}}

    class TerminalAgent:
        def initialize(self, instruction):
            return True

        def predict(self, observation):
            return "done", JSONAction(action_type=action_type, text="task finished")

        def get_total_token_usage(self):
            return {"total_tokens": 0}

        def done(self):
            return None

    task = MiniGameTaskSpec(
        game_id="bolt_unscrew",
        difficulty="easy",
        level_id=1,
        instruction="Complete the visible game.",
        max_steps=5,
        timeout_seconds=10,
    )

    result = _execute_episode(
        env=cast(Any, Environment()),
        evaluator=MiniGameEvaluator(),
        task=task,
        agent=cast(Any, TerminalAgent()),
        traj_logger=TrajLogger(str(tmp_path), task.task_id),
        agent_information={"name": "terminal"},
        run_index=1,
        invalid_action_limit=3,
    )

    assert result.termination_reason == "invalid_action_limit"
    assert result.episode_status == "invalid_action_limit"
    assert result.invalid_action_count == 3
    assert result.trajectory[0]["execution_result"]["reason"] == ("unsupported_environment_action")


def test_deadlock_after_stable_action_stops_before_another_model_call(
    tmp_path: Path,
) -> None:
    class DeadlockEnvironment:
        base_url = "http://example.invalid"

        def __init__(self) -> None:
            self.frame_id = 0
            self.deadlocked = False
            self.last_result = None

        def _observation(self):
            self.frame_id += 1
            return Observation(
                screenshot=Image.new("RGB", (100, 200), "black"),
                frame_id=self.frame_id,
            )

        def initialize_task(self, task):
            return self._observation()

        def execute_action(self, action):
            self.deadlocked = True
            observation = self._observation()
            feedback = PublicActionFeedback(
                action_id="action-1",
                status="screen_changed",
                executed=True,
                fresh_observation=True,
            )
            self.last_result = {
                "action_id": "action-1",
                "executed": True,
                "observation_effect": {
                    "visual_changed": True,
                    "visual_change_ratio": 0.2,
                    "stable": True,
                },
                "public_feedback": feedback.model_dump(),
            }
            return observation.model_copy(update={"action_feedback": feedback})

        def get_last_action_result(self):
            return dict(self.last_result or {})

        def get_game_state(self):
            deadlock = {
                "is_deadlocked": self.deadlocked,
                "deadlock_reason": "no_available_hole" if self.deadlocked else None,
                "available_hole_count": 0 if self.deadlocked else 1,
                "legal_progress_action_count": 0 if self.deadlocked else 2,
                "pending_operation_count": 0,
                "game_state_stable": True,
            }
            return {
                "game_id": "bolt_unscrew",
                "difficulty": "easy",
                "level_id": 1,
                "seed": 0,
                "status": "running",
                "success": False,
                "failure": False,
                "terminal": False,
                "raw_metrics": {"boards_exited": 0},
                "deadlock": deadlock,
            }

        def get_observation_metadata(self):
            return {"frame_id": self.frame_id}

        def is_terminal(self):
            return False

    class CountingAgent:
        def __init__(self) -> None:
            self.initialize_calls = 0
            self.predict_calls = 0

        def initialize(self, instruction):
            self.initialize_calls += 1
            return True

        def predict(self, observation):
            self.predict_calls += 1
            return "click", JSONAction(action_type="click", x=50, y=100)

        def get_total_token_usage(self):
            return {"total_tokens": 0}

        def done(self):
            return None

    task = MiniGameTaskSpec(
        game_id="bolt_unscrew",
        difficulty="easy",
        level_id=1,
        instruction="Complete the visible game.",
        max_steps=10,
        timeout_seconds=10,
    )
    agent = CountingAgent()
    result = _execute_episode(
        env=cast(Any, DeadlockEnvironment()),
        evaluator=MiniGameEvaluator(),
        task=task,
        agent=cast(Any, agent),
        traj_logger=TrajLogger(str(tmp_path), task.task_id),
        agent_information={"name": "counting"},
        run_index=1,
    )

    assert agent.predict_calls == 1
    assert result.step_count == 1
    assert result.termination_reason == "no_available_hole_deadlock"
    assert result.episode_status == "no_available_hole_deadlock"
    assert result.trajectory[-1]["deadlock"]["detected_at_step"] == 1
    assert result.trajectory[-1]["episode_termination_reason"] == ("no_available_hole_deadlock")

    initial_env = DeadlockEnvironment()
    initial_env.deadlocked = True
    initial_agent = CountingAgent()
    initial_result = _execute_episode(
        env=cast(Any, initial_env),
        evaluator=MiniGameEvaluator(),
        task=task,
        agent=cast(Any, initial_agent),
        traj_logger=TrajLogger(str(tmp_path / "initial"), task.task_id),
        agent_information={"name": "counting"},
        run_index=1,
    )

    assert initial_agent.initialize_calls == 0
    assert initial_agent.predict_calls == 0
    assert initial_result.step_count == 0
    assert initial_result.termination_reason == "no_available_hole_deadlock"
    assert initial_result.trajectory[0]["event"] == "deadlock_detected"


def test_level_success_survives_the_game_auto_advancing(tmp_path: Path) -> None:
    class AutoAdvancingEnvironment:
        """Mirror the bridge contract of a game that loads the next level itself."""

        base_url = "http://example.invalid"

        def __init__(self) -> None:
            self.frame_id = 0
            self.moves = 0
            self.latched: dict[str, Any] | None = None
            self.last_result: dict[str, Any] | None = None

        def _observation(self, feedback=None) -> Observation:
            self.frame_id += 1
            return Observation(
                screenshot=Image.new("RGB", (100, 200), (self.moves * 40 % 255, 0, 0)),
                frame_id=self.frame_id,
                action_feedback=feedback,
            )

        def initialize_task(self, task) -> Observation:
            return self._observation()

        def observe(self, wait_to_stabilize=True) -> Observation:
            return self._observation()

        def get_observation_metadata(self):
            return {"frame_id": self.frame_id}

        def execute_action(self, action) -> Observation:
            self.moves += 1
            action_id = f"action-{self.moves}"
            feedback = PublicActionFeedback(
                action_id=action_id,
                status="screen_changed",
                executed=True,
                fresh_observation=True,
            )
            # The winning move is observed once as a solved level 1 and is then
            # replaced by the freshly loaded level 2 board.
            if self.moves == 2:
                self.get_game_state()
            self.last_result = {
                "action_id": action_id,
                "executed": True,
                "visual_changed": True,
                "visual_change_ratio": 1.0,
                "observation_effect": {
                    "visual_changed": True,
                    "visual_change_ratio": 1.0,
                    "stable": True,
                },
                "public_feedback": feedback.model_dump(),
            }
            return self._observation(feedback)

        def get_last_action_result(self):
            return dict(self.last_result or {})

        def get_game_state(self):
            if self.moves < 2:
                state = {
                    "status": "running",
                    "success": False,
                    "failure": False,
                    "level_id": 1,
                    "raw_metrics": {"move_count": self.moves},
                }
            elif self.latched is None:
                state = {
                    "status": "success",
                    "success": True,
                    "failure": False,
                    "level_id": 1,
                    "raw_metrics": {"move_count": self.moves},
                }
            else:
                state = {
                    "status": "loading",
                    "success": False,
                    "failure": False,
                    "level_id": 2,
                    "raw_metrics": {"move_count": 0},
                }
            if self.latched is None and (state["success"] or state["failure"]):
                self.latched = dict(state)
            return state

        def get_latched_terminal_state(self):
            return dict(self.latched) if self.latched is not None else None

        def is_terminal(self):
            return self.latched is not None

    class ClickingAgent:
        def initialize(self, instruction):
            return True

        def predict(self, observation):
            return "raw", JSONAction(action_type="click", x=10, y=20)

        def get_total_token_usage(self):
            return {"total_tokens": 0}

        def done(self):
            return None

    env = AutoAdvancingEnvironment()
    task = MiniGameTaskSpec(
        game_id="nut_and_bolt",
        difficulty="easy",
        level_id=1,
        instruction="Sort the nuts by color.",
        max_steps=20,
        timeout_seconds=30,
    )

    result = _execute_episode(
        env=cast(Any, env),
        evaluator=MiniGameEvaluator(),
        task=task,
        agent=cast(Any, ClickingAgent()),
        traj_logger=TrajLogger(str(tmp_path), task.task_id),
        agent_information={"name": "scripted"},
        run_index=1,
    )

    assert result.task_success is True
    assert result.episode_status == "success"
    assert result.termination_reason == "success"
    assert result.step_count == 2
    assert result.terminal_state["level_id"] == 1
    assert not any("identity mismatch" in error for error in result.errors)


def test_progressive_report_separates_level_progress_from_overall_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report, _, started = _run_scripted_benchmark(
        tmp_path, monkeypatch, ["success", "success", "failure"], levels="1,2,3"
    )

    assert len(started) == 3
    assert report["levels_completed"] == 2
    assert report["levels_attempted"] == 3
    assert report["levels_planned"] == 3
    assert report["highest_level_reached"] == 3
    assert report["highest_level_completed"] == 2
    assert report["level_success_rate"] == pytest.approx(2 / 3)
    assert report["overall_success"] is False
    assert report["success_rate"] == pytest.approx(2 / 3)
    chain = report["chains"][0]
    assert chain["levels_completed"] == 2
    assert chain["highest_level_reached"] == 3
    assert chain["overall_success"] is False


def test_first_level_failure_reports_the_level_it_reached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report, _, started = _run_scripted_benchmark(tmp_path, monkeypatch, ["failure"], levels="1,2,3")

    assert len(started) == 1
    assert report["levels_completed"] == 0
    assert report["levels_attempted"] == 1
    assert report["highest_level_reached"] == 1
    assert report["highest_level_completed"] is None
    assert report["level_success_rate"] == 0.0
    assert report["success_rate"] == 0.0
    assert report["overall_success"] is False


def test_completing_every_level_reports_overall_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report, _, _ = _run_scripted_benchmark(
        tmp_path, monkeypatch, ["success", "success", "success"], levels="1,2,3"
    )

    assert report["overall_success"] is True
    assert report["level_success_rate"] == 1.0
    assert report["success_rate"] == 1.0
    assert report["highest_level_completed"] == 3


def test_all_levels_mode_rates_success_over_attempted_levels(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report, _, started = _run_scripted_benchmark(
        tmp_path,
        monkeypatch,
        ["failure", "success", "success"],
        levels="1,2,3",
        eval_mode="all_levels",
    )

    assert len(started) == 3
    assert report["levels_attempted"] == 3
    assert report["levels_completed"] == 2
    assert report["level_success_rate"] == pytest.approx(2 / 3)
    assert report["overall_success"] is False


class _RunnerEnvironment:
    def __init__(self) -> None:
        self.started = False
        self.closed = False
        self.torn_down: list[str] = []

    def start(self) -> None:
        self.started = True

    def tear_down_task(self, task_id: str) -> None:
        self.torn_down.append(task_id)

    def close(self) -> None:
        self.closed = True


def _run_scripted_benchmark(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    outcomes: list[str],
    levels: str = "1,2",
    eval_mode: str | None = None,
):
    environment = _RunnerEnvironment()
    started_tasks: list[str] = []

    def fake_execute_episode(**kwargs):
        task = kwargs["task"]
        outcome = outcomes[len(started_tasks)]
        started_tasks.append(task.task_id)
        evaluator = MiniGameEvaluator()
        if outcome == "success":
            return evaluator.evaluate(
                {"status": "success", "success": True},
                task,
                steps=1,
                elapsed=1,
                agent_information={"name": "scripted"},
            )
        if outcome == "failure":
            return evaluator.evaluate(
                {"status": "failure", "failure": True},
                task,
                steps=1,
                elapsed=1,
                agent_information={"name": "scripted"},
            )
        if outcome == "repeated_action_cycle":
            return evaluator.evaluate(
                {"status": "running"},
                task,
                steps=6,
                elapsed=1,
                repeated_action_cycle=True,
                termination_reason="repeated_action_cycle",
                agent_information={"name": "scripted"},
                trajectory=[{"cycle_detection": {"triggered_step": 6}}],
            )
        if outcome == "max_steps":
            return evaluator.evaluate(
                {"status": "running"},
                task,
                steps=task.max_steps,
                elapsed=1,
                max_step_reached=True,
                agent_information={"name": "scripted"},
            )
        if outcome == "agent_error":
            return evaluator.evaluate(
                {"status": "running"},
                task,
                steps=0,
                elapsed=0,
                agent_error="Agent LLM failed",
                termination_reason="agent_error",
                agent_information={"name": "scripted"},
            )
        if outcome == "deadlock":
            return evaluator.evaluate(
                {
                    "status": "running",
                    "deadlock": {
                        "is_deadlocked": True,
                        "deadlock_reason": "no_available_hole",
                        "available_hole_count": 0,
                        "legal_progress_action_count": 0,
                        "pending_operation_count": 0,
                        "game_state_stable": True,
                    },
                },
                task,
                steps=1,
                elapsed=1,
                termination_reason="no_available_hole_deadlock",
                agent_information={"name": "scripted"},
            )
        raise AssertionError(outcome)

    monkeypatch.setattr(mini_games_runner, "_make_environment", lambda *args, **kwargs: environment)
    monkeypatch.setattr(mini_games_runner, "_make_agent", lambda *args, **kwargs: object())
    monkeypatch.setattr(mini_games_runner, "_execute_episode", fake_execute_episode)
    monkeypatch.setattr(mini_games_runner, "_print_summary", lambda *args, **kwargs: None)
    args = _args(
        config="configs/longpuzzlebench.json",
        game="bolt_unscrew",
        difficulty="easy",
        debug_level=levels,
        agent_type="scripted",
        model_name=None,
        num_runs=1,
        output=str(tmp_path),
        log_file_root=None,
        dry_run=False,
        eval_mode=eval_mode,
    )
    report = run_mini_games_benchmark(args)
    return report, environment, started_tasks


def test_sequential_success_starts_the_next_level(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report, environment, started = _run_scripted_benchmark(
        tmp_path, monkeypatch, ["success", "success"]
    )

    assert len(started) == 2
    assert report["benchmark_status"] == "completed"
    assert report["remaining_tasks"] == 0
    assert environment.torn_down == started
    assert environment.closed is True


@pytest.mark.parametrize(
    ("outcome", "reason"),
    [
        ("failure", "game_failure"),
        ("repeated_action_cycle", "repeated_action_cycle"),
        ("max_steps", "max_steps"),
        ("deadlock", "no_available_hole_deadlock"),
    ],
)
def test_sequential_failure_stops_before_the_next_level_and_saves_results(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    outcome: str,
    reason: str,
) -> None:
    report, environment, started = _run_scripted_benchmark(tmp_path, monkeypatch, [outcome])

    assert len(started) == 1
    assert environment.torn_down == started
    assert environment.closed is True
    assert report["benchmark_status"] == "terminated"
    assert report["termination_reason"] == reason
    assert report["failed_task_id"] == started[0]
    assert report["completed_tasks"] == 0
    assert report["executed_tasks"] == 1
    assert report["failed_tasks"] == 1
    assert report["remaining_tasks"] == 1
    assert report["not_run_tasks"][0]["task_id"].endswith("level_02.seed_0")

    summary = json.loads((tmp_path / "summary.json").read_text())
    episodes = (tmp_path / "episodes.jsonl").read_text().strip().splitlines()
    assert len(episodes) == 1
    assert summary["benchmark"]["termination_reason"] == reason
    assert summary["overall"]["episode_count"] == 1
    assert summary["overall"]["score_denominator"] == 2
    assert summary["overall"]["not_run_count"] == 1
    assert summary["overall"]["average_normalized_score"] == 0


def test_all_levels_continues_after_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    environment = _RunnerEnvironment()
    started_tasks: list[str] = []

    def fake_execute_episode(**kwargs):
        task = kwargs["task"]
        started_tasks.append(task.task_id)
        evaluator = MiniGameEvaluator()
        agent_information = kwargs.get("agent_information") or {"name": "scripted"}
        if len(started_tasks) == 1:
            return evaluator.evaluate(
                {"status": "failure", "failure": True},
                task,
                steps=1,
                elapsed=1,
                agent_information=agent_information,
            )
        return evaluator.evaluate(
            {"status": "success", "success": True},
            task,
            steps=1,
            elapsed=1,
            agent_information=agent_information,
        )

    monkeypatch.setattr(mini_games_runner, "_make_environment", lambda *args, **kwargs: environment)
    monkeypatch.setattr(mini_games_runner, "_make_agent", lambda *args, **kwargs: object())
    monkeypatch.setattr(mini_games_runner, "_execute_episode", fake_execute_episode)
    monkeypatch.setattr(mini_games_runner, "_print_summary", lambda *args, **kwargs: None)
    args = _args(
        config="configs/longpuzzlebench.json",
        game="bolt_unscrew",
        difficulty="easy",
        debug_level="1,2",
        agent_type="scripted",
        model_name=None,
        num_runs=1,
        output=str(tmp_path),
        log_file_root=None,
        dry_run=False,
        eval_mode="all_levels",
    )
    report = run_mini_games_benchmark(args)

    assert started_tasks == [
        "bolt_unscrew.easy.level_01.seed_0",
        "bolt_unscrew.easy.level_02.seed_0",
    ]
    assert report["eval_mode"] == "all_levels"
    assert report["executed_tasks"] == 2
    assert report["remaining_tasks"] == 0
    assert report["benchmark_status"] == "completed"
    episode = json.loads((tmp_path / "episodes.jsonl").read_text().splitlines()[0])
    assert episode["prompt_setting"] == "full"
    assert "context_setting" not in episode
    assert episode["eval_mode"] == "all_levels"
    assert episode["history_n_images"] is None
    assert "level_score" in episode
    assert "final_success" in episode


def test_environment_start_failure_still_writes_summary_and_closes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FailingEnvironment(_RunnerEnvironment):
        def start(self) -> None:
            raise RuntimeError("browser unavailable")

    environment = FailingEnvironment()
    monkeypatch.setattr(mini_games_runner, "_make_environment", lambda *args, **kwargs: environment)
    monkeypatch.setattr(mini_games_runner, "_print_summary", lambda *args, **kwargs: None)
    args = _args(
        config="configs/longpuzzlebench.json",
        game="bolt_unscrew",
        difficulty="easy",
        debug_level="1,2",
        agent_type="scripted",
        model_name=None,
        num_runs=1,
        output=str(tmp_path),
        log_file_root=None,
        dry_run=False,
    )

    report = run_mini_games_benchmark(args)

    assert report["termination_reason"] == "environment_error"
    assert report["executed_tasks"] == 1
    assert report["remaining_tasks"] == 1
    assert environment.closed is True
    episode = json.loads((tmp_path / "episodes.jsonl").read_text())
    assert episode["termination_reason"] == "environment_error"


class _Clock:
    def __init__(self, start: float = 1_000.0) -> None:
        self.now = start

    def monotonic(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _running_env(
    *,
    clock: _Clock | None = None,
    terminal_after: int = 1,
    play_seconds: float = 1.5,
):
    class Environment:
        base_url = "http://example.invalid"

        def __init__(self) -> None:
            self.frame_id = 0
            self.clicks = 0
            self.events: list[str] = []
            self.failed = False

        def initialize_task(self, task) -> Observation:
            self.frame_id += 1
            return Observation(
                screenshot=Image.new("RGB", (100, 200), "black"),
                frame_id=self.frame_id,
            )

        def execute_action(self, action):
            if clock is not None:
                clock.advance(play_seconds)
            self.clicks += 1
            self.frame_id += 1
            self.last_result = {"executed": True, "reason": "completed"}
            return Observation(
                screenshot=Image.new("RGB", (100, 200), "white"),
                frame_id=self.frame_id,
            )

        def get_last_action_result(self):
            return {"executed": True, "reason": "completed"}

        def get_observation_metadata(self):
            return {"frame_id": self.frame_id}

        def get_game_state(self):
            if self.failed:
                return {"status": "failure", "failure": True, "success": False}
            if self.clicks >= terminal_after:
                return {"status": "success", "success": True, "failure": False}
            return {"status": "running", "success": False, "failure": False}

        def is_terminal(self):
            return self.failed or self.clicks >= terminal_after

        def pause_simulation(self):
            self.events.append("pause")
            return {"applied": True, "via": "test"}

        def resume_simulation(self):
            self.events.append("resume")
            return {"applied": True, "via": "test"}

    return Environment()


def test_long_model_call_does_not_consume_play_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = _Clock()
    monkeypatch.setattr(mini_games_runner.time, "monotonic", clock.monotonic)
    env = _running_env(clock=clock, terminal_after=1, play_seconds=0.05)

    class ThinkingAgent:
        def initialize(self, instruction):
            return True

        def predict(self, observation):
            env.events.append("predict")
            clock.advance(5.0)
            return "raw", JSONAction(action_type="click", x=10, y=20)

        def get_total_token_usage(self):
            return {"total_tokens": 0}

        def done(self):
            return None

    task = MiniGameTaskSpec(
        game_id="bolt_unscrew",
        difficulty="easy",
        level_id=1,
        instruction="Complete the visible game.",
        max_steps=5,
        timeout_seconds=1,
    )
    result = _execute_episode(
        env=cast(Any, env),
        evaluator=MiniGameEvaluator(),
        task=task,
        agent=cast(Any, ThinkingAgent()),
        traj_logger=TrajLogger(str(tmp_path), task.task_id),
        agent_information={"name": "scripted"},
        run_index=1,
    )

    assert result.task_success is True
    assert result.termination_reason == "success"
    assert result.runtime["play_time_seconds"] == pytest.approx(0.05)
    assert result.runtime["model_duration_seconds"] == pytest.approx(5.0)
    assert env.events[:3] == ["pause", "predict", "resume"]


def test_play_budget_can_expire_after_dispatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = _Clock()
    monkeypatch.setattr(mini_games_runner.time, "monotonic", clock.monotonic)
    env = _running_env(clock=clock, terminal_after=99)

    class ClickAgent:
        def initialize(self, instruction):
            return True

        def predict(self, observation):
            return "raw", JSONAction(action_type="click", x=10, y=20)

        def get_total_token_usage(self):
            return {"total_tokens": 0}

        def done(self):
            return None

    task = MiniGameTaskSpec(
        game_id="bolt_unscrew",
        difficulty="easy",
        level_id=1,
        instruction="Complete the visible game.",
        max_steps=5,
        timeout_seconds=1,
    )
    result = _execute_episode(
        env=cast(Any, env),
        evaluator=MiniGameEvaluator(),
        task=task,
        agent=cast(Any, ClickAgent()),
        traj_logger=TrajLogger(str(tmp_path), task.task_id),
        agent_information={"name": "scripted"},
        run_index=1,
    )

    assert result.termination_reason == "timeout"
    assert result.runtime["environment_steps"] == 1
    assert result.runtime["play_time_seconds"] == pytest.approx(1.5)


def test_game_failure_during_thinking_is_harness_error_not_played_loss(
    tmp_path: Path,
) -> None:
    env = _running_env(terminal_after=99)
    env.failed = True

    class ClickAgent:
        def initialize(self, instruction):
            return True

        def predict(self, observation):
            return "raw", JSONAction(action_type="click", x=10, y=20)

        def get_total_token_usage(self):
            return {"total_tokens": 0}

        def done(self):
            return None

    task = MiniGameTaskSpec(
        game_id="bolt_unscrew",
        difficulty="easy",
        level_id=1,
        instruction="Complete the visible game.",
        max_steps=5,
        timeout_seconds=30,
    )
    result = _execute_episode(
        env=cast(Any, env),
        evaluator=MiniGameEvaluator(),
        task=task,
        agent=cast(Any, ClickAgent()),
        traj_logger=TrajLogger(str(tmp_path), task.task_id),
        agent_information={"name": "scripted"},
        run_index=1,
    )

    assert result.termination_reason == "environment_error"
    assert result.episode_status == "error"
    assert result.runtime["timeout_before_dispatch"] is True
    assert result.runtime["game_ended_during_prediction"] is True
    assert result.runtime["simulation_pause"][0]["pause"]["applied"] is True
    assert result.runtime["environment_steps"] == 0


def test_agent_error_is_retried_on_the_same_level(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report, _, started = _run_scripted_benchmark(
        tmp_path, monkeypatch, ["agent_error", "success"], levels="1"
    )

    assert started == ["bolt_unscrew.easy.level_01.seed_0"] * 2
    assert report["executed_tasks"] == 1
    assert report["completed_tasks"] == 1
    assert report["success_rate"] == 1.0
    assert report["comparable_success_rate"] == 1.0
    assert report["comparison_eligible"] is True


def test_agent_error_does_not_enter_comparable_denominator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    attempts = EnvironmentConfig().max_episode_retries + 1
    report, _, started = _run_scripted_benchmark(
        tmp_path,
        monkeypatch,
        ["agent_error"] * attempts,
        levels="1,2",
    )

    assert started == ["bolt_unscrew.easy.level_01.seed_0"] * attempts
    assert report["executed_tasks"] == 1
    assert report["remaining_tasks"] == 1
    assert report["success_rate"] == 0.0
    assert report["comparable_denominator"] == 0
    assert report["comparison_eligible"] is False
    assert report["harness_error_count"] == 1
