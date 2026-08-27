"""Helpers for carrying public GUI/MCP results into agent-local history."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

# Number of *completed* screenshot-action pairs kept as visual context.  The
# current screenshot is appended separately, so a full window contains four
# images: three historical observations plus the current observation.
DEFAULT_HISTORY_N_IMAGES = 3


def keep_historical_screenshot(history_n_images: int | None, screenshots_already_kept: int) -> bool:
    """Whether another screenshot should remain in the prompt.

    ``history_n_images`` counts completed historical pairs; the current
    screenshot is an extra image. ``None`` keeps every screenshot.
    """

    if history_n_images is None:
        return True
    return screenshots_already_kept < history_n_images + 1


def retained_history_pairs(history_n_images: int | None, available: int) -> int:
    """Return how many completed history pairs to keep."""

    if history_n_images is None:
        return available
    return min(history_n_images, available)


def observation_interaction_feedback(observation: Mapping[str, Any]) -> Any | None:
    """Return least-privilege GUI feedback, otherwise an MCP result.

    Fresh action feedback belongs to the immediately preceding GUI action and
    must not be masked by a stale/parallel tool slot.
    """

    action_feedback = observation.get("action_feedback")
    if action_feedback is not None:
        model_dump = getattr(action_feedback, "model_dump", None)
        return model_dump() if callable(model_dump) else action_feedback
    return observation.get("tool_call")


def public_action_feedback_text(observation: Mapping[str, Any]) -> str | None:
    """Render only the small public GUI outcome for text-history agents."""

    feedback = observation.get("action_feedback")
    if feedback is None:
        return None
    model_dump = getattr(feedback, "model_dump", None)
    if callable(model_dump):
        feedback = model_dump()
    if not isinstance(feedback, Mapping):
        return str(feedback)[:300]
    status = str(feedback.get("status", "executed"))
    cycle_length = feedback.get("cycle_length")
    if cycle_length is not None and "cycle" not in status:
        status += f"; cycle_length={cycle_length}"
    if feedback.get("recovery_required"):
        status += "; reassess the fresh screenshot"
    return status[:300]
