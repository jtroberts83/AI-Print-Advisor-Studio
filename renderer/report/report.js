// Print report window (Print history → Print report…). A summary of the prints you pick (status, time, filament,
// and how far that filament would stretch, like the Print Monitor), or a detailed report with the settings each
// print used, read from its G-code. Printed with the system dialog or saved as a PDF.
// compare() and jobName() come from ../monitor/derive.js. Also: a certificate for one print (🏅 Certificate…).
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
  const hm = (s) => { const t = Math.round((s || 0) / 60), h = Math.floor(t / 60), m = t % 60; return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`; };
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
  // pictures only as image data: URLs (made by this app), never anything else put into the page
  const safeImg = (u) => typeof u === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(u);
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
    return safeImg(t) ? `<img class="${cls}" src="${esc(t)}" alt="">` : `<span class="${cls} none" aria-hidden="true"></span>`;
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
          <div class="cmp">${ruler}${esc(cmpText(j))}</div>
          ${j.status === 'completed' ? `<button class="btn certbtn noprint" data-cert="${esc(j.id)}" title="A printable certificate for this print, with a photo, To and From">🏅 Certificate…</button>` : ''}</td>
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
    if (R.pendingCert) { const id = R.pendingCert; R.pendingCert = null; certFor(id); }
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

  // =====================================================================================================
  // Certificate: one print's "birth certificate", to give with the model. Landscape Letter, printed or saved as PDF.
  // A photo (from this PC, a phone via the QR code, or the printer camera's 99 % photo), the name you give it,
  // To / From, a message, and its stats. Templates set the wording, colors, fonts and decorations.
  // =====================================================================================================
  const TEMPLATES = {
    fancy: { label: 'Fancy', kicker: 'An official record of an original creation', title: 'Certificate of Creation', intro: 'This is to certify that',
      born: 'was brought into this world, one layer at a time, on', to: 'Presented to', from: 'Created by', seal: ['CERTIFIED', 'ORIGINAL'], ring: 'HANDCRAFTED · 3D PRINTED · ONE OF A KIND · ' },
    professional: { label: 'Professional', kicker: 'Production record', title: 'Certificate of Manufacture', intro: 'This document certifies that the part',
      born: 'was manufactured to specification and completed on', to: 'Prepared for', from: 'Manufactured by', seal: ['QUALITY', 'VERIFIED'], ring: 'ADDITIVE MANUFACTURING · INSPECTED · APPROVED · ' },
    kids: { label: 'Kids’ toy', kicker: 'Hooray! A new friend has arrived!', title: 'Official Toy Birth Certificate', intro: 'Say hello to',
      born: 'was born at the 3D printer on', to: 'Best friend', from: 'Made with love by', seal: ['BRAND', 'NEW TOY'], ring: 'PLAY · IMAGINE · HAVE FUN · BE KIND · ' },
    christmas: { label: 'Christmas gift', kicker: 'Made in the holiday workshop', title: 'Certificate of Christmas Magic', intro: 'This certifies that',
      born: 'was crafted with holiday cheer and finished on', to: 'To', from: 'From', seal: ['MERRY', 'CHRISTMAS'], ring: 'SEASON’S GREETINGS · JOY · PEACE · LOVE · ' },
    birthday: { label: 'Birthday gift', kicker: 'A one-of-a-kind gift, made just for you', title: 'Happy Birthday!', intro: 'Specially made for your special day:',
      born: 'came to life on', to: 'To', from: 'From', seal: ['HAPPY', 'BIRTHDAY'], ring: 'MAKE A WISH · CELEBRATE · MANY HAPPY RETURNS · ' },
    rainbow: { label: 'Rainbow', kicker: 'Officially 3D printed', title: 'Certificate of Awesomeness', intro: 'Behold!',
      born: 'was printed into existence on', to: 'To', from: 'From', seal: ['100%', 'AWESOME'], ring: 'COLORFUL · CREATIVE · ONE OF A KIND · ' },
  };
  TEMPLATES.kids.letters = ['#ff4d6d', '#fb5607', '#f4a100', '#06b88a', '#118ab2', '#8338ec'];
  TEMPLATES.rainbow.letters = ['#e63946', '#f4a261', '#d4a93a', '#2a9d8f', '#457b9d', '#9b5de5'];
  // each letter its own color (a gradient clipped to the text prints with a box around it)
  const rainbowText = (s, cols) => { let i = 0; return [...s].map((ch) => (ch === ' ' ? ' ' : `<span style="color:${cols[i++ % cols.length]}">${esc(ch)}</span>`)).join(''); };
  // the model's weight as the user weighed it (optional): a bare number is grams, anything else as typed ("1.2 lb")
  function weightText(w) {
    const s = String(w || '').trim();
    if (!s) return '';
    const n = Number(s.replace(',', '.'));
    if (Number.isFinite(n) && n > 0) return n >= 1000 ? `${(n / 1000).toFixed(2)} kg (${(n / 453.6).toFixed(1)} lb)` : `${n} g (${(n / 28.35).toFixed(1)} oz)`;
    return s;
  }
  // width ÷ height of a picture (measured once, then the certificate is drawn again with the frame in that shape)
  const RATIOS = new Map();
  function photoRatio(src) {
    if (RATIOS.has(src)) return RATIOS.get(src);
    RATIOS.set(src, null);
    const im = new Image();
    im.onload = () => { if (im.naturalWidth && im.naturalHeight) { RATIOS.set(src, Math.min(4, Math.max(0.25, im.naturalWidth / im.naturalHeight))); if (C.job) renderCert(); } };
    im.src = src;
    return null;
  }
  // only one of the template names above, never anything else typed or saved
  const tplKey = (k) => (typeof k === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, k) ? k : 'fancy');
  const C = { job: null, fields: {}, photo: null, camera: [], detail: null, openedAt: 0, qr: false, phone: [], saveT: 0 };

  // a stable pseudo-random sequence per print, so decorations don't jump around between renders
  function rng(seed) { let s = 0; for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  const star = (x, y, r, fill, rot = 0) => { let d = ''; for (let i = 0; i < 10; i++) { const a = (Math.PI / 5) * i - Math.PI / 2 + rot, rr = i % 2 ? r * 0.45 : r; d += `${i ? 'L' : 'M'}${(x + rr * Math.cos(a)).toFixed(1)},${(y + rr * Math.sin(a)).toFixed(1)}`; } return `<path d="${d}Z" fill="${fill}"/>`; };
  const flake = (x, y, r, c) => { let d = ''; for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i, ex = x + r * Math.cos(a), ey = y + r * Math.sin(a), mx = x + r * 0.6 * Math.cos(a), my = y + r * 0.6 * Math.sin(a);
    d += `M${x},${y}L${ex.toFixed(1)},${ey.toFixed(1)}`; for (const s of [-0.6, 0.6]) d += `M${mx.toFixed(1)},${my.toFixed(1)}L${(mx + r * 0.3 * Math.cos(a + s)).toFixed(1)},${(my + r * 0.3 * Math.sin(a + s)).toFixed(1)}`; }
    return `<path d="${d}" stroke="${c}" stroke-width="${Math.max(1, r / 8).toFixed(1)}" stroke-linecap="round" fill="none"/>`; };
  const balloon = (x, y, r, c) => `<path d="M${x},${y + r * 1.25} q ${-r * 0.3},${r * 0.9} ${r * 0.1},${r * 1.9}" stroke="#7a7a7a" stroke-width="1.2" fill="none"/><ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 1.2}" fill="${c}"/><path d="M${x - 4},${y + r * 1.2 + 6} l4,-7 l4,7z" fill="${c}"/><ellipse cx="${x - r * 0.35}" cy="${y - r * 0.45}" rx="${r * 0.18}" ry="${r * 0.3}" fill="#fff" opacity=".55"/>`;
  const holly = (x, y, s) => `<g transform="translate(${x},${y}) scale(${s})"><path d="M0,0 q18,-22 40,-6 q-8,6 -4,14 q-12,-2 -16,8 q-6,-10 -20,-16z" fill="#1f7a3a"/><path d="M0,0 q-22,-18 -40,2 q9,4 6,13 q12,-4 17,6 q4,-11 17,-21z" fill="#2e8b47"/><circle cx="-4" cy="4" r="6" fill="#c8102e"/><circle cx="6" cy="6" r="6" fill="#d7263d"/><circle cx="1" cy="-4" r="6" fill="#b30d26"/></g>`;
  // decorations drawn over the frame, in a 1000 × 760 box
  function decoSvg(t, seed) {
    const R = rng(seed), W = 1000, H = 760; let g = '';
    const edges = (n, fn) => { for (let i = 0; i < n; i++) { const side = i % 4; const u = R();
      const [x, y] = side === 0 ? [u * W, 14 + R() * 40] : side === 1 ? [u * W, H - 14 - R() * 40] : side === 2 ? [14 + R() * 34, u * H] : [W - 14 - R() * 34, u * H]; g += fn(x, y); } };
    if (t === 'fancy') {
      const corner = (tx) => `<g transform="${tx}" fill="none" stroke="var(--c-gold)" stroke-width="2.2" stroke-linecap="round"><path d="M30,120 C30,60 60,30 120,30"/><path d="M44,150 C40,80 80,42 150,44"/><path d="M30,120 c10,-30 40,-30 40,0 c0,20 -25,22 -30,8"/><path d="M120,30 c-30,10 -30,40 0,40 c20,0 22,-25 8,-30"/><circle cx="58" cy="58" r="7" fill="var(--c-gold)"/></g>`;
      g = corner('') + corner(`translate(${W},0) scale(-1,1)`) + corner(`translate(0,${H}) scale(1,-1)`) + corner(`translate(${W},${H}) scale(-1,-1)`);
    } else if (t === 'professional') {
      g = `<rect x="0" y="0" width="${W}" height="18" fill="var(--c-1)"/><rect x="0" y="18" width="${W}" height="5" fill="var(--c-2)"/>`;
      for (let i = 0; i < 14; i++) g += `<path d="M${W - 230 + i * 18},${H} L${W},${H - 230 + i * 18}" stroke="var(--c-1)" stroke-opacity=".12" stroke-width="2"/>`;
    } else if (t === 'kids') {
      const cols = ['#ff4d6d', '#ffb703', '#06d6a0', '#118ab2', '#8338ec', '#fb5607'];
      edges(46, (x, y) => (R() < 0.55 ? star(x, y, 9 + R() * 14, cols[Math.floor(R() * cols.length)], R()) : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(4 + R() * 8).toFixed(1)}" fill="${cols[Math.floor(R() * cols.length)]}"/>`));
    } else if (t === 'christmas') {
      edges(34, (x, y) => flake(+x.toFixed(1), +y.toFixed(1), 8 + R() * 12, R() < 0.5 ? '#9cc7e6' : '#c9a227'));
      g += holly(70, 64, 1.3) + holly(W - 70, 64, 1.3) + holly(70, H - 60, 1.3) + holly(W - 70, H - 60, 1.3);
    } else if (t === 'birthday') {
      const cols = ['#ff006e', '#fb5607', '#ffbe0b', '#3a86ff', '#8338ec', '#06d6a0'];
      edges(70, (x, y) => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(5 + R() * 7).toFixed(1)}" height="${(3 + R() * 4).toFixed(1)}" rx="1.5" fill="${cols[Math.floor(R() * cols.length)]}" transform="rotate(${Math.round(R() * 180)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`);
      g += balloon(62, 92, 30, '#ff006e') + balloon(110, 70, 26, '#3a86ff') + balloon(W - 62, 92, 30, '#ffbe0b') + balloon(W - 112, 72, 26, '#8338ec');
    } else {
      const cols = ['#e63946', '#f4a261', '#e9c46a', '#2a9d8f', '#457b9d', '#9b5de5'];
      edges(30, (x, y) => star(x, y, 7 + R() * 11, cols[Math.floor(R() * cols.length)], R()));
    }
    return `<svg class="deco" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${g}</svg>`;
  }
  // the rosette seal, with words around its edge
  function sealSvg(tp, year) {
    const pts = []; for (let i = 0; i < 48; i++) { const a = (Math.PI * 2 * i) / 48, r = i % 2 ? 54 : 60; pts.push(`${(64 + r * Math.cos(a)).toFixed(1)},${(64 + r * Math.sin(a)).toFixed(1)}`); }
    return `<svg class="seal" viewBox="0 0 128 150" aria-hidden="true">
      <path d="M40,100 L28,148 L46,136 L56,150 L64,104Z" fill="var(--c-2)"/><path d="M88,100 L100,148 L82,136 L72,150 L64,104Z" fill="var(--c-2)"/>
      <polygon points="${pts.join(' ')}" fill="var(--c-seal)"/><circle cx="64" cy="64" r="47" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1.5"/>
      <circle cx="64" cy="64" r="34" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1"/>
      <defs><path id="sealRing" d="M64,64 m-40,0 a40,40 0 1,1 80,0 a40,40 0 1,1 -80,0"/></defs>
      <text font-size="7.6" font-weight="700" fill="#fff" letter-spacing="1.2"><textPath href="#sealRing">${esc(tp.ring + tp.ring)}</textPath></text>
      <text x="64" y="58" text-anchor="middle" font-size="${tp.seal[0].length > 7 ? 9 : 11}" font-weight="800" fill="#fff">${esc(tp.seal[0])}</text>
      <text x="64" y="71" text-anchor="middle" font-size="${tp.seal[1].length > 7 ? 9 : 11}" font-weight="800" fill="#fff">${esc(tp.seal[1])}</text>
      <text x="64" y="83" text-anchor="middle" font-size="8" fill="#fff" opacity=".9">${esc(year)}</text></svg>`;
  }

  function certHtml() {
    const j = C.job, f = C.fields, t = tplKey(f.template), tp = TEMPLATES[t];
    const name = (f.name || '').trim() || nameOf(j);
    const d = C.detail && !C.detail.error ? C.detail : null;
    const sec = (id, key) => { const s = d && d.sections.find((x) => x.id === id); const i = s && s.items.find((x) => x.key === key); return i ? i.value : ''; };
    const dateOnly = (iso) => (iso ? new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '');
    const shortDate = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const timeOnly = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
    const done = !live(j) && j.end;
    const gu = gramsUsed(j), m = metres(j) || plannedM(j);
    const colors = (j.filaments || []).filter((x) => x.color);
    const walls = sec('strength', 'wall_loops'), infill = sec('strength', 'sparse_infill_density'), pattern = sec('strength', 'sparse_infill_pattern');
    const stats = [
      ['Creation started', j.start ? `${shortDate(j.start)} · ${timeOnly(j.start)}` : ''],
      ['Creation finished', done ? `${shortDate(j.end)} · ${timeOnly(j.end)}` : live(j) ? 'Still being made…' : ''],
      ['Time in the making', live(j) ? (j.estimatedSeconds ? `about ${hm(j.estimatedSeconds)}` : '') : hm(j.printSeconds)],
      ['Birthplace', j.printer],
      ['Height', j.objectHeight ? `${j.objectHeight} mm (${(j.objectHeight / 25.4).toFixed(1)} in)` : ''],
      ['Weight', weightText(f.weight)],
      ['Layers', j.layers ? Number(j.layers).toLocaleString() : ''],
      ['Layer height', j.layerHeight ? `${j.layerHeight} mm` : sec('quality', 'layer_height')],
      ['Filament', m ? `${m.toFixed(1)} m${(gu || plannedG(j)) ? ` · ${kg(gu || plannedG(j))}` : ''}` : ''],
      ['Material', materials(j)],
      ['Strength', [walls && `${walls} walls`, infill && `${infill} ${String(pattern || '').toLowerCase()} infill`].filter(Boolean).join(' · ')],
    ].filter(([, v]) => v);
    const no = `No. ${(j.start ? j.start.slice(0, 10).replace(/-/g, '') : '0')}-${(rng(j.id)() * 1e6 | 0).toString().padStart(6, '0')}`;
    const photo = [C.photo, R.thumbs.get(j.id)].find(safeImg) || null;
    // the frame takes the picture's own shape (no white bars): its width ÷ height, once the picture is measured
    const ar = photo && photoRatio(photo);
    const year = (j.end || j.start || new Date().toISOString()).slice(0, 4);
    return `<div class="cert t-${esc(t)}">
      ${decoSvg(t, j.id)}
      <div class="paper">
        <header class="chead"><div class="kicker">${esc(tp.kicker)}</div><h1>${tp.letters ? rainbowText(tp.title, tp.letters) : esc(tp.title)}</h1></header>
        <div class="cbody">
          <div class="pcell"><figure class="cphoto ${photo ? '' : 'none'} ${C.photo && C.fields.edit && C.fields.edit.removeBg ? 'cutout' : ''}"${ar ? ` style="--ar:${ar.toFixed(4)}"` : ''}>${photo ? `<img src="${esc(photo)}" alt="" style="object-fit:${C.photo ? 'cover' : 'contain'}">` : '<span>Add a photo</span>'}
            ${colors.length ? `<figcaption>${colors.map((x) => `<span class="sw" style="background:${esc(x.color)}"></span>`).join('')}</figcaption>` : ''}</figure></div>
          <div class="cinfo">
            <div class="intro">${esc(tp.intro)}</div>
            <div class="cname">${esc(name)}</div>
            <div class="born">${esc(tp.born)} <b>${esc(dateOnly(done ? j.end : j.start))}</b></div>
            <dl class="cstats">${stats.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
            ${m ? `<div class="cfun">${ruler}<span>Its filament laid end to end: ${esc(compare(m))}</span></div>` : ''}
            ${f.message ? `<div class="cmsg">“${esc(f.message)}”</div>` : ''}
          </div>
        </div>
        <footer class="cfoot">
          <div class="party"><div class="val">${esc(f.to || '')}</div><div class="lbl">${esc(tp.to)}</div></div>
          ${sealSvg(tp, year)}
          <div class="party"><div class="val">${esc(f.from || '')}</div><div class="lbl">${esc(tp.from)}</div></div>
        </footer>
        <div class="cno">${esc(no)} · ${esc(j.filename)}</div>
      </div></div>`;
  }

  function renderCert() {
    if (!C.job) return;
    $('cert').innerHTML = certHtml();
    const cut = fitText();
    const note = $('cMsgNote'); if (note) note.hidden = !cut;
    fitCert();
  }
  // a long name or message: smaller type until everything fits (the message last, never cut mid-line)
  function fitText() {
    const info = $('cert').querySelector('.cinfo'); if (!info) return;
    const over = () => info.scrollHeight > info.clientHeight + 1;
    const msg = info.querySelector('.cmsg'), name = info.querySelector('.cname');
    for (let pt = 28; name && over() && pt >= 22; pt -= 2) name.style.fontSize = `${pt}pt`;
    for (let pt = 12.5; msg && over() && pt >= 9; pt -= 0.5) msg.style.fontSize = `${pt}pt`;
    // still too long: the message ends with … on the last whole line that fits
    if (msg && over()) {
      const lh = parseFloat(getComputedStyle(msg).lineHeight) || 16;
      const lines = Math.max(1, Math.floor((msg.offsetHeight - (info.scrollHeight - info.clientHeight)) / lh));
      Object.assign(msg.style, { display: '-webkit-box', webkitBoxOrient: 'vertical', webkitLineClamp: String(lines), overflow: 'hidden' });
      return true;
    }
    return false;
  }
  function fitCert() {
    const el = $('cert').querySelector('.cert'); if (!el) return;
    const w = el.offsetWidth, avail = $('cert').clientWidth - 32;
    $('cert').style.setProperty('--z', String(Math.min(1, avail / w)));
  }
  addEventListener('resize', () => { if (C.job) fitCert(); });

  function certControls() {
    const f = C.fields, cur = tplKey(f.template);
    const waiting = C.phone.filter((p) => p.purpose === 'cert' && p.state === 'waiting').slice(0, 6);
    $('certControls').innerHTML = `
      <div class="row"><button class="btn" id="certBack">← Back to the report</button><span class="ctitle">Certificate for <b>${esc(nameOf(C.job))}</b></span>
        <span class="grow"></span><button class="btn" id="certPrint">🖨 Print…</button><button class="btn primary" id="certPdf">Save as PDF…</button></div>
      <div class="row tpls" role="radiogroup" aria-label="Template">${Object.entries(TEMPLATES).map(([k, v]) =>
        `<label class="tpl t-${esc(k)} ${k === cur ? 'on' : ''}"><input type="radio" name="tpl" value="${esc(k)}" ${k === cur ? 'checked' : ''}><span class="dot"></span>${esc(v.label)}</label>`).join('')}</div>
      <div class="row">
        <label class="grow">Name <input id="cName" type="text" maxlength="80" placeholder="${esc(nameOf(C.job))}" value="${esc(f.name || '')}"></label>
        <label class="grow">${esc(TEMPLATES[cur].to)} <input id="cTo" type="text" maxlength="80" value="${esc(f.to || '')}"></label>
        <label class="grow">${esc(TEMPLATES[cur].from)} <input id="cFrom" type="text" maxlength="80" value="${esc(f.from || '')}"></label>
      </div>
      <div class="row"><label class="grow">Message (optional) <input id="cMsg" type="text" maxlength="240" placeholder="e.g. Merry Christmas! Made just for you." value="${esc(f.message || '')}"><small id="cMsgNote" class="warn" hidden>Too long to fit: it ends with “…”. Shorten it or the name.</small></label>
        <label title="Weigh the finished model if you can (a kitchen scale works). Grams if you type just a number. Left empty, it isn’t on the certificate.">Weight (optional) <input id="cWeight" type="text" maxlength="30" size="10" placeholder="e.g. 142" value="${esc(f.weight || '')}"></label></div>
      <div class="row">
        <span class="lbl">Photo</span>
        <label class="btn">🖼 Choose a photo…<input id="cFile" type="file" accept="image/jpeg,image/png,image/webp" hidden></label>
        <button class="btn" id="cPhone">📱 ${C.qr ? 'Hide the QR code' : 'Take one with your phone'}</button>
        ${C.camera.length ? `<button class="btn" id="cCam" title="The Print Monitor’s photo from the printer’s camera, taken at 99 %">📷 Printer camera photo</button>` : ''}
        ${C.photo ? `<button class="btn" id="cTouch" title="Exposure, contrast, colors, sharpening, background removal: preview first, then use it">🎨 Touch up photo</button>` : ''}
        ${C.original ? `<button class="link" id="cUndo">Undo touch up</button>` : ''}
        ${C.photo ? `<button class="link" id="cNoPhoto">Use the slicer picture instead</button>` : ''}
      </div>
      ${ideasHtml()}
      ${waiting.length ? `<div class="row phonewait"><span class="muted small">From your phone (click to use):</span>${waiting.map((p) => `<button class="pw" data-pw="${esc(p.id)}" title="${esc(new Date(p.at).toLocaleString())} · ${esc(p.device)}"><img data-pthumb="${esc(p.id)}" alt="Phone photo"></button>`).join('')}</div>` : ''}
      <div id="cQr" class="qr ${C.qr ? '' : 'hidden'}"></div>
      <div class="status" id="cStatus" role="status" aria-live="polite"></div>`;
    for (const img of $('certControls').querySelectorAll('[data-pthumb]')) api.tsPhotoData(img.dataset.pthumb).then((u) => { if (u) img.src = u; }).catch(() => {});
    if (C.qr) showQr();
  }
  const cstatus = (t) => { const el = $('cStatus'); if (el) el.textContent = t; };

  function saveFields(photo, original) {
    clearTimeout(C.saveT);
    const run = () => api.certSet(C.job.id, C.fields, photo, original).catch((e) => cstatus(`Couldn’t save: ${e.message || e}`));
    if (photo !== undefined || original !== undefined) return run();
    C.saveT = setTimeout(run, 400);
  }
  // a new photo: any touch up belongs to the old one
  async function setPhoto(dataUrl) {
    C.photo = dataUrl; C.original = null; C.fields.edit = null;
    await saveFields(dataUrl, null);
    certControls(); renderCert();
  }
  // 🎨 Touch up: always from the original photo, starting from the last settings
  async function touchUp() {
    if (!C.photo || !window.PhotoEdit) return;
    const certEl = $('cert').querySelector('.cert');
    const paper = certEl ? getComputedStyle(certEl).getPropertyValue('--c-bg').trim() || '#ffffff' : '#ffffff';
    const cutout = api.cutoutRun ? { status: api.cutoutStatus, download: api.cutoutDownload, onProgress: api.onCutoutProgress, run: api.cutoutRun } : null;
    const r = await window.PhotoEdit.open({ src: C.original || C.photo, params: C.fields.edit, paper, cutout });
    if (!r) return;
    if (!C.original) C.original = C.photo;
    C.photo = r.dataUrl; C.fields.edit = r.params;
    await saveFields(C.photo, C.original);
    certControls(); renderCert(); cstatus('✓ Touched up. “Undo touch up” brings the original back.');
  }
  async function undoTouchUp() {
    if (!C.original) return;
    C.photo = C.original; C.original = null; C.fields.edit = null;
    await saveFields(C.photo, null);
    certControls(); renderCert(); cstatus('The original photo is back.');
  }
  // ✨ AI ideas: names and sayings from Claude (kept per print in this window's storage)
  // (names and sayings only: nothing private)
  const IDEAS_SLOT = 'aipa.giftIdeas';
  const ideasStore = () => { try { return JSON.parse(localStorage.getItem(IDEAS_SLOT) || '{}'); } catch { return {}; } };
  function saveIdeas() {
    try {
      const all = ideasStore(); all[C.job.id] = { what: C.ideas.what, names: C.ideas.names, sayings: C.ideas.sayings, spent: C.ideas.spent };
      const ids = Object.keys(all); for (const id of ids.slice(0, Math.max(0, ids.length - 60))) delete all[id];
      localStorage.setItem(IDEAS_SLOT, JSON.stringify(all));
    } catch {}
  }
  async function askIdeas() {
    if (C.ideasBusy) return;
    C.ideasBusy = true; C.ideasErr = ''; certControls();
    let photo = null;
    if (C.photo) {
      try {
        const im = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = C.photo; });
        const k = Math.min(1, 1024 / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement('canvas');
        c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); photo = c.toDataURL('image/jpeg', 0.85);
      } catch {}
    }
    const prev = C.ideas || { names: [], sayings: [] };
    try {
      const r = await api.giftIdeas(C.job.id, { photo, template: tplKey(C.fields.template), to: C.fields.to, from: C.fields.from, avoid: [...prev.names.map((n) => n.name), ...prev.sayings] });
      const seen = new Set(prev.names.map((n) => n.name.toLowerCase()));
      C.ideas = { what: r.what || prev.what, names: [...r.names.filter((n) => !seen.has(n.name.toLowerCase())), ...prev.names].slice(0, 24),
        sayings: [...r.sayings.filter((x) => !prev.sayings.includes(x)), ...prev.sayings].slice(0, 18), spent: (prev.spent || 0) + (r.usd || 0) };
      saveIdeas();
    } catch (e) { C.ideasErr = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
    C.ideasBusy = false; certControls();
  }
  // the list of ideas can be folded away (remembered); new ideas open it again
  const ideasShut = () => { try { return localStorage.getItem('aipa.ideasShut') === '1'; } catch { return false; } };
  const setIdeasShut = (v) => { try { localStorage.setItem('aipa.ideasShut', v ? '1' : '0'); } catch {} };
  function ideasHtml() {
    const ai = C.ai || {}, i = C.ideas;
    const cost = ai.usd != null ? `about ${ai.usd < 0.01 ? '1' : Math.round(ai.usd * 100)}¢` : '';
    const btn = ai.tour ? '' : ai.hasKey
      ? `<button class="btn" id="cIdeas" ${C.ideasBusy ? 'disabled' : ''} title="Claude looks at the model and suggests fun names and short sayings. Uses your API key.">${C.ideasBusy ? '<span class="spin"></span> Thinking up ideas…' : i ? '✨ More ideas' : '✨ AI ideas: fun names and sayings'}</button><span class="muted small">${cost}${cost ? ' each time, with your API key' : ''}</span>`
      : '<span class="muted small">✨ AI name and saying ideas: add your Anthropic API key in Settings (main window) to use them.</span>';
    const shut = !!i && ideasShut();
    const fold = i ? `<button class="btn fold" id="cIdeasFold" aria-expanded="${!shut}" title="${shut ? 'Show' : 'Hide'} the names and sayings">${shut ? `▸ Show ideas (${i.names.length} names, ${i.sayings.length} sayings)` : '▾ Hide ideas'}</button>` : '';
    return `<div class="row ideas">${btn}${fold}${C.ideasErr ? `<span class="warn small">${esc(C.ideasErr)}</span>` : ''}</div>
      ${i && !shut ? `<div class="ideabox">${i.what ? `<div class="muted small">Claude thinks this is ${esc(i.what)}. Click an idea to use it.</div>` : ''}
        <div class="chips"><span class="lbl small">Names</span>${i.names.map((n) => `<button class="chip" data-name="${esc(n.name)}" title="${esc(n.style)}">${esc(n.name)}</button>`).join('')}</div>
        <div class="chips"><span class="lbl small">Sayings</span>${i.sayings.map((x) => `<button class="chip say" data-say="${esc(x)}">${esc(x)}</button>`).join('')}</div>
        ${i.spent ? `<div class="muted small">Spent on ideas for this print: $${i.spent.toFixed(3)}</div>` : ''}</div>` : ''}`;
  }
  // a photo from this PC: made smaller (2400 px on the long side, JPEG), which also drops its location data
  async function shrinkPhoto(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error('That picture can’t be opened (use JPEG, PNG or WebP).')); im.src = url; });
      const sc = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.9);
    } finally { URL.revokeObjectURL(url); }
  }
  async function usePhonePhoto(id) {
    const u = await api.tsPhotoData(id).catch(() => null);
    if (!u) { cstatus('That photo is no longer on the PC.'); return; }
    await api.tsPhotosState([id], 'used').catch(() => {});
    await setPhoto(u);
    cstatus('✓ Photo from your phone added.');
  }
  async function showQr() {
    const box = $('cQr'); if (!box) return;
    let r;
    try { r = await api.tsPhoneLink('cert'); } catch (e) { box.innerHTML = `<p class="warn">${esc(e.message || e)}</p>`; return; }
    if (r.tour) { box.innerHTML = '<p>The tour can’t take photos with a phone.</p>'; return; }
    if (r.off) { box.innerHTML = `<p><b>Phone access is off.</b> Turn it on in the main window: <b>Settings → Phone access</b>. Photos then come straight here over your home Wi-Fi (nothing goes through the internet).${r.error ? ` <span class="warn">${esc(r.error)}</span>` : ''}</p>`; return; }
    if (!window.qrcode) { box.innerHTML = `<p>Open this on your phone: ${esc(r.url)}</p>`; return; }
    const q = window.qrcode(0, 'M'); q.addData(r.url); q.make();
    box.innerHTML = `<img alt="QR code: opens the photo page on your phone" src="${q.createDataURL(5, 2)}"><div><p><b>Scan this with your phone’s camera.</b></p>
      <ol><li>Tap <b>📷 Take a photo</b>, or choose one you already took.</li><li>It appears on the certificate a moment later.</li>${r.paired ? '' : '<li>The first time, the phone asks to pair with this PC (tap <b>Pair this phone</b>).</li>'}</ol>
      <p class="muted small">The phone must be on the same Wi-Fi as this PC. This code works for 15 minutes.</p></div>`;
  }

  async function openCert(jobId) {
    const j = R.jobs.find((x) => x.id === jobId); if (!j) return;
    Object.assign(C, { job: j, fields: {}, photo: null, original: null, camera: [], detail: R.detail.get(j.id) || null, openedAt: Date.now(), qr: false, ideas: ideasStore()[j.id] || null, ideasErr: '', ideasBusy: false });
    try { const g = await api.certGet(j.id); C.fields = g.fields || {}; C.photo = g.photo; C.original = g.original || null; C.camera = g.camera || []; } catch (e) { status(String(e.message || e)); }
    if (!C.ai && api.certAiInfo) C.ai = await api.certAiInfo().catch(() => null);
    try { C.phone = await api.tsPhotosList(); } catch { C.phone = []; }
    document.body.classList.add('cert-mode');
    $('certControls').hidden = false; $('cert').hidden = false;
    document.title = `Certificate · ${(C.fields.name || '').trim() || nameOf(j)}`;
    certControls(); renderCert(); scrollTo(0, 0);
    if (!R.thumbs.has(j.id)) api.reportThumb(j.id).then((t) => { R.thumbs.set(j.id, t); if (C.job === j) renderCert(); }).catch(() => {});
    if (!C.detail) api.reportDetail(j.id).then((d) => { R.detail.set(j.id, d); if (C.job === j) { C.detail = d; renderCert(); } }).catch((e) => { C.detail = { error: e.message }; });
  }
  function closeCert() {
    C.job = null; C.qr = false;
    document.body.classList.remove('cert-mode');
    $('certControls').hidden = true; $('cert').hidden = true; $('cert').innerHTML = '';
    render();
  }
  $('report').addEventListener('click', (e) => { const b = e.target.closest('[data-cert]'); if (b) openCert(b.dataset.cert); });
  $('certControls').addEventListener('input', (e) => {
    const t = e.target, f = C.fields;
    if (t.id === 'cName') f.name = t.value; else if (t.id === 'cTo') f.to = t.value; else if (t.id === 'cFrom') f.from = t.value;
    else if (t.id === 'cMsg') f.message = t.value; else if (t.id === 'cWeight') f.weight = t.value; else return;
    saveFields(); renderCert();
  });
  $('certControls').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.name === 'tpl') { C.fields.template = t.value; saveFields(); certControls(); renderCert(); }
    else if (t.id === 'cFile' && t.files[0]) { try { cstatus('Adding the photo…'); await setPhoto(await shrinkPhoto(t.files[0])); cstatus('✓ Photo added.'); } catch (err) { cstatus(err.message || String(err)); } }
  });
  $('certControls').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'certBack') closeCert();
    else if (b.id === 'cPhone') { C.qr = !C.qr; certControls(); }
    else if (b.id === 'cCam') { const u = await api.certCameraPhoto(C.job.id, C.camera[0].id).catch(() => null); if (u) { await setPhoto(u); cstatus('✓ The printer camera’s photo is on the certificate.'); } else cstatus('That camera photo isn’t on this PC anymore.'); }
    else if (b.id === 'cNoPhoto') { await setPhoto(null); }
    else if (b.id === 'cTouch') touchUp();
    else if (b.id === 'cUndo') undoTouchUp();
    else if (b.id === 'cIdeas') { setIdeasShut(false); askIdeas(); }
    else if (b.id === 'cIdeasFold') { setIdeasShut(!ideasShut()); certControls(); }
    else if (b.dataset.name != null) { C.fields.name = b.dataset.name; $('cName').value = b.dataset.name; saveFields(); renderCert(); }
    else if (b.dataset.say != null) { C.fields.message = b.dataset.say; $('cMsg').value = b.dataset.say; saveFields(); renderCert(); }
    else if (b.dataset.pw) usePhonePhoto(b.dataset.pw);
    else if (b.id === 'certPrint') { const r = await api.reportPrint({ landscape: true }); if (r && r !== true) cstatus(`Not printed: ${r}`); }
    else if (b.id === 'certPdf') {
      const nm = (C.fields.name || '').trim() || nameOf(C.job);
      try { const p = await api.reportPdf({ name: `${nm} - certificate`, landscape: true }); if (p) cstatus(`Saved ${p}`); } catch (err) { cstatus(`Couldn’t save the PDF: ${err.message || err}`); }
    }
  });
  // photos arriving from a phone while this certificate is open: the newest one taken for a certificate goes on it
  if (api.onTsPhotos) api.onTsPhotos((list) => {
    C.phone = list;
    if (!C.job) return;
    const fresh = list.filter((p) => p.purpose === 'cert' && p.state === 'waiting' && p.at >= C.openedAt - 5000).sort((a, b) => b.at - a.at)[0];
    if (fresh) usePhonePhoto(fresh.id); else certControls();
  });

  // Print history → 🏅 Certificate…: straight to that print's certificate (when the window opens, or while it's open)
  function certFor(id) {
    if (!R.jobs.length) { R.pendingCert = id; return; }
    const j = R.jobs.find((x) => x.id === id);
    if (j && j.status !== 'completed') status('Certificates are for finished prints: this one isn’t completed.');
    else if (j) openCert(id);
    else status('That print is further back than the history read here: pick more under History.');
  }
  { const m = /^#cert=(.+)$/.exec(location.hash); if (m) { R.pendingCert = decodeURIComponent(m[1]); history.replaceState(null, '', location.pathname); } }
  if (api.onReportCert) api.onReportCert((id) => certFor(id));
  load();
})();
