# Autonomous evaluation

Autonomous episodes evaluate discovering a game, selecting its difficulty,
starting, playing, recovering, and completing all released levels in that difficulty. The existing `eval` command
retains its cropped observations, play-time clock, progression policies,
termination rules, and scoring. Keep these modes in separate leaderboard tracks.

## Run

```sh
# Actual desktop pixels, including browser chrome (macOS)
longpuzzlebench autonomous --game maze_paint --difficulty easy \
  --model MODEL --timeout 3600 --output results/autonomous/example

# Uncropped browser-content profile for headless automation and CI
longpuzzlebench autonomous --game maze_paint --difficulty easy \
  --agent path/to/agent.py --capture-surface viewport --headless \
  --output results/autonomous/viewport-example

# Recompute metrics without invoking an agent or browser
longpuzzlebench autonomous-regrade results/autonomous/example/events.jsonl \
  --output results/autonomous/example/regraded.json
```

`OPENAI_API_KEY` and `OPENAI_BASE_URL` configure the screenshot baseline;
`LONGPUZZLEBENCH_MODEL` supplies the default model. To use a project `.env` file,
export it in the launching shell before running the command:

```sh
set -a
source .env
set +a
.venv/bin/python -m mobile_world.run autonomous \
  --game maze_paint --difficulty easy --timeout 300
```

The headed browser shows the agent's actions live. By default, it opens on the
first secondary display and enters browser fullscreen; a single-display system
falls back to the primary. `--windowed` keeps the browser in a normal window.
Fullscreen is applied only during environment setup, not restored during play.
macOS fullscreen can hide browser chrome until the pointer reaches the top edge.
`--display primary` selects the primary display and `--display 2` selects a
1-based display index (primary first, then secondary displays ordered by position).
Capture covers that full display, and input uses its desktop origin and scale.
The selected display and single-screen fallback are recorded in browser metadata.

You can watch terminal logs on the primary display while the browser runs on the
secondary. Mouse and keyboard input are still system-wide: typing or clicking
while the agent operates can change focus and interfere with the run.

The built-in `AutonomousVisualAgent` subclasses `GeneralE2EAgentMCP`. It inherits
model-specific image resizing, coordinate conversion, provider/API routing,
response parsing, and multi-action queues. A response may contain one or multiple
actions; all valid actions are queued in order, including a terminal action.
Queued actions do not trigger another model request. Each dispatched action
still receives the configured screenshot delay. Episode completion, timeout, or
an explicit terminal action ends execution even if more actions remain. Its browser-specific prompt permits
navigation and recovery. History is organized by model call: the first observation includes the task;
subsequent model observations contain screenshots only. Each assistant message
preserves the complete original reply, including visible Thought text and all
Actions. Queued actions execute without adding synthetic conversation turns.
Intermediate screenshots remain in the trajectory; the next model call receives
the latest screenshot after the queue drains. Dispatch
feedback, game state, and grader annotations are not inserted into model history.
Execution results remain in the trajectory.

`HISTORY_N_IMAGES` counts completed model-call observation/reply pairs, with the
current screenshot retained in addition. Unset, all screenshots are retained;
`HISTORY_N_IMAGES=3` retains three historical screenshots plus the current one;
`HISTORY_N_IMAGES=0` retains only the current screenshot. Older replies remain,
and omitted images receive the same placeholder as `general_e2e`. All-image
history can consume substantial context in long episodes. The effective window
and baseline version are recorded in episode metadata.

Custom agents implement `BaseAgent.initialize(instruction)` and
`predict(observation) -> (response_text, JSONAction)`. They receive pixels and
dispatch acknowledgements, not a browser handle or game-state object. Custom
Python agents are trusted integrations, not sandboxed adversarial code.

With no `--base-url`, the command serves the bundled native Cocos Game Suite
(`games/puzzle_suite/build/web-mobile`) on loopback. An external base URL must
serve that runtime, with `index.html` at its root. Each episode starts in a fresh
browser context at the original Game Suite home menu. The public demo is separate
and is not used for evaluation. The agent selects games, difficulties and levels
through the original game UI. The default public task identifies the game and difficulty, without solutions or
navigation instructions. The seed is fixed across
attempts and recorded. Output directories must be new to avoid mixing episodes.

## Objective scope

The default evaluation unit is **game × difficulty**, matching the benchmark's
released catalogue. No `--level` is needed:

```sh
longpuzzlebench autonomous --game maze_paint --difficulty easy
```

For focused single-level debugging, explicitly pass `--level 2`. That retains the
single-level completion and scoring semantics. Single-level runs and whole-
difficulty runs are distinct objectives and should not share a leaderboard track.
Individual level IDs remain in grader telemetry and attempt records so progress,
retries, and navigation can still be analyzed.

## Boundaries

- `autonomous_browser.py`: environment setup, screenshots, direct input, and
  private state sampling. No task-specific navigation or reset.
- `autonomous_runner.py`: one monotonic deadline, inference, input dispatch,
  and append-only recording. Browser state evolves during inference. Failures,
  wrong entries, and loops do not end an episode.
- The native Game Suite retains its own menus and lifecycle controls. An
  opt-in passive bridge supplies grader snapshots without launching a game.
- `autonomous_metrics.py`: offline measurements and versioned scoring, reusing
  existing per-game progress potentials through a read-only adapter.

The default budget is 3,600 seconds, beginning when environment setup finishes.
Inference, navigation, waits, play, and recovery all consume it. A blocked model
call cannot dispatch after the deadline. By default, completion requires an
observed success for every released level in the selected game and difficulty.
Completing one level does not end the episode: the agent chooses whether and how
to continue through the native UI. Retries, exits, and re-entry retain completed
levels; repeated wins on the same level do not add completion credit. The level
list is frozen from the catalogue into the episode target for offline regrading.
Other termination reasons are
`timeout`, `agent_terminated`, and `environment_error`. Provider-call failures
are logged and consume time; they are not game failures.

After every dispatched action, autonomous waits **2 seconds** before capturing
the next agent screenshot. Use `--step-wait-time 1` for a one-second delay, or
`--step-wait-time 0` to disable it. The delay consumes the global time budget;
private telemetry sampling and completion checks continue during the wait.
The initial screenshot is not delayed. Legacy `eval` settings are unchanged.

## Live CLI logging

Autonomous CLI runs log to stderr at `INFO` by default. Logs show environment
startup, screenshot references, model request numbers and model names, request
latency, complete model responses, parsed actions, dispatch results, and episode
termination. Responses appear when each model call returns; this is not token
streaming. The final machine-readable JSON remains on stdout.

Use `--log-level DEBUG` to also print the baseline's outbound message history.
Image payloads are replaced with `[screenshot omitted]`; API credentials and
request headers are not printed. Logs do not alter the messages sent to the model.
Custom agents get runner-level observation/decision logs; their internal provider
requests require logging in the agent itself.

```sh
longpuzzlebench autonomous --game maze_paint --difficulty easy \
  --log-level DEBUG 2>&1 | tee autonomous-debug.log
```

`--log-level WARNING` or `ERROR` suppresses normal request/response output. Debug
logs contain task text and model responses; treat saved logs accordingly.

## Native runtime bridge

The native HomePage and game controllers provide the UI. Passive instrumentation
is maintained in `games/puzzle_suite/assets/scripts/game/AutonomousBridge.js`.
Update the bundled web runtime after editing it:

```sh
node games/puzzle_suite/tools/build-autonomous-runtime.mjs
```

The command installs that same module into the shipped browser build and applies
the autonomous-only Truck Escape hint policy. Legacy evaluation and the public
playground retain their existing entry points and behavior.

## Trajectory format

`events.jsonl` records `schema_version`, `seq`, UTC `timestamp`, monotonic
`elapsed_seconds`, `type`, and `data`. Version 1 event types:

| Type | Data |
| --- | --- |
| `episode_start` | Target, seed, timeout, effective configuration, browser metadata |
| `snapshot` | URL, game/level, lifecycle, attempt, progress, game-specific measurements, private state |
| `observation` | Screenshot reference and dimensions |
| `decision` | Source observation sequence, agent response, parsed action |
| `action` | Dispatched action, acceptance, error, optional observed UI target |
| `agent_error` | Failed inference call |
| `episode_end` | Termination reason, infrastructure error, and agent usage |

Screenshots live under `screenshots/`. Model responses retain their native
coordinate format in history and decision response text; dispatched actions use
original screenshot pixels. The model prompt declares the coordinate convention:
normalized coordinates for models using the baseline's normalization policy,
pixel coordinates for GPT-5.6, and the baseline's resized-image coordinates for
Claude. The inherited adapter converts them before dispatch. Logs show both raw
model responses and converted actions.
Snapshots are sampled during inference and between actions. The raw stream and
`result.json` are separate: adding a metric does not require another model run.
Screenshots/actions support visual playback; seeds/actions support reproduction
attempts, not bit-exact replay of asynchronous browser timing.

## Metrics and scoring

Common metrics cover entry/start latency and actions, wrong entries, action
repetition, observed state changes, target progress, attempts, failure/recovery
latency, re-entry, lifecycle time, and final outcome. Per-game progress diagnostics
are preserved separately. Metrics describe behavior, not intent or cognition.
Accepted/valid actions mean successful input dispatch, not a legal puzzle move.
Unobservable semantic no-ops, accidental exits, and unsupported deadlock fields
remain null; repeated actions and unchanged sampled states are named separately.

Default runs use `autonomous-game-difficulty-v2`. Progress is the mean of the
best observed progress for every released level, including zero for unvisited
levels. Completed levels remain at 1 across restarts and re-entry. Results include
`objective_level_count`, `completed_level_count`, `completed_level_ids`, and
`level_progress`; attempt records retain their individual `level_id`. Derived
annotations distinguish `level_complete` from `objective_completion`.

Explicit single-level runs and historical trajectories retain `autonomous-v1`.
Both scoring versions use these maximum component weights:

| Component | Weight |
| --- | ---: |
| Outcome | 40 |
| Best target progress | 30 |
| Process control | 15 |
| Observed recovery | 5 |
| Efficiency | 10 |

Recovery is inapplicable without a failure opportunity; its weight is
redistributed proportionally. Efficiency is gated by progress: random
exploration alone earns no efficiency credit. Results preserve raw metrics,
component ratios, effective weights, composite score, and sequence-linked derived
annotations. Native restart controls advance attempt identity. Explicit grader-reported deadlocks are recorded but never terminate an
episode or produce an Agent hint. Compare identical
task, seed, capture profile, browser configuration, and timeout.

## Limitations

Desktop capture requires macOS, Xcode Command Line Tools, an interactive desktop,
and OS Screen Recording/Accessibility permissions. It captures the
selected display, including native browser menus; use a dedicated display without
unrelated windows or notifications. Desktop viewport options specify requested
outer window size; actual window/content/display geometry is recorded. Viewport
capture includes all visible web UI but not native browser
chrome; it is a distinct profile. Sampling cannot prove every transient animation
or infer that an exit was accidental. Canvas hit-test validity, hidden deadlocks,
and cognitive recognition are not inferred from a click alone. A daemonized
provider call may finish after the episode, but has no browser access and its
result is discarded.

