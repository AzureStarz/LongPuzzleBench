from __future__ import annotations

import json
from typing import Any

import pytest

from mobile_world.benchmarks.autonomous_metrics import (
    ObjectiveProgress,
    derive_autonomous_metrics,
    evaluate_autonomous_trajectory,
    parse_trajectory_jsonl,
    score_autonomous_metrics,
)


def _event(seq: int, elapsed: float, event_type: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "seq": seq,
        "timestamp": f"2026-01-01T00:00:{seq:02d}Z",
        "elapsed_seconds": elapsed,
        "type": event_type,
        "data": data,
    }


def _start(timeout: float = 100) -> dict[str, Any]:
    return _event(
        0,
        0,
        "episode_start",
        {
            "target": {"game_id": "color_connect", "difficulty": "easy", "level_id": 1},
            "timeout_seconds": timeout,
        },
    )


def _snapshot(
    seq: int,
    elapsed: float,
    *,
    lifecycle: str,
    game: str | None = "color_connect",
    progress: float | None = 0,
    attempt: str | None = "attempt-1",
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "url": "/" if game is None else f"/games/{game}",
        "game_id": game,
        "difficulty": "easy" if game else None,
        "level_id": 1 if game else None,
        "attempt_id": attempt,
        "lifecycle": lifecycle,
        "game_specific": {},
        "state": {"private_answer": "never consumed"},
    }
    if progress is not None:
        data["progress"] = progress
    return _event(seq, elapsed, "snapshot", data)


def _action(
    seq: int,
    elapsed: float,
    *,
    target: str | None,
    accepted: bool = True,
    x: int = 10,
) -> dict[str, Any]:
    return _event(
        seq,
        elapsed,
        "action",
        {"action": {"type": "click", "x": x, "y": 10}, "accepted": accepted, "target": target},
    )


def test_full_lifecycle_tracks_failure_recovery_attempts_and_completion() -> None:
    events = [
        _start(),
        _snapshot(1, 1, lifecycle="gallery", game=None, progress=None, attempt=None),
        _action(2, 2, target="color_connect_card"),
        _snapshot(3, 3, lifecycle="menu"),
        _action(4, 4, target="start"),
        _snapshot(5, 5, lifecycle="playing"),
        _action(6, 6, target="board_cell"),
        _snapshot(7, 7, lifecycle="playing", progress=0.4),
        _snapshot(8, 8, lifecycle="failure", progress=0.4),
        _action(9, 10, target="retry"),
        _snapshot(10, 11, lifecycle="playing", progress=0, attempt="attempt-2"),
        _action(11, 12, target="board_cell", x=20),
        _snapshot(12, 13, lifecycle="success", progress=1, attempt="attempt-2"),
        _event(13, 14, "episode_end", {"reason": "completion"}),
    ]

    result = evaluate_autonomous_trajectory(events)
    metrics = result["metrics"]

    assert metrics["completed"] is True
    assert metrics["attempt_count"] == 2
    assert metrics["failure_count"] == 1
    assert metrics["successful_recovery_count"] == 1
    assert metrics["unrecovered_failure_count"] == 0
    assert metrics["retry_count"] == 1
    assert metrics["maximum_progress_reached"] == 1
    assert metrics["time_to_first_correct_game_entry_seconds"] == 3
    assert metrics["actions_to_first_correct_game_entry"] == 1
    assert metrics["actions_to_game_start"] == 2
    assert result["scoring"]["recovery_applicable"] is True
    assert result["scoring"]["component_scores"]["outcome"] == 40


def test_target_progress_ignores_wrong_game_and_reentry_is_episode_level() -> None:
    events = [
        _start(),
        _snapshot(1, 1, lifecycle="gallery", game=None, progress=None, attempt=None),
        _action(2, 2, target="wrong_game"),
        _snapshot(3, 3, lifecycle="success", game="maze_paint", progress=1),
        _action(4, 4, target="home"),
        _snapshot(5, 5, lifecycle="gallery", game=None, progress=None, attempt=None),
        _action(6, 6, target="color_connect_card"),
        _snapshot(7, 7, lifecycle="playing", progress=0.5),
        _action(8, 8, target="home"),
        _snapshot(9, 9, lifecycle="gallery", game=None, progress=None, attempt=None),
        _action(10, 10, target="color_connect_card"),
        _snapshot(11, 11, lifecycle="playing", progress=0.2),
        _event(12, 12, "episode_end", {"reason": "agent_terminated"}),
    ]

    metrics = derive_autonomous_metrics(events)

    assert metrics["completed"] is False
    assert metrics["maximum_progress_reached"] == 0.5
    assert metrics["final_progress"] == 0.2
    assert metrics["incorrect_entry_count"] == 1
    assert metrics["target_exit_count"] == 1
    assert metrics["accidental_exit_count"] is None
    assert metrics["successful_reentry_after_exit_count"] == 1
    assert metrics["attempt_count"] == 2


def test_game_failure_does_not_terminate_episode_and_timeout_keeps_partial_progress() -> None:
    events = [
        _start(timeout=60),
        _snapshot(1, 1, lifecycle="playing"),
        _snapshot(2, 10, lifecycle="failure", progress=0.6),
        _action(3, 20, target="board_cell", accepted=False),
        _event(4, 60, "episode_end", {"reason": "timeout"}),
    ]

    metrics = derive_autonomous_metrics(events)
    score = score_autonomous_metrics(metrics)

    assert metrics["timeout"] is True
    assert metrics["completed"] is False
    assert metrics["maximum_progress_reached"] == 0.6
    assert metrics["unrecovered_failure_count"] == 1
    assert metrics["time_in_failed_states_seconds"] == 50
    assert score["component_scores"]["progress"] == 18
    assert score["component_scores"]["recovery"] == 0


def test_no_failure_makes_recovery_nullable_and_redistributes_five_points() -> None:
    metrics = {
        "completed": True,
        "maximum_progress_reached": 1,
        "autonomous_entry": True,
        "autonomous_start": True,
        "autonomous_lifecycle_completion": True,
        "action_efficiency": 1,
        "total_wall_clock_seconds": 0,
        "configured_timeout_seconds": 100,
        "recovery_opportunity_count": 0,
        "recovery_success_rate": None,
    }

    score = score_autonomous_metrics(metrics)

    assert score["recovery_applicable"] is False
    assert score["component_ratios"]["recovery"] is None
    assert score["component_scores"]["recovery"] is None
    assert score["effective_weights"]["recovery"] == 0
    assert sum(score["effective_weights"].values()) == pytest.approx(100)
    assert score["overall_score"] == 100


def test_jsonl_parser_is_deterministic_and_rejects_non_monotonic_events() -> None:
    events = [_start(), _event(1, 2, "episode_end", {"reason": "agent_terminated"})]
    text = "\n".join(json.dumps(event) for event in events)

    assert parse_trajectory_jsonl(text) == events

    events[1]["seq"] = 0
    with pytest.raises(ValueError, match="strictly increasing"):
        parse_trajectory_jsonl("\n".join(json.dumps(event) for event in events))


def test_private_state_cannot_change_metrics_or_score() -> None:
    events = [
        _start(),
        _snapshot(1, 1, lifecycle="playing", progress=0.25),
        _event(2, 2, "episode_end", {"reason": "agent_terminated"}),
    ]
    altered = json.loads(json.dumps(events))
    altered[1]["data"]["state"] = {"solution": "different", "grader_score": 100}

    assert evaluate_autonomous_trajectory(events) == evaluate_autonomous_trajectory(altered)
    assert derive_autonomous_metrics(events)["dead_end_count"] is None


def test_wrong_level_is_incorrect_entry_and_restart_uses_action_type() -> None:
    wrong = _snapshot(1, 1, lifecycle="menu")
    wrong["data"]["level_id"] = 2
    restart = _action(4, 4, target=None)
    restart["data"]["action"] = {"action_type": "resetGame"}
    events = [
        _start(),
        wrong,
        _snapshot(2, 2, lifecycle="playing", progress=0.2),
        _snapshot(3, 3, lifecycle="failure", progress=0.2),
        restart,
        _snapshot(5, 5, lifecycle="playing", progress=0, attempt="attempt-2"),
        _snapshot(6, 6, lifecycle="playing", progress=0.5, attempt="attempt-2"),
        _event(7, 7, "episode_end", {"reason": "agent_terminated"}),
    ]

    metrics = derive_autonomous_metrics(events)

    assert metrics["incorrect_entry_count"] == 1
    assert metrics["restart_count"] == 1
    assert metrics["restart_effectiveness"] is None
    assert [attempt["best_progress"] for attempt in metrics["attempts"]] == [0.2, 0.5]


def test_explicit_deadlock_is_nonterminal_and_annotated_until_recovery() -> None:
    playing = _snapshot(1, 1, lifecycle="playing", progress=0.1)
    dead = _snapshot(2, 2, lifecycle="failure", progress=0.1)
    recovered = _snapshot(4, 5, lifecycle="playing", progress=0, attempt="attempt-2")
    playing["data"]["state"] = {"deadlock": {"is_deadlocked": False}}
    dead["data"]["state"] = {"deadlock": {"is_deadlocked": True}}
    recovered["data"]["state"] = {"deadlock": {"is_deadlocked": False}}
    events = [
        _start(),
        playing,
        dead,
        _action(3, 4, target="retry"),
        recovered,
        _event(5, 7, "episode_end", {"reason": "agent_terminated"}),
    ]

    result = evaluate_autonomous_trajectory(events)

    assert result["metrics"]["dead_end_count"] == 1
    assert result["metrics"]["time_in_known_dead_states_seconds"] == 3
    assert result["metrics"]["completed"] is False
    assert result["metrics"]["successful_recovery_count"] == 1
    assert {tag for item in result["annotations"] for tag in item["tags"]} >= {
        "meaningful_progress",
        "failure",
        "dead_end",
        "recovery",
        "dead_end_exit",
    }


def test_suite_events_supply_ui_elements_and_lifecycle_control_counts() -> None:
    menu = _snapshot(1, 1, lifecycle="menu")
    playing = _snapshot(3, 3, lifecycle="playing", progress=0.2)
    restarted = _snapshot(5, 5, lifecycle="playing", progress=0.6, attempt="attempt-2")
    menu["data"]["events"] = [
        {
            "sequence": 1,
            "wall_time": "2026-01-01T00:00:01Z",
            "event_type": "browser_action",
            "details": {
                "target": {
                    "element": "button",
                    "id": "startGame",
                    "label": "Start game",
                    "href": None,
                    "disabled": False,
                }
            },
        },
        {
            "sequence": 2,
            "wall_time": "2026-01-01T00:00:01.100Z",
            "event_type": "game_start_requested",
            "details": {"generation": 1},
        },
    ]
    playing["data"]["events"] = [
        {
            "sequence": 3,
            "wall_time": "2026-01-01T00:00:03Z",
            "event_type": "browser_action",
            "details": {"target": {"element": "game_canvas"}},
        },
        {
            "sequence": 4,
            "wall_time": "2026-01-01T00:00:03.100Z",
            "event_type": "browser_action",
            "details": {
                "target": {
                    "element": "button",
                    "id": "resetGame",
                    "label": "Restart game",
                    "href": None,
                    "disabled": False,
                }
            },
        },
        {
            "sequence": 5,
            "wall_time": "2026-01-01T00:00:03.200Z",
            "event_type": "game_restart_requested",
            "details": {"generation": 2},
        },
        {
            "sequence": 6,
            "wall_time": "2026-01-01T00:00:03.300Z",
            "event_type": "browser_action",
            "details": {
                "target": {
                    "element": "button",
                    "id": "backToGallery",
                    "label": "Back to Game Suite",
                    "href": None,
                    "disabled": False,
                }
            },
        },
    ]
    # Repeated bridge payloads must not double-count suite events.
    restarted["data"]["events"] = list(playing["data"]["events"])
    events = [
        _start(),
        menu,
        _action(2, 2, target=None),
        playing,
        _action(4, 4, target=None),
        restarted,
        _event(6, 6, "episode_end", {"reason": "agent_terminated"}),
    ]

    metrics = derive_autonomous_metrics(events)

    assert metrics["unique_ui_elements_explored"] == 4
    assert metrics["game_start_count"] == 1
    assert metrics["restart_count"] == 1
    assert metrics["back_navigation_count"] == 1
    assert metrics["restart_effectiveness"] == 1


def test_native_difficulty_menu_counts_entry_without_inventing_selected_level():
    menu = _snapshot(2, 2, lifecycle="menu", attempt=None)
    menu["data"].update(difficulty=None, level_id=None, progress=0)
    events = [
        _start(),
        _action(1, 1, target="Entry_color-connect"),
        menu,
        _action(3, 3, target="Easy"),
        _snapshot(4, 4, lifecycle="playing", progress=0.2),
        _event(5, 5, "episode_end", {"reason": "timeout"}),
    ]
    metrics = derive_autonomous_metrics(events)
    assert metrics["time_to_first_correct_game_entry_seconds"] == 2
    assert metrics["actions_to_first_correct_game_entry"] == 1
    assert metrics["incorrect_entry_count"] == 0
    assert metrics["time_to_game_start_seconds"] == 4
    assert metrics["maximum_progress_reached"] == 0.2


def test_native_exit_control_is_counted_as_back_navigation():
    snapshot = _snapshot(1, 1, lifecycle="menu", game=None, attempt=None)
    snapshot["data"]["events"] = [
        {
            "sequence": 1,
            "wall_time": "2026-01-01T00:00:01Z",
            "event_type": "game_exit_requested",
            "details": {"source": "native_control", "control_name": "ExitButton"},
        }
    ]
    metrics = derive_autonomous_metrics(
        [
            _start(),
            snapshot,
            _event(2, 2, "episode_end", {"reason": "timeout"}),
        ]
    )
    assert metrics["back_navigation_count"] == 1


def test_animation_loading_does_not_create_another_attempt():
    events = [
        _start(),
        _snapshot(1, 1, lifecycle="playing", progress=0.1),
        _snapshot(2, 2, lifecycle="loading", progress=0.1),
        _snapshot(3, 3, lifecycle="playing", progress=0.3),
        _event(4, 4, "episode_end", {"reason": "timeout"}),
    ]
    metrics = derive_autonomous_metrics(events)
    assert metrics["attempt_count"] == 1
    assert metrics["maximum_progress_reached"] == 0.3


def _difficulty_start(level_ids: list[int] | None = None) -> dict[str, Any]:
    return _event(
        0,
        0,
        "episode_start",
        {
            "target": {
                "scope": "game_difficulty",
                "game_id": "color_connect",
                "difficulty": "easy",
                "level_ids": level_ids or [1, 2, 3],
                "seed": 7,
            },
            "timeout_seconds": 100,
        },
    )


def _difficulty_snapshot(
    seq: int,
    elapsed: float,
    level_id: int,
    progress: float,
    lifecycle: str = "playing",
    *,
    game: str = "color_connect",
    difficulty: str = "easy",
    seed: int = 7,
    attempt: str = "attempt-1",
) -> dict[str, Any]:
    snapshot = _snapshot(
        seq,
        elapsed,
        lifecycle=lifecycle,
        game=game,
        progress=progress,
        attempt=attempt,
    )
    snapshot["data"].update(
        difficulty=difficulty,
        level_id=level_id,
        seed=seed,
    )
    return snapshot


def test_objective_progress_requires_every_catalogued_level_once() -> None:
    target = _difficulty_start()["data"]["target"]
    tracker = ObjectiveProgress(target)

    tracker.update(_difficulty_snapshot(1, 1, 1, 1, "success")["data"])
    tracker.update(_difficulty_snapshot(2, 2, 1, 1, "success")["data"])
    tracker.update(_difficulty_snapshot(3, 3, 2, 1, "success", seed=8)["data"])
    tracker.update(_difficulty_snapshot(4, 4, 99, 1, "success")["data"])

    assert tracker.completed_level_ids == {1}
    assert tracker.completed is False

    tracker.update(_difficulty_snapshot(5, 5, 2, 1, "success")["data"])
    tracker.update(_difficulty_snapshot(6, 6, 3, 1, "success")["data"])

    assert tracker.completed_level_ids == {1, 2, 3}
    assert tracker.completed is True


def test_game_difficulty_metrics_aggregate_unique_level_progress() -> None:
    events = [
        _difficulty_start(),
        _difficulty_snapshot(1, 1, 1, 0.5),
        _difficulty_snapshot(2, 2, 1, 1, "success"),
        _difficulty_snapshot(3, 3, 1, 1, "success", attempt="attempt-2"),
        _difficulty_snapshot(4, 4, 2, 0.25),
        _difficulty_snapshot(5, 5, 3, 1, "success"),
        _event(6, 6, "episode_end", {"reason": "timeout"}),
    ]

    result = evaluate_autonomous_trajectory(events)
    metrics = result["metrics"]

    assert metrics["completed"] is False
    assert metrics["completed_level_ids"] == [1, 3]
    assert metrics["completed_level_count"] == 2
    assert metrics["objective_level_count"] == 3
    assert metrics["level_progress"] == {"1": 1.0, "2": 0.25, "3": 1.0}
    assert metrics["maximum_progress_reached"] == 0.75
    assert metrics["final_progress"] == 0.75
    assert result["scoring"]["version"] == "autonomous-game-difficulty-v2"


def test_game_difficulty_completion_waits_for_all_levels_and_attempts_are_per_level() -> None:
    events = [
        _difficulty_start([1, 2]),
        _difficulty_snapshot(1, 1, 1, 1, "success"),
        _difficulty_snapshot(2, 2, 2, 0.4, attempt="attempt-1"),
        _difficulty_snapshot(3, 3, 2, 1, "success", attempt="attempt-2"),
        _event(4, 4, "episode_end", {"reason": "completion"}),
    ]

    result = evaluate_autonomous_trajectory(events)
    metrics = result["metrics"]

    assert metrics["completed"] is True
    assert metrics["completed_level_ids"] == [1, 2]
    assert [(attempt["level_id"], attempt["best_progress"]) for attempt in metrics["attempts"]] == [
        (1, 1.0),
        (2, 0.4),
        (2, 1.0),
    ]
    tags = [tag for annotation in result["annotations"] for tag in annotation["tags"]]
    assert tags.count("level_complete") == 2
    assert tags.count("objective_completion") == 1


def test_explicit_level_target_keeps_legacy_completion_and_scoring_semantics() -> None:
    result = evaluate_autonomous_trajectory(
        [
            _start(),
            _snapshot(1, 1, lifecycle="success", progress=1),
            _event(2, 2, "episode_end", {"reason": "completion"}),
        ]
    )

    assert result["metrics"]["completed"] is True
    assert "completed_level_ids" not in result["metrics"]
    assert result["scoring"]["version"] == "autonomous-v1"
    assert result["annotations"][0]["tags"] == ["meaningful_progress", "completion"]
