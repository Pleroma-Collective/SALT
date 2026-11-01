'use strict';

/**
 * DataFreshness page-wiring tests: activity-log + server-lists.
 * Hermetic — the real page scripts run in a Node vm against a minimal fake
 * DOM with a stubbed fetch; no network, no real browser.
 *
 * Asserts the acceptance behavior for the wired pages:
 *   - the shared helper mounts into the page's anchor (timestamp + Refresh)
 *   - initial load records "Last updated HH:MM:SS"
 *   - the Refresh button re-fetches and the timestamp stays valid
 *   - a failed refresh keeps stale data visible and surfaces the error
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');

function makeElement(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    className: '',
    style: {},
    dataset: {},
    _listeners: {},
    _children: [],
    addEventListener(type, fn) { this._listeners[type] = fn; },
    appendChild(el) { this._children.push(el); },
    append(...els) { this._children.push(...els); },
    replaceChildren(...els) { this._children = els; },
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    setAttribute() {},
    querySelector() { return makeElement('q'); },
    closest() { return null; },
    remove() {},
  };
}

function makeContext(ids) {
  const registry = {};
  for (const id of ids) registry[id] = makeElement(id);
  const doc = {
    getElementById(id) { return registry[id] || null; },
    createElement() { return makeElement('created'); },
    querySelector() { return makeElement('qs'); },
    _listeners: {},
    addEventListener(type, fn) { this._listeners[type] = fn; },
    fire(type) { if (this._listeners[type]) this._listeners[type]({}); },
  };
  const ctx = {
    document: doc,
    fetch: null, // set per-scenario
    fetchWithCsrf: null,
    setTimeout: (fn) => { fn(); return 0; },
    console,
    _registry: registry,
    _doc: doc,
  };
  ctx.window = ctx; // browser semantics: window IS the global object
  return vm.createContext(ctx);
}

function freshnessRows(context) {
  for (const el of Object.values(context._registry)) {
    if (el._children.length && el._children[0]._children && el._children[0]._children.length === 2) {
      return { label: el._children[0]._children[0], btn: el._children[0]._children[1] };
    }
  }
  throw new Error('freshness row not found in anchors');
}

function makeFetch(handler) {
  return async (url, opts) => handler(String(url), opts);
}

function okJson(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  // ── 1. activity-log: initial load → timestamp; Refresh re-fetches; failure keeps stale rows ──
  {
    const context = makeContext(['serverSelect', 'statusBanner', 'logWrap', 'activity-freshness']);
    let fetchCount = 0;
    let failNext = false;
    context.fetch = makeFetch((url) => {
      fetchCount += 1;
      if (url.startsWith('/api/nitrado/registered-servers')) {
        return okJson({ success: true, servers: [{ id: 'srv1', server_name: 'Test', platform: 'x' }] });
      }
      if (failNext) return okJson({ success: false, error: 'nitrado down' });
      return okJson({ success: true, logs: [{ created_at: '2026-10-27T12:00:00Z', severity: 'info', category: 'test', user: 'u', message: 'hello' }], currentPage: 1, pageCount: 1, logCount: 1 });
    });

    vm.runInContext(fs.readFileSync(path.join(repoRoot, 'public/js/data-freshness.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(repoRoot, 'public/js/activityLog.js'), 'utf8'), context);

    // select a server → onServerChange → loadLogs (change listener is attached
    // once loadServers' fetch resolves)
    await flush();
    context._registry.serverSelect.value = 'srv1';
    await context._registry.serverSelect._listeners.change();

    let rows = freshnessRows(context);
    assert.match(rows.label.textContent, /^Last updated \d{2}:\d{2}:\d{2}$/,
      `initial load records timestamp (got "${rows.label.textContent}")`);
    assert.ok(context._registry.logWrap.innerHTML.includes('hello'), 'log rows rendered');

    // Refresh button re-fetches
    const before = fetchCount;
    await rows.btn._listeners.click();
    assert.equal(fetchCount, before + 1, 'Refresh triggers exactly one re-fetch');
    rows = freshnessRows(context);
    assert.match(rows.label.textContent, /^Last updated \d{2}:\d{2}:\d{2}$/, 'timestamp still valid after refresh');

    // Failed refresh: stale rows kept, error surfaced in the freshness row
    failNext = true;
    await rows.btn._listeners.click();
    rows = freshnessRows(context);
    assert.match(rows.label.textContent, /Refresh failed: nitrado down/, 'failure surfaced in the freshness row');
    assert.ok(context._registry.logWrap.innerHTML.includes('hello'), 'stale log rows stay visible on failed refresh');
  }

  // ── 2. server-lists: initial load → timestamp; Refresh re-fetches; failure keeps stale rows ──
  {
    const ids = ['serverSelect', 'toastArea', 'listSection',
      'tab-whitelist', 'tab-blacklist', 'tab-prioritylist',
      'panel-whitelist', 'panel-blacklist', 'panel-prioritylist',
      'add-whitelist', 'add-blacklist', 'add-prioritylist',
      'list-whitelist', 'list-blacklist', 'list-prioritylist',
      'lists-freshness'];
    const context = makeContext(ids);
    let fetchCount = 0;
    let failNext = false;
    context.fetch = makeFetch((url) => {
      if (url === '/api/owner/servers') {
        return okJson({ success: true, servers: [{ id: 'srv1', name: 'Test', guildName: 'G' }] });
      }
      fetchCount += 1;
      if (failNext) return okJson({ success: false, error: 'list unavailable' });
      return okJson({ success: true, entries: ['PLAYER_ONE', 'PLAYER_TWO'] });
    });
    context.fetchWithCsrf = context.fetch;

    vm.runInContext(fs.readFileSync(path.join(repoRoot, 'public/js/data-freshness.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(repoRoot, 'public/js/server-lists.js'), 'utf8'), context);
    context._doc.fire('DOMContentLoaded');

    // select a server → change handler → loadList(activeTab)
    context._registry.serverSelect.value = 'srv1';
    await context._registry.serverSelect._listeners.change({ target: context._registry.serverSelect });

    let rows = freshnessRows(context);
    assert.match(rows.label.textContent, /^Last updated \d{2}:\d{2}:\d{2}$/,
      `initial load records timestamp (got "${rows.label.textContent}")`);
    assert.ok(context._registry['list-whitelist'].innerHTML.includes('PLAYER_ONE'), 'entries rendered');

    // Refresh re-fetches the active list
    const before = fetchCount;
    await rows.btn._listeners.click();
    assert.equal(fetchCount, before + 1, 'Refresh triggers exactly one re-fetch');
    rows = freshnessRows(context);
    assert.match(rows.label.textContent, /^Last updated \d{2}:\d{2}:\d{2}$/, 'timestamp still valid after refresh');

    // Failed refresh: stale rows kept, error surfaced
    failNext = true;
    await rows.btn._listeners.click();
    rows = freshnessRows(context);
    assert.match(rows.label.textContent, /Refresh failed: list unavailable/, 'failure surfaced in the freshness row');
    assert.ok(context._registry['list-whitelist'].innerHTML.includes('PLAYER_ONE'), 'stale entries stay visible on failed refresh');
  }

  console.log('✅ data-freshness page wiring tests passed (activity-log, server-lists)');
})().catch((err) => {
  console.error('❌ data-freshness page wiring test failed:', err.message);
  process.exit(1);
});
