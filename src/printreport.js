// Print report (Print history → Print report…): what was printed, and the settings each print really used.
// The settings come from the G-code on the printer: Snapmaker Orca writes every setting at the very end of the file
// (; CONFIG_BLOCK_START … ; CONFIG_BLOCK_END, about 30 KB) and the filament totals just above it. Only the end of
// the file is read (an HTTP Range request), so a 200 MB print costs a fraction of a second. Read-only: GET requests.
const http = require('http');
const https = require('https');
const { parseConfigBlock } = require('./gcodeinfo');
const { FILAMENT_KEYS } = require('./orca-settings');

const PER_FILAMENT = new Set(FILAMENT_KEYS);

function baseUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//.test(s)) s = `http://${s}`;
  return s;
}
const encPath = (p) => String(p).split('/').map(encodeURIComponent).join('/');

// GET with an optional byte range; resolves { status, body: Buffer }
function get(url, apiKey, range, ms = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {};
    if (apiKey) headers['X-Api-Key'] = apiKey;
    if (range) headers.Range = range;
    const req = lib.get(u, { headers }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { chunks.push(c); n += c.length; if (n > 8e6) req.destroy(new Error('too large')); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', (e) => reject(new Error(/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT/.test(e.code || e.message) ? 'Printer not reachable' : e.message)));
    req.setTimeout(ms, () => req.destroy(new Error('timed out')));
  });
}

// The end of a G-code file on the printer (or a local file, for the demo): the text from the filament totals on.
async function gcodeTail(printer, filename, readLocal) {
  for (let size of [196608, 2097152]) {
    let text;
    if (readLocal) text = await readLocal(size);
    else {
      const r = await get(`${baseUrl(printer.url)}/server/files/gcodes/${encPath(filename)}`, printer.apiKey, `bytes=-${size}`);
      if (r.status === 404) throw new Error('That G-code is no longer on the printer, so its settings can’t be read.');
      if (r.status !== 200 && r.status !== 206) throw new Error(`The printer answered HTTP ${r.status}`);
      text = r.body.toString('utf8');
      if (r.status === 200) size = Infinity;   // the whole file came back (no Range support): nothing more to read
    }
    if (text.includes('; CONFIG_BLOCK_START') && text.includes('; CONFIG_BLOCK_END')) return text;
    if (size === Infinity) break;
  }
  throw new Error('No Orca settings found at the end of this G-code (it may come from another slicer).');
}

// "; filament used [g] = 283.72, 0.00, 15.21" and friends, just above the settings
function parseFooter(text) {
  const num = (s) => String(s).split(',').map((x) => parseFloat(x)).map((x) => (Number.isFinite(x) ? x : 0));
  const out = {};
  const pick = (re) => { const m = re.exec(text); return m ? m[1].trim() : null; };
  const mm = pick(/^; filament used \[mm\] = (.*)$/m), g = pick(/^; filament used \[g\] = (.*)$/m), cost = pick(/^; filament cost = (.*)$/m);
  if (mm) out.mm = num(mm);
  if (g) out.g = num(g);
  if (cost) out.cost = num(cost);
  const tg = pick(/^; total filament used \[g\] = (.*)$/m), tc = pick(/^; total filament cost = (.*)$/m), ch = pick(/^; total filament change = (.*)$/m);
  if (tg) out.totalG = parseFloat(tg);
  if (tc) out.totalCost = parseFloat(tc);
  if (ch) out.changes = parseInt(ch, 10);
  const est = pick(/^; estimated printing time \(normal mode\) = (.*)$/m);
  if (est) out.estimated = est;
  const layers = pick(/^; total layers count = (.*)$/m);
  if (layers) out.layers = parseInt(layers, 10);
  return out;
}

// ---------------------------------------------------------------- turning settings into report rows
const ON_OFF = (v) => (v === '1' || v === 'true' ? 'On' : v === '0' || v === 'false' ? 'Off' : v);
const UNITS = { mm: ' mm', mms: ' mm/s', acc: ' mm/s²', c: ' °C', pct: '%', deg: '°', mm3: ' mm³/s', layers: ' layers', mm3v: ' mm³' };
function nice(v) {
  if (v == null) return '';
  let s = String(v).replace(/^"|"$/g, '');
  if (s === 'nil' || s === '') return '';
  // enums: "tree(auto)" → "Tree (auto)", "no ironing" → "No ironing", "monotonicline" stays readable
  if (/^[a-z][a-z_ ]*(\([a-z ]+\))?$/.test(s)) s = s.replace(/_/g, ' ').replace(/\(/, ' (').replace(/^./, (c) => c.toUpperCase());
  return s;
}

// [key, label, unit?, how?] how: 'bool' | 'first' (default for process lists) | 'fil' (one value per used filament)
const SECTIONS = [
  ['quality', 'Quality', 'How fine and smooth the surface is.', [
    ['layer_height', 'Layer height', 'mm'], ['initial_layer_print_height', 'First layer height', 'mm'],
    ['line_width', 'Line width', 'mm'], ['outer_wall_line_width', 'Outer wall line width', 'mm'],
    ['seam_position', 'Seam position'], ['seam_slope_type', 'Scarf seam'], ['wall_generator', 'Wall generator'],
    ['wall_sequence', 'Wall order'], ['precise_outer_wall', 'Precise outer wall', null, 'bool'], ['only_one_wall_top', 'Only one wall on top surfaces', null, 'bool'],
    ['ironing_type', 'Ironing'], ['fuzzy_skin', 'Fuzzy skin'], ['elefant_foot_compensation', 'Elephant foot compensation', 'mm'],
    ['resolution', 'Resolution', 'mm'], ['enable_arc_fitting', 'Arc fitting', null, 'bool'],
  ]],
  ['strength', 'Strength', 'Walls, shells and infill: how solid the part is.', [
    ['wall_loops', 'Walls'], ['top_shell_layers', 'Top layers'], ['top_shell_thickness', 'Top shell thickness', 'mm'],
    ['bottom_shell_layers', 'Bottom layers'], ['bottom_shell_thickness', 'Bottom shell thickness', 'mm'],
    ['sparse_infill_density', 'Infill density'], ['sparse_infill_pattern', 'Infill pattern'],
    ['top_surface_pattern', 'Top surface pattern'], ['bottom_surface_pattern', 'Bottom surface pattern'],
    ['internal_solid_infill_pattern', 'Internal solid infill pattern'], ['infill_wall_overlap', 'Infill/wall overlap'],
    ['infill_combination', 'Combine infill', null, 'bool'], ['detect_thin_wall', 'Detect thin walls', null, 'bool'],
  ]],
  ['speed', 'Speed', 'Print speeds and accelerations.', [
    ['outer_wall_speed', 'Outer wall', 'mms'], ['inner_wall_speed', 'Inner walls', 'mms'], ['sparse_infill_speed', 'Infill', 'mms'],
    ['internal_solid_infill_speed', 'Solid infill', 'mms'], ['top_surface_speed', 'Top surface', 'mms'], ['gap_infill_speed', 'Gap fill', 'mms'],
    ['initial_layer_speed', 'First layer', 'mms'], ['initial_layer_infill_speed', 'First layer infill', 'mms'],
    ['bridge_speed', 'Bridges', 'mms'], ['support_speed', 'Support', 'mms'], ['travel_speed', 'Travel', 'mms'],
    ['enable_overhang_speed', 'Slow down for overhangs', null, 'bool'],
    ['default_acceleration', 'Default acceleration', 'acc'], ['outer_wall_acceleration', 'Outer wall acceleration', 'acc'],
    ['inner_wall_acceleration', 'Inner wall acceleration', 'acc'], ['initial_layer_acceleration', 'First layer acceleration', 'acc'],
    ['filament_max_volumetric_speed', 'Max volumetric speed', 'mm3', 'fil'],
  ]],
  ['support', 'Support and adhesion', 'Supports under overhangs, and brim or raft for bed adhesion.', [
    ['enable_support', 'Supports', null, 'bool'], ['support_type', 'Support type'], ['support_style', 'Support style'],
    ['support_threshold_angle', 'Overhang threshold', 'deg'], ['support_on_build_plate_only', 'On build plate only', null, 'bool'],
    ['support_top_z_distance', 'Top Z distance', 'mm'], ['support_bottom_z_distance', 'Bottom Z distance', 'mm'],
    ['support_interface_top_layers', 'Interface top layers'], ['support_interface_spacing', 'Interface spacing', 'mm'],
    ['support_base_pattern', 'Base pattern'], ['support_base_pattern_spacing', 'Base pattern spacing', 'mm'],
    ['support_filament', 'Support filament'], ['support_interface_filament', 'Interface filament'],
    ['tree_support_branch_angle', 'Tree branch angle', 'deg'], ['tree_support_branch_diameter', 'Tree branch diameter', 'mm'],
    ['brim_type', 'Brim'], ['brim_width', 'Brim width', 'mm'], ['raft_layers', 'Raft layers'],
  ]],
  ['multi', 'Multi-material', 'Toolhead changes, prime tower and purging.', [
    ['enable_prime_tower', 'Prime tower', null, 'bool'], ['prime_tower_width', 'Prime tower width', 'mm'],
    ['prime_volume', 'Prime volume', 'mm3v'], ['prime_tower_brim_width', 'Prime tower brim', 'mm'],
    ['flush_into_infill', 'Purge into infill', null, 'bool'], ['flush_into_objects', 'Purge into objects', null, 'bool'],
    ['flush_into_support', 'Purge into support', null, 'bool'], ['flush_multiplier', 'Flush multiplier'],
    ['filament_retract_length_toolchange', 'Retraction on toolchange', 'mm', 'fil'],
  ]],
  ['temps', 'Temperatures and cooling', 'Per filament used.', [
    ['nozzle_temperature_initial_layer', 'Nozzle, first layer', 'c', 'fil'], ['nozzle_temperature', 'Nozzle', 'c', 'fil'],
    ['hot_plate_temp_initial_layer', 'Bed (textured PEI), first layer', 'c', 'fil'], ['hot_plate_temp', 'Bed (textured PEI)', 'c', 'fil'],
    ['fan_min_speed', 'Part fan, min', 'pct', 'fil'], ['fan_max_speed', 'Part fan, max', 'pct', 'fil'],
    ['close_fan_the_first_x_layers', 'No fan for the first', 'layers', 'fil'], ['slow_down_layer_time', 'Slow down if a layer is under', ' s', 'fil'],
    ['filament_flow_ratio', 'Flow ratio', null, 'fil'], ['pressure_advance', 'Pressure advance', null, 'fil'],
  ]],
];

// used: indexes of the filaments this print used (0-based)
function settingsReport(cfg, { used = [0], advisorKeys = [] } = {}) {
  const changed = new Set(advisorKeys);
  const val = (key, unit, how) => {
    const raw = cfg[key];
    if (raw == null) return null;
    const list = Array.isArray(raw) ? raw : String(raw).includes(',') && !/^".*"$/.test(raw) ? String(raw).split(',') : [raw];
    const u = unit ? (UNITS[unit] ?? unit) : '';
    const one = (v) => { v = how === 'bool' ? ON_OFF(String(v).trim()) : nice(String(v).trim()); if (v === '') return ''; if (u && /^-?[\d.]+$/.test(v)) return v + u; return v; };
    if (how === 'fil' || PER_FILAMENT.has(key)) {
      const vals = used.filter((i) => i < list.length).map((i) => ({ i, v: one(list[i]) })).filter((x) => x.v !== '');
      if (!vals.length) return null;
      if (vals.every((x) => x.v === vals[0].v)) return vals[0].v;
      return vals.map((x) => `F${x.i + 1}: ${x.v}`).join(' · ');
    }
    const v = one(list[0]);
    return v === '' ? null : v;
  };
  const sections = [];
  for (const [id, title, blurb, rows] of SECTIONS) {
    let items = rows.map(([key, label, unit, how]) => ({ key, label, value: val(key, unit, how), advisor: changed.has(key) })).filter((r) => r.value != null);
    if (id === 'support' && cfg.enable_support === '0') items = items.filter((r) => !/^(support_|tree_support_)/.test(r.key));
    if (id === 'multi' && used.length < 2) items = items.filter((r) => r.key === 'enable_prime_tower');
    if (items.length) sections.push({ id, title, blurb, items });
  }
  const profiles = {
    process: nice(cfg.print_settings_id), printer: nice(cfg.printer_settings_id),
    filaments: used.map((i) => ({ i, name: nice((cfg.filament_settings_id || [])[i]), type: (cfg.filament_type || [])[i] || '', color: (cfg.filament_colour || [])[i] || '' })),
    nozzle: nice([].concat(cfg.nozzle_diameter || [])[0]), plate: nice(cfg.curr_bed_type), sequence: nice(cfg.print_sequence),
  };
  return { profiles, sections };
}

// ---------------------------------------------------------------- thumbnails
// Moonraker lists the slicer's thumbnails relative to the G-code's folder; the largest is used.
async function thumbnail(printer, job) {
  const t = job.thumb;
  if (!t) return null;
  const dir = String(job.filename).includes('/') ? String(job.filename).replace(/\/[^/]*$/, '/') : '';
  const r = await get(`${baseUrl(printer.url)}/server/files/gcodes/${encPath(dir + t)}`, printer.apiKey, null, 10000);
  if (r.status !== 200 || r.body.length > 3e6) return null;
  return `data:image/png;base64,${r.body.toString('base64')}`;
}

module.exports = { gcodeTail, parseFooter, settingsReport, thumbnail, parseConfigBlock, SECTIONS };
