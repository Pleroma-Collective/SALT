/*
 * Migration 115 — Faction Wars: settlement flag claims
 *
 * faction_flags — one row per placed flag. A flag inside a settlement's
 *   boundary (services/factionClaimService.js, per-kind radius table — the
 *   map data has no footprint polygon) carries that settlement's id and
 *   counts toward the faction's claim; a flag outside any settlement has
 *   settlement_id NULL and claims only its own radius_m circle.
 *
 * faction_claims — at most one live claim per settlement
 *   (UNIQUE(server_id, settlement_id)); the owner is the faction that holds
 *   the threshold of flags (capital 5 / city 3 / village 1).
 */

async function up(pool) {
  console.log('⚔️  Migration 115: Faction Wars flag claims');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS faction_flags (
      id            BIGSERIAL PRIMARY KEY,
      server_id     INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      map_name      TEXT NOT NULL DEFAULT 'nasdara',
      east          NUMERIC(12,4) NOT NULL,
      north         NUMERIC(12,4) NOT NULL,
      settlement_id TEXT,
      faction_id    INTEGER NOT NULL REFERENCES factions(id) ON DELETE CASCADE,
      placed_by     TEXT NOT NULL,
      radius_m      NUMERIC(8,2) NOT NULL DEFAULT 100,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (server_id, faction_id, east, north),
      CHECK (radius_m >= 25 AND radius_m <= 1000),
      CHECK (char_length(placed_by) BETWEEN 1 AND 200)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_faction_flags_server
      ON faction_flags(server_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS faction_claims (
      id            BIGSERIAL PRIMARY KEY,
      server_id     INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      settlement_id TEXT NOT NULL,
      faction_id    INTEGER NOT NULL REFERENCES factions(id) ON DELETE CASCADE,
      flags_needed  INTEGER NOT NULL,
      flags_met     INTEGER NOT NULL,
      claimed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (server_id, settlement_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_faction_claims_server
      ON faction_claims(server_id)
  `);

  console.log('✅ Migration 115 complete');
}

module.exports = { up };
