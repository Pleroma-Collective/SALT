#!/usr/bin/env node
'use strict';

/* loot-probability-test.js — Loot Probability Calculator logic
 * (public/js/tools/loot-probability-core.js), asserted against the real
 * extracted catalog (data/<map>/items.json, scripts/extract-dayz-data.js) and,
 * when DayZ-Central-Economy is present, the raw server types.xml.
 * Run: node scripts/loot-probability-test.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Core = require(path.join(__dirname, '..', 'public', 'js', 'tools', 'loot-probability-core.js'));

const ROOT = path.resolve(__dirname, '..');
const CE_ROOT = process.env.DAYZ_CE_ROOT || '/home/salt/Documents/GitHub/DayZ-Central-Economy';

const maps = ['nasdara', 'enoch', 'chernarusplus'];

for (const map of maps) {
  const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', map, 'items.json'), 'utf8')).items;
  const pools = Core.buildPools(items);

  // Every usage group in the catalog has a pool; uniform weights (this
  // server's types.xml declares no per-item chance elements) => weightSum
  // must be exactly count * 10000 and p(group) = 1/count for every member.
  const groupOf = (it) => it.usages || [];
  for (const it of items) {
    for (const g of groupOf(it)) {
      const p = pools.pools[g];
      assert(p, `${map}: pool missing for group ${g}`);
      assert.strictEqual(p.weightSum, p.count * Core.DEFAULT_WEIGHT,
        `${map}: group ${g} weightSum ${p.weightSum} != ${p.count} * ${Core.DEFAULT_WEIGHT} (uniform expectation broken)`);
      const row = Core.groupProbability(it, pools, g, 'nominal');
      assert(Math.abs(row.p - 1 / p.count) < 1e-12, `${map}: p(${it.classname},${g}) must be 1/${p.count}`);
      assert.strictEqual(row.poolSize, p.count, `${map}: poolSize for ${g}`);
    }
  }

  // Sanity: the big pools exist and small pools are small (server shape).
  assert(Object.keys(pools.pools).length >= 10, `${map}: expected >=10 usage groups, got ${Object.keys(pools.pools).length}`);
  const maxSize = Math.max(...Object.values(pools.pools).map((p) => p.count));
  const minSize = Math.min(...Object.values(pools.pools).map((p) => p.count));
  assert(maxSize > 100 && minSize <= 10, `${map}: pool sizes look degenerate (max=${maxSize}, min=${minSize})`);

  // itemProbability: facts + per-group rows; rows sorted by p desc.
  const tagged = items.find((i) => (i.usages || []).length >= 2);
  const ans = Core.itemProbability(tagged, pools);
  assert.strictEqual(ans.classname, tagged.classname);
  assert.strictEqual(ans.groups.length, tagged.usages.length, `${map}: ${tagged.classname} must have one row per usage`);
  assert(ans.spawnable === (tagged.nominal > 0), `${map}: spawnable flag for ${tagged.classname}`);
  for (let i = 1; i < ans.groups.length; i++) {
    assert(ans.groups[i - 1].p >= ans.groups[i].p, `${map}: rows must be sorted by p desc`);
  }

  // Compare: union of groups, null where an item is absent, ratio where both present.
  const other = items.find((i) => i.classname !== tagged.classname && (i.usages || []).length >= 1);
  const cmp = Core.compareItems(tagged, other, pools);
  const union = new Set([...tagged.usages, ...(other.usages || [])]);
  assert.strictEqual(cmp.length, union.size, `${map}: compare rows must cover the union of usages`);
  for (const row of cmp) {
    const inA = tagged.usages.includes(row.group);
    const inB = (other.usages || []).includes(row.group);
    assert((row.pA != null) === inA, `${map}: compare pA null-ness for ${row.group}`);
    assert((row.pB != null) === inB, `${map}: compare pB null-ness for ${row.group}`);
    if (inA && inB) assert(row.ratioAB > 0, `${map}: ratio must be positive where both present`);
    else assert(row.ratioAB == null, `${map}: ratio must be null where one side is absent`);
  }

  // Search: case-insensitive classname, nonsense/blank -> nothing.
  const sample = items[0];
  assert(Core.searchItems(items, sample.classname.toLowerCase()).some((i) => i.classname === sample.classname),
    `${map}: lowercase search must find ${sample.classname}`);
  assert.strictEqual(Core.searchItems(items, 'zz-no-such-classname-zz').length, 0, `${map}: nonsense query`);
  assert.strictEqual(Core.searchItems(items, '   ').length, 0, `${map}: blank query`);
}

// --- nasdara-specific invariants (the acceptance map) -------------------
{
  const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'nasdara', 'items.json'), 'utf8')).items;
  const pools = Core.buildPools(items);

  const ak101 = items.find((i) => i.classname === 'AK101');
  assert(ak101, 'nasdara: AK101 must exist');
  assert.deepStrictEqual(ak101.usages, ['MilitaryEast']);
  assert.strictEqual(ak101.nominal, 3);
  const akRow = Core.groupProbability(ak101, pools, 'MilitaryEast', 'nominal');
  assert.strictEqual(akRow.poolSize, 59, 'nasdara: MilitaryEast pool must be 59 items');
  assert(Math.abs(akRow.p - 1 / 59) < 1e-12, 'nasdara: AK101 p in MilitaryEast = 1/59');

  const noUsage = items.find((i) => (i.nominal || 0) > 0 && !(i.usages || []).length);
  assert(noUsage, 'nasdara: expected an item with nominal>0 and no usages (map-wide spawns)');
  assert.strictEqual(Core.itemProbability(noUsage, pools).groups.length, 0, 'nasdara: no usage groups -> no per-group rows');

  const crafted = items.find((i) => (i.nominal || 0) === 0 && i.flags && i.flags.crafted === 1 && !(i.usages || []).length);
  assert(crafted, 'nasdara: expected a crafted-only item');
  const cAns = Core.itemProbability(crafted, pools);
  assert.strictEqual(cAns.spawnable, false);
  assert.strictEqual(cAns.crafted, true);

  assert.strictEqual(Core.buildPools(items).hasCustomChances, false,
    'nasdara: this server declares no per-item chances (uniform pool)');
}

// --- parser -------------------------------------------------------------
{
  const bad = [''];
  for (const text of bad) {
    assert.strictEqual(Core.parseTypesXml(text).ok, false, `parser must reject: ${JSON.stringify(text)}`);
  }
  assert.strictEqual(Core.parseTypesXml('<globals><x/></globals>').ok, false, 'parser must reject non-types.xml');
  assert.strictEqual(Core.parseTypesXml('<types></types>').ok, false, 'parser must reject types.xml with no entries');

  // Element-form numbers (this server's BiSTudio export style).
  const xmlEl = `<?xml version="1.0" encoding="UTF-8"?>
<types>
  <type name="TestItemA">
    <nominal>12</nominal>
    <lifetime>14400</lifetime>
    <restock>1800</restock>
    <min>9</min>
    <quantmin>-1</quantmin>
    <quantmax>-1</quantmax>
    <cost>100</cost>
    <flags count_in_cargo="0" count_in_map="1" crafted="0" deloot="1"/>
    <category name="weapons"/>
    <usage name="Military"/>
    <usage name="Store"/>
    <value name="Tier2"/>
    <value name="Unique"/>
  </type>
  <type name="TestItemB">
    <nominal>0</nominal>
    <lifetime>28800</lifetime>
    <restock>3600</restock>
    <min>0</min>
    <quantmin>-1</quantmax>
    <quantmax>-1</quantmax>
    <cost>100</cost>
    <flags count_in_map="1" crafted="1"/>
    <usage name="Store"/>
  </type>
  <type name="TestItemA">
    <nominal>999</nominal>
  </type>
</types>`;
  const parsed = Core.parseTypesXml(xmlEl);
  assert.strictEqual(parsed.ok, true, 'element-form types.xml must parse');
  assert.strictEqual(parsed.items.length, 2, 'duplicate classname must be dropped');
  assert.strictEqual(parsed.duplicates, 1, 'duplicate classname must be counted');
  const a = parsed.items[0];
  assert.deepStrictEqual(
    { nominal: a.nominal, lifetime: a.lifetime, restock: a.restock, min: a.min, quantmin: a.quantmin, quantmax: a.quantmax, cost: a.cost, tier: a.tier, unique: a.unique, category: a.category },
    { nominal: 12, lifetime: 14400, restock: 1800, min: 9, quantmin: -1, quantmax: -1, cost: 100, tier: 2, unique: true, category: 'weapons' },
    'element-form field extraction');
  assert.deepStrictEqual(a.usages, ['Military', 'Store']);
  assert.strictEqual(a.flags.crafted, 0);
  assert.strictEqual(a.flags.deloot, 1);
  assert.strictEqual(a.flags.countInMap, undefined, 'flags keep snake_case keys (house extractor maps them; raw parse does not)');
  const b = parsed.items[1];
  assert.strictEqual(b.flags.crafted, 1);
  assert.strictEqual(b.usages.length, 1);

  // Weighted pools: nominalChance/lifetimeChance honored when present.
  const weighted = Core.parseTypesXml(`
<types>
  <type name="W1"><nominal>5</nominal><nominalChance>30000</nominalChance><usage name="Store"/></type>
  <type name="W2"><nominal>5</nominal><usage name="Store"/></type>
  <type name="W3"><nominal>5</nominal><usage name="Store"/></type>
</types>`);
  assert.strictEqual(weighted.ok, true);
  const wPools = Core.buildPools(weighted.items);
  assert.strictEqual(wPools.hasCustomChances, true, 'custom chances must be detected');
  assert.strictEqual(Core.itemWeight(weighted.items[0], 'nominal'), 30000);
  const wRow = Core.groupProbability(weighted.items[0], wPools, 'Store', 'nominal');
  assert(Math.abs(wRow.p - 30000 / 50000) < 1e-12, 'weighted p must be 30000/50000');
  assert.strictEqual(wRow.weightSum, 50000);

  // Attribute-form numbers (older/vanilla exports): <nominal value="12"/>.
  const xmlAttr = Core.parseTypesXml('<types><type name="AttrItem"><nominal value="12"/><lifetime value="14400"/></type></types>');
  assert.strictEqual(xmlAttr.ok, true);
  assert.strictEqual(xmlAttr.items[0].nominal, 12, 'attribute-form nominal');
  assert.strictEqual(xmlAttr.items[0].lifetime, 14400, 'attribute-form lifetime');
}

// --- raw server types.xml vs the extracted catalog (skip-safe) ----------
if (fs.existsSync(path.join(CE_ROOT, 'dayzOffline.nasdara', 'db', 'types.xml'))) {
  const raw = fs.readFileSync(path.join(CE_ROOT, 'dayzOffline.nasdara', 'db', 'types.xml'), 'utf8');
  const parsed = Core.parseTypesXml(raw);
  assert.strictEqual(parsed.ok, true, 'real nasdara types.xml must parse');
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'nasdara', 'items.json'), 'utf8')).items;
  assert.strictEqual(parsed.items.length, catalog.length,
    `parser item count ${parsed.items.length} must match extracted catalog ${catalog.length}`);

  // Field-for-field parity with the house extractor on a sample + invariants
  // on every item (nominal/lifetime/min/usages/tier/unique).
  const byName = new Map(parsed.items.map((i) => [i.classname, i]));
  let checked = 0;
  for (const c of catalog) {
    const p = byName.get(c.classname);
    assert(p, `extracted item ${c.classname} missing from parsed types.xml`);
    assert.strictEqual(p.nominal, c.nominal, `${c.classname}: nominal`);
    assert.strictEqual(p.lifetime, c.lifetime, `${c.classname}: lifetime`);
    assert.strictEqual(p.min, c.min, `${c.classname}: min`);
    assert.deepStrictEqual(p.usages.slice().sort(), c.usages.slice().sort(), `${c.classname}: usages`);
    assert.strictEqual(p.tier, c.tier, `${c.classname}: tier`);
    assert.strictEqual(p.unique, c.unique, `${c.classname}: unique`);
    if (checked < 5) { checked += 1; }
  }

  // Pools recomputed from the uploaded file must match the quick-answer
  // catalog exactly — the two paths answer the same question.
  const rawPools = Core.buildPools(parsed.items);
  const catPools = Core.buildPools(catalog);
  assert.deepStrictEqual(Object.keys(rawPools.pools).sort(), Object.keys(catPools.pools).sort(), 'same groups from both sources');
  for (const g of Object.keys(catPools.pools)) {
    assert.strictEqual(rawPools.pools[g].count, catPools.pools[g].count, `group ${g}: pool count parity`);
    assert.strictEqual(rawPools.pools[g].weightSum, catPools.pools[g].weightSum, `group ${g}: weight sum parity`);
  }
  console.log(`  ✓ raw types.xml parity (${parsed.items.length} items, ${Object.keys(catPools.pools).length} groups)`);
} else {
  console.log('  · DayZ-Central-Economy not present — raw types.xml parity skipped (CI-safe)');
}

console.log('✓ loot-probability: all assertions passed (' + maps.join(', ') + ')');
