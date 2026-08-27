"""Authoritative white-box progress potentials P(s) for LongPuzzleBench scoring.

Each function reads only evaluator-side structured state.  Values are
deterministic in ``[0, 1]`` and are the sole inputs to failure
``progress_score`` components.  Diagnostic fields are returned alongside the
scalar so raw metrics can be audited without feeding every signal into the
composite level score.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any

from mobile_world.benchmarks.models import EpisodeResult, MiniGameTaskSpec


def _clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return max(minimum, min(maximum, value))


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _path(source: Mapping[str, Any], dotted_path: str) -> Any:
    value: Any = source
    for part in dotted_path.split("."):
        if not isinstance(value, Mapping) or part not in value:
            return None
        value = value[part]
    return value


def _first_number(sources: Sequence[Mapping[str, Any]], paths: Sequence[str]) -> float | None:
    for source in sources:
        for path in paths:
            number = _number(_path(source, path))
            if number is not None:
                return number
    return None


def _first_value(sources: Sequence[Mapping[str, Any]], paths: Sequence[str]) -> Any:
    for source in sources:
        for path in paths:
            value = _path(source, path)
            if value is not None:
                return value
    return None


def _sources(result: EpisodeResult) -> tuple[Mapping[str, Any], ...]:
    return (result.raw_metrics, result.terminal_state, result.runtime)


def _ratio(numerator: float | None, denominator: float | None) -> float:
    if numerator is None or denominator is None or denominator <= 0:
        return 0.0
    return _clamp(numerator / denominator)


# Released-but-not-exited boards are irreversible progress toward clearance,
# yet strictly weaker than a confirmed exit.  Half credit keeps P(s) monotone
# in exits while still separating "loosened the board" from "no progress".
_BOLT_RELEASED_WEIGHT = 0.5


def bolt_unscrew_progress(
    result: EpisodeResult,
) -> tuple[float, dict[str, float]]:
    """Board-clearance potential from exited and unsupported boards.

    ``P = (exited + 0.5 * released_not_exited) / boards_total``

    Released boards are those whose authoritative ``supportCount`` is zero while
    the board node is still alive.  Without support metadata the metric falls
    back to ``exited / total``.
    """

    sources = _sources(result)
    boards_total = _first_number(sources, ("boards_total", "raw_metrics.boards_total"))
    boards_exited = _first_number(sources, ("boards_exited", "raw_metrics.boards_exited"))
    boards = _first_value(
        sources,
        (
            "boards",
            "raw_game_state.boards",
            "terminal_state.raw_game_state.boards",
        ),
    )
    released = _first_number(
        sources,
        (
            "boards_released",
            "raw_metrics.boards_released",
        ),
    )
    supported_remaining = _first_number(
        sources,
        (
            "boards_supported_remaining",
            "raw_metrics.boards_supported_remaining",
        ),
    )
    if isinstance(boards, Sequence) and not isinstance(boards, (str, bytes)):
        exited_count = 0
        released_count = 0
        supported_count = 0
        for board in boards:
            if not isinstance(board, Mapping):
                continue
            exited = bool(board.get("exited")) or board.get("isValid") is False
            if exited:
                exited_count += 1
                continue
            support = _number(board.get("supportCount"))
            if board.get("released") is True or support == 0.0:
                released_count += 1
            else:
                supported_count += 1
        # The snapshot only lists boards that are still alive, so a cleared
        # board leaves it entirely and cannot be counted from there.  Taking the
        # larger exit count keeps both sources usable: snapshots that still
        # carry exited nodes stay authoritative, and aggregates that lag or were
        # zeroed on older runs cannot drag a real exit back to zero.
        boards_exited = max(float(exited_count), boards_exited or 0.0)
        released = float(released_count)
        supported_remaining = float(supported_count)
        boards_total = max(
            boards_total or 0.0,
            boards_exited + released + supported_remaining,
        )
    boards_total = boards_total or 0.0
    boards_exited = boards_exited or 0.0
    released = released or 0.0
    supported_remaining = (
        supported_remaining
        if supported_remaining is not None
        else max(0.0, boards_total - boards_exited - released)
    )
    if result.task_success:
        progress = 1.0
    else:
        progress = _ratio(
            boards_exited + _BOLT_RELEASED_WEIGHT * released,
            boards_total,
        )
    diagnostics = {
        "boards_total": boards_total,
        "boards_exited": boards_exited,
        "boards_released": released,
        "boards_supported_remaining": supported_remaining,
        "board_exit_ratio": _ratio(boards_exited, boards_total),
        "board_release_ratio": _ratio(released, boards_total),
        "progress": progress,
    }
    return progress, diagnostics


def rush_hour_2_progress(
    result: EpisodeResult,
) -> tuple[float, dict[str, float]]:
    """Solver-backed progress ratio from Truck Escape 2 attempt state.

    Final-state ``progressRatio`` is preferred over peak progress so temporary
    advances that were later undone do not inflate the episode score.
    """

    sources = _sources(result)
    progress_value = _first_number(
        sources,
        (
            "currentProgressRatio",
            "metrics.currentProgressRatio",
            "final_progress.progressRatio",
            "raw_metrics.metrics.currentProgressRatio",
            "raw_metrics.final_progress.progressRatio",
        ),
    )
    progress = 1.0 if result.task_success else _clamp(progress_value or 0.0)
    exact_remaining = _first_number(
        sources,
        (
            "exactMovesRemaining",
            "final_progress.exactMovesRemaining",
            "metrics.exactMovesRemaining",
            "raw_metrics.final_progress.exactMovesRemaining",
        ),
    )
    estimated_remaining = _first_number(
        sources,
        (
            "estimatedMovesRemaining",
            "final_progress.estimatedMovesRemaining",
            "raw_metrics.final_progress.estimatedMovesRemaining",
        ),
    )
    blockers = _first_number(
        sources,
        (
            "directBlockerCount",
            "final_progress.directBlockerCount",
            "metrics.directBlockerCount",
            "raw_metrics.final_progress.directBlockerCount",
        ),
    )
    peak = _first_number(
        sources,
        (
            "maxProgressRatio",
            "metrics.maxProgressRatio",
            "raw_metrics.metrics.maxProgressRatio",
        ),
    )
    regressions = _first_number(
        sources,
        (
            "progressRegressions",
            "metrics.progressRegressions",
            "raw_metrics.metrics.progressRegressions",
        ),
    )
    diagnostics = {
        "progress": progress,
        "exact_moves_remaining": exact_remaining or 0.0,
        "estimated_moves_remaining": estimated_remaining or 0.0,
        "direct_blocker_count": blockers or 0.0,
        "max_progress_ratio": peak or 0.0,
        "progress_regressions": regressions or 0.0,
    }
    return progress, diagnostics


def nut_and_bolt_progress(
    result: EpisodeResult,
) -> tuple[float, dict[str, float]]:
    """Homogeneous nut-placement potential over conserved color groups.

    ``P = sum_c max_b homogeneous_count(b, c) / (capacity * distinct_color_groups)``

    Only fully homogeneous bolts contribute, and each color keeps only its best
    bolt so splitting one color across multiple bolts cannot inflate P to 1.
    Empty bolts are temporary storage.  Mixed bolts contribute zero.  Completed
    full groups remain available as a diagnostic but are not double-counted into
    a second weighted term.
    """

    sources = _sources(result)
    bolts = _first_value(
        sources,
        (
            "bolts",
            "raw_game_state.bolts",
            "terminal_state.raw_game_state.bolts",
        ),
    )
    capacity = _first_number(
        sources,
        (
            "capacity",
            "raw_game_state.capacity",
            "terminal_state.raw_game_state.capacity",
        ),
    )
    colors: set[str] = set()
    completed_full = 0
    best_by_color: dict[str, int] = {}
    mixed_bolts = 0
    empty_bolts = 0
    if isinstance(bolts, Sequence) and not isinstance(bolts, (str, bytes)):
        for bolt in bolts:
            if not isinstance(bolt, Mapping):
                continue
            nuts = bolt.get("nuts")
            if not isinstance(nuts, Sequence) or isinstance(nuts, (str, bytes)):
                continue
            nut_colors = [str(item) for item in nuts]
            if not nut_colors:
                empty_bolts += 1
                continue
            colors.update(nut_colors)
            remaining = _number(bolt.get("remaining"))
            is_full = (
                remaining == 0.0
                if remaining is not None
                else (capacity is not None and len(nut_colors) == int(capacity))
            )
            homogeneous = all(color == nut_colors[0] for color in nut_colors)
            if homogeneous:
                color = nut_colors[0]
                best_by_color[color] = max(best_by_color.get(color, 0), len(nut_colors))
                if is_full:
                    completed_full += 1
            else:
                mixed_bolts += 1

    explicit_groups = _first_number(
        sources,
        (
            "distinct_color_groups",
            "color_group_count",
            "raw_metrics.distinct_color_groups",
        ),
    )
    total_groups = explicit_groups if explicit_groups is not None else float(len(colors))
    homogeneous_nuts = float(sum(best_by_color.values()))
    if capacity is None or capacity <= 0:
        # Without capacity the only reliable irreversible signal is completed
        # full homogeneous bolts over color groups.
        progress = 1.0 if result.task_success else _ratio(float(completed_full), total_groups)
        denominator = total_groups
        placed = float(completed_full)
    else:
        denominator = capacity * total_groups if total_groups > 0 else 0.0
        placed = homogeneous_nuts
        progress = 1.0 if result.task_success else _ratio(placed, denominator)

    diagnostics = {
        "progress": progress,
        "homogeneous_nuts": homogeneous_nuts,
        "completed_homogeneous_full_bolts": float(completed_full),
        "distinct_color_groups": float(total_groups or 0.0),
        "capacity": float(capacity or 0.0),
        "mixed_bolts": float(mixed_bolts),
        "empty_bolts": float(empty_bolts),
        "placement_denominator": float(denominator or 0.0),
    }
    return progress, diagnostics


def truck_escape_progress(
    result: EpisodeResult,
) -> tuple[float, dict[str, float]]:
    """Irreversible vehicle-clearance progress for the original truck game.

    ``P = trucks_removed / trucks_total``
    """

    sources = _sources(result)
    total = (
        _first_number(
            sources,
            ("trucks_total", "raw_metrics.trucks_total"),
        )
        or 0.0
    )
    removed = (
        _first_number(
            sources,
            ("trucks_removed", "raw_metrics.trucks_removed"),
        )
        or 0.0
    )
    progress = 1.0 if result.task_success else _ratio(removed, total)
    return progress, {
        "progress": progress,
        "trucks_total": total,
        "trucks_removed": removed,
        "trucks_remaining": max(0.0, total - removed),
        "truck_clearance_ratio": _ratio(removed, total),
    }


def maze_paint_progress(
    result: EpisodeResult,
) -> tuple[float, dict[str, float]]:
    """Paint coverage above the mandatory initially-painted start cell.

    ``P = (painted_cells - 1) / (paintable_cells - 1)``

    Subtracting the start cell makes an untouched level score zero. Painting is
    irreversible, so the potential cannot be inflated by loops or regressions.
    """

    sources = _sources(result)
    total = (
        _first_number(
            sources,
            (
                "total_paintable_cells",
                "board.total_paintable_cells",
                "raw_metrics.total_paintable_cells",
            ),
        )
        or 0.0
    )
    painted = (
        _first_number(
            sources,
            (
                "painted_cell_count",
                "board.painted_cell_count",
                "raw_metrics.painted_cell_count",
            ),
        )
        or 0.0
    )
    remaining = _first_number(
        sources,
        (
            "remaining_unpainted_cells",
            "board.remaining_unpainted_cells",
            "raw_metrics.remaining_unpainted_cells",
        ),
    )
    baseline = 1.0 if total > 0 else 0.0
    progress = (
        1.0
        if result.task_success
        else _ratio(max(0.0, painted - baseline), max(0.0, total - baseline))
    )
    return progress, {
        "progress": progress,
        "total_paintable_cells": total,
        "painted_cell_count": painted,
        "remaining_unpainted_cells": (
            max(0.0, total - painted) if remaining is None else max(0.0, remaining)
        ),
        "coverage_ratio": _ratio(painted, total),
        "initial_painted_cells": baseline,
    }


def color_connect_progress(
    result: EpisodeResult,
) -> tuple[float, dict[str, float]]:
    """Final-state completed-pair ratio for Color Connect.

    Only authoritative completed paths contribute. Active/incomplete path
    length is retained as diagnostics by the game but excluded here because it
    can be increased without getting closer to a legal connection.
    """

    sources = _sources(result)
    total = (
        _first_number(
            sources,
            (
                "total_color_pairs",
                "board.total_color_pairs",
                "raw_metrics.total_color_pairs",
            ),
        )
        or 0.0
    )
    completed = (
        _first_number(
            sources,
            (
                "completed_color_pairs",
                "board.completed_color_pairs",
                "raw_metrics.completed_color_pairs",
            ),
        )
        or 0.0
    )
    occupied = (
        _first_number(
            sources,
            (
                "occupied_path_cells",
                "board.occupied_path_cells",
                "raw_metrics.occupied_path_cells",
            ),
        )
        or 0.0
    )
    playable = (
        _first_number(
            sources,
            (
                "total_playable_cells",
                "board.total_playable_cells",
                "raw_metrics.total_playable_cells",
            ),
        )
        or 0.0
    )
    progress = 1.0 if result.task_success else _ratio(completed, total)
    return progress, {
        "progress": progress,
        "total_color_pairs": total,
        "completed_color_pairs": completed,
        "remaining_color_pairs": max(0.0, total - completed),
        "pair_completion_ratio": _ratio(completed, total),
        "occupied_path_cells": occupied,
        "total_playable_cells": playable,
        "path_coverage_ratio": _ratio(occupied, playable),
    }


_GAME_ID_ALIASES = {
    "truck_escape_2": "rush_hour_2",
    "nuts_bolts": "nut_and_bolt",
}

_SUCCESS_STATUSES = frozenset({"success", "completed", "complete", "won"})

ProgressFn = Callable[[EpisodeResult], tuple[float, dict[str, float]]]

LEVEL_PROGRESS_FUNCTIONS: dict[str, ProgressFn] = {
    "bolt_unscrew": bolt_unscrew_progress,
    "rush_hour_2": rush_hour_2_progress,
    "nut_and_bolt": nut_and_bolt_progress,
    "truck_escape": truck_escape_progress,
    "maze_paint": maze_paint_progress,
    "color_connect": color_connect_progress,
}


def canonical_progress_game_id(game_id: str) -> str:
    """Return the progress-function game id, including catalogue aliases."""

    return _GAME_ID_ALIASES.get(game_id, game_id)


def _evaluator_state_succeeded(state: Mapping[str, Any]) -> bool:
    if state.get("success") is True:
        return True
    status = str(state.get("status") or "").strip().lower()
    return status in _SUCCESS_STATUSES


def _episode_view_from_state(game_id: str, state: Mapping[str, Any]) -> EpisodeResult:
    raw_metrics = state.get("raw_metrics")
    if not isinstance(raw_metrics, Mapping):
        raw_metrics = {}
    success = _evaluator_state_succeeded(state)
    task = MiniGameTaskSpec(
        game_id=canonical_progress_game_id(game_id),
        difficulty="easy",
        level_id=1,
        instruction="Evaluate level progress.",
        max_steps=1,
        timeout_seconds=1,
    )
    return EpisodeResult(
        task=task,
        seed=0,
        instruction=task.instruction,
        task_success=success,
        game_score=float(success),
        normalized_score=float(success),
        step_count=0,
        elapsed_time_seconds=0.0,
        is_terminal=bool(state.get("terminal") or success or state.get("failure")),
        episode_status="success" if success else "running",
        raw_metrics=dict(raw_metrics),
        terminal_state=dict(state),
    )


def level_progress_from_state(
    game_id: str,
    state: Mapping[str, Any],
) -> tuple[float, dict[str, float]]:
    """Score a live evaluator state with the same P(s) used for episode scoring.

    No-progress termination uses this scalar: only a strictly larger value
    counts as the level getting better.  Board identity, accepted-move
    counters and incomplete-path length stay in diagnostics and do not
    move the score by themselves.
    """

    canonical = canonical_progress_game_id(game_id)
    progress_fn = LEVEL_PROGRESS_FUNCTIONS.get(canonical)
    if progress_fn is None:
        success = _evaluator_state_succeeded(state)
        score = 1.0 if success else 0.0
        return score, {"progress": score}
    return progress_fn(_episode_view_from_state(canonical, state))
