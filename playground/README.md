# LongPuzzleBench human playground

The playground is a zero-install, static research exhibit for experiencing LongPuzzleBench. It is deliberately separate from the agent evaluation harness.

## Architecture decision

Repository inspection found that the smallest faithful human runtime already exists: the six canonical environments are TypeScript components in one Cocos Creator 3.8.8 project, and Cocos produces a static browser bundle. The playground therefore uses:

1. a dependency-free HTML/CSS/JavaScript shell in `playground/`;
2. the checked-in Cocos web build in `games/puzzle_suite/build/web-mobile/`;
3. the original controllers, level definitions, collision rules, physics, scoring-state machines, and win/failure checks;
4. a small same-origin iframe bridge that exposes only readiness, status, selected level, terminal state, and action count.

No backend, framework, Pyodide, or new game engine is required. Bolt Unscrew keeps Cocos physics because replacing it would risk changing occlusion, plank motion, and deadlocks. Rush Hour, Nut and Bolt, Truck Escape, Maze Paint, and Color Connect already have browser-native rule models and controllers, so porting them again would create a second source of truth without reducing the shipped runtime enough to justify the fidelity risk.

## Playable scope

The first public gallery contains two deliberately selected levels from each of all six game families:

- **Maze Paint:** a seven-swipe introduction and a verified 25-swipe route;
- **Bolt Unscrew:** a one-transfer introduction and a hard level with future-hole deadlocks;
- **Rush Hour:** a four-drag introduction and a verified 15-drag level that requires temporary regression;
- **Nut and Bolt:** a compact sort and a 56-nut workspace challenge;
- **Truck Escape:** 10-truck and 50-truck dependency chains;
- **Color Connect:** a four-pair introduction and an eight-pair shared-corridor challenge.

These 12 entries are **playable demo levels**, not a claim that the gallery is the complete benchmark. The canonical evaluation catalog remains 114 levels across 16 game × difficulty cells in `configs/longpuzzlebench.json`.

## Fidelity and intentional differences

The browser exhibit and evaluator use the same compiled game controllers and level data. Legal actions, object identity, collision and overlap checks, gravity, occlusion, irreversible states, path occupancy, success, and failure behavior are unchanged.

The human playground intentionally differs from formal evaluation in these ways:

- it does not expose raw board state, reference solutions, deadlock diagnostics, scores, trajectories, or evaluator metrics;
- it does not enforce the agent step and wall-clock budgets;
- direct launches disable Truck Escape's idle correct-move highlight;
- direct launches hide Hub navigation and pin completion actions to the deep-linked level;
- Nut and Bolt does not automatically advance away from a completed deep-linked level;
- the displayed action count is a lightweight input count, not a benchmark score;
- the outer exhibit supplies concise English instructions while some original in-game labels remain localized.

Formal equivalence should continue to be established against the canonical evaluator, not inferred from the human shell.

## Trajectory replay decision

The repository's public research article already replays real trajectory screenshots with previous/next and play/pause controls. Replaying those actions inside the live Cocos scene is not a cheap extension: the canonical logs contain screenshots and GUI actions, while the runtime has no supported arbitrary-state import contract for all six controllers. Adding one would expand the evaluator surface and require cross-game state migration tests. The first version therefore links to the existing evidence player and keeps the live runtime focused on human play. A future live replay should drive recorded legal actions from a fresh level and verify every resulting state hash rather than injecting approximate visuals.

## Deep links

Game state is selected with query parameters, which work without client-side routing or a Pages rewrite:

```text
/play/?game=rush-hour&difficulty=hard&level=6
/play/?game=car-escape&difficulty=easy&level=1
/play/?game=bolt-unscrew&difficulty=hard&level=1
```

Legacy public and runtime IDs such as `rush_hour_2`, `truck_escape_2`, `nut_and_bolt`, and `nuts_bolts` are accepted as aliases. Reset reloads the exact selected level; switching the selector updates the shareable URL.

## Build and verify locally

The Pages artifact is assembled entirely from checked-in files:

```bash
python3 scripts/build_pages.py
python3 scripts/verify_playground.py
python3 -m http.server --directory dist/pages 8000
```

Then open `http://localhost:8000/play/`. The browser integration test additionally serves the artifact below `/LongPuzzleBench/` to catch root-path assumptions:

```bash
uv run pytest -q tests/integration/test_playground_browser.py
```

Game-rule regression tests remain in `games/puzzle_suite/tools/*.test.mjs`, and the existing Playwright integration suite exercises valid and invalid interactions, termination, and resets in the canonical evaluator path.

## Rebuild the Cocos runtime

Cocos Creator 3.8.8 is needed only after changing game TypeScript or assets. Build to a temporary directory, inspect it, and then replace the checked-in `web-mobile` output:

```bash
/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/MacOS/CocosCreator \
  --project games/puzzle_suite \
  --build "platform=web-mobile;buildPath=/tmp/longpuzzlebench-build"
```

Creator may exit with code `36` after producing a complete command-line build on macOS, so validation checks the output files and browser behavior rather than relying on that exit code alone. The checked-in bundle must include `assets/resources/native/` textures and the Cocos Spine assets; `scripts/verify_playground.py` enforces both.

## Add another demo level

Add a curated entry to the existing game's `levels` list in `playground/catalog.js`. Use the public difficulty and one-based level number from `configs/longpuzzlebench.json`. Any horizon or action statement must come from a verified solver result or a clearly labeled recorded trajectory. Rebuild the Pages artifact and run the static plus browser verifiers.

## Add another game family

1. Add or reuse an authoritative browser controller and level source inside `games/puzzle_suite`.
2. Register its provider with `GameInspector` and query routing in `GameMain`.
3. Extend the least-privilege public state bridge without exposing evaluator-only state.
4. Rebuild and validate the Cocos bundle.
5. Add the gallery metadata and preview.
6. Add model tests and a real browser initialization/interaction/reset case.

Do not introduce a common adapter unless it removes real duplication across game families.

## GitHub Pages deployment

`.github/workflows/pages.yml` builds `dist/pages`, verifies it, uploads that directory, and deploys it on pushes to `main`. The artifact contains:

```text
/             research-project homepage
/play/       human exhibit
/runtime/    canonical Cocos web build
/research/   trajectory-analysis article
/assets/     shared site shell and optimized previews
/notices/    license and attribution notices
```

All internal URLs are relative, so assets resolve at `https://<username>.github.io/<repo>/`. The root is the project homepage; legacy root links that contain a `game` query still forward to `play/` while preserving query parameters and fragments.

## Redistribution notice

`games/puzzle_suite/NOTICE.md` records that the imported puzzle-suite source and assets did not include a standalone license. The repository-level Apache-2.0 license covers only material for which contributors hold the necessary rights. Public redistribution of the imported game code and assets requires authorization from their copyright holders; the Pages artifact includes this notice rather than obscuring the issue.
