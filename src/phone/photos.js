// Photos for the print troubleshooter, taken on a paired phone (Phone access → renderer/phone/snap.html).
// They wait here, in the app's data folder, until the troubleshooter uses them:
//   waiting  on the PC, not in a troubleshooter yet
//   added    in the troubleshooter that's open now
//   sent     sent to Claude with a diagnosis
// Only real JPEG / PNG / WebP pictures of a sane size are kept (a phone's upload is data, not a trusted file). The newest
// 30 are kept, none older than 14 days.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');

const MAX_BYTES = 15 * 1024 * 1024, KEEP = 30, MAX_AGE = 14 * 24 * 3600 * 1000;
const STATES = new Set(['waiting', 'added', 'sent', 'used']);   // used: put on a print's certificate (Print report)
const ID = /^[a-f0-9]{16}$/;

// the picture's real type from its first bytes (never from its name or what the phone says)
function pictureType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16 || buf.length > MAX_BYTES) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

class PhotoInbox extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.items = null;   // newest first: { id, ext, name, device, at, state }
  }
  indexFile() { return path.join(this.dir, 'index.json'); }
  load() {
    if (this.items) return this.items;
    let list = [];
    try { list = JSON.parse(fs.readFileSync(this.indexFile(), 'utf8')); } catch {}
    this.items = (Array.isArray(list) ? list : []).filter(p => p && ID.test(p.id) && MIME[p.ext] && STATES.has(p.state)
      && fs.existsSync(path.join(this.dir, `${p.id}.${p.ext}`)));
    // a troubleshooter open when the app closed isn't open any more
    for (const p of this.items) if (p.state === 'added') p.state = 'waiting';
    this.prune();
    return this.items;
  }
  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.indexFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.items));
    fs.renameSync(tmp, this.indexFile());
    this.emit('change', this.list());
  }
  prune() {
    const now = Date.now();
    const keep = this.items.filter((p, i) => i < KEEP && now - p.at < MAX_AGE);
    for (const p of this.items) if (!keep.includes(p)) fsp.unlink(this.file(p)).catch(() => {});
    const changed = keep.length !== this.items.length;
    this.items = keep;
    return changed;
  }
  file(p) { return path.join(this.dir, `${p.id}.${p.ext}`); }
  // purpose 'cert': taken for a print's certificate, never offered to the troubleshooter
  list() { return this.load().map(({ id, name, device, at, state, purpose }) => ({ id, name, device, at, state, purpose: purpose || 'ts' })); }

  async add({ buf, name, device, purpose }) {
    const ext = pictureType(buf);
    if (!ext) throw Object.assign(new Error('That isn’t a JPEG, PNG or WebP picture (or it’s bigger than 15 MB).'), { status: 400 });
    this.load();
    const p = { id: crypto.randomBytes(8).toString('hex'), ext, at: Date.now(), state: 'waiting',
      name: String(name || 'Phone photo').replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 80) || 'Phone photo',
      device: String(device || 'Phone').slice(0, 40) };
    if (purpose === 'cert') p.purpose = 'cert';
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(this.file(p), buf, { flag: 'wx' });
    this.items.unshift(p);
    this.prune();
    this.save();
    return { id: p.id, name: p.name, device: p.device, at: p.at, state: p.state, purpose: p.purpose || 'ts' };
  }
  async read(id) {
    const p = typeof id === 'string' && this.load().find(x => x.id === id);
    if (!p) return null;
    return { buf: await fsp.readFile(this.file(p)), mime: MIME[p.ext], name: p.name };
  }
  async dataUrl(id) {
    const r = await this.read(id);
    return r ? `data:${r.mime};base64,${r.buf.toString('base64')}` : null;
  }
  setState(ids, state) {
    if (!STATES.has(state)) return this.list();
    const want = new Set(Array.isArray(ids) ? ids : [ids]);
    let changed = false;
    for (const p of this.load()) if (want.has(p.id) && p.state !== state) { p.state = state; changed = true; }
    if (changed) this.save();
    return this.list();
  }
  // the open troubleshooter closed (or another one opened): its photos wait again
  release() {
    return this.setState(this.load().filter(p => p.state === 'added').map(p => p.id), 'waiting');
  }
  async remove(id) {
    const items = this.load(), i = items.findIndex(x => x.id === id);
    if (i < 0) return this.list();
    const [p] = items.splice(i, 1);
    await fsp.unlink(this.file(p)).catch(() => {});
    this.save();
    return this.list();
  }
}

module.exports = { PhotoInbox, pictureType };
