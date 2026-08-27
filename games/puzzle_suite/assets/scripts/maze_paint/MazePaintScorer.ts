export interface MazePaintScoreInput {
    readonly success: boolean;
    readonly coverageRatio: number;
    readonly moveEfficiency: number;
    readonly productiveMoveRatio: number;
    readonly invalidMoveRatio: number;
    readonly redundantMoveRatio: number;
    readonly stateRevisitRatio: number;
}

export interface MazePaintScoreWeights {
    readonly successFloor: number;
    readonly completionQuality: number;
    readonly partialCoverage: number;
    readonly efficiency: number;
    readonly productivity: number;
    readonly invalidPenalty: number;
    readonly redundantPenalty: number;
    readonly revisitPenalty: number;
}

export const DEFAULT_MAZE_PAINT_SCORE_WEIGHTS: MazePaintScoreWeights = Object.freeze({
    successFloor: 70,
    completionQuality: 30,
    partialCoverage: 50,
    efficiency: 14,
    productivity: 10,
    invalidPenalty: 10,
    redundantPenalty: 8,
    revisitPenalty: 6,
});

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/**
 * Optional normalized score adapter. Raw evaluator metrics remain authoritative;
 * weights live here rather than in gameplay code so a unified benchmark can
 * replace them without changing the rules.
 */
export function scoreMazePaint(
    input: MazePaintScoreInput,
    weights: MazePaintScoreWeights = DEFAULT_MAZE_PAINT_SCORE_WEIGHTS,
): number {
    const coverage = clamp01(input.coverageRatio);
    const efficiency = clamp01(input.moveEfficiency);
    const productivity = clamp01(input.productiveMoveRatio);
    const penalty = (
        clamp01(input.invalidMoveRatio) * weights.invalidPenalty
        + clamp01(input.redundantMoveRatio) * weights.redundantPenalty
        + clamp01(input.stateRevisitRatio) * weights.revisitPenalty
    );
    const value = input.success
        ? weights.successFloor + weights.completionQuality * (
            0.55 * efficiency + 0.45 * productivity
        ) - penalty * 0.25
        : weights.partialCoverage * coverage
            + weights.efficiency * efficiency * coverage
            + weights.productivity * productivity * coverage
            - penalty;
    // The success floor remains above the maximum failed score by construction.
    const capped = input.success ? Math.max(weights.successFloor, value) : Math.min(69.999, value);
    return Math.round(Math.max(0, Math.min(100, capped)) * 1000) / 1000;
}
