"""Passive, wall-clock-bounded GUI episodes, independent of the classic runner."""

from __future__ import annotations

import asyncio
import json
import logging
import queue
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from mobile_world.benchmarks.autonomous_metrics import (
    ObjectiveProgress,
    evaluate_autonomous_trajectory,
)
from mobile_world.benchmarks.progress import canonical_progress_game_id

logger = logging.getLogger("mobile_world.autonomous.runner")


class AutonomousConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    game_id: str
    difficulty: str
    level_id: int | None = Field(default=None, ge=1)
    level_ids: tuple[int, ...] = ()
    seed: int = Field(default=0, ge=0)
    timeout_seconds: float = Field(default=3600, gt=0, allow_inf_nan=False)
    step_wait_time: float = Field(default=2.0, ge=0, allow_inf_nan=False)
    poll_interval_seconds: float = Field(default=0.1, gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def resolve_difficulty_levels(self) -> AutonomousConfig:
        if self.level_id is None:
            from mobile_world.benchmarks.catalog import load_catalog

            root = Path(__file__).resolve().parents[3]
            catalog = load_catalog(root / "configs/longpuzzlebench.json")
            levels = sorted(
                {
                    int(task.level_id)
                    for task in catalog.tasks
                    if canonical_progress_game_id(task.game_id)
                    == canonical_progress_game_id(self.game_id)
                    and task.difficulty == self.difficulty
                }
            )
            if not levels:
                raise ValueError("Game and difficulty are not in the released catalogue")
            object.__setattr__(self, "level_ids", tuple(levels))
        return self

    @property
    def target(self) -> dict[str, Any]:
        target = {
            "game_id": canonical_progress_game_id(self.game_id),
            "difficulty": self.difficulty,
            "seed": self.seed,
        }
        if self.level_id is None:
            target.update(scope="game_difficulty", level_ids=list(self.level_ids))
        else:
            target["level_id"] = self.level_id
        return target

    @property
    def instruction(self) -> str:
        names = {
            "rush_hour_2": "Rush Hour (卡车出库 2)",
            "nut_and_bolt": "Nut and Bolt (螺帽与螺栓)",
            "bolt_unscrew": "Bolt Unscrew (螺丝专家)",
            "maze_paint": "Maze Paint (迷宫涂色)",
            "color_connect": "Color Connect (颜色连线)",
            "truck_escape": "Truck Escape (卡车出库)",
        }
        name = names.get(self.target["game_id"], self.game_id)
        objective = (
            f"Complete all levels of {name} at {self.difficulty} difficulty in the Game Suite. "
            if self.level_id is None
            else f"Complete {name}, {self.difficulty}, level {self.level_id} in the Game Suite. "
        )
        return objective + "You may take any actions to achieve this goal."


class EventLog:
    """Append-only raw observations; derived annotations never alter this file."""

    def __init__(self, directory: Path, started: float):
        directory.mkdir(parents=True, exist_ok=False)
        (directory / "screenshots").mkdir()
        self.directory = directory
        self.started = started
        self.events: list[dict[str, Any]] = []
        self.file = (directory / "events.jsonl").open("x", encoding="utf-8")

    def append(self, kind: str, data: dict[str, Any]) -> dict[str, Any]:
        event = {
            "schema_version": 1,
            "seq": len(self.events),
            "timestamp": datetime.now(UTC).isoformat(),
            "elapsed_seconds": max(0.0, time.monotonic() - self.started),
            "type": kind,
            "data": data,
        }
        self.file.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n")
        self.file.flush()
        self.events.append(event)
        return event


def _background_call(function: Any, *args: Any) -> queue.Queue:
    """Run inference off-loop so a blocked provider cannot postpone the deadline."""
    result: queue.Queue = queue.Queue(maxsize=1)

    def call() -> None:
        try:
            result.put((True, function(*args)))
        except Exception as exc:
            result.put((False, exc))

    threading.Thread(target=call, daemon=True).start()
    return result


async def run_autonomous_episode(
    browser: Any,
    agent: Any,
    config: AutonomousConfig,
    output: Path,
) -> dict[str, Any]:
    """Supply pixels and dispatch agent actions; never make a gameplay decision.

    Environment setup precedes the clock. From the initial suite observation,
    inference, navigation, animation, waits, and retries all consume one budget.
    The agent receives no browser object, selectors, state, or grader annotations.
    """
    started = time.monotonic()
    log = EventLog(output, started)
    deadline = started + config.timeout_seconds
    reason = "timeout"
    pending = None
    observation_seq = None
    feedback = None
    error = None
    last_snapshot = None
    next_observation_at = 0.0
    initializing = True
    objective = ObjectiveProgress(config.target)
    try:
        logger.info("Starting browser; trajectory directory: %s", output)
        await browser.start()
        display = getattr(browser, "metadata", {}).get("display")
        if display:
            logger.info("Browser display: %s", json.dumps(display, ensure_ascii=False))
        started = time.monotonic()
        log.started = started
        deadline = started + config.timeout_seconds
        log.append(
            "episode_start",
            {
                "mode": "autonomous",
                "target": config.target,
                "seed": config.seed,
                "timeout_seconds": config.timeout_seconds,
                "config": config.model_dump(),
                "instruction": config.instruction,
                "browser": getattr(browser, "metadata", {}),
                "agent": {
                    "class": type(agent).__name__,
                    "metadata": (
                        agent.get_framework_metadata()
                        if hasattr(agent, "get_framework_metadata")
                        else {}
                    ),
                },
            },
        )
        logger.info(
            "Episode started: %s; timeout=%.1fs", config.instruction, config.timeout_seconds
        )
        pending = _background_call(agent.initialize, config.instruction)
        while time.monotonic() < deadline:
            # One global deadline bounds browser operations as well as model calls.
            async with asyncio.timeout_at(deadline):
                snapshot = await browser.snapshot()
                if snapshot != last_snapshot:
                    log.append("snapshot", snapshot)
                    last_snapshot = snapshot
                objective.update(snapshot)
                if objective.completed:
                    reason = "completion"
                    break
                if pending is not None and not pending.empty():
                    ok, value = pending.get_nowait()
                    pending = None
                    if not ok:
                        # Provider failure is recorded, not reported as a game failure.
                        logger.warning(
                            "Agent call failed: %s; details in events.jsonl", type(value).__name__
                        )
                        log.append("agent_error", {"error": str(value)})
                        if initializing:
                            error = f"Agent initialization failed: {value}"
                            reason = "environment_error"
                            break
                        feedback = {"error": "Agent call failed; no action executed."}
                    elif initializing:
                        initializing = False
                    else:
                        response, action = value
                        action = (
                            action.model_dump(exclude_none=True)
                            if hasattr(action, "model_dump")
                            else dict(action)
                        )
                        log.append(
                            "decision",
                            {
                                "observation_seq": observation_seq,
                                "action": action,
                                "response": response,
                            },
                        )
                        logger.info(
                            "Decision for observation %s: %s",
                            observation_seq,
                            json.dumps(action, ensure_ascii=False),
                        )
                        logger.debug(
                            "Agent response for observation %s:\n%s", observation_seq, response
                        )
                        if action.get("action_type") in {"finished", "answer"}:
                            log.append(
                                "action",
                                {
                                    "action": action,
                                    "accepted": True,
                                    "observation_seq": observation_seq,
                                },
                            )
                            reason = "agent_terminated"
                            break
                        try:
                            receipt = await browser.execute(action)
                        except BaseException:
                            log.append(
                                "action",
                                {
                                    "action": action,
                                    "accepted": None,
                                    "error": "dispatch_interrupted",
                                    "observation_seq": observation_seq,
                                },
                            )
                            raise
                        log.append(
                            "action",
                            {"action": action, **receipt, "observation_seq": observation_seq},
                        )
                        next_observation_at = time.monotonic() + config.step_wait_time
                        logger.info(
                            "Action dispatched: accepted=%s; screenshot delay=%.2fs",
                            receipt.get("accepted"),
                            config.step_wait_time,
                        )
                        # Only dispatch acknowledgement goes back to the agent.
                        feedback = {"accepted": bool(receipt.get("accepted"))}
                        if receipt.get("error"):
                            feedback["error"] = receipt["error"]
                        # Observe the result before soliciting another decision.
                        continue
                if pending is None and time.monotonic() >= next_observation_at:
                    screenshot = await browser.observe()
                    reference = f"screenshots/{len(log.events):06d}.png"
                    screenshot.save(output / reference)
                    observation = log.append(
                        "observation",
                        {
                            "screenshot": reference,
                            "width": screenshot.width,
                            "height": screenshot.height,
                        },
                    )
                    observation_seq = observation["seq"]
                    if time.monotonic() >= deadline:
                        break
                    logger.info(
                        "Observation %s: %s (%dx%d); waiting for agent",
                        observation_seq,
                        reference,
                        screenshot.width,
                        screenshot.height,
                    )
                    pending = _background_call(
                        agent.predict,
                        {
                            "screenshot": screenshot,
                            "tool_call": None,
                            "ask_user_response": None,
                            "action_feedback": feedback,
                        },
                    )
                await asyncio.sleep(
                    min(config.poll_interval_seconds, max(0, deadline - time.monotonic()))
                )
    except TimeoutError:
        reason = "timeout"
    except Exception as exc:
        error = str(exc)
        reason = "environment_error"
    finally:
        if not log.events:
            log.append(
                "episode_start",
                {
                    "mode": "autonomous",
                    "target": config.target,
                    "seed": config.seed,
                    "timeout_seconds": config.timeout_seconds,
                    "config": config.model_dump(),
                    "browser": getattr(browser, "metadata", {}),
                },
            )
        usage = agent.get_benchmark_metrics() if hasattr(agent, "get_benchmark_metrics") else {}
        log.append("episode_end", {"reason": reason, "error": error, "agent_usage": usage})
        log.file.close()
        try:
            await browser.close()
        except Exception as exc:
            error = error or f"Browser cleanup: {exc}"
    result = evaluate_autonomous_trajectory(log.events)
    result.update(
        {
            "mode": "autonomous",
            "termination_reason": reason,
            "error": error,
            "config": config.model_dump(),
            "agent": log.events[0]["data"].get("agent", {}),
            "agent_usage": usage,
            "trajectory": "events.jsonl",
        }
    )
    (output / "result.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    )
    logger.info("Episode ended: %s; result: %s", reason, output / "result.json")
    return result
