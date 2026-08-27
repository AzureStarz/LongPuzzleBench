"""Shared strict parsing primitives for one-action-per-turn GUI agents."""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import Any


def require_exactly_one[T](candidates: Sequence[T], *, label: str = "action") -> T:
    """Return one candidate or reject ambiguous/empty model output."""

    if len(candidates) != 1:
        raise ValueError(f"Expected exactly one {label}; found {len(candidates)}")
    return candidates[0]


def extract_exactly_one_tag(text: str, tag: str, *, ignore_case: bool = False) -> str:
    """Extract exactly one complete XML-like tag body."""

    flags = re.DOTALL | (re.IGNORECASE if ignore_case else 0)
    pattern = rf"<{re.escape(tag)}>\s*(.*?)\s*</{re.escape(tag)}>"
    matches = re.findall(pattern, text, flags)
    return str(require_exactly_one(matches, label=f"<{tag}> block")).strip()


def extract_exactly_one_json_tag(text: str, tag: str) -> dict[str, Any]:
    """Extract exactly one tagged JSON object with no trailing JSON values."""

    return parse_single_json_object(extract_exactly_one_tag(text, tag), label=tag)


def split_exactly_one_marker(text: str, marker: str) -> tuple[str, str]:
    """Split around one required marker without silently selecting first/last."""

    count = text.count(marker)
    if count != 1:
        raise ValueError(f"Expected exactly one {marker!r}; found {count}")
    left, right = text.split(marker, 1)
    return left, right


def parse_single_json_object(text: str, *, label: str = "action JSON") -> dict[str, Any]:
    """Parse one JSON object and reject concatenated or trailing action payloads."""

    stripped = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", stripped, re.DOTALL | re.IGNORECASE)
    if fenced:
        stripped = fenced.group(1).strip()
    decoder = json.JSONDecoder()
    try:
        value, end = decoder.raw_decode(stripped)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid {label}: {exc}") from exc
    trailing = stripped[end:].strip()
    if trailing:
        raise ValueError(f"Expected exactly one {label}; found trailing content")
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value
