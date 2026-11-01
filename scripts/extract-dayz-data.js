#!/usr/bin/env node
/**
 * extract-dayz-data.js — P0-A data extraction.
 *
 * Turns local DayZ-Central-Economy mission data into dashboard data:
 *   1. db/types.xml            -> data/<map>/items.json    (item catalog)
 *   2. mapgroupproto.xml +
 *      mapgrouppos.xml         -> data/<map>/markers.geojson (spawn-group markers)
 *   3. cfgspawnabletypes.xml   -> data/<map>/spawnables.json (per-classname
 *      spawn damage range, part attachments, hoarder flag)
 *
 * Vanilla stats (storage grid, insulation, in-game description) are joined
 * from the local vanilla DayZ cfg extraction (the "DayZ Projects" folder,
 * console-era config.cpp + languagecore/stringtable.csv) into items.json.
 *
 * Marker positions are projected into the SAME Leaflet content space the map
 * page uses (L.CRS.Simple, world->leaflet via public/js/dayz-map-coordinates.js),
 * so `L.geoJSON(markers)` lands exactly on the tiles.
 *
 * Usage:
 *   node scripts/extract-dayz-data.js <map> [--source <ceRoot>] [--event dayzOffline] [--vanilla <vanillaCfgRoot>]
 *
 * No new dependencies: uses fast-xml-parser (existing) + the house coordinate
 * module. Self-validating: exits non-zero if the output fails invariants.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const ROOT = path.resolve(__dirname, '..');
const CE_ROOT_DEFAULT = process.env.DAYZ_CE_ROOT || '/home/salt/Documents/GitHub/DayZ-Central-Economy';
const VANILLA_ROOT_DEFAULT = process.env.DAYZ_VANILLA_ROOT || '/home/salt/Documents/DayZ-Projects';
const DEFAULT_EVENT = 'dayzOffline';

const DayzMapCoordinates = require(path.join(ROOT, 'public', 'js', 'dayz-map-coordinates.js'));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { map: null, source: CE_ROOT_DEFAULT, event: DEFAULT_EVENT, vanilla: VANILLA_ROOT_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--event') args.event = argv[++i];
    else if (a === '--vanilla') args.vanilla = argv[++i];
    else if (!a.startsWith('--') && args.map === null) args.map = a;
  }
  if (!args.map) {
    console.error('Usage: node scripts/extract-dayz-data.js <map> [--source <ceRoot>] [--event <event>]');
    process.exit(2);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Display-name derivation (classname -> human words). Heuristic, good enough
// for an item browser; the raw classname is always kept too.
// ---------------------------------------------------------------------------
function humanize(classname) {
  return String(classname)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// types.xml -> item catalog
// ---------------------------------------------------------------------------
function extractItems(xmlText, map, vanilla) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xmlText);
  const types = doc.types && doc.types.type;
  if (!Array.isArray(types)) throw new Error(`types.xml: no <types>/<type> array for ${map}`);

  const items = [];
  for (const t of types) {
    const classname = t['@_name'];
    if (!classname) continue;

    // tier / unique from <value name="TierN"/> | <value name="Unique"/>
    let tier = null;
    let unique = false;
    const values = toArray(t.value).map((v) => v && v['@_name']);
    for (const v of values) {
      if (v === 'Unique') unique = true;
      else if (/^Tier(\d+)$/.test(v)) tier = parseInt(v.match(/^Tier(\d+)$/)[1], 10);
    }

    // <flags .../> is a self-closing tag: fast-xml-parser returns its
    // attributes directly as an object of "@_name" keys (no children).
    const flagsRaw = (typeof t.flags === 'object' && t.flags) || {};
    const flags = {};
    for (const [k, v] of Object.entries(flagsRaw)) {
      if (!k.startsWith('@_')) continue;
      flags[camelCaseFlag(k.slice(2))] = Number(v);
    }

    const v = vanilla ? vanilla.get(classname) : null;
    items.push({
      classname,
      name: humanize(classname),
      category: single(t.category, 'name') || null,
      tier,
      unique,
      nominal: num(t.nominal),
      lifetime: num(t.lifetime),
      restock: num(t.restock),
      min: num(t.min),
      quantmin: num(t.quantmin),
      quantmax: num(t.quantmax),
      cost: num(t.cost),
      flags,
      usages: toArray(t.usage).map((u) => u && u['@_name']).filter(Boolean),
      // Vanilla cfg stats (buildVanillaIndex): null when the item is not in
      // the local extraction (console-only items, CE event items).
      storageGrid: v ? v.storageGrid : null,
      storageSlots: v ? v.storageSlots : null,
      insulation: v ? v.insulation : null,
      description: v ? v.description : null,
    });
  }
  return items;
}

function camelCaseFlag(snake) {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
function single(node, attr) {
  if (!node) return null;
  const n = Array.isArray(node) ? node[0] : node;
  return n ? n['@_' + attr] : null;
}
function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
function num(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Vanilla DayZ cfg (local "DayZ Projects" extraction) -> per-classname stats:
// storage grid (itemSize[]), insulation (heatIsolation), in-game description
// (descriptionShort, resolved through languagecore/stringtable.csv).
// Console-era config syntax: class blocks with inheritance, properties as
// `name=value;` / `name[]={...};`. Class lookup walks the parent chain
// (leaf wins); a property the item doesn't define anywhere stays null.
// ---------------------------------------------------------------------------
function vanillaPropVal(block, name) {
  // `name=v;` `name[]={1,2};` (value: string, array, or number)
  let m = new RegExp('\\b' + name + '\\s*(?:\\[[^\\]]*\\])?\\s*=\\s*(?:"([^"]*)"|\\{([^}]*)\\}|([0-9eE.+-]+))\\s*;').exec(block);
  if (!m) {
    // array form without '=':  name[]\n{\n  1,\n  2\n};
    m = new RegExp('\\b' + name + '\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}\\s*;').exec(block);
  }
  if (!m) return undefined;
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : Number(m[3]);
}

function vanillaClassBlocks(root) {
  const defs = new Map(); // classname -> { parent, block }
  const reClass = /\bclass\s+([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_]\w*)\s*)?\{/g;
  const parseFile = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    reClass.lastIndex = 0;
    let m;
    while ((m = reClass.exec(text))) {
      let depth = 1;
      let i = m.index + m[0].length;
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
      }
      const entry = { parent: m[2] || null, block: text.slice(m.index + m[0].length, i - 1) };
      const prev = defs.get(m[1]);
      // shortcut: duplicates (rare across modules) keep the richest block;
      // upgrade to strict patch-order if a duplicate ever diverges.
      if (!prev || entry.block.length > prev.block.length) defs.set(m[1], entry);
    }
  };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'config.cpp') parseFile(p);
    }
  };
  walk(path.join(root, 'DZ'));
  return defs;
}

function parseStringTable(csvText) {
  const out = new Map(); // key -> english text
  const lines = csvText.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) { // line 0 = header
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = [];
    let cur = '';
    let inQ = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (inQ) {
        if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    // columns: key, original, english, czech, ... (14 language columns)
    if (cells[0] && cells[2]) out.set(cells[0], cells[2]);
  }
  return out;
}

// -> Map<classname, { storageGrid, storageSlots, insulation, description }>
// `wanted` (optional Set of catalog classnames) limits resolution to what
// the catalog needs — the cfg defines ~40k classes, the catalog ~2.4k.
function buildVanillaIndex(root, wanted) {
  const defs = vanillaClassBlocks(root);
  const strings = parseStringTable(fs.readFileSync(path.join(root, 'languagecore', 'stringtable.csv'), 'utf8'));

  const resolve = (name) => {
    const out = {};
    const seen = new Set();
    let cur = name;
    while (cur && defs.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const { parent, block } = defs.get(cur);
      if (out.itemSize === undefined) out.itemSize = vanillaPropVal(block, 'itemSize');
      if (out.heatIsolation === undefined) out.heatIsolation = vanillaPropVal(block, 'heatIsolation');
      if (out.descriptionShort === undefined) out.descriptionShort = vanillaPropVal(block, 'descriptionShort');
      cur = parent;
    }
    let grid = null;
    let slots = null;
    if (typeof out.itemSize === 'string') {
      const [w, h] = out.itemSize.split(',').map((s) => Number(s.trim()));
      if (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) {
        grid = w + 'x' + h;
        slots = w * h;
      }
    }
    const insul = typeof out.heatIsolation === 'number' ? Math.round(out.heatIsolation * 100) / 100 : null;
    let description = null;
    const ds = out.descriptionShort;
    if (typeof ds === 'string' && ds && ds !== '...') {
      description = ds.startsWith('$STR_') || ds.startsWith('STR_')
        ? strings.get(ds.replace(/^\$/, '')) || null
        : ds;
    }
    return { storageGrid: grid, storageSlots: slots, insulation: insul, description: description || null };
  };

  const names = wanted ? [...wanted].filter((n) => defs.has(n)) : [...defs.keys()];
  const index = new Map();
  for (const name of names) index.set(name, resolve(name));
  return index;
}

// ---------------------------------------------------------------------------
// cfgspawnabletypes.xml -> per-classname spawn tuning (P2 item catalog).
// Keeps only what the page frames as "what actually spawns on this server":
// spawn damage range (<damage min max/>), part attachments (<attachments>),
// hoarder flag. Container cargo presets are out of scope for the catalog.
// ---------------------------------------------------------------------------
function extractSpawnables(xmlText) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xmlText);
  const types = toArray(doc.spawnabletypes && doc.spawnabletypes.type);
  if (!types.length) throw new Error('cfgspawnabletypes.xml: no <type> entries found');
  const out = {};
  for (const t of types) {
    const name = t['@_name'];
    if (!name) continue;
    const entry = {};
    if (t.damage) {
      entry.damageMin = num(t.damage['@_min']);
      entry.damageMax = num(t.damage['@_max']);
    }
    // <hoarder /> is self-closing with no attributes; fast-xml-parser keeps
    // the key (undefined value) only when siblings exist, so test presence.
    if ('hoarder' in t) entry.hoarder = true;
    if (t.attachments) {
      const parts = [];
      for (const a of toArray(t.attachments)) {
        for (const it of toArray(a.item)) {
          if (it && it['@_name']) parts.push({ name: it['@_name'], chance: num(it['@_chance']) });
        }
      }
      if (parts.length) entry.parts = parts;
    }
    if (Object.keys(entry).length) out[name] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Category classification for spawn groups (classname + proto usages).
// Returns one of: store, farm, industrial, police, fire, medic, military,
// contaminated, crash, residential, coast, hunting, other.
// Priority = most specific loot-POI first; crash (wrecks) beats the building
// categories it is built from (e.g. a wrecked fire truck is a crash, not fire).
// ---------------------------------------------------------------------------
const RE = {
  crash: /Wreck|Crash/i,
  contaminated: /Contaminat|Nuclear|Radiation|Radio_Tower|RadioStation/i,
  police: /Police|Prison|Detention|Jail/i,
  fire: /FireStation|Firestation|Firehouse|FireTruck/i,
  medic: /Hospital|Medical|Medic|Clinic|Pharmacy|Ambulance|Health/i,
  military: /\bMil_|Military|Barrack|Airfield|Airport|Hangar|Radar|Silo|Bunker|Border|Guardhouse|Checkpoint|Depot|Aircraft|_Base_|Rocket|Missile|\bATC\b/i,
  store: /Store|Supermarket|Shop|Market|Bazaar|Grocery|Kiosk|CarService|Workshop|FuelStation|Trad/i,
  farm: /Farm|Barn|Stable|Greenhouse|Chicken|Cattle|Goat|Pig|Sheep|Haybale/i,
  industrial: /Industr|Factory|Warehouse|Storage|Refin|Power|Plant|Mine|Quarry|Oil|Sawmill|Substation|Transformer|Cement|_Rail_|Pipeline|Drill|_Tank_/i,
  coast: /Coast|Boat|Boathouse|Beach|Pier|Harbor|Dock|Lighthouse|Ferry|Marine/i,
  hunting: /Hunt|DeerStand|FeedShack|\bStand\b/i,
  residential: /House|Home|Village|City|Resort|Hotel|Camp|Refugee|School|Office|Church|Mosque|Monastery|Cemetery|Park/i,
};

function classify(name, usages) {
  const u = usages || [];
  const has = (s) => u.includes(s);
  // 1. contaminated (usage is authoritative)
  if (has('ContaminatedArea') || RE.contaminated.test(name)) return 'contaminated';
  // 2. crash — wrecks/crashes win over the building type
  if (RE.crash.test(name)) return 'crash';
  // 3. police / fire / medic (usage first, classname fallback)
  if (has('Police') || RE.police.test(name)) return 'police';
  if (has('Firefighter') || RE.fire.test(name)) return 'fire';
  if (has('Medic') || RE.medic.test(name)) return 'medic';
  // 4. military
  if (has('Military') || has('MilitaryEast') || has('MilitaryWest') || RE.military.test(name)) return 'military';
  // 5. store (no usage tag — classname driven)
  if (RE.store.test(name)) return 'store';
  // 6. farm / industrial (usage first)
  if (has('Farm') || RE.farm.test(name)) return 'farm';
  if (has('Industrial') || RE.industrial.test(name)) return 'industrial';
  // 7. coast / hunting (usage first)
  if (has('Coast') || RE.coast.test(name)) return 'coast';
  if (has('Hunting') || RE.hunting.test(name)) return 'hunting';
  // 8. residential catch-all for village/town/school/office
  if (has('Village') || has('Town') || has('School') || has('Office') || has('Historical') || RE.residential.test(name)) return 'residential';
  return 'other';
}

// Rough 1..4 loot-value indicator per group, from the loot categories it can
// spawn plus its usage. Transparent heuristic (the dashboard can re-derive from
// `categories`/`usages`). weapons/explosives => high; food/clothes/books => low.
function lootTier(categories, usages) {
  const cats = new Set(categories || []);
  const u = usages || [];
  let tier = 1;
  if (cats.has('weapons') || cats.has('explosives')) tier = 3;
  else if (cats.has('tools') || cats.has('containers')) tier = 2;
  if (u.includes('Military') || u.includes('MilitaryEast') || u.includes('MilitaryWest') || u.includes('ContaminatedArea')) tier += 1;
  return Math.min(4, Math.max(1, tier));
}

// ---------------------------------------------------------------------------
// mapgroupproto.xml -> name -> { usages, categories }
// ---------------------------------------------------------------------------
function parseProto(xmlText) {
  // The source root element is <prototype>, a name fast-xml-parser refuses to
  // emit (reserved-keyword guard). Rename just the root tag; group names live
  // in the `name` attribute, not tag names, so nothing else needs it.
  const text = xmlText.replace(/<prototype>/, '<groupprotos>').replace(/<\/prototype>/, '</groupprotos>');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(text);
  const groups = (doc.groupprotos && doc.groupprotos.group) || [];
  // Key by lowercase name: mapgrouppos.xml and mapgroupproto.xml disagree on
  // casing for some groups (e.g. Land_TradTent_* vs Land_Tradtent_*), and a
  // case-sensitive join would silently drop their loot definitions.
  const byName = new Map();
  for (const g of toArray(groups)) {
    const name = g['@_name'];
    if (!name) continue;
    const usages = toArray(g.usage).map((u) => u && u['@_name']).filter(Boolean);
    const containers = toArray(g.container);
    const categories = new Set();
    for (const c of containers) for (const cat of toArray(c.category)) categories.add(cat && cat['@_name']);
    byName.set(String(name).toLowerCase(), { usages, categories: [...categories] });
  }
  return byName;
}

// ---------------------------------------------------------------------------
// mapgrouppos.xml -> instances (name, east, north, elevation)
// ---------------------------------------------------------------------------
function parsePos(xmlText) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xmlText);
  const groups = (doc.map && doc.map.group) || [];
  const out = [];
  for (const g of toArray(groups)) {
    const name = g['@_name'];
    const pos = g['@_pos'];
    if (!name || !pos) continue;
    const parts = String(pos).split(/\s+/).map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) continue;
    // pos = "X Y Z"  =>  X=east, Y=elevation, Z=north (DayZ world axes)
    out.push({ name, east: parts[0], elevation: parts[1], north: parts[2] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build marker GeoJSON (positions in Leaflet content space)
// ---------------------------------------------------------------------------
function buildMarkers(map, proto, posInstances) {
  const features = [];
  let unmatched = 0;
  for (const inst of posInstances) {
    const def = proto.get(inst.name.toLowerCase()) || { usages: [], categories: [] };
    if (!proto.has(inst.name.toLowerCase())) unmatched += 1;
    const category = classify(inst.name, def.usages);
    const lt = DayzMapCoordinates.worldToLeaflet({ east: inst.east, north: inst.north }, map);
    features.push({
      type: 'Feature',
      properties: {
        name: inst.name,
        category,
        lootTier: lootTier(def.categories, def.usages),
        usages: def.usages,
        categories: def.categories,
        elevation: inst.elevation,
      },
      geometry: { type: 'Point', coordinates: [lt[1], lt[0]] }, // [lng, lat] = [eastPx, northPx]
    });
  }
  return { features, unmatched };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const { map, source, event, vanilla } = parseArgs(process.argv.slice(2));
  const srcDir = path.join(source, `${event}.${map}`);
  const typesPath = path.join(srcDir, 'db', 'types.xml');
  const protoPath = path.join(srcDir, 'mapgroupproto.xml');
  const posPath = path.join(srcDir, 'mapgrouppos.xml');
  const spawnableTypesPath = path.join(srcDir, 'cfgspawnabletypes.xml');

  for (const p of [typesPath, protoPath, posPath, spawnableTypesPath]) {
    if (!fs.existsSync(p)) {
      console.error(`✗ Missing source file: ${p}`);
      process.exit(1);
    }
  }
  for (const p of [path.join(vanilla, 'DZ'), path.join(vanilla, 'languagecore', 'stringtable.csv')]) {
    if (!fs.existsSync(p)) {
      console.error(`✗ Missing vanilla cfg source: ${p} (pass --vanilla <root> or set DAYZ_VANILLA_ROOT)`);
      process.exit(1);
    }
  }

  // Classnames first, so the vanilla index only resolves catalog items.
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const typesDoc = parser.parse(fs.readFileSync(typesPath, 'utf8'));
  const classNames = toArray(typesDoc.types && typesDoc.types.type)
    .map((t) => t && t['@_name']).filter(Boolean);
  const vanillaIndex = buildVanillaIndex(vanilla, new Set(classNames));

  const items = extractItems(fs.readFileSync(typesPath, 'utf8'), map, vanillaIndex);
  const proto = parseProto(fs.readFileSync(protoPath, 'utf8'));
  const posInstances = parsePos(fs.readFileSync(posPath, 'utf8'));
  const { features, unmatched } = buildMarkers(map, proto, posInstances);
  const spawnables = extractSpawnables(fs.readFileSync(spawnableTypesPath, 'utf8'));

  const outDir = path.join(ROOT, 'data', map);
  fs.mkdirSync(outDir, { recursive: true });
  const itemsPath = path.join(outDir, 'items.json');
  const markersPath = path.join(outDir, 'markers.geojson');
  const spawnablesPath = path.join(outDir, 'spawnables.json');
  fs.writeFileSync(itemsPath, JSON.stringify({ map, event, count: items.length, items }, null, 2));
  fs.writeFileSync(markersPath, JSON.stringify({ type: 'FeatureCollection', map, event, count: features.length, features }, null, 2));
  fs.writeFileSync(spawnablesPath, JSON.stringify({ map, event, source: 'cfgspawnabletypes.xml', count: Object.keys(spawnables).length, types: spawnables }, null, 2));

  // ---- self-validation (invariants) --------------------------------------
  const tiered = items.filter((i) => i.tier !== null).length;
  const uniques = items.filter((i) => i.unique).length;
  const badCoords = features.filter((f) => {
    const [lng, lat] = f.geometry.coordinates;
    return !Number.isFinite(lng) || !Number.isFinite(lat);
  }).length;
  const catCounts = {};
  for (const f of features) catCounts[f.properties.category] = (catCounts[f.properties.category] || 0) + 1;

  const problems = [];
  if (items.length === 0) problems.push('item catalog is empty');
  if (features.length === 0) problems.push('no markers generated');
  if (badCoords > 0) problems.push(`${badCoords} markers have non-finite coordinates`);
  if (tiered === 0) problems.push('no tiered items found (expected some <value name="TierN"/>)');
  if (Object.keys(spawnables).length === 0) problems.push('spawnables.json is empty (expected <type> entries in cfgspawnabletypes.xml)');
  if (!spawnables.Hatchback_02 || !spawnables.Hatchback_02.parts) {
    problems.push('Hatchback_02 missing from spawnables or has no part attachments (expected wheels/doors)');
  }

  // Vanilla cfg join: most items should carry storage/insulation; the local
  // stringtable only covers a subset of in-game descriptions (~10%), so that
  // bound is low by design.
  const withStorage = items.filter((i) => i.storageSlots != null).length;
  const withInsulation = items.filter((i) => i.insulation != null).length;
  const withDescription = items.filter((i) => typeof i.description === 'string' && i.description).length;
  if (withStorage < items.length * 0.5) problems.push(`storage stats missing for most items (${withStorage}/${items.length})`);
  if (withInsulation < items.length * 0.4) problems.push(`insulation missing for most items (${withInsulation}/${items.length})`);
  if (withDescription < 50) problems.push(`expected >50 resolvable in-game descriptions, got ${withDescription}`);
  // Spot-checked vanilla values (console cfg, resolved through inheritance).
  const spot = (cn, field, expected) => {
    const it = items.find((i) => i.classname === cn);
    if (!it) return problems.push(`spot-check item ${cn} missing from catalog`);
    if (it[field] !== expected) problems.push(`${cn}.${field} = ${JSON.stringify(it[field])}, expected ${JSON.stringify(expected)}`);
  };
  spot('GorkaEJacket_Winter', 'insulation', 0.6);
  spot('GorkaEJacket_Winter', 'storageSlots', 12);
  spot('BandageDressing', 'storageSlots', 2);
  spot('Ammo_556x45', 'storageSlots', 1);
  if (problems.length) {
    console.error(`✗ Validation failed for ${map}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(`✓ ${map} (event=${event})`);
  console.log(`  items:   ${items.length}  (${tiered} tiered, ${uniques} unique) -> ${path.relative(ROOT, itemsPath)}`);
  console.log(`  vanilla: ${withStorage} storage, ${withInsulation} insulation, ${withDescription} descriptions (of ${items.length})`);
  console.log(`  markers: ${features.length}  (${unmatched} instances had no proto def) -> ${path.relative(ROOT, markersPath)}`);
  console.log(`  categories: ${Object.entries(catCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`);
}

main();
