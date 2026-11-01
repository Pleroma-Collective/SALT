#!/usr/bin/env node
'use strict';

/*
 * Live "recently spawned loot" layer (card t_c2d2a7e2) — parser, map-bounds
 * validation, dedupe, and the dir-explicit service core
 * (readRecentLootSpawnsFromDir) against a temp server.log.
 *
 * Acceptance covered here:
 *   - real recent spawns parsed at real coords (item + east/north)
 *   - ages correctly (ageMs relative to newest; window filter)
 *   - no crash on bad/out-of-range coords (rejected, never returned)
 *   - no spawn rates/odds exposed (only per-event item/coord/time)
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const root = path.resolve(__dirname, '..');
const {
  parseLootAddingLine,
  validateLootPosition,
  parseLootSpawns,
} = require(path.join(root, 'utils', 'lootSpawns.js'));
const { readRecentLootSpawnsFromDir } = require(path.join(root, 'services', 'lootLiveService.js'));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + name);
}

(async () => {
  // ── parseLootAddingLine ─────────────────────────────────────────────────────
  await check('parse: valid Adding line → {clock, item, x, z}', async () => {
    const r = parseLootAddingLine('11:16:20   Adding ShortJeans_Brown at [8554,8678]');
    assert.deepStrictEqual(r, { clock: '11:16:20', item: 'ShortJeans_Brown', x: 8554, z: 8678 });
  });

  await check('parse: tolerates fractional coords + CRLF + millisecond clock', async () => {
    const r = parseLootAddingLine('11:16:20.387  Adding Bandage at [1234.5, -678.9]\r');
    assert.ok(r);
    assert.strictEqual(r.item, 'Bandage');
    assert.strictEqual(r.x, 1234.5);
    assert.strictEqual(r.z, -678.9);
    assert.strictEqual(r.clock, '11:16:20.387');
  });

  await check('parse: player-login Adding line is NOT a loot spawn (no coords)', async () => {
    assert.strictEqual(parseLootAddingLine('11:16:20 [Login]: Adding player Kitty to the game'), null);
  });

  await check('parse: malformed coordinate lines → null (never a bad point)', async () => {
    assert.strictEqual(parseLootAddingLine('11:16:20 Adding Bandage at [8554'), null);
    assert.strictEqual(parseLootAddingLine('11:16:20 Adding Bandage at []'), null);
    assert.strictEqual(parseLootAddingLine('11:16:20 Adding  at [1,2]'), null);
    assert.strictEqual(parseLootAddingLine('unrelated RPT noise'), null);
  });

  // ── validateLootPosition ────────────────────────────────────────────────────
  await check('bounds: in-map position accepted (nasdara)', async () => {
    assert.strictEqual(validateLootPosition({ x: 8554, z: 8678 }, 'nasdara'), true);
    assert.strictEqual(validateLootPosition({ x: 0, z: 0 }, 'nasdara'), true);
  });

  await check('bounds: out-of-map / NaN positions rejected', async () => {
    assert.strictEqual(validateLootPosition({ x: 99999, z: 100 }, 'nasdara'), false); // > worldWidth
    assert.strictEqual(validateLootPosition({ x: -5, z: 100 }, 'nasdara'), false);    // negative
    assert.strictEqual(validateLootPosition({ x: 123.4, z: 50000 }, 'enoch'), false); // wrong map bounds
    assert.strictEqual(validateLootPosition({ x: NaN, z: 100 }, 'nasdara'), false);
    assert.strictEqual(validateLootPosition(null), false);
  });

  // ── parseLootSpawns (dedupe + reject + streaming) ───────────────────────────
  await check('parseMany: dedupes identical lines, rejects out-of-range, streams async input', async () => {
    const lines = [
      '11:00:00 Adding WoundedRag at [1000,2000]',
      '11:00:00 Adding WoundedRag at [1000,2000]', // exact dup
      '12:00:00 Adding BadLoot at [99999,100]',     // out of range
      'noise line',
      '12:45:00 Adding ShortJeans_Brown at [8554,8678]',
    ];
    // async generator input (mirrors streamLogTail)
    async function* gen() { for (const l of lines) yield l; }
    const res = await parseLootSpawns(gen(), { mapName: 'nasdara' });
    assert.strictEqual(res.spawns.length, 2);
    assert.strictEqual(res.rejected, 1);
    assert.strictEqual(res.duplicates, 1);
    assert.deepStrictEqual(res.spawns.map(s => s.item), ['WoundedRag', 'ShortJeans_Brown']);
  });

  await check('parseMany: shared seen Set dedupes across "files"', async () => {
    const seen = new Set();
    await parseLootSpawns(['11:00:00 Adding Bandage at [10,20]'], { mapName: 'nasdara', seen });
    const second = await parseLootSpawns(['11:00:00 Adding Bandage at [10,20]'], { mapName: 'nasdara', seen });
    assert.strictEqual(second.spawns.length, 0);
    assert.strictEqual(second.duplicates, 1);
  });

  // ── service core: readRecentLootSpawnsFromDir (temp server.log) ─────────────
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loot-spawns-test-'));
  try {
    const logDir = path.join(baseDir, 'guild', '42');
    fs.mkdirSync(logDir, { recursive: true });

    // Anchor the file's mtime to a fixed date so clock→timestamp is
    // deterministic. Clocks below are all on that date.
    const anchor = new Date('2026-10-28T12:45:00Z');
    const logLines = [
      '2026-10-28 09:12:01 [3] Mission: DayZServerP — unrelated noise',
      '11:00:00 Adding WoundedRag at [1000,2000]',   // outside 60-min window (1h45m old)
      '11:30:00 Adding WoundedRag at [1000,2000]',   // outside 60-min window (1h15m old)
      '12:00:00 Adding Bandage at [3000,4000]',     // in window (45m old)
      '12:00:00 Adding Bandage at [3000,4000]',     // exact duplicate
      '12:30:00 Adding BadLoot at [99999,100]',      // out-of-range → rejected
      '12:45:00 Adding ShortJeans_Brown at [8554,8678]', // newest (0 old)
    ].join('\n') + '\n';
    const logPath = path.join(logDir, 'server.log');
    fs.writeFileSync(logPath, logLines, { encoding: 'utf8' });
    fs.utimesSync(logPath, anchor, anchor);

    await check('service: returns real recent spawns at real coords, newest-first', async () => {
      const res = await readRecentLootSpawnsFromDir(logDir, 'nasdara', { windowMinutes: 60, limit: 500 });
      assert.strictEqual(res.error, null);
      assert.strictEqual(res.count, 2);
      assert.deepStrictEqual(res.spawns.map(s => s.item), ['ShortJeans_Brown', 'Bandage']);
      const newest = res.spawns[0];
      assert.strictEqual(newest.item, 'ShortJeans_Brown');
      assert.strictEqual(newest.east, 8554);
      assert.strictEqual(newest.north, 8678);
      assert.strictEqual(newest.ageMs, 0);
      assert.strictEqual(res.spawns[1].item, 'Bandage');
      assert.strictEqual(res.spawns[1].east, 3000);
      assert.strictEqual(res.spawns[1].north, 4000);
      assert.strictEqual(res.spawns[1].ageMs, 45 * 60 * 1000);
    });

    await check('service: counts rejected + duplicates; corrupt coords never returned', async () => {
      const res = await readRecentLootSpawnsFromDir(logDir, 'nasdara', { windowMinutes: 60, limit: 500 });
      assert.strictEqual(res.rejected, 1);      // the [99999,100] line
      assert.strictEqual(res.duplicates, 1);     // the dup Bandage line
      assert.ok(res.spawns.every(s => Number.isFinite(s.east) && Number.isFinite(s.north)));
      assert.ok(res.spawns.every(s => s.item && typeof s.item === 'string'));
    });

    await check('service: ages correctly — older-than-window spawns are dropped', async () => {
      const res = await readRecentLootSpawnsFromDir(logDir, 'nasdara', { windowMinutes: 60, limit: 500 });
      assert.ok(!res.spawns.some(s => s.item === 'WoundedRag'), '11:00/11:30 spawns are >60m old');
      assert.strictEqual(res.newestMs, Date.UTC(2026, 9, 28, 12, 45, 0));
    });

    await check('service: smaller window trims to the freshest spawns', async () => {
      const res = await readRecentLootSpawnsFromDir(logDir, 'nasdara', { windowMinutes: 30, limit: 500 });
      assert.deepStrictEqual(res.spawns.map(s => s.item), ['ShortJeans_Brown']);
      assert.strictEqual(res.count, 1);
    });

    await check('service: limit caps the returned spawn count', async () => {
      const res = await readRecentLootSpawnsFromDir(logDir, 'nasdara', { windowMinutes: 60, limit: 1 });
      assert.strictEqual(res.count, 1);
      assert.strictEqual(res.spawns[0].item, 'ShortJeans_Brown');
    });

    await check('service: no server.log → clean error, no crash', async () => {
      const emptyDir = path.join(baseDir, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });
      const res = await readRecentLootSpawnsFromDir(emptyDir, 'nasdara', { windowMinutes: 60 });
      assert.strictEqual(res.spawns.length, 0);
      assert.ok(res.error && /server\.log/.test(res.error));
    });

    await check('service: null dir → clean error, no crash', async () => {
      const res = await readRecentLootSpawnsFromDir(null, 'nasdara', { windowMinutes: 60 });
      assert.strictEqual(res.spawns.length, 0);
      assert.ok(res.error && /No log directory/.test(res.error));
    });

    await check('service: no rates/odds in the payload (disclosure policy)', async () => {
      const res = await readRecentLootSpawnsFromDir(logDir, 'nasdara', { windowMinutes: 60, limit: 500 });
      const keys = new Set();
      for (const s of res.spawns) for (const k of Object.keys(s)) keys.add(k);
      // Only per-event observation fields — no rate/odds/health/economy fields.
      assert.deepStrictEqual(
        [...keys].sort(),
        ['ageMs', 'east', 'item', 'north', 'timestampMs']
      );
      assert.ok(!('healthPct' in res) && !('candidates' in res));
    });

    // ── dual-source: server.log + newest RPT ─────────────────────────────────
    // The same physical spawn is logged to server.log (clock truncated to
    // seconds) and the RPT (clock keeps the ms fraction) in the same second.
    const dualDir = path.join(baseDir, 'dual', '77');
    fs.mkdirSync(dualDir, { recursive: true });
    const dualAnchor = new Date('2026-10-28T12:45:00Z');
    fs.writeFileSync(path.join(dualDir, 'server.log'),
      '12:45:00 Adding ShortJeans_Brown at [8554,8678]\n', { encoding: 'utf8' });
    fs.writeFileSync(path.join(dualDir, 'DayZServerP_X1_x64_2026-10-28_12-45-00.RPT'),
      '12:45:00.335 Adding ShortJeans_Brown at [8554,8678]\r\n' +
      '12:44:00.000 Adding Bandage at [3000,4000]\r\n', { encoding: 'utf8' });
    fs.utimesSync(path.join(dualDir, 'server.log'), dualAnchor, dualAnchor);
    fs.utimesSync(path.join(dualDir, 'DayZServerP_X1_x64_2026-10-28_12-45-00.RPT'), dualAnchor, dualAnchor);

    await check('service: RPT + server.log same spawn dedupe to a single point', async () => {
      const res = await readRecentLootSpawnsFromDir(dualDir, 'nasdara', { windowMinutes: 60, limit: 500 });
      assert.strictEqual(res.error, null);
      // ShortJeans_Brown appears in both files → one point. Bandage only in RPT.
      assert.strictEqual(res.count, 2);
      assert.strictEqual(res.spawns.filter(s => s.item === 'ShortJeans_Brown').length, 1);
      assert.strictEqual(res.spawns.filter(s => s.item === 'Bandage').length, 1);
      assert.ok(res.duplicates >= 1, 'cross-source duplicate was deduped');
    });

    await check('service: RPT-only source works when server.log is absent', async () => {
      const rptOnly = path.join(baseDir, 'rptonly', '88');
      fs.mkdirSync(rptOnly, { recursive: true });
      fs.writeFileSync(path.join(rptOnly, 'DayZServerP_X1_x64_2026-10-28_12-00-00.RPT'),
        '12:44:00.100 Adding WoundedRag at [1000,2000]\r\n', { encoding: 'utf8' });
      fs.utimesSync(path.join(rptOnly, 'DayZServerP_X1_x64_2026-10-28_12-00-00.RPT'), dualAnchor, dualAnchor);
      const res = await readRecentLootSpawnsFromDir(rptOnly, 'nasdara', { windowMinutes: 60, limit: 500 });
      assert.strictEqual(res.error, null);
      assert.strictEqual(res.count, 1);
      assert.strictEqual(res.spawns[0].item, 'WoundedRag');
      assert.strictEqual(res.spawns[0].east, 1000);
      assert.strictEqual(res.spawns[0].north, 2000);
      assert.ok(res.sourceFile && /RPT/.test(res.sourceFile));
    });

    await check('service: neither server.log nor RPT → clean error, no crash', async () => {
      const emptyDir = path.join(baseDir, 'nothing');
      fs.mkdirSync(emptyDir, { recursive: true });
      const res = await readRecentLootSpawnsFromDir(emptyDir, 'nasdara', { windowMinutes: 60 });
      assert.strictEqual(res.spawns.length, 0);
      assert.ok(res.error && /server\.log or RPT/.test(res.error));
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }

  console.log(`\n✅ loot-spawns-test: ${passed} checks passed`);
})().catch((err) => {
  console.error('\n❌ loot-spawns-test failed:', err);
  process.exit(1);
});
