// Talks to a Snapmaker U1 through Moonraker, the way Snapmaker Orca's own "Print Preprocessing" dialog does:
//   1. POST /server/files/upload            (multipart, root=gcodes)
//   2. websocket JSON-RPC server.files.start_local_print
//        { type: 'gcode', path, options: { bed_level, flow_calibrate, time_lapse_camera, map_table } }
//      map_table = [[filament index in the G-code (T<n>), physical head 0-3], ...]   (firmware 1.3.0+)
//   3. older firmware: printer.gcode.script with SET_PRINT_EXTRUDER_MAP / SET_PRINT_USED_EXTRUDERS /
//      SET_PRINT_PREFERENCES, then printer.print.start
// Head state comes from the firmware's print_task_config object (filament type/colour/presence per head).
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

function baseUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//.test(s)) s = `http://${s}`;
  return s;
}
const headers = (apiKey) => (apiKey ? { 'X-Api-Key': apiKey } : {});

async function getJson(url, apiKey, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: headers(apiKey) });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error && body.error.message) || `HTTP ${res.status}`);
    return body;
  } finally { clearTimeout(t); }
}

// "FF8800FF", "#ff8800", 0xFF8800FF, [r,g,b,a] -> "#RRGGBB"
function toHex(c) {
  if (c == null || c === '') return null;
  if (Array.isArray(c)) return '#' + c.slice(0, 3).map(v => Math.round(v > 1 ? v : v * 255).toString(16).padStart(2, '0')).join('');
  if (typeof c === 'number') return '#' + ((c >>> 8) & 0xffffff).toString(16).padStart(6, '0');
  const s = String(c).replace(/^#|^0x/i, '');
  return /^[0-9a-f]{6,8}$/i.test(s) ? `#${s.slice(0, 6).toUpperCase()}` : null;
}

class U1Printer {
  constructor({ name, url, apiKey }) { this.name = name; this.base = baseUrl(url); this.apiKey = apiKey || null; }

  async status() {
    try {
      const q = await getJson(`${this.base}/printer/objects/query?print_stats&print_task_config&webhooks&virtual_sdcard`, this.apiKey, 4000);
      const st = (q.result && q.result.status) || {};
      const ptc = st.print_task_config || {};
      const types = ptc.filament_type || [], colors = ptc.filament_color_rgba || ptc.filament_color || [], exist = ptc.filament_exist || [];
      const subs = ptc.filament_sub_type || [], vendors = ptc.filament_vendor || [];
      const heads = [0, 1, 2, 3].map(i => ({
        index: i,
        type: types[i] || null,
        subType: subs[i] || null,
        vendor: vendors[i] || null,
        color: toHex(colors[i]),
        loaded: exist.length ? !!exist[i] : !!types[i],
      }));
      const ps = st.print_stats || {};
      return {
        online: true,
        klippy: (st.webhooks && st.webhooks.state) || 'ready',
        state: ps.state || 'standby',
        filename: ps.filename || null,
        progress: st.virtual_sdcard && st.virtual_sdcard.progress != null ? st.virtual_sdcard.progress : null,
        heads, hasTaskConfig: !!st.print_task_config,
      };
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'No response' : /fetch failed|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND/i.test(e.message + (e.cause ? e.cause.code : '')) ? 'Not reachable' : e.message;
      return { online: false, error: msg, heads: [] };
    }
  }

  // Streams the file as multipart/form-data so upload progress can be reported.
  upload(localPath, remoteName, onProgress) {
    return new Promise((resolve, reject) => {
      const boundary = '----u1advisor' + Math.random().toString(16).slice(2);
      const size = fs.statSync(localPath).size;
      const pre = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="root"\r\n\r\ngcodes\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="print"\r\n\r\nfalse\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${remoteName.replace(/"/g, '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const post = Buffer.from(`\r\n--${boundary}--\r\n`);
      const url = new URL(`${this.base}/server/files/upload`);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(url, {
        method: 'POST',
        headers: { ...headers(this.apiKey), 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': pre.length + size + post.length },
      }, (res) => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let j = null; try { j = JSON.parse(body); } catch {}
            resolve((j && j.result && j.result.item && j.result.item.path) || (j && j.item && j.item.path) || remoteName);
          } else {
            let msg = `HTTP ${res.statusCode}`;
            try { const j = JSON.parse(body); if (j.error && j.error.message) msg = j.error.message; } catch {}
            reject(new Error(`Upload failed: ${msg}`));
          }
        });
      });
      req.on('error', e => reject(new Error(`Upload failed: ${e.message}`)));
      req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error('timed out')));
      req.write(pre);
      let sent = 0;
      const stream = fs.createReadStream(localPath, { highWaterMark: 256 * 1024 });
      stream.on('data', chunk => {
        sent += chunk.length;
        if (!req.write(chunk)) { stream.pause(); req.once('drain', () => stream.resume()); }
        if (onProgress) onProgress(sent / size);
      });
      stream.on('end', () => { req.end(post); });
      stream.on('error', e => req.destroy(e));
    });
  }

  // GET /server/files/gcodes/<path> into a local file.
  download(remotePath, localPath) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.base}/server/files/gcodes/${String(remotePath).split('/').map(encodeURIComponent).join('/')}`);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.get(url, { headers: headers(this.apiKey) }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(res.statusCode === 404 ? 'That G-code is no longer on the printer' : `HTTP ${res.statusCode}`)); }
        // a connection that drops part way still "finishes": check the size, so a cut-off file is never kept
        const want = Number(res.headers['content-length']) || 0;
        let got = 0, aborted = false;
        res.on('data', (c) => { got += c.length; });
        res.on('aborted', () => { aborted = true; });
        res.on('error', (e) => { aborted = true; out.destroy(e); });
        const out = fs.createWriteStream(localPath);
        res.pipe(out);
        out.on('finish', () => {
          if (aborted || (want && got !== want)) { fs.unlink(localPath, () => {}); reject(new Error(`The download stopped early (${Math.round(got / 1e6)} of ${Math.round(want / 1e6)} MB). Try again.`)); }
          else resolve(localPath);
        });
        out.on('error', reject);
      });
      req.on('error', e => reject(new Error(/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND/.test(e.code || e.message) ? 'Printer not reachable' : e.message)));
      req.setTimeout(120000, () => req.destroy(new Error('timed out')));
    });
  }

  // One JSON-RPC call over Moonraker's websocket.
  rpc(method, params, ms = 20000) {
    return new Promise((resolve, reject) => {
      const wsUrl = this.base.replace(/^http/, 'ws') + '/websocket';
      const ws = new WebSocket(wsUrl, { headers: headers(this.apiKey), handshakeTimeout: 5000 });
      const id = Math.floor(Math.random() * 1e9);
      const timer = setTimeout(() => { ws.terminate(); reject(new Error(`${method} timed out`)); }, ms);
      ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id })));
      ws.on('message', (data) => {
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        if (m.id !== id) return; // notifications
        clearTimeout(timer); ws.close();
        if (m.error) { const e = new Error(m.error.message || 'error'); e.code = m.error.code; reject(e); } else resolve(m.result);
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(new Error(`Websocket: ${e.message}`)); });
    });
  }

  async startPrint(remotePath, { mapTable, bedLevel, flowCalibrate, timelapse }) {
    const options = { bed_level: bedLevel ? 1 : 0, flow_calibrate: flowCalibrate ? 1 : 0, time_lapse_camera: timelapse ? 1 : 0, map_table: mapTable };
    try {
      const r = await this.rpc('server.files.start_local_print', { type: 'gcode', path: remotePath, options });
      // the U1 reports failures as a normal result
      if (r && typeof r === 'object' && /error|fail/i.test(String(r.state || ''))) throw new Error(r.message || 'The printer refused the job');
      return { method: 'start_local_print' };
    } catch (e) {
      const notFound = e.code === -32601 || /method not found|unknown method/i.test(e.message);
      if (!notFound) throw e;
    }
    // firmware before 1.3.0
    const lines = mapTable.map(([cfg, head]) => `SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=${cfg} MAP_EXTRUDER=${head}`);
    lines.push(`SET_PRINT_USED_EXTRUDERS EXTRUDERS=${[...new Set(mapTable.map(m => m[1]))].join(',')}`);
    lines.push(`SET_PRINT_PREFERENCES BED_LEVEL=${options.bed_level} FLOW_CALIBRATE=${options.flow_calibrate} TIME_LAPSE_CAMERA=${options.time_lapse_camera}`);
    await this.rpc('printer.gcode.script', { script: lines.join('\n') });
    await this.rpc('printer.print.start', { filename: remotePath });
    return { method: 'legacy' };
  }
}

// Insert U1-sized thumbnails (48x48 and 300x300 PNG) the way Orca writes them, if the G-code has none.
function withThumbnails(gcode, pngs) {
  if (/; thumbnail begin /.test(gcode.slice(0, 400000)) || !pngs || !pngs.length) return gcode;
  let block = '; THUMBNAIL_BLOCK_START\n';
  for (const { w, h, base64 } of pngs) {
    block += `;\n; thumbnail begin ${w}x${h} ${base64.length}\n`;
    for (let i = 0; i < base64.length; i += 78) block += `; ${base64.slice(i, i + 78)}\n`;
    block += '; thumbnail end\n';
  }
  block += '; THUMBNAIL_BLOCK_END\n\n';
  const end = gcode.indexOf('; HEADER_BLOCK_END');
  if (end >= 0) { const nl = gcode.indexOf('\n', end) + 1; return gcode.slice(0, nl) + '\n' + block + gcode.slice(nl); }
  return block + gcode;
}

function safeRemoteName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().replace(/\.gcode$/i, '') + '.gcode';
}

module.exports = { U1Printer, withThumbnails, safeRemoteName, toHex };
