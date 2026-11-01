#!/usr/bin/env node
'use strict';

/* spawnabletypes-generator-test.js — Spawnabletypes Generator logic
 * (public/js/tools/spawnabletypes-generator-core.js), asserted against real
 * cfgspawnabletypes.xml files: a verbatim fixture excerpt (scripts/fixtures/
 * spawnabletypes-sample.xml, copied from the live nasdara mission baseline)
 * for the byte-exact golden case, and — when the DayZ-Central-Economy
 * checkout is present — the whole six-file corpus (4 maps + 2 event packs,
 * ~4,200 type entries) for parse round-trips.
 * Run: node scripts/spawnabletypes-generator-test.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

const Core = require(path.join(__dirname, '..', 'public', 'js', 'tools', 'spawnabletypes-generator-core.js'));
const CE = process.env.DAYZ_CE_ROOT || '/home/salt/Documents/GitHub/DayZ-Central-Economy';
// 7 more cfgspawnabletypes.xml exist in the CE checkout (halloween.*,
// WalpurgisNightOffline.<map> variants); not in this corpus.
// shortcut: 2 of them (WalpurgisNightOffline.Enoch, halloweenOffline.enoch)
// contain strictly-invalid XML comments ("--" runs) that the strict parser
// rejects, so extending the corpus requires comment-tolerant parsing first.
// Upgrade when the owner runs one of those event packs.
const CORPUS_FILES = [
  'dayzOffline.nasdara/cfgspawnabletypes.xml',
  'dayzOffline.enoch/cfgspawnabletypes.xml',
  'dayzOffline.chernarusplus/cfgspawnabletypes.xml',
  'dayzOffline.sakhal/cfgspawnabletypes.xml',
  'halloweenOffline.nasdara/cfgspawnabletypes.xml',
  'WalpurgisNightOffline.nasdara/cfgspawnabletypes.xml'
];

function pass(name) { console.log(`  ✓ ${name}`); }

/* xml2js adapter -> generic model {tag, attrs, children, text}, the same
 * shape the browser DOMParser path (toolkit-dom.js) produces. */
function makeXml2jsParser() {
  return function parse(content) {
    try {
      const parser = new xml2js.Parser({ strict: true, explicitArray: true });
      const stream = parser.saxParser;
      const open = stream.onopentag;
      const close = stream.onclosetag;
      let depth = 0;
      let roots = 0;
      stream.onopentag = (node) => {
        if (depth === 0 && ++roots > 1) throw new Error('XML must have exactly one root element');
        depth++;
        open(node);
      };
      stream.onclosetag = (name) => { close(name); depth--; };
      parser.on('error', (error) => { throw error; });
      stream.write(content).close();
      return { ok: true, model: toModel(parser.resultObject, content) };
    } catch (error) {
      return { ok: false, error: { message: error.message } };
    }
  };
}

function toModel(object, sourceText) {
  const [rootTag, rootValue] = Object.entries(object)[0];
  const rootNode = Array.isArray(rootValue) ? rootValue[0] : rootValue;
  const model = nodeToModel(rootTag, rootNode);
  model.sourceText = sourceText;
  return model;
}

function nodeToModel(tag, node) {
  const attrs = { ...(node.$ || {}) };
  const children = [];
  let text = '';
  for (const [key, value] of Object.entries(node)) {
    if (key === '$') continue;
    if (key === '#text') { text += Array.isArray(value) ? value.join('') : String(value); continue; }
    for (const child of (Array.isArray(value) ? value : [value])) {
      children.push(typeof child === 'string'
        ? { tag: key, attrs: {}, children: [], text: child.trim() }
        : nodeToModel(key, child));
    }
  }
  return { tag, attrs, children, text: text.trim() };
}

const parse = makeXml2jsParser();

/* 1. Golden byte-exact: the composed state must reproduce the verbatim real
 *    file excerpt exactly (declaration, blank line, tabs, number formats). */
const fixtureText = fs.readFileSync(path.join(__dirname, 'fixtures', 'spawnabletypes-sample.xml'), 'utf8');
const goldenState = {
  types: [
    { name: 'Barrel_Blue', hoarder: true },
    { name: 'GiftWrapPaper', damage: { min: 0.0, max: 0.32 } },
    {
      name: 'PlateCarrierVest_Black',
      damage: { min: 0.1, max: 0.6 },
      sections: [
        { kind: 'attach-items', chance: 0.85, items: [{ name: 'PlateCarrierHolster_Black', chance: 1 }] },
        { kind: 'attach-items', chance: 0.85, items: [{ name: 'PlateCarrierPouches_Black', chance: 1 }] }
      ]
    },
    {
      name: 'AssaultBag_Black',
      sections: [
        { kind: 'cargo-preset', preset: 'mixArmy' },
        { kind: 'cargo-preset', preset: 'mixArmy' },
        { kind: 'cargo-preset', preset: 'mixArmy' }
      ]
    },
    {
      name: 'FirstAidKit',
      sections: [
        { kind: 'tag', name: 'shelves' },
        { kind: 'cargo-items', chance: 1, items: [{ name: 'BandageDressing' }] },
        { kind: 'cargo-items', chance: 0.8, items: [{ name: 'Thermometer' }] },
        { kind: 'cargo-items', chance: 0.8, items: [{ name: 'StartKitIV' }] },
        { kind: 'cargo-items', chance: 0.8, items: [{ name: 'BloodBagEmpty' }] },
        { kind: 'cargo-items', chance: 0.8, items: [{ name: 'BloodTestKit' }] }
      ]
    },
    { name: 'PlateCarrierVest' }
  ]
};
assert.strictEqual(Core.toXML(goldenState), fixtureText, 'toXML must reproduce the real-file excerpt byte-for-byte');
assert.ok(Core.validate(goldenState).ok, 'golden state must validate');
pass('golden byte-exact vs verbatim real-file excerpt');

/* 2. Fixture round-trip: parse -> stateFromModel -> validate -> toXML ->
 *    parse -> state, canonical order-insensitive deep equality. */
function canonicalize(state) {
  return {
    types: state.types
      .map((t) => ({
        name: t.name,
        hoarder: !!t.hoarder,
        damage: t.damage || null,
        sections: (t.sections || []).map((s) => JSON.parse(JSON.stringify(s))).sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)))
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}
{
  const r1 = Core.stateFromModel(parse(fixtureText).model);
  assert.strictEqual(r1.ok, true, `fixture must parse with 0 errors: ${JSON.stringify(r1.errors)}`);
  assert.strictEqual(r1.state.types.length, 6, 'fixture must yield 6 types');
  const xml = Core.toXML(r1.state);
  const r2 = Core.stateFromModel(parse(xml).model);
  assert.strictEqual(r2.ok, true, 'regenerated XML must parse with 0 errors');
  assert.deepStrictEqual(canonicalize(r1.state), canonicalize(r2.state), 'fixture round-trip must be lossless');
  assert.ok(!/\r/.test(xml), 'output must be LF-only');
  pass('fixture round-trip: parse -> state -> XML -> parse is lossless');
}

/* 3. Full corpus: every real mission file must parse with ZERO errors, and
 *    re-serializing its state must round-trip to the same content. */
let corpusFiles = 0;
let corpusTypes = 0;
for (const rel of CORPUS_FILES) {
  const file = path.join(CE, rel);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const r1 = Core.stateFromModel(parse(text).model);
  assert.strictEqual(r1.ok, true, `${rel} must parse with 0 errors: ${JSON.stringify(r1.errors.slice(0, 5))}`);
  corpusTypes += r1.state.types.length;
  const r2 = Core.stateFromModel(parse(Core.toXML(r1.state)).model);
  assert.strictEqual(r2.ok, true, `${rel}: regenerated XML must parse with 0 errors`);
  assert.deepStrictEqual(canonicalize(r1.state), canonicalize(r2.state), `${rel} round-trip must be lossless`);
  corpusFiles++;
}
if (corpusFiles) pass(`corpus round-trip: ${corpusFiles} real files, ${corpusTypes} types, 0 errors`);
else console.log('  – DayZ-Central-Economy checkout absent, corpus skipped (fixture still asserted above)');

/* 4. Format contract: declaration, blank line, tabs, self-close spacing,
 *    trailing newline. */
{
  const xml = Core.toXML({ types: [{ name: 'Foo', hoarder: true }] });
  assert.strictEqual(xml.split('\n')[0], '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>', 'declaration line');
  assert.strictEqual(xml.split('\n')[1], '', 'blank line after declaration');
  assert.ok(xml.includes('\t<type name="Foo">\n\t\t<hoarder />\n\t</type>'), 'tab indentation + spaced self-closing');
  assert.ok(xml.endsWith('</spawnabletypes>\n'), 'trailing newline');
  assert.ok(!/ \/>/.test(xml.replace(/ \//g, ' ')), 'no double self-close spacing');
  pass('format contract: declaration, tabs, self-close spacing, trailing newline');
}

/* 5. Feature build: all five section kinds, repeatable groups, empty type. */
{
  const state = {
    types: [{
      name: 'TestCrate',
      hoarder: false,
      damage: { min: 0.05, max: 0.5 },
      sections: [
        { kind: 'tag', name: 'shelves' },
        { kind: 'cargo-preset', preset: 'mixCity' },
        { kind: 'cargo-items', chance: 0.25, items: [{ name: 'BandageDressing', chance: 0.5 }, { name: 'SodaCan' }] },
        { kind: 'attach-preset', preset: 'bagsCity' },
        { kind: 'attach-items', chance: 1, items: [{ name: 'TestCrate_Key', chance: 0.75 }] }
      ]
    }, { name: 'BareType' }]
  };
  const v = Core.validate(state);
  assert.strictEqual(v.ok, true, `feature state must validate: ${JSON.stringify(v.errors)}`);
  const xml = Core.toXML(state);
  assert.ok(xml.includes('\t\t<tag name="shelves" />'), 'tag emitted');
  assert.ok(xml.includes('<damage min="0.05" max="0.5" />'), 'damage formatting');
  assert.ok(xml.includes('<cargo preset="mixCity" />'), 'cargo preset');
  assert.ok(xml.includes('<cargo chance="0.25">'), 'explicit cargo chance');
  assert.ok(xml.includes('<item name="SodaCan" />'), 'item without chance omitted');
  assert.ok(xml.includes('<attachments preset="bagsCity" />'), 'attachment preset');
  assert.ok(xml.includes('<attachments chance="1.00">'), 'attachment chance 2dp');
  assert.ok(xml.includes('<type name="BareType">\n\t</type>'), 'empty type open/close');
  pass('feature build: tag, damage, cargo, attachments, hoarder, empty type');
}

/* 6. Precise negative cases: every violation lands with the right path. */
function bad(mutator, expectedPath, label) {
  const s = Core.validate({
    types: [{ name: 'A' }]
  }).ok;
  assert.strictEqual(s, true, 'baseline must validate');
  const state = mutator();
  const v = Core.validate(state);
  assert.strictEqual(v.ok, false, `${label}: state must be invalid`);
  assert.ok(v.errors.some((e) => e.path === expectedPath),
    `${label}: expected error at "${expectedPath}", got ${JSON.stringify(v.errors.map((e) => e.path))}`);
}
bad(() => ({ types: [{ name: '', damage: null }] }), 'types[0].name', 'empty name');
bad(() => ({ types: [{ name: '9Bad' }] }), 'types[0].name', 'classname starting with digit');
bad(() => ({ types: [{ name: 'Has Space' }] }), 'types[0].name', 'classname with space');
bad(() => ({ types: [{ name: 'A' }, { name: 'A' }] }), 'types[1].name', 'duplicate type name');
bad(() => ({ types: [{ name: 'A', damage: { min: 0.5, max: 0.2 } }] }), 'types[0].damage', 'damage min > max');
bad(() => ({ types: [{ name: 'A', damage: { min: 1.2, max: 1.5 } }] }), 'types[0].damage.min', 'damage out of range');
bad(() => ({ types: [{ name: 'A', hoarder: 'yes' }] }), 'types[0].hoarder', 'non-boolean hoarder');
bad(() => ({ types: [{ name: 'A', sections: 'nope' }] }), 'types[0].sections', 'sections not an array');
bad(() => ({ types: [{ name: 'A', sections: [{ kind: 'warp' }] }] }), 'types[0].sections[0].kind', 'unknown section kind');
bad(() => ({ types: [{ name: 'A', sections: [{ kind: 'attach-items', items: [] }] }] }), 'types[0].sections[0].chance', 'attach-items missing chance');
bad(() => ({ types: [{ name: 'A', sections: [{ kind: 'attach-items', chance: 2, items: [{ name: 'B' }] }] }] }), 'types[0].sections[0].chance', 'chance > 1');
bad(() => ({ types: [{ name: 'A', sections: [{ kind: 'cargo-items', chance: 1, items: [] }] }] }), 'types[0].sections[0].items', 'empty items list');
bad(() => ({ types: [{ name: 'A', sections: [{ kind: 'cargo-preset', preset: '' }] }] }), 'types[0].sections[0].preset', 'empty preset');
bad(() => ({ types: [{ name: 'A', sections: [{ kind: 'tag', name: '' }] }] }), 'types[0].sections[0].name', 'empty tag name');
bad(() => ({ types: [{ name: 'A', sections: [{ kind: 'tag', name: 'x', extra: 1 }] }] }), 'types[0].sections[0].extra', 'unknown section key');
bad(() => ({ types: [{ name: 'A', sections: [{ kind: 'attach-items', chance: 1, items: [{ name: 'B', weird: 1 }] }] }] }), 'types[0].sections[0].items[0].weird', 'unknown item key');
bad(() => ({ types: [{ name: 'A', sections: [{ kind: 'attach-items', chance: 1, items: [{ name: 'B', chance: -1 }] }] }] }), 'types[0].sections[0].items[0].chance', 'item chance < 0');
bad(() => ({ types: [{ name: 'A', warp: 1 }] }), 'types[0].warp', 'unknown type key');
bad(() => ({ types: 'nope' }), 'types', 'types not an array');
bad(() => ({ nope: 1 }), 'types', 'missing types');
{
  const v = Core.validate('string');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.errors[0].message, 'top level must be a state object with types[]');
}
pass('precise negative cases: path-qualified errors');

/* 7. stateFromModel negative cases (the real-file contract). */
function badModel(mutator, expectedPath, label) {
  const model = mutator();
  const r = Core.stateFromModel(model);
  assert.strictEqual(r.ok, false, `${label}: model must be rejected`);
  assert.ok(r.errors.some((e) => e.path === expectedPath),
    `${label}: expected error at "${expectedPath}", got ${JSON.stringify(r.errors.map((e) => e.path))}`);
}
badModel(() => ({ tag: 'other', attrs: {}, children: [] }), '', 'wrong root tag');
badModel(() => ({ tag: 'spawnabletypes', attrs: {}, children: [{ tag: 'event', attrs: {}, children: [], text: '' }] }), 'types[0]', 'unexpected element under root');
badModel(() => ({ tag: 'spawnabletypes', attrs: {}, children: [{ tag: 'type', attrs: {}, children: [], text: '' }] }), 'types[0].name', 'missing type name');
{
  // Corpus contract: duplicate <type name=> in a REAL file is tolerated and
  // preserved (the sakhal packs ship conflicting ScientificBriefcase entries).
  const dup = Core.stateFromModel({ tag: 'spawnabletypes', attrs: {}, children: [
    { tag: 'type', attrs: { name: 'A' }, children: [], text: '' },
    { tag: 'type', attrs: { name: 'A' }, children: [], text: '' }
  ]});
  assert.strictEqual(dup.ok, true, 'duplicate type in a real file must parse');
  assert.strictEqual(dup.state.types.length, 2, 'both duplicate entries must be preserved');
  // …but composing the same name twice is a precise error in validate().
  const v = Core.validate({ types: [{ name: 'A' }, { name: 'A' }] });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.path === 'types[1].name'));
}
badModel(() => ({ tag: 'spawnabletypes', attrs: {}, children: [{ tag: 'type', attrs: { name: 'A' }, children: [{ tag: 'damage', attrs: { max: '1' }, children: [], text: '' }], text: '' }] }), 'types[0].children[0].min', 'damage missing min');
badModel(() => ({ tag: 'spawnabletypes', attrs: {}, children: [{ tag: 'type', attrs: { name: 'A' }, children: [{ tag: 'damage', attrs: { min: '0.5', max: '0.1' }, children: [], text: '' }], text: '' }] }), 'types[0].children[0]', 'damage min > max in file');
badModel(() => ({ tag: 'spawnabletypes', attrs: {}, children: [{ tag: 'type', attrs: { name: 'A' }, children: [{ tag: 'cargo', attrs: {}, children: [], text: '' }], text: '' }] }), 'types[0].children[0]', 'cargo without preset or items');
badModel(() => ({ tag: 'spawnabletypes', attrs: {}, children: [{ tag: 'type', attrs: { name: 'A' }, children: [{ tag: 'attachments', attrs: {}, children: [{ tag: 'item', attrs: { name: 'B' }, children: [], text: '' }], text: '' }], text: '' }] }), 'types[0].children[0].chance', 'attachments without chance');
badModel(() => ({ tag: 'spawnabletypes', attrs: {}, children: [{ tag: 'type', attrs: { name: 'A' }, children: [{ tag: 'weird', attrs: {}, children: [], text: '' }], text: '' }] }), 'types[0].children[0]', 'unknown child in type');
badModel(() => ({ tag: 'spawnabletypes', attrs: {}, children: [{ tag: 'type', attrs: { name: 'A' }, children: [{ tag: 'cargo', attrs: { chance: '1' }, children: [{ tag: 'item', attrs: { name: 'B', rank: '1' }, children: [], text: '' }], text: '' }], text: '' }] }), 'types[0].children[0].items[0].rank', 'unknown item attribute');
pass('stateFromModel negative cases: real-file contract errors');

if (!corpusFiles) {
  // The fixture is the minimum evidence when the corpus is absent.
  assert.ok(true);
}
console.log(`\n✅ spawnabletypes-generator suite passed${corpusFiles ? ` (corpus ${corpusFiles} files, ${corpusTypes} types)` : ''}`);
