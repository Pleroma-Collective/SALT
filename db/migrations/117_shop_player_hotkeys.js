/*
 * Migration 116 — Per-player shop item hotkeys
 *
 * A player binds one keyboard key (letter, digit, or F1-F12) to a shop item
 * on a specific server. Pressing the key on the shop page spawns the item at
 * the player's last-known in-game location (newest player_position_snapshots
 * row) and checks it out immediately. The binding is keyed
 * (server_id, identity_id, hotkey) so it scales per server.
 */

async function up(pool) {
  console.log('🎯 Migration 116: Add shop player hotkeys');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_player_hotkeys (
      id           BIGSERIAL PRIMARY KEY,
      server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      identity_id  INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      shop_item_id INTEGER NOT NULL REFERENCES shop_items(id) ON DELETE CASCADE,
      hotkey       TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(server_id, identity_id, hotkey)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_shop_player_hotkeys_server_identity
      ON shop_player_hotkeys(server_id, identity_id)
  `);

  console.log('✅ Migration 116 complete');
}

module.exports = { up };
