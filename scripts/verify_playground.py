#!/usr/bin/env python3
"""Audit the assembled public site and its least-privilege Playground runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_RUNTIME_IDS = {
    "bolt_unscrew",
    "truck_escape_2",
    "nuts_bolts",
    "truck_escape",
    "maze_paint",
    "color_connect",
}
SHARED_ASSET_NAMES = {"site.css", "site.js"}
HOMEPAGE_ASSET_NAMES = SHARED_ASSET_NAMES | {"home.css", "home-data.js", "home.js"}
HOME_DATA_PREFIX = "window.LONGPUZZLEBENCH_HOME_DATA="


class ReferenceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: list[tuple[str, str, str]] = []
        self.tags: list[str] = []
        self.text: list[str] = []
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags.append(tag)
        attributes = dict(attrs)
        for name in ("src", "href", "poster"):
            value = attributes.get(name)
            if value:
                self.references.append((tag, name, value))
        if srcset := attributes.get("srcset"):
            for candidate in srcset.split(","):
                reference = candidate.strip().split(maxsplit=1)[0]
                if reference:
                    self.references.append((tag, "srcset", reference))
        if tag in {"script", "style"}:
            self.skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self.skip_depth:
            self.skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self.skip_depth:
            self.text.append(data)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", type=Path, default=ROOT / "dist" / "pages")
    return parser.parse_args()


def resolve_reference(page: Path, reference: str) -> Path:
    if not reference:
        return page
    path = (page.parent / reference).resolve()
    if path.is_dir():
        path /= "index.html"
    return path


def parse_page(path: Path) -> ReferenceParser:
    parser = ReferenceParser()
    parser.feed(path.read_text(encoding="utf-8"))
    return parser


def verify_page_references(site: Path, page: Path) -> tuple[ReferenceParser, set[Path]]:
    parser = parse_page(page)
    local_targets: set[Path] = set()
    for _tag, _attribute, reference in parser.references:
        if reference.startswith(("#", "mailto:", "tel:", "data:")):
            continue
        parsed = urlparse(reference)
        if parsed.scheme or parsed.netloc:
            continue
        assert not parsed.path.startswith("/"), f"Root-relative Pages path in {page}: {reference}"
        target = resolve_reference(page, parsed.path)
        assert target == site or target.is_relative_to(site), (reference, target)
        assert target.is_file(), (reference, target)
        local_targets.add(target)

    for stylesheet in (target for target in local_targets if target.suffix == ".css"):
        css = stylesheet.read_text(encoding="utf-8")
        for reference in re.findall(r'url\(["\']?([^"\')]+)', css):
            reference = reference.strip()
            if reference.startswith("data:"):
                continue
            parsed = urlparse(reference)
            if parsed.scheme or parsed.netloc:
                continue
            assert not parsed.path.startswith("/"), (
                f"Root-relative CSS path in {stylesheet}: {reference}"
            )
            target = resolve_reference(stylesheet, parsed.path)
            assert target == site or target.is_relative_to(site), (reference, target)
            assert target.is_file(), (reference, target)
    return parser, local_targets


def assert_asset_links(targets: set[Path], site: Path, names: set[str]) -> None:
    expected = {site / "assets" / name for name in names}
    assert expected <= targets, f"Missing page asset links: {sorted(map(str, expected - targets))}"


def visible_text(parser: ReferenceParser) -> str:
    return " ".join(" ".join(parser.text).split())


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_homepage_facts(home_parser: ReferenceParser) -> None:
    config = json.loads((ROOT / "configs" / "longpuzzlebench.json").read_text())
    results = json.loads((ROOT / "leaderboard" / "results.json").read_text())
    findings = json.loads(
        (ROOT / "blog" / "longpuzzlebench-agents" / "data" / "findings.json").read_text()
    )

    environment_count = len(config["games"])
    level_count = sum(
        len(difficulty["levels"]) for game in config["games"] for difficulty in game["difficulties"]
    )
    cell_count = sum(len(game["difficulties"]) for game in config["games"])
    ranked_runs = len(results["results"])
    top_run = min(results["results"], key=lambda run: run["rank"])
    bolt_deadlocks = findings["findings"]["future_actionability"]["no_available_hole_deadlocks"]

    assert (environment_count, level_count, cell_count) == (6, 114, 16)
    assert results["evaluation_setting"]["ranked_runs"] == ranked_runs == 18
    assert bolt_deadlocks == 13

    text = visible_text(home_parser).casefold()
    factual_patterns = {
        "environment count": rf"\b(?:{environment_count}|six)\b.{{0,45}}\b(?:games|environments|families)\b",
        "level count": rf"\b{level_count}\b.{{0,35}}\blevels\b",
        "cell count": rf"\b{cell_count}\b.{{0,45}}\b(?:cells|game\s*[\u00d7x]\s*difficulty)\b",
        "complete run count": rf"\b{ranked_runs}\b.{{0,45}}\b(?:complete\s+)?(?:runs|configurations)\b",
        "Bolt recurrence": rf"\b{bolt_deadlocks}\b\s*(?:/|of)\s*{ranked_runs}\b",
    }
    for claim, pattern in factual_patterns.items():
        assert re.search(pattern, text), f"Homepage is missing the verified {claim}"
    assert any(
        score in text
        for score in (f"{top_run['benchmark_score']:.3f}", f"{top_run['benchmark_score']:.1f}")
    )
    assert not re.search(r"\b18\s+(?:unique\s+)?models\b", text)


def verify_homepage_data(site: Path) -> None:
    source = (site / "assets" / "home-data.js").read_text()
    assert source.startswith(HOME_DATA_PREFIX) and source.endswith(";\n")
    assert not any(marker in source for marker in ("/Users/", "/home/", "C:\\Users\\"))
    payload = json.loads(source[len(HOME_DATA_PREFIX) : -2])
    canonical_results = json.loads((ROOT / "leaderboard" / "results.json").read_text())
    findings_path = ROOT / "blog" / "longpuzzlebench-agents" / "data" / "findings.json"

    generated = payload["generated_from"]
    assert generated["leaderboard_sha256"] == sha256(ROOT / "leaderboard" / "results.json")
    assert generated["findings_sha256"] == sha256(findings_path)
    assert payload["benchmark"]["rows"] == canonical_results["results"]
    assert [row["model"] for row in payload["benchmark"]["top_models"]] == [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "kimi-k3",
    ]

    cases = payload["cases"]
    assert [case["id"] for case in cases] == ["rush", "bolt", "color"]
    assert [len(case["branches"][0]["frames"]) for case in cases] == [4, 4, 6]
    assert all(case["matched_initial_frame"] for case in cases)
    expected_stories = [
        ["rush_grouped", "rush_split"],
        ["bolt_immediate", "bolt_deeper"],
        ["color_reserve", "color_recreate"],
    ]
    assert [
        [branch["story"] for branch in case["branches"]] for case in cases
    ] == expected_stories
    for case in cases:
        for branch in case["branches"]:
            for frame in branch["frames"]:
                assert frame["recorded_output"]
                assert frame["action"]
                assert frame["feedback"]
                assert (site / frame["asset"]).is_file(), frame["asset"]

    weak_rush = cases[0]["branches"][1]
    assert "small red vertical vehicle" in weak_rush["frames"][0]["recorded_output"]
    assert weak_rush["frames"][0]["feedback"] == "no_visible_effect"
    assert weak_rush["frames"][0]["action"] == "drag((292,731) → (292,602))"

    home_html = (site / "index.html").read_text()
    ranking_rows = re.findall(
        r'class="ranking-row" data-rank="(\d+)" data-model="([^"]+)" '
        r'data-effort="([^"]+)" data-score="([\d.]+)" data-success="([\d.]+)"',
        home_html,
    )
    assert len(ranking_rows) == 18
    assert len(ranking_rows) == len(canonical_results["results"])
    for rendered, canonical in zip(ranking_rows, canonical_results["results"]):
        rank, model, effort, score, success = rendered
        assert int(rank) == canonical["rank"]
        assert model == canonical["model"]
        assert effort == (canonical.get("reasoning_effort") or "default")
        assert float(score) == canonical["benchmark_score"]
        assert float(success) == canonical["success_rate"]
    assert home_html.count('role="tab" id="case-tab-') == 3
    assert "Recorded model output" in home_html
    assert "evaluator outcomes remain separately labelled" in home_html


def verify_homepage_links(site: Path, parser: ReferenceParser) -> None:
    catalog_source = (site / "play" / "catalog.js").read_text(encoding="utf-8")
    expected_slugs = set(re.findall(r'^\s+slug:\s*"([^"]+)"', catalog_source, re.MULTILINE))
    assert len(expected_slugs) == 6

    game_links: set[str] = set()
    play_links = 0
    research_links = 0
    for tag, attribute, reference in parser.references:
        if tag != "a" or attribute != "href":
            continue
        parsed = urlparse(reference)
        if parsed.scheme or parsed.netloc or parsed.path.startswith("/"):
            continue
        target = resolve_reference(site / "index.html", parsed.path)
        if target == site / "play" / "index.html":
            play_links += 1
            game_links.update(parse_qs(parsed.query).get("game", []))
        if target == site / "research" / "index.html":
            research_links += 1

    assert play_links, "Homepage has no relative Playground link"
    assert research_links, "Homepage has no relative Research link"
    assert game_links == expected_slugs, {
        "missing_game_links": sorted(expected_slugs - game_links),
        "unknown_game_links": sorted(game_links - expected_slugs),
    }


def verify_homepage_runtime_boundary(site: Path, parser: ReferenceParser) -> None:
    assert "iframe" not in parser.tags, "Homepage must not embed the Playground runtime"
    for path in (
        site / "index.html",
        *(site / "assets" / name for name in sorted(HOMEPAGE_ASSET_NAMES)),
    ):
        source = path.read_text(encoding="utf-8")
        assert not re.search(r"(?:runtime/index|[\"\']/runtime/|[\"\']runtime/)", source), path


def verify_legacy_game_redirect(home_html: str) -> None:
    assert not re.search(r'<meta[^>]+http-equiv=["\']refresh["\']', home_html, re.IGNORECASE)
    assert "noindex" not in home_html.casefold()
    inline_scripts = re.findall(
        r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", home_html, flags=re.DOTALL | re.IGNORECASE
    )
    redirect_scripts = [script for script in inline_scripts if "window.location.replace" in script]
    assert len(redirect_scripts) == 1, "Homepage must have one inline legacy game-link redirect"
    script = redirect_scripts[0]
    game_gate = re.search(r"\bif\s*\([^)]*\.\s*(?:get|has)\(\s*[\"\']game[\"\']\s*\)", script)
    assert game_gate, "Legacy redirect must be gated on the game query parameter"
    redirect_index = script.index("window.location.replace")
    assert game_gate.start() < redirect_index
    assert re.search(r"new\s+URL\(\s*[\"\']play/[\"\']\s*,\s*window\.location\.href\s*\)", script)
    assert "window.location.search" in script
    assert "window.location.hash" in script
    assert re.search(r"window\.location\.replace\([^)]*\.href\)", script)


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
        *(site / "assets" / name for name in sorted(HOMEPAGE_ASSET_NAMES)),
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
    assert len(re.findall(r'^\s+key:\s*"', catalog_source, flags=re.MULTILINE)) == 13
    assert "totalEvaluationLevels: 114" in catalog_source
    assert "a recorded successful agent attempt" in catalog_source
    assert 'key: "medium-3"' in catalog_source

    preview_paths = re.findall(r'preview:\s*"([^"]+)"', catalog_source)
    assert len(preview_paths) == 6
    for preview in preview_paths:
        path = resolve_reference(site / "play" / "index.html", preview)
        assert path.is_file() and path.stat().st_size > 1_000, path

    home_html_path = site / "index.html"
    play_html_path = site / "play" / "index.html"
    research_html_path = site / "research" / "index.html"
    home_parser, home_targets = verify_page_references(site, home_html_path)
    _play_parser, play_targets = verify_page_references(site, play_html_path)
    _research_parser, research_targets = verify_page_references(site, research_html_path)
    assert_asset_links(home_targets, site, HOMEPAGE_ASSET_NAMES)
    assert_asset_links(play_targets, site, SHARED_ASSET_NAMES)
    assert_asset_links(research_targets, site, SHARED_ASSET_NAMES)
    verify_homepage_facts(home_parser)
    verify_homepage_data(site)
    verify_homepage_links(site, home_parser)
    verify_homepage_runtime_boundary(site, home_parser)
    verify_legacy_game_redirect(home_html_path.read_text(encoding="utf-8"))

    app_source = (site / "play" / "app.js").read_text(encoding="utf-8")
    assert 'new URL("../runtime/index.html", window.location.href)' in app_source
    assert 'searchParams.set("playground", "1")' in app_source
    assert "__LONGPUZZLEBENCH_PLAY__" in app_source
    assert "__MINIGAME_BENCHMARK__" not in app_source
    assert "__game" not in app_source

    runtime_html = (site / "runtime" / "index.html").read_text(encoding="utf-8")
    assert "LongPuzzleBench game runtime" in runtime_html
    assert 'src="/' not in runtime_html and 'href="/' not in runtime_html
    runtime_bundle = (site / "runtime" / "assets" / "main" / "index.js").read_text(encoding="utf-8")
    assert "__LONGPUZZLEBENCH_PLAY__" in runtime_bundle
    assert "playground" in runtime_bundle

    native_assets = list((site / "runtime" / "assets" / "resources" / "native").rglob("*"))
    assert sum(path.is_file() for path in native_assets) >= 19
    assert (site / "runtime" / "cocos-js" / "assets" / "spine-CC34fKUR.wasm").is_file()

    game_main = (
        ROOT / "games" / "puzzle_suite" / "assets" / "scripts" / "game" / "GameMain.ts"
    ).read_text()
    assert "GameInspector.instance.install(!benchmark.playground)" in game_main
    assert "installPlaygroundBridge" in game_main
    assert "setDirectLaunchMode(directLaunchMode)" in game_main
    assert "setAutoHintEnabled(!disableAutoHint)" in game_main

    not_found = (site / "404.html").read_text(encoding="utf-8")
    assert 'const projectSlug = "LongPuzzleBench"' in not_found
    assert 'const route = routeParts.join("/")' in not_found
    assert 'new Set(["play", "research"])' in not_found
    assert "missingSlashRoutes.has(route)" in not_found
    assert 'document.querySelector("#home-link").href = home.href' in not_found
    assert not_found.count("window.location.replace") == 1

    total_bytes = sum(path.stat().st_size for path in site.rglob("*") if path.is_file())
    assert total_bytes < 12 * 1024 * 1024, total_bytes
    print(
        "Verified public site: factual homepage, 6 linked games, 13 curated levels, "
        "114-level disclosure, research and Playground routes, complete runtime assets, "
        f"relative Pages paths, {total_bytes / 1024 / 1024:.1f} MiB."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
