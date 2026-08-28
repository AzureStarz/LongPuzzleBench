import {
    _decorator,
    Button,
    Color,
    Component,
    EventTouch,
    Graphics,
    Label,
    Node,
    Tween,
    UITransform,
    Vec3,
    tween,
} from 'cc';
import {
    getTruckEscape2Levels,
} from '../data/TruckEscape2Data';
import type {
    TruckEscape2Difficulty,
    TruckEscape2LevelData,
    TruckEscape2VehicleColor,
    TruckEscape2VehicleSpec,
} from '../data/TruckEscape2Data';
import { TruckEscape2BoardModel } from './TruckEscape2BoardModel';
import { GameInspector } from './GameInspector';
import type { InspectorProvider } from './GameInspector';
import { TruckEscape2AbilityTracker } from '../analytics/TruckEscape2AbilityTracker';
import type {
    TruckEscape2AttemptStartReason,
    TruckEscape2InvalidMoveReason,
} from '../analytics/TruckEscape2AbilityTypes';

const { ccclass } = _decorator;

const VIEW_WIDTH = 540;
const VIEW_HEIGHT = 960;
const BOARD_WIDTH = 450;
const MAX_BOARD_HEIGHT = 540;
const BOARD_Y = 18;

const COLORS = {
    background: new Color(22, 42, 38, 255),
    backgroundDeep: new Color(13, 28, 26, 255),
    backgroundGlow: new Color(52, 83, 70, 255),
    board: new Color(34, 39, 43, 255),
    boardInset: new Color(43, 49, 54, 255),
    boardEdge: new Color(104, 115, 119, 255),
    boardHighlight: new Color(165, 174, 173, 255),
    ink: new Color(13, 18, 22, 255),
    glass: new Color(24, 42, 53, 255),
    glassLight: new Color(83, 126, 148, 255),
    coral: new Color(242, 99, 112, 255),
    coralDark: new Color(190, 56, 72, 255),
    gold: new Color(255, 190, 66, 255),
    white: new Color(250, 250, 247, 255),
    cream: new Color(244, 241, 229, 255),
};

interface VehiclePalette {
    body: Color;
    bodyLight: Color;
    bodyDark: Color;
    accent: Color;
}

const VEHICLE_PALETTES: Record<TruckEscape2VehicleColor, VehiclePalette> = {
    sand: {
        body: new Color(211, 197, 163, 255),
        bodyLight: new Color(242, 228, 192, 255),
        bodyDark: new Color(145, 124, 91, 255),
        accent: new Color(255, 239, 197, 255),
    },
    cream: {
        body: new Color(239, 190, 126, 255),
        bodyLight: new Color(255, 222, 172, 255),
        bodyDark: new Color(185, 129, 80, 255),
        accent: new Color(255, 238, 199, 255),
    },
    red: {
        body: new Color(239, 61, 76, 255),
        bodyLight: new Color(255, 96, 105, 255),
        bodyDark: new Color(179, 31, 52, 255),
        accent: new Color(255, 137, 129, 255),
    },
    blue: {
        body: new Color(103, 181, 221, 255),
        bodyLight: new Color(170, 218, 241, 255),
        bodyDark: new Color(55, 125, 168, 255),
        accent: new Color(207, 238, 250, 255),
    },
    white: {
        body: new Color(221, 226, 229, 255),
        bodyLight: new Color(249, 250, 249, 255),
        bodyDark: new Color(153, 164, 172, 255),
        accent: new Color(255, 255, 255, 255),
    },
    purple: {
        body: new Color(162, 119, 205, 255),
        bodyLight: new Color(205, 173, 231, 255),
        bodyDark: new Color(111, 75, 153, 255),
        accent: new Color(226, 204, 243, 255),
    },
};

interface TruckEscape2VehicleRuntime {
    spec: TruckEscape2VehicleSpec;
    node: Node;
    baseScaleX: number;
}

interface DragState {
    vehicle: TruckEscape2VehicleRuntime;
    startAxis: number;
    startedAtMs: number;
    startRow: number;
    startCol: number;
    minDelta: number;
    maxDelta: number;
    rawDelta: number;
    visualDelta: number;
    inputClamped: boolean;
}

interface MoveHistory {
    vehicleId: string;
    fromRow: number;
    fromCol: number;
    toRow: number;
    toCol: number;
}

/**
 * 《卡车出库 2》独立控制器。
 *
 * - 关卡支持截图所需的 5–7 列、5–8 行可变棋盘；
 * - 车辆拖拽时只投影到自身长轴；
 * - 拖拽范围由纯规则模型逐格扫描，实时阻止越界和穿车；
 * - 松手吸附到最近格，支持一次连续移动任意合法格数；
 * - 红车到达右侧出口后自动驶离并完成关卡。
 */
@ccclass('TruckEscape2Controller')
export class TruckEscape2Controller extends Component {
    public onRequestExit: (() => void) | null = null;
    private _directLaunchMode = false;

    private _difficulty: TruckEscape2Difficulty = 'easy';
    private _levels: TruckEscape2LevelData[] = [];
    private _levelIndex = 0;
    private _initialLevelIndex = 0;
    private _level: TruckEscape2LevelData | null = null;
    private _model: TruckEscape2BoardModel | null = null;
    private _boardRoot: Node | null = null;
    private _boardDecorLayer: Node | null = null;
    private _blockerLayer: Node | null = null;
    private _vehicleLayer: Node | null = null;
    private _completeOverlay: Node | null = null;
    private _modeLabel: Label | null = null;
    private _levelLabel: Label | null = null;
    private _completePrimaryLabel: Label | null = null;
    private _vehicles = new Map<string, TruckEscape2VehicleRuntime>();
    private _drag: DragState | null = null;
    private _history: MoveHistory[] = [];
    private _hintTokens = 1;
    private _cellSize = 90;
    private _boardHeight = MAX_BOARD_HEIGHT;
    private _inputLocked = false;
    private _started = false;
    private _complete = false;
    private readonly _abilityTracker = TruckEscape2AbilityTracker.instance;
    private _abilityAttemptId: string | null = null;

    private readonly _inspectorProvider: InspectorProvider = {
        snapshot: () => ({
            ready: this._started && !!this._level && !!this._model && this._vehicles.size > 0,
            difficulty: this._difficulty,
            level: (this._level?.levelNumber ?? 0),
            rows: this._level?.rows ?? 6,
            cols: this._level?.cols ?? 5,
            exitRow: this._level?.exitRow ?? 2,
            complete: this._complete,
            hintTokens: this._hintTokens,
            historyLength: this._history.length,
            ability: this._abilityTracker.getInspectorSnapshot(),
            controls: { exit: true, restart: true, bottom: false },
            levelCount: this._levels.length,
            blockers: this._level?.blockers?.map((blocker) => ({ ...blocker })) ?? [],
            vehicles: this._level?.vehicles.map((spec) => {
                const state = this._model?.getState(spec.id);
                return {
                    id: spec.id,
                    row: state?.row ?? spec.row,
                    col: state?.col ?? spec.col,
                    length: spec.length,
                    orientation: spec.orientation,
                    target: !!spec.target,
                };
            }) ?? [],
        }),
        outcomeHash: () => `${this._difficulty}:${this._levelIndex}:${this._model?.serialize() ?? '-'}:${this._complete}`,
    };

    onLoad() {
        GameInspector.instance.register('truck2', this._inspectorProvider);
    }

    start() {
        this._started = true;
        this._levels = getTruckEscape2Levels(this._difficulty);
        this._buildScene();
        this._loadLevel(this._initialLevelIndex);
    }

    onDestroy() {
        // Header exits normally finalize first; this is an idempotent fallback
        // for view replacement or component destruction from another path.
        if (this._abilityAttemptId) {
            this._safeTrack(() => this._abilityTracker.interruptActiveAttempt(this._abilityAttemptId));
        }
        this._abilityAttemptId = null;
        GameInspector.instance.unregister('truck2');
        for (const vehicle of this._vehicles.values()) Tween.stopAllByTarget(vehicle.node);
    }

    setDifficulty(difficulty: TruckEscape2Difficulty) {
        if (this._started && this._abilityAttemptId) {
            this._safeTrack(() => this._abilityTracker.interruptActiveAttempt(this._abilityAttemptId));
            this._abilityAttemptId = null;
        }
        this._difficulty = difficulty;
        this._levels = getTruckEscape2Levels(difficulty);
        if (this._started) this._loadLevel(0, 'difficulty-change');
    }

    /** Select the first benchmark level by its public, one-based id. */
    public setInitialLevel(levelId: number) {
        this._initialLevelIndex = Math.max(0, Math.min(Math.trunc(levelId) - 1, this._levels.length - 1));
        if (this._started) this._loadLevel(this._initialLevelIndex, 'restored');
    }

    /** Hide Hub navigation and level advancement in a query-launched attempt. */
    public setDirectLaunchMode(enabled: boolean) {
        this._directLaunchMode = enabled;
    }

    /** Reset without routing through the Hub or changing the selected level. */
    public resetCurrentLevel() {
        this._restartLevel();
    }

    private _buildScene() {
        const root = this.node;
        const ui = root.getComponent(UITransform) ?? root.addComponent(UITransform);
        ui.setContentSize(VIEW_WIDTH, VIEW_HEIGHT);
        ui.setAnchorPoint(0.5, 0.5);

        this._drawBackground(root);
        this._buildHeader(root);
        this._buildBoard(root);
        this._buildCompleteOverlay(root);
    }

    private _drawBackground(parent: Node) {
        const node = new Node('TruckEscape2Background');
        node.layer = parent.layer;
        node.parent = parent;
        node.addComponent(UITransform).setContentSize(VIEW_WIDTH, VIEW_HEIGHT);
        const gfx = node.addComponent(Graphics);
        gfx.fillColor = COLORS.background;
        gfx.rect(-VIEW_WIDTH / 2, -VIEW_HEIGHT / 2, VIEW_WIDTH, VIEW_HEIGHT);
        gfx.fill();

        // 通过大面积半透明色块模拟柔和渐变与暗角，保持纯矢量资源的清晰度。
        gfx.fillColor = new Color(71, 112, 92, 32);
        gfx.circle(-205, 315, 250);
        gfx.fill();
        gfx.fillColor = new Color(4, 14, 14, 70);
        gfx.circle(250, -440, 310);
        gfx.fill();
        gfx.fillColor = new Color(5, 17, 16, 50);
        gfx.rect(-VIEW_WIDTH / 2, -VIEW_HEIGHT / 2, VIEW_WIDTH, 178);
        gfx.fill();

        // 极淡的车库导向线只作为背景纹理，不形成棋盘下方的可交互组件。
        gfx.lineWidth = 2;
        gfx.strokeColor = new Color(129, 169, 145, 22);
        for (const x of [-190, -95, 0, 95, 190]) {
            gfx.moveTo(x, -470);
            gfx.lineTo(x + 42, -300);
            gfx.stroke();
        }
    }

    private _buildHeader(parent: Node) {
        if (!this._directLaunchMode) {
            const back = this._makeHeaderButton(parent, 'TruckEscape2Back', '退出', -208, 391);
            this._drawBackChevron(back, COLORS.coral);
            back.on(Button.EventType.CLICK, () => {
                if (this._inputLocked && !this._complete) return;
                this._requestExit();
            }, this);
        }

        const restart = this._makeHeaderButton(parent, 'TruckEscape2Restart', '重来', 208, 391);
        this._drawRestartIcon(restart, COLORS.coral);
        restart.on(Button.EventType.CLICK, () => this._restartLevel(), this);

        const badge = new Node('TruckEscape2ModeBadge');
        badge.layer = parent.layer;
        badge.parent = parent;
        badge.setPosition(0, 412, 0);
        badge.addComponent(UITransform).setContentSize(128, 26);
        const badgeGfx = badge.addComponent(Graphics);
        badgeGfx.fillColor = new Color(8, 19, 18, 132);
        badgeGfx.roundRect(-64, -13, 128, 26, 13);
        badgeGfx.fill();
        badgeGfx.lineWidth = 1.5;
        badgeGfx.strokeColor = new Color(155, 190, 170, 60);
        badgeGfx.roundRect(-64, -13, 128, 26, 13);
        badgeGfx.stroke();
        this._modeLabel = this._makeLabel(badge, 'Mode', 'EASY', 15, new Color(223, 235, 225, 255), true);

        this._levelLabel = this._makeLabel(parent, 'TruckEscape2LevelTitle', 'Level 1', 34, COLORS.white, true);
        this._levelLabel.node.setPosition(0, 371, 0);
    }

    private _buildBoard(parent: Node) {
        const board = new Node('TruckEscape2Board');
        board.layer = parent.layer;
        board.parent = parent;
        board.setPosition(0, BOARD_Y, 0);
        board.addComponent(UITransform).setContentSize(VIEW_WIDTH, MAX_BOARD_HEIGHT + 22);
        this._boardRoot = board;

        const decorLayer = new Node('TruckEscape2BoardDecor');
        decorLayer.layer = board.layer;
        decorLayer.parent = board;
        decorLayer.addComponent(UITransform).setContentSize(VIEW_WIDTH, MAX_BOARD_HEIGHT + 22);
        this._boardDecorLayer = decorLayer;

        const blockerLayer = new Node('TruckEscape2BlockerLayer');
        blockerLayer.layer = board.layer;
        blockerLayer.parent = board;
        blockerLayer.addComponent(UITransform).setContentSize(BOARD_WIDTH, MAX_BOARD_HEIGHT);
        this._blockerLayer = blockerLayer;

        const vehicleLayer = new Node('TruckEscape2VehicleLayer');
        vehicleLayer.layer = board.layer;
        vehicleLayer.parent = board;
        vehicleLayer.addComponent(UITransform).setContentSize(BOARD_WIDTH, MAX_BOARD_HEIGHT);
        this._vehicleLayer = vehicleLayer;

    }

    private _renderBoard(level: TruckEscape2LevelData) {
        if (!this._boardDecorLayer || !this._blockerLayer) return;
        this._clearChildren(this._boardDecorLayer);
        this._clearChildren(this._blockerLayer);
        this._cellSize = BOARD_WIDTH / level.cols;
        this._boardHeight = this._cellSize * level.rows;

        const shadow = new Node('BoardShadow');
        shadow.layer = this._boardDecorLayer.layer;
        shadow.parent = this._boardDecorLayer;
        shadow.setPosition(0, -10, 0);
        shadow.addComponent(UITransform).setContentSize(BOARD_WIDTH + 34, this._boardHeight + 34);
        const shadowGfx = shadow.addComponent(Graphics);
        shadowGfx.fillColor = new Color(3, 9, 9, 128);
        shadowGfx.roundRect(-BOARD_WIDTH / 2 - 17, -this._boardHeight / 2 - 17, BOARD_WIDTH + 34, this._boardHeight + 34, 25);
        shadowGfx.fill();

        const surface = new Node('BoardSurface');
        surface.layer = this._boardDecorLayer.layer;
        surface.parent = this._boardDecorLayer;
        surface.addComponent(UITransform).setContentSize(BOARD_WIDTH + 24, this._boardHeight + 24);
        const gfx = surface.addComponent(Graphics);
        gfx.fillColor = new Color(73, 82, 84, 255);
        gfx.roundRect(-BOARD_WIDTH / 2 - 11, -this._boardHeight / 2 - 11, BOARD_WIDTH + 22, this._boardHeight + 22, 21);
        gfx.fill();
        gfx.lineWidth = 3;
        gfx.strokeColor = COLORS.boardHighlight;
        gfx.roundRect(-BOARD_WIDTH / 2 - 10, -this._boardHeight / 2 - 10, BOARD_WIDTH + 20, this._boardHeight + 20, 20);
        gfx.stroke();
        gfx.fillColor = COLORS.board;
        gfx.roundRect(-BOARD_WIDTH / 2 - 3, -this._boardHeight / 2 - 3, BOARD_WIDTH + 6, this._boardHeight + 6, 14);
        gfx.fill();
        gfx.lineWidth = 2;
        gfx.strokeColor = new Color(10, 15, 18, 190);
        gfx.roundRect(-BOARD_WIDTH / 2 - 3, -this._boardHeight / 2 - 3, BOARD_WIDTH + 6, this._boardHeight + 6, 14);
        gfx.stroke();

        // 柏油颗粒与泊车点阵，增强材质但不显式画格线。
        for (let row = 0; row < level.rows; row++) {
            for (let col = 0; col < level.cols; col++) {
                const x = this._colCenter(col);
                const y = this._rowCenter(row);
                gfx.fillColor = new Color(117, 130, 135, (row + col) % 2 === 0 ? 18 : 11);
                gfx.circle(x, y, Math.max(1.2, this._cellSize * 0.018));
                gfx.fill();
            }
        }

        this._drawExit(this._boardDecorLayer, level.exitRow);
        for (const blocker of level.blockers ?? []) this._drawBush(blocker.row, blocker.col, blocker.id);
    }

    private _drawExit(parent: Node, exitRow: number) {
        const exit = new Node('TruckEscape2Exit');
        exit.layer = parent.layer;
        exit.parent = parent;
        const exitY = this._rowCenter(exitRow);
        exit.setPosition(BOARD_WIDTH / 2 + 30, exitY, 0);
        exit.addComponent(UITransform).setContentSize(70, this._cellSize + 12);
        const gfx = exit.addComponent(Graphics);
        gfx.fillColor = new Color(12, 20, 22, 210);
        gfx.roundRect(-39, -this._cellSize / 2 - 6, 78, this._cellSize + 12, 7);
        gfx.fill();
        gfx.fillColor = new Color(52, 61, 65, 255);
        gfx.roundRect(-33, -this._cellSize / 2, 66, this._cellSize, 4);
        gfx.fill();

        gfx.lineWidth = 2;
        gfx.strokeColor = new Color(242, 99, 112, 115);
        gfx.moveTo(-28, -this._cellSize / 2 + 5);
        gfx.lineTo(27, -this._cellSize / 2 + 5);
        gfx.moveTo(-28, this._cellSize / 2 - 5);
        gfx.lineTo(27, this._cellSize / 2 - 5);
        gfx.stroke();

        gfx.lineWidth = 5;
        gfx.strokeColor = new Color(210, 218, 216, 195);
        const gap = this._cellSize * 0.24;
        for (const y of [gap, 0, -gap]) {
            gfx.moveTo(-5, y + 7);
            gfx.lineTo(5, y);
            gfx.lineTo(-5, y - 7);
            gfx.stroke();
        }
    }

    private _buildCompleteOverlay(parent: Node) {
        const overlay = new Node('TruckEscape2CompleteOverlay');
        overlay.layer = parent.layer;
        overlay.parent = parent;
        overlay.addComponent(UITransform).setContentSize(VIEW_WIDTH, VIEW_HEIGHT);
        overlay.active = false;
        this._completeOverlay = overlay;

        const dim = overlay.addComponent(Graphics);
        dim.fillColor = new Color(4, 14, 14, 205);
        dim.rect(-VIEW_WIDTH / 2, -VIEW_HEIGHT / 2, VIEW_WIDTH, VIEW_HEIGHT);
        dim.fill();

        const card = new Node('CompleteCard');
        card.layer = overlay.layer;
        card.parent = overlay;
        card.setPosition(0, 8, 0);
        card.addComponent(UITransform).setContentSize(410, 292);
        const cardGfx = card.addComponent(Graphics);
        cardGfx.fillColor = new Color(0, 7, 8, 105);
        cardGfx.roundRect(-201, -154, 410, 292, 30);
        cardGfx.fill();
        cardGfx.fillColor = COLORS.cream;
        cardGfx.roundRect(-205, -146, 410, 292, 30);
        cardGfx.fill();
        cardGfx.fillColor = new Color(255, 255, 255, 130);
        cardGfx.roundRect(-193, -134, 386, 86, 22);
        cardGfx.fill();
        cardGfx.lineWidth = 3;
        cardGfx.strokeColor = new Color(255, 255, 255, 180);
        cardGfx.roundRect(-204, -145, 408, 290, 29);
        cardGfx.stroke();

        const medal = new Node('Medal');
        medal.layer = card.layer;
        medal.parent = card;
        medal.setPosition(0, 92, 0);
        medal.addComponent(UITransform).setContentSize(54, 54);
        const medalGfx = medal.addComponent(Graphics);
        medalGfx.fillColor = COLORS.gold;
        medalGfx.circle(0, 0, 25);
        medalGfx.fill();
        medalGfx.fillColor = new Color(255, 222, 117, 255);
        medalGfx.circle(-5, 6, 11);
        medalGfx.fill();
        medalGfx.lineWidth = 5;
        medalGfx.strokeColor = COLORS.white;
        medalGfx.moveTo(-11, 0);
        medalGfx.lineTo(-3, -8);
        medalGfx.lineTo(13, 9);
        medalGfx.stroke();

        const title = this._makeLabel(card, 'CompleteTitle', '通关成功', 32, new Color(34, 52, 45, 255), true);
        title.node.setPosition(0, 42, 0);
        const subtitle = this._makeLabel(card, 'CompleteSubtitle', '红色车辆已安全驶出', 19, new Color(100, 108, 102, 255), false);
        subtitle.node.setPosition(0, 2, 0);

        const primary = this._makeRoundedButton(
            card,
            'Primary',
            this._directLaunchMode ? '再玩一次' : '下一关',
            this._directLaunchMode ? 0 : -88,
            -72,
            150,
            55,
            COLORS.gold,
        );
        this._completePrimaryLabel = primary.getChildByName('Label')?.getComponent(Label) ?? null;
        primary.on(Button.EventType.CLICK, () => this._handleCompletePrimary(), this);
        if (!this._directLaunchMode) {
            const exit = this._makeRoundedButton(card, 'Exit', '退出', 88, -72, 150, 55, COLORS.coral);
            exit.on(Button.EventType.CLICK, () => this._requestExit(), this);
        }
    }

    private _loadLevel(index: number, startReason: TruckEscape2AttemptStartReason = 'initial') {
        if (!this._vehicleLayer) return;
        this._levelIndex = Math.max(0, Math.min(index, this._levels.length - 1));
        this._level = this._levels[this._levelIndex];
        this._model = new TruckEscape2BoardModel(this._level);
        this._complete = false;
        this._inputLocked = false;
        this._history = [];
        this._hintTokens = this._level.hintCount ?? 1;
        this._drag = null;

        this._renderBoard(this._level);

        for (const runtime of this._vehicles.values()) {
            Tween.stopAllByTarget(runtime.node);
            runtime.node.removeFromParent();
            runtime.node.destroy();
        }
        this._vehicles.clear();

        for (const spec of this._level.vehicles) {
            const runtime = this._createVehicle(spec);
            this._vehicles.set(spec.id, runtime);
        }

        if (this._modeLabel) {
            this._modeLabel.string = this._difficulty === 'easy'
                ? 'EASY'
                : this._difficulty === 'medium' ? 'MEDIUM' : 'HARD';
        }
        if (this._levelLabel) this._levelLabel.string = `Level ${this._level.levelNumber}`;
        if (this._completeOverlay) this._completeOverlay.active = false;
        this._abilityAttemptId = this._safeTrack(
            () => this._abilityTracker.startAttempt(this._level!, this._model!, startReason),
        );
    }

    private _createVehicle(spec: TruckEscape2VehicleSpec): TruckEscape2VehicleRuntime {
        const node = new Node(`TruckEscape2Vehicle_${spec.id}`);
        node.layer = this._vehicleLayer!.layer;
        node.parent = this._vehicleLayer;
        const lengthPx = spec.length * this._cellSize - Math.max(8, this._cellSize * 0.11);
        const widthPx = this._cellSize - Math.max(12, this._cellSize * 0.18);
        node.addComponent(UITransform).setContentSize(lengthPx, widthPx);
        node.angle = spec.orientation === 'vertical' ? 90 : 0;
        const baseScaleX = spec.flipVisual ? -1 : 1;
        node.setScale(baseScaleX, 1, 1);
        this._drawVehicle(node, spec, lengthPx, widthPx);
        // 直接绑定到车辆命中节点。Cocos 会把同一触点后续的 MOVE/END 继续
        // 派发给最初命中的节点，因此手指离开车身后仍可自然完成长距离拖动。
        node.on(Node.EventType.TOUCH_START, this._onTouchStart, this);
        node.on(Node.EventType.TOUCH_MOVE, this._onTouchMove, this);
        node.on(Node.EventType.TOUCH_END, this._onTouchEnd, this);
        node.on(Node.EventType.TOUCH_CANCEL, this._onTouchCancel, this);

        const state = this._model!.getState(spec.id);
        node.setPosition(this._vehiclePosition(spec, state.row, state.col));
        return { spec, node, baseScaleX };
    }

    private _drawVehicle(node: Node, spec: TruckEscape2VehicleSpec, length: number, width: number) {
        const palette = VEHICLE_PALETTES[spec.color];
        const gfx = node.addComponent(Graphics);
        const left = -length / 2;
        const bottom = -width / 2;

        // 双层落影、橡胶轮胎和金属轮毂让车辆从棋盘表面自然浮起。
        gfx.fillColor = new Color(0, 4, 7, 75);
        gfx.roundRect(left + 6, bottom - 7, length - 1, width + 3, Math.min(22, width * 0.34));
        gfx.fill();
        gfx.fillColor = new Color(0, 0, 0, 78);
        gfx.roundRect(left + 3, bottom - 3, length - 2, width + 1, Math.min(20, width * 0.31));
        gfx.fill();

        const axleCount = spec.style === 'semi' || spec.style === 'bus' ? 3 : 2;
        this._drawWheels(gfx, length, width, axleCount);

        if (spec.style === 'semi') this._drawSemi(gfx, length, width, palette);
        else if (spec.style === 'bus') this._drawBus(gfx, length, width, palette);
        else if (spec.style === 'target') this._drawTargetTruck(gfx, length, width, palette);
        else if (spec.style === 'pickup') this._drawPickup(gfx, length, width, palette);
        else this._drawCar(gfx, length, width, palette, spec.style === 'coupe');
    }

    private _drawWheels(gfx: Graphics, length: number, width: number, axleCount: number) {
        const bottom = -width / 2;
        const tireWidth = Math.min(24, Math.max(13, length * 0.115));
        const tireHeight = Math.max(7, width * 0.145);
        const positions = axleCount === 3
            ? [-length * 0.34, length * 0.05, length * 0.34]
            : [-length * 0.3, length * 0.3];

        for (const x of positions) {
            for (const y of [bottom - 1, width / 2 - tireHeight + 1]) {
                gfx.fillColor = new Color(8, 12, 16, 255);
                gfx.roundRect(x - tireWidth / 2, y, tireWidth, tireHeight, tireHeight * 0.42);
                gfx.fill();
                gfx.fillColor = new Color(81, 91, 98, 255);
                gfx.roundRect(x - tireWidth * 0.22, y + tireHeight * 0.2, tireWidth * 0.44, tireHeight * 0.6, 2);
                gfx.fill();
            }
        }
    }

    private _drawSemi(gfx: Graphics, length: number, width: number, palette: VehiclePalette) {
        const left = -length / 2;
        const bottom = -width / 2;
        const cabW = Math.max(55, length * 0.29);
        const trailerW = length - cabW - 5;

        this._fillStrokeRoundRect(gfx, left + 2, bottom + 5, trailerW, width - 10, 12, palette.body, COLORS.ink, 3.5);
        gfx.fillColor = palette.bodyLight;
        gfx.roundRect(left + 9, bottom + 10, trailerW - 18, width - 20, 9);
        gfx.fill();
        gfx.fillColor = new Color(255, 255, 255, 56);
        gfx.roundRect(left + 14, width * 0.17, trailerW - 30, width * 0.12, 4);
        gfx.fill();
        gfx.lineWidth = 2;
        gfx.strokeColor = new Color(palette.bodyDark.r, palette.bodyDark.g, palette.bodyDark.b, 125);
        const ribGap = Math.max(25, trailerW / 4);
        for (let x = left + 30; x < left + trailerW - 14; x += ribGap) {
            gfx.moveTo(x, bottom + 13);
            gfx.lineTo(x, width / 2 - 13);
            gfx.stroke();
        }

        const cabX = left + trailerW + 2;
        this._fillStrokeRoundRect(gfx, cabX, bottom + 5, cabW + 1, width - 10, Math.min(17, width * 0.28), palette.body, COLORS.ink, 3.5);
        gfx.fillColor = palette.bodyDark;
        gfx.roundRect(cabX + 4, bottom + 10, cabW * 0.18, width - 20, 6);
        gfx.fill();
        gfx.fillColor = COLORS.glass;
        gfx.roundRect(cabX + cabW * 0.33, bottom + 11, cabW * 0.43, width - 22, 9);
        gfx.fill();
        gfx.fillColor = COLORS.glassLight;
        gfx.roundRect(cabX + cabW * 0.38, width * 0.11, cabW * 0.3, width * 0.1, 3);
        gfx.fill();
        this._drawFrontLights(gfx, length / 2 - 6, width, palette);
    }

    private _drawBus(gfx: Graphics, length: number, width: number, palette: VehiclePalette) {
        const left = -length / 2;
        const bottom = -width / 2;
        this._fillStrokeRoundRect(gfx, left + 3, bottom + 5, length - 6, width - 10, Math.min(18, width * 0.29), palette.body, COLORS.ink, 3.5);

        gfx.fillColor = palette.bodyLight;
        gfx.roundRect(left + 10, bottom + 11, length - 20, width - 22, 10);
        gfx.fill();
        gfx.fillColor = palette.bodyDark;
        gfx.roundRect(left + 10, bottom + 9, length - 20, width * 0.11, 3);
        gfx.fill();

        // 长车车头在局部坐标右端；flipVisual 可将完整造型镜像。
        gfx.fillColor = COLORS.glass;
        const windscreenW = Math.max(27, length * 0.16);
        gfx.roundRect(length / 2 - windscreenW - 11, bottom + 13, windscreenW, width - 26, 9);
        gfx.fill();
        gfx.fillColor = COLORS.glassLight;
        gfx.roundRect(length / 2 - windscreenW - 5, width * 0.08, windscreenW * 0.55, width * 0.1, 3);
        gfx.fill();

        const roofStart = left + 18;
        const roofEnd = length / 2 - windscreenW - 16;
        const panelCount = Math.max(2, Math.min(4, Math.floor((roofEnd - roofStart) / 34)));
        const panelGap = (roofEnd - roofStart) / panelCount;
        for (let i = 0; i < panelCount; i++) {
            const x = roofStart + i * panelGap + 3;
            gfx.fillColor = new Color(palette.bodyDark.r, palette.bodyDark.g, palette.bodyDark.b, 145);
            gfx.roundRect(x, bottom + width * 0.31, Math.max(9, panelGap - 8), width * 0.38, 5);
            gfx.fill();
        }
        this._drawFrontLights(gfx, length / 2 - 6, width, palette);
    }

    private _drawTargetTruck(gfx: Graphics, length: number, width: number, palette: VehiclePalette) {
        const left = -length / 2;
        const bottom = -width / 2;
        const cargoW = length * 0.64;
        const cabW = length - cargoW + 4;

        this._fillStrokeRoundRect(gfx, left + 2, bottom + 4, cargoW, width - 8, 8, palette.body, COLORS.ink, 3.5);
        gfx.fillColor = palette.bodyLight;
        gfx.roundRect(left + 8, bottom + 10, cargoW - 15, width - 20, 5);
        gfx.fill();
        gfx.fillColor = new Color(255, 255, 255, 54);
        gfx.roundRect(left + 13, width * 0.18, cargoW - 27, width * 0.11, 3);
        gfx.fill();
        gfx.lineWidth = 2.2;
        gfx.strokeColor = palette.bodyDark;
        const ribGap = Math.max(10, width * 0.2);
        for (let y = bottom + 15; y < width / 2 - 12; y += ribGap) {
            gfx.moveTo(left + 14, y);
            gfx.lineTo(left + cargoW - 12, y);
            gfx.stroke();
        }
        // 货厢上的右向箭头。
        gfx.lineWidth = Math.max(5, width * 0.1);
        gfx.strokeColor = palette.bodyDark;
        gfx.moveTo(left + cargoW * 0.32, 0);
        gfx.lineTo(left + cargoW * 0.7, 0);
        gfx.moveTo(left + cargoW * 0.58, width * 0.16);
        gfx.lineTo(left + cargoW * 0.7, 0);
        gfx.lineTo(left + cargoW * 0.58, -width * 0.16);
        gfx.stroke();

        const cabX = left + cargoW - 2;
        this._fillStrokeRoundRect(gfx, cabX, bottom + 7, cabW, width - 14, Math.min(16, width * 0.25), palette.body, COLORS.ink, 3.5);
        gfx.fillColor = new Color(63, 24, 34, 255);
        gfx.roundRect(cabX + cabW * 0.27, bottom + 12, cabW * 0.4, width - 24, 9);
        gfx.fill();
        gfx.fillColor = new Color(160, 65, 75, 255);
        gfx.roundRect(cabX + cabW * 0.32, width * 0.08, cabW * 0.27, width * 0.1, 3);
        gfx.fill();
        this._drawFrontLights(gfx, length / 2 - 6, width, palette);
    }

    private _drawPickup(gfx: Graphics, length: number, width: number, palette: VehiclePalette) {
        const left = -length / 2;
        const bottom = -width / 2;
        this._fillStrokeRoundRect(gfx, left + 2, bottom + 5, length - 4, width - 10, Math.min(18, width * 0.3), palette.body, COLORS.ink, 3.5);

        // 左侧货斗，右侧驾驶舱；flipVisual 后与截图中的左车头一致。
        gfx.fillColor = new Color(69, 60, 55, 255);
        gfx.roundRect(left + 9, bottom + 12, length * 0.45, width - 24, 7);
        gfx.fill();
        gfx.lineWidth = 2;
        gfx.strokeColor = new Color(139, 119, 103, 120);
        for (let x = left + 21; x < left + length * 0.43; x += Math.max(12, length * 0.1)) {
            gfx.moveTo(x, bottom + 14);
            gfx.lineTo(x, width / 2 - 14);
            gfx.stroke();
        }
        const cabinX = left + length * 0.5;
        gfx.fillColor = palette.bodyLight;
        gfx.roundRect(cabinX, bottom + 10, length * 0.4, width - 20, 13);
        gfx.fill();
        gfx.fillColor = COLORS.glass;
        gfx.roundRect(cabinX + length * 0.06, bottom + 14, length * 0.18, width - 28, 8);
        gfx.fill();
        gfx.fillColor = COLORS.glassLight;
        gfx.roundRect(cabinX + length * 0.08, width * 0.08, length * 0.11, width * 0.09, 3);
        gfx.fill();
        this._drawFrontLights(gfx, length / 2 - 6, width, palette);
    }

    private _drawCar(gfx: Graphics, length: number, width: number, palette: VehiclePalette, coupe: boolean) {
        const left = -length / 2;
        const bottom = -width / 2;
        this._fillStrokeRoundRect(gfx, left + 3, bottom + 5, length - 6, width - 10, Math.min(21, width * 0.34), palette.body, COLORS.ink, 3.5);
        gfx.fillColor = palette.bodyDark;
        gfx.roundRect(left + 10, bottom + 8, length - 20, width * 0.105, 3);
        gfx.fill();

        const cabinX = left + length * (coupe ? 0.32 : 0.27);
        const cabinW = length * (coupe ? 0.42 : 0.48);
        gfx.fillColor = palette.bodyLight;
        gfx.roundRect(cabinX - 4, bottom + 10, cabinW + 8, width - 20, Math.min(16, width * 0.27));
        gfx.fill();
        gfx.fillColor = COLORS.glass;
        gfx.roundRect(cabinX, bottom + 14, cabinW * 0.29, width - 28, 8);
        gfx.fill();
        gfx.roundRect(cabinX + cabinW * 0.68, bottom + 14, cabinW * 0.29, width - 28, 8);
        gfx.fill();
        gfx.fillColor = palette.body;
        gfx.roundRect(cabinX + cabinW * 0.32, bottom + 12, cabinW * 0.32, width - 24, 6);
        gfx.fill();
        gfx.fillColor = COLORS.glassLight;
        gfx.roundRect(cabinX + cabinW * 0.72, width * 0.08, cabinW * 0.18, width * 0.09, 3);
        gfx.fill();

        // 引擎盖、后备箱和高光压线强化俯视玩具车结构。
        gfx.lineWidth = 2;
        gfx.strokeColor = palette.bodyDark;
        gfx.roundRect(left + 11, bottom + 15, length * 0.16, width - 30, 7);
        gfx.stroke();
        gfx.roundRect(left + length * 0.79, bottom + 15, length * 0.13, width - 30, 7);
        gfx.stroke();
        gfx.fillColor = new Color(255, 255, 255, 72);
        gfx.roundRect(left + length * 0.16, width * 0.19, length * 0.17, width * 0.08, 3);
        gfx.fill();
        this._drawFrontLights(gfx, length / 2 - 6, width, palette);
    }

    private _drawFrontLights(gfx: Graphics, frontX: number, width: number, palette: VehiclePalette) {
        const lampY = width * 0.25;
        gfx.fillColor = new Color(255, 229, 136, 255);
        for (const y of [-lampY, lampY]) {
            gfx.roundRect(frontX - 4, y - 3, 8, 6, 3);
            gfx.fill();
        }
        gfx.fillColor = new Color(palette.bodyDark.r, palette.bodyDark.g, palette.bodyDark.b, 230);
        gfx.roundRect(frontX - 1, -width * 0.12, 5, width * 0.24, 2);
        gfx.fill();
    }

    private _onTouchStart(event: EventTouch) {
        if (this._inputLocked || !this._model || !this._boardRoot) return;
        const p = this._touchToBoard(event);
        const touchedNode = event.currentTarget as Node;
        const vehicle = Array.from(this._vehicles.values()).find((runtime) => runtime.node === touchedNode) ?? null;
        if (!vehicle) return;
        const state = this._model.getState(vehicle.spec.id);
        const range = this._model.getTravelRange(vehicle.spec.id);
        const axis = vehicle.spec.orientation === 'horizontal' ? p.x : -p.y;
        this._drag = {
            vehicle,
            startAxis: axis,
            startedAtMs: Date.now(),
            startRow: state.row,
            startCol: state.col,
            minDelta: range.min,
            maxDelta: range.max,
            rawDelta: 0,
            visualDelta: 0,
            inputClamped: false,
        };
        Tween.stopAllByTarget(vehicle.node);
        vehicle.node.setScale(vehicle.baseScaleX * 1.035, 1.035, 1);
        vehicle.node.setSiblingIndex(vehicle.node.parent!.children.length - 1);
    }

    private _onTouchMove(event: EventTouch) {
        if (!this._drag || !this._model) return;
        const p = this._touchToBoard(event);
        const axis = this._drag.vehicle.spec.orientation === 'horizontal' ? p.x : -p.y;
        const rawDelta = (axis - this._drag.startAxis) / this._cellSize;
        const clamped = Math.max(this._drag.minDelta, Math.min(this._drag.maxDelta, rawDelta));
        this._drag.rawDelta = rawDelta;
        this._drag.visualDelta = clamped;
        if (Math.abs(rawDelta - clamped) > 0.001) this._drag.inputClamped = true;

        const spec = this._drag.vehicle.spec;
        const row = this._drag.startRow + (spec.orientation === 'vertical' ? clamped : 0);
        const col = this._drag.startCol + (spec.orientation === 'horizontal' ? clamped : 0);
        this._drag.vehicle.node.setPosition(this._vehiclePosition(spec, row, col));
    }

    private _onTouchEnd() {
        this._finishDrag(false);
    }

    private _onTouchCancel() {
        this._finishDrag(true);
    }

    private _finishDrag(cancelled: boolean) {
        if (!this._drag || !this._model) return;
        const drag = this._drag;
        this._drag = null;
        const snappedDelta = Math.max(
            drag.minDelta,
            Math.min(drag.maxDelta, Math.round(drag.visualDelta)),
        );
        const spec = drag.vehicle.spec;
        let toRow = drag.startRow;
        let toCol = drag.startCol;
        let accepted = false;

        // Preserve the original gameplay contract: TOUCH_CANCEL used the same
        // commit path as TOUCH_END, so a snapped non-zero drag still moves.
        if (snappedDelta !== 0 && this._model.move(spec.id, snappedDelta)) {
            accepted = true;
            const state = this._model.getState(spec.id);
            toRow = state.row;
            toCol = state.col;
            this._history.push({
                vehicleId: spec.id,
                fromRow: drag.startRow,
                fromCol: drag.startCol,
                toRow,
                toCol,
            });
        }

        let invalidReason: TruckEscape2InvalidMoveReason | null = null;
        if (!accepted) {
            invalidReason = cancelled
                ? 'cancelled'
                : (drag.minDelta === 0 && drag.maxDelta === 0
                    ? 'blocked'
                    : (snappedDelta === 0 ? 'below-snap-threshold' : 'model-rejected'));
        }
        const attemptedDelta = Math.round(drag.rawDelta);
        if (this._abilityAttemptId) {
            this._safeTrack(() => this._abilityTracker.recordMove(this._model!, {
                vehicleId: spec.id,
                attemptedDelta,
                appliedDelta: accepted ? snappedDelta : 0,
                accepted,
                invalidReason,
                inputClamped: drag.inputClamped,
                interactionDurationMs: Math.max(0, Date.now() - drag.startedAtMs),
            }, this._abilityAttemptId));
        }

        const target = this._vehiclePosition(spec, toRow, toCol);
        tween(drag.vehicle.node)
            .to(0.12, {
                position: target,
                scale: new Vec3(drag.vehicle.baseScaleX, 1, 1),
            }, { easing: 'quadOut' })
            .call(() => {
                if (this._model?.isComplete()) this._driveTargetOut(drag.vehicle);
            })
            .start();
    }

    private _driveTargetOut(vehicle: TruckEscape2VehicleRuntime) {
        if (this._complete || !this._boardRoot) return;
        this._complete = true;
        this._inputLocked = true;
        const endX = BOARD_WIDTH / 2 + vehicle.spec.length * this._cellSize / 2 + 95;
        tween(vehicle.node)
            .delay(0.06)
            .to(0.52, { position: new Vec3(endX, this._rowCenter(this._level!.exitRow), 0) }, { easing: 'sineIn' })
            .call(() => this._showComplete())
            .start();
    }

    private _showComplete() {
        if (!this._completeOverlay) return;
        const hasNext = this._levelIndex + 1 < this._levels.length;
        if (this._completePrimaryLabel) {
            this._completePrimaryLabel.string = this._directLaunchMode
                ? '再玩一次'
                : (hasNext ? '下一关' : '再玩一次');
        }
        this._completeOverlay.active = true;
        const card = this._completeOverlay.getChildByName('CompleteCard');
        if (card) {
            card.setScale(0.82, 0.82, 1);
            tween(card).to(0.28, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
        }
    }

    private _restartLevel() {
        if (this._levels.length === 0) return;
        if (this._abilityAttemptId) {
            this._safeTrack(() => this._abilityTracker.recordRestart(this._abilityAttemptId));
        }
        this._loadLevel(this._levelIndex, this._complete ? 'replay-after-complete' : 'restart');
    }

    private _handleCompletePrimary() {
        if (this._directLaunchMode) {
            this._restartLevel();
            return;
        }
        if (this._levelIndex + 1 < this._levels.length) this._loadLevel(this._levelIndex + 1, 'next-level');
        else this._restartLevel();
    }

    private _requestExit() {
        if (this._abilityAttemptId) {
            this._safeTrack(() => this._abilityTracker.recordExit(this._abilityAttemptId));
            this._abilityAttemptId = null;
        }
        this.onRequestExit?.();
    }

    /** Analytics errors must never alter movement, collision, or completion. */
    private _safeTrack<T>(action: () => T): T | null {
        try {
            return action();
        } catch (error) {
            console.warn('[TruckEscape2Ability] 指标采集失败，玩法继续运行', error);
            return null;
        }
    }

    private _touchToBoard(event: EventTouch): Vec3 {
        const p = event.getUILocation();
        const transform = this._boardRoot!.getComponent(UITransform)!;
        return transform.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
    }

    private _vehiclePosition(spec: TruckEscape2VehicleSpec, row: number, col: number): Vec3 {
        const centerCol = col + (spec.orientation === 'horizontal' ? (spec.length - 1) / 2 : 0);
        const centerRow = row + (spec.orientation === 'vertical' ? (spec.length - 1) / 2 : 0);
        return new Vec3(this._colCenter(centerCol), this._rowCenter(centerRow), 0);
    }

    private _colCenter(col: number): number {
        return -BOARD_WIDTH / 2 + (col + 0.5) * this._cellSize;
    }

    private _rowCenter(row: number): number {
        return this._boardHeight / 2 - (row + 0.5) * this._cellSize;
    }

    private _clearChildren(parent: Node) {
        for (const child of parent.children.slice()) {
            child.removeFromParent();
            child.destroy();
        }
    }

    private _drawBush(row: number, col: number, id: string) {
        if (!this._blockerLayer) return;
        const size = this._cellSize * 0.72;
        const bush = new Node(`TruckEscape2Blocker_${id}`);
        bush.layer = this._blockerLayer.layer;
        bush.parent = this._blockerLayer;
        bush.setPosition(this._colCenter(col), this._rowCenter(row), 0);
        bush.addComponent(UITransform).setContentSize(size, size);
        const gfx = bush.addComponent(Graphics);
        gfx.fillColor = new Color(54, 77, 75, 255);
        gfx.roundRect(-size / 2, -size / 2, size, size, size * 0.12);
        gfx.fill();
        gfx.fillColor = new Color(45, 104, 43, 255);
        gfx.roundRect(-size * 0.39, -size * 0.39, size * 0.78, size * 0.78, size * 0.18);
        gfx.fill();

        const leaves = [
            [-0.2, 0.18, 0.24, 0.13], [0.02, 0.24, 0.27, 0.14], [0.22, 0.12, 0.24, 0.13],
            [-0.26, -0.02, 0.28, 0.14], [0, 0.02, 0.3, 0.16], [0.27, -0.08, 0.25, 0.13],
            [-0.12, -0.22, 0.25, 0.13], [0.14, -0.22, 0.28, 0.14],
        ];
        for (let i = 0; i < leaves.length; i++) {
            const [x, y, rx, ry] = leaves[i];
            gfx.fillColor = i % 3 === 0
                ? new Color(146, 213, 36, 255)
                : (i % 3 === 1 ? new Color(105, 190, 38, 255) : new Color(75, 157, 39, 255));
            gfx.ellipse(x * size, y * size, rx * size, ry * size);
            gfx.fill();
        }
    }

    private _makeHeaderButton(parent: Node, name: string, text: string, x: number, y: number): Node {
        const width = 104;
        const height = 54;
        const node = new Node(name);
        node.layer = parent.layer;
        node.parent = parent;
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(width, height);
        const gfx = node.addComponent(Graphics);
        gfx.fillColor = new Color(0, 8, 8, 88);
        gfx.roundRect(-width / 2 + 2, -height / 2 - 4, width, height, 18);
        gfx.fill();
        gfx.fillColor = COLORS.white;
        gfx.roundRect(-width / 2, -height / 2, width, height, 18);
        gfx.fill();
        gfx.fillColor = new Color(255, 255, 255, 115);
        gfx.roundRect(-width / 2 + 7, 5, width - 14, 15, 8);
        gfx.fill();
        gfx.lineWidth = 1.5;
        gfx.strokeColor = new Color(255, 255, 255, 190);
        gfx.roundRect(-width / 2 + 1, -height / 2 + 1, width - 2, height - 2, 17);
        gfx.stroke();

        const label = this._makeLabel(node, 'Label', text, 18, new Color(49, 62, 58, 255), true);
        label.node.setPosition(20, 0, 0);
        label.node.getComponent(UITransform)?.setContentSize(54, 38);
        const button = node.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        button.zoomScale = 0.94;
        return node;
    }

    private _makeRoundedButton(
        parent: Node,
        name: string,
        text: string,
        x: number,
        y: number,
        width: number,
        height: number,
        color: Color,
    ): Node {
        const node = new Node(name);
        node.layer = parent.layer;
        node.parent = parent;
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(width, height);
        const gfx = node.addComponent(Graphics);
        gfx.fillColor = new Color(3, 12, 12, 65);
        gfx.roundRect(-width / 2 + 2, -height / 2 - 4, width, height, 15);
        gfx.fill();
        gfx.fillColor = color;
        gfx.roundRect(-width / 2, -height / 2, width, height, 14);
        gfx.fill();
        gfx.fillColor = new Color(255, 255, 255, 38);
        gfx.roundRect(-width / 2 + 7, 4, width - 14, height * 0.28, 7);
        gfx.fill();
        this._makeLabel(node, 'Label', text, 20, COLORS.white, true);
        const button = node.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        button.zoomScale = 0.95;
        return node;
    }

    private _makeLabel(parent: Node, name: string, text: string, fontSize: number, color: Color, bold: boolean): Label {
        const node = new Node(name);
        node.layer = parent.layer;
        node.parent = parent;
        node.addComponent(UITransform).setContentSize(420, Math.max(32, fontSize + 12));
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = fontSize + 6;
        label.color = color;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.isBold = bold;
        return label;
    }

    private _fillStrokeRoundRect(
        gfx: Graphics,
        x: number,
        y: number,
        width: number,
        height: number,
        radius: number,
        fill: Color,
        stroke: Color,
        lineWidth: number,
    ) {
        gfx.fillColor = fill;
        gfx.roundRect(x, y, width, height, radius);
        gfx.fill();
        gfx.lineWidth = lineWidth;
        gfx.strokeColor = stroke;
        gfx.roundRect(x, y, width, height, radius);
        gfx.stroke();
    }

    private _drawBackChevron(parent: Node, color: Color) {
        const icon = new Node('Icon');
        icon.layer = parent.layer;
        icon.parent = parent;
        icon.setPosition(-29, 0, 0);
        icon.addComponent(UITransform).setContentSize(28, 36);
        const gfx = icon.addComponent(Graphics);
        gfx.lineWidth = 6;
        gfx.strokeColor = color;
        gfx.moveTo(6, 12);
        gfx.lineTo(-6, 0);
        gfx.lineTo(6, -12);
        gfx.stroke();
    }

    private _drawRestartIcon(parent: Node, color: Color) {
        const icon = new Node('Icon');
        icon.layer = parent.layer;
        icon.parent = parent;
        icon.setPosition(-28, 0, 0);
        icon.addComponent(UITransform).setContentSize(32, 36);
        const gfx = icon.addComponent(Graphics);
        gfx.lineWidth = 5;
        gfx.strokeColor = color;
        gfx.arc(1, 0, 11, Math.PI * 0.2, Math.PI * 1.85, true);
        gfx.stroke();
        gfx.fillColor = color;
        gfx.moveTo(-14, 6);
        gfx.lineTo(-3, 9);
        gfx.lineTo(-8, -2);
        gfx.close();
        gfx.fill();
    }
}
