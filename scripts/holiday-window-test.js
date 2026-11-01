'use strict';

/* Roadmap P1: loadout browser + holiday-event marker windows.
   - holiday-window logic: pure matchState from public/js/holiday-windows.js (the exact file the browser loads)
   - loadout page: every listed slug exists in public/kitty_loadouts/ and is valid loadout JSON, and vice versa
   - wiring: event-spawns route honors ?mission=, map.js gates the holiday marker set
   - window↔pack: every window maps to a real Central-Economy pack (per-map coverage reported)
   Run: node scripts/holiday-window-test.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { getEventSpawnLocations } = require('../services/eventHealthService');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

// ── Holiday window logic ────────────────────────────────────────────────────

function loadHolidayWindows() {
  const config = JSON.parse(read('public/data/holiday-windows.json'));
  assert(Array.isArray(config.events) && config.events.length >= 4,
    'holiday config must list the Central-Economy holiday packs');
  const ctx = vm.createContext({ window: {}, fetch: undefined });
  vm.runInContext(read('public/js/holiday-windows.js'), ctx, { filename: 'holiday-windows.js' });
  return ctx.window.HolidayWindows;
}

function testWindowToggles() {
  const HW = loadHolidayWindows();
  const config = JSON.parse(read('public/data/holiday-windows.json'));
  const at = ymd => new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)), 12, 0, 0);

  // Live inside a window
  let s = HW.matchState(config.events, 'ChristmasOffline.ChernarusPlus', at('2026-12-10'));
  assert(s && s.id === 'christmas' && s.live === true, 'christmas must be live mid-window');
  assert.strictEqual(s.start, '2026-12-01');
  assert.strictEqual(s.end, '2026-12-24');

  // Inclusive calendar boundaries (local TZ)
  assert(HW.matchState(config.events, 'halloweenOffline.sakhal', new Date(2026, 9, 24, 0, 0, 0, 1)).live === true,
    'halloween window must be inclusive of start day');
  assert(HW.matchState(config.events, 'halloweenOffline.sakhal', new Date(2026, 9, 31, 23, 59, 59, 999)).live === true,
    'halloween window must be inclusive of end day');
  assert(HW.matchState(config.events, 'halloweenOffline.sakhal', at('2026-11-01')).live === false,
    'halloween window must be off after the end day');
  assert(HW.matchState(config.events, 'halloweenOffline.sakhal', at('2026-10-23')).live === false,
    'halloween window must be off before the start day');

  // Config-driven, not hardcoded: adding a pack is a JSON-only change (valentines is in the config)
  assert(HW.matchState(config.events, 'valentinesOffline.enoch', at('2027-02-13')).live === true,
    'a config-only holiday (valentines) must resolve without code changes');

  // Non-holiday mission → no state (no toggle, no row)
  assert.strictEqual(HW.matchState(config.events, 'dayzOffline.chernarusplus', at('2026-12-10')), null);
  assert.strictEqual(HW.matchState(config.events, null, at('2026-12-10')), null);

  // Case-insensitive prefix match against mission folder names
  assert(HW.matchState(config.events, 'HalloweenOffline.CHernarusPlus', at('2026-10-25')).id === 'halloween');
}

// ── Loadout browser page ────────────────────────────────────────────────────

function testLoadoutPageCoversAllFiles() {
  // The loadout list lives in the external page script (inline <script> is
  // blocked by the app CSP — script-src 'self', no 'unsafe-inline').
  const page = read('public/js/loadouts-page.js');
  const slugs = [...page.matchAll(/^\s*\['([a-z0-9]+)',\s*'[^']+',\s*'(holiday|themed|vanillaplus|other)'\],?\s*$/gm)]
    .map(m => m[1]);
  assert.strictEqual(new Set(slugs).size, slugs.length, 'no duplicate slugs on the page');
  const dirFiles = fs.readdirSync(path.join(root, 'public', 'kitty_loadouts'))
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5));
  assert.strictEqual(dirFiles.length, slugs.length,
    `page lists ${slugs.length} loadouts but public/kitty_loadouts has ${dirFiles.length}`);
  for (const slug of slugs) {
    const file = path.join(root, 'public', 'kitty_loadouts', slug + '.json');
    assert(fs.existsSync(file), `listed slug has no file: ${slug}.json`);
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(Array.isArray(d.attachmentSlotItemSets) && d.attachmentSlotItemSets.length > 0,
      `${slug}.json must carry attachmentSlotItemSets`);
    const items = (d.attachmentSlotItemSets || [])
      .flatMap(slot => slot.discreteItemSets || [])
      .map(item => item.itemType);
    assert(items.length > 0, `${slug}.json must list spawnable items`);
  }
  const pageSet = new Set(slugs);
  for (const f of dirFiles) assert(pageSet.has(f), `file not listed on page: ${f}.json`);
}

// ── Server + client wiring ──────────────────────────────────────────────────

function testMissionPreferralEndToEnd() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holiday-window-test-'));
  try {
    // Two mission folders for one map: base + holiday pack (the real deployment shape).
    for (const [name, marker] of [['dayzOffline.chernarusplus', 'baseEvent'], ['ChristmasOffline.ChernarusPlus', 'xmasEvent']]) {
      const missionDir = path.join(dir, name);
      fs.mkdirSync(missionDir, { recursive: true });
      fs.writeFileSync(path.join(missionDir, 'cfgeventspawns.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>\n<eventposdef><event name="${marker}" pos x="10" z="20" a="0" /></eventposdef>`);
    }
    // No preference: ambiguous (pre-existing behavior — evidence omitted, not an exception).
    const ambiguous = getEventSpawnLocations(dir, 'chernarusplus', {});
    assert.strictEqual(ambiguous.eventSpawnsFileFound, false);
    assert(ambiguous.configurationError.includes('Multiple mission configurations'));
    // Preferred mission = holiday pack → its marker set is what the map gets.
    const preferred = getEventSpawnLocations(dir, 'chernarusplus', { preferredMission: 'ChristmasOffline.ChernarusPlus' });
    assert.strictEqual(preferred.eventSpawnsFileFound, true);
    assert.deepStrictEqual(preferred.events.map(e => e.name), ['xmasEvent']);
    // Preferred mission absent on disk → fall back to full scan (ambiguity surfaces again, no crash).
    const fallback = getEventSpawnLocations(dir, 'chernarusplus', { preferredMission: 'nope.ChernarusPlus' });
    assert.strictEqual(fallback.eventSpawnsFileFound, false);
    assert(fallback.configurationError.includes('Multiple mission configurations'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testRouteAndMapWiring() {
  const registration = read('src/app/registerRoutes.js');
  const route = registration.slice(
    registration.indexOf("app.get('/api/event-spawns/:serverId/:mapName'"),
    registration.indexOf("app.get('/api/detect-structure/:serverId'")
  );
  assert.match(route, /req\.query\.mission/, 'event-spawns route must read the mission query param');
  assert.match(route, /\^\[A-Za-z0-9._-\]\+\$/, 'mission param must be format-validated (no path traversal)');
  assert.match(route, /preferredMission:\s*mission/, 'route must pass the validated mission to the service');
  assert.match(read('services/eventHealthService.js'), /entry\.name !== preferredMission/,
    'mission preference must filter candidate folders by exact folder name');

  const mapJs = read('public/js/map.js');
  assert.match(mapJs, /&mission=' \+ encodeURIComponent\(activeMissionName\)/,
    'map.js must send the active mission with the event-spawns request');
  assert.match(mapJs, /eventTypeFilters\[event\.name\] && \(!holidayState \|\| holidayMarkersVisible\)/,
    'the holiday window state must gate event marker visibility');
  assert.match(mapJs, /activeMissionName = data\.mission/,
    'map.js must capture the active mission name from the active-mission response');

  const mapHtml = read('public/map.html');
  assert(mapHtml.includes('id="holiday-subhead"') && mapHtml.includes('id="holiday-event-row"'),
    'map.html must host the server-event filter row');
  assert(mapHtml.includes('/js/holiday-windows.js'), 'map.html must load the holiday window script');

  // Loadout page logic lives in the external script (inline <script> is
  // blocked by the app CSP — script-src 'self', no 'unsafe-inline').
  const loadoutsPage = read('public/js/loadouts-page.js');
  assert(loadoutsPage.includes('kitty_loadouts/'), 'loadout page must load from the copied JSON dir');
  assert(loadoutsPage.includes('navigator.clipboard.writeText'), 'copy-spawn-config must use the clipboard API');
}

// ── Window ↔ real-pack consistency ──────────────────────────────────────────
// Packs live in the sibling DayZ-Central-Economy repo as <Mission>.<Map> dirs.
// Invariant (asserted): no window may reference a mission with no real pack at all.
// Per-map coverage for the dashboard maps (data/<map>) is reported, not asserted —
// known gaps (e.g. nasdara has no holiday packs) need the operator's decision.
function testWindowPackConsistency() {
  const ceRoot = process.env.DAYZ_CE_PACKS_DIR || path.join(root, '..', 'DayZ-Central-Economy');
  if (!fs.existsSync(ceRoot)) {
    console.log('⚠️  testWindowPackConsistency: pack repo not found — skipped');
    return;
  }
  const packs = fs.readdirSync(ceRoot, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name);
  const config = JSON.parse(read('public/data/holiday-windows.json'));
  const dashMaps = fs.readdirSync(path.join(root, 'data'))
    .filter(m => m !== 'backups' && fs.statSync(path.join(root, 'data', m)).isDirectory());
  for (const ev of config.events) {
    const hits = packs.filter(p =>
      (ev.missions || []).some(m => p.toLowerCase().startsWith(String(m).toLowerCase())));
    assert(hits.length > 0,
      `window "${ev.id}" references mission "${ev.missions.join(',')}" but no such pack exists`);
    const perMap = dashMaps.map(m => {
      const ok = hits.some(p => p.slice(p.lastIndexOf('.') + 1).toLowerCase() === m.toLowerCase());
      return `${m}:${ok ? 'ok' : 'MISSING'}`;
    }).join(' ');
    console.log(`  ${ev.id} → ${hits.length} pack(s) [${perMap}]`);
  }
}

// ── Economy-delta packs: no cfgeventspawns.xml must surface, not fall back ──

function testDeltaPackSurfaces() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holiday-delta-test-'));
  try {
    // Base mission with markers + a "holiday" pack that ships only economy
    // delta files (the real CP/enoch shape) — no cfgeventspawns.xml.
    const base = path.join(dir, 'dayzOffline.chernarusplus');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'cfgeventspawns.xml'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<eventposdef><event name="baseEvent" pos x="1" z="2" a="0" /></eventposdef>');
    const deltaPack = path.join(dir, 'ChristmasOffline.ChernarusPlus');
    fs.mkdirSync(deltaPack, { recursive: true });
    fs.writeFileSync(path.join(deltaPack, 'cfgrandompresets.xml'), '<cfg/>');
    fs.writeFileSync(path.join(deltaPack, 'cfgspawnabletypes.xml'), '<cfg/>');

    // Preferred mission = delta pack → surfaced as economy delta, NOT the base mission's markers.
    const delta = getEventSpawnLocations(dir, 'chernarusplus', { preferredMission: 'ChristmasOffline.ChernarusPlus' });
    assert.strictEqual(delta.eventSpawnsFileFound, false, 'delta pack must not resolve to marker evidence');
    assert.match(delta.configurationError, /no cfgeventspawns\.xml/, 'delta pack must be surfaced by name');
    assert.match(delta.configurationError, /economy delta, no new event markers/);
    assert.match(delta.configurationError, /cfgrandompresets\.xml, cfgspawnabletypes\.xml/,
      'present delta files must be listed');

    // Preferred mission exists on disk with no delta files either → still surfaced.
    const emptyPack = path.join(dir, 'halloweenOffline.ChernarusPlus');
    fs.mkdirSync(emptyPack, { recursive: true });
    const empty = getEventSpawnLocations(dir, 'chernarusplus', { preferredMission: 'halloweenOffline.ChernarusPlus' });
    assert.match(empty.configurationError, /economy delta, no new event markers/);

    // Preferred mission absent on disk → pre-existing full-scan behavior (base markers win).
    const fallback = getEventSpawnLocations(dir, 'chernarusplus', { preferredMission: 'nope.ChernarusPlus' });
    assert.strictEqual(fallback.eventSpawnsFileFound, true);
    assert.deepStrictEqual(fallback.events.map(e => e.name), ['baseEvent']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

testWindowToggles();
testLoadoutPageCoversAllFiles();
testMissionPreferralEndToEnd();
testRouteAndMapWiring();
testWindowPackConsistency();
testDeltaPackSurfaces();
console.log('✅ holiday-window-test: window toggle, loadout coverage (all files), mission preference, wiring, window↔pack consistency, delta-pack surfacing OK');
