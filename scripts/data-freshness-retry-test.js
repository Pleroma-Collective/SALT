'use strict';

/**
 * DataFreshness page-glue tests (card t_a2efe844) — retry/timestamp behavior
 * of the items + loadouts pages on top of the shared helper:
 *   - items: initial load records "Last updated HH:MM:SS" (via dfh.run())
 *   - items: after a first-load failure, the in-content Retry routes through
 *     dfh, so a successful retry records the timestamp
 *   - loadouts: initial load records the timestamp; a failed Refresh keeps
 *     the stale cards visible (helper contract) and preserves the count
 *   - loadouts: after a first-load failure, the empty-state Retry routes
 *     through dfh, so a successful retry records the timestamp
 *
 * Hermetic: the real data-freshness.js + real page scripts run in a Node vm
 * against a minimal fake DOM + stubbed fetch — no network, no real browser.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

// ── minimal fake DOM ─────────────────────────────────────────────────────────
// Faithful to the DOM semantics the page scripts rely on: setting innerHTML
// replaces children, the innerHTML getter serializes the subtree, and
// querySelector('.card') / '[data-dzc-loading]' match by class / marker.

function makeEl(extra = {}) {
  const el = {
    className: '',
    value: '',
    textContent: '',
    disabled: false,
    _html: '',
    _children: [],
    _listeners: {},
    setAttribute() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {},
    dataset: {},
    append(...els) { this._children.push(...els); },
    appendChild(c) { this._children.push(c); },
    insertAdjacentHTML(pos, html) {
      this._html += html;
      if (html.includes('class="grid"')) this._children.push(makeEl({ className: 'grid' }));
    },
    addEventListener(evt, fn) { (this._listeners[evt] = this._listeners[evt] || []).push(fn); },
    click() { (this._listeners.click || []).forEach((fn) => fn()); },
    remove() { this._html = ''; this._children = []; },
    querySelector(sel) {
      if (sel === '.card') return hasClassTree(el, 'card') ? el : null;
      if (sel === '[data-dzc-loading]') {
        return el._html.includes('data-dzc-loading')
          ? { remove() { el._html = el._html.replace('data-dzc-loading', 'data-dzc-loading-done'); } }
          : null;
      }
      if (sel === '.copy-btn') return el._html.includes('copy-btn') ? makeEl() : null;
      return null;
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return el._html
        + el._children.map((c) => `<div class="${c.className}">${c.innerHTML}</div>`).join('');
    },
    set(v) {
      el._html = v;
      el._children = v.includes('class="grid"') ? [makeEl({ className: 'grid' })] : [];
    },
  });
  Object.defineProperty(el, 'lastElementChild', {
    get() { return el._children[el._children.length - 1] || null; },
  });
  return Object.assign(el, extra);
}

function hasClassTree(el, cls) {
  if (el.className === cls) return true;
  return el._children.some((c) => hasClassTree(c, cls));
}

function makeAnchor() {
  const anchor = makeEl();
  anchor.replaceChildren = function (...els) { this._children = els; };
  return anchor;
}

function rowsOf(anchor) {
  const row = anchor._children[0];
  return { label: row._children[0], btn: row._children[1] };
}

function makeContext(byId, extraGetById, fetchImpl) {
  const ctx = {
    window: {},
    document: {
      createElement: () => makeEl(),
      getElementById(id) {
        if (extraGetById) return extraGetById(id) || byId[id] || null;
        return byId[id] || null;
      },
    },
    fetch: (url) => fetchImpl(url),
    setTimeout,
    clearTimeout,
    Date,
  };
  ctx.window.document = ctx.document;
  return vm.createContext(ctx);
}

function loadScripts(context, files) {
  for (const f of files) {
    // Browser globals land on window in the real page; mirror them onto the
    // vm sandbox so bare references (DataFreshness, ItemCatalog) resolve.
    for (const k of Object.keys(context.window)) context[k] = context.window[k];
    vm.runInContext(read('public/js/' + f), context);
  }
}

async function until(cond, what) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 3000) throw new Error('timeout waiting for: ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const okItemsRes = () => ({
  ok: true, status: 200,
  json: async () => ({ map: 'nasdara', event: 'Walpurgis', count: 1,
    items: [{ classname: 'ItemCore', category: 'weapons', name: 'Core', tier: 1 }] }),
});
const okSpawnRes = () => ({ ok: true, status: 200, json: async () => ({ types: {} }) });
const okStatsRes = () => ({ ok: true, status: 200, json: async () => ({ items: [] }) });
const okLoadoutRes = () => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ simpleChildrenTypes: ['ItemBandage'], discreteUnsortedItemSets: [] }),
});
const failRes = () => ({ ok: false, status: 500, json: async () => { throw new Error('HTTP 500'); } });

(async () => {
  // 1. items: successful initial load records the timestamp (dfh.run path).
  {
    const els = {};
    for (const id of ['content', 'tabs', 'framing', 'fineprint', 'view-info', 'view-compare', 'clear-compare']) els[id] = makeEl();
    els.search = makeEl(); els.map = makeEl({ value: 'nasdara' });
    els['catalog-freshness'] = makeAnchor();
    const retry = makeEl();
    let fetchImpl = (url) => url.includes('items.json') ? okItemsRes() : url.includes('spawnables') ? okSpawnRes() : okStatsRes();
    const ctx = makeContext(els,
      (id) => id === 'catalog-retry' && els.content.innerHTML.includes('id="catalog-retry"') ? retry : null,
      (url) => fetchImpl(url));
    loadScripts(ctx, ['item-catalog.js', 'data-freshness.js', 'items-page.js']);
    const { label } = rowsOf(els['catalog-freshness']);
    await until(() => /^Last updated \d{2}:\d{2}:\d{2}$/.test(label.textContent), 'items timestamp after initial load');
    assert.ok(els.content.innerHTML.includes('<table'), 'items catalog table rendered');
  }

  // 2. items: first-load failure → in-content Retry routes through dfh, so a
  //    successful retry records the timestamp (previously the indicator stayed
  //    on "Refresh failed" / "Last updated —" forever).
  {
    const els = {};
    for (const id of ['content', 'tabs', 'framing', 'fineprint', 'view-info', 'view-compare', 'clear-compare']) els[id] = makeEl();
    els.search = makeEl(); els.map = makeEl({ value: 'nasdara' });
    els['catalog-freshness'] = makeAnchor();
    const retry = makeEl();
    let fetchImpl = failRes;
    const ctx = makeContext(els,
      (id) => id === 'catalog-retry' && els.content.innerHTML.includes('id="catalog-retry"') ? retry : null,
      (url) => fetchImpl(url));
    loadScripts(ctx, ['item-catalog.js', 'data-freshness.js', 'items-page.js']);
    const { label } = rowsOf(els['catalog-freshness']);
    await until(() => els.content.innerHTML.includes('id="catalog-retry"'), 'items error state with Retry');
    assert.match(label.textContent, /Refresh failed/, 'first-load failure surfaces in the freshness row');
    // network recovers; the in-content Retry now goes through dfh
    fetchImpl = (url) => url.includes('items.json') ? okItemsRes() : url.includes('spawnables') ? okSpawnRes() : okStatsRes();
    retry.click();
    await until(() => /^Last updated \d{2}:\d{2}:\d{2}$/.test(label.textContent), 'items timestamp after successful retry');
    assert.ok(els.content.innerHTML.includes('<table'), 'catalog renders after the retry');
  }

  // 3. loadouts: initial load records the timestamp; a failed Refresh keeps
  //    the stale cards visible (helper contract) and preserves the count.
  {
    const content = makeEl();
    const count = makeEl();
    const byId = { 'loadout-content': content, 'loadout-count': count, 'loadouts-freshness': makeAnchor() };
    let fetchImpl = (url) => url.includes('kitty_loadouts') ? okLoadoutRes() : okStatsRes();
    const retry = makeEl();
    const ctx = makeContext(byId,
      (id) => id === 'loadouts-retry' && content.innerHTML.includes('id="loadouts-retry"') ? retry : null,
      (url) => fetchImpl(url));
    loadScripts(ctx, ['data-freshness.js', 'loadouts-page.js']);
    const { label, btn } = rowsOf(byId['loadouts-freshness']);
    await until(() => /^Last updated \d{2}:\d{2}:\d{2}$/.test(label.textContent), 'loadouts timestamp after initial load');
    const countBefore = count.textContent;
    assert.match(countBefore, /^\d+ loadouts$/, 'all loadouts loaded (got "' + countBefore + '")');
    assert.ok(content.innerHTML.includes('class="card"'), 'loadout cards rendered');
    // network fails on the manual Refresh
    fetchImpl = failRes;
    btn.click();
    await until(() => /Refresh failed/.test(label.textContent) && btn.disabled === false, 'failed refresh surfaces the error');
    assert.ok(content.innerHTML.includes('class="card"'), 'stale cards stay visible after a failed refresh');
    assert.equal(count.textContent, countBefore, 'count not reset by a failed refresh');
  }

  // 4. loadouts: first-load failure → empty state; the empty-state Retry
  //    routes through dfh, so a successful retry records the timestamp.
  {
    const content = makeEl();
    const count = makeEl();
    const byId = { 'loadout-content': content, 'loadout-count': count, 'loadouts-freshness': makeAnchor() };
    const retry = makeEl();
    let fetchImpl = failRes;
    const ctx = makeContext(byId,
      (id) => id === 'loadouts-retry' && content.innerHTML.includes('id="loadouts-retry"') ? retry : null,
      (url) => fetchImpl(url));
    loadScripts(ctx, ['data-freshness.js', 'loadouts-page.js']);
    const { label } = rowsOf(byId['loadouts-freshness']);
    await until(() => content.innerHTML.includes('id="loadouts-retry"'), 'loadouts empty state with Retry');
    assert.match(label.textContent, /Refresh failed/, 'first-load failure surfaces in the freshness row');
    assert.equal(count.textContent, '0 loadouts', 'count reflects the empty load');
    // network recovers; the empty-state Retry now goes through dfh
    fetchImpl = (url) => url.includes('kitty_loadouts') ? okLoadoutRes() : okStatsRes();
    retry.click();
    await until(() => /^Last updated \d{2}:\d{2}:\d{2}$/.test(label.textContent), 'loadouts timestamp after successful retry');
    assert.ok(content.innerHTML.includes('class="card"'), 'loadouts render after the retry');
  }

  console.log('✅ data-freshness retry page tests passed (4/4)');
})().catch((err) => {
  console.error('❌ data-freshness retry page test failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
