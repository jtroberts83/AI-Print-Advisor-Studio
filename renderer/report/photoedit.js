// Touch up a certificate photo (Print report → 🏅 Certificate → 🎨 Touch up photo): exposure, contrast, saturation,
// warmth, hue, sharpening and background removal, with a live preview, an Auto-fix that sets the sliders from the
// photo itself, and "hold to compare" with the original. All on this PC; nothing is sent anywhere.
//
// Background removal: an AI model (BiRefNet-lite, see src/cutout.js) finds the model in the photo, on this PC. It
// is given the photo squeezed to 1024 × 1024 and returns a soft mask the same size, which is stretched back to the
// photo's shape. The result keeps the photo's own pixels and makes the background transparent (a PNG), so the
// certificate's own color shows behind the model, whichever template is picked.
(function (root) {
  const DEF = { exposure: 0, contrast: 0, saturation: 0, warmth: 0, hue: 0, sharpen: 0, removeBg: false, soften: 0 };
  const PREVIEW = 900, FINAL = 2400, AI = 1024;

  // ---------------------------------------------------------------- pixels
  const loadImg = (src) => new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error('That photo can’t be opened.')); im.src = src; });
  function pixels(img, max) {
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
    return { w, h, data: g.getImageData(0, 0, w, h).data };
  }
  // the photo squeezed to the AI model's square input
  function squeezed(img) {
    const c = document.createElement('canvas'); c.width = AI; c.height = AI;
    const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, AI, AI);
    return g.getImageData(0, 0, AI, AI).data;
  }
  function boxBlur(src, w, h, r) {   // a float image, blurred twice (close to a gaussian)
    if (r < 1) return src.slice();
    let a = src.slice(), b = new Float32Array(src.length);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) {   // rows
        let s = 0, o = y * w; for (let x = -r; x <= r; x++) s += a[o + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) { b[o + x] = s / (2 * r + 1); s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)]; }
      }
      for (let x = 0; x < w; x++) {   // columns
        let s = 0; for (let y = -r; y <= r; y++) s += b[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) { a[y * w + x] = s / (2 * r + 1); s += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x]; }
      }
    }
    return a;
  }
  // the AI's mask (0–255, square) as { w, h, m: 0..1 }
  const maskOf = (u8) => ({ w: AI, h: AI, m: Float32Array.from(u8, (v) => v / 255) });

  // the mask at another size (bilinear), softened
  function maskAt(mask, w, h, soften) {
    let out;
    if (mask.w === w && mask.h === h) out = mask.m.slice();
    else {
      out = new Float32Array(w * h);
      const sx = mask.w / w, sy = mask.h / h;
      for (let y = 0; y < h; y++) {
        const fy = Math.min(mask.h - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = fy | 0, y1 = Math.min(mask.h - 1, y0 + 1), ty = fy - y0;
        for (let x = 0; x < w; x++) {
          const fx = Math.min(mask.w - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = fx | 0, x1 = Math.min(mask.w - 1, x0 + 1), tx = fx - x0;
          const a = mask.m[y0 * mask.w + x0] * (1 - tx) + mask.m[y0 * mask.w + x1] * tx, b = mask.m[y1 * mask.w + x0] * (1 - tx) + mask.m[y1 * mask.w + x1] * tx;
          out[y * w + x] = a * (1 - ty) + b * ty;
        }
      }
    }
    const r = Math.round(soften * Math.max(w, h) / PREVIEW);
    return r >= 1 ? boxBlur(out, w, h, r) : out;
  }

  // ---------------------------------------------------------------- the adjustments
  // mask: 0..1 per pixel (1 = the model) or null. bgColor: [r, g, b] 0..1 to put behind the model, or null for a
  // transparent background.
  function render(px, p, mask, bgColor) {
    const { w, h, data } = px, n = w * h;
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    const k = 2 ** (p.exposure / 100 * 1.3), c = 1 + p.contrast / 100, s = 1 + p.saturation / 100, wm = p.warmth / 100 * 0.12;
    const th = p.hue * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
    // hue rotation around the gray axis (keeps brightness)
    const m00 = 0.213 + cs * 0.787 - sn * 0.213, m01 = 0.715 - cs * 0.715 - sn * 0.715, m02 = 0.072 - cs * 0.072 + sn * 0.928;
    const m10 = 0.213 - cs * 0.213 + sn * 0.143, m11 = 0.715 + cs * 0.285 + sn * 0.140, m12 = 0.072 - cs * 0.072 - sn * 0.283;
    const m20 = 0.213 - cs * 0.213 - sn * 0.787, m21 = 0.715 - cs * 0.715 + sn * 0.715, m22 = 0.072 + cs * 0.928 + sn * 0.072;
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      let r = data[q] / 255 * k, g = data[q + 1] / 255 * k, b = data[q + 2] / 255 * k;
      r = (r - 0.5) * c + 0.5; g = (g - 0.5) * c + 0.5; b = (b - 0.5) * c + 0.5;
      r += wm; g += wm * 0.2; b -= wm;
      const l = 0.299 * r + 0.587 * g + 0.114 * b; r = l + (r - l) * s; g = l + (g - l) * s; b = l + (b - l) * s;
      if (p.hue) { const r2 = m00 * r + m01 * g + m02 * b, g2 = m10 * r + m11 * g + m12 * b, b2 = m20 * r + m21 * g + m22 * b; r = r2; g = g2; b = b2; }
      R[i] = r; G[i] = g; B[i] = b;
    }
    if (p.sharpen > 0) {   // unsharp mask
      const amt = p.sharpen / 100 * 1.6, rad = Math.max(1, Math.round(Math.max(w, h) / 1200));
      for (const ch of [R, G, B]) { const bl = boxBlur(ch, w, h, rad); for (let i = 0; i < n; i++) ch[i] += amt * (ch[i] - bl[i]); }
    }
    const out = new ImageData(w, h), o = out.data;
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      let r = R[i], g = G[i], b = B[i], alpha = 1;
      if (mask) {
        const a = mask[i];
        if (bgColor) { r = r * a + bgColor[0] * (1 - a); g = g * a + bgColor[1] * (1 - a); b = b * a + bgColor[2] * (1 - a); }
        else alpha = a;
      }
      o[q] = Math.max(0, Math.min(255, r * 255)); o[q + 1] = Math.max(0, Math.min(255, g * 255)); o[q + 2] = Math.max(0, Math.min(255, b * 255)); o[q + 3] = Math.round(alpha * 255);
    }
    return out;
  }

  // ---------------------------------------------------------------- Auto-fix: slider values from the photo itself
  function autoFix(px, mask) {
    const { data } = px, n = px.w * px.h, lum = [];
    let sr = 0, sg = 0, sb = 0, sc = 0, cnt = 0;
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      if (mask && mask[i] < 0.5) continue;
      if (i % 3) continue;   // every third pixel is plenty
      const r = data[q] / 255, g = data[q + 1] / 255, b = data[q + 2] / 255, l = 0.299 * r + 0.587 * g + 0.114 * b;
      lum.push(l); sc += Math.max(r, g, b) - Math.min(r, g, b);
      if (l > 0.25 && l < 0.95) { sr += r; sg += g; sb += b; cnt++; }
    }
    if (lum.length < 50) return { ...DEF };
    lum.sort((a, b) => a - b);
    const at = (q) => lum[Math.floor(q * (lum.length - 1))], med = at(0.5), lo = at(0.02), hi = at(0.98);
    const clamp = (v, a, b) => Math.round(Math.max(a, Math.min(b, v)));
    const exposure = clamp(Math.log2(0.48 / Math.max(0.05, med)) / 1.3 * 100 * 0.8, -50, 60);
    const contrast = clamp((0.9 / Math.max(0.2, hi - lo) - 1) * 55, -15, 35);
    const warmth = cnt ? clamp((sb - sr) / cnt / 0.12 * 100 * 0.6, -40, 40) : 0;
    const chroma = sc / lum.length, saturation = chroma < 0.12 ? 30 : chroma < 0.22 ? 18 : 8;
    return { exposure, contrast, warmth, saturation, sharpen: 30, hue: 0 };
  }

  // ---------------------------------------------------------------- the editor window
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SLIDERS = [['exposure', 'Exposure (brightness)', -100, 100], ['contrast', 'Contrast', -100, 100], ['saturation', 'Saturation (color strength)', -100, 100],
    ['warmth', 'Warmth (cool ↔ warm)', -100, 100], ['hue', 'Hue (shift colors)', -180, 180], ['sharpen', 'Sharpen', 0, 100]];

  // cutout: { status(), download(onProgress), run(rgba) } from the window (the AI model runs in the app, not here).
  // paper: the certificate's color, shown behind the model in the preview.
  function open({ src, params, paper = '#fffdf6', cutout = null }) {
    return new Promise(async (resolve) => {
      let img;
      try { img = await loadImg(src); } catch (e) { resolve(null); return; }
      const P = { ...DEF, ...(params || {}) };
      delete P.tolerance; delete P.bg; delete P.tolTouched;   // from the old background remover
      const prev = pixels(img, PREVIEW);
      let ai = null, aiBusy = false;   // the AI's mask ({ w, h, m }), made once per photo
      let st = cutout ? await cutout.status().catch(() => null) : null;
      const box = document.createElement('div');
      box.className = 'pe-wrap';
      box.innerHTML = `<div class="pe" role="dialog" aria-modal="true" aria-label="Touch up the photo">
        <div class="pe-view" style="--pe-paper:${esc(/^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\))$/i.test(paper) ? paper : '#ffffff')}"><canvas width="${prev.w}" height="${prev.h}" aria-label="Preview"></canvas><div class="pe-busy" hidden></div></div>
        <div class="pe-side">
          <h2>Touch up the photo</h2>
          <div class="pe-row"><button class="btn primary" data-pe="auto" title="Sets the sliders from this photo’s brightness and colors. Adjust them after if you like.">✨ Auto-fix</button>
            <button class="btn" data-pe="hold" title="Hold to see the original">👁 Hold to compare</button><button class="link" data-pe="reset">Reset</button></div>
          ${SLIDERS.map(([k, label, lo, hi]) => `<label class="pe-sl"><span>${esc(label)} <output data-out="${k}">${P[k]}</output></span><input type="range" data-k="${k}" min="${lo}" max="${hi}" value="${P[k]}"></label>`).join('')}
          <fieldset class="pe-bg"><legend><label><input type="checkbox" data-k="removeBg" ${P.removeBg ? 'checked' : ''}> Remove the background</label></legend>
            <p class="muted small pe-what">An AI model on this PC finds your model in the photo and takes the background away; the certificate’s own color shows behind it.</p>
            <div class="pe-dl" hidden><button class="btn" data-pe="download"></button><progress max="1" value="0" hidden></progress></div>
            <label class="pe-sl pe-soft"><span>Soften the edge <output data-out="soften">${P.soften}</output></span><input type="range" data-k="soften" min="0" max="10" value="${P.soften}"></label>
            <p class="pe-warn small" hidden></p>
          </fieldset>
          <div class="pe-row pe-end"><button class="btn" data-pe="cancel">Cancel</button><button class="btn primary" data-pe="apply">Use this photo</button></div>
        </div></div>`;
      document.body.append(box);
      const cv = box.querySelector('canvas'), g = cv.getContext('2d');
      const busy = box.querySelector('.pe-busy'), warn = box.querySelector('.pe-warn');
      const dl = box.querySelector('.pe-dl'), dlBtn = dl.querySelector('button'), bar = dl.querySelector('progress');
      const say = (t) => { warn.textContent = t || ''; warn.hidden = !t; };
      const sync = () => {
        for (const el of box.querySelectorAll('[data-k]')) { const k = el.dataset.k; if (el.type === 'checkbox') el.checked = !!P[k]; else el.value = P[k]; }
        for (const o of box.querySelectorAll('[data-out]')) o.textContent = P[o.dataset.out];
        box.querySelector('.pe-bg').classList.toggle('off', !P.removeBg);
        box.querySelector('.pe-soft').hidden = !ai;
        const needDl = !!cutout && !!st && !st.ready;
        dl.hidden = !needDl;
        if (needDl && !st.downloading) dlBtn.textContent = `⬇ Download the background remover (${st.mb} MB, once)`;
      };
      const maskFor = () => (P.removeBg && ai ? maskAt(ai, prev.w, prev.h, P.soften) : null);
      let raf = 0, holding = false;
      const draw = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          g.clearRect(0, 0, prev.w, prev.h);
          if (holding) { g.drawImage(img, 0, 0, prev.w, prev.h); return; }
          g.putImageData(render(prev, P, maskFor(), null), 0, 0);
        });
      };
      // the AI finds the model (once per photo; a few seconds)
      async function findModel() {
        if (ai || aiBusy) return;
        if (!cutout) { say('Background removal isn’t available here.'); P.removeBg = false; sync(); return; }
        st = await cutout.status().catch(() => st);
        if (!st || !st.ready) { say('Download the background remover first (once), then tick “Remove the background”.'); P.removeBg = false; sync(); return; }
        aiBusy = true; busy.textContent = 'Finding your model in the photo… (a few seconds)'; busy.hidden = false; say('');
        try {
          ai = maskOf(await cutout.run(squeezed(img)));
          const kept = ai.m.reduce((t, v) => t + v, 0) / ai.m.length;
          if (kept < 0.02) say('The AI didn’t find a model in this photo. A photo with the model in the middle works best.');
        } catch (e) { say(`Couldn’t remove the background: ${e.message || e}`); P.removeBg = false; }
        aiBusy = false; busy.hidden = true; sync(); draw();
      }
      const done = (v) => { box.remove(); document.removeEventListener('keydown', onKey); if (offProgress) offProgress(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      document.addEventListener('keydown', onKey);
      let offProgress = null;
      box.addEventListener('input', (e) => {
        const t = e.target;
        if (!t.dataset.k) return;
        P[t.dataset.k] = t.type === 'checkbox' ? t.checked : +t.value;
        sync(); draw();
        if (t.dataset.k === 'removeBg' && t.checked) findModel();
      });
      box.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-pe]'); if (!b) return;
        const a = b.dataset.pe;
        if (a === 'cancel') done(null);
        else if (a === 'reset') { Object.assign(P, DEF); sync(); draw(); }
        else if (a === 'auto') { Object.assign(P, autoFix(prev, maskFor())); sync(); draw(); }
        else if (a === 'download') {
          b.disabled = true; bar.hidden = false; say('');
          if (!offProgress && cutout.onProgress) offProgress = cutout.onProgress((got, total) => { bar.value = got / total; b.textContent = `Downloading… ${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB`; });
          b.textContent = 'Downloading…';
          try { st = await cutout.download(); P.removeBg = true; sync(); findModel(); }
          catch (err) { say(err.message || String(err)); st = await cutout.status().catch(() => st); }
          b.disabled = false; bar.hidden = true; sync();
        } else if (a === 'apply') {
          if (P.removeBg && !ai) { say(aiBusy ? 'Still finding your model… one moment.' : 'Tick “Remove the background” again, or untick it.'); return; }
          b.disabled = true; b.textContent = 'Making the photo…';
          await new Promise((r) => setTimeout(r, 30));
          const full = pixels(img, FINAL);
          const m = P.removeBg && ai ? maskAt(ai, full.w, full.h, P.soften) : null;
          const c = document.createElement('canvas'); c.width = full.w; c.height = full.h;
          c.getContext('2d').putImageData(render(full, P, m, null), 0, 0);
          // a cut-out keeps its transparency (PNG); a plain photo stays a JPEG
          done({ dataUrl: m ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92), params: { ...P } });
        }
      });
      const hold = box.querySelector('[data-pe=hold]');
      const on = () => { holding = true; draw(); }, off = () => { if (holding) { holding = false; draw(); } };
      hold.addEventListener('pointerdown', on); hold.addEventListener('pointerup', off); hold.addEventListener('pointerleave', off);
      hold.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); on(); } });
      hold.addEventListener('keyup', off);
      sync(); draw();
      if (P.removeBg) findModel();   // reopened with the background already removed: find the model again
      box.querySelector('[data-pe=auto]').focus();
    });
  }

  const api = { open, autoFix, render, maskAt, DEF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhotoEdit = api;
})(typeof window !== 'undefined' ? window : globalThis);
