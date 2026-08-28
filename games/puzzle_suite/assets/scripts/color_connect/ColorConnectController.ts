import {
    _decorator,
    Button,
    Canvas,
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
    UIOpacity,
    Vec2,
    Vec3,
    input,
    tween,
    view,
} from 'cc';
import { VIEWPORT_HEIGHT, VIEWPORT_WIDTH } from '../data/LevelData';
import { GameInspector } from '../game/GameInspector';
import type { InspectorProvider, PhysicsStats } from '../game/GameInspector';
import { ColorConnectEvaluator } from './ColorConnectEvaluator';
import {
    colorConnectCellCenter,
    colorConnectLocalToGridPoint,
    hitColorConnectGrid,
    isColorConnectGridPointInside,
} from './ColorConnectGridGeometry';
import type {
    ColorConnectGridGeometry,
    ColorConnectGridHit,
    ColorConnectGridPoint,
} from './ColorConnectGridGeometry';
import {
    getColorConnectLevels,
} from './ColorConnectLevelData';
import type {
    ColorConnectDifficulty,
    ColorConnectLevelDefinition,
} from './ColorConnectLevelData';
import {
    colorConnectPositionKey,
    hashColorConnectState,
    parseColorConnectLevel,
} from './ColorConnectRules';
import type {
    ColorConnectLevel,
    ColorConnectState,
    ColorConnectTransitionResult,
    ColorConnectViolation,
    GridPosition,
} from './ColorConnectRules';
import { solveColorConnectLevel } from './ColorConnectSolver';

const { ccclass } = _decorator;

const BOARD_MAX_WIDTH = 520;
const BOARD_MAX_HEIGHT = 600;
const BOARD_MAX_PITCH = 88;
const BOARD_CENTER_Y = 22;
const CELL_FILL_RATIO = 0.9;
const HEADER_BUTTON_Y = 390;
const MOUSE_AFTER_TOUCH_GUARD_MS = 450;
const MAX_RASTER_STEPS = 256;

const COLORS = {
    background: new Color(42, 50, 59, 255),
    backgroundShade: new Color(33, 40, 48, 95),
    cell: new Color(29, 34, 40, 255),
    blockedCell: new Color(19, 23, 28, 255),
    blockedMark: new Color(70, 78, 87, 210),
    white: new Color(250, 250, 250, 255),
    muted: new Color(150, 158, 168, 255),
    difficultyPill: new Color(58, 53, 62, 245),
    backIcon: new Color(215, 132, 169, 255),
    restartButton: new Color(73, 84, 97, 255),
    restartIcon: new Color(137, 149, 165, 255),
    gridShadow: new Color(7, 10, 14, 78),
    pathShadow: new Color(7, 9, 12, 92),
    invalid: new Color(255, 69, 76, 235),
    success: new Color(118, 255, 180, 235),
};

type GestureSource = 'touch' | 'mouse' | 'pointer';

type ContinuousGridPoint = ColorConnectGridPoint;

interface GridHitResult {
    readonly row: number;
    readonly column: number;
    readonly localPosition: Vec3;
    readonly cellCenter: Vec3;
    readonly gridPoint: ContinuousGridPoint;
}

interface GestureState {
    readonly source: GestureSource;
    readonly pointerId: number;
    previousPoint: ContinuousGridPoint;
    lastCell: GridPosition;
    moved: boolean;
}

interface BoardLayout {
    readonly pitch: number;
    readonly cellSize: number;
    readonly width: number;
    readonly height: number;
    readonly centerY: number;
}

/**
 * Pure-code presentation/controller for Color Connect.
 *
 * Rules and metrics live outside the scene graph. The controller maps pointer
 * segments or click-to-click waypoints to an ordered sequence of orthogonal
 * cells, sends each cell through the evaluator/rules authority, and redraws
 * only from the returned state.
 */
@ccclass('ColorConnectController')
export class ColorConnectController extends Component {
    public difficulty: ColorConnectDifficulty = 'easy';
    public onRequestExit: (() => void) | null = null;
    private _directLaunchMode = false;

    private _levels: readonly ColorConnectLevelDefinition[] = [];
    private _levelIndex = 0;
    private _initialLevelIndex = 0;
    private _level: ColorConnectLevel | null = null;
    private _evaluator: ColorConnectEvaluator | null = null;

    private _sceneBuilt = false;
    private _exiting = false;
    private _animationLocked = false;
    private _boardInputBound = false;
    private _globalInputBound = false;
    private _inspectorRegistered = false;
    private _actionToken = 0;
    private _gesture: GestureState | null = null;
    private _ignoreMouseUntil = 0;
    private _layout: BoardLayout = {
        pitch: BOARD_MAX_PITCH,
        cellSize: BOARD_MAX_PITCH * CELL_FILL_RATIO,
        width: 0,
        height: 0,
        centerY: 0,
    };
    private _geometry: ColorConnectGridGeometry = { rows: 0, columns: 0, pitch: BOARD_MAX_PITCH };

    private _boardRoot: Node | null = null;
    private _interactionSurface: Node | null = null;
    private _domCanvas: HTMLCanvasElement | null = null;
    private _previousCanvasTouchAction = '';
    private _canvasTransform: UITransform | null = null;
    private _gridGraphics: Graphics | null = null;
    private _pathLayer: Node | null = null;
    private _pathGraphics: Graphics | null = null;
    private _endpointLayer: Node | null = null;
    private _feedbackLayer: Node | null = null;
    private readonly _endpointNodes = new Map<string, Node>();
    private readonly _endpointColors = new Map<string, Color>();
    private _difficultyLabel: Label | null = null;
    private _levelLabel: Label | null = null;
    private readonly _uiLocationScratch = new Vec2();
    private readonly _canvasLocalScratch = new Vec3();
    private readonly _worldScratch = new Vec3();
    private readonly _boardLocalScratch = new Vec3();
    private readonly _visualTailCurrent = new Vec3();
    private readonly _visualTailTarget = new Vec3();
    private _visualTailVisible = false;
    private _pathRenderDirty = false;

    private readonly _inspectorProvider: InspectorProvider = {
        snapshot: () => {
            const ready = this._isReady();
            const busy = this._isBusy();
            if (!this._evaluator) {
                return {
                    ready,
                    busy,
                    controls: { exit: true, restart: false },
                };
            }
            return {
                ...this._evaluator.snapshot(this._now()),
                ready,
                busy,
                controls: { exit: true, restart: true },
            };
        },
        outcomeHash: () => {
            if (!this._level || !this._evaluator) {
                return `${this.difficulty}:${this._levelIndex}:not-ready:${this._isBusy() ? 1 : 0}`;
            }
            return [
                this.difficulty,
                this._level.id,
                hashColorConnectState(this._level, this._evaluator.state),
                this._evaluator.status,
                this._isBusy() ? 1 : 0,
            ].join(':');
        },
        physicsStats: (): PhysicsStats => ({
            quiet: !this._isBusy(),
            maxLinearVelocity: 0,
            movingBodies: this._isBusy() ? 1 : 0,
        }),
    };

    onLoad(): void {
        this._applyDifficulty(this.difficulty);
    }

    onEnable(): void {
        this._exiting = false;
        this._registerInspector();
        if (this._sceneBuilt) this._bindInputs();
    }

    start(): void {
        this._buildScene();
        this._loadLevel(this._initialLevelIndex);
    }

    update(deltaTime: number): void {
        if (!this._evaluator) return;
        // snapshot() owns timeout polling so the benchmark and an idle visual
        // frame observe the same terminal transition.
        this._evaluator.snapshot(this._now());
        this._updateVisualTail(deltaTime);
    }

    onDisable(): void {
        this._cleanupRuntime();
        this._unregisterInspector();
    }

    onDestroy(): void {
        this._cleanupRuntime();
        this._unregisterInspector();
        this._sceneBuilt = false;
    }

    private _cleanupRuntime(): void {
        this._actionToken++;
        if (this._evaluator && (this._gesture || this._evaluator.state.activeColorId !== null)) {
            this._evaluator.endGesture(this._now());
        }
        this._gesture = null;
        this._animationLocked = false;
        this._resetVisualTail();
        this.unscheduleAllCallbacks();
        this._stopAnimations();
        this._unbindInputs();
    }

    public setDifficulty(difficulty: ColorConnectDifficulty): void {
        this.difficulty = difficulty;
        this._applyDifficulty(difficulty);
        if (this._sceneBuilt) this._loadLevel(0);
    }

    /** Select a one-based screenshot level within the chosen difficulty. */
    public setInitialLevel(levelId: number): void {
        this._initialLevelIndex = this._clampLevelIndex(Math.trunc(levelId) - 1);
        if (this._sceneBuilt) this._loadLevel(this._initialLevelIndex);
    }

    /** Hide navigation that would leave a query-launched game without updating its URL. */
    public setDirectLaunchMode(enabled: boolean): void {
        this._directLaunchMode = enabled;
    }

    /** Reset gameplay, metrics, transient paths, feedback and animation locks. */
    public resetCurrentLevel(): void {
        if (!this._sceneBuilt || !this._level || !this._evaluator) return;
        this._actionToken++;
        this._gesture = null;
        this._animationLocked = false;
        this._resetVisualTail();
        this._stopAnimations();
        this._clearFeedback();
        this._evaluator.restart(this._now());
        this._renderPaths();
        this._paintAllEndpoints();
    }

    private _applyDifficulty(difficulty: ColorConnectDifficulty): void {
        this._levels = getColorConnectLevels(difficulty);
        this._levelIndex = 0;
        this._initialLevelIndex = this._clampLevelIndex(this._initialLevelIndex);
    }

    private _clampLevelIndex(index: number): number {
        if (!Number.isFinite(index) || this._levels.length === 0) return 0;
        return Math.max(0, Math.min(this._levels.length - 1, index));
    }

    private _buildScene(): void {
        const transform = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
        transform.setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        transform.setAnchorPoint(0.5, 0.5);
        this._drawBackground();
        this._buildHeader();
        this._buildBoardLayers();
        this._canvasTransform = this._findCanvasTransform();
        this._sceneBuilt = true;
        if (this.node.activeInHierarchy && this.enabled) this._bindInputs();
    }

    private _drawBackground(): void {
        const node = new Node('ColorConnectBackground');
        node.layer = this.node.layer;
        node.parent = this.node;
        node.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        const graphics = node.addComponent(Graphics);
        graphics.fillColor = COLORS.background;
        graphics.rect(-VIEWPORT_WIDTH / 2, -VIEWPORT_HEIGHT / 2, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        graphics.fill();
        graphics.fillColor = COLORS.backgroundShade;
        graphics.circle(-245, 435, 230);
        graphics.fill();
        graphics.fillColor = new Color(55, 64, 74, 42);
        graphics.circle(295, -455, 310);
        graphics.fill();
    }

    private _buildHeader(): void {
        if (!this._directLaunchMode) {
            const back = this._makeCircleButton('ColorConnectBack', -220, HEADER_BUTTON_Y, COLORS.white);
            const backIcon = new Node('BackIcon');
            backIcon.layer = back.layer;
            backIcon.parent = back;
            const backGraphics = backIcon.addComponent(Graphics);
            backGraphics.strokeColor = COLORS.backIcon;
            backGraphics.lineWidth = 9;
            backGraphics.lineCap = Graphics.LineCap.ROUND;
            backGraphics.lineJoin = Graphics.LineJoin.ROUND;
            backGraphics.moveTo(8, 17);
            backGraphics.lineTo(-9, 0);
            backGraphics.lineTo(8, -17);
            backGraphics.stroke();
            back.on(Button.EventType.CLICK, this._requestExit, this);
        }

        const restart = this._makeCircleButton(
            'ColorConnectRestart',
            220,
            HEADER_BUTTON_Y,
            COLORS.restartButton,
        );
        const restartIcon = new Node('RestartIcon');
        restartIcon.layer = restart.layer;
        restartIcon.parent = restart;
        const restartGraphics = restartIcon.addComponent(Graphics);
        restartGraphics.strokeColor = COLORS.restartIcon;
        restartGraphics.lineWidth = 7;
        restartGraphics.lineCap = Graphics.LineCap.ROUND;
        restartGraphics.moveTo(-14, 8);
        restartGraphics.bezierCurveTo(-5, 22, 18, 17, 18, -4);
        restartGraphics.bezierCurveTo(17, -18, -1, -22, -14, -11);
        restartGraphics.stroke();
        restartGraphics.fillColor = COLORS.restartIcon;
        restartGraphics.moveTo(-20, 8);
        restartGraphics.lineTo(-6, 17);
        restartGraphics.lineTo(-8, 1);
        restartGraphics.close();
        restartGraphics.fill();
        restart.on(Button.EventType.CLICK, this.resetCurrentLevel, this);

        const pill = new Node('ColorConnectDifficultyPill');
        pill.layer = this.node.layer;
        pill.parent = this.node;
        pill.setPosition(0, 414, 0);
        pill.addComponent(UITransform).setContentSize(130, 30);
        const pillGraphics = pill.addComponent(Graphics);
        pillGraphics.fillColor = COLORS.difficultyPill;
        pillGraphics.roundRect(-65, -15, 130, 30, 15);
        pillGraphics.fill();
        this._difficultyLabel = this._makeLabel(pill, 'DifficultyLabel', '', 18, COLORS.white, true, 130, 30);

        this._levelLabel = this._makeLabel(
            this.node,
            'ColorConnectLevelLabel',
            '',
            35,
            COLORS.white,
            true,
            250,
            48,
        );
        this._levelLabel.node.setPosition(0, 365, 0);
    }

    private _makeCircleButton(name: string, x: number, y: number, fill: Color): Node {
        const node = new Node(name);
        node.layer = this.node.layer;
        node.parent = this.node;
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(70, 70);
        const graphics = node.addComponent(Graphics);
        graphics.fillColor = new Color(6, 10, 14, 50);
        graphics.circle(0, -4, 34);
        graphics.fill();
        graphics.fillColor = fill;
        graphics.circle(0, 0, 33);
        graphics.fill();
        const button = node.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        button.zoomScale = 0.93;
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
        label.color = color;
        label.isBold = bold;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        return label;
    }

    private _buildBoardLayers(): void {
        const board = new Node('ColorConnectBoard');
        board.layer = this.node.layer;
        board.parent = this.node;
        board.addComponent(UITransform).setContentSize(BOARD_MAX_WIDTH, BOARD_MAX_HEIGHT);
        this._boardRoot = board;

        const grid = new Node('ColorConnectGrid');
        grid.layer = board.layer;
        grid.parent = board;
        grid.addComponent(UITransform).setContentSize(BOARD_MAX_WIDTH, BOARD_MAX_HEIGHT);
        this._gridGraphics = grid.addComponent(Graphics);

        const paths = new Node('ColorConnectPaths');
        paths.layer = board.layer;
        paths.parent = board;
        paths.addComponent(UITransform).setContentSize(BOARD_MAX_WIDTH, BOARD_MAX_HEIGHT);
        this._pathLayer = paths;
        this._pathGraphics = paths.addComponent(Graphics);

        const endpoints = new Node('ColorConnectEndpoints');
        endpoints.layer = board.layer;
        endpoints.parent = board;
        endpoints.addComponent(UITransform).setContentSize(BOARD_MAX_WIDTH, BOARD_MAX_HEIGHT);
        this._endpointLayer = endpoints;

        const feedback = new Node('ColorConnectFeedback');
        feedback.layer = board.layer;
        feedback.parent = board;
        feedback.addComponent(UITransform).setContentSize(BOARD_MAX_WIDTH, BOARD_MAX_HEIGHT);
        this._feedbackLayer = feedback;

        // Browser pointer input is dispatched through Cocos' UI node event
        // processor, not reliably through the global Input mouse channel.
        // Keep this transparent surface last/topmost so both real touch and
        // Playwright mouse drags receive a sticky TOUCH_* sequence.
        const interaction = new Node('ColorConnectInteractionSurface');
        interaction.layer = board.layer;
        interaction.parent = board;
        interaction.addComponent(UITransform).setContentSize(BOARD_MAX_WIDTH, BOARD_MAX_HEIGHT);
        this._interactionSurface = interaction;
    }

    private _loadLevel(index: number): void {
        if (!this._sceneBuilt || this._levels.length === 0 || !this._boardRoot) return;
        this._actionToken++;
        this._gesture = null;
        this._animationLocked = false;
        this._resetVisualTail();
        this._stopAnimations();
        this._clearFeedback();
        this._clearEndpointNodes();

        this._levelIndex = this._clampLevelIndex(index);
        this._level = parseColorConnectLevel(this._levels[this._levelIndex]);
        const reference = solveColorConnectLevel(this._level);
        if (!reference.solvable || reference.referenceTotalPathLength === null) {
            throw new Error(`${this._level.id}: no validated Color Connect reference is available.`);
        }
        this._evaluator = new ColorConnectEvaluator(this._level, this._now(), {
            referenceTotalPathLength: reference.referenceTotalPathLength,
        });
        this._layout = this._computeLayout(this._level.rows, this._level.columns);
        this._geometry = {
            rows: this._level.rows,
            columns: this._level.columns,
            pitch: this._layout.pitch,
        };
        this._boardRoot.setPosition(0, this._layout.centerY, 0);
        this._boardRoot.getComponent(UITransform)?.setContentSize(this._layout.width, this._layout.height);
        this._interactionSurface?.getComponent(UITransform)?.setContentSize(
            this._layout.width,
            this._layout.height,
        );
        this._paintGrid();
        this._createEndpoints();
        this._renderPaths();
        this._paintAllEndpoints();
        this._updateHeader();
    }

    private _computeLayout(rows: number, columns: number): BoardLayout {
        const pitch = Math.min(
            BOARD_MAX_PITCH,
            BOARD_MAX_WIDTH / Math.max(columns, 1),
            BOARD_MAX_HEIGHT / Math.max(rows, 1),
        );
        const width = columns * pitch;
        const height = rows * pitch;
        return Object.freeze({
            pitch,
            cellSize: pitch * CELL_FILL_RATIO,
            width,
            height,
            centerY: BOARD_CENTER_Y,
        });
    }

    private _paintGrid(): void {
        if (!this._level || !this._gridGraphics) return;
        const graphics = this._gridGraphics;
        const half = this._layout.cellSize / 2;
        const radius = Math.max(5, this._layout.cellSize * 0.075);
        graphics.clear();
        for (let row = 0; row < this._level.rows; row++) {
            for (let column = 0; column < this._level.columns; column++) {
                const position = { row, column };
                const center = this._cellPosition(position);
                graphics.fillColor = COLORS.gridShadow;
                graphics.roundRect(
                    center.x - half + 1.5,
                    center.y - half - 2.5,
                    this._layout.cellSize,
                    this._layout.cellSize,
                    radius,
                );
                graphics.fill();
                const blocked = this._level.blockedCellKeys[colorConnectPositionKey(position)] === true;
                graphics.fillColor = blocked ? COLORS.blockedCell : COLORS.cell;
                graphics.roundRect(
                    center.x - half,
                    center.y - half,
                    this._layout.cellSize,
                    this._layout.cellSize,
                    radius,
                );
                graphics.fill();
                if (blocked) {
                    const mark = this._layout.cellSize * 0.18;
                    graphics.strokeColor = COLORS.blockedMark;
                    graphics.lineWidth = Math.max(3, this._layout.cellSize * 0.055);
                    graphics.lineCap = Graphics.LineCap.ROUND;
                    graphics.moveTo(center.x - mark, center.y - mark);
                    graphics.lineTo(center.x + mark, center.y + mark);
                    graphics.moveTo(center.x - mark, center.y + mark);
                    graphics.lineTo(center.x + mark, center.y - mark);
                    graphics.stroke();
                }
            }
        }
    }

    private _createEndpoints(): void {
        if (!this._level || !this._endpointLayer) return;
        this._endpointColors.clear();
        for (const pair of this._level.colorPairs) {
            const color = this._colorFromHex(pair.displayColor);
            this._endpointColors.set(pair.colorId, color);
            this._createEndpoint(pair.colorId, pair.start, color);
            this._createEndpoint(pair.colorId, pair.end, color);
        }
    }

    private _createEndpoint(colorId: string, position: GridPosition, color: Color): void {
        if (!this._endpointLayer) return;
        const key = colorConnectPositionKey(position);
        const node = new Node(`Endpoint_${colorId}_${position.row}_${position.column}`);
        node.layer = this._endpointLayer.layer;
        node.parent = this._endpointLayer;
        node.setPosition(this._cellPosition(position));
        node.addComponent(UITransform).setContentSize(this._layout.cellSize, this._layout.cellSize);
        node.addComponent(Graphics);
        this._endpointNodes.set(key, node);
        this._paintEndpointNode(node, color, false);
    }

    private _paintAllEndpoints(): void {
        if (!this._level || !this._evaluator) return;
        const activeStart = this._evaluator.state.activePath[0] ?? null;
        for (const pair of this._level.colorPairs) {
            const color = this._endpointColors.get(pair.colorId) ?? this._colorFromHex(pair.displayColor);
            const completed = this._evaluator.state.paths[pair.colorId].completed;
            const first = this._endpointNodes.get(colorConnectPositionKey(pair.start));
            const second = this._endpointNodes.get(colorConnectPositionKey(pair.end));
            const firstSelected = activeStart !== null
                && activeStart.row === pair.start.row
                && activeStart.column === pair.start.column;
            const secondSelected = activeStart !== null
                && activeStart.row === pair.end.row
                && activeStart.column === pair.end.column;
            if (first) this._paintEndpointNode(first, color, completed, firstSelected);
            if (second) this._paintEndpointNode(second, color, completed, secondSelected);
        }
    }

    private _paintEndpointNode(
        node: Node,
        color: Color,
        completed: boolean,
        selected: boolean = false,
    ): void {
        const graphics = node.getComponent(Graphics);
        if (!graphics) return;
        const radius = this._layout.cellSize * 0.365;
        graphics.clear();
        graphics.fillColor = new Color(4, 7, 10, 92);
        graphics.ellipse(2.5, -3.5, radius * 1.02, radius * 0.98);
        graphics.fill();
        if (selected) {
            graphics.fillColor = new Color(255, 255, 255, 50);
            graphics.circle(0, 0, radius * 1.35);
            graphics.fill();
            graphics.strokeColor = new Color(255, 255, 255, 255);
            graphics.lineWidth = Math.max(4, this._layout.cellSize * 0.065);
            graphics.circle(0, 0, radius * 1.15);
            graphics.stroke();
        }
        if (completed) {
            graphics.fillColor = new Color(color.r, color.g, color.b, 72);
            graphics.circle(0, 0, radius * 1.18);
            graphics.fill();
        }
        graphics.fillColor = color;
        graphics.circle(0, 0, radius);
        graphics.fill();
        graphics.fillColor = new Color(255, 255, 255, 52);
        graphics.circle(-radius * 0.28, radius * 0.3, radius * 0.24);
        graphics.fill();
        if (completed || selected) {
            graphics.strokeColor = new Color(255, 255, 255, 178);
            graphics.lineWidth = Math.max(2, this._layout.cellSize * 0.035);
            graphics.circle(0, 0, radius * 0.78);
            graphics.stroke();
        }
    }

    private _renderPaths(): void {
        if (!this._evaluator || !this._pathGraphics) return;
        const graphics = this._pathGraphics;
        const state = this._evaluator.state;
        const completedPaths = Object.keys(state.paths)
            .map(colorId => state.paths[colorId])
            .filter(path => path.completed && path.cells.length > 1);
        graphics.clear();
        graphics.lineCap = Graphics.LineCap.ROUND;
        graphics.lineJoin = Graphics.LineJoin.ROUND;

        for (const path of completedPaths) {
            this._strokePath(graphics, path.cells, COLORS.pathShadow, this._layout.cellSize * 0.56, 2, -2);
        }
        if (state.activePath.length > 1) {
            this._strokePath(graphics, state.activePath, COLORS.pathShadow, this._layout.cellSize * 0.56, 2, -2);
        }
        for (const path of completedPaths) {
            const color = this._endpointColors.get(path.colorId) ?? COLORS.white;
            this._strokePath(graphics, path.cells, color, this._layout.cellSize * 0.48);
        }
        if (state.activeColorId && state.activePath.length > 1) {
            const color = this._endpointColors.get(state.activeColorId) ?? COLORS.white;
            this._strokePath(graphics, state.activePath, color, this._layout.cellSize * 0.48);
        }
        if (state.activeColorId && state.activePath.length > 0 && this._visualTailVisible) {
            const color = this._endpointColors.get(state.activeColorId) ?? COLORS.white;
            this._strokeVisualTail(graphics, state.activePath, COLORS.pathShadow, this._layout.cellSize * 0.56, 2, -2);
            this._strokeVisualTail(graphics, state.activePath, color, this._layout.cellSize * 0.48);
        }
        this._pathRenderDirty = false;
    }

    private _strokeVisualTail(
        graphics: Graphics,
        cells: readonly GridPosition[],
        color: Color,
        width: number,
        offsetX: number = 0,
        offsetY: number = 0,
    ): void {
        const last = cells[cells.length - 1];
        if (!last) return;
        const start = this._cellPosition(last);
        if (Math.abs(start.x - this._visualTailCurrent.x) < 0.1
            && Math.abs(start.y - this._visualTailCurrent.y) < 0.1) return;
        graphics.strokeColor = color;
        graphics.lineWidth = width;
        graphics.moveTo(start.x + offsetX, start.y + offsetY);
        graphics.lineTo(this._visualTailCurrent.x + offsetX, this._visualTailCurrent.y + offsetY);
        graphics.stroke();
    }

    private _strokePath(
        graphics: Graphics,
        cells: readonly GridPosition[],
        color: Color,
        width: number,
        offsetX: number = 0,
        offsetY: number = 0,
    ): void {
        if (cells.length < 2) return;
        const first = this._cellPosition(cells[0]);
        graphics.strokeColor = color;
        graphics.lineWidth = width;
        graphics.moveTo(first.x + offsetX, first.y + offsetY);
        for (let index = 1; index < cells.length; index++) {
            const point = this._cellPosition(cells[index]);
            graphics.lineTo(point.x + offsetX, point.y + offsetY);
        }
        graphics.stroke();
    }

    private _updateHeader(): void {
        const sourceTitle = this._level?.sourceTitle ?? '';
        const match = /^(简单|簡單|困难|困難|超难|超難)\s*第\s*(\d+)\s*[关關]$/u.exec(sourceTitle);
        const sourceDifficulty = match?.[1] ?? (this.difficulty === 'easy' ? '簡單' : '困難');
        const traditionalDifficulty: Record<string, string> = {
            '简单': '簡單', '簡單': '簡單',
            '困难': '困難', '困難': '困難',
            '超难': '超難', '超難': '超難',
        };
        if (this._difficultyLabel) {
            this._difficultyLabel.string = traditionalDifficulty[sourceDifficulty] ?? sourceDifficulty;
        }
        if (this._levelLabel) {
            this._levelLabel.string = `第 ${match?.[2] ?? this._levelIndex + 1} 關`;
        }
    }

    private _cellPosition(position: Readonly<GridPosition>): Vec3 {
        if (!this._level) return Vec3.ZERO;
        const center = colorConnectCellCenter(position.row, position.column, this._gridGeometry());
        return new Vec3(center.x, center.y, 0);
    }

    private _onTouchStart(event: EventTouch): void {
        const pointerId = this._touchId(event);
        this._ignoreMouseUntil = this._now() + MOUSE_AFTER_TOUCH_GUARD_MS;
        this._beginGesture('touch', pointerId, event.getUILocation());
    }

    private _onTouchMove(event: EventTouch): void {
        if (!this._matchesGesture('touch', this._touchId(event))) return;
        this._advanceGesture(event.getUILocation());
    }

    private _onTouchEnd(event: EventTouch): void {
        if (!this._matchesGesture('touch', this._touchId(event))) return;
        this._ignoreMouseUntil = this._now() + MOUSE_AFTER_TOUCH_GUARD_MS;
        this._finishGesture(event.getUILocation());
    }

    private _onTouchCancel(event: EventTouch): void {
        if (!this._matchesGesture('touch', this._touchId(event))) return;
        this._ignoreMouseUntil = this._now() + MOUSE_AFTER_TOUCH_GUARD_MS;
        this._cancelGesture();
    }

    private _onMouseDown(event: EventMouse): void {
        if (event.getButton() !== EventMouse.BUTTON_LEFT || this._now() < this._ignoreMouseUntil) return;
        this._beginGesture('mouse', 0, event.getUILocation());
    }

    private _onMouseMove(event: EventMouse): void {
        if (!this._matchesGesture('mouse', 0)) return;
        this._advanceGesture(event.getUILocation());
    }

    private _onMouseUp(event: EventMouse): void {
        if (event.getButton() !== EventMouse.BUTTON_LEFT || !this._matchesGesture('mouse', 0)) return;
        this._finishGesture(event.getUILocation());
    }

    /**
     * Cocos' web-mobile backend does not consistently forward browser pointer
     * events to the global mouse channel or a transparent UITransform. This
     * canvas-level adapter only converts coordinates; all gameplay still flows
     * through the same gesture, evaluator, and authoritative rules pipeline.
     */
    private readonly _onDomPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0 || !event.isPrimary) return;
        const location = this._domPointerLocation(event);
        if (!location) return;
        this._beginGesture('pointer', event.pointerId, location);
        if (!this._matchesGesture('pointer', event.pointerId)) return;
        event.preventDefault();
        this._domCanvas?.setPointerCapture?.(event.pointerId);
    };

    private readonly _onDomPointerMove = (event: PointerEvent): void => {
        if (!this._matchesGesture('pointer', event.pointerId)) return;
        const location = this._domPointerLocation(event);
        if (!location) return;
        event.preventDefault();
        this._advanceGesture(location);
    };

    private readonly _onDomPointerUp = (event: PointerEvent): void => {
        if (!this._matchesGesture('pointer', event.pointerId)) return;
        const location = this._domPointerLocation(event);
        if (!location) return;
        event.preventDefault();
        this._finishGesture(location);
        if (this._domCanvas?.hasPointerCapture?.(event.pointerId)) {
            this._domCanvas.releasePointerCapture(event.pointerId);
        }
    };

    private readonly _onDomPointerCancel = (event: PointerEvent): void => {
        if (!this._matchesGesture('pointer', event.pointerId)) return;
        this._cancelGesture();
        if (this._domCanvas?.hasPointerCapture?.(event.pointerId)) {
            this._domCanvas.releasePointerCapture(event.pointerId);
        }
    };

    private _beginGesture(source: GestureSource, pointerId: number, location: Readonly<Vec2>): void {
        if (this._gesture || !this._canBeginGesture() || !this._evaluator) return;
        const hit = this._screenPointToGridCell(location);
        if (!hit) return;
        const position = { row: hit.row, column: hit.column };
        const before = this._evaluator.state;
        const activeStart = before.activePath[0];
        const clickedActiveStart = before.activeColorId !== null
            && before.activePath.length === 1
            && activeStart.row === position.row
            && activeStart.column === position.column;
        const transition = clickedActiveStart
            ? this._evaluator.endGesture(this._now())
            : before.activeColorId !== null
                ? this._evaluator.extendGesture(position, this._now())
                : this._evaluator.beginGesture(position, this._now());
        this._playEndpointPress(position);
        this._gesture = {
            source,
            pointerId,
            previousPoint: hit.gridPoint,
            lastCell: position,
            moved: false,
        };
        this._handleTransition(transition, position, before);
        if (this._evaluator.state.activeColorId !== null) {
            this._visualTailCurrent.set(hit.cellCenter);
            this._visualTailTarget.set(hit.localPosition);
            this._visualTailVisible = true;
            this._pathRenderDirty = true;
        }
    }

    private _advanceGesture(location: Readonly<Vec2>): void {
        const gesture = this._gesture;
        if (!gesture || !this._evaluator) return;
        const local = this._uiLocationToBoardLocal(location);
        if (!local) return;
        const point = colorConnectLocalToGridPoint(local.x, local.y, this._gridGeometry());
        if (!point) return;
        if (this._evaluator.state.activeColorId === null) {
            // A completed connection or endpoint cancellation ends the path
            // immediately, while the physical press remains held until END.
            // Preserve the pointer sample without manufacturing violations.
            gesture.previousPoint = point;
            if (this._isGridPointInside(point)) gesture.lastCell = this._cellAt(point);
            return;
        }
        const cells = this._rasterizeOrthogonalCells(gesture.previousPoint, point);
        gesture.previousPoint = point;
        if (cells.length > 0) gesture.moved = true;
        let stateChanged = false;
        for (const position of cells) {
            gesture.lastCell = position;
            const before = this._evaluator.state;
            const transition = this._evaluator.extendGesture(position, this._now());
            stateChanged = transition.changed || stateChanged;
            this._handleTransition(transition, position, before, false);
            if (transition.violation || transition.completedColorId || this._evaluator.state.success) break;
        }
        if (this._evaluator.state.activeColorId !== null) {
            this._setVisualTailTarget(local);
        } else {
            this._resetVisualTail();
        }
        if (stateChanged) this._renderPaths();
    }

    private _finishGesture(location: Readonly<Vec2>): void {
        const gesture = this._gesture;
        if (!gesture || !this._evaluator) return;
        this._advanceGesture(location);
        this._gesture = null;
        this._resetVisualTail();
        // A click starts or advances a logical path without releasing it.
        // A real drag, a completed path, cancellation, or invalid start still
        // closes the evaluator gesture exactly as before.
        if (gesture.moved || this._evaluator.state.activeColorId === null) {
            const before = this._evaluator.state;
            const transition = this._evaluator.endGesture(this._now());
            this._handleTransition(transition, gesture.lastCell, before);
        } else {
            this._renderPaths();
        }
    }

    private _cancelGesture(): void {
        const gesture = this._gesture;
        if (!gesture || !this._evaluator) return;
        const before = this._evaluator.state;
        const transition = this._evaluator.endGesture(this._now());
        this._gesture = null;
        this._resetVisualTail();
        this._handleTransition(transition, gesture.lastCell, before);
    }

    private _handleTransition(
        transition: ColorConnectTransitionResult,
        feedbackCell: GridPosition,
        before: ColorConnectState,
        renderImmediately: boolean = true,
    ): void {
        if (transition.changed && renderImmediately) this._renderPaths();
        if (before.activeColorId !== transition.nextState.activeColorId) {
            this._paintAllEndpoints();
        }
        if (transition.violation && this._isVisualViolation(transition.violation)) {
            this._playInvalidFeedback(feedbackCell);
        }
        if (transition.cancelledColorId) {
            const oldPath = before.paths[transition.cancelledColorId]?.cells ?? [];
            this._playCancelAnimation(oldPath, transition.cancelledColorId);
            this._paintAllEndpoints();
        }
        if (transition.completedColorId) {
            this._playCompletedFeedback(transition.completedColorId);
            this._paintAllEndpoints();
        }
        if (!before.success && transition.nextState.success) this._playSuccessFeedback();
    }

    private _isVisualViolation(violation: ColorConnectViolation): boolean {
        return violation !== 'input_without_active_path'
            && violation !== 'game_already_complete';
    }

    /** The single Cocos UI-space -> board-local -> row/column hit-test chain. */
    private _screenPointToGridCell(location: Readonly<Vec2>): GridHitResult | null {
        const local = this._uiLocationToBoardLocal(location);
        if (!local) return null;
        const hit = hitColorConnectGrid(local.x, local.y, this._gridGeometry());
        return hit ? this._toGridHitResult(hit) : null;
    }

    private _toGridHitResult(hit: Readonly<ColorConnectGridHit>): GridHitResult {
        return {
            row: hit.row,
            column: hit.column,
            localPosition: new Vec3(hit.localX, hit.localY, 0),
            cellCenter: new Vec3(hit.centerX, hit.centerY, 0),
            gridPoint: hit.gridPoint,
        };
    }

    private _uiLocationToBoardLocal(location: Readonly<Vec2>): Vec3 | null {
        if (!this._boardRoot?.isValid) return null;
        const boardTransform = this._boardRoot.getComponent(UITransform);
        const canvasTransform = this._canvasTransform?.isValid
            ? this._canvasTransform
            : this._findCanvasTransform();
        if (!boardTransform || !canvasTransform) return null;
        this._canvasTransform = canvasTransform;

        const size = canvasTransform.contentSize;
        const anchor = canvasTransform.anchorPoint;
        this._canvasLocalScratch.set(
            location.x - size.width * anchor.x,
            location.y - size.height * anchor.y,
            0,
        );
        canvasTransform.convertToWorldSpaceAR(this._canvasLocalScratch, this._worldScratch);
        return boardTransform.convertToNodeSpaceAR(this._worldScratch, this._boardLocalScratch);
    }

    private _findCanvasTransform(): UITransform | null {
        let current: Node | null = this.node;
        while (current) {
            if (current.getComponent(Canvas)) return current.getComponent(UITransform);
            current = current.parent;
        }
        return null;
    }

    private _gridGeometry(): Readonly<ColorConnectGridGeometry> {
        return this._geometry;
    }

    private _isGridPointInside(point: ContinuousGridPoint): boolean {
        return !!this._level && isColorConnectGridPointInside(point, this._gridGeometry());
    }

    private _cellAt(point: ContinuousGridPoint): GridPosition {
        return {
            row: Math.floor(point.y),
            column: Math.floor(point.x),
        };
    }

    /**
     * Amanatides/Woo traversal over the pointer segment. At a perfect corner,
     * both crossed axes are emitted in a deterministic dominant-axis order so
     * every returned pair remains four-neighbour adjacent.
     */
    private _rasterizeOrthogonalCells(
        from: ContinuousGridPoint,
        to: ContinuousGridPoint,
    ): GridPosition[] {
        let column = Math.floor(from.x);
        let row = Math.floor(from.y);
        const targetColumn = Math.floor(to.x);
        const targetRow = Math.floor(to.y);
        if (column === targetColumn && row === targetRow) return [];

        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const stepColumn = Math.sign(dx);
        const stepRow = Math.sign(dy);
        const deltaColumn = stepColumn === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(dx);
        const deltaRow = stepRow === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(dy);
        let maxColumn = stepColumn > 0
            ? (column + 1 - from.x) / Math.abs(dx)
            : stepColumn < 0 ? (from.x - column) / Math.abs(dx) : Number.POSITIVE_INFINITY;
        let maxRow = stepRow > 0
            ? (row + 1 - from.y) / Math.abs(dy)
            : stepRow < 0 ? (from.y - row) / Math.abs(dy) : Number.POSITIVE_INFINITY;
        const positions: GridPosition[] = [];

        const enterColumn = () => {
            column += stepColumn;
            maxColumn += deltaColumn;
            positions.push({ row, column });
        };
        const enterRow = () => {
            row += stepRow;
            maxRow += deltaRow;
            positions.push({ row, column });
        };

        while ((column !== targetColumn || row !== targetRow) && positions.length < MAX_RASTER_STEPS) {
            if (maxColumn < maxRow) {
                enterColumn();
            } else if (maxRow < maxColumn) {
                enterRow();
            } else if (Math.abs(dx) >= Math.abs(dy)) {
                if (column !== targetColumn) enterColumn();
                if (row !== targetRow) enterRow();
            } else {
                if (row !== targetRow) enterRow();
                if (column !== targetColumn) enterColumn();
            }
        }
        return positions;
    }

    private _playInvalidFeedback(position: GridPosition): void {
        if (!this._feedbackLayer || !this._level) return;
        const token = this._actionToken;
        const flash = new Node('InvalidCellFlash');
        flash.layer = this._feedbackLayer.layer;
        flash.parent = this._feedbackLayer;
        flash.setPosition(this._cellPosition(position));
        flash.addComponent(UITransform).setContentSize(this._layout.cellSize, this._layout.cellSize);
        const opacity = flash.addComponent(UIOpacity);
        opacity.opacity = 255;
        const graphics = flash.addComponent(Graphics);
        const half = this._layout.cellSize / 2;
        graphics.fillColor = new Color(COLORS.invalid.r, COLORS.invalid.g, COLORS.invalid.b, 118);
        graphics.roundRect(-half, -half, this._layout.cellSize, this._layout.cellSize, this._layout.cellSize * 0.1);
        graphics.fill();
        graphics.strokeColor = COLORS.invalid;
        graphics.lineWidth = Math.max(3, this._layout.cellSize * 0.06);
        graphics.roundRect(-half + 2, -half + 2, this._layout.cellSize - 4, this._layout.cellSize - 4, this._layout.cellSize * 0.1);
        graphics.stroke();
        tween(opacity)
            .delay(0.08)
            .to(0.2, { opacity: 0 }, { easing: 'quadOut' })
            .call(() => {
                if (token === this._actionToken && flash.isValid) flash.destroy();
            })
            .start();

        if (this._pathLayer) {
            Tween.stopAllByTarget(this._pathLayer);
            this._pathLayer.setPosition(0, 0, 0);
            tween(this._pathLayer)
                .to(0.035, { position: new Vec3(-4, 0, 0) })
                .to(0.05, { position: new Vec3(4, 0, 0) })
                .to(0.035, { position: Vec3.ZERO })
                .start();
        }
    }

    private _playCancelAnimation(cells: readonly GridPosition[], colorId: string): void {
        if (!this._feedbackLayer || cells.length < 2) return;
        const token = this._actionToken;
        this._animationLocked = true;
        const ghost = new Node('CancelledPathGhost');
        ghost.layer = this._feedbackLayer.layer;
        ghost.parent = this._feedbackLayer;
        ghost.addComponent(UITransform).setContentSize(this._layout.width, this._layout.height);
        const opacity = ghost.addComponent(UIOpacity);
        const graphics = ghost.addComponent(Graphics);
        graphics.lineCap = Graphics.LineCap.ROUND;
        graphics.lineJoin = Graphics.LineJoin.ROUND;
        this._strokePath(
            graphics,
            cells,
            this._endpointColors.get(colorId) ?? COLORS.white,
            this._layout.cellSize * 0.5,
        );
        tween(opacity)
            .to(0.2, { opacity: 0 }, { easing: 'quadIn' })
            .call(() => {
                if (ghost.isValid) ghost.destroy();
                if (token === this._actionToken) this._animationLocked = false;
            })
            .start();
    }

    private _playCompletedFeedback(colorId: string): void {
        if (!this._level) return;
        const pair = this._level.pairByColorId[colorId];
        if (!pair) return;
        for (const position of [pair.start, pair.end]) {
            const endpoint = this._endpointNodes.get(colorConnectPositionKey(position));
            if (!endpoint) continue;
            Tween.stopAllByTarget(endpoint);
            endpoint.setScale(Vec3.ONE);
            tween(endpoint)
                .to(0.1, { scale: new Vec3(1.16, 1.16, 1) }, { easing: 'backOut' })
                .to(0.16, { scale: Vec3.ONE }, { easing: 'sineInOut' })
                .start();
        }
    }

    private _playEndpointPress(position: GridPosition): void {
        if (!this._level?.endpointColorByKey[colorConnectPositionKey(position)]) return;
        const endpoint = this._endpointNodes.get(colorConnectPositionKey(position));
        if (!endpoint) return;
        Tween.stopAllByTarget(endpoint);
        endpoint.setScale(Vec3.ONE);
        tween(endpoint)
            .to(0.07, { scale: new Vec3(1.08, 1.08, 1) }, { easing: 'sineOut' })
            .to(0.1, { scale: Vec3.ONE }, { easing: 'sineInOut' })
            .start();
    }

    private _playSuccessFeedback(): void {
        if (!this._feedbackLayer) return;
        const token = this._actionToken;
        this._animationLocked = true;
        const glow = new Node('ColorConnectSuccessGlow');
        glow.layer = this._feedbackLayer.layer;
        glow.parent = this._feedbackLayer;
        glow.addComponent(UITransform).setContentSize(this._layout.width + 18, this._layout.height + 18);
        const opacity = glow.addComponent(UIOpacity);
        opacity.opacity = 0;
        const graphics = glow.addComponent(Graphics);
        graphics.strokeColor = COLORS.success;
        graphics.lineWidth = 7;
        graphics.roundRect(
            -this._layout.width / 2 - 5,
            -this._layout.height / 2 - 5,
            this._layout.width + 10,
            this._layout.height + 10,
            16,
        );
        graphics.stroke();
        tween(opacity)
            .to(0.16, { opacity: 255 }, { easing: 'quadOut' })
            .delay(0.22)
            .to(0.28, { opacity: 0 }, { easing: 'quadIn' })
            .call(() => {
                if (glow.isValid) glow.destroy();
                if (token === this._actionToken) this._animationLocked = false;
            })
            .start();
        for (const pair of this._level?.colorPairs ?? []) this._playCompletedFeedback(pair.colorId);
    }

    private _requestExit(): void {
        if (this._exiting) return;
        this._exiting = true;
        if (this._evaluator && (this._gesture || this._evaluator.state.activeColorId !== null)) {
            this._evaluator.endGesture(this._now());
        }
        this._gesture = null;
        this._resetVisualTail();
        this._renderPaths();
        const callback = this.onRequestExit;
        // Leave the current Button dispatch before replacing its entire view.
        // This avoids destroying the event processor while it is still walking
        // the click listener list.
        this.scheduleOnce(() => callback?.(), 0);
    }

    private _canBeginGesture(): boolean {
        return !this._exiting
            && !this._animationLocked
            && !!this._evaluator
            && !this._evaluator.terminal
            && !this._evaluator.state.success;
    }

    private _matchesGesture(source: GestureSource, pointerId: number): boolean {
        return this._gesture?.source === source && this._gesture.pointerId === pointerId;
    }

    private _touchId(event: EventTouch): number {
        const maybeEvent = event as unknown as { getID?: () => number };
        return maybeEvent.getID ? maybeEvent.getID() : 0;
    }

    private _isReady(): boolean {
        return this._sceneBuilt
            && !!this._level
            && !!this._evaluator
            && !!this._boardRoot
            && !!this._pathGraphics
            && this._endpointNodes.size === this._level.colorPairs.length * 2;
    }

    private _isBusy(): boolean {
        return this._animationLocked || this._gesture !== null;
    }

    private _colorFromHex(value: string): Color {
        const hex = value.replace('#', '');
        const parsed = Number.parseInt(hex, 16);
        return new Color((parsed >> 16) & 0xff, (parsed >> 8) & 0xff, parsed & 0xff, 255);
    }

    private _stopAnimations(): void {
        const stopTree = (node: Node | null) => {
            if (!node || !node.isValid) return;
            Tween.stopAllByTarget(node);
            const opacity = node.getComponent(UIOpacity);
            if (opacity) Tween.stopAllByTarget(opacity);
            for (const child of node.children) stopTree(child);
        };
        stopTree(this._boardRoot);
    }

    private _bindInputs(): void {
        this._bindBoardInput();
        this._bindDomPointerInput();
        if (!this._globalInputBound) {
            input.on(Input.EventType.MOUSE_DOWN, this._onMouseDown, this);
            input.on(Input.EventType.MOUSE_MOVE, this._onMouseMove, this);
            input.on(Input.EventType.MOUSE_UP, this._onMouseUp, this);
            this._globalInputBound = true;
        }
    }

    private _unbindInputs(): void {
        this._unbindBoardInput();
        this._unbindDomPointerInput();
        if (this._globalInputBound) {
            this._globalInputBound = false;
            input.off(Input.EventType.MOUSE_DOWN, this._onMouseDown, this);
            input.off(Input.EventType.MOUSE_MOVE, this._onMouseMove, this);
            input.off(Input.EventType.MOUSE_UP, this._onMouseUp, this);
        }
    }

    private _bindBoardInput(): void {
        if (this._boardInputBound || !this._interactionSurface?.isValid) return;
        this._interactionSurface.on(Node.EventType.TOUCH_START, this._onTouchStart, this);
        this._interactionSurface.on(Node.EventType.TOUCH_MOVE, this._onTouchMove, this);
        this._interactionSurface.on(Node.EventType.TOUCH_END, this._onTouchEnd, this);
        this._interactionSurface.on(Node.EventType.TOUCH_CANCEL, this._onTouchCancel, this);
        this._boardInputBound = true;
    }

    private _unbindBoardInput(): void {
        if (!this._boardInputBound) return;
        this._boardInputBound = false;
        if (this._interactionSurface?.isValid) this._interactionSurface.targetOff(this);
    }

    private _bindDomPointerInput(): void {
        if (this._domCanvas || typeof document === 'undefined') return;
        const canvas = document.querySelector('canvas');
        if (!(canvas instanceof HTMLCanvasElement)) return;
        this._domCanvas = canvas;
        this._previousCanvasTouchAction = canvas.style.touchAction;
        canvas.style.touchAction = 'none';
        canvas.addEventListener('pointerdown', this._onDomPointerDown);
        canvas.addEventListener('pointermove', this._onDomPointerMove);
        canvas.addEventListener('pointerup', this._onDomPointerUp);
        canvas.addEventListener('pointercancel', this._onDomPointerCancel);
    }

    private _unbindDomPointerInput(): void {
        if (!this._domCanvas) return;
        this._domCanvas.removeEventListener('pointerdown', this._onDomPointerDown);
        this._domCanvas.removeEventListener('pointermove', this._onDomPointerMove);
        this._domCanvas.removeEventListener('pointerup', this._onDomPointerUp);
        this._domCanvas.removeEventListener('pointercancel', this._onDomPointerCancel);
        this._domCanvas.style.touchAction = this._previousCanvasTouchAction;
        this._previousCanvasTouchAction = '';
        this._domCanvas = null;
    }

    private _domPointerLocation(event: PointerEvent): Vec2 | null {
        const canvas = this._domCanvas;
        if (!canvas) return null;
        const bounds = canvas.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return null;
        // Convert CSS client pixels to the canvas' real backing pixels. This
        // deliberately derives the effective scale from the canvas instead of
        // window.devicePixelRatio because Cocos may cap a high-DPI framebuffer.
        this._uiLocationScratch.set(
            (event.clientX - bounds.left) * (canvas.width / bounds.width),
            (bounds.bottom - event.clientY) * (canvas.height / bounds.height),
        );
        const viewport = view.getViewportRect();
        this._uiLocationScratch.x = (this._uiLocationScratch.x - viewport.x) / view.getScaleX();
        this._uiLocationScratch.y = (this._uiLocationScratch.y - viewport.y) / view.getScaleY();
        return this._uiLocationScratch;
    }

    private _clearFeedback(): void {
        if (!this._feedbackLayer) return;
        for (const child of [...this._feedbackLayer.children]) {
            child.removeFromParent();
            if (child.isValid) child.destroy();
        }
        if (this._pathLayer) this._pathLayer.setPosition(Vec3.ZERO);
    }

    private _clearEndpointNodes(): void {
        this._endpointNodes.clear();
        this._endpointColors.clear();
        if (!this._endpointLayer) return;
        for (const child of [...this._endpointLayer.children]) {
            child.removeFromParent();
            if (child.isValid) child.destroy();
        }
    }

    private _registerInspector(): void {
        if (this._inspectorRegistered) return;
        GameInspector.instance.register('colorConnect', this._inspectorProvider);
        this._inspectorRegistered = true;
    }

    private _unregisterInspector(): void {
        if (!this._inspectorRegistered) return;
        this._inspectorRegistered = false;
        GameInspector.instance.unregister('colorConnect');
    }

    private _setVisualTailTarget(local: Readonly<Vec3>): void {
        const path = this._evaluator?.state.activePath;
        const last = path?.[path.length - 1];
        if (!last) return;
        const center = this._cellPosition(last);
        const halfPitch = this._layout.pitch * 0.5;
        this._visualTailTarget.set(
            center.x + Math.max(-halfPitch, Math.min(halfPitch, local.x - center.x)),
            center.y + Math.max(-halfPitch, Math.min(halfPitch, local.y - center.y)),
            0,
        );
        if (!this._visualTailVisible) this._visualTailCurrent.set(center);
        this._visualTailVisible = true;
        this._pathRenderDirty = true;
    }

    private _updateVisualTail(deltaTime: number): void {
        if (!this._visualTailVisible || !this._evaluator?.state.activeColorId) return;
        const dx = this._visualTailTarget.x - this._visualTailCurrent.x;
        const dy = this._visualTailTarget.y - this._visualTailCurrent.y;
        if (Math.abs(dx) < 0.08 && Math.abs(dy) < 0.08) {
            this._visualTailCurrent.set(this._visualTailTarget);
        } else {
            const alpha = 1 - Math.exp(-32 * Math.min(Math.max(deltaTime, 0), 0.05));
            this._visualTailCurrent.x += dx * alpha;
            this._visualTailCurrent.y += dy * alpha;
            this._pathRenderDirty = true;
        }
        if (this._pathRenderDirty) this._renderPaths();
    }

    private _resetVisualTail(): void {
        this._visualTailVisible = false;
        this._pathRenderDirty = false;
        this._visualTailCurrent.set(Vec3.ZERO);
        this._visualTailTarget.set(Vec3.ZERO);
    }

    private _now(): number {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }
}
