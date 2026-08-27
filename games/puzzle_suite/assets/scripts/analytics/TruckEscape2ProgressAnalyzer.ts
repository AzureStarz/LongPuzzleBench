import type { TruckEscape2LevelData } from '../data/TruckEscape2Data';
import { TruckEscape2BoardModel } from '../game/TruckEscape2BoardModel';
import type {
    TruckEscape2ProgressSnapshot,
    TruckEscape2ReferenceSolution,
    TruckEscape2ReferenceSource,
} from './TruckEscape2AbilityTypes';

export interface TruckEscape2ProgressReference {
    solution?: TruckEscape2ReferenceSolution | null;
    /** Best trustworthy completed result when an exact/design reference is unavailable. */
    historicalBestMoves?: number | null;
}

interface ParsedPosition {
    row: number;
    col: number;
}

const MAX_INCOMPLETE_PROGRESS = 0.99;

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function parseStateKey(level: TruckEscape2LevelData, stateKey: string): ParsedPosition[] | null {
    const parts = stateKey.split('|');
    if (parts.length !== level.vehicles.length) return null;
    const positions: ParsedPosition[] = [];
    for (const part of parts) {
        const [rowText, colText] = part.split(',');
        const row = Number(rowText);
        const col = Number(colText);
        if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
        positions.push({ row, col });
    }
    return positions;
}

function targetAndDirectBlockers(
    level: TruckEscape2LevelData,
    positions: ParsedPosition[],
): { targetAdvanceRatio: number; directBlockerCount: number } {
    const targetIndex = level.vehicles.findIndex((vehicle) => vehicle.target);
    if (targetIndex < 0) return { targetAdvanceRatio: 0, directBlockerCount: 0 };
    const target = level.vehicles[targetIndex];
    const targetState = positions[targetIndex];
    const exitCol = level.cols - target.length;
    const initialCol = target.col;
    const totalAdvance = Math.max(1, exitCol - initialCol);
    const targetAdvanceRatio = clamp01((targetState.col - initialCol) / totalAdvance);
    const blockers = new Set<string>();

    const firstExitCol = targetState.col + target.length;
    for (let index = 0; index < level.vehicles.length; index++) {
        if (index === targetIndex) continue;
        const spec = level.vehicles[index];
        const state = positions[index];
        for (let cell = 0; cell < spec.length; cell++) {
            const row = state.row + (spec.orientation === 'vertical' ? cell : 0);
            const col = state.col + (spec.orientation === 'horizontal' ? cell : 0);
            if (row === targetState.row && col >= firstExitCol && col < level.cols) {
                blockers.add(spec.id);
            }
        }
    }
    for (const blocker of level.blockers ?? []) {
        if (blocker.row === targetState.row && blocker.col >= firstExitCol && blocker.col < level.cols) {
            blockers.add(blocker.id);
        }
    }
    return { targetAdvanceRatio, directBlockerCount: blockers.size };
}

function stateDifference(left: string, right: string): number {
    const a = left.split('|');
    const b = right.split('|');
    if (a.length !== b.length) return Math.max(a.length, b.length);
    let different = 0;
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) different++;
    }
    return different;
}

/**
 * Computes progress from the pure board model without touching UI state.
 *
 * Exact distances are used for states on the solver-verified canonical path.
 * Other states use a clearly labelled estimate: the minimum number of vehicle
 * positions that differ from a canonical state plus that state's exact
 * remaining distance, never below the direct-obstruction lower bound. This is
 * intentionally cheap enough to run after every drag and never reports a
 * bounded-search timeout as a deadlock.
 */
export class TruckEscape2ProgressAnalyzer {
    static analyze(
        model: TruckEscape2BoardModel,
        reference: TruckEscape2ProgressReference = {},
    ): TruckEscape2ProgressSnapshot {
        const level = model.level;
        const stateKey = model.serialize();
        const complete = model.isComplete();
        const positions = parseStateKey(level, stateKey)
            ?? level.vehicles.map((vehicle) => ({ row: vehicle.row, col: vehicle.col }));
        const goal = targetAndDirectBlockers(level, positions);
        const structuralLowerBound = complete ? 0 : 1 + goal.directBlockerCount;

        let legalMoveCount = 0;
        let movableVehicleCount = 0;
        for (const vehicle of level.vehicles) {
            const range = model.getTravelRange(vehicle.id);
            const count = Math.max(0, -range.min) + Math.max(0, range.max);
            legalMoveCount += count;
            if (count > 0) movableVehicleCount++;
        }

        const solution = reference.solution ?? null;
        const historicalBest = Number.isFinite(reference.historicalBestMoves)
            && (reference.historicalBestMoves ?? 0) > 0
            ? Math.floor(reference.historicalBestMoves as number)
            : null;
        let referenceSource: TruckEscape2ReferenceSource = 'structural-estimate';
        let referenceVersion: string | null = null;
        let referenceMoves: number | null = historicalBest;
        let canonicalPathIndex: number | null = null;
        let canonicalStateSimilarity = 0;
        let exactMovesRemaining: number | null = complete ? 0 : null;
        let estimatedMovesRemaining: number | null = complete ? 0 : structuralLowerBound;
        let progressRatio = complete ? 1 : 0;
        let distanceConfidence: TruckEscape2ProgressSnapshot['distanceConfidence'] = 'lower-bound';

        if (solution && solution.states.length === solution.optimalMoves + 1) {
            referenceSource = solution.source;
            referenceVersion = solution.solverVersion;
            referenceMoves = solution.optimalMoves;
            let bestEstimatedRemaining = Number.POSITIVE_INFINITY;
            let bestSimilarity = 0;
            for (let index = 0; index < solution.states.length; index++) {
                const referenceState = solution.states[index];
                const difference = stateDifference(stateKey, referenceState);
                const parts = Math.max(1, level.vehicles.length);
                bestSimilarity = Math.max(bestSimilarity, 1 - difference / parts);
                bestEstimatedRemaining = Math.min(
                    bestEstimatedRemaining,
                    difference + solution.optimalMoves - index,
                );
                if (referenceState === stateKey) canonicalPathIndex = index;
            }
            canonicalStateSimilarity = clamp01(bestSimilarity);
            if (complete) {
                exactMovesRemaining = 0;
                estimatedMovesRemaining = 0;
                distanceConfidence = 'exact';
                progressRatio = 1;
            } else if (canonicalPathIndex !== null) {
                exactMovesRemaining = Math.max(0, solution.optimalMoves - canonicalPathIndex);
                estimatedMovesRemaining = exactMovesRemaining;
                distanceConfidence = 'exact';
                progressRatio = solution.optimalMoves > 0
                    ? Math.min(MAX_INCOMPLETE_PROGRESS, canonicalPathIndex / solution.optimalMoves)
                    : 0;
            } else {
                estimatedMovesRemaining = Math.max(
                    structuralLowerBound,
                    Number.isFinite(bestEstimatedRemaining)
                        ? bestEstimatedRemaining
                        : structuralLowerBound,
                );
                distanceConfidence = 'estimated';
                const distanceProgress = solution.optimalMoves > 0
                    ? clamp01((solution.optimalMoves - estimatedMovesRemaining) / solution.optimalMoves)
                    : 0;
                const initialPositions = parseStateKey(level, solution.states[0]);
                const initialGoal = initialPositions
                    ? targetAndDirectBlockers(level, initialPositions)
                    : { targetAdvanceRatio: 0, directBlockerCount: goal.directBlockerCount };
                const blockerClearance = initialGoal.directBlockerCount > 0
                    ? clamp01((initialGoal.directBlockerCount - goal.directBlockerCount) / initialGoal.directBlockerCount)
                    : goal.targetAdvanceRatio;
                const structuralProgress = 0.7 * blockerClearance + 0.3 * goal.targetAdvanceRatio;
                progressRatio = Math.min(
                    MAX_INCOMPLETE_PROGRESS,
                    clamp01(0.8 * distanceProgress + 0.2 * structuralProgress),
                );
            }
        } else {
            referenceSource = historicalBest !== null ? 'historical-best' : 'structural-estimate';
            referenceVersion = historicalBest !== null ? 'local-history-v1' : null;
            referenceMoves = historicalBest;
            const initialPositions = level.vehicles.map((vehicle) => ({ row: vehicle.row, col: vehicle.col }));
            const initialGoal = targetAndDirectBlockers(level, initialPositions);
            const blockerClearance = initialGoal.directBlockerCount > 0
                ? clamp01((initialGoal.directBlockerCount - goal.directBlockerCount) / initialGoal.directBlockerCount)
                : goal.targetAdvanceRatio;
            progressRatio = complete
                ? 1
                : Math.min(MAX_INCOMPLETE_PROGRESS, 0.7 * blockerClearance + 0.3 * goal.targetAdvanceRatio);
        }

        let deadlockStatus: TruckEscape2ProgressSnapshot['deadlockStatus'] = 'unknown';
        if (!complete && legalMoveCount === 0) {
            deadlockStatus = 'confirmed';
        } else if (solution?.source === 'verified-optimal') {
            // Every legal slide is reversible. Starting from a verified-solvable
            // initial state, a legal play state can always reverse to that state.
            deadlockStatus = 'safe-reversible';
        }

        return {
            stateKey,
            complete,
            referenceSource,
            referenceVersion,
            referenceMoves,
            exactMovesRemaining,
            estimatedMovesRemaining,
            structuralLowerBound,
            distanceConfidence,
            progressRatio: complete ? 1 : Math.min(MAX_INCOMPLETE_PROGRESS, clamp01(progressRatio)),
            directBlockerCount: goal.directBlockerCount,
            legalMoveCount,
            movableVehicleCount,
            canonicalPathIndex,
            canonicalStateSimilarity,
            deadlockStatus,
        };
    }
}
