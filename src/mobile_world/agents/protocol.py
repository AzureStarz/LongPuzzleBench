"""Canonical contracts shared by benchmark-oriented agent harnesses.

The public :class:`BaseAgent` API remains unchanged for compatibility.  These
types make the observation/decision boundary explicit inside harnesses that
want to compare models rather than model-specific agent implementations.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from PIL import Image

from mobile_world.runtime.utils.models import JSONAction


@dataclass(frozen=True, slots=True)
class AgentInteraction:
    """One previously selected semantic action and its public result."""

    step: int
    action: dict[str, Any]
    result: Any | None = None


@dataclass(frozen=True, slots=True)
class VisualAgentInteraction:
    """One bounded screenshot-action pair supplied as multimodal history."""

    step: int
    screenshot: Image.Image
    action: dict[str, Any]
    result: Any | None = None


@dataclass(frozen=True, slots=True)
class AgentObservation:
    """Least-privilege input supplied to a canonical agent harness."""

    instruction: str
    screenshot: Image.Image
    older_history: tuple[AgentInteraction, ...] = ()
    older_history_omitted: int = 0
    recent_visual_history: tuple[VisualAgentInteraction, ...] = ()


@dataclass(frozen=True, slots=True)
class ModelCallUsage:
    """Provider-neutral usage for one model request."""

    model_calls: int = 1
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    latency_seconds: float = 0.0
    estimated_cost: float | None = None

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass(frozen=True, slots=True)
class AgentDecision:
    """Canonical result of one observation-to-one-action decision."""

    thought: str | None
    action: JSONAction
    raw_response: str
    usage: ModelCallUsage = field(default_factory=ModelCallUsage)
    parsed_action: dict[str, Any] | None = None
    diagnostics: dict[str, Any] = field(default_factory=dict)
