import {
    computeMazePaintMove,
    countPaintedCells,
    createInitialMazePaintState,
    hashMazePaintState,
    isCellPainted,
    isMazePaintComplete,
    positionKey,
} from './MazePaintRules';
import type {
    GridPosition,
    MazePaintDirection,
    MazePaintLevel,
    MazePaintMoveResult,
    MazePaintState,
} from './MazePaintRules';
import { scoreMazePaint } from './MazePaintScorer';

export type MazePaintFailureReason =
    | 'repeated_action_cycle'
    | 'no_progress'
    | 'max_steps'
    | 'timeout'
    | 'environment_error';

export type MazePaintTerminationReason = 'success' | MazePaintFailureReason;
export type MazePaintStatus = 'running' | 'success' | 'failure';

export interface MazePaintEvaluatorOptions {
    readonly maxSteps: number;
    readonly noProgressMoveLimit: number;
    readonly timeoutMs: number;
    readonly cycleFailureRepetitions: number;
}

export const DEFAULT_MAZE_PAINT_EVALUATOR_OPTIONS: MazePaintEvaluatorOptions = Object.freeze({
    maxSteps: 500,
    noProgressMoveLimit: 40,
    timeoutMs: 10 * 60 * 1000,
    cycleFailureRepetitions: 4,
});

export interface MazePaintActionRecord {
    readonly step: number;
    readonly direction: MazePaintDirection;
    readonly moved: boolean;
    readonly traversedCellCount: number;
    readonly newlyPaintedCellCount: number;
    readonly coverageAfter: number;
    readonly beforeStateHash: string;
    readonly afterStateHash: string;
    readonly durationMs: number;
    readonly decisionWaitMs: number;
}

interface CycleState {
    detected: boolean;
    everDetected: boolean;
    length: number | null;
    repetitions: number;
}

export interface MazePaintEvaluatorSnapshot {
    readonly game_id: 'maze_paint';
    readonly difficulty: string;
    readonly level: number;
    readonly level_id: string;
    readonly status: MazePaintStatus;
    readonly success: boolean;
    readonly failure: boolean;
    readonly termination_reason: MazePaintTerminationReason | null;
    readonly ball_position: GridPosition;
    readonly total_paintable_cells: number;
    readonly painted_cell_count: number;
    readonly remaining_unpainted_cells: number;
    readonly coverage_ratio: number;
    readonly move_count: number;
    readonly valid_move_count: number;
    readonly invalid_move_count: number;
    readonly elapsed_time_ms: number;
    readonly optimal_move_count: number | null;
    readonly score: number;
    readonly board: Record<string, unknown>;
    readonly ball: Record<string, unknown>;
    readonly actions: Record<string, unknown>;
    readonly efficiency: Record<string, unknown>;
    readonly traversal: Record<string, unknown>;
    readonly state_analysis: Record<string, unknown>;
    readonly progress: Record<string, unknown>;
    readonly timing: Record<string, unknown>;
    readonly trajectory: readonly MazePaintActionRecord[];
}

function nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function ratio(numerator: number, denominator: number): number {
    return clamp01(numerator / Math.max(denominator, 1));
}

function roundMetric(value: number): number {
    return Math.round(value * 10000) / 10000;
}

function samePosition(a: GridPosition, b: GridPosition): boolean {
    return a.row === b.row && a.column === b.column;
}

/** Stateful statistics collector; it never changes the movement rules. */
export class MazePaintEvaluator {
    private readonly _level: MazePaintLevel;
    private readonly _options: MazePaintEvaluatorOptions;
    private _state: MazePaintState;
    private readonly _startedAt: number;
    private _lastActionEndedAt: number;
    private _terminalAt: number | null = null;
    private _status: MazePaintStatus = 'running';
    private _terminationReason: MazePaintTerminationReason | null = null;
    private _validMoveCount = 0;
    private _invalidMoveCount = 0;
    private _productiveMoveCount = 0;
    private _zeroProgressMoveCount = 0;
    private _totalNewlyPaintedCells = 0;
    private _maxNewCellsInOneMove = 0;
    private _totalTraversedCells = 0;
    private _newlyPaintedTraversals = 0;
    private _alreadyPaintedTraversals = 0;
    private _revisitedStateCount = 0;
    private _repeatedActionCount = 0;
    private _movesSinceLastProgress = 0;
    private _bestCoverageRatio: number;
    private _animationTimeMs = 0;
    private _decisionWaitTimeMs = 0;
    private _moveDurationTimeMs = 0;
    private readonly _newlyPaintedCellsPerMove: number[] = [];
    private readonly _progressDeltaPerMove: number[] = [];
    private readonly _trajectory: MazePaintActionRecord[] = [];
    private readonly _stateVisits = new Map<string, number>();
    private readonly _actionVisits = new Map<string, number>();
    private readonly _cycle: CycleState = {
        detected: false,
        everDetected: false,
        length: null,
        repetitions: 0,
    };

    constructor(
        level: MazePaintLevel,
        startTimeMs: number = nowMs(),
        options: MazePaintEvaluatorOptions = DEFAULT_MAZE_PAINT_EVALUATOR_OPTIONS,
    ) {
        this._level = level;
        this._options = options;
        this._state = createInitialMazePaintState(level);
        this._startedAt = startTimeMs;
        this._lastActionEndedAt = startTimeMs;
        this._bestCoverageRatio = 1 / level.totalPaintableCells;
        this._stateVisits.set(hashMazePaintState(level, this._state), 1);
    }

    get state(): MazePaintState { return this._state; }
    get status(): MazePaintStatus { return this._status; }
    get terminationReason(): MazePaintTerminationReason | null { return this._terminationReason; }
    get terminal(): boolean { return this._status !== 'running'; }

    /**
     * Commit the already-rendered move. The result is recomputed from the
     * collector's current state to reject controller/animation drift.
     */
    recordMove(
        result: MazePaintMoveResult,
        actionStartedAtMs: number,
        actionEndedAtMs: number,
    ): MazePaintMoveResult {
        if (this.terminal) return result;
        if (!samePosition(result.from, this._state.ball)) {
            throw new Error('Maze Paint evaluator received a move from a stale ball position.');
        }
        const canonical = computeMazePaintMove(this._level, this._state, result.direction);
        if (hashMazePaintState(this._level, canonical.nextState)
            !== hashMazePaintState(this._level, result.nextState)) {
            throw new Error('Maze Paint animation result diverged from the authoritative transition.');
        }

        const started = Math.max(this._lastActionEndedAt, actionStartedAtMs);
        const ended = Math.max(started, actionEndedAtMs);
        const decisionWait = Math.max(0, actionStartedAtMs - this._lastActionEndedAt);
        const duration = Math.max(0, ended - actionStartedAtMs);
        const beforeHash = hashMazePaintState(this._level, this._state);
        const actionKey = `${beforeHash}|${canonical.direction}`;
        if ((this._actionVisits.get(actionKey) ?? 0) > 0) this._repeatedActionCount++;
        this._actionVisits.set(actionKey, (this._actionVisits.get(actionKey) ?? 0) + 1);

        const newCount = canonical.newlyPaintedCells.length;
        if (canonical.moved) {
            this._validMoveCount++;
            this._newlyPaintedCellsPerMove.push(newCount);
            this._animationTimeMs += duration;
            if (newCount > 0) this._productiveMoveCount++;
            else this._zeroProgressMoveCount++;
        } else {
            this._invalidMoveCount++;
        }
        this._totalNewlyPaintedCells += newCount;
        this._maxNewCellsInOneMove = Math.max(this._maxNewCellsInOneMove, newCount);
        this._totalTraversedCells += canonical.traversedCells.length;
        this._newlyPaintedTraversals += newCount;
        this._alreadyPaintedTraversals += canonical.traversedCells.length - newCount;
        this._progressDeltaPerMove.push(newCount / this._level.totalPaintableCells);
        if (newCount > 0) this._movesSinceLastProgress = 0;
        else this._movesSinceLastProgress++;

        this._state = canonical.nextState;
        const painted = countPaintedCells(this._state.paintedMask);
        const coverage = painted / this._level.totalPaintableCells;
        this._bestCoverageRatio = Math.max(this._bestCoverageRatio, coverage);
        const afterHash = hashMazePaintState(this._level, this._state);
        const previousVisits = this._stateVisits.get(afterHash) ?? 0;
        if (previousVisits > 0) this._revisitedStateCount++;
        this._stateVisits.set(afterHash, previousVisits + 1);

        this._decisionWaitTimeMs += decisionWait;
        this._moveDurationTimeMs += duration;
        this._lastActionEndedAt = ended;
        this._trajectory.push(Object.freeze({
            step: this._trajectory.length + 1,
            direction: canonical.direction,
            moved: canonical.moved,
            traversedCellCount: canonical.traversedCells.length,
            newlyPaintedCellCount: newCount,
            coverageAfter: roundMetric(coverage),
            beforeStateHash: beforeHash,
            afterStateHash: afterHash,
            durationMs: Math.round(duration),
            decisionWaitMs: Math.round(decisionWait),
        }));
        this._updateCycleState();

        if (isMazePaintComplete(this._level, this._state)) this._finish('success', ended);
        else this._applyStepTerminationPolicy(ended);
        return canonical;
    }

    /** Convenience for tests and non-animated callers. */
    applyDirection(
        direction: MazePaintDirection,
        actionStartedAtMs: number = nowMs(),
        actionEndedAtMs: number = actionStartedAtMs,
    ): MazePaintMoveResult {
        const result = computeMazePaintMove(this._level, this._state, direction);
        return this.recordMove(result, actionStartedAtMs, actionEndedAtMs);
    }

    terminate(reason: MazePaintFailureReason, timestampMs: number = nowMs()): void {
        if (!this.terminal) this._finish(reason, timestampMs);
    }

    /** Called by the controller while idle so timeout is not action-dependent. */
    pollTermination(timestampMs: number = nowMs()): void {
        if (!this.terminal && timestampMs - this._startedAt >= this._options.timeoutMs) {
            this._finish('timeout', timestampMs);
        }
    }

    private _finish(reason: MazePaintTerminationReason, timestampMs: number): void {
        this._terminationReason = reason;
        this._status = reason === 'success' ? 'success' : 'failure';
        this._terminalAt = Math.max(this._startedAt, timestampMs);
    }

    private _applyStepTerminationPolicy(timestampMs: number): void {
        if (this._trajectory.length >= this._options.maxSteps) {
            this._finish('max_steps', timestampMs);
        } else if (this._movesSinceLastProgress >= this._options.noProgressMoveLimit) {
            this._finish('no_progress', timestampMs);
        } else if (this._cycle.detected
            && this._cycle.repetitions >= this._options.cycleFailureRepetitions) {
            this._finish('repeated_action_cycle', timestampMs);
        } else if (timestampMs - this._startedAt >= this._options.timeoutMs) {
            this._finish('timeout', timestampMs);
        }
    }

    private _updateCycleState(): void {
        const records = this._trajectory;
        this._cycle.detected = false;
        this._cycle.length = null;
        this._cycle.repetitions = 0;
        const maxPeriod = Math.min(12, Math.floor(records.length / 3));
        for (let period = 1; period <= maxPeriod; period++) {
            const tailStart = records.length - period * 3;
            let matches = true;
            for (let offset = 0; offset < period * 3; offset++) {
                const record = records[tailStart + offset];
                if (record.newlyPaintedCellCount !== 0) {
                    matches = false;
                    break;
                }
                if (offset >= period) {
                    const previous = records[tailStart + offset - period];
                    if (record.direction !== previous.direction
                        || record.beforeStateHash !== previous.beforeStateHash
                        || record.afterStateHash !== previous.afterStateHash) {
                        matches = false;
                        break;
                    }
                }
            }
            if (!matches) continue;
            let repetitions = 3;
            while ((repetitions + 1) * period <= records.length) {
                const aStart = records.length - repetitions * period;
                const bStart = aStart - period;
                let same = true;
                for (let i = 0; i < period; i++) {
                    const a = records[aStart + i];
                    const b = records[bStart + i];
                    if (b.newlyPaintedCellCount !== 0
                        || a.direction !== b.direction
                        || a.beforeStateHash !== b.beforeStateHash
                        || a.afterStateHash !== b.afterStateHash) {
                        same = false;
                        break;
                    }
                }
                if (!same) break;
                repetitions++;
            }
            this._cycle.detected = true;
            this._cycle.everDetected = true;
            this._cycle.length = period;
            this._cycle.repetitions = repetitions;
            return;
        }
    }

    private _remainingConnectedRegions(): number {
        const unpainted = new Set<string>();
        for (const position of this._level.paintableCells) {
            if (!isCellPainted(this._level, this._state, position)) {
                unpainted.add(positionKey(position));
            }
        }
        let regions = 0;
        while (unpainted.size > 0) {
            regions++;
            const first = unpainted.values().next().value as string;
            const [row, column] = first.split(',').map(Number);
            const pending: GridPosition[] = [{ row, column }];
            unpainted.delete(first);
            while (pending.length > 0) {
                const current = pending.pop()!;
                for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
                    const next = { row: current.row + dr, column: current.column + dc };
                    const key = positionKey(next);
                    if (unpainted.delete(key)) pending.push(next);
                }
            }
        }
        return regions;
    }

    private _reachableUnpaintedCells(): number {
        const pending: GridPosition[] = [this._state.ball];
        const visited = new Set<string>();
        let count = 0;
        while (pending.length > 0) {
            const current = pending.pop()!;
            const key = positionKey(current);
            if (visited.has(key) || this._level.cellIndexByKey[key] === undefined) continue;
            visited.add(key);
            if (!isCellPainted(this._level, this._state, current)) count++;
            for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
                pending.push({ row: current.row + dr, column: current.column + dc });
            }
        }
        return count;
    }

    snapshot(timestampMs: number = nowMs(), isMoving: boolean = false): MazePaintEvaluatorSnapshot {
        this.pollTermination(timestampMs);
        const moveCount = this._trajectory.length;
        const paintedCellCount = countPaintedCells(this._state.paintedMask);
        const remaining = this._level.totalPaintableCells - paintedCellCount;
        const coverageRatio = clamp01(paintedCellCount / this._level.totalPaintableCells);
        const validMoveRatio = ratio(this._validMoveCount, moveCount);
        const invalidMoveRatio = ratio(this._invalidMoveCount, moveCount);
        const productiveMoveRatio = ratio(this._productiveMoveCount, this._validMoveCount);
        const redundantMoveRatio = ratio(this._zeroProgressMoveCount, this._validMoveCount);
        const stateRevisitRatio = ratio(this._revisitedStateCount, moveCount);
        const optimalMoveCount = Number.isFinite(this._level.optimalMoveCount)
            ? this._level.optimalMoveCount
            : null;
        const extraMoveCount = optimalMoveCount === null
            ? null
            : Math.max(moveCount - optimalMoveCount, 0);
        const moveEfficiency = optimalMoveCount === null
            ? 0
            : clamp01(optimalMoveCount / Math.max(moveCount, optimalMoveCount));
        const elapsed = Math.max(0, (this._terminalAt ?? timestampMs) - this._startedAt);
        const success = this._status === 'success';
        const failure = this._status === 'failure';
        const score = scoreMazePaint({
            success,
            coverageRatio,
            moveEfficiency,
            productiveMoveRatio,
            invalidMoveRatio,
            redundantMoveRatio,
            stateRevisitRatio,
        });

        return Object.freeze({
            game_id: 'maze_paint',
            difficulty: this._level.difficulty,
            level: this._level.levelNumber,
            level_id: this._level.id,
            status: this._status,
            success,
            failure,
            termination_reason: this._terminationReason,
            ball_position: Object.freeze({ ...this._state.ball }),
            total_paintable_cells: this._level.totalPaintableCells,
            painted_cell_count: paintedCellCount,
            remaining_unpainted_cells: remaining,
            coverage_ratio: roundMetric(coverageRatio),
            move_count: moveCount,
            valid_move_count: this._validMoveCount,
            invalid_move_count: this._invalidMoveCount,
            elapsed_time_ms: Math.round(elapsed),
            optimal_move_count: optimalMoveCount,
            score,
            board: Object.freeze({
                rows: this._level.rows,
                columns: this._level.columns,
                total_paintable_cells: this._level.totalPaintableCells,
                painted_cell_count: paintedCellCount,
                remaining_unpainted_cells: remaining,
                coverage_ratio: roundMetric(coverageRatio),
            }),
            ball: Object.freeze({
                row: this._state.ball.row,
                column: this._state.ball.column,
                is_moving: isMoving,
            }),
            actions: Object.freeze({
                move_count: moveCount,
                valid_move_count: this._validMoveCount,
                invalid_move_count: this._invalidMoveCount,
                productive_move_count: this._productiveMoveCount,
                zero_progress_move_count: this._zeroProgressMoveCount,
                repeated_action_count: this._repeatedActionCount,
                newly_painted_cells_per_move: Object.freeze([...this._newlyPaintedCellsPerMove]),
                total_newly_painted_cells: this._totalNewlyPaintedCells,
                valid_move_ratio: roundMetric(validMoveRatio),
                invalid_move_ratio: roundMetric(invalidMoveRatio),
                productive_move_ratio: roundMetric(productiveMoveRatio),
                redundant_move_ratio: roundMetric(redundantMoveRatio),
            }),
            efficiency: Object.freeze({
                optimal_move_count: optimalMoveCount,
                actual_move_count: moveCount,
                extra_move_count: extraMoveCount,
                move_efficiency: roundMetric(moveEfficiency),
                mean_new_cells_per_valid_move: roundMetric(
                    this._totalNewlyPaintedCells / Math.max(this._validMoveCount, 1),
                ),
                max_new_cells_in_one_move: this._maxNewCellsInOneMove,
                painted_cells_per_move: roundMetric(
                    this._totalNewlyPaintedCells / Math.max(moveCount, 1),
                ),
            }),
            traversal: Object.freeze({
                total_traversed_cells: this._totalTraversedCells,
                newly_painted_traversals: this._newlyPaintedTraversals,
                already_painted_traversals: this._alreadyPaintedTraversals,
                new_cell_traversal_ratio: roundMetric(ratio(
                    this._newlyPaintedTraversals,
                    this._totalTraversedCells,
                )),
                repainted_cell_traversal_ratio: roundMetric(ratio(
                    this._alreadyPaintedTraversals,
                    this._totalTraversedCells,
                )),
            }),
            state_analysis: Object.freeze({
                state_hash: hashMazePaintState(this._level, this._state),
                unique_state_count: this._stateVisits.size,
                revisited_state_count: this._revisitedStateCount,
                state_revisit_ratio: roundMetric(stateRevisitRatio),
                cycle_detected: this._cycle.detected,
                cycle_detected_ever: this._cycle.everDetected,
                cycle_length: this._cycle.length,
                cycle_repetitions: this._cycle.repetitions,
            }),
            progress: Object.freeze({
                remaining_connected_regions: this._remainingConnectedRegions(),
                reachable_unpainted_cells: this._reachableUnpaintedCells(),
                progress_delta_per_move: Object.freeze(
                    this._progressDeltaPerMove.map(roundMetric),
                ),
                best_coverage_ratio: roundMetric(this._bestCoverageRatio),
                moves_since_last_progress: this._movesSinceLastProgress,
            }),
            timing: Object.freeze({
                elapsed_time_ms: Math.round(elapsed),
                mean_move_duration_ms: Math.round(
                    this._moveDurationTimeMs / Math.max(moveCount, 1),
                ),
                decision_wait_time_ms: Math.round(this._decisionWaitTimeMs),
                animation_time_ms: Math.round(this._animationTimeMs),
            }),
            trajectory: Object.freeze([...this._trajectory]),
        });
    }
}
