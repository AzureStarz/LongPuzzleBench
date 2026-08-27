"""Screenshot-only smoke agent for the Bolt easy level-1 integration test.

This is intentionally test support rather than a production benchmark agent.
It never receives the evaluator bridge or game state; it only scales two known
design-space taps to the current observation image.
"""

from typing import Any

from mobile_world.agents.base import BaseAgent
from mobile_world.runtime.utils.models import CLICK, WAIT, JSONAction


class ScriptedBoltSmokeAgent(BaseAgent):
    """Replay the two public UI taps used by the real-browser smoke test."""

    _DESIGN_ACTIONS = ((270, 420), (400, 230))

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._index = 0
        self.observation_keys: list[set[str]] = []

    def initialize_hook(self, instruction: str) -> None:
        self._index = 0

    def predict(self, observation: dict[str, Any]) -> tuple[str, JSONAction]:
        self.observation_keys.append(set(observation))
        if self._index == len(self._DESIGN_ACTIONS):
            self._index += 1
            return (
                "wait for the board to leave the play area",
                JSONAction(action_type=WAIT, action_json={"duration": 2.0}),
            )
        if self._index > len(self._DESIGN_ACTIONS):
            return (
                "wait for the board to settle after the smoke sequence",
                JSONAction(action_type=WAIT, action_json={"duration": 2.0}),
            )

        width, height = observation["screenshot"].size
        design_x, design_y = self._DESIGN_ACTIONS[self._index]
        self._index += 1
        return (
            f"tap design coordinate ({design_x}, {design_y})",
            JSONAction(
                action_type=CLICK,
                x=round(design_x * width / 540),
                y=round(design_y * height / 960),
            ),
        )

    def reset(self) -> None:
        self._index = 0
