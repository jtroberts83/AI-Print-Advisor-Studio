// Where a cancelled or failed print stopped: the layer and its height, so the rest of the model can be cut off in the
// slicer and printed on its own. Moonraker's history doesn't keep the layer a print reached, but it keeps how much
// filament was pushed (filament_used, mm), and the G-code says how much each move pushes, so reading the G-code from
// the start until that much filament has gone through gives the layer. Only the part of the file up to that point
// is read (a print cancelled early costs little), and the result is kept, so each print is read once.
// The Print Monitor also writes down the layer the printer reported when it sees a print stop (exact), see watch.js.

// A streaming reader: feed() it text in any pieces, it stops (done = true) once `target` mm of filament is reached.
class StopFinder {
  // targetMm: the filament the print used; or untilLayer: the layer it stopped on (known from the Print Monitor),
  // then the file is read only to learn that layer's height
  // untilByte: the printer's position in the file when it stopped (exact): read to there
  constructor(targetMm, untilLayer = 0, untilByte = 0) {
    this.untilByte = Math.max(0, Number(untilByte) || 0); this.pos = 0;
    this.target = Math.max(0, Number(targetMm) || 0);
    this.until = Math.max(0, Math.floor(Number(untilLayer) || 0));
    this.rel = false;        // M83 (relative E) or M82 (absolute)
    this.lastE = 0;          // absolute mode: the E position
    this.used = 0;           // net filament pushed so far, mm (retractions count back, like Klipper's filament_used)
    this.layer = 0; this.total = 0;
    this.z = null;           // the height of the layer being printed (top of it), from ;Z:
    this.zs = [];            // zs[n] = the height of layer n (1-based), as far as read
    this.heights = [];       // heights[n] = layer n's thickness, from ;HEIGHT:
    this.rest = '';
    this.done = false; this.bytes = 0;
  }
  line(s) {
    const c = s.charCodeAt(0);
    if (c === 59) {   // ';'
      if (s.startsWith(';Z:')) { const z = parseFloat(s.slice(3)); if (Number.isFinite(z)) this.z = z; }
      else if (s.startsWith(';HEIGHT:')) { const h = parseFloat(s.slice(8)); if (Number.isFinite(h) && this.layer >= 0) this.pendingH = h; }
      return;
    }
    if (c === 71 && (s[1] === '0' || s[1] === '1' || s[1] === '2' || s[1] === '3') && (s[2] === ' ' || s[2] === undefined)) {   // G0-G3
      const i = s.indexOf(' E'); if (i < 0) return;
      const e = parseFloat(s.slice(i + 2)); if (!Number.isFinite(e)) return;
      if (this.rel) this.used += e; else { this.used += e - this.lastE; this.lastE = e; }
      if (!this.until && this.target > 0 && this.used >= this.target && this.layer > 0) this.done = true;
      return;
    }
    if (s.startsWith('SET_PRINT_STATS_INFO')) {
      const t = /TOTAL_LAYER=(\d+)/.exec(s), l = /CURRENT_LAYER=(\d+)/.exec(s);
      if (t) this.total = +t[1];
      if (l) {
        if (this.until && +l[1] > this.until) { this.done = true; return; }
        this.layer = +l[1];
        if (this.layer > 0) { if (this.z != null) this.zs[this.layer] = this.z; if (this.pendingH != null) this.heights[this.layer] = this.pendingH; }
      }
      return;
    }
    if (s.startsWith('M83')) this.rel = true;
    else if (s.startsWith('M82')) this.rel = false;
    else if (s.startsWith('G92')) { const m = /E(-?[\d.]+)/.exec(s); if (m) this.lastE = parseFloat(m[1]); }
  }
  feed(text) {
    if (this.done) return true;
    this.bytes += text.length;
    const lines = (this.rest + text).split('\n');
    this.rest = lines.pop();
    for (const l of lines) {
      if (this.untilByte && this.pos >= this.untilByte) { this.done = true; return true; }
      this.pos += Buffer.byteLength(l, 'utf8') + 1;
      this.line(l.trim()); if (this.done) return true;
    }
    return false;
  }
  // { layer, total, z (top of the layer it stopped on), doneZ (top of the last whole layer), layerHeight }
  result() {
    const layer = this.layer, z = this.zs[layer] ?? this.z;
    const doneZ = layer > 1 ? (this.zs[layer - 1] ?? null) : 0;
    return { layer, total: this.total || null, z: z ?? null, doneZ, layerHeight: this.heights[layer] ?? null, usedMm: Math.round(this.used), reachedTarget: this.done };
  }
}

// Read a G-code on the printer from the start (GET /server/files/gcodes/<path>, read-only) until the filament runs
// out. fetchImpl(url, { headers, signal }) is the web fetch; returns StopFinder.result() or throws.
// size: the file's size when it was printed (Moonraker's history keeps it): a file since replaced under the same
// name (re-sliced) is a different print, so it isn't read
async function findStop({ url, apiKey, filamentMm, untilLayer = 0, untilByte = 0, size = null, fetchImpl = fetch, timeoutMs = 600000 }) {
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeoutMs);
  const f = untilByte ? new StopFinder(0, 0, untilByte) : new StopFinder(filamentMm, untilLayer);
  try {
    const headers = apiKey ? { 'X-Api-Key': apiKey } : {};
    const gone = () => Object.assign(new Error('That G-code is no longer on the printer.'), { code: 'gone' });
    if (size) {   // the file's size now (Moonraker's metadata; a download may come compressed, without one)
      const m = /^(.*)\/server\/files\/gcodes\/(.+)$/.exec(url);
      if (m) {
        const r = await fetchImpl(`${m[1]}/server/files/metadata?filename=${encodeURIComponent(decodeURIComponent(m[2]))}`, { headers, signal: ctrl.signal });
        if (r.status === 404) throw gone();
        const now = r.ok ? Number((((await r.json()) || {}).result || {}).size) : 0;
        if (now && now !== Number(size)) throw Object.assign(new Error('The G-code on the printer has been replaced since this print (same name, different file).'), { code: 'changed' });
      }
    }
    const res = await fetchImpl(url, { headers, signal: ctrl.signal });
    if (res.status === 404) throw gone();
    if (!res.ok) throw new Error(`The printer answered HTTP ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { f.feed(dec.decode()); f.feed('\n'); break; }
      if (f.feed(dec.decode(value, { stream: true }))) { ctrl.abort(); break; }
    }
  } catch (e) {
    if (e.name === 'AbortError' && !f.done) throw new Error('Reading the G-code took too long.');
    if (e.name !== 'AbortError') throw e;
  } finally { clearTimeout(t); }
  return f.result();
}

module.exports = { StopFinder, findStop };
