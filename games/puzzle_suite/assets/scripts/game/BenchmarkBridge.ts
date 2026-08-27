import { TruckEscape2AbilityTracker } from '../analytics/TruckEscape2AbilityTracker';

export type BenchmarkGameId =
    | 'bolt_unscrew'
    | 'truck_escape'
    | 'truck_escape_2'
    | 'nuts_bolts'
    | 'maze_paint'
    | 'color_connect';

export interface BenchmarkLaunchConfig {
    enabled: boolean;
    gameId: BenchmarkGameId;
    difficulty: string;
    levelId: number;
    seed: number;
}

export interface BenchmarkSuiteManifestEntry {
    suite_id: string;
    game_id: BenchmarkGameId;
    difficulty: string;
    level_ids: readonly number[];
    instruction: string;
}

const MAZE_PAINT_INSTRUCTION = [
    'Paint every traversable cell.',
    'Swipe up, down, left, or right to move the ball.',
    'Each swipe slides the ball until it reaches a wall or the board edge, painting every cell it crosses.',
    'The ball cannot stop partway through a slide.',
].join(' ');

const MAZE_PAINT_LEVEL_IDS = Object.freeze(Array.from({ length: 10 }, (_, index) => index + 1));

/** Formal game×difficulty suites; level entries remain internal to each suite. */
export const MAZE_PAINT_BENCHMARK_SUITES: readonly BenchmarkSuiteManifestEntry[] = Object.freeze([
    Object.freeze({
        suite_id: 'maze_paint.easy',
        game_id: 'maze_paint' as const,
        difficulty: 'easy',
        level_ids: MAZE_PAINT_LEVEL_IDS,
        instruction: MAZE_PAINT_INSTRUCTION,
    }),
    Object.freeze({
        suite_id: 'maze_paint.medium',
        game_id: 'maze_paint' as const,
        difficulty: 'medium',
        level_ids: MAZE_PAINT_LEVEL_IDS,
        instruction: MAZE_PAINT_INSTRUCTION,
    }),
    Object.freeze({
        suite_id: 'maze_paint.hard',
        game_id: 'maze_paint' as const,
        difficulty: 'hard',
        level_ids: MAZE_PAINT_LEVEL_IDS,
        instruction: MAZE_PAINT_INSTRUCTION,
    }),
]);

const COLOR_CONNECT_INSTRUCTION = [
    'Connect every pair of matching colored endpoints using straight path segments.',
    'Click an endpoint to start, then click each corner and finally the matching endpoint.',
    'The selected start endpoint remains marked with a bright white glow and double ring.',
    'Each pair of consecutive clicks must be in the same row or column; every crossed cell is validated.',
    'Paths move through orthogonally adjacent grid cells only.',
    'Different colors cannot overlap or cross, and paths cannot pass through another color endpoint.',
    'Click an earlier cell on the current straight segment to backtrack.',
    'Click either endpoint of a completed color to remove that path and draw it again.',
    'The level is complete when every color pair is connected.',
].join(' ');

const COLOR_CONNECT_LEVEL_IDS = Object.freeze(Array.from({ length: 10 }, (_, index) => index + 1));

export const COLOR_CONNECT_BENCHMARK_SUITES: readonly BenchmarkSuiteManifestEntry[] = Object.freeze([
    Object.freeze({
        suite_id: 'color_connect.easy',
        game_id: 'color_connect' as const,
        difficulty: 'easy',
        level_ids: COLOR_CONNECT_LEVEL_IDS,
        instruction: COLOR_CONNECT_INSTRUCTION,
    }),
    Object.freeze({
        suite_id: 'color_connect.hard',
        game_id: 'color_connect' as const,
        difficulty: 'hard',
        level_ids: COLOR_CONNECT_LEVEL_IDS,
        instruction: COLOR_CONNECT_INSTRUCTION,
    }),
]);

export interface BenchmarkState {
    schema_version: 1;
    game_id: BenchmarkGameId;
    difficulty: string;
    level_id: number;
    seed: number;
    ready: boolean;
    status: 'loading' | 'running' | 'success' | 'failure';
    success: boolean;
    failure: boolean;
    terminal: boolean;
    step_count: number;
    elapsed_time_ms: number;
    raw_metrics: Record<string, unknown>;
    raw_game_state: Record<string, unknown>;
    deadlock: Record<string, unknown> | null;
    termination_reason: string | null;
    trajectory: unknown[];
    score: number | null;
}

export interface BenchmarkBridge {
    getState(): BenchmarkState;
    getManifest(): readonly BenchmarkSuiteManifestEntry[];
    waitForReady(timeoutMs?: number): Promise<{ ok: boolean; state: BenchmarkState }>;
    waitForPostActionState(timeoutMs?: number): Promise<{
        ok: boolean;
        state: BenchmarkState;
        required: boolean;
    }>;
}

interface GameInspectorLike {
    getState(): Record<string, unknown>;
}

const GAME_ALIASES: Record<string, BenchmarkGameId> = {
    bolt: 'bolt_unscrew',
    bolt_unscrew: 'bolt_unscrew',
    'bolt-unscrew': 'bolt_unscrew',
    truck: 'truck_escape',
    truck_escape: 'truck_escape',
    'truck-escape': 'truck_escape',
    truck2: 'truck_escape_2',
    truck_escape_2: 'truck_escape_2',
    'truck-escape-2': 'truck_escape_2',
    nuts_bolts: 'nuts_bolts',
    'nuts-bolts': 'nuts_bolts',
    maze: 'maze_paint',
    maze_paint: 'maze_paint',
    'maze-paint': 'maze_paint',
    color: 'color_connect',
    color_connect: 'color_connect',
    'color-connect': 'color_connect',
};

const PROVIDER_KEYS: Record<BenchmarkGameId, string> = {
    bolt_unscrew: 'bolt',
    truck_escape: 'truck',
    truck_escape_2: 'truck2',
    nuts_bolts: 'nutsBolts',
    maze_paint: 'mazePaint',
    color_connect: 'colorConnect',
};

const VIEW_NAMES: Record<BenchmarkGameId, string> = {
    bolt_unscrew: 'bolt',
    truck_escape: 'truck',
    truck_escape_2: 'truck2',
    nuts_bolts: 'nuts-bolts',
    maze_paint: 'maze-paint',
    color_connect: 'color-connect',
};

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function finiteInt(value: string | null, fallback: number, minimum: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(minimum, Math.trunc(parsed)) : fallback;
}

function defaultDifficulty(gameId: BenchmarkGameId): string {
    return gameId === 'truck_escape' ? 'default' : 'easy';
}

function normalizeDifficulty(gameId: BenchmarkGameId, value: string | null): string {
    const difficulty = (value ?? defaultDifficulty(gameId)).trim().toLowerCase();
    if (gameId === 'truck_escape') return 'default';
    if (gameId === 'bolt_unscrew') return difficulty === 'hard' ? 'hard' : 'easy';
    if (gameId === 'truck_escape_2') {
        return difficulty === 'medium' || difficulty === 'hard' ? difficulty : 'easy';
    }
    if (gameId === 'maze_paint') {
        return difficulty === 'medium' || difficulty === 'hard' ? difficulty : 'easy';
    }
    if (gameId === 'color_connect') return difficulty === 'hard' ? 'hard' : 'easy';
    return difficulty === 'medium' || difficulty === 'hard'
        || difficulty === 'extreme' || difficulty === 'nightmare'
        ? difficulty
        : 'easy';
}

function normalizeGameId(value: string | null): BenchmarkGameId {
    return GAME_ALIASES[(value ?? '').trim().toLowerCase()] ?? 'bolt_unscrew';
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
    try {
        return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    } catch (_) {
        return {};
    }
}

function cloneArray(value: unknown[]): unknown[] {
    try {
        return JSON.parse(JSON.stringify(value)) as unknown[];
    } catch (_) {
        return [];
    }
}

function nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Parse the stable query contract used by the external benchmark runner. */
export function readBenchmarkLaunchConfig(): BenchmarkLaunchConfig {
    let params: URLSearchParams | null = null;
    try {
        const locationLike = (globalThis as unknown as { location?: { search?: string } }).location;
        if (locationLike?.search !== undefined && typeof URLSearchParams !== 'undefined') {
            params = new URLSearchParams(locationLike.search);
        }
    } catch (_) {
        // Native/preview runtimes without a browser URL stay on the normal Hub.
    }
    const gameId = normalizeGameId(params?.get('game_id') ?? null);
    const benchmarkFlag = (params?.get('benchmark') ?? '').trim().toLowerCase();
    return {
        enabled: benchmarkFlag === '1' || benchmarkFlag === 'true' || benchmarkFlag === 'yes',
        gameId,
        difficulty: normalizeDifficulty(gameId, params?.get('difficulty') ?? null),
        levelId: finiteInt(params?.get('level_id') ?? null, 1, 1),
        seed: finiteInt(params?.get('seed') ?? null, 0, 0),
    };
}

function levelFromProvider(gameId: BenchmarkGameId, provider: Record<string, unknown>): number {
    const evaluator = asRecord(provider.evaluator);
    const value = Number(provider.level ?? evaluator.level);
    if (!Number.isFinite(value)) return 0;
    // Legacy Bolt and Truck inspectors predate the benchmark and expose a zero-based index.
    return gameId === 'bolt_unscrew' || gameId === 'truck_escape'
        ? Math.trunc(value) + 1
        : Math.trunc(value);
}

const MAZE_PAINT_METRIC_KEYS = [
    'game_id',
    'difficulty',
    'level_id',
    'status',
    'success',
    'failure',
    'termination_reason',
    'ball_position',
    'total_paintable_cells',
    'painted_cell_count',
    'remaining_unpainted_cells',
    'coverage_ratio',
    'move_count',
    'valid_move_count',
    'invalid_move_count',
    'elapsed_time_ms',
    'optimal_move_count',
    'score',
    'board',
    'ball',
    'actions',
    'efficiency',
    'traversal',
    'state_analysis',
    'progress',
    'timing',
    'trajectory',
] as const;

/** Copy only the evaluator contract, excluding controller-only rendering state. */
function mazePaintMetrics(provider: Record<string, unknown>): Record<string, unknown> {
    const nested = asRecord(provider.evaluator);
    const source = Object.keys(nested).length > 0 ? nested : provider;
    const metrics: Record<string, unknown> = {};
    for (const key of MAZE_PAINT_METRIC_KEYS) {
        if (source[key] !== undefined) metrics[key] = source[key];
    }
    return metrics;
}

const COLOR_CONNECT_METRIC_KEYS = [
    'game_id',
    'difficulty',
    'level',
    'level_id',
    'status',
    'success',
    'failure',
    'termination_reason',
    'total_color_pairs',
    'completed_color_pairs',
    'remaining_color_pairs',
    'pair_completion_ratio',
    'completed_pair_ratio',
    'total_playable_cells',
    'occupied_path_cells',
    'coverage_ratio',
    'require_full_coverage',
    'elapsed_time_ms',
    'gesture_count',
    'valid_gesture_count',
    'invalid_gesture_count',
    'completed_connection_count',
    'incomplete_drag_count',
    'path_cancel_count',
    'path_backtrack_count',
    'restart_count',
    'state_hash',
    'score',
    'board',
    'actions',
    'violations',
    'paths',
    'per_colors',
    'progress',
    'efficiency',
    'state_analysis',
    'timing',
    'trajectory',
] as const;

/** Explicit evaluator allowlist: solver/reference data never crosses the bridge. */
function colorConnectMetrics(provider: Record<string, unknown>): Record<string, unknown> {
    const nested = asRecord(provider.evaluator);
    const source = Object.keys(nested).length > 0 ? nested : provider;
    const metrics: Record<string, unknown> = {};
    for (const key of COLOR_CONNECT_METRIC_KEYS) {
        if (source[key] !== undefined) metrics[key] = source[key];
    }
    return metrics;
}

function baseMetrics(gameId: BenchmarkGameId, provider: Record<string, unknown>): Record<string, unknown> {
    if (gameId === 'bolt_unscrew') {
        return {
            boards_total: Number(provider.boardsTotal ?? 0),
            boards_exited: Number(provider.boardsExited ?? 0),
            boards_released: Number(provider.boardsReleased ?? 0),
            boards_supported_remaining: Number(provider.boardsSupportedRemaining ?? 0),
        };
    }
    if (gameId === 'truck_escape') {
        return {
            trucks_total: Number(provider.trucksTotal ?? 0),
            trucks_removed: Number(provider.trucksRemoved ?? 0),
        };
    }
    if (gameId === 'nuts_bolts') {
        const bolts = Array.isArray(provider.bolts) ? provider.bolts as Record<string, unknown>[] : [];
        const capacity = Number(provider.capacity ?? 0);
        const colors = new Set<string>();
        const bestByColor = new Map<string, number>();
        let completedFull = 0;
        for (const bolt of bolts) {
            const nuts = Array.isArray(bolt.nuts) ? bolt.nuts.map(String) : [];
            if (nuts.length === 0) continue;
            nuts.forEach(color => colors.add(color));
            const homogeneous = nuts.every(color => color === nuts[0]);
            if (!homogeneous) continue;
            const color = nuts[0];
            bestByColor.set(color, Math.max(bestByColor.get(color) ?? 0, nuts.length));
            const remaining = Number(bolt.remaining);
            const isFull = Number.isFinite(remaining)
                ? remaining === 0
                : (capacity > 0 && nuts.length === capacity);
            if (isFull) completedFull += 1;
        }
        const colorGroups = colors.size;
        let homogeneousNuts = 0;
        bestByColor.forEach(count => { homogeneousNuts += count; });
        const placementDenominator = capacity > 0 ? capacity * colorGroups : 0;
        return {
            move_count: Number(provider.historyLength ?? 0),
            undo_available: Boolean(provider.undoAvailable),
            capacity,
            distinct_color_groups: colorGroups,
            completed_homogeneous_full_bolts: completedFull,
            homogeneous_nuts: homogeneousNuts,
            placement_denominator: placementDenominator,
            progress: placementDenominator > 0
                ? Math.min(1, homogeneousNuts / placementDenominator)
                : (colorGroups > 0 ? Math.min(1, completedFull / colorGroups) : 0),
        };
    }
    return {};
}

function deadlockFromProvider(
    gameId: BenchmarkGameId,
    provider: Record<string, unknown>,
): Record<string, unknown> | null {
    if (gameId !== 'bolt_unscrew') return null;
    const state = asRecord(provider.deadlock);
    if (Object.keys(state).length === 0) return null;
    return {
        is_deadlocked: Boolean(state.isDeadlocked),
        deadlock_reason: state.reason ?? null,
        available_hole_count: Number(state.availableHoleCount ?? 0),
        legal_progress_action_count: Number(state.legalProgressActionCount ?? 0),
        pending_operation_count: Number(state.pendingOperationCount ?? 0),
        game_state_stable: Boolean(state.gameStateStable),
        awaiting_operation_settlement: Boolean(state.awaitingOperationSettlement),
    };
}

function truckEscape2Metrics(config: BenchmarkLaunchConfig): Record<string, unknown> {
    const tracker = TruckEscape2AbilityTracker.instance;
    const current = tracker.getCurrentAttempt();
    const final = [...tracker.getAttemptHistory()].reverse().find(attempt => (
        attempt.difficulty === config.difficulty && attempt.levelNumber === config.levelId
    )) ?? null;
    const attempt = current?.difficulty === config.difficulty && current.levelNumber === config.levelId
        ? current
        : final;
    if (!attempt) return {};
    return {
        attempt_state: attempt.endReason === null ? 'current' : 'final',
        attempt_id: attempt.attemptId,
        end_reason: attempt.endReason,
        metrics: attempt.metrics,
        score: attempt.score,
        final_progress: attempt.finalProgress,
    };
}

function providerOperationPending(
    provider: Record<string, unknown>,
    deadlock: Record<string, unknown> | null,
): boolean {
    const evaluator = asRecord(provider.evaluator);
    const ball = asRecord(provider.ball ?? evaluator.ball);
    return Boolean(
        provider.busy
        || provider.is_moving
        || provider.isMoving
        || evaluator.busy
        || evaluator.is_moving
        || ball.is_moving
        || provider.awaitingOperationSettlement
        || provider.awaiting_operation_settlement
        || deadlock?.awaiting_operation_settlement
    );
}

/**
 * Install a read-only evaluator channel. GUI-agent observations contain only
 * pixels; Playwright reads this object separately with page.evaluate().
 */
export function installBenchmarkBridge(config: BenchmarkLaunchConfig): BenchmarkBridge {
    const startedAt = nowMs();

    const getState = (): BenchmarkState => {
        const inspector = (globalThis as unknown as { __game?: GameInspectorLike }).__game;
        const snapshot = inspector ? asRecord(inspector.getState()) : {};
        const provider = asRecord(snapshot[PROVIDER_KEYS[config.gameId]]);
        const levelId = levelFromProvider(config.gameId, provider);
        const evaluator = asRecord(provider.evaluator);
        const success = Boolean(provider.complete ?? provider.success ?? evaluator.success);
        const failure = Boolean(provider.failure ?? evaluator.failure);
        const providerDifficulty = typeof (provider.difficulty ?? evaluator.difficulty) === 'string'
            ? String(provider.difficulty ?? evaluator.difficulty)
            : config.difficulty;
        const correctDifficulty = config.gameId === 'truck_escape' || providerDifficulty === config.difficulty;
        const ready = Boolean(provider.ready)
            && snapshot.view === VIEW_NAMES[config.gameId]
            && levelId === config.levelId
            && correctDifficulty
            && Boolean(snapshot.outcome_stable);
        const rawMetrics = config.gameId === 'truck_escape_2'
            ? truckEscape2Metrics(config)
            : (config.gameId === 'maze_paint'
                ? mazePaintMetrics(provider)
                : (config.gameId === 'color_connect'
                    ? colorConnectMetrics(provider)
                    : baseMetrics(config.gameId, provider)));
        const deadlock = deadlockFromProvider(config.gameId, provider);
        const terminationReason = typeof (provider.termination_reason ?? evaluator.termination_reason) === 'string'
            ? String(provider.termination_reason ?? evaluator.termination_reason)
            : null;
        const trajectoryValue = provider.trajectory ?? evaluator.trajectory;
        const trajectory = Array.isArray(trajectoryValue) ? trajectoryValue : [];
        const scoreValue = Number(provider.score ?? evaluator.score);
        return {
            schema_version: 1,
            game_id: config.gameId,
            difficulty: providerDifficulty,
            level_id: levelId || config.levelId,
            seed: config.seed,
            ready,
            status: success ? 'success' : (failure ? 'failure' : (ready ? 'running' : 'loading')),
            success,
            failure,
            terminal: success || failure,
            step_count: Number(snapshot.step ?? 0),
            elapsed_time_ms: Math.max(0, Math.round(nowMs() - startedAt)),
            raw_metrics: cloneRecord(rawMetrics),
            raw_game_state: cloneRecord(provider),
            deadlock: deadlock ? cloneRecord(deadlock) : null,
            termination_reason: terminationReason,
            trajectory: cloneArray(trajectory),
            score: Number.isFinite(scoreValue) ? scoreValue : null,
        };
    };

    const waitForReady = (timeoutMs: number = 15_000): Promise<{ ok: boolean; state: BenchmarkState }> => {
        const deadline = nowMs() + Math.max(0, timeoutMs);
        return new Promise(resolve => {
            const poll = () => {
                const state = getState();
                if (state.ready) {
                    resolve({ ok: true, state });
                    return;
                }
                if (nowMs() >= deadline) {
                    resolve({ ok: false, state });
                    return;
                }
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(poll);
                else setTimeout(poll, 16);
            };
            poll();
        });
    };

    /** Wait until the active provider is idle and its outcome hash is stable. */
    const waitForPostActionState = (
        timeoutMs: number = 3_000,
    ): Promise<{ ok: boolean; state: BenchmarkState; required: boolean }> => {
        const deadline = nowMs() + Math.max(0, timeoutMs);
        let required = false;
        let initialPoll = true;
        return new Promise(resolve => {
            const poll = () => {
                const state = getState();
                const pending = providerOperationPending(state.raw_game_state, state.deadlock);
                required = required || pending || !state.ready;
                // Always cross at least one render frame so a just-dispatched
                // pointer/touch event has a chance to enter the provider.
                if (!initialPoll && !pending && state.ready) {
                    resolve({ ok: true, state, required });
                    return;
                }
                initialPoll = false;
                if (nowMs() >= deadline) {
                    resolve({ ok: false, state, required });
                    return;
                }
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(poll);
                else setTimeout(poll, 16);
            };
            poll();
        });
    };

    const getManifest = (): readonly BenchmarkSuiteManifestEntry[] => Object.freeze([
        ...MAZE_PAINT_BENCHMARK_SUITES,
        ...COLOR_CONNECT_BENCHMARK_SUITES,
    ]);
    const bridge = Object.freeze({ getState, getManifest, waitForReady, waitForPostActionState });
    const target = globalThis as unknown as Record<string, unknown>;
    try {
        Object.defineProperty(target, '__MINIGAME_BENCHMARK__', {
            value: bridge,
            enumerable: false,
            configurable: false,
            writable: false,
        });
    } catch (_) {
        target.__MINIGAME_BENCHMARK__ = bridge;
    }
    return bridge;
}
