'use strict';

/**
 * Alt auto-ban — enforcement half of the possible-alt system.
 * Detection lives in services/altAccountCandidateService.js; this file
 * decides when detection becomes an action and writes the audit row.
 *
 * Decision policy (deliberately conservative):
 *   - Only a DEFINITIVE detection signal is enforcement-eligible: the
 *     RPT-enforced login wait ("alt-account delay"), i.e. candidate
 *     evidence of type 'rpt_login_wait'. One enforced wait is a
 *     definitive alt flag but stays review-only; CONFIRMED_WAITS_REQUIRED
 *     (2) correlated waits on the same side is what triggers the ban.
 *   - The ban targets ONLY the identity that received the enforced wait
 *     (the account that logged in right after its partner logged out).
 *   - No auto-ban when:
 *       * the pair has a 'dismissed' review (explicit owner decision),
 *       * both accounts hold trusted links to the same Discord user
 *         ('verified_discord_owner' — the alt is legitimately owned),
 *       * enforced waits were observed on BOTH sides of the pair
 *         (shared-ownership pattern — ambiguous, review only),
 *       * the target gamertag is in alt_ban_exemptions,
 *       * the per-server daily cap (AUTO_BAN_DAILY_CAP, UTC day) is met,
 *       * the global kill switch is set (app_settings
 *         'alt_auto_ban_disabled' = 'true'),
 *       * the per-server toggle (server_features 'alt_autoban') is off.
 *   - Behavioral-only candidates (possible/likely) never auto-ban; they
 *     stay in the possible-alt review queue.
 *
 * Every auto-ban writes alt_auto_bans (signal, per-side wait counts,
 * candidate/review row, banned_at) inside the provider-mutation
 * transaction that edits ban.txt.
 */

const { loadAltCandidates } = require('./altAccountCandidateService');
const nitradoService = require('./nitradoService');
const { resolveGameDataPath } = require('../utils/dayzPlatform');
const { decryptToken } = require('../utils/encryption');
const { mutateProviderList } = require('./providerListMutationService');
const missionFileService = require('./missionFileService');

const CONFIRMED_WAITS_REQUIRED = 2;
const AUTO_BAN_DAILY_CAP = 3;
const KILL_SWITCH_KEY = 'alt_auto_ban_disabled';
const FEATURE_NAME = 'alt_autoban';
const ENFORCED_WAIT_MS = 60000;
const TRIGGERED_BY = 'autoban:alt_policy';

/**
 * Read the two gates. killSwitch=true or enabled=false means the feature
 * is off for this server.
 */
async function loadAutoBanGate(db, serverId) {
  const killSwitchRow = await db.get(
    'SELECT value FROM app_settings WHERE key = ?',
    [KILL_SWITCH_KEY]
  );
  const featureRow = await db.get(
    `SELECT sf.enabled
     FROM server_features sf
     JOIN servers s ON s.id = sf.server_id
     WHERE sf.server_id = ? AND sf.feature_name = ? AND s.status = 'active'`,
    [serverId, FEATURE_NAME]
  );
  return {
    killSwitch: String(killSwitchRow?.value || '') === 'true',
    enabled: Number(featureRow?.enabled) === 1,
  };
}

/**
 * Count enforced RPT waits per identity of a pair: waits of >= 60s that
 * landed right (<= 5 min) after the OTHER side of the pair logged out —
 * the same correlation the candidate detector uses, split by side so the
 * policy can tell which account is the alt.
 */
async function loadWaitCounts(db, serverId, lowId, highId) {
  const result = await db.query(
    `SELECT lw.identity_id, COUNT(*) AS wait_count
     FROM rpt_login_wait_events lw
     WHERE lw.server_id = ?
       AND lw.identity_id IN (?, ?)
       AND lw.wait_duration_ms >= ?
       AND EXISTS (
         SELECT 1
         FROM player_sessions ending
         WHERE ending.server_id = lw.server_id
           AND ending.identity_id IN (?, ?)
           AND ending.identity_id <> lw.identity_id
           AND ending.logout_at IS NOT NULL
           AND ending.logout_at < lw.queue_entered_at
           AND lw.queue_entered_at <= ending.logout_at + INTERVAL '5 minutes'
       )
     GROUP BY lw.identity_id`,
    [serverId, lowId, highId, ENFORCED_WAIT_MS, lowId, highId]
  );
  const counts = {};
  for (const row of (result.rows || result || [])) {
    counts[Number(row.identity_id)] = Number(row.wait_count);
  }
  return counts;
}

function currentGamertagQuery() {
  return `SELECT pg.gamertag
         FROM player_gamertags pg
         JOIN player_server_activity psa ON psa.identity_id = pg.identity_id AND psa.server_id = pg.server_id
         WHERE pg.identity_id = ? AND pg.server_id = ? AND pg.is_current_gamertag = 1`;
}

/**
 * Pure policy pass: which candidates on this server are auto-ban targets
 * right now? Returns at most one target per candidate pair.
 */
async function findAutoBanTargets(db, serverId, { confirmedWaitsRequired = CONFIRMED_WAITS_REQUIRED } = {}) {
  const candidates = await loadAltCandidates(db, serverId);
  const targets = [];

  for (const candidate of candidates) {
    if (candidate.review?.status === 'dismissed') continue;
    const waitEvidence = candidate.evidence.find(item => item.type === 'rpt_login_wait');
    if (!waitEvidence) continue;
    if (candidate.evidence.some(item => item.type === 'verified_discord_owner')) continue;

    const [lowId, highId] = candidate.identityIds;
    const counts = await loadWaitCounts(db, serverId, lowId, highId);
    const lowWaits = counts[lowId] || 0;
    const highWaits = counts[highId] || 0;

    let targetId = null;
    if (lowWaits >= confirmedWaitsRequired && highWaits === 0) targetId = lowId;
    else if (highWaits >= confirmedWaitsRequired && lowWaits === 0) targetId = highId;
    if (targetId === null) continue;

    const gamertagRow = await db.get(currentGamertagQuery(), [targetId, serverId]);
    if (!gamertagRow?.gamertag) continue;

    const exempted = await db.get(
      'SELECT 1 FROM alt_ban_exemptions WHERE server_id = ? AND LOWER(gamertag) = LOWER(?)',
      [serverId, gamertagRow.gamertag]
    );
    if (exempted) continue;

    const reviewRow = await db.get(
      'SELECT id FROM alt_account_reviews WHERE server_id = ? AND identity_id_low = ? AND identity_id_high = ?',
      [serverId, lowId, highId]
    );

    targets.push({
      serverId: Number(serverId),
      identityId: Number(targetId),
      gamertag: gamertagRow.gamertag,
      pair: [lowId, highId],
      waits: { [lowId]: lowWaits, [highId]: highWaits },
      enforcedWaits: Number(waitEvidence.count) || 0,
      reviewId: reviewRow?.id || null,
      confidence: candidate.confidence,
      evidenceTypes: candidate.evidence.map(item => item.type),
    });
  }
  return targets;
}

/**
 * Execute one auto-ban through the existing provider-mutation plumbing
 * (the same path /ban and the dashboard list routes use). The gate and
 * the daily cap are re-checked under the provider mutation lock so a
 * toggle change or a cap reached by a parallel scan aborts before any
 * file is touched; the audit row is written in the same transaction.
 */
async function executeAutoBan(db, target, {
  dailyCap = AUTO_BAN_DAILY_CAP,
  fileService = missionFileService,
} = {}) {
  const scope = await db.get(
    `SELECT s.id, s.platform_server_id, gt.token_hash
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
     JOIN guild_tokens gt ON gt.guild_id = s.guild_id
       AND gt.token_type = 'nitrado' AND gt.nitrado_user_id IS NOT NULL
     WHERE s.id = ? AND s.status = 'active'`,
    [target.serverId]
  );
  if (!scope) return { banned: false, status: 'no_credential' };
  const token = decryptToken(scope.token_hash);
  const platformServerId = scope.platform_server_id;

  const gameserver = await nitradoService.getRawGameserver(token, platformServerId);
  const dataPath = resolveGameDataPath(gameserver);
  const namespace = dataPath.match(/^(\/games\/[^/]+)\/(?:noftp|ftproot)\//)?.[1];
  if (!namespace) return { banned: false, status: 'path_unavailable' };
  const dir = `${dataPath}/`;
  const filename = 'ban.txt';

  const evidence = {
    pair: target.pair,
    waitsBySide: target.waits,
    enforcedWaits: target.enforcedWaits,
    candidate: { confidence: target.confidence, evidenceTypes: target.evidenceTypes },
  };
  const gamertag = target.gamertag;

  const outcome = await mutateProviderList({
    db,
    internalServerId: target.serverId,
    platformServerId,
    token,
    dir,
    filename,
    listType: 'blacklist',
    action: 'add',
    triggeredBy: TRIGGERED_BY,
    beforeMutation: async transactionDb => {
      const gate = await loadAutoBanGate(transactionDb, target.serverId);
      if (!gate.enabled || gate.killSwitch) {
        const error = new Error('Alt auto-ban disabled before execution');
        error.code = 'AUTO_BAN_DISABLED';
        throw error;
      }
      const capRow = await transactionDb.get(
        `SELECT COUNT(*)::int AS n
         FROM alt_auto_bans
         WHERE server_id = ? AND banned_at >= CURRENT_DATE AT TIME ZONE 'UTC'`,
        [target.serverId]
      );
      if (Number(capRow?.n ?? 0) >= dailyCap) {
        const error = new Error(`Daily auto-ban cap (${dailyCap}) reached for server ${target.serverId}`);
        error.code = 'AUTO_BAN_DAILY_CAP';
        throw error;
      }
      {
        const locked = await transactionDb.get(
          `SELECT gt.token_hash
           FROM servers s
           JOIN guild_tokens gt ON gt.guild_id = s.guild_id
             AND gt.token_type = 'nitrado' AND gt.nitrado_user_id IS NOT NULL
           WHERE s.id = ? AND s.status = 'active' AND s.platform_server_id = ?
             FOR NO KEY UPDATE OF s, gt`,
          [target.serverId, platformServerId]
        );
        if (!locked || decryptToken(locked.token_hash) !== token) {
          const error = new Error('Auto-ban credential context changed before execution');
          error.code = 'SERVER_AUTHORIZATION_MISMATCH';
          throw error;
        }
      }
    },
    mutate: banned => {
      if (banned.map(g => g.toLowerCase()).includes(gamertag.toLowerCase())) {
        return { lines: banned, result: { status: 'exists', entries: banned } };
      }
      return { lines: [...banned, gamertag], result: { status: 'added', entries: [...banned, gamertag] } };
    },
    localWriter: async (transactionDb, mutation) => {
      // No audit row when the gamertag was already banned (no change).
      if (mutation?.result?.status !== 'added') return;
      await transactionDb.run(
        `INSERT INTO alt_auto_bans
           (server_id, identity_id, gamertag, signal, evidence, review_id, triggered_by, banned_at)
         VALUES (?, ?, ?, 'rpt_login_wait', ?::jsonb, ?, ?, NOW())`,
        [
          target.serverId,
          target.identityId,
          gamertag,
          JSON.stringify(evidence),
          target.reviewId,
          TRIGGERED_BY,
        ]
      );
    },
    fileService,
  });

  return {
    banned: outcome.result?.status === 'added',
    alreadyBanned: outcome.result?.status === 'exists',
    status: outcome.result?.status || (outcome.changed ? 'changed' : 'unchanged'),
  };
}

/**
 * Evaluate auto-ban for one exact server. Called from the log ingestion
 * path right after enforced RPT login-wait evidence is persisted. Never
 * throws at the caller: a single failed target does not stop the rest,
 * and any failure leaves the server unchanged (review queue is enough).
 */
async function evaluateAltAutoBan(db, serverId, { dailyCap = AUTO_BAN_DAILY_CAP } = {}) {
  const gate = await loadAutoBanGate(db, serverId);
  if (gate.killSwitch || !gate.enabled) {
    return { serverId: Number(serverId), skipped: gate.killSwitch ? 'kill_switch' : 'disabled', banned: [] };
  }

  const targets = await findAutoBanTargets(db, Number(serverId));
  const banned = [];
  const skipped = [];
  for (const target of targets) {
    try {
      const outcome = await executeAutoBan(db, target, { dailyCap });
      if (outcome.banned) banned.push({ gamertag: target.gamertag, identityId: target.identityId });
      if (outcome.alreadyBanned) skipped.push({ gamertag: target.gamertag, reason: 'already_banned' });
      if (!outcome.banned && !outcome.alreadyBanned) skipped.push({ gamertag: target.gamertag, reason: outcome.status });
    } catch (err) {
      console.error(`❌ Alt auto-ban failed for server ${serverId} gamertag ${target.gamertag}:`, err.message);
      skipped.push({ gamertag: target.gamertag, reason: err.code || 'error' });
    }
  }
  return { serverId: Number(serverId), banned, skipped };
}

module.exports = {
  evaluateAltAutoBan,
  findAutoBanTargets,
  executeAutoBan,
  loadAutoBanGate,
  CONFIRMED_WAITS_REQUIRED,
  AUTO_BAN_DAILY_CAP,
  KILL_SWITCH_KEY,
  FEATURE_NAME,
};
