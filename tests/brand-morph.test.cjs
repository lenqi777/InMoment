'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../src/shared/brand-morph.js');

function harness() {
  let clock = 0, sequence = 0, reduced = false, painted;
  const frames = new Map();
  const shapes = { logo: [[[0, 0], [10, 10]]], play: [[[20, 40], [30, 50]]], pause: [[[60, 80], [70, 90]]] };
  const control = createController({ shapes, paint(value) { painted = value; }, now: () => clock, reducedMotion: () => reduced,
    requestFrame(fn) { frames.set(++sequence, fn); return sequence; }, cancelFrame(id) { frames.delete(id); } });
  return { control, shapes, get painted() { return painted; }, get frames() { return frames.size; }, reduce() { reduced = true; control.settle(); },
    tick(time) { clock = time; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)); } };
}
test('brand morph paints real intermediate geometry and settles exactly on the target', () => {
  const ui = harness(); ui.control.setState('play'); ui.tick(160);
  assert.deepEqual(ui.painted, [[[10, 20], [20, 30]]]); assert.equal(ui.frames, 1);
  ui.tick(320); assert.deepEqual(ui.painted, ui.shapes.play); assert.equal(ui.frames, 0);
});
test('rapid reversal continues from the current visible contour and repeated state does not restart it', () => {
  const ui = harness(); ui.control.setState('pause'); ui.tick(160);
  const midpoint = structuredClone(ui.painted); ui.control.setState('play'); assert.deepEqual(ui.painted, midpoint);
  ui.tick(240); const progressing = structuredClone(ui.painted); ui.control.setState('play');
  ui.tick(480); assert.notDeepEqual(progressing, ui.painted); assert.deepEqual(ui.painted, ui.shapes.play); assert.equal(ui.frames, 0);
});
test('reduced motion settles an active morph and makes subsequent actions immediate', () => {
  const ui = harness(); ui.control.setState('play'); ui.tick(80); ui.reduce();
  assert.deepEqual(ui.painted, ui.shapes.play); assert.equal(ui.frames, 0);
  ui.control.setState('pause'); assert.deepEqual(ui.painted, ui.shapes.pause); assert.equal(ui.frames, 0);
});
test('a new draft reset and disposal cancel pending animation callbacks', () => {
  const ui = harness(); ui.control.setState('pause'); ui.tick(90); ui.control.setState('logo', { immediate: true });
  assert.deepEqual(ui.painted, ui.shapes.logo); assert.equal(ui.frames, 0);
  ui.control.setState('play'); ui.control.destroy(); ui.tick(500); assert.deepEqual(ui.painted, ui.shapes.logo);
  ui.control.setState('pause'); assert.equal(ui.frames, 0);
});
