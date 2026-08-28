# LongPuzzleBench trajectory article

This directory contains the static research article **“The Move Was Legal. The Puzzle Was Already Lost.”**

**[Read the published article](https://azurestarz.github.io/LongPuzzleBench/)**

The article has no runtime dependencies. Open `index.html` directly, or serve it from the repository root:

```bash
uv run python -m http.server 8000
```

Then open `http://localhost:8000/blog/longpuzzlebench-agents/`.

## Rebuild the empirical figures

The checked-in `data/findings.json`, file-safe `data/findings.js`, and optimized trajectory frames are generated from the canonical evaluation outputs corresponding to the public leaderboard runs, not manually entered chart values:

```bash
uv run python scripts/analyze_blog_trajectories.py \
  --results-root /path/to/canonical/results
```

The results directory must contain one folder per public leaderboard run, with canonical episodes under `<run>/leaderboard/episodes/` and image-backed traces under each game and difficulty directory. Every exported frame records its source path and SHA-256 hash in `data/findings.json`.

Raw evaluation outputs are intentionally excluded from Git. The release contains the sanitized
derived evidence, source hashes, and the script needed to rebuild it from a local results export.

Counts refer to **executed trajectories**. Under the progressive protocol, levels skipped after a cell failure contribute to the benchmark score but do not produce a trajectory and are excluded from behavioral denominators. The script also verifies the byte-identical matched states used in the article, replays Nut and Bolt's interaction state machine, and hashes every exported source frame.

Run the artifact audit after rebuilding:

```bash
uv run python scripts/verify_blog.py
```

## Release contents

Committed:

- `index.html`, `styles.css`, and `article.js`;
- `data/findings.json` and the direct-file fallback `data/findings.js`;
- all referenced game thumbnails, empirical trajectory frames, and the labeled conceptual illustration;
- the repository-level analysis and verification scripts.

Not committed:

- canonical raw evaluation outputs and full trajectory logs;
- local browser screenshots under `artifacts/blog-qa/`;
- caches, temporary servers, and editor state.

## Asset provenance

- Empirical animations use recorded LongPuzzleBench screenshots.
- Game thumbnails come from the bundled puzzle suite and follow its `NOTICE.md`.
- The state-ledger image is a conceptual illustration generated with OpenAI image generation; the page labels it as non-empirical.
- The hero and all five finding comparisons use recorded board states.
