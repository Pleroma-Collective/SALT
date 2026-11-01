'use strict';

/*
 * server-health-indicator-test.js
 *
 * Fixture suite for the server-health indicator + the 1.30 [Shutdown]
 * tracking fix (card t_e60827a8). All deterministic — no live data, no DB.
 *
 *   - SCHEDULED-RESTART DETECTION ON REAL 1.30 LOGS: the committed fixture
 *     scripts/fixtures/server-log-130-scheduled.txt is a verbatim 841-line
 *     slice of a real DayZ 1.30.164200.56 rolling server.log (SALT XB,
 *     2026-10-23) covering the previous session's [Shutdown] save line and
 *     the current session's BIOS registration. previousSessionScheduledShutdown
 *     must return true for it — this is the acceptance test for the 1.30
 *     regression where [Shutdown] lines moved out of the RPT into server.log.
 *   - The same real slice feeds the 1.30 `shutdowns` signal through
 *     extractSignals (countdown lines must surface with remainingSeconds).
 *   - extractSignals raw volume counters (RPT `!!!` error lines, `Warning`
 *     lines) — the error/warning half of the indicator.
 *   - detectPredictiveWarnings logTotals + warningSummary health state
 *     (critical / degraded / healthy / unknown) against injected RPT tails.
 *   - The dashboard-ops panel renders the health chip + counts, and a
 *     critical crash outranks other items on the attention strip.
 */

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const ROOT = path.join(__dirname, '..');
const logIntel = require(path.join(ROOT, 'services', 'logIntelligenceService'));
const ops = require(path.join(ROOT, 'services', 'opsIntelligenceService'));
const shopRestart = require(path.join(ROOT, 'services', 'shopRestartService'));
const dzcOps = require(path.join(ROOT, 'public', 'js', 'dashboard-ops.js'));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── 1. Real 1.30 server.log fixture ────────────────────────────────────────
//
// The fixture's session re-registered with BIOS at local time 11:52:47
// (line: "11:52:47 Connected to BIOS (server registration) ..."), so the
// provider start time under a UTC node is 2026-10-23T11:52:47Z.
const REAL_LOG = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'server-log-130-scheduled.txt'),
  'utf8'
);
const START_130 = Date.parse('2026-10-23T11:52:47Z');

test('real 1.30 server.log: previous-session save line → scheduled (true)', () => {
  assert.strictEqual(shopRestart.previousSessionScheduledShutdown(REAL_LOG, START_130), true);
});

test('real 1.30 server.log: a 14h-offset node still matches the start', () => {
  // Same wall-clock evidence, node 14h ahead of the provider clock.
  assert.strictEqual(shopRestart.previousSessionScheduledShutdown(REAL_LOG, START_130 + 14 * 3600e3), true);
});

// (A stale-file test is not expressible with this fixture: server.log lines
// carry NO date, so any provider start matches some ±14h timezone offset.
// The dated-timestamp stale case is covered by
// shop-restart-scheduled-shutdown-test.js.)

test('real 1.30 server.log: countdown line feeds the shutdowns signal', () => {
  const signals = logIntel.extractSignals(REAL_LOG.split('\n'), logIntel.loadKnownIssues(), '2026-10-23');
  assert.ok(signals.shutdowns.length >= 1, 'countdown lines extract as shutdowns');
  assert.ok(signals.shutdowns.some(s => s.remainingSeconds === 60), 'the 60s countdown is present');
  assert.ok(signals.shutdowns.every(s => Number.isFinite(s.atMs)), 'each shutdown carries a time');
});

// ── 2. Raw error/warning volume counters ───────────────────────────────────

test('extractSignals counts !!! error lines and Warning lines', () => {
  const lines = [
    ' 09:00:00.000 !!! [Inputs] Attempt to insert input twice "X"',
    ' 09:00:01.000 Warning Message: No entry config.bin/CfgWorlds',
    ' 09:00:02.000 !!! Error: second error',
    ' 09:00:03.000 plain line',
    ' 09:00:04.000 Warning: another warning',
  ];
  const s = logIntel.extractSignals(lines, logIntel.loadKnownIssues(), '2026-10-23');
  assert.equal(s.errorLines, 2);
  assert.equal(s.warningLines, 2);
});

test('extractSignals does not count 1.30 network noise', () => {
  const lines = [
    ' 09:00:00.000 !!! real error',
    ' 09:00:01.000 NETWORK: Simulate networked players',
    ' 09:00:02.000 PLAYER: Player Simulation entity 5',
  ];
  const s = logIntel.extractSignals(lines, logIntel.loadKnownIssues(), '2026-10-23');
  assert.equal(s.errorLines, 1);
  assert.equal(s.warningLines, 0);
});

// ── 3. logTotals + health state through detectPredictiveWarnings ───────────
//
// Temp configDir with one real-shaped RPT file; listFiles/readTail injected.
// File start = top of the current UTC hour minus 20 min, so fixture line
// times land inside the 24h lookback window on any run.

const HOUR_MS = 3600e3;
const startMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 20 * 60e3;

function rptName(ms) {
  const d = new Date(ms).toISOString();
  return `DayZServer_X1_x64_${d.slice(0, 10)}_${d.slice(11, 19).replace(/:/g, '-')}.RPT`;
}
function rptLine(offsetSec, text) {
  const t = new Date(startMs + offsetSec * 1000).toISOString().slice(11, 23);
  return `${t} ${text}`;
}

function tmpConfigDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh130-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content, 'utf8');
  return dir;
}

function depsFor(configDir) {
  return {
    listFiles: (dir) => fs.readdirSync(dir),
    readTail: (rootDir, filename, maxBytes) => {
      const text = fs.readFileSync(path.join(rootDir, filename), 'utf8');
      return Buffer.from(text, 'utf8').subarray(Math.max(0, text.length - maxBytes)).toString('utf8').split('\n');
    },
    configDir,
  };
}

function runDetection(lines) {
  const dir = tmpConfigDir({ [rptName(startMs)]: lines.join('\n') });
  try {
    return ops.detectPredictiveWarnings(depsFor(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const FAKE_ROWS = [
  { label: 'synthetic', severity: 'warning', occurrences: 1, lastSeenAt: new Date(startMs).toISOString(), sample: 's' },
];

test('warningSummary health: out-of-memory crash in window → critical', () => {
  const detection = runDetection([
    rptLine(10, 'Fatal error: out of memory — shutting down'),
    rptLine(20, '!!! [Inputs] Attempt to insert input twice "X"'),
    rptLine(30, 'Warning Message: No entry config.bin/CfgWorlds'),
  ]);
  assert.ok(detection.logTotals, 'detection carries logTotals');
  assert.equal(detection.logTotals.errorLines, 1);
  assert.equal(detection.logTotals.warningLines, 1);
  assert.ok(detection.logTotals.linesScanned > 0);
  const summary = ops.warningSummary(detection, []);
  assert.equal(summary.health.state, 'critical');
  assert.ok(summary.health.crashCount >= 1, 'fatal window counts as a crash');
  assert.ok(typeof summary.health.lastCrashAt === 'string');
  assert.equal(summary.health.errorLines, 1);
  assert.equal(summary.health.warningLines, 1);
  assert.equal(summary.health.windowHours, 24);
});

test('warningSummary health: active precursor only → degraded, no crash', () => {
  const detection = runDetection([
    rptLine(10, 'Error: Failed to spawn Object Litter_Small'),
  ]);
  const summary = ops.warningSummary(detection, FAKE_ROWS);
  assert.equal(summary.health.state, 'degraded');
  assert.equal(summary.health.crashCount, 0);
  assert.equal(summary.health.lastCrashAt, null);
  assert.equal(summary.health.errorLines, 0);
});

test('warningSummary health: clean logs, no precursors → healthy with real counts', () => {
  const detection = runDetection([
    rptLine(10, '*** CE Loop took 0.02 (sec)...'),
    rptLine(11, 'Warning Message: No entry config.bin/CfgWorlds'),
    rptLine(12, 'Warning Message: No entry config.bin/CfgWorlds'),
    rptLine(13, '!!! [Inputs] Attempt to insert input twice "X"'),
  ]);
  const summary = ops.warningSummary(detection, []);
  assert.equal(summary.health.state, 'healthy');
  assert.equal(summary.health.crashCount, 0);
  assert.equal(summary.health.errorLines, 1);
  assert.equal(summary.health.warningLines, 2);
  assert.ok(summary.health.linesScanned >= 4);
});

test('warningSummary health: no data (route empty-fallback shape) → unknown', () => {
  const summary = ops.warningSummary(
    { precursors: [], crashWindows: [], lastCrashAt: null, warnings: [], ceLoop: null },
    []
  );
  assert.equal(summary.health.state, 'unknown');
  assert.equal(summary.health.crashCount, 0);
  assert.equal(summary.health.errorLines, null);
  assert.equal(summary.health.warningLines, null);
  assert.equal(summary.health.linesScanned, null);
});

test('warningSummary health: scheduled restart window is not a crash', () => {
  // A countdown line only produces a restart-kind window (no fatal signal),
  // so the health state stays healthy even though a shutdown is recorded.
  const detection = runDetection([
    rptLine(10, '[Shutdown] Shutting down in 60 seconds.'),
  ]);
  assert.ok(detection.crashWindows.some(w => w.kind === 'restart'));
  const summary = ops.warningSummary(detection, []);
  assert.equal(summary.health.state, 'healthy');
  assert.equal(summary.health.crashCount, 0);
});

// ── 4. Dashboard panel: health chip + attention strip ──────────────────────

test('renderServerBlock shows the health chip + real counts', () => {
  const html = dzcOps.renderServerBlock({
    serverId: '1',
    serverName: 'Salty',
    summary: {
      activeWarnings: [],
      health: {
        state: 'critical', crashCount: 2, lastCrashAt: '2026-10-23T11:52:47.000Z',
        errorLines: 120, warningLines: 340, linesScanned: 5000, windowHours: 24,
      },
    },
    warningsError: null, rollback: null, rollbackError: null,
  }, null);
  assert.ok(html.includes('Server health'), 'section label renders');
  assert.ok(html.includes('data-state="critical"'), 'state chip renders');
  assert.ok(html.includes('2 crashes (24h)'));
  assert.ok(html.includes('120 errors'));
  assert.ok(html.includes('340 warnings'));
});

test('renderServerBlock: legacy summary without health renders no health block', () => {
  const html = dzcOps.renderServerBlock({
    serverId: '2',
    serverName: 'Old',
    summary: { activeWarnings: [] },
    warningsError: null, rollback: null, rollbackError: null,
  }, null);
  assert.ok(!html.includes('Server health'));
});

test('opsAttentionItems: a 24h crash outranks warnings on the strip', () => {
  const items = dzcOps.opsAttentionItems({
    7: {
      serverId: 7,
      serverName: 'Salty',
      summary: {
        activeWarnings: [{ label: 'tick slow', severity: 'high', occurrences: 10 }],
        health: { state: 'critical', crashCount: 1, lastCrashAt: '2026-10-23T11:52:47.000Z', windowHours: 24 },
      },
      warningsError: null, rollback: null, rollbackError: null,
    },
  });
  assert.equal(items[0].severity, 'danger');
  assert.ok(items[0].text.includes('health: 1 crash'));
});

console.log(`\n✅ server-health-indicator-test passed: ${passed}/${passed}`);
