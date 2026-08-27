import { director, Director } from 'cc';
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from '../data/LevelData';

/**
 * Read-only state inspector for GUI-agent training / monitoring.
 *
 * The agent itself only sees screenshots; this channel is for the harness
 * (Playwright `page.evaluate(() => window.__game.getState())`) to compute
 * step-reward and evaluate episodes.
 *
 * Stability semantics:
 *   `outcome_stable_frames` counts consecutive frames where the
 *   outcome-affecting summary (provider.outcomeHash()) hasn't changed. This
 *   reaches a steady value in bounded time even when boards are oscillating
 *   forever under low-friction physics — exactly the property reward
 *   computation needs. `physics_quiet` is also reported for episode filtering.
 */

export interface PhysicsStats {
    quiet: boolean;
    maxLinearVelocity: number;
    movingBodies: number;
}

export interface InspectorProvider {
    /** JSON-serializable snapshot of provider-specific state. */
    snapshot(): unknown;
    /**
     * Short string summarizing outcome-affecting fields. Consecutive identical
     * hashes mark the step's effect as determined.
     */
    outcomeHash(): string;
    /** Optional physics-level info. Defaults to "quiet" when absent. */
    physicsStats?(): PhysicsStats;
}

export type ViewName =
    | 'home'
    | 'difficulty'
    | 'bolt'
    | 'truck'
    | 'truck2-difficulty'
    | 'truck2'
    | 'nuts-bolts-difficulty'
    | 'nuts-bolts'
    | 'maze-paint-difficulty'
    | 'maze-paint'
    | 'color-connect-difficulty'
    | 'color-connect';

export interface InspectorState {
    step: number;
    view: ViewName;
    outcome_stable: boolean;
    outcome_stable_frames: number;
    physics_quiet: boolean;
    max_linear_velocity: number;
    moving_bodies: number;
    viewport: { width: number; height: number };
    [providerKey: string]: unknown;
}

const STABLE_FRAME_THRESHOLD = 6;

export class GameInspector {
    private static _instance: GameInspector | null = null;
    static get instance(): GameInspector {
        if (!this._instance) this._instance = new GameInspector();
        return this._instance;
    }

    private _providers: Map<string, InspectorProvider> = new Map();
    private _view: ViewName = 'home';
    private _step: number = 0;
    private _lastHash: string = '';
    private _stableFrames: number = 0;
    private _physicsQuiet: boolean = true;
    private _maxLinearVelocity: number = 0;
    private _movingBodies: number = 0;
    private _installed: boolean = false;
    private _inputHooked: boolean = false;

    install() {
        if (!this._installed) {
            director.on(Director.EVENT_AFTER_UPDATE, this._tick, this);
            this._installed = true;
        }
        if (!this._inputHooked && typeof globalThis !== 'undefined'
            && typeof (globalThis as unknown as EventTarget).addEventListener === 'function') {
            try {
                (globalThis as unknown as EventTarget).addEventListener(
                    'pointerdown',
                    () => { this._step++; },
                    true,
                );
                this._inputHooked = true;
            } catch (_) {
                // native platform without DOM — step counter just stays at 0
            }
        }
        (globalThis as unknown as { __game: GameInspector }).__game = this;
    }

    setView(view: ViewName) {
        if (this._view === view) return;
        this._view = view;
        this._resetStable();
    }

    register(name: string, provider: InspectorProvider) {
        this._providers.set(name, provider);
        this._resetStable();
    }

    unregister(name: string) {
        if (this._providers.delete(name)) this._resetStable();
    }

    /** For synthetic actions that don't go through DOM pointerdown. */
    bumpStep() { this._step++; }

    getState(): InspectorState {
        const out: InspectorState = {
            step: this._step,
            view: this._view,
            outcome_stable: this._stableFrames >= STABLE_FRAME_THRESHOLD,
            outcome_stable_frames: this._stableFrames,
            physics_quiet: this._physicsQuiet,
            max_linear_velocity: this._maxLinearVelocity,
            moving_bodies: this._movingBodies,
            viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
        };
        for (const [name, p] of this._providers) {
            out[name] = p.snapshot();
        }
        return out;
    }

    /**
     * Resolve once `outcome_stable_frames >= minFrames`, or after timeout.
     * Always returns a snapshot — caller decides what to do on `ok=false`.
     */
    waitForStable(minFrames: number = STABLE_FRAME_THRESHOLD, timeoutMs: number = 3000): Promise<{ ok: boolean; snapshot: InspectorState }> {
        const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const deadline = now() + timeoutMs;
        return new Promise(resolve => {
            const tick = () => {
                if (this._stableFrames >= minFrames) {
                    resolve({ ok: true, snapshot: this.getState() });
                    return;
                }
                if (now() > deadline) {
                    resolve({ ok: false, snapshot: this.getState() });
                    return;
                }
                if (typeof requestAnimationFrame === 'function') {
                    requestAnimationFrame(tick);
                } else {
                    setTimeout(tick, 16);
                }
            };
            tick();
        });
    }

    private _resetStable() {
        this._lastHash = '';
        this._stableFrames = 0;
    }

    private _tick() {
        let quiet = true;
        let maxV = 0;
        let moving = 0;
        const parts: string[] = [this._view];
        for (const [name, p] of this._providers) {
            if (p.physicsStats) {
                const s = p.physicsStats();
                if (!s.quiet) quiet = false;
                if (s.maxLinearVelocity > maxV) maxV = s.maxLinearVelocity;
                moving += s.movingBodies;
            }
            parts.push(name, p.outcomeHash());
        }
        this._physicsQuiet = quiet;
        this._maxLinearVelocity = maxV;
        this._movingBodies = moving;

        const h = parts.join('|');
        if (h === this._lastHash) {
            this._stableFrames++;
        } else {
            this._stableFrames = 0;
            this._lastHash = h;
        }
    }
}
