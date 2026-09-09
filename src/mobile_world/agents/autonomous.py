"""Autonomous browser policy on the maintained multi-model GUI agent."""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from jinja2 import Template

from mobile_world.agents.implementations.general_e2e_agent import GeneralE2EAgentMCP
from mobile_world.runtime.utils.models import JSONAction

logger = logging.getLogger("mobile_world.autonomous.agent")

AUTONOMOUS_PROMPT = Template("""You control the full browser shown in screenshots.
Return actions using the following schema:
- Click: {"action_type":"click","coordinate":[x,y]}
- Double-click: {"action_type":"double_tap","coordinate":[x,y]}
- Drag: {"action_type":"drag","start_coordinate":[x1,y1],"end_coordinate":[x2,y2]}
- Swipe: {"action_type":"swipe","direction":"up|down|left|right"}
- Scroll: {"action_type":"scroll","direction":"up|down|left|right"}
- Type: {"action_type":"input_text","text":"text"}
- Key: {"action_type":"keyboard_enter","keycode":"KEYCODE_ENTER"}
- Back: {"action_type":"navigate_back"}
- Home: {"action_type":"navigate_home"}
- Wait: {"action_type":"wait"}
- End task: {"action_type":"answer","text":"reason"}
Coordinates use the screenshot's top-left as the origin.
{% if scale_factor is iterable and scale_factor is not string -%}
Use screenshot pixels: width={{ scale_factor[0] }}, height={{ scale_factor[1] }}.
{% else -%}
Normalize both axes to [0, {{ scale_factor }}].
{% endif %}
Keyboard names start with KEYCODE_, including KEYCODE_TAB, KEYCODE_ESCAPE,
and KEYCODE_Meta+l for the address bar.
Thought: [concise state and plan]
Action: [JSON action]
""")


class AutonomousVisualAgent(GeneralE2EAgentMCP):
    def __init__(
        self,
        model_name: str,
        llm_base_url: str = "",
        api_key: str = "",
        history_n_images: int | None = None,
    ):
        super().__init__(
            model_name,
            llm_base_url,
            api_key,
            runtime_conf={"history_n_images": history_n_images},
            tools=[],
        )
        if self.history_n_images is not None and self.history_n_images < 0:
            raise ValueError("history_n_images must be non-negative or None")
        self._request_id = 0

    def _get_system_prompt(self, active_scale_factor: int | tuple[int, int]) -> str:
        return AUTONOMOUS_PROMPT.render(
            scale_factor=active_scale_factor,
        )

    def _defer_queued_action(self, action: dict[str, Any]) -> bool:
        return False

    def get_framework_metadata(self) -> dict[str, Any]:
        return {
            **super().get_framework_metadata(),
            "history_n_images": self.history_n_images,
            "agent_version": "autonomous-general-e2e-v4",
            "history_unit": "model_call",
            "prompt_version": "longpuzzlebench-autonomous-v5",
            "coordinate_space": "screenshot_pixels"
            if self._use_pixel_coordinates
            or self._use_adaptive_resize
            or "claude" in self.model_name.lower()
            else "normalized",
            "execution_coordinate_space": "original_screenshot_pixels",
            "api_mode": "responses" if self.use_responses_api else "chat_completions",
        }

    def initialize_hook(self, instruction: str) -> None:
        super().initialize_hook(instruction)
        self._request_id = 0

    def predict(self, observation: dict[str, Any]) -> tuple[str, JSONAction]:
        if self.pending_actions:
            thought, raw_action, action, action_dict = self.pending_actions.popleft()
            self.actions.append(action_dict)
            logger.info(
                "Executing queued action (%d remaining): %s", len(self.pending_actions), action_dict
            )
            response = f"Thought: {thought}\nAction: {raw_action}" if thought else raw_action
            return response, action

        histories = (self.history_images, self.history_responses, self.actions)
        lengths = [len(history) for history in histories]
        pending = tuple(self.pending_actions)
        try:
            response, action = super().predict({"screenshot": observation["screenshot"]})
            self.history_responses[-1] = {"role": "assistant", "content": response}
            return response, action
        except Exception:
            # A failed prediction must not commit history or unexecuted queued actions.
            for history, length in zip(histories, lengths, strict=True):
                del history[length:]
            self.pending_actions.clear()
            self.pending_actions.extend(pending)
            raise

    def _logged_request(self, transport, model, messages, **kwargs):
        self._request_id += 1
        request_id = self._request_id
        screenshot = self.history_images[-1][0]
        image_count = sum(
            part.get("type") == "image_url"
            for message in messages
            if isinstance(message.get("content"), list)
            for part in message["content"]
        )
        logger.info(
            "Sending model request %d: model=%s messages=%d screenshots=%d current=%dx%d",
            request_id,
            model,
            len(messages),
            image_count,
            screenshot.width,
            screenshot.height,
        )
        if logger.isEnabledFor(logging.DEBUG):
            preview = [
                {
                    **message,
                    "content": [
                        {"type": "image_url", "image_url": "[screenshot omitted]"}
                        if part["type"] == "image_url"
                        else part
                        for part in message["content"]
                    ],
                }
                if isinstance(message["content"], list)
                else message
                for message in messages
            ]
            logger.debug(
                "Model request %d messages:\n%s",
                request_id,
                json.dumps(preview, ensure_ascii=False, indent=2),
            )
        started = time.monotonic()
        try:
            raw = transport(model=model, messages=messages, **kwargs)
        except Exception as exc:
            logger.error(
                "Model request %d failed after %.2fs: %s",
                request_id,
                time.monotonic() - started,
                type(exc).__name__,
            )
            raise RuntimeError(type(exc).__name__) from None
        logger.info("Model response %d (%.2fs):\n%s", request_id, time.monotonic() - started, raw)
        return raw

    def openai_chat_completions_create(self, model, messages, **kwargs):
        return self._logged_request(
            super().openai_chat_completions_create, model, messages, **kwargs
        )

    def openai_responses_create(self, model, messages, **kwargs):
        return self._logged_request(super().openai_responses_create, model, messages, **kwargs)
