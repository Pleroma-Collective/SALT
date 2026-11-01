/**
 * Migration 111: Per-server holiday event configs (holiday system rework).
 *
 *  - P1 shipped a single global file (public/data/holiday-windows.json) that
 *    every server shared. Rework requirement: holiday windows/packs are
 *    per-server, admin-managed, and persisted in the DB (not just JSON on
 *    disk). The global file becomes the DEFAULT SET ("standard BiSTudio
 *    schedule") that a server can apply in one click and then customize.
 *
 *  - holiday_server_configs: one row per (guild, platform server).
 *      config  JSONB — { events: [ { id, label, icon, missions, windows: [[start,end],...] } ] }
 *                same shape as public/data/holiday-windows.json
 *      enabled — master on/off for the server's holiday windows
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 111: Create holiday_server_configs');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS holiday_server_configs (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      guild_id INTEGER NOT NULL,
      platform_server_id TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'nitrado',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      config JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (guild_id, platform_server_id)
    )
  `);

  console.log('✅ Migration 111 complete');
}

module.exports = { up };
