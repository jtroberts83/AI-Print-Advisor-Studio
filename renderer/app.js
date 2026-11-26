import { ModelViewer, FINISH_CODES } from './viewer.js';
import { GcodePreview } from './gcode-preview.js';
import { BUILT } from './scenes/built.js';
import { createGlossary } from './glossary.js';

const api = window.advisor;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanErr = e => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const TYPES = ['PLA', 'PLA Matte', 'PLA Silk', 'PLA-CF', 'PETG', 'PETG-HF', 'PETG-CF', 'PCTG', 'TPU', 'PVA', 'ABS', 'ASA'];
const DEFAULT_COLORS = ['#2F8F9D', '#E8E4DA', '#C2412D', '#2B3A4A'];
// filaments a project can list: more than the toolheads is allowed (a Bambu AMS setup loads 16 or more)
const MAX_FILAMENTS = 32;

const state = {
  file: null, info: { available: false, filaments: [], recipes: [] }, config: {},
  slots: [], plateIndex: 1, analysis: null, rotations: {}, orientObj: null,
  result: null, recipe: null, compare: null, selectedVariant: null, history: null, busy: false, checks: [],
};
const viewer = new ModelViewer($('viewer'));
// beginner word help (renderer/glossary.js): dotted-underlined words explained with a picture on hover
const openCheatSheet = (which) => api.openCheatSheet(which).catch(e => toast(cleanErr(e), 6000));
const glossary = createGlossary({ isOn: () => wordsOn(), onCheatSheet: openCheatSheet });

// ---------- progress strip ----------
const busy = new Map(); // task id -> { label, pct }
let busyHideTimer;
function renderBusy() {
  const bar = $('busyBar');
  const last = [...busy.values()].pop();
  clearTimeout(busyHideTimer);
  if (!last) { busyHideTimer = setTimeout(() => bar.classList.add('idle'), 150); return; }
  bar.classList.remove('idle', 'warn');
  bar.classList.toggle('indeterminate', last.pct == null);
  $('busyFill').style.width = last.pct == null ? '' : `${last.pct}%`;
  $('busyLabel').textContent = last.label;
}
function setBusy(id, label, pct = null) { busy.delete(id); busy.set(id, { label, pct }); renderBusy(); }
function clearBusy(id) { busy.delete(id); renderBusy(); }
async function withBusy(id, label, fn) { setBusy(id, label); try { return await fn(); } finally { clearBusy(id); } }

api.onProgress(t => {
  document.querySelectorAll('.progress-line').forEach(el => { el.textContent = t; });
  const last = [...busy.keys()].pop();
  if (!last) return;
  const m = /Sliced (\d+) of (\d+)/.exec(t);
  setBusy(last, t, m ? Math.round(100 * m[1] / m[2]) : null);
});

function onStartup(st) {
  if (!st.done) { setBusy('startup', st.label, st.pct); return; }
  setBusy('startup', st.label, 100);
  if (st.warn) $('busyBar').classList.add('warn');
  setTimeout(() => clearBusy('startup'), st.warn ? 6000 : 1500);
  loadConfig().then(maybeWelcome).then(maybeRestoreSession);
}
api.onStartup(onStartup);
api.startupState().then(onStartup);

// ---------- tabs ----------
function showTab(name) {
  setTimeout(() => saveSession(), 0);
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  ['recs', 'compare', 'history'].forEach(t => $(`tab-${t}`).classList.toggle('hidden', t !== name));
  if (name === 'history' && !state.history) loadHistory();
  if (name === 'compare') renderVariantPicks();
}
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => showTab(b.dataset.tab));

// ---------- slider + recipe ----------
function sliderText(v) {
  if (v <= 15) return 'Best possible finish and detail. Print time is not a concern.';
  if (v <= 38) return 'Leaning toward quality. Longer prints for cleaner surfaces.';
  if (v <= 61) return 'Balanced. Close to the stock U1 profile.';
  if (v <= 84) return 'Leaning toward speed. Some visible layer lines are fine.';
  return 'As fast as it can reliably go. Looks come second.';
}
function drawLayers() {
  const v = Number($('slider').value);
  // the layer heights of the printer's own presets (Finest may be 0.08 mm), else the usual steps
  const rs = (state.info && state.info.recipes) || [];
  const rec = rs.find(r => v >= r.range[0] && v <= r.range[1]);
  const lh = (rec && rec.layer) || [0.12, 0.16, 0.2, 0.24, 0.28][v <= 15 ? 0 : v <= 38 ? 1 : v <= 61 ? 2 : v <= 84 ? 3 : 4];
  const px = Math.max(2, lh * 38);
  const count = Math.floor(66 / (px + 1.5));
  $('layerPreview').innerHTML = Array.from({ length: count }, () => `<span style="height:${px}px;margin-top:1.5px"></span>`).join('');
  $('sliderNote').textContent = sliderText(v);
}
const refreshRecipe = debounce(async () => {
  if (!state.file) return;
  const r = await api.recipePreview(Number($('slider').value));
  state.recipe = r;
  $('recipeLine').innerHTML = `Recipe: <b>${esc(r.recipe.name)}</b>. ${esc(r.recipe.about)}${r.changes.length ? ` (${r.changes.length} setting${r.changes.length === 1 ? '' : 's'})` : ''}`;
}, 150);
$('slider').addEventListener('input', () => { drawLayers(); refreshRecipe(); saveSession(); });
$('purpose').addEventListener('input', () => saveSession());
$('fitTogether').addEventListener('change', async () => {
  state.assemblyChoice = $('fitTogether').checked; saveSession();
  await api.setAssembly({ assembly: $('fitTogether').checked, guess: state.assemblyGuess }).catch(() => {});
  state.compare = null; renderCompare(); refreshChecks();
  if (!$('fitTogether').checked && state.assemblyGuess) toast('Fit protection is off. Walls, line widths and sizes may now change, which can stop parts fitting together.', 7000);
});

// Before saving, sending or opening: a likely assembly with fit protection off, and changes that alter walls or sizes
let FIT_KEYS = null;
async function fitConfirm(changes) {
  if (!state.assemblyGuess || $('fitTogether').checked) return true;
  FIT_KEYS = FIT_KEYS || new Set(await api.fitCritical().catch(() => []));
  const risky = (changes || []).filter(c => FIT_KEYS.has(c.key));
  if (!risky.length) return true;
  return window.confirm(`These parts look like they fit together, and “These parts fit together” is unticked.\n\nThis version changes ${[...new Set(risky.map(c => c.label || c.key.replace(/_/g, ' ')))].join(', ')}. On snap-together or multi-piece models that usually makes the pieces too tight or too loose to fit, even if every piece prints perfectly.\n\nContinue anyway?`);
}
drawLayers();

// ---------- opening files ----------
// restore: a saved session to bring back (toolheads, orientation, slider, recommendations, edits, comparisons)
async function openFile(promise, restore = null, opts = {}) {
  if (!opts.fromSession) { api.sessionForgetFile().catch(() => {}); document.title = 'AI 3D Print Advisor Studio'; }
  try {
    setBusy('file', restore ? 'Restoring your session…' : 'Reading the 3MF…');
    const info = await promise;
    if (!info) { clearBusy('file'); return; }
    if (state.tsCarry && state.tsCarry.filePath !== info.filePath) state.tsCarry = null;
    // a new model starts with an empty "What is this part for?" (a restored session brings its own back below)
    if (!restore) $('purpose').value = '';
    if (!restore) { state.ifaceChoice = null; $('ifaceOpposite').checked = false; }
    Object.assign(state, { file: info, result: null, objects: null, objPlan: null, compare: null, rotations: {}, checks: [], orientObj: null, assemblyChoice: null, blockersOn: false, remixApplied: false, swapUndo: null });
    resetRemix(); swReset();
    state.slots = initialSlots(info.filaments);
    state.mixes = info.mixes || [];
    renderFileInfo();
    guideEvent('opened');   // the model is on screen: the guide moves on now, not after the slower preparing below
    if (restore) {
      if (restore.slots && restore.slots.length) state.slots = restore.slots;
      state.rotations = restore.rotations || {};
      if (restore.plateIndex) { state.plateIndex = restore.plateIndex; $('plateSelect').value = String(restore.plateIndex); }
      if (restore.slider != null) { $('slider').value = restore.slider; drawLayers(); }
      $('purpose').value = restore.purpose || '';
      state.assemblyChoice = restore.assemblyChoice ?? null;
      state.ifaceChoice = restore.ifaceChoice ?? null;
      state.blockersOn = !!restore.blockersOn;
    }
    await prepare();
    if (restore && restore.result) {
      state.result = restore.result;
      if (restore.objects && restore.objects.results) state.objects = restore.objects;
      renderResults();
      applyRowEdits(restore.rowEdits);
      $('analyzeBtn').textContent = 'Get new recommendations';
      if (restore.comparePicks) state.comparePicks = new Set(restore.comparePicks);
      if (restore.compareIds && restore.compareIds.length && state.info.available) await runCompare(restore.compareIds); // served from the slice cache
      if (restore.tab) showTab(restore.tab);
    } else {
      await offerPastAnalyses();
    }
    info.warnings.forEach(w => toast(w, 7000));
    api.printName().then(showPrintName).catch(() => {});
    saveSession();
  } catch (e) { toast(`Could not open the file: ${cleanErr(e)}`, 8000); }
  finally { clearBusy('file'); }
}

// ---------- crash safety: session save/restore, earlier analyses ----------
function rowEdits() {
  const out = {};
  document.querySelectorAll('#resultsBody .setting').forEach(r => { out[r.dataset.id] = { checked: r.querySelector('input[type=checkbox]').checked, value: r.querySelector('input[type=text]').value }; });
  return out;
}
function applyRowEdits(edits) {
  if (!edits) return;
  document.querySelectorAll('#resultsBody .setting').forEach(r => {
    const e = edits[r.dataset.id]; if (!e) return;
    r.querySelector('input[type=checkbox]').checked = e.checked;
    r.querySelector('input[type=text]').value = e.value;
  });
  updateCount(); refreshChecks();
}
// everything needed to pick up where you left off
function sessionPayload() {
  const tab = (document.querySelector('[data-tab][aria-selected=true]') || {}).dataset?.tab || 'recs';
  return {
    plateIndex: state.plateIndex, slots: state.slots, rotations: state.rotations, slider: Number($('slider').value), purpose: $('purpose').value,
    result: state.result, rowEdits: state.result ? rowEdits() : null,
    objects: state.objects ? { ...state.objects, results: state.objects.results.map((r, i) => (i === state.objects.cur ? { ...r, edits: rowEdits() } : r)) } : null,
    comparePicks: state.comparePicks ? [...state.comparePicks] : null,
    compareIds: state.compare && state.compare.results ? state.compare.results.filter(r => r.ok).map(r => r.id) : [], tab,
    selectedVariant: state.selectedVariant || null,
    assemblyChoice: state.assemblyChoice ?? null, ifaceChoice: state.ifaceChoice ?? null,
    blockersOn: !!state.blockersOn,
  };
}
const saveSession = debounce(() => {
  if (!state.file) return;
  api.sessionSave(sessionPayload()).catch(() => {});
}, 700);

// ---------- models too heavy to slice (AI-generated, colours baked in from a texture) ----------
const fmtN = (n) => Number(n).toLocaleString();
async function checkHeavy() {
  const r = await api.heavyCheck({ plateIndex: state.plateIndex }).catch(() => null);
  const row = $('heavyRow');
  if (!r || (!r.heavy && !r.fixed)) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  row.classList.toggle('fixed', !r.heavy && r.fixed);
  $('heavyUndoBtn').classList.toggle('hidden', !r.fixed);
  $('heavyFixBtn').classList.toggle('hidden', !r.heavy);
  if (!r.heavy) {
    $('heavyTitle').textContent = 'Model fixed for faster slicing';
    $('heavyText').textContent = `Now ${fmtN(r.triangles)} triangles${r.painted ? ` and ${fmtN(r.areas)} color areas` : ''}. For the fastest slice, use Fine or Balanced rather than Finest.`;
    return;
  }
  $('heavyTitle').textContent = 'This model will be very slow to slice';
  const why = [];
  if (r.triangles > 600000) why.push(`${fmtN(r.triangles)} triangles`);
  if (r.specks > 300) why.push(`${fmtN(r.specks)} tiny color specks`);
  $('heavyText').innerHTML = `${r.aiMade ? 'Likely AI-generated (Meshy, Tripo…) with colors baked in from a texture: ' : 'It has '}${why.join(' and ')}. The slicer may take very long or run out of memory and seem stuck.` +
    `<details><summary>What Fix model does</summary>Merges each speck into the color around it${r.triangles > 600000 ? ` and lightens the mesh to about ${fmtN(r.reduceTo)} triangles, keeping the shape within 0.03 mm` : ''}. Colors keep their edges and the model stays watertight. You can undo it.</details>`;
  if (state.heavyToldFor !== state.file) { state.heavyToldFor = state.file; toast('This model will be very slow to slice. See “Fix model” at the top left.', 8000); }
}
$('heavyFixBtn').onclick = async () => {
  $('heavyFixBtn').disabled = true;
  try {
    const r = await withBusy('heavy', 'Cleaning up the colors and lightening the mesh… (can take a minute)', () => api.heavyFix({ plateIndex: state.plateIndex }));
    state.compare = null; state.result = null; renderCompare();
    await prepare();
    toast(`Fixed: ${fmtN(r.trianglesBefore)} → ${fmtN(r.trianglesAfter)} triangles${r.specksMerged ? `, ${fmtN(r.specksMerged)} color specks merged` : ''}. Save it with Save as 3MF to keep the fixed copy.`, 9000);
  } catch (e) { toast(cleanErr(e), 8000); }
  finally { $('heavyFixBtn').disabled = false; }
};
$('heavyUndoBtn').onclick = async () => {
  if (await api.heavyUndo()) { state.compare = null; renderCompare(); await prepare(); toast('Back to the model as it was.', 4000); }
};

// ---------- support blockers inside hollow, open models ----------
async function checkBlockers() {
  const info = await api.blockerCheck({ plateIndex: state.plateIndex }).catch(() => null);
  if (!info || !info.found) { $('blockRow').classList.add('hidden'); return; }
  $('blockRow').classList.remove('hidden');
  const cm = Math.round(info.items.reduce((t, x) => t + x.hollowCm3, 0));
  $('blockText').textContent = `This model is hollow with openings (about ${cm} cm³ inside). Supports can grow up through the openings and get stuck inside, where you can't remove them. This fills the inside with a support blocker (shown in light blue) so supports stay outside. A few inner edges of the openings then print without support.`;
  $('blockInside').checked = !!info.on;
  // remembered choice: re-apply after the project is rebuilt (e.g. after changing a filament)
  if (state.blockersOn && !info.on) applyBlockers(true);
}
async function applyBlockers(on) {
  try {
    const r = await withBusy('blockers', on ? 'Adding support blockers inside the model…' : 'Removing the support blockers…', () => api.setBlockers({ plateIndex: state.plateIndex, on }));
    state.blockersOn = !!(r && r.on);
    $('blockInside').checked = state.blockersOn;
    state.compare = null; renderCompare();
    const a = await api.analyzePlate({ plateIndex: state.plateIndex, rotations: state.rotations });
    viewer.load(a.preview); pushColors();
    refreshChecks(); saveSession();
    if (on && state.blockersOn) toast('Support blockers added inside the model. They’re included when you compare, save, send or open it in your slicer.', 7000);
  } catch (e) { toast(cleanErr(e), 7000); }
}
$('blockInside').addEventListener('change', () => applyBlockers($('blockInside').checked));

// ---------- colour remix ----------
// Step 1, Parts: the model is cut into patches along its grooves; the AI groups them into named parts; the user
// checks and fixes them (click a patch, or brush). Step 2, Colors: schemes are designed per confirmed part.
const RX_STYLES = [['realistic', 'Realistic'], ['fun', 'Fun'], ['galaxy', 'Galaxy'], ['colorshift', 'Color Shift'], ['pastel', 'Pastel'], ['monochrome', 'Monochrome'], ['holiday', 'Holiday']];
const RX = { counts: { realistic: 3 }, prep: null, variations: [], previews: [], regions: null, labels: null, estimates: null };
// the parts being edited (labels: part id per triangle of the file, before pupils are added)
const PT = { subject: '', parts: [], labels: null, sel: 0, history: [] };
const KIND_NAMES = { eye: 'Eyes', pupil: 'Pupils', skin: 'Skin', body: 'Body', shell: 'Shell', hair: 'Hair / fur', mouth: 'Mouth', nose: 'Nose', ear: 'Ears', limb: 'Limbs', clothing: 'Clothing', accessory: 'Accessory', marking: 'Markings', base: 'Base / stand', text: 'Text', other: 'Other' };
const PART_COLORS = ['#3FA34D', '#8B5A2B', '#F2F2F2', '#2B6CB0', '#E0A526', '#C53D6B', '#6B46C1', '#2C9C9C', '#E86A33', '#7A8B99', '#B8D54A', '#5C3B8C'];
// show each part in (roughly) its natural colour, so the editor reads like the real thing; parts that would
// look the same get distinct colours instead
const COLOR_WORDS = [['white', '#F4F4F4'], ['ivory', '#F3EBD3'], ['cream', '#F1E6C8'], ['beige', '#D9C7A0'], ['tan', '#C9A66B'], ['black', '#1A1A1A'], ['gray', '#8A8F94'], ['grey', '#8A8F94'], ['silver', '#BFC5CA'],
  ['olive', '#6B7A2E'], ['lime', '#8BC34A'], ['dark green', '#2E6B34'], ['green', '#3FA34D'], ['teal', '#2C9C9C'], ['turquoise', '#3BC1B5'], ['navy', '#22315E'], ['sky', '#78B7E5'], ['blue', '#2B6CB0'],
  ['purple', '#6B46C1'], ['violet', '#8E5BD6'], ['pink', '#E68FB0'], ['magenta', '#C53D9B'], ['red', '#C8312E'], ['orange', '#E8772E'], ['gold', '#D4A72C'], ['yellow', '#EDD03A'],
  ['dark brown', '#5A3A1E'], ['brown', '#8B5A2B'], ['wood', '#A87A4D'], ['copper', '#B8693A'], ['bronze', '#9C6B30']];
function partHex(p) {
  if (p.kind === 'pupil') return '#151515';
  const words = String(p.realColor || '').toLowerCase();
  const natural = (COLOR_WORDS.find(([w]) => words.includes(w)) || [])[1] || (p.kind === 'eye' ? '#F4F4F4' : null);
  const fallback = PART_COLORS[(p.id - 1) % PART_COLORS.length];
  if (!natural) return fallback;
  // an earlier part already shows this colour: use the palette so the two can be told apart
  const earlier = PT.parts.filter(q => q.id < p.id && q.kind !== 'pupil').some(q => partHexNatural(q) === natural);
  return earlier ? fallback : natural;
}
function partHexNatural(p) { const w = String(p.realColor || '').toLowerCase(); return (COLOR_WORDS.find(([k]) => w.includes(k)) || [])[1] || (p.kind === 'eye' ? '#F4F4F4' : null); }
const RX_MAX = 12;
const rxTotal = () => Object.values(RX.counts).reduce((t, n) => t + n, 0);
const money = (usd) => (usd < 0.01 ? 'under 1¢' : usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`);
function resetRemix() { RX.prep = null; RX.variations = []; RX.regions = null; RX.labels = null; Object.assign(PT, { subject: '', parts: [], labels: null, sel: 0, history: [] }); $('rxResults').innerHTML = ''; }

// style chips: click to pick or drop a style; a picked style shows − count + for how many schemes of it
// (two sets: Color remix by parts, and Swap colors)
function styleChips(el, counts, after) {
  const total = () => Object.values(counts).reduce((t, n) => t + n, 0);
  const draw = () => { el.innerHTML = RX_STYLES.map(([id, name]) => {
    const n = counts[id] || 0;
    return n
      ? `<span class="rx-chip on" data-style="${id}"><button type="button" class="step" data-step="-1" aria-label="One fewer ${name}">−</button><button type="button" data-toggle aria-pressed="true" title="Click to remove this style">${name}</button><span class="n" aria-label="${n} ${name} schemes">${n}</span><button type="button" class="step" data-step="1" aria-label="One more ${name}">+</button></span>`
      : `<span class="rx-chip" data-style="${id}"><button type="button" data-toggle aria-pressed="false">${name}</button></span>`;
  }).join(''); after(); };
  el.onclick = (e) => {
    const chip = e.target.closest('[data-style]'); if (!chip) return;
    const id = chip.dataset.style, step = e.target.closest('[data-step]');
    if (step) {
      const n = (counts[id] || 0) + Number(step.dataset.step);
      if (n <= 0) delete counts[id]; else if (total() < RX_MAX || n < counts[id]) counts[id] = n;
      else toast(`Up to ${RX_MAX} schemes at a time.`, 3000);
    } else if (e.target.closest('[data-toggle]')) {
      if (counts[id]) delete counts[id]; else if (total() < RX_MAX) counts[id] = 1;
    }
    draw();
  };
  draw();
}
styleChips($('rxStyles'), RX.counts, () => rxCost());
function rxCost() {
  const total = rxTotal();
  if (!RX.prep || !RX.estimates) { $('rxGo').disabled = true; return; } // parts not confirmed yet (also: called at startup)
  const est = total && RX.estimates[Math.min(total, RX_MAX)];
  const name = (MODELS[RX.prep.model] || {}).name || 'the selected model';
  $('rxCost').textContent = !total ? 'Pick at least one style.' : est ? `${total} scheme${total === 1 ? '' : 's'}. Estimated cost: about ${money(est.low)}–${money(est.high)} with ${name}` : '';
  $('rxGo').disabled = !total || !RX.prep.hasKey;
}

// ----- step switching -----
// 0 = Swap colors (the simple way), 1 = Parts, 2 = Colors (recolor by parts)
function rxStep(n) {
  RX.mode = n === 0 ? 'swap' : 'parts';
  $('rxSwapPane').classList.toggle('hidden', n !== 0);
  $('rxPartsPane').classList.toggle('hidden', n !== 1);
  $('rxColorsPane').classList.toggle('hidden', n !== 2);
  $('rxStepSwap').setAttribute('aria-selected', n === 0);
  $('rxStep1').setAttribute('aria-selected', n === 1); $('rxStep2').setAttribute('aria-selected', n === 2);
  $('rxStep2').disabled = !RX.labels;
  if (n === 0 || n === 1) requestAnimationFrame(() => { window.dispatchEvent(new Event('resize')); });
  if (n === 2) { rxShowGrid(); rxCost(); }
}
$('rxStepSwap').onclick = () => swOpen();
$('rxStep1').onclick = () => (RX.prep && RX.pvFor === RX.prep ? rxStep(1) : rxOpenParts());
$('rxStep2').onclick = () => { if (RX.labels) rxStep(2); };
$('rxBackParts').onclick = () => rxStep(1);

// ----- step 1: patches and parts -----
const modelTris = (preview) => preview.filter(p => p.kind === 'model').reduce((t, p) => t + (p.srcTri ? p.srcTri.length : p.positions.length / 9), 0);
// make sure the patches belong to what the main 3D view shows (it reloads at times); redo them if not
async function ensurePrep() {
  if (RX.prep && RX.prep.plateIndex === state.plateIndex) {
    const mapped = viewer.setRegions(state.analysis.preview, RX.prep.patchLabels);
    if (mapped && mapped >= modelTris(state.analysis.preview) * 0.9) return true;
  }
  resetRemix();
  await rxPrepare();
  return !!RX.prep;
}
async function rxPrepare() {
  $('rxPartsStatus').textContent = 'Finding the patches along the model’s grooves…';
  $('rxIdentify').disabled = true; $('rxConfirm').disabled = true;
  try {
    RX.prep = await withBusy('remix', 'Preparing the color remix…', () => api.remixPrepare({ plateIndex: state.plateIndex, detail: Number($('rxDetail').value) }));
    RX.prep.plateIndex = state.plateIndex;
    let mapped = viewer.setRegions(state.analysis.preview, RX.prep.patchLabels);
    if (!mapped) {
      const a = await api.analyzePlate({ plateIndex: state.plateIndex, rotations: state.rotations });
      state.analysis = a; viewer.load(a.preview); pushColors();
      mapped = viewer.setRegions(a.preview, RX.prep.patchLabels);
    }
    if (!mapped) throw new Error('Couldn’t match the patches to the model shown. Close this window and open Color remix again.');
    const p = RX.prep;
    const est = p.identifyCost, mName = (MODELS[p.model] || {}).name || 'the selected model';
    $('rxIdCost').textContent = p.hasKey ? `about ${money(est.low)}–${money(est.high)} with ${mName}` : 'needs a Claude API key (Settings)';
    $('rxIdentify').disabled = !p.hasKey;
    if (p.saved) {
      Object.assign(PT, { subject: p.saved.subject, parts: p.saved.parts, labels: p.saved.labels, history: [] });
      PT.sel = PT.parts[0] ? PT.parts[0].id : 0; $('rxPupils').checked = p.saved.pupils !== false;
      $('rxIdentify').textContent = 'Identify again with AI';
      $('rxPartsStatus').textContent = `These are the parts you confirmed for this model on ${new Date(p.saved.savedAt).toLocaleDateString()}. Check them and confirm, or identify again.`;
    } else {
      Object.assign(PT, { subject: '', parts: [], labels: null, sel: 0, history: [] });
      $('rxIdentify').textContent = 'Identify parts with AI';
      $('rxPartsStatus').textContent = `${p.patches.length} patches found. ${p.hasKey ? 'Next: Identify parts with AI.' : 'Add parts yourself with “+ Add a part”, or add a Claude API key in Settings so the AI can do it.'}`;
    }
    showParts();
  } catch (e) { $('rxPartsStatus').textContent = cleanErr(e); RX.prep = null; }
}
// the parts editor's own 3D view
function partsViewer() {
  if (!RX.pv) {
    RX.pv = new ModelViewer($('rxPartsView'));
    RX.pv.onRegionEdit = () => {
      PT.history.push(PT.labels); if (PT.history.length > 15) PT.history.shift();
      PT.labels = RX.pv.exportRegions(PT.labels);
      $('rxUndoEdit').disabled = false; renderPartList();
    };
    const el = $('rxPartsView');
    el.addEventListener('pointermove', (e) => {
      if (RX.pv.painting) return;
      const r = RX.pv.regionAt(e), part = r && PT.parts.find(p => p.id === r.region);
      $('rxHover').classList.toggle('hidden', !r);
      if (r) $('rxHover').textContent = part ? `${part.name} · patch ${r.patch}` : `Patch ${r.patch}`;
    });
    el.addEventListener('pointerleave', () => $('rxHover').classList.add('hidden'));
  }
  return RX.pv;
}
function showParts() {
  const pv = partsViewer(), pre = state.analysis.preview;
  pv.load(pre);
  pushColors(pv);
  pv.setPatches(pre, RX.prep.patchLabels);
  if (PT.labels) {
    pv.setRegions(pre, PT.labels);
    pv.showRegionColors(Object.fromEntries(PT.parts.map(p => [p.id, partHex(p)])));
  } else {
    // no parts yet: every patch in its own colour
    pv.setRegions(pre, RX.prep.patchLabels);
    pv.showRegionColors(Object.fromEntries(RX.prep.patches.map((p, i) => [p.id, `hsl(${Math.round((i * 137.5) % 360)}, 55%, ${i % 2 ? 48 : 62}%)`])));
  }
  pv.editValue = PT.sel; RX.pvFor = RX.prep;
  requestAnimationFrame(() => { window.dispatchEvent(new Event('resize')); pv.fit('iso'); });
  renderPartList();
}
function recolorParts() {
  if (!RX.pv || !PT.labels) return;
  RX.pv.showRegionColors(Object.fromEntries(PT.parts.map(p => [p.id, partHex(p)])));
}
function partShares() {
  const n = new Map(); let total = 0;
  for (const lab of Object.values(PT.labels || {})) for (let i = 0; i < lab.length; i++) { n.set(lab[i], (n.get(lab[i]) || 0) + 1); total++; }
  return { n, total: total || 1 };
}
function renderPartList() {
  const { n, total } = partShares();
  $('rxSubject').classList.toggle('hidden', !PT.subject);
  $('rxSubject').innerHTML = PT.subject ? `Recognized: <b>${esc(PT.subject)}</b>` : '';
  $('rxParts').innerHTML = PT.parts.map(p => {
    const share = (n.get(p.id) || 0) / total;
    return `<li data-part="${p.id}" class="${p.id === PT.sel ? 'sel' : ''}" title="${esc(p.realColor ? 'Natural color: ' + p.realColor : '')}">
      <span class="sw" style="background:${partHex(p)}"></span>
      <input type="text" value="${esc(p.name)}" aria-label="Part name" data-name>
      <select aria-label="Kind of part" data-kind>${Object.entries(KIND_NAMES).map(([k, v]) => `<option value="${k}" ${k === p.kind ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <span class="area">${share ? (share < 0.01 ? '<1' : Math.round(share * 100)) + '%' : 'empty'}</span>
      <button class="del" data-del title="Remove this part (its surface goes to the biggest other part)" aria-label="Remove ${esc(p.name)}">×</button></li>`;
  }).join('');
  $('rxConfirm').disabled = !PT.parts.length || !PT.labels;
  if (RX.pv) RX.pv.editValue = PT.sel;
}
$('rxParts').addEventListener('click', (e) => {
  const li = e.target.closest('[data-part]'); if (!li) return;
  const id = +li.dataset.part;
  if (e.target.closest('[data-del]')) {
    const { n } = partShares();
    const rest = PT.parts.filter(p => p.id !== id); if (!rest.length) return;
    const to = rest.reduce((b, p) => ((n.get(p.id) || 0) > (n.get(b.id) || 0) ? p : b), rest[0]).id;
    PT.history.push(PT.labels);
    const out = {}; for (const [k, lab] of Object.entries(PT.labels)) { const c = Uint16Array.from(lab); for (let i = 0; i < c.length; i++) if (c[i] === id) c[i] = to; out[k] = c; }
    PT.labels = out; PT.parts = rest; if (PT.sel === id) PT.sel = to;
    RX.pv.setRegions(state.analysis.preview, PT.labels); recolorParts(); renderPartList(); $('rxUndoEdit').disabled = false;
    return;
  }
  if (PT.sel !== id) { PT.sel = id; renderPartList(); if (RX.pv && RX.pv.tool === 'rotate') setPartTool('part-patch'); }
});
$('rxParts').addEventListener('change', (e) => {
  const li = e.target.closest('[data-part]'); if (!li) return;
  const p = PT.parts.find(x => x.id === +li.dataset.part); if (!p) return;
  if (e.target.matches('[data-name]')) p.name = e.target.value.trim() || p.name;
  if (e.target.matches('[data-kind]')) { p.kind = e.target.value; recolorParts(); renderPartList(); }
});
$('rxAddPart').onclick = () => {
  if (!RX.prep) return;
  if (!PT.labels) { // first part by hand: everything starts as "Body"
    PT.parts = [{ id: 1, name: 'Body', kind: 'body', realColor: '' }];
    PT.labels = Object.fromEntries(Object.entries(RX.prep.patchLabels).map(([k, lab]) => [k, new Uint16Array(lab.length).fill(1)]));
    RX.pv.setRegions(state.analysis.preview, PT.labels);
  }
  const id = Math.max(0, ...PT.parts.map(p => p.id)) + 1;
  PT.parts.push({ id, name: `Part ${id}`, kind: 'other', realColor: '' });
  PT.sel = id; recolorParts(); renderPartList(); setPartTool('part-patch');
  const inp = $('rxParts').querySelector(`[data-part="${id}"] input`); if (inp) { inp.focus(); inp.select(); }
  $('rxPartsStatus').textContent = 'Click the patches that belong to the new part, or use the brush.';
};
function setPartTool(tool) {
  partsViewer().setTool(tool);
  document.querySelectorAll('[data-ptool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.ptool === tool));
  $('rxBrushRow').classList.toggle('hidden', tool !== 'part-brush');
  if (tool !== 'rotate' && !PT.labels) { $('rxPartsStatus').textContent = 'Identify the parts first, or add one with “+ Add a part”.'; }
}
document.querySelectorAll('[data-ptool]').forEach(b => { b.onclick = () => setPartTool(b.dataset.ptool); });
$('rxBrush').oninput = () => { partsViewer().brush = Number($('rxBrush').value); $('rxBrushVal').textContent = `${$('rxBrush').value} mm`; };
$('rxUndoEdit').onclick = () => {
  if (!PT.history.length) return;
  PT.labels = PT.history.pop();
  RX.pv.setRegions(state.analysis.preview, PT.labels); recolorParts(); renderPartList();
  $('rxUndoEdit').disabled = !PT.history.length;
};
$('rxDetail').onchange = () => { resetRemix(); rxPrepare(); };
$('rxIdentify').onclick = async () => {
  if (!RX.prep || !(await ensurePrep())) return;
  $('rxIdentify').disabled = true; $('rxPartsStatus').textContent = 'Looking at the model from every side… (usually under a minute)';
  try {
    const ids = RX.prep.patches.map(p => p.id);
    viewer.setRegions(state.analysis.preview, RX.prep.patchLabels);
    const shots = viewer.regionMapShots(ids, ['front', 'back', 'side', 'left', 'top', 'iso'], 'patch');
    viewer.showRegionColors(null); pushColors();
    const plain = viewer.thumbnails([700])[0];
    const images = [{ label: 'The model as it looks now', dataUrl: plain.dataUrl }, ...shots];
    const r = await withBusy('remix', 'Identifying the parts…', () => api.partsIdentify({ images, hint: $('rxHint').value.trim() }));
    PT.history = PT.labels ? [PT.labels] : [];
    PT.subject = r.subject; PT.parts = r.parts;
    PT.labels = Object.fromEntries(Object.entries(RX.prep.patchLabels).map(([k, lab]) => { const o = new Uint16Array(lab.length); for (let i = 0; i < lab.length; i++) o[i] = r.patchPart[lab[i]] || PT.parts[0].id; return [k, o]; }));
    PT.parts = PT.parts.filter(p => Object.values(r.patchPart).includes(p.id));
    PT.sel = PT.parts[0] ? PT.parts[0].id : 0;
    RX.pv.setRegions(state.analysis.preview, PT.labels); recolorParts(); renderPartList();
    $('rxUndoEdit').disabled = !PT.history.length;
    $('rxPartsStatus').textContent = 'Check the parts from every side (drag to rotate). Wrong spot? Pick the right part in the list, then click the patch or brush over it. Then confirm.';
  } catch (e) { $('rxPartsStatus').textContent = cleanErr(e); }
  finally { $('rxIdentify').disabled = !(RX.prep && RX.prep.hasKey); }
};
$('rxConfirm').onclick = async () => {
  if (!PT.labels || !PT.parts.length) return;
  $('rxConfirm').disabled = true;
  try {
    const r = await withBusy('remix', 'Saving the parts…', () => api.partsConfirm({ subject: PT.subject, parts: PT.parts, labels: PT.labels, pupils: $('rxPupils').checked }));
    RX.regions = r.regions; RX.labels = r.labels; RX.estimates = r.estimates; RX.variations = []; $('rxResults').innerHTML = '';
    const p = RX.prep;
    $('rxInfo').textContent = `${r.regions.length} parts${r.pupilsAdded ? ` (pupils added on ${r.pupilsAdded} eye${r.pupilsAdded === 1 ? '' : 's'})` : ''}. ${p.inventory.count} filaments ${p.inventory.onHand ? 'on hand' : 'in your inventory'}; up to ${p.maxColors} colors (one per toolhead).${p.inventory.note ? ' ' + p.inventory.note : ''}`;
    $('rxStatus').textContent = !p.hasKey ? 'Color remix needs a Claude API key (Settings).' : '';
    rxStep(2);
  } catch (e) { $('rxPartsStatus').textContent = cleanErr(e); }
  finally { $('rxConfirm').disabled = false; }
};

// ----- step 2: colors -----
// attach the confirmed parts to what the main 3D view shows (it reloads at times)
async function ensureRegions() {
  if (RX.labels && RX.prep && RX.prep.plateIndex === state.plateIndex) {
    const mapped = viewer.setRegions(state.analysis.preview, RX.labels);
    if (mapped && mapped >= modelTris(state.analysis.preview) * 0.9) return true;
  }
  $('rxStatus').textContent = 'The model changed. Check the parts again and confirm.';
  await ensurePrep(); rxStep(1);
  return false;
}
async function openRemix() {
  if (!state.file) { toast('Open a model first.', 3000); return; }
  const inv = await api.inventoryStatus().catch(() => ({ set: false }));
  if (!inv.set || !inv.ok) {
    toast(inv.set ? `Couldn’t read your filament inventory: ${inv.error}` : 'Color remix picks from the filament you have. Add yours here first.', 7000);
    showFilament(true);
    return;
  }
  $('rxUndo').classList.toggle('hidden', !(state.remixApplied || state.swapUndo));
  $('remixDialog').showModal();
  // Swap colors first (the simple way), unless recoloring by parts was used last; the tour shows the parts way
  if (RX.mode === 'parts' || (api.demo && !RX.mode)) await rxOpenParts(); else await swOpen();
}
async function rxOpenParts() {
  rxStep(RX.labels ? 2 : 1);
  if (!(await ensurePrep())) return;
  if (RX.pvFor !== RX.prep) showParts();
  rxStep(RX.labels ? 2 : 1);
}
$('remixBtn').onclick = openRemix;
$('rxClose').onclick = () => { $('remixDialog').close(); };
$('remixDialog').addEventListener('close', () => { viewer.showRegionColors(null); pushColors(); });
$('rxGo').onclick = async () => {
  if (!RX.prep || !RX.labels) return;
  const count = rxTotal();
  if (!count) return;
  const styles = Object.entries(RX.counts).map(([id, n]) => ({ id, count: n }));
  $('rxGo').disabled = true; $('rxStatus').textContent = `Designing ${count} color scheme${count === 1 ? '' : 's'}… (usually under a minute)`;
  try {
    if (!(await ensureRegions())) return;
    const ids = RX.regions.map(r => r.id);
    const shots = viewer.regionMapShots(ids, ['iso', 'front', 'back', 'side', 'top'], 'part');
    viewer.showRegionColors(null); pushColors();
    const real = viewer.thumbnails([700])[0];
    const images = [{ label: 'The model in its current colours', dataUrl: real.dataUrl }, ...shots];
    const r = await withBusy('remix', 'Designing color schemes…', () => api.remixRun({ styles, custom: $('rxCustom').value.trim(), extras: $('rxExtras').checked, material: $('rxMaterial').value, images }));
    RX.variations = r.variations;
    viewer.setRegions(state.analysis.preview, RX.labels);
    RX.previews = r.variations.map(v => viewer.regionPreview(schemeHex(v)));
    viewer.showRegionColors(null); pushColors();
    rxShowGrid();
    $('rxStatus').textContent = 'Click a picture to see it larger in 3D.';
    renderRemix();
  } catch (e) { $('rxStatus').textContent = cleanErr(e); }
  finally { rxCost(); }
};
const schemeHex = (v) => Object.fromEntries(Object.entries(v.assign).map(([rid, fid]) => [rid, (v.tools.find(t => t.fid === fid) || {}).hex || '#999']));
function rxShowGrid() { $('rxBig').classList.add('hidden'); $('rxResults').classList.remove('hidden'); }
async function rxShowBig(i) {
  const v = RX.variations[i];
  if (!v || !(await ensureRegions())) return;
  $('rxResults').classList.add('hidden'); $('rxBig').classList.remove('hidden');
  $('rxBigTitle').textContent = v.name;
  if (!RX.big) RX.big = new ModelViewer($('rxBigView'));
  RX.big.load(state.analysis.preview);
  pushColors(RX.big);
  RX.big.setRegions(state.analysis.preview, RX.labels);
  RX.big.showRegionColors(schemeHex(v));
  requestAnimationFrame(() => { window.dispatchEvent(new Event('resize')); RX.big.fit('iso'); });
  const card = $('rxResults').querySelector(`.rx-card[data-i="${i}"]`);
  const byPart = Object.entries(v.assign).map(([rid, fid]) => { const part = RX.regions.find(r => r.id === +rid), t = v.tools.find(x => x.fid === fid); return part && t ? `<li><span class="sw" style="background:${esc(t.hex)}"></span>${esc(part.name)}: ${esc(t.color || t.name)}</li>` : ''; }).join('');
  $('rxBigSide').innerHTML = `<p>${esc(v.description)}</p>${card ? card.querySelector('.rx-tools').outerHTML : ''}
    <h4 style="margin:6px 0 0">By part</h4><ul class="rx-tools">${byPart}</ul>
    ${v.pauses.length ? `<p class="hint">${v.pauses.map(p => `At ${p.z} mm the print pauses: swap T${p.tool} for ${esc(p.to.color || '')}.`).join(' ')}</p>` : ''}
    <div class="row-btns"><button class="btn primary" data-apply="${i}">Apply to model</button></div>`;
  $('rxBigSide').querySelector('[data-apply]').onclick = (e) => $('rxResults').onclick({ target: e.target });
}
$('rxBigBack').onclick = rxShowGrid;

// one filament spelled out: its color, brand and line, then material, finish and what's on hand
function filDetail(f) {
  const finish = f.finish && !String(f.line || '').toLowerCase().includes(String(f.finish).toLowerCase()) ? f.finish : '';
  const meta = [f.type, finish, f.spools ? `${f.spools} spool${f.spools === 1 ? '' : 's'}` : '', f.remainingG > 0 ? `${(f.remainingG / 1000).toFixed(1)} kg left` : ''].filter(Boolean).join(' · ');
  return `<span class="fil-d"><span class="fil-name">${esc(f.color || f.name || '')}</span> <span class="fil-brand">${esc(`${f.brand || ''} ${f.line || ''}`.trim() || String(f.name || '').replace(f.color || '', '').trim())}</span>${meta ? `<span class="fil-meta">${esc(meta)}</span>` : ''}</span>`;
}
function renderRemix() {
  $('rxResults').innerHTML = RX.variations.map((v, i) => `<div class="rx-card" data-i="${i}">
    <img src="${RX.previews[i]}" alt="${esc(v.name)}" data-preview="${i}" title="Click to see it larger in 3D">
    ${v.style ? `<span class="rx-tag">${esc((RX_STYLES.find(x => x[0] === v.style) || [0, v.style])[1])}</span>` : ''}<h3>${esc(v.name)}</h3><p>${esc(v.description)}</p>
    <ul class="rx-tools">${v.tools.map(t => `<li><span class="sw" style="background:${esc(t.hex)}"></span><b class="th">T${t.tool}${t.from ? ` from ${t.from} mm` : ''}</b>${filDetail(t)}</li>`).join('')}</ul>
    ${v.pauses.length ? `<p class="hint">${v.pauses.length} filament swap${v.pauses.length === 1 ? '' : 's'} during the print.</p>` : ''}
    ${v.notes.length ? `<ul class="rx-notes">${v.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <div class="row-btns"><button class="btn primary" data-apply="${i}">Apply to model</button></div>
  </div>`).join('');
}
$('rxResults').onclick = async (e) => {
  const pv = e.target.closest('[data-preview]');
  if (pv) { rxShowBig(+pv.dataset.preview); return; }
  const ap = e.target.closest('[data-apply]');
  if (!ap) return;
  try {
    const r = await withBusy('remix', 'Painting the colors into the model…', () => api.remixApply({ index: +ap.dataset.apply }));
    state.slots = r.slots.map(s => ({ slot: s.slot, type: s.type, preset: s.preset || matchPreset(s.type), color: s.color }));
    state.remixApplied = true; state.compare = null; state.result = null;
    $('remixDialog').close();
    renderMaterials(); await prepare();
    toast(`Applied “${r.name}”. The colors are painted into the model and the toolheads are set to your filaments.${r.swaps.length ? ' ' + r.swaps.join(' ') : ''} Save it with Save as 3MF.`, r.swaps.length ? 16000 : 8000);
    // the parts stay remembered for this shape, so another remix starts from them
    resetRemix();
    guideEvent('remixed');
  } catch (err) { $('rxStatus').textContent = cleanErr(err); }
};
$('rxUndo').onclick = async () => {
  if (state.swapUndo) {
    state.slots = state.swapUndo; state.swapUndo = null; state.compare = null; state.result = null;
    $('remixDialog').close(); renderMaterials(); await prepare();
    toast('Swap undone: the toolheads are back to the filaments they had before.', 5000);
    return;
  }
  if (await api.remixUndo()) { state.remixApplied = false; $('remixDialog').close(); resetRemix(); await prepare(); toast('Remix undone: back to the model’s own colors.', 5000); }
};

// ----- Swap colors: the simple remix -----
// The model keeps its painting exactly as it is; each of its filaments (toolheads) gets a new one from the library:
// picked by hand, the closest match, a shuffle, or schemes the AI suggests. Only the toolheads change, nothing is
// repainted, so it works on any multi-color model without finding its parts first.
const SW = { prep: null, picks: {}, schemes: [], previews: [], sel: -1, counts: { fun: 1, pastel: 1, galaxy: 1 }, viewer: null, viewerFor: null, areas: {} };
function swReset() { Object.assign(SW, { picks: {}, schemes: [], previews: [], sel: -1, viewerFor: null, matSet: false }); $('rxSwResults').innerHTML = ''; $('rxSwStatus').textContent = ''; }
const swFamily = (t) => (/^(PETG|PCTG)/i.test(t) ? 'petg' : /^(ABS|ASA)/i.test(t) ? 'abs' : /^TPU/i.test(t) ? 'tpu' : 'pla');
// colours compared as people see them (CIE Lab)
function hexLab(h) {
  const v = parseInt(String(h).replace('#', '').slice(0, 6), 16) || 0;
  const [r, g, b] = [v >> 16 & 255, v >> 8 & 255, v & 255].map(c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a, b) => { const p = hexLab(a), q = hexLab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const swFil = (id) => (SW.prep && id ? SW.prep.filaments.find(f => f.id === id) : null);
// the model's own colors: the toolheads it uses (mixes count as the toolheads they blend)
function swSlots() { const used = new Set(state.analysis?.totals.extrudersUsed || []); const s = state.slots.filter(x => used.has(x.slot)); return s.length ? s : state.slots; }
function swPool() { const m = $('rxSwMaterial').value; return SW.prep ? SW.prep.filaments.filter(f => m === 'any' || swFamily(f.type) === m) : []; }
// every toolhead as it would be with these picks
function swSlotsWith(picks = SW.picks) {
  return state.slots.map(s => {
    const f = swFil(picks[s.slot]);
    return f ? { ...s, type: f.type, preset: matchPreset(f.type, f.preset), color: f.hex.toUpperCase(), name: `${f.name} ${f.finish || ''}`.trim(), sparkle: undefined } : s;
  });
}
// how much of the model's surface each toolhead colors (0..1)
function swShares() {
  const out = {};
  for (const [id, a] of Object.entries(viewer.filamentAreas())) {
    const m = (state.mixes || []).find(x => String(x.id) === id);
    if (m) for (const p of m.parts) out[p.slot] = (out[p.slot] || 0) + a * p.pct / 100;
    else out[id] = (out[id] || 0) + a;
  }
  const total = Object.values(out).reduce((t, a) => t + a, 0) || 1;
  return Object.fromEntries(Object.entries(out).map(([k, a]) => [k, a / total]));
}
async function swOpen() {
  rxStep(0);
  try { SW.prep = await api.remixSwapPrepare({ toolheads: swSlots().length }); }
  catch (e) { SW.prep = null; swCost(); $('rxSwList').innerHTML = `<li class="hint" style="display:block">${esc(cleanErr(e))}</li>`; return; }
  // forget picks of filament that's no longer on hand
  for (const k of Object.keys(SW.picks)) if (!swFil(SW.picks[k])) delete SW.picks[k];
  if (!SW.matSet) {
    const fams = swSlots().map(s => swFamily(s.type)), top = [...fams].sort((a, b) => fams.filter(x => x === b).length - fams.filter(x => x === a).length)[0];
    if (['pla', 'petg', 'abs'].includes(top) && SW.prep.filaments.some(f => swFamily(f.type) === top)) $('rxSwMaterial').value = top;
    SW.matSet = true;
  }
  SW.areas = swShares();
  if (!SW.viewer) SW.viewer = new ModelViewer($('rxSwView'));
  if (SW.viewerFor !== state.analysis) { SW.viewer.load(state.analysis.preview); SW.viewerFor = state.analysis; }
  requestAnimationFrame(() => { window.dispatchEvent(new Event('resize')); SW.viewer.fit('iso'); });
  swRender();
}
function swRender() {
  const pool = swPool(), byType = {};
  for (const f of [...pool].sort((a, b) => `${a.type} ${a.color}`.localeCompare(`${b.type} ${b.color}`))) (byType[f.type] = byType[f.type] || []).push(f);
  const groups = Object.entries(byType).map(([t, list]) => `<optgroup label="${esc(t)}">${list.map(f => `<option value="${esc(f.id)}">${esc(f.color || f.name)} · ${esc(`${f.brand} ${f.line || ''}`.trim())}</option>`).join('')}</optgroup>`).join('');
  $('rxSwList').innerHTML = !pool.length ? `<li class="hint" style="display:block">No ${esc($('rxSwMaterial').selectedOptions[0].text)} filament on hand. Pick another material.</li>` : swSlots().map(s => {
    const f = swFil(SW.picks[s.slot]), pct = Math.round((SW.areas[s.slot] || 0) * 100);
    return `<li data-slot="${s.slot}"><span class="sw" style="background:${esc(s.color)}" title="Now: ${esc((s.preset || s.type).replace(/ @U1.*$/, ''))}, ${esc(s.color)}"></span><b>T${s.slot}</b><span class="muted" title="How much of the model’s surface this color covers">${pct < 1 ? '<1' : pct}%</span><span aria-hidden="true">→</span><span class="sw" style="background:${esc(f ? f.hex : s.color)}"></span>
      <select aria-label="New filament for T${s.slot}"><option value="">Keep this color</option>${f && !pool.includes(f) ? `<option value="${esc(f.id)}">${esc(f.name)}</option>` : ''}${groups}</select>
      ${f ? `<div class="rx-sw-detail">${filDetail(f)}</div>` : ''}</li>`;
  }).join('');
  $('rxSwList').querySelectorAll('li[data-slot]').forEach(li => {
    const sel = li.querySelector('select'), slot = +li.dataset.slot;
    sel.value = SW.picks[slot] || '';
    sel.onchange = () => { if (sel.value) SW.picks[slot] = sel.value; else delete SW.picks[slot]; SW.sel = -1; swRender(); };
  });
  if (SW.viewer) { const L = filamentLooks(swSlotsWith()); SW.viewer.setFilamentColors(L.colors, L.sparkle, L.finish); }
  $('rxSwApply').disabled = $('rxSwApply2').disabled = !swSlots().some(s => SW.picks[s.slot]);
  swCost(); swRenderSchemes();
}
$('rxSwMaterial').onchange = () => swRender();
$('rxSwReset').onclick = () => { SW.picks = {}; SW.sel = -1; $('rxSwStatus').textContent = ''; swRender(); };
// each color gets the filament that looks most like it (the biggest areas choose first; a filament is only used twice
// when nothing else comes close)
$('rxSwClosest').onclick = () => {
  const pool = swPool(); if (!pool.length) return;
  const taken = new Set(); SW.picks = {};
  for (const s of [...swSlots()].sort((a, b) => (SW.areas[b.slot] || 0) - (SW.areas[a.slot] || 0))) {
    const best = pool.reduce((b, f) => { const d = deltaE(f.hex, s.color) + (taken.has(f.id) ? 12 : 0); return !b || d < b.d ? { f, d } : b; }, null);
    SW.picks[s.slot] = best.f.id; taken.add(best.f.id);
  }
  SW.sel = -1; $('rxSwStatus').textContent = 'Each color now uses the filament you have that looks most like it.'; swRender();
};
// a random scheme, but light colors stay light and dark ones dark, so eyes, outlines and details still stand out
$('rxSwShuffle').onclick = () => {
  const pool = swPool(), slots = swSlots(); if (!pool.length) return;
  const bag = [...pool];
  for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
  const chosen = bag.slice(0, slots.length);
  while (chosen.length < slots.length) chosen.push(pool[Math.floor(Math.random() * pool.length)]);
  const L = (h) => hexLab(h)[0];
  const order = [...slots].sort((a, b) => L(a.color) - L(b.color));
  chosen.sort((a, b) => L(a.hex) - L(b.hex));
  SW.picks = Object.fromEntries(order.map((s, i) => [s.slot, chosen[i].id]));
  SW.sel = -1; $('rxSwStatus').textContent = 'Shuffled. Click Shuffle again for another, or change any color by hand.'; swRender();
};
styleChips($('rxSwStyles'), SW.counts, () => swCost());
function swCost() {
  const p = SW.prep, total = Object.values(SW.counts).reduce((t, n) => t + n, 0);
  if (!p) { $('rxSwGo').disabled = true; $('rxSwCost').textContent = ''; return; }
  const est = total && p.estimates && p.estimates[Math.min(total, RX_MAX)];
  const name = (MODELS[p.model] || {}).name || 'the selected model';
  $('rxSwCost').textContent = !p.hasKey ? 'Needs a Claude API key (Settings). Closest match and Shuffle are free.' : !total ? 'Pick at least one style.'
    : est ? `${total} scheme${total === 1 ? '' : 's'}. Estimated cost: about ${money(est.low)}–${money(est.high)} with ${name}` : '';
  $('rxSwGo').disabled = !total || !p.hasKey;
}
$('rxSwGo').onclick = async () => {
  const styles = Object.entries(SW.counts).map(([id, count]) => ({ id, count })), count = styles.reduce((t, x) => t + x.count, 0);
  if (!count || !SW.prep || !SW.viewer) return;
  $('rxSwGo').disabled = true; $('rxSwStatus').textContent = `Designing ${count} color scheme${count === 1 ? '' : 's'}… (usually under a minute)`;
  try {
    const now = filamentLooks();
    const images = [{ label: 'The model in its current colours', dataUrl: SW.viewer.filamentPreview(now, 700, 'iso') },
      { label: 'The same model from behind', dataUrl: SW.viewer.filamentPreview(now, 600, 'back') }];
    const toolheads = swSlots().map(s => ({ toolhead: s.slot, currentColor: String(s.color).toUpperCase(), currentFilament: (s.preset || s.type).replace(/ @U1.*$/, ''), surfacePct: Math.round((SW.areas[s.slot] || 0) * 100) }));
    const mixes = (state.mixes || []).map((m, i) => ({ name: `M${i + 1}`, blend: m.parts.map(p => ({ toolhead: p.slot, pct: Math.round(p.pct) })) }));
    const r = await withBusy('remix', 'Designing color schemes…', () => api.remixSwapRun({ styles, custom: $('rxSwCustom').value.trim(), material: $('rxSwMaterial').value, images, toolheads, mixes }));
    SW.schemes = r.variations; SW.sel = -1;
    SW.previews = SW.schemes.map(v => SW.viewer.filamentPreview(filamentLooks(swSlotsWith(v.picks)), 160));
    $('rxSwStatus').textContent = SW.schemes.length ? 'Click a scheme to try it on the model, then Apply to model.' : 'No usable schemes came back. Try again.';
    swRenderSchemes();
  } catch (e) { $('rxSwStatus').textContent = cleanErr(e); }
  finally { swCost(); }
};
function swRenderSchemes() {
  $('rxSwResults').innerHTML = SW.schemes.map((v, i) => `<div class="rx-sw-card ${i === SW.sel ? 'sel' : ''}" data-i="${i}" title="Click to try it on the model">
    <div class="rx-sw-top"><img src="${SW.previews[i] || ''}" alt="">
    <div>${v.style ? `<span class="rx-tag">${esc((RX_STYLES.find(x => x[0] === v.style) || [0, v.style])[1])}</span>` : ''}<b>${esc(v.name)}</b><span class="muted">${esc(v.description)}</span></div></div>
    <ul class="rx-tools">${swSlots().map(s => { const f = swFil(v.picks[s.slot]); return `<li><span class="sw" style="background:${esc(s.color)}" title="Now"></span><span class="arrow" aria-hidden="true">→</span><span class="sw" style="background:${esc(f ? f.hex : s.color)}"></span><b class="th">T${s.slot}</b>${f ? filDetail(f) : '<span class="fil-d muted">keeps its color</span>'}</li>`; }).join('')}</ul>
    ${v.notes && v.notes.length ? `<span class="rx-notes">${esc(v.notes.join(' '))}</span>` : ''}
    <div class="row-btns"><button type="button" class="btn small" data-try="${i}">${i === SW.sel ? 'On the model ✓' : 'Try on the model'}</button> <button type="button" class="btn primary small" data-apply="${i}">Apply to model</button></div>
  </div>`).join('');
  $('rxSwApplyEnd').classList.toggle('hidden', !SW.schemes.length);
}
function swTry(i) {
  const v = SW.schemes[i]; if (!v) return false;
  SW.picks = { ...v.picks }; SW.sel = i;
  const pool = swPool();
  if (Object.values(v.picks).some(id => !pool.some(f => f.id === id))) $('rxSwMaterial').value = 'any';
  swRender();
  return true;
}
$('rxSwResults').onclick = (e) => {
  const ap = e.target.closest('[data-apply]');
  if (ap) { if (swTry(+ap.dataset.apply)) $('rxSwApply').onclick(); return; }
  const c = e.target.closest('[data-i]'); if (c) swTry(+c.dataset.i);
};
$('rxSwApply2').onclick = () => $('rxSwApply').onclick();
$('rxSwApply').onclick = async () => {
  const changed = swSlots().filter(s => swFil(SW.picks[s.slot]));
  if (!changed.length) return;
  const next = swSlotsWith();
  const fams = new Set(swSlots().map(s => swFamily(next.find(x => x.slot === s.slot).type)));
  const what = changed.map(s => { const f = swFil(SW.picks[s.slot]); return `T${s.slot} ${f.color || f.name}`; }).join(', ');
  const name = SW.sel >= 0 && SW.schemes[SW.sel] ? SW.schemes[SW.sel].name : '';
  state.swapUndo = state.swapUndo || state.slots.map(s => ({ ...s }));
  state.slots = next; state.compare = null; state.result = null;
  SW.picks = {}; SW.sel = -1;
  $('remixDialog').close();
  renderMaterials(); await prepare();
  toast(`${name ? `Applied “${name}”` : 'Colors swapped'}: ${what}. The painting is unchanged; the toolheads now hold these filaments.${fams.size > 1 ? ' They are different materials, so check they print well together.' : ''} Save it with Save as 3MF.`, 9000);
  guideEvent('remixed');
};

// ---------- Filament: the built-in filament inventory, shown over the whole window ----------
// renderer/filament/ runs in an iframe (its own page and styles) and talks to the app through window.advisor here.
function showFilament(on) {
  const view = $('filamentView');
  if (on && !view.querySelector('iframe')) {
    const f = document.createElement('iframe');
    f.src = 'filament/index.html'; f.title = 'Filament inventory';
    f.addEventListener('load', () => { try { glossary.attach(f.contentDocument, f); } catch (e) { console.warn('glossary', e); } });
    view.appendChild(f);
  }
  document.body.classList.toggle('filament-open', on);
  $('filamentBtn').textContent = on ? 'Back to model' : 'Filament';
  $('filamentBtn').setAttribute('aria-pressed', String(on));
  if (on) { view.querySelector('iframe').focus(); guideEvent('filament'); }
  else { SHOP.key = ''; renderShopping(); }   // what's on hand may have changed
}
// A spool tag scanned on the NFC reader (turned on in Filament → Settings) opens the Filament screen, unless
// "Open the Filament screen when a spool is scanned" is off: then scans only count while that screen is open.
// The screen itself handles the scan (it listens too); a scan that opens the screen for the first time waits here.
let nfcPending = null, nfcOpenAnywhere = true;
window.__takeNfcPending = () => { const t = nfcPending; nfcPending = null; return t; };
if (api.onNfcTag) {
  api.nfcStatus().then(s => { nfcOpenAnywhere = s.openAnywhere !== false; }).catch(() => {});
  api.onNfcStatus(s => { if (typeof s.openAnywhere === 'boolean') nfcOpenAnywhere = s.openAnywhere; });
  api.onNfcTag((scan) => {
    if (!scan || scan.status === 'read_error') return;
    if (document.body.classList.contains('filament-open')) return;
    if (!nfcOpenAnywhere) return toast('Spool tag scanned. Open Filament (top right) to use it.', 4000);
    if (!$('filamentView').querySelector('iframe')) nfcPending = scan;
    showFilament(true);
  });
}
$('glossaryBtn').onclick = () => { glossary.open(); guideEvent('glossary'); };
// where to download models (links open in the browser through the window-open handler)
const openModels = () => { if (!$('modelsDialog').open) $('modelsDialog').showModal(); guideEvent('models'); };
$('modelsBtn').onclick = openModels;
$('findModelsLink').onclick = (e) => { e.stopPropagation(); openModels(); };
$('modelsClose').onclick = () => $('modelsDialog').close();
$('filamentBtn').onclick = async () => {
  const opening = !document.body.classList.contains('filament-open');
  if (opening && !(await filamentIntro())) return;
  showFilament(opening);
};
// The first time Filament is opened with an empty library: explore the sample library, or start empty.
// Returns false when the window is closed without a choice (nothing opens).
function filamentIntro() {
  const c = state.config || {}, sm = c.samples || {};
  if (api.demo || c.filamentIntroDone) return Promise.resolve(true);
  const done = () => { c.filamentIntroDone = true; api.setConfig({ filamentIntroDone: true }).catch(() => {}); };
  if (!sm.available || !sm.empty) { done(); return Promise.resolve(true); }
  return new Promise((resolve) => {
    const dlg = $('filIntroDialog');
    let chose = false;
    $('filIntroSamples').onclick = async () => {
      chose = true; $('filIntroSamples').disabled = true;
      try { c.samples = await api.filamentSamples('load'); toast('Sample library loaded. Remove it anytime in Settings (Filament library).', 6000); }
      catch (e) { toast(`Couldn’t load the sample library: ${cleanErr(e)}`, 7000); }
      $('filIntroSamples').disabled = false; done(); dlg.close(); resolve(true);
    };
    $('filIntroEmpty').onclick = () => { chose = true; done(); dlg.close(); resolve(true); };
    dlg.addEventListener('close', () => { if (!chose) resolve(false); }, { once: true });
    dlg.showModal();
  });
}
// Load or remove the sample library. The Filament screen is closed first, so a save from it can't bring the
// samples back, and reopened afterwards if it was showing.
async function sampleAction(action) {
  const open = document.body.classList.contains('filament-open');
  const f = $('filamentView').querySelector('iframe');
  if (f) { f.remove(); await new Promise(r => setTimeout(r, 400)); }
  try {
    state.config.samples = await api.filamentSamples(action);
    state.config.filamentIntroDone = true; api.setConfig({ filamentIntroDone: true }).catch(() => {});
    toast(action === 'clear' ? 'Sample filament removed. Your library is ready for your own spools.' : 'Sample library loaded. Click “Filament” at the top to explore it.', 6000);
  } catch (e) { toast(cleanErr(e), 7000); }
  if (open) showFilament(true);
  renderSamples();
}
function renderSamples() {
  const sm = (state.config && state.config.samples) || {};
  const show = !api.demo && sm.available && (sm.loaded || sm.empty);
  $('sampleField').classList.toggle('hidden', !show);
  $('sampleConfirm').classList.add('hidden');
  $('sampleBtn').classList.remove('hidden');
  if (!show) return;
  if (sm.loaded) {
    $('sampleText').textContent = 'The sample filament library is loaded, so you can see what the Filament screen does. When you’re done exploring, remove it to start your own. Anything you added yourself stays.';
    $('sampleBtn').textContent = 'Remove the sample filament…';
  } else {
    $('sampleText').textContent = 'Your filament library is empty. Want to see what it can do first? Load the sample library (about 240 spools with photos), then remove it here when you’re done.';
    $('sampleBtn').textContent = 'Load the sample library';
  }
}
$('sampleBtn').onclick = () => {
  if ((state.config.samples || {}).loaded) { $('sampleConfirm').classList.remove('hidden'); $('sampleBtn').classList.add('hidden'); }
  else sampleAction('load');
};
$('sampleNo').onclick = () => renderSamples();
$('sampleYes').onclick = () => sampleAction('clear');


// rough cost of getting recommendations, shown under the button
function showAnalyzeCost() {
  const m = MODELS[state.config && state.config.model];
  $('analyzeCost').textContent = state.config && state.config.aiMode === 'chat' ? 'Free chatbot mode: no API cost.' : m ? `About ${m.cost.replace(/^~/, '').replace(/ per analysis$/, '')} with ${m.name}` : '';
  // a diagnosis sends the printed file's details and photos: about the same as an analysis
  $('tsCost').textContent = state.config && state.config.aiMode === 'chat' ? 'Free chatbot mode: no API cost.' : m ? `About ${m.cost.replace(/^~/, '').replace(/ per analysis$/, '')} with ${m.name} (a bit more with photos)` : '';
}

// ---------- print name: the short, speakable name for saved and sent files ----------
function showPrintName(p) {
  if (!p || !p.name || !state.file) { $('printNameBox').classList.add('hidden'); return; }
  $('printNameBox').classList.remove('hidden');
  $('printNameBtn').textContent = `“${p.name}”`;
  $('printNameBtn').title = p.source === 'ai' ? 'Named by AI from the model. Click to change.' : p.source === 'user' ? 'Your name for this print. Click to change.' : 'Cleaned up from the file name. Click to change.';
}
api.onPrintName(showPrintName);
$('printNameBtn').onclick = () => {
  const inp = $('printNameInput');
  inp.value = $('printNameBtn').textContent.replace(/[“”]/g, '');
  $('printNameBtn').classList.add('hidden'); inp.classList.remove('hidden'); inp.focus(); inp.select();
};
async function commitPrintName(save) {
  const inp = $('printNameInput');
  if (inp.classList.contains('hidden')) return;
  inp.classList.add('hidden'); $('printNameBtn').classList.remove('hidden');
  if (save && inp.value.trim()) showPrintName(await api.setPrintName(inp.value));
}
$('printNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') commitPrintName(true); if (e.key === 'Escape') commitPrintName(false); });
$('printNameInput').addEventListener('blur', () => commitPrintName(true));

// ---------- File menu ----------
async function saveSessionFile(saveAs = false) {
  if (!state.file) { toast('Open a model first, then save the session.', 4000); return; }
  try {
    const r = await api.sessionExport({ data: sessionPayload(), saveAs });
    if (!r) return;
    document.title = `${r.name} · AI 3D Print Advisor Studio`;
    toast(`Session saved as ${r.name}. Open it anytime with File → Open Session (or double-click it) to pick up exactly where you left off.`, 7000, () => api.showInFolder(r.path));
  } catch (e) { toast(`Couldn’t save the session: ${cleanErr(e)}`, 8000); }
}
async function openSessionFile(file = null) {
  try {
    const r = await withBusy('session', 'Opening the session…', () => api.sessionImport(file));
    if (!r) return;
    await openFile(api.openPath(r.filePath), r.state, { fromSession: true });
    await api.sessionOpened();
    if (r.state && r.state.selectedVariant) { state.selectedVariant = r.state.selectedVariant; renderCompare(); }
    document.title = `${r.name} · AI 3D Print Advisor Studio`;
    toast(`Opened ${r.name}${r.savedAt ? `, saved ${new Date(r.savedAt).toLocaleString()}` : ''}.${r.usingCopy ? ' The original model file was moved or changed, so the copy saved inside the session is used.' : ''}`, 7000);
  } catch (e) { toast(`Couldn’t open the session: ${cleanErr(e)}`, 8000); }
}
async function closeModel() {
  await api.sessionClear().catch(() => {});
  await api.sessionForgetFile().catch(() => {});
  location.reload();
}
// ---------- export for Bambu Lab printers ----------
async function openBambuExport(pre = null) {
  await toolheadsReady();
  if (!state.file) { toast('Open a model first.', 3000); return; }
  const dlg = $('bambuDialog');
  $('bxStatus').textContent = 'Looking for Bambu Studio…'; $('bxPrinter').innerHTML = ''; $('bxExport').disabled = true;
  const extra = pre && !['recommended', 'original'].includes(pre) ? variantDef(pre) : null;
  $('bxVersion').innerHTML = `<option value="recommended" ${state.result ? '' : 'disabled'}>Recommended (the checked settings)</option><option value="original">Original</option>${extra ? `<option value="${esc(extra.id)}">${esc(extra.name)} (from Compare)</option>` : ''}`;
  $('bxVersion').value = extra ? extra.id : (pre === 'original' || !state.result ? 'original' : 'recommended');
  dlg.showModal();
  const info = await api.bambuInfo().catch(() => ({ found: false }));
  $('bxLocate').classList.toggle('hidden', info.found);
  if (!info.found) { $('bxStatus').textContent = 'Bambu Studio wasn’t found. It’s free from bambulab.com; install it, or locate it if it’s already installed.'; return; }
  const pref = ['Bambu Lab X1 Carbon 0.4 nozzle', 'Bambu Lab P1S 0.4 nozzle', 'Bambu Lab A1 0.4 nozzle'];
  const list = info.printers.filter(n => /0\.4 nozzle/.test(n));
  const last = localStorage.getItem('bambuPrinter');
  const pick = list.includes(last) ? last : pref.find(p => list.includes(p));
  $('bxPrinter').innerHTML = list.map(n => `<option ${n === pick ? 'selected' : ''}>${esc(n)}</option>`).join('');
  $('bxStatus').textContent = `Using ${info.label} (${info.exe}).`;
  $('bxExport').disabled = false;
}
$('bxClose').onclick = () => $('bambuDialog').close();
$('bambuLeftBtn').onclick = () => openBambuExport();
$('bxLocate').onclick = async () => { if (await api.bambuLocate()) openBambuExport(); };
$('bxExport').onclick = async () => {
  const def = variantDef($('bxVersion').value);
  try { localStorage.setItem('bambuPrinter', $('bxPrinter').value); } catch { /* only a convenience */ }
  $('bxExport').disabled = true; $('bxStatus').textContent = 'Converting and exporting with Bambu Studio… (a minute or two)';
  try {
    const r = await withBusy('bambu', 'Exporting for Bambu Lab…', () => api.exportBambu({ machine: $('bxPrinter').value, changes: def.changes, objectChanges: def.objectChanges || null, rotations: def.rotations || state.rotations, plateIndex: state.plateIndex, variantName: def.name, thumbs: fileThumbs() }));
    if (r) { $('bambuDialog').close(); toast(`Saved the ${r.machine.replace(/ 0\.4 nozzle$/, '')} version (${r.how})${r.mixes ? `. ${r.mixes === 1 ? 'The color mix is' : `The ${r.mixes} color mixes are`} now ${r.mixes === 1 ? 'a filament' : 'filaments'} of ${r.mixes === 1 ? 'its' : 'their'} own in the blended color, so it needs ${r.filaments} filaments in the AMS` : ''}.${r.moved ? ` The model was moved ${r.moved} mm on the plate to make room for the purge tower.` : ''} It’s a Bambu Studio project, ready to upload to MakerWorld.`, 10000, () => api.showInFolder(r.path)); }
    else $('bxStatus').textContent = '';
  } catch (e) { $('bxStatus').textContent = cleanErr(e); }
  finally { $('bxExport').disabled = false; }
};

// ---------- convert without AI ----------
$('quickSaveBtn').onclick = () => { if (!state.file) { toast('Open a model first.', 3000); return; } save3mf(null, { noAI: true }); };

const BC = { files: [], outDir: null, running: false, status: [] };
function renderBatch() {
  const icon = { waiting: '·', working: '…', done: '✓', failed: '✕', skipped: '–' };
  $('bcList').innerHTML = BC.files.map((f, i) => {
    const st = BC.status[i] || { status: 'waiting', note: '' };
    return `<li><span class="st ${st.status}">${icon[st.status] || '·'}</span><span class="nm">${esc(f.split(/[\\/]/).pop())}${st.note ? `<span class="nt">${esc(st.note)}</span>` : ''}${st.out ? `<span class="nt">Saved as ${esc(st.out.split(/[\\/]/).pop())} <button class="link" data-show="${i}">Show</button></span>` : ''}</span>${BC.running ? '' : `<button class="link" data-remove="${i}" aria-label="Remove">✕</button>`}</li>`;
  }).join('');
  $('bcStart').disabled = BC.running || !BC.files.length;
  $('bcStop').classList.toggle('hidden', !BC.running);
  $('bcFolder').textContent = BC.outDir || '';
}
function openBatch(paths = []) {
  if (!BC.running) { const seen = new Set(BC.files); for (const p of paths) if (!seen.has(p)) { BC.files.push(p); BC.status.push(null); } }
  $('bcSummary').textContent = '';
  renderBatch();
  if (!$('batchDialog').open) $('batchDialog').showModal();
}
$('bcAdd').onclick = async () => openBatch(await api.batchChoose());
$('bcClear').onclick = () => { if (!BC.running) { BC.files = []; BC.status = []; renderBatch(); } };
$('bcPick').onclick = async () => { const d = await api.batchFolder(); if (d) { BC.outDir = d; document.querySelector('input[name=bcWhere][value=folder]').checked = true; renderBatch(); } };
$('bcClose').onclick = () => $('batchDialog').close();
$('bcStop').onclick = () => { api.batchCancel(); $('bcStop').disabled = true; };
$('bcList').onclick = (e) => {
  const r = e.target.closest('[data-remove]'); if (r) { BC.files.splice(+r.dataset.remove, 1); BC.status.splice(+r.dataset.remove, 1); renderBatch(); return; }
  const s2 = e.target.closest('[data-show]'); if (s2) api.showInFolder(BC.status[+s2.dataset.show].out);
};
api.onBatchProgress(({ i, status, note, out }) => { BC.status[i] = { status, note, out }; renderBatch(); });
$('bcStart').onclick = async () => {
  const toFolder = document.querySelector('input[name=bcWhere]:checked').value === 'folder';
  if (toFolder && !BC.outDir) { const d = await api.batchFolder(); if (!d) return; BC.outDir = d; }
  BC.running = true; BC.status = BC.files.map(() => ({ status: 'waiting', note: '' })); $('bcStop').disabled = false; renderBatch();
  try {
    const res = await api.batchConvert({ files: BC.files, outDir: toFolder ? BC.outDir : null });
    const ok = res.filter(r => r.ok).length;
    $('bcSummary').textContent = `${ok} of ${res.length} converted${ok < res.length ? `; ${res.length - ok} didn’t (see the list)` : ''}.`;
  } catch (e) { $('bcSummary').textContent = cleanErr(e); }
  finally { BC.running = false; renderBatch(); }
};

api.onMenu(({ action, arg }) => {
  if (action === 'batch') { openBatch(); return; }
  if (action === 'export-bambu') { openBambuExport(); return; }
  if (action === 'open-model') openFile(api.choose3mf());
  else if (action === 'open-session') openSessionFile(arg || null);
  else if (action === 'save-session') saveSessionFile(false);
  else if (action === 'save-session-as') saveSessionFile(true);
  else if (action === 'save-3mf') { if (state.file) save3mf(); else toast('Open a model first.', 3000); }
  else if (action === 'close-model') closeModel();
  else if (action === 'settings') openSettings();
  else if (action === 'guide') startGuide(state.result ? 5 : state.file ? 1 : 0);
});

async function offerPastAnalyses() {
  const list = await api.pastAnalyses().catch(() => []);
  const box = $('emptyFlow');
  if (!list.length || state.result) { box.textContent = 'Claude reviews the model’s shape and overhangs, a real slice of the original, your past prints, and the current Orca settings, then lists what to change.'; return; }
  const when = (iso) => new Date(iso).toLocaleString();
  const modelName = (m) => m === 'chatbot' ? 'free chatbot' : String(m).replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^\w/, c => c.toUpperCase());
  box.innerHTML = `<b>You’ve analyzed this file before.</b> Reuse an earlier answer at no cost:
    <span class="past-list">${list.slice(0, 5).map((a, i) => `<button class="btn" data-past="${i}">${esc(when(a.at))} · ${esc(modelName(a.model))}${a.kind === 'objects' ? ` · all objects (${a.result.results.length})` : a.result && a.result.recipe ? ` · ${esc(a.result.recipe.name)}` : ''}</button>`).join('')}</span>`;
  box.querySelectorAll('[data-past]').forEach(b => b.onclick = () => {
    const a = list[Number(b.dataset.past)];
    if (a.kind === 'objects') { if (a.slider != null) { $('slider').value = a.slider; drawLayers(); refreshRecipe(); } setObjectsResult(a.result); toast('Loaded the earlier analysis of every object. No new AI request was made.', 5000); return; }
    state.objects = null;
    state.result = a.result;
    if (a.slider != null) { $('slider').value = a.slider; drawLayers(); refreshRecipe(); }
    if (a.purpose) $('purpose').value = a.purpose;
    state.compare = null;
    renderResults(); renderStats();
    $('analyzeBtn').textContent = 'Get new recommendations';
    toast('Loaded the earlier recommendations. No new AI request was made.', 5000);
    saveSession();
  });
}

let restoreChecked = false;
async function maybeRestoreSession() {
  if (restoreChecked) return; restoreChecked = true;
  const s = await api.sessionGet().catch(() => null);
  if (!s || state.file) return;
  const name = s.filePath.split(/[\\/]/).pop();
  const restore = () => openFile(api.openPath(s.filePath), s.fileChanged ? { ...s, result: null } : s);
  if (s.autoRestore) { restore(); toast('The window had a problem and was reloaded. Your session was restored.', 7000); return; }
  const ago = Math.round((Date.now() - new Date(s.savedAt)) / 60000);
  const agoText = ago < 60 ? `${ago} min ago` : ago < 1440 ? `${Math.round(ago / 60)} h ago` : `${Math.round(ago / 1440)} days ago`;
  noticeWithActions(`Pick up where you left off? ${name}${s.result ? ' with its recommendations' : ''}${s.compareIds && s.compareIds.length ? ' and sliced comparisons' : ''}, saved ${agoText}.${s.fileChanged ? ' (The file has changed since, so recommendations will be fetched fresh.)' : ''}`, [
    { label: 'Restore', primary: true, fn: restore },
    { label: 'Start fresh', fn: () => api.sessionClear() },
  ]);
}
$('openBtn').onclick = () => openFile(api.choose3mf());
$('browseBtn').onclick = () => openFile(api.choose3mf());
api.onOpenFromOS(p => (/\.aipsession$/i.test(p) ? openSessionFile(p) : openFile(api.openPath(p))));
const drop = $('dropZone');
window.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragging'); });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) drop.classList.remove('dragging'); });
window.addEventListener('drop', e => {
  e.preventDefault(); drop.classList.remove('dragging');
  // several models at once: batch convert them
  const many = [...e.dataTransfer.files].filter(x => /\.3mf$/i.test(x.name));
  if (many.length > 1) { openBatch(many.map(x => api.pathForFile(x))); return; }
  const f = [...e.dataTransfer.files].find(x => /\.(3mf|aipsession)$/i.test(x.name));
  if (!f) { toast('That isn’t a .3mf model or a saved session. Drop a .3mf file, or an .aipsession file to reopen a session.', 5000); return; }
  if (/\.aipsession$/i.test(f.name)) openSessionFile(api.pathForFile(f));
  else openFile(api.openPath(api.pathForFile(f)));
});
drop.addEventListener('keydown', e => { if (e.key === 'Enter') openFile(api.choose3mf()); });

function matchPreset(type, preferred) {
  const list = state.info.filaments;
  if (!list.length) return '';
  if (preferred && list.some(f => f.name === preferred)) return preferred;
  const t = String(type || 'PLA').toUpperCase().replace('PETG-HF', 'PETG HF');
  return (list.find(f => f.group === 'Generic' && f.type.toUpperCase() === t) || list.find(f => f.type.toUpperCase() === t) || list.find(f => f.name === 'Generic PLA') || list[0]).name;
}
function initialSlots(filaments) {
  const src = filaments.length ? filaments : [{ slot: 1, type: 'PETG', color: DEFAULT_COLORS[0], preset: '' }];
  return src.map(f => {
    const type = TYPES.find(t => t.toLowerCase() === String(f.type).toLowerCase()) || f.type || 'PLA';
    return { slot: f.slot, type, color: String(f.color).slice(0, 7), preset: matchPreset(type, f.preset) };
  });
}

function renderFileInfo() {
  const f = state.file;
  $('fileTitle').innerHTML = `<strong>${esc(f.fileName)}</strong>${f.printer ? ` <span>made for ${esc(f.printer)}</span>` : ''}`;
  drop.classList.add('compact');
  drop.querySelector('.drop-title').textContent = 'Drop another .3mf here to replace it';
  ['thumbBlock', 'plateBlock', 'materialBlock', 'prefBlock', 'viewerTools', 'sceneBar'].forEach(id => $(id).classList.remove('hidden'));
  $('viewerEmpty').classList.add('hidden');
  const imgs = f.images.filter(i => !/pick|small/i.test(i.label));
  $('thumbBlock').classList.toggle('hidden', !imgs.length);
  $('thumbs').innerHTML = imgs.map((i, n) => `<button data-n="${n}" title="${esc(i.label)}"><img src="${i.dataUrl}" alt="${esc(i.label)}"></button>`).join('');
  $('thumbs').querySelectorAll('button').forEach(b => b.onclick = () => {
    const i = imgs[Number(b.dataset.n)];
    $('lightboxImg').src = i.dataUrl; $('lightboxLabel').textContent = i.label; $('lightbox').showModal();
  });
  $('plateBlock').classList.toggle('hidden', f.plates.length < 2);
  $('plateSelect').innerHTML = f.plates.map(p => `<option value="${p.index}">Plate ${p.index}${p.name ? `: ${esc(p.name)}` : ''} (${p.objectCount} object${p.objectCount === 1 ? '' : 's'})</option>`).join('');
  state.plateIndex = f.plates[0]?.index || 1;
  $('analyzeBtn').textContent = 'Get recommended settings';
  $('orcaBtn').disabled = !state.info.available;
  $('orcaBtn').title = state.info.available ? 'Write this project with the current changes and open it in Snapmaker Orca' : 'Set the Snapmaker Orca location in Settings';
  renderMaterials(); renderResults(); renderCompare(); refreshRecipe();
}
$('plateSelect').onchange = e => { state.plateIndex = Number(e.target.value); state.compare = null; loadPlate(); };

async function prepare() {
  if (TH.editing) endToolheadEdit();
  $('prepStatus').textContent = state.info.available ? 'Preparing the project for your printer…' : '';
  try {
    const r = await withBusy('prepare', state.info.available ? 'Preparing the project for your printer…' : 'Reading the project…', () => api.prepare(state.slots.map(s => ({ slot: s.slot, type: s.type, preset: s.preset, color: s.color }))));
    const notes = [...r.notes];
    state.mixes = r.mixes || [];
    if (r.slotMap) {
      // filaments were renumbered to fit the toolheads (e.g. 1, 3, 5 → T1, T2, T3): move the choices along
      const moved = state.slots.filter(x => r.slotMap[x.slot]).map(x => ({ ...x, slot: r.slotMap[x.slot] }));
      state.slots = moved.filter((x, i, a) => a.findIndex(y => y.slot === x.slot) === i).sort((a, b) => a.slot - b.slot);
      renderMaterials();
    }
    state.prepNotes = r.notes.filter(n => /^Corrected|^Kept the creator|^Converted|^Plain model/.test(n));
    if (!state.info.available) notes.push('Snapmaker Orca isn’t set up, so slicing and conversion are off. Set its location in Settings.');
    state.wrongPrinter = r.wrongPrinter || null;
    $('prepStatus').classList.toggle('prep-error', !!r.wrongPrinter);
    $('prepStatus').textContent = r.wrongPrinter
      ? `This file is still set up for the ${r.wrongPrinter.project}, not your ${r.wrongPrinter.printer}: converting it failed${r.error ? ` (${r.error})` : ''}. To keep your printer safe, the app won’t save, slice, send or analyze it. Open it in your slicer, choose your printer, save it, and open that copy here.`
      : notes.join(' ');
    if (r.wrongPrinter) toast(`This file couldn’t be converted to your ${r.wrongPrinter.printer}. See the red note on the left.`, 9000);
  } catch (e) { $('prepStatus').textContent = cleanErr(e); }
  await loadPlate();
  refreshRecipe();
}
const reprepare = debounce(() => applyToolheads(), 500);

async function loadPlate() {
  const a = await withBusy('measure', 'Measuring the model and scoring orientations…', () => api.analyzePlate({ plateIndex: state.plateIndex, rotations: state.rotations }));
  state.analysis = a;
  checkBlockers();
  checkHeavy();
  // assemblies: show the "fit together" choice; the user's choice wins over the guess
  // always offered: a piece alone on its plate can still snap or glue to pieces on other plates
  $('fitRow').classList.remove('hidden');
  state.assemblyGuess = !!a.assemblyGuess;
  $('fitTogether').checked = state.assemblyChoice ?? state.assemblyGuess;
  api.setAssembly({ assembly: $('fitTogether').checked, guess: state.assemblyGuess }).catch(() => {});
  let added = false;
  for (const e of a.totals.extrudersUsed) {
    if (e <= MAX_FILAMENTS && !state.slots.find(s => s.slot === e)) { const type = state.slots[0]?.type || 'PETG'; state.slots.push({ slot: e, type, preset: matchPreset(type), color: DEFAULT_COLORS[(e - 1) % 4] }); added = true; }
  }
  state.slots.sort((x, y) => x.slot - y.slot);
  renderMaterials();
  viewer.load(a.preview);
  const notes = [];
  if (a.totals.parkedObjects) notes.push(`${a.totals.parkedObjects} object${a.totals.parkedObjects === 1 ? '' : 's'} parked off the plate ${a.totals.parkedObjects === 1 ? 'is' : 'are'} ignored, as in Orca.`);
  if (a.totals.previewSimplified) notes.push('Preview simplified for speed. Measurements use the full mesh.');
  $('viewerNote').classList.toggle('hidden', !notes.length);
  $('viewerNote').textContent = notes.join(' ');
  renderStats(); renderOrientation();
  refreshObjectsPlan();
  if (added) reprepare();
}

// ---------- materials ----------
function presetOptions(sel) {
  const groups = {};
  for (const f of state.info.filaments) (groups[f.group] ||= []).push(f);
  return Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(f => `<option value="${esc(f.name)}" ${f.name === sel ? 'selected' : ''}>${esc(f.name.replace(/ @U1.*$/, ''))}</option>`).join('')}</optgroup>`).join('');
}
const toolheadCount = () => Math.max(1, Number(state.info?.toolheads) || 4);
// "Clean-release supports": the support interface in the opposite material (PLA under PETG, PETG under PLA), offered
// when the model is PLA or PETG; usable once the other material is loaded in a toolhead (src/interface.js)
const slotMaterials = () => state.slots.map(s => ({ toolhead: `T${s.slot}`, material: s.type }));
async function refreshIface() {
  const row = $('ifaceRow'), box = $('ifaceOpposite');
  let plan = null;
  try { plan = state.analysis ? await api.supportInterfacePlan({ materials: slotMaterials(), used: state.analysis.totals.extrudersUsed || [] }) : null; } catch {}
  state.ifacePlan = plan;
  if (!plan || (!plan.ok && !plan.modelFamily)) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  box.disabled = !plan.ok;
  if (!plan.ok) box.checked = false;
  else if (state.ifaceChoice != null) box.checked = state.ifaceChoice;
  $('ifaceText').textContent = plan.ok
    ? `${plan.interfaceFamily} on T${plan.slot} under the ${plan.modelFamily} model: the two don’t stick, so supports lift off and leave an almost flawless underside. The app sets wide, flat, solid support roofs with no gap (the model can’t grip the roof, so small tips would let it slide). Costs some tool changes and a prime tower.`
    : plan.reason;
}
$('ifaceOpposite').addEventListener('change', () => { state.ifaceChoice = $('ifaceOpposite').checked; saveSession(); });
const ifaceOn = () => !!(state.ifacePlan && state.ifacePlan.ok && $('ifaceOpposite').checked);
// Toolheads are locked by default: changing a material or color sets the whole project up again (slow on big models),
// so the user unlocks them, makes every change (the 3D view recolors live), and clicks Done to set it up once.
const TH = { editing: false, before: null };
const thSnap = () => JSON.stringify(state.slots.map(s => ({ slot: s.slot, type: s.type, preset: s.preset, color: s.color })));
function renderToolheadLock() {
  const ed = TH.editing;
  $('thLock').classList.toggle('editing', ed);
  $('thLockText').textContent = ed
    ? 'Unlocked: change materials and colors, add or remove toolheads. The project is set up once, when you click Done.'
    : 'Locked, so the project isn’t set up again after every little change.';
  $('thEditBtn').classList.toggle('hidden', ed);
  $('thDoneBtn').classList.toggle('hidden', !ed);
  $('thCancelBtn').classList.toggle('hidden', !ed);
  $('materials').classList.toggle('locked', !ed);
  $('materials').querySelectorAll('.mat-row[data-slot] select, .mat-row[data-slot] input[type=color], .mat-row[data-slot] .remove').forEach(el => { el.disabled = !ed; });
  $('materials').querySelectorAll('.mat-row[data-slot] .swatch').forEach(el => { el.title = ed ? 'Filament color' : 'Click ✎ Change toolheads first'; });
}
function startToolheadEdit() { TH.editing = true; TH.before = thSnap(); renderMaterials(); }
// stop editing; true when something changed (the caller sets the project up)
function endToolheadEdit() { const changed = TH.before != null && TH.before !== thSnap(); TH.editing = false; TH.before = null; renderMaterials(); return changed; }
// Before anything that uses the set-up project (recommendations, save, slice, send…): apply an open edit first.
async function toolheadsReady() {
  if (!TH.editing) return;
  if (endToolheadEdit()) await applyToolheads();
}
async function applyToolheads() { state.compare = null; saveSession(); await prepare(); if (state.result) { toast('Toolheads changed. Get new recommendations to update the plan.', 5000); refreshChecks(); } }
$('thEditBtn').onclick = () => startToolheadEdit();
$('thDoneBtn').onclick = () => { if (endToolheadEdit()) applyToolheads(); };
$('thCancelBtn').onclick = () => {
  const before = TH.before ? JSON.parse(TH.before) : null;
  TH.editing = false; TH.before = null;
  if (before) state.slots = before.map(b => ({ ...(state.slots.find(s => s.slot === b.slot) || {}), ...b }));
  renderMaterials();
};
function renderMaterials() {
  const used = new Set(state.analysis?.totals.extrudersUsed || [1]);
  const usePresets = state.info.filaments.length > 0;
  refreshIface();
  $('materials').innerHTML = state.slots.map(s => `
    <div class="mat-row ${used.has(s.slot) ? '' : 'unused'}" data-slot="${s.slot}">
      <label class="swatch" style="background:${esc(s.color)}" title="Filament color"><input type="color" value="${esc(s.color)}"></label>
      <span class="tool">T${s.slot}</span>
      <select aria-label="Filament for toolhead ${s.slot}">${usePresets ? presetOptions(s.preset) : TYPES.map(m => `<option ${m === s.type ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
      ${(() => { const f = finishOf(s), F = FINISHES.find(x => x[0] === f); return `<button type="button" class="sparkle-btn ${f === 'normal' ? '' : `on f-${f}`}" title="Finish: ${esc(F[1])} (how it looks in the 3D view; click to change: galaxy, silk, matte, translucent, glow in the dark)" aria-label="Filament finish on toolhead ${s.slot}: ${esc(F[1])}" aria-haspopup="menu">${f === 'normal' ? '✦' : F[2]}</button>`; })()}
      ${used.has(s.slot) ? '<span></span>' : `<button class="remove" title="Remove T${s.slot}" aria-label="Remove toolhead ${s.slot}">×</button>`}
    </div>`).join('') + mixRowsHtml();
  $('materials').querySelectorAll('.mat-row[data-slot]').forEach(row => {
    const slot = state.slots.find(s => s.slot === Number(row.dataset.slot));
    row.querySelector('select').onchange = e => {
      if (usePresets) { slot.preset = e.target.value; slot.type = (state.info.filaments.find(f => f.name === slot.preset) || {}).type || slot.type; }
      else slot.type = e.target.value;
      refreshIface();
    };
    row.querySelector('input[type=color]').oninput = e => { slot.color = e.target.value; row.querySelector('.swatch').style.background = slot.color; pushColors(); refreshMixRows(); };
    const rm = row.querySelector('.remove');
    if (rm) rm.onclick = () => { state.slots = state.slots.filter(s => s !== slot); renderMaterials(); };
    row.querySelector('.sparkle-btn').onclick = (e) => openFinishMenu(e.currentTarget, slot);
  });
  renderToolheadLock();
  renderCautions();
  $('addSlotBtn').classList.toggle('hidden', !TH.editing || state.slots.length >= MAX_FILAMENTS);
  $('addSlotBtn').textContent = state.slots.length >= toolheadCount() ? 'Add a filament' : 'Add a toolhead';
  // more solid filaments than toolheads: allowed, with a warning
  const extra = state.slots.length - toolheadCount();
  $('slotWarn').classList.toggle('hidden', !(extra > 0 && toolheadCount() > 1));
  if (extra > 0) $('slotWarn').innerHTML = `<b>${state.slots.length} solid filaments, but the ${esc(state.info.printerShort || 'printer')} has ${toolheadCount()} toolheads.</b> Filament${extra === 1 ? '' : 's'} ${state.slots.slice(toolheadCount()).map(s => `T${s.slot}`).join(', ')} ${extra === 1 ? 'has' : 'have'} no toolhead of ${extra === 1 ? 'its' : 'their'} own, so check the filament-to-toolhead assignment in Snapmaker Orca before printing it on the ${esc(state.info.printerShort || 'printer')}. That’s fine for a file you’ll share or export for Bambu printers with an AMS, which can load 16 or more colors.`;
  pushColors();
  renderShopping().catch(() => {});
}
$('addSlotBtn').onclick = () => {
  const free = Array.from({ length: MAX_FILAMENTS }, (_, i) => i + 1).find(n => !state.slots.find(s => s.slot === n));
  if (!free) return;
  state.slots.push({ slot: free, type: 'PLA', preset: matchPreset('PLA'), color: DEFAULT_COLORS[(free - 1) % DEFAULT_COLORS.length] });
  state.slots.sort((x, y) => x.slot - y.slot);
  renderMaterials();
};
// Snapmaker Orca color mixes in the file: shown under the toolheads (they're printed with those toolheads in turn)
function mixRowsHtml() {
  const mixes = state.mixes || [];
  if (!mixes.length) return '';
  const usedMix = new Set(state.analysis?.totals.mixesUsed || mixes.map(m => m.id));
  return `<div class="mix-head"><b>Color mixes</b> <span class="muted">from Snapmaker Orca: thin layers of these toolheads in turn, which blend into a new color</span></div>` +
    mixes.map((m, i) => `<div class="mat-row mix-row ${usedMix.has(m.id) ? '' : 'unused'}" data-mix="${m.id}">
      <span class="swatch mix-swatch" style="background:${esc(mixColor(m))}" title="Blended color (as Snapmaker Orca shows it)"></span>
      <span class="tool" title="Filament ${m.id} in Snapmaker Orca">M${i + 1}</span>
      <span class="mix-recipe">${m.parts.map(p => `<i class="dot" style="background:${esc(slotColor(p.slot))}"></i>T${p.slot} ${Math.round(p.pct)}%`).join(' + ')}</span>
      <span></span><span></span>
    </div>`).join('');
}
function refreshMixRows() {
  for (const m of state.mixes || []) {
    const row = $('materials').querySelector(`[data-mix="${m.id}"]`);
    if (!row) continue;
    row.querySelector('.mix-swatch').style.background = mixColor(m);
    row.querySelectorAll('.dot').forEach((d, i) => { d.style.background = slotColor(m.parts[i].slot); });
  }
}
// ---------- the model's own colours vs. the filament inventory: what to buy ----------
const SHOP = { key: '', data: null, found: null };
async function renderShopping() {
  const used = new Set(state.analysis?.totals.extrudersUsed || []);
  const slots = state.slots.filter(s => used.has(s.slot)).map(s => ({ slot: s.slot, type: s.type, color: s.color }));
  const key = JSON.stringify(slots);
  if (!state.file || !slots.length) { $('shop').classList.add('hidden'); return; }
  if (key !== SHOP.key) {
    SHOP.key = key; SHOP.found = null;
    SHOP.data = await api.shoppingCheck({ slots }).catch(() => null);
    if (SHOP.key !== key) return; // changed again meanwhile
  }
  const d = SHOP.data;
  const need = d && d.ok ? d.rows.filter(r => r.status !== 'have') : [];
  $('shop').classList.toggle('hidden', !need.length);
  if (!need.length) return;
  const found = SHOP.found;
  $('shop').innerHTML = `<h4>Colors you may not have</h4>
    <ul>${need.map(r => {
      const prods = found && (found.results.find(x => x.slot === r.slot) || {}).products;
      return `<li><span class="sw" style="background:${esc(r.color)}"></span><div>
        <b>T${r.slot}: ${esc(r.words)} ${esc(r.type)}</b> <span class="muted">${esc(r.color.toUpperCase())}</span><br>
        <span class="muted">${r.have ? (r.status === 'close' ? `Closest you have: ${esc(r.have.name)} (similar)` : `Closest you have: ${esc(r.have.name)} (not a close match)`) : `No ${esc(r.type)} in your inventory`}</span>
        <div class="links"><a href="${esc(r.amazon)}" target="_blank" rel="noopener">Search Amazon</a></div>
        ${prods ? (prods.length ? prods.map(p => `<div class="prod"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>${p.price ? ` <b>${esc(p.price)}</b>` : ''} <span class="muted">${esc(p.colorMatch || '')}${p.why ? ' · ' + esc(p.why) : ''}</span></div>`).join('') : '<div class="muted">No exact product found.</div>') : ''}
      </div></li>`;
    }).join('')}</ul>
    ${!found && d.hasKey ? `<div class="row-btns"><button class="btn small" id="shopFind">Find exact products with AI</button> <span class="cost-line">${d.findCost ? `about ${money(d.findCost.low)}–${money(d.findCost.high)}` : ''}</span></div>` : ''}
    ${d.onHand ? '' : '<span class="muted">Compared with everything you’ve bought; import your inventory on the Filament screen to compare with what’s on hand.</span>'}`;
  const b = $('shop').querySelector('#shopFind');
  if (b) b.onclick = async () => {
    b.disabled = true; b.textContent = 'Searching…';
    try { SHOP.found = await withBusy('shop', 'Searching the web for matching filaments…', () => api.shoppingFind({ rows: need })); renderShopping(); }
    catch (e) { toast(cleanErr(e), 7000); b.disabled = false; b.textContent = 'Find exact products with AI'; }
  };
}
// ---------- filament looks in the 3D views: toolhead colors, Snapmaker Orca color mixes, filament finishes ----------
// Each toolhead's finish (the button next to its color): guessed from the filament's name, or picked by hand
const FINISHES = [['normal', 'Normal', '○', 'plain filament'], ['galaxy', 'Galaxy / glitter', '✦', 'sparkly flakes'], ['silk', 'Silk', '◈', 'glossy, pearly sheen'],
  ['matte', 'Matte', '■', 'flat, no shine'], ['translucent', 'Translucent', '◇', 'light shines through'], ['glow', 'Glow in the dark', '☾', 'glows with the lights off'],
  ['chrome', 'Chrome', '◉', 'mirror finish, most reflective']];
const SPARKLE_WORDS = /galaxy|glitter|sparkl|starry|star ?dust|twinkl|cosmic|nebula|shimmer|metal ?flake|flake/i;
function finishOf(s) {
  if (s.finish && FINISH_CODES[s.finish] != null) return s.finish;
  if (s.sparkle != null) return s.sparkle ? 'galaxy' : 'normal';   // chosen with the old ✦ button
  const t = `${s.preset || ''} ${s.name || ''}`;
  if (SPARKLE_WORDS.test(t)) return 'galaxy';
  if (/chrome|mirror/i.test(t)) return 'chrome';
  if (/glow|luminous|gitd|phosphor/i.test(t)) return 'glow';
  if (/silk|satin|shiny|lustre|luster/i.test(t)) return 'silk';
  if (/matte?\b|\bmatt\b/i.test(t)) return 'matte';
  if (/translucent|transparent|clear|crystal|glass|frost/i.test(t)) return 'translucent';
  return 'normal';
}
const sparkles = (s) => finishOf(s) === 'galaxy';

// ---------- filaments that are hard on nozzles or need special handling ----------
// From the filament's type, preset and name (and the Glow in the dark finish). New users rarely know that fiber-filled
// and glow-in-the-dark filament wear out a standard nozzle, so these are shown under the toolheads and before printing.
const ABRASIVE = [
  [/(^|[^a-z])(cf|carbon)([^a-z]|$)|carbon ?fib/i, 'carbon fiber', true],
  [/(^|[^a-z])gf([^a-z]|$)|glass ?fib/i, 'glass fiber', true],
  [/kevlar|aramid/i, 'aramid (Kevlar) fiber', true],
  [/glow|gitd|luminous|phosphor/i, 'glow-in-the-dark', false],
  [/metal ?fill|copper|bronze|brass ?fill|steel ?fill|iron ?fill|magnetic|tungsten/i, 'metal-filled', false],
  [/marble|stone ?fill|ceramic|granite|concrete/i, 'stone- or ceramic-filled', false],
];
function filamentCautions(slots) {
  const out = [];
  for (const s of slots) {
    const text = `${s.type || ''} ${s.preset || ''} ${s.name || ''}`;
    const tool = `T${s.slot}`;
    const hits = ABRASIVE.filter(([re]) => re.test(text)).map(([, name, fiber]) => ({ name, fiber }));
    if (finishOf(s) === 'glow' && !hits.some(h => h.name === 'glow-in-the-dark')) hits.push({ name: 'glow-in-the-dark', fiber: false });
    if (hits.length) {
      const what = hits.map(h => h.name).join(' and ');
      out.push({ kind: 'abrasive', slot: s.slot, title: `${tool}: ${what} filament is abrasive`,
        detail: `It wears out a standard brass or stainless steel nozzle (what most printers come with) quickly, sometimes within a few hundred grams. A worn nozzle under-extrudes and ruins prints. Fit a hardened steel (or other wear-resistant) nozzle on ${tool} before printing it.${hits.some(h => h.fiber) ? ' A 0.6 mm nozzle also clogs less with fiber-filled filament.' : ''}` });
      continue;
    }
    if (/wood|bamboo|cork/i.test(text)) out.push({ kind: 'special', slot: s.slot, title: `${tool}: wood-filled filament`, detail: 'The wood particles can clog a 0.4 mm nozzle: a 0.6 mm nozzle is safer. Don’t leave it sitting hot in the nozzle.' });
    else if (/tpu|tpe|flex|95a|85a/i.test(text)) out.push({ kind: 'special', slot: s.slot, title: `${tool}: flexible filament (TPU)`, detail: 'Print it slowly (about 20–40 mm/s) and keep retraction short, or it buckles and jams.' });
    else if (/(^|[^a-z])(pa|pa6|pa12|paht|nylon|pc)([^a-z]|$)|polycarbonate/i.test(text)) out.push({ kind: 'special', slot: s.slot, title: `${tool}: nylon or polycarbonate`, detail: 'It soaks up moisture from the air within hours: dry it first (e.g. 70–80 °C for 6 hours or more) and keep it dry while printing. It needs high temperatures; an enclosure helps.' });
    else if (/(^|[^a-z])(abs|asa)([^a-z]|$)/i.test(text)) out.push({ kind: 'special', slot: s.slot, title: `${tool}: ABS / ASA`, detail: 'It gives off fumes and warps in drafts: print in an enclosure, with the room ventilated.' });
  }
  return out;
}
function cautionsHtml(list) {
  return list.map(c => `<div class="fc ${c.kind}"><b>${c.kind === 'abrasive' ? '⚠ ' : ''}${esc(c.title)}</b>${esc(c.detail)}</div>`).join('');
}
function renderCautions() {
  const used = new Set(state.analysis?.totals.extrudersUsed || state.slots.map(s => s.slot));
  const list = filamentCautions(state.slots.filter(s => used.has(s.slot)));
  $('matCautions').innerHTML = cautionsHtml(list);
  $('matCautions').classList.toggle('hidden', !list.length);
}
function openFinishMenu(btn, slot) {
  document.querySelector('.finish-menu')?.remove();
  const cur = finishOf(slot);
  const m = document.createElement('div');
  m.className = 'finish-menu'; m.setAttribute('role', 'menu');
  m.innerHTML = FINISHES.map(([id, name, icon, hint]) => `<button role="menuitemradio" aria-checked="${id === cur}" data-finish="${id}"><i>${icon}</i>${esc(name)}<small>${esc(hint)}</small></button>`).join('');
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect();
  m.style.left = `${Math.min(r.left, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${r.bottom + 4 + m.offsetHeight > innerHeight ? r.top - m.offsetHeight - 4 : r.bottom + 4}px`;
  m.querySelectorAll('[data-finish]').forEach(b => b.onclick = () => {
    slot.finish = b.dataset.finish; delete slot.sparkle;
    m.remove(); saveSession(); renderMaterials(); pushColors(); updateNightBtn();
  });
  setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off); } }), 0);
}
function slotColor(n) {
  const s = state.slots.find(x => x.slot === n);
  return s ? s.color : String((state.file && state.file.fileColors || [])[n - 1] || '#888888').slice(0, 7);
}
// a mix looks like its filaments blended (what Snapmaker Orca shows), from the toolhead colors as they are now
function mixColor(m, slots = state.slots) {
  const rgb = [0, 0, 0];
  for (const p of m.parts) {
    const s = slots.find(x => x.slot === p.slot);
    const v = parseInt(String(s ? s.color : slotColor(p.slot)).replace('#', '').slice(0, 6), 16) || 0x888888;
    rgb[0] += ((v >> 16) & 255) * p.pct / 100; rgb[1] += ((v >> 8) & 255) * p.pct / 100; rgb[2] += (v & 255) * p.pct / 100;
  }
  return '#' + rgb.map(c => Math.round(Math.min(255, c)).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function filamentLooks(slots = state.slots) {
  const colors = Object.fromEntries(slots.map(s => [s.slot, s.color]));
  const sparkle = Object.fromEntries(slots.filter(sparkles).map(s => [s.slot, 1]));
  const finish = Object.fromEntries(slots.map(s => [s.slot, FINISH_CODES[finishOf(s)] || 0]));
  for (const m of state.mixes || []) {
    colors[m.id] = mixColor(m, slots);
    const share = m.parts.reduce((t, p) => t + (sparkle[p.slot] ? p.pct / 100 : 0), 0);
    if (share > 0) sparkle[m.id] = share;
    // a mix looks like the finish of its biggest share
    const main = [...m.parts].sort((a, b) => b.pct - a.pct)[0];
    if (main && finish[main.slot]) finish[m.id] = finish[main.slot];
  }
  return { colors, sparkle, finish };
}
function pushColors(v = viewer) { const L = filamentLooks(); v.setFilamentColors(L.colors, L.sparkle, L.finish); updateNightBtn(); }
// ---------- "See it in place": the model in a setting (renderer/viewer.js setScene, renderer/scenes/) ----------
// 3D-built settings (every theme, day / evening / night, true size), the app's photo settings (sharp still photos in
// renderer/scenes/photos/, listed in its manifest.json with where the model stands in each) and your own photos.
// Dragging turns the model; the setting stays put. The app always starts on the build plate.
let SCENE_STILLS = [];
fetch('scenes/photos/manifest.json').then(r => (r.ok ? r.json() : [])).then(l => { SCENE_STILLS = Array.isArray(l) ? l : []; renderSceneSelect(); }).catch(() => {});
const SC = { sel: '', time: 'day', trueSize: true, mine: { scale: 1, x: 0, y: 0 }, accent: 1, myPhotos: [], busy: false };
async function renderSceneSelect() {
  try { SC.myPhotos = await api.sceneMyPhotos(); } catch { SC.myPhotos = []; }
  const o = (v, label) => `<option value="${esc(v)}" ${SC.sel === v ? 'selected' : ''}>${esc(label)}</option>`;
  $('sceneSelect').innerHTML = o('', 'Build plate (no setting)')
    + `<optgroup label="Settings">${BUILT.map(b => o(`built:${b.id}`, b.name)).join('')}</optgroup>`
    + (SCENE_STILLS.length ? `<optgroup label="Photos">${SCENE_STILLS.map(p => o(`still:${p.id}`, p.name)).join('')}</optgroup>` : '')
    + `<optgroup label="My photos">${SC.myPhotos.map(p => o(`mine:${p.id}`, p.name)).join('')}<option value="mine:+">Add a photo…</option></optgroup>`;
}
async function applyScene() {
  if (SC.busy) return;
  const sel = SC.sel;
  const inScene = !!sel;
  document.querySelectorAll('#sceneBar .scene-only').forEach(e => e.classList.toggle('hidden', !inScene));
  const photo = sel.startsWith('mine:') || sel.startsWith('still:');
  // Adjust: in a photo the model's size, place and brightness; in a built setting its own (accent) lights; both: glow
  $('sceneAdjust').classList.toggle('hidden', !inScene);
  if (!inScene) { $('sceneMine').classList.add('hidden'); $('sceneAdjust').setAttribute('aria-expanded', 'false'); }
  document.querySelectorAll('#sceneMine .still-only').forEach(e => e.classList.toggle('hidden', !photo));
  $('sceneSize').classList.toggle('hidden', !inScene || photo);
  document.querySelectorAll('#sceneTime [data-time]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.time === SC.time)));
  if (!inScene) { viewer.setScene(null); $('sceneNote').textContent = ''; return; }
  SC.busy = true;
  try {
    let spec;
    if (sel.startsWith('built:')) spec = { kind: 'built', id: sel.slice(6) };
    else if (sel.startsWith('still:')) {
      // an app photo: where the model stands in it is preset (the sliders still adjust it)
      const p = SCENE_STILLS.find(x => x.id === sel.slice(6));
      if (!p) throw new Error('That photo setting isn’t available.');
      if (SC.lastStill !== p.id) { SC.mine = stillDefaults(p); SC.lastStill = p.id; syncMineSliders(); }
      spec = { kind: 'still', image: `scenes/photos/${p.file}`, light: p.light, pitch: p.pitch, at: p.at };
    } else if (sel.startsWith('mine:')) { SC.lastStill = null; spec = { kind: 'still', image: await api.sceneMyPhoto(sel.slice(5)), light: 'front' }; }
    $('sceneNote').textContent = '';
    viewer.setScene(spec, { time: SC.time, trueSize: SC.trueSize, mine: SC.mine, accent: SC.accent });
    localStorage.setItem('aipa.scene', JSON.stringify({ sel, time: SC.time, trueSize: SC.trueSize }));
  } catch (e) {
    $('sceneNote').textContent = ''; toast(cleanErr(e), 7000);
    SC.sel = ''; $('sceneSelect').value = ''; viewer.setScene(null);
    document.querySelectorAll('#sceneBar .scene-only').forEach(x => x.classList.add('hidden'));
  } finally { SC.busy = false; }
}
$('sceneSelect').onchange = async (e) => {
  let v = e.target.value;
  if (v === 'mine:+') {
    try { const p = await api.sceneAddPhoto(); if (!p) { e.target.value = SC.sel; return; } v = `mine:${p.id}`; SC.mine = stillDefaults(); SC.lastStill = null; syncMineSliders(); }
    catch (err) { toast(cleanErr(err), 6000); e.target.value = SC.sel; return; }
  }
  SC.sel = v; await renderSceneSelect(); await applyScene();
};
document.querySelectorAll('#sceneTime [data-time]').forEach(b => b.onclick = () => { SC.time = b.dataset.time; applyScene(); });
$('sceneSize').onclick = () => {
  SC.trueSize = !SC.trueSize;
  $('sceneSize').setAttribute('aria-pressed', String(SC.trueSize));
  $('sceneSize').textContent = SC.trueSize ? 'True size' : 'Fill the view';
  $('sceneSize').title = SC.trueSize ? 'True size: the model at its real size in the setting. Click to fill the view instead.' : 'Fill the view: the model shown big. Click for its true size in the setting.';
  viewer.setSceneOptions({ trueSize: SC.trueSize });
};
// the Adjust panel: size, left / right and back / front (as % of the photo), photo and model brightness (2^n)
function stillDefaults(p) { return { scale: (p && p.scale) || 1, x: 0, y: 0, photo: 0, light: 0 }; }
function syncMineSliders() { $('mineScale').value = Math.log2(SC.mine.scale || 1); $('mineX').value = SC.mine.x || 0; $('mineY').value = SC.mine.y || 0; $('minePhoto').value = SC.mine.photo || 0; $('mineLight').value = SC.mine.light || 0; }
$('sceneAdjust').onclick = () => {
  const open = $('sceneMine').classList.toggle('hidden') === false;
  $('sceneAdjust').setAttribute('aria-expanded', String(open));
};
const mineChange = () => {
  SC.mine = { scale: Math.pow(2, Number($('mineScale').value)), x: Number($('mineX').value), y: Number($('mineY').value), photo: Number($('minePhoto').value), light: Number($('mineLight').value) };
  viewer.setSceneOptions({ mine: SC.mine });
};
for (const id of ['mineScale', 'mineX', 'mineY', 'minePhoto', 'mineLight']) $(id).oninput = mineChange;
$('mineReset').onclick = () => {
  $('mineGlow').value = 0; viewer.setGlowGain(1);
  SC.accent = 1; $('sceneAccent').value = 1; viewer.setSceneOptions({ accent: 1 });
  if (SC.sel.startsWith('still:') || SC.sel.startsWith('mine:')) { SC.mine = stillDefaults(SCENE_STILLS.find(x => x.id === SC.lastStill)); syncMineSliders(); viewer.setSceneOptions({ mine: SC.mine }); }
};
// Accent lights (built settings): kept from setting to setting
$('sceneAccent').oninput = () => { SC.accent = Number($('sceneAccent').value); viewer.setSceneOptions({ accent: SC.accent }); };
// Glow intensity: 2^n, kept across settings (also used by Lights off on the plate)
$('mineGlow').oninput = () => viewer.setGlowGain(Math.pow(2, Number($('mineGlow').value)));
$('sceneShot').onclick = async () => {
  try {
    const where = SC.sel ? $('sceneSelect').selectedOptions[0].textContent : '';
    const p = await api.saveImage({ dataUrl: viewer.snapshot(), name: `${(state.file && (state.printName || state.file.fileName.replace(/\.3mf$/i, ''))) || 'Print'}${where ? ` - ${where}` : ''}` });
    if (p) toast('Picture saved.', 5000, () => api.showInFolder(p));
  } catch (e) { toast(cleanErr(e), 6000); }
};
renderSceneSelect();

// the 3D view's Spin and Lights off buttons
$('spinBtn').onclick = () => { const on = !viewer.spin; viewer.setSpin(on); $('spinBtn').setAttribute('aria-pressed', String(on)); };
viewer.onSpinStop = () => $('spinBtn').setAttribute('aria-pressed', 'false');
$('nightBtn').onclick = () => { const on = !viewer.night; viewer.setNight(on); $('nightBtn').setAttribute('aria-pressed', String(on)); };
function updateNightBtn() {
  const any = (state.slots || []).some(s => finishOf(s) === 'glow');
  $('nightBtn').classList.toggle('hidden', !any);
  $('mineGlowRow').classList.toggle('hidden', !any);
  if (!any && viewer.night) { viewer.setNight(false); $('nightBtn').setAttribute('aria-pressed', 'false'); }
}

// ---------- orientation ----------
function renderOrientation() {
  const objs = (state.analysis?.objects || []).filter(o => o.orientationOptions && o.orientationOptions.length);
  $('orientBlock').classList.toggle('hidden', !objs.length);
  if (!objs.length) return;
  if (!objs.find(o => o.itemIndex === state.orientObj)) state.orientObj = objs[0].itemIndex;
  $('orientObject').classList.toggle('hidden', objs.length < 2);
  $('orientObject').innerHTML = objs.map(o => `<option value="${o.itemIndex}" ${o.itemIndex === state.orientObj ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  const obj = objs.find(o => o.itemIndex === state.orientObj);
  const current = state.rotations[obj.itemIndex];
  const bestId = obj.orientationOptions[0].id;
  const list = obj.orientationShortlist || obj.orientationOptions.slice(0, 4);
  $('orientList').innerHTML = list.map(o => {
    const on = current ? JSON.stringify(o.rotation) === JSON.stringify(current) : o.isCurrent;
    return `<label class="orient-opt ${o.id === bestId ? 'best' : ''} ${o.unstable ? 'unstable' : ''}" aria-checked="${on}">
      <input type="radio" name="orient" value="${esc(o.id)}" ${on ? 'checked' : ''}>
      <span class="t">${esc(o.isCurrent ? 'As placed in the file' : o.label)}</span>
      <span class="m">${o.overhangCm2} cm² overhang, ${o.contactCm2} cm² on the bed, ${o.heightMm} mm (${inch(o.heightMm)} in) tall${o.fits ? '' : ', too big'}</span>
      ${o.look ? `<span class="look ${esc(o.look.level)}">${o.look.level === 'good' ? '✓' : '⚠'} Look: ${esc(o.look.text)}</span>` : ''}
    </label>`;
  }).join('');
  $('orientList').querySelectorAll('input').forEach(inp => inp.onchange = () => {
    const o = obj.orientationOptions.find(x => x.id === inp.value);
    setRotation(obj.itemIndex, o.isCurrent ? null : o.rotation);
    guideEvent('oriented');
  });
}
$('orientObject').onchange = e => { state.orientObj = Number(e.target.value); renderOrientation(); };
async function setRotation(itemIndex, rotation) {
  if (rotation) state.rotations[itemIndex] = rotation; else delete state.rotations[itemIndex];
  saveSession();
  state.compare = null;
  await loadPlate();
  refreshChecks();
}

// ---------- viewer controls ----------
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
  viewer.setMode(b.dataset.mode);
  $('legend').classList.toggle('hidden', b.dataset.mode !== 'overhang');
});
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => viewer.fit(b.dataset.view));

// ---------- measurement strip ----------
const fmt = n => (Math.round(n * 10) / 10).toLocaleString();
const inch = mm => (mm / 25.4).toFixed(2);
const compact = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
// rounded to whole minutes first, so 1 h 59.6 min shows as 2h 0m, not 1h 60m
const hm = s => { if (!s && s !== 0) return '—'; const t = Math.round(s / 60), h = Math.floor(t / 60), m = t % 60; return h ? `${h}h ${m}m` : `${m}m`; };
function renderStats() {
  const t = state.analysis.totals, objs = state.analysis.objects;
  const footprint = objs.reduce((s, o) => s + (o.sizeMm.x * o.sizeMm.y) / 100, 0);
  const contactPct = footprint ? Math.round(100 * t.bedContactAreaCm2 / footprint) : 0;
  const orig = state.compare?.results?.find(r => r.id === 'original' && r.ok) || (state.result?.originalSlice ? { ...state.result.originalSlice, ok: true } : null);
  const cells = [
    { k: 'Size in mm (X × Y × Z)', v: `${fmt(t.sizeMm.x)} × ${fmt(t.sizeMm.y)} × ${fmt(t.sizeMm.z)}`, sub: t.fitsBuildVolume ? 'fits the U1' : 'larger than 270 mm', cls: t.fitsBuildVolume ? '' : 'bad' },
    { k: 'Size in inches', v: `${inch(t.sizeMm.x)} × ${inch(t.sizeMm.y)} × ${inch(t.sizeMm.z)}`, sub: 'U1 prints up to 10.6 in' },
    { k: 'Solid volume', v: `${fmt(t.volumeCm3)} cm³`, sub: `${(t.volumeCm3 / 16.387).toFixed(2)} in³, ${t.objectCount} object${t.objectCount === 1 ? '' : 's'}` },
    { k: 'Overhangs past 45°', v: `${t.overhangPercent45}%`, sub: `${fmt(t.overhangAreaBelow45Cm2)} cm²`, cls: t.overhangPercent45 > 15 ? 'bad' : t.overhangPercent45 > 4 ? 'warn' : '' },
    { k: 'Bed contact', v: `${fmt(t.bedContactAreaCm2)} cm²`, sub: `${contactPct}% of footprint`, cls: t.bedContactAreaCm2 < 0.2 ? 'bad' : contactPct < 12 && t.sizeMm.z > 30 ? 'warn' : '' },
    { k: 'Height to base', v: `${t.tipRatio.toFixed(1)} : 1`, sub: t.tipRatio > 5 ? 'high tipping risk' : t.tipRatio > 3 ? 'may wobble' : 'stable', cls: t.tipRatio > 5 ? 'bad' : t.tipRatio > 3 ? 'warn' : '' },
    { k: 'Colors', v: `${t.extrudersUsed.length}`, sub: t.paintedTriangles ? `painted on ${t.paintedTriangles.toLocaleString()} faces` : t.multiColor ? 'per-part colors' : 'single toolhead' },
    { k: 'Triangles', v: compact(t.triangles), sub: t.flatTopAreaCm2 ? `${fmt(t.flatTopAreaCm2)} cm² flat tops` : 'no flat tops' },
  ];
  if (orig) cells.push({ k: 'Sliced (original)', v: hm(orig.timeSeconds), sub: `${fmt(orig.grams || 0)} g filament` });
  $('stats').innerHTML = cells.map(c => `<div class="stat ${c.cls || ''}"><div class="v">${esc(c.v)}</div><div class="k">${esc(c.k)}</div><div class="sub">${esc(c.sub || '')}</div></div>`).join('');
  $('stats').classList.remove('hidden');
}

// ---------- Claude ----------
$('analyzeBtn').onclick = async () => {
  if (!state.file || state.busy) return;
  await toolheadsReady();
  if (state.config.aiMode !== 'chat' && !state.config.hasKey) { openSettings(); return; }
  state.busy = true; $('analyzeBtn').disabled = true; showTab('recs');
  const started = Date.now();
  $('resultsEmpty').classList.add('hidden');
  const body = $('resultsBody');
  body.classList.remove('hidden');
  body.innerHTML = `<div class="working"><h2>Reviewing ${esc(state.file.fileName)}</h2><div class="bar"></div><p class="progress-line">Measuring the model…</p><p class="hint" id="elapsed"></p></div>`;
  const timer = setInterval(() => { const el = $('elapsed'); if (el) el.textContent = `${Math.round((Date.now() - started) / 1000)} s`; }, 1000);
  try {
    const renders = viewer.capture();
    const used = state.analysis.totals.extrudersUsed || [];
    const materials = state.slots.map(s => ({ toolhead: `T${s.slot}`, material: s.type, preset: s.preset || null, color: s.color, usedOnThisPlate: used.includes(s.slot) }));
    setBusy('claude', 'Getting recommendations…');
    let res = await api.runClaude({ plateIndex: state.plateIndex, slider: Number($('slider').value), materials, purpose: $('purpose').value.trim(), renders, assembly: $('fitTogether').checked, oppositeInterface: ifaceOn() });
    if (res && res.chat) {
      body.innerHTML = '<div class="working"><p>Waiting for the chatbot’s answer. Follow the steps in the window that just opened.</p></div>';
      res = await askChatbot(res);
      if (!res) { state.result ? renderResults() : (body.classList.add('hidden'), $('resultsEmpty').classList.remove('hidden')); return; }
    }
    // troubleshooter fixes loaded for this model stay: the new advice is added around them
    const carry = state.tsCarry && state.file && state.tsCarry.filePath === state.file.filePath ? state.tsCarry : null;
    if (carry && res && res.rows) {
      for (const r of carry.rows) {
        const i = res.rows.findIndex(x => x.id === r.id);
        const row = { ...r, reason: `From the troubleshooter: ${r.reason || ''}` };
        if (i >= 0) res.rows[i] = row; else res.rows.push(row);
      }
      res.fromTs = carry.job;
    }
    state.result = res;
    state.objects = null;
    state.compare = null;
    saveSession();
    setTimeout(() => guideEvent('analyzed'), 50);
    renderResults(); renderStats();
    $('analyzeBtn').textContent = 'Get new recommendations';
    // The recommended version isn't sliced here: the recommendations only need the slice of the original (made
    // before asking the AI). Slicing it is up to the user in Compare slices; sending a print slices it if needed.
    renderCompare();
  } catch (e) {
    body.innerHTML = `<div class="error"><b>Analysis failed.</b><p>${esc(cleanErr(e))}</p></div>`;
  } finally { clearInterval(timer); clearBusy('claude'); state.busy = false; $('analyzeBtn').disabled = false; }
};

function renderResults() {
  const body = $('resultsBody');
  if (!state.result) { body.classList.add('hidden'); $('resultsEmpty').classList.remove('hidden'); return; }
  // shown whichever way the results came (the AI, the troubleshooter's fixes, an earlier analysis, a restored session)
  body.classList.remove('hidden'); $('resultsEmpty').classList.add('hidden');
  const { plan, rows, recipe, orientationChoices, sliceError, usedHistory } = state.result;
  const order = ['Quality', 'Strength', 'Speed', 'Support', 'Adhesion', 'Multi-color', 'Filament', 'Other'];
  const claudeRows = rows.filter(r => r.source === 'claude');
  const recipeRows = rows.filter(r => r.source === 'recipe' && !claudeRows.find(c => c.id === r.id));
  const groups = {};
  for (const r of claudeRows) (groups[r.group] ||= []).push(r);
  const orientHtml = orientationChoices.map((c, i) => {
    const applied = JSON.stringify(state.rotations[c.itemIndex]) === JSON.stringify(c.option.rotation);
    return `<div class="callout"><b>Reorient ${esc(c.objectName)}: ${esc(c.option.label)}.</b> ${esc(c.reason)}
      <div class="row">${applied ? '<span class="ok-line">Applied</span>' : `<button class="btn primary" data-orient="${i}">Apply this orientation</button>`}</div></div>`;
  }).join('');
  const tsBanner = state.result.fromTs ? `<div class="callout ts-carry"><b>Includes the troubleshooter’s fixes for ${esc(state.result.fromTs)}.</b> They’re ticked below (marked “From the troubleshooter” after new recommendations). <b>Send to printer…</b> prints with all of them; <b>Save as 3MF</b> keeps them in the file.</div>` : '';
  body.innerHTML = `${tsBanner}${state.objects ? objectsHeader() : ''}
    <div class="actions">
      <span class="count" id="selCount"></span>
      <button class="btn" id="copyBtn" title="Copy a to-do list of these changes, to make them by hand in your slicer">Copy checklist</button>
      <button class="btn" id="presetBtn" title="Optional: save just the settings (without the model) as Orca presets you can import and reuse on other models">Save as Orca presets</button>
      <button class="btn primary" id="saveBtn" title="Save this model with the checked settings built in, as a project file you open in your slicer">Save as 3MF</button>
      <button class="btn" id="bambuRecBtn" title="Save a Bambu Studio version of this model with these settings, to share on MakerWorld">For MakerWorld (Bambu)…</button>
      <button class="btn primary" id="sendRecBtn" ${state.info.available ? '' : 'disabled title="Set the Snapmaker Orca location in Settings to send prints"'}>Send to printer…</button>
    </div>
    <p class="hint save-hint"><b>Which should I use?</b> <b>Save as 3MF</b> saves this model with the checked settings built in: open it in your slicer and print. That’s all most people need. <b>Orca presets</b> are optional: just the settings, to reuse on other models. To pick a faster or finer version first, use <button class="link" id="toCompare">Compare slices</button>.</p>
    <p class="summary">${esc(plan.summary)}</p>
    <p class="meta-line">Recipe: <b>${esc(recipe.name)}</b>. ${esc(recipe.about)}</p>
    ${plan.orientation ? `<p class="meta-line">Orientation: <b>${esc(plan.orientation)}</b></p>` : ''}
    ${plan.estimated_effect ? `<p class="meta-line">Expected effect: <b>${esc(plan.estimated_effect)}</b></p>` : ''}
    ${sliceError ? `<p class="meta-line">The original couldn’t be sliced for comparison: ${esc(sliceError)}</p>` : ''}
    ${orientHtml}
    <div id="checksBox"></div>
    ${plan.risks.length ? `<ul class="risks">${plan.risks.map(r => `<li class="${esc(r.severity)}"><b>${esc(r.title)}</b><span>${esc(r.detail)}</span></li>`).join('')}</ul>` : ''}
    ${order.filter(g => groups[g]).map(g => `<h3 class="group-title">${esc(g)}</h3>${groups[g].map(settingRow).join('')}`).join('')}
    ${recipeRows.length ? `<details class="recipe-group"><summary>From the ${esc(recipe.name)} recipe (${recipeRows.length})</summary>${recipeRows.map(settingRow).join('')}</details>` : ''}
    <div class="notes">
      ${plan.manual_steps.length ? `<h3>Do these by hand in Orca</h3><ol>${plan.manual_steps.map(m => `<li>${esc(m)}</li>`).join('')}</ol>` : ''}
      ${plan.material_notes ? `<h3>Materials</h3><p>${esc(plan.material_notes)}</p>` : ''}
      ${plan.multicolor_notes ? `<h3>Multi-color</h3><p>${esc(plan.multicolor_notes)}</p>` : ''}
      ${usedHistory && plan.history_notes ? `<h3>From your past prints</h3><p>${esc(plan.history_notes)}</p>` : ''}
    </div>
    ${caveatHtml()}`;
  body.querySelectorAll('[data-orient]').forEach(b => b.onclick = async () => {
    const c = orientationChoices[Number(b.dataset.orient)];
    await setRotation(c.itemIndex, c.option.rotation);
    renderResults();
  });
  body.querySelectorAll('.setting input').forEach(i => i.addEventListener('input', onRowEdit));
  $('copyBtn').onclick = copyChecklist; $('presetBtn').onclick = exportPresets; $('saveBtn').onclick = () => { save3mf(); guideEvent('saved'); }; $('bambuRecBtn').onclick = () => openBambuExport('recommended');
  $('toCompare').onclick = () => showTab('compare');
  $('sendRecBtn').onclick = () => openSend('recommended');
  if (state.objects) { wireObjectsHeader(); $('presetBtn').disabled = true; $('presetBtn').title = 'Presets hold one set of settings: not available when each object has its own'; }
  updateCount(); refreshChecks();
}

// Under every set of AI advice: what settings can't fix, and that AI can be wrong
function caveatHtml() {
  return `<details class="caveat"><summary><b>Good to know:</b> settings can’t fix everything</summary>
    <p>The app chooses settings. Some things that decide how a print turns out happen outside it:</p>
    <ul>
      <li><b>Damp filament.</b> Most filament soaks up moisture from the air (PETG, TPU and nylon most). Wet filament strings, pops, looks rough and prints weak. Dry it, and store it sealed with desiccant.</li>
      <li><b>The room.</b> Cold rooms, drafts (fans, windows, air vents) and temperature swings cause warping, cracks and prints coming loose. ABS and ASA need an enclosure.</li>
      <li><b>The filament itself.</b> Brands and even colors of the same material print differently. Check the temperatures on the spool’s label.</li>
      <li><b>The printer.</b> A dirty or uneven bed, a worn or partly clogged nozzle, loose belts or skipped calibration cause failures no setting fixes. Clean the bed (dish soap and water, or isopropyl alcohol) and calibrate now and then.</li>
      <li><b>The model.</b> Very thin walls, a tiny footprint on the bed or a broken mesh can fail whatever the settings.</li>
    </ul>
    <p><b>AI can make mistakes</b>, especially with little to go on. Say what the part is for, describe problems in the troubleshooter and add photos. The app’s safety checks catch settings that wouldn’t work, but read each change before printing, and do a small test print when it matters.</p>
    <p>Keep this handy: <button class="link" data-sheet="quick">1-page cheat sheet</button> · <button class="link" data-sheet="booklet">booklet</button> (PDF, printable).</p>
  </details>`;
}
document.addEventListener('click', (e) => { const b = e.target.closest('.caveat [data-sheet]'); if (b) openCheatSheet(b.dataset.sheet); });

function settingRow(s) {
  const checked = s.action === 'change' && !s.unchanged && !s.invalid;
  const cur = s.current == null ? '<span class="cur none">not set</span>' : `<span class="cur">${esc(s.current)}</span>`;
  const list = s.options ? `<datalist id="dl-${esc(s.id)}">${s.options.map(o => `<option value="${esc(o)}">`).join('')}</datalist>` : '';
  return `
    <div class="setting ${s.unchanged ? 'same' : ''}" data-id="${esc(s.id)}">
      <input type="checkbox" ${checked ? 'checked' : ''} aria-label="Apply ${esc(s.label)}">
      <div class="name">${esc(s.label)}${s.slot ? ` <span class="tool">T${s.slot}</span>` : ''}
        ${s.source === 'claude' ? `<span class="pri ${esc(s.priority)}">${esc(s.priority)}</span>` : ''}
        ${s.action === 'check' ? '<span class="check">double-check</span>' : ''}</div>
      <div class="values">${cur}<span class="arrow" aria-hidden="true">›</span>
        <input type="text" value="${esc(s.recommended)}" ${s.options ? `list="dl-${esc(s.id)}"` : ''} class="${s.invalid ? 'bad' : ''}" aria-label="New value for ${esc(s.label)}"> <span class="unit">${esc(s.unit)}</span>${list}</div>
      <div class="err">${esc(s.invalid || '')}</div>
      ${s.reason ? `<div class="reason">${esc(s.reason)}</div>` : ''}
      <div class="where">${esc(s.gui)}</div>
    </div>`;
}

function rowById(id) { return state.result.rows.find(x => x.id === id); }
function selectedChanges() {
  return [...document.querySelectorAll('#resultsBody .setting')].filter(r => r.querySelector('input[type=checkbox]').checked).map(r => {
    const s = rowById(r.dataset.id);
    return { key: s.key, value: r.querySelector('input[type=text]').value.trim(), slot: s.slot, label: s.label, current: s.current, gui: s.gui, reason: s.reason, id: s.id, source: s.source };
  });
}
// light client-side validation mirror: enums and numbers; the main process re-validates on save
function quickValidate(s, v) {
  if (!v) return 'Enter a value';
  if (s.options && !s.options.includes(v)) return 'Pick one of the listed values';
  if (/^\d|^-/.test(s.recommended) && !/^-?\d+(\.\d+)?%?$/.test(v)) return 'Number only';
  return '';
}
function onRowEdit(e) {
  saveSession();
  const row = e.target.closest('.setting');
  const s = rowById(row.dataset.id);
  const txt = row.querySelector('input[type=text]');
  const err = quickValidate(s, txt.value.trim());
  txt.classList.toggle('bad', !!err);
  row.querySelector('.err').textContent = err;
  updateCount(); refreshChecks();
}
function updateCount() {
  const ch = selectedChanges();
  const bad = [...document.querySelectorAll('#resultsBody .setting')].some(r => r.querySelector('input[type=checkbox]').checked && r.querySelector('input.bad'));
  $('selCount').textContent = `${ch.length} change${ch.length === 1 ? '' : 's'} selected${Object.keys(state.rotations).length ? ', reoriented' : ''}${bad ? '. Fix the values marked in red first.' : ''}`;
  $('presetBtn').disabled = !ch.length || bad;
  $('saveBtn').disabled = bad || (!ch.length && !Object.keys(state.rotations).length);
}

const refreshChecks = debounce(async () => {
  if (!state.file) return;
  const changes = state.result ? selectedChanges() : [];
  const r = await api.runChecks({ plateIndex: state.plateIndex, changes, rotations: state.rotations });
  state.checks = r.checks; state.fixes = r.fixes;
  const box = $('checksBox');
  if (!box) return;
  const recSlice = state.compare?.results?.find(x => x.id === 'recommended');
  const sliceWarn = recSlice && recSlice.ok ? recSlice.warnings.map(w => ({ severity: 'warn', title: 'Snapmaker Orca warning', detail: w })) : [];
  const all = [...state.checks, ...sliceWarn];
  document.querySelectorAll('#resultsBody .fixnote').forEach(el => el.remove());
  for (const f of r.fixes) {
    const row = document.querySelector(`#resultsBody .setting[data-id="${f.key}#0"]`);
    if (row) row.querySelector('.err').insertAdjacentHTML('afterend', `<div class="fixnote">Will be saved as <b>${esc(f.value)}</b> so Snapmaker Orca accepts the file.</div>`);
  }
  const fileFixes = (state.prepNotes || []).filter(n => /^Corrected/.test(n));
  const fixesHtml = (r.fixes.length || fileFixes.length) ? `<h3 class="group-title">Fixed automatically so Snapmaker Orca accepts the file</h3><ul class="checks">${fileFixes.map(n => `<li class="info">${esc(n)}</li>`).join('')}${r.fixes.map(f => `<li class="info"><b>${esc(f.key.replace(/_/g, ' '))} → ${esc(f.value)}.</b>${esc(f.reason)}</li>`).join('')}</ul>` : '';
  box.innerHTML = fixesHtml + (all.length
    ? `<h3 class="group-title">Safety checks</h3><ul class="checks">${all.map(c => `<li class="${esc(c.severity)}"><b>${esc(c.title)}.</b>${esc(c.detail)}</li>`).join('')}</ul>`
    : '<p class="ok-line">Safety checks passed: flow, temperatures, cooling and supports look consistent.</p>');
}, 300);

// pictures of the model for the saved file's thumbnail (what Windows Explorer and the slicer's plate list show)
function fileThumbs() { try { return viewer.thumbnails([512, 256, 128]); } catch { return []; } }

// variantId: a version from Compare slices; none = the recommendations with the checked rows
async function save3mf(variantId = null, opts = {}) {
  await toolheadsReady();
  try {
    const def = variantId ? variantDef(variantId) : null;
    // "no AI": just the conversion and the automatic safety fixes, whatever recommendations are on screen
    const rec = !opts.noAI && !def ? recChanges() : null;
    const changes = opts.noAI ? [] : def ? def.changes : rec.changes;
    const objectChanges = opts.noAI ? null : def ? (def.objectChanges || null) : rec.objectChanges;
    if (!(await fitConfirm([...changes, ...Object.values(objectChanges || {}).flat()]))) return;
    const out = await api.save3mf({ changes, objectChanges, rotations: def ? (def.rotations || state.rotations) : state.rotations, slider: Number($('slider').value), purpose: $('purpose').value.trim(), plateIndex: state.plateIndex, variantName: def ? def.name : (opts.name || null), thumbs: fileThumbs() });
    if (out) {
      const n = out.fixes.length + out.corrections.length;
      if (opts.quiet) return out;
      toast(`Saved${def ? ` “${def.name}”` : ''}${n ? ` with ${n} automatic fix${n === 1 ? '' : 'es'}` : ''}. Open the file in your slicer (double-click it, or File → Open Project), check the preview, then print.`, n ? 12000 : 8000, () => api.showInFolder(out.path));
    }
    return out;
  } catch (e) { if (opts.quiet) throw e; toast(cleanErr(e), 8000); }
}
async function exportPresets() {
  await toolheadsReady();
  try {
    const r = await api.exportPresets({ changes: selectedChanges(), plateIndex: state.plateIndex, rotations: state.rotations });
    if (!r) return;
    toast(`Saved ${r.files.length} preset file${r.files.length === 1 ? '' : 's'}. To use them on other models: in Orca choose File → Import → Import Configs, select the files, then pick the new presets in the sidebar.${r.missingParent ? ' Select your printer profile after importing.' : ''} (Not needed for this model if you saved it as a 3MF.)`, 14000, () => api.showInFolder(r.files[0]));
  } catch (e) { toast(cleanErr(e), 8000); }
}
async function copyChecklist() {
  const lines = [`Snapmaker Orca changes for ${state.file.fileName}`, ''];
  for (const [i, rot] of Object.entries(state.rotations)) { const o = state.analysis.objects.find(x => x.itemIndex === +i); if (rot && o) lines.push(`[ ] Reorient ${o.name} (see the app's orientation choice)`); }
  if (state.objects) {
    // every object's own settings (Orca: right-click the object -> Add settings), then the whole-plate ones
    const plan = objectPlan(), byId = new Map();
    for (const r of state.objects.results) if (r.result) byId.set(r.group.objectIds[0], r);
    for (const [id, list] of Object.entries(plan.objectChanges || {})) {
      const r = byId.get(id); if (!r) continue;
      lines.push(`${r.group.name}${r.group.count > 1 ? ` (x${r.group.count})` : ''}: right-click it in Orca -> Add settings`);
      for (const c of list) lines.push(`[ ] ${(r.result.rows.find(x => x.key === c.key) || {}).label || c.key}: ${c.value}`);
      lines.push('');
    }
    if (plan.changes.length) { lines.push('Whole plate (Process / Filament settings):'); plan.changes.forEach(c => lines.push(`[ ] ${(plan.shared.find(x => x.key === c.key) || {}).label || c.key}${c.slot ? ` (T${c.slot})` : ''}: ${c.value}`)); }
  } else for (const c of selectedChanges()) lines.push(`[ ] ${c.label}${c.slot ? ` (T${c.slot})` : ''}: ${c.current ?? 'default'} -> ${c.value}   [${c.gui}]${c.reason ? `\n    ${c.reason}` : ''}`);
  if (state.result.plan.manual_steps.length) { lines.push('', 'By hand:'); state.result.plan.manual_steps.forEach(m => lines.push(`[ ] ${m}`)); }
  await navigator.clipboard.writeText(lines.join('\n'));
  toast('Checklist copied.', 3000);
}

// ---------- compare slices ----------
const VARIANT_NAMES = { original: 'Original', recommended: 'Recommended', finest: 'Finest recipe', fine: 'Fine recipe', fast: 'Fast recipe', fastest: 'Fastest recipe' };
const RECIPE_SLIDER = { finest: 5, fine: 25, fast: 75, fastest: 95 };
function renderVariantPicks() {
  const hasPlan = !!state.result;
  const picks = ['original', 'recommended', 'finest', 'fine', 'fast', 'fastest'];
  const on = state.comparePicks || new Set(['original', 'recommended', 'fast']);
  state.comparePicks = on;
  $('variantPicks').innerHTML = picks.map(p => `<label><input type="checkbox" value="${p}" ${on.has(p) ? 'checked' : ''} ${p === 'recommended' && !hasPlan ? 'disabled' : ''}> ${VARIANT_NAMES[p]}</label>`).join('')
    + `<p class="hint picks-hint">${hasPlan ? 'Finest, Fine, Fast and Fastest use the printer maker’s quality presets for layer height and speed, plus the other recommended settings (supports, cooling and so on).' : 'Finest, Fine, Fast and Fastest are the printer maker’s own quality presets.'} Pick one in the table to save it as a 3MF, send it, or open it in your slicer.</p>`;
  $('variantPicks').querySelectorAll('input').forEach(i => i.onchange = () => { if (i.checked) on.add(i.value); else on.delete(i.value); });
  $('sliceBtn').disabled = !state.file || !state.info.available;
  $('compareHint').textContent = !state.info.available ? 'Set the Snapmaker Orca location in Settings to slice variants.'
    : 'Slices each variant with Snapmaker Orca (with your current orientation and toolheads) and compares real print time, filament, tool changes and flow.';
}
$('sliceBtn').onclick = () => runCompare([...state.comparePicks].filter(p => p !== 'recommended' || state.result));

async function runCompare(ids) {
  await toolheadsReady();
  if (!state.file || !state.info.available) return;
  const variants = [];
  for (const id of ids) {
    if (id === 'original') variants.push({ id, name: VARIANT_NAMES[id], changes: [] });
    else if (id === 'recommended') { if (state.result) variants.push({ id, name: VARIANT_NAMES[id], ...recChanges() }); }
    else {
      // a quality preset plus the AI's other recommendations (supports, cooling…), so picking "Fast" doesn't
      // drop what the model needs; the preset decides layer height and speeds
      const r = await api.recipePreview(RECIPE_SLIDER[id]);
      // keys the recipe decides (even ones it leaves as they are) aren't overridden by the AI's values
      const presetKeys = new Set([...r.changes.map(c => `${c.key}#${c.slot || 0}`), ...(r.governs || []).map(k => `${k}#0`)]);
      const extra = state.result && !state.objects ? selectedChanges().filter(c => c.source !== 'recipe' && !presetKeys.has(`${c.key}#${c.slot || 0}`)).map(c => ({ key: c.key, value: c.value, slot: c.slot })) : [];
      // every object's own settings too (except what the preset decides)
      let objectChanges = null;
      if (state.objects) {
        const rc = recChanges();
        extra.push(...rc.changes.filter(c => !presetKeys.has(`${c.key}#${c.slot || 0}`)));
        objectChanges = Object.fromEntries(Object.entries(rc.objectChanges || {}).map(([oid, l]) => [oid, l.filter(c => !presetKeys.has(`${c.key}#0`))]));
      }
      variants.push({ id, name: state.result ? VARIANT_NAMES[id].replace(' recipe', ' + recommendations') : VARIANT_NAMES[id], changes: [...r.changes, ...extra], objectChanges });
    }
  }
  for (const v of variants) v.rotations = state.rotations;
  state.variantDefs = Object.fromEntries(variants.map(v => [v.id, v]));
  $('compareBody').innerHTML = `<div class="working"><div class="bar"></div><p class="progress-line">Slicing…</p></div>`;
  setBusy('slice', `Slicing ${variants.length} variant${variants.length === 1 ? '' : 's'} in Snapmaker Orca…`, 0);
  try {
    const results = await api.sliceVariants({ plateIndex: state.plateIndex, variants: variants.map(({ id, changes, rotations }) => ({ id, changes, rotations })) });
    const names = Object.fromEntries(variants.map(v => [v.id, v.name]));
    state.compare = { results: results.map(r => ({ ...r, name: names[r.id] || VARIANT_NAMES[r.id] })) };
    state.selectedVariant = state.compare.results.find(r => r.id === 'recommended' && r.ok) ? 'recommended' : state.compare.results.find(r => r.ok)?.id;
  } catch (e) { state.compare = { error: cleanErr(e) }; }
  finally { clearBusy('slice'); }
  renderCompare(); renderStats(); refreshChecks(); saveSession();
  const tabBtn = document.querySelector('[data-tab=compare]');
  if (tabBtn.getAttribute('aria-selected') !== 'true' && state.compare?.results) tabBtn.innerHTML = 'Compare slices<span class="badge">new</span>';
}

const LOOK_WORDS = ['', 'Rough', 'Visible lines', 'Standard', 'Smooth', 'Very smooth'];
const STRENGTH_WORDS = ['', 'Light', 'Light–normal', 'Normal', 'Strong', 'Very strong'];
const meter = (n) => n ? `<span class="meter" aria-label="${n} of 5">${'●'.repeat(n)}<span class="off">${'●'.repeat(5 - n)}</span></span>` : '';
const lookPart = (r, id) => (r.look || []).find(x => x.id === id);

function renderCompare() {
  renderVariantPicks();
  const c = state.compare, body = $('compareBody');
  if (!c) { body.innerHTML = ''; return; }
  if (c.error) { body.innerHTML = `<div class="error">${esc(c.error)}</div>`; return; }
  const base = c.results.find(r => r.id === 'original' && r.ok);
  const delta = (v, b, unit, fmtFn) => {
    if (!base || v == null || b == null || v === b) return '';
    const d = v - b, pct = b ? Math.round(100 * d / b) : 0;
    return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${fmtFn(Math.abs(d))}${unit} (${pct > 0 ? '+' : ''}${pct}%)</span>`;
  };
  // pick something to describe straight away (the first version that isn't the original)
  if (!c.results.some(r => r.ok && r.id === state.selectedVariant)) state.selectedVariant = (c.results.find(r => r.ok && r.id !== 'original') || c.results.find(r => r.ok) || {}).id;
  const tech = state.showTech ?? (level() >= 3);
  body.innerHTML = `
    <div class="ctable-head"><span class="hint">${level() <= 1 ? 'Click a version to see what you’ll get and to save or print it.' : 'Click a version for details.'}</span>
      <button class="link" id="techToggle">${tech ? 'Hide' : 'Show'} technical details</button></div>
    <div class="ctable-wrap"><table class="ctable ${tech ? 'show-tech' : ''}"><thead><tr><th>Version</th><th title="Surface finish: how visible the layer lines are">Look</th><th title="How strong and stiff the part will be">Strength</th><th>Time</th><th>Filament</th><th class="tech">Layers</th><th class="tech" title="Toolhead or filament changes">Swaps</th><th class="tech" title="95th percentile volumetric flow, mm³/s">Flow</th></tr></thead><tbody>
    ${c.results.map(r => {
      if (!r.ok) return `<tr><td>${esc(r.name)}</td><td colspan="7" class="err">${esc(r.error)}</td></tr>`;
      const lk = lookPart(r, 'look'), st = lookPart(r, 'strength');
      return `<tr data-v="${r.id}" class="${r.id === state.selectedVariant ? 'sel' : ''}" tabindex="0">
      <td>${esc(r.name)}${base && r.id !== 'original' && base.timeSeconds && r.timeSeconds > 2 * base.timeSeconds ? `<span class="delta up">${(r.timeSeconds / base.timeSeconds).toFixed(1)}× as long</span>` : ''}${r.warnings.length ? `<span class="delta up">${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}</span>` : ''}${(r.corrections || []).length ? `<span class="delta fixed">${r.corrections.length} fixed automatically</span>` : ''}</td>
      <td title="${esc(lk ? lk.text : '')}">${lk ? `${meter(lk.score)}<span class="mword">${LOOK_WORDS[lk.score]}</span>` : '—'}</td>
      <td title="${esc(st ? st.text : '')}">${st ? `${meter(st.score)}<span class="mword">${STRENGTH_WORDS[st.score]}</span>` : '—'}</td>
      <td>${hm(r.timeSeconds)}${r.id !== 'original' ? delta(r.timeSeconds, base?.timeSeconds, '', hm) : ''}</td>
      <td>${fmt(r.grams || 0)} g${r.id !== 'original' ? delta(r.grams, base?.grams, ' g', fmt) : ''}</td>
      <td class="tech">${r.gcode.layers}</td><td class="tech">${r.gcode.toolChanges}</td><td class="tech">${r.gcode.peakFlowP95}</td></tr>`;
    }).join('')}
  </tbody></table></div><div id="variantDetail"></div>`;
  $('techToggle').onclick = () => { state.showTech = !tech; renderCompare(); };
  body.querySelectorAll('tr[data-v]').forEach(tr => {
    const pick = () => { state.selectedVariant = tr.dataset.v; renderCompare(); guideEvent('compare-picked'); };
    tr.onclick = pick; tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  });
  const sel = c.results.find(r => r.id === state.selectedVariant && r.ok);
  if (!sel) return;
  const feats = sel.gcode.byFeature.filter(f => f.timeShare >= 0.005);
  const cards = (sel.look || []).map(x => `<div class="look-card"><div class="lc-head"><b>${esc(x.title)}</b>${x.score ? meter(x.score) : ''}</div>
      <p>${esc(x.text)}</p>${x.compare ? `<p class="lc-cmp">${esc(x.compare)}</p>` : ''}${x.detail && level() >= 2 ? `<p class="lc-detail">${esc(x.detail)}</p>` : ''}</div>`).join('');
  $('variantDetail').innerHTML = `
    ${base && sel.id !== 'original' && base.timeSeconds && sel.timeSeconds > 2 * base.timeSeconds ? (() => {
      const why = ['look', 'strength'].map(id => { const a = lookPart(base, id), b = lookPart(sel, id); return a && b && a.detail !== b.detail ? `${b.detail} instead of ${a.detail}` : null; }).filter(Boolean);
      return `<div class="error time-warn"><b>This version takes ${(sel.timeSeconds / base.timeSeconds).toFixed(1)}× as long as the original</b> (${esc(hm(sel.timeSeconds))} instead of ${esc(hm(base.timeSeconds))}) and uses ${fmt(sel.grams || 0)} g instead of ${fmt(base.grams || 0)} g.${why.length ? ` Mainly: ${esc(why.join('; '))}.` : ''} Untick the rows that cause it in Recommendations if you don’t need the extra quality or strength.</div>`;
    })() : ''}
    <h3>What you’ll get with “${esc(sel.name)}”</h3>
    <div class="look-cards">${cards || '<p class="hint">Descriptions appear after slicing.</p>'}</div>
    <p class="hint">${esc(hm(sel.timeSeconds))} to print, ${fmt(sel.grams || 0)} g of filament${base && sel.id !== 'original' ? ` (original: ${esc(hm(base.timeSeconds))}, ${fmt(base.grams || 0)} g)` : ''}.</p>
    ${sel.warnings.length ? `<ul class="warn-list">${sel.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <h3>Use “${esc(sel.name)}”</h3>
    <div class="row-btns" id="useButtons"><button class="btn primary" id="save3mfVariant">Save as 3MF</button> <button class="btn" id="sendVariant">Send to printer…</button> <button class="btn" id="orcaVariant">Open in slicer</button> <button class="btn" id="bambuVariant" title="Save a Bambu Studio version of this one, to share on MakerWorld">For MakerWorld (Bambu)…</button></div>
    <p class="hint"><b>Save as 3MF</b> saves the model with this version’s settings built in, ready to open in your slicer and print. <button class="link" id="saveGcode">Save the G-code instead</button> (advanced: the finished print file, only needed to upload to a printer yourself, e.g. with Fluidd or a USB stick).</p>
    <details class="time-details" ${level() >= 3 ? 'open' : ''}><summary>Where the print time goes</summary>
      <div class="feature-bars">${feats.map(f => `<div class="fbar"><span>${esc(f.name)}</span><span class="track"><span class="fill" style="width:${Math.round(f.timeShare * 100)}%"></span></span><span class="n">${Math.round(f.timeShare * 100)}%, ${f.flowP95} mm³/s</span></div>`).join('')}</div>
      <p class="hint">Per-toolhead filament: ${sel.filaments.length ? sel.filaments.map(f => `T${f.id} ${f.type} ${fmt(f.usedGrams || 0)} g`).join(', ') : Object.entries(sel.gcode.volumeByTool).map(([t, v]) => `${t} ${v} cm³`).join(', ')}. Flow (mm³/s) is the 95th percentile per feature, after the slicer’s own speed caps.</p>
      ${(sel.corrections || []).length ? `<h3>Fixed automatically</h3><ul class="fix-list">${sel.corrections.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    </details>`;
  $('save3mfVariant').onclick = () => { save3mf(sel.id); guideEvent('saved'); };
  $('bambuVariant').onclick = () => openBambuExport(sel.id);
  $('sendVariant').onclick = () => { openSend(sel.id); guideEvent('saved'); };
  $('orcaVariant').onclick = () => openInOrca(sel.id);
  $('saveGcode').onclick = async () => {
    try { const p = await api.saveGcode({ variantId: sel.id, name: sel.name }); if (p) toast('G-code saved.', 5000, () => api.showInFolder(p)); }
    catch (e) { toast(cleanErr(e), 6000); }
  };
}

// ---------- history ----------
$('historyRefresh').onclick = () => loadHistory();
if (api.reportOpen) $('historyReport').onclick = () => api.reportOpen(); else $('historyReport').hidden = true;   // not in the guided tour
if (api.statsOpen) $('historyStats').onclick = () => api.statsOpen(); else $('historyStats').hidden = true;
// status filter and name search: they only hide rows, so ratings and notes typed in a row stay put
const histStatus = (s) => (s === 'completed' || s === 'cancelled' ? s : s === 'in_progress' ? 'printing' : 'failed');
function filterHistory() {
  const st = $('historyStatus').value, q = $('historySearch').value.trim().toLowerCase();
  const rows = [...$('historyBody').querySelectorAll('.job')];
  let shown = 0;
  for (const el of rows) { const ok = (!st || el.dataset.st === st) && (!q || el.dataset.name.includes(q)); el.hidden = !ok; if (ok) shown++; }
  $('historyCount').textContent = rows.length ? (shown === rows.length ? `${rows.length} prints` : `${shown} of ${rows.length} prints`) : '';
  let none = $('historyBody').querySelector('.hist-none');
  if (rows.length && !shown) { if (!none) { none = document.createElement('p'); none.className = 'hint hist-none'; $('historyBody').append(none); } none.textContent = 'No prints match. Change the status or the search.'; }
  else if (none) none.remove();
}
$('historyStatus').onchange = filterHistory;
$('historySearch').oninput = filterHistory;
// where a cancelled or failed print stopped: the layer, and the height to cut the model at to print the rest
const STOPPED = new Set(['cancelled', 'error', 'klippy_shutdown', 'klippy_disconnect', 'interrupted', 'server_exit']);
const mmText = (z) => `${(Math.round(z * 100) / 100).toFixed(2)} mm`;
function stopHtml(s) {
  if (!s) return '<span class="muted">⏹ Finding the layer it stopped on…</span>';
  if (s.error) return `<span class="muted">⏹ Couldn’t find the layer it stopped on: ${esc(s.error)}</span> <button type="button" class="link" data-stopretry>Try again</button>`;
  if (s.none) return `<span class="muted">⏹ ${esc(s.none)}</span>`;
  const about = s.exact ? '' : 'about ';
  let h = `⏹ Stopped on ${about}layer <b>${s.layer}</b>${s.total ? ` of ${s.total}` : ''}${s.z != null ? ` (${about}${mmText(s.z)} high)` : ''}`;
  h += s.exact ? ' <span class="muted">as the printer reported it</span>' : ' <span class="muted" title="Worked out from the filament the print used and its G-code. It’s usually within a few layers: check the part before cutting.">worked out from the filament used ⓘ</span>';
  if (s.layer <= 1) h += '<br><span class="muted">That’s the first layer: print the whole model again.</span>';
  else if (s.doneZ != null) h += `<br>To print the rest: in Snapmaker Orca, cut the model at <b>${mmText(s.doneZ)}</b> (the top of layer ${s.layer - 1}, the last whole one) and print the top part. <button type="button" class="btn small" data-copycut="${s.doneZ}" title="Copy ${mmText(s.doneZ)} to paste into Orca’s Cut tool">📋 Copy ${mmText(s.doneZ)}</button>`;
  if (s.note) h += `<br><span class="muted">${esc(s.note)}</span>`;
  return h;
}
let stopGen = 0;
async function findStops(h, gen) {   // one at a time (each reads a G-code from a printer), newest first
  for (const el of $('historyBody').querySelectorAll('.job .stop')) {
    if (gen !== stopGen) return;
    const j = h.jobs[Number(el.closest('.job').dataset.i)];
    if (j.stop) continue;
    try { j.stop = await api.historyStop(j.id); } catch (e) { j.stop = { error: cleanErr(e) }; }
    if (gen !== stopGen) return;
    el.innerHTML = stopHtml(j.stop); wireStop(el, h);
  }
}
function wireStop(el, h) {
  const c = el.querySelector('[data-copycut]');
  if (c) c.onclick = () => { navigator.clipboard.writeText(String(Math.round(Number(c.dataset.copycut) * 100) / 100)).then(() => toast('Copied. In Snapmaker Orca: select the model, press C (Cut), and paste it as the height.', 6000), () => toast('Couldn’t copy.', 3000)); };
  const r = el.querySelector('[data-stopretry]');
  if (r) r.onclick = () => { const j = h.jobs[Number(el.closest('.job').dataset.i)]; j.stop = null; el.innerHTML = stopHtml(null); findStops(h, stopGen); };
}
async function loadHistory() {
  stopGen++;
  $('historyFilter').hidden = true;
  $('historyBody').innerHTML = '<p class="progress-line">Reading print history…</p>';
  try {
    const h = await withBusy('history', 'Reading print history from your printers…', () => api.historyList());
    state.history = h;
    if (!h.configured) { $('historyBody').innerHTML = `<p>Add your printers’ addresses in <button class="link" id="histSettings">Settings</button> to see their print history here.</p>`; $('histSettings').onclick = openSettings; return; }
    const err = h.errors.length ? `<p class="error">${h.errors.map(esc).join('<br>')}</p>` : '';
    if (!h.jobs.length) { $('historyBody').innerHTML = err + '<p class="hint">No prints yet.</p>'; return; }
    $('historyBody').innerHTML = err + h.jobs.map((j, i) => `
      <div class="job" data-i="${i}" data-st="${histStatus(j.status)}" data-name="${esc(String(j.filename || '').toLowerCase())}">
        <span class="f">${esc(j.filename)}</span><span class="st ${esc(j.status)}">${esc(j.status)}</span>
        <span class="m">${esc(j.printer)}, ${j.start ? new Date(j.start).toLocaleString() : ''}, ${hm(j.printSeconds)}${j.filamentType ? `, ${esc(j.filamentType)}` : ''}${j.layerHeight ? `, ${j.layerHeight} mm layers` : ''}${j.run ? ' <span class="adv">· advisor settings</span>' : ''}</span>
        <div class="rate">
          ${['good', 'issues', 'failed'].map(r => `<button class="btn" data-r="${r}" aria-pressed="${j.rating?.rating === r}">${{ good: 'Good', issues: 'Had issues', failed: 'Failed' }[r]}</button>`).join('')}
          <input type="text" placeholder="What happened? (optional)" value="${esc(j.rating?.note || '')}" aria-label="Note for ${esc(j.filename)}">
          ${j.status === 'completed' && api.reportOpen ? `<button class="btn cert-btn" data-certjob="${i}" title="A printable certificate for this print, like a birth certificate, to give with the model">🏅 Certificate…</button>` : ''}
          <button class="btn ts-btn" data-ts="${i}">Troubleshoot…</button>
        </div>
        ${STOPPED.has(j.status) && api.historyStop ? `<div class="stop">${stopHtml(j.stop)}</div>` : ''}
        ${j.diagnoses && j.diagnoses[0] ? `<div class="diag">Diagnosis ${new Date(j.diagnoses[0].at).toLocaleDateString()}: ${esc(j.diagnoses[0].summary)}</div>` : ''}
      </div>`).join('');
    $('historyBody').querySelectorAll('.job').forEach(el => {
      const j = h.jobs[Number(el.dataset.i)];
      const note = el.querySelector('input');
      const save = async (rating) => { await api.historyRate({ jobId: j.id, rating, note: note.value.trim() }); j.rating = rating ? { rating, note: note.value.trim() } : null; el.querySelectorAll('[data-r]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.r === rating))); };
      el.querySelectorAll('[data-r]').forEach(b => b.onclick = () => save(j.rating?.rating === b.dataset.r ? null : b.dataset.r));
      note.onchange = () => { if (j.rating) save(j.rating.rating); else toast('Pick Good, Had issues or Failed to save the note.', 3500); };
      el.querySelector('[data-ts]').onclick = () => openTroubleshooter(j);
      const cb = el.querySelector('[data-certjob]'); if (cb) cb.onclick = () => api.reportOpen(j.id);
    });
    $('historyBody').querySelectorAll('.job .stop').forEach((el) => wireStop(el, h));
    $('historyFilter').hidden = false; filterHistory();
    if (api.historyStop) findStops(h, stopGen);
  } catch (e) { $('historyBody').innerHTML = `<p class="error">${esc(cleanErr(e))}</p>`; }
}

// ---------- open in Snapmaker Orca ----------
async function openInOrca(variantId) {
  if (!state.file) return;
  if (!state.info.available) { toast('Set the Snapmaker Orca location in Settings first.', 5000); openSettings(); return; }
  // the current plan (if any), or a sliced version from Compare
  const def = variantId ? variantDef(variantId) : { id: 'current', name: state.result ? 'Recommended' : 'Current', ...(state.result ? recChanges() : { changes: [], objectChanges: null }), rotations: state.rotations };
  if (!(await fitConfirm([...def.changes, ...Object.values(def.objectChanges || {}).flat()]))) return;
  try {
    const r = await withBusy('orca', 'Writing the project and starting Snapmaker Orca…', () => api.openInOrca({ changes: def.changes, objectChanges: def.objectChanges || null, rotations: def.rotations, plateIndex: state.plateIndex, variantName: def.name, thumbs: fileThumbs() }));
    if (!r) return;
    const name = r.path.split(/[\\/]/).pop();
    const big = state.analysis && state.analysis.totals.triangles > 300000;
    toast(`Saved ${name}${r.fixes ? ` with ${r.fixes} automatic fix${r.fixes === 1 ? '' : 'es'}` : ''} and started ${r.singleInstance ? 'your running' : 'a new'} Snapmaker Orca window.${big ? ` This model has ${(state.analysis.totals.triangles / 1e6).toFixed(1)}M triangles, so Orca may take a minute or two to finish loading it.` : ' Orca can take a little while to start.'} Save there and the advisor will offer to reload your edits.${r.singleInstance ? ' (Orca’s “only one instance” preference is on, so it used the existing window.)' : ''}`, 12000, () => api.showInFolder(r.path));
  } catch (e) { toast(cleanErr(e), 8000); }
}
$('orcaBtn').onclick = () => openInOrca(null);

api.onOrcaFileChanged(({ file, name }) => {
  noticeWithActions(`${name} was saved in Snapmaker Orca.`, [
    { label: 'Reload your Orca edits', primary: true, fn: async () => { await openFile(api.openPath(file)); api.orcaReloaded(file); toast('Reloaded the project from Snapmaker Orca. Its settings are now the starting point here.', 6000); } },
    { label: 'Dismiss', fn: () => {} },
  ]);
});

// a persistent notice (until acted on) with buttons
function noticeWithActions(msg, actions) {
  const t = $('toast');
  clearTimeout(toastTimer);
  t.innerHTML = `${esc(msg)} ${actions.map((a, i) => `<button class="link notice-btn ${a.primary ? 'primary' : ''}" data-a="${i}">${esc(a.label)}</button>`).join(' ')}`;
  t.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { hideToast(); actions[Number(b.dataset.a)].fn(); });
  t.classList.remove('hidden');
}

// ---------- send to printer ----------
const SEND = { job: null, printers: [], printer: null, map: {} };
const prefsKey = 'u1advisor.sendPrefs';
// ---------- "Analyze all objects": one AI request per unique object, each object's settings saved on it ----------
// state.objects = { results: [{ group: {id, name, count, plates, objectIds}, result | error, edits }], cur, picks }
// While it's on, state.result is the shown object's recommendations, so the usual rows, checks and buttons work; the
// other objects' ticks and edits are kept in their `edits`. Saving merges them all (recChanges): settings Orca allows
// per object go on that object (and its copies), the rest (filament, first layer…) are whole-plate settings, shared by
// all objects; when objects disagree on one of those, the user picks the value.
let PER_OBJ = null;
api.perObjectKeys().then(l => { PER_OBJ = new Set(l); }).catch(() => { PER_OBJ = new Set(); });
async function refreshObjectsPlan() {
  const b = $('analyzeAllBtn');
  try { state.objPlan = await api.objectsPlan(); } catch { state.objPlan = null; }
  const p = state.objPlan;
  b.classList.toggle('hidden', !p || p.unique < 2);
  if (p) b.textContent = `Analyze all objects (${p.unique} different${p.objects > p.unique ? ` of ${p.objects}` : ''})`;
}
function setObjectsResult(res) {
  const results = res.results.map(r => ({ ...r, edits: r.edits || null }));
  const cur = Math.max(0, results.findIndex(r => r.result));
  state.objects = { results, cur, picks: (res.picks || {}) };
  state.result = results[cur].result;
  state.compare = null;
  renderResults(); renderStats(); renderCompare();
  $('analyzeBtn').textContent = 'Get new recommendations';
  saveSession();
}
function switchObject(i) {
  const o = state.objects;
  if (!o || i === o.cur || !o.results[i] || !o.results[i].result) return;
  o.results[o.cur].edits = rowEdits();
  o.cur = i;
  state.result = o.results[i].result;
  renderResults();
  applyRowEdits(o.results[i].edits);
  // show that object's plate
  const pl = o.results[i].group.plates[0];
  if (pl && pl !== state.plateIndex && [...$('plateSelect').options].some(op => Number(op.value) === pl)) { $('plateSelect').value = String(pl); state.plateIndex = pl; state.compare = null; loadPlate(); }
  saveSession();
}
// every object's ticked settings: { changes (whole plate), objectChanges: { objectId: [{key, value}] }, shared }
function objectPlan() {
  const o = state.objects, perObj = PER_OBJ || new Set();
  const objectChanges = {}, shared = new Map();
  o.results.forEach((r, i) => {
    if (!r.result) return;
    const edits = i === o.cur ? rowEdits() : r.edits;
    for (const row of r.result.rows) {
      const e = edits && edits[row.id];
      const on = e ? e.checked : (row.action === 'change' && !row.unchanged && !row.invalid);
      if (!on || row.invalid) continue;
      const value = e ? e.value : row.recommended;
      if (perObj.has(row.key) && !row.slot) {
        for (const id of r.group.objectIds) (objectChanges[id] ||= []).push({ key: row.key, value });
      } else {
        const s = shared.get(row.id) || { id: row.id, key: row.key, slot: row.slot || 0, label: row.label, wants: [] };
        s.wants.push({ value: String(value), from: r.group.name, priority: row.priority });
        shared.set(row.id, s);
      }
    }
  });
  const rank = { high: 0, medium: 1, low: 2 };
  const list = [...shared.values()].map(s => {
    const values = [...new Set(s.wants.map(w => w.value))];
    const count = (v) => s.wants.filter(w => w.value === v).length;
    const best = values.sort((a, b) => count(b) - count(a) || Math.min(...s.wants.filter(w => w.value === a).map(w => rank[w.priority] ?? 3)) - Math.min(...s.wants.filter(w => w.value === b).map(w => rank[w.priority] ?? 3)))[0];
    const chosen = o.picks[s.id] && values.includes(o.picks[s.id]) ? o.picks[s.id] : best;
    return { ...s, values, chosen, conflict: values.length > 1 };
  });
  return { changes: list.map(s => ({ key: s.key, value: s.chosen, slot: s.slot })), objectChanges: Object.keys(objectChanges).length ? objectChanges : null, shared: list };
}
// what Save / Compare / Send / Open in Orca use for "the recommendations"
function recChanges() {
  if (state.objects) { const p = objectPlan(); return { changes: p.changes, objectChanges: p.objectChanges }; }
  return { changes: selectedChanges().map(c => ({ key: c.key, value: c.value, slot: c.slot })), objectChanges: null };
}
function objectsHeader() {
  const o = state.objects, p = objectPlan();
  const pills = o.results.map((r, i) => `<button class="obj${r.error ? ' err' : ''}" data-obj="${i}" aria-pressed="${i === o.cur}" ${r.error ? `title="${esc(r.error)}" disabled` : ''}>${esc(r.group.name)}${r.group.count > 1 ? ` <small>×${r.group.count}</small>` : ''}${r.group.plates.length && (state.file.plates || []).length > 1 ? ` <small>plate ${r.group.plates.join(', ')}</small>` : ''}${r.error ? ' <small>(failed)</small>' : ''}</button>`).join('');
  const sharedHtml = p.shared.length ? `<div class="shared"><b>Whole-plate settings</b> (filament, first layer…: one value for every object on a plate):<ul>${p.shared.map(s => `<li>${esc(s.label)}${s.slot ? ` T${s.slot}` : ''}: ${s.conflict
    ? `<span class="conflict">objects disagree</span> <select data-pick="${esc(s.id)}" aria-label="${esc(s.label)}">${s.values.map(v => `<option value="${esc(v)}" ${v === s.chosen ? 'selected' : ''}>${esc(v)} (${esc(s.wants.filter(w => w.value === v).map(w => w.from).join(', '))})</option>`).join('')}</select>`
    : `<b>${esc(s.chosen)}</b>`}</li>`).join('')}</ul></div>` : '';
  return `<div class="objs"><h3>Settings per object</h3><p class="hint">Each object below was analyzed on its own; its settings are saved on it (and its copies) in one file. Pick an object to see and edit its settings.</p>
    <div class="obj-list">${pills}</div>${sharedHtml}</div>`;
}
function wireObjectsHeader() {
  document.querySelectorAll('#resultsBody [data-obj]').forEach(b => b.onclick = () => switchObject(Number(b.dataset.obj)));
  document.querySelectorAll('#resultsBody [data-pick]').forEach(s => s.onchange = () => { state.objects.picks[s.dataset.pick] = s.value; state.compare = null; saveSession(); });
}

$('analyzeAllBtn').onclick = () => {
  if (!state.file || state.busy || !state.objPlan) return;
  if (state.config.aiMode === 'chat') { toast('Analyzing every object needs the Claude API (one request per object). Switch the AI mode in Settings, or use Get recommended settings.', 7000); return; }
  if (!state.config.hasKey) { openSettings(); return; }
  const p = state.objPlan;
  showTab('recs');
  $('resultsEmpty').classList.add('hidden');
  const body = $('resultsBody');
  body.classList.remove('hidden');
  const cost = p.usdEach != null ? `about $${(p.usdEach * p.unique).toFixed(2)} (about $${p.usdEach.toFixed(2)} each, from your past requests)` : 'the cost of one recommendation for each';
  body.innerHTML = `<div class="objs-plan"><h2>Analyze all objects</h2>
    <p>${p.objects} object${p.objects === 1 ? '' : 's'}${p.plates > 1 ? ` on ${p.plates} plates` : ''}, <b>${p.unique} different</b> (copies and near-identical objects are analyzed once and get the same settings).</p>
    <p>That’s <b>${p.unique} AI requests</b>, ${cost}, and about ${p.minutes} minute${p.minutes === 1 ? '' : 's'}. Each object’s settings are saved on that object, in one file.</p>
    <ul>${p.groups.map(g => `<li>${esc(g.name)}${g.count > 1 ? ` ×${g.count}` : ''}</li>`).join('')}</ul>
    <div class="row"><button class="btn primary" id="objsGo">Analyze ${p.unique} objects</button><button class="btn" id="objsCancel">Cancel</button></div></div>`;
  $('objsCancel').onclick = () => { state.result ? renderResults() : (body.classList.add('hidden'), $('resultsEmpty').classList.remove('hidden')); };
  $('objsGo').onclick = runAllObjects;
};
async function runAllObjects() {
  if (state.busy) return;
  state.busy = true; $('analyzeBtn').disabled = true; $('analyzeAllBtn').disabled = true;
  const started = Date.now(), body = $('resultsBody');
  body.innerHTML = `<div class="working"><h2>Analyzing every object in ${esc(state.file.fileName)}</h2><div class="bar"></div><p class="progress-line">Measuring the objects…</p><p class="hint" id="elapsed"></p></div>`;
  const timer = setInterval(() => { const el = $('elapsed'); if (el) el.textContent = `${Math.round((Date.now() - started) / 1000)} s`; }, 1000);
  try {
    const used = state.analysis.totals.extrudersUsed || [];
    const materials = state.slots.map(s => ({ toolhead: `T${s.slot}`, material: s.type, preset: s.preset || null, color: s.color, usedOnThisPlate: used.includes(s.slot) }));
    setBusy('claude', 'Analyzing every object…');
    const res = await api.runClaudeObjects({ plateIndex: state.plateIndex, slider: Number($('slider').value), materials, purpose: $('purpose').value.trim(), assembly: $('fitTogether').checked, oppositeInterface: ifaceOn() });
    setObjectsResult(res);
    const failed = res.results.filter(r => r.error);
    if (failed.length) toast(`${failed.length} object${failed.length === 1 ? '' : 's'} couldn’t be analyzed (${failed.map(r => r.group.name).join(', ')}); they keep the file’s settings.`, 9000);
    setTimeout(() => guideEvent('analyzed'), 50);
  } catch (e) {
    body.innerHTML = `<div class="error"><b>Analysis failed.</b><p>${esc(cleanErr(e))}</p></div>`;
  } finally { clearInterval(timer); clearBusy('claude'); state.busy = false; $('analyzeBtn').disabled = false; $('analyzeAllBtn').disabled = false; }
}

function variantDef(id) {
  if (id === 'recommended') return { id, name: 'Recommended', ...recChanges(), rotations: state.rotations };
  if (id === 'original') return { id, name: 'Original', changes: [], rotations: state.rotations };
  return (state.variantDefs && state.variantDefs[id]) || { id, name: id, changes: [], rotations: state.rotations };
}
function sdStatus(text, pct = null, kind = '') {
  const box = document.querySelector('.sd-progress');
  box.classList.remove('error', 'done'); if (kind) box.classList.add(kind);
  $('sdStatus').textContent = text || '';
  $('sdFill').style.width = pct == null ? '0%' : `${pct}%`;
}
api.onSendProgress(p => sdStatus(p.label, p.pct));

// The Send dialog's "Settings in this print": every intended change, read back from the sliced print (✓ / ⚠), and the
// main settings it will print with, so nothing is printed on trust
function renderSendVerify(v) {
  const box = $('sdVerify');
  if (!v || v.error) { box.innerHTML = `<p class="error">Couldn’t read the settings back from the sliced print${v && v.error ? `: ${esc(v.error)}` : ''}.</p>`; return; }
  const bad = v.checks.filter(c => !c.ok);
  const head = !v.checks.length ? '<p class="vsum">No settings changed: it prints with the model’s own settings.</p>'
    : bad.length ? `<p class="vsum bad">⚠ ${bad.length} of ${v.checks.length} changed setting${v.checks.length === 1 ? '' : 's'} ${bad.length === 1 ? 'is' : 'are'} not in the sliced print. Check before printing.</p>`
      : `<p class="vsum ok">✓ All ${v.checks.length} changed setting${v.checks.length === 1 ? ' is' : 's are'} in the sliced print (read back from the file that will be sent).</p>`;
  const rows = v.checks.map(c => `<tr class="${c.ok ? 'ok' : 'bad'}"><td class="st">${c.ok ? '✓' : '⚠'}</td><td><b>${esc(c.label)}</b>${c.slot ? ` T${c.slot}` : ''}<br><small>${esc(c.where)}</small></td>
    <td>${esc(c.wanted)}${c.ok ? '' : ` <small>(print has: ${esc(c.actual)})</small>`}${c.note ? `<br><small>${esc(c.note)}</small>` : ''}</td></tr>`).join('');
  const perObj = v.checks.some(c => / \(per object\)$/.test(c.where));
  const summary = v.summary.length ? `<details ${v.checks.length ? '' : 'open'}><summary>Main settings of this print</summary><table>${v.summary.map(s => `<tr><td>${esc(s.label)}</td><td>${esc(s.value)}</td></tr>`).join('')}</table>
    ${perObj ? '<small>These are the print’s general values; objects with their own settings (above) use those instead.</small>' : ''}</details>` : '';
  // does all of it stay on the bed? (a brim or skirt next to the edge can push the first layer off it)
  const b = v.bed;
  SEND.blocked = !!(b && !b.ok) || !!v.blocked;
  const probs = (v.problems || []).filter(p => !(p.title === 'Goes outside the bed' && b && !b.ok));
  const probHtml = probs.length ? `<ul class="problems">${probs.map(p => `<li class="${p.severity}"><b>${p.severity === 'block' ? '⛔' : '⚠'} ${esc(p.title)}.</b> ${esc(p.detail)}${p.severity === 'block' ? ' <b>Printing is blocked.</b>' : ''}</li>`).join('')}</ul>`
    : (v.problems ? '<p class="vsum ok">✓ No problems found in the print file (bed size, height, layers, extrusion, temperatures, slicer errors).</p>' : '');
  const fmt = (n) => (Math.round(n * 10) / 10).toString();
  const bedHtml = !b ? '<p class="hint">Couldn’t check the print against the bed size.</p>'
    : !b.ok ? `<p class="vsum bad bed">⛔ This print would move outside the bed: the ${esc((b.worst && b.worst.type || 'print').toLowerCase())} reaches ${b.worst ? `${b.worst.axis} ${fmt(b.worst.value)} mm` : 'past the edge'}, and the bed is X ${fmt(b.rect.x0)}–${fmt(b.rect.x1)}, Y ${fmt(b.rect.y0)}–${fmt(b.rect.y1)} mm. The printer would stop with “movement exceeded travel limit”. <b>Printing is blocked.</b> Move the model away from the edge in Orca, or untick the brim/skirt changes.</p>`
      : `<p class="vsum ok bed">✓ Fits on the bed: the print uses X ${fmt(b.extent.x0)}–${fmt(b.extent.x1)}, Y ${fmt(b.extent.y0)}–${fmt(b.extent.y1)} mm of the ${fmt(b.rect.x1 - b.rect.x0)} × ${fmt(b.rect.y1 - b.rect.y0)} mm bed (every move checked).${v.moved ? ` It was moved ${[v.moved.dy ? `${fmt(Math.abs(v.moved.dy))} mm ${v.moved.dy > 0 ? 'toward the back' : 'toward the front'}` : '', v.moved.dx ? `${fmt(Math.abs(v.moved.dx))} mm ${v.moved.dx > 0 ? 'to the right' : 'to the left'}` : ''].filter(Boolean).join(' and ')} first: its ${esc((v.moved.was && v.moved.was.type || 'edge').toLowerCase())} went ${fmt(v.moved.over)} mm past the bed edge.` : ''}</p>`;
  box.innerHTML = bedHtml + probHtml + head + (rows ? `<table>${rows}</table>` : '') + summary;
  if (SEND.blocked) $('sdStart').disabled = true;
}
// the sliced print drawn in 3D, with each feature shown or hidden and a layer slider
let SEND_PV = null;
async function showSendPreview(job) {
  const view = $('sdPreview'), feats = $('sdPvFeats'), slider = $('sdPvLayer');
  feats.innerHTML = ''; $('sdPvLayerLbl').textContent = '—';
  let data;
  try { data = await api.sendPreview(job.variantId); } catch (e) { view.querySelector('.sd-pv-wait')?.remove(); view.insertAdjacentHTML('beforeend', `<p class="hint sd-pv-wait">Couldn’t draw the preview: ${esc(cleanErr(e))}</p>`); return; }
  if (!data || SEND.job !== job) return;
  view.querySelector('.sd-pv-wait')?.remove();
  if (!SEND_PV) SEND_PV = new GcodePreview(view);
  SEND_PV.load(data, job.verify && job.verify.bed);
  const total = data.features.reduce((n, f) => n + f.count, 0) || 1;
  feats.innerHTML = data.features.map((f, i) => `<label><input type="checkbox" data-pvf="${i}" checked><span class="sw" style="background:${esc(f.color)}"></span>${esc(f.name)}<small>${Math.max(0.1, Math.round(f.count / total * 1000) / 10)}%</small></label>`).join('');
  feats.querySelectorAll('[data-pvf]').forEach(c => c.onchange = () => SEND_PV.setVisible(data.features[Number(c.dataset.pvf)].name, c.checked));
  const n = data.layers.length;
  slider.max = String(Math.max(0, n - 1)); slider.value = String(Math.max(0, n - 1));
  const label = () => { const L = Number(slider.value); $('sdPvLayerLbl').textContent = n ? `${L + 1} of ${n} (Z ${data.layers[L] ?? '?'} mm)` : '—'; };
  slider.oninput = () => { SEND_PV.setMaxLayer(Number(slider.value)); label(); };
  label();
  $('sdPvNote').textContent = `Drag to turn, scroll to zoom. This is the exact file that will be sent${data.thinned ? ' (drawn with fewer points to stay smooth)' : ''}.`;
}
async function openSend(variantId) {
  await toolheadsReady();
  if (!state.file) return;
  { const d = variantDef(variantId); if (!(await fitConfirm([...d.changes, ...Object.values(d.objectChanges || {}).flat()]))) return; }
  if (!state.config.printers || !state.config.printers.length) { toast('Add your printers’ addresses in Settings first.', 5000); openSettings(); return; }
  const dlg = $('sendDialog');
  SEND.job = null; SEND.map = {}; SEND.blocked = false;
  $('sdFilaments').innerHTML = ''; $('sdPrinters').innerHTML = '<p class="hint">Checking your printers…</p>'; $('sdFilNote').textContent = '';
  $('sdCautions').innerHTML = ''; $('sdCautions').classList.add('hidden');
  $('sdVerify').innerHTML = '<p class="hint">Slicing, then reading the settings back from the sliced print…</p>';
  if (SEND_PV) SEND_PV.clear();
  if (!$('sdPreview').querySelector('.sd-pv-wait')) $('sdPreview').insertAdjacentHTML('beforeend', '<p class="hint sd-pv-wait">Drawing the sliced print…</p>');
  $('sdPvFeats').innerHTML = '';
  $('sdStart').disabled = true;
  const thumbs = viewer.thumbnails([48, 300, 512]);
  SEND.thumbs = thumbs.filter(t => t.w !== 512);
  $('sdThumb').src = thumbs.find(t => t.w === 512).dataUrl;
  const p = JSON.parse(localStorage.getItem(prefsKey) || '{}');
  $('sdFlow').checked = !!p.flowCalibrate; $('sdTimelapse').checked = !!p.timelapse; $('sdLevel').checked = !!p.bedLevel;
  sdStatus('Preparing the job…');
  dlg.showModal();
  const def = variantDef(variantId);
  const [job, printers] = await Promise.all([
    withBusy('send', `Slicing ${def.name} for the printer…`, () => api.sendPrepare({ plateIndex: state.plateIndex, variant: def })).catch(e => ({ error: cleanErr(e) })),
    api.printersStatus().catch(() => []),
  ]);
  if (job.error) { sdStatus(job.error, null, 'error'); $('sdVerify').innerHTML = ''; return; }
  SEND.job = job; SEND.printers = printers;
  renderSendVerify(job.verify);
  {
    const slots = job.filaments.map(f => { const s = state.slots.find(x => x.slot === f.index + 1) || {}; return { ...s, slot: f.index + 1, type: f.type || s.type, preset: f.preset || s.preset }; });
    const list = filamentCautions(slots);
    $('sdCautions').innerHTML = list.length ? `${cautionsHtml(list)}${list.some(c => c.kind === 'abrasive') ? '<small class="hint">Check the nozzle on the toolhead you map it to before you press Print.</small>' : ''}` : '';
    $('sdCautions').classList.toggle('hidden', !list.length);
  }
  showSendPreview(job);
  $('sdName').value = job.remoteName;
  $('sdTime').textContent = hm(job.timeSeconds);
  $('sdGrams').textContent = `${fmt(job.grams || 0)} g`;
  $('sdVariant').textContent = def.name + (job.corrections.length ? ` (${job.corrections.length} fixed automatically)` : '');
  const last = localStorage.getItem('u1advisor.lastPrinter');
  const usable = printers.filter(x => x.online && !/printing|paused/.test(x.state));
  SEND.printer = (usable.find(x => x.name === last) || usable[0] || printers[0] || null);
  renderSendPrinters(); renderSendFilaments();
  sdStatus(job.warnings.length ? `Slicer warning: ${job.warnings[0]}` : '');
}

function printerLine(x) {
  if (!x.online) return { cls: 'off', text: `Offline: ${x.error}` };
  if (/printing|paused/.test(x.state)) return { cls: 'busy', text: `${x.state === 'paused' ? 'Paused' : 'Printing'}${x.filename ? ` ${x.filename}` : ''}${x.progress != null ? ` (${Math.round(x.progress * 100)}%)` : ''}` };
  const loaded = x.heads.filter(h => h.loaded).map(h => `T${h.index + 1} ${h.type}`).join(', ');
  return { cls: 'ready', text: `Ready${loaded ? `. Loaded: ${loaded}` : ''}` };
}
function renderSendPrinters() {
  $('sdPrinters').innerHTML = SEND.printers.map(x => {
    const l = printerLine(x); const dis = !x.online || /printing|paused/.test(x.state);
    return `<div class="sd-printer ${dis ? 'disabled' : ''}" role="radio" tabindex="0" aria-checked="${SEND.printer && SEND.printer.index === x.index}" data-i="${x.index}">
      <span class="dot dot-${l.cls}"></span><span class="n">${esc(x.name)}</span><span class="hint">${esc(x.url.replace(/^https?:\/\//, ''))}</span><span class="s">${esc(l.text)}</span></div>`;
  }).join('') || '<p class="hint">No printers set up.</p>';
  $('sdPrinters').querySelectorAll('.sd-printer').forEach(el => {
    const pick = () => { const x = SEND.printers[Number(el.dataset.i)]; if (!x.online || /printing|paused/.test(x.state)) return; SEND.printer = x; SEND.map = {}; renderSendPrinters(); renderSendFilaments(); };
    el.onclick = pick; el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  });
}
const baseType = t => String(t || '').toUpperCase().replace(/[\s_-]+/g, '').replace(/^(PLA|PETG|PCTG|TPU|ABS|ASA|PVA|PA|PC).*/, '$1');
function colorDist(a, b) { const p = c => [1, 3, 5].map(i => parseInt(String(c || '#888888').replace('#', '').padEnd(6, '8').slice(i - 1, i + 1), 16)); const x = p(a), y = p(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); }
function defaultMap(fils, heads) {
  const map = {}, used = new Set();
  for (const f of fils) {
    const cands = heads.filter(h => h.loaded && !used.has(h.index) && baseType(h.type) === baseType(f.type)).sort((a, b) => colorDist(a.color, f.color) - colorDist(b.color, f.color));
    const pick = cands[0] || heads.find(h => h.index === f.index && !used.has(h.index)) || heads.find(h => !used.has(h.index)) || { index: f.index % 4 };
    map[f.index] = pick.index; used.add(pick.index);
  }
  return map;
}
function renderSendFilaments() {
  const job = SEND.job; if (!job) return;
  const heads = (SEND.printer && SEND.printer.heads && SEND.printer.heads.length) ? SEND.printer.heads : [0, 1, 2, 3].map(i => ({ index: i, type: null, loaded: false }));
  if (!Object.keys(SEND.map).length) SEND.map = defaultMap(job.filaments, heads);
  const textOn = c => { const v = parseInt(String(c || '#888888').replace('#', '').slice(0, 6), 16); const lum = 0.299 * (v >> 16 & 255) + 0.587 * (v >> 8 & 255) + 0.114 * (v & 255); return lum > 150 ? '#18232E' : '#FFFFFF'; };
  $('sdFilaments').innerHTML = job.filaments.map(f => {
    const h = heads.find(x => x.index === SEND.map[f.index]);
    let warn = '';
    if (h && !h.loaded) warn = `Nothing is loaded in T${h.index + 1}.`;
    else if (h && h.type && baseType(h.type) !== baseType(f.type)) warn = `T${h.index + 1} has ${h.type} loaded; this part is ${f.type}.`;
    const dup = job.filaments.filter(o => SEND.map[o.index] === SEND.map[f.index]).length > 1;
    if (dup) warn = (warn ? warn + ' ' : '') + 'Two filaments share this toolhead.';
    return `<div class="sd-fil" data-f="${f.index}">
      <div class="top" style="background:${esc(f.color)};color:${textOn(f.color)}">${esc(f.type)}<br>${fmt(f.grams)} g</div>
      <div class="bottom"><select aria-label="Toolhead for filament ${f.index + 1}">${heads.map(x => `<option value="${x.index}" ${x.index === SEND.map[f.index] ? 'selected' : ''}>T${x.index + 1}${x.loaded && x.type ? ` · ${esc(x.type)}` : x.loaded ? '' : ' · empty'}</option>`).join('')}</select>
      ${warn ? `<span class="warn">${esc(warn)}</span>` : ''}</div></div>`;
  }).join('');
  $('sdFilaments').querySelectorAll('.sd-fil select').forEach(sel => sel.onchange = () => { SEND.map[Number(sel.closest('.sd-fil').dataset.f)] = Number(sel.value); renderSendFilaments(); });
  $('sdFilNote').textContent = SEND.printer && SEND.printer.online ? `Toolheads show what ${SEND.printer.name} reports as loaded.` : 'Printer offline: toolheads can’t show what’s loaded.';
  const bad = job.filaments.some(f => job.filaments.filter(o => SEND.map[o.index] === SEND.map[f.index]).length > 1);
  $('sdStart').disabled = !SEND.printer || !SEND.printer.online || /printing|paused/.test(SEND.printer.state) || bad || SEND.blocked;
}
['sdFlow', 'sdTimelapse', 'sdLevel'].forEach(id => $(id).addEventListener('change', () => localStorage.setItem(prefsKey, JSON.stringify({ flowCalibrate: $('sdFlow').checked, timelapse: $('sdTimelapse').checked, bedLevel: $('sdLevel').checked }))));
$('sdClose').onclick = () => $('sendDialog').close();
$('sdStart').onclick = async () => {
  const job = SEND.job, pr = SEND.printer;
  if (!job || !pr) return;
  if (SEND.blocked) { sdStatus('Printing is blocked: this print has a problem (see above).', null, 'error'); return; }
  $('sdStart').disabled = true;
  sdStatus(`Uploading to ${pr.name}…`, 0);
  try {
    const mapTable = job.filaments.map(f => [f.index, SEND.map[f.index]]).sort((a, b) => a[0] - b[0]);
    const r = await api.sendPrint({ variantId: job.variantId, printerIndex: pr.index, remoteName: $('sdName').value || job.remoteName, mapTable,
      prefs: { flowCalibrate: $('sdFlow').checked, timelapse: $('sdTimelapse').checked, bedLevel: $('sdLevel').checked }, thumbs: SEND.thumbs });
    localStorage.setItem('u1advisor.lastPrinter', pr.name);
    sdStatus(`Printing on ${r.printer}.`, 100, 'done');
    toast(`Sent ${r.remote} to ${r.printer}. It’s printing now.`, 7000);
    state.history = null;
    setTimeout(() => $('sendDialog').close(), 1800);
  } catch (e) {
    sdStatus(cleanErr(e), null, 'error');
    $('sdStart').disabled = !!SEND.blocked;
  }
};

// ---------- print issue troubleshooter ----------
const TS = { job: null, modelPath: null, model: null, viewer: null, region: null, mapSel: new Set(), photos: [], issues: new Set(), gcode: null, result: null };

async function openTroubleshooter(job) {
  Object.assign(TS, { job, modelPath: null, model: null, region: null, mapSel: new Set(), photos: [], issues: new Set(), gcode: null, result: null });
  $('tsPhoneQr').classList.add('hidden');
  tsPhoneOpen();   // photos already taken on a phone (recent ones go straight in)
  $('tsDesc').value = job.rating && job.rating.note ? job.rating.note : '';
  $('tsZmin').value = ''; $('tsZmax').value = '';
  $('tsResult').innerHTML = ''; renderTsPhotos();
  TS.diags = (job.diagnoses || []).filter(d => d.full);
  TS.diagAt = null;
  $('tsRun').textContent = TS.diags.length ? 'Run a new diagnosis with Claude' : 'Troubleshoot with Claude';
  $('tsJob').innerHTML = `<h3>${esc(job.filename)}</h3><dl class="ts-job"><dt>Printer</dt><dd>${esc(job.printer)}</dd><dt>When</dt><dd>${job.start ? new Date(job.start).toLocaleString() : '—'}</dd><dt>Result</dt><dd>${esc(job.status)} after ${hm(job.printSeconds)}${job.rating ? `, rated “${esc({ good: 'Good', issues: 'Had issues', failed: 'Failed' }[job.rating.rating])}”` : ''}</dd><dt>Material</dt><dd>${esc(job.filamentType || '—')}</dd></dl>`;
  $('tsEmpty').innerHTML = '<p>Loading the print…</p>'; $('tsEmpty').classList.remove('hidden');
  $('tsTools').classList.add('hidden'); $('tsMap').classList.add('hidden'); $('tsViewer').classList.remove('hidden');
  $('tsLeftHint').textContent = '';
  $('tsDialog').showModal();
  try {
    const info = await api.tsOpen({ jobId: job.id });
    $('tsIssues').innerHTML = info.issues.map(x => `<button class="chip" aria-pressed="false" data-issue="${esc(x)}">${esc(x)}</button>`).join('');
    $('tsIssues').querySelectorAll('.chip').forEach(c => c.onclick = () => { const on = c.getAttribute('aria-pressed') !== 'true'; c.setAttribute('aria-pressed', String(on)); on ? TS.issues.add(c.dataset.issue) : TS.issues.delete(c.dataset.issue); });
    if (job.rating && job.rating.rating === 'failed' && job.status === 'cancelled') { /* no preselection: let the user say what happened */ }
    // the model picked for this print last time (saving a fixed file asked for it) is used again
    let modelPath = info.modelPath;
    if (!modelPath) { try { modelPath = localStorage.getItem(`aipa.tsModel.${job.id}`) || null; } catch {} }
    try { await tsLoad(modelPath); }
    catch (e) { if (modelPath && modelPath !== info.modelPath) { try { localStorage.removeItem(`aipa.tsModel.${job.id}`); } catch {} await tsLoad(info.modelPath); } else throw e; }
    if (TS.diags.length) showTsDiagnosis(TS.diags[0]);
  } catch (e) { $('tsEmpty').innerHTML = `<p class="error">${esc(cleanErr(e))}</p>`; }
}
// a saved diagnosis: shown as it was (with the ticks and values you chose), no new AI request
function showTsDiagnosis(d) {
  TS.result = d.full; TS.diagAt = d.at;
  if (d.issueTypes) {
    TS.issues = new Set(d.issueTypes);
    $('tsIssues').querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(TS.issues.has(c.dataset.issue))));
  }
  if (d.description && !$('tsDesc').value.trim()) $('tsDesc').value = d.description;
  renderTsResult();
}
const tsEditsKey = () => `aipa.tsEdits.${TS.job && TS.job.id}.${TS.diagAt || ''}`;

async function tsLoad(modelPath, plateIndex = null) {
  TS.modelPath = modelPath || null;
  if (plateIndex == null) { try { plateIndex = Number(localStorage.getItem(`aipa.tsPlate.${TS.job.id}`)) || null; } catch {} }
  const res = await withBusy('ts', modelPath ? 'Loading the printed G-code and the model…' : 'Loading the printed G-code…', () => api.tsLoad({ jobId: TS.job.id, modelPath, plateIndex }));
  TS.gcode = res.gcode; TS.model = res.model;
  TS.plate = res.model ? res.model.plate : null;
  const gNames = new Set((res.gcode.objects || []).map(o => o.name.replace(/_id_\d+_copy_\d+$/, '')));
  const tsMulti = (res.model && (res.model.names.length > 1 || res.model.assemblyGuess)) || gNames.size > 1;
  $('tsFitRow').classList.remove('hidden');
  $('tsFitTogether').checked = !!((res.model && res.model.assemblyGuess) || gNames.size > 1);
  const maxZ = (res.gcode.ok && res.gcode.header && res.gcode.header.maxZ) || (res.model && res.model.totals.sizeMm.z) || 270;
  $('tsZmin').max = $('tsZmax').max = maxZ;
  $('tsLeftHint').textContent = res.gcode.ok
    ? `Using the G-code that was printed (${res.gcode.header.slicer || 'Snapmaker Orca'}, ${res.gcode.header.layers || '?'} layers${res.printed && res.printed.layer ? `, ${res.printed.layer} mm` : ''}). ${res.model ? 'Rotate with the left button; in Paint mode, right-drag rotates.' : ''}`
    : `Couldn’t read the G-code from the printer (${res.gcode.error}).${res.model ? ' Claude will use the model’s saved settings instead.' : ''}`;
  if (res.model && res.model.plates && res.model.plates.length > 1) {
    // the plate that was printed (found from the printed objects); pick another if it's wrong
    const how = { chosen: 'your choice', 'file name': 'from the print’s file name', objects: 'its objects match the print', first: 'couldn’t tell: check it' }[res.model.plateHow] || '';
    $('tsLeftHint').insertAdjacentHTML('beforeend', ` <label class="ts-plate">Plate: <select id="tsPlatePick">${res.model.plates.map(p => `<option value="${p.index}" ${p.index === res.model.plate ? 'selected' : ''}>${p.index}${p.name ? `: ${esc(p.name)}` : ''} (${p.objects} object${p.objects === 1 ? '' : 's'}${p.match ? `, ${p.match} printed` : ''})</option>`).join('')}</select> <small>${esc(how)}</small></label>`);
    $('tsPlatePick').onchange = (e) => { try { localStorage.setItem(`aipa.tsPlate.${TS.job.id}`, e.target.value); } catch {} tsLoad(TS.modelPath, Number(e.target.value)); };
  }
  if (res.model) {
    $('tsEmpty').classList.add('hidden'); $('tsMap').classList.add('hidden'); $('tsViewer').classList.remove('hidden'); $('tsTools').classList.remove('hidden');
    if (!TS.viewer) {
      TS.viewer = new ModelViewer($('tsViewer'));
      TS.viewer.onPaint = () => setTsRegion();
    }
    TS.viewer.setFilamentColors(Object.fromEntries(res.filamentColors.map((c, i) => [i + 1, String(c).slice(0, 7)])));
    TS.viewer.load(res.model.preview);
    TS.viewer.setSupports(res.supports, res.model.offset);
    const hasSup = !!(res.supports && res.supports.count);
    $('tsSupportsRow').classList.toggle('hidden', !hasSup); $('tsPaintSupports').classList.toggle('hidden', !hasSup);
    $('tsShowSupports').checked = false; TS.viewer.setSupportsVisible(false);
    TS.viewer.setTool('paint'); setToolButtons('paint');
    $('tsRegionText').textContent = hasSup ? 'Paint the area where it failed (magenta). If the supports failed, tick “Show printed supports” and use “Paint supports”.' : 'Paint the area where it failed (magenta). Use Erase to fix mistakes.';
  } else {
    $('tsTools').classList.add('hidden');
    const objs = res.gcode.ok ? res.gcode.objects.filter(o => o.polygon.length > 2) : [];
    if (objs.length) {
      $('tsViewer').classList.add('hidden'); $('tsMap').classList.remove('hidden');
      renderTsMap(objs);
      $('tsRegionText').textContent = 'Click the part that failed on the plate map and set the height below.';
      $('tsLeftHint').insertAdjacentHTML('beforeend', ' <button class="link" id="tsOpenModel">Open the model (.3mf)</button> to paint the exact spot instead.');
    } else {
      $('tsViewer').classList.remove('hidden'); $('tsMap').classList.add('hidden');
      $('tsEmpty').classList.remove('hidden');
      $('tsRegionText').textContent = 'Set the height where it failed below.';
    }
    $('tsEmpty').innerHTML = `<div><p>${res.gcode.ok ? 'This print wasn’t made or sent with the advisor, so its model isn’t on file.' : 'No model on file for this print.'}</p><button class="btn primary" id="tsOpenModel2">Open the model (.3mf) to paint the failure</button></div>`;
    for (const id of ['tsOpenModel', 'tsOpenModel2']) { const b = $(id); if (b) b.onclick = async () => { const pth = await api.tsPickModel(); if (pth) tsLoad(pth); }; }
  }
}

function setToolButtons(tool) { document.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.tool === tool))); }
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => {
  setToolButtons(b.dataset.tool); if (!TS.viewer) return;
  TS.viewer.setTool(b.dataset.tool);
  if (b.dataset.tool === 'paint-supports' && !$('tsShowSupports').checked) { $('tsShowSupports').checked = true; TS.viewer.setSupportsVisible(true); }
});
$('tsShowSupports').onchange = () => TS.viewer && TS.viewer.setSupportsVisible($('tsShowSupports').checked);
$('tsBrush').oninput = () => { $('tsBrushV').textContent = `${$('tsBrush').value} mm`; if (TS.viewer) TS.viewer.brush = Number($('tsBrush').value); };
$('tsClear').onclick = () => TS.viewer && TS.viewer.clearPaint();
$('tsClose').onclick = () => $('tsDialog').close();

function setTsRegion() {
  const off = TS.model ? TS.model.offset : [0, 0, 0];
  const m = TS.viewer ? TS.viewer.region(off) : null, sup = TS.viewer ? TS.viewer.supportRegion(off) : null;
  let r = m;
  if (sup && !m) {
    r = { source: 'painted on the printed supports', onSupports: true, supports: sup, zMin: sup.zMin, zMax: sup.zMax, xRange: sup.xRange, yRange: sup.yRange, centerXY: sup.centerXY, facing: 'support structure', nearBed: sup.zMin < 1 };
  } else if (sup && m) {
    r = { ...m, source: 'painted on the model and its printed supports', onSupports: true, supports: sup, zMin: Math.min(m.zMin, sup.zMin), zMax: Math.max(m.zMax, sup.zMax) };
  }
  TS.region = r;
  if (r && r.onSupports && !m) {
    $('tsZmin').value = Math.max(0, r.zMin).toFixed(1); $('tsZmax').value = r.zMax.toFixed(1);
    $('tsRegionText').textContent = `Painted ${sup.segments} lines of the printed supports, ${r.zMin.toFixed(1)}–${r.zMax.toFixed(1)} mm up${sup.interfaceShare > 30 ? ', mostly the support interface (the layer right under the part)' : ''}${r.nearBed ? ', at the bed' : ''}.`;
    return;
  }
  if (!r) { $('tsRegionText').textContent = 'Paint the area where it failed (magenta). Use Erase to fix mistakes.'; return; }
  $('tsZmin').value = Math.max(0, r.zMin).toFixed(1); $('tsZmax').value = r.zMax.toFixed(1);
  $('tsRegionText').textContent = `Painted ${m.areaCm2} cm² on the ${m.facing}, ${r.zMin.toFixed(1)}–${r.zMax.toFixed(1)} mm up (${m.heightOfPartPercent[0]}–${m.heightOfPartPercent[1]}% of the part’s height)${m.overhangSharePercent ? `, ${m.overhangSharePercent}% of it overhang` : ''}${m.nearBed ? ', touching the bed' : ''}${sup ? `, plus ${sup.segments} lines of the supports` : ''}.`;
}

// "Bracket_id_0_copy_1" -> "Bracket", numbered when several objects share a name
function mapLabels(objs) {
  const base = objs.map(o => o.name.replace(/_id_\d+_copy_\d+$/, '').replace(/_/g, ' '));
  const count = {}; base.forEach(b => { count[b] = (count[b] || 0) + 1; });
  const seen = {};
  return base.map(b => count[b] > 1 ? `${b} #${(seen[b] = (seen[b] || 0) + 1)}` : b);
}
function renderTsMap(objs) {
  const labels = mapLabels(objs);
  const pts = objs.flatMap(o => o.polygon);
  const minX = Math.min(0, ...pts.map(p => p[0])), maxX = Math.max(270, ...pts.map(p => p[0])), minY = Math.min(0, ...pts.map(p => p[1])), maxY = Math.max(270, ...pts.map(p => p[1]));
  const pad = 6;
  $('tsMap').innerHTML = `<svg viewBox="${minX - pad} ${-(maxY + pad)} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}" role="group" aria-label="Plate map">
    <rect class="bed" x="0" y="-270" width="270" height="270" rx="3"></rect>
    ${objs.map((o, i) => `<g><polygon class="obj ${TS.mapSel.has(o.name) ? 'sel' : ''}" data-i="${i}" tabindex="0" points="${o.polygon.map(p => `${p[0]},${-p[1]}`).join(' ')}"><title>${esc(labels[i])}</title></polygon>
      ${o.center ? `<text x="${o.center[0]}" y="${-o.center[1]}" text-anchor="middle">${esc(labels[i].slice(0, 20))}</text>` : ''}</g>`).join('')}
  </svg>`;
  $('tsMap').querySelectorAll('.obj').forEach(pg => {
    const toggle = () => { const o = objs[Number(pg.dataset.i)]; TS.mapSel.has(o.name) ? TS.mapSel.delete(o.name) : TS.mapSel.add(o.name); renderTsMap(objs);
      $('tsRegionText').textContent = TS.mapSel.size ? `Picked: ${objs.map((x, k) => TS.mapSel.has(x.name) ? labels[k] : null).filter(Boolean).join(', ')}. Set the height below.` : 'Click the part that failed on the plate map and set the height below.'; };
    pg.onclick = toggle; pg.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  });
}
$('tsFirstLayers').onclick = () => { $('tsZmin').value = '0'; $('tsZmax').value = '1.0'; };

const TS_MAX_PHOTOS = 4;
// a photo for Claude: at most 1280 px on the long side, JPEG
async function tsPhotoEntry(url, label, phoneId) {
  const img = await new Promise((r, bad) => { const im = new Image(); im.onload = () => r(im); im.onerror = () => bad(new Error('Couldn’t open the picture.')); im.src = url; });
  const sc = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { label, dataUrl: c.toDataURL('image/jpeg', 0.85), ...(phoneId ? { phoneId } : {}) };
}
$('tsPhotoInput').onchange = async (e) => {
  for (const f of [...e.target.files].slice(0, TS_MAX_PHOTOS - TS.photos.length)) {
    const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
    TS.photos.push(await tsPhotoEntry(url, `User photo of the failed print (${f.name})`));
  }
  e.target.value = ''; renderTsPhotos();
};
function renderTsPhotos() {
  $('tsPhotos').innerHTML = TS.photos.map((p, i) => `<div class="ph${p.phoneId ? ' phone' : ''}"><img src="${p.dataUrl}" alt="Photo ${i + 1}"${p.phoneId ? ' title="Taken with your phone"' : ''}><button class="x" data-i="${i}" aria-label="Remove photo">×</button></div>`).join('');
  $('tsPhotos').querySelectorAll('.x').forEach(b => b.onclick = () => {
    const [p] = TS.photos.splice(Number(b.dataset.i), 1);
    if (p && p.phoneId && api.tsPhotosState) api.tsPhotosState([p.phoneId], 'waiting');   // back with the phone's other photos
    renderTsPhotos();
  });
  renderTsPhoneWait();
}

// ---------- photos taken with a phone (Phone access): they arrive by themselves ----------
// The PC keeps them (src/phone/photos.js) until a troubleshooter uses them. While the troubleshooter is open, new ones go
// straight in; when it opens, the ones taken in the last 2 hours do too; older ones wait below the photos, one click away.
TS.phoneList = []; TS.phoneAdding = new Set(); TS.phoneThumbs = new Map();
async function tsAddPhonePhotos(items) {
  const added = [];
  for (const p of items) {
    if (TS.photos.length >= TS_MAX_PHOTOS) { toast(`The troubleshooter takes ${TS_MAX_PHOTOS} photos: remove one to add another.`, 4000); break; }
    if (TS.phoneAdding.has(p.id) || TS.photos.some(x => x.phoneId === p.id)) continue;
    TS.phoneAdding.add(p.id);
    try {
      const url = await api.tsPhotoData(p.id);
      if (url && $('tsDialog').open && TS.photos.length < TS_MAX_PHOTOS) { TS.photos.push(await tsPhotoEntry(url, `User photo of the failed print (taken with ${p.device})`, p.id)); added.push(p.id); }
    } catch {} finally { TS.phoneAdding.delete(p.id); }
  }
  if (added.length) { renderTsPhotos(); await api.tsPhotosState(added, 'added'); }
}
async function tsPhoneOpen() {
  if (!api.tsPhotosList) return;
  try {
    await api.tsPhotosRelease();
    TS.phoneList = await api.tsPhotosList();
    renderTsPhoneWait();
    const recent = TS.phoneList.filter(p => p.state === 'waiting' && p.purpose !== 'cert' && Date.now() - p.at < 2 * 3600 * 1000).reverse();   // oldest first
    if (recent.length) await tsAddPhonePhotos(recent);
  } catch {}
}
if (api.onTsPhotos) api.onTsPhotos(async (list) => {
  const known = new Set(TS.phoneList.map(p => p.id)), ids = new Set(list.map(p => p.id));
  TS.phoneList = list;
  if (!$('tsDialog').open) return;
  // deleted on the phone: out of the troubleshooter too
  const before = TS.photos.length;
  TS.photos = TS.photos.filter(p => !p.phoneId || ids.has(p.phoneId));
  if (TS.photos.length !== before) renderTsPhotos(); else renderTsPhoneWait();
  const fresh = list.filter(p => p.state === 'waiting' && p.purpose !== 'cert' && !known.has(p.id)).reverse();
  if (fresh.length) {
    await tsAddPhonePhotos(fresh);
    if (!$('tsPhoneQr').classList.contains('hidden')) $('tsPhoneQr').querySelector('.live').textContent = `✓ ${fresh.length === 1 ? 'A photo' : `${fresh.length} photos`} arrived. Take more, or close this.`;
  }
});
// the phone's other photos, not in this troubleshooter: click one to add it
function renderTsPhoneWait() {
  const box = $('tsPhoneWait');
  const wait = TS.phoneList.filter(p => p.state === 'waiting' && p.purpose !== 'cert' && !TS.photos.some(x => x.phoneId === p.id)).slice(0, 8);
  box.classList.toggle('hidden', !wait.length);
  if (!wait.length) { box.innerHTML = ''; return; }
  box.innerHTML = `Taken with your phone earlier (click one to add it):<div class="row">${wait.map(p => `<span class="wp" role="button" tabindex="0" data-id="${p.id}" title="${esc(new Date(p.at).toLocaleString())} · ${esc(p.device)}"><img alt="Photo from your phone" data-thumb="${p.id}"><button class="x" data-del="${p.id}" aria-label="Delete this photo">×</button></span>`).join('')}</div>`;
  for (const img of box.querySelectorAll('img[data-thumb]')) {
    const id = img.dataset.thumb;
    const have = TS.phoneThumbs.get(id);
    if (have) { img.src = have; continue; }
    api.tsPhotoData(id).then(u => { if (u) { TS.phoneThumbs.set(id, u); img.src = u; } }).catch(() => {});
  }
  box.querySelectorAll('.wp').forEach(el => {
    const add = (e) => { if (e.target.closest('[data-del]')) return; const p = TS.phoneList.find(x => x.id === el.dataset.id); if (p) tsAddPhonePhotos([p]); };
    el.onclick = add; el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(e); } };
  });
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = (e) => { e.stopPropagation(); TS.phoneThumbs.delete(b.dataset.del); api.tsPhotosRemove(b.dataset.del); });
}
$('tsPhoneBtn').onclick = async () => {
  const box = $('tsPhoneQr');
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  let r;
  try { r = await api.tsPhoneLink(); } catch (e) { toast(cleanErr(e), 5000); return; }
  if (r.tour) { toast('The tour can’t take photos with a phone.', 4000); return; }
  if (r.off) {
    box.innerHTML = `<div><p><b>Phone access is off.</b> Turn it on to take the photos with your phone: they come straight here over your home Wi-Fi (nothing goes through the internet).${r.error ? ` <span class="error">${esc(r.error)}</span>` : ''}</p>
      <button class="btn" id="tsPhoneSettings">Open Settings → Phone access</button></div>`;
    box.classList.remove('hidden');
    $('tsPhoneSettings').onclick = () => { openSettings(); if (typeof selectSettingsTab === 'function') selectSettingsTab('phone'); };
    return;
  }
  const q = window.qrcode(0, 'M'); q.addData(r.url); q.make();
  box.innerHTML = `<img alt="QR code: opens the photo page on your phone" src="${q.createDataURL(5, 2)}">
    <div><p><b>Scan this with your phone’s camera.</b></p>
    <ol><li>It opens a page with a big <b>📷 Take a photo</b> button, or choose photos you already took.</li><li>Take the photos: each one appears here a moment later.</li>
    ${r.paired ? '' : '<li>The first time, the phone asks to pair with this PC (tap <b>Pair this phone</b>).</li>'}</ol>
    <p class="hint">The phone must be on the same Wi-Fi as this PC. Paired phones can also open it any time with the 📷 button on their Filament page. This code works for 15 minutes.</p>
    <p class="live"></p></div>`;
  box.classList.remove('hidden');
};
// closing the troubleshooter: photos it didn't send wait for the next one
$('tsDialog').addEventListener('close', () => { $('tsPhoneQr').classList.add('hidden'); if (api.tsPhotosRelease) api.tsPhotosRelease().catch(() => {}); });

$('tsRun').onclick = async () => {
  if (!TS.job) return;
  if (state.config.aiMode !== 'chat' && !state.config.hasKey) { openSettings(); return; }
  if (!TS.issues.size && !$('tsDesc').value.trim()) { toast('Pick at least one issue type or describe what happened.', 4000); return; }
  const zMin = $('tsZmin').value === '' ? null : Number($('tsZmin').value), zMax = $('tsZmax').value === '' ? null : Number($('tsZmax').value);
  let region = TS.region ? { ...TS.region } : (TS.mapSel.size ? { source: 'picked on the plate map', objects: [...TS.mapSel] } : null);
  if (zMin != null || zMax != null) {
    region = region || { source: 'height range only' };
    region.zMin = zMin ?? 0; region.zMax = zMax ?? region.zMin + 2;
    if (region.zMax < region.zMin) [region.zMin, region.zMax] = [region.zMax, region.zMin];
  }
  const renders = TS.model && TS.viewer ? TS.viewer.capturePainted(TS.region ? TS.region.faceDirection : null) : [];
  $('tsRun').disabled = true;
  $('tsResult').innerHTML = '<div class="working"><div class="bar"></div><p class="progress-line">Claude is diagnosing the print…</p></div>';
  try {
    let out = await withBusy('tsrun', 'Diagnosing the print…', () => api.tsRun({ issueTypes: [...TS.issues], description: $('tsDesc').value.trim(), region, photos: TS.photos, renders, assembly: !$('tsFitRow').classList.contains('hidden') && $('tsFitTogether').checked }));
    if (out && out.chat) {
      $('tsResult').innerHTML = '<p class="hint">Waiting for the chatbot’s answer…</p>';
      out = await askChatbot(out);
      if (!out) { $('tsResult').innerHTML = ''; return; }
    }
    const fresh = { at: new Date().toISOString(), full: out, issueTypes: [...TS.issues], description: $('tsDesc').value.trim(), summary: out.result && out.result.summary };
    TS.job.diagnoses = [fresh, ...(TS.job.diagnoses || [])];
    TS.diags = [fresh, ...(TS.diags || [])];
    TS.result = out; TS.diagAt = fresh.at; renderTsResult(); guideEvent('troubleshot');
    $('tsRun').textContent = 'Run a new diagnosis with Claude';
    const fromPhone = TS.photos.filter(p => p.phoneId).map(p => p.phoneId);
    if (fromPhone.length && api.tsPhotosState) api.tsPhotosState(fromPhone, 'sent').catch(() => {});
    $('tsResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
    state.history = null; // refresh to show the saved diagnosis
  } catch (e) { $('tsResult').innerHTML = `<div class="error"><b>Couldn’t troubleshoot.</b><p>${esc(cleanErr(e))}</p></div>`; }
  finally { $('tsRun').disabled = false; }
};

function renderTsResult() {
  const { result: r, rows, regionGcode } = TS.result;
  const fixes = rows.filter(x => !x.invalid);
  const diags = TS.diags || [];
  const savedNote = TS.diagAt ? `<div class="ts-saved"><b>Saved diagnosis</b> from ${esc(new Date(TS.diagAt).toLocaleString())}: no new AI request.
      ${diags.length > 1 ? `<label>Other diagnoses of this print: <select id="tsDiagPick">${diags.map((d, i) => `<option value="${i}" ${d.at === TS.diagAt ? 'selected' : ''}>${esc(new Date(d.at).toLocaleString())}${d.full.rows.some(x => x.key === 'layer_height') ? ' · layer height' : ''}</option>`).join('')}</select></label>` : ''}
      <small>Want a fresh one? Click <b>Run a new diagnosis with Claude</b> above.</small></div>` : '';
  $('tsResult').innerHTML = `${savedNote}
    <h3 class="group-title">Diagnosis</h3>
    <p class="summary">${esc(r.summary)}</p>
    ${r.causes.map(c => `<div class="cause ${esc(c.likelihood)}"><span class="k">${esc(c.likelihood)} likelihood · ${esc(c.kind)}</span><b>${esc(c.cause)}</b><span class="e">${esc(c.evidence)}</span></div>`).join('')}
    ${regionGcode ? `<p class="hint">At ${regionGcode.zFrom ?? '?'}–${regionGcode.zTo ?? '?'} mm the printer ran ${regionGcode.features.slice(0, 3).map(f => `${f.name.toLowerCase()} at ${f.speedMedian} mm/s`).join(', ')}; fan ${regionGcode.fanPercent || '—'}; ${regionGcode.toolheads.join(', ') || '—'}.</p>` : ''}
    ${fixes.length ? `<h3 class="group-title">Settings for the next print</h3>${fixes.map(x => `
      <div class="setting" data-id="${esc(x.id)}"><input type="checkbox" ${x.action === 'change' && !x.unchanged ? 'checked' : ''} aria-label="Use ${esc(x.label)}">
        <div class="name">${esc(x.label)}${x.slot ? ` <span class="tool">T${x.slot}</span>` : ''} <span class="pri ${esc(x.priority)}">${esc(x.priority)}</span>${x.action === 'check' ? ' <span class="check">double-check</span>' : ''}</div>
        <div class="values">${x.current == null ? '<span class="cur none">not set</span>' : `<span class="cur">${esc(x.current)}</span>`}<span class="arrow">›</span><input type="text" value="${esc(x.recommended)}" aria-label="New value for ${esc(x.label)}"> <span class="unit">${esc(x.unit)}</span></div>
        <div class="reason">${esc(x.reason)}</div><div class="where">${esc(x.gui)}</div></div>`).join('')}` : ''}
    ${r.physical_checks.length ? `<h3 class="group-title">Check at the printer</h3><ol class="fix-list">${r.physical_checks.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
    ${r.orientation ? `<h3 class="group-title">Orientation</h3><p>${esc(r.orientation)}</p>` : ''}
    ${r.questions.length ? `<h3 class="group-title">To narrow it down</h3><ul class="fix-list">${r.questions.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p class="hint">Add the answers to the description and troubleshoot again.</p>` : ''}
    ${caveatHtml()}
    <div class="ts-actions">
      <button class="btn primary" id="tsPrintFixed" title="Print the model on one of your printers with the ticked fixes (sliced here, with every fix included)">🖨 Print fixed version…</button>
      <button class="btn primary" id="tsSaveFixed" title="Save a copy of the model (.3mf) with the ticked fixes built in, to open in Snapmaker Orca and print">💾 Save fixed 3MF…</button>
      ${TS.modelPath ? '<button class="btn" id="tsUse">Use these settings</button>' : '<button class="btn" id="tsUseOpen">Open the model and use these settings</button>'}
      <button class="btn" id="tsCopy">Copy checklist</button>
    </div>
    <p class="hint" id="tsSaveNote">${TS.modelPath ? 'Saves a copy of <b>' + esc(TS.modelPath.split(/[\\/]/).pop()) + '</b> with the ticked fixes built in; the original stays as it was.' : 'Asks for the model’s project file (.3mf, the one you sliced in Orca), then saves a copy with the ticked fixes built in; the original stays as it was.'}</p>`;
  $('tsCopy').onclick = async () => {
    const lines = [`Troubleshooting ${TS.job.filename}`, '', r.summary, ''];
    for (const x of tsSelected()) lines.push(`[ ] ${x.label}${x.slot ? ` (T${x.slot})` : ''}: ${x.current ?? 'default'} -> ${x.recommended}   [${x.gui}]`);
    if (r.physical_checks.length) { lines.push('', 'At the printer:'); r.physical_checks.forEach(c => lines.push(`[ ] ${c}`)); }
    await navigator.clipboard.writeText(lines.join('\n')); toast('Checklist copied.', 3000);
  };
  // the model in the main window, with the ticked fixes as its recommendations (keepOpen: the troubleshooter stays)
  const load = async (pathToModel, keepOpen) => {
    const picked = tsSelected().map(x => ({ key: x.key, recommended: x.recommended, slot: x.slot || 0, action: 'change', priority: x.priority, reason: x.reason }));
    const fit = !$('tsFitRow').classList.contains('hidden') && $('tsFitTogether').checked;
    if (!keepOpen) $('tsDialog').close();
    await openFile(api.openPath(pathToModel));
    if (!state.file || state.file.filePath !== pathToModel) throw new Error('The model didn’t open.');
    // the plate that was printed ("…_plate_2.gcode")
    const plate = TS.plate || Number((/_plate_(\d+)/i.exec(TS.job.filename) || [])[1]);
    if (plate && plate !== state.plateIndex && [...$('plateSelect').options].some(o => Number(o.value) === plate)) {
      $('plateSelect').value = String(plate); state.plateIndex = plate; state.compare = null; await loadPlate();
    }
    if (fit && !$('fitTogether').checked) $('fitTogether').checked = true;
    const newRows = await api.rowsFor(picked);
    state.result = { plan: { summary: `From the troubleshooter (${TS.job.filename}): ${r.summary}`, risks: r.causes.slice(0, 3).map(c => ({ severity: c.likelihood === 'high' ? 'warn' : 'info', title: c.cause, detail: c.evidence })),
        manual_steps: r.physical_checks, orientation: r.orientation, estimated_effect: '', material_notes: '', multicolor_notes: '', history_notes: '' },
      rows: newRows, recipe: { name: 'None', about: 'Settings from the troubleshooter, on top of the project as saved.' }, orientationChoices: [], originalSlice: null, usedHistory: false };
    state.result.fromTs = TS.job.filename;
    state.tsCarry = { filePath: pathToModel, job: TS.job.filename, rows: newRows };
    renderResults(); showTab('recs');
    return picked.length;
  };
  const use = async (pathToModel) => {
    try { await load(pathToModel, false); toast('Troubleshooter fixes loaded. Send to printer…, Save as 3MF or Compare slices; Get new recommendations adds to them.', 8000); }
    catch (e) { toast(cleanErr(e), 8000); }
  };
  // your ticks and edited values stay with this diagnosis
  const saved = (() => { try { return JSON.parse(localStorage.getItem(tsEditsKey()) || 'null'); } catch { return null; } })();
  document.querySelectorAll('#tsResult .setting').forEach(el => {
    const e = saved && saved[el.dataset.id];
    if (e) { el.querySelector('input[type=checkbox]').checked = e.checked; el.querySelector('input[type=text]').value = e.value; }
    el.addEventListener('input', () => {
      const all = {};
      document.querySelectorAll('#tsResult .setting').forEach(x => { all[x.dataset.id] = { checked: x.querySelector('input[type=checkbox]').checked, value: x.querySelector('input[type=text]').value }; });
      try { localStorage.setItem(tsEditsKey(), JSON.stringify(all)); } catch {}
    });
  });
  const dp = $('tsDiagPick'); if (dp) dp.onchange = () => showTsDiagnosis(TS.diags[Number(dp.value)]);
  const rememberModel = (pth) => { TS.modelPath = pth; try { localStorage.setItem(`aipa.tsModel.${TS.job.id}`, pth); } catch {} };
  // 🖨 Print fixed version: the model in the main window with these fixes, then straight to the printer dialog
  $('tsPrintFixed').onclick = async () => {
    if (!tsSelected().length) { toast('Tick at least one fix under “Settings for the next print”.', 5000); return; }
    let pth = TS.modelPath;
    if (!pth) { pth = await api.tsPickModel(); if (!pth) return; rememberModel(pth); }
    try { await load(pth, false); await openSend('recommended'); }
    catch (e) { toast(cleanErr(e), 8000); }
  };
  const u = $('tsUse'); if (u) u.onclick = () => use(TS.modelPath);
  const uo = $('tsUseOpen'); if (uo) uo.onclick = async () => { const pth = await api.tsPickModel(); if (pth) use(pth); };
  // 💾 Save fixed 3MF: open the model (or ask for it once), apply the ticked fixes, save a copy, all from here
  $('tsSaveFixed').onclick = async () => {
    const btn = $('tsSaveFixed'), note = $('tsSaveNote');
    if (!tsSelected().length) { toast('Tick at least one fix under “Settings for the next print”.', 5000); return; }
    let pth = TS.modelPath;
    if (!pth) {
      pth = await api.tsPickModel();
      if (!pth) return;
      rememberModel(pth);   // remembered for this print (Use these settings, printing, saving again, next time)
    }
    btn.disabled = true;
    note.textContent = 'Opening the model and applying the fixes…';
    try {
      await load(pth, true);
      if (!selectedChanges().length) throw new Error('None of the ticked fixes change this project: it already has those values.');
      // the file name says what it fixes: "Rocket (advisor - Fixed stringing - 2026-11-23 7.42 PM).3mf" (the issues
      // picked now, or those of the earlier diagnosis on screen)
      const diag = (TS.job.diagnoses || []).find(d => d.full === TS.result);
      const issues = TS.issues.size ? [...TS.issues] : ((diag && diag.issueTypes) || []);
      const what = issues.slice(0, 2).map(i => i.split(/\s*(?:\/| or )\s*/)[0].toLowerCase()).join(' and ');
      note.textContent = 'Choose where to save it…';
      const out = await save3mf(null, { quiet: true, name: what ? `Fixed ${what}` : 'Fixed' });
      const plate = TS.plate || Number((/_plate_(\d+)/i.exec(TS.job.filename) || [])[1]) || null;
      if (!out) { note.textContent = 'Not saved.'; return; }
      const auto = [...out.fixes.map(f => `${f.key.replace(/_/g, ' ')} → ${f.value}: ${f.reason}`), ...out.corrections];
      const file = out.path.split(/[\\/]/).pop();
      note.innerHTML = `<span class="ok-line">✓ Saved <b>${esc(file)}</b>.</span> Double-click it to open it in Snapmaker Orca, check the preview, then print. <button class="link" id="tsShowSaved">Show in folder</button>
        ${out.perObject ? `<br>The fixes are on the objects of the plate that was printed${plate ? ` (plate ${plate})` : ''}; the other plates keep their settings.${out.wholeFile.length ? ` These apply to the whole file (Orca can’t set them per object): ${out.wholeFile.map(w => `${esc(w.label)}${w.slot ? ` T${w.slot}` : ''} ${esc(w.value)}`).join(', ')}.` : ''}` : ''}
        ${auto.length ? `<details><summary>Also adjusted so the file works in Orca (${auto.length})</summary><ul>${auto.map(a => `<li>${esc(a)}</li>`).join('')}</ul></details>` : ''}`;
      $('tsShowSaved').onclick = () => api.showInFolder(out.path);
      guideEvent('saved');
    } catch (e) {
      note.innerHTML = `<span class="error">Couldn’t save the fixed file: ${esc(cleanErr(e))}</span>`;
    } finally { btn.disabled = false; }
  };
}
function tsSelected() {
  return [...document.querySelectorAll('#tsResult .setting')].filter(el => el.querySelector('input[type=checkbox]').checked).map(el => {
    const x = TS.result.rows.find(rw => rw.id === el.dataset.id);
    return { ...x, recommended: el.querySelector('input[type=text]').value.trim() };
  });
}

// ---------- free chatbot mode ----------
// Resolves with the finished result, or null if the user closes the window.
function askChatbot(req) {
  return new Promise((resolve) => {
    const dlg = $('chatDialog');
    $('chatTitle').textContent = req.kind === 'ts' ? 'Ask a free chatbot to diagnose the print' : 'Ask a free chatbot for settings';
    setBusy(req.kind === 'ts' ? 'tsrun' : 'claude', 'Waiting for the chatbot’s answer. Follow the steps in the window.');
    $('chatSize').textContent = `${Math.round(req.chars / 100) / 10}k characters`;
    $('chatImgHint').textContent = req.imageCount ? `${req.imageCount} picture${req.imageCount === 1 ? '' : 's'} saved. Drag them into the chat (or use its attach button) along with the prompt.` : 'No pictures for this request.';
    $('chatImages').classList.toggle('hidden', !req.imageCount);
    $('chatReply').value = ''; $('chatError').classList.add('hidden');
    let done = false;
    const finish = (v) => { if (done) return; done = true; dlg.close(); resolve(v); };
    $('chatCopy').onclick = async () => { await navigator.clipboard.writeText(req.prompt); $('chatCopy').textContent = 'Copied'; setTimeout(() => { $('chatCopy').textContent = 'Copy prompt'; }, 2000); };
    dlg.querySelectorAll('[data-open]').forEach(b => b.onclick = () => window.open(b.dataset.open, '_blank'));
    $('chatImages').onclick = () => api.openFolder(req.folder);
    $('chatUse').onclick = async () => {
      $('chatError').classList.add('hidden');
      try { finish(await api.chatAnswer({ id: req.id, text: $('chatReply').value })); }
      catch (e) { $('chatError').textContent = cleanErr(e); $('chatError').classList.remove('hidden'); }
    };
    $('chatClose').onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    dlg.showModal();
  });
}

const KEYS_URL = 'https://platform.claude.com/settings/keys';

// ---------- model choices ----------
// Costs measured from the app's real requests at Anthropic list prices (Nov 2026); ranges run from a repeat
// analysis within 5 minutes (instructions cached) to a first analysis.
const MODELS = {
  'claude-sonnet-5-5': { name: 'Sonnet 5.5', badge: 'Recommended', quality: 4, cost: '~4–10¢ per analysis', perFive: '~60–115 analyses for $5',
    about: 'The best balance for this app: thorough, specific advice at a few cents. Use this unless you have a reason not to.' },
  'claude-opus-5-5': { name: 'Opus 5.5', badge: 'Best results', quality: 5, cost: '~9–20¢ per analysis', perFive: '~30–55 analyses for $5',
    about: 'The most careful reasoning. Worth it for tricky multi-color prints, big plates and stubborn failures. About 2× the cost of Sonnet.' },
  'claude-haiku-5-5': { name: 'Haiku 5.5', badge: 'Cheapest', quality: 3, cost: 'well under 1¢ per analysis', perFive: '1,000+ analyses for $5',
    about: 'About 20× cheaper than Sonnet. Good for everyday prints; advice is simpler and can miss subtle problems. The app’s own checks still catch invalid or unsafe values.' },
};
function renderModelCard() {
  const v = $('modelSelect').value, m = MODELS[v];
  $('modelCard').innerHTML = m
    ? `<div class="mc-head"><b>${esc(m.name)}</b><span class="mc-badge">${esc(m.badge)}</span><span class="mc-stars" aria-label="Quality ${m.quality} of 5">${'★'.repeat(m.quality)}${'☆'.repeat(5 - m.quality)}</span></div>
       <p>${esc(m.about)}</p><p class="mc-cost">${esc(m.cost)} · ${esc(m.perFive)}</p>`
    : '<p>Any Claude model ID from the Claude Console. Costs and quality depend on the model.</p>';
}

// ---------- experience level, guide and tips ----------
// 0 brand new, 1 a little, 2 comfortable, 3 experienced. Decides how much help is shown.
function level() { const x = state.config && state.config.experience; return Number.isInteger(x) ? x : 1; }
function applyLevel() { document.body.dataset.level = String(level()); glossary.refresh(); }
// "Explain 3D printing words": on for Brand new and A little unless changed in Settings; off until a level is chosen
function wordsOn() {
  const c = state.config;
  if (!c || c.experience == null) return false;
  return typeof c.explainWords === 'boolean' ? c.explainWords : c.experience <= 1;
}

const sectionOf = (tip) => { const b = document.querySelector(`[data-tip="${tip}"]`); return b ? b.closest('section, .panel, .block') || b.parentElement.parentElement : null; };
const GUIDE_STEPS = [
  { id: 'open', title: 'Open a 3D model', text: 'Drag a .3mf file onto the window, or click Open 3MF. Files from MakerWorld, Printables and Snapmaker Orca all work. Downloaded a model? It’s usually in your Downloads folder.', target: () => $('dropZone'), until: 'opened', skipIf: () => !!state.file },
  { id: 'toolheads', title: 'Match your filament', text: 'Each toolhead (T1, T2…) should be set to the filament you’ll actually load. Click ✎ Change toolheads, pick the material (PLA is the most common), click the color dot to match your spool, then ✓ Done. Parts of the model use the toolhead shown in the 3D view’s colors.', target: () => sectionOf('toolheads') },
  { id: 'inspect', title: 'Look the model over', text: 'Drag on the model to rotate it and scroll to zoom. Click “Overhangs”: red areas would be printed over thin air and need supports. The Orientation list suggests the safest way to place it on the bed.', target: () => $('viewerTools') },
  { id: 'goal', title: 'Choose quality or speed', text: 'Slide toward Quality for smoother, better-looking prints, or toward Speed for faster ones. If you like, say what the part is for (e.g. “display piece” or “holds weight”); the advice takes it into account.', target: () => sectionOf('goal') },
  { id: 'ask', title: 'Get recommended settings', text: 'Click “Get recommended settings”. The app slices your model to measure it, then asks the AI which settings to change and why. It usually takes under a minute.', target: () => $('analyzeBtn'), until: 'analyzed', skipIf: () => !!state.result },
  { id: 'review', title: 'Read the recommendations', text: 'Each row is one suggested change with the reason in plain words. Untick anything you don’t want. Safety checks at the top catch settings that wouldn’t work, and fix many automatically. “Good to know” at the bottom lists what settings can’t fix (damp filament, the room, the printer), and AI can make mistakes, so read each change.', target: () => $('tab-recs') },
  { id: 'compare', title: 'Compare versions', text: 'Open “Compare slices”, click “Slice and compare” (slicing takes a minute or two), then click a version. You’ll see how it will look (smooth or visible layer lines), how strong it will be, and how long it takes, side by side.', target: () => document.querySelector('[data-tab=compare]'), until: 'compare-picked' },
  { id: 'finish', title: 'Save it or print it', text: 'Happy with a version? Click “Save as 3MF” to keep the model with these settings (open it in your slicer and print), or “Send to printer…” to print right away.', target: () => $('useButtons') || $('saveBtn'), until: 'saved' },
  { id: 'done', title: 'You’re all set!', text: 'That’s the whole workflow. If a print goes wrong, open Print history and click “Troubleshoot…”: you can paint where it failed and get fixes. Reopen this guide anytime with the Guide button at the top.' },
];
// The guided tour (api.demo, the first launch): the sample rocket through every feature, with recorded results.
// Finishing it unlocks the app for your own models (api.finishTour).
const DEMO_STEPS = [
  { id: 'open', title: 'Welcome to AI 3D Print Advisor Studio!', text: 'This tour shows how the app works on a sample toy rocket. Everything is recorded from the real app: nothing is sliced, printed or sent to the AI. Leave it anytime with “Exit the tour” at the bottom right. Click Open 3MF and choose “Demo Rocket”.', target: () => $('openBtn'), until: 'opened', skipIf: () => !!state.file },
  { id: 'words', title: 'Learn the words as you go', text: 'New to 3D printing? Words with a dotted underline are explained: hover over one to see what it means, with a picture. The Glossary button at the top lists every word with its picture, and you can search it. It’s a great way to learn the terms: have a look now, or anytime.', target: () => $('glossaryBtn'), until: 'glossary' },
  { id: 'models', title: 'Where to find models', text: 'Click “Find models” at the top: it lists the best sites to download models, free and paid. Snapmaker Space is Snapmaker’s own site for the U1, where every model is a ready-to-print U1 file. Close it when you’re done looking.', target: () => $('modelsBtn'), until: 'models' },
  { id: 'inspect', title: 'Spot the problem', text: 'This rocket was saved lying on its side. Click “Overhangs” above the model: red areas would be printed over thin air and need supports. Drag to rotate, scroll to zoom.', target: () => $('viewerTools') },
  { id: 'orient', title: 'Stand it up', text: 'The Orientation list scores every way to place the model. Pick “Stood upright · lowest risk”: overhangs drop from about 34 cm² to under 1 cm², so it needs no supports.', target: () => sectionOf('orientation'), until: 'oriented' },
  { id: 'toolheads', title: 'Four colors, four toolheads', text: 'Each toolhead (T1–T4) prints one filament: white body, red nose and fins, blue windows, grey nozzle. With your own models you set these to the spools you load.', target: () => sectionOf('toolheads') },
  { id: 'goal', title: 'Choose quality or speed', text: 'Slide toward Quality or Speed and say what the part is for. The advice takes both into account.', target: () => sectionOf('goal') },
  { id: 'ask', title: 'Get recommended settings', text: 'Click “Get recommended settings”. Normally your model is sliced and Claude reviews it (about a minute, a few cents with your API key). Here the answer was recorded.', target: () => $('analyzeBtn'), until: 'analyzed', skipIf: () => !!state.result },
  { id: 'review', title: 'Read the recommendations', text: 'This file had 0.08 mm layers (6½ hours), 1 wall, 5% infill and no brim. Each row says what changes and why, in plain words. Untick anything you don’t want.', target: () => $('tab-recs') },
  { id: 'compare', title: 'Compare versions', text: 'Open “Compare slices”, click “Slice and compare”, then click a version to see how it will look, how strong it is and how long it takes.', target: () => document.querySelector('[data-tab=compare]'), until: 'compare-picked' },
  { id: 'finish', title: 'Save it or print it', text: '“Save as 3MF” keeps the model with these settings and “Send to printer…” prints it on your printer. In the tour they explain instead. Try “Send to printer…” to see the printer picker.', target: () => $('useButtons') || $('saveBtn') },
  { id: 'remix', title: 'Color remix', text: 'Click “Color remix…”: Identify parts with AI, Confirm parts, then Generate. Each scheme uses filament from your library. Apply “Deep Space Cruiser” to repaint the rocket.', target: () => $('remixBtn'), until: 'remixed' },
  { id: 'filament', title: 'Your filament library', text: 'Click “Filament” at the top right: the library Color remix picks from, with photos, spools, locations and print settings. This is a sample library. After the tour, the first time you open Filament you can keep exploring it or start your own.', target: () => $('filamentBtn'), until: 'filament' },
  { id: 'history', title: 'When a print fails', text: 'Click “Back to model”, open “Print history” and click “Troubleshoot…” on the cancelled “Demo Rocket” print, then run it. The AI explains what went wrong and what to change.', target: () => document.querySelector('[data-tab=history]'), until: 'troubleshot' },
  { id: 'makerworld', title: 'MakerWorld files on a U1 (optional)', text: 'Using a Snapmaker U1 or another non-Bambu printer? Click Open 3MF and choose “Demo Rocket (MakerWorld version)” to see the app convert a Bambu Lab file. Bambu Lab owners open MakerWorld files as they are.', target: () => $('openBtn') },
  { id: 'limits', title: 'What no app can control', text: 'Settings are only part of a good print. Damp filament, a cold or drafty room and temperature swings, the type and brand of filament, and a dirty bed or a printer that needs calibrating can still spoil a print, however good the settings. AI can also make mistakes, especially with little to go on, so tell it what the part is for and read the changes. “Good to know” under every set of recommendations lists what to look after, and the Glossary window has printable cheat sheets (a 1-page sheet and a booklet) to keep next to your printer.', target: () => $('glossaryBtn') },
  { id: 'settings', title: 'Settings: where you set things up', text: 'Everything you set up lives in Settings, the gear at the top right: your AI key, your printers, Snapmaker Orca and your experience level. Click the gear.', target: () => $('settingsBtn'), until: 'settings' },
  { id: 'why-key', title: 'Why the app uses an API key', text: 'The app needs an Anthropic API key to use AI on its own. One analysis sends Claude pictures of your model, the slice results and your settings, often over several requests, and puts the answers straight into the app. A chatbot can’t do that: in the free chatbot mode you copy and paste every request by hand, and the chatbot sees less. A key is pay-as-you-go and cheap: most analyses cost a few cents (about 4–10¢ with Sonnet). The next three steps set up the real app: your account, your key and your slicer.', target: () => $('apiKeyField') },
  { id: 'account', title: 'Set up: your Anthropic account', text: 'The AI behind this app is Claude, made by Anthropic. To use it you need a free Anthropic account and a few dollars of credit (pay as you go, no subscription; $5 is the minimum and lasts for 60 or more analyses). Already have an account? Skip ahead. Otherwise: open the Claude Console below, sign up (or log in), then open Billing and add credit.', links: [['Open the Claude Console', 'https://platform.claude.com/'], ['Billing: add credit', 'https://platform.claude.com/settings/billing']], target: () => $('apiKeyField') },
  { id: 'apikey', title: 'Set up: an API key just for this app', text: 'In the Console, open API keys, click “Create key” and name it “AI 3D Print Advisor Studio”. Make a new key for this app even if you already have one: the Console then shows exactly what this app has cost, and you can switch it off without affecting anything else. Copy the key (it starts with sk-ant-), paste it in the API key box here, and keep it private. Prefer not to pay? Choose “Free chatbot” at the top of Settings instead: free, but you copy and paste each request by hand.', links: [['Open API keys', KEYS_URL]], target: () => $('apiKeyField'),
    doneIf: () => tourAiReady() || (openDlg('settingsDialog') && ($('apiKey').value.trim().length > 20 || (document.querySelector('input[name=aiMode]:checked') || {}).value === 'chat')) },
  { id: 'slicer', title: 'Set up: Snapmaker Orca', text: 'The app slices with Snapmaker Orca, the free slicer for the U1, to measure your models and compare versions. It needs to be installed on this PC, and the app needs to know where. If the “Snapmaker Orca program” box below shows it was found, you’re fine. If not, install it (link below) and click Browse to pick snapmaker-orca.exe. Then click “Save settings”.', links: [['Download Snapmaker Orca', 'https://github.com/Snapmaker/OrcaSlicer/releases/latest']], target: () => $('slicerPath'),
    doneIf: () => !openDlg('settingsDialog') && tourSlicerReady() },
  { id: 'done', title: 'You’re ready!', text: 'Click “Finish the tour” to go back to the app. It restarts once in normal mode: every click is real (Snapmaker Orca slices your models, Claude reviews them). Nothing from the tour is kept except what you just set up. You can take this tour again from Settings.' },
];
if (api.demo) GUIDE_STEPS.splice(0, GUIDE_STEPS.length, ...DEMO_STEPS);

// What to click next, step by step (also inside windows like Color remix): the guide rings it with a pulsing
// "Click here" and names it. Each returns [element, what it's called] or null when the step is just reading.
const openDlg = (id) => { const d = $(id); return d && d.open ? d : null; };
const tabOn = (t) => { const b = document.querySelector(`[data-tab=${t}]`); return b && b.getAttribute('aria-selected') === 'true'; };
const byText = (sel, re, root = document) => [...root.querySelectorAll(sel)].find(b => re.test(b.textContent));
const filamentOpen = () => $('filamentBtn').getAttribute('aria-pressed') === 'true';
const demoPickBtn = (i, fallback) => { const d = openDlg('demoPick'); return d ? [d.querySelector(`[data-i="${i}"]`), `“${(d.querySelector(`[data-i="${i}"] b`) || {}).textContent || 'the model'}”`] : fallback; };
const NEXT_CLICK = {
  open: () => demoPickBtn(0, [$('openBtn'), '“Open 3MF”']),
  makerworld: () => demoPickBtn(1, [$('openBtn'), '“Open 3MF”']),
  words: () => [$('glossaryBtn'), '“Glossary”'],
  models: () => (openDlg('modelsDialog') ? [$('modelsClose'), '“Close”'] : [$('modelsBtn'), '“Find models”']),
  settings: () => (openDlg('settingsDialog') ? null : [$('settingsBtn'), 'the gear (Settings)']),
  'why-key': () => (openDlg('settingsDialog') ? null : [$('settingsBtn'), 'the gear (Settings)']),
  account: () => (openDlg('settingsDialog') ? null : [$('settingsBtn'), 'the gear (Settings)']),
  apikey: () => {
    if (!openDlg('settingsDialog')) return tourAiReady() ? null : [$('settingsBtn'), 'the gear (Settings)'];
    if ($('apiKeyField').classList.contains('hidden')) return null;
    return [$('apiKey'), 'the API key box and paste your key'];
  },
  slicer: () => {
    if (!openDlg('settingsDialog')) return tourSlicerReady() ? null : [$('settingsBtn'), 'the gear (Settings)'];
    return $('slicerPath').value.trim() || (state.config.realSlicer || {}).available ? [$('saveSettings'), '“Save settings”'] : [$('browseSlicer'), '“Browse” and pick snapmaker-orca.exe'];
  },
  done: () => (tourAiReady() ? null : [$('settingsBtn'), 'the gear (Settings), and add your key or choose Free chatbot']),
  inspect: () => { const b = document.querySelector('#viewerTools [data-mode=overhang]'); return b && b.getAttribute('aria-checked') !== 'true' ? [b, '“Overhangs”'] : null; },
  orient: () => { const o = byText('#orientList .orient-opt', /upright/i) || document.querySelector('#orientList .orient-opt.best'); return o ? [o, 'the upright orientation'] : null; },
  ask: () => [$('analyzeBtn'), '“Get recommended settings”'],
  compare: () => {
    if (!tabOn('compare')) return [document.querySelector('[data-tab=compare]'), '“Compare slices”'];
    const row = document.querySelector('#compareBody tr[data-v]:not([data-v=original])');
    return row ? [row, 'a version in the table'] : [$('sliceBtn'), '“Slice and compare”'];
  },
  finish: () => api.demo ? ($('sendVariant') ? [$('sendVariant'), '“Send to printer…”'] : null)
    : ($('save3mfVariant') ? [$('save3mfVariant'), '“Save as 3MF”'] : [$('saveBtn'), '“Save as 3MF”']),
  remix: () => {
    if (!openDlg('remixDialog')) return [$('remixBtn'), '“Color remix…”'];
    if (!$('rxSwapPane').classList.contains('hidden')) return [$('rxStep1'), '“Parts”'];
    if (!$('rxPartsPane').classList.contains('hidden')) return !$('rxConfirm').disabled ? [$('rxConfirm'), '“Confirm parts”'] : [$('rxIdentify'), '“Identify parts with AI”'];
    const side = !$('rxBig').classList.contains('hidden') && $('rxBigSide').querySelector('[data-apply]');
    if (side) return [side, '“Apply to model”'];
    const cards = [...$('rxResults').querySelectorAll('.rx-card')];
    if (!cards.length) return [$('rxGo'), '“Generate”'];
    const card = cards.find(c => /deep space/i.test(c.textContent)) || cards[0];
    return [card.querySelector('[data-apply]'), '“Apply to model”' + (/deep space/i.test(card.textContent) ? ' on Deep Space Cruiser' : '')];
  },
  filament: () => [$('filamentBtn'), '“Filament”'],
  history: () => {
    if (filamentOpen()) return [$('filamentBtn'), '“Back to model”'];
    if (openDlg('tsDialog')) return [$('tsRun'), '“Troubleshoot with Claude”'];
    if (!tabOn('history')) return [document.querySelector('[data-tab=history]'), '“Print history”'];
    const b = document.querySelector('#tab-history [data-ts]'); return b ? [b, '“Troubleshoot…”'] : null;
  },
};
const GUIDE = { i: 0, on: false };
// The guide is a floating card. Windows like Color remix open as modal dialogs (above the page, the rest of it
// unclickable), so the card moves into whichever window is open and comes back when it closes. The "Click here" ring
// goes into the topmost window too (also the demo's model picker). While the guide is on, guideTick() keeps the ring
// on the thing to click next and moves the card to the corner where it covers neither that nor the main buttons.
const ring = document.createElement('div');
ring.id = 'guideRing'; ring.className = 'guide-ring hidden'; ring.setAttribute('aria-hidden', 'true');
ring.innerHTML = '<span class="guide-ring-tag">Click here</span>';
document.body.appendChild(ring);
const topDialog = (withDemo) => [...document.querySelectorAll('dialog[open]')].filter(d => d.id !== 'glossaryDialog' && (withDemo || !/^demo/.test(d.id))).pop();
function placeGuide() {
  const g = $('guide'), open = topDialog(false), home = open || document.body, top = topDialog(true) || document.body;
  if (g.parentElement !== home) home.appendChild(g);
  if (ring.parentElement !== top) top.appendChild(ring);
  g.classList.toggle('in-dialog', !!open);
  if (GUIDE.on) guideTick();
}
new MutationObserver(placeGuide).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
// an element's box when it's showing and clickable (not under another window); scrolled to first if it's off screen
function shownRect(el, scroll = false) {
  if (!el || !el.isConnected || el.closest('.hidden')) return null;
  const d = topDialog(true);
  if (d && !d.contains(el)) return null;
  let r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  if (scroll && (r.top < 0 || r.bottom > innerHeight) && guideScrolled !== el) {   // scroll to it once, then leave the scrolling to the user
    guideScrolled = el; el.scrollIntoView({ block: 'center' }); r = el.getBoundingClientRect();
  }
  return r.bottom < 0 || r.top > innerHeight ? null : r;
}
const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
let guideSpot = 0, guideLastEl = null, guideScrolled = null, guideTimer = null;
function positionCard(target) {
  const g = $('guide'); if (g.classList.contains('hidden')) return;
  const W = innerWidth, H = innerHeight, w = g.offsetWidth, h = g.offsetHeight, m = 16, top = 70;
  const mid = (W - w) / 2;
  const spots = [[m, H - h - m], [W - w - m, H - h - m], [W - w - m, top], [m, top], [mid, H - h - m], [mid, top]];
  const avoid = [];
  if (target) avoid.push([{ left: target.left - 40, right: target.right + 40, top: target.top - 48, bottom: target.bottom + 48 }, 1000]);
  const scope = topDialog(true) || document;
  scope.querySelectorAll('button, [role=radio], select, input, .orient-opt, .rx-card').forEach(el => { if (g.contains(el) || el.closest('.guide-ring')) return; const r = shownRect(el); if (r) avoid.push([r, el.matches('.btn.primary, [role=tab]') ? 4 : 2]); });
  const banner = document.querySelector('.demo-banner'); if (banner) avoid.push([banner.getBoundingClientRect(), 20]);
  const score = ([x, y]) => avoid.reduce((s, [r, k]) => s + k * overlap(r, { left: x, top: y, right: x + w, bottom: y + h }), 0);
  const scores = spots.map(score);
  const best = scores.indexOf(Math.min(...scores));
  if (scores[best] < scores[guideSpot]) guideSpot = best;   // stay put unless another corner is clearly better
  const [x, y] = spots[guideSpot];
  g.style.left = Math.max(m, x) + 'px'; g.style.top = Math.max(m, y) + 'px';
}
function guideTick() {
  const st = GUIDE.on && GUIDE_STEPS[GUIDE.i];
  if (!st) { ring.classList.add('hidden'); return; }
  // already done (e.g. the file opened another way): move on
  if (st.until && st.skipIf && st.skipIf()) { guideEvent(st.until); return; }
  // a step that is done by what the user set up (e.g. a key typed in) moves on by itself
  if (st.doneIf && st.doneIf()) { GUIDE.i++; renderGuide(); return; }
  if (st.id === 'done' && api.tour) gateFinish();
  const next = NEXT_CLICK[st.id] && (st.id !== 'done' || api.tour) ? NEXT_CLICK[st.id]() : null;
  let el = next && next[0], r = shownRect(el, true);
  const click = !!r;
  if (!r) { el = st.target && st.target(); r = shownRect(el); }
  // the app is working (slicing, asking the AI…): say so, so the guide doesn't look stuck
  const working = !click && busy.size ? [...busy.values()].pop() : null;
  const act = click ? `Click ${next[1]}` : working ? `Working: ${String(working.label).replace(/…$/, '')}… The guide moves on when it’s done.` : '';
  if ($('guideAct').textContent !== act) { $('guideAct').textContent = act; $('guideAct').classList.toggle('hidden', !act); $('guideWait').classList.toggle('hidden', !!act); }
  if (el && el !== guideLastEl) { guideLastEl = el; if (!click) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  ring.classList.toggle('hidden', !r);
  if (r) {
    const p = 5;
    Object.assign(ring.style, { left: `${r.left - p}px`, top: `${r.top - p}px`, width: `${r.width + 2 * p}px`, height: `${r.height + 2 * p}px` });
    ring.classList.toggle('soft', !click);
    ring.classList.toggle('tag-below', r.top < 48);
  }
  positionCard(r);
}
// react to a click straight away (not on the next 250 ms tick), so the highlight moves on as soon as it's clicked
document.addEventListener('click', () => { if (GUIDE.on) setTimeout(guideTick, 30); }, true);
function startGuide(from = 0) { GUIDE.on = true; GUIDE.i = from; while (GUIDE_STEPS[GUIDE.i] && GUIDE_STEPS[GUIDE.i].skipIf && GUIDE_STEPS[GUIDE.i].skipIf()) GUIDE.i++; renderGuide(); }
function stopGuide(done = false) {
  GUIDE.on = false; $('guide').classList.add('hidden'); ring.classList.add('hidden');
  clearInterval(guideTimer); guideTimer = null;
  if (done) api.setConfig({ guideDone: true }).catch(() => {});
}
function renderGuide() {
  if (!GUIDE.on) return;
  const st = GUIDE_STEPS[GUIDE.i];
  if (!st) { stopGuide(true); return; }
  $('guide').classList.remove('hidden');
  $('guideStep').textContent = st.id === 'done' ? 'Done' : `Step ${GUIDE.i + 1} of ${GUIDE_STEPS.length - 1}`;
  $('guideTitle').textContent = st.title;
  if ($('guideHero')) $('guideHero').classList.toggle('hidden', GUIDE.i !== 0);
  $('guideText').innerHTML = esc(st.text) + (st.id === 'open' && wordsOn() ? '<br><span class="waiting">Words with a dotted underline are explained: hover over one to see what it means and a picture.</span>' : '')
    + (st.links ? `<span class="guide-links">${st.links.map(([label, url]) => `<a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`).join('')}</span>` : '');
  $('guideWait').textContent = st.until ? { opened: 'Waiting for you to open a model…', analyzed: 'Click the highlighted button to continue.', 'compare-picked': 'Click a version in the table to continue.', saved: 'Save or send it to finish.', oriented: 'Pick an orientation to continue.', remixed: 'Apply a scheme to continue.', glossary: 'Open the Glossary to continue (or skip this step).', settings: 'Open Settings to continue.', filament: 'Open Filament to continue.', troubleshot: 'Run the troubleshooter to continue.' }[st.until] : '';
  $('guideAct').textContent = ''; $('guideAct').classList.add('hidden'); $('guideWait').classList.remove('hidden');
  $('guideDots').innerHTML = GUIDE_STEPS.slice(0, -1).map((_, k) => `<span class="${k <= GUIDE.i ? 'on' : ''}"></span>`).join('');
  $('guideBack').disabled = GUIDE.i === 0;
  $('guideNext').disabled = false; const later = $('guideSlicerLater'); if (later) later.remove();
  $('guideNext').textContent = st.id === 'done' ? (api.tour ? 'Finish the tour' : 'Finish') : st.until ? 'Skip step' : 'Next';
  guideLastEl = null;
  placeGuide();
  guideTick();
  if (!guideTimer) guideTimer = setInterval(guideTick, 250);
}
// the app reports what the user just did; the guide moves on when it's what the current step waits for
function guideEvent(name) {
  if (!GUIDE.on) return;
  const st = GUIDE_STEPS[GUIDE.i];
  if (st && st.until === name) { GUIDE.i++; while (GUIDE_STEPS[GUIDE.i] && GUIDE_STEPS[GUIDE.i].skipIf && GUIDE_STEPS[GUIDE.i].skipIf()) GUIDE.i++; renderGuide(); return; }
  // done a step or two early (before pressing Next): move on past it
  const ahead = GUIDE_STEPS.findIndex((x, k) => k > GUIDE.i && k <= GUIDE.i + 2 && x.until === name);
  if (ahead > 0) { GUIDE.i = ahead + 1; renderGuide(); }
  else if (name === 'analyzed') { const review = GUIDE_STEPS.findIndex(x => x.id === 'review'); if (GUIDE.i < review) { GUIDE.i = review; renderGuide(); } }
}
// The tour's last steps help set up the AI (a saved key, or the free chatbot) and Snapmaker Orca. Finishing is
// never blocked: anything not set up is offered again when the app starts.
const tourAiReady = () => !!(state.config.realHasKey || state.config.realAiMode === 'chat');
const tourSlicerReady = () => !!((state.config.realSlicer || {}).available || GUIDE.slicerLater);
function gateFinish() {
  const ai = tourAiReady(), sl = tourSlicerReady();
  $('guideNext').disabled = false;
  const why = !ai ? 'The AI isn’t set up yet (Back shows how). You can finish anyway and set it up when the app starts.'
    : !sl ? 'Snapmaker Orca wasn’t found. Set its location in Settings (Back shows how), or finish now and set it up when the app starts.' : '';
  if ($('guideWait').textContent !== why) $('guideWait').textContent = why;
  $('guideWait').classList.toggle('hidden', !why);
  const later = $('guideSlicerLater'); if (later) later.remove();
}
$('guideNext').onclick = () => {
  if (GUIDE_STEPS[GUIDE.i].id === 'done') {
    if (api.tour) { $('guideNext').disabled = true; $('guideNext').textContent = 'Starting the app…'; api.finishTour(); return; }
    stopGuide(true); return;
  }
  GUIDE.i++; renderGuide();
};
$('guideBack').onclick = () => { if (GUIDE.i > 0) { GUIDE.i--; renderGuide(); } };
$('guideHide').onclick = () => { stopGuide(); toast('Guide hidden. Click “Guide” at the top to bring it back.', 4000); };
$('guideBtn').onclick = () => (GUIDE.on ? stopGuide() : startGuide(state.result ? GUIDE_STEPS.findIndex(x => x.id === 'review') : state.file ? 1 : 0));

// first launch: ask about experience once
function maybeWelcome() {
  applyLevel();
  if (state.config.experience != null) {
    return firstSetup().then(() => {
      if ((level() <= 1 || api.demo) && !state.config.guideDone && !GUIDE.on) startGuide(state.result ? GUIDE_STEPS.findIndex(x => x.id === 'review') : state.file ? 1 : 0);
    });
  }
  return new Promise((resolve) => {
    const dlg = $('welcomeDialog');
    dlg.querySelectorAll('[data-xp]').forEach(b => b.onclick = async () => {
      const xp = Number(b.dataset.xp);
      state.config.experience = xp;
      await api.setConfig({ experience: xp }).catch(() => {});
      applyLevel(); dlg.close();
      // beginners are offered the guided tour (once); everyone else never sees it
      if (xp <= 1 && await offerTour()) { resolve(); return; }
      await firstSetup();
      if (xp <= 1 || api.demo) startGuide(state.file ? 1 : 0);
      else toast(xp === 3 ? 'Expert mode: tips are hidden and technical details shown. Change it anytime in Settings.' : 'Tips are on (the “?” buttons). Click “Guide” at the top for a step-by-step walkthrough anytime.', 6000);
      resolve();
    });
    dlg.addEventListener('cancel', (e) => e.preventDefault(), { once: true }); // a choice is needed; any choice is fine
    dlg.showModal();
  });
}

// The optional guided tour, offered once to beginners. true = they chose it (the app restarts into it).
function offerTour() {
  if (api.demo || !state.config.tourAvailable || state.config.tourOffered) return Promise.resolve(false);
  return new Promise((resolve) => {
    const dlg = $('tourOfferDialog');
    state.config.tourOffered = true;
    api.setConfig({ tourOffered: true }).catch(() => {});
    $('tourOfferYes').onclick = () => { $('tourOfferYes').disabled = true; $('tourOfferYes').textContent = 'Starting the tour…'; api.restartTour(); resolve(true); };
    $('tourOfferNo').onclick = () => { dlg.close(); resolve(false); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); dlg.close(); resolve(false); }, { once: true });
    dlg.showModal();
  });
}
// Once, after the experience question: the AI (own key or free chatbot) and Snapmaker Orca, whatever isn't set
// up yet. "Later" is fine: Settings has both.
function firstSetup() {
  const c = state.config;
  if (api.demo || c.setupOffered) return Promise.resolve();
  const needAi = c.aiMode !== 'chat' && !c.hasKey, needSlicer = !(state.info && state.info.available);
  const mark = () => { c.setupOffered = true; return api.setConfig({ setupOffered: true }).catch(() => {}); };
  if (!needAi && !needSlicer) { mark(); return Promise.resolve(); }
  return new Promise((resolve) => {
    const dlg = $('setupDialog');
    $('suAi').classList.toggle('hidden', !needAi);
    $('suSlicerBox').classList.toggle('hidden', !needSlicer);
    $('suKey').value = ''; $('suSlicer').value = c.slicerPath || '';
    const sync = () => { $('suKey').disabled = (document.querySelector('input[name=suMode]:checked') || {}).value === 'chat'; };
    document.querySelectorAll('input[name=suMode]').forEach(r => { r.onchange = sync; }); sync();
    $('suBrowse').onclick = async () => { const p = await api.browseSlicer(); if (p) $('suSlicer').value = p; };
    const finish = async (save) => {
      const patch = { setupOffered: true };
      if (save && needAi) {
        patch.aiMode = (document.querySelector('input[name=suMode]:checked') || {}).value || 'api';
        if (patch.aiMode === 'api' && $('suKey').value.trim()) patch.apiKey = $('suKey').value.trim();
      }
      if (save && needSlicer && $('suSlicer').value.trim()) patch.slicerPath = $('suSlicer').value.trim();
      $('suSave').disabled = true;
      try { await api.setConfig(patch); await loadConfig(); } catch (e) { toast(cleanErr(e), 6000); }
      $('suSave').disabled = false;
      c.setupOffered = true; dlg.close();
      const left = [state.config.aiMode !== 'chat' && !state.config.hasKey ? 'the AI' : '', !(state.info && state.info.available) ? 'Snapmaker Orca' : ''].filter(Boolean);
      toast(left.length ? `You can set up ${left.join(' and ')} anytime in Settings (the gear, top right).` : 'All set. Open a 3MF file to get started.', 6000);
      resolve();
    };
    $('suSave').onclick = () => finish(true);
    $('suLater').onclick = () => finish(false);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); }, { once: true });
    dlg.showModal();
  });
}

// "?" tips: plain-language explanations next to sections
const TIPS = {
  toolheads: 'A toolhead (T1, T2…) is a nozzle that melts and lays down one filament. Single-nozzle printers use T1 for everything. Set each to the filament you’ll load: PLA is easiest and most common, PETG is tougher and handles heat better, TPU is flexible. The toolheads are locked so the project isn’t set up again after every little change: click ✎ Change toolheads, make all your changes, then ✓ Done.',
  orientation: 'How the model sits on the bed changes a lot: parts printed over thin air (“overhangs”) need supports, and a model touching the bed with a large flat area sticks better and won’t tip over. Each choice also says what it does to the look: the top and sides people see should print smooth, not on supports, so a figure is never flipped upside down just to save support underneath. “Lowest risk” is the app’s pick.',
  goal: 'Quality prints thinner layers, so surfaces look smoother but the print takes longer. Speed prints thicker layers: much faster, with more visible lines. The middle is a good everyday choice.',
};
function showTip(btn) {
  const pop = $('tipPop');
  pop.textContent = TIPS[btn.dataset.tip] || '';
  pop.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  pop.style.left = `${Math.min(window.innerWidth - 340, r.left)}px`; pop.style.top = `${r.bottom + 8}px`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.tip-btn');
  if (b) { e.preventDefault(); showTip(b); return; }
  if (!e.target.closest('#tipPop')) $('tipPop').classList.add('hidden');
});

// ---------- settings ----------
async function loadConfig() {
  state.config = await api.getConfig();
  state.info = state.config.slicer;
  applyLevel();
  setTimeout(showAnalyzeCost, 0);
  $('keyHint').innerHTML = state.config.aiMode === 'chat' ? 'Free chatbot mode: you’ll copy a prompt into ChatGPT, Claude or Gemini and paste the answer back.'
    : !state.config.hasKey ? `To get recommendations, create a Claude API key at <a href="${KEYS_URL}" target="_blank" rel="noopener">platform.claude.com/settings/keys</a> and paste it in <button class="link" id="keyLink">Settings</button>, or switch to the free chatbot mode there.`
    : state.config.hasKey ? '' : 'To get recommendations, add a Claude API key or switch to the free chatbot mode in <button class="link" id="keyLink">Settings</button>.';
  const kl = $('keyLink'); if (kl) kl.onclick = openSettings;
  offerBooklet();
}
// ---------- Settings: spool tags (NFC) ----------
// The reader runs in the background (src/nfc.js); its status shows here live while Settings is open.
let NFC = { state: 'off', readers: [] };
const NFC_TEXT = {
  off: 'Off.',
  starting: 'Starting the reader…',
  no_service: 'Waiting for a reader: plug in your USB NFC reader or Arduino.',
  no_reader: 'No reader found yet: plug in your USB NFC reader or Arduino.',
};
function renderNfcStatus() {
  const el = $('nfcStatus');
  if (!el) return;
  let text, cls = '';
  if (!$('nfcOn').checked) text = NFC.enabled ? 'Turns off when you save settings.' : 'Off.';
  else if (!NFC.enabled) text = 'Starts when you save settings.';
  else if (NFC.state === 'watching') { text = `✓ Ready: ${(NFC.readers || []).join(', ')}. Tap a spool’s tag on the reader.`; cls = 'ok'; }
  else if (NFC.state === 'error') { text = NFC.error || 'The tag reader has a problem.'; cls = 'bad'; }
  else text = NFC_TEXT[NFC.state] || NFC.state;
  el.textContent = text;
  el.className = `nfc-status ${cls}`;
}
async function fillNfcPorts(selected) {
  const sel = $('nfcPort');
  const opt = (v, t, arduino) => { const o = document.createElement('option'); o.value = v; o.textContent = t; if (arduino) o.dataset.arduino = '1'; return o; };
  sel.replaceChildren(opt('', 'None'), opt('auto', 'Find an Arduino automatically'));
  sel.value = selected || '';
  const r = await api.nfcPorts().catch(() => null);
  const ports = (r && r.ports) || [];
  for (const p of ports) sel.append(opt(p.port, `${p.port}: ${p.name}`, p.arduino));
  if (/^COM\d+$/.test(selected || '') && !ports.some(p => p.port === selected)) sel.append(opt(selected, `${selected} (not plugged in)`));
  sel.value = selected || '';
}
async function renderNfcSettings() {
  const tour = !!api.tour;
  $('nfcTour').classList.toggle('hidden', !tour);
  $('nfcOn').disabled = tour;
  const s = (await api.nfcStatus().catch(() => null)) || {};
  NFC = { ...NFC, ...s };
  $('nfcOn').checked = !!s.enabled;
  $('nfcPcsc').checked = s.pcsc !== false;
  $('nfcReader').value = s.reader || '';
  $('nfcAnywhere').checked = s.openAnywhere !== false;
  $('nfcFormat').value = s.writeFormat || 'openspool';
  $('nfcConfirm').checked = s.confirmOverwrite !== false;
  $('nfcPortStatus').dataset.base = $('nfcPortStatus').dataset.base || $('nfcPortStatus').innerHTML;
  $('nfcPortStatus').innerHTML = $('nfcPortStatus').dataset.base;
  const showOpts = () => $('nfcOpts').classList.toggle('hidden', !$('nfcOn').checked || tour);
  showOpts();
  const port = typeof s.serialPort === 'string' ? s.serialPort : 'auto';
  $('nfcPort').replaceChildren(new Option(port || 'None', port));
  if ($('nfcOn').checked && !tour) fillNfcPorts(port);
  $('nfcOn').onchange = () => { showOpts(); if ($('nfcOn').checked && $('nfcPort').options.length < 3) fillNfcPorts($('nfcPort').value || 'auto'); renderNfcStatus(); };
  $('nfcTest').onclick = async () => {
    const out = $('nfcPortStatus');
    let port = $('nfcPort').value;
    if (port === 'auto') port = ([...$('nfcPort').options].find(o => o.dataset.arduino) || {}).value || '';
    if (!port) { out.textContent = $('nfcPort').value === 'auto' ? 'No Arduino is plugged in.' : 'Pick the COM port of your Arduino or PN532 board first.'; return; }
    out.textContent = `Testing ${port}…`;
    $('nfcTest').disabled = true;
    const r = await api.nfcTestPort(port).catch(e => ({ ok: false, error: String(e.message || e) }));
    $('nfcTest').disabled = false;
    out.textContent = r && r.ok
      ? `✓ Found ${r.kind === 'bridge' ? 'the SpoolTagBridge Arduino' : 'a PN532 board'} on ${port}${r.version ? ` (${r.version.replace(/^SPOOLBRIDGE \d+ /, '')})` : ''}.`
      : `✗ ${(r && r.error) || `Nothing answered on ${port}.`}`;
  };
  renderNfcStatus();
}
if (api.onNfcStatus) api.onNfcStatus(s => { NFC = { ...NFC, ...s }; if ($('settingsDialog').open) renderNfcStatus(); });
// The Filament screen's "Reader settings" button: open Settings at the spool tags section
window.__openNfcSettings = () => { openSettings(); setTimeout(() => $('nfcField').scrollIntoView({ block: 'center' }), 60); };
async function saveNfcSettings() {
  if (api.tour || !api.nfcSet) return;
  const patch = { enabled: $('nfcOn').checked, pcsc: $('nfcPcsc').checked, reader: $('nfcReader').value.trim(), serialPort: $('nfcPort').value,
    openAnywhere: $('nfcAnywhere').checked, writeFormat: $('nfcFormat').value, confirmOverwrite: $('nfcConfirm').checked };
  try { NFC = { ...NFC, ...(await api.nfcSet(patch)) }; } catch (e) { toast(String(e.message || e), 5000); }
}
// ---------- Settings: phone access (the Filament library on phones on the home network, src/phone) ----------
let PH = { devices: [] };
let phonePairTimer = null;
const ago = (t) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString();
};
function renderPhoneStatus() {
  const el = $('phoneStatus');
  if (!el) return;
  let text, cls = '';
  if (!$('phoneOn').checked) text = PH.enabled ? 'Turns off when you save settings.' : 'Off.';
  else if (!PH.enabled) text = 'Starts when you save settings.';
  else if (PH.error) { text = PH.error; cls = 'bad'; }
  else if (PH.running) {
    const u = PH.urls || {};
    text = `✓ On at ${u.name}${u.ips && u.ips.length ? ` (also ${u.ips.join(', ')})` : ''}${u.https ? ` · secure: ${u.https}` : ''}`;
    if (PH.linkVia && PH.linkVia.because) text += ` · Links on labels and stickers use ${PH.linkBase}, because ${PH.linkVia.because} can’t find this PC by name: reserve that address for this PC in your router so it doesn’t change.`;
    cls = 'ok';
  } else text = 'Starting…';
  el.textContent = text;
  el.className = `nfc-status ${cls}`;
  $('phonePairBtn').disabled = !PH.running;
  const certOk = !!(PH.running && PH.https && PH.urls && PH.urls.https);
  $('phoneCertRow').classList.toggle('hidden', !certOk);
  if (!certOk) $('phoneCert').classList.add('hidden');
  const devs = PH.devices || [];
  $('phoneDevices').innerHTML = devs.length ? `<small><b>Paired phones</b></small>${devs.map(d => `<div class="phone-dev"><span class="grow">${esc(d.name)} <small>· paired ${new Date(d.paired).toLocaleDateString()} · last seen ${ago(d.lastSeen)}${d.localOk === false ? ' · <span style="color:var(--warn)">can’t find this PC by name, so links use its address</span>' : ''}</small></span><button type="button" class="link" data-phone-remove="${esc(d.id)}">Remove</button></div>`).join('')}` : '';
}
async function renderPhoneSettings() {
  const tour = !!api.tour;
  $('phoneTour').classList.toggle('hidden', !tour);
  $('phoneOn').disabled = tour;
  const s = (await api.phoneStatus().catch(() => null)) || {};
  PH = { ...PH, ...s };
  $('phoneOn').checked = !!s.enabled;
  $('phoneReader').checked = s.readerToPhones !== false;
  $('phoneStickers').checked = s.stickerLinks !== false;
  $('phoneLinkHost').value = s.linkHost === 'ip' ? 'ip' : 'name';
  $('phoneHttps').checked = !!s.https;
  $('phonePort').value = s.port || 8765;
  $('phonePair').classList.add('hidden');
  $('phoneCert').classList.add('hidden');
  // the certificate is on the plain address (the phone doesn't trust the secure one yet)
  $('phoneCertBtn').onclick = () => {
    const url = `${(PH.urls && PH.urls.ips && PH.urls.ips[0]) || (PH.urls && PH.urls.name)}/cert/aipa-ca.crt`;   // by number: some phones can't find the PC by name
    const q = window.qrcode(0, 'M'); q.addData(url); q.make();
    $('phoneCertQr').src = q.createDataURL(5, 2);
    $('phoneCertUrl').textContent = url;
    $('phoneCert').classList.toggle('hidden');
  };
  const showOpts = () => $('phoneOpts').classList.toggle('hidden', !$('phoneOn').checked || tour);
  showOpts();
  $('phoneOn').onchange = () => { showOpts(); renderPhoneStatus(); };
  $('phonePairBtn').onclick = async () => {
    try {
      const r = await api.phonePair();
      const q = window.qrcode(0, 'M'); q.addData(r.url); q.make();
      $('phoneQr').src = q.createDataURL(5, 2);
      $('phonePairUrl').textContent = r.url;
      $('phonePair').classList.remove('hidden');
      clearInterval(phonePairTimer);
      const tick = () => {
        const left = Math.max(0, Math.round((r.expires - Date.now()) / 1000));
        $('phonePairExp').textContent = left ? `(works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}, once)` : '(expired: click Pair a phone again)';
        if (!left) { clearInterval(phonePairTimer); $('phoneQr').style.opacity = '.2'; } else $('phoneQr').style.opacity = '';
      };
      tick(); phonePairTimer = setInterval(tick, 1000);
    } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''), 5000); }
  };
  $('phoneDevices').onclick = async (e) => {
    const b = e.target.closest('[data-phone-remove]');
    if (!b) return;
    PH = { ...PH, ...(await api.phoneRemove(b.dataset.phoneRemove)) };
    renderPhoneStatus();
  };
  renderPhoneStatus();
}
if (api.onPhoneStatus) api.onPhoneStatus(s => { PH = { ...PH, ...s }; if ($('settingsDialog').open) renderPhoneStatus(); });
async function savePhoneSettings() {
  clearInterval(phonePairTimer);
  if (api.tour || !api.phoneSet) return;
  const port = parseInt($('phonePort').value, 10);
  const patch = { enabled: $('phoneOn').checked, readerToPhones: $('phoneReader').checked, stickerLinks: $('phoneStickers').checked,
    linkHost: $('phoneLinkHost').value, https: $('phoneHttps').checked };
  if (port >= 1024 && port <= 65535) { patch.port = port; patch.httpsPort = port + 1; }
  try { PH = { ...PH, ...(await api.phoneSet(patch)) }; } catch (e) { toast(String(e.message || e), 5000); }
  if (PH.error) toast(`Phone access: ${PH.error}`, 8000);
}
function openSettings() {
  const sel = $('modelSelect');
  const known = [...sel.options].some(o => o.value === state.config.model);
  sel.value = known ? state.config.model : 'custom';
  $('customModel').value = known ? '' : state.config.model;
  $('customModel').classList.toggle('hidden', known);
  renderModelCard();
  $('apiKey').value = '';
  const keysLink = `<a href="${KEYS_URL}" target="_blank" rel="noopener">platform.claude.com/settings/keys</a>`;
  $('keyStatus').innerHTML = state.config.keyNeedsReentry ? `Your saved key couldn’t be unlocked after the app was renamed. Please paste it again (find or create it at ${keysLink}).`
    : (api.tour ? state.config.realHasKey : state.config.hasKey) ? `A key is saved. Leave blank to keep it. Manage your keys at ${keysLink}.`
    : `No key saved yet. Create one at ${keysLink} (pay-as-you-go; a Claude subscription isn’t needed, but the account needs a little prepaid credit).`;
  document.querySelectorAll('input[name=aiMode]').forEach(r => { r.checked = r.value === (state.config.aiMode || 'api'); });
  $('experienceSelect').value = String(level());
  $('explainWords').checked = wordsOn() || (state.config.experience == null && level() <= 1);
  $('experienceSelect').onchange = () => { $('explainWords').checked = Number($('experienceSelect').value) <= 1; };
  const syncMode = () => { const chat = document.querySelector('input[name=aiMode]:checked').value === 'chat'; $('apiKeyField').classList.toggle('hidden', chat); $('modelSelect').closest('.field').classList.toggle('hidden', chat); };
  document.querySelectorAll('input[name=aiMode]').forEach(r => { r.onchange = syncMode; });
  syncMode();
  $('slicerPath').value = state.config.slicerPath || '';
  $('slicerPath').placeholder = state.config.detectedSlicer ? `Detected: ${state.config.detectedSlicer}` : 'Not found. Browse to snapmaker-orca.exe';
  $('slicerStatus').textContent = state.info.available ? `Ready: ${state.info.filaments.length} U1 filament presets found.` : 'Slicing is off until Snapmaker Orca is found.';
  if (api.tour && state.config.realSlicer) {
    const rs = state.config.realSlicer;
    $('slicerPath').value = rs.path || '';
    $('slicerPath').placeholder = rs.detected ? `Detected: ${rs.detected}` : 'Not found. Install it, then Browse to snapmaker-orca.exe';
    $('slicerStatus').textContent = rs.available ? `Found: ${rs.exe || rs.detected}. You’re set.` : 'Not found on this PC yet. Install Snapmaker Orca, then click Browse.';
  }
  renderSamples();
  $('printerRows').innerHTML = '';
  (state.config.printers.length ? state.config.printers : [{}]).forEach(p => addPrinterRow(p));
  $('discoverResults').innerHTML = ''; $('discoverStatus').textContent = '';
  renderSpend();
  $('aboutLine').innerHTML = `AI 3D Print Advisor Studio ${esc(state.config.version || '')}${state.config.homepage ? ` · <a href="${esc(state.config.homepage)}#readme" target="_blank" rel="noopener">Guide and help</a>` : ''} · Not affiliated with Snapmaker.`;
  $('tourAgain').classList.toggle('hidden', !state.config.tourAvailable);
  $('autoUpdate').checked = state.config.autoUpdate !== false;
  $('updateStatus').textContent = UPDATE.info && UPDATE.info.available ? `Version ${UPDATE.info.latest} is available.` : `You have version ${state.config.version || ''}.`;
  renderNfcSettings();
  renderPhoneSettings();
  renderMonitorSettings();
  if (api.zoomGet) api.zoomGet().then(z => { const sel = $('zoomSelect'); const near = [...sel.options].reduce((a, o) => Math.abs(+o.value - z) < Math.abs(+a.value - z) ? o : a); sel.value = near.value; }).catch(() => {});
  selectSettingsTab('general');
  $('settingsDialog').showModal();
  guideEvent('settings');
}
$('tourAgain').onclick = () => api.restartTour();
document.querySelectorAll('#settingsDialog [data-sheet]').forEach(b => { b.onclick = () => openCheatSheet(b.dataset.sheet); });
$('settingsBtn').onclick = openSettings;

// ---------- updates: check GitHub, show what's new, install in place ----------
const UPDATE = { info: null };
// the CHANGELOG's Markdown, enough of it: bullets (with wrapped lines), bold, code, links
function mdHtml(md) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const items = [], para = [];
  for (const line of String(md).split('\n')) {
    if (/^\s*[-*]\s+/.test(line)) items.push(line.replace(/^\s*[-*]\s+/, ''));
    else if (/^\s+\S/.test(line) && items.length) items[items.length - 1] += ' ' + line.trim();
    else if (line.trim()) para.push(line.trim());
  }
  return (para.length ? `<p>${inline(para.join(' '))}</p>` : '') + (items.length ? `<ul>${items.map(i => `<li>${inline(i)}</li>`).join('')}</ul>` : '');
}
function showUpdate(info) {
  UPDATE.info = info;
  $('updateBtn').classList.toggle('hidden', !info.available);
  if (!info.available) return;
  $('updTitle').textContent = `Version ${info.latest} is available`;
  $('updSub').textContent = `You have ${info.current}. Here’s what’s new since then${info.notes.length > 1 ? ` (${info.notes.length} versions)` : ''}:`;
  $('updNotes').innerHTML = info.notes.map(n => `<h3>${esc(n.version)}</h3>${mdHtml(n.text)}`).join('') || '<p>See the release page for details.</p>';
  $('updNote').innerHTML = info.canInstall
    ? 'It downloads from GitHub, checks the file, installs into this same folder and restarts the app. Your settings, API key, filament library and history are kept.'
    : `This copy can’t update itself (it isn’t in a release folder). <a href="${esc(info.page)}" target="_blank" rel="noopener">Download it from the release page</a>.`;
  $('updInstall').textContent = info.canInstall ? 'Install and restart' : 'Open the release page';
  ['updInstall', 'updLater', 'updSkip'].forEach(id => { $(id).disabled = false; });
  $('updProgress').classList.add('hidden');
  if (!$('updateDialog').open) $('updateDialog').showModal();
}
// found by the automatic check: show it now, unless the app is busy or another window is open (then the green button)
api.onUpdateAvailable(info => {
  UPDATE.info = info; $('updateBtn').classList.remove('hidden');
  if (!busy.size && !document.querySelector('dialog[open]')) showUpdate(info);
});
api.onUpdateProgress(({ stage, pct, version }) => {
  if (version) $('updTitle').textContent = `Installing version ${version}`;
  $('updProgress').classList.remove('hidden');
  $('updProgress').querySelector('.bar span').style.width = `${stage === 'download' ? pct : 100}%`;
  $('updProgress').querySelector('.label').textContent = stage === 'download' ? `Downloading… ${pct}%` : stage === 'unpack' ? 'Unpacking…' : 'Restarting with the new version…';
});
$('updateBtn').onclick = () => UPDATE.info && showUpdate(UPDATE.info);
$('updLater').onclick = () => $('updateDialog').close();
$('updSkip').onclick = async () => {
  await api.updateSkip(UPDATE.info && UPDATE.info.latest).catch(() => {});
  $('updateDialog').close(); $('updateBtn').classList.add('hidden');
  toast('Skipped. Settings → Check for updates shows it again.', 5000);
};
$('updInstall').onclick = async () => {
  const info = UPDATE.info;
  if (!info) return;
  if (!info.canInstall) { window.open(info.page, '_blank'); return; }
  if (state.file) saveSession();
  ['updInstall', 'updLater', 'updSkip'].forEach(id => { $(id).disabled = true; });
  try { await api.updateInstall(); }
  catch (e) {
    $('updProgress').classList.add('hidden');
    $('updNote').textContent = `The update didn’t install: ${cleanErr(e)}`;
    ['updInstall', 'updLater', 'updSkip'].forEach(id => { $(id).disabled = false; });
  }
};
$('updateCheckBtn').onclick = async () => {
  $('updateStatus').textContent = 'Checking…';
  try {
    const info = await api.updateCheck();
    $('updateStatus').textContent = info.available ? `Version ${info.latest} is available.` : `You have the newest version (${info.current}).`;
    if (info.available) showUpdate(info);
  } catch (e) { $('updateStatus').textContent = `Couldn’t check: ${cleanErr(e)}`; }
};
// once, the first time the real app opens after the tour: offer the printable booklet
function offerBooklet() {
  if (!state.config.offerBooklet || api.tour || $('bookletDialog').open) return;
  state.config.offerBooklet = false;
  // wait until no other window (setup, filament library…) is open, then offer it once
  const tryShow = () => {
    if (document.querySelector('dialog[open]')) { setTimeout(tryShow, 2000); return; }
    api.setConfig({ bookletOffered: true }).catch(() => {});
    $('bookletDialog').showModal();
  };
  setTimeout(tryShow, 1500);
}
$('bookletLater').onclick = () => $('bookletDialog').close();
$('bookletOpen').onclick = () => { openCheatSheet('booklet'); $('bookletDialog').close(); };
$('bookletQuick').onclick = () => { openCheatSheet('quick'); };
$('bookletSave').onclick = async () => {
  try { const p = await api.saveCheatSheet('booklet'); if (p) { toast(`Saved the booklet: ${p}`, 6000); $('bookletDialog').close(); } }
  catch (e) { toast(cleanErr(e), 6000); }
};
$('autoUpdate').onchange = (e) => { state.config.autoUpdate = e.target.checked; api.setConfig({ autoUpdate: e.target.checked }).catch(() => {}); };

// ---------- AI spending: top-bar counter and the Settings section ----------
const dollars = (usd) => (usd >= 1 ? `$${usd.toFixed(2)}` : usd >= 0.01 ? `${(usd * 100).toFixed(usd < 0.1 ? 1 : 0)}¢` : usd > 0 ? 'under 1¢' : '$0.00');
function showSpendChip(month) { $('spendChip').textContent = `AI ${month.usd >= 1 ? '$' + month.usd.toFixed(2) : month.usd > 0 ? dollars(month.usd) : '$0.00'}`; }
let spendFlash;
api.onSpend(({ usd, feature, month }) => {
  const chip = $('spendChip');
  chip.textContent = `+${dollars(usd)}`; chip.classList.add('flash'); chip.title = `${feature}: ${dollars(usd)}. This month: ${dollars(month.usd)} (details in Settings)`;
  clearTimeout(spendFlash);
  spendFlash = setTimeout(() => { chip.classList.remove('flash'); showSpendChip(month); }, 4000);
  if ($('settingsDialog').open) renderSpend();
});
api.spendSummary().then(s => showSpendChip(s.month)).catch(() => {});
$('spendChip').onclick = () => { openSettings(); selectSettingsTab('ai'); setTimeout(() => $('spendField').scrollIntoView({ block: 'center' }), 50); };
async function renderSpend() {
  const s = await api.spendSummary().catch(() => null);
  if (!s) return;
  showSpendChip(s.month);
  const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  $('spendSummary').innerHTML = `<div class="spend-totals"><span><b>${dollars(s.month.usd)}</b>this month (${s.month.calls} request${s.month.calls === 1 ? '' : 's'})</span>
      <span><b>${dollars(s.last30.usd)}</b>last 30 days</span><span><b>${dollars(s.all.usd)}</b>${s.since ? `since ${new Date(s.since).toLocaleDateString()}` : 'in total'}</span></div>
    ${s.byFeature.length ? `<table><tbody>${s.byFeature.map(f => `<tr><td>${esc(f.feature)}</td><td class="n">${f.calls}×</td><td class="n">${dollars(f.usd)}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">No AI requests yet this month.</p>'}
    ${s.recent.length ? `<details><summary>Latest requests</summary><table><tbody>${s.recent.map(e => `<tr><td>${esc(when(e.t))} · ${esc(e.feature)}<br><small>${esc(e.model)}: ${e.in + e.cr + e.cw} tokens in, ${e.out} out${e.searches ? `, ${e.searches} web search${e.searches === 1 ? '' : 'es'}` : ''}</small></td><td class="n">${dollars(e.usd)}</td></tr>`).join('')}</tbody></table></details>` : ''}`;
}
$('spendClear').onclick = async () => { await api.spendClear(); renderSpend(); toast('The app’s spending record was cleared.', 3000); };

// ---------- printers in Settings: any number, added by hand or found on the network ----------
function addPrinterRow(p = {}) {
  const n = $('printerRows').children.length + 1;
  const row = document.createElement('div');
  row.className = 'printer-row';
  row.innerHTML = `<input type="text" class="p-name" placeholder="Name, e.g. Office U1" aria-label="Printer ${n} name">
    <input type="text" class="p-url" placeholder="Address, e.g. 192.168.1.50" aria-label="Printer ${n} address">
    <input type="password" class="p-key" placeholder="${p.hasKey ? 'Key saved' : 'API key (optional)'}" aria-label="Printer ${n} API key">
    <button type="button" class="btn ghost p-remove" aria-label="Remove printer ${n}" title="Remove this printer">×</button>
    <div class="p-mon">
      <label class="check"><input type="checkbox" class="p-watch"> Print Monitor</label>
      <label>Camera <select class="p-cam" aria-label="Printer ${n} camera">
        <option value="u1">Snapmaker U1’s built-in camera</option><option value="snapshot">A picture address (webcam snapshot)</option>
        <option value="mjpeg">A video stream address (MJPEG)</option><option value="off">No camera</option></select></label>
      <input type="url" class="p-camurl hidden" placeholder="http://192.168.1.50/webcam/?action=snapshot" aria-label="Printer ${n} camera address">
      <button type="button" class="link p-ka" title="Wakes the U1's camera with the API key, like the app does every minute while it's watching">Test camera keep-alive</button>
      <span class="hint p-kastatus"></span>
    </div>`;
  row.querySelector('.p-name').value = p.name || '';
  row.querySelector('.p-url').value = p.url || '';
  const cam = p.camera || {};
  row.querySelector('.p-watch').checked = p.monitor !== false;
  row.querySelector('.p-cam').value = cam.mode || 'u1';
  row.querySelector('.p-camurl').value = cam.url || '';
  const syncCam = () => { const m = row.querySelector('.p-cam').value; row.querySelector('.p-camurl').classList.toggle('hidden', m !== 'snapshot' && m !== 'mjpeg'); row.querySelector('.p-ka').classList.toggle('hidden', m !== 'u1'); };
  row.querySelector('.p-cam').onchange = syncCam; syncCam();
  row.querySelector('.p-ka').onclick = async () => {
    const st = row.querySelector('.p-kastatus');
    st.textContent = 'Sending…';
    const r = await api.monitorKeepalive(row.querySelector('.p-url').value.trim()).catch(e => ({ ok: false, status: cleanErr(e) }));
    st.textContent = r.ok ? 'The camera accepted it.' : r.status;
  };
  row.querySelector('.p-remove').onclick = () => { row.remove(); if (!$('printerRows').children.length) addPrinterRow(); };
  $('printerRows').appendChild(row);
  return row;
}
$('addPrinterBtn').onclick = () => addPrinterRow().querySelector('.p-name').focus();
const normAddr = (u) => String(u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/:80$/, '');
api.onDiscoverProgress(({ done, total, found }) => { $('discoverStatus').textContent = `Checking your network… ${Math.round(100 * done / total)}% (${found} found)`; });
$('discoverBtn').onclick = async () => {
  $('discoverBtn').disabled = true; $('discoverResults').innerHTML = ''; $('discoverStatus').textContent = 'Checking your network…';
  try {
    const found = await api.discoverPrinters();
    const have = () => new Set([...document.querySelectorAll('.printer-row .p-url')].map(i => normAddr(i.value)).filter(Boolean));
    if (!found.length) {
      $('discoverStatus').textContent = '';
      $('discoverResults').innerHTML = '<p class="hint">No printers answered. Make sure they’re on and on the same network as this computer, or add them by hand with their address (shown in each printer’s network settings, or your router’s device list).</p>';
      return;
    }
    $('discoverStatus').textContent = `Found ${found.length} printer${found.length === 1 ? '' : 's'}.`;
    const render = () => {
      const h = have();
      const fresh = found.filter(f => !h.has(normAddr(f.url)));
      $('discoverResults').innerHTML = `<ul class="discover-list">${found.map((f, i) => `<li><span><b>${esc(f.hostname || f.host)}</b> · ${esc(f.kind)} · ${esc(f.url)}</span>${h.has(normAddr(f.url)) ? '<span class="ok-line">Added</span>' : `<button type="button" class="btn" data-add="${i}">Add</button>`}</li>`).join('')}</ul>
        ${fresh.length > 1 ? '<button type="button" class="btn primary" id="addAllFound">Add all</button>' : ''}`;
      const add = (f) => {
        // fill an empty row first, else add one; name from the printer's own name
        const empty = [...document.querySelectorAll('.printer-row')].find(r => !r.querySelector('.p-url').value.trim() && !r.querySelector('.p-name').value.trim());
        const row = empty || addPrinterRow();
        const count = document.querySelectorAll('.printer-row').length;
        row.querySelector('.p-name').value = f.hostname ? f.hostname.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : `${f.isU1 ? 'U1' : 'Printer'} ${count}`;
        row.querySelector('.p-url').value = f.url;
      };
      $('discoverResults').querySelectorAll('[data-add]').forEach(b => b.onclick = () => { add(found[Number(b.dataset.add)]); render(); });
      const all = $('addAllFound'); if (all) all.onclick = () => { fresh.forEach(add); render(); };
    };
    render();
  } catch (e) { $('discoverStatus').textContent = `Couldn’t search the network: ${cleanErr(e)}`; }
  finally { $('discoverBtn').disabled = false; }
};
$('browseSlicer').onclick = async () => { const p = await api.browseSlicer(); if (p) $('slicerPath').value = p; };
$('modelSelect').onchange = e => { $('customModel').classList.toggle('hidden', e.target.value !== 'custom'); renderModelCard(); };
$('settingsDialog').addEventListener('close', async () => {
  if ($('settingsDialog').returnValue !== 'save') return;
  const model = $('modelSelect').value === 'custom' ? $('customModel').value : $('modelSelect').value;
  const printers = [...document.querySelectorAll('.printer-row')].map(r => ({ name: r.querySelector('.p-name').value.trim(), url: r.querySelector('.p-url').value.trim(), apiKey: r.querySelector('.p-key').value.trim(),
    monitor: r.querySelector('.p-watch').checked, camera: { mode: r.querySelector('.p-cam').value, url: r.querySelector('.p-camurl').value.trim() } })).filter(p => p.url);
  const patch = { model, printers, slicerPath: $('slicerPath').value.trim(), aiMode: (document.querySelector('input[name=aiMode]:checked') || {}).value || 'api', experience: Number($('experienceSelect').value) };
  // remember the switch only when it differs from what the level would choose, so changing level later still applies
  patch.explainWords = $('explainWords').checked === (patch.experience <= 1) ? null : $('explainWords').checked;
  if ($('apiKey').value.trim()) patch.apiKey = $('apiKey').value;
  const before = state.info.available;
  await api.setConfig(patch);
  await saveNfcSettings();
  await savePhoneSettings();
  await saveMonitorSettings();
  await loadConfig();
  state.history = null;
  toast('Settings saved.', 2500);
  if (state.file && before !== state.info.available) { state.slots = state.slots.map(s => ({ ...s, preset: matchPreset(s.type, s.preset) })); renderMaterials(); prepare(); }
});

// ---------- toast ----------
let toastTimer;
function toast(msg, ms = 4000, onReveal) {
  const t = $('toast');
  t.innerHTML = esc(msg) + (onReveal ? ' <button class="link">Show in folder</button>' : '');
  if (onReveal) t.querySelector('button').onclick = onReveal;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('toast').classList.add('hidden'); }
document.querySelector('[data-tab=compare]').addEventListener('click', e => { e.currentTarget.textContent = 'Compare slices'; });


// ---------- zoom: applies at once (it's saved by the app, not by Save settings) ----------
$('zoomSelect').addEventListener('change', (e) => { if (api.zoomSet) api.zoomSet(Number(e.target.value)); });
if (api.onZoom) api.onZoom(() => { if (typeof renderKpiBar === 'function') setTimeout(renderKpiBar, 50); });

// ---------- Settings tabs ----------
function selectSettingsTab(tab) {
  const t = document.querySelector(`#settingsDialog .stabs [data-stab="${tab}"]`) ? tab : 'general';
  document.querySelectorAll('#settingsDialog .stabs [data-stab]').forEach(b => { const on = b.dataset.stab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  document.querySelectorAll('#settingsDialog .stab').forEach(p => p.classList.toggle('hidden', p.dataset.stab !== t));
}
document.querySelector('#settingsDialog .stabs').addEventListener('click', (e) => { const b = e.target.closest('[data-stab]'); if (b) selectSettingsTab(b.dataset.stab); });
if (api.onOpenSettingsTab) api.onOpenSettingsTab((tab) => { if (!$('settingsDialog').open) openSettings(); selectSettingsTab(tab); });

// ---------- Settings: Print Monitor (src/monitor) ----------
const MON_EVENTS = [['start', 'Print started'], ['paused', 'Paused'], ['error', 'Printer error'], ['cancelled', 'Cancelled'], ['snapshot', 'Final photo taken'], ['complete', 'Finished (bed still hot)'], ['ready', 'Done and cooled: ready to remove']];
const MON_MILES = [1, 10, 25, 50, 75, 90];
let MON = null;
async function renderMonitorSettings() {
  if (!api.monitorSettings) return;
  const m = MON = await api.monitorSettings().catch(() => null);
  if (!m) return;
  const tour = !!m.tour;
  $('monTour').classList.toggle('hidden', !tour);
  $('monOn').disabled = tour;
  $('monOn').checked = m.enabled !== false && !tour;
  $('monBar').checked = m.kpiBar !== false;
  $('monTray').checked = m.keepInTray !== false;
  $('monLogin').checked = !!m.startWithWindows;
  $('monLoginRow').classList.toggle('hidden', !m.canStartWithWindows);
  $('monUnits').value = m.units === 'C' ? 'C' : 'F';
  $('monSnap').value = m.snapshot_progress; $('monSafe').value = m.safe_bed_c; $('monPrev').value = m.preview_minutes;
  const n = m.notifications;
  $('monDesk').checked = !!n.desktop.enabled; $('monNtfy').checked = !!n.ntfy.enabled; $('monMail').checked = !!n.email.enabled;
  $('monEvents').innerHTML = MON_EVENTS.map(([k, label]) => `<tr><td>${esc(label)}</td>${['desktop', 'ntfy', 'email'].map(ch =>
    `<td><input type="checkbox" data-mon-ch="${ch}" data-mon-ev="${k}" aria-label="${esc(label)}: ${ch}" ${n[ch].events[k] ? 'checked' : ''}></td>`).join('')}</tr>`).join('');
  $('monNtfyServer').value = n.ntfy.server || 'https://ntfy.sh'; $('monNtfyTopic').value = n.ntfy.topic || ''; $('monNtfyToken').value = '';
  $('monNtfyTokenSet').textContent = n.ntfy.tokenSet ? '· saved, leave blank to keep' : '';
  $('monMailHost').value = n.email.host || ''; $('monMailPort').value = n.email.port || 587; $('monMailSec').value = n.email.security || 'starttls';
  $('monMailUser').value = n.email.user || ''; $('monMailPass').value = ''; $('monMailTo').value = n.email.to || ''; $('monMailFrom').value = n.email.from || '';
  $('monMailPassSet').textContent = n.email.passSet ? '· saved, leave blank to keep' : '';
  $('monMiles').innerHTML = MON_MILES.map(v => `<label class="check"><input type="checkbox" data-mon-mile="${v}" ${(n.email.milestones || []).includes(v) ? 'checked' : ''}> ${v}%</label>`).join(' ');
  $('monStatus').textContent = '';
  syncMonitorSettings();
}
function syncMonitorSettings() {
  $('monOpts').classList.toggle('hidden', !$('monOn').checked);
  $('monNtfyBox').classList.toggle('hidden', !$('monNtfy').checked);
  $('monMailBox').classList.toggle('hidden', !$('monMail').checked);
  document.querySelectorAll('[data-mon-ch]').forEach(c => { c.disabled = !$({ desktop: 'monDesk', ntfy: 'monNtfy', email: 'monMail' }[c.dataset.monCh]).checked; });
}
['monOn', 'monDesk', 'monNtfy', 'monMail'].forEach(id => $(id).addEventListener('change', syncMonitorSettings));
$('monMailSec').onchange = () => { $('monMailPort').value = $('monMailSec').value === 'tls' ? 465 : 587; };
$('monNtfyNew').onclick = () => {
  const a = new Uint8Array(9); crypto.getRandomValues(a);
  $('monNtfyTopic').value = 'prints-' + [...a].map(b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
};
function monitorPatch() {
  const ev = (ch) => Object.fromEntries([...document.querySelectorAll(`[data-mon-ch="${ch}"]`)].map(c => [c.dataset.monEv, c.checked]));
  const patch = {
    enabled: $('monOn').checked, kpiBar: $('monBar').checked, keepInTray: $('monTray').checked, startWithWindows: $('monLogin').checked,
    units: $('monUnits').value, snapshot_progress: Number($('monSnap').value), safe_bed_c: Number($('monSafe').value), preview_minutes: Number($('monPrev').value),
    notifications: {
      desktop: { enabled: $('monDesk').checked, events: ev('desktop') },
      ntfy: { enabled: $('monNtfy').checked, events: ev('ntfy'), server: $('monNtfyServer').value.trim(), topic: $('monNtfyTopic').value.trim() },
      email: { enabled: $('monMail').checked, events: ev('email'), host: $('monMailHost').value.trim(), port: Number($('monMailPort').value), security: $('monMailSec').value,
        user: $('monMailUser').value.trim(), to: $('monMailTo').value.trim(), from: $('monMailFrom').value.trim(),
        milestones: [...document.querySelectorAll('[data-mon-mile]')].filter(c => c.checked).map(c => Number(c.dataset.monMile)) },
    },
  };
  if ($('monNtfyToken').value.trim()) patch.notifications.ntfy.token = $('monNtfyToken').value.trim();
  if ($('monMailPass').value) patch.notifications.email.pass = $('monMailPass').value;
  return patch;
}
async function saveMonitorSettings() {
  if (!MON || MON.tour || !api.monitorSet) return;
  try { await api.monitorSet(monitorPatch()); } catch (e) { toast(`Print Monitor settings: ${cleanErr(e)}`, 6000); }
  refreshKpiBar();
}
$('monTest').onclick = async () => {
  $('monStatus').textContent = 'Saving and sending…';
  try {
    await api.monitorSet(monitorPatch());
    const r = await api.monitorTest();
    const res = Object.entries(r.results || {});
    $('monStatus').textContent = res.length ? res.map(([k, v]) => `${k}: ${v}`).join(' · ') : 'No alert channel is switched on.';
    const s = await api.monitorSettings(); MON = s;
    $('monNtfyTokenSet').textContent = s.notifications.ntfy.tokenSet ? '· saved, leave blank to keep' : '';
    $('monMailPassSet').textContent = s.notifications.email.passSet ? '· saved, leave blank to keep' : '';
    $('monNtfyToken').value = ''; $('monMailPass').value = '';
  } catch (e) { $('monStatus').textContent = `Couldn’t send it: ${cleanErr(e)}`; }
};
$('monOpen').onclick = () => api.openMonitor();
$('monImport').onclick = async () => {
  try {
    const r = await api.monitorImportU1Studio();
    if (!r) return;
    await renderMonitorSettings();
    $('monStatus').textContent = `Brought over U1 Studio's settings${r.photos ? ` and ${r.photos} final photo${r.photos === 1 ? '' : 's'}` : ''}. Stop U1 Studio from starting with Windows, so alerts don't come twice.`;
  } catch (e) { $('monStatus').textContent = cleanErr(e); }
};

// ---------- the printing bar on the main screen ----------
const KPI = { state: null, timer: null };
const kpiHours = (s) => { const h = (s || 0) / 3600; return h >= 100 ? `${Math.round(h).toLocaleString()} h` : `${Math.floor(h)} h ${String(Math.round(((s || 0) % 3600) / 60)).padStart(2, '0')} m`; };
const kpiTime = (s) => (s == null || !isFinite(s) ? '--:--' : `${Math.floor(s / 3600)}:${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`);
async function refreshKpiBar() {
  try { const r = await fetch('/api/monitor/state', { cache: 'no-store' }); KPI.state = await r.json(); }
  catch { KPI.state = null; }
  const s = await (api.monitorSettings ? api.monitorSettings().catch(() => null) : null);
  KPI.show = !!(s && !s.tour && s.enabled !== false && s.kpiBar !== false);
  renderKpiBar();
}
function renderKpiBar() {
  const bar = $('kpiBar'), st = KPI.state;
  const ps = st && st.printers ? st.order.map(id => st.printers.find(p => p.id === id)).filter(Boolean) : [];
  $('monitorBtn').classList.toggle('hidden', !ps.length);
  const show = KPI.show && ps.length > 0;
  bar.classList.toggle('hidden', !show);
  document.body.classList.toggle('has-kpi', show);
  sizeKpiBar(show);
  if (!show) return;
  const now = Date.now() / 1000;
  const printing = ps.filter(p => ['printing', 'paused', 'preparing'].includes(p.stage));
  const next = printing.map(p => p.time && p.time.left != null ? now + p.time.left : null).filter(Boolean).sort((a, b) => a - b)[0];
  const ready = ps.filter(p => p.stage === 'ready' || p.stage === 'cooling').length;
  const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const label = { printing: 'Printing', preparing: 'Heating up', paused: 'Paused', cooling: 'Done · cooling', ready: 'Ready to remove', waiting: 'Idle', idle: 'Idle', error: 'Error', cancelled: 'Cancelled', offline: 'Offline' };
  const card = (p) => {
    const active = ['printing', 'paused', 'preparing'].includes(p.stage);
    const pct = Math.round((p.progress || 0) * 100);
    const left = p.time && p.time.left;
    const name = String((p.status && p.status.print_stats && p.status.print_stats.filename) || (p.job && p.job.filename) || '').replace(/\.gcode$/i, '').split('/').pop().replace(/_/g, ' ');
    const thumb = p.thumb && (active || ['cooling', 'ready'].includes(p.stage)) ? `<img src="/api/monitor/p/${encodeURIComponent(p.id)}/thumbnail?v=${esc(p.thumb_v)}" alt="">` : `<span class="kpi-ph"></span>`;
    return `<button type="button" class="kpi-card st-${esc(p.stage.replace(/^klippy_.*/, 'offline'))}" data-mon-open="${esc(p.id)}" title="${esc(p.name)}: open in the Print Monitor">
      ${thumb}<span class="kpi-txt"><b>${esc(p.name)}</b><span class="kpi-st">${esc(label[p.stage] || 'Offline')}${active ? ` · ${pct}%` : ''}</span>
      ${active ? `<span class="kpi-sub">${left != null ? `${kpiTime(left)} left · ends ${clock(now + left)}` : 'estimating…'}</span>` : name && ['cooling', 'ready'].includes(p.stage) ? `<span class="kpi-sub">${esc(name)}</span>` : ''}
      ${active ? `<span class="kpi-prog"><i style="width:${pct}%"></i></span>` : ''}</span></button>`;
  };
  // lifetime print time from each printer's own history (Moonraker's job totals)
  const life = ps.map(p => ({ name: p.name, s: (p.totals && p.totals.total_print_time) || 0, jobs: (p.totals && p.totals.total_jobs) || 0 }));
  const lifeAll = life.reduce((t, x) => t + x.s, 0), jobsAll = life.reduce((t, x) => t + x.jobs, 0);
  const lifeTip = life.map(x => `${x.name}: ${kpiHours(x.s)} printed, ${Math.round(x.jobs)} prints`).join('\n') + `\nAll printers: ${kpiHours(lifeAll)}, ${Math.round(jobsAll)} prints`;
  const html = `<div class="kpi-grip" title="Drag to make the bar bigger or smaller (double-click: normal size)"></div><div class="kpi-sum"><b>${printing.length}</b> printing${next ? `<span>next done ${clock(next)}</span>` : ''}${ready ? `<span class="kpi-ready">${ready} ready to remove</span>` : ''}</div>
    ${lifeAll ? `<div class="kpi-sum kpi-life" title="${esc(lifeTip)}"><b>${kpiHours(lifeAll)}</b> printed<span>all printers · ${Math.round(jobsAll).toLocaleString()} prints</span></div>` : ''}
    <div class="kpi-cards">${ps.map(card).join('')}</div>
    <button type="button" class="btn ghost kpi-open" data-mon-open="">Print Monitor</button>`;
  if (bar.__html !== html) { bar.innerHTML = html; bar.__html = html; }   // only when something shows differently
}
$('kpiBar').addEventListener('click', (e) => { const b = e.target.closest('[data-mon-open]'); if (b) { hideKpiPeek(); api.openMonitor(b.dataset.monOpen || undefined); } });
// The bar's height: drag its bottom edge (48 to 200 px); everything in it scales with it. Kept on this PC.
const KPI_BASE = 64;
let kpiH = (() => { const v = Number(localStorage.getItem('aipa.kpiH')); return v >= 48 && v <= 200 ? v : KPI_BASE; })();
function sizeKpiBar(show = !$('kpiBar').classList.contains('hidden')) {
  $('kpiBar').style.zoom = String(kpiH / KPI_BASE);
  document.body.style.setProperty('--kpi-h', show ? `${kpiH}px` : '0px');
}
$('kpiBar').addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('.kpi-grip');
  if (!grip || e.button !== 0) return;
  e.preventDefault(); hideKpiPeek();
  const y0 = e.clientY, h0 = kpiH;
  grip.classList.add('dragging'); document.body.classList.add('kpi-resizing');
  const move = (ev) => { kpiH = Math.round(Math.min(200, Math.max(48, h0 + ev.clientY - y0))); sizeKpiBar(); };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    grip.classList.remove('dragging'); document.body.classList.remove('kpi-resizing');
    localStorage.setItem('aipa.kpiH', String(kpiH));
    window.dispatchEvent(new Event('resize'));   // the 3D view and others re-measure
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});
$('kpiBar').addEventListener('dblclick', (e) => { if (e.target.closest('.kpi-grip')) { kpiH = KPI_BASE; localStorage.setItem('aipa.kpiH', String(kpiH)); sizeKpiBar(); window.dispatchEvent(new Event('resize')); } });
// Hovering a printer in the bar shows a bigger card: a larger picture of the print and its details
const kpiPeek = document.createElement('div');
kpiPeek.className = 'kpi-peek hidden';
kpiPeek.setAttribute('role', 'tooltip');
kpiPeek.dataset.noGloss = '';   // no word explanations inside it
document.body.appendChild(kpiPeek);
let peekId = null, peekTimer = null;
function hideKpiPeek() { clearTimeout(peekTimer); peekId = null; kpiPeek.classList.add('hidden'); }
function renderKpiPeek() {
  const p = peekId && KPI.state && KPI.state.printers.find(x => x.id === peekId);
  if (!p) return hideKpiPeek();
  const now = Date.now() / 1000, t = p.time || {}, j = p.job || {};
  const active = ['printing', 'paused', 'preparing'].includes(p.stage), done = ['cooling', 'ready', 'waiting'].includes(p.stage);
  const pct = Math.round((p.progress || 0) * 1000) / 10;
  const ps = (p.status && p.status.print_stats) || {}, info = ps.info || {};
  const name = String(ps.filename || j.filename || '').replace(/\.gcode$/i, '').split('/').pop().replace(/_/g, ' ');
  const dur = (s) => (s == null || !isFinite(s) ? '—' : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} min`);
  const clock = (ts) => new Date(ts * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const elapsed = j.started_at ? ((done && j.ended_at ? j.ended_at : now) - j.started_at) : null;
  const label = { printing: 'Printing', preparing: 'Heating up', paused: 'Paused', cooling: 'Done · bed cooling', ready: 'Done · ready to remove', waiting: 'Idle', idle: 'Idle', error: 'Error', cancelled: 'Cancelled', offline: 'Offline' }[p.stage] || 'Offline';
  const row = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  const heads = ['extruder', 'extruder1', 'extruder2', 'extruder3'].map((e, i) => {
    const h = p.status && p.status[e]; if (!h) return '';
    const ptc = (p.status && p.status.print_task_config) || {}, raw = (ptc.filament_color_rgba || [])[i];
    const hex = raw == null ? '' : (typeof raw === 'number' ? raw.toString(16).padStart(8, '0') : String(raw).replace('#', '')).slice(0, 6);
    const active = p.status.toolhead && p.status.toolhead.extruder === e;
    return `<span class="kp-head${active ? ' on' : ''}" title="Toolhead ${i + 1}">${/^[0-9a-f]{6}$/i.test(hex) ? `<i style="background:#${hex}"></i>` : ''}T${i + 1} ${Math.round(h.temperature || 0)}°C</span>`;
  }).join('');
  kpiPeek.innerHTML = `${p.thumb ? `<img src="/api/monitor/p/${encodeURIComponent(p.id)}/thumbnail?v=${esc(p.thumb_v)}" alt="">` : ''}
    <div class="kp-body"><div class="kp-name">${esc(p.name)}</div>
    <div class="kp-st st-${esc(p.stage.replace(/^klippy_.*/, 'offline'))}">${esc(label)}${active || done ? ` · ${pct}%` : ''}</div>
    ${name ? `<div class="kp-file">${esc(name)}</div>` : ''}
    ${active || done ? `<div class="kpi-prog"><i style="width:${active || done ? pct : 0}%"></i></div>` : ''}
    <div class="kp-rows">
      ${active ? row('Time left', dur(t.left)) + row('Ends', t.left != null ? clock(now + t.left) : '—') : ''}
      ${active || done ? row(done ? 'Print took' : 'Elapsed', dur(elapsed)) : ''}
      ${active && elapsed != null && t.left != null ? row('Estimated duration', dur(elapsed + t.left)) : ''}
      ${info.total_layer ? row('Layer', `${info.current_layer || 0} / ${info.total_layer}`) : ''}
      ${ps.filament_used ? row('Filament used', `${(ps.filament_used / 1000).toFixed(1)} m`) : ''}
    </div>
    ${heads ? `<div class="kp-heads">${heads}</div>` : ''}
    ${p.totals && p.totals.total_print_time ? `<div class="kp-life">Lifetime: <b>${kpiHours(p.totals.total_print_time)}</b> printed · ${Math.round(p.totals.total_jobs || 0).toLocaleString()} prints · ${((p.totals.total_filament_used || 0) / 1000).toFixed(0)} m of filament</div>` : ''}
    <div class="kp-hint">Click to open it in the Print Monitor</div></div>`;
  kpiPeek.classList.remove('hidden');
}
$('kpiBar').addEventListener('mouseover', (e) => {
  const c = e.target.closest('.kpi-card');
  if (!c) return;
  if (peekId === c.dataset.monOpen && !kpiPeek.classList.contains('hidden')) return;
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    peekId = c.dataset.monOpen;
    renderKpiPeek();
    const r = c.getBoundingClientRect(), w = kpiPeek.offsetWidth;
    kpiPeek.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    kpiPeek.style.top = `${r.bottom + 6}px`;
  }, 180);
});
$('kpiBar').addEventListener('mouseleave', hideKpiPeek);
$('kpiBar').addEventListener('mouseout', (e) => { if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.kpi-card')) { if (e.target.closest('.kpi-card')) hideKpiPeek(); } });
$('monitorBtn').onclick = () => api.openMonitor();
if (api.onMonitor) {
  api.onMonitor((msg) => {
    if (msg.type === 'printer' && !KPI.state) return refreshKpiBar();
    if (msg.type === 'printer' && KPI.state) {
      const i = KPI.state.printers.findIndex(p => p.id === msg.printer.id);
      if (i >= 0) KPI.state.printers[i] = msg.printer; else return refreshKpiBar();
      renderKpiBar();
      if (peekId === msg.printer.id) renderKpiPeek();
    } else if (msg.type === 'state') refreshKpiBar();
  });
  refreshKpiBar();
  setInterval(() => { if (!document.hidden) renderKpiBar(); }, 30000);
}

loadConfig();
