#!/usr/bin/env node
'use strict';
/**
 * Launch the dashboard on the HOST against the local postgres (node 22), with
 * the local-testing backdoor enabled. Prints the test-login URL + token, then
 * runs server.js in-process (child) and streams its output.
 *
 *   npm run local:host          # node scripts/local-host-run.js
 *   # or, pinned to node 22:
 *   /home/salt/.nvm/versions/node/v22.23.3/bin/node scripts/local-host-run.js
 *
 * The backdoor is inert unless DEPLOYMENT_MODE=local && TEST_ADMIN_TOKEN is set
 * (both applied here) — it never activates in production.
 */
const path = require('path');
const { spawn } = require('child_process');
const { localHostEnv, ROOT } = require('./local-host-env');

const major = parseInt(process.versions.node.split('.')[0], 10);
if (major !== 22) {
  console.warn(`⚠️  Running on node ${process.versions.node}; the project targets node 22.`);
  console.warn('   Preferred: /home/salt/.nvm/versions/node/v22.23.3/bin/node');
}

const env = localHostEnv();
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' DayZ Dashboard — LOCAL TESTING (host run)');
console.log(`   Dashboard  : http://127.0.0.1:${env.PORT}`);
console.log(`   Test login : http://127.0.0.1:${env.PORT}/auth/test-login?token=${env.TEST_ADMIN_TOKEN}`);
console.log(`   DB         : ${env.POSTGRES_USER}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code || 0));
});
