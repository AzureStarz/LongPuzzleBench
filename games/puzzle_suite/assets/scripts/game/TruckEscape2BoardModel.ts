import type {
    TruckEscape2LevelData,
    TruckEscape2Orientation,
    TruckEscape2VehicleSpec,
} from '../data/TruckEscape2Data';

export interface TruckEscape2VehicleState {
    id: string;
    row: number;
    col: number;
}

export interface TruckEscape2Move {
    vehicleId: string;
    delta: number;
}

export interface TruckEscape2TravelRange {
    min: number;
    max: number;
}

/**
 * 与 Cocos 节点完全解耦的可变尺寸棋盘规则模型，便于对碰撞、边界和解法做回归验证。
 */
export class TruckEscape2BoardModel {
    public readonly level: TruckEscape2LevelData;
    public readonly states: TruckEscape2VehicleState[];

    private readonly _specById = new Map<string, TruckEscape2VehicleSpec>();
    private readonly _stateById = new Map<string, TruckEscape2VehicleState>();

    constructor(level: TruckEscape2LevelData, states?: TruckEscape2VehicleState[]) {
        this.level = level;
        for (const spec of level.vehicles) this._specById.set(spec.id, spec);
        this.states = (states ?? level.vehicles).map((state) => ({
            id: state.id,
            row: state.row,
            col: state.col,
        }));
        for (const state of this.states) this._stateById.set(state.id, state);
        this._assertValidState();
    }

    clone(): TruckEscape2BoardModel {
        return new TruckEscape2BoardModel(this.level, this.states);
    }

    getSpec(vehicleId: string): TruckEscape2VehicleSpec {
        const spec = this._specById.get(vehicleId);
        if (!spec) throw new Error(`[TruckEscape2] 未知车辆：${vehicleId}`);
        return spec;
    }

    getState(vehicleId: string): TruckEscape2VehicleState {
        const state = this._stateById.get(vehicleId);
        if (!state) throw new Error(`[TruckEscape2] 未知车辆状态：${vehicleId}`);
        return state;
    }

    getTravelRange(vehicleId: string): TruckEscape2TravelRange {
        const spec = this.getSpec(vehicleId);
        const state = this.getState(vehicleId);
        const occupied = this._buildOccupancy(vehicleId);
        let min = 0;
        let max = 0;

        if (spec.orientation === 'horizontal') {
            for (let col = state.col - 1; col >= 0 && !occupied.has(this._key(state.row, col)); col--) min--;
            for (
                let col = state.col + spec.length;
                col < this.level.cols && !occupied.has(this._key(state.row, col));
                col++
            ) max++;
        } else {
            for (let row = state.row - 1; row >= 0 && !occupied.has(this._key(row, state.col)); row--) min--;
            for (
                let row = state.row + spec.length;
                row < this.level.rows && !occupied.has(this._key(row, state.col));
                row++
            ) max++;
        }
        return { min, max };
    }

    canMove(vehicleId: string, delta: number): boolean {
        if (!Number.isInteger(delta) || delta === 0) return false;
        const range = this.getTravelRange(vehicleId);
        return delta >= range.min && delta <= range.max;
    }

    move(vehicleId: string, delta: number): boolean {
        if (!this.canMove(vehicleId, delta)) return false;
        const spec = this.getSpec(vehicleId);
        const state = this.getState(vehicleId);
        if (spec.orientation === 'horizontal') state.col += delta;
        else state.row += delta;
        return true;
    }

    setPosition(vehicleId: string, row: number, col: number) {
        const state = this.getState(vehicleId);
        const oldRow = state.row;
        const oldCol = state.col;
        state.row = row;
        state.col = col;
        try {
            this._assertValidState();
        } catch (error) {
            state.row = oldRow;
            state.col = oldCol;
            throw error;
        }
    }

    isComplete(): boolean {
        const target = this.level.vehicles.find((vehicle) => vehicle.target);
        if (!target || target.orientation !== 'horizontal' || this.level.exitSide !== 'right') return false;
        const state = this.getState(target.id);
        return state.row === this.level.exitRow && state.col + target.length === this.level.cols;
    }

    serialize(): string {
        return this.level.vehicles
            .map((spec) => {
                const state = this.getState(spec.id);
                return `${state.row},${state.col}`;
            })
            .join('|');
    }

    findHintMove(maxVisited: number = 20000): TruckEscape2Move | null {
        if (this.isComplete()) return null;

        interface QueueItem {
            model: TruckEscape2BoardModel;
            firstMove: TruckEscape2Move | null;
        }

        const queue: QueueItem[] = [{ model: this.clone(), firstMove: null }];
        const visited = new Set<string>([this.serialize()]);
        let head = 0;

        while (head < queue.length && visited.size <= maxVisited) {
            const item = queue[head++];
            for (const spec of this.level.vehicles) {
                const range = item.model.getTravelRange(spec.id);
                for (let delta = range.min; delta <= range.max; delta++) {
                    if (delta === 0) continue;
                    const next = item.model.clone();
                    if (!next.move(spec.id, delta)) continue;
                    const key = next.serialize();
                    if (visited.has(key)) continue;
                    visited.add(key);
                    const firstMove = item.firstMove ?? { vehicleId: spec.id, delta };
                    if (next.isComplete()) return firstMove;
                    queue.push({ model: next, firstMove });
                }
            }
        }
        return null;
    }

    private _buildOccupancy(ignoreVehicleId?: string): Set<string> {
        const occupied = new Set<string>();
        for (const blocker of this.level.blockers ?? []) {
            occupied.add(this._key(blocker.row, blocker.col));
        }
        for (const spec of this.level.vehicles) {
            if (spec.id === ignoreVehicleId) continue;
            const state = this.getState(spec.id);
            for (let i = 0; i < spec.length; i++) {
                const row = state.row + (spec.orientation === 'vertical' ? i : 0);
                const col = state.col + (spec.orientation === 'horizontal' ? i : 0);
                occupied.add(this._key(row, col));
            }
        }
        return occupied;
    }

    private _assertValidState() {
        if ((this.level.rows !== 5 && this.level.rows !== 6 && this.level.rows !== 7 && this.level.rows !== 8)
            || (this.level.cols !== 5 && this.level.cols !== 6 && this.level.cols !== 7)) {
            throw new Error(`[TruckEscape2] 棋盘尺寸不受支持：${this.level.cols}×${this.level.rows}`);
        }
        if (this.states.length !== this.level.vehicles.length) {
            throw new Error('[TruckEscape2] 车辆状态数量与关卡定义不一致');
        }

        const occupied = new Map<string, string>();
        for (const blocker of this.level.blockers ?? []) {
            if (blocker.row < 0 || blocker.row >= this.level.rows || blocker.col < 0 || blocker.col >= this.level.cols) {
                throw new Error(`[TruckEscape2] 障碍 ${blocker.id} 越界：(${blocker.row}, ${blocker.col})`);
            }
            const key = this._key(blocker.row, blocker.col);
            if (occupied.has(key)) throw new Error(`[TruckEscape2] 障碍 ${blocker.id} 重叠：${key}`);
            occupied.set(key, blocker.id);
        }
        for (const spec of this.level.vehicles) {
            const state = this.getState(spec.id);
            for (let i = 0; i < spec.length; i++) {
                const row = state.row + (spec.orientation === 'vertical' ? i : 0);
                const col = state.col + (spec.orientation === 'horizontal' ? i : 0);
                if (row < 0 || row >= this.level.rows || col < 0 || col >= this.level.cols) {
                    throw new Error(`[TruckEscape2] 车辆 ${spec.id} 越界：(${row}, ${col})`);
                }
                const key = this._key(row, col);
                const blocker = occupied.get(key);
                if (blocker) throw new Error(`[TruckEscape2] 车辆 ${spec.id} 与 ${blocker} 重叠：${key}`);
                occupied.set(key, spec.id);
            }
        }
    }

    private _key(row: number, col: number): string {
        return `${row},${col}`;
    }
}

export function vehicleAxis(orientation: TruckEscape2Orientation): { row: number; col: number } {
    return orientation === 'horizontal' ? { row: 0, col: 1 } : { row: 1, col: 0 };
}
