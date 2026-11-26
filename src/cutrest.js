// Print the rest: a copy of a Snapmaker Orca project with every object on one plate cut at a height (where a
// cancelled or failed print stopped), keeping only what is above it, closed flat at the cut and lowered onto the bed.
// Objects that had already finished (shorter than the cut) are kept but turned off (not printable). The project's
// settings, per-object settings, filament per part and painted colors stay as they were.
//
// The cut is made in each mesh's own coordinates: the world height of a point is a plane through the mesh there
// (the mesh's transform), so no mesh is moved or re-centered; the build items are lowered by the cut height instead.
const { load3mf, plateMembership, setBuildTransforms } = require('./threemf');
const { Earcut } = require('./earcut');

const fmt = (v) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? '0' : String(r); };
const attr = (s, n) => { const m = new RegExp(`(?:^|\\s)${n}="([^"]*)"`).exec(s); return m ? m[1] : null; };

// cut one mesh (vertices, triangles, per-triangle extra attributes) by f(v) = a·v + d, keeping f > 0, and close it
// returns { vertices: number[], triangles: number[], extra: string[] (per triangle), capped, open } or null (nothing left)
function cutMesh(V, T, extra, a, d) {
  const nV = V.length / 3, f = new Float64Array(nV);
  for (let i = 0; i < nV; i++) f[i] = V[i * 3] * a[0] + V[i * 3 + 1] * a[1] + V[i * 3 + 2] * a[2] + d;
  const outV = [], map = new Int32Array(nV).fill(-1), cut = new Map();
  const keep = (i) => { if (map[i] < 0) { map[i] = outV.length / 3; outV.push(V[i * 3], V[i * 3 + 1], V[i * 3 + 2]); } return map[i]; };
  // the point where edge i (above) → j (below) crosses the plane; shared by both triangles of the edge
  const cross = (i, j) => {
    const key = f[j] === 0 ? `v${j}` : i < j ? `${i}_${j}` : `${j}_${i}`;
    let k = cut.get(key);
    if (k == null) {
      const t = f[i] / (f[i] - f[j]);
      k = outV.length / 3; cut.set(key, k);
      outV.push(V[i * 3] + t * (V[j * 3] - V[i * 3]), V[i * 3 + 1] + t * (V[j * 3 + 1] - V[i * 3 + 1]), V[i * 3 + 2] + t * (V[j * 3 + 2] - V[i * 3 + 2]));
    }
    return k;
  };
  const outT = [], outX = [], edges = new Map();   // edges: the cut's boundary, from → to (as the kept mesh runs it)
  for (let t = 0; t < T.length; t += 3) {
    const v = [T[t], T[t + 1], T[t + 2]], up = v.map((i) => f[i] > 0), n = up.filter(Boolean).length;
    const x = extra ? extra[t / 3] || '' : '';
    if (n === 0) continue;
    if (n === 3) { outT.push(keep(v[0]), keep(v[1]), keep(v[2])); outX.push(x); continue; }
    // rotate so the odd one out is first: [A, B, C] in the triangle's own order
    const r = up.findIndex((u) => (n === 1 ? u : !u)), A = v[r], B = v[(r + 1) % 3], C = v[(r + 2) % 3];
    if (n === 1) {   // A above
      const pab = cross(A, B), pac = cross(A, C);
      outT.push(keep(A), pab, pac); outX.push(x);
      if (pab !== pac) edges.set(pab, pac);
    } else {         // A below, B and C above
      const pbc = keep(B), pcc = keep(C), pcA = cross(C, A), pAb = cross(B, A);
      outT.push(pbc, pcc, pcA, pbc, pcA, pAb); outX.push(x, x);
      if (pcA !== pAb) edges.set(pcA, pAb);
    }
  }
  if (!outT.length) return null;
  // the boundary in loops, then a flat face for each outline (with its holes), facing down (-a)
  const loops = []; let open = 0;
  const left = new Map(edges);
  for (const start of edges.keys()) {
    if (!left.has(start)) continue;
    const loop = [start]; let cur = start, ok = false;
    for (let guard = 0; guard <= edges.size; guard++) {
      const nx = left.get(cur); left.delete(cur);
      if (nx == null) break;
      if (nx === start) { ok = true; break; }
      loop.push(nx); cur = nx;
    }
    if (ok && loop.length >= 3) loops.push(loop); else open++;
  }
  // a 2D frame on the plane
  const len = Math.hypot(a[0], a[1], a[2]) || 1, nrm = a.map((c) => c / len);
  const ref = Math.abs(nrm[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = [nrm[1] * ref[2] - nrm[2] * ref[1], nrm[2] * ref[0] - nrm[0] * ref[2], nrm[0] * ref[1] - nrm[1] * ref[0]];
  const ul = Math.hypot(...u); u[0] /= ul; u[1] /= ul; u[2] /= ul;
  const w = [nrm[1] * u[2] - nrm[2] * u[1], nrm[2] * u[0] - nrm[0] * u[2], nrm[0] * u[1] - nrm[1] * u[0]];
  const p2 = (k) => [outV[k * 3] * u[0] + outV[k * 3 + 1] * u[1] + outV[k * 3 + 2] * u[2], outV[k * 3] * w[0] + outV[k * 3 + 1] * w[1] + outV[k * 3 + 2] * w[2]];
  const polys = loops.map((l) => { const pts = l.map(p2); let s = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]); return { l, pts, area: s }; });
  let capped = 0;
  if (polys.length) {
    const big = polys.reduce((m, p) => (Math.abs(p.area) > Math.abs(m.area) ? p : m));
    const outer = polys.filter((p) => Math.sign(p.area) === Math.sign(big.area)), holes = polys.filter((p) => Math.sign(p.area) !== Math.sign(big.area));
    const inside = (pt, pts) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
    const groups = outer.map((o) => ({ o, holes: [] }));
    for (const h of holes) {
      const home = groups.filter((g) => inside(h.pts[0], g.o.pts)).sort((x, y) => Math.abs(x.o.area) - Math.abs(y.o.area))[0];
      if (home) home.holes.push(h);
    }
    for (const g of groups) {
      const ids = [...g.o.l], flat = g.o.pts.flat(), holeIdx = [];
      for (const h of g.holes) { holeIdx.push(ids.length); ids.push(...h.l); flat.push(...h.pts.flat()); }
      const tri = Earcut.triangulate(flat, holeIdx, 2);
      for (let i = 0; i < tri.length; i += 3) {
        let [p, q, r] = [ids[tri[i]], ids[tri[i + 1]], ids[tri[i + 2]]];
        // facing down: (q-p)×(r-p) · a < 0
        const e1 = [0, 1, 2].map((k) => outV[q * 3 + k] - outV[p * 3 + k]), e2 = [0, 1, 2].map((k) => outV[r * 3 + k] - outV[p * 3 + k]);
        const cz = (e1[1] * e2[2] - e1[2] * e2[1]) * a[0] + (e1[2] * e2[0] - e1[0] * e2[2]) * a[1] + (e1[0] * e2[1] - e1[1] * e2[0]) * a[2];
        if (cz > 0) [q, r] = [r, q];
        outT.push(p, q, r); outX.push('');
        capped++;
      }
    }
  }
  return { vertices: outV, triangles: outT, extra: outX, capped, open };
}

// the <mesh> of object `id` in a model file's text: { start, end } of its inside, or null
function findMesh(xml, id) {
  const m = new RegExp(`<(?:\\w+:)?object\\b[^>]*\\sid="${id}"[^>]*>`).exec(xml); if (!m) return null;
  const ms = /<((?:\w+:)?)mesh\b[^>]*>/g; ms.lastIndex = m.index;
  const open = ms.exec(xml); if (!open) return null;
  const close = /<\/(?:\w+:)?mesh>/g; close.lastIndex = open.index;
  const c = close.exec(xml); if (!c) return null;
  return { start: open.index + open[0].length, end: c.index, prefix: open[1] || '' };
}
function readMesh(body) {
  const V = [], T = [], X = [];
  const vre = /<(?:\w+:)?vertex\b([^>]*?)\/>/g; let m;
  while ((m = vre.exec(body))) V.push(+attr(m[1], 'x'), +attr(m[1], 'y'), +attr(m[1], 'z'));
  const tre = /<(?:\w+:)?triangle\b([^>]*?)\/>/g;
  while ((m = tre.exec(body))) {
    T.push(+attr(m[1], 'v1'), +attr(m[1], 'v2'), +attr(m[1], 'v3'));
    X.push(m[1].replace(/\s(v1|v2|v3)="[^"]*"/g, '').trim());
  }
  return { V, T, X };
}
function writeMesh(r, ns) {
  const out = ['\n    <', ns, 'vertices>\n'];
  for (let i = 0; i < r.vertices.length; i += 3) out.push(`     <${ns}vertex x="${fmt(r.vertices[i])}" y="${fmt(r.vertices[i + 1])}" z="${fmt(r.vertices[i + 2])}"/>\n`);
  out.push(`    </${ns}vertices>\n    <${ns}triangles>\n`);
  for (let t = 0; t < r.triangles.length; t += 3) out.push(`     <${ns}triangle v1="${r.triangles[t]}" v2="${r.triangles[t + 1]}" v3="${r.triangles[t + 2]}"${r.extra[t / 3] ? ' ' + r.extra[t / 3] : ''}/>\n`);
  out.push(`    </${ns}triangles>\n   `);
  return out.join('');
}

// buffer: the .3mf; z: the cut height (mm above the bed); plate: the plate number (1-based) or null for all
// returns { buffer, cut: [names], done: [names], removedParts, open, warnings }
async function printTheRest(buffer, { z, plate = null, onProgress = () => {} }) {
  if (!(z > 0)) throw new Error('The cut height must be above the bed.');
  const project = await load3mf(buffer);
  const zip = project.zip, warnings = [];
  if (project.plates.length > 1 && !plate) throw new Error('Pick the plate that was printed.');
  const member = plateMembership(project);
  const onPlate = project.items.filter((it) => !plate || project.plates.length <= 1 || (member.get(it.index) || {}).plate === plate);
  if (!onPlate.length) throw new Error(`No objects on plate ${plate}.`);
  // each item's height range (all its parts, in bed coordinates)
  const range = (it) => {
    let lo = Infinity, hi = -Infinity;
    for (const m of it.meshes) {
      const V = m.mesh.vertices, M = m.transform;
      for (let i = 0; i < V.length; i += 3) { const wz = V[i] * M[2] + V[i + 1] * M[5] + V[i + 2] * M[8] + M[11]; if (wz < lo) lo = wz; if (wz > hi) hi = wz; }
    }
    return { lo, hi };
  };
  const cutItems = [], doneItems = [];
  for (const it of onPlate) { const r = range(it); if (r.hi <= z + 1e-6) doneItems.push(it); else cutItems.push(it); if (r.lo > 0.5) warnings.push(`${it.name} doesn’t sit on the bed in the project (it starts ${r.lo.toFixed(1)} mm up).`); }
  if (!cutItems.length) throw new Error(`Everything on this plate is shorter than ${z} mm, so it all finished.`);
  // meshes to cut (a mesh used by several copies is cut once: the copies must be the same way up)
  const jobs = new Map();
  for (const it of cutItems) for (const m of it.meshes) {
    const key = `${m.sourcePath}#${m.sourceId}`, M = m.transform, plane = [M[2], M[5], M[8], M[11]];
    const j = jobs.get(key);
    if (!j) jobs.set(key, { path: m.sourcePath.replace(/^\//, ''), id: m.sourceId, plane, items: [it] });
    else {
      if (plane.some((v, k) => Math.abs(v - j.plane[k]) > 1e-6 * Math.max(1, Math.abs(v)))) throw new Error(`Copies of “${it.name}” are turned differently, so they can’t share one cut. Cut them in Snapmaker Orca instead.`);
      j.items.push(it);
    }
  }
  // shared with an object that isn't being cut (another plate, or already finished): can't cut it here
  const cutSet = new Set(cutItems);
  for (const it of project.items) if (!cutSet.has(it)) for (const m of it.meshes) if (jobs.has(`${m.sourcePath}#${m.sourceId}`)) throw new Error(`“${it.name}” shares its shape with an object being cut. Cut them in Snapmaker Orca instead.`);
  // cut, file by file
  const byFile = new Map();
  for (const j of jobs.values()) (byFile.get(j.path) || byFile.set(j.path, []).get(j.path)).push(j);
  const emptied = new Set(); let open = 0, n = 0;
  const texts = new Map();
  for (const [file, list] of byFile) {
    let xml = texts.get(file) ?? await zip.file(file).async('string');
    // later edits first, so earlier positions stay right
    const found = list.map((j) => ({ j, at: findMesh(xml, j.id) })).filter((x) => x.at).sort((a, b) => b.at.start - a.at.start);
    for (const { j, at } of found) {
      onProgress(`Cutting ${++n} of ${jobs.size}…`);
      const { V, T, X } = readMesh(xml.slice(at.start, at.end));
      const r = cutMesh(V, T, X, [j.plane[0], j.plane[1], j.plane[2]], j.plane[3] - z);
      if (!r) { emptied.add(`${j.path}#${j.id}`); continue; }
      open += r.open;
      xml = xml.slice(0, at.start) + writeMesh(r, at.prefix) + xml.slice(at.end);
    }
    texts.set(file, xml);
  }
  for (const [file, xml] of texts) zip.file(file, xml);
  // parts entirely below the cut: taken out of their object (and its settings)
  let root = texts.get(project.rootPath) ?? await zip.file(project.rootPath).async('string');
  let ms = zip.file('Metadata/model_settings.config') ? await zip.file('Metadata/model_settings.config').async('string') : null;
  let removedParts = 0;
  for (const key of emptied) {
    const [p, id] = key.split('#');
    const re = new RegExp(`\\s*<(?:\\w+:)?component\\b(?=[^>]*\\sobjectid="${id}")(?=[^>]*path="/?${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}")[^>]*/>`, 'g');
    const before = root.length; root = root.replace(re, ''); if (root.length !== before) removedParts++;
    if (ms) ms = ms.replace(new RegExp(`\\s*<part\\b[^>]*\\sid="${id}"[^>]*>[\\s\\S]*?</part>`), '');
  }
  // lower the cut objects onto the bed, turn the finished ones off
  const updates = {};
  for (const it of cutItems) { const t = it.buildTransform.slice(); t[11] -= z; updates[it.index] = t; }
  root = setBuildTransforms(root, updates);
  const off = new Set(doneItems.map((it) => it.index));
  let k = -1;
  root = root.replace(/<((?:\w+:)?build)\b[^>]*>[\s\S]*?<\/\1>/, (block) => block.replace(/<((?:\w+:)?item)\b([^>]*?)(\/?)>/g, (m, tag, attrs, close) => {
    k++;
    if (!off.has(k)) return m;
    return `<${tag}${/\sprintable="/.test(attrs) ? attrs.replace(/\sprintable="[^"]*"/, ' printable="0"') : `${attrs} printable="0"`}${close}>`;
  }));
  zip.file(project.rootPath, root);
  if (ms) zip.file('Metadata/model_settings.config', ms);
  // heights that no longer match (variable layer height, height ranges) and the old sliced G-code go
  for (const n2 of project.names) {
    if (/^Metadata\/(layer_heights_profile\.txt|layer_config_ranges\.xml)$/i.test(n2)) { zip.remove(n2); warnings.push('The project’s variable layer heights (or height ranges) were for the whole model, so they were taken out.'); }
    if (/\.gcode(\.md5)?$/i.test(n2)) zip.remove(n2);
  }
  if (open) warnings.push('Some of the cut couldn’t be closed flat (the model has holes in its surface). Snapmaker Orca still slices it.');
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buffer: out, cut: cutItems.map((it) => it.name), done: doneItems.map((it) => it.name), removedParts, warnings: [...new Set(warnings)] };
}

module.exports = { printTheRest, cutMesh };
