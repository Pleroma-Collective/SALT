'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

(function run() {
  const shopJs = fs.readFileSync(path.join(__dirname, '../public/js/shop.js'), 'utf8');
  const shopHtml = fs.readFileSync(path.join(__dirname, '../public/shop.html'), 'utf8');

  // Extract the pure UI-copy helpers (house pattern: slice between anchors).
  const escapeFn = shopJs.slice(shopJs.indexOf('function escapeHtml'), shopJs.indexOf('function orderStatusMeta'));
  const badgeFn = shopJs.slice(shopJs.indexOf('function fulfillmentBadge'), shopJs.indexOf('function buildRentalCard'));
  const statusFn = shopJs.slice(shopJs.indexOf('function orderStatusMeta'), shopJs.indexOf('/** Brief toast'));

  const context = {};
  vm.runInNewContext(`${escapeFn}\n${statusFn}\n${badgeFn}`, context);
  const refundLabels = vm.runInNewContext('REFUND_STATUS_LABEL', context);

  for (const status of ['completed', 'expired', 'refunded', 'pending', 'cancelled']) {
    const meta = context.orderStatusMeta(status);
    assert.ok(meta.label && meta.helper && meta.cls, `order status '${status}' needs label, helper, and style`);
    assert.notStrictEqual(meta.label, status, `order status '${status}' must show a human label, not the raw token`);
  }
  const unknown = context.orderStatusMeta('some_future_status');
  assert.ok(unknown.helper && unknown.cls, 'unknown order statuses must still render with a helper and style');

  const states = [
    ['provisioned', {}],
    ['awaiting_spawn_evidence', {}],
    ['evidence_unavailable', {}],
    ['activated', {}],
    ['inactive', {}],
    ['spawn_confirmed', { confirmedAt: '2026-10-24T10:00:00.000Z' }],
    ['spawn_failed', { observedAt: '2026-10-24T11:00:00.000Z' }],
    ['spawn_refused', { observedAt: '2026-10-24T12:00:00.000Z' }],
    ['spawn_attempted', {}],
  ];
  for (const [state, extra] of states) {
    const html = context.fulfillmentBadge({ state, label: null, ...extra });
    assert.match(html, new RegExp(`title="${state}"`), `fulfillment '${state}' tooltip must carry the raw token`);
    assert.ok(html.length > 60, `fulfillment '${state}' must render a human helper line`);
  }
  assert.match(context.fulfillmentBadge({ state: 'provisioned', respawnsRemaining: 2 }), /2 restarts left/,
    'rental timing must say how many restarts are left');
  assert.match(context.fulfillmentBadge({ state: 'provisioned', respawnsRemaining: 1 }), /1 restart left/,
    'a single remaining restart must not be pluralised');
  assert.match(context.fulfillmentBadge({ state: 'spawn_confirmed', confirmedAt: '2026-10-24T10:00:00.000Z' }),
    /Spawned in-game — confirmed /, 'confirmed spawns must show the confirmation time');
  assert.match(context.fulfillmentBadge({ state: 'activated' }), /no restart needed/i,
    'capabilities must explain they are active immediately');
  assert.doesNotMatch(context.fulfillmentBadge(null), /undefined/,
    'a missing fulfillment object must render without undefined');

  for (const token of ['credited', 'pending', 'claimed']) {
    assert.ok(refundLabels[token], `refund status '${token}' needs a human label`);
  }

  assert.match(shopHtml, /How orders work/i, 'orders tab must explain how orders work');
  const infoBlock = shopHtml.slice(shopHtml.indexOf('How orders work'), shopHtml.indexOf('orders-tbody'));
  assert.match(infoBlock, /next server restart/i, 'info block must say files apply on the next server restart');
  assert.match(infoBlock, /one restart per scheduled server restart/i,
    'info block must say rentals consume one restart per scheduled restart');
  assert.match(infoBlock, /refund/i, 'info block must mention refunds');

  console.log('Shop order UX copy tests passed');
})();
