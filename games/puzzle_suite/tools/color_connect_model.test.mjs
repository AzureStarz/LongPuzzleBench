import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    COLOR_CONNECT_LEVELS,
    getColorConnectLevel,
} from '../assets/scripts/color_connect/ColorConnectLevelData.ts';
import {
    beginColorConnectPath,
    cancelColorConnectPathAtEndpoint,
    cloneColorConnectState,
    countColorConnectOccupiedCells,
    createInitialColorConnectState,
    extendColorConnectPath,
    extendColorConnectPathThrough,
    hashColorConnectState,
    parseColorConnectLevel,
    releaseColorConnectPath,
    replayColorConnectPaths,
    validateColorConnectPath,
    validateColorConnectSolution,
} from '../assets/scripts/color_connect/ColorConnectRules.ts';
import {
    replayColorConnectSolution,
    solveColorConnectLevel,
} from '../assets/scripts/color_connect/ColorConnectSolver.ts';

const EXPECTED = {
    easy: [
        [6, 6, 6], [7, 6, 8], [7, 7, 11], [6, 5, 4], [7, 7, 10],
        [5, 5, 3], [7, 6, 7], [6, 6, 6], [7, 7, 9], [6, 5, 5],
    ],
    hard: [
        [8, 7, 8], [9, 8, 11], [8, 8, 10], [7, 7, 6], [9, 8, 12],
        [8, 7, 7], [7, 7, 5], [9, 8, 11], [10, 9, 14], [11, 11, 15],
    ],
};

function definition(id, rows, columns, pairs, blockedCells = []) {
    return Object.freeze({
        id,
        difficulty: 'easy',
        levelNumber: 1,
        rows,
        columns,
        blockedCells: Object.freeze(blockedCells),
        colorPairs: Object.freeze(pairs.map(([colorId, sr, sc, er, ec], index) => Object.freeze({
            colorId,
            start: Object.freeze({ row: sr, column: sc }),
            end: Object.freeze({ row: er, column: ec }),
            displayColor: ['#ff0000', '#00ff00', '#0000ff'][index % 3],
        }))),
        requireFullCoverage: false,
        screenshot: `test/${id}.png`,
        sourceTitle: id,
        sourceScreenshotTitle: id,
    });
}

function draw(level, state, cells) {
    let transition = beginColorConnectPath(level, state, cells[0]);
    assert.equal(transition.valid, true);
    state = transition.nextState;
    for (const cell of cells.slice(1)) {
        transition = extendColorConnectPath(level, state, cell);
        assert.equal(transition.valid, true, `${transition.violation} at ${JSON.stringify(cell)}`);
        state = transition.nextState;
    }
    return state;
}

function assertCatalogueAndReferences() {
    assert.equal(COLOR_CONNECT_LEVELS.easy.length, 10);
    assert.equal(COLOR_CONNECT_LEVELS.hard.length, 10);
    let solvedCount = 0;
    for (const difficulty of ['easy', 'hard']) {
        COLOR_CONNECT_LEVELS[difficulty].forEach((raw, index) => {
            const [rows, columns, pairCount] = EXPECTED[difficulty][index];
            assert.equal(raw.id, `${difficulty}_${String(index + 1).padStart(2, '0')}`);
            assert.equal(raw.levelNumber, index + 1);
            assert.equal(raw.rows, rows);
            assert.equal(raw.columns, columns);
            assert.equal(raw.colorPairs.length, pairCount);
            assert.deepEqual(raw.blockedCells, []);
            assert.equal(raw.requireFullCoverage, false);
            assert.equal(raw.screenshot, `${difficulty === 'easy' ? '简单' : '困难'}/${index + 1}.png`);
            assert.equal(raw.sourceTitle, raw.sourceScreenshotTitle);
            const level = parseColorConnectLevel(raw);
            assert.equal(level.totalPlayableCells, rows * columns);
            assert.equal(Object.keys(level.endpointColorByKey).length, pairCount * 2);
            assert.equal(Object.keys(level.pairByColorId).length, pairCount);

            const solution = solveColorConnectLevel(level);
            assert.equal(solution.solvable, true, `${level.id} must have a checked reference`);
            assert.equal(solution.optimal, false, 'reference solutions never claim strict optimality');
            assert.equal(solution.referenceTotalPathLength, rows * columns, 'verified references happen to cover each source board');
            assert.equal(validateColorConnectSolution(level, solution.paths).valid, true);
            const replayed = replayColorConnectSolution(level, solution);
            assert.equal(replayed.success, true);
            assert.equal(replayed.completedColorCount, pairCount);
            assert.equal(countColorConnectOccupiedCells(replayed), rows * columns);
            solvedCount++;
        });
    }
    assert.equal(solvedCount, 20);
    const topologyManifest = ['easy', 'hard'].flatMap(difficulty => COLOR_CONNECT_LEVELS[difficulty].map(raw =>
        `${raw.id}:${raw.rows}x${raw.columns}:` + raw.colorPairs.map(pair =>
            `${pair.colorId}@${pair.start.row},${pair.start.column}-${pair.end.row},${pair.end.column}`).join('|'))).join('\n');
    assert.equal(
        createHash('sha256').update(topologyManifest).digest('hex'),
        '548dca7887e872f058d842afc14e3eb317576c4c20a56fbe7721448ac520cb85',
        'all 20 screenshot-derived endpoint coordinates are locked',
    );
    assert.equal(getColorConnectLevel('easy', -100).id, 'easy_01');
    assert.equal(getColorConnectLevel('hard', 999).id, 'hard_10');
    assert.equal(COLOR_CONNECT_LEVELS.easy[0].sourceTitle, '簡單 第 1 關');
    assert.equal(COLOR_CONNECT_LEVELS.hard[0].sourceTitle, '困難 第 1 關');
    assert.equal(COLOR_CONNECT_LEVELS.hard[6].sourceTitle, '困難 第 8 關');
    assert.equal(COLOR_CONNECT_LEVELS.hard[7].sourceTitle, '困難 第 9 關');
    assert.equal(COLOR_CONNECT_LEVELS.hard[8].sourceTitle, '困難 第 10 關');
    assert.equal(COLOR_CONNECT_LEVELS.hard[9].sourceTitle, '超難 第 1 關');
}

function assertParserGuardsAndFallbackSolver() {
    assert.throws(() => parseColorConnectLevel(definition('bad-size', 0, 2, [['red', 0, 0, 0, 1]])), /positive integers/);
    assert.throws(() => parseColorConnectLevel(definition('duplicate-color', 2, 2, [
        ['red', 0, 0, 0, 1], ['red', 1, 0, 1, 1],
    ])), /color ids must be unique/);
    assert.throws(() => parseColorConnectLevel(definition('duplicate-endpoint', 2, 2, [
        ['red', 0, 0, 0, 1], ['green', 0, 1, 1, 1],
    ])), /endpoint coordinates must be unique/);
    assert.throws(() => parseColorConnectLevel(definition('blocked-endpoint', 2, 2, [
        ['red', 0, 0, 0, 1],
    ], [{ row: 0, column: 0 }])), /endpoint is blocked/);
    assert.throws(() => parseColorConnectLevel(definition('outside', 2, 2, [
        ['red', 0, 0, 3, 1],
    ])), /outside/);

    const corridor = parseColorConnectLevel(definition('custom-corridor', 1, 4, [['red', 0, 0, 0, 3]]));
    const solved = solveColorConnectLevel(corridor, { candidatePathLimit: 4, maxExtraPathLength: 0 });
    assert.equal(solved.solvable, true, 'non-catalogue levels use deterministic fallback search');
    assert.deepEqual(solved.paths.red, [
        { row: 0, column: 0 }, { row: 0, column: 1 },
        { row: 0, column: 2 }, { row: 0, column: 3 },
    ]);
}

function assertPureTransitionsBacktrackingReleaseAndFastSampling() {
    const level = parseColorConnectLevel(definition('transitions', 3, 4, [
        ['red', 0, 0, 0, 3], ['green', 2, 0, 2, 3],
    ]));
    const initial = createInitialColorConnectState(level);
    const initialHash = hashColorConnectState(level, initial);
    const ordinary = beginColorConnectPath(level, initial, { row: 1, column: 1 });
    assert.equal(ordinary.valid, false);
    assert.equal(ordinary.violation, 'start_from_non_endpoint');
    assert.strictEqual(ordinary.nextState, initial);

    const outside = beginColorConnectPath(level, initial, { row: -1, column: 0 });
    assert.equal(outside.violation, 'drag_outside_board');
    let start = beginColorConnectPath(level, initial, { row: 0, column: 0 });
    assert.equal(start.valid, true);
    assert.equal(start.nextState.activeColorId, 'red');
    assert.deepEqual(initial.activePath, [], 'begin is pure');
    assert.equal(hashColorConnectState(level, initial), initialHash);

    const jump = extendColorConnectPath(level, start.nextState, { row: 0, column: 2 });
    assert.equal(jump.violation, 'non_adjacent_jump_attempt');
    const first = extendColorConnectPath(level, start.nextState, { row: 0, column: 1 });
    const second = extendColorConnectPath(level, first.nextState, { row: 1, column: 1 });
    const backtrack = extendColorConnectPath(level, second.nextState, { row: 0, column: 1 });
    assert.equal(backtrack.valid, true);
    assert.equal(backtrack.backtrackedCellCount, 1);
    assert.deepEqual(backtrack.nextState.activePath, [{ row: 0, column: 0 }, { row: 0, column: 1 }]);

    const selfRoute = extendColorConnectPath(level, second.nextState, { row: 1, column: 0 });
    const self = extendColorConnectPath(level, selfRoute.nextState, { row: 0, column: 0 });
    assert.equal(self.violation, 'path_self_intersection_attempt');
    const incomplete = releaseColorConnectPath(level, backtrack.nextState);
    assert.equal(incomplete.violation, 'released_before_connection');
    assert.equal(incomplete.nextState.activeColorId, null);
    assert.equal(incomplete.nextState.completedColorCount, 0);
    assert.equal(hashColorConnectState(level, incomplete.nextState), initialHash);

    start = beginColorConnectPath(level, initial, { row: 0, column: 0 });
    const fast = extendColorConnectPathThrough(level, start.nextState, { row: 0, column: 3 });
    assert.equal(fast.valid, true);
    assert.equal(fast.completedColorId, 'red');
    assert.deepEqual(fast.enteredCells, [
        { row: 0, column: 1 }, { row: 0, column: 2 }, { row: 0, column: 3 },
    ]);
    assert.equal(fast.nextState.paths.red.completed, true);
    assert.equal(fast.nextState.completedColorCount, 1);
    assert.equal(fast.nextState.success, false);
}

function assertConflictsCancellationAndSuccess() {
    const level = parseColorConnectLevel(definition('conflicts', 4, 4, [
        ['red', 0, 0, 0, 3], ['green', 1, 0, 1, 3],
    ], [{ row: 3, column: 3 }]));
    let state = createInitialColorConnectState(level);
    const blockedStart = beginColorConnectPath(level, state, { row: 3, column: 3 });
    assert.equal(blockedStart.violation, 'entered_blocked_cell');
    let redStart = beginColorConnectPath(level, state, { row: 0, column: 0 });
    const wrong = extendColorConnectPath(level, redStart.nextState, { row: 1, column: 0 });
    assert.equal(wrong.violation, 'entered_other_color_endpoint');
    state = draw(level, state, [{ row: 0, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 2 }, { row: 0, column: 3 }]);
    assert.equal(countColorConnectOccupiedCells(state), 4);

    let green = beginColorConnectPath(level, state, { row: 1, column: 0 });
    const overlap = extendColorConnectPath(level, green.nextState, { row: 0, column: 0 });
    assert.equal(overlap.violation, 'entered_other_color_endpoint', 'endpoints are classified before path overlap');
    green = extendColorConnectPath(level, green.nextState, { row: 1, column: 1 });
    const intoPath = extendColorConnectPath(level, green.nextState, { row: 0, column: 1 });
    assert.equal(intoPath.violation, 'path_overlap_attempt');
    assert.equal(state.paths.red.completed, true, 'conflict never deletes another path');

    state = draw(level, state, [{ row: 1, column: 0 }, { row: 1, column: 1 }, { row: 1, column: 2 }, { row: 1, column: 3 }]);
    assert.equal(state.success, true);
    const frozen = beginColorConnectPath(level, state, { row: 0, column: 0 });
    assert.equal(frozen.violation, 'game_already_complete');

    const cancellableLevel = parseColorConnectLevel(definition('cancel', 3, 4, [
        ['red', 0, 0, 0, 3], ['green', 2, 0, 2, 3],
    ]));
    let cancellable = createInitialColorConnectState(cancellableLevel);
    cancellable = draw(cancellableLevel, cancellable, [
        { row: 0, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 2 }, { row: 0, column: 3 },
    ]);
    cancellable = draw(cancellableLevel, cancellable, [
        { row: 2, column: 0 }, { row: 2, column: 1 }, { row: 2, column: 2 }, { row: 2, column: 3 },
    ]);
    assert.equal(cancellable.success, true);
    // Cancellation is intentionally locked after overall success.
    assert.equal(cancelColorConnectPathAtEndpoint(cancellableLevel, cancellable, { row: 0, column: 0 }).violation, 'game_already_complete');

    let partial = createInitialColorConnectState(cancellableLevel);
    partial = draw(cancellableLevel, partial, [
        { row: 0, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 2 }, { row: 0, column: 3 },
    ]);
    const cancel = cancelColorConnectPathAtEndpoint(cancellableLevel, partial, { row: 0, column: 3 });
    assert.equal(cancel.valid, true);
    assert.equal(cancel.cancelledColorId, 'red');
    assert.equal(cancel.nextState.paths.red.completed, false);
    assert.equal(countColorConnectOccupiedCells(cancel.nextState), 0);

    const cloned = cloneColorConnectState(partial);
    assert.equal(hashColorConnectState(cancellableLevel, cloned), hashColorConnectState(cancellableLevel, partial));
    assert.deepEqual(cloned.paths.red.cells, partial.paths.red.cells);
    assert.equal(cloned.completedColorCount, partial.completedColorCount);
    assert.notStrictEqual(cloned, partial);
    assert.throws(() => { cloned.paths.red.cells[0].row = 99; }, TypeError);
}

function assertValidationAndReplayRejectDivergence() {
    const level = parseColorConnectLevel(definition('validation', 2, 3, [
        ['red', 0, 0, 0, 2], ['green', 1, 0, 1, 2],
    ]));
    const good = {
        red: [{ row: 0, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 2 }],
        green: [{ row: 1, column: 0 }, { row: 1, column: 1 }, { row: 1, column: 2 }],
    };
    assert.equal(validateColorConnectPath(level, 'red', good.red).valid, true);
    assert.equal(validateColorConnectSolution(level, good).valid, true);
    assert.equal(replayColorConnectPaths(level, good).success, true);
    assert.equal(validateColorConnectPath(level, 'red', [good.red[0], good.red[2]]).violation, 'non_adjacent_jump_attempt');
    assert.equal(validateColorConnectPath(level, 'red', [good.red[0], good.red[1], good.red[0], good.red[1], good.red[2]]).violation, 'path_self_intersection_attempt');
    const overlap = { ...good, green: [{ row: 1, column: 0 }, { row: 0, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 2 }, { row: 1, column: 2 }] };
    assert.equal(validateColorConnectSolution(level, overlap).valid, false);
}

assertCatalogueAndReferences();
assertParserGuardsAndFallbackSolver();
assertPureTransitionsBacktrackingReleaseAndFastSampling();
assertConflictsCancellationAndSuccess();
assertValidationAndReplayRejectDivergence();

console.log('Color Connect rules, solver, and all 20 screenshot levels passed.');
