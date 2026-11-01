#!/usr/bin/env node
'use strict';

/*
 * map-url-state.js unit test (card 6/9 — shareable map state).
 * Pure module: parse() / buildSearch() round-trips, defaults, and the
 * "omit defaults to keep shared URLs short" discipline.
 */

const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const M = require(path.join(root, 'public', 'js', 'map-url-state.js'));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

// ── parse: defaults ─────────────────────────────────────────────────────────
check('empty URL → defaults (all sections open, ops layers on, heatmaps off, radius 500, auto-refresh on)', () => {
  const s = M.parse('');
  assert.strictEqual(s.server, '');
  assert.strictEqual(s.map, '');
  assert.ok([...M.DEFAULT_ENABLED_LAYERS].every(k => s.layers.has(k)), 'default layers missing');
  assert.ok(!s.layers.has('loot') && !s.layers.has('kill') && !s.layers.has('death') && !s.layers.has('movement'), 'heatmaps must default off');
  assert.deepStrictEqual(s.hiddenFilters, []);
  assert.strictEqual(s.radius, M.DEFAULT_RADIUS);
  assert.strictEqual(s.autoRefresh, true);
  assert.deepStrictEqual([...s.openSections].sort(),
    M.SECTION_KEYS.filter(k => k !== 'spawnfilters').sort(),
    'all sections open by default except the collapsed spawn filter rail');
  assert.deepStrictEqual([...s.rail], [], 'rail defaults to nothing on');
  assert.strictEqual(s.panelOpen, true);
});

check('parse accepts URLSearchParams and a leading ? prefix', () => {
  assert.strictEqual(M.parse('?radius=900').radius, 900);
  assert.strictEqual(M.parse(new URLSearchParams('radius=900')).radius, 900);
});

// ── parse: values ────────────────────────────────────────────────────────────
check('layers param restricts enabled set to known keys only', () => {
  const s = M.parse('?layers=loot,bogus-key,kill');
  assert.deepStrictEqual([...s.layers].sort(), ['kill', 'loot']);
});

check('unknown layer keys are dropped; empty layers value → nothing enabled', () => {
  assert.ok(!M.parse('?layers=bogus').layers.size);
});

check('open param keeps known sections only; closed sections absent from set', () => {
  const s = M.parse('?open=server,bogus,radius');
  assert.deepStrictEqual([...s.openSections].sort(), ['radius', 'server']);
  assert.ok(!s.openSections.has('layers'));
  assert.ok(!s.openSections.has('spawnfilters'), 'explicit open list is authoritative');
});

check('open=spawnfilters un-collapses the rail; buildSearch writes the deviation', () => {
  const s = M.parse('?open=spawnfilters');
  assert.ok(s.openSections.has('spawnfilters'));
  const q = M.buildSearch({
    server: '', map: '', layers: s.layers, hiddenFilters: s.hiddenFilters,
    radius: s.radius, autoRefresh: s.autoRefresh, openSections: s.openSections,
    rail: s.rail, panelOpen: s.panelOpen,
  });
  assert.strictEqual(new URLSearchParams(q).get('open'), 'spawnfilters');
});

check('radius / refresh / panel params', () => {
  assert.strictEqual(M.parse('?radius=1200').radius, 1200);
  assert.strictEqual(M.parse('?radius=abc').radius, M.DEFAULT_RADIUS, 'malformed radius → default');
  assert.strictEqual(M.parse('?radius=-5').radius, M.DEFAULT_RADIUS, 'non-positive radius → default');
  assert.strictEqual(M.parse('?refresh=0').autoRefresh, false);
  assert.strictEqual(M.parse('?refresh=1').autoRefresh, true);
  assert.strictEqual(M.parse('?panel=0').panelOpen, false);
});

check('filters param is a trimmed, non-empty list (invalid escapes stay literal)', () => {
  assert.deepStrictEqual(M.parse('?filters=trainLocked,%%bogus%% , ').hiddenFilters, ['trainLocked', '%%bogus%%']);
});

// ── rail param (P0-C spawn filter rail) ─────────────────────────────────────
check('rail param keeps valid path forms, drops malformed entries', () => {
  const s = M.parse('?rail=cat:store:high,tier:3,evt:christmas,tier:9,cat:store,cat:store:x,cat:Store:high,bogus');
  assert.deepStrictEqual([...s.rail], ['cat:store:high', 'tier:3', 'evt:christmas']);
});

check('rail accepts unique tier; empty rail value → empty set', () => {
  assert.ok(M.parse('?rail=tier:unique').rail.has('tier:unique'));
  assert.ok(!M.parse('?rail=,').rail.size);
  assert.ok(!M.parse('').rail.size);
});

// ── buildSearch: defaults omitted ───────────────────────────────────────────
check('default state serializes to an empty query', () => {
  const s = M.parse('');
  assert.strictEqual(M.buildSearch({
    server: '', map: '', layers: s.layers, hiddenFilters: s.hiddenFilters,
    radius: s.radius, autoRefresh: s.autoRefresh, openSections: s.openSections,
    rail: s.rail, panelOpen: s.panelOpen,
  }), '');
});

check('non-default state serializes every deviation', () => {
  const q = M.buildSearch({
    server: 'abc123',
    map: 'chernarusplus',
    layers: new Set(['loot', 'roster']),
    hiddenFilters: ['trainLocked'],
    radius: 1200,
    autoRefresh: false,
    openSections: new Set(['server']),
    rail: new Set(['tier:3', 'cat:store:high']),
    panelOpen: false,
  });
  const p = new URLSearchParams(q);
  assert.strictEqual(p.get('server'), 'abc123');
  assert.strictEqual(p.get('map'), 'chernarusplus');
  assert.strictEqual(p.get('layers'), 'roster,loot', 'layers in LAYER_CONTROLS declaration order, not alphabetical');
  assert.strictEqual(p.get('filters'), 'trainLocked');
  assert.strictEqual(p.get('radius'), '1200');
  assert.strictEqual(p.get('refresh'), '0');
  assert.strictEqual(p.get('open'), 'server');
  assert.strictEqual(p.get('rail'), 'tier:3,cat:store:high', 'rail in insertion order');
  assert.strictEqual(p.get('panel'), '0');
});

check('buildSearch omits params that equal their defaults', () => {
  const s = M.parse('?radius=500&refresh=1&panel=1');
  const q = M.buildSearch({
    server: '', map: '', layers: s.layers, hiddenFilters: [],
    radius: 500, autoRefresh: true, openSections: s.openSections,
    rail: s.rail, panelOpen: true,
  });
  const p = new URLSearchParams(q);
  assert.strictEqual(p.get('radius'), null);
  assert.strictEqual(p.get('refresh'), null);
  assert.strictEqual(p.get('panel'), null);
  assert.strictEqual(p.get('open'), null, 'default-open sections (rail collapsed) must be omitted');
  assert.strictEqual(p.get('layers'), null, 'default layer set must be omitted');
  assert.strictEqual(p.get('rail'), null, 'empty rail must be omitted');
});

// ── round-trip ──────────────────────────────────────────────────────────────
check('parse(buildSearch(parse(x))) is stable (round-trip)', () => {
  const urls = [
    '?server=abc&map=sakhal&layers=roster,loot&filters=trainLocked&radius=1500&refresh=0&open=server,layers&panel=0',
    '?layers=settlement-radii',
    '?open=health&radius=400',
    '?rail=cat:store:high,tier:3,evt:christmas&open=spawnfilters',
    '?rail=cat:residential:med&rail=bogus',
    '',
    '?server=x&map=namalsk',
  ];
  for (const url of urls) {
    const once = M.parse(url);
    const twice = M.parse('?' + M.buildSearch({
      server: once.server, map: once.map, layers: once.layers,
      hiddenFilters: once.hiddenFilters, radius: once.radius,
      autoRefresh: once.autoRefresh, openSections: once.openSections,
      rail: once.rail, panelOpen: once.panelOpen,
    }));
    assert.strictEqual(twice.server, once.server);
    assert.strictEqual(twice.map, once.map);
    assert.deepStrictEqual([...twice.layers].sort(), [...once.layers].sort());
    assert.deepStrictEqual(twice.hiddenFilters, once.hiddenFilters);
    assert.strictEqual(twice.radius, once.radius);
    assert.strictEqual(twice.autoRefresh, once.autoRefresh);
    assert.deepStrictEqual([...twice.openSections].sort(), [...once.openSections].sort());
    assert.deepStrictEqual([...twice.rail].sort(), [...once.rail].sort());
    assert.strictEqual(twice.panelOpen, once.panelOpen);
  }
});

// ── browser global surface ──────────────────────────────────────────────────
check('UMD attaches the API to the global scope (window in browser, globalThis in node)', () => {
  assert.strictEqual(globalThis.MapUrlState, M, 'global MapUrlState not attached');
  assert.strictEqual(typeof globalThis.MapUrlState.parse, 'function');
});

console.log(`\n✅ map-url-state suite passed: ${passed} checks`);
