/*
 * Migration 114 — Alt auto-ban audit + global settings
 *
 * alt_auto_bans: one row per auto-ban executed by the conservative
 * policy in services/altAutoBanService.js (definitive RPT-enforced
 * wait evidence only). The row is written in the same provider
 * mutation transaction that edits ban.txt, so a failed ban never
 * leaves an audit row and vice versa.
 *
 * app_settings: minimal global key/value store; currently holds the
 * alt auto-ban kill switch ('alt_auto_ban_disabled').
 */

async function up(pool) {
  console.log('⚡ Migration 114: Alt auto-ban audit + global settings');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alt_auto_bans (
      id          BIGSERIAL PRIMARY KEY,
      server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      gamertag    TEXT NOT NULL,
      signal      TEXT NOT NULL DEFAULT 'rpt_login_wait',
      evidence    JSONB NOT NULL DEFAULT '{}'::jsonb,
      review_id   BIGINT REFERENCES alt_account_reviews(id) ON DELETE SET NULL,
      triggered_by TEXT NOT NULL DEFAULT 'autoban:alt_policy',
      banned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_alt_auto_bans_server_time
      ON alt_auto_bans (server_id, banned_at DESC)
  `);

  console.log('✅ Migration 114 complete');
}

module.exports = { up };
