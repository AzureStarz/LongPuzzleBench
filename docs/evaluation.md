# Evaluation guide

LongPuzzleBench exposes two complementary evaluation protocols. The benchmark's
paper-facing default is **Autonomous Evaluation**: the agent starts from the
native game hub, discovers the target game and difficulty, plays the complete
cell, and recovers through the UI when needed. `longpuzzlebench autonomous` is
the canonical entry point for this protocol.

The catalog runner, `longpuzzlebench eval`, is the controlled harness protocol.
It launches a fixed game × difficulty cell with deterministic task metadata and
is useful for ablations, debugging, and agents that already implement the
benchmark lifecycle outside the native hub.

## Protocols and implementations

| Protocol | Entry point | Agent implementation | Interaction contract | Use |
| --- | --- | --- | --- | --- |
| Autonomous Evaluation | `longpuzzlebench autonomous` | `autonomous_visual` | Screenshot observations and parsed GUI actions | Baseline visual agent and compatibility runs |
| Autonomous Evaluation | `longpuzzlebench autonomous --agent autonomous_tools` | `autonomous_tools` | Responses API tools; default `code_execution` uses the persistent `cua_repl` | Paper-facing code-execution CUA runs |
| Autonomous Evaluation | `longpuzzlebench autonomous --agent autonomous_gui` | `autonomous_gui` | Structured Computer Tool `action` envelope | Native structured GUI runs; no shell, DOM, or text-action fallback |
| Controlled harness | `longpuzzlebench eval` | Built-in OpenAI-compatible baseline or a custom `BaseAgent` | Fixed catalog cell, cropped screenshot, public action feedback | Reproducible harness checks and agent development |

`autonomous_tools` also retains `--tool-execution-mode legacy` and `batched`
for historical comparisons. They remain supported evaluation settings and are
separate from the default `code_execution` profile. Historical Codex App runs
are implemented by `scripts/gui_game_benchmark.py`; its `code_execution` and
`structured_computer_tool` settings map to the two Codex pathways documented in
[`docs/harness-cua-alignment.md`](harness-cua-alignment.md).

## Autonomous Evaluation (recommended)

Run one complete game × difficulty objective:

```bash
uv run longpuzzlebench autonomous \
  --game maze_paint \
  --difficulty easy \
  --model "$LONGPUZZLEBENCH_MODEL" \
  --output results/autonomous/maze-paint-easy
```

For code-execution CUA:

```bash
uv run longpuzzlebench autonomous \
  --agent autonomous_tools \
  --game maze_paint --difficulty easy \
  --model "$LONGPUZZLEBENCH_MODEL" \
  --output results/autonomous/tools-maze-paint-easy
```

For structured Computer Tool evaluation:

```bash
uv run longpuzzlebench autonomous \
  --agent autonomous_gui \
  --game maze_paint --difficulty easy \
  --model "$LONGPUZZLEBENCH_MODEL" \
  --output results/autonomous/structured-maze-paint-easy
```

The full objective includes every released level in the selected cell. The
seed is fixed and the trajectory is append-only. Regrade a recorded episode
without invoking a model:

```bash
uv run longpuzzlebench autonomous-regrade \
  results/autonomous/tools-maze-paint-easy/events.jsonl \
  --output results/autonomous/tools-maze-paint-easy/regraded.json
```

The paper's main results use this autonomous, full-lifecycle setting. Reported
scores use the same normalized per-level score and macro-average aggregation as
the public leaderboard.

## Controlled harness

Use `eval` when the task catalog and launch state should be fixed by the
harness:

```bash
uv run longpuzzlebench eval \
  --game bolt_unscrew --difficulty easy \
  --dry-run --output results/dry-run
```

A formal run uses the configured progressive policy: a failed level stops the
cell's sequential unlock, and skipped levels remain in the denominator. See
[`configs/longpuzzlebench.json`](../configs/longpuzzlebench.json) for the
versioned catalog, seeds, limits, and metric configuration.

## Outputs

Every run writes machine-readable JSON plus an append-only `events.jsonl` for
autonomous episodes. Screenshots, model requests, decisions, dispatched
actions, termination reasons, and evaluator snapshots are kept together so a
result can be inspected or regraded. `results/`, `artifacts/`, and local logs
are ignored by Git; copy only sanitized, complete result summaries into
`leaderboard/` or a release artifact directory.
