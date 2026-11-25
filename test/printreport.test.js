const test = require('node:test');
const assert = require('node:assert');
const PR = require('../src/printreport');
const { filamentsOf, largestThumb } = require('../src/history');

// the end of an Orca G-code: totals, then the settings
const TAIL = `G1 X1 Y1 E.1
; EXECUTABLE_BLOCK_END

; filament used [mm] = 95126.42, 0.00, 5059.34
; filament used [g] = 283.72, 0.00, 15.21
; filament cost = 5.67, 0.00, 0.38
; total filament used [g] = 298.93
; total filament cost = 6.05
; total filament change = 628
; total layers count = 3145
; estimated printing time (normal mode) = 1d 17h 36m 46s

; CONFIG_BLOCK_START
; layer_height = 0.08
; initial_layer_print_height = 0.2
; wall_loops = 3
; sparse_infill_density = 15%
; sparse_infill_pattern = gyroid
; outer_wall_speed = 63,90
; enable_support = 1
; support_type = tree(auto)
; support_threshold_angle = 30
; enable_prime_tower = 1
; prime_volume = 45
; flush_into_infill = 0
; ironing_type = no ironing
; nozzle_temperature = 220,220,255
; filament_max_volumetric_speed = 12,12,12
; filament_settings_id = "Generic PLA";"Generic PLA";"Generic PETG"
; filament_type = PLA;PLA;PETG
; print_settings_id = 0.08mm High Quality @Snapmaker U1
; nozzle_diameter = 0.4,0.4,0.4,0.4
; CONFIG_BLOCK_END
`;

test('print report: totals from the end of the G-code', () => {
  const f = PR.parseFooter(TAIL);
  assert.deepStrictEqual(f.g, [283.72, 0, 15.21]);
  assert.strictEqual(f.totalCost, 6.05);
  assert.strictEqual(f.changes, 628);
  assert.strictEqual(f.layers, 3145);
});

test('print report: settings grouped for people, only the filaments used', () => {
  const cfg = PR.parseConfigBlock(TAIL);
  const r = PR.settingsReport(cfg, { used: [0, 2], advisorKeys: ['wall_loops'] });
  const sec = (id) => r.sections.find((s) => s.id === id);
  const item = (id, key) => sec(id).items.find((i) => i.key === key);
  assert.strictEqual(item('quality', 'layer_height').value, '0.08 mm');
  assert.strictEqual(item('quality', 'ironing_type').value, 'No ironing');
  assert.strictEqual(item('strength', 'wall_loops').advisor, true);
  assert.strictEqual(item('strength', 'sparse_infill_density').value, '15%');
  assert.strictEqual(PR.settingsReport({ sparse_infill_pattern: 'adaptivecubic' }).sections[0].items[0].value, 'Adaptive cubic');
  assert.strictEqual(item('speed', 'outer_wall_speed').value, '63 mm/s');
  assert.strictEqual(item('support', 'support_type').value, 'Tree (auto)');
  assert.strictEqual(item('support', 'enable_support').value, 'On');
  assert.strictEqual(item('temps', 'nozzle_temperature').value, 'F1: 220 °C · F3: 255 °C');   // filament 2 wasn't used
  assert.strictEqual(item('speed', 'filament_max_volumetric_speed').value, '12 mm³/s');
  assert.ok(item('multi', 'prime_volume'));
  assert.strictEqual(r.profiles.process, '0.08mm High Quality @Snapmaker U1');
  assert.deepStrictEqual(r.profiles.filaments.map((f) => f.name), ['Generic PLA', 'Generic PETG']);
  // one filament: no multi-material details beyond the prime tower; supports off hides their details
  const one = PR.settingsReport({ ...cfg, enable_support: '0' }, { used: [0] });
  assert.deepStrictEqual(one.sections.find((s) => s.id === 'multi').items.map((i) => i.key), ['enable_prime_tower']);
  assert.deepStrictEqual(one.sections.find((s) => s.id === 'support').items.map((i) => i.key), ['enable_support']);
});

test('print report: the end of the file is read again, larger, when the settings start earlier', async () => {
  const sizes = [];
  const text = await PR.gcodeTail({}, 'x.gcode', async (n) => { sizes.push(n); return n > 200000 ? TAIL : TAIL.slice(-200); });
  assert.ok(text.includes('; CONFIG_BLOCK_START'));
  assert.strictEqual(sizes.length, 2);
  await assert.rejects(PR.gcodeTail({}, 'x.gcode', async () => 'G1 X1'), /No Orca settings/);
});

test('history: filaments a print used, with colors, and the largest thumbnail', () => {
  const md = { filament_type: 'PLA;PLA;PETG', filament_colour: '#E0E0E0;#FFFFFF;#112233', filament_name: 'Generic PLA";"Generic PLA";"Generic PETG',
    filament_weight: [283.72, 0, 15.21], filament_used_mm: [95126.42, 0, 5059.34] };
  const f = filamentsOf(md);
  assert.deepStrictEqual(f.map((x) => [x.i, x.type, x.color]), [[0, 'PLA', '#E0E0E0'], [2, 'PETG', '#112233']]);
  assert.strictEqual(f[1].name, 'Generic PETG');
  assert.strictEqual(largestThumb([{ relative_path: '.thumbs/a-48x48.png' }, { relative_path: '.thumbs/a-300x300.png' }, { relative_path: '.thumbs/a-96x96.png' }]), '.thumbs/a-300x300.png');
  assert.strictEqual(largestThumb(undefined), null);
});
