"""Evaluator for state exposed through the evaluator-only game bridge."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from mobile_world.benchmarks.models import (
    EpisodeResult,
    EpisodeStatus,
    MetricConfig,
    MiniGameTaskSpec,
    TerminationReason,
)
from mobile_world.benchmarks.scoring import score_episode


def _mapping(state: Mapping[str, Any] | Any | None) -> dict[str, Any]:
    if state is None:
        return {}
    if isinstance(state, Mapping):
        return dict(state)
    if hasattr(state, "model_dump"):
        dumped = state.model_dump()
        if isinstance(dumped, Mapping):
            return dict(dumped)
    raise TypeError("game state must be a mapping or Pydantic model")


def _field(data: Mapping[str, Any], path: str | None, default: Any = None) -> Any:
    if not path:
        return default
    current: Any = data
    for part in path.split("."):
        if not isinstance(current, Mapping) or part not in current:
            return default
        current = current[part]
    return current


def _number(value: Any, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def deadlock_diagnostic(
    state: Mapping[str, Any] | Any | None,
    *,
    detected_at_step: int | None = None,
) -> dict[str, Any]:
    """Normalize and independently validate evaluator-only deadlock state."""

    data = _mapping(state)
    # Truck Escape 2 exposes a solver-backed board classification through its
    # attempt progress snapshot.  It is distinct from Bolt's no-hole rule but
    # equally suitable as evaluator-only terminal evidence.
    raw_metrics = data.get("raw_metrics")
    final_progress = raw_metrics.get("final_progress") if isinstance(raw_metrics, Mapping) else None
    if isinstance(final_progress, Mapping):
        deadlock_status = str(
            final_progress.get("deadlockStatus") or final_progress.get("deadlock_status") or ""
        ).lower()
        complete = bool(final_progress.get("complete"))
        if deadlock_status == "confirmed" and not complete:
            return {
                "is_deadlocked": True,
                "deadlock_type": "unsolvable_board",
                "termination_reason": "game_deadlock",
                "state_key": final_progress.get("stateKey") or final_progress.get("state_key"),
                "legal_move_count": max(
                    0,
                    int(
                        _number(
                            final_progress.get("legalMoveCount")
                            or final_progress.get("legal_move_count")
                        )
                    ),
                ),
                "distance_confidence": final_progress.get("distanceConfidence")
                or final_progress.get("distance_confidence"),
                "game_state_stable": True,
                **(
                    {"detected_at_step": max(0, detected_at_step)}
                    if detected_at_step is not None
                    else {}
                ),
            }
    candidate = data.get("deadlock")
    if not isinstance(candidate, Mapping):
        raw_game_state = data.get("raw_game_state")
        candidate = raw_game_state.get("deadlock") if isinstance(raw_game_state, Mapping) else None
    if not isinstance(candidate, Mapping):
        return {}

    def value(snake: str, camel: str, default: Any = None) -> Any:
        if snake in candidate:
            return candidate[snake]
        return candidate.get(camel, default)

    def has(snake: str, camel: str) -> bool:
        return snake in candidate or camel in candidate

    holes_reported = has("available_hole_count", "availableHoleCount")
    available_holes = max(0, int(_number(value("available_hole_count", "availableHoleCount", 0))))
    legal_actions = max(
        0, int(_number(value("legal_progress_action_count", "legalProgressActionCount", 0)))
    )
    pending_operations = max(
        0, int(_number(value("pending_operation_count", "pendingOperationCount", 0)))
    )
    game_state_stable = bool(value("game_state_stable", "gameStateStable", False))
    awaiting_settlement = bool(
        value(
            "awaiting_operation_settlement",
            "awaitingOperationSettlement",
            False,
        )
    )
    reason = value("deadlock_reason", "reason")
    status = str(data.get("status", "")).lower()
    level_success = bool(data.get("success")) or status == "success"
    level_failure = bool(data.get("failure")) or status in {"failure", "failed"}
    reason_ok = reason in (None, "no_available_hole")
    # A selected screw cannot create a hole. Only unsettled physics that may
    # uncover an empty anchor may delay the no-hole deadlock.
    is_deadlocked = bool(
        reason_ok
        and holes_reported
        and not level_success
        and not level_failure
        and available_holes == 0
        and legal_actions == 0
        and not awaiting_settlement
    )
    diagnostic = {
        "is_deadlocked": is_deadlocked,
        "deadlock_type": "no_available_hole" if is_deadlocked else None,
        "available_hole_count": available_holes,
        "legal_progress_action_count": legal_actions,
        "pending_operation_count": pending_operations,
        "game_state_stable": game_state_stable,
        "awaiting_operation_settlement": awaiting_settlement,
        "level_success": level_success,
        "level_failure": level_failure,
        "termination_reason": "no_available_hole_deadlock" if is_deadlocked else None,
    }
    if detected_at_step is not None:
        diagnostic["detected_at_step"] = max(0, detected_at_step)
    return diagnostic


def normalize_score(
    raw_score: float,
    *,
    success: bool,
    config: MetricConfig,
    state: Mapping[str, Any] | None = None,
) -> float:
    """Normalize a raw task score to ``[0, 1]`` according to task configuration."""

    if config.normalization == "binary":
        return float(success)
    if config.normalization == "existing_score":
        existing = _field(state or {}, config.normalized_score_field, None)
        value = (
            _number(existing) if existing is not None else raw_score / config.existing_score_scale
        )
    else:
        value = (raw_score - config.minimum) / (config.maximum - config.minimum)
        if not config.higher_is_better:
            value = 1.0 - value
    return min(1.0, max(0.0, value))


class MiniGameEvaluator:
    """Convert evaluator-only bridge state into a standard episode result."""

    def evaluate(
        self,
        state: Mapping[str, Any] | Any | None,
        task: MiniGameTaskSpec,
        steps: int | None = None,
        elapsed: float | None = None,
        termination_flags: Mapping[str, Any] | None = None,
        *,
        timeout: bool = False,
        max_step_reached: bool = False,
        agent_terminated: bool = False,
        no_progress: bool = False,
        repeated_action_cycle: bool = False,
        invalid_action_limit_reached: bool = False,
        timeout_before_dispatch: bool = False,
        environment_error: str | None = None,
        agent_error: str | None = None,
        termination_reason: TerminationReason | None = None,
        deadlock: Mapping[str, Any] | None = None,
        invalid_action_count: int | None = None,
        agent_information: Mapping[str, Any] | None = None,
        trajectory: list[dict[str, Any]] | None = None,
        observation_metadata: list[dict[str, Any]] | None = None,
        runtime: Mapping[str, Any] | None = None,
        errors: list[str] | None = None,
    ) -> EpisodeResult:
        """Evaluate a bridge snapshot without returning it to the GUI agent."""

        data = _mapping(state)
        if steps is None:
            steps = int(_number(data.get("step_count", 0)))
        if elapsed is None:
            if "elapsed_time_seconds" in data:
                elapsed = _number(data["elapsed_time_seconds"])
            else:
                elapsed = _number(data.get("elapsed_time_ms", 0)) / 1000
        if steps < 0 or elapsed < 0:
            raise ValueError("steps and elapsed must be non-negative")
        flags = dict(termination_flags or {})
        timeout = bool(timeout or flags.get("timeout") or flags.get("timed_out"))
        max_step_reached = bool(
            max_step_reached
            or flags.get("max_step_reached")
            or flags.get("max_steps_reached")
            or flags.get("max_steps")
        )
        agent_terminated = bool(
            agent_terminated or flags.get("agent_terminated") or flags.get("agent_finished")
        )
        no_progress = bool(no_progress or flags.get("no_progress"))
        repeated_action_cycle = bool(repeated_action_cycle or flags.get("repeated_action_cycle"))
        invalid_action_limit_reached = bool(
            invalid_action_limit_reached or flags.get("invalid_action_limit_reached")
        )
        timeout_before_dispatch = bool(
            timeout_before_dispatch
            or flags.get("timeout_before_dispatch")
            or flags.get("game_ended_during_prediction")
        )
        environment_error = (
            environment_error
            or flags.get("environment_error")
            or flags.get("env_error")
            or flags.get("error")
        )
        agent_error = agent_error or flags.get("agent_error")
        expected_identity = {
            # Public benchmark ids are intentionally decoupled from legacy
            # Cocos provider ids through the evaluator-only launch query.
            "game_id": str(task.launch_parameters.get("game_id", task.game_id)),
            "difficulty": task.difficulty,
            "level_id": str(task.level_id),
            "seed": str(task.seed),
        }
        mismatches = [
            f"{name}={data[name]!r} (expected {expected!r})"
            for name, expected in expected_identity.items()
            if name in data and str(data[name]) != expected
        ]
        if mismatches and not environment_error:
            environment_error = "game state identity mismatch: " + ", ".join(mismatches)
        timeout = timeout or elapsed >= task.timeout_seconds
        max_step_reached = max_step_reached or steps >= task.max_steps

        config = task.metric_config
        status = str(_field(data, config.status_field, "")).lower()
        success = bool(_field(data, config.success_field, False)) or status in {
            item.lower() for item in config.success_statuses
        }
        failure = bool(_field(data, config.failure_field, False)) or status in {
            item.lower() for item in config.failure_statuses
        }
        normalized_deadlock = deadlock_diagnostic(data, detected_at_step=steps)
        if deadlock:
            normalized_deadlock.update(dict(deadlock))
        deadlock_triggered = bool(
            normalized_deadlock.get("is_deadlocked") and not success and not failure
        ) or (
            termination_reason in {"no_available_hole_deadlock", "game_deadlock"}
            and not success
            and not failure
        )

        bridge_metrics = data.get("raw_metrics", {})
        raw_metrics = dict(bridge_metrics) if isinstance(bridge_metrics, Mapping) else {}
        configured_metrics = _field(data, config.metrics_field, {})
        if isinstance(configured_metrics, Mapping):
            raw_metrics.update(configured_metrics)
        score_value = _field(data, config.score_field, None)
        if score_value is None:
            score_value = _field(raw_metrics, config.score_field, None)
        raw_score = _number(score_value, float(success))
        invalid_actions = _field(data, config.invalid_actions_field, None)
        if invalid_actions is None:
            invalid_actions = data.get("invalid_action_count")
        if invalid_actions is None:
            invalid_actions = raw_metrics.get(config.invalid_actions_field, 0)
        bridge_invalid_action_count = max(0, int(_number(invalid_actions)))
        invalid_action_count = bridge_invalid_action_count + max(0, int(invalid_action_count or 0))
        blocking_reason = termination_reason not in (None, "success")
        task_success = bool(
            success
            and not failure
            and not timeout
            and not environment_error
            and not agent_error
            and not repeated_action_cycle
            and not no_progress
            and not invalid_action_limit_reached
            and not deadlock_triggered
            and not blocking_reason
        )
        normalized_score = normalize_score(
            raw_score,
            success=task_success,
            config=config,
            state=data,
        )

        result_errors = list(errors or [])
        episode_status: EpisodeStatus
        # Infrastructure and budget stops outrank an in-game fail bit. Color
        # Connect can flip ``failure`` while the model is still thinking; that
        # must not be recorded as a played-and-lost outcome.
        if task_success:
            episode_status = "success"
            termination_reason = "success"
        elif environment_error:
            if str(environment_error) not in result_errors:
                result_errors.append(str(environment_error))
            episode_status = "error"
            termination_reason = "environment_error"
        elif agent_error:
            if str(agent_error) not in result_errors:
                result_errors.append(str(agent_error))
            episode_status = "error"
            termination_reason = "agent_error"
        elif timeout or timeout_before_dispatch:
            episode_status = "timeout"
            termination_reason = "timeout"
        elif failure:
            episode_status = "failure"
            termination_reason = "game_failure"
        elif deadlock_triggered:
            termination_reason = cast(
                TerminationReason,
                str(
                    normalized_deadlock.get("termination_reason")
                    or termination_reason
                    or "game_deadlock"
                ),
            )
            episode_status = (
                "no_available_hole_deadlock"
                if termination_reason == "no_available_hole_deadlock"
                else "deadlock"
            )
        elif max_step_reached and not task_success:
            episode_status = "max_steps"
            termination_reason = "max_steps"
        elif repeated_action_cycle or termination_reason == "repeated_action_cycle":
            episode_status = "repeated_action_cycle"
            termination_reason = "repeated_action_cycle"
        elif invalid_action_limit_reached or termination_reason == "invalid_action_limit":
            episode_status = "invalid_action_limit"
            termination_reason = "invalid_action_limit"
        elif no_progress or termination_reason == "no_progress":
            episode_status = "no_progress"
            termination_reason = "no_progress"
        elif agent_terminated:
            episode_status = "agent_terminated"
            termination_reason = termination_reason or "agent_terminated"
        else:
            episode_status = "running"
            termination_reason = None

        timeout = bool(timeout or timeout_before_dispatch)
        is_terminal = episode_status != "running"
        terminal_state = data if is_terminal else {}
        raw_metrics.update(
            {
                "task_success": task_success,
                "game_score": raw_score,
                "step_count": steps,
                "invalid_action_count": invalid_action_count,
                "elapsed_time_seconds": elapsed,
                "timeout": timeout or timeout_before_dispatch,
                "timeout_before_dispatch": timeout_before_dispatch,
                "max_step_reached": max_step_reached,
                "no_progress": no_progress,
                "episode_status": episode_status,
                "termination_reason": termination_reason,
                "deadlock": normalized_deadlock,
            }
        )
        normalized_metrics = {
            "score": normalized_score,
            "task_success": float(task_success),
        }
        result = EpisodeResult(
            task=task,
            agent_information=dict(agent_information or {}),
            seed=task.seed,
            instruction=task.instruction,
            task_success=task_success,
            game_score=raw_score,
            normalized_score=normalized_score,
            step_count=steps,
            invalid_action_count=invalid_action_count,
            elapsed_time_seconds=elapsed,
            timeout=timeout,
            max_step_reached=max_step_reached,
            is_terminal=is_terminal,
            episode_status=episode_status,
            termination_reason=termination_reason,
            deadlock=normalized_deadlock,
            terminal_state=terminal_state,
            raw_metrics=raw_metrics,
            normalized_metrics=normalized_metrics,
            errors=result_errors,
            runtime=dict(runtime or {}),
            trajectory=trajectory or [],
            observation_metadata=observation_metadata or [],
        )
        if task.scoring_config is None:
            # Historical/custom catalogues retain their declared MetricConfig
            # normalization.  Composite scoring is opt-in and versioned.
            return result
        identity = dict(agent_information or {})
        return score_episode(
            result,
            benchmark_version=str(identity.get("benchmark_version") or "unknown"),
            game_version=str(
                identity.get("game_version") or identity.get("environment_version") or "unknown"
            ),
        )
