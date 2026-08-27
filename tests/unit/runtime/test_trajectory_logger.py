from __future__ import annotations

import json

from PIL import Image

from mobile_world.runtime.utils.models import Observation, PublicActionFeedback
from mobile_world.runtime.utils.trajectory_logger import TrajLogger


def test_trajectory_aligns_raw_parsed_executed_and_post_observation(tmp_path) -> None:
    logger = TrajLogger(str(tmp_path), "task")
    before = Observation(screenshot=Image.new("RGB", (20, 30), "black"), frame_id=1)
    after = Observation(
        screenshot=Image.new("RGB", (20, 30), "white"),
        frame_id=2,
        action_feedback=PublicActionFeedback(
            action_id="action-1",
            status="screen_changed",
            executed=True,
            fresh_observation=True,
        ),
    )
    action = {"action_type": "click", "x": 10, "y": 15}

    logger.log_traj(
        "task",
        "goal",
        1,
        "raw response",
        action,
        before,
        {"total_tokens": 1},
    )
    logger.log_action_result(
        "task",
        1,
        executed_action=action,
        execution_result={
            "action_id": "action-1",
            "executed": True,
            "public_feedback": after.action_feedback.model_dump(),
        },
        post_observation=after,
        duration_seconds=0.25,
    )
    logger.log_termination("repeated_action_cycle", {"cycle_length": 1})

    data = json.loads((tmp_path / "task" / "traj.json").read_text())
    step = data["0"]["traj"][0]
    assert step["raw_model_response"] == "raw response"
    assert step["parsed_action"] == action
    assert step["normalized_action"] == action
    assert step["executed_action"] == action
    assert step["action_id"] == "action-1"
    assert step["execution_result"]["executed"] is True
    assert step["pre_observation"]["frame_id"] == 1
    assert step["post_observation"]["frame_id"] == 2
    assert step["pre_action_feedback"] is None
    assert step["post_action_feedback"]["status"] == "screen_changed"
    assert step["public_action_feedback"]["status"] == "screen_changed"
    assert step["termination_reason"] == "repeated_action_cycle"
    assert step["termination_diagnostics"]["cycle_length"] == 1
    assert data["termination"]["reason"] == "repeated_action_cycle"
    assert (
        step["pre_observation"]["screenshot_sha256"]
        != step["post_observation"]["screenshot_sha256"]
    )
    assert (tmp_path / "task" / step["pre_observation"]["screenshot_path"]).is_file()
    assert (tmp_path / "task" / step["post_observation"]["screenshot_path"]).is_file()
