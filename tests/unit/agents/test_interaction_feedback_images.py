from __future__ import annotations

from PIL import Image

from mobile_world.agents.base import BaseAgent
from mobile_world.agents.implementations.general_e2e_agent import (
    GeneralE2EAgentMCP,
    uses_openai_responses_api,
    uses_screenshot_pixel_coordinates,
)
from mobile_world.agents.utils.interaction_history import (
    keep_historical_screenshot,
    observation_interaction_feedback,
    public_action_feedback_text,
    retained_history_pairs,
)
from mobile_world.runtime.utils.models import PublicActionFeedback


def test_history_image_cap_counts_completed_pairs() -> None:
    assert keep_historical_screenshot(None, 100)
    assert keep_historical_screenshot(2, 2)
    assert not keep_historical_screenshot(2, 3)
    assert retained_history_pairs(None, 7) == 7
    assert retained_history_pairs(3, 7) == 3


def test_public_feedback_precedes_tool_slot() -> None:
    feedback = PublicActionFeedback(
        action_id="a1",
        status="no_visible_effect",
        executed=True,
        fresh_observation=True,
        recovery_required=True,
    )
    observation = {"action_feedback": feedback, "tool_call": {"private": "ignored"}}
    assert observation_interaction_feedback(observation)["status"] == "no_visible_effect"
    assert public_action_feedback_text(observation) == (
        "no_visible_effect; reassess the fresh screenshot"
    )


def test_responses_translation_uses_public_input_types() -> None:
    instructions, items = BaseAgent._responses_input(
        [
            {"role": "system", "content": "system"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "task"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}},
                ],
            },
            {"role": "assistant", "content": [{"type": "text", "text": "done"}]},
        ]
    )
    assert instructions == "system"
    assert items[0]["content"][0]["type"] == "input_text"
    assert items[0]["content"][1] == {
        "type": "input_image",
        "image_url": "data:image/png;base64,AA",
    }
    assert items[1]["content"][0]["type"] == "output_text"


def test_model_transport_and_coordinate_heuristics() -> None:
    assert uses_openai_responses_api("gpt-5.6-sol")
    assert uses_openai_responses_api("qwen/qwen3-vl")
    assert not uses_openai_responses_api("anthropic/claude-sonnet")
    assert uses_screenshot_pixel_coordinates("openai/gpt-5.6-terra")
    assert not uses_screenshot_pixel_coordinates("qwen/qwen3-vl")


def test_general_agent_executes_safe_batched_prefix(monkeypatch) -> None:
    monkeypatch.setattr(GeneralE2EAgentMCP, "build_openai_client", lambda *args: None)
    agent = GeneralE2EAgentMCP(
        model_name="gpt-5.6-sol",
        llm_base_url="https://api.openai.com/v1",
        api_key="DUMMY_API_KEY",
        tools=[],
        runtime_conf={"mini_game_mode": True},
    )
    responses = iter(
        [
            """Thought: select
Action: {"action_type":"click","coordinate":[100,200]}
Thought: move
Action: {"action_type":"click","coordinate":[300,400]}
Thought: finish
Action: {"action_type":"status","goal_status":"complete"}"""
        ]
    )
    agent.openai_responses_create = lambda **kwargs: next(responses)  # type: ignore[method-assign]
    agent.initialize("solve")
    observation = {
        "screenshot": Image.new("RGB", (1080, 1920), "white"),
        "tool_call": None,
        "ask_user_response": None,
    }
    _, first = agent.predict(observation)
    _, second = agent.predict(observation)
    assert (first.x, first.y) == (100, 200)
    assert (second.x, second.y) == (300, 400)
    assert not agent.pending_actions
