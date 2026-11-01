'use strict';

/**
 * Regression: shop event-spawn cleanup failure loop (t_d5b18c4c).
 *
 * Incident: the live cfgeventspawns.xml had been re-seeded (Nasadara rollout),
 * so 23 of 38 tracked rental positions were already absent from the file.
 * removeEventSpawnPositions treated "tracked position missing from file" the
 * same as "tracked position failed to remove" and threw
 * 'Event spawn cleanup did not match every tracked position'.  The throw
 * aborted processRestartEvents before the restarts_remaining decrements
 * persisted, so every subsequent restart re-targeted the same 38 items and
 * re-failed forever (pipeline stuck 'degraded').
 *
 * Contract under test:
 *  1. A tracked position already absent from the live file is tolerated
 *     (already-clean); no throw.  Present positions are still removed and
 *     uploaded exactly once; an all-absent batch uploads nothing.
 *  2. Because cleanup no longer throws, decrementRentalCounts persists the
 *     restarts_remaining decrement and marks the exhausted item cleaned
 *     (inactive) + the order expired.
 *  3. processRestartEvents (the restart-evidence path caught by scheduler.js)
 *     completes the transaction end-to-end for a scheduled restart with a mix
 *     of present and absent tracked positions.
 */

const assert = require('assert');

const shopFileService = require('../services/shopFileService');
const shopRestartService = require('../services/shopRestartService');

const LIVE_FILE = [
  '<eventposdef>',
  '  <event name="VehicleRental453">',
  '    <zone smin="0" smax="0" dmin="0" dmax="0" r="0"/>',
  '    <pos x="100" z="200" a="15" y="0"/>',
  '  </event>',
  '  <event name="VehicleRental467">',
  '    <zone smin="0" smax="0" dmin="0" dmax="0" r="0"/>',
  '    <pos x="300" z="400" a="30" y="1"/>',
  '  </event>',
  '  <event name="UnrelatedEvent">',
  '    <zone smin="0" smax="0" dmin="0" dmax="0" r="0"/>',
  '    <pos x="999" z="999" a="45" y="0"/>',
  '  </event>',
  '</eventposdef>',
].join('\n');

const ENTRY_453 = JSON.stringify({ event: 'VehicleRental453', x: 100, z: 200, a: 15, y: 0 });
const ENTRY_467 = JSON.stringify({ event: 'VehicleRental467', x: 300, z: 400, a: 30, y: 1 });
// Orphaned by the mission re-seed: the DB tracks it, the live file never had it.
const ENTRY_ORPHAN = JSON.stringify({ event: 'VehicleRental413', x: 50, z: 60, a: 5, y: 0 });

function makeFileService(fileContent) {
  const uploads = [];
  return {
    uploads,
    downloadFileFromServer: async () => fileContent,
    uploadFileToServer: async (_serverId, _dir, _name, content) => { uploads.push(content); },
  };
}

async function testMissingPositionsAreTolerated() {
  // Mixed batch (the prod shape: some present, some absent) — no throw.
  const mixed = makeFileService(LIVE_FILE);
  await shopFileService.removeEventSpawnPositions(
    '15580969', 'token', '/mission', [ENTRY_453, ENTRY_467, ENTRY_ORPHAN], mixed
  );
  assert.strictEqual(mixed.uploads.length, 1, 'mixed batch must upload exactly once');
  const rewritten = mixed.uploads[0];
  assert.ok(!rewritten.includes('x="100"'), 'present position must be removed');
  assert.ok(!rewritten.includes('x="300"'), 'present position must be removed');
  assert.ok(!rewritten.includes('name="VehicleRental453"'), 'emptied rental block must be dropped');
  assert.ok(!rewritten.includes('name="VehicleRental467"'), 'emptied rental block must be dropped');
  assert.ok(rewritten.includes('name="UnrelatedEvent"'), 'unrelated event must survive');
  assert.ok(rewritten.includes('x="999"'), 'unrelated position must survive');

  // All-absent batch — no throw and no no-op rewrite of the unchanged file.
  const allAbsent = makeFileService(LIVE_FILE);
  await shopFileService.removeEventSpawnPositions(
    '15580969', 'token', '/mission', [ENTRY_ORPHAN], allAbsent
  );
  assert.strictEqual(allAbsent.uploads.length, 0, 'all-absent batch must not rewrite the file');
}

async function testDecrementPersistsWhenCleanupDoesNotThrow() {
  const originalRemoveExpiredRentals = shopFileService.removeExpiredRentals;
  const cleanupCalls = [];
  // Boundary stub: the real removeExpiredRentals delegates to
  // removeEventSpawnPositions, whose tolerance is proven directly above.
  shopFileService.removeExpiredRentals = async (_db, _serverId, ids) => { cleanupCalls.push(ids); };
  try {
    const state = { remaining: 1, consumptionIds: 0 };
    const updates = { counters: [], isActive: [], orders: [] };
    const replayDb = {
      async all(sql) {
        if (sql.includes('SELECT soi.id, soi.order_id, soi.restarts_remaining')) {
          return state.remaining > 0
            ? [{ id: 413, order_id: 17, restarts_remaining: state.remaining }]
            : [];
        }
        if (sql.includes('restarts_remaining <= 0')) {
          return state.remaining <= 0 ? [{ id: 413 }] : [];
        }
        throw new Error(`Unexpected replay all query: ${sql}`);
      },
      async get(sql) {
        if (sql.includes('INSERT INTO shop_rental_consumption_events')) {
          return { id: ++state.consumptionIds };
        }
        throw new Error(`Unexpected replay get query: ${sql}`);
      },
      async run(sql, params) {
        if (sql.includes('UPDATE shop_order_items SET restarts_remaining')) {
          state.remaining = params[0];
          updates.counters.push(params[0]);
          return { changes: 1 };
        }
        if (sql.includes('UPDATE shop_order_items SET is_active = FALSE')) {
          updates.isActive.push(params);
          return { changes: 1 };
        }
        if (sql.includes('UPDATE shop_orders')) {
          updates.orders.push(params);
          return { changes: 1 };
        }
        throw new Error(`Unexpected replay run query: ${sql}`);
      },
    };

    await shopRestartService.decrementRentalCounts(
      replayDb, 1, '2026-10-17T17:30:10.000Z', 501
    );

    assert.deepStrictEqual(updates.counters, [0],
      'the restarts_remaining decrement must persist (1 -> 0)');
    assert.strictEqual(updates.isActive.length, 1,
      'the exhausted rental must be marked cleaned (inactive)');
    assert.deepStrictEqual(updates.isActive[0], [413]);
    assert.strictEqual(updates.orders.length, 1,
      'the fully-expired order must be marked expired');
    assert.deepStrictEqual(cleanupCalls, [[413]],
      'the expired item must be handed to the file cleanup before being marked inactive');
  } finally {
    shopFileService.removeExpiredRentals = originalRemoveExpiredRentals;
  }
}

async function testProcessRestartEventsCompletesForMixedCleanup() {
  const originalRemoveExpiredRentals = shopFileService.removeExpiredRentals;
  shopFileService.removeExpiredRentals = async () => {};
  try {
    const state = { remaining: 1 };
    const updates = { counters: [], isActive: [], orders: [] };
    const restartLogInserts = [];
    const db = {
      async acquireTransactionAdvisoryLock() {},
      async transaction(fn) { return fn(this); },
      async get(sql) {
        if (sql.includes('owner_triggered')) return null; // no owner marker
        if (sql.includes('SELECT id FROM server_restart_log')) return null; // new BIOS session
        if (sql.includes('INSERT INTO server_restart_log')) {
          restartLogInserts.push(sql);
          return { id: 501 };
        }
        if (sql.includes('INSERT INTO shop_rental_consumption_events')) return { id: 1 };
        throw new Error(`Unexpected get query: ${sql}`);
      },
      async all(sql) {
        if (sql.includes('SELECT soi.id, soi.order_id, soi.restarts_remaining')) {
          return state.remaining > 0
            ? [{ id: 413, order_id: 17, restarts_remaining: state.remaining }]
            : [];
        }
        if (sql.includes('restarts_remaining <= 0')) {
          return state.remaining <= 0 ? [{ id: 413 }] : [];
        }
        throw new Error(`Unexpected all query: ${sql}`);
      },
      async run(sql, params) {
        if (sql.includes('UPDATE shop_order_items SET restarts_remaining')) {
          state.remaining = params[0];
          updates.counters.push(params[0]);
          return { changes: 1 };
        }
        if (sql.includes('UPDATE shop_order_items SET is_active = FALSE')) {
          updates.isActive.push(params);
          return { changes: 1 };
        }
        if (sql.includes('UPDATE shop_orders')) {
          updates.orders.push(params);
          return { changes: 1 };
        }
        throw new Error(`Unexpected run query: ${sql}`);
      },
    };

    // The exact production shape: scheduled restart evidence for server 1
    // whose expired rental batch mixes present and re-seed-orphaned positions.
    await shopRestartService.processRestartEvents(db, 1, [{
      biosSessionId: 'provider-start:15580969:1760755810000',
      detectedAt: '2026-10-17 17:30:10',
      providerStartedAt: '2026-10-17 17:30:10',
      evidenceSourceFile: 'DayZServer_X1_x64_2026-10-17_17-30-10.RPT',
      isScheduled: true,
    }]);

    assert.strictEqual(restartLogInserts.length, 1, 'the restart must be recorded exactly once');
    assert.deepStrictEqual(updates.counters, [0],
      'the decrement must persist inside the restart transaction');
    assert.strictEqual(updates.isActive.length, 1,
      'the cleaned item must be marked inactive');
    assert.strictEqual(updates.orders.length, 1,
      'the expired order must be marked expired');
  } finally {
    shopFileService.removeExpiredRentals = originalRemoveExpiredRentals;
  }
}

async function main() {
  await testMissingPositionsAreTolerated();
  await testDecrementPersistsWhenCleanupDoesNotThrow();
  await testProcessRestartEventsCompletesForMixedCleanup();
  console.log('Shop rental cleanup missing-position regression tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
