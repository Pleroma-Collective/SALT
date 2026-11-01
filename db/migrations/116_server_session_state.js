/**
 * Migration 116: server session state
 *
 * Per-server "session time left / days funded" indicator (card t_c1de9125).
 *
 * Written by the bot's 5-minute status loop (bot/services/serverStatusService.js):
 *   - status / session_started_at — Nitrado gameserver status + last_status_change
 *     (the provider-side restart anchor; updates across restarts without log parsing)
 *   - next_restart_at — the scheduled restart already computed for the Discord
 *     status channels (messages.xml deadline + RPT/boot anchor + [Shutdown]
 *     server.log refinement in serverStatusService.fetchRestartFromXml)
 *   - funded_until / funding_observed_at — Nitrado service-details
 *     suspending_in seconds observed at funding_observed_at; funded_until is a
 *     wall-clock instant that stays true between refreshes (refreshed ~12h)
 *
 * Read by the dashboard pill (services/serverMetricsService.js overview) and
 * the player portal (routes/playerPortal.js /api/player/guilds) — DB-only reads,
 * no provider calls from web pages.
 */
async function up(pool) {
  console.log('🔄 Migration 116: server session state');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_session_state (
      server_id          INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      status             TEXT,
      session_started_at TIMESTAMPTZ,
      next_restart_at    TIMESTAMPTZ,
      funded_until       TIMESTAMPTZ,
      funding_observed_at TIMESTAMPTZ,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('  ✓ server_session_state');
}

async function down(pool) {
  await pool.query(`DROP TABLE IF EXISTS server_session_state`);
}

module.exports = { up, down };
