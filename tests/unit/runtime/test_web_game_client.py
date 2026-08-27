from __future__ import annotations

import subprocess
from io import BytesIO
from typing import Any

import pytest
from PIL import Image

from mobile_world.benchmarks import GameViewportConfig, MiniGameTaskSpec
from mobile_world.runtime.utils.models import JSONAction
from mobile_world.runtime.web_game_client import (
    SIMULATION_PAUSE_SCRIPT,
    GameRect,
    WebGameEnvClient,
    compute_show_all_game_rect,
    game_state_fingerprint,
    map_screenshot_point_to_page,
    screenshot_sha256,
    visual_change_ratio,
)


def _png(
    width: int = 540,
    height: int = 960,
    color: tuple[int, int, int] = (12, 34, 56),
) -> bytes:
    output = BytesIO()
    Image.new("RGB", (width, height), color).save(output, format="PNG")
    return output.getvalue()


class FakeLocator:
    def __init__(self, box: dict[str, float]) -> None:
        self.box = box
        self.wait_calls: list[dict[str, Any]] = []

    @property
    def first(self) -> FakeLocator:
        return self

    def wait_for(self, **kwargs: Any) -> None:
        self.wait_calls.append(kwargs)

    def bounding_box(self) -> dict[str, float]:
        return dict(self.box)


class FakeMouse:
    def __init__(self) -> None:
        self.events: list[tuple[Any, ...]] = []

    def click(self, x: float, y: float, **kwargs: Any) -> None:
        self.events.append(("click", x, y, kwargs))

    def move(self, x: float, y: float) -> None:
        self.events.append(("move", x, y))

    def down(self) -> None:
        self.events.append(("down",))

    def up(self) -> None:
        self.events.append(("up",))

    def wheel(self, delta_x: float, delta_y: float) -> None:
        self.events.append(("wheel", delta_x, delta_y))


class FakePage:
    def __init__(
        self,
        box: dict[str, float] | None = None,
        screenshot_size: tuple[int, int] = (540, 960),
    ) -> None:
        self.canvas = FakeLocator(box or {"x": 100.0, "y": 50.0, "width": 800.0, "height": 1000.0})
        self.mouse = FakeMouse()
        self.screenshot_bytes = _png(*screenshot_size)
        self.screenshot_calls: list[dict[str, Any]] = []
        self.timeout_calls: list[float] = []
        self.evaluate_calls: list[tuple[str, Any]] = []
        self.state = {
            "game_id": "bolt_unscrew",
            "ready": True,
            "status": "running",
            "terminal": False,
        }

    def locator(self, selector: str) -> FakeLocator:
        assert selector == "#GameCanvas, canvas"
        return self.canvas

    def screenshot(self, **kwargs: Any) -> bytes:
        self.screenshot_calls.append(kwargs)
        return self.screenshot_bytes

    def wait_for_timeout(self, timeout: float) -> None:
        self.timeout_calls.append(timeout)

    def evaluate(self, script: str, arg: Any = None) -> Any:
        self.evaluate_calls.append((script, arg))
        if "Missing benchmark bridge" in script:
            return dict(self.state)
        return None


def _client(page: FakePage | None = None) -> tuple[WebGameEnvClient, FakePage]:
    fake_page = page or FakePage()
    client = WebGameEnvClient(
        base_url="http://example.invalid",
        step_wait_time=0,
        action_timeout_seconds=0,
        action_effect_timeout_seconds=0,
        visual_stability_timeout_seconds=0,
    )
    client._page = fake_page
    client._current_task = {"task_id": "bolt_unscrew.easy.level_01.seed_0"}
    client._current_task_id = "bolt_unscrew.easy.level_01.seed_0"
    return client, fake_page


def test_show_all_rect_removes_horizontal_canvas_letterbox() -> None:
    rect = compute_show_all_game_rect(
        {"x": 10, "y": 20, "width": 1000, "height": 1000},
        design_width=540,
        design_height=960,
    )

    assert rect == GameRect(x=228.75, y=20.0, width=562.5, height=1000.0)


def test_show_all_rect_removes_vertical_canvas_letterbox() -> None:
    rect = compute_show_all_game_rect(
        {"x": 10, "y": 20, "width": 540, "height": 1200},
        design_width=540,
        design_height=960,
    )

    assert rect == GameRect(x=10.0, y=140.0, width=540.0, height=960.0)


def test_map_uses_decoded_screenshot_size_not_device_pixel_ratio() -> None:
    # A 2x-device screenshot of a 540x960 CSS rectangle still maps its center
    # to the CSS center.
    point = map_screenshot_point_to_page(
        540,
        960,
        screenshot_size=(1080, 1920),
        game_rect=GameRect(100, 50, 540, 960),
    )

    assert point == pytest.approx((370, 530))


def test_pixel_hash_and_visual_difference_ignore_encoder_identity() -> None:
    before = Image.new("RGB", (10, 10), "black")
    same = before.copy()
    changed = before.copy()
    changed.putpixel((4, 5), (255, 255, 255))

    assert screenshot_sha256(before) == screenshot_sha256(same)
    assert visual_change_ratio(before, same) == 0
    assert visual_change_ratio(before, changed) == pytest.approx(0.01)


def test_state_fingerprint_excludes_clock_and_dispatch_counter() -> None:
    before = {"status": "running", "step_count": 1, "elapsed_time_ms": 20}
    transport_only = {"status": "running", "step_count": 2, "elapsed_time_ms": 200}
    changed = {**transport_only, "raw_game_state": {"selectedAnchorId": "a1"}}

    assert game_state_fingerprint(before) == game_state_fingerprint(transport_only)
    assert game_state_fingerprint(before) != game_state_fingerprint(changed)


def test_observe_clips_page_to_canvas_inner_game_rect_and_exposes_no_state() -> None:
    client, page = _client()

    observation = client.observe()

    assert observation.screenshot.size == (540, 960)
    assert observation.accessibility_tree is None
    assert observation.model_dump().keys() == {
        "screenshot",
        "accessibility_tree",
        "ask_user_response",
        "tool_call",
        "frame_id",
        "action_feedback",
    }
    assert "state" not in observation.model_dump()
    assert page.screenshot_calls == [
        {
            "type": "png",
            "clip": {"x": 218.75, "y": 50.0, "width": 562.5, "height": 1000.0},
            "animations": "disabled",
            "caret": "hide",
            "scale": "css",
        }
    ]


def test_headed_preview_fits_window_without_changing_agent_observation_space() -> None:
    page = FakePage(
        box={"x": 0.0, "y": 0.0, "width": 360.0, "height": 640.0},
        screenshot_size=(360, 640),
    )
    client = WebGameEnvClient(
        base_url="http://example.invalid",
        headless=False,
        viewport_width=1080,
        viewport_height=1920,
        headed_max_viewport_width=900,
        headed_max_viewport_height=640,
        step_wait_time=0,
    )
    client._page = page
    client._current_task = {"task_id": "bolt_unscrew.easy.level_01.seed_0"}

    observation = client.observe()

    assert client._browser_viewport_size() == (360, 640)
    assert observation.screenshot.size == (1080, 1920)
    assert client.get_observation_metadata()["headed_preview_scaled"] is True
    assert client._map_point(540, 960) == pytest.approx((180, 320))


def test_default_headed_preview_uses_clearer_desktop_size() -> None:
    client = WebGameEnvClient(
        base_url="http://example.invalid",
        headless=False,
        viewport_width=1080,
        viewport_height=1920,
    )

    assert client._browser_viewport_size() == (495, 880)


def test_headless_viewport_and_observation_remain_unchanged() -> None:
    page = FakePage(
        box={"x": 0.0, "y": 0.0, "width": 1080.0, "height": 1920.0},
        screenshot_size=(1080, 1920),
    )
    client = WebGameEnvClient(
        base_url="http://example.invalid",
        headless=True,
        viewport_width=1080,
        viewport_height=1920,
    )
    client._page = page
    client._current_task = {"task_id": "bolt_unscrew.easy.level_01.seed_0"}

    observation = client.observe()

    assert client._browser_viewport_size() == (1080, 1920)
    assert observation.screenshot.size == (1080, 1920)
    assert client.get_observation_metadata()["headed_preview_scaled"] is False


def test_click_double_tap_and_long_press_map_cropped_coordinates() -> None:
    client, page = _client()
    client.observe()

    client.execute_action({"action_type": "click", "x": 270, "y": 480})
    client.execute_action({"action_type": "double_tap", "x": 0, "y": 0})
    client.execute_action({"action_type": "long_press", "x": 540, "y": 960, "duration_ms": 250})

    assert page.mouse.events[0] == pytest.approx(("click", 500.0, 550.0, {}))
    double_tap = page.mouse.events[1]
    assert double_tap[:3] == pytest.approx(("click", 218.75, 50.0))
    assert double_tap[3] == {"click_count": 2, "delay": 100}
    assert page.mouse.events[2] == pytest.approx(("move", 781.25, 1050.0))
    assert page.mouse.events[3:] == [("down",), ("up",)]
    assert 250 in page.timeout_calls


def test_execute_action_reports_effect_and_aligned_post_observation() -> None:
    class ChangingPage(FakePage):
        def __init__(self) -> None:
            super().__init__()
            self.capture_count = 0

        def screenshot(self, **kwargs: Any) -> bytes:
            self.screenshot_calls.append(kwargs)
            self.capture_count += 1
            color = (12, 34, 56) if self.capture_count == 1 else (22, 44, 66)
            return _png(color=color)

    client, _ = _client(ChangingPage())
    initial = client.observe()

    after = client.execute_action({"action_type": "click", "x": 270, "y": 480})
    result = client.get_last_action_result()

    assert result is not None
    assert result["executed"] is True
    assert result["visual_changed"] is True
    assert result["state_changed"] is False
    assert result["reason"] == "screen_changed"
    assert result["pre_screenshot_sha256"] == screenshot_sha256(initial.screenshot)
    assert result["post_screenshot_sha256"] == screenshot_sha256(after.screenshot)
    assert initial.frame_id == 1
    assert after.frame_id == 2
    assert after.tool_call is None
    assert after.action_feedback is not None
    assert after.action_feedback.model_dump() == {
        "type": "gui_action_feedback",
        "action_id": "bolt_unscrew.easy.level_01.seed_0:action:0001",
        "status": "screen_changed",
        "executed": True,
        "fresh_observation": True,
        "cycle_length": None,
        "recovery_required": False,
        "message": None,
    }
    assert "state_changed" not in after.action_feedback.model_dump()


def test_execute_action_reports_no_effect_without_treating_dispatch_as_state_change() -> None:
    client, _ = _client()
    client.observe()

    observation = client.execute_action({"action_type": "click", "x": 10, "y": 20})
    result = client.get_last_action_result()

    assert result is not None
    assert result["executed"] is True
    assert result["state_changed"] is False
    assert result["visual_changed"] is False
    assert result["reason"] == "no_visible_effect"
    assert observation.tool_call is None
    assert observation.action_feedback is not None
    assert observation.action_feedback.status == "no_visible_effect"


def test_drag_generates_intermediate_pointer_trajectory() -> None:
    client, page = _client()
    client.observe()

    client.execute_action(
        {
            "action_type": "drag",
            "start_x": 0,
            "start_y": 0,
            "end_x": 540,
            "end_y": 960,
            "duration_ms": 64,
            "steps": 4,
        }
    )

    assert page.mouse.events[0] == pytest.approx(("move", 218.75, 50.0))
    assert page.mouse.events[1] == ("down",)
    trajectory = page.mouse.events[2:6]
    assert len(trajectory) == 4
    assert trajectory[-1] == pytest.approx(("move", 781.25, 1050.0))
    assert page.mouse.events[-1] == ("up",)
    assert page.timeout_calls[:4] == [16.0, 16.0, 16.0, 16.0]


def test_swipe_scroll_press_release_and_wait_map_to_browser_primitives() -> None:
    client, page = _client()
    client.observe()

    client.execute_action(
        {
            "action_type": "swipe",
            "x": 270,
            "y": 480,
            "direction": "right",
            "duration_ms": 0,
            "steps": 2,
        }
    )
    client.execute_action({"action_type": "scroll", "direction": "up", "amount": 123})
    client.execute_action({"action_type": "press", "x": 100, "y": 200})
    client.execute_action({"action_type": "release", "x": 110, "y": 210})
    client.execute_action({"action_type": "wait", "duration_ms": 77})

    assert ("wheel", 0.0, -123.0) in page.mouse.events
    assert page.mouse.events.count(("down",)) == 2  # swipe plus explicit press
    assert page.mouse.events.count(("up",)) == 2  # swipe plus explicit release
    assert 77.0 in page.timeout_calls


@pytest.mark.parametrize("action_type", ["tap", "press", "release"])
def test_web_pointer_actions_are_valid_mobileworld_json_actions(action_type: str) -> None:
    action = JSONAction(action_type=action_type, x=10, y=20)

    assert action.action_type == action_type


def test_state_is_only_read_through_evaluator_channel() -> None:
    client, page = _client()
    client.observe()
    page.state.update({"terminal": True, "success": True, "raw_game_state": {"answer": 7}})

    assert client.is_terminal() is True
    assert client.get_game_state()["raw_game_state"] == {"answer": 7}
    metadata = client.get_observation_metadata()
    assert "raw_game_state" not in metadata
    assert metadata["coordinate_space"] == "cropped_game_screenshot_pixels"


def test_terminal_state_is_latched_before_the_game_auto_advances() -> None:
    client, page = _client()
    client._current_task = {
        "task_id": "nut_and_bolt.easy.level_01.seed_0",
        "level_id": 1,
    }
    client.observe()

    page.state.update({"status": "success", "success": True, "level_id": 1})
    client.get_game_state()
    # The Cocos suite loads the next level about a second after a win, so the
    # live state stops describing the level the episode was launched for.
    page.state.update({"status": "loading", "success": False, "ready": False, "level_id": 2})

    latched = client.get_latched_terminal_state()
    assert latched is not None
    assert latched["success"] is True
    assert latched["level_id"] == 1
    assert client.get_game_state()["level_id"] == 2
    assert client.is_terminal() is True


def test_auto_advance_without_success_snapshot_is_latched_as_assigned_level_win() -> None:
    client, page = _client()
    client._current_task = {
        "task_id": "nut_and_bolt.easy.level_01.seed_0",
        "level_id": 1,
    }
    page.state.update(
        {
            "game_id": "nuts_bolts",
            "status": "running",
            "success": False,
            "level_id": 1,
            "raw_metrics": {"currentProgressRatio": 0.75},
        }
    )
    client.get_game_state()
    page.state.update(
        {
            "game_id": "nuts_bolts",
            "status": "loading",
            "success": False,
            "complete": False,
            "ready": False,
            "level_id": 2,
            "capacity": 3,
        }
    )

    live = client.get_game_state()
    latched = client.get_latched_terminal_state()

    assert live["level_id"] == 2
    assert latched is not None
    assert latched["success"] is True
    assert latched["status"] == "success"
    assert latched["level_id"] == 1
    assert latched["raw_metrics"]["currentProgressRatio"] == 0.75
    assert client.is_terminal() is True


def test_terminal_latch_is_cleared_between_episodes() -> None:
    client, page = _client()
    client.observe()
    page.state.update({"status": "success", "success": True})
    client.get_game_state()

    client.tear_down()

    assert client.get_latched_terminal_state() is None


def test_task_url_uses_stable_direct_launch_query_contract() -> None:
    client = WebGameEnvClient(base_url="http://127.0.0.1:8765/game?existing=yes")
    task = {
        "game_id": "bolt_unscrew",
        "difficulty": "hard",
        "level_id": 3,
        "seed": 11,
        "launch_parameters": {"mode": "visual"},
        "launch": {"query": {"feature": "benchmark"}},
    }

    assert client._task_url(task) == (
        "http://127.0.0.1:8765/game?existing=yes&benchmark=1&game_id=bolt_unscrew"
        "&difficulty=hard&level_id=3&seed=11&mode=visual&feature=benchmark"
    )


def test_task_viewport_overrides_selector_and_design_resolution() -> None:
    client = WebGameEnvClient(
        base_url="http://127.0.0.1:8765",
        per_game_viewport_selectors={"wide_game": "#wide-canvas"},
    )
    client._current_task = MiniGameTaskSpec(
        game_id="wide_game",
        difficulty="easy",
        level_id=1,
        instruction="Complete the visible game.",
        viewport=GameViewportConfig(design_width=1280, design_height=720),
    )

    assert client._viewport_settings() == ("#wide-canvas", 1280, 720)


def test_cocos_nonzero_exit_is_accepted_only_with_fresh_artifact(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "project"
    build = project / "build" / "web-mobile"
    project.mkdir()

    def completed_build(*args: Any, **kwargs: Any) -> None:
        build.mkdir(parents=True)
        (build / "index.html").write_text("fresh", encoding="utf-8")
        raise subprocess.CalledProcessError(36, args[0])

    monkeypatch.setattr(subprocess, "run", completed_build)
    client = WebGameEnvClient(
        project_path=project,
        build_dir=build,
        cocos_executable="CocosCreator",
    )

    client._run_build()
    assert (build / "index.html").read_text(encoding="utf-8") == "fresh"


def test_cocos_build_removes_electron_run_as_node(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "project"
    build = project / "build" / "web-mobile"
    project.mkdir()
    monkeypatch.setenv("ELECTRON_RUN_AS_NODE", "1")
    captured_environment: dict[str, str] = {}

    def completed_build(*args: Any, **kwargs: Any) -> None:
        captured_environment.update(kwargs["env"])
        build.mkdir(parents=True)
        (build / "index.html").write_text("fresh", encoding="utf-8")

    monkeypatch.setattr(subprocess, "run", completed_build)
    client = WebGameEnvClient(
        project_path=project,
        build_dir=build,
        cocos_executable="CocosCreator",
    )

    client._run_build()

    assert "ELECTRON_RUN_AS_NODE" not in captured_environment


def test_pause_and_resume_simulation_are_best_effort() -> None:
    page = FakePage()

    def evaluate(script: str, arg: Any = None) -> Any:
        page.evaluate_calls.append((script, arg))
        assert script == SIMULATION_PAUSE_SCRIPT
        return {
            "applied": True,
            "via": "clock+bridge",
            "paused": arg["paused"],
            "clock": True,
            "bridge": True,
            "cocos": False,
        }

    page.evaluate = evaluate
    client, _ = _client(page)

    paused = client.pause_simulation()
    resumed = client.resume_simulation()

    assert paused["applied"] is True
    assert paused["via"] == "clock+bridge"
    assert paused["clock"] is True
    assert resumed["applied"] is True
    assert resumed["paused"] is False
    assert client._simulation_paused is False
    assert [call[1]["paused"] for call in page.evaluate_calls] == [True, False]


def test_pause_script_freezes_page_clocks_in_browser() -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        pytest.skip(f"Playwright is unavailable: {exc}")

    try:
        with sync_playwright() as playwright:
            path = playwright.chromium.executable_path
            if not path:
                pytest.skip("Playwright Chromium is unavailable")
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page()
            try:
                page.evaluate(SIMULATION_PAUSE_SCRIPT, {"name": "__unused__", "paused": True})
                before = page.evaluate("() => ({date: Date.now(), perf: performance.now()})")
                page.wait_for_timeout(250)
                during = page.evaluate("() => ({date: Date.now(), perf: performance.now()})")
                page.evaluate(SIMULATION_PAUSE_SCRIPT, {"name": "__unused__", "paused": False})
                page.wait_for_timeout(250)
                after = page.evaluate("() => ({date: Date.now(), perf: performance.now()})")
            finally:
                browser.close()
    except Exception as exc:
        pytest.skip(f"Playwright Chromium could not launch: {exc}")

    assert during["date"] - before["date"] < 40
    assert during["perf"] - before["perf"] < 40
    assert after["date"] - before["date"] >= 200
    assert after["perf"] - before["perf"] >= 200
