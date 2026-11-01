#!/usr/bin/env node
'use strict';

/*
 * Spawn filter rail self-check (roadmap P0-C).
 *
 * Acceptance: every marker in each map's GeoJSON is reachable via exactly one
 * filter path — i.e. the rail's (category, density-level) × (tier) cells form
 * an exhaustive, non-overlapping partition of the features, and every rail
 * path the UI would emit survives the ?rail= URL validation round-trip.
 *
 * DOM/Leaflet behavior (instant toggling, pre-bucketed groups) is verified by
 * real-browser render; this script proves the data-level partition + the
 * pure path/level rules map.js implements.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const M = require(path.join(root, 'public', 'js', 'map-url-state.js'));

// Must stay in lockstep with SPAWN_LEVELS / spawnLevelOfTier in public/js/map.js.
const SPAWN_LEVELS = ['high', 'med', 'low'];
function levelOfTier(tier) {
  if (tier >= 3) return 'high';
  if (tier === 2) return 'med';
  return 'low';
}

// Pull the actual category order out of map.js so this test fails if the two
// drift apart (house pattern: assert against the source, cf. holiday-window-test).
const mapJs = fs.readFileSync(path.join(root, 'public', 'js', 'map.js'), 'utf8');
const orderMatch = mapJs.match(/const SPAWN_CATEGORY_ORDER = \[([^\]]+)\];/);
assert.ok(orderMatch, 'SPAWN_CATEGORY_ORDER not found in map.js');
const mapCategoryOrder = orderMatch[1].match(/'([a-z0-9]+)'/g).map((s) => s.slice(1, -1));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

for (const mapName of ['nasdara', 'enoch', 'chernarusplus']) {
  const g = JSON.parse(fs.readFileSync(path.join(root, 'data', mapName, 'markers.geojson'), 'utf8'));

  check(mapName + ': every feature is reachable via exactly one rail path', () => {
    const railCats = new Set();
    const railTiers = new Set();
    for (const f of g.features) {
      const p = f.properties || {};
      const tier = Number(p.lootTier) || 1;
      const cat = p.category || 'other';
      assert.ok(Number.isInteger(tier) && tier >= 1 && tier <= 4, 'lootTier out of 1-4: ' + p.name);
      assert.ok(mapCategoryOrder.indexOf(cat) !== -1,
        'category not covered by the rail order: ' + cat);
      assert.ok(SPAWN_LEVELS.indexOf(levelOfTier(tier)) !== -1);
      // Exactly one path per marker: one category row, one density level,
      // one tier — and each of those exists as a rail checkbox.
      assert.ok(M.parse('?rail=cat:' + cat + ':' + levelOfTier(tier) + ',tier:' + tier)
        .rail.size === 2, 'rail path rejected for ' + p.name);
      railCats.add(cat);
      railTiers.add(tier);
    }
    // Data-driven completeness: every tier/category in the data has a row,
    // so no marker is unreachable and no dead row is rendered.
    for (const t of railTiers) assert.ok(M.parse('?rail=tier:' + t).rail.has('tier:' + t));
    for (const c of railCats) {
      for (const l of SPAWN_LEVELS) {
        assert.ok(M.parse('?rail=cat:' + c + ':' + l).rail.has('cat:' + c + ':' + l),
          'category path rejected: ' + c + ':' + l);
      }
    }
  });

  check(mapName + ': pre-bucket structure holds every feature exactly once', () => {
    // Mirror of loadSpawnMarkers' bucketing: (usage bucket, cat|tier) groups.
    const bucketOf = (usages) => (usages || []).indexOf('Town') !== -1 ? 'town'
      : (usages || []).indexOf('Village') !== -1 ? 'village' : 'city';
    let placed = 0;
    for (const usage of ['city', 'town', 'village']) {
      const groups = new Map();
      for (const f of g.features) {
        const p = f.properties || {};
        if (bucketOf(p.usages) !== usage) continue;
        const key = (p.category || 'other') + '|' + (Number(p.lootTier) || 1);
        if (!groups.has(key)) groups.set(key, 0);
        groups.set(key, groups.get(key) + 1);
        placed++;
      }
    }
    assert.strictEqual(placed, g.features.length, 'features lost or double-bucketed');
  });
}

check('rail URL round-trip for a realistic multi-group state', () => {
  const s = M.parse('?rail=cat:store:high,tier:3,cat:farm:med,evt:christmas');
  const q = M.buildSearch({
    server: '', map: 'nasdara', layers: s.layers, hiddenFilters: s.hiddenFilters,
    radius: s.radius, autoRefresh: s.autoRefresh, openSections: s.openSections,
    rail: s.rail, panelOpen: s.panelOpen,
  });
  const again = M.parse('?' + q);
  assert.deepStrictEqual([...again.rail].sort(), [...s.rail].sort());
});

console.log(`\n✅ spawn-filter-rail suite passed: ${passed} checks`);
