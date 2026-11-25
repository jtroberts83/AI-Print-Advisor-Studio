// Print report window (Print history → Print report…). A summary of the prints you pick (status, time, filament,
// and how far that filament would stretch, like the Print Monitor), or a detailed report with the settings each
// print used, read from its G-code. Printed with the system dialog or saved as a PDF.
// compare() and jobName() come from ../monitor/derive.js.
(() => {
  const api = window.advisor;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KEY = 'aipa.printReport';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  const R = { jobs: [], errors: [], excluded: new Set(saved.excluded || []), detail: new Map(), thumbs: new Map(), busy: false };
  let BIG = null;   // the Print Monitor's list for big totals (school bus … marathon)
  fetch('../monitor/comparisons.json').then((r) => r.json()).then((x) => { BIG = x; render(); }).catch(() => {});

  // ---------- small helpers
  const hm = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`; };
  const dayStr = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  const dtStr = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const metres = (j) => (j.filamentMm || 0) / 1000;
  const plannedG = (j) => j.grams || (j.filaments || []).reduce((t, f) => t + (f.grams || 0), 0) || null;
  const plannedM = (j) => (j.filaments || []).reduce((t, f) => t + (f.mm || 0), 0) / 1000;
  const live = (j) => STATUS(j.status) === 'printing';
  const cmpText = (j) => (live(j) ? (plannedM(j) ? `When done: ${compare(plannedM(j))}` : 'Still printing') : metres(j) > 0 ? compare(metres(j)) : 'No filament used');
  const STATUS = (s) => (s === 'completed' ? 'completed' : s === 'cancelled' ? 'cancelled' : s === 'in_progress' ? 'printing' : 'failed');
  const STATUS_LABEL = { completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed', printing: 'Printing' };
  const nameOf = (j) => (typeof jobName === 'function' ? jobName(j.filename) : String(j.filename || '').split('/').pop().replace(/\.gcode$/i, ''));
  // grams really used: the slicer's planned weight, scaled down for a print that stopped early
  function gramsUsed(j) {
    const planned = j.grams || (j.filaments || []).reduce((t, f) => t + (f.grams || 0), 0);
    if (!planned) return null;
    if (STATUS(j.status) === 'printing') return null;   // the printer's history fills in time and filament when a print ends
    const plannedMm = (j.filaments || []).reduce((t, f) => t + (f.mm || 0), 0);
    if (!j.filamentMm) return 0;
    return plannedMm ? planned * Math.min(1, j.filamentMm / plannedMm) : planned;
  }
  const kg = (g) => (g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${Math.round(g)} g`);
  const ruler = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/></svg>';

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify({ excluded: [...R.excluded].slice(-3000), title: $('title').value, mode: mode(), depth: $('depth').value,
      st: [...document.querySelectorAll('[data-st]')].filter((c) => !c.checked).map((c) => c.dataset.st), printer: $('printer').value, q: $('q').value, from: $('from').value, to: $('to').value })); } catch {}
  }
  const mode = () => document.querySelector('[name=mode]:checked').value;

  // ---------- which prints
  function shown() {
    const off = new Set([...document.querySelectorAll('[data-st]')].filter((c) => !c.checked).map((c) => c.dataset.st));
    const from = $('from').value, to = $('to').value, pr = $('printer').value, q = $('q').value.trim().toLowerCase();
    return R.jobs.filter((j) => {
      if (off.has(STATUS(j.status))) return false;
      if (pr && j.printer !== pr) return false;
      const d = j.start ? ymd(new Date(j.start)) : '';
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (q && !nameOf(j).toLowerCase().includes(q)) return false;
      return true;
    });
  }
  const included = () => shown().filter((j) => !R.excluded.has(j.id));

  // ---------- rendering
  function swatches(j) {
    return (j.filaments || []).map((f) => `<span class="sw" style="background:${esc(f.color || '#ccc')}" title="${esc([f.type, f.name].filter(Boolean).join(' · '))}"></span>`).join('');
  }
  function materials(j) {
    const types = [...new Set((j.filaments || []).map((f) => f.type).filter(Boolean))];
    return types.length ? types.join(' + ') : (j.filamentType || '');
  }
  function thumbHtml(j, cls = 'th') {
    const t = R.thumbs.get(j.id);
    return t ? `<img class="${cls}" src="${t}" alt="">` : `<span class="${cls} none" aria-hidden="true"></span>`;
  }

  function render() {
    const list = shown(), inc = list.filter((j) => !R.excluded.has(j.id));
    $('counts').textContent = R.jobs.length ? `${inc.length} of ${list.length} shown prints in the report` : '';
    const title = $('title').value.trim() || 'Print report';
    document.title = title;
    if (!R.jobs.length) { $('report').innerHTML = R.loading ? '<p class="empty">Reading print history from your printers…</p>' : `<p class="empty">${R.errors.length ? esc(R.errors.join(' · ')) : 'No prints found.'}</p>`; return; }

    const done = inc.filter((j) => STATUS(j.status) === 'completed').length;
    const canc = inc.filter((j) => STATUS(j.status) === 'cancelled').length, fail = inc.filter((j) => STATUS(j.status) === 'failed').length;
    const secs = inc.reduce((t, j) => t + (j.printSeconds || 0), 0), m = inc.reduce((t, j) => t + metres(j), 0);
    const g = inc.reduce((t, j) => t + (gramsUsed(j) || 0), 0);
    const costs = inc.map((j) => R.detail.get(j.id)).filter((d) => d && d.footer && d.footer.totalCost != null);
    const dates = inc.map((j) => j.start).filter(Boolean).sort();
    const printers = [...new Set(inc.map((j) => j.printer))];
    const range = dates.length ? (dayStr(dates[0]) === dayStr(dates[dates.length - 1]) ? dayStr(dates[0]) : `${dayStr(dates[0])} – ${dayStr(dates[dates.length - 1])}`) : '';
    const big = m > 0 ? compare(m, BIG && m >= BIG[0][0] ? BIG : undefined) : '';

    const head = `<header class="rhead">
        <div><h1>${esc(title)}</h1><div class="muted">${esc(range)}${printers.length ? ` · ${esc(printers.join(', '))}` : ''}</div></div>
        <div class="muted small right">Made ${esc(dtStr(new Date().toISOString()))}<br>AI 3D Print Advisor Studio</div></header>
      <section class="kpis">
        <div class="kpi"><b>${inc.length}</b><span>print${inc.length === 1 ? '' : 's'}${inc.length ? ` · ${done} completed${canc ? `, ${canc} cancelled` : ''}${fail ? `, ${fail} failed` : ''}` : ''}</span></div>
        <div class="kpi"><b>${esc(hm(secs))}</b><span>printing time${inc.some(live) ? ` · ${inc.filter(live).length} still printing (not counted yet)` : ''}</span></div>
        <div class="kpi"><b>${m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m.toFixed(1) + ' m'}</b><span>of filament${g ? ` · ≈ ${esc(kg(g))}` : ''}</span></div>
        ${costs.length ? `<div class="kpi"><b>$${costs.reduce((t, d) => t + d.footer.totalCost, 0).toFixed(2)}</b><span>filament cost (slicer’s prices${costs.length < inc.length ? `, ${costs.length} of ${inc.length} prints` : ''})</span></div>` : ''}
      </section>
      ${big ? `<div class="bigcmp">${ruler}<div><b>All that filament laid end to end:</b> ${esc(big)}</div></div>` : ''}`;

    const rows = list.map((j) => {
      const off = R.excluded.has(j.id), st = STATUS(j.status), gu = gramsUsed(j);
      return `<tr class="${off ? 'off' : ''}" data-id="${esc(j.id)}">
        <td class="noprint"><input type="checkbox" data-inc="${esc(j.id)}" ${off ? '' : 'checked'} aria-label="Include ${esc(nameOf(j))}"></td>
        <td class="tcell">${thumbHtml(j)}</td>
        <td><div class="nm">${esc(nameOf(j))}</div><div class="muted small">${esc(j.printer)} · ${esc(dtStr(j.start))}</div>
          <div class="cmp">${ruler}${esc(cmpText(j))}</div></td>
        <td><span class="st ${st}">${STATUS_LABEL[st]}</span>${j.rating ? `<div class="muted small">Rated: ${esc({ good: 'Good', issues: 'Had issues', failed: 'Failed' }[j.rating.rating] || '')}</div>` : ''}</td>
        <td class="num">${live(j) ? 'in progress' : esc(hm(j.printSeconds))}${j.estimatedSeconds ? `<div class="muted small">planned ${esc(hm(j.estimatedSeconds))}</div>` : ''}</td>
        <td class="num">${live(j) ? (plannedM(j) ? `<span class="muted">planned</span><br>${plannedM(j).toFixed(2)} m${plannedG(j) ? `<div class="muted small">≈ ${esc(kg(plannedG(j)))}</div>` : ''}` : '—')
          : `${metres(j).toFixed(2)} m${gu ? `<div class="muted small">≈ ${esc(kg(gu))}</div>` : ''}`}</td>
        <td><div class="sws">${swatches(j)}</div><div class="muted small">${esc(materials(j))}${j.layerHeight ? ` · ${esc(j.layerHeight)} mm layers` : ''}</div></td>
      </tr>`;
    }).join('');
    const table = `<table class="jobs"><thead><tr><th class="noprint"></th><th></th><th>Print</th><th>Status</th><th class="num">Print time</th><th class="num">Filament</th><th>Material</th></tr></thead><tbody>${rows}</tbody></table>`;

    const details = mode() === 'detail' ? inc.map(detailHtml).join('') : '';
    $('report').innerHTML = head + table + details;
  }

  function detailHtml(j) {
    const d = R.detail.get(j.id);
    const gu = gramsUsed(j);
    const facts = [
      ['Printer', j.printer], ['Started', dtStr(j.start)], ['Finished', j.end && STATUS(j.status) !== 'printing' ? dtStr(j.end) : ''],
      ['Status', STATUS_LABEL[STATUS(j.status)]], ['Print time', `${live(j) ? 'in progress' : hm(j.printSeconds)}${j.estimatedSeconds ? ` (planned ${hm(j.estimatedSeconds)})` : ''}`],
      ['Total time', j.totalSeconds && j.totalSeconds - j.printSeconds > 120 ? `${hm(j.totalSeconds)} including heating and pauses` : ''],
      ['Filament', live(j) ? (plannedM(j) ? `planned ${plannedM(j).toFixed(2)} m${plannedG(j) ? ` · ≈ ${kg(plannedG(j))}` : ''}` : '') : `${metres(j).toFixed(2)} m${gu ? ` · ≈ ${kg(gu)}` : ''}`], ['Height', j.objectHeight ? `${j.objectHeight} mm` : ''],
      ['Layers', j.layers || (d && d.footer && d.footer.layers) || ''], ['Slicer', j.slicer || ''],
      ['File', j.filename],
    ].filter(([, v]) => v !== '' && v != null);
    let body;
    if (!d) body = `<p class="muted">${R.busy ? 'Reading this print’s settings…' : 'Settings not read yet.'}</p>`;
    else if (d.error) body = `<p class="warn">Settings not available: ${esc(d.error)}</p>`;
    else {
      const p = d.profiles, f = d.footer || {};
      const fil = (j.filaments || []).map((x) => {
        const prof = (p.filaments || []).find((y) => y.i === x.i);
        const cost = f.cost && f.cost[x.i] != null ? `$${f.cost[x.i].toFixed(2)}` : '';
        return `<tr><td><span class="sw" style="background:${esc(x.color || '#ccc')}"></span> Filament ${x.i + 1}</td><td>${esc(x.type)}</td><td>${esc(prof && prof.name || x.name || '')}</td>
          <td class="num">${x.grams != null ? `${x.grams.toFixed(1)} g` : ''}</td><td class="num">${x.mm != null ? `${(x.mm / 1000).toFixed(2)} m` : ''}</td><td class="num">${cost}</td></tr>`;
      }).join('');
      const prof = [['Process profile', p.process], ['Printer profile', p.printer], ['Nozzle', p.nozzle ? `${p.nozzle} mm` : ''], ['Build plate', p.plate], ['Print order', p.sequence],
        ['Toolhead changes', f.changes != null && (j.filaments || []).length > 1 ? f.changes : '']].filter(([, v]) => v !== '' && v != null);
      const advisor = d.sections.some((s) => s.items.some((i) => i.advisor));
      body = `<div class="kv">${prof.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
        ${fil ? `<h4>Filament used</h4><table class="mini"><thead><tr><th></th><th>Type</th><th>Profile</th><th class="num">Weight</th><th class="num">Length</th><th class="num">Cost</th></tr></thead><tbody>${fil}</tbody>
          ${f.totalCost != null ? `<tfoot><tr><td colspan="3">Total (slicer’s planned amounts and prices)</td><td class="num">${f.totalG != null ? `${f.totalG.toFixed(1)} g` : ''}</td><td></td><td class="num">$${f.totalCost.toFixed(2)}</td></tr></tfoot>` : ''}</table>` : ''}
        <div class="secs">${d.sections.map((s) => `<section class="sec"><h4>${esc(s.title)}</h4><p class="muted small">${esc(s.blurb)}</p>
          <dl>${s.items.map((i) => `<dt>${esc(i.label)}</dt><dd>${esc(i.value)}${i.advisor ? ' <span class="adv" title="Set by AI 3D Print Advisor">advisor</span>' : ''}</dd>`).join('')}</dl></section>`).join('')}</div>
        <p class="muted small">Settings for the whole plate, as saved in the G-code. Changes made to single objects in Orca aren’t listed separately.${advisor ? ' “advisor” marks settings AI 3D Print Advisor changed.' : ''}</p>`;
    }
    return `<article class="detail">
      <header>${thumbHtml(j, 'big')}<div class="grow"><h2>${esc(nameOf(j))}</h2>
        <div class="cmp">${ruler}${esc(cmpText(j))}</div>
        <div class="kv">${facts.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div></div></header>
      ${body}</article>`;
  }

  // ---------- loading
  async function pool(items, n, fn) {
    let k = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (k < items.length) await fn(items[k++]); }));
  }
  let thumbRun = 0;
  async function loadThumbs() {
    const run = ++thumbRun;
    const todo = included().filter((j) => j.thumb && !R.thumbs.has(j.id)).slice(0, 400);
    let pending = 0;
    await pool(todo, 4, async (j) => {
      if (run !== thumbRun) return;
      const t = await api.reportThumb(j.id).catch(() => null);
      R.thumbs.set(j.id, t);
      if (t && ++pending >= 6) { pending = 0; render(); }
    });
    if (run === thumbRun) render();
  }
  async function loadDetails() {
    const todo = included().filter((j) => !R.detail.has(j.id));
    if (!todo.length || R.busy) return;
    R.busy = true; let n = 0;
    status(`Reading settings from the G-code of ${todo.length} print${todo.length === 1 ? '' : 's'}…`);
    render();
    await pool(todo, 3, async (j) => {
      try { R.detail.set(j.id, await api.reportDetail(j.id)); } catch (e) { R.detail.set(j.id, { error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }); }
      n++; status(`Reading settings… ${n} of ${todo.length}`);
      if (n % 3 === 0) render();
    });
    R.busy = false; status('');
    render();
  }
  async function load() {
    R.loading = true; render(); status('Reading print history from your printers…');
    try {
      const h = await api.reportJobs(Number($('depth').value));
      R.jobs = h.jobs || []; R.errors = h.errors || [];
      if (!h.configured) R.errors = ['Add your printers’ addresses in Settings (main window) to see their print history.'];
      const sel = $('printer'), cur = saved.printer || sel.value;
      sel.innerHTML = '<option value="">All printers</option>' + [...new Set(R.jobs.map((j) => j.printer))].map((p) => `<option ${p === cur ? 'selected' : ''}>${esc(p)}</option>`).join('');
      status(R.errors.length && R.jobs.length ? `Some printers didn’t answer: ${R.errors.join(' · ')}` : '');
    } catch (e) { R.errors = [String(e.message || e)]; status(''); }
    R.loading = false; render(); loadThumbs();
    if (mode() === 'detail') loadDetails();
  }
  const status = (t) => { $('status').textContent = t; };

  // ---------- controls
  if (saved.title) $('title').value = saved.title;
  if (saved.mode) { const r = document.querySelector(`[name=mode][value=${saved.mode}]`); if (r) r.checked = true; }
  if (saved.depth) $('depth').value = saved.depth;
  for (const c of document.querySelectorAll('[data-st]')) c.checked = !(saved.st || []).includes(c.dataset.st);
  if (saved.q) $('q').value = saved.q;
  if (saved.from) $('from').value = saved.from;
  if (saved.to) $('to').value = saved.to;

  const changed = () => { persist(); render(); loadThumbs(); if (mode() === 'detail') loadDetails(); };
  for (const id of ['from', 'to', 'printer']) $(id).addEventListener('change', changed);
  $('q').addEventListener('input', changed);
  $('title').addEventListener('input', () => { persist(); render(); });
  document.querySelectorAll('[data-st], [name=mode]').forEach((el) => el.addEventListener('change', changed));
  $('depth').addEventListener('change', () => { persist(); load(); });
  $('report').addEventListener('change', (e) => {
    const c = e.target.closest('[data-inc]'); if (!c) return;
    if (c.checked) R.excluded.delete(c.dataset.inc); else R.excluded.add(c.dataset.inc);
    changed();
  });
  $('allOn').onclick = () => { shown().forEach((j) => R.excluded.delete(j.id)); changed(); };
  $('allOff').onclick = () => { shown().forEach((j) => R.excluded.add(j.id)); changed(); };
  const ready = async () => {
    if (mode() === 'detail' && R.busy) { status('Still reading settings, one moment…'); while (R.busy) await new Promise((r) => setTimeout(r, 300)); }
    await loadThumbs();
  };
  $('printBtn').onclick = async () => { await ready(); const r = await api.reportPrint(); if (r && r !== true) status(`Not printed: ${r}`); };
  $('pdfBtn').onclick = async () => {
    await ready();
    try { const f = await api.reportPdf({ name: $('title').value.trim() || 'Print report' }); if (f) status(`Saved ${f}`); }
    catch (e) { status(`Couldn’t save the PDF: ${e.message || e}`); }
  };
  load();
})();
