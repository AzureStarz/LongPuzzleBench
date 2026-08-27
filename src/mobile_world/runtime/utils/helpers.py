"""Small logging helpers shared by the public agent implementation."""

from __future__ import annotations

import copy
import json

from loguru import logger


def mask_api_key(key: str | None) -> str:
    """Return a non-reversible placeholder suitable for logs."""

    return "<configured>" if key else "<missing>"


def pretty_print_messages(messages: list[dict], max_messages: int = 2) -> None:
    """Debug-log recent model messages without including image payloads."""

    visible = copy.deepcopy(messages[-max_messages:])
    for message in visible:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if isinstance(part, dict) and part.get("type") in {"image_url", "input_image"}:
                part["image_url"] = "[IMAGE]"
    logger.debug("Model messages: {}", json.dumps(visible, ensure_ascii=False, default=str))
