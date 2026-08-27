import {
    _decorator,
    Component,
    Node,
    Graphics,
    Color,
    Sprite,
    EventTouch,
    RigidBody2D,
    CircleCollider2D,
    Tween,
    tween,
    Vec3,
} from 'cc';
import { BOLT_RADIUS } from '../data/LevelData';
import {
    BOLT_SELECTION_DURATION_SECONDS,
    BOLT_SELECTION_SCALE,
    boltSelectionTarget,
} from './BoltSelectionFeedback';

const { ccclass } = _decorator;

/**
 * Anchor point - a clickable hole in the base plate that may hold a screw.
 * Visuals (bolt sprite, selection highlight) and support body (the static
 * circle the board hooks onto) are wired up by LevelController and stored here
 * for fast access. Click events forward to onAnchorPressed.
 */
@ccclass('AnchorPoint')
export class AnchorPoint extends Component {
    public anchorId: string = '';
    public occupied: boolean = false;
    public onAnchorPressed: ((anchor: AnchorPoint) => void) | null = null;

    private _selected: boolean = false;
    private _coveredByBoard: boolean = false;
    private _boltDefaultPosition = new Vec3();
    private _boltDefaultScale = new Vec3(1, 1, 1);
    private _boltDefaultSiblingIndex = 0;
    private _highlightDefaultPosition = new Vec3();

    /** Visuals - assigned by LevelController during build. */
    public boltSpriteNode: Node | null = null;
    public boltSprite: Sprite | null = null;
    public highlightGraphics: Graphics | null = null;

    /** Physics support - the static body that boards can pin against. */
    public supportNode: Node | null = null;
    public supportBody: RigidBody2D | null = null;
    public supportCollider: CircleCollider2D | null = null;

    start() {
        this.node.on(Node.EventType.TOUCH_END, this._onTouchEnd, this);
    }

    onDestroy() {
        if (this.boltSpriteNode) Tween.stopAllByTarget(this.boltSpriteNode);
        const highlightNode = this.highlightGraphics?.node;
        if (highlightNode) Tween.stopAllByTarget(highlightNode);
    }

    hasBolt(): boolean { return this.occupied; }

    setBoltPresent(value: boolean) {
        this.occupied = value;
        if (!value) this._selected = false;
        this._syncSupportBody();
        this._updateVisual();
    }

    setCoveredByBoard(value: boolean) {
        if (this._coveredByBoard === value) return;
        this._coveredByBoard = value;
    }

    isCovered(): boolean { return this._coveredByBoard; }

    setSelected(value: boolean) {
        const next = value && this.occupied;
        if (next === this._selected) return;
        this._selected = next;
        this._updateVisual();
    }

    isSelected(): boolean { return this._selected; }

    /** Called by LevelController after creating the visual child nodes. */
    initVisuals(boltSpriteNode: Node, boltSprite: Sprite, highlightGfx: Graphics) {
        this.boltSpriteNode = boltSpriteNode;
        this.boltSprite = boltSprite;
        this.highlightGraphics = highlightGfx;
        this._boltDefaultPosition.set(boltSpriteNode.position);
        this._boltDefaultScale.set(boltSpriteNode.scale);
        this._boltDefaultSiblingIndex = boltSpriteNode.getSiblingIndex();
        this._highlightDefaultPosition.set(highlightGfx.node.position);
        this._updateVisual(false);
    }

    /** Called by LevelController after creating the support body child. */
    initSupport(supportNode: Node, body: RigidBody2D, collider: CircleCollider2D) {
        this.supportNode = supportNode;
        this.supportBody = body;
        this.supportCollider = collider;
        this._syncSupportBody();
    }

    private _syncSupportBody() {
        if (this.supportCollider) {
            this.supportCollider.enabled = this.occupied;
        }
        if (this.supportNode) {
            this.supportNode.active = this.occupied;
        }
    }

    private _updateVisual(animate: boolean = true) {
        const selected = this.occupied && this._selected;
        const target = boltSelectionTarget(this._boltDefaultPosition, this.occupied, selected);
        if (this.boltSpriteNode) {
            const bolt = this.boltSpriteNode;
            bolt.active = this.occupied;
            Tween.stopAllByTarget(bolt);
            if (selected) bolt.setSiblingIndex(bolt.parent!.children.length - 1);
            else bolt.setSiblingIndex(Math.min(this._boltDefaultSiblingIndex, bolt.parent!.children.length - 1));

            const targetPosition = new Vec3(target.x, target.y, target.z);
            const targetScale = selected
                ? new Vec3(
                    this._boltDefaultScale.x * BOLT_SELECTION_SCALE,
                    this._boltDefaultScale.y * BOLT_SELECTION_SCALE,
                    this._boltDefaultScale.z,
                )
                : this._boltDefaultScale.clone();
            if (animate && this.occupied) {
                tween(bolt)
                    .to(BOLT_SELECTION_DURATION_SECONDS, {
                        position: targetPosition,
                        scale: targetScale,
                    }, { easing: selected ? 'quadOut' : 'quadInOut' })
                    .call(() => {
                        // Snap to the baseline-derived target so interrupted or
                        // rapidly reversed tweens can never accumulate drift.
                        if (!bolt.isValid) return;
                        bolt.setPosition(targetPosition);
                        bolt.setScale(targetScale);
                    })
                    .start();
            } else {
                bolt.setPosition(targetPosition);
                bolt.setScale(targetScale);
            }
        }
        if (this.highlightGraphics) {
            const highlightNode = this.highlightGraphics.node;
            Tween.stopAllByTarget(highlightNode);
            this.highlightGraphics.clear();
            if (selected) {
                this.highlightGraphics.lineWidth = 4;
                this.highlightGraphics.strokeColor = new Color(255, 224, 92, 255);
                this.highlightGraphics.circle(0, 0, BOLT_RADIUS + 7);
                this.highlightGraphics.stroke();
            }
            const highlightTarget = new Vec3(
                this._highlightDefaultPosition.x,
                this._highlightDefaultPosition.y + (selected ? target.y - this._boltDefaultPosition.y : 0),
                this._highlightDefaultPosition.z,
            );
            if (animate && this.occupied) {
                tween(highlightNode)
                    .to(BOLT_SELECTION_DURATION_SECONDS, { position: highlightTarget }, { easing: 'quadOut' })
                    .call(() => {
                        if (highlightNode.isValid) highlightNode.setPosition(highlightTarget);
                    })
                    .start();
            } else highlightNode.setPosition(highlightTarget);
        }
    }

    private _onTouchEnd(_event: EventTouch) {
        if (this.onAnchorPressed) {
            this.onAnchorPressed(this);
        }
    }
}
