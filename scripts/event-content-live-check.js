'use strict';
/* Live acceptance check: run the event/content generators against the REAL
 * SALT XB enoch working copy on saltskrew. No HTTP — direct service calls so
 * we exercise the real mission XML (comment-interleaved weather, 26 spawn
 * groups, existing event/group names) and prove the generated blocks are
 * well-formed + materialize into valid patches. */
const fs = require('fs');
const path = require('path');
const { XMLValidator, XMLParser } = require('fast-xml-parser');

const ROOT = process.cwd();
const svc = require(path.join(ROOT, 'services', 'eventContentService'));

const serverRoot = '/home/salt/dayz-dashboard/downloads/789326430571855893/server_15580969';
const mapName = 'enoch';
const mapDir = svc.resolveMissionDir(serverRoot, mapName);
if (!mapDir) { console.error('FAIL: enoch mission dir not found under', serverRoot); process.exit(1); }
console.log('mission dir:', mapDir);

let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}

// ── 1. Event generation: winter ──
const plan = svc.generateEventBlocks({ mapName, mapDir }, 'winter', {});
check('winter plan eventName unique', !plan._eventNames.includes(plan.eventName), plan.eventName);
check('winter plan groupName unique', !plan._groupNames.includes(plan.groupName), plan.groupName);
check('parsed real events', plan.validation.existingEvents > 5, `${plan.validation.existingEvents} events`);
check('parsed real groups', plan.validation.existingGroups > 5, `${plan.validation.existingGroups} groups`);
check('map bounds resolved', plan.validation.mapBounds && plan.validation.mapBounds.max > 10000, JSON.stringify(plan.validation.mapBounds));

const suggestions = svc.materializeEventSuggestions(plan);
check('materialized suggestions', suggestions.length >= 3, `${suggestions.length} (event+group+weather)`);
const files = new Set(suggestions.map(s => s.filename));
check('covers spawns+groups+weather', files.has('cfgeventspawns.xml') && files.has('cfgeventgroups.xml') && files.has('cfgweather.xml'), [...files].join(', '));

for (const s of suggestions) {
  const wf = XMLValidator.validate(s.suggestedContent, { allowBooleanAttributes: true });
  if (wf !== true) { check(`well-formed ${s.filename}`, false, String(wf)); continue; }
  // CE registration check against the real mission.
  const ce = svc.ceRegistrationNote(mapDir, s.filename);
  check(`well-formed + CE-typed ${s.filename}`, ce.ok, ce.documentType || 'no-ce-doc-type');
  // Re-parse suggested content to confirm the new element is actually present.
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(s.suggestedContent);
  if (s.filename === 'cfgeventspawns.xml') {
    check('event present in suggested spawns',
      JSON.stringify(doc).includes(plan.eventName), '');
  }
  if (s.filename === 'cfgeventgroups.xml') {
    check('group present in suggested groups',
      JSON.stringify(doc).includes(plan.groupName), '');
  }
  if (s.filename === 'cfgweather.xml') {
    check('weather edit pinned to base hash', s.baseContentHash.length === 64, '');
  }
}

// ── 2. Spawn design: bounds against real enoch (0..12800) ──
const spawn = svc.designSpawnGroup({ mapName, mapDir }, 'SALTTestZone', [[6400, 6400], [10000, 9000]]);
check('spawn group materialized', spawn.suggestion.suggestedContent.includes('SALTTestZone'), '');
check('spawn group well-formed',
  XMLValidator.validate(spawn.suggestion.suggestedContent, { allowBooleanAttributes: true }) === true, '');

// ── 3. Loot design: against real spawn config (real types.xml) ──
try {
  const loot = svc.designLootEntry({ mapName, mapDir }, 'SALTWinterItem', { nominal: 50 });
  check('loot entry well-formed', XMLValidator.validate(loot.suggestion.suggestedContent, { allowBooleanAttributes: true }) === true, `nominal=${loot.nominal}`);
} catch (e) {
  check('loot design', false, `${e.code}: ${e.message}`);
}

// ── 4. Season plan: real multi-mission (enoch present; cherno/sakhal maybe) ──
try {
  const season = svc.planSeason(serverRoot, 'winter', 28);
  check('season plan has >=1 mission', season.missions.length >= 1, `${season.missions.length} mission(s)`);
  check('season markdown has schedule', season.markdown.includes('| Mission | Window |'), '');
  check('season suggestions generated', season.missions[0].suggestions && season.missions[0].suggestions.length >= 3,
    `${season.missions[0].suggestions ? season.missions[0].suggestions.length : 0} on ${season.missions[0].mapName}`);
} catch (e) {
  check('season plan', false, `${e.code}: ${e.message}`);
}

// ── 5. Out-of-bounds must be rejected against real enoch ──
let oobRejected = false;
try { svc.validateMapCoordinate('enoch', 99999, 6400); } catch (e) { oobRejected = e.code === 'COORD_OUT_OF_BOUNDS'; }
check('out-of-bounds coordinate rejected', oobRejected, '');

console.log(`\n${failures === 0 ? 'ALL LIVE CHECKS PASSED' : failures + ' LIVE CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
