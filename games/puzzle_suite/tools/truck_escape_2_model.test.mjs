import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    TRUCK_ESCAPE_2_EASY_LEVEL_1,
    TRUCK_ESCAPE_2_HARD_LEVEL_1,
    getTruckEscape2Levels,
} from '../assets/scripts/data/TruckEscape2Data.ts';
import { TruckEscape2BoardModel } from '../assets/scripts/game/TruckEscape2BoardModel.ts';

function assertEasyLevel() {
    const level = TRUCK_ESCAPE_2_EASY_LEVEL_1;
    assert.equal(level.cols, 5);
    assert.equal(level.rows, 6);
    assert.equal(level.exitRow, 2);
    assert.equal(level.vehicles.length, 6);

    const model = new TruckEscape2BoardModel(level);
    const initial = model.serialize();

    // 上下都被占用的蓝车不能穿越顶部长车、米色车或底部白车。
    assert.deepEqual(model.getTravelRange('blue_sedan'), { min: 0, max: 0 });
    assert.equal(model.move('blue_sedan', -1), false);
    assert.equal(model.serialize(), initial);

    // 越界移动被拒绝，状态保持不变。
    assert.equal(model.move('sand_semi', -2), false);
    assert.equal(model.move('cream_coupe', 2), false);
    assert.equal(model.serialize(), initial);

    // 一次拖动可合法跨越多个空格。
    assert.equal(model.move('sand_semi', -1), true);
    assert.equal(model.move('cream_coupe', -2), true);
    assert.deepEqual(model.getTravelRange('blue_sedan'), { min: -2, max: 0 });
    assert.equal(model.move('blue_sedan', -2), true);
    assert.deepEqual(model.getTravelRange('red_target'), { min: -1, max: 2 });
    assert.equal(model.move('red_target', 2), true);
    assert.equal(model.isComplete(), true);
}

function assertHintSolver(level, maxVisited) {
    const model = new TruckEscape2BoardModel(level);
    let moves = 0;
    while (!model.isComplete() && moves < 30) {
        const hint = model.findHintMove(maxVisited);
        assert.ok(hint, `${level.id} should remain solvable`);
        assert.equal(model.move(hint.vehicleId, hint.delta), true);
        moves++;
    }
    assert.equal(model.isComplete(), true, `${level.id} should solve from repeated BFS hints`);
    assert.ok(moves > 0 && moves < 30);
}

function assertScreenshotLevels() {
    const levels = getTruckEscape2Levels('easy');
    assert.equal(levels.length, 10);
    const expectedSizes = [
        [5, 6], [5, 5], [6, 6], [5, 5], [5, 6],
        [5, 5], [5, 6], [6, 6], [5, 6], [6, 6],
    ];
    levels.forEach((level, index) => {
        assert.equal(level.levelNumber, index + 1);
        assert.deepEqual([level.cols, level.rows], expectedSizes[index], `${level.id} board size`);
        assert.equal(level.exitRow, 2);
        assert.equal(level.vehicles.filter((item) => item.target).length, 1);
        assertHintSolver(level);
    });

    const level6 = levels[5];
    const model6 = new TruckEscape2BoardModel(level6);
    assert.deepEqual(model6.getTravelRange('e6_white_top'), { min: 0, max: 0 });
    assert.equal(model6.move('e6_white_top', 3), false, 'bush and board boundary must block movement');
}

function assertMediumScreenshotLevels() {
    const levels = getTruckEscape2Levels('medium');
    assert.equal(levels.length, 10);
    const expectedSizes = [
        [7, 7], [7, 8], [7, 8], [7, 7], [7, 7],
        [7, 8], [7, 7], [7, 8], [7, 8], [7, 7],
    ];
    const expectedVehicleCounts = [8, 14, 8, 13, 12, 12, 10, 8, 14, 10];
    const expectedBlockerCounts = [0, 0, 1, 0, 0, 1, 0, 0, 2, 0];
    levels.forEach((level, index) => {
        assert.equal(level.difficulty, 'medium');
        assert.equal(level.levelNumber, index + 1);
        assert.deepEqual([level.cols, level.rows], expectedSizes[index], `${level.id} board size`);
        assert.equal(level.vehicles.length, expectedVehicleCounts[index], `${level.id} vehicle count`);
        assert.equal(level.blockers?.length ?? 0, expectedBlockerCounts[index], `${level.id} blocker count`);
        assert.equal(level.vehicles.filter((item) => item.target).length, 1);
        assertHintSolver(level, 100000);
    });
}

function assertHardScreenshotLevels() {
    const levels = getTruckEscape2Levels('hard');
    assert.equal(levels.length, 10);
    const expectedSizes = [
        [5, 6], [6, 6], [6, 7], [5, 6], [6, 6],
        [5, 6], [7, 7], [5, 5], [6, 6], [5, 6],
    ];
    levels.forEach((level, index) => {
        assert.equal(level.difficulty, 'hard');
        assert.equal(level.levelNumber, index + 1);
        assert.deepEqual([level.cols, level.rows], expectedSizes[index], `${level.id} board size`);
        assert.equal(level.vehicles.filter((item) => item.target).length, 1);
        assertHintSolver(level);
    });
}

function assertCalibratedCatalogIdentity() {
    const expectedHashes = {
        medium: '8b69e052495fafb1f63b2725a4a6b501fbe715415faf2b1208602b3af1052c7a',
        hard: 'f34dd6a670632ca5ca6ff5c27b2056248d7c1d48b22471315634508ac36f2bba',
    };
    for (const difficulty of ['medium', 'hard']) {
        const normalized = getTruckEscape2Levels(difficulty).map((level) => ({
            id: level.id,
            difficulty: level.difficulty,
            levelNumber: level.levelNumber,
            rows: level.rows,
            cols: level.cols,
            exitRow: level.exitRow,
            exitSide: level.exitSide,
            hintCount: level.hintCount,
            vehicles: level.vehicles,
            blockers: level.blockers ?? [],
        }));
        const digest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
        assert.equal(digest, expectedHashes[difficulty], `${difficulty} catalog identity`);
    }
}

function assertInvalidStateRejected() {
    const overlapping = TRUCK_ESCAPE_2_EASY_LEVEL_1.vehicles.map((vehicle) => ({
        id: vehicle.id,
        row: vehicle.row,
        col: vehicle.col,
    }));
    const blue = overlapping.find((vehicle) => vehicle.id === 'blue_sedan');
    blue.row = 1;
    assert.throws(
        () => new TruckEscape2BoardModel(TRUCK_ESCAPE_2_EASY_LEVEL_1, overlapping),
        /重叠/,
    );
}

assertEasyLevel();
assertScreenshotLevels();
assertMediumScreenshotLevels();
assertHardScreenshotLevels();
assertCalibratedCatalogIdentity();
assertHintSolver(TRUCK_ESCAPE_2_HARD_LEVEL_1, 100000);
assertInvalidStateRejected();

console.log('Truck Escape 2 model tests passed.');
