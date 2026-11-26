// One printer in the Print Monitor: its Moonraker connection and camera, and everything Home Assistant used to do for
// it. Ported from U1 Studio (backend/u1studio/printer.py), which ported the Home Assistant package and automations:
//   * print stage (preparing / printing / paused / cooling / ready / waiting / error / cancelled / idle)
//   * time left = Home Assistant's Moonraker "Print ETA" (also Mainsail's): the slicer plan scaled to the real pace
//   * temperature trend per heater (°F per minute), for Heating / Cooling / Holding
//   * thumbnail kept after the print ends (save_thumbnail.yaml)
//   * a photo at 99 %, while the part is still on the bed (final_snapshot.yaml)
//   * G-code previews every few minutes (gcode_preview.yaml)
//   * alerts: started / paused / error / cancelled / finished / bed cooled (print_finished.yaml), and progress
//     emails with a camera photo at 1 / 25 / 50 / 75 % (progress_emails.yaml)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Connection } = require('./moonraker');
const { Camera } = require('./camera');

const ACTIVE = new Set(['printing', 'paused']);
const RATE_WINDOW = { heater_bed: 120000 };
const cToF = (c) => c * 9 / 5 + 32;
const safeName = (s) => (String(s || 'print').replace(/\.gcode$/i, '').split('/').pop().replace(/[^A-Za-z0-9 _.-]+/g, '_').trim().slice(0, 80) || 'print');
const jobTitle = (s) => String(s || '').replace(/\.gcode$/i, '').split('/').pop().replace(/_/g, ' ');
// Only real pictures of a sane size are written to disk (a printer's answers are data, not trusted files)
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pictureOk(buf, kind, max = 8 * 1024 * 1024) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.length > max) return null;
  if (kind === 'png' && buf.subarray(0, 8).equals(PNG_SIG)) return buf;
  if (kind === 'jpg' && buf[0] === 0xff && buf[1] === 0xd8) return buf;
  return null;
}
async function writeNew(file, buf) {   // creates the file, or leaves an existing one alone
  try { await fsp.writeFile(file, buf, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}
const stamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

class PrinterWatch extends EventEmitter {
  // printer: { id, name, url, apiKey, camera: { mode, url, intervalMs, keepalive }, enabled }
  // settings(): { safe_bed_c, snapshot_progress, preview_minutes, units, milestones: [1, 25, 50, 75] }
  // notify(event, { title, message, image, priority, email }): sends an alert (src/monitor/notify.js)
  constructor({ printer, dataDir, settings, notify, previews, log = () => {}, connectionFactory, cameraFactory }) {
    super();
    Object.assign(this, { cfg: printer, id: printer.id, settings, notifyFn: notify, previews, log });
    this.dir = dataDir;
    for (const sub of ['thumbs', 'previews', 'gallery']) fs.mkdirSync(path.join(dataDir, sub, this.id), { recursive: true });
    this.conn = connectionFactory ? connectionFactory(printer) : new Connection({ url: printer.url, apiKey: printer.apiKey });
    const u = new URL(this.conn.base || 'http://invalid');
    const port80Base = u.port && u.port !== '7125' ? u.origin : `${u.protocol}//${u.hostname}`;
    const cam = printer.camera || {};
    this.camera = cameraFactory ? cameraFactory(printer) : new Camera({ port80Base, mode: cam.mode || 'u1', url: cam.url || '', intervalMs: cam.intervalMs || 1000, keepalive: cam.keepalive !== false, apiKey: printer.apiKey });
    this.hist = {}; this.rates = {};
    this.meta = {}; this.totals = {};
    this.previewTs = 0; this.previewRunning = false; this.previewModelKey = '';
    this.persistPath = path.join(dataDir, `state_${this.id}.json`);
    this.stopsPath = path.join(dataDir, `stops_${this.id}.json`);
    this.job = this.loadJob();
    this.thumbFile = this.job.thumb_file || '';
    this.prevState = null;
    this.conn.on('update', (changed) => this.onUpdate(changed));
  }

  start() {
    if (this.cfg.enabled === false) return;
    this.conn.start(); this.camera.start();
    this.ticker = setInterval(() => this.tick(), 1000);
  }
  stop() { clearInterval(this.ticker); this.conn.stop(); this.camera.stop(); }

  // ------------------------------------------------------------ remembered job
  loadJob() {
    const base = { filename: '', started_at: null, ended_at: null, ready_since: null, bed_peak_c: null, snapshot_taken: false, snapshot_file: '', notified: [], thumb_file: '', milestones: [] };
    try { return { ...base, ...JSON.parse(fs.readFileSync(this.persistPath, 'utf8')) }; } catch { return base; }
  }
  // written at once (a few hundred bytes), so an app restart right after an alert never sends it again
  saveJob() { try { fs.writeFileSync(this.persistPath, JSON.stringify(this.job)); } catch (e) { this.log(`print monitor: saving job state: ${e.message}`); } }

  // ------------------------------------------------------------ derived values
  get s() { return this.conn.status; }
  num(obj, key, d = 0) { const v = (this.s[obj] || {})[key]; return typeof v === 'number' && isFinite(v) ? v : d; }
  get state() {
    if (!this.conn.connected) return 'offline';
    if (this.conn.klippyState !== 'ready') return `klippy_${this.conn.klippyState}`;
    return (this.s.print_stats || {}).state || 'standby';
  }
  get progress() { const d = this.num('display_status', 'progress'); return d > 0 ? d : this.num('virtual_sdcard', 'progress'); }
  get bedC() { const v = (this.s.heater_bed || {}).temperature; return typeof v === 'number' ? v : null; }
  get safeBedC() { return Number(this.settings().safe_bed_c) || 40; }
  get stage() {
    const st = this.state;
    const layer = (((this.s.print_stats || {}).info) || {}).current_layer || 0;
    const bed = this.bedC == null ? 999 : this.bedC;
    if (st === 'printing') {
      // printers that don't report layers: "preparing" only while nothing has printed yet
      const noLayers = !((this.s.print_stats || {}).info || {}).total_layer;
      return (noLayers ? this.num('print_stats', 'print_duration') <= 0 : layer <= 0) ? 'preparing' : 'printing';
    }
    if (st === 'paused') return 'paused';
    if (st === 'complete') {
      if (bed > this.safeBedC) return 'cooling';
      const rs = this.job.ready_since;
      return rs && Date.now() / 1000 - rs >= 1800 ? 'waiting' : 'ready';
    }
    if (st === 'error' || st === 'cancelled') return st;
    if (st === 'offline' || st.startsWith('klippy_')) return st;
    return 'idle';
  }
  // How much of the job is done, like Mainsail and Home Assistant's "Print ETA": the average of the printer's
  // progress and filament used ÷ filament the slicer planned.
  jobFraction() {
    const ps = this.s.print_stats || {}, prog = this.progress, parts = [];
    if (Number(this.meta.estimated_time) > 0) parts.push(prog);
    const total = Number(this.meta.filament_total) || 0;
    if (total > 0) parts.push((Number(ps.filament_used) || 0) / total);
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : prog;
  }
  // Time left: seconds printed ÷ job fraction − seconds printed. While heating (before layer 1) that's far too high,
  // so the slicer's estimate is shown until printing starts.
  timeLeft() {
    const ps = this.s.print_stats || {};
    const dur = Number(ps.print_duration) || 0, est = Number(this.meta.estimated_time) || 0;
    const frac = this.jobFraction();
    let eta = null;
    if (ACTIVE.has(this.state) && dur > 0 && frac > 0) eta = frac >= 1 ? 0 : dur / frac - dur;
    const left = this.stage === 'preparing' || eta == null ? (est ? est * (1 - this.progress) : eta) : eta;
    return { slicer: est ? Math.max(0, est - dur) : null, print_eta_left: eta, job_fraction: frac, left,
      eta: left != null && ACTIVE.has(this.state) ? Date.now() / 1000 + left : null };
  }
  trackRates() {
    const now = Date.now();
    for (const [obj, val] of Object.entries(this.s)) {
      if (!(obj.startsWith('extruder') || obj === 'heater_bed')) continue;
      const t = val && val.temperature;
      if (typeof t !== 'number') continue;
      const q = (this.hist[obj] ||= []);
      if (!q.length || now - q[q.length - 1][0] >= 1000) q.push([now, cToF(t)]);
      const win = RATE_WINDOW[obj] || 60000;
      while (q.length && now - q[0][0] > win) q.shift();
      this.rates[obj] = q.length >= 2 && q[q.length - 1][0] - q[0][0] >= 10000
        ? Math.round((q[q.length - 1][1] - q[0][1]) / ((q[q.length - 1][0] - q[0][0]) / 60000) * 100) / 100 : (this.rates[obj] || 0);
    }
  }
  get isU1() { return !!this.s.print_task_config || (this.conn.objects || []).includes('print_task_config'); }

  // ------------------------------------------------------------ what the screens get
  snapshot() {
    const ps = this.s.print_stats || {};
    const mem = this.conn.systemMemory || {};
    let memPct = mem.total && mem.used != null ? Math.round(100 * mem.used / mem.total) : null;
    if (memPct == null && mem.total && mem.available != null) memPct = Math.round(100 * (1 - mem.available / mem.total));
    const thumbV = this.thumbFile ? crypto.createHash('md5').update(this.thumbFile).digest('hex').slice(0, 8) : '';
    return {
      id: this.id, name: this.cfg.name || this.id, host: this.conn.base, enabled: this.cfg.enabled !== false, kind: this.isU1 ? 'u1' : 'klipper',
      connected: this.conn.connected, klippy_state: this.conn.klippyState, error: this.conn.lastError,
      state: this.state, stage: this.stage, progress: this.progress, status: this.s, rates_f_per_min: this.rates,
      job: { filename: this.job.filename, started_at: this.job.started_at, ended_at: this.job.ended_at, ready_since: this.job.ready_since,
        bed_peak_c: this.job.bed_peak_c, snapshot_taken: this.job.snapshot_taken, snapshot_file: this.job.snapshot_file },
      message: ps.message || '', time: this.timeLeft(),
      meta: { estimated_time: this.meta.estimated_time, slicer: this.meta.slicer, layer_height: this.meta.layer_height, object_height: this.meta.object_height,
        filament_total: this.meta.filament_total, filament_weight_total: this.meta.filament_weight_total, first_layer_height: this.meta.first_layer_height },
      totals: this.totals, memory_pct: memPct, thumb: !!this.thumbFile, thumb_v: thumbV,
      preview_v: Math.round(this.previewTs / 1000), camera: this.camera.info(), safe_bed_c: this.safeBedC,
    };
  }

  // ------------------------------------------------------------ events
  onUpdate(changed) {
    this.trackRates();
    if (changed.has('_history') || (changed.has('_connection') && this.conn.connected)) this.refreshTotals();
    this.watchJob().catch(e => this.log(`print monitor ${this.cfg.name}: ${e.message}`));
    this.emit('change');
  }
  tick() {
    this.watchJob().catch(() => {});
    const st = this.stage, mins = Number(this.settings().preview_minutes) || 5;
    if (['printing', 'paused', 'preparing'].includes(st) && Date.now() - this.previewTs > mins * 60000) this.schedulePreview();
    this.emit('change');
  }
  async notify(event, title, message, extra = {}) {
    const image = extra.image ? path.join(this.dir, 'gallery', this.id, extra.image) : null;
    return this.notifyFn(event, { printer: this.id, title, message, imagePath: image, priority: extra.priority, email: extra.email || null }).catch(e => this.log(`print monitor alert: ${e.message}`));
  }
  async watchJob() {
    if (!this.conn.connected || this.conn.klippyState !== 'ready' || !this.s.print_stats) return;
    const st = this.state, prev = this.prevState;
    this.prevState = st;
    const ps = this.s.print_stats || {}, fname = ps.filename || '', job = this.job, name = this.cfg.name || this.id;
    this.camera.forced = ACTIVE.has(st);
    const settings = this.settings();

    // a new job: seen going from idle/complete/cancelled/error into printing (even the same file again); right after
    // start-up (no previous state) only when it isn't the job remembered from before
    const startedLive = prev != null && !ACTIVE.has(prev) && ACTIVE.has(st);
    if (ACTIVE.has(st) && (startedLive || job.filename !== fname || job.ended_at || !job.started_at)) {
      Object.assign(job, { filename: fname, started_at: Date.now() / 1000 - (Number(ps.total_duration) || 0), ended_at: null, ready_since: null,
        snapshot_taken: false, snapshot_file: '', notified: [], milestones: startedLive ? [] : (job.filename === fname ? job.milestones || [] : []) });
      this.saveJob();
      this.loadMetadata(fname);
      this.schedulePreview(true);
      if (startedLive) await this.notify('start', `${name}: print started`, `Printing ${jobTitle(fname)}`);
    }
    if (fname && fname !== this.meta._filename && !this.metaLoading) this.loadMetadata(fname);
    // the layer being printed, kept so a cancel or error can say where it stopped (the printer may clear it afterwards)
    if (st === 'printing') {   // exactly where it is in the file, and the nozzle's height (kept in memory; saved when it stops)
      const pos = Number((this.s.virtual_sdcard || {}).file_position) || 0, gp = (this.s.gcode_move || {}).gcode_position;
      if (pos > 0) this.lastPoint = { file: fname, pos, z: Array.isArray(gp) && Number.isFinite(gp[2]) ? Math.round(gp[2] * 1000) / 1000 : null };
    }
    if (ACTIVE.has(st)) {
      const info = ps.info || {}, cur = Number(info.current_layer) || 0;
      if (cur > 0 && (cur !== job.last_layer || job.layer_file !== fname)) {
        Object.assign(job, { last_layer: cur, total_layer: Number(info.total_layer) || null, layer_file: fname, last_filament: Math.round(Number(ps.filament_used) || 0) });
        this.saveJob();
      }
    }

    // the 99 % photo, while the part is still on the bed
    const threshold = (Number(settings.snapshot_progress) || 99) / 100;
    if (st === 'printing' && this.progress >= threshold && !job.snapshot_taken) {
      job.snapshot_taken = true; this.saveJob();
      this.takeFinalSnapshot(`${Math.round(threshold * 100)}%`).catch(() => {});
    }
    // progress emails (1 / 25 / 50 / 75 %): only when the milestone is crossed now, not caught up after a reconnect
    if (st === 'printing') {
      const pct = this.progress * 100;
      for (const m of settings.milestones || []) {
        if (pct >= m && pct < m + 5 && !(job.milestones || []).includes(m)) {
          (job.milestones ||= []).push(m); this.saveJob();
          this.progressEmail(m).catch(e => this.log(`print monitor progress email: ${e.message}`));
        } else if (pct >= m + 5 && !(job.milestones || []).includes(m)) { (job.milestones ||= []).push(m); }
      }
    }
    // the bed's peak temperature (for the cooling progress bar)
    const bed = this.bedC, safe = this.safeBedC;
    if (bed != null) job.bed_peak_c = Math.round((bed <= safe ? bed : Math.max(bed, job.bed_peak_c || bed)) * 10) / 10;

    if (prev != null && prev !== st) {
      if (st === 'paused') {
        // say who paused it: this app only ever pauses after the user confirms in the Print Monitor
        const ours = this.lastControl && this.lastControl.action === 'pause' && Date.now() - this.lastControl.ts < 120000;
        this.log(`print monitor ${name}: print paused ${ours ? 'by this app (the user confirmed Pause)' : 'by something other than this app (the printer’s screen, another app or Home Assistant, a filament sensor…)'}`);
        await this.notify('paused', `${name}: print paused`, `${jobTitle(fname)}${ours ? '' : ' (not by this app)'}`);
      }
      if ((st === 'error' || st === 'cancelled' || st === 'klippy_shutdown') && ACTIVE.has(prev)) this.recordStop(fname, st);
      if (st === 'error') await this.notify('error', `${name}: printer error`, ps.message || 'The print stopped with an error. Check the printer.', { priority: 'high' });
      else if (st === 'cancelled') await this.notify('cancelled', `${name}: print cancelled`, jobTitle(fname));
      else if (st === 'complete') {
        job.ended_at = Date.now() / 1000; this.saveJob();
        if (!job.snapshot_taken) { job.snapshot_taken = true; await this.takeFinalSnapshot('at completion').catch(() => {}); }
        this.schedulePreview(true);
        this.refreshTotals();
        const fil = (Number(ps.filament_used) || 0) / 1000, layers = (ps.info || {}).total_layer || '?';
        await this.notify('complete', `${name}: print finished`,
          `${jobTitle(fname)} is done. ${layers} layers, ${fil.toFixed(1)} m of filament. Bed cooling to ${this.tempText(safe)}.`, { image: job.snapshot_file });
      }
    }
    if (st === 'complete' && bed != null && bed <= safe && !job.ready_since) {
      job.ready_since = Date.now() / 1000; this.saveJob();
      if (!(job.notified || []).includes('ready')) {
        (job.notified ||= []).push('ready'); this.saveJob();
        await this.notify('ready', `${name}: ready to remove`, `${jobTitle(fname)} has cooled to ${this.tempText(bed)}, safe to remove.`,
          { image: job.snapshot_file, email: this.finishedEmail() });
      }
    }
    if (st !== 'complete' && job.ready_since && !ACTIVE.has(st)) job.ready_since = null;
  }
  // where a cancelled or failed print stopped, for Print history (stops_<id>.json, the last 100)
  recordStop(fname, status) {
    const job = this.job;
    if (!fname || job.layer_file !== fname || !job.last_layer) return;
    const pt = this.lastPoint && this.lastPoint.file === fname ? this.lastPoint : null;
    const rec = { filename: fname, status, layer: job.last_layer, total: job.total_layer || null, filament_mm: job.last_filament || null, at: Math.round(Date.now() / 1000),
      file_position: pt ? pt.pos : null, z: pt ? pt.z : null };
    try {
      const list = this.stops();
      list.unshift(rec);
      fs.writeFileSync(this.stopsPath, JSON.stringify(list.slice(0, 100)));
    } catch (e) { this.log(`print monitor: saving where the print stopped: ${e.message}`); }
  }
  stops() { try { const l = JSON.parse(fs.readFileSync(this.stopsPath, 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; } }
  tempText(c) { return this.settings().units === 'C' ? `${Math.round(c)}°C` : `${Math.round(cToF(c))}°F`; }

  // ------------------------------------------------------------ emails like the Home Assistant automations
  kpis() {
    const ps = this.s.print_stats || {}, info = ps.info || {};
    const rows = [['State', String(this.stage)], ['Progress', `${Math.round(this.progress * 100)} %`],
      ['Layer', info.total_layer ? `${info.current_layer || 0} / ${info.total_layer}` : '—'],
      ['Filament used', `${((Number(ps.filament_used) || 0) / 1000).toFixed(1)} m`]];
    const t = this.timeLeft();
    if (t.left != null) rows.push(['Time left', `${Math.floor(t.left / 3600)} h ${Math.round((t.left % 3600) / 60)} min`]);
    if (t.eta) rows.push(['Estimated completion', new Date(t.eta * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })]);
    if (this.job.started_at) rows.push(['Elapsed', `${Math.floor((Date.now() / 1000 - this.job.started_at) / 3600)} h ${Math.round(((Date.now() / 1000 - this.job.started_at) % 3600) / 60)} min`]);
    if (this.bedC != null) rows.push(['Bed', this.tempText(this.bedC)]);
    const cav = Object.keys(this.s).find(k => k === 'temperature_sensor cavity') || Object.keys(this.s).find(k => k.startsWith('temperature_sensor '));
    if (cav && typeof this.s[cav].temperature === 'number') rows.push(['Enclosure', this.tempText(this.s[cav].temperature)]);
    ['extruder', 'extruder1', 'extruder2', 'extruder3'].forEach((e, i) => {
      const x = this.s[e];
      if (x && typeof x.temperature === 'number') rows.push([`Toolhead ${i + 1}`, `${this.tempText(x.temperature)} · ${Math.round((x.power || 0) * 100)} %`]);
    });
    return rows;
  }
  emailHtml(title, sub, rows, cid) {
    const { esc } = require('./notify');
    return `<div style="font:15px/1.5 Segoe UI,Arial,sans-serif;color:#18232E;max-width:680px">
      <h2 style="margin:0 0 4px">${esc(title)}</h2><p style="margin:0 0 12px;color:#586774">${esc(sub)}</p>
      ${cid ? `<img src="cid:${cid}" style="width:100%;max-width:680px;border-radius:10px;margin-bottom:12px">` : ''}
      <table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) => `<tr><td style="padding:5px 10px;border-bottom:1px solid #e3e7ea;color:#586774">${esc(k)}</td><td style="padding:5px 10px;border-bottom:1px solid #e3e7ea;font-weight:600">${esc(v)}</td></tr>`).join('')}</table>
      <p style="color:#7a8794;font-size:12px;margin-top:14px">From AI 3D Print Advisor Studio’s Print Monitor.</p></div>`;
  }
  async progressEmail(m) {
    const name = this.cfg.name || this.id, fname = (this.s.print_stats || {}).filename || this.job.filename;
    const photo = await this.camera.freshSnapshot().catch(() => null);
    const rows = this.kpis();
    const title = `${name} @ ${m}% - ${jobTitle(fname)}`;
    await this.notifyFn('progress', { printer: this.id, title, message: `${jobTitle(fname)} is ${m}% done.`,
      email: { subject: title, text: rows.map(r => `${r[0]}: ${r[1]}`).join('\n'), html: this.emailHtml(title, `${jobTitle(fname)} is ${m}% done`, rows, photo ? 'cam' : null),
        images: photo ? [{ cid: 'cam', name: 'camera.jpg', data: photo }] : [] } });
  }
  finishedEmail() {
    const name = this.cfg.name || this.id, ps = this.s.print_stats || {}, fname = ps.filename || this.job.filename;
    const { compare } = require('./compare');
    const used = (Number(ps.filament_used) || 0) / 1000;
    const rows = [['Layers', String((ps.info || {}).total_layer || '—')], ['Filament used', `${used.toFixed(1)} m (${compare(used)})`]];
    if (this.job.started_at && this.job.ended_at) { const s = this.job.ended_at - this.job.started_at; rows.push(['Print took', `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`]); }
    if (this.totals.total_jobs) rows.push(['Lifetime', `${Math.round(this.totals.total_jobs)} jobs · ${((this.totals.total_filament_used || 0) / 1000).toFixed(1)} m of filament`]);
    const photo = this.job.snapshot_file ? path.join(this.dir, 'gallery', this.id, this.job.snapshot_file) : null;
    const title = `${name}: ${jobTitle(fname)} is done and ready to remove`;
    return { subject: title, text: rows.map(r => `${r[0]}: ${r[1]}`).join('\n'),
      html: this.emailHtml(title, `The bed has cooled to ${this.tempText(this.bedC == null ? this.safeBedC : this.bedC)}.`, rows, photo && fs.existsSync(photo) ? 'photo' : null),
      images: photo && fs.existsSync(photo) ? [{ cid: 'photo', name: path.basename(photo), file: photo }] : [] };
  }

  // ------------------------------------------------------------ files, thumbnails, totals
  async loadMetadata(fname) {
    if (!fname) return;
    this.metaLoading = true;
    try {
      const meta = await this.conn.call('server.files.metadata', { filename: fname });
      meta._filename = fname;
      this.meta = meta;
      const thumbs = (meta.thumbnails || []).slice().sort((a, b) => (a.width || 0) - (b.width || 0));
      if (thumbs.length) {
        const rel = thumbs[thumbs.length - 1].relative_path;
        const folder = fname.includes('/') ? fname.slice(0, fname.lastIndexOf('/') + 1) : '';
        const key = crypto.createHash('sha1').update(`${fname}|${meta.size}|${meta.modified}`).digest('hex').slice(0, 16);
        const dest = path.join(this.dir, 'thumbs', this.id, `${key}.png`);
        if (!(await fsp.stat(dest).then(() => true, () => false))) {
          const r = await this.conn.fetch(`/server/files/gcodes/${(folder + rel).split('/').map(encodeURIComponent).join('/')}`);
          if (!r.ok) throw new Error(`thumbnail: HTTP ${r.status}`);
          const png = pictureOk(Buffer.from(await r.arrayBuffer()), 'png');
          if (!png) throw new Error('the thumbnail isn’t a PNG picture');
          await writeNew(dest, png);
          const old = (await fsp.readdir(path.dirname(dest))).filter(f => f.endsWith('.png'));
          if (old.length > 20) {
            const st = await Promise.all(old.map(async f => [f, (await fsp.stat(path.join(path.dirname(dest), f))).mtimeMs]));
            for (const [f] of st.sort((a, b) => a[1] - b[1]).slice(0, old.length - 20)) await fsp.unlink(path.join(path.dirname(dest), f)).catch(() => {});
          }
        }
        this.thumbFile = path.basename(dest);
        this.job.thumb_file = this.thumbFile;
        this.saveJob();
      }
    } catch (e) {
      this.log(`print monitor ${this.cfg.name}: details of ${fname}: ${e.message}`);
      this.meta = { _filename: fname };
    } finally { this.metaLoading = false; this.emit('change'); }
  }
  async refreshTotals() {
    try { const r = await this.conn.call('server.history.totals'); this.totals = (r && r.job_totals) || {}; this.emit('change'); } catch { /* older Moonraker */ }
  }
  async listTimelapses() {
    let files;
    try { files = await this.conn.call('server.files.list', { root: 'camera' }); }
    catch { files = await this.conn.call('server.files.list', { root: 'timelapse' }).catch(() => []); this.tlRoot = 'timelapse'; }
    const root = this.tlRoot || 'camera';
    const names = new Set(files.map(f => f.path));
    return files.filter(f => /\.mp4$/i.test(f.path)).map(f => {
      const p = f.path, coverU1 = p.slice(0, -4) + '_cover.jpg', coverJpg = p.slice(0, -4) + '.jpg';
      return { path: p, root, size: f.size, modified: f.modified, title: p.slice(0, -4).split('/').pop().replace(/_(\d{14})$/, '').replace(/_/g, ' '),
        cover: names.has(coverU1) ? coverU1 : names.has(coverJpg) ? coverJpg : null };
    }).sort((a, b) => (b.modified || 0) - (a.modified || 0));
  }

  // ------------------------------------------------------------ photo + previews
  async takeFinalSnapshot(kind) {
    const data = pictureOk(await this.camera.freshSnapshot(), 'jpg', 16 * 1024 * 1024);
    if (!data) { this.log(`print monitor ${this.cfg.name}: no camera picture for the final photo`); return ''; }
    const ps = this.s.print_stats || {};
    const file = `${stamp()}_${safeName(ps.filename || this.job.filename)}.jpg`;
    const folder = path.join(this.dir, 'gallery', this.id);
    await fsp.writeFile(path.join(folder, file), data);
    const meta = { printer: this.id, printer_name: this.cfg.name, file, job: ps.filename || this.job.filename, taken: Date.now() / 1000, kind,
      progress: Math.round(this.progress * 1000) / 10, layers: (ps.info || {}).total_layer, filament_m: Math.round((Number(ps.filament_used) || 0) / 10) / 100,
      print_duration: ps.print_duration, thumb: this.thumbFile };
    await fsp.writeFile(path.join(folder, file.slice(0, -4) + '.json'), JSON.stringify(meta, null, 1));
    this.job.snapshot_file = file; this.saveJob();
    await this.notify('snapshot', `${this.cfg.name || this.id}: final photo`, `Photo taken ${kind} of ${jobTitle(meta.job)}`, { image: file });
    this.emit('change');
    return file;
  }
  schedulePreview(force = false) {
    if (this.previewRunning || !this.previews) return;
    if (!force && Date.now() - this.previewTs < 30000) return;
    this.previewRunning = true; this.previewTs = Date.now();
    this.drawPreview().catch(e => this.log(`print monitor ${this.cfg.name}: preview: ${e.message}`))
      .finally(() => { this.previewRunning = false; this.emit('change'); });
  }
  async drawPreview() {
    const ps = this.s.print_stats || {}, fname = ps.filename || '';
    if (!fname) return;
    const vs = this.s.virtual_sdcard || {}, ptc = this.s.print_task_config || {};
    const key = `${this.conn.base}|${fname}|${this.meta.size}|${this.meta.modified}`;
    const colors = (ptc.filament_color_rgba || []).map(v => (typeof v === 'number' ? v.toString(16).padStart(8, '0') : String(v || '')));
    const want = key + colors.join(',');
    const out = await this.previews.draw({ key, url: `${this.conn.base}/server/files/gcodes/${fname.split('/').map(encodeURIComponent).join('/')}`,
      headers: this.conn.headers(), colors, model: this.previewModelKey !== want,
      st: { state: ps.state, filePosition: vs.file_position || 0, currentLayer: (ps.info || {}).current_layer } });
    const dir = path.join(this.dir, 'previews', this.id);
    // drawn by the app itself (src/monitor/preview.js), checked anyway
    const model = out.model && pictureOk(Buffer.from(out.model), 'png'), progress = pictureOk(Buffer.from(out.progress), 'png');
    if (model) { await fsp.writeFile(path.join(dir, 'model.png'), model); this.previewModelKey = want; }
    if (progress) await fsp.writeFile(path.join(dir, 'progress.png'), progress);
    this.previewTs = Date.now();
  }

  // ------------------------------------------------------------ controls (always behind a confirmation in the window)
  async control(action) {
    const method = { pause: 'printer.print.pause', resume: 'printer.print.resume', cancel: 'printer.print.cancel' }[action];
    if (!method) throw new Error('Unknown action.');
    const allowed = { pause: ['printing'], resume: ['paused'], cancel: ['printing', 'paused'] }[action];
    if (!allowed.includes(this.state)) throw new Error(`Can’t ${action} while the printer is ${this.state}.`);
    this.log(`print monitor ${this.cfg.name}: ${action} requested (confirmed by the user in the Print Monitor)`);
    this.lastControl = { action, ts: Date.now() };
    return this.conn.call(method, undefined, 30000);
  }
}

module.exports = { PrinterWatch, safeName, jobTitle, cToF };
