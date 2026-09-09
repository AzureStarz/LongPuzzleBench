"""Screenshot-action history and autonomous navigation contracts."""

import copy
import json

import pytest
from PIL import Image

from mobile_world.agents.autonomous import AutonomousVisualAgent
from mobile_world.agents.base import BaseAgent


@pytest.fixture
def requests(monkeypatch):
    monkeypatch.delenv("HISTORY_N_IMAGES", raising=False)
    monkeypatch.setattr(AutonomousVisualAgent, "build_openai_client", lambda *args: None)
    calls = []

    def respond(self, model, messages, **kwargs):
        calls.append(copy.deepcopy(messages))
        return json.dumps({"action_type": "navigate_back"})

    monkeypatch.setattr(BaseAgent, "openai_chat_completions_create", respond)
    monkeypatch.setattr(BaseAgent, "openai_responses_create", respond)
    return calls


def observe(agent):
    return agent.predict(
        {
            "screenshot": Image.new("RGB", (320, 240)),
            "action_feedback": {"accepted": False, "error": "dispatch-secret"},
            "tool_call": "grader-secret",
            "ask_user_response": "recovery-secret",
        }
    )


def images(messages):
    return [
        part
        for message in messages
        if isinstance(message["content"], list)
        for part in message["content"]
        if part["type"] == "image_url"
    ]


@pytest.mark.parametrize("window,expected", [(None, 5), (0, 1), (1, 2), (3, 4)])
def test_screenshot_window_counts_completed_pairs_plus_current(requests, window, expected):
    agent = AutonomousVisualAgent("test-model", history_n_images=window)
    agent.initialize("Complete the requested puzzle.")
    for _ in range(5):
        _, action = observe(agent)
        assert action.action_type == "navigate_back"
    prompt = requests[-1]
    assert len(images(prompt)) == expected
    assert [message["role"] for message in prompt] == ["system", "user"] + ["assistant", "user"] * 4
    assert len(images(prompt[-1:])) == 1
    assert "secret" not in json.dumps(prompt)
    texts = [
        part["text"]
        for message in prompt
        if message["role"] == "user"
        for part in message["content"]
        if part["type"] == "text"
    ]
    assert texts == ["Complete the requested puzzle."] + ["(Previous turn, screen not shown)"] * (
        5 - expected
    )
    assert agent.get_framework_metadata()["history_n_images"] == window


def test_default_keeps_all_observations_and_reset_clears_history(requests):
    agent = AutonomousVisualAgent("test-model")
    agent.initialize("First objective")
    for _ in range(5):
        observe(agent)
    assert len(images(requests[-1])) == 5
    agent.initialize("Second objective")
    observe(agent)
    assert [message["role"] for message in requests[-1]] == ["system", "user"]
    assert "First objective" not in json.dumps(requests[-1])
    assert "Second objective" in json.dumps(requests[-1])


def test_history_environment_override(requests, monkeypatch):
    monkeypatch.setenv("HISTORY_N_IMAGES", "0")
    agent = AutonomousVisualAgent("test-model", history_n_images=3)
    agent.initialize("Task")
    observe(agent)
    observe(agent)
    assert len(images(requests[-1])) == 1
    assert agent.get_framework_metadata()["history_n_images"] == 0


def test_failed_transport_does_not_insert_unpaired_observation(requests, monkeypatch):
    agent = AutonomousVisualAgent("test-model")
    agent.initialize("Task")
    transport = BaseAgent.openai_responses_create

    def fail(*args, **kwargs):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(BaseAgent, "openai_responses_create", fail)
    with pytest.raises(ValueError):
        observe(agent)
    monkeypatch.setattr(BaseAgent, "openai_responses_create", transport)
    observe(agent)
    assert [message["role"] for message in requests[-1]] == ["system", "user"]


def test_request_and_response_logs_are_live_and_screenshots_are_redacted(
    requests, monkeypatch, caplog
):
    caplog.set_level("DEBUG", logger="mobile_world.autonomous")
    agent = AutonomousVisualAgent("test-model", api_key="api-key-secret")
    agent.initialize("Complete the puzzle")
    transport = BaseAgent.openai_responses_create

    def respond(self, model, messages, **kwargs):
        assert "Sending model request 1" in caplog.text
        assert "Complete the puzzle" in caplog.text
        return transport(self, model, messages, **kwargs)

    monkeypatch.setattr(BaseAgent, "openai_responses_create", respond)
    observe(agent)
    assert "Model response 1" in caplog.text
    assert "navigate_back" in caplog.text
    assert "320x240" in caplog.text
    assert "api-key-secret" not in caplog.text
    assert "data:image" not in caplog.text
    assert "[screenshot omitted]" in caplog.text
    assert images(requests[0])[0]["image_url"]["url"].startswith("data:image/png;base64,")
    assert "Sending model" not in json.dumps(agent.history_responses)


def test_provider_failure_logs_request_id_without_credentials(requests, monkeypatch, caplog):
    caplog.set_level("INFO", logger="mobile_world.autonomous")
    agent = AutonomousVisualAgent("test-model")
    agent.initialize("Task")

    def fail(*args, **kwargs):
        raise RuntimeError("https://provider.invalid/?api_key=secret")

    monkeypatch.setattr(BaseAgent, "openai_responses_create", fail)
    with pytest.raises(ValueError):
        observe(agent)
    assert "Model request 1 failed" in caplog.text
    assert "RuntimeError" in caplog.text
    assert "api_key=secret" not in caplog.text


def test_invalid_model_response_is_logged_before_parsing(requests, monkeypatch, caplog):
    caplog.set_level("INFO", logger="mobile_world.autonomous")
    agent = AutonomousVisualAgent("test-model")
    agent.initialize("Task")
    monkeypatch.setattr(
        BaseAgent, "openai_responses_create", lambda *args, **kwargs: "not valid JSON"
    )
    _, action = observe(agent)
    assert action.action_type == "unknown"
    assert "not valid JSON" in caplog.text


@pytest.mark.parametrize(
    "model,coordinate,expected",
    [
        ("qwen/qwen3.8-flash", [516, 721], (1560, 1416)),
        ("gpt-5.6-sol", [516, 721], (516, 721)),
        ("kimi-k2", [0.5, 0.5], (1512, 982)),
        ("claude-sonnet-4", [640, 360], (1512, 982)),
    ],
)
def test_autonomous_inherits_model_coordinate_adaptation(
    requests, monkeypatch, model, coordinate, expected
):
    from mobile_world.agents.base import BaseAgent
    from mobile_world.agents.implementations.general_e2e_agent import GeneralE2EAgentMCP

    assert issubclass(AutonomousVisualAgent, GeneralE2EAgentMCP)

    def respond(*args, **kwargs):
        return json.dumps({"action_type": "click", "coordinate": coordinate})

    monkeypatch.setattr(BaseAgent, "openai_responses_create", respond)
    monkeypatch.setattr(BaseAgent, "openai_chat_completions_create", respond)
    agent = AutonomousVisualAgent(model)
    agent.initialize("Enter Maze Paint")
    _, action = agent.predict({"screenshot": Image.new("RGB", (3024, 1964))})
    assert (action.x, action.y) == expected


@pytest.mark.parametrize("scale", [1000, 1, (1280, 720)])
def test_legacy_prompt_hook_preserves_existing_prompt(scale):
    from mobile_world.agents.implementations.general_e2e_agent import GeneralE2EAgentMCP
    from mobile_world.agents.utils.prompts import GENERAL_E2E_PROMPT_TEMPLATE

    agent = object.__new__(GeneralE2EAgentMCP)
    agent.tools = [{"name": "test"}]
    agent.use_responses_api = True
    agent.mini_game_mode = True
    assert agent._get_system_prompt(scale) == GENERAL_E2E_PROMPT_TEMPLATE.render(
        tools=json.dumps(agent.tools[0], ensure_ascii=False),
        scale_factor=scale,
        allow_multi_action=True,
        mini_game=True,
    )


def test_opus_adaptive_resize_and_drag_use_original_screenshot_coordinates(requests, monkeypatch):
    def respond(*args, **kwargs):
        return json.dumps(
            {"action_type": "drag", "start_coordinate": [400, 300], "end_coordinate": [600, 400]}
        )

    monkeypatch.setattr(BaseAgent, "openai_chat_completions_create", respond)
    agent = AutonomousVisualAgent("claude-opus-4.7")
    agent.initialize("Task")
    _, action = agent.predict({"screenshot": Image.new("RGB", (3024, 1964))})
    width, height = agent.history_images[-1][0].size
    assert max(width, height) == 1280
    assert action.start_x == int(400 * 3024 / width)
    assert action.start_y == int(300 * 1964 / height)
    assert action.end_x == int(600 * 3024 / width)
    assert action.end_y == int(400 * 1964 / height)
    prompt = agent._get_system_prompt((width, height))
    assert "navigate_back" in prompt
    assert "Do not use navigation" not in prompt


def test_inherited_multi_action_queue_uses_one_model_request_and_logs_each_action(
    requests, monkeypatch
):
    def respond(self, model, messages, **kwargs):
        requests.append(copy.deepcopy(messages))
        return (
            'Thought: enter\nAction: {"action_type":"click","coordinate":[500,500]}\n'
            'Thought: back\nAction: {"action_type":"navigate_back"}'
        )

    monkeypatch.setattr(BaseAgent, "openai_responses_create", respond)
    agent = AutonomousVisualAgent("qwen/qwen3.8-flash")
    agent.initialize("Task")
    _, first = observe(agent)
    _, second = observe(agent)
    assert (first.x, first.y) == (160, 120)
    assert second.action_type == "navigate_back"
    assert len(requests) == 1
    assert len(agent.history_images) == len(agent.history_responses) == 1


@pytest.mark.parametrize(
    "invalid",
    [
        '{"action_type":"teleport"}',
        'Action: {"action_type":"click","coordinate":[500,500]}\n'
        'Action: {"action_type":"navigate_back"}\n'
        'Action: {"action_type":"teleport"}',
    ],
)
def test_invalid_action_rolls_back_all_inherited_state(requests, monkeypatch, invalid):
    replies = iter([invalid, '{"action_type":"navigate_back"}'])
    monkeypatch.setattr(BaseAgent, "openai_responses_create", lambda *a, **kw: next(replies))
    agent = AutonomousVisualAgent("qwen/qwen3.8-flash")
    agent.initialize("Task")
    with pytest.raises(ValueError):
        observe(agent)
    assert agent.history_images == []
    assert agent.history_responses == []
    assert agent.actions == []
    assert not agent.pending_actions
    _, action = observe(agent)
    assert action.action_type == "navigate_back"
    assert len(agent.history_images) == len(agent.history_responses) == 1


def test_autonomous_system_prompt_keeps_protocol_without_lifecycle_guidance():
    from mobile_world.agents.autonomous import AUTONOMOUS_PROMPT

    prompt = AUTONOMOUS_PROMPT.render(scale_factor=1000, allow_multi_action=False)
    assert "Normalize both axes to [0, 1000]" in prompt
    assert '"action_type":"click"' in prompt
    assert "recovery" not in prompt
    assert "evaluator" not in prompt
    assert "choose to stop" not in prompt


@pytest.mark.parametrize("model", ["qwen/qwen3.8-flash", "claude-sonnet-4"])
def test_autonomous_batch_preserves_all_actions_including_terminal(requests, monkeypatch, model):
    response = (
        'Action: {"action_type":"navigate_back"}\n'
        'Action: {"action_type":"wait"}\n'
        'Action: {"action_type":"navigate_home"}\n'
        'Action: {"action_type":"answer","text":"Done"}'
    )

    def respond(self, **kwargs):
        requests.append(kwargs["messages"])
        return response

    monkeypatch.setattr(BaseAgent, "openai_chat_completions_create", respond)
    monkeypatch.setattr(BaseAgent, "openai_responses_create", respond)
    agent = AutonomousVisualAgent(model)
    agent.initialize("Task")
    actions = [observe(agent)[1].action_type for _ in range(4)]
    assert actions == ["navigate_back", "wait", "navigate_home", "answer"]
    assert len(requests) == 1
    assert not agent.pending_actions
    prompt = requests[0][0]["content"]
    assert "Emit exactly one" not in prompt
    assert "short sequence" not in prompt
    assert "otherwise emit only" not in prompt


def test_legacy_queued_terminal_policy_is_preserved():
    from mobile_world.agents.implementations.general_e2e_agent import GeneralE2EAgentMCP

    agent = object.__new__(GeneralE2EAgentMCP)
    assert agent._defer_queued_action({"action_type": "answer"}) is True
    assert agent._defer_queued_action({"action_type": "click"}) is False


@pytest.mark.parametrize("model", ["qwen/qwen3.8-flash", "claude-sonnet-4"])
def test_batch_history_preserves_original_reply_and_only_model_call_observations(
    requests, monkeypatch, model
):
    response = (
        "Thought: Keep this complete plan, including its formatting.\n\n"
        'Action: {"action_type":"navigate_back"}\n'
        "Thought: Then return home.\n"
        'Action: {"action_type":"navigate_home"}\n'
        'Action: {"action_type":"wait"}'
    )

    def respond(self, **kwargs):
        requests.append(copy.deepcopy(kwargs["messages"]))
        return response if len(requests) == 1 else '{"action_type":"navigate_back"}'

    monkeypatch.setattr(BaseAgent, "openai_chat_completions_create", respond)
    monkeypatch.setattr(BaseAgent, "openai_responses_create", respond)
    agent = AutonomousVisualAgent(model)
    agent.initialize("Task")
    screenshots = [
        Image.new("RGB", (320, 240), color) for color in ["red", "green", "blue", "yellow"]
    ]
    for screenshot in screenshots[:3]:
        agent.predict({"screenshot": screenshot})
    assert len(requests) == 1
    assert len(agent.history_images) == len(agent.history_responses) == 1
    assert agent.history_responses[0]["content"] == response
    assert len(agent.actions) == 3
    agent.predict({"screenshot": screenshots[3]})
    assert len(requests) == 2
    assert [m["role"] for m in requests[1]] == ["system", "user", "assistant", "user"]
    assert requests[1][2]["content"] == [{"type": "text", "text": response}]
    assert len(images(requests[1])) == 2
    assert [item[0].getpixel((0, 0)) for item in agent.history_images] == [
        (255, 0, 0),
        (255, 255, 0),
    ]
