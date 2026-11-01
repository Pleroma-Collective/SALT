// One-shot backfill: persist 'player.death_cause' events from already-downloaded
// ADM logs into the events table (idempotent — existing dedupeKeys are skipped).
//
// Usage:
//   INTERNAL_SERVER_ID=<internal servers.id> ENCRYPTION_KEY=... \
//     node scripts/backfill-adm-death-causes.js <configDir>
//
// <configDir> is a log-sync downloads config dir (e.g.
// downloads/<guildDiscordId>/server_<platformServerId>/config) containing
// DayZServerP_X1_x64_YYYY-MM-DD_HH-MM-SS.ADM files.
(async () => {
  try {
    if (!process.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is required');
    const configDir = process.argv[2];
    const internalServerId = Number(process.env.INTERNAL_SERVER_ID);
    if (!configDir || !Number.isInteger(internalServerId) || internalServerId <= 0) {
      throw new Error('configDir argument and INTERNAL_SERVER_ID are required');
    }
    const fs = require('fs');
    const path = require('path');
    const { initializeDatabase, closeDatabase } = require('../db/abstraction');
    const { processAdmDeathCauses } = require('../routes/logParser');

    const admFiles = fs.readdirSync(configDir)
      .filter(f => /\.ADM$/i.test(f))
      .sort()
      .map(f => path.join(configDir, f));
    if (admFiles.length === 0) throw new Error(`No ADM files found in ${configDir}`);

    const db = await initializeDatabase();
    try {
      console.log(`Backfilling ${admFiles.length} ADM files for server ${internalServerId}…`);
      const result = await processAdmDeathCauses(db, {
        baseDir: configDir,
        admFiles,
        serverContext: { id: internalServerId },
      });
      console.log('BACKFILL_RESULT:', result);
    } finally {
      await closeDatabase();
    }
  } catch (err) {
    console.error('FATAL:', err && err.stack ? err.stack : err);
    process.exitCode = 2;
  }
})();
