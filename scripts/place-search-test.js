#!/usr/bin/env node
'use strict';

/*
 * place-search.js unit test (roadmap P0-B — map search box + zoom buckets).
 * Pure module: coordinate parsing, fuzzy place matching, and the POI
 * zoom-bucket visibility rules. No DOM or network needed.
 */

const assert = require('assert');
const path = require('path');

const M = require(path.join(path.resolve(__dirname, '..'), 'public', 'js', 'place-search.js'));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

// ── parseCoordinates ────────────────────────────────────────────────────────
check('two numbers separated by space or comma parse to east/north', () => {
  assert.deepStrictEqual(M.parseCoordinates('6778 2321'), { east: 6778, north: 2321 });
  assert.deepStrictEqual(M.parseCoordinates('6778, 2321'), { east: 6778, north: 2321 });
  assert.deepStrictEqual(M.parseCoordinates('6778.5 2321'), { east: 6778.5, north: 2321 });
  assert.deepStrictEqual(M.parseCoordinates('  100\t200 '), { east: 100, north: 200 });
});

check('anything that is not exactly two numbers → null', () => {
  for (const bad of ['', '   ', '123', '123 456 789', 'Chernogorsk',
    '6778 2321 extra', 'a b', '6778', '12.34.56 78', '6778 -5']) {
    assert.strictEqual(M.parseCoordinates(bad), null, JSON.stringify(bad));
  }
});

// ── spawnBucketOf ──────────────────────────────────────────────────────────
check('bucket from usages: Town outranks Village; no usage → city', () => {
  assert.strictEqual(M.spawnBucketOf(['Town', 'Village']), 'town');
  assert.strictEqual(M.spawnBucketOf(['Village']), 'village');
  assert.strictEqual(M.spawnBucketOf(['Industrial']), 'city');
  assert.strictEqual(M.spawnBucketOf([]), 'city');
  assert.strictEqual(M.spawnBucketOf(null), 'city');
});

// ── bucketVisible ──────────────────────────────────────────────────────────
check('cities always visible; towns at z>=0; villages at z>=1', () => {
  assert.ok(M.bucketVisible('city', -2));
  assert.ok(M.bucketVisible('city', 0.5));
  assert.ok(!M.bucketVisible('town', -1));
  assert.ok(M.bucketVisible('town', 0));
  assert.ok(!M.bucketVisible('village', 0));
  assert.ok(!M.bucketVisible('village', 0.5));
  assert.ok(M.bucketVisible('village', 1));
  assert.ok(M.bucketVisible('village', 3));
});

// ── matchPlaces ─────────────────────────────────────────────────────────────
const index = [
  { label: 'Chernogorsk' },
  { label: 'Cherno sea' },
  { label: 'Novoselki' },
  { label: 'Zelenogorsk' },
];

check('exact > prefix > substring, case-insensitive, ranked and capped', () => {
  assert.deepStrictEqual(M.matchPlaces('Chernogorsk', index, 10).map(e => e.label), ['Chernogorsk']);
  assert.deepStrictEqual(M.matchPlaces('cherno', index, 10).map(e => e.label),
    ['Cherno sea', 'Chernogorsk']);
  assert.deepStrictEqual(M.matchPlaces('zel', index, 1).map(e => e.label), ['Zelenogorsk']);
  assert.deepStrictEqual(M.matchPlaces('  z ', index, 10).map(e => e.label), ['Zelenogorsk']);
  assert.deepStrictEqual(M.matchPlaces('', index), []);
  assert.deepStrictEqual(M.matchPlaces('qqq', index), []);
});

console.log('\n' + passed + ' checks passed');
