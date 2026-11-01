#!/usr/bin/env node
'use strict';

/*
 * loot-probability-gating-test.js — verifies the server-side spawn-rate
 * gating on the map-data endpoint (roadmap P0 map/data decision, 2026-10-22:
 * spawn rates are ADMIN-ONLY; the public view shows only "what can spawn").
 *
 * Boots the real Express app (stub DB, no Postgres) and asserts:
 *   - non-admin (anonymous) GET /data/<map>/items.json  -> "what can spawn"
 *     view: no numeric spawn-rate field reaches the client, while identity /
 *     building groups (usages) / spawn locations (flags) / presence remain.
 *   - admin GET /data/<map>/items.json -> the FULL file (nominal/lifetime/…).
 *   - non-sensitive map files (settlements.json) are still served in full.
 *   - the static-symlink leak path /data/data/<map>/items.json is blocked (404).
 *   - isDashboardAdmin classifies anonymous / player / admin / owner correctly.
 *
 * The enforcement point is the /data/:map/:file route (registerRoutes.js): the
 * numeric rates are stripped server-side for non-admins, so a non-admin browser
 * never receives them in any response (not a UI hide).
 * Run: node scripts/loot-probability-gating-test.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const sign = require('cookie-signature').sign;

const { ensureTestEncryptionKey } = require(path.join(__dirname, 'lib/test-env.js'));
ensureTestEncryptionKey();
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || 'test-client-id';
process.env.DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || 'test-client-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';

const root = path.resolve(__dirname, '..');

// ---- stub DB: in-memory session store (connectPgSimple-compatible pool) + a
// ---- single admin user row for passport deserializeUser.
const adminUser = {
  id: 1,
  discord_id: 'admin-did',
  username: 'AdminTest',
  is_admin: 1,
  platform_role: 'dashboard_owner',
};
function stubDb() {
  const sessions = new Map(); // sid -> session object
  const pool = {
    async query(query, params) {
      const q = String(query || '');
      if (q.includes('SELECT sess FROM')) {
        const sid = params[0];
        const sess = sessions.get(sid);
        return { rows: sess ? [{ sess }] : [] };
      }
      if (q.includes('INSERT INTO')) {
        const sess = params[0];
        const sid = params[2];
        sessions.set(sid, sess);
        return { rows: [{ sid }] };
      }
      return { rows: [] };
    },
    async end() {},
  };
  const empty = { rows: [] };
  return {
    pool,
    sessions,
    async get(sql) {
      const s = String(sql || '');
      if (/SELECT \* FROM users WHERE discord_id/i.test(s)) return adminUser;
      if (/theme_preference/i.test(s)) return { theme_preference: null };
      return empty;
    },
    async query() { return empty; },
    async all() { return []; },
    async execute() { return empty; },
    async getClient() { return { async query() { return empty; }, async release() {} }; },
    async begin() {},
    async commit() {},
    async rollback() {},
    async transaction(fn) { return fn(this); },
    async close() {},
  };
}

function request(server, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: urlPath, headers }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Tolerant fetch: the connect-pg session store pings a (missing) Postgres in
// this stub environment; retry a couple of times before treating as failure.
async function softRequest(server, method, urlPath, headers) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await request(server, method, urlPath, headers);
      if (r.status !== 0) return r;
    } catch (err) { /* retry */ }
    await new Promise(res => setTimeout(res, 150));
  }
  return { status: 0, text: '', headers: {}, error: 'gave up after retries' };
}

// Numeric spawn-rate fields that must NEVER reach a non-admin client.
const RATE_FIELDS = ['nominal', 'lifetime', 'restock', 'min', 'quantmin', 'quantmax', 'nominalChance', 'lifetimeChance', 'minChance'];

async function main() {
  let failures = 0;
  const check = (name, ok, detail) => {
    if (ok) console.log(`\u2705 ${name}`);
    else { failures++; console.log(`\u274c ${name}${detail ? ' \u2014 ' + detail : ''}`); }
  };

  const { createApp } = require(path.join(root, 'src/app/createApp.js'));
  const db = stubDb();
  const app = createApp(db);
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  console.log(`(gating app on port ${server.address().port})`);

  try {
    // ---- 1. unit: isDashboardAdmin classification ----
    const { isDashboardAdmin } = require(path.join(root, 'middleware/auth.js'));
    check('isDashboardAdmin: anonymous -> false', isDashboardAdmin({ isAuthenticated: () => false }) === false);
    check('isDashboardAdmin: player (non-admin) -> false', isDashboardAdmin({ isAuthenticated: () => true, user: { is_admin: 0, platform_role: null } }) === false);
    check('isDashboardAdmin: global is_admin -> true', isDashboardAdmin({ isAuthenticated: () => true, user: { is_admin: 1, platform_role: null } }) === true);
    check('isDashboardAdmin: dashboard_owner -> true', isDashboardAdmin({ isAuthenticated: () => true, user: { is_admin: 0, platform_role: 'dashboard_owner' } }) === true);
    check('isDashboardAdmin: dashboard_admin -> true', isDashboardAdmin({ isAuthenticated: () => true, user: { is_admin: 0, platform_role: 'dashboard_admin' } }) === true);

    // ---- 2. non-admin (anonymous) items.json -> stripped "what can spawn" ----
    const pub = await softRequest(server, 'GET', '/data/nasdara/items.json');
    check('non-admin GET /data/nasdara/items.json -> 200', pub.status === 200, `status ${pub.status}`);
    const pubDoc = JSON.parse(pub.text);
    check('non-admin doc has numeric count', typeof pubDoc.count === 'number', `count ${pubDoc.count}`);
    check('non-admin doc has items[]', Array.isArray(pubDoc.items) && pubDoc.items.length > 0, `items ${pubDoc.items && pubDoc.items.length}`);
    const sample = pubDoc.items[0];
    for (const f of RATE_FIELDS) {
      check(`non-admin item carries NO "${f}"`, !(f in sample), `leaked ${f}=${sample[f]}`);
    }
    check('non-admin item keeps classname', typeof sample.classname === 'string', sample.classname);
    check('non-admin item keeps usages (building groups)', Array.isArray(sample.usages));
    check('non-admin item keeps spawn locations (flags)', sample.flags !== undefined);
    check('non-admin item keeps spawnable presence', typeof sample.spawnable === 'boolean');
    check('non-admin response has no numeric nominal', !/"nominal":\s*-?\d/.test(pub.text));
    check('non-admin response has no numeric chance weights', !/"(nominalChance|lifetimeChance|minChance)":\s*-?\d/.test(pub.text));

    // ---- 3. non-sensitive map file served in full (settlements.json) ----
    const stl = await softRequest(server, 'GET', '/data/nasdara/settlements.json');
    check('non-admin GET /data/nasdara/settlements.json -> 200 (unchanged)', stl.status === 200, `status ${stl.status}`);
    check('settlements.json is a real file (non-empty)', stl.text.length > 10, `len ${stl.text.length}`);

    // ---- 4. static-symlink leak path blocked ----
    const leak = await softRequest(server, 'GET', '/data/data/nasdara/items.json');
    check('leak path /data/data/nasdara/items.json -> 404', leak.status === 404, `status ${leak.status}`);

    // ---- 5. admin items.json -> FULL file (via a forged admin session) ----
    const ADMIN_SID = 'admin-test-sid';
    db.sessions.set(ADMIN_SID, {
      passport: { user: adminUser.discord_id },
      cookie: {
        originalMaxAge: 3600000, originalTTL: 3600000, secure: false,
        expires: new Date(Date.now() + 3600000), httpOnly: true, path: '/',
      },
    });
    const cookieVal = encodeURIComponent('s:' + sign(ADMIN_SID, process.env.SESSION_SECRET));
    const adm = await softRequest(server, 'GET', '/data/nasdara/items.json', { cookie: `connect.sid=${cookieVal}` });
    check('admin GET /data/nasdara/items.json -> 200', adm.status === 200, `status ${adm.status} ${adm.text.slice(0, 60)}`);
    const admDoc = JSON.parse(adm.text);
    const admSample = admDoc.items && admDoc.items[0];
    check('admin item has nominal (full rates present)', admSample && typeof admSample.nominal === 'number', `keys ${admSample ? Object.keys(admSample).join(',') : 'n/a'}`);
    check('admin item has lifetime', admSample && typeof admSample.lifetime === 'number');
    check('admin doc larger than public doc (rates included)', adm.text.length > pub.text.length, `admin ${adm.text.length} vs public ${pub.text.length}`);
  } catch (e) {
    failures++;
    console.log('\u274c test threw \u2014 ' + e.message);
  } finally {
    server.close();
  }

  if (failures) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll spawn-rate gating checks passed.');
}

main();
