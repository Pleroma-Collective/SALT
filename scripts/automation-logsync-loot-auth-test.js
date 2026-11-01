'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();
const { encryptToken } = require('../utils/encryption');

const root = path.join(__dirname, '..');
const compact = value => value.replace(/\s+/g, ' ');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function handlerFor(router, routePath, method) {
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} route must exist`);
  return layer.route.stack.at(-1).handle;
}

// The automation route captures performLogSync / scanLogsForServer bindings at
// module load, so the Nitrado download + log scan pipeline must be stubbed
// BEFORE routes/automation is first required. The stubs only affect the
// /sync-now happy path; every other test in this file returns before them.
const logSyncService = require('../services/logSyncService');
const logScanService = require('../services/logScanService');
const syncNowInvocations = [];
logSyncService.performLogSync = async (db, userId, token, serverIds) => {
  syncNowInvocations.push({ userId, token, serverIds });
  return {
    totalFilesDownloaded: 1,
    totalFilesUpdated: 1,
    totalFilesSkipped: 0,
    errors: [],
    blockingErrors: [],
    failedServerIds: [],
    parseBlockedServerIds: [],
    rptBlockedServerIds: [],
    restartEvidence: {},
  };
};
logScanService.scanLogsForServer = async () => ({ onlineCachePublished: false });

function activeServerRow(id) {
  return {
    server_status: 'active',
    guild_status: 'approved',
    token_id: 1,
    nitrado_user_id: 'nitrado-user',
    guild_role: 'owner',
  };
}

async function testDiagnoseSyncServerAccessClassifiesEveryFailureMode() {
  const { diagnoseSyncServerAccess } = require('../services/logSyncService');
  const rows = {
    '101': activeServerRow(),
    '102': { ...activeServerRow(), server_status: 'inactive' },
    '103': { ...activeServerRow(), guild_status: 'disabled' },
    '104': { ...activeServerRow(), token_id: null, nitrado_user_id: null },
    '105': { ...activeServerRow(), guild_role: 'member' },
    '106': { ...activeServerRow(), guild_role: 'member', sra_admin: true },
  };
  const db = {
    query: async (_sql, params) => {
      const id = String(params[2]);
      if (id === '108') return [rows['101'], rows['101']];
      return rows[id] ? [rows[id]] : [];
    },
  };

  const result = await diagnoseSyncServerAccess(db, 900, ['101', '102', '103', '104', '105', '106', '107', '108']);
  const byId = new Map(result.map(d => [d.serverId, d.reason]));

  assert.strictEqual(byId.get('101'), 'operational');
  assert.strictEqual(byId.get('102'), 'inactive');
  assert.strictEqual(byId.get('103'), 'guild_disabled');
  assert.strictEqual(byId.get('104'), 'no_token');
  assert.strictEqual(byId.get('105'), 'unauthorized');
  assert.strictEqual(byId.get('106'), 'operational', 'an assigned server admin must be operational');
  assert.strictEqual(byId.get('107'), 'unknown');
  assert.strictEqual(byId.get('108'), 'ambiguous');
}

async function testLogSyncDropsStaleInactiveServersButSavesOperationalOnes() {
  const router = require('../routes/automation');
  const handler = handlerFor(router, '/log-sync', 'post');
  let savedSettings;
  const tokenHash = encryptToken('account-a');
  const req = {
    user: { id: 507, is_admin: false },
    body: { enabled: true, interval: 15, autoScan: true, servers: ['900', '800'] },
    app: { locals: { db: {
      get: async (sql, params) => {
        if (sql.includes('AS server_status')) {
          return String(params[2]) === '900'
            ? { ...activeServerRow(), server_status: 'inactive' }
            : activeServerRow();
        }
        return String(params[1]) === '800'
          ? { id: 41, platform_server_id: 800, discord_guild_id: 'guild-800', token_hash: tokenHash }
          : null;
      },
      run: async (_sql, params) => { savedSettings = JSON.parse(params[1]); },
    } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body.skippedServers, [
    { serverId: '900', reason: 'inactive', detail: 'server is inactive' },
  ]);
  assert.deepStrictEqual(savedSettings.servers, ['800'], 'only the operable server may be persisted');
}

async function testLogSyncReportsBlockingGuildDisabledServers() {
  const router = require('../routes/automation');
  const handler = handlerFor(router, '/log-sync', 'post');
  let writes = 0;
  const req = {
    user: { id: 509, is_admin: false },
    body: { enabled: true, interval: 15, autoScan: true, servers: ['900'] },
    app: { locals: { db: {
      get: async (sql, params) => {
        if (sql.includes('AS server_status')) {
          return { ...activeServerRow(), guild_status: 'disabled' };
        }
        return null;
      },
      run: async () => { writes += 1; },
    } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.success, false);
  assert.deepStrictEqual(res.body.servers, [
    { serverId: '900', reason: 'guild_disabled', detail: 'guild is disabled' },
  ]);
  assert.strictEqual(writes, 0, 'a disabled-guild server must never be persisted');
}

async function testSyncNowDropsStaleServersHealsConfigAndSyncsOperationalOnes() {
  const router = require('../routes/automation');
  const handler = handlerFor(router, '/sync-now', 'post');
  const tokenHash = encryptToken('account-a');
  const settingsUpdates = [];
  const req = {
    user: { id: 508, is_admin: false },
    app: { locals: { db: {
      get: async (sql, params) => {
        if (sql.includes('automation_settings')) {
          return { auto_log_sync: JSON.stringify({
            enabled: true,
            interval: 15,
            autoScan: true,
            servers: ['900', '800'],
            lastRun: null,
          }) };
        }
        if (sql.includes('clock_timestamp')) return { observed_at: new Date().toISOString() };
        if (sql.includes('AS server_status')) {
          return String(params[2]) === '900'
            ? { ...activeServerRow(), server_status: 'inactive' }
            : activeServerRow();
        }
        return String((params && params[1]) || '') === '800'
          ? { id: 41, platform_server_id: 800, discord_guild_id: 'guild-800', token_hash: tokenHash }
          : null;
      },
      run: async (sql, params) => {
        if (sql.includes('automation_settings')) settingsUpdates.push(JSON.parse(params[0]));
      },
    } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body.skippedServers, [
    { serverId: '900', reason: 'inactive', detail: 'server is inactive' },
  ]);
  assert.ok(settingsUpdates.length >= 1, 'the healed config must be persisted');
  assert.deepStrictEqual(settingsUpdates[0].servers, ['800'], 'stale servers are removed from the saved config');
  assert.strictEqual(syncNowInvocations.length, 1);
  assert.deepStrictEqual(syncNowInvocations[0].serverIds, ['800'], 'only operable servers may be synced');
  assert.strictEqual(syncNowInvocations[0].token, 'account-a');
}

async function testAutomationRejectsCrossTenantServerBeforeSaving() {
  const router = require('../routes/automation');
  const handler = handlerFor(router, '/log-sync', 'post');
  let writes = 0;
  const queries = [];
  const req = {
    user: { id: 501, is_admin: true },
    body: { enabled: true, interval: 15, autoScan: true, servers: ['foreign-service'] },
    app: { locals: { db: {
      get: async (sql, params) => { queries.push({ sql: compact(sql), params }); return null; },
      run: async () => { writes += 1; },
    } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(writes, 0, 'unauthorized client server IDs must never be persisted');
  assert.ok(queries.some(query => query.sql.includes('guild_roles') && query.params.includes('foreign-service')));
  assert.ok(queries.every(query => !query.sql.includes('u.is_admin')));
}

async function testAutomationPersistsOnlyCanonicalAuthorizedServerIds() {
  const router = require('../routes/automation');
  const handler = handlerFor(router, '/log-sync', 'post');
  let savedSettings;
  const req = {
    user: { id: 505, is_admin: false },
    body: { enabled: true, interval: 15, autoScan: false, servers: ['000123', '000123'] },
    app: { locals: { db: {
      get: async () => ({ platform_server_id: 123, discord_guild_id: 'guild-a', token_hash: encryptToken('account-a') }),
      run: async (sql, params) => { savedSettings = JSON.parse(params[1]); },
    } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(savedSettings.servers, ['123']);
}

async function testAutomationRejectsMixedProviderTokensBeforeSaving() {
  const router = require('../routes/automation');
  const handler = handlerFor(router, '/log-sync', 'post');
  let writes = 0;
  const encryptedTokens = {
    '101': encryptToken('account-a'),
    '202': encryptToken('account-b'),
  };
  const req = {
    user: { id: 506, is_admin: false },
    body: { enabled: true, interval: 15, autoScan: true, servers: ['101', '202'] },
    app: { locals: { db: {
      get: async (_sql, params) => ({
        platform_server_id: params[1],
        discord_guild_id: `guild-${params[1]}`,
        token_hash: encryptedTokens[String(params[1])],
      }),
      run: async () => { writes += 1; },
    } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.success, false);
  assert.match(res.body.error, /same Nitrado account/i);
  assert.strictEqual(writes, 0);
}

async function testSyncNowReauthorizesSavedServersBeforeUsingCredentials() {
  const router = require('../routes/automation');
  const handler = handlerFor(router, '/sync-now', 'post');
  const queries = [];
  const req = {
    user: { id: 504, is_admin: true },
    app: { locals: { db: {
      get: async (sql, params) => {
        queries.push({ sql: compact(sql), params });
        if (sql.includes('automation_settings')) {
          return { auto_log_sync: JSON.stringify({ servers: ['foreign-saved-service'], autoScan: false }) };
        }
        return null;
      },
      run: async () => { throw new Error('unauthorized sync must not update settings'); },
    } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.ok(queries.some(query => query.sql.includes('guild_roles') && query.params.includes('foreign-saved-service')));
  assert.ok(queries.every(query => !query.sql.includes('u.is_admin')));
}

async function testOperationalCredentialsRequireExactServerOperatorRole() {
  const { getDecryptedToken } = require('../services/logSyncService');
  let captured;
  const db = { get: async (sql, params) => {
    captured = { sql: compact(sql), params };
    return null;
  } };

  const token = await getDecryptedToken(db, 502, ['foreign-service']);

  assert.strictEqual(token, null);
  assert.ok(captured.sql.includes("gr.role IN ('owner', 'admin')"));
  assert.ok(captured.sql.includes('server_role_assignments'));
  assert.ok(captured.sql.includes("sra.role = 'admin'"));
  assert.ok(captured.sql.includes("s.status = 'active'"));
  assert.ok(captured.sql.includes('CAST(s.platform_server_id AS TEXT) = ?'));
  assert.doesNotMatch(captured.sql, /u\.is_admin/);
  assert.deepStrictEqual(captured.params, [502, 'foreign-service', 502]);
}

async function testLootResolutionRequiresExactServerMembershipWithoutAdminBypass() {
  const { resolveGuildDiscordId } = require('../services/logSyncService');
  let captured;
  const db = { get: async (sql, params) => {
    captured = { sql: compact(sql), params };
    return null;
  } };

  const guildId = await resolveGuildDiscordId(db, 503, 'foreign-service');

  assert.strictEqual(guildId, null);
  assert.ok(captured.sql.includes('LEFT JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = ?'));
  assert.ok(captured.sql.includes('server_role_assignments'));
  assert.ok(captured.sql.includes("s.status = 'active'"));
  assert.ok(captured.sql.includes('CAST(s.platform_server_id AS TEXT) = ?'));
  assert.doesNotMatch(captured.sql, /u\.is_admin/);
  assert.deepStrictEqual(captured.params, [503, 'foreign-service', 503]);
}

async function testCanonicalLogPathResolutionAllowsAssignedServerAdmin() {
  const { resolveGuildDiscordId } = require('../services/logSyncService');
  let captured;
  const db = { get: async (sql, params) => {
    captured = { sql: compact(sql), params };
    return { discord_guild_id: 'guild-a' };
  } };

  assert.strictEqual(await resolveGuildDiscordId(db, 503, 'service-a'), 'guild-a');
  assert.ok(captured.sql.includes('server_role_assignments'));
  assert.ok(captured.sql.includes("sra.role = 'admin'"));
  assert.ok(captured.sql.includes("sra.status = 'active'"));
  assert.deepStrictEqual(captured.params, [503, 'service-a', 503]);
}

async function testLootRouteDeniesCrossTenantGlobalAdminBeforeReadingLoot() {
  const router = require('../routes/lootFinder');
  const handler = handlerFor(router, '/categories', 'get');
  let captured;
  const req = {
    user: { id: 506, is_admin: true },
    query: { serverId: 'foreign-service' },
    app: { locals: { db: { get: async (sql, params) => {
      captured = { sql: compact(sql), params };
      return null;
    } } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 404);
  assert.doesNotMatch(captured.sql, /u\.is_admin/);
  assert.deepStrictEqual(captured.params, [506, 'foreign-service', 506]);
}

function testSyncImplementationsReauthorizeEveryServerAsOperator() {
  const source = fs.readFileSync(path.join(root, 'services/logSyncService.js'), 'utf8');
  const legacyStart = source.indexOf('async function performLogSync(');
  const concurrentStart = source.indexOf('async function performLogSyncConcurrent(');
  const exportsStart = source.indexOf('module.exports', concurrentStart);
  assert.match(source.slice(legacyStart, concurrentStart), /resolveOperationalServer\w*\(db, userId, serverId, token\)/);
  assert.match(source.slice(concurrentStart, exportsStart), /resolveOperationalServer\w*\(db, userId, serverId, token\)/);
}

function testOrdinaryMountsDoNotGrantGlobalAdminTenantBypass() {
  const routeRegistration = fs.readFileSync(path.join(root, 'src/app/registerRoutes.js'), 'utf8');
  const serverAccess = fs.readFileSync(path.join(root, 'middleware/serverAccess.js'), 'utf8');
  const start = serverAccess.indexOf('async function ensureApproved');
  const end = serverAccess.indexOf('async function ensurePlayerApproved', start);
  assert.ok(routeRegistration.includes("app.use('/api/loot', ensureAuthenticated, ensureApproved, lootFinderRoutes)"));
  assert.doesNotMatch(serverAccess.slice(start, end), /is_admin/);
}

async function testAssignedAdminCanReachLogAndAutomationSurfaces() {
  const { ensureHasOperableServers } = require('../middleware/serverAccess');
  let captured;
  const req = {
    user: { id: 77, username: 'assigned-admin' },
    isAuthenticated: () => true,
    originalUrl: '/logs',
    app: { locals: { db: { get: async (sql, params) => {
      captured = { sql: compact(sql), params };
      return { id: 42 };
    } } } },
  };
  const res = responseRecorder();
  res.redirect = location => { res.redirectLocation = location; return res; };
  let nextCalled = false;

  await ensureHasOperableServers(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.match(captured.sql, /server_role_assignments/);
  assert.match(captured.sql, /sra\.status = 'active'/);
  assert.match(captured.sql, /s\.status = 'active'/);
  assert.match(captured.sql, /g\.status = 'approved'/);
  assert.deepStrictEqual(captured.params, [77, 77]);

  const routeRegistration = fs.readFileSync(path.join(root, 'src/app/registerRoutes.js'), 'utf8');
  assert.match(routeRegistration, /app\.use\('\/api\/automation', ensureAuthenticated, ensureHasOperableServers, automationRoutes\)/);
  assert.match(routeRegistration, /app\.get\('\/dashboard\/automation',[\s\S]{0,100}ensureHasOperableServers/);
  assert.match(routeRegistration, /app\.get\('\/logs',[\s\S]{0,100}ensureHasOperableServers/);
}

async function main() {
  await testDiagnoseSyncServerAccessClassifiesEveryFailureMode();
  await testLogSyncDropsStaleInactiveServersButSavesOperationalOnes();
  await testLogSyncReportsBlockingGuildDisabledServers();
  await testSyncNowDropsStaleServersHealsConfigAndSyncsOperationalOnes();
  await testAutomationRejectsCrossTenantServerBeforeSaving();
  await testAutomationPersistsOnlyCanonicalAuthorizedServerIds();
  await testAutomationRejectsMixedProviderTokensBeforeSaving();
  await testSyncNowReauthorizesSavedServersBeforeUsingCredentials();
  await testOperationalCredentialsRequireExactServerOperatorRole();
  await testLootResolutionRequiresExactServerMembershipWithoutAdminBypass();
  await testCanonicalLogPathResolutionAllowsAssignedServerAdmin();
  await testLootRouteDeniesCrossTenantGlobalAdminBeforeReadingLoot();
  testSyncImplementationsReauthorizeEveryServerAsOperator();
  testOrdinaryMountsDoNotGrantGlobalAdminTenantBypass();
  await testAssignedAdminCanReachLogAndAutomationSurfaces();
  console.log('✅ Automation, log-sync, and loot tenant authorization tests passed');
}

main().catch(error => {
  console.error(`❌ ${error.stack || error.message}`);
  process.exit(1);
});
