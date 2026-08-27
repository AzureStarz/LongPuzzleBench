import {
    beginColorConnectPath,
    countColorConnectOccupiedCells,
    createInitialColorConnectState,
    extendColorConnectPathThrough,
    hashColorConnectState,
    releaseColorConnectPath,
    restartColorConnectState,
} from './ColorConnectRules';
import type {
    ColorConnectLevel,
    ColorConnectState,
    ColorConnectTransitionResult,
    ColorConnectViolation,
    GridPosition,
} from './ColorConnectRules';
import { scoreColorConnect } from './ColorConnectScorer';

export type ColorConnectFailureReason =
    | 'repeated_action_cycle'
    | 'no_progress'
    | 'max_steps'
    | 'timeout'
    | 'environment_error';
export type ColorConnectTerminationReason = 'success' | ColorConnectFailureReason;
export type ColorConnectStatus = 'running' | 'success' | 'failure';

export interface ColorConnectEvaluatorOptions {
    readonly maxSteps: number;
    readonly noProgressGestureLimit: number;
    readonly timeoutMs: number;
    readonly cycleFailureRepetitions: number;
    /** Verified reference cell count; null disables reference efficiency. */
    readonly referenceTotalPathLength: number | null;
}

export const DEFAULT_COLOR_CONNECT_EVALUATOR_OPTIONS: ColorConnectEvaluatorOptions = Object.freeze({
    maxSteps: 500,
    noProgressGestureLimit: 40,
    timeoutMs: 10 * 60 * 1000,
    cycleFailureRepetitions: 4,
    referenceTotalPathLength: null,
});

export interface ColorConnectGestureRecord {
    readonly step: number;
    readonly start_position: GridPosition;
    readonly sampled_cells: readonly GridPosition[];
    readonly valid: boolean;
    readonly completed_color_id: string | null;
    readonly cancelled_color_id: string | null;
    readonly backtracked_cell_count: number;
    readonly violations: readonly ColorConnectViolation[];
    readonly completed_pair_delta: number;
    readonly occupied_cell_delta: number;
    readonly progress_delta: number;
    readonly before_state_hash: string;
    readonly after_state_hash: string;
    readonly started_at_ms: number;
    readonly ended_at_ms: number;
    readonly duration_ms: number;
}

export interface ColorConnectEvaluatorSnapshot {
    readonly game_id: 'color_connect';
    readonly difficulty: string;
    readonly level: number;
    readonly level_id: string;
    readonly status: ColorConnectStatus;
    readonly success: boolean;
    readonly failure: boolean;
    readonly termination_reason: ColorConnectTerminationReason | null;
    readonly total_color_pairs: number;
    readonly completed_color_pairs: number;
    readonly remaining_color_pairs: number;
    readonly pair_completion_ratio: number;
    readonly completed_pair_ratio: number;
    readonly total_playable_cells: number;
    readonly occupied_path_cells: number;
    readonly coverage_ratio: number;
    readonly require_full_coverage: boolean;
    readonly elapsed_time_ms: number;
    readonly gesture_count: number;
    readonly valid_gesture_count: number;
    readonly invalid_gesture_count: number;
    readonly completed_connection_count: number;
    readonly incomplete_drag_count: number;
    readonly path_cancel_count: number;
    readonly path_backtrack_count: number;
    readonly restart_count: number;
    readonly state_hash: string;
    readonly board: Readonly<Record<string, number | boolean>>;
    readonly actions: Readonly<Record<string, number>>;
    readonly violations: Readonly<Record<string, number>>;
    readonly paths: readonly Readonly<Record<string, string | number | boolean>>[];
    readonly per_colors: readonly Readonly<Record<string, string | number | boolean>>[];
    readonly progress: Readonly<Record<string, number>>;
    readonly efficiency: Readonly<Record<string, number | null>>;
    readonly state_analysis: Readonly<Record<string, number | boolean | null>>;
    readonly timing: Readonly<Record<string, number>>;
    readonly trajectory: readonly ColorConnectGestureRecord[];
    readonly score: number;
}

interface GestureAccumulator {
    readonly startPosition: GridPosition;
    readonly startedAtMs: number;
    readonly beforeStateHash: string;
    readonly beforeCompletedCount: number;
    readonly beforeOccupiedCount: number;
    readonly sampledCells: GridPosition[];
    readonly violations: ColorConnectViolation[];
    completedColorId: string | null;
    cancelledColorId: string | null;
    backtrackedCellCount: number;
}

interface CycleSummary {
    readonly detected: boolean;
    readonly length: number | null;
    readonly repetitions: number;
}

function freezePosition(position: GridPosition): GridPosition {
    return Object.freeze({ row: position.row, column: position.column });
}

function round4(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

function ratio(numerator: number, denominator: number): number {
    return denominator > 0 ? round4(numerator / denominator) : 0;
}

function stableGestureSignature(record: ColorConnectGestureRecord): string {
    return `${record.start_position.row},${record.start_position.column}`
        + `>${record.sampled_cells.map(cell => `${cell.row},${cell.column}`).join(';')}`
        + `!${record.violations.join(',')}`
        + `#${record.after_state_hash}`;
}

function detectCycle(history: readonly string[]): CycleSummary {
    const maximumLength = Math.min(12, Math.floor(history.length / 2));
    let best: CycleSummary = { detected: false, length: null, repetitions: 0 };
    for (let length = 1; length <= maximumLength; length++) {
        let repetitions = 1;
        while ((repetitions + 1) * length <= history.length) {
            const rightStart = history.length - repetitions * length;
            const leftStart = rightStart - length;
            let equal = true;
            for (let offset = 0; offset < length; offset++) {
                if (history[leftStart + offset] !== history[rightStart + offset]) {
                    equal = false;
                    break;
                }
            }
            if (!equal) break;
            repetitions++;
        }
        if (repetitions >= 2 && (repetitions > best.repetitions
            || (repetitions === best.repetitions && (best.length === null || length < best.length)))) {
            best = { detected: true, length, repetitions };
        }
    }
    return best;
}

/** Authoritative metric collector; it owns and transitions the same pure state used by rendering. */
export class ColorConnectEvaluator {
    public readonly level: ColorConnectLevel;
    private readonly options: ColorConnectEvaluatorOptions;
    private _state: ColorConnectState;
    private _status: ColorConnectStatus = 'running';
    private _terminationReason: ColorConnectTerminationReason | null = null;
    private startedAtMs: number;
    private terminalAtMs: number | null = null;
    private gesture: GestureAccumulator | null = null;
    private gestureCount = 0;
    private validGestureCount = 0;
    private invalidGestureCount = 0;
    private completedConnectionCount = 0;
    private incompleteDragCount = 0;
    private pathCancelCount = 0;
    private pathBacktrackCount = 0;
    private backtrackedCellCount = 0;
    private restartCount = 0;
    private bestCompletedPairCount = 0;
    private actionsSinceLastProgress = 0;
    private zeroProgressActionCount = 0;
    private progressRegressionCount = 0;
    private repeatedGestureCount = 0;
    private revisitedStateCount = 0;
    private cycleDetectedEver = false;
    private totalGestureDurationMs = 0;
    private readonly violationCounts: Record<ColorConnectViolation, number>;
    private readonly pathEditCounts: Record<string, number>;
    private readonly pathCancelCounts: Record<string, number>;
    private stateHistory: string[] = [];
    private stateVisitCounts = new Map<string, number>();
    private gestureSignatureCounts = new Map<string, number>();
    private trajectoryRecords: ColorConnectGestureRecord[] = [];

    public constructor(
        level: ColorConnectLevel,
        startTimeMs: number = Date.now(),
        overrides: Partial<ColorConnectEvaluatorOptions> = {},
    ) {
        this.level = level;
        this.options = Object.freeze({ ...DEFAULT_COLOR_CONNECT_EVALUATOR_OPTIONS, ...overrides });
        if (this.options.maxSteps <= 0 || this.options.noProgressGestureLimit <= 0
            || this.options.timeoutMs <= 0 || this.options.cycleFailureRepetitions < 2) {
            throw new Error('Color Connect evaluator limits must be positive (cycle repetitions must be at least two).');
        }
        this._state = createInitialColorConnectState(level);
        this.startedAtMs = startTimeMs;
        this.violationCounts = Object.create(null) as Record<ColorConnectViolation, number>;
        for (const violation of ColorConnectEvaluator.violationKinds()) this.violationCounts[violation] = 0;
        this.pathEditCounts = Object.create(null) as Record<string, number>;
        this.pathCancelCounts = Object.create(null) as Record<string, number>;
        for (const pair of level.colorPairs) {
            this.pathEditCounts[pair.colorId] = 0;
            this.pathCancelCounts[pair.colorId] = 0;
        }
        this.recordInitialState();
    }

    public get state(): ColorConnectState {
        return this._state;
    }

    public get status(): ColorConnectStatus {
        return this._status;
    }

    public get terminal(): boolean {
        return this._status !== 'running';
    }

    public beginGesture(position: GridPosition, nowMs: number = Date.now()): ColorConnectTransitionResult {
        if (this.terminal) return beginColorConnectPath(this.level, this._state, position);
        if (this.gesture) throw new Error('A Color Connect gesture is already active.');
        this.gesture = {
            startPosition: freezePosition(position),
            startedAtMs: nowMs,
            beforeStateHash: hashColorConnectState(this.level, this._state),
            beforeCompletedCount: this._state.completedColorCount,
            beforeOccupiedCount: countColorConnectOccupiedCells(this._state),
            sampledCells: [],
            violations: [],
            completedColorId: null,
            cancelledColorId: null,
            backtrackedCellCount: 0,
        };
        return this.commitTransition(beginColorConnectPath(this.level, this._state, position), nowMs);
    }

    /** Adjacent cells work directly; a same-row/column fast sample is filled cell-by-cell. */
    public extendGesture(position: GridPosition, nowMs: number = Date.now()): ColorConnectTransitionResult {
        if (!this.gesture) throw new Error('Cannot extend a Color Connect gesture before beginGesture.');
        if (this.terminal && !this._state.success) return extendColorConnectPathThrough(this.level, this._state, position);
        return this.commitTransition(extendColorConnectPathThrough(this.level, this._state, position), nowMs);
    }

    /** Ends one press-drag-release and commits exactly one trajectory record. */
    public endGesture(nowMs: number = Date.now()): ColorConnectTransitionResult {
        const release = releaseColorConnectPath(this.level, this._state);
        if (!this.gesture) return release;
        const transition = this.commitTransition(release, nowMs);
        const active = this.gesture;
        const afterHash = hashColorConnectState(this.level, this._state);
        const completedPairDelta = this._state.completedColorCount - active.beforeCompletedCount;
        const occupiedCellDelta = countColorConnectOccupiedCells(this._state) - active.beforeOccupiedCount;
        const progressDelta = completedPairDelta / this.level.colorPairs.length;
        const valid = active.beforeStateHash !== afterHash;
        this.gestureCount++;
        if (valid) this.validGestureCount++;
        else this.invalidGestureCount++;
        const durationMs = Math.max(0, nowMs - active.startedAtMs);
        this.totalGestureDurationMs += durationMs;
        const record: ColorConnectGestureRecord = Object.freeze({
            step: this.gestureCount,
            start_position: active.startPosition,
            sampled_cells: Object.freeze(active.sampledCells.map(freezePosition)),
            valid,
            completed_color_id: active.completedColorId,
            cancelled_color_id: active.cancelledColorId,
            backtracked_cell_count: active.backtrackedCellCount,
            violations: Object.freeze([...active.violations]),
            completed_pair_delta: completedPairDelta,
            occupied_cell_delta: occupiedCellDelta,
            progress_delta: round4(progressDelta),
            before_state_hash: active.beforeStateHash,
            after_state_hash: afterHash,
            started_at_ms: active.startedAtMs,
            ended_at_ms: nowMs,
            duration_ms: durationMs,
        });
        this.trajectoryRecords.push(record);
        this.gesture = null;
        this.recordCommittedState(afterHash, record);
        this.updateProgressAndTermination(completedPairDelta, nowMs);
        return transition;
    }

    /** Convenience for harnesses: pressing an already connected endpoint is one gesture. */
    public cancelCompletedAtEndpoint(position: GridPosition, nowMs: number = Date.now()): ColorConnectTransitionResult {
        this.beginGesture(position, nowMs);
        return this.endGesture(nowMs);
    }

    /** Reset the run-local trajectory/counters; restart_count remains cumulative. */
    public restart(nowMs: number = Date.now()): ColorConnectState {
        this.restartCount++;
        this._state = restartColorConnectState(this.level);
        this._status = 'running';
        this._terminationReason = null;
        this.startedAtMs = nowMs;
        this.terminalAtMs = null;
        this.gesture = null;
        this.gestureCount = 0;
        this.validGestureCount = 0;
        this.invalidGestureCount = 0;
        this.completedConnectionCount = 0;
        this.incompleteDragCount = 0;
        this.pathCancelCount = 0;
        this.pathBacktrackCount = 0;
        this.backtrackedCellCount = 0;
        this.bestCompletedPairCount = 0;
        this.actionsSinceLastProgress = 0;
        this.zeroProgressActionCount = 0;
        this.progressRegressionCount = 0;
        this.repeatedGestureCount = 0;
        this.revisitedStateCount = 0;
        this.cycleDetectedEver = false;
        this.totalGestureDurationMs = 0;
        for (const violation of ColorConnectEvaluator.violationKinds()) this.violationCounts[violation] = 0;
        for (const pair of this.level.colorPairs) {
            this.pathEditCounts[pair.colorId] = 0;
            this.pathCancelCounts[pair.colorId] = 0;
        }
        this.stateHistory = [];
        this.stateVisitCounts = new Map<string, number>();
        this.gestureSignatureCounts = new Map<string, number>();
        this.trajectoryRecords = [];
        this.recordInitialState();
        return this._state;
    }

    public terminate(reason: ColorConnectFailureReason, nowMs: number = Date.now()): void {
        if (this.terminal) return;
        this._status = 'failure';
        this._terminationReason = reason;
        this.terminalAtMs = nowMs;
    }

    public snapshot(nowMs: number = Date.now()): ColorConnectEvaluatorSnapshot {
        this.checkTimeout(nowMs);
        const completed = this._state.completedColorCount;
        const total = this.level.colorPairs.length;
        const occupied = countColorConnectOccupiedCells(this._state);
        const pairCompletionRatio = ratio(completed, total);
        const coverageRatio = ratio(occupied, this.level.totalPlayableCells);
        const validActionRatio = ratio(this.validGestureCount, this.gestureCount);
        const invalidActionRatio = ratio(this.invalidGestureCount, this.gestureCount);
        const overlapAttemptCount = this.violationCounts.path_overlap_attempt;
        const overlapAttemptRate = ratio(overlapAttemptCount, this.gestureCount);
        const currentTotalPathLength = this.currentTotalPathLength();
        const completedLengths = Object.keys(this._state.paths)
            .map(colorId => this._state.paths[colorId])
            .filter(path => path.completed)
            .map(path => path.cells.length);
        const actualTotalPathLength = completedLengths.reduce((sum, length) => sum + length, 0);
        const reference = this.options.referenceTotalPathLength;
        const referenceEfficiency = this._state.success && reference !== null && reference > 0
            ? round4(reference / Math.max(actualTotalPathLength, reference))
            : null;
        const cycle = detectCycle(this.stateHistory);
        const stateRevisitRatio = ratio(this.revisitedStateCount, this.gestureCount);
        const elapsed = Math.max(0, (this.terminalAtMs ?? nowMs) - this.startedAtMs);
        const score = scoreColorConnect({
            success: this._state.success,
            pairCompletionRatio,
            bestProgress: ratio(this.bestCompletedPairCount, total),
            validActionRatio,
            invalidActionRatio,
            overlapAttemptRate,
            pathLengthEfficiency: referenceEfficiency,
            actionsSinceLastProgress: this.actionsSinceLastProgress,
            stateRevisitRatio,
        });

        const board = Object.freeze({
            rows: this.level.rows,
            columns: this.level.columns,
            total_color_pairs: total,
            completed_color_pairs: completed,
            remaining_color_pairs: total - completed,
            pair_completion_ratio: pairCompletionRatio,
            total_playable_cells: this.level.totalPlayableCells,
            occupied_path_cells: occupied,
            coverage_ratio: coverageRatio,
            require_full_coverage: this.level.requireFullCoverage,
        });
        const actions = Object.freeze({
            gesture_count: this.gestureCount,
            valid_gesture_count: this.validGestureCount,
            invalid_gesture_count: this.invalidGestureCount,
            completed_connection_count: this.completedConnectionCount,
            incomplete_drag_count: this.incompleteDragCount,
            path_cancel_count: this.pathCancelCount,
            completed_path_reopen_count: this.pathCancelCount,
            path_backtrack_count: this.pathBacktrackCount,
            backtracked_cell_count: this.backtrackedCellCount,
            restart_count: this.restartCount,
            repeated_gesture_count: this.repeatedGestureCount,
            valid_action_ratio: validActionRatio,
            invalid_action_ratio: invalidActionRatio,
        });
        const violations = Object.freeze({
            start_from_non_endpoint_count: this.violationCounts.start_from_non_endpoint,
            overlap_attempt_count: overlapAttemptCount,
            blocked_cell_attempt_count: this.violationCounts.entered_blocked_cell,
            wrong_endpoint_attempt_count: this.violationCounts.entered_other_color_endpoint,
            non_adjacent_jump_count: this.violationCounts.non_adjacent_jump_attempt,
            self_intersection_attempt_count: this.violationCounts.path_self_intersection_attempt,
            outside_board_attempt_count: this.violationCounts.drag_outside_board,
            released_before_connection_count: this.violationCounts.released_before_connection,
            overlap_attempt_rate: overlapAttemptRate,
        });
        const pathSnapshots = Object.freeze(this.level.colorPairs.map(pair => {
            const path = this._state.paths[pair.colorId];
            const activeLength = this._state.activeColorId === pair.colorId ? this._state.activePath.length : 0;
            return Object.freeze({
                color_id: pair.colorId,
                connected: path.completed,
                current_path_length: path.completed ? path.cells.length : activeLength,
                final_path_length: path.completed ? path.cells.length : 0,
                path_edit_count: this.pathEditCounts[pair.colorId],
                cancel_count: this.pathCancelCounts[pair.colorId],
            });
        }));
        const progress = Object.freeze({
            current_progress: pairCompletionRatio,
            best_progress: ratio(this.bestCompletedPairCount, total),
            completed_pair_delta: this.trajectoryRecords.length > 0
                ? this.trajectoryRecords[this.trajectoryRecords.length - 1].completed_pair_delta : 0,
            occupied_cell_delta: this.trajectoryRecords.length > 0
                ? this.trajectoryRecords[this.trajectoryRecords.length - 1].occupied_cell_delta : 0,
            progress_delta: this.trajectoryRecords.length > 0
                ? this.trajectoryRecords[this.trajectoryRecords.length - 1].progress_delta : 0,
            best_completed_pair_count: this.bestCompletedPairCount,
            actions_since_last_progress: this.actionsSinceLastProgress,
            zero_progress_action_count: this.zeroProgressActionCount,
            progress_regression_count: this.progressRegressionCount,
        });
        const efficiency = Object.freeze({
            valid_action_ratio: validActionRatio,
            invalid_action_ratio: invalidActionRatio,
            overlap_attempt_rate: overlapAttemptRate,
            gestures_per_completed_pair: ratio(this.gestureCount, completed),
            invalid_gestures_per_pair: ratio(this.invalidGestureCount, completed),
            path_cancellations_per_pair: ratio(this.pathCancelCount, Math.max(completed, 1)),
            backtracks_per_pair: ratio(this.pathBacktrackCount, Math.max(completed, 1)),
            time_per_completed_pair: ratio(elapsed, completed),
            mean_completed_path_length: completedLengths.length > 0
                ? round4(actualTotalPathLength / completedLengths.length) : 0,
            longest_completed_path_length: completedLengths.length > 0 ? Math.max(...completedLengths) : 0,
            current_total_path_length: currentTotalPathLength,
            reference_total_path_length: reference,
            actual_total_path_length: actualTotalPathLength,
            extra_path_length: reference !== null && this._state.success
                ? Math.max(0, actualTotalPathLength - reference) : null,
            reference_path_efficiency: referenceEfficiency,
            // Reserved for a proven strict optimum. The current bounded solver
            // deliberately supplies only a validated reference solution.
            path_length_efficiency: null,
        });
        const stateAnalysis = Object.freeze({
            unique_state_count: this.stateVisitCounts.size,
            revisited_state_count: this.revisitedStateCount,
            state_revisit_ratio: stateRevisitRatio,
            repeated_gesture_count: this.repeatedGestureCount,
            cycle_detected: cycle.detected,
            cycle_detected_ever: this.cycleDetectedEver,
            cycle_length: cycle.length,
            cycle_repetitions: cycle.repetitions,
        });
        const timing = Object.freeze({
            elapsed_time_ms: elapsed,
            mean_gesture_duration_ms: ratio(this.totalGestureDurationMs, this.gestureCount),
            total_gesture_duration_ms: this.totalGestureDurationMs,
        });
        return Object.freeze({
            game_id: 'color_connect',
            difficulty: this.level.difficulty,
            level: this.level.levelNumber,
            level_id: this.level.id,
            status: this._status,
            success: this._state.success,
            failure: this._status === 'failure',
            termination_reason: this._terminationReason,
            total_color_pairs: total,
            completed_color_pairs: completed,
            remaining_color_pairs: total - completed,
            pair_completion_ratio: pairCompletionRatio,
            completed_pair_ratio: pairCompletionRatio,
            total_playable_cells: this.level.totalPlayableCells,
            occupied_path_cells: occupied,
            coverage_ratio: coverageRatio,
            require_full_coverage: this.level.requireFullCoverage,
            elapsed_time_ms: elapsed,
            gesture_count: this.gestureCount,
            valid_gesture_count: this.validGestureCount,
            invalid_gesture_count: this.invalidGestureCount,
            completed_connection_count: this.completedConnectionCount,
            incomplete_drag_count: this.incompleteDragCount,
            path_cancel_count: this.pathCancelCount,
            path_backtrack_count: this.pathBacktrackCount,
            restart_count: this.restartCount,
            state_hash: hashColorConnectState(this.level, this._state),
            board,
            actions,
            violations,
            paths: pathSnapshots,
            per_colors: pathSnapshots,
            progress,
            efficiency,
            state_analysis: stateAnalysis,
            timing,
            trajectory: Object.freeze([...this.trajectoryRecords]),
            score,
        });
    }

    private commitTransition(
        transition: ColorConnectTransitionResult,
        nowMs: number = Date.now(),
    ): ColorConnectTransitionResult {
        this._state = transition.nextState;
        if (!this.gesture) return transition;
        for (const cell of transition.enteredCells) this.gesture.sampledCells.push(freezePosition(cell));
        if (transition.violation) {
            this.gesture.violations.push(transition.violation);
            this.violationCounts[transition.violation]++;
            if (transition.violation === 'released_before_connection') this.incompleteDragCount++;
        }
        if (transition.backtrackedCellCount > 0) {
            this.pathBacktrackCount++;
            this.backtrackedCellCount += transition.backtrackedCellCount;
            this.gesture.backtrackedCellCount += transition.backtrackedCellCount;
            if (this._state.activeColorId) this.pathEditCounts[this._state.activeColorId]++;
        } else if (transition.changed && this._state.activeColorId) {
            this.pathEditCounts[this._state.activeColorId]++;
        }
        if (transition.completedColorId) {
            this.completedConnectionCount++;
            this.gesture.completedColorId = transition.completedColorId;
            this.pathEditCounts[transition.completedColorId]++;
            if (this._state.success) {
                this._status = 'success';
                this._terminationReason = 'success';
                this.terminalAtMs = this.terminalAtMs ?? nowMs;
            }
        }
        if (transition.cancelledColorId) {
            this.pathCancelCount++;
            this.gesture.cancelledColorId = transition.cancelledColorId;
            this.pathCancelCounts[transition.cancelledColorId]++;
            this.pathEditCounts[transition.cancelledColorId]++;
        }
        return transition;
    }

    private recordInitialState(): void {
        const hash = hashColorConnectState(this.level, this._state);
        this.stateHistory.push(hash);
        this.stateVisitCounts.set(hash, 1);
    }

    private recordCommittedState(hash: string, record: ColorConnectGestureRecord): void {
        this.stateHistory.push(hash);
        const visits = this.stateVisitCounts.get(hash) ?? 0;
        if (visits > 0) this.revisitedStateCount++;
        this.stateVisitCounts.set(hash, visits + 1);
        const signature = stableGestureSignature(record);
        const priorSignatures = this.gestureSignatureCounts.get(signature) ?? 0;
        if (priorSignatures > 0) this.repeatedGestureCount++;
        this.gestureSignatureCounts.set(signature, priorSignatures + 1);
        const cycle = detectCycle(this.stateHistory);
        this.cycleDetectedEver = this.cycleDetectedEver || cycle.detected;
    }

    private updateProgressAndTermination(completedPairDelta: number, nowMs: number): void {
        if (this._state.completedColorCount > this.bestCompletedPairCount) {
            this.bestCompletedPairCount = this._state.completedColorCount;
            this.actionsSinceLastProgress = 0;
        } else {
            this.actionsSinceLastProgress++;
            this.zeroProgressActionCount++;
        }
        if (completedPairDelta < 0) this.progressRegressionCount++;
        if (this._state.success) {
            this._status = 'success';
            this._terminationReason = 'success';
            this.terminalAtMs = this.terminalAtMs ?? nowMs;
            return;
        }
        const cycle = detectCycle(this.stateHistory);
        const requiredCycleActions = (cycle.length ?? 1) * this.options.cycleFailureRepetitions;
        if (cycle.detected && cycle.repetitions >= this.options.cycleFailureRepetitions
            // stateHistory includes the pre-action initial state. Require the
            // configured number of repeated action cycles, not one fewer.
            && this.actionsSinceLastProgress >= requiredCycleActions) {
            this.terminate('repeated_action_cycle', nowMs);
        } else if (this.gestureCount >= this.options.maxSteps) {
            this.terminate('max_steps', nowMs);
        } else if (this.actionsSinceLastProgress >= this.options.noProgressGestureLimit) {
            this.terminate('no_progress', nowMs);
        }
    }

    private currentTotalPathLength(): number {
        let total = Object.keys(this._state.paths).map(colorId => this._state.paths[colorId])
            .filter(path => path.completed)
            .reduce((sum, path) => sum + path.cells.length, 0);
        if (this._state.activeColorId) total += this._state.activePath.length;
        return total;
    }

    private checkTimeout(nowMs: number): void {
        if (!this.terminal && nowMs - this.startedAtMs >= this.options.timeoutMs) {
            this.terminate('timeout', this.startedAtMs + this.options.timeoutMs);
        }
    }

    private static violationKinds(): readonly ColorConnectViolation[] {
        return [
            'start_from_non_endpoint', 'entered_blocked_cell', 'entered_other_color_endpoint',
            'path_overlap_attempt', 'path_self_intersection_attempt', 'non_adjacent_jump_attempt',
            'released_before_connection', 'drag_outside_board', 'input_without_active_path',
            'game_already_complete',
        ];
    }
}
