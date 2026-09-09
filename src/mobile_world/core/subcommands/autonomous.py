"""Independent autonomous evaluation and offline trajectory regrading commands."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import threading
from datetime import UTC, datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from mobile_world.benchmarks.autonomous_runner import AutonomousConfig, run_autonomous_episode


def _display_selector(value: str) -> str | int:
    if value in {"secondary", "primary"}:
        return value
    try:
        index = int(value)
    except ValueError:
        index = 0
    if index < 1:
        raise argparse.ArgumentTypeError("display must be secondary, primary, or a positive index")
    return index


def configure_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("autonomous", help="Run a complete autonomous browser episode")
    parser.set_defaults(handler=execute)
    parser.add_argument("--game", required=True)
    parser.add_argument("--difficulty", required=True)
    parser.add_argument(
        "--level",
        type=int,
        default=None,
        help="Optional single-level debugging objective; default evaluates the entire difficulty",
    )
    parser.add_argument(
        "--windowed",
        action="store_true",
        help="Keep desktop browser windowed instead of fullscreen",
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--step-wait-time",
        type=float,
        default=2.0,
        help="Seconds after each action before the next screenshot (default: 2)",
    )
    parser.add_argument("--timeout", type=float, default=3600, help="Global wall-clock seconds")
    parser.add_argument(
        "--agent", default="autonomous_visual", help="Baseline or BaseAgent Python file"
    )
    parser.add_argument("--model", default=os.getenv("LONGPUZZLEBENCH_MODEL"))
    parser.add_argument("--model-base-url", default=os.getenv("OPENAI_BASE_URL", ""))
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--log-level",
        choices=("DEBUG", "INFO", "WARNING", "ERROR"),
        default="INFO",
        help="Console logging; DEBUG includes model messages with screenshot data omitted",
    )
    parser.add_argument(
        "--base-url", help="Native Game Suite runtime root; omit to serve the bundled runtime"
    )
    parser.add_argument(
        "--display",
        type=_display_selector,
        default="secondary",
        metavar="secondary|primary|N",
        help="Desktop display; defaults to the first secondary display, or primary if alone",
    )
    parser.add_argument("--viewport-width", type=int, default=1280)
    parser.add_argument("--viewport-height", type=int, default=900)
    parser.add_argument(
        "--capture-surface",
        choices=("desktop", "viewport"),
        default="desktop",
        help="desktop includes browser chrome; viewport is a separate test profile",
    )
    parser.add_argument(
        "--headless", action="store_true", help="Only with --capture-surface viewport"
    )
    regrade = subparsers.add_parser("autonomous-regrade", help="Recompute metrics from raw events")
    regrade.set_defaults(handler=regrade_events)
    regrade.add_argument("trajectory", type=Path)
    regrade.add_argument("--output", type=Path)


def regrade_events(args: argparse.Namespace) -> None:
    from mobile_world.benchmarks.autonomous_metrics import (
        evaluate_autonomous_trajectory,
        load_trajectory_jsonl,
    )

    result = evaluate_autonomous_trajectory(load_trajectory_jsonl(args.trajectory))
    content = json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    if args.output:
        args.output.write_text(content)
    else:
        print(content)


def _configure_logging(level: str) -> None:
    logger = logging.getLogger("mobile_world.autonomous")
    logger.setLevel(level)
    logger.propagate = False
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%H:%M:%S"))
    logger.addHandler(handler)


def execute(args: argparse.Namespace) -> None:
    _configure_logging(args.log_level)
    from mobile_world.agents.autonomous import AutonomousVisualAgent
    from mobile_world.agents.registry import load_agent_from_file
    from mobile_world.runtime.autonomous_browser import AutonomousBrowser

    config = AutonomousConfig(
        game_id=args.game,
        difficulty=args.difficulty,
        level_id=args.level,
        seed=args.seed,
        timeout_seconds=args.timeout,
        step_wait_time=args.step_wait_time,
    )
    if args.headless and args.capture_surface == "desktop":
        raise SystemExit("Desktop capture requires a headed browser")
    root = Path(__file__).resolve().parents[4]
    # Validate the public objective against the released task catalogue.
    from mobile_world.benchmarks.catalog import load_catalog
    from mobile_world.benchmarks.progress import canonical_progress_game_id

    catalog = load_catalog(root / "configs/longpuzzlebench.json")
    if not any(
        canonical_progress_game_id(task.game_id) == config.target["game_id"]
        and task.difficulty == config.difficulty
        and (config.level_id is None or int(task.level_id) == config.level_id)
        for task in catalog.tasks
    ):
        raise SystemExit("Objective is not in the released catalogue")
    if args.agent == "autonomous_visual":
        if not args.model:
            raise SystemExit("--model is required for autonomous_visual")
        agent = AutonomousVisualAgent(
            args.model, args.model_base_url, os.getenv("OPENAI_API_KEY", "")
        )
    else:
        agent = load_agent_from_file(args.agent)(
            model_name=args.model or "",
            llm_base_url=args.model_base_url,
            api_key=os.getenv("OPENAI_API_KEY", ""),
        )
    server = None
    base_url = args.base_url
    if not base_url:
        site = root / "games/puzzle_suite/build/web-mobile"
        if not (site / "index.html").is_file():
            raise SystemExit(f"Native Game Suite build is missing: {site}")
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(site))
        )
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base_url = f"http://127.0.0.1:{server.server_address[1]}"
    output = args.output or root / "results/autonomous" / datetime.now(UTC).strftime(
        "%Y%m%dT%H%M%S%fZ"
    )
    browser = AutonomousBrowser(
        base_url=base_url,
        viewport=(args.viewport_width, args.viewport_height),
        headless=args.headless,
        seed=args.seed,
        capture_surface=args.capture_surface,
        display=args.display,
        fullscreen=not args.windowed,
    )
    try:
        result = asyncio.run(run_autonomous_episode(browser, agent, config, output))
        print(
            json.dumps(
                {
                    "output": str(output),
                    "termination_reason": result["termination_reason"],
                    "scoring": result["scoring"],
                },
                indent=2,
            )
        )
    finally:
        if server:
            server.shutdown()
            server.server_close()
