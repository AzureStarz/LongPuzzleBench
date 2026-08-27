import pytest

from mobile_world.benchmarks import (
    MetricConfig,
    MiniGameEvaluator,
    MiniGameTaskSpec,
    normalize_score,
)


def _task(metric_config: MetricConfig | None = None) -> MiniGameTaskSpec:
    return MiniGameTaskSpec(
        game_id="truck_escape_2",
        difficulty="easy",
        level_id=1,
        seed=0,
        instruction="Move the target vehicle to the exit.",
        max_steps=10,
        timeout_seconds=30,
        metric_config=metric_config or MetricConfig(),
    )


def _bolt_task() -> MiniGameTaskSpec:
    return MiniGameTaskSpec(
        game_id="bolt_unscrew",
        difficulty="easy",
        level_id=3,
        seed=0,
        instruction="Move screws into available holes.",
        max_steps=20,
        timeout_seconds=30,
    )


def _deadlock_state(**overrides):
    deadlock = {
        "is_deadlocked": True,
        "deadlock_reason": "no_available_hole",
        "available_hole_count": 0,
        "legal_progress_action_count": 0,
        "pending_operation_count": 0,
        "game_state_stable": True,
    }
    deadlock.update(overrides.pop("deadlock", {}))
    state = {
        "game_id": "bolt_unscrew",
        "difficulty": "easy",
        "level_id": 3,
        "seed": 0,
        "status": "running",
        "success": False,
        "failure": False,
        "deadlock": deadlock,
    }
    state.update(overrides)
    return state


def test_normalization_modes() -> None:
    assert normalize_score(99, success=False, config=MetricConfig(normalization="binary")) == 0
    assert normalize_score(0, success=True, config=MetricConfig(normalization="binary")) == 1
    assert normalize_score(
        15,
        success=False,
        config=MetricConfig(normalization="linear", minimum=10, maximum=20),
    ) == pytest.approx(0.5)
    assert normalize_score(
        15,
        success=False,
        config=MetricConfig(normalization="linear", minimum=10, maximum=20, higher_is_better=False),
    ) == pytest.approx(0.5)
    assert (
        normalize_score(
            120,
            success=True,
            config=MetricConfig(normalization="existing_score", normalized_score_field=None),
        )
        == 1.0
    )
    assert normalize_score(
        0,
        success=True,
        config=MetricConfig(normalization="existing_score"),
        state={"normalized_score": 0.8},
    ) == pytest.approx(0.8)


def test_evaluator_reads_nested_existing_metrics() -> None:
    config = MetricConfig(
        normalization="existing_score",
        score_field="raw_metrics.score.abilityScore",
        normalized_score_field=None,
        metrics_field="raw_metrics.metrics",
        invalid_actions_field="raw_metrics.metrics.invalidOperations",
    )
    result = MiniGameEvaluator().evaluate(
        {
            "status": "success",
            "success": True,
            "failure": False,
            "raw_metrics": {
                "score": {"abilityScore": 75.0},
                "metrics": {"acceptedMoves": 8, "invalidOperations": 2},
            },
        },
        _task(config),
        steps=10,
        elapsed=12.5,
        agent_information={"name": "vision-agent"},
    )

    assert result.task_success
    assert result.episode_status == "success"
    assert result.is_terminal
    assert result.game_score == 75
    assert result.normalized_score == pytest.approx(0.75)
    assert result.invalid_action_count == 2
    assert result.raw_metrics["acceptedMoves"] == 8
    assert result.raw_metrics["score"]["abilityScore"] == 75
    assert result.agent_information["name"] == "vision-agent"


def test_timeout_overrides_late_success_and_binary_score() -> None:
    result = MiniGameEvaluator().evaluate(
        {"success": True, "status": "success"},
        _task(),
        steps=2,
        elapsed=31,
    )

    assert not result.task_success
    assert result.timeout
    assert result.episode_status == "timeout"
    assert result.normalized_score == 0


def test_running_and_max_step_termination() -> None:
    evaluator = MiniGameEvaluator()
    running = evaluator.evaluate({"status": "running"}, _task(), steps=1, elapsed=1)
    exhausted = evaluator.evaluate({"status": "running"}, _task(), steps=10, elapsed=5)

    assert running.episode_status == "running"
    assert not running.is_terminal
    assert running.terminal_state == {}
    assert exhausted.episode_status == "max_steps"
    assert exhausted.max_step_reached
    assert exhausted.is_terminal


def test_state_identity_mismatch_is_environment_error() -> None:
    result = MiniGameEvaluator().evaluate(
        {
            "game_id": "truck_escape_2",
            "difficulty": "hard",
            "level_id": 1,
            "seed": 0,
            "status": "success",
            "success": True,
        },
        _task(),
        steps=1,
        elapsed=1,
    )

    assert result.episode_status == "error"
    assert not result.task_success
    assert "identity mismatch" in result.errors[0]


def test_steps_and_elapsed_can_be_read_from_bridge_state() -> None:
    result = MiniGameEvaluator().evaluate(
        {
            "status": "running",
            "step_count": 3,
            "elapsed_time_ms": 1250,
        },
        _task(),
    )

    assert result.step_count == 3
    assert result.elapsed_time_seconds == pytest.approx(1.25)


def test_no_progress_has_distinct_terminal_status() -> None:
    result = MiniGameEvaluator().evaluate(
        {"status": "running", "raw_metrics": {}},
        _task(),
        steps=6,
        elapsed=4,
        no_progress=True,
    )

    assert result.episode_status == "no_progress"
    assert result.is_terminal is True
    assert result.task_success is False
    assert result.raw_metrics["no_progress"] is True


@pytest.mark.parametrize(
    ("kwargs", "status", "reason"),
    [
        (
            {"repeated_action_cycle": True},
            "repeated_action_cycle",
            "repeated_action_cycle",
        ),
        (
            {"invalid_action_limit_reached": True},
            "invalid_action_limit",
            "invalid_action_limit",
        ),
        ({"agent_error": "model failed"}, "error", "agent_error"),
        ({"environment_error": "browser failed"}, "error", "environment_error"),
    ],
)
def test_explicit_termination_reasons(kwargs, status, reason) -> None:
    result = MiniGameEvaluator().evaluate(
        {"status": "running"}, _task(), steps=3, elapsed=2, **kwargs
    )

    assert result.episode_status == status
    assert result.termination_reason == reason
    assert result.task_success is False


def test_true_no_available_hole_deadlock_has_distinct_failure_reason() -> None:
    result = MiniGameEvaluator().evaluate(_deadlock_state(), _bolt_task(), steps=17, elapsed=4)

    assert result.episode_status == "no_available_hole_deadlock"
    assert result.termination_reason == "no_available_hole_deadlock"
    assert result.task_success is False
    assert result.deadlock["available_hole_count"] == 0
    assert result.deadlock["legal_progress_action_count"] == 0
    assert result.deadlock["pending_operation_count"] == 0
    assert result.deadlock["detected_at_step"] == 17


def test_selected_screw_does_not_delay_no_hole_deadlock() -> None:
    result = MiniGameEvaluator().evaluate(
        _deadlock_state(
            deadlock={
                "is_deadlocked": False,
                "deadlock_reason": None,
                "pending_operation_count": 1,
                "game_state_stable": False,
                "awaiting_operation_settlement": False,
            }
        ),
        _bolt_task(),
        steps=16,
        elapsed=4,
    )

    assert result.episode_status == "no_available_hole_deadlock"
    assert result.deadlock["is_deadlocked"] is True
    assert result.deadlock["pending_operation_count"] == 1


@pytest.mark.parametrize(
    "deadlock_override",
    [
        {"awaiting_operation_settlement": True, "game_state_stable": False},
        {"legal_progress_action_count": 1},
        {"available_hole_count": 1},
    ],
)
def test_temporary_or_recoverable_no_hole_state_is_not_deadlock(
    deadlock_override,
) -> None:
    result = MiniGameEvaluator().evaluate(
        _deadlock_state(deadlock=deadlock_override),
        _bolt_task(),
        steps=4,
        elapsed=2,
    )

    assert result.episode_status == "running"
    assert result.termination_reason is None
    assert result.deadlock["is_deadlocked"] is False


def test_agent_and_environment_errors_outrank_game_failure() -> None:
    evaluator = MiniGameEvaluator()
    agent = evaluator.evaluate(
        {"status": "failure", "failure": True},
        _task(),
        steps=1,
        elapsed=2,
        agent_error="Agent LLM failed",
    )
    environment = evaluator.evaluate(
        {"status": "failure", "failure": True},
        _task(),
        steps=1,
        elapsed=2,
        environment_error="browser failed",
    )

    assert agent.termination_reason == "agent_error"
    assert agent.episode_status == "error"
    assert environment.termination_reason == "environment_error"
    assert environment.episode_status == "error"


def test_timeout_outranks_in_game_failure_during_thinking() -> None:
    result = MiniGameEvaluator().evaluate(
        {"status": "failure", "failure": True},
        _task(),
        steps=1,
        elapsed=2,
        timeout=True,
        timeout_before_dispatch=True,
    )

    assert result.termination_reason == "timeout"
    assert result.episode_status == "timeout"
    assert result.timeout is True


def test_played_in_game_loss_stays_game_failure() -> None:
    result = MiniGameEvaluator().evaluate(
        {"status": "failure", "failure": True},
        _task(),
        steps=4,
        elapsed=8,
    )

    assert result.termination_reason == "game_failure"
    assert result.episode_status == "failure"
    assert result.timeout is False


def test_success_and_explicit_failure_take_priority_over_deadlock() -> None:
    success = MiniGameEvaluator().evaluate(
        _deadlock_state(status="success", success=True),
        _bolt_task(),
        steps=5,
        elapsed=2,
    )
    failure = MiniGameEvaluator().evaluate(
        _deadlock_state(status="failure", failure=True),
        _bolt_task(),
        steps=5,
        elapsed=2,
    )

    assert success.termination_reason == "success"
    assert success.task_success is True
    assert success.deadlock["is_deadlocked"] is False
    assert failure.termination_reason == "game_failure"
    assert failure.deadlock["is_deadlocked"] is False
