"""Machine-readable episode artifacts, summaries, and offline leaderboard output."""

from __future__ import annotations

import csv
import hashlib
import json
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from statistics import fmean, pstdev
from typing import Any

from mobile_world.benchmarks.models import EpisodeResult, is_harness_termination


def _agent_identity(agent: Mapping[str, Any]) -> str:
    """Never merge results across model, provider, harness, or benchmark builds."""

    name = str(agent.get("name") or agent.get("agent_name") or agent.get("agent_type") or "unknown")
    model = str(agent.get("model_name") or agent.get("model") or "unknown")
    provider = str(agent.get("model_provider") or "unknown")
    framework = agent.get("agent_framework")
    if not framework:
        return f"legacy:{provider}:{model}:{name}"
    version = str(agent.get("agent_framework_version") or "unversioned")
    config_hash = str(agent.get("agent_config_hash") or "unhashed")[:12]
    track = str(agent.get("leaderboard_track") or "unspecified")
    benchmark_version = str(agent.get("benchmark_version") or "unknown-benchmark")
    benchmark_config = str(agent.get("benchmark_config_hash") or "unhashed")[:12]
    environment_version = str(agent.get("environment_version") or "unknown-environment")
    experiment_hash = str(agent.get("experiment_config_hash") or "unhashed")[:12]
    prompt_setting = str(agent.get("prompt_setting") or "unspecified")
    context_setting = str(agent.get("context_setting") or "unspecified")
    eval_mode = str(agent.get("eval_mode") or "unspecified")
    return (
        f"{track}:{provider}:{model}:{framework}@{version}:{config_hash}:{name}:"
        f"benchmark={benchmark_version}:{benchmark_config}:env={environment_version}:"
        f"experiment={experiment_hash}:{prompt_setting}:{context_setting}:{eval_mode}:"
        "aggregation=game-difficulty-macro"
    )


def _agent_name(result: EpisodeResult) -> str:
    return _agent_identity(result.agent_information)


def _agent_columns_from_mapping(agent: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "Agent": str(
            agent.get("name") or agent.get("agent_name") or agent.get("agent_type") or "unknown"
        ),
        "Model": str(agent.get("model_name") or agent.get("model") or "unknown"),
        "Model Provider": str(agent.get("model_provider") or "unknown"),
        "Agent Harness": str(agent.get("agent_framework") or "legacy_unspecified"),
        "Harness Version": str(agent.get("agent_framework_version") or "unversioned"),
        "Harness Config Hash": str(agent.get("agent_config_hash") or "unhashed"),
        "Track": str(agent.get("leaderboard_track") or "unspecified"),
        "Prompt Setting": str(agent.get("prompt_setting") or "unspecified"),
        "Context Setting": str(agent.get("context_setting") or "unspecified"),
        "Eval Mode": str(agent.get("eval_mode") or "unspecified"),
        "Experiment Config Hash": str(agent.get("experiment_config_hash") or "unhashed"),
        "Benchmark Version": str(agent.get("benchmark_version") or "unknown"),
        "Benchmark Config Hash": str(agent.get("benchmark_config_hash") or "unhashed"),
        "Environment Version": str(agent.get("environment_version") or "unknown"),
        "Evaluation Matrix Hash": str(agent.get("evaluation_matrix_hash") or "unknown-matrix"),
        "Planned Episodes": agent.get("planned_episodes"),
    }


def _agent_columns(result: EpisodeResult) -> dict[str, Any]:
    return _agent_columns_from_mapping(result.agent_information)


def _usage_value(result: EpisodeResult, name: str) -> float | None:
    usage = result.runtime.get("model_usage", {})
    if not isinstance(usage, Mapping):
        return None
    value = usage.get(name)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def _usage_average(results: Sequence[EpisodeResult], name: str) -> float | None:
    values = [value for result in results if (value := _usage_value(result, name)) is not None]
    return fmean(values) if values else None


def _usage_sum(results: Sequence[EpisodeResult], name: str) -> float | None:
    values = [value for result in results if (value := _usage_value(result, name)) is not None]
    return sum(values) if values else None


def _runtime_average(
    results: Sequence[EpisodeResult], name: str, *, fallback_to_steps: bool = False
) -> float | None:
    values: list[float] = []
    for result in results:
        value = result.runtime.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            values.append(float(value))
        elif fallback_to_steps:
            values.append(float(result.step_count))
    return fmean(values) if values else None


def _numeric_metric_averages(results: Sequence[EpisodeResult]) -> dict[str, float]:
    def numeric_items(value: Any, prefix: str = ""):
        if isinstance(value, Mapping):
            for name, item in value.items():
                path = f"{prefix}.{name}" if prefix else str(name)
                yield from numeric_items(item, path)
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            yield prefix, float(value)

    values: dict[str, list[float]] = defaultdict(list)
    for result in results:
        for name, value in numeric_items(result.raw_metrics):
            values[name].append(value)
    return {name: fmean(items) for name, items in sorted(values.items()) if items}


_SCORE_COMPONENTS = (
    "success_score",
    "progress_score",
    "efficiency_score",
    "action_quality_score",
    "time_score",
    "penalty_score",
)
_TASK_ID_PATTERN = re.compile(
    r"^(?P<game>[^.]+)\.(?P<difficulty>[^.]+)\.level_(?P<level>.+)\.seed_(?P<seed>\d+)$"
)


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            dumped = model_dump(mode="json")
        except TypeError:
            dumped = model_dump()
        return dict(dumped) if isinstance(dumped, Mapping) else {}
    return {}


def _number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def _episode_overall_score(result: EpisodeResult) -> float:
    """Return the versioned game scorer result, with a legacy 0-1 fallback."""

    direct = _number(getattr(result, "overall_score", None))
    if direct is None:
        scoring = _mapping(getattr(result, "scoring", None))
        direct = _number(scoring.get("overall_score"))
    if direct is None:
        direct = _number(result.raw_metrics.get("overall_score"))
    if direct is None:
        direct = float(result.normalized_score) * 100.0
    return _clamp(direct, 0.0, 100.0)


def _episode_score_breakdown(result: EpisodeResult) -> dict[str, float]:
    raw = _mapping(getattr(result, "breakdown", None))
    if not raw:
        raw = _mapping(getattr(result, "score_breakdown", None))
    if not raw:
        scoring = _mapping(getattr(result, "scoring", None))
        raw = _mapping(scoring.get("score_breakdown") or scoring.get("components"))
    if not raw:
        raw = _mapping(result.raw_metrics.get("score_breakdown"))
    overall_score = _episode_overall_score(result)
    breakdown = {name: (_number(raw.get(name)) or 0.0) for name in _SCORE_COMPONENTS}
    if not raw:
        # Legacy artifacts did not expose components. Preserve their exact score
        # while assigning it to the only semantically defensible component.
        component = "success_score" if result.task_success else "progress_score"
        breakdown[component] = overall_score
    breakdown["overall_score"] = overall_score
    return breakdown


def _episode_payload(result: EpisodeResult) -> dict[str, Any]:
    payload = result.model_dump(mode="json")
    # This compatibility bridge also works while an older EpisodeResult model is
    # reading an artifact produced by a newer scorer.
    payload["overall_score"] = _episode_overall_score(result)
    payload["breakdown"] = _episode_score_breakdown(result)
    scoring = _mapping(getattr(result, "scoring", None))
    if scoring:
        payload["scoring"] = scoring
    agent = result.agent_information
    payload["model"] = agent.get("model_name") or agent.get("model")
    payload["game"] = result.task.game_id
    payload["prompt_setting"] = agent.get("prompt_setting")
    if "context_setting" in agent:
        payload["context_setting"] = agent.get("context_setting")
    payload["eval_mode"] = agent.get("eval_mode")
    payload["history_n_images"] = agent.get("history_n_images")
    payload["level_id"] = result.task.level_id
    payload["success"] = result.task_success
    payload["final_success"] = result.task_success
    # Public progress_score is the 0-1 task-completion potential P(s).
    # breakdown.progress_score remains the weighted 0-100 composite component.
    progress_ratio = _number((result.normalized_metrics or {}).get("progress"))
    if progress_ratio is None:
        process = _mapping(result.raw_metrics.get("process_metrics"))
        progress_ratio = _number(process.get("progress"))
    if progress_ratio is None and result.task_success:
        progress_ratio = 1.0
    payload["progress_score"] = float(
        _clamp(progress_ratio if progress_ratio is not None else 0.0, 0.0, 1.0)
    )
    payload["level_score"] = float(payload["overall_score"])
    payload["steps"] = result.step_count
    if "process_metrics" in result.raw_metrics:
        payload["process_metrics"] = result.raw_metrics["process_metrics"]
    return payload


def _parse_task_id(task_id: Any) -> dict[str, Any]:
    match = _TASK_ID_PATTERN.match(str(task_id or ""))
    if match is None:
        return {}
    level: int | str = match.group("level")
    if str(level).isdigit():
        level = int(level)
    return {
        "task_id": str(task_id),
        "game_id": match.group("game"),
        "difficulty": match.group("difficulty"),
        "level_id": level,
        "seed": int(match.group("seed")),
    }


def _planned_descriptor(value: Any, *, default_run_index: int = 1) -> dict[str, Any] | None:
    data = _mapping(value)
    if not data and isinstance(value, str):
        data = {"task_id": value}
    task = _mapping(data.get("task"))
    merged = {**_parse_task_id(data.get("task_id") or task.get("task_id")), **task, **data}
    game_id = merged.get("game_id")
    difficulty = merged.get("difficulty")
    if not game_id or not difficulty:
        return None
    runtime = _mapping(merged.get("runtime"))
    run_index = merged.get("run_index", runtime.get("run_index", default_run_index))
    try:
        run_index = int(run_index)
    except (TypeError, ValueError):
        run_index = default_run_index
    seed = merged.get("seed", task.get("seed", 0))
    try:
        seed = int(seed)
    except (TypeError, ValueError):
        seed = 0
    descriptor = {
        "task_id": str(merged.get("task_id") or task.get("task_id") or ""),
        "game_id": str(game_id),
        "difficulty": str(difficulty),
        "level_id": merged.get("level_id", task.get("level_id")),
        "seed": seed,
        "run_index": run_index,
    }
    return descriptor


def _result_descriptor(result: EpisodeResult, *, default_run_index: int = 1) -> dict[str, Any]:
    return _planned_descriptor(
        {
            "task": result.task,
            "task_id": result.task.task_id,
            "seed": result.seed,
            "runtime": result.runtime,
        },
        default_run_index=default_run_index,
    ) or {
        "task_id": result.task.task_id,
        "game_id": result.task.game_id,
        "difficulty": result.task.difficulty,
        "level_id": result.task.level_id,
        "seed": result.seed,
        "run_index": default_run_index,
    }


def _looks_like_plan_descriptor(value: Mapping[str, Any]) -> bool:
    return any(name in value for name in ("task", "task_id", "game_id", "difficulty"))


def _normalise_planned_episodes(
    planned_episodes: Any,
    results: Sequence[EpisodeResult],
    agent_metadata: Mapping[str, Any] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Normalize a common plan or an identity->plan mapping without fake episodes."""

    result_agents = {_agent_name(result) for result in results}
    fallback_agent = _agent_identity(agent_metadata) if agent_metadata else None
    target_agents = result_agents or ({fallback_agent} if fallback_agent else set())
    if planned_episodes is None:
        plans: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for index, result in enumerate(results, start=1):
            plans[_agent_name(result)].append(_result_descriptor(result, default_run_index=index))
        return dict(plans)

    if isinstance(planned_episodes, Mapping) and not _looks_like_plan_descriptor(planned_episodes):
        plans = {}
        for identity, items in planned_episodes.items():
            sequence = (
                items if isinstance(items, Sequence) and not isinstance(items, str) else [items]
            )
            descriptors = [
                descriptor
                for index, item in enumerate(sequence, start=1)
                if (descriptor := _planned_descriptor(item, default_run_index=index)) is not None
            ]
            plans[str(identity)] = descriptors
        return plans

    sequence = (
        planned_episodes
        if isinstance(planned_episodes, Sequence) and not isinstance(planned_episodes, str)
        else [planned_episodes]
    )
    descriptors = [
        descriptor
        for index, item in enumerate(sequence, start=1)
        if (descriptor := _planned_descriptor(item, default_run_index=index)) is not None
    ]
    return {identity: list(descriptors) for identity in target_agents}


def _distribution(values: Sequence[float]) -> dict[str, float | int]:
    return {
        "count": len(values),
        "mean": fmean(values) if values else 0.0,
        "std": pstdev(values) if len(values) > 1 else 0.0,
    }


def _flat_numeric(value: Any, prefix: str = "") -> dict[str, float]:
    flattened: dict[str, float] = {}
    if isinstance(value, Mapping):
        for name, item in value.items():
            path = f"{prefix}.{name}" if prefix else str(name)
            flattened.update(_flat_numeric(item, path))
    elif (numeric := _number(value)) is not None:
        flattened[prefix] = numeric
    return flattened


def _metric_value(result: EpisodeResult, names: Sequence[str]) -> float | None:
    breakdown = _mapping(getattr(result, "breakdown", None))
    flattened = {
        **_flat_numeric(result.raw_metrics),
        **_flat_numeric(result.normalized_metrics),
        **_flat_numeric(_mapping(breakdown.get("normalized_metrics"))),
    }
    for requested in names:
        for name, value in flattened.items():
            if name == requested or name.endswith(f".{requested}"):
                return value
    return None


def _execution_record(item: EpisodeResult | Mapping[str, Any]) -> dict[str, Any]:
    """Normalize one executed episode for comparable-metric grouping."""

    if isinstance(item, EpisodeResult):
        run_index = item.runtime.get("run_index", 1)
        try:
            run_index = int(run_index)
        except (TypeError, ValueError):
            run_index = 1
        return {
            "run_index": run_index,
            "task_id": item.task.task_id,
            "game_id": item.task.game_id,
            "difficulty": item.task.difficulty,
            "level_id": item.task.level_id,
            "seed": item.seed,
            "termination_reason": item.termination_reason,
            "success": bool(item.task_success),
            "level_score": float(item.overall_score),
        }
    try:
        run_index = int(item.get("run_index") or 1)
    except (TypeError, ValueError):
        run_index = 1
    try:
        seed = int(item.get("seed") or 0)
    except (TypeError, ValueError):
        seed = 0
    return {
        "run_index": run_index,
        "task_id": str(item.get("task_id") or ""),
        "game_id": str(item.get("game_id") or ""),
        "difficulty": str(item.get("difficulty") or ""),
        "level_id": item.get("level_id"),
        "seed": seed,
        "termination_reason": item.get("termination_reason") or item.get("status"),
        "success": bool(
            item.get("success") or item.get("final_success") or item.get("status") == "success"
        ),
        "level_score": float(item.get("level_score") or item.get("overall_score") or 0.0),
    }


def _chain_key(record: Mapping[str, Any]) -> tuple[int, str, str, int]:
    return (
        int(record.get("run_index") or 1),
        str(record.get("game_id") or ""),
        str(record.get("difficulty") or ""),
        int(record.get("seed") or 0),
    )


def comparable_metrics(
    executed: Sequence[EpisodeResult | Mapping[str, Any]],
    planned: Sequence[Mapping[str, Any]] | None = None,
    *,
    score_denominator: int | None = None,
) -> dict[str, Any]:
    """Exclude provider/environment failures from comparison denominators.

    Planned levels that were never started because a chain stopped on
    ``agent_error`` / ``environment_error`` are also excluded.  Levels skipped
    after a real play failure still count as zeros.
    """

    records = [_execution_record(item) for item in executed]
    harness_error_count = sum(
        1 for item in records if is_harness_termination(str(item.get("termination_reason") or ""))
    )
    if planned:
        chains: dict[tuple[Any, ...], list[dict[str, Any]]] = defaultdict(list)
        for item in planned:
            chains[_chain_key(item)].append(dict(item))
        executed_by_chain: dict[tuple[Any, ...], list[dict[str, Any]]] = defaultdict(list)
        for item in records:
            executed_by_chain[_chain_key(item)].append(item)
        comparable_slots = 0
        comparable_successes = 0
        comparable_score_total = 0.0
        contaminated = 0
        for key, plan_items in chains.items():
            chain_exec = executed_by_chain.get(key, [])
            if not chain_exec:
                contaminated += len(plan_items)
                continue
            last_reason = str(chain_exec[-1].get("termination_reason") or "")
            exec_by_task = {
                (int(item["run_index"]), str(item["task_id"])): item for item in chain_exec
            }
            stopped_by_harness = is_harness_termination(last_reason)
            for plan in plan_items:
                record = exec_by_task.get(
                    (int(plan.get("run_index") or 1), str(plan.get("task_id") or ""))
                )
                if record is None:
                    if stopped_by_harness:
                        contaminated += 1
                    else:
                        comparable_slots += 1
                    continue
                if is_harness_termination(str(record.get("termination_reason") or "")):
                    contaminated += 1
                    continue
                comparable_slots += 1
                if record.get("success"):
                    comparable_successes += 1
                comparable_score_total += float(record.get("level_score") or 0.0)
        return {
            "harness_error_count": harness_error_count,
            "harness_contaminated_count": contaminated,
            "comparable_denominator": comparable_slots,
            "comparable_successes": comparable_successes,
            "comparable_success_rate": (
                comparable_successes / comparable_slots if comparable_slots else 0.0
            ),
            "comparable_overall_score": (
                comparable_score_total / comparable_slots if comparable_slots else 0.0
            ),
            "comparison_eligible": comparable_slots > 0,
            "comparison_complete": contaminated == 0,
        }

    comparable = [
        item
        for item in records
        if not is_harness_termination(str(item.get("termination_reason") or ""))
    ]
    denominator = (
        len(records) if score_denominator is None else max(len(records), score_denominator)
    )
    not_run = max(0, denominator - len(records))
    all_harness = bool(records) and harness_error_count == len(records)
    comparable_slots = len(comparable) if all_harness else len(comparable) + not_run
    comparable_successes = sum(1 for item in comparable if item.get("success"))
    comparable_score_total = sum(float(item.get("level_score") or 0.0) for item in comparable)
    return {
        "harness_error_count": harness_error_count,
        "harness_contaminated_count": harness_error_count + (not_run if all_harness else 0),
        "comparable_denominator": comparable_slots,
        "comparable_successes": comparable_successes,
        "comparable_success_rate": (
            comparable_successes / comparable_slots if comparable_slots else 0.0
        ),
        "comparable_overall_score": (
            comparable_score_total / comparable_slots if comparable_slots else 0.0
        ),
        "comparison_eligible": comparable_slots > 0,
        "comparison_complete": harness_error_count == 0,
    }


def _statistics(
    results: Sequence[EpisodeResult],
    *,
    score_denominator: int | None = None,
    planned: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    denominator = (
        len(results) if score_denominator is None else max(len(results), score_denominator)
    )
    comparison = comparable_metrics(results, planned, score_denominator=score_denominator)
    if not results:
        return {
            "episode_count": 0,
            "score_denominator": denominator,
            "not_run_count": denominator,
            "success_rate": 0.0,
            "average_normalized_score": 0.0,
            "average_game_score": 0.0,
            "average_steps": 0.0,
            "average_agent_decisions": 0.0,
            "average_environment_steps": 0.0,
            "average_runtime_seconds": 0.0,
            "average_invalid_actions": 0.0,
            "average_model_calls": None,
            "average_input_tokens": None,
            "average_output_tokens": None,
            "average_total_tokens": None,
            "average_model_latency_seconds": None,
            "total_estimated_cost": None,
            "average_parse_failures": None,
            "average_repeated_actions": None,
            "average_noop_actions": None,
            "raw_metric_averages": {},
            **comparison,
        }
    return {
        "episode_count": len(results),
        "score_denominator": denominator,
        "not_run_count": max(0, denominator - len(results)),
        "success_rate": (
            sum(float(item.task_success) for item in results) / denominator if denominator else 0.0
        ),
        "average_normalized_score": (
            sum(item.normalized_score for item in results) / denominator if denominator else 0.0
        ),
        "average_game_score": fmean(item.game_score for item in results),
        "average_steps": fmean(item.step_count for item in results),
        "average_agent_decisions": _runtime_average(
            results, "agent_decisions", fallback_to_steps=True
        ),
        "average_environment_steps": _runtime_average(
            results, "environment_steps", fallback_to_steps=True
        ),
        "average_runtime_seconds": fmean(item.elapsed_time_seconds for item in results),
        "average_invalid_actions": fmean(item.invalid_action_count for item in results),
        "average_model_calls": _usage_average(results, "model_calls"),
        "average_input_tokens": _usage_average(results, "input_tokens"),
        "average_output_tokens": _usage_average(results, "output_tokens"),
        "average_total_tokens": _usage_average(results, "total_tokens"),
        "average_model_latency_seconds": _usage_average(results, "model_latency_seconds"),
        "total_estimated_cost": _usage_sum(results, "estimated_cost"),
        "average_parse_failures": _usage_average(results, "parse_failures"),
        "average_repeated_actions": _usage_average(results, "repeated_actions"),
        "average_noop_actions": _usage_average(results, "noop_actions"),
        "raw_metric_averages": _numeric_metric_averages(results),
        **comparison,
    }


def _grouped(
    results: Sequence[EpisodeResult],
    key,
    *,
    score_denominators: Mapping[str, int] | None = None,
    include_keys: Iterable[str] = (),
) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[EpisodeResult]] = defaultdict(list)
    for result in results:
        groups[str(key(result))].append(result)
    for name in include_keys:
        groups.setdefault(str(name), [])
    return {
        name: _statistics(
            items,
            score_denominator=(score_denominators or {}).get(name),
        )
        for name, items in sorted(groups.items())
    }


def aggregate_results(
    results: Iterable[EpisodeResult | Mapping[str, Any]],
    *,
    expected_episode_count: int | None = None,
    benchmark_summary: Mapping[str, Any] | None = None,
    score_denominators: Mapping[str, int] | None = None,
    planned_episodes: Any = None,
    agent_metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Aggregate common and game-specific metrics across benchmark dimensions."""

    parsed = [
        item if isinstance(item, EpisodeResult) else EpisodeResult.model_validate(item)
        for item in results
    ]
    plans_by_agent = _normalise_planned_episodes(planned_episodes, parsed, agent_metadata)
    cell_denominators: Counter[str] = Counter()
    for plan in plans_by_agent.values():
        for item in plan:
            cell_denominators[f"{item['game_id']}.{item['difficulty']}"] += 1
    if expected_episode_count is not None and len(cell_denominators) == 1:
        cell = next(iter(cell_denominators))
        cell_denominators[cell] = max(cell_denominators[cell], expected_episode_count)
    all_plans = [item for plan in plans_by_agent.values() for item in plan]
    summary = {
        "generated_at": datetime.now(UTC).isoformat(),
        "overall": _statistics(
            parsed,
            score_denominator=expected_episode_count,
            planned=all_plans or None,
        ),
        "by_agent": _grouped(parsed, _agent_name, score_denominators=score_denominators),
        "by_game": _grouped(parsed, lambda item: item.task.game_id),
        "by_difficulty": _grouped(parsed, lambda item: item.task.difficulty),
        "by_game_difficulty": _grouped(
            parsed,
            lambda item: f"{item.task.game_id}.{item.task.difficulty}",
            score_denominators=cell_denominators,
            include_keys=cell_denominators,
        ),
        "by_level": _grouped(
            parsed,
            lambda item: item.task.task_id.rsplit(".seed_", maxsplit=1)[0],
        ),
        "by_seed": _grouped(parsed, lambda item: item.seed),
    }
    if benchmark_summary is not None:
        summary["benchmark"] = dict(benchmark_summary)
    return summary


def _score_breakdown_average(
    results: Sequence[EpisodeResult], denominator: int
) -> dict[str, float]:
    names = (*_SCORE_COMPONENTS, "overall_score")
    if denominator <= 0:
        return {name: 0.0 for name in names}
    breakdowns = [_episode_score_breakdown(result) for result in results]
    return {name: sum(item.get(name, 0.0) for item in breakdowns) / denominator for name in names}


def _difficulty_metrics(results: Sequence[EpisodeResult], denominator: int) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "mean_elapsed_time": (
            fmean(result.elapsed_time_seconds for result in results) if results else 0.0
        ),
        "raw_metric_averages": _numeric_metric_averages(results),
    }
    normalized_averages: dict[str, list[float]] = defaultdict(list)
    for result in results:
        for name, value in _flat_numeric(result.normalized_metrics).items():
            normalized_averages[name].append(value)
    metrics["normalized_metric_averages"] = {
        name: sum(values) / denominator
        for name, values in sorted(normalized_averages.items())
        if denominator > 0
    }
    canonical = {
        "mean_progress": ("progress", "progress_ratio", "completion_ratio"),
        "mean_progress_score": ("progress", "progress_ratio", "completion_ratio"),
        "mean_step_efficiency": (
            "step_efficiency",
            "move_efficiency",
            "efficiency",
        ),
        "valid_action_rate": (
            "valid_action_rate",
            "valid_action_ratio",
        ),
        "mean_action_quality": ("action_quality",),
        "mean_time_efficiency": ("time_efficiency",),
        "invalid_action_rate": ("invalid_action_rate", "invalid_action_ratio"),
        "repeated_action_rate": (
            "repeated_action_rate",
            "repeated_action_ratio",
        ),
    }
    for output_name, source_names in canonical.items():
        values: list[float] = []
        for result in results:
            metric_value = _metric_value(result, source_names)
            if metric_value is not None:
                values.append(metric_value)
        if values and denominator > 0:
            # Missing/unexecuted slots contribute zero for normalized process
            # quality, preventing early termination from shrinking the divisor.
            metrics[output_name] = sum(values) / denominator
    if "invalid_action_rate" not in metrics and results:
        decisions = sum(max(0, result.step_count) for result in results)
        if decisions:
            metrics["invalid_action_rate"] = (
                sum(result.invalid_action_count for result in results) / decisions
            )
    return metrics


def _termination_reasons(results: Sequence[EpisodeResult], denominator: int) -> dict[str, int]:
    reasons: Counter[str] = Counter()
    for result in results:
        if result.task_success:
            reasons["success"] += 1
        else:
            reasons[str(result.termination_reason or result.episode_status)] += 1
    not_run = max(0, denominator - len(results))
    if not_run:
        reasons["not_run"] += not_run
    return dict(sorted(reasons.items()))


def _episode_run_index(result: EpisodeResult, default: int = 1) -> int:
    value = result.runtime.get("run_index", default)
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _dimension_statistics(
    results: Sequence[EpisodeResult],
    plans: Sequence[Mapping[str, Any]],
    *,
    dimension: str,
) -> dict[str, dict[str, Any]]:
    plan_groups: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    result_groups: dict[str, list[EpisodeResult]] = defaultdict(list)
    for plan in plans:
        plan_groups[str(plan.get(dimension))].append(plan)
    for index, result in enumerate(results, start=1):
        value: Any
        if dimension == "run_index":
            value = _episode_run_index(result, index)
        else:
            value = getattr(result, dimension, getattr(result.task, dimension, None))
        result_groups[str(value)].append(result)
    values: dict[str, dict[str, Any]] = {}
    for name in sorted(set(plan_groups) | set(result_groups)):
        items = result_groups.get(name, [])
        denominator = max(len(items), len(plan_groups.get(name, [])))
        scores = [_episode_overall_score(item) for item in items]
        padded_scores = [*scores, *([0.0] * max(0, denominator - len(scores)))]
        values[name] = {
            "planned_episode_count": denominator,
            "executed_episode_count": len(items),
            "not_run_count": max(0, denominator - len(items)),
            "success_rate": (
                sum(item.task_success for item in items) / denominator if denominator else 0.0
            ),
            "overall_score": fmean(padded_scores) if padded_scores else 0.0,
            "overall_score_std": pstdev(padded_scores) if len(padded_scores) > 1 else 0.0,
            "run_count": len(
                {_episode_run_index(item, index) for index, item in enumerate(items, start=1)}
            ),
        }
    return values


def _planned_key(plan: Mapping[str, Any]) -> tuple[str, int, int]:
    return (
        str(plan.get("task_id") or ""),
        int(plan.get("seed") or 0),
        int(plan.get("run_index") or 1),
    )


def _not_run_descriptors(
    results: Sequence[EpisodeResult], plans: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    actual = Counter(
        (
            result.task.task_id,
            result.seed,
            _episode_run_index(result, index),
        )
        for index, result in enumerate(results, start=1)
    )
    not_run: list[dict[str, Any]] = []
    for plan in plans:
        key = _planned_key(plan)
        if actual[key]:
            actual[key] -= 1
        else:
            not_run.append(dict(plan))
    return not_run


def _scoring_metadata(
    results: Sequence[EpisodeResult], agent_information: Mapping[str, Any]
) -> dict[str, Any]:
    versions: set[str] = set()
    config_hashes: set[str] = set()
    game_versions: set[str] = set()
    benchmark_versions: set[str] = set()
    for result in results:
        scoring = _mapping(getattr(result, "scoring", None))
        version = (
            getattr(result, "scoring_version", None)
            or scoring.get("version")
            or scoring.get("scoring_version")
            or result.raw_metrics.get("scoring_version")
        )
        config_hash = (
            getattr(result, "scoring_config_hash", None)
            or scoring.get("config_hash")
            or scoring.get("scoring_config_hash")
            or result.raw_metrics.get("scoring_config_hash")
        )
        game_version = (
            getattr(result, "game_version", None)
            or result.agent_information.get("game_version")
            or result.terminal_state.get("game_version")
        )
        benchmark_version = getattr(
            result, "benchmark_version", None
        ) or result.agent_information.get("benchmark_version")
        if version:
            versions.add(str(version))
        if config_hash:
            config_hashes.add(str(config_hash))
        if game_version:
            game_versions.add(str(game_version))
        if benchmark_version:
            benchmark_versions.add(str(benchmark_version))
    return {
        "scoring_version": next(iter(versions)) if len(versions) == 1 else sorted(versions),
        "scoring_config_hash": (
            next(iter(config_hashes)) if len(config_hashes) == 1 else sorted(config_hashes)
        ),
        "benchmark_version": (
            next(iter(benchmark_versions))
            if len(benchmark_versions) == 1
            else sorted(benchmark_versions)
        ),
        "game_version": (
            next(iter(game_versions)) if len(game_versions) == 1 else sorted(game_versions)
        ),
    }


def _build_difficulty_results(
    results: Sequence[EpisodeResult],
    *,
    planned_episodes: Any = None,
    agent_metadata: Mapping[str, Any] | None = None,
    score_denominators: Mapping[str, int] | None = None,
) -> list[dict[str, Any]]:
    plans_by_agent = _normalise_planned_episodes(planned_episodes, results, agent_metadata)
    results_by_agent: dict[str, list[EpisodeResult]] = defaultdict(list)
    agent_information: dict[str, Mapping[str, Any]] = {}
    for result in results:
        identity = _agent_name(result)
        results_by_agent[identity].append(result)
        agent_information.setdefault(identity, result.agent_information)
    if agent_metadata:
        agent_information.setdefault(_agent_identity(agent_metadata), agent_metadata)

    entries: list[dict[str, Any]] = []
    for identity in sorted(set(results_by_agent) | set(plans_by_agent)):
        agent_results = results_by_agent.get(identity, [])
        agent_plan = plans_by_agent.get(identity, [])
        result_cells: dict[tuple[str, str], list[EpisodeResult]] = defaultdict(list)
        plan_cells: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for result in agent_results:
            result_cells[(result.task.game_id, result.task.difficulty)].append(result)
        for plan in agent_plan:
            plan_cells[(plan["game_id"], plan["difficulty"])].append(plan)
        cells = set(result_cells) | set(plan_cells)
        denominator_override = (score_denominators or {}).get(identity)
        for game_id, difficulty in sorted(cells):
            cell_results = result_cells.get((game_id, difficulty), [])
            cell_plan = plan_cells.get((game_id, difficulty), [])
            denominator = max(len(cell_results), len(cell_plan))
            if len(cells) == 1 and denominator_override is not None:
                denominator = max(denominator, denominator_override)
            successes = sum(result.task_success for result in cell_results)
            scores = [_episode_overall_score(result) for result in cell_results]
            padded_scores = [*scores, *([0.0] * max(0, denominator - len(scores)))]
            breakdown = _score_breakdown_average(cell_results, denominator)

            level_results: dict[str, list[EpisodeResult]] = defaultdict(list)
            level_plans: dict[str, list[dict[str, Any]]] = defaultdict(list)
            level_values: dict[str, Any] = {}
            for result in cell_results:
                key = str(result.task.level_id)
                level_values[key] = result.task.level_id
                level_results[key].append(result)
            for plan in cell_plan:
                key = str(plan.get("level_id"))
                level_values[key] = plan.get("level_id")
                level_plans[key].append(plan)
            levels: list[dict[str, Any]] = []
            for key in sorted(set(level_results) | set(level_plans)):
                actual = level_results.get(key, [])
                planned = level_plans.get(key, [])
                level_denominator = max(len(actual), len(planned))
                level_scores = [_episode_overall_score(result) for result in actual]
                level_padded = [
                    *level_scores,
                    *([0.0] * max(0, level_denominator - len(level_scores))),
                ]
                levels.append(
                    {
                        "level_id": level_values[key],
                        "planned_episode_count": level_denominator,
                        "executed_episode_count": len(actual),
                        "not_run_count": max(0, level_denominator - len(actual)),
                        "success_rate": (
                            sum(result.task_success for result in actual) / level_denominator
                            if level_denominator
                            else 0.0
                        ),
                        "overall_score": fmean(level_padded) if level_padded else 0.0,
                        "overall_score_std": (
                            pstdev(level_padded) if len(level_padded) > 1 else 0.0
                        ),
                        "score_breakdown": _score_breakdown_average(actual, level_denominator),
                        "seed_statistics": _dimension_statistics(actual, planned, dimension="seed"),
                        "episodes": [_episode_payload(result) for result in actual],
                        "planned_episodes": [dict(item) for item in planned],
                        "not_run_episodes": _not_run_descriptors(actual, planned),
                    }
                )
            successful_levels = sum(level["success_rate"] == 1.0 for level in levels)
            info = agent_information.get(identity, {})
            entry = {
                "game_id": game_id,
                "difficulty": difficulty,
                "agent": _agent_columns_from_mapping(info)["Agent"],
                "leaderboard_identity": identity,
                "agent_information": dict(info),
                "success_rate": successes / denominator if denominator else 0.0,
                "overall_score": fmean(padded_scores) if padded_scores else 0.0,
                "overall_score_std": (pstdev(padded_scores) if len(padded_scores) > 1 else 0.0),
                "level_count": len(levels),
                "successful_levels": successful_levels,
                "failed_levels": max(0, len(levels) - successful_levels),
                "planned_episode_count": denominator,
                "executed_episode_count": len(cell_results),
                "not_run_count": max(0, denominator - len(cell_results)),
                "successful_episodes": successes,
                "failed_episodes": max(0, denominator - successes),
                **comparable_metrics(cell_results, cell_plan),
                "score_breakdown": breakdown,
                "metrics": _difficulty_metrics(cell_results, denominator),
                "termination_reasons": _termination_reasons(cell_results, denominator),
                "seed_statistics": _dimension_statistics(cell_results, cell_plan, dimension="seed"),
                "run_statistics": _dimension_statistics(
                    cell_results, cell_plan, dimension="run_index"
                ),
                "planned_episodes": [dict(item) for item in cell_plan],
                "not_run_episodes": _not_run_descriptors(cell_results, cell_plan),
                "levels": levels,
                **_scoring_metadata(cell_results, info),
            }
            entries.append(entry)
    return entries


def _build_leaderboard(
    results: Sequence[EpisodeResult],
    *,
    score_denominators: Mapping[str, int] | None = None,
    difficulty_results: Sequence[Mapping[str, Any]] | None = None,
    planned_episodes: Any = None,
    agent_metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    agents: dict[str, list[EpisodeResult]] = defaultdict(list)
    for result in results:
        agents[_agent_name(result)].append(result)
    difficulty_entries = list(
        difficulty_results
        or _build_difficulty_results(
            results,
            planned_episodes=planned_episodes,
            agent_metadata=agent_metadata,
            score_denominators=score_denominators,
        )
    )
    cells_by_agent: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for item in difficulty_entries:
        cells_by_agent[str(item["leaderboard_identity"])].append(item)
    entries: list[dict[str, Any]] = []
    for agent in sorted(set(agents) | set(cells_by_agent)):
        agent_results = agents.get(agent, [])
        cells = cells_by_agent.get(agent, [])
        resource_statistics = _statistics(agent_results)
        agent_info = (
            agent_results[0].agent_information
            if agent_results
            else _mapping(cells[0].get("agent_information"))
            if cells
            else {}
        )
        agent_columns = _agent_columns_from_mapping(agent_info)
        matrix_hashes = {
            str(result.agent_information.get("evaluation_matrix_hash"))
            for result in agent_results
            if result.agent_information.get("evaluation_matrix_hash")
        }
        if len(matrix_hashes) > 1:
            agent_columns["Evaluation Matrix Hash"] = "multiple"
        if cells:
            agent_columns["Planned Episodes"] = sum(
                int(cell.get("planned_episode_count", 0)) for cell in cells
            )
        per_game_values: dict[str, list[float]] = defaultdict(list)
        per_difficulty_values: dict[str, list[float]] = defaultdict(list)
        per_game_difficulty: dict[str, dict[str, Any]] = {}
        for cell in cells:
            game = str(cell["game_id"])
            difficulty = str(cell["difficulty"])
            score = float(cell["overall_score"])
            per_game_values[game].append(score)
            per_difficulty_values[difficulty].append(score)
            breakdown = _mapping(cell.get("score_breakdown"))
            metrics = _mapping(cell.get("metrics"))
            per_game_difficulty[f"{game}.{difficulty}"] = {
                "overall_score": score,
                "success_rate": float(cell["success_rate"]),
                "comparable_success_rate": float(
                    cell.get("comparable_success_rate", cell["success_rate"])
                ),
                "comparison_eligible": bool(cell.get("comparison_eligible", True)),
                "progress": metrics.get("mean_progress"),
                "efficiency": metrics.get("mean_step_efficiency"),
                "action_quality": metrics.get(
                    "mean_action_quality", metrics.get("valid_action_rate")
                ),
                "score_breakdown": breakdown,
                "planned_episode_count": cell.get("planned_episode_count", 0),
            }

        def macro_metric(source: str, name: str) -> float | None:
            values = [
                float(value)
                for cell in cells
                if (value := _mapping(cell.get(source)).get(name)) is not None
                and _number(value) is not None
            ]
            return fmean(values) if values else None

        overall_score = fmean(float(cell["overall_score"]) for cell in cells) if cells else 0.0
        overall_success_rate = (
            fmean(float(cell["success_rate"]) for cell in cells) if cells else 0.0
        )
        eligible_cells = [cell for cell in cells if cell.get("comparison_eligible", True)]
        comparable_score = (
            fmean(
                float(cell.get("comparable_overall_score", cell["overall_score"]))
                for cell in eligible_cells
            )
            if eligible_cells
            else 0.0
        )
        comparable_success_rate = (
            fmean(
                float(cell.get("comparable_success_rate", cell["success_rate"]))
                for cell in eligible_cells
            )
            if eligible_cells
            else 0.0
        )
        entries.append(
            {
                **agent_columns,
                "Leaderboard Identity": agent,
                "Overall Score": overall_score,
                "Overall Success Rate": overall_success_rate,
                "Comparable Score": comparable_score,
                "Comparable Success Rate": comparable_success_rate,
                "Comparable Cells": len(eligible_cells),
                "Per-Game-Difficulty": per_game_difficulty,
                "Per-Game Score": {
                    name: fmean(values) for name, values in sorted(per_game_values.items())
                },
                "Per-Difficulty Score": {
                    name: fmean(values) for name, values in sorted(per_difficulty_values.items())
                },
                "Progress": macro_metric("metrics", "mean_progress"),
                "Efficiency": macro_metric("metrics", "mean_step_efficiency"),
                "Action Quality": macro_metric("metrics", "mean_action_quality"),
                "Progress Score": macro_metric("score_breakdown", "progress_score"),
                "Efficiency Score": macro_metric("score_breakdown", "efficiency_score"),
                "Action Quality Score": macro_metric("score_breakdown", "action_quality_score"),
                "Time Score": macro_metric("score_breakdown", "time_score"),
                "Penalty Score": macro_metric("score_breakdown", "penalty_score"),
                "Average Steps": resource_statistics["average_steps"],
                "Average Agent Decisions": resource_statistics["average_agent_decisions"],
                "Average Environment Steps": resource_statistics["average_environment_steps"],
                "Average Runtime": resource_statistics["average_runtime_seconds"],
                "Average Model Calls": resource_statistics["average_model_calls"],
                "Average Input Tokens": resource_statistics["average_input_tokens"],
                "Average Output Tokens": resource_statistics["average_output_tokens"],
                "Average Tokens": resource_statistics["average_total_tokens"],
                "Average Model Latency": resource_statistics["average_model_latency_seconds"],
                "Estimated Cost": resource_statistics["total_estimated_cost"],
                "Average Invalid Actions": resource_statistics["average_invalid_actions"],
                "Average Parse Failures": resource_statistics["average_parse_failures"],
                "Average Repeated Actions": resource_statistics["average_repeated_actions"],
                "Average No-op Actions": resource_statistics["average_noop_actions"],
                "Episodes": resource_statistics["episode_count"],
                "Difficulty Cells": len(cells),
            }
        )
    comparison_groups: dict[str, dict[str, Any]] = {}
    for entry in entries:
        scope = {
            "track": entry["Track"],
            "benchmark_version": entry["Benchmark Version"],
            "benchmark_config_hash": entry["Benchmark Config Hash"],
            "environment_version": entry["Environment Version"],
            "prompt_setting": entry.get("Prompt Setting", "unspecified"),
            "context_setting": entry.get("Context Setting", "unspecified"),
            "eval_mode": entry.get("Eval Mode", "unspecified"),
            "experiment_config_hash": entry.get("Experiment Config Hash", "unhashed"),
        }
        # Native/Best-System explicitly compares complete systems.  Every other
        # track is a fixed-scaffold comparison and must never rank different
        # harness/provider configurations against each other.
        if entry["Track"] != "native_agent":
            scope.update(
                {
                    "model_provider": entry["Model Provider"],
                    "agent_framework": entry["Agent Harness"],
                    "agent_framework_version": entry["Harness Version"],
                    "agent_config_hash": entry["Harness Config Hash"],
                }
            )
        scope_hash = hashlib.sha256(
            json.dumps(scope, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()[:12]
        group = f"{entry['Track']}:{scope_hash}"
        entry["Comparison Group"] = group
        group_data = comparison_groups.setdefault(
            group,
            {"scope": scope, "entries": []},
        )
        group_data["entries"].append(entry)
    for group_data in comparison_groups.values():
        group_entries = group_data["entries"]
        group_entries.sort(
            key=lambda item: (
                item.get("Comparable Cells", 0) == 0,
                -item.get("Comparable Score", item["Overall Score"]),
                -item.get("Comparable Success Rate", item["Overall Success Rate"]),
                item["Leaderboard Identity"],
            )
        )
        for rank, entry in enumerate(group_entries, start=1):
            entry["Rank Within Comparison Group"] = rank
    ordered_groups = {name: comparison_groups[name] for name in sorted(comparison_groups)}
    only_entries = (
        next(iter(ordered_groups.values()))["entries"] if len(ordered_groups) == 1 else []
    )
    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "ranking_scope": "track_policy_and_reproducibility_scope",
        "entries": only_entries,
        "comparison_groups": ordered_groups,
    }


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _append_jsonl_atomically(path: Path, payload: Mapping[str, Any]) -> None:
    """Append one complete record via replace so interruption cannot tear a line."""

    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        existing + json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _summary_rows(summary: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for dimension in (
        "overall",
        "by_agent",
        "by_game",
        "by_difficulty",
        "by_game_difficulty",
        "by_level",
        "by_seed",
    ):
        value = summary[dimension]
        groups = {"all": value} if dimension == "overall" else value
        for key, stats in groups.items():
            rows.append(
                {
                    "dimension": dimension,
                    "key": key,
                    **{
                        name: metric
                        for name, metric in stats.items()
                        if name != "raw_metric_averages"
                    },
                    "raw_metric_averages": json.dumps(
                        stats["raw_metric_averages"], ensure_ascii=False, sort_keys=True
                    ),
                }
            )
    return rows


def _write_csv(path: Path, rows: Sequence[Mapping[str, Any]], fieldnames: Sequence[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    temporary.replace(path)


def load_results(path: str | Path) -> list[EpisodeResult]:
    """Load episode results from JSONL, a single JSON artifact, or an output directory."""

    source = Path(path)
    if source.is_dir():
        episode_files = sorted((source / "episodes").glob("*.json"))
        if episode_files:
            return [
                EpisodeResult.model_validate_json(item.read_text(encoding="utf-8"))
                for item in episode_files
            ]
        jsonl_path = source / "episodes.jsonl"
        if jsonl_path.exists():
            source = jsonl_path
        else:
            return []
    if source.suffix == ".jsonl":
        results = []
        with source.open(encoding="utf-8") as file:
            for line_number, line in enumerate(file, start=1):
                if not line.strip():
                    continue
                try:
                    results.append(EpisodeResult.model_validate_json(line))
                except ValueError as error:
                    raise ValueError(
                        f"invalid result at {source}:{line_number}: {error}"
                    ) from error
        return results
    data = json.loads(source.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return [EpisodeResult.model_validate(item) for item in data]
    if isinstance(data, dict) and "episodes" in data:
        return [EpisodeResult.model_validate(item) for item in data["episodes"]]
    return [EpisodeResult.model_validate(data)]


class ResultWriter:
    """Persist append-only episodes, then generate deterministic offline reports."""

    def __init__(self, output_directory: str | Path):
        self.output_directory = Path(output_directory)
        self.episodes_directory = self.output_directory / "episodes"
        self.output_directory.mkdir(parents=True, exist_ok=True)
        self.episodes_directory.mkdir(parents=True, exist_ok=True)

    def _next_episode_id(self, task_id: str) -> str:
        safe_id = re.sub(r"[^a-zA-Z0-9_.-]", "_", task_id)
        run_numbers = []
        for path in self.episodes_directory.glob(f"{safe_id}.run_*.json"):
            match = re.search(r"\.run_(\d+)\.json$", path.name)
            if match:
                run_numbers.append(int(match.group(1)))
        return f"{safe_id}.run_{max(run_numbers, default=0) + 1:03d}"

    def write_episode(
        self,
        result: EpisodeResult,
        trajectory_dir: str | Path | None = None,
    ) -> Path:
        """Write a per-episode JSON artifact and append the same record to JSONL."""

        episode_id = result.episode_id or self._next_episode_id(result.task.task_id)
        runtime = dict(result.runtime)
        if trajectory_dir is not None:
            runtime["trajectory_directory"] = str(trajectory_dir)
        persisted = result.model_copy(
            update={"episode_id": episode_id, "runtime": runtime}, deep=True
        )
        payload = _episode_payload(persisted)
        payload["episode_id"] = episode_id
        artifact_path = self.episodes_directory / f"{episode_id}.json"
        if artifact_path.exists():
            raise FileExistsError(f"episode artifact already exists: {artifact_path}")
        _write_json(artifact_path, payload)
        _append_jsonl_atomically(self.output_directory / "episodes.jsonl", payload)
        return artifact_path

    def load_results(self) -> list[EpisodeResult]:
        return load_results(self.output_directory)

    def finalize(
        self,
        agent_metadata: Mapping[str, Any] | None = None,
        *,
        expected_episode_count: int | None = None,
        benchmark_summary: Mapping[str, Any] | None = None,
        score_denominators: Mapping[str, int] | None = None,
        planned_episodes: Any = None,
    ) -> dict[str, Path]:
        """Regenerate summary and leaderboard JSON/CSV from append-only episodes."""

        (self.output_directory / "episodes.jsonl").touch(exist_ok=True)
        results = self.load_results()
        effective_planned_episodes = planned_episodes
        if effective_planned_episodes is None and benchmark_summary:
            benchmark_plan = benchmark_summary.get("planned_episodes")
            if benchmark_plan is not None:
                effective_planned_episodes = benchmark_plan
            else:
                not_run = benchmark_summary.get("not_run_tasks")
                if isinstance(not_run, Sequence) and not isinstance(not_run, str):
                    by_agent: dict[str, list[Any]] = defaultdict(list)
                    for index, result in enumerate(results, start=1):
                        by_agent[_agent_name(result)].append(
                            _result_descriptor(result, default_run_index=index)
                        )
                    if by_agent:
                        for plan in by_agent.values():
                            plan.extend(not_run)
                        effective_planned_episodes = dict(by_agent)
        # Episode identity is immutable evidence. Never backfill older artifacts
        # with metadata from the current invocation/output-directory reuse.
        effective_denominators = dict(score_denominators or {})
        if expected_episode_count is not None and not effective_denominators:
            agent_names = {_agent_name(item) for item in results}
            if not agent_names and agent_metadata:
                fallback_name = _agent_identity(agent_metadata)
                agent_names.add(fallback_name)
            effective_denominators = {name: expected_episode_count for name in agent_names}
        summary = aggregate_results(
            results,
            expected_episode_count=expected_episode_count,
            benchmark_summary=benchmark_summary,
            score_denominators=score_denominators,
            planned_episodes=effective_planned_episodes,
            agent_metadata=agent_metadata,
        )
        difficulty_entries = _build_difficulty_results(
            results,
            planned_episodes=effective_planned_episodes,
            agent_metadata=agent_metadata,
            score_denominators=effective_denominators,
        )
        leaderboard = _build_leaderboard(
            results,
            score_denominators=effective_denominators,
            difficulty_results=difficulty_entries,
            planned_episodes=effective_planned_episodes,
            agent_metadata=agent_metadata,
        )
        summary_json = self.output_directory / "summary.json"
        summary_csv = self.output_directory / "summary.csv"
        difficulty_results_json = self.output_directory / "difficulty_results.json"
        leaderboard_json = self.output_directory / "leaderboard.json"
        leaderboard_csv = self.output_directory / "leaderboard.csv"
        _write_json(summary_json, summary)
        difficulty_payload = {
            "generated_at": datetime.now(UTC).isoformat(),
            "aggregation_unit": "game_x_difficulty",
            "score_scale": [0, 100],
            "not_run_policy": "score_zero_and_include_in_complete_denominator",
            "entries": difficulty_entries,
        }
        _write_json(difficulty_results_json, difficulty_payload)
        summary_rows = _summary_rows(summary)
        _write_csv(
            summary_csv,
            summary_rows,
            (
                "dimension",
                "key",
                "episode_count",
                "success_rate",
                "average_normalized_score",
                "average_game_score",
                "average_steps",
                "average_agent_decisions",
                "average_environment_steps",
                "average_runtime_seconds",
                "average_invalid_actions",
                "average_model_calls",
                "average_input_tokens",
                "average_output_tokens",
                "average_total_tokens",
                "average_model_latency_seconds",
                "total_estimated_cost",
                "average_parse_failures",
                "average_repeated_actions",
                "average_noop_actions",
                "raw_metric_averages",
            ),
        )
        _write_json(leaderboard_json, leaderboard)
        all_group_entries = [
            entry
            for group in leaderboard["comparison_groups"].values()
            for entry in group["entries"]
        ]
        leaderboard_rows = [
            {
                **item,
                "Per-Game-Difficulty": json.dumps(
                    item["Per-Game-Difficulty"], ensure_ascii=False, sort_keys=True
                ),
                "Per-Game Score": json.dumps(
                    item["Per-Game Score"], ensure_ascii=False, sort_keys=True
                ),
                "Per-Difficulty Score": json.dumps(
                    item["Per-Difficulty Score"], ensure_ascii=False, sort_keys=True
                ),
            }
            for item in all_group_entries
        ]
        _write_csv(
            leaderboard_csv,
            leaderboard_rows,
            (
                "Agent",
                "Model",
                "Model Provider",
                "Agent Harness",
                "Harness Version",
                "Harness Config Hash",
                "Track",
                "Prompt Setting",
                "Context Setting",
                "Eval Mode",
                "Experiment Config Hash",
                "Comparison Group",
                "Rank Within Comparison Group",
                "Benchmark Version",
                "Benchmark Config Hash",
                "Environment Version",
                "Evaluation Matrix Hash",
                "Planned Episodes",
                "Leaderboard Identity",
                "Overall Score",
                "Overall Success Rate",
                "Comparable Score",
                "Comparable Success Rate",
                "Comparable Cells",
                "Per-Game-Difficulty",
                "Per-Game Score",
                "Per-Difficulty Score",
                "Progress",
                "Efficiency",
                "Action Quality",
                "Progress Score",
                "Efficiency Score",
                "Action Quality Score",
                "Time Score",
                "Penalty Score",
                "Average Steps",
                "Average Agent Decisions",
                "Average Environment Steps",
                "Average Runtime",
                "Average Model Calls",
                "Average Input Tokens",
                "Average Output Tokens",
                "Average Tokens",
                "Average Model Latency",
                "Estimated Cost",
                "Average Invalid Actions",
                "Average Parse Failures",
                "Average Repeated Actions",
                "Average No-op Actions",
                "Episodes",
                "Difficulty Cells",
            ),
        )
        files = {
            "episodes_jsonl": self.output_directory / "episodes.jsonl",
            "summary_json": summary_json,
            "summary_csv": summary_csv,
            "difficulty_results_json": difficulty_results_json,
            "leaderboard_json": leaderboard_json,
            "leaderboard_csv": leaderboard_csv,
        }
        cells: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for entry in difficulty_entries:
            cells[f"{entry['game_id']}.{entry['difficulty']}"].append(entry)
        difficulty_directory = self.output_directory / "difficulty_results"
        for cell_name, cell_entries in sorted(cells.items()):
            safe_name = re.sub(r"[^a-zA-Z0-9_.-]", "_", cell_name)
            cell_path = difficulty_directory / f"{safe_name}.json"
            cell_payload: dict[str, Any] = {
                "generated_at": difficulty_payload["generated_at"],
                "aggregation_unit": "game_x_difficulty",
                "game_id": cell_entries[0]["game_id"],
                "difficulty": cell_entries[0]["difficulty"],
                "entries": cell_entries,
            }
            if len(cell_entries) == 1:
                # The normal benchmark invocation has one agent. Keep direct
                # access compatible with the documented difficulty result shape.
                cell_payload.update(cell_entries[0])
            _write_json(cell_path, cell_payload)
            files[f"difficulty_{safe_name}_json"] = cell_path
        for group_name, group in leaderboard["comparison_groups"].items():
            safe_name = re.sub(r"[^a-zA-Z0-9_.-]", "_", group_name)
            group_json = self.output_directory / f"leaderboard.{safe_name}.json"
            group_csv = self.output_directory / f"leaderboard.{safe_name}.csv"
            _write_json(
                group_json,
                {
                    "generated_at": leaderboard["generated_at"],
                    "comparison_group": group_name,
                    "scope": group["scope"],
                    "entries": group["entries"],
                },
            )
            group_rows = [
                {
                    **item,
                    "Per-Game-Difficulty": json.dumps(
                        item["Per-Game-Difficulty"],
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                    "Per-Game Score": json.dumps(
                        item["Per-Game Score"], ensure_ascii=False, sort_keys=True
                    ),
                    "Per-Difficulty Score": json.dumps(
                        item["Per-Difficulty Score"],
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                }
                for item in group["entries"]
            ]
            _write_csv(
                group_csv, group_rows, tuple(leaderboard_rows[0].keys()) if leaderboard_rows else ()
            )
            files[f"leaderboard_{safe_name}_json"] = group_json
            files[f"leaderboard_{safe_name}_csv"] = group_csv
        return files
