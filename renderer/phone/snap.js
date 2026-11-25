// The phone's page for troubleshooter photos (Phone access; src/phone/server.js /api/ts-photos, src/phone/photos.js).
// Each photo is made smaller on the phone (2000 px on the long side, JPEG) and sent to the PC right away; the app's
// print troubleshooter picks it up by itself. Opened from the troubleshooter's QR code (with a one-time pairing code
// in ?c= for a phone that isn't paired yet) or from the Filament page's 📷 button.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // this phone's key from pairing (after # in the address, then kept in the phone's storage for this address)
  const m = /(?:^#|&)k=([A-Za-z0-9_-]{20,100})/.exec(location.hash);
  if (m) { try { localStorage.setItem('aipaKey', m[1]); } catch {} }
  let KEY = null;
  try { KEY = localStorage.getItem('aipaKey'); } catch {}
  const code = new URLSearchParams(location.search).get('c');
  // ?for=cert: the photo is for a print's certificate (Print report), not the troubleshooter
  const CERT = new URLSearchParams(location.search).get('for') === 'cert';
  if (m || code) history.replaceState(null, '', location.pathname + (CERT ? '?for=cert' : ''));   // the key and the pairing code don't stay in the address
  if (CERT) {
    document.title = 'Certificate photo';
    document.querySelector('h1').textContent = 'A photo for the certificate';
    document.querySelector('.sub').innerHTML = 'It goes straight to the certificate you have open in <b>AI 3D Print Advisor Studio</b> on your PC. The newest photo is used.';
    document.querySelector('.tips').innerHTML = 'Tips: put the model on a plain background in good light (near a window works well), fill the frame, and hold the phone steady.';
  }
  const auth = KEY ? { 'x-aipa-key': KEY } : {};

  function say(html, bad) { const el = $('msg'); el.innerHTML = html; el.className = `msg${bad ? ' bad' : ''}`; el.hidden = !html; }

  async function call(path, body) {
    const init = body === undefined ? { headers: auth, credentials: 'same-origin', cache: 'no-store' }
      : { method: 'POST', headers: { 'content-type': 'application/json', 'x-aipa': '1', ...auth }, body: JSON.stringify(body), credentials: 'same-origin' };
    let r;
    try { r = await fetch(path, init); } catch { throw new Error('Can’t reach the PC. Is it on, with the app open, and is this phone on the same Wi-Fi?'); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw Object.assign(new Error('not paired'), { notPaired: j });
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  // Not paired on this address: paired on the secure one (go there), or pair now with the QR code's one-time code
  async function notPaired(j) {
    if (j.secure && location.protocol === 'http:') {
      const ok = await fetch(`${j.secure}/ping`, { cache: 'no-store', signal: AbortSignal.timeout(4000) }).then(x => x.ok, () => false);
      if (ok) { location.replace(`${j.secure}/phone/snap.html${code ? `?c=${encodeURIComponent(code)}${CERT ? '&for=cert' : ''}` : CERT ? '?for=cert' : ''}`); return; }
    }
    if (code) { location.replace(`/pair?c=${encodeURIComponent(code)}`); return; }
    say('This phone isn’t paired with the app yet. On your PC, open the print troubleshooter, click <b>📱 Take photos with your phone</b> and scan the QR code with this phone.', true);
  }

  // ---- the list of photos (newest first), with what happened to each
  let photos = [];
  const uploads = [];   // { tmp, url, state: 'up' | 'bad', error }
  const STATE = { waiting: ['', 'On the PC, waiting for the troubleshooter'], added: ['ok', 'In the troubleshooter'], sent: ['ok', 'Sent to Claude with a diagnosis'], used: ['ok', 'On a certificate'] };
  const CERT_WAIT = ['', 'On the PC, for a certificate'];
  function render() {
    const rows = [
      ...uploads.map(u => `<li><img src="${esc(u.url)}" alt=""><span class="st ${esc(u.state)}"><b>${u.state === 'up' ? 'Sending…' : 'Not sent'}</b>${u.error ? `<br>${esc(u.error)}` : ''}</span><button type="button" data-drop="${esc(u.tmp)}" aria-label="Remove" ${u.state === 'up' ? 'disabled' : ''}>✕</button></li>`),
      ...photos.map(p => {
        const [cls, text] = p.purpose === 'cert' && p.state === 'waiting' ? CERT_WAIT : STATE[p.state] || STATE.waiting;
        return `<li><img src="/api/ts-photos/${esc(p.id)}?k=${esc(encodeURIComponent(KEY || ''))}" alt="" loading="lazy"><span class="st ${cls}"><b>${esc(text)}</b><br>${esc(new Date(p.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }))} · ${esc(p.device)}</span><button type="button" data-del="${esc(p.id)}" aria-label="Delete this photo">✕</button></li>`;
      }),
    ];
    $('list').innerHTML = rows.join('');
    $('sentBox').hidden = !rows.length;
  }
  $('list').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.drop) { const i = uploads.findIndex(u => u.tmp === b.dataset.drop); if (i >= 0) { URL.revokeObjectURL(uploads[i].url); uploads.splice(i, 1); } render(); return; }
    b.disabled = true;
    try { photos = (await call('/api/ts-photos/remove', { id: b.dataset.del })).photos; render(); }
    catch (err) { b.disabled = false; say(esc(err.message), true); }
  });
  async function refresh() {
    try { photos = (await call('/api/ts-photos')).photos; $('take').hidden = false; say(''); render(); return true; }
    catch (e) { if (e.notPaired) await notPaired(e.notPaired); else say(esc(e.message), true); return false; }
  }

  // ---- taking and sending: smaller on the phone first (the right way up), then sent as JPEG
  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error(/\.hei[cf]$/i.test(file.name) || /hei[cf]/i.test(file.type)
        ? 'This browser can’t open HEIC photos. Take it with the 📷 button above, or set the camera to save JPEG (“Most compatible” on iPhone).'
        : 'This phone can’t open that picture.')); im.src = url; });
      const sc = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      if (!blob) throw new Error('This phone couldn’t prepare the picture.');
      return blob;
    } finally { URL.revokeObjectURL(url); }
  }
  const b64 = (blob) => new Promise((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = () => bad(fr.error); fr.readAsDataURL(blob); });
  async function send(file) {
    const u = { tmp: Math.random().toString(36).slice(2), url: URL.createObjectURL(file), state: 'up' };
    uploads.unshift(u); render();
    try {
      const blob = await shrink(file);
      await call('/api/ts-photos', { name: (file.name || 'Phone photo').replace(/\.[^.]+$/, ''), data: await b64(blob), purpose: CERT ? 'cert' : undefined });
      uploads.splice(uploads.indexOf(u), 1); URL.revokeObjectURL(u.url);
      await refresh();
      return true;
    } catch (e) {
      if (e.notPaired) { await notPaired(e.notPaired); return false; }
      Object.assign(u, { state: 'bad', error: e.message }); render();
      return false;
    }
  }
  // the camera, the photo picker and the file browser (several at a time from the last two), sent one by one
  for (const id of ['cam', 'pick', 'files']) {
    $(id).addEventListener('change', async (e) => {
      const files = [...e.target.files].slice(0, 30);
      e.target.value = '';
      let ok = 0;
      for (const [i, f] of files.entries()) {
        if (files.length > 1) say(`Sending ${i + 1} of ${files.length}…`);
        if (await send(f)) ok++;
      }
      if (files.length > 1) say(ok ? `✓ Sent ${ok} of ${files.length} photos to your PC.${CERT ? ' The newest one goes on the certificate.' : ' Up to 4 go into the troubleshooter; the rest wait there.'}` : 'None of them could be sent: see below.', !ok);
      else if (CERT && ok) say('✓ Sent. It’s on the certificate on your PC now.');
    });
  }

  // ---- live: the PC adds a photo to the troubleshooter, sends it to Claude, or deletes it
  function stream() {
    if (!KEY) return;
    const es = new EventSource(`/api/events?k=${encodeURIComponent(KEY)}`);
    es.addEventListener('ts-photos', (e) => { try { photos = JSON.parse(e.data); render(); } catch {} });
    es.onopen = () => refresh();
  }

  refresh().then(ok => { if (ok) stream(); });
})();
