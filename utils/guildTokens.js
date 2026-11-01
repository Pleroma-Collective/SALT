const { decryptToken } = require('./encryption');

/**
 * Decrypt a stored token hash, degrading gracefully on failure.
 *
 * A stored token that was encrypted with a different key (e.g. after an
 * ENCRYPTION_KEY rotation, or seeded/fake test data) makes `decryptToken`
 * throw an uncaught "bad decrypt" that would otherwise crash the entire
 * process. Returning null lets every caller treat it as "no usable token"
 * and respond with a per-request error instead of a hard crash.
 */
function safeDecryptToken(tokenHash, context) {
  try {
    return decryptToken(tokenHash);
  } catch (err) {
    console.error(
      '❌ [TOKEN-LOOKUP] Failed to decrypt token' +
        (context ? ` (${context})` : '') +
        `: ${err.message}`
    );
    return null;
  }
}

/**
 * Get decrypted Nitrado token for a guild by Discord guild ID.
 * @param {object} db - Database adapter instance
 * @param {string} discordGuildId - Discord guild ID
 * @returns {Promise<string|null>} Decrypted token or null
 */
async function getGuildToken(db, discordGuildId) {
  const row = await db.get(`
    SELECT gt.token_hash
    FROM guilds g
    JOIN guild_tokens gt ON g.id = gt.guild_id
    WHERE g.discord_guild_id = ?
      AND g.status = 'approved'
      AND gt.token_type = 'nitrado'
      AND gt.nitrado_user_id IS NOT NULL
    ORDER BY gt.created_at DESC
    LIMIT 1
  `, [discordGuildId]);
  if (!row || !row.token_hash) return null;
  return safeDecryptToken(row.token_hash, `discord guild ${discordGuildId}`);
}

/**
 * Get decrypted Nitrado token for the guild that owns a given server.
 * @param {object} db - Database adapter instance
 * @param {string|number} platformServerId - Nitrado platform server ID
 * @returns {Promise<string|null>} Decrypted token or null
 */
async function getGuildTokenForServer(db, platformServerId) {
  console.log('🔍 [TOKEN-LOOKUP] Looking up token for server:', platformServerId);

  const row = await db.get(`
    SELECT gt.token_hash, g.name as guild_name, g.id as guild_id
    FROM servers s
    JOIN guilds g ON s.guild_id = g.id
    JOIN guild_tokens gt ON g.id = gt.guild_id
    WHERE s.platform_server_id = ?
      AND g.status = 'approved'
      AND gt.token_type = 'nitrado'
      AND gt.nitrado_user_id IS NOT NULL
    LIMIT 1
  `, [platformServerId]);

  if (!row || !row.token_hash) {
    console.error('❌ [TOKEN-LOOKUP] No token found for server:', platformServerId);
    console.error('   This means either:');
    console.error('   1. Server not registered in database');
    console.error('   2. Server not linked to a guild');
    console.error('   3. Guild has no Nitrado token');
    return null;
  }

  console.log('✅ [TOKEN-LOOKUP] Token found for guild:', row.guild_name, '(ID:', row.guild_id, ')');
  const decrypted = safeDecryptToken(row.token_hash, `platform server ${platformServerId}`);
  if (decrypted) console.log('✅ [TOKEN-LOOKUP] Token decrypted successfully');
  return decrypted;
}

async function getGuildTokenForExactServer(db, serverId, guildId) {
  const row = await db.get(`
    SELECT gt.token_hash
    FROM servers s
    JOIN guilds g ON g.id = s.guild_id
    JOIN guild_tokens gt ON gt.guild_id = g.id
    WHERE s.id = ?
      AND s.guild_id = ?
      AND s.status = 'active'
      AND g.status = 'approved'
      AND gt.token_type = 'nitrado'
      AND gt.nitrado_user_id IS NOT NULL
    ORDER BY gt.created_at DESC
    LIMIT 1
  `, [serverId, guildId]);
  if (!row?.token_hash) return null;
  return safeDecryptToken(row.token_hash, `server id ${serverId}`);
}

/**
 * Startup self-check: attempt to decrypt every stored guild token with the
 * current ENCRYPTION_KEY. A token encrypted under a different key (key
 * rotation, stale seed data) would otherwise fail silently at first API use.
 *
 * Logs a loud warning listing the affected guild ids (never token values)
 * and returns those failing guild ids. Guild ids come from
 * discord_guild_id, with `guild#<id>` as fallback when it is missing.
 *
 * @param {object} db - Database adapter instance
 * @returns {Promise<string[]>} guild ids with undecryptable tokens (empty if all OK)
 */
async function verifyAllTokens(db) {
  const rows = await db.all(`
    SELECT gt.token_hash, g.discord_guild_id, g.id
    FROM guild_tokens gt
    JOIN guilds g ON g.id = gt.guild_id
  `);
  const failing = new Set();
  for (const row of rows) {
    if (!row.token_hash) continue;
    try {
      decryptToken(row.token_hash);
    } catch (err) {
      failing.add(row.discord_guild_id || `guild#${row.id}`);
    }
  }
  const failingIds = [...failing];
  if (failingIds.length) {
    console.warn(
      `⚠️  [TOKEN-VERIFY] ${failingIds.length} of ${rows.length} stored guild token(s) cannot be decrypted ` +
      `with the current ENCRYPTION_KEY (key mismatch?) — affected guilds: ${failingIds.join(', ')}`
    );
  } else {
    console.log(`✅ [TOKEN-VERIFY] ${rows.length} stored guild token(s) all decrypt OK`);
  }
  return failingIds;
}

module.exports = { getGuildToken, getGuildTokenForServer, getGuildTokenForExactServer, verifyAllTokens };
