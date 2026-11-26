// Where a cancelled or failed print stopped (src/stoplayer.js), and the Print Monitor writing it down (watch.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { StopFinder, findStop } = require('../src/stoplayer');
const { PrinterWatch } = require('../src/monitor/watch');

// like Snapmaker Orca's G-code: a start block that purges, then layers of 0.2 mm (first 0.24), 10 mm of filament each
function gcode({ layers = 20, absolute = false } = {}) {
  const out = ['; total layer number: ' + layers, 'SET_PRINT_STATS_INFO TOTAL_LAYER=' + layers + ' CURRENT_LAYER=0', absolute ? 'M82' : 'M83', 'G1 X0 Y0 E5 ; purge'];
  let e = 5;
  if (absolute) out.push('G92 E0'), e = 0;
  let z = 0;
  for (let n = 1; n <= layers; n++) {
    const h = n === 1 ? 0.24 : 0.2; z = Math.round((z + h) * 100) / 100;
    out.push(';LAYER_CHANGE', `;Z:${z}`, `;HEIGHT:${h}`, `SET_PRINT_STATS_INFO TOTAL_LAYER=${layers} CURRENT_LAYER=${n}`);
    for (let k = 0; k < 5; k++) {
      if (absolute) { e += 2.5; out.push(`G1 X${k} Y${n} E${e.toFixed(3)}`); e -= 0.5; out.push(`G1 E${e.toFixed(3)} F2400`); }
      else out.push(`G1 X${k} Y${n} E2.5`, 'G1 E-.5 F2400');
    }
  }
  return out.join('\n') + '\n';
}

test('finds the layer the filament ran out on, and the height to cut at', () => {
  const f = new StopFinder(5 + 10 * 7 + 4);   // the purge, 7 whole layers, part of the 8th
  f.feed(gcode());
  const r = f.result();
  assert.strictEqual(r.layer, 8); assert.strictEqual(r.total, 20);
  assert.strictEqual(r.z, 1.64); assert.strictEqual(r.doneZ, 1.44); assert.strictEqual(r.layerHeight, 0.2);
  assert.ok(r.reachedTarget);
});

test('absolute extrusion (M82 with G92 E0) counts the same', () => {
  const f = new StopFinder(5 + 10 * 12 + 1);   // the purge, 12 whole layers, a little of the 13th
  f.feed(gcode({ absolute: true }));
  assert.strictEqual(f.result().layer, 13);
});

test('fed in odd pieces (lines split across chunks) gives the same answer', () => {
  const text = gcode(), f = new StopFinder(5 + 10 * 3 + 1);
  for (let i = 0; i < text.length && !f.done; i += 7) f.feed(text.slice(i, i + 7));
  assert.strictEqual(f.result().layer, 4);
  assert.strictEqual(f.result().doneZ, 0.64);
});

test('with the layer known (from the Print Monitor) it reads just to that layer for its height', () => {
  const f = new StopFinder(0, 5);
  f.feed(gcode());
  const r = f.result();
  assert.strictEqual(r.layer, 5); assert.strictEqual(r.z, 1.04); assert.strictEqual(r.doneZ, 0.84);
});

test('with the printer’s position in the file (from the Print Monitor) it stops exactly there', () => {
  const text = gcode(), at = text.indexOf('CURRENT_LAYER=6\n') + 60;   // part way into layer 6
  const f = new StopFinder(0, 0, at);
  f.feed(text);
  const r = f.result();
  assert.strictEqual(r.layer, 6); assert.strictEqual(r.z, 1.24); assert.strictEqual(r.doneZ, 1.04);
});

test('findStop reads from the printer only as far as needed, and says when the G-code is gone', async () => {
  const text = gcode({ layers: 400 });
  let sent = 0, pulled = 0;
  const fetchImpl = async (url, o) => {
    assert.match(url, /\/server\/files\/gcodes\//);
    const enc = new TextEncoder().encode(text);
    return new Response(new ReadableStream({
      pull(c) { if (o.signal.aborted || sent >= enc.length) { c.close(); return; } pulled++; c.enqueue(enc.slice(sent, sent + 4096)); sent += 4096; },
    }), { status: 200 });
  };
  const r = await findStop({ url: 'http://p.test/server/files/gcodes/a.gcode', filamentMm: 5 + 10 * 9 + 2, fetchImpl });
  assert.strictEqual(r.layer, 10);
  assert.ok(sent < text.length / 4, 'stopped reading early');
  await assert.rejects(findStop({ url: 'http://p.test/server/files/gcodes/c.gcode', filamentMm: 50, size: 123, fetchImpl: async (u) => (/metadata\?filename=c\.gcode$/.test(u) ? Response.json({ result: { size: 999 } }) : new Response('G1 E1;')) }), (e) => e.code === 'changed');
  await assert.rejects(findStop({ url: 'http://p.test/server/files/gcodes/b.gcode', filamentMm: 50, fetchImpl: async () => new Response('', { status: 404 }) }), (e) => e.code === 'gone');
});

// the Print Monitor writes down the layer when a print is cancelled
class FakeConn extends EventEmitter {
  constructor() { super(); this.base = 'http://printer.test'; this.status = {}; this.connected = true; this.klippyState = 'ready'; this.objects = []; this.systemMemory = {}; }
  start() {} stop() {}
  headers() { return {}; }
  async call(method) { if (method === 'server.files.metadata') return { estimated_time: 3600, filament_total: 10000, thumbnails: [] }; return {}; }
  async fetch() { return new Response('x'); }
  set(st) { for (const [k, v] of Object.entries(st)) this.status[k] = { ...(this.status[k] || {}), ...v }; this.emit('update', new Set(Object.keys(st))); }
}
class FakeCam { start() {} stop() {} info() { return {}; } async freshSnapshot() { return null; } }
const tick = () => new Promise((r) => setTimeout(r, 30));

test('the Print Monitor records the layer a cancelled print stopped on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipa-stop-'));
  const conn = new FakeConn();
  const w = new PrinterWatch({ printer: { id: 'p1', name: 'U1 #1', url: 'printer.test' }, dataDir: dir, previews: null,
    settings: () => ({ safe_bed_c: 40, snapshot_progress: 99, preview_minutes: 5, units: 'F', milestones: [] }), notify: async () => {},
    connectionFactory: () => conn, cameraFactory: () => new FakeCam() });
  conn.set({ print_stats: { state: 'standby', filename: '' }, heater_bed: { temperature: 25 } }); await tick();
  conn.set({ print_stats: { state: 'printing', filename: 'Deer.gcode', info: { current_layer: 41, total_layer: 300 }, filament_used: 9000 } }); await tick();
  conn.set({ print_stats: { info: { current_layer: 42, total_layer: 300 } }, virtual_sdcard: { file_position: 123456 }, gcode_move: { gcode_position: [10, 20, 8.44, 0] } }); await tick();
  conn.set({ print_stats: { state: 'cancelled', info: { current_layer: 0, total_layer: 300 } } }); await tick();   // cleared by the cancel
  const s = w.stops();
  assert.strictEqual(s.length, 1);
  assert.deepStrictEqual({ f: s[0].filename, l: s[0].layer, t: s[0].total, st: s[0].status }, { f: 'Deer.gcode', l: 42, t: 300, st: 'cancelled' });
  assert.strictEqual(s[0].file_position, 123456); assert.strictEqual(s[0].z, 8.44);
  w.stop();
});
