'use strict';

/* Bot config API route smoke (routes/admin.js).
 * Mounts the real admin router in a minimal express app with an in-memory
 * fake db (house fakeDb pattern) and a session stub standing in for
 * ensureAuthenticated/ensureAdmin, then hits GET + PUT /api/admin/bot-config/:guildId
 * and checks status codes, response shapes, and the writes that land.
 * Run: node scripts/bot-config-route-test.js */

const assert = require('node:assert/strict');
const http = require('node:http');
const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const express = require('express');
const adminRoutes = require('../routes/admin.js');

const GUILD_ID = '123456789012345678';

// In-memory db over the tables the bot-config routes touch (house fakeDb pattern).
function fakeDb() {
  const tables = {
    guilds: [{ id: 7, name: 'Test Guild', discord_guild_id: GUILD_ID }],
    servers: [{ id: 11, name: 'Chernarus', platform_server_id: '4436', guild_id: 7 }],
    guild_features: [
      { guild_id: 7, feature_name: 'welcome', enabled: 1, config: JSON.stringify({ channel_id: '555', message: 'hi {user}' }) },
    ],
    guild_ai_settings: [],
    reaction_roles: [],
    discord_feeds: [],
    server_features: [],
    player_count_alerts: [],
    server_wipe_info: [],
  };
  const db = {
    __guild_features_rows: tables.guild_features,
    async get(sql, params = []) {
      if (/FROM guilds WHERE discord_guild_id/i.test(sql)) return tables.guilds.find(g => String(g.discord_guild_id) === String(params[0])) || null;
      if (/FROM guild_ai_settings/i.test(sql)) return tables.guild_ai_settings.find(r => r.guild_id === Number(params[0])) || null;
      if (/FROM guild_features/i.test(sql)) {
        const name = sql.match(/feature_name = '([a-z_]+)'/i);
        const featureName = name ? name[1] : params[1];
        return tables.guild_features.find(r => r.guild_id === Number(params[0]) && r.feature_name === featureName) || null;
      }
      return null;
    },
    async all(sql, params = []) {
      if (/FROM servers WHERE guild_id/i.test(sql)) return tables.servers.filter(s => s.guild_id === Number(params[0]));
      if (/FROM guild_features WHERE guild_id/i.test(sql)) return tables.guild_features.filter(r => r.guild_id === Number(params[0]));
      if (/FROM reaction_roles WHERE guild_id/i.test(sql)) return [];
      if (/FROM discord_feeds WHERE guild_id/i.test(sql)) return tables.discord_feeds.filter(r => String(r.guild_id) === String(params[0]) && r.server_id === Number(params[1]));
      if (/FROM server_features WHERE server_id/i.test(sql)) {
        const names = [...sql.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
        return tables.server_features.filter(r => r.server_id === Number(params[0]) && names.includes(r.feature_name));
      }
      if (/FROM player_count_alerts/i.test(sql)) return tables.player_count_alerts.filter(r => String(r.guild_id) === String(params[0]) && r.server_id === Number(params[1]));
      return [];
    },
    async run(sql, params = []) {
      if (/INSERT INTO guild_features/i.test(sql)) {
        const guild = tables.guilds.find(g => String(g.discord_guild_id) === String(params[3]));
        if (!guild) return { changes: 0 };
        const row = tables.guild_features.find(r => r.guild_id === guild.id && r.feature_name === params[0]);
        if (row) { row.enabled = params[1]; row.config = params[2]; }
        else tables.guild_features.push({ guild_id: guild.id, feature_name: params[0], enabled: params[1], config: params[2] });
        return { changes: 1 };
      }
      // everything else (audit log, ai upserts, feeds…) — accept and record
      db.lastRun = { sql, params };
      return { changes: 1, rows: [] };
    },
  };
  return db;
}

function boot() {
  const db = fakeDb();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    // stand-in for express-session + passport (ensureAuthenticated/ensureAdmin)
    req.isAuthenticated = () => true;
    req.user = { id: 1, username: 'testadmin', is_admin: true, platform_role: 'dashboard_admin' };
    req.app.locals.db = db;
    next();
  });
  app.use('/api/admin', adminRoutes);
  return new Promise(resolve => {
    const server = http.createServer(app).listen(0, () => resolve({ server, db }));
  });
}

async function request(server, method, path, body) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function main() {
  const { server, db } = await boot();
  try {
    // GET — full config view
    const get = await request(server, 'GET', `/api/admin/bot-config/${GUILD_ID}`);
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.data.ok, true);
    assert.deepStrictEqual(get.data.config.guild, { dbId: 7, discordGuildId: GUILD_ID, name: 'Test Guild' });
    assert.deepStrictEqual(get.data.config.servers, [{ serverId: 11, name: 'Chernarus', platformServerId: '4436' }]);
    assert.strictEqual(get.data.config.welcome.enabled, true);
    assert.deepStrictEqual(get.data.config.serverConfigs['11'].feeds, {
      killFeed: null,
      factionFeed: null,
      modReports: null,
    });

    // PUT — partial welcome patch writes through to guild_features
    const put = await request(server, 'PUT', `/api/admin/bot-config/${GUILD_ID}`, {
      welcome: { enabled: true, channelId: '777', message: 'yo {username}' },
    });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.data.ok, true);
    assert.deepStrictEqual(put.data.applied, ['welcome → on']);
    const welcome = db && JSON.parse(fakeRows(db).find(r => r.feature_name === 'welcome').config);
    assert.strictEqual(welcome.channel_id, '777');
    assert.strictEqual(welcome.message, 'yo {username}');

    // PUT — validation failures are 400 with the service message
    const bad = await request(server, 'PUT', `/api/admin/bot-config/${GUILD_ID}`, { welcome: { enabled: true, channelId: null } });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.data.error, /channel is required/);

    const unknown = await request(server, 'PUT', `/api/admin/bot-config/${GUILD_ID}`, { bogus: {} });
    assert.strictEqual(unknown.status, 400);
    assert.match(unknown.data.error, /unknown section/);

    // GET — unknown guild is a 404, not a 500
    const missing = await request(server, 'GET', '/api/admin/bot-config/999999999999999999');
    assert.strictEqual(missing.status, 404);

    // param validation: non-numeric guild ids are rejected before hitting the db
    const shaped = await request(server, 'GET', '/api/admin/bot-config/not-a-guild-id');
    assert.strictEqual(shaped.status, 400);

    console.log('✅ bot-config route smoke: GET view, PUT write, 400/404 guards');
  } finally {
    server.close();
  }
}

function fakeRows(db) {
  // the fake keeps guild_features in a closure; reach it through the db handle
  return db.__guild_features_rows;
}

main().catch(err => {
  console.error('❌ bot-config-route-test failed:', err);
  process.exit(1);
});
