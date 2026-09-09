/** Passive telemetry bridge for the native Game Suite autonomous mode. */

const VIEW_GAMES = {
    bolt: ['bolt_unscrew', 'bolt'],
    truck: ['truck_escape', 'truck'],
    truck2: ['truck_escape_2', 'truck2'],
    'nuts-bolts': ['nuts_bolts', 'nutsBolts'],
    'maze-paint': ['maze_paint', 'mazePaint'],
    'color-connect': ['color_connect', 'colorConnect'],
};

const MENU_GAMES = {
    difficulty: 'bolt_unscrew',
    'truck2-difficulty': 'truck_escape_2',
    'nuts-bolts-difficulty': 'nuts_bolts',
    'maze-paint-difficulty': 'maze_paint',
    'color-connect-difficulty': 'color_connect',
};

const nowMs = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
const record = value => value && typeof value === 'object' ? value : {};
const clone = value => {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
};

function params() {
    try { return new URLSearchParams(globalThis.location?.search ?? ''); }
    catch (_) { return new URLSearchParams(); }
}

export function readAutonomousLaunchConfig() {
    const query = params();
    const enabled = ['1', 'true', 'yes'].includes((query.get('autonomous') ?? '').trim().toLowerCase());
    const parsedSeed = Number(query.get('seed'));
    return { enabled, seed: Number.isFinite(parsedSeed) ? Math.max(0, Math.trunc(parsedSeed)) : 0 };
}

function inspect() {
    try { return record(globalThis.__game?.getState?.()); } catch (_) { return {}; }
}

function gameAt(state) {
    const mapping = VIEW_GAMES[state.view];
    if (!mapping) return null;
    const [gameId, providerKey] = mapping;
    const provider = record(state[providerKey]);
    const evaluator = record(provider.evaluator);
    const rawLevel = Number(provider.level ?? evaluator.level);
    const zeroBased = gameId === 'bolt_unscrew' || gameId === 'truck_escape';
    if (!Number.isFinite(rawLevel) || (zeroBased ? rawLevel < 0 : rawLevel < 1)) return null;
    return {
        game_id: gameId,
        difficulty: typeof (provider.difficulty ?? evaluator.difficulty) === 'string'
            ? String(provider.difficulty ?? evaluator.difficulty)
            : (gameId === 'truck_escape' ? 'default' : 'easy'),
        level_id: zeroBased
            ? Math.trunc(rawLevel) + 1
            : Math.trunc(rawLevel),
        provider,
        evaluator,
    };
}

function activeAt(state) {
    const game = gameAt(state);
    if (game) return { game_id: game.game_id, difficulty: game.difficulty, level_id: game.level_id };
    const gameId = MENU_GAMES[state.view];
    return gameId ? { game_id: gameId, difficulty: null, level_id: null } : null;
}

function baseMetrics(game) {
    const p = game.provider;
    if (game.game_id === 'bolt_unscrew') return {
        boards_total: Number(p.boardsTotal ?? 0),
        boards_exited: Number(p.boardsExited ?? 0),
        boards_released: Number(p.boardsReleased ?? 0),
        boards_supported_remaining: Number(p.boardsSupportedRemaining ?? 0),
    };
    if (game.game_id === 'truck_escape') return {
        trucks_total: Number(p.trucksTotal ?? 0),
        trucks_removed: Number(p.trucksRemoved ?? 0),
    };
    if (game.game_id === 'truck_escape_2') {
        const ability = record(p.ability);
        return {
            attempt_state: 'current',
            attempt_id: ability.currentAttemptId ?? null,
            metrics: clone(record(ability.currentMetrics)) ?? {},
            score: clone(record(ability.currentScore)) ?? {},
        };
    }
    return clone(Object.keys(game.evaluator).length ? game.evaluator : p) ?? {};
}

function graderState(game, seed, attemptStartedAt, state) {
    const p = game.provider;
    const e = game.evaluator;
    const success = Boolean(p.complete ?? p.success ?? e.success);
    const failure = Boolean(p.failure ?? e.failure);
    const deadlockRaw = game.game_id === 'bolt_unscrew' ? record(p.deadlock) : {};
    const deadlock = Object.keys(deadlockRaw).length ? {
        is_deadlocked: Boolean(deadlockRaw.isDeadlocked),
        deadlock_reason: deadlockRaw.reason ?? null,
        available_hole_count: Number(deadlockRaw.availableHoleCount ?? 0),
        legal_progress_action_count: Number(deadlockRaw.legalProgressActionCount ?? 0),
        pending_operation_count: Number(deadlockRaw.pendingOperationCount ?? 0),
        game_state_stable: Boolean(deadlockRaw.gameStateStable),
        awaiting_operation_settlement: Boolean(deadlockRaw.awaitingOperationSettlement),
    } : null;
    const ready = Boolean(p.ready && state.outcome_stable);
    const rawScore = Number(p.score ?? e.score);
    const trajectory = p.trajectory ?? e.trajectory;
    return {
        schema_version: 1,
        game_id: game.game_id,
        difficulty: game.difficulty,
        level_id: game.level_id,
        seed,
        ready,
        status: success ? 'success' : failure ? 'failure' : ready ? 'running' : 'loading',
        success,
        failure,
        terminal: success || failure,
        step_count: Number(state.step ?? 0),
        elapsed_time_ms: Math.max(0, Math.round(nowMs() - attemptStartedAt)),
        raw_metrics: baseMetrics(game),
        raw_game_state: clone(p) ?? {},
        deadlock,
        termination_reason: typeof (p.termination_reason ?? e.termination_reason) === 'string'
            ? String(p.termination_reason ?? e.termination_reason) : null,
        trajectory: Array.isArray(trajectory) ? clone(trajectory) ?? [] : [],
        score: Number.isFinite(rawScore) ? rawScore : null,
    };
}

let nativeRecorder = null;

/** Record a native control intent; this function never performs the control. */
export function recordAutonomousControl(kind, details = {}) {
    nativeRecorder?.(kind, details);
}

export function installAutonomousBridge(config) {
    if (!config.enabled) return null;
    if (globalThis.__LONGPUZZLEBENCH_AUTONOMOUS__) return globalThis.__LONGPUZZLEBENCH_AUTONOMOUS__;
    const events = [];
    const startedAt = nowMs();
    let sequence = 0;
    let attemptCount = 0;
    let attemptId = null;
    let attemptStartedAt = startedAt;
    let activeSignature = '';
    let lastObserved = '';
    let controls = 0;
    const instrumented = new WeakSet();
    const terminalFailureIntent = new WeakMap();

    const emit = (eventType, details = {}) => events.push(Object.freeze({
        sequence: ++sequence,
        wall_time: new Date().toISOString(),
        timestamp_ms: Math.max(0, Math.round(nowMs() - startedAt)),
        event_type: eventType,
        attempt_id: attemptId,
        details: Object.freeze({ ...details }),
    }));

    const beginAttempt = (game, source) => {
        attemptCount++;
        attemptId = `attempt-${attemptCount}`;
        attemptStartedAt = nowMs();
        activeSignature = `${game.game_id}:${game.difficulty}:${game.level_id}`;
        lastObserved = '';
        emit('game_start_requested', { source, generation: attemptCount, game_id: game.game_id,
            difficulty: game.difficulty, level_id: game.level_id });
    };

    nativeRecorder = (kind, details = {}) => {
        if (kind === 'restart' || kind === 'retry') {
            const game = gameAt(inspect());
            if (game) beginAttempt(game, 'native_control');
            emit(kind === 'retry' ? 'game_retry_requested' : 'game_restart_requested', {
                source: 'native_control', generation: attemptCount, ...details,
            });
        } else emit('game_exit_requested', { source: 'native_control', ...details });
    };

    const instrumentControls = () => {
        const cocos = globalThis.cc;
        const scene = cocos?.director?.getScene?.();
        if (!scene || !cocos?.Node?.EventType?.TOUCH_START) return;
        const visit = node => {
            const name = String(node.name ?? '');
            const restart = /Restart|restart|重玩|再玩/.test(name);
            const back = /Back|Exit|返回/.test(name);
            const terminalPrimary = name === 'CompletePrimary';
            const isButton = Boolean(cocos.Button && node.getComponent?.(cocos.Button));
            if (!instrumented.has(node) && isButton && (restart || back || terminalPrimary)) {
                instrumented.add(node);
                controls++;
                if (terminalPrimary) node.on(cocos.Node.EventType.TOUCH_START, () => {
                    const game = gameAt(inspect());
                    const failed = game && Boolean(game.provider.failure ?? game.evaluator.failure);
                    terminalFailureIntent.set(node, Boolean(failed));
                });
                node.on(cocos.Button.EventType.CLICK, () => {
                    if (terminalPrimary) {
                        if (terminalFailureIntent.get(node)) {
                            nativeRecorder?.('retry', { control_name: name });
                        }
                        terminalFailureIntent.delete(node);
                        return;
                    }
                    nativeRecorder?.(restart ? 'restart' : 'back', { control_name: name });
                });
            }
            for (const child of node.children ?? []) visit(child);
        };
        visit(scene);
    };

    try {
        globalThis.addEventListener('pointerdown', event => emit('ui_interaction', {
            action: 'pointerdown', x: Number(event.clientX ?? 0), y: Number(event.clientY ?? 0),
        }), true);
    } catch (_) { /* no DOM on native targets */ }

    const getSnapshot = () => {
        instrumentControls();
        const state = inspect();
        const game = gameAt(state);
        const activeGame = activeAt(state);
        if (!game) {
            if (activeSignature) emit('game_exit_observed', { page: state.view ?? 'home' });
            activeSignature = '';
            attemptId = null;
            lastObserved = '';
            return { schema_version: 1, seed: config.seed, page: state.view ?? 'home', lifecycle: 'menu',
                active_game: activeGame, grader_state: null, attempt_id: null, attempt_count: attemptCount,
                last_event_sequence: sequence, instrumented_control_count: controls };
        }
        const signature = `${game.game_id}:${game.difficulty}:${game.level_id}`;
        if (signature !== activeSignature) beginAttempt(game, activeSignature ? 'native_next_level' : 'native_navigation');
        const grader = graderState(game, config.seed, attemptStartedAt, state);
        const lifecycle = grader.success ? 'completed'
            : grader.failure || grader.deadlock?.is_deadlocked ? 'failure'
                : grader.ready ? 'playing' : 'loading';
        const observed = `${grader.status}:${lifecycle}`;
        if (activeSignature === signature && lastObserved.endsWith(':completed') && lifecycle !== 'completed') {
            beginAttempt(game, 'native_replay');
        }
        if (observed !== lastObserved) {
            emit(grader.ready && !lastObserved ? 'game_ready' : 'game_state_observed', {
                status: grader.status, lifecycle, game_id: grader.game_id,
                difficulty: grader.difficulty, level_id: grader.level_id,
            });
            if (lifecycle === 'failure') emit('game_failure_observed', { reason: grader.termination_reason });
            if (lifecycle === 'completed') emit('game_completion_observed');
            lastObserved = observed;
        }
        return { schema_version: 1, seed: config.seed, page: state.view, lifecycle,
            active_game: activeAt(state), grader_state: grader, attempt_id: attemptId,
            attempt_count: attemptCount, last_event_sequence: sequence, instrumented_control_count: controls };
    };

    const bridge = Object.freeze({
        isReady: () => {
            instrumentControls();
            const state = inspect();
            if (!state.view) return false;
            if (state.view !== 'home') return true;
            const scene = globalThis.cc?.director?.getScene?.();
            const containsHome = node => node?.name === 'HomeView'
                || (node?.children ?? []).some(containsHome);
            return Boolean(scene && containsHome(scene));
        },
        getSnapshot,
        getEvents: (afterSequence = 0) => events
            .filter(event => event.sequence > Math.max(0, Math.trunc(Number(afterSequence) || 0)))
            .map(event => ({ ...event, details: { ...event.details } })),
    });
    Object.defineProperty(globalThis, '__LONGPUZZLEBENCH_AUTONOMOUS__', {
        value: bridge, enumerable: false, configurable: false, writable: false,
    });
    emit('suite_ready', { seed: config.seed });
    setInterval(instrumentControls, 250);
    return bridge;
}

// The shipped web build loads this same source as an ES module. Cocos imports
// the exports above and installs it from GameMain, while a prebuilt runtime can
// install itself once GameInspector becomes available.
const launch = readAutonomousLaunchConfig();
if (launch.enabled) installAutonomousBridge(launch);
