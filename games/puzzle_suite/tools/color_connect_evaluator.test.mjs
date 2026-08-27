import assert from 'node:assert/strict';
import { parseColorConnectLevel } from '../assets/scripts/color_connect/ColorConnectRules.ts';
import { ColorConnectEvaluator } from '../assets/scripts/color_connect/ColorConnectEvaluator.ts';
import { scoreColorConnect } from '../assets/scripts/color_connect/ColorConnectScorer.ts';

function level(id = 'evaluator', rows = 3, columns = 4) {
    const pairs = rows >= 3
        ? [['red', 0, 0, 0, columns - 1], ['green', rows - 1, 0, rows - 1, columns - 1]]
        : [['red', 0, 0, 0, columns - 1], ['green', 1, 0, 1, columns - 1]];
    return parseColorConnectLevel(Object.freeze({
        id,
        difficulty: 'easy',
        levelNumber: 1,
        rows,
        columns,
        blockedCells: Object.freeze([]),
        colorPairs: Object.freeze(pairs.map(([colorId, sr, sc, er, ec], index) => Object.freeze({
            colorId,
            start: Object.freeze({ row: sr, column: sc }),
            end: Object.freeze({ row: er, column: ec }),
            displayColor: index === 0 ? '#ff0000' : '#00ff00',
        }))),
        requireFullCoverage: false,
        screenshot: `test/${id}.png`,
        sourceTitle: id,
        sourceScreenshotTitle: id,
    }));
}

function options(overrides = {}) {
    return Object.freeze({
        maxSteps: 100,
        noProgressGestureLimit: 100,
        timeoutMs: 100_000,
        cycleFailureRepetitions: 100,
        referenceTotalPathLength: null,
        ...overrides,
    });
}

function gesture(evaluator, cells, startedAtMs, endedAtMs = startedAtMs + 10) {
    evaluator.beginGesture(cells[0], startedAtMs);
    for (const cell of cells.slice(1)) evaluator.extendGesture(cell, startedAtMs + 1);
    return evaluator.endGesture(endedAtMs);
}

const red = [
    { row: 0, column: 0 }, { row: 0, column: 1 },
    { row: 0, column: 2 }, { row: 0, column: 3 },
];
const green = [
    { row: 2, column: 0 }, { row: 2, column: 1 },
    { row: 2, column: 2 }, { row: 2, column: 3 },
];

function assertInitialStateAndZeroDenominators() {
    const evaluator = new ColorConnectEvaluator(level('initial'), 1_000, options());
    const state = evaluator.snapshot(1_000);
    assert.equal(state.game_id, 'color_connect');
    assert.equal(state.difficulty, 'easy');
    assert.equal(state.level, 1);
    assert.equal(state.level_id, 'initial');
    assert.equal(state.status, 'running');
    assert.equal(evaluator.status, 'running');
    assert.equal(evaluator.terminal, false);
    assert.equal(state.success, false);
    assert.equal(state.failure, false);
    assert.equal(state.termination_reason, null);
    assert.equal(state.total_color_pairs, 2);
    assert.equal(state.completed_color_pairs, 0);
    assert.equal(state.remaining_color_pairs, 2);
    assert.equal(state.pair_completion_ratio, 0);
    assert.equal(state.total_playable_cells, 12);
    assert.equal(state.occupied_path_cells, 0);
    assert.equal(state.coverage_ratio, 0);
    assert.equal(state.require_full_coverage, false);
    assert.equal(state.elapsed_time_ms, 0);
    assert.equal(state.gesture_count, 0);
    assert.equal(state.completed_connection_count, 0);
    assert.equal(state.incomplete_drag_count, 0);
    assert.equal(state.path_cancel_count, 0);
    assert.equal(state.path_backtrack_count, 0);
    assert.equal(state.restart_count, 0);
    assert.equal(state.actions.valid_action_ratio, 0);
    assert.equal(state.actions.invalid_action_ratio, 0);
    assert.equal(state.efficiency.gestures_per_completed_pair, 0);
    assert.equal(state.efficiency.invalid_gestures_per_pair, 0);
    assert.equal(state.efficiency.time_per_completed_pair, 0);
    assert.equal(state.efficiency.reference_path_efficiency, null);
    assert.equal(state.efficiency.path_length_efficiency, null);
    assert.equal(state.progress.best_progress, 0);
    assert.equal(state.state_analysis.unique_state_count, 1);
    assert.equal(state.state_analysis.revisited_state_count, 0);
    assert.equal(state.state_analysis.cycle_detected, false);
    assert.equal(state.state_hash.includes('0,0'), false, 'an empty state hash contains no endpoint list');
    assert.equal(state.paths.length, 2);
    assert.strictEqual(state.per_colors, state.paths);
    assert.deepEqual(state.trajectory, []);
}

function assertGestureDefinitionsViolationsAndTrajectory() {
    const evaluator = new ColorConnectEvaluator(level('gestures'), 0, options());
    gesture(evaluator, [{ row: 1, column: 1 }], 10, 20); // non-endpoint
    gesture(evaluator, [{ row: 0, column: 0 }, { row: 0, column: 1 }], 30, 50); // incomplete
    const afterInvalid = evaluator.snapshot(60);
    assert.equal(afterInvalid.gesture_count, 2);
    assert.equal(afterInvalid.valid_gesture_count, 0);
    assert.equal(afterInvalid.invalid_gesture_count, 2);
    assert.equal(afterInvalid.actions.invalid_action_ratio, 1);
    assert.equal(afterInvalid.actions.incomplete_drag_count, 1);
    assert.equal(afterInvalid.violations.start_from_non_endpoint_count, 1);
    assert.equal(afterInvalid.violations.released_before_connection_count, 1);
    assert.equal(afterInvalid.trajectory.length, 2);
    assert.equal(afterInvalid.trajectory[0].valid, false);
    assert.equal(afterInvalid.trajectory[1].duration_ms, 20);
    assert.equal(afterInvalid.timing.total_gesture_duration_ms, 30);
    assert.equal(afterInvalid.timing.mean_gesture_duration_ms, 15);

    evaluator.beginGesture(red[0], 100);
    evaluator.extendGesture(red[1], 101);
    evaluator.extendGesture({ row: 1, column: 1 }, 102);
    const backtrack = evaluator.extendGesture(red[1], 103);
    assert.equal(backtrack.backtrackedCellCount, 1);
    evaluator.extendGesture(red[2], 104);
    evaluator.extendGesture(red[3], 105);
    evaluator.endGesture(110);
    const connected = evaluator.snapshot(120);
    assert.equal(connected.completed_color_pairs, 1);
    assert.equal(connected.pair_completion_ratio, 0.5);
    assert.equal(connected.actions.path_backtrack_count, 1);
    assert.equal(connected.actions.backtracked_cell_count, 1);
    assert.equal(connected.actions.completed_connection_count, 1);
    assert.equal(connected.completed_connection_count, 1);
    assert.equal(connected.path_backtrack_count, 1);
    assert.equal(connected.valid_gesture_count, 1);
    assert.equal(connected.invalid_gesture_count, 2);
    assert.equal(connected.actions.valid_action_ratio, 0.3333);
    assert.equal(connected.progress.best_progress, 0.5);
    assert.equal(connected.progress.actions_since_last_progress, 0);
    assert.equal(connected.paths.find(path => path.color_id === 'red').final_path_length, 4);
    assert.equal(connected.trajectory[2].completed_pair_delta, 1);
    assert.equal(connected.trajectory[2].occupied_cell_delta, 4);
    assert.equal(connected.trajectory[2].progress_delta, 0.5);
    assert.throws(() => connected.trajectory.push({}), TypeError);
    assert.throws(() => connected.trajectory[2].sampled_cells.push({ row: 9, column: 9 }), TypeError);
}

function assertWaypointClicksFillStraightSegmentsAndRejectDiagonals() {
    const evaluator = new ColorConnectEvaluator(level('waypoint-clicks'), 0, options());
    evaluator.beginGesture(red[0], 10);

    const diagonal = evaluator.extendGesture({ row: 1, column: 1 }, 11);
    assert.equal(diagonal.valid, false);
    assert.equal(diagonal.violation, 'non_adjacent_jump_attempt');
    assert.deepEqual(evaluator.state.activePath, [red[0]]);

    const filled = evaluator.extendGesture(red[3], 12);
    assert.equal(filled.valid, true);
    assert.equal(filled.completedColorId, 'red');
    assert.deepEqual(filled.enteredCells, [red[1], red[2], red[3]]);
    evaluator.endGesture(13);

    const snapshot = evaluator.snapshot(14);
    assert.equal(snapshot.completed_color_pairs, 1);
    assert.equal(snapshot.gesture_count, 1);
    assert.deepEqual(snapshot.paths.find(path => path.color_id === 'red').final_path_length, 4);
}

function assertOverlapCancellationProgressAndStateAnalysis() {
    const evaluator = new ColorConnectEvaluator(level('cancel-progress'), 0, options());
    gesture(evaluator, red, 0, 10);

    evaluator.beginGesture(green[0], 20);
    evaluator.extendGesture(green[1], 21);
    const overlap = evaluator.extendGesture({ row: 0, column: 1 }, 22);
    assert.equal(overlap.valid, false);
    assert.equal(overlap.violation, 'path_overlap_attempt');
    evaluator.endGesture(30);
    const collided = evaluator.snapshot(30);
    assert.equal(collided.violations.overlap_attempt_count, 1);
    assert.equal(collided.violations.overlap_attempt_rate, 0.5);
    assert.equal(collided.completed_color_pairs, 1);
    assert.equal(collided.invalid_gesture_count, 1, 'an unfinished collision gesture has no durable state change');

    evaluator.beginGesture(red[3], 40);
    evaluator.endGesture(45);
    const cancelled = evaluator.snapshot(50);
    assert.equal(cancelled.completed_color_pairs, 0);
    assert.equal(cancelled.actions.path_cancel_count, 1);
    assert.equal(cancelled.path_cancel_count, 1);
    assert.equal(cancelled.actions.completed_path_reopen_count, 1);
    assert.equal(cancelled.progress.best_progress, 0.5, 'best progress is monotonic');
    assert.equal(cancelled.progress.progress_regression_count, 1);
    assert.equal(cancelled.progress.completed_pair_delta, -1);
    assert.equal(cancelled.progress.actions_since_last_progress, 2);
    assert.equal(cancelled.paths.find(path => path.color_id === 'red').cancel_count, 1);
    assert.equal(cancelled.occupied_path_cells, 0);
    assert.equal(cancelled.valid_gesture_count, 2);
    assert.equal(cancelled.invalid_gesture_count, 1);
    assert.equal(cancelled.state_analysis.revisited_state_count, 2, 'collision revisits red, then cancellation revisits initial state');
}

function assertStableHashesRepeatedGesturesAndCycleTermination() {
    const game = level('cycles');
    const repeated = new ColorConnectEvaluator(game, 0, options());
    for (let index = 0; index < 3; index++) gesture(repeated, [{ row: 1, column: 1 }], index * 10, index * 10 + 1);
    const repeatState = repeated.snapshot(40);
    assert.equal(repeatState.actions.repeated_gesture_count, 2);
    assert.equal(repeatState.state_analysis.repeated_gesture_count, 2);
    assert.equal(repeatState.state_analysis.unique_state_count, 1);
    assert.equal(repeatState.state_analysis.revisited_state_count, 3);
    assert.equal(repeatState.state_analysis.state_revisit_ratio, 1);
    assert.equal(repeatState.state_analysis.cycle_detected, true);
    assert.equal(repeatState.state_analysis.cycle_length, 1);
    assert.ok(repeatState.state_analysis.cycle_repetitions >= 3);

    const cycle = new ColorConnectEvaluator(game, 0, options({ cycleFailureRepetitions: 4 }));
    for (let index = 0; index < 3; index++) {
        gesture(cycle, [{ row: 1, column: 1 }], index, index);
    }
    assert.equal(
        cycle.snapshot(3).status,
        'running',
        'the initial state must not count as one of four repeated action cycles',
    );
    gesture(cycle, [{ row: 1, column: 1 }], 3, 3);
    const cycleState = cycle.snapshot(10);
    assert.equal(cycleState.failure, true);
    assert.equal(cycleState.status, 'failure');
    assert.equal(cycleState.termination_reason, 'repeated_action_cycle');
    assert.equal(cycleState.state_analysis.cycle_detected_ever, true);
}

function assertSuccessReferenceEfficiencyAndTerminalGuard() {
    const game = level('success', 2, 4);
    const evaluator = new ColorConnectEvaluator(game, 100, options({ referenceTotalPathLength: 8 }));
    gesture(evaluator, red, 110, 120);
    const secondRow = green.map(cell => ({ row: 1, column: cell.column }));
    evaluator.beginGesture(secondRow[0], 130);
    evaluator.extendGesture(secondRow[1], 131);
    evaluator.extendGesture(secondRow[2], 132);
    evaluator.extendGesture(secondRow[3], 133);
    assert.equal(evaluator.status, 'success', 'the last endpoint updates success immediately');
    evaluator.endGesture(140);
    const state = evaluator.snapshot(10_000);
    assert.equal(state.success, true);
    assert.equal(state.failure, false);
    assert.equal(state.termination_reason, 'success');
    assert.equal(state.completed_color_pairs, 2);
    assert.equal(state.pair_completion_ratio, 1);
    assert.equal(state.coverage_ratio, 1);
    assert.equal(state.efficiency.reference_total_path_length, 8);
    assert.equal(state.efficiency.actual_total_path_length, 8);
    assert.equal(state.efficiency.extra_path_length, 0);
    assert.equal(state.efficiency.reference_path_efficiency, 1);
    assert.equal(state.efficiency.path_length_efficiency, null);
    assert.ok(state.score >= 70);
    assert.equal(state.elapsed_time_ms, 33, 'terminal time freezes when the last endpoint is entered');
    assert.equal(evaluator.terminal, true);

    const beforeCount = state.gesture_count;
    const rejected = evaluator.beginGesture(red[0], 20_000);
    assert.equal(rejected.violation, 'game_already_complete');
    assert.equal(evaluator.snapshot(30_000).gesture_count, beforeCount, 'terminal input is not added to trajectory');
}

function assertFailureReasonsRestartAndScoringBounds() {
    const game = level('failure');
    const maxSteps = new ColorConnectEvaluator(game, 0, options({ maxSteps: 1 }));
    gesture(maxSteps, [{ row: 1, column: 1 }], 0, 1);
    assert.equal(maxSteps.snapshot(1).termination_reason, 'max_steps');

    const noProgress = new ColorConnectEvaluator(game, 0, options({ noProgressGestureLimit: 1 }));
    gesture(noProgress, [{ row: 1, column: 1 }], 0, 1);
    assert.equal(noProgress.snapshot(1).termination_reason, 'no_progress');

    const timeout = new ColorConnectEvaluator(game, 1_000, options({ timeoutMs: 500 }));
    assert.equal(timeout.snapshot(1_499).status, 'running');
    assert.equal(timeout.snapshot(1_500).termination_reason, 'timeout');
    assert.equal(timeout.snapshot(9_999).elapsed_time_ms, 500);

    for (const reason of ['environment_error', 'max_steps', 'no_progress', 'timeout']) {
        const terminated = new ColorConnectEvaluator(game, 10, options());
        terminated.terminate(reason, 25);
        assert.equal(terminated.snapshot(1_000).termination_reason, reason);
    }

    const restarted = new ColorConnectEvaluator(game, 0, options());
    gesture(restarted, red, 0, 10);
    restarted.restart(100);
    const reset = restarted.snapshot(100);
    assert.equal(reset.actions.restart_count, 1);
    assert.equal(reset.restart_count, 1);
    assert.equal(reset.gesture_count, 0);
    assert.equal(reset.completed_color_pairs, 0);
    assert.equal(reset.actions.completed_connection_count, 0);
    assert.equal(reset.state_analysis.unique_state_count, 1);
    assert.deepEqual(reset.trajectory, []);
    assert.equal(reset.elapsed_time_ms, 0);

    const worstSuccess = scoreColorConnect({
        success: true, pairCompletionRatio: 1, bestProgress: 1, validActionRatio: 0,
        invalidActionRatio: 1, overlapAttemptRate: 1, pathLengthEfficiency: 0,
        actionsSinceLastProgress: 999, stateRevisitRatio: 1,
    });
    const bestFailure = scoreColorConnect({
        success: false, pairCompletionRatio: 1, bestProgress: 1, validActionRatio: 1,
        invalidActionRatio: 0, overlapAttemptRate: 0, pathLengthEfficiency: 1,
        actionsSinceLastProgress: 0, stateRevisitRatio: 0,
    });
    assert.equal(worstSuccess, 70);
    assert.equal(bestFailure, 69.999);
    assert.ok(worstSuccess > bestFailure);
    for (const sample of [
        { success: false, pairCompletionRatio: -9, bestProgress: Infinity, validActionRatio: NaN, invalidActionRatio: 8, overlapAttemptRate: -1, pathLengthEfficiency: null, actionsSinceLastProgress: -3, stateRevisitRatio: 99 },
        { success: true, pairCompletionRatio: 99, bestProgress: 99, validActionRatio: 99, invalidActionRatio: -4, overlapAttemptRate: -2, pathLengthEfficiency: 99, actionsSinceLastProgress: 0, stateRevisitRatio: -1 },
    ]) {
        const score = scoreColorConnect(sample);
        assert.equal(Number.isFinite(score), true);
        assert.ok(score >= 0 && score <= 100);
    }
}

assertInitialStateAndZeroDenominators();
assertGestureDefinitionsViolationsAndTrajectory();
assertWaypointClicksFillStraightSegmentsAndRejectDiagonals();
assertOverlapCancellationProgressAndStateAnalysis();
assertStableHashesRepeatedGesturesAndCycleTermination();
assertSuccessReferenceEfficiencyAndTerminalGuard();
assertFailureReasonsRestartAndScoringBounds();

console.log('Color Connect evaluator, metrics, cycles, timing, restart, and scoring passed.');
