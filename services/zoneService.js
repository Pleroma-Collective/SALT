/**
 * Activity Zones
 *
 * Admin-defined circular areas whose ingested combat activity is reported to a
 * Discord channel.
 *
 * Two responsibilities, one module:
 *   - CRUD (list/create/update/delete) for the admin UI.
 *   - Activity matching: on the feed-processor tick, read position-bearing
 *     kill_events for a server, match each event against the server's active
 *     zones, and post a per-zone aggregate to its channel at a bounded cadence.
 *
 * Grounding / reuse (no new log-parsing pipeline):
 *   - Positions come from kill_events.victim_position / killer_position
 *     ("east,north,elevation"), written by the existing ADM ingestion
 *     (routes/logParser.js). The zone reader is a plain SELECT over that table.
 *   - Output reuses utils/discordPoster (postToDiscord +
 *     validateDiscordDestination), the same path the kill feed uses.
 *   - Trigger: called from workers/feedProcessor.processServerFeedEvents, which
 *     already runs on the 30s feed tick and right after the low-latency ADM
 *     hook observes new kills. Servers only produce kill_events when ADM
 *     ingestion is active for them, so the trigger covers every server that can
 *     have zone activity.
 *
 * Cadence choice (documented per task): a zone posts at most once per
 * min_interval_seconds (default 120s) per tick; within a tick all matching
 * events since the last report are batched into a single summary message.
 */

'use strict';

const { postToDiscord, validateDiscordDestination, fetchGuildChannels } = require('../utils/discordPoster');

const DEFAULT_MIN_INTERVAL_SECONDS = 120;
const DEFAULT_ACTIVITY_FILTERS = ['kill'];
// A kill_events row is one combat event: it is simultaneously a kill (for the
// killer) and a death (for the victim). Both labels map to the same source
// rows; loot/build have no position-bearing low-latency stream yet, so they are
// not wired (shortcut — add the event type when such a stream exists).
const KNOWN_EVENT_TYPES = new Set(['kill', 'death']);
// Scan cap: bounds the worst-case batch (a zone whose channel is unreachable
// keeps re-scanning this window until it can post). 500 combat events is far
// beyond any sane per-interval aggregate.
const MAX_SCAN_ROWS = 500;
// Fresh-zone backfill window: a zone with no last_checked_at scans the last
// hour rather than the whole table.
const DEFAULT_LOOKBACK_MS = 60 * 60 * 1000;

const SUPPORTED_MAPS = new Set([
  'chernarusplus', 'enoch', 'sakhal', 'nasdara', 'namalsk', 'takistanplus',
]);

// In-process guard: the 30s feed tick and the low-latency kill hook can reach the
// same server concurrently; skip a second in-flight run for a server (both run in
// the backend process).
const zoneBusy = new Set();

/* ─── Pure geometry + parsing (unit-tested, no I/O) ───────────────────────── */

/** Parse "east,north[,elevation]" -> {east, north} | null. */
function parsePosition(positionText) {
  if (typeof positionText !== 'string') return null;
  const parts = positionText.split(',');
  if (parts.length < 2) return null;
  const east = Number(parts[0]);
  const north = Number(parts[1]);
  if (!Number.isFinite(east) || !Number.isFinite(north)) return null;
  return { east, north };
}

/** True if the world point (east,north) is within the zone circle. */
function zoneContains(zone, east, north) {
  const dx = east - Number(zone.center_x);
  const dz = north - Number(zone.center_z);
  const radius = Number(zone.radius_m);
  return dx * dx + dz * dz <= radius * radius;
}

/** Normalize a stored activity_filters value (JSON string or array) to a Set. */
function parseFilters(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return new Set();
  const set = new Set();
  for (const entry of arr) {
    const type = String(entry).toLowerCase();
    if (KNOWN_EVENT_TYPES.has(type)) set.add(type);
  }
  return set;
}

// A kill_events row is combat. It counts for a zone iff the zone tracks combat
// (any known filter is present).
function eventMatchesZone(zone, filtersSet) {
  return filtersSet.size > 0;
}

/* ─── CRUD ────────────────────────────────────────────────────────────────── */

function normalizeZone(row) {
  return {
    id: Number(row.id),
    server_id: Number(row.server_id),
    name: row.name,
    map_name: row.map_name,
    center_x: Number(row.center_x || 0),
    center_z: Number(row.center_z || 0),
    radius_m: Number(row.radius_m || 0),
    // Array (not Set) so API responses JSON-serialize correctly; the matcher
    // builds its own Set internally.
    activity_filters: Array.from(parseFilters(row.activity_filters)),
    channel_id: row.channel_id,
    min_interval_seconds: Number(row.min_interval_seconds),
    enabled: Number(row.enabled) === 1,
    last_checked_at: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    last_posted_at: row.last_posted_at ? new Date(row.last_posted_at).toISOString() : null,
    last_post_count: Number(row.last_post_count || 0),
  };
}

async function listZones(db, serverId) {
  const rows = await db.query(
    `SELECT id, server_id, name, map_name, center_x, center_z, radius_m,
            activity_filters, channel_id, min_interval_seconds, enabled,
            last_checked_at, last_posted_at, last_post_count
     FROM activity_zones WHERE server_id = ? ORDER BY name ASC`,
    [Number(serverId)]
  );
  return rows.map(normalizeZone);
}

async function getZone(db, serverId, zoneId) {
  const row = await db.get(
    `SELECT id, server_id, name, map_name, center_x, center_z, radius_m,
            activity_filters, channel_id, min_interval_seconds, enabled,
            last_checked_at, last_posted_at, last_post_count
     FROM activity_zones WHERE id = ? AND server_id = ?`,
    [Number(zoneId), Number(serverId)]
  );
  return row ? normalizeZone(row) : null;
}

const CHANNEL_ID_RE = /^[0-9]{1,20}$/;

function finiteIn(value, min, max, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}`);
  }
  return n;
}

function validateName(input, { partial }) {
  if (partial && !('name' in input)) return undefined;
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 120) throw new Error('name must be 1-120 characters');
  return name;
}

function validateGeometry(input, { partial }) {
  if (partial && !('center_x' in input) && !('center_z' in input) && !('radius_m' in input)) {
    return {};
  }
  const out = {};
  if (!partial || 'center_x' in input) out.center_x = finiteIn(input.center_x, -50000, 50000, 'center_x');
  if (!partial || 'center_z' in input) out.center_z = finiteIn(input.center_z, -50000, 50000, 'center_z');
  if (!partial || 'radius_m' in input) out.radius_m = finiteIn(input.radius_m, 25, 5000, 'radius_m');
  return out;
}

function validateFilters(input, { partial }) {
  if (partial && !('activity_filters' in input)) return undefined;
  let arr = input.activity_filters;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { arr = []; }
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('activity_filters must be a non-empty array of event types');
  }
  const normalized = arr.map(type => String(type).toLowerCase());
  for (const type of normalized) {
    if (!KNOWN_EVENT_TYPES.has(type)) throw new Error(`unknown activity type: ${type}`);
  }
  return normalized;
}

function validateChannel(input, { partial }) {
  if (partial && !('channel_id' in input)) return undefined;
  const channelId = String(input.channel_id ?? '').trim();
  if (!CHANNEL_ID_RE.test(channelId)) throw new Error('channel_id must be a Discord channel ID');
  return channelId;
}

function validateMinInterval(input, { partial }) {
  if (partial && !('min_interval_seconds' in input)) return undefined;
  const value = Number(input.min_interval_seconds);
  if (!Number.isFinite(value)) throw new Error('min_interval_seconds must be a number');
  const clamped = Math.round(value);
  if (clamped < 30 || clamped > 3600) throw new Error('min_interval_seconds must be between 30 and 3600');
  return clamped;
}

function validateMapName(input, { partial }) {
  if (partial && !('map_name' in input)) return undefined;
  const mapName = String(input.map_name ?? 'nasdara').toLowerCase().trim();
  if (!SUPPORTED_MAPS.has(mapName)) throw new Error(`unsupported map: ${mapName}`);
  return mapName;
}

async function createZone(db, serverId, input = {}) {
  const name = validateName(input, { partial: false });
  const { center_x, center_z, radius_m } = validateGeometry(input, { partial: false });
  const activityFilters = validateFilters(input, { partial: false }) || DEFAULT_ACTIVITY_FILTERS;
  const channelId = validateChannel(input, { partial: false });
  const minInterval = validateMinInterval(input, { partial: false }) || DEFAULT_MIN_INTERVAL_SECONDS;
  const mapName = validateMapName(input, { partial: false });
  const enabled = input.enabled === false ? 0 : 1;

  const row = await db.get(
    `INSERT INTO activity_zones
       (server_id, name, map_name, center_x, center_z, radius_m,
        activity_filters, channel_id, min_interval_seconds, enabled, last_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     RETURNING id, server_id, name, map_name, center_x, center_z, radius_m,
               activity_filters, channel_id, min_interval_seconds, enabled,
               last_checked_at, last_posted_at, last_post_count`,
    [
      Number(serverId), name, mapName, center_x, center_z, radius_m,
      JSON.stringify(activityFilters), channelId, minInterval, enabled,
    ]
  );
  return normalizeZone(row);
}

async function updateZone(db, serverId, zoneId, patch = {}) {
  const existing = await getZone(db, serverId, zoneId);
  if (!existing) return null;

  const name = validateName(patch, { partial: true });
  const geometry = validateGeometry(patch, { partial: true });
  const activityFilters = validateFilters(patch, { partial: true });
  const channelId = validateChannel(patch, { partial: true });
  const minInterval = validateMinInterval(patch, { partial: true });
  const mapName = validateMapName(patch, { partial: true });

  const sets = [];
  const params = [];
  const push = (column, value) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (name !== undefined) push('name', name);
  if (geometry.center_x !== undefined) push('center_x', geometry.center_x);
  if (geometry.center_z !== undefined) push('center_z', geometry.center_z);
  if (geometry.radius_m !== undefined) push('radius_m', geometry.radius_m);
  if (activityFilters !== undefined) push('activity_filters', JSON.stringify(activityFilters));
  if (channelId !== undefined) push('channel_id', channelId);
  if (minInterval !== undefined) push('min_interval_seconds', minInterval);
  if (mapName !== undefined) push('map_name', mapName);
  if ('enabled' in patch) push('enabled', patch.enabled ? 1 : 0);

  if (sets.length === 0) return existing; // nothing to change

  sets.push('updated_at = NOW()');
  params.push(Number(zoneId), Number(serverId));
  await db.run(
    `UPDATE activity_zones SET ${sets.join(', ')} WHERE id = ? AND server_id = ?`,
    params
  );
  return getZone(db, serverId, zoneId);
}

async function deleteZone(db, serverId, zoneId) {
  const result = await db.run(
    'DELETE FROM activity_zones WHERE id = ? AND server_id = ?',
    [Number(zoneId), Number(serverId)]
  );
  return (result && Number(result.changes)) > 0;
}

/** Text channels for the zone output-channel dropdown (reuses discordPoster). */
async function listGuildChannels(discordGuildId) {
  const channels = await fetchGuildChannels(discordGuildId);
  return channels.filter(channel => channel.type === 0).map(channel => ({
    id: channel.id,
    name: channel.name,
  }));
}

/* ─── Activity matching + aggregation + posting ───────────────────────────── */

async function loadActiveZonesForServer(db, serverId) {
  const rows = await db.query(
    `SELECT id, server_id, name, map_name, center_x, center_z, radius_m,
            activity_filters, channel_id, min_interval_seconds
     FROM activity_zones WHERE server_id = ? AND enabled = 1`,
    [Number(serverId)]
  );
  return rows.map(row => normalizeZone(row));
}

function formatWindowLabel(firstAt, lastAt) {
  if (!firstAt) return '';
  const fmt = d => new Date(d).toISOString().slice(11, 16); // HH:MM UTC
  if (!lastAt || lastAt <= firstAt) return fmt(firstAt) + ' UTC';
  return `${fmt(firstAt)}–${fmt(lastAt)} UTC`;
}

function topEntries(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function buildZoneMessage(zone, agg) {
  const lines = [];
  lines.push(`${agg.count} combat event${agg.count === 1 ? '' : 's'} · ${formatWindowLabel(agg.firstAt, agg.lastAt)}`);
  const players = [...agg.players].slice(0, 12).join(', ');
  if (players) {
    const more = agg.players.size > 12 ? ` (+${agg.players.size - 12})` : '';
    lines.push(`Players: ${players}${more}`);
  }
  const weapons = topEntries(agg.weapons, 3);
  if (weapons.length) lines.push(`Top weapons: ${weapons.map(([w, n]) => `${w} (${n})`).join(', ')}`);

  const description = lines.join('\n');
  const body = zone.last_event
    ? `\nLatest: ${zone.last_event.killer} → ${zone.last_event.victim}${zone.last_event.weapon ? ` (${zone.last_event.weapon})` : ''}`
    : '';

  return {
    embeds: [{
      title: `📍 ${zone.name} — activity`,
      description: description + body,
      color: 0xE53935,
      footer: {
        text: `Zone monitor · ${zone.map_name} · up to ${zone.min_interval_seconds}s cadence`,
      },
    }],
  };
}

/**
 * Match ingested kill_events for a server against its active zones and post any
 * due aggregates.
 *
 * @returns {Promise<{zones:number, scanned:number, posted:number}>}
 */
async function processZonesForServer(db, discordGuildId, serverId, options = {}) {
  const logger = options.logger || console;
  const post = options.post || postToDiscord;
  const validate = options.validate || validateDiscordDestination;
  const nowMs = options.now ? options.now() : Date.now();

  const serverKey = Number(serverId);
  // Atomic guard (check+add with no await between): the 30s feed tick and the
  // low-latency kill hook can reach the same server concurrently. A second
  // in-flight run skips; the next tick/hook picks up whatever this one left.
  if (zoneBusy.has(serverKey)) {
    return { zones: 0, scanned: 0, posted: 0, skipped: 'busy' };
  }
  zoneBusy.add(serverKey);
  try {
    const zones = await loadActiveZonesForServer(db, serverId);
    if (zones.length === 0) return { zones: 0, scanned: 0, posted: 0 };

    const since = earliestCheckedAt(zones, nowMs);
    const rows = await db.query(
      `SELECT id, killer_gamertag, victim_gamertag, weapon, victim_position,
              killer_position, timestamp
       FROM kill_events
       WHERE server_id = ? AND timestamp > ?
       ORDER BY timestamp ASC
       LIMIT ?`,
      [Number(serverId), since, MAX_SCAN_ROWS]
    );

    const aggregates = new Map(zones.map(zone => [zone.id, {
      zone,
      count: 0,
      players: new Set(),
      weapons: new Map(),
      firstAt: null,
      lastAt: null,
    }]));

    for (const row of rows) {
      const position = parsePosition(row.victim_position) || parsePosition(row.killer_position);
      if (!position) continue;
      const ts = row.timestamp ? new Date(row.timestamp).getTime() : nowMs;
      for (const agg of aggregates.values()) {
        if (!eventMatchesZone(agg.zone, parseFilters(agg.zone.activity_filters))) continue;
        if (!zoneContains(agg.zone, position.east, position.north)) continue;
        agg.count += 1;
        if (row.killer_gamertag) agg.players.add(row.killer_gamertag);
        if (row.victim_gamertag) agg.players.add(row.victim_gamertag);
        if (row.weapon) agg.weapons.set(row.weapon, (agg.weapons.get(row.weapon) || 0) + 1);
        agg.firstAt = agg.firstAt === null ? ts : Math.min(agg.firstAt, ts);
        agg.lastAt = agg.lastAt === null ? ts : Math.max(agg.lastAt, ts);
        agg.zone.last_event = {
          killer: row.killer_gamertag || '?',
          victim: row.victim_gamertag || '?',
          weapon: row.weapon || null,
        };
      }
    }

    const batchMaxTs = rows.length ? Math.max(...rows.map(row => row.timestamp ? new Date(row.timestamp).getTime() : 0)) : null;
    const isoFromMs = ms => (ms === null ? null : new Date(ms).toISOString());
    let posted = 0;

    for (const agg of aggregates.values()) {
      const zone = agg.zone;
      if (agg.count === 0) {
        // Nothing to report: advance the cursor so we don't re-scan this window.
        if (batchMaxTs !== null) await advanceCursor(db, zone.id, isoFromMs(batchMaxTs));
        continue;
      }

      const due = zone.last_posted_at === null
        || nowMs >= new Date(zone.last_posted_at).getTime() + zone.min_interval_seconds * 1000;
      if (!due) continue; // keep accumulating; post on a later tick once the interval elapses

      const content = buildZoneMessage(zone, agg);
      const okDest = await validate(String(discordGuildId), zone.channel_id, null);
      if (!okDest) {
        // Config problem (bad channel / wrong guild / no bot token): drop the
        // window and warn once rather than retry forever.
        logger.warn?.(`⚠️ [zone] "${zone.name}" channel ${zone.channel_id} not valid; dropped ${agg.count} event(s)`);
        await advanceCursor(db, zone.id, isoFromMs(batchMaxTs));
        continue;
      }
      const success = await post(zone.channel_id, null, content, true);
      if (success) {
        posted += 1;
        await recordPost(db, zone.id, isoFromMs(nowMs), agg.count, isoFromMs(batchMaxTs));
        logger.log?.(`📍 [zone] posted ${agg.count} event(s) for "${zone.name}" (server ${serverId})`);
      } else {
        // Delivery failed: keep the cursor so the next tick retries (bounded by MAX_SCAN_ROWS).
        logger.error?.(`❌ [zone] failed to post for "${zone.name}" (server ${serverId}); will retry`);
      }
    }

    return { zones: zones.length, scanned: rows.length, posted };
  } finally {
    zoneBusy.delete(Number(serverId));
  }
}

function earliestCheckedAt(zones, nowMs) {
  // Established zones scan from their own cursor so we never re-report events.
  // Only a zone with no cursor yet (created before it was first checked) falls
  // back to a bounded lookback — that keeps a fresh zone from scanning the
  // whole table while still catching recent activity.
  const fallback = nowMs - DEFAULT_LOOKBACK_MS;
  let earliest = nowMs;
  for (const zone of zones) {
    const raw = zone.last_checked_at ? new Date(zone.last_checked_at).getTime() : null;
    earliest = Math.min(earliest, raw === null || !Number.isFinite(raw) ? fallback : raw);
  }
  return new Date(earliest).toISOString();
}

async function advanceCursor(db, zoneId, iso) {
  await db.run(
    `UPDATE activity_zones
     SET last_checked_at = GREATEST(COALESCE(last_checked_at, ?), ?)
     WHERE id = ?`,
    [iso, iso, Number(zoneId)]
  );
}

async function recordPost(db, zoneId, postedIso, count, cursorIso) {
  await db.run(
    `UPDATE activity_zones
     SET last_posted_at = ?, last_post_count = ?,
         last_checked_at = GREATEST(COALESCE(last_checked_at, ?), ?)
     WHERE id = ?`,
    [postedIso, count, cursorIso, cursorIso, Number(zoneId)]
  );
}

module.exports = {
  // pure helpers (unit tests)
  parsePosition,
  zoneContains,
  parseFilters,
  eventMatchesZone,
  buildZoneMessage,
  // CRUD
  listZones,
  getZone,
  createZone,
  updateZone,
  deleteZone,
  listGuildChannels,
  // activity
  loadActiveZonesForServer,
  processZonesForServer,
  _internal: { zoneBusy, DEFAULT_MIN_INTERVAL_SECONDS, DEFAULT_ACTIVITY_FILTERS, KNOWN_EVENT_TYPES, MAX_SCAN_ROWS },
};
