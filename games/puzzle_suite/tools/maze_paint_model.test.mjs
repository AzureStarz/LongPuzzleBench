import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    MAZE_PAINT_LEVELS,
    getMazePaintLevel,
    getMazePaintLevels,
} from '../assets/scripts/maze_paint/MazePaintLevelData.ts';
import {
    MAZE_PAINT_DIRECTIONS,
    cloneMazePaintState,
    computeMazePaintMove,
    countPaintedCells,
    createInitialMazePaintState,
    hashMazePaintState,
    isCellPainted,
    isMazePaintComplete,
    isPaintable,
    parseMazePaintLevel,
} from '../assets/scripts/maze_paint/MazePaintRules.ts';
import {
    replayMazePaintSolution,
    solveMazePaintLevel,
} from '../assets/scripts/maze_paint/MazePaintSolver.ts';

const EXPECTED_LEVELS = Object.freeze({
    easy: Object.freeze([
        ['easy_01', 4, 4, 3, 0, 12, 7],
        ['easy_02', 5, 4, 4, 0, 15, 7],
        ['easy_03', 6, 4, 5, 0, 20, 8],
        ['easy_04', 5, 5, 4, 0, 19, 8],
        ['easy_05', 7, 5, 5, 0, 24, 8],
        ['easy_06', 6, 5, 4, 0, 23, 10],
        ['easy_07', 9, 7, 8, 0, 38, 7],
        ['easy_08', 6, 4, 5, 0, 20, 12],
        ['easy_09', 5, 5, 4, 0, 20, 12],
        ['easy_10', 6, 6, 5, 0, 23, 9],
    ]),
    medium: Object.freeze([
        ['medium_01', 6, 6, 4, 0, 29, 13],
        ['medium_02', 7, 5, 6, 0, 27, 16],
        ['medium_03', 7, 6, 6, 0, 31, 13],
        ['medium_04', 8, 6, 7, 0, 35, 14],
        ['medium_05', 6, 6, 5, 0, 33, 14],
        ['medium_06', 7, 7, 5, 0, 37, 15],
        ['medium_07', 11, 10, 10, 0, 68, 14],
        ['medium_08', 7, 5, 6, 0, 26, 13],
        ['medium_09', 6, 6, 5, 0, 27, 13],
        ['medium_10', 8, 7, 7, 0, 37, 15],
    ]),
    hard: Object.freeze([
        ['hard_01', 10, 7, 9, 0, 45, 18],
        ['hard_02', 8, 8, 6, 0, 47, 20],
        ['hard_03', 9, 8, 8, 0, 60, 18],
        ['hard_04', 11, 8, 10, 0, 65, 25],
        ['hard_05', 9, 9, 7, 0, 60, 24],
        ['hard_06', 11, 11, 10, 0, 73, 19],
        ['hard_07', 10, 9, 7, 0, 69, 25],
        ['hard_08', 14, 10, 12, 0, 84, 23],
        ['hard_09', 10, 8, 7, 0, 60, 23],
        ['hard_10', 10, 10, 9, 0, 65, 22],
    ]),
});

const SCREENSHOT_DIRECTORIES = Object.freeze({
    easy: '简单',
    medium: '中等',
    hard: '困难',
});

// Locks every screenshot-derived wall/start cell, not only aggregate metadata.
const CATALOGUE_HASHES = Object.freeze({
    easy: '1fe7d45d0be3ba095e9e814bda86ffc5cdc1dc7d43919e014b49347c8a71a96d',
    medium: 'adbf21d00f90a6094ed4dda4cb607a015bd3a583b512fbf5ab6186334810b3f2',
    hard: '60e18288dae31f42f0fd5e09e302b890fd296a13ab4459b460c8169105457b8b',
});

function definition(id, layout, optimalMoveCount = 0) {
    return Object.freeze({
        id,
        difficulty: 'easy',
        levelNumber: 1,
        layout: Object.freeze([...layout]),
        optimalMoveCount,
        screenshot: `test/${id}.png`,
    });
}

function level(id, layout, optimalMoveCount = 0) {
    return parseMazePaintLevel(definition(id, layout, optimalMoveCount));
}

function assertCatalogueAndExactSolutions() {
    assert.deepEqual(Object.keys(MAZE_PAINT_LEVELS), ['easy', 'medium', 'hard']);
    assert.equal(Object.values(MAZE_PAINT_LEVELS).flat().length, 30);

    for (const [difficulty, expected] of Object.entries(EXPECTED_LEVELS)) {
        const definitions = getMazePaintLevels(difficulty);
        assert.equal(definitions.length, 10, `${difficulty} must contain ten screenshot levels`);
        const normalized = definitions.map(({
            id, difficulty: itemDifficulty, levelNumber, layout, optimalMoveCount, screenshot,
        }) => ({
            id,
            difficulty: itemDifficulty,
            levelNumber,
            layout,
            optimalMoveCount,
            screenshot,
        }));
        assert.equal(
            createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
            CATALOGUE_HASHES[difficulty],
            `${difficulty} screenshot topology must remain unchanged`,
        );

        definitions.forEach((item, index) => {
            const [id, rows, columns, startRow, startColumn, paintableCount, optimal] = expected[index];
            assert.equal(item.id, id);
            assert.equal(item.difficulty, difficulty);
            assert.equal(item.levelNumber, index + 1);
            assert.equal(item.screenshot, `${SCREENSHOT_DIRECTORIES[difficulty]}/${index + 1}.png`);
            assert.equal(item.optimalMoveCount, optimal);

            const parsed = parseMazePaintLevel(item);
            const initialBeforeSolve = createInitialMazePaintState(parsed);
            assert.equal(parsed.rows, rows, `${id} row count`);
            assert.equal(parsed.columns, columns, `${id} column count`);
            assert.deepEqual(parsed.start, { row: startRow, column: startColumn }, `${id} start`);
            assert.equal(parsed.totalPaintableCells, paintableCount, `${id} paintable count`);
            assert.equal(parsed.layout.flatMap(row => [...row]).filter(cell => cell === 'S').length, 1);
            assert.equal(parsed.layout.flatMap(row => [...row]).filter(cell => cell !== '#').length, paintableCount);

            // Parsing proves orthogonal connectivity; exact BFS additionally proves every
            // paintable cell can be covered under the slide-until-wall rule.
            const solution = solveMazePaintLevel(parsed);
            assert.equal(solution.solvable, true, `${id} must be exactly solvable`);
            assert.equal(solution.optimalMoveCount, optimal, `${id} configured optimum`);
            assert.equal(solution.moves.length, optimal, `${id} solution length`);
            assert.ok(solution.visitedStateCount > 0);
            assert.deepEqual(
                createInitialMazePaintState(parsed),
                initialBeforeSolve,
                `${id} solver must not mutate gameplay state or level data`,
            );
            const replayed = replayMazePaintSolution(parsed, solution.moves);
            assert.equal(isMazePaintComplete(parsed, replayed), true, `${id} solution must replay`);
            assert.equal(countPaintedCells(replayed.paintedMask), paintableCount);
        });

        assert.equal(getMazePaintLevel(difficulty, 1).id, `${difficulty}_01`);
        assert.equal(getMazePaintLevel(difficulty, 10).id, `${difficulty}_10`);
        assert.equal(getMazePaintLevel(difficulty, -10).id, `${difficulty}_01`, 'level lookup clamps low');
        assert.equal(getMazePaintLevel(difficulty, 99).id, `${difficulty}_10`, 'level lookup clamps high');
    }
}

function assertParserValidationAndUnsolvableDetection() {
    assert.throws(
        () => level('empty', []),
        /must not be empty/,
    );
    assert.throws(
        () => level('ragged', ['S.', '.']),
        /rectangular/,
    );
    assert.throws(
        () => level('bad-cell', ['SX']),
        /invalid cell/,
    );
    assert.throws(
        () => level('no-start', ['..']),
        /must contain one start/,
    );
    assert.throws(
        () => level('two-starts', ['SS']),
        /multiple starts/,
    );
    assert.throws(
        () => level('disconnected', ['S#', '#.']),
        /disconnected paintable cells/,
    );

    // The cells are connected, but the lower middle cell can never be entered:
    // a horizontal slide crosses its column and neither endpoint is above it.
    const unsolvable = level('connected-but-unsolvable', ['S..', '#.#']);
    const result = solveMazePaintLevel(unsolvable);
    assert.deepEqual(result, {
        solvable: false,
        optimalMoveCount: null,
        moves: [],
        visitedStateCount: 3,
        exhausted: true,
    });
    assert.equal(isMazePaintComplete(unsolvable, replayMazePaintSolution(unsolvable, [])), false);

    const capped = solveMazePaintLevel(parseMazePaintLevel(MAZE_PAINT_LEVELS.easy[0]), 1);
    assert.equal(capped.solvable, false);
    assert.equal(capped.optimalMoveCount, null);
    assert.equal(capped.exhausted, false, 'a resource cap is distinct from graph exhaustion');
}

function assertFourDirectionsAndSlideSemantics() {
    const open = level('four-directions', [
        '.....',
        '.....',
        '..S..',
        '.....',
        '.....',
    ]);
    const initial = createInitialMazePaintState(open);
    const expected = {
        up: { to: { row: 0, column: 2 }, path: [{ row: 1, column: 2 }, { row: 0, column: 2 }] },
        down: { to: { row: 4, column: 2 }, path: [{ row: 3, column: 2 }, { row: 4, column: 2 }] },
        left: { to: { row: 2, column: 0 }, path: [{ row: 2, column: 1 }, { row: 2, column: 0 }] },
        right: { to: { row: 2, column: 4 }, path: [{ row: 2, column: 3 }, { row: 2, column: 4 }] },
    };

    assert.deepEqual(MAZE_PAINT_DIRECTIONS, ['up', 'down', 'left', 'right']);
    for (const direction of MAZE_PAINT_DIRECTIONS) {
        const result = computeMazePaintMove(open, initial, direction);
        assert.equal(result.moved, true);
        assert.deepEqual(result.from, { row: 2, column: 2 });
        assert.deepEqual(result.to, expected[direction].to);
        assert.deepEqual(result.traversedCells, expected[direction].path);
        assert.deepEqual(result.newlyPaintedCells, expected[direction].path);
        assert.deepEqual(result.nextState.ball, expected[direction].to);
        assert.equal(countPaintedCells(result.nextState.paintedMask), 3);
    }

    const corridor = level('corridor', ['S...']);
    const corridorInitial = createInitialMazePaintState(corridor);
    const right = computeMazePaintMove(corridor, corridorInitial, 'right');
    assert.deepEqual(right.to, { row: 0, column: 3 }, 'the ball cannot stop midway');
    assert.deepEqual(right.traversedCells, [
        { row: 0, column: 1 },
        { row: 0, column: 2 },
        { row: 0, column: 3 },
    ]);
    assert.equal(isMazePaintComplete(corridor, right.nextState), true, 'painting the final cell completes immediately');
    assert.equal(countPaintedCells(right.nextState.paintedMask), 4);
    const corridorSolution = solveMazePaintLevel(corridor);
    assert.equal(corridorSolution.solvable, true);
    assert.equal(corridorSolution.optimalMoveCount, 1, 'the human-verifiable corridor optimum is one slide');

    const blocked = computeMazePaintMove(corridor, corridorInitial, 'left');
    assert.equal(blocked.moved, false);
    assert.deepEqual(blocked.to, corridorInitial.ball);
    assert.deepEqual(blocked.traversedCells, []);
    assert.deepEqual(blocked.newlyPaintedCells, []);
    assert.strictEqual(blocked.nextState, corridorInitial, 'an invalid direction preserves state identity');

    const wallStop = level('wall-stop', ['S.#', '...']);
    const intoWall = computeMazePaintMove(wallStop, createInitialMazePaintState(wallStop), 'right');
    assert.deepEqual(intoWall.to, { row: 0, column: 1 });
    assert.deepEqual(intoWall.traversedCells, [{ row: 0, column: 1 }]);
    assert.equal(isPaintable(wallStop, { row: 0, column: 2 }), false);
    assert.throws(
        () => isCellPainted(wallStop, intoWall.nextState, { row: 0, column: 2 }),
        /is not paintable/,
        'walls can never enter the painted mask',
    );
}

function assertPaintingRevisitAndPurity() {
    const corridor = level('painting', ['S...']);
    const initial = createInitialMazePaintState(corridor);
    const initialHash = hashMazePaintState(corridor, initial);
    const initialMask = [...initial.paintedMask];
    assert.equal(countPaintedCells(initialMask), 1, 'the start cell is initially painted');
    assert.equal(isCellPainted(corridor, initial, { row: 0, column: 0 }), true);
    assert.equal(isPaintable(corridor, { row: 0, column: 4 }), false);

    const right = computeMazePaintMove(corridor, initial, 'right');
    assert.deepEqual(initial.paintedMask, initialMask, 'the authoritative transition is pure');
    assert.deepEqual(initial.ball, { row: 0, column: 0 });
    assert.equal(hashMazePaintState(corridor, initial), initialHash);
    assert.equal(right.newlyPaintedCells.length, 3);

    const left = computeMazePaintMove(corridor, right.nextState, 'left');
    assert.equal(left.traversedCells.length, 3);
    assert.equal(left.newlyPaintedCells.length, 0, 'repainting never increments coverage');
    assert.deepEqual(left.nextState.paintedMask, right.nextState.paintedMask);
    assert.equal(countPaintedCells(left.nextState.paintedMask), 4);
    assert.notEqual(
        hashMazePaintState(corridor, right.nextState),
        hashMazePaintState(corridor, left.nextState),
        'ball position participates in the stable state hash',
    );

    const clone = cloneMazePaintState(left.nextState);
    assert.deepEqual(clone, left.nextState);
    assert.notStrictEqual(clone, left.nextState);
    assert.notStrictEqual(clone.ball, left.nextState.ball);
    assert.throws(() => { clone.ball.row = 42; }, TypeError);
    assert.throws(() => { clone.paintedMask[0] = 0; }, TypeError);
}

assertCatalogueAndExactSolutions();
assertParserValidationAndUnsolvableDetection();
assertFourDirectionsAndSlideSemantics();
assertPaintingRevisitAndPurity();

console.log('Maze Paint rules, solver, and all 30 screenshot levels passed.');
