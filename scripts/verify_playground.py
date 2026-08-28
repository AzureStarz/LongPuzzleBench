#!/usr/bin/env python3
"""Audit the assembled static playground and its least-privilege runtime surface."""

from __future__ import annotations

import argparse
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_RUNTIME_IDS = {
    "bolt_unscrew",
    "truck_escape_2",
    "nuts_bolts",
    "truck_escape",
    "maze_paint",
    "color_connect",
}


class ReferenceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        for name in ("src", "href"):
            value = attributes.get(name)
            if value and not value.startswith(("#", "mailto:")):
                parsed = urlparse(value)
                if not parsed.scheme and not parsed.netloc:
                    self.references.append(parsed.path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", type=Path, default=ROOT / "dist" / "pages")
    return parser.parse_args()


def resolve_reference(page: Path, reference: str) -> Path:
    path = (page.parent / reference).resolve()
    if path.is_dir():
        path /= "index.html"
    return path


def catalog_level_total() -> int:
    payload = json.loads((ROOT / "configs" / "longpuzzlebench.json").read_text())
    return sum(
        len(difficulty["levels"])
        for game in payload["games"]
        for difficulty in game["difficulties"]
    )


def main() -> int:
    args = parse_args()
    site = args.site.expanduser().resolve()
    required = (
        site / "index.html",
        site / "404.html",
        site / ".nojekyll",
        site / "play" / "index.html",
        site / "play" / "app.js",
        site / "play" / "catalog.js",
        site / "play" / "styles.css",
        site / "runtime" / "index.html",
        site / "runtime" / "assets" / "main" / "index.js",
        site / "research" / "index.html",
        site / "notices" / "PUZZLE_SUITE_NOTICE.md",
    )
    for path in required:
        assert path.is_file(), path

    assert catalog_level_total() == 114
    catalog_source = (site / "play" / "catalog.js").read_text(encoding="utf-8")
    runtime_ids = set(re.findall(r'runtimeId:\s*"([^"]+)"', catalog_source))
    assert runtime_ids == EXPECTED_RUNTIME_IDS, runtime_ids
    assert len(re.findall(r'^\s+key:\s*"', catalog_source, flags=re.MULTILINE)) == 12
    assert "totalEvaluationLevels: 114" in catalog_source
    assert "a recorded successful agent attempt" in catalog_source

    preview_paths = re.findall(r'preview:\s*"([^"]+)"', catalog_source)
    assert len(preview_paths) == 6
    for preview in preview_paths:
        path = resolve_reference(site / "play" / "index.html", preview)
        assert path.is_file() and path.stat().st_size > 1_000, path

    play_html_path = site / "play" / "index.html"
    play_html = play_html_path.read_text(encoding="utf-8")
    parser = ReferenceParser()
    parser.feed(play_html)
    for reference in parser.references:
        assert not reference.startswith("/"), f"Root-relative Pages path: {reference}"
        target = resolve_reference(play_html_path, reference)
        assert target.is_file(), (reference, target)

    app_source = (site / "play" / "app.js").read_text(encoding="utf-8")
    assert 'new URL("../runtime/index.html", window.location.href)' in app_source
    assert 'searchParams.set("playground", "1")' in app_source
    assert "__LONGPUZZLEBENCH_PLAY__" in app_source
    assert "__MINIGAME_BENCHMARK__" not in app_source
    assert "__game" not in app_source

    runtime_html = (site / "runtime" / "index.html").read_text(encoding="utf-8")
    assert "LongPuzzleBench game runtime" in runtime_html
    assert 'src="/' not in runtime_html and 'href="/' not in runtime_html
    runtime_bundle = (site / "runtime" / "assets" / "main" / "index.js").read_text(
        encoding="utf-8"
    )
    assert "__LONGPUZZLEBENCH_PLAY__" in runtime_bundle
    assert "playground" in runtime_bundle

    native_assets = list((site / "runtime" / "assets" / "resources" / "native").rglob("*"))
    assert sum(path.is_file() for path in native_assets) >= 19
    assert (site / "runtime" / "cocos-js" / "assets" / "spine-CC34fKUR.wasm").is_file()

    game_main = (ROOT / "games" / "puzzle_suite" / "assets" / "scripts" / "game" / "GameMain.ts").read_text()
    assert "GameInspector.instance.install(!benchmark.playground)" in game_main
    assert "installPlaygroundBridge" in game_main
    assert "setDirectLaunchMode(directLaunchMode)" in game_main
    assert "setAutoHintEnabled(!disableAutoHint)" in game_main

    root_redirect = (site / "index.html").read_text(encoding="utf-8")
    assert 'new URL("play/", window.location.href)' in root_redirect
    assert "target.search = window.location.search" in root_redirect

    total_bytes = sum(path.stat().st_size for path in site.rglob("*") if path.is_file())
    assert total_bytes < 12 * 1024 * 1024, total_bytes
    print(
        "Verified playground: 6 games, 12 curated levels, 114-level disclosure, "
        f"complete runtime assets, relative Pages paths, {total_bytes / 1024 / 1024:.1f} MiB."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
