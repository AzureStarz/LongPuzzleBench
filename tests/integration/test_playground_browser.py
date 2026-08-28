"""End-to-end coverage for the static GitHub Pages playground."""

from __future__ import annotations

import re
import subprocess
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


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


def _wait_for_public_state(page: object, game_id: str, difficulty: str, level: int) -> dict[str, object]:
    page.wait_for_function(
        """([gameId, difficulty, level]) => {
          const state = document.querySelector('#gameRuntime')?.contentWindow
            ?.__LONGPUZZLEBENCH_PLAY__?.getState?.();
          return state?.ready === true && state.game_id === gameId
            && state.difficulty === difficulty && state.level_id === level;
        }""",
        arg=[game_id, difficulty, level],
        timeout=20_000,
    )
    return page.evaluate(
        "document.querySelector('#gameRuntime').contentWindow.__LONGPUZZLEBENCH_PLAY__.getState()"
    )


@pytest.mark.integration
def test_static_playground_deep_links_gameplay_reset_and_mobile(tmp_path: Path) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        pytest.skip(f"Playwright is unavailable: {exc}")

    unsafe_output = ROOT / "playground" / "_generated_site"
    unsafe_build = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "build_pages.py"),
            "--output",
            str(unsafe_output),
        ],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert unsafe_build.returncode != 0
    assert "Refusing to replace a source directory" in unsafe_build.stderr
    assert not unsafe_output.exists()

    project_site = tmp_path / "LongPuzzleBench"
    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "build_pages.py"), "--output", str(project_site)],
        cwd=ROOT,
        check=True,
    )
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "verify_playground.py"),
            "--site",
            str(project_site),
        ],
        cwd=ROOT,
        check=True,
    )

    cases = (
        ("maze-paint", "maze_paint", "easy", 1),
        ("bolt-unscrew", "bolt_unscrew", "hard", 1),
        ("rush-hour", "truck_escape_2", "hard", 6),
        ("nut-and-bolt", "nuts_bolts", "hard", 2),
        ("truck-escape", "truck_escape", "default", 1),
        ("color-connect", "color_connect", "hard", 1),
    )

    with _serve(tmp_path) as origin, sync_playwright() as playwright:
        if not playwright.chromium.executable_path or not Path(
            playwright.chromium.executable_path
        ).exists():
            pytest.skip("Playwright Chromium is unavailable; run `playwright install chromium`.")
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        bad_responses: list[tuple[int, str]] = []
        console_errors: list[str] = []
        page.on(
            "response",
            lambda response: bad_responses.append((response.status, response.url))
            if response.status >= 400
            else None,
        )
        page.on(
            "console",
            lambda message: console_errors.append(message.text) if message.type == "error" else None,
        )

        base = f"{origin}/LongPuzzleBench/play/"
        page.goto(base)
        page.wait_for_function("window.scrollY < 2")
        assert page.locator("#landingView").is_visible()
        assert page.locator("#hero-title").is_visible()

        page.goto(
            f"{origin}/LongPuzzleBench/?game=maze-paint&difficulty=easy&level=01"
        )
        page.wait_for_url(re.compile(r"/LongPuzzleBench/play/\?game=maze-paint"))
        state = _wait_for_public_state(page, "maze_paint", "easy", 1)
        assert state["step_count"] == 0
        assert set(state) == {
            "schema_version",
            "game_id",
            "difficulty",
            "level_id",
            "ready",
            "status",
            "terminal",
            "step_count",
        }
        page.wait_for_function("document.querySelector('#statusText').textContent === 'Puzzle ready'")
        assert page.locator("#statusText").text_content() == "Puzzle ready"
        assert page.locator("#gameGrid .game-card").count() == 6
        assert re.search(r"/LongPuzzleBench/runtime/index\.html", page.locator("#gameRuntime").get_attribute("src") or "")

        frame = page.frame(url=re.compile(r"/LongPuzzleBench/runtime/index\.html"))
        assert frame is not None
        globals_ = frame.evaluate(
            "({public: !!window.__LONGPUZZLEBENCH_PLAY__, evaluator: !!window.__MINIGAME_BENCHMARK__, inspector: !!window.__game})"
        )
        assert globals_ == {"public": True, "evaluator": False, "inspector": False}

        canvas = frame.locator("#GameCanvas")
        canvas.scroll_into_view_if_needed()
        box = canvas.bounding_box()
        assert box is not None
        frame.evaluate(
            """() => {
              const canvas = document.querySelector('#GameCanvas');
              const rect = canvas.getBoundingClientRect();
              const start = { x: rect.width * 0.45, y: rect.height * 0.55 };
              const end = { x: rect.width * 0.75, y: rect.height * 0.55 };
              canvas.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true, button: 0, buttons: 1, clientX: start.x, clientY: start.y,
              }));
              canvas.dispatchEvent(new MouseEvent('mouseup', {
                bubbles: true, button: 0, buttons: 0, clientX: end.x, clientY: end.y,
              }));
            }"""
        )
        page.wait_for_function(
            "document.querySelector('#gameRuntime').contentWindow.__LONGPUZZLEBENCH_PLAY__.getState().step_count >= 1",
            timeout=5_000,
        )
        action_state = page.evaluate(
            "document.querySelector('#gameRuntime').contentWindow.__LONGPUZZLEBENCH_PLAY__.getState()"
        )
        assert action_state["step_count"] == 1
        page.wait_for_function("document.querySelector('#actionCount').textContent === '1'")
        assert page.locator("#actionCount").text_content() == "1"

        page.locator("#resetGame").click()
        reset_state = _wait_for_public_state(page, "maze_paint", "easy", 1)
        assert reset_state["step_count"] == 0
        page.wait_for_function("document.querySelector('#actionCount').textContent === '0'")
        assert page.locator("#actionCount").text_content() == "0"

        page.locator("#levelSelect").select_option("hard-4")
        hard_state = _wait_for_public_state(page, "maze_paint", "hard", 4)
        assert hard_state["step_count"] == 0
        assert "game=maze-paint" in page.url and "difficulty=hard" in page.url and "level=4" in page.url

        page.locator("#tryAnother").click()
        assert page.locator("#landingView").is_visible()
        assert page.locator("#gameGrid .game-card").count() == 6

        for slug, runtime_id, difficulty, level in cases[1:]:
            page.goto(f"{base}?game={slug}&difficulty={difficulty}&level={level}")
            loaded = _wait_for_public_state(page, runtime_id, difficulty, level)
            assert loaded["status"] == "running"
            assert loaded["step_count"] == 0

        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{base}?game=car-escape&difficulty=easy&level=1")
        _wait_for_public_state(page, "truck_escape_2", "easy", 1)
        page.wait_for_function("document.querySelector('#statusText').textContent === 'Puzzle ready'")
        assert page.locator("#runtimeFrame").is_visible()
        assert page.locator("#mobilePlayTitle").text_content() == "Rush Hour"
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        page.screenshot(path=tmp_path / "playground-mobile.png", full_page=True)

        assert bad_responses == []
        assert console_errors == []
        browser.close()
