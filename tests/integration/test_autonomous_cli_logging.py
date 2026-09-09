"""CLI console logging with the real browser and an offline model transport."""

import json
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.integration
def test_cli_logs_requests_and_outputs_without_polluting_result_json(tmp_path: Path):
    output = tmp_path / "episode"
    script = """
import json
import sys
from mobile_world.agents.base import BaseAgent
from mobile_world.core.cli import main
actions = iter([
    {"action_type": "click", "coordinate": [500, 751]},
    {"action_type": "finished"},
])
BaseAgent.openai_responses_create = lambda *args, **kwargs: json.dumps(next(actions))
sys.argv = ["longpuzzlebench", "autonomous", "--game", "maze_paint", "--difficulty", "easy",
            "--model", "qwen/qwen3.8-flash", "--capture-surface", "viewport", "--headless",
            "--timeout", "10", "--log-level", "DEBUG", "--output", sys.argv[1]]
main()
"""
    import os

    env = {**os.environ, "OPENAI_API_KEY": "logging-test-api-key"}
    completed = subprocess.run(
        [sys.executable, "-c", script, str(output)],
        env=env,
        capture_output=True,
        text=True,
        timeout=45,
        cwd=Path(__file__).resolve().parents[2],
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["termination_reason"] == "agent_terminated"
    assert "Sending model request 1" in completed.stderr
    assert "Model response 1" in completed.stderr
    assert '"action_type": "finished"' in completed.stderr
    assert "[screenshot omitted]" in completed.stderr
    assert "data:image" not in completed.stderr
    assert "logging-test-api-key" not in completed.stderr
    assert "Episode ended: agent_terminated" in completed.stderr
    assert (output / "events.jsonl").is_file()

    events = [json.loads(line) for line in (output / "events.jsonl").read_text().splitlines()]
    decisions = [event["data"] for event in events if event["type"] == "decision"]
    assert decisions[0]["action"]["x"] == 640
    assert decisions[0]["action"]["y"] == 675
    assert any(
        event["type"] == "snapshot" and event["data"].get("page") == "maze-paint-difficulty"
        for event in events
    )
