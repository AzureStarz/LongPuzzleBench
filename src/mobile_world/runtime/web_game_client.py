"""Playwright-backed MobileWorld client for Cocos web-game benchmarks.

The client deliberately keeps the two benchmark channels separate:

* :meth:`observe` captures only the rendered game rectangle.
* :meth:`get_game_state` reads the private in-page benchmark bridge for the
  evaluator.  The returned state is never added to :class:`Observation`.

The implementation is synchronous because MobileWorld's existing environment
client and runner are synchronous.  Playwright is imported lazily so importing
MobileWorld still produces a useful error when the optional browser runtime is
not installed.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import math
import os
import shlex
import subprocess
import threading
import time
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import Any, cast
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

from loguru import logger
from PIL import Image

from mobile_world.runtime.action_outcome import visual_change_ratio
from mobile_world.runtime.utils.models import (
    ActionDispatchReceipt,
    Observation,
    ObservationEffect,
    PublicActionFeedback,
    PublicActionStatus,
    Response,
)

DEFAULT_DESIGN_WIDTH = 540
DEFAULT_DESIGN_HEIGHT = 960
DEFAULT_CANVAS_SELECTOR = "#GameCanvas, canvas"
DEFAULT_BRIDGE_NAME = "__MINIGAME_BENCHMARK__"
DEFAULT_HEADED_MAX_VIEWPORT_WIDTH = 900
DEFAULT_HEADED_MAX_VIEWPORT_HEIGHT = 880
DEFAULT_ACTION_EFFECT_TIMEOUT_SECONDS = 0.75
DEFAULT_VISUAL_STABILITY_TIMEOUT_SECONDS = 0.35
DEFAULT_VISUAL_POLL_INTERVAL_SECONDS = 0.05
DEFAULT_VISUAL_CHANGE_THRESHOLD = 0.0001


@dataclass(frozen=True, slots=True)
class GameRect:
    """A game rectangle in browser CSS-pixel coordinates."""

    x: float
    y: float
    width: float
    height: float

    def as_playwright_clip(self) -> dict[str, float]:
        """Return the shape accepted by ``page.screenshot(clip=...)``."""

        return {
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
        }


def screenshot_sha256(image: Image.Image) -> str:
    """Hash decoded pixels so PNG metadata/compression cannot fake a change."""

    rgb = image.convert("RGB")
    digest = hashlib.sha256()
    digest.update(f"{rgb.width}x{rgb.height}:RGB".encode())
    digest.update(rgb.tobytes())
    return digest.hexdigest()


def game_state_fingerprint(state: Mapping[str, Any] | None) -> str:
    """Hash evaluator state while excluding monotonic transport fields.

    ``step_count`` acknowledges pointer dispatch and ``elapsed_time_ms`` changes
    continuously; neither proves that the game accepted an action.  The
    remaining read-only state detects selection, board, score, and terminal
    changes without exposing those values to the GUI agent.
    """

    payload = {
        key: value
        for key, value in dict(state or {}).items()
        if key not in {"step_count", "elapsed_time_ms", "ready"}
    }
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


# Freeze Date.now / performance.now during model inference. Cocos director.pause
# stops animation, but maze_paint and color_connect still timeout on wall clocks.
SIMULATION_PAUSE_SCRIPT = """({name, paused}) => {
    const root = globalThis;
    const clockKey = '__mobileWorldPlayClock';
    const clock = root[clockKey] || (root[clockKey] = {
        realDateNow: Date.now.bind(Date),
        realPerfNow: (
            root.performance && typeof root.performance.now === 'function'
                ? root.performance.now.bind(root.performance)
                : null
        ),
        pausedAccumDate: 0,
        pausedAccumPerf: 0,
        freezeRealDate: null,
        freezeRealPerf: null,
        installed: false,
        install() {
            if (this.installed) return;
            const self = this;
            Date.now = function () {
                const real = self.realDateNow();
                if (self.freezeRealDate != null) {
                    return self.freezeRealDate - self.pausedAccumDate;
                }
                return real - self.pausedAccumDate;
            };
            if (self.realPerfNow && root.performance) {
                root.performance.now = function () {
                    const real = self.realPerfNow();
                    if (self.freezeRealPerf != null) {
                        return self.freezeRealPerf - self.pausedAccumPerf;
                    }
                    return real - self.pausedAccumPerf;
                };
            }
            this.installed = true;
        },
        setPaused(next) {
            this.install();
            if (next) {
                if (this.freezeRealDate == null) {
                    this.freezeRealDate = this.realDateNow();
                }
                if (this.realPerfNow && this.freezeRealPerf == null) {
                    this.freezeRealPerf = this.realPerfNow();
                }
            } else {
                if (this.freezeRealDate != null) {
                    this.pausedAccumDate += this.realDateNow() - this.freezeRealDate;
                    this.freezeRealDate = null;
                }
                if (this.freezeRealPerf != null && this.realPerfNow) {
                    this.pausedAccumPerf += this.realPerfNow() - this.freezeRealPerf;
                    this.freezeRealPerf = null;
                }
            }
        },
    });
    clock.setPaused(paused);

    const call = (target, method) => (
        Boolean(target) && typeof target[method] === 'function'
            ? (target[method](), true)
            : false
    );
    const bridge = root[name];
    const method = paused ? 'pause' : 'resume';
    const alt = paused ? 'pauseGame' : 'resumeGame';
    const viaBridge = call(bridge, method) || call(bridge, alt);
    const cc = root.cc;
    const viaCocos = Boolean(
        cc && (call(cc.game, method) || call(cc.director, method))
    );
    const parts = ['clock'];
    if (viaBridge) parts.push('bridge');
    if (viaCocos) parts.push('cocos');
    return {
        applied: true,
        via: parts.join('+'),
        paused,
        clock: true,
        bridge: viaBridge,
        cocos: viaCocos,
    };
}"""


def compute_show_all_game_rect(
    canvas_box: Mapping[str, float],
    design_width: float = DEFAULT_DESIGN_WIDTH,
    design_height: float = DEFAULT_DESIGN_HEIGHT,
) -> GameRect:
    """Compute Cocos ``ResolutionPolicy.SHOW_ALL`` content inside a canvas.

    Cocos preserves the design aspect ratio and centers it.  Depending on the
    generated page/Cocos version, the letterbox may be outside the ``canvas``
    element or inside it.  Applying this calculation in both cases is safe: an
    already aspect-matched canvas is returned unchanged, while an oversized
    canvas has its black bars removed.
    """

    try:
        canvas_x = float(canvas_box["x"])
        canvas_y = float(canvas_box["y"])
        canvas_width = float(canvas_box["width"])
        canvas_height = float(canvas_box["height"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"Invalid canvas bounding box: {canvas_box!r}") from exc

    if canvas_width <= 0 or canvas_height <= 0:
        raise ValueError(f"Canvas must have positive dimensions: {canvas_box!r}")
    if design_width <= 0 or design_height <= 0:
        raise ValueError("Design dimensions must be positive")

    design_aspect = design_width / design_height
    canvas_aspect = canvas_width / canvas_height
    if canvas_aspect > design_aspect:
        game_height = canvas_height
        game_width = game_height * design_aspect
        game_x = canvas_x + (canvas_width - game_width) / 2
        game_y = canvas_y
    else:
        game_width = canvas_width
        game_height = game_width / design_aspect
        game_x = canvas_x
        game_y = canvas_y + (canvas_height - game_height) / 2

    return GameRect(game_x, game_y, game_width, game_height)


def map_screenshot_point_to_page(
    x: float,
    y: float,
    screenshot_size: tuple[int, int],
    game_rect: GameRect,
    *,
    clamp: bool = True,
) -> tuple[float, float]:
    """Map cropped screenshot pixels to browser CSS pixels.

    The screenshot size is measured from the decoded PNG rather than inferred
    from device-pixel ratio.  Therefore this mapping remains correct for
    Retina screenshots, Playwright's CSS/device screenshot scales, browser
    zoom, and fractional canvas bounding boxes.
    """

    screenshot_width, screenshot_height = screenshot_size
    if screenshot_width <= 0 or screenshot_height <= 0:
        raise ValueError(f"Invalid screenshot size: {screenshot_size!r}")
    point_x = float(x)
    point_y = float(y)
    if clamp:
        point_x = min(max(point_x, 0.0), float(screenshot_width))
        point_y = min(max(point_y, 0.0), float(screenshot_height))
    elif not (0 <= point_x <= screenshot_width and 0 <= point_y <= screenshot_height):
        raise ValueError(f"Point {(x, y)!r} is outside screenshot bounds {screenshot_size!r}")

    return (
        game_rect.x + (point_x / screenshot_width) * game_rect.width,
        game_rect.y + (point_y / screenshot_height) * game_rect.height,
    )


class _QuietStaticHandler(SimpleHTTPRequestHandler):
    """Static handler that logs through MobileWorld rather than stderr."""

    def log_message(self, message_format: str, *args: Any) -> None:
        logger.trace("Web game server: {}", message_format % args)

    def end_headers(self) -> None:
        # Cocos builds may load generated resources through fetch.  These
        # headers also make a local build usable from a separately hosted UI.
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()


class WebGameEnvClient:
    """MobileWorld-compatible environment client for browser puzzle games.

    Args:
        base_url: Externally managed game URL.  When omitted, ``build_dir`` is
            served by an in-process static HTTP server.
        project_path: Cocos project root, used as the build command working
            directory and for resolving a relative ``build_dir``.
        build_dir: Directory containing the generated web ``index.html``.
        build_command: Optional Cocos build command (string or argv sequence).
        cocos_executable: Optional Creator executable used to synthesize a
            web-mobile build command when ``build_command`` is absent.
        task_catalog: Object exposing ``get_task(task_id)`` or a ``task``/
            ``tasks`` attribute.
        evaluator: Optional evaluator used by :meth:`get_episode_result`.
    """

    tools: list[dict[str, Any]] = []

    def __init__(
        self,
        base_url: str | None = None,
        *,
        project_path: str | Path | None = None,
        build_dir: str | Path | None = None,
        build_directory: str | Path | None = None,
        build_command: str | Sequence[str] | None = None,
        cocos_executable: str | Path | None = None,
        cocos_creator_binary: str | Path | None = None,
        build_on_start: bool = True,
        auto_build: bool | None = None,
        task_catalog: Any | None = None,
        evaluator: Any | None = None,
        host: str = "127.0.0.1",
        port: int = 0,
        server_command: str | Sequence[str] | None = None,
        server_ready_timeout_seconds: float = 60.0,
        browser_type: str = "chromium",
        headless: bool = True,
        browser_launch_options: Mapping[str, Any] | None = None,
        viewport_width: int = 1080,
        viewport_height: int = 1920,
        headed_max_viewport_width: int = DEFAULT_HEADED_MAX_VIEWPORT_WIDTH,
        headed_max_viewport_height: int = DEFAULT_HEADED_MAX_VIEWPORT_HEIGHT,
        device_scale_factor: float = 1.0,
        canvas_selector: str = DEFAULT_CANVAS_SELECTOR,
        game_viewport_selector: str | None = None,
        per_game_viewport_selectors: Mapping[str, str] | None = None,
        design_width: int = DEFAULT_DESIGN_WIDTH,
        design_height: int = DEFAULT_DESIGN_HEIGHT,
        bridge_name: str = DEFAULT_BRIDGE_NAME,
        ready_timeout_seconds: float = 30.0,
        navigation_timeout_seconds: float = 60.0,
        action_timeout_seconds: float = 3.0,
        action_effect_timeout_seconds: float = DEFAULT_ACTION_EFFECT_TIMEOUT_SECONDS,
        visual_stability_timeout_seconds: float = DEFAULT_VISUAL_STABILITY_TIMEOUT_SECONDS,
        visual_poll_interval_seconds: float = DEFAULT_VISUAL_POLL_INTERVAL_SECONDS,
        visual_change_threshold: float = DEFAULT_VISUAL_CHANGE_THRESHOLD,
        step_wait_time: float = 0.05,
        playwright_factory: Callable[[], Any] | None = None,
    ) -> None:
        configured_build_dir = build_dir if build_dir is not None else build_directory
        configured_cocos = (
            cocos_executable if cocos_executable is not None else cocos_creator_binary
        )
        self._manage_static_server = (
            not base_url or project_path is not None or build_dir is not None
        )
        self.base_url = base_url.rstrip("/") if base_url else ""
        self.project_path = Path(project_path).expanduser().resolve() if project_path else None
        self.build_dir = self._resolve_build_dir(configured_build_dir)
        self.build_command = build_command
        self.cocos_executable = self._resolve_cocos_executable(configured_cocos)
        self.build_on_start = build_on_start if auto_build is None else auto_build
        self.task_catalog = task_catalog
        self.evaluator = evaluator
        self.host = host
        self.port = int(port)
        self.server_command = server_command
        self.server_ready_timeout_seconds = float(server_ready_timeout_seconds)
        self.browser_type = browser_type
        self.headless = headless
        self.browser_launch_options = dict(browser_launch_options or {})
        self.viewport_width = int(viewport_width)
        self.viewport_height = int(viewport_height)
        self.headed_max_viewport_width = int(headed_max_viewport_width)
        self.headed_max_viewport_height = int(headed_max_viewport_height)
        if self.headed_max_viewport_width <= 0 or self.headed_max_viewport_height <= 0:
            raise ValueError("Headed viewport limits must be positive")
        self.device_scale_factor = float(device_scale_factor)
        self.canvas_selector = game_viewport_selector or canvas_selector
        self.per_game_viewport_selectors = dict(per_game_viewport_selectors or {})
        self.design_width = int(design_width)
        self.design_height = int(design_height)
        self.bridge_name = bridge_name
        self.ready_timeout_seconds = float(ready_timeout_seconds)
        self.navigation_timeout_seconds = float(navigation_timeout_seconds)
        self.action_timeout_seconds = float(action_timeout_seconds)
        self.action_effect_timeout_seconds = max(0.0, float(action_effect_timeout_seconds))
        self.visual_stability_timeout_seconds = max(0.0, float(visual_stability_timeout_seconds))
        self.visual_poll_interval_seconds = max(0.001, float(visual_poll_interval_seconds))
        self.visual_change_threshold = min(1.0, max(0.0, float(visual_change_threshold)))
        self.step_wait_time = float(step_wait_time)
        self._playwright_factory = playwright_factory

        self._server: ThreadingHTTPServer | None = None
        self._server_thread: threading.Thread | None = None
        self._server_process: subprocess.Popen[str] | None = None
        self._playwright: Any | None = None
        self._browser: Any | None = None
        self._context: Any | None = None
        self._page: Any | None = None
        self._current_task: Any | None = None
        self._current_task_id: str | None = None
        self._game_rect: GameRect | None = None
        self._observation_size: tuple[int, int] | None = None
        self._last_observation_image: Image.Image | None = None
        self._last_observation_frame_id: int | None = None
        self._frame_sequence = 0
        self._action_sequence = 0
        self._last_action_result: dict[str, Any] | None = None
        self._latched_terminal_state: dict[str, Any] | None = None
        self._last_assigned_level_state: dict[str, Any] | None = None
        self._simulation_paused = False
        self._mouse_is_down = False
        self._closed = False

    def _resolve_build_dir(self, build_dir: str | Path | None) -> Path | None:
        if build_dir is None:
            if self.project_path is None:
                return None
            return self.project_path / "build" / "web-mobile"
        path = Path(build_dir).expanduser()
        if not path.is_absolute() and self.project_path is not None:
            path = self.project_path / path
        return path.resolve()

    @staticmethod
    def _resolve_cocos_executable(value: str | Path | None) -> Path | None:
        if value is None:
            return None
        path = Path(value).expanduser()
        if path.suffix.lower() == ".app":
            path = path / "Contents" / "MacOS" / "CocosCreator"
        return path.resolve()

    @property
    def page(self) -> Any | None:
        """Current Playwright page, exposed for diagnostics but not agents."""

        return self._page

    def start(self) -> WebGameEnvClient:
        """Build/serve the game when needed and launch the browser."""

        if self._closed:
            raise RuntimeError("This WebGameEnvClient has already been closed")
        if self.server_command is not None:
            self._start_server_process()
        elif self._manage_static_server:
            self._prepare_local_build()
            self._start_static_server()
        self.connect()
        return self

    def _prepare_local_build(self) -> None:
        if self.build_on_start and (self.build_command is not None or self.cocos_executable):
            self._run_build()
        if self.build_dir is None:
            raise RuntimeError("build_dir or an external base_url is required for a web game")
        if not (self.build_dir / "index.html").is_file():
            raise RuntimeError(
                f"Cocos web build not found at {self.build_dir}. Expected index.html; "
                "provide build_command/cocos_executable or an existing build_dir."
            )

    def _run_build(self) -> None:
        if self.project_path is None:
            raise RuntimeError("project_path is required when building a Cocos project")
        if self.build_dir is None:
            raise RuntimeError("build_dir is required when building a Cocos project")
        self.build_dir.parent.mkdir(parents=True, exist_ok=True)

        command: str | list[str]
        if self.build_command is not None:
            command = (
                self.build_command
                if isinstance(self.build_command, str)
                else [str(part) for part in self.build_command]
            )
        elif self.cocos_executable is not None:
            command = [
                str(self.cocos_executable),
                "--project",
                str(self.project_path),
                "--build",
                f"platform=web-mobile;buildPath={self.build_dir.parent}",
            ]
        else:  # guarded by caller, retained for a clear direct-call error
            raise RuntimeError("No Cocos build command was configured")

        printable = command if isinstance(command, str) else shlex.join(command)
        logger.info("Building Cocos web game: {}", printable)
        build_started_at = time.time()
        build_environment = os.environ.copy()
        # Cursor and some Node-based launchers export this flag for their own
        # Electron subprocesses. Cocos Creator is also Electron-based; if the
        # flag leaks into it, the executable starts as plain Node and rejects
        # Creator's --project/--build arguments.
        build_environment.pop("ELECTRON_RUN_AS_NODE", None)
        try:
            subprocess.run(
                command,
                cwd=self.project_path,
                env=build_environment,
                shell=isinstance(command, str),
                check=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            # Cocos Creator 3.8.x on macOS can return its application exit
            # status (observed: 36) after the builder has already emitted a
            # successful web artifact.  Accept only a freshly written entry
            # point; a stale prior build must never mask a real build failure.
            index_path = self.build_dir / "index.html"
            if index_path.is_file() and index_path.stat().st_mtime >= build_started_at - 1.0:
                logger.warning(
                    "Cocos exited with status {} after producing a fresh build at {}; "
                    "continuing with the verified artifact",
                    exc.returncode,
                    index_path,
                )
                return
            raise RuntimeError(f"Cocos web build failed: {printable}") from exc
        except OSError as exc:
            raise RuntimeError(f"Cocos web build failed: {printable}") from exc

    def _start_static_server(self) -> None:
        if self._server is not None:
            return
        assert self.build_dir is not None
        if self.base_url:
            configured_url = urlsplit(self.base_url)
            if configured_url.scheme != "http" or configured_url.path not in {"", "/"}:
                raise ValueError("A managed static Cocos server requires a root http:// base_url")
            self.host = configured_url.hostname or self.host
            self.port = configured_url.port or 80
        handler = partial(_QuietStaticHandler, directory=str(self.build_dir))
        try:
            self._server = ThreadingHTTPServer((self.host, self.port), handler)
        except OSError as exc:
            raise RuntimeError(
                f"Could not start the web game server on {self.host}:{self.port}"
            ) from exc
        self._server.daemon_threads = True
        bound_host, bound_port = self._server.server_address[:2]
        public_host = self.host if self.host not in {"", "0.0.0.0", "::"} else "127.0.0.1"
        self.base_url = f"http://{public_host}:{bound_port}"
        self._server_thread = threading.Thread(
            target=self._server.serve_forever,
            name="mobileworld-web-game-server",
            daemon=True,
        )
        self._server_thread.start()
        logger.info("Serving Cocos build {} at {}", self.build_dir, self.base_url)
        self._wait_for_server()

    def _start_server_process(self) -> None:
        """Start a configured project server and own its lifecycle."""

        if self._server_process is not None:
            return
        if not self.base_url:
            raise RuntimeError("base_url is required with server_command")
        command = self.server_command
        assert command is not None
        argv: str | list[str] = (
            command if isinstance(command, str) else [str(part) for part in command]
        )
        printable = argv if isinstance(argv, str) else shlex.join(argv)
        logger.info("Starting web-game server process: {}", printable)
        try:
            self._server_process = subprocess.Popen(
                argv,
                cwd=self.project_path,
                shell=isinstance(argv, str),
                text=True,
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            # Give immediate bind/configuration failures time to surface before
            # accepting a health response that could belong to another process
            # already listening on the configured port.
            time.sleep(0.1)
            if self._server_process.poll() is not None:
                raise RuntimeError(
                    "Web-game server process exited during startup with code "
                    f"{self._server_process.returncode}"
                )
            self._wait_for_server()
        except Exception:
            self._stop_server_process()
            raise

    def _wait_for_server(self) -> None:
        deadline = time.monotonic() + self.server_ready_timeout_seconds
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            if self._server_process is not None and self._server_process.poll() is not None:
                raise RuntimeError(
                    f"Web-game server process exited with code {self._server_process.returncode}"
                )
            try:
                with urllib.request.urlopen(self.base_url, timeout=1.0) as response:
                    if response.status < 500:
                        return
            except Exception as exc:  # transient while the server thread starts
                last_error = exc
                time.sleep(0.05)
        raise RuntimeError(
            f"Web game server did not become ready at {self.base_url}"
        ) from last_error

    def connect(self) -> WebGameEnvClient:
        """Start Playwright and connect to a reusable browser process."""

        if self._browser is not None:
            return self
        factory = self._playwright_factory or self._load_playwright_factory()
        try:
            self._playwright = factory().start()
            launcher = getattr(self._playwright, self.browser_type, None)
            if launcher is None:
                raise RuntimeError(f"Unsupported Playwright browser type: {self.browser_type}")
            options = dict(self.browser_launch_options)
            options.setdefault("headless", self.headless)
            if not self.headless:
                display_width, display_height = self._browser_viewport_size()
                launch_args = list(options.get("args", ()))
                if not any(str(item).startswith("--window-size=") for item in launch_args):
                    launch_args.append(f"--window-size={display_width + 32},{display_height + 120}")
                options["args"] = launch_args
            self._browser = launcher.launch(**options)
        except Exception as exc:
            self._stop_playwright()
            message = str(exc)
            if "Executable doesn't exist" in message or "executable" in message.lower():
                raise RuntimeError(
                    "Playwright browser executable is unavailable. Run "
                    "`playwright install chromium` (or the configured browser)."
                ) from exc
            raise RuntimeError(f"Failed to start Playwright {self.browser_type}: {exc}") from exc
        return self

    @staticmethod
    def _load_playwright_factory() -> Callable[[], Any]:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise RuntimeError(
                "WebGameEnvClient requires Playwright. Install the project dependencies "
                "and run `playwright install chromium`."
            ) from exc
        return cast(Callable[[], Any], sync_playwright)

    def initialize_task(self, task_name: str | Any) -> Observation:
        """Open a fresh isolated browser context directly at the target level."""

        if self._browser is None:
            self.start()
        task = self._resolve_task(task_name)
        self.tear_down()
        self._current_task = task
        self._current_task_id = str(
            self._task_value(task, "task_id", self._task_value(task, "id", task_name))
        )

        assert self._browser is not None
        browser_viewport_width, browser_viewport_height = self._browser_viewport_size()
        self._context = self._browser.new_context(
            viewport={
                "width": browser_viewport_width,
                "height": browser_viewport_height,
            },
            device_scale_factor=self.device_scale_factor,
        )
        self._page = self._context.new_page()
        self._page.set_default_timeout(self.navigation_timeout_seconds * 1000)
        target_url = self._task_url(task)
        logger.info("Initializing web-game task {} at {}", self._current_task_id, target_url)
        try:
            self._page.goto(
                target_url,
                wait_until="domcontentloaded",
                timeout=self.navigation_timeout_seconds * 1000,
            )
            self._wait_for_task_ready(task)
            self._wait_for_post_action_state()
            return self.observe(wait_to_stabilize=False)
        except Exception:
            self.tear_down()
            raise

    def reset(self, task: str | Any | None = None, go_home: bool = False) -> Observation | Response:
        """Reset by creating a new context, guaranteeing no episode storage leak."""

        del go_home  # Browser tasks never expose or navigate through the Hub.
        target = task if task is not None else self._current_task
        if target is None:
            return Response(status="success", message="Web game environment reset")
        return self.initialize_task(target)

    def _resolve_task(self, task_or_id: str | Any) -> Any:
        if not isinstance(task_or_id, str):
            return task_or_id
        if self.task_catalog is None:
            # A task id alone remains useful when it is also the game id.
            return {"task_id": task_or_id, "game_id": task_or_id}
        getter = getattr(self.task_catalog, "get_task", None)
        if callable(getter):
            task = getter(task_or_id)
            if task is None:
                raise KeyError(f"Unknown web-game task: {task_or_id}")
            return task

        tasks = getattr(self.task_catalog, "tasks", getattr(self.task_catalog, "task", None))
        if isinstance(tasks, Mapping):
            try:
                return tasks[task_or_id]
            except KeyError as exc:
                raise KeyError(f"Unknown web-game task: {task_or_id}") from exc
        if tasks is not None:
            for task in tasks if isinstance(tasks, Sequence) else [tasks]:
                task_id = self._task_value(task, "task_id", self._task_value(task, "id", None))
                if task_id == task_or_id:
                    return task
        raise KeyError(f"Unknown web-game task: {task_or_id}")

    @staticmethod
    def _task_value(task: Any, key: str, default: Any = None) -> Any:
        if isinstance(task, Mapping):
            return task.get(key, default)
        return getattr(task, key, default)

    def _nested_task_value(self, task: Any, section: str, key: str, default: Any = None) -> Any:
        value = self._task_value(task, key, None)
        if value is not None:
            return value
        nested = self._task_value(task, section, None)
        return self._task_value(nested, key, default) if nested is not None else default

    def _task_url(self, task: Any) -> str:
        if not self.base_url:
            raise RuntimeError("Web game server has not been started and base_url is empty")
        launch_path = self._nested_task_value(task, "launch", "path", "") or ""
        base = self.base_url + "/"
        target = urljoin(base, str(launch_path).lstrip("/")) if launch_path else self.base_url
        split = urlsplit(target)
        query = dict(parse_qsl(split.query, keep_blank_values=True))
        query.setdefault("benchmark", "1")
        for key in ("game_id", "difficulty", "level_id", "seed"):
            value = self._task_value(task, key, None)
            if value is not None:
                query[key] = str(value)
        custom_query = self._nested_task_value(task, "launch", "query", {}) or {}
        if not isinstance(custom_query, Mapping):
            raise ValueError("Task launch.query must be a mapping")
        launch_parameters = self._task_value(task, "launch_parameters", {}) or {}
        if not isinstance(launch_parameters, Mapping):
            raise ValueError("Task launch_parameters must be a mapping")
        for extra_query in (launch_parameters, custom_query):
            query.update(
                {str(key): str(value) for key, value in extra_query.items() if value is not None}
            )
        return urlunsplit(
            (split.scheme, split.netloc, split.path, urlencode(query), split.fragment)
        )

    def _wait_for_task_ready(self, task: Any) -> None:
        assert self._page is not None
        bridge_name = self._nested_task_value(task, "environment", "bridge_name", self.bridge_name)
        timeout_seconds = float(
            self._nested_task_value(
                task, "environment", "ready_timeout_seconds", self.ready_timeout_seconds
            )
        )
        timeout_ms = max(1, round(timeout_seconds * 1000))
        try:
            self._page.wait_for_function(
                """name => {
                    const bridge = globalThis[name];
                    return !!bridge && (typeof bridge.getState === 'function'
                        || typeof bridge.get_state === 'function');
                }""",
                arg=bridge_name,
                timeout=timeout_ms,
            )
            result = self._page.evaluate(
                """async ({name, timeoutMs}) => {
                    const bridge = globalThis[name];
                    if (typeof bridge.waitForReady === 'function') {
                        return await bridge.waitForReady(timeoutMs);
                    }
                    const deadline = performance.now() + timeoutMs;
                    while (performance.now() <= deadline) {
                        const state = typeof bridge.getState === 'function'
                            ? bridge.getState() : bridge.get_state();
                        if (state && state.ready === true) return {ok: true, state};
                        await new Promise(resolve => setTimeout(resolve, 16));
                    }
                    const state = typeof bridge.getState === 'function'
                        ? bridge.getState() : bridge.get_state();
                    return {ok: false, state};
                }""",
                {"name": bridge_name, "timeoutMs": timeout_ms},
            )
        except Exception as exc:
            raise RuntimeError(
                f"Benchmark bridge {bridge_name!r} did not become available for "
                f"task {self._current_task_id}"
            ) from exc
        if not isinstance(result, Mapping) or not result.get("ok"):
            state = result.get("state") if isinstance(result, Mapping) else None
            raise RuntimeError(
                f"Target game/difficulty/level did not become ready for task "
                f"{self._current_task_id}; last evaluator state={state!r}"
            )
        # Some Cocos controllers briefly re-enter ``loading`` while replacing
        # the scene after their readiness promise resolves. Do not hand that
        # transient frame to the agent or evaluator.
        try:
            self._page.wait_for_function(
                """name => {
                    const bridge = globalThis[name];
                    if (!bridge) return false;
                    const state = typeof bridge.getState === 'function'
                        ? bridge.getState() : bridge.get_state();
                    return !!state && state.ready === true && state.status !== 'loading';
                }""",
                arg=bridge_name,
                timeout=timeout_ms,
            )
        except Exception as exc:
            raise RuntimeError(f"Task {self._current_task_id} remained in a loading state") from exc

    def _wait_for_post_action_state(self) -> dict[str, Any]:
        """Wait for evaluator-declared in-flight rule operations to settle.

        The bridge exposes only a boolean wait contract here; none of the
        evaluator state is copied into the agent observation or public action
        feedback.  A bounded timeout is returned only as diagnostics and is
        never treated as evidence of a deadlock; the next stable action can
        re-evaluate the state.
        """

        if self._page is None:
            raise RuntimeError("No web-game task is active")
        bridge_name = self._nested_task_value(
            self._current_task, "environment", "bridge_name", self.bridge_name
        )
        timeout_ms = max(1, round(self.action_timeout_seconds * 1000))
        started = time.monotonic()
        result = self._page.evaluate(
            """async ({name, timeoutMs}) => {
                const bridge = globalThis[name];
                if (!bridge) throw new Error(`Missing benchmark bridge ${name}`);
                if (typeof bridge.waitForPostActionState === 'function') {
                    return await bridge.waitForPostActionState(timeoutMs);
                }
                const state = typeof bridge.getState === 'function'
                    ? bridge.getState() : bridge.get_state();
                return {ok: true, state, required: false};
            }""",
            {"name": bridge_name, "timeoutMs": timeout_ms},
        )
        if not isinstance(result, Mapping):
            raise RuntimeError("Benchmark post-action synchronization returned non-object")
        required = bool(result.get("required"))
        ok = bool(result.get("ok"))
        return {
            "required": required,
            "ok": ok,
            "wait_ms": round((time.monotonic() - started) * 1000, 3),
        }

    def _viewport_settings(self) -> tuple[str, int, int]:
        task = self._current_task
        selector = self.canvas_selector
        width = self.design_width
        height = self.design_height
        if task is not None:
            game_id = str(self._task_value(task, "game_id", ""))
            selector = self.per_game_viewport_selectors.get(game_id, selector)
            viewport = self._task_value(task, "viewport", None)
            task_selector = self._nested_task_value(
                task, "environment", "canvas_selector", selector
            )
            viewport_selector = self._task_value(viewport, "selector", None)
            selector = viewport_selector or task_selector
            if viewport is not None:
                width = int(self._task_value(viewport, "design_width", width))
                height = int(self._task_value(viewport, "design_height", height))
        return str(selector), width, height

    def _browser_viewport_size(self) -> tuple[int, int]:
        """Return the actual page viewport used by Playwright.

        Headless evaluation keeps the configured benchmark viewport exactly.
        A headed debugging window is proportionally reduced so the full
        portrait game fits on a desktop display instead of extending below
        the physical screen. Agent observations are restored to the benchmark
        resolution in :meth:`observe`.
        """

        if self.headless:
            return self.viewport_width, self.viewport_height
        scale = min(
            1.0,
            self.headed_max_viewport_width / self.viewport_width,
            self.headed_max_viewport_height / self.viewport_height,
        )
        return (
            max(1, round(self.viewport_width * scale)),
            max(1, round(self.viewport_height * scale)),
        )

    def _target_observation_size(self) -> tuple[int, int]:
        """Return the game-crop size produced by the benchmark viewport."""

        _, design_width, design_height = self._viewport_settings()
        target = compute_show_all_game_rect(
            {
                "x": 0.0,
                "y": 0.0,
                "width": float(self.viewport_width),
                "height": float(self.viewport_height),
            },
            design_width,
            design_height,
        )
        return max(1, round(target.width)), max(1, round(target.height))

    def locate_game_rect(self) -> GameRect:
        """Locate the current canvas and remove any SHOW_ALL letterbox."""

        if self._page is None:
            raise RuntimeError("No web-game task is active")
        selector, design_width, design_height = self._viewport_settings()
        locator = self._page.locator(selector).first
        locator.wait_for(state="visible", timeout=self.navigation_timeout_seconds * 1000)
        canvas_box = locator.bounding_box()
        if canvas_box is None:
            raise RuntimeError(f"Visible game canvas {selector!r} has no bounding box")
        rect = compute_show_all_game_rect(canvas_box, design_width, design_height)
        self._game_rect = rect
        return rect

    def _capture_game_image(self) -> Image.Image:
        """Capture one cropped game frame without reading evaluator state."""

        if self._page is None:
            raise RuntimeError("No web-game task is active")
        rect = self.locate_game_rect()
        png = self._page.screenshot(
            type="png",
            clip=rect.as_playwright_clip(),
            animations="disabled",
            caret="hide",
            scale="css",
        )
        with Image.open(BytesIO(png)) as decoded:
            screenshot = decoded.convert("RGB").copy()
        if not self.headless:
            target_size = self._target_observation_size()
            if screenshot.size != target_size:
                screenshot = screenshot.resize(target_size, Image.Resampling.LANCZOS)
        return cast(Image.Image, screenshot)

    def _remember_observation(self, screenshot: Image.Image) -> Observation:
        self._frame_sequence += 1
        self._observation_size = screenshot.size
        self._last_observation_image = screenshot.copy()
        self._last_observation_frame_id = self._frame_sequence
        return Observation(screenshot=screenshot, frame_id=self._frame_sequence)

    def observe(self, wait_to_stabilize: bool = False) -> Observation:
        """Capture only the actual game pixels; evaluator state is excluded."""

        if self._page is None:
            raise RuntimeError("No web-game task is active")
        if wait_to_stabilize and self.step_wait_time > 0:
            self._page.wait_for_timeout(self.step_wait_time * 1000)
        return self._remember_observation(self._capture_game_image())

    def get_observation(self, type: str = "screenshot", wait_to_stabilize: bool = True) -> dict:
        """AndroidEnvClient-compatible observation dictionary."""

        if type != "screenshot":
            raise ValueError(f"Unsupported web-game observation type: {type}")
        observation = self.observe(wait_to_stabilize=wait_to_stabilize)
        return {"screenshot": observation.screenshot, "accessibility_tree": None}

    def get_screenshot(self, wait_to_stabilize: bool = False) -> Image.Image:
        return cast(Image.Image, self.observe(wait_to_stabilize=wait_to_stabilize).screenshot)

    def get_observation_metadata(self) -> dict[str, Any]:
        """Return non-secret image/coordinate metadata safe for trajectory logs."""

        if (
            self._game_rect is None
            or self._observation_size is None
            or self._last_observation_image is None
        ):
            raise RuntimeError("No observation has been captured for the active task")
        return {
            "environment_type": "web_game",
            "frame_id": self._last_observation_frame_id,
            "coordinate_space": "cropped_game_screenshot_pixels",
            "screenshot_width": self._observation_size[0],
            "screenshot_height": self._observation_size[1],
            "game_rect_css_width": self._game_rect.width,
            "game_rect_css_height": self._game_rect.height,
            "headed_preview_scaled": not self.headless,
            "screenshot_sha256": screenshot_sha256(self._last_observation_image),
        }

    def _map_point(self, x: float, y: float) -> tuple[float, float]:
        if self._page is None:
            raise RuntimeError("No web-game task is active")
        if self._observation_size is None:
            self.observe(wait_to_stabilize=False)
        # Recompute offsets before every action to survive responsive reflow.
        rect = self.locate_game_rect()
        assert self._observation_size is not None
        return map_screenshot_point_to_page(x, y, self._observation_size, rect)

    @staticmethod
    def _action_value(action: Any, key: str, default: Any = None) -> Any:
        if isinstance(action, Mapping):
            value = action.get(key, None)
            nested = action.get("action_json")
        else:
            value = getattr(action, key, None)
            nested = getattr(action, "action_json", None)
        if value is not None:
            return value
        if isinstance(nested, Mapping):
            return nested.get(key, default)
        return default

    def execute_action(self, action: Any) -> Observation:
        """Map a MobileWorld action onto Playwright mouse/timing primitives."""

        if self._page is None:
            raise RuntimeError("No web-game task is active")
        if self._last_observation_image is None:
            self.observe(wait_to_stabilize=False)
        assert self._last_observation_image is not None
        pre_image = self._last_observation_image.copy()
        pre_frame_id = self._last_observation_frame_id
        pre_state = self.get_game_state()
        pre_state_fingerprint = game_state_fingerprint(pre_state)
        dispatched_coordinates: dict[str, Any] = {}
        dispatch_started = time.monotonic()
        self._action_sequence += 1
        action_id = f"{self._current_task_id or 'web-game'}:action:{self._action_sequence:04d}"
        action_type = str(self._action_value(action, "action_type", "")).lower()
        if action_type in {"click", "tap"}:
            x, y = self._required_point(action, "x", "y")
            page_x, page_y = self._map_point(x, y)
            dispatched_coordinates = {
                "agent": {"x": x, "y": y},
                "page_css": {"x": page_x, "y": page_y},
            }
            self._page.mouse.click(page_x, page_y)
        elif action_type in {"double_tap", "double_click"}:
            x, y = self._required_point(action, "x", "y")
            page_x, page_y = self._map_point(x, y)
            dispatched_coordinates = {
                "agent": {"x": x, "y": y},
                "page_css": {"x": page_x, "y": page_y},
            }
            self._page.mouse.click(page_x, page_y, click_count=2, delay=100)
        elif action_type == "long_press":
            x, y = self._required_point(action, "x", "y")
            page_x, page_y = self._map_point(x, y)
            dispatched_coordinates = {
                "agent": {"x": x, "y": y},
                "page_css": {"x": page_x, "y": page_y},
            }
            duration_ms = float(self._action_value(action, "duration_ms", 1000))
            self._page.mouse.move(page_x, page_y)
            self._page.mouse.down()
            self._page.wait_for_timeout(max(0.0, duration_ms))
            self._page.mouse.up()
        elif action_type == "press":
            x, y = self._required_point(action, "x", "y")
            page_x, page_y = self._map_point(x, y)
            dispatched_coordinates = {
                "agent": {"x": x, "y": y},
                "page_css": {"x": page_x, "y": page_y},
            }
            self._page.mouse.move(page_x, page_y)
            if not self._mouse_is_down:
                self._page.mouse.down()
                self._mouse_is_down = True
        elif action_type == "release":
            x = self._action_value(action, "x", None)
            y = self._action_value(action, "y", None)
            if x is not None and y is not None:
                page_x, page_y = self._map_point(float(x), float(y))
                dispatched_coordinates = {
                    "agent": {"x": float(x), "y": float(y)},
                    "page_css": {"x": page_x, "y": page_y},
                }
                self._page.mouse.move(page_x, page_y)
            if self._mouse_is_down:
                self._page.mouse.up()
                self._mouse_is_down = False
        elif action_type in {"drag", "swipe"}:
            dispatched_coordinates = self._execute_drag_like(action, action_type)
        elif action_type == "scroll":
            self._execute_scroll(action)
        elif action_type == "wait":
            duration_ms = self._duration_ms(action, default_ms=1000)
            self._page.wait_for_timeout(duration_ms)
        else:
            raise ValueError(f"Unsupported web-game action type: {action_type!r}")

        post_image, post_state, synchronization = self._synchronize_after_action(
            action_type,
            pre_image=pre_image,
            pre_state_fingerprint=pre_state_fingerprint,
        )
        post_hash = screenshot_sha256(post_image)
        pre_hash = screenshot_sha256(pre_image)
        change_ratio = visual_change_ratio(pre_image, post_image)
        state_changed = game_state_fingerprint(post_state) != pre_state_fingerprint
        visual_changed = change_ratio > self.visual_change_threshold
        duration_ms = round((time.monotonic() - dispatch_started) * 1000, 3)
        dispatch = ActionDispatchReceipt(action_id=action_id, duration_ms=duration_ms)
        observation = self._remember_observation(post_image)
        post_frame_id = observation.frame_id
        fresh_capture = (
            pre_frame_id is None or post_frame_id is None or post_frame_id > pre_frame_id
        )
        stable = synchronization.get("inspector_stable") is not False
        observation_effect = ObservationEffect(
            pre_frame_id=pre_frame_id,
            post_frame_id=post_frame_id,
            fresh_capture=fresh_capture,
            stable=stable,
            visual_changed=visual_changed,
            visual_change_ratio=change_ratio,
        )
        public_status = (
            "wait_completed"
            if action_type == "wait"
            else "screen_changed"
            if visual_changed
            else "no_visible_effect"
        )
        public_feedback = PublicActionFeedback(
            action_id=action_id,
            status=cast(PublicActionStatus, public_status),
            executed=True,
            fresh_observation=fresh_capture,
        )
        self._last_action_result = {
            "action_id": action_id,
            "executed": True,
            "action_type": action_type,
            "dispatch": dispatch.model_dump(),
            "observation_effect": observation_effect.model_dump(),
            "public_feedback": public_feedback.model_dump(),
            # Evaluator/game-bridge signals remain trajectory-only diagnostics.
            "state_changed": state_changed,
            "visual_changed": visual_changed,
            "visual_change_ratio": change_ratio,
            "reason": public_status,
            "pre_screenshot_sha256": pre_hash,
            "post_screenshot_sha256": post_hash,
            "pre_state_sha256": pre_state_fingerprint,
            "post_state_sha256": game_state_fingerprint(post_state),
            "dispatched_coordinates": dispatched_coordinates,
            "synchronization": synchronization,
            "duration_ms": duration_ms,
        }
        return observation.model_copy(update={"action_feedback": public_feedback})

    def _required_point(self, action: Any, x_key: str, y_key: str) -> tuple[float, float]:
        x = self._action_value(action, x_key, None)
        y = self._action_value(action, y_key, None)
        if x is None or y is None:
            raise ValueError(f"Action requires {x_key} and {y_key} coordinates")
        return float(x), float(y)

    def _duration_ms(self, action: Any, default_ms: float) -> float:
        duration_ms = self._action_value(action, "duration_ms", None)
        if duration_ms is None:
            duration = self._action_value(action, "duration", None)
            duration_ms = float(duration) * 1000 if duration is not None else default_ms
        return max(0.0, float(duration_ms))

    def _execute_drag_like(self, action: Any, action_type: str) -> dict[str, Any]:
        assert self._page is not None
        start_x = self._action_value(action, "start_x", self._action_value(action, "x", None))
        start_y = self._action_value(action, "start_y", self._action_value(action, "y", None))
        end_x = self._action_value(action, "end_x", None)
        end_y = self._action_value(action, "end_y", None)

        if start_x is None or start_y is None:
            if self._observation_size is None:
                self.observe(wait_to_stabilize=False)
            assert self._observation_size is not None
            start_x = self._observation_size[0] / 2
            start_y = self._observation_size[1] / 2
        if end_x is None or end_y is None:
            if action_type != "swipe":
                raise ValueError("Drag action requires start and end coordinates")
            direction = str(self._action_value(action, "direction", "up")).lower()
            if direction not in {"up", "down", "left", "right"}:
                raise ValueError(f"Invalid swipe direction: {direction!r}")
            if self._observation_size is None:
                self.observe(wait_to_stabilize=False)
            assert self._observation_size is not None
            distance = 0.4 * min(self._observation_size)
            delta = {
                "up": (0.0, -distance),
                "down": (0.0, distance),
                "left": (-distance, 0.0),
                "right": (distance, 0.0),
            }[direction]
            end_x = float(start_x) + delta[0]
            end_y = float(start_y) + delta[1]

        page_start = self._map_point(float(start_x), float(start_y))
        page_end = self._map_point(float(end_x), float(end_y))
        duration_ms = self._duration_ms(action, default_ms=400)
        requested_steps = self._action_value(action, "steps", None)
        steps = (
            max(1, int(requested_steps))
            if requested_steps is not None
            else max(2, min(60, math.ceil(duration_ms / 16)))
        )
        interval_ms = duration_ms / steps if steps else 0.0

        self._page.mouse.move(*page_start)
        self._page.mouse.down()
        self._mouse_is_down = True
        try:
            for index in range(1, steps + 1):
                progress = index / steps
                x = page_start[0] + (page_end[0] - page_start[0]) * progress
                y = page_start[1] + (page_end[1] - page_start[1]) * progress
                self._page.mouse.move(x, y)
                if interval_ms > 0:
                    self._page.wait_for_timeout(interval_ms)
        finally:
            self._page.mouse.up()
            self._mouse_is_down = False
        return {
            "agent": {
                "start_x": float(start_x),
                "start_y": float(start_y),
                "end_x": float(end_x),
                "end_y": float(end_y),
            },
            "page_css": {
                "start_x": page_start[0],
                "start_y": page_start[1],
                "end_x": page_end[0],
                "end_y": page_end[1],
            },
        }

    def _execute_scroll(self, action: Any) -> None:
        assert self._page is not None
        direction = str(self._action_value(action, "direction", "down")).lower()
        amount = float(self._action_value(action, "amount", 400))
        deltas = {
            "up": (0.0, -amount),
            "down": (0.0, amount),
            "left": (-amount, 0.0),
            "right": (amount, 0.0),
        }
        if direction not in deltas:
            raise ValueError(f"Invalid scroll direction: {direction!r}")
        x = self._action_value(action, "x", None)
        y = self._action_value(action, "y", None)
        if x is not None and y is not None:
            self._page.mouse.move(*self._map_point(float(x), float(y)))
        self._page.mouse.wheel(*deltas[direction])

    def _synchronize_after_action(
        self,
        action_type: str,
        *,
        pre_image: Image.Image,
        pre_state_fingerprint: str,
    ) -> tuple[Image.Image, dict[str, Any], dict[str, Any]]:
        """Wait for an observable effect and then a bounded stable frame.

        This preserves ``step_wait_time`` as a compatibility minimum while the
        actual acknowledgement comes from decoded Canvas pixels or private
        evaluator state.  A no-op is returned after a configurable timeout.
        """

        assert self._page is not None
        if action_type != "wait" and self.step_wait_time > 0:
            self._page.wait_for_timeout(self.step_wait_time * 1000)

        effect_started = time.monotonic()
        deadline = effect_started + self.action_effect_timeout_seconds
        samples = 1
        effect_observed = action_type == "wait"
        current_image = self._capture_game_image()
        current_state = self.get_game_state()
        while not effect_observed:
            state_changed = game_state_fingerprint(current_state) != pre_state_fingerprint
            pixels_changed = (
                visual_change_ratio(pre_image, current_image) > self.visual_change_threshold
            )
            effect_observed = state_changed or pixels_changed
            if effect_observed or time.monotonic() >= deadline:
                break
            self._page.wait_for_timeout(self.visual_poll_interval_seconds * 1000)
            current_image = self._capture_game_image()
            current_state = self.get_game_state()
            samples += 1
        effect_wait_ms = round((time.monotonic() - effect_started) * 1000, 3)

        inspector_stable: bool | None = None
        try:
            stable_result = self._page.evaluate(
                """async ({minFrames, timeoutMs}) => {
                    const inspector = globalThis.__game;
                    if (inspector && typeof inspector.waitForStable === 'function') {
                        return await inspector.waitForStable(minFrames, timeoutMs);
                    }
                    return null;
                }""",
                {"minFrames": 6, "timeoutMs": round(self.action_timeout_seconds * 1000)},
            )
            if isinstance(stable_result, Mapping):
                inspector_stable = bool(stable_result.get("ok"))
        except Exception as exc:
            # Stability is best-effort after the bridge has already passed its
            # strict initialization gate.  A screenshot is still meaningful.
            logger.warning("Web game stability wait failed after {}: {}", action_type, exc)

        rule_state_synchronization = self._wait_for_post_action_state()

        stable_deadline = time.monotonic() + self.visual_stability_timeout_seconds
        stable_samples = 0
        previous_image = current_image
        while time.monotonic() < stable_deadline:
            self._page.wait_for_timeout(self.visual_poll_interval_seconds * 1000)
            candidate = self._capture_game_image()
            stable_samples += 1
            current_image = candidate
            current_state = self.get_game_state()
            if visual_change_ratio(previous_image, candidate) <= self.visual_change_threshold:
                break
            previous_image = candidate

        return (
            current_image,
            current_state,
            {
                "effect_observed": effect_observed,
                "effect_samples": samples,
                "effect_wait_ms": effect_wait_ms,
                "inspector_stable": inspector_stable,
                "rule_state_synchronization": rule_state_synchronization,
                "visual_stability_samples": stable_samples,
            },
        )

    def get_last_action_result(self) -> dict[str, Any] | None:
        """Return a diagnostic copy; agents receive only the safe feedback subset."""

        return dict(self._last_action_result) if self._last_action_result is not None else None

    def pause_simulation(self) -> dict[str, Any]:
        """Pause animation and freeze in-page clocks during ``predict``."""

        return self._set_simulation_paused(True)

    def resume_simulation(self) -> dict[str, Any]:
        """Resume a simulation previously paused for model inference."""

        return self._set_simulation_paused(False)

    def _set_simulation_paused(self, paused: bool) -> dict[str, Any]:
        if self._page is None:
            return {"applied": False, "via": None, "paused": paused, "reason": "no_page"}
        if self._simulation_paused == paused:
            return {
                "applied": True,
                "via": "already_set",
                "paused": paused,
            }
        bridge_name = self._nested_task_value(
            self._current_task, "environment", "bridge_name", self.bridge_name
        )
        try:
            result = self._page.evaluate(
                SIMULATION_PAUSE_SCRIPT,
                {"name": bridge_name, "paused": paused},
            )
        except Exception as exc:
            logger.debug(
                "Could not {} web-game simulation: {}", "pause" if paused else "resume", exc
            )
            return {
                "applied": False,
                "via": None,
                "paused": paused,
                "error": str(exc),
            }
        payload = dict(result) if isinstance(result, Mapping) else {}
        applied = bool(payload.get("applied"))
        if applied:
            self._simulation_paused = paused
        return {
            "applied": applied,
            "via": payload.get("via"),
            "paused": paused,
            "clock": payload.get("clock"),
            "bridge": payload.get("bridge"),
            "cocos": payload.get("cocos"),
        }

    def get_game_state(self) -> dict[str, Any]:
        """Read the evaluator-only bridge state without modifying observation."""

        if self._page is None:
            raise RuntimeError("No web-game task is active")
        bridge_name = self._nested_task_value(
            self._current_task, "environment", "bridge_name", self.bridge_name
        )
        state = self._page.evaluate(
            """name => {
                const bridge = globalThis[name];
                if (!bridge) throw new Error(`Missing benchmark bridge ${name}`);
                if (typeof bridge.getState === 'function') return bridge.getState();
                if (typeof bridge.get_state === 'function') return bridge.get_state();
                throw new Error(`Benchmark bridge ${name} has no state reader`);
            }""",
            bridge_name,
        )
        if not isinstance(state, Mapping):
            raise RuntimeError(f"Benchmark bridge returned non-object state: {state!r}")
        # JSON round-trip prevents page-owned proxy-like values from escaping
        # and guarantees the evaluator receives a plain, detached structure.
        detached = json.loads(json.dumps(dict(state)))
        if not isinstance(detached, dict):  # defensive; ``state`` was a mapping above
            raise RuntimeError("Benchmark state could not be detached as an object")
        detached_state = cast(dict[str, Any], detached)
        self._maybe_latch_terminal_state(detached_state)
        return detached_state

    def _assigned_level_id(self) -> str | None:
        task = self._current_task
        if task is None:
            return None
        value = self._task_value(task, "level_id", None)
        if value is None:
            return None
        return str(value)

    def _maybe_latch_terminal_state(self, state: dict[str, Any]) -> None:
        if self._latched_terminal_state is not None:
            return
        if self._state_is_terminal(state):
            self._latched_terminal_state = state
            return
        assigned = self._assigned_level_id()
        live_level = state.get("level_id")
        if assigned is None or live_level is None:
            return
        if str(live_level) == assigned:
            self._last_assigned_level_state = dict(state)
            return
        source = self._last_assigned_level_state
        if source is None:
            return
        # Sequential Cocos games often skip the success snapshot and jump
        # straight into the next level's loading screen. Leaving the episode
        # running would score the wrong identity and keep the agent playing.
        latched = dict(source)
        latched.update(
            {
                "status": "success",
                "success": True,
                "failure": False,
                "terminal": True,
                "level_id": source.get("level_id", assigned),
            }
        )
        self._latched_terminal_state = latched

    @staticmethod
    def _state_is_terminal(state: Mapping[str, Any]) -> bool:
        status = str(state.get("status", "")).lower()
        return bool(
            state.get("terminal")
            or state.get("success")
            or state.get("failure")
            or status in {"success", "failure", "completed", "failed", "terminal"}
        )

    def get_latched_terminal_state(self) -> dict[str, Any] | None:
        """Return the first terminal bridge snapshot observed in this episode.

        Sequential games keep playing after a level is solved: this build of the
        Cocos suite auto-loads the next level about a second after completion,
        sometimes without ever exposing a ``success`` snapshot.  Polling the
        live bridge therefore cannot guarantee that the assigned level's
        outcome is still available when the episode is scored.
        """

        return (
            dict(self._latched_terminal_state) if self._latched_terminal_state is not None else None
        )

    def is_terminal(self) -> bool:
        if self._latched_terminal_state is not None:
            return True
        state = self.get_game_state()
        evaluator_method = getattr(self.evaluator, "is_terminal", None)
        if callable(evaluator_method):
            return bool(self._call_evaluator(evaluator_method, state))
        return self._state_is_terminal(state)

    def get_episode_result(self) -> Any:
        """Evaluate the current state, or return the bridge state as a fallback."""

        state = self.get_game_state()
        if self.evaluator is None:
            return state
        method = getattr(self.evaluator, "evaluate", None)
        if method is None and callable(self.evaluator):
            method = self.evaluator
        if not callable(method):
            raise TypeError("evaluator must be callable or expose evaluate()")
        return self._call_evaluator(method, state)

    def _call_evaluator(self, method: Callable[..., Any], state: dict[str, Any]) -> Any:
        """Call common evaluator signatures without masking evaluator failures."""

        signature = inspect.signature(method)
        parameters = signature.parameters
        kwargs: dict[str, Any] = {}
        for name in ("state", "game_state", "snapshot"):
            if name in parameters:
                kwargs[name] = state
                break
        for name in ("task", "task_config"):
            if name in parameters:
                kwargs[name] = self._current_task
                break
        if kwargs:
            return method(**kwargs)
        positional = [
            parameter
            for parameter in parameters.values()
            if parameter.kind
            in {inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD}
        ]
        if len(positional) >= 2:
            return method(state, self._current_task)
        if len(positional) == 1:
            return method(state)
        return method()

    def get_task_goal(self, task_type: str | None = None) -> str:
        task = self._current_task
        if task_type is not None and (
            task is None or str(self._task_value(task, "task_id", "")) != str(task_type)
        ):
            task = self._resolve_task(task_type)
        if task is None:
            raise RuntimeError("No task is active")
        return str(self._task_value(task, "instruction", self._task_value(task, "goal", "")))

    def get_suite_task_list(
        self, enable_mcp: bool = False, enable_user_interaction: bool = False
    ) -> list[str]:
        """Return catalogue task ids using the Android client compatibility API."""

        del enable_mcp, enable_user_interaction
        if self.task_catalog is None:
            return []
        tasks = getattr(
            self.task_catalog,
            "tasks",
            getattr(self.task_catalog, "task", ()),
        )
        if isinstance(tasks, Mapping):
            return [str(task_id) for task_id in tasks]
        return [
            str(self._task_value(task, "task_id", self._task_value(task, "id", "")))
            for task in tasks
        ]

    def get_suite_task_length(self, task_type: str) -> int:
        del task_type
        return 1

    def get_task_score(self, task_type: str | None = None) -> tuple[float, str]:
        del task_type
        result = self.get_episode_result()
        if isinstance(result, Mapping):
            score_value = result.get(
                "normalized_score",
                result.get("score", 1.0 if result.get("success") else 0.0),
            )
            reason = str(result.get("reason", result.get("status", "web-game evaluation")))
        else:
            score_value = getattr(
                result,
                "normalized_score",
                getattr(result, "score", 1.0 if getattr(result, "success", False) else 0.0),
            )
            reason = str(getattr(result, "reason", "web-game evaluation"))
        return float(score_value), reason

    def tear_down_task(self, task_type: str | None = None) -> Response:
        del task_type
        self.tear_down()
        return Response(status="success", message="Web-game task torn down")

    def tear_down(self) -> None:
        """Close the episode page/context while retaining the browser/server."""

        if self._page is not None:
            if self._simulation_paused:
                try:
                    self.resume_simulation()
                except Exception:
                    logger.debug("Could not resume web-game simulation during tear down")
            try:
                if self._mouse_is_down:
                    self._page.mouse.up()
            except Exception:
                logger.debug("Could not release web-game mouse during tear down")
            try:
                self._page.close()
            except Exception:
                logger.debug("Could not close web-game page during tear down")
        if self._context is not None:
            try:
                self._context.close()
            except Exception:
                logger.debug("Could not close web-game context during tear down")
        self._page = None
        self._context = None
        self._current_task = None
        self._current_task_id = None
        self._game_rect = None
        self._observation_size = None
        self._last_observation_image = None
        self._last_observation_frame_id = None
        self._frame_sequence = 0
        self._action_sequence = 0
        self._last_action_result = None
        self._latched_terminal_state = None
        self._last_assigned_level_state = None
        self._simulation_paused = False
        self._mouse_is_down = False

    def close(self) -> None:
        """Release episode, browser, Playwright, and local HTTP resources."""

        if self._closed:
            return
        self.tear_down()
        if self._browser is not None:
            try:
                self._browser.close()
            finally:
                self._browser = None
        self._stop_playwright()
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._server_thread is not None:
            self._server_thread.join(timeout=5.0)
            self._server_thread = None
        self._stop_server_process()
        self._closed = True

    def _stop_server_process(self) -> None:
        if self._server_process is None:
            return
        process = self._server_process
        self._server_process = None
        if process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5.0)

    def _stop_playwright(self) -> None:
        if self._playwright is not None:
            try:
                self._playwright.stop()
            finally:
                self._playwright = None

    def health(self) -> bool:
        if not self.base_url:
            return False
        try:
            with urllib.request.urlopen(self.base_url, timeout=2.0) as response:
                return int(response.getcode()) < 500
        except Exception:
            return False

    def __enter__(self) -> WebGameEnvClient:
        return self.start()

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.close()


# Descriptive aliases for callers that use "browser" rather than "web game".
BrowserGameEnvClient = WebGameEnvClient
WebGameClient = WebGameEnvClient


__all__ = [
    "BrowserGameEnvClient",
    "DEFAULT_ACTION_EFFECT_TIMEOUT_SECONDS",
    "DEFAULT_HEADED_MAX_VIEWPORT_HEIGHT",
    "DEFAULT_HEADED_MAX_VIEWPORT_WIDTH",
    "GameRect",
    "WebGameClient",
    "WebGameEnvClient",
    "compute_show_all_game_rect",
    "game_state_fingerprint",
    "map_screenshot_point_to_page",
    "screenshot_sha256",
    "visual_change_ratio",
]
