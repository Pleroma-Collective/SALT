/*
 * DayZ Dashboard - Shop Restart Service
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Detects server restart events from downloaded server.log files and manages
 * event rental lifecycle (decrementing restart counts, expiring rentals).
 *
 * Restart types:
 *   scheduled      — preceded by [Shutdown] countdown in server.log; counts against rentals
 *   owner_triggered — recorded explicitly by owner via the dashboard; excluded from counts
 *   crash          — no countdown detected before BIOS re-registration; excluded from counts
 */

const shopFileService = require('./shopFileService');

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

/**
 * Parse a server.log text blob and extract restart events.
 *
 * A restart is identified by a new "Connected to BIOS" line, which signals the
 * server has come back online after a termination.  The shutdown type is inferred
 * from whether a [Shutdown] countdown appeared before the termination.
 *
 * @param {string} logContent - Full text of server.log
 * @returns {Array<{biosSessionId: string, detectedAt: string|null, isScheduled: boolean}>}
 */
function parseServerLog(logContent) {
  if (!logContent) return [];

  const lines = logContent.split('\n');
  const events = [];

  // Regex patterns
  const biosRegex = /Connected to BIOS \(server registration\) with id ([0-9a-f-]{36})/i;
  const shutdownRegex = /\[Shutdown\]\s+Shutting down in \d+/i;
  // Timestamp at start of line: "HH:MM:SS " or "YYYY-MM-DD HH:MM:SS "
  const timestampRegex = /^(\d{1,2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/;

  let seenShutdownCountdown = false;

  for (const line of lines) {
    if (shutdownRegex.test(line)) {
      seenShutdownCountdown = true;
    }

    const biosMatch = biosRegex.exec(line);
    if (biosMatch) {
      const biosSessionId = biosMatch[1];
      // Extract timestamp from the line if present
      const tsMatch = timestampRegex.exec(line.trim());
      const detectedAt = tsMatch ? tsMatch[1] : null;

      events.push({
        biosSessionId,
        detectedAt,
        isScheduled: seenShutdownCountdown,
      });

      // Reset countdown flag for the next cycle
      seenShutdownCountdown = false;
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Previous-session scheduled-shutdown evidence (rolling server.log)
// ---------------------------------------------------------------------------

// DayZ 1.30 moved the `[Shutdown]` console lines OUT of the per-run RPT: the
// countdown + "Saving players, locking server and kicking all players." lines
// now appear ONLY in the rolling console server.log. The previous session's
// save line is therefore the authoritative "this restart was scheduled"
// evidence for 1.30+, while the identical RPT line remains the fallback for
// pre-1.30 history files.

const BIOS_SESSION_REGEX = /Connected to BIOS \(server registration\) with id [0-9a-f-]{36}/i;
const SAVING_PLAYERS_REGEX = /\[Shutdown\]\s+Saving players, locking server and kicking all players\./i;
const SHUTDOWN_COUNTDOWN_REGEX = /\[Shutdown\]\s+Shutting down in \d+/i;
const SERVER_LOG_LINE_TIMESTAMP = /^(\d{1,2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/;
const SCHEDULED_SHUTDOWN_CORRELATION_MS = 30 * 60 * 1000;

/**
 * Correlate a time-only ("H:MM:SS" / "HH:MM:SS") server.log timestamp with a
 * provider start time. Console server.log lines carry no date, so the
 * timestamp is a wall-clock time on the node's local day: compare
 * time-of-day against the start's UTC time-of-day with a per-timezone
 * tolerance (node local vs provider UTC, 0-14h apart, mirroring
 * rptFilenameMatchesProviderStart) and normalize across midnight.
 *
 * @param {string} value "H:MM:SS" or "HH:MM:SS"
 * @param {number} startedAtMs provider start epoch ms
 * @returns {boolean}
 */
function timeOnlyTimestampMatchesProviderStart(value, startedAtMs) {
  if (typeof value !== 'string' || !/^\d{1,2}:\d{2}:\d{2}$/.test(value)) return false;
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return false;
  const [, hh, mm, ss] = value.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  const hour = Number(hh);
  const localClockMs = (hour * 3600 + Number(mm) * 60 + Number(ss)) * 1000;
  if (hour > 23) return false;
  const dayMs = 86400000;
  let difference = (startedAtMs % dayMs) - localClockMs;
  // Normalize across midnight: 23:55 local vs a 00:02 UTC start is +7 minutes,
  // not -23h53m.
  if (difference > dayMs / 2) difference -= dayMs;
  if (difference < -dayMs / 2) difference += dayMs;
  const hourMs = 60 * 60 * 1000;
  const timezoneHours = Math.round(difference / hourMs);
  return Math.abs(timezoneHours) <= 14
    && Math.abs(difference - timezoneHours * hourMs) <= SCHEDULED_SHUTDOWN_CORRELATION_MS;
}

function datedTimestampMatchesProviderStart(value, startedAtMs) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(value)) return false;
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return false;
  const localClockMs = Date.parse(`${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(localClockMs)) return false;
  const hourMs = 60 * 60 * 1000;
  const difference = startedAtMs - localClockMs;
  const timezoneHours = Math.round(difference / hourMs);
  return Math.abs(timezoneHours) <= 14
    && Math.abs(difference - timezoneHours * hourMs) <= SCHEDULED_SHUTDOWN_CORRELATION_MS;
}

function biosLineIsCurrentSession(line, startedAtMs) {
  const tsMatch = String(line).trim().match(SERVER_LOG_LINE_TIMESTAMP);
  if (!tsMatch) return null;
  const timestamp = tsMatch[1];
  return timestamp.includes('-')
    ? datedTimestampMatchesProviderStart(timestamp, startedAtMs)
    : timeOnlyTimestampMatchesProviderStart(timestamp, startedAtMs);
}

/**
 * Determine whether the most recent completed session in a rolling
 * server.log ended with a scheduled shutdown.
 *
 * The file is rolling (single file, 100k-line cap) so "the previous run's
 * server.log" is this same file: its tail holds the previous session's
 * shutdown region unless the current session already registered.
 *
 * Evidence levels, per candidate region (checked most-recent first):
 *  - a "Saving players, locking server and kicking all players." line
 *    (present in every era's console stream) → definitive scheduled
 *  - only a "[Shutdown] Shutting down in N" countdown (pre-1.30 tails —
 *    and only pre-1.30 tails — carry the countdown without the save line,
 *    which also landed in the per-run RPT) → null, defer to the caller's
 *    RPT fallback
 *  - no shutdown lines → definitive not-scheduled (crash)
 *
 * Freshness gate: the file's LAST timestamped line must correlate with the
 * provider start time (mod timezone). A stale file that does not straddle
 * the restart boundary yields null so the caller falls back to the RPT.
 *
 * @param {string|null} logContent full text of the rolling server.log
 * @param {number|null} startedAtMs provider start epoch ms for the CURRENT
 *        session (the restart under investigation).
 * @returns {boolean|null} true/false, or null when the file carries no
 *        usable shutdown evidence (caller falls back to the RPT).
 */
function previousSessionScheduledShutdown(logContent, startedAtMs) {
  if (typeof logContent !== 'string' || logContent.length === 0) return null;
  const lines = logContent.split('\n');

  // Freshness: the file must straddle the restart boundary. The last
  // timestamped line is either the tail of the previous session (file synced
  // before the new session registered) or an early current-session line —
  // both correlate with the provider start time. Checked BEFORE the shutdown
  // search so a stale file with old shutdown lines yields null (RPT fallback)
  // instead of a false "not scheduled".
  let lastTimestamped = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const tsMatch = lines[i].trim().match(SERVER_LOG_LINE_TIMESTAMP);
    if (tsMatch) { lastTimestamped = tsMatch[1]; break; }
  }
  if (!lastTimestamped) return null;
  if (!datedTimestampMatchesProviderStart(lastTimestamped, startedAtMs)
      && !timeOnlyTimestampMatchesProviderStart(lastTimestamped, startedAtMs)) {
    return null; // stale: does not cover the restart under investigation
  }

  // Verdict for one region [start, end): save line wins; a bare countdown
  // defers to the RPT; no shutdown lines means the session crashed.
  const verdict = (start, end) => {
    for (let i = start; i < end; i += 1) {
      if (SAVING_PLAYERS_REGEX.test(lines[i])) return true;
    }
    for (let i = start; i < end; i += 1) {
      if (SHUTDOWN_COUNTDOWN_REGEX.test(lines[i])) return null;
    }
    return false;
  };

  const biosIndices = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (BIOS_SESSION_REGEX.test(lines[i])) biosIndices.push(i);
  }

  if (biosIndices.length >= 2) {
    const lastIdx = biosIndices[biosIndices.length - 1];
    const prevIdx = biosIndices[biosIndices.length - 2];
    const lastIsCurrent = biosLineIsCurrentSession(lines[lastIdx], startedAtMs);
    if (lastIsCurrent === true) {
      // The last BIOS line opened the current session: the previous session
      // is the region between the two BIOS lines.
      return verdict(prevIdx, lastIdx);
    }
    if (lastIsCurrent === false) {
      // The last BIOS line opened the previous session: its shutdown is the
      // tail of the file.
      return verdict(lastIdx, lines.length);
    }
    // Undecidable (no timestamp on the last BIOS line): check the most recent
    // region first, then the one before it.
    const tail = verdict(lastIdx, lines.length);
    if (tail !== false) return tail;
    return verdict(prevIdx, lastIdx);
  }

  if (biosIndices.length === 1) {
    const idx = biosIndices[0];
    const lastIsCurrent = biosLineIsCurrentSession(lines[idx], startedAtMs);
    if (lastIsCurrent === true) {
      // The BIOS line opened the current session; the previous session is
      // everything before it (any older shutdowns were rotated out with
      // their BIOS lines).
      return verdict(0, idx);
    }
    if (lastIsCurrent === false) {
      // The BIOS line opened the previous session; its shutdown is the tail.
      return verdict(idx, lines.length);
    }
    const tail = verdict(idx, lines.length);
    if (tail !== false) return tail;
    return verdict(0, idx);
  }

  // No BIOS lines: the file is the tail of a single session; its shutdown
  // region is the whole file.
  return verdict(0, lines.length);
}

// ---------------------------------------------------------------------------
// Owner restart recording
// ---------------------------------------------------------------------------

/**
 * Record that an owner manually triggered a restart from the dashboard.
 * The next detected restart within 10 minutes will be treated as owner_triggered
 * and will NOT decrement rental counts.
 *
 * @param {object} db - DB abstraction
 * @param {number} serverId - Internal servers.id
 */
async function recordOwnerRestart(db, serverId) {
  await shopFileService.acquireShopServerLock(db, serverId);
  await db.run(
    `INSERT INTO server_restart_log (server_id, restart_type, bios_session_id)
     SELECT ?, 'owner_triggered', NULL
     WHERE NOT EXISTS (
       SELECT 1 FROM server_restart_log
       WHERE server_id = ?
         AND restart_type = 'owner_triggered'
         AND bios_session_id IS NULL
         AND detected_at >= NOW() - INTERVAL '10 minutes'
     )`,
    [serverId, serverId]
  );
}

// ---------------------------------------------------------------------------
// Restart event processing
// ---------------------------------------------------------------------------

/**
 * Determine whether a detected restart should be excluded from rental counts.
 * A restart is owner-triggered if an owner_triggered row exists in
 * server_restart_log within the last 10 minutes with no bios_session_id
 * (i.e., the pending marker we wrote in recordOwnerRestart).
 *
 * @param {object} db
 * @param {number} serverId
 * @returns {Promise<boolean>}
 */
async function claimOwnerRestartMarker(
  db,
  serverId,
  biosSessionId,
  detectedAt,
  providerStartedAt,
  evidenceSourceFile
) {
  if (!detectedAt) return false;
  const marker = await db.get(
    `SELECT id FROM server_restart_log
     WHERE server_id = ?
       AND restart_type = 'owner_triggered'
       AND bios_session_id IS NULL
       AND detected_at BETWEEN ?::timestamptz - INTERVAL '10 minutes'
                           AND ?::timestamptz
     ORDER BY detected_at DESC, id DESC
     FOR UPDATE SKIP LOCKED
     LIMIT 1`,
    [serverId, detectedAt, detectedAt]
  );
  if (!marker) return false;
  await db.run(
    `UPDATE server_restart_log
     SET bios_session_id = ?,
         detected_at = COALESCE(?::timestamptz, detected_at),
         provider_started_at = ?::timestamptz,
         evidence_source_file = ?
     WHERE id = ?`,
    [biosSessionId, detectedAt, providerStartedAt, evidenceSourceFile, marker.id]
  );
  return true;
}

/**
 * Process an array of parsed restart events for a given server.
 *
 * For each new BIOS session ID (not yet recorded):
 *   1. Determine restart type (owner_triggered > scheduled > crash)
 *   2. Insert into server_restart_log
 *   3. If scheduled: decrement rental counts and expire finished rentals
 *
 * @param {object} db - DB abstraction
 * @param {number} serverId - Internal servers.id
 * @param {Array} events - Output of parseServerLog()
 */
function normalizeRestartTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const timestamp = new Date(`${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(timestamp.getTime())) return null;
  const normalized = timestamp.toISOString();
  return normalized.startsWith(value.replace(' ', 'T')) ? normalized : null;
}

async function processRestartEvents(db, serverId, events) {
  for (const event of events) {
    await db.transaction(async transactionDb => {
      const { biosSessionId, isScheduled } = event;
      const detectedAt = normalizeRestartTimestamp(event.detectedAt);
      const providerStartedAt = normalizeRestartTimestamp(event.providerStartedAt);
      const evidenceSourceFile = typeof event.evidenceSourceFile === 'string'
        ? event.evidenceSourceFile
        : null;

      await shopFileService.acquireShopServerLock(transactionDb, serverId);

      const existing = await transactionDb.get(
        'SELECT id FROM server_restart_log WHERE bios_session_id = ?',
        [biosSessionId]
      );
      if (existing) return;

      const ownerTriggered = await claimOwnerRestartMarker(
        transactionDb,
        serverId,
        biosSessionId,
        detectedAt,
        providerStartedAt,
        evidenceSourceFile
      );
      const restartType = ownerTriggered ? 'owner_triggered' : (isScheduled ? 'scheduled' : 'crash');
      let restartLogId = null;
      if (!ownerTriggered) {
        const inserted = await transactionDb.get(
          `INSERT INTO server_restart_log (
             server_id, restart_type, bios_session_id, detected_at,
             provider_started_at, evidence_source_file
           )
           VALUES (?, ?, ?, COALESCE(?::timestamptz, NOW()), ?::timestamptz, ?)
           ON CONFLICT (bios_session_id) DO NOTHING
           RETURNING id`,
          [serverId, restartType, biosSessionId, detectedAt, providerStartedAt, evidenceSourceFile]
        );
        if (!inserted) return;
        restartLogId = inserted.id;
      }

      // A scheduled event without a full date cannot safely be ordered against
      // rental checkout times, so record it without consuming a rental restart.
      if (restartType === 'scheduled' && detectedAt) {
        await decrementRentalCounts(transactionDb, serverId, detectedAt, restartLogId);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Rental count management
// ---------------------------------------------------------------------------

/**
 * Decrement restarts_remaining for all active event rental line items on a server,
 * then expire and remove file entries for those that have reached zero.
 *
 * @param {object} db - DB abstraction
 * @param {number} serverId
 */
async function decrementRentalCounts(db, serverId, detectedAt, restartLogId) {
  if (restartLogId === null || restartLogId === undefined) {
    throw new Error('Scheduled rental consumption requires restart evidence');
  }
  // Lock and snapshot every eligible line before decrementing so the durable
  // consumption event records the exact before/after counter values.
  const consumedRentals = await db.all(
    `SELECT soi.id, soi.order_id, soi.restarts_remaining
     FROM shop_order_items soi
     JOIN shop_orders so ON so.id = soi.order_id
     WHERE soi.is_active = TRUE
       AND soi.restarts_remaining > 0
       AND so.server_id = ?
       AND so.status = 'completed'
       AND so.checked_out_at <= ?
     ORDER BY soi.id
     FOR UPDATE OF soi`,
    [serverId, detectedAt]
  );

  for (const rental of consumedRentals) {
    const previous = Number(rental.restarts_remaining);
    const resulting = previous - 1;
    const consumption = await db.get(
      `INSERT INTO shop_rental_consumption_events
         (server_id, order_id, order_item_id, restart_log_id,
          previous_restarts_remaining, resulting_restarts_remaining, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?::timestamptz)
       ON CONFLICT (order_item_id, restart_log_id) DO NOTHING
       RETURNING id`,
      [serverId, rental.order_id, rental.id, restartLogId, previous, resulting, detectedAt]
    );
    if (!consumption) continue;
    await db.run(
      'UPDATE shop_order_items SET restarts_remaining = ? WHERE id = ?',
      [resulting, rental.id]
    );
  }

  // Find items that have now exhausted their restarts
  const expired = await db.all(
    `SELECT soi.id
     FROM shop_order_items soi
     JOIN shop_orders so ON soi.order_id = so.id
     WHERE soi.is_active = TRUE
       AND (soi.restarts_remaining IS NOT NULL AND soi.restarts_remaining <= 0)
       AND so.server_id = ?
       AND so.status = 'completed'`,
    [serverId]
  );

  if (expired.length === 0) return;

  const expiredIds = expired.map(r => r.id);

  // Do not mark rentals expired unless their server-file entries were removed.
  await shopFileService.removeExpiredRentals(db, serverId, expiredIds);

  // Mark items as inactive
  const placeholders = expiredIds.map(() => '?').join(', ');
  await db.run(
    `UPDATE shop_order_items SET is_active = FALSE
     WHERE id IN (${placeholders})`,
    expiredIds
  );

  // If all line items in an order are now inactive → mark order expired
  await db.run(
    `UPDATE shop_orders
     SET status = 'expired'
     WHERE id IN (
       SELECT DISTINCT order_id FROM shop_order_items WHERE id IN (${placeholders})
     )
       AND NOT EXISTS (
         SELECT 1 FROM shop_order_items
         WHERE order_id = shop_orders.id AND is_active = TRUE
       )
       AND status = 'completed'`,
    expiredIds
  );
}

module.exports = {
  parseServerLog,
  recordOwnerRestart,
  processRestartEvents,
  decrementRentalCounts,
  previousSessionScheduledShutdown,
  timeOnlyTimestampMatchesProviderStart,
};
