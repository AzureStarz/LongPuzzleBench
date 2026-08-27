import assert from 'node:assert/strict';
import { evaluateBoltDeadlock } from '../assets/scripts/game/BoltDeadlock.ts';

const base = {
    levelSuccess: false,
    levelFailure: false,
    availableHoleCount: 0,
    movableBoltCount: 3,
    pendingOperationCount: 0,
    gameStateStable: true,
    awaitingOperationSettlement: false,
};

assert.deepEqual(evaluateBoltDeadlock(base), {
    isDeadlocked: true,
    reason: 'no_available_hole',
    availableHoleCount: 0,
    legalProgressActionCount: 0,
    pendingOperationCount: 0,
    gameStateStable: true,
    awaitingOperationSettlement: false,
});
assert.equal(evaluateBoltDeadlock({ ...base, pendingOperationCount: 1 }).isDeadlocked, false);
assert.equal(evaluateBoltDeadlock({ ...base, levelSuccess: true }).isDeadlocked, false);
assert.equal(evaluateBoltDeadlock({ ...base, availableHoleCount: 1 }).isDeadlocked, false);
assert.equal(evaluateBoltDeadlock({ ...base, gameStateStable: false }).isDeadlocked, false);
assert.equal(
    evaluateBoltDeadlock({ ...base, awaitingOperationSettlement: true, gameStateStable: false }).isDeadlocked,
    false,
);
assert.equal(
    evaluateBoltDeadlock({ ...base, availableHoleCount: 1 }).legalProgressActionCount,
    3,
);

console.log('Bolt deadlock rules passed.');
