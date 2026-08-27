export type MazePaintDifficulty = 'easy' | 'medium' | 'hard';

export interface MazePaintLevelDefinition {
    readonly id: string;
    readonly difficulty: MazePaintDifficulty;
    readonly levelNumber: number;
    /** `#` is non-playable, `.` is paintable, and `S` is the initially painted start. */
    readonly layout: readonly string[];
    /** Exact minimum number of directional slides, verified by MazePaintSolver. */
    readonly optimalMoveCount: number;
    readonly screenshot: string;
}

const SCREENSHOT_DIFFICULTY_DIR: Readonly<Record<MazePaintDifficulty, string>> = Object.freeze({
    easy: '简单',
    medium: '中等',
    hard: '困难',
});

function level(
    difficulty: MazePaintDifficulty,
    levelNumber: number,
    layout: string,
    optimalMoveCount: number,
): MazePaintLevelDefinition {
    const number = levelNumber < 10 ? `0${levelNumber}` : String(levelNumber);
    return Object.freeze({
        id: `${difficulty}_${number}`,
        difficulty,
        levelNumber,
        layout: Object.freeze(layout.split('/')),
        optimalMoveCount,
        screenshot: `${SCREENSHOT_DIFFICULTY_DIR[difficulty]}/${levelNumber}.png`,
    });
}

/**
 * Screenshot-derived topology. The screenshots render walls as cream-colored
 * empty space, so only the dark grid footprint is paintable.
 */
export const MAZE_PAINT_LEVELS: Readonly<Record<MazePaintDifficulty, readonly MazePaintLevelDefinition[]>> = Object.freeze({
    easy: Object.freeze([
        level('easy', 1, '##../##../..../S...', 7),
        level('easy', 2, '##../##../..../..../S..#', 7),
        level('easy', 3, '...#/...#/..../..../..../S.##', 8),
        level('easy', 4, '#..../...../..#../..#../S.###', 8),
        level('easy', 5, '...##/...##/...##/...##/...##/S..../#....', 8),
        level('easy', 6, '#..../...../...../..###/S...#/#...#', 10),
        level('easy', 7, '......#/......./.####../.####../.####../.####../.####../.####../S......', 7),
        level('easy', 8, '..##/..../#.../...#/..../S...', 12),
        level('easy', 9, '...##/...../...../..##./S.#..', 12),
        level('easy', 10, '....../....../####../####../.###.#/S....#', 9),
    ]),
    medium: Object.freeze([
        level('medium', 1, '#....#/#...../....../....../S....#/##...#', 13),
        level('medium', 2, '..###/...../...../....#/.##../..#../S.#..', 16),
        level('medium', 3, '...###/...###/...##./#...../....../...#../S..#..', 13),
        level('medium', 4, '.....#/.....#/#....#/...###/....../....##/....##/S...##', 14),
        level('medium', 5, '..#.../....../....../.....#/....../S..#..', 14),
        level('medium', 6, '....###/.....##/..#..##/......./......./S.....#/#....##', 15),
        level('medium', 7, '#.......##/........##/.........#/..#####..#/..#####..#/..#####.../..######../..######../..######../........../S........#', 14),
        level('medium', 8, '.#.../...#./####./#..../...#./...#./S....', 13),
        level('medium', 9, '##..../#..#../#...../....../.....#/S##..#', 13),
        level('medium', 10, '....#../....#../......./...##.#/#.###.#/..###.#/..###.#/S.....#', 15),
    ]),
    hard: Object.freeze([
        level('hard', 1, '##..###/##...../##..#../##..#../##...../#.....#/....###/..#..../#.#.##./S......', 18),
        level('hard', 2, '###...../......../#......./#.###.#./#.....#./#..#..../S......./#..##..#', 20),
        level('hard', 3, '..###..#/..###.../....#.../......../.......#/.......#/.......#/......../S..#....', 18),
        level('hard', 4, '..#...../......../......../.#....../.#..#..#/.......#/##.....#/......##/......##/.##.####/S...####', 25),
        level('hard', 5, '#..##..../#......../........./........#/##.....##/.##....../.##....#./S......../####..###', 24),
        level('hard', 6, '###...#####/###....####/.........##/.........##/.####..####/.####..####/.........../.####..#.#./.........##/.#####...../S..........', 19),
        level('hard', 7, '#....##../........./...#.#.#./.......#./........./...#....#/...#....#/S..#..#.#/#..#...../#####....', 25),
        level('hard', 8, '##..######/....######/.#..######/.#..######/........../.#..#####./........../.#..####../.#..####../.........#/.#..###.../.#..###.../S........./###.......', 23),
        level('hard', 9, '#..###../#......./......../....###./......../....##../......../S......#/###...../######..', 23),
        level('hard', 10, '.........#/.#..####.#/.#..####.#/.#..####.#/....##..../##......../#........./........../.....###../S.########', 22),
    ]),
});

export function getMazePaintLevels(difficulty: MazePaintDifficulty): readonly MazePaintLevelDefinition[] {
    return MAZE_PAINT_LEVELS[difficulty];
}

export function getMazePaintLevel(
    difficulty: MazePaintDifficulty,
    levelNumber: number,
): MazePaintLevelDefinition {
    const levels = getMazePaintLevels(difficulty);
    const index = Math.max(0, Math.min(levels.length - 1, Math.trunc(levelNumber) - 1));
    return levels[index];
}
