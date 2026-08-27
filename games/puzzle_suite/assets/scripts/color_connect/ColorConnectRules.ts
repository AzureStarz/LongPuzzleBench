import type {
    ColorConnectColorPairConfig,
    ColorConnectGridPosition,
    ColorConnectLevelDefinition,
} from './ColorConnectLevelData';

export type GridPosition = ColorConnectGridPosition;

export interface ColorConnectLevel extends ColorConnectLevelDefinition {
    readonly totalPlayableCells: number;
    readonly pairByColorId: Readonly<Record<string, ColorConnectColorPairConfig>>;
    readonly endpointColorByKey: Readonly<Record<string, string>>;
    readonly blockedCellKeys: Readonly<Record<string, true>>;
}

export interface ColorPathState {
    readonly colorId: string;
    /** Includes both endpoints when completed; empty when disconnected. */
    readonly cells: readonly GridPosition[];
    readonly completed: boolean;
}

export interface ColorConnectState {
    readonly paths: Readonly<Record<string, ColorPathState>>;
    readonly activeColorId: string | null;
    /** Includes the start endpoint and the current tip. */
    readonly activePath: readonly GridPosition[];
    /** Completed-path footprint, including endpoints. */
    readonly occupiedCells: Readonly<Record<string, string>>;
    readonly completedColorCount: number;
    readonly success: boolean;
}

export type ColorConnectViolation =
    | 'start_from_non_endpoint'
    | 'entered_blocked_cell'
    | 'entered_other_color_endpoint'
    | 'path_overlap_attempt'
    | 'path_self_intersection_attempt'
    | 'non_adjacent_jump_attempt'
    | 'released_before_connection'
    | 'drag_outside_board'
    | 'input_without_active_path'
    | 'game_already_complete';

export interface ColorConnectTransitionResult {
    readonly nextState: ColorConnectState;
    readonly changed: boolean;
    readonly valid: boolean;
    readonly violation: ColorConnectViolation | null;
    readonly completedColorId: string | null;
    readonly cancelledColorId: string | null;
    readonly backtrackedCellCount: number;
    readonly enteredCells: readonly GridPosition[];
}

export interface ColorConnectPathValidation {
    readonly valid: boolean;
    readonly violation: ColorConnectViolation | null;
}

export interface ColorConnectSolutionValidation {
    readonly valid: boolean;
    readonly completedColorCount: number;
    readonly occupiedCellCount: number;
    readonly error: string | null;
}

export function colorConnectPositionKey(position: GridPosition): string {
    return `${position.row},${position.column}`;
}

export function sameColorConnectPosition(a: GridPosition, b: GridPosition): boolean {
    return a.row === b.row && a.column === b.column;
}

export function isColorConnectPositionInside(level: ColorConnectLevel, position: GridPosition): boolean {
    return Number.isInteger(position.row)
        && Number.isInteger(position.column)
        && position.row >= 0
        && position.row < level.rows
        && position.column >= 0
        && position.column < level.columns;
}

export function isColorConnectCellBlocked(level: ColorConnectLevel, position: GridPosition): boolean {
    return level.blockedCellKeys[colorConnectPositionKey(position)] === true;
}

export function areColorConnectCellsAdjacent(a: GridPosition, b: GridPosition): boolean {
    return Math.abs(a.row - b.row) + Math.abs(a.column - b.column) === 1;
}

function freezePosition(position: GridPosition): GridPosition {
    return Object.freeze({ row: position.row, column: position.column });
}

function assertPosition(level: ColorConnectLevelDefinition, position: GridPosition, label: string): void {
    if (!Number.isInteger(position.row) || !Number.isInteger(position.column)) {
        throw new Error(`${level.id}: ${label} must use integer coordinates.`);
    }
    if (position.row < 0 || position.row >= level.rows || position.column < 0 || position.column >= level.columns) {
        throw new Error(`${level.id}: ${label} is outside the ${level.rows}x${level.columns} board.`);
    }
}

/** Validate a declarative definition and add immutable lookup tables. */
export function parseColorConnectLevel(definition: ColorConnectLevelDefinition): ColorConnectLevel {
    if (!Number.isInteger(definition.rows) || definition.rows <= 0
        || !Number.isInteger(definition.columns) || definition.columns <= 0) {
        throw new Error(`${definition.id}: rows and columns must be positive integers.`);
    }
    if (definition.colorPairs.length === 0) throw new Error(`${definition.id}: at least one color pair is required.`);

    const blockedCellKeys: Record<string, true> = Object.create(null) as Record<string, true>;
    for (const cell of definition.blockedCells) {
        assertPosition(definition, cell, 'blocked cell');
        const key = colorConnectPositionKey(cell);
        if (blockedCellKeys[key]) throw new Error(`${definition.id}: duplicate blocked cell ${key}.`);
        blockedCellKeys[key] = true;
    }

    const pairByColorId: Record<string, ColorConnectColorPairConfig> = Object.create(null) as Record<string, ColorConnectColorPairConfig>;
    const endpointColorByKey: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const pair of definition.colorPairs) {
        if (!pair.colorId || pairByColorId[pair.colorId]) {
            throw new Error(`${definition.id}: color ids must be unique and non-empty (${pair.colorId}).`);
        }
        assertPosition(definition, pair.start, `${pair.colorId} start`);
        assertPosition(definition, pair.end, `${pair.colorId} end`);
        const startKey = colorConnectPositionKey(pair.start);
        const endKey = colorConnectPositionKey(pair.end);
        if (startKey === endKey) throw new Error(`${definition.id}: ${pair.colorId} endpoints must be distinct.`);
        if (blockedCellKeys[startKey] || blockedCellKeys[endKey]) {
            throw new Error(`${definition.id}: ${pair.colorId} endpoint is blocked.`);
        }
        if (endpointColorByKey[startKey] || endpointColorByKey[endKey]) {
            throw new Error(`${definition.id}: endpoint coordinates must be unique.`);
        }
        if (!/^#[0-9a-f]{6}$/i.test(pair.displayColor)) {
            throw new Error(`${definition.id}: ${pair.colorId} has an invalid display color.`);
        }
        pairByColorId[pair.colorId] = pair;
        endpointColorByKey[startKey] = pair.colorId;
        endpointColorByKey[endKey] = pair.colorId;
    }

    return Object.freeze({
        ...definition,
        totalPlayableCells: definition.rows * definition.columns - definition.blockedCells.length,
        pairByColorId: Object.freeze(pairByColorId),
        endpointColorByKey: Object.freeze(endpointColorByKey),
        blockedCellKeys: Object.freeze(blockedCellKeys),
    });
}

function emptyPath(colorId: string): ColorPathState {
    return Object.freeze({ colorId, cells: Object.freeze([]), completed: false });
}

export function createInitialColorConnectState(level: ColorConnectLevel): ColorConnectState {
    const paths: Record<string, ColorPathState> = Object.create(null) as Record<string, ColorPathState>;
    for (const pair of level.colorPairs) paths[pair.colorId] = emptyPath(pair.colorId);
    return Object.freeze({
        paths: Object.freeze(paths),
        activeColorId: null,
        activePath: Object.freeze([]),
        occupiedCells: Object.freeze(Object.create(null) as Record<string, string>),
        completedColorCount: 0,
        success: false,
    });
}

function result(
    nextState: ColorConnectState,
    changed: boolean,
    valid: boolean,
    violation: ColorConnectViolation | null = null,
    extras: Partial<Pick<ColorConnectTransitionResult,
        'completedColorId' | 'cancelledColorId' | 'backtrackedCellCount' | 'enteredCells'>> = {},
): ColorConnectTransitionResult {
    return Object.freeze({
        nextState,
        changed,
        valid,
        violation,
        completedColorId: extras.completedColorId ?? null,
        cancelledColorId: extras.cancelledColorId ?? null,
        backtrackedCellCount: extras.backtrackedCellCount ?? 0,
        enteredCells: Object.freeze([...(extras.enteredCells ?? [])]),
    });
}

function stateWithActive(
    state: ColorConnectState,
    activeColorId: string | null,
    activePath: readonly GridPosition[],
): ColorConnectState {
    return Object.freeze({
        ...state,
        activeColorId,
        activePath: Object.freeze(activePath.map(freezePosition)),
    });
}

function occupiedFromPaths(paths: Readonly<Record<string, ColorPathState>>): Readonly<Record<string, string>> {
    const occupied: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const colorId of Object.keys(paths)) {
        const path = paths[colorId];
        if (!path.completed) continue;
        for (const cell of path.cells) occupied[colorConnectPositionKey(cell)] = colorId;
    }
    return Object.freeze(occupied);
}

function completedState(
    level: ColorConnectLevel,
    state: ColorConnectState,
    colorId: string,
    cells: readonly GridPosition[],
): ColorConnectState {
    const paths: Record<string, ColorPathState> = { ...state.paths };
    paths[colorId] = Object.freeze({
        colorId,
        cells: Object.freeze(cells.map(freezePosition)),
        completed: true,
    });
    const frozenPaths = Object.freeze(paths);
    const completedColorCount = Object.keys(paths).filter(id => paths[id].completed).length;
    const occupiedCells = occupiedFromPaths(frozenPaths);
    const coverageSatisfied = !level.requireFullCoverage
        || Object.keys(occupiedCells).length === level.totalPlayableCells;
    return Object.freeze({
        paths: frozenPaths,
        activeColorId: null,
        activePath: Object.freeze([]),
        occupiedCells,
        completedColorCount,
        success: completedColorCount === level.colorPairs.length && coverageSatisfied,
    });
}

/**
 * Begin at an endpoint. Pressing either endpoint of a completed color cancels
 * that path immediately; a subsequent gesture may draw it again.
 */
export function beginColorConnectPath(
    level: ColorConnectLevel,
    state: ColorConnectState,
    position: GridPosition,
): ColorConnectTransitionResult {
    if (state.success) return result(state, false, false, 'game_already_complete');
    if (!isColorConnectPositionInside(level, position)) return result(state, false, false, 'drag_outside_board');
    if (isColorConnectCellBlocked(level, position)) return result(state, false, false, 'entered_blocked_cell');
    const colorId = level.endpointColorByKey[colorConnectPositionKey(position)];
    if (!colorId) return result(state, false, false, 'start_from_non_endpoint');
    if (state.paths[colorId].completed) return cancelColorConnectPathAtEndpoint(level, state, position);
    return result(stateWithActive(state, colorId, [position]), true, true, null, { enteredCells: [position] });
}

export function extendColorConnectPath(
    level: ColorConnectLevel,
    state: ColorConnectState,
    position: GridPosition,
): ColorConnectTransitionResult {
    if (state.success) return result(state, false, false, 'game_already_complete');
    if (!state.activeColorId || state.activePath.length === 0) {
        return result(state, false, false, 'input_without_active_path');
    }
    if (!isColorConnectPositionInside(level, position)) return result(state, false, false, 'drag_outside_board');
    const last = state.activePath[state.activePath.length - 1];
    if (sameColorConnectPosition(last, position)) return result(state, false, true);
    if (!areColorConnectCellsAdjacent(last, position)) return result(state, false, false, 'non_adjacent_jump_attempt');
    if (isColorConnectCellBlocked(level, position)) return result(state, false, false, 'entered_blocked_cell');

    const previous = state.activePath.length > 1 ? state.activePath[state.activePath.length - 2] : null;
    if (previous && sameColorConnectPosition(previous, position)) {
        const activePath = state.activePath.slice(0, -1);
        return result(stateWithActive(state, state.activeColorId, activePath), true, true, null, {
            backtrackedCellCount: 1,
            enteredCells: [position],
        });
    }

    const key = colorConnectPositionKey(position);
    const endpointColor = level.endpointColorByKey[key];
    if (endpointColor && endpointColor !== state.activeColorId) {
        return result(state, false, false, 'entered_other_color_endpoint');
    }
    const ownPair = level.pairByColorId[state.activeColorId];
    const startKey = colorConnectPositionKey(state.activePath[0]);
    const target = colorConnectPositionKey(ownPair.start) === startKey ? ownPair.end : ownPair.start;
    const isTarget = sameColorConnectPosition(position, target);
    if (state.activePath.some(cell => sameColorConnectPosition(cell, position))) {
        return result(state, false, false, 'path_self_intersection_attempt');
    }
    const occupiedBy = state.occupiedCells[key];
    if (occupiedBy && occupiedBy !== state.activeColorId) {
        return result(state, false, false, 'path_overlap_attempt');
    }

    const activePath = [...state.activePath, freezePosition(position)];
    if (isTarget) {
        const nextState = completedState(level, state, state.activeColorId, activePath);
        return result(nextState, true, true, null, {
            completedColorId: state.activeColorId,
            enteredCells: [position],
        });
    }
    return result(stateWithActive(state, state.activeColorId, activePath), true, true, null, {
        enteredCells: [position],
    });
}

/**
 * Fill a fast straight pointer sample one grid cell at a time. Diagonal samples
 * are rejected because no unique orthogonal route is implied by two cells.
 */
export function extendColorConnectPathThrough(
    level: ColorConnectLevel,
    state: ColorConnectState,
    target: GridPosition,
): ColorConnectTransitionResult {
    if (!state.activeColorId || state.activePath.length === 0) {
        return result(state, false, false, 'input_without_active_path');
    }
    const from = state.activePath[state.activePath.length - 1];
    if (from.row !== target.row && from.column !== target.column) {
        return result(state, false, false, 'non_adjacent_jump_attempt');
    }
    const dr = Math.sign(target.row - from.row);
    const dc = Math.sign(target.column - from.column);
    const enteredCells: GridPosition[] = [];
    let nextState = state;
    let changed = false;
    let backtrackedCellCount = 0;
    let row = from.row;
    let column = from.column;
    while (row !== target.row || column !== target.column) {
        row += dr;
        column += dc;
        const entered = freezePosition({ row, column });
        const step = extendColorConnectPath(level, nextState, entered);
        enteredCells.push(entered);
        changed = changed || step.changed;
        backtrackedCellCount += step.backtrackedCellCount;
        nextState = step.nextState;
        if (!step.valid || step.completedColorId) {
            return result(nextState, changed, step.valid, step.violation, {
                completedColorId: step.completedColorId,
                backtrackedCellCount,
                enteredCells,
            });
        }
    }
    return result(nextState, changed, true, null, { backtrackedCellCount, enteredCells });
}

export function releaseColorConnectPath(
    _level: ColorConnectLevel,
    state: ColorConnectState,
): ColorConnectTransitionResult {
    if (!state.activeColorId) return result(state, false, true);
    return result(stateWithActive(state, null, []), true, false, 'released_before_connection');
}

export function cancelColorConnectPathAtEndpoint(
    level: ColorConnectLevel,
    state: ColorConnectState,
    position: GridPosition,
): ColorConnectTransitionResult {
    if (state.success) return result(state, false, false, 'game_already_complete');
    const colorId = level.endpointColorByKey[colorConnectPositionKey(position)];
    if (!colorId || !state.paths[colorId].completed) return result(state, false, false, 'start_from_non_endpoint');
    const paths: Record<string, ColorPathState> = { ...state.paths, [colorId]: emptyPath(colorId) };
    const frozenPaths = Object.freeze(paths);
    const nextState: ColorConnectState = Object.freeze({
        paths: frozenPaths,
        activeColorId: null,
        activePath: Object.freeze([]),
        occupiedCells: occupiedFromPaths(frozenPaths),
        completedColorCount: state.completedColorCount - 1,
        success: false,
    });
    return result(nextState, true, true, null, { cancelledColorId: colorId });
}

export function restartColorConnectState(level: ColorConnectLevel): ColorConnectState {
    return createInitialColorConnectState(level);
}

export function isColorConnectComplete(level: ColorConnectLevel, state: ColorConnectState): boolean {
    if (state.completedColorCount !== level.colorPairs.length) return false;
    return !level.requireFullCoverage || Object.keys(state.occupiedCells).length === level.totalPlayableCells;
}

export function countColorConnectOccupiedCells(state: ColorConnectState): number {
    return Object.keys(state.occupiedCells).length;
}

export function hashColorConnectState(_level: ColorConnectLevel, state: ColorConnectState): string {
    const pathPart = Object.keys(state.paths).sort().map(colorId => {
        const path = state.paths[colorId];
        return `${colorId}:${path.cells.map(colorConnectPositionKey).join(';')}`;
    }).join('|');
    const active = state.activeColorId
        ? `${state.activeColorId}:${state.activePath.map(colorConnectPositionKey).join(';')}`
        : '-';
    return `${pathPart}#${active}`;
}

export function cloneColorConnectState(state: ColorConnectState): ColorConnectState {
    const paths: Record<string, ColorPathState> = Object.create(null) as Record<string, ColorPathState>;
    for (const colorId of Object.keys(state.paths)) {
        const path = state.paths[colorId];
        paths[colorId] = Object.freeze({
            colorId,
            completed: path.completed,
            cells: Object.freeze(path.cells.map(freezePosition)),
        });
    }
    return Object.freeze({
        paths: Object.freeze(paths),
        activeColorId: state.activeColorId,
        activePath: Object.freeze(state.activePath.map(freezePosition)),
        occupiedCells: occupiedFromPaths(paths),
        completedColorCount: state.completedColorCount,
        success: state.success,
    });
}

/** Validate one complete path using the same cell rules as gameplay. */
export function validateColorConnectPath(
    level: ColorConnectLevel,
    colorId: string,
    cells: readonly GridPosition[],
    occupiedByOtherPaths: Readonly<Record<string, string>> = Object.freeze({}),
): ColorConnectPathValidation {
    const pair = level.pairByColorId[colorId];
    if (!pair || cells.length < 2) return Object.freeze({ valid: false, violation: 'released_before_connection' });
    const forward = sameColorConnectPosition(cells[0], pair.start) && sameColorConnectPosition(cells[cells.length - 1], pair.end);
    const reverse = sameColorConnectPosition(cells[0], pair.end) && sameColorConnectPosition(cells[cells.length - 1], pair.start);
    if (!forward && !reverse) return Object.freeze({ valid: false, violation: 'entered_other_color_endpoint' });
    const seen = new Set<string>();
    for (let index = 0; index < cells.length; index++) {
        const cell = cells[index];
        if (!isColorConnectPositionInside(level, cell)) return Object.freeze({ valid: false, violation: 'drag_outside_board' });
        if (isColorConnectCellBlocked(level, cell)) return Object.freeze({ valid: false, violation: 'entered_blocked_cell' });
        if (index > 0 && !areColorConnectCellsAdjacent(cells[index - 1], cell)) {
            return Object.freeze({ valid: false, violation: 'non_adjacent_jump_attempt' });
        }
        const key = colorConnectPositionKey(cell);
        if (seen.has(key)) return Object.freeze({ valid: false, violation: 'path_self_intersection_attempt' });
        seen.add(key);
        const endpointColor = level.endpointColorByKey[key];
        if (endpointColor && endpointColor !== colorId) {
            return Object.freeze({ valid: false, violation: 'entered_other_color_endpoint' });
        }
        if (occupiedByOtherPaths[key] && occupiedByOtherPaths[key] !== colorId) {
            return Object.freeze({ valid: false, violation: 'path_overlap_attempt' });
        }
    }
    return Object.freeze({ valid: true, violation: null });
}

/** Validate a complete multi-color solution without mutating gameplay state. */
export function validateColorConnectSolution(
    level: ColorConnectLevel,
    paths: Readonly<Record<string, readonly GridPosition[]>>,
): ColorConnectSolutionValidation {
    const occupied: Record<string, string> = Object.create(null) as Record<string, string>;
    let completedColorCount = 0;
    for (const pair of level.colorPairs) {
        const cells = paths[pair.colorId];
        if (!cells) {
            return Object.freeze({ valid: false, completedColorCount, occupiedCellCount: Object.keys(occupied).length, error: `Missing ${pair.colorId} path.` });
        }
        const validation = validateColorConnectPath(level, pair.colorId, cells, occupied);
        if (!validation.valid) {
            return Object.freeze({ valid: false, completedColorCount, occupiedCellCount: Object.keys(occupied).length, error: `${pair.colorId}: ${validation.violation}` });
        }
        for (const cell of cells) occupied[colorConnectPositionKey(cell)] = pair.colorId;
        completedColorCount++;
    }
    if (level.requireFullCoverage && Object.keys(occupied).length !== level.totalPlayableCells) {
        return Object.freeze({ valid: false, completedColorCount, occupiedCellCount: Object.keys(occupied).length, error: 'Full coverage is required.' });
    }
    return Object.freeze({
        valid: completedColorCount === level.colorPairs.length,
        completedColorCount,
        occupiedCellCount: Object.keys(occupied).length,
        error: null,
    });
}

/** Replay solver/test paths through authoritative start/extend transitions. */
export function replayColorConnectPaths(
    level: ColorConnectLevel,
    paths: Readonly<Record<string, readonly GridPosition[]>>,
): ColorConnectState {
    let state = createInitialColorConnectState(level);
    for (const pair of level.colorPairs) {
        const path = paths[pair.colorId];
        if (!path || path.length === 0) throw new Error(`${level.id}: missing replay path for ${pair.colorId}.`);
        let transition = beginColorConnectPath(level, state, path[0]);
        if (!transition.valid) throw new Error(`${level.id}/${pair.colorId}: replay start failed (${transition.violation}).`);
        state = transition.nextState;
        for (let index = 1; index < path.length; index++) {
            transition = extendColorConnectPath(level, state, path[index]);
            if (!transition.valid) throw new Error(`${level.id}/${pair.colorId}: replay failed (${transition.violation}).`);
            state = transition.nextState;
        }
        if (!state.paths[pair.colorId].completed) throw new Error(`${level.id}/${pair.colorId}: replay did not reach its endpoint.`);
    }
    return state;
}
