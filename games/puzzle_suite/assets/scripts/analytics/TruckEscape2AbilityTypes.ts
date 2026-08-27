import type { TruckEscape2Difficulty } from '../data/TruckEscape2Data';

/**
 * Serialized data contract for Truck Escape 2 player-ability analytics.
 *
 * Bump the schema version when stored fields change incompatibly. Bump the
 * scoring version when formulas or weights change without changing the shape.
 */
export const TRUCK_ESCAPE_2_ABILITY_SCHEMA_VERSION = 1;
export const TRUCK_ESCAPE_2_SCORING_VERSION = 'truck-escape-2-ability-v1';

export type TruckEscape2ReferenceSource =
    | 'verified-optimal'
    | 'designer-reference'
    | 'historical-best'
    | 'structural-estimate';

export type TruckEscape2DistanceConfidence = 'exact' | 'estimated' | 'lower-bound';

export type TruckEscape2DeadlockStatus =
    | 'safe-reversible'
    | 'confirmed'
    | 'unknown';

export type TruckEscape2AttemptStartReason =
    | 'initial'
    | 'restart'
    | 'next-level'
    | 'replay-after-complete'
    | 'difficulty-change'
    | 'restored';

export type TruckEscape2AttemptEndReason =
    | 'completed'
    | 'restarted'
    | 'exited'
    | 'interrupted';

export type TruckEscape2OperationType =
    | 'move'
    | 'invalid-move'
    | 'hint'
    | 'undo'
    | 'restart'
    | 'exit';

export type TruckEscape2InvalidMoveReason =
    | 'blocked'
    | 'below-snap-threshold'
    | 'cancelled'
    | 'model-rejected'
    | 'unknown';

export interface TruckEscape2ReferenceMove {
    vehicleId: string;
    delta: number;
}

/** A versioned, solver-verified canonical shortest solution for a level. */
export interface TruckEscape2ReferenceSolution {
    source: 'verified-optimal' | 'designer-reference';
    solverVersion: string;
    optimalMoves: number;
    moves: readonly TruckEscape2ReferenceMove[];
    /** Initial state followed by the state after each canonical move. */
    states: readonly string[];
}

/** Cheap post-action board analysis; no unbounded search is performed here. */
export interface TruckEscape2ProgressSnapshot {
    stateKey: string;
    complete: boolean;
    referenceSource: TruckEscape2ReferenceSource;
    referenceVersion: string | null;
    referenceMoves: number | null;
    exactMovesRemaining: number | null;
    estimatedMovesRemaining: number | null;
    structuralLowerBound: number;
    distanceConfidence: TruckEscape2DistanceConfidence;
    progressRatio: number;
    directBlockerCount: number;
    legalMoveCount: number;
    movableVehicleCount: number;
    canonicalPathIndex: number | null;
    canonicalStateSimilarity: number;
    deadlockStatus: TruckEscape2DeadlockStatus;
}

/** One semantic player operation, captured synchronously after model commit. */
export interface TruckEscape2OperationRecord {
    sequence: number;
    type: TruckEscape2OperationType;
    timestampMs: number;
    /** Time since the previous recorded semantic operation (or level start). */
    decisionTimeMs: number;
    /** Time spent dragging before release; null for non-drag controls. */
    interactionDurationMs: number | null;
    accepted: boolean;
    invalidReason: TruckEscape2InvalidMoveReason | null;
    vehicleId: string | null;
    attemptedDelta: number | null;
    appliedDelta: number | null;
    movedCells: number;
    inputClamped: boolean;
    before: TruckEscape2ProgressSnapshot;
    after: TruckEscape2ProgressSnapshot;
    progressDelta: number;
    repeatedOperation: boolean;
    repeatedState: boolean;
    immediateReversal: boolean;
    oscillation: boolean;
    progressRegression: boolean;
    referenceMoveMatch: boolean | null;
    suspiciousRapidRepeat: boolean;
}

/** Session-level controls that happen after an attempt has already finalized. */
export interface TruckEscape2ControlEvent {
    sequence: number;
    type: 'exit';
    timestampMs: number;
    relatedAttemptId: string;
    levelId: string;
    afterCompletion: true;
}

export interface TruckEscape2DecisionTimeStats {
    samples: number;
    meanMs: number;
    medianMs: number;
    standardDeviationMs: number;
    coefficientOfVariation: number;
    p90Ms: number;
}

export interface TruckEscape2AttemptMetrics {
    completed: boolean;
    currentProgressRatio: number;
    maxProgressRatio: number;
    acceptedMoves: number;
    totalOperationAttempts: number;
    invalidOperations: number;
    invalidOperationRate: number;
    movedCells: number;
    uniqueVehiclesMoved: number;
    uniqueStatesVisited: number;
    repeatedOperations: number;
    repeatedStates: number;
    immediateReversals: number;
    inferredUndoCount: number;
    explicitUndoCount: number;
    oscillations: number;
    progressAdvances: number;
    progressPlateaus: number;
    progressRegressions: number;
    longestNoProgressStreak: number;
    deadlockEntries: number;
    hintUses: number;
    restartCount: number;
    exitCount: number;
    suspiciousRapidRepeats: number;
    referenceMoves: number | null;
    referenceSource: TruckEscape2ReferenceSource;
    excessMoves: number | null;
    movesPerReference: number | null;
    stepEfficiency: number;
    referenceMoveMatches: number;
    referenceMoveOpportunities: number;
    referenceMoveMatchRate: number | null;
    firstOperationDelayMs: number | null;
    totalDurationMs: number;
    activeThinkingTimeMs: number;
    idleTimeMs: number;
    effectiveMsPerMove: number | null;
    decisionTime: TruckEscape2DecisionTimeStats;
}

/** All dimension scores use a stable 0..100 scale. */
export interface TruckEscape2DimensionScores {
    correctness: number;
    solutionEfficiency: number;
    timeEfficiency: number;
    planning: number;
    operationQuality: number;
    decisionStability: number;
    independence: number;
    stageProgress: number;
    performanceCore: number;
}

export interface TruckEscape2AttemptScore {
    /**
     * 0..100. Completed attempts occupy [60, 100]; incomplete attempts occupy
     * [0, 49.99], so a completion always wins within the same level.
     */
    abilityScore: number;
    difficultyWeight: number;
    challengeAdjustedScore: number;
    dimensions: TruckEscape2DimensionScores;
}

export interface TruckEscape2AttemptReport {
    attemptId: string;
    levelId: string;
    levelNumber: number;
    difficulty: TruckEscape2Difficulty;
    startReason: TruckEscape2AttemptStartReason;
    startedAtMs: number;
    /** Null only while this is the live, not-yet-finalized attempt. */
    endedAtMs: number | null;
    /** Null only while this is the live, not-yet-finalized attempt. */
    endReason: TruckEscape2AttemptEndReason | null;
    featureAvailability: {
        hint: boolean;
        undo: boolean;
    };
    initialProgress: TruckEscape2ProgressSnapshot;
    finalProgress: TruckEscape2ProgressSnapshot;
    metrics: TruckEscape2AttemptMetrics;
    score: TruckEscape2AttemptScore;
    operations: TruckEscape2OperationRecord[];
}

export interface TruckEscape2LevelHistory {
    levelId: string;
    levelNumber: number;
    difficulty: TruckEscape2Difficulty;
    attempts: number;
    completions: number;
    completionRate: number;
    firstTryCompleted: boolean;
    attemptsToFirstCompletion: number | null;
    retryEfficiencyScore: number;
    bestAttemptId: string;
    bestCompletedAttemptId: string | null;
    bestIncompleteAttemptId: string | null;
    bestAbilityScore: number;
    fewestCompletedMoves: number | null;
    fastestCompletedTimeMs: number | null;
    meanAbilityScore: number;
    abilityScoreStandardDeviation: number;
    stabilityScore: number;
}

export interface TruckEscape2DifficultyAggregate {
    difficulty: TruckEscape2Difficulty;
    difficultyWeight: number;
    catalogLevels: number;
    uniqueLevelsAttempted: number;
    uniqueLevelsCompleted: number;
    attempts: number;
    completions: number;
    completionRate: number;
    evaluatedAbilityScore: number;
    catalogAbilityContribution: number;
    meanStepEfficiency: number;
    meanTimeEfficiency: number;
    meanPlanningScore: number;
    meanOperationQuality: number;
    meanIndependenceScore: number;
}

export interface TruckEscape2AggregateReport {
    scoringVersion: string;
    generatedAtMs: number;
    catalogLevels: number;
    totalAttempts: number;
    completedAttempts: number;
    completionRate: number;
    uniqueLevelsAttempted: number;
    uniqueLevelsCompleted: number;
    coverageRatio: number;
    weightedCompletionRate: number;
    /** Catalog-normalized 0..100 score; unattempted levels contribute zero. */
    overallAbilityScore: number;
    /** 0..100 score over attempted unique levels only. */
    evaluatedAbilityScore: number;
    stabilityScore: number;
    difficultyAdaptationScore: number;
    independenceScore: number;
    firstTryCompletedLevels: number;
    retryEfficiencyScore: number;
    completedChallengeCredits: number;
    /**
     * Sort descending. High digits encode unique difficulty-weighted
     * completions; low digits encode completion/retry quality, partial
     * progress, stability, and independence. Replaying one level never adds
     * credits, while failed retries remain visible in quality/reliability.
     */
    leaderboardScore: number;
    totalInvalidOperations: number;
    totalRepeatedStates: number;
    totalInferredUndos: number;
    totalRestarts: number;
    totalExits: number;
    totalHintUses: number;
    byDifficulty: Record<TruckEscape2Difficulty, TruckEscape2DifficultyAggregate>;
}

export interface TruckEscape2AbilitySnapshot {
    schemaVersion: number;
    scoringVersion: string;
    exportedAtMs: number;
    attempts: TruckEscape2AttemptReport[];
    currentAttempt: TruckEscape2AttemptReport | null;
    controlEvents: TruckEscape2ControlEvent[];
    levelHistory: TruckEscape2LevelHistory[];
    aggregate: TruckEscape2AggregateReport;
}

/** Small inspector payload; the full event history remains available via exportData(). */
export interface TruckEscape2AbilityInspectorSnapshot {
    schemaVersion: number;
    scoringVersion: string;
    currentAttemptId: string | null;
    currentMetrics: TruckEscape2AttemptMetrics | null;
    currentScore: TruckEscape2AttemptScore | null;
    aggregate: TruckEscape2AggregateReport;
}
