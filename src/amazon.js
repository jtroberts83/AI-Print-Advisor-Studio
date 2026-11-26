'use strict';
// Amazon order history → filament orders, read in the app's own Amazon window (see main.js "amazon-*").
// The person signs in to Amazon themselves in that window; the app never sees the password. The app only OPENS
// order-history and order-details pages and reads them: it never clicks, buys, cancels or changes anything.
// The approach (order list per year → details page per order; selectors tried newest layout first) follows
// amazon-order-history-csv-download-mcp by Marcus Quinn (MIT licence, see THIRD-PARTY-NOTICES.md); this is a separate,
// smaller implementation with no dependency on it.

// Amazon stores. lang: asks Amazon for English pages where the store offers them (the reader also knows other languages).
const STORES = [
  { domain: 'amazon.com', name: 'United States', cur: 'USD', lang: 'en_US' },
  { domain: 'amazon.ca', name: 'Canada', cur: 'CAD', lang: 'en_CA' },
  { domain: 'amazon.com.mx', name: 'Mexico', cur: 'MXN', lang: '' },
  { domain: 'amazon.com.br', name: 'Brazil', cur: 'BRL', lang: '' },
  { domain: 'amazon.co.uk', name: 'United Kingdom', cur: 'GBP', lang: 'en_GB' },
  { domain: 'amazon.ie', name: 'Ireland', cur: 'EUR', lang: '' },
  { domain: 'amazon.de', name: 'Germany', cur: 'EUR', lang: 'en_GB' },
  { domain: 'amazon.fr', name: 'France', cur: 'EUR', lang: 'en_GB' },
  { domain: 'amazon.es', name: 'Spain', cur: 'EUR', lang: 'en_GB' },
  { domain: 'amazon.it', name: 'Italy', cur: 'EUR', lang: 'en_GB' },
  { domain: 'amazon.nl', name: 'Netherlands', cur: 'EUR', lang: 'en_GB' },
  { domain: 'amazon.com.be', name: 'Belgium', cur: 'EUR', lang: 'en_GB' },
  { domain: 'amazon.se', name: 'Sweden', cur: 'SEK', lang: 'en_GB' },
  { domain: 'amazon.pl', name: 'Poland', cur: 'PLN', lang: '' },
  { domain: 'amazon.com.tr', name: 'Türkiye', cur: 'TRY', lang: '' },
  { domain: 'amazon.ae', name: 'United Arab Emirates', cur: 'AED', lang: 'en_AE' },
  { domain: 'amazon.sa', name: 'Saudi Arabia', cur: 'SAR', lang: 'en_AE' },
  { domain: 'amazon.eg', name: 'Egypt', cur: 'EGP', lang: 'en_AE' },
  { domain: 'amazon.in', name: 'India', cur: 'INR', lang: 'en_IN' },
  { domain: 'amazon.co.jp', name: 'Japan', cur: 'JPY', lang: 'en_US' },
  { domain: 'amazon.sg', name: 'Singapore', cur: 'SGD', lang: '' },
  { domain: 'amazon.com.au', name: 'Australia', cur: 'AUD', lang: 'en_AU' },
];
const store = (domain) => STORES.find((s) => s.domain === domain) || null;
const withLang = (s, url) => (s.lang ? `${url}${url.includes('?') ? '&' : '?'}language=${s.lang}` : url);
const listUrl = (s, year, start) => withLang(s, `https://www.${s.domain}/your-orders/orders?timeFilter=year-${year}${start ? `&startIndex=${start}` : ''}`);
const detailUrl = (s, id) => withLang(s, `https://www.${s.domain}/gp/your-account/order-details?orderID=${encodeURIComponent(id)}`);

// a host the Amazon window may show: the store itself and Amazon's own sign-in / image hosts
function amazonHost(host) {
  host = String(host || '').toLowerCase();
  return STORES.some((s) => host === s.domain || host.endsWith('.' + s.domain)) || /(^|\.)(media-amazon|ssl-images-amazon|images-amazon|amazon-adsystem)\.com$/.test(host)
    || /(^|\.)amazon\.(com|co\.[a-z]{2}|[a-z]{2,3})$/.test(host);
}
// a page that needs the person (sign in, a code, a puzzle)
const needsPerson = (url) => /\/ap\/(signin|cvf|mfa|challenge)|\/errors\/validateCaptcha|\/ax\/claim|\/ap\/accountfixup/i.test(String(url || ''));
const imageHostOk = (host) => /(^|\.)(media-amazon|ssl-images-amazon|images-amazon)\.com$/i.test(String(host || ''));
// Amazon picture URLs carry a size code (._AC_SX100_.); ask for a 500 px one
const bigImage = (url) => String(url || '').replace(/\._[A-Z0-9_,]+_\.(jpe?g|png|webp)$/i, '._SL500_.$1');

// "1.234,56 €", "$1,234.56", "￥2,480", "₹ 1,299.00" → 1234.56
function parsePrice(text) {
  const m = /(?:[$£€¥￥₹]|R\$|CHF|zł|kr|SEK|PLN|TRY|AED|SAR|EGP|MXN|CAD|AUD|SGD|USD|EUR|GBP|INR|JPY|TL)?\s*([0-9][0-9.,'\s]*[0-9]|[0-9])\s*(?:[$£€¥￥₹]|zł|kr|TL)?/.exec(String(text || '').replace(/\u00a0/g, ' '));
  if (!m) return null;
  let n = m[1].replace(/[\s']/g, '');
  const lastDot = n.lastIndexOf('.'), lastComma = n.lastIndexOf(',');
  const dec = Math.max(lastDot, lastComma);
  if (dec > -1 && n.length - dec - 1 === 2) n = n.slice(0, dec).replace(/[.,]/g, '') + '.' + n.slice(dec + 1);   // 2 decimals
  else n = n.replace(/[.,]/g, '');   // only thousands separators (or yen)
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : null;
}
// a price written with a currency mark, anywhere in a text
const PRICE_RE = /(?:[$£€¥￥₹]|R\$|zł|kr|TL|AED|SAR|EGP)\s?[0-9][0-9.,'\u00a0 ]*[0-9]|[0-9][0-9.,'\u00a0 ]*[0-9]\s?(?:€|zł|kr|TL|₹)/;

const MONTHS = [   // January … December in the languages Amazon stores use (first letters are enough)
  ['jan', 'janv', 'ene', 'gen', 'januar', 'jänner', 'jan', 'sty', 'oca'],
  ['feb', 'févr', 'fevr', 'fev', 'febr', 'lut', 'şub', 'sub'],
  ['mar', 'mär', 'mrt', 'mars', 'marz', 'março', 'marco', 'mart'],
  ['apr', 'avr', 'abr', 'kwi', 'nis'],
  ['may', 'mai', 'mei', 'mag', 'maj', 'mayo', 'mayıs', 'mayis', 'maio'],
  ['jun', 'juin', 'giu', 'juni', 'cze', 'haz'],
  ['jul', 'juil', 'lug', 'juli', 'lip', 'tem'],
  ['aug', 'août', 'aout', 'ago', 'sie', 'ağu', 'agu'],
  ['sep', 'sept', 'set', 'wrz', 'eyl'],
  ['oct', 'okt', 'ott', 'out', 'paź', 'paz', 'eki'],
  ['nov', 'lis', 'kas'],
  ['dec', 'déc', 'dic', 'dez', 'dez', 'gru', 'ara'],
];
function monthOf(word) {
  const w = String(word || '').toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return 0;
  for (let i = 0; i < 12; i++) if (MONTHS[i].some((m) => w.startsWith(m) || (m.length >= 4 && m.startsWith(w)))) return i + 1;
  return 0;
}
const iso = (y, m, d) => (y > 1990 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
// the first date in a text: "November 3, 2024", "3 November 2024", "3. November 2024", "3 de noviembre de 2024",
// "2024年11月3日", "2024/11/03", "03.11.2024", "03/11/2024" (day first outside the US)
function parseDate(text, domain = 'amazon.com') {
  const t = String(text || '').replace(/\u00a0/g, ' ').replace(/([a-zà-ÿ])([A-ZÀ-Þ])/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2');   // 'placedNovember', '2026Total'
  let m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(t);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /\b(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\b/.exec(t);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /\b([A-Za-zÀ-ÿçğışöüÇĞİŞÖÜąćęłńóśźżÄÖÜä]{3,}\.?)\s+(\d{1,2}),?\s+(\d{4})\b/.exec(t);   // Month D, YYYY
  if (m && monthOf(m[1])) return iso(+m[3], monthOf(m[1]), +m[2]);
  m = /\b(\d{1,2})\.?\s+(?:de\s+)?([A-Za-zÀ-ÿçğışöüÇĞİŞÖÜąćęłńóśźżÄÖÜä]{3,}\.?)\s+(?:de\s+)?(\d{4})\b/.exec(t);   // D Month YYYY
  if (m && monthOf(m[2])) return iso(+m[3], monthOf(m[2]), +m[1]);
  m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(t);
  if (m) return domain === 'amazon.com' ? iso(+m[3], +m[1], +m[2]) : iso(+m[3], +m[2], +m[1]);
  return null;
}

// does a product title look like 3D-printer filament (not a printer, dryer, nozzle, holder…)?
const MATERIAL = /\b(PLA\+?|PETG|PCTG|ABS|ASA|TPU|TPE|PA(?:6|12)?(?:-CF)?|PC|PVA|HIPS|PET|Nylon|PP|PEEK|PEI)\b/i;
function isFilament(title) {
  const t = String(title || '');
  const weight = /\b\d+(?:[.,]\d+)?\s?kg\b|\b\d{3,4}\s?g\b/i.test(t);
  const fil = /filament|filamento|フィラメント|filamentu/i.test(t), spool = weight || /\bspools?\b|\b1[.,]75\s?mm\b|\b2[.,]85\s?mm\b/i.test(t);
  if (!(fil || (MATERIAL.test(t) && spool))) return false;
  // things for filament rather than filament (dryers, holders, cutters, nozzles, storage) and printers, unless a
  // spool weight says it's filament. Claude skips anything else that isn't filament when it reads the list.
  if (!weight && /\b(dryer|dry ?box|dehydrator|holder|rack|cutter|sensor|nozzles?|hot ?end|extruder|storage|vacuum|desiccant|empty spool|guide|runout|buffer|enclosure|3d pen|build plate|print bed|auto[- ]?level|build volume|printing speed)\b/i.test(t)) return false;
  return true;
}

// Run inside an order-list page: every order card's id, date text, status words and items (title, ASIN, picture).
// Works on the 2024+ layout (data-component) and the older ones (.order-card / .js-order-card / .a-box-group).
const LIST_SCRIPT = `(() => {
  const asinOf = (h) => { const m = /\\/(?:dp|gp\\/product|gp\\/aw\\/d)\\/([A-Z0-9]{10})/.exec(h || ''); return m ? m[1] : null; };
  const pick = (sel) => [...document.querySelectorAll(sel)];
  let cards = [];
  for (const sel of ['[data-component="orderCard"]', '.js-order-card', '.order-card', '.a-box-group.order', '#ordersContainer .a-box-group']) { cards = pick(sel); if (cards.length) break; }
  const orders = cards.map((c) => {
    const text = c.innerText || '';
    const idm = /\\b(\\d{3}-\\d{7}-\\d{7})\\b/.exec(text) || /orderI[Dd]=(\\d{3}-\\d{7}-\\d{7})/.exec(c.innerHTML);
    const head = c.querySelector('.order-header, [data-component="orderHeader"], .a-box:first-child') || c;
    const items = new Map();
    for (const a of c.querySelectorAll('a[href]')) {
      const asin = asinOf(a.getAttribute('href')); if (!asin) continue;
      const it = items.get(asin) || { asin, title: '', image: '' };
      const t = (a.innerText || '').trim(); if (t.length > it.title.length) it.title = t;
      const img = a.querySelector('img'); if (img) { it.image = it.image || img.currentSrc || img.src || ''; if (!it.title && img.alt) it.title = img.alt.trim(); }
      items.set(asin, it);
    }
    return { id: idm ? idm[1] : null, head: (head.innerText || '').slice(0, 600), text: text.slice(0, 3000), items: [...items.values()] };
  }).filter((o) => o.id);
  const next = !!document.querySelector('.a-pagination .a-last:not(.a-disabled) a');
  return { url: location.href, orders, next, signin: !!document.querySelector('#ap_email, #signInSubmit, input[name="email"]') };
})()`;

// Run inside an order-details page: for each item (by ASIN) its quantity and unit price, the price text near it.
const DETAIL_SCRIPT = `(() => {
  const asinOf = (h) => { const m = /\\/(?:dp|gp\\/product|gp\\/aw\\/d)\\/([A-Z0-9]{10})/.exec(h || ''); return m ? m[1] : null; };
  const out = {};
  const links = [...document.querySelectorAll('a[href]')].filter((a) => asinOf(a.getAttribute('href')));
  for (const a of links) {
    const asin = asinOf(a.getAttribute('href'));
    if (out[asin] && out[asin].price) continue;
    // the biggest box around this link that is about this one product only
    let box = a, el = a;
    while (el.parentElement && el.parentElement !== document.body) {
      el = el.parentElement;
      const others = [...el.querySelectorAll('a[href]')].map((x) => asinOf(x.getAttribute('href'))).filter((x) => x && x !== asin);
      if (others.length) break;
      box = el;
    }
    const q = box.querySelector('.od-item-view-qty span, [data-component="quantity"], .item-view-qty');
    const qtext = (q && q.innerText) || '';
    const qm = /(\\d+)/.exec(qtext) || /(?:Qty|Quantity|Menge|Quantité|Cantidad|Quantità|Aantal|数量|Antal|Ilość)\\s*[:：]?\\s*(\\d+)/i.exec(box.innerText || '');
    const pe = box.querySelector('[data-component="unitPrice"] .a-offscreen, [data-component="unitPrice"], .a-color-price, .a-price .a-offscreen');
    const img = box.querySelector('img');
    const title = (a.innerText || '').trim();
    out[asin] = { qty: qm ? +qm[1] : 1, price: ((pe && pe.innerText) || (pe && pe.textContent) || '').trim(), text: (box.innerText || '').slice(0, 800),
      title: title.length > ((out[asin] && out[asin].title) || '').length ? title : (out[asin] && out[asin].title) || '', image: (img && (img.currentSrc || img.src)) || (out[asin] && out[asin].image) || '' };
  }
  const st = document.querySelector('[data-component="shipments"], [data-component="shipmentStatus"], .delivery-box, #orderDetails, .od-shipments');
  return { url: location.href, items: out, status: ((st && st.innerText) || document.body.innerText || '').slice(0, 3000), signin: !!document.querySelector('#ap_email, #signInSubmit, input[name="email"]') };
})()`;

// words on an order card that mean it hasn't arrived yet
const NOT_ARRIVED = /\b(arriving|out for delivery|not yet shipped|shipped|on the way|preparing for shipment|expected|lieferung voraussichtlich|unterwegs|en cours|arrivée prévue|llega|in arrivo|verwacht|配送中|お届け予定)\b/i;

// one order card + its details → the order's filament items
function orderItems(card, detail, domain) {
  const date = parseDate(card.head, domain) || parseDate(card.text, domain);
  const ordered = NOT_ARRIVED.test(card.text) && !/\bdelivered\b|zugestellt|livré|entregado|consegnato|bezorgd|配達済/i.test(card.head + ' ' + card.text.slice(0, 400));
  const seen = new Map(card.items.map((i) => [i.asin, i]));
  if (detail) for (const [asin, d] of Object.entries(detail.items || {})) if (!seen.has(asin) && d.title) seen.set(asin, { asin, title: d.title, image: d.image });
  const out = [];
  for (const it of seen.values()) {
    const d = (detail && detail.items && detail.items[it.asin]) || {};
    const title = (it.title || d.title || '').trim();
    if (!isFilament(title)) continue;
    const priceText = d.price || ((PRICE_RE.exec(d.text || '') || [])[0]) || '';
    out.push({ order: card.id, asin: it.asin, title, date, qty: Math.max(1, Math.min(99, d.qty || 1)), price: parsePrice(priceText), image: bigImage(it.image || d.image || ''),
      url: `https://www.${domain}/dp/${it.asin}`, ordered });
  }
  return out;
}

// ---------- Claude reads the filament order lines (title, quantity, price, picture) into inventory rows ----------
// The same lists as the Filament screen (renderer/filament/inventory.js FIL_TYPES, FINISHES, FAMS): keep them in step.
const FIL_TYPES = ['PLA', 'PETG', 'PCTG', 'TPU', 'ABS', 'ASA', 'PLA-CF', 'PETG-CF', 'Nylon', 'Other'];
const FINISHES = ['Standard', 'Matte', 'Silk', 'Translucent', 'Gradient', 'Metallic', 'Galaxy', 'Carbon Fiber', 'Wood', 'Color Change'];
const FAMILIES = ['Red', 'Orange', 'Yellow', 'Gold', 'Green', 'Teal', 'Blue', 'Purple', 'Pink', 'Brown', 'Beige', 'White', 'Grey', 'Silver', 'Black', 'Clear', 'Multicolor'];
const CLAUDE_MODEL = 'claude-opus-5-5';
const CLAUDE_PRICE = { in: 4, out: 20 };   // $ per million tokens, only for the cost shown
const READ_SCHEMA = { type: 'object', additionalProperties: false, required: ['items', 'notes'], properties: {
  items: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['item', 'brand', 'type', 'line', 'finish', 'color', 'families', 'hex', 'grams', 'spools', 'price_each', 'note'],
    properties: { item: { type: 'integer' }, brand: { type: 'string' }, type: { type: 'string', enum: FIL_TYPES }, line: { type: 'string' },
      finish: { type: 'string', enum: FINISHES }, color: { type: 'string' },
      families: { type: 'array', items: { type: 'string', enum: FAMILIES } }, hex: { type: 'array', items: { type: 'string' } },
      grams: { type: 'integer' }, spools: { type: 'integer' }, price_each: { anyOf: [{ type: 'number' }, { type: 'null' }] }, note: { type: 'string' } } } },
  notes: { type: 'string' } } };
const READ_SYSTEM = `You read 3D-printer filament products from someone's Amazon order history (the product title, the quantity ordered, the price per unit, and the product picture) so they can be added to a home filament inventory.

Return one entry per distinct filament color, with item set to the number of the order line it came from:
- spools: the total spools of that color: quantity ordered × spools of that color in one pack. For a bundle of several colors (e.g. "4 pack, black white grey red"), make one entry per color with its own spool count; read the colors from the title and the picture.
- grams: filament per spool (1 kg = 1000). Use 1000 when the size isn't stated.
- price_each: the unit price × quantity divided by all the spools of that order line (so a bundle's price is split across its spools). null when no price is given.
- brand is the manufacturer. line is the product line without the brand, type or color (for example "Panchroma Matte", "PLA+ HS", "Rapid PETG"); use the type itself when there is no line name. finish is the closest allowed value ("Standard" when nothing special is stated).
- color: the color name as the seller writes it. families: one or more color groups. "Clear" for transparent, "Multicolor" for gradient, dual- or tri-color filament.
- hex: your best estimate of the color as "#rrggbb", from the picture or the color name. Two or three values for gradient or multi-color filament, otherwise one.
- note: anything the person should double-check (a guessed color in a bundle, a guessed spool size); otherwise "".

Skip order lines that aren't filament (printers, dryers, nozzles, tools). notes: one short sentence about anything you skipped or weren't sure of, otherwise "".

When a brand and product line match one in the known list in the message, use exactly that spelling.`;
// src: order lines from orderItems (+ photo data URLs); call(body) sends a request to Claude (main.js filamentClaude)
async function readWithClaude(src, currency, known, call, progress = () => {}) {
  const items = [], notes = []; let cost = 0;
  const isHex = (h) => /^#[0-9a-f]{6}$/i.test(h);
  for (let b = 0; b < src.length; b += 20) {   // 20 order lines per request
    const part = src.slice(b, b + 20), content = [];
    part.forEach((s, j) => {
      content.push({ type: 'text', text: `Order line ${b + j + 1}: "${s.title}" · quantity ${s.qty}${s.price != null ? ` · ${s.price} ${currency} each` : ''}` });
      const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(s.photo || '');
      if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    });
    content.push({ type: 'text', text: 'List the filament in these order lines (item = the order line number).' + (known && known.length ? '\n\nKnown brand | product line names:\n' + known.join('\n') : '') });
    progress(b, src.length);
    const resp = await call({ model: CLAUDE_MODEL, max_tokens: 16000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: READ_SCHEMA } }, system: READ_SYSTEM, messages: [{ role: 'user', content }] });
    if (resp.stop_reason === 'refusal') throw new Error('Claude declined to read these products.');
    let out; try { out = JSON.parse(resp.content.filter((x) => x.type === 'text').map((x) => x.text).join('')); } catch { throw new Error('Claude’s answer couldn’t be read. Try again.'); }
    const u = resp.usage || {};
    cost += ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1) * CLAUDE_PRICE.in / 1e6 + (u.output_tokens || 0) * CLAUDE_PRICE.out / 1e6;
    if (out.notes) notes.push(out.notes);
    for (const it of out.items || []) {
      if (!src[it.item - 1]) continue;
      items.push({ ...it, hex: (it.hex || []).filter(isHex).length ? it.hex.filter(isHex).slice(0, 3) : ['#888888'], families: (it.families || []).filter((f) => FAMILIES.includes(f)),
        grams: it.grams > 0 ? it.grams : 1000, spools: Math.max(0, it.spools | 0), price: it.price_each ?? '', line_no: it.item - 1 });
    }
  }
  return { items, notes: notes.join(' '), cost };
}
// no API key: one row per order line from its title (the person fills in the color)
function guessItems(src) {
  return src.map((s, i) => {
    const t = s.title, type = FIL_TYPES.find((x) => new RegExp(`\\b${x}\\b`, 'i').test(t)) || 'Other';
    const kg = /\b(\d+(?:[.,]\d+)?)\s?kg\b/i.exec(t), g = /\b(\d{3,4})\s?g\b/i.exec(t);
    const pm = /\b(\d{1,2})\s?-?\s?(?:pack|pcs|rolls|spools)\b/i.exec(t), pack = pm ? Math.max(1, Math.min(20, +pm[1])) : 1;
    const kgv = kg ? parseFloat(kg[1].replace(',', '.')) : 0;
    return { brand: (t.split(/\s+/)[0] || '').replace(/[^\p{L}\p{N}+-]/gu, ''), type, line: type, finish: FINISHES.find((f) => f !== 'Standard' && new RegExp(`\\b${f}\\b`, 'i').test(t)) || 'Standard',
      color: '', families: [], hex: ['#888888'], grams: kgv ? Math.round(kgv * 1000 / (pack > 1 && kgv >= pack ? pack : 1)) : g ? +g[1] : 1000,
      spools: s.qty * pack, price: s.price == null ? '' : Math.round(s.price / pack * 100) / 100,
      note: `Fill in the color${pack > 1 ? `s (a pack of ${pack})` : ''}: ${t.slice(0, 140)}`, line_no: i };
  });
}
// an order page that says it was delivered
const DELIVERED = /\bdelivered\b|zugestellt|livré|entregado|consegnato|bezorgd|levererad|dostarczono|teslim edildi|配達済|お届け済/i;

module.exports = { FIL_TYPES, FINISHES, FAMILIES, READ_SYSTEM, READ_SCHEMA, readWithClaude, guessItems, DELIVERED, STORES, store, listUrl, detailUrl, amazonHost, needsPerson, imageHostOk, bigImage, parsePrice, parseDate, isFilament, orderItems, LIST_SCRIPT, DETAIL_SCRIPT };
