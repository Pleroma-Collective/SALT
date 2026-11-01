#!/usr/bin/env node
'use strict';

/*
 * CE Dynamic Events (card t_37a71bcc) — parser, dedupe, feed filter, map link,
 * embed, and end-to-end processCeDynamicEvents (RPT + server.log → events
 * table + feed_events queue) against a fake db and temp log files.
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const root = path.resolve(__dirname, '..');
const {
  parseDeLine,
  parseCEDynamicEvents,
  humanNameForDeType,
  validateDePosition,
  shouldAnnounceDeSpawn,
  buildMapDeepLink,
} = require(path.join(root, 'utils', 'ceDynamicEvents.js'));
const { buildDeSpawnEmbedPayload } = require(path.join(root, 'utils', 'feedMessageFormatter.js'));
const { processCeDynamicEvents } = require(path.join(root, 'routes', 'logParser.js'));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + name);
}

// Real sample lines from Events/logs/dayzxb/config (2026-10-23 → 26).
const RPT_LINES = [
  '3:41:42.387 [CE][DE] [StaticContainerLocked] Spawning: EventID:[24] CurrentID:[20067] at [11690.0,-1.0,10555.1] a: -1.000',
  '3:41:42.711 [CE][DE] [StaticHeliCrash] Spawning: EventID:[25] CurrentID:[20068] at [6942.7,-1.0,7702.2] a: -1.000',
  '5:00:00.000 [CE][DE] [StaticPoliceCar] Spawning: EventID:[27] CurrentID:[28001] at [-3402823466385288598117041832116734636714,-1.0,1234.5] a: -1.000',
  '2026-10-26 03:41:42 [3]Mission: DayZServerP_X1_x64 — unrelated RPT noise',
];
const SERVER_LOG_LINES = [
  '11:16:24 [CE][DE] [StaticContainerLocked] Spawning: EventID:[24] CurrentID:[20067] at [11690.0,-1.0,10555.1] a: -1.000',
  '11:16:24 [CE][DE] [StaticWaterTruck] Spawning: EventID:[29] CurrentID:[28413] at [5065.2,-1.0,13095.8] a: -1.000',
];

function createFakeDb(persistedKeys) {
  const queued = [];
  const appended = [];
  return {
    queued,
    appended,
    get: async (sql, params) => {
      if (sql.includes('FROM discord_feeds')) {
        // guild-1 has an enabled feed configured; other/absent guilds do not.
        return params && params[0] === 'guild-1' ? { id: 1, channel_id: null, webhook_url: null } : null;
      }
      if (sql.includes('FROM events')) {
        return persistedKeys.has(`${params[1]}:${params[2]}`) ? { '1': 1 } : null;
      }
      return null;
    },
    run: async (sql, params) => {
      if (sql.includes('INSERT INTO feed_events')) queued.push(params);
      return { changes: 1 };
    },
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO events')) appended.push(params);
      return { rows: [{ seq: 1, uuid: 'uuid-test' }] };
    },
  };
}

(async () => {
  // ── Parser ────────────────────────────────────────────────────────────────
  await check('parseDeLine: real RPT line → type/eventId/currentId/coords/rotation/clock', () => {
    const p = parseDeLine(RPT_LINES[0]);
    assert.ok(p, 'line must parse');
    assert.strictEqual(p.deType, 'StaticContainerLocked');
    assert.strictEqual(p.eventId, 24);
    assert.strictEqual(p.currentId, 20067);
    assert.deepStrictEqual(p.pos, { x: 11690.0, y: -1.0, z: 10555.1 });
    assert.strictEqual(p.rotation, -1.0);
    assert.strictEqual(p.clock, '3:41:42.387');
  });

  await check('parseDeLine: server.log line without milliseconds parses', () => {
    const p = parseDeLine(SERVER_LOG_LINES[1]);
    assert.ok(p);
    assert.strictEqual(p.deType, 'StaticWaterTruck');
    assert.strictEqual(p.clock, '11:16:24');
    assert.deepStrictEqual(p.pos, { x: 5065.2, y: -1.0, z: 13095.8 });
  });

  await check('parseDeLine: trailing CR (CRLF logs) and non-DE lines → parse / null', () => {
    assert.ok(parseDeLine(RPT_LINES[0] + '\r'));
    assert.strictEqual(parseDeLine('2026-10-26 03:41:42 [3]Unrelated'), null);
    assert.strictEqual(parseDeLine(''), null);
  });

  await check('parseCEDynamicEvents: real lines → correct events + human names', () => {
    const { events, rejected, duplicates } = parseCEDynamicEvents(RPT_LINES);
    assert.strictEqual(events.length, 2, 'bad-coord line must be rejected, not counted');
    assert.strictEqual(rejected, 1);
    assert.strictEqual(duplicates, 0);
    assert.strictEqual(events[0].deType, 'StaticContainerLocked');
    assert.strictEqual(events[0].humanName, 'Locked container / armory');
    assert.strictEqual(events[1].humanName, 'Heli crash');
  });

  await check('out-of-range coordinate is rejected and counted, never an event', () => {
    const bad = parseCEDynamicEvents([RPT_LINES[2]]);
    assert.strictEqual(bad.events.length, 0);
    assert.strictEqual(bad.rejected, 1);
    assert.strictEqual(
      validateDePosition({ x: -3402823466385288598117041832116734636714, y: -1, z: 1234.5 }),
      false
    );
    assert.strictEqual(validateDePosition({ x: NaN, y: 0, z: 0 }), false);
  });

  await check('humanNameForDeType: observed type mapping', () => {
    assert.strictEqual(humanNameForDeType('StaticRental500'), 'Rental (500)');
    assert.strictEqual(humanNameForDeType('StaticRental562'), 'Rental (562)');
    assert.strictEqual(humanNameForDeType('VehicleRental'), 'Rental vehicle');
    assert.strictEqual(humanNameForDeType('ItemBricks'), 'Loot');
    assert.strictEqual(humanNameForDeType('HeliCrashBig'), 'Heli crash');
    assert.strictEqual(humanNameForDeType('TotallyNewType'), 'TotallyNewType');
  });

  await check('dedupe across RPT + server.log via shared seen set', () => {
    const first = parseCEDynamicEvents(RPT_LINES);
    const second = parseCEDynamicEvents(SERVER_LOG_LINES, { seen: first.seen });
    assert.strictEqual(second.events.length, 1, 'only the water truck is new');
    assert.strictEqual(second.events[0].deType, 'StaticWaterTruck');
    assert.strictEqual(second.duplicates, 1, 'the duplicated container line is counted');
  });

  // ── Feed filter (whitelist/blacklist) ────────────────────────────────────
  await check('shouldAnnounceDeSpawn: default ON announces everything', () => {
    assert.strictEqual(shouldAnnounceDeSpawn('StaticContainerLocked', null), true);
    assert.strictEqual(shouldAnnounceDeSpawn('StaticContainerLocked', {}), true);
    assert.strictEqual(shouldAnnounceDeSpawn('UnknownFutureType', { suppress: ['Heli crash'] }), true);
  });

  await check('shouldAnnounceDeSpawn: suppress (blacklist) wins', () => {
    assert.strictEqual(shouldAnnounceDeSpawn('StaticHeliCrash', { suppress: ['Heli crash'] }), false);
    assert.strictEqual(shouldAnnounceDeSpawn('StaticPoliceCar', { suppress: ['Heli crash'] }), true);
    // Every StaticRentalNNN is one toggle
    assert.strictEqual(shouldAnnounceDeSpawn('StaticRental534', { suppress: ['Rental property'] }), false);
  });

  await check('shouldAnnounceDeSpawn: announce (whitelist) restricts', () => {
    const s = { announce: ['Loot'] };
    assert.strictEqual(shouldAnnounceDeSpawn('ItemBricks', s), true);
    assert.strictEqual(shouldAnnounceDeSpawn('StaticContainerLocked', s), false);
    assert.strictEqual(shouldAnnounceDeSpawn('UnknownFutureType', s), false);
  });

  // ── Map deep-link ────────────────────────────────────────────────────────
  await check('buildMapDeepLink: valid coords → /map.html?map=&marker=<east>,<north>', () => {
    const url = buildMapDeepLink({ east: 11690.4, north: 10555.9, origin: 'https://dash.test' });
    assert.strictEqual(url, 'https://dash.test/map.html?map=nasdara&marker=11690,10556');
  });

  await check('buildMapDeepLink: out-of-range coords or missing origin → null', () => {
    assert.strictEqual(buildMapDeepLink({ east: -1, north: 0, origin: 'https://dash.test' }), null);
    assert.strictEqual(buildMapDeepLink({ east: 999999, north: 0, origin: 'https://dash.test' }), null);
    assert.strictEqual(buildMapDeepLink({ east: 0, north: 0, origin: null }), null);
    assert.strictEqual(buildMapDeepLink({ east: NaN, north: 0, origin: 'https://dash.test' }), null);
  });

  // ── Embed shape ──────────────────────────────────────────────────────────
  await check('buildDeSpawnEmbedPayload: embed contains human name + working map link', () => {
    const payload = buildDeSpawnEmbedPayload(
      { deType: 'StaticContainerLocked', pos: { x: 11690.0, y: -1.0, z: 10555.1 }, timestamp: new Date('2026-10-26T08:41:42Z') },
      { includeMapLink: true },
      'DayZ XB',
      'https://dash.test'
    );
    assert.strictEqual(payload.embeds.length, 1);
    const embed = payload.embeds[0];
    assert.ok(embed.title.includes('Locked container / armory'), 'human name in title');
    assert.ok(embed.description.includes('11690'), 'coords in description');
    assert.ok(embed.description.includes('[🗺️ View on map](https://dash.test/map.html?map=nasdara&marker=11690,10555)'));
    assert.strictEqual(embed.footer.text, 'DayZ XB');
  });

  await check('buildDeSpawnEmbedPayload: includeMapLink:false omits the link but keeps coords', () => {
    const payload = buildDeSpawnEmbedPayload(
      { deType: 'StaticPoliceCar', pos: { x: 100, y: -1, z: 200 } },
      { includeMapLink: false },
      'DayZ XB',
      'https://dash.test'
    );
    assert.ok(!payload.embeds[0].description.includes('View on map'));
    assert.ok(payload.embeds[0].description.includes('100, 200'));
  });

  // ── processCeDynamicEvents (integration, fake db + temp logs) ─────────────
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-de-test-'));
  try {
    const rptPath = path.join(baseDir, 'DayZServerP_X1_x64_2026-10-26_03-38-28.RPT');
    fs.writeFileSync(rptPath, RPT_LINES.join('\n') + '\n');
    fs.writeFileSync(path.join(baseDir, 'server.log'), SERVER_LOG_LINES.join('\n') + '\n');

    const db = createFakeDb(new Set());
    const result = await processCeDynamicEvents(db, {
      baseDir,
      rptFiles: [rptPath],
      serverContext: { id: 42 },
      guildId: 'guild-1',
    });

    await check('integration: RPT + server.log → 3 unique events, 1 rejected, 1 duplicate', () => {
      assert.deepStrictEqual(result, { announced: 3, rejected: 1, skippedDuplicates: 1 });
      assert.strictEqual(db.appended.length, 3, 'exactly 3 events persisted');
      assert.strictEqual(db.queued.length, 3, 'exactly 3 feed events queued');
    });

    await check('integration: persisted payload + queued event are correct', () => {
      // appendEvent params: (server_id, player_id, event_type, timestamp, payload json)
      const byType = {};
      for (const params of db.appended) {
        const payload = JSON.parse(params[4]);
        byType[payload.deType] = payload;
        assert.strictEqual(params[0], 42, 'server_id');
        assert.strictEqual(params[2], 'ce.dynamic_event', 'event_type');
      }
      assert.strictEqual(byType.StaticContainerLocked.pos.x, 11690.0);
      assert.strictEqual(byType.StaticContainerLocked.eventId, 24);
      assert.strictEqual(byType.StaticContainerLocked.currentId, 20067);
      assert.ok(byType.StaticContainerLocked.humanName === 'Locked container / armory');
      // feed_events params: (guild_id, server_id, feed_type, event_type, event_data json, payload json)
      assert.ok(db.queued.every(q => q[2] === 'dynamic_events' && q[3] === 'de_spawn'));
      const data = JSON.parse(db.queued[0][4]);
      assert.ok(data.pos, 'event_data carries pos');
    });

    await check('integration: second run re-derives nothing (events-table dedupe)', async () => {
      const persisted = new Set(['24:20067', '25:20068', '29:28413']);
      const db2 = createFakeDb(persisted);
      const again = await processCeDynamicEvents(db2, {
        baseDir,
        rptFiles: [rptPath],
        serverContext: { id: 42 },
        guildId: 'guild-1',
      });
      assert.strictEqual(again.announced, 0);
      assert.strictEqual(again.rejected, 1, 'out-of-range still rejected, never persisted');
      assert.strictEqual(db2.appended.length, 0);
      assert.strictEqual(db2.queued.length, 0);
    });

    await check('integration: no guild → events persist, nothing queued, no crash', async () => {
      const db3 = createFakeDb(new Set());
      const res = await processCeDynamicEvents(db3, {
        baseDir,
        rptFiles: [rptPath],
        serverContext: { id: 42 },
        guildId: null,
      });
      assert.strictEqual(res.announced, 3);
      assert.strictEqual(db3.appended.length, 3);
      assert.strictEqual(db3.queued.length, 0);
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }

  console.log(`\n✅ ce-dynamic-events-test: ${passed} checks passed`);
})().catch((err) => {
  console.error('\n❌ ce-dynamic-events-test failed:', err);
  process.exit(1);
});
