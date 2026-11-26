const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Cutout, MODEL } = require('../src/cutout');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cutout-'));
const fakeFetch = (bytes, status = 200) => async () => ({ ok: status === 200, status, body: (async function* () { for (let i = 0; i < bytes.length; i += 65536) yield bytes.subarray(i, i + 65536); })() });

test('background remover: not ready until downloaded; run refuses before that', async () => {
  const c = new Cutout(tmp());
  const st = await c.status();
  assert.strictEqual(st.ready, false);
  assert.strictEqual(st.mb, Math.round(MODEL.size / 1e6));
  await assert.rejects(c.run(new Uint8Array(1024 * 1024 * 4)), /Download/);
});

test('background remover: a download that isn’t the pinned file is thrown away', async () => {
  const dir = tmp(), c = new Cutout(dir);
  await assert.rejects(c.download(null, fakeFetch(Buffer.alloc(300000, 7))), /expected/);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'nothing kept');
  await assert.rejects(c.download(null, fakeFetch(Buffer.alloc(10), 404)), /HTTP 404/);
  await assert.rejects(c.download(null, async () => { throw new Error('offline'); }), /internet/);
  assert.strictEqual((await c.status()).ready, false);
});
