/*
 * services/sessionStateService.js
 *
 * Per-server "session time left / days funded" state (card t_c1de9125).
 *
 * The bot's 5-minute status loop is the ONLY writer: it persists the provider
 * session anchor (Nitrado status + last_status_change), the scheduled restart
 * it already computes for Discord, and — at most once per 12h per service —
 * the Nitrado service-details `suspending_in` value, converted to a wall-clock
 * `funded_until` instant that stays true between refreshes.
 *
 * Web routes (dashboard overview, player portal) are DB-only readers.
 */

'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

// funded_until is derived from suspending_in at observation time, so it only
// needs re-observation on the order of once a day; a missed renewal or a
// payment flips it within one refresh window.
const FUNDING_REFRESH_MS = 12 * 60 * 60 * 1000;

/**
 * Normalize a provider gameserver status to the persisted vocabulary.
 * @param {string|null} value e.g. 'started' | 'stopped'
 * @returns {'started'|'stopped'|null}
 */
function normalizeStatus(value) {
  if (value === 'started' || value === 'stopped') return value;
  return null;
}

/**
 * Should the funding (suspending_in) observation be re-fetched now?
 * A null/zero last attempt means "never observed" → refresh.
 */
function shouldRefreshFunding(lastAttemptAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(lastAttemptAtMs) || lastAttemptAtMs <= 0) return true;
  return nowMs - lastAttemptAtMs >= FUNDING_REFRESH_MS;
}

/**
 * Convert Nitrado's suspending_in seconds into a wall-clock funded-until
 * instant. Returns null when the value is not a usable non-negative number.
 */
function fundedUntilMs(suspendingInSeconds, observedAtMs) {
  const seconds = Number(suspendingInSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (!Number.isFinite(observedAtMs)) return null;
  return observedAtMs + Math.round(seconds) * 1000;
}

/**
 * Whole days of funding remaining (0 when unknown or expired).
 */
function daysFunded(fundedUntilMs, nowMs = Date.now()) {
  if (!Number.isFinite(fundedUntilMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.floor((fundedUntilMs - nowMs) / DAY_MS));
}

/**
 * Upsert one server's session state. The funding columns are only touched
 * when a fresh observation is supplied — otherwise the stored values are
 * preserved (COALESCE against the existing row).
 *
 * @param {object} pool pg Pool (bot side) — raw SQL with $n placeholders
 * @param {object} args { serverId, status, sessionStartedAtMs, nextRestartAtMs,
 *                        fundedUntilMs|null, fundingObservedAtMs|null }
 */
async function recordSessionState(pool, args) {
  await pool.query(
    `INSERT INTO server_session_state
       (server_id, status, session_started_at, next_restart_at,
        funded_until, funding_observed_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (server_id) DO UPDATE
       SET status = EXCLUDED.status,
           session_started_at = EXCLUDED.session_started_at,
           next_restart_at = EXCLUDED.next_restart_at,
           -- Keep the last known funding when this tick has no fresh data.
           -- (The target table is not referenceable in the VALUES clause.)
           funded_until = COALESCE(EXCLUDED.funded_until, server_session_state.funded_until),
           funding_observed_at = COALESCE(EXCLUDED.funding_observed_at, server_session_state.funding_observed_at),
           updated_at = NOW()`,
    [
      args.serverId,
      args.status,
      args.sessionStartedAtMs != null ? new Date(args.sessionStartedAtMs) : null,
      args.nextRestartAtMs != null ? new Date(args.nextRestartAtMs) : null,
      args.fundedUntilMs != null ? new Date(args.fundedUntilMs) : null,
      args.fundingObservedAtMs != null ? new Date(args.fundingObservedAtMs) : null,
    ]
  );
}

// A restart time that passed more than this long ago is stale data (the bot
// loop replaces it within one 5-min tick; the Discord label uses the same
// 30-min reboot window in formatRestartLabel).
const STALE_RESTART_WINDOW_MS = 30 * 60 * 1000;

/**
 * Shape a stored row (or null) for API responses. Two staleness rules:
 *  - a next_restart_at before the current session start is stale — the
 *    session has already restarted and the bot loop replaces it next tick;
 *  - a next_restart_at more than 30 min in the past is stale — within the
 *    window the UI may render it as "Restarting…".
 *
 * @param {object|null} row { session_started_at, next_restart_at, funded_until }
 * @param {number} [nowMs]
 */
function sessionView(row, nowMs = Date.now()) {
  const startedAt = row?.session_started_at ? new Date(row.session_started_at) : null;
  let nextRestartAt = row?.next_restart_at ? new Date(row.next_restart_at) : null;
  if (nextRestartAt && Number.isNaN(nextRestartAt.getTime())) nextRestartAt = null;
  if (nextRestartAt && startedAt && Number.isFinite(startedAt.getTime())
      && nextRestartAt <= startedAt) {
    nextRestartAt = null;
  }
  if (nextRestartAt && nowMs - nextRestartAt.getTime() > STALE_RESTART_WINDOW_MS) {
    nextRestartAt = null;
  }
  const fundedUntil = row?.funded_until ? new Date(row.funded_until) : null;
  const fundedUntilMs = fundedUntil && Number.isFinite(fundedUntil.getTime())
    ? fundedUntil.getTime() : null;
  return {
    sessionStartedAt: startedAt && Number.isFinite(startedAt.getTime())
      ? startedAt.toISOString() : null,
    nextRestartAt: nextRestartAt ? nextRestartAt.toISOString() : null,
    fundedUntil: fundedUntilMs !== null ? new Date(fundedUntilMs).toISOString() : null,
    daysFunded: daysFunded(fundedUntilMs, nowMs),
  };
}

module.exports = {
  DAY_MS,
  FUNDING_REFRESH_MS,
  daysFunded,
  fundedUntilMs,
  normalizeStatus,
  recordSessionState,
  shouldRefreshFunding,
  sessionView,
};
