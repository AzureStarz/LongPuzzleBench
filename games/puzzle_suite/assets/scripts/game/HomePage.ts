import {
    _decorator,
    Component,
    Node,
    UITransform,
    Label,
    Color,
    Graphics,
    Button,
    Vec3,
} from 'cc';
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from '../data/LevelData';

const { ccclass } = _decorator;

/** 主菜单上一个游戏入口的元数据 */
export interface GameEntry {
    id: string;
    name: string;
    description: string;
    /** 入口右下角的角标颜色，纯装饰 */
    accent: Color;
}

/** 注册到主菜单的所有游戏列表 */
export const GAME_ENTRIES: GameEntry[] = [
    {
        id: 'bolt',
        name: '螺丝专家',
        description: '搬螺丝拆木条 · 物理解谜',
        accent: new Color(196, 142, 73, 255),
    },
    {
        id: 'truck',
        name: '卡车出库',
        description: '看准方向 · 一路开走',
        accent: new Color(220, 110, 90, 255),
    },
    {
        id: 'truck2',
        name: '卡车出库 2',
        description: '滑动车辆 · 为红车清理出口',
        accent: new Color(207, 118, 153, 255),
    },
    {
        id: 'nuts-bolts',
        name: '螺帽与螺栓',
        description: '整理彩色螺帽 · 逐层配对',
        accent: new Color(145, 87, 187, 255),
    },
    {
        id: 'maze-paint',
        name: '迷宫涂色',
        description: '滑动小球 · 涂满迷宫',
        accent: new Color(71, 164, 178, 255),
    },
    {
        id: 'color-connect',
        name: '颜色连线',
        description: '连接同色端点 · 路径不可交叉',
        accent: new Color(218, 116, 155, 255),
    },
];

/**
 * 《工地我最牛》主页：标题 + 游戏入口列表。
 * 选中某个入口后通过 onSelectGame 回调通知 GameMain 切换。
 */
@ccclass('HomePage')
export class HomePage extends Component {
    public onSelectGame: ((id: string) => void) | null = null;

    start() {
        this._build();
    }

    private _build() {
        const root = this.node;
        const ui = root.getComponent(UITransform) ?? root.addComponent(UITransform);
        ui.setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        ui.setAnchorPoint(0.5, 0.5);

        // 背景：暖橙渐近色（用纯色矩形 + 顶部装饰条）
        const bg = new Node('Bg');
        bg.layer = root.layer;
        bg.parent = root;
        bg.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        const bgGfx = bg.addComponent(Graphics);
        bgGfx.fillColor = new Color(252, 220, 150, 255);
        bgGfx.rect(-VIEWPORT_WIDTH / 2, -VIEWPORT_HEIGHT / 2, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
        bgGfx.fill();
        // 顶部一条棕色色带
        bgGfx.fillColor = new Color(115, 71, 36, 255);
        bgGfx.rect(-VIEWPORT_WIDTH / 2, VIEWPORT_HEIGHT / 2 - 200, VIEWPORT_WIDTH, 200);
        bgGfx.fill();
        // 底部一条草绿色色带
        bgGfx.fillColor = new Color(140, 178, 110, 255);
        bgGfx.rect(-VIEWPORT_WIDTH / 2, -VIEWPORT_HEIGHT / 2, VIEWPORT_WIDTH, 80);
        bgGfx.fill();

        // 主标题：工地我最牛
        const titleNode = new Node('Title');
        titleNode.layer = root.layer;
        titleNode.parent = root;
        titleNode.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, 80);
        titleNode.setPosition(0, VIEWPORT_HEIGHT / 2 - 110, 0);
        const titleLbl = titleNode.addComponent(Label);
        titleLbl.fontSize = 56;
        titleLbl.lineHeight = 64;
        titleLbl.string = '工地我最牛';
        titleLbl.color = new Color(255, 240, 200, 255);
        titleLbl.horizontalAlign = Label.HorizontalAlign.CENTER;
        titleLbl.verticalAlign = Label.VerticalAlign.CENTER;
        titleLbl.isBold = true;

        // 副标题
        const subNode = new Node('Subtitle');
        subNode.layer = root.layer;
        subNode.parent = root;
        subNode.addComponent(UITransform).setContentSize(VIEWPORT_WIDTH, 30);
        subNode.setPosition(0, VIEWPORT_HEIGHT / 2 - 165, 0);
        const subLbl = subNode.addComponent(Label);
        subLbl.fontSize = 20;
        subLbl.lineHeight = 24;
        subLbl.string = '一个工地小游戏合集';
        subLbl.color = new Color(255, 240, 200, 220);
        subLbl.horizontalAlign = Label.HorizontalAlign.CENTER;

        // 游戏入口列表
        const listTop = VIEWPORT_HEIGHT / 2 - 250;     // 列表第一项的顶部
        // Six entries still fit above the bottom decorative strip. Keep the
        // original roomy cards for shorter registries and compact only when
        // the Hub grows beyond five games.
        const compact = GAME_ENTRIES.length > 5;
        const itemH = compact ? 94 : 110;
        const itemGap = compact ? 12 : 22;
        const itemW = VIEWPORT_WIDTH - 80;             // 左右各留 40
        for (let i = 0; i < GAME_ENTRIES.length; i++) {
            const entry = GAME_ENTRIES[i];
            const yCenter = listTop - itemH / 2 - i * (itemH + itemGap);
            this._buildEntry(root, entry, yCenter, itemW, itemH);
        }
    }

    private _buildEntry(parent: Node, entry: GameEntry, yCenter: number, w: number, h: number) {
        const n = new Node(`Entry_${entry.id}`);
        n.layer = parent.layer;
        n.parent = parent;
        n.setPosition(0, yCenter, 0);
        n.addComponent(UITransform).setContentSize(w, h);

        // 卡片背景
        const g = n.addComponent(Graphics);
        g.fillColor = new Color(255, 248, 230, 255);
        g.roundRect(-w / 2, -h / 2, w, h, 18);
        g.fill();
        g.lineWidth = 3;
        g.strokeColor = new Color(115, 71, 36, 255);
        g.roundRect(-w / 2, -h / 2, w, h, 18);
        g.stroke();

        // 左侧装饰色块
        const accentW = 14;
        g.fillColor = entry.accent;
        g.roundRect(-w / 2 + 12, -h / 2 + 12, accentW, h - 24, 6);
        g.fill();

        // 游戏名称
        const nameNode = new Node('Name');
        nameNode.layer = n.layer;
        nameNode.parent = n;
        nameNode.addComponent(UITransform).setContentSize(w - 80, 40);
        nameNode.setPosition(20, 18, 0);
        const nameLbl = nameNode.addComponent(Label);
        nameLbl.fontSize = 30;
        nameLbl.lineHeight = 36;
        nameLbl.string = entry.name;
        nameLbl.color = new Color(70, 40, 16, 255);
        nameLbl.horizontalAlign = Label.HorizontalAlign.LEFT;
        nameLbl.verticalAlign = Label.VerticalAlign.CENTER;
        nameLbl.isBold = true;

        // 描述
        const descNode = new Node('Desc');
        descNode.layer = n.layer;
        descNode.parent = n;
        descNode.addComponent(UITransform).setContentSize(w - 80, 28);
        descNode.setPosition(20, -20, 0);
        const descLbl = descNode.addComponent(Label);
        descLbl.fontSize = 18;
        descLbl.lineHeight = 22;
        descLbl.string = entry.description;
        descLbl.color = new Color(120, 90, 60, 255);
        descLbl.horizontalAlign = Label.HorizontalAlign.LEFT;
        descLbl.verticalAlign = Label.VerticalAlign.CENTER;

        // 右侧 “开始” 角标
        const goNode = new Node('Go');
        goNode.layer = n.layer;
        goNode.parent = n;
        goNode.addComponent(UITransform).setContentSize(80, 40);
        goNode.setPosition(w / 2 - 60, 0, 0);
        const goGfx = goNode.addComponent(Graphics);
        goGfx.fillColor = entry.accent;
        goGfx.roundRect(-40, -20, 80, 40, 10);
        goGfx.fill();
        const goLblNode = new Node('GoLbl');
        goLblNode.layer = n.layer;
        goLblNode.parent = goNode;
        goLblNode.addComponent(UITransform).setContentSize(80, 40);
        const goLbl = goLblNode.addComponent(Label);
        goLbl.fontSize = 20;
        goLbl.lineHeight = 24;
        goLbl.string = '开始 ▶';
        goLbl.color = new Color(255, 255, 255, 255);
        goLbl.horizontalAlign = Label.HorizontalAlign.CENTER;
        goLbl.verticalAlign = Label.VerticalAlign.CENTER;

        // 整张卡片可点击；点击后立即"消费"回调 + 隐藏整页，再延迟一帧把事件传出去，
        // 避免本帧内剩余的事件分发逻辑还能命中已被销毁但尚未真正移除的节点。
        const btn = n.addComponent(Button);
        n.on(Button.EventType.CLICK, () => {
            const cb = this.onSelectGame;
            if (!cb) return;
            this.onSelectGame = null;
            this._disableAllButtons();
            // 立刻隐藏整个主菜单，避免在 GameMain 切换视图之前还能再触发任何按钮
            if (this.node && this.node.isValid) {
                this.node.active = false;
            }
            // 延迟一帧再触发 GameMain 的视图切换，确保本帧事件分发完全结束
            this.scheduleOnce(() => cb(entry.id), 0);
        }, this);
        void btn;
    }

    /** 把当前页所有 Button 都标记为不可交互，并卸下 CLICK 监听 */
    private _disableAllButtons() {
        const visit = (n: Node) => {
            if (!n || !n.isValid) return;
            const b = n.getComponent(Button);
            if (b) b.interactable = false;
            n.off(Button.EventType.CLICK);
            n.off(Node.EventType.TOUCH_END);
            n.off(Node.EventType.TOUCH_START);
            for (const c of n.children) visit(c);
        };
        visit(this.node);
    }
}
