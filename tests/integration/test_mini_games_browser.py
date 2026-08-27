"""Real Playwright/Cocos smoke coverage for the mini-games adapter."""

from __future__ import annotations

import json
import os
import threading
from argparse import Namespace
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from mobile_world.agents.base import BaseAgent
from mobile_world.benchmarks import MiniGameEvaluator, ResultWriter, load_catalog, mini_games_runner
from mobile_world.benchmarks.mini_games_runner import _execute_episode
from mobile_world.runtime.utils.models import (
    CLICK,
    DRAG,
    PRESS,
    RELEASE,
    SWIPE,
    WAIT,
    JSONAction,
)
from mobile_world.runtime.utils.trajectory_logger import TrajLogger
from mobile_world.runtime.web_game_client import WebGameEnvClient

DEFAULT_PROJECT = Path(__file__).resolve().parents[2] / "games" / "puzzle_suite"


def _game_project() -> Path:
    return Path(os.getenv("LONGPUZZLEBENCH_GAME_PROJECT", DEFAULT_PROJECT)).expanduser()


def _require_playwright_chromium() -> None:
    """Skip browser integration tests when Chromium is not installed."""

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        pytest.skip(f"Playwright is unavailable: {exc}")
    try:
        with sync_playwright() as playwright:
            path = playwright.chromium.executable_path
            if not path or not Path(path).exists():
                pytest.skip(
                    "Playwright browser executable is unavailable. "
                    "Run `playwright install chromium`."
                )
    except Exception as exc:  # pragma: no cover - environment dependent
        message = str(exc)
        if "Executable doesn't exist" in message or "executable" in message.lower():
            pytest.skip(
                "Playwright browser executable is unavailable. Run `playwright install chromium`."
            )
        raise


@pytest.mark.integration
def test_real_bolt_episode_crop_actions_evaluator_results_and_reset(tmp_path: Path) -> None:
    project = _game_project()
    build_directory = project / "build" / "web-mobile"
    if not (build_directory / "index.html").is_file():
        pytest.skip(f"Cocos web build is unavailable: {build_directory}")

    catalog = load_catalog("configs/longpuzzlebench.json")
    task = catalog.get_task("bolt_unscrew.easy.level_01.seed_0")
    evaluator = MiniGameEvaluator()
    env = WebGameEnvClient(
        project_path=project,
        build_directory=build_directory,
        auto_build=False,
        task_catalog=catalog,
        evaluator=evaluator,
        viewport_width=1000,
        viewport_height=1000,
        step_wait_time=0.05,
    )
    try:
        try:
            env.start()
        except RuntimeError as exc:
            if "Playwright browser executable is unavailable" in str(exc):
                pytest.skip(str(exc))
            raise

        observation = env.initialize_task(task)
        width, height = observation.screenshot.size
        state = env.get_game_state()

        # A square browser viewport forces SHOW_ALL letterboxing.  The adapter
        # must remove it and expose exactly the 540:960 game aspect ratio.
        assert width / height == pytest.approx(540 / 960, abs=0.002)
        assert state["ready"] is True
        assert state["deadlock"] == {
            "is_deadlocked": False,
            "deadlock_reason": None,
            "available_hole_count": 1,
            "legal_progress_action_count": 1,
            "pending_operation_count": 0,
            "game_state_stable": True,
            "awaiting_operation_settlement": False,
        }
        assert state["raw_game_state"]["deadlock"]["availableHoleCount"] == 1
        assert (state["game_id"], state["difficulty"], state["level_id"], state["seed"]) == (
            "bolt_unscrew",
            "easy",
            1,
            0,
        )
        public_observation = observation.model_dump()
        assert set(public_observation) == {
            "screenshot",
            "accessibility_tree",
            "ask_user_response",
            "tool_call",
            "frame_id",
            "action_feedback",
        }
        assert all("state" not in key and "metric" not in key for key in public_observation)
        initial_anchors = state["raw_game_state"]["anchors"]
        source_anchor = min(
            (anchor for anchor in initial_anchors if anchor["hasBolt"]),
            key=lambda anchor: (anchor["x"] - 270) ** 2 + (anchor["y"] - 420) ** 2,
        )
        assert source_anchor["boltVisualY"] == pytest.approx(source_anchor["y"], abs=0.5)
        observation.screenshot.save(tmp_path / "bolt-unselected-crop.png")

        no_effect = env.execute_action(
            JSONAction(
                action_type=CLICK,
                x=round(80 * width / 540),
                y=round(700 * height / 960),
            )
        )
        no_effect_result = env.get_last_action_result()
        assert no_effect_result is not None
        assert no_effect_result["executed"] is True
        assert no_effect_result["state_changed"] is False
        assert no_effect_result["visual_changed"] is False
        assert no_effect.tool_call is None
        assert no_effect.action_feedback is not None
        assert no_effect.action_feedback.status == "no_visible_effect"
        assert "state_changed" not in no_effect.action_feedback.model_dump()

        def click(design_x: int, design_y: int) -> None:
            env.execute_action(
                JSONAction(
                    action_type=CLICK,
                    x=round(design_x * width / 540),
                    y=round(design_y * height / 960),
                )
            )

        selected_observation = env.execute_action(
            JSONAction(
                action_type=CLICK,
                x=round(source_anchor["x"] * width / 540),
                y=round(source_anchor["y"] * height / 960),
            )
        )
        selected_result = env.get_last_action_result()
        assert selected_result is not None
        assert selected_result["state_changed"] is True
        assert selected_result["visual_changed"] is True
        assert selected_result["synchronization"]["effect_observed"] is True
        selected_state = env.get_game_state()
        selected = next(
            anchor
            for anchor in selected_state["raw_game_state"]["anchors"]
            if anchor["id"] == source_anchor["id"]
        )
        assert selected_state["raw_game_state"]["selectedAnchorId"] == source_anchor["id"]
        assert selected_state["deadlock"]["is_deadlocked"] is False
        assert selected_state["deadlock"]["pending_operation_count"] == 0
        assert selected_state["deadlock"]["game_state_stable"] is True
        assert selected["y"] == pytest.approx(source_anchor["y"], abs=0.5)
        assert selected["boltVisualY"] == pytest.approx(source_anchor["y"] - 26, abs=0.8)
        selected_observation.screenshot.save(tmp_path / "bolt-selected-crop.png")

        # Cancel and re-select: both targets are computed from the immutable
        # baseline, so interrupted/repeated interactions cannot accumulate lift.
        click(source_anchor["x"], source_anchor["y"])
        env.execute_action(JSONAction(action_type=WAIT, action_json={"duration_ms": 260}))
        restored = next(
            anchor
            for anchor in env.get_game_state()["raw_game_state"]["anchors"]
            if anchor["id"] == source_anchor["id"]
        )
        assert restored["boltVisualY"] == pytest.approx(source_anchor["y"], abs=0.8)
        click(source_anchor["x"], source_anchor["y"])
        env.execute_action(JSONAction(action_type=WAIT, action_json={"duration_ms": 260}))
        reselected = next(
            anchor
            for anchor in env.get_game_state()["raw_game_state"]["anchors"]
            if anchor["id"] == source_anchor["id"]
        )
        assert reselected["boltVisualY"] == pytest.approx(source_anchor["y"] - 26, abs=0.8)

        # Restart destroys all visual tweens/nodes and rebuilds baseline state.
        click(470, 34)
        env.execute_action(JSONAction(action_type=WAIT, action_json={"duration_ms": 300}))
        restarted_state = env.get_game_state()["raw_game_state"]
        assert restarted_state["selectedAnchorId"] is None
        assert all(
            anchor["boltVisualY"] == pytest.approx(anchor["y"], abs=0.8)
            for anchor in restarted_state["anchors"]
            if anchor["hasBolt"]
        )

        click(source_anchor["x"], source_anchor["y"])
        click(400, 230)
        env.execute_action(JSONAction(action_type=WAIT, action_json={"duration": 2.0}))

        assert env.is_terminal() is True
        terminal_state = env.get_game_state()
        result = evaluator.evaluate(terminal_state, task, steps=3, elapsed=2.0)
        assert result.task_success is True
        assert 0.6 <= result.normalized_score <= 1.0
        assert result.overall_score == pytest.approx(result.normalized_score * 100)
        assert result.breakdown.success_score == 60.0
        assert result.raw_metrics["boards_exited"] == 1
        assert terminal_state["raw_game_state"]["selectedAnchorId"] is None

        writer = ResultWriter(tmp_path / "results")
        writer.write_episode(result)
        report_files = writer.finalize()
        assert all(path.is_file() for path in report_files.values())

        # A new browser context must reset both Cocos and benchmark bridge
        # state so repeated episodes cannot inherit completion.
        env.tear_down_task(task.task_id)
        second_observation = env.initialize_task(task)
        second_state = env.get_game_state()
        assert second_observation.screenshot.size == (width, height)
        assert second_state["status"] == "running"
        assert second_state["step_count"] == 0
        assert second_state["success"] is False

        # Level 2 has two occupied screws, so it also locks the switch-selection
        # contract without altering either anchor's logical coordinates.
        env.tear_down_task(task.task_id)
        level_two = catalog.get_task("bolt_unscrew.easy.level_02.seed_0")
        env.initialize_task(level_two)
        occupied = [
            anchor
            for anchor in env.get_game_state()["raw_game_state"]["anchors"]
            if anchor["hasBolt"]
        ]
        assert len(occupied) >= 2
        click(occupied[0]["x"], occupied[0]["y"])
        click(occupied[1]["x"], occupied[1]["y"])
        env.execute_action(JSONAction(action_type=WAIT, action_json={"duration_ms": 260}))
        switched = {
            anchor["id"]: anchor for anchor in env.get_game_state()["raw_game_state"]["anchors"]
        }
        assert switched[occupied[0]["id"]]["boltVisualY"] == pytest.approx(
            occupied[0]["y"], abs=0.8
        )
        assert switched[occupied[1]["id"]]["boltVisualY"] == pytest.approx(
            occupied[1]["y"] - 26, abs=0.8
        )
    finally:
        env.close()


@contextmanager
def _serve_deadlock_fixture(root: Path):
    class QuietHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(root), **kwargs)

        def log_message(self, format, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class _OneClickAgent(BaseAgent):
    def __init__(self) -> None:
        super().__init__()
        self.predict_calls = 0

    def predict(self, observation: dict[str, Any]) -> tuple[str, JSONAction]:
        self.predict_calls += 1
        width, height = observation["screenshot"].size
        return "click once", JSONAction(action_type=CLICK, x=width // 2, y=height // 2)

    def reset(self) -> None:
        pass


@pytest.mark.integration
def test_browser_deadlock_stops_model_and_strict_benchmark_before_level_three(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _require_playwright_chromium()
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    (fixture / "index.html").write_text(
        """<!doctype html><html><body style='margin:0'>
        <canvas id='GameCanvas' width='540' height='960'></canvas>
        <script>
        const params = new URLSearchParams(location.search);
        const level = Number(params.get('level_id') || 1);
        const difficulty = params.get('difficulty') || 'easy';
        const seed = Number(params.get('seed') || 0);
        let steps = 0;
        let success = false;
        let deadlocked = false;
        const canvas = document.getElementById('GameCanvas');
        const context = canvas.getContext('2d');
        context.fillStyle = '#654321'; context.fillRect(0, 0, 540, 960);
        canvas.addEventListener('click', () => {
          steps += 1;
          if (level === 1) success = true;
          if (level === 2) deadlocked = true;
        });
        const getState = () => ({
          schema_version: 1,
          game_id: 'bolt_unscrew', difficulty, level_id: level, seed,
          ready: true,
          status: success ? 'success' : 'running',
          success, failure: false, terminal: success,
          step_count: steps, elapsed_time_ms: 0,
          raw_metrics: {boards_total: 1, boards_exited: success ? 1 : 0},
          raw_game_state: {},
          deadlock: {
            is_deadlocked: deadlocked,
            deadlock_reason: deadlocked ? 'no_available_hole' : null,
            available_hole_count: deadlocked ? 0 : 1,
            legal_progress_action_count: deadlocked ? 0 : 1,
            pending_operation_count: 0,
            game_state_stable: true,
            awaiting_operation_settlement: false
          }
        });
        globalThis.__game = {waitForStable: async () => ({ok: true})};
        globalThis.__MINIGAME_BENCHMARK__ = {
          getState,
          waitForReady: async () => ({ok: true, state: getState()}),
          waitForPostActionState: async () => ({ok: true, state: getState(), required: false})
        };
        </script></body></html>""",
        encoding="utf-8",
    )
    catalog = load_catalog("configs/longpuzzlebench.json")
    agents: list[_OneClickAgent] = []

    with _serve_deadlock_fixture(fixture) as base_url:
        env = WebGameEnvClient(
            base_url=base_url,
            task_catalog=catalog,
            evaluator=MiniGameEvaluator(),
            viewport_width=540,
            viewport_height=960,
            game_viewport_selector="#GameCanvas",
            step_wait_time=0,
            action_effect_timeout_seconds=0.05,
            visual_stability_timeout_seconds=0.01,
        )
        monkeypatch.setattr(mini_games_runner, "_make_environment", lambda *args: env)

        def make_agent(args, environment, **kwargs):
            agent = _OneClickAgent()
            agents.append(agent)
            return agent

        monkeypatch.setattr(mini_games_runner, "_make_agent", make_agent)
        monkeypatch.setattr(mini_games_runner, "_print_summary", lambda *args: None)
        output = tmp_path / "results"
        args = Namespace(
            config="configs/longpuzzlebench.json",
            task=None,
            game="bolt_unscrew",
            difficulty="easy",
            level=None,
            all_levels=False,
            debug_level="1,2,3",
            debug_task=None,
            seeds=None,
            max_round=5,
            timeout=10,
            agent_type="one-click",
            model_name=None,
            num_runs=1,
            output=str(output),
            log_file_root=None,
            dry_run=False,
            base_url=base_url,
            game_project=None,
            skip_build=True,
            headed=False,
            headed_viewport_width=None,
            headed_viewport_height=None,
            step_wait_time=0,
            prompt_setting=None,
            context_setting=None,
            eval_mode=None,
            history_turns=None,
            history_n_images=None,
        )

        report = mini_games_runner.run_mini_games_benchmark(args)

    assert [agent.predict_calls for agent in agents] == [1, 1]
    assert report["benchmark_status"] == "terminated"
    assert report["termination_reason"] == "no_available_hole_deadlock"
    assert report["completed_tasks"] == 1
    assert report["failed_tasks"] == 1
    assert report["executed_tasks"] == 2
    assert report["remaining_tasks"] == 1
    assert report["not_run_tasks"][0]["task_id"].endswith("level_03.seed_0")
    assert env._browser is None

    episodes = [json.loads(line) for line in (output / "episodes.jsonl").read_text().splitlines()]
    summary = json.loads((output / "summary.json").read_text())
    assert [episode["termination_reason"] for episode in episodes] == [
        "success",
        "no_available_hole_deadlock",
    ]
    assert episodes[1]["deadlock"]["detected_at_step"] == 1
    assert episodes[1]["trajectory"][-1]["deadlock"]["detected_at_step"] == 1
    assert summary["overall"]["score_denominator"] == 3
    expected_score = sum(episode["normalized_score"] for episode in episodes) / 3
    assert summary["overall"]["average_normalized_score"] == pytest.approx(expected_score)
    difficulty = json.loads((output / "difficulty_results.json").read_text())["entries"][0]
    assert difficulty["success_rate"] == pytest.approx(1 / 3)
    assert difficulty["overall_score"] == pytest.approx(expected_score * 100)
    assert difficulty["termination_reasons"] == {
        "no_available_hole_deadlock": 1,
        "not_run": 1,
        "success": 1,
    }


class _RepeatingBoltAgent(BaseAgent):
    def __init__(self) -> None:
        super().__init__()
        self.feedback: list[dict[str, Any]] = []

    def predict(self, observation: dict[str, Any]) -> tuple[str, JSONAction]:
        if observation.get("action_feedback") is not None:
            self.feedback.append(observation["action_feedback"])
        width, height = observation["screenshot"].size
        return (
            "repeat the same screw click",
            JSONAction(
                action_type=CLICK,
                x=round(270 * width / 540),
                y=round(420 * height / 960),
            ),
        )

    def reset(self) -> None:
        pass


@pytest.mark.integration
def test_real_bolt_repeated_cycle_gets_recovery_feedback_and_bounded_termination(
    tmp_path: Path,
) -> None:
    project = _game_project()
    build_directory = project / "build" / "web-mobile"
    if not (build_directory / "index.html").is_file():
        pytest.skip(f"Cocos web build is unavailable: {build_directory}")

    catalog = load_catalog("configs/longpuzzlebench.json")
    task = catalog.get_task("bolt_unscrew.easy.level_01.seed_0").model_copy(
        update={"max_steps": 10, "timeout_seconds": 30.0}
    )
    evaluator = MiniGameEvaluator()
    env = WebGameEnvClient(
        project_path=project,
        build_directory=build_directory,
        auto_build=False,
        task_catalog=catalog,
        evaluator=evaluator,
        viewport_width=540,
        viewport_height=960,
        step_wait_time=0.01,
        action_effect_timeout_seconds=0.1,
        visual_stability_timeout_seconds=0.05,
    )
    agent = _RepeatingBoltAgent()
    logger = TrajLogger(str(tmp_path / "trajectory"), task.task_id)
    try:
        try:
            env.start()
        except RuntimeError as exc:
            if "Playwright browser executable is unavailable" in str(exc):
                pytest.skip(str(exc))
            raise

        result = _execute_episode(
            env=env,
            evaluator=evaluator,
            task=task,
            agent=agent,
            traj_logger=logger,
            agent_information={"name": "repeating-regression-agent"},
            run_index=1,
            no_progress_recovery_steps=2,
            no_progress_termination_steps=4,
            no_progress_max_cycle_length=4,
        )

        assert result.episode_status == "repeated_action_cycle"
        assert result.termination_reason == "repeated_action_cycle"
        assert result.step_count <= 8
        assert any(feedback.get("recovery_required") for feedback in agent.feedback)
        assert [step["executed_action"] for step in result.trajectory] == [
            step["parsed_action"] for step in result.trajectory
        ]
        assert any(step["no_progress"]["recovery_required"] for step in result.trajectory)
        assert result.trajectory[-1]["no_progress"]["terminate"] is True
        assert result.trajectory[-1]["cycle_detection"]["cycle_repetitions"] >= 3
        assert result.trajectory[-1]["episode_termination_reason"] == ("repeated_action_cycle")

        trajectory = json.loads((Path(logger.log_file_dir) / "traj.json").read_text())
        logged_steps = trajectory["0"]["traj"]
        assert len(logged_steps) == result.step_count
        assert all("pre_observation" in step for step in logged_steps)
        assert all("post_observation" in step for step in logged_steps)
        assert all(step["executed_action"] == step["parsed_action"] for step in logged_steps)
        assert logged_steps[-1]["execution_result"]["no_progress"]["terminate"] is True
        assert trajectory["termination"]["reason"] == "repeated_action_cycle"
    finally:
        env.close()


@pytest.mark.integration
def test_real_repeated_cycle_stops_strict_benchmark_before_level_two(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _require_playwright_chromium()
    project = _game_project()
    build_directory = project / "build" / "web-mobile"
    if not (build_directory / "index.html").is_file():
        pytest.skip(f"Cocos web build is unavailable: {build_directory}")

    monkeypatch.setattr(
        mini_games_runner,
        "_make_agent",
        lambda args, env, **kwargs: _RepeatingBoltAgent(),
    )
    args = Namespace(
        config="configs/longpuzzlebench.json",
        task=None,
        game="bolt_unscrew",
        difficulty="easy",
        level=None,
        all_levels=False,
        debug_level="1,2",
        debug_task=None,
        seeds=None,
        max_round=10,
        timeout=30,
        agent_type="repeating-regression-agent",
        model_name=None,
        num_runs=1,
        output=str(tmp_path / "strict-results"),
        log_file_root=None,
        dry_run=False,
        base_url=None,
        game_project=str(project),
        skip_build=True,
        headed=False,
        headed_viewport_width=None,
        headed_viewport_height=None,
        step_wait_time=0.01,
        prompt_setting=None,
        context_setting=None,
        eval_mode=None,
        history_turns=None,
        history_n_images=None,
    )

    report = mini_games_runner.run_mini_games_benchmark(args)

    assert report["benchmark_status"] == "terminated"
    assert report["termination_reason"] == "repeated_action_cycle"
    assert report["failed_task_id"] == "bolt_unscrew.easy.level_01.seed_0"
    assert report["executed_tasks"] == 1
    assert report["remaining_tasks"] == 1
    assert report["not_run_tasks"] == [
        {
            "run_index": 1,
            "task_id": "bolt_unscrew.easy.level_02.seed_0",
            "game_id": "bolt_unscrew",
            "difficulty": "easy",
            "level_id": 2,
            "seed": 0,
            "status": "not_run",
            "prompt_setting": "full",
            "eval_mode": "progressive",
        }
    ]
    episodes = (tmp_path / "strict-results" / "episodes.jsonl").read_text().splitlines()
    summary = json.loads((tmp_path / "strict-results" / "summary.json").read_text())
    assert len(episodes) == 1
    assert summary["overall"]["score_denominator"] == 2
    assert summary["overall"]["not_run_count"] == 1
    assert summary["benchmark"]["remaining_tasks"] == 1


@pytest.mark.integration
def test_real_truck_escape_2_drag_sequence_uses_cropped_coordinates() -> None:
    project = _game_project()
    build_directory = project / "build" / "web-mobile"
    if not (build_directory / "index.html").is_file():
        pytest.skip(f"Cocos web build is unavailable: {build_directory}")

    catalog = load_catalog("configs/longpuzzlebench.json")
    task = catalog.get_task("truck_escape_2.easy.level_01.seed_0")
    evaluator = MiniGameEvaluator()
    env = WebGameEnvClient(
        project_path=project,
        build_directory=build_directory,
        auto_build=False,
        task_catalog=catalog,
        evaluator=evaluator,
        viewport_width=540,
        viewport_height=960,
        step_wait_time=0.05,
    )
    moves = (
        ((270, 237), (180, 237)),
        ((315, 327), (135, 327)),
        ((360, 462), (360, 282)),
        ((225, 417), (405, 417)),
    )
    try:
        try:
            env.start()
        except RuntimeError as exc:
            if "Playwright browser executable is unavailable" in str(exc):
                pytest.skip(str(exc))
            raise
        observation = env.initialize_task(task)
        width, height = observation.screenshot.size

        for (start_x, start_y), (end_x, end_y) in moves:
            env.execute_action(
                JSONAction(
                    action_type=DRAG,
                    start_x=round(start_x * width / 540),
                    start_y=round(start_y * height / 960),
                    end_x=round(end_x * width / 540),
                    end_y=round(end_y * height / 960),
                    action_json={"steps": 12, "duration_ms": 200},
                )
            )
            env.execute_action(JSONAction(action_type=WAIT, action_json={"duration_ms": 220}))

        state = env.get_game_state()
        result = evaluator.evaluate(state, task, steps=8, elapsed=2.0)
        assert state["status"] == "success"
        assert result.task_success is True
        assert result.raw_metrics["acceptedMoves"] == 4
        assert result.invalid_action_count == 0
        assert result.normalized_score > 0.9
    finally:
        env.close()


@pytest.mark.integration
def test_real_nut_and_bolt_bridge_uses_progress_aware_scoring() -> None:
    """Nut and Bolt failures can earn partial credit from completed color groups."""

    project = _game_project()
    build_directory = project / "build" / "web-mobile"
    if not (build_directory / "index.html").is_file():
        pytest.skip(f"Cocos web build is unavailable: {build_directory}")

    catalog = load_catalog("configs/longpuzzlebench.json")
    task = catalog.get_task("nut_and_bolt.easy.level_01.seed_0")
    assert task.scoring_config is not None
    assert task.scoring_config.mode == "composite"
    evaluator = MiniGameEvaluator()
    env = WebGameEnvClient(
        project_path=project,
        build_directory=build_directory,
        auto_build=False,
        task_catalog=catalog,
        evaluator=evaluator,
        viewport_width=540,
        viewport_height=960,
        step_wait_time=0.01,
    )
    try:
        try:
            env.start()
        except RuntimeError as exc:
            if "Playwright browser executable is unavailable" in str(exc):
                pytest.skip(str(exc))
            raise
        env.initialize_task(task)
        state = env.get_game_state()
        result = evaluator.evaluate(
            state,
            task,
            steps=0,
            elapsed=0,
            max_step_reached=True,
        )

        assert state["ready"] is True
        assert state["game_id"] == "nuts_bolts"
        assert result.task.game_id == "nut_and_bolt"
        assert result.task_success is False
        assert 0 <= result.overall_score < 60
        assert result.breakdown.progress_score == 0
        assert result.breakdown.normalized_metrics["progress"] == 0
        assert result.termination_reason == "max_steps"
        assert "move_count" in result.raw_metrics  # preserved for audit
        assert result.scoring_version == "1.3"
    finally:
        env.close()


@pytest.mark.integration
def test_new_games_actions_metrics_termination_and_serialization() -> None:
    """Exercise every newly registered game through the shared browser contract."""

    project = _game_project()
    build_directory = project / "build" / "web-mobile"
    if not (build_directory / "index.html").is_file():
        pytest.skip(f"Cocos web build is unavailable: {build_directory}")

    catalog = load_catalog("configs/longpuzzlebench.json")
    evaluator = MiniGameEvaluator()
    env = WebGameEnvClient(
        project_path=project,
        build_directory=build_directory,
        auto_build=False,
        task_catalog=catalog,
        evaluator=evaluator,
        viewport_width=540,
        viewport_height=960,
        step_wait_time=0.05,
    )
    task_cases = (
        ("truck_escape.default.level_01.seed_0", "truck"),
        ("maze_paint.easy.level_01.seed_0", "maze"),
        ("color_connect.easy.level_01.seed_0", "color"),
    )
    try:
        env.start()
        for task_id, exercise in task_cases:
            task = catalog.get_task(task_id)
            observation = env.initialize_task(task)
            initial_state = env.get_game_state()
            initial_result = evaluator.evaluate(
                initial_state,
                task,
                steps=0,
                elapsed=0.0,
            )
            initial_progress = initial_result.breakdown.normalized_metrics["progress"]
            steps = 0

            if exercise == "truck":
                # Probe grid-cell centers until the first removable generated
                # truck is hit, without coupling this test to its exact position.
                truck_removed = False
                for row in range(6):
                    for col in range(6):
                        env.execute_action(
                            JSONAction(
                                action_type=CLICK,
                                x=round(30 + (col + 0.5) * 80),
                                y=round(240 + (row + 0.5) * 80),
                            )
                        )
                        steps += 1
                        truck_removed = env.get_game_state()["raw_metrics"]["trucks_removed"] > 0
                        if truck_removed:
                            break
                    if truck_removed:
                        break
                assert truck_removed
            elif exercise == "maze":
                # Easy level 1 opens to the right of the starting cell.
                env.execute_action(
                    JSONAction(
                        action_type=SWIPE,
                        x=200,
                        y=529,
                        end_x=400,
                        end_y=529,
                    )
                )
                steps += 1
            else:
                # Connect the orange pair on the 6x6 board, including one turn.
                for x, y in ((53, 241), (227, 241), (227, 501)):
                    env.execute_action(JSONAction(action_type=PRESS, x=x, y=y))
                    steps += 1
                env.execute_action(JSONAction(action_type=RELEASE, x=227, y=501))
                steps += 1

            updated_state = env.get_game_state()
            result = evaluator.evaluate(
                updated_state,
                task,
                steps=steps,
                elapsed=0.0,
                max_step_reached=True,
            )
            serialized = result.to_dict()

            assert observation.screenshot.size == (540, 960)
            assert updated_state["ready"] is True
            assert serialized["task"]["task_id"] == task_id
            assert serialized["step_count"] == steps
            assert initial_progress < serialized["normalized_metrics"]["progress"] <= 1
            assert 0 <= serialized["normalized_score"] <= 1
            assert serialized["termination_reason"] == "max_steps"
            env.tear_down()
    finally:
        env.close()
