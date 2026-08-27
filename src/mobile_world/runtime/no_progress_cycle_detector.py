"""Evaluator-only repeated-action and no-progress cycle detection.

The detector records bounded action, observation, and state signatures for
diagnostics.  None of these private fields are returned to a GUI agent.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Literal

import imagehash
from PIL import Image

from mobile_world.runtime.action_outcome import (
    average_frame_color,
    decoded_frame_sha256,
    objective_fingerprint,
    objective_improved,
    perceptual_frame_hash,
)

CycleTerminationReason = Literal["repeated_action_cycle", "no_progress"]
_COORDINATE_KEYS = ("x", "y", "start_x", "start_y", "end_x", "end_y")


def _json_hash(value: Mapping[str, Any] | None) -> str | None:
    if value is None:
        return None
    rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return sha256(rendered.encode()).hexdigest()


def normalize_cycle_action(
    action: Mapping[str, Any], *, coordinate_tolerance_px: int
) -> dict[str, Any]:
    """Return a semantic action signature with tolerant coordinate buckets."""

    tolerance = max(1, coordinate_tolerance_px)
    action_type = str(action.get("action_type") or action.get("type") or "unknown")
    signature: dict[str, Any] = {"action_type": action_type}
    coordinate_buckets: dict[str, int] = {}
    for key in _COORDINATE_KEYS:
        value = action.get(key)
        if value is None:
            continue
        try:
            coordinate_buckets[key] = math.floor((float(value) + tolerance / 2) / tolerance)
        except (TypeError, ValueError):
            continue
    if coordinate_buckets:
        signature["coordinate_buckets"] = coordinate_buckets
        signature["coordinate_tolerance_px"] = tolerance

    if all(key in action and action.get(key) is not None for key in _COORDINATE_KEYS[2:]):
        try:
            dx = float(action["end_x"]) - float(action["start_x"])
            dy = float(action["end_y"]) - float(action["start_y"])
            signature["drag_direction_bucket"] = (
                round((math.atan2(dy, dx) % (2 * math.pi)) / (math.pi / 4)) % 8
            )
            signature["drag_distance_bucket"] = round(math.hypot(dx, dy) / tolerance)
        except (TypeError, ValueError):
            pass

    for key in ("direction", "index", "app_name", "goal_status", "text"):
        value = action.get(key)
        if value is not None:
            signature[key] = value
    return signature


@dataclass(frozen=True, slots=True)
class _VisualSignature:
    sha256: str
    perceptual_hash: str
    mean_rgb: tuple[int, int, int]


@dataclass(frozen=True, slots=True)
class _CycleRecord:
    step: int
    raw_action: dict[str, Any]
    action_signature: dict[str, Any]
    observation: _VisualSignature
    state_signature: str | None
    progress_signature: str | None
    progress: dict[str, Any] | None


@dataclass(frozen=True, slots=True)
class NoProgressCycleDecision:
    """One private detector decision and its bounded diagnostic payload."""

    detected: bool
    terminate: bool
    termination_reason: CycleTerminationReason | None
    cycle_length: int | None
    cycle_repetitions: int
    cycle_actions: tuple[dict[str, Any], ...]
    no_progress_steps: int
    last_progress_step: int
    triggered_step: int | None
    raw_action: dict[str, Any]
    action_signature: dict[str, Any]
    observation_hash: str
    state_signature: str | None
    progress_signature: str | None
    progress: dict[str, Any] | None

    def diagnostic_dict(self) -> dict[str, Any]:
        return {
            "detected": self.detected,
            "terminate": self.terminate,
            "termination_reason": self.termination_reason,
            "cycle_length": self.cycle_length,
            "cycle_repetitions": self.cycle_repetitions,
            "cycle_actions": list(self.cycle_actions),
            "no_progress_steps": self.no_progress_steps,
            "last_progress_step": self.last_progress_step,
            "triggered_step": self.triggered_step,
            "raw_action": self.raw_action,
            "action_signature": self.action_signature,
            "observation_hash": self.observation_hash,
            "state_signature": self.state_signature,
            "progress_signature": self.progress_signature,
            "progress": self.progress,
        }


class NoProgressCycleDetector:
    """Detect short repeated action cycles only when objective progress is absent."""

    def __init__(
        self,
        *,
        enabled: bool = True,
        action_window_size: int = 12,
        min_cycle_length: int = 1,
        max_cycle_length: int = 4,
        required_repetitions: int = 3,
        no_progress_steps: int = 8,
        coordinate_tolerance_px: int = 8,
        perceptual_hash_threshold: int = 0,
        mean_color_threshold: int = 3,
    ) -> None:
        if action_window_size <= 0:
            raise ValueError("action_window_size must be positive")
        if min_cycle_length <= 0 or max_cycle_length < min_cycle_length:
            raise ValueError("cycle lengths must be positive and ordered")
        if required_repetitions < 2:
            raise ValueError("required_repetitions must be at least 2")
        if action_window_size < max_cycle_length * required_repetitions:
            raise ValueError("action_window_size must hold the largest required cycle")
        if no_progress_steps <= 0:
            raise ValueError("no_progress_steps must be positive")
        self.enabled = enabled
        self.action_window_size = action_window_size
        self.min_cycle_length = min_cycle_length
        self.max_cycle_length = max_cycle_length
        self.required_repetitions = required_repetitions
        self.no_progress_steps = no_progress_steps
        self.coordinate_tolerance_px = max(1, coordinate_tolerance_px)
        self.perceptual_hash_threshold = max(0, perceptual_hash_threshold)
        self.mean_color_threshold = max(0, mean_color_threshold)
        self._records: list[_CycleRecord] = []
        self._steps_since_progress = 0
        self._last_progress_step = 0

    def reset(self) -> None:
        self._records.clear()
        self._steps_since_progress = 0
        self._last_progress_step = 0

    def _same_visual(self, left: _VisualSignature, right: _VisualSignature) -> bool:
        if left.sha256 == right.sha256:
            return True
        return (
            imagehash.hex_to_hash(left.perceptual_hash)
            - imagehash.hex_to_hash(right.perceptual_hash)
            <= self.perceptual_hash_threshold
            and max(abs(a - b) for a, b in zip(left.mean_rgb, right.mean_rgb, strict=True))
            <= self.mean_color_threshold
        )

    def _same_action(self, left: _CycleRecord, right: _CycleRecord) -> bool:
        ignored = {"coordinate_buckets", "coordinate_tolerance_px"}
        left_semantics = {
            key: value for key, value in left.action_signature.items() if key not in ignored
        }
        right_semantics = {
            key: value for key, value in right.action_signature.items() if key not in ignored
        }
        if left_semantics != right_semantics:
            return False
        for key in _COORDINATE_KEYS:
            left_value = left.raw_action.get(key)
            right_value = right.raw_action.get(key)
            if left_value is None or right_value is None:
                if left_value != right_value:
                    return False
                continue
            try:
                if abs(float(left_value) - float(right_value)) > self.coordinate_tolerance_px:
                    return False
            except (TypeError, ValueError):
                if left_value != right_value:
                    return False
        return True

    def _matches_repeated_pattern(self, cycle_length: int, *, visual: bool) -> bool:
        required = cycle_length * self.required_repetitions
        if len(self._records) < required:
            return False
        records = self._records[-required:]
        for repetition in range(1, self.required_repetitions):
            for offset in range(cycle_length):
                left = records[offset]
                right = records[repetition * cycle_length + offset]
                matched = (
                    self._same_visual(left.observation, right.observation)
                    if visual
                    else self._same_action(left, right)
                )
                if not matched:
                    return False
        return True

    def _find_cycle(self, *, visual: bool) -> int | None:
        for cycle_length in range(self.min_cycle_length, self.max_cycle_length + 1):
            if self._matches_repeated_pattern(cycle_length, visual=visual):
                return cycle_length
        return None

    def _repetition_count(self, cycle_length: int, *, visual: bool) -> int:
        count = 1
        end = len(self._records)
        while end - (count + 1) * cycle_length >= 0:
            previous_start = end - (count + 1) * cycle_length
            current_start = end - count * cycle_length
            matched = True
            for offset in range(cycle_length):
                left = self._records[previous_start + offset]
                right = self._records[current_start + offset]
                same = (
                    self._same_visual(left.observation, right.observation)
                    if visual
                    else self._same_action(left, right)
                )
                if not same:
                    matched = False
                    break
            if not matched:
                break
            count += 1
        return count

    def update(
        self,
        *,
        step: int,
        action: Mapping[str, Any],
        observation: Image.Image,
        state: Mapping[str, Any] | None,
        objective_before: Mapping[str, Any] | None,
        objective_after: Mapping[str, Any] | None,
    ) -> NoProgressCycleDecision:
        raw_action = dict(action)
        action_signature = normalize_cycle_action(
            raw_action, coordinate_tolerance_px=self.coordinate_tolerance_px
        )
        rgb = observation.convert("RGB")
        visual = _VisualSignature(
            sha256=decoded_frame_sha256(rgb),
            perceptual_hash=perceptual_frame_hash(rgb),
            mean_rgb=average_frame_color(rgb),
        )
        after_progress = objective_fingerprint(dict(objective_after or {}))
        objective_progressed = objective_improved(objective_before, objective_after)
        if objective_progressed:
            self._steps_since_progress = 0
            self._last_progress_step = step
        else:
            self._steps_since_progress += 1

        progress = dict(objective_after) if objective_after is not None else None
        record = _CycleRecord(
            step=step,
            raw_action=raw_action,
            action_signature=action_signature,
            observation=visual,
            state_signature=_json_hash(state),
            progress_signature=after_progress,
            progress=progress,
        )
        self._records.append(record)
        if len(self._records) > self.action_window_size:
            self._records = self._records[-self.action_window_size :]

        action_cycle = self._find_cycle(visual=False) if self.enabled else None
        visual_cycle = self._find_cycle(visual=True) if self.enabled else None
        enough_no_progress = self._steps_since_progress >= self.no_progress_steps
        repeated_action_cycle = (
            enough_no_progress and action_cycle is not None and visual_cycle is not None
        )
        generic_no_progress = enough_no_progress and visual_cycle is not None
        reason: CycleTerminationReason | None = None
        cycle_length: int | None = None
        repetitions = 0
        cycle_actions: tuple[dict[str, Any], ...] = ()
        if repeated_action_cycle:
            assert action_cycle is not None
            reason = "repeated_action_cycle"
            cycle_length = action_cycle
            repetitions = self._repetition_count(action_cycle, visual=False)
            cycle_actions = tuple(item.raw_action for item in self._records[-action_cycle:])
        elif generic_no_progress:
            assert visual_cycle is not None
            reason = "no_progress"
            cycle_length = visual_cycle
            repetitions = self._repetition_count(visual_cycle, visual=True)

        return NoProgressCycleDecision(
            detected=reason is not None,
            terminate=reason is not None,
            termination_reason=reason,
            cycle_length=cycle_length,
            cycle_repetitions=repetitions,
            cycle_actions=cycle_actions,
            no_progress_steps=self._steps_since_progress,
            last_progress_step=self._last_progress_step,
            triggered_step=step if reason is not None else None,
            raw_action=raw_action,
            action_signature=action_signature,
            observation_hash=visual.sha256,
            state_signature=record.state_signature,
            progress_signature=record.progress_signature,
            progress=progress,
        )
