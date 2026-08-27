import {
    TruckColor,
    TruckDirection,
    TruckLevelData,
    TruckSpawn,
} from './TruckLevelData';

const UP = TruckDirection.UP;
const DOWN = TruckDirection.DOWN;
const LEFT = TruckDirection.LEFT;
const RIGHT = TruckDirection.RIGHT;

const ALL_DIRS: TruckDirection[] = [UP, DOWN, LEFT, RIGHT];
const ALL_COLORS: TruckColor[] = ['yellow', 'red', 'blue', 'gray_green'];

/**
 * 一辆卡车在「网格关卡」中的描述。
 *
 * 卡车长边沿其朝向占据 2 个相邻单元（锚点 + 朝向方向上的下一个单元）：
 *   UP    锚点 (col, row) 与 (col,   row-1)
 *   DOWN  锚点 (col, row) 与 (col,   row+1)
 *   LEFT  锚点 (col, row) 与 (col-1, row)
 *   RIGHT 锚点 (col, row) 与 (col+1, row)
 *
 * 锚点 = 卡车的"车尾"单元；朝向方向上的相邻单元 = "车头"单元。
 */
export interface TruckGridSpec {
    id: string;
    col: number;
    row: number;
    color: TruckColor;
    direction: TruckDirection;
}

function dirStep(dir: TruckDirection): { dCol: number; dRow: number } {
    switch (dir) {
        case UP:    return { dCol:  0, dRow: -1 };
        case DOWN:  return { dCol:  0, dRow:  1 };
        case LEFT:  return { dCol: -1, dRow:  0 };
        case RIGHT: return { dCol:  1, dRow:  0 };
    }
}

/**
 * 把网格描述编译成 TruckLevelData。
 *  - cellSize：单元像素大小（每辆车长 = 2 * cellSize）
 *  - cols / rows：网格大小
 *  - trucks：卡车列表（trucks[0] 应为关卡设计上"最先可消除"的车）
 */
export function gridLevel(
    title: string,
    instruction: string,
    cols: number,
    rows: number,
    cellSize: number,
    trucks: TruckGridSpec[],
): TruckLevelData {
    const truckLength = cellSize * 2;
    const truckWidth = Math.round(cellSize * 0.85);
    const fieldWidth = cols * cellSize;
    const fieldHeight = rows * cellSize;

    const occupied = new Map<string, string>();
    const occupy = (col: number, row: number, id: string) => {
        const k = `${col},${row}`;
        if (occupied.has(k)) {
            console.warn(`[gridLevel] 关卡「${title}」单元 (${col},${row}) 被多辆车占据：${occupied.get(k)} 与 ${id}`);
        }
        occupied.set(k, id);
    };

    const out: TruckSpawn[] = trucks.map((t) => {
        const { dCol, dRow } = dirStep(t.direction);
        if (t.col < 0 || t.col >= cols || t.row < 0 || t.row >= rows
            || t.col + dCol < 0 || t.col + dCol >= cols
            || t.row + dRow < 0 || t.row + dRow >= rows) {
            console.warn(`[gridLevel] 关卡「${title}」卡车 ${t.id} 占位越界 (${t.col},${t.row})→(${t.col + dCol},${t.row + dRow})，网格 ${cols}×${rows}`);
        }
        // 卡车中心 = 两个单元中心的中点
        const ax = (t.col + 0.5) * cellSize;
        const ay = (t.row + 0.5) * cellSize;
        const cx = ax + dCol * 0.5 * cellSize;
        const cy = ay + dRow * 0.5 * cellSize;
        occupy(t.col, t.row, t.id);
        occupy(t.col + dCol, t.row + dRow, t.id);
        return {
            id: t.id,
            x: cx, y: cy,
            color: t.color,
            direction: t.direction,
        };
    });

    return {
        title, instruction,
        fieldWidth, fieldHeight,
        truckLength, truckWidth,
        trucks: out,
    };
}

// ────────────────────────────────────────────────────────────────────────
// 关卡自动生成（保证可解）
// ────────────────────────────────────────────────────────────────────────

/**
 * 一个简单确定性伪随机数（mulberry32），关卡每次构建结果一致，便于调试。
 */
function makeRng(seed: number): () => number {
    let a = seed | 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * 正向构造法生成可解 + 有难度的关卡：
 *
 * 不变式：放置顺序 = 消除顺序。trucks[0] 是第一个消除的车，trucks[N-1] 最后消除。
 *
 * 放置 trucks[i] 时（trucks[0..i-1] 已放置在场上）：
 *   (a) 它占的 2 单元未被任何已放置车占据。
 *   (b) 它占的 2 单元不在任何已放置车的路径上 ——
 *       因为已放置车 trucks[j<i] 是「比它先消除」的车，
 *       它消除的时刻 trucks[j] 已离场；但 trucks[i] 自己消除前一直在场上，
 *       会一直占着这 2 单元。如果这 2 单元在 trucks[j] 的路径上，
 *       那 trucks[j] 永远开不出去 → 不可解。
 *   (c) 软约束 — 它自己的路径上至少有一辆已放置车 trucks[j<i]，
 *       这样它一开始就被 trucks[j] 阻挡（增加关卡难度）；
 *       但允许第一辆 (i=0) 没有阻挡（它本来就要先消除）。
 *
 * 路径概念：从车头单元 (c2, r2) 沿朝向方向到边界的所有单元，**不含车头本身**。
 *   - 当 trucks[i] 消除时它整辆车都从场上离开 → 它的占位 (col,row),(c2,r2) 也不再阻挡。
 *   - 路径上的车（在它前方）必须比它**先**消除 → 即 trucks[j<i]。
 *
 * 难度调控：候选评分公式，鼓励"路径上有阻挡 + 中心位置"。
 */
function generateSolvableLevel(
    title: string,
    instruction: string,
    cols: number,
    rows: number,
    cellSize: number,
    targetCount: number,
    seed: number,
): TruckLevelData {
    const occ: boolean[][] = Array.from({ length: cols }, () => new Array(rows).fill(false));
    const pathMark: boolean[][] = Array.from({ length: cols }, () => new Array(rows).fill(false));
    let rng: () => number = makeRng(seed);

    function pathCellsForward(col: number, row: number, dir: TruckDirection): { c: number; r: number }[] {
        const { dCol, dRow } = dirStep(dir);
        const out: { c: number; r: number }[] = [];
        let c = col + dCol;
        let r = row + dRow;
        while (c >= 0 && c < cols && r >= 0 && r < rows) {
            out.push({ c, r });
            c += dCol;
            r += dRow;
        }
        return out;
    }

    type Placed = { col: number; row: number; dir: TruckDirection };
    const placed: Placed[] = [];

    /** 检查候选车 (col, row, dir) 是否可放置；并返回它的路径上有多少辆已放置车（阻挡数） */
    function evaluate(col: number, row: number, dir: TruckDirection): { ok: boolean; blockers: number; pathLen: number } {
        const { dCol, dRow } = dirStep(dir);
        const c2 = col + dCol;
        const r2 = row + dRow;
        if (col < 0 || col >= cols || row < 0 || row >= rows) return { ok: false, blockers: 0, pathLen: 0 };
        if (c2 < 0 || c2 >= cols || r2 < 0 || r2 >= rows) return { ok: false, blockers: 0, pathLen: 0 };
        // (a) 2 单元未被占
        if (occ[col][row] || occ[c2][r2]) return { ok: false, blockers: 0, pathLen: 0 };
        // (b) 2 单元不能在已放置车路径上
        if (pathMark[col][row] || pathMark[c2][r2]) return { ok: false, blockers: 0, pathLen: 0 };
        // 自己的路径数 + 已放置车在路径上的数量（阻挡数）
        const path = pathCellsForward(c2, r2, dir);
        let blockers = 0;
        for (const p of path) {
            if (occ[p.c][p.r]) blockers++;
        }
        return { ok: true, blockers, pathLen: path.length };
    }

    function place(col: number, row: number, dir: TruckDirection) {
        const { dCol, dRow } = dirStep(dir);
        const c2 = col + dCol;
        const r2 = row + dRow;
        occ[col][row] = true;
        occ[c2][r2] = true;
        // 标记路径上所有单元（这些单元不能再被新车占用）
        const path = pathCellsForward(c2, r2, dir);
        for (const p of path) pathMark[p.c][p.r] = true;
        placed.push({ col, row, dir });
    }

    /**
     * 评分逻辑：所有阶段都偏好"中心"+"短路径"。
     *  - 强制约束：**短路径**（pathLen ≤ 6）—— 避免一辆车的路径占满半个场地。
     *  - 早期车（ratio < 0.2，先消除）：自身路径上必须**无任何已放置车**（blockers=0），
     *    且偏好靠中心 + 路径短（路径短意味着距边界近，更容易 blockers=0）。
     *  - 中期车（0.2 ≤ ratio < 0.6）：blockers 1~2 较好。
     *  - 晚期车（ratio ≥ 0.6，最后消除）：blockers 越多越好（被多重阻挡）+ 必须靠中心。
     */
    function tryGenerate(): boolean {
        const cx = (cols - 1) / 2;
        const cy = (rows - 1) / 2;
        const maxDistCenter = Math.hypot(cx, cy);
        const PATH_LEN_LIMIT = 6;

        for (let i = 0; i < targetCount; i++) {
            const ratio = i / Math.max(1, targetCount - 1);
            type Cand = { col: number; row: number; dir: TruckDirection; w: number };
            const candidates: Cand[] = [];

            for (let col = 0; col < cols; col++) {
                for (let row = 0; row < rows; row++) {
                    for (const dir of ALL_DIRS) {
                        const ev = evaluate(col, row, dir);
                        if (!ev.ok) continue;
                        if (ev.pathLen > PATH_LEN_LIMIT) continue;

                        const { dCol, dRow } = dirStep(dir);
                        const mc = (col + col + dCol) / 2;
                        const mr = (row + row + dRow) / 2;
                        const dCenter = Math.hypot(mc - cx, mr - cy) / Math.max(0.0001, maxDistCenter);

                        // 中心偏好：所有阶段都强偏中心
                        const centerScore = (1 - dCenter);

                        // 阻挡偏好分阶段
                        let blockerScore: number;
                        if (ratio < 0.2) {
                            // 先消除：必须 blockers=0
                            if (ev.blockers !== 0) continue;
                            blockerScore = 0;
                        } else if (ratio < 0.6) {
                            // 中期：偏好 blockers=1
                            blockerScore = ev.blockers === 1 ? 0.4 : (ev.blockers === 2 ? 0.2 : -0.1);
                        } else {
                            // 晚期：blockers 越多越好（封顶 3）
                            blockerScore = Math.min(ev.blockers, 3) / 3 * 0.5;
                        }

                        const score = centerScore * 0.7 + blockerScore + rng() * 0.1;
                        candidates.push({ col, row, dir, w: score });
                    }
                }
            }

            if (candidates.length === 0) {
                // 兜底：放宽阻挡 / 路径长度限制再试
                for (let col = 0; col < cols; col++) {
                    for (let row = 0; row < rows; row++) {
                        for (const dir of ALL_DIRS) {
                            const ev = evaluate(col, row, dir);
                            if (!ev.ok) continue;
                            const { dCol, dRow } = dirStep(dir);
                            const mc = (col + col + dCol) / 2;
                            const mr = (row + row + dRow) / 2;
                            const dCenter = Math.hypot(mc - cx, mr - cy) / Math.max(0.0001, maxDistCenter);
                            const score = (1 - dCenter) * 0.6 + (1 / (1 + ev.pathLen)) * 0.3 + rng() * 0.1;
                            candidates.push({ col, row, dir, w: score });
                        }
                    }
                }
            }
            if (candidates.length === 0) return false;

            let pick = candidates[0];
            for (const c of candidates) {
                if (c.w > pick.w) pick = c;
            }
            place(pick.col, pick.row, pick.dir);
        }

        // 后处理：补空行 / 空列。最多 3 轮，每轮扫一遍。
        for (let pass = 0; pass < 3; pass++) {
            const colHasCar = new Array(cols).fill(false);
            const rowHasCar = new Array(rows).fill(false);
            for (let c = 0; c < cols; c++) {
                for (let r = 0; r < rows; r++) {
                    if (occ[c][r]) {
                        colHasCar[c] = true;
                        rowHasCar[r] = true;
                    }
                }
            }
            let progressed = false;
            // 空列补
            for (let c = 0; c < cols; c++) {
                if (colHasCar[c]) continue;
                for (let r = 0; r < rows; r++) {
                    let placed = false;
                    for (const dir of ALL_DIRS) {
                        const ev = evaluate(c, r, dir);
                        if (ev.ok && ev.pathLen <= PATH_LEN_LIMIT) {
                            place(c, r, dir);
                            placed = true;
                            progressed = true;
                            break;
                        }
                    }
                    if (placed) break;
                }
            }
            // 空行补
            for (let r = 0; r < rows; r++) {
                if (rowHasCar[r]) continue;
                for (let c = 0; c < cols; c++) {
                    let placed = false;
                    for (const dir of ALL_DIRS) {
                        const ev = evaluate(c, r, dir);
                        if (ev.ok && ev.pathLen <= PATH_LEN_LIMIT) {
                            place(c, r, dir);
                            placed = true;
                            progressed = true;
                            break;
                        }
                    }
                    if (placed) break;
                }
            }
            if (!progressed) break;
        }

        return true;
    }

    let success = false;
    let attempt = 0;
    while (!success && attempt < 20) {
        rng = makeRng(seed + attempt * 7919);   // 每次换种子
        for (let c = 0; c < cols; c++) {
            occ[c].fill(false);
            pathMark[c].fill(false);
        }
        placed.length = 0;
        success = tryGenerate();
        attempt++;
    }
    if (!success) {
        console.warn(`[generateSolvableLevel] 「${title}」生成 ${targetCount} 辆车失败，仅放下 ${placed.length} 辆。`);
    }

    // placed[i] 就是 trucks[i]（消除顺序 i），id 直接按放置序
    const trucks: TruckGridSpec[] = placed.map((p, i) => ({
        id: `t${i}`,
        col: p.col,
        row: p.row,
        color: ALL_COLORS[(i * 7 + (cols + rows)) % ALL_COLORS.length],
        direction: p.dir,
    }));

    return gridLevel(title, instruction, cols, rows, cellSize, trucks);
}

/**
 * 关卡集
 *
 * 第 x 关 = 10*x 辆车；网格大小随关卡递增。
 * 网格刻意紧凑，让车集中堆在中心区域。
 */
export function buildTruckLevels(): TruckLevelData[] {
    const cell = 60;
    return [
        generateSolvableLevel('第1关：开工',     '点击没被挡住的卡车让它开走。',         6, 6,  cell, 10, 1001),
        generateSolvableLevel('第2关：加塞',     '前方被挡的车开不了，先开走没被挡的。',  8, 8,  cell, 20, 1002),
        generateSolvableLevel('第3关：堵车',     '注意车头朝向，找出可以开走的那辆。',    9, 10, cell, 30, 1003),
        generateSolvableLevel('第4关：早高峰',   '密集堆叠的工地，找对清场顺序。',       10, 12, cell, 40, 1004),
        generateSolvableLevel('第5关：千车工地', '50 辆车等你清场，工地我最牛！',        11, 13, cell, 50, 1005),
    ];
}
