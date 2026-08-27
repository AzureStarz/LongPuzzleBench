/** Read-only rule summary used by the evaluator-only benchmark bridge. */
export interface BoltDeadlockStatus {
    isDeadlocked: boolean;
    reason: 'no_available_hole' | null;
    availableHoleCount: number;
    legalProgressActionCount: number;
    pendingOperationCount: number;
    gameStateStable: boolean;
    awaitingOperationSettlement: boolean;
}

export interface BoltDeadlockInputs {
    levelSuccess: boolean;
    levelFailure: boolean;
    availableHoleCount: number;
    movableBoltCount: number;
    pendingOperationCount: number;
    gameStateStable: boolean;
    awaitingOperationSettlement: boolean;
}

/**
 * Evaluate a Bolt Unscrew deadlock from state already classified by the game
 * rules.  In this game every screw fits every insertable anchor and there are
 * no benchmark-visible power-ups, storage slots, or progress-producing undo
 * actions, so source/target pairs are the complete active move set.
 */
export function evaluateBoltDeadlock(input: BoltDeadlockInputs): BoltDeadlockStatus {
    const availableHoleCount = Math.max(0, Math.trunc(input.availableHoleCount));
    const movableBoltCount = Math.max(0, Math.trunc(input.movableBoltCount));
    const pendingOperationCount = Math.max(0, Math.trunc(input.pendingOperationCount));
    const legalProgressActionCount = availableHoleCount * movableBoltCount;
    const isDeadlocked = !input.levelSuccess
        && !input.levelFailure
        && availableHoleCount === 0
        && pendingOperationCount === 0
        && legalProgressActionCount === 0
        && !input.awaitingOperationSettlement
        && input.gameStateStable;

    return {
        isDeadlocked,
        reason: isDeadlocked ? 'no_available_hole' : null,
        availableHoleCount,
        legalProgressActionCount,
        pendingOperationCount,
        gameStateStable: input.gameStateStable,
        awaitingOperationSettlement: input.awaitingOperationSettlement,
    };
}
