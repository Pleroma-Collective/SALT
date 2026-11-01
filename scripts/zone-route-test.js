'use strict';

/* Activity-zone API route smoke (routes/admin.js /api/admin/zones).
 * Mounts the real admin router in a minimal express app with an in-memory fake
 * db (house fakeDb pattern) and a session stub standing in for
 * ensureAuthenticated/ensureAdmin, then exercises the zone CRUD routes, the
 * server-resolution guard, param validation, and the admin guard, and checks
 * status codes / response shapes / the writes that land.
 *
 * The channels picker fetches live Discord channels via a bot token, so only
 * its guard paths (server 404 / no-token 500) are asserted here — the fetch
 * itself is the shared fetchGuildChannels used by bot-config + feeds.
 * Run: node scripts/zone-route-test.js */

const assert = require('node:assert/strict');
const http = require('node:http');
const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const express = require('express');
const adminRoutes = require('../routes/admin.js');

const GUILD_ID = '123456789012345678';
const SERVER_ID = 11;
const CHANNEL_ID = '999888777';

function fakeDb() {
  const tables = {
    activity_zones: [
      {
        id: 1, server_id: SERVER_ID, name: 'Old Zone', map_name: 'nasdara',
        center_x: 500, center_z: 500, radius_m: 200,
        activity_filters: '["kill"]', channel_id: CHANNEL_ID,
        min_interval_seconds: 120, enabled: 1,
        last_checked_at: new Date().toISOString(), last_posted_at: null, last_post_count: 0,
      },
    ],
  };
  let nextZoneId = 2;
  const norm = sql => sql.replace(/\s+/g, ' ').trim();
  const db = {
    __zones: tables.activity_zones,
    async get(sql, params = []) {
      const s = norm(sql);
      // resolveAdminServer: approved server -> (id, name, status, guild ids)
      if (/FROM servers s JOIN guilds g ON g\.id = s\.guild_id WHERE s\.id = \? AND g\.status = 'approved'/.test(s)) {
        return Number(params[0]) === SERVER_ID
          ? { id: SERVER_ID, name: 'Chernarus', status: 'online', guild_db_id: 7, discord_guild_id: GUILD_ID }
          : null;
      }
      if (/FROM activity_zones WHERE id = \? AND server_id = \?/.test(s)) {
        return tables.activity_zones.find(z => z.id === Number(params[0]) && z.server_id === Number(params[1])) || null;
      }
      if (/INSERT INTO activity_zones/.test(s)) {
        const row = {
          id: nextZoneId++,
          server_id: Number(params[0]), name: params[1], map_name: params[2],
          center_x: Number(params[3]), center_z: Number(params[4]), radius_m: Number(params[5]),
          activity_filters: params[6], channel_id: params[7],
          min_interval_seconds: Number(params[8]), enabled: params[9],
          last_checked_at: new Date().toISOString(), last_posted_at: null, last_post_count: 0,
        };
        tables.activity_zones.push(row);
        return row;
      }
      return null;
    },
    async query(sql, params = []) {
      const s = norm(sql);
      if (/FROM activity_zones WHERE server_id = \? ORDER BY name/.test(s)) {
        return tables.activity_zones
          .filter(z => z.server_id === Number(params[0]))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      }
      return [];
    },
    async run(sql, params = []) {
      const s = norm(sql);
      if (/DELETE FROM activity_zones/.test(s)) {
        const [zoneId, serverId] = params;
        const idx = tables.activity_zones.findIndex(z => z.id === Number(zoneId) && z.server_id === Number(serverId));
        if (idx >= 0) tables.activity_zones.splice(idx, 1);
        return { changes: idx >= 0 ? 1 : 0 };
      }
      if (/UPDATE activity_zones SET .* updated_at = NOW\(\) WHERE id = \? AND server_id = \?/.test(s)) {
        const setPart = s.match(/SET (.*) WHERE id = \? AND server_id = \?/)[1];
        const cols = [...setPart.matchAll(/([a-z_]+) = \?/g)].map(m => m[1]);
        const values = params.slice(0, cols.length);
        const zone = tables.activity_zones.find(x => x.id === Number(params[cols.length]) && x.server_id === Number(params[cols.length + 1]));
        if (zone) cols.forEach((col, i) => { zone[col] = values[i]; });
        return { changes: zone ? 1 : 0 };
      }
      // audit logAction + any other writes: accept
      return { changes: 1 };
    },
  };
  return db;
}

function boot({ isAdmin = true } = {}) {
  const db = fakeDb();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.isAuthenticated = () => true;
    req.user = { id: 1, username: 'testadmin', is_admin: isAdmin, platform_role: isAdmin ? 'dashboard_admin' : 'player' };
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
    const base = `/api/admin/zones/${SERVER_ID}`;

    // list
    const list = await request(server, 'GET', base);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.data.ok, true);
    assert.strictEqual(list.data.zones.length, 1);
    assert.strictEqual(list.data.zones[0].name, 'Old Zone');
    assert.deepEqual(list.data.zones[0].activity_filters, ['kill']);

    // create
    const created = await request(server, 'POST', base, {
      name: 'New Zone',
      center_x: 1000, center_z: 2000, radius_m: 300,
      activity_filters: ['kill'], channel_id: CHANNEL_ID,
      min_interval_seconds: 90, enabled: true, map_name: 'nasdara',
    });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.data.zone.name, 'New Zone');
    assert.strictEqual(created.data.zone.radius_m, 300);
    assert.equal(db.__zones.length, 2);
    const newId = created.data.zone.id;

    // create — validation failure -> 400
    const bad = await request(server, 'POST', base, {
      name: 'Bad', center_x: 0, center_z: 0, radius_m: 10,
      activity_filters: ['kill'], channel_id: CHANNEL_ID,
    });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.data.error, /radius_m/);

    // update
    const updated = await request(server, 'PATCH', `${base}/${newId}`, { name: 'Renamed', enabled: false });
    assert.strictEqual(updated.status, 200);
    assert.strictEqual(updated.data.zone.name, 'Renamed');
    assert.strictEqual(updated.data.zone.enabled, false);
    assert.strictEqual(updated.data.zone.radius_m, 300); // unchanged

    // update — unknown zone -> 404
    assert.strictEqual((await request(server, 'PATCH', `${base}/999`, { name: 'X' })).status, 404);

    // delete
    const del = await request(server, 'DELETE', `${base}/${newId}`);
    assert.strictEqual(del.status, 200);
    assert.strictEqual(db.__zones.length, 1);

    // delete — unknown zone -> 404
    assert.strictEqual((await request(server, 'DELETE', `${base}/999`)).status, 404);

    // server resolution guard: valid server id with no approved row -> 404
    assert.strictEqual((await request(server, 'GET', '/api/admin/zones/999')).status, 404);
    // param validation: non-numeric server id -> 400
    assert.strictEqual((await request(server, 'GET', '/api/admin/zones/abc')).status, 400);
    // channels: server resolves but no bot token configured -> 500 handled, not a crash
    assert.strictEqual((await request(server, 'GET', `${base}/channels`)).status, 500);
    // channels: unknown server -> 404
    assert.strictEqual((await request(server, 'GET', '/api/admin/zones/999/channels')).status, 404);

    console.log('✅ zone route smoke: list, create(201/400), update(200/404), delete(200/404), server 404, param 400');
  } finally {
    server.close();
  }

  // admin guard: non-admin gets 403
  const { server: s2 } = await boot({ isAdmin: false });
  try {
    assert.strictEqual((await request(s2, 'GET', `/api/admin/zones/${SERVER_ID}`)).status, 403);
    console.log('✅ zone route guard: non-admin 403');
  } finally {
    s2.close();
  }
}

main().catch(err => {
  console.error('❌ zone-route-test failed:', err);
  process.exit(1);
});
