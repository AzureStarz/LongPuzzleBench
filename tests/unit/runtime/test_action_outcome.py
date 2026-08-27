from __future__ import annotations

from PIL import Image

from mobile_world.runtime.action_outcome import (
    ActionOutcomeTracker,
    objective_improved,
)


def _frame(color: str) -> Image.Image:
    return Image.new("RGB", (100, 200), color)


def _tracker() -> ActionOutcomeTracker:
    return ActionOutcomeTracker(
        recovery_steps=3,
        termination_steps=6,
        max_cycle_length=4,
    )


def test_two_frame_cycle_recovers_despite_coordinate_jitter() -> None:
    tracker = _tracker()
    a = _frame("black")
    b = _frame("white")
    frames = [(a, b), (b, a), (a, b), (b, a)]
    decisions = []
    for index, (before, after) in enumerate(frames, start=1):
        decisions.append(
            tracker.update(
                action_id=f"a-{index}",
                action={"action_type": "click", "x": 50, "y": 100 + index * 10},
                pre_image=before,
                post_image=after,
                pre_frame_id=index,
                post_frame_id=index + 1,
                visual_changed=True,
                visual_change_ratio=1.0,
                stable=True,
                objective_before={"removed": 0},
                objective_after={"removed": 0},
            )
        )

    assert [decision.cycle_length for decision in decisions] == [None, 2, 2, 2]
    assert [decision.evidence_steps for decision in decisions] == [0, 1, 2, 3]
    assert decisions[-1].recovery_required is True
    assert decisions[-1].public_feedback.status == "repeating_visual_cycle"
    assert decisions[-1].action_signature["y"] == 0.7


def test_intentional_repeat_is_allowed_when_objective_progresses() -> None:
    tracker = _tracker()
    image = _frame("black")

    decision = tracker.update(
        action_id="a-1",
        action={"action_type": "click", "x": 50, "y": 100},
        pre_image=image,
        post_image=image,
        pre_frame_id=1,
        post_frame_id=2,
        visual_changed=False,
        visual_change_ratio=0.0,
        stable=True,
        objective_before={"level_progress": 0.0},
        objective_after={"level_progress": 0.2},
    )

    assert decision.evidence_steps == 0
    assert not decision.recovery_required


def test_progress_regression_does_not_clear_no_progress_evidence() -> None:
    tracker = _tracker()
    image = _frame("black")

    first = tracker.update(
        action_id="a-1",
        action={"action_type": "click", "x": 50, "y": 100},
        pre_image=image,
        post_image=image,
        pre_frame_id=1,
        post_frame_id=2,
        visual_changed=False,
        visual_change_ratio=0.0,
        stable=True,
        objective_before={"level_progress": 0.6},
        objective_after={"level_progress": 0.4},
    )
    second = tracker.update(
        action_id="a-2",
        action={"action_type": "click", "x": 50, "y": 100},
        pre_image=image,
        post_image=image,
        pre_frame_id=2,
        post_frame_id=3,
        visual_changed=False,
        visual_change_ratio=0.0,
        stable=True,
        objective_before={"level_progress": 0.4},
        objective_after={"level_progress": 0.4},
    )

    assert first.objective_progressed is False
    assert first.evidence_steps == 1
    assert second.evidence_steps == 2


def test_objective_improved_requires_a_strictly_larger_level_score() -> None:
    assert objective_improved({"level_progress": 0.2}, {"level_progress": 0.4})
    assert not objective_improved({"level_progress": 0.4}, {"level_progress": 0.4})
    assert not objective_improved({"level_progress": 0.4}, {"level_progress": 0.2})
    assert not objective_improved({"stateKey": "a"}, {"stateKey": "b"})
    assert not objective_improved(None, {"level_progress": 1.0})


def test_novel_visual_states_do_not_accumulate_no_progress() -> None:
    tracker = _tracker()
    frames = [_frame(color) for color in ("black", "red", "green", "blue")]

    decisions = [
        tracker.update(
            action_id=f"a-{index}",
            action={"action_type": "click", "x": index * 10, "y": index * 20},
            pre_image=frames[index - 1],
            post_image=frames[index],
            pre_frame_id=index,
            post_frame_id=index + 1,
            visual_changed=True,
            visual_change_ratio=1.0,
            stable=True,
        )
        for index in range(1, len(frames))
    ]

    assert all(decision.evidence_steps == 0 for decision in decisions)
    assert all(not decision.recovery_required for decision in decisions)


def test_stale_observation_is_explicitly_reported() -> None:
    tracker = _tracker()
    image = _frame("black")

    decision = tracker.update(
        action_id="a-1",
        action={"action_type": "click", "x": 50, "y": 100},
        pre_image=image,
        post_image=image,
        pre_frame_id=2,
        post_frame_id=2,
        visual_changed=False,
        visual_change_ratio=0.0,
        stable=True,
    )

    assert decision.reason == "observation_stale"
    assert decision.public_feedback.status == "observation_stale"
    assert decision.public_feedback.fresh_observation is False


def test_public_feedback_contains_no_private_evaluator_payload() -> None:
    tracker = _tracker()
    image = _frame("black")

    decision = tracker.update(
        action_id="a-1",
        action={"action_type": "click", "x": 50, "y": 100},
        pre_image=image,
        post_image=image,
        pre_frame_id=1,
        post_frame_id=2,
        visual_changed=False,
        visual_change_ratio=0.0,
        stable=True,
        objective_before={"secret_score": 0},
        objective_after={"secret_score": 0},
    )

    public = decision.public_feedback.model_dump()
    assert "objective_progressed" not in public
    assert "secret_score" not in str(public)
    assert "state_changed" not in public
