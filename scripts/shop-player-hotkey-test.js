'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const shopFileService = require('../services/shopFileService');
const {
  normalizeHotkey,
  snapshotToSpawnCoordinates,
  getLatestPositionSnapshot,
  resolveHotkeySpawn,
  usePlayerHotkey,
} = require('../services/shopPlayerHotkeyService');
const {
  fingerprintFinancialRequest,
} = require('../utils/financialIdempotency');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

(function testNormalizeHotkey() {
  assert.strictEqual(normalizeHotkey('f5'), 'F5');
  assert.strictEqual(normalizeHotkey('a'), 'A');
  assert.strictEqual(normalizeHotkey('  7  '), '7');
  assert.strictEqual(normalizeHotkey('F12'), 'F12');
  assert.strictEqual(normalizeHotkey('F1'), 'F1');
  assert.throws(() => normalizeHotkey('F13'), /single letter, digit, or F1-F12/);
  assert.throws(() => normalizeHotkey('ab'), /single letter, digit, or F1-F12/);
  assert.throws(() => normalizeHotkey(''), /single letter, digit, or F1-F12/);
  assert.throws(() => normalizeHotkey('ArrowUp'), /single letter, digit, or F1-F12/);
  assert.throws(() => normalizeHotkey(null), TypeError);
  assert.throws(() => normalizeHotkey(5), TypeError);
})();

(function testSnapshotCoordinateSwap() {
  // ADM tuple order: x=east, y=north, z=elevation
  // Shop order-item order: x=east, y=elevation, z=north
  assert.deepStrictEqual(
    snapshotToSpawnCoordinates({ pos_x: 100.25, pos_y: 200.75, pos_z: 5 }),
    { pos_x: 100.25, pos_y: 5, pos_z: 200.75 }
  );
})();

// ---------------------------------------------------------------------------
// Mock db harness
// ---------------------------------------------------------------------------

function makeDb({
  binding = null,
  item = null,
  snapshot = null,
  idempotencyExisting = null,
} = {}) {
  const calls = { gets: [], runs: [], locks: 0 };
  const db = {
    async acquireTransactionAdvisoryLock() {
      calls.locks += 1;
    },
    async get(sql, params) {
      calls.gets.push({ sql, params });
      if (sql.includes('FROM shop_player_hotkeys')) return binding;
      if (sql.includes('FROM shop_items')) return item;
      if (sql.includes('FROM player_position_snapshots')) return snapshot;
      if (sql.includes('INSERT INTO financial_idempotency_records')) {
        return idempotencyExisting ? null : { id: 777 };
      }
      if (sql.includes('FROM financial_idempotency_records') && sql.includes('FOR UPDATE')) {
        return idempotencyExisting;
      }
      if (sql.includes('FROM shop_orders') && sql.includes("status = 'cart'")) return { id: 99 };
      if (sql.includes('FROM shop_order_items') && sql.includes('ORDER BY id DESC')) {
        return { id: 31 };
      }
      throw new Error('Unexpected get: ' + sql.replace(/\s+/g, ' ').trim());
    },
    async run(sql, params) {
      calls.runs.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { changes: 1 };
    },
    async transaction(fn) {
      return fn(db);
    },
  };
  return { db, calls };
}

const VALID_ITEM = {
  id: 5,
  server_id: 7,
  name: 'Crate Bundle',
  item_class: 'Crate',
  spawn_method: 'cfgEffectArea',
  item_type: 'item',
  price: 50,
  is_active: true,
  deleted_at: null,
  rental_restarts: 1,
  provisioning_version: 1,
};

const SNAPSHOT = {
  pos_x: 100.25, // east
  pos_y: 200.75, // north
  pos_z: 5,      // elevation
  timestamp: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
};

// ---------------------------------------------------------------------------
// getLatestPositionSnapshot
// ---------------------------------------------------------------------------

async function testLatestSnapshotQuery() {
  const { db, calls } = makeDb({ snapshot: SNAPSHOT });
  const row = await getLatestPositionSnapshot(db, { identityId: 11, serverId: 7 });
  assert.strictEqual(row.pos_x, 100.25);
  assert.strictEqual(calls.gets.length, 1);
  const sql = calls.gets[0].sql;
  assert.match(sql, /player_position_snapshots/);
  assert.match(sql, /pos_x IS NOT NULL AND pos_y IS NOT NULL/);
  assert.match(sql, /ORDER BY timestamp DESC, id DESC/);
  assert.match(sql, /LIMIT 1/);
  assert.deepStrictEqual(calls.gets[0].params, [11, 7]);
}

// ---------------------------------------------------------------------------
// resolveHotkeySpawn
// ---------------------------------------------------------------------------

async function testResolveErrors() {
  const base = { serverId: 7, identityId: 11, hotkey: 'f5' };

  // Unbound key
  let { db } = makeDb({});
  await assert.rejects(
    resolveHotkeySpawn(db, base),
    error => error.status === 404 && /No item is bound to hotkey F5/.test(error.message)
  );

  // Bound to a removed item
  ({ db } = makeDb({ binding: { shop_item_id: 5 } }));
  await assert.rejects(
    resolveHotkeySpawn(db, base),
    error => error.status === 404 && /no longer available/.test(error.message)
  );

  // Bound, active item, but the server has never seen the player
  ({ db } = makeDb({ binding: { shop_item_id: 5 }, item: VALID_ITEM }));
  await assert.rejects(
    resolveHotkeySpawn(db, base),
    error => error.status === 409 && /No recent in-game location/.test(error.message)
  );

  // Bad key shape fails before any DB access
  const { db: noAccessDb, calls } = makeDb({ binding: { shop_item_id: 5 }, item: VALID_ITEM, snapshot: SNAPSHOT });
  await assert.rejects(
    resolveHotkeySpawn(noAccessDb, { ...base, hotkey: 'not a key' }),
    error => error instanceof TypeError
  );
  assert.strictEqual(calls.gets.length, 0);
}

async function testResolveHappyPath() {
  const { db } = makeDb({
    binding: { shop_item_id: 5 },
    item: VALID_ITEM,
    snapshot: SNAPSHOT,
  });
  const plan = await resolveHotkeySpawn(db, { serverId: 7, identityId: 11, hotkey: 'f5' });
  assert.strictEqual(plan.hotkey, 'F5');
  assert.deepStrictEqual(plan.coordinates, { pos_x: 100.25, pos_y: 5, pos_z: 200.75 });
  assert.ok(plan.ageSeconds >= 119 && plan.ageSeconds <= 121, `age was ${plan.ageSeconds}`);
}

// ---------------------------------------------------------------------------
// usePlayerHotkey — full pipeline
// ---------------------------------------------------------------------------

async function testUseHotkeySuccess() {
  const originalCheckout = shopFileService.processCheckout;
  shopFileService.processCheckout = async (db, orderId, userId, _opts) => ({
    success: true,
    orderId,
    userId,
    charged: 50,
  });
  try {
    const { db, calls } = makeDb({
      binding: { shop_item_id: 5 },
      item: VALID_ITEM,
      snapshot: SNAPSHOT,
    });
    const response = await usePlayerHotkey(db, {
      userId: 3, identityId: 11, serverId: 7,
      hotkey: 'F5', idempotencyKey: 'hotkey-test-1', timer: { finish() {} },
    });

    assert.strictEqual(response.replay, undefined);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.checkoutState, 'success');
    assert.deepStrictEqual(response.body.data.spawn, {
      pos_x: 100.25,
      pos_y: 5,
      pos_z: 200.75,
      captured_at: SNAPSHOT.timestamp,
      age_seconds: response.body.data.spawn.age_seconds,
      item_name: 'Crate Bundle',
    });

    // The server lock was taken once
    assert.strictEqual(calls.locks, 1);

    // The cart line was inserted with the captured (swapped) coordinates
    const insert = calls.runs.find(run => run.sql.includes('INSERT INTO shop_order_items'));
    assert.ok(insert, 'cart line insert expected');
    assert.deepStrictEqual(
      insert.params.slice(4, 7),
      [100.25, 5, 200.75]
    );

    // The financial operation was claimed and completed with the success body
    const complete = calls.runs.find(run =>
      run.sql.includes('UPDATE financial_idempotency_records')
    );
    assert.ok(complete, 'financial completion expected');
    assert.strictEqual(complete.params[0], 200);
    assert.strictEqual(JSON.parse(complete.params[1]).checkoutState, 'success');
  } finally {
    shopFileService.processCheckout = originalCheckout;
  }
}

async function testUseHotkeyReplay() {
  const recorded = {
    success: true,
    checkoutState: 'success',
    data: { spawn: { item_name: 'Crate Bundle' } },
  };
  const fingerprint = fingerprintFinancialRequest({
    operation: 'shop_hotkey',
    serverId: 7,
    identityId: 11,
    shopItemId: 5,
    hotkey: 'F5',
  });
  const existing = {
    id: 55,
    operation: 'shop_hotkey',
    request_fingerprint: fingerprint,
    response_status: 200,
    response_body: JSON.stringify(recorded),
    completed_at: new Date().toISOString(),
  };

  const { db, calls } = makeDb({
    binding: { shop_item_id: 5 },
    item: VALID_ITEM,
    snapshot: SNAPSHOT,
    idempotencyExisting: existing,
  });
  const response = await usePlayerHotkey(db, {
    userId: 3, identityId: 11, serverId: 7,
    hotkey: 'F5', idempotencyKey: 'hotkey-test-1', timer: { finish() {} },
  });

  assert.strictEqual(response.replay, true);
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(response.body, recorded);
  // A replay must not touch the cart
  assert.ok(!calls.runs.some(run => run.sql.includes('INSERT INTO shop_order_items')),
    'replay must not insert a cart line');
}

async function testUseHotkeyFailedCheckoutCompletesWith409() {
  const originalCheckout = shopFileService.processCheckout;
  shopFileService.processCheckout = async () => ({ success: false, error: 'spawn provider failed' });
  try {
    const { db, calls } = makeDb({
      binding: { shop_item_id: 5 },
      item: VALID_ITEM,
      snapshot: SNAPSHOT,
    });
    const response = await usePlayerHotkey(db, {
      userId: 3, identityId: 11, serverId: 7,
      hotkey: 'F5', idempotencyKey: 'hotkey-test-2', timer: { finish() {} },
    });
    assert.strictEqual(response.status, 409);
    assert.strictEqual(response.body.checkoutState, 'failed');
    assert.strictEqual(response.body.error, 'spawn provider failed');
    const complete = calls.runs.find(run =>
      run.sql.includes('UPDATE financial_idempotency_records')
    );
    assert.strictEqual(complete.params[0], 409);
  } finally {
    shopFileService.processCheckout = originalCheckout;
  }
}

// ---------------------------------------------------------------------------
// Migration + route wiring contracts
// ---------------------------------------------------------------------------

(function testMigrationDefinesHotkeyTable() {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '117_shop_player_hotkeys.js'),
    'utf8'
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS shop_player_hotkeys/);
  assert.match(migration, /UNIQUE\(server_id, identity_id, hotkey\)/);
  assert.match(migration, /REFERENCES servers\(id\)/);
  assert.match(migration, /REFERENCES player_identities\(id\)/);
  assert.match(migration, /REFERENCES shop_items\(id\)/);
  assert.match(migration, /idx_shop_player_hotkeys_server_identity/);
  assert.ok(!fs.existsSync(
    path.join(__dirname, '..', 'db', 'migrations', '116_shop_player_hotkeys.js')
  ), 'migration must not collide with 116_server_session_state.js');
})();

(function testRoutesWireTheNewSurfaces() {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'shop.js'), 'utf8');
  assert.match(routes, /require\('\.\.\/services\/shopPlayerHotkeyService'\)/);
  assert.match(routes, /require\('\.\.\/services\/shopCartService'\)/);
  assert.match(routes, /router\.get\('\/last-position\/:identityId\/:serverId'/);
  assert.match(routes, /router\.get\('\/hotkeys\/:identityId\/:serverId'/);
  assert.match(routes, /router\.put\('\/hotkeys'/);
  assert.match(routes, /router\.delete\('\/hotkeys\/:hotkey'/);
  assert.match(routes, /router\.post\('\/hotkeys\/use', ensurePlayerServerAccess/);
  assert.match(routes, /usePlayerHotkey\(db/);
  // The old inline cart helpers must be gone from the route file
  assert.doesNotMatch(routes, /async function addCartItem/);
  assert.doesNotMatch(routes, /async function recalculateCartTotal/);
})();

(async () => {
  await testLatestSnapshotQuery();
  await testResolveErrors();
  await testResolveHappyPath();
  await testUseHotkeySuccess();
  await testUseHotkeyReplay();
  await testUseHotkeyFailedCheckoutCompletesWith409();
  console.log('Shop player hotkey tests passed');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
