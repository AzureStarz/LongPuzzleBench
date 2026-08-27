"""Command-line interface for LongPuzzleBench."""

from __future__ import annotations

import argparse
from collections.abc import Callable
from typing import Any

from mobile_world.core.subcommands import eval, leaderboard, play


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="longpuzzlebench",
        description="Long-horizon visual puzzle-game evaluation for GUI agents",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    play.configure_parser(subparsers)
    eval.configure_parser(subparsers)
    leaderboard.configure_parser(subparsers)
    return parser


def main() -> None:
    args = create_parser().parse_args()
    handler: Callable[[argparse.Namespace], Any] = args.handler
    handler(args)


__all__ = ["create_parser", "main"]
