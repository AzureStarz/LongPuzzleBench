from __future__ import annotations

import pytest

from mobile_world.agents.implementations.general_e2e_agent import (
    parse_action,
    parse_actions,
    parse_response_to_action,
)
from mobile_world.agents.utils.action_parsing import (
    extract_exactly_one_json_tag,
    parse_single_json_object,
    require_exactly_one,
    split_exactly_one_marker,
)


def test_parse_single_json_object_accepts_fenced_object() -> None:
    assert parse_single_json_object('```json\n{"action_type":"wait"}\n```') == {
        "action_type": "wait"
    }


@pytest.mark.parametrize("payload", ['{"a":1}{"b":2}', "[]", 'text {"a":1}'])
def test_parse_single_json_object_rejects_ambiguous_payload(payload: str) -> None:
    with pytest.raises(ValueError):
        parse_single_json_object(payload)


def test_strict_marker_and_tag_helpers() -> None:
    assert split_exactly_one_marker("Thought: inspect\nAction: {}", "Action:") == (
        "Thought: inspect\n",
        " {}",
    )
    assert extract_exactly_one_json_tag('<action>{"x":1}</action>', "action") == {"x": 1}
    assert require_exactly_one([3]) == 3
    with pytest.raises(ValueError):
        require_exactly_one([1, 2])


def test_parse_action_accepts_thought_and_bare_json() -> None:
    assert parse_action('Thought: wait\nAction: {"action_type":"wait"}') == (
        "wait",
        '{"action_type":"wait"}',
    )
    assert parse_action('{"action_type":"wait"}') == ("", '{"action_type":"wait"}')


def test_parse_actions_preserves_order() -> None:
    response = """Thought: select
Action: {"action_type":"click","coordinate":[100,200]}
Thought: move
Action: {"action_type":"click","coordinate":[300,400]}"""
    assert parse_actions(response) == [
        ("select", '{"action_type":"click","coordinate":[100,200]}'),
        ("move", '{"action_type":"click","coordinate":[300,400]}'),
    ]


def test_coordinate_actions_are_scaled_to_screenshot() -> None:
    click = parse_response_to_action(
        '{"action_type":"click","coordinate":[500,250]}',
        image_width=1080,
        image_height=1920,
        scale_factor=1000,
    )
    assert click == {"action_type": "click", "x": 540, "y": 480}
    drag = parse_response_to_action(
        '{"action_type":"drag","start_coordinate":[0,0],"end_coordinate":[1000,1000]}',
        image_width=540,
        image_height=960,
        scale_factor=1000,
    )
    assert drag == {
        "action_type": "drag",
        "start_x": 0,
        "start_y": 0,
        "end_x": 540,
        "end_y": 960,
    }
