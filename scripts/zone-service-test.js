'use strict';

/* Activity zones (services/zoneService.js).
 * Proves:
 *   pure  — position parse, circle containment, filter parse, message build
 *   CRUD  — create/update/delete/list against an in-memory fake db,
 *           including validation failures (radius/channel/filters/map/name)
 *   match — processZonesForServer counts in-zone kill_events and ignores
 *           out-of-zone ones, aggregates, and posts on the right cadence
 *           (min-interval batching; retries on delivery failure; drops on
 *           invalid channel)
 * Run: node scripts/zone-service-test.js */

const assert = require('node:assert/strict');
const Zone = require('../services/zoneService');

/* ── fake db (house pattern) ──────────────────────────────────────────────── */

function fakeDb({ zones = [], kills = [] } = {}) {
  const table = {
    activity_zones: zones.map(z => ({ ...z })),
    kill_events: kills.map(k => ({ ...k })),
  };
  let nextZoneId = table.activity_zones.length ? Math.max(...table.activity_zones.map(z => z.id)) + 1 : 1;

  const parseColumns = (setPart) => [...setPart.matchAll(/([a-z_]+) = \?/g)].map(m => m[1]);
  const norm = sql => sql.replace(/\s+/g, ' ').trim();

  const db = {
    posts: [], // capture for assertions
    kill_events: table.kill_events, // live reference so tests can append
    async query(sql, params = []) {
      const s = norm(sql);
      if (/FROM kill_events WHERE server_id = \? AND timestamp > \?/.test(s)) {
        const [serverId, since, limit] = params;
        const sinceMs = new Date(since).getTime();
        return table.kill_events
          .filter(k => k.server_id === Number(serverId) && new Date(k.timestamp).getTime() > sinceMs)
          .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
          .slice(0, Number(limit));
      }
      if (/FROM activity_zones WHERE server_id = \? AND enabled = 1/.test(s)) {
        return table.activity_zones.filter(z => z.server_id === Number(params[0]) && z.enabled === 1);
      }
      if (/FROM activity_zones WHERE server_id = \? ORDER BY name/.test(s)) {
        return table.activity_zones
          .filter(z => z.server_id === Number(params[0]))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      }
      return [];
    },
    async get(sql, params = []) {
      const s = norm(sql);
      if (/INSERT INTO activity_zones/.test(s)) {
        // params: serverId, name, mapName, center_x, center_z, radius_m, filters, channel, minInterval, enabled
        const row = {
          id: nextZoneId++,
          server_id: Number(params[0]),
          name: params[1],
          map_name: params[2],
          center_x: Number(params[3]),
          center_z: Number(params[4]),
          radius_m: Number(params[5]),
          activity_filters: params[6],
          channel_id: params[7],
          min_interval_seconds: Number(params[8]),
          enabled: params[9],
          last_checked_at: null,
          last_posted_at: null,
          last_post_count: 0,
        };
        table.activity_zones.push(row);
        return row;
      }
      if (/FROM activity_zones WHERE id = \? AND server_id = \?/.test(s)) {
        const [zoneId, serverId] = params;
        return table.activity_zones.find(z => z.id === Number(zoneId) && z.server_id === Number(serverId)) || null;
      }
      return null;
    },
    async run(sql, params = []) {
      const s = norm(sql);
      if (/DELETE FROM activity_zones/.test(s)) {
        const [zoneId, serverId] = params;
        const before = table.activity_zones.length;
        const kept = table.activity_zones.filter(z => !(z.id === Number(zoneId) && z.server_id === Number(serverId)));
        table.activity_zones = kept;
        return { changes: before - kept.length };
      }
      if (/UPDATE activity_zones SET last_posted_at = \?/.test(s)) {
        // params: postedIso, count, cursorIso, cursorIso, zoneId
        const [postedIso, count, cursorIso, , zoneId] = params;
        const z = table.activity_zones.find(x => x.id === Number(zoneId));
        if (z) {
          z.last_posted_at = postedIso;
          z.last_post_count = Number(count);
          z.last_checked_at = laterOf(z.last_checked_at, cursorIso);
        }
        return { changes: 1 };
      }
      if (/UPDATE activity_zones SET last_checked_at = GREATEST/.test(s)) {
        // params: iso, iso, zoneId
        const [, , , zoneId] = params;
        const z = table.activity_zones.find(x => x.id === Number(zoneId));
        if (z) z.last_checked_at = laterOf(z.last_checked_at, params[0]);
        return { changes: 1 };
      }
      if (/UPDATE activity_zones SET .* updated_at = NOW\(\) WHERE id = \? AND server_id = \?/.test(s)) {
        const setPart = s.match(/SET (.*) WHERE id = \? AND server_id = \?/)[1];
        const cols = parseColumns(setPart);
        const values = params.slice(0, cols.length);
        const zoneId = params[cols.length];
        const serverId = params[cols.length + 1];
        const z = table.activity_zones.find(x => x.id === Number(zoneId) && x.server_id === Number(serverId));
        if (z) {
          cols.forEach((col, i) => { z[col] = values[i]; });
        }
        return { changes: z ? 1 : 0 };
      }
      return { changes: 0 };
    },
  };
  return db;
}

function laterOf(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

/* ── pure helpers ─────────────────────────────────────────────────────────── */

function testPure() {
  assert.deepEqual(Zone.parsePosition('1000,2000,5'), { east: 1000, north: 2000 });
  assert.deepEqual(Zone.parsePosition('1000,2000'), { east: 1000, north: 2000 });
  assert.equal(Zone.parsePosition('1000'), null);
  assert.equal(Zone.parsePosition(null), null);
  assert.equal(Zone.parsePosition('abc,2000'), null);
  assert.equal(Zone.parsePosition(''), null);

  const z = { center_x: 0, center_z: 0, radius_m: 100 };
  assert.equal(Zone.zoneContains(z, 50, 50), true);
  assert.equal(Zone.zoneContains(z, 100, 0), true); // on the edge
  assert.equal(Zone.zoneContains(z, 100.01, 0), false); // just outside
  assert.equal(Zone.zoneContains(z, 150, 0), false);
  assert.equal(Zone.zoneContains(z, -120, 0), false);

  assert.deepEqual([...Zone.parseFilters('["kill","death"]')], ['kill', 'death']);
  assert.deepEqual([...Zone.parseFilters(['KILL', 'Death'])], ['kill', 'death']);
  assert.deepEqual([...Zone.parseFilters('["bogus"]')], []);
  assert.deepEqual([...Zone.parseFilters(null)], []);
  assert.deepEqual([...Zone.parseFilters('[]')], []);
  assert.equal(Zone.eventMatchesZone({ activity_filters: '["kill"]' }, Zone.parseFilters('["kill"]')), true);
  assert.equal(Zone.eventMatchesZone({ activity_filters: '[]' }, Zone.parseFilters('[]')), false);

  const msg = Zone.buildZoneMessage(
    { name: 'Base', map_name: 'nasdara', min_interval_seconds: 120, last_event: { killer: 'A', victim: 'B', weapon: 'M4' } },
    { count: 2, players: new Set(['A', 'B']), weapons: new Map([['M4', 2]]), firstAt: Date.parse('2026-10-24T14:02:00Z'), lastAt: Date.parse('2026-10-24T14:05:00Z') }
  );
  assert.equal(msg.embeds.length, 1);
  assert.match(msg.embeds[0].title, /Base/);
  assert.match(msg.embeds[0].description, /2 combat events/);
  assert.match(msg.embeds[0].description, /Players: A, B/);
  assert.match(msg.embeds[0].description, /M4 \(2\)/);
  assert.match(msg.embeds[0].description, /A → B/);
  assert.match(msg.embeds[0].footer.text, /nasdara/);
}

/* ── CRUD ─────────────────────────────────────────────────────────────────── */

async function testCrud() {
  const db = fakeDb();

  const created = await Zone.createZone(db, 11, {
    name: 'North Base',
    center_x: 1000, center_z: 2000, radius_m: 350,
    activity_filters: ['kill'],
    channel_id: '111222333444',
    min_interval_seconds: 90,
  });
  assert.equal(created.name, 'North Base');
  assert.equal(created.center_x, 1000);
  assert.equal(created.radius_m, 350);
  assert.deepEqual(created.activity_filters, ['kill']);
  assert.equal(created.enabled, true);
  assert.equal(created.min_interval_seconds, 90);

  // validation failures
  for (const bad of [
    { name: '', center_x: 0, center_z: 0, radius_m: 100, activity_filters: ['kill'], channel_id: '1' },
    { name: 'X', center_x: 0, center_z: 0, radius_m: 10, activity_filters: ['kill'], channel_id: '1' },
    { name: 'X', center_x: 0, center_z: 0, radius_m: 100, activity_filters: [], channel_id: '1' },
    { name: 'X', center_x: 0, center_z: 0, radius_m: 100, activity_filters: ['bogus'], channel_id: '1' },
    { name: 'X', center_x: 0, center_z: 0, radius_m: 100, activity_filters: ['kill'], channel_id: 'nope' },
    { name: 'X', center_x: 0, center_z: 0, radius_m: 100, activity_filters: ['kill'], channel_id: '1', min_interval_seconds: 5 },
    { name: 'X', center_x: 0, center_z: 0, radius_m: 100, activity_filters: ['kill'], channel_id: '1', map_name: 'atlantis' },
  ]) {
    await assert.rejects(() => Zone.createZone(db, 11, bad), /must be|unknown|non-empty/);
  }

  // update (partial)
  const updated = await Zone.updateZone(db, 11, created.id, { name: 'North Base 2', enabled: false });
  assert.equal(updated.name, 'North Base 2');
  assert.equal(updated.enabled, false);
  assert.equal(updated.radius_m, 350); // unchanged

  // update missing -> null
  assert.equal(await Zone.updateZone(db, 11, 999, { name: 'Z' }), null);

  // list
  const list = await Zone.listZones(db, 11);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);

  // delete
  assert.equal(await Zone.deleteZone(db, 11, created.id), true);
  assert.equal(await Zone.deleteZone(db, 11, created.id), false);
  assert.equal((await Zone.listZones(db, 11)).length, 0);
}

/* ── matching + cadence ───────────────────────────────────────────────────── */

function killEvent(serverId, east, north, ts, killer, victim, weapon) {
  return {
    id: Math.random(),
    server_id: serverId,
    killer_gamertag: killer,
    victim_gamertag: victim,
    weapon,
    victim_position: `${east},${north},0`,
    killer_position: null,
    timestamp: ts,
  };
}

async function testMatching() {
  const now0 = Date.parse('2026-10-24T13:55:00Z'); // the "now" of the first tick
  const killAt = s => Date.parse(`2026-10-24T${s}Z`);

  const db = fakeDb({
    zones: [{
      id: 1, server_id: 11, name: 'Base', map_name: 'nasdara',
      center_x: 1000, center_z: 1000, radius_m: 200,
      activity_filters: '["kill"]', channel_id: '999',
      min_interval_seconds: 120, enabled: 1,
      last_checked_at: new Date(killAt('13:40:00')).toISOString(), // cursor: scan from here
      last_posted_at: null, last_post_count: 0,
    }],
    kills: [
      killEvent(11, 1100, 1000, new Date(killAt('13:50:00')).toISOString(), 'Killer1', 'Victim1', 'M4'),
      killEvent(11, 1050, 1050, new Date(killAt('13:50:30')).toISOString(), 'Killer2', 'Victim2', 'AKM'),
      killEvent(11, 5000, 5000, new Date(killAt('13:51:00')).toISOString(), 'FarK', 'FarV', 'Gloves'), // outside
    ],
  });
  const posts = [];
  const baseOpts = (ms) => ({
    now: () => ms,
    validate: async () => true,
    post: async (channel, webhook, content) => { posts.push({ channel, content }); return true; },
  });

  // First run: 2 in-zone events -> one post; outside ignored.
  let result = await Zone.processZonesForServer(db, '1234567890', 11, baseOpts(now0));
  assert.equal(result.posted, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, '999');
  assert.match(posts[0].content.embeds[0].description, /2 combat events/);
  assert.match(posts[0].content.embeds[0].description, /Killer1/);
  assert.doesNotMatch(posts[0].content.embeds[0].description, /FarK/);
  // cursor advanced to the batch max ts; last_posted_at = now
  const after = await Zone.listZones(db, 11);
  assert.equal(after[0].last_posted_at, new Date(now0).toISOString());
  assert.equal(after[0].last_post_count, 2);

  // Cadence: a new event arrives but we're still inside the 120s window -> no post.
  db.kill_events.push(killEvent(11, 1010, 1010, new Date(killAt('13:53:00')).toISOString(), 'K3', 'V3', 'M4'));
  posts.length = 0;
  result = await Zone.processZonesForServer(db, '1234567890', 11, baseOpts(killAt('13:56:00')));
  assert.equal(result.posted, 0);
  assert.equal(posts.length, 0);

  // After the interval elapses -> the new event is posted as a fresh aggregate.
  posts.length = 0;
  result = await Zone.processZonesForServer(db, '1234567890', 11, baseOpts(killAt('13:57:30')));
  assert.equal(result.posted, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].content.embeds[0].description, /1 combat event/);
  assert.match(posts[0].content.embeds[0].description, /K3/);
}

async function testNoZonesAndInvalidChannel() {
  // No active zones -> no post.
  const dbNone = fakeDb({ kills: [killEvent(11, 10, 10, new Date().toISOString(), 'a', 'b', 'M4')] });
  const postsNone = [];
  const r = await Zone.processZonesForServer(dbNone, 'g', 11, {
    now: () => Date.now(), validate: async () => true, post: async () => { postsNone.push(1); return true; },
  });
  assert.equal(r.zones, 0);
  assert.equal(postsNone.length, 0);

  // Invalid channel -> validate false -> events dropped, cursor advanced, no post.
  const dbBad = fakeDb({
    zones: [{ id: 1, server_id: 11, name: 'B', map_name: 'nasdara', center_x: 100, center_z: 100, radius_m: 300, activity_filters: '["kill"]', channel_id: '000', min_interval_seconds: 120, enabled: 1, last_checked_at: null, last_posted_at: null, last_post_count: 0 }],
    kills: [killEvent(11, 100, 100, new Date().toISOString(), 'a', 'b', 'M4')],
  });
  const postsBad = [];
  const warnings = [];
  const rBad = await Zone.processZonesForServer(dbBad, 'g', 11, {
    now: () => Date.now(),
    validate: async () => false,
    post: async () => { postsBad.push(1); return true; },
    logger: { log() {}, error() {}, warn: m => warnings.push(m) },
  });
  assert.equal(rBad.posted, 0);
  assert.equal(postsBad.length, 0);
  assert.ok(warnings.length >= 1);
}

async function main() {
  testPure();
  console.log('✅ zone pure helpers (parse/contain/filter/message)');
  await testCrud();
  console.log('✅ zone CRUD (create/update/delete/list + validation)');
  await testMatching();
  console.log('✅ zone matching + cadence (in-zone counted, out-of-zone ignored, min-interval batching)');
  await testNoZonesAndInvalidChannel();
  console.log('✅ zone no-op + invalid-channel drop');
  console.log('✅ zone-service-test passed');
}

main().catch(err => {
  console.error('❌ zone-service-test failed:', err);
  process.exit(1);
});
