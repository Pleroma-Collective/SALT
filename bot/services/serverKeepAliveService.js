'use strict';

/*
 * bot/services/serverKeepAliveService.js
 *
 * "Keep Alive": when the health monitor observes a crashed gameserver
 * (Nitrado reachable so the guild token is valid, game server offline,
 * service not suspended) for a server with keep_alive enabled, it
 * re-issues a durable start mutation through the SAME lifecycle path as
 * the dashboard Server Control Panel (services/serverLifecycleMutationService)
 * — journaled in provider_mutations with triggered_by 'system:keep_alive'.
 *
 * Restart-storm protection (stateless — the mutation journal is the state):
 *   - COOLDOWN_MS (15m): no two auto-starts within 15 minutes. The monitor
 *     ticks every 5m, so a still-crashed server is retried ~3x/hour max.
 *   - MAX_ATTEMPTS_PER_WINDOW (3 per rolling hour): after 3 auto-start
 *     attempts in the last hour, further auto-starts are skipped until the
 *     window slides. Manual dashboard/bot actions are unaffected.
 *
 * Optional notification: posts to the guild's configured ops-alert channel
 * (guild_ai_settings.ops_alert_channel_id, set via /setup-ai or the
 * admin bot-config page) when enabled. No config, no notice.
 */

const pool = require('../db');
const dashboardDb = require('../utils/dashboardDbAdapter');
const { controlServerLifecycle } = require('../../services/serverLifecycleMutationService');

const COOLDOWN_MS = 15 * 60 * 1000;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 3;

/**
 * Pure decision: may this auto-start fire?
 * @param {object} args
 * @param {Date|null} args.lastKeepAliveAt  most recent keep-alive journal row (in-window)
 * @param {number}    args.keepAliveAttemptsInWindow count of keep-alive journal rows (in-window)
 * @param {number}    [args.nowMs]
 * @returns {{allowed: boolean, reason?: string}}
 */
function keepAliveDecision({ lastKeepAliveAt, keepAliveAttemptsInWindow, nowMs = Date.now() }) {
  if (keepAliveAttemptsInWindow >= MAX_ATTEMPTS_PER_WINDOW) {
    return { allowed: false, reason: 'window_exhausted' };
  }
  if (lastKeepAliveAt) {
    const last = lastKeepAliveAt instanceof Date ? lastKeepAliveAt.getTime() : Number(lastKeepAliveAt);
    if (Number.isFinite(last) && nowMs - last < COOLDOWN_MS) {
      return { allowed: false, reason: 'cooldown' };
    }
  }
  return { allowed: true };
}

/**
 * Count recent keep-alive attempts from the durable journal.
 * @returns {Promise<{lastKeepAliveAt: Date|null, keepAliveAttemptsInWindow: number}>}
 */
async function loadKeepAliveJournal(serverId, db = pool) {
  const result = await db.query(
    `SELECT max(created_at) AS last_keep_alive_at, count(*)::int AS attempts
       FROM provider_mutations
      WHERE server_id = $1
        AND workflow = 'server_lifecycle'
        AND triggered_by = 'system:keep_alive'
        AND created_at >= now() - interval '1 hour'`
  );
  const row = result.rows[0] || {};
  return {
    lastKeepAliveAt: row.last_keep_alive_at || null,
    keepAliveAttemptsInWindow: row.attempts || 0,
  };
}

/** Best-effort notice to the guild's ops-alert channel (reused from AI ops alerts). */
async function postKeepAliveNotice(client, server, operationId, db = pool) {
  try {
    const result = await db.query(
      `SELECT ops_alert_enabled, ops_alert_channel_id
         FROM guild_ai_settings WHERE guild_id = $1`,
      [server.guild_id]
    );
    const row = result.rows[0];
    if (!row?.ops_alert_enabled || !row?.ops_alert_channel_id) return;
    const channel = await client.channels.fetch(String(row.ops_alert_channel_id));
    if (!channel || channel.guildId !== String(server.discord_guild_id)) {
      console.warn(`⚠️ [keep-alive] ops-alert channel ${row.ops_alert_channel_id} not usable in guild ${server.discord_guild_id}`);
      return;
    }
    const message = [
      `⚠️ **Keep-Alive** — \`${server.name}\` was offline; it was auto-started (journal operation #${operationId}).`,
      `Protection: max ${MAX_ATTEMPTS_PER_WINDOW} auto-starts/hour, ${COOLDOWN_MS / 60000}m cooldown. If it stays down, start it manually from the dashboard Server Control Panel.`,
    ].join('\n');
    await channel.send(message.slice(0, 4000));
    console.log(`✅ [keep-alive] notice posted for ${server.name} (guild ${server.discord_guild_id})`);
  } catch (error) {
    console.error('❌ [keep-alive] notice failed:', error.message);
  }
}

/**
 * Crash reaction for one server. Called by the health monitor after the
 * game_server component has been classified and written.
 *
 * @param {object} client       discord client (for the optional notice)
 * @param {object} server       row from the monitor query (server_id, guild_id,
 *                              discord_guild_id, name, keep_alive_actor_id)
 * @param {object} gameserver   raw Nitrado gameserver object
 * @param {object} classified   classifyGameServerStatus(gameserver)
 * @param {object} [deps]       injectable deps for tests (control, journal, db)
 */
async function maybeKeepAlive(client, server, gameserver, classified, deps = {}) {
  const control = deps.control || controlServerLifecycle;
  const journal = deps.journal || loadKeepAliveJournal;
  const db = deps.db || pool;
  const nowMs = deps.nowMs ?? Date.now();

  // Only a genuine crash: provider reachable (token valid), game offline.
  if (classified.state !== 'offline' || classified.detail !== 'offline') return;
  // Suspended services are billing-parked, not crashed — never restart them.
  if (String(gameserver?.status || '').toLowerCase() === 'suspended') return;
  if (!server.keep_alive_actor_id) {
    console.warn(`⚠️ [keep-alive] server ${server.name} has no guild owner row; skipping auto-start`);
    return;
  }

  const { lastKeepAliveAt, keepAliveAttemptsInWindow } = await journal(server.server_id, db);
  const decision = keepAliveDecision({ lastKeepAliveAt, keepAliveAttemptsInWindow, nowMs });
  if (!decision.allowed) {
    console.log(`⏸️ [keep-alive] ${server.name}: auto-start skipped (${decision.reason}; attempts=${keepAliveAttemptsInWindow})`);
    return;
  }

  try {
    const result = await control({
      db: dashboardDb,
      internalServerId: server.server_id,
      actor: { id: server.keep_alive_actor_id },
      action: 'start',
      triggeredBy: 'system:keep_alive',
    });
    console.log(`♻️ [keep-alive] ${server.name} was offline — auto-started (journal operation #${result.operationId})`);
    await postKeepAliveNotice(client, server, result.operationId, db);
  } catch (error) {
    // Journal already recorded/snapshotted the attempt; log and let the next
    // tick (subject to cooldown) retry.
    console.error(`❌ [keep-alive] auto-start failed for ${server.name}:`, error.code || error.message);
  }
}

module.exports = {
  COOLDOWN_MS,
  WINDOW_MS,
  MAX_ATTEMPTS_PER_WINDOW,
  keepAliveDecision,
  loadKeepAliveJournal,
  maybeKeepAlive,
};
