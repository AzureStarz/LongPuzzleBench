import type { NutColorId, NutsBoltsLevelData } from './NutsBoltsLevelData';

export type NutsBoltsMoveError =
    | 'same-bolt'
    | 'empty-source'
    | 'target-full'
    | 'color-mismatch'
    | 'invalid-index';

export interface NutsBoltsMoveRecord {
    source: number;
    target: number;
    color: NutColorId;
    count: number;
    sourceLengthBefore: number;
    targetLengthBefore: number;
}

export interface NutsBoltsMoveResult {
    ok: true;
    move: NutsBoltsMoveRecord;
}

export interface NutsBoltsMoveFailure {
    ok: false;
    reason: NutsBoltsMoveError;
}

export type NutsBoltsMoveAttempt = NutsBoltsMoveResult | NutsBoltsMoveFailure;

/**
 * Pure rules/state model. It deliberately has no Cocos dependency so moves,
 * undo, restart and solvability can be regression-tested under Node.
 */
export class NutsBoltsModel {
    readonly capacity: number;
    private readonly _initial: NutColorId[][];
    private _stacks: NutColorId[][];
    private _history: NutsBoltsMoveRecord[] = [];

    constructor(level: NutsBoltsLevelData) {
        this.capacity = level.capacity;
        this._initial = level.bolts.map(item => item.nuts.slice());
        this._stacks = this._cloneStacks(this._initial);
    }

    get boltCount(): number { return this._stacks.length; }
    get historyLength(): number { return this._history.length; }

    getStack(index: number): readonly NutColorId[] {
        return this._stacks[index] ?? [];
    }

    getStacks(): NutColorId[][] {
        return this._cloneStacks(this._stacks);
    }

    getTopColor(index: number): NutColorId | null {
        const stack = this._stacks[index];
        return stack && stack.length > 0 ? stack[stack.length - 1] : null;
    }

    getMovableRunLength(index: number): number {
        const stack = this._stacks[index];
        if (!stack || stack.length === 0) return 0;
        const top = stack[stack.length - 1];
        let count = 1;
        for (let i = stack.length - 2; i >= 0 && stack[i] === top; i--) count++;
        return count;
    }

    checkMove(source: number, target: number): NutsBoltsMoveFailure | null {
        if (!Number.isInteger(source) || !Number.isInteger(target)
            || source < 0 || target < 0
            || source >= this._stacks.length || target >= this._stacks.length) {
            return { ok: false, reason: 'invalid-index' };
        }
        if (source === target) return { ok: false, reason: 'same-bolt' };

        const from = this._stacks[source];
        const to = this._stacks[target];
        if (from.length === 0) return { ok: false, reason: 'empty-source' };
        if (to.length >= this.capacity) return { ok: false, reason: 'target-full' };

        const movingColor = from[from.length - 1];
        if (to.length > 0 && to[to.length - 1] !== movingColor) {
            return { ok: false, reason: 'color-mismatch' };
        }
        return null;
    }

    move(source: number, target: number): NutsBoltsMoveAttempt {
        const failure = this.checkMove(source, target);
        if (failure) return failure;

        const from = this._stacks[source];
        const to = this._stacks[target];
        const color = from[from.length - 1];
        const runLength = this.getMovableRunLength(source);
        const count = Math.min(runLength, this.capacity - to.length);
        const record: NutsBoltsMoveRecord = {
            source,
            target,
            color,
            count,
            sourceLengthBefore: from.length,
            targetLengthBefore: to.length,
        };

        const moved = from.splice(from.length - count, count);
        to.push(...moved);
        this._history.push(record);
        return { ok: true, move: record };
    }

    /** Read the next undo without mutating stacks or history. */
    peekUndo(): NutsBoltsMoveRecord | null {
        const record = this._history[this._history.length - 1];
        return record ? { ...record } : null;
    }

    undo(): NutsBoltsMoveRecord | null {
        const record = this._history.pop();
        if (!record) return null;
        const from = this._stacks[record.source];
        const to = this._stacks[record.target];
        const restored = to.splice(to.length - record.count, record.count);
        from.push(...restored);
        return record;
    }

    reset(): void {
        this._stacks = this._cloneStacks(this._initial);
        this._history.length = 0;
    }

    isComplete(): boolean {
        return this._stacks.every(stack => {
            if (stack.length === 0) return true;
            if (stack.length !== this.capacity) return false;
            return stack.every(color => color === stack[0]);
        });
    }

    serialize(): string {
        return this._stacks.map(stack => stack.join(',')).join('|');
    }

    private _cloneStacks(stacks: readonly (readonly NutColorId[])[]): NutColorId[][] {
        return stacks.map(stack => stack.slice());
    }
}
