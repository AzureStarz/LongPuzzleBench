import assert from 'node:assert/strict';
import {
    computeMazePaintMove,
    createInitialMazePaintState,
    hashMazePaintState,
    parseMazePaintLevel,
} from '../assets/scripts/maze_paint/MazePaintRules.ts';
import { MazePaintEvaluator } from '../assets/scripts/maze_paint/MazePaintEvaluator.ts';
import { scoreMazePaint } from '../assets/scripts/maze_paint/MazePaintScorer.ts';

function level(id, layout, optimalMoveCount = 1) {
    return parseMazePaintLevel(Object.freeze({
        id,
        difficulty: 'easy',
        levelNumber: 1,
        layout: Object.freeze([...layout]),
        optimalMoveCount,
        screenshot: `test/${id}.png`,
    }));
}

function options(overrides = {}) {
    return Object.freeze({
        maxSteps: 100,
        noProgressMoveLimit: 100,
        timeoutMs: 100_000,
        cycleFailureRepetitions: 100,
        ...overrides,
    });
}

function assertInitialSnapshotAndZeroDenominators() {
    const maze = level('initial', ['S..', '#.#'], Number.POSITIVE_INFINITY);
    const evaluator = new MazePaintEvaluator(maze, 1_000, options());
    const state = evaluator.snapshot(1_000);

    assert.equal(state.game_id, 'maze_paint');
    assert.equal(state.difficulty, 'easy');
    assert.equal(state.level, 1);
    assert.equal(state.level_id, 'initial');
    assert.equal(state.status, 'running');
    assert.equal(state.success, false);
    assert.equal(state.failure, false);
    assert.equal(state.termination_reason, null);
    assert.deepEqual(state.ball_position, { row: 0, column: 0 });
    assert.equal(state.total_paintable_cells, 4);
    assert.equal(state.painted_cell_count, 1);
    assert.equal(state.remaining_unpainted_cells, 3);
    assert.equal(state.coverage_ratio, 0.25);
    assert.equal(state.move_count, 0);
    assert.equal(state.valid_move_count, 0);
    assert.equal(state.invalid_move_count, 0);
    assert.equal(state.elapsed_time_ms, 0);
    assert.equal(state.optimal_move_count, null);
    assert.equal(state.ball.is_moving, false);
    assert.equal(state.actions.valid_move_ratio, 0);
    assert.equal(state.actions.invalid_move_ratio, 0);
    assert.equal(state.actions.productive_move_ratio, 0);
    assert.equal(state.actions.redundant_move_ratio, 0);
    assert.equal(state.efficiency.mean_new_cells_per_valid_move, 0);
    assert.equal(state.efficiency.painted_cells_per_move, 0);
    assert.equal(state.efficiency.move_efficiency, 0);
    assert.equal(state.traversal.new_cell_traversal_ratio, 0);
    assert.equal(state.traversal.repainted_cell_traversal_ratio, 0);
    assert.equal(state.state_analysis.unique_state_count, 1);
    assert.equal(state.state_analysis.revisited_state_count, 0);
    assert.equal(state.state_analysis.state_revisit_ratio, 0);
    assert.equal(state.progress.moves_since_last_progress, 0);
    assert.equal(state.progress.best_coverage_ratio, 0.25);
    assert.equal(state.timing.mean_move_duration_ms, 0);
    assert.deepEqual(state.trajectory, []);

    const moving = evaluator.snapshot(1_010, true);
    assert.equal(moving.ball.is_moving, true);
    assert.equal(moving.elapsed_time_ms, 10);
}

function assertCoverageRatiosStateAnalysisAndTiming() {
    const maze = level('metrics', ['S..', '#.#'], 5);
    const evaluator = new MazePaintEvaluator(maze, 1_000, options());
    evaluator.applyDirection('up', 1_100, 1_150);    // invalid
    evaluator.applyDirection('right', 1_250, 1_450); // +2
    evaluator.applyDirection('left', 1_500, 1_600);  // repaint
    evaluator.applyDirection('right', 1_650, 1_800); // repaint + revisit
    const state = evaluator.snapshot(1_900);

    assert.equal(state.status, 'running');
    assert.deepEqual(state.ball_position, { row: 0, column: 2 });
    assert.equal(state.painted_cell_count, 3);
    assert.equal(state.remaining_unpainted_cells, 1);
    assert.equal(state.coverage_ratio, 0.75);
    assert.deepEqual(state.board, {
        rows: 2,
        columns: 3,
        total_paintable_cells: 4,
        painted_cell_count: 3,
        remaining_unpainted_cells: 1,
        coverage_ratio: 0.75,
    });

    assert.equal(state.move_count, 4);
    assert.equal(state.valid_move_count, 3);
    assert.equal(state.invalid_move_count, 1);
    assert.deepEqual(state.actions.newly_painted_cells_per_move, [2, 0, 0]);
    assert.equal(state.actions.productive_move_count, 1);
    assert.equal(state.actions.zero_progress_move_count, 2);
    assert.equal(state.actions.total_newly_painted_cells, 2);
    assert.equal(state.actions.valid_move_ratio, 0.75);
    assert.equal(state.actions.invalid_move_ratio, 0.25);
    assert.equal(state.actions.productive_move_ratio, 0.3333);
    assert.equal(state.actions.redundant_move_ratio, 0.6667);

    assert.equal(state.efficiency.optimal_move_count, 5);
    assert.equal(state.efficiency.actual_move_count, 4);
    assert.equal(state.efficiency.extra_move_count, 0);
    assert.equal(state.efficiency.move_efficiency, 1);
    assert.equal(state.efficiency.mean_new_cells_per_valid_move, 0.6667);
    assert.equal(state.efficiency.max_new_cells_in_one_move, 2);
    assert.equal(state.efficiency.painted_cells_per_move, 0.5);

    assert.deepEqual(state.traversal, {
        total_traversed_cells: 6,
        newly_painted_traversals: 2,
        already_painted_traversals: 4,
        new_cell_traversal_ratio: 0.3333,
        repainted_cell_traversal_ratio: 0.6667,
    });
    assert.equal(state.state_analysis.unique_state_count, 3);
    assert.equal(state.state_analysis.revisited_state_count, 2);
    assert.equal(state.state_analysis.state_revisit_ratio, 0.5);
    assert.equal(state.state_analysis.cycle_detected, false);
    assert.equal(state.progress.remaining_connected_regions, 1);
    assert.equal(state.progress.reachable_unpainted_cells, 1);
    assert.deepEqual(state.progress.progress_delta_per_move, [0, 0.5, 0, 0]);
    assert.equal(state.progress.best_coverage_ratio, 0.75);
    assert.equal(state.progress.moves_since_last_progress, 2);

    assert.equal(state.elapsed_time_ms, 900);
    assert.deepEqual(state.timing, {
        elapsed_time_ms: 900,
        mean_move_duration_ms: 125,
        decision_wait_time_ms: 300,
        animation_time_ms: 450,
    });
    assert.equal(state.trajectory.length, 4);
    assert.deepEqual(state.trajectory.map(record => record.step), [1, 2, 3, 4]);
    assert.deepEqual(state.trajectory.map(record => record.moved), [false, true, true, true]);
    assert.deepEqual(state.trajectory.map(record => record.durationMs), [50, 200, 100, 150]);
    assert.deepEqual(state.trajectory.map(record => record.decisionWaitMs), [100, 100, 50, 50]);
    assert.throws(() => state.actions.newly_painted_cells_per_move.push(9), TypeError);
}

function assertStableHashesRevisitsRepeatedActionsAndCycles() {
    const maze = level('cycles', ['S..', '#.#'], Number.POSITIVE_INFINITY);
    const initial = createInitialMazePaintState(maze);
    const initialHash = hashMazePaintState(maze, initial);
    assert.equal(initialHash, hashMazePaintState(maze, createInitialMazePaintState(maze)));

    const across = computeMazePaintMove(maze, initial, 'right').nextState;
    const back = computeMazePaintMove(maze, across, 'left').nextState;
    assert.deepEqual(back.ball, initial.ball);
    assert.notEqual(
        hashMazePaintState(maze, back),
        initialHash,
        'the painted mask distinguishes states at the same ball position',
    );

    const repeats = new MazePaintEvaluator(maze, 0, options());
    repeats.applyDirection('up', 0, 0);
    repeats.applyDirection('up', 0, 0);
    repeats.applyDirection('up', 0, 0);
    const repeatedState = repeats.snapshot(0);
    assert.equal(repeatedState.actions.repeated_action_count, 2);
    assert.equal(repeatedState.state_analysis.unique_state_count, 1);
    assert.equal(repeatedState.state_analysis.revisited_state_count, 3);
    assert.equal(repeatedState.state_analysis.state_revisit_ratio, 1);
    assert.equal(repeatedState.state_analysis.cycle_detected, true);
    assert.equal(repeatedState.state_analysis.cycle_detected_ever, true);
    assert.equal(repeatedState.state_analysis.cycle_length, 1);
    assert.equal(repeatedState.state_analysis.cycle_repetitions, 3);

    const cycle = new MazePaintEvaluator(maze, 0, options({ cycleFailureRepetitions: 3 }));
    cycle.applyDirection('right', 0, 0); // establishes the painted top corridor
    for (const direction of ['left', 'right', 'left', 'right', 'left', 'right']) {
        cycle.applyDirection(direction, 0, 0);
    }
    const cycleState = cycle.snapshot(0);
    assert.equal(cycleState.failure, true);
    assert.equal(cycleState.termination_reason, 'repeated_action_cycle');
    assert.equal(cycleState.state_analysis.cycle_detected, true);
    assert.equal(cycleState.state_analysis.cycle_length, 2);
    assert.equal(cycleState.state_analysis.cycle_repetitions, 3);
    assert.equal(cycleState.progress.moves_since_last_progress, 6);
}

function assertSuccessEfficiencyAndCanonicalMoveGuard() {
    const maze = level('success', ['S.'], 1);
    const evaluator = new MazePaintEvaluator(maze, 100, options());
    const result = evaluator.applyDirection('right', 150, 250);
    assert.equal(result.moved, true);
    const state = evaluator.snapshot(10_000);
    assert.equal(state.status, 'success');
    assert.equal(state.success, true);
    assert.equal(state.failure, false);
    assert.equal(state.termination_reason, 'success');
    assert.equal(state.coverage_ratio, 1);
    assert.equal(state.efficiency.actual_move_count, 1);
    assert.equal(state.efficiency.extra_move_count, 0);
    assert.equal(state.efficiency.move_efficiency, 1);
    assert.equal(state.score, 100);
    assert.equal(state.elapsed_time_ms, 150, 'terminal elapsed time is frozen at completion');

    const afterTerminal = evaluator.applyDirection('left', 20_000, 21_000);
    assert.equal(afterTerminal.moved, true, 'the caller may still compute a move after terminal state');
    assert.equal(evaluator.snapshot(22_000).move_count, 1, 'terminal evaluator ignores further commits');

    const guardMaze = level('guard-valid', ['S..', '#.#']);
    const guarded = new MazePaintEvaluator(guardMaze, 0, options());
    const move = computeMazePaintMove(guardMaze, guarded.state, 'right');
    const divergent = {
        ...move,
        nextState: createInitialMazePaintState(guardMaze),
    };
    assert.throws(
        () => guarded.recordMove(divergent, 0, 0),
        /diverged from the authoritative transition/,
    );

    const stale = { ...move, from: { row: 99, column: 99 } };
    assert.throws(
        () => guarded.recordMove(stale, 0, 0),
        /stale ball position/,
    );
}

function assertFailureReasons() {
    const maze = level('failures', ['S..', '#.#'], Number.POSITIVE_INFINITY);

    const maxSteps = new MazePaintEvaluator(maze, 0, options({ maxSteps: 1 }));
    maxSteps.applyDirection('right', 0, 1);
    assert.equal(maxSteps.snapshot(1).termination_reason, 'max_steps');

    const noProgress = new MazePaintEvaluator(maze, 0, options({ noProgressMoveLimit: 1 }));
    noProgress.applyDirection('up', 0, 1);
    assert.equal(noProgress.snapshot(1).termination_reason, 'no_progress');

    const timeout = new MazePaintEvaluator(maze, 1_000, options({ timeoutMs: 500 }));
    assert.equal(timeout.snapshot(1_499).status, 'running');
    assert.equal(timeout.snapshot(1_500).termination_reason, 'timeout');
    assert.equal(timeout.snapshot(9_999).elapsed_time_ms, 500);

    for (const reason of ['environment_error', 'max_steps', 'no_progress', 'timeout']) {
        const terminated = new MazePaintEvaluator(maze, 10, options());
        terminated.terminate(reason, 25);
        const state = terminated.snapshot(1_000);
        assert.equal(state.status, 'failure');
        assert.equal(state.success, false);
        assert.equal(state.failure, true);
        assert.equal(state.termination_reason, reason);
        assert.equal(state.elapsed_time_ms, 15);
    }
}

function assertScoringBoundsAndSuccessOrdering() {
    const common = {
        coverageRatio: 1,
        moveEfficiency: 0,
        productiveMoveRatio: 0,
        invalidMoveRatio: 1,
        redundantMoveRatio: 1,
        stateRevisitRatio: 1,
    };
    const worstSuccess = scoreMazePaint({ success: true, ...common });
    const bestFailure = scoreMazePaint({
        success: false,
        coverageRatio: 1,
        moveEfficiency: 1,
        productiveMoveRatio: 1,
        invalidMoveRatio: 0,
        redundantMoveRatio: 0,
        stateRevisitRatio: 0,
    });
    assert.equal(worstSuccess, 70);
    assert.equal(bestFailure, 69.999);
    assert.ok(worstSuccess > bestFailure, 'every success scores above every failure');

    const samples = [
        { success: false, coverageRatio: -5, moveEfficiency: NaN, productiveMoveRatio: Infinity, invalidMoveRatio: -1, redundantMoveRatio: 9, stateRevisitRatio: 2 },
        { success: false, coverageRatio: 0.5, moveEfficiency: 0.5, productiveMoveRatio: 0.5, invalidMoveRatio: 0.5, redundantMoveRatio: 0.5, stateRevisitRatio: 0.5 },
        { success: true, coverageRatio: 99, moveEfficiency: 99, productiveMoveRatio: 99, invalidMoveRatio: -2, redundantMoveRatio: -2, stateRevisitRatio: -2 },
    ];
    for (const sample of samples) {
        const score = scoreMazePaint(sample);
        assert.equal(typeof score, 'number');
        assert.equal(Number.isFinite(score), true);
        assert.ok(score >= 0 && score <= 100);
    }
}

assertInitialSnapshotAndZeroDenominators();
assertCoverageRatiosStateAnalysisAndTiming();
assertStableHashesRevisitsRepeatedActionsAndCycles();
assertSuccessEfficiencyAndCanonicalMoveGuard();
assertFailureReasons();
assertScoringBoundsAndSuccessOrdering();

console.log('Maze Paint evaluator, termination, cycle, timing, and scoring tests passed.');
