"""Agent registry with one maintained baseline and custom-file loading."""

from __future__ import annotations

import importlib.util
import inspect
import sys
from pathlib import Path
from typing import Any

from mobile_world.agents.base import BaseAgent
from mobile_world.agents.implementations.general_e2e_agent import GeneralE2EAgentMCP

AGENT_CONFIGS: dict[str, type[BaseAgent]] = {"general_e2e": GeneralE2EAgentMCP}


def load_agent_from_file(file_path: str) -> type[BaseAgent]:
    """Load the first concrete :class:`BaseAgent` subclass from a Python file."""

    path = Path(file_path).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Agent file not found: {path}")
    if path.suffix != ".py":
        raise ValueError(f"Agent file must use the .py extension: {path}")
    module_name = f"longpuzzlebench_custom_agent_{path.stem}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ValueError(f"Could not load agent module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    candidates = [
        cls
        for _, cls in inspect.getmembers(module, inspect.isclass)
        if issubclass(cls, BaseAgent) and cls is not BaseAgent and cls.__module__ == module_name
    ]
    if not candidates:
        raise ValueError(f"No BaseAgent subclass found in {path}")
    if len(candidates) > 1:
        names = ", ".join(cls.__name__ for cls in candidates)
        raise ValueError(f"Multiple BaseAgent subclasses found in {path}: {names}")
    return candidates[0]


def create_agent(
    agent_type: str,
    model_name: str,
    llm_base_url: str,
    api_key: str = "",
    **kwargs: Any,
) -> BaseAgent:
    """Create the built-in baseline or a custom agent loaded from a local file."""

    if agent_type == "unified_openai":
        raise ValueError("unified_openai is deprecated; use general_e2e")

    custom_path = Path(agent_type).expanduser()
    if agent_type.endswith(".py") or custom_path.exists():
        agent_class = load_agent_from_file(agent_type)
    else:
        try:
            agent_class = AGENT_CONFIGS[agent_type]
        except KeyError as exc:
            raise ValueError(
                f"Unsupported agent {agent_type!r}; use 'general_e2e' or a Python file"
            ) from exc

    constructor_kwargs = {
        "model_name": model_name,
        "llm_base_url": llm_base_url,
        "api_key": api_key,
        **kwargs,
    }
    if agent_class is GeneralE2EAgentMCP:
        env = constructor_kwargs.pop("env")
        constructor_kwargs["tools"] = list(env.tools)
    return agent_class(**constructor_kwargs)


__all__ = ["AGENT_CONFIGS", "create_agent", "load_agent_from_file"]
