#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
    colorConnectCellCenter,
    colorConnectLocalToGridPoint,
    hitColorConnectGrid,
} from '../assets/scripts/color_connect/ColorConnectGridGeometry.ts';

const geometry = Object.freeze({ rows: 5, columns: 6, pitch: 80 });

for (let row = 0; row < geometry.rows; row++) {
    for (let column = 0; column < geometry.columns; column++) {
        const center = colorConnectCellCenter(row, column, geometry);
        const hit = hitColorConnectGrid(center.x, center.y, geometry);
        assert.ok(hit, `center ${row},${column} must hit`);
        assert.equal(hit.row, row);
        assert.equal(hit.column, column);
        assert.equal(hit.centerX, center.x);
        assert.equal(hit.centerY, center.y);
    }
}

// Top-left is inclusive; right/bottom outer edges are exclusive so floor()
// never produces an out-of-range index.
assert.deepEqual(
    (({ row, column }) => ({ row, column }))(hitColorConnectGrid(-240, 200, geometry)),
    { row: 0, column: 0 },
);
assert.equal(hitColorConnectGrid(240, 0, geometry), null);
assert.equal(hitColorConnectGrid(0, -200, geometry), null);
assert.equal(hitColorConnectGrid(-240.001, 0, geometry), null);
assert.equal(hitColorConnectGrid(0, 200.001, geometry), null);

// Internal boundaries deterministically select the cell to the right/bottom.
assert.deepEqual(
    (({ row, column }) => ({ row, column }))(hitColorConnectGrid(-160, 120, geometry)),
    { row: 1, column: 1 },
);
assert.deepEqual(
    (({ row, column }) => ({ row, column }))(hitColorConnectGrid(-160.001, 120.001, geometry)),
    { row: 0, column: 0 },
);

// A point inside the authored 10% visual gap still follows the same pitch-cell
// rule, preventing edge jitter as a pointer crosses the gap.
const gapHit = hitColorConnectGrid(-160.5, 100, geometry);
assert.equal(gapHit?.column, 0);

// Continuous points preserve outside-board coordinates for segment traversal;
// the hit-test alone rejects them.
assert.deepEqual(colorConnectLocalToGridPoint(-320, 280, geometry), { x: -1, y: -1 });
assert.equal(hitColorConnectGrid(-320, 280, geometry), null);

// Scale, parent offsets and anchor points are intentionally absent here: the
// Cocos UITransform chain removes them before this pure local-space test. They
// are exercised against actual scene nodes by color_connect_interaction_e2e.
assert.equal(hitColorConnectGrid(Number.NaN, 0, geometry), null);
assert.equal(hitColorConnectGrid(0, 0, { ...geometry, pitch: 0 }), null);

console.log('Color Connect coordinate tests passed: centers, corners, gaps, boundaries, Y direction, outside and bounds protection.');
