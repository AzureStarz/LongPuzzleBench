import json
import os
import time
from collections import deque
from typing import Any

from loguru import logger

from mobile_world.agents.base import MCPAgent
from mobile_world.agents.providers.catalog import resolve_provider_name
from mobile_world.agents.utils.action_parsing import (
    parse_single_json_object,
    split_exactly_one_marker,
)
from mobile_world.agents.utils.helpers import pil_adaptive_resize, pil_to_base64
from mobile_world.agents.utils.interaction_history import (
    keep_historical_screenshot,
    observation_interaction_feedback,
)
from mobile_world.agents.utils.prompts import GENERAL_E2E_PROMPT_TEMPLATE
from mobile_world.runtime.utils.helpers import mask_api_key, pretty_print_messages
from mobile_world.runtime.utils.models import JSONAction

ACTION_ALIASES = {
    "click": ["tap", "touch"],
    "long_press": ["long tap", "long press", "hold"],
    "input_text": ["type", "enter_text", "write", "enter"],
    "swipe": ["fling"],
    "keyboard_enter": ["enter"],
}
NORMALIZED_ACTION_MAP = {}
for standard_action, aliases in ACTION_ALIASES.items():
    NORMALIZED_ACTION_MAP[standard_action] = standard_action
    for alias in aliases:
        NORMALIZED_ACTION_MAP[alias.replace(" ", "_")] = standard_action
        NORMALIZED_ACTION_MAP[alias] = standard_action

CLAUDE_IMAGE_SIZE = (1280, 720)
CLAUDE_OPUS_MAX_DIMENSION = 1280


def uses_openai_responses_api(model_name: str) -> bool:
    """Use Responses except for Claude, which only supports chat completions."""

    return "claude" not in (model_name or "").lower()


def uses_screenshot_pixel_coordinates(model_name: str) -> bool:
    """GPT-5.6 variants all ground on the screenshot pixel grid."""

    model_id = model_name.lower().rsplit("/", 1)[-1]
    return model_id == "gpt-5.6" or model_id.startswith("gpt-5.6-")


def normalize_action_type(action_type: str) -> str:
    if not action_type:
        return None
    processed_type = action_type.lower().strip().replace(" ", "_")
    return NORMALIZED_ACTION_MAP.get(processed_type, action_type)


def parse_action(plan_output: str) -> tuple[str, str]:
    """
    Parse the Thought and Action from agent output.

    Expected format:
    Thought: [analysis]
    Action: [json_action]

    Reasoning models keep their analysis in a separate reasoning item and emit
    only the action payload, so a bare action is accepted with an empty thought.

    Args:
        plan_output: Raw output from agent

    Returns:
        Tuple of (thought, action)
    """
    try:
        candidate = plan_output.strip()
        if "Action:" not in candidate and candidate.startswith(("{", "```")):
            return "", candidate

        thought_text, action_text = split_exactly_one_marker(plan_output, "Action:")
        thought_part = thought_text.strip()
        if thought_part.startswith("Thought:"):
            thought = thought_part[8:].strip()  # Remove 'Thought:' prefix
        else:
            thought = thought_part

        action = action_text.strip()

        return thought, action

    except Exception as e:
        logger.error(f"Error parsing output: {e}")
        logger.debug(f"Output: {plan_output}")
        raise ValueError(f"Output is not in the correct format: {e}")


def _decode_action_at(text: str, start: int) -> tuple[str, int]:
    """Decode one JSON action beginning at or after ``start``."""

    position = start
    while position < len(text) and text[position].isspace():
        position += 1
    if text[position : position + 3] == "```":
        fence_end = text.find("```", position + 3)
        if fence_end < 0:
            raise ValueError("Unclosed JSON code fence")
        payload = text[position : fence_end + 3]
        parse_single_json_object(payload)
        return payload.strip(), fence_end + 3

    decoder = json.JSONDecoder()
    try:
        value, end = decoder.raw_decode(text, position)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid action JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("Action JSON must be an object")
    return text[position:end].strip(), end


def _thought_text(value: str) -> str:
    thought = value.strip()
    if thought.startswith("Thought:"):
        thought = thought[len("Thought:") :].strip()
    return thought


def parse_actions(plan_output: str) -> list[tuple[str, str]]:
    """Parse one or more ordered Thought/Action pairs from one model response.

    A final bare JSON object is also accepted. This covers reasoning-model
    responses that append a terminal status action without another marker.
    """

    text = plan_output.strip()
    if not text:
        raise ValueError("Model output is empty")

    parsed: list[tuple[str, str]] = []
    cursor = 0
    marker = "Action:"
    while True:
        marker_start = text.find(marker, cursor)
        if marker_start < 0:
            break
        action_text, action_end = _decode_action_at(text, marker_start + len(marker))
        parsed.append((_thought_text(text[cursor:marker_start]), action_text))
        cursor = action_end

    # Accept bare JSON output and concatenated terminal JSON objects, but do
    # not silently discard prose after the final marked action.
    while cursor < len(text):
        while cursor < len(text) and text[cursor].isspace():
            cursor += 1
        if cursor >= len(text):
            break
        if text.startswith("Thought:", cursor):
            raise ValueError("Thought block is missing its following Action marker")
        action_text, cursor = _decode_action_at(text, cursor)
        parsed.append(("", action_text))

    if not parsed:
        raise ValueError("Expected at least one action; found 0")
    return parsed


def parse_response_to_action(
    action_str: str,
    image_width: int,
    image_height: int,
    scale_factor: int | tuple[int, int] = 1000,
) -> dict:
    """
    Parse the JSON action from response and normalize it.
    Convert relative coordinates (0-999) to absolute coordinates based on image size.

    Args:
        action_str: JSON action string from model
        image_width: Width of the screenshot image
        image_height: Height of the screenshot image
        scale_factor: Scale factor for the coordinates
    Returns:
        Dictionary with action type and absolute coordinates
    """
    try:
        action_data = parse_single_json_object(action_str)
        original_action_type = action_data.get("action_type")
        normalized_action_type = normalize_action_type(original_action_type)

        if not normalized_action_type:
            raise ValueError("Action type is missing or empty.")

        action_data["action_type"] = normalized_action_type
        action_type = normalized_action_type
        scale_factor_x, scale_factor_y = (
            [scale_factor, scale_factor] if isinstance(scale_factor, int) else scale_factor
        )

        # Handle coordinate-based actions
        if action_type in ["click", "double_tap", "long_press", "press", "release"]:
            # Ensure coordinate is present
            if "coordinate" in action_data:
                coord = action_data["coordinate"]
                if isinstance(coord, list) and len(coord) == 2:
                    # Convert relative coordinates (0-999) to absolute coordinates
                    relative_x, relative_y = coord[0], coord[1]

                    absolute_x = int(relative_x * image_width / scale_factor_x)
                    absolute_y = int(relative_y * image_height / scale_factor_y)

                    logger.debug(
                        f"Coordinate conversion: relative ({relative_x}, {relative_y}) -> absolute ({absolute_x}, {absolute_y})"
                    )

                    return {
                        "action_type": action_type,
                        "x": absolute_x,
                        "y": absolute_y,
                    }
                else:
                    raise ValueError(f"Invalid coordinate format: {coord}")
            elif action_type == "release":
                return {"action_type": "release"}
            else:
                raise ValueError(f"Missing coordinate for action type: {action_type}")

        # Handle drag/swipe actions with explicit endpoints. A direction-only
        # swipe is preserved so environments can choose a suitable gesture
        # origin and distance.
        elif action_type in {"drag", "swipe"}:
            if "start_coordinate" in action_data and "end_coordinate" in action_data:
                start_coord = action_data["start_coordinate"]
                end_coord = action_data["end_coordinate"]
                if (
                    isinstance(start_coord, list)
                    and len(start_coord) == 2
                    and isinstance(end_coord, list)
                    and len(end_coord) == 2
                ):
                    # Convert relative coordinates (0-999) to absolute coordinates
                    relative_start_x, relative_start_y = start_coord[0], start_coord[1]
                    relative_end_x, relative_end_y = end_coord[0], end_coord[1]

                    absolute_start_x = int(relative_start_x * image_width / scale_factor_x)
                    absolute_start_y = int(relative_start_y * image_height / scale_factor_y)
                    absolute_end_x = int(relative_end_x * image_width / scale_factor_x)
                    absolute_end_y = int(relative_end_y * image_height / scale_factor_y)

                    logger.debug(
                        f"Drag coordinate conversion: relative ({relative_start_x}, {relative_start_y}) -> ({relative_end_x}, {relative_end_y}) | absolute ({absolute_start_x}, {absolute_start_y}) -> ({absolute_end_x}, {absolute_end_y})"
                    )

                    return {
                        "action_type": action_type,
                        "start_x": absolute_start_x,
                        "start_y": absolute_start_y,
                        "end_x": absolute_end_x,
                        "end_y": absolute_end_y,
                    }
                else:
                    raise ValueError(
                        f"Invalid {action_type} coordinates: {start_coord}, {end_coord}"
                    )
            elif action_type == "swipe" and action_data.get("direction") in {
                "up",
                "down",
                "left",
                "right",
            }:
                return action_data
            else:
                raise ValueError(f"Missing coordinates for {action_type} action")

        # Handle other action types
        elif action_type in [
            "open_app",
            "answer",
            "navigate_home",
            "navigate_back",
            "scroll",
            "wait",
            "ask_user",
            "keyboard_enter",
        ]:
            return action_data
        elif action_type == "input_text":
            return {
                "action_type": "input_text",
                "text": action_data.get("text", ""),
            }
        elif action_type == "status":
            return {
                "action_type": "answer",
                "text": "task finished"
                if action_data.get("goal_status") == "complete"
                else "task failed",
            }
        else:
            return action_data

    except json.JSONDecodeError as e:
        logger.error(f"Error parsing JSON action: {e}")
        raise ValueError(f"Invalid JSON format in action: {action_str}")
    except Exception as e:
        logger.error(f"Error parsing action: {e}")
        raise ValueError(f"Error parsing action: {e}") from e


class GeneralE2EAgentMCP(MCPAgent):
    def __init__(
        self,
        model_name: str,
        llm_base_url: str,
        api_key: str = "",
        observation_type: str = "screenshot",
        runtime_conf: dict[str, Any] | None = None,
        tools: list[dict] | None = None,
        scale_factor: int = 1000,
        model_provider: str | None = None,
        **kwargs,
    ):
        super().__init__(tools=tools or [], **kwargs)

        # Agent parameters
        self.model_name = model_name
        self.llm_base_url = llm_base_url
        self.api_key = api_key
        self.model_provider = resolve_provider_name(model_provider, base_url=llm_base_url)
        self.observation_type = observation_type
        self._framework_runtime_conf = {
            "history_n_images": None,
            "temperature": 0.0,
            "max_tokens": 2048,
            "reasoning_effort": "medium",
            **dict(runtime_conf or {}),
        }
        self.runtime_conf = dict(self._framework_runtime_conf)
        self.reasoning_effort = str(self.runtime_conf.pop("reasoning_effort", "medium"))
        self.mini_game_mode = bool(self.runtime_conf.pop("mini_game_mode", False))
        self.use_responses_api = uses_openai_responses_api(self.model_name)
        # GPT-5.6 grounds on the screenshot's own pixel grid. Asking any of its
        # variants (sol/luna/terra) to normalize to [0, 1000] silently rescales
        # coordinates that were already in image pixels.
        self._use_pixel_coordinates = uses_screenshot_pixel_coordinates(self.model_name)
        self._framework_runtime_conf.update(
            {
                "api_mode": "responses" if self.use_responses_api else "chat_completions",
                "reasoning_effort": (self.reasoning_effort if self.use_responses_api else None),
                "coordinate_space": (
                    "screenshot_pixels" if self._use_pixel_coordinates else "normalized"
                ),
                "mini_game_mode": self.mini_game_mode,
            }
        )
        self.scale_factor = scale_factor
        self._use_adaptive_resize = False
        if "opus-4" in self.model_name.lower() or "opus_4" in self.model_name.lower():
            self._use_adaptive_resize = True
        elif "claude" in self.model_name.lower():
            self.scale_factor = CLAUDE_IMAGE_SIZE
        if "kimi-k" in self.model_name.lower():
            self.scale_factor = 1

        logger.debug(f"Agent runtime_conf = {self.runtime_conf}")
        if self._use_adaptive_resize:
            logger.debug(f"Agent uses adaptive resize (max_dimension={CLAUDE_OPUS_MAX_DIMENSION})")
        else:
            logger.debug(f"Agent scale_factor = {self.scale_factor}")

        self.build_openai_client(self.llm_base_url, self.api_key)
        logger.debug(f"Agent base_url={self.llm_base_url} model={self.model_name}")

        self._framework_runtime_conf.pop("history_turns", None)
        self.runtime_conf.pop("history_turns", None)
        self.history_n_images = self.runtime_conf.pop("history_n_images", None)
        if os.getenv("HISTORY_N_IMAGES") is not None:
            self.history_n_images = int(os.getenv("HISTORY_N_IMAGES"))

        self.history_images = []
        self.history_responses = []
        self.actions = []
        self.pending_actions: deque[tuple[str, str, JSONAction, dict[str, Any]]] = deque()

    def initialize_hook(self, instruction: str) -> None:
        """Hook for initializing the agent with instruction."""
        logger.info(f"Initializing general E2E agent with instruction: {instruction}")
        # Reset history when initializing with new instruction
        self.reset()

    def _get_user_message(
        self, img_data, tool_call_res, ask_user_response_res, instruction: str | None = None
    ) -> dict:
        del tool_call_res, ask_user_response_res
        content = []
        # The first turn still carries the task text. Later observations are
        # screenshot-only so the model must judge action effects visually.
        if instruction is not None:
            content.append(
                {
                    "type": "text",
                    "text": instruction,
                }
            )
        content.append(
            {
                "type": "image_url",
                "image_url": img_data,
            }
        )
        return {
            "role": "user",
            "content": content,
        }

    def _hide_history_images(self, messages) -> list[dict]:
        num_images_used = 0
        for i in range(len(messages)):
            reverse_i = len(messages) - i - 1
            if messages[reverse_i]["role"] == "user":
                img_item_idx = None
                for idx, content in enumerate(messages[reverse_i]["content"]):
                    if content["type"] == "image_url":
                        img_item_idx = idx
                if img_item_idx is not None:
                    # ``history_n_images`` counts completed historical pairs;
                    # the current screenshot is always an additional image.
                    if keep_historical_screenshot(self.history_n_images, num_images_used):
                        encoded_string = pil_to_base64(
                            messages[reverse_i]["content"][img_item_idx]["image_url"]
                        )
                        # OpenAI-compatible Chat Completions image part.
                        messages[reverse_i]["content"][img_item_idx]["image_url"] = {
                            "url": f"data:image/png;base64,{encoded_string}"
                        }
                        num_images_used += 1
                    else:
                        messages[reverse_i]["content"][img_item_idx] = {
                            "type": "text",
                            "text": "(Previous turn, screen not shown)",
                        }

        return messages

    def predict(
        self,
        observation: dict[str, Any],
    ) -> tuple[str, JSONAction]:
        """
        Generate action with coordinates based on the current observation.

        Args:
            observation: Observation containing screenshot

        Returns:
            Tuple of (raw_response, JSONAction)
        """

        orig_width, orig_height = observation["screenshot"].size
        if self._use_adaptive_resize:
            obs_image, _, _ = pil_adaptive_resize(
                observation["screenshot"], CLAUDE_OPUS_MAX_DIMENSION
            )
            active_scale_factor = obs_image.size  # (resized_w, resized_h)
        elif "claude" in self.model_name.lower():
            obs_image = observation["screenshot"].resize(CLAUDE_IMAGE_SIZE)
            active_scale_factor = self.scale_factor
        else:
            obs_image = observation["screenshot"]
            active_scale_factor = (
                obs_image.size if self._use_pixel_coordinates else self.scale_factor
            )
        tool_call = observation_interaction_feedback(observation)
        ask_user_response = observation.get("ask_user_response", None)

        self.history_images.append((obs_image, tool_call, ask_user_response))

        logger.debug(f"Current history images count: {len(self.history_images)}")
        logger.debug(f"Current history responses count: {len(self.history_responses)}")

        assert len(self.history_images) == len(self.history_responses) + 1
        if self.pending_actions:
            thought, raw_action, action, action_dict = self.pending_actions.popleft()
            queued_response = f"Thought: {thought}\nAction: {raw_action}" if thought else raw_action
            self.history_responses.append({"role": "assistant", "content": queued_response})
            self.actions.append(action_dict)
            logger.info(
                "Executing queued action ({} remaining): {}",
                len(self.pending_actions),
                action_dict,
            )
            return queued_response, action

        messages = [
            {
                "role": "system",
                "content": GENERAL_E2E_PROMPT_TEMPLATE.render(
                    tools="\n".join([json.dumps(tool, ensure_ascii=False) for tool in self.tools]),
                    scale_factor=active_scale_factor,
                    allow_multi_action=self.use_responses_api,
                    mini_game=self.mini_game_mode,
                ),
            },
            # UPDATED 2026-04-21: user instruction may get ignored by opus-4.7 occasionally,
            # migrated user instruction from system prompt to user prompt!
            self._get_user_message(
                self.history_images[0][0],
                self.history_images[0][1],
                self.history_images[0][2],
                instruction=self.instruction,
            ),
        ]
        for i, history_resp in enumerate(self.history_responses):
            history_img_data, tool_call_res, ask_user_response_res = self.history_images[i + 1]

            user_message = self._get_user_message(
                history_img_data, tool_call_res, ask_user_response_res
            )

            response_message = {
                "role": "assistant",
                "content": [{"type": "text", "text": history_resp.get("content", "")}],
            }

            messages.append(response_message)
            messages.append(user_message)

        logger.debug(f"Constructed {len(messages) // 2} history turns.")
        messages = self._hide_history_images(messages)

        pretty_print_messages(messages, max_messages=10)
        logger.debug("*" * 100)

        try_times = 3
        response = None
        action_candidates: list[tuple[str, str]] | None = None

        while try_times > 0:
            try:
                if self.use_responses_api:
                    response = self.openai_responses_create(
                        model=self.model_name,
                        messages=messages,
                        retry_times=3,
                        reasoning_effort=self.reasoning_effort,
                        **self.runtime_conf,
                    )
                else:
                    response = self.openai_chat_completions_create(
                        model=self.model_name,
                        messages=messages,
                        retry_times=1,
                        **self.runtime_conf,
                    )
                logger.info(f"\nRaw LLM response received:\n{response}")

                action_candidates = parse_actions(response)

                break

            except Exception as e:
                logger.warning(
                    f"Error fetching response from agent: {self.model_name}, {self.llm_base_url}, {mask_api_key(self.api_key)}"
                )

                error_msg = str(e)
                try_times -= 1
                logger.warning(
                    f"Error fetching response from agent: {error_msg}. Retrying... ({try_times} attempts left)"
                )
                if "timeout" in error_msg.lower() or "connection" in error_msg.lower():
                    time.sleep(2)

        if response is None:
            raise ValueError("Agent LLM failed")
        if not action_candidates:
            self.history_responses.append({"role": "assistant", "content": response})
            return response, JSONAction(
                action_type="unknown", text="parse_error: missing valid Action payload"
            )

        logger.debug(f"Image size: {orig_width}x{orig_height}")

        try:
            parsed_batch = [
                (
                    thought,
                    action_str,
                    parse_response_to_action(
                        action_str, orig_width, orig_height, active_scale_factor
                    ),
                )
                for thought, action_str in action_candidates
            ]

        except Exception as e:
            logger.error(f"Error parsing agent response: {e}")
            self.history_responses.append({"role": "assistant", "content": response})
            return response, JSONAction(action_type="unknown", text=f"parse_error: {e}")

        thought, action_str, json_action_dict = parsed_batch[0]
        first_history_response = (
            f"Thought: {thought}\nAction: {action_str}" if thought else action_str
        )
        self.history_responses.append({"role": "assistant", "content": first_history_response})
        self.actions.append(json_action_dict)
        for queued_thought, queued_raw, queued_dict in parsed_batch[1:]:
            # A terminal decision made before the preceding GUI actions run is
            # necessarily speculative. Do not let a stale batched ``status``
            # or ``answer`` terminate the episode; after the safe prefix has
            # executed, the next predict call will ask the model again with
            # the latest screenshot. Since status actions normalize to answer,
            # checking the parsed action covers both forms.
            if queued_dict.get("action_type") == "answer":
                logger.info(
                    "Deferred terminal action from multi-action response; "
                    "the agent will re-evaluate completion after queued actions"
                )
                break
            self.pending_actions.append(
                (
                    queued_thought,
                    queued_raw,
                    JSONAction(**queued_dict),
                    queued_dict,
                )
            )
        logger.info(f"Parsed thought: {thought}")
        logger.info(f"Parsed action: {json_action_dict}")
        if self.pending_actions:
            logger.info(
                "Queued {} additional actions from the same model response",
                len(self.pending_actions),
            )
        logger.debug("Agent state updated for next turn.")

        return response, JSONAction(**json_action_dict)

    def reset(self):
        """Reset the agent for the next task."""
        self.history_images = []
        self.history_responses = []
        self.actions = []
        self.pending_actions = deque()
        logger.debug("Agent reset completed")
