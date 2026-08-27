import {
    _decorator,
    Component,
    Node,
    UITransform,
    Sprite,
    SpriteFrame,
    Label,
    Color,
    Vec3,
    Graphics,
    EventTouch,
    resources,
    tween,
    Tween,
    Button,
} from 'cc';
import {
    TruckColor,
    TruckLevelData,
    TruckSpawn,
    directionVector,
    directionRotationDeg,
    colorHeadOffsetDeg,
    DEFAULT_TRUCK_LENGTH,
    DEFAULT_TRUCK_WIDTH,
    TRUCK_VIEWPORT_WIDTH,
    TRUCK_VIEWPORT_HEIGHT,
    TRUCK_HUD_TOP,
    TRUCK_HUD_BOTTOM,
    TRUCK_IDLE_HINT_SECONDS,
} from '../data/TruckLevelData';
import { buildTruckLevels } from '../data/TruckLevelDefinitions';
import { GameInspector, InspectorProvider, PhysicsStats } from './GameInspector';

const { ccclass } = _decorator;

const TRUCK_COLORS: TruckColor[] = ['yellow', 'red', 'blue', 'gray_green'];

/** 道具按钮列表 */
const ITEM_BUTTON_KEYS = ['btn_remove', 'btn_shuffle', 'btn_flip'] as const;
type ItemButtonKey = typeof ITEM_BUTTON_KEYS[number];

/**
 * 一辆卡车的 OBB（面向矩形），在屏幕局部坐标里：
 *   center = (cx, cy)，半长 hl 沿 dir 方向，半宽 hw 沿 dir 的法线方向
 */
interface OBB {
    cx: number;
    cy: number;
    hl: number;
    hw: number;
    /** 朝向单位向量（屏幕坐标，y 向上） */
    fx: number;
    fy: number;
    /** 法线单位向量（朝向逆时针 90°） */
    nx: number;
    ny: number;
}

/** 一辆卡车的运行时实例 */
interface TruckRuntime {
    spawn: TruckSpawn;
    node: Node;
    sprite: Sprite;
    /** 屏幕局部坐标（root 中心为原点） */
    cx: number;
    cy: number;
    /** 屏幕坐标系下的朝向单位向量（y 向上） */
    fx: number;
    fy: number;
    /** 半长 / 半宽（屏幕像素） */
    hl: number;
    hw: number;
    /** 渲染顺序 */
    order: number;
    moving: boolean;
    removed: boolean;
}

/**
 * 《工地我最牛》之 卡车出库小游戏控制器
 *
 * 玩法：
 *  - 卡车自由摆放（不再是棋盘），每辆卡车有连续坐标和四个对角方向之一。
 *  - 点击卡车 → 沿其方向把车身长方形「向前扫掠」，与其他未消除卡车做 OBB 相交检测。
 *    如果相交，则被前方卡车阻挡；否则播放飞出动画并消除。
 *  - 顶部进度条显示已消除 / 总数比例。
 *  - 闲置 5 秒系统会高亮一辆当前可消除的卡车作为提示。
 *
 * 控制器自身仅依赖 UI 节点 + 缓动 + 数学相交计算，不使用 Box2D 物理。
 */
@ccclass('TruckGameController')
export class TruckGameController extends Component {
    public onRequestExit: (() => void) | null = null;

    private _levels: TruckLevelData[] = [];
    private _currentIndex: number = 0;

    private _root: Node | null = null;
    private _bgRoot: Node | null = null;
    private _fieldRoot: Node | null = null;
    private _hudRoot: Node | null = null;
    private _completeOverlay: Node | null = null;
    private _completeTitleLabel: Label | null = null;
    private _completeSubLabel: Label | null = null;
    private _nextLevelButton: Button | null = null;
    private _titleLabel: Label | null = null;

    private _trucks: TruckRuntime[] = [];
    private _level: TruckLevelData | null = null;

    private _scale: number = 1;
    private _fieldOriginX: number = 0;
    private _fieldOriginY: number = 0;

    /** 进度条 */
    private _progressFillGfx: Graphics | null = null;
    private _progressLabel: Label | null = null;
    private readonly _progressBarRect = { cx: 0, cy: 380, w: 320, h: 28 };

    /** 高亮提示 */
    private _idleTimer: number = 0;
    private _hintedTruck: TruckRuntime | null = null;
    /** 高亮提示节点（脉冲圆环）的引用，用于 stopHint 时清理 */
    private _hintRingNode: Node | null = null;

    /** SpriteFrame 缓存（卡车贴图 + 道具按钮贴图） */
    private _frames: Map<string, SpriteFrame> = new Map();
    private _texturesLoaded: boolean = false;
    private _pendingLevelIndex: number = -1;

    /** 标题闪烁 token */
    private _flashTitleToken: number = 0;

    onLoad() {
        this._levels = buildTruckLevels();
        GameInspector.instance.register('truck', this._inspectorProvider);
    }

    start() {
        this._buildSkeleton();
        this._loadTextures(() => {
            this._texturesLoaded = true;
            this._loadLevel(this._pendingLevelIndex >= 0 ? this._pendingLevelIndex : 0);
        });
    }

    update(dt: number) {
        if (!this._level || this._isLevelComplete()) return;
        this._idleTimer += dt;
        if (this._idleTimer >= TRUCK_IDLE_HINT_SECONDS && !this._hintedTruck) {
            this._idleTimer = 0;
            this._showHintForFreeTruck();
        }
    }

    onDestroy() {
        this._stopHint();
        GameInspector.instance.unregister('truck');
    }

    /** Select the first benchmark level by its public, one-based id. */
    public setInitialLevel(levelId: number) {
        const index = Math.max(0, Math.min(Math.trunc(levelId) - 1, this._levels.length - 1));
        this._pendingLevelIndex = index;
        if (this._texturesLoaded) this._loadLevel(index);
    }

    /** Reset without routing through the Hub or changing the selected level. */
    public resetCurrentLevel() {
        this._loadLevel(this._currentIndex);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 场景构建
    // ──────────────────────────────────────────────────────────────────────
    private _buildSkeleton() {
        const root = this.node;
        const ui = root.getComponent(UITransform) ?? root.addComponent(UITransform);
        ui.setContentSize(TRUCK_VIEWPORT_WIDTH, TRUCK_VIEWPORT_HEIGHT);
        ui.setAnchorPoint(0.5, 0.5);
        this._root = root;

        // 草地背景
        const bg = new Node('TruckBackground');
        bg.layer = root.layer;
        bg.parent = root;
        bg.addComponent(UITransform).setContentSize(TRUCK_VIEWPORT_WIDTH, TRUCK_VIEWPORT_HEIGHT);
        const bgGfx = bg.addComponent(Graphics);
        bgGfx.fillColor = new Color(170, 215, 120, 255);
        bgGfx.rect(-TRUCK_VIEWPORT_WIDTH / 2, -TRUCK_VIEWPORT_HEIGHT / 2, TRUCK_VIEWPORT_WIDTH, TRUCK_VIEWPORT_HEIGHT);
        bgGfx.fill();
        bgGfx.fillColor = new Color(135, 195, 95, 255);
        bgGfx.ellipse(-TRUCK_VIEWPORT_WIDTH / 2 + 60, TRUCK_VIEWPORT_HEIGHT / 2 - 30, 220, 90);
        bgGfx.fill();
        bgGfx.ellipse(TRUCK_VIEWPORT_WIDTH / 2 - 80, TRUCK_VIEWPORT_HEIGHT / 2 - 70, 200, 100);
        bgGfx.fill();
        bgGfx.ellipse(-TRUCK_VIEWPORT_WIDTH / 2 + 80, -TRUCK_VIEWPORT_HEIGHT / 2 + 60, 240, 110);
        bgGfx.fill();
        bgGfx.ellipse(TRUCK_VIEWPORT_WIDTH / 2 - 60, -TRUCK_VIEWPORT_HEIGHT / 2 + 50, 200, 90);
        bgGfx.fill();
        bgGfx.fillColor = new Color(255, 250, 240, 255);
        bgGfx.circle(-180, 280, 3); bgGfx.fill();
        bgGfx.circle(150, 320, 3); bgGfx.fill();
        bgGfx.circle(-220, -350, 3); bgGfx.fill();
        bgGfx.circle(180, -320, 3); bgGfx.fill();
        this._bgRoot = bg;

        const field = new Node('TruckField');
        field.layer = root.layer;
        field.parent = root;
        field.addComponent(UITransform).setContentSize(TRUCK_VIEWPORT_WIDTH, TRUCK_VIEWPORT_HEIGHT);
        this._fieldRoot = field;

        const hud = new Node('TruckHUD');
        hud.layer = root.layer;
        hud.parent = root;
        hud.addComponent(UITransform).setContentSize(TRUCK_VIEWPORT_WIDTH, TRUCK_VIEWPORT_HEIGHT);
        this._hudRoot = hud;
        this._buildTopHud(hud);
        this._buildBottomHud(hud);
        this._buildCompleteOverlay(hud);
    }

    private _buildTopHud(parent: Node) {
        const HALF_H = TRUCK_VIEWPORT_HEIGHT / 2;

        const title = this._makeLabel(parent, 'TruckTitle', '', 28);
        title.node.setPosition(0, HALF_H - 60, 0);
        title.horizontalAlign = Label.HorizontalAlign.CENTER;
        title.color = new Color(50, 70, 30, 255);
        title.isBold = true;
        this._titleLabel = title;

        const pr = this._progressBarRect;
        pr.cy = HALF_H - 110;
        const progressBg = new Node('ProgressBg');
        progressBg.layer = parent.layer;
        progressBg.parent = parent;
        progressBg.addComponent(UITransform).setContentSize(pr.w + 40, pr.h + 8);
        progressBg.setPosition(pr.cx, pr.cy, 0);
        const pbg = progressBg.addComponent(Graphics);
        pbg.fillColor = new Color(80, 60, 40, 255);
        pbg.roundRect(-pr.w / 2, -pr.h / 2, pr.w, pr.h, pr.h / 2);
        pbg.fill();

        const progressFill = new Node('ProgressFill');
        progressFill.layer = parent.layer;
        progressFill.parent = parent;
        progressFill.addComponent(UITransform).setContentSize(pr.w, pr.h);
        progressFill.setPosition(pr.cx, pr.cy, 0);
        this._progressFillGfx = progressFill.addComponent(Graphics);

        const progressLabel = this._makeLabel(parent, 'ProgressLabel', '0%', 16);
        progressLabel.node.setPosition(pr.cx, pr.cy, 0);
        progressLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        progressLabel.color = new Color(255, 255, 255, 255);
        progressLabel.isBold = true;
        this._progressLabel = progressLabel;

        // 礼物盒装饰
        const giftNode = new Node('GiftIcon');
        giftNode.layer = parent.layer;
        giftNode.parent = parent;
        giftNode.addComponent(UITransform).setContentSize(34, 34);
        giftNode.setPosition(pr.cx + pr.w / 2 + 8, pr.cy + 2, 0);
        const giftGfx = giftNode.addComponent(Graphics);
        giftGfx.fillColor = new Color(245, 130, 160, 255);
        giftGfx.roundRect(-15, -12, 30, 24, 4); giftGfx.fill();
        giftGfx.fillColor = new Color(220, 80, 120, 255);
        giftGfx.rect(-3, -12, 6, 24); giftGfx.fill();
        giftGfx.rect(-15, -2, 30, 4); giftGfx.fill();

        const backBtn = this._makeButton(parent, 'BackBtn', '主菜单', 95, 38);
        backBtn.node.setPosition(-TRUCK_VIEWPORT_WIDTH / 2 + 65, HALF_H - 60, 0);
        backBtn.node.on(Button.EventType.CLICK, () => {
            if (this.onRequestExit) this.onRequestExit();
        }, this);

        const restartBtn = this._makeButton(parent, 'RestartBtn', '重玩', 95, 38);
        restartBtn.node.setPosition(TRUCK_VIEWPORT_WIDTH / 2 - 65, HALF_H - 60, 0);
        restartBtn.node.on(Button.EventType.CLICK, () => this._loadLevel(this._currentIndex), this);
    }

    private _buildBottomHud(parent: Node) {
        const HALF_H = TRUCK_VIEWPORT_HEIGHT / 2;
        const yCenter = -HALF_H + 90;
        const labels: Record<ItemButtonKey, string> = {
            'btn_remove':  'Remove',
            'btn_shuffle': 'Shuffle',
            'btn_flip':    'Flip',
        };
        const xs = [-130, 0, 130];
        ITEM_BUTTON_KEYS.forEach((k, i) => {
            const n = new Node(`ItemBtn_${k}`);
            n.layer = parent.layer;
            n.parent = parent;
            n.addComponent(UITransform).setContentSize(96, 96);
            n.setPosition(xs[i], yCenter, 0);

            const bg = n.addComponent(Graphics);
            bg.fillColor = new Color(255, 255, 255, 240);
            bg.roundRect(-48, -48, 96, 96, 16);
            bg.fill();
            bg.lineWidth = 3;
            bg.strokeColor = new Color(80, 130, 60, 255);
            bg.roundRect(-48, -48, 96, 96, 16);
            bg.stroke();

            const iconNode = new Node('Icon');
            iconNode.layer = n.layer;
            iconNode.parent = n;
            iconNode.addComponent(UITransform).setContentSize(70, 70);
            iconNode.setPosition(0, 8, 0);
            const sprite = iconNode.addComponent(Sprite);
            sprite.sizeMode = Sprite.SizeMode.CUSTOM;
            const frame = this._frames.get(k);
            if (frame) sprite.spriteFrame = frame;
            iconNode.getComponent(UITransform)!.setContentSize(70, 70);

            const lblNode = new Node('Lbl');
            lblNode.layer = n.layer;
            lblNode.parent = n;
            lblNode.addComponent(UITransform).setContentSize(96, 22);
            lblNode.setPosition(0, -34, 0);
            const lbl = lblNode.addComponent(Label);
            lbl.fontSize = 14;
            lbl.lineHeight = 18;
            lbl.string = labels[k];
            lbl.color = new Color(60, 90, 40, 255);
            lbl.horizontalAlign = Label.HorizontalAlign.CENTER;

            n.addComponent(Button);
            n.on(Button.EventType.CLICK, () => {
                this._flashTitle(`「${labels[k]}」道具暂未开放`);
            }, this);
        });
    }

    private _buildCompleteOverlay(parent: Node) {
        const overlay = new Node('TruckCompleteOverlay');
        overlay.layer = parent.layer;
        overlay.parent = parent;
        overlay.active = false;
        overlay.addComponent(UITransform).setContentSize(TRUCK_VIEWPORT_WIDTH, TRUCK_VIEWPORT_HEIGHT);
        const dim = new Node('Dim');
        dim.layer = parent.layer;
        dim.parent = overlay;
        dim.addComponent(UITransform).setContentSize(TRUCK_VIEWPORT_WIDTH, TRUCK_VIEWPORT_HEIGHT);
        const dimGfx = dim.addComponent(Graphics);
        dimGfx.fillColor = new Color(0, 0, 0, 160);
        dimGfx.rect(-TRUCK_VIEWPORT_WIDTH / 2, -TRUCK_VIEWPORT_HEIGHT / 2, TRUCK_VIEWPORT_WIDTH, TRUCK_VIEWPORT_HEIGHT);
        dimGfx.fill();

        const panel = new Node('Panel');
        panel.layer = parent.layer;
        panel.parent = overlay;
        panel.addComponent(UITransform).setContentSize(420, 280);
        const pg = panel.addComponent(Graphics);
        pg.fillColor = new Color(245, 226, 195, 255);
        pg.roundRect(-210, -140, 420, 280, 16);
        pg.fill();
        pg.lineWidth = 3;
        pg.strokeColor = new Color(115, 71, 36, 255);
        pg.roundRect(-210, -140, 420, 280, 16);
        pg.stroke();

        const titleLbl = this._makeLabel(panel, 'CompleteTitle', '关卡完成！', 28);
        titleLbl.node.setPosition(0, 70, 0);
        titleLbl.color = new Color(60, 36, 16, 255);
        titleLbl.horizontalAlign = Label.HorizontalAlign.CENTER;
        this._completeTitleLabel = titleLbl;

        const subLbl = this._makeLabel(panel, 'CompleteSub', '工地清场，太牛了！', 18);
        subLbl.node.setPosition(0, 30, 0);
        subLbl.color = new Color(80, 50, 28, 255);
        subLbl.horizontalAlign = Label.HorizontalAlign.CENTER;
        subLbl.enableWrapText = true;
        subLbl.getComponent(UITransform)!.setContentSize(380, 60);
        this._completeSubLabel = subLbl;

        const restartBtn = this._makeButton(panel, 'RestartBtn', '重玩本关', 140, 44);
        restartBtn.node.setPosition(-90, -70, 0);
        restartBtn.node.on(Button.EventType.CLICK, () => this._loadLevel(this._currentIndex), this);

        const nextBtn = this._makeButton(panel, 'NextBtn', '下一关', 140, 44);
        nextBtn.node.setPosition(90, -70, 0);
        nextBtn.node.on(Button.EventType.CLICK, () => this._goToNextLevel(), this);
        this._nextLevelButton = nextBtn;

        this._completeOverlay = overlay;
    }

    // ──────────────────────────────────────────────────────────────────────
    // 资源加载（仅普通态卡车 + 道具按钮）
    // ──────────────────────────────────────────────────────────────────────
    private _loadTextures(done: () => void) {
        const tasks: { key: string; path: string }[] = [];
        for (const c of TRUCK_COLORS) {
            tasks.push({ key: c, path: `textures/truck_remove_game/car_${c}/spriteFrame` });
        }
        for (const k of ITEM_BUTTON_KEYS) {
            tasks.push({ key: k, path: `textures/truck_remove_game/${k}/spriteFrame` });
        }
        let pending = tasks.length;
        if (pending === 0) { done(); return; }
        for (const t of tasks) {
            resources.load(t.path, SpriteFrame, (err, frame) => {
                if (!err && frame) this._frames.set(t.key, frame);
                else console.warn(`[TruckGame] failed to load ${t.path}: ${err}`);
                if (--pending === 0) done();
            });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // 关卡加载
    // ──────────────────────────────────────────────────────────────────────
    private _loadLevel(index: number) {
        if (!this._texturesLoaded) {
            this._pendingLevelIndex = index;
            return;
        }
        if (index < 0 || index >= this._levels.length) return;
        this._currentIndex = index;
        const level = this._levels[index];
        this._level = level;

        // 清理
        this._stopHint();
        if (this._fieldRoot) this._fieldRoot.removeAllChildren();
        this._trucks = [];
        this._idleTimer = 0;
        if (this._completeOverlay) this._completeOverlay.active = false;

        // 自适应缩放
        const availW = TRUCK_VIEWPORT_WIDTH - 60;
        const availH = TRUCK_VIEWPORT_HEIGHT - TRUCK_HUD_TOP - TRUCK_HUD_BOTTOM;
        this._scale = Math.min(availW / level.fieldWidth, availH / level.fieldHeight);

        const fieldScreenW = level.fieldWidth * this._scale;
        const fieldScreenH = level.fieldHeight * this._scale;
        this._fieldOriginX = -fieldScreenW / 2;
        const HALF_H = TRUCK_VIEWPORT_HEIGHT / 2;
        const availTop = HALF_H - TRUCK_HUD_TOP;
        const availBottom = -HALF_H + TRUCK_HUD_BOTTOM;
        const availMidY = (availTop + availBottom) / 2;
        this._fieldOriginY = availMidY + fieldScreenH / 2;

        const truckLen = (level.truckLength ?? DEFAULT_TRUCK_LENGTH) * this._scale;
        const truckWid = (level.truckWidth  ?? DEFAULT_TRUCK_WIDTH)  * this._scale;
        for (let i = 0; i < level.trucks.length; i++) {
            this._spawnTruck(level.trucks[i], i, truckLen, truckWid);
        }
        // 屏幕下方的车在上层（近大远小遮挡感）
        this._trucks.sort((a, b) => a.cy - b.cy);
        this._trucks.forEach((t, idx) => {
            t.order = idx;
            t.node.setSiblingIndex(idx);
        });

        if (this._titleLabel) this._titleLabel.string = level.title;
        if (this._nextLevelButton) {
            this._nextLevelButton.node.active = index < this._levels.length - 1;
        }
        this._updateProgress();

        // 启动后立即做一次解算检查（开发期日志，发现关卡设计错误）
        if (!this._isLevelSolvable()) {
            console.warn(`[TruckGame] 关卡 ${index} (${level.title}) 可能无解！`);
        }
    }

    private _levelToScreen(lx: number, ly: number): { x: number; y: number } {
        const x = this._fieldOriginX + lx * this._scale;
        const y = this._fieldOriginY - ly * this._scale;
        return { x, y };
    }

    private _spawnTruck(sp: TruckSpawn, index: number, truckLen: number, truckWid: number) {
        if (!this._fieldRoot) return;
        const node = new Node(`Truck_${sp.id}`);
        node.layer = this._fieldRoot.layer;
        node.parent = this._fieldRoot;

        const ui = node.addComponent(UITransform);
        ui.setContentSize(truckWid, truckLen);
        ui.setAnchorPoint(0.5, 0.5);

        const screen = this._levelToScreen(sp.x, sp.y);
        node.setPosition(screen.x, screen.y, 0);
        // 节点旋转 = 方向旋转 + 颜色素材自带的 180° 修正
        node.angle = directionRotationDeg(sp.direction) + colorHeadOffsetDeg(sp.color);

        // 阴影：默认放在节点局部 -Y（车尾下方）。红色车因为 colorHeadOffsetDeg=0
        // 与其它颜色（180°）相反，节点局部 ±Y 方向相对车头是反的，所以翻一下符号。
        const shadowDir = sp.color === 'red' ? 1 : -1;
        const shadow = new Node('Shadow');
        shadow.layer = node.layer;
        shadow.parent = node;
        shadow.addComponent(UITransform).setContentSize(truckWid, truckLen);
        shadow.setPosition(0, shadowDir * truckLen * 0.08, 0);
        const sgfx = shadow.addComponent(Graphics);
        sgfx.fillColor = new Color(0, 0, 0, 80);
        sgfx.ellipse(0, shadowDir * truckLen * 0.35, truckWid * 0.55, truckLen * 0.18);
        sgfx.fill();

        // 车身贴图
        const spriteNode = new Node('Sprite');
        spriteNode.layer = node.layer;
        spriteNode.parent = node;
        const sprUi = spriteNode.addComponent(UITransform);
        sprUi.setContentSize(truckWid, truckLen);
        sprUi.setAnchorPoint(0.5, 0.5);
        const sprite = spriteNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.spriteFrame = this._frames.get(sp.color) ?? null;
        sprUi.setContentSize(truckWid, truckLen);

        // 朝向单位向量（屏幕坐标，y 向上）
        const v = directionVector(sp.direction);
        const fx = v.dx;
        const fy = -v.dy;

        const rt: TruckRuntime = {
            spawn: sp,
            node, sprite,
            cx: screen.x, cy: screen.y,
            fx, fy,
            hl: truckLen / 2,
            hw: truckWid / 2,
            order: index,
            moving: false, removed: false,
        };

        node.on(Node.EventType.TOUCH_END, (ev: EventTouch) => this._onTruckTapped(rt, ev), this);
        this._trucks.push(rt);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 玩法逻辑：阻挡判定 + 飞出动画
    // ──────────────────────────────────────────────────────────────────────
    private _truckOBB(t: TruckRuntime): OBB {
        return {
            cx: t.cx, cy: t.cy,
            hl: t.hl, hw: t.hw,
            fx: t.fx, fy: t.fy,
            nx: -t.fy, ny: t.fx,
        };
    }

    private _obbIntersect(a: OBB, b: OBB): boolean {
        const axes = [
            { x: a.fx, y: a.fy }, { x: a.nx, y: a.ny },
            { x: b.fx, y: b.fy }, { x: b.nx, y: b.ny },
        ];
        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        for (const ax of axes) {
            const t = Math.abs(dx * ax.x + dy * ax.y);
            const ra = Math.abs(a.hl * (a.fx * ax.x + a.fy * ax.y))
                     + Math.abs(a.hw * (a.nx * ax.x + a.ny * ax.y));
            const rb = Math.abs(b.hl * (b.fx * ax.x + b.fy * ax.y))
                     + Math.abs(b.hw * (b.nx * ax.x + b.ny * ax.y));
            if (t > ra + rb + 0.5) return false;
        }
        return true;
    }

    private _canTruckLeave(t: TruckRuntime): boolean {
        if (t.removed || t.moving) return false;
        const screenDiag = Math.hypot(TRUCK_VIEWPORT_WIDTH, TRUCK_VIEWPORT_HEIGHT);
        const D = screenDiag * 1.2;
        const sweepHl = D / 2;
        const offset = t.hl + sweepHl;
        const sweepCx = t.cx + t.fx * offset;
        const sweepCy = t.cy + t.fy * offset;
        const sweep: OBB = {
            cx: sweepCx, cy: sweepCy,
            hl: sweepHl, hw: Math.max(1, t.hw - 1),
            fx: t.fx, fy: t.fy,
            nx: -t.fy, ny: t.fx,
        };
        for (const other of this._trucks) {
            if (other === t || other.removed || other.moving) continue;
            if (this._obbIntersect(sweep, this._truckOBB(other))) return false;
        }
        return true;
    }

    /**
     * 关卡可解性检查：贪心模拟——反复找一辆当前能开走的卡车把它标记为"已消除"，
     * 直到所有车都消除（可解）或者找不到可消除的车（无解）。
     * 该函数不会修改实际状态，仅用临时 set 模拟。
     */
    private _isLevelSolvable(): boolean {
        const removed = new Set<string>();
        const all = this._trucks.slice();
        const isLeavable = (t: TruckRuntime): boolean => {
            const sweepHl = Math.hypot(TRUCK_VIEWPORT_WIDTH, TRUCK_VIEWPORT_HEIGHT) * 0.6;
            const offset = t.hl + sweepHl;
            const sweep: OBB = {
                cx: t.cx + t.fx * offset, cy: t.cy + t.fy * offset,
                hl: sweepHl, hw: Math.max(1, t.hw - 1),
                fx: t.fx, fy: t.fy,
                nx: -t.fy, ny: t.fx,
            };
            for (const other of all) {
                if (other === t || removed.has(other.spawn.id)) continue;
                if (this._obbIntersect(sweep, this._truckOBB(other))) return false;
            }
            return true;
        };
        while (removed.size < all.length) {
            let progressed = false;
            for (const t of all) {
                if (removed.has(t.spawn.id)) continue;
                if (isLeavable(t)) {
                    removed.add(t.spawn.id);
                    progressed = true;
                }
            }
            if (!progressed) return false;
        }
        return true;
    }

    private _onTruckTapped(t: TruckRuntime, ev: EventTouch) {
        ev.propagationStopped = true;
        if (!this._level || t.removed || t.moving) return;
        if (this._isLevelComplete()) return;

        this._idleTimer = 0;
        this._stopHint();

        if (!this._canTruckLeave(t)) {
            this._shake(t.node);
            this._flashTitle('前面被挡住了，先开走前面的车');
            return;
        }
        this._driveAway(t);
    }

    private _driveAway(t: TruckRuntime) {
        t.moving = true;
        if (t.node && t.node.isValid) {
            t.node.setSiblingIndex(this._trucks.length);
        }
        const screenDiag = Math.hypot(TRUCK_VIEWPORT_WIDTH, TRUCK_VIEWPORT_HEIGHT);
        const dist = screenDiag + t.hl * 2;
        const endX = t.cx + t.fx * dist;
        const endY = t.cy + t.fy * dist;
        const duration = 0.55;

        Tween.stopAllByTarget(t.node);
        tween(t.node)
            .to(duration, {
                position: new Vec3(endX, endY, 0),
                scale: new Vec3(0.55, 0.55, 1),
            }, { easing: 'quadIn' })
            .call(() => this._onTruckGone(t))
            .start();
    }

    private _onTruckGone(t: TruckRuntime) {
        t.removed = true;
        t.moving = false;
        if (t.node && t.node.isValid) t.node.destroy();
        this._updateProgress();
        if (this._isLevelComplete()) {
            this._showComplete();
        }
    }

    private _shake(node: Node) {
        if (!node || !node.isValid) return;
        const original = node.position.clone();
        Tween.stopAllByTarget(node);
        tween(node)
            .to(0.05, { position: new Vec3(original.x - 6, original.y, 0) })
            .to(0.05, { position: new Vec3(original.x + 6, original.y, 0) })
            .to(0.05, { position: new Vec3(original.x - 4, original.y, 0) })
            .to(0.05, { position: new Vec3(original.x, original.y, 0) })
            .start();
    }

    private _isLevelComplete(): boolean {
        return this._trucks.every(t => t.removed);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 进度条
    // ──────────────────────────────────────────────────────────────────────
    private _updateProgress() {
        if (!this._progressFillGfx || !this._progressLabel) return;
        const total = this._trucks.length;
        const done = this._trucks.filter(t => t.removed).length;
        const ratio = total === 0 ? 0 : done / total;

        const g = this._progressFillGfx;
        g.clear();
        const pr = this._progressBarRect;
        const fillW = Math.max(0, pr.w * ratio);
        if (fillW > 0) {
            g.fillColor = new Color(255, 200, 80, 255);
            g.roundRect(-pr.w / 2, -pr.h / 2, fillW, pr.h, pr.h / 2);
            g.fill();
        }
        this._progressLabel.string = `${Math.round(ratio * 100)}%`;
    }

    // ──────────────────────────────────────────────────────────────────────
    // 高亮提示（不再依赖 glow 素材：在卡车下方画一圈黄色描边圆，并做呼吸缩放）
    // ──────────────────────────────────────────────────────────────────────
    private _showHintForFreeTruck() {
        if (this._hintedTruck || !this._fieldRoot) return;
        const candidate = this._trucks.find(t => !t.removed && !t.moving && this._canTruckLeave(t));
        if (!candidate) return;
        this._hintedTruck = candidate;

        // 创建一个独立的高亮环节点，置于卡车节点下方但坐标贴着卡车中心
        const ring = new Node('HintRing');
        ring.layer = this._fieldRoot.layer;
        ring.parent = this._fieldRoot;
        const size = Math.max(candidate.hl, candidate.hw) * 2 + 30;
        ring.addComponent(UITransform).setContentSize(size, size);
        ring.setPosition(candidate.cx, candidate.cy, 0);
        // 放在卡车之下：siblingIndex 设为 candidate.order - 1
        const idx = Math.max(0, this._fieldRoot.children.indexOf(candidate.node));
        ring.setSiblingIndex(idx);

        const g = ring.addComponent(Graphics);
        g.lineWidth = 6;
        g.strokeColor = new Color(255, 220, 80, 255);
        g.circle(0, 0, size / 2 - 4);
        g.stroke();
        // 内层一圈淡填充
        g.fillColor = new Color(255, 220, 80, 60);
        g.circle(0, 0, size / 2 - 4);
        g.fill();

        this._hintRingNode = ring;
        Tween.stopAllByTarget(ring);
        tween(ring)
            .repeatForever(
                tween<Node>().to(0.5, { scale: new Vec3(1.18, 1.18, 1) }, { easing: 'sineInOut' })
                    .to(0.5, { scale: new Vec3(0.9, 0.9, 1) }, { easing: 'sineInOut' })
            )
            .start();

        // 同时让卡车自己上下小幅跳动，强化提示
        Tween.stopAllByTarget(candidate.node);
        const baseY = candidate.cy;
        tween(candidate.node)
            .repeatForever(
                tween<Node>().to(0.4, { position: new Vec3(candidate.cx, baseY + 6, 0) }, { easing: 'sineInOut' })
                    .to(0.4, { position: new Vec3(candidate.cx, baseY, 0) }, { easing: 'sineInOut' })
            )
            .start();
    }

    private _stopHint() {
        if (this._hintRingNode && this._hintRingNode.isValid) {
            Tween.stopAllByTarget(this._hintRingNode);
            this._hintRingNode.destroy();
        }
        this._hintRingNode = null;
        if (this._hintedTruck) {
            const t = this._hintedTruck;
            if (t.node && t.node.isValid && !t.removed) {
                Tween.stopAllByTarget(t.node);
                t.node.setPosition(t.cx, t.cy, 0);
            }
        }
        this._hintedTruck = null;
    }

    // ──────────────────────────────────────────────────────────────────────
    // 通关 / 切关
    // ──────────────────────────────────────────────────────────────────────
    private _showComplete() {
        if (!this._completeOverlay) return;
        this._stopHint();
        this._completeOverlay.active = true;
        if (this._completeTitleLabel) this._completeTitleLabel.string = '关卡完成！';
        const isLast = this._currentIndex >= this._levels.length - 1;
        if (this._completeSubLabel) {
            this._completeSubLabel.string = isLast
                ? '所有关卡都通关了，工地我最牛！'
                : '工地清场，干得漂亮！';
        }
        if (this._nextLevelButton) this._nextLevelButton.node.active = !isLast;
    }

    private _goToNextLevel() {
        if (this._currentIndex < this._levels.length - 1) {
            this._loadLevel(this._currentIndex + 1);
        }
    }

    private _flashTitle(msg: string) {
        if (!this._titleLabel || !this._level) return;
        this._titleLabel.string = msg;
        const myToken = ++this._flashTitleToken;
        this.scheduleOnce(() => {
            if (this._flashTitleToken === myToken && this._titleLabel && this._level) {
                this._titleLabel.string = this._level.title;
            }
        }, 1.4);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 通用 UI helpers
    // ──────────────────────────────────────────────────────────────────────
    private _makeLabel(parent: Node, name: string, text: string, fontSize: number): Label {
        const n = new Node(name);
        n.layer = parent.layer;
        n.parent = parent;
        const ui = n.addComponent(UITransform);
        ui.setContentSize(TRUCK_VIEWPORT_WIDTH, fontSize + 10);
        const label = n.addComponent(Label);
        label.fontSize = fontSize;
        label.lineHeight = fontSize + 4;
        label.string = text;
        label.color = new Color(255, 255, 255, 255);
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
        bg.roundRect(-w / 2, -h / 2, w, h, 8);
        bg.fill();
        bg.lineWidth = 2;
        bg.strokeColor = new Color(115, 71, 36, 255);
        bg.roundRect(-w / 2, -h / 2, w, h, 8);
        bg.stroke();

        const labelNode = new Node('Label');
        labelNode.layer = parent.layer;
        labelNode.parent = n;
        labelNode.addComponent(UITransform).setContentSize(w, h);
        const label = labelNode.addComponent(Label);
        label.fontSize = 18;
        label.lineHeight = 22;
        label.string = text;
        label.color = new Color(40, 22, 10, 255);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;

        return n.addComponent(Button);
    }

    // ──────────────────────────────────────────────────────────────────────
    // GameInspector hook — read-only state for GUI-agent monitoring/reward.
    // ──────────────────────────────────────────────────────────────────────
    private _inspectorProvider: InspectorProvider = {
        snapshot: () => {
            const trucks = this._trucks.map(t => ({
                id: t.spawn.id,
                x: t.spawn.x,
                y: t.spawn.y,
                color: t.spawn.color,
                direction: t.spawn.direction,
                removed: t.removed,
                moving: t.moving,
            }));
            const trucksRemoved = trucks.reduce((n, t) => n + (t.removed ? 1 : 0), 0);
            return {
                ready: this._texturesLoaded && !!this._level && this._trucks.length > 0,
                level: this._currentIndex,
                levelTitle: this._level?.title ?? '',
                complete: this._trucks.length > 0 && this._isLevelComplete(),
                trucksTotal: this._trucks.length,
                trucksRemoved,
                trucks,
            };
        },

        outcomeHash: () => {
            // Truck game has no perpetual motion, so we can include `moving` in
            // the hash: stable_frames only accumulates after the exit tween
            // finishes and `removed` flips. Avoids reading reward mid-animation.
            const parts: string[] = [
                String(this._currentIndex),
                this._trucks.length > 0 && this._isLevelComplete() ? '1' : '0',
            ];
            for (const t of this._trucks) {
                parts.push(t.spawn.id, t.removed ? '1' : '0', t.moving ? '1' : '0');
            }
            return parts.join(',');
        },

        physicsStats: (): PhysicsStats => {
            const moving = this._trucks.reduce((n, t) => n + (!t.removed && t.moving ? 1 : 0), 0);
            return { quiet: moving === 0, maxLinearVelocity: 0, movingBodies: moving };
        },
    };
}
