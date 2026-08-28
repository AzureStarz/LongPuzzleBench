#!/usr/bin/env python3
"""Audit the checked-in LongPuzzleBench article, claims, and empirical assets."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
ARTICLE = ROOT / "blog" / "longpuzzlebench-agents"
HTML_PATH = ARTICLE / "index.html"
DATA_PATH = ARTICLE / "data" / "findings.json"
DATA_JS_PATH = ARTICLE / "data" / "findings.js"
DATA_JS_PREFIX = "window.LONGPUZZLEBENCH_FINDINGS="
GAME_IDS = {
    "bolt_unscrew",
    "color_connect",
    "maze_paint",
    "nut_and_bolt",
    "rush_hour_2",
    "truck_escape",
}


class ArticleParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.in_main = False
        self.skip_depth = 0
        self.main_text: list[str] = []
        self.ids: set[str] = set()
        self.local_references: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "main":
            self.in_main = True
        if tag in {"script", "style"}:
            self.skip_depth += 1
        if identifier := attributes.get("id"):
            self.ids.add(identifier)
        for attribute in ("src", "href"):
            value = attributes.get(attribute)
            if value and not value.startswith(("#", "mailto:")):
                parsed = urlparse(value)
                if not parsed.scheme and not parsed.netloc:
                    self.local_references.append(parsed.path)

    def handle_endtag(self, tag: str) -> None:
        if tag == "main":
            self.in_main = False
        if tag in {"script", "style"} and self.skip_depth:
            self.skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self.in_main and not self.skip_depth:
            self.main_text.append(data)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--results-root",
        type=Path,
        help="Optional canonical raw-results root used to re-hash exported source frames.",
    )
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_claims(data: dict[str, object]) -> None:
    meta = data["meta"]
    assert isinstance(meta, dict)
    assert meta["public_runs"] == 18
    assert meta["executed_trajectories"] == 782
    assert meta["successful_trajectories"] == 545
    assert meta["failed_trajectories"] == 237

    models = data["models"]
    assert isinstance(models, list)
    assert [model["rank"] for model in models] == list(range(1, 19))

    findings = data["findings"]
    assert isinstance(findings, dict)
    assert set(findings) == {
        "future_actionability",
        "postcondition_repair",
        "corridor_reservation",
        "stale_localization",
        "part_whole_segmentation",
    }

    bolt = findings["future_actionability"]
    assert bolt["public_runs_on_task"] == 18
    assert bolt["no_available_hole_deadlocks"] == 13
    assert bolt["terminal_transfer_increased_progress"] == 12
    assert bolt["top_ten_common_terminal"] == 10
    assert bolt["sol_immediate"]["legal_actions_after"] == 0
    assert bolt["qwen_delayed"]["final_progress"] == 0.5

    nut = findings["postcondition_repair"]
    assert (nut["hard_1_runs"], nut["hard_1_failures"]) == (18, 17)
    assert nut["runs_with_consecutive_repeated_illegal_pair"] == 15
    assert nut["successful_runs_with_repeated_illegal_pair"] == 0
    assert nut["weak_chain"]["move_counts"] == [2, 2, 2, 2]
    assert nut["strong_chain"]["move_counts"] == [31, 31, 31, 32]
    assert nut["long_dependency_capability"]["valid_transfers_without_empty_buffer"] == 26

    color = findings["corridor_reservation"]
    assert color["failed_completed_coral_state_actions"] == [10, 17, 23]
    assert color["successful_path_cancellations"] == 0
    revisits = color["revisits"]
    assert (revisits["failed_episodes_with_revisit"], revisits["failures"]) == (32, 33)
    assert (revisits["failed_revisit_events"], revisits["failed_actions"]) == (274, 750)

    maze = findings["stale_localization"]
    assert maze["matched_one_cell_state_hash"] == "9,1:1fefffffffff"
    assert maze["matched_after_right_state_hash"] == "9,6:1fefffffffff"
    assert maze["remaining_cell"] == {"row": 9, "column": 4, "indexing": "one-based"}
    assert maze["actual_ball_after_right"] == {"row": 10, "column": 7, "indexing": "one-based"}
    assert maze["failure_recovery_warnings"] == 3
    assert maze["blocked_swipe_context"] == {
        "failed_episodes": 41,
        "failures_with_blocked_swipe": 28,
        "successful_episodes": 178,
        "successes_with_blocked_swipe": 30,
    }

    rush = findings["part_whole_segmentation"]
    assert rush["hand_verified_episodes"] == 5
    assert rush["model_configurations"] == 4
    assert rush["split_repaired"] == 3
    assert rush["recovered_and_solved"] == 2
    assert rush["recovered_but_failed"] == 1
    assert rush["failed"] == 3
    assert rush["matched_successful_task"]["split_no_effect_actions"] == [1, 3]
    repair_actions = {
        (case["run"], case["episode_id"]): (
            case["first_split_action"],
            case["repair_action"],
        )
        for case in rush["cases"]
    }
    assert repair_actions == {
        ("gpt-5.6-luna-low", "rush_hour_2.easy.level_01.seed_0.run_001"): (4, None),
        ("gpt-5.6-terra-high", "rush_hour_2.easy.level_06.seed_0.run_001"): (1, 2),
        ("gpt-5.6-terra-low", "rush_hour_2.medium.level_03.seed_0.run_001"): (1, 6),
        ("gpt-5.6-terra-high", "rush_hour_2.medium.level_05.seed_0.run_001"): (1, 13),
        ("kimi-k3-high", "rush_hour_2.hard.level_01.seed_0.run_001"): (2, None),
    }


def verify_story_assets(data: dict[str, object], results_root: Path | None) -> tuple[int, int]:
    stories = data["stories"]
    assert isinstance(stories, dict)
    assert set(stories) == {
        "bolt_immediate",
        "bolt_deeper",
        "nut_dependency",
        "nut_repeat",
        "nut_repair",
        "color_reserve",
        "color_recreate",
        "maze_recover",
        "maze_stale",
        "rush_grouped",
        "rush_split",
    }
    assert (
        stories["bolt_immediate"]["frames"][0]["source_sha256"]
        == stories["bolt_deeper"]["frames"][0]["source_sha256"]
    )

    frame_count = 0
    raw_sources = 0
    expected_assets: set[Path] = set()
    for story in stories.values():
        for frame in story["frames"]:
            frame_count += 1
            asset = ARTICLE / frame["asset"]
            expected_assets.add(asset.resolve())
            assert asset.is_file() and asset.stat().st_size > 1_000, asset
            assert re.fullmatch(r"[0-9a-f]{64}", frame["source_sha256"])
            source_path = Path(frame["source"])
            assert not source_path.is_absolute() and ".." not in source_path.parts
            for overlay in frame["overlays"]:
                assert 0 <= overlay["x"] <= 100
                assert 0 <= overlay["y"] <= 100
                assert 0 < overlay["width"] <= 100
                assert 0 < overlay["height"] <= 100
            if results_root:
                source = results_root / frame["source"]
                assert source.is_file(), source
                assert sha256(source) == frame["source_sha256"], source
                raw_sources += 1
    assert frame_count == 51
    actual_assets = {
        path.resolve() for path in (ARTICLE / "assets" / "trajectories").glob("*")
    }
    assert actual_assets == expected_assets, {
        "unreferenced": sorted(map(str, actual_assets - expected_assets)),
        "missing": sorted(map(str, expected_assets - actual_assets)),
    }
    return frame_count, raw_sources


def verify_html() -> int:
    parser = ArticleParser()
    html = HTML_PATH.read_text()
    parser.feed(html)
    assert {f"finding-{index}" for index in range(1, 6)} <= parser.ids
    assert "The Agent That Solved in 92 Actions" not in html
    assert "Longer trajectories fail more often" not in html
    assert "Communication references:" not in html
    assert html.count('class="trajectory-comparison') == 5

    missing: list[Path] = []
    for reference in parser.local_references:
        path = (ARTICLE / reference).resolve()
        if not path.exists():
            missing.append(path)
    assert not missing, f"Missing local article references: {missing}"

    css = (ARTICLE / "styles.css").read_text()
    for reference in re.findall(r'url\(["\']?([^"\')]+)', css):
        parsed = urlparse(reference)
        if not parsed.scheme:
            assert (ARTICLE / parsed.path).resolve().is_file(), reference

    game_assets = {path.stem for path in (ARTICLE / "assets" / "games").glob("*.webp")}
    assert game_assets == GAME_IDS

    words = re.findall(r"\b[\w’'-]+\b", " ".join(parser.main_text))
    assert 2_300 <= len(words) <= 3_700, len(words)
    return len(words)


def main() -> None:
    args = parse_args()
    serialized_data = DATA_PATH.read_text()
    assert not any(marker in serialized_data for marker in ("/Users/", "/home/", "C:\\Users\\"))
    data = json.loads(serialized_data)
    data_script = DATA_JS_PATH.read_text()
    assert data_script.startswith(DATA_JS_PREFIX) and data_script.endswith(";\n")
    assert json.loads(data_script[len(DATA_JS_PREFIX) : -2]) == data
    verify_claims(data)
    frames, sources = verify_story_assets(data, args.results_root)
    words = verify_html()
    source_message = f", {sources} raw source hashes verified" if args.results_root else ""
    print(
        f"Article audit passed: {words} main-text words, {frames} empirical frames{source_message}."
    )


if __name__ == "__main__":
    main()
