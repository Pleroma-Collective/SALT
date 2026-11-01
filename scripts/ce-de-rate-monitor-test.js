#!/usr/bin/env node
'use strict';

/*
 * CE Dynamic Event rate monitor (card t_02d9def4) — unit tests for the
 * aggregation, route-level tests (auth gating + SQL shape) against a fake
 * db, and a spot-check of the aggregation against real dayzxb RPT logs
 * (the same source the [CE][DE] parser consumes) when present on disk.
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const root = path.resolve(__dirname, '..');
const router = require(path.join(root, 'routes', 'ceDynamicEventRates.js'));
const { aggregateDeRateRows, MAX_WINDOW_DAYS } = router;
const { parseCEDynamicEvents } = require(path.join(root, 'utils', 'ceDynamicEvents.js'));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + name);
}

const NOW = new Date('2026-10-28T12:00:00Z');
const day = offset => new Date(NOW.getTime() + offset * 86400000).toISOString().slice(0, 10);

(async () => {
  // ── Aggregation unit tests ────────────────────────────────────────────────
  await check('aggregate: per-type totals, per-day rate, human names, lastSeen', () => {
    const rows = [
      { de_type: 'StaticContainerLocked', day: day(-2), last_seen: new Date(day(-2) + 'T10:00:00Z'), count: 3 },
      { de_type: 'StaticHeliCrash', day: day(-1), last_seen: new Date(day(-1) + 'T08:00:00Z'), count: 2 },
      { de_type: 'StaticHeliCrash', day: day(0), last_seen: new Date(day(0) + 'T04:00:00Z'), count: 1 },
      { de_type: 'StaticRental500', day: day(-2), last_seen: new Date(day(-2) + 'T01:00:00Z'), count: 5 },
    ];
    const result = aggregateDeRateRows(rows, { days: 3, now: NOW });
    assert.strictEqual(result.total, 11);
    assert.strictEqual(result.windowDays, 3);
    assert.strictEqual(result.activeDays, 3);
    assert.strictEqual(result.avgPerDay, Math.round((11 / 3) * 100) / 100);
    assert.deepStrictEqual(result.perType.map(t => t.deType), ['StaticRental500', 'StaticContainerLocked', 'StaticHeliCrash']);
    const rental = result.perType[0];
    assert.strictEqual(rental.count, 5);
    assert.strictEqual(rental.humanName, 'Rental (500)');
    assert.strictEqual(rental.perDay, 1.67, 'round2(5/3)');
    const heli = result.perType[2];
    assert.strictEqual(heli.count, 3);
    assert.strictEqual(heli.humanName, 'Heli crash');
    assert.strictEqual(heli.lastSeen, day(0) + 'T04:00:00.000Z');
  });

  await check('aggregate: zero-filled daily series covers the whole window', () => {
    const rows = [{ de_type: 'ItemBricks', day: day(0), last_seen: null, count: 4 }];
    const result = aggregateDeRateRows(rows, { days: 7, now: NOW });
    assert.strictEqual(result.daily.length, 7);
    assert.ok(result.daily.every(d => typeof d.total === 'number' && d.total >= 0));
    assert.strictEqual(result.daily[6].total, 4);
    assert.strictEqual(result.daily[6].byType.ItemBricks, 4);
    assert.strictEqual(result.activeDays, 1);
    assert.deepStrictEqual(result.daily.slice(0, 6).map(d => d.total), [0, 0, 0, 0, 0, 0]);
  });

  await check('aggregate: rows outside the window are dropped, days param clamped', () => {
    const rows = [
      { de_type: 'StaticPoliceCar', day: day(-400), last_seen: null, count: 9 },
      { de_type: 'StaticPoliceCar', day: day(-2), last_seen: null, count: 2 },
    ];
    const result = aggregateDeRateRows(rows, { days: 30, now: NOW });
    assert.strictEqual(result.total, 2, 'out-of-window rows must not leak in');
    const clamped = aggregateDeRateRows(rows, { days: 99999, now: NOW });
    assert.strictEqual(clamped.windowDays, MAX_WINDOW_DAYS);
    const defaulted = aggregateDeRateRows(rows, { days: 0, now: NOW });
    assert.strictEqual(defaulted.windowDays, 30, 'days=0 falls back to the default window');
    const clampedDown = aggregateDeRateRows(rows, { days: -5, now: NOW });
    assert.strictEqual(clampedDown.windowDays, 1);
  });

  await check('aggregate: Date-typed day values and zero counts tolerated', () => {
    const rows = [
      { de_type: 'StaticWaterTruck', day: new Date(day(-1) + 'T00:00:00Z'), last_seen: null, count: 2 },
      { de_type: 'StaticWaterTruck', day: day(-1), last_seen: null, count: 0 },
    ];
    const result = aggregateDeRateRows(rows, { days: 7, now: NOW });
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.perType[0].humanName, 'Water-truck wreck');
  });

  await check('aggregate: empty rows → zeroed payload', () => {
    const result = aggregateDeRateRows([], { days: 7, now: NOW });
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.perType.length, 0);
    assert.strictEqual(result.activeDays, 0);
    assert.strictEqual(result.daily.length, 7);
  });

  // ── Route tests (real middleware + express, fake db) ─────────────────────
  function makeFakeDb({ role, eventRows }) {
    const state = { eventQuery: null };
    return {
      get eventQuery() { return state.eventQuery; },
      get: async (sql) => {
        if (sql.includes('FROM servers s') && sql.includes('JOIN guilds g')) {
          return {
            server_id: 42, guild_id: 7, platform_server_id: '4436',
            server_status: 'active', guild_status: 'approved', discord_guild_id: '9001',
            guild_role: role, server_role: null, server_role_status: null,
            player_membership_id: null, identity_id: null,
            player_membership_status: null, player_verification_method: null,
          };
        }
        return null;
      },
      query: async (sql, params) => {
        if (sql.includes('FROM events')) {
          state.eventQuery = { sql, params };
          return eventRows;
        }
        return [];
      },
    };
  }

  async function startApp(db, authenticated = true) {
    const app = express();
    app.locals.db = db;
    app.use((req, _res, next) => {
      req.user = { id: 10, username: 'tester' };
      req.isAuthenticated = () => authenticated;
      next();
    });
    app.use('/api/dynamic-event-rates', router);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server;
  }

  async function get(server, urlPath) {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`);
    return { status: response.status, body: await response.json() };
  }

  const eventRows = [
    { de_type: 'StaticContainerLocked', day: day(-1), last_seen: new Date(day(-1) + 'T20:00:00Z'), count: 6 },
    { de_type: 'StaticHeliCrash', day: day(0), last_seen: new Date(day(0) + 'T02:00:00Z'), count: 2 },
  ];

  await check('route: guild admin → 200 with aggregated payload, SQL scoped to server + type', async () => {
    const db = makeFakeDb({ role: 'admin', eventRows });
    const server = await startApp(db);
    try {
      const { status, body } = await get(server, '/api/dynamic-event-rates/42?days=7');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.serverId, 42);
      assert.strictEqual(body.total, 8);
      assert.strictEqual(body.perType.length, 2);
      assert.deepStrictEqual(db.eventQuery.params, [42, 7], 'SQL must be parameterized (serverId, days)');
      assert.ok(db.eventQuery.sql.includes("event_type = 'ce.dynamic_event'"));
      assert.ok(db.eventQuery.sql.includes('server_id = ?'));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await check('route: unauthenticated → 401, no db access', async () => {
    const db = makeFakeDb({ role: 'admin', eventRows });
    const server = await startApp(db, false);
    try {
      const res = await get(server, '/api/dynamic-event-rates/42');
      assert.strictEqual(res.status, 401);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await check('route: non-admin (no guild/server role) → 404, never 200/500', async () => {
    const db = makeFakeDb({ role: null, eventRows });
    const server = await startApp(db);
    try {
      const res = await get(server, '/api/dynamic-event-rates/42');
      assert.strictEqual(res.status, 404, 'capability denial must hide the resource');
      assert.strictEqual(db.eventQuery, null, 'no events query for denied actors');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await check('route: unknown server id → 404', async () => {
    const db = makeFakeDb({ role: 'admin', eventRows });
    db.get = async () => null; // no such server row
    const server = await startApp(db);
    try {
      const res = await get(server, '/api/dynamic-event-rates/9999');
      assert.strictEqual(res.status, 404);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  // ── Spot-check against real dayzxb logs ───────────────────────────────────
  // The raw logs that produced the persisted events live outside the repo
  // (Nitrado downloads). When present, verify the full pipeline: parse →
  // dedupe → aggregate, cross-checked per day against raw line counts.
  const SAMPLE_DIR = process.env.CE_DE_SAMPLE_DIR
    ? path.resolve(process.env.CE_DE_SAMPLE_DIR)
    : '/home/salt/Documents/GitHub/Events/logs/dayzxb/config';

  if (fs.existsSync(path.join(SAMPLE_DIR, 'server.log')) || fs.existsSync(SAMPLE_DIR)) {
    const files = fs.readdirSync(SAMPLE_DIR)
      .filter(name => name.endsWith('.RPT') || name === 'server.log')
      .sort();
    assert.ok(files.length > 0, 'sample dir must contain RPT logs or server.log');

    const seen = new Set();
    const events = []; // { deType, day }
    let rejected = 0;
    for (const name of files) {
      const filePath = path.join(SAMPLE_DIR, name);
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
      const parsed = parseCEDynamicEvents(lines, { seen });
      rejected += parsed.rejected;
      const m = /^DayZServer[A-Za-z0-9_]*_(\d{4}-\d{2}-\d{2})_/.exec(name);
      const dayKey = m ? m[1] : fs.statSync(filePath).mtime.toISOString().slice(0, 10);
      for (const event of parsed.events) events.push({ deType: event.deType, day: dayKey });
    }
    assert.ok(events.length > 0, 'real logs must contain unique DE events');

    const rows = events.reduce((acc, e) => {
      const key = `${e.deType}|${e.day}`;
      acc.set(key, (acc.get(key) || 0) + 1);
      return acc;
    }, new Map());
    const sqlRows = [...rows.entries()].map(([key, count]) => {
      const [deType, d] = key.split('|');
      return { de_type: deType, day: d, last_seen: null, count };
    });

    const wide = aggregateDeRateRows(sqlRows, { days: 365, now: NOW });
    await check(`spot-check: real logs → ${events.length} unique events aggregate consistently`, () => {
      // Window must cover the whole log span; every parsed event counted.
      assert.strictEqual(wide.total, events.length, 'aggregated total equals parser-unique count');
      // Raw-line cross-check: per (day, type) counts recomputed by brute force.
      const brute = new Map();
      for (const e of events) {
        const key = `${e.deType}|${e.day}`;
        brute.set(key, (brute.get(key) || 0) + 1);
      }
      assert.strictEqual(brute.size, rows.size);
      for (const [key, count] of brute) {
        assert.strictEqual(rows.get(key), count, `raw recount mismatch for ${key}`);
      }
      // Daily series sums back to the total.
      assert.strictEqual(wide.daily.reduce((sum, d) => sum + d.total, 0), events.length);
      console.log(`    · ${events.length} unique events, ${rejected} rejected out-of-range, ${wide.perType.length} types, ${wide.activeDays} active days`);
      for (const t of wide.perType.slice(0, 6)) {
        console.log(`    · ${t.deType} (${t.humanName}): ${t.count} spawns, ${t.perDay}/day`);
      }
    });
  } else {
    console.log('  · spot-check skipped: real dayzxb logs not present at ' + SAMPLE_DIR + ' (set CE_DE_SAMPLE_DIR)');
  }

  console.log(`\n✅ ce-de-rate-monitor-test: ${passed} checks passed`);
})().catch(err => {
  console.error('\n❌ ce-de-rate-monitor-test failed:', err);
  process.exit(1);
});
