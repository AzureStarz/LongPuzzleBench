"""Launch or smoke-check one bundled LongPuzzleBench level."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from rich.console import Console

from mobile_world.benchmarks.catalog import load_catalog
from mobile_world.benchmarks.evaluator import MiniGameEvaluator
from mobile_world.benchmarks.mini_games_runner import _make_environment, _resolve_config
from mobile_world.core.subcommands.eval import DIFFICULTIES, GAMES


def configure_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("play", help="Launch one bundled puzzle level")
    parser.set_defaults(handler=execute)
    parser.add_argument("--config", default="configs/longpuzzlebench.json")
    parser.add_argument("--game", default="bolt_unscrew", choices=GAMES)
    parser.add_argument("--difficulty", default="easy", choices=DIFFICULTIES)
    parser.add_argument("--level", type=int, default=1)
    parser.add_argument("--headless", action="store_false", dest="headed")
    parser.add_argument("--check", action="store_true", help="Start, inspect readiness, and exit")
    parser.add_argument("--screenshot", type=Path)
    parser.add_argument("--base-url")
    parser.add_argument("--game-project")
    parser.add_argument("--rebuild", action="store_true")
    parser.add_argument("--cocos-creator")
    parser.add_argument("--headed-viewport-width", type=int)
    parser.add_argument("--headed-viewport-height", type=int)
    parser.add_argument("--step-wait-time", type=float)
    parser.set_defaults(headed=True, skip_build=False)


def execute(args: argparse.Namespace) -> None:
    config_path = _resolve_config(args.config)
    catalog = load_catalog(config_path)
    tasks = catalog.filter(
        game_id=args.game,
        difficulty=args.difficulty,
        level_id=args.level,
        seed=0,
    )
    if not tasks:
        raise SystemExit(f"No level matched {args.game}/{args.difficulty}/level-{args.level}")
    env = _make_environment(catalog, MiniGameEvaluator(), args)
    console = Console()
    try:
        env.start()
        observation = env.initialize_task(tasks[0])
        state = env.get_game_state()
        if args.screenshot:
            args.screenshot.parent.mkdir(parents=True, exist_ok=True)
            observation.screenshot.save(args.screenshot)
        console.print(
            "LongPuzzleBench ready: "
            f"{state.get('game_id')}/{state.get('difficulty')}/level-{state.get('level_id')} "
            f"status={state.get('status')} screenshot={observation.screenshot.size[0]}x{observation.screenshot.size[1]}"
        )
        if not args.check:
            console.print("Browser is open. Press Ctrl-C to stop.")
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        env.close()


__all__ = ["configure_parser", "execute"]
