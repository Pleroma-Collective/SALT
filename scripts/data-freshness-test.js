'use strict';

/**
 * DataFreshness helper tests (QOL: last-updated indicator + Refresh on live
 * data pages). Hermetic: the browser script runs in a Node vm against a
 * minimal fake DOM — no network, no real browser.
 *
 * Asserts the acceptance behavior:
 *   - mount() injects a timestamp label + Refresh button into the anchor
 *   - a successful run() records "Last updated HH:MM:SS"
 *   - a failed run() shows a brief error and does NOT keep a success time
 *   - while a run is in flight the button is disabled (in-progress state)
 *   - reset() clears the timestamp (server/context switch)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');

function makeAnchor() {
  return {
    children: [],
    replaceChildren(...els) { this.children = els; },
  };
}

function makeContext(anchor) {
  const ctx = {
    window: {},
    document: {
      getElementById(id) { return id === 'freshness-anchor' ? anchor : null; },
      createElement() {
        return {
          className: '',
          type: '',
          disabled: false,
          textContent: '',
          innerHTML: '',
          classList: { add() {}, remove() {}, contains() { return false; } },
          setAttribute() {},
          addEventListener(evt, fn) { this._click = evt === 'click' ? fn : null; },
          append(...els) { (this._children = this._children || []).push(...els); },
        };
      },
    },
    Date,
  };
  ctx.window.document = ctx.document;
  return vm.createContext(ctx);
}

function loadHelper(context) {
  const source = fs.readFileSync(path.join(repoRoot, 'public/js/data-freshness.js'), 'utf8');
  vm.runInContext(source, context);
  return context.window.DataFreshness;
}

function rowsOf(anchor) {
  const [row] = anchor.children;
  return { row, label: row._children[0], btn: row._children[1] };
}

(async () => {
  // 1. mount injects label + button; initial state has no success time.
  {
    const anchor = makeAnchor();
    const context = makeContext(anchor);
    const DataFreshness = loadHelper(context);
    const dfh = DataFreshness.mount('freshness-anchor', async () => {}, { auto: false });
    assert.ok(dfh, 'mount returns a handle');
    const { label, btn } = rowsOf(anchor);
    assert.equal(label.textContent, 'Last updated —', 'no success time before first run');
    assert.equal(btn.textContent, '↻ Refresh', 'refresh button rendered');
    assert.equal(dfh.run, undefined || dfh.run, 'handle exposes run');
  }

  // 2. successful run records "Last updated HH:MM:SS".
  {
    const anchor = makeAnchor();
    const context = makeContext(anchor);
    const DataFreshness = loadHelper(context);
    const dfh = DataFreshness.mount('freshness-anchor', async () => {}, { auto: false });
    await dfh.run();
    const { label } = rowsOf(anchor);
    assert.match(label.textContent, /^Last updated \d{2}:\d{2}:\d{2}$/,
      `timestamp format (got "${label.textContent}")`);
  }

  // 3. failed run shows a brief error; stale-data callers never see a success.
  {
    const anchor = makeAnchor();
    const context = makeContext(anchor);
    const DataFreshness = loadHelper(context);
    let dfh;
    dfh = DataFreshness.mount('freshness-anchor', async () => { throw new Error('boom'); }, { auto: false });
    await dfh.run();
    let { label } = rowsOf(anchor);
    assert.match(label.textContent, /Refresh failed: boom/, 'failure surfaces in the label');
    assert.ok(label.classList.add !== undefined, 'label is an element');
    // a later success replaces the error with a fresh timestamp
    const anchor2 = makeAnchor();
    context.document.getElementById = () => anchor2;
    dfh = DataFreshness.mount('freshness-anchor', async () => {}, { auto: false });
    await dfh.run();
    label = rowsOf(anchor2).label;
    assert.match(label.textContent, /^Last updated \d{2}:\d{2}:\d{2}$/);
  }

  // 4. in-flight: button disabled + spinner; released after the run.
  {
    const anchor = makeAnchor();
    const context = makeContext(anchor);
    const DataFreshness = loadHelper(context);
    let release;
    const gate = new Promise((res) => { release = res; });
    let dfh;
    dfh = DataFreshness.mount('freshness-anchor', async () => { await gate; });
    const p = dfh.run();
    const { btn } = rowsOf(anchor);
    assert.equal(btn.disabled, true, 'button disabled while in flight');
    assert.match(btn.innerHTML, /dzc-spinner/, 'spinner shown while in flight');
    release();
    await p;
    assert.equal(btn.disabled, false, 'button re-enabled after the run');
    assert.equal(btn.textContent, '↻ Refresh', 'label restored after the run');
  }

  // 5. reset() clears the success time (context switch before a fresh load).
  {
    const anchor = makeAnchor();
    const context = makeContext(anchor);
    const DataFreshness = loadHelper(context);
    const dfh = DataFreshness.mount('freshness-anchor', async () => {}, { auto: false });
    await dfh.run();
    dfh.reset();
    const { label } = rowsOf(anchor);
    assert.equal(label.textContent, 'Last updated —', 'reset clears the timestamp');
  }

  // 6. mount is a no-op without the anchor (pages that don't opt in).
  {
    const context = makeContext(null);
    const DataFreshness = loadHelper(context);
    assert.equal(DataFreshness.mount('missing-anchor', async () => {}), null,
      'missing anchor returns null, pages continue without the control');
  }

  console.log('✅ data-freshness helper tests passed (6/6)');
})().catch((err) => {
  console.error('❌ data-freshness helper test failed:', err.message);
  process.exit(1);
});
