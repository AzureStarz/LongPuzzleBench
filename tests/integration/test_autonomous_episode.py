"""Scripted end-to-end episodes through the native autonomous Cocos suite."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest
from test_autonomous_suite import RUNTIME, _serve

from mobile_world.benchmarks.autonomous_runner import AutonomousConfig, run_autonomous_episode
from mobile_world.runtime.autonomous_browser import AutonomousBrowser


class NativeScriptedAgent:
    """Test driver using only fixed visible UI geometry and screenshot observations."""

    def __init__(self, browser: AutonomousBrowser, loop: asyncio.AbstractEventLoop, partial: bool):
        self.browser = browser
        self.loop = loop
        self.partial = partial
        self.step = 0
        self.actions: list[dict[str, object]] = []

    def initialize(self, instruction: str) -> None:
        self.instruction = instruction

    def predict(self, observation: dict[str, object]):
        assert set(observation) == {
            "screenshot",
            "tool_call",
            "ask_user_response",
            "action_feedback",
        }
        action = asyncio.run_coroutine_threadsafe(self.next_action(), self.loop).result(timeout=10)
        self.actions.append(action)
        return "scripted visible UI action", action

    async def _geometry(self) -> tuple[float, float, float]:
        page = self.browser._require_page()
        box = await page.locator("#GameCanvas").bounding_box()
        assert box is not None
        scale = min(box["width"] / 540, box["height"] / 960)
        left = box["x"] + (box["width"] - 540 * scale) / 2
        top = box["y"] + (box["height"] - 960 * scale) / 2
        return left, top, scale

    async def _click(self, x: float, y: float) -> dict[str, object]:
        left, top, scale = await self._geometry()
        return {"action_type": "click", "x": left + x * scale, "y": top + y * scale}

    async def _drag(
        self, start: tuple[float, float], end: tuple[float, float]
    ) -> dict[str, object]:
        left, top, scale = await self._geometry()
        return {
            "action_type": "drag",
            "start_x": left + start[0] * scale,
            "start_y": top + start[1] * scale,
            "end_x": left + end[0] * scale,
            "end_y": top + end[1] * scale,
            "duration": 0.3,
        }

    async def next_action(self) -> dict[str, object]:
        self.step += 1
        solution = (
            ((300, 237), (100, 237)),
            ((300, 237), (100, 237)),
            ((315, 327), (135, 327)),
            ((360, 462), (360, 200)),
            ((225, 417), (510, 417)),
        )
        if self.partial:
            if self.step == 1:
                return await self._click(270, 509)
            if self.step == 2:
                return await self._click(270, 315)
            if self.step == 3:
                return {"action_type": "wait", "duration": 0.45}
            move_index = self.step - 4
            if move_index < len(solution) - 1:
                return await self._drag(*solution[move_index])
            return {"action_type": "wait", "duration": 0.2}

        navigation = {
            1: (270, 721),  # wrong Maze Paint entry
            2: (75, 908),  # back from Maze difficulty
            3: (270, 509),  # Rush Hour 2 entry
            4: (270, 315),  # Easy difficulty starts the game
            6: (478, 89),  # native Restart
            8: (62, 89),  # native Exit
            10: (75, 908),  # back from Rush Hour difficulty
            11: (270, 509),  # rediscover Rush Hour 2
            12: (270, 315),  # re-enter Easy
        }
        if self.step in navigation:
            return await self._click(*navigation[self.step])
        if self.step in {5, 7, 9, 13}:
            return {"action_type": "wait", "duration": 0.45}

        solution_step = self.step - 14
        move_index = solution_step // 2
        if move_index >= len(solution):
            return {"action_type": "wait", "duration": 0.2}
        if solution_step % 2:
            return {"action_type": "wait", "duration": 0.45}
        return await self._drag(*solution[move_index])


@pytest.mark.integration
@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["completion", "timeout"])
async def test_native_autonomous_episode_and_regrade(tmp_path: Path, outcome: str) -> None:
    if not (RUNTIME / "index.html").is_file():
        pytest.skip(f"Cocos web build is unavailable: {RUNTIME}")
    with _serve(RUNTIME) as base:
        browser = AutonomousBrowser(base, headless=True, capture_surface="viewport", seed=19)
        agent = NativeScriptedAgent(
            browser, asyncio.get_running_loop(), partial=outcome == "timeout"
        )
        result = await run_autonomous_episode(
            browser,
            agent,
            AutonomousConfig(
                game_id="rush_hour_2",
                difficulty="easy",
                level_id=1,
                seed=19,
                timeout_seconds=30 if outcome == "completion" else 9,
                poll_interval_seconds=0.05,
                step_wait_time=0.5,
            ),
            tmp_path / "episode",
        )

    assert result["termination_reason"] == outcome, result
    assert agent.actions
    if outcome == "completion":
        assert result["metrics"]["maximum_progress_reached"] == 1
        assert result["metrics"]["attempt_count"] >= 3
        assert result["metrics"]["incorrect_entry_count"] >= 1
        assert result["metrics"]["successful_reentry_after_exit_count"] >= 1
    else:
        assert 0 < result["metrics"]["maximum_progress_reached"] < 1
        assert result["scoring"]["overall_score"] > 0
        assert result["metrics"]["attempt_count"] == 1

    raw_events = [
        json.loads(line) for line in (tmp_path / "episode/events.jsonl").read_text().splitlines()
    ]
    decisions = [event for event in raw_events if event["type"] == "decision"]
    dispatched = [event for event in raw_events if event["type"] == "action"]
    assert [event["data"]["action"] for event in decisions] == agent.actions
    assert len(dispatched) == len(agent.actions)

    replay = subprocess.run(
        [
            sys.executable,
            "-m",
            "mobile_world.run",
            "autonomous-regrade",
            str(tmp_path / "episode/events.jsonl"),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(replay.stdout)["scoring"] == result["scoring"]


class DifficultyScriptedAgent(NativeScriptedAgent):
    async def next_action(self) -> dict[str, object]:
        if self.step == 22:
            self.step += 1
            return {"action_type": "wait", "duration": 1.2}
        if self.step == 23:
            self.step += 1
            return await self._click(182, 544)  # Native completion overlay: Next level
        return await super().next_action()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_default_difficulty_episode_allows_agent_to_advance_after_success(tmp_path: Path):
    with _serve(RUNTIME) as base:
        browser = AutonomousBrowser(base, headless=True, capture_surface="viewport")
        agent = DifficultyScriptedAgent(browser, asyncio.get_running_loop(), partial=False)
        result = await run_autonomous_episode(
            browser,
            agent,
            AutonomousConfig(
                game_id="rush_hour_2",
                difficulty="easy",
                timeout_seconds=30,
                poll_interval_seconds=0.05,
                step_wait_time=0.5,
            ),
            tmp_path / "episode",
        )
    events = [
        json.loads(line) for line in (tmp_path / "episode/events.jsonl").read_text().splitlines()
    ]
    snapshots = [event["data"] for event in events if event["type"] == "snapshot"]
    assert any(s.get("level_id") == 1 and s.get("lifecycle") == "success" for s in snapshots)
    assert any(s.get("level_id") == 2 and s.get("lifecycle") == "playing" for s in snapshots)
    assert result["termination_reason"] == "timeout"
    assert result["metrics"]["completed"] is False
    assert 0.1 <= result["metrics"]["maximum_progress_reached"] < 1
    assert result["metrics"]["target"]["scope"] == "game_difficulty"
    from mobile_world.benchmarks.autonomous_metrics import evaluate_autonomous_trajectory

    assert evaluate_autonomous_trajectory(events)["scoring"] == result["scoring"]
