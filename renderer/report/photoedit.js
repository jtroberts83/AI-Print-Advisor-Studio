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

  // ---------------------------------------------------------------- the cut-out mask, fix-ups
  const GRID = 2048;   // the mask is kept at up to 2048 px on the long side, in the photo's shape
  const gridSize = (img) => { const k = Math.min(1, GRID / Math.max(img.naturalWidth, img.naturalHeight)); return [Math.max(1, Math.round(img.naturalWidth * k)), Math.max(1, Math.round(img.naturalHeight * k))]; };
  // part of the photo (rect: [x0, y0, x1, y1] as fractions) squeezed to the AI's square input
  function squeezedPart(img, rect, flip = false) {
    const c = document.createElement('canvas'); c.width = AI; c.height = AI;
    const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high';
    const W = img.naturalWidth, H = img.naturalHeight;
    if (flip) { g.translate(AI, 0); g.scale(-1, 1); }
    g.drawImage(img, rect[0] * W, rect[1] * H, (rect[2] - rect[0]) * W, (rect[3] - rect[1]) * H, 0, 0, AI, AI);
    return g.getImageData(0, 0, AI, AI).data;
  }
  // the AI's square mask for a part of the photo, placed in a full-photo mask (outside the part: background)
  function placeMask(sq, rect, GW, GH) {
    const m = new Float32Array(GW * GH);
    const x0 = Math.round(rect[0] * GW), y0 = Math.round(rect[1] * GH), x1 = Math.round(rect[2] * GW), y1 = Math.round(rect[3] * GH);
    const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0), sub = maskAt(sq, bw, bh, 0);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const gx = x0 + x, gy = y0 + y; if (gx < GW && gy < GH) m[gy * GW + gx] = sub[y * bw + x]; }
    return { w: GW, h: GH, m };
  }
  // tidy the AI's mask: faint haze becomes clear, near-solid becomes solid, and loose bits of background away from
  // the model (anything much smaller than the biggest piece) are removed
  function tidy(mask) {
    const { w, h, m } = mask, n = w * h;
    for (let i = 0; i < n; i++) m[i] = m[i] < 0.06 ? 0 : m[i] > 0.94 ? 1 : m[i];
    const lab = new Int32Array(n), area = [0], stack = new Int32Array(n);
    let next = 0;
    for (let i = 0; i < n; i++) {
      if (m[i] < 0.5 || lab[i]) continue;
      next++; let sp = 0, a = 0; stack[sp++] = i; lab[i] = next;
      while (sp) {
        const j = stack[--sp]; a++;
        const x = j % w;
        if (x > 0 && !lab[j - 1] && m[j - 1] >= 0.5) { lab[j - 1] = next; stack[sp++] = j - 1; }
        if (x < w - 1 && !lab[j + 1] && m[j + 1] >= 0.5) { lab[j + 1] = next; stack[sp++] = j + 1; }
        if (j >= w && !lab[j - w] && m[j - w] >= 0.5) { lab[j - w] = next; stack[sp++] = j - w; }
        if (j < n - w && !lab[j + w] && m[j + w] >= 0.5) { lab[j + w] = next; stack[sp++] = j + w; }
      }
      area.push(a);
    }
    if (next < 2) return mask;
    let big = 0; for (const a of area) if (a > big) big = a;
    const keep = area.map((a) => a >= big * 0.03);
    const kept = new Float32Array(n);
    for (let i = 0; i < n; i++) { if (lab[i] && !keep[lab[i]]) m[i] = 0; else if (lab[i]) kept[i] = 1; }
    const near = boxBlur(kept, w, h, Math.max(2, Math.round(Math.max(w, h) / 400)));   // the soft edge next to a kept piece stays
    for (let i = 0; i < n; i++) if (m[i] < 0.5 && near[i] <= 0.001) m[i] = 0;
    return mask;
  }
  // the closer look only sharpens the edges: it can't add anything the first look left out (zoomed in, the AI
  // can take a reflection or a shadow for part of the model)
  function within(close, first) {
    const { w, h } = first, keep = new Float32Array(w * h);
    for (let i = 0; i < keep.length; i++) keep[i] = first.m[i] >= 0.5 ? 1 : 0;
    const near = boxBlur(keep, w, h, Math.max(2, Math.round(Math.max(w, h) / 300)));
    for (let i = 0; i < keep.length; i++) if (near[i] < 0.02) close.m[i] = 0;
    return close;
  }
  // a copy of the mask with everything outside the box (fractions) removed
  function clip(mask, rect) {
    const { w, h } = mask, m = mask.m.slice();
    const x0 = Math.floor(rect[0] * w), y0 = Math.floor(rect[1] * h), x1 = Math.ceil(rect[2] * w), y1 = Math.ceil(rect[3] * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < x0 || x >= x1 || y < y0 || y >= y1) m[y * w + x] = 0;
    return { w, h, m };
  }
  const union = (a, b) => { const m = a.m.slice(); for (let i = 0; i < m.length; i++) if (b.m[i] > m[i]) m[i] = b.m[i]; return { w: a.w, h: a.h, m }; };
  // the box around what the mask keeps (fractions), or null
  function bboxOf(mask) {
    const { w, h, m } = mask; let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x] >= 0.5) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 < 0 ? null : [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h];
  }
  // a photo at preview size as a data URL (for Claude), optionally with the cut-out shown on bright green
  function previewUrl(px, P, mask) {
    const c = document.createElement('canvas'); c.width = px.w; c.height = px.h;
    c.getContext('2d').putImageData(mask ? render(px, { ...DEF }, mask, [0, 1, 0]) : render(px, { ...DEF }, null, null), 0, 0);
    return c.toDataURL('image/jpeg', 0.88);
  }
  // brush edits on top of the mask: ew = how much the edit counts (0..1), ev = the alpha it sets (0 erase, 1 restore)
  function applyEdits(a, ew, ev) { const out = a.slice(); for (let i = 0; i < out.length; i++) if (ew[i]) out[i] = out[i] * (1 - ew[i]) + ev[i] * ew[i]; return out; }

  // cutout: { status(), download(onProgress), run(rgba) } from the window (the AI model runs in the app, not here).
  // paper: the certificate's color, shown behind the model in the preview.
  function open({ src, params, paper = '#fffdf6', cutout = null }) {
    return new Promise(async (resolve) => {
      let img;
      try { img = await loadImg(src); } catch (e) { resolve(null); return; }
      const P = { ...DEF, brush: 28, ...(params || {}) };
      delete P.tolerance; delete P.bg; delete P.tolTouched;   // from the old background remover
      const prev = pixels(img, PREVIEW), [GW, GH] = gridSize(img);
      let grid = null, aiBusy = false;   // the cut-out mask at grid size ({ w, h, m }), made by the AI
      let ew = new Float32Array(prev.w * prev.h), ev = new Float32Array(prev.w * prev.h), edited = false;   // brush edits, preview size
      let tool = null, base = null;   // base: the mask at preview size (cached)
      const undo = [];
      let st = cutout ? await cutout.status().catch(() => null) : null;
      const cl = cutout && cutout.claudeInfo ? await cutout.claudeInfo().catch(() => null) : null;   // { hasKey, usd, tour }
      const paperOk = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\))$/i.test(paper) ? paper : '#ffffff';
      const box = document.createElement('div');
      box.className = 'pe-wrap';
      box.innerHTML = `<div class="pe" role="dialog" aria-modal="true" aria-label="Touch up the photo">
        <div class="pe-view" style="--pe-paper:${esc(paperOk)}"><canvas width="${prev.w}" height="${prev.h}" aria-label="Preview"></canvas><div class="pe-busy" hidden></div><div class="pe-cursor" hidden></div><div class="pe-sel" hidden></div><div class="pe-marks"></div></div>
        <div class="pe-side">
          <h2>Touch up the photo</h2>
          <div class="pe-row"><button class="btn primary" data-pe="auto" title="Sets the sliders from this photo’s brightness and colors. Adjust them after if you like.">✨ Auto-fix</button>
            <button class="btn" data-pe="hold" title="Hold to see the original">👁 Hold to compare</button><button class="link" data-pe="reset">Reset</button></div>
          ${SLIDERS.map(([k, label, lo, hi]) => `<label class="pe-sl"><span>${esc(label)} <output data-out="${k}">${P[k]}</output></span><input type="range" data-k="${k}" min="${lo}" max="${hi}" value="${P[k]}"></label>`).join('')}
          <fieldset class="pe-bg"><legend><label><input type="checkbox" data-k="removeBg" ${P.removeBg ? 'checked' : ''}> Remove the background</label></legend>
            <p class="muted small pe-what">An AI model on this PC finds your model in the photo and takes the background away; the certificate’s own color shows behind it.</p>
            <div class="pe-dl" hidden><button class="btn primary" data-pe="download"></button><progress max="1" value="0" hidden></progress></div>
            <div class="pe-tools" hidden>
              <p class="small pe-ask"><b>Bits of background left?</b> Fix them here:</p>
              <div class="pe-row"><button class="btn" data-tool="box" title="Drag a box around your model: everything outside goes, and the AI looks again, closer">✂ Box around the model</button>
                <button class="btn" data-tool="erase" title="Paint over leftover background to remove it">🧽 Erase</button>
                <button class="btn" data-tool="restore" title="Paint over parts of your model that were removed by mistake">🖌 Restore</button></div>
              <p class="small pe-how" hidden></p>
              <label class="pe-sl pe-brush" hidden><span>Brush size <output data-out="brush">${P.brush}</output></span><input type="range" data-k="brush" min="4" max="120" value="${P.brush}"></label>
              <div class="pe-row pe-claude" hidden><button class="btn" data-pe="claude" title="Claude looks at the photo, marks the real object (not reflections, shadows or the table), the AI cuts again inside it, and Claude checks the result. Uses your API key.">✨ Let Claude fix it</button><span class="muted small pe-cost"></span></div>
              <div class="pe-row"><button class="link" data-pe="undo" disabled title="Ctrl+Z">↶ Undo</button><button class="link" data-pe="again" title="Throw away the fixes and let the AI cut out the whole photo again">Start over</button></div>
              <label class="pe-sl pe-soft"><span>Soften the edge <output data-out="soften">${P.soften}</output></span><input type="range" data-k="soften" min="0" max="10" value="${P.soften}"></label>
            </div>
            <p class="pe-warn small" hidden></p>
          </fieldset>
          <div class="pe-row pe-end"><button class="btn" data-pe="cancel">Cancel</button><button class="btn primary" data-pe="apply">Use this photo</button></div>
        </div></div>`;
      document.body.append(box);
      const view = box.querySelector('.pe-view'), cv = box.querySelector('canvas'), g = cv.getContext('2d');
      const busy = box.querySelector('.pe-busy'), warn = box.querySelector('.pe-warn'), cursor = box.querySelector('.pe-cursor'), sel = box.querySelector('.pe-sel');
      const dl = box.querySelector('.pe-dl'), dlBtn = dl.querySelector('button'), bar = dl.querySelector('progress');
      const say = (t) => { warn.textContent = t || ''; warn.hidden = !t; };
      const HOW = { box: 'Drag a box around your model on the picture. Everything outside it goes, and the AI looks again, closer.',
        erase: 'Paint over the leftover background on the picture.', restore: 'Paint over parts of your model that were taken away by mistake.' };
      const sync = () => {
        for (const el of box.querySelectorAll('[data-k]')) { const k = el.dataset.k; if (el.type === 'checkbox') el.checked = !!P[k]; else el.value = P[k]; }
        for (const o of box.querySelectorAll('[data-out]')) o.textContent = P[o.dataset.out];
        box.querySelector('.pe-bg').classList.toggle('off', !P.removeBg);
        box.querySelector('.pe-tools').hidden = !grid || !P.removeBg;
        for (const b of box.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
        const how = box.querySelector('.pe-how'); how.hidden = !tool; how.textContent = tool ? HOW[tool] : '';
        box.querySelector('.pe-brush').hidden = tool !== 'erase' && tool !== 'restore';
        box.querySelector('[data-pe=undo]').disabled = !undo.length;
        box.querySelector('.pe-claude').hidden = !cl || !cl.hasKey || cl.tour;
        if (cl && cl.usd != null) box.querySelector('.pe-cost').textContent = `about ${Math.max(1, Math.round(cl.usd * 100 * 2))}¢ (two looks), with your API key`;
        view.classList.toggle('drawing', !!tool);
        const needDl = !!cutout && !!st && !st.ready;
        dl.hidden = !needDl;
        if (needDl && !st.downloading) dlBtn.textContent = `⬇ Download the background remover (${st.mb} MB, once)`;
      };
      const baseMask = () => (base && base.soften === P.soften && base.grid === grid ? base.m : (base = { soften: P.soften, grid, m: maskAt(grid, prev.w, prev.h, P.soften) }).m);
      const maskFor = () => { if (!P.removeBg || !grid) return null; const a = baseMask(); return edited ? applyEdits(a, ew, ev) : a; };
      let raf = 0, holding = false;
      const draw = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          g.clearRect(0, 0, prev.w, prev.h);
          if (holding) { g.drawImage(img, 0, 0, prev.w, prev.h); return; }
          g.putImageData(render(prev, P, maskFor(), null), 0, 0);
        });
      };
      const marks = box.querySelector('.pe-marks');
      const showMarks = (list) => {
        marks.innerHTML = '';
        const r = cv.getBoundingClientRect(), vr = view.getBoundingClientRect();
        for (const o of list || []) {
          const d = document.createElement('div'); d.className = 'pe-mark'; d.title = o.what || '';
          Object.assign(d.style, { left: `${r.left - vr.left + o.box[0] * r.width}px`, top: `${r.top - vr.top + o.box[1] * r.height}px`, width: `${(o.box[2] - o.box[0]) * r.width}px`, height: `${(o.box[3] - o.box[1]) * r.height}px` });
          marks.append(d);
        }
      };
      const remember = () => { undo.push({ grid, ew: ew.slice(), ev: ev.slice(), edited, box: P.box }); if (undo.length > 15) undo.shift(); };
      // the AI cuts out the model: the whole photo, or just inside the box (closer, so sharper)
      async function cutOut(rect) {
        if (aiBusy) return;
        if (!cutout) { say('Background removal isn’t available here.'); P.removeBg = false; sync(); return; }
        st = await cutout.status().catch(() => st);
        if (!st || !st.ready) { say(st ? 'First, download the background remover with the button above (once). Your model is cut out right after.' : 'The background remover isn’t available right now.'); sync(); return; }
        aiBusy = true; busy.textContent = rect ? 'Looking again inside your box… (a few seconds)' : 'Finding your model in the photo… (a few seconds)'; busy.hidden = false; say('');
        showMarks(null);
        try {
          const r = rect || [0, 0, 1, 1];
          // one look: the photo and its mirror image, averaged (steadier where the AI isn't sure)
          const look = async (q) => {
            const a = await cutout.run(squeezedPart(img, q, false)), b = await cutout.run(squeezedPart(img, q, true));
            const m = new Float32Array(AI * AI);
            for (let y = 0; y < AI; y++) { const o = y * AI; for (let x = 0; x < AI; x++) m[o + x] = (a[o + x] + b[o + AI - 1 - x]) / 510; }
            return { w: AI, h: AI, m };
          };
          let gm = rect && grid ? grid : null;
          if (!gm) {   // the whole photo, then a closer look at just the model for sharper edges
            gm = tidy(placeMask(await look([0, 0, 1, 1]), [0, 0, 1, 1], GW, GH));
            const bb = bboxOf(gm);
            if (bb) {
              const mx = (bb[2] - bb[0]) * 0.05 + 0.01, my = (bb[3] - bb[1]) * 0.05 + 0.01;
              const r2 = [Math.max(0, bb[0] - mx), Math.max(0, bb[1] - my), Math.min(1, bb[2] + mx), Math.min(1, bb[3] + my)];
              if ((r2[2] - r2[0]) * (r2[3] - r2[1]) < 0.8) {
                busy.textContent = 'Looking closer at your model… (a few seconds)';
                gm = within(tidy(placeMask(await look(r2), r2, GW, GH)), gm);
              }
            }
          }
          if (rect) {   // a box: everything outside goes; inside, what was found stays and a closer look can add detail
            busy.textContent = 'Looking again inside the box… (a few seconds)';
            gm = tidy(union(clip(gm, r), placeMask(await look(r), r, GW, GH)));
          }
          grid = gm;
          P.box = rect ? r.map((v) => Math.round(v * 10000) / 10000) : null;
          let sum = 0; for (const v of grid.m) sum += v;
          if (sum / grid.m.length < 0.005) say('The AI didn’t find a model here. Try a bigger box, or a photo with the model in the middle.');
        } catch (e) { say(`Couldn’t remove the background: ${e.message || e}`); if (!grid) P.removeBg = false; }
        aiBusy = false; busy.hidden = true; sync(); draw();
      }
      const findModel = () => (grid ? Promise.resolve() : cutOut(Array.isArray(P.box) && P.box.length === 4 ? P.box : null));

      // ---- painting and the box, on the preview
      const at = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * prev.w, y: (e.clientY - r.top) / r.height * prev.h, r }; };
      const showCursor = (e) => {
        if (tool !== 'erase' && tool !== 'restore') { cursor.hidden = true; return; }
        const { r } = at(e), vr = view.getBoundingClientRect(), d = 2 * P.brush * r.width / prev.w;
        Object.assign(cursor.style, { width: `${d}px`, height: `${d}px`, left: `${e.clientX - vr.left - d / 2}px`, top: `${e.clientY - vr.top - d / 2}px` });
        cursor.hidden = false; cursor.classList.toggle('restore', tool === 'restore');
      };
      function dab(x, y) {
        const rad = P.brush, target = tool === 'restore' ? 1 : 0;
        const x0 = Math.max(0, Math.floor(x - rad)), x1 = Math.min(prev.w - 1, Math.ceil(x + rad)), y0 = Math.max(0, Math.floor(y - rad)), y1 = Math.min(prev.h - 1, Math.ceil(y + rad));
        for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
          const d = Math.hypot(px - x, py - y); if (d > rad) continue;
          const f = d < rad * 0.7 ? 1 : (rad - d) / (rad * 0.3), i = py * prev.w + px, w0 = ew[i], nw = 1 - (1 - w0) * (1 - f);
          ev[i] = nw ? (ev[i] * w0 * (1 - f) + target * f) / nw : target; ew[i] = nw;
        }
        edited = true;
      }
      let down = null;
      cv.addEventListener('pointerdown', (e) => {
        if (!tool || !grid || aiBusy) return;
        e.preventDefault(); cv.setPointerCapture(e.pointerId);
        const p = at(e); down = { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY };
        if (tool === 'erase' || tool === 'restore') { remember(); dab(p.x, p.y); draw(); sync(); }
      });
      cv.addEventListener('pointermove', (e) => {
        showCursor(e);
        if (!down) return;
        const p = at(e);
        if (tool === 'box') {
          const vr = view.getBoundingClientRect();
          Object.assign(sel.style, { left: `${Math.min(down.cx, e.clientX) - vr.left}px`, top: `${Math.min(down.cy, e.clientY) - vr.top}px`, width: `${Math.abs(e.clientX - down.cx)}px`, height: `${Math.abs(e.clientY - down.cy)}px` });
          sel.hidden = false;
        } else {
          const steps = Math.max(1, Math.ceil(Math.hypot(p.x - down.x, p.y - down.y) / Math.max(1, P.brush / 3)));
          for (let k = 1; k <= steps; k++) dab(down.x + (p.x - down.x) * k / steps, down.y + (p.y - down.y) * k / steps);
          down.x = p.x; down.y = p.y; draw();
        }
      });
      const up = async (e) => {
        if (!down) return;
        const start = down; down = null; sel.hidden = true;
        if (tool !== 'box') return;
        const p = at(e), clamp = (v) => Math.max(0, Math.min(1, v));
        const rect = [clamp(Math.min(start.x, p.x) / prev.w), clamp(Math.min(start.y, p.y) / prev.h), clamp(Math.max(start.x, p.x) / prev.w), clamp(Math.max(start.y, p.y) / prev.h)];
        if ((rect[2] - rect[0]) * prev.w < 12 || (rect[3] - rect[1]) * prev.h < 12) { say('Drag to draw the box: press, move and let go.'); return; }
        remember(); tool = null; sync();
        await cutOut(rect);
      };
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', () => { down = null; sel.hidden = true; });
      cv.addEventListener('pointerleave', () => { cursor.hidden = true; });

      const done = (v) => { box.remove(); document.removeEventListener('keydown', onKey); if (offProgress) offProgress(); resolve(v); };
      const onKey = (e) => {
        if (e.key === 'Escape') { if (tool) { tool = null; sync(); } else done(null); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && undo.length) { e.preventDefault(); box.querySelector('[data-pe=undo]').click(); }
      };
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
        const tb = e.target.closest('[data-tool]');
        if (tb) { tool = tool === tb.dataset.tool ? null : tb.dataset.tool; if (tool !== 'erase') showMarks(null); say(''); sync(); return; }
        const b = e.target.closest('[data-pe]'); if (!b) return;
        const a = b.dataset.pe;
        if (a === 'cancel') done(null);
        else if (a === 'reset') { Object.assign(P, DEF, { brush: P.brush, box: P.box, removeBg: P.removeBg }); sync(); draw(); }
        else if (a === 'auto') { Object.assign(P, autoFix(prev, maskFor())); sync(); draw(); }
        else if (a === 'undo') { const u = undo.pop(); if (u) { grid = u.grid; ew = u.ew; ev = u.ev; edited = u.edited; P.box = u.box; } sync(); draw(); }
        else if (a === 'claude') {
          if (aiBusy || !grid) return;
          b.disabled = true; say(''); showMarks(null);
          const ask = async (label) => { busy.textContent = label; busy.hidden = false; try { return await cutout.claude(previewUrl(prev, P, null), previewUrl(prev, P, maskFor())); } finally { busy.hidden = true; } };
          try {
            let r = await ask('Claude is looking at your photo…');
            let spent = r.usd || 0;
            if (!r.clean && r.box && (r.box[2] - r.box[0]) > 0.02 && (r.box[3] - r.box[1]) > 0.02) {
              remember(); ew = new Float32Array(prev.w * prev.h); ev = new Float32Array(prev.w * prev.h); edited = false;
              const pad = 0.012;   // a little room so the edge of the model isn't shaved off
              await cutOut([Math.max(0, r.box[0] - pad), Math.max(0, r.box[1] - pad), Math.min(1, r.box[2] + pad), Math.min(1, r.box[3] + pad)]);
              if (grid) { r = await ask('Claude is checking the result…'); spent += r.usd || 0; }
            }
            const cost = spent ? ` (Claude: $${spent.toFixed(3)})` : '';
            if (r.clean) say(`✓ Claude checked it: ${r.advice || 'the cut-out looks clean.'}${cost}`);
            else { showMarks(r.leftovers); say(`${r.advice || 'Some background is left.'}${r.leftovers.length ? ' The red boxes show where: use 🧽 Erase there.' : ''}${cost}`); }
          } catch (err) { say(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
          b.disabled = false; sync(); draw();
        }
        else if (a === 'again') { remember(); ew = new Float32Array(prev.w * prev.h); ev = new Float32Array(prev.w * prev.h); edited = false; tool = null; grid = null; P.box = null; sync(); await cutOut(null); }
        else if (a === 'download') {
          b.disabled = true; bar.hidden = false; say('');
          if (!offProgress && cutout.onProgress) offProgress = cutout.onProgress((got, total) => { bar.value = got / total; b.textContent = `Downloading… ${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB`; });
          b.textContent = 'Downloading…';
          try { st = await cutout.download(); P.removeBg = true; sync(); findModel(); }
          catch (err) { say(err.message || String(err)); st = await cutout.status().catch(() => st); }
          b.disabled = false; bar.hidden = true; sync();
        } else if (a === 'apply') {
          if (P.removeBg && !grid) { say(aiBusy ? 'Still finding your model… one moment.' : st && !st.ready ? 'Download the background remover first, or untick “Remove the background”.' : 'Untick “Remove the background”, or tick it again to try once more.'); return; }
          b.disabled = true; b.textContent = 'Making the photo…';
          await new Promise((r) => setTimeout(r, 30));
          const full = pixels(img, FINAL);
          let m = P.removeBg && grid ? maskAt(grid, full.w, full.h, P.soften) : null;
          if (m && edited) m = applyEdits(m, maskAt({ w: prev.w, h: prev.h, m: ew }, full.w, full.h, 0), maskAt({ w: prev.w, h: prev.h, m: ev }, full.w, full.h, 0));
          const c = document.createElement('canvas'); c.width = full.w; c.height = full.h;
          c.getContext('2d').putImageData(render(full, P, m, null), 0, 0);
          const { brush, ...keep } = P;
          // a cut-out keeps its transparency (PNG); a plain photo stays a JPEG
          done({ dataUrl: m ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92), params: keep });
        }
      });
      const hold = box.querySelector('[data-pe=hold]');
      const on = () => { holding = true; draw(); }, off = () => { if (holding) { holding = false; draw(); } };
      hold.addEventListener('pointerdown', on); hold.addEventListener('pointerup', off); hold.addEventListener('pointerleave', off);
      hold.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); on(); } });
      hold.addEventListener('keyup', off);
      sync(); draw();
      if (P.removeBg) findModel();   // reopened with the background already removed: cut it out again (inside the same box)
      box.querySelector('[data-pe=auto]').focus();
    });
  }

  const api = { open, autoFix, render, maskAt, tidy, placeMask, applyEdits, within, clip, union, DEF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhotoEdit = api;
})(typeof window !== 'undefined' ? window : globalThis);
