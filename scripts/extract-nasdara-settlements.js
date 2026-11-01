#!/usr/bin/env node
/**
 * extract-nasdara-settlements.js — nasdara settlement-name extraction.
 *
 * Nasdara's mission files embed no settlement names in building classnames
 * (only Takistan does), so its map labels come from the dayz-library
 * community_builds location dump (dayzed.gg, game-file-derived):
 *   <mapDataDir>/nasdara-locations.json  ->  { name, type, x, z } in world m
 *
 * Output: data/nasdara/settlements.json — one catalog-shaped entry per named
 * location (public/js/map-layer-catalog.js entry shape), consumed by map.js's
 * P0-B settlement-label layer and the place-search index.
 *
 * Type -> zoom bucket (see public/js/place-search.js): capital/city always;
 * village and the minor localities (Local/Ruin/Marine/Hill) from z>=1.
 *
 * Usage:
 *   node scripts/extract-nasdara-settlements.js [--source <mapDataDir>]
 *
 * Self-validating: exits non-zero if the output fails invariants (counts,
 * world bounds, Dashtabad anchor).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAP_DATA_DIR_DEFAULT = process.env.DAYZ_LIBRARY_MAP_DATA
  || '/home/salt/Documents/GitHub/dayz-library/community_builds/map-data';
const WORLD = require(path.join(ROOT, 'public', 'js', 'dayz-map-coordinates.js'))
  .getMapDefinition('nasdara');

// dayzed.gg location type -> P0-B zoom bucket. Unknown types fail validation
// below so a new source type gets mapped deliberately, not by default.
const KIND_BY_TYPE = Object.freeze({
  Capital: 'capital',
  City: 'city',
  Village: 'village',
  Local: 'village',
  Ruin: 'village',
  Marine: 'village',
  Hill: 'village',
});

function parseArgs(argv) {
  const args = { source: MAP_DATA_DIR_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') args.source = argv[++i];
  }
  return args;
}

function slug(name) {
  return 'Settlement_' + String(name).replace(/[^A-Za-z0-9]+/g, '');
}

function main() {
  const { source } = parseArgs(process.argv.slice(2));
  const srcPath = path.join(source, 'nasdara-locations.json');
  if (!fs.existsSync(srcPath)) {
    console.error(`✗ Missing source file: ${srcPath}`);
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  if (doc.map !== 'nasdara' || !Array.isArray(doc.locations) || !doc.locations.length) {
    console.error(`✗ ${srcPath}: expected { map: "nasdara", locations: [...] }`);
    process.exit(1);
  }

  const settlements = [];
  const idCounts = new Map();
  for (const loc of doc.locations) {
    const problems = [];
    if (!loc || typeof loc.name !== 'string' || !loc.name.trim()) problems.push('missing name');
    if (!KIND_BY_TYPE[loc.type]) problems.push(`unknown type ${JSON.stringify(loc.type)}`);
    for (const [label, raw] of [['x', loc.x], ['z', loc.z]]) {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || v > WORLD.worldWidth) {
        problems.push(`${label}=${JSON.stringify(raw)} outside world extent [0, ${WORLD.worldWidth}]`);
      }
    }
    if (problems.length) {
      console.error(`✗ ${srcPath}: entry ${JSON.stringify(loc)}: ${problems.join(', ')}`);
      process.exit(1);
    }
    // Same-named points are real (river landing points, shared names); the
    // occurrence suffix keeps ids unique without hiding any location. Count
    // by slug, not raw name: "Sefid Darya" / "Sefid-Darya" share one slug.
    const base = slug(loc.name);
    const n = (idCounts.get(base) || 0) + 1;
    idCounts.set(base, n);
    settlements.push({
      id: n === 1 ? base : base + '-' + n,
      names: { en: loc.name, cy: '' },
      position: { east: loc.x, north: loc.z },
      kind: KIND_BY_TYPE[loc.type],
      type: loc.type,
      provenance: 'dayzed.gg (game-file-derived) via dayz-library',
    });
  }

  // ---- self-validation (invariants) --------------------------------------
  const count = (type) => settlements.filter((s) => s.type === type).length;
  const problems = [];
  if (settlements.length !== 156) problems.push(`expected 156 locations, got ${settlements.length}`);
  if (count('City') !== 19) problems.push(`expected 19 City, got ${count('City')}`);
  if (count('Village') !== 46) problems.push(`expected 46 Village, got ${count('Village')}`);
  if (new Set(settlements.map((s) => s.id)).size !== settlements.length) {
    problems.push('duplicate ids');
  }
  // Known-point anchor: Dashtabad is the dense centre-east building cluster.
  const dashtabad = settlements.find((s) => s.names.en === 'Dashtabad');
  if (!dashtabad ||
      Math.abs(dashtabad.position.east - 10655.3) > 1 ||
      Math.abs(dashtabad.position.north - 10792.1) > 1) {
    problems.push('Dashtabad missing or moved >1m from the known anchor (10655.3, 10792.1)');
  }
  if (problems.length) {
    console.error(`✗ Validation failed for nasdara settlements:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const outDir = path.join(ROOT, 'data', 'nasdara');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'settlements.json');
  fs.writeFileSync(outPath, JSON.stringify({
    map: 'nasdara',
    source: 'dayz-library/community_builds/map-data/nasdara-locations.json (dayzed.gg, game-file-derived)',
    count: settlements.length,
    settlements,
  }, null, 2));

  const kinds = {};
  for (const s of settlements) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
  console.log(`✓ nasdara settlements: ${settlements.length} -> ${path.relative(ROOT, outPath)}`);
  console.log(`  kinds: ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`);
}

main();
