#!/usr/bin/env node
'use strict';

/*
 * Command palette unit test (QOL card t_d37bee95 — Ctrl/Cmd+K page search).
 *
 *   1. Index coverage: every page route in src/app/registerRoutes.js appears
 *      in the client-side palette index (aliases/redirects/data routes excepted).
 *   2. Access tiers: anonymous sees public only; signed-in non-admins never
 *      see admin-tier pages; admins see everything.
 *   3. Matching: substring (label + path), ranking order, subsequence fuzzy
 *      fallback, empty query = full grouped index.
 *   4. Chrome stamping: applyPageChromes sets data-cmdk-auth / data-cmdk-admin
 *      per request identity and injects palette.css + command-palette.js on
 *      every page; the shell topbar carries the visible trigger.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { PAGES, accessible, match, filterAndGroup } = require(path.join(root, 'public/js/command-palette.js'));

/* ── 1. Index coverage vs route source ─────────────────────────────────── */

// Page routes that exist in registerRoutes.js but are NOT palette entries:
// auth flows, non-page endpoints, redirect aliases, and the /player-portal
// alias (same page as /player). /loot-finder is a 301 alias of the merged
// /map page — the palette keeps one entry for the consolidated page.
const NOT_PALETTE_PAGES = new Set([
  '/favicon.ico', '/readyz', '/metrics', '/data/:map/:file',
  '/logout', '/logout-confirm', '/auth/discord', '/auth/discord/callback',
  '/automation', '/nitrado-settings', '/economy-dashboard', '/loot-finder',
  '/economy-leaderboard', '/economy-transactions', '/admin/feeds',
  '/player-portal',
]);

function getPageRoutes() {
  const src = fs.readFileSync(path.join(root, 'src/app/registerRoutes.js'), 'utf8');
  const routes = [];
  const re = /app\.get\('([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) routes.push(m[1]);
  // /admin/* wildcard (app.use) covers admin sub-pages; individual admin
  // routes are registered explicitly, so nothing extra is derived here.
  return routes.filter(r =>
    !r.startsWith('/api/') && !r.startsWith('/auth/') &&
    !NOT_PALETTE_PAGES.has(r)
  );
}

function testCoverage() {
  const indexed = new Set(PAGES.map(p => p.path));
  assert.strictEqual(PAGES.length, indexed.size, 'palette index has duplicate paths');
  const missing = getPageRoutes().filter(r => !indexed.has(r));
  assert.deepStrictEqual(missing, [],
    `route(s) missing from palette index: ${missing.join(', ')}`);
  // Merged map page: the /loot-finder alias is a redirect, not a palette
  // entry — the palette must show exactly one entry for the consolidated page.
  assert.ok(!indexed.has('/loot-finder'), 'palette must not keep a /loot-finder entry');
  assert.strictEqual(PAGES.filter(p => p.path === '/map').length, 1,
    'palette must show exactly one entry for /map');
  // The ~57 page routes: the index is a real navigation surface, not a stub.
  assert.ok(PAGES.length >= 50, `index too small to be a nav surface (${PAGES.length})`);
  for (const p of PAGES) {
    assert.ok(p.label && p.path && p.section && p.tier, `incomplete entry: ${JSON.stringify(p)}`);
    assert.ok(['public', 'auth', 'admin'].includes(p.tier), `bad tier on ${p.path}`);
  }
}

/* ── 2. Access tiers ───────────────────────────────────────────────────── */

function testAccess() {
  const anon = accessible(PAGES, false, false);
  assert.ok(anon.length > 0, 'anonymous must see public pages');
  assert.ok(!anon.some(p => p.tier !== 'public'), 'anonymous tier leak: ' +
    anon.filter(p => p.tier !== 'public').map(p => p.path).join(', '));

  const user = accessible(PAGES, true, false).map(p => p.path);
  assert.ok(user.includes('/dashboard') && user.includes('/player'), 'user pages missing');
  const leaked = user.filter(p => {
    const tier = PAGES.find(x => x.path === p).tier;
    return tier === 'admin';
  });
  assert.deepStrictEqual(leaked, [], 'non-admin sees admin pages: ' + leaked.join(', '));
  assert.ok(!user.includes('/admin') && !user.includes('/dashboard/casino') &&
    !user.includes('/tools/loot-probability'), 'admin pages leaked to non-admin');

  const admin = accessible(PAGES, true, true).map(p => p.path);
  assert.strictEqual(admin.length, PAGES.length, 'admin must see every page');
  assert.ok(admin.includes('/admin') && admin.includes('/dashboard/casino') &&
    admin.includes('/tools/loot-probability'), 'admin entries missing');
}

/* ── 3. Matching ───────────────────────────────────────────────────────── */

function paths(groups) { return groups.flatMap(g => g.items.map(i => i.page.path)); }

function testMatching() {
  const byLabel = (q) => paths(filterAndGroup(PAGES, q));

  assert.strictEqual(byLabel('console')[0], '/dashboard/console', 'substring: console');
  assert.strictEqual(byLabel('xml')[0], '/tools/xml-validator', 'substring: xml');
  assert.deepStrictEqual(byLabel('zzznotapage'), [], 'nonsense query must not match');
  assert.ok(byLabel('conso').includes('/dashboard/console'), 'subsequence fuzzy fallback (conso → Console)');

  // Exact label beats prefix, prefix beats mid-word, path-only still matches.
  const full = filterAndGroup(PAGES, 'economy');
  const econPaths = paths(full);
  assert.strictEqual(econPaths[0], '/dashboard/economy', 'exact label ranks first');
  assert.ok(econPaths.includes('/dashboard/economy-leaderboard') &&
    econPaths.includes('/admin/economy-analytics'), 'word-start + path matches present');

  // Empty query returns every page, grouped, in section order.
  const all = filterAndGroup(PAGES, '');
  assert.strictEqual(paths(all).length, PAGES.length, 'empty query must list every page');
  const order = ['Public', 'Player', 'Dashboard', 'Admin', 'Tools'];
  assert.deepStrictEqual(all.map(g => g.section), order.filter(s => all.some(g => g.section === s)),
    'groups must follow section order');
  // Admin pages present only for admins (tier filter applies to empty query too).
  assert.strictEqual(match(PAGES[0], '   '), 0, 'whitespace-only query = no query');
}

/* ── 4. Chrome stamping ────────────────────────────────────────────────── */

const { applyPageChromes } = require(path.join(root, 'utils/renderWithCsrf.js'));
const { renderShellPage } = require(path.join(root, 'utils/appShell.js'));

const PAGE_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="/css/theme.css">
</head>
<body><main>Fixture</main></body>
</html>`;

function chromeReq(user) {
  const authed = !!user;
  return {
    path: '/dashboard',
    theme: {},
    csrfToken: () => 'tok',
    isAuthenticated: () => authed,
    user: user || null,
  };
}

function testChromes() {
  const anon = applyPageChromes(PAGE_FIXTURE, chromeReq(null));
  assert.ok(anon.includes('data-cmdk-auth="0"') && anon.includes('data-cmdk-admin="0"'),
    'anonymous flags must be off');
  assert.ok(anon.includes('href="/css/palette.css"'), 'palette.css not injected');
  assert.ok(anon.includes('<script defer src="/js/command-palette.js"></script>'), 'palette script not injected');

  const user = applyPageChromes(PAGE_FIXTURE, chromeReq({ id: 1, is_admin: 0 }));
  assert.ok(user.includes('data-cmdk-auth="1"') && user.includes('data-cmdk-admin="0"'),
    'signed-in non-admin flags wrong');

  const admin = applyPageChromes(PAGE_FIXTURE, chromeReq({ id: 2, is_admin: 1 }));
  assert.ok(admin.includes('data-cmdk-auth="1"') && admin.includes('data-cmdk-admin="1"'),
    'is_admin flag not stamped');

  const owner = applyPageChromes(PAGE_FIXTURE, chromeReq({ id: 3, is_admin: 0, platform_role: 'dashboard_owner' }));
  assert.ok(owner.includes('data-cmdk-admin="1"'), 'platform_role admin not stamped');
}

function testShellTrigger() {
  const file = path.join(os.tmpdir(), `palette-fixture-${Date.now()}.html`);
  fs.writeFileSync(file, PAGE_FIXTURE);
  fs.chmodSync(file, 0o755);
  const req = chromeReq({ id: 1, is_admin: 0 });
  const res = { send(body) { this.body = body; return this; } };
  return renderShellPage(file, req, res, {
    surface: 'owner', activePath: '/dashboard', crumbs: [{ label: 'Dashboard' }],
  }).then(() => {
    assert.ok(res.body.includes('data-cmdk-trigger'), 'shell topbar missing the search trigger');
    assert.ok(res.body.includes('class="dzc-cmdk-trigger"'), 'trigger element missing');
    fs.unlinkSync(file);
  });
}

async function testAll() {
  testCoverage();
  testAccess();
  testMatching();
  testChromes();
  await testShellTrigger();
  console.log('✅ command-palette unit tests passed');
}

testAll().catch(err => { console.error('❌ command-palette unit test failed:', err.message); process.exit(1); });
