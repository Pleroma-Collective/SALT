'use strict';

// Local HTTP regression: DELETE /api/admin/servers/:serverId performs a real
// delete (row + local file dirs) and refuses when non-cascading rows exist.
const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');
const adminRoutes = require('../routes/admin');

const SERVER_ID = 2;
const PLATFORM_ID = '19811731';
const OTHER_PLATFORM_ID = '15580969';
const ADMIN = { id: 7, username: 'Test admin', platform_role: 'dashboard_admin', is_admin: 0 };

const BLOCKING_TABLES = [
  'shop_items', 'rotation_snippets', 'rotation_presets', 'rotation_history', 'mod_actions',
  'financial_refund_claims',
  'economy_supply_precision_reconciliation', 'radar_activations',
  'financial_idempotency_records',
  'shop_order_payment_allocations', 'shop_rental_consumption_events', 'shop_refund_decisions'
];

function fixture({ found = true, blockedBy = [], openMutations = 0, activeEscrow = 0 } = {}) {
  const calls = [];
  const state = { casinoDeleted: false };
  const db = {
    async get(sql, params) {
      calls.push({ sql, params });
      if (sql === 'SELECT * FROM servers WHERE id = ?') {
        assert.deepEqual(params, [String(SERVER_ID)]);
        return found ? {
          id: SERVER_ID, name: 'SALT NS', platform: 'switch2',
          platform_server_id: PLATFORM_ID, status: 'inactive'
        } : null;
      }
      if (sql.includes('FROM provider_mutations')) return { count: openMutations };
      if (sql.includes('FROM casino_game_history')) return { count: activeEscrow };
      const m = sql.match(/^SELECT COUNT\(\*\) AS count FROM (\w+) WHERE server_id = \?$/);
      if (m) {
        assert.deepEqual(params, [String(SERVER_ID)]);
        return { count: blockedBy.includes(m[1]) ? 3 : 0 };
      }
      throw new Error('unexpected get: ' + sql);
    },
    async run(sql, params) {
      calls.push({ sql, params });
      if (sql === 'SET LOCAL dayz.authorized_server_deletion = on') return { changes: 0 };
      if (sql === 'DELETE FROM servers WHERE id = ?') assert.deepEqual(params, [String(SERVER_ID)]);
      if (sql === 'DELETE FROM downloads WHERE server_id = ?') assert.deepEqual(params, [String(SERVER_ID)]);
      if (sql === 'DELETE FROM casino_game_history WHERE server_id = ?') {
        assert.deepEqual(params, [String(SERVER_ID)]);
        state.casinoDeleted = true;
        return { changes: 1 };
      }
      for (const stmt of ['DELETE FROM provider_mutation_files', 'DELETE FROM provider_mutations', 'DELETE FROM economy_daily_assessments']) {
        if (sql.startsWith(stmt)) assert.deepEqual(params, [String(SERVER_ID)]);
      }
      if (sql.startsWith('INSERT INTO audit_log')) {
        assert.equal(params[1], 'DELETE_SERVER');
        assert.equal(params[2], 'server');
      }
      return { changes: 1 };
    },
    async transaction(callback) {
      calls.push({ transaction: true });
      return callback(db);
    }
  };
  return { calls, db, state };
}

function appWith(db, downloadRoot) {
  const app = express();
  app.locals.db = db;
  app.locals.downloadRoot = downloadRoot;
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isAuthenticated = () => true;
    req.user = ADMIN;
    next();
  });
  app.use('/api/admin', adminRoutes);
  return app;
}

function makeDownloadRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-delete-test-'));
  // the server being deleted, under two parents (shared + numeric user-id parent)
  fs.mkdirSync(path.join(root, '789326430571855893', `server_${PLATFORM_ID}`), { recursive: true });
  fs.writeFileSync(path.join(root, '789326430571855893', `server_${PLATFORM_ID}`, 'marker.txt'), 'x');
  fs.mkdirSync(path.join(root, '111222333', PLATFORM_ID), { recursive: true });
  fs.writeFileSync(path.join(root, '111222333', PLATFORM_ID, 'marker.txt'), 'x');
  // another server in the SAME parent dir — must survive
  fs.mkdirSync(path.join(root, '789326430571855893', `server_${OTHER_PLATFORM_ID}`), { recursive: true });
  fs.writeFileSync(path.join(root, '789326430571855893', `server_${OTHER_PLATFORM_ID}`, 'marker.txt'), 'keep');
  // diagnostic parent (non-numeric) with the target's dir
  fs.mkdirSync(path.join(root, 'diagnostic', `server_${PLATFORM_ID}`), { recursive: true });
  return root;
}

function request(app, method, urlPath) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      const req = http.request({ host: '127.0.0.1', port, method, path: urlPath }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          srv.close();
          resolve({ status: res.statusCode, body: JSON.parse(body || '{}') });
        });
      });
      req.on('error', reject);
      req.end();
    });
  });
}

test('delete server: real delete + file dirs removed, other servers untouched', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const root = makeDownloadRoot();
  const { calls, db } = fixture();
  const app = appWith(db, root);

  const res = await request(app, 'DELETE', `/api/admin/servers/${SERVER_ID}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.removedDirs.length, 3, 'three dirs removed');

  // target dirs gone, other server's dir in the shared parent survives
  assert.equal(fs.existsSync(path.join(root, '789326430571855893', `server_${PLATFORM_ID}`)), false);
  assert.equal(fs.existsSync(path.join(root, '111222333', PLATFORM_ID)), false);
  assert.equal(fs.existsSync(path.join(root, 'diagnostic', `server_${PLATFORM_ID}`)), false);
  assert.equal(fs.existsSync(path.join(root, '789326430571855893', `server_${OTHER_PLATFORM_ID}`)), true);

  // row delete issued; no guild token lookup (Nitrado untouched)
  assert.ok(calls.some(c => c.sql === 'DELETE FROM servers WHERE id = ?'));
  assert.ok(!calls.some(c => /guild_tokens/i.test(c.sql)), 'no token lookup — Nitrado untouched');
});

test('delete server: blocked by non-cascading rows', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const root = makeDownloadRoot();
  const { calls, db } = fixture({ blockedBy: ['shop_items'] });
  const app = appWith(db, root);

  const res = await request(app, 'DELETE', `/api/admin/servers/${SERVER_ID}`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /shop_items/);
  assert.ok(!calls.some(c => c.sql === 'DELETE FROM servers WHERE id = ?'), 'row must not be deleted');
  assert.equal(fs.existsSync(path.join(root, '789326430571855893', `server_${PLATFORM_ID}`)), true, 'files must survive a blocked delete');
});

test('delete server: in-flight provider mutation blocks everything', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const root = makeDownloadRoot();
  const { calls, db } = fixture({ openMutations: 1 });
  const app = appWith(db, root);

  const res = await request(app, 'DELETE', `/api/admin/servers/${SERVER_ID}`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /provider_mutations/);
  assert.ok(!calls.some(c => c.sql === 'DELETE FROM servers WHERE id = ?'), 'row must not be deleted');
  assert.ok(!calls.some(c => c.sql === 'DELETE FROM economy_daily_assessments WHERE server_id = ?'), 'history must not be deleted');
  assert.equal(fs.existsSync(path.join(root, '789326430571855893', `server_${PLATFORM_ID}`)), true, 'files must survive a blocked delete');
});

test('delete server: terminal mutation history + assessments are removed with the server', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const root = makeDownloadRoot();
  const { calls, db } = fixture({ openMutations: 0 });
  const app = appWith(db, root);

  const res = await request(app, 'DELETE', `/api/admin/servers/${SERVER_ID}`);
  assert.equal(res.status, 200);
  assert.ok(calls.some(c => c.sql === 'DELETE FROM provider_mutation_files WHERE mutation_id IN (SELECT id FROM provider_mutations WHERE server_id = ?)'));
  assert.ok(calls.some(c => c.sql === 'DELETE FROM provider_mutations WHERE server_id = ?'));
  assert.ok(calls.some(c => c.sql === 'DELETE FROM economy_daily_assessments WHERE server_id = ?'));
  assert.ok(calls.some(c => c.sql === 'DELETE FROM servers WHERE id = ?'));
  const setIdx = calls.findIndex(c => c.sql === 'SET LOCAL dayz.authorized_server_deletion = on');
  const delIdx = calls.findIndex(c => c.sql === 'DELETE FROM economy_daily_assessments WHERE server_id = ?');
  assert.ok(setIdx !== -1 && delIdx > setIdx, 'SET LOCAL escape must precede the assessment delete in the same transaction');
});

test('delete server: active casino escrow blocks everything', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const root = makeDownloadRoot();
  const { calls, db } = fixture({ activeEscrow: 2 });
  const app = appWith(db, root);

  const res = await request(app, 'DELETE', `/api/admin/servers/${SERVER_ID}`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /casino_game_history \(active escrow\)/);
  assert.ok(!calls.some(c => c.sql === 'DELETE FROM servers WHERE id = ?'), 'row must not be deleted');
  assert.equal(fs.existsSync(path.join(root, '789326430571855893', `server_${PLATFORM_ID}`)), true, 'files must survive a blocked delete');
});

test('delete server: closed casino game history travels with the server', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const root = makeDownloadRoot();
  const { calls, db, state } = fixture({ activeEscrow: 0 });
  const app = appWith(db, root);

  const res = await request(app, 'DELETE', `/api/admin/servers/${SERVER_ID}`);
  assert.equal(res.status, 200);
  assert.ok(calls.some(c => c.sql === 'DELETE FROM casino_game_history WHERE server_id = ?'), 'closed casino rows are removed with the server');
  assert.equal(state.casinoDeleted, true);
});

test('delete server: unknown id 404s', async () => {
  const { db } = fixture({ found: false });
  const app = appWith(db, fs.mkdtempSync(path.join(os.tmpdir(), 'server-delete-test-')));
  const res = await request(app, 'DELETE', `/api/admin/servers/${SERVER_ID}`);
  assert.equal(res.status, 404);
});
