import csv
import json
from argparse import Namespace

import pytest

from mobile_world.benchmarks import (
    MetricConfig,
    MiniGameEvaluator,
    MiniGameTaskSpec,
    ResultWriter,
    aggregate_results,
    load_results,
)
from mobile_world.benchmarks.results import comparable_metrics
from mobile_world.core.subcommands.leaderboard import execute as rebuild_leaderboard


def _result(
    *,
    game: str,
    difficulty: str,
    level: int,
    success: bool,
    agent: str,
    score: float,
    seed: int = 0,
    run_index: int | None = None,
):
    task = MiniGameTaskSpec(
        game_id=game,
        difficulty=difficulty,
        level_id=level,
        seed=seed,
        instruction="Complete the visible puzzle using GUI actions.",
        metric_config=MetricConfig(
            normalization="linear", minimum=0, maximum=100, score_field="score"
        ),
    )
    result = MiniGameEvaluator().evaluate(
        {
            "success": success,
            "status": "success" if success else "failure",
            "score": score,
            "metrics": {"move_counts": {"accepted": 4 + level}},
        },
        task,
        steps=5 + level,
        elapsed=2.5 + level,
        agent_information={"name": agent, "model": "test-model"},
        trajectory=[{"action_type": "click", "x": 10, "y": 20}],
        observation_metadata=[{"width": 540, "height": 960}],
    )
    if run_index is not None:
        result = result.model_copy(
            update={"runtime": {**result.runtime, "run_index": run_index}}, deep=True
        )
    return result


def test_aggregate_results_by_dimensions() -> None:
    results = [
        _result(game="bolt_unscrew", difficulty="easy", level=1, success=True, agent="a", score=80),
        _result(
            game="bolt_unscrew", difficulty="hard", level=2, success=False, agent="a", score=20
        ),
        _result(game="nuts_bolts", difficulty="easy", level=1, success=True, agent="b", score=60),
    ]

    summary = aggregate_results(results)

    assert summary["overall"]["episode_count"] == 3
    assert summary["overall"]["success_rate"] == 2 / 3
    assert summary["by_game"]["bolt_unscrew"]["average_normalized_score"] == 0.5
    assert summary["by_difficulty"]["easy"]["episode_count"] == 2
    agent_a = next(value for key, value in summary["by_agent"].items() if key.endswith(":a"))
    assert agent_a["raw_metric_averages"]["move_counts.accepted"] == 5.5


def test_result_writer_round_trip_and_reports(tmp_path) -> None:
    writer = ResultWriter(tmp_path)
    first = _result(
        game="bolt_unscrew", difficulty="easy", level=1, success=True, agent="agent-a", score=90
    )
    second = _result(
        game="truck_escape", difficulty="default", level=1, success=False, agent="agent-b", score=10
    )

    first_path = writer.write_episode(first, trajectory_dir="trajs/first")
    second_path = writer.write_episode(second)
    paths = writer.finalize()

    assert first_path.exists() and second_path.exists()
    assert first_path != second_path
    assert all(path.exists() for path in paths.values())
    assert len(writer.load_results()) == 2
    assert len(load_results(tmp_path / "episodes.jsonl")) == 2
    assert json.loads(first_path.read_text())["runtime"]["trajectory_directory"] == "trajs/first"

    summary = json.loads(paths["summary_json"].read_text())
    leaderboard = json.loads(paths["leaderboard_json"].read_text())
    assert summary["overall"]["episode_count"] == 2
    assert [row["Agent"] for row in leaderboard["entries"]] == ["agent-a", "agent-b"]

    with paths["summary_csv"].open(newline="") as file:
        assert any(row["dimension"] == "by_game" for row in csv.DictReader(file))
    with paths["leaderboard_csv"].open(newline="") as file:
        assert [row["Agent"] for row in csv.DictReader(file)] == ["agent-a", "agent-b"]


def test_early_termination_keeps_full_score_denominator() -> None:
    result = _result(
        game="bolt_unscrew",
        difficulty="easy",
        level=1,
        success=True,
        agent="agent-a",
        score=100,
    )

    summary = aggregate_results(
        [result],
        expected_episode_count=4,
        benchmark_summary={"benchmark_status": "terminated", "remaining_tasks": 3},
    )

    assert summary["overall"]["episode_count"] == 1
    assert summary["overall"]["score_denominator"] == 4
    assert summary["overall"]["not_run_count"] == 3
    assert summary["overall"]["average_normalized_score"] == 0.25
    assert summary["overall"]["success_rate"] == 0.25
    assert summary["benchmark"]["remaining_tasks"] == 3


def test_leaderboard_never_merges_models_or_harness_configs(tmp_path) -> None:
    writer = ResultWriter(tmp_path)
    base = _result(
        game="bolt_unscrew",
        difficulty="easy",
        level=1,
        success=True,
        agent="general_e2e",
        score=100,
    )
    for model, config_hash, calls in (
        ("qwen/model", "a" * 64, 1),
        ("google/model", "b" * 64, 2),
    ):
        writer.write_episode(
            base.model_copy(
                update={
                    "episode_id": None,
                    "agent_information": {
                        "name": "general_e2e",
                        "agent_type": "general_e2e",
                        "model": model,
                        "model_name": model,
                        "model_provider": "openrouter",
                        "agent_framework": "mobileworld_native",
                        "agent_framework_version": "GeneralE2EAgentMCP",
                        "agent_config_hash": config_hash,
                        "leaderboard_track": "native_agent",
                    },
                    "runtime": {
                        "model_usage": {
                            "model_calls": calls,
                            "input_tokens": 10,
                            "output_tokens": 5,
                            "total_tokens": 15,
                            "model_latency_seconds": 0.5,
                            "estimated_cost": 0.01,
                            "parse_failures": 0,
                            "repeated_actions": 0,
                            "noop_actions": 0,
                        }
                    },
                },
                deep=True,
            )
        )

    paths = writer.finalize()
    entries = json.loads(paths["leaderboard_json"].read_text())["entries"]

    assert len(entries) == 2
    assert {entry["Model"] for entry in entries} == {"qwen/model", "google/model"}
    assert {entry["Agent Harness"] for entry in entries} == {"mobileworld_native"}
    assert {entry["Average Model Calls"] for entry in entries} == {1.0, 2.0}
    assert all(entry["Harness Config Hash"] for entry in entries)


def test_leaderboard_never_merges_provider_or_environment_versions(tmp_path) -> None:
    writer = ResultWriter(tmp_path)
    base = _result(
        game="bolt_unscrew",
        difficulty="easy",
        level=1,
        success=True,
        agent="unified_openai",
        score=100,
    )
    for provider, environment in (
        ("openrouter", "cocos-a"),
        ("private_gateway", "cocos-b"),
    ):
        writer.write_episode(
            base.model_copy(
                update={
                    "episode_id": None,
                    "agent_information": {
                        "name": "unified_openai",
                        "model_name": "same/model",
                        "model_provider": provider,
                        "agent_framework": "mobileworld_unified",
                        "agent_framework_version": "1",
                        "agent_config_hash": "a" * 64,
                        "leaderboard_track": "unified_harness",
                        "benchmark_version": "benchmark-a",
                        "benchmark_config_hash": "b" * 64,
                        "environment_version": environment,
                    },
                },
                deep=True,
            )
        )

    leaderboard = json.loads(writer.finalize()["leaderboard_json"].read_text())
    entries = [
        entry for group in leaderboard["comparison_groups"].values() for entry in group["entries"]
    ]

    assert leaderboard["entries"] == []
    assert len(entries) == 2
    assert {entry["Model Provider"] for entry in entries} == {
        "openrouter",
        "private_gateway",
    }
    assert {entry["Environment Version"] for entry in entries} == {
        "cocos-a",
        "cocos-b",
    }


def test_tracks_are_ranked_in_separate_comparison_groups(tmp_path) -> None:
    writer = ResultWriter(tmp_path)
    base = _result(
        game="bolt_unscrew",
        difficulty="easy",
        level=1,
        success=True,
        agent="agent",
        score=100,
    )
    for track in ("unified_harness", "native_agent"):
        writer.write_episode(
            base.model_copy(
                update={
                    "episode_id": None,
                    "agent_information": {
                        "name": "agent",
                        "model_name": "same/model",
                        "agent_framework": track,
                        "agent_framework_version": "1",
                        "agent_config_hash": "a" * 64,
                        "leaderboard_track": track,
                        "evaluation_matrix_hash": "m" * 64,
                    },
                },
                deep=True,
            )
        )

    paths = writer.finalize()
    leaderboard = json.loads(paths["leaderboard_json"].read_text())

    assert leaderboard["entries"] == []
    groups = leaderboard["comparison_groups"]
    assert len(groups) == 2
    assert {group["scope"]["track"] for group in groups.values()} == {
        "native_agent",
        "unified_harness",
    }
    assert any("native_agent" in key for key in paths)
    assert any("unified_harness" in key for key in paths)


def test_unified_track_never_ranks_different_harness_configs_together(tmp_path) -> None:
    writer = ResultWriter(tmp_path)
    base = _result(
        game="bolt_unscrew",
        difficulty="easy",
        level=1,
        success=True,
        agent="unified_openai",
        score=100,
    )
    for model, config_hash in (("model/a", "a" * 64), ("model/b", "b" * 64)):
        writer.write_episode(
            base.model_copy(
                update={
                    "episode_id": None,
                    "agent_information": {
                        "name": "unified_openai",
                        "model_name": model,
                        "model_provider": "openrouter",
                        "agent_framework": "mobileworld_unified",
                        "agent_framework_version": "1.1.0",
                        "agent_config_hash": config_hash,
                        "leaderboard_track": "unified_harness",
                        "benchmark_version": "benchmark-a",
                        "benchmark_config_hash": "c" * 64,
                        "environment_version": "environment-a",
                        "evaluation_matrix_hash": "m" * 64,
                    },
                },
                deep=True,
            )
        )

    leaderboard = json.loads(writer.finalize()["leaderboard_json"].read_text())

    assert leaderboard["entries"] == []
    assert len(leaderboard["comparison_groups"]) == 2
    assert all(len(group["entries"]) == 1 for group in leaderboard["comparison_groups"].values())


def test_offline_rebuild_preserves_planned_denominator(tmp_path) -> None:
    writer = ResultWriter(tmp_path)
    writer.write_episode(
        _result(
            game="bolt_unscrew",
            difficulty="easy",
            level=1,
            success=True,
            agent="agent-a",
            score=100,
        )
    )
    writer.finalize(
        expected_episode_count=4,
        benchmark_summary={"total_tasks": 4, "remaining_tasks": 3},
    )

    rebuild_leaderboard(Namespace(input=[str(tmp_path)], output=None))

    summary = json.loads((tmp_path / "summary.json").read_text())
    assert summary["overall"]["average_normalized_score"] == 0.25
    entry = json.loads((tmp_path / "leaderboard.json").read_text())["entries"][0]
    assert entry["Overall Score"] == 25.0


def _planned(result, *, run_index: int = 1) -> dict:
    return {
        "task": result.task.model_dump(mode="json"),
        "task_id": result.task.task_id,
        "seed": result.seed,
        "run_index": run_index,
    }


def test_difficulty_result_uses_complete_plan_and_keeps_actual_episodes(tmp_path) -> None:
    writer = ResultWriter(tmp_path)
    success = _result(
        game="bolt_unscrew",
        difficulty="easy",
        level=1,
        success=True,
        agent="agent-a",
        score=90,
    )
    failure = _result(
        game="bolt_unscrew",
        difficulty="easy",
        level=2,
        success=False,
        agent="agent-a",
        score=30,
    )
    writer.write_episode(success)
    writer.write_episode(failure)
    not_run_3 = _result(
        game="bolt_unscrew",
        difficulty="easy",
        level=3,
        success=False,
        agent="agent-a",
        score=0,
    )
    not_run_4 = _result(
        game="bolt_unscrew",
        difficulty="easy",
        level=4,
        success=False,
        agent="agent-a",
        score=0,
    )

    files = writer.finalize(
        planned_episodes=[
            _planned(success),
            _planned(failure),
            _planned(not_run_3),
            _planned(not_run_4),
        ]
    )

    payload = json.loads(files["difficulty_results_json"].read_text())
    entry = payload["entries"][0]
    assert entry["planned_episode_count"] == 4
    assert entry["executed_episode_count"] == 2
    assert entry["not_run_count"] == 2
    assert entry["success_rate"] == 0.25
    assert entry["overall_score"] == 30.0
    assert entry["termination_reasons"]["not_run"] == 2
    assert entry["score_breakdown"]["overall_score"] == 30.0
    assert len(entry["levels"]) == 4
    actual = [episode for level in entry["levels"] for episode in level["episodes"]]
    assert len(actual) == 2
    assert actual[0]["trajectory"]
    assert actual[0]["raw_metrics"]
    assert (
        json.loads(files["summary_json"].read_text())["by_game_difficulty"]["bolt_unscrew.easy"][
            "score_denominator"
        ]
        == 4
    )
    cell = json.loads(files["difficulty_bolt_unscrew.easy_json"].read_text())
    assert cell["overall_score"] == 30.0
    assert cell["levels"] == entry["levels"]


def test_difficulty_result_reports_seed_and_run_mean_std(tmp_path) -> None:
    writer = ResultWriter(tmp_path)
    results = [
        _result(
            game="bolt_unscrew",
            difficulty="easy",
            level=1,
            success=True,
            agent="agent-a",
            score=score,
            seed=seed,
            run_index=run,
        )
        for seed, run, score in ((0, 1, 100), (0, 2, 80), (1, 1, 60), (1, 2, 40))
    ]
    for result in results:
        writer.write_episode(result)

    paths = writer.finalize(
        planned_episodes=[
            _planned(result, run_index=result.runtime["run_index"]) for result in results
        ]
    )
    entry = json.loads(paths["difficulty_results_json"].read_text())["entries"][0]

    assert entry["overall_score"] == 70.0
    assert entry["overall_score_std"] == pytest.approx(22.360679775)
    assert entry["seed_statistics"]["0"]["overall_score"] == 90.0
    assert entry["seed_statistics"]["0"]["overall_score_std"] == 10.0
    assert entry["seed_statistics"]["1"]["overall_score"] == 50.0
    assert entry["run_statistics"]["1"]["overall_score"] == 80.0
    assert entry["run_statistics"]["2"]["overall_score"] == 60.0


def test_leaderboard_macro_averages_game_difficulty_cells(tmp_path) -> None:
    writer = ResultWriter(tmp_path)
    bolt_results = [
        _result(
            game="bolt_unscrew",
            difficulty="easy",
            level=level,
            success=True,
            agent="agent-a",
            score=100,
        )
        for level in (1, 2, 3)
    ]
    nuts = _result(
        game="nuts_bolts",
        difficulty="easy",
        level=1,
        success=False,
        agent="agent-a",
        score=0,
    )
    for result in [*bolt_results, nuts]:
        writer.write_episode(result)

    paths = writer.finalize(planned_episodes=[_planned(result) for result in [*bolt_results, nuts]])
    leaderboard = json.loads(paths["leaderboard_json"].read_text())
    entry = leaderboard["entries"][0]

    assert entry["Overall Score"] == 50.0
    assert entry["Overall Success Rate"] == 0.5
    assert entry["Difficulty Cells"] == 2
    assert set(entry["Per-Game-Difficulty"]) == {
        "bolt_unscrew.easy",
        "nuts_bolts.easy",
    }


def _plan(task_id: str, level: int) -> dict:
    return {
        "run_index": 1,
        "task_id": task_id,
        "game_id": "bolt_unscrew",
        "difficulty": "easy",
        "level_id": level,
        "seed": 0,
    }


def test_comparable_metrics_exclude_harness_blocked_levels() -> None:
    planned = [
        _plan("bolt_unscrew.easy.level_01.seed_0", 1),
        _plan("bolt_unscrew.easy.level_02.seed_0", 2),
        _plan("bolt_unscrew.easy.level_03.seed_0", 3),
    ]
    executed = [
        {
            **_plan("bolt_unscrew.easy.level_01.seed_0", 1),
            "termination_reason": "success",
            "success": True,
            "level_score": 80,
        },
        {
            **_plan("bolt_unscrew.easy.level_02.seed_0", 2),
            "termination_reason": "agent_error",
            "success": False,
            "level_score": 0,
        },
    ]

    metrics = comparable_metrics(executed, planned)

    assert metrics["harness_error_count"] == 1
    assert metrics["comparable_denominator"] == 1
    assert metrics["comparable_success_rate"] == 1.0
    assert metrics["comparison_eligible"] is True
    assert metrics["comparison_complete"] is False


def test_comparable_metrics_keep_capability_skips_as_zeros() -> None:
    planned = [
        _plan("bolt_unscrew.easy.level_01.seed_0", 1),
        _plan("bolt_unscrew.easy.level_02.seed_0", 2),
        _plan("bolt_unscrew.easy.level_03.seed_0", 3),
    ]
    executed = [
        {
            **_plan("bolt_unscrew.easy.level_01.seed_0", 1),
            "termination_reason": "game_failure",
            "success": False,
            "level_score": 10,
        }
    ]

    metrics = comparable_metrics(executed, planned)

    assert metrics["comparable_denominator"] == 3
    assert metrics["comparable_success_rate"] == 0.0
    assert metrics["comparison_eligible"] is True
    assert metrics["comparison_complete"] is True


def test_load_results_reads_legacy_episode_json_without_composite_fields(tmp_path) -> None:
    result = _result(
        game="bolt_unscrew",
        difficulty="easy",
        level=1,
        success=True,
        agent="legacy-agent",
        score=75,
    )
    legacy = result.model_dump(mode="json")
    for name in (
        "overall_score",
        "breakdown",
        "scoring_version",
        "scoring_config_hash",
        "benchmark_version",
        "game_version",
    ):
        legacy.pop(name)
    path = tmp_path / "legacy.json"
    path.write_text(json.dumps(legacy), encoding="utf-8")

    loaded = load_results(path)

    assert len(loaded) == 1
    assert loaded[0].overall_score == 75.0
    assert loaded[0].breakdown.success_score == 75.0
    assert loaded[0].scoring_version == "legacy"
