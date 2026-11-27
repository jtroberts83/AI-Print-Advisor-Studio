// The 3D preview of a very big model: a smaller copy with no see-through holes (2.60.1)
const test = require('node:test');
const assert = require('node:assert');
const { clusterTris } = require('../src/threemf.js');

// a closed sphere as a triangle soup (9 floats per triangle)
function sphere(rings, segs, r = 20) {
  const p = (i, j) => { if (i === 0 || i === rings) return [0, 0, i ? -r : r]; const th = Math.PI * i / rings, ph = 2 * Math.PI * (j % segs) / segs; return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)]; };
  const out = [];
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
    if (i < rings - 1) out.push(...a, ...b, ...c);
    if (i > 0) out.push(...a, ...c, ...d);
  }
  return new Float32Array(out);
}
const openEdges = (P) => {
  const m = new Map(), key = (i) => `${P[i]},${P[i + 1]},${P[i + 2]}`;
  for (let t = 0; t < P.length / 9; t++) for (let k = 0; k < 3; k++) {
    const A = key(t * 9 + k * 3), B = key(t * 9 + ((k + 1) % 3) * 3), e = A < B ? `${A}|${B}` : `${B}|${A}`;
    m.set(e, (m.get(e) || 0) + 1);
  }
  let n = 0; for (const v of m.values()) if (v === 1) n++; return n;
};

test('a big mesh is reduced to about the target with a closed surface', () => {
  const pos = sphere(300, 400);
  const n = pos.length / 9;
  assert.strictEqual(openEdges(pos), 0);
  const r = clusterTris(pos, Math.floor(n / 3));
  assert.ok(r, 'reduced');
  assert.ok(r.keep.length <= n / 3 * 1.05 && r.keep.length > n / 10, `kept ${r.keep.length} of ${n}`);
  assert.strictEqual(r.pos.length, r.keep.length * 9);
  assert.strictEqual(openEdges(r.pos), 0, 'no holes');
  // each shown triangle points at a real triangle of the file, in order
  for (let i = 1; i < r.keep.length; i++) assert.ok(r.keep[i] > r.keep[i - 1] && r.keep[i] < n);
});

test('a mesh already under the target is left alone', () => {
  assert.strictEqual(clusterTris(sphere(10, 10), 1000), null);
});
