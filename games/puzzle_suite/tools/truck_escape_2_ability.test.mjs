import assert from 'node:assert/strict';
import { TruckEscape2AbilityTracker } from '../assets/scripts/analytics/TruckEscape2AbilityTracker.ts';
import {
    TRUCK_ESCAPE_2_EASY_LEVEL_1,
    getTruckEscape2Levels,
} from '../assets/scripts/data/TruckEscape2Data.ts';
import { TRUCK_ESCAPE_2_REFERENCE_SOLUTIONS } from '../assets/scripts/data/TruckEscape2ReferenceSolutions.ts';
import { TruckEscape2BoardModel } from '../assets/scripts/game/TruckEscape2BoardModel.ts';

const allLevels = ['easy', 'medium', 'hard'].flatMap((difficulty) => getTruckEscape2Levels(difficulty));

function verifyAllReferences() {
    assert.equal(allLevels.length, 30);
    assert.equal(Object.keys(TRUCK_ESCAPE_2_REFERENCE_SOLUTIONS).length, 30);
    const levelIds = allLevels.map((level) => level.id);
    assert.equal(new Set(levelIds).size, levelIds.length, 'catalog level IDs must be unique');
    assert.deepEqual(
        new Set(levelIds),
        new Set(Object.keys(TRUCK_ESCAPE_2_REFERENCE_SOLUTIONS)),
        'catalog and reference IDs must match exactly',
    );
    for (const level of allLevels) {
        assert.equal(level.id, `truck_escape_2_${level.difficulty}_${level.levelNumber}`);
        const reference = TRUCK_ESCAPE_2_REFERENCE_SOLUTIONS[level.id];
        assert.ok(reference, `${level.id} must have a reference`);
        assert.equal(reference.source, 'verified-optimal');
        assert.equal(reference.moves.length, reference.optimalMoves);
        assert.equal(reference.states.length, reference.optimalMoves + 1);
        const model = new TruckEscape2BoardModel(level);
        assert.equal(model.serialize(), reference.states[0], `${level.id} initial reference state`);
        reference.moves.forEach((move, index) => {
            assert.equal(model.move(move.vehicleId, move.delta), true, `${level.id} move ${index + 1}`);
            assert.equal(model.serialize(), reference.states[index + 1], `${level.id} state ${index + 1}`);
        });
        assert.equal(model.isComplete(), true, `${level.id} reference must complete`);
    }
}

function verifySolverDepthCalibration() {
    const depths = (difficulty) => getTruckEscape2Levels(difficulty)
        .map((level) => TRUCK_ESCAPE_2_REFERENCE_SOLUTIONS[level.id].optimalMoves);
    const medium = depths('medium');
    const hard = depths('hard');
    assert.deepEqual(medium, [6, 4, 3, 4, 10, 6, 5, 3, 6, 3]);
    assert.deepEqual(hard, [13, 10, 12, 12, 11, 15, 7, 14, 11, 14]);
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    assert.ok(mean(hard) > mean(medium), 'hard solver depth must exceed medium solver depth');
}

function timedTracker(options = {}) {
    let now = 1_000;
    const tracker = new TruckEscape2AbilityTracker({
        catalog: allLevels,
        now: () => now,
        ...options,
    });
    return {
        tracker,
        tick(ms) { now += ms; },
        now() { return now; },
    };
}

function playReference(clock, level, gapMs = 4_000) {
    const model = new TruckEscape2BoardModel(level);
    const reference = TRUCK_ESCAPE_2_REFERENCE_SOLUTIONS[level.id];
    clock.tracker.startAttempt(level, model);
    for (const move of reference.moves) {
        clock.tick(gapMs);
        assert.equal(model.move(move.vehicleId, move.delta), true);
        clock.tracker.recordMove(model, {
            vehicleId: move.vehicleId,
            attemptedDelta: move.delta,
            appliedDelta: move.delta,
            accepted: true,
            interactionDurationMs: 350,
        });
    }
    return model;
}

function verifyOptimalAttemptAndSerialization() {
    const clock = timedTracker();
    playReference(clock, TRUCK_ESCAPE_2_EASY_LEVEL_1);
    const history = clock.tracker.getAttemptHistory();
    assert.equal(history.length, 1);
    const report = history[0];
    assert.equal(report.endReason, 'completed');
    assert.equal(report.metrics.completed, true);
    assert.equal(report.metrics.acceptedMoves, 4);
    assert.equal(report.metrics.movedCells, 7);
    assert.equal(report.metrics.referenceMoves, 4);
    assert.equal(report.finalProgress.referenceVersion, 'truck2-bfs-v1');
    assert.equal(report.metrics.excessMoves, 0);
    assert.equal(report.metrics.stepEfficiency, 100);
    assert.equal(report.metrics.currentProgressRatio, 1);
    assert.equal(report.metrics.referenceMoveMatchRate, 1);
    assert.equal(report.metrics.invalidOperations, 0);
    assert.equal(report.metrics.activeThinkingTimeMs, 16_000);
    assert.equal(report.metrics.effectiveMsPerMove, 4_000);
    assert.equal(report.score.dimensions.planning, 100);
    assert.ok(report.score.abilityScore >= 60 && report.score.abilityScore <= 100);

    const encoded = JSON.stringify(clock.tracker.exportData());
    const decoded = JSON.parse(encoded);
    assert.equal(decoded.schemaVersion, 1);
    assert.equal(decoded.attempts[0].operations.length, 4);
    assert.equal(decoded.aggregate.catalogLevels, 30);
    assert.equal(decoded.aggregate.completedChallengeCredits, 10);
    assert.ok(decoded.aggregate.leaderboardScore >= 10_000_000);

    const restored = timedTracker();
    restored.tracker.restoreData(decoded);
    assert.equal(restored.tracker.getAttemptHistory().length, 1);
    assert.equal(restored.tracker.getAggregate(false).completedChallengeCredits, 10);

    const derivedFieldsEdited = structuredClone(decoded);
    derivedFieldsEdited.attempts[0].metrics.acceptedMoves = 999_999;
    derivedFieldsEdited.attempts[0].score.abilityScore = 0;
    derivedFieldsEdited.aggregate.leaderboardScore = Number.MAX_SAFE_INTEGER;
    const recomputed = timedTracker();
    recomputed.tracker.restoreData(derivedFieldsEdited);
    assert.equal(recomputed.tracker.getAttemptHistory()[0].metrics.acceptedMoves, 4);
    assert.equal(recomputed.tracker.getAttemptHistory()[0].score.abilityScore, report.score.abilityScore);

    assert.throws(
        () => restored.tracker.restoreData({ ...decoded, schemaVersion: 999 }),
        /不支持的数据版本/,
    );
    assert.throws(
        () => restored.tracker.restoreData({ ...decoded, scoringVersion: 'edited-formula' }),
        /不支持的评分版本/,
    );
    const badDifficulty = structuredClone(decoded);
    badDifficulty.attempts[0].difficulty = 'hard';
    assert.throws(() => restored.tracker.restoreData(badDifficulty), /关卡元数据不匹配/);
    const brokenOperation = structuredClone(decoded);
    brokenOperation.attempts[0].operations[0] = null;
    assert.throws(() => restored.tracker.restoreData(brokenOperation), /操作 1 无效/);
    assert.equal(restored.tracker.getAttemptHistory().length, 1, 'failed restore must be atomic');
}

function verifyInvalidReverseRestartAndCompletionBand() {
    const clock = timedTracker();
    const level = TRUCK_ESCAPE_2_EASY_LEVEL_1;
    const model = new TruckEscape2BoardModel(level);
    clock.tracker.startAttempt(level, model);

    // Zero-snap drag is recorded but does not become a valid solution step.
    clock.tick(100);
    const invalid = clock.tracker.recordMove(model, {
        vehicleId: 'sand_semi',
        attemptedDelta: 0,
        appliedDelta: 0,
        accepted: false,
        invalidReason: 'below-snap-threshold',
    });
    assert.equal(invalid.type, 'invalid-move');

    clock.tick(2_000);
    assert.equal(model.move('sand_semi', -1), true);
    clock.tracker.recordMove(model, {
        vehicleId: 'sand_semi', attemptedDelta: -1, appliedDelta: -1, accepted: true,
    });
    clock.tick(2_000);
    assert.equal(model.move('sand_semi', 1), true);
    const reverse = clock.tracker.recordMove(model, {
        vehicleId: 'sand_semi', attemptedDelta: 1, appliedDelta: 1, accepted: true,
    });
    assert.equal(reverse.immediateReversal, true);
    assert.equal(reverse.repeatedState, true);

    const active = clock.tracker.getCurrentAttempt();
    assert.equal(active.metrics.invalidOperations, 1);
    assert.equal(active.metrics.acceptedMoves, 2);
    assert.equal(active.metrics.immediateReversals, 1);
    assert.equal(active.metrics.inferredUndoCount, 1);
    assert.equal(active.metrics.currentProgressRatio, 0);
    assert.equal(active.metrics.maxProgressRatio, 0.25);
    assert.ok(active.score.abilityScore < 50);

    const restarted = clock.tracker.recordRestart();
    assert.equal(restarted.endReason, 'restarted');
    assert.equal(restarted.metrics.restartCount, 1);
    const incompleteScore = restarted.score.abilityScore;

    playReference(clock, level, 8_000);
    const completed = clock.tracker.getAttemptHistory().at(-1);
    assert.ok(completed.score.abilityScore >= 60);
    assert.ok(completed.score.abilityScore > incompleteScore, 'completion band must dominate incomplete play');
}

function verifyAntiFarmAndDifficultyCredits() {
    const clock = timedTracker();
    const easy = TRUCK_ESCAPE_2_EASY_LEVEL_1;
    playReference(clock, easy, 3_000);
    const firstAggregate = clock.tracker.getAggregate(false);
    const firstScore = firstAggregate.leaderboardScore;
    playReference(clock, easy, 2_000);
    const replayAggregate = clock.tracker.getAggregate(false);
    assert.equal(replayAggregate.completedChallengeCredits, 10, 'same level must not add credits twice');
    assert.equal(replayAggregate.stabilityScore, firstAggregate.stabilityScore, 'same-level farming must not inflate cross-level stability');
    assert.ok(replayAggregate.leaderboardScore >= firstScore, 'a better replay may improve only low-order quality');

    const hard = getTruckEscape2Levels('hard')[0];
    playReference(clock, hard, 5_000);
    const crossDifficulty = clock.tracker.getAggregate(false);
    assert.equal(crossDifficulty.completedChallengeCredits, 26);
    assert.equal(crossDifficulty.uniqueLevelsCompleted, 2);
    assert.equal(crossDifficulty.byDifficulty.easy.uniqueLevelsCompleted, 1);
    assert.equal(crossDifficulty.byDifficulty.hard.uniqueLevelsCompleted, 1);
}

function verifyFailedRetriesReduceRankingQuality() {
    const level = TRUCK_ESCAPE_2_EASY_LEVEL_1;
    const direct = timedTracker();
    playReference(direct, level, 3_000);

    const retried = timedTracker();
    for (let attempt = 0; attempt < 20; attempt++) {
        const model = new TruckEscape2BoardModel(level);
        const attemptId = retried.tracker.startAttempt(level, model, attempt === 0 ? 'initial' : 'restart');
        retried.tick(100);
        retried.tracker.recordRestart(attemptId);
    }
    playReference(retried, level, 3_000);

    const directAggregate = direct.tracker.getAggregate(false);
    const retriedAggregate = retried.tracker.getAggregate(false);
    const retriedLevel = retried.tracker.getLevelHistory(false)[0];
    assert.equal(directAggregate.completedChallengeCredits, retriedAggregate.completedChallengeCredits);
    assert.equal(retriedLevel.attemptsToFirstCompletion, 21);
    assert.equal(retriedLevel.firstTryCompleted, false);
    assert.ok(retriedLevel.retryEfficiencyScore < 25);
    assert.ok(retriedAggregate.overallAbilityScore < directAggregate.overallAbilityScore);
    assert.ok(retriedAggregate.leaderboardScore < directAggregate.leaderboardScore);
}

function verifyPostCompletionExitAndAttemptOwnership() {
    const level = TRUCK_ESCAPE_2_EASY_LEVEL_1;
    const completedClock = timedTracker();
    playReference(completedClock, level, 2_000);
    const completedAttemptId = completedClock.tracker.getAttemptHistory()[0].attemptId;
    assert.equal(completedClock.tracker.getAggregate(false).totalExits, 0);
    completedClock.tick(500);
    completedClock.tracker.recordExit(completedAttemptId);
    completedClock.tracker.recordExit(completedAttemptId);
    assert.equal(completedClock.tracker.getAggregate(false).totalExits, 1, 'post-completion exit is counted once');
    const exitSnapshot = JSON.parse(JSON.stringify(completedClock.tracker.exportData()));
    assert.equal(exitSnapshot.controlEvents.length, 1);
    const restored = timedTracker();
    restored.tracker.restoreData(exitSnapshot);
    assert.equal(restored.tracker.getAggregate(false).totalExits, 1);
    const duplicateControl = structuredClone(exitSnapshot);
    duplicateControl.controlEvents.push({
        ...duplicateControl.controlEvents[0],
        sequence: 2,
    });
    assert.throws(() => restored.tracker.restoreData(duplicateControl), /引用无效或重复/);

    const activeExit = timedTracker();
    const activeExitModel = new TruckEscape2BoardModel(level);
    const activeExitId = activeExit.tracker.startAttempt(level, activeExitModel);
    activeExit.tracker.recordExit(activeExitId);
    activeExit.tracker.recordExit(activeExitId);
    assert.equal(activeExit.tracker.getAggregate(false).totalExits, 1, 'active exit is idempotent');
    assert.equal(activeExit.tracker.exportData().controlEvents.length, 0);

    const ownership = timedTracker();
    const firstModel = new TruckEscape2BoardModel(level);
    const firstId = ownership.tracker.startAttempt(level, firstModel);
    ownership.tick(100);
    const secondModel = new TruckEscape2BoardModel(level);
    const secondId = ownership.tracker.startAttempt(level, secondModel, 'restart');
    assert.notEqual(firstId, secondId);
    assert.equal(ownership.tracker.getAttemptHistory()[0].endReason, 'interrupted');
    assert.equal(ownership.tracker.interruptActiveAttempt(firstId), null);
    assert.equal(ownership.tracker.activeAttemptId, secondId);
    assert.throws(() => ownership.tracker.recordMove(secondModel, {
        vehicleId: 'sand_semi',
        attemptedDelta: 0,
        appliedDelta: 0,
        accepted: false,
        invalidReason: 'below-snap-threshold',
    }, firstId), /单局所有权不匹配/);
    assert.equal(ownership.tracker.activeAttemptId, secondId);
    ownership.tracker.interruptActiveAttempt(secondId);
}

function verifyIdleCannotImproveTimeScore() {
    const fast = timedTracker();
    const fastModel = new TruckEscape2BoardModel(TRUCK_ESCAPE_2_EASY_LEVEL_1);
    fast.tracker.startAttempt(fastModel.level, fastModel);
    fast.tick(4_000);
    fastModel.move('sand_semi', -1);
    fast.tracker.recordMove(fastModel, {
        vehicleId: 'sand_semi', attemptedDelta: -1, appliedDelta: -1, accepted: true,
    });

    const idle = timedTracker();
    const idleModel = new TruckEscape2BoardModel(TRUCK_ESCAPE_2_EASY_LEVEL_1);
    idle.tracker.startAttempt(idleModel.level, idleModel);
    idle.tick(3_600_000);
    idleModel.move('sand_semi', -1);
    idle.tracker.recordMove(idleModel, {
        vehicleId: 'sand_semi', attemptedDelta: -1, appliedDelta: -1, accepted: true,
    });
    const fastTime = fast.tracker.getCurrentAttempt().score.dimensions.timeEfficiency;
    const idleTime = idle.tracker.getCurrentAttempt().score.dimensions.timeEfficiency;
    assert.ok(idleTime < fastTime, 'idle time must reduce time efficiency');
}

function verifyMissingReferenceFallback() {
    const clock = timedTracker({
        catalog: [TRUCK_ESCAPE_2_EASY_LEVEL_1],
        references: {},
    });
    playReference(clock, TRUCK_ESCAPE_2_EASY_LEVEL_1, 4_000);
    const first = clock.tracker.getAttemptHistory()[0];
    assert.equal(first.metrics.referenceSource, 'structural-estimate');
    assert.equal(first.metrics.referenceMoves, null);
    assert.equal(first.metrics.stepEfficiency, 70);
    assert.ok(Number.isFinite(first.score.abilityScore));

    const model = new TruckEscape2BoardModel(TRUCK_ESCAPE_2_EASY_LEVEL_1);
    clock.tracker.startAttempt(TRUCK_ESCAPE_2_EASY_LEVEL_1, model, 'restart');
    const second = clock.tracker.getCurrentAttempt();
    assert.equal(second.metrics.referenceSource, 'historical-best');
    assert.equal(second.metrics.referenceMoves, 4);
    const activeSnapshot = JSON.parse(JSON.stringify(clock.tracker.exportData()));
    const restored = timedTracker({
        catalog: [TRUCK_ESCAPE_2_EASY_LEVEL_1],
        references: {},
    });
    restored.tracker.restoreData(activeSnapshot);
    assert.equal(restored.tracker.getAttemptHistory().at(-1).endReason, 'interrupted');
    clock.tracker.recordExit();
}

verifyAllReferences();
verifySolverDepthCalibration();
verifyOptimalAttemptAndSerialization();
verifyInvalidReverseRestartAndCompletionBand();
verifyAntiFarmAndDifficultyCredits();
verifyFailedRetriesReduceRankingQuality();
verifyPostCompletionExitAndAttemptOwnership();
verifyIdleCannotImproveTimeScore();
verifyMissingReferenceFallback();

console.log('Truck Escape 2 ability tests passed.');
