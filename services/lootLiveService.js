/*
 * DayZ Dashboard — Live Loot Service
 * Copyright (C) 2026
 *
 * Parses DayZ server RPT log files for Central Economy LootRespawner events.
 * Extracts RESPAWN CANDIDATE entries (economy health) and live item spawn
 * coordinates ("Adding X at [x,z]") for admin dashboard display.
 *
 * Log file location: bin/dayzxb/config/*.RPT
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getGuildDownloadPath } = require('./logSyncService');
const {
  listContainedDirectorySync,
  openContainedFileSync,
  resolveExistingContainedPath,
  statContainedFileSync,
} = require('../utils/safePath');
const { parseLootSpawns } = require('../utils/lootSpawns');
const { createRptChronology, parseRptClockTimestamp } = require('../utils/rptChronology');

// Regex patterns for RPT log parsing
const RE_RESPAWN_CANDIDATE = /\[CE\]\[LootRespawner\].*RESPAWN CANDIDATE\]\s+(\S+)\s+missing:(\d+)\s+\[cnt:(\d+),\s*nom:(\d+),\s*min:(\d+)\]/;
const RE_ADDING_ITEM       = /^\s+Adding\s+(\S+)\s+at\s+\[(\d+),(\d+)\]/;
const RE_MAP_STORAGE       = /mpmissions\\dayzOffline\.(\w+)\\/;
const RE_TIMESTAMP         = /^(\d+:\d+:\d+\.\d+)/;

// Simple in-memory cache per exact server/map context.
const liveCache = {};

function getLogDir(guildDiscordId, serverId) {
  const serverRoot = getGuildDownloadPath(guildDiscordId, serverId);
  try {
    return resolveExistingContainedPath(serverRoot, 'config');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// ─── RPT File Discovery ───────────────────────────────────────────────────────

/**
 * List all RPT files in the log directory, sorted newest first.
 */
function listRptFiles(logDir) {
  if (!logDir) return [];
  return listContainedDirectorySync(logDir)
    .filter(entry => entry.isFile() && entry.name.endsWith('.RPT'))
    .map(entry => ({ name: entry.name }))
    .sort((a, b) => {
      // Sort by filename (which contains timestamp) descending
      return b.name.localeCompare(a.name);
    });
}

/**
 * Detect which DayZ map a RPT file covers by scanning its header lines
 * for a storage path reference (e.g. "dayzOffline.chernarusplus").
 *
 * Returns the map name (e.g. "chernarusplus") or null if not found.
 */
function detectMapFromRpt(logDir, fileName) {
  let fd;
  try {
    // Read first 200 lines to find the storage path.
    ({ fd } = openContainedFileSync(logDir, fileName));
    const buffer = Buffer.alloc(16384); // 16KB should cover the header
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);

    const header = buffer.slice(0, bytesRead).toString('utf8');
    const match = RE_MAP_STORAGE.exec(header);
    return match ? match[1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Find the most recent RPT file for a given map name.
 * Checks files newest-first and returns the first one matching the map.
 */
function findLatestRptForMap(mapName, logDir) {
  const files = listRptFiles(logDir);
  for (const { name } of files) {
    const detectedMap = detectMapFromRpt(logDir, name);
    if (detectedMap === mapName) return name;
  }
  // Fallback: return the latest RPT file if map detection fails
  return files.length > 0 ? files[0].name : null;
}

// ─── RPT Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a full RPT file and extract:
 *   - candidates: items below their nominal count (RESPAWN CANDIDATE entries)
 *   - recentAdds: "Adding X at [x,z]" entries (up to maxAdds most recent)
 *   - summary: overall CE statistics from the initial respawner log line
 *
 * This reads the file in chunks to avoid loading 13MB+ files entirely into memory.
 */
function parseRptFile(logDir, fileName, maxAdds = 1000) {
  const candidates = {};
  const allAdds = [];
  let lastCandidate = null;
  let summary = null;

  // Buffer for incomplete lines across chunks
  let remainder = '';
  const CHUNK = 65536; // 64KB per read
  let offset = 0;
  let fd;

  try {
    ({ fd } = openContainedFileSync(logDir, fileName));
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    while (offset < fileSize) {
      const buf = Buffer.alloc(CHUNK);
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK, offset);
      offset += bytesRead;

      const chunk = remainder + buf.slice(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      remainder = lines.pop(); // Keep incomplete last line for next iteration

      for (const line of lines) {
        // Check for RESPAWN CANDIDATE
        const candidateMatch = RE_RESPAWN_CANDIDATE.exec(line);
        if (candidateMatch) {
          const [, item, missing, cnt, nom, min] = candidateMatch;
          lastCandidate = item;
          candidates[item] = {
            item,
            missing:  parseInt(missing, 10),
            current:  parseInt(cnt, 10),
            nominal:  parseInt(nom, 10),
            min:      parseInt(min, 10),
            healthPct: Math.round((parseInt(cnt, 10) / Math.max(parseInt(nom, 10), 1)) * 100),
          };
          continue;
        }

        // Check for "Adding X at [x,z]" — these follow a RESPAWN CANDIDATE
        const addMatch = RE_ADDING_ITEM.exec(line);
        if (addMatch) {
          const [, item, xStr, zStr] = addMatch;
          const tsMatch = RE_TIMESTAMP.exec(line);
          allAdds.push({
            item: lastCandidate || item,
            x: parseInt(xStr, 10),
            z: parseInt(zStr, 10),
            timestamp: tsMatch ? tsMatch[1] : null,
          });
          continue;
        }

        // Capture initial CE summary (spawned:X, Nominal:Y, Total:Z)
        if (!summary) {
          const sumMatch = /LootRespawner.*Initially.*Nominal:(\d+).*Total in Map:\s*(\d+)/.exec(line);
          if (sumMatch) {
            summary = {
              nominal: parseInt(sumMatch[1], 10),
              totalInMap: parseInt(sumMatch[2], 10),
            };
          }
        }
      }
    }

    // Process any remaining buffered content
    if (remainder.trim()) {
      const candidateMatch = RE_RESPAWN_CANDIDATE.exec(remainder);
      if (candidateMatch) {
        const [, item, missing, cnt, nom, min] = candidateMatch;
        candidates[item] = {
          item,
          missing:  parseInt(missing, 10),
          current:  parseInt(cnt, 10),
          nominal:  parseInt(nom, 10),
          min:      parseInt(min, 10),
          healthPct: Math.round((parseInt(cnt, 10) / Math.max(parseInt(nom, 10), 1)) * 100),
        };
      }
    }
  } catch (err) {
    // Return empty if file can't be read
    return { candidates: [], recentAdds: [], summary: null, error: err.message };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  // Return only the most recent spawn events (tail of allAdds)
  const recentAdds = allAdds.slice(-maxAdds);

  return {
    candidates: Object.values(candidates).sort((a, b) => b.missing - a.missing),
    recentAdds,
    summary,
  };
}

// ─── Economy Health ───────────────────────────────────────────────────────────

/**
 * Compute aggregate economy health from parsed RPT data.
 */
function computeEconomyHealth(parsedData) {
  const { summary, candidates } = parsedData;

  if (summary) {
    return {
      nominal:     summary.nominal,
      totalInMap:  summary.totalInMap,
      healthPct:   Math.round((summary.totalInMap / Math.max(summary.nominal, 1)) * 100),
      itemsBelowNominal: candidates.length,
    };
  }

  // Fallback: compute from candidates if no summary line found
  const totalNominal = candidates.reduce((s, c) => s + c.nominal, 0);
  const totalCurrent = candidates.reduce((s, c) => s + c.current, 0);
  return {
    nominal:     totalNominal,
    totalInMap:  totalCurrent,
    healthPct:   totalNominal > 0 ? Math.round((totalCurrent / totalNominal) * 100) : 100,
    itemsBelowNominal: candidates.length,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get live loot data for a specific map.
 * Reads and parses the latest RPT log that corresponds to that map.
 * Results are cached until the RPT file changes (mtime check).
 *
 * @param {string} mapName - e.g. "chernarusplus", "enoch", "sakhal"
 * @returns {{ candidates, recentAdds, economyHealth, lastUpdated, rptFile, error? }}
 */
async function getLiveSpawns(mapName, guildDiscordId, serverId) {
  const logDir = getLogDir(guildDiscordId, serverId);
  const rptFile = findLatestRptForMap(mapName, logDir);

  if (!rptFile) {
    return {
      candidates: [],
      recentAdds: [],
      economyHealth: null,
      lastUpdated: null,
      rptFile: null,
      error: 'No RPT log file found for this map.',
    };
  }

  // Cache invalidation by mtime
  let currentMtime = 0;
  try { currentMtime = statContainedFileSync(logDir, rptFile).mtimeMs; } catch { /* ignore */ }

  const cacheKey = `${guildDiscordId}:${serverId}:${mapName}`;
  const cached = liveCache[cacheKey];
  if (cached && cached.rptFile === rptFile && cached.mtime === currentMtime) {
    return cached.data;
  }

  // Parse the RPT file
  const parsed = parseRptFile(logDir, rptFile);
  const economyHealth = computeEconomyHealth(parsed);

  const result = {
    candidates:    parsed.candidates,
    recentAdds:    parsed.recentAdds,
    economyHealth,
    lastUpdated:   new Date().toISOString(),
    rptFile,
    error:         parsed.error || null,
  };

  liveCache[cacheKey] = { rptFile, mtime: currentMtime, data: result };
  return result;
}

/**
 * List all RPT files with their detected maps and timestamps.
 * Useful for the admin UI to know what data is available.
 */
function listAvailableLogs(guildDiscordId, serverId) {
  const logDir = getLogDir(guildDiscordId, serverId);
  return listRptFiles(logDir).slice(0, 20).map(({ name }) => ({
    file: name,
    map:  detectMapFromRpt(logDir, name),
    size: (() => { try { return statContainedFileSync(logDir, name).size; } catch { return 0; } })(),
    mtime: (() => { try { return statContainedFileSync(logDir, name).mtime; } catch { return null; } })(),
  }));
}

// ─── Live recent-spawn layer (server.log "Adding X at [x,z]") ─────────────────
//
// The map's live "recently spawned loot" layer sources its points from the
// coord-bearing `Adding <Item> at [east,north]` lines that the CE respawner
// writes to server.log. We read only the tail of the current server.log (the
// most recent lines are the recent spawns) so the parse stays bounded in
// memory, then reuse the Event Feed pipeline pieces: parseLootSpawns (regex
// parse + dedupe) and its getMapDefinition bounds check (rejects corrupt
// coords), plus the RPT clock→timestamp resolver with midnight-rollover
// chronology. Timestamps are anchored to the file's mtime date, exactly as
// routes/logParser.js anchors server.log for CE dynamic events.

// Tail read cap: recent spawns are at the end of the file; 16 MB comfortably
// covers the default window plus bursty spawner startup flushes.
const RECENT_SPAWN_TAIL_BYTES = 16 * 1024 * 1024;

/**
 * Stream the last `maxBytes` of a contained log file as complete lines.
 * For files within the cap the whole file is streamed; larger files stream
 * only the tail and drop the (possibly partial) first line.
 */
async function* streamLogTail(logDir, fileName, maxBytes) {
  const { fd, stat } = openContainedFileSync(logDir, fileName);
  const start = Math.max(0, stat.size - maxBytes);
  const fileStream = fs.createReadStream(path.join(logDir, fileName), {
    fd,
    start,
    end: stat.size - 1,
    encoding: 'utf8',
    autoClose: true,
  });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  let skipFirst = start > 0;
  try {
    for await (const line of rl) {
      if (skipFirst) { skipFirst = false; continue; }
      yield line;
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }
}

/**
 * The mtime date of a contained log file as YYYY-MM-DD (clock→timestamp
 * anchor), or null if the file can't be stat'd.
 */
function fileMtimeDate(logDir, fileName) {
  try {
    return new Date(statContainedFileSync(logDir, fileName).mtimeMs).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/**
 * Read + parse recent loot spawns from an explicit log directory.
 * The core of the live layer; kept dir-explicit so it is unit-testable
 * against a temp dir without the fixed downloads/ root.
 *
 * Sources: the current server.log AND the newest RPT — both carry the
 * coord-bearing `Adding <Item> at [east,north]` lines (verified against the
 * dayzxb log set; the RPT `[CE][LootRespawner]` bookkeeping lines carry
 * counts, NOT coords, so they are not a source). The same physical spawn is
 * logged to both files within the same wall-clock second, so the merged set
 * is deduped on a per-second bucket. Each file's clocks are anchored to that
 * file's own mtime date.
 *
 * @returns {{
 *   spawns: Array<{item, east, north, timestampMs, ageMs}>,
 *   newestMs: number|null, count: number, windowMinutes: number, limit: number,
 *   sourceFile: string|null, rejected: number, duplicates: number,
 *   error: string|null }}
 *   spawns are newest-first, within the recent window, capped at `limit`.
 *   `ageMs` is relative to the newest spawn in the batch (robust to any clock
 *   offset): newest = 0, older = larger.
 */
async function readRecentLootSpawnsFromDir(logDir, mapName, {
  windowMinutes = 60,
  limit = 500,
} = {}) {
  if (!logDir) {
    return { spawns: [], newestMs: null, count: 0, windowMinutes, limit, sourceFile: null, rejected: 0, duplicates: 0, error: 'No log directory found for this server.' };
  }

  // Candidate sources: server.log (always present when a server has run) plus
  // the newest RPT file (superset of the same Adding lines, with ms clocks).
  const sources = [];
  let serverLogSize = 0;
  try { serverLogSize = statContainedFileSync(logDir, 'server.log').size; } catch { /* no server.log */ }
  if (serverLogSize > 0) {
    sources.push({ file: 'server.log', date: fileMtimeDate(logDir, 'server.log') });
  }
  const newestRpt = listRptFiles(logDir)[0];
  if (newestRpt) {
    sources.push({ file: newestRpt.name, date: fileMtimeDate(logDir, newestRpt.name) });
  }
  if (sources.length === 0) {
    return { spawns: [], newestMs: null, count: 0, windowMinutes, limit, sourceFile: null, rejected: 0, duplicates: 0, error: 'No server.log or RPT found for this server.' };
  }

  const resolved = [];
  let rejected = 0;
  let duplicates = 0;
  for (const source of sources) {
    const chronology = createRptChronology();
    const parsed = await parseLootSpawns(
      streamLogTail(logDir, source.file, RECENT_SPAWN_TAIL_BYTES),
      { mapName }
    );
    rejected += parsed.rejected;
    duplicates += parsed.duplicates;
    for (const spawn of parsed.spawns) {
      const timestampMs = source.date
        ? parseRptClockTimestamp(spawn.clock, source.date, chronology)
        : null;
      if (timestampMs === null) { rejected += 1; continue; }
      resolved.push({ item: spawn.item, east: spawn.x, north: spawn.z, timestampMs });
    }
  }

  if (resolved.length === 0) {
    return { spawns: [], newestMs: null, count: 0, windowMinutes, limit, sourceFile: sources[0].file, rejected, duplicates, error: null };
  }

  // Cross-source dedupe: the same spawn lands in server.log (clock truncated
  // to seconds) and the RPT (clock keeps the ms fraction) within the same
  // wall-clock second. Bucket on the second so both copies collapse to one.
  const seen = new Set();
  const unique = [];
  for (const r of resolved) {
    const key = `${r.item}:${r.east}:${r.north}:${Math.floor(r.timestampMs / 1000)}`;
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    unique.push(r);
  }

  let newestMs = unique[0].timestampMs;
  for (const r of unique) if (r.timestampMs > newestMs) newestMs = r.timestampMs;

  const windowStart = newestMs - windowMinutes * 60000;
  const spawns = unique
    .filter(r => r.timestampMs >= windowStart)
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, limit)
    .map(r => ({
      item: r.item,
      east: r.east,
      north: r.north,
      timestampMs: r.timestampMs,
      ageMs: newestMs - r.timestampMs,
    }));

  return {
    spawns,
    newestMs,
    count: spawns.length,
    windowMinutes,
    limit,
    sourceFile: sources.map(s => s.file).join(', '),
    rejected,
    duplicates,
    error: null,
  };
}

/**
 * Get the most-recent loot spawns for a map from the current server.log,
 * resolving the server's log directory via the guild download path.
 */
async function getRecentLootSpawns(mapName, guildDiscordId, serverId, opts = {}) {
  return readRecentLootSpawnsFromDir(getLogDir(guildDiscordId, serverId), mapName, opts);
}

module.exports = {
  getLiveSpawns,
  listAvailableLogs,
  getRecentLootSpawns,
  readRecentLootSpawnsFromDir,
};
