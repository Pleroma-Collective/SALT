/*
 * DayZ Dashboard - Shop Player Hotkey Service
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Per-player, per-server item hotkeys. A player binds one key to a shop
 * item; triggering the hotkey spawns the item at the player's last-known
 * in-game location (newest player_position_snapshots row) and checks it
 * out immediately, reusing the standard shop checkout pipeline.
 */

'use strict';

const shopFileService = require('./shopFileService');
const { addCartItem, isCatalogItemPurchasable } = require('./shopCartService');
const {
  emoteEventToShopCoordinates,
} = require('./shopEmoteCaptureService');
const {
  claimFinancialOperationInTransaction,
  completeFinancialOperationInTransaction,
  fingerprintFinancialRequest,
} = require('../utils/financialIdempotency');

const HOTKEY_PATTERN = /^([A-Z0-9]|F[1-9]|F1[0-2])$/;

/**
 * Normalize a hotkey to its canonical uppercase form.
 * Accepts a single letter, a single digit, or F1-F12.
 */
function normalizeHotkey(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Hotkey must be a single letter, digit, or F1-F12');
  }
  const key = value.trim().toUpperCase();
  if (!HOTKEY_PATTERN.test(key)) {
    throw new TypeError('Hotkey must be a single letter, digit, or F1-F12');
  }
  return key;
}

function hotkeyError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** Newest position snapshot for the player on the exact server, or null. */
async function getLatestPositionSnapshot(db, { identityId, serverId }) {
  return db.get(
    `SELECT pos_x, pos_y, pos_z, timestamp
     FROM player_position_snapshots
     WHERE identity_id = ? AND server_id = ?
       AND pos_x IS NOT NULL AND pos_y IS NOT NULL
     ORDER BY timestamp DESC, id DESC
     LIMIT 1`,
    [identityId, serverId]
  );
}

/**
 * Convert a position snapshot row (ADM tuple order: x=east, y=north,
 * z=elevation) to shop order-item coordinates (x=east, y=elevation,
 * z=north). Same swap the emote capture path applies.
 */
function snapshotToSpawnCoordinates(snapshot) {
  return emoteEventToShopCoordinates(snapshot);
}

/**
 * Resolve a bound hotkey to a spawn-ready plan: catalog item + captured
 * coordinates + snapshot age. Throws a status-carrying Error when the
 * binding is missing, the item is gone, or no location is on record.
 */
async function resolveHotkeySpawn(db, { serverId, identityId, hotkey }) {
  const key = normalizeHotkey(hotkey);
  const binding = await db.get(
    `SELECT * FROM shop_player_hotkeys
     WHERE server_id = ? AND identity_id = ? AND hotkey = ?`,
    [serverId, identityId, key]
  );
  if (!binding) {
    throw hotkeyError(`No item is bound to hotkey ${key} on this server`, 404);
  }
  const shopItem = await db.get(
    'SELECT * FROM shop_items WHERE id = ? AND server_id = ? AND is_active = true AND deleted_at IS NULL',
    [binding.shop_item_id, serverId]
  );
  if (!shopItem) throw hotkeyError('The bound shop item is no longer available', 404);
  if (!isCatalogItemPurchasable(shopItem)) {
    throw hotkeyError('The bound item uses an unsupported provisioning method', 409);
  }
  const snapshot = await getLatestPositionSnapshot(db, { identityId, serverId });
  if (!snapshot) {
    throw hotkeyError(
      'No recent in-game location on record for this player. '
      + 'The server reports positions every few minutes — try again shortly.',
      409
    );
  }
  return {
    hotkey: key,
    shopItem,
    snapshot,
    coordinates: snapshotToSpawnCoordinates(snapshot),
    ageSeconds: Math.max(0, Math.floor((Date.now() - new Date(snapshot.timestamp).getTime()) / 1000)),
  };
}

/**
 * Spawn a hotkey-bound item at the player's last-known location and check
 * it out, inside a caller-provided transaction. Mirrors the /checkout route:
 * shared server lock, financial idempotency claim, cart line insert, then the
 * standard processCheckout pipeline.
 */
async function usePlayerHotkeyInTransaction(db, {
  userId, identityId, serverId, hotkey, idempotencyKey, timer,
}) {
  await shopFileService.acquireShopServerLock(db, serverId);
  const plan = await resolveHotkeySpawn(db, { serverId, identityId, hotkey });

  const claim = await claimFinancialOperationInTransaction(db, {
    serverId,
    identityId,
    actorUserId: userId,
    operation: 'shop_hotkey',
    idempotencyKey,
    requestFingerprint: fingerprintFinancialRequest({
      operation: 'shop_hotkey',
      serverId: Number(serverId),
      identityId: Number(identityId),
      shopItemId: Number(plan.shopItem.id),
      hotkey: plan.hotkey,
    }),
  });
  if (claim.replay) {
    return { replay: true, status: claim.status, body: claim.body };
  }

  const added = await addCartItem(db, {
    identityId,
    serverId,
    shopItemId: plan.shopItem.id,
    quantity: 1,
    ...plan.coordinates,
  });
  if (added.error) {
    const body = { error: added.error, checkoutState: 'failed' };
    await completeFinancialOperationInTransaction(db, claim.id, 409, body);
    return { status: 409, body };
  }

  const cart = await db.get(
    `SELECT * FROM shop_orders
     WHERE identity_id = ? AND server_id = ? AND status = 'cart'`,
    [identityId, serverId]
  );
  if (!cart) {
    const body = { error: 'Cart is no longer available', checkoutState: 'failed' };
    await completeFinancialOperationInTransaction(db, claim.id, 409, body);
    return { status: 409, body };
  }

  const result = await shopFileService.processCheckout(db, cart.id, userId, { timer });
  if (!result.success) {
    const body = { error: result.error, checkoutState: 'failed' };
    await completeFinancialOperationInTransaction(db, claim.id, 409, body);
    return { status: 409, body };
  }

  const body = {
    success: true,
    checkoutState: 'success',
    data: {
      spawn: {
        pos_x: plan.coordinates.pos_x,
        pos_y: plan.coordinates.pos_y,
        pos_z: plan.coordinates.pos_z,
        captured_at: plan.snapshot.timestamp,
        age_seconds: plan.ageSeconds,
        item_name: plan.shopItem.name,
      },
      order: result,
    },
  };
  await completeFinancialOperationInTransaction(db, claim.id, 200, body);
  return { status: 200, body };
}

async function usePlayerHotkey(db, args) {
  return db.transaction(transactionDb => usePlayerHotkeyInTransaction(transactionDb, args));
}

module.exports = {
  normalizeHotkey,
  getLatestPositionSnapshot,
  snapshotToSpawnCoordinates,
  resolveHotkeySpawn,
  usePlayerHotkeyInTransaction,
  usePlayerHotkey,
};
