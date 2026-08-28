#!/usr/bin/env python3
"""Assemble the static LongPuzzleBench GitHub Pages artifact."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "dist" / "pages"
HOMEPAGE = ROOT / "index.html"
SITE_ASSETS = (
    ROOT / "assets" / "site.css",
    ROOT / "assets" / "site.js",
    ROOT / "assets" / "home.css",
    ROOT / "assets" / "home-data.js",
    ROOT / "assets" / "home.js",
)
PLAYGROUND = ROOT / "playground"
RUNTIME = ROOT / "games" / "puzzle_suite" / "build" / "web-mobile"
RESEARCH = ROOT / "blog" / "longpuzzlebench-agents"
PREVIEWS = RESEARCH / "assets" / "games"

NOT_FOUND = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#f2eee5">
  <title>Page not found · LongPuzzleBench</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body {
      display: grid;
      min-height: 100svh;
      margin: 0;
      padding: 2rem;
      place-items: center;
      background: #f2eee5;
      color: #16272e;
    }
    main { width: min(100%, 38rem); }
    p:first-child {
      margin: 0 0 1rem;
      color: #a7442d;
      font: 700 0.75rem/1 ui-monospace, monospace;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    h1 { margin: 0; font: 700 clamp(2.5rem, 9vw, 5rem)/0.98 Georgia, serif; }
    p { max-width: 34rem; margin: 1.35rem 0; line-height: 1.65; }
    a { color: inherit; font-weight: 700; text-underline-offset: 0.22em; }
    a:focus-visible { outline: 3px solid #bf9140; outline-offset: 4px; }
  </style>
</head>
<body>
  <main>
    <p>LongPuzzleBench · 404</p>
    <h1>This path is not part of the puzzle.</h1>
    <p>The page may have moved. Return to the project homepage to explore the benchmark, research note, and playable games.</p>
    <p><a id="home-link" href="https://azurestarz.github.io/LongPuzzleBench/">Return to LongPuzzleBench</a></p>
  </main>
  <script>
    const projectSlug = "LongPuzzleBench";
    const pathParts = window.location.pathname.split("/").filter(Boolean);
    const projectIndex = pathParts.indexOf(projectSlug);
    const baseParts = projectIndex >= 0 ? pathParts.slice(0, projectIndex + 1) : [];
    const routeParts = projectIndex >= 0 ? pathParts.slice(projectIndex + 1) : pathParts;
    const basePath = `/${baseParts.join("/")}${baseParts.length ? "/" : ""}`;
    const route = routeParts.join("/");
    const home = new URL(basePath, window.location.origin);
    document.querySelector("#home-link").href = home.href;

    const missingSlashRoutes = new Set(["play", "research"]);
    if (missingSlashRoutes.has(route)) {
      const target = new URL(`${basePath}${route}/`, window.location.origin);
      target.search = window.location.search;
      target.hash = window.location.hash;
      window.location.replace(target.href);
    }
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
    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "build_home_data.py"), "--check"],
        cwd=ROOT,
        check=True,
    )
    output = args.output.expanduser().resolve()
    source_roots = (ROOT / "assets", PLAYGROUND, RUNTIME, RESEARCH)
    if any(paths_overlap(output, source) for source in source_roots):
        raise ValueError(f"Refusing to replace a source directory: {output}")

    for required in (
        HOMEPAGE,
        *SITE_ASSETS,
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
    shutil.copy2(HOMEPAGE, output / "index.html")
    for asset in SITE_ASSETS:
        shutil.copy2(asset, output / "assets" / asset.name)

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

    (output / "404.html").write_text(NOT_FOUND, encoding="utf-8")
    (output / ".nojekyll").touch()

    file_count = sum(path.is_file() for path in output.rglob("*"))
    total_bytes = sum(path.stat().st_size for path in output.rglob("*") if path.is_file())
    print(f"Built {file_count} static files ({total_bytes / 1024 / 1024:.1f} MiB) at {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
