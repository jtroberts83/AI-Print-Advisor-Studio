// Reads Snapmaker Orca / OrcaSlicer / Bambu-style .3mf projects:
//   3D/3dmodel.model (+ 3D/Objects/*.model)  -> meshes, components, build items
//   Metadata/project_settings.config        -> full slicer settings (JSON)
//   Metadata/model_settings.config          -> plates, object names, extruders, per-object overrides
//   Metadata/slice_info.config              -> time/weight if the project was sliced
//   Metadata/*.png                          -> plate thumbnails
// and writes a copy with changed settings.

const JSZip = require('jszip');
const { getMachine } = require('./machine');
const { BY_KEY, CONTEXT_KEYS, normalize, SCHEMA } = require('./orca-settings');
const { orientObject, shortlist } = require('./orient');

const PREVIEW_TRIANGLE_LIMIT = 1_500_000;
const { decode: decodePaint, states: paintStates, subdivide: subdividePaint } = require('./paint');
const { parseMixes, expand: expandMix } = require('./mixed');

// ---------- small XML helpers (regex-based: model files can be 100+ MB) ----------
function attr(str, name) {
  const m = new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`).exec(str);
  return m ? m[1] : null;
}
function metadataMap(block) {
  const out = {};
  const re = /<metadata\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(block))) {
    const k = attr(m[1], 'key');
    if (k != null) out[k] = attr(m[1], 'value');
  }
  return out;
}
function blocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push({ attrs: m[1], body: m[2] || '' });
  return out;
}

// ---------- affine transforms (3MF: 12 numbers, row-vector convention) ----------
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
function parseTransform(s) {
  if (!s) return IDENTITY.slice();
  const n = s.trim().split(/\s+/).map(Number);
  return n.length === 12 && n.every(Number.isFinite) ? n : IDENTITY.slice();
}
// apply A first, then B
function compose(A, B) {
  const r = new Array(12);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      let v = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
      if (i === 3) v += B[9 + j];
      r[i * 3 + j] = v;
    }
  }
  return r;
}

// ---------- model file parsing ----------
// filament numbers used by an object's painted colour (decoded once per distinct paint code)
const PAINT_PIECE_LIMIT = 2_500_000;
// the filament covering most of a painted triangle
function dominantState(tree) {
  const area = new Map();
  const walk = (t, a) => {
    if (!t.children) { area.set(t.state, (area.get(t.state) || 0) + a); return; }
    const share = t.sides === 1 ? [0.5, 0.5] : t.sides === 2 ? [0.25, 0.25, 0.5] : [0.25, 0.25, 0.25, 0.25];
    t.children.forEach((c, i) => walk(c, a * share[i]));
  };
  walk(tree, 1);
  let best = 0, bestA = -1;
  for (const [st, a] of area) if (a > bestA) { best = st; bestA = a; }
  return best;
}

function paintStatesOf(it) {
  const out = new Set();
  const seen = new Set();
  for (const m of it.meshes) {
    if (!m.mesh.paint) continue;
    for (const str of m.mesh.paint) {
      if (!str || seen.has(str)) continue;
      seen.add(str);
      for (const st of paintStates(decodePaint(str))) if (st > 0) out.add(st);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function parseMesh(body) {
  const vx = [];
  const vre = /<(?:\w+:)?vertex\b([^>]*?)\/>/g;
  let m;
  while ((m = vre.exec(body))) {
    const a = m[1];
    vx.push(+attr(a, 'x'), +attr(a, 'y'), +attr(a, 'z'));
  }
  const tri = [];
  let painted = 0;
  const paint = []; // painted colour per triangle (hex string), sparse
  const tre = /<(?:\w+:)?triangle\b([^>]*?)\/>/g;
  const pre = /(?:^|\s)(?:paint_color|(?:\w+:)?mmu_segmentation)="([0-9A-Fa-f]+)"/;
  while ((m = tre.exec(body))) {
    const a = m[1];
    tri.push(+attr(a, 'v1'), +attr(a, 'v2'), +attr(a, 'v3'));
    if (a.includes('paint_color=') || a.includes('mmu_segmentation=')) {
      painted++;
      const pm = pre.exec(a);
      if (pm) paint[tri.length / 3 - 1] = pm[1];
    }
  }
  return { vertices: new Float64Array(vx), triangles: new Uint32Array(tri), painted, paint: painted ? paint : null };
}

function parseModelFile(xml) {
  const objects = new Map();
  for (const ob of blocks(xml, '(?:\\w+:)?object')) {
    const id = attr(ob.attrs, 'id');
    const obj = { id, name: attr(ob.attrs, 'name'), type: attr(ob.attrs, 'type') || 'model', mesh: null, components: [] };
    const meshMatch = /<(?:\w+:)?mesh\b[^>]*>([\s\S]*?)<\/(?:\w+:)?mesh>/.exec(ob.body);
    if (meshMatch) obj.mesh = parseMesh(meshMatch[1]);
    const cre = /<(?:\w+:)?component\b([^>]*?)\/?>/g;
    let m;
    while ((m = cre.exec(ob.body))) {
      obj.components.push({
        objectid: attr(m[1], 'objectid'),
        path: attr(m[1], 'p:path') || attr(m[1], 'path'),
        transform: parseTransform(attr(m[1], 'transform')),
      });
    }
    objects.set(id, obj);
  }
  const build = [];
  const bm = /<(?:\w+:)?build\b[^>]*>([\s\S]*?)<\/(?:\w+:)?build>/.exec(xml);
  if (bm) {
    const ire = /<(?:\w+:)?item\b([^>]*?)\/?>/g;
    let m;
    while ((m = ire.exec(bm[1]))) {
      build.push({
        objectid: attr(m[1], 'objectid'),
        transform: parseTransform(attr(m[1], 'transform')),
        printable: attr(m[1], 'printable') !== '0',
      });
    }
  }
  const unitMatch = /<model\b[^>]*\sunit="([^"]+)"/.exec(xml);
  return { objects, build, unit: unitMatch ? unitMatch[1] : 'millimeter' };
}

// Very detailed models can hold more XML than JavaScript can keep in one string (about 512 MB; a 600 MB
// MakerWorld model was seen). Above BIG_MODEL_BYTES a .model file is read in chunks straight from its bytes,
// picking out the same elements parseModelFile reads, so the model still opens and "Fix model" can lighten it.
const BIG_MODEL_BYTES = +process.env.AIPA_BIG_MODEL_BYTES || 256 * 1024 * 1024;   // the setting is for tests only
function parseModelBytes(bytes) {
  const objects = new Map(), build = [];
  let unit = 'millimeter', cur = null, inBuild = false;
  const tagRe = /<(\/?)(?:\w+:)?(model|object|vertex|triangle|component|build|item)\b([^>]*?)\/?>/g;
  const pre = /(?:^|\s)(?:paint_color|(?:\w+:)?mmu_segmentation)="([0-9A-Fa-f]+)"/;
  const finish = () => {
    if (!cur) return;
    const o = { id: cur.id, name: cur.name, type: cur.type, mesh: null, components: cur.components };
    if (cur.vx.length || cur.tri.length) o.mesh = { vertices: new Float64Array(cur.vx), triangles: new Uint32Array(cur.tri), painted: cur.painted, paint: cur.painted ? cur.paint : null };
    objects.set(cur.id, o); cur = null;
  };
  const handle = (close, tag, a) => {
    if (tag === 'model' && !close) { const u = attr(a, 'unit'); if (u) unit = u; }
    else if (tag === 'object') {
      if (close) finish();
      else { finish(); cur = { id: attr(a, 'id'), name: attr(a, 'name'), type: attr(a, 'type') || 'model', vx: [], tri: [], paint: [], painted: 0, components: [] }; }
    } else if (tag === 'vertex' && cur) cur.vx.push(+attr(a, 'x'), +attr(a, 'y'), +attr(a, 'z'));
    else if (tag === 'triangle' && cur) {
      cur.tri.push(+attr(a, 'v1'), +attr(a, 'v2'), +attr(a, 'v3'));
      if (a.includes('paint_color=') || a.includes('mmu_segmentation=')) { cur.painted++; const pm = pre.exec(a); if (pm) cur.paint[cur.tri.length / 3 - 1] = pm[1]; }
    } else if (tag === 'component' && cur && !close) cur.components.push({ objectid: attr(a, 'objectid'), path: attr(a, 'p:path') || attr(a, 'path'), transform: parseTransform(attr(a, 'transform')) });
    else if (tag === 'build') inBuild = !close;
    else if (tag === 'item' && inBuild && !close) build.push({ objectid: attr(a, 'objectid'), transform: parseTransform(attr(a, 'transform')), printable: attr(a, 'printable') !== '0' });
  };
  const dec = new TextDecoder('utf-8');
  const CHUNK = 32 * 1024 * 1024;
  let carry = '';
  for (let pos = 0; pos < bytes.length; pos += CHUNK) {
    const text = carry + dec.decode(bytes.subarray(pos, Math.min(bytes.length, pos + CHUNK)), { stream: pos + CHUNK < bytes.length });
    const cut = pos + CHUNK < bytes.length ? text.lastIndexOf('<') : text.length;   // an unfinished tag waits for the next chunk
    const part = text.slice(0, cut);
    carry = text.slice(cut);
    tagRe.lastIndex = 0;
    let m;
    while ((m = tagRe.exec(part))) handle(m[1] === '/', m[2], m[3]);
  }
  finish();
  return { objects, build, unit };
}

const UNIT_SCALE = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

// ---------- settings files ----------
function parseModelSettings(xml) {
  const objects = {};
  const plates = [];
  if (!xml) return { objects, plates };
  const skip = new Set(['name', 'extruder', 'matrix', 'source_file', 'source_object_id', 'source_volume_id',
    'source_offset_x', 'source_offset_y', 'source_offset_z', 'mesh_stat', 'face_count', 'source_in_inches', 'source_in_meters']);
  for (const ob of blocks(xml, 'object')) {
    const id = attr(ob.attrs, 'id');
    const bodyNoParts = ob.body.replace(/<part\b[\s\S]*?<\/part>/g, '');
    const meta = metadataMap(bodyNoParts);
    const parts = blocks(ob.body, 'part').map(p => {
      const pm = metadataMap(p.body);
      return {
        id: attr(p.attrs, 'id'),
        subtype: attr(p.attrs, 'subtype') || 'normal_part',
        name: pm.name || null,
        extruder: pm.extruder ? Number(pm.extruder) : null,
        sourceFile: pm.source_file || null,
        overrides: Object.fromEntries(Object.entries(pm).filter(([k]) => !skip.has(k))),
      };
    });
    objects[id] = {
      name: meta.name || null,
      extruder: meta.extruder ? Number(meta.extruder) : null,
      overrides: Object.fromEntries(Object.entries(meta).filter(([k]) => !skip.has(k))),
      parts,
    };
  }
  for (const pl of blocks(xml, 'plate')) {
    const bodyNoInst = pl.body.replace(/<model_instance\b[\s\S]*?<\/model_instance>/g, '');
    const meta = metadataMap(bodyNoInst);
    const instances = blocks(pl.body, 'model_instance').map(mi => {
      const mm = metadataMap(mi.body);
      return { objectId: mm.object_id, instanceId: mm.instance_id };
    });
    plates.push({
      index: Number(meta.plater_id || plates.length + 1),
      name: meta.plater_name || '',
      thumbnailFile: meta.thumbnail_file || null,
      objectIds: [...new Set(instances.map(i => i.objectId))],
    });
  }
  return { objects, plates };
}

function parseSliceInfo(xml) {
  if (!xml) return [];
  return blocks(xml, 'plate').map(pl => {
    const meta = metadataMap(pl.body.replace(/<filament\b[^>]*\/>/g, ''));
    const filaments = [];
    const fre = /<filament\b([^>]*?)\/>/g;
    let m;
    while ((m = fre.exec(pl.body))) {
      filaments.push({
        id: attr(m[1], 'id'), type: attr(m[1], 'type'), color: attr(m[1], 'color'),
        usedMeters: Number(attr(m[1], 'used_m')) || null, usedGrams: Number(attr(m[1], 'used_g')) || null,
      });
    }
    return {
      index: Number(meta.index || 0),
      predictionSeconds: meta.prediction ? Number(meta.prediction) : null,
      weightGrams: meta.weight ? Number(meta.weight) : null,
      filaments,
    };
  });
}

// ---------- main entry: load ----------
async function load3mf(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  const warnings = [];
  const readText = async n => (zip.file(n) ? zip.file(n).async('string') : null);

  // root model path from _rels/.rels
  let rootPath = '3D/3dmodel.model';
  const rels = await readText('_rels/.rels');
  if (rels) {
    const m = /Target="\/?([^"]+\.model)"/i.exec(rels);
    if (m) rootPath = m[1];
  }
  if (!zip.file(rootPath)) {
    const alt = names.find(n => /\.model$/i.test(n));
    if (!alt) throw new Error('This file has no 3D model inside. Make sure it is a .3mf project or model file.');
    rootPath = alt;
  }

  // parse all .model files lazily
  const modelCache = new Map();
  async function getModel(path) {
    const p = path.replace(/^\//, '');
    if (!modelCache.has(p)) {
      const f = zip.file(p);
      let model = null;
      if (f) {
        const bytes = await f.async('uint8array');
        model = bytes.length > BIG_MODEL_BYTES ? parseModelBytes(bytes) : parseModelFile(new TextDecoder('utf-8').decode(bytes));
      }
      modelCache.set(p, model);
    }
    return modelCache.get(p);
  }
  const root = await getModel(rootPath);
  const unitScale = UNIT_SCALE[root.unit] || 1;
  const scaleT = [unitScale, 0, 0, 0, unitScale, 0, 0, 0, unitScale, 0, 0, 0];

  // flatten each build item into transformed meshes
  async function flatten(path, objectid, transform, out, depth = 0) {
    if (depth > 8) return;
    const model = await getModel(path);
    const obj = model && model.objects.get(objectid);
    if (!obj) return;
    if (obj.mesh && obj.mesh.triangles.length) out.push({ mesh: obj.mesh, transform, sourceId: objectid, sourcePath: path, type: obj.type });
    for (const c of obj.components) {
      await flatten(c.path || path, c.objectid, compose(c.transform, transform), out, depth + 1);
    }
  }

  const items = [];
  for (const b of root.build) {
    const meshes = [];
    await flatten(rootPath, b.objectid, compose(scaleT, b.transform), meshes);
    const rootObj = root.objects.get(b.objectid);
    items.push({ index: items.length, objectId: b.objectid, name: rootObj && rootObj.name, printable: b.printable, meshes, buildTransform: b.transform });
  }

  // settings
  let projectSettings = null;
  const psText = await readText('Metadata/project_settings.config');
  if (psText) {
    try { projectSettings = JSON.parse(psText); } catch { warnings.push('Could not read the embedded slicer settings (project_settings.config).'); }
  }
  const modelSettings = parseModelSettings(await readText('Metadata/model_settings.config'));
  const sliceInfo = parseSliceInfo(await readText('Metadata/slice_info.config'));
  const hasGcode = names.some(n => /\.gcode$/i.test(n));
  if (hasGcode) warnings.push('This is a sliced project with G-code inside. The saved copy keeps the old G-code; re-slice in Orca before printing.');

  // plates
  let plates = modelSettings.plates;
  if (!plates.length) plates = [{ index: 1, name: '', thumbnailFile: null, objectIds: items.map(i => i.objectId) }];
  plates.sort((a, b) => a.index - b.index);

  // images
  const images = [];
  for (const n of names.filter(n => /\.(png|jpe?g)$/i.test(n))) {
    const ext = n.toLowerCase().endsWith('png') ? 'png' : 'jpeg';
    const b64 = await zip.file(n).async('base64');
    images.push({ name: n, label: imageLabel(n), dataUrl: `data:image/${ext};base64,${b64}`, mediaType: `image/${ext}`, base64: b64 });
  }

  // object labels / extruders
  for (const it of items) {
    const ms = modelSettings.objects[it.objectId];
    if (ms && ms.name) it.name = ms.name;
    it.extruder = (ms && ms.extruder) || 1;
    it.overrides = (ms && ms.overrides) || {};
    it.parts = (ms && ms.parts) || [];
    it.painted = it.meshes.reduce((s, m) => s + m.mesh.painted, 0);
    it.paintStates = paintStatesOf(it);
    if (!it.name) it.name = `Object ${it.objectId}`;
  }

  const customLayering = await readCustomLayering(readText, items);
  // Snapmaker Orca color mixes: filament numbers after the real ones, printed with real filaments in turn
  const mixes = parseMixes(projectSettings);
  return { zip, rootPath, names, items, plates, projectSettings, modelSettings, sliceInfo, images, warnings, hasGcode, customLayering, mixes };
}

// Objects with variable layer height (layer_heights_profile.txt) or per-height layer_height ranges
// (layer_config_ranges.xml). Returns item indexes. Format per Snapmaker Orca's bbs_3mf.cpp:
//   profile v2 keys entries by the build item's objectid; legacy v1 and ranges use a 1-based object index.
async function readCustomLayering(readText, items) {
  const out = new Set();
  const prof = await readText('Metadata/layer_heights_profile.txt');
  if (prof) {
    const v2 = /layer_heights_profile_format_version\s*=\s*2/.test(prof);
    for (const line of prof.split(/\r?\n/)) {
      const m = /^object_id=(\d+)\|(.+)$/.exec(line.trim());
      if (!m || m[2].split(';').length < 4) continue;
      const idx = v2 ? items.findIndex(it => it.objectId === m[1]) : Number(m[1]) - 1;
      if (idx >= 0 && idx < items.length) out.add(idx);
    }
  }
  const ranges = await readText('Metadata/layer_config_ranges.xml');
  if (ranges) {
    for (const b of blocks(ranges, 'object')) {
      if (!/opt_key="layer_height"/.test(b.body)) continue;
      const idx = Number(attr(b.attrs, 'id')) - 1;
      if (idx >= 0 && idx < items.length) out.add(idx);
    }
  }
  return [...out];
}

function imageLabel(n) {
  const f = n.split('/').pop().replace(/\.\w+$/, '');
  let m;
  if ((m = /^plate_(\d+)_small$/.exec(f))) return `Plate ${m[1]} (small)`;
  if ((m = /^plate_(\d+)$/.exec(f))) return `Plate ${m[1]}`;
  if ((m = /^top_(\d+)$/.exec(f))) return `Plate ${m[1]} top view`;
  if ((m = /^pick_(\d+)$/.exec(f))) return `Plate ${m[1]} pick map`;
  if ((m = /^plate_no_light_(\d+)$/.exec(f))) return `Plate ${m[1]} (flat light)`;
  if (/^thumbnail/i.test(f)) return 'Thumbnail';
  return f.replace(/_/g, ' ');
}

// ---------- analysis for one plate ----------
// A smaller copy of a triangle soup for the 3D preview (pos: 9 floats per triangle). Points closer together than a
// grid cell are merged into one (their average), and triangles that shrink to a line or a point are left out, so the
// surface stays closed (no see-through holes, as taking every Nth triangle gave). The cell size is grown until about
// `target` triangles are left. Returns { pos, keep }: keep[i] = the file's triangle that shown triangle i came from.
function clusterTris(pos, target) {
  const n = pos.length / 9;
  if (n <= target) return null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  // average edge length (from a sample) sets the first cell size
  let e = 0, m = 0;
  for (let t = 0; t < n; t += Math.max(1, Math.floor(n / 20000))) {
    const o = t * 9; e += Math.hypot(pos[o] - pos[o + 3], pos[o + 1] - pos[o + 4], pos[o + 2] - pos[o + 5]); m++;
  }
  let h = Math.max(1e-4, (e / m) * Math.sqrt(n / target) * 0.75);
  const cid = new Int32Array(n * 3);
  for (let tries = 0; tries < 12; tries++, h *= 1.2) {
    const K = Math.ceil((max[0] - min[0]) / h) + 2, L = Math.ceil((max[1] - min[1]) / h) + 2;
    const cells = new Map();
    for (let c = 0; c < n * 3; c++) {
      const o = c * 3;
      const key = Math.floor((pos[o] - min[0]) / h) + K * (Math.floor((pos[o + 1] - min[1]) / h) + L * Math.floor((pos[o + 2] - min[2]) / h));
      let id = cells.get(key); if (id === undefined) { id = cells.size; cells.set(key, id); }
      cid[c] = id;
    }
    let kept = 0;
    for (let t = 0; t < n; t++) { const a = cid[t * 3], b = cid[t * 3 + 1], c = cid[t * 3 + 2]; if (a !== b && b !== c && a !== c) kept++; }
    if (kept > target * 1.05 && tries < 11) continue;
    // each cell's point: the average of the points merged into it
    const sum = new Float64Array(cells.size * 3), cnt = new Uint32Array(cells.size);
    for (let c = 0; c < n * 3; c++) { const id = cid[c], o = c * 3; sum[id * 3] += pos[o]; sum[id * 3 + 1] += pos[o + 1]; sum[id * 3 + 2] += pos[o + 2]; cnt[id]++; }
    for (let id = 0; id < cnt.length; id++) for (let k = 0; k < 3; k++) sum[id * 3 + k] /= cnt[id];
    const out = new Float32Array(kept * 9), keep = new Uint32Array(kept);
    let j = 0;
    for (let t = 0; t < n; t++) {
      const a = cid[t * 3], b = cid[t * 3 + 1], c = cid[t * 3 + 2];
      if (a === b || b === c || a === c) continue;
      const o = j * 9;
      for (let k = 0; k < 3; k++) { out[o + k] = sum[a * 3 + k]; out[o + 3 + k] = sum[b * 3 + k]; out[o + 6 + k] = sum[c * 3 + k]; }
      keep[j++] = t;
    }
    return { pos: out, keep };
  }
  return null;
}

function analyzePlate(project, plateIndex, rotations = {}, opts = {}) {
  const plate = project.plates.find(p => p.index === plateIndex) || project.plates[0];
  const membership = plateMembership(project);
  let usedItems = project.items.filter(it => it.printable && membership.get(it.index)?.plate === plate.index && membership.get(it.index)?.where === 'inside');
  const partly = project.items.filter(it => it.printable && membership.get(it.index)?.plate === plate.index && membership.get(it.index)?.where === 'partly');
  const parked = project.items.filter(it => membership.get(it.index)?.where === 'outside');
  usedItems.push(...partly);
  if (!usedItems.length) {
    // positions don't line up with any plate (e.g. a plain model placed around 0,0): fall back to the file's plate list
    const idSet = new Set(plate.objectIds);
    usedItems = project.items.filter(it => idSet.has(it.objectId) && it.printable);
    if (!usedItems.length) usedItems = project.items;
  }

  let totalTris = 0;
  for (const it of usedItems) for (const m of it.meshes) if (m.type !== 'support' && m.type !== 'other') totalTris += m.mesh.triangles.length / 3;
  // a very big model: the preview gets a smaller copy of each mesh (measurements use the full mesh)
  const ratio = totalTris > PREVIEW_TRIANGLE_LIMIT ? PREVIEW_TRIANGLE_LIMIT / totalTris : 1;
  let simplified = false;

  const g = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const objects = [];
  const preview = [];

  for (const it of usedItems) {
    // pass 1: transform all triangles into world space
    const worldTris = [];
    for (const m of it.meshes) {
      const { vertices: V, triangles: T } = m.mesh;
      const M = m.transform;
      const out = new Float32Array(T.length * 3);
      for (let t = 0; t < T.length; t++) {
        const i = T[t] * 3;
        const x = V[i], y = V[i + 1], z = V[i + 2];
        out[t * 3] = x * M[0] + y * M[3] + z * M[6] + M[9];
        out[t * 3 + 1] = x * M[1] + y * M[4] + z * M[7] + M[10];
        out[t * 3 + 2] = x * M[2] + y * M[5] + z * M[8] + M[11];
      }
      const part = it.parts.find(pt => pt.id === m.sourceId);
      const subtype = part ? part.subtype : 'normal_part';
      const kind = m.type === 'support' || m.type === 'other' || subtype !== 'normal_part' ? 'modifier' : 'model';
      worldTris.push({ pos: out, kind, subtype, extruder: (part && part.extruder) || it.extruder, paint: m.mesh.paint, meshKey: `${m.sourcePath}#${m.sourceId}` });
    }
    const modelTris = worldTris.filter(w => w.kind === 'model').map(w => w.pos);
    const orientationOptions = opts.orient === false ? null : orientObject(modelTris);
    const rot = rotations[it.index];
    let rotationAffine = null;
    if (rot) {
      rotationAffine = rotationAbout(modelTris, rot);
      for (const w of worldTris) transformInPlace(w.pos, rotationAffine);
    }
    const s = statsFor(modelTris);
    for (let k = 0; k < 3; k++) { g.min[k] = Math.min(g.min[k], s.bbox.min[k]); g.max[k] = Math.max(g.max[k], s.bbox.max[k]); }
    objects.push({
      itemIndex: it.index, name: it.name, extruder: it.extruder, paintedTriangles: it.painted,
      orientationOptions, orientationShortlist: orientationOptions ? shortlist(orientationOptions, 4) : null, rotation: rot || null, rotationAffine,
      // a color mix counts as the real filaments it's printed with
      partExtruders: [...new Set([...it.parts.map(p => p.extruder), ...(it.paintStates || [])].filter(Boolean).flatMap(n => expandMix(n, project.mixes)))],
      paintedExtruders: [...new Set((it.paintStates || []).flatMap(n => expandMix(n, project.mixes)))],
      mixesUsed: [...new Set([it.extruder, ...it.parts.map(p => p.extruder), ...(it.paintStates || [])])].filter(n => (project.mixes || []).some(m => m.id === n)),
      modifierParts: it.parts.filter(p => p.subtype && p.subtype !== 'normal_part').map(p => ({ name: p.name, subtype: p.subtype })),
      overrides: it.overrides, ...s,
    });
    for (const w of worldTris) {
      let pos = w.pos;
      const n0 = pos.length / 9;
      const small = ratio < 1 && n0 > 2000 ? clusterTris(pos, Math.max(1000, Math.floor(n0 * ratio))) : null;
      if (small) simplified = true;
      const pick = small ? small.keep.length : n0;
      const src = (i) => (small ? small.keep[i] : i);
      const sp = small ? small.pos : pos;   // the shown triangle i's corners: sp[i*9 ..]
      let triFilament = null, srcTri = null; // srcTri: which source triangle each shown triangle came from
      if (w.paint && w.kind === 'model') {
        // painted colour: each painted triangle becomes its coloured pieces; 0 = the part's own filament
        const P = [], F = [], SRC = [];
        const cache = new Map();
        for (let i = 0; i < pick; i++) {
          const t = src(i), o = i * 9;
          const str = w.paint[t];
          let tree = null;
          if (str) { tree = cache.get(str); if (tree === undefined) { tree = decodePaint(str); cache.set(str, tree); } }
          if (!tree || F.length > PAINT_PIECE_LIMIT) {
            // past the limit (very fine painting), each triangle gets its main colour so the view stays fast
            for (let k = 0; k < 9; k++) P.push(sp[o + k]);
            F.push(tree ? dominantState(tree) : 0); SRC.push(t);
            continue;
          }
          subdividePaint(tree, [sp[o], sp[o + 1], sp[o + 2]], [sp[o + 3], sp[o + 4], sp[o + 5]], [sp[o + 6], sp[o + 7], sp[o + 8]],
            (a, b, c, st) => { P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); F.push(st); SRC.push(t); });
        }
        pos = Float32Array.from(P);
        triFilament = Uint8Array.from(F);
        srcTri = Uint32Array.from(SRC);
      } else if (small) {
        pos = small.pos;
        srcTri = small.keep;
      }
      preview.push({ name: it.name, extruder: w.extruder, kind: w.kind, subtype: w.subtype, positions: pos, triFilament, srcTri, meshKey: w.meshKey });
    }
  }

  // center plate on origin, sit on z=0
  const cx = (g.min[0] + g.max[0]) / 2, cy = (g.min[1] + g.max[1]) / 2, cz = g.min[2];
  for (const p of preview) {
    const a = p.positions;
    for (let i = 0; i < a.length; i += 3) { a[i] -= cx; a[i + 1] -= cy; a[i + 2] -= cz; }
  }

  const size = [0, 1, 2].map(k => +(g.max[k] - g.min[k]).toFixed(2));
  const sum = (f) => objects.reduce((s, o) => s + f(o), 0);
  const totals = {
    objectCount: objects.length,
    triangles: Math.round(totalTris),
    sizeMm: { x: size[0], y: size[1], z: size[2] },
    volumeCm3: +(sum(o => o.volumeCm3)).toFixed(2),
    surfaceAreaCm2: +(sum(o => o.surfaceAreaCm2)).toFixed(1),
    bedContactAreaCm2: +(sum(o => o.bedContactAreaCm2)).toFixed(2),
    overhangAreaBelow45Cm2: +(sum(o => o.overhangAreaBelow45Cm2)).toFixed(2),
    overhangAreaBelow30Cm2: +(sum(o => o.overhangAreaBelow30Cm2)).toFixed(2),
    flatTopAreaCm2: +(sum(o => o.flatTopAreaCm2)).toFixed(2),
    fitsBuildVolume: size[0] <= getMachine().bed.width && size[1] <= getMachine().bed.depth && size[2] <= getMachine().height,
    paintedTriangles: sum(o => o.paintedTriangles),
    previewSimplified: simplified,
  };
  totals.overhangPercent45 = totals.surfaceAreaCm2 ? +(100 * totals.overhangAreaBelow45Cm2 / totals.surfaceAreaCm2).toFixed(1) : 0;
  totals.overhangPercent30 = totals.surfaceAreaCm2 ? +(100 * totals.overhangAreaBelow30Cm2 / totals.surfaceAreaCm2).toFixed(1) : 0;
  totals.solidMassGrams = { PLA: +(totals.volumeCm3 * 1.24).toFixed(0), PETG: +(totals.volumeCm3 * 1.27).toFixed(0) };

  const extrudersUsed = new Set();
  for (const o of objects) { expandMix(o.extruder, project.mixes).forEach(e => extrudersUsed.add(e)); o.partExtruders.forEach(e => extrudersUsed.add(e)); }
  totals.extrudersUsed = [...extrudersUsed].sort((a, b) => a - b);
  totals.mixesUsed = [...new Set(objects.flatMap(o => o.mixesUsed))].sort((a, b) => a - b);
  totals.tipRatio = Math.max(0, ...objects.map(o => o.heightToBaseRatio));
  const usedSet = new Set(usedItems.map(it => it.index));
  totals.parkedObjects = parked.filter(it => !usedSet.has(it.index)).length;
  totals.partlyOffPlate = partly.map(it => it.name);
  const custom = new Set(project.customLayering || []);
  totals.customLayering = objects.filter(o => custom.has(o.itemIndex)).map(o => o.name);
  totals.multiColor = totals.extrudersUsed.length > 1 || totals.paintedTriangles > 0;

  const sliceForPlate = project.sliceInfo.find(s => s.index === plate.index) || null;
  return { plateIndex: plate.index, plateName: plate.name, objects, totals, slice: sliceForPlate, preview, offset: [cx, cy, cz] };
}

function statsFor(posArrays) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const a of posArrays) for (let i = 0; i < a.length; i += 3) {
    for (let k = 0; k < 3; k++) { const v = a[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  }
  const zMin = min[2], height = max[2] - min[2];
  const bands = 5;
  const overhangByBand = new Array(bands).fill(0);
  let vol = 0, area = 0, bed = 0, ov45 = 0, ov30 = 0, flatTop = 0, lowestOverhangZ = null;
  const cos45 = Math.cos(Math.PI / 4), cos30 = Math.cos(Math.PI / 6);
  for (const a of posArrays) for (let i = 0; i < a.length; i += 9) {
    const ax = a[i], ay = a[i + 1], az = a[i + 2];
    const bx = a[i + 3], by = a[i + 4], bz = a[i + 5];
    const cxx = a[i + 6], cyy = a[i + 7], czz = a[i + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cxx - ax, vy = cyy - ay, vz = czz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!len) continue;
    const triArea = len / 2;
    area += triArea;
    vol += (ax * (by * czz - bz * cyy) - ay * (bx * czz - bz * cxx) + az * (bx * cyy - by * cxx)) / 6;
    const dz = nz / len;
    if (dz > 0.985) flatTop += triArea;
    if (dz < 0) {
      const onBed = az - zMin < 0.05 && bz - zMin < 0.05 && czz - zMin < 0.05;
      if (onBed) { bed += triArea; continue; }
      // slope from horizontal: 0 = flat ceiling, 90 = vertical wall. Supports needed when slope is small.
      const down = -dz; // cos of angle between normal and -Z
      if (down > cos45) {
        ov45 += triArea;
        const zc = (az + bz + czz) / 3 - zMin;
        const band = Math.min(bands - 1, Math.floor((zc / (height || 1)) * bands));
        overhangByBand[band] += triArea;
        if (lowestOverhangZ == null || zc < lowestOverhangZ) lowestOverhangZ = zc;
      }
      if (down > cos30) ov30 += triArea;
    }
  }
  const sx = max[0] - min[0], sy = max[1] - min[1];
  const minFoot = Math.max(0.001, Math.min(sx, sy));
  return {
    bbox: { min, max },
    sizeMm: { x: +sx.toFixed(2), y: +sy.toFixed(2), z: +height.toFixed(2) },
    volumeCm3: +(Math.abs(vol) / 1000).toFixed(2),
    surfaceAreaCm2: +(area / 100).toFixed(1),
    bedContactAreaCm2: +(bed / 100).toFixed(2),
    bedContactPercentOfFootprint: sx * sy ? +(100 * bed / (sx * sy)).toFixed(0) : 0,
    overhangAreaBelow45Cm2: +(ov45 / 100).toFixed(2),
    overhangAreaBelow30Cm2: +(ov30 / 100).toFixed(2),
    overhangByHeightBandCm2: overhangByBand.map(v => +(v / 100).toFixed(2)),
    lowestOverhangZmm: lowestOverhangZ == null ? null : +lowestOverhangZ.toFixed(1),
    flatTopAreaCm2: +(flatTop / 100).toFixed(2),
    heightToBaseRatio: +(height / minFoot).toFixed(2),
    smallestDimensionMm: +Math.min(sx, sy, height).toFixed(2),
  };
}

// ---------- plate membership (same layout rules as Snapmaker Orca's PartPlateList) ----------
// Each plate is the printable area; plates sit in a grid spaced 1.2 bed sizes apart
// (LOGICAL_PART_PLATE_GAP = 1/5), columns = ceil-ish sqrt(plate count), rows go toward -Y.
// extra: optional { itemIndex: 12-number affine } applied after an item's own transforms (e.g. a pending rotation)
function plateMembership(project, extra = {}) {
  const ps = project.projectSettings || {};
  const BEDM = getMachine().bed;
  let bx0 = BEDM.minX, by0 = BEDM.minY, bx1 = BEDM.maxX, by1 = BEDM.maxY;
  if (Array.isArray(ps.printable_area) && ps.printable_area.length >= 3) {
    const pts = ps.printable_area.map(p => String(p).split('x').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
    if (pts.length >= 3) { bx0 = Math.min(...pts.map(p => p[0])); bx1 = Math.max(...pts.map(p => p[0])); by0 = Math.min(...pts.map(p => p[1])); by1 = Math.max(...pts.map(p => p[1])); }
  }
  const w = bx1 - bx0, d = by1 - by0;
  const n = Math.max(1, project.plates.length);
  const v = Math.sqrt(n), r = Math.round(v), cols = v > r ? r + 1 : r;
  const rects = project.plates.map((pl, i) => {
    const row = Math.floor(i / cols), col = i % cols;
    const ox = col * w * 1.2, oy = -row * d * 1.2;
    return { plate: pl.index, x0: ox + bx0, x1: ox + bx1, y0: oy + by0, y1: oy + by1 };
  });
  const tol = 0.5;
  const out = new Map();
  for (const it of project.items) {
    const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
    for (const m of it.meshes) {
      if (m.type === 'support' || m.type === 'other') continue;
      const V = m.mesh.vertices, M = extra[it.index] ? compose(m.transform, extra[it.index]) : m.transform;
      for (let i = 0; i < V.length; i += 3) {
        const x = V[i] * M[0] + V[i + 1] * M[3] + V[i + 2] * M[6] + M[9];
        const y = V[i] * M[1] + V[i + 1] * M[4] + V[i + 2] * M[7] + M[10];
        if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
        if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
      }
    }
    let res = { plate: null, where: 'outside' };
    for (const rc of rects) {
      const inside = min[0] >= rc.x0 - tol && max[0] <= rc.x1 + tol && min[1] >= rc.y0 - tol && max[1] <= rc.y1 + tol;
      const touches = max[0] > rc.x0 && min[0] < rc.x1 && max[1] > rc.y0 && min[1] < rc.y1;
      const bbox = { x0: min[0], x1: max[0], y0: min[1], y1: max[1] };
      if (inside) { res = { plate: rc.plate, where: 'inside', rect: rc, bbox }; break; }
      if (touches && res.where === 'outside') res = { plate: rc.plate, where: 'partly', rect: rc, bbox };
    }
    out.set(it.index, res);
  }
  return out;
}

// ---------- rotation helpers ----------
function transformInPlace(a, M) {
  for (let i = 0; i < a.length; i += 3) {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    a[i] = x * M[0] + y * M[3] + z * M[6] + M[9];
    a[i + 1] = x * M[1] + y * M[4] + z * M[7] + M[10];
    a[i + 2] = x * M[2] + y * M[5] + z * M[8] + M[11];
  }
}
// Affine that rotates world points by R (9, row-vector) about their bbox center and keeps the lowest point at the same Z.
function rotationAbout(posArrays, R) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const a of posArrays) for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) { if (a[i + k] < min[k]) min[k] = a[i + k]; if (a[i + k] > max[k]) max[k] = a[i + k]; }
  const c = [0, 1, 2].map(k => (min[k] + max[k]) / 2);
  const cR = [0, 1, 2].map(j => c[0] * R[j] + c[1] * R[3 + j] + c[2] * R[6 + j]);
  const A = [...R, c[0] - cR[0], c[1] - cR[1], c[2] - cR[2]];
  let newMin = Infinity;
  for (const a of posArrays) for (let i = 0; i < a.length; i += 3) {
    const z = a[i] * A[2] + a[i + 1] * A[5] + a[i + 2] * A[8] + A[11];
    if (z < newMin) newMin = z;
  }
  A[11] += min[2] - newMin;
  return A;
}
// Replace build item transforms in a root .model XML. updates: { itemIndex: 12 numbers }
function setBuildTransforms(xml, updates) {
  let k = -1;
  return xml.replace(/<((?:\w+:)?build)\b[^>]*>[\s\S]*?<\/\1>/, (block) => block.replace(/<((?:\w+:)?item)\b([^>]*?)(\/?)>/g, (m, tag, attrs, close) => {
    k++;
    if (!updates[k]) return m;
    const t = updates[k].map(v => +(+v).toFixed(9)).join(' ');
    const a = /\stransform="/.test(attrs) ? attrs.replace(/\stransform="[^"]*"/, ` transform="${t}"`) : `${attrs} transform="${t}"`;
    return `<${tag}${a}${close}>`;
  }));
}

// ---------- settings summary ----------
function settingsSummary(project) {
  const ps = project.projectSettings || {};
  const current = {};
  for (const key of Object.keys(BY_KEY)) if (key in ps) current[key] = ps[key];
  const context = {};
  for (const key of CONTEXT_KEYS) if (key in ps) context[key] = ps[key];
  return { hasSettings: !!project.projectSettings, current, context };
}

// ---------- writing ----------
function applyChanges(settings, changes) {
  const changedProcess = new Set();
  const changedFilament = new Map(); // slotIndex(0-based) -> Set(keys)
  for (const c of changes) {
    // the curated catalog, or any setting Snapmaker Orca/OrcaSlicer defines (automatic fixes such as the plate type)
    const meta = BY_KEY[c.key] || (SCHEMA[c.key] && { scope: SCHEMA[c.key].scope === 'filament' ? 'filament' : 'process' });
    if (!meta) continue;
    const value = normalize(c.key, c.value);
    const existing = settings[c.key];
    if (meta.scope === 'filament') {
      const slot = Math.max(0, (c.slot || 1) - 1);
      let arr = Array.isArray(existing) ? existing.slice() : [];
      const filamentCount = Array.isArray(settings.filament_settings_id) ? settings.filament_settings_id.length : 1;
      while (arr.length < Math.max(filamentCount, slot + 1)) arr.push(arr.length ? arr[arr.length - 1] : value);
      arr[slot] = value;
      settings[c.key] = arr;
      if (!changedFilament.has(slot)) changedFilament.set(slot, new Set());
      changedFilament.get(slot).add(c.key);
    } else {
      // Process arrays hold [standard nozzle, high-flow nozzle] variants: change the standard entry only.
      if (Array.isArray(existing)) { const arr = existing.slice(); arr[0] = value; settings[c.key] = arr; }
      else settings[c.key] = value;
      changedProcess.add(c.key);
    }
  }
  // mark as modified so Orca shows the orange "changed" markers
  const diff = settings.different_settings_to_system;
  if (Array.isArray(diff) && diff.length) {
    const addTo = (i, keys) => {
      if (i >= diff.length) return;
      const set = new Set((diff[i] || '').split(';').filter(Boolean));
      keys.forEach(k => set.add(k));
      diff[i] = [...set].join(';');
    };
    addTo(0, changedProcess);
    for (const [slot, keys] of changedFilament) addTo(slot + 1, keys);
  }
  return settings;
}

async function writeModified(project, changes) {
  const ps = JSON.parse(JSON.stringify(project.projectSettings || {}));
  applyChanges(ps, changes);
  project.zip.file('Metadata/project_settings.config', JSON.stringify(ps, null, 4));
  const buf = await project.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  // restore so repeated saves start from the original
  project.zip.file('Metadata/project_settings.config', JSON.stringify(project.projectSettings || {}, null, 4));
  return buf;
}

function buildPresets(project, changes, baseName) {
  const ps = project.projectSettings || {};
  const stamp = new Date().toISOString().slice(0, 10);
  const files = [];
  const proc = changes.filter(c => BY_KEY[c.key] && BY_KEY[c.key].scope === 'process');
  if (proc.length) {
    const name = `${baseName} - Advisor ${stamp}`;
    const preset = { type: 'process', name, from: 'User', inherits: ps.print_settings_id || '', print_settings_id: name, version: ps.version || '' };
    if (Array.isArray(ps.compatible_printers) && ps.printer_settings_id) preset.compatible_printers = [ps.printer_settings_id];
    for (const c of proc) {
      preset[c.key] = Array.isArray(ps[c.key]) ? ps[c.key].map(() => String(c.value)) : String(c.value);
    }
    files.push({ fileName: safeName(name) + '.json', json: preset });
  }
  const fil = changes.filter(c => BY_KEY[c.key] && BY_KEY[c.key].scope === 'filament');
  const bySlot = new Map();
  for (const c of fil) { const s = c.slot || 1; if (!bySlot.has(s)) bySlot.set(s, []); bySlot.get(s).push(c); }
  for (const [slot, list] of bySlot) {
    const parent = Array.isArray(ps.filament_settings_id) ? ps.filament_settings_id[slot - 1] : ps.filament_settings_id;
    const name = `${parent || 'Filament'} - Advisor T${slot} ${stamp}`;
    const preset = { type: 'filament', name, from: 'User', inherits: parent || '', filament_settings_id: [name], version: ps.version || '' };
    for (const c of list) preset[c.key] = [String(c.value)];
    files.push({ fileName: safeName(name) + '.json', json: preset });
  }
  return files;
}
function safeName(s) { return s.replace(/[\\/:*?"<>|@]+/g, '_').replace(/\s+/g, ' ').trim(); }

module.exports = { clusterTris, plateMembership, load3mf, analyzePlate, settingsSummary, writeModified, buildPresets, applyChanges, compose, parseTransform, setBuildTransforms, rotationAbout, parseModelBytes, BIG_MODEL_BYTES };
