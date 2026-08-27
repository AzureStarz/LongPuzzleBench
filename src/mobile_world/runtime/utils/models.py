# models.py
"""Public GUI action and observation models for LongPuzzleBench."""

from typing import Any, Literal

from pydantic import BaseModel, field_validator

# Action type constants
ANSWER = "answer"
CLICK = "click"
TAP = "tap"
DOUBLE_TAP = "double_tap"
FINISHED = "finished"
INPUT_TEXT = "input_text"
KEYBOARD_ENTER = "keyboard_enter"
LONG_PRESS = "long_press"
PRESS = "press"
RELEASE = "release"
NAVIGATE_BACK = "navigate_back"
NAVIGATE_HOME = "navigate_home"
OPEN_APP = "open_app"
SCROLL = "scroll"
STATUS = "status"
SWIPE = "swipe"
UNKNOWN = "unknown"
WAIT = "wait"
DRAG = "drag"
ASK_USER = "ask_user"
MCP = "mcp"
ENV_FAIL = "error_env"
_ACTION_TYPES = (
    CLICK,
    TAP,
    DOUBLE_TAP,
    SCROLL,
    SWIPE,
    INPUT_TEXT,
    NAVIGATE_HOME,
    NAVIGATE_BACK,
    KEYBOARD_ENTER,
    OPEN_APP,
    STATUS,
    WAIT,
    LONG_PRESS,
    PRESS,
    RELEASE,
    ANSWER,
    FINISHED,
    UNKNOWN,
    DRAG,
    ASK_USER,
    MCP,
)

_SCROLL_DIRECTIONS = ("left", "right", "down", "up")

# Keys of JSON action
ACTION_TYPE = "action_type"
INDEX = "index"
X = "x"
Y = "y"
TEXT = "text"
DIRECTION = "direction"
APP_NAME = "app_name"
GOAL_STATUS = "goal_status"
START_X = "start_x"
START_Y = "start_y"
END_X = "end_x"
END_Y = "end_y"
ACTION_KEYS = [
    ACTION_TYPE,
    INDEX,
    X,
    Y,
    TEXT,
    DIRECTION,
    APP_NAME,
    GOAL_STATUS,
    START_X,
    START_Y,
    END_X,
    END_Y,
]


class JSONAction(BaseModel):
    """Represents a parsed JSON action.

    Example:
        result_json = {'action_type': 'click', 'x': 100, 'y': 200}
        action = JSONAction(**result_json)

    Attributes:
        action_type: The action type.
        index: The index to click, if action is a click. Either an index or a <x, y>
            should be provided. See x, y attributes below.
        x: The x position to click, if the action is a click.
        y: The y position to click, if the action is a click.
        text: The text to type, if action is type.
        direction: The direction to scroll, if action is scroll.
        goal_status: If the status is a 'status' type, indicates the status of the goal.
        app_name: The app name to launch, if the action type is 'open_app'.
        keycode: Keycode actions are necessary for an agent to interact with complex
            UI elements (like large textareas) that can't be accessed or controlled by
            simply taping, ensuring precise control over navigation and selection in
            the interface.
        clear_text: Whether to clear the text field before typing.
        start_x: The x position to start drag, if the action is a drag.
        start_y: The y position to start drag, if the action is a drag.
        end_x: The x position to end drag, if the action is a drag.
        end_y: The y position to end drag, if the action is a drag.
    """

    action_type: str | None = None
    index: str | int | None = None
    x: int | None = None
    y: int | None = None
    text: str | None = None
    direction: str | None = None
    goal_status: str | None = None
    app_name: str | None = None
    keycode: str | None = None
    clear_text: bool | None = None
    start_x: int | None = None
    start_y: int | None = None
    end_x: int | None = None
    end_y: int | None = None
    action_name: str | None = None
    action_json: dict | None = None

    @field_validator("action_type")
    @classmethod
    def validate_action_type(cls, v: str | None) -> str | None:
        """Validate action type is valid."""
        if v is not None and v not in _ACTION_TYPES:
            raise ValueError(f"Invalid action type: {v}")
        return v

    @field_validator("index")
    @classmethod
    def validate_index(cls, v: str | int | None) -> int | None:
        """Convert index to int if needed."""
        if v is not None:
            return int(v)
        return v

    @field_validator("x", "y", mode="before")
    @classmethod
    def validate_coordinates(cls, v: int | float | None) -> int | None:
        """Convert float coordinates to int if needed."""
        if v is not None:
            return round(v)
        return v

    @field_validator("direction")
    @classmethod
    def validate_direction(cls, v: str | None) -> str | None:
        """Validate scroll direction is valid."""
        if v is not None and v not in _SCROLL_DIRECTIONS:
            raise ValueError(f"Invalid scroll direction: {v}")
        return v

    @field_validator("text", mode="before")
    @classmethod
    def validate_text(cls, v: Any) -> str | None:
        """Convert text to string if needed."""
        if v is not None and not isinstance(v, str):
            return str(v)
        return v

    @field_validator("keycode")
    @classmethod
    def validate_keycode(cls, v: str | None) -> str | None:
        """Validate keycode format."""
        if v is not None and not v.startswith("KEYCODE_"):
            raise ValueError(f"Invalid keycode: {v}")
        return v

    def model_post_init(self, __context: Any) -> None:
        """Additional validation after model initialization."""
        if self.index is not None:
            if self.x is not None or self.y is not None:
                raise ValueError("Either an index or a <x, y> should be provided.")

    def __eq__(self, other: object) -> bool:
        """Compare two JSONActions."""
        if not isinstance(other, JSONAction):
            return False
        return _compare_actions(self, other)

    def __ne__(self, other: object) -> bool:
        """Check if two JSONActions are not equal."""
        return not self.__eq__(other)


def _compare_actions(a: JSONAction, b: JSONAction) -> bool:
    """Compares two JSONActions.

    Args:
        a: The first action.
        b: The second action.

    Returns:
        If the actions are equal.
    """
    # Ignore cases for app_name and text.
    if a.app_name is not None and b.app_name is not None:
        app_name_match = a.app_name.lower() == b.app_name.lower()
    else:
        app_name_match = a.app_name == b.app_name

    if a.text is not None and b.text is not None:
        text_match = a.text.lower() == b.text.lower()
    else:
        text_match = a.text == b.text

    # Compare the non-metadata fields.
    return (
        app_name_match
        and text_match
        and a.action_type == b.action_type
        and a.index == b.index
        and a.x == b.x
        and a.y == b.y
        and a.keycode == b.keycode
        and a.direction == b.direction
        and a.goal_status == b.goal_status
        and a.start_x == b.start_x
        and a.start_y == b.start_y
        and a.end_x == b.end_x
        and a.end_y == b.end_y
    )


class Response(BaseModel):
    """Status returned by environment lifecycle operations."""

    status: str
    message: str


class ActionDispatchReceipt(BaseModel):
    """Environment acknowledgement for one attempted GUI action."""

    action_id: str
    attempted: bool = True
    accepted: bool = True
    completed: bool = True
    error_code: str | None = None
    error_message: str | None = None
    duration_ms: float = 0.0


class ObservationEffect(BaseModel):
    """Agent-visible effect measured between fresh screenshots."""

    pre_frame_id: int | None = None
    post_frame_id: int | None = None
    fresh_capture: bool = True
    stable: bool | None = None
    visual_changed: bool = False
    visual_change_ratio: float = 0.0
    returned_to_recent_frame: bool = False
    detected_cycle_length: int | None = None


PublicActionStatus = Literal[
    "screen_changed",
    "no_visible_effect",
    "returned_to_recent_screen",
    "repeating_visual_cycle",
    "wait_completed",
    "dispatch_failed",
    "observation_stale",
]


class PublicActionFeedback(BaseModel):
    """Least-privilege feedback exposed to an agent after one action."""

    type: Literal["gui_action_feedback"] = "gui_action_feedback"
    action_id: str
    status: PublicActionStatus
    executed: bool
    fresh_observation: bool
    cycle_length: int | None = None
    recovery_required: bool = False
    message: str | None = None


class Observation(BaseModel):
    """Screenshot-first observation supplied to GUI agents."""

    screenshot: Any
    accessibility_tree: Any = None
    ask_user_response: str | None = None
    tool_call: Any | None = None
    frame_id: int | None = None
    action_feedback: PublicActionFeedback | None = None
