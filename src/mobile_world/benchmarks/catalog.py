"""Declarative catalogue loading and task selection."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from mobile_world.benchmarks.models import (
    BenchmarkExecutionConfig,
    EnvironmentConfig,
    ExperimentSettings,
    GameScoringConfig,
    MetricConfig,
    MiniGameTaskSpec,
    PromptSetting,
)

_GAME_ID_ALIASES = {
    "truck_escape_2": "rush_hour_2",
    "nuts_bolts": "nut_and_bolt",
}


def _canonical_game_id(game_id: str) -> str:
    return _GAME_ID_ALIASES.get(game_id, game_id)


def _canonical_task_id(task_id: str) -> str:
    game_id, separator, remainder = task_id.partition(".")
    if not separator:
        return task_id
    return f"{_canonical_game_id(game_id)}.{remainder}"


class MiniGameCatalog(BaseModel):
    """An immutable benchmark environment and its fully expanded task list."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    benchmark: str = "longpuzzlebench"
    environment: EnvironmentConfig
    execution: BenchmarkExecutionConfig = Field(default_factory=BenchmarkExecutionConfig)
    experiment: ExperimentSettings = Field(default_factory=ExperimentSettings)
    tasks: tuple[MiniGameTaskSpec, ...]
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_unique_tasks(self) -> MiniGameCatalog:
        identifiers = [task.task_id for task in self.tasks]
        duplicates = sorted(item for item, count in Counter(identifiers).items() if count > 1)
        if duplicates:
            raise ValueError(f"duplicate task_id values: {', '.join(duplicates)}")
        return self

    def with_experiment(self, experiment: ExperimentSettings) -> MiniGameCatalog:
        """Rebuild tasks so instruction text matches the selected prompt_setting."""

        if experiment.prompt_setting == self.experiment.prompt_setting:
            return self.model_copy(update={"experiment": experiment}, deep=True)
        # Instruction text is already expanded for the catalogue prompt_setting.
        # Callers that need a different prompt must reload from the source JSON.
        return self.model_copy(update={"experiment": experiment}, deep=True)

    def filter(
        self,
        *,
        game_id: str | Iterable[str] | None = None,
        difficulty: str | Iterable[str] | None = None,
        level_id: int | str | Iterable[int | str] | None = None,
        seed: int | Iterable[int] | None = None,
        task_id: str | Iterable[str] | None = None,
    ) -> tuple[MiniGameTaskSpec, ...]:
        return filter_tasks(
            self.tasks,
            game_id=game_id,
            difficulty=difficulty,
            level_id=level_id,
            seed=seed,
            task_id=task_id,
        )

    def get_task(self, task_id: str) -> MiniGameTaskSpec:
        """Return one task by stable id, raising ``KeyError`` when it is absent."""

        canonical_task_id = _canonical_task_id(task_id)
        for task in self.tasks:
            if task.task_id == canonical_task_id:
                return task
        raise KeyError(f"unknown LongPuzzleBench task: {task_id}")


class _Defaults(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_steps: int = Field(default=100, gt=0)
    timeout_seconds: float = Field(default=300.0, gt=0)
    seeds: list[int] = Field(default_factory=lambda: [0])
    success_condition: str = "The game bridge reports success."
    metric_config: MetricConfig = Field(default_factory=MetricConfig)


def _as_set(value: Any, *, scalar_types: tuple[type, ...]) -> set[Any] | None:
    if value is None:
        return None
    if isinstance(value, scalar_types):
        return {value}
    return set(value)


def filter_tasks(
    tasks: Sequence[MiniGameTaskSpec],
    *,
    game_id: str | Iterable[str] | None = None,
    difficulty: str | Iterable[str] | None = None,
    level_id: int | str | Iterable[int | str] | None = None,
    seed: int | Iterable[int] | None = None,
    task_id: str | Iterable[str] | None = None,
) -> tuple[MiniGameTaskSpec, ...]:
    """Select tasks by any benchmark dimension while preserving catalogue order."""

    games = _as_set(game_id, scalar_types=(str,))
    if games is not None:
        games = {_canonical_game_id(str(item)) for item in games}
    difficulties = _as_set(difficulty, scalar_types=(str,))
    levels = _as_set(level_id, scalar_types=(str, int))
    if levels is not None:
        levels = {
            int(item) if isinstance(item, str) and item.isdigit() else item for item in levels
        }
    seeds = _as_set(seed, scalar_types=(int,))
    identifiers = _as_set(task_id, scalar_types=(str,))
    if identifiers is not None:
        identifiers = {_canonical_task_id(str(item)) for item in identifiers}
    return tuple(
        task
        for task in tasks
        if (games is None or task.game_id in games)
        and (difficulties is None or task.difficulty in difficulties)
        and (levels is None or task.level_id in levels)
        and (seeds is None or task.seed in seeds)
        and (identifiers is None or task.task_id in identifiers)
    )


def _merged_metric_config(*values: dict[str, Any] | MetricConfig | None) -> MetricConfig:
    merged: dict[str, Any] = {}
    for value in values:
        if value is None:
            continue
        if isinstance(value, MetricConfig):
            merged.update(value.model_dump())
        else:
            merged.update(value)
    return MetricConfig.model_validate(merged)


def _select_instruction(
    entry: Mapping[str, Any],
    *,
    prompt_setting: PromptSetting,
    fallback: str | None = None,
) -> str:
    """Pick one prompt tier without changing action/system protocols.

    A game that declares ``instructions`` must declare the requested tier: a
    fallback here would serve one tier while the episode metadata records the
    other, making the prompt axis uninterpretable.
    """

    instructions = entry.get("instructions")
    if isinstance(instructions, Mapping):
        selected = instructions.get(prompt_setting)
        if selected is None or not str(selected).strip():
            raise ValueError(f"missing instruction for prompt_setting={prompt_setting!r}")
        return str(selected).strip()
    instruction = entry.get("instruction", fallback)
    if instruction is None or not str(instruction).strip():
        raise ValueError("game entry must declare instruction or instructions")
    return str(instruction).strip()


def _expand_game(
    game: dict[str, Any],
    defaults: _Defaults,
    scoring_policies: dict[str, GameScoringConfig],
    *,
    prompt_setting: PromptSetting,
) -> list[MiniGameTaskSpec]:
    required = {"game_id", "difficulties"}
    missing = required.difference(game)
    if missing:
        raise ValueError(f"game entry is missing: {', '.join(sorted(missing))}")
    if "instruction" not in game and "instructions" not in game:
        raise ValueError("game entry is missing: instruction or instructions")
    game_id = game["game_id"]
    instruction = _select_instruction(game, prompt_setting=prompt_setting)
    game_metric = game.get("metric_config")
    game_defaults = game.get("defaults", {})
    tasks: list[MiniGameTaskSpec] = []

    for difficulty_entry in game["difficulties"]:
        difficulty = difficulty_entry["name"]
        levels = difficulty_entry.get("levels", [])
        if not levels:
            raise ValueError(f"{game_id}.{difficulty} must declare at least one level")
        seeds = difficulty_entry.get("seeds", game_defaults.get("seeds", defaults.seeds))
        metric_config = _merged_metric_config(
            defaults.metric_config,
            game_metric,
            game_defaults.get("metric_config"),
            difficulty_entry.get("metric_config"),
        )
        difficulty_instruction = (
            _select_instruction(
                difficulty_entry,
                prompt_setting=prompt_setting,
                fallback=instruction,
            )
            if ("instruction" in difficulty_entry or "instructions" in difficulty_entry)
            else instruction
        )
        for level_id in levels:
            for seed in seeds:
                tasks.append(
                    MiniGameTaskSpec(
                        game_id=game_id,
                        difficulty=difficulty,
                        level_id=level_id,
                        seed=seed,
                        instruction=difficulty_instruction,
                        max_steps=difficulty_entry.get(
                            "max_steps", game_defaults.get("max_steps", defaults.max_steps)
                        ),
                        timeout_seconds=difficulty_entry.get(
                            "timeout_seconds",
                            game_defaults.get("timeout_seconds", defaults.timeout_seconds),
                        ),
                        success_condition=difficulty_entry.get(
                            "success_condition",
                            game_defaults.get("success_condition", defaults.success_condition),
                        ),
                        metric_config=metric_config,
                        scoring_config=scoring_policies.get(game_id),
                        viewport=difficulty_entry.get("viewport", game.get("viewport")),
                        launch_parameters={
                            **game.get("launch_parameters", {}),
                            **difficulty_entry.get("launch_parameters", {}),
                        },
                        tags=tuple(game.get("tags", ())) + tuple(difficulty_entry.get("tags", ())),
                    )
                )
    return tasks


def _load_scoring_policies(
    data: dict[str, Any],
) -> tuple[dict[str, GameScoringConfig], dict[str, str]]:
    scoring = data.get("scoring")
    if scoring is None:
        return {}, {}
    if not isinstance(scoring, dict):
        raise ValueError("scoring must be an object")
    version = str(scoring.get("version", "")).strip()
    if not version:
        raise ValueError("scoring.version must not be empty")
    games = scoring.get("games", {})
    if not isinstance(games, dict) or not games:
        raise ValueError("scoring.games must declare at least one game policy")

    policies: dict[str, GameScoringConfig] = {}
    for raw_game_id, raw_policy in games.items():
        game_id = _canonical_game_id(str(raw_game_id))
        if not isinstance(raw_policy, dict):
            raise ValueError(f"scoring.games.{raw_game_id} must be an object")
        policy = dict(raw_policy)
        configured_version = policy.setdefault("version", version)
        if configured_version != version:
            raise ValueError(f"scoring.games.{raw_game_id}.version must match scoring.version")
        policies[game_id] = GameScoringConfig.model_validate(policy)

    effective_scoring = {
        "version": version,
        "games": {
            game_id: policy.model_dump(mode="json", exclude_none=True)
            for game_id, policy in sorted(policies.items())
        },
    }
    payload = json.dumps(
        effective_scoring,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return policies, {
        "scoring_version": version,
        "scoring_config_hash": hashlib.sha256(payload).hexdigest(),
    }


def _load_experiment_settings(data: dict[str, Any]) -> ExperimentSettings:
    experiment = data.get("experiment")
    if experiment is None:
        execution = BenchmarkExecutionConfig.model_validate(data.get("benchmark_execution", {}))
        return ExperimentSettings(eval_mode=execution.resolve_eval_mode())
    if not isinstance(experiment, dict):
        raise ValueError("experiment must be an object")
    payload = dict(experiment)
    payload.pop("context_setting", None)
    payload.pop("context_presets", None)
    if "eval_mode" not in payload:
        execution = BenchmarkExecutionConfig.model_validate(data.get("benchmark_execution", {}))
        payload["eval_mode"] = execution.resolve_eval_mode()
    return ExperimentSettings.model_validate(payload)


def load_catalog(
    path: str | Path,
    *,
    prompt_setting: PromptSetting | None = None,
) -> MiniGameCatalog:
    """Load explicit tasks or expand compact ``games/difficulties/levels`` JSON."""

    config_path = Path(path)
    with config_path.open(encoding="utf-8") as file:
        data = json.load(file)
    defaults = _Defaults.model_validate(data.get("defaults", {}))
    scoring_policies, scoring_metadata = _load_scoring_policies(data)
    experiment = _load_experiment_settings(data)
    if prompt_setting is not None:
        # model_copy would skip validation and let an unknown tier be recorded
        # in the episode metadata while the fallback text is actually served.
        experiment = ExperimentSettings.model_validate(
            {**experiment.model_dump(), "prompt_setting": prompt_setting}
        )
    configured_game_ids = {
        _canonical_game_id(str(entry.get("game_id", "")))
        for key in ("games", "tasks")
        for entry in data.get(key, [])
    }
    if scoring_policies:
        missing_policies = sorted(configured_game_ids.difference(scoring_policies))
        unknown_policies = sorted(set(scoring_policies).difference(configured_game_ids))
        if missing_policies:
            raise ValueError(
                "missing scoring policy for configured games: " + ", ".join(missing_policies)
            )
        if unknown_policies:
            raise ValueError(
                "scoring policy references unknown games: " + ", ".join(unknown_policies)
            )
    tasks = []
    for item in data.get("tasks", []):
        task_data = dict(item)
        if "instructions" in task_data and "instruction" not in task_data:
            task_data["instruction"] = _select_instruction(
                task_data,
                prompt_setting=experiment.prompt_setting,
            )
            task_data.pop("instructions", None)
        task_data.setdefault(
            "scoring_config",
            scoring_policies.get(_canonical_game_id(str(task_data.get("game_id", "")))),
        )
        tasks.append(MiniGameTaskSpec.model_validate(task_data))
    for game in data.get("games", []):
        tasks.extend(
            _expand_game(
                game,
                defaults,
                scoring_policies,
                prompt_setting=experiment.prompt_setting,
            )
        )
    if not tasks:
        raise ValueError("benchmark catalogue contains no tasks")
    metadata = {
        **data.get("metadata", {}),
        **scoring_metadata,
        **experiment.public_metadata(),
    }
    return MiniGameCatalog(
        benchmark=data.get("benchmark", "longpuzzlebench"),
        environment=EnvironmentConfig.model_validate(data["environment"]),
        execution=BenchmarkExecutionConfig.model_validate(data.get("benchmark_execution", {})),
        experiment=experiment,
        tasks=tuple(tasks),
        metadata=metadata,
    )
