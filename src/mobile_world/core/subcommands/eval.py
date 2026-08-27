"""LongPuzzleBench evaluation command."""

from __future__ import annotations

import argparse
from pathlib import Path

from rich.console import Console

from mobile_world.agents.providers import KNOWN_PROVIDERS, apply_provider_settings
from mobile_world.benchmarks.mini_games_runner import run_mini_games_benchmark

GAMES = (
    "bolt_unscrew",
    "rush_hour_2",
    "nut_and_bolt",
    "truck_escape",
    "maze_paint",
    "color_connect",
)
DIFFICULTIES = ("easy", "medium", "hard", "extreme", "nightmare", "default")


def configure_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("eval", help="Run one formal game × difficulty cell")
    parser.set_defaults(handler=execute)
    parser.add_argument("--config", default="configs/longpuzzlebench.json")
    parser.add_argument("--game", required=True, choices=GAMES)
    parser.add_argument("--difficulty", required=True, choices=DIFFICULTIES)
    parser.add_argument(
        "--agent",
        "--agent-type",
        dest="agent_type",
        default="general_e2e",
        help="Built-in 'general_e2e' agent or path to a BaseAgent Python file",
    )
    parser.add_argument("--model", "--model-name", dest="model_name")
    parser.add_argument(
        "--model-base-url",
        "--llm-base-url",
        dest="llm_base_url",
        help="OpenAI-compatible API base URL (default: OPENAI_BASE_URL)",
    )
    parser.add_argument("--provider", choices=KNOWN_PROVIDERS)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--seeds", default=None, help="Comma-separated deterministic seeds")
    parser.add_argument("--num-runs", type=int, default=1)
    parser.add_argument("--prompt-setting", choices=("minimal", "full"))
    parser.add_argument("--eval-mode", choices=("progressive", "all_levels"))
    parser.add_argument("--max-steps", dest="max_round", type=int)
    parser.add_argument("--timeout", type=int, help="Per-level play timeout in seconds")
    parser.add_argument("--history-images", dest="history_n_images", type=int)
    parser.add_argument("--max-output-tokens", type=int, default=1024)
    parser.add_argument(
        "--reasoning-effort",
        choices=("none", "low", "medium", "high", "xhigh", "max"),
        default="medium",
    )
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--scale-factor", type=int, default=1000)
    parser.add_argument("--step-wait-time", type=float)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--headed-viewport-width", type=int)
    parser.add_argument("--headed-viewport-height", type=int)
    parser.add_argument("--base-url", help="Use an externally hosted game build")
    parser.add_argument("--game-project", help="Override the repository game project")
    parser.add_argument("--rebuild", action="store_true", help="Rebuild with Cocos Creator")
    parser.add_argument("--cocos-creator", help="Path to a Cocos Creator executable")
    parser.add_argument(
        "--dry-run", action="store_true", help="Validate and materialize the run plan"
    )
    parser.set_defaults(
        api_key=None,
        log_file_root=None,
        skip_build=False,
        executor_llm_base_url=None,
        executor_model_name=None,
        executor_agent_class=None,
    )


def execute(args: argparse.Namespace) -> None:
    apply_provider_settings(args)
    if not args.dry_run and args.agent_type == "general_e2e" and not args.model_name:
        raise SystemExit("--model or LONGPUZZLEBENCH_MODEL is required for general_e2e evaluation")
    result = run_mini_games_benchmark(args)
    if args.dry_run:
        Console().print(
            "Validated "
            f"{result['total_tasks']} planned levels; "
            f"artifacts: {result['files']['summary_json']}"
        )


__all__ = ["DIFFICULTIES", "GAMES", "configure_parser", "execute"]
