#!/usr/bin/env node
/**
 * server-session-state-test.js — card t_c1de9125
 *
 * "Server days funded / time left" indicator:
 *   - shared pure helpers (services/sessionStateService.js)
 *   - the bot-side upsert (fake pool, SQL + param shape)
 *   - source contracts: the bot status loop persists session state with the
 *     computed restart, and the web surfaces read it DB-only.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  normalizeStatus,
  shouldRefreshFunding,
  fundedUntilMs,
  daysFunded,
  sessionView,
  recordSessionState,
  FUNDING_REFRESH_MS,
} = require('../services/sessionStateService');

const NOW = Date.parse('2026-10-27T12:00:00.000Z');

// ── pure helpers ──────────────────────────────────────────────────────────

function testNormalizeStatus() {
  assert.strictEqual(normalizeStatus('started'), 'started');
  assert.strictEqual(normalizeStatus('stopped'), 'stopped');
  assert.strictEqual(normalizeStatus('paused'), null);
  assert.strictEqual(normalizeStatus(null), null);
}

function testShouldRefreshFundingGate() {
  assert.strictEqual(shouldRefreshFunding(null, NOW), true, 'never observed → refresh');
  assert.strictEqual(shouldRefreshFunding(0, NOW), true, 'zero → refresh');
  assert.strictEqual(shouldRefreshFunding(NOW - 11 * 60 * 60 * 1000, NOW), false, '11h → hold');
  assert.strictEqual(shouldRefreshFunding(NOW - FUNDING_REFRESH_MS, NOW), true, '12h → refresh');
  assert.strictEqual(shouldRefreshFunding(NOW - FUNDING_REFRESH_MS - 1, NOW), true, '>12h → refresh');
}

function testFundedUntilConversion() {
  const observed = Date.parse('2026-10-27T12:00:00.000Z');
  assert.strictEqual(fundedUntilMs(2592000, observed), observed + 2592000 * 1000, '30 days out');
  assert.strictEqual(fundedUntilMs(0, observed), observed, 'zero seconds');
  assert.strictEqual(fundedUntilMs(-5, observed), null, 'negative → null');
  assert.strictEqual(fundedUntilMs('garbage', observed), null, 'non-numeric → null');
  assert.strictEqual(fundedUntilMs(100, null), null, 'no observation time → null');
}

function testDaysFunded() {
  assert.strictEqual(daysFunded(null, NOW), 0, 'unknown → 0');
  assert.strictEqual(daysFunded(NOW - 1000, NOW), 0, 'expired → 0');
  assert.strictEqual(daysFunded(NOW + 23.5 * 86400000, NOW), 23, '23.5 days → 23');
  assert.strictEqual(daysFunded(NOW + 2 * 86400000, NOW), 2, 'whole days');
}

function testSessionViewClampsStaleRestart() {
  const started = new Date(NOW - 3 * 3600000).toISOString(); // 3h ago
  const row = (over = {}) => ({
    session_started_at: started,
    next_restart_at: new Date(NOW + 3600000).toISOString(),
    funded_until: new Date(NOW + 23 * 86400000).toISOString(),
    funding_observed_at: started,
    ...over,
  });
  const view = sessionView(row(), NOW);
  assert.strictEqual(view.sessionStartedAt, started);
  assert.ok(view.nextRestartAt > new Date(NOW).toISOString(), 'future restart kept');
  assert.strictEqual(view.daysFunded, 23);

  const justPassed = sessionView(row({
    next_restart_at: new Date(NOW - 10 * 60000).toISOString(), // 10 min ago
  }), NOW);
  assert.ok(justPassed.nextRestartAt, 'restart inside the 30-min reboot window is kept');

  const stale = sessionView(row({
    next_restart_at: new Date(NOW - 2 * 3600000).toISOString(), // 2h ago
  }), NOW);
  assert.strictEqual(stale.nextRestartAt, null, 'restart >30min in the past is stale');

  const beforeSession = sessionView(row({
    next_restart_at: new Date(NOW - 4 * 3600000).toISOString(), // before session start
  }), NOW);
  assert.strictEqual(beforeSession.nextRestartAt, null, 'restart older than session start is stale');

  const empty = sessionView(null, NOW);
  assert.deepStrictEqual(empty, {
    sessionStartedAt: null, nextRestartAt: null, fundedUntil: null, daysFunded: 0,
  });
}

// ── bot-side upsert (fake pool) ───────────────────────────────────────────

function fakePool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; },
  };
}

async function testRecordSessionStateUpsert() {
  const pool = fakePool();
  const startedMs = NOW - 3 * 3600000;
  await recordSessionState(pool, {
    serverId: 7,
    status: 'started',
    sessionStartedAtMs: startedMs,
    nextRestartAtMs: NOW + 3600000,
    fundedUntilMs: NOW + 23 * 86400000,
    fundingObservedAtMs: NOW,
  });
  assert.strictEqual(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.ok(/INSERT INTO server_session_state/i.test(sql), 'targets server_session_state');
  assert.ok(/ON CONFLICT \(server_id\) DO UPDATE/i.test(sql), 'upsert, not insert-only');
  // Funding preservation lives in the DO UPDATE branch — the target table is
  // not referenceable inside the VALUES clause (caught on prod, card t_c1de9125).
  assert.ok(/COALESCE\(EXCLUDED\.funded_until, server_session_state\.funded_until\)/.test(sql),
    'stored funding preserved when no fresh observation');
  assert.ok(/COALESCE\(EXCLUDED\.funding_observed_at, server_session_state\.funding_observed_at\)/.test(sql),
    'stored funding observation preserved');
  assert.strictEqual(params[0], 7);
  assert.strictEqual(params[1], 'started');
  assert.strictEqual(params[2].getTime(), startedMs);
  assert.strictEqual(params[3].getTime(), NOW + 3600000);
  assert.strictEqual(params[5].getTime(), NOW);

  // No fresh funding observation → $5/$6 stay null so the stored values win.
  await recordSessionState(pool, {
    serverId: 7,
    status: 'started',
    sessionStartedAtMs: NOW,
    nextRestartAtMs: null,
    fundedUntilMs: null,
    fundingObservedAtMs: null,
  });
  assert.strictEqual(pool.calls[1].params[4], null);
  assert.strictEqual(pool.calls[1].params[5], null);
  assert.strictEqual(pool.calls[1].params[3], null, 'no scheduled restart → null');
}

// ── source contracts (wiring) ─────────────────────────────────────────────

function readRepoFile(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function testBotLoopPersistsSessionState() {
  const source = readRepoFile('bot/services/serverStatusService.js');
  assert.ok(/require\('\.\.\/\.\.\/services\/sessionStateService'\)/.test(source),
    'bot status loop requires the shared session-state service');
  assert.ok(/persistSessionState\(server_db_id, token, gameserver, restartAtMs\)/.test(source),
    'status loop persists session state with the computed restart time');
  assert.ok(/nitradoService\.getServiceDetails\(token, serviceId\)/.test(source),
    'funding comes from the provider service-details call');
  assert.ok(/shouldRefreshFunding\(fundingRefreshAt\.get/.test(source),
    'funding fetch is gated by the 12h refresh cadence');
}

function testWebSurfacesReadSessionState() {
  const overview = readRepoFile('services/serverMetricsService.js');
  assert.ok(/FROM server_session_state WHERE server_id = \?/.test(overview),
    'dashboard overview reads session state from the DB');
  assert.ok(/session,/.test(overview), 'overview response carries the session block');

  const portal = readRepoFile('routes/playerPortal.js');
  assert.ok(/LEFT JOIN server_session_state sst ON sst\.server_id = s\.id/.test(portal),
    'player portal guild servers join session state');
  assert.ok(/\.\.\.sessionView\(server\)/.test(portal),
    'portal server entries carry the session view fields');

  const appShellJs = readRepoFile('public/js/app-shell.js');
  assert.ok(/sessionText\(data && data\.session\)/.test(appShellJs),
    'dashboard pill renders the overview session block');
  const pill = readRepoFile('utils/appShell.js');
  assert.ok(/dzc-pill-session/.test(pill), 'pill markup carries the session segment');
  const portalJs = readRepoFile('public/js/player-portal.js');
  assert.ok(/formatSessionLine\(server\)/.test(portalJs),
    'player portal guild cards render the session line');
}

// ── run ───────────────────────────────────────────────────────────────────

(async () => {
  const tests = [
    testNormalizeStatus,
    testShouldRefreshFundingGate,
    testFundedUntilConversion,
    testDaysFunded,
    testSessionViewClampsStaleRestart,
    testRecordSessionStateUpsert,
    testBotLoopPersistsSessionState,
    testWebSurfacesReadSessionState,
  ];
  for (const test of tests) {
    await test();
    console.log(`✅ ${test.name}`);
  }
  console.log(`\n🎉 server-session-state-test: ${tests.length}/${tests.length} passed`);
})().catch(err => {
  console.error('❌ server-session-state-test failed:', err);
  process.exit(1);
});
