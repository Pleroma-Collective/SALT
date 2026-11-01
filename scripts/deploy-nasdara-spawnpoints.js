'use strict';
/* One-shot deploy: nasdara cfgplayerspawnpoints.xml (T1 spawn groups).
 * Backup -> upload -> verify (re-download byte compare).
 * Run from the dayz-dashboard repo root on the prod host (saltskrew).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initializeDatabase, closeDatabase } = require('../db/abstraction');
const rotation = require('../services/rotationService');
const { getGuildTokenForServer } = require('../utils/guildTokens');

const PLATFORM_SERVER_ID = '789326430571855893'; // S.A.L.T XB
const FILE = 'cfgplayerspawnpoints.xml';
const NEW_CONTENT = fs.readFileSync(process.argv[2], 'utf8');

(async () => {
  const db = await initializeDatabase();
  // Nitrado token for the guild owning this platform server (same path as app routes)
  const token = await getGuildTokenForServer(db, PLATFORM_SERVER_ID);
  if (!token) throw new Error('no Nitrado token for ' + PLATFORM_SERVER_ID);
  const platformServerId = PLATFORM_SERVER_ID;

  const missionPath = await rotation.resolveMissionPath(token, platformServerId);
  const remoteFile = `${missionPath}/${FILE}`;
  console.log('mission path:', missionPath);

  // 1. backup
  const current = await rotation.downloadFile(token, platformServerId, remoteFile);
  if (current === null) throw new Error('backup download failed — ABORTING, no upload');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${FILE}.backup-${stamp}`;
  fs.mkdirSync('/home/salt/backups', { recursive: true });
  fs.writeFileSync(path.join('/home/salt/backups', backupName), current, 'utf8');
  console.log('backup saved:', backupName, `(${current.length} bytes)`);

  // 2. pre-flight: new content must be well-formed XML with more groups
  const groupsBefore = (current.match(/<group /g) || []).length;
  const groupsAfter = (NEW_CONTENT.match(/<group /g) || []).length;
  if (!(groupsAfter > groupsBefore)) throw new Error('sanity: group count did not increase');
  if (!NEW_CONTENT.includes('playerspawnpoints')) throw new Error('sanity: not a playerspawnpoints file');
  console.log(`groups: ${groupsBefore} -> ${groupsAfter}`);

  // 3. upload
  await rotation.uploadFile(token, platformServerId, missionPath, FILE, NEW_CONTENT);
  console.log('upload done');

  // 4. verify: re-download and compare
  const after = await rotation.downloadFile(token, platformServerId, remoteFile);
  if (after === null) throw new Error('verify download failed');
  if (after !== NEW_CONTENT) throw new Error('VERIFY FAILED: live file != uploaded content');
  console.log('VERIFIED: live file matches uploaded content byte-for-byte');

  await closeDatabase();
  console.log('DEPLOY OK');
})().catch(async (e) => {
  console.error('DEPLOY FAILED:', e.message);
  try { await closeDatabase(); } catch (_) {}
  process.exit(1);
});
