#!/usr/bin/env node
'use strict';

/* loadout-generator-test.js — Loadout Generator logic
 * (public/js/tools/loadout-generator-core.js), asserted against a real
 * kitty_loadouts file (scripts/fixtures/kitty-loadout-sample.json, copied
 * from dayz-library/community_builds/loadouts/kitty_loadouts/) and, when the
 * dayz-library checkout is present, the whole 42-file corpus.
 * Run: node scripts/loadout-generator-test.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Core = require(path.join(__dirname, '..', 'public', 'js', 'tools', 'loadout-generator-core.js'));
const ROOT = path.resolve(__dirname, '..');
const LIB = process.env.DAYZ_LIBRARY_ROOT || '/home/salt/Documents/GitHub/dayz-library';
const CORPUS_DIR = path.join(LIB, 'community_builds', 'loadouts', 'kitty_loadouts');

function pass(name) { console.log(`  ✓ ${name}`); }

/* 1. Golden round-trip: composing a real corpus file back out must reproduce
 *    it byte-structurally (deep-equal on the parsed document). */
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'kitty-loadout-sample.json'), 'utf8'));
const state = {
  name: sample.name,
  spawnWeight: sample.spawnWeight,
  characterTypes: sample.characterTypes.slice(),
  slots: sample.attachmentSlotItemSets.map((s) => ({
    slotName: s.slotName,
    items: s.discreteItemSets.map((it) => ({ itemType: it.itemType, spawnWeight: it.spawnWeight }))
  })),
  cargo: [],
  loose: []
};
const doc = Core.buildLoadout(state);
assert.deepStrictEqual(doc, sample, 'generated doc must deep-equal the real kitty_loadouts sample');
assert.ok(Core.validate(doc).ok, 'generated doc must validate');
assert.strictEqual(Core.validateText(Core.toJSON(doc)).ok, true, 'toJSON round-trip must validate');
assert.deepStrictEqual(JSON.parse(Core.toJSON(doc)), sample, 'JSON round-trip must be lossless');
pass('golden round-trip vs real kitty_loadouts sample');

/* 2. Feature build: quantity expansion, cargo sections, loose items,
 *    character types, simple children, per-section health. */
const doc2 = Core.buildLoadout({
  name: 'Loadout Santa',
  spawnWeight: 1,
  characterTypes: ['SurvivorM_Jose'],
  slots: [{ slotName: 'Body', items: [{ itemType: 'TrackSuitJacket_Red', qty: 2, spawnWeight: 1 }] }],
  cargo: [{
    name: 'Cargo1',
    health: 0.8,
    items: [
      { itemType: 'Mag_SVD_10Rnd', qty: 3 },
      { itemType: 'FirstAidKit', qty: 1, simpleChildren: ['BandageDressing', 'StartKitIV'] }
    ],
    simpleChildren: ['GlassBottle', 'GlassBottle']
  }],
  loose: [{ itemType: 'Candycane_Green', qty: 2 }]
});
{
  const v = Core.validate(doc2);
  assert.strictEqual(v.ok, true, `feature doc must validate: ${JSON.stringify(v.errors)}`);
}
assert.strictEqual(doc2.attachmentSlotItemSets[0].discreteItemSets.length, 2, 'qty=2 must repeat the entry');
assert.strictEqual(doc2.discreteUnsortedItemSets[0].complexChildrenTypes.length, 4, 'qty=3 + qty=1 must expand');
assert.strictEqual(doc2.discreteUnsortedItemSets[0].attributes.healthMax, 0.8, 'cargo health must flow into attributes');
assert.deepStrictEqual(doc2.discreteUnsortedItemSets[0].simpleChildrenTypes, ['GlassBottle', 'GlassBottle']);
assert.deepStrictEqual(doc2.discreteUnsortedItemSets[0].complexChildrenTypes[3].simpleChildrenTypes, ['BandageDressing', 'StartKitIV']);
assert.deepStrictEqual(doc2.simpleChildrenTypes, ['Candycane_Green', 'Candycane_Green'], 'loose items repeat');
assert.strictEqual(doc2.simpleChildrenUseDefaultAttributes, false);
assert.deepStrictEqual(doc2.characterTypes, ['SurvivorM_Jose']);
assert.deepStrictEqual(doc2.attachmentSlotItemSets[0].discreteItemSets[0].attributes,
  { healthMin: 1, healthMax: 1, quantityMin: 1, quantityMax: 1 }, 'default attributes must match the corpus');
assert.strictEqual(doc2.attachmentSlotItemSets[0].discreteItemSets[0].quickBarSlot, -1);
pass('feature build: quantities, cargo, loose items, children, health');

/* 3. Corpus key audit: every key the generator emits must appear in the real
 *    corpus (top level, slot entries, items, cargo sections). */
function keyAudit(corpusFiles) {
  const top = new Set(), slot = new Set(), item = new Set(), cargo = new Set();
  corpusFiles.forEach((f) => {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    Object.keys(d).forEach((k) => top.add(k));
    (d.attachmentSlotItemSets || []).forEach((s) => {
      Object.keys(s).forEach((k) => slot.add(k));
      (s.discreteItemSets || []).forEach((it) => Object.keys(it).forEach((k) => item.add(k)));
    });
    (d.discreteUnsortedItemSets || []).forEach((c) => {
      Object.keys(c).forEach((k) => cargo.add(k));
      (c.complexChildrenTypes || []).forEach((it) => Object.keys(it).forEach((k) => item.add(k)));
    });
  });
  function subset(objKeys, corpusSet, label) {
    objKeys.forEach((k) => assert.ok(corpusSet.has(k), `${label}: generator emits key "${k}" absent from corpus`));
  }
  const allDocs = [doc, doc2];
  allDocs.forEach((d, i) => {
    subset(Object.keys(d), top, `doc${i + 1} top-level`);
    (d.attachmentSlotItemSets || []).forEach((s) => {
      subset(Object.keys(s), slot, `doc${i + 1} slot entry`);
      (s.discreteItemSets || []).forEach((it) => subset(Object.keys(it), item, `doc${i + 1} item`));
    });
    (d.discreteUnsortedItemSets || []).forEach((c) => {
      subset(Object.keys(c), cargo, `doc${i + 1} cargo section`);
      (c.complexChildrenTypes || []).forEach((it) => subset(Object.keys(it), item, `doc${i + 1} cargo item`));
    });
  });
}
if (fs.existsSync(CORPUS_DIR)) {
  keyAudit(fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(CORPUS_DIR, f)));
  pass('corpus key audit: generated keys ⊆ corpus keys');
} else {
  console.log('  – corpus dir absent, key audit skipped (fixture still asserted above)');
}

/* 4. The whole real corpus must validate with ZERO errors (proves the
 *    validator accepts the target format). */
let corpusCount = 0;
if (fs.existsSync(CORPUS_DIR)) {
  fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json')).forEach((f) => {
    const d = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, f), 'utf8'));
    const v = Core.validate(d);
    assert.strictEqual(v.ok, true, `${f} must validate: ${JSON.stringify(v.errors)}`);
    corpusCount++;
  });
  pass(`corpus validation: ${corpusCount} real files, 0 errors`);
} else {
  pass('corpus validation skipped (dayz-library absent) — fixture asserted instead');
}

/* 5. Precise negative cases: every violation lands with the right JSON path. */
function bad(mutator, expectedPath, label) {
  const d = Core.buildLoadout(state);
  mutator(d);
  const v = Core.validate(d);
  assert.strictEqual(v.ok, false, `${label}: doc must be invalid`);
  assert.ok(v.errors.some((e) => e.path === expectedPath),
    `${label}: expected error at "${expectedPath}", got ${JSON.stringify(v.errors.map((e) => e.path))}`);
}
bad((d) => { delete d.name; }, 'name', 'missing name');
bad((d) => { d.spawnWeight = -1; }, 'spawnWeight', 'negative spawnWeight');
bad((d) => { d.characterTypes = ['', 'x']; }, 'characterTypes[0]', 'empty character type');
bad((d) => { d.spawnWeight = 1.5; }, 'spawnWeight', 'non-integer spawnWeight');
bad((d) => { d.foo = 1; }, 'foo', 'unknown top-level key');
bad((d) => { d.attachmentSlotItemSets[0].discreteItemSets[0].attributes.healthMin = 2; },
  'attachmentSlotItemSets[0].discreteItemSets[0].attributes', 'healthMin > healthMax');
bad((d) => { d.attachmentSlotItemSets[0].discreteItemSets[0].itemType = ''; },
  'attachmentSlotItemSets[0].discreteItemSets[0].itemType', 'empty itemType');
bad((d) => { d.attachmentSlotItemSets[0].discreteItemSets[0].quickBarSlot = -2; },
  'attachmentSlotItemSets[0].discreteItemSets[0].quickBarSlot', 'quickBarSlot < -1');
bad((d) => { d.attachmentSlotItemSets.push({ weird: true }); },
  `attachmentSlotItemSets[${sample.attachmentSlotItemSets.length}]`, 'entry neither slot nor item');
bad((d) => { d.discreteUnsortedItemSets = [{ name: 'C1' }]; },
  'discreteUnsortedItemSets[0].complexChildrenTypes', 'cargo without complexChildrenTypes');
bad((d) => { d.attachmentSlotItemSets = 'nope'; }, 'attachmentSlotItemSets', 'non-array slots');
bad((d) => { d.simpleChildrenTypes = [null]; d.simpleChildrenUseDefaultAttributes = false; },
  'simpleChildrenTypes[0]', 'non-string loose item');
{
  const v = Core.validateText('{ "name": "Player", ');
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors[0].message.includes('JSON parse error'), 'parse errors must be reported with the parser message');
  const v2 = Core.validate(['not', 'an', 'object']);
  assert.strictEqual(v2.ok, false);
  assert.strictEqual(v2.errors[0].message, 'top level must be a JSON object');
}
pass('precise negative cases: path-qualified errors');

/* 6. Naming: kitty file convention loadout<name>.json */
assert.strictEqual(Core.slugify('Pumpkin'), 'loadoutpumpkin.json');
assert.strictEqual(Core.slugify('Loadout Santa'), 'loadoutloadoutsanta.json');
assert.strictEqual(Core.slugify(''), 'loadoutcustom.json');
assert.strictEqual(Core.slugify('Vanilla Enhanced Xmas'), 'loadoutvanillaenhancedxmas.json');
pass('slugify: loadout<name>.json convention');

/* 7. Defaults: stateless build uses the corpus defaults. */
{
  const d = Core.buildLoadout({});
  assert.strictEqual(d.spawnWeight, 1);
  assert.strictEqual(d.name, 'Player');
  assert.deepStrictEqual(d.characterTypes, []);
  assert.deepStrictEqual(d.attachmentSlotItemSets, []);
  assert.deepStrictEqual(d.discreteUnsortedItemSets, []);
  assert.ok(!('simpleChildrenTypes' in d), 'no top-level simple children unless requested');
  assert.ok(Core.validate(d).ok, 'empty loadout must be structurally valid');
}
pass('defaults: minimal valid doc');

console.log(`\n✅ loadout-generator suite passed${corpusCount ? ` (corpus ${corpusCount} files)` : ''}`);
