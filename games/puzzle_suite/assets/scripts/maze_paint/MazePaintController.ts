import {
    _decorator,
    Button,
    Color,
    Component,
    EventMouse,
    EventTouch,
    Graphics,
    Input,
    Label,
    Node,
    Tween,
    UITransform,
    Vec2,
    Vec3,
    input,
    tween,
} from 'cc';
import { GameInspector } from '../game/GameInspector';
import type { InspectorProvider, PhysicsStats } from '../game/GameInspector';
import {
    getMazePaintLevels,
} from './MazePaintLevelData';
import type {
    MazePaintDifficulty,
    MazePaintLevelDefinition,
} from './MazePaintLevelData';
import { MazePaintEvaluator } from './MazePaintEvaluator';
import {
    computeMazePaintMove,
    hashMazePaintState,
    isCellPainted,
    parseMazePaintLevel,
    positionKey,
} from './MazePaintRules';
import type {
    GridPosition,
    MazePaintDirection,
    MazePaintLevel,
    MazePaintMoveResult,
} from './MazePaintRules';

const { ccclass } = _decorator;

const VIEW_WIDTH = 540;
const VIEW_HEIGHT = 960;
const BOARD_Y = -16;
const BOARD_MAX_WIDTH = 432;
const BOARD_MAX_HEIGHT = 560;
const MAX_CELL_SIZE = 84;
const SWIPE_THRESHOLD = 24;
const SEGMENT_DURATION_SECONDS = 0.085;

const COLORS = {
    background: new Color(255, 251, 231, 255),
    backgroundWarm: new Color(255, 246, 215, 255),
    backgroundShade: new Color(238, 226, 196, 70),
    title: new Color(165, 76, 118, 255),
    muted: new Color(117, 108, 103, 255),
    pill: new Color(188, 181, 173, 255),
    cell: new Color(76, 94, 110, 255),
    cellLight: new Color(91, 110, 126, 255),
    cellLine: new Color(57, 75, 91, 255),
    cellEdge: new Color(51, 57, 61, 255),
    cellSide: new Color(67, 66, 59, 255),
    white: new Color(252, 252, 250, 255),
    ballShade: new Color(172, 181, 191, 255),
    shadow: new Color(30, 31, 35, 70),
    accent: new Color(255, 185, 38, 255),
};

interface PaintPalette {
    readonly fill: Color;
    readonly light: Color;
    readonly line: Color;
}

/** Screenshot order: red, blue, green, pink, cyan, red, orange, purple, red, blue. */
const LEVEL_PALETTES: readonly PaintPalette[] = Object.freeze([
    { fill: new Color(226, 51, 83, 255), light: new Color(246, 72, 105, 255), line: new Color(178, 35, 64, 255) },
    { fill: new Color(52, 139, 225, 255), light: new Color(78, 168, 244, 255), line: new Color(34, 101, 180, 255) },
    { fill: new Color(64, 184, 99, 255), light: new Color(91, 214, 126, 255), line: new Color(38, 137, 70, 255) },
    { fill: new Color(231, 102, 170, 255), light: new Color(247, 134, 193, 255), line: new Color(180, 69, 129, 255) },
    { fill: new Color(40, 190, 192, 255), light: new Color(72, 220, 218, 255), line: new Color(25, 139, 146, 255) },
    { fill: new Color(226, 51, 83, 255), light: new Color(246, 72, 105, 255), line: new Color(178, 35, 64, 255) },
    { fill: new Color(241, 139, 37, 255), light: new Color(255, 172, 64, 255), line: new Color(190, 96, 20, 255) },
    { fill: new Color(143, 83, 207, 255), light: new Color(174, 113, 231, 255), line: new Color(102, 54, 159, 255) },
    { fill: new Color(226, 51, 83, 255), light: new Color(246, 72, 105, 255), line: new Color(178, 35, 64, 255) },
    { fill: new Color(52, 139, 225, 255), light: new Color(78, 168, 244, 255), line: new Color(34, 101, 180, 255) },
]);

type GestureSource = 'touch' | 'mouse';

interface GestureState {
    readonly source: GestureSource;
    readonly start: Vec2;
}

/**
 * Pure-code Cocos presentation/controller for Maze Painting.
 *
 * The evaluator remains the only committed game state. A move is calculated
 * once by the authoritative rule function, rendered one grid cell at a time,
 * and committed only after the final animation segment completes.
 */
@ccclass('MazePaintController')
export class MazePaintController extends Component {
    public difficulty: MazePaintDifficulty = 'easy';
    public onRequestExit: (() => void) | null = null;

    private _levels: readonly MazePaintLevelDefinition[] = [];
    private _levelIndex = 0;
    private _initialLevelIndex = 0;
    private _level: MazePaintLevel | null = null;
    private _evaluator: MazePaintEvaluator | null = null;

    private _sceneBuilt = false;
    private _busy = false;
    private _actionToken = 0;
    private _gesture: GestureState | null = null;
    private _cellSize = MAX_CELL_SIZE;

    private _boardRoot: Node | null = null;
    private _cellLayer: Node | null = null;
    private _ballLayer: Node | null = null;
    private _ballNode: Node | null = null;
    private readonly _cellGraphics = new Map<string, Graphics>();

    private _difficultyLabel: Label | null = null;
    private _levelLabel: Label | null = null;
    private _completeOverlay: Node | null = null;
    private _completeCard: Node | null = null;
    private _completeTitle: Label | null = null;
    private _completeSubtitle: Label | null = null;
    private _completePrimaryLabel: Label | null = null;
    private _completionMarkGraphics: Graphics | null = null;

    private readonly _inspectorProvider: InspectorProvider = {
        snapshot: () => {
            if (!this._evaluator) {
                return {
                    ready: false,
                    busy: this._busy,
                    complete: false,
                    failure: false,
                    difficulty: this.difficulty,
                    level: this._levelIndex + 1,
                    levelCount: this._levels.length,
                    controls: { exit: true, restart: false, next: false },
                };
            }
            const evaluator = this._evaluator.snapshot(this._now(), this._busy);
            return {
                ...evaluator,
                ready: this._sceneBuilt
                    && !this._busy
                    && !!this._level
                    && !!this._ballNode
                    && this._cellGraphics.size === this._level.totalPaintableCells,
                busy: this._busy,
                complete: evaluator.success,
                failure: evaluator.failure,
                levelCount: this._levels.length,
                controls: {
                    exit: true,
                    restart: true,
                    next: evaluator.success && this._levelIndex + 1 < this._levels.length,
                },
            };
        },
        outcomeHash: () => {
            if (!this._level || !this._evaluator) {
                return `${this.difficulty}:${this._levelIndex}:not-ready:${this._busy ? 1 : 0}`;
            }
            return [
                this.difficulty,
                this._level.id,
                hashMazePaintState(this._level, this._evaluator.state),
                this._busy ? 1 : 0,
                this._evaluator.status,
            ].join(':');
        },
        physicsStats: (): PhysicsStats => ({
            quiet: !this._busy,
            maxLinearVelocity: 0,
            movingBodies: this._busy ? 1 : 0,
        }),
    };

    onLoad(): void {
        this._applyDifficulty(this.difficulty);
        GameInspector.instance.register('mazePaint', this._inspectorProvider);
    }

    start(): void {
        this._buildScene();
        this._loadLevel(this._initialLevelIndex);
    }

    update(): void {
        if (!this._evaluator || this._busy || this._completeOverlay?.active) return;
        this._evaluator.pollTermination(this._now());
        if (this._evaluator.terminal) this._showTerminalOverlay();
    }

    onDestroy(): void {
        this._actionToken++;
        this._gesture = null;
        this._stopAnimations();
        input.off(Input.EventType.MOUSE_DOWN, this._onMouseDown, this);
        input.off(Input.EventType.MOUSE_UP, this._onMouseUp, this);
        GameInspector.instance.unregister('mazePaint');
    }

    public setDifficulty(difficulty: MazePaintDifficulty): void {
        this.difficulty = difficulty;
        this._applyDifficulty(difficulty);
        if (this._sceneBuilt) this._loadLevel(0);
    }

    /** Select a one-based screenshot level within the current difficulty. */
    public setInitialLevel(levelId: number): void {
        this._initialLevelIndex = this._clampLevelIndex(Math.trunc(levelId) - 1);
        if (this._sceneBuilt) this._loadLevel(this._initialLevelIndex);
    }

    /** Benchmark-safe reset that preserves difficulty and selected level. */
    public resetCurrentLevel(): void {
        this._loadLevel(this._levelIndex);
    }

    private _applyDifficulty(difficulty: MazePaintDifficulty): void {
        this._levels = getMazePaintLevels(difficulty);
        this._levelIndex = 0;
        this._initialLevelIndex = this._clampLevelIndex(this._initialLevelIndex);
    }

    private _clampLevelIndex(index: number): number {
        if (this._levels.length === 0 || !Number.isFinite(index)) return 0;
        return Math.max(0, Math.min(this._levels.length - 1, index));
    }

    private _buildScene(): void {
        const rootTransform = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
        rootTransform.setContentSize(VIEW_WIDTH, VIEW_HEIGHT);
        rootTransform.setAnchorPoint(0.5, 0.5);

        this._drawBackground();
        this._buildHeader();
        this._buildBoardLayers();
        this._buildInstruction();
        this._buildCompleteOverlay();

        input.on(Input.EventType.MOUSE_DOWN, this._onMouseDown, this);
        input.on(Input.EventType.MOUSE_UP, this._onMouseUp, this);
        this._sceneBuilt = true;
    }

    private _drawBackground(): void {
        const background = new Node('MazePaintBackground');
        background.layer = this.node.layer;
        background.parent = this.node;
        background.addComponent(UITransform).setContentSize(VIEW_WIDTH, VIEW_HEIGHT);
        const graphics = background.addComponent(Graphics);
        graphics.fillColor = COLORS.background;
        graphics.rect(-VIEW_WIDTH / 2, -VIEW_HEIGHT / 2, VIEW_WIDTH, VIEW_HEIGHT);
        graphics.fill();

        graphics.fillColor = new Color(
            COLORS.backgroundWarm.r,
            COLORS.backgroundWarm.g,
            COLORS.backgroundWarm.b,
            120,
        );
        graphics.circle(-205, 340, 245);
        graphics.fill();
        graphics.fillColor = COLORS.backgroundShade;
        graphics.circle(250, -410, 330);
        graphics.fill();
        graphics.fillColor = new Color(255, 255, 255, 55);
        graphics.roundRect(-242, -320, 484, 620, 38);
        graphics.fill();
    }

    private _buildHeader(): void {
        const back = this._makeCircleButton('MazePaintBack', -220, 390);
        const backIcon = new Node('BackIcon');
        backIcon.layer = back.layer;
        backIcon.parent = back;
        const backGraphics = backIcon.addComponent(Graphics);
        backGraphics.strokeColor = new Color(211, 126, 164, 255);
        backGraphics.lineWidth = 8;
        backGraphics.lineCap = Graphics.LineCap.ROUND;
        backGraphics.lineJoin = Graphics.LineJoin.ROUND;
        backGraphics.moveTo(8, 16);
        backGraphics.lineTo(-8, 0);
        backGraphics.lineTo(8, -16);
        backGraphics.stroke();
        back.on(Button.EventType.CLICK, this._requestExit, this);

        const restart = this._makeCircleButton('MazePaintRestart', 220, 390);
        const restartIcon = new Node('RestartIcon');
        restartIcon.layer = restart.layer;
        restartIcon.parent = restart;
        const restartGraphics = restartIcon.addComponent(Graphics);
        restartGraphics.strokeColor = new Color(211, 126, 164, 255);
        restartGraphics.lineWidth = 5;
        restartGraphics.lineCap = Graphics.LineCap.ROUND;
        restartGraphics.moveTo(-13, 9);
        restartGraphics.bezierCurveTo(-3, 20, 18, 13, 17, -4);
        restartGraphics.bezierCurveTo(16, -17, -1, -21, -13, -10);
        restartGraphics.stroke();
        restartGraphics.fillColor = new Color(211, 126, 164, 255);
        restartGraphics.moveTo(-19, 8);
        restartGraphics.lineTo(-7, 16);
        restartGraphics.lineTo(-8, 1);
        restartGraphics.close();
        restartGraphics.fill();
        restart.on(Button.EventType.CLICK, this.resetCurrentLevel, this);

        const pill = new Node('DifficultyPill');
        pill.layer = this.node.layer;
        pill.parent = this.node;
        pill.setPosition(0, 414, 0);
        pill.addComponent(UITransform).setContentSize(132, 26);
        const pillGraphics = pill.addComponent(Graphics);
        pillGraphics.fillColor = COLORS.pill;
        pillGraphics.roundRect(-66, -13, 132, 26, 13);
        pillGraphics.fill();
        this._difficultyLabel = this._makeLabel(
            pill,
            'DifficultyLabel',
            '',
            16,
            COLORS.white,
            true,
            132,
            28,
        );

        this._levelLabel = this._makeLabel(
            this.node,
            'LevelLabel',
            '',
            34,
            COLORS.title,
            true,
            250,
            48,
        );
        this._levelLabel.node.setPosition(0, 363, 0);
    }

    private _makeCircleButton(name: string, x: number, y: number): Node {
        const node = new Node(name);
        node.layer = this.node.layer;
        node.parent = this.node;
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(64, 64);
        const graphics = node.addComponent(Graphics);
        graphics.fillColor = new Color(79, 68, 57, 24);
        graphics.circle(0, -3, 31);
        graphics.fill();
        graphics.fillColor = COLORS.white;
        graphics.circle(0, 0, 30);
        graphics.fill();
        const button = node.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        button.zoomScale = 0.94;
        return node;
    }

    private _buildBoardLayers(): void {
        const board = new Node('MazePaintBoard');
        board.layer = this.node.layer;
        board.parent = this.node;
        board.setPosition(0, BOARD_Y, 0);
        board.addComponent(UITransform).setContentSize(BOARD_MAX_WIDTH + 32, BOARD_MAX_HEIGHT + 32);
        this._boardRoot = board;

        const interaction = new Node('MazePaintSwipeSurface');
        interaction.layer = board.layer;
        interaction.parent = board;
        interaction.addComponent(UITransform).setContentSize(BOARD_MAX_WIDTH + 32, BOARD_MAX_HEIGHT + 32);
        interaction.on(Node.EventType.TOUCH_START, this._onTouchStart, this);
        interaction.on(Node.EventType.TOUCH_END, this._onTouchEnd, this);
        interaction.on(Node.EventType.TOUCH_CANCEL, this._onTouchCancel, this);

        const cells = new Node('MazePaintCells');
        cells.layer = board.layer;
        cells.parent = board;
        cells.addComponent(UITransform).setContentSize(BOARD_MAX_WIDTH + 20, BOARD_MAX_HEIGHT + 20);
        this._cellLayer = cells;

        const balls = new Node('MazePaintBallLayer');
        balls.layer = board.layer;
        balls.parent = board;
        balls.addComponent(UITransform).setContentSize(BOARD_MAX_WIDTH + 20, BOARD_MAX_HEIGHT + 20);
        this._ballLayer = balls;
    }

    private _buildInstruction(): void {
        const instruction = this._makeLabel(
            this.node,
            'MazePaintInstruction',
            '滑動小球，塗滿所有方格 · 小球會一直滑到撞牆',
            17,
            COLORS.muted,
            false,
            470,
            34,
        );
        instruction.node.setPosition(0, -407, 0);
    }

    private _buildCompleteOverlay(): void {
        const overlay = new Node('MazePaintCompleteOverlay');
        overlay.layer = this.node.layer;
        overlay.parent = this.node;
        overlay.addComponent(UITransform).setContentSize(VIEW_WIDTH, VIEW_HEIGHT);
        overlay.active = false;
        this._completeOverlay = overlay;

        const dim = overlay.addComponent(Graphics);
        dim.fillColor = new Color(61, 47, 50, 175);
        dim.rect(-VIEW_WIDTH / 2, -VIEW_HEIGHT / 2, VIEW_WIDTH, VIEW_HEIGHT);
        dim.fill();

        const card = new Node('CompleteCard');
        card.layer = overlay.layer;
        card.parent = overlay;
        card.setPosition(0, 8, 0);
        card.addComponent(UITransform).setContentSize(410, 306);
        this._completeCard = card;
        const cardGraphics = card.addComponent(Graphics);
        cardGraphics.fillColor = new Color(42, 33, 32, 65);
        cardGraphics.roundRect(-205, -158, 410, 306, 30);
        cardGraphics.fill();
        cardGraphics.fillColor = COLORS.background;
        cardGraphics.roundRect(-205, -150, 410, 300, 30);
        cardGraphics.fill();
        cardGraphics.lineWidth = 3;
        cardGraphics.strokeColor = new Color(255, 255, 255, 190);
        cardGraphics.roundRect(-203, -148, 406, 296, 28);
        cardGraphics.stroke();

        const medal = new Node('CompletionMark');
        medal.layer = card.layer;
        medal.parent = card;
        medal.setPosition(0, 93, 0);
        medal.addComponent(UITransform).setContentSize(62, 62);
        const medalGraphics = medal.addComponent(Graphics);
        this._completionMarkGraphics = medalGraphics;
        this._paintCompletionMark();

        this._completeTitle = this._makeLabel(
            card,
            'CompleteTitle',
            '完成！',
            32,
            COLORS.title,
            true,
            330,
            44,
        );
        this._completeTitle.node.setPosition(0, 42, 0);
        this._completeSubtitle = this._makeLabel(
            card,
            'CompleteSubtitle',
            '全部方格都已塗滿',
            18,
            COLORS.muted,
            false,
            350,
            32,
        );
        this._completeSubtitle.node.setPosition(0, 3, 0);

        const primary = this._makeRoundedButton(card, 'CompletePrimary', '下一關', -91, -82, COLORS.accent);
        this._completePrimaryLabel = primary.getChildByName('Label')?.getComponent(Label) ?? null;
        primary.on(Button.EventType.CLICK, this._handleTerminalPrimary, this);
        const exit = this._makeRoundedButton(card, 'CompleteExit', '返回', 91, -82, new Color(218, 116, 155, 255));
        exit.on(Button.EventType.CLICK, this._requestExit, this);
    }

    private _makeRoundedButton(
        parent: Node,
        name: string,
        text: string,
        x: number,
        y: number,
        color: Color,
    ): Node {
        const node = new Node(name);
        node.layer = parent.layer;
        node.parent = parent;
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(156, 56);
        const graphics = node.addComponent(Graphics);
        graphics.fillColor = new Color(48, 38, 31, 46);
        graphics.roundRect(-78, -31, 156, 56, 18);
        graphics.fill();
        graphics.fillColor = color;
        graphics.roundRect(-78, -27, 156, 54, 18);
        graphics.fill();
        const label = this._makeLabel(node, 'Label', text, 19, COLORS.white, true, 156, 56);
        label.node.setPosition(0, 1, 0);
        const button = node.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        button.zoomScale = 0.95;
        return node;
    }

    private _makeLabel(
        parent: Node,
        name: string,
        text: string,
        fontSize: number,
        color: Color,
        bold: boolean,
        width: number,
        height: number,
    ): Label {
        const node = new Node(name);
        node.layer = parent.layer;
        node.parent = parent;
        node.addComponent(UITransform).setContentSize(width, height);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = fontSize + 5;
        label.isBold = bold;
        label.color = color;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        return label;
    }

    private _loadLevel(index: number): void {
        if (!this._sceneBuilt || !this._cellLayer || !this._ballLayer || this._levels.length === 0) return;
        this._actionToken++;
        this._gesture = null;
        this._stopAnimations();
        this._busy = false;
        if (this._completeOverlay) this._completeOverlay.active = false;

        this._levelIndex = this._clampLevelIndex(index);
        this._level = parseMazePaintLevel(this._levels[this._levelIndex]);
        this._evaluator = new MazePaintEvaluator(this._level, this._now());
        this._cellSize = Math.min(
            MAX_CELL_SIZE,
            BOARD_MAX_WIDTH / this._level.columns,
            BOARD_MAX_HEIGHT / this._level.rows,
        );

        this._clearChildren(this._cellLayer);
        this._clearChildren(this._ballLayer);
        this._cellGraphics.clear();
        this._renderCells();
        this._createBall();
        this._updateHeader();
        this._paintCompletionMark();
    }

    private _renderCells(): void {
        if (!this._level || !this._evaluator || !this._cellLayer) return;
        for (const position of this._level.paintableCells) {
            const cell = new Node(`Cell_${position.row}_${position.column}`);
            cell.layer = this._cellLayer.layer;
            cell.parent = this._cellLayer;
            cell.setPosition(this._cellPosition(position));
            cell.addComponent(UITransform).setContentSize(this._cellSize, this._cellSize);
            const graphics = cell.addComponent(Graphics);
            this._cellGraphics.set(positionKey(position), graphics);
            this._paintCell(position, isCellPainted(this._level, this._evaluator.state, position));
        }
    }

    private _paintCell(position: GridPosition, painted: boolean): void {
        const graphics = this._cellGraphics.get(positionKey(position));
        if (!graphics) return;
        const half = this._cellSize / 2;
        const inset = Math.max(1.5, this._cellSize * 0.025);
        const sideDepth = Math.max(4, this._cellSize * 0.085);
        const palette = this._paintPalette();
        graphics.clear();

        graphics.fillColor = COLORS.shadow;
        graphics.rect(-half + 2, -half - sideDepth - 2, this._cellSize, this._cellSize + sideDepth);
        graphics.fill();
        graphics.fillColor = COLORS.cellSide;
        graphics.rect(-half, -half - sideDepth, this._cellSize, sideDepth + 2);
        graphics.fill();
        graphics.fillColor = painted ? palette.line : COLORS.cellEdge;
        graphics.rect(-half, -half, this._cellSize, this._cellSize);
        graphics.fill();
        graphics.fillColor = painted ? palette.fill : COLORS.cell;
        graphics.rect(
            -half + inset,
            -half + inset,
            this._cellSize - inset * 2,
            this._cellSize - inset * 2,
        );
        graphics.fill();
        graphics.fillColor = painted
            ? new Color(palette.light.r, palette.light.g, palette.light.b, 95)
            : new Color(COLORS.cellLight.r, COLORS.cellLight.g, COLORS.cellLight.b, 70);
        graphics.rect(
            -half + inset * 2,
            half - Math.max(5, this._cellSize * 0.1),
            this._cellSize - inset * 4,
            Math.max(3, this._cellSize * 0.045),
        );
        graphics.fill();
    }

    private _paintPalette(): PaintPalette {
        return LEVEL_PALETTES[this._levelIndex % LEVEL_PALETTES.length];
    }

    private _paintCompletionMark(): void {
        const graphics = this._completionMarkGraphics;
        if (!graphics) return;
        const palette = this._paintPalette();
        graphics.clear();
        graphics.fillColor = palette.fill;
        graphics.circle(0, 0, 29);
        graphics.fill();
        graphics.lineWidth = 6;
        graphics.strokeColor = COLORS.white;
        graphics.lineCap = Graphics.LineCap.ROUND;
        graphics.moveTo(-13, 1);
        graphics.lineTo(-3, -9);
        graphics.lineTo(15, 11);
        graphics.stroke();
    }

    private _createBall(): void {
        if (!this._level || !this._ballLayer) return;
        const ball = new Node('MazePaintBall');
        ball.layer = this._ballLayer.layer;
        ball.parent = this._ballLayer;
        ball.setPosition(this._cellPosition(this._level.start));
        ball.addComponent(UITransform).setContentSize(this._cellSize * 0.82, this._cellSize * 0.82);
        const graphics = ball.addComponent(Graphics);
        const radius = this._cellSize * 0.34;
        graphics.fillColor = new Color(22, 29, 38, 86);
        graphics.ellipse(4, -5, radius * 1.04, radius * 0.96);
        graphics.fill();
        graphics.fillColor = COLORS.ballShade;
        graphics.circle(0, 0, radius);
        graphics.fill();
        graphics.fillColor = COLORS.white;
        graphics.circle(-radius * 0.12, radius * 0.1, radius * 0.87);
        graphics.fill();
        graphics.fillColor = new Color(255, 255, 255, 210);
        graphics.circle(-radius * 0.34, radius * 0.36, radius * 0.27);
        graphics.fill();
        this._ballNode = ball;
    }

    private _updateHeader(): void {
        const labels: Record<MazePaintDifficulty, string> = {
            easy: '簡單',
            medium: '中等',
            hard: '困難',
        };
        if (this._difficultyLabel) this._difficultyLabel.string = labels[this.difficulty];
        if (this._levelLabel) this._levelLabel.string = `第 ${this._levelIndex + 1} 關`;
    }

    private _cellPosition(position: GridPosition): Vec3 {
        if (!this._level) return Vec3.ZERO;
        return new Vec3(
            (position.column - (this._level.columns - 1) / 2) * this._cellSize,
            ((this._level.rows - 1) / 2 - position.row) * this._cellSize,
            0,
        );
    }

    private _onTouchStart(event: EventTouch): void {
        if (!this._canBeginGesture() || this._gesture) return;
        this._gesture = { source: 'touch', start: event.getUILocation().clone() };
    }

    private _onTouchEnd(event: EventTouch): void {
        if (!this._gesture || this._gesture.source !== 'touch') return;
        this._finishGesture(event.getUILocation());
    }

    private _onTouchCancel(event: EventTouch): void {
        if (!this._gesture || this._gesture.source !== 'touch') return;
        // Cocos emits TOUCH_CANCEL when a swipe that began on the board ends
        // just outside its rectangle; it is still a valid directional swipe.
        this._finishGesture(event.getUILocation());
    }

    private _onMouseDown(event: EventMouse): void {
        if (event.getButton() !== EventMouse.BUTTON_LEFT || !this._canBeginGesture() || this._gesture) return;
        const location = event.getUILocation();
        if (!this._isPointInBoard(location)) return;
        this._gesture = { source: 'mouse', start: location.clone() };
    }

    private _onMouseUp(event: EventMouse): void {
        if (!this._gesture || this._gesture.source !== 'mouse') return;
        this._finishGesture(event.getUILocation());
    }

    private _canBeginGesture(): boolean {
        return !this._busy && !!this._evaluator && !this._evaluator.terminal;
    }

    private _isPointInBoard(location: Vec2): boolean {
        if (!this._boardRoot) return false;
        const transform = this._boardRoot.getComponent(UITransform);
        if (!transform) return false;
        const local = transform.convertToNodeSpaceAR(new Vec3(location.x, location.y, 0));
        return Math.abs(local.x) <= (BOARD_MAX_WIDTH + 32) / 2
            && Math.abs(local.y) <= (BOARD_MAX_HEIGHT + 32) / 2;
    }

    private _finishGesture(end: Readonly<Vec2>): void {
        const gesture = this._gesture;
        this._gesture = null;
        if (!gesture || !this._canBeginGesture()) return;
        const dx = end.x - gesture.start.x;
        const dy = end.y - gesture.start.y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_THRESHOLD) return;
        let direction: MazePaintDirection;
        if (Math.abs(dx) > Math.abs(dy)) direction = dx > 0 ? 'right' : 'left';
        else direction = dy > 0 ? 'up' : 'down';
        this._performMove(direction);
    }

    private _performMove(direction: MazePaintDirection): void {
        if (!this._level || !this._evaluator || !this._ballNode || !this._canBeginGesture()) return;
        const result = computeMazePaintMove(this._level, this._evaluator.state, direction);
        const startedAt = this._now();
        const token = ++this._actionToken;
        this._busy = true;

        if (!result.moved) {
            this._recordInvalidMove(result, direction, startedAt, token);
            return;
        }
        this._animateMove(result, startedAt, token, 0);
    }

    private _animateMove(
        result: MazePaintMoveResult,
        startedAt: number,
        token: number,
        stepIndex: number,
    ): void {
        if (token !== this._actionToken || !this._ballNode) return;
        if (stepIndex >= result.traversedCells.length) {
            this._commitMove(result, startedAt, token);
            return;
        }
        const position = result.traversedCells[stepIndex];
        tween(this._ballNode)
            .to(
                SEGMENT_DURATION_SECONDS,
                { position: this._cellPosition(position) },
                { easing: 'linear' },
            )
            .call(() => {
                if (token !== this._actionToken) return;
                if (result.newlyPaintedCells.some(cell => positionKey(cell) === positionKey(position))) {
                    this._paintCell(position, true);
                }
                this._animateMove(result, startedAt, token, stepIndex + 1);
            })
            .start();
    }

    private _commitMove(result: MazePaintMoveResult, startedAt: number, token: number): void {
        if (token !== this._actionToken || !this._evaluator) return;
        try {
            this._evaluator.recordMove(result, startedAt, this._now());
        } catch (error) {
            console.error('[MazePaint] Failed to commit rendered move.', error);
            this._evaluator.terminate('environment_error', this._now());
        }
        if (this._evaluator.terminal) {
            this._playTerminalFeedback(token);
        } else {
            this._busy = false;
        }
    }

    private _recordInvalidMove(
        result: MazePaintMoveResult,
        direction: MazePaintDirection,
        startedAt: number,
        token: number,
    ): void {
        if (!this._evaluator || !this._ballNode) return;
        try {
            this._evaluator.recordMove(result, startedAt, this._now());
        } catch (error) {
            console.error('[MazePaint] Failed to record invalid direction.', error);
            this._evaluator.terminate('environment_error', this._now());
        }

        const origin = this._ballNode.position.clone();
        const amount = Math.max(5, this._cellSize * 0.09);
        const delta: Record<MazePaintDirection, readonly [number, number]> = {
            up: [0, amount],
            down: [0, -amount],
            left: [-amount, 0],
            right: [amount, 0],
        };
        const [dx, dy] = delta[direction];
        tween(this._ballNode)
            .to(0.055, { position: new Vec3(origin.x + dx, origin.y + dy, origin.z) }, { easing: 'sineOut' })
            .to(0.09, { position: origin }, { easing: 'sineInOut' })
            .call(() => {
                if (token !== this._actionToken) return;
                if (this._evaluator?.terminal) this._showTerminalOverlay();
                else this._busy = false;
            })
            .start();
    }

    private _playTerminalFeedback(token: number): void {
        if (!this._ballNode || !this._evaluator) {
            this._busy = false;
            this._showTerminalOverlay();
            return;
        }
        if (!this._evaluator.status || this._evaluator.status !== 'success') {
            this._busy = false;
            this._showTerminalOverlay();
            return;
        }
        const ball = this._ballNode;
        tween(ball)
            .to(0.12, { scale: new Vec3(1.18, 1.18, 1) }, { easing: 'sineOut' })
            .to(0.14, { scale: Vec3.ONE }, { easing: 'backOut' })
            .call(() => {
                if (token !== this._actionToken) return;
                this._busy = false;
                this._showTerminalOverlay();
            })
            .start();
    }

    private _showTerminalOverlay(): void {
        if (!this._completeOverlay || !this._evaluator || !this._evaluator.terminal) return;
        const success = this._evaluator.status === 'success';
        if (this._completeTitle) this._completeTitle.string = success ? '完成！' : '挑戰結束';
        if (this._completeSubtitle) {
            this._completeSubtitle.string = success
                ? '全部方格都已塗滿'
                : this._failureMessage(this._evaluator.terminationReason);
        }
        if (this._completePrimaryLabel) {
            this._completePrimaryLabel.string = success
                ? (this._levelIndex + 1 < this._levels.length ? '下一關' : '再玩一次')
                : '重新挑戰';
        }
        this._busy = false;
        this._completeOverlay.active = true;
        if (this._completeCard) {
            Tween.stopAllByTarget(this._completeCard);
            this._completeCard.setScale(0.84, 0.84, 1);
            tween(this._completeCard)
                .to(0.25, { scale: Vec3.ONE }, { easing: 'backOut' })
                .start();
        }
    }

    private _failureMessage(reason: string | null): string {
        switch (reason) {
            case 'repeated_action_cycle': return '偵測到持續重複的操作';
            case 'no_progress': return '長時間沒有新的塗色進度';
            case 'max_steps': return '已達本關操作次數上限';
            case 'timeout': return '本次挑戰已逾時';
            default: return '遊戲狀態發生錯誤';
        }
    }

    private _handleTerminalPrimary(): void {
        if (!this._evaluator) return;
        if (this._evaluator.status === 'success' && this._levelIndex + 1 < this._levels.length) {
            this._loadLevel(this._levelIndex + 1);
        } else {
            this._loadLevel(this._levelIndex);
        }
    }

    private _requestExit(): void {
        this._actionToken++;
        this._gesture = null;
        this._stopAnimations();
        this.onRequestExit?.();
    }

    private _stopAnimations(): void {
        if (this._ballNode) Tween.stopAllByTarget(this._ballNode);
        if (this._completeCard) Tween.stopAllByTarget(this._completeCard);
    }

    private _clearChildren(parent: Node): void {
        for (const child of [...parent.children]) {
            child.removeFromParent();
            child.destroy();
        }
        if (parent === this._ballLayer) this._ballNode = null;
    }

    private _now(): number {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }
}
