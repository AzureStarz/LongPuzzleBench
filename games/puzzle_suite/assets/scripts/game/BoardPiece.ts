import {
    _decorator,
    Component,
    Node,
    Vec2,
    Vec3,
    UITransform,
    RigidBody2D,
    BoxCollider2D,
    CircleCollider2D,
    PolygonCollider2D,
} from 'cc';
import { BOLT_RADIUS, BOARD_WIDTH } from '../data/LevelData';

const { ccclass } = _decorator;

export type BoardVisualMaterial = 'empty' | 'hole' | 'solid';

// A screw can be inserted as long as the anchor center still falls inside the
// visible drilled hole. A 5px exact-center tolerance is too strict for dynamic
// pieces: after one support is removed, boards/pads can settle slightly while
// the hole is still visually usable.
const ALIGN_TOLERANCE = BOLT_RADIUS;

/**
 * Cocos counterpart of Godot BoardPiece.
 * Holds collision dimensions, hole offsets, and exposes alignment / blocking checks
 * in world coordinates. The collider/rigidbody are added by LevelController during
 * board construction so geometry is data-driven.
 */
@ccclass('BoardPiece')
export class BoardPiece extends Component {
    public boardId: string = '';
    public collisionWidth: number = 176;
    public collisionHeight: number = BOARD_WIDTH;
    public holeOffsets: Vec2[] = [];
    public holeRadius: number = BOLT_RADIUS;
    public renderOrder: number = 0;
    public hasExited: boolean = false;
    public shape: 'rect' | 'roundedRect' | 'capsule' | 'circle' = 'rect';
    public circleRadius: number = 0;
    public capsuleRadius: number = BOARD_WIDTH * 0.5;
    public cornerRadius: number = 0;
    public collisionInset: number = 0;

    public rigidBody: RigidBody2D | null = null;
    public collider: BoxCollider2D | CircleCollider2D | PolygonCollider2D | null = null;
    public spriteNode: Node | null = null;
    public overlayNode: Node | null = null;

    /** Cached UITransform of self (for world<->local conversions matching node anchor). */
    public get uiTransform(): UITransform | null {
        return this.getComponent(UITransform);
    }

    /** Whether this board still owns physical existence in the scene. */
    public get isValid(): boolean {
        return !this.hasExited && this.node && this.node.isValid;
    }

    /** Mark for cleanup; called when the board exits the play zone. */
    markExited() {
        this.hasExited = true;
    }

    /**
     * Convert a world point (in the GameRoot coordinate space - which mirrors Godot's
     * top-left Y-down by using a parent translation) to this board's local space.
     * UITransform uses the node's full world matrix, avoiding Cocos Euler-angle
     * decomposition ambiguities for rotations beyond +/-90 degrees.
     */
    public worldToLocal(wx: number, wy: number): Vec2 {
        const ui = this.uiTransform;
        if (ui) {
            const local = ui.convertToNodeSpaceAR(new Vec3(wx, wy, 0));
            return new Vec2(local.x, local.y);
        }

        // Board nodes always have a UITransform in this game. Keep a matrix-free
        // fallback for partially constructed nodes, but derive the planar angle
        // from the quaternion instead of eulerAngles.z. Cocos may represent a
        // pure Z rotation beyond +/-90 degrees as X=180/Y=180 plus a different Z
        // Euler angle; using eulerAngles.z alone mirrors the geometry.
        const wp = this.node.worldPosition;
        const angleRad = this.worldAngleDegrees() * Math.PI / 180;
        const dx = wx - wp.x;
        const dy = wy - wp.y;
        const cos = Math.cos(-angleRad);
        const sin = Math.sin(-angleRad);
        return new Vec2(dx * cos - dy * sin, dx * sin + dy * cos);
    }

    public localToWorld(local: Vec2): Vec2 {
        const ui = this.uiTransform;
        if (ui) {
            const world = ui.convertToWorldSpaceAR(new Vec3(local.x, local.y, 0));
            return new Vec2(world.x, world.y);
        }
        const wp = this.node.worldPosition;
        const angleRad = this.worldAngleDegrees() * Math.PI / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        return new Vec2(
            wp.x + local.x * cos - local.y * sin,
            wp.y + local.x * sin + local.y * cos
        );
    }

    /** Actual planar world rotation, independent of Cocos Euler decomposition. */
    public worldAngleDegrees(): number {
        const q = this.node.worldRotation;
        const sin = 2 * (q.w * q.z + q.x * q.y);
        const cos = 1 - 2 * (q.y * q.y + q.z * q.z);
        return Math.atan2(sin, cos) * 180 / Math.PI;
    }

    public closestHoleLocalAt(wx: number, wy: number): Vec2 | null {
        if (this.holeOffsets.length === 0) return null;
        const lp = this.worldToLocal(wx, wy);
        let best = this.holeOffsets[0];
        let bestDist = Number.MAX_VALUE;
        for (const h of this.holeOffsets) {
            const dist = (h.x - lp.x) ** 2 + (h.y - lp.y) ** 2;
            if (dist < bestDist) {
                bestDist = dist;
                best = h;
            }
        }
        return best;
    }

    /** True iff the board has a hole whose center is within tolerance of (wx, wy). */
    hasAlignedHoleAt(wx: number, wy: number, tolerance: number = ALIGN_TOLERANCE): boolean {
        const lp = this.worldToLocal(wx, wy);
        for (const h of this.holeOffsets) {
            const dx = lp.x - h.x;
            const dy = lp.y - h.y;
            if (Math.sqrt(dx * dx + dy * dy) <= tolerance) return true;
        }
        return false;
    }

    /**
     * True iff the board's solid body overlaps a circle of radius `r` centered at (wx, wy)
     * AND that point is not within any aligned hole. Mirrors Godot blocks_anchor_circle.
     */
    blocksAnchorCircle(
        wx: number,
        wy: number,
        r: number = BOLT_RADIUS,
        solidInset: number = 0,
        holeTolerance: number = ALIGN_TOLERANCE
    ): boolean {
        const lp = this.worldToLocal(wx, wy);
        let outside: number;
        if (this.shape === 'circle') {
            const effectiveRadius = Math.max(this.circleRadius - solidInset, 0);
            outside = Math.max(Math.sqrt(lp.x * lp.x + lp.y * lp.y) - effectiveRadius, 0);
        } else if (this.shape === 'roundedRect') {
            outside = Math.max(this._roundedRectOutsideDistance(lp, solidInset, false), 0);
        } else if (this.shape === 'capsule') {
            // Wooden bars are visually rounded. Treat their solid body as a
            // horizontal capsule instead of a sharp-corner rectangle so empty
            // holes and screws near the rounded ends do not get falsely blocked.
            const rCapsule = this.capsuleRadius;
            const halfSegment = Math.max(this.collisionWidth * 0.5 - rCapsule, 0);
            const closestX = Math.max(-halfSegment, Math.min(halfSegment, lp.x));
            const dx = lp.x - closestX;
            outside = Math.max(Math.sqrt(dx * dx + lp.y * lp.y) - rCapsule, 0);
        } else {
            const halfW = this.collisionWidth * 0.5;
            const halfH = this.collisionHeight * 0.5;
            const dx = Math.max(Math.abs(lp.x) - halfW, 0);
            const dy = Math.max(Math.abs(lp.y) - halfH, 0);
            outside = Math.sqrt(dx * dx + dy * dy);
        }
        if (outside >= r) return false;
        if (this.hasAlignedHoleAt(wx, wy, holeTolerance)) return false;
        return true;
    }

    /**
     * Raw physics-footprint overlap, intentionally ignoring visual drilled
     * holes. The real collider is one solid rounded polygon/circle, so this answers:
     * "would a newly enabled screw support collider start inside this body and
     * generate a Box2D separation impulse?"
     */
    overlapsSolidCircle(wx: number, wy: number, r: number, solidInset: number = 0): boolean {
        const lp = this.worldToLocal(wx, wy);
        return this._solidOutsideDistance(lp, solidInset) < r;
    }

    /**
     * Per-board visual material query for one socket sample.
     *
     * LevelController can inspect this result across every overlapping layer:
     * a painted hole cuts through its owning board, but cannot erase solid wood
     * belonging to a different board behind or in front of it.
     *   - `solid`: visible wood/disk pixel, blocks the sample.
     *   - `hole`: this board has a drilled opening at the sample.
     *   - `empty`: this board contributes no visible pixel at the sample.
     */
    visualMaterialAtAnchorSample(
        sampleWx: number,
        sampleWy: number,
        solidInset: number = 0,
        visualHoleRadius: number = BOLT_RADIUS - 2
    ): BoardVisualMaterial {
        const sampleLocal = this.worldToLocal(sampleWx, sampleWy);
        if (this._visualOutsideDistance(sampleLocal, solidInset) > 0) return 'empty';

        // Hole graphics use a transparent center with a dark rim above the wood
        // sprite. A sample inside that visible footprint is therefore a hole
        // regardless of how far its center is from the base anchor. Restricting
        // this to only "aligned" holes would classify the rim as solid wood.
        if (this._isInsideVisibleHole(sampleLocal, visualHoleRadius)) {
            return 'hole';
        }
        return 'solid';
    }

    private _isInsideVisibleHole(lp: Vec2, visualHoleRadius: number): boolean {
        for (const h of this.holeOffsets) {
            const dx = lp.x - h.x;
            const dy = lp.y - h.y;
            if (Math.sqrt(dx * dx + dy * dy) <= visualHoleRadius) return true;
        }
        return false;
    }

    private _visualOutsideDistance(lp: Vec2, solidInset: number): number {
        if (this.shape === 'circle') {
            const effectiveRadius = Math.max(this.circleRadius - solidInset, 0);
            return Math.sqrt(lp.x * lp.x + lp.y * lp.y) - effectiveRadius;
        }
        if (this.shape === 'roundedRect') {
            return this._roundedRectOutsideDistance(lp, solidInset, false);
        }
        if (this.shape === 'capsule') {
            // Insertion blocking must match what the player sees, not the
            // slightly inset physics collider used to keep falling smooth.
            const rCapsule = Math.max(this.collisionHeight * 0.5 - solidInset, 0);
            const halfSegment = Math.max(this.collisionWidth * 0.5 - rCapsule, 0);
            const closestX = Math.max(-halfSegment, Math.min(halfSegment, lp.x));
            const dx = lp.x - closestX;
            return Math.sqrt(dx * dx + lp.y * lp.y) - rCapsule;
        }
        const halfW = Math.max(this.collisionWidth * 0.5 - solidInset, 0);
        const halfH = Math.max(this.collisionHeight * 0.5 - solidInset, 0);
        const dx = Math.max(Math.abs(lp.x) - halfW, 0);
        const dy = Math.max(Math.abs(lp.y) - halfH, 0);
        if (dx > 0 || dy > 0) return Math.sqrt(dx * dx + dy * dy);
        return -Math.min(halfW - Math.abs(lp.x), halfH - Math.abs(lp.y));
    }

    private _solidOutsideDistance(lp: Vec2, solidInset: number): number {
        if (this.shape === 'circle') {
            const effectiveRadius = Math.max(this.circleRadius - solidInset, 0);
            return Math.sqrt(lp.x * lp.x + lp.y * lp.y) - effectiveRadius;
        }
        if (this.shape === 'roundedRect') {
            return this._roundedRectOutsideDistance(lp, solidInset, true);
        }
        if (this.shape === 'capsule') {
            const rCapsule = this.capsuleRadius;
            const halfSegment = Math.max(this.collisionWidth * 0.5 - rCapsule, 0);
            const closestX = Math.max(-halfSegment, Math.min(halfSegment, lp.x));
            const dx = lp.x - closestX;
            return Math.sqrt(dx * dx + lp.y * lp.y) - rCapsule;
        }
        const halfW = this.collisionWidth * 0.5;
        const halfH = this.collisionHeight * 0.5;
        const dx = Math.max(Math.abs(lp.x) - halfW, 0);
        const dy = Math.max(Math.abs(lp.y) - halfH, 0);
        if (dx > 0 || dy > 0) return Math.sqrt(dx * dx + dy * dy);
        return -Math.min(halfW - Math.abs(lp.x), halfH - Math.abs(lp.y));
    }

    private _roundedRectOutsideDistance(lp: Vec2, solidInset: number, physical: boolean): number {
        const inset = Math.max(solidInset + (physical ? this.collisionInset : 0), 0);
        const halfW = Math.max(this.collisionWidth * 0.5 - inset, 0);
        const halfH = Math.max(this.collisionHeight * 0.5 - inset, 0);
        const radius = Math.max(Math.min(this.cornerRadius - inset, halfW, halfH), 0);
        const innerHalfW = Math.max(halfW - radius, 0);
        const innerHalfH = Math.max(halfH - radius, 0);
        const qx = Math.abs(lp.x) - innerHalfW;
        const qy = Math.abs(lp.y) - innerHalfH;
        const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
        return outside + Math.min(Math.max(qx, qy), 0) - radius;
    }
}
