"""Shared action-outcome and visual-loop tracking for GUI environments.

The tracker separates facts visible to an agent (fresh frames and visual
transitions) from evaluator-only task progress.  It never exposes private game
state, scores, or task-specific identifiers in :class:`PublicActionFeedback`.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, cast

import imagehash
from PIL import Image, ImageChops, ImageStat

from mobile_world.runtime.utils.models import PublicActionFeedback, PublicActionStatus

LEVEL_PROGRESS_KEY = "level_progress"
_LEVEL_PROGRESS_EPSILON = 1e-9


def decoded_frame_sha256(image: Image.Image) -> str:
    """Return a deterministic hash of decoded RGB pixels."""

    rgb = image.convert("RGB")
    digest = sha256()
    digest.update(f"{rgb.width}x{rgb.height}:RGB".encode())
    digest.update(rgb.tobytes())
    return digest.hexdigest()


def visual_change_ratio(before: Image.Image, after: Image.Image) -> float:
    """Return the fraction of decoded RGB pixels that differ."""

    before_rgb = before.convert("RGB")
    after_rgb = after.convert("RGB")
    if before_rgb.size != after_rgb.size:
        return 1.0
    difference = ImageChops.difference(before_rgb, after_rgb)
    channels = difference.split()
    changed = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2])
    histogram = changed.histogram()
    return float(sum(histogram[1:]) / (before_rgb.width * before_rgb.height))


def perceptual_frame_hash(image: Image.Image) -> str:
    """Return a compact visual fingerprint tolerant of encoder differences."""

    return str(imagehash.phash(image.convert("RGB")))


def average_frame_color(image: Image.Image) -> tuple[int, int, int]:
    """Return mean RGB values to disambiguate perceptually flat-color frames."""

    means = ImageStat.Stat(image.convert("RGB")).mean
    return round(means[0]), round(means[1]), round(means[2])


def normalized_action_signature(
    action: dict[str, Any], observation_size: tuple[int, int]
) -> dict[str, Any]:
    """Describe an action in resolution-independent observation coordinates."""

    width, height = observation_size
    signature: dict[str, Any] = {"action_type": action.get("action_type")}
    coordinate_axes = {
        "x": width,
        "y": height,
        "start_x": width,
        "start_y": height,
        "end_x": width,
        "end_y": height,
    }
    for key, scale in coordinate_axes.items():
        value = action.get(key)
        if value is not None and scale > 0:
            signature[key] = round(float(value) / scale, 4)
    for key, value in action.items():
        if key not in coordinate_axes and key != "action_type" and value is not None:
            signature[key] = value
    return signature


def objective_fingerprint(payload: dict[str, Any] | None) -> str | None:
    """Hash an evaluator-owned progress payload without exposing its contents."""

    if payload is None:
        return None
    rendered = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return sha256(rendered.encode()).hexdigest()


def objective_level_progress(payload: Mapping[str, Any] | None) -> float | None:
    """Return the canonical level-progress score from an evaluator payload."""

    if payload is None:
        return None
    value = payload.get(LEVEL_PROGRESS_KEY)
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def objective_improved(
    before: Mapping[str, Any] | None,
    after: Mapping[str, Any] | None,
) -> bool:
    """Return True only when the level-progress score strictly increased.

    Board identity, accepted-move counters and progress regressions do not
    count.  A missing score is treated as no improvement so no-progress
    counters keep accumulating.
    """

    before_score = objective_level_progress(before)
    after_score = objective_level_progress(after)
    if before_score is None or after_score is None:
        return False
    return after_score > before_score + _LEVEL_PROGRESS_EPSILON


@dataclass(frozen=True, slots=True)
class ActionOutcomeDecision:
    """Private loop-control decision plus safe feedback for the next turn."""

    evidence_steps: int
    recovery_required: bool
    terminate: bool
    recovery_epoch: int
    reason: str
    cycle_length: int | None
    objective_progressed: bool | None
    action_signature: dict[str, Any]
    pre_frame_sha256: str
    post_frame_sha256: str
    pre_frame_phash: str
    post_frame_phash: str
    pre_frame_mean_rgb: tuple[int, int, int]
    post_frame_mean_rgb: tuple[int, int, int]
    public_feedback: PublicActionFeedback

    def diagnostic_dict(self) -> dict[str, Any]:
        """Serialize internal evidence for trajectories, not model prompts."""

        return {
            "evidence_steps": self.evidence_steps,
            "recovery_required": self.recovery_required,
            "terminate": self.terminate,
            "recovery_epoch": self.recovery_epoch,
            "reason": self.reason,
            "cycle_length": self.cycle_length,
            "objective_progressed": self.objective_progressed,
            "action_signature": self.action_signature,
            "pre_frame_sha256": self.pre_frame_sha256,
            "post_frame_sha256": self.post_frame_sha256,
            "pre_frame_phash": self.pre_frame_phash,
            "post_frame_phash": self.post_frame_phash,
            "pre_frame_mean_rgb": self.pre_frame_mean_rgb,
            "post_frame_mean_rgb": self.post_frame_mean_rgb,
        }


class ActionOutcomeTracker:
    """Detect no-effect transitions and short visual cycles without blocking repeats."""

    def __init__(
        self,
        *,
        recovery_steps: int,
        termination_steps: int,
        max_cycle_length: int = 4,
        perceptual_hash_threshold: int = 0,
        mean_color_threshold: int = 3,
    ) -> None:
        if recovery_steps <= 0 or termination_steps <= recovery_steps:
            raise ValueError("Outcome thresholds must be positive and ordered")
        if max_cycle_length < 2:
            raise ValueError("max_cycle_length must be at least 2")
        self.recovery_steps = recovery_steps
        self.termination_steps = termination_steps
        self.max_cycle_length = max_cycle_length
        self.perceptual_hash_threshold = max(0, perceptual_hash_threshold)
        self.mean_color_threshold = max(0, mean_color_threshold)
        self._recent_frame_hashes: list[tuple[str, str, tuple[int, int, int]]] = []
        self._evidence_steps = 0
        self._recovery_epoch = 0

    def reset(self) -> None:
        self._recent_frame_hashes.clear()
        self._evidence_steps = 0
        self._recovery_epoch = 0

    def _same_visual_frame(
        self,
        left: tuple[str, str, tuple[int, int, int]],
        right: tuple[str, str, tuple[int, int, int]],
    ) -> bool:
        left_sha, left_phash, left_mean = left
        right_sha, right_phash, right_mean = right
        if left_sha == right_sha:
            return True
        return (
            imagehash.hex_to_hash(left_phash) - imagehash.hex_to_hash(right_phash)
            <= self.perceptual_hash_threshold
            and max(abs(a - b) for a, b in zip(left_mean, right_mean, strict=True))
            <= self.mean_color_threshold
        )

    def _cycle_length(self, post_hash: tuple[str, str, tuple[int, int, int]]) -> int | None:
        if not self._recent_frame_hashes:
            return None
        current_index = len(self._recent_frame_hashes)
        lower_bound = max(0, current_index - self.max_cycle_length)
        for prior_index in range(current_index - 1, lower_bound - 1, -1):
            cycle_length = current_index - prior_index
            if cycle_length < 2:
                continue
            if self._same_visual_frame(self._recent_frame_hashes[prior_index], post_hash):
                return cycle_length
        return None

    def update(
        self,
        *,
        action_id: str,
        action: dict[str, Any],
        pre_image: Image.Image,
        post_image: Image.Image,
        pre_frame_id: int | None,
        post_frame_id: int | None,
        visual_changed: bool,
        visual_change_ratio: float,
        stable: bool | None,
        objective_before: dict[str, Any] | None = None,
        objective_after: dict[str, Any] | None = None,
    ) -> ActionOutcomeDecision:
        pre_sha = decoded_frame_sha256(pre_image)
        post_sha = decoded_frame_sha256(post_image)
        pre_phash = perceptual_frame_hash(pre_image)
        post_phash = perceptual_frame_hash(post_image)
        pre_mean = average_frame_color(pre_image)
        post_mean = average_frame_color(post_image)
        pre_hash = (pre_sha, pre_phash, pre_mean)
        post_hash = (post_sha, post_phash, post_mean)
        if not self._recent_frame_hashes:
            self._recent_frame_hashes.append(pre_hash)

        cycle_length = self._cycle_length(post_hash)
        objective_progressed = objective_improved(objective_before, objective_after)
        fresh_capture = (
            pre_frame_id is None or post_frame_id is None or post_frame_id > pre_frame_id
        )

        if not fresh_capture:
            reason = "observation_stale"
            loop_evidence = True
        elif not visual_changed:
            reason = "no_visible_effect"
            loop_evidence = True
        elif cycle_length is not None:
            reason = "returned_to_recent_screen"
            loop_evidence = True
        else:
            reason = "screen_changed"
            loop_evidence = False

        if objective_progressed is True:
            self._evidence_steps = 0
        elif loop_evidence:
            self._evidence_steps += 1
        else:
            self._evidence_steps = 0

        terminate = self._evidence_steps >= self.termination_steps
        recovery_required = False
        if not terminate and self._evidence_steps >= self.recovery_steps:
            offset = self._evidence_steps - self.recovery_steps
            recovery_required = offset % self.recovery_steps == 0
            if recovery_required:
                self._recovery_epoch += 1

        public_status = reason
        if cycle_length is not None and recovery_required:
            public_status = "repeating_visual_cycle"
        message = None
        if recovery_required:
            message = (
                "Recent interactions returned the interface to a previously observed "
                "visual state. Reassess the fresh screenshot and choose another visible "
                "target unless repetition is intentionally required."
            )

        public_feedback = PublicActionFeedback(
            action_id=action_id,
            status=cast(PublicActionStatus, public_status),
            executed=True,
            fresh_observation=fresh_capture,
            cycle_length=cycle_length,
            recovery_required=recovery_required,
            message=message,
        )
        self._recent_frame_hashes.append(post_hash)
        max_history = max(8, self.max_cycle_length * 3)
        if len(self._recent_frame_hashes) > max_history:
            self._recent_frame_hashes = self._recent_frame_hashes[-max_history:]

        return ActionOutcomeDecision(
            evidence_steps=self._evidence_steps,
            recovery_required=recovery_required,
            terminate=terminate,
            recovery_epoch=self._recovery_epoch,
            reason=reason,
            cycle_length=cycle_length,
            objective_progressed=objective_progressed,
            action_signature=normalized_action_signature(action, pre_image.size),
            pre_frame_sha256=pre_sha,
            post_frame_sha256=post_sha,
            pre_frame_phash=pre_phash,
            post_frame_phash=post_phash,
            pre_frame_mean_rgb=pre_mean,
            post_frame_mean_rgb=post_mean,
            public_feedback=public_feedback,
        )
