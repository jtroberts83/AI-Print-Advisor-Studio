const test = require('node:test');
const assert = require('node:assert');
globalThis.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
const PE = require('../renderer/report/photoedit');

// a w×h picture: fn(x, y) → [r, g, b]
function pic(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y), i = (y * w + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return { w, h, data };
}

test('photo touch up: a removed background is transparent, the model keeps its own pixels', () => {
  const src = pic(20, 10, (x, y) => [x * 10, y * 20, 100]);
  const mask = new Float32Array(200).fill(0); for (let i = 0; i < 100; i++) mask[i] = 1;   // top half is the model
  const out = PE.render(src, { ...PE.DEF, removeBg: true }, mask, null);
  assert.strictEqual(out.data[3], 255, 'model: opaque');
  assert.deepStrictEqual([...out.data.slice(0, 3)], [...src.data.slice(0, 3)], 'model: same colors');
  assert.strictEqual(out.data[150 * 4 + 3], 0, 'background: transparent');
  // the AI's square mask stretched back to the photo's shape
  const sq = { w: 4, h: 4, m: Float32Array.from({ length: 16 }, (_, i) => (i < 8 ? 1 : 0)) };
  const big = PE.maskAt(sq, 20, 10, 0);
  assert.ok(big[0] > 0.99 && big[199] < 0.01 && big.length === 200);
});

test('photo touch up: Auto-fix brightens a dark photo, neutral settings change nothing', () => {
  const dark = pic(60, 40, (x, y) => [40 + (x % 20), 35 + (y % 15), 30]);
  const a = PE.autoFix(dark, null);
  assert.ok(a.exposure > 20, `exposure ${a.exposure}`);
  const src = pic(20, 10, (x, y) => [x * 10, y * 20, 100]);
  const out = PE.render(src, { ...PE.DEF }, null, [1, 1, 1]);
  for (let i = 0; i < src.data.length; i++) assert.ok(Math.abs(out.data[i] - src.data[i]) <= 1, `pixel ${i}`);
  // background removed onto a color (when one is given)
  const mask = new Float32Array(200).fill(0);
  const white = PE.render(src, { ...PE.DEF, removeBg: true }, mask, [1, 1, 1]);
  assert.deepStrictEqual([...white.data.slice(0, 4)], [255, 255, 255, 255]);
});

test('photo touch up: clean-up removes loose specks and haze, keeps the model and its soft edge', () => {
  const w = 100, h = 80, m = new Float32Array(w * h);
  for (let y = 20; y < 60; y++) for (let x = 20; x < 70; x++) m[y * w + x] = 1;   // the model
  m[20 * w + 19] = 0.4;                       // its soft edge
  for (let y = 5; y < 7; y++) for (let x = 85; x < 87; x++) m[y * w + x] = 1;   // a speck of background far away
  m[75 * w + 5] = 0.04;                       // faint haze
  m[70 * w + 50] = 0.3;                       // a faint smudge away from the model
  const t = PE.tidy({ w, h, m });
  assert.strictEqual(t.m[40 * w + 40], 1, 'model kept');
  assert.ok(Math.abs(t.m[20 * w + 19] - 0.4) < 1e-6, 'soft edge next to the model kept');
  assert.strictEqual(t.m[5 * w + 85], 0, 'speck removed');
  assert.strictEqual(t.m[75 * w + 5], 0, 'haze cleared');
  assert.strictEqual(t.m[70 * w + 50], 0, 'smudge away from the model cleared');
});

test('photo touch up: a box cut-out is placed back in the photo; outside the box is background', () => {
  const sq = { w: 4, h: 4, m: new Float32Array(16).fill(1) };
  const g = PE.placeMask(sq, [0.5, 0.5, 1, 1], 10, 10);
  assert.strictEqual(g.m[0], 0); assert.strictEqual(g.m[7 * 10 + 7], 1);
  const e = PE.applyEdits(Float32Array.from([1, 1, 0]), Float32Array.from([1, 0, 1]), Float32Array.from([0, 0, 1]));
  assert.deepStrictEqual([...e], [0, 1, 1], 'erase, untouched, restore');
});

test('photo touch up: trimming keeps the model and a little space around it', () => {
  const w = 100, h = 200, m = new Float32Array(w * h);
  for (let y = 50; y < 150; y++) for (let x = 30; x < 70; x++) m[y * w + x] = 1;
  const t = PE.trimRect(m, w, h, 5);   // 5% of the model's longest side (100 px) = 5 px each side
  [0.25, 0.225, 0.75, 0.775].forEach((v, i) => assert.ok(Math.abs(t[i] - v) < 0.005, `side ${i}: ${t[i]}`));
  assert.strictEqual(PE.trimRect(new Float32Array(w * h), w, h, 5), null, 'nothing kept: no trim');
  assert.deepStrictEqual(PE.trimRect(m, w, h, 200), [0, 0, 1, 1], 'never outside the photo');
});
