"""Provider-neutral configuration for OpenAI-compatible model endpoints."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlparse

KNOWN_PROVIDERS = ("openai", "openrouter", "openai-compatible")


def resolve_provider_name(
    explicit: str | None = None,
    *,
    base_url: str | None = None,
    environ: Mapping[str, str] | None = None,
) -> str:
    """Return a public provider label without exposing endpoint details."""

    env = environ if environ is not None else os.environ
    raw = (explicit or env.get("LONGPUZZLEBENCH_PROVIDER") or "").strip().lower()
    if raw:
        if raw not in KNOWN_PROVIDERS:
            raise ValueError(f"Unknown provider {raw!r}; choose from {', '.join(KNOWN_PROVIDERS)}")
        return raw
    host = (urlparse(base_url or "").hostname or "").lower()
    if host == "api.openai.com" or host.endswith(".openai.com"):
        return "openai"
    if host == "openrouter.ai" or host.endswith(".openrouter.ai"):
        return "openrouter"
    return "openai-compatible"


def apply_provider_settings(args: Any) -> None:
    """Fill model transport settings from documented environment variables."""

    if not getattr(args, "model_name", None):
        args.model_name = os.getenv("LONGPUZZLEBENCH_MODEL")
    if not getattr(args, "llm_base_url", None):
        args.llm_base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    if not getattr(args, "api_key", None):
        args.api_key = os.getenv("OPENAI_API_KEY")
    args.provider = resolve_provider_name(
        getattr(args, "provider", None), base_url=args.llm_base_url
    )
