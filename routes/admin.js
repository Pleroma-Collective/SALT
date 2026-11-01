const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { ensureAdmin } = require('../middleware/auth');
const { validateGuildId, validateGuildIdParam, validateServerId } = require('../middleware/validators');

const { logAction } = require('../utils/audit');

const { classifyBotHealth } = require('../utils/botHealth');

// Constants

const FULL_RESET_PRESERVE_TABLES = new Set([
  // auth + privileges
  'users',
  'guilds',
  'guild_roles',
  'guild_setup_state',
  // server registrations + platform credentials
  'servers',
  'guild_tokens',
  // keep linked player identities/accounts so players remain linked after reset
  'players',
  'player_identities',
  'player_gamertags',
  'linked_accounts',
  // preserve server activity rows so linked accounts still resolve to their guild
  // (counters are zeroed below rather than wiping the whole table)
  'player_server_activity',
  // preserve every authoritative economy balance, reserve, purchase, and audit row
  'guild_economy_config',
  'economy_precision_reconciliation',
  'economy_supply_precision_reconciliation',
  'economy_supply_log',
  'player_wallets',
  'player_bank_accounts',
  'economy_transactions',
  'economy_daily_assessments',
  'financial_idempotency_records',
  'financial_refund_claims',
  'casino_sessions',
  'casino_game_history',
  // Faction rows are durable parents for retained bounty contracts and audit history.
  'factions',
  'faction_members',
  'bounties',
  'bounty_claims',
  'bounty_faction_members',
  'bounty_objective_events',
  'bounty_events',
  'bounty_settings',
  'shop_items',
  'shop_preset_locations',
  'shop_orders',
  'shop_order_items',
  'shop_order_payment_allocations',
  'shop_rental_consumption_events',
  'shop_refund_decisions',
  'server_restart_log',
  // preserve parents/history whose CASCADE paths would erase the rows above
  'server_player_memberships',
  'kill_events',
  // durable provider recovery plans, exact snapshots, and reconciliation history
  'provider_mutations',
  'provider_mutation_files',
  // schema bookkeeping
  'schema_migrations',
  'schema_version',
  // session storage
  'sessions'
]);

const PLAYER_RESET_PRESERVE_TABLES = new Set([
  'players',
  'player_identities',
  'player_gamertags',
  'linked_accounts',
  // A stats reset is never an economy reset: preserve balances, reserves,
  // purchases, configuration, and immutable monetary audit history.
  'guild_economy_config',
  'economy_precision_reconciliation',
  'economy_supply_precision_reconciliation',
  'economy_supply_log',
  'player_wallets',
  'player_bank_accounts',
  'economy_transactions',
  'economy_daily_assessments',
  'financial_idempotency_records',
  'financial_refund_claims',
  'casino_sessions',
  'casino_game_history',
  // Faction membership is authorization state for retained faction bounties.
  'factions',
  'faction_members',
  'bounties',
  'bounty_claims',
  'bounty_faction_members',
  'bounty_objective_events',
  'bounty_events',
  'bounty_settings',
  'shop_items',
  'shop_preset_locations',
  'shop_orders',
  'shop_order_items',
  'shop_order_payment_allocations',
  'shop_rental_consumption_events',
  'shop_refund_decisions',
  // These are immutable economic evidence/parents once a bounty was settled.
  'server_player_memberships',
  'kill_events'
]);

function quoteIdent(identifier) {
  return '"' + String(identifier).replace(/"/g, '""') + '"';
}

function isEscrowProtectionConflict(error) {
  return (error?.status === 409 || error?.code === 'P0001')
    && /active (?:financial|bounty|casino) escrow|wallet with active financial escrow|financial history must be retained/i.test(error.message || '');
}

async function ensurePostgres(db) {
  // This feature is intentionally PostgreSQL-first to match production.
  if (db?.type && db.type !== 'postgres') {
    throw new Error('Database reset tools currently require PostgreSQL');
  }
}

async function getPublicTables(db) {
  const rows = await db.query(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename ASC`,
    []
  );
  return rows.map(r => r.tablename);
}

async function getIdentityReferenceColumns(db) {
  return db.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN (
          'identity_id',
          'killer_identity_id',
          'victim_identity_id',
          'attacker_identity_id',
          'reported_identity_id'
        )
      ORDER BY table_name, column_name`,
    []
  );
}


/**
 * GET /api/admin/guilds
 * List approved Discord guilds by default.
 * Removed (disabled) guilds no longer appear in the default list; the
 * guild-management approval page retrieves them with ?status=disabled.
 */
router.get('/guilds', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;

  const requestedStatus = req.query.status;
  const status = requestedStatus === undefined ? 'approved' : requestedStatus;
  if (status !== 'approved' && status !== 'disabled') {
    return res.status(400).json({ error: "status must be 'approved' or 'disabled'" });
  }

  const query = `
    SELECT 
      g.*,
      g.discord_guild_id as guild_id,
      g.name as "guildName",
      g.created_at as "addedAt",
      u.username as "addedByUsername",
      COUNT(DISTINCT s.id) as "serverCount",
      CASE WHEN gt.token_hash IS NOT NULL THEN 1 ELSE 0 END as "hasToken"
    FROM guilds g
    LEFT JOIN guild_tokens gt ON g.id = gt.guild_id AND gt.token_type = 'nitrado'
    LEFT JOIN guild_roles gr ON g.id = gr.guild_id AND gr.role = 'owner'
    LEFT JOIN users u ON gr.user_id = u.id
    LEFT JOIN servers s ON g.id = s.guild_id
    WHERE g.status = ?
    GROUP BY g.id, g.discord_guild_id, g.name, u.username, gt.token_hash
    ORDER BY g.created_at DESC
  `;

  try {
    const rows = await db.query(query, [status]);
    res.json({ success: true, guilds: rows });
  } catch (err) {
    console.error('❌ Error fetching guilds:', err);
    res.status(500).json({ error: 'Failed to fetch guilds' });
  }
});

/**
 * POST /api/admin/guilds
 * Add a new Discord guild to the approved list
 */
router.post('/guilds', validateGuildId, ensureAdmin, async (req, res) => {
  return res.status(410).json({
    error: 'Manual guild creation is disabled. Invite the bot and run /register-token as the Discord guild owner or an Administrator.'
  });
});

/**
 * DELETE /api/admin/guilds/:guildId
 * Remove a guild for real (admin only): every linked server is deleted via
 * the same real-delete path (row + local files + server-owned history), the
 * guild row is deleted (cascades to guild tokens, settings, shop, factions,
 * tickets, ...), and the bot-leave job is enqueued so the bot leaves Discord.
 * Nitrado is never touched. Audit events survive with their guild pointer
 * nulled.
 */
router.delete('/guilds/:guildId', validateGuildIdParam, ensureAdmin, async (req, res) => {
  const { guildId } = req.params;
  const db = req.app.locals.db;

  try {
    const guild = await db.get('SELECT id, name FROM guilds WHERE discord_guild_id = ?', [guildId]);
    if (!guild) {
      return res.status(404).json({ error: 'Guild not found' });
    }

    const servers = await db.all('SELECT * FROM servers WHERE guild_id = ?', [guild.id]);

    // Any linked server with live data blocks the whole guild delete
    for (const server of servers) {
      const blockedBy = await collectServerDeleteBlockers(db, server.id);
      if (blockedBy.length) {
        return res.status(409).json({
          error: `Cannot delete guild: server ${server.name || server.id} still has data in ${blockedBy.join(', ')}`
        });
      }
    }

    const downloadRoot = req.app.locals.downloadRoot || path.join(__dirname, '..', 'downloads');
    const removedDirs = [];
    for (const server of servers) {
      removedDirs.push(...await removeServerDownloadDirs(downloadRoot, server.platform_server_id));
      await removeServerOwnedHistory(db, server.id);
    }

    // Non-cascading guild references: strip pointers instead of destroying
    // the surviving records (account links, audit evidence)
    await db.run('UPDATE linked_accounts SET verified_by_guild_id = NULL WHERE verified_by_guild_id = ?', [guild.id]);
    await db.run('UPDATE security_audit_events SET guild_id = NULL WHERE guild_id = ?', [guild.id]);
    for (const table of ['radar_activations', 'radar_synthetic_events', 'teleport_destinations', 'player_pra_restrictions', 'teleport_requests', 'teleport_events']) {
      await db.run(`DELETE FROM ${table} WHERE guild_id = ?`, [guild.id]).catch(() => null);
    }

    await db.transaction(async (transactionDb) => {
      // Enqueue the bot-leave job in the same transaction as the guild delete
      // so the outbox row and the removal are atomic. Re-deleting re-queues
      // instead of failing.
      await transactionDb.run(
        `INSERT INTO discord_guild_leave_jobs
           (discord_guild_id, status, attempts, next_attempt_at, updated_at)
         VALUES (?, 'pending', 0, NOW(), NOW())
         ON CONFLICT (discord_guild_id) DO UPDATE SET
           status = 'pending', attempts = 0, next_attempt_at = NOW(),
           last_error = NULL, completed_at = NULL, locked_at = NULL, updated_at = NOW()`,
        [guildId]
      );
      await transactionDb.run('DELETE FROM guilds WHERE id = ?', [guild.id]);
      await logAction(transactionDb, req.user.id, 'REMOVE_GUILD', 'guild', guild.id, {
        guildName: guild.name,
        discordGuildId: guildId,
        serversRemoved: servers.length,
        removedDirs
      });
    });

    console.log(`✅ Guild ${guildId} (${guild.name}) deleted by ${req.user.username}; servers removed: ${servers.length}, dirs: ${removedDirs.length}`);

    res.json({
      success: true,
      message: `Guild removed. ${servers.length} linked server(s) were deleted with it.`,
      serversRemoved: servers.length,
      removedDirs
    });
  } catch (err) {
    console.error('❌ Guild delete error:', err);
    if (isEscrowProtectionConflict(err)) {
      return res.status(409).json({
        error: 'Operation blocked: active financial escrow or retained financial history exists'
      });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/admin/stats
 * Get platform statistics
 */
router.get('/stats', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;

  try {
    const [guildsRow, serversRow, usersRow, linkedRow] = await Promise.all([
      db.get('SELECT COUNT(*) as count FROM guilds', []),
      db.get('SELECT COUNT(*) as count FROM servers', []),
      db.get('SELECT COUNT(*) as count FROM users', []),
      db.get('SELECT COUNT(*) as count FROM linked_accounts', [])
    ]);

    res.json({
      success: true,
      stats: {
        totalGuilds: guildsRow.count,
        totalServers: serversRow.count,
        totalUsers: usersRow.count,
        totalLinkedAccounts: linkedRow.count
      }
    });
  } catch (err) {
    console.error('❌ Error fetching stats:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/admin/servers
 * List all servers with optional guild filter
 */
router.get('/servers', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const { guildId } = req.query;

  try {
    let guildDatabaseId = null;
    if (guildId) {
      const guild = await db.get('SELECT id FROM guilds WHERE discord_guild_id = ?', [guildId]);
      if (!guild) {
        return res.json({ success: true, servers: [] });
      }
      guildDatabaseId = guild.id;
    }

    await fetchServers(db, guildDatabaseId, res);
  } catch (err) {
    console.error('❌ Error looking up guild:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * Helper function to fetch servers with optional guild filter
 */
async function fetchServers(db, guildDatabaseId, res) {
  // Correlated subquery for player_count avoids GROUP BY on s.* (PostgreSQL rejects that).
  let query = `
    SELECT
      s.*,
      s.platform_server_id as nitrado_server_id,
      s.name as server_name,
      g.name as "guildName",
      g.icon_url as "guildIcon",
      (SELECT or2.user_id FROM guild_roles or2 WHERE or2.guild_id = g.id AND or2.role = 'owner' LIMIT 1) as "ownerId",
      (SELECT u2.username FROM users u2
         JOIN guild_roles or3 ON or3.user_id = u2.id
         WHERE or3.guild_id = g.id AND or3.role = 'owner' LIMIT 1) as "ownerUsername",
      (SELECT COUNT(DISTINCT la.id)
         FROM player_server_activity psa
         JOIN player_identities pi ON pi.id = psa.identity_id
         JOIN linked_accounts la ON la.identity_id = pi.id
         WHERE psa.server_id = s.id) as player_count
    FROM servers s
    LEFT JOIN guilds g ON s.guild_id = g.id
  `;

  const params = [];
  if (guildDatabaseId !== null) {
    query += ' WHERE s.guild_id = ?';
    params.push(guildDatabaseId);
  }

  query += ' ORDER BY s.created_at DESC';

  try {
    const rows = await db.query(query, params);
    res.json({ success: true, servers: rows });
  } catch (err) {
    console.error('❌ Error fetching servers:', err);
    res.status(500).json({ error: 'Failed to fetch servers' });
  }
}

/**
 * Physical file cleanup for a deleted server.
 * Removes `server_<platformId>` (and, under numeric user-id parents, bare
 * `<platformId>`) dirs from every downloads root parent. Shared parent dirs
 * are kept. Nitrado itself is never touched.
 * Returns the list of removed absolute paths.
 */
async function removeServerDownloadDirs(downloadRoot, platformServerId) {
  const removed = [];
  if (!platformServerId) return removed;
  let parents = [];
  try {
    parents = await fs.promises.readdir(downloadRoot, { withFileTypes: true });
  } catch {
    return removed; // no download root yet — nothing to remove
  }
  for (const parent of parents) {
    if (!parent.isDirectory()) continue;
    const isNumericParent = /^\d+$/.test(parent.name);
    const candidates = [
      path.join(downloadRoot, parent.name, `server_${platformServerId}`),
      ...(isNumericParent ? [path.join(downloadRoot, parent.name, String(platformServerId))] : [])
    ];
    for (const dir of candidates) {
      let existed = false;
      try {
        existed = fs.existsSync(dir);
        if (!existed) continue;
        await fs.promises.rm(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch {
        // skip unreadable dirs — not fatal
      }
    }
  }
  return removed;
}

/**
 * Tables whose rows block a server delete (non-cascading FKs / live work).
 * History tables (economy assessments, closed casino rows, terminal
 * mutation journal) are removed with the server instead — see
 * removeServerOwnedHistory.
 */
const SERVER_DELETE_BLOCKING_TABLES = [
  'shop_items', 'rotation_snippets', 'rotation_presets', 'rotation_history', 'mod_actions',
  'financial_refund_claims', 'economy_supply_precision_reconciliation', 'radar_activations',
  'financial_idempotency_records',
  'shop_order_payment_allocations', 'shop_rental_consumption_events', 'shop_refund_decisions'
];

async function collectServerDeleteBlockers(db, serverId) {
  const blockedBy = [];
  for (const table of SERVER_DELETE_BLOCKING_TABLES) {
    const row = await db.get(`SELECT COUNT(*) AS count FROM ${table} WHERE server_id = ?`, [serverId]);
    if (row && Number(row.count) > 0) blockedBy.push(table);
  }
  // In-flight provider mutations block: a prepared-but-unapplied mutation is live work.
  const openMutations = await db.get(
    `SELECT COUNT(*) AS count FROM provider_mutations
     WHERE server_id = ? AND status NOT IN ('completed','compensated','failed','rolled_back','recovery_pending')`,
    [serverId]
  );
  if (openMutations && Number(openMutations.count) > 0) blockedBy.push('provider_mutations (in-flight)');
  // Casino history only blocks while an escrow is active (the DB guard agrees).
  const activeEscrow = await db.get(
    "SELECT COUNT(*) AS count FROM casino_game_history WHERE server_id = ? AND status = 'active' AND reserved_wager > 0",
    [serverId]
  );
  if (activeEscrow && Number(activeEscrow.count) > 0) blockedBy.push('casino_game_history (active escrow)');
  return blockedBy;
}

/**
 * Server-owned history that travels with the server: terminal provider
 * mutation journal (+ file payloads), daily economy assessments (append-only
 * retention trigger bypassed via SET LOCAL in this delete's own transaction),
 * and closed casino game history (active escrows block earlier).
 */
async function removeServerOwnedHistory(db, serverId) {
  await db.run(
    'DELETE FROM provider_mutation_files WHERE mutation_id IN (SELECT id FROM provider_mutations WHERE server_id = ?)',
    [serverId]
  ).catch(() => null);
  await db.run('DELETE FROM provider_mutations WHERE server_id = ?', [serverId]);
  await db.transaction(async (txDb) => {
    await txDb.run('SET LOCAL dayz.authorized_server_deletion = on');
    await txDb.run('DELETE FROM economy_daily_assessments WHERE server_id = ?', [serverId]);
  });
  await db.run('DELETE FROM casino_game_history WHERE server_id = ?', [serverId]);
}

/**
 * DELETE /api/admin/servers/:serverId
 * Delete a server (admin only): removes the DB row (cascades to per-server
 * tables), its local file copies on this host, and its download bookkeeping.
 * Nitrado service/slots are left untouched.
 */
router.delete('/servers/:serverId', ensureAdmin, async (req, res) => {
  const { serverId } = req.params;
  const db = req.app.locals.db;

  try {
    const server = await db.get('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const blockedBy = await collectServerDeleteBlockers(db, serverId);
    if (blockedBy.length) {
      return res.status(409).json({
        error: `Cannot delete server: data still references it in ${blockedBy.join(', ')}`
      });
    }

    const downloadRoot = req.app.locals.downloadRoot || path.join(__dirname, '..', 'downloads');
    const removedDirs = await removeServerDownloadDirs(downloadRoot, server.platform_server_id);

    await removeServerOwnedHistory(db, serverId);
    await db.run('DELETE FROM servers WHERE id = ?', [serverId]);
    await db.run('DELETE FROM downloads WHERE server_id = ?', [serverId]).catch(() => null);

    console.log(`✅ Server ${serverId} (${server.server_name || server.name}) deleted by admin ${req.user.username}; removed dirs: ${removedDirs.length}`);
    await logAction(db, req.user.id, 'DELETE_SERVER', 'server', serverId, {
      serverName: server.server_name || server.name,
      nitradoServerId: server.nitrado_server_id,
      platformServerId: server.platform_server_id,
      removedDirs
    });

    res.json({ success: true, message: 'Server deleted', removedDirs });
  } catch (err) {
    console.error('❌ Database error:', err);
    if (isEscrowProtectionConflict(err)) {
      return res.status(409).json({
        error: 'Operation blocked: active financial escrow or retained financial history exists'
      });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/admin/users
 * List admins and server owners
 */
router.get('/users', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;

  const query = `
    SELECT DISTINCT
      u.id,
      u.discord_id,
      u.username,
      u.discriminator,
      u.avatar,
      u.is_admin,
      u.created_at,
      STRING_AGG(DISTINCT g.name, ',') as "ownedGuilds"
    FROM users u
    LEFT JOIN guild_roles gr ON gr.user_id = u.id AND gr.role = 'owner'
    LEFT JOIN guilds g ON g.id = gr.guild_id
    WHERE u.is_admin = 1 OR gr.role = 'owner'
    GROUP BY u.id
    ORDER BY u.is_admin DESC, u.username ASC
  `;

  try {
    const rows = await db.query(query, []);
    res.json({ success: true, users: rows });
  } catch (err) {
    console.error('❌ Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * POST /api/admin/users/:userId/promote
 * Promote user to admin
 */
router.post('/users/:userId/promote', ensureAdmin, async (req, res) => {
  return res.status(410).json({ error: 'Use the scoped role-management API.' });
});

/**
 * POST /api/admin/users/:userId/demote
 * Remove admin privileges from user
 */
router.post('/users/:userId/demote', ensureAdmin, async (req, res) => {
  return res.status(410).json({ error: 'Use the scoped role-management API.' });
});

/**
 * GET /api/admin/audit
 * Get audit log entries
 */
router.get('/audit', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const { action, userId, limit = 100, offset = 0 } = req.query;
  const pageLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
  const pageOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
  if (action && (typeof action !== 'string' || action.length > 100)) {
    return res.status(400).json({ error: 'Invalid action filter' });
  }
  if (userId && !/^\d+$/.test(String(userId))) {
    return res.status(400).json({ error: 'Invalid user filter' });
  }

  let query = `
    SELECT 
      al.*,
      u.username,
      u.avatar,
      u.discord_id
    FROM audit_log al
    LEFT JOIN users u ON al.user_id = u.id
    WHERE 1=1
  `;

  const params = [];

  if (action) {
    query += ' AND al.action = ?';
    params.push(action);
  }

  if (userId) {
    query += ' AND al.user_id = ?';
    params.push(userId);
  }

  query += ' ORDER BY al.timestamp DESC LIMIT ? OFFSET ?';
  params.push(pageLimit, pageOffset);

  try {
    const rows = await db.query(query, params);
    const entries = rows.map(row => {
      let details = {};
      try { details = typeof row.details === 'string' ? JSON.parse(row.details) : (row.details || {}); } catch (_) { details = {}; }
      return {
        ...row,
        userId: row.discord_id,
        targetType: row.target_type,
        targetId: row.target_id,
        details,
      };
    });
    res.json({ success: true, entries });
  } catch (err) {
    console.error('❌ Error fetching audit log:', err);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

/**
 * GET /api/admin/guilds/pending
 * Get pending guilds awaiting approval
 */
router.get('/guilds/pending', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;

  const query = `
    SELECT 
      g.*,
      g.discord_guild_id as guild_id,
      g.name as "guildName",
      u.username as "ownerUsername",
      u.discord_id as "ownerDiscordId",
      u.avatar as "ownerAvatar",
      COUNT(DISTINCT s.id) as "serverCount"
    FROM guilds g
    LEFT JOIN guild_roles gr ON g.id = gr.guild_id AND gr.role = 'owner'
    LEFT JOIN users u ON gr.user_id = u.id
    LEFT JOIN servers s ON g.id = s.guild_id
    WHERE g.status = 'pending'
    GROUP BY g.id, g.discord_guild_id, g.name, u.username, u.discord_id, u.avatar
    ORDER BY g.created_at ASC
  `;

  try {
    const rows = await db.query(query, []);
    res.json({ success: true, guilds: rows });
  } catch (err) {
    console.error('❌ Error fetching pending guilds:', err);
    res.status(500).json({ error: 'Failed to fetch pending guilds' });
  }
});

/**
 * POST /api/admin/guilds/:guildId/approve
 * Manual approval is unsafe: verified /register-token setup activates the guild atomically.
 */
router.post('/guilds/:guildId/approve', ensureAdmin, async (_req, res) => {
  return res.status(410).json({
    error: 'Manual approval is disabled. The Discord guild owner or an Administrator must complete /register-token.'
  });
});

/**
 * POST /api/admin/guilds/:guildId/disable
 * Disable a guild
 */
router.post('/guilds/:guildId/disable', ensureAdmin, async (req, res) => {
  const { guildId } = req.params;
  const { reason } = req.body;
  const db = req.app.locals.db;
  const adminId = req.user.id;
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) {
    return res.status(400).json({ error: 'Reason must be 1000 characters or fewer' });
  }

  try {
    const result = await db.transaction(async transactionDb => {
      const guild = await transactionDb.get(
        'SELECT * FROM guilds WHERE discord_guild_id = ? FOR UPDATE', [guildId]
      );
      if (!guild) return { status: 404, error: 'Guild not found' };
      if (guild.status !== 'approved') {
        return { status: 400, error: 'Only approved guilds can be disabled; deny incomplete setup instead' };
      }

      const activeBounty = await transactionDb.get(
        `SELECT b.id FROM bounties b
         JOIN servers s ON s.id = b.server_id
         WHERE s.guild_id = ? AND b.status = 'active'
         ORDER BY b.id LIMIT 1 FOR UPDATE OF b`, [guild.id]
      );
      const activeCasino = await transactionDb.get(
        `SELECT c.session_id FROM casino_sessions c
         JOIN servers s ON s.id = c.server_id
         WHERE s.guild_id = ? AND c.status = 'active' AND c.reserved_wager > 0
         ORDER BY c.session_id LIMIT 1 FOR UPDATE OF c`, [guild.id]
      );
      if (activeBounty || activeCasino) {
        const error = new Error('Guild cannot be disabled while active financial escrow exists');
        error.status = 409;
        throw error;
      }

      const updateResult = await transactionDb.run(
        `UPDATE guilds
         SET status = 'disabled', disabled_at = CURRENT_TIMESTAMP,
             disabled_by = ?, disabled_reason = ?
         WHERE discord_guild_id = ? AND status <> 'disabled'`,
        [adminId, reason || 'No reason provided', guildId]
      );
      if (!updateResult.changes) return { status: 409, error: 'Guild status changed; refresh and try again' };
      await logAction(transactionDb, adminId, 'DISABLE_GUILD', 'guild', guild.id, {
        guildName: guild.name,
        discordGuildId: guildId,
        reason: reason || 'No reason provided'
      });
      return { guild };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    console.log(`🚫 Guild ${result.guild.name} disabled by admin ${req.user.username}`);
    return res.json({ success: true, message: 'Guild disabled successfully' });
  } catch (err) {
    console.error('❌ Database error:', err.code || err.name);
    if (err.status === 409 || isEscrowProtectionConflict(err)) {
      return res.status(409).json({ error: 'Guild cannot be disabled while active financial escrow exists' });
    }
    return res.status(500).json({ error: 'Database error' });
  }
});

/**
 * POST /api/admin/guilds/:guildId/enable
 * Re-enable a disabled guild
 */
router.post('/guilds/:guildId/enable', ensureAdmin, async (req, res) => {
  const { guildId } = req.params;
  const db = req.app.locals.db;
  const adminId = req.user.id;

  try {
    const guild = await db.get('SELECT * FROM guilds WHERE discord_guild_id = ?', [guildId]);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    if (guild.status !== 'disabled') return res.status(400).json({ error: 'Guild is not disabled' });
    if (!guild.approved_at) {
      return res.status(409).json({
        error: 'This guild never completed verified activation. Run /register-token instead.'
      });
    }

    const updateResult = await db.run(
      `UPDATE guilds 
       SET status = 'approved', 
           approved_at = CURRENT_TIMESTAMP,
           approved_by = ?,
           disabled_at = NULL,
           disabled_by = NULL,
           disabled_reason = NULL
       WHERE discord_guild_id = ? AND status = 'disabled' AND approved_at IS NOT NULL`,
      [adminId, guildId]
    );
    if (!updateResult.changes) return res.status(409).json({ error: 'Guild status changed; refresh and try again' });

    console.log(`✅ Guild ${guild.name} re-enabled by admin ${req.user.username}`);
    await logAction(db, adminId, 'ENABLE_GUILD', 'guild', guild.id, {
      guildName: guild.name,
      discordGuildId: guildId
    });

    res.json({ success: true, message: 'Guild enabled successfully' });
  } catch (err) {
    console.error('❌ Database error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * POST /api/admin/guilds/:guildId/deny
 * Deny a pending guild request
 */
router.post('/guilds/:guildId/deny', ensureAdmin, async (req, res) => {
  const { guildId } = req.params;
  const { reason } = req.body;
  const db = req.app.locals.db;
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) {
    return res.status(400).json({ error: 'Reason must be 1000 characters or fewer' });
  }

  try {
    const guild = await db.get('SELECT * FROM guilds WHERE discord_guild_id = ?', [guildId]);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    if (guild.status !== 'pending') return res.status(400).json({ error: 'Can only deny pending guilds' });

    const updateResult = await db.run(
      `UPDATE guilds
       SET status = 'denied', disabled_at = CURRENT_TIMESTAMP, disabled_by = ?, disabled_reason = ?
       WHERE discord_guild_id = ? AND status = 'pending'`,
      [req.user.id, reason || 'Denied by dashboard administrator', guildId]
    );
    if (!updateResult.changes) return res.status(409).json({ error: 'Guild status changed; refresh and try again' });

    console.log(`❌ Guild ${guild.name} denied by admin ${req.user.username}`);
    console.log(`   Reason: ${reason || 'No reason provided'}`);
    await logAction(db, req.user.id, 'DENY_GUILD', 'guild', guild.id, {
      guildName: guild.name,
      discordGuildId: guildId,
      reason: reason || 'No reason provided'
    });

    res.json({ success: true, message: 'Guild request denied' });
  } catch (err) {
    console.error('❌ Database error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/admin/overview/stats
 * Get dashboard overview stats (guild breakdown, servers, players)
 */
router.get('/overview/stats', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;

  try {
    const [guildRow, serverRow, playerRow] = await Promise.all([
      db.get(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
           SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) as disabled
         FROM guilds`,
        []
      ),
      db.get('SELECT COUNT(*) as total FROM servers', []),
      db.get('SELECT COUNT(*) as total FROM linked_accounts', [])
    ]);

    res.json({
      success: true,
      stats: {
        guilds: {
          total: guildRow.total || 0,
          approved: guildRow.approved || 0,
          pending: guildRow.pending || 0,
          disabled: guildRow.disabled || 0
        },
        servers: { total: serverRow.total || 0 },
        players: { total: playerRow.total || 0 }
      }
    });
  } catch (err) {
    console.error('❌ Error fetching overview stats:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/admin/overview/health
 * Get system health status (DB, Discord API, Nitrado API, last sync)
 */
router.get('/overview/health', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const now = new Date().toISOString();
  const checks = {};
  let failCount = 0;

  // Database health: simple SELECT 1
  try {
    await db.get('SELECT 1 as ok', []);
    checks.database = { status: 'healthy', message: 'OK', lastCheck: now };
  } catch (err) {
    checks.database = { status: 'error', message: err.message, lastCheck: now };
    failCount++;
  }

  // Nitrado API: check if any guild has a token configured
  try {
    const row = await db.get('SELECT COUNT(*) as cnt FROM guild_tokens WHERE token_type = ?', ['nitrado']);
    checks.nitradoApi = {
      status: 'connected',
      message: row && row.cnt > 0 ? `${row.cnt} token(s) configured` : 'No tokens configured',
      lastCheck: now
    };
  } catch (err) {
    checks.nitradoApi = { status: 'error', message: err.message, lastCheck: now };
    failCount++;
  }

  // Discord API: check if any user has authenticated via Discord
  try {
    await db.get('SELECT COUNT(*) as cnt FROM users WHERE discord_id IS NOT NULL', []);
    checks.discordApi = { status: 'connected', message: 'OK', lastCheck: now };
  } catch (err) {
    checks.discordApi = { status: 'error', message: err.message, lastCheck: now };
    failCount++;
  }

  // Bot process: heartbeat written by the separate Discord bot container.
  try {
    const row = await db.get(
      `SELECT status, started_at, last_heartbeat, guild_count,
              websocket_ping_ms, process_uptime_seconds
         FROM bot_health
        WHERE id = 1`,
      []
    );
    checks.bot = classifyBotHealth(row);
    if (checks.bot.status !== 'online') failCount++;
  } catch (err) {
    checks.bot = classifyBotHealth(null);
    failCount++;
  }

  // Last sync: most recent completed sync_job
  try {
    const row = await db.get(
      `SELECT completed_at FROM sync_jobs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1`,
      []
    );
    checks.lastSync = row ? row.completed_at : null;
  } catch (err) {
    checks.lastSync = null;
  }

  const overallStatus = failCount === 0 ? 'healthy' : failCount >= 3 ? 'critical' : 'degraded';

  res.json({
    success: true,
    health: {
      status: overallStatus,
      checks: {
        nitradoApi: checks.nitradoApi,
        discordApi: checks.discordApi,
        bot: checks.bot,
        database: checks.database,
        lastSync: checks.lastSync
      }
    }
  });
});

/**
 * GET /api/admin/overview/activity
 * Get recent activity feed (guild approvals, disables, new requests, server registrations)
 */
router.get('/overview/activity', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;

  const approvedQuery = `
    SELECT
      'guild_approved' as type,
      g.name as "guildName",
      g.discord_guild_id as guild_id,
      u.username as "adminUsername",
      g.approved_at as timestamp
    FROM guilds g
    LEFT JOIN users u ON g.approved_by = u.id
    WHERE g.status = 'approved' AND g.approved_at IS NOT NULL
    ORDER BY g.approved_at DESC
    LIMIT 15
  `;

  const disabledQuery = `
    SELECT
      'guild_disabled' as type,
      g.name as "guildName",
      g.discord_guild_id as guild_id,
      u.username as "adminUsername",
      g.disabled_reason as reason,
      g.disabled_at as timestamp
    FROM guilds g
    LEFT JOIN users u ON g.disabled_by = u.id
    WHERE g.disabled_at IS NOT NULL
    ORDER BY g.disabled_at DESC
    LIMIT 15
  `;

  const pendingQuery = `
    SELECT
      'guild_requested' as type,
      g.name as "guildName",
      g.discord_guild_id as guild_id,
      NULL as "adminUsername",
      g.created_at as timestamp
    FROM guilds g
    WHERE g.status = 'pending'
    ORDER BY g.created_at DESC
    LIMIT 15
  `;

  const serverQuery = `
    SELECT
      'server_registered' as type,
      s.name as "serverName",
      s.id as server_id,
      g.name as "guildName",
      s.created_at as timestamp
    FROM servers s
    LEFT JOIN guilds g ON g.id = s.guild_id
    ORDER BY s.created_at DESC
    LIMIT 15
  `;

  try {
    const [approved, disabled, pending, servers] = await Promise.all([
      db.query(approvedQuery, []),
      db.query(disabledQuery, []),
      db.query(pendingQuery, []),
      db.query(serverQuery, [])
    ]);

    const all = [...approved, ...disabled, ...pending, ...servers]
      .filter(r => r.timestamp)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 15);

    res.json({ success: true, activities: all });
  } catch (err) {
    console.error('❌ Error fetching activity:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/admin/db-reset/players?query=
 * Search linked player identities for per-player reset actions.
 */
router.get('/db-reset/players', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const query = String(req.query.query || '').trim().toLowerCase();

  try {
    const rows = await db.query(
      `SELECT
         pi.id AS identity_id,
         pi.platform,
         pi.platform_user_id,
         COALESCE(pg.gamertag, pi.platform_username, pi.platform_user_id) AS gamertag,
         COUNT(DISTINCT la.id) AS linked_accounts
       FROM player_identities pi
       LEFT JOIN linked_accounts la ON la.identity_id = pi.id
       LEFT JOIN player_gamertags pg
              ON pg.identity_id = pi.id
             AND pg.is_current_gamertag = 1
       WHERE ($1 = '' OR
              LOWER(COALESCE(pg.gamertag, '')) LIKE '%' || $1 || '%' OR
              LOWER(COALESCE(pi.platform_user_id, '')) LIKE '%' || $1 || '%' OR
              LOWER(COALESCE(pi.platform_username, '')) LIKE '%' || $1 || '%')
       GROUP BY pi.id, pi.platform, pi.platform_user_id, pg.gamertag, pi.platform_username
       ORDER BY gamertag ASC
       LIMIT 50`,
      [query]
    );

    res.json({ success: true, players: rows });
  } catch (err) {
    console.error('❌ Error searching reset players:', err);
    res.status(500).json({ error: 'Failed to load players' });
  }
});

/**
 * POST /api/admin/db-reset/player-stats
 * Body: { identityId }
 *
 * Removes tracked stats/events for a single identity while preserving:
 * - player_identities
 * - linked_accounts
 * - privileges / guild membership
 */
router.post('/db-reset/player-stats', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const identityValue = req.body.identityId;
  const identityId = typeof identityValue === 'number'
    ? identityValue
    : typeof identityValue === 'string' && /^[1-9]\d*$/.test(identityValue)
      ? Number(identityValue)
      : NaN;

  if (!Number.isSafeInteger(identityId) || identityId <= 0) {
    return res.status(400).json({ error: 'Valid identityId is required' });
  }

  try {
    await ensurePostgres(db);
    const reset = await db.transaction(async () => {
      const identity = await db.get(
        `SELECT id, platform, platform_user_id
           FROM player_identities
          WHERE id = $1
          FOR UPDATE`,
        [identityId]
      );
      if (!identity) return null;

      const activeBounty = await db.get(
        `SELECT id FROM bounties
         WHERE status = 'active'
           AND (target_identity_id = ? OR poster_identity_id = ? OR claimed_by_identity_id = ?)
         ORDER BY id
         LIMIT 1
         FOR UPDATE`,
        [identityId, identityId, identityId]
      );
      if (activeBounty) {
        const error = new Error('Cannot reset a player with active bounty escrow');
        error.status = 409;
        throw error;
      }

      const refs = await getIdentityReferenceColumns(db);
      const targets = refs.filter(r => !PLAYER_RESET_PRESERVE_TABLES.has(r.table_name));
      const touched = [];
      for (const ref of targets) {
        const sql = `DELETE FROM ${quoteIdent(ref.table_name)} WHERE ${quoteIdent(ref.column_name)} = ?`;
        const result = await db.run(sql, [identityId]);
        if (result?.changes > 0) {
          touched.push({ table: ref.table_name, column: ref.column_name, deleted: result.changes });
        }
      }

      const onlineResult = await db.run(
        'DELETE FROM server_online_cache WHERE identity_id = ?',
        [identityId]
      );
      if (onlineResult?.changes > 0) {
        touched.push({ table: 'server_online_cache', column: 'identity_id', deleted: onlineResult.changes });
      }

      const totalDeleted = touched.reduce((sum, row) => sum + row.deleted, 0);
      await logAction(db, req.user.id, 'RESET_PLAYER_STATS', 'player_identity', identityId, {
        platform: identity.platform,
        platformUserId: identity.platform_user_id,
        deletedRows: totalDeleted,
        tables: touched
      });
      return { identity, touched, totalDeleted };
    });
    if (!reset) return res.status(404).json({ error: 'Identity not found' });

    res.json({
      success: true,
      message: 'Player stats reset complete',
      identityId,
      deletedRows: reset.totalDeleted,
      details: reset.touched
    });
  } catch (err) {
    console.error('❌ Error resetting player stats:', err);
    if (isEscrowProtectionConflict(err)) {
      return res.status(409).json({
        error: 'Operation blocked: active financial escrow or retained financial history exists'
      });
    }
    res.status(500).json({ error: err.message || 'Failed to reset player stats' });
  }
});

/**
 * POST /api/admin/db-reset/full
 * Body: { confirmation }
 *
 * Wipes all tracked data while preserving:
 * - linked accounts and privilege/auth tables
 * - server registrations and tokens
 */
router.post('/db-reset/full', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const confirmation = String(req.body.confirmation || '');

  if (confirmation !== 'RESET TRACKED DATA') {
    return res.status(400).json({ error: 'Confirmation phrase mismatch' });
  }

  try {
    await ensurePostgres(db);

    const allTables = await getPublicTables(db);
    const resetTables = allTables.filter(t => !FULL_RESET_PRESERVE_TABLES.has(t));

    if (resetTables.length === 0) {
      return res.json({ success: true, message: 'No resettable tables found', resetTables: [] });
    }

    const truncateSql = `TRUNCATE TABLE ${resetTables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`;
    await db.query(truncateSql, []);

    // Zero out activity counters while keeping the identity→server rows so that
    // linked accounts can still resolve to their guild after the reset.
    await db.query(
      `UPDATE player_server_activity SET total_sessions = 0, last_seen = NULL`,
      []
    );

    await logAction(db, req.user.id, 'RESET_TRACKED_DATA', 'database', null, {
      resetTableCount: resetTables.length,
      resetTables
    });

    res.json({
      success: true,
      message: 'Tracked data reset complete',
      resetTableCount: resetTables.length,
      resetTables
    });
  } catch (err) {
    console.error('❌ Error resetting tracked data:', err);
    if (isEscrowProtectionConflict(err)) {
      return res.status(409).json({
        error: 'Operation blocked: active financial escrow or retained financial history exists'
      });
    }
    res.status(500).json({ error: err.message || 'Failed to reset tracked data' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Player Reports endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/reports?guildId=&status=open
 * List player reports, optionally filtered by status.
 */
router.get('/reports', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const { guildId, status } = req.query;

  if (status && !['all', 'open', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'Invalid report status' });
  }

  try {
    let where = [];
    const params = [];

    if (guildId) {
      params.push(guildId);
      where.push(`r.guild_id = $${params.length}`);
    }

    if (status && status !== 'all') {
      params.push(status);
      where.push(`r.status = $${params.length}`);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const reports = await db.query(
      `SELECT
         r.id,
         r.status,
         r.reason,
         r.evidence,
         r.resolution_note,
         r.created_at,
         r.resolved_at,
         r.reporter_discord_name AS reporter_name,
         r.reported_gamertag,
         r.resolved_by_discord_name AS resolved_by_name
       FROM player_reports r
       ${whereClause}
       ORDER BY r.created_at DESC`,
      params
    );

    res.json({ ok: true, reports });
  } catch (err) {
    console.error('❌ /api/admin/reports GET error:', err);
    res.status(500).json({ ok: false, error: 'Failed to load reports' });
  }
});

/**
 * POST /api/admin/reports/:id/resolve
 * Mark a report as resolved with an optional resolution note.
 * Body: { note }
 */
router.post('/reports/:id/resolve', ensureAdmin, async (req, res) => {
  const db       = req.app.locals.db;
  const reportId = parseInt(req.params.id, 10);
  const { note } = req.body;

  if (isNaN(reportId)) return res.status(400).json({ ok: false, error: 'Invalid report id' });
  if (note !== undefined && (typeof note !== 'string' || note.length > 2000)) {
    return res.status(400).json({ ok: false, error: 'Resolution note must be 2000 characters or fewer' });
  }

  try {
    const result = await db.run(
      `UPDATE player_reports
       SET status = 'resolved',
           resolved_by_discord_id = ?,
           resolved_by_discord_name = ?,
           resolved_at = NOW(),
           resolution_note = ?
       WHERE id = ? AND status = 'open'`,
      [req.user.discord_id, req.user.username, note || null, reportId]
    );
    if (!result.changes) {
      const existing = await db.get('SELECT status FROM player_reports WHERE id = ?', [reportId]);
      return res.status(existing ? 409 : 404).json({ ok: false, error: existing ? 'Report is already closed' : 'Report not found' });
    }
    await logAction(db, req.user.id, 'REPORT_RESOLVED', 'player_report', reportId, { noteProvided: Boolean(note) });
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ /api/admin/reports/:id/resolve error:', err);
    res.status(500).json({ ok: false, error: 'Failed to resolve report' });
  }
});

/**
 * POST /api/admin/reports/:id/dismiss
 * Mark a report as dismissed.
 */
router.post('/reports/:id/dismiss', ensureAdmin, async (req, res) => {
  const db       = req.app.locals.db;
  const reportId = parseInt(req.params.id, 10);

  if (isNaN(reportId)) return res.status(400).json({ ok: false, error: 'Invalid report id' });

  try {
    const result = await db.run(
      `UPDATE player_reports
       SET status = 'dismissed',
           resolved_by_discord_id = ?,
           resolved_by_discord_name = ?,
           resolved_at = NOW()
       WHERE id = ? AND status = 'open'`,
      [req.user.discord_id, req.user.username, reportId]
    );
    if (!result.changes) {
      const existing = await db.get('SELECT status FROM player_reports WHERE id = ?', [reportId]);
      return res.status(existing ? 409 : 404).json({ ok: false, error: existing ? 'Report is already closed' : 'Report not found' });
    }
    await logAction(db, req.user.id, 'REPORT_DISMISSED', 'player_report', reportId, {});
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ /api/admin/reports/:id/dismiss error:', err);
    res.status(500).json({ ok: false, error: 'Failed to dismiss report' });
  }
});

// ── Holiday events (per-server, DB-persisted) ───────────────────────────────
// Admin-managed holiday windows: one row per (guild, platform server) in
// holiday_server_configs; servers without a row run the default set from
// public/data/holiday-windows.json. See services/holidayConfigService.js.

const HolidayConfig = require('../services/holidayConfigService');
const { MISSION_SUBDIRS } = require('../utils/dayzPlatform');
const { getGuildDownloadPath } = require('../services/logSyncService');

async function resolveHolidayServer(db, serverId) {
  if (!/^\d+$/.test(String(serverId || ''))) return null;
  return db.get(
    'SELECT id, guild_id, platform, platform_server_id, name FROM servers WHERE id = ?',
    [Number(serverId)]
  );
}

/** Build the (guild, platform server) key the config service persists by. */
function holidayKey(server) {
  return {
    guildId: server.guild_id,
    platformServerId: String(server.platform_server_id),
    platform: server.platform,
  };
}

/** Server download dir when resolvable (null when the server has none yet). */
function holidayServerDownloadDir(guildDiscordId, platformServerId) {
  try {
    return getGuildDownloadPath(guildDiscordId, platformServerId);
  } catch {
    return null;
  }
}

router.get('/holiday-events', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  try {
    res.json({
      ok: true,
      defaults: HolidayConfig.withStates(HolidayConfig.loadDefaultSet()),
      servers: await HolidayConfig.listServerHolidayConfigs(db),
    });
  } catch (err) {
    console.error('❌ /api/admin/holiday-events error:', err);
    res.status(500).json({ ok: false, error: 'Failed to load holiday configs' });
  }
});

router.get('/holiday-events/:serverId', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const server = await resolveHolidayServer(db, req.params.serverId);
  if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });

  try {
    const config = await HolidayConfig.serverHolidayConfig(db, server.guild_id, server.platform_server_id);
    const serverDir = holidayServerDownloadDir(
      (await db.get('SELECT discord_guild_id FROM guilds WHERE id = ?', [server.guild_id]))?.discord_guild_id,
      server.platform_server_id
    );
    const folders = serverDir ? HolidayConfig.listMissionFolders(serverDir, MISSION_SUBDIRS) : [];
    res.json({
      ok: true,
      server: {
        serverId: server.id,
        platformServerId: String(server.platform_server_id),
        guildId: server.guild_id,
        name: server.name,
        platform: server.platform,
      },
      config,
      packs: { known: folders.length > 0, folders, missing: HolidayConfig.missingPacks(serverDir, folders, config.events) },
      defaults: HolidayConfig.withStates(HolidayConfig.loadDefaultSet()),
    });
  } catch (err) {
    console.error('❌ /api/admin/holiday-events/:serverId error:', err);
    res.status(500).json({ ok: false, error: 'Failed to load holiday config' });
  }
});

router.put('/holiday-events/:serverId', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const server = await resolveHolidayServer(db, req.params.serverId);
  if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });

  const body = req.body || {};
  const validationError = HolidayConfig.validateHolidayConfig({ events: body.events });
  if (validationError) return res.status(400).json({ ok: false, error: validationError });

  try {
    const serverDir = holidayServerDownloadDir(
      (await db.get('SELECT discord_guild_id FROM guilds WHERE id = ?', [server.guild_id]))?.discord_guild_id,
      server.platform_server_id
    );
    const folders = serverDir ? HolidayConfig.listMissionFolders(serverDir, MISSION_SUBDIRS) : [];
    const packCheck = HolidayConfig.missingPacks(serverDir, folders, body.events);
    if (packCheck.known && packCheck.missing.length) {
      return res.status(400).json({
        ok: false,
        error: `Pack not found on this server: ${packCheck.missing.map(m => m.mission).join(', ')} (available: ${folders.join(', ') || 'none'})`,
      });
    }
    const events = await HolidayConfig.saveServerConfig(db, holidayKey(server), body, body.enabled === undefined ? undefined : Boolean(body.enabled));
    await logAction(db, req.user.id, 'HOLIDAY_CONFIG_SAVED', 'server', server.id,
      { platformServerId: server.platform_server_id, eventCount: events.length, packsKnown: packCheck.known });
    res.json({ ok: true, events });
  } catch (err) {
    console.error('❌ /api/admin/holiday-events/:serverId (save) error:', err);
    res.status(500).json({ ok: false, error: 'Failed to save holiday config' });
  }
});

router.post('/holiday-events/:serverId/apply-defaults', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const server = await resolveHolidayServer(db, req.params.serverId);
  if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });

  try {
    const events = await HolidayConfig.applyDefaultSet(db, holidayKey(server));
    await logAction(db, req.user.id, 'HOLIDAY_DEFAULTS_APPLIED', 'server', server.id,
      { platformServerId: server.platform_server_id, eventCount: events.length });
    res.json({ ok: true, events });
  } catch (err) {
    console.error('❌ /api/admin/holiday-events/:serverId/apply-defaults error:', err);
    res.status(500).json({ ok: false, error: 'Failed to apply default set' });
  }
});

router.post('/holiday-events/:serverId/toggle', ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const server = await resolveHolidayServer(db, req.params.serverId);
  if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });

  const enabled = Boolean((req.body || {}).enabled);
  try {
    await HolidayConfig.setEnabled(db, holidayKey(server), enabled);
    await logAction(db, req.user.id, enabled ? 'HOLIDAY_ENABLED' : 'HOLIDAY_DISABLED', 'server', server.id,
      { platformServerId: server.platform_server_id });
    res.json({ ok: true, enabled });
  } catch (err) {
    console.error('❌ /api/admin/holiday-events/:serverId/toggle error:', err);
    res.status(500).json({ ok: false, error: 'Failed to toggle holiday config' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Bot config (mirror of the bot's setup* slash commands)
//
// Per-guild admin surface for every channel/feed/config the bot reads:
//   guild-level  — welcome/goodbye/suggestions/antispam (guild_features),
//                  player-facing AI (guild_ai_settings), reaction roles
//   per-server   — kill/faction/mod-report feeds (discord_feeds),
//                  server status channels (server_features 'server_status'),
//                  player-count alerts (player_count_alerts),
//                  player-link settings (server_features 'player_linking'),
//                  wipe info (server_wipe_info)
// The bot picks changes up on its normal read cadence; storage is the same
// tables the slash commands write (services/botConfigService.js).
// ─────────────────────────────────────────────────────────────────────────────

const BotConfig = require('../services/botConfigService');

/** GET /api/admin/bot-config/:guildId — full bot-config view for one guild. */
router.get('/bot-config/:guildId', validateGuildIdParam, ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  try {
    res.json({ ok: true, config: await BotConfig.loadBotConfig(db, req.params.guildId) });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ ok: false, error: err.message });
    console.error('❌ /api/admin/bot-config GET error:', err);
    res.status(500).json({ ok: false, error: 'Failed to load bot config' });
  }
});

/** PUT /api/admin/bot-config/:guildId — partial patch; only sent sections are written. */
router.put('/bot-config/:guildId', validateGuildIdParam, ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const { guildId } = req.params;
  const body = req.body || {};
  try {
    const guild = await db.get('SELECT id, name FROM guilds WHERE discord_guild_id = ?', [guildId]);
    if (!guild) return res.status(404).json({ ok: false, error: 'Guild not found' });
    const applied = await BotConfig.applyBotConfig(db, guildId, body);
    await logAction(db, req.user.id, 'BOT_CONFIG_UPDATED', 'guild', guild.id, {
      guildName: guild.name,
      discordGuildId: guildId,
      sections: Object.keys(body).filter(k => body[k] !== undefined),
      applied,
    });
    res.json({ ok: true, applied });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ ok: false, error: err.message });
    if (err.status === 404) return res.status(404).json({ ok: false, error: err.message });
    console.error('❌ /api/admin/bot-config PUT error:', err);
    res.status(500).json({ ok: false, error: 'Failed to save bot config' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 * Activity zones — admin-defined areas whose ingested combat activity is
 * posted to a configured channel. Geometry is a circle (center + radius in
 * DayZ world units); matching runs on the feed-processor tick against the
 * existing kill_events stream (services/zoneService.js).
 * ═══════════════════════════════════════════════════════════════════════ */

const ZoneService = require('../services/zoneService');

/** Resolve a server to (id, name, discord_guild_id) for approved guilds only. */
async function resolveAdminServer(db, serverId) {
  return db.get(
    `SELECT s.id, s.name, s.status, g.id AS guild_db_id, g.discord_guild_id
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     WHERE s.id = ? AND g.status = 'approved'`,
    [Number(serverId)]
  );
}

router.get('/zones/:serverId', validateServerId, ensureAdmin, async (req, res) => {
  try {
    const server = await resolveAdminServer(req.app.locals.db, req.params.serverId);
    if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });
    const zones = await ZoneService.listZones(req.app.locals.db, server.id);
    res.json({
      ok: true,
      server: { id: server.id, name: server.name, status: server.status, guildId: server.discord_guild_id },
      zones,
    });
  } catch (err) {
    console.error('❌ /api/admin/zones GET error:', err);
    res.status(500).json({ ok: false, error: 'Failed to load zones' });
  }
});

/** Text channels for the zone output-channel dropdown (admin-scoped). */
router.get('/zones/:serverId/channels', validateServerId, ensureAdmin, async (req, res) => {
  try {
    const server = await resolveAdminServer(req.app.locals.db, req.params.serverId);
    if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });
    const channels = await ZoneService.listGuildChannels(server.discord_guild_id);
    res.json({ ok: true, channels });
  } catch (err) {
    console.error('❌ /api/admin/zones channels error:', err);
    res.status(500).json({ ok: false, error: 'Failed to load channels' });
  }
});

router.post('/zones/:serverId', validateServerId, ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const server = await resolveAdminServer(db, req.params.serverId);
  if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });
  try {
    const zone = await ZoneService.createZone(db, server.id, req.body || {});
    await logAction(db, req.user.id, 'ZONE_CREATED', 'server', server.id, {
      zoneId: zone.id, zoneName: zone.name,
    });
    res.status(201).json({ ok: true, zone });
  } catch (err) {
    if (/must be|unknown|unsupported|Invalid|1-120|non-empty/i.test(err.message)) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('❌ /api/admin/zones POST error:', err);
    res.status(500).json({ ok: false, error: 'Failed to create zone' });
  }
});

router.patch('/zones/:serverId/:zoneId', validateServerId, ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const server = await resolveAdminServer(db, req.params.serverId);
  if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });
  try {
    const zone = await ZoneService.updateZone(db, server.id, req.params.zoneId, req.body || {});
    if (!zone) return res.status(404).json({ ok: false, error: 'Zone not found' });
    await logAction(db, req.user.id, 'ZONE_UPDATED', 'server', server.id, {
      zoneId: zone.id, zoneName: zone.name, sections: Object.keys(req.body || {}),
    });
    res.json({ ok: true, zone });
  } catch (err) {
    if (/must be|unknown|unsupported|Invalid|1-120|non-empty/i.test(err.message)) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('❌ /api/admin/zones PATCH error:', err);
    res.status(500).json({ ok: false, error: 'Failed to update zone' });
  }
});

router.delete('/zones/:serverId/:zoneId', validateServerId, ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const server = await resolveAdminServer(db, req.params.serverId);
  if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });
  try {
    const removed = await ZoneService.deleteZone(db, server.id, req.params.zoneId);
    if (!removed) return res.status(404).json({ ok: false, error: 'Zone not found' });
    await logAction(db, req.user.id, 'ZONE_DELETED', 'server', server.id, {
      zoneId: Number(req.params.zoneId),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ /api/admin/zones DELETE error:', err);
    res.status(500).json({ ok: false, error: 'Failed to delete zone' });
  }
});

/* ═════════════════════════════════════════════════════════════════════════
 * Faction Wars — settlement flag claims. One engine
 * (services/factionClaimService.js), shared with the /faction-war bot
 * command; claim transitions post to the existing faction feed
 * (discord_feeds feed_type='faction_feed', set by /setup-feeds faction).
 * ═══════════════════════════════════════════════════════════════════════ */

const FactionClaimService = require('../services/factionClaimService');

router.get('/faction-war/:serverId', validateServerId, ensureAdmin, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const server = await resolveAdminServer(db, req.params.serverId);
    if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });
    const mapName = req.query.map || 'nasdara';
    const [settlements, factions, state] = await Promise.all([
      FactionClaimService.getSettlementsForServer(db, server.id, mapName),
      FactionClaimService.listFactionsForServer(db, server.id),
      FactionClaimService.getWarState(db, server.id),
    ]);
    res.json({
      ok: true,
      server: { id: server.id, name: server.name, status: server.status, guildId: server.discord_guild_id },
      settlements,
      factions,
      flags: state.flags,
      claims: state.claims,
    });
  } catch (err) {
    console.error('❌ /api/admin/faction-war GET error:', err);
    res.status(500).json({ ok: false, error: 'Failed to load faction war state' });
  }
});

router.post('/faction-war/:serverId/flags', validateServerId, ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const server = await resolveAdminServer(db, req.params.serverId);
  if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });
  try {
    const placed = await FactionClaimService.placeFlag(db, server.id, {
      ...(req.body || {}),
      placedBy: `dashboard:admin:${req.user.id}`,
    });
    if (placed.claimEvent) await FactionClaimService.deliverClaimEvents(db, server.id, [placed.claimEvent]);
    await logAction(db, req.user.id, 'FACTION_FLAG_PLACED', 'server', server.id, {
      flagId: placed.flag.id, settlementId: placed.flag.settlement_id,
      factionId: placed.flag.faction_id,
    });
    res.status(201).json({ ok: true, flag: placed.flag, settlement: placed.settlement, claimEvent: placed.claimEvent });
  } catch (err) {
    if (/must be|between|not found/i.test(err.message)) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('❌ /api/admin/faction-war POST flag error:', err);
    res.status(500).json({ ok: false, error: 'Failed to place flag' });
  }
});

router.delete('/faction-war/:serverId/flags/:flagId', validateServerId, ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const server = await resolveAdminServer(db, req.params.serverId);
  if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });
  try {
    const { removed, claimEvent } = await FactionClaimService.removeFlag(db, server.id, req.params.flagId);
    if (!removed) return res.status(404).json({ ok: false, error: 'Flag not found' });
    if (claimEvent) await FactionClaimService.deliverClaimEvents(db, server.id, [claimEvent]);
    await logAction(db, req.user.id, 'FACTION_FLAG_REMOVED', 'server', server.id, {
      flagId: Number(req.params.flagId),
    });
    res.json({ ok: true, claimEvent });
  } catch (err) {
    console.error('❌ /api/admin/faction-war DELETE flag error:', err);
    res.status(500).json({ ok: false, error: 'Failed to remove flag' });
  }
});

router.post('/faction-war/:serverId/settlements/:settlementId/clear', validateServerId, ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const server = await resolveAdminServer(db, req.params.serverId);
  if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });
  try {
    const mapName = req.query.map || 'nasdara';
    const { removed, claimEvent } = await FactionClaimService.clearSettlementFlags(
      db, server.id, req.params.settlementId, mapName
    );
    if (claimEvent) await FactionClaimService.deliverClaimEvents(db, server.id, [claimEvent]);
    await logAction(db, req.user.id, 'FACTION_SETTLEMENT_CLEARED', 'server', server.id, {
      settlementId: req.params.settlementId, removed,
    });
    res.json({ ok: true, removed, claimEvent });
  } catch (err) {
    console.error('❌ /api/admin/faction-war clear error:', err);
    res.status(500).json({ ok: false, error: 'Failed to clear settlement flags' });
  }
});

module.exports = router;
