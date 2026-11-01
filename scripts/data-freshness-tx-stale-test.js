'use strict';

/**
 * DataFreshness regression test — economy-transactions page (transactionList.js):
 *   - initial load records "Last updated HH:MM:SS" and renders rows
 *   - a FAILED Refresh keeps the stale rows visible (showLoading() must not
 *     leave an eternal spinner behind) and the row surfaces the error
 *   - after a first-load failure (no stale data), the in-content error state
 *     shows; a successful retry through dfh records the timestamp
 *
 * Hermetic: the real data-freshness.js + transactionList.js +
 * economy-transactions-init.js run in a Node vm against a minimal fake DOM +
 * stubbed fetch — no network, no real browser.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

// ── minimal fake DOM (same approach as data-freshness-retry-test.js) ─────────
function makeEl() {
  const el = {
    tagName: 'div', className: '', value: '', textContent: '', disabled: false,
    style: {}, dataset: {}, _html: '', _children: [], _listeners: {},
    setAttribute() {},
    classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
    appendChild(c) { this._children.push(c); return c; },
    append(...c) { this._children.push(...c); },
    replaceChildren(...c) { this._children = c; },
    insertAdjacentHTML(pos, html) { this._html += html; },
    addEventListener(evt, fn) { (this._listeners[evt] = this._listeners[evt] || []).push(fn); },
    click() { (this._listeners.click || []).forEach((fn) => fn({ target: this })); },
    remove() { this._html = ''; this._children = []; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return el._html
        + el._children.map((c) => `<${c.tagName} class="${c.className}">${c.textContent || ''}${c.innerHTML}</${c.tagName}>`).join('');
    },
    set(v) { el._html = String(v); el._children = []; },
  });
  return el;
}

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
});

const TX = { id: 1, transactionType: 'transfer', amount: 100, balanceAfter: 500,
  accountType: 'cash', source: 'player', description: 'd1',
  timestamp: new Date().toISOString(), serverName: 'S1' };
const okTxRes = () => jsonRes(200, { success: true, snapshotId: '7', transactions: [TX], pagination: { hasMore: false, limit: 200 } });
const failTxRes = () => jsonRes(500, { success: false, error: 'boom' });

function makePage(txResponder) {
  const byId = new Map([['tx-freshness', makeEl()], ['transactionList', makeEl()]]);
  const fetchLog = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    fetchLog.push(u);
    if (u.includes('/api/economy/player/1/transactions')) return txResponder();
    if (u.includes('/api/economy/player/1?serverId')) return jsonRes(200, { success: true, currency: { symbol: '$' } });
    if (u.includes('/api/accounts/linked')) return jsonRes(200, {
      success: true,
      accounts: [{ identity_id: 1, server_id: 1, gamertag: 'Kitty', platform: 'steam', server_name: 'S1' }],
    });
    return jsonRes(404, { error: 'unstubbed: ' + u });
  };
  const errs = [];
  const ctx = {
    document: {
      createElement(tag) { const e = makeEl(); e.tagName = tag; return e; },
      getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl()); return byId.get(id); },
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    fetch: fetchImpl,
    setTimeout, clearTimeout,
    console: { log() {}, info() {}, warn() {}, error(...a) { errs.push(a.map(String).join(' ')); } },
    AbortController, URLSearchParams, URL,
    navigator: { userAgent: 'node-vm' },
  };
  ctx.window = ctx;
  ctx.location = { href: '' };
  const context = vm.createContext(ctx);
  vm.runInContext(read('public/js/data-freshness.js'), context);
  vm.runInContext(read('public/js/components/transactionList.js'), context);
  vm.runInContext(read('public/js/economy-transactions-init.js'), context);
  return {
    byId, fetchLog, errs,
    container: byId.get('transactionList'),
    row: () => { const anchor = byId.get('tx-freshness'); return { label: anchor._children[0]._children[0], btn: anchor._children[0]._children[1] }; },
    txFetches: () => fetchLog.filter((u) => u.includes('/transactions')).length,
  };
}

async function until(cond, what, t = 4000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > t) throw new Error('timeout waiting for: ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const TS = /^Last updated \d{2}:\d{2}:\d{2}$/;

(async () => {
  // 1. initial load records the timestamp; a failed Refresh keeps the stale
  //    rows visible (regression: showLoading() used to leave a spinner).
  {
    let res = okTxRes;
    const page = makePage(() => res());
    await until(() => page.byId.get('tx-freshness')._children.length === 1, 'freshness row mounted (init IIFE)');
    const { label, btn } = page.row();
    await until(() => TS.test(label.textContent), 'initial timestamp');
    await until(() => page.container.innerHTML.includes('data-transaction-id="1"'), 'initial rows rendered');
    const n1 = page.txFetches();
    res = failTxRes;
    btn.click();
    await until(() => /Refresh failed/.test(label.textContent), 'failed refresh surfaces the error');
    assert.ok(page.container.innerHTML.includes('data-transaction-id="1"'),
      'stale rows stay visible after a failed refresh');
    assert.ok(!page.container.innerHTML.includes('animate-spin'),
      'no eternal spinner left behind after a failed refresh');
    assert.ok(page.txFetches() > n1, 'refresh triggered a re-fetch');
  }

  // 2. first-load failure (no stale data) shows the error state; a successful
  //    retry records the timestamp.
  {
    let res = failTxRes;
    const page = makePage(() => res());
    await until(() => page.byId.get('tx-freshness')._children.length === 1, 'freshness row mounted (init IIFE)');
    const { label, btn } = page.row();
    await until(() => /Failed to load transactions/.test(label.textContent), 'first-load failure surfaces in the row');
    assert.ok(page.container.innerHTML.includes('Failed to load transactions'),
      'first-load failure renders the in-content error state');
    res = okTxRes;
    btn.click();
    await until(() => TS.test(label.textContent), 'timestamp after successful retry');
    assert.ok(page.container.innerHTML.includes('data-transaction-id="1"'), 'rows render after the retry');
  }

  console.log('✅ data-freshness transactions stale-data tests passed (2/2)');
})().catch((err) => {
  console.error('❌ data-freshness transactions stale-data test failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
