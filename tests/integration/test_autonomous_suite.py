"""Real-browser coverage for the native Cocos autonomous Game Suite."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "games" / "puzzle_suite" / "build" / "web-mobile"


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *args: object) -> None:
        return


@contextmanager
def _serve(directory: Path) -> Iterator[str]:
    def handler(*args: object, **kwargs: object) -> _QuietHandler:
        return _QuietHandler(*args, directory=str(directory), **kwargs)

    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class NativeCanvas:
    """Translate documented 540×960 UI geometry into browser coordinates."""

    def __init__(self, page: object) -> None:
        self.page = page
        box = page.locator("#GameCanvas").bounding_box()
        assert box is not None
        self.scale = min(box["width"] / 540, box["height"] / 960)
        self.left = box["x"] + (box["width"] - 540 * self.scale) / 2
        self.top = box["y"] + (box["height"] - 960 * self.scale) / 2
        self.actions: list[dict[str, object]] = []

    def point(self, x: float, y: float) -> tuple[float, float]:
        return self.left + x * self.scale, self.top + y * self.scale

    def click(self, x: float, y: float, label: str) -> None:
        browser_x, browser_y = self.point(x, y)
        self.actions.append(
            {"action_type": "click", "x": browser_x, "y": browser_y, "label": label}
        )
        self.page.mouse.click(browser_x, browser_y)

    def drag(self, start: tuple[float, float], end: tuple[float, float], label: str) -> None:
        start_x, start_y = self.point(*start)
        end_x, end_y = self.point(*end)
        self.actions.append(
            {
                "action_type": "drag",
                "start_x": start_x,
                "start_y": start_y,
                "end_x": end_x,
                "end_y": end_y,
                "label": label,
            }
        )
        self.page.mouse.move(start_x, start_y)
        self.page.mouse.down()
        self.page.mouse.move(end_x, end_y, steps=18)
        self.page.mouse.up()


def _snapshot(page: object) -> dict[str, object]:
    return page.evaluate("window.__LONGPUZZLEBENCH_AUTONOMOUS__.getSnapshot()")


def _wait_page(page: object, name: str) -> dict[str, object]:
    page.wait_for_function(
        "(name) => window.__LONGPUZZLEBENCH_AUTONOMOUS__.getSnapshot().page === name",
        arg=name,
        timeout=10_000,
    )
    # GameInspector changes before the replacement Cocos node tree finishes its
    # scheduled build. Wait two frames so the next visible action targets the
    # page represented by the snapshot rather than the outgoing scene.
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    return _snapshot(page)


@pytest.mark.integration
def test_native_suite_discovery_restart_wrong_navigation_reentry_and_completion(
    tmp_path: Path,
) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        pytest.skip(f"Playwright is unavailable: {exc}")
    if not (RUNTIME / "index.html").is_file():
        pytest.skip(f"Cocos web build is unavailable: {RUNTIME}")

    with _serve(RUNTIME) as origin, sync_playwright() as playwright:
        if not Path(playwright.chromium.executable_path).exists():
            pytest.skip("Playwright Chromium is unavailable; run `playwright install chromium`.")
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(f"{origin}/index.html?autonomous=1&seed=37", wait_until="networkidle")
        page.wait_for_function("window.__LONGPUZZLEBENCH_AUTONOMOUS__?.isReady()")
        ui = NativeCanvas(page)

        initial = _snapshot(page)
        assert initial["page"] == "home"
        assert initial["lifecycle"] == "menu"
        assert initial["active_game"] is None
        assert initial["grader_state"] is None
        assert initial["seed"] == 37
        entry_names = page.evaluate(
            """() => {
              const result = [];
              const stack = [window.cc.director.getScene()];
              while (stack.length) {
                const node = stack.pop();
                if (!node) continue;
                if (node.name.startsWith('Entry_')) result.push(node.name);
                stack.push(...node.children);
              }
              return result.sort();
            }"""
        )
        assert entry_names == [
            "Entry_bolt",
            "Entry_color-connect",
            "Entry_maze-paint",
            "Entry_nuts-bolts",
            "Entry_truck",
            "Entry_truck2",
        ]
        page.screenshot(path=tmp_path / "native-autonomous-home.png")

        ui.click(270, 721, "home: Maze Paint (wrong entry)")
        wrong = _wait_page(page, "maze-paint-difficulty")
        assert wrong["active_game"] == {
            "game_id": "maze_paint",
            "difficulty": None,
            "level_id": None,
        }
        ui.click(270, 315, "Maze Paint difficulty: Easy")
        page.wait_for_function(
            "window.__LONGPUZZLEBENCH_AUTONOMOUS__.getSnapshot().lifecycle === 'playing'",
            timeout=15_000,
        )
        maze_attempt = _snapshot(page)
        assert maze_attempt["attempt_id"] == "attempt-1"
        ui.drag((108, 658), (432, 658), "Maze Paint: paint bottom row")
        page.wait_for_function(
            "window.__LONGPUZZLEBENCH_AUTONOMOUS__.getSnapshot().lifecycle === 'playing'",
            timeout=5_000,
        )
        after_animation = _snapshot(page)
        assert after_animation["attempt_id"] == "attempt-1"
        assert after_animation["attempt_count"] == 1
        ui.click(50, 90, "Maze Paint: Back")
        _wait_page(page, "maze-paint-difficulty")
        ui.click(75, 908, "Maze difficulty: Back")
        assert _wait_page(page, "home")["active_game"] is None

        ui.click(270, 509, "home: Rush Hour 2")
        _wait_page(page, "truck2-difficulty")
        ui.click(270, 315, "Rush Hour 2 difficulty: Easy")
        page.wait_for_function(
            """() => {
              const snapshot = window.__LONGPUZZLEBENCH_AUTONOMOUS__.getSnapshot();
              return snapshot.page === 'truck2' && snapshot.lifecycle === 'playing';
            }""",
            timeout=15_000,
        )
        started = _snapshot(page)
        assert started["active_game"] == {
            "game_id": "truck_escape_2",
            "difficulty": "easy",
            "level_id": 1,
        }
        assert started["attempt_count"] == 2
        assert started["grader_state"]["seed"] == 37

        ui.click(478, 89, "Rush Hour 2: Restart")
        page.wait_for_function(
            "window.__LONGPUZZLEBENCH_AUTONOMOUS__.getSnapshot().attempt_count === 3",
            timeout=5_000,
        )
        assert _snapshot(page)["page"] == "truck2"

        ui.click(62, 89, "Rush Hour 2: Exit")
        exited = _wait_page(page, "truck2-difficulty")
        assert exited["grader_state"] is None
        assert exited["attempt_id"] is None
        ui.click(75, 908, "Rush Hour 2 difficulty: Back")
        _wait_page(page, "home")
        ui.click(270, 509, "home: Rush Hour 2 re-entry")
        _wait_page(page, "truck2-difficulty")
        ui.click(270, 315, "Rush Hour 2 difficulty: Easy re-entry")
        page.wait_for_function(
            """() => {
              const snapshot = window.__LONGPUZZLEBENCH_AUTONOMOUS__.getSnapshot();
              return snapshot.page === 'truck2' && snapshot.lifecycle === 'playing'
                && snapshot.attempt_count === 4;
            }""",
            timeout=15_000,
        )

        solution = (
            ((300, 237), (100, 237)),
            ((300, 237), (100, 237)),
            ((315, 327), (135, 327)),
            ((360, 462), (360, 200)),
            ((225, 417), (510, 417)),
        )
        for index, (start, end) in enumerate(solution, 1):
            before = _snapshot(page)["grader_state"]["step_count"]
            ui.drag(start, end, f"Rush Hour 2 solution drag {index}")
            page.wait_for_function(
                """(step) => {
                  const state = window.__LONGPUZZLEBENCH_AUTONOMOUS__.getSnapshot().grader_state;
                  return state?.step_count > step || state?.success === true;
                }""",
                arg=before,
                timeout=5_000,
            )
            assert _snapshot(page)["attempt_count"] == 4

        page.wait_for_function(
            "window.__LONGPUZZLEBENCH_AUTONOMOUS__.getSnapshot().lifecycle === 'completed'",
            timeout=10_000,
        )
        completed = _snapshot(page)
        assert completed["grader_state"]["success"] is True
        assert completed["attempt_count"] == 4
        page.screenshot(path=tmp_path / "native-autonomous-completed.png")

        events = page.evaluate("window.__LONGPUZZLEBENCH_AUTONOMOUS__.getEvents()")
        event_types = [event["event_type"] for event in events]
        assert event_types.count("game_start_requested") >= 3
        assert "game_restart_requested" in event_types
        assert "game_exit_requested" in event_types
        assert "game_completion_observed" in event_types
        assert event_types.count("ui_interaction") >= len(ui.actions)
        sequences = [event["sequence"] for event in events]
        assert sequences == list(range(1, len(events) + 1))
        assert len(ui.actions) == 17
        browser.close()
