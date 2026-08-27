import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    NUTS_BOLTS_LEVELS,
    validateNutsBoltsLevel,
} from '../assets/scripts/nuts_bolts/NutsBoltsLevelData.ts';
import { NutsBoltsModel } from '../assets/scripts/nuts_bolts/NutsBoltsModel.ts';

const LOCKED_CATALOGUE_HASHES = {
    easy: 'c1736063f9fb1600faa2286e3478ac957ea9ecd025c8ed1110c2e98542f4724f',
    medium: '4d164facc30cf5c1300c0d099baba4b7c43d3a412b4be196f37e804da3e8766b',
    hard: '4394a1fbc8cfc3936dea7e65215c5380e93b8364bf820d4a31db0a9d2b7dceed',
};

function assertExistingCatalogueUnchanged() {
    for (const [difficulty, expectedHash] of Object.entries(LOCKED_CATALOGUE_HASHES)) {
        const normalized = NUTS_BOLTS_LEVELS[difficulty].map(({
            id, difficulty: levelDifficulty, difficultyLabel, levelNumber, capacity,
            visualSize, nutStep, capBaseOffset, bolts, source,
        }) => ({
            id,
            difficulty: levelDifficulty,
            difficultyLabel,
            levelNumber,
            capacity,
            visualSize,
            nutStep,
            capBaseOffset,
            bolts,
            source,
        }));
        const actualHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
        assert.equal(actualHash, expectedHash, `${difficulty} screenshot data must remain unchanged`);
    }
}

function assertCoreRules() {
    const level = NUTS_BOLTS_LEVELS.easy[1];
    const model = new NutsBoltsModel(level);
    const initial = model.serialize();

    assert.deepEqual(model.move(0, 1), { ok: false, reason: 'target-full' });
    assert.equal(model.serialize(), initial);
    assert.deepEqual(model.move(3, 4), { ok: false, reason: 'empty-source' });
    assert.deepEqual(model.move(0, 0), { ok: false, reason: 'same-bolt' });

    // Two adjacent blue top nuts move together to an empty bolt.
    const moved = model.move(0, 3);
    assert.equal(moved.ok, true);
    assert.equal(moved.move.count, 2);
    assert.deepEqual(model.getStack(0), ['red']);
    assert.deepEqual(model.getStack(3), ['blue', 'blue']);
    assert.equal(model.historyLength, 1);
    assert.deepEqual(model.peekUndo(), moved.move);
    assert.equal(model.historyLength, 1, 'peeking undo must not consume history');

    // Different colours never stack.
    assert.deepEqual(model.move(2, 3), { ok: false, reason: 'color-mismatch' });
    assert.deepEqual(model.getStack(3), ['blue', 'blue']);

    const undone = model.undo();
    assert.equal(undone?.count, 2);
    assert.equal(model.serialize(), initial);
    assert.equal(model.undo(), null);

    model.move(0, 3);
    model.reset();
    assert.equal(model.serialize(), initial);
    assert.equal(model.historyLength, 0);
}

function solveLevel(level, maxVisited = 200_000) {
    const capacity = level.capacity;
    const stacks = level.bolts.map(item => item.nuts.slice());
    const visited = new Set();
    const path = [];
    let visits = 0;

    const complete = () => stacks.every(stack => stack.length === 0
        || (stack.length === capacity && stack.every(color => color === stack[0])));
    // Bolt positions are irrelevant to the rules, so canonicalise permutations.
    const stateKey = () => stacks.map(stack => stack.join('.')).sort().join('|');

    const visit = (lastSource = -1, lastTarget = -1) => {
        if (complete()) return true;
        const key = stateKey();
        if (visited.has(key)) return false;
        visited.add(key);
        visits++;
        if (visits > maxVisited) return false;

        const firstEmpty = stacks.findIndex(stack => stack.length === 0);
        const moves = [];
        for (let source = 0; source < stacks.length; source++) {
            const from = stacks[source];
            if (from.length === 0) continue;
            const color = from[from.length - 1];
            let run = 1;
            while (run < from.length && from[from.length - run - 1] === color) run++;
            if (from.length === capacity && run === capacity) continue;

            for (let target = 0; target < stacks.length; target++) {
                if (source === target) continue;
                const to = stacks[target];
                if (to.length >= capacity || (to.length > 0 && to[to.length - 1] !== color)) continue;
                if (to.length === 0 && (target !== firstEmpty || run === from.length)) continue;

                const count = Math.min(run, capacity - to.length);
                let score = to.length > 0 ? 100 : -20;
                if (to.length + count === capacity) score += 60;
                if (count === run) score += 15;
                if (from.length > count && from[from.length - count - 1] !== color) score += 20;
                if (source === lastTarget && target === lastSource) score -= 1000;
                moves.push({ source, target, count, score });
            }
        }
        moves.sort((a, b) => b.score - a.score);

        for (const move of moves) {
            const moved = stacks[move.source].splice(-move.count, move.count);
            stacks[move.target].push(...moved);
            path.push(move);
            if (visit(move.source, move.target)) return true;
            path.pop();
            stacks[move.source].push(...stacks[move.target].splice(-move.count, move.count));
        }
        return false;
    };

    return { solved: visit(), path: path.slice(), visits };
}

function assertScreenshotCatalogue() {
    const expectedCapacities = {
        easy: [4, 3, 3],
        medium: [4, 5, 3],
        hard: [4, 8, 6],
        extreme: [4, 3, 5],
        nightmare: [8],
    };

    for (const [difficulty, levels] of Object.entries(NUTS_BOLTS_LEVELS)) {
        assert.equal(levels.length, expectedCapacities[difficulty].length);
        levels.forEach((level, index) => {
            validateNutsBoltsLevel(level);
            assert.equal(level.difficulty, difficulty);
            assert.equal(level.levelNumber, index + 1);
            assert.equal(level.capacity, expectedCapacities[difficulty][index]);
            assert.equal(level.bolts.filter(item => item.nuts.length === 0).length, 2);

            const solution = solveLevel(level);
            assert.equal(solution.solved, true, `${level.id} must be solvable`);
            assert.ok(solution.path.length > 0, `${level.id} must require moves`);

            // Replay the found path through the production model and prove its
            // grouped-move semantics reach the same terminal state.
            const model = new NutsBoltsModel(level);
            for (const move of solution.path) {
                const result = model.move(move.source, move.target);
                assert.equal(result.ok, true, `${level.id}: solver move must stay legal`);
            }
            assert.equal(model.isComplete(), true, `${level.id} must complete`);
        });
    }
}

function assertNightmareScreenshot() {
    const [level] = NUTS_BOLTS_LEVELS.nightmare;
    assert.equal(level.source, '极难关卡/1.jpg');
    assert.equal(level.difficultyLabel, '超難');
    assert.equal(level.nutStep, 21);
    assert.deepEqual(level.bolts.map(({ screenX, baseBottomY }) => [screenX, baseBottomY]), [
        [39.5, 445], [109.5, 445], [179.5, 445], [249.5, 445], [319.5, 445], [389.5, 445],
        [39.5, 700], [109.5, 700], [179.5, 700], [249.5, 700], [319.5, 700],
    ]);
    assert.deepEqual(level.bolts.map(item => item.nuts), [
        ['brown', 'lime', 'red', 'orange', 'orange', 'red', 'red', 'red'],
        ['cyan', 'cyan', 'blue', 'green', 'brown', 'orange', 'yellow', 'yellow'],
        ['cyan', 'blue', 'brown', 'lime', 'lime', 'lime', 'lime', 'yellow'],
        ['cyan', 'blue', 'green', 'yellow', 'pink', 'red', 'green', 'red'],
        ['pink', 'brown', 'blue', 'pink', 'orange', 'green', 'blue', 'orange'],
        ['green', 'brown', 'blue', 'blue', 'pink', 'yellow', 'orange', 'red'],
        ['green', 'cyan', 'orange', 'pink', 'yellow', 'pink', 'lime', 'yellow'],
        ['green', 'pink', 'brown', 'brown', 'pink', 'cyan', 'orange', 'yellow'],
        ['blue', 'green', 'lime', 'lime', 'brown', 'cyan', 'red', 'cyan'],
        [],
        [],
    ]);
}

assertCoreRules();
assertExistingCatalogueUnchanged();
assertNightmareScreenshot();
assertScreenshotCatalogue();
console.log('Nuts & Bolts model and all 13 screenshot levels passed.');
