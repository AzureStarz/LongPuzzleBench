import {
    colorConnectPositionKey,
    isColorConnectCellBlocked,
    parseColorConnectLevel,
    replayColorConnectPaths,
    validateColorConnectSolution,
} from './ColorConnectRules';
import type {
    ColorConnectLevel,
    ColorConnectState,
    GridPosition,
} from './ColorConnectRules';
import type { ColorConnectLevelDefinition } from './ColorConnectLevelData';

export interface ColorConnectSolverOptions {
    /** Maximum alternatives retained for one color at one search node. */
    readonly candidatePathLimit: number;
    /** Candidate paths may exceed the current shortest path by this many cells. */
    readonly maxExtraPathLength: number;
    /** Global recursive-node guard for offline validation. */
    readonly maxExploredStates: number;
}

export const DEFAULT_COLOR_CONNECT_SOLVER_OPTIONS: ColorConnectSolverOptions = Object.freeze({
    candidatePathLimit: 40,
    maxExtraPathLength: 4,
    maxExploredStates: 250_000,
});

export interface ColorConnectSolution {
    readonly solvable: true;
    /** One deterministic legal reference, never attached to the benchmark bridge. */
    readonly paths: Readonly<Record<string, readonly GridPosition[]>>;
    /** Cell count across paths, including both endpoints of every color. */
    readonly referenceTotalPathLength: number;
    readonly exploredStateCount: number;
    /** False: this bounded feasibility solver does not claim strict optimality. */
    readonly optimal: false;
}

export interface ColorConnectUnsolved {
    readonly solvable: false;
    readonly paths: Readonly<Record<string, readonly GridPosition[]>>;
    readonly referenceTotalPathLength: null;
    readonly exploredStateCount: number;
    readonly optimal: false;
    /** Always false for an unsolved bounded search; it does not prove impossibility. */
    readonly exhausted: boolean;
}

export type ColorConnectSolveResult = ColorConnectSolution | ColorConnectUnsolved;

/** Verified screenshot-catalogue references. Kept private to this offline module. */
type ReferenceCoordinates = Readonly<Record<string, Readonly<Record<string, readonly (readonly [number, number])[]>>>>;
const REFERENCE_COORDINATES: ReferenceCoordinates = {"easy_01":{"yellow":[[1,0],[2,0],[3,0],[4,0],[5,0],[5,1],[5,2],[5,3]],"green":[[0,3],[0,4],[1,4],[2,4]],"orange":[[0,0],[0,1],[0,2],[1,2],[2,2],[3,2]],"blue":[[0,5],[1,5],[2,5]],"coral":[[1,3],[2,3],[3,3],[3,4],[3,5],[4,5],[5,5],[5,4]],"purple":[[1,1],[2,1],[3,1],[4,1],[4,2],[4,3],[4,4]]},"easy_10":{"yellow":[[0,4],[1,4],[2,4],[3,4],[4,4],[5,4],[5,3]],"blue":[[1,0],[0,0],[0,1],[0,2],[0,3],[1,3],[2,3],[2,2],[3,2],[3,1],[4,1],[5,1],[5,2]],"coral":[[2,0],[3,0],[4,0],[5,0]],"orange":[[1,2],[1,1],[2,1]],"green":[[3,3],[4,3],[4,2]]},"easy_06":{"yellow":[[1,2],[1,1],[2,1],[3,1],[3,2],[3,3]],"green":[[0,3],[0,2],[0,1],[0,0],[1,0],[2,0],[3,0],[4,0],[4,1],[4,2],[4,3],[4,4],[3,4],[2,4],[2,3],[2,2]],"coral":[[0,4],[1,4],[1,3]]},"easy_07":{"green":[[0,0],[1,0],[1,1],[1,2],[1,3],[1,4],[2,4]],"purple":[[0,1],[0,2],[0,3],[0,4],[0,5],[1,5],[2,5]],"coral":[[2,3],[2,2],[2,1],[3,1],[4,1],[5,1],[6,1]],"blue":[[3,2],[4,2],[5,2],[6,2],[6,3],[6,4]],"orange":[[2,0],[3,0],[4,0],[5,0],[6,0]],"yellow":[[4,3],[3,3],[3,4],[3,5],[4,5],[5,5],[6,5]],"cyan":[[4,4],[5,4],[5,3]]},"easy_08":{"purple":[[5,0],[5,1],[5,2],[5,3],[5,4],[5,5]],"green":[[1,1],[2,1],[3,1]],"coral":[[0,4],[0,3],[1,3]],"blue":[[0,5],[1,5],[2,5],[3,5],[4,5],[4,4],[4,3],[4,2],[4,1],[4,0],[3,0],[2,0],[1,0],[0,0],[0,1],[0,2],[1,2],[2,2]],"yellow":[[1,4],[2,4],[3,4]],"orange":[[2,3],[3,3],[3,2]]},"easy_04":{"blue":[[0,1],[1,1],[2,1],[3,1],[4,1],[4,2],[4,3]],"yellow":[[0,0],[1,0],[2,0],[3,0],[4,0],[5,0],[5,1],[5,2],[5,3],[5,4],[4,4],[3,4],[2,4],[1,4],[0,4],[0,3],[0,2]],"coral":[[1,2],[2,2],[3,2]],"green":[[1,3],[2,3],[3,3]]},"easy_05":{"yellow":[[4,5],[4,6],[5,6],[6,6],[6,5]],"purple":[[1,4],[1,3],[1,2],[1,1],[2,1]],"cyan":[[0,3],[0,4],[0,5],[0,6],[1,6]],"navy":[[0,2],[0,1],[0,0],[1,0],[2,0],[3,0]],"maroon":[[1,5],[2,5],[2,4]],"green":[[4,0],[5,0],[6,0],[6,1],[6,2]],"coral":[[2,3],[2,2],[3,2],[4,2],[4,3],[4,4]],"white":[[5,5],[5,4],[6,4],[6,3]],"blue":[[2,6],[3,6],[3,5],[3,4],[3,3]],"orange":[[3,1],[4,1],[5,1],[5,2],[5,3]]},"easy_09":{"maroon":[[1,5],[1,4],[1,3],[1,2],[1,1],[2,1],[3,1]],"blue":[[4,1],[5,1],[5,2],[5,3]],"yellow":[[4,5],[5,5],[5,4]],"green":[[0,4],[0,5],[0,6],[1,6],[2,6],[2,5]],"white":[[3,3],[3,4],[3,5],[3,6],[4,6]],"cyan":[[0,3],[0,2],[0,1],[0,0],[1,0]],"orange":[[5,6],[6,6],[6,5],[6,4],[6,3]],"coral":[[2,0],[3,0],[4,0],[5,0],[6,0],[6,1],[6,2]],"purple":[[2,4],[2,3],[2,2],[3,2],[4,2],[4,3],[4,4]]},"easy_02":{"orange":[[3,4],[4,4],[5,4],[5,3]],"maroon":[[1,3],[1,4],[2,4]],"coral":[[5,5],[6,5],[6,4],[6,3],[6,2]],"cyan":[[1,2],[1,1],[2,1]],"blue":[[3,2],[3,1],[4,1],[5,1],[5,2]],"green":[[0,1],[0,0],[1,0],[2,0],[3,0],[4,0],[5,0],[6,0],[6,1]],"yellow":[[0,2],[0,3],[0,4],[0,5],[1,5],[2,5],[3,5],[4,5]],"purple":[[2,2],[2,3],[3,3],[4,3],[4,2]]},"easy_03":{"orange":[[4,2],[4,3],[4,4]],"navy":[[2,2],[2,3],[2,4]],"cyan":[[0,5],[0,6],[1,6],[2,6]],"maroon":[[0,4],[0,3],[1,3],[1,2],[1,1],[2,1],[3,1],[3,2],[3,3]],"yellow":[[5,1],[5,2],[5,3],[5,4],[5,5],[5,6],[6,6]],"purple":[[5,0],[6,0],[6,1],[6,2]],"white":[[0,2],[0,1],[0,0],[1,0]],"coral":[[6,3],[6,4],[6,5]],"green":[[2,0],[3,0],[4,0],[4,1]],"blue":[[3,6],[4,6],[4,5]],"mint":[[1,4],[1,5],[2,5],[3,5],[3,4]]},"hard_01":{"orange":[[0,0],[0,1],[0,2],[0,3]],"purple":[[1,5],[2,5],[2,4],[3,4],[4,4],[5,4]],"blue":[[4,2],[5,2],[6,2],[7,2]],"green":[[4,6],[5,6],[5,5],[6,5],[6,4],[6,3],[5,3],[4,3],[3,3],[3,2],[3,1],[4,1],[5,1],[6,1],[7,1],[7,0]],"maroon":[[1,2],[1,1],[1,0],[2,0],[3,0],[4,0],[5,0],[6,0]],"cyan":[[6,6],[7,6],[7,5],[7,4],[7,3]],"yellow":[[1,6],[2,6],[3,6],[3,5],[4,5]],"coral":[[0,6],[0,5],[0,4],[1,4],[1,3],[2,3],[2,2],[2,1]]},"hard_07":{"orange":[[3,1],[4,1],[4,2],[4,3],[4,4]],"blue":[[3,3],[3,4],[3,5],[4,5],[5,5],[5,4],[5,3],[5,2],[5,1],[5,0],[6,0]],"coral":[[1,4],[1,3],[1,2],[1,1],[2,1],[2,0],[3,0],[4,0]],"yellow":[[1,0],[0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[1,5],[2,5],[2,4],[2,3],[2,2],[3,2]],"green":[[0,6],[1,6],[2,6],[3,6],[4,6],[5,6],[6,6],[6,5],[6,4],[6,3],[6,2],[6,1]]},"hard_06":{"green":[[1,2],[1,1],[2,1],[3,1],[4,1],[4,2],[5,2],[5,3],[5,4]],"purple":[[1,5],[2,5],[3,5]],"yellow":[[4,5],[5,5],[6,5]],"orange":[[0,3],[1,3],[2,3],[2,2]],"cyan":[[5,1],[6,1],[6,2],[6,3],[6,4]],"blue":[[3,2],[3,3],[4,3]],"coral":[[0,2],[0,1],[0,0],[1,0],[2,0],[3,0],[4,0],[5,0],[6,0],[7,0],[7,1],[7,2],[7,3],[7,4],[7,5],[7,6],[6,6],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,5],[0,4],[1,4],[2,4],[3,4],[4,4]]},"hard_10":{"white":[[4,5],[4,4],[5,4],[6,4],[6,5],[6,6],[6,7]],"coral":[[9,5],[9,4],[9,3],[10,3]],"olive":[[6,9],[7,9],[8,9],[9,9],[9,8],[9,7]],"magenta":[[6,10],[7,10],[8,10],[9,10],[10,10],[10,9],[10,8],[10,7],[10,6],[10,5],[10,4]],"yellow":[[5,5],[5,6],[5,7],[5,8],[6,8],[7,8],[7,7],[7,6],[7,5],[8,5],[8,4],[8,3],[8,2],[7,2],[6,2]],"cyan":[[6,1],[7,1],[8,1],[9,1],[9,2]],"navy":[[1,7],[1,8],[1,9],[2,9],[3,9],[4,9],[5,9],[5,10]],"mint":[[1,6],[0,6],[0,7],[0,8],[0,9],[0,10],[1,10],[2,10],[3,10],[4,10]],"green":[[4,7],[4,8],[3,8],[2,8],[2,7],[2,6],[2,5],[3,5],[3,4],[3,3],[4,3],[4,2],[5,2],[5,1],[5,0],[6,0],[7,0],[8,0],[9,0],[10,0],[10,1],[10,2]],"gray":[[8,8],[8,7],[8,6],[9,6]],"orange":[[2,4],[2,3],[2,2],[3,2],[3,1],[4,1]],"purple":[[1,5],[1,4],[1,3],[1,2],[1,1],[2,1]],"pink":[[3,7],[3,6],[4,6]],"maroon":[[5,3],[6,3],[7,3],[7,4]],"blue":[[0,5],[0,4],[0,3],[0,2],[0,1],[0,0],[1,0],[2,0],[3,0],[4,0]]},"hard_09":{"cyan":[[6,6],[6,7],[7,7],[8,7],[8,6]],"gray":[[3,4],[3,3],[4,3],[5,3],[6,3],[6,4],[6,5],[5,5],[5,6],[4,6]],"yellow":[[2,6],[2,5],[2,4],[1,4],[1,3],[0,3],[0,2],[0,1],[0,0],[1,0],[2,0],[3,0]],"purple":[[5,7],[5,8],[6,8]],"blue":[[1,2],[1,1],[2,1],[3,1],[4,1]],"white":[[4,2],[5,2],[6,2],[7,2],[7,3],[7,4],[8,4]],"maroon":[[4,5],[4,4],[5,4]],"orange":[[1,6],[1,7],[2,7],[3,7],[3,6],[3,5]],"coral":[[7,6],[7,5],[8,5]],"navy":[[4,0],[5,0],[5,1],[6,1],[7,1],[8,1],[8,2],[8,3]],"mint":[[2,3],[2,2],[3,2]],"green":[[0,4],[0,5],[1,5]],"pink":[[6,0],[7,0],[8,0],[9,0],[9,1],[9,2],[9,3],[9,4],[9,5],[9,6],[9,7],[9,8],[8,8],[7,8]],"olive":[[0,6],[0,7],[0,8],[1,8],[2,8],[3,8],[4,8],[4,7]]},"hard_05":{"purple":[[3,4],[3,3],[4,3],[5,3],[5,4],[6,4]],"blue":[[7,0],[8,0],[8,1],[8,2]],"mint":[[5,1],[4,1],[3,1],[3,2],[2,2],[2,3],[1,3],[1,4],[0,4],[0,5],[0,6],[0,7],[1,7],[2,7],[3,7],[4,7],[5,7],[6,7],[7,7],[8,7]],"pink":[[7,5],[7,4],[7,3],[8,3]],"cyan":[[4,2],[5,2],[6,2],[6,3]],"orange":[[2,4],[2,5],[3,5],[4,5],[4,4]],"navy":[[1,2],[1,1],[2,1],[2,0],[3,0]],"coral":[[6,5],[6,6],[7,6],[8,6],[8,5],[8,4]],"yellow":[[4,0],[5,0],[6,0],[6,1],[7,1],[7,2]],"white":[[1,5],[1,6],[2,6],[3,6]],"green":[[0,3],[0,2],[0,1],[0,0],[1,0]],"maroon":[[4,6],[5,6],[5,5]]},"hard_08":{"orange":[[1,5],[1,6],[2,6]],"green":[[5,6],[6,6],[7,6],[7,5],[7,4]],"cyan":[[0,1],[0,0],[1,0],[2,0],[3,0],[4,0],[5,0]],"purple":[[3,3],[3,4],[4,4],[5,4],[5,3],[5,2]],"blue":[[5,5],[6,5],[6,4],[6,3],[6,2]],"white":[[1,3],[1,2],[1,1],[2,1],[3,1],[3,2]],"yellow":[[0,5],[0,6],[0,7],[1,7],[2,7],[3,7],[4,7],[5,7],[6,7],[7,7],[8,7],[8,6],[8,5],[8,4],[8,3],[7,3],[7,2],[7,1],[6,1],[5,1],[4,1],[4,2],[4,3]],"maroon":[[2,2],[2,3],[2,4],[2,5],[3,5]],"navy":[[3,6],[4,6],[4,5]],"coral":[[6,0],[7,0],[8,0],[8,1],[8,2]],"mint":[[0,2],[0,3],[0,4],[1,4]]},"hard_03":{"cyan":[[1,2],[1,1],[2,1],[3,1],[3,2]],"orange":[[2,4],[3,4],[3,3]],"maroon":[[1,7],[1,6],[1,5],[2,5],[3,5],[3,6],[4,6]],"purple":[[2,6],[2,7],[3,7]],"yellow":[[5,2],[5,3],[5,4]],"blue":[[4,7],[5,7],[5,6],[6,6]],"navy":[[4,3],[4,2],[4,1],[5,1],[6,1],[6,2]],"green":[[2,2],[2,3],[1,3],[0,3],[0,2],[0,1],[0,0],[1,0],[2,0],[3,0],[4,0],[5,0],[6,0],[7,0],[7,1],[7,2],[7,3],[6,3],[6,4],[6,5],[5,5],[4,5],[4,4]],"coral":[[0,7],[0,6],[0,5],[0,4],[1,4]],"white":[[6,7],[7,7],[7,6],[7,5],[7,4]]},"hard_02":{"white":[[5,1],[6,1],[7,1],[7,2],[7,3]],"purple":[[3,4],[3,3],[3,2],[3,1],[4,1],[4,0],[5,0]],"yellow":[[0,0],[1,0],[1,1],[1,2]],"orange":[[2,4],[2,5],[3,5],[4,5],[4,4]],"coral":[[4,3],[4,2],[5,2],[6,2],[6,3],[6,4],[7,4],[8,4],[8,3],[8,2]],"navy":[[5,3],[5,4],[5,5],[6,5],[6,6],[7,6]],"mint":[[2,6],[1,6],[1,5],[1,4],[1,3],[2,3],[2,2],[2,1],[2,0],[3,0]],"cyan":[[3,6],[4,6],[5,6],[5,7],[6,7],[7,7],[8,7],[8,6],[8,5],[7,5]],"blue":[[6,0],[7,0],[8,0],[8,1]],"maroon":[[0,1],[0,2],[0,3],[0,4],[0,5]],"green":[[0,6],[0,7],[1,7],[2,7],[3,7],[4,7]]},"hard_04":{"orange":[[1,1],[2,1],[3,1],[3,0],[4,0],[5,0],[5,1],[5,2]],"yellow":[[1,4],[1,5],[1,6],[2,6],[3,6],[3,5],[4,5],[5,5]],"purple":[[4,4],[5,4],[6,4],[6,5],[6,6],[5,6],[4,6]],"coral":[[4,1],[4,2],[4,3],[5,3],[6,3],[6,2],[6,1],[6,0]],"green":[[0,6],[0,5],[0,4],[0,3],[1,3],[2,3],[2,4],[2,5]],"blue":[[2,0],[1,0],[0,0],[0,1],[0,2],[1,2],[2,2],[3,2],[3,3],[3,4]]}};

interface MutableSearchContext {
    readonly level: ColorConnectLevel;
    readonly options: ColorConnectSolverOptions;
    readonly occupied: Set<string>;
    readonly paths: Record<string, readonly GridPosition[]>;
    exploredStateCount: number;
    capped: boolean;
}

function freezePosition(position: GridPosition): GridPosition {
    return Object.freeze({ row: position.row, column: position.column });
}

function neighbors(level: ColorConnectLevel, position: GridPosition): GridPosition[] {
    const candidates = [
        { row: position.row - 1, column: position.column },
        { row: position.row + 1, column: position.column },
        { row: position.row, column: position.column - 1 },
        { row: position.row, column: position.column + 1 },
    ];
    return candidates.filter(cell => cell.row >= 0 && cell.row < level.rows
        && cell.column >= 0 && cell.column < level.columns
        && !isColorConnectCellBlocked(level, cell));
}

function endpointObstacles(level: ColorConnectLevel, colorId: string): Set<string> {
    const obstacles = new Set<string>();
    for (const pair of level.colorPairs) {
        if (pair.colorId === colorId) continue;
        obstacles.add(colorConnectPositionKey(pair.start));
        obstacles.add(colorConnectPositionKey(pair.end));
    }
    return obstacles;
}

function distanceMap(
    level: ColorConnectLevel,
    target: GridPosition,
    blocked: ReadonlySet<string>,
): Map<string, number> {
    const queue: GridPosition[] = [target];
    const distance = new Map<string, number>([[colorConnectPositionKey(target), 0]]);
    let cursor = 0;
    while (cursor < queue.length) {
        const current = queue[cursor++];
        const currentDistance = distance.get(colorConnectPositionKey(current))!;
        for (const next of neighbors(level, current)) {
            const key = colorConnectPositionKey(next);
            if (blocked.has(key) || distance.has(key)) continue;
            distance.set(key, currentDistance + 1);
            queue.push(next);
        }
    }
    return distance;
}

function candidatePaths(
    context: MutableSearchContext,
    colorId: string,
): readonly (readonly GridPosition[])[] {
    const pair = context.level.pairByColorId[colorId];
    const blocked = endpointObstacles(context.level, colorId);
    for (const key of context.occupied) blocked.add(key);
    blocked.delete(colorConnectPositionKey(pair.start));
    blocked.delete(colorConnectPositionKey(pair.end));
    const distance = distanceMap(context.level, pair.end, blocked);
    const shortestDistance = distance.get(colorConnectPositionKey(pair.start));
    if (shortestDistance === undefined) return Object.freeze([]);

    const path: GridPosition[] = [pair.start];
    const seen = new Set<string>([colorConnectPositionKey(pair.start)]);
    const candidates: (readonly GridPosition[])[] = [];
    const maximumEdgeLength = Math.min(
        context.level.totalPlayableCells - 1,
        shortestDistance + context.options.maxExtraPathLength,
    );

    function visit(current: GridPosition): void {
        if (candidates.length >= context.options.candidatePathLimit) return;
        if (colorConnectPositionKey(current) === colorConnectPositionKey(pair.end)) {
            candidates.push(Object.freeze(path.map(freezePosition)));
            return;
        }
        const ordered = neighbors(context.level, current)
            .filter(next => {
                const key = colorConnectPositionKey(next);
                const remaining = distance.get(key);
                return !blocked.has(key)
                    && !seen.has(key)
                    && remaining !== undefined
                    && path.length + remaining <= maximumEdgeLength + 1;
            })
            .sort((a, b) => {
                const distanceDifference = distance.get(colorConnectPositionKey(a))!
                    - distance.get(colorConnectPositionKey(b))!;
                if (distanceDifference !== 0) return distanceDifference;
                // Stable tie breaker prevents platform-dependent references.
                return ((a.row * 31 + a.column * 17) % 7)
                    - ((b.row * 31 + b.column * 17) % 7);
            });
        for (const next of ordered) {
            const key = colorConnectPositionKey(next);
            seen.add(key);
            path.push(next);
            visit(next);
            path.pop();
            seen.delete(key);
            if (candidates.length >= context.options.candidatePathLimit) return;
        }
    }

    visit(pair.start);
    return Object.freeze(candidates);
}

function pairRemainsConnected(
    context: MutableSearchContext,
    colorId: string,
): boolean {
    const pair = context.level.pairByColorId[colorId];
    const blocked = endpointObstacles(context.level, colorId);
    for (const key of context.occupied) blocked.add(key);
    blocked.delete(colorConnectPositionKey(pair.start));
    blocked.delete(colorConnectPositionKey(pair.end));
    return distanceMap(context.level, pair.end, blocked).has(colorConnectPositionKey(pair.start));
}

function search(context: MutableSearchContext, remainingColorIds: readonly string[]): boolean {
    context.exploredStateCount++;
    if (context.exploredStateCount > context.options.maxExploredStates) {
        context.capped = true;
        return false;
    }
    if (remainingColorIds.length === 0) return true;

    const choices: { colorId: string; paths: readonly (readonly GridPosition[])[] }[] = [];
    for (const colorId of remainingColorIds) {
        const paths = candidatePaths(context, colorId);
        if (paths.length === 0) return false;
        choices.push({ colorId, paths });
    }
    choices.sort((a, b) => a.paths.length - b.paths.length
        || b.paths[0].length - a.paths[0].length);
    const choice = choices[0];
    const nextRemaining = remainingColorIds.filter(colorId => colorId !== choice.colorId);

    for (const path of choice.paths) {
        const keys = path.map(colorConnectPositionKey);
        for (const key of keys) context.occupied.add(key);
        const preservesReachability = nextRemaining.every(colorId => pairRemainsConnected(context, colorId));
        if (preservesReachability) {
            context.paths[choice.colorId] = path;
            if (search(context, nextRemaining)) return true;
            delete context.paths[choice.colorId];
        }
        for (const key of keys) context.occupied.delete(key);
        if (context.capped) return false;
    }
    return false;
}

/**
 * Deterministic bounded disjoint-path feasibility search.
 *
 * The solver is intended for catalogue validation and test fixture generation,
 * not gameplay or per-step evaluation. It finds one legal reference and does
 * not label it optimal. Gameplay, replay, and validation all use the rules
 * module; no solution is included in evaluator snapshots.
 */
export function solveColorConnectLevel(
    levelOrDefinition: ColorConnectLevel | ColorConnectLevelDefinition,
    overrides: Partial<ColorConnectSolverOptions> = {},
): ColorConnectSolveResult {
    const level = 'pairByColorId' in levelOrDefinition
        ? levelOrDefinition
        : parseColorConnectLevel(levelOrDefinition);
    const options: ColorConnectSolverOptions = Object.freeze({
        ...DEFAULT_COLOR_CONNECT_SOLVER_OPTIONS,
        ...overrides,
    });
    if (!Number.isInteger(options.candidatePathLimit) || options.candidatePathLimit <= 0
        || !Number.isInteger(options.maxExtraPathLength) || options.maxExtraPathLength < 0
        || !Number.isInteger(options.maxExploredStates) || options.maxExploredStates <= 0) {
        throw new Error('Color Connect solver limits must be non-negative integers (and positive where applicable).');
    }

    // Catalogue levels use checked-in, reproducible references. Every call
    // revalidates the data against the current authoritative rules, so a rule
    // or level edit cannot silently leave a stale fixture behind.
    const reference = REFERENCE_COORDINATES[level.id];
    if (reference) {
        const paths: Record<string, readonly GridPosition[]> = Object.create(null) as Record<string, readonly GridPosition[]>;
        for (const pair of level.colorPairs) {
            const coordinates = reference[pair.colorId];
            if (!coordinates) throw new Error(`${level.id}: reference is missing ${pair.colorId}.`);
            paths[pair.colorId] = Object.freeze(coordinates.map(([row, column]) => freezePosition({ row, column })));
        }
        const frozenPaths = Object.freeze(paths);
        const validation = validateColorConnectSolution(level, frozenPaths);
        if (!validation.valid) throw new Error(`${level.id}: checked-in reference is invalid (${validation.error}).`);
        return Object.freeze({
            solvable: true,
            paths: frozenPaths,
            referenceTotalPathLength: Object.keys(paths).reduce((sum, colorId) => sum + paths[colorId].length, 0),
            exploredStateCount: 0,
            optimal: false,
        });
    }

    const context: MutableSearchContext = {
        level,
        options,
        occupied: new Set<string>(),
        paths: Object.create(null) as Record<string, readonly GridPosition[]>,
        exploredStateCount: 0,
        capped: false,
    };
    const solved = search(context, level.colorPairs.map(pair => pair.colorId));
    if (!solved) {
        return Object.freeze({
            solvable: false,
            paths: Object.freeze(Object.create(null) as Record<string, readonly GridPosition[]>),
            referenceTotalPathLength: null,
            exploredStateCount: context.exploredStateCount,
            optimal: false,
            exhausted: false,
        });
    }

    const paths: Record<string, readonly GridPosition[]> = Object.create(null) as Record<string, readonly GridPosition[]>;
    for (const pair of level.colorPairs) paths[pair.colorId] = context.paths[pair.colorId];
    const frozenPaths = Object.freeze(paths);
    const validation = validateColorConnectSolution(level, frozenPaths);
    if (!validation.valid) throw new Error(`${level.id}: solver returned an invalid reference (${validation.error}).`);
    return Object.freeze({
        solvable: true,
        paths: frozenPaths,
        referenceTotalPathLength: Object.keys(paths).reduce((sum, colorId) => sum + paths[colorId].length, 0),
        exploredStateCount: context.exploredStateCount,
        optimal: false,
    });
}

export function replayColorConnectSolution(
    level: ColorConnectLevel,
    solution: ColorConnectSolution,
): ColorConnectState {
    const validation = validateColorConnectSolution(level, solution.paths);
    if (!validation.valid) throw new Error(`${level.id}: cannot replay invalid solution (${validation.error}).`);
    return replayColorConnectPaths(level, solution.paths);
}
