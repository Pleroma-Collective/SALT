'use strict';

/* Keep-Alive tests (bot/services/serverKeepAliveService.js + services/botConfigService.js):
 *   1. keepAliveDecision — 15m cooldown and 3-attempts/rolling-hour window
 *   2. maybeKeepAlive gating — suspended, degraded, missing owner: no control call
 *   3. Restart-storm simulation — in-memory journal, 5-minute monitor ticks:
 *      crash loop fires exactly one auto-start per cooldown, and never more
 *      than MAX_ATTEMPTS_PER_WINDOW inside a rolling hour
 *   4. bot-config keepAlive section — load view + apply upsert via fake db
 * Run: node scripts/keep-alive-test.js
 */

const assert = require('node:assert/strict');
const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const {
  keepAliveDecision,
  maybeKeepAlive,
  COOLDOWN_MS,
  WINDOW_MS,
  MAX_ATTEMPTS_PER_WINDOW,
} = require('../bot/services/serverKeepAliveService');
const BotConfig = require('../services/botConfigService');

const T0 = Date.parse('2026-10-24T12:00:00Z');
const MIN = 60 * 1000;
const offline = { state: 'offline', detail: 'offline' };

// ── 1. keepAliveDecision ─────────────────────────────────────────────────────
assert.equal(keepAliveDecision({ lastKeepAliveAt: null, keepAliveAttemptsInWindow: 0, nowMs: T0 }).allowed, true, 'fresh server: allowed');
assert.deepEqual(
  keepAliveDecision({ lastKeepAliveAt: new Date(T0), keepAliveAttemptsInWindow: 1, nowMs: T0 + 10 * MIN }),
  { allowed: false, reason: 'cooldown' }, 'within 15m: cooldown'
);
assert.deepEqual(
  keepAliveDecision({ lastKeepAliveAt: new Date(T0), keepAliveAttemptsInWindow: 1, nowMs: T0 + COOLDOWN_MS }),
  { allowed: true }, 'cooldown boundary (exactly 15m): allowed'
);
assert.deepEqual(
  keepAliveDecision({ lastKeepAliveAt: null, keepAliveAttemptsInWindow: MAX_ATTEMPTS_PER_WINDOW, nowMs: T0 }),
  { allowed: false, reason: 'window_exhausted' }, `${MAX_ATTEMPTS_PER_WINDOW} in window: exhausted`
);
assert.equal(keepAliveDecision({ lastKeepAliveAt: null, keepAliveAttemptsInWindow: 2, nowMs: T0 }).allowed, true, '2 in window: still allowed');
console.log('✓ keepAliveDecision');

// ── 2. maybeKeepAlive gating ─────────────────────────────────────────────────
function gatingFixture() {
  const controlCalls = [];
  const deps = {
    control: async (args) => { controlCalls.push(args); return { operationId: '900', message: 'start initiated' }; },
    journal: async () => ({ lastKeepAliveAt: null, keepAliveAttemptsInWindow: 0 }),
    db: { query: async () => ({ rows: [] }) }, // guild_ai_settings → no ops-alert channel
    nowMs: T0,
  };
  const client = { channels: { fetch: async () => null } };
  const server = {
    server_id: 11, guild_id: 7, discord_guild_id: '123456789012345678',
    name: 'Chernarus', keep_alive_actor_id: 42,
  };
  return { client, server, deps, controlCalls };
}

(async () => {
  // suspended service: never restarted
  {
    const { client, server, deps, controlCalls } = gatingFixture();
    await maybeKeepAlive(client, server, { status: 'suspended' }, offline, deps);
    assert.equal(controlCalls.length, 0, 'suspended service is not restarted');
  }
  // still starting (crash-recovery in progress): not restarted
  {
    const { client, server, deps, controlCalls } = gatingFixture();
    await maybeKeepAlive(client, server, { status: 'restarting' }, { state: 'degraded', detail: 'starting' }, deps);
    assert.equal(controlCalls.length, 0, 'degraded/starting server is not restarted');
  }
  // provider unreachable (game_server unknown): not restarted
  {
    const { client, server, deps, controlCalls } = gatingFixture();
    await maybeKeepAlive(client, server, null, { state: 'unknown', detail: 'unknown' }, deps);
    assert.equal(controlCalls.length, 0, 'provider status unknown is not restarted');
  }
  // no guild owner row: skip, no control call
  {
    const { client, server, deps, controlCalls } = gatingFixture();
    server.keep_alive_actor_id = null;
    await maybeKeepAlive(client, server, { status: 'stopped' }, offline, deps);
    assert.equal(controlCalls.length, 0, 'missing owner row skips the auto-start');
  }
  // healthy crash: durable start mutation with system trigger
  {
    const { client, server, deps, controlCalls } = gatingFixture();
    await maybeKeepAlive(client, server, { status: 'stopped' }, offline, deps);
    assert.equal(controlCalls.length, 1, 'crashed server triggers one auto-start');
    assert.equal(controlCalls[0].action, 'start');
    assert.equal(controlCalls[0].triggeredBy, 'system:keep_alive', 'journal row is attributed to the keep-alive system');
    assert.equal(controlCalls[0].actor.id, 42, 'mutation runs under the guild owner authority');
  }
  console.log('✓ maybeKeepAlive gating');

  // ── 3. Restart-storm simulation ────────────────────────────────────────────
  // In-memory journal (1h rolling window) + monitor ticks every 5 minutes
  // against a server that keeps crashing. The auto-start must not storm.
  {
    const journalRows = []; // timestamps of journaled auto-starts
    let controlCalls = 0;
    const depsFor = (nowMs) => ({
      control: async () => { controlCalls += 1; journalRows.push(nowMs); return { operationId: String(controlCalls) }; },
      journal: async () => {
        const inWindow = journalRows.filter(at => nowMs - at < WINDOW_MS);
        return {
          lastKeepAliveAt: inWindow.length ? new Date(Math.max(...inWindow)) : null,
          keepAliveAttemptsInWindow: inWindow.length,
        };
      },
      db: { query: async () => ({ rows: [] }) },
      nowMs,
    });
    const client = { channels: { fetch: async () => null } };
    const server = {
      server_id: 11, guild_id: 7, discord_guild_id: '123456789012345678',
      name: 'Chernarus', keep_alive_actor_id: 42,
    };
    const tick = async (offsetMin) => {
      const now = T0 + offsetMin * MIN;
      await maybeKeepAlive(client, server, { status: 'stopped' }, offline, depsFor(now));
      return controlCalls;
    };

    assert.equal(await tick(0), 1, 'first crash: auto-start fires');
    assert.equal(await tick(5), 1, '+5m: cooldown holds (no second start)');
    assert.equal(await tick(10), 1, '+10m: cooldown still holds');
    assert.equal(await tick(20), 2, '+20m: cooldown elapsed, second start allowed');
    assert.equal(await tick(35), 3, '+35m: third start allowed');
    assert.equal(await tick(50), 3, '+50m: window exhausted — storm protected');
    assert.equal(await tick(59), 3, '+59m: still exhausted at the window edge');
    assert.equal(await tick(61), 4, '+61m: window slid past the first attempt, recovery allowed');

    assert.ok(controlCalls <= 4, 'storm simulation bounded');
    assert.equal(journalRows.length, 4, 'journal holds exactly the fired auto-starts');
    console.log('✓ restart-storm protection');
  }

  // ── 4. bot-config keepAlive section ────────────────────────────────────────
  {
    const GUILD_ID = '123456789012345678';
    const tables = {
      guilds: [{ id: 7, name: 'Test Guild', discord_guild_id: GUILD_ID }],
      servers: [{ id: 11, name: 'Chernarus', platform_server_id: '4436', guild_id: 7 }],
      guild_features: [],
      guild_ai_settings: [],
      reaction_roles: [],
      discord_feeds: [],
      server_features: [],
      player_count_alerts: [],
      server_wipe_info: [],
    };
    const db = {
      async get(sql, params = []) {
        if (/FROM guilds WHERE discord_guild_id/i.test(sql)) {
          return tables.guilds.find(g => String(g.discord_guild_id) === String(params[0])) || null;
        }
        return null;
      },
      async all(sql, params = []) {
        if (/FROM servers WHERE guild_id/i.test(sql)) return tables.servers.filter(s => s.guild_id === Number(params[0]));
        if (/FROM server_features WHERE server_id/i.test(sql)) {
          const names = [...sql.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
          return tables.server_features.filter(r => r.server_id === Number(params[0]) && names.includes(r.feature_name));
        }
        return [];
      },
      async run(sql, params = []) {
        if (/INSERT INTO server_features/i.test(sql)) {
          const row = tables.server_features.find(r => r.server_id === Number(params[0]) && r.feature_name === 'keep_alive');
          if (row) row.enabled = params[1];
          else tables.server_features.push({ server_id: Number(params[0]), feature_name: 'keep_alive', enabled: params[1], config: null });
          return { changes: 1 };
        }
        return { changes: 1 };
      },
    };

    // default view: disabled
    let view = (await BotConfig.loadBotConfig(db, GUILD_ID)).serverConfigs['11'];
    assert.deepEqual(view.keepAlive, { enabled: false }, 'keepAlive defaults to off');

    // enable
    let applied = await BotConfig.applyBotConfig(db, GUILD_ID, { servers: { '11': { keepAlive: { enabled: true } } } });
    assert.ok(applied.some(line => line === 'keep_alive → on'), `applied reports enable: ${applied.join('; ')}`);
    assert.equal(tables.server_features.find(r => r.feature_name === 'keep_alive').enabled, 1, 'server_features row upserted on');

    // view reflects the toggle
    view = (await BotConfig.loadBotConfig(db, GUILD_ID)).serverConfigs['11'];
    assert.deepEqual(view.keepAlive, { enabled: true }, 'loadBotConfig reflects keepAlive on');

    // disable (same row, no duplicate)
    applied = await BotConfig.applyBotConfig(db, GUILD_ID, { servers: { '11': { keepAlive: { enabled: false } } } });
    assert.ok(applied.some(line => line === 'keep_alive → off'), 'applied reports disable');
    assert.equal(tables.server_features.filter(r => r.feature_name === 'keep_alive').length, 1, 'single keep_alive row after toggle off');
    assert.equal(tables.server_features.find(r => r.feature_name === 'keep_alive').enabled, 0, 'row flipped off');

    // validation: non-object section rejected
    await assert.rejects(
      () => BotConfig.applyBotConfig(db, GUILD_ID, { servers: { '11': { keepAlive: 'yes' } } }),
      err => err.status === 400, 'non-object keepAlive rejected'
    );
    console.log('✓ bot-config keepAlive section');
  }

  console.log(`\n✅ keep-alive tests passed (cooldown ${COOLDOWN_MS / MIN}m, max ${MAX_ATTEMPTS_PER_WINDOW}/h, window ${WINDOW_MS / MIN}m)`);
})().catch(err => {
  console.error('❌ keep-alive test failed:', err);
  process.exit(1);
});
