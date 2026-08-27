"""Offline leaderboard generation for LongPuzzleBench result artifacts."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

from rich.console import Console

from mobile_world.benchmarks.results import ResultWriter, _agent_identity, load_results


def configure_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "leaderboard",
        help="Generate a LongPuzzleBench leaderboard from episode results",
    )
    parser.set_defaults(handler=execute)
    parser.add_argument(
        "--input",
        nargs="+",
        required=True,
        help="Result directory or JSON/JSONL file (multiple inputs may be merged)",
    )
    parser.add_argument(
        "--output",
        help="Output directory; defaults to the input directory for one directory input",
    )


def execute(args: argparse.Namespace) -> None:
    sources = [Path(item).expanduser().resolve() for item in args.input]
    results_by_source = [(source, load_results(source)) for source in sources]
    score_denominators: dict[str, int] = defaultdict(int)
    planned_by_agent: dict[str, list[dict]] = defaultdict(list)
    source_summaries: list[dict] = []
    for source, results in results_by_source:
        summary_path = source / "summary.json" if source.is_dir() else None
        summary = {}
        if summary_path is not None and summary_path.is_file():
            loaded = json.loads(summary_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                summary = loaded
                source_summaries.append(summary)
        benchmark = summary.get("benchmark", {})
        total_tasks = benchmark.get("total_tasks") if isinstance(benchmark, dict) else None
        identities = {_agent_identity(result.agent_information) for result in results}
        difficulty_path = source / "difficulty_results.json" if source.is_dir() else None
        loaded_plan = False
        if difficulty_path is not None and difficulty_path.is_file():
            difficulty_payload = json.loads(difficulty_path.read_text(encoding="utf-8"))
            entries = (
                difficulty_payload.get("entries", [])
                if isinstance(difficulty_payload, dict)
                else []
            )
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                identity = entry.get("leaderboard_identity")
                plan = entry.get("planned_episodes")
                if isinstance(identity, str) and isinstance(plan, list):
                    planned_by_agent[identity].extend(
                        item for item in plan if isinstance(item, dict)
                    )
                    loaded_plan = True
        if not loaded_plan:
            for result in results:
                identity = _agent_identity(result.agent_information)
                planned_by_agent[identity].append(
                    {
                        "task": result.task.model_dump(mode="json"),
                        "task_id": result.task.task_id,
                        "seed": result.seed,
                        "runtime": result.runtime,
                    }
                )
            not_run = benchmark.get("not_run_tasks") if isinstance(benchmark, dict) else None
            if isinstance(not_run, list):
                for identity in identities:
                    planned_by_agent[identity].extend(
                        item for item in not_run if isinstance(item, dict)
                    )
        for identity in identities:
            if isinstance(total_tasks, int) and total_tasks >= 0:
                score_denominators[identity] += total_tasks
            else:
                score_denominators[identity] += sum(
                    1 for result in results if _agent_identity(result.agent_information) == identity
                )
    if args.output is None and len(sources) == 1 and sources[0].is_dir():
        writer = ResultWriter(sources[0])
    else:
        output = Path(args.output or "leaderboard/generated").expanduser().resolve()
        writer = ResultWriter(output)
        for _, results in results_by_source:
            for result in results:
                writer.write_episode(result.model_copy(update={"episode_id": None}, deep=True))
    benchmark_summary = None
    expected_episode_count = None
    if len(source_summaries) == 1:
        candidate = source_summaries[0].get("benchmark")
        if isinstance(candidate, dict):
            benchmark_summary = candidate
            total = candidate.get("total_tasks")
            if isinstance(total, int):
                expected_episode_count = total
    files = writer.finalize(
        expected_episode_count=expected_episode_count,
        benchmark_summary=benchmark_summary,
        score_denominators=score_denominators,
        planned_episodes=dict(planned_by_agent) or None,
    )
    console = Console()
    console.print(f"Difficulty results: {files['difficulty_results_json']}")
    console.print(f"Leaderboard JSON: {files['leaderboard_json']}")
    console.print(f"Leaderboard CSV: {files['leaderboard_csv']}")


__all__ = ["configure_parser", "execute"]
