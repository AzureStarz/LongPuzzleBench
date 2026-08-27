import type { MazePaintLevelDefinition } from './MazePaintLevelData';

export type MazePaintDirection = 'up' | 'down' | 'left' | 'right';

export interface GridPosition {
    readonly row: number;
    readonly column: number;
}

export interface MazePaintLevel extends MazePaintLevelDefinition {
    readonly rows: number;
    readonly columns: number;
    readonly start: GridPosition;
    readonly paintableCells: readonly GridPosition[];
    readonly totalPaintableCells: number;
    /** Internal lookup used by the authoritative transition function. */
    readonly cellIndexByKey: Readonly<Record<string, number>>;
    readonly allPaintedMask: MazePaintMask;
}

export type MazePaintMask = readonly number[];

export interface MazePaintState {
    readonly ball: GridPosition;
    readonly paintedMask: MazePaintMask;
}

export interface MazePaintMoveResult {
    readonly direction: MazePaintDirection;
    readonly from: GridPosition;
    readonly to: GridPosition;
    /** Cells entered by the ball, excluding its starting cell. */
    readonly traversedCells: readonly GridPosition[];
    readonly newlyPaintedCells: readonly GridPosition[];
    readonly moved: boolean;
    readonly nextState: MazePaintState;
}

const DELTAS: Readonly<Record<MazePaintDirection, readonly [number, number]>> = Object.freeze({
    up: [-1, 0],
    down: [1, 0],
    left: [0, -1],
    right: [0, 1],
});

export const MAZE_PAINT_DIRECTIONS: readonly MazePaintDirection[] = Object.freeze([
    'up', 'down', 'left', 'right',
]);

export function positionKey(position: GridPosition): string {
    return `${position.row},${position.column}`;
}

function assertConnected(cells: readonly GridPosition[], index: Readonly<Record<string, number>>): void {
    const pending: GridPosition[] = cells.length > 0 ? [cells[0]] : [];
    const visited = new Set<string>();
    while (pending.length > 0) {
        const current = pending.pop()!;
        const key = positionKey(current);
        if (visited.has(key)) continue;
        visited.add(key);
        for (const direction of MAZE_PAINT_DIRECTIONS) {
            const [dr, dc] = DELTAS[direction];
            const next = { row: current.row + dr, column: current.column + dc };
            const nextKey = positionKey(next);
            if (index[nextKey] !== undefined && !visited.has(nextKey)) pending.push(next);
        }
    }
    if (visited.size !== cells.length) {
        throw new Error('Maze Paint level contains disconnected paintable cells.');
    }
}

/** Parse and validate a screenshot-level definition into the runtime form. */
export function parseMazePaintLevel(definition: MazePaintLevelDefinition): MazePaintLevel {
    const rows = definition.layout.length;
    if (rows === 0) throw new Error(`${definition.id}: layout must not be empty.`);
    const columns = definition.layout[0].length;
    if (columns === 0) throw new Error(`${definition.id}: layout rows must not be empty.`);

    const paintableCells: GridPosition[] = [];
    const cellIndexByKey: Record<string, number> = Object.create(null) as Record<string, number>;
    let start: GridPosition | null = null;
    for (let row = 0; row < rows; row++) {
        const line = definition.layout[row];
        if (line.length !== columns) throw new Error(`${definition.id}: layout must be rectangular.`);
        for (let column = 0; column < columns; column++) {
            const cell = line[column];
            if (cell !== '#' && cell !== '.' && cell !== 'S') {
                throw new Error(`${definition.id}: invalid cell ${JSON.stringify(cell)}.`);
            }
            if (cell === '#') continue;
            const position = Object.freeze({ row, column });
            cellIndexByKey[positionKey(position)] = paintableCells.length;
            paintableCells.push(position);
            if (cell === 'S') {
                if (start) throw new Error(`${definition.id}: layout contains multiple starts.`);
                start = position;
            }
        }
    }
    if (!start) throw new Error(`${definition.id}: layout must contain one start.`);
    assertConnected(paintableCells, cellIndexByKey);
    const totalPaintableCells = paintableCells.length;
    return Object.freeze({
        ...definition,
        rows,
        columns,
        start,
        paintableCells: Object.freeze(paintableCells),
        totalPaintableCells,
        cellIndexByKey: Object.freeze(cellIndexByKey),
        allPaintedMask: Object.freeze(createFullMask(totalPaintableCells)),
    });
}

export function isPaintable(level: MazePaintLevel, position: GridPosition): boolean {
    return level.cellIndexByKey[positionKey(position)] !== undefined;
}

export function cellIndex(level: MazePaintLevel, position: GridPosition): number {
    const index = level.cellIndexByKey[positionKey(position)];
    if (index === undefined) throw new Error(`Cell ${positionKey(position)} is not paintable.`);
    return index;
}

function createFullMask(bitCount: number): number[] {
    const words = new Array(Math.ceil(bitCount / 32)).fill(0xffffffff);
    const finalBits = bitCount % 32;
    if (finalBits > 0) words[words.length - 1] = (2 ** finalBits - 1) >>> 0;
    return words;
}

function emptyMask(level: MazePaintLevel): number[] {
    return new Array(level.allPaintedMask.length).fill(0);
}

function hasIndex(mask: MazePaintMask, index: number): boolean {
    return ((mask[index >>> 5] >>> (index & 31)) & 1) === 1;
}

function setIndex(mask: number[], index: number): void {
    const word = index >>> 5;
    mask[word] = (mask[word] | (1 << (index & 31))) >>> 0;
}

export function isCellPainted(level: MazePaintLevel, state: MazePaintState, position: GridPosition): boolean {
    return hasIndex(state.paintedMask, cellIndex(level, position));
}

export function createInitialMazePaintState(level: MazePaintLevel): MazePaintState {
    const paintedMask = emptyMask(level);
    setIndex(paintedMask, cellIndex(level, level.start));
    return Object.freeze({
        ball: level.start,
        paintedMask: Object.freeze(paintedMask),
    });
}

/**
 * The single authoritative slide rule used by gameplay, tests, and solver.
 * It is pure: neither the input state nor the level is modified.
 */
export function computeMazePaintMove(
    level: MazePaintLevel,
    state: MazePaintState,
    direction: MazePaintDirection,
): MazePaintMoveResult {
    const [dr, dc] = DELTAS[direction];
    if (dr === undefined || dc === undefined) throw new Error(`Unknown Maze Paint direction: ${direction}`);
    const traversedCells: GridPosition[] = [];
    const newlyPaintedCells: GridPosition[] = [];
    let row = state.ball.row;
    let column = state.ball.column;
    const nextMask = [...state.paintedMask];

    while (isPaintable(level, { row: row + dr, column: column + dc })) {
        row += dr;
        column += dc;
        const position = level.paintableCells[cellIndex(level, { row, column })];
        traversedCells.push(position);
        const index = cellIndex(level, position);
        if (!hasIndex(nextMask, index)) newlyPaintedCells.push(position);
        setIndex(nextMask, index);
    }

    const moved = traversedCells.length > 0;
    const to = moved ? traversedCells[traversedCells.length - 1] : state.ball;
    const nextState = moved
        ? Object.freeze({ ball: to, paintedMask: Object.freeze(nextMask) })
        : state;
    return Object.freeze({
        direction,
        from: state.ball,
        to,
        traversedCells: Object.freeze(traversedCells),
        newlyPaintedCells: Object.freeze(newlyPaintedCells),
        moved,
        nextState,
    });
}

export function countPaintedCells(mask: MazePaintMask): number {
    let count = 0;
    for (const word of mask) {
        let remaining = word >>> 0;
        while (remaining !== 0) {
            remaining = (remaining & (remaining - 1)) >>> 0;
            count++;
        }
    }
    return count;
}

export function isMazePaintComplete(level: MazePaintLevel, state: MazePaintState): boolean {
    return state.paintedMask.length === level.allPaintedMask.length
        && state.paintedMask.every((word, index) => word === level.allPaintedMask[index]);
}

/** Stable canonical state identity; width is fixed for a given level. */
export function hashMazePaintState(level: MazePaintLevel, state: MazePaintState): string {
    const hexWidth = Math.ceil(level.totalPaintableCells / 4);
    const fullHex = [...state.paintedMask]
        .reverse()
        .map(word => padLeft((word >>> 0).toString(16), 8, '0'))
        .join('');
    return `${state.ball.row},${state.ball.column}:${padLeft(fullHex.slice(-hexWidth), hexWidth, '0')}`;
}

function padLeft(value: string, width: number, fill: string): string {
    return value.length >= width ? value : new Array(width - value.length + 1).join(fill) + value;
}

export function cloneMazePaintState(state: MazePaintState): MazePaintState {
    return Object.freeze({
        ball: Object.freeze({ row: state.ball.row, column: state.ball.column }),
        paintedMask: Object.freeze([...state.paintedMask]),
    });
}
