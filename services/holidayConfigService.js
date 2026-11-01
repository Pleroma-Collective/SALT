'use strict';

/**
 * Holiday config service — per-server holiday event windows, admin-managed.
 *
 * Storage: holiday_server_configs (migration 111), one row per
 * (guild_id, platform_server_id). Servers without a row fall back to the
 * DEFAULT SET, which is the "standard BiSTudio schedule" shipped as
 * public/data/holiday-windows.json (single source — no duplicated data).
 *
 * db is injected (same house pattern as other services) so tests can use a
 * fake; queries use ? placeholders via the Postgres adapter.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SET_FILE = path.join(__dirname, '..', 'public', 'data', 'holiday-windows.json');

// Economy-delta pack markers (Kitty: cfgrandompresets.xml etc. also carry
// holiday content) — used to tell "no markers, delta only" apart from "pack
// not found".
const DELTA_FILES = ['cfgrandompresets.xml', 'cfgspawnabletypes.xml', 'cfgeffectarea.xml'];

const MAX_EVENTS = 20;
const MAX_WINDOWS_PER_EVENT = 12;
const MAX_MISSIONS_PER_EVENT = 8;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/;
const MISSION_RE = /^[A-Za-z0-9._-]{1,120}$/;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Default set = the 5 standard BiSTudio windows, read fresh from the JSON file. */
function loadDefaultSet() {
  const parsed = JSON.parse(fs.readFileSync(DEFAULT_SET_FILE, 'utf8'));
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  if (!events.length) throw new Error('holiday-windows.json must list events');
  return events;
}

function dayStartMs(yyyymmdd) {
  const p = String(yyyymmdd).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 0, 0, 0, 0).getTime();
}

function dayEndMs(yyyymmdd) {
  const p = String(yyyymmdd).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 23, 59, 59, 999).getTime();
}

function isValidCalendarDate(yyyymmdd) {
  if (!DATE_RE.test(String(yyyymmdd))) return false;
  const p = String(yyyymmdd).split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
}

/**
 * Validate a full holiday config ({ events: [...] }). Returns an error string
 * or null. Hard rules: non-empty events; unique sane ids; non-empty missions;
 * 1..N windows, each [start, end] a real calendar date with start <= end.
 */
function validateHolidayConfig(config) {
  if (!config || typeof config !== 'object' || !Array.isArray(config.events)) {
    return 'Config must be an object with an events array';
  }
  const events = config.events;
  if (!events.length) return 'At least one holiday event is required';
  if (events.length > MAX_EVENTS) return `Too many events (max ${MAX_EVENTS})`;
  const seenIds = new Set();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') return 'Each event must be an object';
    if (!ID_RE.test(String(ev.id || ''))) return `Event id "${ev.id}" is invalid (letters/digits/_/-, 1-50 chars)`;
    if (seenIds.has(String(ev.id).toLowerCase())) return `Duplicate event id "${ev.id}"`;
    seenIds.add(String(ev.id).toLowerCase());
    if (!ev.label || typeof ev.label !== 'string' || !ev.label.trim()) return `Event "${ev.id}" needs a label`;
    if (typeof ev.icon === 'string' && ev.icon.length > 16) return `Event "${ev.id}" icon too long`;
    if (!Array.isArray(ev.missions) || !ev.missions.length) return `Event "${ev.id}" needs at least one mission`;
    if (ev.missions.length > MAX_MISSIONS_PER_EVENT) return `Event "${ev.id}" lists too many missions`;
    for (const mission of ev.missions) {
      if (!MISSION_RE.test(String(mission || ''))) return `Event "${ev.id}": invalid mission name "${mission}"`;
    }
    if (!Array.isArray(ev.windows) || !ev.windows.length) return `Event "${ev.id}" needs at least one window`;
    if (ev.windows.length > MAX_WINDOWS_PER_EVENT) return `Event "${ev.id}" has too many windows`;
    for (const win of ev.windows) {
      if (!Array.isArray(win) || win.length !== 2) return `Event "${ev.id}": windows must be [start, end] pairs`;
      for (const day of win) {
        if (!isValidCalendarDate(day)) return `Event "${ev.id}": "${day}" is not a valid YYYY-MM-DD date`;
      }
      if (win[0] > win[1]) return `Event "${ev.id}": window start ${win[0]} is after end ${win[1]}`;
    }
  }
  return null;
}

/**
 * Pure: state of one event's windows at a point in time (inclusive calendar
 * days, server-local timezone — same semantics as public/js/holiday-windows.js).
 * Returns { state: 'live'|'upcoming'|'expired', activeWindow?, nextWindow? }.
 */
function eventWindowState(ev, nowMs = Date.now()) {
  for (const win of ev.windows || []) {
    if (Array.isArray(win) && win.length === 2 && dayStartMs(win[0]) <= nowMs && nowMs <= dayEndMs(win[1])) {
      return { state: 'live', activeWindow: win };
    }
  }
  const upcoming = (ev.windows || [])
    .filter(win => Array.isArray(win) && win.length === 2 && dayStartMs(win[0]) > nowMs)
    .sort((a, b) => dayStartMs(a[0]) - dayStartMs(b[0]))[0];
  if (upcoming) return { state: 'upcoming', nextWindow: upcoming };
  return { state: 'expired' };
}

function withStates(events, nowMs = Date.now()) {
  return events.map(ev => ({ ...ev, state: eventWindowState(ev, nowMs) }));
}

async function getConfigRow(db, guildId, platformServerId) {
  return db.get(
    'SELECT enabled, config FROM holiday_server_configs WHERE guild_id = ? AND platform_server_id = ?',
    [Number(guildId), String(platformServerId)]
  );
}

/** { enabled, source: 'server'|'default', events (with state) } for one server. */
async function serverHolidayConfig(db, guildId, platformServerId) {
  const row = await getConfigRow(db, guildId, platformServerId);
  const events = row ? row.config.events : loadDefaultSet();
  return {
    enabled: row ? Boolean(row.enabled) : true,
    source: row ? 'server' : 'default',
    events: withStates(events),
  };
}

async function listServerHolidayConfigs(db, nowMs = Date.now()) {
  const rows = await db.all(
    `SELECT s.id AS server_id, s.guild_id, s.platform, s.platform_server_id,
            s.name AS server_name, g.discord_guild_id, g.name AS guild_name,
            h.enabled AS enabled, h.config AS config
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     LEFT JOIN holiday_server_configs h
       ON h.guild_id = s.guild_id AND h.platform_server_id = s.platform_server_id
     WHERE s.status = 'active'
     ORDER BY g.name, s.name`
  );
  return rows.map(row => {
    const events = row.config ? row.config.events : loadDefaultSet();
    return {
      serverId: row.server_id,
      platformServerId: String(row.platform_server_id),
      guildId: row.guild_id,
      discordGuildId: row.discord_guild_id,
      guildName: row.guild_name,
      serverName: row.server_name,
      platform: row.platform,
      enabled: row.config ? Boolean(row.enabled) : true,
      source: row.config ? 'server' : 'default',
      events: withStates(events, nowMs),
    };
  });
}

async function upsertConfig(db, guildId, platformServerId, platform, events, enabled) {
  await db.run(
    `INSERT INTO holiday_server_configs (guild_id, platform_server_id, platform, enabled, config)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, platform_server_id)
     DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP`,
    [Number(guildId), String(platformServerId), platform, Boolean(enabled), JSON.stringify({ events })]
  );
}

/** Save a validated custom config for a server (throws ValidationError on bad input). */
async function saveServerConfig(db, key, config, enabled) {
  const error = validateHolidayConfig(config);
  if (error) throw new ValidationError(error);
  await upsertConfig(db, key.guildId, key.platformServerId, key.platform || 'nitrado',
    config.events, enabled === undefined ? true : Boolean(enabled));
  return withStates(config.events);
}

/** Apply the general/default set (standard BiSTudio schedule) to a server. */
async function applyDefaultSet(db, key) {
  const events = loadDefaultSet();
  await upsertConfig(db, key.guildId, key.platformServerId, key.platform || 'nitrado', events, true);
  return withStates(events);
}

/** Master enable/disable toggle. Creates the row from the default set when absent. */
async function setEnabled(db, key, enabled) {
  const row = await getConfigRow(db, key.guildId, key.platformServerId);
  const events = row ? row.config.events : loadDefaultSet();
  await upsertConfig(db, key.guildId, key.platformServerId, key.platform || 'nitrado', events, Boolean(enabled));
  return Boolean(enabled);
}

/**
 * Mission folders present on disk for a server (root + mission subdirs), used
 * to check "pack exists for that map" on edit. Returns [] when the server has
 * no download directory yet (unknown — callers must not reject on unknown).
 */
function listMissionFolders(serverDir, missionSubdirs = []) {
  if (!serverDir || !fs.existsSync(serverDir)) return [];
  const folders = new Set();
  for (const root of [serverDir, ...missionSubdirs.map(dir => path.join(serverDir, dir))]) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.includes('.')) folders.add(entry.name);
    }
  }
  return [...folders].sort();
}

/**
 * Which missions in a config have no matching mission folder on disk.
 * Returns { known, missing } — known=false means the server dir is absent, so
 * `missing` must not be treated as a hard error.
 */
function missingPacks(serverDir, missionFolders, events) {
  if (!missionFolders.length) return { known: false, missing: [] };
  const missing = [];
  for (const ev of events) {
    for (const mission of ev.missions || []) {
      const hit = missionFolders.some(f => f.toLowerCase().startsWith(String(mission).toLowerCase()));
      if (!hit) missing.push({ id: ev.id, mission });
    }
  }
  return { known: true, missing };
}

/** Delta files present in a mission folder (economy-pack detection). */
function listDeltaFiles(missionDir) {
  if (!missionDir || !fs.existsSync(missionDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(missionDir);
  } catch {
    return [];
  }
  const lower = new Set(entries.map(e => e.toLowerCase()));
  return DELTA_FILES.filter(f => lower.has(f));
}

module.exports = {
  ValidationError,
  loadDefaultSet,
  validateHolidayConfig,
  eventWindowState,
  withStates,
  serverHolidayConfig,
  listServerHolidayConfigs,
  saveServerConfig,
  applyDefaultSet,
  setEnabled,
  listMissionFolders,
  missingPacks,
  listDeltaFiles,
  DELTA_FILES,
};
