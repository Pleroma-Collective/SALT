/**
 * faction-claim-engine-test.js — Faction Wars claim rules engine
 *
 * Covers: threshold met/unmet, conflict (split flags), tie keeps owner,
 * strict-out-flag takeover, claim loss, and radius-only (out-of-settlement)
 * placement via settlementAt.
 *
 * Run: node scripts/faction-claim-engine-test.js
 */

'use strict';

const assert = require('assert');
const S = require('../services/factionClaimService');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('Faction Wars — claim rules engine\n');

/* ── Threshold table ──────────────────────────────────────────────────── */
check('thresholds scale with size (capital 5 / city 3 / village 1)', () => {
  assert.strictEqual(S.flagsNeededForKind('capital'), 5);
  assert.strictEqual(S.flagsNeededForKind('city'), 3);
  assert.strictEqual(S.flagsNeededForKind('village'), 1);
  assert.strictEqual(S.flagsNeededForKind('Local'), 1); // village sub-type
  assert.strictEqual(S.flagsNeededForKind('bogus'), 1); // unknown → village fallback
});

check('boundary radii (capital 1500 / city 800 / village 400)', () => {
  assert.strictEqual(S.boundaryRadiusForKind('capital'), 1500);
  assert.strictEqual(S.boundaryRadiusForKind('city'), 800);
  assert.strictEqual(S.boundaryRadiusForKind('village'), 400);
});

/* ── Threshold met / unmet ────────────────────────────────────────────── */
check('threshold met → claimed event with the right owner', () => {
  const r = S.computeClaimState({ needed: 3, counts: { 7: 3 }, currentClaim: null });
  assert.deepStrictEqual(r, { ownerFactionId: 7, flagsMet: 3, event: { type: 'claimed', factionId: 7 } });
});

check('threshold unmet → no owner, no event', () => {
  const r = S.computeClaimState({ needed: 3, counts: { 7: 2 }, currentClaim: null });
  assert.deepStrictEqual(r, { ownerFactionId: null, flagsMet: 0, event: null });
});

check('flags already met by current owner → no event', () => {
  const r = S.computeClaimState({ needed: 3, counts: { 7: 3 }, currentClaim: { factionId: 7 } });
  assert.strictEqual(r.ownerFactionId, 7);
  assert.strictEqual(r.event, null);
});

/* ── Conflict / takeover / tie ────────────────────────────────────────── */
check('conflict: split flags below threshold → no claim', () => {
  const r = S.computeClaimState({ needed: 5, counts: { 1: 3, 2: 3 }, currentClaim: null });
  assert.strictEqual(r.ownerFactionId, null);
  assert.strictEqual(r.event, null);
});

check('takeover: challenger strictly out-flags owner → claim_taken', () => {
  const r = S.computeClaimState({ needed: 3, counts: { 1: 2, 2: 3 }, currentClaim: { factionId: 1 } });
  assert.deepStrictEqual(r, { ownerFactionId: 2, flagsMet: 3, event: { type: 'claim_taken', factionId: 2 } });
});

check('tie: current owner keeps a tied top count', () => {
  const r = S.computeClaimState({ needed: 3, counts: { 1: 3, 2: 3 }, currentClaim: { factionId: 1 } });
  assert.strictEqual(r.ownerFactionId, 1);
  assert.strictEqual(r.event, null);
});

check('loss: owner drops below threshold → claim_lost', () => {
  const r = S.computeClaimState({ needed: 3, counts: { 1: 1 }, currentClaim: { factionId: 1 } });
  assert.deepStrictEqual(r, { ownerFactionId: null, flagsMet: 0, event: { type: 'claim_lost', factionId: 1 } });
});

check('all flags cleared → claim_lost', () => {
  const r = S.computeClaimState({ needed: 1, counts: {}, currentClaim: { factionId: 4 } });
  assert.deepStrictEqual(r, { ownerFactionId: null, flagsMet: 0, event: { type: 'claim_lost', factionId: 4 } });
});

/* ── Settlement membership (radius-only placement) ────────────────────── */
const settlements = [
  { id: 'capital-x', position: { east: 0, north: 0 }, kind: 'capital' },
  { id: 'village-y', position: { east: 1200, north: 0 }, kind: 'village' },
];

check('flag inside a boundary → that settlement', () => {
  const s = S.settlementAt(settlements, 100, 0);
  assert.strictEqual(s && s.id, 'capital-x');
});

check('flag inside a village boundary → that village', () => {
  const s = S.settlementAt(settlements, 1200 + 300, 0);
  assert.strictEqual(s && s.id, 'village-y');
});

check('flag OUTSIDE every boundary → null (claims only its own radius circle)', () => {
  // village-y boundary is 400m: point at 1200+401,0 is outside it;
  // capital boundary is 1500m: |1601| > 1500, outside it too.
  const s = S.settlementAt(settlements, 1601, 0);
  assert.strictEqual(s, null);
});

check('overlapping boundaries → closest settlement wins', () => {
  const overlap = [
    { id: 'a', position: { east: 0, north: 0 }, kind: 'city' },   // r=800
    { id: 'b', position: { east: 1000, north: 0 }, kind: 'city' }, // r=800
  ];
  // Point at 450 is 450 from a and 550 from b → inside both, closer to a.
  const s = S.settlementAt(overlap, 450, 0);
  assert.strictEqual(s && s.id, 'a');
  const s2 = S.settlementAt(overlap, 550, 0);
  assert.strictEqual(s2 && s2.id, 'b');
});

/* ── Settlement data sanity (nasdara) ─────────────────────────────────── */
check('nasdara settlements.json loads with kind + position', () => {
  const all = S.loadSettlements('nasdara');
  assert.ok(all.length >= 150, `expected 150+ settlements, got ${all.length}`);
  for (const s of all) {
    assert.ok(s.kind, `settlement ${s.id} missing kind`);
    assert.ok(Number.isFinite(s.position.east) && Number.isFinite(s.position.north), `settlement ${s.id} missing position`);
  }
});

/* ── Feed delivery (existing faction feed) ────────────────────────────── */
// Regression: discord_feeds.guild_id is the Discord guild id (text
// snowflake), not an internal DB id — delivery must pass it to the
// destination validator as-is.
async function runFeedDeliveryTests() {
  const guildSnowflake = '789326430571855893';
  const calls = { validate: [], post: [] };
  const fakeDb = {
    get: async (sql, params) => {
      if (/discord_feeds/.test(sql)) {
        assert.deepStrictEqual(params, [1]);
        return { guild_id: guildSnowflake, channel_id: '1480397136637198457' };
      }
      if (/factions/.test(sql)) return { name: 'TEST', tag: 'TEST' };
      throw new Error('unexpected db.get: ' + sql);
    },
  };
  const result = await S.deliverClaimEvents(fakeDb, 1, [
    { type: 'claimed', factionId: 1, flagsMet: 1, settlementId: 'Settlement_Dashtabad' },
  ], {
    post: async (channelId, webhook, content, _force) => {
      calls.post.push({ channelId, content });
      return true;
    },
    validate: async (guildId, channelId) => {
      calls.validate.push({ guildId, channelId });
      return true;
    },
  });
  assert.deepStrictEqual(result, { posted: 1 });
  assert.deepStrictEqual(calls.validate, [{ guildId: guildSnowflake, channelId: '1480397136637198457' }]);
  assert.strictEqual(calls.post.length, 1);
  assert.ok(calls.post[0].content.embeds[0].title.includes('Dashtabad'));
  assert.ok(calls.post[0].content.embeds[0].description.includes('TEST'));
  console.log('  ✓ feed delivery posts to the existing faction feed with the Discord guild id');

  // Disabled feed → no post at all.
  const noFeed = await S.deliverClaimEvents(
    { get: async () => null }, 1,
    [{ type: 'claimed', factionId: 1, flagsMet: 1, settlementId: 'Settlement_Dashtabad' }],
    { post: async () => { throw new Error('must not post'); }, validate: async () => true }
  );
  assert.deepStrictEqual(noFeed, { posted: 0 });
  console.log('  ✓ feed delivery is a no-op when the faction feed is not enabled');
}

runFeedDeliveryTests().then(() => {
  console.log(`\n${passed + 2} checks passed.`);
}).catch(err => { console.error(err); process.exit(1); });
