/**
 * 卡车出库小游戏 —— 统一元数据结构
 *
 * 设计：
 *  - 关卡是 cols × rows 的网格。每辆卡车占据 2 个相邻单元（沿其朝向）：
 *      LEFT  / RIGHT → 水平 1×2（占 (col,row) 与 (col±1,row)）
 *      UP    / DOWN  → 竖直 2×1（占 (col,row) 与 (col,row±1)）
 *  - 阻挡判定：从车头单元沿朝向逐格扫描到边界，途中若有任何其他未消除卡车
 *    占据的单元，则被阻挡；否则点击播放飞出动画并消除。
 *  - 通关条件：所有卡车都消除。
 *  - 元数据可以直接被关卡编辑器序列化 / 反序列化，便于扩展。
 */

/** 卡车颜色 —— 对应 textures/truck_remove_game/car_{color}.png */
export type TruckColor = 'yellow' | 'red' | 'blue' | 'gray_green';

/** 4 个正交方向（卡车朝向 = 它要开走的方向） */
export enum TruckDirection {
    UP = 'up',
    DOWN = 'down',
    LEFT = 'left',
    RIGHT = 'right',
}

/** 单辆卡车的关卡定义（连续坐标，由 gridLevel 工具生成） */
export interface TruckSpawn {
    id: string;
    /** 关卡内坐标系：原点在游戏区域左上角，x 向右、y 向下，单位是“逻辑像素”。 */
    x: number;
    y: number;
    color: TruckColor;
    direction: TruckDirection;
}

/** 卡车出库关卡数据 */
export interface TruckLevelData {
    title: string;
    instruction?: string;
    fieldWidth: number;
    fieldHeight: number;
    truckLength?: number;   // 长边（沿朝向）
    truckWidth?: number;    // 短边
    trucks: TruckSpawn[];
}

/** 默认卡车车身（贴近素材原图比例：高 ~300 / 宽 ~200） */
export const DEFAULT_TRUCK_LENGTH = 100;
export const DEFAULT_TRUCK_WIDTH = 65;

/** 由方向得到逻辑坐标系下的单位向量（x 向右、y 向下） */
export function directionVector(dir: TruckDirection): { dx: number; dy: number } {
    switch (dir) {
        case TruckDirection.UP:    return { dx:  0, dy: -1 };
        case TruckDirection.DOWN:  return { dx:  0, dy:  1 };
        case TruckDirection.LEFT:  return { dx: -1, dy:  0 };
        case TruckDirection.RIGHT: return { dx:  1, dy:  0 };
    }
}

/**
 * 由方向得到卡车精灵在 Cocos 屏幕坐标系下的旋转角度（CCW 为正）。
 * 原始素材车头朝上（屏幕 +Y）：
 *   UP    → 0°
 *   DOWN  → 180°
 *   LEFT  → 90°
 *   RIGHT → -90°
 */
export function directionRotationDeg(dir: TruckDirection): number {
    switch (dir) {
        case TruckDirection.UP:    return 0;
        case TruckDirection.DOWN:  return 180;
        case TruckDirection.LEFT:  return 90;
        case TruckDirection.RIGHT: return -90;
    }
}

/**
 * 不同颜色的素材原图朝向修正（黄色作为基准，其他三色与黄色相反）：
 *  - yellow  原图与代码假设的「车头朝上」一致 → 但配合 directionRotationDeg
 *    时需要 180° 才能正确展示。
 *  - red / blue / gray_green 与黄色方向相反，因此使用 0°（无修正）。
 */
export function colorHeadOffsetDeg(color: TruckColor): number {
    switch (color) {
        case 'yellow':     return 180;
        case 'red':        return 0;
        case 'blue':       return 180;
        case 'gray_green': return 180;
    }
}

/** 卡车出库小游戏的视口（沿用主项目 540×960） */
export const TRUCK_VIEWPORT_WIDTH = 540;
export const TRUCK_VIEWPORT_HEIGHT = 960;

/** 顶部与底部 HUD 占用的高度（像素） */
export const TRUCK_HUD_TOP = 200;
export const TRUCK_HUD_BOTTOM = 200;

/** 闲置多久后高亮一个可消除的卡车（秒） */
export const TRUCK_IDLE_HINT_SECONDS = 5.0;
