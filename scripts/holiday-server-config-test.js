'use strict';

/* Holiday system rework: per-server holiday config (services/holidayConfigService.js).
   - validation: sane windows only (bad dates / start>end / bad missions rejected)
   - persistence: save/apply-defaults/toggle write through the injected db (DB, not JSON on disk)
   - fallback: servers without a row run the default set from public/data/holiday-windows.json
   - window state: live / upcoming / expired
   Run: node scripts/holiday-server-config-test.js */

const assert = require('assert');
const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();
const H = require('../services/holidayConfigService');

/** Fake db over holiday_server_configs (house fakeDb pattern). */
function fakeDb() {
  const db = {
    rows: new Map(),
    allRows: [],
    runs: [],
    key: (guildId, platformServerId) => `${guildId}:${platformServerId}`,
    async get(sql, params = []) {
      if (/FROM holiday_server_configs/i.test(sql)) {
        return db.rows.get(db.key(Number(params[0]), String(params[1]))) || null;
      }
      return null;
    },
    async run(sql, params = []) {
      db.runs.push({ sql, params });
      if (/INSERT INTO holiday_server_configs/i.test(sql)) {
        db.rows.set(db.key(Number(params[0]), String(params[1])), {
          enabled: Boolean(params[3]),
          config: JSON.parse(params[4]),
        });
      }
      return { changes: 1 };
    },
    async all(sql) {
      if (/FROM servers/i.test(sql)) return db.allRows;
      return [];
    },
  };
  return db;
}

const key = { guildId: 7, platformServerId: '4436', platform: 'nitrado' };

function goodConfig() {
  return {
    events: [
      { id: 'christmas', label: 'Christmas', icon: '🎄', missions: ['ChristmasOffline'], windows: [['2026-12-01', '2026-12-24']] },
      { id: 'payday', label: 'Payday', icon: '💰', missions: ['PaydayOffline', 'paydayExtra'], windows: [['2027-01-13', '2027-01-19'], ['2028-01-08', '2028-01-14']] },
    ],
  };
}

function testValidation() {
  assert.strictEqual(H.validateHolidayConfig(goodConfig()), null, 'valid config must pass');

  const bad = (events) => H.validateHolidayConfig({ events });
  assert.match(bad([]), /at least one/i, 'empty events must be rejected');
  assert.match(bad([{ ...goodConfig().events[0], windows: [['2026-12-24', '2026-12-01']] }]), /after/, 'start after end must be rejected');
  assert.match(bad([{ ...goodConfig().events[0], windows: [['2026-02-30', '2026-03-02']] }]), /not a valid/, 'nonexistent calendar day must be rejected');
  assert.match(bad([{ ...goodConfig().events[0], windows: [['2026/12/01', '2026-12-24']] }]), /not a valid/, 'non-ISO date string must be rejected');
  assert.match(bad([{ ...goodConfig().events[0], missions: [] }]), /mission/, 'mission-less event must be rejected');
  assert.match(bad([{ ...goodConfig().events[0], missions: ['bad mission!'] }]), /invalid mission/, 'bad mission name must be rejected');
  assert.match(bad(goodConfig().events.concat(goodConfig().events[0])), /duplicate/i, 'duplicate ids must be rejected');
  assert.match(bad(goodConfig().events.map(e => ({ ...e, id: 'x'.repeat(60) }))), /invalid/, 'overlong id must be rejected');
  assert.match(bad(goodConfig().events.map(e => ({ ...e, windows: [] }))), /window/, 'window-less event must be rejected');
  assert.match(H.validateHolidayConfig({}), /events array/, 'shape check must run first');
}

function testWindowState() {
  const ev = { windows: [['2026-12-01', '2026-12-24'], ['2027-02-12', '2027-02-14']] };
  const at = ymd => new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)), 12, 0, 0).getTime();

  assert.strictEqual(H.eventWindowState(ev, at('2026-12-10')).state, 'live', 'inside a window must be live');
  assert.strictEqual(H.eventWindowState(ev, at('2026-12-01')).state, 'live', 'start day is inclusive');
  assert.strictEqual(H.eventWindowState(ev, at('2026-12-24')).state, 'live', 'end day is inclusive');
  const upcoming = H.eventWindowState(ev, at('2026-06-01'));
  assert.strictEqual(upcoming.state, 'upcoming', 'before all windows must be upcoming');
  assert.deepStrictEqual(upcoming.nextWindow, ['2026-12-01', '2026-12-24']);
  assert.strictEqual(H.eventWindowState(ev, at('2027-06-01')).state, 'expired', 'after all windows must be expired');
}

async function testDefaultFallbackAndPacking() {
  const db = fakeDb();
  const defaults = H.loadDefaultSet();
  assert(defaults.length >= 4, 'default set must carry the standard windows');

  // No row → default set, source 'default', enabled on.
  const view = await H.serverHolidayConfig(db, key.guildId, key.platformServerId);
  assert.strictEqual(view.source, 'default');
  assert.strictEqual(view.enabled, true);
  assert.deepStrictEqual(view.events.map(e => e.id), defaults.map(e => e.id));
  assert(view.events.every(e => e.state && ['live', 'upcoming', 'expired'].includes(e.state.state)), 'states must be attached');

  // Pack helpers: unknown dir → known=false (never a hard reject).
  assert.deepStrictEqual(H.missingPacks('/no/such/dir', [], defaults), { known: false, missing: [] });
  assert.deepStrictEqual(H.listMissionFolders('/no/such/dir'), []);

  // Known dir: prefix match is case-insensitive, per map suffix.
  const folders = ['dayzOffline.ChernarusPlus', 'ChristmasOffline.ChernarusPlus', 'ChristmasOffline.Enoch', 'PaydayOffline.Nasdara'];
  const check = H.missingPacks('/x', folders, goodConfig().events);
  assert.strictEqual(check.known, true);
  assert.deepStrictEqual(check.missing.map(m => m.mission), ['paydayExtra'], 'only the absent pack is missing');
}

async function testPersistence() {
  const db = fakeDb();

  // Save persists a custom config (DB row, not the JSON file on disk).
  const saved = await H.saveServerConfig(db, key, goodConfig(), true);
  assert.strictEqual(saved.length, 2);
  assert(db.rows.has(db.key(key.guildId, key.platformServerId)), 'save must upsert a DB row');
  const after = await H.serverHolidayConfig(db, key.guildId, key.platformServerId);
  assert.strictEqual(after.source, 'server');
  assert.deepStrictEqual(after.events.map(e => e.id), ['christmas', 'payday']);

  // Save rejects bad dates with ValidationError (no row written).
  await assert.rejects(
    H.saveServerConfig(db, key, { events: [{ id: 'x', label: 'X', missions: ['m'], windows: [['2027-01-20', '2027-01-10']] }] }),
    H.ValidationError
  );

  // Disabled toggle persists.
  await H.setEnabled(db, key, false);
  const off = await H.serverHolidayConfig(db, key.guildId, key.platformServerId);
  assert.strictEqual(off.enabled, false, 'toggle must persist disabled state');

  // Applying the default set replaces the custom config and re-enables.
  const applied = await H.applyDefaultSet(db, key);
  assert.deepStrictEqual(applied.map(e => e.id), H.loadDefaultSet().map(e => e.id));
  const reset = await H.serverHolidayConfig(db, key.guildId, key.platformServerId);
  assert.strictEqual(reset.source, 'server');
  assert.strictEqual(reset.enabled, true);

  // Toggle on a server with no row creates one from the default set.
  const fresh = fakeDb();
  await H.setEnabled(fresh, key, false);
  assert(fresh.rows.has(fresh.key(key.guildId, key.platformServerId)), 'toggle must create the row when absent');

  // Per-guild isolation: same platform server id under another guild has no row.
  const other = await H.serverHolidayConfig(db, 99, key.platformServerId);
  assert.strictEqual(other.source, 'default');
}

// ── Route level: real admin router + express, fake auth + fake db (house pattern) ──

function holidayRouteDb() {
  const state = {
    server: { id: 11, guild_id: 7, platform: 'nitrado', platform_server_id: '4436', name: 'nasdara' },
    rows: new Map(),
    allRows: [{
      server_id: 11, guild_id: 7, platform: 'nitrado', platform_server_id: '4436',
      server_name: 'nasdara', discord_guild_id: '9001', guild_name: 'Skrew',
      enabled: null, config: null,
    }],
    audit: [],
  };
  const db = {
    state,
    async get(sql, params = []) {
      if (/FROM servers WHERE id/i.test(sql)) return Number(params[0]) === state.server.id ? state.server : null;
      if (/FROM guilds WHERE id/i.test(sql)) return { discord_guild_id: '9001' };
      if (/FROM holiday_server_configs/i.test(sql)) {
        return state.rows.get(`${params[0]}:${params[1]}`) || null;
      }
      return null;
    },
    async run(sql, params = []) {
      if (/INSERT INTO holiday_server_configs/i.test(sql)) {
        state.rows.set(`${params[0]}:${params[1]}`, { enabled: Boolean(params[3]), config: JSON.parse(params[4]) });
        state.allRows[0].enabled = Boolean(params[3]);
        state.allRows[0].config = JSON.parse(params[4]);
        return { changes: 1 };
      }
      if (/INSERT INTO audit_log/i.test(sql)) {
        state.audit.push(params[1]);
        return { changes: 1 };
      }
      return { changes: 0 };
    },
    async all(sql) {
      if (/FROM servers/i.test(sql)) {
        for (const row of state.allRows) row.config = state.rows.get(`${row.guild_id}:${row.platform_server_id}`) || null;
        return state.allRows;
      }
      return [];
    },
  };
  return db;
}

async function testRoutes() {
  const express = require('express');
  const http = require('http');
  const router = require('../routes/admin');
  const db = holidayRouteDb();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isAuthenticated = () => true;
    req.user = { id: 1, username: 'admin-probe', is_admin: true };
    req.app.locals.db = db;
    next();
  });
  app.use('/api/admin', router);

  const request = (method, urlPath, body) => new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const r = http.request({
        host: '127.0.0.1', port: server.address().port, method, path: urlPath,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); }
          catch (e) { reject(e); }
        });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  });

  // List: row-less server surfaces the default set.
  const list = await request('GET', '/api/admin/holiday-events');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.ok, true);
  assert.strictEqual(list.body.defaults.length, H.loadDefaultSet().length);
  assert.strictEqual(list.body.servers[0].source, 'default');
  assert.strictEqual(list.body.servers[0].events.length, H.loadDefaultSet().length);

  // Detail: packs unknown (no download dir) but default set intact.
  const detail = await request('GET', '/api/admin/holiday-events/11');
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.body.config.source, 'default');
  assert.strictEqual(detail.body.packs.known, false);

  // Save rejects bad dates with 400 and writes nothing.
  const bad = await request('PUT', '/api/admin/holiday-events/11', {
    events: [{ id: 'x', label: 'X', missions: ['m'], windows: [['2027-01-20', '2027-01-10']] }],
  });
  assert.strictEqual(bad.status, 400, `bad dates must be rejected, got ${bad.status}: ${bad.body && bad.body.error}`);
  assert(db.state.rows.size === 0, 'rejected save must not persist a row');

  // Valid save succeeds (pack check skips when the server has no download dir yet).
  const good = {
    events: [
      { id: 'christmas', label: 'Christmas', missions: ['ChristmasOffline'], windows: [['2026-12-01', '2026-12-24']] },
    ],
  };
  const saved = await request('PUT', '/api/admin/holiday-events/11', { events: good.events });
  assert.strictEqual(saved.status, 200, `valid save must succeed: ${saved.body && saved.body.error}`);
  assert(db.state.rows.has('7:4436'), 'save must persist a DB row');

  // Toggle persists.
  const toggle = await request('POST', '/api/admin/holiday-events/11/toggle', { enabled: false });
  assert.strictEqual(toggle.status, 200);
  assert.strictEqual(toggle.body.enabled, false);
  const row = db.state.rows.get('7:4436');
  assert.strictEqual(row.enabled, false, 'toggle must persist in the DB row');

  // Apply defaults replaces config and re-enables.
  const applied = await request('POST', '/api/admin/holiday-events/11/apply-defaults');
  assert.strictEqual(applied.status, 200);
  assert.strictEqual(applied.body.events.length, H.loadDefaultSet().length);
  assert.strictEqual(db.state.rows.get('7:4436').enabled, true);

  // Unknown / malformed server ids → 404, never 500.
  assert.strictEqual((await request('GET', '/api/admin/holiday-events/999')).status, 404);
  assert.strictEqual((await request('PUT', '/api/admin/holiday-events/abc', { events: good.events })).status, 404);

  // Mutations are audited.
  assert(db.state.audit.includes('HOLIDAY_CONFIG_SAVED'), 'save must write an audit entry');
  assert(db.state.audit.includes('HOLIDAY_DEFAULTS_APPLIED'), 'apply-defaults must write an audit entry');
  assert(db.state.audit.includes('HOLIDAY_DISABLED'), 'toggle must write an audit entry');
}

async function testListShape() {
  const db = fakeDb();
  await H.saveServerConfig(db, key, goodConfig(), true);
  const row = {
    server_id: 11, guild_id: key.guildId, platform: 'nitrado', platform_server_id: key.platformServerId,
    server_name: 'nasdara', discord_guild_id: '9001', guild_name: 'Skrew',
    enabled: true, config: JSON.parse(JSON.stringify({ events: goodConfig().events })),
  };
  const noRow = {
    server_id: 12, guild_id: key.guildId, platform: 'nitrado', platform_server_id: '4437',
    server_name: 'sakhal', discord_guild_id: '9001', guild_name: 'Skrew',
    enabled: null, config: null,
  };
  db.allRows = [row, noRow];
  const list = await H.listServerHolidayConfigs(db);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].serverId, 11);
  assert.strictEqual(list[0].source, 'server');
  assert.strictEqual(list[0].enabled, true);
  assert.strictEqual(list[1].source, 'default');
  assert.strictEqual(list[1].enabled, true);
  assert.strictEqual(list[1].events.length, H.loadDefaultSet().length, 'row-less server lists the default set');
}

async function main() {
  testValidation();
  testWindowState();
  await testDefaultFallbackAndPacking();
  await testPersistence();
  await testListShape();
  await testRoutes();
  console.log('✅ holiday-server-config-test: validation, window state, default fallback, DB persistence, listing, routes OK');
}

main().catch(err => {
  console.error('❌ holiday-server-config-test failed:', err);
  process.exit(1);
});
