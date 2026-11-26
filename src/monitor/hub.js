// The Print Monitor: one PrinterWatch per printer in Settings, the alerts, and the requests the monitor pages make.
// The same requests serve the app's own windows (app://bundle/api/monitor/..., see main.js) and paired phones
// (src/phone/server.js): handle() takes a web Request and returns a web Response.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { PrinterWatch } = require('./watch');
const { PreviewWorker } = require('./preview');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.json': 'application/json' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const text = (s, status) => new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
const okName = (s) => typeof s === 'string' && /^[A-Za-z0-9 _.()-]{1,160}$/.test(s) && !s.includes('..');

class MonitorHub extends EventEmitter {
  // getPrinters(): [{ id, name, url, apiKey, camera, enabled }]   getSettings(): the monitor settings
  // notifier: src/monitor/notify.js Notifier
  constructor({ dataDir, getPrinters, getSettings, notifier, log = () => {}, watchFactory }) {
    super();
    Object.assign(this, { dataDir, getPrinters, getSettings, notifier, log, watchFactory });
    this.watches = new Map();
    this.previews = new PreviewWorker();
    this.pending = new Map();   // id -> timer (changes are sent at most once a second per printer)
    this.lastSent = new Map();
    notifier.onItem((item) => this.emit('notify', item));
  }
  settings() {
    const s = this.getSettings() || {};
    const em = (s.notifications || {}).email || {};
    return { units: s.units || 'F', safe_bed_c: Number(s.safe_bed_c) || 40, snapshot_progress: Number(s.snapshot_progress) || 99,
      preview_minutes: Number(s.preview_minutes) || 5, milestones: em.enabled ? (em.milestones || []) : [] };
  }
  async reload() {
    for (const w of this.watches.values()) w.stop();
    this.watches.clear();
    const s = this.getSettings() || {};
    if (s.enabled === false) { this.emit('state'); return; }
    const list = await this.getPrinters();
    for (const p of list) {
      if (!p.url) continue;
      const opts = { printer: p, dataDir: this.dataDir, settings: () => this.settings(), previews: this.previews, log: this.log,
        notify: (event, o) => this.notifier.send({ event, ...o }) };
      const w = this.watchFactory ? this.watchFactory(opts) : new PrinterWatch(opts);
      w.on('change', () => this.changed(p.id));
      this.watches.set(p.id, w);
      w.start();
    }
    this.emit('state');
  }
  // where cancelled or failed prints stopped, as the printers reported it: [{ printer (its name), filename, layer, total, at }]
  stops() { return [...this.watches.values()].flatMap((w) => w.stops().map((r) => ({ ...r, printer: w.cfg.name || w.id }))); }
  stop() { for (const w of this.watches.values()) w.stop(); this.watches.clear(); this.previews.stop(); }
  changed(id) {
    if (this.pending.has(id)) return;
    const wait = Math.max(0, 1000 - (Date.now() - (this.lastSent.get(id) || 0)));
    this.pending.set(id, setTimeout(() => {
      this.pending.delete(id); this.lastSent.set(id, Date.now());
      const w = this.watches.get(id);
      if (w) this.emit('printer', w.snapshot());
    }, wait));
  }
  state() {
    const s = this.getSettings() || {};
    return { printers: [...this.watches.values()].map(w => w.snapshot()), order: [...this.watches.keys()],
      settings: { units: s.units || 'F', snapshot_progress: Number(s.snapshot_progress) || 99, safe_bed_c: Number(s.safe_bed_c) || 40, enabled: s.enabled !== false },
      notifications: this.notifier.history.slice(0, 20) };
  }
  // a short summary for the tray and the main window's bar
  summary() {
    const ps = [...this.watches.values()].map(w => w.snapshot());
    const printing = ps.filter(p => ['printing', 'paused', 'preparing'].includes(p.stage));
    const next = printing.map(p => p.time && p.time.eta).filter(Boolean).sort((a, b) => a - b)[0] || null;
    return { printers: ps.length, printing: printing.length, ready: ps.filter(p => p.stage === 'ready' || p.stage === 'cooling').length,
      errors: ps.filter(p => p.stage === 'error').length, nextDone: next };
  }

  // ------------------------------------------------------------ requests from the monitor pages
  // req: web Request whose path starts with /api/monitor/
  async handle(req) {
    const u = new URL(req.url);
    const parts = u.pathname.replace(/^\/api\/monitor\/?/, '').split('/').map(decodeURIComponent);
    const m = req.method;
    try {
      if (m === 'GET' && parts[0] === 'state') return json(this.state());
      if (parts[0] === 'gallery') return this.gallery(req, parts.slice(1));
      if (m === 'POST' && parts[0] === 'test-notify') {
        const item = await this.notifier.send({ event: 'test', printer: '', title: 'Test from AI 3D Print Advisor Studio', message: 'Print Monitor alerts work.', force: true });
        return json(item);
      }
      if (parts[0] === 'p') {
        const w = this.watches.get(parts[1]);
        if (!w) return text('No such printer.', 404);
        const what = parts[2];
        if (m === 'GET' && what === 'frame') {
          const after = Number(u.searchParams.get('after')) || 0;
          const f = await w.camera.waitFrame(after, 8000);
          if (!f.data) return new Response(null, { status: 204, headers: { 'x-frame-id': String(f.id), 'cache-control': 'no-store' } });
          return new Response(f.data, { headers: { 'content-type': 'image/jpeg', 'x-frame-id': String(f.id), 'cache-control': 'no-store' } });
        }
        if (m === 'GET' && what === 'thumbnail') return this.file(path.join(this.dataDir, 'thumbs', w.id, w.thumbFile || '-'), path.join(this.dataDir, 'thumbs', w.id));
        if (m === 'GET' && what === 'preview' && /^(model|progress)\.png$/.test(parts[3] || '')) return this.file(path.join(this.dataDir, 'previews', w.id, parts[3]), path.join(this.dataDir, 'previews', w.id));
        if (m === 'GET' && what === 'timelapses') return json(await w.listTimelapses());
        if (m === 'GET' && what === 'file') return this.proxyFile(req, w, parts[3], parts.slice(4).join('/'), u.searchParams.has('download'));
        if (m === 'POST' && what === 'control') {
          const b = await req.json().catch(() => ({}));
          if (!b || b.confirm !== true) return text('Confirm first.', 400);
          return json({ ok: true, result: await w.control(String(b.action || '')) });
        }
        if (m === 'POST' && what === 'keepalive') { const ok = await w.camera.sendKeepalive(); return json({ ok, status: w.camera.keepaliveStatus }); }
      }
      return text('Not found.', 404);
    } catch (e) { return json({ error: String(e.message || e).split('\n')[0].slice(0, 300) }, 500); }
  }
  async file(file, root) {
    const norm = path.normalize(file);
    if (!norm.startsWith(path.normalize(root) + path.sep)) return text('Not found.', 404);
    try { return new Response(await fsp.readFile(norm), { headers: { 'content-type': MIME[path.extname(norm).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' } }); }
    catch { return text('Not found.', 404); }
  }
  // timelapse videos and their cover pictures, from the printer, with seeking (Range) passed through
  async proxyFile(req, w, root, rel, download) {
    if (!['camera', 'timelapse'].includes(root) || !rel || rel.split('/').some(s => s === '..' || !s) || !/\.(mp4|jpe?g|png)$/i.test(rel)) return text('Not found.', 404);
    const headers = {};
    const range = req.headers.get('range');
    if (range) headers.Range = range;
    const r = await w.conn.fetch(`/server/files/${root}/${rel.split('/').map(encodeURIComponent).join('/')}`, { headers, timeout: 60000 });
    if (!r.ok && r.status !== 206) return text(`The printer said HTTP ${r.status}.`, r.status === 404 ? 404 : 502);
    const out = { 'content-type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    for (const h of ['content-length', 'content-range']) { const v = r.headers.get(h); if (v) out[h] = v; }
    if (download) out['content-disposition'] = `attachment; filename="${path.basename(rel).replace(/"/g, '')}"`;
    return new Response(r.body, { status: r.status, headers: out });
  }
  async gallery(req, parts) {
    const root = path.join(this.dataDir, 'gallery');
    if (req.method === 'GET' && !parts.length) {
      const items = [];
      for (const pid of await fsp.readdir(root).catch(() => [])) {
        for (const f of await fsp.readdir(path.join(root, pid)).catch(() => [])) {
          if (!f.endsWith('.json')) continue;
          try { items.push({ ...JSON.parse(await fsp.readFile(path.join(root, pid, f), 'utf8')), printer: pid }); } catch {}
        }
      }
      items.sort((a, b) => (b.taken || 0) - (a.taken || 0));
      return json(items.slice(0, 500));
    }
    const [pid, file] = parts;
    if (!okName(pid) || !okName(file) || !/\.jpg$/i.test(file)) return text('Not found.', 404);
    const f = path.join(root, pid, file);
    if (req.method === 'GET') {
      const r = await this.file(f, root);
      if (new URL(req.url).searchParams.has('download') && r.ok) r.headers.set('content-disposition', `attachment; filename="${file}"`);
      return r;
    }
    if (req.method === 'DELETE') {
      await fsp.unlink(f).catch(() => {}); await fsp.unlink(f.slice(0, -4) + '.json').catch(() => {});
      return json({ ok: true });
    }
    return text('Not found.', 404);
  }
}

module.exports = { MonitorHub };
