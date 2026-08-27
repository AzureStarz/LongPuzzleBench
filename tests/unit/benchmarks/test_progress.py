"""Discrimination tests for white-box progress potentials P(s)."""

from __future__ import annotations

import pytest

from mobile_world.benchmarks.models import EpisodeResult, MiniGameTaskSpec
from mobile_world.benchmarks.progress import (
    bolt_unscrew_progress,
    color_connect_progress,
    level_progress_from_state,
    maze_paint_progress,
    nut_and_bolt_progress,
    rush_hour_2_progress,
    truck_escape_progress,
)
from mobile_world.runtime.action_outcome import objective_improved


def _episode(
    game: str,
    *,
    success: bool = False,
    raw_metrics: dict | None = None,
    terminal_state: dict | None = None,
) -> EpisodeResult:
    task = MiniGameTaskSpec(
        game_id=game,
        difficulty="easy",
        level_id=1,
        instruction="Solve the level.",
        max_steps=100,
        timeout_seconds=100,
    )
    return EpisodeResult(
        task=task,
        seed=0,
        instruction=task.instruction,
        task_success=success,
        game_score=float(success),
        normalized_score=float(success),
        step_count=10,
        elapsed_time_seconds=10,
        is_terminal=True,
        episode_status="success" if success else "failure",
        termination_reason="success" if success else "game_failure",
        raw_metrics=raw_metrics or {},
        terminal_state=terminal_state or {},
    )


def test_bolt_progress_ladder_initial_to_success() -> None:
    states = [
        _episode(
            "bolt_unscrew",
            terminal_state={
                "raw_game_state": {
                    "boards": [
                        {"exited": False, "supportCount": 2},
                        {"exited": False, "supportCount": 1},
                    ]
                }
            },
        ),
        _episode(
            "bolt_unscrew",
            terminal_state={
                "raw_game_state": {
                    "boards": [
                        {"exited": False, "supportCount": 0, "released": True},
                        {"exited": False, "supportCount": 1},
                    ]
                }
            },
        ),
        _episode(
            "bolt_unscrew",
            raw_metrics={"boards_total": 2, "boards_exited": 1},
            terminal_state={
                "raw_game_state": {
                    "boards": [
                        {"exited": True, "supportCount": 0},
                        {"exited": False, "supportCount": 1},
                    ]
                }
            },
        ),
        _episode(
            "bolt_unscrew",
            raw_metrics={"boards_total": 2, "boards_exited": 1},
            terminal_state={
                "raw_game_state": {
                    "boards": [
                        {"exited": True, "supportCount": 0},
                        {"exited": False, "supportCount": 0, "released": True},
                    ]
                }
            },
        ),
        _episode(
            "bolt_unscrew",
            success=True,
            raw_metrics={"boards_total": 2, "boards_exited": 2},
        ),
    ]
    progress = [bolt_unscrew_progress(item)[0] for item in states]
    assert progress == sorted(progress)
    assert progress[0] == 0.0
    assert progress[1] == 0.25
    assert progress[2] == 0.5
    assert progress[3] == 0.75
    assert progress[4] == 1.0


def test_bolt_progress_counts_exits_missing_from_live_snapshot() -> None:
    result = _episode(
        "bolt_unscrew",
        raw_metrics={"boards_total": 9, "boards_exited": 5},
        terminal_state={
            "raw_game_state": {
                "boards": [
                    {"exited": False, "supportCount": 2},
                    {"exited": False, "supportCount": 1},
                    {"exited": False, "supportCount": 1},
                    {"exited": False, "supportCount": 1},
                ]
            }
        },
    )
    progress, diagnostics = bolt_unscrew_progress(result)
    assert diagnostics["boards_exited"] == 5.0
    assert diagnostics["boards_supported_remaining"] == 4.0
    assert progress == pytest.approx(5 / 9)


def test_bolt_progress_snapshot_outranks_stale_zero_aggregate() -> None:
    result = _episode(
        "bolt_unscrew",
        raw_metrics={"boards_total": 4, "boards_exited": 0},
        terminal_state={
            "raw_game_state": {
                "boards": [
                    {"exited": True, "supportCount": 0},
                    {"exited": True, "supportCount": 0},
                    {"exited": False, "supportCount": 1},
                    {"exited": False, "supportCount": 1},
                ]
            }
        },
    )
    progress, diagnostics = bolt_unscrew_progress(result)
    assert diagnostics["boards_exited"] == 2.0
    assert progress == pytest.approx(0.5)


def test_rush_progress_uses_final_not_peak() -> None:
    peak_only = _episode(
        "rush_hour_2",
        raw_metrics={
            "metrics": {
                "currentProgressRatio": 0.2,
                "maxProgressRatio": 0.9,
            },
            "final_progress": {"progressRatio": 0.2, "directBlockerCount": 2},
        },
    )
    near = _episode(
        "rush_hour_2",
        raw_metrics={
            "metrics": {"currentProgressRatio": 0.85},
            "final_progress": {
                "progressRatio": 0.85,
                "exactMovesRemaining": 1,
                "directBlockerCount": 0,
            },
        },
    )
    success = _episode(
        "rush_hour_2",
        success=True,
        raw_metrics={"metrics": {"currentProgressRatio": 1}},
    )
    p_peak, diagnostics = rush_hour_2_progress(peak_only)
    p_near, _ = rush_hour_2_progress(near)
    p_success, _ = rush_hour_2_progress(success)
    assert p_peak == 0.2
    assert diagnostics["max_progress_ratio"] == 0.9
    assert p_peak < p_near < p_success == 1.0


def test_nut_progress_ladder_and_mixed_stacks_get_zero() -> None:
    mixed = _episode(
        "nut_and_bolt",
        terminal_state={
            "raw_game_state": {
                "capacity": 3,
                "bolts": [
                    {"nuts": ["red", "blue"], "remaining": 1},
                    {"nuts": ["blue", "red"], "remaining": 1},
                    {"nuts": [], "remaining": 3},
                ],
            }
        },
    )
    early = _episode(
        "nut_and_bolt",
        terminal_state={
            "raw_game_state": {
                "capacity": 3,
                "bolts": [
                    {"nuts": ["red", "red"], "remaining": 1},
                    {"nuts": ["blue", "blue", "red"], "remaining": 0},
                    {"nuts": [], "remaining": 3},
                ],
            }
        },
    )
    medium = _episode(
        "nut_and_bolt",
        terminal_state={
            "raw_game_state": {
                "capacity": 3,
                "bolts": [
                    {"nuts": ["red", "red", "red"], "remaining": 0},
                    {"nuts": ["blue", "blue"], "remaining": 1},
                    {"nuts": [], "remaining": 3},
                ],
            }
        },
    )
    solved_state = _episode(
        "nut_and_bolt",
        terminal_state={
            "raw_game_state": {
                "capacity": 3,
                "bolts": [
                    {"nuts": ["red", "red", "red"], "remaining": 0},
                    {"nuts": ["blue", "blue", "blue"], "remaining": 0},
                    {"nuts": [], "remaining": 3},
                ],
            }
        },
    )
    success = solved_state.model_copy(
        update={
            "task_success": True,
            "episode_status": "success",
            "termination_reason": "success",
        }
    )
    values = [
        nut_and_bolt_progress(mixed)[0],
        nut_and_bolt_progress(early)[0],
        nut_and_bolt_progress(medium)[0],
        nut_and_bolt_progress(solved_state)[0],
        nut_and_bolt_progress(success)[0],
    ]
    assert values[0] == 0.0
    assert values[1] == pytest.approx(2 / 6)
    assert values[2] == pytest.approx(5 / 6)
    assert values == sorted(values)
    assert values[3] == 1.0
    assert values[4] == 1.0


def test_truck_escape_progress_ladder() -> None:
    states = [
        _episode("truck_escape", raw_metrics={"trucks_total": 10, "trucks_removed": done})
        for done in (0, 2, 6, 9)
    ]
    states.append(
        _episode(
            "truck_escape",
            success=True,
            raw_metrics={"trucks_total": 10, "trucks_removed": 10},
        )
    )
    values = [truck_escape_progress(item)[0] for item in states]
    assert values == [0.0, 0.2, 0.6, 0.9, 1.0]


def test_maze_paint_progress_removes_initial_cell_baseline() -> None:
    states = [
        _episode(
            "maze_paint",
            raw_metrics={
                "total_paintable_cells": 11,
                "painted_cell_count": painted,
                "remaining_unpainted_cells": 11 - painted,
            },
        )
        for painted in (1, 3, 7, 10)
    ]
    states.append(
        _episode(
            "maze_paint",
            success=True,
            raw_metrics={"total_paintable_cells": 11, "painted_cell_count": 11},
        )
    )
    values = [maze_paint_progress(item)[0] for item in states]
    assert values == [0.0, 0.2, 0.6, 0.9, 1.0]


def test_color_connect_scores_only_completed_pairs() -> None:
    initial = _episode(
        "color_connect",
        raw_metrics={
            "total_color_pairs": 5,
            "completed_color_pairs": 0,
            "occupied_path_cells": 12,
            "total_playable_cells": 25,
        },
    )
    early = initial.model_copy(
        update={"raw_metrics": {**initial.raw_metrics, "completed_color_pairs": 1}},
        deep=True,
    )
    near = initial.model_copy(
        update={"raw_metrics": {**initial.raw_metrics, "completed_color_pairs": 4}},
        deep=True,
    )
    success = near.model_copy(
        update={
            "task_success": True,
            "episode_status": "success",
            "termination_reason": "success",
        }
    )
    values = [color_connect_progress(item)[0] for item in (initial, early, near, success)]
    assert values == [0.0, 0.2, 0.8, 1.0]
    assert color_connect_progress(initial)[1]["path_coverage_ratio"] == pytest.approx(12 / 25)


def _payload(game_id: str, state: dict) -> dict:
    score, metrics = level_progress_from_state(game_id, state)
    return {"level_progress": score, "process_metrics": metrics}


@pytest.mark.parametrize(
    ("game_id", "before", "identity_after", "improved_after", "expected_improved"),
    [
        (
            "rush_hour_2",
            {
                "raw_metrics": {
                    "metrics": {
                        "acceptedMoves": 4,
                        "movedCells": 6,
                        "currentProgressRatio": 0.0,
                    },
                    "final_progress": {
                        "stateKey": "0,1|2,1",
                        "progressRatio": 0.0,
                        "estimatedMovesRemaining": 4,
                    },
                }
            },
            {
                "raw_metrics": {
                    "metrics": {
                        "acceptedMoves": 14,
                        "movedCells": 22,
                        "currentProgressRatio": 0.0,
                    },
                    "final_progress": {
                        "stateKey": "0,1|2,2",
                        "progressRatio": 0.0,
                        "estimatedMovesRemaining": 4,
                    },
                }
            },
            {
                "raw_metrics": {
                    "metrics": {
                        "acceptedMoves": 5,
                        "currentProgressRatio": 0.4,
                    },
                    "final_progress": {
                        "stateKey": "0,1|2,3",
                        "progressRatio": 0.4,
                        "estimatedMovesRemaining": 3,
                    },
                }
            },
            0.4,
        ),
        (
            "truck_escape_2",
            {
                "raw_metrics": {
                    "metrics": {"acceptedMoves": 2, "currentProgressRatio": 0.2},
                    "final_progress": {"stateKey": "a", "progressRatio": 0.2},
                }
            },
            {
                "raw_metrics": {
                    "metrics": {"acceptedMoves": 8, "currentProgressRatio": 0.2},
                    "final_progress": {"stateKey": "b", "progressRatio": 0.2},
                }
            },
            {
                "raw_metrics": {
                    "metrics": {"acceptedMoves": 3, "currentProgressRatio": 0.6},
                    "final_progress": {"stateKey": "c", "progressRatio": 0.6},
                }
            },
            0.6,
        ),
        (
            "bolt_unscrew",
            {
                "raw_metrics": {"boards_total": 2, "boards_exited": 0},
                "raw_game_state": {
                    "boards": [
                        {"exited": False, "supportCount": 2},
                        {"exited": False, "supportCount": 1},
                    ]
                },
            },
            {
                "raw_metrics": {"boards_total": 2, "boards_exited": 0},
                "raw_game_state": {
                    "selectedScrew": "a1",
                    "boards": [
                        {"exited": False, "supportCount": 2},
                        {"exited": False, "supportCount": 1},
                    ],
                },
            },
            {
                "raw_metrics": {"boards_total": 2, "boards_exited": 1},
                "raw_game_state": {
                    "boards": [
                        {"exited": True, "supportCount": 0},
                        {"exited": False, "supportCount": 1},
                    ]
                },
            },
            0.5,
        ),
        (
            "nut_and_bolt",
            {
                "raw_game_state": {
                    "capacity": 3,
                    "bolts": [
                        {"nuts": ["red", "blue"], "remaining": 1},
                        {"nuts": ["blue", "red"], "remaining": 1},
                        {"nuts": [], "remaining": 3},
                    ],
                }
            },
            {
                "raw_game_state": {
                    "capacity": 3,
                    "bolts": [
                        {"nuts": ["blue", "red"], "remaining": 1},
                        {"nuts": ["red", "blue"], "remaining": 1},
                        {"nuts": [], "remaining": 3},
                    ],
                }
            },
            {
                "raw_game_state": {
                    "capacity": 3,
                    "bolts": [
                        {"nuts": ["red", "red"], "remaining": 1},
                        {"nuts": ["blue", "blue"], "remaining": 1},
                        {"nuts": [], "remaining": 3},
                    ],
                }
            },
            4 / 6,
        ),
        (
            "nuts_bolts",
            {
                "raw_game_state": {
                    "capacity": 3,
                    "bolts": [
                        {"nuts": ["red", "blue"], "remaining": 1},
                        {"nuts": ["blue"], "remaining": 2},
                    ],
                }
            },
            {
                "raw_game_state": {
                    "capacity": 3,
                    "bolts": [
                        {"nuts": ["blue", "red"], "remaining": 1},
                        {"nuts": ["blue"], "remaining": 2},
                    ],
                }
            },
            {
                "raw_game_state": {
                    "capacity": 3,
                    "bolts": [
                        {"nuts": ["red"], "remaining": 2},
                        {"nuts": ["blue", "blue"], "remaining": 1},
                    ],
                }
            },
            3 / 6,
        ),
        (
            "truck_escape",
            {"raw_metrics": {"trucks_total": 10, "trucks_removed": 2}},
            {"raw_metrics": {"trucks_total": 10, "trucks_removed": 2, "moves": 9}},
            {"raw_metrics": {"trucks_total": 10, "trucks_removed": 3}},
            0.3,
        ),
        (
            "maze_paint",
            {
                "raw_metrics": {
                    "total_paintable_cells": 11,
                    "painted_cell_count": 1,
                }
            },
            {
                "raw_metrics": {
                    "total_paintable_cells": 11,
                    "painted_cell_count": 1,
                    "cursor": "moved",
                }
            },
            {
                "raw_metrics": {
                    "total_paintable_cells": 11,
                    "painted_cell_count": 4,
                }
            },
            0.3,
        ),
        (
            "color_connect",
            {
                "raw_metrics": {
                    "total_color_pairs": 5,
                    "completed_color_pairs": 0,
                    "occupied_path_cells": 4,
                    "total_playable_cells": 25,
                }
            },
            {
                "raw_metrics": {
                    "total_color_pairs": 5,
                    "completed_color_pairs": 0,
                    "occupied_path_cells": 18,
                    "total_playable_cells": 25,
                }
            },
            {
                "raw_metrics": {
                    "total_color_pairs": 5,
                    "completed_color_pairs": 1,
                    "occupied_path_cells": 6,
                    "total_playable_cells": 25,
                }
            },
            0.2,
        ),
    ],
)
def test_no_progress_uses_level_improvement_not_board_identity(
    game_id: str,
    before: dict,
    identity_after: dict,
    improved_after: dict,
    expected_improved: float,
) -> None:
    start = _payload(game_id, before)
    same_progress = _payload(game_id, identity_after)
    better = _payload(game_id, improved_after)

    assert start["level_progress"] == pytest.approx(same_progress["level_progress"])
    assert better["level_progress"] == pytest.approx(expected_improved)
    assert not objective_improved(start, same_progress)
    assert objective_improved(start, better)
    assert not objective_improved(better, start)


def test_unknown_game_only_treats_success_as_level_progress() -> None:
    running = _payload("custom_game", {"status": "running", "success": False})
    success = _payload("custom_game", {"status": "success", "success": True})
    assert running["level_progress"] == 0.0
    assert success["level_progress"] == 1.0
    assert objective_improved(running, success)
