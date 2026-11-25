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

test('photo touch up: the background goes, the model stays (even its white parts inside)', () => {
  // a light gray table, slightly uneven, with a red model that has a white window in the middle
  const p = pic(120, 90, (x, y) => {
    const inModel = x >= 40 && x < 80 && y >= 25 && y < 70, inWindow = x >= 55 && x < 65 && y >= 40 && y < 50;
    if (inModel && !inWindow) return [200, 30, 30];
    if (inWindow) return [238, 238, 238];
    const n = (x * 7 + y * 13) % 9;
    return [232 + n, 232 + n, 230 + n];
  });
  const m = PE.bgMask(p, 22);
  const at = (x, y) => m.m[y * p.w + x];
  assert.strictEqual(at(2, 2), 0, 'corner is background');
  assert.strictEqual(at(100, 80), 0);
  assert.strictEqual(at(45, 30), 1, 'the model is kept');
  assert.strictEqual(at(60, 45), 1, 'a white part inside the model is kept (it doesn’t touch the background)');
  assert.ok(m.kept > 0.15 && m.kept < 0.35, String(m.kept));
  const auto = PE.autoTolerance(p);
  assert.ok(auto.mask && auto.mask.kept > 0.15 && auto.mask.kept < 0.35, `auto tolerance ${auto.tolerance} kept ${auto.mask && auto.mask.kept}`);
});

test('photo touch up: Auto-fix brightens a dark photo, neutral settings change nothing', () => {
  const dark = pic(60, 40, (x, y) => [40 + (x % 20), 35 + (y % 15), 30]);
  const a = PE.autoFix(dark, null);
  assert.ok(a.exposure > 20, `exposure ${a.exposure}`);
  const src = pic(20, 10, (x, y) => [x * 10, y * 20, 100]);
  const out = PE.render(src, { ...PE.DEF }, null, [1, 1, 1]);
  for (let i = 0; i < src.data.length; i++) assert.ok(Math.abs(out.data[i] - src.data[i]) <= 1, `pixel ${i}`);
  // background removed: replaced with the chosen color
  const mask = new Float32Array(200).fill(0);
  const white = PE.render(src, { ...PE.DEF, removeBg: true }, mask, [1, 1, 1]);
  assert.deepStrictEqual([...white.data.slice(0, 4)], [255, 255, 255, 255]);
});
