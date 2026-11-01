'use strict';

// Regression: the shop refund route's tenant lock (routes/shop.js
// lockActiveServerTenant) must not conflict with the independent
// provider_mutations FK INSERT that processRefund awaits inside the same
// transaction. FOR UPDATE on the servers row blocks that FK's FOR KEY SHARE
// and self-deadlocks the refund; FOR NO KEY UPDATE does not.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Client, Pool } = require('pg');
const PostgreSQLAdapter = require('../db/abstraction/postgres');
const { PROVIDER_RECOVERY_SQL } = require('../db/migrations/076_rotation_provider_recovery');
const { prepareProviderMutation } = require('../services/providerMutationRecoveryService');

function readRefundTenantLockSql() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'shop.js'), 'utf8');
  const start = source.indexOf('async function lockActiveServerTenant');
  assert(start !== -1, 'lockActiveServerTenant missing from routes/shop.js');
  const fn = source.slice(start, source.indexOf('async function assertServerOwnerForMutation'));
  const lockSql = /`([^`]*FOR (?:NO KEY )?UPDATE[^`]*)`/.exec(fn)?.[1];
  assert(lockSql, 'lockActiveServerTenant must issue a FOR ... UPDATE tenant lock');
  assert.match(lockSql, /FOR NO KEY UPDATE OF g, s/,
    'refund tenant lock must be FOR NO KEY UPDATE: FOR UPDATE self-deadlocks the independent provider_mutations FK insert');
  return lockSql;
}

async function main() {
  // Contract (hermetic, always enforced): the refund tenant lock is FOR NO KEY UPDATE.
  const lockSql = readRefundTenantLockSql();

  const connectionString = process.env.PROVIDER_MUTATION_PG_TEST_DATABASE;
  if (!connectionString) {
    console.log('refund lock deadlock PostgreSQL rehearsal skipped (PROVIDER_MUTATION_PG_TEST_DATABASE unset)');
    return;
  }
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (!/(?:-|_)test$/i.test(databaseName)) {
    throw new Error('PROVIDER_MUTATION_PG_TEST_DATABASE must name a dedicated database ending in -test or _test');
  }

  const setup = new Client({ connectionString });
  const schema = `refund_lock_deadlock_${process.pid}`;
  await setup.connect();
  let pool;
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(`SET search_path TO ${schema}, public`);
    await setup.query(`CREATE TABLE guilds (id BIGINT PRIMARY KEY, status TEXT NOT NULL)`);
    await setup.query(`CREATE TABLE servers (
      id INTEGER PRIMARY KEY,
      guild_id BIGINT NOT NULL,
      status TEXT NOT NULL
    )`);
    await setup.query(`INSERT INTO guilds VALUES (70, 'approved')`);
    await setup.query(`INSERT INTO servers VALUES (7, 70, 'active')`);
    await setup.query(PROVIDER_RECOVERY_SQL);

    pool = new Pool({
      connectionString,
      // Fails fast if the tenant lock regresses to FOR UPDATE: the independent
      // FK insert below then blocks on it instead of completing.
      options: `-c search_path=${schema},public -c lock_timeout=1500ms`,
    });
    const db = new PostgreSQLAdapter();
    db.pool = pool;

    // Outer refund transaction (T1): the exact lock the route takes first.
    const outer = await pool.connect();
    await outer.query('BEGIN');
    await outer.query(lockSql.replace('?', '$1'), [7]);

    // Live provider mutation (T2): the independent provider_mutations INSERT
    // that processRefund awaits before committing T1.
    const operationId = await prepareProviderMutation(db, {
      serverId: 7,
      providerServiceId: 'provider-7',
      workflow: 'shop',
      action: 'refund',
      contextType: 'shop_order',
      contextId: '189',
      plan: { filePaths: ['/mission/shop.xml'] },
      snapshots: new Map([['/mission/shop.xml', '<old/>']]),
      triggeredBy: 'test:postgres',
    });
    assert(Number(operationId) > 0,
      'independent provider mutation must complete while the tenant lock is held');
    await outer.query('COMMIT');
    outer.release();

    const rows = await setup.query('SELECT id, status, server_id FROM provider_mutations');
    assert.strictEqual(rows.rows.length, 1);
    assert.strictEqual(rows.rows[0].status, 'prepared');
    assert.strictEqual(Number(rows.rows[0].server_id), 7);
    console.log('refund lock deadlock PostgreSQL rehearsal passed');
  } finally {
    if (pool) await pool.end();
    await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await setup.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
