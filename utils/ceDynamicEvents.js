/**
 * CE Dynamic Events (Central Economy mod) — parser + feed helpers.
 *
 * Console Nitrado DayZ servers with the CE mod log live world events
 * (containers, wrecked vehicles, armories, convoys) to BOTH the RPT and
 * server.log:
 *
 *   HH:MM:SS[.mmm] [CE][DE] [<Type>] Spawning: EventID:[N] CurrentID:[M] at [x,y,z] a: R
 *
 *   e.g. 3:41:42.387 [CE][DE] [StaticContainerLocked] Spawning: EventID:[24]
 *        CurrentID:[20067] at [11690.0,-1.0,10555.1] a: -1.000
 *
 * The same instance appears in both files, so callers must dedupe by
 * (serverId, eventId, currentId): parseCEDynamicEvents dedupes within one
 * call (optionally across a shared `seen` Set), and the events-table check in
 * routes/logParser.js covers dedupe across scans/restarts.
 */
'use strict';

const { getMapDefinition } = require('../public/js/dayz-map-coordinates.js');

/**
 * Spawning line format. server.log omits the millisecond fraction
 * (e.g. "11:16:24"); RPT includes it. Tolerates trailing CR (CRLF logs).
 */
const DE_SPAWNING_REGEX = /^\s*(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\s+\[CE\]\[DE\]\s+\[([A-Za-z0-9_]+)\]\s+Spawning:\s+EventID:\[(\d+)\]\s+CurrentID:\[(\d+)\]\s+at\s+\[(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\]\s+a:\s*(-?\d+(?:\.\d+)?)\s*$/;

/** Map a raw <Type> to its human-readable feed name. */
function humanNameForDeType(deType) {
  if (typeof deType !== 'string' || !deType) return 'Dynamic event';
  if (deType === 'StaticContainerLocked') return 'Locked container / armory';
  if (deType === 'StaticHeliCrash' || deType === 'StaticHeliCrashBig' || deType === 'HeliCrashBig') return 'Heli crash';
  if (deType === 'StaticPoliceCar') return 'Police-car wreck';
  if (deType === 'StaticWaterTruck') return 'Water-truck wreck';
  if (deType === 'StaticMilitaryConvoy') return 'Military convoy';
  if (deType === 'ItemBricks') return 'Loot';
  const rental = /^StaticRental(\d+)$/.exec(deType);
  if (rental) return `Rental (${rental[1]})`;
  if (deType.startsWith('VehicleRental')) return 'Rental vehicle';
  return deType;
}

/**
 * Coordinate groups the dashboard toggles map to. Settings store the group
 * labels (announce/suppress), so a whole family (e.g. every StaticRentalNNN)
 * is controlled by one toggle.
 */
const DE_TYPE_GROUPS = [
  { label: 'Locked container / armory', match: t => t === 'StaticContainerLocked' },
  { label: 'Heli crash', match: t => t === 'StaticHeliCrash' || t === 'StaticHeliCrashBig' || t === 'HeliCrashBig' },
  { label: 'Police-car wreck', match: t => t === 'StaticPoliceCar' },
  { label: 'Water-truck wreck', match: t => t === 'StaticWaterTruck' },
  { label: 'Military convoy', match: t => t === 'StaticMilitaryConvoy' },
  { label: 'Rental property', match: t => /^StaticRental\d+$/.test(t) },
  { label: 'Rental vehicle', match: t => typeof t === 'string' && t.startsWith('VehicleRental') },
  { label: 'Loot', match: t => t === 'ItemBricks' },
];

function deTypeGroupFor(deType) {
  return DE_TYPE_GROUPS.find(group => group.match(deType)) || null;
}

/**
 * Reject NaN or out-of-map positions before any persistence. CE has emitted
 * corrupt values (a player was observed logged at -340282346638…); those must
 * never reach the map or the events table.
 */
function validateDePosition(position, mapName = 'nasdara') {
  if (!position) return false;
  const { x, y, z } = position;
  const map = getMapDefinition(mapName);
  if (![x, y, z].every(Number.isFinite)) return false;
  if (x < 0 || x > map.worldWidth || z < 0 || z > map.worldHeight) return false;
  // Elevation may sit below ground level (observed: -1.0); wild magnitudes are
  // corrupt. shortcut: fixed sanity band, tighten per-map if real bounds appear.
  return y >= -500 && y <= 2000;
}

/** Parse a single Spawning line → raw fields, or null if not a DE line. */
function parseDeLine(line) {
  const match = DE_SPAWNING_REGEX.exec(String(line || ''));
  if (!match) return null;
  return {
    clock: match[1],
    deType: match[2],
    eventId: Number(match[3]),
    currentId: Number(match[4]),
    pos: { x: Number(match[5]), y: Number(match[6]), z: Number(match[7]) },
    rotation: Number(match[8]),
  };
}

/**
 * Parse log lines into DE events.
 *
 * @param {string[]|Iterable<string>} lines  log lines
 * @param {Object}   [opts]
 * @param {string}   [opts.mapName='nasdara'] bounds map for coordinate validation
 * @param {Set}      [opts.seen]   shared (eventId:currentId) key Set for
 *                                 cross-file dedupe; created when omitted
 * @returns {{ events: Array, rejected: number, duplicates: number, seen: Set }}
 *   events: [{ deType, eventId, currentId, pos, rotation, clock, humanName }]
 *   rejected:  out-of-range positions skipped
 *   duplicates: same-instance lines skipped
 */
function parseCEDynamicEvents(lines, { mapName = 'nasdara', seen = null } = {}) {
  const seenKeys = seen instanceof Set ? seen : new Set();
  const events = [];
  let rejected = 0;
  let duplicates = 0;

  for (const line of lines) {
    const parsed = parseDeLine(line);
    if (!parsed) continue;
    const key = `${parsed.eventId}:${parsed.currentId}`;
    if (seenKeys.has(key)) {
      duplicates += 1;
      continue;
    }
    if (!validateDePosition(parsed.pos, mapName)) {
      rejected += 1;
      continue;
    }
    seenKeys.add(key);
    events.push({
      deType: parsed.deType,
      eventId: parsed.eventId,
      currentId: parsed.currentId,
      pos: parsed.pos,
      rotation: parsed.rotation,
      clock: parsed.clock,
      humanName: humanNameForDeType(parsed.deType),
    });
  }
  return { events, rejected, duplicates, seen: seenKeys };
}

/**
 * Feed filter: settings = { announce:[group labels], suppress:[group labels] }.
 * Default ON = announce all types. suppress wins over announce.
 */
function shouldAnnounceDeSpawn(deType, settings) {
  const s = settings || {};
  const group = deTypeGroupFor(deType);
  if (Array.isArray(s.suppress) && group && s.suppress.includes(group.label)) return false;
  if (Array.isArray(s.announce) && s.announce.length > 0) {
    return Boolean(group) && s.announce.includes(group.label);
  }
  return true;
}

/**
 * Build the dashboard map deep-link URL for a world position:
 *   <origin>/map.html?map=<mapName>&marker=<east>,<north>
 * map.js drops a marker on `marker` (validated against the map bounds there).
 * Returns null when the position or origin is unusable — callers omit the
 * link line rather than post a broken one.
 */
function buildMapDeepLink({ mapName = 'nasdara', east, north, origin }) {
  if (!origin || !Number.isFinite(east) || !Number.isFinite(north)) return null;
  const map = getMapDefinition(mapName);
  if (east < 0 || east > map.worldWidth || north < 0 || north > map.worldHeight) return null;
  return `${origin}/map.html?map=${encodeURIComponent(mapName)}&marker=${Math.round(east)},${Math.round(north)}`;
}

module.exports = {
  DE_SPAWNING_REGEX,
  DE_TYPE_GROUPS,
  parseDeLine,
  parseCEDynamicEvents,
  humanNameForDeType,
  deTypeGroupFor,
  validateDePosition,
  shouldAnnounceDeSpawn,
  buildMapDeepLink,
};
