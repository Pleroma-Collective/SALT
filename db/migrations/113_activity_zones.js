/*
 * Migration 113 — Activity zones
 *
 * Admin-defined areas whose ingested combat activity is reported to a Discord
 * channel. Geometry is a circle in DayZ world units (center_x = east,
 * center_z = north, radius_m = meters) — the same convention as
 * spawn_exclusion_zones. Matching runs against the EXISTING ingested
 * kill_events stream (position-bearing) on the feed-processor tick; no new
 * log-parsing pipeline.
 */

async function up(pool) {
  console.log('🎯 Migration 113: Add activity zones');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_zones (
      id                   BIGSERIAL PRIMARY KEY,
      server_id            INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name                 TEXT NOT NULL,
      map_name             TEXT NOT NULL DEFAULT 'nasdara',
      center_x             NUMERIC(12,4) NOT NULL,
      center_z             NUMERIC(12,4) NOT NULL,
      radius_m             NUMERIC(8,2) NOT NULL,
      activity_filters     TEXT NOT NULL DEFAULT '["kill"]',
      channel_id           TEXT NOT NULL,
      min_interval_seconds INTEGER NOT NULL DEFAULT 120,
      enabled              INTEGER NOT NULL DEFAULT 1,
      last_checked_at      TIMESTAMPTZ,
      last_posted_at       TIMESTAMPTZ,
      last_post_count      INTEGER NOT NULL DEFAULT 0,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(server_id, name),
      CHECK (radius_m >= 25 AND radius_m <= 5000),
      CHECK (min_interval_seconds BETWEEN 30 AND 3600)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_activity_zones_server_enabled
      ON activity_zones(server_id, enabled)
  `);

  console.log('✅ Migration 113 complete');
}

module.exports = { up };
