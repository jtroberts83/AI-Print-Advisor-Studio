const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Slicer } = require('../src/slicer');

test('slicing: a cancelled whole-project run stops slices that have not started and kills running ones', async () => {
  const t = Slicer.cancelToken();
  let killed = 0;
  t.children.add({ kill: () => { killed++; } });
  t.cancel();
  assert.strictEqual(t.cancelled, true);
  assert.strictEqual(killed, 1);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipa-slice-'));
  const s = new Slicer({ exe: null, lib: null, workDir });
  await assert.rejects(s.slice(Buffer.from('x'), 2, 'key', t), (e) => e.cancelled === true);
  assert.strictEqual(s.isCached(2, 'key'), false);
  fs.mkdirSync(s.cacheDir, { recursive: true });
  fs.writeFileSync(s.cacheFileFor(2, 'key'), JSON.stringify({ timeSeconds: 60 }));
  // a slice made before still comes back, even after cancelling (it costs nothing)
  assert.strictEqual(s.isCached(2, 'key'), true);
  assert.deepStrictEqual(await s.slice(null, 2, 'key', t), { timeSeconds: 60, cached: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});
