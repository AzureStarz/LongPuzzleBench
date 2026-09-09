"""Offline metrics and scoring for full-browser autonomous trajectories.

The functions in this module consume only persisted trajectory events.  They do
not drive the browser and do not expose evaluator snapshots to an agent.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
SCORING_VERSION = "autonomous-v1"
GAME_DIFFICULTY_SCORING_VERSION = "autonomous-game-difficulty-v2"
IDLE_GAP_THRESHOLD_SECONDS = 30.0
EVENT_TYPES = {
    "episode_start",
    "snapshot",
    "observation",
    "decision",
    "action",
    "agent_error",
    "episode_end",
}

_BASE_WEIGHTS = {
    "outcome": 40.0,
    "progress": 30.0,
    "process_control": 15.0,
    "recovery": 5.0,
    "efficiency": 10.0,
}


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    if result != result or result in (float("inf"), float("-inf")):
        return None
    return result


def _clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return min(maximum, max(minimum, value))


def parse_trajectory_jsonl(source: str | Iterable[str]) -> list[dict[str, Any]]:
    """Parse trajectory JSONL text or lines and validate the stable envelope."""

    lines = source.splitlines() if isinstance(source, str) else source
    events: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(
                f"invalid trajectory JSON on line {line_number}: {error.msg}"
            ) from error
        if not isinstance(value, dict):
            raise ValueError(f"trajectory line {line_number} must be a JSON object")
        events.append(value)
    _validated_events(events)
    return events


def load_trajectory_jsonl(path: str | Path) -> list[dict[str, Any]]:
    """Load and validate a UTF-8 trajectory JSONL file."""

    return parse_trajectory_jsonl(Path(path).read_text(encoding="utf-8"))


def _validated_events(events: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    validated: list[dict[str, Any]] = []
    previous_seq = -1
    previous_elapsed = -1.0
    for index, event in enumerate(events):
        if not isinstance(event, Mapping):
            raise ValueError(f"trajectory event {index} must be a mapping")
        item = dict(event)
        if item.get("schema_version") != SCHEMA_VERSION:
            raise ValueError(f"trajectory event {index} has unsupported schema_version")
        seq = item.get("seq")
        elapsed = _number(item.get("elapsed_seconds"))
        if not isinstance(seq, int) or isinstance(seq, bool) or seq < 0:
            raise ValueError(f"trajectory event {index} has invalid seq")
        if elapsed is None or elapsed < 0:
            raise ValueError(f"trajectory event {index} has invalid elapsed_seconds")
        if seq <= previous_seq:
            raise ValueError("trajectory seq values must be strictly increasing")
        if elapsed < previous_elapsed:
            raise ValueError("trajectory elapsed_seconds must be monotonic")
        if item.get("type") not in EVENT_TYPES:
            raise ValueError(f"trajectory event {index} has invalid type")
        if not isinstance(item.get("timestamp"), str) or not item["timestamp"]:
            raise ValueError(f"trajectory event {index} has invalid timestamp")
        if not isinstance(item.get("data"), Mapping):
            raise ValueError(f"trajectory event {index} data must be a mapping")
        item["data"] = dict(item["data"])
        validated.append(item)
        previous_seq = seq
        previous_elapsed = elapsed
    return validated


def _same_identifier(actual: Any, expected: Any) -> bool:
    return expected is None or (actual is not None and str(actual) == str(expected))


def _is_game_difficulty_target(target: Mapping[str, Any]) -> bool:
    return target.get("scope") == "game_difficulty"


def _target_level_ids(target: Mapping[str, Any]) -> tuple[Any, ...]:
    raw = target.get("level_ids")
    if not isinstance(raw, list) or not raw:
        return ()
    result: list[Any] = []
    seen: set[str] = set()
    for level_id in raw:
        if isinstance(level_id, bool) or not isinstance(level_id, (str, int)):
            continue
        identity = str(level_id)
        if identity not in seen:
            seen.add(identity)
            result.append(level_id)
    return tuple(result)


def _catalog_level_id(actual: Any, target: Mapping[str, Any]) -> Any | None:
    if actual is None:
        return None
    for level_id in _target_level_ids(target):
        if _same_identifier(actual, level_id):
            return level_id
    return None


class ObjectiveProgress:
    """Track benchmark completion without controlling the game lifecycle.

    Explicit-level targets retain the original one-success completion rule.
    Game+difficulty targets require one observed success for every catalogued
    level and retain completed levels across retries, exits, and re-entry.
    """

    def __init__(self, target: Mapping[str, Any]) -> None:
        self.target = dict(target)
        self.level_ids = _target_level_ids(target)
        if _is_game_difficulty_target(target) and not self.level_ids:
            raise ValueError("game_difficulty target requires non-empty level_ids")
        self.completed_level_ids: set[Any] = set()
        self._legacy_completed = False

    def update(self, snapshot: Mapping[str, Any]) -> None:
        if str(snapshot.get("lifecycle", "")).lower() != "success":
            return
        if not _is_target(snapshot, self.target):
            return
        if _is_game_difficulty_target(self.target):
            level_id = _catalog_level_id(snapshot.get("level_id"), self.target)
            if level_id is not None:
                self.completed_level_ids.add(level_id)
        else:
            self._legacy_completed = True

    @property
    def completed(self) -> bool:
        if _is_game_difficulty_target(self.target):
            return bool(self.level_ids) and all(
                level_id in self.completed_level_ids for level_id in self.level_ids
            )
        return self._legacy_completed


def _is_target(snapshot: Mapping[str, Any], target: Mapping[str, Any]) -> bool:
    if not target.get("game_id"):
        return False
    identifiers_match = all(
        (
            _same_identifier(snapshot.get("game_id"), target.get("game_id")),
            _same_identifier(snapshot.get("difficulty"), target.get("difficulty")),
            _same_identifier(snapshot.get("seed"), target.get("seed")),
        )
    )
    if not identifiers_match:
        return False
    if _is_game_difficulty_target(target):
        return _catalog_level_id(snapshot.get("level_id"), target) is not None
    return _same_identifier(snapshot.get("level_id"), target.get("level_id"))


def _is_target_surface(snapshot: Mapping[str, Any], target: Mapping[str, Any]) -> bool:
    lifecycle = str(snapshot.get("lifecycle", "")).lower()
    if lifecycle == "menu":
        return bool(target.get("game_id")) and all(
            (
                _same_identifier(snapshot.get("game_id"), target.get("game_id")),
                snapshot.get("difficulty") is None
                or _same_identifier(snapshot.get("difficulty"), target.get("difficulty")),
                snapshot.get("level_id") is None
                or (
                    _catalog_level_id(snapshot.get("level_id"), target) is not None
                    if _is_game_difficulty_target(target)
                    else _same_identifier(snapshot.get("level_id"), target.get("level_id"))
                ),
                _same_identifier(snapshot.get("seed"), target.get("seed")),
            )
        )
    return _is_target(snapshot, target) and lifecycle != "gallery"


def _is_launched(snapshot: Mapping[str, Any], target: Mapping[str, Any]) -> bool:
    return _is_target(snapshot, target) and str(snapshot.get("lifecycle", "")).lower() in {
        "playing",
        "failure",
        "success",
    }


def _semantic_types(data: Mapping[str, Any]) -> list[str]:
    raw = data.get("events", ())
    if isinstance(raw, (str, Mapping)):
        raw = (raw,)
    if not isinstance(raw, Iterable):
        return []
    result: list[str] = []
    for value in raw:
        event_type = (
            value.get("event_type") or value.get("type") if isinstance(value, Mapping) else value
        )
        if isinstance(event_type, str):
            result.append(event_type.strip().lower())
    return result


def _suite_events(events: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Return de-duplicated events emitted by the private Game Suite bridge."""

    result: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for outer in events:
        if outer.get("type") != "snapshot":
            continue
        data = outer.get("data")
        raw_events = data.get("events") if isinstance(data, Mapping) else None
        if not isinstance(raw_events, list):
            continue
        for raw in raw_events:
            if not isinstance(raw, Mapping):
                continue
            item = dict(raw)
            identity = (
                item.get("wall_time"),
                item.get("sequence"),
                item.get("event_type") or item.get("type"),
            )
            if identity in seen:
                continue
            seen.add(identity)
            result.append(item)
    return result


def _action_name(data: Mapping[str, Any]) -> str:
    def normalize(value: str) -> str:
        compact = "".join(character for character in value.strip().lower() if character.isalnum())
        aliases = {
            "resetgame": "restart",
            "restartgame": "restart",
            "navigateback": "back",
            "gohome": "home",
        }
        return aliases.get(compact, value.strip().lower())

    target = data.get("target")
    if isinstance(target, str) and target:
        return normalize(target)
    action = data.get("action")
    if isinstance(action, Mapping):
        for key in ("name", "action_type", "type", "key"):
            value = action.get(key)
            if isinstance(value, str) and value:
                return normalize(value)
    return ""


def _action_identity(data: Mapping[str, Any]) -> str:
    return json.dumps(
        {"action": data.get("action"), "target": data.get("target")},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def _snapshot_identity(data: Mapping[str, Any]) -> tuple[Any, ...]:
    return (
        data.get("url"),
        data.get("game_id"),
        data.get("difficulty"),
        data.get("level_id"),
        data.get("attempt_id"),
        data.get("lifecycle"),
        _number(data.get("progress")),
        json.dumps(data.get("game_specific", {}), sort_keys=True, default=str),
    )


def _round_optional(value: float | None) -> float | None:
    return None if value is None else round(value, 6)


def derive_autonomous_metrics(events: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Derive reproducible common metrics from an autonomous event trajectory.

    Progress is accepted only from snapshots matching the target declared by
    ``episode_start``.  The private ``state`` field is deliberately ignored.
    """

    items = _validated_events(events)
    starts = [event for event in items if event["type"] == "episode_start"]
    if len(starts) != 1:
        raise ValueError("trajectory must contain exactly one episode_start")
    target = dict(starts[0]["data"].get("target") or {})
    if not target.get("game_id"):
        raise ValueError("episode_start data.target.game_id is required")
    objective = ObjectiveProgress(target)
    difficulty_scoped = _is_game_difficulty_target(target)
    per_level_best = {level_id: 0.0 for level_id in objective.level_ids}

    actions = [event for event in items if event["type"] == "action"]
    snapshots = [event for event in items if event["type"] == "snapshot"]
    suite_events = _suite_events(items)
    ends = [event for event in items if event["type"] == "episode_end"]
    end = ends[-1] if ends else None
    total_time = float(
        end["elapsed_seconds"] if end else (items[-1]["elapsed_seconds"] if items else 0)
    )
    timeout_seconds = _number(starts[0]["data"].get("timeout_seconds"))
    end_reason = end["data"].get("reason") if end else None

    accepted = sum(event["data"].get("accepted") is True for event in actions)
    invalid = sum(event["data"].get("accepted") is False for event in actions)
    outside_count = sum(
        event["data"].get("error") == "outside_actionable_region"
        or "outside_actionable_region" in _semantic_types(event["data"])
        for event in actions
    )
    click_actions = [
        event
        for event in actions
        if isinstance(event["data"].get("action"), Mapping)
        and str(
            event["data"]["action"].get("action_type") or event["data"]["action"].get("type") or ""
        ).lower()
        in {"click", "tap"}
    ]
    outside = (
        outside_count
        if click_actions
        and all(
            event["data"].get("target") not in (None, "")
            or event["data"].get("error") == "outside_actionable_region"
            or "outside_actionable_region" in _semantic_types(event["data"])
            for event in click_actions
        )
        else None
    )
    repeated = 0
    repeated_loops = 0
    run_length = 0
    previous_identity: str | None = None
    action_diversity: set[str] = set()
    for event in actions:
        identity = _action_identity(event["data"])
        action_diversity.add(identity)
        if identity == previous_identity:
            repeated += 1
            run_length += 1
            if run_length == 3:
                repeated_loops += 1
        else:
            run_length = 1
        previous_identity = identity

    no_observed_change = 0
    classifiable_actions = 0
    max_ineffective_streak = 0
    ineffective_streak = 0
    prior_snapshot: Mapping[str, Any] | None = None
    interval_actions: list[Mapping[str, Any]] = []
    for event in items:
        if event["type"] == "action":
            interval_actions.append(event)
        elif event["type"] == "snapshot":
            if (
                prior_snapshot is not None
                and len(interval_actions) == 1
                and interval_actions[0]["data"].get("accepted") is True
            ):
                classifiable_actions += 1
                changed = _snapshot_identity(prior_snapshot["data"]) != _snapshot_identity(
                    event["data"]
                )
                if changed:
                    ineffective_streak = 0
                else:
                    no_observed_change += 1
                    ineffective_streak += 1
                    max_ineffective_streak = max(max_ineffective_streak, ineffective_streak)
            prior_snapshot = event
            interval_actions = []

    first_entry_time: float | None = None
    first_entry_actions: int | None = None
    first_start_time: float | None = None
    first_start_actions: int | None = None
    first_progress_time: float | None = None
    first_progress_actions: int | None = None
    best_progress = 0.0
    final_progress = 0.0
    time_to_best_progress: float | None = None
    progress_events = 0
    productive_actions: set[int] = set()
    incorrect_entries = 0
    target_exits = 0
    successful_reentries = 0
    target_surface_active = False
    launched_active = False
    exited_target = False
    previous_incorrect_entry: tuple[Any, ...] | None = None
    attempts = 0
    previous_attempt: Any = None
    attempt_summaries: list[dict[str, Any]] = []
    state_coverage: set[tuple[Any, ...]] = set()
    ui_elements: set[tuple[Any, ...]] = set()
    failures: list[dict[str, Any]] = []
    active_failure: dict[str, Any] | None = None
    lifecycle_previous: str | None = None
    semantic_counts: dict[str, int] = {}
    back_ui_actions = 0
    for suite_event in suite_events:
        semantic_type = suite_event.get("event_type") or suite_event.get("type")
        if isinstance(semantic_type, str):
            normalized_type = semantic_type.strip().lower()
            semantic_counts[normalized_type] = semantic_counts.get(normalized_type, 0) + 1
        if semantic_type != "browser_action":
            continue
        details = suite_event.get("details")
        target_descriptor = details.get("target") if isinstance(details, Mapping) else None
        if not isinstance(target_descriptor, Mapping):
            continue
        element = target_descriptor.get("element")
        if element == "game_canvas":
            ui_elements.add(("game_canvas", None, None, None))
        else:
            ui_elements.add(
                (
                    element,
                    target_descriptor.get("id"),
                    target_descriptor.get("label"),
                    target_descriptor.get("href"),
                )
            )
        target_id = str(target_descriptor.get("id") or "").lower()
        target_label = str(target_descriptor.get("label") or "").lower()
        if target_id == "backtogallery" or target_label in {
            "back to game suite",
            "back to gallery",
        }:
            back_ui_actions += 1
    latest_game_specific: dict[str, Any] = {}
    best_game_specific: dict[str, Any] = {}
    action_counter = 0
    last_action_seq: int | None = None
    deadlock_supported = False
    known_dead_state = False
    dead_end_count = 0
    known_dead_time = 0.0
    dead_time_cursor = float(starts[0]["elapsed_seconds"])

    for event in items:
        data = event["data"]
        elapsed = float(event["elapsed_seconds"])
        if known_dead_state:
            known_dead_time += max(0.0, elapsed - dead_time_cursor)
        dead_time_cursor = elapsed
        if event["type"] == "action":
            action_counter += 1
            last_action_seq = event["seq"]
            name = _action_name(data)
            continue
        if event["type"] != "snapshot":
            continue
        is_target = _is_target_surface(data, target)
        is_launched = _is_launched(data, target)
        lifecycle = str(data.get("lifecycle") or "unknown").lower()
        progress_value = _number(data.get("progress")) if is_target else None
        progress = _clamp(progress_value) if progress_value is not None else None
        state_coverage.add(
            (data.get("url"), data.get("game_id"), lifecycle, progress, data.get("attempt_id"))
        )
        if is_target:
            objective.update(data)
            state = data.get("state")
            deadlock = state.get("deadlock") if isinstance(state, Mapping) else None
            is_deadlocked = deadlock.get("is_deadlocked") if isinstance(deadlock, Mapping) else None
            if isinstance(is_deadlocked, bool):
                deadlock_supported = True
                if is_deadlocked and not known_dead_state:
                    dead_end_count += 1
                known_dead_state = is_deadlocked
            else:
                known_dead_state = False
            game_specific = data.get("game_specific")
            if isinstance(game_specific, Mapping):
                latest_game_specific = dict(game_specific)
            if first_entry_time is None:
                first_entry_time = elapsed
                first_entry_actions = action_counter
            if not target_surface_active:
                if exited_target:
                    successful_reentries += 1
            attempt_id = data.get("attempt_id")
            attempt_identity = (
                (_catalog_level_id(data.get("level_id"), target), attempt_id)
                if difficulty_scoped
                else attempt_id
            )
            new_attempt = is_launched and (
                not launched_active
                or (
                    attempt_identity is not None
                    and previous_attempt is not None
                    and attempt_identity != previous_attempt
                )
            )
            if new_attempt:
                attempts += 1
                attempt_summary = {
                    "index": attempts,
                    "attempt_id": attempt_id,
                    "started_at_seconds": elapsed,
                    "best_progress": 0.0,
                    "ended_lifecycle": lifecycle,
                }
                if difficulty_scoped:
                    attempt_summary["level_id"] = _catalog_level_id(data.get("level_id"), target)
                attempt_summaries.append(attempt_summary)
            if is_launched:
                previous_attempt = attempt_identity
            if lifecycle != "loading":
                launched_active = is_launched
            target_surface_active = True
            exited_target = False
            if is_launched and first_start_time is None:
                first_start_time = elapsed
                first_start_actions = action_counter
            if progress is not None:
                if attempt_summaries and is_launched:
                    attempt_summaries[-1]["best_progress"] = round(
                        max(attempt_summaries[-1]["best_progress"], progress), 6
                    )
                    attempt_summaries[-1]["ended_lifecycle"] = lifecycle
                if difficulty_scoped:
                    level_id = _catalog_level_id(data.get("level_id"), target)
                    if level_id is not None:
                        per_level_best[level_id] = max(per_level_best[level_id], progress)
                        if level_id in objective.completed_level_ids:
                            per_level_best[level_id] = 1.0
                    objective_progress = sum(per_level_best.values()) / len(per_level_best)
                    final_progress = objective_progress
                else:
                    objective_progress = progress
                    final_progress = progress
                if objective_progress > best_progress:
                    best_progress = progress
                    if difficulty_scoped:
                        best_progress = objective_progress
                    best_game_specific = dict(latest_game_specific)
                    time_to_best_progress = elapsed
                    progress_events += 1
                    if last_action_seq is not None:
                        productive_actions.add(last_action_seq)
                    if first_progress_time is None and progress > 0:
                        first_progress_time = elapsed
                        first_progress_actions = action_counter
            if lifecycle == "failure" and lifecycle_previous != "failure":
                active_failure = {
                    "time": elapsed,
                    "actions": action_counter,
                    "recovered": False,
                }
                failures.append(active_failure)
            elif active_failure is not None and lifecycle in {"playing", "success"}:
                active_failure["recovered"] = True
                active_failure["recovery_time"] = elapsed - active_failure["time"]
                active_failure["recovery_actions"] = action_counter - active_failure["actions"]
                active_failure = None
            lifecycle_previous = lifecycle
        else:
            known_dead_state = False
            game_id = data.get("game_id")
            incorrect_descriptor = (
                data.get("game_id"),
                data.get("difficulty"),
                data.get("level_id"),
            )
            if game_id and lifecycle != "gallery":
                if incorrect_descriptor != previous_incorrect_entry:
                    incorrect_entries += 1
                previous_incorrect_entry = incorrect_descriptor
            else:
                previous_incorrect_entry = None
            if target_surface_active:
                target_exits += 1
                exited_target = True
                target_surface_active = False
                launched_active = False
                lifecycle_previous = None

    if known_dead_state and dead_time_cursor < total_time:
        known_dead_time += total_time - dead_time_cursor

    transition_failures = len(failures)
    failure_count = max(transition_failures, semantic_counts.get("failure", 0))
    recovery_times = [failure["recovery_time"] for failure in failures if failure["recovered"]]
    recovery_actions = [failure["recovery_actions"] for failure in failures if failure["recovered"]]
    successful_recoveries = sum(failure["recovered"] for failure in failures)
    successful_recoveries = max(successful_recoveries, semantic_counts.get("recovery", 0))
    successful_recoveries = min(successful_recoveries, failure_count)
    unrecovered_failures = max(0, failure_count - successful_recoveries)

    action_target_counts: dict[str, int] = {}
    for event in actions:
        name = _action_name(event["data"])
        action_target_counts[name] = action_target_counts.get(name, 0) + 1

    def control_count(name: str, aliases: set[str]) -> int:
        action_count = sum(
            count for target_name, count in action_target_counts.items() if target_name in aliases
        )
        semantic_count = sum(semantic_counts.get(alias, 0) for alias in aliases)
        return max(action_count, semantic_count)

    starts_requested = semantic_counts.get("game_start_requested", 0)
    retries = control_count("retry", {"retry", "game_retry_requested"})
    restarts = control_count("restart", {"restart", "reset", "game_restart_requested"})
    back_navigation = max(
        control_count("back", {"back", "home", "exit", "back_navigation", "game_exit_requested"}),
        back_ui_actions,
    )
    navigation_errors = semantic_counts.get("navigation_error", incorrect_entries)
    redundant_actions = semantic_counts.get("redundant_action")
    explicit_noops = semantic_counts.get("no_op")
    accidental_exits = semantic_counts.get("accidental_exit")

    completed = objective.completed or (not difficulty_scoped and end_reason == "completion")
    if completed:
        best_progress = 1.0
        final_progress = max(final_progress, 1.0)
    timeout = end_reason == "timeout"

    # Attribute time to the last observed lifecycle until the next event.  This
    # uses only monotonic elapsed time and remains identical during offline replay.
    durations = {"navigation": 0.0, "menus": 0.0, "playing": 0.0, "failed": 0.0}
    current_bucket = "navigation"
    previous_elapsed = float(starts[0]["elapsed_seconds"])
    for event in items:
        elapsed = float(event["elapsed_seconds"])
        durations[current_bucket] += max(0.0, elapsed - previous_elapsed)
        previous_elapsed = elapsed
        if event["type"] == "snapshot":
            data = event["data"]
            lifecycle = str(data.get("lifecycle") or "").lower()
            if not _is_target(data, target) or lifecycle == "gallery":
                current_bucket = "navigation"
            elif lifecycle in {"menu", "loading"}:
                current_bucket = "menus"
            elif lifecycle == "failure":
                current_bucket = "failed"
            else:
                current_bucket = "playing"
    if previous_elapsed < total_time:
        durations[current_bucket] += total_time - previous_elapsed

    gaps = [
        float(right["elapsed_seconds"]) - float(left["elapsed_seconds"])
        for left, right in zip(actions, actions[1:], strict=False)
    ]
    idle_time = sum(max(0.0, gap - IDLE_GAP_THRESHOLD_SECONDS) for gap in gaps)
    observable_ineffective = invalid + repeated + (explicit_noops or 0) + (redundant_actions or 0)
    action_efficiency = _clamp(1.0 - observable_ineffective / len(actions)) if actions else 0.0
    progress_per_action = best_progress / len(actions) if actions else 0.0
    progress_per_minute = best_progress / (total_time / 60.0) if total_time > 0 else 0.0
    reentry_rate = successful_reentries / target_exits if target_exits else None
    restart_outcomes: list[bool] = []
    attempts_by_id = {
        str(attempt["attempt_id"]): index
        for index, attempt in enumerate(attempt_summaries)
        if attempt["attempt_id"] is not None
    }
    for suite_event in suite_events:
        if suite_event.get("event_type") != "game_restart_requested":
            continue
        details = suite_event.get("details")
        generation = details.get("generation") if isinstance(details, Mapping) else None
        attempt_index = attempts_by_id.get(f"attempt-{generation}")
        if attempt_index is None or attempt_index == 0:
            continue
        restart_outcomes.append(
            attempt_summaries[attempt_index]["best_progress"]
            > attempt_summaries[attempt_index - 1]["best_progress"]
        )
    restart_effectiveness = (
        sum(restart_outcomes) / len(restart_outcomes) if restart_outcomes else None
    )
    recovery_controls_before_success = retries + restarts if completed else None
    process_observations = [
        float(first_entry_time is not None),
        float(first_start_time is not None),
    ]
    if failure_count:
        process_observations.append(successful_recoveries / failure_count)
    process_observations.append(float(completed))
    process_control_success_rate = sum(process_observations) / len(process_observations)

    result = {
        "schema_version": SCHEMA_VERSION,
        "target": target,
        "termination_reason": end_reason,
        "completed": completed,
        "timeout": timeout,
        "terminal_environment_error": end_reason == "environment_error",
        "total_wall_clock_seconds": round(total_time, 6),
        "configured_timeout_seconds": timeout_seconds,
        "total_actions": len(actions),
        "valid_actions": accepted,
        "invalid_actions": invalid,
        "classifiable_actions": classifiable_actions,
        "no_op_actions": explicit_noops,
        "no_observed_instrumented_change_actions": no_observed_change,
        "clicks_outside_actionable_regions": outside,
        "redundant_actions": redundant_actions,
        "repeated_identical_actions": repeated,
        "repeated_exploration_loops": repeated_loops,
        "max_ineffective_interaction_streak": max_ineffective_streak,
        "action_efficiency": round(action_efficiency, 6),
        "productive_actions": len(productive_actions),
        "unproductive_exploration_actions": (
            invalid + repeated + (explicit_noops or 0) + (redundant_actions or 0)
        ),
        "progress_per_action": round(progress_per_action, 6),
        "progress_per_minute": round(progress_per_minute, 6),
        "unique_action_signatures": len(action_diversity),
        "unique_ui_elements_explored": len(ui_elements),
        "state_coverage": len(state_coverage),
        "novel_state_discovery_rate": round(len(state_coverage) / len(snapshots), 6)
        if snapshots
        else 0.0,
        "time_to_first_correct_game_entry_seconds": _round_optional(first_entry_time),
        "actions_to_first_correct_game_entry": first_entry_actions,
        "incorrect_entry_count": incorrect_entries,
        "navigation_error_count": navigation_errors,
        "successful_game_launch": first_entry_time is not None,
        "time_to_game_start_seconds": _round_optional(first_start_time),
        "actions_to_game_start": first_start_actions,
        "maximum_progress_reached": round(best_progress, 6),
        "normalized_progress": round(best_progress, 6),
        "final_progress": round(final_progress, 6),
        "meaningful_progress_events": progress_events,
        "time_to_first_meaningful_progress_seconds": _round_optional(first_progress_time),
        "actions_to_first_meaningful_progress": first_progress_actions,
        "time_to_best_progress_seconds": _round_optional(time_to_best_progress),
        "attempt_count": attempts,
        "attempts": attempt_summaries,
        "failure_count": failure_count,
        "dead_end_count": dead_end_count if deadlock_supported else None,
        "time_in_known_dead_states_seconds": (
            round(known_dead_time, 6) if deadlock_supported else None
        ),
        "successful_recovery_count": successful_recoveries,
        "unrecovered_failure_count": unrecovered_failures,
        "recovery_opportunity_count": failure_count,
        "recovery_success_rate": round(successful_recoveries / failure_count, 6)
        if failure_count
        else None,
        "mean_time_to_recovery_after_failure_seconds": _round_optional(
            sum(recovery_times) / len(recovery_times) if recovery_times else None
        ),
        "mean_actions_to_recovery_after_failure": _round_optional(
            sum(recovery_actions) / len(recovery_actions) if recovery_actions else None
        ),
        "retry_count": retries,
        "game_start_count": starts_requested,
        "restart_count": restarts,
        "restart_effectiveness": _round_optional(restart_effectiveness),
        "recovery_controls_before_success": recovery_controls_before_success,
        "back_navigation_count": back_navigation,
        "target_exit_count": target_exits,
        "accidental_exit_count": accidental_exits,
        "successful_reentry_after_exit_count": successful_reentries,
        "reentry_success_rate": _round_optional(reentry_rate),
        "autonomous_entry": first_entry_time is not None,
        "autonomous_start": first_start_time is not None,
        "autonomous_lifecycle_completion": completed,
        "process_control_success_rate": round(process_control_success_rate, 6),
        "time_in_navigation_seconds": round(durations["navigation"], 6),
        "time_in_menus_seconds": round(durations["menus"], 6),
        "time_actively_playing_seconds": round(durations["playing"], 6),
        "time_in_failed_states_seconds": round(durations["failed"], 6),
        "time_spent_recovering_seconds": round(sum(recovery_times), 6),
        "idle_time_seconds": round(idle_time, 6),
        "idle_gap_threshold_seconds": IDLE_GAP_THRESHOLD_SECONDS,
        "completion_time_seconds": round(total_time, 6) if completed else None,
        "game_specific": {
            "latest": latest_game_specific,
            "at_best_progress": best_game_specific,
        },
    }
    if difficulty_scoped:
        result.update(
            {
                "objective_level_count": len(objective.level_ids),
                "completed_level_count": len(objective.completed_level_ids),
                "completed_level_ids": [
                    level_id
                    for level_id in objective.level_ids
                    if level_id in objective.completed_level_ids
                ],
                "level_progress": {
                    str(level_id): round(per_level_best[level_id], 6)
                    for level_id in objective.level_ids
                },
            }
        )
    return result


def derive_autonomous_annotations(
    events: Iterable[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Attach replay-friendly semantic tags without altering raw events."""

    items = _validated_events(events)
    starts = [event for event in items if event["type"] == "episode_start"]
    if len(starts) != 1:
        raise ValueError("trajectory must contain exactly one episode_start")
    target = dict(starts[0]["data"].get("target") or {})
    if not target.get("game_id"):
        raise ValueError("episode_start data.target.game_id is required")
    objective = ObjectiveProgress(target)
    difficulty_scoped = _is_game_difficulty_target(target)
    per_level_best = {level_id: 0.0 for level_id in objective.level_ids}

    annotations: list[dict[str, Any]] = []
    best_progress = 0.0
    prior_lifecycle: str | None = None
    failure_open = False
    dead_state = False
    completion_tagged = False
    for event in items:
        tags: list[str] = []
        data = event["data"]
        if event["type"] == "snapshot":
            is_target = _is_target_surface(data, target)
            lifecycle = str(data.get("lifecycle") or "unknown").lower()
            if is_target:
                progress_value = _number(data.get("progress"))
                progress = _clamp(progress_value) if progress_value is not None else None
                previously_completed = set(objective.completed_level_ids)
                objective.update(data)
                if difficulty_scoped and progress is not None:
                    level_id = _catalog_level_id(data.get("level_id"), target)
                    if level_id is not None:
                        per_level_best[level_id] = max(per_level_best[level_id], progress)
                        if level_id in objective.completed_level_ids:
                            per_level_best[level_id] = 1.0
                    observed_progress = sum(per_level_best.values()) / len(per_level_best)
                else:
                    observed_progress = progress
                if observed_progress is not None and observed_progress > best_progress:
                    tags.append("meaningful_progress")
                    best_progress = observed_progress
                if lifecycle == "failure" and prior_lifecycle != "failure":
                    tags.append("failure")
                    failure_open = True
                elif failure_open and lifecycle in {"playing", "success"}:
                    tags.append("recovery")
                    failure_open = False
                state = data.get("state")
                deadlock = state.get("deadlock") if isinstance(state, Mapping) else None
                is_deadlocked = (
                    deadlock.get("is_deadlocked") if isinstance(deadlock, Mapping) else None
                )
                if is_deadlocked is True and not dead_state:
                    tags.append("dead_end")
                elif is_deadlocked is False and dead_state:
                    tags.append("dead_end_exit")
                dead_state = is_deadlocked is True
                if lifecycle == "success":
                    if difficulty_scoped:
                        newly_completed = objective.completed_level_ids - previously_completed
                        if newly_completed:
                            tags.append("level_complete")
                        if objective.completed and not completion_tagged:
                            tags.append("objective_completion")
                            completion_tagged = True
                    else:
                        tags.append("completion")
                        completion_tagged = True
                prior_lifecycle = lifecycle
            else:
                prior_lifecycle = None
                dead_state = False
        elif (
            event["type"] == "episode_end"
            and data.get("reason") == "completion"
            and not completion_tagged
            and (not difficulty_scoped or objective.completed)
        ):
            tags.append("objective_completion" if difficulty_scoped else "completion")
            completion_tagged = True
        if tags:
            annotations.append(
                {
                    "seq": event["seq"],
                    "elapsed_seconds": round(float(event["elapsed_seconds"]), 6),
                    "tags": tags,
                }
            )
    return annotations


def score_autonomous_metrics(metrics: Mapping[str, Any]) -> dict[str, Any]:
    """Score autonomous metrics while preserving all raw measurements.

    A trajectory without an observed failure has no recovery opportunity.  In
    that case recovery is reported as null and its five points are redistributed
    proportionally across the four applicable components.
    """

    completed = metrics.get("completed") is True
    progress = _clamp(_number(metrics.get("maximum_progress_reached")) or 0.0)
    entry = metrics.get("autonomous_entry") is True
    started = metrics.get("autonomous_start") is True
    lifecycle = metrics.get("autonomous_lifecycle_completion") is True
    process_ratio = 0.35 * float(entry) + 0.35 * float(started) + 0.30 * float(lifecycle)

    action_efficiency = _clamp(_number(metrics.get("action_efficiency")) or 0.0)
    total_time = _number(metrics.get("total_wall_clock_seconds")) or 0.0
    timeout = _number(metrics.get("configured_timeout_seconds"))
    temporal_efficiency = (
        _clamp(1.0 - total_time / timeout) if completed and timeout and timeout > 0 else progress
    )
    efficiency_ratio = progress * (0.7 * action_efficiency + 0.3 * temporal_efficiency)

    opportunities = int(_number(metrics.get("recovery_opportunity_count")) or 0)
    recovery_ratio = (
        _clamp(_number(metrics.get("recovery_success_rate")) or 0.0) if opportunities > 0 else None
    )
    weights = dict(_BASE_WEIGHTS)
    if recovery_ratio is None:
        redistributed_total = 100.0 - weights["recovery"]
        recovery_weight = weights.pop("recovery")
        for name in weights:
            weights[name] += recovery_weight * weights[name] / redistributed_total
        weights["recovery"] = 0.0

    ratios: dict[str, float | None] = {
        "outcome": float(completed),
        "progress": progress,
        "process_control": process_ratio,
        "recovery": recovery_ratio,
        "efficiency": efficiency_ratio,
    }
    components = {
        name: round(weights[name] * ratio, 6) if ratio is not None else None
        for name, ratio in ratios.items()
    }
    overall = sum(value for value in components.values() if value is not None)
    target = metrics.get("target")
    scoring_version = (
        GAME_DIFFICULTY_SCORING_VERSION
        if isinstance(target, Mapping) and _is_game_difficulty_target(target)
        else SCORING_VERSION
    )
    return {
        "version": scoring_version,
        "overall_score": round(_clamp(overall, 0.0, 100.0), 6),
        "base_weights": dict(_BASE_WEIGHTS),
        "effective_weights": {name: round(value, 6) for name, value in weights.items()},
        "component_ratios": {name: _round_optional(value) for name, value in ratios.items()},
        "component_scores": components,
        "recovery_applicable": recovery_ratio is not None,
    }


def evaluate_autonomous_trajectory(events: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Recompute raw metrics and the versioned composite score from events."""

    event_list = list(events)
    metrics = derive_autonomous_metrics(event_list)
    return {
        "schema_version": SCHEMA_VERSION,
        "metrics": metrics,
        "annotations": derive_autonomous_annotations(event_list),
        "scoring": score_autonomous_metrics(metrics),
    }
