#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
    BOLT_SELECTION_DURATION_SECONDS,
    BOLT_SELECTION_LIFT,
    boltSelectionTarget,
} from '../assets/scripts/game/BoltSelectionFeedback.ts';

const baseline = Object.freeze({ x: 7, y: -11, z: 0 });
const selected = boltSelectionTarget(baseline, true, true);
assert.equal(BOLT_SELECTION_LIFT >= 22, true, 'lift must remain screenshot-visible');
assert.equal(BOLT_SELECTION_DURATION_SECONDS >= 0.15, true);
assert.equal(BOLT_SELECTION_DURATION_SECONDS <= 0.30, true);
assert.deepEqual(selected, { x: 7, y: -11 + BOLT_SELECTION_LIFT, z: 0 });

// Re-selecting always derives from the immutable baseline rather than the
// prior target, which locks out cumulative drift.
assert.deepEqual(boltSelectionTarget(baseline, true, true), selected);
assert.deepEqual(boltSelectionTarget(baseline, true, false), baseline);
assert.deepEqual(boltSelectionTarget(baseline, false, true), baseline);

console.log('Bolt selection feedback geometry passed.');
