#!/usr/bin/env python3
"""Assemble the static LongPuzzleBench GitHub Pages artifact."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "dist" / "pages"
PLAYGROUND = ROOT / "playground"
RUNTIME = ROOT / "games" / "puzzle_suite" / "build" / "web-mobile"
RESEARCH = ROOT / "blog" / "longpuzzlebench-agents"
PREVIEWS = RESEARCH / "assets" / "games"

ROOT_REDIRECT = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Play LongPuzzleBench</title>
  <meta http-equiv="refresh" content="0; url=play/">
</head>
<body>
  <p>Opening the <a href="play/">LongPuzzleBench playground</a>…</p>
  <script>
    const target = new URL("play/", window.location.href);
    target.search = window.location.search;
    target.hash = window.location.hash;
    window.location.replace(target.href);
  </script>
</body>
</html>
"""

NOT_FOUND = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>LongPuzzleBench</title>
</head>
<body>
  <p>Returning to the <a id="playground" href="./play/">LongPuzzleBench playground</a>…</p>
  <script>
    const first = window.location.pathname.split("/").filter(Boolean)[0];
    const base = first ? `/${first}/` : "/";
    const target = new URL(`${base}play/`, window.location.origin);
    target.search = window.location.search;
    target.hash = window.location.hash;
    document.querySelector("#playground").href = target.href;
    window.location.replace(target.href);
  </script>
</body>
</html>
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def require_file(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"Required Pages input is missing: {path}")


def copy_tree(source: Path, destination: Path) -> None:
    if not source.is_dir():
        raise FileNotFoundError(f"Required Pages input is missing: {source}")
    shutil.copytree(source, destination)


def paths_overlap(left: Path, right: Path) -> bool:
    """Return whether either path contains the other."""
    return left == right or left in right.parents or right in left.parents


def main() -> int:
    args = parse_args()
    output = args.output.expanduser().resolve()
    source_roots = (PLAYGROUND, RUNTIME, RESEARCH)
    if any(paths_overlap(output, source) for source in source_roots):
        raise ValueError(f"Refusing to replace a source directory: {output}")

    for required in (
        PLAYGROUND / "index.html",
        PLAYGROUND / "app.js",
        PLAYGROUND / "catalog.js",
        RUNTIME / "index.html",
        RUNTIME / "assets" / "main" / "index.js",
        RESEARCH / "index.html",
        ROOT / "LICENSE",
        ROOT / "NOTICE",
        ROOT / "THIRD_PARTY_NOTICES.md",
        ROOT / "games" / "puzzle_suite" / "NOTICE.md",
    ):
        require_file(required)

    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    copy_tree(PLAYGROUND, output / "play")
    copy_tree(RUNTIME, output / "runtime")
    copy_tree(RESEARCH, output / "research")
    copy_tree(PREVIEWS, output / "assets" / "games")

    runtime_index = output / "runtime" / "index.html"
    runtime_html = runtime_index.read_text(encoding="utf-8")
    runtime_html = runtime_html.replace(
        "<title>Cocos Creator | longpuzzlebench-puzzle-suite</title>",
        "<title>LongPuzzleBench game runtime</title>",
    )
    runtime_index.write_text(runtime_html, encoding="utf-8")

    notices = output / "notices"
    notices.mkdir()
    shutil.copy2(ROOT / "LICENSE", notices / "LICENSE")
    shutil.copy2(ROOT / "NOTICE", notices / "NOTICE")
    shutil.copy2(ROOT / "THIRD_PARTY_NOTICES.md", notices / "THIRD_PARTY_NOTICES.md")
    shutil.copy2(
        ROOT / "games" / "puzzle_suite" / "NOTICE.md",
        notices / "PUZZLE_SUITE_NOTICE.md",
    )

    (output / "index.html").write_text(ROOT_REDIRECT, encoding="utf-8")
    (output / "404.html").write_text(NOT_FOUND, encoding="utf-8")
    (output / ".nojekyll").touch()

    file_count = sum(path.is_file() for path in output.rglob("*"))
    total_bytes = sum(path.stat().st_size for path in output.rglob("*") if path.is_file())
    print(f"Built {file_count} static files ({total_bytes / 1024 / 1024:.1f} MiB) at {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
