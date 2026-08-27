/**
 * 锚点数据定义
 */
export interface AnchorData {
    id: string;
    x: number;
    y: number;
    occupied: boolean;
}

/**
 * Optional circular wooden piece behind an anchor. It behaves like a board:
 * it has a dynamic body, a center hole, screw attachments, collision, and can
 * fall out after its screw is moved.
 */
export interface AnchorPadData {
    id: string;
    x: number;
    y: number;
    radius: number;
    holeOffsets?: { x: number; y: number }[];
    renderOrder: number;
    attachedAnchors: string[];
}

/**
 * 木条数据定义
 */
export interface BoardData {
    id: string;
    x: number;
    y: number;
    rotationDegrees: number;
    textureIndex: number;        // 1~10, 对应 wood_len_{index}.png
    collisionWidth: number;
    collisionHeight: number;
    holeOffsets: { x: number; y: number }[];
    renderOrder: number;
    linearDamp: number;
    angularDamp: number;
    attachedAnchors: string[];
}

/**
 * 关卡数据定义
 */
export interface LevelData {
    title: string;
    instruction: string;
    completeTitle: string;
    completeSubtitle: string;
    anchors: AnchorData[];
    anchorPads?: AnchorPadData[];
    boards: BoardData[];
}

// ── 统一尺寸体系 ──
export const BOLT_DIAMETER = 44.0;
export const BOLT_RADIUS = 22.0;
export const BOARD_WIDTH = 56.0;
export const HOLE_SPACING = 80.0;
export const ANCHOR_MIN_DIST = 70.0;
export const VIEWPORT_WIDTH = 540;
export const VIEWPORT_HEIGHT = 960;

// Play zone: Godot Rect2(20, 120, 500, 700)
export const PLAY_ZONE = {
    left: 20,
    top: 120,
    width: 500,
    height: 700,
    get right() { return this.left + this.width; },
    get bottom() { return this.top + this.height; },
};

/**
 * 计算木条长度 = 孔洞跨度 + 两端余量
 */
export function boardLen(nHoles: number, spacing: number = HOLE_SPACING): number {
    return (nHoles - 1) * spacing + BOLT_DIAMETER + 28.0;
}
