import {
    _decorator,
    Button,
    Color,
    Component,
    Graphics,
    Label,
    Node,
    Tween,
    tween,
    UIOpacity,
    UITransform,
    Vec3,
} from 'cc';
import { VIEWPORT_HEIGHT, VIEWPORT_WIDTH } from '../data/LevelData';
import { GameInspector } from '../game/GameInspector';
import type { InspectorProvider } from '../game/GameInspector';
import {
    getNutsBoltsLevels,
    NutsBoltsDifficulty,
    NutsBoltsLevelData,
    validateNutsBoltsLevel,
} from './NutsBoltsLevelData';
import { NutsBoltsModel, NutsBoltsMoveError, NutsBoltsMoveRecord } from './NutsBoltsModel';
import {
    BoltVisualRuntime,
    createBoltVisual,
    refX,
    refY,
} from './NutsBoltsVisuals';
import {
    animateBoardArrival,
    animateBoltShake,
    animateTransfer,
    setBoltSelected,
    stopBoltAnimations,
} from './NutsBoltsAnimator';

const { ccclass } = _decorator;

const BACKGROUND_TOP = new Color(41, 24, 62, 255);
const BACKGROUND_BOTTOM = new Color(38, 22, 57, 255);
const EXIT_BUTTON = new Color(250, 249, 250, 255);
const RESTART_BUTTON = new Color(214, 86, 118, 255);
const RESTART_ICON = new Color(255, 244, 247, 255);
const RESTART_CAPTION = new Color(255, 196, 208, 255);
const UNDO_BUTTON = new Color(236, 176, 42, 255);
const UNDO_ICON = new Color(48, 32, 8, 255);
const UNDO_CAPTION = new Color(255, 228, 150, 255);
const UNDO_BUTTON_OFF = new Color(96, 78, 42, 255);
const UNDO_ICON_OFF = new Color(214, 186, 118, 255);
const UNDO_CAPTION_OFF = new Color(196, 168, 108, 255);
const UNDO_SIZE = 72;

@ccclass('NutsBoltsController')
export class NutsBoltsController extends Component {
    public difficulty: NutsBoltsDifficulty = 'easy';
    public onRequestExit: (() => void) | null = null;
    private _directLaunchMode = false;

    private _levels: NutsBoltsLevelData[] = [];
    private _levelIndex = 0;
    private _initialLevelIndex = 0;
    private _model: NutsBoltsModel | null = null;
    private _boardRoot: Node | null = null;
    private _movingLayer: Node | null = null;
    private _boltViews: BoltVisualRuntime[] = [];
    private _selectedBolt = -1;
    private _inputLocked = false;
    private _complete = false;
    private _actionToken = 0;
    private _animationKind: 'move' | 'undo' | null = null;

    private _difficultyLabel: Label | null = null;
    private _levelLabel: Label | null = null;
    private _undoButton: Button | null = null;
    private _undoNode: Node | null = null;
    private _undoIconGraphics: Graphics | null = null;
    private _undoTextLabel: Label | null = null;
    private _undoOpacity: UIOpacity | null = null;
    private _feedbackNode: Node | null = null;
    private _completeNode: Node | null = null;
    private _pendingAdvance: (() => void) | null = null;

    private readonly _inspectorProvider: InspectorProvider = {
        snapshot: () => ({
            ready: !!this._model && this._boltViews.length > 0,
            difficulty: this.difficulty,
            level: this._levelIndex + 1,
            levelCount: this._levels.length,
            capacity: this._model?.capacity ?? 0,
            complete: this._complete,
            busy: this._inputLocked,
            selectedBolt: this._selectedBolt,
            historyLength: this._model?.historyLength ?? 0,
            controls: { exit: true, restart: true, undo: this._canUseUndo() },
            undoAvailable: (this._model?.historyLength ?? 0) > 0,
            animation: this._animationKind,
            bolts: this._model?.getStacks().map((nuts, index) => ({
                index,
                screenX: this._levels[this._levelIndex]?.bolts[index]?.screenX ?? 0,
                baseBottomY: this._levels[this._levelIndex]?.bolts[index]?.baseBottomY ?? 0,
                nuts,
                remaining: Math.max(0, (this._model?.capacity ?? 0) - nuts.length),
            })) ?? [],
        }),
        outcomeHash: () => [
            this.difficulty,
            this._levelIndex,
            this._model?.serialize() ?? '',
            this._model?.historyLength ?? 0,
            this._complete ? 1 : 0,
            this._inputLocked ? 1 : 0,
        ].join(':'),
    };

    onLoad() {
        this._applyDifficulty(this.difficulty);
        GameInspector.instance.register('nutsBolts', this._inspectorProvider);
    }

    start() {
        this._buildScene();
        this._loadLevel(this._initialLevelIndex);
    }

    onDestroy() {
        this._actionToken++;
        this._cancelAdvance();
        this._stopBoardAnimations();
        this.unscheduleAllCallbacks();
        GameInspector.instance.unregister('nutsBolts');
    }

    public setDifficulty(difficulty: NutsBoltsDifficulty): void {
        this.difficulty = difficulty;
        this._applyDifficulty(difficulty);
        if (this._boardRoot) this._loadLevel(0);
    }

    /** Select the first benchmark level by its public, one-based id. */
    public setInitialLevel(levelId: number): void {
        this._initialLevelIndex = Math.max(0, Math.min(Math.trunc(levelId) - 1, this._levels.length - 1));
        if (this._boardRoot) this._loadLevel(this._initialLevelIndex);
    }

    /** Keep a query-launched completion visible instead of advancing silently. */
    public setDirectLaunchMode(enabled: boolean): void {
        this._directLaunchMode = enabled;
    }

    /** Reset without routing through the Hub or changing the selected level. */
    public resetCurrentLevel(): void {
        this._loadLevel(this._levelIndex);
    }

    private _applyDifficulty(difficulty: NutsBoltsDifficulty): void {
        this._levels = getNutsBoltsLevels(difficulty);
        for (const level of this._levels) validateNutsBoltsLevel(level);
        this._levelIndex = 0;
    }

    private _buildScene(): void {
        const ui = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
        ui.setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        ui.setAnchorPoint(0.5, 0.5);
        this._drawBackground();

        const board = new Node('NutsBoltsBoard');
        board.layer = this.node.layer;
        board.parent = this.node;
        board.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        this._boardRoot = board;

        const moving = new Node('NutsBoltsMovingLayer');
        moving.layer = this.node.layer;
        moving.parent = this.node;
        moving.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        this._movingLayer = moving;
        this._buildHud();
    }

    private _drawBackground(): void {
        const bg = new Node('NutsBoltsBackground');
        bg.layer = this.node.layer;
        bg.parent = this.node;
        bg.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        const g = bg.addComponent(Graphics);

        const bands = 16;
        for (let i = 0; i < bands; i++) {
            const t = i / Math.max(1, bands - 1);
            g.fillColor = new Color(
                Math.round(BACKGROUND_BOTTOM.r + (BACKGROUND_TOP.r - BACKGROUND_BOTTOM.r) * t),
                Math.round(BACKGROUND_BOTTOM.g + (BACKGROUND_TOP.g - BACKGROUND_BOTTOM.g) * t),
                Math.round(BACKGROUND_BOTTOM.b + (BACKGROUND_TOP.b - BACKGROUND_BOTTOM.b) * t),
                255,
            );
            const y = -VIEWPORT_HEIGHT / 2 + i * VIEWPORT_HEIGHT / bands;
            g.rect(-VIEWPORT_WIDTH / 2, y, VIEWPORT_WIDTH, VIEWPORT_HEIGHT / bands + 1);
            g.fill();
        }

        // Keep the supplied field nearly flat; the very small band variation
        // prevents visible colour stepping on low-end mobile GPUs.
    }

    private _buildHud(): void {
        const titlePill = new Node('DifficultyPill');
        titlePill.layer = this.node.layer;
        titlePill.parent = this.node;
        titlePill.setPosition(refX(215), refY(65.5), 0);
        titlePill.addComponent(UITransform).setContentSize(132, 20);
        const pillG = titlePill.addComponent(Graphics);
        pillG.fillColor = new Color(52, 29, 65, 230);
        pillG.roundRect(-66, -10, 132, 20, 10);
        pillG.fill();

        const diffNode = new Node('DifficultyLabel');
        diffNode.layer = this.node.layer;
        diffNode.parent = titlePill;
        diffNode.addComponent(UITransform).setContentSize(132, 22);
        const diff = diffNode.addComponent(Label);
        diff.fontSize = 13;
        diff.lineHeight = 17;
        diff.isBold = true;
        diff.color = new Color(255, 255, 255, 245);
        diff.horizontalAlign = Label.HorizontalAlign.CENTER;
        diff.verticalAlign = Label.VerticalAlign.CENTER;
        this._difficultyLabel = diff;

        const levelNode = new Node('LevelLabel');
        levelNode.layer = this.node.layer;
        levelNode.parent = this.node;
        levelNode.setPosition(0, refY(91), 0);
        levelNode.addComponent(UITransform).setContentSize(240, 40);
        const levelLabel = levelNode.addComponent(Label);
        levelLabel.fontSize = 29;
        levelLabel.lineHeight = 35;
        levelLabel.isBold = true;
        levelLabel.color = new Color(255, 255, 255, 255);
        levelLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        levelLabel.verticalAlign = Label.VerticalAlign.CENTER;
        this._levelLabel = levelLabel;

        if (!this._directLaunchMode) {
            const exit = this._createRoundButton('ExitButton', refX(38.5), refY(82), 62, EXIT_BUTTON, true);
            this._drawBackIcon(exit);
            exit.on(Button.EventType.CLICK, this._requestExit, this);
        }

        const restart = this._createRoundButton('RestartButton', refX(390), refY(82), 62, RESTART_BUTTON, true);
        this._drawRestartIcon(restart, RESTART_ICON);
        restart.on(Button.EventType.CLICK, this._restartLevel, this);
        this._addHudCaption('RestartText', '重开', refX(390), refY(128), RESTART_CAPTION);

        const undo = this._createRoundButton('UndoButton', refX(54.5), refY(852), UNDO_SIZE, UNDO_BUTTON_OFF, false);
        this._undoIconGraphics = this._drawUndoIcon(undo, UNDO_ICON_OFF);
        undo.on(Button.EventType.CLICK, this._undo, this);
        this._undoNode = undo;
        this._undoButton = undo.getComponent(Button);
        this._undoOpacity = undo.addComponent(UIOpacity);
        this._undoTextLabel = this._addHudCaption(
            'UndoText',
            '撤销',
            refX(54.5),
            refY(908),
            UNDO_CAPTION_OFF,
        );
    }

    private _addHudCaption(name: string, text: string, x: number, y: number, color: Color): Label {
        const node = new Node(name);
        node.layer = this.node.layer;
        node.parent = this.node;
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(108, 30);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = 22;
        label.lineHeight = 26;
        label.isBold = true;
        label.color = color;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        return label;
    }

    private _createRoundButton(
        name: string,
        x: number,
        y: number,
        size: number,
        color: Color,
        lit: boolean,
    ): Node {
        const node = new Node(name);
        node.layer = this.node.layer;
        node.parent = this.node;
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(size, size);
        node.addComponent(Graphics);
        this._paintRoundButton(node, size, color, lit);
        const button = node.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        button.zoomScale = 0.94;
        return node;
    }

    private _paintRoundButton(node: Node, size: number, color: Color, lit: boolean): void {
        const g = node.getComponent(Graphics);
        if (!g) return;
        g.clear();
        g.fillColor = new Color(10, 7, 22, 72);
        g.circle(0, -3, size * 0.50); g.fill();
        g.fillColor = color;
        g.circle(0, 0, size * 0.47); g.fill();
        g.strokeColor = lit
            ? new Color(255, 255, 255, 110)
            : new Color(255, 255, 255, 28);
        g.lineWidth = lit ? 4 : 2;
        g.circle(0, 0, size * 0.47); g.stroke();
        g.fillColor = new Color(255, 255, 255, lit ? 80 : 18);
        g.circle(-size * 0.12, size * 0.14, size * 0.27); g.fill();
    }

    private _drawBackIcon(parent: Node): void {
        const icon = new Node('BackIcon');
        icon.layer = parent.layer;
        icon.parent = parent;
        const g = icon.addComponent(Graphics);
        g.strokeColor = new Color(215, 130, 166, 255);
        g.lineWidth = 7;
        g.moveTo(7, 13); g.lineTo(-6, 0); g.lineTo(7, -13); g.stroke();
    }

    private _drawRestartIcon(parent: Node, color: Color): void {
        const icon = new Node('RestartIcon');
        icon.layer = parent.layer;
        icon.parent = parent;
        const g = icon.addComponent(Graphics);
        g.strokeColor = color;
        g.lineWidth = 7;
        g.moveTo(-12, 8);
        g.bezierCurveTo(-2, 20, 17, 13, 16, -2);
        g.bezierCurveTo(15, -14, 0, -19, -11, -10);
        g.stroke();
        g.fillColor = color;
        g.moveTo(-18, 7); g.lineTo(-7, 14); g.lineTo(-8, 1); g.close(); g.fill();
    }

    private _drawUndoIcon(parent: Node, color: Color): Graphics {
        const icon = new Node('UndoIcon');
        icon.layer = parent.layer;
        icon.parent = parent;
        const g = icon.addComponent(Graphics);
        this._paintUndoIcon(g, color);
        return g;
    }

    private _paintUndoIcon(g: Graphics, color: Color): void {
        g.clear();
        g.strokeColor = color;
        g.lineWidth = 8;
        g.lineCap = Graphics.LineCap.ROUND;
        g.moveTo(14, 6);
        g.bezierCurveTo(14, -16, -14, -16, -14, 2);
        g.stroke();
        g.fillColor = color;
        g.moveTo(-22, 2);
        g.lineTo(-8, 16);
        g.lineTo(-6, 0);
        g.close();
        g.fill();
    }

    private _loadLevel(index: number): void {
        if (this._levels.length === 0 || !this._boardRoot) return;
        this._actionToken++;
        this._cancelAdvance();
        this._dismissFeedback();
        this._dismissComplete();
        this._stopBoardAnimations();
        if (this._movingLayer) this._movingLayer.destroyAllChildren();

        this._levelIndex = Math.max(0, Math.min(index, this._levels.length - 1));
        this._model = new NutsBoltsModel(this._levels[this._levelIndex]);
        this._selectedBolt = -1;
        this._inputLocked = false;
        this._complete = false;
        this._animationKind = null;
        this._updateHeader();
        this._renderBoard(true);
        this._updateUndoState();
    }

    private _renderBoard(animate: boolean): void {
        if (!this._boardRoot || !this._model) return;
        this._stopBoardAnimations();
        this._boardRoot.destroyAllChildren();
        this._boltViews.length = 0;
        const level = this._levels[this._levelIndex];
        const stacks = this._model.getStacks();
        for (let index = 0; index < level.bolts.length; index++) {
            this._boltViews.push(createBoltVisual(
                this._boardRoot,
                level,
                index,
                stacks[index],
                () => this._onBoltClicked(index),
            ));
        }
        if (animate) animateBoardArrival(this._boltViews);
    }

    private _updateHeader(): void {
        const level = this._levels[this._levelIndex];
        if (this._difficultyLabel) this._difficultyLabel.string = level.difficultyLabel;
        if (this._levelLabel) this._levelLabel.string = `第 ${level.levelNumber} 關`;
    }

    private _onBoltClicked(index: number): void {
        if (this._inputLocked || this._complete || !this._model) return;
        const stack = this._model.getStack(index);

        if (this._selectedBolt < 0) {
            if (stack.length === 0) {
                animateBoltShake(this._boltViews[index]);
                this._showFeedback('這根螺栓是空的');
                return;
            }
            this._selectBolt(index);
            return;
        }

        if (index === this._selectedBolt) {
            this._clearSelection();
            return;
        }

        const sourceIndex = this._selectedBolt;
        const attempt = this._model.move(sourceIndex, index);
        if (attempt.ok === false) {
            animateBoltShake(this._boltViews[index]);
            this._showFeedback(this._messageForMoveError(attempt.reason));
            return;
        }

        const token = ++this._actionToken;
        this._inputLocked = true;
        this._animationKind = 'move';
        const sourceView = this._boltViews[sourceIndex];
        const targetView = this._boltViews[index];
        const sourceLength = attempt.move.sourceLengthBefore;
        const runLength = this._model.getMovableRunLength(sourceIndex) + attempt.move.count;
        setBoltSelected(sourceView, sourceLength, runLength, false);
        this._selectedBolt = -1;
        this._updateUndoState();

        animateTransfer(
            this._movingLayer!,
            this._levels[this._levelIndex],
            sourceView,
            targetView,
            this._boltViews,
            attempt.move,
            attempt.move.color,
            () => {
                if (token !== this._actionToken || !this.node || !this.node.isValid) return;
                this._inputLocked = false;
                this._animationKind = null;
                this._renderBoard(false);
                this._updateUndoState();
                if (this._model?.isComplete()) this._showComplete();
            },
        );
    }

    private _selectBolt(index: number): void {
        if (!this._model) return;
        this._clearSelection();
        this._selectedBolt = index;
        const run = this._model.getMovableRunLength(index);
        setBoltSelected(this._boltViews[index], this._model.getStack(index).length, run, true);
    }

    private _clearSelection(): void {
        if (this._selectedBolt < 0 || !this._model) {
            this._selectedBolt = -1;
            return;
        }
        const index = this._selectedBolt;
        const run = this._model.getMovableRunLength(index);
        setBoltSelected(this._boltViews[index], this._model.getStack(index).length, run, false);
        this._selectedBolt = -1;
    }

    private _messageForMoveError(reason: NutsBoltsMoveError): string {
        if (reason === 'target-full') return '這根螺栓沒有空間了';
        if (reason === 'color-mismatch') return '只能疊在相同顏色上';
        if (reason === 'empty-source') return '這根螺栓是空的';
        return '不能這樣移動';
    }

    private _undo(): void {
        if (!this._model) return;
        if (this._inputLocked && !this._complete) {
            this._showFeedback('請等螺帽落穩');
            return;
        }
        const record = this._model.peekUndo();
        if (!record) {
            this._showFeedback('暂时没有可撤销的步骤');
            this._updateUndoState();
            return;
        }

        const token = ++this._actionToken;
        this._cancelAdvance();
        this._dismissComplete();
        this._complete = false;
        this._clearSelection();
        this._inputLocked = true;
        this._animationKind = 'undo';
        this._updateUndoState();

        const reverseMove: NutsBoltsMoveRecord = {
            source: record.target,
            target: record.source,
            color: record.color,
            count: record.count,
            sourceLengthBefore: this._model.getStack(record.target).length,
            targetLengthBefore: this._model.getStack(record.source).length,
        };
        animateTransfer(
            this._movingLayer!,
            this._levels[this._levelIndex],
            this._boltViews[reverseMove.source],
            this._boltViews[reverseMove.target],
            this._boltViews,
            reverseMove,
            reverseMove.color,
            () => {
                if (token !== this._actionToken || !this.node || !this.node.isValid) return;
                this._model?.undo();
                this._inputLocked = false;
                this._animationKind = null;
                this._renderBoard(false);
                this._updateUndoState();
            },
        );
    }

    private _restartLevel(): void {
        this._loadLevel(this._levelIndex);
    }

    private _requestExit(): void {
        this._actionToken++;
        this._inputLocked = true;
        this._cancelAdvance();
        this.onRequestExit?.();
    }

    private _updateUndoState(): void {
        const available = (this._model?.historyLength ?? 0) > 0;
        const interactable = this._canUseUndo();
        if (this._undoNode) {
            this._paintRoundButton(
                this._undoNode,
                UNDO_SIZE,
                available ? UNDO_BUTTON : UNDO_BUTTON_OFF,
                available,
            );
        }
        if (this._undoIconGraphics) {
            this._paintUndoIcon(this._undoIconGraphics, available ? UNDO_ICON : UNDO_ICON_OFF);
        }
        if (this._undoTextLabel) {
            this._undoTextLabel.color = available ? UNDO_CAPTION : UNDO_CAPTION_OFF;
        }
        if (this._undoOpacity) this._undoOpacity.opacity = available && !interactable ? 210 : 255;
        if (this._undoButton) this._undoButton.interactable = interactable;
    }

    private _canUseUndo(): boolean {
        const available = (this._model?.historyLength ?? 0) > 0;
        return available && (!this._inputLocked || this._complete);
    }

    private _showFeedback(message: string): void {
        this._dismissFeedback();
        const node = new Node('NutsBoltsFeedback');
        node.layer = this.node.layer;
        node.parent = this.node;
        node.setPosition(0, 318, 0);
        node.addComponent(UITransform).setContentSize(300, 54);
        const g = node.addComponent(Graphics);
        g.fillColor = new Color(18, 12, 31, 220);
        g.roundRect(-150, -27, 300, 54, 22); g.fill();
        g.lineWidth = 2;
        g.strokeColor = new Color(255, 255, 255, 28);
        g.roundRect(-149, -26, 298, 52, 21); g.stroke();

        const labelNode = new Node('Label');
        labelNode.layer = node.layer;
        labelNode.parent = node;
        labelNode.addComponent(UITransform).setContentSize(280, 48);
        const label = labelNode.addComponent(Label);
        label.string = message;
        label.fontSize = 20;
        label.lineHeight = 26;
        label.color = new Color(250, 243, 251, 255);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;

        const opacity = node.addComponent(UIOpacity);
        opacity.opacity = 0;
        this._feedbackNode = node;
        tween(opacity)
            .to(0.10, { opacity: 255 })
            .delay(0.70)
            .to(0.18, { opacity: 0 })
            .call(() => {
                if (this._feedbackNode === node) this._feedbackNode = null;
                if (node.isValid) node.destroy();
            })
            .start();
    }

    private _dismissFeedback(): void {
        if (this._feedbackNode && this._feedbackNode.isValid) {
            const opacity = this._feedbackNode.getComponent(UIOpacity);
            if (opacity) Tween.stopAllByTarget(opacity);
            this._feedbackNode.destroy();
        }
        this._feedbackNode = null;
    }

    private _showComplete(): void {
        if (this._complete || !this._model) return;
        this._complete = true;
        this._inputLocked = true;
        this._clearSelection();
        this._updateUndoState();

        const node = new Node('NutsBoltsComplete');
        node.layer = this.node.layer;
        node.parent = this.node;
        node.setPosition(0, 42, 0);
        node.addComponent(UITransform).setContentSize(330, 142);
        const g = node.addComponent(Graphics);
        g.fillColor = new Color(20, 12, 34, 232);
        g.roundRect(-165, -71, 330, 142, 30); g.fill();
        g.lineWidth = 3;
        g.strokeColor = new Color(255, 211, 68, 220);
        g.roundRect(-163, -69, 326, 138, 28); g.stroke();
        g.fillColor = new Color(255, 195, 40, 255);
        g.circle(-105, 3, 37); g.fill();
        g.strokeColor = new Color(255, 255, 255, 255);
        g.lineWidth = 8;
        g.moveTo(-122, 3); g.lineTo(-109, -10); g.lineTo(-87, 17); g.stroke();

        const last = this._levelIndex >= this._levels.length - 1;
        const titleNode = new Node('Title');
        titleNode.layer = node.layer;
        titleNode.parent = node;
        titleNode.setPosition(40, 20, 0);
        titleNode.addComponent(UITransform).setContentSize(205, 42);
        const title = titleNode.addComponent(Label);
        title.string = last ? '全部完成！' : '完成！';
        title.fontSize = 30;
        title.lineHeight = 36;
        title.isBold = true;
        title.color = new Color(255, 249, 235, 255);
        title.horizontalAlign = Label.HorizontalAlign.LEFT;
        title.verticalAlign = Label.VerticalAlign.CENTER;

        const subNode = new Node('Subtitle');
        subNode.layer = node.layer;
        subNode.parent = node;
        subNode.setPosition(40, -23, 0);
        subNode.addComponent(UITransform).setContentSize(205, 32);
        const sub = subNode.addComponent(Label);
        sub.string = this._directLaunchMode
            ? '可重開本關，或從外頁選擇其他謎題'
            : (last ? '這個難度已全數通關' : '即將進入下一關');
        sub.fontSize = 17;
        sub.lineHeight = 22;
        sub.color = new Color(218, 207, 224, 255);
        sub.horizontalAlign = Label.HorizontalAlign.LEFT;
        sub.verticalAlign = Label.VerticalAlign.CENTER;

        node.setScale(0.78, 0.78, 1);
        tween(node).to(0.28, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
        this._completeNode = node;

        if (!last && !this._directLaunchMode) {
            const token = this._actionToken;
            this._pendingAdvance = () => {
                this._pendingAdvance = null;
                if (token !== this._actionToken || !this.node || !this.node.isValid) return;
                this._loadLevel(this._levelIndex + 1);
            };
            this.scheduleOnce(this._pendingAdvance, 1.35);
        }
    }

    private _dismissComplete(): void {
        if (this._completeNode && this._completeNode.isValid) {
            Tween.stopAllByTarget(this._completeNode);
            this._completeNode.destroy();
        }
        this._completeNode = null;
    }

    private _cancelAdvance(): void {
        if (!this._pendingAdvance) return;
        this.unschedule(this._pendingAdvance);
        this._pendingAdvance = null;
    }

    private _stopBoardAnimations(): void {
        for (const runtime of this._boltViews) stopBoltAnimations(runtime);
        this._boltViews.length = 0;
    }
}
