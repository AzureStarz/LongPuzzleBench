/**
 * Independent level catalogue for the screenshot-matched game 《螺帽与螺栓》.
 *
 * Authoring coordinates use the 430×932 logical resolution of the supplied
 * 1290×2796 screenshots. `screenX` is the bolt centre and `baseBottomY` is the
 * lower edge of its silver base. Nut arrays are always bottom -> top.
 */

export type NutsBoltsDifficulty = 'easy' | 'medium' | 'hard' | 'extreme' | 'nightmare';

export type NutColorId =
    | 'yellow'
    | 'red'
    | 'blue'
    | 'green'
    | 'orange'
    | 'pink'
    | 'cyan'
    | 'purple'
    | 'lime'
    | 'brown'
    | 'teal'
    | 'indigo'
    | 'silver'
    | 'charcoal'
    | 'peach';

export type NutsBoltsVisualSize = 'large' | 'regular' | 'compact';

export interface NutsBoltsBoltData {
    screenX: number;
    baseBottomY: number;
    /** Bottom -> top. Empty arrays are the two playable spare bolts. */
    nuts: NutColorId[];
}

export interface NutsBoltsLevelData {
    id: string;
    difficulty: NutsBoltsDifficulty;
    difficultyLabel: string;
    levelNumber: number;
    capacity: number;
    visualSize: NutsBoltsVisualSize;
    /** Vertical nut pitch in screenshot logical pixels. */
    nutStep: number;
    /** Bolt-cap centre above the base bottom before `(capacity - 1) * nutStep`. */
    capBaseOffset: number;
    bolts: NutsBoltsBoltData[];
    /** Relative source screenshot used while authoring and reviewing. */
    source: string;
}

export const NUTS_BOLTS_DIFFICULTY_LABELS: Record<NutsBoltsDifficulty, string> = {
    easy: '簡單',
    medium: '中等',
    hard: '困難',
    extreme: '超難',
    nightmare: '超難',
};

const bolt = (screenX: number, baseBottomY: number, nuts: NutColorId[] = []): NutsBoltsBoltData => ({
    screenX,
    baseBottomY,
    nuts,
});

// The screenshots also contain one dark, short decorative bolt near the last
// row. It is intentionally omitted from every level below.
export const NUTS_BOLTS_EASY_LEVELS: NutsBoltsLevelData[] = [
    {
        id: 'nuts_bolts_easy_1', difficulty: 'easy', difficultyLabel: '簡單', levelNumber: 1,
        capacity: 4, visualSize: 'large', nutStep: 25, capBaseOffset: 49,
        source: '简单关卡/1.png',
        bolts: [
            bolt(151, 426, ['red', 'red', 'red', 'yellow']),
            bolt(278, 426, ['yellow', 'red', 'yellow', 'yellow']),
            bolt(103, 649),
            bolt(214.5, 649),
        ],
    },
    {
        id: 'nuts_bolts_easy_2', difficulty: 'easy', difficultyLabel: '簡單', levelNumber: 2,
        capacity: 3, visualSize: 'large', nutStep: 25, capBaseOffset: 49.6,
        source: '简单关卡/2.png',
        bolts: [
            bolt(103, 413, ['red', 'blue', 'blue']),
            bolt(214.5, 413, ['yellow', 'red', 'blue']),
            bolt(326, 413, ['yellow', 'yellow', 'red']),
            bolt(103, 636),
            bolt(214.5, 636),
        ],
    },
    {
        id: 'nuts_bolts_easy_3', difficulty: 'easy', difficultyLabel: '簡單', levelNumber: 3,
        capacity: 3, visualSize: 'large', nutStep: 25, capBaseOffset: 49.6,
        source: '简单关卡/3.png',
        bolts: [
            bolt(103, 413, ['blue', 'green', 'green']),
            bolt(214.5, 413, ['blue', 'blue', 'red']),
            bolt(326, 413, ['yellow', 'red', 'red']),
            bolt(71, 636, ['yellow', 'yellow', 'green']),
            bolt(166.5, 636),
            bolt(262.5, 636),
        ],
    },
];

export const NUTS_BOLTS_MEDIUM_LEVELS: NutsBoltsLevelData[] = [
    {
        id: 'nuts_bolts_medium_1', difficulty: 'medium', difficultyLabel: '中等', levelNumber: 1,
        capacity: 4, visualSize: 'regular', nutStep: 24, capBaseOffset: 45.7,
        source: '中等关卡/1.png',
        bolts: [
            bolt(71, 425, ['blue', 'red', 'orange', 'pink']),
            bolt(167, 425, ['red', 'pink', 'blue', 'orange']),
            bolt(262, 425, ['red', 'green', 'blue', 'pink']),
            bolt(358, 425, ['yellow', 'green', 'green', 'pink']),
            bolt(55, 647, ['yellow', 'blue', 'yellow', 'green']),
            bolt(135, 647, ['yellow', 'red', 'orange', 'orange']),
            bolt(214.5, 647),
            bolt(294, 647),
        ],
    },
    {
        id: 'nuts_bolts_medium_2', difficulty: 'medium', difficultyLabel: '中等', levelNumber: 2,
        capacity: 5, visualSize: 'large', nutStep: 24, capBaseOffset: 52.5,
        source: '中等关卡/2.png',
        bolts: [
            bolt(71, 439, ['orange', 'green', 'blue', 'blue', 'blue']),
            bolt(167, 439, ['orange', 'yellow', 'orange', 'red', 'red']),
            bolt(262.5, 439, ['green', 'blue', 'red', 'blue', 'orange']),
            bolt(358, 439, ['green', 'yellow', 'red', 'yellow', 'green']),
            bolt(71, 662, ['yellow', 'orange', 'red', 'yellow', 'green']),
            bolt(166.5, 662),
            bolt(262.5, 662),
        ],
    },
    {
        id: 'nuts_bolts_medium_3', difficulty: 'medium', difficultyLabel: '中等', levelNumber: 3,
        capacity: 3, visualSize: 'regular', nutStep: 24, capBaseOffset: 46.5,
        source: '中等关卡/3.png',
        bolts: [
            bolt(55, 412, ['cyan', 'green', 'blue']),
            bolt(135, 412, ['orange', 'pink', 'cyan']),
            bolt(214.5, 412, ['orange', 'green', 'pink']),
            bolt(294, 412, ['blue', 'orange', 'yellow']),
            bolt(374, 412, ['red', 'blue', 'red']),
            bolt(55, 635, ['yellow', 'pink', 'green']),
            bolt(135, 635, ['yellow', 'red', 'cyan']),
            bolt(214.5, 635),
            bolt(294, 635),
        ],
    },
];

export const NUTS_BOLTS_HARD_LEVELS: NutsBoltsLevelData[] = [
    {
        id: 'nuts_bolts_hard_1', difficulty: 'hard', difficultyLabel: '困難', levelNumber: 1,
        capacity: 4, visualSize: 'regular', nutStep: 24, capBaseOffset: 45.8,
        source: '困难关卡/1.png',
        bolts: [
            bolt(71, 321, ['teal', 'purple', 'yellow', 'blue']),
            bolt(167, 321, ['purple', 'lime', 'yellow', 'yellow']),
            bolt(262, 321, ['lime', 'brown', 'teal', 'orange']),
            bolt(358, 321, ['lime', 'red', 'green', 'orange']),
            bolt(55, 520, ['brown', 'cyan', 'cyan', 'orange']),
            bolt(135, 520, ['cyan', 'pink', 'red', 'red']),
            bolt(214.5, 520, ['pink', 'teal', 'pink', 'brown']),
            bolt(294, 520, ['orange', 'lime', 'purple', 'brown']),
            bolt(374, 520, ['green', 'blue', 'yellow', 'blue']),
            bolt(55, 719, ['blue', 'green', 'green', 'teal']),
            bolt(135, 719, ['red', 'purple', 'cyan', 'pink']),
            bolt(214.5, 719),
            bolt(294, 719),
        ],
    },
    {
        id: 'nuts_bolts_hard_2', difficulty: 'hard', difficultyLabel: '困難', levelNumber: 2,
        capacity: 8, visualSize: 'regular', nutStep: 23, capBaseOffset: 47.3,
        source: '困难关卡/2.png',
        bolts: [
            bolt(55, 445, ['cyan', 'green', 'green', 'orange', 'orange', 'yellow', 'pink', 'cyan']),
            bolt(135, 445, ['orange', 'orange', 'blue', 'cyan', 'red', 'pink', 'green', 'pink']),
            bolt(214.5, 445, ['orange', 'red', 'red', 'green', 'yellow', 'pink', 'blue', 'orange']),
            bolt(294, 445, ['blue', 'pink', 'green', 'red', 'cyan', 'yellow', 'yellow', 'blue']),
            bolt(374, 445, ['blue', 'blue', 'green', 'pink', 'cyan', 'cyan', 'orange', 'yellow']),
            bolt(55, 700, ['red', 'cyan', 'cyan', 'blue', 'red', 'blue', 'orange', 'pink']),
            bolt(135, 700, ['yellow', 'green', 'pink', 'red', 'red', 'green', 'yellow', 'yellow']),
            bolt(214.5, 700),
            bolt(294, 700),
        ],
    },
    {
        id: 'nuts_bolts_hard_3', difficulty: 'hard', difficultyLabel: '困難', levelNumber: 3,
        capacity: 6, visualSize: 'compact', nutStep: 20, capBaseOffset: 43.8,
        source: '困难关卡/3.png',
        bolts: [
            bolt(39.5, 447, ['lime', 'orange', 'red', 'red', 'red', 'pink']),
            bolt(109.5, 447, ['cyan', 'cyan', 'yellow', 'green', 'green', 'cyan']),
            bolt(179.5, 447, ['pink', 'orange', 'blue', 'brown', 'red', 'lime']),
            bolt(249.5, 447, ['orange', 'pink', 'brown', 'orange', 'blue', 'orange']),
            bolt(319.5, 447, ['blue', 'red', 'cyan', 'green', 'brown', 'brown']),
            bolt(389.5, 447, ['blue', 'yellow', 'yellow', 'cyan', 'cyan', 'green']),
            bolt(39.5, 670, ['yellow', 'pink', 'lime', 'lime', 'lime', 'lime']),
            bolt(109.5, 670, ['yellow', 'blue', 'blue', 'orange', 'brown', 'green']),
            bolt(179.5, 670, ['yellow', 'red', 'pink', 'pink', 'green', 'brown']),
            bolt(249.5, 670),
            bolt(319.5, 670),
        ],
    },
];

export const NUTS_BOLTS_EXTREME_LEVELS: NutsBoltsLevelData[] = [
    {
        id: 'nuts_bolts_extreme_1', difficulty: 'extreme', difficultyLabel: '超難', levelNumber: 1,
        capacity: 4, visualSize: 'compact', nutStep: 20, capBaseOffset: 43.4,
        source: '巨难关卡/1.png',
        bolts: [
            bolt(55, 318, ['indigo', 'green', 'green', 'yellow']),
            bolt(135, 318, ['silver', 'purple', 'lime', 'indigo']),
            bolt(214.5, 318, ['teal', 'teal', 'orange', 'brown']),
            bolt(294, 318, ['teal', 'blue', 'indigo', 'red']),
            bolt(374, 318, ['brown', 'lime', 'purple', 'blue']),
            bolt(55, 517, ['cyan', 'silver', 'cyan', 'silver']),
            bolt(135, 517, ['pink', 'cyan', 'orange', 'yellow']),
            bolt(214.5, 517, ['pink', 'orange', 'purple', 'yellow']),
            bolt(294, 517, ['orange', 'lime', 'blue', 'brown']),
            bolt(374, 517, ['green', 'lime', 'red', 'teal']),
            bolt(39.5, 716, ['blue', 'silver', 'purple', 'green']),
            bolt(109.5, 716, ['red', 'indigo', 'brown', 'pink']),
            bolt(179.5, 716, ['red', 'pink', 'yellow', 'cyan']),
            bolt(249.5, 716),
            bolt(319.5, 716),
        ],
    },
    {
        id: 'nuts_bolts_extreme_2', difficulty: 'extreme', difficultyLabel: '超難', levelNumber: 2,
        capacity: 3, visualSize: 'compact', nutStep: 20, capBaseOffset: 43,
        source: '巨难关卡/2.png',
        bolts: [
            bolt(39.5, 305, ['charcoal', 'teal', 'purple']),
            bolt(109.5, 305, ['charcoal', 'pink', 'charcoal']),
            bolt(179.5, 305, ['peach', 'lime', 'red']),
            bolt(249.5, 305, ['peach', 'brown', 'brown']),
            bolt(319.5, 305, ['peach', 'orange', 'brown']),
            bolt(389.5, 305, ['silver', 'orange', 'indigo']),
            bolt(39.5, 504, ['teal', 'cyan', 'indigo']),
            bolt(109.5, 504, ['lime', 'pink', 'green']),
            bolt(179.5, 504, ['lime', 'blue', 'red']),
            bolt(249.5, 504, ['cyan', 'blue', 'yellow']),
            bolt(319.5, 504, ['pink', 'yellow', 'indigo']),
            bolt(389.5, 504, ['orange', 'silver', 'green']),
            bolt(39.5, 703, ['green', 'teal', 'purple']),
            bolt(109.5, 703, ['blue', 'red', 'cyan']),
            bolt(179.5, 703, ['yellow', 'purple', 'silver']),
            bolt(249.5, 703),
            bolt(319.5, 703),
        ],
    },
    {
        id: 'nuts_bolts_extreme_3', difficulty: 'extreme', difficultyLabel: '超難', levelNumber: 3,
        capacity: 5, visualSize: 'regular', nutStep: 24, capBaseOffset: 44.3,
        source: '巨难关卡/3.png',
        bolts: [
            bolt(55, 334, ['silver', 'orange', 'silver', 'cyan', 'cyan']),
            bolt(135, 334, ['teal', 'teal', 'purple', 'yellow', 'teal']),
            bolt(214.5, 334, ['purple', 'purple', 'pink', 'blue', 'purple']),
            bolt(294, 334, ['brown', 'cyan', 'lime', 'teal', 'brown']),
            bolt(374, 334, ['brown', 'red', 'yellow', 'purple', 'blue']),
            bolt(55, 533, ['pink', 'red', 'orange', 'green', 'lime']),
            bolt(135, 533, ['orange', 'silver', 'lime', 'brown', 'cyan']),
            bolt(214.5, 533, ['green', 'lime', 'teal', 'orange', 'pink']),
            bolt(294, 533, ['green', 'brown', 'pink', 'orange', 'blue']),
            bolt(374, 533, ['green', 'red', 'silver', 'yellow', 'silver']),
            bolt(55, 732, ['yellow', 'lime', 'pink', 'cyan', 'green']),
            bolt(135, 732, ['yellow', 'red', 'blue', 'blue', 'red']),
            bolt(214.5, 732),
            bolt(294, 732),
        ],
    },
];

/**
 * The additional screenshot is stored under `极难关卡`, while the screenshot
 * itself labels the mode `超難`. Keep it as a separate additive difficulty so
 * the existing `巨难关卡` catalogue remains untouched.
 */
export const NUTS_BOLTS_NIGHTMARE_LEVELS: NutsBoltsLevelData[] = [
    {
        id: 'nuts_bolts_nightmare_1', difficulty: 'nightmare', difficultyLabel: '超難', levelNumber: 1,
        capacity: 8, visualSize: 'compact', nutStep: 21, capBaseOffset: 43,
        source: '极难关卡/1.jpg',
        bolts: [
            bolt(39.5, 445, ['brown', 'lime', 'red', 'orange', 'orange', 'red', 'red', 'red']),
            bolt(109.5, 445, ['cyan', 'cyan', 'blue', 'green', 'brown', 'orange', 'yellow', 'yellow']),
            bolt(179.5, 445, ['cyan', 'blue', 'brown', 'lime', 'lime', 'lime', 'lime', 'yellow']),
            bolt(249.5, 445, ['cyan', 'blue', 'green', 'yellow', 'pink', 'red', 'green', 'red']),
            bolt(319.5, 445, ['pink', 'brown', 'blue', 'pink', 'orange', 'green', 'blue', 'orange']),
            bolt(389.5, 445, ['green', 'brown', 'blue', 'blue', 'pink', 'yellow', 'orange', 'red']),
            bolt(39.5, 700, ['green', 'cyan', 'orange', 'pink', 'yellow', 'pink', 'lime', 'yellow']),
            bolt(109.5, 700, ['green', 'pink', 'brown', 'brown', 'pink', 'cyan', 'orange', 'yellow']),
            bolt(179.5, 700, ['blue', 'green', 'lime', 'lime', 'brown', 'cyan', 'red', 'cyan']),
            bolt(249.5, 700),
            bolt(319.5, 700),
        ],
    },
];

export const NUTS_BOLTS_LEVELS: Record<NutsBoltsDifficulty, NutsBoltsLevelData[]> = {
    easy: NUTS_BOLTS_EASY_LEVELS,
    medium: NUTS_BOLTS_MEDIUM_LEVELS,
    hard: NUTS_BOLTS_HARD_LEVELS,
    extreme: NUTS_BOLTS_EXTREME_LEVELS,
    nightmare: NUTS_BOLTS_NIGHTMARE_LEVELS,
};

export function getNutsBoltsLevels(difficulty: NutsBoltsDifficulty): NutsBoltsLevelData[] {
    return NUTS_BOLTS_LEVELS[difficulty].slice();
}

/** Throws on authoring mistakes that would make a screenshot level invalid. */
export function validateNutsBoltsLevel(level: NutsBoltsLevelData): void {
    const emptyCount = level.bolts.filter(item => item.nuts.length === 0).length;
    if (emptyCount !== 2) {
        throw new Error(`${level.id}: expected exactly two empty bolts, got ${emptyCount}`);
    }

    const counts = new Map<NutColorId, number>();
    for (const item of level.bolts) {
        if (item.nuts.length !== 0 && item.nuts.length !== level.capacity) {
            throw new Error(`${level.id}: non-empty bolt must start full`);
        }
        for (const color of item.nuts) counts.set(color, (counts.get(color) ?? 0) + 1);
    }
    for (const [color, count] of counts) {
        if (count !== level.capacity) {
            throw new Error(`${level.id}: ${color} count ${count}, expected ${level.capacity}`);
        }
    }
}
