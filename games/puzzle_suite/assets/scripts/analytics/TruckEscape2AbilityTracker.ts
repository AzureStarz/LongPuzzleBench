import {
    getTruckEscape2Levels,
} from '../data/TruckEscape2Data';
import type {
    TruckEscape2Difficulty,
    TruckEscape2LevelData,
} from '../data/TruckEscape2Data';
import { TRUCK_ESCAPE_2_REFERENCE_SOLUTIONS } from '../data/TruckEscape2ReferenceSolutions';
import { TruckEscape2BoardModel } from '../game/TruckEscape2BoardModel';
import type {
    TruckEscape2AbilityInspectorSnapshot,
    TruckEscape2AbilitySnapshot,
    TruckEscape2AggregateReport,
    TruckEscape2AttemptEndReason,
    TruckEscape2AttemptMetrics,
    TruckEscape2AttemptReport,
    TruckEscape2AttemptScore,
    TruckEscape2AttemptStartReason,
    TruckEscape2ControlEvent,
    TruckEscape2DecisionTimeStats,
    TruckEscape2DifficultyAggregate,
    TruckEscape2InvalidMoveReason,
    TruckEscape2LevelHistory,
    TruckEscape2OperationRecord,
    TruckEscape2OperationType,
    TruckEscape2ProgressSnapshot,
    TruckEscape2ReferenceSolution,
} from './TruckEscape2AbilityTypes';
import {
    TRUCK_ESCAPE_2_ABILITY_SCHEMA_VERSION,
    TRUCK_ESCAPE_2_SCORING_VERSION,
} from './TruckEscape2AbilityTypes';
import {
    TruckEscape2ProgressAnalyzer,
} from './TruckEscape2ProgressAnalyzer';

const ACTIVE_DECISION_CAP_MS = 30_000;
const RAPID_REPEAT_THRESHOLD_MS = 250;
const EPSILON = 1e-9;
const ATTEMPT_START_REASONS = new Set<TruckEscape2AttemptStartReason>([
    'initial',
    'restart',
    'next-level',
    'replay-after-complete',
    'difficulty-change',
    'restored',
]);
const ATTEMPT_END_REASONS = new Set<TruckEscape2AttemptEndReason>([
    'completed',
    'restarted',
    'exited',
    'interrupted',
]);
const OPERATION_TYPES = new Set<TruckEscape2OperationType>([
    'move',
    'invalid-move',
    'hint',
    'undo',
    'restart',
    'exit',
]);
const INVALID_MOVE_REASONS = new Set<TruckEscape2InvalidMoveReason>([
    'blocked',
    'below-snap-threshold',
    'cancelled',
    'model-rejected',
    'unknown',
]);

/** Declared challenge weights; optimal move count is intentionally separate. */
export const TRUCK_ESCAPE_2_DIFFICULTY_WEIGHT: Record<TruckEscape2Difficulty, number> = {
    easy: 1,
    medium: 1.3,
    hard: 1.6,
};

/** Integer completion credits occupy the high-order leaderboard score digits. */
export const TRUCK_ESCAPE_2_DIFFICULTY_CREDITS: Record<TruckEscape2Difficulty, number> = {
    easy: 10,
    medium: 13,
    hard: 16,
};

const TARGET_DECISION_MS: Record<TruckEscape2Difficulty, number> = {
    easy: 7_000,
    medium: 8_000,
    hard: 9_000,
};

interface MutableAttempt {
    attemptId: string;
    level: TruckEscape2LevelData;
    startReason: TruckEscape2AttemptStartReason;
    startedAtMs: number;
    lastOperationAtMs: number;
    initialProgress: TruckEscape2ProgressSnapshot;
    currentProgress: TruckEscape2ProgressSnapshot;
    reference: TruckEscape2ReferenceSolution | null;
    historicalBestMoves: number | null;
    operations: TruckEscape2OperationRecord[];
    stateVisits: Record<string, number>;
}

interface OperationInput {
    vehicleId: string | null;
    attemptedDelta: number | null;
    appliedDelta: number | null;
    accepted: boolean;
    invalidReason: TruckEscape2InvalidMoveReason | null;
    inputClamped: boolean;
    interactionDurationMs: number | null;
}

export interface TruckEscape2MoveTrackingInput {
    vehicleId: string;
    attemptedDelta: number;
    appliedDelta: number;
    accepted: boolean;
    invalidReason?: TruckEscape2InvalidMoveReason | null;
    inputClamped?: boolean;
    interactionDurationMs?: number | null;
}

export interface TruckEscape2UndoTrackingInput extends TruckEscape2MoveTrackingInput {
    accepted: boolean;
}

export interface TruckEscape2AbilityTrackerOptions {
    now?: () => number;
    catalog?: readonly TruckEscape2LevelData[];
    references?: Readonly<Record<string, TruckEscape2ReferenceSolution>>;
    activeDecisionCapMs?: number;
    rapidRepeatThresholdMs?: number;
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
}

function round(value: number, places: number = 4): number {
    if (!Number.isFinite(value)) return 0;
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
}

function average(values: readonly number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
    if (values.length < 2) return 0;
    const mean = average(values);
    return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function percentile(values: readonly number[], ratio: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const position = clamp(ratio, 0, 1) * (sorted.length - 1);
    const low = Math.floor(position);
    const high = Math.ceil(position);
    if (low === high) return sorted[low];
    const fraction = position - low;
    return sorted[low] * (1 - fraction) + sorted[high] * fraction;
}

function decisionTimeStats(values: readonly number[]): TruckEscape2DecisionTimeStats {
    const mean = average(values);
    const deviation = standardDeviation(values);
    return {
        samples: values.length,
        meanMs: round(mean, 2),
        medianMs: round(percentile(values, 0.5), 2),
        standardDeviationMs: round(deviation, 2),
        coefficientOfVariation: round(mean > 0 ? deviation / mean : 0),
        p90Ms: round(percentile(values, 0.9), 2),
    };
}

function fullCatalog(): TruckEscape2LevelData[] {
    const catalog: TruckEscape2LevelData[] = [];
    for (const difficulty of ['easy', 'medium', 'hard'] as TruckEscape2Difficulty[]) {
        catalog.push(...getTruckEscape2Levels(difficulty));
    }
    return catalog;
}

function emptyDifficultyAggregate(difficulty: TruckEscape2Difficulty, catalogLevels: number): TruckEscape2DifficultyAggregate {
    return {
        difficulty,
        difficultyWeight: TRUCK_ESCAPE_2_DIFFICULTY_WEIGHT[difficulty],
        catalogLevels,
        uniqueLevelsAttempted: 0,
        uniqueLevelsCompleted: 0,
        attempts: 0,
        completions: 0,
        completionRate: 0,
        evaluatedAbilityScore: 0,
        catalogAbilityContribution: 0,
        meanStepEfficiency: 0,
        meanTimeEfficiency: 0,
        meanPlanningScore: 0,
        meanOperationQuality: 0,
        meanIndependenceScore: 0,
    };
}

function operationChangesState(operation: TruckEscape2OperationRecord): boolean {
    return operation.accepted && operation.before.stateKey !== operation.after.stateKey;
}

function levelHasVehicle(level: TruckEscape2LevelData, vehicleId: string): boolean {
    return level.vehicles.some((vehicle) => vehicle.id === vehicleId);
}

function compareAttemptQuality(left: TruckEscape2AttemptReport, right: TruckEscape2AttemptReport): number {
    if (left.metrics.completed !== right.metrics.completed) return left.metrics.completed ? 1 : -1;
    if (left.score.abilityScore !== right.score.abilityScore) {
        return left.score.abilityScore > right.score.abilityScore ? 1 : -1;
    }
    if (left.metrics.hintUses !== right.metrics.hintUses) return left.metrics.hintUses < right.metrics.hintUses ? 1 : -1;
    if (left.metrics.acceptedMoves !== right.metrics.acceptedMoves) return left.metrics.acceptedMoves < right.metrics.acceptedMoves ? 1 : -1;
    if (left.metrics.activeThinkingTimeMs !== right.metrics.activeThinkingTimeMs) {
        return left.metrics.activeThinkingTimeMs < right.metrics.activeThinkingTimeMs ? 1 : -1;
    }
    return left.startedAtMs <= right.startedAtMs ? 1 : -1;
}

/**
 * Pure session/history evaluator for Truck Escape 2.
 *
 * The controller supplies semantic model commits. This class never reads UI
 * nodes, never changes the board, and never invokes the expensive BFS solver
 * during play. All exported objects contain only JSON-compatible primitives.
 */
export class TruckEscape2AbilityTracker {
    private static _instance: TruckEscape2AbilityTracker | null = null;

    static get instance(): TruckEscape2AbilityTracker {
        if (!this._instance) this._instance = new TruckEscape2AbilityTracker();
        return this._instance;
    }

    private readonly _nowProvider: () => number;
    private readonly _catalog: TruckEscape2LevelData[];
    private readonly _catalogById = new Map<string, TruckEscape2LevelData>();
    private readonly _references: Readonly<Record<string, TruckEscape2ReferenceSolution>>;
    private readonly _activeDecisionCapMs: number;
    private readonly _rapidRepeatThresholdMs: number;
    private _history: TruckEscape2AttemptReport[] = [];
    private _controlEvents: TruckEscape2ControlEvent[] = [];
    private _current: MutableAttempt | null = null;
    private _attemptSequence = 0;
    private _lastTimestampMs = 0;

    constructor(options: TruckEscape2AbilityTrackerOptions = {}) {
        this._nowProvider = options.now ?? (() => Date.now());
        this._catalog = [...(options.catalog ?? fullCatalog())];
        for (const level of this._catalog) this._catalogById.set(level.id, level);
        this._references = options.references ?? TRUCK_ESCAPE_2_REFERENCE_SOLUTIONS;
        this._activeDecisionCapMs = Math.max(1_000, options.activeDecisionCapMs ?? ACTIVE_DECISION_CAP_MS);
        this._rapidRepeatThresholdMs = Math.max(0, options.rapidRepeatThresholdMs ?? RAPID_REPEAT_THRESHOLD_MS);
    }

    get activeLevelId(): string | null {
        return this._current?.level.id ?? null;
    }

    get activeAttemptId(): string | null {
        return this._current?.attemptId ?? null;
    }

    startAttempt(
        level: TruckEscape2LevelData,
        model: TruckEscape2BoardModel,
        startReason: TruckEscape2AttemptStartReason = 'initial',
    ): string {
        this._assertModelLevel(level, model);
        if (this._current) this._finalize('interrupted', this._timestamp());
        const now = this._timestamp();
        const reference = this._references[level.id] ?? null;
        const historicalBestMoves = reference ? null : this._historicalBestMoves(level.id);
        const initialProgress = TruckEscape2ProgressAnalyzer.analyze(model, {
            solution: reference,
            historicalBestMoves,
        });
        this._attemptSequence++;
        this._current = {
            attemptId: `truck2-${now}-${this._attemptSequence}`,
            level,
            startReason,
            startedAtMs: now,
            lastOperationAtMs: now,
            initialProgress,
            currentProgress: initialProgress,
            reference,
            historicalBestMoves,
            operations: [],
            stateVisits: { [initialProgress.stateKey]: 1 },
        };
        return this._current.attemptId;
    }

    recordMove(
        model: TruckEscape2BoardModel,
        input: TruckEscape2MoveTrackingInput,
        expectedAttemptId?: string | null,
    ): TruckEscape2OperationRecord {
        this._assertAttemptOwner(expectedAttemptId);
        return this._recordStateOperation('move', model, input);
    }

    /** Explicit undo hook for a future non-UI caller; current gameplay has no undo control. */
    recordUndo(
        model: TruckEscape2BoardModel,
        input: TruckEscape2UndoTrackingInput,
        expectedAttemptId?: string | null,
    ): TruckEscape2OperationRecord {
        this._assertAttemptOwner(expectedAttemptId);
        return this._recordStateOperation('undo', model, input);
    }

    /** Explicit hint hook. Merely owning hint tokens never increments this metric. */
    recordHintUse(expectedAttemptId?: string | null): TruckEscape2OperationRecord {
        this._assertAttemptOwner(expectedAttemptId);
        const current = this._requireCurrent();
        return this._appendOperation('hint', current.currentProgress, {
            vehicleId: null,
            attemptedDelta: null,
            appliedDelta: null,
            accepted: true,
            invalidReason: null,
            inputClamped: false,
            interactionDurationMs: null,
        });
    }

    recordRestart(expectedAttemptId?: string | null): TruckEscape2AttemptReport | null {
        if (!this._current) return null;
        this._assertAttemptOwner(expectedAttemptId);
        this._appendOperation('restart', this._current.currentProgress, {
            vehicleId: null,
            attemptedDelta: null,
            appliedDelta: null,
            accepted: true,
            invalidReason: null,
            inputClamped: false,
            interactionDurationMs: null,
        });
        return this._finalize('restarted', this._lastTimestampMs);
    }

    recordExit(expectedAttemptId?: string | null): TruckEscape2AttemptReport | null {
        if (!this._current) {
            const related = this._history[this._history.length - 1] ?? null;
            // A no-current exit is meaningful only on the completion overlay.
            // Exited/restarted/interrupted attempts already carry their own end
            // semantics and must not gain a second standalone exit event.
            if (!related?.metrics.completed || (expectedAttemptId && related.attemptId !== expectedAttemptId)) {
                return null;
            }
            if (this._controlEvents.some((event) => event.relatedAttemptId === related.attemptId)) return null;
            this._controlEvents.push({
                sequence: this._controlEvents.length + 1,
                type: 'exit',
                timestampMs: this._timestamp(),
                relatedAttemptId: related.attemptId,
                levelId: related.levelId,
                afterCompletion: true,
            });
            return null;
        }
        this._assertAttemptOwner(expectedAttemptId);
        this._appendOperation('exit', this._current.currentProgress, {
            vehicleId: null,
            attemptedDelta: null,
            appliedDelta: null,
            accepted: true,
            invalidReason: null,
            inputClamped: false,
            interactionDurationMs: null,
        });
        return this._finalize('exited', this._lastTimestampMs);
    }

    interruptActiveAttempt(expectedAttemptId?: string | null): TruckEscape2AttemptReport | null {
        if (!this._current) return null;
        if (expectedAttemptId && this._current.attemptId !== expectedAttemptId) return null;
        return this._finalize('interrupted', this._timestamp());
    }

    getCurrentAttempt(): TruckEscape2AttemptReport | null {
        return this._current ? this._buildReport(this._current, this._timestamp(), null) : null;
    }

    getAttemptHistory(): TruckEscape2AttemptReport[] {
        return this._history.map((attempt) => this._jsonClone(attempt));
    }

    getLevelHistory(includeCurrent: boolean = true): TruckEscape2LevelHistory[] {
        const reports = this._reportsForAggregation(includeCurrent);
        const grouped = new Map<string, TruckEscape2AttemptReport[]>();
        for (const report of reports) {
            const list = grouped.get(report.levelId) ?? [];
            list.push(report);
            grouped.set(report.levelId, list);
        }
        return Array.from(grouped.values())
            .map((attempts) => this._buildLevelHistory(attempts))
            .sort((a, b) => {
                const difficultyOrder = { easy: 0, medium: 1, hard: 2 };
                return difficultyOrder[a.difficulty] - difficultyOrder[b.difficulty]
                    || a.levelNumber - b.levelNumber;
            });
    }

    getAggregate(includeCurrent: boolean = true): TruckEscape2AggregateReport {
        return this._buildAggregate(this._reportsForAggregation(includeCurrent));
    }

    getInspectorSnapshot(): TruckEscape2AbilityInspectorSnapshot {
        const current = this.getCurrentAttempt();
        return {
            schemaVersion: TRUCK_ESCAPE_2_ABILITY_SCHEMA_VERSION,
            scoringVersion: TRUCK_ESCAPE_2_SCORING_VERSION,
            currentAttemptId: current?.attemptId ?? null,
            currentMetrics: current?.metrics ?? null,
            currentScore: current?.score ?? null,
            aggregate: this.getAggregate(true),
        };
    }

    exportData(): TruckEscape2AbilitySnapshot {
        const currentAttempt = this.getCurrentAttempt();
        const snapshot: TruckEscape2AbilitySnapshot = {
            schemaVersion: TRUCK_ESCAPE_2_ABILITY_SCHEMA_VERSION,
            scoringVersion: TRUCK_ESCAPE_2_SCORING_VERSION,
            exportedAtMs: this._timestamp(),
            attempts: this.getAttemptHistory(),
            currentAttempt,
            controlEvents: this._controlEvents.map((event) => ({ ...event })),
            levelHistory: this.getLevelHistory(true),
            aggregate: this.getAggregate(true),
        };
        return this._jsonClone(snapshot);
    }

    /**
     * Restores history by replaying raw semantic operations against the board
     * model. Derived progress, metrics, and scores from storage are deliberately
     * ignored and recomputed, so stale or edited ranking fields cannot be
     * trusted accidentally. A live exported attempt becomes interrupted because
     * resuming its model and clocks implicitly would be unsafe.
     */
    restoreData(data: unknown): void {
        if (!data || typeof data !== 'object') throw new Error('[TruckEscape2Ability] 无效的快照');
        const snapshot = data as Partial<TruckEscape2AbilitySnapshot>;
        if (snapshot.schemaVersion !== TRUCK_ESCAPE_2_ABILITY_SCHEMA_VERSION) {
            throw new Error(`[TruckEscape2Ability] 不支持的数据版本：${String(snapshot.schemaVersion)}`);
        }
        if (snapshot.scoringVersion !== TRUCK_ESCAPE_2_SCORING_VERSION) {
            throw new Error(`[TruckEscape2Ability] 不支持的评分版本：${String(snapshot.scoringVersion)}`);
        }
        if (!this._isTimestamp(snapshot.exportedAtMs)) {
            throw new Error('[TruckEscape2Ability] exportedAtMs 无效');
        }
        if (!Array.isArray(snapshot.attempts)) throw new Error('[TruckEscape2Ability] attempts 必须是数组');
        if (!Array.isArray(snapshot.controlEvents)) throw new Error('[TruckEscape2Ability] controlEvents 必须是数组');

        const previousHistory = this._history;
        const previousControlEvents = this._controlEvents;
        const previousCurrent = this._current;
        const previousAttemptSequence = this._attemptSequence;
        const previousLastTimestamp = this._lastTimestampMs;
        try {
            this._history = [];
            this._controlEvents = [];
            this._current = null;
            this._attemptSequence = 0;
            this._lastTimestampMs = 0;

            const seenAttemptIds = new Set<string>();
            let previousAttemptEndedAtMs = 0;
            for (const candidate of snapshot.attempts) {
                const restored = this._rebuildStoredAttempt(candidate, true, snapshot.exportedAtMs);
                if (seenAttemptIds.has(restored.attemptId)) {
                    throw new Error(`[TruckEscape2Ability] 重复的 attemptId：${restored.attemptId}`);
                }
                if (restored.startedAtMs < previousAttemptEndedAtMs) {
                    throw new Error(`[TruckEscape2Ability] 单局历史顺序无效：${restored.attemptId}`);
                }
                seenAttemptIds.add(restored.attemptId);
                this._history.push(restored);
                previousAttemptEndedAtMs = restored.endedAtMs ?? restored.startedAtMs;
            }
            if (snapshot.currentAttempt !== null && snapshot.currentAttempt !== undefined) {
                const interrupted = this._rebuildStoredAttempt(
                    snapshot.currentAttempt,
                    false,
                    snapshot.exportedAtMs,
                );
                if (seenAttemptIds.has(interrupted.attemptId)) {
                    throw new Error(`[TruckEscape2Ability] 重复的 attemptId：${interrupted.attemptId}`);
                }
                if (interrupted.startedAtMs < previousAttemptEndedAtMs) {
                    throw new Error(`[TruckEscape2Ability] 当前单局顺序无效：${interrupted.attemptId}`);
                }
                seenAttemptIds.add(interrupted.attemptId);
                this._history.push(interrupted);
            }
            this._controlEvents = this._restoreControlEvents(
                snapshot.controlEvents,
                seenAttemptIds,
                snapshot.exportedAtMs,
            );
            this._current = null;
            this._attemptSequence = this._history.length;
            this._lastTimestampMs = Math.max(
                snapshot.exportedAtMs,
                ...this._history.map((attempt) => attempt.endedAtMs ?? attempt.startedAtMs),
                ...this._controlEvents.map((event) => event.timestampMs),
            );
        } catch (error) {
            this._history = previousHistory;
            this._controlEvents = previousControlEvents;
            this._current = previousCurrent;
            this._attemptSequence = previousAttemptSequence;
            this._lastTimestampMs = previousLastTimestamp;
            throw error;
        }
    }

    clear(): void {
        this._history = [];
        this._controlEvents = [];
        this._current = null;
        this._attemptSequence = 0;
        this._lastTimestampMs = 0;
    }

    private _recordStateOperation(
        type: 'move' | 'undo',
        model: TruckEscape2BoardModel,
        input: TruckEscape2MoveTrackingInput,
    ): TruckEscape2OperationRecord {
        const current = this._requireCurrent();
        this._assertModelLevel(current.level, model);
        const after = TruckEscape2ProgressAnalyzer.analyze(model, {
            solution: current.reference,
            historicalBestMoves: current.historicalBestMoves,
        });
        const stateChanged = after.stateKey !== current.currentProgress.stateKey;
        const accepted = !!input.accepted && stateChanged;
        const operation = this._appendOperation(accepted ? type : 'invalid-move', after, {
            vehicleId: input.vehicleId,
            attemptedDelta: Number.isFinite(input.attemptedDelta) ? Math.trunc(input.attemptedDelta) : 0,
            appliedDelta: accepted && Number.isFinite(input.appliedDelta) ? Math.trunc(input.appliedDelta) : 0,
            accepted,
            invalidReason: accepted ? null : (input.invalidReason ?? 'unknown'),
            inputClamped: !!input.inputClamped,
            interactionDurationMs: input.interactionDurationMs ?? null,
        });
        if (after.complete && accepted && this._current) {
            this._finalize('completed', operation.timestampMs);
        }
        return operation;
    }

    private _appendOperation(
        type: TruckEscape2OperationType,
        after: TruckEscape2ProgressSnapshot,
        input: OperationInput,
    ): TruckEscape2OperationRecord {
        const current = this._requireCurrent();
        return this._appendOperationAt(current, type, after, input, this._timestamp());
    }

    private _appendOperationAt(
        current: MutableAttempt,
        type: TruckEscape2OperationType,
        after: TruckEscape2ProgressSnapshot,
        input: OperationInput,
        now: number,
    ): TruckEscape2OperationRecord {
        const before = current.currentProgress;
        const decisionTimeMs = Math.max(0, now - current.lastOperationAtMs);
        const previousComparable = [...current.operations]
            .reverse()
            .find((operation) => operation.vehicleId !== null);
        const previousStateMove = [...current.operations]
            .reverse()
            .find(operationChangesState);
        const seenState = current.stateVisits[after.stateKey] ?? 0;
        const stateChanged = before.stateKey !== after.stateKey;
        const repeatedOperation = !!previousComparable
            && previousComparable.vehicleId === input.vehicleId
            && previousComparable.appliedDelta === input.appliedDelta
            && previousComparable.before.stateKey === before.stateKey;
        const repeatedState = input.accepted && stateChanged && seenState > 0;
        const immediateReversal = input.accepted
            && stateChanged
            && !!previousStateMove
            && after.stateKey === previousStateMove.before.stateKey;
        const oscillation = immediateReversal
            && (seenState > 1 || !!previousStateMove?.immediateReversal);
        const progressDelta = after.progressRatio - before.progressRatio;
        const progressRegression = progressDelta < -EPSILON
            || (
                before.estimatedMovesRemaining !== null
                && after.estimatedMovesRemaining !== null
                && after.estimatedMovesRemaining > before.estimatedMovesRemaining
            );
        let referenceMoveMatch: boolean | null = null;
        if (
            input.accepted
            && current.reference
            && before.canonicalPathIndex !== null
            && before.canonicalPathIndex < current.reference.moves.length
        ) {
            const expected = current.reference.moves[before.canonicalPathIndex];
            referenceMoveMatch = expected.vehicleId === input.vehicleId
                && expected.delta === input.appliedDelta;
        }
        const suspiciousRapidRepeat = decisionTimeMs < this._rapidRepeatThresholdMs
            && (!input.accepted || repeatedOperation || repeatedState || immediateReversal);
        const duration = input.interactionDurationMs;
        const operation: TruckEscape2OperationRecord = {
            sequence: current.operations.length + 1,
            type,
            timestampMs: now,
            decisionTimeMs,
            interactionDurationMs: duration === null ? null : Math.max(0, Number(duration) || 0),
            accepted: input.accepted,
            invalidReason: input.invalidReason,
            vehicleId: input.vehicleId,
            attemptedDelta: input.attemptedDelta,
            appliedDelta: input.appliedDelta,
            movedCells: input.accepted ? Math.abs(input.appliedDelta ?? 0) : 0,
            inputClamped: input.inputClamped,
            before,
            after,
            progressDelta: round(progressDelta, 6),
            repeatedOperation,
            repeatedState,
            immediateReversal,
            oscillation,
            progressRegression,
            referenceMoveMatch,
            suspiciousRapidRepeat,
        };
        current.operations.push(operation);
        current.lastOperationAtMs = now;
        current.currentProgress = after;
        if (input.accepted && stateChanged) {
            current.stateVisits[after.stateKey] = seenState + 1;
        }
        return operation;
    }

    private _finalize(reason: TruckEscape2AttemptEndReason, endedAtMs: number): TruckEscape2AttemptReport {
        const current = this._requireCurrent();
        const report = this._buildReport(current, Math.max(current.startedAtMs, endedAtMs), reason);
        this._history.push(report);
        this._current = null;
        return report;
    }

    private _buildReport(
        attempt: MutableAttempt,
        now: number,
        endReason: TruckEscape2AttemptEndReason | null,
    ): TruckEscape2AttemptReport {
        const metrics = this._calculateMetrics(attempt, now);
        const score = this._calculateScore(attempt.level.difficulty, metrics);
        return {
            attemptId: attempt.attemptId,
            levelId: attempt.level.id,
            levelNumber: attempt.level.levelNumber,
            difficulty: attempt.level.difficulty,
            startReason: attempt.startReason,
            startedAtMs: attempt.startedAtMs,
            endedAtMs: endReason === null ? null : now,
            endReason,
            featureAvailability: { hint: false, undo: false },
            initialProgress: attempt.initialProgress,
            finalProgress: attempt.currentProgress,
            metrics,
            score,
            operations: [...attempt.operations],
        };
    }

    private _calculateMetrics(attempt: MutableAttempt, now: number): TruckEscape2AttemptMetrics {
        const stateOperations = attempt.operations.filter((operation) =>
            operation.type === 'move' || operation.type === 'invalid-move' || operation.type === 'undo');
        const acceptedMoves = stateOperations.filter(operationChangesState);
        const acceptedDecisionTimes: number[] = [];
        let previousAcceptedAt = attempt.startedAtMs;
        for (const operation of acceptedMoves) {
            acceptedDecisionTimes.push(Math.min(
                this._activeDecisionCapMs,
                Math.max(0, operation.timestampMs - previousAcceptedAt),
            ));
            previousAcceptedAt = operation.timestampMs;
        }
        const uniqueStates = new Set<string>([attempt.initialProgress.stateKey]);
        const uniqueVehicles = new Set<string>();
        let progressAdvances = 0;
        let progressPlateaus = 0;
        let progressRegressions = 0;
        let noProgressStreak = 0;
        let longestNoProgressStreak = 0;
        let maxProgressRatio = attempt.initialProgress.progressRatio;
        let deadlockEntries = 0;
        for (const operation of acceptedMoves) {
            uniqueStates.add(operation.after.stateKey);
            if (operation.vehicleId) uniqueVehicles.add(operation.vehicleId);
            maxProgressRatio = Math.max(maxProgressRatio, operation.after.progressRatio);
            const distanceBefore = operation.before.estimatedMovesRemaining;
            const distanceAfter = operation.after.estimatedMovesRemaining;
            const distanceImproved = distanceBefore !== null && distanceAfter !== null && distanceAfter < distanceBefore;
            const distanceRegressed = distanceBefore !== null && distanceAfter !== null && distanceAfter > distanceBefore;
            if (operation.progressDelta > EPSILON || distanceImproved) {
                progressAdvances++;
                noProgressStreak = 0;
            } else if (operation.progressRegression || distanceRegressed) {
                progressRegressions++;
                noProgressStreak++;
            } else {
                progressPlateaus++;
                noProgressStreak++;
            }
            longestNoProgressStreak = Math.max(longestNoProgressStreak, noProgressStreak);
            if (operation.before.deadlockStatus !== 'confirmed' && operation.after.deadlockStatus === 'confirmed') {
                deadlockEntries++;
            }
        }
        const totalDurationMs = Math.max(0, now - attempt.startedAtMs);
        const activeThinkingTimeMs = acceptedDecisionTimes.reduce((sum, value) => sum + value, 0);
        const invalidOperations = stateOperations.filter((operation) => !operation.accepted).length;
        const referenceMoves = attempt.initialProgress.referenceMoves;
        const completed = attempt.currentProgress.complete;
        let stepEfficiency = 0;
        if (referenceMoves !== null && referenceMoves > 0) {
            stepEfficiency = completed
                ? 100 * Math.min(1, referenceMoves / Math.max(1, acceptedMoves.length))
                : 100 * Math.min(
                    1,
                    (referenceMoves * attempt.currentProgress.progressRatio) / Math.max(1, acceptedMoves.length),
                );
        } else if (completed) {
            // No trustworthy baseline: keep the dimension neutral rather than
            // pretending the first observed completion is mathematically optimal.
            stepEfficiency = 70;
        } else if (acceptedMoves.length > 0) {
            stepEfficiency = 100 * attempt.currentProgress.progressRatio / acceptedMoves.length;
        }
        const matchOpportunities = acceptedMoves.filter((operation) => operation.referenceMoveMatch !== null);
        const matches = matchOpportunities.filter((operation) => operation.referenceMoveMatch).length;
        const firstOperationAt = attempt.operations[0]?.timestampMs ?? null;
        return {
            completed,
            currentProgressRatio: round(attempt.currentProgress.progressRatio, 6),
            maxProgressRatio: round(maxProgressRatio, 6),
            acceptedMoves: acceptedMoves.length,
            totalOperationAttempts: stateOperations.length,
            invalidOperations,
            invalidOperationRate: round(stateOperations.length > 0 ? invalidOperations / stateOperations.length : 0),
            movedCells: acceptedMoves.reduce((sum, operation) => sum + operation.movedCells, 0),
            uniqueVehiclesMoved: uniqueVehicles.size,
            uniqueStatesVisited: uniqueStates.size,
            repeatedOperations: stateOperations.filter((operation) => operation.repeatedOperation).length,
            repeatedStates: acceptedMoves.filter((operation) => operation.repeatedState).length,
            immediateReversals: acceptedMoves.filter((operation) => operation.immediateReversal).length,
            inferredUndoCount: acceptedMoves.filter((operation) => operation.type !== 'undo' && operation.immediateReversal).length,
            explicitUndoCount: acceptedMoves.filter((operation) => operation.type === 'undo').length,
            oscillations: acceptedMoves.filter((operation) => operation.oscillation).length,
            progressAdvances,
            progressPlateaus,
            progressRegressions,
            longestNoProgressStreak,
            deadlockEntries,
            hintUses: attempt.operations.filter((operation) => operation.type === 'hint').length,
            restartCount: attempt.operations.filter((operation) => operation.type === 'restart').length,
            exitCount: attempt.operations.filter((operation) => operation.type === 'exit').length,
            suspiciousRapidRepeats: stateOperations.filter((operation) => operation.suspiciousRapidRepeat).length,
            referenceMoves,
            referenceSource: attempt.currentProgress.referenceSource,
            excessMoves: completed && referenceMoves !== null
                ? Math.max(0, acceptedMoves.length - referenceMoves)
                : null,
            movesPerReference: referenceMoves !== null && referenceMoves > 0
                ? round(acceptedMoves.length / referenceMoves)
                : null,
            stepEfficiency: round(clamp(stepEfficiency, 0, 100)),
            referenceMoveMatches: matches,
            referenceMoveOpportunities: matchOpportunities.length,
            referenceMoveMatchRate: matchOpportunities.length > 0
                ? round(matches / matchOpportunities.length)
                : null,
            firstOperationDelayMs: firstOperationAt === null ? null : Math.max(0, firstOperationAt - attempt.startedAtMs),
            totalDurationMs,
            activeThinkingTimeMs,
            idleTimeMs: Math.max(0, totalDurationMs - activeThinkingTimeMs),
            effectiveMsPerMove: acceptedMoves.length > 0
                ? round(activeThinkingTimeMs / acceptedMoves.length, 2)
                : null,
            decisionTime: decisionTimeStats(acceptedDecisionTimes),
        };
    }

    private _calculateScore(
        difficulty: TruckEscape2Difficulty,
        metrics: TruckEscape2AttemptMetrics,
    ): TruckEscape2AttemptScore {
        const accepted = metrics.acceptedMoves;
        const total = metrics.totalOperationAttempts;
        const advanceRate = accepted > 0 ? metrics.progressAdvances / accepted : 0;
        const regressionRate = accepted > 0 ? metrics.progressRegressions / accepted : 0;
        const revisitRate = accepted > 0 ? metrics.repeatedStates / accepted : 0;
        const reversalRate = accepted > 0 ? metrics.immediateReversals / accepted : 0;
        const suspiciousRate = total > 0 ? metrics.suspiciousRapidRepeats / total : 0;
        const uniqueStateRatio = accepted > 0
            ? clamp((metrics.uniqueStatesVisited - 1) / accepted, 0, 1)
            : 0;
        const stallBase = Math.max(3, metrics.referenceMoves ?? 5);
        const stallSeverity = clamp(metrics.longestNoProgressStreak / stallBase, 0, 1);
        let planning = accepted > 0
            ? 100 * (
                0.45 * advanceRate
                + 0.25 * (1 - regressionRate)
                + 0.20 * (1 - revisitRate)
                + 0.10 * (1 - stallSeverity)
            )
            : 0;
        if (metrics.deadlockEntries > 0) planning *= 0.5;
        const validRate = total > 0 ? accepted / total : 0;
        const restartFactor = 1 / (1 + metrics.restartCount);
        const operationQuality = total > 0
            ? 100 * (
                0.40 * validRate
                + 0.20 * (1 - reversalRate)
                + 0.20 * uniqueStateRatio
                + 0.10 * (1 - suspiciousRate)
                + 0.10 * restartFactor
            )
            : 0;
        const independence = 100 / (1 + 0.5 * metrics.hintUses);
        const decisionStability = metrics.decisionTime.samples < 3
            ? 50
            : 100 / (1 + metrics.decisionTime.coefficientOfVariation);
        const expectedMoves = Math.max(1, metrics.referenceMoves ?? accepted);
        const targetThinkingTime = TARGET_DECISION_MS[difficulty] * expectedMoves;
        const speed = accepted > 0
            ? 100 * Math.exp(-0.28 * metrics.activeThinkingTimeMs / Math.max(1, targetThinkingTime))
            : 0;
        const idlePenalty = 1 / (1 + metrics.idleTimeMs / Math.max(1, targetThinkingTime));
        const timeEfficiency = accepted > 0
            ? (0.8 * speed + 0.2 * decisionStability) * idlePenalty
            : 0;
        const solutionEfficiency = metrics.stepEfficiency;
        const stageProgress = 100 * metrics.currentProgressRatio;
        const correctness = metrics.completed ? 100 : 0;
        const performanceCore =
            0.30 * solutionEfficiency
            + 0.20 * timeEfficiency
            + 0.20 * planning
            + 0.15 * operationQuality
            + 0.10 * independence
            + 0.05 * decisionStability;
        const abilityScore = metrics.completed
            ? 60 + 0.40 * performanceCore
            : Math.min(49, 49 * metrics.currentProgressRatio * (0.4 + 0.6 * performanceCore / 100));
        const difficultyWeight = TRUCK_ESCAPE_2_DIFFICULTY_WEIGHT[difficulty];
        return {
            abilityScore: round(clamp(abilityScore, 0, 100), 3),
            difficultyWeight,
            challengeAdjustedScore: round(clamp(abilityScore, 0, 100) * difficultyWeight, 3),
            dimensions: {
                correctness,
                solutionEfficiency: round(clamp(solutionEfficiency, 0, 100), 3),
                timeEfficiency: round(clamp(timeEfficiency, 0, 100), 3),
                planning: round(clamp(planning, 0, 100), 3),
                operationQuality: round(clamp(operationQuality, 0, 100), 3),
                decisionStability: round(clamp(decisionStability, 0, 100), 3),
                independence: round(clamp(independence, 0, 100), 3),
                stageProgress: round(clamp(stageProgress, 0, 100), 3),
                performanceCore: round(clamp(performanceCore, 0, 100), 3),
            },
        };
    }

    private _buildLevelHistory(attempts: TruckEscape2AttemptReport[]): TruckEscape2LevelHistory {
        let best = attempts[0];
        let bestCompleted: TruckEscape2AttemptReport | null = null;
        let bestIncomplete: TruckEscape2AttemptReport | null = null;
        for (const attempt of attempts) {
            if (compareAttemptQuality(attempt, best) > 0) best = attempt;
            if (attempt.metrics.completed && (!bestCompleted || compareAttemptQuality(attempt, bestCompleted) > 0)) {
                bestCompleted = attempt;
            }
            if (!attempt.metrics.completed && (!bestIncomplete || compareAttemptQuality(attempt, bestIncomplete) > 0)) {
                bestIncomplete = attempt;
            }
        }
        const scores = attempts.map((attempt) => attempt.score.abilityScore);
        const deviation = standardDeviation(scores);
        const rawStability = 100 / (1 + deviation / 15);
        const confidence = attempts.length / (attempts.length + 4);
        const stability = confidence * rawStability + (1 - confidence) * 50;
        const completed = attempts.filter((attempt) => attempt.metrics.completed);
        const firstCompletionIndex = attempts.findIndex((attempt) => attempt.metrics.completed);
        const attemptsToFirstCompletion = firstCompletionIndex >= 0 ? firstCompletionIndex + 1 : null;
        const retryEfficiencyScore = attemptsToFirstCompletion === null
            ? 0
            : 100 / Math.sqrt(attemptsToFirstCompletion);
        return {
            levelId: best.levelId,
            levelNumber: best.levelNumber,
            difficulty: best.difficulty,
            attempts: attempts.length,
            completions: completed.length,
            completionRate: round(completed.length / attempts.length),
            firstTryCompleted: firstCompletionIndex === 0,
            attemptsToFirstCompletion,
            retryEfficiencyScore: round(retryEfficiencyScore, 3),
            bestAttemptId: best.attemptId,
            bestCompletedAttemptId: bestCompleted?.attemptId ?? null,
            bestIncompleteAttemptId: bestIncomplete?.attemptId ?? null,
            bestAbilityScore: best.score.abilityScore,
            fewestCompletedMoves: completed.length > 0
                ? Math.min(...completed.map((attempt) => attempt.metrics.acceptedMoves))
                : null,
            fastestCompletedTimeMs: completed.length > 0
                ? Math.min(...completed.map((attempt) => attempt.metrics.activeThinkingTimeMs))
                : null,
            meanAbilityScore: round(average(scores), 3),
            abilityScoreStandardDeviation: round(deviation, 3),
            stabilityScore: round(clamp(stability, 0, 100), 3),
        };
    }

    private _buildAggregate(reports: TruckEscape2AttemptReport[]): TruckEscape2AggregateReport {
        const bestByLevel = new Map<string, TruckEscape2AttemptReport>();
        for (const report of reports) {
            const current = bestByLevel.get(report.levelId);
            if (!current || compareAttemptQuality(report, current) > 0) bestByLevel.set(report.levelId, report);
        }
        const levelHistories = this._groupReports(reports)
            .map((attempts) => this._buildLevelHistory(attempts));
        const historyByLevel = new Map(levelHistories.map((history) => [history.levelId, history]));
        const adjustedAbility = (report: TruckEscape2AttemptReport): number => {
            if (!report.metrics.completed) return report.score.abilityScore;
            const history = historyByLevel.get(report.levelId);
            if (!history) return report.score.abilityScore;
            // Best-play quality remains dominant, while first-solve retries and
            // observed completion reliability make failed attempts consequential.
            const reliabilityFactor = 0.80
                + 0.15 * history.retryEfficiencyScore / 100
                + 0.05 * history.completionRate;
            return report.score.abilityScore * reliabilityFactor;
        };
        const catalogWeight = this._catalog.reduce(
            (sum, level) => sum + TRUCK_ESCAPE_2_DIFFICULTY_WEIGHT[level.difficulty],
            0,
        );
        let attemptedWeight = 0;
        let bestScoreWeight = 0;
        let completedWeight = 0;
        let completedChallengeCredits = 0;
        let partialProgressWeight = 0;
        const bestCompleted: TruckEscape2AttemptReport[] = [];
        for (const report of bestByLevel.values()) {
            const weight = TRUCK_ESCAPE_2_DIFFICULTY_WEIGHT[report.difficulty];
            attemptedWeight += weight;
            bestScoreWeight += adjustedAbility(report) * weight;
            if (report.metrics.completed) {
                completedWeight += weight;
                completedChallengeCredits += TRUCK_ESCAPE_2_DIFFICULTY_CREDITS[report.difficulty];
                bestCompleted.push(report);
            } else {
                partialProgressWeight += weight * report.metrics.currentProgressRatio;
            }
        }
        // Cross-level stability uses one best result per distinct level. Thus
        // replaying one easy level cannot inflate leaderboard stability.
        const distinctScores = Array.from(bestByLevel.values())
            .map((report) => report.score.abilityScore);
        const distinctDeviation = standardDeviation(distinctScores);
        const rawCrossLevelStability = 100 / (1 + distinctDeviation / 15);
        const stabilityConfidence = distinctScores.length / (distinctScores.length + 4);
        const stabilityScore = distinctScores.length > 0
            ? stabilityConfidence * rawCrossLevelStability + (1 - stabilityConfidence) * 50
            : 50;
        const completedQuality = this._weightedMean(
            bestCompleted,
            (report) => {
                const history = historyByLevel.get(report.levelId);
                return history
                    ? 0.70 * report.score.dimensions.performanceCore
                        + 0.20 * history.retryEfficiencyScore
                        + 0.10 * history.completionRate * 100
                    : report.score.dimensions.performanceCore;
            },
        );
        const independenceScore = this._weightedMean(
            Array.from(bestByLevel.values()),
            (report) => report.score.dimensions.independence,
        );
        const partialCoverage = catalogWeight > 0 ? partialProgressWeight / catalogWeight : 0;
        const leaderboardScore =
            completedChallengeCredits * 1_000_000
            + Math.floor(clamp(completedQuality / 100, 0, 1) * 900_000)
            + Math.floor(clamp(partialCoverage, 0, 1) * 90_000)
            + Math.floor(clamp(stabilityScore / 100, 0, 1) * 9_000)
            + Math.floor(clamp(independenceScore / 100, 0, 1) * 999);

        const byDifficulty = {} as Record<TruckEscape2Difficulty, TruckEscape2DifficultyAggregate>;
        for (const difficulty of ['easy', 'medium', 'hard'] as TruckEscape2Difficulty[]) {
            const catalogLevels = this._catalog.filter((level) => level.difficulty === difficulty).length;
            const aggregate = emptyDifficultyAggregate(difficulty, catalogLevels);
            const attempts = reports.filter((report) => report.difficulty === difficulty);
            const best = Array.from(bestByLevel.values()).filter((report) => report.difficulty === difficulty);
            const complete = attempts.filter((report) => report.metrics.completed);
            const bestComplete = best.filter((report) => report.metrics.completed);
            aggregate.attempts = attempts.length;
            aggregate.completions = complete.length;
            aggregate.completionRate = round(attempts.length > 0 ? complete.length / attempts.length : 0);
            aggregate.uniqueLevelsAttempted = best.length;
            aggregate.uniqueLevelsCompleted = bestComplete.length;
            aggregate.evaluatedAbilityScore = round(average(best.map(adjustedAbility)), 3);
            aggregate.catalogAbilityContribution = round(
                catalogLevels > 0
                    ? best.reduce((sum, report) => sum + adjustedAbility(report), 0) / catalogLevels
                    : 0,
                3,
            );
            aggregate.meanStepEfficiency = round(average(best.map((report) => report.metrics.stepEfficiency)), 3);
            aggregate.meanTimeEfficiency = round(average(best.map((report) => report.score.dimensions.timeEfficiency)), 3);
            aggregate.meanPlanningScore = round(average(best.map((report) => report.score.dimensions.planning)), 3);
            aggregate.meanOperationQuality = round(average(best.map((report) => report.score.dimensions.operationQuality)), 3);
            aggregate.meanIndependenceScore = round(average(best.map((report) => report.score.dimensions.independence)), 3);
            byDifficulty[difficulty] = aggregate;
        }
        const adaptationNumerator = (['easy', 'medium', 'hard'] as TruckEscape2Difficulty[])
            .reduce((sum, difficulty) => {
                const item = byDifficulty[difficulty];
                const coverage = item.catalogLevels > 0 ? item.uniqueLevelsAttempted / item.catalogLevels : 0;
                return sum + TRUCK_ESCAPE_2_DIFFICULTY_WEIGHT[difficulty]
                    * item.evaluatedAbilityScore
                    * Math.sqrt(coverage);
            }, 0);
        const adaptationDenominator = (['easy', 'medium', 'hard'] as TruckEscape2Difficulty[])
            .reduce((sum, difficulty) => sum + TRUCK_ESCAPE_2_DIFFICULTY_WEIGHT[difficulty], 0);
        const completedHistories = levelHistories.filter((history) => history.completions > 0);
        let retryNumerator = 0;
        let retryDenominator = 0;
        for (const history of completedHistories) {
            const weight = TRUCK_ESCAPE_2_DIFFICULTY_WEIGHT[history.difficulty];
            retryNumerator += history.retryEfficiencyScore * weight;
            retryDenominator += weight;
        }
        const retryEfficiencyScore = retryDenominator > 0 ? retryNumerator / retryDenominator : 0;

        return {
            scoringVersion: TRUCK_ESCAPE_2_SCORING_VERSION,
            generatedAtMs: this._timestamp(),
            catalogLevels: this._catalog.length,
            totalAttempts: reports.length,
            completedAttempts: reports.filter((report) => report.metrics.completed).length,
            completionRate: round(reports.length > 0
                ? reports.filter((report) => report.metrics.completed).length / reports.length
                : 0),
            uniqueLevelsAttempted: bestByLevel.size,
            uniqueLevelsCompleted: bestCompleted.length,
            coverageRatio: round(this._catalog.length > 0 ? bestByLevel.size / this._catalog.length : 0),
            weightedCompletionRate: round(catalogWeight > 0 ? completedWeight / catalogWeight : 0),
            overallAbilityScore: round(catalogWeight > 0 ? bestScoreWeight / catalogWeight : 0, 3),
            evaluatedAbilityScore: round(attemptedWeight > 0 ? bestScoreWeight / attemptedWeight : 0, 3),
            stabilityScore: round(clamp(stabilityScore, 0, 100), 3),
            difficultyAdaptationScore: round(
                adaptationDenominator > 0 ? adaptationNumerator / adaptationDenominator : 0,
                3,
            ),
            independenceScore: round(independenceScore, 3),
            firstTryCompletedLevels: completedHistories.filter((history) => history.firstTryCompleted).length,
            retryEfficiencyScore: round(retryEfficiencyScore, 3),
            completedChallengeCredits,
            leaderboardScore,
            totalInvalidOperations: reports.reduce((sum, report) => sum + report.metrics.invalidOperations, 0),
            totalRepeatedStates: reports.reduce((sum, report) => sum + report.metrics.repeatedStates, 0),
            totalInferredUndos: reports.reduce((sum, report) => sum + report.metrics.inferredUndoCount, 0),
            totalRestarts: reports.reduce((sum, report) => sum + report.metrics.restartCount, 0),
            totalExits: reports.reduce((sum, report) => sum + report.metrics.exitCount, 0)
                + this._controlEvents.length,
            totalHintUses: reports.reduce((sum, report) => sum + report.metrics.hintUses, 0),
            byDifficulty,
        };
    }

    private _weightedMean(
        reports: readonly TruckEscape2AttemptReport[],
        selector: (report: TruckEscape2AttemptReport) => number,
    ): number {
        let numerator = 0;
        let denominator = 0;
        for (const report of reports) {
            const weight = TRUCK_ESCAPE_2_DIFFICULTY_WEIGHT[report.difficulty];
            numerator += selector(report) * weight;
            denominator += weight;
        }
        return denominator > 0 ? numerator / denominator : 0;
    }

    private _groupReports(reports: readonly TruckEscape2AttemptReport[]): TruckEscape2AttemptReport[][] {
        const grouped = new Map<string, TruckEscape2AttemptReport[]>();
        for (const report of reports) {
            const list = grouped.get(report.levelId) ?? [];
            list.push(report);
            grouped.set(report.levelId, list);
        }
        return Array.from(grouped.values());
    }

    private _reportsForAggregation(includeCurrent: boolean): TruckEscape2AttemptReport[] {
        const reports = [...this._history];
        if (includeCurrent && this._current) reports.push(this._buildReport(this._current, this._timestamp(), null));
        return reports;
    }

    private _historicalBestMoves(levelId: string): number | null {
        const completed = this._history
            .filter((attempt) => attempt.levelId === levelId && attempt.metrics.completed)
            .map((attempt) => attempt.metrics.acceptedMoves);
        return completed.length > 0 ? Math.min(...completed) : null;
    }

    private _assertModelLevel(level: TruckEscape2LevelData, model: TruckEscape2BoardModel): void {
        if (!model || model.level.id !== level.id) {
            throw new Error(`[TruckEscape2Ability] 模型关卡不匹配：${level.id}`);
        }
    }

    private _requireCurrent(): MutableAttempt {
        if (!this._current) throw new Error('[TruckEscape2Ability] 当前没有活动单局');
        return this._current;
    }

    private _assertAttemptOwner(expectedAttemptId?: string | null): void {
        if (expectedAttemptId && this._current?.attemptId !== expectedAttemptId) {
            throw new Error(`[TruckEscape2Ability] 单局所有权不匹配：${expectedAttemptId}`);
        }
    }

    private _timestamp(): number {
        let value: number;
        try {
            value = Number(this._nowProvider());
        } catch (_) {
            value = Date.now();
        }
        if (!Number.isFinite(value)) value = Date.now();
        value = Math.max(this._lastTimestampMs, Math.floor(value));
        this._lastTimestampMs = value;
        return value;
    }

    private _rebuildStoredAttempt(
        value: unknown,
        mustBeFinalized: boolean,
        exportedAtMs: number,
    ): TruckEscape2AttemptReport {
        if (!value || typeof value !== 'object') {
            throw new Error('[TruckEscape2Ability] 单局记录不是对象');
        }
        const stored = value as Partial<TruckEscape2AttemptReport>;
        if (typeof stored.attemptId !== 'string' || stored.attemptId.length === 0) {
            throw new Error('[TruckEscape2Ability] attemptId 无效');
        }
        if (typeof stored.levelId !== 'string') throw new Error('[TruckEscape2Ability] levelId 无效');
        const level = this._catalogById.get(stored.levelId);
        if (!level) throw new Error(`[TruckEscape2Ability] 未知关卡：${stored.levelId}`);
        if (stored.levelNumber !== level.levelNumber || stored.difficulty !== level.difficulty) {
            throw new Error(`[TruckEscape2Ability] 关卡元数据不匹配：${stored.levelId}`);
        }
        if (!ATTEMPT_START_REASONS.has(stored.startReason as TruckEscape2AttemptStartReason)) {
            throw new Error(`[TruckEscape2Ability] startReason 无效：${String(stored.startReason)}`);
        }
        if (!this._isTimestamp(stored.startedAtMs)) {
            throw new Error(`[TruckEscape2Ability] startedAtMs 无效：${stored.attemptId}`);
        }
        if (stored.startedAtMs > exportedAtMs) {
            throw new Error(`[TruckEscape2Ability] 单局开始时间晚于导出时间：${stored.attemptId}`);
        }
        if (!Array.isArray(stored.operations)) {
            throw new Error(`[TruckEscape2Ability] operations 无效：${stored.attemptId}`);
        }

        const model = new TruckEscape2BoardModel(level);
        const reference = this._references[level.id] ?? null;
        const historicalBestMoves = reference ? null : this._historicalBestMoves(level.id);
        const initialProgress = TruckEscape2ProgressAnalyzer.analyze(model, {
            solution: reference,
            historicalBestMoves,
        });
        if (!stored.initialProgress || stored.initialProgress.stateKey !== initialProgress.stateKey) {
            throw new Error(`[TruckEscape2Ability] 初始状态不匹配：${stored.attemptId}`);
        }
        const mutable: MutableAttempt = {
            attemptId: stored.attemptId,
            level,
            startReason: stored.startReason as TruckEscape2AttemptStartReason,
            startedAtMs: stored.startedAtMs,
            lastOperationAtMs: stored.startedAtMs,
            initialProgress,
            currentProgress: initialProgress,
            reference,
            historicalBestMoves,
            operations: [],
            stateVisits: { [initialProgress.stateKey]: 1 },
        };
        for (let index = 0; index < stored.operations.length; index++) {
            this._replayStoredOperation(mutable, model, stored.operations[index], index);
        }
        if (!stored.finalProgress || stored.finalProgress.stateKey !== mutable.currentProgress.stateKey) {
            throw new Error(`[TruckEscape2Ability] 最终状态不匹配：${stored.attemptId}`);
        }

        let endReason: TruckEscape2AttemptEndReason;
        let endedAtMs: number;
        if (mustBeFinalized) {
            if (!ATTEMPT_END_REASONS.has(stored.endReason as TruckEscape2AttemptEndReason)) {
                throw new Error(`[TruckEscape2Ability] endReason 无效：${stored.attemptId}`);
            }
            if (!this._isTimestamp(stored.endedAtMs)) {
                throw new Error(`[TruckEscape2Ability] endedAtMs 无效：${stored.attemptId}`);
            }
            endReason = stored.endReason as TruckEscape2AttemptEndReason;
            endedAtMs = stored.endedAtMs;
        } else {
            if (stored.endReason !== null || stored.endedAtMs !== null) {
                throw new Error(`[TruckEscape2Ability] 活动单局结束字段无效：${stored.attemptId}`);
            }
            endReason = 'interrupted';
            endedAtMs = Math.max(exportedAtMs, mutable.lastOperationAtMs);
        }
        if (endedAtMs < mutable.startedAtMs || endedAtMs < mutable.lastOperationAtMs) {
            throw new Error(`[TruckEscape2Ability] 单局时间顺序无效：${stored.attemptId}`);
        }
        if (endedAtMs > exportedAtMs) {
            throw new Error(`[TruckEscape2Ability] 单局结束时间晚于导出时间：${stored.attemptId}`);
        }

        const finalOperation = mutable.operations[mutable.operations.length - 1] ?? null;
        const complete = model.isComplete();
        if (endReason === 'completed') {
            if (!complete || !finalOperation || !operationChangesState(finalOperation)) {
                throw new Error(`[TruckEscape2Ability] 通关结束状态无效：${stored.attemptId}`);
            }
        } else if (complete) {
            throw new Error(`[TruckEscape2Ability] 已通关单局不能标记为 ${endReason}`);
        }
        if (endReason === 'restarted' && finalOperation?.type !== 'restart') {
            throw new Error(`[TruckEscape2Ability] 重开事件缺失：${stored.attemptId}`);
        }
        if (endReason === 'exited' && finalOperation?.type !== 'exit') {
            throw new Error(`[TruckEscape2Ability] 退出事件缺失：${stored.attemptId}`);
        }
        if (
            (endReason === 'completed' || endReason === 'restarted' || endReason === 'exited')
            && endedAtMs !== finalOperation?.timestampMs
        ) {
            throw new Error(`[TruckEscape2Ability] 结束时间与结束事件不一致：${stored.attemptId}`);
        }
        return this._buildReport(mutable, endedAtMs, endReason);
    }

    private _replayStoredOperation(
        attempt: MutableAttempt,
        model: TruckEscape2BoardModel,
        value: unknown,
        index: number,
    ): void {
        if (!value || typeof value !== 'object') {
            throw new Error(`[TruckEscape2Ability] 操作 ${index + 1} 无效`);
        }
        const stored = value as Partial<TruckEscape2OperationRecord>;
        if (!OPERATION_TYPES.has(stored.type as TruckEscape2OperationType)) {
            throw new Error(`[TruckEscape2Ability] 操作类型无效：${String(stored.type)}`);
        }
        if (stored.sequence !== index + 1) {
            throw new Error(`[TruckEscape2Ability] 操作序号无效：${attempt.attemptId}/${index + 1}`);
        }
        if (!this._isTimestamp(stored.timestampMs) || stored.timestampMs < attempt.lastOperationAtMs) {
            throw new Error(`[TruckEscape2Ability] 操作时间无效：${attempt.attemptId}/${index + 1}`);
        }
        if (!stored.before || stored.before.stateKey !== attempt.currentProgress.stateKey) {
            throw new Error(`[TruckEscape2Ability] 操作前状态不匹配：${attempt.attemptId}/${index + 1}`);
        }
        if (typeof stored.inputClamped !== 'boolean') {
            throw new Error(`[TruckEscape2Ability] inputClamped 无效：${attempt.attemptId}/${index + 1}`);
        }
        if (
            stored.interactionDurationMs !== null
            && (!Number.isFinite(stored.interactionDurationMs) || (stored.interactionDurationMs as number) < 0)
        ) {
            throw new Error(`[TruckEscape2Ability] interactionDurationMs 无效：${attempt.attemptId}/${index + 1}`);
        }

        const type = stored.type as TruckEscape2OperationType;
        let after = attempt.currentProgress;
        let input: OperationInput;
        if (type === 'move' || type === 'undo') {
            if (
                stored.accepted !== true
                || typeof stored.vehicleId !== 'string'
                || !levelHasVehicle(attempt.level, stored.vehicleId)
                || !Number.isInteger(stored.attemptedDelta)
                || !Number.isInteger(stored.appliedDelta)
                || stored.appliedDelta === 0
                || stored.invalidReason !== null
            ) {
                throw new Error(`[TruckEscape2Ability] 已接受移动字段无效：${attempt.attemptId}/${index + 1}`);
            }
            if (!model.move(stored.vehicleId, stored.appliedDelta)) {
                throw new Error(`[TruckEscape2Ability] 非法移动：${attempt.attemptId}/${index + 1}`);
            }
            after = TruckEscape2ProgressAnalyzer.analyze(model, {
                solution: attempt.reference,
                historicalBestMoves: attempt.historicalBestMoves,
            });
            input = {
                vehicleId: stored.vehicleId,
                attemptedDelta: stored.attemptedDelta,
                appliedDelta: stored.appliedDelta,
                accepted: true,
                invalidReason: null,
                inputClamped: stored.inputClamped,
                interactionDurationMs: stored.interactionDurationMs ?? null,
            };
        } else if (type === 'invalid-move') {
            if (
                stored.accepted !== false
                || typeof stored.vehicleId !== 'string'
                || !levelHasVehicle(attempt.level, stored.vehicleId)
                || !Number.isInteger(stored.attemptedDelta)
                || stored.appliedDelta !== 0
                || !INVALID_MOVE_REASONS.has(stored.invalidReason as TruckEscape2InvalidMoveReason)
            ) {
                throw new Error(`[TruckEscape2Ability] 无效移动字段损坏：${attempt.attemptId}/${index + 1}`);
            }
            input = {
                vehicleId: stored.vehicleId,
                attemptedDelta: stored.attemptedDelta,
                appliedDelta: 0,
                accepted: false,
                invalidReason: stored.invalidReason as TruckEscape2InvalidMoveReason,
                inputClamped: stored.inputClamped,
                interactionDurationMs: stored.interactionDurationMs ?? null,
            };
        } else {
            if (
                stored.accepted !== true
                || stored.vehicleId !== null
                || stored.attemptedDelta !== null
                || stored.appliedDelta !== null
                || stored.invalidReason !== null
                || stored.inputClamped
                || stored.interactionDurationMs !== null
            ) {
                throw new Error(`[TruckEscape2Ability] 控制操作字段无效：${attempt.attemptId}/${index + 1}`);
            }
            input = {
                vehicleId: null,
                attemptedDelta: null,
                appliedDelta: null,
                accepted: true,
                invalidReason: null,
                inputClamped: false,
                interactionDurationMs: null,
            };
        }
        const rebuilt = this._appendOperationAt(
            attempt,
            type,
            after,
            input,
            stored.timestampMs,
        );
        if (!stored.after || stored.after.stateKey !== rebuilt.after.stateKey) {
            throw new Error(`[TruckEscape2Ability] 操作后状态不匹配：${attempt.attemptId}/${index + 1}`);
        }
    }

    private _restoreControlEvents(
        values: readonly unknown[],
        seenAttemptIds: ReadonlySet<string>,
        exportedAtMs: number,
    ): TruckEscape2ControlEvent[] {
        const reports = new Map(this._history.map((attempt) => [attempt.attemptId, attempt]));
        const relatedAttempts = new Set<string>();
        let previousTimestampMs = 0;
        return values.map((value, index) => {
            if (!value || typeof value !== 'object') {
                throw new Error(`[TruckEscape2Ability] 控制事件 ${index + 1} 无效`);
            }
            const stored = value as Partial<TruckEscape2ControlEvent>;
            if (stored.sequence !== index + 1 || stored.type !== 'exit' || !this._isTimestamp(stored.timestampMs)) {
                throw new Error(`[TruckEscape2Ability] 控制事件字段无效：${index + 1}`);
            }
            if (stored.timestampMs < previousTimestampMs || stored.timestampMs > exportedAtMs) {
                throw new Error(`[TruckEscape2Ability] 控制事件时间无效：${index + 1}`);
            }
            previousTimestampMs = stored.timestampMs;
            if (
                typeof stored.relatedAttemptId !== 'string'
                || !seenAttemptIds.has(stored.relatedAttemptId)
                || relatedAttempts.has(stored.relatedAttemptId)
            ) {
                throw new Error(`[TruckEscape2Ability] 控制事件引用无效或重复：${index + 1}`);
            }
            const related = reports.get(stored.relatedAttemptId);
            if (
                !related?.metrics.completed
                || stored.levelId !== related.levelId
                || stored.afterCompletion !== true
                || stored.timestampMs < (related.endedAtMs ?? related.startedAtMs)
            ) {
                throw new Error(`[TruckEscape2Ability] 控制事件上下文不匹配：${index + 1}`);
            }
            relatedAttempts.add(stored.relatedAttemptId);
            return {
                sequence: index + 1,
                type: 'exit',
                timestampMs: stored.timestampMs,
                relatedAttemptId: stored.relatedAttemptId,
                levelId: stored.levelId,
                afterCompletion: true,
            };
        });
    }

    private _isTimestamp(value: unknown): value is number {
        return Number.isSafeInteger(value) && (value as number) >= 0;
    }

    private _jsonClone<T>(value: T): T {
        return JSON.parse(JSON.stringify(value)) as T;
    }
}
