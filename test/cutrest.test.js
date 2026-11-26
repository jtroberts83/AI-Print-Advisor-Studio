// Print the rest (src/cutrest.js): a project cut at a height, closed flat, lowered onto the bed.
const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { printTheRest, cutMesh } = require('../src/cutrest');
const { load3mf } = require('../src/threemf');

// a box w×d×h with its corner at the origin, as a closed mesh
function box(w, d, h) {
  const V = [0, 0, 0, w, 0, 0, w, d, 0, 0, d, 0, 0, 0, h, w, 0, h, w, d, h, 0, d, h];
  const T = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { V, T };
}
const closed = (T) => {   // every edge used once each way
  const e = new Map();
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) { const a = T[t + k], b = T[t + (k + 1) % 3]; e.set(`${a}_${b}`, (e.get(`${a}_${b}`) || 0) + 1); }
  return [...e].every(([k, n]) => { const [a, b] = k.split('_'); return n === 1 && e.get(`${b}_${a}`) === 1; });
};
const volume = (V, T) => { let v = 0; for (let t = 0; t < T.length; t += 3) { const [p, q, s] = [0, 1, 2].map((k) => V.slice(T[t + k] * 3, T[t + k] * 3 + 3)); v += (p[0] * (q[1] * s[2] - q[2] * s[1]) - p[1] * (q[0] * s[2] - q[2] * s[0]) + p[2] * (q[0] * s[1] - q[1] * s[0])) / 6; } return v; };

test('a box cut part way up is closed flat, with the right volume, and keeps its triangle attributes', () => {
  const { V, T } = box(10, 20, 30);
  const X = T.map((_, i) => (i % 3 === 0 ? 'paint_color="4"' : '')).filter((_, i) => i % 3 === 0);
  const r = cutMesh(V, T, X, [0, 0, 1], -12);
  assert.ok(closed(r.triangles), 'watertight');
  assert.ok(Math.abs(volume(r.vertices, r.triangles) - 10 * 20 * 18) < 1e-6);
  assert.ok(r.capped > 0 && r.open === 0);
  assert.ok(r.extra.filter(Boolean).every((x) => x === 'paint_color="4"'));
  assert.strictEqual(cutMesh(V, T, X, [0, 0, 1], -40), null, 'nothing above the top');
});

async function project() {
  const zip = new JSZip();
  const mesh = (id, w, d, h) => { const { V, T } = box(w, d, h); return `<object id="${id}" type="model"><mesh><vertices>${Array.from({ length: V.length / 3 }, (_, i) => `<vertex x="${V[i * 3]}" y="${V[i * 3 + 1]}" z="${V[i * 3 + 2] - h / 2}"/>`).join('')}</vertices><triangles>${Array.from({ length: T.length / 3 }, (_, i) => `<triangle v1="${T[i * 3]}" v2="${T[i * 3 + 1]}" v3="${T[i * 3 + 2]}"/>`).join('')}</triangles></mesh></object>`; };
  // a tall tower (two copies) and a short tile, meshes centered like Snapmaker Orca writes them
  zip.file('3D/3dmodel.model', `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${mesh(1, 10, 10, 40)}${mesh(2, 30, 30, 3)}</resources><build>
<item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 50 20" printable="1"/><item objectid="1" transform="0 1 0 -1 0 0 0 0 1 100 50 20" printable="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 150 150 1.5" printable="1"/></build></model>`);
  zip.file('Metadata/layer_heights_profile.txt', 'object_id=1|0.2|0.2');
  zip.file('Metadata/plate_1.gcode', 'G1 X0');
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('Print the rest: the tall objects are cut and lowered, the finished one is turned off, old heights and G-code go', async () => {
  const r = await printTheRest(await project(), { z: 12.5 });
  assert.deepStrictEqual(r.cut.length, 2); assert.strictEqual(r.done.length, 1);
  const p = await load3mf(r.buffer);
  for (const it of p.items.slice(0, 2)) {
    let lo = Infinity, hi = -Infinity;
    for (const m of it.meshes) { const V = m.mesh.vertices, M = m.transform; for (let i = 0; i < V.length; i += 3) { const z = V[i] * M[2] + V[i + 1] * M[5] + V[i + 2] * M[8] + M[11]; lo = Math.min(lo, z); hi = Math.max(hi, z); } }
    assert.ok(Math.abs(lo) < 1e-6 && Math.abs(hi - 27.5) < 1e-6, `${lo}..${hi}`);
    assert.ok(it.printable);
  }
  assert.strictEqual(p.items[2].printable, false, 'the short tile had finished');
  assert.ok(!p.names.includes('Metadata/layer_heights_profile.txt') && !p.names.includes('Metadata/plate_1.gcode'));
  assert.ok(r.warnings.some((w) => /variable layer heights/.test(w)));
  await assert.rejects(printTheRest(await project(), { z: 50 }), /shorter than 50 mm/);
});
