import { Vec2, Vec3 } from 'cc';
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from '../data/LevelData';

/**
 * Godot: origin top-left, Y-down
 * Cocos: origin center, Y-up
 * GameRoot node at (-VIEWPORT_WIDTH/2, VIEWPORT_HEIGHT/2) makes children use:
 *   cocos_local = (godot_x, -godot_y)
 */

const HALF_W = VIEWPORT_WIDTH / 2;   // 270
const HALF_H = VIEWPORT_HEIGHT / 2;  // 480

/** Convert Godot position to Cocos world position */
export function g2c(gx: number, gy: number): Vec3 {
    return new Vec3(gx - HALF_W, HALF_H - gy, 0);
}

/** Convert Godot position to Vec2 */
export function g2cv2(gx: number, gy: number): Vec2 {
    return new Vec2(gx - HALF_W, HALF_H - gy);
}

/** Godot angle (CW degrees) to Cocos angle (CCW degrees) */
export function g2cAngle(godotDeg: number): number {
    return -godotDeg;
}

/** Convert Cocos world position back to design (Godot-style) coordinates. */
export function c2g(cocosX: number, cocosY: number): { x: number; y: number } {
    return { x: cocosX + HALF_W, y: HALF_H - cocosY };
}

/** Cocos angle (CCW degrees) back to Godot angle (CW degrees) */
export function c2gAngle(cocosDeg: number): number {
    return -cocosDeg;
}
