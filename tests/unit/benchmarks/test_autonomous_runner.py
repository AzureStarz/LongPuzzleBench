"""Episode lifetime and observation isolation contracts."""

import json
import time

import pytest
from PIL import Image

from mobile_world.benchmarks.autonomous_runner import AutonomousConfig, run_autonomous_episode


class Browser:
    metadata = {"capture_surface": "viewport"}

    def __init__(self, states):
        self.states = states
        self.index = 0
        self.actions = []
        self.closed = False

    async def start(self):
        pass

    async def snapshot(self):
        return self.states[min(self.index, len(self.states) - 1)]

    async def observe(self):
        return Image.new("RGB", (1280, 900))

    async def execute(self, action):
        self.actions.append(action)
        self.index += 1
        return {"accepted": True, "target": "grader-only-target"}

    async def close(self):
        self.closed = True


def state(lifecycle, progress=0, attempt=1, game="maze_paint"):
    return {
        "game_id": game,
        "difficulty": "easy",
        "level_id": 1,
        "seed": 0,
        "attempt_id": attempt,
        "lifecycle": lifecycle,
        "progress": progress,
        "state": {"secret": "grader-only"},
        "game_specific": {},
    }


class Agent:
    def __init__(self, delay=0, action=None):
        self.observations = []
        self.delay = delay
        self.action = action or {"action_type": "click", "x": 100, "y": 200}

    def initialize(self, instruction):
        self.instruction = instruction

    def predict(self, observation):
        self.observations.append(observation)
        time.sleep(self.delay)
        return "", self.action


def config(timeout=2):
    return AutonomousConfig(
        game_id="maze_paint",
        difficulty="easy",
        level_id=1,
        timeout_seconds=timeout,
        poll_interval_seconds=0.001,
        step_wait_time=0,
    )


@pytest.mark.asyncio
async def test_failure_navigation_reentry_and_attempts_are_agent_controlled(tmp_path):
    browser = Browser(
        [
            state("gallery"),
            state("menu", game="color_connect"),
            state("gallery"),
            state("menu"),
            state("playing", 0.1),
            state("failure", 0.2),
            state("playing", 0, 2),
            state("gallery"),
            state("playing", 0.3, 3),
            state("success", 1, 3),
        ]
    )
    agent = Agent()
    result = await run_autonomous_episode(browser, agent, config(), tmp_path / "run")
    assert result["termination_reason"] == "completion"
    assert len(browser.actions) == 9
    assert browser.closed
    assert len(agent.observations) == 9
    for observation in agent.observations:
        assert set(observation) == {
            "screenshot",
            "tool_call",
            "ask_user_response",
            "action_feedback",
        }
        assert "grader-only" not in repr(observation)
    events = [json.loads(line) for line in (tmp_path / "run/events.jsonl").read_text().splitlines()]
    assert [e["seq"] for e in events] == list(range(len(events)))
    assert any(e["type"] == "snapshot" and e["data"]["lifecycle"] == "failure" for e in events)
    assert all(
        (tmp_path / "run" / e["data"]["screenshot"]).exists()
        for e in events
        if e["type"] == "observation"
    )
    from mobile_world.benchmarks.autonomous_metrics import evaluate_autonomous_trajectory

    assert evaluate_autonomous_trajectory(events)["scoring"] == result["scoring"]


@pytest.mark.asyncio
async def test_timeout_includes_blocked_inference_and_never_dispatches_late_action(tmp_path):
    browser = Browser([state("playing", 0.4)])
    start = time.monotonic()
    result = await run_autonomous_episode(browser, Agent(delay=1), config(0.08), tmp_path / "run")
    assert time.monotonic() - start < 0.5
    assert result["termination_reason"] == "timeout"
    assert browser.actions == []
    assert browser.closed


@pytest.mark.asyncio
async def test_wrong_game_success_cannot_complete_objective(tmp_path):
    browser = Browser([state("success", 1, game="color_connect")])
    result = await run_autonomous_episode(
        browser, Agent(action={"action_type": "finished"}), config(), tmp_path / "run"
    )
    assert result["termination_reason"] == "agent_terminated"


@pytest.mark.asyncio
async def test_wrong_seed_success_cannot_receive_completion_credit(tmp_path):
    snapshot = state("success", 1)
    snapshot["seed"] = 1
    snapshot["state"]["seed"] = 1
    result = await run_autonomous_episode(
        Browser([snapshot]), Agent(action={"action_type": "finished"}), config(), tmp_path / "run"
    )
    assert result["termination_reason"] == "agent_terminated"
    assert result["metrics"]["completed"] is False
    assert result["metrics"]["maximum_progress_reached"] == 0


@pytest.mark.asyncio
async def test_browser_failure_is_infrastructure_not_game_failure(tmp_path):
    browser = Browser([])
    result = await run_autonomous_episode(browser, Agent(), config(), tmp_path / "run")
    assert result["termination_reason"] == "environment_error"
    assert browser.closed


@pytest.mark.asyncio
async def test_completion_during_inference_ends_without_waiting_for_model(tmp_path):
    browser = Browser([state("playing")])
    started = time.monotonic()

    async def snapshot():
        return state("success", 1) if time.monotonic() - started > 0.04 else state("playing")

    browser.snapshot = snapshot
    result = await run_autonomous_episode(browser, Agent(delay=1), config(), tmp_path / "run")
    assert result["termination_reason"] == "completion"
    assert browser.actions == []


@pytest.mark.asyncio
async def test_inflight_action_is_recorded_when_deadline_interrupts_dispatch(tmp_path):
    import asyncio

    browser = Browser([state("playing", 0.2)])

    async def execute(action):
        browser.actions.append(action)
        await asyncio.sleep(1)

    browser.execute = execute
    result = await run_autonomous_episode(browser, Agent(), config(0.08), tmp_path / "run")
    assert result["termination_reason"] == "timeout"
    assert result["metrics"]["total_actions"] == 1
    events = [json.loads(line) for line in (tmp_path / "run/events.jsonl").read_text().splitlines()]
    action = next(e["data"] for e in events if e["type"] == "action")
    assert action["accepted"] is None
    assert action["error"] == "dispatch_interrupted"


def test_default_objective_is_entire_game_difficulty():
    objective = AutonomousConfig(game_id="maze_paint", difficulty="easy")
    assert objective.level_id is None
    assert objective.target["scope"] == "game_difficulty"
    assert objective.target["level_ids"] == list(range(1, 11))
    assert "level 1" not in objective.instruction
    assert "all levels" in objective.instruction


@pytest.mark.asyncio
async def test_difficulty_episode_continues_after_first_level_and_finishes_all(tmp_path):
    states = [state("menu")]
    for level in range(1, 11):
        states.extend(
            [
                {**state("playing", 0.1, level), "level_id": level},
                {**state("success", 1, level), "level_id": level},
            ]
        )
    browser = Browser(states)
    result = await run_autonomous_episode(
        browser,
        Agent(),
        AutonomousConfig(
            game_id="maze_paint",
            difficulty="easy",
            timeout_seconds=3,
            poll_interval_seconds=0.001,
            step_wait_time=0,
        ),
        tmp_path / "run",
    )
    assert result["termination_reason"] == "completion"
    assert len(browser.actions) == 20
    assert result["metrics"]["completed"] is True
    assert result["metrics"]["maximum_progress_reached"] == 1


@pytest.mark.asyncio
async def test_first_level_success_is_partial_progress_at_episode_end(tmp_path):
    browser = Browser([state("success", 1)])
    result = await run_autonomous_episode(
        browser,
        Agent(action={"action_type": "finished"}),
        AutonomousConfig(game_id="maze_paint", difficulty="easy", timeout_seconds=2),
        tmp_path / "run",
    )
    assert result["termination_reason"] == "agent_terminated"
    assert result["metrics"]["completed"] is False
    assert result["metrics"]["maximum_progress_reached"] == 0.1


@pytest.mark.parametrize("level_id", [None, 2])
def test_task_instruction_contains_only_goal_and_action_permission(level_id):
    objective = AutonomousConfig(game_id="maze_paint", difficulty="easy", level_id=level_id)
    goal = (
        "Complete all levels of Maze Paint (迷宫涂色) at easy difficulty in the Game Suite. "
        if level_id is None
        else "Complete Maze Paint (迷宫涂色), easy, level 2 in the Game Suite. "
    )
    assert objective.instruction == goal + "You may take any actions to achieve this goal."


@pytest.mark.asyncio
async def test_screenshots_wait_after_dispatch_while_telemetry_continues(tmp_path):
    browser = Browser([state("playing")])
    result = await run_autonomous_episode(
        browser, Agent(), config(0.32).model_copy(update={"step_wait_time": 0.1}), tmp_path / "run"
    )
    events = [json.loads(line) for line in (tmp_path / "run/events.jsonl").read_text().splitlines()]
    last_action = None
    delayed_observations = 0
    for event in events:
        if event["type"] == "action":
            last_action = event["elapsed_seconds"]
        if event["type"] == "observation" and last_action is not None:
            assert event["elapsed_seconds"] - last_action >= 0.1
            delayed_observations += 1
    assert delayed_observations >= 1
    assert result["termination_reason"] == "timeout"


@pytest.mark.asyncio
async def test_timeout_during_screenshot_delay_does_not_request_another_action(tmp_path):
    agent = Agent()
    result = await run_autonomous_episode(
        Browser([state("playing")]),
        agent,
        config(0.15).model_copy(update={"step_wait_time": 1}),
        tmp_path / "run",
    )
    assert len(agent.observations) == 1
    assert result["termination_reason"] == "timeout"
    assert result["metrics"]["total_wall_clock_seconds"] < 0.5


def test_screenshot_delay_defaults_and_validation():
    assert AutonomousConfig(game_id="maze_paint", difficulty="easy").step_wait_time == 2.0
    for value in [-1, float("inf"), float("nan")]:
        with pytest.raises(ValueError):
            AutonomousConfig(game_id="maze_paint", difficulty="easy", step_wait_time=value)
