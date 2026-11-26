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
