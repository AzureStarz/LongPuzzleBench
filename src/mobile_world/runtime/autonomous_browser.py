"""Asynchronous full-browser runtime for autonomous GUI evaluation.

Unlike :mod:`mobile_world.runtime.web_game_client`, this runtime opens the
suite gallery rather than a benchmark deep link and never pauses, resets, or
otherwise controls a game's lifecycle.  The agent channel is image-only;
``snapshot`` is a separate grader-only channel.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import platform
import tempfile
from collections.abc import Mapping
from io import BytesIO
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit

from PIL import Image

from mobile_world.benchmarks.progress import canonical_progress_game_id, level_progress_from_state

DEFAULT_AUTONOMOUS_VIEWPORT = (1280, 900)
DEFAULT_NAVIGATION_TIMEOUT_SECONDS = 30.0
AUTONOMOUS_BRIDGE_NAME = "__LONGPUZZLEBENCH_AUTONOMOUS__"


class _DesktopBackend(Protocol):
    async def prepare(self, selector: str | int) -> dict[str, Any]: ...

    async def start(self) -> None: ...

    async def capture(self) -> Image.Image: ...

    async def execute(self, action: Mapping[str, Any], image_size: tuple[int, int]) -> dict[str, Any]: ...

    async def close(self) -> None: ...


_QUARTZ_INPUT_SOURCE = r"""
import ApplicationServices
import Foundation

func number(_ index: Int) -> Double {
    guard CommandLine.arguments.count > index,
          let value = Double(CommandLine.arguments[index]) else { exit(64) }
    return value
}

func point(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: y) }

func mouse(_ type: CGEventType, _ x: Double, _ y: Double,
           _ button: CGMouseButton = .left, _ clickState: Int64 = 1) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                              mouseCursorPosition: point(x, y), mouseButton: button) else { exit(70) }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.post(tap: .cghidEventTap)
}

func keyboard(_ keyCode: CGKeyCode, _ down: Bool, _ flags: CGEventFlags = []) {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down) else { exit(70) }
    event.flags = flags
    event.post(tap: .cghidEventTap)
}

guard CommandLine.arguments.count > 1 else { exit(64) }
let command = CommandLine.arguments[1]
switch command {
case "displays":
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    let values: [[String: Any]] = ids.prefix(Int(count)).map { id in
        let bounds = CGDisplayBounds(id)
        return ["id": Int(id), "is_primary": CGDisplayIsMain(id) != 0,
                "x": bounds.origin.x, "y": bounds.origin.y,
                "width": bounds.width, "height": bounds.height,
                "pixel_width": CGDisplayPixelsWide(id),
                "pixel_height": CGDisplayPixelsHigh(id)]
    }
    let data = try! JSONSerialization.data(withJSONObject: values)
    FileHandle.standardOutput.write(data)
case "desktop":
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    let displayID = CommandLine.arguments.count >= 7
        ? CGDirectDisplayID(number(6)) : CGMainDisplayID()
    let displayBounds = CGDisplayBounds(displayID)
    let expected = CommandLine.arguments.count >= 6
        ? CGRect(x: number(2), y: number(3), width: number(4), height: number(5)) : nil
    var value: [String: Any]? = nil
    var bestDistance = Double.infinity
    for window in windows {
        let owner = (window[kCGWindowOwnerName as String] as? String ?? "").lowercased()
        let layer = window[kCGWindowLayer as String] as? Int ?? -1
        guard layer == 0, owner.contains("chromium") || owner.contains("chrome"),
              let number = window[kCGWindowNumber as String] as? Int,
              let rawBounds = window[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: rawBounds) else { continue }
        let distance = expected.map {
            abs(bounds.origin.x - $0.origin.x) + abs(bounds.origin.y - $0.origin.y)
                + abs(bounds.width - $0.width) + abs(bounds.height - $0.height)
        } ?? 0
        if distance >= bestDistance { continue }
        bestDistance = distance
        value = ["x": displayBounds.origin.x, "y": displayBounds.origin.y,
                 "width": displayBounds.width, "height": displayBounds.height,
                 "window_x": bounds.origin.x, "window_y": bounds.origin.y,
                 "window_width": bounds.width, "window_height": bounds.height,
                 "window_id": number, "owner": owner,
                 "accessibility_trusted": AXIsProcessTrusted(),
                 "screen_capture_allowed": CGPreflightScreenCaptureAccess()]
    }
    guard let value = value else { exit(69) }
    let data = try! JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(data)
case "click":
    let x = number(2), y = number(3), count = Int(number(4))
    for clickIndex in 1...max(1, count) {
        mouse(.leftMouseDown, x, y, .left, Int64(clickIndex))
        mouse(.leftMouseUp, x, y, .left, Int64(clickIndex))
        if clickIndex < count { usleep(80_000) }
    }
case "down":
    mouse(.leftMouseDown, number(2), number(3))
case "up":
    mouse(.leftMouseUp, number(2), number(3))
case "release":
    let location = CGEvent(source: nil)?.location ?? CGPoint.zero
    mouse(.leftMouseUp, location.x, location.y)
case "drag":
    let x1 = number(2), y1 = number(3), x2 = number(4), y2 = number(5)
    let duration = max(0, number(6)), steps = max(2, Int(duration * 60.0))
    mouse(.leftMouseDown, x1, y1)
    for index in 1...steps {
        let progress = Double(index) / Double(steps)
        mouse(.leftMouseDragged, x1 + (x2 - x1) * progress, y1 + (y2 - y1) * progress)
        if duration > 0 { usleep(useconds_t(duration * 1_000_000.0 / Double(steps))) }
    }
    mouse(.leftMouseUp, x2, y2)
case "scroll":
    let dx = Int32(number(2)), dy = Int32(number(3))
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                              wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { exit(70) }
    event.post(tap: .cghidEventTap)
case "text":
    let text = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
    for character in text {
        let units = Array(String(character).utf16)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { exit(70) }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
    }
case "key":
    let value = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
    let parts = value.split(separator: "+").map { String($0).lowercased() }
    var flags: CGEventFlags = []
    if parts.contains("shift") { flags.insert(.maskShift) }
    if parts.contains("control") || parts.contains("ctrl") { flags.insert(.maskControl) }
    if parts.contains("alt") || parts.contains("option") { flags.insert(.maskAlternate) }
    if parts.contains("meta") || parts.contains("command") || parts.contains("cmd") { flags.insert(.maskCommand) }
    let name = parts.last ?? ""
    let codes: [String: CGKeyCode] = [
        "enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51,
        "delete": 117, "escape": 53, "esc": 53, "left": 123, "arrowleft": 123,
        "right": 124, "arrowright": 124, "down": 125, "arrowdown": 125,
        "up": 126, "arrowup": 126, "home": 115, "end": 119, "pageup": 116,
        "pagedown": 121, "a": 0, "b": 11, "c": 8, "d": 2, "e": 14,
        "f": 3, "g": 5, "h": 4, "i": 34, "j": 38, "k": 40, "l": 37,
        "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15,
        "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16,
        "z": 6, "0": 29, "1": 18, "2": 19, "3": 20, "4": 21,
        "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
    ]
    if let code = codes[name], !flags.isEmpty || name.count != 1 {
        keyboard(code, true, flags); keyboard(code, false, flags)
    } else if name.count == 1 && flags.isEmpty {
        let units = Array(name.utf16)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { exit(70) }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
    } else { exit(64) }
default:
    exit(64)
}
"""


class _MacDesktopBackend:
    """macOS screen capture and Quartz pointer input without Python packages."""

    def __init__(self) -> None:
        self._helper: Path | None = None
        self._screen: dict[str, float] | None = None
        self._window_bounds: dict[str, float] | None = None
        self._window_id: int | None = None
        self._owner: str | None = None
        self._expected_window_bounds: dict[str, float] | None = None
        self._display: dict[str, Any] | None = None
        self._selector: str | int = "secondary"
        self._fallback_to_primary = False

    async def _build_helper(self) -> None:
        if platform.system() != "Darwin":
            raise RuntimeError(
                "capture_surface='desktop' requires macOS. Use capture_surface='viewport' "
                "for headless or Linux test runs."
            )
        cache = Path(tempfile.gettempdir()) / f"longpuzzlebench-quartz-input-{os.getuid()}"
        source = cache.with_suffix(".swift")
        source.write_text(_QUARTZ_INPUT_SOURCE, encoding="utf-8")
        process = await asyncio.create_subprocess_exec(
            "xcrun", "swiftc", str(source), "-o", str(cache),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await process.communicate()
        if process.returncode:
            raise RuntimeError(f"Could not build the macOS Quartz input helper: {stderr.decode().strip()}")
        self._helper = cache

    async def prepare(self, selector: str | int) -> dict[str, Any]:
        await self._build_helper()
        try:
            displays = json.loads(await self._run_helper("displays"))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError("The macOS Quartz helper returned invalid display metadata") from exc
        if not isinstance(displays, list) or not displays:
            raise RuntimeError("macOS reported no active displays")
        selected, fallback = _select_display(displays, selector)
        ordered = _ordered_displays(displays)
        self._display = dict(selected)
        self._display["index"] = ordered.index(selected) + 1
        self._selector = selector
        self._fallback_to_primary = fallback
        self._screen = {
            key: float(selected[key]) for key in ("x", "y", "width", "height")
        }
        return dict(self._display)

    def set_expected_window_bounds(self, bounds: Mapping[str, Any]) -> None:
        self._expected_window_bounds = {
            key: float(bounds[key]) for key in ("left", "top", "width", "height")
        }

    async def start(self) -> None:
        if self._helper is None:
            await self.prepare(self._selector)
        assert self._display is not None
        expected = self._expected_window_bounds or {
            "left": 0.0,
            "top": 0.0,
            "width": 0.0,
            "height": 0.0,
        }
        result = await self._run_helper(
            "desktop",
            expected["left"],
            expected["top"],
            expected["width"],
            expected["height"],
            self._display["id"],
        )
        try:
            metadata = json.loads(result)
            if metadata.get("accessibility_trusted") is not True:
                raise RuntimeError(
                    "macOS desktop input requires Accessibility permission for the terminal "
                    "or benchmark process."
                )
            if metadata.get("screen_capture_allowed") is not True:
                raise RuntimeError(
                    "macOS desktop capture requires Screen Recording permission for the terminal "
                    "or benchmark process."
                )
            self._screen = {key: float(metadata[key]) for key in ("x", "y", "width", "height")}
            self._window_bounds = {
                key.removeprefix("window_"): float(metadata[key])
                for key in ("window_x", "window_y", "window_width", "window_height")
            }
            self._window_id = int(metadata["window_id"])
            self._owner = str(metadata["owner"])
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError("The macOS Quartz input helper returned invalid window metadata") from exc

    async def _run_helper(self, *arguments: object) -> str:
        if self._helper is None:
            raise RuntimeError("The macOS desktop input backend has not been started")
        process = await asyncio.create_subprocess_exec(
            str(self._helper), *(str(argument) for argument in arguments),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await process.communicate()
        except asyncio.CancelledError:
            await self._terminate_process(process)
            if arguments and arguments[0] == "drag":
                await asyncio.shield(self._release_mouse())
            raise
        if process.returncode:
            detail = stderr.decode().strip()
            if arguments and arguments[0] == "desktop":
                raise RuntimeError(
                    "Could not identify the foreground Chromium window for desktop capture."
                )
            raise RuntimeError(
                "macOS rejected desktop input. Grant Accessibility permission to the terminal "
                f"or benchmark process.{f' ({detail})' if detail else ''}"
            )
        return stdout.decode()

    @staticmethod
    async def _terminate_process(process: Any) -> None:
        if process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
        await process.wait()

    async def _release_mouse(self) -> None:
        if self._helper is None:
            return
        process = await asyncio.create_subprocess_exec(
            str(self._helper), "release",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await process.communicate()

    async def capture(self) -> Image.Image:
        if self._window_id is None or self._display is None:
            raise RuntimeError("The macOS desktop backend has no Chromium window")
        handle, filename = tempfile.mkstemp(prefix="longpuzzlebench-observation-", suffix=".png")
        os.close(handle)
        try:
            capture_region = ",".join(
                str(int(round(float(self._display[key]))))
                for key in ("x", "y", "width", "height")
            )
            process = await asyncio.create_subprocess_exec(
                "/usr/sbin/screencapture", "-x", f"-R{capture_region}", "-t", "png", filename,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                _, stderr = await process.communicate()
            except asyncio.CancelledError:
                await self._terminate_process(process)
                raise
            if process.returncode:
                raise RuntimeError(
                    "macOS screen capture failed. Grant Screen Recording permission to the "
                    f"terminal or benchmark process. ({stderr.decode().strip()})"
                )
            with Image.open(filename) as image:
                return image.convert("RGB").copy()
        finally:
            Path(filename).unlink(missing_ok=True)

    def _point(self, x: float, y: float, image_size: tuple[int, int]) -> tuple[float, float]:
        if self._screen is None:
            raise RuntimeError("The macOS desktop input backend has no display metadata")
        width, height = image_size
        if width <= 0 or height <= 0:
            raise ValueError("Desktop observation has invalid dimensions")
        return (
            self._screen["x"] + x * self._screen["width"] / width,
            self._screen["y"] + y * self._screen["height"] / height,
        )

    async def execute(self, action: Mapping[str, Any], image_size: tuple[int, int]) -> dict[str, Any]:
        action_type = str(action.get("action_type", "")).lower()
        if action_type in {"click", "tap", "double_click", "double_tap"}:
            x, y = _required_point(action)
            target = self._point(x, y, image_size)
            await self._run_helper("click", *target, 2 if action_type.startswith("double") else 1)
            return {"x": x, "y": y}
        if action_type in {"drag", "swipe"}:
            start, end = _drag_points(action, image_size)
            duration = _duration_seconds(action, 0.4)
            await self._run_helper(
                "drag", *self._point(*start, image_size), *self._point(*end, image_size), duration
            )
            return {"start": _point_dict(start), "end": _point_dict(end)}
        if action_type == "scroll":
            dx, dy = _scroll_delta(action)
            # Quartz wheel deltas use the opposite sign from Playwright's
            # content-scroll convention.
            await self._run_helper("scroll", -dx, -dy)
            return {"delta_x": dx, "delta_y": dy}
        if action_type in {"key", "keypress"}:
            key = action.get("key")
            if not isinstance(key, str) or not key:
                raise ValueError("Key action requires a nonempty key")
            await self._run_helper("key", key)
            return {"key": key}
        if action_type in {"input", "type"}:
            text = action.get("text")
            if not isinstance(text, str):
                raise ValueError("Input action requires text")
            await self._run_helper("text", text)
            return {"text_length": len(text)}
        raise ValueError(
            f"Action {action_type!r} cannot target browser chrome through the desktop backend"
        )

    async def close(self) -> None:
        self._helper = None
        self._screen = None
        self._window_bounds = None
        self._window_id = None
        self._owner = None
        self._expected_window_bounds = None
        self._display = None
        self._fallback_to_primary = False

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "profile": "macos_selected_display",
            "window_owner": self._owner,
            "screen_bounds": dict(self._screen) if self._screen is not None else None,
            "browser_window_bounds": (
                dict(self._window_bounds) if self._window_bounds is not None else None
            ),
            "display": ({
                **dict(self._display),
                "selector": self._selector,
                "fallback_to_primary": self._fallback_to_primary,
            } if self._display is not None else None),
        }


def _ordered_displays(displays: list[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return sorted(
        displays,
        key=lambda display: (
            not bool(display.get("is_primary")),
            float(display.get("y", 0)),
            float(display.get("x", 0)),
            int(display.get("id", 0)),
        ),
    )


def _select_display(
    displays: list[Mapping[str, Any]], selector: str | int
) -> tuple[Mapping[str, Any], bool]:
    ordered = _ordered_displays(displays)
    if not ordered:
        raise ValueError("No active displays are available")
    if selector == "primary":
        return next((display for display in ordered if display.get("is_primary")), ordered[0]), False
    if selector == "secondary":
        secondary = next((display for display in ordered if not display.get("is_primary")), None)
        if secondary is not None:
            return secondary, False
        return next((display for display in ordered if display.get("is_primary")), ordered[0]), True
    if isinstance(selector, int) and not isinstance(selector, bool):
        if selector < 1 or selector > len(ordered):
            raise ValueError(f"Display index must be between 1 and {len(ordered)}")
        return ordered[selector - 1], False
    raise ValueError("display must be 'secondary', 'primary', or a positive 1-based index")


def _point_dict(point: tuple[float, float]) -> dict[str, float]:
    return {"x": point[0], "y": point[1]}


def _required_point(action: Mapping[str, Any]) -> tuple[float, float]:
    x = action.get("x")
    y = action.get("y")
    if x is None or y is None:
        coordinate = action.get("coordinate")
        if isinstance(coordinate, (list, tuple)) and len(coordinate) == 2:
            x, y = coordinate
    if x is None or y is None:
        raise ValueError("Action requires x and y coordinates")
    return float(x), float(y)


def _duration_seconds(action: Mapping[str, Any], default: float) -> float:
    if action.get("duration_ms") is not None:
        return max(0.0, float(action["duration_ms"]) / 1000.0)
    return max(0.0, float(action.get("duration", default)))


def _drag_points(
    action: Mapping[str, Any], image_size: tuple[int, int]
) -> tuple[tuple[float, float], tuple[float, float]]:
    start_coordinate = action.get("start_coordinate")
    end_coordinate = action.get("end_coordinate")
    start_x = action.get("start_x", action.get("x"))
    start_y = action.get("start_y", action.get("y"))
    end_x, end_y = action.get("end_x"), action.get("end_y")
    if isinstance(start_coordinate, (list, tuple)) and len(start_coordinate) == 2:
        start_x, start_y = start_coordinate
    if isinstance(end_coordinate, (list, tuple)) and len(end_coordinate) == 2:
        end_x, end_y = end_coordinate
    if start_x is None or start_y is None:
        start_x, start_y = image_size[0] / 2, image_size[1] / 2
    if end_x is None or end_y is None:
        if str(action.get("action_type", "")).lower() != "swipe":
            raise ValueError("Drag action requires start and end coordinates")
        direction = str(action.get("direction", "up")).lower()
        if direction not in {"up", "down", "left", "right"}:
            raise ValueError(f"Invalid swipe direction: {direction!r}")
        distance = min(image_size) * 0.4
        dx, dy = {
            "up": (0.0, -distance), "down": (0.0, distance),
            "left": (-distance, 0.0), "right": (distance, 0.0),
        }[direction]
        end_x, end_y = float(start_x) + dx, float(start_y) + dy
    return (float(start_x), float(start_y)), (float(end_x), float(end_y))


def _scroll_delta(action: Mapping[str, Any]) -> tuple[float, float]:
    if action.get("delta_x") is not None or action.get("delta_y") is not None:
        return float(action.get("delta_x", 0.0)), float(action.get("delta_y", 0.0))
    amount = abs(float(action.get("amount", 600.0)))
    direction = str(action.get("direction", "down")).lower()
    try:
        return {
            "down": (0.0, amount),
            "up": (0.0, -amount),
            "right": (amount, 0.0),
            "left": (-amount, 0.0),
        }[direction]
    except KeyError as exc:
        raise ValueError(f"Invalid scroll direction: {direction!r}") from exc


def _canonical_action(action: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(action)
    action_type = str(result.get("action_type", "")).lower()
    aliases = {
        "navigate_back": "back",
        "navigate_home": "home",
        "input_text": "input",
        "keyboard_enter": "key",
    }
    result["action_type"] = aliases.get(action_type, action_type)
    if result["action_type"] == "key" and not result.get("key"):
        result["key"] = result.get("keycode") or "Enter"
    if result["action_type"] == "key":
        result["key"] = _canonical_key(str(result["key"]))
    return result


def _canonical_key(value: str) -> str:
    key = value.removeprefix("KEYCODE_")
    aliases = {
        "ENTER": "Enter",
        "DPAD_CENTER": "Enter",
        "HOME": "Home",
        "END": "End",
        "ESCAPE": "Escape",
        "BACK": "Escape",
        "TAB": "Tab",
        "SPACE": "Space",
        "DEL": "Backspace",
        "FORWARD_DEL": "Delete",
        "DPAD_UP": "ArrowUp",
        "DPAD_DOWN": "ArrowDown",
        "DPAD_LEFT": "ArrowLeft",
        "DPAD_RIGHT": "ArrowRight",
        "PAGE_UP": "PageUp",
        "PAGE_DOWN": "PageDown",
    }
    return aliases.get(key.upper(), key)


def _snapshot_state(state: Mapping[str, Any]) -> dict[str, Any]:
    """Remove cumulative histories already represented by append-only events."""

    result = dict(state)
    result.pop("trajectory", None)
    raw_game_state = result.get("raw_game_state")
    if isinstance(raw_game_state, Mapping):
        compact_game_state = dict(raw_game_state)
        compact_game_state.pop("trajectory", None)
        result["raw_game_state"] = compact_game_state
    return result


class AutonomousBrowser:
    """Lightweight, asynchronous browser/desktop observation and action channel."""

    def __init__(
        self,
        base_url: str,
        viewport: tuple[int, int] = DEFAULT_AUTONOMOUS_VIEWPORT,
        headless: bool = False,
        seed: int = 0,
        capture_surface: str = "desktop",
        display: str | int = "secondary",
        *,
        fullscreen: bool = True,
        navigation_timeout_seconds: float = DEFAULT_NAVIGATION_TIMEOUT_SECONDS,
        playwright_factory: Any | None = None,
        desktop_backend: _DesktopBackend | None = None,
    ) -> None:
        if not base_url:
            raise ValueError("base_url is required")
        if len(viewport) != 2 or viewport[0] <= 0 or viewport[1] <= 0:
            raise ValueError("viewport must contain positive width and height")
        if seed < 0:
            raise ValueError("seed must be nonnegative")
        if capture_surface not in {"desktop", "viewport"}:
            raise ValueError("capture_surface must be 'desktop' or 'viewport'")
        if headless and capture_surface == "desktop":
            raise ValueError("A headless browser cannot use capture_surface='desktop'")
        if not (
            display in {"secondary", "primary"}
            or (isinstance(display, int) and not isinstance(display, bool) and display >= 1)
        ):
            raise ValueError("display must be 'secondary', 'primary', or a positive 1-based index")
        self.base_url = base_url.rstrip("/")
        self.viewport = (int(viewport[0]), int(viewport[1]))
        self.headless = bool(headless)
        self.seed = int(seed)
        self.capture_surface = capture_surface
        self.fullscreen = fullscreen and capture_surface == "desktop"
        self.display = display
        self.navigation_timeout_seconds = float(navigation_timeout_seconds)
        self._playwright_factory = playwright_factory
        self._desktop = desktop_backend or _MacDesktopBackend()
        self._playwright: Any | None = None
        self._browser: Any | None = None
        self._context: Any | None = None
        self._page: Any | None = None
        self._last_observation_size: tuple[int, int] | None = None
        self._last_suite_event_sequence = 0
        self._runtime_metadata: dict[str, Any] = {}
        self._cdp_session: Any | None = None
        self._selected_display: dict[str, Any] | None = None

    @property
    def suite_url(self) -> str:
        base = self.base_url + "/"
        path = urljoin(base, "index.html")
        split = urlsplit(path)
        return urlunsplit((split.scheme, split.netloc, split.path, urlencode({"autonomous": 1, "seed": self.seed}), ""))

    async def start(self) -> AutonomousBrowser:
        """Open one fresh context at the suite gallery and wait for its bridge."""

        if self._browser is not None:
            return self
        factory = self._playwright_factory
        if factory is None:
            try:
                from playwright.async_api import async_playwright
            except ImportError as exc:  # pragma: no cover - declared dependency
                raise RuntimeError(
                    "AutonomousBrowser requires Playwright. Install dependencies and run "
                    "`playwright install chromium`."
                ) from exc
            factory = async_playwright
        try:
            self._playwright = await factory().start()
            window_left = 0
            window_top = 0
            if self.capture_surface == "desktop":
                prepare = getattr(self._desktop, "prepare", None)
                if callable(prepare):
                    self._selected_display = dict(await prepare(self.display))
                    window_left = int(self._selected_display["x"])
                    window_top = int(self._selected_display["y"])
            launch_options: dict[str, Any] = {"headless": self.headless}
            if not self.headless:
                launch_options["args"] = [
                    f"--window-size={self.viewport[0]},{self.viewport[1]}",
                    f"--window-position={window_left},{window_top}",
                ]
            self._browser = await self._playwright.chromium.launch(**launch_options)
            context_options: dict[str, Any] = {
                "locale": "en-US",
                "timezone_id": "UTC",
            }
            if self.capture_surface == "desktop":
                context_options.update({"viewport": None, "no_viewport": True})
            else:
                context_options.update(
                    {
                        "viewport": {"width": self.viewport[0], "height": self.viewport[1]},
                        "device_scale_factor": 1.0,
                    }
                )
            self._context = await self._browser.new_context(**context_options)
            self._page = await self._context.new_page()
            self._context.on("page", self._select_page)
            if self.capture_surface == "desktop":
                self._cdp_session = await self._context.new_cdp_session(self._page)
                window = await self._cdp_session.send("Browser.getWindowForTarget")
                await self._cdp_session.send(
                    "Browser.setWindowBounds",
                    {
                        "windowId": window["windowId"],
                        "bounds": {
                            "left": window_left,
                            "top": window_top,
                            "width": self.viewport[0],
                            "height": self.viewport[1],
                            "windowState": "normal",
                        },
                    },
                )
                if self.fullscreen:
                    await self._cdp_session.send(
                        "Browser.setWindowBounds",
                        {"windowId": window["windowId"], "bounds": {"windowState": "fullscreen"}},
                    )
                    # macOS moves the window into a full-screen Space asynchronously.
                    deadline = asyncio.get_running_loop().time() + self.navigation_timeout_seconds
                    while True:
                        state = await self._cdp_session.send(
                            "Browser.getWindowBounds", {"windowId": window["windowId"]}
                        )
                        if state["bounds"].get("windowState") == "fullscreen":
                            break
                        if asyncio.get_running_loop().time() >= deadline:
                            raise RuntimeError("Browser did not enter fullscreen on the selected display")
                        await asyncio.sleep(0.1)
                actual_window = await self._cdp_session.send(
                    "Browser.getWindowBounds", {"windowId": window["windowId"]}
                )
                configure_bounds = getattr(self._desktop, "set_expected_window_bounds", None)
                if callable(configure_bounds):
                    configure_bounds(actual_window["bounds"])
            self._page.set_default_timeout(self.navigation_timeout_seconds * 1000)
            await self._page.goto(
                self.suite_url,
                wait_until="domcontentloaded",
                timeout=self.navigation_timeout_seconds * 1000,
            )
            await self._page.wait_for_function(
                f"() => Boolean(window.{AUTONOMOUS_BRIDGE_NAME}?.isReady?.())",
                timeout=self.navigation_timeout_seconds * 1000,
            )
            browser_geometry = await self._page.evaluate(
                """() => ({
                    user_agent: navigator.userAgent,
                    inner_width: innerWidth, inner_height: innerHeight,
                    outer_width: outerWidth, outer_height: outerHeight,
                    screen_x: screenX, screen_y: screenY,
                    device_pixel_ratio: devicePixelRatio,
                })"""
            )
            self._runtime_metadata = {
                "browser_version": self._browser.version,
                **dict(browser_geometry),
            }
            if self.capture_surface == "desktop":
                await self._page.bring_to_front()
                await self._desktop.start()
        except Exception:
            await self.close()
            raise
        return self

    def _select_page(self, page: Any) -> None:
        """Follow agent-opened tabs without changing focus or navigation."""

        self._page = page

    def _require_page(self) -> Any:
        if self._page is None:
            raise RuntimeError("AutonomousBrowser has not been started")
        return self._page

    async def _active_page(self) -> Any:
        page = self._require_page()
        if self.capture_surface != "desktop":
            return page
        pages = [candidate for candidate in self._context.pages if not candidate.is_closed()]
        if not pages:
            raise RuntimeError("All autonomous browser tabs have been closed")
        for candidate in reversed(pages):
            try:
                if await candidate.evaluate("() => document.visibilityState") == "visible":
                    self._page = candidate
                    return candidate
            except Exception as exc:
                if not self._is_transient_navigation_error(exc):
                    raise
        if page in pages:
            return page
        self._page = pages[-1]
        return self._page

    @staticmethod
    def _is_transient_navigation_error(error: Exception) -> bool:
        message = str(error).lower()
        return (
            "execution context was destroyed" in message
            or "cannot find context with specified id" in message
            or "most likely because of a navigation" in message
        )

    async def observe(self) -> Image.Image:
        """Return only the current visual observation, never grader state."""

        page = await self._active_page()
        if self.capture_surface == "desktop":
            image = await self._desktop.capture()
        else:
            payload = await page.screenshot(type="png", full_page=False, animations="allow")
            with Image.open(BytesIO(payload)) as decoded:
                image = decoded.convert("RGB").copy()
        self._last_observation_size = image.size
        return image

    async def snapshot(self) -> dict[str, Any]:
        """Read the private suite bridge and append grader-side progress only."""

        page = await self._active_page()
        try:
            payload = await page.evaluate(
                f"""(after) => {{
                const bridge = window.{AUTONOMOUS_BRIDGE_NAME};
                if (!bridge?.getSnapshot) return null;
                const snapshot = bridge.getSnapshot();
                const cursor = Number(snapshot?.last_event_sequence) < after ? 0 : after;
                return {{snapshot, events: bridge.getEvents?.(cursor) ?? []}};
            }}""",
                self._last_suite_event_sequence,
            )
        except Exception as exc:
            if not self._is_transient_navigation_error(exc):
                raise
            return {
                "schema_version": 1,
                "bridge_available": False,
                "lifecycle": "navigation",
                "page": "navigation",
                "url": page.url,
                "progress": 0.0,
                "game_specific": {"progress": 0.0},
                "state": None,
                "events": [],
            }
        raw = payload.get("snapshot") if isinstance(payload, Mapping) else None
        if not isinstance(raw, Mapping):
            return {
                "schema_version": 1,
                "bridge_available": False,
                "lifecycle": "outside_suite",
                "page": "external",
                "url": page.url,
                "progress": 0.0,
                "game_specific": {"progress": 0.0},
                "state": None,
                "events": [],
            }
        snapshot = dict(raw)
        snapshot["bridge_available"] = True
        snapshot["url"] = page.url
        events = payload.get("events", []) if isinstance(payload, Mapping) else []
        snapshot["events"] = [
            {**event, "type": event.get("event_type")}
            if isinstance(event, Mapping) and "type" not in event
            else event
            for event in events
        ] if isinstance(events, list) else []
        sequences = [
            event.get("sequence")
            for event in snapshot["events"]
            if isinstance(event, Mapping) and isinstance(event.get("sequence"), int)
        ]
        if sequences:
            self._last_suite_event_sequence = max(sequences)
        grader_state = snapshot.pop("grader_state", None)
        active_game = snapshot.get("active_game")
        game_id = active_game.get("game_id") if isinstance(active_game, Mapping) else None
        if isinstance(grader_state, Mapping) and grader_state.get("game_id"):
            game_id = grader_state.get("game_id")
        if game_id and isinstance(grader_state, Mapping):
            progress, metrics = level_progress_from_state(str(game_id), grader_state)
        else:
            progress, metrics = 0.0, {"progress": 0.0}
        lifecycle = str(snapshot.get("lifecycle", ""))
        snapshot["lifecycle"] = "success" if lifecycle == "completed" else lifecycle
        snapshot["suite_lifecycle"] = lifecycle
        if isinstance(active_game, Mapping):
            for key in ("game_id", "difficulty", "level_id"):
                snapshot[key] = active_game.get(key)
            if isinstance(grader_state, Mapping):
                for key in ("game_id", "difficulty", "level_id", "seed"):
                    if grader_state.get(key) is not None:
                        snapshot[key] = grader_state[key]
            if snapshot.get("game_id"):
                snapshot["game_id"] = canonical_progress_game_id(str(snapshot["game_id"]))
        else:
            snapshot.update({"game_id": None, "difficulty": None, "level_id": None})
        snapshot["progress"] = float(progress)
        snapshot["game_specific"] = dict(metrics)
        snapshot["state"] = _snapshot_state(grader_state) if isinstance(grader_state, Mapping) else None
        return snapshot

    async def execute(self, action: Mapping[str, Any]) -> dict[str, Any]:
        """Execute exactly one agent-chosen action without lifecycle intervention."""

        page = await self._active_page()
        action = _canonical_action(action)
        action_type = str(action.get("action_type", "")).lower()
        try:
            if action_type == "wait":
                duration = _duration_seconds(action, 1.0)
                await asyncio.sleep(duration)
                target: Any = {"duration_seconds": duration}
            elif action_type in {"back", "browser_back"}:
                await page.go_back(wait_until="domcontentloaded")
                target = "browser_history"
            elif action_type in {"home", "suite_home"}:
                await page.goto(self.suite_url, wait_until="domcontentloaded")
                target = self.suite_url
            elif self.capture_surface == "desktop" and action_type not in {
                "back", "browser_back", "home", "suite_home"
            }:
                if self._last_observation_size is None:
                    await self.observe()
                assert self._last_observation_size is not None
                target = await self._desktop.execute(action, self._last_observation_size)
            elif action_type in {"key", "keypress"}:
                key = action.get("key")
                if not isinstance(key, str) or not key:
                    raise ValueError("Key action requires a nonempty key")
                await page.keyboard.press(key)
                target = {"key": key}
            elif action_type in {"input", "type"}:
                text = action.get("text")
                if not isinstance(text, str):
                    raise ValueError("Input action requires text")
                await page.keyboard.insert_text(text)
                target = {"text_length": len(text)}
            else:
                target = await self._execute_viewport(action)
            return {"accepted": True, "error": None, "target": target}
        except (TypeError, ValueError, RuntimeError) as exc:
            return {"accepted": False, "error": str(exc), "target": None}

    async def _execute_viewport(self, action: Mapping[str, Any]) -> Any:
        page = self._require_page()
        action_type = str(action.get("action_type", "")).lower()
        if action_type in {"click", "tap", "double_click", "double_tap"}:
            x, y = _required_point(action)
            await page.mouse.click(
                x, y, click_count=2 if action_type.startswith("double") else 1
            )
            return {"x": x, "y": y}
        if action_type in {"drag", "swipe"}:
            start, end = _drag_points(action, self.viewport)
            duration = _duration_seconds(action, 0.4)
            steps = max(2, min(120, math.ceil(duration * 60)))
            interval = duration / steps
            await page.mouse.move(*start)
            await page.mouse.down()
            try:
                for index in range(1, steps + 1):
                    progress = index / steps
                    x = start[0] + (end[0] - start[0]) * progress
                    y = start[1] + (end[1] - start[1]) * progress
                    await page.mouse.move(x, y)
                    if interval > 0:
                        await asyncio.sleep(interval)
            finally:
                await page.mouse.up()
            return {"start": _point_dict(start), "end": _point_dict(end)}
        if action_type == "scroll":
            dx, dy = _scroll_delta(action)
            await page.mouse.wheel(dx, dy)
            return {"delta_x": dx, "delta_y": dy}
        raise ValueError(f"Unsupported autonomous browser action type: {action_type!r}")

    @property
    def metadata(self) -> dict[str, Any]:
        result = {
            "base_url": self.base_url,
            "suite_url": self.suite_url,
            "seed": self.seed,
            "headless": self.headless,
            "capture_surface": self.capture_surface,
            "fullscreen": self.fullscreen,
            "viewport": {"width": self.viewport[0], "height": self.viewport[1]},
            "requested_window_size": (
                {"width": self.viewport[0], "height": self.viewport[1]}
                if self.capture_surface == "desktop"
                else None
            ),
            "device_scale_factor": 1.0,
            "locale": "en-US",
            "timezone": "UTC",
            "browser_chrome_visible": (None if self.fullscreen else self.capture_surface == "desktop"),
            **self._runtime_metadata,
        }
        desktop_metadata = getattr(self._desktop, "metadata", None)
        if self.capture_surface == "desktop" and isinstance(desktop_metadata, Mapping):
            result["desktop"] = dict(desktop_metadata)
            display_metadata = desktop_metadata.get("display")
            if isinstance(display_metadata, Mapping):
                result["display"] = dict(display_metadata)
        return result

    def observation_metadata(self) -> dict[str, Any]:
        """Compatibility accessor for callers that prefer an explicit method."""

        return self.metadata

    async def close(self) -> None:
        """Close the fresh browser context and all owned resources."""

        for attribute in ("_context", "_browser"):
            resource = getattr(self, attribute)
            setattr(self, attribute, None)
            if resource is not None:
                try:
                    await resource.close()
                except Exception:
                    pass
        self._page = None
        self._cdp_session = None
        if self._playwright is not None:
            playwright, self._playwright = self._playwright, None
            try:
                await playwright.stop()
            except Exception:
                pass
        await self._desktop.close()
        self._last_observation_size = None
        self._last_suite_event_sequence = 0
        self._runtime_metadata = {}
        self._selected_display = None


__all__ = ["AUTONOMOUS_BRIDGE_NAME", "AutonomousBrowser"]
