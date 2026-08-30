import {
    _decorator,
    Component,
    Node,
    Vec2,
    Graphics,
    Color,
    UITransform,
    Sprite,
    SpriteFrame,
    Mask,
    Label,
    Button,
    RigidBody2D,
    ERigidBody2DType,
    Collider2D,
    BoxCollider2D,
    CircleCollider2D,
    PolygonCollider2D,
    Contact2DType,
    IPhysics2DContact,
    HingeJoint2D,
    PhysicsSystem2D,
    resources,
    input,
    Input,
    EventKeyboard,
    KeyCode,
} from 'cc';
import {
    BOLT_RADIUS,
    BOLT_DIAMETER,
    VIEWPORT_WIDTH,
    VIEWPORT_HEIGHT,
    PLAY_ZONE,
    LevelData,
    BoardData,
    AnchorData,
    AnchorPadData,
} from '../data/LevelData';
import { BoltDifficulty, buildLevelsForDifficulty } from '../data/LevelDefinitions';
import { AnchorPoint } from './AnchorPoint';
import { BoardPiece } from './BoardPiece';
import type { BoardVisualMaterial } from './BoardPiece';
import { g2c, g2cAngle, c2g, c2gAngle } from './CoordHelper';
import { GameInspector, InspectorProvider, PhysicsStats } from './GameInspector';
import { BoltDeadlockStatus, evaluateBoltDeadlock } from './BoltDeadlock';

const { ccclass } = _decorator;

const DEFAULT_INSTRUCTION = '先点有螺丝的锚点，再点空位把它挪走。';
const ANCHOR_MIN_DIST = 70.0;

// Collision groups (categoryBits in Box2D). DEFAULT (1) is reserved by Cocos.
// Boards in these reference levels are visually layered and often overlap at
// start. Hard board-board contacts make dense levels explode apart. Ordinary
// pinned/released groups therefore remain mutually non-colliding. A separate
// group is armed only for a fully released, stable horizontal strip approaching
// another stable horizontal strip; PRE_SOLVE rejects every cross/side contact.
const GROUP_BOARD_PINNED = 1 << 1;    // 2
const GROUP_SUPPORT = 1 << 2;         // 4
const GROUP_BOARD_RELEASED = 1 << 3;  // 8
const GROUP_BOARD_FREE_SURFACE = 1 << 4; // 16
// Hard 8 uses a separate group for fully released pieces so they remain
// isolated from the level's deliberately overlapping wood layers. It must
// still collide with every occupied screw: both strips and circular pads are
// physical bodies and may never pass through a support peg.
const GROUP_LEVEL8_FULLY_RELEASED = 1 << 5; // 32
// Keep every hole-related footprint on the same small size reduction while
// leaving the 44px screw head itself unchanged. This keeps the painted socket,
// physical support peg, obstruction samples, and visible-hole classifier in
// sync instead of shrinking only one representation.
const HOLE_RADIUS_REDUCTION = 2;
const SUPPORT_COLLISION_RADIUS = BOLT_RADIUS - 4 - HOLE_RADIUS_REDUCTION;
const VISUAL_HOLE_OUTER_RADIUS = BOLT_RADIUS + 0.25 - HOLE_RADIUS_REDUCTION;
const VISUAL_HOLE_INNER_RADIUS = BOLT_RADIUS - 3 - HOLE_RADIUS_REDUCTION;
// Empty-hole insertion follows the visible black socket. Reliably visible wood
// on that face blocks the screw; the former weighted tolerance allowed almost a
// third of a socket to be covered while still accepting insertion. Board/pad
// hole overlays paint the same outer rim as the background sockets, so
// classify that full painted radius as a hole rather than as solid wood.
const ANCHOR_INSERT_SOCKET_RADIUS = BOLT_RADIUS - 0.25 - HOLE_RADIUS_REDUCTION;
const ANCHOR_INSERT_VISUAL_HOLE_RADIUS = VISUAL_HOLE_OUTER_RADIUS;
// Ignore at most four isolated samples on the 32-point outer contour. They
// represent a sub-pixel/anti-aliased rim graze (about 1-2% of the socket face),
// not visible wood over the usable hole. Any solid sample deeper than the rim,
// or five outer samples forming a visible crescent, still blocks insertion.
const ANCHOR_INSERT_OUTER_SOLID_BLOCK_COUNT = 5;
const ANCHOR_ATTACH_HOLE_TOLERANCE = 2.5;
const WOOD_INSERT_SOLID_INSET = 0;
// Circular pads must block insertion by their full visible disk. A previous
// inset hit-test made the disk look like it was covering a base hole while the
// logic still allowed a screw to be inserted, which then pushed the disk away.
// Use the full rendered radius: sockets under the disk body must stay blocked.
const CIRCLE_PAD_INSERT_SOLID_INSET = 0;
const SUPPORT_ACTIVATION_OVERLAP_RADIUS = SUPPORT_COLLISION_RADIUS + 3;
const SUPPORT_INSERT_ACTIVATION_DELAY = 0.18;
const ANCHOR_COVER_REFRESH_INTERVAL = 0.08;
const INSERTION_SETTLE_MAX_LINEAR_SPEED = 1.0;
const INSERTION_SETTLE_MAX_ANGULAR_SPEED = 0.05;
const INSERTION_SETTLE_REQUIRED_TIME = 0.22;

// The wood textures are rounded rectangles, not capsules. Use one inset convex
// octagon per board: it follows the visible corners closely, avoids the sharp
// BoxCollider corners, and (unlike the former box + two overlapping circles)
// does not count overlapping fixture area multiple times in body mass/inertia.
const WOOD_COLLISION_SKIN = 2;
const WOOD_CORNER_RADIUS = 11;
const WOOD_FRICTION = 0.12;
const WOOD_RESTITUTION = 0.02;
const WOOD_DENSITY = 0.9;
// A fully released, nearly horizontal strip can land flat across screw pegs or
// a stable horizontal wood surface. Default mixed friction may consume a small
// tangential velocity in the first solve and make the strip look glued in
// place. For that one post-fall state, use a lower native contact friction and
// temporarily prevent sleep; authored damping still dissipates the inertia.
const FREE_HORIZONTAL_SLIDE_ANGLE_DEG = 8;
const FREE_HORIZONTAL_SLIDE_MIN_RELEASE_AGE = 0.12;
const FREE_HORIZONTAL_SLIDE_MAJOR_FALL_DISTANCE = 24;
const FREE_HORIZONTAL_SLIDE_MAJOR_FALL_SPEED = 1.0;
const FREE_HORIZONTAL_SLIDE_MAX_ANGULAR_SPEED = 0.18;
const FREE_HORIZONTAL_SLIDE_MAX_VERTICAL_SPEED = 1.5;
const FREE_HORIZONTAL_SLIDE_MIN_START_SPEED = 0.08;
const FREE_HORIZONTAL_SLIDE_STOP_SPEED = 0.06;
const FREE_HORIZONTAL_SLIDE_STOP_QUIET_TIME = 0.18;
const FREE_HORIZONTAL_SLIDE_MIN_CONTACT_NORMAL_Y = 0.65;
const FREE_HORIZONTAL_SLIDE_CONTACT_FRICTION = 0.01;
const FREE_HORIZONTAL_SURFACE_SCAN_DISTANCE = 90;
const FREE_HORIZONTAL_SURFACE_MIN_X_OVERLAP = 12;
const FREE_HORIZONTAL_SURFACE_MAX_PENETRATION = 2;
const FREE_HORIZONTAL_SURFACE_MAX_SUPPORT_SPEED = 1.0;
const VERTICAL_ANCHORED_PIVOT_ANGLE_DEG = 16;
const VERTICAL_ANCHORED_PIVOT_ANGULAR_IMPULSE = 0.0035;
const VERTICAL_ANCHORED_PIVOT_MIN_START_SPEED = 0.04;
const VERTICAL_ANCHORED_OUTWARD_BIAS_X = 30;
const VERTICAL_ANCHORED_LEAN_DEADBAND = 18;
// Board graphics leave about 36px from an end screw hole to the rounded end.
// Treat that as "top-end fixed" so removing the lower screw does not wrongly
// classify a hanging plank as a lower-pivot plank and make it wobble/fall.
const VERTICAL_ANCHORED_TOP_FREE_GAP = 48;
const EXIT_MARGIN_X = 180;
const EXIT_MARGIN_Y = 260;
const EXIT_BOUNDS_EXTRA_RADIUS = 20;
const TEMP_JUMP_LEVEL_4_TITLE = '困难第4关：密集竖栅';
const TEMP_JUMP_LEVEL_5_TITLE = '困难第5关：吊架圆盘';
const TEMP_JUMP_LEVEL_6_TITLE = '困难第6关：斜拉木桥';
const TEMP_JUMP_LEVEL_7_TITLE = '困难第7关：双圆盘交叉栅栏';
const TEMP_JUMP_LEVEL_8_TITLE = '困难第8关：双V交叉木架';

type ValidationPieceShape = 'roundedRect' | 'circle';
type AnchorInsertionSampleBand = 'center' | 'inner' | 'middle' | 'outer';

interface AnchorInsertionSample {
    x: number;
    y: number;
    weight: number;
    band: AnchorInsertionSampleBand;
}

interface ReleasedHorizontalSlideState {
    age: number;
    releaseY: number;
    sawMajorFall: boolean;
    gliding: boolean;
    completed: boolean;
    quietAge: number;
    surfaceCollisionsEnabled: boolean;
    glidingOnBoardSurface: boolean;
}

interface ValidationPieceSpec {
    id: string;
    kind: 'board' | 'anchorPad';
    x: number;
    y: number;
    rotationDegrees: number;
    collisionWidth: number;
    collisionHeight: number;
    circleRadius: number;
    shape: ValidationPieceShape;
    holeOffsets: { x: number; y: number }[];
    attachedAnchors: string[];
}

/**
 * Master controller. Owns the level data array, the GameRoot subtree (anchors,
 * boards, joints), and the HUD. It rebuilds everything from data on level load.
 *
 * Coordinate system: levels are authored in Godot top-left/Y-down pixel space.
 * GameRoot is positioned so its (0,0) lives at the top-left of the viewport in
 * Cocos world space. `g2c(godot_x, godot_y)` converts authoring coords to the
 * local-position we hand to nodes.
 */
@ccclass('LevelController')
export class LevelController extends Component {
    public levelDifficulty: BoltDifficulty = 'easy';
    private levels: LevelData[] = [];
    private _currentIndex: number = 0;
    private _initialLevelIndex: number = 0;
    private _levelComplete: boolean = false;
    private _boardsTotal: number = 0;
    private _boardsExited: number = 0;
    private _currentInstruction: string = DEFAULT_INSTRUCTION;

    private _anchors: AnchorPoint[] = [];
    private _boards: BoardPiece[] = [];
    private _anchorById: Map<string, AnchorPoint> = new Map();
    private _boardById: Map<string, BoardPiece> = new Map();
    /** anchor -> list of boards currently pinned to it. */
    private _anchorBoardLinks: Map<AnchorPoint, BoardPiece[]> = new Map();
    /** anchor -> list of hinge joint components currently pinning boards. */
    private _anchorJointLinks: Map<AnchorPoint, HingeJoint2D[]> = new Map();
    private _selectedAnchor: AnchorPoint | null = null;
    private _pendingSupportActivations: Map<AnchorPoint, number> = new Map();
    private _releasedHorizontalSlides: Map<BoardPiece, ReleasedHorizontalSlideState> = new Map();
    private _anchorCoverRefreshTimer: number = 0;
    private _insertionQuietAge: number = INSERTION_SETTLE_REQUIRED_TIME;

    /** Container nodes inside GameRoot. */
    private _root: Node | null = null;       // GameRoot (top-left origin)
    private _anchorsRoot: Node | null = null;
    private _boardsRoot: Node | null = null;
    private _backgroundRoot: Node | null = null;

    /** HUD references. */
    private _levelLabel: Label | null = null;
    private _instructionLabel: Label | null = null;
    private _boardsOutLabel: Label | null = null;
    private _completeOverlay: Node | null = null;
    private _completeTitleLabel: Label | null = null;
    private _completeSubLabel: Label | null = null;
    private _completeNextButton: Button | null = null;

    /** Sprite frames for wood textures keyed by 1..10. */
    private _woodFrames: Map<number, SpriteFrame> = new Map();
    private _boltUpFrame: SpriteFrame | null = null;
    private _boltInHoleFrame: SpriteFrame | null = null;

    onLoad() {
        // Gravity is needed for boards to fall once detached.
        const physics = PhysicsSystem2D.instance;
        physics.gravity = new Vec2(0, -640);
        physics.fixedTimeStep = 1 / 60;
        physics.maxSubSteps = 3;
        physics.velocityIterations = 10;
        physics.positionIterations = 10;
        physics.enable = true;

        // General board-board contacts stay disabled because authored layers
        // overlap. Only GROUP_BOARD_FREE_SURFACE can meet another board, and
        // its PRE_SOLVE filter accepts a stable top-on-bottom landing only.
        const matrix = PhysicsSystem2D.instance.collisionMatrix as any;
        matrix[GROUP_BOARD_PINNED] = GROUP_SUPPORT | GROUP_BOARD_FREE_SURFACE;
        matrix[GROUP_BOARD_RELEASED] = GROUP_SUPPORT | GROUP_BOARD_FREE_SURFACE;
        matrix[GROUP_BOARD_FREE_SURFACE] = GROUP_SUPPORT
            | GROUP_BOARD_PINNED
            | GROUP_BOARD_RELEASED
            | GROUP_BOARD_FREE_SURFACE;
        matrix[GROUP_LEVEL8_FULLY_RELEASED] = GROUP_SUPPORT;
        matrix[GROUP_SUPPORT] = GROUP_BOARD_PINNED
            | GROUP_BOARD_RELEASED
            | GROUP_BOARD_FREE_SURFACE
            | GROUP_LEVEL8_FULLY_RELEASED;

        this._applyDifficulty(this.levelDifficulty);
        input.on(Input.EventType.KEY_DOWN, this._onKeyDown, this);
        GameInspector.instance.register('bolt', this._inspectorProvider);
    }

    start() {
        this._buildSceneSkeleton();
        this._loadTextures(() => {
            this._loadLevel(this._initialLevelIndex);
        });
    }

    onDestroy() {
        input.off(Input.EventType.KEY_DOWN, this._onKeyDown, this);
        GameInspector.instance.unregister('bolt');
    }

    public setDifficulty(difficulty: BoltDifficulty) {
        if (this.levelDifficulty === difficulty && this.levels.length > 0) return;
        this.levelDifficulty = difficulty;
        this._applyDifficulty(difficulty);
        if (this._root && this._anchorsRoot && this._boardsRoot) {
            this._loadLevel(0);
        }
    }

    /** Select the first benchmark level by its public, one-based id. */
    public setInitialLevel(levelId: number) {
        this._initialLevelIndex = Math.max(0, Math.min(Math.trunc(levelId) - 1, this.levels.length - 1));
        if (this._root && this._anchorsRoot && this._boardsRoot && this._woodFrames.size > 0) {
            this._loadLevel(this._initialLevelIndex);
        }
    }

    /** Reset without routing through the Hub or changing the selected level. */
    public resetCurrentLevel() {
        this._loadLevel(this._currentIndex);
    }

    private _applyDifficulty(difficulty: BoltDifficulty) {
        this.levels = buildLevelsForDifficulty(difficulty);
        this._currentIndex = 0;
        this._validateLevels();
    }

    private _isLevel8ReferenceStyle(): boolean {
        return this.levels[this._currentIndex]?.title === TEMP_JUMP_LEVEL_8_TITLE;
    }

    update(_dt: number) {
        if (!this._root) return;
        this._resolvePendingSupportActivations(_dt);
        this._updateReleasedHorizontalSlides(_dt);
        this._updateInsertionQuietAge(_dt);
        this._anchorCoverRefreshTimer += _dt > 0 && _dt < 0.25 ? _dt : 1 / 60;
        if (this._anchorCoverRefreshTimer >= ANCHOR_COVER_REFRESH_INTERVAL) {
            this._anchorCoverRefreshTimer = 0;
            this._refreshAnchorCoverState();
        }
        this._checkBoardsOutOfBounds();
    }

    // ──────────────────────────────────────────────────────────────────────
    // Scene skeleton: build GameRoot, HUD nodes, complete overlay.
    // ──────────────────────────────────────────────────────────────────────
    private _buildSceneSkeleton() {
        const root = this.node;
        const ui = root.getComponent(UITransform) ?? root.addComponent(UITransform);
        ui.setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        ui.setAnchorPoint(0.5, 0.5);
        this._root = root;

        // Background (board + holes drawing).
        const bg = new Node('Background');
        bg.layer = root.layer;
        bg.parent = root;
        bg.setPosition(0, 0, 0);
        const bgUI = bg.addComponent(UITransform);
        bgUI.setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        bgUI.setAnchorPoint(0.5, 0.5);
        const bgGfx = bg.addComponent(Graphics);
        this._drawBackground(bgGfx);
        this._backgroundRoot = bg;

        const boards = new Node('Boards');
        boards.layer = root.layer;
        boards.parent = root;
        this._boardsRoot = boards;

        const anchors = new Node('Anchors');
        anchors.layer = root.layer;
        anchors.parent = root;
        this._anchorsRoot = anchors;

        this._buildHud();
    }

    private _drawBackground(g: Graphics, level8ReferenceStyle: boolean = false) {
        // The Graphics origin is the node center. Convert PLAY_ZONE (godot pixel rect)
        // to local rectangle inside GameRoot.
        // Outer brown background.
        g.fillColor = new Color(82, 56, 36, 255);
        g.rect(-VIEWPORT_WIDTH / 2, -VIEWPORT_HEIGHT / 2, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        g.fill();

        // Play zone. Level 8 uses the warmer rounded wooden plate visible in
        // its source reference; other levels retain the established flat board.
        const zoneTopLeft = g2c(PLAY_ZONE.left, PLAY_ZONE.top);
        if (level8ReferenceStyle) {
            const x = zoneTopLeft.x + 3;
            const y = zoneTopLeft.y - PLAY_ZONE.height + 9;
            const width = PLAY_ZONE.width - 6;
            const height = PLAY_ZONE.height - 14;
            g.fillColor = new Color(91, 61, 37, 255);
            g.roundRect(x, y, width, height, 24);
            g.fill();
            g.fillColor = new Color(242, 181, 82, 255);
            g.roundRect(x + 4, y + 4, width - 8, height - 8, 20);
            g.fill();

            // Broad low-contrast grain strokes reproduce the sparse, soft
            // background grain without introducing another texture asset.
            g.lineWidth = 4;
            g.strokeColor = new Color(218, 140, 57, 30);
            const grainOffsets = [54, 151, 264, 376, 501, 623];
            const grainBends = [-12, 8, -6, 13, -9, 7];
            for (let i = 0; i < grainOffsets.length; i++) {
                const grainY = y + grainOffsets[i];
                const bend = grainBends[i];
                g.moveTo(x + 18, grainY);
                g.bezierCurveTo(
                    x + 135, grainY + bend,
                    x + 340, grainY - bend,
                    x + width - 18, grainY + bend * 0.4,
                );
            }
            g.stroke();

            g.lineWidth = 2;
            g.strokeColor = new Color(255, 224, 151, 205);
            g.roundRect(x + 7, y + 7, width - 14, height - 14, 17);
            g.stroke();
            return;
        }
        g.fillColor = new Color(235, 191, 122, 255);
        g.rect(zoneTopLeft.x, zoneTopLeft.y - PLAY_ZONE.height, PLAY_ZONE.width, PLAY_ZONE.height);
        g.fill();

        // Play zone border.
        g.lineWidth = 6;
        g.strokeColor = new Color(115, 71, 36, 255);
        g.rect(zoneTopLeft.x, zoneTopLeft.y - PLAY_ZONE.height, PLAY_ZONE.width, PLAY_ZONE.height);
        g.stroke();
    }

    /** Draws the dark hole rings for each anchor on top of the play zone. */
    private _drawAnchorHoles() {
        if (!this._backgroundRoot) return;
        let gfx = this._backgroundRoot.getChildByName('AnchorHoles');
        if (!gfx) {
            gfx = new Node('AnchorHoles');
            gfx.layer = this._root!.layer;
            gfx.parent = this._backgroundRoot;
            gfx.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
            gfx.addComponent(Graphics);
        }
        const g = gfx.getComponent(Graphics)!;
        g.clear();
        const level8ReferenceStyle = this._isLevel8ReferenceStyle();
        for (const anchor of this._anchors) {
            if (!anchor || !anchor.node || !anchor.node.isValid) continue;
            const lp = anchor.node.position;
            if (level8ReferenceStyle) {
                g.fillColor = new Color(234, 156, 124, 80);
                g.circle(lp.x, lp.y, 24.5);
                g.fill();
                g.fillColor = new Color(113, 78, 58, 205);
                g.circle(lp.x, lp.y, 20.5);
                g.fill();
                g.fillColor = new Color(50, 47, 44, 255);
                g.circle(lp.x, lp.y, 15.5);
                g.fill();
                continue;
            }
            g.fillColor = new Color(64, 41, 20, 255);
            g.circle(lp.x, lp.y, VISUAL_HOLE_OUTER_RADIUS);
            g.fill();
            g.fillColor = new Color(13, 8, 5, 255);
            g.circle(lp.x, lp.y, VISUAL_HOLE_INNER_RADIUS);
            g.fill();
        }
    }

    private _buildHud() {
        const parent = this.node;
        const hud = new Node('HUD');
        hud.layer = parent.layer;
        hud.parent = parent;
        hud.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        hud.setPosition(0, 0, 0);

        // Level title (top-left).
        const levelLabel = this._makeLabel(hud, 'LevelLabel', '', 26);
        levelLabel.node.setPosition(g2c(190, 32).x, g2c(190, 32).y, 0);
        levelLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
        levelLabel.verticalAlign = Label.VerticalAlign.CENTER;
        levelLabel.getComponent(UITransform)!.setContentSize(340, 36);
        this._levelLabel = levelLabel;

        // Boards out counter.
        const boardsOut = this._makeLabel(hud, 'BoardsOutLabel', '', 18);
        boardsOut.node.setPosition(g2c(160, 70).x, g2c(160, 70).y, 0);
        boardsOut.horizontalAlign = Label.HorizontalAlign.LEFT;
        boardsOut.getComponent(UITransform)!.setContentSize(280, 30);
        this._boardsOutLabel = boardsOut;

        // Restart button (top-right).
        const restartBtn = this._makeButton(hud, 'RestartButton', '重开', 80, 36);
        restartBtn.node.setPosition(g2c(470, 34).x, g2c(470, 34).y, 0);
        restartBtn.node.on(Button.EventType.CLICK, () => this._restartLevel(), this);

        // Complete overlay (hidden by default).
        const overlay = new Node('CompleteOverlay');
        overlay.layer = parent.layer;
        overlay.parent = hud;
        overlay.active = false;
        const overlayUI = overlay.addComponent(UITransform);
        overlayUI.setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        overlay.setPosition(0, 0, 0);
        // Tint background.
        const dim = new Node('Dim');
        dim.layer = parent.layer;
        dim.parent = overlay;
        dim.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        const dimGfx = dim.addComponent(Graphics);
        dimGfx.fillColor = new Color(0, 0, 0, 160);
        dimGfx.rect(-VIEWPORT_WIDTH / 2, -VIEWPORT_HEIGHT / 2, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        dimGfx.fill();
        // Panel.
        const panel = new Node('Panel');
        panel.layer = parent.layer;
        panel.parent = overlay;
        panel.setPosition(0, 0, 0);
        const panelUI = panel.addComponent(UITransform);
        panelUI.setContentSize(380, 240);
        const panelGfx = panel.addComponent(Graphics);
        panelGfx.fillColor = new Color(245, 226, 195, 255);
        panelGfx.roundRect(-190, -120, 380, 240, 14);
        panelGfx.fill();
        panelGfx.lineWidth = 3;
        panelGfx.strokeColor = new Color(115, 71, 36, 255);
        panelGfx.roundRect(-190, -120, 380, 240, 14);
        panelGfx.stroke();

        const completeLabel = this._makeLabel(panel, 'CompleteLabel', '关卡完成', 24);
        completeLabel.node.setPosition(0, 60, 0);
        completeLabel.color = new Color(60, 36, 16, 255);
        completeLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        this._completeTitleLabel = completeLabel;

        const completeSub = this._makeLabel(panel, 'CompleteSubLabel', '', 16);
        completeSub.node.setPosition(0, 20, 0);
        completeSub.color = new Color(80, 50, 28, 255);
        completeSub.horizontalAlign = Label.HorizontalAlign.CENTER;
        completeSub.enableWrapText = true;
        completeSub.getComponent(UITransform)!.setContentSize(320, 50);
        this._completeSubLabel = completeSub;

        const restartLevelBtn = this._makeButton(panel, 'RestartLevelButton', '重玩本关', 140, 40);
        restartLevelBtn.node.setPosition(-80, -60, 0);
        restartLevelBtn.node.on(Button.EventType.CLICK, () => this._restartLevel(), this);

        const nextBtn = this._makeButton(panel, 'NextLevelButton', '下一关', 140, 40);
        nextBtn.node.setPosition(80, -60, 0);
        nextBtn.node.on(Button.EventType.CLICK, () => this._goToNextLevel(), this);
        this._completeNextButton = nextBtn;

        this._completeOverlay = overlay;
    }

    private _makeLabel(parent: Node, name: string, text: string, fontSize: number): Label {
        const n = new Node(name);
        n.layer = parent.layer;
        n.parent = parent;
        const ui = n.addComponent(UITransform);
        ui.setContentSize(VIEWPORT_WIDTH, 40);
        const label = n.addComponent(Label);
        label.fontSize = fontSize;
        label.lineHeight = fontSize + 4;
        label.string = text;
        label.color = new Color(255, 245, 220, 255);
        return label;
    }

    private _makeButton(parent: Node, name: string, text: string, w: number, h: number): Button {
        const n = new Node(name);
        n.layer = parent.layer;
        n.parent = parent;
        const ui = n.addComponent(UITransform);
        ui.setContentSize(w, h);

        const bg = n.addComponent(Graphics);
        bg.fillColor = new Color(196, 142, 73, 255);
        bg.roundRect(-w / 2, -h / 2, w, h, 6);
        bg.fill();
        bg.lineWidth = 2;
        bg.strokeColor = new Color(115, 71, 36, 255);
        bg.roundRect(-w / 2, -h / 2, w, h, 6);
        bg.stroke();

        const labelNode = new Node('Label');
        labelNode.layer = parent.layer;
        labelNode.parent = n;
        labelNode.addComponent(UITransform).setContentSize(w, h);
        const label = labelNode.addComponent(Label);
        label.fontSize = 16;
        label.lineHeight = 20;
        label.string = text;
        label.color = new Color(40, 22, 10, 255);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;

        return n.addComponent(Button);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Texture loading
    // ──────────────────────────────────────────────────────────────────────
    private _loadTextures(done: () => void) {
        const paths: { key: string; path: string }[] = [
            ...Array.from({ length: 10 }, (_, i) => ({
                key: `wood_${i + 1}`,
                path: `textures/wood_len_${i + 1}/spriteFrame`,
            })),
            { key: 'bolt_up', path: 'textures/luosi_up/spriteFrame' },
            { key: 'bolt_in', path: 'textures/luosi_in_hole/spriteFrame' },
        ];
        let pending = paths.length;
        for (const p of paths) {
            resources.load(p.path, SpriteFrame, (err, frame) => {
                if (!err && frame) {
                    if (p.key.startsWith('wood_')) {
                        this._woodFrames.set(parseInt(p.key.split('_')[1], 10), frame);
                    } else if (p.key === 'bolt_up') {
                        this._boltUpFrame = frame;
                    } else if (p.key === 'bolt_in') {
                        this._boltInHoleFrame = frame;
                    }
                } else {
                    console.warn(`[LevelController] Failed to load ${p.path}: ${err}`);
                }
                if (--pending === 0) done();
            });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Validation
    // ──────────────────────────────────────────────────────────────────────
    private _validateLevels() {
        for (let i = 0; i < this.levels.length; i++) {
            const lv = this.levels[i];
            const levelLabel = `${this.levelDifficulty} level ${i + 1} "${lv.title}"`;
            const anchorsById: Map<string, AnchorData> = new Map();
            const anchorIds: Set<string> = new Set();

            for (const anchor of lv.anchors) {
                if (anchorIds.has(anchor.id)) {
                    console.warn(`[LevelController] ${levelLabel}: duplicate anchor id "${anchor.id}"`);
                }
                anchorIds.add(anchor.id);
                anchorsById.set(anchor.id, anchor);
            }

            for (let a = 0; a < lv.anchors.length; a++) {
                for (let b = a + 1; b < lv.anchors.length; b++) {
                    const A = lv.anchors[a];
                    const B = lv.anchors[b];
                    const dx = A.x - B.x;
                    const dy = A.y - B.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < ANCHOR_MIN_DIST) {
                        console.warn(`[LevelController] ${levelLabel}: anchors ${A.id} and ${B.id} too close (${dist.toFixed(1)} < ${ANCHOR_MIN_DIST})`);
                    }
                }
            }

            const pieces: ValidationPieceSpec[] = [
                ...(lv.anchorPads ?? []).map((pad) => this._validationSpecFromPad(pad)),
                ...lv.boards.map((board) => this._validationSpecFromBoard(board)),
            ];
            const pieceIds: Set<string> = new Set();
            const occupiedAnchors = lv.anchors.filter((anchor) => anchor.occupied);

            for (const piece of pieces) {
                this._validatePieceLinks(levelLabel, piece, anchorsById, occupiedAnchors, pieceIds);
            }
        }
    }

    private _validationSpecFromBoard(data: BoardData): ValidationPieceSpec {
        return {
            id: data.id,
            kind: 'board',
            x: data.x,
            y: data.y,
            rotationDegrees: data.rotationDegrees,
            collisionWidth: data.collisionWidth,
            collisionHeight: data.collisionHeight,
            circleRadius: 0,
            shape: 'roundedRect',
            holeOffsets: data.holeOffsets,
            attachedAnchors: data.attachedAnchors,
        };
    }

    private _validationSpecFromPad(data: AnchorPadData): ValidationPieceSpec {
        const diameter = data.radius * 2;
        return {
            id: data.id,
            kind: 'anchorPad',
            x: data.x,
            y: data.y,
            rotationDegrees: 0,
            collisionWidth: diameter,
            collisionHeight: diameter,
            circleRadius: data.radius,
            shape: 'circle',
            holeOffsets: data.holeOffsets ?? [{ x: 0, y: 0 }],
            attachedAnchors: data.attachedAnchors,
        };
    }

    private _validatePieceLinks(
        levelLabel: string,
        piece: ValidationPieceSpec,
        anchorsById: Map<string, AnchorData>,
        occupiedAnchors: AnchorData[],
        pieceIds: Set<string>
    ) {
        if (pieceIds.has(piece.id)) {
            console.warn(`[LevelController] ${levelLabel}: duplicate piece id "${piece.id}"`);
        }
        pieceIds.add(piece.id);

        for (const anchorId of piece.attachedAnchors) {
            const anchor = anchorsById.get(anchorId);
            if (!anchor) {
                console.warn(`[LevelController] ${levelLabel}: ${piece.kind} "${piece.id}" attaches missing anchor "${anchorId}"`);
                continue;
            }
            if (!anchor.occupied) {
                console.warn(`[LevelController] ${levelLabel}: ${piece.kind} "${piece.id}" attaches empty anchor "${anchorId}"`);
            }
            if (!this._hasValidationHoleAt(piece, anchor.x, anchor.y, 3)) {
                console.warn(`[LevelController] ${levelLabel}: ${piece.kind} "${piece.id}" is attached to "${anchorId}" but has no aligned hole there`);
            }
        }

        for (const anchor of occupiedAnchors) {
            const hasAlignedHole = this._hasValidationHoleAt(piece, anchor.x, anchor.y, 3);
            const isAttached = piece.attachedAnchors.indexOf(anchor.id) >= 0;
            if (hasAlignedHole && !isAttached) {
                console.warn(`[LevelController] ${levelLabel}: ${piece.kind} "${piece.id}" has a hole at occupied anchor "${anchor.id}" but is not attached`);
                continue;
            }
            if (!isAttached && this._validationPieceBlocksAnchor(piece, anchor, SUPPORT_COLLISION_RADIUS)) {
                console.warn(`[LevelController] ${levelLabel}: ${piece.kind} "${piece.id}" overlaps occupied anchor "${anchor.id}" without a drilled hole/attachment`);
            }
        }
    }

    private _validationWorldToLocal(piece: ValidationPieceSpec, x: number, y: number): { x: number; y: number } {
        const dx = x - piece.x;
        // Authored coordinates are Y-down, but board-local hole Y is Cocos-style Y-up.
        const dy = -(y - piece.y);
        const angleRad = (-piece.rotationDegrees * Math.PI) / 180;
        const cos = Math.cos(-angleRad);
        const sin = Math.sin(-angleRad);
        return {
            x: dx * cos - dy * sin,
            y: dx * sin + dy * cos,
        };
    }

    private _hasValidationHoleAt(piece: ValidationPieceSpec, x: number, y: number, tolerance: number): boolean {
        const local = this._validationWorldToLocal(piece, x, y);
        for (const hole of piece.holeOffsets) {
            const dx = local.x - hole.x;
            const dy = local.y - hole.y;
            if (Math.sqrt(dx * dx + dy * dy) <= tolerance) return true;
        }
        return false;
    }

    private _validationPieceBlocksAnchor(piece: ValidationPieceSpec, anchor: AnchorData, radius: number): boolean {
        if (this._hasValidationHoleAt(piece, anchor.x, anchor.y, BOLT_RADIUS + 2)) return false;

        const local = this._validationWorldToLocal(piece, anchor.x, anchor.y);
        let outside: number;
        if (piece.shape === 'circle') {
            outside = Math.max(Math.sqrt(local.x * local.x + local.y * local.y) - piece.circleRadius, 0);
        } else {
            const halfW = Math.max(piece.collisionWidth * 0.5 - WOOD_COLLISION_SKIN, 0);
            const halfH = Math.max(piece.collisionHeight * 0.5 - WOOD_COLLISION_SKIN, 0);
            const radius = Math.max(Math.min(
                WOOD_CORNER_RADIUS - WOOD_COLLISION_SKIN,
                halfW,
                halfH
            ), 0);
            const qx = Math.abs(local.x) - Math.max(halfW - radius, 0);
            const qy = Math.abs(local.y) - Math.max(halfH - radius, 0);
            outside = Math.max(
                Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
                    + Math.min(Math.max(qx, qy), 0)
                    - radius,
                0
            );
        }
        return outside < radius;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Level load
    // ──────────────────────────────────────────────────────────────────────
    private _loadLevel(index: number) {
        if (index < 0 || index >= this.levels.length) return;
        this._currentIndex = index;
        this._clearSelection();
        this._clearLevelNodes();

        this._levelComplete = false;
        this._boardsExited = 0;
        if (this._completeOverlay) this._completeOverlay.active = false;

        const lv = this.levels[index];
        this._currentInstruction = lv.instruction || DEFAULT_INSTRUCTION;

        const bgGfx = this._backgroundRoot?.getComponent(Graphics);
        if (bgGfx) {
            bgGfx.clear();
            this._drawBackground(bgGfx, this._isLevel8ReferenceStyle());
        }

        for (const ad of lv.anchors) {
            this._spawnAnchor(ad);
        }
        for (const pad of lv.anchorPads ?? []) {
            this._spawnAnchorPad(pad);
        }
        for (const bd of lv.boards) {
            this._spawnBoard(bd);
        }
        this._sortBoardsByRenderOrder();

        // After anchors and boards are positioned, attach boards to their anchors.
        for (const pad of lv.anchorPads ?? []) {
            const board = this._boardById.get(pad.id);
            if (!board) continue;
            for (const anchorId of pad.attachedAnchors) {
                const anchor = this._anchorById.get(anchorId);
                if (anchor) this._attachBoardIfPossible(board, anchor);
            }
        }
        for (const bd of lv.boards) {
            const board = this._boardById.get(bd.id);
            if (!board) continue;
            for (const anchorId of bd.attachedAnchors) {
                const anchor = this._anchorById.get(anchorId);
                if (anchor) this._attachBoardIfPossible(board, anchor);
            }
        }
        // Joint creation can wake dynamic bodies. Sleep only after every
        // authored constraint has been created so a freshly loaded level does
        // not settle, swing, or fall before the player moves a screw.
        this._sleepInitiallyConstrainedBoards();

        this._boardsTotal = this._boards.length;
        if (this._levelLabel) this._levelLabel.string = lv.title;
        if (this._completeTitleLabel) this._completeTitleLabel.string = lv.completeTitle;
        if (this._completeSubLabel) this._completeSubLabel.string = lv.completeSubtitle;
        if (this._completeNextButton) this._completeNextButton.node.active = index < this.levels.length - 1;

        this._updateHud();
        this._drawAnchorHoles();
        this._refreshAnchorCoverState();
        this._setInstruction(this._currentInstruction);
    }

    private _clearLevelNodes() {
        this._anchors = [];
        this._boards = [];
        this._anchorById.clear();
        this._boardById.clear();
        this._anchorBoardLinks.clear();
        this._anchorJointLinks.clear();
        this._pendingSupportActivations.clear();
        this._releasedHorizontalSlides.clear();
        this._anchorCoverRefreshTimer = 0;
        this._insertionQuietAge = INSERTION_SETTLE_REQUIRED_TIME;
        this._selectedAnchor = null;

        this._destroyChildren(this._anchorsRoot);
        this._destroyChildren(this._boardsRoot);
    }

    private _destroyChildren(parent: Node | null) {
        if (!parent) return;
        for (const child of parent.children.slice()) {
            child.removeFromParent();
            child.destroy();
        }
    }

    private _sleepInitiallyConstrainedBoards() {
        for (const board of this._boards) {
            const rb = board.rigidBody;
            if (!board.isValid || !rb || this._getBoardSupportCount(board) === 0) continue;
            rb.linearVelocity = new Vec2(0, 0);
            rb.angularVelocity = 0;
            rb.sleep();
        }
    }

    private _spawnAnchor(data: AnchorData) {
        const n = new Node(data.id);
        n.layer = this._root!.layer;
        n.parent = this._anchorsRoot!;
        const local = g2c(data.x, data.y);
        n.setPosition(local.x, local.y, 0);

        // Touchable area - UITransform sized larger than bolt radius for easy tapping.
        const ui = n.addComponent(UITransform);
        ui.setContentSize(BOLT_DIAMETER + 20, BOLT_DIAMETER + 20);
        ui.setAnchorPoint(0.5, 0.5);

        // Highlight + bolt sprite children.
        const highlightNode = new Node('Highlight');
        highlightNode.layer = n.layer;
        highlightNode.parent = n;
        highlightNode.addComponent(UITransform).setContentSize(60, 60);
        const highlightGfx = highlightNode.addComponent(Graphics);

        const boltNode = new Node('Bolt');
        boltNode.layer = n.layer;
        boltNode.parent = n;
        boltNode.addComponent(UITransform).setContentSize(BOLT_DIAMETER, BOLT_DIAMETER);
        const boltSprite = boltNode.addComponent(Sprite);
        boltSprite.spriteFrame = this._boltInHoleFrame;
        boltSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        boltNode.getComponent(UITransform)!.setContentSize(BOLT_DIAMETER, BOLT_DIAMETER);
        if (this._isLevel8ReferenceStyle()) {
            boltSprite.color = new Color(255, 255, 245, 255);
            boltNode.setScale(1.12, 1.12, 1);
        }

        // Component setup.
        const anchor = n.addComponent(AnchorPoint);
        anchor.anchorId = data.id;
        anchor.occupied = data.occupied;
        anchor.onAnchorPressed = (a) => this._onAnchorPressed(a);
        anchor.initVisuals(boltNode, boltSprite, highlightGfx);

        // Support body (static circle the board pins onto).
        const supportNode = new Node('Support');
        supportNode.layer = n.layer;
        supportNode.parent = n;
        supportNode.addComponent(UITransform).setContentSize(BOLT_DIAMETER, BOLT_DIAMETER);
        const body = supportNode.addComponent(RigidBody2D);
        body.type = ERigidBody2DType.Static;
        const supportCollider = supportNode.addComponent(CircleCollider2D);
        supportCollider.radius = SUPPORT_COLLISION_RADIUS;
        supportCollider.group = GROUP_SUPPORT;
        supportCollider.friction = 0.03;
        supportCollider.restitution = 0.01;
        // Solid (non-sensor) so boards that aren't joined to this screw get
        // physically blocked by it — that's how an unjoined screw "holds" a
        // board after one of its own bolts is removed.
        supportCollider.apply();
        anchor.initSupport(supportNode, body, supportCollider);

        this._anchors.push(anchor);
        this._anchorById.set(data.id, anchor);
    }

    private _spawnAnchorPad(data: AnchorPadData) {
        const n = new Node(data.id);
        n.layer = this._root!.layer;
        n.parent = this._boardsRoot!;
        const local = g2c(data.x, data.y);
        n.setPosition(local.x, local.y, 0);

        const diameter = data.radius * 2;
        const ui = n.addComponent(UITransform);
        ui.setContentSize(diameter, diameter);
        ui.setAnchorPoint(0.5, 0.5);

        const padHoles = data.holeOffsets ?? [{ x: 0, y: 0 }];
        const visual = this._createHoleCutoutMask(n, diameter, diameter, padHoles);
        const bodyNode = new Node('Wood');
        bodyNode.layer = n.layer;
        bodyNode.parent = visual;
        bodyNode.addComponent(UITransform).setContentSize(diameter, diameter);
        const gfx = bodyNode.addComponent(Graphics);
        const level8ReferenceStyle = this._isLevel8ReferenceStyle();
        gfx.fillColor = level8ReferenceStyle
            ? new Color(211, 139, 72, 250)
            : new Color(188, 119, 55, 245);
        gfx.circle(0, 0, data.radius);
        gfx.fill();
        if (level8ReferenceStyle) {
            gfx.fillColor = new Color(250, 189, 111, 58);
            gfx.circle(-2, 3, data.radius - 4);
            gfx.fill();
        }
        gfx.lineWidth = 2.5;
        gfx.strokeColor = new Color(13, 8, 5, 245);
        gfx.circle(0, 0, data.radius);
        gfx.stroke();

        if (level8ReferenceStyle) {
            // The two source disks use sparse vertical grain instead of rings.
            gfx.lineWidth = 1.5;
            gfx.strokeColor = new Color(143, 79, 36, 80);
            for (const offset of [-0.55, -0.28, 0, 0.28, 0.55]) {
                const x = data.radius * offset;
                const halfSpan = data.radius * Math.sqrt(Math.max(0, 0.72 - offset * offset));
                gfx.moveTo(x, -halfSpan);
                gfx.bezierCurveTo(
                    x - data.radius * 0.08, -halfSpan * 0.35,
                    x + data.radius * 0.08, halfSpan * 0.35,
                    x, halfSpan,
                );
            }
            gfx.stroke();
        } else {
            // Concentric wood-grain rings, matching the other reference-image pads.
            gfx.lineWidth = 1.2;
            gfx.strokeColor = new Color(135, 82, 39, 100);
            gfx.circle(data.radius * 0.08, -data.radius * 0.02, data.radius * 0.56);
            gfx.stroke();
            gfx.circle(-data.radius * 0.10, data.radius * 0.04, data.radius * 0.82);
            gfx.stroke();
        }

        // Holes are visible after the screw leaves, covered by screw sprites
        // while occupied because the Anchors root is drawn above Boards.
        const overlay = new Node('Holes');
        overlay.layer = n.layer;
        overlay.parent = n;
        overlay.addComponent(UITransform).setContentSize(diameter, diameter);
        this._drawHoleRims(overlay.addComponent(Graphics), padHoles);

        const body = n.addComponent(RigidBody2D);
        body.type = ERigidBody2DType.Dynamic;
        body.linearDamping = 0.08;
        body.angularDamping = 0.04;
        body.gravityScale = 1.0;
        body.allowSleep = true;
        body.awakeOnLoad = false;
        body.enabledContactListener = false;

        const collider = n.addComponent(CircleCollider2D);
        collider.radius = data.radius;
        collider.friction = 1.2;
        collider.restitution = 0.08;
        collider.density = 0.85;
        collider.group = GROUP_BOARD_PINNED;
        collider.apply();

        const board = n.addComponent(BoardPiece);
        board.boardId = data.id;
        board.collisionWidth = diameter;
        board.collisionHeight = diameter;
        board.holeOffsets = padHoles.map((h) => new Vec2(h.x, h.y));
        board.renderOrder = data.renderOrder;
        board.shape = 'circle';
        board.circleRadius = data.radius;
        board.rigidBody = body;
        board.collider = collider;
        board.overlayNode = overlay;

        this._boards.push(board);
        this._boardById.set(data.id, board);
    }

    private _spawnBoard(data: BoardData) {
        const n = new Node(data.id);
        n.layer = this._root!.layer;
        n.parent = this._boardsRoot!;
        const local = g2c(data.x, data.y);
        n.setPosition(local.x, local.y, 0);
        // Rotation: Godot rotation_degrees is clockwise; Cocos is counter-clockwise.
        n.setRotationFromEuler(0, 0, g2cAngle(data.rotationDegrees));

        const ui = n.addComponent(UITransform);
        ui.setContentSize(data.collisionWidth, data.collisionHeight);
        ui.setAnchorPoint(0.5, 0.5);

        const visual = this._createHoleCutoutMask(
            n,
            data.collisionWidth,
            data.collisionHeight,
            data.holeOffsets,
        );

        // Sprite child (visual stretched to collision dims).
        const spriteNode = new Node('Sprite');
        spriteNode.layer = n.layer;
        spriteNode.parent = visual;
        const spriteUI = spriteNode.addComponent(UITransform);
        spriteUI.setContentSize(data.collisionWidth, data.collisionHeight);
        spriteUI.setAnchorPoint(0.5, 0.5);
        const sprite = spriteNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.spriteFrame = this._woodFrames.get(data.textureIndex) ?? this._woodFrames.get(1)!;
        spriteUI.setContentSize(data.collisionWidth, data.collisionHeight);

        if (this._isLevel8ReferenceStyle()) {
            const toneNode = new Node('WoodTone');
            toneNode.layer = n.layer;
            toneNode.parent = visual;
            toneNode.addComponent(UITransform).setContentSize(data.collisionWidth, data.collisionHeight);
            const tone = toneNode.addComponent(Graphics);
            tone.fillColor = new Color(230, 171, 91, 70);
            tone.roundRect(
                -data.collisionWidth * 0.5 + 3,
                -data.collisionHeight * 0.5 + 3,
                data.collisionWidth - 6,
                data.collisionHeight - 6,
                Math.max(4, WOOD_CORNER_RADIUS - 3),
            );
            tone.fill();
        }

        // Keep the dark inner wall on top of the transparent sprite cutout.
        const overlay = new Node('Holes');
        overlay.layer = n.layer;
        overlay.parent = n;
        overlay.addComponent(UITransform).setContentSize(data.collisionWidth, data.collisionHeight);
        this._drawHoleRims(overlay.addComponent(Graphics), data.holeOffsets);

        // Physics.
        const body = n.addComponent(RigidBody2D);
        body.type = ERigidBody2DType.Dynamic;
        body.linearDamping = data.linearDamp;
        body.angularDamping = data.angularDamp;
        body.gravityScale = 1.0;
        body.allowSleep = true;
        body.awakeOnLoad = false;
        body.enabledContactListener = false;

        const collider = this._addWoodRoundedRectCollider(n, data.collisionWidth, data.collisionHeight);

        // BoardPiece component.
        const board = n.addComponent(BoardPiece);
        board.boardId = data.id;
        board.collisionWidth = data.collisionWidth;
        board.collisionHeight = data.collisionHeight;
        board.holeOffsets = data.holeOffsets.map((h) => new Vec2(h.x, h.y));
        board.renderOrder = data.renderOrder;
        board.rigidBody = body;
        board.collider = collider;
        board.shape = 'roundedRect';
        board.cornerRadius = WOOD_CORNER_RADIUS;
        board.collisionInset = WOOD_COLLISION_SKIN;
        board.spriteNode = spriteNode;
        board.overlayNode = overlay;
        collider.on(Contact2DType.PRE_SOLVE, this._onBoardPreSolve, this);

        // Z order via siblingIndex (higher renderOrder = drawn last = on top).
        // We'll sort after all boards are added.

        this._boards.push(board);
        this._boardById.set(data.id, board);
    }

    private _createHoleCutoutMask(
        parent: Node,
        width: number,
        height: number,
        holes: readonly { x: number; y: number }[],
    ): Node {
        const visual = new Node('WoodCutout');
        visual.layer = parent.layer;
        visual.parent = parent;
        const visualUI = visual.addComponent(UITransform);
        visualUI.setContentSize(width, height);
        visualUI.setAnchorPoint(0.5, 0.5);

        const mask = visual.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_STENCIL;
        mask.inverted = true;
        const stencil = visual.getComponent(Graphics)!;
        stencil.clear();
        stencil.fillColor = Color.WHITE;
        for (const hole of holes) {
            stencil.circle(hole.x, hole.y, VISUAL_HOLE_INNER_RADIUS);
            stencil.fill();
        }
        return visual;
    }

    private _drawHoleRims(
        graphics: Graphics,
        holes: readonly { x: number; y: number }[],
    ) {
        graphics.lineWidth = VISUAL_HOLE_OUTER_RADIUS - VISUAL_HOLE_INNER_RADIUS;
        graphics.strokeColor = new Color(64, 38, 20, 220);
        const ringRadius = (VISUAL_HOLE_OUTER_RADIUS + VISUAL_HOLE_INNER_RADIUS) * 0.5;
        for (const hole of holes) {
            graphics.circle(hole.x, hole.y, ringRadius);
            graphics.stroke();
        }
    }

    private _addWoodRoundedRectCollider(
        node: Node,
        collisionWidth: number,
        collisionHeight: number
    ): PolygonCollider2D {
        const halfW = Math.max(collisionWidth * 0.5 - WOOD_COLLISION_SKIN, 1);
        const halfH = Math.max(collisionHeight * 0.5 - WOOD_COLLISION_SKIN, 1);
        const radius = Math.max(Math.min(
            WOOD_CORNER_RADIUS - WOOD_COLLISION_SKIN,
            halfW,
            halfH
        ), 0);
        const collider = node.addComponent(PolygonCollider2D);
        collider.points = [
            new Vec2(-halfW + radius, -halfH),
            new Vec2(halfW - radius, -halfH),
            new Vec2(halfW, -halfH + radius),
            new Vec2(halfW, halfH - radius),
            new Vec2(halfW - radius, halfH),
            new Vec2(-halfW + radius, halfH),
            new Vec2(-halfW, halfH - radius),
            new Vec2(-halfW, -halfH + radius),
        ];
        this._applyWoodColliderMaterial(collider);
        return collider;
    }

    private _applyWoodColliderMaterial(collider: PolygonCollider2D) {
        collider.friction = WOOD_FRICTION;
        collider.restitution = WOOD_RESTITUTION;
        collider.density = WOOD_DENSITY;
        collider.group = GROUP_BOARD_PINNED;
        collider.apply();
    }

    private _setBoardCollisionGroup(board: BoardPiece, group: number) {
        if (!board.node || !board.node.isValid) return;
        const colliders: (BoxCollider2D | CircleCollider2D | PolygonCollider2D)[] = [
            ...board.node.getComponents(BoxCollider2D),
            ...board.node.getComponents(CircleCollider2D),
            ...board.node.getComponents(PolygonCollider2D),
        ];
        for (const collider of colliders) {
            collider.group = group;
            collider.apply();
        }
    }

    private _sortBoardsByRenderOrder() {
        if (!this._boardsRoot) return;
        const ordered = this._boards
            .map((board, index) => ({ board, index }))
            .sort((a, b) => {
                const byOrder = a.board.renderOrder - b.board.renderOrder;
                return byOrder !== 0 ? byOrder : a.index - b.index;
            });
        for (let i = 0; i < ordered.length; i++) {
            ordered[i].board.node.setSiblingIndex(i);
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Click handling - mirrors Godot _on_anchor_pressed
    // ──────────────────────────────────────────────────────────────────────
    private _onAnchorPressed(anchor: AnchorPoint) {
        if (this._levelComplete) return;

        if (!this._selectedAnchor) {
            if (!anchor.hasBolt()) {
                this._setInstruction('先选一颗有螺丝的锚点。');
                return;
            }
            this._selectedAnchor = anchor;
            anchor.setSelected(true);
            this._setInstruction('已选中螺丝，点击一个空位把它放过去。');
            return;
        }

        if (anchor === this._selectedAnchor) {
            this._clearSelection();
            this._setInstruction(this._currentInstruction);
            return;
        }

        if (anchor.hasBolt()) {
            this._selectedAnchor.setSelected(false);
            this._selectedAnchor = anchor;
            anchor.setSelected(true);
            this._setInstruction('已切换螺丝，选择一个空位继续。');
            return;
        }

        if (!this._isInsertionPhysicsSettledAt(anchor)) {
            this._setInstruction('目标孔附近的木条还在移动，等它稳定后再插入。');
            return;
        }

        if (this._isAnchorBlocked(anchor)) {
            this._setInstruction('这个空位被木条或圆盘的实体部分挡住了。');
            return;
        }

        this._moveSelectedBolt(anchor);
    }

    private _moveSelectedBolt(target: AnchorPoint) {
        const source = this._selectedAnchor!;
        const detached = this._detachAnchor(source);
        source.setBoltPresent(false);
        this._pendingSupportActivations.delete(source);
        source.setSelected(false);
        target.setBoltPresent(true);
        this._insertionQuietAge = 0;
        // Keep the visual screw visible immediately, but do not let its solid
        // peg collider participate until all detach/reattach bookkeeping below
        // is complete and the delayed overlap gate has run. This avoids a
        // one-frame Box2D separation impulse when a valid visual hole is close
        // to other layered wood.
        this._setSupportColliderEnabled(target, false);
        this._selectedAnchor = null;

        const attached = this._attachAllPossibleBoards(target);

        let releasedCount = 0;
        let partial = 0;
        for (const board of detached) {
            if (!board.isValid) continue;
            if (this._isBoardAttachedToAnchor(board, target)) continue;
            this._reattachBoardToOccupiedAnchors(board);
            const supportCount = this._getBoardSupportCount(board);
            if (supportCount > 0) {
                partial++;
                this._wakePartiallyReleasedPiece(board);
            } else {
                releasedCount++;
                this._wakeFullyReleasedPiece(board);
            }
        }

        this._deferSupportActivationIfOverlapping(target, SUPPORT_INSERT_ACTIVATION_DELAY);
        this._refreshAnchorCoverState();

        if (releasedCount > 0) {
            this._setInstruction(releasedCount > 1
                ? '共享螺丝被挪开了，多块木条都松开了！'
                : '木条松开了，等它掉出区域。');
            return;
        }
        if (partial > 0) {
            this._setInstruction(detached.length > 1
                ? '共享螺丝同时固定多块木条，先处理剩下的支撑。'
                : '木条还挂着，继续拆下一颗支撑螺丝。');
            return;
        }
        if (attached.length > 0) {
            this._setInstruction(attached.length > 1
                ? '螺丝穿过了重叠孔位，同时固定了多块木条。'
                : '螺丝移动成功。');
            return;
        }
        this._setInstruction('停车位腾出来了，继续拆剩下的螺丝。');
    }

    private _wakePartiallyReleasedPiece(board: BoardPiece) {
        const rb = board.rigidBody;
        if (!rb) return;
        this._stopReleasedHorizontalSlide(board);
        // A piece with remaining screws stays governed by its hinge(s), gravity,
        // and peg contacts. Never inject a center/linear impulse: that violates
        // the constraint solver and was the main source of wood visibly popping
        // away from a screw. The one exact upright lower-pivot exception below
        // receives only a one-time minimal angular start.
        rb.wakeUp();
        this._setBoardCollisionGroup(board, GROUP_BOARD_PINNED);

        if (this._isNearAnchoredVerticalPivotWood(board)) {
            if (this._hasSingleUpperHangingSupport(board)) {
                this._settleUpperHangingVerticalPiece(board);
                return;
            }
            if (this._hasSingleLowerSupport(board)) {
                // A perfectly upright body pinned below its center has exactly
                // zero gravitational torque. Apply one small angular impulse to
                // choose a side, then leave all subsequent motion to Box2D.
                this._applyAnchoredVerticalPivotNudge(board);
            }
        }
    }

    private _wakeFullyReleasedPiece(board: BoardPiece) {
        const rb = board.rigidBody;
        if (!rb) return;
        if (this._isLevel8ReferenceStyle()) {
            // The reference packs a dense screw grid below several released
            // pieces. Only a genuinely zero-support piece enters the isolated
            // released group; that group ignores overlapping wood layers but
            // deliberately retains solid screw-support contacts for both wood
            // strips and circular pads.
            this._stopReleasedHorizontalSlide(board);
            this._setBoardCollisionGroup(board, GROUP_LEVEL8_FULLY_RELEASED);
            rb.allowSleep = false;
            rb.enabledContactListener = false;
            rb.wakeUp();
            return;
        }
        if (board.shape !== 'circle') {
            // Cocos registers a Box2D fixture for PRE_SOLVE reporting only
            // while regenerating that fixture. Enable reporting before the
            // group change calls collider.apply(), otherwise toggling this flag
            // afterward leaves the released fixture absent from the contact
            // listener and the native friction override never runs.
            rb.allowSleep = true;
            rb.enabledContactListener = true;
            this._releasedHorizontalSlides.set(board, {
                age: 0,
                releaseY: board.node.worldPosition.y,
                sawMajorFall: false,
                gliding: false,
                completed: false,
                quietAge: 0,
                surfaceCollisionsEnabled: false,
                glidingOnBoardSurface: false,
            });
        }
        this._setBoardCollisionGroup(board, GROUP_BOARD_RELEASED);
        rb.wakeUp();
    }

    private _untrackReleasedPiece(board: BoardPiece) {
        this._stopReleasedHorizontalSlide(board);
        if (board.isValid && this._getBoardSupportCount(board) > 0) {
            this._setBoardCollisionGroup(board, GROUP_BOARD_PINNED);
        }
    }

    private _stopReleasedHorizontalSlide(board: BoardPiece) {
        const rb = board.rigidBody;
        const state = this._releasedHorizontalSlides.get(board);
        if (state?.surfaceCollisionsEnabled && board.isValid) {
            this._setBoardCollisionGroup(board, GROUP_BOARD_RELEASED);
        }
        this._releasedHorizontalSlides.delete(board);
        if (!rb) return;
        rb.allowSleep = true;
        rb.enabledContactListener = false;
    }

    private _updateReleasedHorizontalSlides(dt: number) {
        if (this._releasedHorizontalSlides.size === 0) return;
        const step = dt > 0 && dt < 0.1 ? dt : 1 / 60;

        for (const [board, state] of Array.from(this._releasedHorizontalSlides.entries())) {
            const rb = board.rigidBody;
            if (!board.isValid || !rb) {
                this._releasedHorizontalSlides.delete(board);
                continue;
            }
            if (board.shape === 'circle' || this._getBoardSupportCount(board) > 0) {
                this._stopReleasedHorizontalSlide(board);
                continue;
            }

            state.age += step;
            const velocity = rb.linearVelocity;
            const fallDistance = state.releaseY - board.node.worldPosition.y;
            if (fallDistance >= FREE_HORIZONTAL_SLIDE_MAJOR_FALL_DISTANCE
                || velocity.y <= -FREE_HORIZONTAL_SLIDE_MAJOR_FALL_SPEED) {
                state.sawMajorFall = true;
            }

            if (state.completed) {
                if (state.glidingOnBoardSurface) {
                    // Keep the selective board contact alive after coming to
                    // rest so the strip remains on the lower wood. If either
                    // body later tips or falls, return to the ordinary ghost
                    // group before any cross-layer impulse can be solved.
                    const remainsOnStableBoardSurface = this._isStableHorizontalBoardSurface(board);
                    if (remainsOnStableBoardSurface) continue;
                    state.completed = false;
                    state.glidingOnBoardSurface = false;
                    state.quietAge = 0;
                    this._setReleasedBoardSurfaceCollisions(board, state, false);
                    rb.allowSleep = true;
                    continue;
                }

                // Screw-support contacts need PRE_SOLVE briefly to restore the
                // normal mixed friction, then can return to ordinary sleeping.
                state.quietAge += step;
                if (state.quietAge >= FREE_HORIZONTAL_SLIDE_STOP_QUIET_TIME) {
                    this._stopReleasedHorizontalSlide(board);
                }
                continue;
            }
            if (!state.gliding) {
                const shouldEnableBoardSurface = this._canArmReleasedBoardSurface(board, state);
                this._setReleasedBoardSurfaceCollisions(board, state, shouldEnableBoardSurface);

                // A released strip that settles without ever qualifying (for
                // example, no horizontal momentum or a tipped landing) no
                // longer needs contact callbacks. Do not keep a dormant body
                // in the tracking map indefinitely.
                if (!rb.isAwake()) this._stopReleasedHorizontalSlide(board);
                continue;
            }

            const remainsAStableHorizontalSlide = this._isNearHorizontalFreeWood(board)
                && Math.abs(rb.angularVelocity) <= FREE_HORIZONTAL_SLIDE_MAX_ANGULAR_SPEED
                && Math.abs(velocity.y) <= FREE_HORIZONTAL_SLIDE_MAX_VERTICAL_SPEED;
            if (!remainsAStableHorizontalSlide) {
                // It bounced, tipped, or fell off the support. Restore ordinary
                // sleep/friction behavior; a later genuine landing may qualify
                // again without carrying any artificial velocity across states.
                state.gliding = false;
                state.glidingOnBoardSurface = false;
                state.quietAge = 0;
                this._setReleasedBoardSurfaceCollisions(board, state, false);
                rb.allowSleep = true;
                continue;
            }

            if (Math.abs(velocity.x) > FREE_HORIZONTAL_SLIDE_STOP_SPEED) {
                state.quietAge = 0;
                continue;
            }

            state.quietAge += step;
            if (state.quietAge >= FREE_HORIZONTAL_SLIDE_STOP_QUIET_TIME) {
                state.gliding = false;
                state.completed = true;
                state.quietAge = 0;
                rb.allowSleep = true;
            }
        }
    }

    private _setReleasedBoardSurfaceCollisions(
        board: BoardPiece,
        state: ReleasedHorizontalSlideState,
        enabled: boolean
    ) {
        if (state.surfaceCollisionsEnabled === enabled) return;
        state.surfaceCollisionsEnabled = enabled;
        const rb = board.rigidBody;
        if (rb) rb.enabledContactListener = true;
        this._setBoardCollisionGroup(
            board,
            enabled ? GROUP_BOARD_FREE_SURFACE : GROUP_BOARD_RELEASED
        );
    }

    private _canArmReleasedBoardSurface(
        board: BoardPiece,
        state: ReleasedHorizontalSlideState
    ): boolean {
        const rb = board.rigidBody;
        if (!rb || this._getBoardSupportCount(board) > 0) return false;
        const velocity = rb.linearVelocity;
        return state.age >= FREE_HORIZONTAL_SLIDE_MIN_RELEASE_AGE
            && state.sawMajorFall
            && this._isNearHorizontalFreeWood(board)
            && Math.abs(rb.angularVelocity) <= FREE_HORIZONTAL_SLIDE_MAX_ANGULAR_SPEED
            && velocity.y < -0.1
            && Math.abs(velocity.x) >= FREE_HORIZONTAL_SLIDE_MIN_START_SPEED
            && this._hasPotentialHorizontalBoardSurfaceBelow(board);
    }

    private _hasPotentialHorizontalBoardSurfaceBelow(board: BoardPiece): boolean {
        const ownAabb = board.collider?.enabled ? board.collider.worldAABB : null;
        if (!ownAabb) return false;

        for (const other of this._boards) {
            if (other === board || !other.isValid || !this._isStableHorizontalBoardSurface(other)) {
                continue;
            }
            if (other.node.worldPosition.y >= board.node.worldPosition.y - 4) continue;
            const otherAabb = other.collider?.worldAABB;
            if (!otherAabb) continue;

            const overlapX = Math.min(ownAabb.xMax, otherAabb.xMax)
                - Math.max(ownAabb.xMin, otherAabb.xMin);
            if (overlapX < FREE_HORIZONTAL_SURFACE_MIN_X_OVERLAP) continue;

            const verticalGap = ownAabb.yMin - otherAabb.yMax;
            if (verticalGap >= -FREE_HORIZONTAL_SURFACE_MAX_PENETRATION
                && verticalGap <= FREE_HORIZONTAL_SURFACE_SCAN_DISTANCE) {
                return true;
            }
        }
        return false;
    }

    private _onBoardPreSolve(
        selfCollider: Collider2D,
        otherCollider: Collider2D,
        contact: IPhysics2DContact | null
    ) {
        if (!contact || !otherCollider) return;
        const otherBoard = otherCollider.node.getComponent(BoardPiece);
        if (otherBoard) {
            this._onBoardSurfacePreSolve(selfCollider, otherCollider, contact);
            return;
        }
        if (otherCollider.group !== GROUP_SUPPORT) return;
        const defaultFriction = Math.sqrt(
            Math.max(selfCollider.friction, 0) * Math.max(otherCollider.friction, 0)
        );
        const restoreDefaultFriction = () => contact.setFriction(defaultFriction);
        const board = selfCollider.node.getComponent(BoardPiece);
        if (!board || !board.rigidBody) {
            restoreDefaultFriction();
            return;
        }

        const state = this._releasedHorizontalSlides.get(board);
        const rb = board.rigidBody;
        if (!state || state.completed || this._getBoardSupportCount(board) > 0) {
            restoreDefaultFriction();
            return;
        }

        const normalY = Math.abs(contact.getWorldManifold().normal.y);
        const horizontalSurfaceContact = normalY >= FREE_HORIZONTAL_SLIDE_MIN_CONTACT_NORMAL_Y;
        const stableOrientation = this._isNearHorizontalFreeWood(board)
            && Math.abs(rb.angularVelocity) <= FREE_HORIZONTAL_SLIDE_MAX_ANGULAR_SPEED;

        if (state.gliding) {
            if (horizontalSurfaceContact && stableOrientation) {
                contact.setFriction(FREE_HORIZONTAL_SLIDE_CONTACT_FRICTION);
            } else {
                restoreDefaultFriction();
            }
            return;
        }

        const velocity = rb.linearVelocity;
        const canStartGliding = state.age >= FREE_HORIZONTAL_SLIDE_MIN_RELEASE_AGE
            && state.sawMajorFall
            && horizontalSurfaceContact
            && stableOrientation
            && velocity.y < -0.1
            && Math.abs(velocity.x) >= FREE_HORIZONTAL_SLIDE_MIN_START_SPEED;
        if (!canStartGliding) {
            restoreDefaultFriction();
            return;
        }

        // No velocity is synthesized here. PRE_SOLVE only prevents the first
        // static-friction impulse from erasing the body's existing tangent
        // momentum; Box2D contacts plus the authored linear damping own every
        // subsequent change in speed and direction.
        state.gliding = true;
        state.glidingOnBoardSurface = false;
        state.quietAge = 0;
        rb.allowSleep = false;
        rb.wakeUp();
        contact.setFriction(FREE_HORIZONTAL_SLIDE_CONTACT_FRICTION);
    }

    private _onBoardSurfacePreSolve(
        selfCollider: Collider2D,
        otherCollider: Collider2D,
        contact: IPhysics2DContact
    ) {
        const selfBoard = selfCollider.node.getComponent(BoardPiece);
        const otherBoard = otherCollider.node.getComponent(BoardPiece);
        if (!selfBoard || !otherBoard) {
            contact.disabledOnce = true;
            return;
        }

        const selfIsUpper = selfBoard.node.worldPosition.y >= otherBoard.node.worldPosition.y;
        const upperBoard = selfIsUpper ? selfBoard : otherBoard;
        const upperCollider = selfIsUpper ? selfCollider : otherCollider;
        const lowerBoard = selfIsUpper ? otherBoard : selfBoard;
        const state = this._releasedHorizontalSlides.get(upperBoard);
        const upperBody = upperBoard.rigidBody;
        const normalY = Math.abs(contact.getWorldManifold().normal.y);

        const validHorizontalLanding = !!state
            && !!upperBody
            && state.surfaceCollisionsEnabled
            && upperCollider.group === GROUP_BOARD_FREE_SURFACE
            && this._getBoardSupportCount(upperBoard) === 0
            && upperBoard.node.worldPosition.y > lowerBoard.node.worldPosition.y + 4
            && normalY >= FREE_HORIZONTAL_SLIDE_MIN_CONTACT_NORMAL_Y
            && this._isNearHorizontalFreeWood(upperBoard)
            && Math.abs(upperBody.angularVelocity) <= FREE_HORIZONTAL_SLIDE_MAX_ANGULAR_SPEED
            && this._isStableHorizontalBoardSurface(lowerBoard);

        if (!validHorizontalLanding || !state || !upperBody) {
            // This preserves the old layered-board behavior for authored
            // crossings, side hits, rotating strips, and pinned structures.
            contact.disabledOnce = true;
            return;
        }

        const defaultFriction = Math.sqrt(
            Math.max(selfCollider.friction, 0) * Math.max(otherCollider.friction, 0)
        );
        contact.disabledOnce = false;
        if (state.completed && state.glidingOnBoardSurface) {
            contact.setFriction(defaultFriction);
            return;
        }

        if (state.gliding) {
            state.glidingOnBoardSurface = true;
            contact.setFriction(FREE_HORIZONTAL_SLIDE_CONTACT_FRICTION);
            return;
        }

        const velocity = upperBody.linearVelocity;
        const canStartGliding = state.age >= FREE_HORIZONTAL_SLIDE_MIN_RELEASE_AGE
            && state.sawMajorFall
            && velocity.y < -0.1
            && Math.abs(velocity.x) >= FREE_HORIZONTAL_SLIDE_MIN_START_SPEED;
        if (!canStartGliding) {
            contact.disabledOnce = true;
            return;
        }

        // The contact solver owns the impact and normal support. We only select
        // a smooth native friction coefficient, preserving the incoming tangent
        // velocity without assigning velocity, force, impulse, or node motion.
        state.gliding = true;
        state.glidingOnBoardSurface = true;
        state.quietAge = 0;
        upperBody.allowSleep = false;
        upperBody.wakeUp();
        contact.setFriction(FREE_HORIZONTAL_SLIDE_CONTACT_FRICTION);
    }

    private _isNearHorizontalFreeWood(board: BoardPiece): boolean {
        if (board.shape === 'circle') return false;
        const normalized = ((board.worldAngleDegrees() % 180) + 180) % 180;
        return Math.min(normalized, 180 - normalized) <= FREE_HORIZONTAL_SLIDE_ANGLE_DEG;
    }

    private _isStableHorizontalBoardSurface(board: BoardPiece): boolean {
        const rb = board.rigidBody;
        return board.shape !== 'circle'
            && !!rb
            && !!board.collider?.enabled
            && this._isNearHorizontalFreeWood(board)
            && Math.abs(rb.angularVelocity) <= FREE_HORIZONTAL_SLIDE_MAX_ANGULAR_SPEED
            && Math.hypot(rb.linearVelocity.x, rb.linearVelocity.y)
                <= FREE_HORIZONTAL_SURFACE_MAX_SUPPORT_SPEED;
    }

    private _deferSupportActivationIfOverlapping(anchor: AnchorPoint, minDelay: number = 0) {
        if (!anchor.hasBolt()) {
            this._pendingSupportActivations.delete(anchor);
            return;
        }
        if (minDelay > 0 || this._supportWouldStartOverlappingBoard(anchor)) {
            this._setSupportColliderEnabled(anchor, false);
            this._pendingSupportActivations.set(anchor, -Math.max(minDelay, 0));
            return;
        }
        this._pendingSupportActivations.delete(anchor);
        this._setSupportColliderEnabled(anchor, true);
    }

    private _resolvePendingSupportActivations(dt: number) {
        if (this._pendingSupportActivations.size === 0) return;
        const step = dt > 0 && dt < 0.1 ? dt : 1 / 60;
        for (const anchor of Array.from(this._pendingSupportActivations.keys())) {
            if (!anchor || !anchor.node || !anchor.node.isValid || !anchor.hasBolt()) {
                this._pendingSupportActivations.delete(anchor);
                continue;
            }

            const age = (this._pendingSupportActivations.get(anchor) ?? 0) + step;

            // Never introduce the solid support in the same frame as the joint
            // bookkeeping.
            const overlapping = this._supportWouldStartOverlappingBoard(anchor);
            if (age < 0) {
                this._pendingSupportActivations.set(anchor, age);
                this._setSupportColliderEnabled(anchor, false);
                continue;
            }

            // Hard 8 has several closely layered moving strips. Even after a
            // target was visibly clear at click time, an unrelated free strip
            // can enter the socket during the insertion grace. Enabling a peg
            // inside that strip produces a large Box2D separation impulse — the
            // observed one-frame "pop". Keep the occupied peg non-solid until
            // the unrelated strip clears; boards reattached to this anchor are
            // intentionally excluded by _supportWouldStartOverlappingBoard().
            if (overlapping && this._isLevel8ReferenceStyle()) {
                this._pendingSupportActivations.set(anchor, 0);
                this._setSupportColliderEnabled(anchor, false);
                continue;
            }

            this._pendingSupportActivations.delete(anchor);
            if (overlapping) this._wakeBoardsOverlappingSupport(anchor);
            this._setSupportColliderEnabled(anchor, true);
        }
    }

    private _supportWouldStartOverlappingBoard(anchor: AnchorPoint): boolean {
        const aw = anchor.node.worldPosition;
        for (const board of this._boards) {
            if (!board.isValid) continue;
            if (this._isBoardAttachedToAnchor(board, anchor)) continue;
            if (board.overlapsSolidCircle(
                aw.x,
                aw.y,
                SUPPORT_ACTIVATION_OVERLAP_RADIUS,
                0
            )) return true;
        }
        return false;
    }

    private _wakeBoardsOverlappingSupport(anchor: AnchorPoint) {
        const aw = anchor.node.worldPosition;
        for (const board of this._boards) {
            if (!board.isValid || this._isBoardAttachedToAnchor(board, anchor)) continue;
            if (!board.overlapsSolidCircle(
                aw.x,
                aw.y,
                SUPPORT_ACTIVATION_OVERLAP_RADIUS,
                0
            )) continue;
            board.rigidBody?.wakeUp();
        }
    }

    private _setSupportColliderEnabled(anchor: AnchorPoint, enabled: boolean) {
        const collider = anchor.supportCollider;
        if (!collider || !collider.node || !collider.node.isValid) return;
        if (collider.enabled === enabled) return;
        collider.enabled = enabled;
        collider.apply();
    }

    private _updateInsertionQuietAge(dt: number) {
        const step = dt > 0 && dt < 0.25 ? dt : 1 / 60;
        if (this._hasInsertionBlockingMotion()) {
            this._insertionQuietAge = 0;
            return;
        }
        this._insertionQuietAge = Math.min(
            INSERTION_SETTLE_REQUIRED_TIME,
            this._insertionQuietAge + step
        );
    }

    private _hasInsertionBlockingMotion(): boolean {
        for (const board of this._boards) {
            const rb = board.rigidBody;
            if (!board.isValid || !rb) continue;
            const v = rb.linearVelocity;
            if (Math.hypot(v.x, v.y) > INSERTION_SETTLE_MAX_LINEAR_SPEED) return true;
            if (Math.abs(rb.angularVelocity) > INSERTION_SETTLE_MAX_ANGULAR_SPEED) return true;
        }
        return false;
    }

    private _isInsertionPhysicsSettled(): boolean {
        return this._insertionQuietAge >= INSERTION_SETTLE_REQUIRED_TIME
            && !this._hasInsertionBlockingMotion();
    }

    private _isInsertionPhysicsSettledAt(anchor: AnchorPoint): boolean {
        if (this._isInsertionPhysicsSettled()) return true;

        // A swinging board elsewhere in the level cannot affect insertion at
        // this socket. Only defer while a moving body is inside the target
        // screw's physical activation footprint; the existing delayed support
        // activation still guards against a collider starting in overlap.
        const aw = anchor.node.worldPosition;
        for (const board of this._boards) {
            const rb = board.rigidBody;
            if (!board.isValid || !rb) continue;
            const v = rb.linearVelocity;
            const moving = Math.hypot(v.x, v.y) > INSERTION_SETTLE_MAX_LINEAR_SPEED
                || Math.abs(rb.angularVelocity) > INSERTION_SETTLE_MAX_ANGULAR_SPEED;
            if (!moving) continue;
            if (board.overlapsSolidCircle(
                aw.x,
                aw.y,
                SUPPORT_ACTIVATION_OVERLAP_RADIUS,
                0
            )) return false;
        }
        return true;
    }

    /**
     * Return holes that the existing click handler would accept right now.
     * This deliberately reuses the rule-layer obstruction classifier rather
     * than inferring availability from visuals or occupancy alone.
     */
    private _getAvailableHoles(): AnchorPoint[] {
        return this._anchors.filter(anchor => (
            !anchor.hasBolt()
            && this._isInsertionPhysicsSettledAt(anchor)
            && !anchor.isCovered()
        ));
    }

    /** Operations that can still commit state or autonomously release a hole. */
    private _pendingOperationState(): {
        count: number;
        awaitingSettlement: boolean;
        gameStateStable: boolean;
    } {
        let movingHoleAffectingBodies = 0;
        for (const board of this._boards) {
            const rb = board.rigidBody;
            if (!board.isValid || !rb) continue;
            const velocity = rb.linearVelocity;
            if (Math.hypot(velocity.x, velocity.y) > INSERTION_SETTLE_MAX_LINEAR_SPEED
                || Math.abs(rb.angularVelocity) > INSERTION_SETTLE_MAX_ANGULAR_SPEED) {
                const affectsEmptyHole = this._anchors.some(anchor => (
                    !anchor.hasBolt()
                    && anchor.isCovered()
                    && this._anchorInsertionSamples(
                        anchor.node.worldPosition.x,
                        anchor.node.worldPosition.y,
                    ).some(sample => board.visualMaterialAtAnchorSample(
                        sample.x,
                        sample.y,
                        0,
                        ANCHOR_INSERT_VISUAL_HOLE_RADIUS,
                    ) === 'solid')
                ));
                if (affectsEmptyHole) movingHoleAffectingBodies++;
            }
        }
        const supportActivations = this._pendingSupportActivations.size;
        const awaitingSettlement = movingHoleAffectingBodies > 0
            || supportActivations > 0;
        return {
            // A selected screw cannot create a hole. Only physics that may
            // uncover an empty anchor may delay the no-hole deadlock.
            count: movingHoleAffectingBodies + supportActivations,
            awaitingSettlement,
            gameStateStable: !awaitingSettlement,
        };
    }

    private _getDeadlockStatus(): BoltDeadlockStatus {
        const pending = this._pendingOperationState();
        const availableHoles = this._getAvailableHoles();
        return evaluateBoltDeadlock({
            levelSuccess: this._levelComplete,
            levelFailure: false,
            availableHoleCount: availableHoles.length,
            movableBoltCount: this._anchors.filter(anchor => anchor.hasBolt()).length,
            pendingOperationCount: pending.count,
            gameStateStable: pending.gameStateStable,
            awaitingOperationSettlement: pending.awaitingSettlement,
        });
    }

    private _isNearAnchoredVerticalPivotWood(board: BoardPiece): boolean {
        if (board.shape === 'circle') return false;
        const angle = board.worldAngleDegrees();
        const normalized = ((angle % 180) + 180) % 180;
        return Math.abs(normalized - 90) <= VERTICAL_ANCHORED_PIVOT_ANGLE_DEG;
    }

    private _hasSingleLowerSupport(board: BoardPiece): boolean {
        return this._singleLowerSupportPivot(board) !== null;
    }

    private _hasSingleUpperHangingSupport(board: BoardPiece): boolean {
        const support = this._singleSupportGeometry(board);
        if (!support) return false;

        const topFreeGap = Math.abs(support.topEndLocal.x - support.supportLocal.x);
        if (topFreeGap > VERTICAL_ANCHORED_TOP_FREE_GAP) return false;

        const boardWorld = board.node.worldPosition;
        return support.supportWorld.y >= boardWorld.y + 2;
    }

    private _settleUpperHangingVerticalPiece(board: BoardPiece) {
        const rb = board.rigidBody;
        if (!rb) return;
        // Removing the lower screw from an already-vertical plank whose top end
        // remains pinned should leave it hanging at a stable gravity equilibrium.
        // Preserve real contacts, but clear the residual velocity injected by
        // joint destruction so the free lower end does not visibly wobble.
        rb.linearVelocity = new Vec2(0, 0);
        rb.angularVelocity = 0;
        rb.sleep();
    }

    private _singleSupportGeometry(board: BoardPiece): {
        support: AnchorPoint;
        supportLocal: Vec2;
        supportWorld: Vec2;
        topEndLocal: Vec2;
        topEndWorld: Vec2;
    } | null {
        const supports = this._getBoardSupportAnchors(board);
        if (supports.length !== 1) return null;

        const support = supports[0];
        const supportWorld3 = support.node.worldPosition;
        const supportWorld = new Vec2(supportWorld3.x, supportWorld3.y);
        const supportLocal = this._closestHoleLocal(board, supportWorld.x, supportWorld.y);

        const halfLength = board.collisionWidth * 0.5;
        const endALocal = new Vec2(-halfLength, supportLocal.y);
        const endBLocal = new Vec2(halfLength, supportLocal.y);
        const endAWorld = this._boardLocalToWorld(board, endALocal);
        const endBWorld = this._boardLocalToWorld(board, endBLocal);
        const topEndLocal = endAWorld.y >= endBWorld.y ? endALocal : endBLocal;
        const topEndWorld = endAWorld.y >= endBWorld.y ? endAWorld : endBWorld;

        return { support, supportLocal, supportWorld, topEndLocal, topEndWorld };
    }

    private _singleLowerSupportPivot(board: BoardPiece): {
        support: AnchorPoint;
        supportLocal: Vec2;
        supportWorld: Vec2;
        freeEndLocal: Vec2;
        freeEndWorld: Vec2;
    } | null {
        const support = this._singleSupportGeometry(board);
        if (!support) return null;

        // If the only remaining screw is at/near the top end, it is a hanging
        // support and should not be forced to fall. If there is a visible free
        // section above the screw (middle or lower single support), drive it
        // out of the vertical dead point so gravity/contacts can take over.
        const topFreeGap = Math.abs(support.topEndLocal.x - support.supportLocal.x);
        if (topFreeGap < VERTICAL_ANCHORED_TOP_FREE_GAP) return null;

        // Cocos Y grows upward. If the remaining screw is below the top free
        // end, gravity should make the strip topple around that screw. Compare
        // against both top end and center so the detection survives small center
        // shifts caused by contacts.
        const boardWorld = board.node.worldPosition;
        const supportBelowFreeEnd = support.supportWorld.y < support.topEndWorld.y - 2;
        const supportBelowCenter = support.supportWorld.y < boardWorld.y - 2;
        if (!supportBelowFreeEnd && !supportBelowCenter) return null;

        return {
            support: support.support,
            supportLocal: support.supportLocal,
            supportWorld: support.supportWorld,
            freeEndLocal: support.topEndLocal,
            freeEndWorld: support.topEndWorld
        };
    }

    private _applyAnchoredVerticalPivotNudge(board: BoardPiece) {
        const rb = board.rigidBody;
        if (!rb) return;
        rb.wakeUp();
        // Preserve any real angular motion left by the removed constraint. Only
        // choose a side when the body is still at the exact upright dead point.
        const sign = Math.abs(rb.angularVelocity) > 0.0001
            ? Math.sign(rb.angularVelocity)
            : this._anchoredVerticalPivotSign(board);
        rb.applyAngularImpulse(sign * VERTICAL_ANCHORED_PIVOT_ANGULAR_IMPULSE, true);
        // The tiny physical impulse alone falls below Box2D's sleep tolerance
        // for long planks. Give this one exact scenario a one-time minimal start
        // speed; gravity supplies all subsequent acceleration around the hinge.
        if (Math.abs(rb.angularVelocity) < VERTICAL_ANCHORED_PIVOT_MIN_START_SPEED) {
            rb.angularVelocity = sign * VERTICAL_ANCHORED_PIVOT_MIN_START_SPEED;
        }
    }

    private _anchoredVerticalPivotSign(board: BoardPiece): number {
        const pivot = this._singleLowerSupportPivot(board);
        if (!pivot) return board.node.position.x < 0 ? 1 : -1;

        // Choose the physical side of the current lean: if the free/top end is
        // already left of the lower pivot, continue tipping left; if it is
        // right, continue tipping right. This matches the reference-level
        // expectation and avoids an arbitrary screen-side default forcing a
        // vertical strip to fall the wrong way.
        const leanDx = pivot.freeEndWorld.x - pivot.supportWorld.x;
        const outwardSign = board.node.position.x < 0 ? -1 : 1;
        let desiredXSign = Math.sign(leanDx);
        // Side posts in the reference levels should fall outward. Tiny or
        // contact-induced inward lean can otherwise make the assist push the
        // wrong way and leave the strip upright against pegs.
        if (Math.abs(board.node.position.x) >= VERTICAL_ANCHORED_OUTWARD_BIAS_X
            && (Math.abs(leanDx) < VERTICAL_ANCHORED_LEAN_DEADBAND || Math.sign(leanDx) !== outwardSign)) {
            desiredXSign = outwardSign;
        } else if (Math.abs(leanDx) < 1.0) {
            desiredXSign = outwardSign;
        }

        const angleRad = (board.worldAngleDegrees() * Math.PI) / 180;
        const dxPerPositiveAngular = -Math.sin(angleRad) * pivot.freeEndLocal.x
            - Math.cos(angleRad) * pivot.freeEndLocal.y;
        let sign = desiredXSign * Math.sign(dxPerPositiveAngular || 1);
        if (sign === 0) sign = board.node.position.x < 0 ? 1 : -1;
        return sign > 0 ? 1 : -1;
    }

    private _boardLocalToWorld(board: BoardPiece, local: Vec2): Vec2 {
        return board.localToWorld(local);
    }

    private _getBoardSupportAnchors(board: BoardPiece): AnchorPoint[] {
        const anchors: AnchorPoint[] = [];
        for (const [anchor, boards] of this._anchorBoardLinks.entries()) {
            if (boards.indexOf(board) >= 0) anchors.push(anchor);
        }
        return anchors;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Attach / detach
    // ──────────────────────────────────────────────────────────────────────
    private _attachBoardIfPossible(
        board: BoardPiece,
        anchor: AnchorPoint,
        tolerance: number = ANCHOR_ATTACH_HOLE_TOLERANCE,
    ): boolean {
        if (!board.isValid) return false;
        if (!anchor.hasBolt()) return false;
        const aw = anchor.node.worldPosition;
        if (!board.hasAlignedHoleAt(aw.x, aw.y, tolerance)) return false;
        if (this._isBoardAttachedToAnchor(board, anchor)) return false;
        if (!anchor.supportBody || !board.rigidBody) return false;

        // HingeJoint2D must live on the same node as the dynamic RigidBody2D.
        const joint = board.node.addComponent(HingeJoint2D);
        if (!joint) {
            console.warn(`[LevelController] Failed to add HingeJoint2D to board ${board.boardId}`);
            return false;
        }
        const localHole = this._closestHoleLocal(board, aw.x, aw.y);
        joint.anchor = new Vec2(localHole.x, localHole.y);
        joint.connectedAnchor = new Vec2(0, 0);
        joint.connectedBody = anchor.supportBody;
        joint.collideConnected = false;
        // Required for Box2D backend: rebuilds the underlying joint with the values
        // we set. Without this, the joint was created with connectedBody=null and
        // never holds the board, so it falls instantly.
        joint.apply();

        let boards = this._anchorBoardLinks.get(anchor);
        if (!boards) { boards = []; this._anchorBoardLinks.set(anchor, boards); }
        boards.push(board);

        let joints = this._anchorJointLinks.get(anchor);
        if (!joints) { joints = []; this._anchorJointLinks.set(anchor, joints); }
        joints.push(joint);

        this._untrackReleasedPiece(board);
        return true;
    }

    private _closestHoleLocal(board: BoardPiece, wx: number, wy: number): Vec2 {
        return board.closestHoleLocalAt(wx, wy) ?? new Vec2(0, 0);
    }

    private _attachAllPossibleBoards(anchor: AnchorPoint): BoardPiece[] {
        const attached: BoardPiece[] = [];
        for (const board of this._boards) {
            if (this._attachBoardIfPossible(board, anchor)) attached.push(board);
        }
        return attached;
    }

    private _reattachBoardToOccupiedAnchors(board: BoardPiece): number {
        let attached = 0;
        for (const anchor of this._anchors) {
            if (!anchor.hasBolt()) continue;
            if (this._attachBoardIfPossible(board, anchor)) attached++;
        }
        return attached;
    }

    private _detachAnchor(anchor: AnchorPoint): BoardPiece[] {
        const boards = (this._anchorBoardLinks.get(anchor) ?? []).slice();
        for (const board of boards) {
            this._detachBoardFromAnchor(anchor, board);
        }
        return boards;
    }

    private _detachBoardFromAnchor(anchor: AnchorPoint, board: BoardPiece) {
        const boards = this._anchorBoardLinks.get(anchor);
        if (!boards) return;
        const idx = boards.indexOf(board);
        if (idx < 0) return;

        const joints = this._anchorJointLinks.get(anchor);
        let joint: HingeJoint2D | undefined;
        if (joints && idx < joints.length) {
            joint = joints[idx];
            joints.splice(idx, 1);
        }
        boards.splice(idx, 1);
        // Destroying just the joint component (not the board node) breaks the link.
        if (joint && joint.node && joint.node.isValid) {
            joint.destroy();
        }
        if (boards.length === 0) {
            this._anchorBoardLinks.delete(anchor);
            this._anchorJointLinks.delete(anchor);
        }
    }

    private _isBoardAttachedToAnchor(board: BoardPiece, anchor: AnchorPoint): boolean {
        const boards = this._anchorBoardLinks.get(anchor);
        return !!boards && boards.indexOf(board) >= 0;
    }

    private _getBoardSupportCount(board: BoardPiece): number {
        let count = 0;
        for (const boards of this._anchorBoardLinks.values()) {
            for (const b of boards) {
                if (b === board) count++;
            }
        }
        return count;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Misc state
    // ──────────────────────────────────────────────────────────────────────
    private _isAnchorBlocked(anchor: AnchorPoint): boolean {
        const aw = anchor.node.worldPosition;
        const boardsTopToBottom = this._boardsTopToBottom();
        const samples = this._anchorInsertionSamples(aw.x, aw.y);
        const alignedHoleBoards = new Set(boardsTopToBottom.filter((board) =>
            board.hasAlignedHoleAt(
                aw.x,
                aw.y,
                ANCHOR_ATTACH_HOLE_TOLERANCE
            )));

        let outerSolidCount = 0;
        for (const sample of samples) {
            const hasSolid = this._hasSolidMaterialAtAnchorSample(
                boardsTopToBottom,
                sample.x,
                sample.y,
                // A centre-pinned strip can settle with a sub-degree rotation.
                // Its drilled hole is still within the exact joint-attachment
                // tolerance, but a few samples on the fixed socket's outer rim
                // then land on that same strip's painted hole edge. Ignore only
                // that owning strip on the outer band. Inner material and every
                // unrelated board/disk still block insertion normally.
                sample.band === 'outer' ? alignedHoleBoards : undefined
            );
            if (!hasSolid) continue;
            if (sample.band !== 'outer') return true;
            outerSolidCount++;
        }
        return outerSolidCount >= ANCHOR_INSERT_OUTER_SOLID_BLOCK_COUNT;
    }

    private _refreshAnchorCoverState() {
        this._anchorCoverRefreshTimer = 0;
        for (const anchor of this._anchors) {
            anchor.setCoveredByBoard(this._isAnchorBlocked(anchor));
        }
    }

    private _boardsTopToBottom(): BoardPiece[] {
        return this._boards
            .filter((board) => board.isValid)
            .map((board, index) => ({ board, index }))
            .sort((a, b) => {
                const byOrder = b.board.renderOrder - a.board.renderOrder;
                if (byOrder !== 0) return byOrder;
                return this._boardSiblingIndex(b.board, b.index) - this._boardSiblingIndex(a.board, a.index);
            })
            .map(({ board }) => board);
    }

    private _boardSiblingIndex(board: BoardPiece, fallback: number): number {
        const parent = board.node?.parent;
        if (!parent) return fallback;
        const idx = parent.children.indexOf(board.node);
        return idx >= 0 ? idx : fallback;
    }

    private _anchorInsertionSamples(wx: number, wy: number): AnchorInsertionSample[] {
        const samples: AnchorInsertionSample[] = [{ x: wx, y: wy, weight: 4, band: 'center' }];
        this._addAnchorInsertionSampleRing(samples, wx, wy, ANCHOR_INSERT_SOCKET_RADIUS * 0.35, 12, 'inner');
        this._addAnchorInsertionSampleRing(samples, wx, wy, ANCHOR_INSERT_SOCKET_RADIUS * 0.68, 24, 'middle');
        this._addAnchorInsertionSampleRing(samples, wx, wy, ANCHOR_INSERT_SOCKET_RADIUS, 32, 'outer');
        return samples;
    }

    private _addAnchorInsertionSampleRing(
        samples: AnchorInsertionSample[],
        wx: number,
        wy: number,
        radius: number,
        count: number,
        band: AnchorInsertionSampleBand
    ) {
        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 * i) / count;
            samples.push({
                x: wx + Math.cos(angle) * radius,
                y: wy + Math.sin(angle) * radius,
                weight: 1,
                band
            });
        }
    }

    private _topVisibleMaterialAtAnchorSample(
        boardsTopToBottom: BoardPiece[],
        sampleWx: number,
        sampleWy: number
    ): BoardVisualMaterial {
        for (const board of boardsTopToBottom) {
            const material = board.visualMaterialAtAnchorSample(
                sampleWx,
                sampleWy,
                board.shape === 'circle' ? CIRCLE_PAD_INSERT_SOLID_INSET : WOOD_INSERT_SOLID_INSET,
                ANCHOR_INSERT_VISUAL_HOLE_RADIUS
            );
            if (material !== 'empty') return material;
        }
        return 'empty';
    }

    private _hasSolidMaterialAtAnchorSample(
        boardsTopToBottom: BoardPiece[],
        sampleWx: number,
        sampleWy: number,
        ignoredSolidBoards?: ReadonlySet<BoardPiece>
    ): boolean {
        // A painted hole only cuts through the board that owns it. It must not
        // hide solid wood on another layer from the insertion test: the screw's
        // physical shaft still has to pass through every overlapping piece.
        for (const board of boardsTopToBottom) {
            const material = board.visualMaterialAtAnchorSample(
                sampleWx,
                sampleWy,
                board.shape === 'circle' ? CIRCLE_PAD_INSERT_SOLID_INSET : WOOD_INSERT_SOLID_INSET,
                ANCHOR_INSERT_VISUAL_HOLE_RADIUS
            );
            if (material === 'solid' && !ignoredSolidBoards?.has(board)) return true;
        }
        return false;
    }

    private _checkBoardsOutOfBounds() {
        const minX = g2c(PLAY_ZONE.left - EXIT_MARGIN_X, 0).x;
        const maxX = g2c(PLAY_ZONE.right + EXIT_MARGIN_X, 0).x;
        const minY = g2c(0, PLAY_ZONE.bottom + EXIT_MARGIN_Y).y;
        const maxY = g2c(0, PLAY_ZONE.top - EXIT_MARGIN_Y).y;

        const exited: BoardPiece[] = [];
        for (const board of this._boards) {
            if (!board.isValid) continue;

            // A board that is still pinned by any screw is not "cleared" even if
            // its visible body swings beyond the background. Removing it here
            // also removed the remaining bolt, which created false progress and
            // broken puzzle states in dense reference levels.
            if (this._getBoardSupportCount(board) > 0) continue;

            const radius = (board.shape === 'circle'
                ? board.circleRadius
                : Math.hypot(board.collisionWidth, board.collisionHeight) * 0.5
            ) + EXIT_BOUNDS_EXTRA_RADIUS;

            // Compare against the board's whole bounding circle, not just its
            // center. Long strips often have their center outside while one end
            // is still visibly inside the play/background area.
            const lp = board.node.position;
            const fullyOutside = lp.x + radius < minX
                || lp.x - radius > maxX
                || lp.y + radius < minY
                || lp.y - radius > maxY;
            if (fullyOutside) {
                exited.push(board);
            }
        }
        for (const board of exited) {
            this._onBoardExited(board);
        }
    }

    private _onBoardExited(board: BoardPiece) {
        if (board.hasExited) return;
        board.markExited();
        this._untrackReleasedPiece(board);
        this._detachAllBoardAnchors(board, true);
        const idx = this._boards.indexOf(board);
        if (idx >= 0) this._boards.splice(idx, 1);
        this._boardById.delete(board.boardId);
        this._boardsExited++;
        this._updateHud();
        this._refreshAnchorCoverState();

        if (this._boardsExited >= this._boardsTotal) {
            this._levelComplete = true;
            if (this._completeOverlay) this._completeOverlay.active = true;
            this._setInstruction('所有木条都已离场！');
        } else {
            this._setInstruction('有木条离场了，继续清空剩下的。');
        }

        if (board.node && board.node.isValid) board.node.destroy();
    }

    private _detachAllBoardAnchors(board: BoardPiece, clearBolts: boolean) {
        const anchorsToClear: AnchorPoint[] = [];
        for (const [anchor, boards] of this._anchorBoardLinks.entries()) {
            if (boards.indexOf(board) >= 0) anchorsToClear.push(anchor);
        }
        for (const anchor of anchorsToClear) {
            this._detachBoardFromAnchor(anchor, board);
            if (clearBolts && !(this._anchorBoardLinks.get(anchor)?.length)) {
                anchor.setBoltPresent(false);
            }
        }
    }

    private _clearSelection() {
        if (this._selectedAnchor) {
            this._selectedAnchor.setSelected(false);
            this._selectedAnchor = null;
        }
    }

    private _setInstruction(text: string) {
        if (this._instructionLabel) this._instructionLabel.string = text;
    }

    private _updateHud() {
        if (this._boardsOutLabel) {
            this._boardsOutLabel.string = `木条出界：${this._boardsExited} / ${this._boardsTotal}`;
        }
    }

    private _restartLevel() {
        this._loadLevel(this._currentIndex);
    }

    private _goToNextLevel() {
        if (this._currentIndex < this.levels.length - 1) {
            this._loadLevel(this._currentIndex + 1);
        }
    }

    private _onKeyDown(event: EventKeyboard) {
        // Temporary development shortcuts: press 4/5/6/7/8 to jump straight to the
        // matching reference recreation levels. Safe to delete with this method,
        // the TEMP_JUMP_LEVEL_* constants, and the input on/off lines.
        if (event.keyCode === KeyCode.DIGIT_4 || event.keyCode === KeyCode.NUM_4) {
            this._jumpToLevelByTitle(TEMP_JUMP_LEVEL_4_TITLE);
            return;
        }
        if (event.keyCode === KeyCode.DIGIT_5 || event.keyCode === KeyCode.NUM_5) {
            this._jumpToLevelByTitle(TEMP_JUMP_LEVEL_5_TITLE);
            return;
        }
        if (event.keyCode === KeyCode.DIGIT_6 || event.keyCode === KeyCode.NUM_6) {
            this._jumpToLevelByTitle(TEMP_JUMP_LEVEL_6_TITLE);
            return;
        }
        if (event.keyCode === KeyCode.DIGIT_7 || event.keyCode === KeyCode.NUM_7) {
            this._jumpToLevelByTitle(TEMP_JUMP_LEVEL_7_TITLE);
            return;
        }
        if (event.keyCode === KeyCode.DIGIT_8 || event.keyCode === KeyCode.NUM_8) {
            this._jumpToLevelByTitle(TEMP_JUMP_LEVEL_8_TITLE);
            return;
        }
    }

    private _jumpToLevelByTitle(title: string) {
        let index = this.levels.findIndex(level => level.title === title);
        if (index < 0 && title.startsWith('困难第')) {
            this.setDifficulty('hard');
            index = this.levels.findIndex(level => level.title === title);
        }
        if (index < 0 || !this._root || !this._anchorsRoot || !this._boardsRoot) return;
        this._loadLevel(index);
    }

    // ──────────────────────────────────────────────────────────────────────
    // GameInspector hook — read-only state for GUI-agent monitoring/reward.
    // ──────────────────────────────────────────────────────────────────────
    private _inspectorProvider: InspectorProvider = {
        snapshot: () => {
            const insertionSettled = this._isInsertionPhysicsSettled();
            const deadlock = this._getDeadlockStatus();
            const anchors = this._anchors.map(a => {
                const wp = a.node.worldPosition;
                const { x, y } = c2g(wp.x, wp.y);
                const hasBolt = a.hasBolt();
                const coveredByBoard = a.isCovered();
                const boltVisualWorld = a.boltSpriteNode?.worldPosition;
                const boltVisual = boltVisualWorld
                    ? c2g(boltVisualWorld.x, boltVisualWorld.y)
                    : { x, y };
                return {
                    id: a.anchorId,
                    x, y,
                    boltVisualX: boltVisual.x,
                    boltVisualY: boltVisual.y,
                    hasBolt,
                    coveredByBoard,
                    insertable: insertionSettled && !hasBolt && !coveredByBoard,
                };
            });
            const boards = this._boards.map(b => {
                const wp = b.node.worldPosition;
                const { x, y } = c2g(wp.x, wp.y);
                const alive = b.isValid;
                const supportCount = alive ? this._getBoardSupportCount(b) : 0;
                return {
                    id: b.boardId,
                    x, y,
                    angleDeg: c2gAngle(b.worldAngleDegrees()),
                    holes: b.holeOffsets.length,
                    exited: !alive,
                    supportCount,
                    // Evaluator-only: board has lost all hinge supports but has
                    // not yet left the play area.  GUI agents never receive this.
                    released: alive && supportCount === 0,
                };
            });
            const boardsReleased = boards.filter(board => board.released).length;
            const boardsSupportedRemaining = boards.filter(
                board => !board.exited && !board.released,
            ).length;
            return {
                ready: !!this._root && this._boardsTotal > 0,
                difficulty: this.levelDifficulty,
                level: this._currentIndex,
                levelTitle: this.levels[this._currentIndex]?.title ?? '',
                complete: this._levelComplete,
                boardsTotal: this._boardsTotal,
                boardsExited: this._boardsExited,
                boardsReleased,
                boardsSupportedRemaining,
                selectedAnchorId: this._selectedAnchor?.anchorId ?? null,
                deadlock,
                anchors,
                boards,
            };
        },

        outcomeHash: () => {
            // Outcome-affecting fields only: level index, completion, exit count,
            // per-anchor bolt occupancy, per-board liveness. Position drift from
            // a perpetually-swinging board does NOT enter the hash, so the
            // inspector reports outcome_stable in bounded time.
            const parts: string[] = [
                String(this._currentIndex),
                this._levelComplete ? '1' : '0',
                String(this._boardsExited),
            ];
            const deadlock = this._getDeadlockStatus();
            parts.push(
                deadlock.isDeadlocked ? 'deadlock' : 'playable',
                String(deadlock.availableHoleCount),
                String(deadlock.legalProgressActionCount),
                String(deadlock.pendingOperationCount),
                deadlock.gameStateStable ? 'stable' : 'unstable',
            );
            for (const a of this._anchors) parts.push(a.anchorId, a.hasBolt() ? '1' : '0', a.isCovered() ? 'c' : 'o');
            for (const b of this._boards) parts.push(b.boardId, b.isValid ? '1' : '0');
            return parts.join(',');
        },

        physicsStats: (): PhysicsStats => {
            let maxV = 0;
            let moving = 0;
            for (const b of this._boards) {
                if (!b.isValid) continue;
                const rb = b.rigidBody;
                if (!rb) continue;
                const v = rb.linearVelocity;
                const lin = Math.hypot(v.x, v.y);
                if (lin > maxV) maxV = lin;
                if (lin > 1.0 || Math.abs(rb.angularVelocity) > 0.05) moving++;
            }
            return { quiet: moving === 0, maxLinearVelocity: maxV, movingBodies: moving };
        },
    };
}
