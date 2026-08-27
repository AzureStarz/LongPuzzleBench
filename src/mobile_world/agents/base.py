"""Agent interfaces and OpenAI-compatible model transport for LongPuzzleBench."""

from __future__ import annotations

import hashlib
import json
import os
import time
from abc import ABC, abstractmethod
from typing import Any, cast

from openai import OpenAI

from mobile_world.agents.providers.catalog import resolve_provider_name
from mobile_world.runtime.utils.models import JSONAction

MODEL_TIMEOUT_SECONDS = 120.0


class BaseAgent(ABC):
    """Minimal agent contract used by the benchmark runner."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        del args, kwargs
        self._total_completion_tokens = 0
        self._total_prompt_tokens = 0
        self._total_cached_tokens = 0
        self._total_model_calls = 0
        self._total_model_latency_seconds = 0.0
        self._total_model_failures = 0
        self._total_estimated_cost = 0.0
        self._has_estimated_cost = False
        self.instruction: str | None = None

    def initialize(self, instruction: str) -> bool:
        self.instruction = instruction
        self.initialize_hook(instruction)
        return True

    def initialize_hook(self, instruction: str) -> None:
        """Optional per-episode initialization hook."""

    @abstractmethod
    def predict(self, observation: dict[str, Any]) -> tuple[str, JSONAction]:
        """Return a raw model response and one normalized GUI action."""

    def done(self) -> None:
        self.instruction = None
        self.reset()

    def reset(self) -> None:
        """Optional per-episode reset hook."""

    def build_openai_client(self, base_url: str, api_key: str) -> None:
        """Build an official OpenAI SDK client for OpenAI-compatible endpoints."""

        resolved_key = api_key or os.getenv("OPENAI_API_KEY", "")
        if not resolved_key:
            raise ValueError("OPENAI_API_KEY is required for the built-in general_e2e agent")
        kwargs: dict[str, Any] = {
            "api_key": resolved_key,
            "timeout": MODEL_TIMEOUT_SECONDS,
            "max_retries": 2,
        }
        if base_url:
            kwargs["base_url"] = base_url
        self.openai_client = OpenAI(**kwargs)

    def openai_chat_completions_create(
        self,
        model: str,
        messages: list[dict[str, Any]],
        retry_times: int = 3,
        stream: bool = False,
        **kwargs: Any,
    ) -> Any:
        """Call Chat Completions and record provider-neutral usage metrics."""

        del retry_times
        started_at = time.monotonic()
        self._total_model_calls += 1
        try:
            response = self.openai_client.chat.completions.create(
                model=model,
                messages=cast(Any, messages),
                stream=stream,
                **kwargs,
            )
            if stream:
                return response
            self._log_openai_usage(response)
            return (response.choices[0].message.content or "").strip()
        except Exception:
            self._total_model_failures += 1
            raise
        finally:
            self._total_model_latency_seconds += time.monotonic() - started_at

    @staticmethod
    def _responses_content_part(item: Any, *, role: str) -> dict[str, Any]:
        text_type = "output_text" if role == "assistant" else "input_text"
        if not isinstance(item, dict):
            return {"type": text_type, "text": str(item)}
        item_type = item.get("type")
        if item_type in {"text", "input_text", "output_text"}:
            return {"type": text_type, "text": str(item.get("text", ""))}
        if item_type in {"image_url", "input_image"}:
            image_url = item.get("image_url")
            if isinstance(image_url, dict):
                image_url = image_url.get("url")
            return {"type": "input_image", "image_url": str(image_url)}
        return dict(item)

    @classmethod
    def _responses_input(
        cls, messages: list[dict[str, Any]]
    ) -> tuple[str | None, list[dict[str, Any]]]:
        instructions: list[str] = []
        translated: list[dict[str, Any]] = []
        for message in messages:
            role = str(message["role"])
            content = message.get("content")
            if role in {"system", "developer"}:
                if isinstance(content, list):
                    instructions.extend(
                        str(item.get("text", ""))
                        for item in content
                        if isinstance(item, dict) and item.get("text")
                    )
                elif content:
                    instructions.append(str(content))
                continue
            if isinstance(content, list):
                content = [cls._responses_content_part(item, role=role) for item in content]
            translated.append({"role": role, "content": content})
        return "\n\n".join(instructions) or None, translated

    def openai_responses_create(
        self,
        model: str,
        messages: list[dict[str, Any]],
        retry_times: int = 3,
        reasoning_effort: str = "medium",
        **kwargs: Any,
    ) -> str:
        """Call the Responses API through the official OpenAI SDK."""

        del retry_times
        if "max_tokens" in kwargs:
            kwargs["max_output_tokens"] = kwargs.pop("max_tokens")
        if "max_completion_tokens" in kwargs:
            kwargs["max_output_tokens"] = kwargs.pop("max_completion_tokens")
        if reasoning_effort != "none":
            kwargs.pop("temperature", None)
            kwargs.pop("top_p", None)
        instructions, input_items = self._responses_input(messages)
        request: dict[str, Any] = {"model": model, "input": input_items, **kwargs}
        if instructions:
            request["instructions"] = instructions
        if reasoning_effort != "none":
            request["reasoning"] = {"effort": reasoning_effort}

        started_at = time.monotonic()
        self._total_model_calls += 1
        try:
            response = self.openai_client.responses.create(**request)
            self._log_openai_usage(response)
            return str(response.output_text or "").strip()
        except Exception:
            self._total_model_failures += 1
            raise
        finally:
            self._total_model_latency_seconds += time.monotonic() - started_at

    @staticmethod
    def _responses_output_text(response: Any) -> str:
        return str(getattr(response, "output_text", "") or "")

    def _log_openai_usage(self, response: Any) -> None:
        usage = getattr(response, "usage", None)
        if usage is None:
            return
        completion = int(
            getattr(usage, "completion_tokens", None) or getattr(usage, "output_tokens", None) or 0
        )
        prompt = int(
            getattr(usage, "prompt_tokens", None) or getattr(usage, "input_tokens", None) or 0
        )
        details = getattr(usage, "prompt_tokens_details", None) or getattr(
            usage, "input_tokens_details", None
        )
        cached = int(getattr(details, "cached_tokens", 0) or 0) if details else 0
        self._total_completion_tokens += completion
        self._total_prompt_tokens += prompt
        self._total_cached_tokens += cached

    def get_total_token_usage(self) -> dict[str, int]:
        return {
            "completion_tokens": self._total_completion_tokens,
            "prompt_tokens": self._total_prompt_tokens,
            "cached_tokens": self._total_cached_tokens,
            "total_tokens": self._total_completion_tokens + self._total_prompt_tokens,
        }

    def reset_token_usage(self) -> None:
        self._total_completion_tokens = 0
        self._total_prompt_tokens = 0
        self._total_cached_tokens = 0
        self._total_model_calls = 0
        self._total_model_latency_seconds = 0.0
        self._total_model_failures = 0
        self._total_estimated_cost = 0.0
        self._has_estimated_cost = False

    def get_benchmark_metrics(self) -> dict[str, Any]:
        return {
            "model_calls": self._total_model_calls,
            "input_tokens": self._total_prompt_tokens,
            "output_tokens": self._total_completion_tokens,
            "cached_tokens": self._total_cached_tokens,
            "total_tokens": self._total_prompt_tokens + self._total_completion_tokens,
            "model_latency_seconds": self._total_model_latency_seconds,
            "estimated_cost": None,
            "provider_failures": self._total_model_failures,
            "auxiliary_models": [],
        }

    def get_framework_metadata(self) -> dict[str, Any]:
        runtime_conf = getattr(self, "_framework_runtime_conf", {})
        serialized = json.dumps(
            {
                "class": type(self).__name__,
                "runtime_conf": runtime_conf,
                "scale_factor": getattr(self, "scale_factor", None),
            },
            sort_keys=True,
            default=str,
            separators=(",", ":"),
        )
        return {
            "model_name": str(getattr(self, "model_name", "")),
            "model_provider": resolve_provider_name(
                getattr(self, "model_provider", None),
                base_url=str(getattr(self, "llm_base_url", "") or ""),
            ),
            "agent_framework": "longpuzzlebench_native",
            "agent_framework_version": type(self).__name__,
            "agent_config_hash": hashlib.sha256(serialized.encode()).hexdigest(),
            "prompt_version": "longpuzzlebench-general-e2e-v1",
            "action_schema_version": "longpuzzlebench-json-action-v1",
            "temperature": runtime_conf.get("temperature"),
            "sampling_parameters": runtime_conf,
            "max_model_calls_per_step": 1,
            "interaction_mode": "screenshot_action",
        }


class MCPAgent(BaseAgent):
    """Compatibility base that exposes the environment's public tool schema."""

    def __init__(self, tools: list[dict[str, Any]], *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.tools = tools

    def reset_tools(self, tools: list[dict[str, Any]]) -> None:
        self.tools = tools
