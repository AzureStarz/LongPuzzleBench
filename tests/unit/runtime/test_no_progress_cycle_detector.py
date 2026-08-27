from __future__ import annotations

import pytest
from PIL import Image

from mobile_world.runtime.no_progress_cycle_detector import NoProgressCycleDetector


def _frame(color: str = "black") -> Image.Image:
    return Image.new("RGB", (100, 200), color)


def _run(actions, *, no_progress_steps: int, progress_values=None, frames=None):
    detector = NoProgressCycleDetector(
        action_window_size=16,
        min_cycle_length=1,
        max_cycle_length=4,
        required_repetitions=3,
        no_progress_steps=no_progress_steps,
        coordinate_tolerance_px=8,
    )
    progress_values = progress_values or [0] * (len(actions) + 1)
    frames = frames or [_frame()] * len(actions)
    decisions = []
    for index, action in enumerate(actions, start=1):
        decisions.append(
            detector.update(
                step=index,
                action=action,
                observation=frames[index - 1],
                state={"board": "same"},
                objective_before={"level_progress": progress_values[index - 1]},
                objective_after={"level_progress": progress_values[index]},
            )
        )
    return decisions


@pytest.mark.parametrize(
    ("actions", "cycle_length"),
    [
        ([{"action_type": "click", "x": 400, "y": 500}] * 4, 1),
        (
            [{"action_type": "click", "x": x, "y": 500} for x in (400, 600, 400, 600, 400, 600)],
            2,
        ),
        (
            [
                {"action_type": "click", "x": x, "y": 500}
                for x in (300, 400, 500, 300, 400, 500, 300, 400, 500)
            ],
            3,
        ),
    ],
)
def test_fixed_action_cycles_terminate_without_progress(actions, cycle_length) -> None:
    decisions = _run(actions, no_progress_steps=len(actions))

    assert decisions[-1].termination_reason == "repeated_action_cycle"
    assert decisions[-1].cycle_length == cycle_length
    assert decisions[-1].cycle_repetitions >= 3
    assert decisions[-1].triggered_step == len(actions)


def test_coordinate_jitter_normalizes_to_same_target_region() -> None:
    actions = [
        {"action_type": "click", "x": x, "y": y}
        for x, y in ((401, 502), (403, 500), (400, 504), (402, 501))
    ]
    decisions = _run(actions, no_progress_steps=4)

    assert decisions[-1].termination_reason == "repeated_action_cycle"
    assert decisions[-1].cycle_length == 1
    assert decisions[-1].action_signature["coordinate_buckets"] == {"x": 50, "y": 63}


def test_coordinate_tolerance_is_not_defeated_by_bucket_boundary() -> None:
    actions = [{"action_type": "click", "x": x, "y": 500} for x in (403, 404, 403, 404)]
    decisions = _run(actions, no_progress_steps=4)

    assert decisions[-1].termination_reason == "repeated_action_cycle"
    assert decisions[-1].cycle_length == 1


def test_repetition_with_objective_progress_is_legal() -> None:
    actions = [{"action_type": "click", "x": 400, "y": 500}] * 6
    decisions = _run(actions, no_progress_steps=3, progress_values=list(range(7)))

    assert all(not decision.terminate for decision in decisions)
    assert decisions[-1].no_progress_steps == 0


def test_different_actions_on_unchanged_screen_terminate_as_generic_no_progress() -> None:
    actions = [{"action_type": "click", "x": 100 + index * 50, "y": 500} for index in range(6)]
    decisions = _run(actions, no_progress_steps=6)

    assert decisions[-1].termination_reason == "no_progress"
    assert decisions[-1].cycle_actions == ()


def test_cycle_below_threshold_does_not_terminate() -> None:
    actions = [{"action_type": "click", "x": x, "y": 500} for x in (400, 600, 400, 600)]
    decisions = _run(actions, no_progress_steps=8)

    assert all(not decision.terminate for decision in decisions)


def test_same_actions_with_changing_game_state_do_not_terminate() -> None:
    actions = [{"action_type": "click", "x": 400, "y": 500}] * 4
    decisions = _run(actions, no_progress_steps=4, progress_values=[0, 1, 2, 3, 4])

    assert decisions[-1].termination_reason is None


def test_progress_regression_does_not_reset_no_progress_counter() -> None:
    actions = [{"action_type": "click", "x": 400, "y": 500}] * 4
    decisions = _run(actions, no_progress_steps=4, progress_values=[0.4, 0.6, 0.4, 0.4, 0.3])

    assert decisions[0].no_progress_steps == 0
    assert decisions[-1].no_progress_steps == 3
    assert decisions[-1].termination_reason is None


def test_board_identity_change_without_level_progress_still_terminates() -> None:
    detector = NoProgressCycleDetector(
        action_window_size=16,
        min_cycle_length=1,
        max_cycle_length=4,
        required_repetitions=3,
        no_progress_steps=4,
    )
    actions = [{"action_type": "click", "x": 400, "y": 500}] * 4
    decisions = []
    for index, action in enumerate(actions, start=1):
        decisions.append(
            detector.update(
                step=index,
                action=action,
                observation=_frame(),
                state={"board": f"state-{index}"},
                objective_before={
                    "level_progress": 0.0,
                    "process_metrics": {"progress": 0.0},
                },
                objective_after={
                    "level_progress": 0.0,
                    "process_metrics": {"progress": 0.0},
                },
            )
        )

    assert decisions[-1].termination_reason == "repeated_action_cycle"
    assert decisions[-1].no_progress_steps == 4
