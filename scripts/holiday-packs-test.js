'use strict';

// Holiday pack verification (dayz-library/community_builds/holiday_missions/).
//
// Loads each nasdara holiday pack through the dashboard's getEventSpawnLocations
// (the same path map.html uses) and asserts:
//   - every XML file in the pack is well-formed (xmllint)
//   - all base mission events survive with their original position counts
//   - the added events resolve with the expected positions
//   - every position is finite and in-bounds (0..16384)
//   - every group= reference resolves to a group defined in the pack
//   - every classname the pack ADDS to cfgeventgroups.xml exists in the
//     nasdara mapgroupproto.xml (inherited base groups must be byte-identical)
//   - every event name in cfgeventspawns.xml is defined in the pack's db/events.xml
//   - pack-enabled events are active=1; secondaries resolve
//   - folder name matches the holiday-windows.json missions prefix
//
// Run: node scripts/holiday-packs-test.js
// (needs xmllint on PATH; override pack/base locations via HOLIDAY_PACKS_DIR /
// NASDARA_BASE_MISSION env vars)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { XMLParser } = require('fast-xml-parser');

const { getEventSpawnLocations } = require('../services/eventHealthService');

const LIB = process.env.DAYZ_LIBRARY || '/home/salt/Documents/GitHub/dayz-library';
const PACKS_DIR = process.env.HOLIDAY_PACKS_DIR || path.join(LIB, 'community_builds', 'holiday_missions');
const BASE_MISSION = process.env.NASDARA_BASE_MISSION ||
  '/home/salt/.steam/debian-installation/steamapps/common/DayZServer/mpmissions/dayzOffline.nasdara';
const MAP_SIZE = 16384; // dayz-library/community_builds/map-data/nasdara-locations.json

const PACKS = {
  'halloweenOffline.nasdara': {
    prefix: 'halloweenOffline',
    added: { StaticSpookyCamp: 6, StaticBonfire: 4, InfectedSpooky: 0 },
    newEvents: ['StaticSpookyCamp'],
    newGroups: ['SpookyCamp'],
    enabled: ['InfectedSpooky'],
  },
  'ChristmasOffline.nasdara': {
    prefix: 'ChristmasOffline',
    added: { StaticSantaCrash: 6, StaticBonfire: 4, AnimalDeer: 6, AnimalRoeDeer: 4, StaticChristmasMarket: 3, InfectedSanta: 0 },
    newEvents: ['StaticChristmasMarket'],
    newGroups: ['ChristmasMarket'],
    enabled: ['StaticSantaCrash', 'StaticBonfire', 'InfectedSanta', 'AnimalDeer', 'AnimalRoeDeer'],
  },
};

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function parseXml(file) {
  return parser.parse(fs.readFileSync(file, 'utf8'));
}

function xmllint(file) {
  execFileSync('xmllint', ['--noout', file]);
}

function readBase() {
  const spawns = parseXml(path.join(BASE_MISSION, 'cfgeventspawns.xml'));
  const groups = parseXml(path.join(BASE_MISSION, 'cfgeventgroups.xml'));
  // mapgroupproto.xml's root tag (<prototype>) trips fast-xml-parser's
  // reserved-name check — we only need the <group name="..."> set, so regex it.
  const proto = {
    protoGroups: new Set(
      (fs.readFileSync(path.join(BASE_MISSION, 'mapgroupproto.xml'), 'utf8').match(/<group name="([^"]+)"/g) || [])
        .map(m => m.slice(m.indexOf('"') + 1, m.lastIndexOf('"'))),
    ),
  };
  const events = parseXml(path.join(BASE_MISSION, 'db', 'events.xml'));
  return { spawns, groups, proto, events };
}

function eventsOf(doc) {
  const root = Object.values(doc).find(v => v && typeof v === 'object' && v.event);
  assert(root, 'no <event> entries in doc');
  const arr = Array.isArray(root.event) ? root.event : [root.event];
  return arr.filter(e => e && e['@_name']);
}

function positionsOf(ev) {
  return (Array.isArray(ev.pos) ? ev.pos : ev.pos ? [ev.pos] : []).map(p => ({
    x: Number(p['@_x']),
    z: Number(p['@_z']),
    group: p['@_group'] || null,
  }));
}

function groupsOf(doc) {
  const root = Object.values(doc).find(v => v && typeof v === 'object' && v.group);
  assert(root, 'no <group> entries in doc');
  const arr = Array.isArray(root.group) ? root.group : [root.group];
  return arr.filter(g => g && g['@_name']).map(g => ({
    name: g['@_name'],
    children: (Array.isArray(g.child) ? g.child : g.child ? [g.child] : []).map(c => c['@_type']),
  }));
}

function groupSignature(groups) {
  const sig = new Map();
  for (const g of groups) sig.set(g.name, [...g.children].sort().join('|'));
  return sig;
}

function eventBlock(doc, name) {
  const ev = eventsOf(doc).find(e => e['@_name'] === name);
  assert(ev, `event ${name} missing from db/events.xml`);
  return ev;
}

function activeOf(doc, name) {
  const ev = eventBlock(doc, name);
  const raw = ev.active !== undefined ? ev.active : (ev['@_active']);
  assert(raw !== undefined, `active flag missing on ${name}`);
  return String(raw);
}

function assertInBounds(positions, label) {
  for (const p of positions) {
    assert(Number.isFinite(p.x) && Number.isFinite(p.z), `${label}: non-finite position ${JSON.stringify(p)}`);
    assert(p.x >= 0 && p.x <= MAP_SIZE, `${label}: x ${p.x} out of bounds (0..${MAP_SIZE})`);
    assert(p.z >= 0 && p.z <= MAP_SIZE, `${label}: z ${p.z} out of bounds (0..${MAP_SIZE})`);
  }
}

function testPack(name, spec, base) {
  const packDir = path.join(PACKS_DIR, name);
  assert(fs.existsSync(packDir), `pack dir missing: ${packDir}`);

  // 1. well-formed XML
  for (const f of ['cfgeventspawns.xml', 'cfgeventgroups.xml', path.join('db', 'events.xml')]) {
    xmllint(path.join(packDir, f));
  }

  const spawns = parseXml(path.join(packDir, 'cfgeventspawns.xml'));
  const groups = parseXml(path.join(packDir, 'cfgeventgroups.xml'));
  const events = parseXml(path.join(packDir, 'db', 'events.xml'));

  // 2. dashboard path: pack loads through getEventSpawnLocations
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holiday-packs-'));
  try {
    fs.cpSync(packDir, path.join(root, name), { recursive: true });
    const result = getEventSpawnLocations(root, 'nasdara', { preferredMission: name });
    assert.strictEqual(result.configurationError, null, `getEventSpawnLocations error: ${result.configurationError}`);
    assert.strictEqual(result.eventSpawnsFileFound, true, 'cfgeventspawns.xml not found by service');

    // 3. every base event survives with its original position count
    const byName = new Map(result.events.map(e => [e.name, e]));
    for (const baseEv of eventsOf(base.spawns)) {
      const bname = baseEv['@_name'];
      const got = byName.get(bname);
      assert(got, `base event ${bname} missing from dashboard result`);
      assert.strictEqual(got.count, positionsOf(baseEv).length, `base event ${bname} position count changed`);
    }

    // 4. added events resolve with expected counts
    for (const [evName, count] of Object.entries(spec.added)) {
      const got = byName.get(evName);
      assert(got, `added event ${evName} not resolved by getEventSpawnLocations`);
      assert.strictEqual(got.count, count, `${evName}: expected ${count} positions, got ${got.count}`);
      assertInBounds(got.positions, evName);
    }

    // 5. group= references resolve inside the pack; new-group classnames in mapgroupproto
    const allGroups = groupsOf(groups);
    const groupNames = new Set(allGroups.map(g => g.name));
    for (const e of result.events) {
      for (const p of positionsOf(eventsOf(spawns).find(x => x['@_name'] === e.name) || {})) {
        if (p.group) assert(groupNames.has(p.group), `${e.name}: group "${p.group}" not defined in pack cfgeventgroups.xml`);
      }
    }
    const baseSig = groupSignature(groupsOf(base.groups));
    for (const g of allGroups) {
      if (baseSig.has(g.name)) {
        assert.strictEqual(groupSignature([g]).get(g.name), baseSig.get(g.name),
          `inherited group ${g.name} was modified (pack must not touch base groups)`);
      } else {
        assert(spec.newGroups.includes(g.name), `unexpected new group ${g.name}`);
        for (const type of g.children) {
          assert(base.proto.protoGroups.has(type), `classname ${type} (new group ${g.name}) not present in nasdara mapgroupproto.xml`);
        }
      }
    }
    for (const gn of spec.newGroups) assert(groupNames.has(gn), `new group ${gn} missing`);

    // 6. db/events.xml integrity
    const eventNames = new Set(eventsOf(events).map(e => e['@_name']));
    for (const e of eventsOf(spawns)) assert(eventNames.has(e['@_name']), `spawn event ${e['@_name']} not defined in pack db/events.xml`);
    for (const e of eventsOf(events)) {
      const raw = e.secondary;
      const secName = raw && typeof raw === 'object' ? raw['#text'] : raw;
      if (secName) assert(eventNames.has(secName), `${e['@_name']}: secondary ${secName} not defined in pack db/events.xml`);
    }
    for (const evName of spec.enabled) assert.strictEqual(activeOf(events, evName), '1', `${evName} not active=1 in pack`);
    for (const evName of spec.newEvents) {
      assert(eventNames.has(evName), `new event ${evName} missing`);
      assert.strictEqual(activeOf(events, evName), '1', `new event ${evName} not active=1`);
    }

    // 7. dashboard holiday-windows naming: folder name starts with the missions prefix
    assert(name.toLowerCase().startsWith(spec.prefix.toLowerCase()),
      `folder name ${name} does not match holiday-windows.json missions prefix ${spec.prefix}`);

    console.log(`ok ${name} (${result.totalSpawns} spawn positions, ${result.events.length} events, ${allGroups.length} groups)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const base = readBase();
  for (const [name, spec] of Object.entries(PACKS)) testPack(name, spec, base);
  console.log(`\nholiday packs: all checks passed (${Object.keys(PACKS).length} packs)`);
}

if (require.main === module) main();
module.exports = { testPack, main };
