import { Node, Tween, tween, Vec3 } from 'cc';
import type { NutColorId, NutsBoltsLevelData } from './NutsBoltsLevelData';
import type { NutsBoltsMoveRecord } from './NutsBoltsModel';
import {
    BoltVisualRuntime,
    createMovingThreadSleeves,
    createNutNode,
    createTransferForeground,
} from './NutsBoltsVisuals';

export function setBoltSelected(
    runtime: BoltVisualRuntime,
    stackLength: number,
    runLength: number,
    selected: boolean,
): void {
    const { glow, nutNodes, metrics } = runtime;
    Tween.stopAllByTarget(glow);
    glow.active = selected;
    glow.setScale(1, 1, 1);
    if (selected) {
        tween(glow)
            .repeatForever(
                tween<Node>()
                    .to(0.42, { scale: new Vec3(1.035, 1.025, 1) }, { easing: 'sineInOut' })
                    .to(0.42, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' }),
            )
            .start();
    }

    const firstMoving = Math.max(0, stackLength - runLength);
    nutNodes.forEach((nut, index) => {
        Tween.stopAllByTarget(nut);
        const baseY = metrics.firstNutCenter + index * metrics.nutStep;
        const targetY = selected && index >= firstMoving ? baseY + metrics.selectionLift : baseY;
        tween(nut)
            .to(0.15, { position: new Vec3(0, targetY, 0) }, { easing: selected ? 'backOut' : 'quadOut' })
            .start();
    });
}

export function animateBoltShake(runtime: BoltVisualRuntime): void {
    const node = runtime.root;
    if (!node || !node.isValid) return;
    const original = node.position.clone();
    Tween.stopAllByTarget(node);
    tween(node)
        .to(0.045, { position: new Vec3(original.x - 7, original.y, 0) })
        .to(0.045, { position: new Vec3(original.x + 7, original.y, 0) })
        .to(0.045, { position: new Vec3(original.x - 4, original.y, 0) })
        .to(0.045, { position: new Vec3(original.x + 3, original.y, 0) })
        .to(0.045, { position: new Vec3(original.x, original.y, 0) })
        .start();
}

export function animateTransfer(
    overlay: Node,
    level: NutsBoltsLevelData,
    source: BoltVisualRuntime,
    target: BoltVisualRuntime,
    allBolts: readonly BoltVisualRuntime[],
    move: NutsBoltsMoveRecord,
    color: NutColorId,
    onComplete: () => void,
): Node {
    const movingRoot = new Node('MovingNuts');
    movingRoot.layer = overlay.layer;
    movingRoot.parent = overlay;
    movingRoot.setSiblingIndex(overlay.children.length - 1);

    const firstSourceNut = move.sourceLengthBefore - move.count;
    const startY = source.root.position.y
        + source.metrics.firstNutCenter
        + firstSourceNut * source.metrics.nutStep
        + source.metrics.selectionLift;
    const targetY = target.root.position.y
        + target.metrics.firstNutCenter
        + move.targetLengthBefore * target.metrics.nutStep;
    const startX = source.root.position.x;
    const targetX = target.root.position.x;
    movingRoot.setPosition(startX, startY, 0);

    for (let i = 0; i < move.count; i++) {
        const nut = createNutNode(movingRoot, color, source.metrics, `MovingNut_${i}`);
        nut.setPosition(0, i * source.metrics.nutStep, 0);
    }
    const sleeves = createMovingThreadSleeves(movingRoot, move.count, source.metrics);
    const foreground = createTransferForeground(overlay, level, target);
    for (let i = firstSourceNut; i < source.nutNodes.length; i++) {
        source.nutNodes[i].active = false;
    }

    const boardCeiling = allBolts.reduce((highest, runtime) => Math.max(
        highest,
        runtime.root.position.y
            + runtime.metrics.capBaseOffset
            + (level.capacity - 1) * runtime.metrics.nutStep
            + runtime.metrics.capHeight * 0.55,
    ), Number.NEGATIVE_INFINITY);
    // The bottom moving nut clears the highest bolt before any horizontal
    // travel, so neither single nor grouped moves can cross another stack.
    const travelY = Math.max(
        startY + source.metrics.selectionLift * 0.45,
        targetY + target.metrics.selectionLift * 0.45,
        boardCeiling + source.metrics.nutHeight * 0.62,
    );
    const preInsertY = targetY + Math.max(
        target.metrics.selectionLift * 0.78,
        target.metrics.nutHeight * 0.34,
    );
    const horizontalDuration = Math.min(0.30, 0.17 + Math.abs(targetX - startX) / 850);
    const descentDuration = Math.min(0.32, Math.max(0.18, (travelY - preInsertY) / 820));

    movingRoot.setScale(1, 1, 1);
    tween(movingRoot)
        .to(0.15, {
            position: new Vec3(startX, travelY, 0),
            scale: new Vec3(1.025, 1.025, 1),
        }, { easing: 'quadOut' })
        .to(horizontalDuration, { position: new Vec3(targetX, travelY, 0) }, { easing: 'sineInOut' })
        .call(() => {
            // Only reveal the target foreground once horizontally aligned;
            // this makes the shaft appear through the centre holes instead of
            // letting the moving meshes paint over it.
            if (sleeves.isValid) sleeves.active = true;
            if (foreground.isValid) foreground.active = true;
        })
        .to(descentDuration, {
            position: new Vec3(targetX, preInsertY, 0),
            scale: new Vec3(1.01, 1.01, 1),
        }, { easing: 'quadInOut' })
        .to(0.13, {
            position: new Vec3(targetX, targetY + 1.6, 0),
            scale: new Vec3(0.992, 1.015, 1),
        }, { easing: 'quadIn' })
        .to(0.07, {
            position: new Vec3(targetX, targetY, 0),
            scale: new Vec3(1, 1, 1),
        }, { easing: 'quadOut' })
        .call(() => {
            // Eliminate accumulated tween interpolation error before the
            // production board is reconciled to the model state.
            if (movingRoot.isValid) movingRoot.setPosition(targetX, targetY, 0);
            if (foreground.isValid) foreground.destroy();
            if (movingRoot.isValid) movingRoot.destroy();
            onComplete();
        })
        .start();
    return movingRoot;
}

export function animateBoardArrival(bolts: readonly BoltVisualRuntime[]): void {
    bolts.forEach((runtime, index) => {
        const node = runtime.root;
        Tween.stopAllByTarget(node);
        node.setScale(0.82, 0.82, 1);
        tween(node)
            .delay(Math.min(0.22, index * 0.015))
            .to(0.22, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
            .start();
    });
}

export function stopBoltAnimations(runtime: BoltVisualRuntime): void {
    Tween.stopAllByTarget(runtime.root);
    Tween.stopAllByTarget(runtime.glow);
    Tween.stopAllByTarget(runtime.cap);
    for (const nut of runtime.nutNodes) Tween.stopAllByTarget(nut);
}
