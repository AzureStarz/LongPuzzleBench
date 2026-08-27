export type ColorConnectDifficulty = 'easy' | 'hard';

export interface ColorConnectGridPosition {
    readonly row: number;
    readonly column: number;
}

export interface ColorConnectColorPairConfig {
    readonly colorId: string;
    readonly start: ColorConnectGridPosition;
    readonly end: ColorConnectGridPosition;
    readonly displayColor: string;
}

export interface ColorConnectLevelDefinition {
    readonly id: string;
    readonly difficulty: ColorConnectDifficulty;
    readonly levelNumber: number;
    readonly rows: number;
    readonly columns: number;
    readonly blockedCells: readonly ColorConnectGridPosition[];
    readonly colorPairs: readonly ColorConnectColorPairConfig[];
    readonly requireFullCoverage: false;
    readonly screenshot: string;
    /** Title rendered in the source capture, retained even when it disagrees with the filename. */
    readonly sourceTitle: string;
    readonly sourceScreenshotTitle: string;
}

const COLORS: Readonly<Record<string, string>> = Object.freeze({
    orange: '#ff8e00',
    green: '#00b418',
    blue: '#1c71ff',
    yellow: '#fff900',
    purple: '#a44bab',
    coral: '#f15047',
    cyan: '#00efff',
    maroon: '#a6160f',
    mint: '#00ff7f',
    navy: '#002eb7',
    white: '#ffffff',
    pink: '#ff3696',
    olive: '#808100',
    gray: '#a0a0a0',
    magenta: '#ff6eff',
});

type EndpointTuple = readonly [string, number, number, number, number];

function position(row: number, column: number): ColorConnectGridPosition {
    return Object.freeze({ row, column });
}

function pair(tuple: EndpointTuple): ColorConnectColorPairConfig {
    const [colorId, startRow, startColumn, endRow, endColumn] = tuple;
    const displayColor = COLORS[colorId];
    if (!displayColor) throw new Error(`Unknown Color Connect color: ${colorId}`);
    return Object.freeze({
        colorId,
        start: position(startRow, startColumn),
        end: position(endRow, endColumn),
        displayColor,
    });
}

function level(
    difficulty: ColorConnectDifficulty,
    levelNumber: number,
    rows: number,
    columns: number,
    endpoints: readonly EndpointTuple[],
    sourceTitle?: string,
): ColorConnectLevelDefinition {
    const number = levelNumber < 10 ? `0${levelNumber}` : String(levelNumber);
    const screenshotDirectory = difficulty === 'easy' ? '简单' : '困难';
    const titleDifficulty = difficulty === 'easy' ? '簡單' : '困難';
    const capturedTitle = sourceTitle ?? `${titleDifficulty} 第 ${levelNumber} 關`;
    return Object.freeze({
        id: `${difficulty}_${number}`,
        difficulty,
        levelNumber,
        rows,
        columns,
        blockedCells: Object.freeze([]),
        colorPairs: Object.freeze(endpoints.map(pair)),
        requireFullCoverage: false,
        screenshot: `${screenshotDirectory}/${levelNumber}.png`,
        sourceTitle: capturedTitle,
        sourceScreenshotTitle: capturedTitle,
    });
}

/**
 * Screenshot-derived catalogue. Coordinates are zero-based from the top-left.
 * The screenshots contain rectangular open boards and no pre-connected paths.
 * Full-board coverage cannot be established from a still image, so it is not a
 * completion requirement; only pairwise, non-overlapping connections are.
 */
export const COLOR_CONNECT_LEVELS: Readonly<Record<ColorConnectDifficulty, readonly ColorConnectLevelDefinition[]>> = Object.freeze({
    easy: Object.freeze([
        level('easy', 1, 6, 6, [
            ['orange', 0, 0, 3, 2], ['green', 0, 3, 2, 4], ['blue', 0, 5, 2, 5],
            ['yellow', 1, 0, 5, 3], ['purple', 1, 1, 4, 4], ['coral', 1, 3, 5, 4],
        ]),
        level('easy', 2, 7, 6, [
            ['green', 0, 1, 6, 1], ['yellow', 0, 2, 4, 5], ['cyan', 1, 2, 2, 1],
            ['maroon', 1, 3, 2, 4], ['purple', 2, 2, 4, 2], ['blue', 3, 2, 5, 2],
            ['orange', 3, 4, 5, 3], ['coral', 5, 5, 6, 2],
        ]),
        level('easy', 3, 7, 7, [
            ['white', 0, 2, 1, 0], ['maroon', 0, 4, 3, 3], ['cyan', 0, 5, 2, 6],
            ['mint', 1, 4, 3, 4], ['green', 2, 0, 4, 1], ['navy', 2, 2, 2, 4],
            ['blue', 3, 6, 4, 5], ['orange', 4, 2, 4, 4], ['purple', 5, 0, 6, 2],
            ['yellow', 5, 1, 6, 6], ['coral', 6, 3, 6, 5],
        ]),
        level('easy', 4, 6, 5, [
            ['yellow', 0, 0, 0, 2], ['blue', 0, 1, 4, 3],
            ['coral', 1, 2, 3, 2], ['green', 1, 3, 3, 3],
        ]),
        level('easy', 5, 7, 7, [
            ['navy', 0, 2, 3, 0], ['cyan', 0, 3, 1, 6], ['purple', 1, 4, 2, 1],
            ['maroon', 1, 5, 2, 4], ['coral', 2, 3, 4, 4], ['blue', 2, 6, 3, 3],
            ['orange', 3, 1, 5, 3], ['green', 4, 0, 6, 2], ['yellow', 4, 5, 6, 5],
            ['white', 5, 5, 6, 3],
        ]),
        level('easy', 6, 5, 5, [
            ['green', 0, 3, 2, 2], ['coral', 0, 4, 1, 3], ['yellow', 1, 2, 3, 3],
        ]),
        level('easy', 7, 7, 6, [
            ['green', 0, 0, 2, 4], ['purple', 0, 1, 2, 5], ['orange', 2, 0, 6, 0],
            ['coral', 2, 3, 6, 1], ['blue', 3, 2, 6, 4], ['yellow', 4, 3, 6, 5],
            ['cyan', 4, 4, 5, 3],
        ]),
        level('easy', 8, 6, 6, [
            ['coral', 0, 4, 1, 3], ['blue', 0, 5, 2, 2], ['green', 1, 1, 3, 1],
            ['yellow', 1, 4, 3, 4], ['orange', 2, 3, 3, 2], ['purple', 5, 0, 5, 5],
        ]),
        level('easy', 9, 7, 7, [
            ['cyan', 0, 3, 1, 0], ['green', 0, 4, 2, 5], ['maroon', 1, 5, 3, 1],
            ['coral', 2, 0, 6, 2], ['purple', 2, 4, 4, 4], ['white', 3, 3, 4, 6],
            ['blue', 4, 1, 5, 3], ['yellow', 4, 5, 5, 4], ['orange', 5, 6, 6, 3],
        ]),
        level('easy', 10, 6, 5, [
            ['yellow', 0, 4, 5, 3], ['blue', 1, 0, 5, 2], ['orange', 1, 2, 2, 1],
            ['coral', 2, 0, 5, 0], ['green', 3, 3, 4, 2],
        ]),
    ]),
    hard: Object.freeze([
        level('hard', 1, 8, 7, [
            ['orange', 0, 0, 0, 3], ['coral', 0, 6, 2, 1], ['maroon', 1, 2, 6, 0],
            ['purple', 1, 5, 5, 4], ['yellow', 1, 6, 4, 5], ['blue', 4, 2, 7, 2],
            ['green', 4, 6, 7, 0], ['cyan', 6, 6, 7, 3],
        ]),
        level('hard', 2, 9, 8, [
            ['yellow', 0, 0, 1, 2], ['maroon', 0, 1, 0, 5], ['green', 0, 6, 4, 7],
            ['orange', 2, 4, 4, 4], ['mint', 2, 6, 3, 0], ['purple', 3, 4, 5, 0],
            ['cyan', 3, 6, 7, 5], ['coral', 4, 3, 8, 2], ['white', 5, 1, 7, 3],
            ['navy', 5, 3, 7, 6], ['blue', 6, 0, 8, 1],
        ]),
        level('hard', 3, 8, 8, [
            ['coral', 0, 7, 1, 4], ['cyan', 1, 2, 3, 2], ['maroon', 1, 7, 4, 6],
            ['green', 2, 2, 4, 4], ['orange', 2, 4, 3, 3], ['purple', 2, 6, 3, 7],
            ['navy', 4, 3, 6, 2], ['blue', 4, 7, 6, 6], ['yellow', 5, 2, 5, 4],
            ['white', 6, 7, 7, 4],
        ]),
        level('hard', 4, 7, 7, [
            ['green', 0, 6, 2, 5], ['orange', 1, 1, 5, 2], ['yellow', 1, 4, 5, 5],
            ['blue', 2, 0, 3, 4], ['coral', 4, 1, 6, 0], ['purple', 4, 4, 4, 6],
        ]),
        level('hard', 5, 9, 8, [
            ['green', 0, 3, 1, 0], ['navy', 1, 2, 3, 0], ['white', 1, 5, 3, 6],
            ['orange', 2, 4, 4, 4], ['purple', 3, 4, 6, 4], ['yellow', 4, 0, 7, 2],
            ['cyan', 4, 2, 6, 3], ['maroon', 4, 6, 5, 5], ['mint', 5, 1, 8, 7],
            ['coral', 6, 5, 8, 4], ['blue', 7, 0, 8, 2], ['pink', 7, 5, 8, 3],
        ]),
        level('hard', 6, 8, 7, [
            ['coral', 0, 2, 4, 4], ['orange', 0, 3, 2, 2], ['green', 1, 2, 5, 4],
            ['purple', 1, 5, 3, 5], ['blue', 3, 2, 4, 3], ['yellow', 4, 5, 6, 5],
            ['cyan', 5, 1, 6, 4],
        ]),
        level('hard', 7, 7, 7, [
            ['green', 0, 6, 6, 1], ['yellow', 1, 0, 3, 2], ['coral', 1, 4, 4, 0],
            ['orange', 3, 1, 4, 4], ['blue', 3, 3, 6, 0],
        ], '困難 第 8 關'),
        level('hard', 8, 9, 8, [
            ['cyan', 0, 1, 5, 0], ['mint', 0, 2, 1, 4], ['yellow', 0, 5, 4, 3],
            ['white', 1, 3, 3, 2], ['orange', 1, 5, 2, 6], ['maroon', 2, 2, 3, 5],
            ['purple', 3, 3, 5, 2], ['navy', 3, 6, 4, 5], ['blue', 5, 5, 6, 2],
            ['green', 5, 6, 7, 4], ['coral', 6, 0, 8, 2],
        ], '困難 第 9 關'),
        level('hard', 9, 10, 9, [
            ['green', 0, 4, 1, 5], ['olive', 0, 6, 4, 7], ['blue', 1, 2, 4, 1],
            ['orange', 1, 6, 3, 5], ['mint', 2, 3, 3, 2], ['yellow', 2, 6, 3, 0],
            ['gray', 3, 4, 4, 6], ['navy', 4, 0, 8, 3], ['white', 4, 2, 8, 4],
            ['maroon', 4, 5, 5, 4], ['purple', 5, 7, 6, 8], ['pink', 6, 0, 7, 8],
            ['cyan', 6, 6, 8, 6], ['coral', 7, 6, 8, 5],
        ], '困難 第 10 關'),
        level('hard', 10, 11, 11, [
            ['blue', 0, 5, 4, 0], ['purple', 1, 5, 2, 1], ['mint', 1, 6, 4, 10],
            ['navy', 1, 7, 5, 10], ['orange', 2, 4, 4, 1], ['pink', 3, 7, 4, 6],
            ['white', 4, 5, 6, 7], ['green', 4, 7, 10, 2], ['maroon', 5, 3, 7, 4],
            ['yellow', 5, 5, 6, 2], ['olive', 6, 9, 9, 7], ['magenta', 6, 10, 10, 4],
            ['gray', 8, 8, 9, 6], ['cyan', 6, 1, 9, 2], ['coral', 9, 5, 10, 3],
        ], '超難 第 1 關'),
    ]),
});

export function getColorConnectLevels(difficulty: ColorConnectDifficulty): readonly ColorConnectLevelDefinition[] {
    return COLOR_CONNECT_LEVELS[difficulty];
}

export function getColorConnectLevel(
    difficulty: ColorConnectDifficulty,
    levelNumber: number,
): ColorConnectLevelDefinition {
    const levels = getColorConnectLevels(difficulty);
    const index = Math.max(0, Math.min(levels.length - 1, Math.trunc(levelNumber) - 1));
    return levels[index];
}
