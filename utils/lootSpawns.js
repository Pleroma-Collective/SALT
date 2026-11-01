/**
 * Live loot-spawn parser (Central Economy respawner output).
 *
 * The CE LootRespawner logs every item it places to server.log as:
 *
 *   HH:MM:SS   Adding <ItemClass> at [east,north]
 *
 * e.g. 11:16:20   Adding ShortJeans_Brown at [8554,8678]
 *
 * These are the coord-bearing loot records. The RPT `[CE][LootRespawner]`
 * lines (`respawned:N, tests:N missing:N` and `[RESPAWN CANDIDATE] …`) are the
 * respawner's bookkeeping and carry NO coordinates — verified against the
 * dayzxb log set — so the map layer sources its points from server.log only.
 *
 * Parsing, dedupe and map-bounds validation mirror the Event Feed pipeline
 * (utils/ceDynamicEvents.js): same regex-first line parse, same `seen` Set
 * dedupe across files, same getMapDefinition bounds check so corrupt
 * coordinates never reach the map.
 */
'use strict';

const { getMapDefinition } = require('../public/js/dayz-map-coordinates.js');

/**
 * Spawning line format. server.log omits the millisecond fraction; a trailing
 * CR (CRLF logs) is tolerated. The item class is a DayZ classname (alnum +
 * underscore) — the `[Login]: Adding player …` lines do NOT match because they
 * have no `at [x,z]` coordinate group.
 */
const LOOT_ADDING_REGEX = /^\s*(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\s+Adding\s+([A-Za-z0-9_]+)\s+at\s+\[(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\]\s*$/;

/** Parse a single Adding line → { clock, item, x, z }, or null if not one. */
function parseLootAddingLine(line) {
  const match = LOOT_ADDING_REGEX.exec(String(line || ''));
  if (!match) return null;
  return {
    clock: match[1],
    item: match[2],
    x: Number(match[3]),
    z: Number(match[4]),
  };
}

/**
 * Reject NaN or out-of-map positions before any persistence/rendering.
 * east = DayZ X, north = DayZ Z (the two values the Adding line carries;
 * elevation is absent). Mirrors validateDePosition's bounds approach.
 */
function validateLootPosition(position, mapName = 'nasdara') {
  if (!position) return false;
  const { x, z } = position;
  const map = getMapDefinition(mapName);
  if (![x, z].every(Number.isFinite)) return false;
  return x >= 0 && x <= map.worldWidth && z >= 0 && z <= map.worldHeight;
}

/**
 * Parse log lines into loot spawns.
 *
 * @param {string[]|Iterable<string>} lines  log lines
 * @param {Object}   [opts]
 * @param {string}   [opts.mapName='nasdara'] bounds map for coordinate validation
 * @param {Set}      [opts.seen]   shared dedupe-key Set for cross-file dedupe;
 *                                 created when omitted
 * @returns {{ spawns: Array, rejected: number, duplicates: number, seen: Set }}
 *   spawns: [{ item, x, z, clock }]
 *   rejected:  out-of-range positions skipped
 *   duplicates: same (item, east, north, clock) lines skipped
 */
async function parseLootSpawns(lines, { mapName = 'nasdara', seen = null } = {}) {
  const seenKeys = seen instanceof Set ? seen : new Set();
  const spawns = [];
  let rejected = 0;
  let duplicates = 0;

  for await (const line of lines) {
    const parsed = parseLootAddingLine(line);
    if (!parsed) continue;
    const key = `${parsed.item}:${parsed.x}:${parsed.z}:${parsed.clock}`;
    if (seenKeys.has(key)) {
      duplicates += 1;
      continue;
    }
    if (!validateLootPosition({ x: parsed.x, z: parsed.z }, mapName)) {
      rejected += 1;
      continue;
    }
    seenKeys.add(key);
    spawns.push({ item: parsed.item, x: parsed.x, z: parsed.z, clock: parsed.clock });
  }
  return { spawns, rejected, duplicates, seen: seenKeys };
}

module.exports = {
  LOOT_ADDING_REGEX,
  parseLootAddingLine,
  validateLootPosition,
  parseLootSpawns,
};
