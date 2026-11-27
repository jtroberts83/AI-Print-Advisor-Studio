// Drives the Snapmaker Orca command line:
//   prepareBase  -> a U1 project with the user's toolhead filaments (converting foreign/plain files)
//   buildVariant -> base + setting changes + rotations
//   slice        -> real slice of one plate: time, grams, G-code analysis, warnings
const { spawn } = require('child_process');
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const JSZip = require('jszip');
const { load3mf, applyChanges, compose, setBuildTransforms, rotationAbout, plateMembership } = require('./threemf');
const { analyzeGcodeFile } = require('./gcode');
const { expand: expandMix } = require('./mixed');
const { ensureThumbnails } = require('./thumbs');
const { setObjectSettings, releaseLayerHeights } = require('./perobject');
const { sanitizeZip, describe: describeFixes, parseRangeErrors, applyRangeErrors, describeFix } = require('./sanitize');
const U1_TEMPLATE = require('./u1-template-settings.json');
const { BY_KEY, CURATED, validate } = require('./orca-settings');
const { DEFAULT_MACHINE } = require('./profiles');
const { getMachine } = require('./machine');

// Creator settings worth carrying over when converting someone else's project to the U1.
// Speeds, accelerations and temperatures are machine/material specific, so they come from the U1 profiles instead.
const PORTABLE = Object.entries(CURATED)
  .filter(([k, c]) => ['Quality', 'Strength', 'Support', 'Adhesion'].includes(c[1]) && !/line_width/.test(k) && !/filament$/.test(k))
  .map(([k]) => k);

const sha = (...parts) => { const h = crypto.createHash('sha1'); for (const p of parts) h.update(p); return h.digest('hex'); };
const first = (v, i = 0) => (Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v);

// Index of the nozzle variant the designer used, for projects in Bambu Studio's per-variant format; null otherwise.
function variantIndex(ps) {
  if (!ps || !Array.isArray(ps.print_extruder_variant) || ps.print_extruder_variant.length < 2) return null;
  const type = Array.isArray(ps.extruder_type) ? ps.extruder_type[0] : ps.extruder_type;
  const vol = Array.isArray(ps.nozzle_volume_type) ? ps.nozzle_volume_type[0] : ps.nozzle_volume_type;
  const want = `${type || 'Direct Drive'} ${vol || 'Standard'}`.toLowerCase();
  const i = ps.print_extruder_variant.findIndex(v => String(v).toLowerCase() === want);
  return i >= 0 ? i : 0;
}

class Slicer {
  constructor({ exe, lib, workDir, wrapper, concurrency }) {
    this.exe = exe;
    this.lib = lib;
    this.workDir = workDir;
    this.dataDir = path.join(workDir, 'orca-data');
    this.cacheDir = path.join(workDir, 'slice-cache');
    this.wrapper = wrapper || (process.env.U1_SLICER_WRAPPER ? process.env.U1_SLICER_WRAPPER.split(' ') : null);
    this.limit = concurrency || Math.max(1, Math.min(3, Math.floor(os.cpus().length / 2)));
    this.active = 0;
    this.queue = [];
  }

  get available() { return !!(this.exe && fss.existsSync(this.exe) && this.lib && this.lib.available); }

  // token (optional): { cancelled, children: Set } from cancelToken(); cancelling kills its running slicer processes and
  // stops queued slices before they start
  static cancelToken() {
    const t = { cancelled: false, children: new Set() };
    t.cancel = () => { t.cancelled = true; for (const c of t.children) { try { c.kill(); } catch {} } };
    return t;
  }
  static cancelledError() { const e = new Error('Cancelled.'); e.cancelled = true; return e; }

  async run(args, outDir, timeoutMs = 15 * 60 * 1000, token = null) {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    const full = ['--datadir', this.dataDir, ...args];
    const [cmd, ...pre] = this.wrapper ? [...this.wrapper, this.exe] : [this.exe];
    return new Promise((resolve) => {
      const child = spawn(cmd, [...pre, ...full], { cwd: outDir, windowsHide: true });
      if (token) { token.children.add(child); if (token.cancelled) child.kill(); }
      let log = '';
      const keep = (d) => { log += d.toString(); if (log.length > 20000) log = log.slice(-20000); };
      child.stdout.on('data', keep); child.stderr.on('data', keep);
      const timer = setTimeout(() => { child.kill(); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, result: null, log: String(e) }); });
      child.on('close', async (code) => {
        clearTimeout(timer);
        if (token) token.children.delete(child);
        let result = null;
        try { result = JSON.parse(await fs.readFile(path.join(outDir, 'result.json'), 'utf8')); } catch {}
        resolve({ code, result, log: log.slice(-3000) });
      });
    });
  }

  // limit parallel slicer processes
  async schedule(fn) {
    if (this.active >= this.limit) await new Promise(r => this.queue.push(r));
    this.active++;
    try { return await fn(); } finally { this.active--; const n = this.queue.shift(); if (n) n(); }
  }

  failure(r, what) {
    const tail = (r.log || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !/exclude triangles|sentry|Sentry|^\[.*\] \[(trace|debug|info)\]/.test(l)).slice(-3).join(' | ');
    const known = [
      [/large difference of temperature|different_temp|FILAMENTS_DIFFERENT_TEMP/i, `These filaments print at very different temperatures and ${this.label} won’t combine them on one plate. Change one toolhead to a material from the same group (PETG works with both PLA and ABS-type filaments).`],
      [/no object fully inside|plate is empty|Nothing to be sliced/i, 'Nothing on this plate is fully inside the print area. Move the parts onto the plate in Orca, or pick another plate.'],
      [/Not a variable name|invalid custom G-code|Parsing error at line/i, `The file’s custom G-code (start, end or filament change) was written for a newer slicer and uses settings your ${this.label} doesn’t know. Open the file again in this version of the app, which swaps it for your ${this.label}’s own G-code, or update ${this.label}.`],
      [/exceeds the maximum build volume/i, `Part of the model is taller than the ${getMachine().height} mm build height. Lay it down or scale it in the slicer.`],
    ].find(([re]) => re.test(r.log || '') || re.test((r.result && r.result.error_string) || ''));
    if (known) { const e = new Error(`${what}: ${known[1]}`); e.log = r.log; return e; }
    // the slicer's own explanation (e.g. "empty layer between 17.24 and 17.96"), where it writes one (not on Windows)
    const detail = r.result && Array.isArray(r.result.sliced_plates) ? r.result.sliced_plates.map(p => p.warning_message).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() : '';
    const failedSlicing = r.code === -100 || r.code === 4294967196;
    const msg = r.result && r.result.error_string && !/^Success/.test(r.result.error_string) ? `${r.result.error_string.trim()}${detail ? ` ${detail}` : ''}`
      : failedSlicing ? `${this.label} couldn’t slice this version. This often means a thin detail disappears at this layer height and leaves an empty layer.`
      : r.code === -1 ? `Could not start ${this.label} (${r.log})`
      : (/^(3221225477|3221226505|3221225725|139|-1073741819|-1073740791)$/.test(String(r.code))
        ? `${this.label} crashed while reading this project (exit code ${r.code}). This usually means the file uses something ${this.label} can’t handle; the app retries other ways automatically where it can. If it keeps happening with one file, please report it with that file.`
        : `${this.label} stopped without producing output (exit code ${r.code})${tail ? `: ${tail}` : ''}`);
    const e = new Error(`${what}: ${msg}`);
    e.log = r.log; e.code = r.code; e.failedSlicing = failedSlicing || /empty layer/i.test(detail);
    return e;
  }

  async writeJson(dir, name, obj) {
    const p = path.join(dir, name);
    await fs.writeFile(p, JSON.stringify(obj));
    return p;
  }

  // ---------- base project ----------
  // per-slicer command-line differences (Bambu Studio's --allow-newer-file takes a value)
  allowNewer() { return (this.lib && this.lib.slicer && this.lib.slicer.cli && this.lib.slicer.cli.allowNewer) || ['--allow-newer-file']; }
  get label() { return (this.lib && this.lib.slicer && this.lib.slicer.label) || 'Snapmaker Orca'; }
  get targetMachine() { return (this.lib && this.lib.machine) || DEFAULT_MACHINE; }

  // opts.carryFrom: the original file's settings, when converting a stripped or rebuilt copy (fallbacks), so
  // the designer's quality/strength/support choices are still carried over
  async prepareBase(originalBuffer, project, slots, opts = {}) {
    // test hook: simulate a conversion failure (first attempt only, or every attempt)
    const force = process.env.U1_TEST_FAIL_CONVERSION;
    if (force && project && project.projectSettings && Object.keys(project.projectSettings).length) throw new Error('simulated conversion failure');
    if (force === 'all') throw new Error('simulated conversion failure');
    // an incomplete settings file (partial or hand-made) is treated as a plain model
    let ps = project.projectSettings || null;
    // (a real slicer project has hundreds of settings; a few dozen means generic defaults would fill the gaps)
    if (ps && Object.keys(ps).length < 100) {
      originalBuffer = await Slicer.stripToModel(originalBuffer);
      project = await load3mf(originalBuffer);
      ps = null;
    }
    // already set up for the selected printer? (name, or the same printer model, e.g. a user's copy of the preset)
    const target = this.targetMachine, M = getMachine();
    const isU1 = !!ps && (String(ps.printer_settings_id || '') === target || (!!M.model && String(ps.printer_model || '') === M.model) ||
      (target === DEFAULT_MACHINE && (/U1/.test(String(ps.printer_settings_id || '')) || /U1/.test(String(ps.printer_model || '')))));
    const notes = [];
    // A printer with one nozzle and no filament changer prints one material per job: put every part on
    // filament 1 (color changes can still be added by hand in the slicer).
    if (M.multiMaterial === 'single') {
      const remapped = await Slicer.singleMaterial(originalBuffer);
      if (remapped) {
        originalBuffer = remapped.buffer;
        project = await load3mf(originalBuffer);
        slots = slots.filter(x => x.slot === 1);
        notes.push(`The ${M.short || 'printer'} prints one material at a time, so all ${remapped.parts} part${remapped.parts === 1 ? '' : 's'} that used other filaments now use filament 1. Add color changes in the slicer if you want to swap spools by hand.`);
      }
    }
    // Newer Bambu Studio projects (dual-nozzle era) store settings per nozzle variant: process settings hold one
    // value per variant and filament settings one per filament × variant. Older Orca-based slicers crash reading
    // them, so the model is converted without them and the designer's settings are carried over below, using the
    // values for the nozzle the designer actually used.
    const vIdx = isU1 ? null : variantIndex(ps || opts.carryFrom);
    let cliBuffer = originalBuffer, cliProject = project;
    if (vIdx != null && ps) {
      cliBuffer = await Slicer.stripToModel(originalBuffer);
      cliProject = await load3mf(cliBuffer);
    }
    // more filament numbers in use than the printer has toolheads (e.g. 1, 3 and 5 on a 4-toolhead U1):
    // renumber the ones in use to fit, so every part lands on a real toolhead
    let slotMap = null;
    if (M.multiMaterial === 'toolheads' && !isU1) {
      const c = await Slicer.compactFilaments(cliBuffer, M.extruders || 4, cliProject);
      if (c) {
        slotMap = c.map;
        cliBuffer = c.buffer; cliProject = await load3mf(cliBuffer);
        if (vIdx == null) { originalBuffer = cliBuffer; project = cliProject; }
        const moved = Object.entries(c.map).filter(([o, n]) => +o !== n);
        if (moved.length) notes.push(`The model used filament numbers ${Object.keys(c.map).join(', ')}, but the ${M.short || 'printer'} has toolheads 1–${M.extruders || 4}, so they’re now ${Object.entries(c.map).map(([o, n]) => `${o} → T${n}`).join(', ')}${c.merged ? ` (${c.merged} more than the ${M.extruders} toolheads, so those share T1)` : ''}.`);
        // only the filaments still in use, at their new numbers
        slots = slots.filter(x => c.map[x.slot]).map(x => ({ ...x, slot: c.map[x.slot] })).filter((x, i, a) => a.findIndex(y => y.slot === x.slot) === i);
      }
    }
    const fileCount = vIdx != null || slotMap ? 0 : (ps && Array.isArray(ps.filament_settings_id) ? ps.filament_settings_id.length : 0);
    // (a Snapmaker Orca color mix is printed with the real filaments in its recipe: those are the ones to load)
    const used = Math.max(1, ...cliProject.items.flatMap(it => [it.extruder, ...it.parts.map(p => p.extruder || 0), ...(it.paintStates || [])]).flatMap(n => expandMix(n, cliProject.mixes)));
    // a single-material printer gets exactly one filament (extra listed filaments still affect bed temperature)
    let count = Math.max(used, fileCount, slots.length ? Math.max(...slots.map(s => s.slot)) : 1);
    // a toolhead printer can't take more filaments than it has toolheads (Snapmaker Orca crashes on a U1 asked
    // to load 7); when the file's own list is longer, convert a copy without it
    if (M.multiMaterial === 'toolheads' && M.extruders && count > M.extruders && !isU1) {
      if (fileCount > M.extruders && ps) throw new Error(`the file lists ${fileCount} filaments but the ${M.short || 'printer'} has ${M.extruders} toolheads`);
      count = Math.max(used, Math.min(count, M.extruders));
    }
    const presetFor = (n) => {
      const s = slots.find(x => x.slot === n);
      if (s && s.preset) return s.preset;
      if (!slotMap && vIdx == null && ps && Array.isArray(ps.filament_settings_id) && ps.filament_settings_id[n - 1] && this.lib.byType.filament.has(ps.filament_settings_id[n - 1])) return ps.filament_settings_id[n - 1];
      return this.lib.presetForMaterial((s && s.type) || 'PLA');
    };
    // single-material printers: the slicer won't load fewer filaments than the file lists, so every position gets
    // the chosen filament (all parts use filament 1, and the bed temperature then comes from that one material)
    const wanted = Array.from({ length: count }, (_, i) => presetFor(M.multiMaterial === 'single' ? 1 : i + 1));
    const same = isU1 && fileCount >= count && wanted.every((p, i) => ps.filament_settings_id[i] === p);

    let buffer = originalBuffer;
    let mode = 'original';
    if (!same) {
      const key = sha(cliBuffer, JSON.stringify(wanted), String(isU1), this.exe || '', target, 'v2');
      const dir = path.join(this.workDir, 'prepare', key);
      const out = path.join(dir, 'base.3mf');
      if (!fss.existsSync(out)) {
        await fs.mkdir(dir, { recursive: true });
        const input = path.join(dir, 'input.3mf');
        let filPresets = null;
        try { filPresets = wanted.map(n => this.lib.flatten('filament', n)); } catch {}
        await fs.writeFile(input, await Slicer.cliReady(cliBuffer, cliProject, { ...this.cliOptions(), filaments: filPresets }));
        const filPaths = [];
        for (let i = 0; i < wanted.length; i++) filPaths.push(await this.writeJson(dir, `filament${i + 1}.json`, this.lib.flatten('filament', wanted[i])));
        const args = [...this.allowNewer(), '--load-filaments', filPaths.join(';')];
        if (!isU1) {
          const layer = ps && ps.layer_height ? +first(ps.layer_height) : 0.2;
          const procName = this.lib.processForLayer(layer || 0.2);
          const proc = this.lib.flatten('process', procName);
          delete proc.wipe_tower_filament; // crashes the CLI when loaded from a settings file
          const m = await this.writeJson(dir, 'machine.json', this.lib.flatten('machine', target));
          const p = await this.writeJson(dir, 'process.json', proc);
          args.unshift('--load-settings', `${m};${p}`);
          notes.push(ps ? `Converted from ${ps.printer_settings_id || 'another printer'} to the ${M.model || target} using “${procName}”.` : `Plain model: set up with “${procName}” for the ${M.model || target}.`);
        } else {
          notes.push('Swapped toolhead filaments to match your selection.');
        }
        let r;
        for (let attempt = 0; attempt < 3; attempt++) {
          r = await this.run([...args, '--outputdir', dir, '--export-3mf', 'base.3mf', input], dir, 5 * 60 * 1000);
          if (fss.existsSync(out)) break;
          const ranges = parseRangeErrors(r.log);
          if (!ranges.length) break;
          const zip = await JSZip.loadAsync(await fs.readFile(input));
          const fixes = await applyRangeErrors(zip, ranges);
          if (!fixes.length) break;
          notes.push(`Corrected ${fixes.map(describeFix).join('; ')}.`);
          await fs.writeFile(input, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
        }
        if (!fss.existsSync(out)) throw this.failure(r, `Preparing the project for the ${M.short || 'printer'} failed`);
      } else if (!isU1) notes.push(ps ? `Converted from ${ps.printer_settings_id || 'another printer'} to the ${M.model || target}.` : `Plain model: set up for the ${M.model || target}.`);
      buffer = await fs.readFile(out);
      mode = isU1 ? 'filament-swap' : 'converted';
    }

    // creator's own tuning survives conversion; colors follow the toolhead swatches
    const zip = await JSZip.loadAsync(buffer);
    const legacy = await sanitizeZip(zip);
    if (legacy.length) notes.push(`Corrected ${legacy.length} out-of-range setting${legacy.length === 1 ? '' : 's'} from an older or different slicer, as ${this.label} does when opening the file: ${describeFixes(legacy)}.`);
    const base = JSON.parse(await zip.file('Metadata/project_settings.config').async('string'));
    const carried = [];
    const cps = ps || opts.carryFrom;
    if (mode === 'converted' && cps) {
      const nVar = vIdx != null && Array.isArray(cps.print_extruder_variant) ? cps.print_extruder_variant.length : 0;
      for (const k of PORTABLE) {
        if (!(k in cps)) continue;
        // per-variant lists: the value for the designer's nozzle
        const raw = cps[k];
        const v = String(Array.isArray(raw) && nVar > 1 && raw.length === nVar ? raw[vIdx] : first(raw));
        if (validate(k, v) || String(first(base[k])) === v) continue;
        carried.push({ key: k, value: v });
      }
      applyChanges(base, carried);
      if (carried.length) notes.push(`Kept the creator's ${carried.length} quality/strength/support setting${carried.length === 1 ? '' : 's'}${vIdx != null ? ` (from their ${String(cps.print_extruder_variant[vIdx] || 'main nozzle').toLowerCase()} nozzle settings; this file uses a newer Bambu Studio format that’s converted separately)` : ''}.`);
    }
    if (Array.isArray(base.filament_colour)) {
      for (const s of slots) if (s.color && s.slot <= base.filament_colour.length) base.filament_colour[s.slot - 1] = s.color.toUpperCase();
    }
    zip.file('Metadata/project_settings.config', JSON.stringify(base, null, 4));
    const finalBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return { buffer: finalBuffer, settings: base, mode, notes, carried, slotMap, project: await load3mf(finalBuffer) };
  }

  // ---------- variants ----------
  // rotations: { itemIndex: 9-number rotation } applied relative to the base project's own placement
  static async buildVariant(baseBuffer, opts = {}) {
    return (await Slicer.buildVariantDetailed(baseBuffer, opts)).buffer;
  }

  // Returns { buffer, corrections } where corrections are plain-language notes of automatic fixes.
  // project: the already-parsed project for baseBuffer (optional). Passing it avoids re-reading large meshes.
  // changes: project-wide settings [{key, value, slot}]; objectChanges: per-object settings { [objectId]: [{key, value}] }
  // (src/perobject.js), for files whose objects need different settings
  // shift: { plate, dx, dy } moves that plate's objects (mm), e.g. so a brim or skirt stays on the bed
  static async buildVariantDetailed(baseBuffer, { changes = [], objectChanges = null, rotations = {}, project = null, shift = null } = {}) {
    const corrections = [];
    const zip = await JSZip.loadAsync(baseBuffer);
    for (const n of Object.keys(zip.files)) if (/^Metadata\/(plate_\d+\.gcode(\.md5)?|slice_info\.config)$/.test(n)) zip.remove(n);
    const psFile = zip.file('Metadata/project_settings.config');
    if (psFile && changes.length) {
      const ps = JSON.parse(await psFile.async('string'));
      applyChanges(ps, changes);
      zip.file('Metadata/project_settings.config', JSON.stringify(ps, null, 4));
    }
    // A new layer height only takes effect where the model doesn't set its own: release those (per-object layer
    // heights, variable layer height profiles) for every object (project-wide change) or the objects concerned
    const oc = objectChanges && Object.keys(objectChanges).length ? objectChanges : null;
    const lhObjects = oc ? Object.keys(oc).filter(id => oc[id].some(c => c.key === 'layer_height')) : [];
    if (changes.some(c => c.key === 'layer_height')) {
      corrections.push(...(await releaseLayerHeights(zip, null, Object.fromEntries(lhObjects.map(id => [id, true])))));
    } else if (lhObjects.length) {
      corrections.push(...(await releaseLayerHeights(zip, lhObjects, Object.fromEntries(lhObjects.map(id => [id, true])))));
    }
    if (oc) {
      const msFile = zip.file('Metadata/model_settings.config');
      if (msFile) {
        const r = setObjectSettings(await msFile.async('string'), oc);
        zip.file('Metadata/model_settings.config', r.xml);
      }
    }
    const rotKeys = Object.keys(rotations).filter(k => rotations[k]);
    const proj = project || await load3mf(baseBuffer);
    const affines = {}, transforms = {};
    const shifted = new Set();
    const T = shift && (shift.dx || shift.dy) ? [1, 0, 0, 0, 1, 0, 0, 0, 1, shift.dx || 0, shift.dy || 0, 0] : null;
    if (T) {
      const mem = plateMembership(proj);
      for (const it of proj.items) { const m = mem.get(it.index); if (m && m.plate === shift.plate && m.where !== 'outside') shifted.add(it.index); }
    }
    if (rotKeys.length) {
      for (const k of rotKeys) {
        const it = proj.items[+k];
        if (!it) continue;
        const A = rotationAbout(worldTris(it), rotations[k]);
        affines[+k] = A;
        transforms[+k] = compose(it.buildTransform, A);
      }
    }
    // then the move, on top of the placement (and rotation)
    for (const i of shifted) transforms[i] = compose(transforms[i] || proj.items[i].buildTransform, T);
    if (Object.keys(transforms).length) {
      const xml = await zip.file(proj.rootPath).async('string');
      zip.file(proj.rootPath, setBuildTransforms(xml, transforms));
      if (shifted.size) corrections.push(`Moved the print ${[shift.dy ? `${Math.abs(shift.dy)} mm ${shift.dy > 0 ? 'toward the back' : 'toward the front'}` : '', shift.dx ? `${Math.abs(shift.dx)} mm ${shift.dx > 0 ? 'to the right' : 'to the left'}` : ''].filter(Boolean).join(' and ')} so all of it (brim and skirt included) stays on the bed.`);
    }
    corrections.push(...(await sanitizeZip(zip)).map(describeFix));
    corrections.push(...(await Slicer.nudgeOntoPlates(zip, proj, affines, transforms)));
    corrections.push(...(await Slicer.uniqueObjectNames(zip)));
    corrections.push(...(await Slicer.plateBedTypes(zip)));
    await ensureThumbnails(zip);
    return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), corrections };
  }

  // A plate can carry its own bed_type (model_settings plate metadata), overriding curr_bed_type. Apply the same
  // rule as the project setting: if a filament on that plate isn't supported there, switch to a supported plate.
  static async plateBedTypes(zip) {
    // The CLI heats the bed from each plate's own bed_type and ignores curr_bed_type when a plate has none
    // (verified: no per-plate entry -> 35 °C cool-plate value; with "Textured PEI Plate" -> 80 °C). The desktop
    // app falls back to curr_bed_type. Write every plate's bed_type explicitly so both agree, and make sure
    // it supports the filaments on that plate.
    const { supportedPlate } = require('./compat');
    const f = zip.file('Metadata/model_settings.config'), pf = zip.file('Metadata/project_settings.config');
    if (!f || !pf) return [];
    let xml = await f.async('string');
    if (!/<plate>/.test(xml)) return [];
    const ps = JSON.parse(await pf.async('string'));
    // toolheads in use, straight from the object/part extruder entries (no need to read the meshes)
    const used = new Set();
    for (const ob of xml.matchAll(/<object\b[^>]*>([\s\S]*?)<\/object>/g)) {
      const own = ob[1].replace(/<part\b[\s\S]*?<\/part>/g, '');
      const e = /<metadata key="extruder" value="(\d+)"/.exec(own);
      used.add(e ? +e[1] : 1); // an object without an extruder entry prints with T1
      for (const pm of ob[1].matchAll(/<part\b[\s\S]*?<\/part>/g)) { const pe = /<metadata key="extruder" value="(\d+)"/.exec(pm[0]); if (pe && +pe[1] > 0) used.add(+pe[1]); }
    }
    if (!used.size) used.add(1);
    const projectPlate = String(Array.isArray(ps.curr_bed_type) ? ps.curr_bed_type[0] : ps.curr_bed_type || 'Textured PEI Plate');
    const notes = [];
    xml = xml.replace(/<plate>([\s\S]*?)<\/plate>/g, (m, body) => {
      const cur = (/<metadata key="bed_type" value="([^"]*)"\s*\/>/.exec(body) || [])[1];
      // single-bed printers: per-plate overrides are reset to the global type, as OrcaSlicer does
      let plate = getMachine().supportsBedTypes === false ? projectPlate : (cur || projectPlate);
      const alt = supportedPlate(ps, plate, [...used]);
      if (alt) { notes.push(`A plate was set to ${plate}, which a filament on it doesn’t support (bed would stay cold). Switched it to ${alt.plate}.`); plate = alt.plate; }
      if (cur === plate) return m;
      const tag = `<metadata key="bed_type" value="${plate}"/>`;
      body = cur ? body.replace(/<metadata key="bed_type" value="[^"]*"\s*\/>/, tag) : body.replace(/(<metadata key="plater_id"[^>]*\/>)/, `$1\n    ${tag}`);
      return `<plate>${body}</plate>`;
    });
    zip.file('Metadata/model_settings.config', xml);
    return notes;
  }

  // Duplicate object names are hard to tell apart in the U1's Skip Objects list: "Bracket", "Bracket 2", ...
  static async uniqueObjectNames(zip) {
    const f = zip.file('Metadata/model_settings.config');
    if (!f) return [];
    const xml = await f.async('string');
    const counts = {};
    const renamed = [];
    const out = xml.replace(/(<object id="[^"]*">\s*(?:<metadata[^>]*\/>\s*)*?)<metadata key="name" value="([^"]*)"\s*\/>/g, (m, pre, name) => {
      counts[name] = (counts[name] || 0) + 1;
      if (counts[name] === 1) return m;
      const nn = `${name} ${counts[name]}`;
      renamed.push(nn);
      return `${pre}<metadata key="name" value="${nn}"/>`;
    });
    if (!renamed.length) return [];
    zip.file('Metadata/model_settings.config', out);
    return [`Renamed ${renamed.length} duplicate object name${renamed.length === 1 ? '' : 's'} (${renamed.slice(0, 4).join(', ')}${renamed.length > 4 ? '…' : ''}) so each part can be told apart when skipping objects on the printer.`];
  }

  // Objects hanging over a plate edge make Snapmaker Orca refuse the whole plate. When an object fits,
  // slide it the shortest distance that puts it fully on its plate (objects parked fully off are left alone).
  static async nudgeOntoPlates(zip, proj, affines = {}, transforms = {}) {
    const notes = [];
    if (!proj) proj = await load3mf(await zip.generateAsync({ type: 'nodebuffer' }));
    const mem = plateMembership(proj, affines);
    const updates = {};
    for (const it of proj.items) {
      const m = mem.get(it.index);
      if (!m || m.where !== 'partly' || !m.rect || !m.bbox) continue;
      const { rect, bbox } = m;
      const w = bbox.x1 - bbox.x0, d = bbox.y1 - bbox.y0;
      if (w > rect.x1 - rect.x0 || d > rect.y1 - rect.y0) { notes.push(`${it.name} is larger than the plate and hangs over its edge; move or scale it in Orca.`); continue; }
      const dx = bbox.x0 < rect.x0 ? rect.x0 - bbox.x0 + 1 : bbox.x1 > rect.x1 ? rect.x1 - bbox.x1 - 1 : 0;
      const dy = bbox.y0 < rect.y0 ? rect.y0 - bbox.y0 + 1 : bbox.y1 > rect.y1 ? rect.y1 - bbox.y1 - 1 : 0;
      updates[it.index] = compose(transforms[it.index] || it.buildTransform, [1, 0, 0, 0, 1, 0, 0, 0, 1, dx, dy, 0]);
      notes.push(`Moved ${it.name} ${Math.round(Math.hypot(dx, dy))} mm so it sits fully on plate ${m.plate} (it hung over the edge, which Orca won’t slice).`);
    }
    if (Object.keys(updates).length) zip.file(proj.rootPath, setBuildTransforms(await zip.file(proj.rootPath).async('string'), updates));
    return notes;
  }

  // Detects the G-code path conflict failure (result.json on Mac/Linux, log text everywhere).
  static conflictIn(r) {
    const coded = r.result && r.result.return_code === -101;
    const m = /gcode path conflicts found between (.+?) and (.+?)\s*$/m.exec(r.log || '');
    if (!coded && !m && !(r.code === -101 || r.code === 4294967195)) return null;
    const a = m ? m[1].trim() : 'two objects', b = m ? m[2].trim() : '';
    return {
      objects: m ? [a, b] : [],
      message: `Toolpaths of ${a}${b ? ` and ${b}` : ''} overlap (a G-code path conflict). Snapmaker Orca shows this as a warning and still slices, but those objects touch or intersect, so one may print into the other. If they belong together, select them in Orca, right-click and choose Assemble to make them one object; otherwise move them apart.`,
    };
  }

  // Make any 3MF safe to hand to the CLI on every platform: plate data, all four plate thumbnails
  // (so the CLI never needs OpenGL), and, for plain models, a complete settings file to convert from.
  // Every object and part on filament 1. Returns null when nothing used another filament.
  static async singleMaterial(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const f = zip.file('Metadata/model_settings.config');
    if (!f) return null;
    let n = 0;
    const xml = (await f.async('string')).replace(/<metadata key="extruder" value="(\d+)"\s*\/>/g, (m, v) => { if (+v > 1) { n++; return '<metadata key="extruder" value="1"/>'; } return m; });
    if (!n) return null;
    zip.file('Metadata/model_settings.config', xml);
    return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), parts: n };
  }

  // Built-in conversion, without the slicer reading the foreign file: geometry is rebuilt from the model's
  // shapes and the project settings are assembled here from the target printer's own presets (machine,
  // process, filaments), on top of a complete project template, with the designer's settings carried over.
  // The slicer then only has to slice a native project. Used when the slicer crashes reading a file.
  async nativeConvert(project, slots, carryFrom = null) {
    const M = getMachine();
    const lib = this.lib;
    const target = this.targetMachine;
    const notes = [];
    let buf = await Slicer.rebuildFromGeometry(project);
    let slotMap = null;
    if (M.multiMaterial === 'single') {
      const r = await Slicer.singleMaterial(buf);
      if (r) { buf = r.buffer; slots = slots.filter(x => x.slot === 1); notes.push(`The ${M.short || 'printer'} prints one material at a time, so every part now uses filament 1.`); }
    } else if (M.multiMaterial === 'toolheads') {
      const c = await Slicer.compactFilaments(buf, M.extruders || 4, await load3mf(buf));
      if (c) {
        buf = c.buffer; slotMap = c.map;
        slots = slots.filter(x => c.map[x.slot]).map(x => ({ ...x, slot: c.map[x.slot] })).filter((x, i, a) => a.findIndex(y => y.slot === x.slot) === i);
        notes.push(`The model used filament numbers ${Object.keys(c.map).join(', ')}, but the ${M.short || 'printer'} has toolheads 1–${M.extruders || 4}, so they’re now ${Object.entries(c.map).map(([o, n]) => `${o} → T${n}`).join(', ')}.`);
      }
    }
    const proj = await load3mf(buf);
    const used = Math.max(1, ...proj.items.flatMap(it => [it.extruder || 1, ...it.parts.map(p => p.extruder || 0), ...(it.paintStates || [])]).flatMap(n => expandMix(n, proj.mixes)));
    let count = Math.max(used, slots.length ? Math.max(...slots.map(s => s.slot)) : 1);
    if (M.multiMaterial === 'toolheads' && M.extruders) count = Math.max(used, Math.min(count, M.extruders)); // never more than the toolheads
    if (M.multiMaterial === 'single') count = 1;
    const presetFor = (n) => (slots.find(x => x.slot === n) || {}).preset || lib.presetForMaterial((slots.find(x => x.slot === n) || {}).type || 'PLA');
    const filaments = Array.from({ length: count }, (_, i) => lib.flatten('filament', presetFor(i + 1)));
    const procName = lib.defaultProcess();
    const machine = lib.flatten('machine', target), process_ = lib.flatten('process', procName);
    // a complete key set: the U1 template, or for other printers the printer + process presets themselves
    const skip = new Set(['name', 'inherits', 'from', 'instantiation', 'type', 'version', 'setting_id', 'filament_id', 'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition', 'renamed_from']);
    const t = M.isU1 ? JSON.parse(JSON.stringify(U1_TEMPLATE)) : {};
    for (const src of [machine, process_]) for (const [k, v] of Object.entries(src)) if (!skip.has(k)) t[k] = v;
    // filaments: one entry per filament in every per-filament list
    const oldN = Array.isArray(t.filament_settings_id) ? t.filament_settings_id.length : 0;
    const fkeys = new Set(filaments.flatMap(f => Object.keys(f)).filter(k => !skip.has(k)));
    for (const k of fkeys) t[k] = filaments.map(f => { const v = f[k] ?? filaments[0][k]; return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''); });
    const { SCHEMA } = require('./orca-settings');
    for (const [k, v] of Object.entries(t)) {
      if (!Array.isArray(v) || fkeys.has(k) || !oldN || v.length !== oldN) continue;
      if (!(/^filament_/.test(k) || (SCHEMA[k] && SCHEMA[k].scope === 'filament'))) continue;
      t[k] = Array.from({ length: count }, (_, i) => (k === 'filament_map' ? String(i + 1) : v[Math.min(i, v.length - 1)]));
    }
    Object.assign(t, { printer_settings_id: target, print_settings_id: procName, filament_settings_id: filaments.map(f => f.name), printer_model: machine.printer_model || t.printer_model });
    // a converted project starts on the printer's own plate type, not the template's
    if (M.defaultBedType) t.curr_bed_type = M.defaultBedType;
    // the designer's quality/strength/support choices
    const carried = [];
    if (carryFrom) {
      const vIdx = variantIndex(carryFrom);
      const nVar = vIdx != null && Array.isArray(carryFrom.print_extruder_variant) ? carryFrom.print_extruder_variant.length : 0;
      for (const k of PORTABLE) {
        if (!(k in carryFrom)) continue;
        const raw = carryFrom[k];
        const v = String(Array.isArray(raw) && nVar > 1 && raw.length === nVar ? raw[vIdx] : first(raw));
        if (v === '' || v === 'nil') continue;
        if (String(first(t[k])) === v) continue;
        carried.push({ key: k, value: v });
      }
      if (carried.length) applyChanges(t, carried);
    }
    // value repairs, then the plate types, written into the rebuilt file
    const zip = await JSZip.loadAsync(buf);
    zip.file('Metadata/project_settings.config', JSON.stringify(t, null, 4));
    const fixes = await sanitizeZip(zip);
    await Slicer.plateBedTypes(zip);
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const settings = JSON.parse(await zip.file('Metadata/project_settings.config').async('string'));
    notes.unshift(`Converted by the app itself to the ${M.model || target} using “${procName}”${carried.length ? `, keeping the creator's ${carried.length} quality/strength/support settings` : ''}.`);
    if (fixes.length) notes.push(`Corrected ${fixes.length} setting${fixes.length === 1 ? '' : 's'} to values the slicer accepts.`);
    return { buffer: out, settings, mode: 'converted', notes, carried, slotMap, native: true, project: await load3mf(out) };
  }

  // Load a project and save it again with this slicer, unchanged, so the file is genuinely written by it
  // (used for "Export for Bambu Lab printers": the final file comes from Bambu Studio itself).
  async exportRoundTrip(buffer) {
    const dir = path.join(this.workDir, 'export', sha(buffer, this.exe || ''));
    await fs.mkdir(dir, { recursive: true });
    const input = path.join(dir, 'input.3mf'), out = path.join(dir, 'export.3mf');
    await fs.writeFile(input, buffer);
    const r = await this.run([...this.allowNewer(), '--outputdir', dir, '--export-3mf', 'export.3mf', input], dir);
    if (!fss.existsSync(out)) throw this.failure(r, `${this.label} couldn’t export the project`);
    return fs.readFile(out);
  }

  // Renumber the filaments in use to 1..n so they fit the toolheads. Numbers beyond the toolhead count share T1.
  // Returns null when nothing needs to change.
  // project (optional, from load3mf) adds the filaments used by painted colour on each object.
  static async compactFilaments(buffer, maxSlots, project = null) {
    const zip = await JSZip.loadAsync(buffer);
    const f = zip.file('Metadata/model_settings.config');
    if (!f) return null;
    const xml = await f.async('string');
    const paintBy = {};
    for (const it of (project && project.items) || []) if (it.paintStates && it.paintStates.length) paintBy[it.objectId] = it.paintStates;
    const usedNums = [...new Set([...[...xml.matchAll(/<metadata key="extruder" value="(\d+)"\s*\/>/g)].map(m => +m[1]), ...Object.values(paintBy).flat()].filter(n => n > 0))].sort((a, b) => a - b);
    if (!usedNums.length || Math.max(...usedNums) <= maxSlots) return null;
    // Filaments that share a plate get consecutive numbers: Snapmaker Orca crashes slicing a plate that uses
    // toolheads 1 and 3 but not 2. Plates with the most filaments are placed first, then everything else.
    const byObject = {};
    for (const m of xml.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)) byObject[m[1]] = [...new Set([...[...m[2].matchAll(/key="extruder" value="(\d+)"/g)].map(x => +x[1]), ...(paintBy[m[1]] || [])].filter(n => n > 0))];
    const groups = [...xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map(pm => [...new Set([...pm[1].matchAll(/key="object_id" value="(\d+)"/g)].flatMap(o => byObject[o[1]] || []))].sort((a, b) => a - b))
      .filter(g => g.length > 1).sort((a, b) => b.length - a.length);
    const order = [];
    for (const g of groups) for (const n of g) if (!order.includes(n)) order.push(n);
    for (const n of usedNums) if (!order.includes(n)) order.push(n);
    const map = {};
    let merged = 0;
    order.forEach((n, i) => { if (i < maxSlots) map[n] = i + 1; else { map[n] = 1; merged++; } });
    zip.file('Metadata/model_settings.config', xml.replace(/<metadata key="extruder" value="(\d+)"\s*\/>/g, (m, v) => (map[+v] ? `<metadata key="extruder" value="${map[+v]}"/>` : m)));
    // painted areas use filament numbers too: renumber them the same way (each distinct code once)
    if (Object.keys(paintBy).length) {
      const { remap } = require('./paint');
      const memo = new Map();
      const fix = (code) => { let r = memo.get(code); if (r === undefined) { r = remap(code, st => (st > 0 && map[st] ? map[st] : st)); memo.set(code, r); } return r; };
      for (const name of Object.keys(zip.files).filter(n => /\.model$/i.test(n))) {
        const body = await zip.file(name).async('string');
        if (!/paint_color=|mmu_segmentation=/.test(body)) continue;
        zip.file(name, body.replace(/((?:paint_color|(?:\w+:)?mmu_segmentation)=")([0-9A-Fa-f]+)"/g, (m0, k, code) => `${k}${fix(code)}"`));
      }
    }
    return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), map, merged };
  }

  // Plan C: write a brand-new, minimal 3MF from the geometry alone, for files whose structure a slicer can't
  // read. Each object keeps its parts (as components) and their filaments; each original plate's objects stay
  // together, centered on the matching plate of the selected printer.
  static async rebuildFromGeometry(project) {
    const { plateMembership } = require('./threemf');
    const M = getMachine();
    const mem = plateMembership(project);
    const plates = project.plates.length ? project.plates.map(p => p.index) : [1];
    const n = plates.length, v = Math.sqrt(n), r = Math.round(v), cols = v > r ? r + 1 : r;
    const W = M.bed.width, D = M.bed.depth;
    // where each original plate's objects go: centered on the same plate position for this printer
    const shift = {};
    for (const [k, pi] of plates.entries()) {
      const its = project.items.filter(it => (mem.get(it.index) || {}).plate === pi);
      if (!its.length) continue;
      const bb = its.map(it => mem.get(it.index).bbox).filter(Boolean);
      const cx = (Math.min(...bb.map(b => b.x0)) + Math.max(...bb.map(b => b.x1))) / 2, cy = (Math.min(...bb.map(b => b.y0)) + Math.max(...bb.map(b => b.y1))) / 2;
      const row = Math.floor(k / cols), col = k % cols;
      shift[pi] = [col * W * 1.2 + M.bed.minX + W / 2 - cx, -row * D * 1.2 + M.bed.minY + D / 2 - cy];
    }
    const fmtN = (x) => (Math.round(x * 1e5) / 1e5).toString();
    let id = 0, objXml = '', buildXml = '', cfgXml = '';
    const plateInst = {};
    for (const it of project.items) {
      const m0 = mem.get(it.index) || {};
      const pl = m0.plate || plates[0];
      const [dx, dy] = shift[pl] || [0, 0];
      const parts = [];
      let zMin = Infinity;
      for (const m of it.meshes) {
        if (m.type === 'support' || m.type === 'other') continue; // modifiers would become solid parts
        const P = (it.parts || []).find(p => String(p.id) === String(m.sourceId));
        if (P && P.subtype && P.subtype !== 'normal_part') continue;
        const V = m.mesh.vertices, T = m.transform, out = new Array(V.length);
        for (let i = 0; i < V.length; i += 3) {
          out[i] = V[i] * T[0] + V[i + 1] * T[3] + V[i + 2] * T[6] + T[9] + dx;
          out[i + 1] = V[i] * T[1] + V[i + 1] * T[4] + V[i + 2] * T[7] + T[10] + dy;
          out[i + 2] = V[i] * T[2] + V[i + 1] * T[5] + V[i + 2] * T[8] + T[11];
          if (out[i + 2] < zMin) zMin = out[i + 2];
        }
        parts.push({ id: ++id, verts: out, tris: m.mesh.triangles, paint: m.mesh.paint, extruder: (P && P.extruder) || it.extruder || 1, name: (P && P.name) || it.name || `Part ${id}` });
      }
      if (!parts.length) continue;
      if (!Number.isFinite(zMin)) zMin = 0;
      for (const p of parts) {
        let vx = '';
        for (let i = 0; i < p.verts.length; i += 3) vx += `<vertex x="${fmtN(p.verts[i])}" y="${fmtN(p.verts[i + 1])}" z="${fmtN(p.verts[i + 2] - zMin)}"/>`;
        let tr = '';
        for (let i = 0; i < p.tris.length; i += 3) {
          const pc = p.paint && p.paint[i / 3];
          tr += `<triangle v1="${p.tris[i]}" v2="${p.tris[i + 1]}" v3="${p.tris[i + 2]}"${pc ? ` paint_color="${pc}"` : ''}/>`;
        }
        objXml += `<object id="${p.id}" type="model"><mesh><vertices>${vx}</vertices><triangles>${tr}</triangles></mesh></object>\n`;
      }
      const oid = ++id;
      objXml += `<object id="${oid}" type="model"><components>${parts.map(p => `<component objectid="${p.id}"/>`).join('')}</components></object>\n`;
      buildXml += `<item objectid="${oid}" printable="1"/>\n`;
      const esc = (s) => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
      cfgXml += `  <object id="${oid}">\n    <metadata key="name" value="${esc(it.name || `Object ${oid}`)}"/>\n    <metadata key="extruder" value="${parts[0].extruder}"/>\n${parts.map(p => `    <part id="${p.id}" subtype="normal_part">\n      <metadata key="name" value="${esc(p.name)}"/>\n      <metadata key="extruder" value="${p.extruder}"/>\n    </part>`).join('\n')}\n  </object>\n`;
      (plateInst[pl] ||= []).push(oid);
    }
    const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n <metadata name="Application">${(this.prototype && 'Snapmaker_Orca-2.4.1') || 'Snapmaker_Orca-2.4.1'}</metadata>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n${objXml} </resources>\n <build>\n${buildXml} </build>\n</model>\n`;
    const platesXml = plates.filter(p => plateInst[p]).map((p, k) => `  <plate>\n    <metadata key="plater_id" value="${k + 1}"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n${plateInst[p].map(o => `    <model_instance>\n      <metadata key="object_id" value="${o}"/>\n      <metadata key="instance_id" value="0"/>\n    </model_instance>`).join('\n')}\n  </plate>`).join('\n');
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
    zip.file('3D/3dmodel.model', model);
    zip.file('Metadata/model_settings.config', `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${cfgXml}${platesXml}\n</config>\n`);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  // Plan B when a project's own settings can't be converted: keep only what makes up the model (geometry,
  // parts, which filament each part uses, plates) and drop every printer/process/filament setting, so it can be
  // set up from scratch like a plain model.
  static async stripToModel(buffer) {
    const { SCHEMA } = require('./orca-settings');
    const zip = await JSZip.loadAsync(buffer);
    zip.remove('Metadata/project_settings.config');
    for (const n of Object.keys(zip.files)) if (/^Metadata\/.*\.(gcode|md5|json)$/i.test(n) || /^Metadata\/(slice_info|filament_sequence|cut_information)\.config$/i.test(n)) zip.remove(n);
    const f = zip.file('Metadata/model_settings.config');
    if (f) {
      const xml = (await f.async('string')).replace(/<metadata key="([^"]+)" value="[^"]*"\s*\/>\s*/g, (m, key) => (key !== 'extruder' && SCHEMA[key] ? '' : m));
      zip.file('Metadata/model_settings.config', xml);
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  // what cliReady needs to know about the slicer and printer
  cliOptions() {
    const M = getMachine();
    const tags = { 'bambu-studio': ['BambuStudio-02.09.01.70', 'BambuStudio:3mfVersion'], 'orcaslicer': ['OrcaSlicer-2.5.0', 'BambuStudio:3mfVersion'], 'snapmaker-orca': ['Snapmaker_Orca-2.4.1', 'Snapmaker_Orca:3mfVersion'] };
    let template = null;
    if (!M.isU1 && this.lib) {
      try { template = { ...this.lib.flatten('machine', this.targetMachine), ...this.lib.flatten('process', this.lib.defaultProcess()) }; } catch {}
    }
    return { center: [(M.bed.minX + M.bed.maxX) / 2, (M.bed.minY + M.bed.maxY) / 2], tag: tags[this.lib && this.lib.kind] || tags['snapmaker-orca'], template };
  }

  static async cliReady(buffer, project, { center = [135, 135], tag: appTag = ['Snapmaker_Orca-2.4.1', 'Snapmaker_Orca:3mfVersion'], template = null, filaments = null } = {}) {
    const zip = await JSZip.loadAsync(buffer);
    const ms = zip.file('Metadata/model_settings.config');
    const hasPlate = ms && /<plate>/.test(await ms.async('string'));
    if (!hasPlate) {
      const x = (v) => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      // one entry per object; repeated build items of the same object are numbered instances of it
      const seen = new Map();
      const objs = [], inst = [];
      for (const it of project.items) {
        const n = seen.has(it.objectId) ? seen.get(it.objectId) + 1 : 0;
        seen.set(it.objectId, n);
        if (n === 0) objs.push(`  <object id="${x(it.objectId)}">\n    <metadata key="name" value="${x(it.name || 'Object')}"/>\n  </object>`);
        inst.push(`    <model_instance>\n      <metadata key="object_id" value="${x(it.objectId)}"/>\n      <metadata key="instance_id" value="${n}"/>\n    </model_instance>`);
      }
      zip.file('Metadata/model_settings.config', `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${objs.join('\n')}\n  <plate>\n    <metadata key="plater_id" value="1"/>\n${inst.join('\n')}\n  </plate>\n</config>\n`);
    }
    if (!hasPlate) {
      // The loader only honors Orca plate data (model_settings.config) in files whose model says it was
      // written by BambuStudio or Snapmaker Orca (bbs_3mf.cpp, Application tag); otherwise it rebuilds plates
      // from scratch, drops the thumbnails, and the Windows CLI dies rendering new ones.
      const rootPath = project.rootPath || '3D/3dmodel.model';
      const root = await zip.file(rootPath).async('string');
      let xml = root;
      if (!/<metadata name="Application">\s*(BambuStudio-|Snapmaker_Orca-|OrcaSlicer-)/.test(xml)) {
        const tag = `\n <metadata name="Application">${appTag[0]}</metadata>\n <metadata name="${appTag[1]}">1</metadata>`;
        xml = xml.replace(/<metadata name="Application">[^<]*<\/metadata>/, '').replace(/(<model\b[^>]*>)/, `$1${tag}`);
      }
      // Plain models can sit anywhere (often around 0,0). Without auto-arrange the CLI then finds them off
      // the bed, so center the whole group on the 270 x 270 mm U1 plate and set it down at Z = 0.
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const it of project.items) for (const a of worldTris(it)) for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) {
        if (a[i + k] < min[k]) min[k] = a[i + k]; if (a[i + k] > max[k]) max[k] = a[i + k];
      }
      if (Number.isFinite(min[0])) {
        const d = [center[0] - (min[0] + max[0]) / 2, center[1] - (min[1] + max[1]) / 2, -min[2]];
        if (Math.abs(d[0]) > 0.01 || Math.abs(d[1]) > 0.01 || Math.abs(d[2]) > 0.01) {
          const T = [1, 0, 0, 0, 1, 0, 0, 0, 1, d[0], d[1], d[2]];
          const updates = {};
          project.items.forEach((it, k) => { updates[k] = compose(it.buildTransform, T); });
          xml = setBuildTransforms(xml, updates);
        }
      }
      zip.file(rootPath, xml);
    }
    if (!zip.file('Metadata/project_settings.config')) {
      // A model without settings gets starter settings. They must list every filament the parts use: the slicer
      // resets parts on filaments beyond that list to the first one before applying the loaded filaments.
      const t = JSON.parse(JSON.stringify(template || U1_TEMPLATE));
      if (Array.isArray(filaments) && filaments.length) {
        const skip = new Set(['name', 'inherits', 'from', 'instantiation', 'type', 'version', 'setting_id', 'filament_id', 'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition']);
        const keys = new Set(filaments.flatMap(f => Object.keys(f)).filter(k => !skip.has(k)));
        const oldN = Array.isArray(t.filament_settings_id) ? t.filament_settings_id.length : 0;
        // only per-filament lists the starter settings already have, kept in the same shape (adding settings or
        // turning single values into lists makes the slicer reject the file later)
        for (const k of keys) {
          if (!Array.isArray(t[k]) || t[k].length !== oldN) continue;
          t[k] = filaments.map(f => { const v = f[k] ?? filaments[0][k]; return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''); });
        }
        t.filament_settings_id = filaments.map(f => f.name);
        // any other per-filament list (e.g. the filament-to-toolhead map) must be as long, or extra filaments vanish
        const { SCHEMA } = require('./orca-settings');
        const n = filaments.length;
        for (const [k, v] of Object.entries(t)) {
          if (!Array.isArray(v) || v.length !== oldN || keys.has(k) || !oldN) continue;
          if (!(/^filament_/.test(k) || (SCHEMA[k] && SCHEMA[k].scope === 'filament'))) continue;
          t[k] = Array.from({ length: n }, (_, i) => (k === 'filament_map' ? String(i + 1) : v[Math.min(i, v.length - 1)]));
        }
      }
      zip.file('Metadata/project_settings.config', JSON.stringify(t));
    }
    await sanitizeZip(zip);
    await ensureThumbnails(zip);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  // How many Snapmaker Orca processes may run at once. Each can use several GB on a detailed model, so this
  // follows free memory and model size (one at a time for big models or small machines).
  setLimitFor(triangles = 0) {
    const freeGb = os.freemem() / 1e9, totalGb = os.totalmem() / 1e9;
    let n = Math.max(1, Math.min(3, Math.floor(os.cpus().length / 2)));
    if (totalGb < 12 || freeGb < 4) n = 1;
    else if (totalGb < 24 || freeGb < 8) n = Math.min(n, 2);
    if (triangles > 500_000) n = 1;
    else if (triangles > 150_000) n = Math.min(n, 2);
    this.limit = n;
    return n;
  }

  // cacheKey: a stable description of what is being sliced (file, toolheads, settings, orientation), so results
  // are found again after a restart. Without it the zip bytes are used, which differ run to run.
  cacheFileFor(plateIndex, cacheKey) { return path.join(this.cacheDir, `${sha('v2', cacheKey, String(plateIndex), this.exe || '')}.json`); }
  isCached(plateIndex, cacheKey) { return fss.existsSync(this.cacheFileFor(plateIndex, cacheKey)); }

  async slice(buffer, plateIndex, cacheKey = null, token = null) {
    const key = cacheKey ? sha('v2', cacheKey, String(plateIndex), this.exe || '') : sha(buffer, String(plateIndex), this.exe || '');
    const cacheFile = path.join(this.cacheDir, `${key}.json`);
    try { return { ...JSON.parse(await fs.readFile(cacheFile, 'utf8')), cached: true }; } catch {}
    if (token && token.cancelled) throw Slicer.cancelledError();
    return this.schedule(async () => {
      if (token && token.cancelled) throw Slicer.cancelledError();
      const dir = path.join(this.workDir, 'slices', key);
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      const input = path.join(dir, 'input.3mf');
      await fs.writeFile(input, buffer);
      const started = Date.now();
      const args = [...this.allowNewer(), '--slice', String(plateIndex), '--outputdir', dir, '--export-3mf', 'sliced.3mf', input];
      // Repair-and-retry loop. Every fix the slicer's own errors point to is applied and recorded:
      //  - G-code path conflicts: a warning in the desktop app but fatal on the command line (-101).
      //    --no-check skips only that check; every other validation still applies.
      //  - "X: v not in range [a,b]" (-18): clamp to the slicer's own range, even for settings the
      //    bundled schema doesn't know (newer slicer versions).
      const corrections = [];
      let conflict = null, noCheck = false, r;
      for (let attempt = 0; attempt < 4; attempt++) {
        r = await this.run(noCheck ? ['--no-check', ...args] : args, dir, undefined, token);
        if (token && token.cancelled) throw Slicer.cancelledError();
        const ok = (await fs.readdir(dir)).some(f => /\.gcode$/.test(f)) && !(r.result && r.result.return_code !== 0);
        if (ok) break;
        const c = !noCheck && Slicer.conflictIn(r);
        if (c) { conflict = c; noCheck = true; continue; }
        const ranges = parseRangeErrors(r.log);
        if (ranges.length) {
          const zip = await JSZip.loadAsync(await fs.readFile(input));
          const fixes = await applyRangeErrors(zip, ranges);
          if (!fixes.length) break;
          corrections.push(...fixes.map(describeFix));
          await fs.writeFile(input, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
          continue;
        }
        break;
      }
      const gcodeName = (await fs.readdir(dir)).find(f => /\.gcode$/.test(f));
      // result.json is only written by some builds (not Snapmaker Orca on Windows): the G-code is the proof.
      if (!gcodeName || (r.result && r.result.return_code !== 0)) throw this.failure(r, 'Slicing failed');
      const g = await analyzeGcodeFile(path.join(dir, gcodeName));
      let info = null;
      try {
        if (!fss.existsSync(path.join(dir, 'sliced.3mf'))) throw new Error('no sliced project');
        const sliced = await load3mf(await fs.readFile(path.join(dir, 'sliced.3mf')));
        info = sliced.sliceInfo.find(s => s.index === plateIndex) || sliced.sliceInfo[0] || null;
      } catch {}
      const warnings = ((r.result && r.result.sliced_plates) || []).map(p => p.warning_message).filter(Boolean);
      if (conflict) warnings.unshift(conflict.message);
      const out = {
        timeSeconds: (info && info.predictionSeconds) || g.timeSeconds,
        grams: (info && info.weightGrams) || g.grams,
        filaments: info ? info.filaments : (g.gramsPerTool || []).map((grams, i) => ({ id: String(i + 1), type: '', usedGrams: grams })).filter(f => f.usedGrams > 0),
        gcode: g, warnings, corrections, sliceSeconds: Math.round((Date.now() - started) / 1000),
        gcodePath: path.join(dir, gcodeName), slicedProjectPath: path.join(dir, 'sliced.3mf'),
      };
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(out));
      return out;
    });
  }
}

function worldTris(item) {
  const out = [];
  for (const m of item.meshes) {
    if (m.type === 'support' || m.type === 'other') continue;
    const { vertices: V, triangles: T } = m.mesh, M = m.transform;
    const a = new Float32Array(T.length * 3);
    for (let t = 0; t < T.length; t++) {
      const i = T[t] * 3, x = V[i], y = V[i + 1], z = V[i + 2];
      a[t * 3] = x * M[0] + y * M[3] + z * M[6] + M[9];
      a[t * 3 + 1] = x * M[1] + y * M[4] + z * M[7] + M[10];
      a[t * 3 + 2] = x * M[2] + y * M[5] + z * M[8] + M[11];
    }
    out.push(a);
  }
  return out;
}

module.exports = { Slicer, PORTABLE, worldTris };
