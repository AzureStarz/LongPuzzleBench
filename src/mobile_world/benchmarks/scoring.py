"""Explainable, versioned level scoring for LongPuzzleBench.

Only evaluator-side structured state is consumed here.  Nothing in this
module is part of the agent observation channel.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence
from typing import Any

from mobile_world.benchmarks.models import (
    EpisodeResult,
    GameScoringConfig,
    MiniGameTaskSpec,
    ScoreBreakdown,
)
from mobile_world.benchmarks.progress import (
    bolt_unscrew_progress,
    color_connect_progress,
    maze_paint_progress,
    nut_and_bolt_progress,
    rush_hour_2_progress,
    truck_escape_progress,
)


def _clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return max(minimum, min(maximum, value))


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _path(source: Mapping[str, Any], dotted_path: str) -> Any:
    value: Any = source
    for part in dotted_path.split("."):
        if not isinstance(value, Mapping) or part not in value:
            return None
        value = value[part]
    return value


def _first_number(sources: Sequence[Mapping[str, Any]], paths: Sequence[str]) -> float | None:
    for source in sources:
        for path in paths:
            number = _number(_path(source, path))
            if number is not None:
                return number
    return None


def _first_value(sources: Sequence[Mapping[str, Any]], paths: Sequence[str]) -> Any:
    for source in sources:
        for path in paths:
            value = _path(source, path)
            if value is not None:
                return value
    return None


def _ratio(numerator: float | None, denominator: float | None) -> float:
    if numerator is None or denominator is None or denominator <= 0:
        return 0.0
    return _clamp(numerator / denominator)


def _sources(result: EpisodeResult) -> tuple[Mapping[str, Any], ...]:
    return (result.raw_metrics, result.terminal_state, result.runtime)


def _effective_config(task: MiniGameTaskSpec) -> GameScoringConfig:
    # A missing policy must never create guessed partial-credit metrics.  The
    # explicit binary fallback keeps old catalogues runnable while making the
    # unconfigured policy visible through its version/hash in the result.
    return task.scoring_config or GameScoringConfig.success_rate_only(
        version="unconfigured-success-only"
    )


def _component(config: GameScoringConfig, name: str) -> float:
    return config.components.get(name, 0.0)


def _confirmed_game_deadlock(result: EpisodeResult) -> bool:
    sources = _sources(result)
    status = _first_value(
        sources,
        (
            "final_progress.deadlockStatus",
            "metrics.deadlockStatus",
            "deadlockStatus",
            "raw_metrics.final_progress.deadlockStatus",
        ),
    )
    if isinstance(status, str) and status.lower() == "confirmed":
        return True
    deadlocked = _first_value(
        sources,
        ("deadlock.is_deadlocked", "raw_metrics.deadlock.is_deadlocked"),
    )
    return deadlocked is True


def _failure_reason(result: EpisodeResult) -> str | None:
    # Keep Bolt's explicit no-available-hole reason ahead of the generic
    # confirmed-deadlock collapse so each game's penalty table stays accurate.
    if result.termination_reason == "no_available_hole_deadlock":
        return "no_available_hole_deadlock"
    if _confirmed_game_deadlock(result):
        return "game_deadlock"
    return result.termination_reason


def _penalty(result: EpisodeResult, config: GameScoringConfig) -> float:
    reason = _failure_reason(result)
    return config.penalties.get(reason, 0.0) if reason else 0.0


def _shared_action_quality(
    result: EpisodeResult,
    sources: Sequence[Mapping[str, Any]],
) -> tuple[float, float, float, float, dict[str, float]]:
    total_actions = _first_number(
        sources,
        (
            "agent_decisions",
            "total_actions",
            "totalOperationAttempts",
            "raw_metrics.total_actions",
        ),
    )
    if total_actions is None:
        total_actions = float(result.step_count)
    invalid_actions = max(
        float(result.invalid_action_count),
        _first_number(
            sources,
            ("invalid_action_count", "invalid_actions", "raw_metrics.invalid_actions"),
        )
        or 0.0,
    )
    repeated_actions = (
        _first_number(
            sources,
            (
                "model_usage.repeated_actions",
                "repeated_actions",
                "repeated_action_count",
            ),
        )
        or 0.0
    )
    noop_actions = (
        _first_number(
            sources,
            ("model_usage.noop_actions", "noop_actions", "no_op_actions"),
        )
        or 0.0
    )
    action_quality = (
        _clamp(1.0 - (invalid_actions + repeated_actions + noop_actions) / total_actions)
        if total_actions > 0
        else 0.0
    )
    valid_action_rate = _clamp(1.0 - invalid_actions / total_actions) if total_actions > 0 else 0.0
    invalid_action_rate = _ratio(invalid_actions, total_actions)
    repeated_action_rate = _ratio(repeated_actions + noop_actions, total_actions)
    return (
        action_quality,
        valid_action_rate,
        invalid_action_rate,
        repeated_action_rate,
        {
            "action_quality": action_quality,
            "valid_action_rate": valid_action_rate,
            "invalid_action_rate": invalid_action_rate,
            "repeated_action_rate": repeated_action_rate,
        },
    )


def _finish(
    *,
    config: GameScoringConfig,
    success: bool,
    success_score: float = 0.0,
    progress_score: float = 0.0,
    efficiency_score: float = 0.0,
    action_quality_score: float = 0.0,
    time_score: float = 0.0,
    penalty_score: float = 0.0,
    normalized_metrics: Mapping[str, float] | None = None,
) -> ScoreBreakdown:
    subtotal = (
        success_score
        + progress_score
        + efficiency_score
        + action_quality_score
        + time_score
        - penalty_score
    )
    upper_bound = 100.0 if success else config.failure_score_cap
    overall = _clamp(subtotal, 0.0, upper_bound)
    return ScoreBreakdown(
        success_score=round(_clamp(success_score, 0.0, 100.0), 6),
        progress_score=round(_clamp(progress_score, 0.0, 100.0), 6),
        efficiency_score=round(_clamp(efficiency_score, 0.0, 100.0), 6),
        action_quality_score=round(_clamp(action_quality_score, 0.0, 100.0), 6),
        time_score=round(_clamp(time_score, 0.0, 100.0), 6),
        penalty_score=round(_clamp(penalty_score, 0.0, 100.0), 6),
        overall_score=round(overall, 6),
        normalized_metrics=dict(normalized_metrics or {}),
    )


class GameScorer(ABC):
    """Common level-scoring interface implemented by each supported game."""

    @abstractmethod
    def score_level(self, result: EpisodeResult) -> ScoreBreakdown:
        """Score one completed or terminated evaluator result."""

    def process_metrics(self, result: EpisodeResult) -> dict[str, float]:
        """Return authoritative process diagnostics for result artifacts."""

        return {}

    def score_episode(
        self,
        result: EpisodeResult,
        *,
        benchmark_version: str | None = None,
        game_version: str | None = None,
    ) -> EpisodeResult:
        """Attach the score, policy identity, and normalized components."""

        breakdown = self.score_level(result)
        config = _effective_config(result.task)
        normalized_metrics = dict(result.normalized_metrics)
        normalized_metrics.update(breakdown.normalized_metrics)
        normalized_metrics["overall_score"] = breakdown.overall_score / 100.0
        raw_metrics = dict(result.raw_metrics)
        process = self.process_metrics(result)
        if process:
            raw_metrics["process_metrics"] = process
            # Mirror the 0-1 progress potential used by the composite scorer.
            if "progress" in process:
                raw_metrics["progress"] = process["progress"]
        return result.model_copy(
            update={
                "overall_score": breakdown.overall_score,
                "breakdown": breakdown,
                "normalized_score": breakdown.overall_score / 100.0,
                "normalized_metrics": normalized_metrics,
                "raw_metrics": raw_metrics,
                "scoring_version": config.version,
                "scoring_config_hash": result.task.scoring_config_hash or config.config_hash,
                "benchmark_version": benchmark_version
                or str(result.runtime.get("benchmark_version", "unknown")),
                "game_version": game_version or str(result.runtime.get("game_version", "unknown")),
            },
            deep=True,
        )


class BoltUnscrewScorer(GameScorer):
    """Score Bolt Unscrew from cleared/released-board progress and telemetry."""

    def process_metrics(self, result: EpisodeResult) -> dict[str, float]:
        _, diagnostics = bolt_unscrew_progress(result)
        return diagnostics

    def score_level(self, result: EpisodeResult) -> ScoreBreakdown:
        config = _effective_config(result.task)
        if config.mode == "success_rate_only":
            return _binary_breakdown(result.task_success, config)

        sources = _sources(result)
        progress, _process_metrics = bolt_unscrew_progress(result)

        step_budget = float(result.task.max_steps)
        step_efficiency = _clamp(1.0 - result.step_count / max(1.0, step_budget))
        (
            action_quality,
            _valid_action_rate,
            _invalid_action_rate,
            _repeated_action_rate,
            quality_metrics,
        ) = _shared_action_quality(result, sources)

        time_budget = config.time_budget_seconds or result.task.timeout_seconds
        time_efficiency = _clamp(1.0 - result.elapsed_time_seconds / max(1.0, time_budget))
        normalized = {
            "progress": progress,
            "step_efficiency": step_efficiency,
            **quality_metrics,
            "time_efficiency": time_efficiency,
        }
        if result.task_success:
            return _finish(
                config=config,
                success=True,
                success_score=_component(config, "success_base"),
                efficiency_score=_component(config, "step_efficiency") * step_efficiency,
                action_quality_score=_component(config, "action_quality") * action_quality,
                time_score=_component(config, "time_efficiency") * time_efficiency,
                normalized_metrics=normalized,
            )
        return _finish(
            config=config,
            success=False,
            progress_score=_component(config, "failure_progress") * progress,
            action_quality_score=_component(config, "failure_action_quality")
            * progress
            * action_quality,
            efficiency_score=_component(config, "failure_efficiency") * progress * step_efficiency,
            penalty_score=_penalty(result, config),
            normalized_metrics=normalized,
        )


class RushHour2Scorer(GameScorer):
    """Score Truck Escape 2 / Rush Hour 2 from its ability-tracker metrics."""

    def process_metrics(self, result: EpisodeResult) -> dict[str, float]:
        _, diagnostics = rush_hour_2_progress(result)
        return diagnostics

    def score_level(self, result: EpisodeResult) -> ScoreBreakdown:
        config = _effective_config(result.task)
        if config.mode == "success_rate_only":
            return _binary_breakdown(result.task_success, config)

        sources = _sources(result)
        progress, _process_metrics = rush_hour_2_progress(result)

        reference_moves = _first_number(
            sources,
            ("referenceMoves", "metrics.referenceMoves", "raw_metrics.metrics.referenceMoves"),
        )
        accepted_moves = _first_number(
            sources,
            ("acceptedMoves", "metrics.acceptedMoves", "raw_metrics.metrics.acceptedMoves"),
        )
        if reference_moves is not None and reference_moves > 0 and accepted_moves is not None:
            step_efficiency = (
                _clamp(reference_moves / max(reference_moves, accepted_moves))
                if accepted_moves > 0
                else 0.0
            )
        else:
            reported_efficiency = _first_number(
                sources,
                ("stepEfficiency", "metrics.stepEfficiency", "raw_metrics.metrics.stepEfficiency"),
            )
            step_efficiency = _clamp((reported_efficiency or 0.0) / 100.0)

        total_attempts = (
            _first_number(
                sources,
                (
                    "totalOperationAttempts",
                    "metrics.totalOperationAttempts",
                    "raw_metrics.metrics.totalOperationAttempts",
                ),
            )
            or 0.0
        )
        accepted = max(0.0, accepted_moves or 0.0)
        invalid = (
            _first_number(
                sources,
                (
                    "invalidOperations",
                    "metrics.invalidOperations",
                    "raw_metrics.metrics.invalidOperations",
                ),
            )
            or 0.0
        )
        if total_attempts <= 0 and accepted + invalid > 0:
            total_attempts = accepted + invalid
        loop_counts = [
            _first_number(sources, (name, f"metrics.{name}", f"raw_metrics.metrics.{name}")) or 0.0
            for name in (
                "repeatedOperations",
                "repeatedStates",
                "immediateReversals",
                "oscillations",
            )
        ]
        loop_burden = max(loop_counts, default=0.0)
        restart_count = (
            _first_number(
                sources,
                (
                    "terminal_state.raw_game_state.ability.aggregate.totalRestarts",
                    "raw_game_state.ability.aggregate.totalRestarts",
                    "restartCount",
                    "metrics.restartCount",
                    "raw_metrics.metrics.restartCount",
                ),
            )
            or 0.0
        )
        action_quality = (
            _clamp((accepted - min(accepted, loop_burden) - restart_count) / total_attempts)
            if total_attempts > 0
            else 0.0
        )
        valid_action_rate = _ratio(accepted, total_attempts)
        invalid_action_rate = _ratio(invalid, total_attempts)
        repeated_action_rate = _ratio(loop_burden, total_attempts)

        duration_ms = _first_number(
            sources,
            ("totalDurationMs", "metrics.totalDurationMs", "raw_metrics.metrics.totalDurationMs"),
        )
        elapsed_seconds = (
            max(0.0, duration_ms / 1000.0)
            if duration_ms is not None
            else result.elapsed_time_seconds
        )
        time_budget = config.time_budget_seconds or result.task.timeout_seconds
        time_efficiency = _clamp(1.0 - elapsed_seconds / max(1.0, time_budget))
        normalized = {
            "progress": progress,
            "step_efficiency": step_efficiency,
            "action_quality": action_quality,
            "valid_action_rate": valid_action_rate,
            "invalid_action_rate": invalid_action_rate,
            "repeated_action_rate": repeated_action_rate,
            "time_efficiency": time_efficiency,
        }
        if result.task_success:
            return _finish(
                config=config,
                success=True,
                success_score=_component(config, "success_base"),
                efficiency_score=_component(config, "step_efficiency") * step_efficiency,
                action_quality_score=_component(config, "action_quality") * action_quality,
                time_score=_component(config, "time_efficiency") * time_efficiency,
                normalized_metrics=normalized,
            )
        return _finish(
            config=config,
            success=False,
            progress_score=_component(config, "failure_progress") * progress,
            action_quality_score=_component(config, "failure_action_quality")
            * progress
            * action_quality,
            efficiency_score=_component(config, "failure_efficiency") * progress * step_efficiency,
            penalty_score=_penalty(result, config),
            normalized_metrics=normalized,
        )


class NutAndBoltScorer(GameScorer):
    """Score Nut and Bolt from homogeneous nut-placement progress."""

    def process_metrics(self, result: EpisodeResult) -> dict[str, float]:
        _, diagnostics = nut_and_bolt_progress(result)
        return diagnostics

    def score_level(self, result: EpisodeResult) -> ScoreBreakdown:
        config = _effective_config(result.task)
        if config.mode == "success_rate_only":
            return _binary_breakdown(result.task_success, config)

        sources = _sources(result)
        progress, _process_metrics = nut_and_bolt_progress(result)
        step_budget = float(result.task.max_steps)
        step_efficiency = _clamp(1.0 - result.step_count / max(1.0, step_budget))
        (
            action_quality,
            _valid_action_rate,
            _invalid_action_rate,
            _repeated_action_rate,
            quality_metrics,
        ) = _shared_action_quality(result, sources)
        time_budget = config.time_budget_seconds or result.task.timeout_seconds
        time_efficiency = _clamp(1.0 - result.elapsed_time_seconds / max(1.0, time_budget))
        normalized = {
            "progress": progress,
            "step_efficiency": step_efficiency,
            **quality_metrics,
            "time_efficiency": time_efficiency,
        }
        if result.task_success:
            return _finish(
                config=config,
                success=True,
                success_score=_component(config, "success_base"),
                efficiency_score=_component(config, "step_efficiency") * step_efficiency,
                action_quality_score=_component(config, "action_quality") * action_quality,
                time_score=_component(config, "time_efficiency") * time_efficiency,
                normalized_metrics=normalized,
            )
        return _finish(
            config=config,
            success=False,
            progress_score=_component(config, "failure_progress") * progress,
            action_quality_score=_component(config, "failure_action_quality")
            * progress
            * action_quality,
            efficiency_score=_component(config, "failure_efficiency") * progress * step_efficiency,
            penalty_score=_penalty(result, config),
            normalized_metrics=normalized,
        )


class _StandardProgressScorer(GameScorer):
    """Shared composite policy for games with one authoritative progress potential."""

    progress_function = staticmethod(truck_escape_progress)

    def process_metrics(self, result: EpisodeResult) -> dict[str, float]:
        _, diagnostics = self.progress_function(result)
        return diagnostics

    def _step_efficiency(
        self,
        result: EpisodeResult,
        sources: Sequence[Mapping[str, Any]],
    ) -> float:
        del sources
        return _clamp(1.0 - result.step_count / max(1.0, float(result.task.max_steps)))

    def score_level(self, result: EpisodeResult) -> ScoreBreakdown:
        config = _effective_config(result.task)
        if config.mode == "success_rate_only":
            return _binary_breakdown(result.task_success, config)

        sources = _sources(result)
        progress, _ = self.progress_function(result)
        step_efficiency = self._step_efficiency(result, sources)
        (
            action_quality,
            _valid_action_rate,
            _invalid_action_rate,
            _repeated_action_rate,
            quality_metrics,
        ) = _shared_action_quality(result, sources)
        time_budget = config.time_budget_seconds or result.task.timeout_seconds
        time_efficiency = _clamp(1.0 - result.elapsed_time_seconds / max(1.0, time_budget))
        normalized = {
            "progress": progress,
            "step_efficiency": step_efficiency,
            **quality_metrics,
            "time_efficiency": time_efficiency,
        }
        if result.task_success:
            return _finish(
                config=config,
                success=True,
                success_score=_component(config, "success_base"),
                efficiency_score=_component(config, "step_efficiency") * step_efficiency,
                action_quality_score=_component(config, "action_quality") * action_quality,
                time_score=_component(config, "time_efficiency") * time_efficiency,
                normalized_metrics=normalized,
            )
        return _finish(
            config=config,
            success=False,
            progress_score=_component(config, "failure_progress") * progress,
            action_quality_score=_component(config, "failure_action_quality")
            * progress
            * action_quality,
            efficiency_score=_component(config, "failure_efficiency") * progress * step_efficiency,
            penalty_score=_penalty(result, config),
            normalized_metrics=normalized,
        )


class TruckEscapeScorer(_StandardProgressScorer):
    """Score the original truck-removal game from irreversible removals."""

    progress_function = staticmethod(truck_escape_progress)


class MazePaintScorer(_StandardProgressScorer):
    """Score Maze Paint from irreversible coverage and exact solved efficiency."""

    progress_function = staticmethod(maze_paint_progress)

    def _step_efficiency(
        self,
        result: EpisodeResult,
        sources: Sequence[Mapping[str, Any]],
    ) -> float:
        optimal = _first_number(
            sources,
            (
                "optimal_move_count",
                "efficiency.optimal_move_count",
                "raw_metrics.optimal_move_count",
            ),
        )
        moves = _first_number(
            sources,
            (
                "move_count",
                "actions.move_count",
                "raw_metrics.move_count",
            ),
        )
        if optimal is not None and optimal > 0 and moves is not None and moves > 0:
            return _clamp(optimal / max(optimal, moves))
        return super()._step_efficiency(result, sources)


class ColorConnectScorer(_StandardProgressScorer):
    """Score Color Connect from legal completed color pairs."""

    progress_function = staticmethod(color_connect_progress)


def _binary_breakdown(success: bool, config: GameScoringConfig) -> ScoreBreakdown:
    score = 100.0 if success else 0.0
    return ScoreBreakdown(
        success_score=score,
        overall_score=score,
        normalized_metrics={"success": float(success)},
    )


def scorer_for_task(task: MiniGameTaskSpec) -> GameScorer:
    """Resolve scorer aliases without leaking game-specific branches into runners."""

    if task.game_id == "bolt_unscrew":
        return BoltUnscrewScorer()
    if task.game_id in {"rush_hour_2", "truck_escape_2"}:
        return RushHour2Scorer()
    if task.game_id in {"nut_and_bolt", "nuts_bolts"}:
        return NutAndBoltScorer()
    if task.game_id == "truck_escape":
        return TruckEscapeScorer()
    if task.game_id == "maze_paint":
        return MazePaintScorer()
    if task.game_id == "color_connect":
        return ColorConnectScorer()
    if task.scoring_config is None or task.scoring_config.mode == "success_rate_only":
        # Compatibility for historical/custom binary benchmark tasks.  An
        # unknown game can never receive guessed partial-credit semantics.
        return NutAndBoltScorer()
    raise ValueError(f"no composite scorer registered for game {task.game_id!r}")


def score_episode(
    result: EpisodeResult,
    *,
    benchmark_version: str | None = None,
    game_version: str | None = None,
) -> EpisodeResult:
    """Score an episode with its task-selected game policy."""

    return scorer_for_task(result.task).score_episode(
        result,
        benchmark_version=benchmark_version,
        game_version=game_version,
    )
