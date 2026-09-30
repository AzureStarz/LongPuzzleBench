# Contributing to LongPuzzleBench

LongPuzzleBench contributions should preserve deterministic task selection, evaluator isolation, and reproducible scoring. Before opening a change, read [`docs/evaluation.md`](docs/evaluation.md) and [`configs/longpuzzlebench.json`](configs/longpuzzlebench.json).

## Development setup

```bash
uv sync --extra dev --locked
uv run playwright install chromium
uv run pytest -q
uv run ruff check src tests scripts
```

## Adding an environment

1. Add stable game, difficulty, level, and seed launch parameters.
2. Implement the browser bridge, terminal state, progress metric, and normalized score.
3. Add the task catalog entry and unit tests for scoring and state transitions.
4. Add a real-browser launch check and update the bundled web runtime and previews.
5. Document the interaction contract and include a deterministic smoke command.

Keep evaluator-only state on the scoring path. Do not commit credentials, local trajectories, generated caches, or unsanitized model logs. Public result summaries belong under `leaderboard/`; local run output belongs under ignored `results/` or `artifacts/` directories.

## Pull requests

Describe the user-visible or reproducibility impact, list validation commands and results, and keep benchmark terminology aligned with the paper and [`docs/evaluation.md`](docs/evaluation.md). Changes that alter scores or task definitions should include the catalog/configuration rationale and regenerated sanitized artifacts.
