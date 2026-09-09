from __future__ import annotations

import asyncio
from io import BytesIO
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from mobile_world.runtime.autonomous_browser import (
    AutonomousBrowser,
    _MacDesktopBackend,
    _select_display,
)


def _png(width: int = 1280, height: int = 900) -> bytes:
    output = BytesIO()
    Image.new("RGB", (width, height), (20, 40, 60)).save(output, "PNG")
    return output.getvalue()


class FakeMouse:
    def __init__(self) -> None:
        self.events: list[tuple[Any, ...]] = []

    async def click(self, x: float, y: float, **kwargs: Any) -> None:
        self.events.append(("click", x, y, kwargs))

    async def move(self, x: float, y: float, **kwargs: Any) -> None:
        self.events.append(("move", x, y, kwargs))

    async def down(self) -> None:
        self.events.append(("down",))

    async def up(self) -> None:
        self.events.append(("up",))

    async def wheel(self, x: float, y: float) -> None:
        self.events.append(("wheel", x, y))


class FakeKeyboard:
    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []

    async def press(self, key: str) -> None:
        self.events.append(("press", key))

    async def insert_text(self, text: str) -> None:
        self.events.append(("text", text))


class FakePage:
    def __init__(self) -> None:
        self.mouse = FakeMouse()
        self.keyboard = FakeKeyboard()
        self.url = "about:blank"
        self.goto_calls: list[tuple[str, dict[str, Any]]] = []
        self.screenshot_calls: list[dict[str, Any]] = []
        self.wait_script: str | None = None
        self.default_timeout: float | None = None
        self.go_back_calls = 0
        self.bring_to_front_calls = 0
        self.visibility = "visible"
        self.closed = False
        self.snapshot_error: Exception | None = None
        self.snapshot: dict[str, Any] | None = {
            "schema_version": 1,
            "mode": "autonomous",
            "lifecycle": "completed",
            "page": "game",
            "active_game": {
                "slug": "example",
                "game_id": "example",
                "difficulty": "easy",
                "level_id": 2,
            },
            "attempt_id": "attempt-2",
            "attempt_count": 2,
            "grader_state": {"status": "success", "terminal": True, "trajectory": [1, 2]},
        }

    def set_default_timeout(self, value: float) -> None:
        self.default_timeout = value

    async def goto(self, url: str, **kwargs: Any) -> None:
        self.url = url
        self.goto_calls.append((url, kwargs))

    async def wait_for_function(self, script: str, **kwargs: Any) -> None:
        del kwargs
        self.wait_script = script

    async def screenshot(self, **kwargs: Any) -> bytes:
        self.screenshot_calls.append(kwargs)
        return _png()

    async def evaluate(self, script: str, after: int | None = None) -> Any:
        if "document.visibilityState" in script:
            return self.visibility
        if "navigator.userAgent" in script:
            return {
                "user_agent": "FakeBrowser/1.0",
                "inner_width": 1280,
                "inner_height": 900,
                "outer_width": 1280,
                "outer_height": 980,
                "screen_x": 0,
                "screen_y": 0,
                "device_pixel_ratio": 1,
            }
        assert "getSnapshot" in script
        assert after == 0
        if self.snapshot_error is not None:
            error, self.snapshot_error = self.snapshot_error, None
            raise error
        if self.snapshot is None:
            return None
        return {
            "snapshot": self.snapshot,
            "events": [{"sequence": 1, "event_type": "completion"}],
        }

    async def go_back(self, **kwargs: Any) -> None:
        del kwargs
        self.go_back_calls += 1

    async def bring_to_front(self) -> None:
        self.bring_to_front_calls += 1

    def is_closed(self) -> bool:
        return self.closed


class FakeContext:
    def __init__(self, page: FakePage) -> None:
        self.page = page
        self.pages = [page]
        self.closed = False
        self.listeners: dict[str, Any] = {}
        self.cdp = FakeCDPSession()

    def on(self, event: str, callback: Any) -> None:
        self.listeners[event] = callback

    async def new_cdp_session(self, page: FakePage) -> FakeCDPSession:
        assert page is self.page
        return self.cdp

    async def new_page(self) -> FakePage:
        return self.page

    async def close(self) -> None:
        self.closed = True


class FakeBrowser:
    def __init__(self, page: FakePage) -> None:
        self.context = FakeContext(page)
        self.context_options: dict[str, Any] | None = None
        self.closed = False
        self.version = "123.0"

    async def new_context(self, **kwargs: Any) -> FakeContext:
        self.context_options = kwargs
        return self.context

    async def close(self) -> None:
        self.closed = True


class FakeCDPSession:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.bounds = {"left": 0, "top": 23, "width": 1280, "height": 900}

    async def send(self, method: str, params: Any = None) -> dict[str, Any]:
        self.calls.append((method, params))
        if method == "Browser.getWindowForTarget":
            return {"windowId": 42}
        if method == "Browser.setWindowBounds":
            self.bounds.update(params["bounds"])
        if method == "Browser.getWindowBounds":
            return {"bounds": dict(self.bounds)}
        return {}


class FakeChromium:
    def __init__(self, browser: FakeBrowser) -> None:
        self.browser = browser
        self.launch_options: dict[str, Any] | None = None

    async def launch(self, **kwargs: Any) -> FakeBrowser:
        self.launch_options = kwargs
        return self.browser


class FakePlaywright:
    def __init__(self, page: FakePage) -> None:
        self.chromium = FakeChromium(FakeBrowser(page))
        self.stopped = False

    async def stop(self) -> None:
        self.stopped = True


class FakePlaywrightStarter:
    def __init__(self, playwright: FakePlaywright) -> None:
        self.playwright = playwright

    async def start(self) -> FakePlaywright:
        return self.playwright


class FakeDesktop:
    def __init__(self) -> None:
        self.started = False
        self.closed = False
        self.actions: list[tuple[dict[str, Any], tuple[int, int]]] = []
        self.expected_bounds: dict[str, Any] | None = None
        self.display_selector: str | int | None = None
        self.selected_display = {
            "index": 2,
            "is_primary": False,
            "x": -1728.0,
            "y": 0.0,
            "width": 1728.0,
            "height": 1117.0,
            "pixel_width": 3456,
            "pixel_height": 2234,
        }

    async def prepare(self, selector: str | int) -> dict[str, Any]:
        self.display_selector = selector
        return dict(self.selected_display)

    def set_expected_window_bounds(self, bounds: dict[str, Any]) -> None:
        self.expected_bounds = dict(bounds)

    async def start(self) -> None:
        self.started = True

    async def capture(self) -> Image.Image:
        return Image.new("RGB", (2560, 1440), "navy")

    async def execute(
        self, action: dict[str, Any], image_size: tuple[int, int]
    ) -> dict[str, Any]:
        self.actions.append((dict(action), image_size))
        return {"native": True}

    async def close(self) -> None:
        self.closed = True

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "display": {
                **self.selected_display,
                "selector": self.display_selector,
                "fallback_to_primary": False,
            }
        }


class BlockingProcess:
    def __init__(self) -> None:
        self.returncode: int | None = None
        self.started = asyncio.Event()
        self.stopped = asyncio.Event()
        self.terminated = False

    async def communicate(self) -> tuple[bytes, bytes]:
        self.started.set()
        await asyncio.Event().wait()
        return b"", b""

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = -15
        self.stopped.set()

    async def wait(self) -> int:
        await self.stopped.wait()
        assert self.returncode is not None
        return self.returncode


class CompletedProcess:
    returncode = 0

    async def communicate(self) -> tuple[bytes, bytes]:
        return b"", b""


def _browser(
    *, capture_surface: str = "viewport", headless: bool = True,
    desktop: FakeDesktop | None = None,
    fullscreen: bool = False,
) -> tuple[AutonomousBrowser, FakePage, FakePlaywright]:
    page = FakePage()
    playwright = FakePlaywright(page)
    browser = AutonomousBrowser(
        "http://suite.invalid/root",
        viewport=(1280, 900),
        headless=headless,
        seed=17,
        capture_surface=capture_surface,
        playwright_factory=lambda: FakePlaywrightStarter(playwright),
        desktop_backend=desktop,
        fullscreen=fullscreen,
    )
    return browser, page, playwright


@pytest.mark.asyncio
async def test_start_opens_only_seeded_gallery_in_a_fresh_context() -> None:
    browser, page, playwright = _browser()

    await browser.start()

    assert browser.suite_url == "http://suite.invalid/root/index.html?autonomous=1&seed=17"
    assert page.goto_calls == [
        (
            browser.suite_url,
            {"wait_until": "domcontentloaded", "timeout": 30_000.0},
        )
    ]
    assert "__LONGPUZZLEBENCH_AUTONOMOUS__" in (page.wait_script or "")
    assert playwright.chromium.browser.context_options == {
        "viewport": {"width": 1280, "height": 900},
        "device_scale_factor": 1.0,
        "locale": "en-US",
        "timezone_id": "UTC",
    }
    assert "game_id" not in browser.suite_url
    assert "level_id" not in browser.suite_url
    await browser.close()


@pytest.mark.asyncio
async def test_viewport_observation_is_uncropped_and_contains_no_snapshot() -> None:
    browser, page, _ = _browser()
    await browser.start()

    image = await browser.observe()

    assert image.size == (1280, 900)
    assert page.screenshot_calls == [
        {"type": "png", "full_page": False, "animations": "allow"}
    ]
    assert browser.metadata["capture_surface"] == "viewport"
    assert browser.metadata["viewport"] == {"width": 1280, "height": 900}
    assert browser.metadata["browser_chrome_visible"] is False
    assert browser.metadata["browser_version"] == "123.0"
    assert browser.metadata["user_agent"] == "FakeBrowser/1.0"
    assert not hasattr(image, "grader_state")
    await browser.close()


@pytest.mark.asyncio
async def test_snapshot_flattens_suite_identity_and_keeps_grader_data_private() -> None:
    browser, _, _ = _browser()
    await browser.start()

    snapshot = await browser.snapshot()
    observation = await browser.observe()

    assert snapshot["lifecycle"] == "success"
    assert snapshot["suite_lifecycle"] == "completed"
    assert snapshot["game_id"] == "example"
    assert snapshot["difficulty"] == "easy"
    assert snapshot["level_id"] == 2
    assert snapshot["attempt_id"] == "attempt-2"
    assert snapshot["progress"] == 1.0
    assert snapshot["game_specific"] == {"progress": 1.0}
    assert snapshot["state"] == {"status": "success", "terminal": True}
    assert "grader_state" not in snapshot
    assert snapshot["events"] == [
        {"sequence": 1, "event_type": "completion", "type": "completion"}
    ]
    assert isinstance(observation, Image.Image)
    await browser.close()


@pytest.mark.asyncio
async def test_missing_bridge_is_navigation_state_not_infrastructure_failure() -> None:
    browser, page, _ = _browser()
    await browser.start()
    page.snapshot = None
    page.url = "http://suite.invalid/wrong-place"

    snapshot = await browser.snapshot()

    assert snapshot == {
        "schema_version": 1,
        "bridge_available": False,
        "lifecycle": "outside_suite",
        "page": "external",
        "url": "http://suite.invalid/wrong-place",
        "progress": 0.0,
        "game_specific": {"progress": 0.0},
        "state": None,
        "events": [],
    }
    await browser.close()


@pytest.mark.asyncio
async def test_viewport_actions_use_full_screenshot_coordinates_without_cropping() -> None:
    browser, page, _ = _browser()
    await browser.start()

    click = await browser.execute({"action_type": "click", "x": 1200, "y": 80})
    scroll = await browser.execute({"action_type": "scroll", "direction": "down", "amount": 250})
    await browser.execute({"action_type": "keyboard_enter", "keycode": "KEYCODE_ENTER"})
    await browser.execute({"action_type": "input_text", "text": "puzzle"})

    assert click == {"accepted": True, "error": None, "target": {"x": 1200.0, "y": 80.0}}
    assert scroll["accepted"] is True
    assert page.mouse.events == [
        ("click", 1200.0, 80.0, {"click_count": 1}),
        ("wheel", 0.0, 250.0),
    ]
    assert page.keyboard.events == [("press", "Enter"), ("text", "puzzle")]
    await browser.close()


@pytest.mark.asyncio
async def test_viewport_drag_paces_intermediate_pointer_moves(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    browser, page, _ = _browser()
    await browser.start()
    sleeps: list[float] = []

    async def remember_sleep(duration: float) -> None:
        sleeps.append(duration)

    monkeypatch.setattr("mobile_world.runtime.autonomous_browser.asyncio.sleep", remember_sleep)

    receipt = await browser.execute(
        {
            "action_type": "drag",
            "start_x": 100,
            "start_y": 200,
            "end_x": 400,
            "end_y": 500,
            "duration": 0.05,
        }
    )

    assert receipt["accepted"] is True
    assert page.mouse.events == [
        ("move", 100.0, 200.0, {}),
        ("down",),
        ("move", 200.0, 300.0, {}),
        ("move", 300.0, 400.0, {}),
        ("move", 400.0, 500.0, {}),
        ("up",),
    ]
    assert sum(sleeps) == pytest.approx(0.05)
    await browser.close()


@pytest.mark.asyncio
async def test_desktop_tracks_the_visible_tab_without_changing_focus() -> None:
    desktop = FakeDesktop()
    browser, original, playwright = _browser(
        capture_surface="desktop", headless=False, desktop=desktop
    )
    await browser.start()
    original.visibility = "hidden"
    visible = FakePage()
    playwright.chromium.browser.context.pages.append(visible)

    await browser.snapshot()

    assert browser._page is visible
    assert visible.bring_to_front_calls == 0
    assert original.bring_to_front_calls == 1
    await browser.close()


@pytest.mark.asyncio
async def test_desktop_falls_back_to_an_open_tab_when_current_tab_was_closed() -> None:
    desktop = FakeDesktop()
    browser, original, playwright = _browser(
        capture_surface="desktop", headless=False, desktop=desktop
    )
    await browser.start()
    original.closed = True
    original.visibility = "hidden"
    remaining = FakePage()
    remaining.visibility = "hidden"
    playwright.chromium.browser.context.pages.append(remaining)

    await browser.observe()

    assert browser._page is remaining
    await browser.close()


@pytest.mark.asyncio
async def test_snapshot_reports_transient_agent_navigation_without_ending_episode() -> None:
    browser, page, _ = _browser()
    await browser.start()
    page.url = "http://suite.invalid/navigating"
    page.snapshot_error = RuntimeError(
        "Execution context was destroyed, most likely because of a navigation"
    )

    snapshot = await browser.snapshot()

    assert snapshot == {
        "schema_version": 1,
        "bridge_available": False,
        "lifecycle": "navigation",
        "page": "navigation",
        "url": "http://suite.invalid/navigating",
        "progress": 0.0,
        "game_specific": {"progress": 0.0},
        "state": None,
        "events": [],
    }
    await browser.close()


@pytest.mark.asyncio
async def test_snapshot_does_not_hide_arbitrary_bridge_errors() -> None:
    browser, page, _ = _browser()
    await browser.start()
    page.snapshot_error = RuntimeError("bridge contract broke")

    with pytest.raises(RuntimeError, match="bridge contract broke"):
        await browser.snapshot()
    await browser.close()


@pytest.mark.asyncio
async def test_bad_action_is_a_rejected_receipt_not_an_episode_reset() -> None:
    browser, page, _ = _browser()
    await browser.start()

    receipt = await browser.execute({"action_type": "restart"})

    assert receipt["accepted"] is False
    assert "Unsupported" in receipt["error"]
    assert page.goto_calls == [(browser.suite_url, {"wait_until": "domcontentloaded", "timeout": 30_000.0})]
    await browser.close()


@pytest.mark.asyncio
async def test_agent_navigation_aliases_are_executed_only_when_requested() -> None:
    browser, page, _ = _browser()
    await browser.start()

    back = await browser.execute({"action_type": "navigate_back"})
    home = await browser.execute({"action_type": "navigate_home"})

    assert back == {"accepted": True, "error": None, "target": "browser_history"}
    assert home == {"accepted": True, "error": None, "target": browser.suite_url}
    assert page.go_back_calls == 1
    assert page.goto_calls[-1] == (browser.suite_url, {"wait_until": "domcontentloaded"})
    await browser.close()


@pytest.mark.asyncio
async def test_desktop_observation_and_input_share_physical_screen_coordinates() -> None:
    desktop = FakeDesktop()
    browser, page, playwright = _browser(
        capture_surface="desktop", headless=False, desktop=desktop
    )
    await browser.start()

    image = await browser.observe()
    click = await browser.execute({"action_type": "click", "x": 2000, "y": 100})
    typed = await browser.execute({"action_type": "input", "text": "URL"})

    assert image.size == (2560, 1440)
    assert desktop.started is True
    assert desktop.display_selector == "secondary"
    assert page.bring_to_front_calls == 1
    assert playwright.chromium.browser.context_options["viewport"] is None
    assert playwright.chromium.browser.context_options["no_viewport"] is True
    assert "device_scale_factor" not in playwright.chromium.browser.context_options
    assert desktop.expected_bounds == {"left": -1728, "top": 0, "width": 1280, "height": 900, "windowState": "normal"}
    assert playwright.chromium.browser.context.cdp.calls == [
        ("Browser.getWindowForTarget", None),
        (
            "Browser.setWindowBounds",
            {
                "windowId": 42,
                "bounds": {
                    "left": -1728,
                    "top": 0,
                    "width": 1280,
                    "height": 900,
                    "windowState": "normal",
                },
            },
        ),
        ("Browser.getWindowBounds", {"windowId": 42}),
    ]
    assert desktop.actions == [
        ({"action_type": "click", "x": 2000, "y": 100}, (2560, 1440)),
        ({"action_type": "input", "text": "URL"}, (2560, 1440)),
    ]
    assert click["target"] == {"native": True}
    assert typed["target"] == {"native": True}
    assert page.mouse.events == []
    assert page.keyboard.events == []
    assert browser.metadata["browser_chrome_visible"] is True
    assert browser.metadata["display"]["selector"] == "secondary"
    assert browser.metadata["display"]["index"] == 2
    assert browser.metadata["display"]["fallback_to_primary"] is False
    await browser.close()
    assert desktop.closed is True


@pytest.mark.asyncio
async def test_desktop_backend_states_the_supported_platform_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("mobile_world.runtime.autonomous_browser.platform.system", lambda: "Linux")

    with pytest.raises(RuntimeError, match="requires macOS"):
        await _MacDesktopBackend().start()


@pytest.mark.asyncio
async def test_cancelling_native_drag_stops_input_and_releases_mouse(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backend = _MacDesktopBackend()
    backend._helper = Path("/fake/quartz-helper")
    drag = BlockingProcess()
    calls: list[tuple[str, ...]] = []

    async def create_process(*arguments: str, **kwargs: Any) -> Any:
        del kwargs
        calls.append(arguments)
        return drag if arguments[1] == "drag" else CompletedProcess()

    monkeypatch.setattr(
        "mobile_world.runtime.autonomous_browser.asyncio.create_subprocess_exec",
        create_process,
    )
    task = asyncio.create_task(backend._run_helper("drag", 1, 2, 3, 4, 60))
    await drag.started.wait()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert drag.terminated is True
    assert calls[-1] == ("/fake/quartz-helper", "release")


@pytest.mark.asyncio
async def test_cancelling_desktop_capture_stops_screencapture(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backend = _MacDesktopBackend()
    backend._helper = Path("/fake/quartz-helper")
    backend._window_id = 1
    backend._display = {"id": 10, "x": -1920, "y": 0, "width": 1920, "height": 1080}
    capture = BlockingProcess()

    async def create_process(*arguments: str, **kwargs: Any) -> BlockingProcess:
        del arguments, kwargs
        return capture

    monkeypatch.setattr(
        "mobile_world.runtime.autonomous_browser.asyncio.create_subprocess_exec",
        create_process,
    )
    task = asyncio.create_task(backend.capture())
    await capture.started.wait()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert capture.terminated is True


def test_desktop_capture_cannot_be_combined_with_headless_browser() -> None:
    with pytest.raises(ValueError, match="headless"):
        AutonomousBrowser("http://suite.invalid", headless=True, capture_surface="desktop")


def test_secondary_display_selection_falls_back_to_primary_on_single_display() -> None:
    displays = [
        {
            "id": 10,
            "is_primary": True,
            "x": 0,
            "y": 0,
            "width": 1512,
            "height": 982,
            "pixel_width": 3024,
            "pixel_height": 1964,
        }
    ]

    selected, fallback = _select_display(displays, "secondary")

    assert selected["id"] == 10
    assert fallback is True


def test_display_selection_supports_primary_and_one_based_index() -> None:
    displays = [
        {"id": 20, "is_primary": False, "x": -1920, "y": 0, "width": 1920, "height": 1080},
        {"id": 10, "is_primary": True, "x": 0, "y": 0, "width": 1512, "height": 982},
    ]

    primary, primary_fallback = _select_display(displays, "primary")
    indexed, index_fallback = _select_display(displays, 2)

    assert primary["id"] == 10
    assert primary_fallback is False
    assert indexed["id"] == 20
    assert index_fallback is False


def test_desktop_point_mapping_includes_negative_display_origin_and_retina_scale() -> None:
    backend = _MacDesktopBackend()
    backend._screen = {"x": -1728.0, "y": 0.0, "width": 1728.0, "height": 1117.0}

    assert backend._point(1728, 1117, (3456, 2234)) == pytest.approx((-864.0, 558.5))


@pytest.mark.asyncio
async def test_desktop_fullscreen_is_applied_after_secondary_display_placement():
    desktop = FakeDesktop()
    browser, _, playwright = _browser(capture_surface="desktop", headless=False,
                                      desktop=desktop, fullscreen=True)
    await browser.start()
    bounds_calls = [params["bounds"] for method, params in
                    playwright.chromium.browser.context.cdp.calls
                    if method == "Browser.setWindowBounds"]
    assert bounds_calls[0]["left"] == -1728
    assert bounds_calls[0]["windowState"] == "normal"
    assert bounds_calls[1] == {"windowState": "fullscreen"}
    assert browser.metadata["fullscreen"] is True
    assert browser.metadata["browser_chrome_visible"] is None
    await browser.close()
