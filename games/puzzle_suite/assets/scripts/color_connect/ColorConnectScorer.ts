export interface ColorConnectScoreInput {
    readonly success: boolean;
    readonly pairCompletionRatio: number;
    readonly bestProgress: number;
    readonly validActionRatio: number;
    readonly invalidActionRatio: number;
    readonly overlapAttemptRate: number;
    readonly pathLengthEfficiency: number | null;
    readonly actionsSinceLastProgress: number;
    readonly stateRevisitRatio: number;
}

function clamp01(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/**
 * Game-specific score adapter. Controller code never contains weights.
 * Every success is in [70, 100], while every failure is in [0, 69.999].
 */
export function scoreColorConnect(input: ColorConnectScoreInput): number {
    const current = clamp01(input.pairCompletionRatio);
    const best = clamp01(input.bestProgress);
    const valid = clamp01(input.validActionRatio);
    const invalid = clamp01(input.invalidActionRatio);
    const overlap = clamp01(input.overlapAttemptRate);
    const pathEfficiency = input.pathLengthEfficiency === null ? 0 : clamp01(input.pathLengthEfficiency);
    const revisit = clamp01(input.stateRevisitRatio);
    const stagnation = clamp01(input.actionsSinceLastProgress / 20);

    if (input.success) {
        const quality = 0.35 * valid
            + 0.25 * pathEfficiency
            + 0.15 * (1 - invalid)
            + 0.10 * (1 - overlap)
            + 0.10 * (1 - revisit)
            + 0.05 * (1 - stagnation);
        return round3(70 + 30 * clamp01(quality));
    }
    const partial = 0.55 * current
        + 0.25 * best
        + 0.10 * valid
        + 0.05 * (1 - overlap)
        + 0.05 * (1 - stagnation);
    return Math.min(69.999, round3(69.999 * clamp01(partial)));
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}
