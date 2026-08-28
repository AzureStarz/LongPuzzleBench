#!/usr/bin/env python3
"""Build the evidence bundle for the LongPuzzleBench trajectory article.

The article is grounded in environment transitions rather than episode length. This
script reads the 18 canonical public runs, verifies the matched states used in the
prose, derives recurrence counts, and exports a small, hashed set of real frames.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
from collections import Counter
from pathlib import Path
from typing import Any

from PIL import Image

PUBLIC_RUN_DIRS = {
    ("qwen/qwen3.8-27b", None): "qwen3.8-27b",
    ("moonshotai/kimi-k2.5", "max"): "kimi-k2.5-max",
    ("qwen/qwen3.5-122b-a10b", None): "qwen3.5-122b-a10b",
    ("qwen/qwen3.6-35b-a3b", None): "qwen3.6-35b-a3b",
    ("qwen/qwen3.5-397b-a17b", None): "qwen3.5-397b-a17b",
    ("z-ai/glm-4.6v", "max"): "glm-4.6v-max",
    ("qwen/qwen3-vl-235b-a22b-thinking", None): "qwen3-vl-235b-a22b-thinking",
    ("qwen/qwen3-vl-30b-a3b-thinking", None): "qwen3-vl-30b-a3b-thinking",
}
GAME_IDS = (
    "bolt_unscrew",
    "rush_hour_2",
    "nut_and_bolt",
    "truck_escape",
    "maze_paint",
    "color_connect",
)


def mark(x: float, y: float, w: float, h: float, label: str, tone: str = "note") -> dict[str, Any]:
    return {"x": x, "y": y, "width": w, "height": h, "label": label, "tone": tone}


# Coordinates are percentages of the original 1080×1920 observation. They annotate
# evidence; evaluator-state assertions below establish the empirical claims.
STORIES: dict[str, dict[str, Any]] = {
    "bolt_immediate": {
        "label": "Salient source",
        "tone": "failure",
        "run": "gpt-5.6-sol-medium",
        "task": "bolt_unscrew.hard.level_01.seed_0",
        "episode": "bolt_unscrew.hard.level_01.seed_0.run_001",
        "game": "bolt_unscrew",
        "difficulty": "hard",
        "frames": [
            (
                "post",
                8,
                "One uncovered destination remains.",
                "same state · 20.8% progress",
                [mark(61, 22, 9, 8, "only open hole", "warning")],
            ),
            (
                "post",
                9,
                "The exposed mid-right screw is selected.",
                "source: mid-right support",
                [mark(78, 36, 10, 10, "selected source", "danger")],
            ),
            (
                "pre",
                10,
                "The target is legal and visibly open.",
                "the fatal click looks correct",
                [mark(61, 22, 9, 8, "legal target", "warning")],
            ),
            (
                "post",
                10,
                "Progress rises; physics covers every empty source.",
                "29.2% progress · 0 legal moves",
                [mark(10, 37, 80, 18, "empty anchors covered", "danger")],
            ),
        ],
    },
    "bolt_deeper": {
        "label": "Deeper source",
        "tone": "success",
        "run": "qwen3.8-27b",
        "task": "bolt_unscrew.hard.level_01.seed_0",
        "episode": "bolt_unscrew.hard.level_01.seed_0.run_001",
        "game": "bolt_unscrew",
        "difficulty": "hard",
        "frames": [
            (
                "post",
                10,
                "Byte-identical board; the same destination is open.",
                "same state · 20.8% progress",
                [mark(61, 22, 9, 8, "same open hole", "warning")],
            ),
            (
                "post",
                11,
                "This run selects a deeper support screw.",
                "source: lower-center support",
                [mark(45, 53, 10, 10, "deeper source", "good")],
            ),
            (
                "post",
                12,
                "The same destination now preserves a usable source.",
                "27.1% progress · mobility survives",
                [mark(45, 53, 10, 10, "newly usable source", "good")],
            ),
            (
                "post",
                20,
                "Three more transfers follow before a later deadlock.",
                "50.0% progress · later deadlock",
                [],
            ),
        ],
    },
    "nut_dependency": {
        "label": "A capability agents already have",
        "tone": "success",
        "run": "gpt-5.6-sol-medium",
        "task": "nut_and_bolt.hard.level_02.seed_0",
        "episode": "nut_and_bolt.hard.level_02.seed_0.run_001",
        "game": "nut_and_bolt",
        "difficulty": "hard",
        "frames": [
            ("post", 4, "Both empty bolts are occupied.", "0 empty buffers", []),
            (
                "post",
                56,
                "Twenty-six valid transfers later, the chain is intact.",
                "0 empty buffers · no invalid transfer",
                [],
            ),
            (
                "post",
                58,
                "A bolt finally empties and restores workspace.",
                "workspace reopened",
                [mark(7, 54, 16, 20, "reopened", "good")],
            ),
        ],
    },
    "nut_repeat": {
        "label": "Repeats the postcondition error",
        "tone": "failure",
        "run": "qwen3.8-27b",
        "task": "nut_and_bolt.hard.level_01.seed_0",
        "episode": "nut_and_bolt.hard.level_01.seed_0.run_001",
        "game": "nut_and_bolt",
        "difficulty": "hard",
        "frames": [
            (
                "post",
                4,
                "Only one of two yellow nuts fits; one remains.",
                "truncated transfer: 1 of 2 moved",
                [
                    mark(12, 18, 12, 13, "target full", "danger"),
                    mark(34, 18, 12, 13, "1 remains", "warning"),
                ],
            ),
            (
                "post",
                5,
                "The remaining yellow is selected.",
                "source selected",
                [mark(34, 18, 12, 13, "selected source", "warning")],
            ),
            (
                "post",
                6,
                "The full target rejects it; selection persists.",
                "no state change",
                [
                    mark(12, 18, 12, 13, "still full", "danger"),
                    mark(34, 18, 12, 13, "still selected", "warning"),
                ],
            ),
            (
                "post",
                9,
                "A cycle warning arrives after the pair repeats.",
                "recovery warning",
                [mark(12, 18, 34, 13, "same source → target", "danger")],
            ),
            (
                "post",
                10,
                "The run clicks the full target again.",
                "move count unchanged since action 4",
                [mark(12, 18, 12, 13, "repeated target", "danger")],
            ),
        ],
    },
    "nut_repair": {
        "label": "Rebuilds the transfer",
        "tone": "success",
        "run": "gpt-5.6-sol-medium",
        "task": "nut_and_bolt.hard.level_01.seed_0",
        "episode": "nut_and_bolt.hard.level_01.seed_0.run_001",
        "game": "nut_and_bolt",
        "difficulty": "hard",
        "frames": [
            (
                "post",
                72,
                "The same error: only one of two purple nuts fits.",
                "truncated transfer: 1 of 2 moved",
                [
                    mark(33, 20, 12, 13, "1 remains", "warning"),
                    mark(27, 61, 12, 14, "target full", "danger"),
                ],
            ),
            (
                "post",
                73,
                "The remaining purple is selected.",
                "source selected",
                [mark(33, 20, 12, 13, "selected source", "warning")],
            ),
            (
                "post",
                74,
                "The full target rejects it and emits a warning.",
                "same postcondition failure",
                [mark(27, 61, 12, 14, "full", "danger")],
            ),
            (
                "post",
                75,
                "The source is cancelled and the flow reverses.",
                "representation updated",
                [mark(33, 20, 12, 13, "new destination", "good")],
            ),
            (
                "post",
                77,
                "Three purples move onto the lone purple.",
                "postcondition repaired · progress advances",
                [mark(33, 20, 12, 17, "complete stack", "good")],
            ),
        ],
    },
    "color_reserve": {
        "label": "Leaves the corridor open",
        "tone": "success",
        "run": "gpt-5.6-sol-high",
        "task": "color_connect.hard.level_01.seed_0",
        "episode": "color_connect.hard.level_01.seed_0.run_001",
        "game": "color_connect",
        "difficulty": "hard",
        "frames": [
            (
                "post",
                5,
                "Coral reaches row 2, column 5.",
                "matched active-path state",
                [
                    mark(60, 25, 8, 8, "coral tip", "warning"),
                    mark(60, 33, 8, 8, "future purple cell"),
                ],
            ),
            (
                "post",
                6,
                "It turns left before descending.",
                "row 3, column 5 stays empty",
                [mark(46, 25, 8, 8, "turn", "good"), mark(60, 33, 8, 8, "left open", "good")],
            ),
            (
                "post",
                7,
                "Coral descends through the neighboring column.",
                "corridor remains open",
                [mark(46, 33, 8, 8, "coral", "good"), mark(60, 33, 8, 8, "still empty", "good")],
            ),
            (
                "post",
                8,
                "Coral completes without occupying the shared cell.",
                "2 of 8 pairs",
                [mark(60, 33, 8, 8, "available", "good")],
            ),
            (
                "post",
                14,
                "Purple later uses the untouched cell.",
                "earlier route preserved capacity",
                [mark(60, 33, 8, 8, "purple route", "good")],
            ),
            (
                "post",
                33,
                "All eight paths connect without cancellation.",
                "success · 0 path cancellations",
                [],
            ),
        ],
    },
    "color_recreate": {
        "label": "Consumes and recreates it",
        "tone": "failure",
        "run": "gpt-5.6-sol-medium",
        "task": "color_connect.hard.level_01.seed_0",
        "episode": "color_connect.hard.level_01.seed_0.run_001",
        "game": "color_connect",
        "difficulty": "hard",
        "frames": [
            (
                "post",
                8,
                "Coral reaches the same matched state.",
                "matched active-path state",
                [
                    mark(60, 25, 8, 8, "coral tip", "warning"),
                    mark(60, 33, 8, 8, "future purple cell"),
                ],
            ),
            (
                "post",
                9,
                "Coral descends into the shared cell.",
                "legal now · corridor consumed",
                [mark(60, 33, 8, 8, "occupied", "danger")],
            ),
            (
                "post",
                10,
                "The path completes, but purple is boxed out.",
                "2 of 8 pairs",
                [mark(60, 33, 8, 8, "purple blocked", "danger")],
            ),
            (
                "post",
                11,
                "The agent names the conflict and deletes coral.",
                "path cancellation 1",
                [mark(60, 33, 8, 8, "freed again", "warning")],
            ),
            (
                "post",
                17,
                "It rebuilds the byte-identical coral path.",
                "same occupancy · second visit",
                [mark(60, 33, 8, 8, "same blocker", "danger")],
            ),
            (
                "post",
                23,
                "It creates that board a third time.",
                "same occupancy · third visit",
                [mark(60, 33, 8, 8, "same blocker again", "danger")],
            ),
        ],
    },
    "maze_recover": {
        "label": "Re-localizes",
        "tone": "success",
        "run": "gpt-5.6-terra-high",
        "task": "maze_paint.hard.level_01.seed_0",
        "episode": "maze_paint.hard.level_01.seed_0.run_001",
        "game": "maze_paint",
        "difficulty": "hard",
        "frames": [
            (
                "post",
                31,
                "One cell remains; the ball rests on row 10, column 2.",
                "matched state · 44 of 45 cells",
                [mark(43, 69, 9, 9, "last cell", "danger"), mark(7, 75, 9, 9, "ball")],
            ),
            (
                "post",
                32,
                "The ball moves right along row 10.",
                "actual position: row 10, column 7",
                [mark(43, 69, 9, 9, "target one row up", "danger"), mark(85, 75, 9, 9, "ball")],
            ),
            (
                "post",
                33,
                "It moves up to a stopping corridor.",
                "route changes rows",
                [mark(85, 61, 9, 9, "ball", "good")],
            ),
            (
                "post",
                34,
                "It slides left until aligned above the cell.",
                "column aligned",
                [mark(43, 61, 9, 9, "ball", "good"), mark(43, 69, 9, 9, "target", "danger")],
            ),
            (
                "post",
                35,
                "A downward slide crosses the final cell.",
                "success",
                [mark(43, 69, 9, 9, "painted", "good")],
            ),
        ],
    },
    "maze_stale": {
        "label": "Keeps the wrong row",
        "tone": "failure",
        "run": "kimi-k3-high",
        "task": "maze_paint.hard.level_01.seed_0",
        "episode": "maze_paint.hard.level_01.seed_0.run_001",
        "game": "maze_paint",
        "difficulty": "hard",
        "frames": [
            (
                "post",
                33,
                "The exact same one-cell-short state.",
                "matched state · 44 of 45 cells",
                [mark(43, 69, 9, 9, "last cell", "danger"), mark(7, 75, 9, 9, "ball")],
            ),
            (
                "post",
                34,
                "The note places the ball one row too high.",
                "actual row 10 · claimed row 9",
                [
                    mark(43, 69, 9, 9, "claimed path", "danger"),
                    mark(85, 75, 9, 9, "actual ball", "warning"),
                ],
            ),
            (
                "post",
                35,
                "It reverses along the bottom row.",
                "painted mask unchanged",
                [
                    mark(7, 75, 87, 7, "motion on row 10", "warning"),
                    mark(43, 69, 9, 9, "target on row 9", "danger"),
                ],
            ),
            (
                "post",
                37,
                "A cycle warning arrives; the row belief survives.",
                "same target belief · no coverage gain",
                [mark(7, 75, 87, 7, "same corridor", "danger")],
            ),
            (
                "post",
                40,
                "The ball is still touring row 10.",
                "97.8% · one cell still dark",
                [
                    mark(43, 69, 9, 9, "still unpainted", "danger"),
                    mark(7, 75, 9, 9, "ball", "warning"),
                ],
            ),
        ],
    },
    "rush_grouped": {
        "label": "One articulated target",
        "tone": "success",
        "run": "gpt-5.6-sol-low",
        "task": "rush_hour_2.medium.level_03.seed_0",
        "episode": "rush_hour_2.medium.level_03.seed_0.run_001",
        "game": "rush_hour_2",
        "difficulty": "medium",
        "frames": [
            (
                "pre",
                1,
                "The board contains one articulated horizontal target.",
                "game state: one vehicle · one motion axis",
                [mark(9, 33, 25, 10, "one target vehicle", "good")],
            ),
            (
                "post",
                1,
                "The first real blocker moves down.",
                "target unchanged",
                [mark(9, 33, 25, 10, "target", "good")],
            ),
            (
                "post",
                2,
                "The second real blocker moves up.",
                "exit row clear",
                [mark(9, 33, 25, 10, "horizontal route", "good")],
            ),
            ("post", 3, "The target exits along its long axis.", "success in 3 actions", []),
        ],
    },
    "rush_split": {
        "label": "Imagined vertical fragment",
        "tone": "failure",
        "run": "gpt-5.6-terra-low",
        "task": "rush_hour_2.medium.level_03.seed_0",
        "episode": "rush_hour_2.medium.level_03.seed_0.run_001",
        "game": "rush_hour_2",
        "difficulty": "medium",
        "frames": [
            (
                "pre",
                1,
                "The same sprite is split into a body and a ‘small red vertical car.’",
                "one sprite described as two vehicles",
                [mark(9, 33, 16, 10, "main car"), mark(23, 33, 11, 10, "imagined car", "danger")],
            ),
            (
                "post",
                1,
                "The imagined fragment is dragged upward.",
                "no visible effect",
                [mark(23, 33, 11, 10, "not independent", "danger")],
            ),
            (
                "post",
                3,
                "After moving a real blocker, it tries the fragment again.",
                "second no-effect fragment move",
                [mark(23, 33, 11, 10, "same false object", "danger")],
            ),
            (
                "post",
                6,
                "This run later abandons the fragment model.",
                "recovered after reclassification",
                [],
            ),
        ],
    },
}

NUT_HARD_1_STACKS = [
    ["teal", "purple", "yellow", "blue"],
    ["purple", "lime", "yellow", "yellow"],
    ["lime", "brown", "teal", "orange"],
    ["lime", "red", "green", "orange"],
    ["brown", "cyan", "cyan", "orange"],
    ["cyan", "pink", "red", "red"],
    ["pink", "teal", "pink", "brown"],
    ["orange", "lime", "purple", "brown"],
    ["green", "blue", "yellow", "blue"],
    ["blue", "green", "green", "teal"],
    ["red", "purple", "cyan", "pink"],
    [],
    [],
]
NUT_HARD_1_CENTERS = [
    (178, 520),
    (418, 520),
    (658, 520),
    (898, 520),
    (138, 930),
    (338, 930),
    (538, 930),
    (738, 930),
    (938, 930),
    (138, 1360),
    (338, 1360),
    (538, 1360),
    (738, 1360),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-root", type=Path, default=Path("results"))
    parser.add_argument("--leaderboard", type=Path, default=Path("leaderboard/results.json"))
    parser.add_argument("--article-root", type=Path, default=Path("blog/longpuzzlebench-agents"))
    return parser.parse_args()


def run_dir(row: dict[str, Any]) -> str:
    key = (row["model"], row.get("reasoning_effort"))
    if key in PUBLIC_RUN_DIRS:
        return PUBLIC_RUN_DIRS[key]
    model = row["model"].split("/")[-1]
    effort = row.get("reasoning_effort")
    return f"{model}-{effort}" if effort else model


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def nested(payload: Any, *keys: str, default: Any = None) -> Any:
    current = payload
    for key in keys:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
        if current is None:
            return default
    return current


def episode_path(root: Path, run: str, episode_id: str) -> Path:
    return root / run / "leaderboard" / "episodes" / f"{episode_id}.json"


def load_episode(root: Path, run: str, episode_id: str) -> dict[str, Any]:
    path = episode_path(root, run, episode_id)
    if not path.is_file():
        raise FileNotFoundError(path)
    return json.loads(path.read_text())


def load_corpus(
    root: Path, leaderboard_path: Path
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    leaderboard = json.loads(leaderboard_path.read_text())
    rows = leaderboard["results"]
    corpus = []
    for row in rows:
        directory = run_dir(row)
        episode_root = root / directory / "leaderboard" / "episodes"
        if not episode_root.is_dir():
            raise FileNotFoundError(episode_root)
        for source in sorted(episode_root.glob("*.json")):
            episode = json.loads(source.read_text())
            episode.update({"_run": directory, "_rank": row["rank"], "_source": str(source)})
            corpus.append(episode)
    return leaderboard, rows, corpus


def feedback(step: dict[str, Any]) -> dict[str, Any]:
    return nested(step, "execution_result", "public_feedback", default={}) or {}


def raw_metrics(step: dict[str, Any]) -> dict[str, Any]:
    return nested(step, "post_observation", "evaluator", "raw_metrics", default={}) or {}


def state_sha(step: dict[str, Any]) -> str | None:
    return nested(step, "post_observation", "evaluator", "state_sha256")


def frame_source(root: Path, story: dict[str, Any], kind: str, step: int) -> Path:
    trace = (
        root
        / story["run"]
        / story["game"]
        / story["difficulty"]
        / "trajectories"
        / "run_001"
        / story["task"]
    )
    folder = "screenshots" if kind == "pre" else "post_screenshots"
    return trace / folder / f"{story['task']}-0-{step}.png"


def save_webp(source: Path, destination: Path, max_width: int = 720) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        image = image.convert("RGB")
        if image.width > max_width:
            image = image.resize(
                (max_width, round(image.height * max_width / image.width)), Image.Resampling.LANCZOS
            )
        image.save(destination, "WEBP", quality=84, method=6)


def build_game_thumbnails(article_root: Path) -> None:
    destination = article_root / "assets" / "games"
    destination.mkdir(parents=True, exist_ok=True)
    for game in GAME_IDS:
        source = Path("assets") / "games" / f"{game}.png"
        if not source.is_file():
            raise FileNotFoundError(source)
        save_webp(source, destination / f"{game}.webp", 360)


def frame_progress(episode: dict[str, Any], kind: str, step: int) -> float:
    index = step - 1
    if index < 0:
        return 0.0
    trajectory = episode.get("trajectory") or []
    if not trajectory:
        return 0.0
    observation = "pre_observation" if kind == "pre" else "post_observation"
    value = nested(
        trajectory[min(index, len(trajectory) - 1)],
        observation,
        "evaluator",
        "level_progress",
    )
    return float(value) if isinstance(value, (int, float)) else 0.0


def build_stories(results_root: Path, article_root: Path) -> dict[str, Any]:
    assets = article_root / "assets" / "trajectories"
    if assets.exists():
        shutil.rmtree(assets)
    output = {}
    for key, story in STORIES.items():
        episode = load_episode(results_root, story["run"], story["episode"])
        frames = []
        for kind, step, description, fact, overlays in story["frames"]:
            source = frame_source(results_root, story, kind, step)
            if not source.is_file():
                raise FileNotFoundError(source)
            filename = f"{key}-{step:03d}-{kind}.webp"
            save_webp(source, assets / filename)
            frames.append(
                {
                    "step": step,
                    "kind": kind,
                    "description": description,
                    "fact": fact,
                    "progress": round(frame_progress(episode, kind, step), 4),
                    "asset": f"assets/trajectories/{filename}",
                    "source": str(source.relative_to(results_root)),
                    "source_sha256": sha256(source),
                    "overlays": overlays,
                }
            )
        output[key] = {
            "label": story["label"],
            "tone": story["tone"],
            "run": story["run"],
            "episode_id": story["episode"],
            "success": bool(episode["success"]),
            "termination": episode["termination_reason"],
            "steps": episode["step_count"],
            "frames": frames,
        }
    return output


def nearest_nut_bolt(action: dict[str, Any]) -> int | None:
    if action.get("action_type") != "click":
        return None
    x, y = action.get("x"), action.get("y")
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return None
    distances = [math.dist((x, y), center) for center in NUT_HARD_1_CENTERS]
    index = min(range(len(distances)), key=distances.__getitem__)
    return index if distances[index] <= 150 else None


def replay_nut_hard_1(episode: dict[str, Any]) -> dict[str, Any]:
    stacks = [stack.copy() for stack in NUT_HARD_1_STACKS]
    initial = [stack.copy() for stack in stacks]
    history: list[tuple[int, int, list[str]]] = []
    selected: int | None = None
    last_illegal: tuple[int, int] | None = None
    repeated_illegal = 0
    invalid_pairs: list[tuple[int, int, int]] = []
    move_count = 0

    for step_number, step in enumerate(episode.get("trajectory") or [], 1):
        action = step.get("normalized_action") or step.get("action") or {}
        target = nearest_nut_bolt(action)
        if target is not None:
            if selected is None:
                if stacks[target]:
                    selected = target
            elif target == selected:
                selected = None
                last_illegal = None
            else:
                source = selected
                source_stack, target_stack = stacks[source], stacks[target]
                legal = (
                    bool(source_stack)
                    and len(target_stack) < 4
                    and (not target_stack or target_stack[-1] == source_stack[-1])
                )
                if not legal:
                    pair = (source, target)
                    repeated_illegal += int(pair == last_illegal)
                    last_illegal = pair
                    invalid_pairs.append((step_number, source, target))
                else:
                    color = source_stack[-1]
                    run = 1
                    while run < len(source_stack) and source_stack[-1 - run] == color:
                        run += 1
                    count = min(run, 4 - len(target_stack))
                    moved = source_stack[-count:]
                    del source_stack[-count:]
                    target_stack.extend(moved)
                    history.append((source, target, moved))
                    move_count += 1
                    selected = None
                    last_illegal = None
        elif action.get("action_type") == "click":
            x, y = action.get("x", 0), action.get("y", 0)
            # Undo: a disabled/no-history Undo does not clear selection.
            if y > 1500 and x < 300:
                if history:
                    source, target_index, moved = history.pop()
                    del stacks[target_index][-len(moved) :]
                    stacks[source].extend(moved)
                    move_count -= 1
                    selected = None
                    last_illegal = None
            # Restart restores both board and interaction mode.
            elif y < 420 and x > 760:
                stacks = [stack.copy() for stack in initial]
                history.clear()
                selected = None
                last_illegal = None
                move_count = 0

        evaluator_moves = raw_metrics(step).get("move_count")
        advanced_after_success = bool(episode.get("success")) and step_number == len(
            episode.get("trajectory") or []
        )
        if (
            isinstance(evaluator_moves, int)
            and not advanced_after_success
            and evaluator_moves != move_count
        ):
            raise AssertionError(
                f"Nut replay mismatch {episode['_run']} action {step_number}: "
                f"simulated {move_count}, evaluator {evaluator_moves}"
            )

    return {
        "repeated_illegal_pair_count": repeated_illegal,
        "has_repeated_illegal_pair": repeated_illegal > 0,
        "illegal_attempt_count": len(invalid_pairs),
        "invalid_pairs": invalid_pairs,
    }


def bolt_findings(corpus: list[dict[str, Any]], root: Path) -> dict[str, Any]:
    episode_id = "bolt_unscrew.hard.level_01.seed_0.run_001"
    matched = [episode for episode in corpus if episode["episode_id"] == episode_id]
    deadlocks = [ep for ep in matched if ep["termination_reason"] == "no_available_hole_deadlock"]
    rises = 0
    for episode in deadlocks:
        trajectory = episode["trajectory"]
        if len(trajectory) > 1:
            before = nested(
                trajectory[-2], "post_observation", "evaluator", "level_progress", default=0
            )
            after = nested(
                trajectory[-1], "post_observation", "evaluator", "level_progress", default=0
            )
            rises += int(after > before)

    sol = load_episode(root, "gpt-5.6-sol-medium", episode_id)
    qwen = load_episode(root, "qwen3.8-27b", episode_id)
    sol_state, qwen_state = state_sha(sol["trajectory"][7]), state_sha(qwen["trajectory"][9])
    sol_image = frame_source(root, STORIES["bolt_immediate"], "post", 8)
    qwen_image = frame_source(root, STORIES["bolt_deeper"], "post", 10)
    if sol_state != qwen_state or sha256(sol_image) != sha256(qwen_image):
        raise AssertionError("Expected byte-identical matched Bolt state and screenshot")
    return {
        "public_runs_on_task": len(matched),
        "no_available_hole_deadlocks": len(deadlocks),
        "terminal_transfer_increased_progress": rises,
        "top_ten_common_terminal": sum(
            ep["_rank"] <= 10
            and ep["termination_reason"] == "no_available_hole_deadlock"
            and ep["step_count"] == 10
            for ep in matched
        ),
        "matched_state_sha256": sol_state,
        "matched_screenshot_sha256": sha256(sol_image),
        "sol_immediate": {
            "source_action": 9,
            "terminal_action": 10,
            "progress_before": 0.2083,
            "progress_after": 0.2917,
            "legal_actions_after": 0,
        },
        "qwen_delayed": {
            "source_action": 11,
            "transfer_action": 12,
            "terminal_action": 20,
            "final_progress": qwen["progress_score"],
        },
    }


def nut_findings(corpus: list[dict[str, Any]], root: Path) -> dict[str, Any]:
    episode_id = "nut_and_bolt.hard.level_01.seed_0.run_001"
    matched = [episode for episode in corpus if episode["episode_id"] == episode_id]
    replay = {episode["_run"]: replay_nut_hard_1(episode) for episode in matched}
    weak = load_episode(root, "qwen3.8-27b", episode_id)
    strong = load_episode(root, "gpt-5.6-sol-medium", episode_id)
    return {
        "hard_1_runs": len(matched),
        "hard_1_failures": sum(not episode["success"] for episode in matched),
        "runs_with_consecutive_repeated_illegal_pair": sum(
            item["has_repeated_illegal_pair"] for item in replay.values()
        ),
        "successful_runs_with_repeated_illegal_pair": sum(
            episode["success"] and replay[episode["_run"]]["has_repeated_illegal_pair"]
            for episode in matched
        ),
        "weak_chain": {
            "truncated_transfer_action": 4,
            "warning_action": 9,
            "move_counts": [
                raw_metrics(weak["trajectory"][i]).get("move_count") for i in (3, 5, 8, 9)
            ],
        },
        "strong_chain": {
            "truncated_transfer_action": 72,
            "warning_action": 74,
            "cancel_action": 75,
            "reverse_completion_action": 77,
            "move_counts": [
                raw_metrics(strong["trajectory"][i]).get("move_count") for i in (71, 73, 74, 76)
            ],
        },
        "long_dependency_capability": {
            "episode_id": "nut_and_bolt.hard.level_02.seed_0.run_001",
            "valid_transfers_without_empty_buffer": 26,
            "first_buffer_reopened_action": 58,
        },
    }


def color_hash(episode: dict[str, Any], action: int) -> str:
    value = nested(
        episode["trajectory"][action - 1],
        "post_observation",
        "evaluator",
        "raw_metrics",
        "state_hash",
    )
    if not isinstance(value, str):
        raise AssertionError(f"Missing Color state at action {action}")
    return value


def color_findings(corpus: list[dict[str, Any]], root: Path) -> dict[str, Any]:
    failures = [ep for ep in corpus if ep["game"] == "color_connect" and not ep["success"]]
    successes = [ep for ep in corpus if ep["game"] == "color_connect" and ep["success"]]

    def revisit_summary(episodes: list[dict[str, Any]]) -> tuple[int, int, int]:
        episode_count = event_count = action_count = 0
        for episode in episodes:
            seen: set[str] = set()
            revisits = 0
            for step in episode["trajectory"]:
                state = nested(step, "post_observation", "evaluator", "raw_metrics", "state_hash")
                if isinstance(state, str):
                    revisits += int(state in seen)
                    seen.add(state)
                action_count += 1
            event_count += revisits
            episode_count += int(revisits > 0)
        return episode_count, event_count, action_count

    episode_id = "color_connect.hard.level_01.seed_0.run_001"
    good = load_episode(root, "gpt-5.6-sol-high", episode_id)
    bad = load_episode(root, "gpt-5.6-sol-medium", episode_id)
    good_prefix, bad_prefix = color_hash(good, 5), color_hash(bad, 8)
    recreated = [color_hash(bad, action) for action in (10, 17, 23)]
    if good_prefix != bad_prefix or len(set(recreated)) != 1:
        raise AssertionError("Expected matched prefix and repeated completed coral state")
    fail_revisits, success_revisits = revisit_summary(failures), revisit_summary(successes)
    return {
        "matched_active_path_state": good_prefix,
        "first_divergence": {
            "success_action": 6,
            "failure_action": 9,
            "reserved_cell": {"row": 3, "column": 5},
        },
        "failed_completed_coral_state_actions": [10, 17, 23],
        "failed_completed_coral_state_hash": recreated[0],
        "successful_path_cancellations": nested(
            good["trajectory"][-1],
            "post_observation",
            "evaluator",
            "raw_metrics",
            "actions",
            "path_cancel_count",
            default=0,
        ),
        "revisits": {
            "failures": len(failures),
            "failed_episodes_with_revisit": fail_revisits[0],
            "failed_revisit_events": fail_revisits[1],
            "failed_actions": fail_revisits[2],
            "successes": len(successes),
            "successful_episodes_with_revisit": success_revisits[0],
            "successful_revisit_events": success_revisits[1],
            "successful_actions": success_revisits[2],
        },
    }


def maze_hash_from_step(step: dict[str, Any]) -> str | None:
    value = nested(
        step, "post_observation", "evaluator", "raw_metrics", "state_analysis", "state_hash"
    )
    return value if isinstance(value, str) else None


def maze_hash(episode: dict[str, Any], action: int) -> str:
    value = maze_hash_from_step(episode["trajectory"][action - 1])
    if value is None:
        raise AssertionError(f"Missing Maze state at action {action}")
    return value


def maze_findings(corpus: list[dict[str, Any]], root: Path) -> dict[str, Any]:
    failures = [ep for ep in corpus if ep["game"] == "maze_paint" and not ep["success"]]
    successes = [ep for ep in corpus if ep["game"] == "maze_paint" and ep["success"]]

    def has_blocked_swipe(episode: dict[str, Any]) -> bool:
        for step in episode["trajectory"]:
            action = step.get("normalized_action") or step.get("action") or {}
            if action.get("action_type") != "swipe":
                continue
            before = nested(
                step,
                "pre_observation",
                "evaluator",
                "raw_metrics",
                "state_analysis",
                "state_hash",
            )
            after = maze_hash_from_step(step)
            if isinstance(before, str) and before == after:
                return True
        return False

    episode_id = "maze_paint.hard.level_01.seed_0.run_001"
    good = load_episode(root, "gpt-5.6-terra-high", episode_id)
    bad = load_episode(root, "kimi-k3-high", episode_id)
    matched_good, matched_bad = maze_hash(good, 31), maze_hash(bad, 33)
    right_good, right_bad = maze_hash(good, 32), maze_hash(bad, 34)
    if matched_good != matched_bad or right_good != right_bad:
        raise AssertionError("Expected exact matched Maze states")
    return {
        "matched_one_cell_state_hash": matched_good,
        "matched_after_right_state_hash": right_good,
        "remaining_cell": {"row": 9, "column": 4, "indexing": "one-based"},
        "actual_ball_after_right": {"row": 10, "column": 7, "indexing": "one-based"},
        "successful_route_actions": [33, 34, 35],
        "failed_route_actions": [35, 37, 40],
        "failure_recovery_warnings": sum(
            bool(feedback(step).get("recovery_required")) for step in bad["trajectory"]
        ),
        "failure_final_coverage": nested(
            bad["trajectory"][-1], "post_observation", "evaluator", "level_progress"
        ),
        "blocked_swipe_context": {
            "failed_episodes": len(failures),
            "failures_with_blocked_swipe": sum(has_blocked_swipe(ep) for ep in failures),
            "successful_episodes": len(successes),
            "successes_with_blocked_swipe": sum(has_blocked_swipe(ep) for ep in successes),
        },
    }


def rush_findings(root: Path) -> dict[str, Any]:
    cases = [
        ("gpt-5.6-luna-low", "rush_hour_2.easy.level_01.seed_0.run_001"),
        ("gpt-5.6-terra-high", "rush_hour_2.easy.level_06.seed_0.run_001"),
        ("gpt-5.6-terra-low", "rush_hour_2.medium.level_03.seed_0.run_001"),
        ("gpt-5.6-terra-high", "rush_hour_2.medium.level_05.seed_0.run_001"),
        ("kimi-k3-high", "rush_hour_2.hard.level_01.seed_0.run_001"),
    ]
    split_terms = (
        "小竖车",
        "竖向小车",
        "红色竖车",
        "竖直红色车辆",
        "vertical vehicle",
        "vertical car",
    )
    target_terms = (
        "红色目标横车",
        "红色目标车",
        "红色目标车辆",
        "red target car",
        "red target vehicle",
    )
    verified = []
    for run, episode_id in cases:
        episode = load_episode(root, run, episode_id)
        split_index = next(
            (
                index
                for index, step in enumerate(episode["trajectory"])
                if any(term in str(step.get("prediction") or "").lower() for term in split_terms)
            ),
            None,
        )
        if split_index is None:
            raise AssertionError(f"Missing split-object language in {run}/{episode_id}")
        split_step = episode["trajectory"][split_index]
        repair_index = next(
            (
                index
                for index, step in enumerate(
                    episode["trajectory"][split_index + 1 :], split_index + 1
                )
                if any(term in str(step.get("prediction") or "").lower() for term in target_terms)
                and abs(
                    (step.get("normalized_action") or {}).get("end_x", 0)
                    - (step.get("normalized_action") or {}).get("start_x", 0)
                )
                > abs(
                    (step.get("normalized_action") or {}).get("end_y", 0)
                    - (step.get("normalized_action") or {}).get("start_y", 0)
                )
                and nested(step, "action_outcome", "reason") == "screen_changed"
            ),
            None,
        )
        verified.append(
            {
                "run": run,
                "episode_id": episode_id,
                "first_split_action": split_index + 1,
                "repair_action": repair_index + 1 if repair_index is not None else None,
                "recovered": repair_index is not None,
                "episode_success": episode["success"],
                "feedback_status": feedback(split_step).get("status"),
            }
        )
    strong = load_episode(root, "gpt-5.6-sol-low", "rush_hour_2.medium.level_03.seed_0.run_001")
    weak = load_episode(root, "gpt-5.6-terra-low", "rush_hour_2.medium.level_03.seed_0.run_001")
    return {
        "hand_verified_episodes": len(verified),
        "model_configurations": len({case[0] for case in cases}),
        "split_repaired": sum(item["recovered"] for item in verified),
        "recovered_and_solved": sum(
            item["recovered"] and item["episode_success"] for item in verified
        ),
        "recovered_but_failed": sum(
            item["recovered"] and not item["episode_success"] for item in verified
        ),
        "failed": sum(not item["episode_success"] for item in verified),
        "cases": verified,
        "matched_successful_task": {
            "episode_id": "rush_hour_2.medium.level_03.seed_0.run_001",
            "grouped_run": "gpt-5.6-sol-low",
            "grouped_steps": strong["step_count"],
            "split_run": "gpt-5.6-terra-low",
            "split_steps": weak["step_count"],
            "split_no_effect_actions": [1, 3],
        },
    }


def build_findings(corpus: list[dict[str, Any]], root: Path) -> dict[str, Any]:
    return {
        "future_actionability": bolt_findings(corpus, root),
        "postcondition_repair": nut_findings(corpus, root),
        "corridor_reservation": color_findings(corpus, root),
        "stale_localization": maze_findings(corpus, root),
        "part_whole_segmentation": rush_findings(root),
    }


def main() -> None:
    args = parse_args()
    leaderboard, rows, corpus = load_corpus(args.results_root, args.leaderboard)
    build_game_thumbnails(args.article_root)
    stories = build_stories(args.results_root, args.article_root)
    findings = build_findings(corpus, args.results_root)
    output = {
        "meta": {
            "benchmark": leaderboard["benchmark"],
            "leaderboard_generated_at": leaderboard["generated_at"],
            "public_runs": len(rows),
            "executed_trajectories": len(corpus),
            "successful_trajectories": sum(ep["success"] for ep in corpus),
            "failed_trajectories": sum(not ep["success"] for ep in corpus),
            "game_counts": dict(Counter(ep["game"] for ep in corpus)),
            "analysis_scope": "Canonical executed episodes from 18 complete public progressive runs; skipped levels are not trajectories.",
            "leaderboard_source": str(args.leaderboard),
            "leaderboard_sha256": sha256(args.leaderboard),
        },
        "models": [
            {
                "rank": row["rank"],
                "model": row["model"],
                "effort": row.get("reasoning_effort"),
                "run": run_dir(row),
                "benchmark_score": row["benchmark_score"],
            }
            for row in rows
        ],
        "findings": findings,
        "stories": stories,
    }
    destination = args.article_root / "data" / "findings.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    script_destination = args.article_root / "data" / "findings.js"
    script_destination.write_text(
        "window.LONGPUZZLEBENCH_FINDINGS="
        + json.dumps(output, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    frame_count = sum(len(story["frames"]) for story in stories.values())
    print(
        f"Wrote {destination} and {script_destination} from {len(corpus)} trajectories "
        f"with {frame_count} hashed frames."
    )


if __name__ == "__main__":
    main()
