// Touch up a certificate photo (Print report → 🏅 Certificate → 🎨 Touch up photo): exposure, contrast, saturation,
// warmth, hue, sharpening and background removal, with a live preview, an Auto-fix that sets the sliders from the
// photo itself, and "hold to compare" with the original. All on this PC; nothing is sent anywhere.
//
// Background removal: the colors along the photo's edges are taken as the background (a few clusters, so a table
// and a wall both count), then the background grows inward from the edges through pixels close to those colors.
// The model's own pixels, even ones that look like the background, stay unless they touch it. Works best on a
// plain background. The mask is made at preview size, scaled up and softened for the final picture.
(function (root) {
  const DEF = { exposure: 0, contrast: 0, saturation: 0, warmth: 0, hue: 0, sharpen: 0, removeBg: false, tolerance: 22, soften: 2, bg: 'white' };
  const PREVIEW = 900, FINAL = 2400;

  // ---------------------------------------------------------------- pixels
  const loadImg = (src) => new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error('That photo can’t be opened.')); im.src = src; });
  function pixels(img, max) {
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
    return { w, h, data: g.getImageData(0, 0, w, h).data };
  }
  const LIN = new Float32Array(256).map((_, i) => { const c = i / 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; });
  function labOf(data, n) {
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = LIN[data[p]], g = LIN[data[p + 1]], b = LIN[data[p + 2]];
      const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
      L[i] = 116 * y - 16; A[i] = 500 * (x - y); B[i] = 200 * (y - z);
    }
    return { L, A, B };
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

  // ---------------------------------------------------------------- background mask: 1 = keep (the model), 0 = background
  function bgMask(px, tol) {
    const { w, h, data } = px, n = w * h, { L, A, B } = labOf(data, n);
    const ring = Math.max(2, Math.round(Math.min(w, h) * 0.02)), border = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < ring || y < ring || x >= w - ring || y >= h - ring) border.push(y * w + x);
    // the background's colors: k-means on the edge pixels
    const step = Math.max(1, Math.floor(border.length / 4000)), sample = border.filter((_, i) => i % step === 0);
    let C = [0, 0.33, 0.66, 0.99].map((q) => { const i = sample[Math.floor(q * (sample.length - 1))]; return [L[i], A[i], B[i]]; });
    for (let it = 0; it < 8; it++) {
      const sum = C.map(() => [0, 0, 0, 0]);
      for (const i of sample) { let bi = 0, bd = Infinity; C.forEach((c, k) => { const d = (L[i] - c[0]) ** 2 + (A[i] - c[1]) ** 2 + (B[i] - c[2]) ** 2; if (d < bd) { bd = d; bi = k; } }); const s = sum[bi]; s[0] += L[i]; s[1] += A[i]; s[2] += B[i]; s[3]++; }
      C = C.map((c, k) => (sum[k][3] ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : c));
    }
    const dist = new Float32Array(n);
    for (let i = 0; i < n; i++) { let bd = Infinity; for (const c of C) { const d = (L[i] - c[0]) ** 2 + (A[i] - c[1]) ** 2 + (B[i] - c[2]) ** 2; if (d < bd) bd = d; } dist[i] = Math.sqrt(bd); }
    // grow the background inward from the edges
    const bg = new Uint8Array(n), queue = new Int32Array(n); let qh = 0, qt = 0;
    for (const i of border) if (dist[i] < tol && !bg[i]) { bg[i] = 1; queue[qt++] = i; }
    const near = (i, j) => Math.sqrt((L[i] - L[j]) ** 2 + (A[i] - A[j]) ** 2 + (B[i] - B[j]) ** 2);
    while (qh < qt) {
      const i = queue[qh++], x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || bg[j]) continue;
        // a step at a time into slightly different colors (soft shadows, uneven light), but never far from the background's colors
        if (dist[j] < tol || (dist[j] < tol * 1.35 && near(i, j) < Math.min(4, tol * 0.18))) { bg[j] = 1; queue[qt++] = j; }
      }
    }
    // keep the model: the big pieces of what's left, not specks
    const lab = new Int32Array(n).fill(-1), sizes = []; let id = 0;
    for (let s = 0; s < n; s++) {
      if (bg[s] || lab[s] >= 0) continue;
      let qh2 = 0, qt2 = 0, size = 0; queue[qt2++] = s; lab[s] = id;
      while (qh2 < qt2) {
        const i = queue[qh2++], x = i % w, y = (i / w) | 0; size++;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && !bg[j] && lab[j] < 0) { lab[j] = id; queue[qt2++] = j; }
      }
      sizes.push(size); id++;
    }
    const biggest = Math.max(0, ...sizes), keep = sizes.map((s) => s >= Math.max(n * 0.002, biggest * 0.02));
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = !bg[i] && keep[lab[i]] ? 1 : 0;
    const kept = m.reduce((t, v) => t + v, 0) / n;
    return { m, w, h, kept };
  }
  // the strongest setting that still keeps the model: more and more counts as background until, at some point,
  // the model itself starts to go (a sudden drop in what's kept); one step before that
  function autoTolerance(px) {
    const steps = [8, 12, 16, 20, 24, 28, 32, 38, 44], kept = [];
    let best = steps[0], cache = null;
    for (const t of steps) {
      const m = bgMask(px, t); kept.push(m.kept);
      const k = kept.length - 1;
      if (m.kept < 0.02 || (k > 0 && m.kept < kept[k - 1] * 0.75)) break;
      best = t; cache = m;
    }
    return { tolerance: best, mask: cache };
  }
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
    const soft = p.removeBg && p.bg === 'soft';
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      let r = R[i], g = G[i], b = B[i];
      if (mask) {
        const a = mask[i];
        let br = bgColor[0], bgc = bgColor[1], bb = bgColor[2];
        if (soft) { const x = i % w, y = (i / w) | 0, d = Math.hypot((x - w / 2) / w, (y - h / 2) / h) * 1.6; br = bgc = bb = 1 - 0.14 * Math.min(1, d); }
        r = r * a + br * (1 - a); g = g * a + bgc * (1 - a); b = b * a + bb * (1 - a);
      }
      o[q] = Math.max(0, Math.min(255, r * 255)); o[q + 1] = Math.max(0, Math.min(255, g * 255)); o[q + 2] = Math.max(0, Math.min(255, b * 255)); o[q + 3] = 255;
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
  const hexRgb = (h) => { const v = parseInt(String(h || '#ffffff').replace('#', '').slice(0, 6), 16) || 0xffffff; return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; };

  function open({ src, params, paper = '#fffdf6' }) {
    return new Promise(async (resolve) => {
      let img;
      try { img = await loadImg(src); } catch (e) { resolve(null); return; }
      const P = { ...DEF, ...(params || {}) };
      const prev = pixels(img, PREVIEW);
      let maskCache = null;   // { tol, mask }
      const box = document.createElement('div');
      box.className = 'pe-wrap';
      box.innerHTML = `<div class="pe" role="dialog" aria-modal="true" aria-label="Touch up the photo">
        <div class="pe-view"><canvas width="${prev.w}" height="${prev.h}" aria-label="Preview"></canvas><div class="pe-busy" hidden>Finding the background…</div></div>
        <div class="pe-side">
          <h2>Touch up the photo</h2>
          <div class="pe-row"><button class="btn primary" data-pe="auto" title="Sets the sliders from this photo’s brightness and colors. Adjust them after if you like.">✨ Auto-fix</button>
            <button class="btn" data-pe="hold" title="Hold to see the original">👁 Hold to compare</button><button class="link" data-pe="reset">Reset</button></div>
          ${SLIDERS.map(([k, label, lo, hi]) => `<label class="pe-sl"><span>${esc(label)} <output data-out="${k}">${P[k]}</output></span><input type="range" data-k="${k}" min="${lo}" max="${hi}" value="${P[k]}"></label>`).join('')}
          <fieldset class="pe-bg"><legend><label><input type="checkbox" data-k="removeBg" ${P.removeBg ? 'checked' : ''}> Remove the background</label></legend>
            <p class="muted small">Works best with the model on a plain background. The preview shows the result.</p>
            <label class="pe-sl"><span>How much counts as background <output data-out="tolerance">${P.tolerance}</output></span><input type="range" data-k="tolerance" min="4" max="60" value="${P.tolerance}"></label>
            <label class="pe-sl"><span>Soften the edge <output data-out="soften">${P.soften}</output></span><input type="range" data-k="soften" min="0" max="10" value="${P.soften}"></label>
            <div class="pe-row">New background:
              ${[['white', 'White'], ['paper', 'Certificate paper'], ['soft', 'Soft studio']].map(([v, l]) => `<label><input type="radio" name="pe-bg" value="${v}" ${P.bg === v ? 'checked' : ''}> ${l}</label>`).join('')}</div>
            <p class="pe-warn small" hidden></p>
          </fieldset>
          <div class="pe-row pe-end"><button class="btn" data-pe="cancel">Cancel</button><button class="btn primary" data-pe="apply">Use this photo</button></div>
        </div></div>`;
      document.body.append(box);
      const cv = box.querySelector('canvas'), g = cv.getContext('2d');
      const busy = box.querySelector('.pe-busy'), warn = box.querySelector('.pe-warn');
      const sync = () => {
        for (const el of box.querySelectorAll('[data-k]')) { const k = el.dataset.k; if (el.type === 'checkbox') el.checked = !!P[k]; else el.value = P[k]; }
        for (const o of box.querySelectorAll('[data-out]')) o.textContent = P[o.dataset.out];
        for (const r of box.querySelectorAll('[name=pe-bg]')) r.checked = r.value === P.bg;
        box.querySelector('.pe-bg').classList.toggle('off', !P.removeBg);
      };
      const bgColor = () => (P.bg === 'paper' ? hexRgb(paper) : [1, 1, 1]);
      const maskFor = () => {
        if (!P.removeBg) return null;
        if (!maskCache || maskCache.tol !== P.tolerance) maskCache = { tol: P.tolerance, mask: bgMask(prev, P.tolerance) };
        const kept = maskCache.mask.kept;
        warn.hidden = kept > 0.02 && kept < 0.97;
        warn.textContent = kept >= 0.97 ? 'No background found: try a higher “how much counts as background”, or a photo on a plainer background.' : 'Almost everything was taken out: lower “how much counts as background”.';
        return maskAt(maskCache.mask, prev.w, prev.h, P.soften);
      };
      let raf = 0, holding = false;
      const draw = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          if (holding) { g.drawImage(img, 0, 0, prev.w, prev.h); return; }
          const needMask = P.removeBg && (!maskCache || maskCache.tol !== P.tolerance);
          busy.hidden = !needMask;
          setTimeout(() => { g.putImageData(render(prev, P, maskFor(), bgColor()), 0, 0); busy.hidden = true; }, needMask ? 30 : 0);
        });
      };
      const done = (v) => { box.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      document.addEventListener('keydown', onKey);
      box.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.k === 'removeBg' && t.checked && !P.tolTouched) {   // first time on: find a good setting
          P.removeBg = true; busy.hidden = false; sync();
          setTimeout(() => { const a = autoTolerance(prev); P.tolerance = a.tolerance; maskCache = a.mask ? { tol: a.tolerance, mask: a.mask } : null; sync(); draw(); }, 30);
          return;
        }
        if (t.dataset.k === 'tolerance') P.tolTouched = true;
        if (t.dataset.k) { P[t.dataset.k] = t.type === 'checkbox' ? t.checked : +t.value; }
        else if (t.name === 'pe-bg') P.bg = t.value;
        else return;
        sync(); draw();
      });
      box.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-pe]'); if (!b) return;
        const a = b.dataset.pe;
        if (a === 'cancel') done(null);
        else if (a === 'reset') { Object.assign(P, DEF); sync(); draw(); }
        else if (a === 'auto') { Object.assign(P, autoFix(prev, P.removeBg ? maskFor() : null)); sync(); draw(); }
        else if (a === 'apply') {
          b.disabled = true; b.textContent = 'Making the photo…';
          await new Promise((r) => setTimeout(r, 30));
          const full = pixels(img, FINAL);
          const m = P.removeBg ? maskAt(maskCache && maskCache.tol === P.tolerance ? maskCache.mask : bgMask(prev, P.tolerance), full.w, full.h, P.soften) : null;
          const c = document.createElement('canvas'); c.width = full.w; c.height = full.h;
          c.getContext('2d').putImageData(render(full, P, m, bgColor()), 0, 0);
          done({ dataUrl: c.toDataURL('image/jpeg', 0.92), params: { ...P } });
        }
      });
      const hold = box.querySelector('[data-pe=hold]');
      const on = () => { holding = true; draw(); }, off = () => { if (holding) { holding = false; draw(); } };
      hold.addEventListener('pointerdown', on); hold.addEventListener('pointerup', off); hold.addEventListener('pointerleave', off);
      hold.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); on(); } });
      hold.addEventListener('keyup', off);
      sync(); draw();
      box.querySelector('[data-pe=auto]').focus();
    });
  }

  const api = { open, autoFix, bgMask, autoTolerance, render, DEF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhotoEdit = api;
})(typeof window !== 'undefined' ? window : globalThis);
