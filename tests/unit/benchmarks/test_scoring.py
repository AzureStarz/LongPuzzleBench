from __future__ import annotations

import json
from typing import Any

import pytest

from mobile_world.benchmarks import (
    BoltUnscrewScorer,
    ColorConnectScorer,
    EpisodeResult,
    GameScoringConfig,
    MazePaintScorer,
    MiniGameTaskSpec,
    NutAndBoltScorer,
    RushHour2Scorer,
    TruckEscapeScorer,
    score_episode,
)


def _bolt_config() -> GameScoringConfig:
    return GameScoringConfig(
        version="1.0-test-bolt",
        components={
            "success_base": 60,
            "step_efficiency": 20,
            "action_quality": 10,
            "time_efficiency": 10,
            "failure_progress": 45,
            "failure_action_quality": 8,
            "failure_efficiency": 3,
        },
        penalties={
            "no_available_hole_deadlock": 6,
            "repeated_action_cycle": 5,
            "max_steps": 2,
            "timeout": 3,
        },
        time_budget_seconds=100,
    )


def _rush_config() -> GameScoringConfig:
    return GameScoringConfig(
        version="1.0-test-rush",
        components={
            "success_base": 60,
            "step_efficiency": 25,
            "action_quality": 10,
            "time_efficiency": 5,
            "failure_progress": 45,
            "failure_action_quality": 8,
            "failure_efficiency": 3,
        },
        penalties={
            "game_deadlock": 7,
            "repeated_action_cycle": 5,
            "max_steps": 2,
            "timeout": 3,
        },
        time_budget_seconds=100,
    )


def _standard_config() -> GameScoringConfig:
    return GameScoringConfig(
        version="1.3-test-standard",
        components={
            "success_base": 60,
            "step_efficiency": 20,
            "action_quality": 10,
            "time_efficiency": 10,
            "failure_progress": 45,
            "failure_action_quality": 8,
            "failure_efficiency": 3,
        },
        penalties={"max_steps": 4, "timeout": 4, "repeated_action_cycle": 6},
        time_budget_seconds=100,
    )


def _result(
    *,
    game: str,
    success: bool,
    scoring_config: GameScoringConfig,
    raw_metrics: dict[str, Any] | None = None,
    step_count: int = 10,
    invalid_actions: int = 0,
    elapsed: float = 10,
    termination_reason: str | None = None,
    runtime: dict[str, Any] | None = None,
    terminal_state: dict[str, Any] | None = None,
) -> EpisodeResult:
    task = MiniGameTaskSpec(
        game_id=game,
        difficulty="easy",
        level_id=1,
        instruction="Complete the puzzle.",
        max_steps=100,
        timeout_seconds=100,
        scoring_config=scoring_config,
    )
    reason = termination_reason or ("success" if success else "game_failure")
    return EpisodeResult(
        task=task,
        seed=0,
        instruction=task.instruction,
        task_success=success,
        game_score=float(success),
        normalized_score=float(success),
        step_count=step_count,
        invalid_action_count=invalid_actions,
        elapsed_time_seconds=elapsed,
        is_terminal=True,
        episode_status="success" if success else "failure",
        termination_reason=reason,
        raw_metrics=raw_metrics or {},
        runtime=runtime or {},
        terminal_state=terminal_state or {},
    )


def test_bolt_success_score_has_expected_explainable_components() -> None:
    result = _result(
        game="bolt_unscrew",
        success=True,
        scoring_config=_bolt_config(),
        raw_metrics={"boards_total": 8, "boards_exited": 8},
        step_count=10,
        elapsed=10,
        runtime={"agent_decisions": 10},
    )

    score = BoltUnscrewScorer().score_level(result)

    assert score.success_score == 60
    assert score.progress_score == 0
    assert score.efficiency_score == 18
    assert score.action_quality_score == 10
    assert score.time_score == 9
    assert score.penalty_score == 0
    assert score.overall_score == 97
    assert score.normalized_metrics["valid_action_rate"] == 1
    assert score.normalized_metrics["invalid_action_rate"] == 0
    assert score.normalized_metrics["repeated_action_rate"] == 0


def test_bolt_failure_uses_board_progress_and_progress_gates_bonuses() -> None:
    no_progress = _result(
        game="bolt_unscrew",
        success=False,
        scoring_config=_bolt_config(),
        raw_metrics={"boards_total": 8, "boards_exited": 0},
        step_count=0,
    )
    partial = no_progress.model_copy(
        update={"raw_metrics": {"boards_total": 8, "boards_exited": 6}, "step_count": 20},
        deep=True,
    )

    zero_score = BoltUnscrewScorer().score_level(no_progress)
    partial_score = BoltUnscrewScorer().score_level(partial)

    assert zero_score.overall_score == 0
    assert partial_score.progress_score == pytest.approx(33.75)
    assert partial_score.overall_score > zero_score.overall_score
    assert partial_score.overall_score < 60


def test_bolt_deadlock_penalty_is_auditable_and_lowers_score() -> None:
    base = _result(
        game="bolt_unscrew",
        success=False,
        scoring_config=_bolt_config(),
        raw_metrics={"boards_total": 10, "boards_exited": 9},
        runtime={"agent_decisions": 10},
    )
    deadlocked = base.model_copy(
        update={
            "termination_reason": "no_available_hole_deadlock",
            "episode_status": "no_available_hole_deadlock",
        }
    )

    normal_score = BoltUnscrewScorer().score_level(base)
    deadlock_score = BoltUnscrewScorer().score_level(deadlocked)

    assert deadlock_score.penalty_score == 6
    assert deadlock_score.overall_score == normal_score.overall_score - 6


def test_bolt_monotonicity_for_steps_invalid_actions_and_progress() -> None:
    scorer = BoltUnscrewScorer()
    success = _result(
        game="bolt_unscrew",
        success=True,
        scoring_config=_bolt_config(),
        raw_metrics={"boards_total": 5, "boards_exited": 5},
        step_count=50,
        invalid_actions=5,
        runtime={"agent_decisions": 50},
    )
    fewer_steps = success.model_copy(update={"step_count": 20})
    fewer_invalid = success.model_copy(update={"invalid_action_count": 1})
    with_noops = success.model_copy(
        update={"runtime": {"agent_decisions": 50, "model_usage": {"noop_actions": 4}}},
        deep=True,
    )
    assert (
        scorer.score_level(fewer_steps).overall_score >= scorer.score_level(success).overall_score
    )
    assert (
        scorer.score_level(fewer_invalid).overall_score >= scorer.score_level(success).overall_score
    )
    assert scorer.score_level(success).overall_score >= scorer.score_level(with_noops).overall_score

    failure = success.model_copy(
        update={
            "task_success": False,
            "episode_status": "failure",
            "termination_reason": "game_failure",
        }
    )
    low = failure.model_copy(update={"raw_metrics": {"boards_total": 10, "boards_exited": 2}})
    high = failure.model_copy(update={"raw_metrics": {"boards_total": 10, "boards_exited": 8}})
    assert scorer.score_level(high).overall_score >= scorer.score_level(low).overall_score


def test_bolt_reports_acceptance_rate_separately_from_no_progress_quality() -> None:
    result = _result(
        game="bolt_unscrew",
        success=True,
        scoring_config=_bolt_config(),
        raw_metrics={"boards_total": 1, "boards_exited": 1},
        step_count=10,
        invalid_actions=1,
        runtime={
            "agent_decisions": 10,
            "model_usage": {"repeated_actions": 1, "noop_actions": 1},
        },
    )

    metrics = BoltUnscrewScorer().score_level(result).normalized_metrics
    assert metrics["valid_action_rate"] == pytest.approx(0.9)
    assert metrics["action_quality"] == pytest.approx(0.7)


def test_bolt_normalizes_different_raw_board_scales() -> None:
    small = _result(
        game="bolt_unscrew",
        success=False,
        scoring_config=_bolt_config(),
        raw_metrics={"boards_total": 10, "boards_exited": 5},
        runtime={"agent_decisions": 10},
    )
    large = small.model_copy(
        update={"raw_metrics": {"boards_total": 100, "boards_exited": 50}}, deep=True
    )
    assert BoltUnscrewScorer().score_level(small) == BoltUnscrewScorer().score_level(large)


def test_rush_optimal_success_scores_above_inefficient_success() -> None:
    optimal = _result(
        game="truck_escape_2",
        success=True,
        scoring_config=_rush_config(),
        raw_metrics={
            "metrics": {
                "currentProgressRatio": 1,
                "referenceMoves": 4,
                "acceptedMoves": 4,
                "totalOperationAttempts": 4,
                "invalidOperations": 0,
                "totalDurationMs": 10_000,
            }
        },
    )
    inefficient = optimal.model_copy(
        update={
            "raw_metrics": {
                "metrics": {
                    "currentProgressRatio": 1,
                    "referenceMoves": 4,
                    "acceptedMoves": 12,
                    "totalOperationAttempts": 14,
                    "invalidOperations": 2,
                    "repeatedStates": 2,
                    "totalDurationMs": 80_000,
                }
            }
        },
        deep=True,
    )

    optimal_score = RushHour2Scorer().score_level(optimal)
    inefficient_score = RushHour2Scorer().score_level(inefficient)

    assert optimal_score.efficiency_score == 25
    assert optimal_score.action_quality_score == 10
    assert optimal_score.overall_score > inefficient_score.overall_score >= 60


def test_rush_partial_progress_failure_and_confirmed_deadlock() -> None:
    partial = _result(
        game="rush_hour_2",
        success=False,
        scoring_config=_rush_config(),
        raw_metrics={
            "metrics": {
                "currentProgressRatio": 0.8,
                "referenceMoves": 5,
                "acceptedMoves": 5,
                "totalOperationAttempts": 5,
            }
        },
    )
    deadlocked = partial.model_copy(
        update={
            "raw_metrics": {
                **partial.raw_metrics,
                "final_progress": {"deadlockStatus": "confirmed"},
            }
        },
        deep=True,
    )

    partial_score = RushHour2Scorer().score_level(partial)
    deadlock_score = RushHour2Scorer().score_level(deadlocked)

    assert partial_score.progress_score == 36
    assert 0 < partial_score.overall_score < 60
    assert deadlock_score.penalty_score == 7
    assert deadlock_score.overall_score == partial_score.overall_score - 7


def test_rush_cumulative_restarts_reduce_action_quality() -> None:
    base = _result(
        game="truck_escape_2",
        success=True,
        scoring_config=_rush_config(),
        raw_metrics={
            "metrics": {"referenceMoves": 4, "acceptedMoves": 4, "totalOperationAttempts": 4}
        },
    )
    restarted = base.model_copy(
        update={
            "terminal_state": {"raw_game_state": {"ability": {"aggregate": {"totalRestarts": 2}}}}
        },
        deep=True,
    )
    scorer = RushHour2Scorer()
    assert (
        scorer.score_level(restarted).action_quality_score
        < scorer.score_level(base).action_quality_score
    )


@pytest.mark.parametrize("success, expected", [(True, 100.0), (False, 0.0)])
def test_nut_and_bolt_success_rate_only_mode(success: bool, expected: float) -> None:
    config = GameScoringConfig.success_rate_only(version="1.0-nut")
    result = _result(
        game="nut_and_bolt",
        success=success,
        scoring_config=config,
        raw_metrics={"invented_progress": 0.999, "move_count": 1},
    )
    score = NutAndBoltScorer().score_level(result)
    assert score.overall_score == expected
    assert score.normalized_metrics == {"success": float(success)}


def test_nut_and_bolt_partial_credit_from_homogeneous_full_bolts() -> None:
    config = GameScoringConfig(
        version="1.1-test-nut",
        components={
            "success_base": 60,
            "step_efficiency": 20,
            "action_quality": 10,
            "time_efficiency": 10,
            "failure_progress": 45,
            "failure_action_quality": 8,
            "failure_efficiency": 3,
        },
        penalties={"max_steps": 2, "timeout": 3},
        time_budget_seconds=100,
    )
    zero = _result(
        game="nut_and_bolt",
        success=False,
        scoring_config=config,
        terminal_state={
            "raw_game_state": {
                "capacity": 4,
                "bolts": [
                    {"nuts": ["red", "yellow", "red", "yellow"], "remaining": 0},
                    {"nuts": ["yellow", "red", "yellow", "red"], "remaining": 0},
                    {"nuts": [], "remaining": 4},
                    {"nuts": [], "remaining": 4},
                ],
            }
        },
        step_count=10,
        runtime={"agent_decisions": 10},
    )
    partial = zero.model_copy(
        update={
            "terminal_state": {
                "raw_game_state": {
                    "capacity": 4,
                    "bolts": [
                        {"nuts": ["red", "red", "red", "red"], "remaining": 0},
                        {"nuts": ["yellow", "yellow"], "remaining": 2},
                        {"nuts": ["yellow", "yellow"], "remaining": 2},
                        {"nuts": [], "remaining": 4},
                    ],
                }
            }
        },
        deep=True,
    )
    near = zero.model_copy(
        update={
            "terminal_state": {
                "raw_game_state": {
                    "capacity": 4,
                    "bolts": [
                        {"nuts": ["red", "red", "red", "red"], "remaining": 0},
                        {"nuts": ["yellow", "yellow", "yellow"], "remaining": 1},
                        {"nuts": [], "remaining": 4},
                        {"nuts": ["yellow"], "remaining": 3},
                    ],
                }
            }
        },
        deep=True,
    )
    success = partial.model_copy(
        update={
            "task_success": True,
            "episode_status": "success",
            "termination_reason": "success",
            "terminal_state": {
                "raw_game_state": {
                    "capacity": 4,
                    "bolts": [
                        {"nuts": ["red", "red", "red", "red"], "remaining": 0},
                        {"nuts": ["yellow", "yellow", "yellow", "yellow"], "remaining": 0},
                        {"nuts": [], "remaining": 4},
                        {"nuts": [], "remaining": 4},
                    ],
                }
            },
        },
        deep=True,
    )
    scorer = NutAndBoltScorer()
    zero_score = scorer.score_level(zero)
    partial_score = scorer.score_level(partial)
    near_score = scorer.score_level(near)
    success_score = scorer.score_level(success)
    assert zero_score.overall_score == 0
    # best red=4, best yellow=2 -> 6/(4*2)=0.75
    assert partial_score.normalized_metrics["progress"] == pytest.approx(0.75)
    assert partial_score.progress_score == pytest.approx(33.75)
    # consolidating yellow onto one bolt raises progress without completing
    assert near_score.normalized_metrics["progress"] == pytest.approx(0.875)
    assert 0 < partial_score.overall_score < near_score.overall_score < 60
    assert success_score.overall_score >= 60
    assert (
        success_score.overall_score
        > near_score.overall_score
        > partial_score.overall_score
        > zero_score.overall_score
    )


def test_bolt_released_boards_rank_above_no_progress() -> None:
    config = _bolt_config()
    none = _result(
        game="bolt_unscrew",
        success=False,
        scoring_config=config,
        raw_metrics={"boards_total": 4, "boards_exited": 0, "boards_released": 0},
        terminal_state={
            "raw_game_state": {
                "boards": [
                    {"id": "a", "exited": False, "supportCount": 2, "released": False},
                    {"id": "b", "exited": False, "supportCount": 1, "released": False},
                    {"id": "c", "exited": False, "supportCount": 2, "released": False},
                    {"id": "d", "exited": False, "supportCount": 1, "released": False},
                ]
            }
        },
    )
    released = none.model_copy(
        update={
            "terminal_state": {
                "raw_game_state": {
                    "boards": [
                        {"id": "a", "exited": False, "supportCount": 0, "released": True},
                        {"id": "b", "exited": False, "supportCount": 0, "released": True},
                        {"id": "c", "exited": False, "supportCount": 2, "released": False},
                        {"id": "d", "exited": False, "supportCount": 1, "released": False},
                    ]
                }
            }
        },
        deep=True,
    )
    exited = none.model_copy(
        update={
            "raw_metrics": {"boards_total": 4, "boards_exited": 2, "boards_released": 0},
            "terminal_state": {
                "raw_game_state": {
                    "boards": [
                        {"id": "a", "exited": True, "supportCount": 0, "released": False},
                        {"id": "b", "exited": True, "supportCount": 0, "released": False},
                        {"id": "c", "exited": False, "supportCount": 2, "released": False},
                        {"id": "d", "exited": False, "supportCount": 1, "released": False},
                    ]
                }
            },
        },
        deep=True,
    )
    near = none.model_copy(
        update={
            "raw_metrics": {"boards_total": 4, "boards_exited": 3, "boards_released": 1},
            "terminal_state": {
                "raw_game_state": {
                    "boards": [
                        {"id": "a", "exited": True, "supportCount": 0},
                        {"id": "b", "exited": True, "supportCount": 0},
                        {"id": "c", "exited": True, "supportCount": 0},
                        {"id": "d", "exited": False, "supportCount": 0, "released": True},
                    ]
                }
            },
        },
        deep=True,
    )
    success = near.model_copy(
        update={
            "task_success": True,
            "episode_status": "success",
            "termination_reason": "success",
            "raw_metrics": {"boards_total": 4, "boards_exited": 4},
        },
        deep=True,
    )
    scorer = BoltUnscrewScorer()
    scores = [
        scorer.score_level(item).overall_score for item in (none, released, exited, near, success)
    ]
    assert scores == sorted(scores)
    assert scorer.score_level(released).normalized_metrics["progress"] == pytest.approx(0.25)
    assert scorer.score_level(exited).normalized_metrics["progress"] == pytest.approx(0.5)
    assert scorer.score_level(near).normalized_metrics["progress"] == pytest.approx(0.875)
    assert scores[0] == 0
    assert scores[-1] >= 60 > scores[-2]


def test_nut_split_color_cannot_reach_full_progress() -> None:
    from mobile_world.benchmarks.progress import nut_and_bolt_progress

    result = _result(
        game="nut_and_bolt",
        success=False,
        scoring_config=GameScoringConfig.success_rate_only(),
        terminal_state={
            "raw_game_state": {
                "capacity": 4,
                "bolts": [
                    {"nuts": ["red", "red"], "remaining": 2},
                    {"nuts": ["red", "red"], "remaining": 2},
                    {"nuts": ["yellow", "yellow"], "remaining": 2},
                    {"nuts": ["yellow", "yellow"], "remaining": 2},
                ],
            }
        },
    )
    progress, diagnostics = nut_and_bolt_progress(result)
    assert progress == pytest.approx(0.5)
    assert diagnostics["homogeneous_nuts"] == 4
    assert progress < 1.0


def test_episode_payload_exposes_unit_interval_progress_score() -> None:
    from mobile_world.benchmarks.results import _episode_payload

    scored = score_episode(
        _result(
            game="bolt_unscrew",
            success=False,
            scoring_config=_bolt_config(),
            raw_metrics={"boards_total": 4, "boards_exited": 2},
            runtime={"agent_decisions": 10},
        )
    )
    payload = _episode_payload(scored)
    assert payload["progress_score"] == pytest.approx(0.5)
    assert payload["level_score"] == scored.overall_score
    assert payload["process_metrics"]["boards_exited"] == 2
    assert 0 <= payload["progress_score"] <= 1
    assert payload["breakdown"]["progress_score"] == pytest.approx(22.5)


def test_bolt_deadlock_penalty_prefers_explicit_termination_reason() -> None:
    config = _bolt_config()
    result = _result(
        game="bolt_unscrew",
        success=False,
        scoring_config=config,
        raw_metrics={
            "boards_total": 10,
            "boards_exited": 9,
            "deadlock": {"is_deadlocked": True},
        },
        termination_reason="no_available_hole_deadlock",
        runtime={"agent_decisions": 10},
    )
    score = BoltUnscrewScorer().score_level(result)
    assert score.penalty_score == 6


@pytest.mark.parametrize(
    "game, config, raw",
    [
        ("bolt_unscrew", _bolt_config(), {}),
        ("truck_escape_2", _rush_config(), {"metrics": {"referenceMoves": 0, "acceptedMoves": 0}}),
    ],
)
def test_missing_metrics_and_zero_denominators_are_safe(
    game: str, config: GameScoringConfig, raw: dict[str, Any]
) -> None:
    failure = _result(
        game=game,
        success=False,
        scoring_config=config,
        raw_metrics=raw,
        step_count=0,
        elapsed=0,
    )
    scored = score_episode(failure)
    assert 0 <= scored.overall_score < 60
    assert all(0 <= value <= 1 for value in scored.breakdown.normalized_metrics.values())


def test_every_failure_is_below_success_threshold_and_scores_are_clamped() -> None:
    scorer = RushHour2Scorer()
    failure = _result(
        game="truck_escape_2",
        success=False,
        scoring_config=_rush_config(),
        raw_metrics={
            "metrics": {
                "currentProgressRatio": 1000,
                "referenceMoves": 1,
                "acceptedMoves": 1,
                "totalOperationAttempts": 1,
            }
        },
    )
    success = failure.model_copy(
        update={"task_success": True, "episode_status": "success", "termination_reason": "success"}
    )
    assert 0 <= scorer.score_level(failure).overall_score <= 59
    assert scorer.score_level(success).overall_score >= 60


def test_intuitive_ranking_optimal_then_inefficient_then_partial_failures() -> None:
    scorer = RushHour2Scorer()
    optimal = _result(
        game="rush_hour_2",
        success=True,
        scoring_config=_rush_config(),
        raw_metrics={
            "metrics": {
                "currentProgressRatio": 1,
                "referenceMoves": 4,
                "acceptedMoves": 4,
                "totalOperationAttempts": 4,
                "totalDurationMs": 1_000,
            }
        },
    )
    inefficient = optimal.model_copy(
        update={
            "raw_metrics": {
                "metrics": {
                    "currentProgressRatio": 1,
                    "referenceMoves": 4,
                    "acceptedMoves": 40,
                    "totalOperationAttempts": 60,
                    "invalidOperations": 20,
                    "repeatedStates": 20,
                    "totalDurationMs": 100_000,
                }
            }
        },
        deep=True,
    )
    near_failure = optimal.model_copy(
        update={
            "task_success": False,
            "episode_status": "failure",
            "termination_reason": "game_failure",
            "raw_metrics": {
                "metrics": {
                    "currentProgressRatio": 0.95,
                    "referenceMoves": 4,
                    "acceptedMoves": 5,
                    "totalOperationAttempts": 5,
                }
            },
        },
        deep=True,
    )
    low_failure = near_failure.model_copy(
        update={"raw_metrics": {"metrics": {"currentProgressRatio": 0.2}}},
        deep=True,
    )
    no_progress = near_failure.model_copy(
        update={"raw_metrics": {"metrics": {"currentProgressRatio": 0.0}}},
        deep=True,
    )

    scores = [
        scorer.score_level(item).overall_score
        for item in (optimal, inefficient, near_failure, low_failure, no_progress)
    ]
    assert scores == sorted(scores, reverse=True)
    assert scores[1] >= 60 > scores[2]


def test_scoring_policy_hash_version_and_result_versions_are_recorded() -> None:
    config = _bolt_config()
    result = _result(
        game="bolt_unscrew",
        success=True,
        scoring_config=config,
        raw_metrics={"boards_total": 1, "boards_exited": 1},
    )
    scored = score_episode(result, benchmark_version="benchmark-2", game_version="game-7")

    assert len(config.config_hash) == 64
    assert result.task.scoring_config_hash == config.config_hash
    assert scored.scoring_version == config.version
    assert scored.scoring_config_hash == config.config_hash
    assert scored.benchmark_version == "benchmark-2"
    assert scored.game_version == "game-7"
    assert scored.normalized_score == scored.overall_score / 100


def test_old_episode_json_remains_readable_with_legacy_defaults() -> None:
    current = _result(
        game="bolt_unscrew",
        success=True,
        scoring_config=_bolt_config(),
        raw_metrics={"boards_total": 1, "boards_exited": 1},
    ).model_dump(mode="json")
    for field in (
        "overall_score",
        "breakdown",
        "scoring_version",
        "scoring_config_hash",
        "benchmark_version",
        "game_version",
    ):
        current.pop(field)

    restored = EpisodeResult.model_validate_json(json.dumps(current))

    assert restored.overall_score == 100
    assert restored.breakdown.overall_score == 100
    assert restored.scoring_version == "legacy"
    assert restored.benchmark_version == "unknown"


@pytest.mark.parametrize(
    "scorer, game, raw_states",
    [
        (
            TruckEscapeScorer(),
            "truck_escape",
            [
                {"trucks_total": 10, "trucks_removed": 0},
                {"trucks_total": 10, "trucks_removed": 4},
                {"trucks_total": 10, "trucks_removed": 9},
            ],
        ),
        (
            MazePaintScorer(),
            "maze_paint",
            [
                {"total_paintable_cells": 11, "painted_cell_count": 1},
                {"total_paintable_cells": 11, "painted_cell_count": 5},
                {"total_paintable_cells": 11, "painted_cell_count": 10},
            ],
        ),
        (
            ColorConnectScorer(),
            "color_connect",
            [
                {"total_color_pairs": 5, "completed_color_pairs": 0},
                {"total_color_pairs": 5, "completed_color_pairs": 2},
                {"total_color_pairs": 5, "completed_color_pairs": 4},
            ],
        ),
    ],
)
def test_new_game_failure_scores_are_monotonic(
    scorer, game: str, raw_states: list[dict[str, Any]]
) -> None:
    results = [
        _result(
            game=game,
            success=False,
            scoring_config=_standard_config(),
            raw_metrics=raw,
            runtime={"agent_decisions": 20},
            step_count=20,
        )
        for raw in raw_states
    ]
    scores = [scorer.score_level(result).overall_score for result in results]
    assert scores == sorted(scores)
    assert scores[0] == 0
    assert scores[-1] < 60


def test_maze_success_uses_exact_optimal_move_efficiency() -> None:
    optimal = _result(
        game="maze_paint",
        success=True,
        scoring_config=_standard_config(),
        raw_metrics={
            "total_paintable_cells": 20,
            "painted_cell_count": 20,
            "optimal_move_count": 8,
            "move_count": 8,
        },
    )
    inefficient = optimal.model_copy(
        update={"raw_metrics": {**optimal.raw_metrics, "move_count": 16}},
        deep=True,
    )
    scorer = MazePaintScorer()
    assert scorer.score_level(optimal).efficiency_score == 20
    assert scorer.score_level(inefficient).efficiency_score == 10
    assert scorer.score_level(optimal).overall_score > scorer.score_level(inefficient).overall_score


def test_invalid_scoring_bands_and_hash_mismatch_are_rejected() -> None:
    with pytest.raises(ValueError, match="failure_score_cap"):
        GameScoringConfig(
            success_threshold=60,
            failure_score_cap=60,
            components={"success_base": 60},
        )
    config = _bolt_config()
    with pytest.raises(ValueError, match="scoring_config_hash"):
        MiniGameTaskSpec(
            game_id="bolt_unscrew",
            difficulty="easy",
            level_id=1,
            instruction="Complete it.",
            scoring_config=config,
            scoring_config_hash="incorrect",
        )
