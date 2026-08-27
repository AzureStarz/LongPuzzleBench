import {
    MAZE_PAINT_DIRECTIONS,
    computeMazePaintMove,
    createInitialMazePaintState,
    hashMazePaintState,
    isMazePaintComplete,
} from './MazePaintRules';
import type {
    MazePaintDirection,
    MazePaintLevel,
    MazePaintState,
} from './MazePaintRules';

export interface MazePaintSolution {
    readonly solvable: true;
    readonly optimalMoveCount: number;
    readonly moves: readonly MazePaintDirection[];
    readonly visitedStateCount: number;
}

export interface MazePaintUnsolvable {
    readonly solvable: false;
    readonly optimalMoveCount: null;
    readonly moves: readonly MazePaintDirection[];
    readonly visitedStateCount: number;
    readonly exhausted: boolean;
}

export type MazePaintSolveResult = MazePaintSolution | MazePaintUnsolvable;

interface SearchNode {
    readonly state: MazePaintState;
    readonly depth: number;
}

interface ParentLink {
    readonly previous: string;
    readonly move: MazePaintDirection;
}

/**
 * Exact breadth-first search over `(ball position, painted mask)`.
 *
 * Time and space are O(V + E) over the reachable state graph, with at most
 * `paintableCells × 2^paintableCells` theoretical states. Screenshot levels
 * are sparse slide mazes and stay far below that bound. The solver is used by
 * validation/precomputation, never on each evaluator step.
 */
export function solveMazePaintLevel(
    level: MazePaintLevel,
    maxVisitedStates: number = Number.POSITIVE_INFINITY,
): MazePaintSolveResult {
    const initial = createInitialMazePaintState(level);
    const initialHash = hashMazePaintState(level, initial);
    const queue: SearchNode[] = [{ state: initial, depth: 0 }];
    const visited = new Set<string>([initialHash]);
    const parents = new Map<string, ParentLink>();
    let cursor = 0;

    while (cursor < queue.length) {
        const node = queue[cursor++];
        const currentHash = hashMazePaintState(level, node.state);
        if (isMazePaintComplete(level, node.state)) {
            const moves: MazePaintDirection[] = [];
            let hash = currentHash;
            while (hash !== initialHash) {
                const link = parents.get(hash);
                if (!link) throw new Error(`${level.id}: solver parent chain is incomplete.`);
                moves.push(link.move);
                hash = link.previous;
            }
            moves.reverse();
            return Object.freeze({
                solvable: true,
                optimalMoveCount: node.depth,
                moves: Object.freeze(moves),
                visitedStateCount: visited.size,
            });
        }

        for (const direction of MAZE_PAINT_DIRECTIONS) {
            const move = computeMazePaintMove(level, node.state, direction);
            if (!move.moved) continue;
            const nextHash = hashMazePaintState(level, move.nextState);
            if (visited.has(nextHash)) continue;
            if (visited.size >= maxVisitedStates) {
                return Object.freeze({
                    solvable: false,
                    optimalMoveCount: null,
                    moves: Object.freeze([]),
                    visitedStateCount: visited.size,
                    exhausted: false,
                });
            }
            visited.add(nextHash);
            parents.set(nextHash, Object.freeze({ previous: currentHash, move: direction }));
            queue.push(Object.freeze({ state: move.nextState, depth: node.depth + 1 }));
        }
    }

    return Object.freeze({
        solvable: false,
        optimalMoveCount: null,
        moves: Object.freeze([]),
        visitedStateCount: visited.size,
        exhausted: true,
    });
}

export function replayMazePaintSolution(
    level: MazePaintLevel,
    moves: readonly MazePaintDirection[],
): MazePaintState {
    let state = createInitialMazePaintState(level);
    for (const direction of moves) {
        state = computeMazePaintMove(level, state, direction).nextState;
    }
    return state;
}
