"""Typed data contracts for the LongPuzzleBench web-game benchmark."""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

NormalizationMode = Literal["binary", "linear", "existing_score"]
ProgressionMode = Literal["independent", "sequential_unlock"]
PromptSetting = Literal["minimal", "full"]
EvalMode = Literal["progressive", "all_levels"]
ScoringMode = Literal["composite", "success_rate_only"]
TerminationReason = Literal[
    "success",
    "game_failure",
    "no_available_hole_deadlock",
    "repeated_action_cycle",
    "no_progress",
    "game_deadlock",
    "max_steps",
    "timeout",
    "invalid_action_limit",
    "environment_error",
    "agent_error",
    "agent_terminated",
]
EpisodeStatus = Literal[
    "running",
    "success",
    "failure",
    "timeout",
    "max_steps",
    "agent_terminated",
    "no_available_hole_deadlock",
    "repeated_action_cycle",
    "invalid_action_limit",
    "no_progress",
    "deadlock",
    "error",
]
HARNESS_TERMINATION_REASONS: frozenset[str] = frozenset({"agent_error", "environment_error"})


def is_harness_termination(reason: str | None) -> bool:
    """Return True when the episode stopped for infrastructure, not play."""

    return str(reason or "") in HARNESS_TERMINATION_REASONS


def _identifier(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9_-]+", "_", value.strip()).strip("_").lower()
    if not value:
        raise ValueError("identifier must contain at least one letter or digit")
    return value


def _level_token(level_id: int | str) -> str:
    if isinstance(level_id, int) or str(level_id).isdigit():
        return f"level_{int(level_id):02d}"
    return f"level_{_identifier(str(level_id))}"


def stable_task_id(game_id: str, difficulty: str, level_id: int | str, seed: int) -> str:
    """Return the deterministic identifier used by result files and task filters."""

    if seed < 0:
        raise ValueError("seed must be non-negative")
    return f"{_identifier(game_id)}.{_identifier(difficulty)}.{_level_token(level_id)}.seed_{seed}"


class CycleDetectionConfig(BaseModel):
    """Reusable no-progress action-cycle detector policy."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    enabled: bool = True
    action_window_size: int = Field(default=12, gt=0)
    min_cycle_length: int = Field(default=1, gt=0)
    max_cycle_length: int = Field(default=4, gt=0)
    required_repetitions: int = Field(default=3, ge=2)
    no_progress_steps: int = Field(default=8, gt=0)
    coordinate_tolerance_px: int = Field(default=8, gt=0)

    @model_validator(mode="after")
    def validate_window(self) -> CycleDetectionConfig:
        if self.max_cycle_length < self.min_cycle_length:
            raise ValueError("max_cycle_length must be at least min_cycle_length")
        if self.action_window_size < self.max_cycle_length * self.required_repetitions:
            raise ValueError("action_window_size must hold max_cycle_length * required_repetitions")
        return self


class ExperimentSettings(BaseModel):
    """Reproducible prompt and eval-mode knobs for one invocation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    prompt_setting: PromptSetting = "full"
    eval_mode: EvalMode = "progressive"

    @property
    def config_hash(self) -> str:
        payload = json.dumps(
            self.model_dump(mode="json"),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def public_metadata(
        self,
        *,
        history_n_images: int | None = None,
    ) -> dict[str, Any]:
        return {
            "prompt_setting": self.prompt_setting,
            "eval_mode": self.eval_mode,
            "history_n_images": history_n_images,
            "experiment_config_hash": self.config_hash,
        }


class BenchmarkExecutionConfig(BaseModel):
    """Task progression policy for one benchmark invocation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    progression_mode: ProgressionMode = "independent"
    stop_on_failure: bool = False
    eval_mode: EvalMode | None = None

    @model_validator(mode="after")
    def validate_sequential_policy(self) -> BenchmarkExecutionConfig:
        if self.progression_mode == "sequential_unlock" and not self.stop_on_failure:
            raise ValueError("sequential_unlock requires stop_on_failure=true")
        return self

    def resolve_eval_mode(self) -> EvalMode:
        """Map legacy progression knobs onto the public eval_mode surface."""

        if self.eval_mode is not None:
            return self.eval_mode
        if self.progression_mode == "sequential_unlock" or self.stop_on_failure:
            return "progressive"
        return "all_levels"

    def should_stop_on_failure(self, eval_mode: EvalMode | None = None) -> bool:
        mode = eval_mode or self.resolve_eval_mode()
        return mode == "progressive"


class EnvironmentConfig(BaseModel):
    """Browser environment settings shared by all tasks in a catalogue."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["web_game"] = "web_game"
    base_url: str | None = None
    viewport_width: int = Field(default=1080, gt=0)
    viewport_height: int = Field(default=1920, gt=0)
    game_viewport_selector: str = "#GameCanvas"
    per_game_viewport_selectors: dict[str, str] = Field(default_factory=dict)
    device_scale_factor: float = Field(default=1.0, gt=0)
    headless: bool = True
    project_path: str | None = None
    build_directory: str = "build/web-mobile"
    auto_build: bool = False
    cocos_creator_binary: str | None = None
    server_command: list[str] | None = None
    server_ready_timeout_seconds: float = Field(default=60.0, gt=0)
    step_wait_time: float = Field(default=0.05, ge=0)
    action_effect_timeout_seconds: float = Field(default=0.75, ge=0)
    visual_stability_timeout_seconds: float = Field(default=0.35, ge=0)
    visual_poll_interval_seconds: float = Field(default=0.05, gt=0)
    visual_change_threshold: float = Field(default=0.0001, ge=0, le=1)
    no_progress_recovery_steps: int = Field(default=3, gt=0)
    no_progress_termination_steps: int = Field(default=6, gt=0)
    no_progress_max_cycle_length: int = Field(default=4, ge=2)
    no_progress_perceptual_hash_threshold: int = Field(default=0, ge=0)
    no_progress_mean_color_threshold: int = Field(default=3, ge=0, le=255)
    invalid_action_limit: int = Field(default=3, gt=0)
    cycle_detection: CycleDetectionConfig = Field(default_factory=CycleDetectionConfig)
    # Extra wall-clock budget so long model calls do not consume the play timer.
    wall_clock_timeout_slack_seconds: float = Field(default=7200.0, ge=0)
    # Extra attempts after a provider/agent transport failure on the same level.
    max_episode_retries: int = Field(default=5, ge=0)

    @model_validator(mode="after")
    def validate_no_progress_thresholds(self) -> EnvironmentConfig:
        if self.no_progress_termination_steps <= self.no_progress_recovery_steps:
            raise ValueError("no_progress_termination_steps must exceed no_progress_recovery_steps")
        return self

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.rstrip("/")
        if not value.startswith(("http://", "https://")):
            raise ValueError("base_url must use http:// or https://")
        return value

    @field_validator("game_viewport_selector")
    @classmethod
    def validate_selector(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("game_viewport_selector must not be empty")
        return value


class MetricConfig(BaseModel):
    """State field mapping and reproducible score normalization policy."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    normalization: NormalizationMode = "binary"
    score_field: str = "score"
    normalized_score_field: str | None = "normalized_score"
    success_field: str = "success"
    failure_field: str = "failure"
    status_field: str = "status"
    metrics_field: str = "metrics"
    invalid_actions_field: str = "invalid_actions"
    minimum: float = 0.0
    maximum: float = 1.0
    higher_is_better: bool = True
    existing_score_scale: float = Field(default=100.0, gt=0)
    success_statuses: tuple[str, ...] = ("success", "completed", "complete", "won")
    failure_statuses: tuple[str, ...] = ("failure", "failed", "lost", "game_over")

    @model_validator(mode="after")
    def validate_range(self) -> MetricConfig:
        if self.normalization == "linear" and self.maximum <= self.minimum:
            raise ValueError("maximum must be greater than minimum for linear normalization")
        return self


class GameScoringConfig(BaseModel):
    """Versioned, declarative weights for one game's level scorer.

    Component and penalty names are deliberately data rather than Python
    constants.  This makes the exact policy hashable and keeps result files
    comparable after weights change.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    version: str = "1.0"
    mode: ScoringMode = "composite"
    success_threshold: float = Field(default=60.0, ge=0.0, le=100.0)
    failure_score_cap: float = Field(default=59.0, ge=0.0, le=100.0)
    components: dict[str, float] = Field(default_factory=dict)
    penalties: dict[str, float] = Field(default_factory=dict)
    time_budget_seconds: float | None = Field(default=None, gt=0.0)

    @field_validator("version")
    @classmethod
    def validate_version(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("scoring version must not be empty")
        return value.strip()

    @field_validator("components", "penalties")
    @classmethod
    def validate_weights(cls, value: dict[str, float]) -> dict[str, float]:
        normalized: dict[str, float] = {}
        for name, weight in value.items():
            key = str(name).strip()
            number = float(weight)
            if not key:
                raise ValueError("scoring weight names must not be empty")
            if not math.isfinite(number) or number < 0:
                raise ValueError("scoring weights must be finite and non-negative")
            normalized[key] = number
        return normalized

    @model_validator(mode="after")
    def validate_score_bands(self) -> GameScoringConfig:
        if self.failure_score_cap >= self.success_threshold:
            raise ValueError("failure_score_cap must be below success_threshold")
        if self.mode == "composite":
            success_base = self.components.get("success_base", 0.0)
            if success_base < self.success_threshold:
                raise ValueError("success_base must be at least success_threshold")
        return self

    @property
    def config_hash(self) -> str:
        """Return a stable SHA-256 hash of the effective scoring policy."""

        payload = json.dumps(
            self.model_dump(mode="json", exclude_none=True),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    @classmethod
    def success_rate_only(cls, *, version: str = "1.0") -> GameScoringConfig:
        """Build the intentionally metric-free success-only policy."""

        return cls(
            version=version,
            mode="success_rate_only",
            success_threshold=100.0,
            failure_score_cap=0.0,
        )


class ScoreBreakdown(BaseModel):
    """Auditable 0-100 level score and its additive components."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    success_score: float = Field(default=0.0, ge=0.0, le=100.0)
    progress_score: float = Field(default=0.0, ge=0.0, le=100.0)
    efficiency_score: float = Field(default=0.0, ge=0.0, le=100.0)
    action_quality_score: float = Field(default=0.0, ge=0.0, le=100.0)
    time_score: float = Field(default=0.0, ge=0.0, le=100.0)
    penalty_score: float = Field(default=0.0, ge=0.0, le=100.0)
    overall_score: float = Field(default=0.0, ge=0.0, le=100.0)
    normalized_metrics: dict[str, float] = Field(default_factory=dict)

    @field_validator("normalized_metrics")
    @classmethod
    def validate_normalized_metrics(cls, value: dict[str, float]) -> dict[str, float]:
        normalized: dict[str, float] = {}
        for name, metric in value.items():
            number = float(metric)
            if not math.isfinite(number):
                raise ValueError("normalized score metrics must be finite")
            normalized[str(name)] = max(0.0, min(1.0, number))
        return normalized


class GameViewportConfig(BaseModel):
    """Per-game rendered-content selector and Cocos design resolution."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    selector: str | None = None
    design_width: int = Field(default=540, gt=0)
    design_height: int = Field(default=960, gt=0)


class MiniGameTaskSpec(BaseModel):
    """A fully expanded, reproducible LongPuzzleBench episode specification."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    task_id: str = ""
    game_id: str
    difficulty: str
    level_id: int | str
    seed: int = Field(default=0, ge=0)
    instruction: str
    max_steps: int = Field(default=100, gt=0)
    timeout_seconds: float = Field(default=300.0, gt=0)
    success_condition: str = "The game bridge reports success."
    metric_config: MetricConfig = Field(default_factory=MetricConfig)
    scoring_config: GameScoringConfig | None = None
    scoring_config_hash: str | None = None
    viewport: GameViewportConfig | None = None
    launch_parameters: dict[str, Any] = Field(default_factory=dict)
    tags: tuple[str, ...] = ()

    @model_validator(mode="before")
    @classmethod
    def populate_task_id(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        required = ("game_id", "difficulty", "level_id")
        if all(item in data for item in required):
            expected = stable_task_id(
                str(data["game_id"]),
                str(data["difficulty"]),
                data["level_id"],
                int(data.get("seed", 0)),
            )
            supplied = data.get("task_id")
            if supplied and supplied != expected:
                raise ValueError(f"task_id must be {expected!r}, got {supplied!r}")
            data["task_id"] = expected
        if data.get("scoring_config") is not None:
            scoring = GameScoringConfig.model_validate(data["scoring_config"])
            expected_hash = scoring.config_hash
            supplied_hash = data.get("scoring_config_hash")
            if supplied_hash and supplied_hash != expected_hash:
                raise ValueError("scoring_config_hash does not match the effective scoring_config")
            data["scoring_config_hash"] = expected_hash
        return data

    @field_validator("game_id", "difficulty")
    @classmethod
    def validate_identifier(cls, value: str) -> str:
        normalized = _identifier(value)
        if normalized != value:
            raise ValueError(f"identifier must already be normalized as {normalized!r}")
        return value

    @field_validator("instruction", "success_condition")
    @classmethod
    def validate_nonempty_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text fields must not be empty")
        return value.strip()


class EpisodeResult(BaseModel):
    """Evaluator output plus the artifact fields needed for reproducibility."""

    model_config = ConfigDict(extra="ignore")

    episode_id: str | None = None
    task: MiniGameTaskSpec
    agent_information: dict[str, Any] = Field(default_factory=dict)
    seed: int
    instruction: str
    task_success: bool
    game_score: float
    normalized_score: float = Field(ge=0.0, le=1.0)
    overall_score: float = Field(default=0.0, ge=0.0, le=100.0)
    breakdown: ScoreBreakdown = Field(default_factory=ScoreBreakdown)
    scoring_version: str = "legacy"
    scoring_config_hash: str = "legacy"
    benchmark_version: str = "unknown"
    game_version: str = "unknown"
    step_count: int = Field(ge=0)
    invalid_action_count: int = Field(default=0, ge=0)
    elapsed_time_seconds: float = Field(ge=0.0)
    timeout: bool = False
    max_step_reached: bool = False
    is_terminal: bool
    episode_status: EpisodeStatus
    termination_reason: TerminationReason | None = None
    deadlock: dict[str, Any] = Field(default_factory=dict)
    terminal_state: dict[str, Any] = Field(default_factory=dict)
    raw_metrics: dict[str, Any] = Field(default_factory=dict)
    normalized_metrics: dict[str, float] = Field(default_factory=dict)
    errors: list[str] = Field(default_factory=list)
    runtime: dict[str, Any] = Field(default_factory=dict)
    trajectory: list[dict[str, Any]] = Field(default_factory=list)
    observation_metadata: list[dict[str, Any]] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @model_validator(mode="before")
    @classmethod
    def populate_legacy_scoring_fields(cls, value: Any) -> Any:
        """Make pre-composite-score JSON artifacts readable without migration."""

        if not isinstance(value, dict):
            return value
        data = dict(value)
        if "breakdown" not in data and "score_breakdown" in data:
            data["breakdown"] = data.pop("score_breakdown")
        if "overall_score" not in data:
            try:
                data["overall_score"] = max(
                    0.0, min(100.0, float(data.get("normalized_score", 0.0)) * 100.0)
                )
            except (TypeError, ValueError):
                data["overall_score"] = 0.0
        if "breakdown" not in data:
            score = data["overall_score"]
            data["breakdown"] = {
                "success_score": score if bool(data.get("task_success")) else 0.0,
                "progress_score": 0.0 if bool(data.get("task_success")) else score,
                "overall_score": score,
            }
        data.setdefault("scoring_version", "legacy")
        data.setdefault("scoring_config_hash", "legacy")
        data.setdefault("benchmark_version", "unknown")
        data.setdefault("game_version", "unknown")
        return data

    @model_validator(mode="after")
    def validate_task_metadata(self) -> EpisodeResult:
        if self.seed != self.task.seed:
            raise ValueError("result seed must match task seed")
        if self.instruction != self.task.instruction:
            raise ValueError("result instruction must match task instruction")
        return self

    @property
    def steps(self) -> int:
        """Compatibility alias used by benchmark runners."""

        return self.step_count

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible representation."""

        return self.model_dump(mode="json")
