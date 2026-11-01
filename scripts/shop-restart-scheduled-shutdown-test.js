'use strict';

// Test: 1.30 scheduled-shutdown evidence (rolling console server.log).
// Covers the exported shopRestartService helpers added for DayZ 1.30, where
// [Shutdown] lines live only in the rolling server.log, not the per-run RPT.

const assert = require('assert');

const {
  previousSessionScheduledShutdown,
  timeOnlyTimestampMatchesProviderStart,
} = require('../services/shopRestartService');

const BIOS_A = 'Connected to BIOS (server registration) with id aaaaaaaa-1111-4bbb-8ccc-000000000001';
const BIOS_B = 'Connected to BIOS (server registration) with id bbbbbbbb-2222-4bbb-8ccc-000000000002';
const SAVE = '[Shutdown] Saving players, locking server and kicking all players.';
const COUNTDOWN = '[Shutdown] Shutting down in 60';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// start = 2026-10-16T12:00:00Z (UTC)
const START_UTC = Date.parse('2026-10-16T12:00:00Z');
const START_MIDNIGHT = Date.parse('2026-10-16T00:05:00Z');

console.log('timeOnlyTimestampMatchesProviderStart');
test('matches UTC node (0h offset)', () => {
  assert.strictEqual(timeOnlyTimestampMatchesProviderStart('12:00:00', START_UTC), true);
});
test('matches UTC+5 node', () => {
  assert.strictEqual(timeOnlyTimestampMatchesProviderStart('17:00:00', START_UTC), true);
});
test('matches across midnight (UTC-7 node)', () => {
  assert.strictEqual(timeOnlyTimestampMatchesProviderStart('17:05:00', START_MIDNIGHT), true);
});
test('rejects malformed inputs', () => {
  assert.strictEqual(timeOnlyTimestampMatchesProviderStart('12:00', START_UTC), false);
  assert.strictEqual(timeOnlyTimestampMatchesProviderStart('99:00:00', START_UTC), false);
  assert.strictEqual(timeOnlyTimestampMatchesProviderStart('abc', START_UTC), false);
  assert.strictEqual(timeOnlyTimestampMatchesProviderStart('12:00:00', NaN), false);
  assert.strictEqual(timeOnlyTimestampMatchesProviderStart(null, START_UTC), false);
});

console.log('previousSessionScheduledShutdown');
test('scheduled: save line in previous region (time-only, UTC node)', () => {
  const log = [
    '11:55:00 ' + BIOS_A,
    '11:58:00 ' + COUNTDOWN,
    '11:59:59 ' + SAVE,
    '12:00:00 ' + BIOS_B,
    '12:00:10 Server started',
  ].join('\n');
  assert.strictEqual(previousSessionScheduledShutdown(log, START_UTC), true);
});
test('scheduled: save line in previous region (dated, UTC+5 node)', () => {
  const log = [
    '2026-10-16 16:00:00 ' + BIOS_A,
    '2026-10-16 16:05:59 ' + SAVE,
    '2026-10-16 17:00:00 ' + BIOS_B,
    '2026-10-16 17:00:10 Server started',
  ].join('\n');
  assert.strictEqual(previousSessionScheduledShutdown(log, START_UTC), true);
});
test('crash: no shutdown lines in previous region', () => {
  const log = [
    '11:55:00 ' + BIOS_A,
    '11:58:00 ERROR: something broke',
    '12:00:00 ' + BIOS_B,
    '12:00:10 Server started',
  ].join('\n');
  assert.strictEqual(previousSessionScheduledShutdown(log, START_UTC), false);
});
test('defers to RPT: bare countdown (pre-1.30 tail) yields null', () => {
  const log = [
    '11:55:00 ' + BIOS_A,
    '11:58:00 ' + COUNTDOWN,
    '12:00:00 ' + BIOS_B,
    '12:00:10 Server started',
  ].join('\n');
  assert.strictEqual(previousSessionScheduledShutdown(log, START_UTC), null);
});
test('stale file (timestamps far from provider start) yields null', () => {
  const log = [
    '2026-01-01 09:00:00 ' + BIOS_A,
    '2026-01-01 10:05:59 ' + SAVE,
  ].join('\n');
  assert.strictEqual(previousSessionScheduledShutdown(log, START_UTC), null);
});
test('undecidable BIOS (no timestamp) falls back to previous region', () => {
  const log = [
    '11:55:00 ' + BIOS_A,
    '11:59:59 ' + SAVE,
    BIOS_B,
    '12:00:10 Server started',
  ].join('\n');
  assert.strictEqual(previousSessionScheduledShutdown(log, START_UTC), true);
});
test('empty / null content yields null', () => {
  assert.strictEqual(previousSessionScheduledShutdown('', START_UTC), null);
  assert.strictEqual(previousSessionScheduledShutdown(null, START_UTC), null);
});

console.log(`\n✅ shop-restart-scheduled-shutdown-test passed: ${passed}/${passed}`);
