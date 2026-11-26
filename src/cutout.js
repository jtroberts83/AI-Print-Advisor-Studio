// Background removal for certificate photos: BiRefNet-lite (MIT license, by ZhengPeng7; ONNX export by onnx-community)
// run on this PC with ONNX Runtime (MIT, Microsoft). The model (224 MB) is downloaded once, from a pinned version,
// and checked against its SHA-256 before it is used. Photos never leave the PC.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const MODEL = {
  name: 'BiRefNet-lite',
  url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model.onnx',
  sha256: '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333',
  size: 224005088,
  file: 'birefnet-lite-de15b22.onnx',
};
const SIZE = 1024;   // the model's input: 1024 × 1024 RGB
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

class Cutout {
  constructor(dir) { this.dir = dir; this.session = null; this.loading = null; this.idle = null; this.downloading = null; }
  get file() { return path.join(this.dir, MODEL.file); }
  async status() {
    let ready = false;
    try { ready = (await fsp.stat(this.file)).size === MODEL.size; } catch {}
    return { ready, downloading: !!this.downloading, mb: Math.round(MODEL.size / 1e6), model: MODEL.name };
  }

  // one download at a time; onProgress(received, total). Checked against the pinned SHA-256 before it's kept.
  download(onProgress, fetchImpl = fetch) {
    if (!this.downloading) this.downloading = this._download(onProgress, fetchImpl).finally(() => { this.downloading = null; });
    return this.downloading;
  }
  async _download(onProgress, fetchImpl) {
    await fsp.mkdir(this.dir, { recursive: true });
    const part = this.file + '.part';
    let res;
    try { res = await fetchImpl(MODEL.url, { redirect: 'follow' }); }
    catch { throw new Error('Couldn’t reach the download site. Check your internet connection and try again.'); }
    if (!res.ok || !res.body) throw new Error(`The download didn’t start (HTTP ${res.status}). Try again later.`);
    const hash = crypto.createHash('sha256'), out = fs.createWriteStream(part);
    let got = 0, last = 0;
    try {
      for await (const chunk of res.body) {
        const b = Buffer.from(chunk);
        hash.update(b); got += b.length;
        if (got > MODEL.size) throw new Error('The download was larger than expected, so it wasn’t used.');
        if (!out.write(b)) await new Promise((r) => out.once('drain', r));
        if (onProgress && (got - last > 2e6 || got === MODEL.size)) { last = got; onProgress(got, MODEL.size); }
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    } catch (e) {
      out.destroy(); await fsp.unlink(part).catch(() => {});
      throw e.message && /larger/.test(e.message) ? e : new Error('The download was interrupted. Try again.');
    }
    if (got !== MODEL.size || hash.digest('hex') !== MODEL.sha256) {
      await fsp.unlink(part).catch(() => {});
      throw new Error('The downloaded file wasn’t the expected one, so it wasn’t used. Try again.');
    }
    await fsp.rename(part, this.file);
    return this.status();
  }

  async _session() {
    clearTimeout(this.idle);
    if (!this.session) {
      if (!this.loading) {
        const ort = require('onnxruntime-node');
        this.loading = ort.InferenceSession.create(this.file, {
          executionProviders: ['cpu'],   // DirectML (graphics card) crashed the driver in testing: the processor is reliable
          graphOptimizationLevel: 'all', intraOpNumThreads: Math.max(1, os.cpus().length - 1),
        }).then((s) => { this.session = s; this.ort = ort; return s; }).finally(() => { this.loading = null; });
      }
      await this.loading;
    }
    return this.session;
  }
  // free the memory (about 1 GB while loaded) two minutes after the last photo
  _releaseLater() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { const s = this.session; this.session = null; if (s) s.release().catch(() => {}); }, 120000);
  }

  // rgba: the photo squeezed to 1024 × 1024 (Uint8Array, RGBA). Returns the mask, 1024 × 1024, 0–255 (255 = the model).
  async run(rgba) {
    if (!(await this.status()).ready) throw new Error('Download the background remover first.');
    const px = Buffer.isBuffer(rgba) || rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba);
    if (px.length !== SIZE * SIZE * 4) throw new Error('Bad photo size.');
    const s = await this._session();
    const n = SIZE * SIZE, data = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      data[i] = (px[i * 4] / 255 - MEAN[0]) / STD[0];
      data[n + i] = (px[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
      data[2 * n + i] = (px[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
    }
    try {
      const out = await s.run({ [s.inputNames[0]]: new this.ort.Tensor('float32', data, [1, 3, SIZE, SIZE]) });
      const o = out[s.outputNames[s.outputNames.length - 1]].data;
      const mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = Math.round(255 / (1 + Math.exp(-o[i])));   // the model gives logits
      return mask;
    } finally { this._releaseLater(); }
  }
}

module.exports = { Cutout, MODEL, SIZE };
