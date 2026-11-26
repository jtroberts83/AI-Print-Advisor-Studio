const test = require('node:test');
const assert = require('node:assert');
const A = require('../src/amazon');

test('amazon: prices in the formats Amazon stores write them', () => {
  assert.strictEqual(A.parsePrice('$19.99'), 19.99);
  assert.strictEqual(A.parsePrice('$1,234.56'), 1234.56);
  assert.strictEqual(A.parsePrice('22,99 €'), 22.99);
  assert.strictEqual(A.parsePrice('EUR 1.234,50'), 1234.5);
  assert.strictEqual(A.parsePrice('￥2,480'), 2480);
  assert.strictEqual(A.parsePrice('£18.49'), 18.49);
  assert.strictEqual(A.parsePrice('₹ 1,299.00'), 1299);
  assert.strictEqual(A.parsePrice(''), null);
});

test('amazon: order dates in several languages and formats', () => {
  assert.strictEqual(A.parseDate('Order placed\nNovember 3, 2024\nTotal $45.98'), '2024-11-03');
  assert.strictEqual(A.parseDate('Order placed 3 November 2024', 'amazon.co.uk'), '2024-11-03');
  assert.strictEqual(A.parseDate('Bestellung aufgegeben 3. November 2024', 'amazon.de'), '2024-11-03');
  assert.strictEqual(A.parseDate('Commande effectuée le 12 décembre 2023', 'amazon.fr'), '2023-12-12');
  assert.strictEqual(A.parseDate('Pedido realizado 5 de marzo de 2025', 'amazon.es'), '2025-03-05');
  assert.strictEqual(A.parseDate('注文日 2024年1月5日', 'amazon.co.jp'), '2024-01-05');
  assert.strictEqual(A.parseDate('Ordered on 03/11/2024', 'amazon.co.uk'), '2024-11-03');
  assert.strictEqual(A.parseDate('Ordered on 11/03/2024', 'amazon.com'), '2024-11-03');
  assert.strictEqual(A.parseDate('Order placedNovember 20, 2026Total$59.99'), '2026-11-20');
  assert.strictEqual(A.parseDate('no date here'), null);
});

test('amazon: filament titles are found; printers, dryers and nozzles are not', () => {
  assert.ok(A.isFilament('Polymaker PLA Filament 1.75mm, Panchroma Matte PLA, 1kg Cardboard Spool - Pastel Beige'));
  assert.ok(A.isFilament('SUNLU PETG 3D Printer Filament 1.75mm, 1KG Spool, Black'));
  assert.ok(A.isFilament('ELEGOO PLA Plus Filament 4 Pack, 4kg Black White Grey Red'));
  assert.ok(A.isFilament('Overture Matte PLA 1.75mm 1kg spool'));
  assert.ok(!A.isFilament('SUNLU Filament Dryer Box S2, Upgraded Dryer for 3D Printer Filament'));
  assert.ok(!A.isFilament('0.4mm Hardened Steel Nozzles for 3D Printer Filament'));
  assert.ok(!A.isFilament('USB-C Cable 6 ft'));
  assert.ok(!A.isFilament('Bambu Lab A1 3D Printer, Auto Leveling, Build Volume 256mm, works with PLA filament'));
});

test('amazon: only Amazon pages in the Amazon window; sign-in pages need the person', () => {
  assert.ok(A.amazonHost('www.amazon.com'));
  assert.ok(A.amazonHost('www.amazon.co.uk'));
  assert.ok(A.amazonHost('m.media-amazon.com'));
  assert.ok(!A.amazonHost('evil-amazon.com.example.net'));
  assert.ok(!A.amazonHost('example.com'));
  assert.ok(A.needsPerson('https://www.amazon.com/ap/signin?openid.return_to=x'));
  assert.ok(A.needsPerson('https://www.amazon.com/errors/validateCaptcha'));
  assert.ok(!A.needsPerson('https://www.amazon.com/your-orders/orders?timeFilter=year-2024'));
  assert.ok(A.imageHostOk('m.media-amazon.com') && !A.imageHostOk('media-amazon.com.evil.net'));
  assert.strictEqual(A.bigImage('https://m.media-amazon.com/images/I/71abc._SS142_.jpg'), 'https://m.media-amazon.com/images/I/71abc._SL500_.jpg');
  assert.strictEqual(A.listUrl(A.store('amazon.de'), 2024, 10), 'https://www.amazon.de/your-orders/orders?timeFilter=year-2024&startIndex=10&language=en_GB');
});

test('amazon: an order card and its details become filament lines (quantity, unit price, date, not-yet-arrived)', () => {
  const card = { id: '111-1234567-1234567', head: 'Order placed\nOctober 2, 2025\nTotal\n$51.97',
    text: 'Order placed October 2, 2025 Arriving Friday', items: [
      { asin: 'B0AAAAAAAA', title: 'Polymaker Matte PLA Filament 1.75mm 1kg - Pastel Beige', image: 'https://m.media-amazon.com/images/I/a._SS142_.jpg' },
      { asin: 'B0BBBBBBBB', title: 'Digital Calipers 6 inch', image: '' }] };
  const detail = { items: { B0AAAAAAAA: { qty: 2, price: '$22.99', text: '' }, B0BBBBBBBB: { qty: 1, price: '$5.99' } } };
  const out = A.orderItems(card, detail, 'amazon.com');
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual({ ...out[0] }, { order: '111-1234567-1234567', asin: 'B0AAAAAAAA', title: 'Polymaker Matte PLA Filament 1.75mm 1kg - Pastel Beige', date: '2025-10-02',
    qty: 2, price: 22.99, image: 'https://m.media-amazon.com/images/I/a._SL500_.jpg', url: 'https://www.amazon.com/dp/B0AAAAAAAA', ordered: true });
});

test('amazon: without an API key, rows come from the titles (a pack is split into its spools)', () => {
  const rows = A.guessItems([{ title: 'ELEGOO PLA Plus Filament 4 Pack, 4kg Black White Grey Red, 1.75mm', qty: 1, price: 59.99 },
    { title: 'SUNLU PETG 3D Printer Filament 1.75mm, 1KG Spool, Black', qty: 2, price: 17.99 }]);
  assert.deepStrictEqual(rows.map((r) => [r.brand, r.type, r.grams, r.spools, r.price, r.line_no]), [['ELEGOO', 'PLA', 1000, 4, 15, 0], ['SUNLU', 'PETG', 1000, 2, 17.99, 1]]);
});

test('amazon: Claude rows keep their order line, colors and split prices', async () => {
  const src = [{ title: 'ELEGOO PLA Plus 4 Pack Black White', qty: 1, price: 40, photo: 'data:image/jpeg;base64,AAAA' }];
  let body = null;
  const call = async (b) => { body = b; return { stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: 'text', text: JSON.stringify({ notes: '', items: [
    { item: 1, brand: 'ELEGOO', type: 'PLA', line: 'PLA+', finish: 'Standard', color: 'Black', families: ['Black', 'Nope'], hex: ['#111111', 'bad'], grams: 1000, spools: 2, price_each: 10, note: '' },
    { item: 1, brand: 'ELEGOO', type: 'PLA', line: 'PLA+', finish: 'Standard', color: 'White', families: ['White'], hex: [], grams: 0, spools: 2, price_each: 10, note: '' },
    { item: 7, brand: 'x', type: 'PLA', line: '', finish: 'Standard', color: '', families: [], hex: [], grams: 1, spools: 1, price_each: null, note: '' }] }) }] }; };
  const r = await A.readWithClaude(src, 'USD', ['ELEGOO | PLA+'], call);
  assert.strictEqual(r.items.length, 2);
  assert.deepStrictEqual(r.items.map((x) => [x.color, x.families, x.hex, x.grams, x.spools, x.price, x.line_no]), [['Black', ['Black'], ['#111111'], 1000, 2, 10, 0], ['White', ['White'], ['#888888'], 1000, 2, 10, 0]]);
  assert.ok(body.messages[0].content.some((c) => c.type === 'image' && c.source.media_type === 'image/jpeg'));
  assert.ok(r.cost > 0);
});
