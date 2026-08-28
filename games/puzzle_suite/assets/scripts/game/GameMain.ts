import {
    _decorator,
    Component,
    Node,
    Canvas,
    Camera,
    UITransform,
    Color,
    Director,
    director,
    Layers,
    PhysicsSystem2D,
    Button,
    Label,
    Graphics,
    view,
    screen,
    ResolutionPolicy,
    profiler,
} from 'cc';
import { LevelController } from './LevelController';
import { TruckGameController } from './TruckGameController';
import { TruckEscape2Controller } from './TruckEscape2Controller';
import { HomePage } from './HomePage';
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from '../data/LevelData';
import { GameInspector } from './GameInspector';
import { BoltDifficulty } from '../data/LevelDefinitions';
import type { TruckEscape2Difficulty } from '../data/TruckEscape2Data';
import { NutsBoltsController } from '../nuts_bolts/NutsBoltsController';
import type { NutsBoltsDifficulty } from '../nuts_bolts/NutsBoltsLevelData';
import { MazePaintController } from '../maze_paint/MazePaintController';
import type { MazePaintDifficulty } from '../maze_paint/MazePaintLevelData';
import { ColorConnectController } from '../color_connect/ColorConnectController';
import type { ColorConnectDifficulty } from '../color_connect/ColorConnectLevelData';
import {
    BenchmarkLaunchConfig,
    installBenchmarkBridge,
    installPlaygroundBridge,
    readBenchmarkLaunchConfig,
} from './BenchmarkBridge';

const { ccclass } = _decorator;

/** 当前展示的子游戏 / 主菜单 */
type View =
    | 'home'
    | 'difficulty'
    | 'bolt'
    | 'truck'
    | 'truck2-difficulty'
    | 'truck2'
    | 'nuts-bolts-difficulty'
    | 'nuts-bolts'
    | 'maze-paint-difficulty'
    | 'maze-paint'
    | 'color-connect-difficulty'
    | 'color-connect';

/**
 * 入口组件：负责挂载主菜单与各子游戏控制器，并在它们之间路由。
 *
 * - 主菜单（HomePage）由代码动态构建，列表展示《螺丝专家》《卡车出库》等
 *   子游戏入口；
 * - 选中入口后销毁主菜单子树，挂上对应的游戏控制器；
 * - 子游戏控制器通过 `onRequestExit` 回调请求返回主菜单。
 */
@ccclass('GameMain')
export class GameMain extends Component {
    private _currentView: View | null = null;
    private _viewRoot: Node | null = null;

    start() {
        // Debug Web builds enable the engine stats overlay by default; keep it
        // out of GUI-agent screenshots and normal Hub gameplay.
        try { profiler.hideStats(); } catch (_) { /* profiler is optional on some targets */ }
        const benchmark = readBenchmarkLaunchConfig();
        GameInspector.instance.install(!benchmark.playground);
        if (benchmark.enabled) {
            if (benchmark.playground) installPlaygroundBridge(benchmark);
            else installBenchmarkBridge(benchmark);
            this._showBenchmarkGame(benchmark);
        } else this._showHome();
    }

    /** Query-driven entry used by MobileWorld; it never renders the Hub menus. */
    private _showBenchmarkGame(config: BenchmarkLaunchConfig) {
        if (config.gameId === 'bolt_unscrew') {
            this._showBoltGame(config.difficulty as BoltDifficulty, config.levelId, true);
        } else if (config.gameId === 'truck_escape') {
            this._showTruckGame(config.levelId, true, config.playground);
        } else if (config.gameId === 'truck_escape_2') {
            this._showTruckEscape2Game(
                config.difficulty as TruckEscape2Difficulty,
                config.levelId,
                config.playground,
            );
        } else if (config.gameId === 'nuts_bolts') {
            this._showNutsBoltsGame(
                config.difficulty as NutsBoltsDifficulty,
                config.levelId,
                config.playground,
            );
        } else if (config.gameId === 'maze_paint') {
            this._showMazePaintGame(
                config.difficulty as MazePaintDifficulty,
                config.levelId,
                config.playground,
            );
        } else if (config.gameId === 'color_connect') {
            this._showColorConnectGame(
                config.difficulty as ColorConnectDifficulty,
                config.levelId,
                config.playground,
            );
        }
    }

    /** 销毁当前视图节点及其组件 */
    private _disposeCurrentView() {
        if (this._viewRoot && this._viewRoot.isValid) {
            // 先触发组件 onDisable，让控制器有机会按生命周期解除它自己
            // 注册的 DOM / Cocos 输入和 Tween；之后再做通用事件兜底清理。
            this._viewRoot.active = false;
            this._stripInputs(this._viewRoot);
            // 立即从父节点上卸下，避免在 destroy 异步执行前还能继续命中事件
            this._viewRoot.removeFromParent();
            this._viewRoot.destroy();
        }
        // 兜底：把 this.node 上残留的任何子节点（不该存在的）一并清掉，
        // 防止上一帧 destroy 还未真正生效或有其它地方意外加了节点
        for (const child of this.node.children.slice()) {
            this._stripInputs(child);
            child.active = false;
            child.removeFromParent();
            child.destroy();
        }
        this._viewRoot = null;
        this._currentView = null;
        // 关闭物理（卡车小游戏不需要 Box2D；螺丝游戏会在 onLoad 时自行打开）
        try {
            PhysicsSystem2D.instance.enable = false;
        } catch (_) {
            // 某些平台早期可能尚未初始化，忽略
        }
    }

    /** 递归把子树里所有事件监听 + Button 组件清掉，防止销毁前残余触摸命中 */
    private _stripInputs(n: Node) {
        if (!n || !n.isValid) return;
        n.targetOff(this);
        n.off(Node.EventType.TOUCH_START);
        n.off(Node.EventType.TOUCH_END);
        n.off(Node.EventType.TOUCH_MOVE);
        n.off(Node.EventType.TOUCH_CANCEL);
        const btn = n.getComponent(Button);
        if (btn) btn.interactable = false;
        for (const c of n.children) this._stripInputs(c);
    }

    private _showHome() {
        this._disposeCurrentView();
        const view = new Node('HomeView');
        view.layer = this.node.layer;
        view.parent = this.node;
        view.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        view.setPosition(0, 0, 0);
        const home = view.addComponent(HomePage);
        home.onSelectGame = (id) => this._onSelectGame(id);
        this._viewRoot = view;
        this._currentView = 'home';
        GameInspector.instance.setView('home');
    }

    private _onSelectGame(id: string) {
        if (id === 'bolt') this._showBoltDifficultySelect();
        else if (id === 'truck') this._showTruckGame();
        else if (id === 'truck2') this._showTruckEscape2DifficultySelect();
        else if (id === 'nuts-bolts') this._showNutsBoltsDifficultySelect();
        else if (id === 'maze-paint') this._showMazePaintDifficultySelect();
        else if (id === 'color-connect') this._showColorConnectDifficultySelect();
    }

    private _showBoltDifficultySelect() {
        this._disposeCurrentView();
        const view = new Node('BoltDifficultyView');
        view.layer = this.node.layer;
        view.parent = this.node;
        view.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        view.setPosition(0, 0, 0);

        this._buildBoltDifficultyView(view);
        this._viewRoot = view;
        this._currentView = 'difficulty';
        GameInspector.instance.setView('difficulty');
    }

    private _showBoltGame(difficulty: BoltDifficulty, initialLevelId: number = 1, benchmarkMode: boolean = false) {
        this._disposeCurrentView();
        const view = new Node('BoltGameView');
        view.layer = this.node.layer;
        view.parent = this.node;
        view.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        view.setPosition(0, 0, 0);
        const ctrl = view.addComponent(LevelController);
        ctrl.setDifficulty(difficulty);
        ctrl.setInitialLevel(initialLevelId);
        // LevelController 自带 “重开” 按钮但没有 “返回主菜单”，
        // 我们额外塞一个返回按钮节点放在 view 顶层，避免修改 LevelController 本身。
        if (!benchmarkMode) this._addBackToMenuButton(view);
        // ctrl 仅引用以避免 unused 警告
        void ctrl;
        this._viewRoot = view;
        this._currentView = 'bolt';
        GameInspector.instance.setView('bolt');
    }

    private _buildBoltDifficultyView(root: Node) {
        const bg = new Node('Bg');
        bg.layer = root.layer;
        bg.parent = root;
        bg.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        const bgGfx = bg.addComponent(Graphics);
        bgGfx.fillColor = new Color(252, 220, 150, 255);
        bgGfx.rect(-VIEWPORT_WIDTH / 2, -VIEWPORT_HEIGHT / 2, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        bgGfx.fill();
        bgGfx.fillColor = new Color(115, 71, 36, 255);
        bgGfx.rect(-VIEWPORT_WIDTH / 2, VIEWPORT_HEIGHT / 2 - 210, VIEWPORT_WIDTH, 210);
        bgGfx.fill();

        const titleNode = new Node('Title');
        titleNode.layer = root.layer;
        titleNode.parent = root;
        titleNode.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, 70);
        titleNode.setPosition(0, VIEWPORT_HEIGHT / 2 - 105, 0);
        const title = titleNode.addComponent(Label);
        title.fontSize = 44;
        title.lineHeight = 52;
        title.string = '选择难度';
        title.color = new Color(255, 240, 200, 255);
        title.horizontalAlign = Label.HorizontalAlign.CENTER;
        title.verticalAlign = Label.VerticalAlign.CENTER;
        title.isBold = true;

        const subNode = new Node('Subtitle');
        subNode.layer = root.layer;
        subNode.parent = root;
        subNode.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, 32);
        subNode.setPosition(0, VIEWPORT_HEIGHT / 2 - 160, 0);
        const sub = subNode.addComponent(Label);
        sub.fontSize = 20;
        sub.lineHeight = 24;
        sub.string = '螺丝专家';
        sub.color = new Color(255, 240, 200, 220);
        sub.horizontalAlign = Label.HorizontalAlign.CENTER;
        sub.verticalAlign = Label.VerticalAlign.CENTER;

        this._buildDifficultyCard(
            root,
            '简单',
            '原始入门关卡 · 保留第 1–8 关',
            new Color(105, 166, 96, 255),
            115,
            () => this._showBoltGame('easy')
        );
        this._buildDifficultyCard(
            root,
            '困难',
            '高阶结构关卡 · 更复杂的木条机关',
            new Color(196, 88, 68, 255),
            -35,
            () => this._showBoltGame('hard')
        );

        const back = this._buildSmallButton(root, '返回', -VIEWPORT_WIDTH / 2 + 75, -VIEWPORT_HEIGHT / 2 + 52, 110, 42);
        back.on(Button.EventType.CLICK, () => this._showHome(), this);
    }

    private _buildDifficultyCard(
        parent: Node,
        titleText: string,
        descText: string,
        accent: Color,
        y: number,
        onClick: () => void
    ) {
        const w = VIEWPORT_WIDTH - 80;
        const h = 118;
        const n = new Node(`Difficulty_${titleText}`);
        n.layer = parent.layer;
        n.parent = parent;
        n.setPosition(0, y, 0);
        n.addComponent(UITransform).setContentSize(w, h);

        const g = n.addComponent(Graphics);
        g.fillColor = new Color(255, 248, 230, 255);
        g.roundRect(-w / 2, -h / 2, w, h, 18);
        g.fill();
        g.lineWidth = 3;
        g.strokeColor = new Color(115, 71, 36, 255);
        g.roundRect(-w / 2, -h / 2, w, h, 18);
        g.stroke();
        g.fillColor = accent;
        g.roundRect(-w / 2 + 14, -h / 2 + 14, 16, h - 28, 7);
        g.fill();

        const titleNode = new Node('Name');
        titleNode.layer = n.layer;
        titleNode.parent = n;
        titleNode.addComponent(UITransform).setContentSize(w - 110, 42);
        titleNode.setPosition(28, 20, 0);
        const title = titleNode.addComponent(Label);
        title.fontSize = 32;
        title.lineHeight = 38;
        title.string = titleText;
        title.color = new Color(70, 40, 16, 255);
        title.horizontalAlign = Label.HorizontalAlign.LEFT;
        title.verticalAlign = Label.VerticalAlign.CENTER;
        title.isBold = true;

        const descNode = new Node('Desc');
        descNode.layer = n.layer;
        descNode.parent = n;
        descNode.addComponent(UITransform).setContentSize(w - 110, 30);
        descNode.setPosition(28, -24, 0);
        const desc = descNode.addComponent(Label);
        desc.fontSize = 18;
        desc.lineHeight = 22;
        desc.string = descText;
        desc.color = new Color(120, 90, 60, 255);
        desc.horizontalAlign = Label.HorizontalAlign.LEFT;
        desc.verticalAlign = Label.VerticalAlign.CENTER;

        const badge = new Node('Badge');
        badge.layer = n.layer;
        badge.parent = n;
        badge.addComponent(UITransform).setContentSize(78, 40);
        badge.setPosition(w / 2 - 60, 0, 0);
        const badgeGfx = badge.addComponent(Graphics);
        badgeGfx.fillColor = accent;
        badgeGfx.roundRect(-39, -20, 78, 40, 10);
        badgeGfx.fill();
        const badgeLblNode = new Node('BadgeLbl');
        badgeLblNode.layer = n.layer;
        badgeLblNode.parent = badge;
        badgeLblNode.addComponent(UITransform).setContentSize(78, 40);
        const badgeLbl = badgeLblNode.addComponent(Label);
        badgeLbl.fontSize = 20;
        badgeLbl.lineHeight = 24;
        badgeLbl.string = '进入 ▶';
        badgeLbl.color = new Color(255, 255, 255, 255);
        badgeLbl.horizontalAlign = Label.HorizontalAlign.CENTER;
        badgeLbl.verticalAlign = Label.VerticalAlign.CENTER;

        n.addComponent(Button);
        n.on(Button.EventType.CLICK, () => {
            this._stripInputs(parent);
            if (parent && parent.isValid) parent.active = false;
            this.scheduleOnce(onClick, 0);
        }, this);
    }

    private _buildSmallButton(parent: Node, text: string, x: number, y: number, w: number, h: number): Node {
        const n = new Node(`${text}Btn`);
        n.layer = parent.layer;
        n.parent = parent;
        n.addComponent(UITransform).setContentSize(w, h);
        n.setPosition(x, y, 0);
        const g = n.addComponent(Graphics);
        g.fillColor = new Color(196, 142, 73, 255);
        g.roundRect(-w / 2, -h / 2, w, h, 8);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = new Color(115, 71, 36, 255);
        g.roundRect(-w / 2, -h / 2, w, h, 8);
        g.stroke();
        const lblNode = new Node('Lbl');
        lblNode.layer = n.layer;
        lblNode.parent = n;
        lblNode.addComponent(UITransform).setContentSize(w, h);
        const lbl = lblNode.addComponent(Label);
        lbl.fontSize = 18;
        lbl.lineHeight = 22;
        lbl.string = text;
        lbl.color = new Color(40, 22, 10, 255);
        lbl.horizontalAlign = Label.HorizontalAlign.CENTER;
        lbl.verticalAlign = Label.VerticalAlign.CENTER;
        n.addComponent(Button);
        return n;
    }

    private _showTruckGame(
        initialLevelId: number = 1,
        disableAutoHint: boolean = false,
        directLaunchMode: boolean = false,
    ) {
        this._disposeCurrentView();
        const view = new Node('TruckGameView');
        view.layer = this.node.layer;
        view.parent = this.node;
        view.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        view.setPosition(0, 0, 0);
        const ctrl = view.addComponent(TruckGameController);
        ctrl.setAutoHintEnabled(!disableAutoHint);
        ctrl.setDirectLaunchMode(directLaunchMode);
        ctrl.setInitialLevel(initialLevelId);
        ctrl.onRequestExit = () => this._showHome();
        this._viewRoot = view;
        this._currentView = 'truck';
        GameInspector.instance.setView('truck');
    }

    /** 《卡车出库 2》独立难度入口，不复用旧版卡车的控制器、关卡或资源。 */
    private _showTruckEscape2DifficultySelect() {
        this._disposeCurrentView();
        const view = new Node('TruckEscape2DifficultyView');
        view.layer = this.node.layer;
        view.parent = this.node;
        view.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        view.setPosition(0, 0, 0);

        const bg = new Node('TruckEscape2DifficultyBackground');
        bg.layer = view.layer;
        bg.parent = view;
        bg.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        const bgGfx = bg.addComponent(Graphics);
        bgGfx.fillColor = new Color(31, 47, 37, 255);
        bgGfx.rect(-VIEWPORT_WIDTH / 2, -VIEWPORT_HEIGHT / 2, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        bgGfx.fill();

        const titleNode = new Node('Title');
        titleNode.layer = view.layer;
        titleNode.parent = view;
        titleNode.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, 70);
        titleNode.setPosition(0, VIEWPORT_HEIGHT / 2 - 110, 0);
        const title = titleNode.addComponent(Label);
        title.string = '卡车出库 2';
        title.fontSize = 44;
        title.lineHeight = 52;
        title.isBold = true;
        title.color = new Color(250, 250, 248, 255);
        title.horizontalAlign = Label.HorizontalAlign.CENTER;
        title.verticalAlign = Label.VerticalAlign.CENTER;

        const subtitleNode = new Node('Subtitle');
        subtitleNode.layer = view.layer;
        subtitleNode.parent = view;
        subtitleNode.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, 38);
        subtitleNode.setPosition(0, VIEWPORT_HEIGHT / 2 - 160, 0);
        const subtitle = subtitleNode.addComponent(Label);
        subtitle.string = '滑动车辆 · 清理出口通道';
        subtitle.fontSize = 20;
        subtitle.lineHeight = 26;
        subtitle.color = new Color(211, 218, 211, 255);
        subtitle.horizontalAlign = Label.HorizontalAlign.CENTER;
        subtitle.verticalAlign = Label.VerticalAlign.CENTER;

        this._buildDifficultyCard(
            view,
            '简单',
            '截图复刻关卡 · 棋盘尺寸随关卡变化',
            new Color(207, 118, 153, 255),
            165,
            () => this._showTruckEscape2Game('easy'),
        );
        this._buildDifficultyCard(
            view,
            '中等',
            '全新 10 关 · 5×5 至 7×7 可变棋盘',
            new Color(173, 139, 205, 255),
            25,
            () => this._showTruckEscape2Game('medium'),
        );
        this._buildDifficultyCard(
            view,
            '困难',
            '全新 10 关 · 7×7 与 7×8 高难棋盘',
            new Color(255, 184, 34, 255),
            -115,
            () => this._showTruckEscape2Game('hard'),
        );

        const back = this._buildSmallButton(
            view,
            '返回',
            -VIEWPORT_WIDTH / 2 + 75,
            -VIEWPORT_HEIGHT / 2 + 52,
            110,
            42,
        );
        back.on(Button.EventType.CLICK, () => this._showHome(), this);

        this._viewRoot = view;
        this._currentView = 'truck2-difficulty';
        GameInspector.instance.setView('truck2-difficulty');
    }

    private _showTruckEscape2Game(
        difficulty: TruckEscape2Difficulty,
        initialLevelId: number = 1,
        directLaunchMode: boolean = false,
    ) {
        this._disposeCurrentView();
        const view = new Node('TruckEscape2GameView');
        view.layer = this.node.layer;
        view.parent = this.node;
        view.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        view.setPosition(0, 0, 0);
        const controller = view.addComponent(TruckEscape2Controller);
        controller.setDifficulty(difficulty);
        controller.setDirectLaunchMode(directLaunchMode);
        controller.setInitialLevel(initialLevelId);
        controller.onRequestExit = () => this._showTruckEscape2DifficultySelect();
        this._viewRoot = view;
        this._currentView = 'truck2';
        GameInspector.instance.setView('truck2');
    }

    /** 《螺帽与螺栓》独立五档难度入口，对应 13 张参考关卡截图。 */
    private _showNutsBoltsDifficultySelect() {
        this._disposeCurrentView();
        const viewRoot = new Node('NutsBoltsDifficultyView');
        viewRoot.layer = this.node.layer;
        viewRoot.parent = this.node;
        viewRoot.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        viewRoot.setPosition(0, 0, 0);

        const bg = new Node('Background');
        bg.layer = viewRoot.layer;
        bg.parent = viewRoot;
        bg.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        const bgGfx = bg.addComponent(Graphics);
        bgGfx.fillColor = new Color(38, 22, 58, 255);
        bgGfx.rect(-VIEWPORT_WIDTH / 2, -VIEWPORT_HEIGHT / 2, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        bgGfx.fill();
        bgGfx.fillColor = new Color(91, 57, 118, 65);
        bgGfx.circle(-170, 320, 250);
        bgGfx.fill();
        bgGfx.fillColor = new Color(13, 8, 26, 45);
        bgGfx.circle(210, -350, 300);
        bgGfx.fill();

        const titleNode = new Node('Title');
        titleNode.layer = viewRoot.layer;
        titleNode.parent = viewRoot;
        titleNode.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, 70);
        titleNode.setPosition(0, VIEWPORT_HEIGHT / 2 - 92, 0);
        const title = titleNode.addComponent(Label);
        title.string = '螺帽与螺栓';
        title.fontSize = 45;
        title.lineHeight = 54;
        title.isBold = true;
        title.color = new Color(255, 250, 255, 255);
        title.horizontalAlign = Label.HorizontalAlign.CENTER;
        title.verticalAlign = Label.VerticalAlign.CENTER;

        const subtitleNode = new Node('Subtitle');
        subtitleNode.layer = viewRoot.layer;
        subtitleNode.parent = viewRoot;
        subtitleNode.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, 36);
        subtitleNode.setPosition(0, VIEWPORT_HEIGHT / 2 - 145, 0);
        const subtitle = subtitleNode.addComponent(Label);
        subtitle.string = '选择难度 · 13 个截图复刻关卡';
        subtitle.fontSize = 19;
        subtitle.lineHeight = 24;
        subtitle.color = new Color(218, 204, 226, 255);
        subtitle.horizontalAlign = Label.HorizontalAlign.CENTER;
        subtitle.verticalAlign = Label.VerticalAlign.CENTER;

        this._buildDifficultyCard(
            viewRoot, '简单', '基础容量与两色配对', new Color(94, 174, 107, 255), 220,
            () => this._showNutsBoltsGame('easy'),
        );
        this._buildDifficultyCard(
            viewRoot, '中等', '更多颜色与五层螺栓', new Color(73, 164, 213, 255), 95,
            () => this._showNutsBoltsGame('medium'),
        );
        this._buildDifficultyCard(
            viewRoot, '困难', '高容量密集排列', new Color(222, 121, 63, 255), -30,
            () => this._showNutsBoltsGame('hard'),
        );
        this._buildDifficultyCard(
            viewRoot, '超难', '最多十五种颜色挑战', new Color(151, 77, 183, 255), -155,
            () => this._showNutsBoltsGame('extreme'),
        );
        this._buildDifficultyCard(
            viewRoot, '极难', '九色八层终极挑战', new Color(190, 57, 91, 255), -280,
            () => this._showNutsBoltsGame('nightmare'),
        );

        const back = this._buildSmallButton(
            viewRoot,
            '返回',
            -VIEWPORT_WIDTH / 2 + 75,
            -VIEWPORT_HEIGHT / 2 + 42,
            110,
            42,
        );
        back.on(Button.EventType.CLICK, () => this._showHome(), this);

        this._viewRoot = viewRoot;
        this._currentView = 'nuts-bolts-difficulty';
        GameInspector.instance.setView('nuts-bolts-difficulty');
    }

    private _showNutsBoltsGame(
        difficulty: NutsBoltsDifficulty,
        initialLevelId: number = 1,
        directLaunchMode: boolean = false,
    ) {
        this._disposeCurrentView();
        const viewRoot = new Node('NutsBoltsGameView');
        viewRoot.layer = this.node.layer;
        viewRoot.parent = this.node;
        viewRoot.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        viewRoot.setPosition(0, 0, 0);
        const controller = viewRoot.addComponent(NutsBoltsController);
        controller.setDifficulty(difficulty);
        controller.setDirectLaunchMode(directLaunchMode);
        controller.setInitialLevel(initialLevelId);
        controller.onRequestExit = () => this._showNutsBoltsDifficultySelect();
        this._viewRoot = viewRoot;
        this._currentView = 'nuts-bolts';
        GameInspector.instance.setView('nuts-bolts');
    }

    /** 《迷宫涂色》三档难度入口，每档对应一组截图复刻关卡。 */
    private _showMazePaintDifficultySelect() {
        this._disposeCurrentView();
        const viewRoot = new Node('MazePaintDifficultyView');
        viewRoot.layer = this.node.layer;
        viewRoot.parent = this.node;
        viewRoot.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        viewRoot.setPosition(0, 0, 0);

        const bg = new Node('Background');
        bg.layer = viewRoot.layer;
        bg.parent = viewRoot;
        bg.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        const bgGfx = bg.addComponent(Graphics);
        bgGfx.fillColor = new Color(26, 58, 72, 255);
        bgGfx.rect(-VIEWPORT_WIDTH / 2, -VIEWPORT_HEIGHT / 2, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        bgGfx.fill();
        bgGfx.fillColor = new Color(71, 164, 178, 55);
        bgGfx.circle(-190, 320, 260);
        bgGfx.fill();
        bgGfx.fillColor = new Color(9, 29, 38, 55);
        bgGfx.circle(220, -330, 310);
        bgGfx.fill();

        const titleNode = new Node('Title');
        titleNode.layer = viewRoot.layer;
        titleNode.parent = viewRoot;
        titleNode.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, 70);
        titleNode.setPosition(0, VIEWPORT_HEIGHT / 2 - 105, 0);
        const title = titleNode.addComponent(Label);
        title.string = '迷宫涂色';
        title.fontSize = 45;
        title.lineHeight = 54;
        title.isBold = true;
        title.color = new Color(248, 253, 252, 255);
        title.horizontalAlign = Label.HorizontalAlign.CENTER;
        title.verticalAlign = Label.VerticalAlign.CENTER;

        const subtitleNode = new Node('Subtitle');
        subtitleNode.layer = viewRoot.layer;
        subtitleNode.parent = viewRoot;
        subtitleNode.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, 36);
        subtitleNode.setPosition(0, VIEWPORT_HEIGHT / 2 - 158, 0);
        const subtitle = subtitleNode.addComponent(Label);
        subtitle.string = '滑动小球 · 涂满所有可通行方格';
        subtitle.fontSize = 19;
        subtitle.lineHeight = 24;
        subtitle.color = new Color(210, 230, 231, 255);
        subtitle.horizontalAlign = Label.HorizontalAlign.CENTER;
        subtitle.verticalAlign = Label.VerticalAlign.CENTER;

        this._buildDifficultyCard(
            viewRoot, '简单', '入门迷宫 · 基础滑行路径', new Color(88, 180, 132, 255), 165,
            () => this._showMazePaintGame('easy'),
        );
        this._buildDifficultyCard(
            viewRoot, '中等', '复合迷宫 · 规划涂色顺序', new Color(71, 164, 213, 255), 25,
            () => this._showMazePaintGame('medium'),
        );
        this._buildDifficultyCard(
            viewRoot, '困难', '大型迷宫 · 高效完成覆盖', new Color(224, 126, 76, 255), -115,
            () => this._showMazePaintGame('hard'),
        );

        const back = this._buildSmallButton(
            viewRoot, '返回', -VIEWPORT_WIDTH / 2 + 75, -VIEWPORT_HEIGHT / 2 + 52, 110, 42,
        );
        back.on(Button.EventType.CLICK, () => this._showHome(), this);

        this._viewRoot = viewRoot;
        this._currentView = 'maze-paint-difficulty';
        GameInspector.instance.setView('maze-paint-difficulty');
    }

    private _showMazePaintGame(
        difficulty: MazePaintDifficulty,
        initialLevelId: number = 1,
        directLaunchMode: boolean = false,
    ) {
        this._disposeCurrentView();
        const viewRoot = new Node('MazePaintGameView');
        viewRoot.layer = this.node.layer;
        viewRoot.parent = this.node;
        viewRoot.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        viewRoot.setPosition(0, 0, 0);
        const controller = viewRoot.addComponent(MazePaintController);
        controller.setDifficulty(difficulty);
        controller.setDirectLaunchMode(directLaunchMode);
        controller.setInitialLevel(initialLevelId);
        controller.onRequestExit = () => this._showMazePaintDifficultySelect();
        this._viewRoot = viewRoot;
        this._currentView = 'maze-paint';
        GameInspector.instance.setView('maze-paint');
    }

    /** 《颜色连线》两档截图关卡入口。 */
    private _showColorConnectDifficultySelect() {
        this._disposeCurrentView();
        const viewRoot = new Node('ColorConnectDifficultyView');
        viewRoot.layer = this.node.layer;
        viewRoot.parent = this.node;
        viewRoot.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        viewRoot.setPosition(0, 0, 0);

        const bg = new Node('Background');
        bg.layer = viewRoot.layer;
        bg.parent = viewRoot;
        bg.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        const bgGfx = bg.addComponent(Graphics);
        bgGfx.fillColor = new Color(42, 49, 58, 255);
        bgGfx.rect(-VIEWPORT_WIDTH / 2, -VIEWPORT_HEIGHT / 2, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        bgGfx.fill();
        bgGfx.fillColor = new Color(218, 116, 155, 42);
        bgGfx.circle(-205, 325, 255);
        bgGfx.fill();
        bgGfx.fillColor = new Color(18, 23, 29, 72);
        bgGfx.circle(225, -340, 315);
        bgGfx.fill();

        const titleNode = new Node('Title');
        titleNode.layer = viewRoot.layer;
        titleNode.parent = viewRoot;
        titleNode.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, 70);
        titleNode.setPosition(0, VIEWPORT_HEIGHT / 2 - 112, 0);
        const title = titleNode.addComponent(Label);
        title.string = '颜色连线';
        title.fontSize = 46;
        title.lineHeight = 54;
        title.isBold = true;
        title.color = new Color(255, 255, 255, 255);
        title.horizontalAlign = Label.HorizontalAlign.CENTER;
        title.verticalAlign = Label.VerticalAlign.CENTER;

        const subtitleNode = new Node('Subtitle');
        subtitleNode.layer = viewRoot.layer;
        subtitleNode.parent = viewRoot;
        subtitleNode.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, 36);
        subtitleNode.setPosition(0, VIEWPORT_HEIGHT / 2 - 166, 0);
        const subtitle = subtitleNode.addComponent(Label);
        subtitle.string = '从端点拖动 · 连接所有同色圆点';
        subtitle.fontSize = 19;
        subtitle.lineHeight = 24;
        subtitle.color = new Color(220, 225, 232, 255);
        subtitle.horizontalAlign = Label.HorizontalAlign.CENTER;
        subtitle.verticalAlign = Label.VerticalAlign.CENTER;

        this._buildDifficultyCard(
            viewRoot, '简单', '基础棋盘 · 熟悉路径规划', new Color(91, 185, 126, 255), 120,
            () => this._showColorConnectGame('easy'),
        );
        this._buildDifficultyCard(
            viewRoot, '困难', '大型棋盘 · 多色避让挑战', new Color(218, 116, 155, 255), -35,
            () => this._showColorConnectGame('hard'),
        );

        const back = this._buildSmallButton(
            viewRoot, '返回', -VIEWPORT_WIDTH / 2 + 75, -VIEWPORT_HEIGHT / 2 + 52, 110, 42,
        );
        back.on(Button.EventType.CLICK, () => this._showHome(), this);

        this._viewRoot = viewRoot;
        this._currentView = 'color-connect-difficulty';
        GameInspector.instance.setView('color-connect-difficulty');
    }

    private _showColorConnectGame(
        difficulty: ColorConnectDifficulty,
        initialLevelId: number = 1,
        directLaunchMode: boolean = false,
    ) {
        this._disposeCurrentView();
        const viewRoot = new Node('ColorConnectGameView');
        viewRoot.layer = this.node.layer;
        viewRoot.parent = this.node;
        viewRoot.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        viewRoot.setPosition(0, 0, 0);
        const controller = viewRoot.addComponent(ColorConnectController);
        controller.setDifficulty(difficulty);
        controller.setDirectLaunchMode(directLaunchMode);
        controller.setInitialLevel(initialLevelId);
        controller.onRequestExit = () => this._showHome();
        this._viewRoot = viewRoot;
        this._currentView = 'color-connect';
        GameInspector.instance.setView('color-connect');
    }

    /** 在 BoltGame 视图右下角加一个 “主菜单” 按钮（不修改 LevelController） */
    private _addBackToMenuButton(parent: Node) {
        // 延迟到下一帧再添加，避免 LevelController 的 HUD 把它盖住
        this.scheduleOnce(() => {
            if (!parent || !parent.isValid) return;
            const n = new Node('BackToHomeBtn');
            n.layer = parent.layer;
            n.parent = parent;
            n.addComponent(UITransform).setContentSize(110, 38);
            // 屏幕坐标：右下角附近
            n.setPosition(VIEWPORT_WIDTH / 2 - 80, -VIEWPORT_HEIGHT / 2 + 40, 0);

            const g = n.addComponent(Graphics);
            g.fillColor = new Color(196, 142, 73, 255);
            g.roundRect(-55, -19, 110, 38, 8);
            g.fill();
            g.lineWidth = 2;
            g.strokeColor = new Color(115, 71, 36, 255);
            g.roundRect(-55, -19, 110, 38, 8);
            g.stroke();

            const lblNode = new Node('Lbl');
            lblNode.layer = n.layer;
            lblNode.parent = n;
            lblNode.addComponent(UITransform).setContentSize(110, 38);
            const lbl = lblNode.addComponent(Label);
            lbl.fontSize = 18;
            lbl.lineHeight = 22;
            lbl.string = '主菜单';
            lbl.color = new Color(40, 22, 10, 255);
            lbl.horizontalAlign = Label.HorizontalAlign.CENTER;
            lbl.verticalAlign = Label.VerticalAlign.CENTER;

            n.addComponent(Button);
            n.on(Button.EventType.CLICK, () => this._showHome(), this);
        }, 0);
    }
}

/** 启动场景 bootstrap：构建 Canvas / Camera / GameRoot，并锁定 9:16 设计分辨率 */
function bootstrap() {
    const scene = director.getScene();
    if (!scene) return;

    // 锁定 540×960 (9:16) 设计分辨率：使用 SHOW_ALL 在不同设备屏幕上等比缩放后留黑边，
    // 确保游戏画面始终是竖屏 9:16 比例，不会被拉伸或裁切。
    try {
        view.setDesignResolutionSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, ResolutionPolicy.SHOW_ALL);
        // 兼容窗口 resize：监听屏幕尺寸变化重新应用分辨率策略
        screen.on('window-resize', () => {
            view.setDesignResolutionSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, ResolutionPolicy.SHOW_ALL);
        }, undefined);
    } catch (_) {
        // 某些早期初始化阶段 view 可能未就绪，忽略
    }

    let canvas: Node | null = scene.getChildByName('Canvas');
    if (!canvas) {
        canvas = new Node('Canvas');
        canvas.layer = Layers.Enum.UI_2D;
        canvas.parent = scene;
        const ui = canvas.addComponent(UITransform);
        ui.setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        ui.setAnchorPoint(0.5, 0.5);
    }
    if (!canvas.getComponent(UITransform)) {
        canvas.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    }
    if (!canvas.getComponent(Canvas)) {
        canvas.addComponent(Canvas);
    }

    let cameraNode = canvas.getChildByName('Camera');
    if (!cameraNode) {
        cameraNode = new Node('Camera');
        cameraNode.layer = Layers.Enum.UI_2D;
        cameraNode.parent = canvas;
    }
    let camera = cameraNode.getComponent(Camera);
    if (!camera) {
        camera = cameraNode.addComponent(Camera);
        camera.projection = Camera.ProjectionType.ORTHO;
        camera.priority = 1073741824;
        camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        camera.clearColor = new Color(82, 56, 36, 255);
        camera.visibility = Layers.Enum.UI_2D;
        camera.orthoHeight = VIEWPORT_HEIGHT / 2;
        camera.near = -1000;
        camera.far = 1000;
        cameraNode.setPosition(0, 0, 1000);
    }
    const canvasComp = canvas.getComponent(Canvas)!;
    (canvasComp as any).cameraComponent = camera;

    let gameRoot = canvas.getChildByName('GameRoot');
    if (!gameRoot) {
        gameRoot = new Node('GameRoot');
        gameRoot.layer = Layers.Enum.UI_2D;
        gameRoot.parent = canvas;
        gameRoot.setPosition(0, 0, 0);
        gameRoot.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    }
    if (!gameRoot.getComponent(GameMain)) {
        gameRoot.addComponent(GameMain);
    }
}

director.on(Director.EVENT_AFTER_SCENE_LAUNCH, () => {
    setTimeout(bootstrap, 0);
});
setTimeout(bootstrap, 0);
