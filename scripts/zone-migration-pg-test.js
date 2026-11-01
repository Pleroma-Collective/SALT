'use strict';

/* Migration 113 (activity_zones) verification against a real Postgres.
 * Creates a throwaway database, lays down the `servers` table the FK depends
 * on, runs the migration, then exercises the constraints (UNIQUE per server,
 * radius + interval CHECKs, FK, and the active-zone index). Drops the throwaway
 * DB on the way out.
 *
 * Connects to the local debug Postgres (127.0.0.1:55432) by default; override
 * with ZONE_PG_HOST / ZONE_PG_PORT. User/password come from .env.local.
 * Run: node scripts/zone-migration-pg-test.js */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Client, Pool } = require('pg');

const env = {};
const envFile = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
}

const HOST = process.env.ZONE_PG_HOST || '127.0.0.1';
const PORT = Number(process.env.ZONE_PG_PORT || 55432);
const USER = env.POSTGRES_USER || 'dayz-dashboard';
const PASS = env.POSTGRES_PASSWORD || '';
const TEST_DB = 'zone_migration_test';

function conn(database) {
  return new Client({ host: HOST, port: PORT, user: USER, password: PASS, database, ssl: false, connectionTimeoutMillis: 5000 });
}

async function main() {
  const admin = conn('dayz-dashboard');
  await admin.connect();
  // Recreate the throwaway DB fresh.
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [TEST_DB]);
  await admin.query('DROP DATABASE IF EXISTS ' + TEST_DB);
  await admin.query('CREATE DATABASE ' + TEST_DB);
  await admin.end();

  const pool = new Pool({ host: HOST, port: PORT, user: USER, password: PASS, database: TEST_DB, ssl: false, connectionTimeoutMillis: 5000 });

  try {
    // Lay down the `servers` table the FK references (minimal).
    await pool.query(`
      CREATE TABLE servers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'online'
      )`);
    const ins = await pool.query(`INSERT INTO servers (name, status) VALUES ('Chernarus','online') RETURNING id`);
    const serverId = ins.rows[0].id;

    // Run the migration under test.
    const migration = require('../db/migrations/113_activity_zones.js');
    await migration.up(pool);

    // Table + columns exist.
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='activity_zones' ORDER BY column_name`)).rows.map(r => r.column_name);
    for (const expected of ['id', 'server_id', 'name', 'map_name', 'center_x', 'center_z', 'radius_m', 'activity_filters', 'channel_id', 'min_interval_seconds', 'enabled', 'last_checked_at', 'last_posted_at', 'last_post_count', 'created_at', 'updated_at']) {
      assert.ok(cols.includes(expected), `missing column ${expected}`);
    }

    // Index exists.
    const idx = (await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename='activity_zones' AND indexname='idx_activity_zones_server_enabled'`)).rows;
    assert.equal(idx.length, 1, 'active-zone index missing');

    // Happy insert.
    await pool.query(
      `INSERT INTO activity_zones (server_id, name, center_x, center_z, radius_m, channel_id, last_checked_at)
       VALUES ($1, 'Alpha', 1000, 2000, 300, '999', NOW())`,
      [serverId]
    );

    // UNIQUE(server_id, name): duplicate name on the same server is rejected.
    await assert.rejects(
      () => pool.query(`INSERT INTO activity_zones (server_id, name, center_x, center_z, radius_m, channel_id) VALUES ($1, 'Alpha', 100, 200, 300, '999')`, [serverId]),
      /duplicate key/
    );

    // CHECK radius_m >= 25 AND <= 5000.
    for (const badRadius of [10, 6000]) {
      await assert.rejects(
        () => pool.query(`INSERT INTO activity_zones (server_id, name, center_x, center_z, radius_m, channel_id) VALUES ($1, $2, 0, 0, $3, '999')`, [serverId, 'r' + badRadius, badRadius]),
        /check/i
      );
    }

    // CHECK min_interval_seconds BETWEEN 30 AND 3600.
    for (const badInterval of [20, 4000]) {
      await assert.rejects(
        () => pool.query(`INSERT INTO activity_zones (server_id, name, center_x, center_z, radius_m, channel_id, min_interval_seconds) VALUES ($1, $2, 0, 0, 300, '999', $3)`, [serverId, 'i' + badInterval, badInterval]),
        /check/i
      );
    }

    // FK: a server id that does not exist is rejected.
    await assert.rejects(
      () => pool.query(`INSERT INTO activity_zones (server_id, name, center_x, center_z, radius_m, channel_id) VALUES (999999, 'Orphan', 0, 0, 300, '999')`),
      /foreign key/
    );

    // idempotent: re-running up() does not error (IF NOT EXISTS).
    await migration.up(pool);

    console.log('✅ zone migration 113: table, index, UNIQUE, CHECK radius/interval, FK, idempotent re-run');
  } finally {
    await pool.end();
    const drop = conn('dayz-dashboard');
    await drop.connect();
    await drop.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await drop.end();
    console.log('✅ throwaway DB dropped');
  }
}

main().catch(err => {
  console.error('❌ zone-migration-pg-test failed:', err.message);
  process.exit(1);
});
