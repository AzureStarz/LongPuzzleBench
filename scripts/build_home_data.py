#!/usr/bin/env python3
"""Generate the homepage leaderboard and curated trajectory data.

The checked-in HTML remains meaningful without JavaScript, while every score,
action, model excerpt, and evaluator outcome is derived from the canonical
leaderboard and public research evidence bundle.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
LEADERBOARD = ROOT / "leaderboard" / "results.json"
FINDINGS = ROOT / "blog" / "longpuzzlebench-agents" / "data" / "findings.json"
HOMEPAGE = ROOT / "index.html"
DATA_ASSET = ROOT / "assets" / "home-data.js"

RESULTS_START = "<!-- LONGPUZZLEBENCH:RESULTS:START -->"
RESULTS_END = "<!-- LONGPUZZLEBENCH:RESULTS:END -->"
CASE_TABS_START = "<!-- LONGPUZZLEBENCH:CASE-TABS:START -->"
CASE_TABS_END = "<!-- LONGPUZZLEBENCH:CASE-TABS:END -->"
CASE_FALLBACK_START = "<!-- LONGPUZZLEBENCH:CASE-FALLBACK:START -->"
CASE_FALLBACK_END = "<!-- LONGPUZZLEBENCH:CASE-FALLBACK:END -->"

MODEL_LABELS = {
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-5.6-terra": "GPT-5.6 Terra",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "kimi-k3": "Kimi K3",
    "moonshotai/kimi-k2.5": "Kimi K2.5",
    "qwen/qwen3.8-27b": "Qwen 3.8 27B",
    "qwen/qwen3.5-122b-a10b": "Qwen 3.5 122B A10B",
    "qwen/qwen3.6-35b-a3b": "Qwen 3.6 35B A3B",
    "qwen/qwen3.5-397b-a17b": "Qwen 3.5 397B A17B",
    "qwen/qwen3-vl-235b-a22b-thinking": "Qwen3-VL 235B Thinking",
    "qwen/qwen3-vl-30b-a3b-thinking": "Qwen3-VL 30B Thinking",
    "z-ai/glm-4.6v": "GLM-4.6V",
}

RUN_LABELS = {
    "gpt-5.6-sol-medium": "GPT-5.6 Sol · medium",
    "gpt-5.6-sol-low": "GPT-5.6 Sol · low",
    "gpt-5.6-sol-high": "GPT-5.6 Sol · high",
    "gpt-5.6-terra-low": "GPT-5.6 Terra · low",
    "qwen3.8-27b": "Qwen 3.8 27B",
}

GAME_LABELS = {
    "bolt_unscrew": "Bolt Unscrew",
    "rush_hour_2": "Rush Hour",
    "nut_and_bolt": "Nut and Bolt",
    "truck_escape": "Truck Escape",
    "maze_paint": "Maze Paint",
    "color_connect": "Color Connect",
}

CASE_SPECS = (
    {
        "id": "rush",
        "tab": "Rush Hour",
        "kicker": "Case 01 · Part–whole segmentation",
        "title": "One model sees a car. Another sees a fragment that is not there.",
        "summary": (
            "The same initial pixels produce the first meaningful divergence: one run moves a "
            "real blocker; the other invents a vertical red vehicle and receives no visible effect."
        ),
        "stat": "17.336-point benchmark gap · 3 actions versus 6",
        "research": "research/#finding-5",
        "play": "play/?game=rush-hour&difficulty=medium&level=3",
        "play_label": "Try this exact puzzle",
        "moments": ("Same pixels", "First move", "Belief survives", "Both solve"),
        "branches": (
            {
                "story": "rush_grouped",
                "label": "Higher-ranked run",
                "thesis": "Treats the articulated sprite as one target",
                "outcome": "Success · 3 actions",
                "tone": "success",
            },
            {
                "story": "rush_split",
                "label": "Lower-ranked run",
                "thesis": "Splits one sprite into two vehicles",
                "outcome": "Success · 6 actions",
                "tone": "warning",
            },
        ),
    },
    {
        "id": "bolt",
        "tab": "Bolt Unscrew",
        "kicker": "Case 02 · Future actionability",
        "title": "A legal move raises progress—and removes every future move.",
        "summary": (
            "Both runs reach a byte-identical board and use the same open destination. "
            "Changing only the source screw decides whether another transfer remains possible."
        ),
        "stat": "13 of 18 runs end with no available hole",
        "research": "research/#finding-1",
        "play": "play/?game=bolt-unscrew&difficulty=hard&level=1",
        "play_label": "Try Bolt hard 1",
        "moments": ("Matched board", "Source choice", "State settles", "Compressed outcome"),
        "branches": (
            {
                "story": "bolt_immediate",
                "label": "Immediate deadlock",
                "thesis": "Chooses the salient mid-right support",
                "outcome": "Failure · 10 actions",
                "tone": "failure",
            },
            {
                "story": "bolt_deeper",
                "label": "Mobility preserved",
                "thesis": "Chooses a deeper lower-center support",
                "outcome": "Later failure · 20 actions",
                "tone": "warning",
            },
        ),
    },
    {
        "id": "color",
        "tab": "Color Connect",
        "kicker": "Case 03 · Corridor reservation",
        "title": "The agent names the constraint, then rebuilds the same blocker.",
        "summary": (
            "A failed run explicitly says row 3, column 5 must remain free for purple. "
            "Six actions later it recreates the same occupied board—and later does it again."
        ),
        "stat": "32 of 33 failed episodes revisit an exact board state",
        "research": "research/#finding-3",
        "play": "play/?game=color-connect&difficulty=hard&level=1",
        "play_label": "Try Color hard 1",
        "moments": (
            "Matched prefix",
            "First divergence",
            "Path completed",
            "Conflict recognized",
            "Constraint preserved",
            "Final outcome",
        ),
        "branches": (
            {
                "story": "color_reserve",
                "label": "Successful branch",
                "thesis": "Turns early and reserves the shared cell",
                "outcome": "Success · 33 actions",
                "tone": "success",
            },
            {
                "story": "color_recreate",
                "label": "Repeated blocker",
                "thesis": "Recognizes the conflict, then recreates it",
                "outcome": "Failure · 56 actions",
                "tone": "failure",
            },
        ),
    },
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if the checked-in HTML or JavaScript data is stale.",
    )
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def display_model(model: str) -> str:
    return MODEL_LABELS.get(model, model)


def effort_label(value: str | None) -> str:
    return value if value else "default"


def monogram(model: str) -> str:
    labels = {
        "gpt-5.6-sol": "SOL",
        "gpt-5.6-terra": "TER",
        "kimi-k3": "K3",
    }
    return labels.get(model, display_model(model)[:3].upper())


def replace_generated(source: str, start: str, end: str, content: str) -> str:
    if source.count(start) != 1 or source.count(end) != 1:
        raise ValueError(f"Expected one generated block: {start} … {end}")
    prefix, remainder = source.split(start, 1)
    _old, suffix = remainder.split(end, 1)
    return f"{prefix}{start}\n{content.rstrip()}\n{end}{suffix}"


def run_lookup(findings: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {model["run"]: model for model in findings["models"]}


def format_action(action: dict[str, Any] | None) -> str:
    if not action:
        return "No executed action recorded"
    action_type = action.get("action_type")
    if action_type == "swipe":
        return f"swipe({action.get('direction', '?')})"
    if action_type == "click":
        return f"click(x={action.get('x')}, y={action.get('y')})"
    if action_type == "drag":
        start = f"{action.get('start_x')},{action.get('start_y')}"
        end = f"{action.get('end_x')},{action.get('end_y')}"
        return f"drag(({start}) → ({end}))"
    return json.dumps(action, ensure_ascii=False, separators=(",", ":"))


def build_cases(findings: dict[str, Any]) -> list[dict[str, Any]]:
    models_by_run = run_lookup(findings)
    cases: list[dict[str, Any]] = []
    for spec in CASE_SPECS:
        branches = []
        for branch_spec in spec["branches"]:
            story = findings["stories"][branch_spec["story"]]
            model = models_by_run[story["run"]]
            frames = []
            previous_step: int | None = None
            for index, frame in enumerate(story["frames"]):
                feedback = frame["public_feedback"]
                omitted_before = (
                    max(0, frame["step"] - previous_step - 1)
                    if previous_step is not None
                    else 0
                )
                frames.append(
                    {
                        "moment": spec["moments"][index],
                        "step": frame["step"],
                        "kind": frame["kind"],
                        "asset": "research/" + frame["asset"],
                        "source_sha256": frame["source_sha256"],
                        "recorded_output": frame["recorded_output"],
                        "action": format_action(frame["executed_action"]),
                        "feedback": feedback["status"],
                        "feedback_message": feedback["message"],
                        "description": frame["description"],
                        "fact": frame["fact"],
                        "progress": frame["progress"],
                        "omitted_before": omitted_before,
                    }
                )
                previous_step = frame["step"]
            branches.append(
                {
                    **{key: branch_spec[key] for key in ("label", "thesis", "outcome", "tone")},
                    "story": branch_spec["story"],
                    "run": story["run"],
                    "model": RUN_LABELS.get(story["run"], story["run"]),
                    "rank": model["rank"],
                    "benchmark_score": model["benchmark_score"],
                    "success": story["success"],
                    "termination": story["termination"],
                    "steps": story["steps"],
                    "frames": frames,
                }
            )
        if len({len(branch["frames"]) for branch in branches}) != 1:
            raise ValueError(f"Case {spec['id']} branches are not synchronized")
        matched_hashes = {branch["frames"][0]["source_sha256"] for branch in branches}
        cases.append(
            {
                **{
                    key: spec[key]
                    for key in (
                        "id",
                        "tab",
                        "kicker",
                        "title",
                        "summary",
                        "stat",
                        "research",
                        "play",
                        "play_label",
                    )
                },
                "matched_initial_frame": len(matched_hashes) == 1,
                "matched_sha256": next(iter(matched_hashes)) if len(matched_hashes) == 1 else None,
                "branches": branches,
            }
        )
    return cases


def build_benchmark(leaderboard: dict[str, Any]) -> dict[str, Any]:
    rows = sorted(leaderboard["results"], key=lambda row: row["rank"])
    best_by_model: dict[str, dict[str, Any]] = {}
    for row in rows:
        best_by_model.setdefault(row["model"], row)
    top_models = list(best_by_model.values())[:3]
    game_leaders = {}
    for game in GAME_LABELS:
        leader = max(rows, key=lambda row: row["game_scores"][game])
        game_leaders[game] = {
            "model": leader["model"],
            "effort": leader.get("reasoning_effort"),
            "score": leader["game_scores"][game],
        }
    return {
        "evaluation": leaderboard["evaluation_setting"],
        "rows": rows,
        "top_models": top_models,
        "game_leaders": game_leaders,
        "configuration_gap": round(rows[0]["benchmark_score"] - rows[1]["benchmark_score"], 3),
        "leader_to_third_gap": round(rows[0]["benchmark_score"] - rows[2]["benchmark_score"], 3),
        "success_reversal": round(rows[1]["success_rate"] - rows[0]["success_rate"], 2),
    }


def render_results(benchmark: dict[str, Any]) -> str:
    rows = benchmark["rows"]
    top_models = benchmark["top_models"]
    leader_score = rows[0]["benchmark_score"]
    output = [
        '<div class="results-layout">',
        '  <aside class="frontier-panel" aria-labelledby="frontier-title">',
        '    <div class="frontier-panel__intro">',
        '      <p class="home-kicker">Frontier by model ID</p>',
        '      <h3 id="frontier-title">Best observed setting per model</h3>',
        "      <p>Each card keeps only the strongest reasoning setting for that model ID. The canonical configuration ranking remains at right.</p>",
        "    </div>",
        '    <ol class="frontier-models">',
    ]
    for index, row in enumerate(top_models, 1):
        delta = leader_score - row["benchmark_score"]
        delta_label = "leader" if index == 1 else f"−{delta:.3f} vs. leader"
        output.extend(
            [
                (
                    f'      <li data-model="{html.escape(row["model"])}" '
                    f'data-effort="{html.escape(effort_label(row.get("reasoning_effort")))}">'
                ),
                f'        <span class="frontier-model__rank">{index:02d}</span>',
                f'        <span class="frontier-model__mark" aria-hidden="true">{monogram(row["model"])}</span>',
                '        <span class="frontier-model__identity">',
                f'          <strong>{html.escape(display_model(row["model"]))}</strong>',
                f'          <small>{html.escape(effort_label(row.get("reasoning_effort")))} reasoning · {delta_label}</small>',
                "        </span>",
                '        <span class="frontier-model__score">',
                f'          <strong>{row["benchmark_score"]:.3f}</strong><small>/100</small>',
                f'          <em>{row["success_rate"]:.2f}% success</em>',
                "        </span>",
                "      </li>",
            ]
        )
    output.extend(
        [
            "    </ol>",
            '    <div class="metric-note">',
            '      <span aria-hidden="true">↳</span>',
            "      <p><strong>Primary metric</strong> Equal-weight mean across 16 game × difficulty cells. Bars use the released 0–100 scale.</p>",
            "    </div>",
            '    <p class="baseline-note"><strong>Reference point</strong> Human baseline is not reported in this release.</p>',
            "  </aside>",
            '  <div class="ranking-panel">',
            '    <header class="ranking-panel__header">',
            "      <div>",
            '        <p class="home-kicker">Complete ranking</p>',
            '        <h3>All 18 model × reasoning configurations</h3>',
            "      </div>",
            '      <div class="ranking-legend" aria-label="Ranking columns"><span>Score</span><span>Success</span></div>',
            "    </header>",
            '    <ol class="ranking-list" data-ranking-list>',
        ]
    )
    for row in rows:
        effort = effort_label(row.get("reasoning_effort"))
        output.extend(
            [
                (
                    f'      <li class="ranking-row" data-rank="{row["rank"]}" '
                    f'data-model="{html.escape(row["model"])}" data-effort="{html.escape(effort)}" '
                    f'data-score="{row["benchmark_score"]:.3f}" data-success="{row["success_rate"]:.2f}">'
                ),
                f'        <span class="ranking-row__rank">{row["rank"]:02d}</span>',
                '        <span class="ranking-row__model">',
                f'          <strong>{html.escape(display_model(row["model"]))}</strong>',
                f'          <small>{html.escape(row["model"])}</small>',
                "        </span>",
                f'        <span class="ranking-row__effort">{html.escape(effort)}</span>',
                (
                    f'        <span class="ranking-row__bar" aria-label="Score {row["benchmark_score"]:.3f} out of 100">'
                    f'<i style="--score: {row["benchmark_score"]:.3f}%"></i></span>'
                ),
                f'        <strong class="ranking-row__score">{row["benchmark_score"]:.3f}</strong>',
                f'        <span class="ranking-row__success">{row["success_rate"]:.2f}%</span>',
                "      </li>",
            ]
        )
    output.extend(
        [
            "    </ol>",
            "  </div>",
            "</div>",
            '<ol class="result-observations" aria-label="Three observations from the results">',
            "  <li><span>01</span><p><strong>The top three configurations are all Sol settings.</strong> Medium leads low by "
            f'{benchmark["configuration_gap"]:.3f} points; high trails the leader by {benchmark["leader_to_third_gap"]:.3f}.</p></li>',
            "  <li><span>02</span><p><strong>Success alone does not set the rank.</strong> Sol-low solves "
            f'{benchmark["success_reversal"]:.2f} percentage points more levels, while Sol-medium earns the higher 16-cell score.</p></li>',
            "  <li><span>03</span><p><strong>No configuration leads every game.</strong> Sol-high leads Rush Hour; Terra-high leads Maze Paint and Color Connect; Kimi K3 leads Bolt Unscrew and Truck Escape.</p></li>",
            "</ol>",
        ]
    )
    return "\n".join(output)


def render_case_tabs(cases: list[dict[str, Any]]) -> str:
    output = []
    for index, case in enumerate(cases):
        selected = index == 0
        output.append(
            f'<button type="button" role="tab" id="case-tab-{case["id"]}" '
            f'aria-controls="trajectory-case" aria-selected="{str(selected).lower()}" '
            f'tabindex="{0 if selected else -1}" data-case-tab="{case["id"]}">'
            f'<span>0{index + 1}</span>{html.escape(case["tab"])}</button>'
        )
    return "\n".join(output)


def render_branch(branch: dict[str, Any], frame: dict[str, Any], index: int) -> str:
    output = frame["recorded_output"] or "No model-output excerpt selected for this moment."
    state_timing = "Before action" if frame["kind"] == "pre" else "After action"
    return "\n".join(
        [
            f'<section class="trajectory-run trajectory-run--{branch["tone"]}" data-case-branch="{index}">',
            '  <header class="trajectory-run__header">',
            "    <div>",
            f'      <span data-branch-label>{html.escape(branch["label"])}</span>',
            f'      <strong data-branch-model>{html.escape(branch["model"])}</strong>',
            "    </div>",
            f'    <span class="trajectory-run__rank" data-branch-rank>Rank {branch["rank"]} · {branch["benchmark_score"]:.3f}</span>',
            "  </header>",
            '  <figure class="trajectory-state">',
            '    <div class="trajectory-state__image">',
            (
                f'      <img src="{html.escape(frame["asset"])}" width="360" height="640" '
                f'alt="{html.escape(frame["description"])}" loading="lazy" decoding="async" data-case-image />'
            ),
            f'      <span data-case-state-label>{state_timing} {frame["step"]:02d}</span>',
            "    </div>",
            f'    <figcaption data-branch-thesis>{html.escape(branch["thesis"])}</figcaption>',
            "  </figure>",
            '  <dl class="trajectory-record">',
            "    <div class=\"trajectory-record__output\"><dt>Recorded model output</dt>"
            f'<dd data-case-output lang="und">{html.escape(output)}</dd></div>',
            "    <div class=\"trajectory-record__action\"><dt>Executed action</dt>"
            f'<dd><code data-case-action>{html.escape(frame["action"])}</code></dd></div>',
            "    <div class=\"trajectory-record__environment\"><dt>Environment</dt><dd>"
            f'<strong data-case-fact>{html.escape(frame["fact"])}</strong>'
            f'<span data-case-description>{html.escape(frame["description"])}</span>'
            f'<small data-case-feedback>Public feedback · {html.escape(frame["feedback"].replace("_", " "))}</small>'
            "</dd></div>",
            "  </dl>",
            f'  <p class="trajectory-run__outcome" data-branch-outcome>{html.escape(branch["outcome"])}</p>',
            "</section>",
        ]
    )


def render_case_fallback(cases: list[dict[str, Any]]) -> str:
    case = cases[0]
    return "\n".join(
        render_branch(branch, branch["frames"][0], index)
        for index, branch in enumerate(case["branches"])
    )


def generate() -> tuple[str, str, str, str]:
    leaderboard = json.loads(LEADERBOARD.read_text())
    findings = json.loads(FINDINGS.read_text())
    benchmark = build_benchmark(leaderboard)
    cases = build_cases(findings)
    payload = {
        "generated_from": {
            "leaderboard": "leaderboard/results.json",
            "leaderboard_sha256": sha256(LEADERBOARD),
            "findings": "blog/longpuzzlebench-agents/data/findings.json",
            "findings_sha256": sha256(FINDINGS),
        },
        "benchmark": benchmark,
        "cases": cases,
    }
    data_script = (
        "window.LONGPUZZLEBENCH_HOME_DATA="
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    return render_results(benchmark), render_case_tabs(cases), render_case_fallback(cases), data_script


def expected_homepage(source: str) -> tuple[str, str]:
    results, tabs, fallback, data_script = generate()
    updated = replace_generated(source, RESULTS_START, RESULTS_END, results)
    updated = replace_generated(updated, CASE_TABS_START, CASE_TABS_END, tabs)
    updated = replace_generated(updated, CASE_FALLBACK_START, CASE_FALLBACK_END, fallback)
    return updated, data_script


def main() -> int:
    args = parse_args()
    homepage_source = HOMEPAGE.read_text()
    expected_html, expected_data = expected_homepage(homepage_source)
    if args.check:
        stale = []
        if expected_html != homepage_source:
            stale.append(str(HOMEPAGE.relative_to(ROOT)))
        if not DATA_ASSET.is_file() or DATA_ASSET.read_text() != expected_data:
            stale.append(str(DATA_ASSET.relative_to(ROOT)))
        if stale:
            raise SystemExit(f"Generated homepage data is stale: {', '.join(stale)}")
        print("Homepage data is current: 18 rankings and 3 trajectory cases.")
        return 0
    HOMEPAGE.write_text(expected_html)
    DATA_ASSET.write_text(expected_data)
    print(f"Updated {HOMEPAGE.relative_to(ROOT)} and {DATA_ASSET.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
