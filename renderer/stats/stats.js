// Print stats window (Print history → 📊 Print stats…): how often prints succeed, the filament they used and
// wasted (and what that cost), each printer's cancel/fail rate, a start-to-finish timeline of every print, and
// each printer's prints over time. Read-only: it only reads each printer's print history.
(() => {
  const api = window.advisor;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY = 864e5;

  // Moonraker's statuses → four groups. "Failed" is anything that stopped on its own (error, interrupted, shutdown…).
  const ST = (s) => (s === 'completed' || s === 'cancelled' ? s : s === 'in_progress' ? 'printing' : 'failed');
  const LABEL = { completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed', printing: 'Printing now' };
  const ENDED = ['completed', 'cancelled', 'failed'];

  const S = { jobs: [], errors: [], loading: false };
  const tips = [];   // tooltip HTML, by data-tip index

  try { const p = Number(localStorage.getItem('aipa.stats.price')); if (p > 0) $('price').value = p; } catch {}
  try { const u = localStorage.getItem('aipa.stats.units'); if (u === 'metric' || u === 'imperial') $('units').value = u; } catch {}
  try { const r = localStorage.getItem('aipa.stats.range'); if (r !== null && [...$('range').options].some(o => o.value === r)) $('range').value = r; } catch {}

  const name = (j) => String(j.filename || '').split(/[\\/]/).pop().replace(/\.gcode$/i, '');
  const startOf = (j) => (j.start ? Date.parse(j.start) : NaN);
  const endOf = (j) => {
    if (j.end) return Date.parse(j.end);
    const s = startOf(j);
    if (ST(j.status) === 'printing') return Math.max(s, Date.now());
    return s + 1000 * (j.totalSeconds || j.printSeconds || 0);
  };
  // filament a print really used: Moonraker's measured length; grams from the slicer's own weight per mm when it
  // has one (it knows each filament's density), else 1.75 mm PLA (about 2.98 g per meter)
  const metersOf = (j) => (j.filamentMm || 0) / 1000;
  function gramsOf(j) {
    const mm = j.filamentMm || 0; if (!mm) return 0;
    const planMm = (j.filaments || []).reduce((t, f) => t + (f.mm || 0), 0), planG = Number(j.grams) || 0;
    return planMm > 0 && planG > 0 ? (planG * mm) / planMm : (mm / 1000) * 2.98;
  }
  const price = () => { const p = Number($('price').value); return p > 0 ? p : 15; };
  const money = (usd) => (usd >= 100 ? `$${Math.round(usd).toLocaleString()}` : `$${usd.toFixed(2)}`);
  // lengths and weights in the units picked at the top (metric: m, km, g, kg; imperial: ft, mi, oz, lb)
  const imperial = () => $('units').value === 'imperial';
  const meters = (m) => {
    if (imperial()) { const ft = m * 3.28084; return ft >= 5280 ? `${(ft / 5280).toFixed(2)} mi` : `${Math.round(ft).toLocaleString()} ft`; }
    return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m >= 100 ? Math.round(m) : m.toFixed(1)} m`;
  };
  const weight = (g) => {
    if (imperial()) { const oz = g / 28.3495; return oz >= 16 ? `${(oz / 16).toFixed(2)} lb` : `${oz.toFixed(1)} oz`; }
    return g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${Math.round(g)} g`;
  };
  const spoolName = () => (imperial() ? '1 kg (2.2 lb) spool' : '1 kg spool');
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');
  const hm = (s) => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
  // printing time in hours and minutes: "2 hours 31 minutes", "1,239 hours 5 minutes", "45 minutes"
  const hours = (s) => {
    const all = Math.round((s || 0) / 60), h = Math.floor(all / 60), m = all % 60;
    const unit = (n, one) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;
    return h ? `${unit(h, 'hour')}${m ? ` ${unit(m, 'minute')}` : ''}` : unit(m, 'minute');
  };
  // the same, for a big number in a tile: the words smaller than the numbers
  const hoursBig = (s) => esc(hours(s)).replace(/ (hours?|minutes?)/g, '<small> $1</small>');
  const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  function inRange() {
    const days = Number($('range').value);
    const from = days ? Date.now() - days * DAY : -Infinity;
    return S.jobs.filter((j) => Number.isFinite(startOf(j)) && endOf(j) >= from);
  }
  function tally(list) {
    const t = { completed: 0, cancelled: 0, failed: 0, printing: 0, m: 0, g: 0, wm: 0, wg: 0, okS: 0, wS: 0 };
    for (const j of list) {
      const st = ST(j.status); t[st]++;
      const m = metersOf(j), g = gramsOf(j);
      t.m += m; t.g += g;
      if (st === 'cancelled' || st === 'failed') { t.wm += m; t.wg += g; t.wS += j.printSeconds || 0; }
      if (st === 'completed') t.okS += j.printSeconds || 0;
    }
    t.ended = t.completed + t.cancelled + t.failed;
    return t;
  }
  const splitBar = (t) => `<div class="split" aria-hidden="true">${ENDED.filter(k => t[k]).map(k => `<span class="c-${k}" style="flex:${t[k]}"></span>`).join('')}</div>`;

  // ---------- totals ----------
  function renderKpis(list) {
    const t = tally(list), cost = (t.wg / 1000) * price();
    $('kpis').innerHTML = !t.ended && !t.printing ? '' : `
      <div class="kpi wide"><div class="v">${pct(t.completed, t.ended)}</div><div class="l">of finished prints <b>completed</b> (${t.completed.toLocaleString()} of ${t.ended.toLocaleString()})</div>
        ${splitBar(t)}
        <div class="keys">${ENDED.map(k => `<span><i class="c-${k}"></i>${LABEL[k]} ${pct(t[k], t.ended)} (${t[k]})</span>`).join('')}${t.printing ? `<span><i class="c-printing"></i>Printing now ${t.printing}</span>` : ''}</div></div>
      <div class="kpi"><div class="v">${pct(t.cancelled + t.failed, t.ended)}</div><div class="l">cancelled or failed (${t.cancelled} cancelled, ${t.failed} failed)</div></div>
      <div class="kpi"><div class="v">${hoursBig(t.okS)}</div><div class="l">of <b>successful</b> printing (completed prints)</div></div>
      <div class="kpi"><div class="v">${hoursBig(t.wS)}</div><div class="l">of printing <b>wasted</b> on cancelled and failed prints (${pct(t.wS, t.okS + t.wS)} of the time)</div></div>
      <div class="kpi"><div class="v">${meters(t.m)}</div><div class="l">of filament used on all printers (≈ ${weight(t.g)})</div></div>
      <div class="kpi"><div class="v">${meters(t.wm)}</div><div class="l">used on cancelled and failed prints (≈ ${weight(t.wg)}, ${pct(t.wm, t.m)} of all filament)</div></div>
      <div class="kpi"><div class="v">${money(cost)}</div><div class="l">of wasted filament, at ${money(price())} per ${spoolName()}</div></div>`;
  }

  // ---------- each printer ----------
  function renderPrinters(list) {
    const by = new Map();
    for (const j of list) { if (!by.has(j.printer)) by.set(j.printer, []); by.get(j.printer).push(j); }
    const rows = [...by.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((p) => ({ p, t: tally(by.get(p)) }));
    if (!rows.length) { $('printers').innerHTML = '<p class="empty">No prints in this period.</p>'; return; }
    // flag the printer with clearly more problems than the others (at least 5 finished prints, 10 points above the rest)
    const all = tally(list), rate = (t) => (t.ended ? (t.cancelled + t.failed) / t.ended : 0);
    let worst = null;
    if (rows.length > 1) for (const r of rows) {
      const others = { e: all.ended - r.t.ended, bad: all.cancelled + all.failed - r.t.cancelled - r.t.failed };
      if (r.t.ended >= 5 && others.e && rate(r.t) - others.bad / others.e >= 0.1 && (!worst || rate(r.t) > rate(worst.t))) worst = r;
    }
    $('printers').innerHTML = `<div class="tablewrap"><table>
      <thead><tr><th>Printer</th><th class="n">Prints</th><th class="n">Completed</th><th class="n">Cancelled</th><th class="n">Failed</th><th></th><th class="n">Successful time</th><th class="n">Wasted time</th><th class="n">Filament used</th><th class="n">Wasted</th><th class="n">Wasted cost</th></tr></thead>
      <tbody>${rows.map(({ p, t }) => `<tr>
        <td><b>${esc(p)}</b>${worst && worst.p === p ? '<span class="flag">⚠ most cancelled/failed</span>' : ''}${t.printing ? '<div class="muted small">printing now</div>' : ''}</td>
        <td class="n">${t.ended}</td>
        <td class="n">${pct(t.completed, t.ended)}</td>
        <td class="n">${pct(t.cancelled, t.ended)} <span class="muted small">(${t.cancelled})</span></td>
        <td class="n">${pct(t.failed, t.ended)} <span class="muted small">(${t.failed})</span></td>
        <td>${splitBar(t)}</td>
        <td class="n">${hours(t.okS)}</td>
        <td class="n">${hours(t.wS)}</td>
        <td class="n">${meters(t.m)}</td>
        <td class="n">${meters(t.wm)}</td>
        <td class="n">${money((t.wg / 1000) * price())}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // ---------- time axis ----------
  function timeTicks(t0, t1, want) {
    const span = t1 - t0, out = [];
    const dayStep = [1, 2, 7, 14].find((d) => span / (d * DAY) <= want);
    if (dayStep) {
      const d = new Date(t0); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1);
      if (dayStep >= 7) while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
      for (; +d <= t1; d.setDate(d.getDate() + dayStep)) out.push(+d);
      return { ticks: out, fmt: { month: 'short', day: 'numeric' } };
    }
    const mStep = [1, 2, 3, 6, 12].find((m) => span / (m * 30.4 * DAY) <= want) || 12;
    const d = new Date(t0); d.setHours(0, 0, 0, 0); d.setDate(1); d.setMonth(d.getMonth() + 1);
    for (; +d <= t1; d.setMonth(d.getMonth() + 1)) if (d.getMonth() % mStep === 0) out.push(+d);
    return { ticks: out, fmt: { month: 'short', year: '2-digit' } };
  }

  // ---------- every print, start to finish: one lane per printer ----------
  function renderTimeline(list) {
    const el = $('timeline');
    if (!list.length) { el.innerHTML = '<p class="empty">No prints in this period.</p>'; return; }
    const printers = [...new Set(list.map((j) => j.printer))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const days = Number($('range').value);
    const t1 = Math.max(Date.now(), ...list.map(endOf));
    const t0 = days ? Date.now() - days * DAY : Math.min(...list.map(startOf));
    const W = Math.max(480, el.clientWidth), L = 120, R = 10, lane = 30, barH = 18, top = 4, H = top + printers.length * lane + 24;
    const x = (t) => L + ((Math.max(t0, Math.min(t1, t)) - t0) / (t1 - t0 || 1)) * (W - L - R);
    const { ticks, fmt } = timeTicks(t0, t1, Math.max(3, Math.floor((W - L) / 90)));
    let svg = `<svg width="${W}" height="${H}" role="img" aria-label="Timeline of every print by printer, colored by how it ended">`;
    for (const t of ticks) svg += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${H - 22}"/><text x="${x(t)}" y="${H - 6}" text-anchor="middle">${esc(new Date(t).toLocaleDateString(undefined, fmt))}</text>`;
    printers.forEach((p, i) => {
      const y = top + i * lane;
      svg += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y + lane - 0.5}" y2="${y + lane - 0.5}"/><text class="lane-name" x="0" y="${y + lane / 2 + 4}">${esc(p)}</text>`;
      for (const j of list.filter((q) => q.printer === p).sort((a, b) => startOf(a) - startOf(b))) {
        const st = ST(j.status), a = x(startOf(j)), b = x(endOf(j)), w = Math.max(2, b - a), k = tips.length;
        tips.push(`<b>${esc(name(j))}</b><div class="muted">${esc(j.printer)} · ${LABEL[st]}</div>
          <div class="row"><span>Started</span><span>${esc(when(startOf(j)))}</span></div>
          <div class="row"><span>${st === 'printing' ? 'So far' : 'Ended'}</span><span>${esc(st === 'printing' ? hm((Date.now() - startOf(j)) / 1000) : when(endOf(j)))}</span></div>
          ${st !== 'printing' ? `<div class="row"><span>Printing time</span><span>${esc(hm(j.printSeconds))}</span></div>` : ''}
          ${j.filamentMm ? `<div class="row"><span>Filament</span><span>${esc(meters(metersOf(j)))} (≈ ${esc(weight(gramsOf(j)))})</span></div>` : ''}`);
        svg += `<rect class="mark f-${st}" x="${a}" y="${y + (lane - barH) / 2}" width="${w}" height="${barH}" rx="2"/>`;
        svg += `<rect class="hit" data-tip="${k}" x="${a - Math.max(0, (8 - w) / 2)}" y="${y + 2}" width="${Math.max(8, w)}" height="${lane - 4}"/>`;
      }
    });
    el.innerHTML = svg + '</svg>';
  }

  // ---------- each printer's prints over time: stacked columns per day / week / month, same scale for all ----------
  function buckets(t0, t1) {
    const span = t1 - t0, unit = span <= 45 * DAY ? 'day' : span <= 400 * DAY ? 'week' : 'month';
    const first = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); if (unit === 'month') d.setDate(1); return d; };
    const next = (d) => { const n = new Date(d); if (unit === 'day') n.setDate(n.getDate() + 1); else if (unit === 'week') n.setDate(n.getDate() + 7); else n.setMonth(n.getMonth() + 1); return n; };
    const out = [];
    for (let d = first(t0); +d <= t1; d = next(d)) out.push({ a: +d, b: +next(d) });
    const label = (b) => unit === 'month' ? new Date(b.a).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : unit === 'week' ? `Week of ${new Date(b.a).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
        : new Date(b.a).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return { list: out, unit, label };
  }
  function renderPerPrinter(list) {
    const el = $('perPrinter');
    const ended = list.filter((j) => ST(j.status) !== 'printing');
    if (!ended.length) { el.innerHTML = '<p class="empty">No finished prints in this period.</p>'; return null; }
    const days = Number($('range').value);
    const t1 = Date.now(), t0 = days ? t1 - days * DAY : Math.min(...ended.map(endOf));
    const B = buckets(t0, t1);
    const printers = [...new Set(ended.map((j) => j.printer))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    // a print counts in the period it ended in
    const at = (t) => { let lo = 0, hi = B.list.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (B.list[m].a <= t) lo = m; else hi = m - 1; } return lo; };
    const counts = new Map(printers.map((p) => [p, B.list.map(() => ({ completed: 0, cancelled: 0, failed: 0 }))]));
    for (const j of ended) { const e = endOf(j); if (e >= B.list[0].a) counts.get(j.printer)[at(e)][ST(j.status)]++; }
    const max = Math.max(1, ...[...counts.values()].flat().map((c) => c.completed + c.cancelled + c.failed));
    const yTicks = max <= 4 ? [...Array(max + 1).keys()] : [0, Math.round(max / 2), max];
    el.innerHTML = printers.map((p) => `<div><h3>${esc(p)}</h3><div class="pp" data-p="${esc(p)}"></div></div>`).join('');
    for (const p of printers) {
      const box = el.querySelector(`.pp[data-p="${CSS.escape(p)}"]`);
      const W = Math.max(300, box.clientWidth), H = 150, L = 28, R = 4, T = 6, Bm = 20, ph = H - T - Bm;
      const n = B.list.length, slot = (W - L - R) / n, gap = Math.min(4, slot * 0.25), bw = Math.max(1, slot - gap);
      const y = (v) => T + ph - (v / max) * ph;
      let svg = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(p)}: completed, cancelled and failed prints per ${B.unit}">`;
      for (const v of yTicks) svg += `<line class="${v ? 'grid' : 'axis'}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
      const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L) / 70))));
      counts.get(p).forEach((c, i) => {
        const x0 = L + i * slot + gap / 2, k = tips.length, tot = c.completed + c.cancelled + c.failed;
        tips.push(`<b>${esc(p)}</b><div class="muted">${esc(B.label(B.list[i]))}</div>${tot ? ENDED.map((s) => `<div class="row"><span><i class="c-${s}" style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px"></i>${LABEL[s]}</span><span>${c[s]}</span></div>`).join('') : '<div>No prints</div>'}`);
        svg += `<g class="col">`;
        let base = 0;
        for (const s of ENDED) {
          if (!c[s]) continue;
          const yTop = y(base + c[s]), yBot = y(base), h = Math.max(1, yBot - yTop - (base ? 2 : 0));
          svg += `<rect class="mark f-${s}" x="${x0}" y="${yTop}" width="${bw}" height="${h}" rx="${Math.min(2, bw / 2)}"/>`;
          base += c[s];
        }
        svg += `<rect class="hit" data-tip="${k}" x="${L + i * slot}" y="${T}" width="${slot}" height="${ph}"/></g>`;
        if (i % every === 0) svg += `<text x="${x0 + bw / 2}" y="${H - 5}" text-anchor="middle">${esc(new Date(B.list[i].a).toLocaleDateString(undefined, B.unit === 'month' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' }))}</text>`;
      });
      box.innerHTML = svg + '</svg>';
    }
    return B.unit;
  }

  function legend(id, keys) { $(id).innerHTML = keys.map((k) => `<span><i class="c-${k}"></i>${LABEL[k]}</span>`).join(''); }

  function render() {
    tips.length = 0;
    const list = inRange();
    $('perSpool').textContent = `per ${spoolName()}`;
    renderKpis(list); renderPrinters(list); renderTimeline(list); const unit = renderPerPrinter(list);
    legend('legendTime', ['completed', 'cancelled', 'failed', 'printing']);
    legend('legendBars', ENDED);
    if (unit) $('legendBars').insertAdjacentHTML('beforeend', `<span>· one column per ${unit}; a print counts when it ended</span>`);
    const n = list.length;
    $('status').textContent = S.loading ? 'Reading print history from your printers…'
      : S.errors.length ? S.errors.join(' · ') : `${n.toLocaleString()} print${n === 1 ? '' : 's'} in this period`;
  }

  async function load() {
    S.loading = true; render();
    try {
      const h = await api.statsJobs(Number($('depth').value));
      if (!h.configured) { S.jobs = []; S.errors = ['Add your printers’ addresses in Settings (main window) to see their print history.']; }
      else { S.jobs = h.jobs || []; S.errors = h.errors || []; }
    } catch (e) { S.errors = [String(e.message || e)]; }
    S.loading = false; render();
  }

  // tooltips: one box, follows the pointer over any mark with data-tip
  const tip = $('tip');
  document.addEventListener('mousemove', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t || !tips[t.dataset.tip]) { tip.hidden = true; return; }
    tip.innerHTML = tips[t.dataset.tip]; tip.hidden = false;
    const r = tip.getBoundingClientRect(), pad = 14;
    let left = e.clientX + pad, top = e.clientY + pad;
    if (left + r.width > innerWidth - 4) left = e.clientX - r.width - pad;
    if (top + r.height > innerHeight - 4) top = e.clientY - r.height - pad;
    tip.style.left = `${Math.max(4, left)}px`; tip.style.top = `${Math.max(4, top)}px`;
  });
  document.addEventListener('mouseleave', () => { tip.hidden = true; });

  $('range').onchange = () => { try { localStorage.setItem('aipa.stats.range', $('range').value); } catch {} render(); };
  $('price').oninput = () => { try { if (Number($('price').value) > 0) localStorage.setItem('aipa.stats.price', $('price').value); } catch {} render(); };
  $('units').onchange = () => { try { localStorage.setItem('aipa.stats.units', $('units').value); } catch {} render(); };
  $('depth').onchange = load;
  $('refresh').onclick = load;
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  load();
})();
