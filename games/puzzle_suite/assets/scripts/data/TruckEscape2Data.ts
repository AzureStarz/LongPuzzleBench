/**
 * 独立小游戏《卡车出库 2》的关卡数据。
 *
 * 坐标约定：左上角为 (0, 0)，列向右、行向下。车辆长度以格为单位，
 * 横车占用同一行的连续格，竖车占用同一列的连续格。
 */

export type TruckEscape2Difficulty = 'easy' | 'medium' | 'hard';
export type TruckEscape2Orientation = 'horizontal' | 'vertical';
export type TruckEscape2VehicleStyle = 'semi' | 'bus' | 'coupe' | 'target' | 'sedan' | 'pickup';
export type TruckEscape2VehicleColor = 'sand' | 'cream' | 'red' | 'blue' | 'white' | 'purple';

export interface TruckEscape2VehicleSpec {
    id: string;
    row: number;
    col: number;
    length: 2 | 3;
    orientation: TruckEscape2Orientation;
    style: TruckEscape2VehicleStyle;
    color: TruckEscape2VehicleColor;
    /** 仅改变车辆插画朝向，不改变它的可滑动轴。 */
    flipVisual?: boolean;
    target?: boolean;
}

export interface TruckEscape2LevelData {
    id: string;
    difficulty: TruckEscape2Difficulty;
    levelNumber: number;
    rows: 5 | 6 | 7 | 8;
    cols: 5 | 6 | 7;
    exitRow: number;
    exitSide: 'right';
    hintCount?: number;
    vehicles: TruckEscape2VehicleSpec[];
    blockers?: TruckEscape2BlockerSpec[];
}

export interface TruckEscape2BlockerSpec {
    id: string;
    row: number;
    col: number;
    style: 'bush';
}

/**
 * 简单第 1 关严格按参考图的 5×6 布局：
 *
 *   · S S S ·
 *   · · C C ·
 *   · R R B ·
 *   · · · B ·
 *   P P · W ·
 *   · · · W ·
 *
 * 一条最短解：S 左移 1 → C 左移 2 → B 上移 2 → R 右移 2。
 */
export const TRUCK_ESCAPE_2_EASY_LEVEL_1: TruckEscape2LevelData = {
    id: 'truck_escape_2_easy_1',
    difficulty: 'easy',
    levelNumber: 1,
    rows: 6,
    cols: 5,
    exitRow: 2,
    exitSide: 'right',
    hintCount: 1,
    vehicles: [
        {
            id: 'sand_semi', row: 0, col: 1, length: 3,
            orientation: 'horizontal', style: 'semi', color: 'sand', flipVisual: true,
        },
        {
            id: 'cream_coupe', row: 1, col: 2, length: 2,
            orientation: 'horizontal', style: 'coupe', color: 'cream', flipVisual: true,
        },
        {
            id: 'red_target', row: 2, col: 1, length: 2,
            orientation: 'horizontal', style: 'target', color: 'red', target: true,
        },
        {
            id: 'blue_sedan', row: 2, col: 3, length: 2,
            orientation: 'vertical', style: 'sedan', color: 'blue',
        },
        {
            id: 'sand_pickup', row: 4, col: 0, length: 2,
            orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true,
        },
        {
            id: 'white_sedan', row: 4, col: 3, length: 2,
            orientation: 'vertical', style: 'sedan', color: 'white',
        },
    ],
};

/** 简单第 2 关，来源：关卡截图/2.png（5×5）。 */
export const TRUCK_ESCAPE_2_EASY_LEVEL_2: TruckEscape2LevelData = {
    id: 'truck_escape_2_easy_2', difficulty: 'easy', levelNumber: 2,
    rows: 5, cols: 5, exitRow: 2, exitSide: 'right', hintCount: 1,
    vehicles: [
        { id: 'e2_red_target', row: 2, col: 0, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
        { id: 'e2_blue_left', row: 1, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
        { id: 'e2_white_top', row: 0, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
        { id: 'e2_white_middle', row: 2, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
        { id: 'e2_blue_right', row: 1, col: 4, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
        { id: 'e2_white_bottom', row: 4, col: 2, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white', flipVisual: true },
    ],
};

/** 简单第 3 关，来源：关卡截图/3.png（6×6）。 */
export const TRUCK_ESCAPE_2_EASY_LEVEL_3: TruckEscape2LevelData = {
    id: 'truck_escape_2_easy_3', difficulty: 'easy', levelNumber: 3,
    rows: 6, cols: 6, exitRow: 2, exitSide: 'right', hintCount: 1,
    vehicles: [
        { id: 'e3_white_left', row: 0, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
        { id: 'e3_purple_top', row: 0, col: 2, length: 3, orientation: 'horizontal', style: 'semi', color: 'purple' },
        { id: 'e3_sand_pickup', row: 1, col: 4, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
        { id: 'e3_red_target', row: 2, col: 1, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
        { id: 'e3_blue_middle', row: 2, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
        { id: 'e3_purple_bus', row: 3, col: 0, length: 3, orientation: 'vertical', style: 'bus', color: 'purple', flipVisual: true },
    ],
    blockers: [{ id: 'e3_bush', row: 4, col: 3, style: 'bush' }],
};

/** 简单第 4 关，来源：关卡截图/4.png（5×5）。 */
export const TRUCK_ESCAPE_2_EASY_LEVEL_4: TruckEscape2LevelData = {
    id: 'truck_escape_2_easy_4', difficulty: 'easy', levelNumber: 4,
    rows: 5, cols: 5, exitRow: 2, exitSide: 'right', hintCount: 1,
    vehicles: [
        { id: 'e4_blue_left_top', row: 1, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
        { id: 'e4_blue_left_bottom', row: 3, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
        { id: 'e4_white_top_left', row: 0, col: 1, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
        { id: 'e4_white_mid_left', row: 2, col: 1, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
        { id: 'e4_red_target', row: 2, col: 2, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
        { id: 'e4_white_top_right', row: 0, col: 4, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
        { id: 'e4_white_mid_right', row: 2, col: 4, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
        { id: 'e4_pickup_left', row: 4, col: 1, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
        { id: 'e4_pickup_right', row: 4, col: 3, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
    ],
};

/** 简单第 5 关，来源：关卡截图/5.png（5×6）。 */
export const TRUCK_ESCAPE_2_EASY_LEVEL_5: TruckEscape2LevelData = {
    id: 'truck_escape_2_easy_5', difficulty: 'easy', levelNumber: 5,
    rows: 6, cols: 5, exitRow: 2, exitSide: 'right', hintCount: 2,
    vehicles: [
        { id: 'e5_red_target', row: 2, col: 1, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
        { id: 'e5_purple_gate', row: 1, col: 3, length: 3, orientation: 'vertical', style: 'semi', color: 'purple', flipVisual: true },
        { id: 'e5_white_right', row: 1, col: 4, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
        { id: 'e5_sand_pickup', row: 4, col: 2, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true },
        { id: 'e5_sand_bottom', row: 5, col: 1, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand' },
    ],
};

/** 简单第 6 关，来源：关卡截图/6.png（5×5）。 */
export const TRUCK_ESCAPE_2_EASY_LEVEL_6: TruckEscape2LevelData = {
    id: 'truck_escape_2_easy_6', difficulty: 'easy', levelNumber: 6,
    rows: 5, cols: 5, exitRow: 2, exitSide: 'right', hintCount: 2,
    vehicles: [
        { id: 'e6_white_top', row: 0, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
        { id: 'e6_white_coupe', row: 0, col: 3, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white', flipVisual: true },
        { id: 'e6_red_target', row: 2, col: 1, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
        { id: 'e6_blue_top', row: 1, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
        { id: 'e6_blue_bottom', row: 3, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
    ],
    blockers: [{ id: 'e6_bush', row: 4, col: 2, style: 'bush' }],
};

/** 简单第 7 关，来源：关卡截图/7.png（5×6）。 */
export const TRUCK_ESCAPE_2_EASY_LEVEL_7: TruckEscape2LevelData = {
    id: 'truck_escape_2_easy_7', difficulty: 'easy', levelNumber: 7,
    rows: 6, cols: 5, exitRow: 2, exitSide: 'right', hintCount: 2,
    vehicles: [
        { id: 'e7_red_target', row: 2, col: 1, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
        { id: 'e7_bus_right', row: 0, col: 4, length: 3, orientation: 'vertical', style: 'bus', color: 'sand' },
        { id: 'e7_bus_bottom', row: 3, col: 2, length: 3, orientation: 'vertical', style: 'bus', color: 'sand', flipVisual: true },
        { id: 'e7_pickup', row: 3, col: 3, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true },
    ],
};

/** 简单第 8 关，来源：关卡截图/8.png（6×6）。 */
export const TRUCK_ESCAPE_2_EASY_LEVEL_8: TruckEscape2LevelData = {
    id: 'truck_escape_2_easy_8', difficulty: 'easy', levelNumber: 8,
    rows: 6, cols: 6, exitRow: 2, exitSide: 'right', hintCount: 2,
    vehicles: [
        { id: 'e8_purple_left_semi', row: 0, col: 0, length: 3, orientation: 'vertical', style: 'semi', color: 'purple' },
        { id: 'e8_purple_left_bus', row: 0, col: 1, length: 3, orientation: 'vertical', style: 'bus', color: 'purple', flipVisual: true },
        { id: 'e8_pickup_top_left', row: 0, col: 2, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
        { id: 'e8_pickup_top_right', row: 0, col: 4, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true },
        { id: 'e8_purple_top', row: 1, col: 2, length: 3, orientation: 'horizontal', style: 'semi', color: 'purple' },
        { id: 'e8_white_right', row: 1, col: 5, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
        { id: 'e8_blue_middle', row: 2, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
        { id: 'e8_red_target', row: 2, col: 3, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
        { id: 'e8_purple_right', row: 3, col: 5, length: 3, orientation: 'vertical', style: 'semi', color: 'purple' },
        { id: 'e8_sand_bottom', row: 4, col: 0, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand', flipVisual: true },
        { id: 'e8_white_bottom', row: 4, col: 3, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white', flipVisual: true },
        { id: 'e8_cream_bottom', row: 5, col: 0, length: 2, orientation: 'horizontal', style: 'coupe', color: 'cream', flipVisual: true },
    ],
};

/** 简单第 9 关，来源：关卡截图/9.png（5×6）。 */
export const TRUCK_ESCAPE_2_EASY_LEVEL_9: TruckEscape2LevelData = {
    id: 'truck_escape_2_easy_9', difficulty: 'easy', levelNumber: 9,
    rows: 6, cols: 5, exitRow: 2, exitSide: 'right', hintCount: 2,
    vehicles: [
        { id: 'e9_blue_top', row: 0, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
        { id: 'e9_white_coupe', row: 0, col: 3, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white', flipVisual: true },
        { id: 'e9_red_target', row: 2, col: 1, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
        { id: 'e9_white_middle', row: 1, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
        { id: 'e9_purple_bus', row: 3, col: 3, length: 3, orientation: 'vertical', style: 'bus', color: 'purple', flipVisual: true },
        { id: 'e9_sand_bottom', row: 5, col: 0, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand', flipVisual: true },
    ],
    blockers: [{ id: 'e9_bush', row: 4, col: 2, style: 'bush' }],
};

/** 简单第 10 关，来源：关卡截图/10.png（6×6）。 */
export const TRUCK_ESCAPE_2_EASY_LEVEL_10: TruckEscape2LevelData = {
    id: 'truck_escape_2_easy_10', difficulty: 'easy', levelNumber: 10,
    rows: 6, cols: 6, exitRow: 2, exitSide: 'right', hintCount: 3,
    vehicles: [
        { id: 'e10_purple_top', row: 0, col: 3, length: 3, orientation: 'horizontal', style: 'semi', color: 'purple' },
        { id: 'e10_sand_pickup', row: 1, col: 0, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
        { id: 'e10_red_target', row: 2, col: 0, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
        { id: 'e10_purple_middle', row: 2, col: 2, length: 2, orientation: 'vertical', style: 'semi', color: 'purple', flipVisual: true },
        { id: 'e10_white_right', row: 1, col: 5, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
        { id: 'e10_cream_right', row: 3, col: 4, length: 2, orientation: 'horizontal', style: 'coupe', color: 'cream', flipVisual: true },
        { id: 'e10_white_pickup', row: 4, col: 1, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white', flipVisual: true },
        { id: 'e10_purple_bottom', row: 4, col: 3, length: 3, orientation: 'horizontal', style: 'semi', color: 'purple' },
    ],
};

/**
 * 困难模式关卡（catalog v2 产品重分类），几何来源：原“中等难度关卡截图”集。
 * 原图顶部标识 EXTRA HARD；verified-optimal BFS depth 为 7–15 步（均值 11.9）。
 */
export const TRUCK_ESCAPE_2_HARD_LEVELS: TruckEscape2LevelData[] = [
    {
        id: 'truck_escape_2_hard_1', difficulty: 'hard', levelNumber: 1,
        rows: 6, cols: 5, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'm1_blue_top', row: 0, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm1_red_target', row: 2, col: 0, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'm1_blue_middle', row: 2, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm1_sand_bus', row: 2, col: 3, length: 3, orientation: 'vertical', style: 'bus', color: 'sand' },
            { id: 'm1_white_coupe', row: 3, col: 0, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white', flipVisual: true },
            { id: 'm1_blue_left', row: 4, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm1_sand_pickup', row: 4, col: 1, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true },
        ],
    },
    {
        id: 'truck_escape_2_hard_2', difficulty: 'hard', levelNumber: 2,
        rows: 6, cols: 6, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'm2_cream_coupe', row: 1, col: 0, length: 2, orientation: 'horizontal', style: 'coupe', color: 'cream' },
            { id: 'm2_white_pickup_top', row: 1, col: 3, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white', flipVisual: true },
            { id: 'm2_purple_bus', row: 0, col: 5, length: 3, orientation: 'vertical', style: 'bus', color: 'purple' },
            { id: 'm2_red_target', row: 2, col: 2, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'm2_blue_middle', row: 3, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm2_white_coupe', row: 3, col: 4, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white', flipVisual: true },
            { id: 'm2_sand_pickup', row: 4, col: 4, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
            { id: 'm2_cream_bottom', row: 5, col: 0, length: 2, orientation: 'horizontal', style: 'coupe', color: 'cream' },
            { id: 'm2_white_pickup_bottom', row: 5, col: 3, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white' },
        ],
    },
    {
        id: 'truck_escape_2_hard_3', difficulty: 'hard', levelNumber: 3,
        rows: 7, cols: 6, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'm3_blue_top_left', row: 0, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm3_blue_top_right', row: 0, col: 4, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm3_sand_bus_left', row: 2, col: 0, length: 3, orientation: 'vertical', style: 'bus', color: 'sand', flipVisual: true },
            { id: 'm3_sand_pickup', row: 2, col: 1, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true },
            { id: 'm3_red_target', row: 2, col: 3, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'm3_sand_bus_right', row: 1, col: 5, length: 3, orientation: 'vertical', style: 'bus', color: 'sand' },
            { id: 'm3_sand_semi_middle', row: 3, col: 2, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand', flipVisual: true },
            { id: 'm3_blue_bottom', row: 4, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm3_sand_semi_bottom', row: 4, col: 3, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand' },
            { id: 'm3_white_bottom_left', row: 5, col: 0, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white' },
            { id: 'm3_white_bottom_right', row: 5, col: 4, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white' },
        ],
        blockers: [{ id: 'm3_bush', row: 6, col: 2, style: 'bush' }],
    },
    {
        id: 'truck_escape_2_hard_4', difficulty: 'hard', levelNumber: 4,
        rows: 6, cols: 5, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'm4_sand_pickup_top', row: 0, col: 1, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true },
            { id: 'm4_sand_bus', row: 0, col: 4, length: 3, orientation: 'vertical', style: 'bus', color: 'sand' },
            { id: 'm4_white_left_top', row: 1, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm4_white_right_top', row: 1, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm4_red_target', row: 2, col: 0, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'm4_white_left_bottom', row: 3, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm4_pickup_right_top', row: 3, col: 3, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
            { id: 'm4_pickup_right_bottom', row: 4, col: 3, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
            { id: 'm4_pickup_bottom_left', row: 5, col: 0, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true },
            { id: 'm4_pickup_bottom_right', row: 5, col: 2, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
        ],
    },
    {
        id: 'truck_escape_2_hard_5', difficulty: 'hard', levelNumber: 5,
        rows: 6, cols: 6, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'm5_white_pickup_left', row: 0, col: 0, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white' },
            { id: 'm5_white_pickup_right', row: 0, col: 2, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white' },
            { id: 'm5_sand_bus', row: 0, col: 4, length: 3, orientation: 'vertical', style: 'bus', color: 'sand', flipVisual: true },
            { id: 'm5_red_target', row: 2, col: 1, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'm5_white_middle', row: 2, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm5_blue_left', row: 3, col: 1, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm5_white_coupe', row: 3, col: 4, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white', flipVisual: true },
            { id: 'm5_sand_semi', row: 4, col: 2, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand', flipVisual: true },
            { id: 'm5_sand_pickup', row: 5, col: 3, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
        ],
    },
    {
        id: 'truck_escape_2_hard_6', difficulty: 'hard', levelNumber: 6,
        rows: 6, cols: 5, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'm6_white_top', row: 0, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm6_blue_right', row: 1, col: 4, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm6_red_target', row: 2, col: 0, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'm6_blue_middle', row: 2, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm6_blue_left', row: 3, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm6_white_coupe_middle', row: 3, col: 1, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white', flipVisual: true },
            { id: 'm6_white_bottom', row: 4, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm6_sand_pickup', row: 4, col: 3, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
            { id: 'm6_white_coupe_bottom', row: 5, col: 0, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white' },
        ],
        blockers: [{ id: 'm6_bush', row: 0, col: 0, style: 'bush' }],
    },
    {
        id: 'truck_escape_2_hard_7', difficulty: 'hard', levelNumber: 7,
        rows: 7, cols: 7, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'm7_cream_coupe', row: 0, col: 0, length: 2, orientation: 'horizontal', style: 'coupe', color: 'cream' },
            { id: 'm7_sand_semi', row: 0, col: 2, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand' },
            { id: 'm7_white_top', row: 0, col: 5, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm7_sand_bus', row: 1, col: 2, length: 3, orientation: 'vertical', style: 'bus', color: 'sand' },
            { id: 'm7_red_target', row: 2, col: 0, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'm7_blue_left', row: 3, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm7_sand_pickup', row: 3, col: 4, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true },
            { id: 'm7_white_pickup', row: 4, col: 2, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white' },
            { id: 'm7_white_bottom', row: 4, col: 4, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm7_purple_semi', row: 5, col: 0, length: 3, orientation: 'horizontal', style: 'semi', color: 'purple' },
        ],
    },
    {
        id: 'truck_escape_2_hard_8', difficulty: 'hard', levelNumber: 8,
        rows: 5, cols: 5, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'm8_blue_top', row: 0, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm8_white_top', row: 1, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm8_blue_right', row: 1, col: 4, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm8_red_target', row: 2, col: 0, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'm8_blue_middle', row: 2, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm8_blue_left', row: 3, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm8_white_left', row: 3, col: 1, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm8_white_right', row: 3, col: 4, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm8_sand_pickup', row: 4, col: 2, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
        ],
    },
    {
        id: 'truck_escape_2_hard_9', difficulty: 'hard', levelNumber: 9,
        rows: 6, cols: 6, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'm9_blue_top_left', row: 0, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm9_blue_top_right', row: 0, col: 1, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm9_sand_pickup', row: 1, col: 3, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true },
            { id: 'm9_red_target', row: 2, col: 0, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'm9_purple_bus', row: 2, col: 2, length: 3, orientation: 'vertical', style: 'bus', color: 'purple' },
            { id: 'm9_white_middle', row: 2, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm9_blue_right', row: 2, col: 5, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'm9_white_bottom', row: 4, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm9_blue_bottom', row: 4, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
        ],
        blockers: [{ id: 'm9_bush', row: 4, col: 5, style: 'bush' }],
    },
    {
        id: 'truck_escape_2_hard_10', difficulty: 'hard', levelNumber: 10,
        rows: 6, cols: 5, exitRow: 2, exitSide: 'right', hintCount: 2,
        vehicles: [
            { id: 'm10_purple_left', row: 1, col: 2, length: 3, orientation: 'vertical', style: 'bus', color: 'purple' },
            { id: 'm10_purple_right', row: 1, col: 4, length: 3, orientation: 'vertical', style: 'bus', color: 'purple' },
            { id: 'm10_red_target', row: 2, col: 0, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'm10_sand_pickup', row: 3, col: 0, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
            { id: 'm10_white_left', row: 4, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'm10_white_pickup', row: 5, col: 2, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white' },
        ],
    },
];

/**
 * 中等模式关卡（catalog v2 产品重分类），几何来源：原“困难难度关卡截图”集。
 * 原图顶部标识 ULTRA HARD；verified-optimal BFS depth 为 3–10 步（均值 5.0）。
 */
export const TRUCK_ESCAPE_2_MEDIUM_LEVELS: TruckEscape2LevelData[] = [
    {
        id: 'truck_escape_2_medium_1', difficulty: 'medium', levelNumber: 1,
        rows: 7, cols: 7, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'h1_sand_top', row: 0, col: 2, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand', flipVisual: true },
            { id: 'h1_purple_bus', row: 2, col: 0, length: 3, orientation: 'vertical', style: 'bus', color: 'purple' },
            { id: 'h1_red_target', row: 2, col: 1, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'h1_sand_bus', row: 1, col: 5, length: 3, orientation: 'vertical', style: 'bus', color: 'sand' },
            { id: 'h1_sand_middle', row: 3, col: 1, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand', flipVisual: true },
            { id: 'h1_blue_bottom', row: 5, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h1_white_bottom', row: 5, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h1_cream_coupe', row: 5, col: 5, length: 2, orientation: 'horizontal', style: 'coupe', color: 'cream' },
        ],
    },
    {
        id: 'truck_escape_2_medium_2', difficulty: 'medium', levelNumber: 2,
        rows: 8, cols: 7, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'h2_white_top', row: 0, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h2_white_coupe', row: 0, col: 5, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white', flipVisual: true },
            { id: 'h2_blue_left', row: 1, col: 1, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h2_white_pickup_top', row: 1, col: 3, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white', flipVisual: true },
            { id: 'h2_blue_right', row: 1, col: 6, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h2_red_target', row: 2, col: 2, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'h2_white_middle', row: 2, col: 5, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h2_white_right', row: 4, col: 6, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h2_sand_pickup', row: 5, col: 0, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true },
            { id: 'h2_sand_middle', row: 5, col: 2, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand' },
            { id: 'h2_white_bottom', row: 6, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h2_white_pickup_bottom', row: 6, col: 1, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white', flipVisual: true },
            { id: 'h2_sand_right', row: 6, col: 4, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand', flipVisual: true },
            { id: 'h2_sand_bottom', row: 7, col: 1, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand', flipVisual: true },
        ],
    },
    {
        id: 'truck_escape_2_medium_3', difficulty: 'medium', levelNumber: 3,
        rows: 8, cols: 7, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'h3_purple_bus', row: 1, col: 3, length: 3, orientation: 'vertical', style: 'bus', color: 'purple', flipVisual: true },
            { id: 'h3_blue_top', row: 1, col: 6, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h3_red_target', row: 2, col: 0, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'h3_white_left', row: 4, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h3_sand_pickup', row: 4, col: 4, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
            { id: 'h3_white_middle', row: 5, col: 1, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white' },
            { id: 'h3_blue_bottom', row: 5, col: 4, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h3_white_bottom', row: 7, col: 1, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white' },
        ],
        blockers: [{ id: 'h3_bush', row: 0, col: 4, style: 'bush' }],
    },
    {
        id: 'truck_escape_2_medium_4', difficulty: 'medium', levelNumber: 4,
        rows: 7, cols: 7, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'h4_blue_left_top', row: 0, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h4_white_top', row: 0, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h4_sand_top', row: 0, col: 3, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand' },
            { id: 'h4_white_middle', row: 1, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h4_white_right', row: 1, col: 6, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h4_white_left', row: 2, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h4_red_target', row: 2, col: 1, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'h4_white_lower', row: 3, col: 1, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h4_sand_pickup', row: 4, col: 2, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
            { id: 'h4_blue_right', row: 3, col: 6, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h4_sand_middle', row: 5, col: 2, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand' },
            { id: 'h4_sand_bottom', row: 6, col: 0, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand', flipVisual: true },
            { id: 'h4_sand_pickup_bottom', row: 6, col: 3, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
        ],
    },
    {
        id: 'truck_escape_2_medium_5', difficulty: 'medium', levelNumber: 5,
        rows: 7, cols: 7, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'h5_white_left', row: 0, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h5_white_coupe', row: 0, col: 2, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white' },
            { id: 'h5_white_right_top', row: 0, col: 5, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h5_sand_semi', row: 1, col: 1, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand' },
            { id: 'h5_purple_top', row: 1, col: 4, length: 3, orientation: 'vertical', style: 'bus', color: 'purple', flipVisual: true },
            { id: 'h5_red_target', row: 2, col: 0, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'h5_white_right_bottom', row: 2, col: 5, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h5_blue_middle', row: 4, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h5_purple_bottom', row: 3, col: 3, length: 3, orientation: 'vertical', style: 'bus', color: 'purple' },
            { id: 'h5_white_pickup_left', row: 5, col: 0, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white' },
            { id: 'h5_white_pickup_right', row: 4, col: 4, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white' },
            { id: 'h5_purple_semi', row: 6, col: 0, length: 3, orientation: 'horizontal', style: 'semi', color: 'purple', flipVisual: true },
        ],
    },
    {
        id: 'truck_escape_2_medium_6', difficulty: 'medium', levelNumber: 6,
        rows: 8, cols: 7, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'h6_white_coupe', row: 0, col: 0, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white' },
            { id: 'h6_purple_top', row: 0, col: 2, length: 3, orientation: 'horizontal', style: 'semi', color: 'purple', flipVisual: true },
            { id: 'h6_sand_pickup', row: 1, col: 0, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
            { id: 'h6_white_top', row: 1, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h6_blue_middle', row: 1, col: 3, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h6_blue_right', row: 1, col: 6, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h6_red_target', row: 2, col: 0, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'h6_sand_bus', row: 3, col: 0, length: 3, orientation: 'vertical', style: 'bus', color: 'sand', flipVisual: true },
            { id: 'h6_sand_middle', row: 3, col: 1, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand' },
            { id: 'h6_white_right', row: 3, col: 6, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h6_white_pickup', row: 7, col: 0, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white' },
            { id: 'h6_purple_bottom', row: 7, col: 2, length: 3, orientation: 'horizontal', style: 'semi', color: 'purple' },
        ],
        blockers: [{ id: 'h6_bush', row: 7, col: 6, style: 'bush' }],
    },
    {
        id: 'truck_escape_2_medium_7', difficulty: 'medium', levelNumber: 7,
        rows: 7, cols: 7, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'h7_sand_bus_left', row: 0, col: 0, length: 3, orientation: 'vertical', style: 'bus', color: 'sand', flipVisual: true },
            { id: 'h7_sand_bus_middle', row: 0, col: 1, length: 3, orientation: 'vertical', style: 'bus', color: 'sand', flipVisual: true },
            { id: 'h7_white_top', row: 1, col: 5, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h7_purple_right', row: 1, col: 6, length: 3, orientation: 'vertical', style: 'bus', color: 'purple', flipVisual: true },
            { id: 'h7_red_target', row: 2, col: 2, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'h7_cream_coupe', row: 3, col: 0, length: 2, orientation: 'horizontal', style: 'coupe', color: 'cream' },
            { id: 'h7_purple_middle', row: 3, col: 2, length: 3, orientation: 'vertical', style: 'bus', color: 'purple' },
            { id: 'h7_white_middle', row: 3, col: 4, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h7_white_pickup', row: 4, col: 5, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white', flipVisual: true },
            { id: 'h7_sand_bottom', row: 6, col: 4, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand', flipVisual: true },
        ],
    },
    {
        id: 'truck_escape_2_medium_8', difficulty: 'medium', levelNumber: 8,
        rows: 8, cols: 7, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'h8_white_top', row: 1, col: 4, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h8_sand_bus', row: 1, col: 6, length: 3, orientation: 'vertical', style: 'bus', color: 'sand' },
            { id: 'h8_red_target', row: 2, col: 1, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'h8_sand_pickup', row: 3, col: 0, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true },
            { id: 'h8_purple_bus', row: 3, col: 2, length: 3, orientation: 'vertical', style: 'bus', color: 'purple' },
            { id: 'h8_blue_middle', row: 3, col: 4, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h8_blue_left', row: 5, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h8_white_bottom', row: 7, col: 5, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white' },
        ],
    },
    {
        id: 'truck_escape_2_medium_9', difficulty: 'medium', levelNumber: 9,
        rows: 8, cols: 7, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'h9_sand_top', row: 0, col: 0, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand' },
            { id: 'h9_white_coupe', row: 0, col: 4, length: 2, orientation: 'horizontal', style: 'coupe', color: 'white' },
            { id: 'h9_sand_bus', row: 0, col: 6, length: 3, orientation: 'vertical', style: 'bus', color: 'sand' },
            { id: 'h9_blue_left_top', row: 1, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h9_white_pickup_top', row: 1, col: 4, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white', flipVisual: true },
            { id: 'h9_red_target', row: 2, col: 1, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'h9_blue_right', row: 2, col: 5, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h9_blue_left_bottom', row: 3, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h9_sand_middle', row: 3, col: 1, length: 3, orientation: 'horizontal', style: 'semi', color: 'sand', flipVisual: true },
            { id: 'h9_white_bottom', row: 4, col: 1, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h9_sand_pickup', row: 4, col: 2, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true },
            { id: 'h9_cream_coupe', row: 4, col: 5, length: 2, orientation: 'horizontal', style: 'coupe', color: 'cream' },
            { id: 'h9_purple_bottom', row: 6, col: 4, length: 3, orientation: 'horizontal', style: 'semi', color: 'purple', flipVisual: true },
            { id: 'h9_white_pickup_bottom', row: 7, col: 0, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white', flipVisual: true },
        ],
        blockers: [
            { id: 'h9_bush_left', row: 6, col: 0, style: 'bush' },
            { id: 'h9_bush_bottom', row: 7, col: 4, style: 'bush' },
        ],
    },
    {
        id: 'truck_escape_2_medium_10', difficulty: 'medium', levelNumber: 10,
        rows: 7, cols: 7, exitRow: 2, exitSide: 'right', hintCount: 1,
        vehicles: [
            { id: 'h10_white_left', row: 0, col: 0, length: 2, orientation: 'vertical', style: 'sedan', color: 'white' },
            { id: 'h10_sand_top', row: 0, col: 1, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand', flipVisual: true },
            { id: 'h10_purple_top', row: 0, col: 3, length: 3, orientation: 'horizontal', style: 'semi', color: 'purple' },
            { id: 'h10_red_target', row: 2, col: 0, length: 2, orientation: 'horizontal', style: 'target', color: 'red', target: true },
            { id: 'h10_blue_middle', row: 2, col: 2, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
            { id: 'h10_sand_bus', row: 2, col: 6, length: 3, orientation: 'vertical', style: 'bus', color: 'sand', flipVisual: true },
            { id: 'h10_white_pickup', row: 3, col: 0, length: 2, orientation: 'horizontal', style: 'pickup', color: 'white', flipVisual: true },
            { id: 'h10_sand_pickup', row: 3, col: 4, length: 2, orientation: 'horizontal', style: 'pickup', color: 'sand' },
            { id: 'h10_purple_bottom', row: 5, col: 1, length: 3, orientation: 'horizontal', style: 'semi', color: 'purple' },
            { id: 'h10_blue_bottom', row: 5, col: 5, length: 2, orientation: 'vertical', style: 'sedan', color: 'blue' },
        ],
    },
];

/** 保留 Hard slot 的单关 API；catalog v2 中其棋盘来自原 Medium 组。 */
export const TRUCK_ESCAPE_2_HARD_LEVEL_1 = TRUCK_ESCAPE_2_HARD_LEVELS[0];

export function getTruckEscape2Levels(difficulty: TruckEscape2Difficulty): TruckEscape2LevelData[] {
    if (difficulty === 'hard') return TRUCK_ESCAPE_2_HARD_LEVELS;
    if (difficulty === 'medium') return TRUCK_ESCAPE_2_MEDIUM_LEVELS;
    return [
            TRUCK_ESCAPE_2_EASY_LEVEL_1,
            TRUCK_ESCAPE_2_EASY_LEVEL_2,
            TRUCK_ESCAPE_2_EASY_LEVEL_3,
            TRUCK_ESCAPE_2_EASY_LEVEL_4,
            TRUCK_ESCAPE_2_EASY_LEVEL_5,
            TRUCK_ESCAPE_2_EASY_LEVEL_6,
            TRUCK_ESCAPE_2_EASY_LEVEL_7,
            TRUCK_ESCAPE_2_EASY_LEVEL_8,
            TRUCK_ESCAPE_2_EASY_LEVEL_9,
            TRUCK_ESCAPE_2_EASY_LEVEL_10,
        ];
}
