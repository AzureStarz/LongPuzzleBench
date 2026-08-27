import {
    Button,
    Color,
    Graphics,
    Node,
    UITransform,
    Vec3,
} from 'cc';
import type {
    NutColorId,
    NutsBoltsLevelData,
    NutsBoltsVisualSize,
} from './NutsBoltsLevelData';

export const NUTS_BOLTS_REFERENCE_WIDTH = 430;
export const NUTS_BOLTS_REFERENCE_HEIGHT = 932;
export const NUTS_BOLTS_VIEW_WIDTH = 540;
export const NUTS_BOLTS_VIEW_HEIGHT = 960;
export const NUTS_BOLTS_X_SCALE = NUTS_BOLTS_VIEW_WIDTH / NUTS_BOLTS_REFERENCE_WIDTH;
export const NUTS_BOLTS_Y_SCALE = NUTS_BOLTS_VIEW_HEIGHT / NUTS_BOLTS_REFERENCE_HEIGHT;

export interface NutVisualMetrics {
    baseWidth: number;
    baseHeight: number;
    nutWidth: number;
    nutHeight: number;
    nutStep: number;
    firstNutCenter: number;
    capBaseOffset: number;
    shaftWidth: number;
    capWidth: number;
    capHeight: number;
    selectionLift: number;
}

export interface BoltVisualRuntime {
    root: Node;
    glow: Node;
    cap: Node;
    nutNodes: Node[];
    metrics: NutVisualMetrics;
}

interface NutPalette {
    base: Color;
    light: Color;
    dark: Color;
    deep: Color;
    icon: Color;
}

const BASE_COLORS: Record<NutColorId, Color> = {
    yellow: new Color(255, 184, 0, 255),
    red: new Color(219, 24, 61, 255),
    blue: new Color(10, 102, 229, 255),
    green: new Color(10, 157, 22, 255),
    orange: new Color(255, 111, 0, 255),
    pink: new Color(244, 75, 144, 255),
    cyan: new Color(16, 183, 229, 255),
    purple: new Color(145, 18, 162, 255),
    lime: new Color(121, 192, 8, 255),
    brown: new Color(184, 69, 36, 255),
    teal: new Color(0, 99, 89, 255),
    indigo: new Color(70, 46, 182, 255),
    silver: new Color(205, 224, 222, 255),
    charcoal: new Color(66, 80, 96, 255),
    peach: new Color(230, 164, 119, 255),
};

function shade(color: Color, factor: number, alpha = color.a): Color {
    return new Color(
        Math.max(0, Math.min(255, Math.round(color.r * factor))),
        Math.max(0, Math.min(255, Math.round(color.g * factor))),
        Math.max(0, Math.min(255, Math.round(color.b * factor))),
        alpha,
    );
}

function paletteFor(color: NutColorId): NutPalette {
    const base = BASE_COLORS[color];
    return {
        base: new Color(base.r, base.g, base.b, base.a),
        light: shade(base, color === 'silver' ? 1.08 : 1.22),
        dark: shade(base, 0.78),
        deep: shade(base, 0.55),
        icon: shade(base, color === 'charcoal' ? 0.44 : 0.64),
    };
}

export function refX(screenX: number): number {
    return screenX * NUTS_BOLTS_X_SCALE - NUTS_BOLTS_VIEW_WIDTH / 2;
}

export function refY(screenY: number): number {
    return NUTS_BOLTS_VIEW_HEIGHT / 2 - screenY * NUTS_BOLTS_Y_SCALE;
}

export function getNutVisualMetrics(
    size: NutsBoltsVisualSize,
    nutStep: number,
    capBaseOffset?: number,
): NutVisualMetrics {
    const source = size === 'large'
        ? { baseW: 77, baseH: 36, nutW: 68, nutH: 50, first: 33, capBase: 49, shaftW: 25, capW: 26, capH: 17 }
        : size === 'regular'
            ? { baseW: 73, baseH: 34, nutW: 64, nutH: 47, first: 31, capBase: 46, shaftW: 23, capW: 24, capH: 16 }
            : { baseW: 64, baseH: 30, nutW: 56, nutH: 41, first: 28, capBase: 43, shaftW: 21, capW: 22, capH: 14 };
    return {
        baseWidth: source.baseW * NUTS_BOLTS_X_SCALE,
        baseHeight: source.baseH * NUTS_BOLTS_Y_SCALE,
        nutWidth: source.nutW * NUTS_BOLTS_X_SCALE,
        nutHeight: source.nutH * NUTS_BOLTS_Y_SCALE,
        nutStep: nutStep * NUTS_BOLTS_Y_SCALE,
        firstNutCenter: source.first * NUTS_BOLTS_Y_SCALE,
        capBaseOffset: (capBaseOffset ?? source.capBase) * NUTS_BOLTS_Y_SCALE,
        shaftWidth: source.shaftW * NUTS_BOLTS_X_SCALE,
        capWidth: source.capW * NUTS_BOLTS_X_SCALE,
        capHeight: source.capH * NUTS_BOLTS_Y_SCALE,
        selectionLift: (size === 'compact' ? 12 : 15) * NUTS_BOLTS_Y_SCALE,
    };
}

function polygon(g: Graphics, points: Array<[number, number]>): void {
    if (points.length === 0) return;
    g.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i][0], points[i][1]);
    g.close();
}

function ellipse(g: Graphics, cx: number, cy: number, rx: number, ry: number): void {
    const k = 0.5522847498;
    g.moveTo(cx + rx, cy);
    g.bezierCurveTo(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry);
    g.bezierCurveTo(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy);
    g.bezierCurveTo(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry);
    g.bezierCurveTo(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy);
    g.close();
}

function addGraphicsNode(parent: Node, name: string): Graphics {
    const node = new Node(name);
    node.layer = parent.layer;
    node.parent = parent;
    return node.addComponent(Graphics);
}

function drawBoltBase(parent: Node, m: NutVisualMetrics): void {
    const g = addGraphicsNode(parent, 'Base');
    const w = m.baseWidth;
    const h = m.baseHeight;
    const cy = h / 2;

    g.fillColor = new Color(20, 16, 34, 80);
    ellipse(g, 0, cy - h * 0.13, w * 0.56, h * 0.48);
    g.fill();

    g.fillColor = new Color(155, 168, 181, 255);
    g.roundRect(-w / 2, 0, w, h * 0.58, h * 0.20);
    g.fill();
    g.fillColor = new Color(205, 215, 223, 255);
    ellipse(g, 0, h * 0.58, w / 2, h * 0.42);
    g.fill();
    g.fillColor = new Color(244, 248, 250, 120);
    ellipse(g, -w * 0.12, h * 0.69, w * 0.31, h * 0.18);
    g.fill();
    g.fillColor = new Color(226, 233, 238, 255);
    ellipse(g, -w * 0.04, h * 0.62, w * 0.41, h * 0.27);
    g.fill();
    g.fillColor = new Color(190, 202, 212, 175);
    ellipse(g, w * 0.12, h * 0.24, w * 0.31, h * 0.18);
    g.fill();
}

/** Front lip is rendered after the nuts so the lowest nut visibly threads into the base. */
function drawBoltBaseFront(parent: Node, m: NutVisualMetrics): void {
    const g = addGraphicsNode(parent, 'BaseFrontLip');
    const w = m.baseWidth;
    const h = m.baseHeight;
    g.fillColor = new Color(181, 193, 203, 255);
    g.moveTo(-w * 0.50, h * 0.31);
    g.bezierCurveTo(-w * 0.49, -h * 0.03, w * 0.49, -h * 0.03, w * 0.50, h * 0.31);
    g.lineTo(w * 0.47, h * 0.48);
    g.bezierCurveTo(w * 0.26, h * 0.28, -w * 0.26, h * 0.28, -w * 0.47, h * 0.48);
    g.close();
    g.fill();
    g.lineWidth = Math.max(1.2, h * 0.055);
    g.strokeColor = new Color(236, 241, 244, 205);
    g.moveTo(-w * 0.44, h * 0.43);
    g.bezierCurveTo(-w * 0.22, h * 0.25, w * 0.22, h * 0.25, w * 0.44, h * 0.43);
    g.stroke();
}

function drawShaft(parent: Node, level: NutsBoltsLevelData, m: NutVisualMetrics): void {
    const g = addGraphicsNode(parent, 'Shaft');
    const top = m.capBaseOffset + (level.capacity - 1) * m.nutStep;
    const bottom = m.baseHeight * 0.70;
    const w = m.shaftWidth;
    const height = top - bottom + m.capHeight * 0.18;

    g.fillColor = new Color(151, 162, 173, 255);
    g.roundRect(-w / 2, bottom, w, height, w * 0.42);
    g.fill();
    g.fillColor = new Color(210, 220, 227, 255);
    g.roundRect(-w * 0.34, bottom + 1, w * 0.49, height - 2, w * 0.22);
    g.fill();
    g.fillColor = new Color(246, 249, 251, 110);
    g.roundRect(-w * 0.25, bottom + 2, w * 0.13, height - 5, w * 0.06);
    g.fill();
    g.fillColor = new Color(68, 80, 94, 58);
    g.roundRect(w * 0.22, bottom + 2, w * 0.15, height - 4, w * 0.07);
    g.fill();

    g.lineWidth = Math.max(1.2, m.capHeight * 0.10);
    const grooveGap = Math.max(6, m.nutStep * 0.31);
    for (let y = bottom + grooveGap; y < top - m.capHeight * 0.30; y += grooveGap) {
        g.strokeColor = new Color(115, 128, 143, 175);
        g.moveTo(-w * 0.46, y + 1);
        g.bezierCurveTo(-w * 0.16, y - 1, w * 0.18, y - 1, w * 0.46, y + 1);
        g.stroke();
        g.strokeColor = new Color(250, 252, 253, 150);
        g.moveTo(-w * 0.42, y + 2.3);
        g.lineTo(w * 0.32, y + 2.3);
        g.stroke();
    }
}

function drawBoltCap(parent: Node, y: number, m: NutVisualMetrics): Node {
    const node = new Node('BoltCap');
    node.layer = parent.layer;
    node.parent = parent;
    node.setPosition(0, y, 0);
    const g = node.addComponent(Graphics);
    const w = m.capWidth;
    const h = m.capHeight;

    g.fillColor = new Color(71, 83, 97, 62);
    ellipse(g, 1.2, -h * 0.10, w * 0.51, h * 0.43);
    g.fill();
    g.fillColor = new Color(168, 179, 190, 255);
    g.roundRect(-w / 2, -h * 0.24, w, h * 0.47, h * 0.15);
    g.fill();
    g.fillColor = new Color(211, 221, 228, 255);
    ellipse(g, 0, h * 0.11, w / 2, h * 0.44);
    g.fill();
    g.fillColor = new Color(236, 242, 246, 230);
    ellipse(g, -w * 0.04, h * 0.18, w * 0.39, h * 0.31);
    g.fill();
    g.fillColor = new Color(255, 255, 255, 205);
    ellipse(g, -w * 0.13, h * 0.21, w * 0.25, h * 0.18);
    g.fill();
    return node;
}

function drawNutBody(g: Graphics, color: NutColorId, w: number, h: number): void {
    const p = paletteFor(color);
    const shoulderY = h * 0.15;
    const half = w / 2;

    // Soft cast shadow anchors each thick toy-metal nut to the stack below.
    g.fillColor = new Color(13, 10, 24, 70);
    polygon(g, [
        [-half * 0.80, -h * 0.52], [half * 0.80, -h * 0.52],
        [half * 0.98, -h * 0.31], [half * 0.79, -h * 0.10], [-half * 0.79, -h * 0.10],
    ]);
    g.fill();

    // Deep lower extrusion gives the same chunky thickness as the references.
    g.fillColor = p.deep;
    polygon(g, [
        [-half * 0.92, shoulderY - h * 0.02], [-half * 0.73, h * 0.39],
        [half * 0.73, h * 0.39], [half * 0.92, shoulderY - h * 0.02],
        [half * 0.84, -h * 0.41], [half * 0.65, -h * 0.52],
        [-half * 0.65, -h * 0.52], [-half * 0.84, -h * 0.41],
    ]);
    g.fill();

    g.fillColor = p.dark;
    polygon(g, [
        [-half, shoulderY], [-half * 0.77, h * 0.43], [half * 0.77, h * 0.43],
        [half, shoulderY], [half * 0.86, -h * 0.34], [half * 0.66, -h * 0.45],
        [-half * 0.66, -h * 0.45], [-half * 0.86, -h * 0.34],
    ]);
    g.fill();

    // Main front face.
    g.fillColor = p.base;
    polygon(g, [
        [-half * 0.93, shoulderY], [-half * 0.70, h * 0.36], [half * 0.70, h * 0.36],
        [half * 0.93, shoulderY], [half * 0.79, -h * 0.32], [half * 0.62, -h * 0.41],
        [-half * 0.62, -h * 0.41], [-half * 0.79, -h * 0.32],
    ]);
    g.fill();

    // Faceted sides preserve the hex silhouette while adding rounded light.
    g.fillColor = new Color(p.deep.r, p.deep.g, p.deep.b, 88);
    polygon(g, [
        [-half * 0.93, shoulderY], [-half * 0.70, h * 0.36], [-half * 0.54, h * 0.25],
        [-half * 0.58, -h * 0.34], [-half * 0.79, -h * 0.32],
    ]);
    g.fill();
    g.fillColor = new Color(p.deep.r, p.deep.g, p.deep.b, 62);
    polygon(g, [
        [half * 0.70, h * 0.36], [half * 0.93, shoulderY], [half * 0.79, -h * 0.32],
        [half * 0.58, -h * 0.34], [half * 0.54, h * 0.25],
    ]);
    g.fill();

    // Bright bevelled top plane.
    g.fillColor = p.light;
    polygon(g, [
        [-half * 0.70, h * 0.36], [-half * 0.42, h * 0.50], [half * 0.42, h * 0.50],
        [half * 0.70, h * 0.36], [half * 0.52, shoulderY], [-half * 0.52, shoulderY],
    ]);
    g.fill();
    g.fillColor = new Color(p.base.r, p.base.g, p.base.b, 145);
    polygon(g, [
        [-half * 0.50, h * 0.31], [-half * 0.35, h * 0.42], [half * 0.35, h * 0.42],
        [half * 0.50, h * 0.31], [half * 0.39, h * 0.20], [-half * 0.39, h * 0.20],
    ]);
    g.fill();

    g.fillColor = new Color(255, 255, 255, 54);
    polygon(g, [
        [-half * 0.69, h * 0.33], [-half * 0.41, h * 0.46], [-half * 0.31, h * 0.41],
        [-half * 0.52, h * 0.26], [-half * 0.62, -h * 0.23], [-half * 0.76, -h * 0.18],
    ]);
    g.fill();
    g.fillColor = new Color(255, 255, 255, 22);
    g.roundRect(-half * 0.46, -h * 0.25, half * 0.77, h * 0.31, h * 0.08);
    g.fill();

    g.lineWidth = Math.max(1.2, h * 0.042);
    g.strokeColor = new Color(p.deep.r, p.deep.g, p.deep.b, 178);
    g.moveTo(-half * 0.61, -h * 0.38);
    g.bezierCurveTo(-half * 0.20, -h * 0.46, half * 0.24, -h * 0.46, half * 0.61, -h * 0.38);
    g.stroke();
    g.strokeColor = new Color(255, 255, 255, 48);
    g.moveTo(-half * 0.50, h * 0.19);
    g.bezierCurveTo(-half * 0.16, h * 0.12, half * 0.18, h * 0.12, half * 0.50, h * 0.19);
    g.stroke();

    // Concentric bevel + deep centre hole. The fixed bolt cap covers this when
    // aligned, while lifted/transferring nuts retain a convincing through-hole.
    g.fillColor = p.light;
    ellipse(g, 0, h * 0.29, w * 0.165, h * 0.145);
    g.fill();
    g.fillColor = p.dark;
    ellipse(g, 0, h * 0.285, w * 0.135, h * 0.115);
    g.fill();
    g.fillColor = p.deep;
    ellipse(g, 0, h * 0.275, w * 0.105, h * 0.087);
    g.fill();
    g.fillColor = new Color(255, 255, 255, 46);
    ellipse(g, -w * 0.025, h * 0.315, w * 0.060, h * 0.032);
    g.fill();
}

function drawIcon(g: Graphics, color: NutColorId, w: number, h: number): void {
    const p = paletteFor(color);
    const y = -h * 0.10;
    const r = Math.min(w * 0.12, h * 0.19);
    g.fillColor = p.icon;
    g.strokeColor = p.icon;
    g.lineWidth = Math.max(1.4, h * 0.055);

    switch (color) {
        case 'yellow': {
            g.circle(0, y, r * 0.58); g.fill();
            for (let i = 0; i < 8; i++) {
                const a = i * Math.PI / 4;
                g.moveTo(Math.cos(a) * r * 0.82, y + Math.sin(a) * r * 0.82);
                g.lineTo(Math.cos(a) * r * 1.22, y + Math.sin(a) * r * 1.22);
            }
            g.stroke();
            break;
        }
        case 'red': {
            g.moveTo(0, y - r * 0.95);
            g.bezierCurveTo(-r * 1.25, y - r * 0.15, -r * 1.15, y + r * 0.90, -r * 0.48, y + r * 0.90);
            g.bezierCurveTo(-r * 0.10, y + r * 0.90, 0, y + r * 0.55, 0, y + r * 0.40);
            g.bezierCurveTo(0, y + r * 0.55, r * 0.10, y + r * 0.90, r * 0.48, y + r * 0.90);
            g.bezierCurveTo(r * 1.15, y + r * 0.90, r * 1.25, y - r * 0.15, 0, y - r * 0.95);
            g.fill();
            break;
        }
        case 'blue': {
            g.moveTo(0, y + r * 1.15);
            g.bezierCurveTo(-r * 1.05, y + r * 0.15, -r * 0.78, y - r, 0, y - r * 1.04);
            g.bezierCurveTo(r * 0.78, y - r, r * 1.05, y + r * 0.15, 0, y + r * 1.15);
            g.fill();
            break;
        }
        case 'green': {
            g.circle(0, y + r * 0.48, r * 0.50); g.fill();
            g.circle(-r * 0.48, y, r * 0.50); g.fill();
            g.circle(r * 0.48, y, r * 0.50); g.fill();
            g.roundRect(-r * 0.13, y - r * 0.92, r * 0.26, r * 0.78, r * 0.10); g.fill();
            break;
        }
        case 'orange': {
            polygon(g, [
                [-r * 0.15, y + r * 1.12], [-r * 0.78, y + r * 0.05], [-r * 0.22, y + r * 0.08],
                [-r * 0.48, y - r * 1.08], [r * 0.78, y + r * 0.18], [r * 0.18, y + r * 0.14],
            ]);
            g.fill();
            break;
        }
        case 'pink': {
            polygon(g, [
                [-r, y + r * 0.62], [-r * 0.55, y - r * 0.75], [0, y + r * 0.18],
                [r * 0.55, y - r * 0.75], [r, y + r * 0.62], [r * 0.74, y - r * 0.82],
                [-r * 0.74, y - r * 0.82],
            ]);
            g.fill();
            break;
        }
        case 'cyan': {
            polygon(g, [
                [0, y + r], [r * 1.08, y + r * 0.35], [r * 0.58, y - r * 0.82],
                [-r * 0.58, y - r * 0.82], [-r * 1.08, y + r * 0.35],
            ]);
            g.fill();
            break;
        }
        case 'purple': {
            g.circle(0, y, r); g.fill();
            g.fillColor = p.base;
            g.circle(r * 0.43, y + r * 0.30, r * 0.88); g.fill();
            break;
        }
        case 'lime': {
            g.roundRect(-r * 0.88, y - r * 0.58, r * 1.34, r * 1.16, r * 0.25); g.fill();
            polygon(g, [[r * 0.36, y + r * 0.34], [r, y + r * 0.70], [r, y - r * 0.70], [r * 0.36, y - r * 0.34]]);
            g.fill();
            break;
        }
        case 'brown': {
            g.circle(0, y - r * 0.10, r * 0.74); g.fill();
            g.roundRect(-r, y - r * 0.62, r * 2, r * 0.55, r * 0.20); g.fill();
            break;
        }
        case 'teal': {
            g.moveTo(r * 0.48, y + r * 0.92); g.lineTo(r * 0.48, y - r * 0.45);
            g.moveTo(r * 0.48, y + r * 0.77); g.lineTo(-r * 0.24, y + r * 0.58);
            g.stroke();
            g.circle(-r * 0.34, y - r * 0.48, r * 0.43); g.fill();
            g.circle(r * 0.14, y - r * 0.25, r * 0.34); g.fill();
            break;
        }
        case 'indigo': {
            polygon(g, [[-r * 0.72, y + r], [r, y], [-r * 0.72, y - r]]); g.fill();
            break;
        }
        case 'silver': {
            const points: Array<[number, number]> = [];
            for (let i = 0; i < 10; i++) {
                const a = Math.PI / 2 + i * Math.PI / 5;
                const rr = i % 2 === 0 ? r : r * 0.45;
                points.push([Math.cos(a) * rr, y + Math.sin(a) * rr]);
            }
            polygon(g, points); g.fill();
            break;
        }
        case 'charcoal': {
            g.circle(0, y + r * 0.12, r * 0.85); g.fill();
            g.rect(-r * 0.85, y - r * 0.66, r * 1.70, r * 0.65); g.fill();
            g.fillColor = p.base;
            g.circle(-r * 0.30, y + r * 0.15, r * 0.13); g.fill();
            g.circle(r * 0.30, y + r * 0.15, r * 0.13); g.fill();
            break;
        }
        case 'peach': {
            g.lineWidth = r * 0.48;
            g.moveTo(-r * 0.63, y - r * 0.58); g.lineTo(r * 0.63, y + r * 0.58); g.stroke();
            for (const [x, yy] of [[-0.78, -0.78], [-0.46, -0.78], [0.46, 0.78], [0.78, 0.78]]) {
                g.circle(x * r, y + yy * r, r * 0.30); g.fill();
            }
            break;
        }
    }
}

export function createNutNode(
    parent: Node,
    color: NutColorId,
    metrics: NutVisualMetrics,
    name = `Nut_${color}`,
): Node {
    const node = new Node(name);
    node.layer = parent.layer;
    node.parent = parent;
    node.addComponent(UITransform).setContentSize(metrics.nutWidth, metrics.nutHeight);
    const g = node.addComponent(Graphics);
    drawNutBody(g, color, metrics.nutWidth, metrics.nutHeight);
    drawIcon(g, color, metrics.nutWidth, metrics.nutHeight);
    return node;
}

/** Metallic shaft glimpses shown only inside moving nut holes while inserting. */
export function createMovingThreadSleeves(
    parent: Node,
    count: number,
    metrics: NutVisualMetrics,
): Node {
    const root = new Node('MovingThreadSleeves');
    root.layer = parent.layer;
    root.parent = parent;
    root.active = false;
    for (let index = 0; index < count; index++) {
        const g = addGraphicsNode(root, `ThreadSleeve_${index}`);
        const y = index * metrics.nutStep + metrics.nutHeight * 0.285;
        g.fillColor = new Color(84, 97, 111, 255);
        ellipse(g, 0, y - metrics.nutHeight * 0.010, metrics.nutWidth * 0.102, metrics.nutHeight * 0.082);
        g.fill();
        g.fillColor = new Color(194, 207, 217, 255);
        ellipse(g, 0, y + metrics.nutHeight * 0.008, metrics.nutWidth * 0.088, metrics.nutHeight * 0.067);
        g.fill();
        g.fillColor = new Color(245, 249, 251, 170);
        ellipse(g, -metrics.nutWidth * 0.020, y + metrics.nutHeight * 0.030, metrics.nutWidth * 0.043, metrics.nutHeight * 0.024);
        g.fill();
    }
    return root;
}

/**
 * Fixed destination foreground. The cloned cap stays in front while a nut
 * passes over the shaft, and the cloned base lip hides the final insertion.
 */
export function createTransferForeground(
    parent: Node,
    level: NutsBoltsLevelData,
    target: BoltVisualRuntime,
): Node {
    const root = new Node('TransferOcclusionForeground');
    root.layer = parent.layer;
    root.parent = parent;
    root.setPosition(target.root.position);
    root.active = false;
    const top = target.metrics.capBaseOffset + (level.capacity - 1) * target.metrics.nutStep;
    drawBoltBaseFront(root, target.metrics);
    drawBoltCap(root, top, target.metrics);
    return root;
}

function drawSelectionGlow(parent: Node, level: NutsBoltsLevelData, m: NutVisualMetrics): Node {
    const node = new Node('SelectionGlow');
    node.layer = parent.layer;
    node.parent = parent;
    node.active = false;
    const g = node.addComponent(Graphics);
    const top = m.capBaseOffset + (level.capacity - 1) * m.nutStep;
    g.fillColor = new Color(255, 212, 54, 42);
    g.roundRect(-m.baseWidth * 0.61, -4, m.baseWidth * 1.22, top + m.nutHeight * 0.74, m.baseWidth * 0.34);
    g.fill();
    g.lineWidth = Math.max(2.5, m.baseHeight * 0.09);
    g.strokeColor = new Color(255, 220, 83, 225);
    g.roundRect(-m.baseWidth * 0.57, 0, m.baseWidth * 1.14, top + m.nutHeight * 0.61, m.baseWidth * 0.31);
    g.stroke();
    return node;
}

export function createBoltVisual(
    parent: Node,
    level: NutsBoltsLevelData,
    index: number,
    stack: readonly NutColorId[],
    onClick: () => void,
): BoltVisualRuntime {
    const m = getNutVisualMetrics(level.visualSize, level.nutStep, level.capBaseOffset);
    const spec = level.bolts[index];
    const root = new Node(`Bolt_${index}`);
    root.layer = parent.layer;
    root.parent = parent;
    root.setPosition(refX(spec.screenX), refY(spec.baseBottomY), 0);
    const top = m.capBaseOffset + (level.capacity - 1) * m.nutStep;
    const ui = root.addComponent(UITransform);
    ui.setContentSize(Math.max(m.baseWidth, m.nutWidth) + 18, top + m.nutHeight * 0.85 + m.selectionLift);
    ui.setAnchorPoint(0.5, 0);

    const glow = drawSelectionGlow(root, level, m);
    drawBoltBase(root, m);
    drawShaft(root, level, m);

    const nutNodes: Node[] = [];
    stack.forEach((color, nutIndex) => {
        const nut = createNutNode(root, color, m, `Nut_${nutIndex}_${color}`);
        nut.setPosition(0, m.firstNutCenter + nutIndex * m.nutStep, 0);
        nutNodes.push(nut);
    });
    drawBoltBaseFront(root, m);
    const cap = drawBoltCap(root, top, m);
    cap.setSiblingIndex(root.children.length - 1);

    const button = root.addComponent(Button);
    button.transition = Button.Transition.NONE;
    root.on(Button.EventType.CLICK, onClick);
    root.setScale(new Vec3(1, 1, 1));
    return { root, glow, cap, nutNodes, metrics: m };
}
