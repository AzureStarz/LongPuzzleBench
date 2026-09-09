import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { buildHardLevels, buildLevels } from '../assets/scripts/data/LevelDefinitions.ts';
import * as data from '../assets/scripts/data/LevelData.ts';

const level = buildHardLevels()[0];
for (const [side, x] of [['l', 93], ['c', 270], ['r', 447]]) {
    const anchor = level.anchors.find(a => a.id === `n_mid_${side}`);
    assert.equal(anchor.x, x);
    assert.equal(anchor.y, 407);
    const pad = level.anchorPads.find(p => p.id === `pad_mid_${side}`);
    assert.equal(pad.y, 395);
    assert.deepEqual(pad.holeOffsets, [{ x: 0, y: -12 }]);
    for (const piece of [...level.boards, ...level.anchorPads]) {
        if (!piece.attachedAnchors.includes(anchor.id)) continue;
        const angle = (piece.rotationDegrees ?? 0) * Math.PI / 180;
        assert.ok(piece.holeOffsets.some(h => {
            const worldX = piece.x + h.x * Math.cos(angle) + h.y * Math.sin(angle);
            const worldY = piece.y + h.x * Math.sin(angle) - h.y * Math.cos(angle);
            return Math.hypot(worldX - anchor.x, worldY - anchor.y) < 0.15;
        }), `${piece.id} must have a hole aligned with ${anchor.id}`);
    }
}
const assets = new URL('../build/web-mobile/assets/main/', import.meta.url);
const bundle = readdirSync(assets).find(name => /^index\..*\.js$/.test(name));
let compiled;
vm.runInNewContext(readFileSync(new URL(bundle, assets), 'utf8'), {
    System: { register(name, dependencies, declare) {
        if (name !== 'chunks:///_virtual/LevelDefinitions.ts') return;
        compiled = {};
        const module = declare(values => Object.assign(compiled, values));
        module.setters[0]({ cclegacy: { _RF: { push() {}, pop() {} } } });
        module.setters[1](data);
        module.execute();
    } },
});
assert.deepEqual(JSON.parse(JSON.stringify(compiled.buildLevels())), JSON.parse(JSON.stringify(buildLevels())));
