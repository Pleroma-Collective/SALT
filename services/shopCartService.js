/*
 * DayZ Dashboard - Shop Cart Service
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Cart line-item mutations (add / update / delete) shared by the player
 * cart routes and the per-player shop hotkey flow. All functions run
 * inside a caller-provided transaction.
 */

'use strict';

const shopFileService = require('./shopFileService');
const { normalizeCartCoordinates } = require('../utils/shopCoordinates');
const { normalizeEmoteCaptureConfig } = require('./shopEmoteCaptureService');

/**
 * Normalize the value written to the NOT NULL rental_restarts column.
 * Non-rental items and invalid or missing input use the schema default of one.
 * @param {*} value
 * @returns {number}
 */
function normalizeRentalRestarts(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function isCatalogItemPurchasable(item) {
  if (item?.spawn_method === 'capability') return true;
  try {
    shopFileService.validateProvisioningItem(item);
    return true;
  } catch (_error) {
    return false;
  }
}

function validatePurchaseQuantity(shopItem, value) {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { error: 'Quantity must be a positive integer' };
  }
  if (shopItem.item_type === 'event_rental') {
    if (quantity > normalizeRentalRestarts(shopItem.rental_restarts)) {
      return { error: "Rental duration exceeds this item's configured maximum" };
    }
  } else if (quantity !== 1) {
    return { error: 'Permanent shop items require quantity 1' };
  }
  return { quantity };
}

async function addCartItem(db, body) {
  const {
    identityId, serverId, shopItemId, quantity,
  } = body;
  const shopItem = await db.get(
    'SELECT * FROM shop_items WHERE id = ? AND server_id = ? AND is_active = true AND deleted_at IS NULL',
    [shopItemId, serverId]
  );
  if (!shopItem) return { status: 404, error: 'Shop item not found or inactive' };
  if (!isCatalogItemPurchasable(shopItem)) {
    return { status: 409, error: 'Shop item uses an unsupported provisioning method' };
  }
  const quantityResult = validatePurchaseQuantity(shopItem, quantity);
  if (quantityResult.error) return { status: 400, error: quantityResult.error };
  const validatedQuantity = quantityResult.quantity;
  let coordinates;
  let emoteCaptureConfig;
  try {
    coordinates = normalizeCartCoordinates(body);
    emoteCaptureConfig = normalizeEmoteCaptureConfig(shopItem.emote_capture_config);
  } catch (error) {
    return { status: 400, error: error.message };
  }

  let cart = await db.get(
    `SELECT * FROM shop_orders
     WHERE identity_id = ? AND server_id = ? AND status = 'cart' FOR UPDATE`,
    [identityId, serverId]
  );
  if (!cart) {
    await db.run(
      `INSERT INTO shop_orders (identity_id, server_id, status, total_price)
       VALUES (?, ?, 'cart', 0)
       ON CONFLICT DO NOTHING`,
      [identityId, serverId]
    );
    cart = await db.get(
      `SELECT * FROM shop_orders
       WHERE identity_id = ? AND server_id = ? AND status = 'cart' FOR UPDATE`,
      [identityId, serverId]
    );
  }
  if (!cart) return { status: 409, error: 'Cart is no longer available' };

  await db.run(
    `INSERT INTO shop_order_items
       (order_id, shop_item_id, quantity, unit_price,
        pos_x, pos_y, pos_z, ypr_x, ypr_y, ypr_z,
        spawn_method, restarts_remaining, is_active,
        snapshot_schema_version, item_name_snapshot, image_url_snapshot,
        item_class_snapshot, item_type_snapshot, rental_restarts_snapshot,
        custom_json_file_snapshot, object_spawner_config_snapshot,
        event_name_snapshot, event_config_snapshot,
        capability_config_snapshot, emote_capture_config_snapshot,
        provisioning_version_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, true, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cart.id, shopItemId, validatedQuantity, shopItem.price,
      coordinates.pos_x, coordinates.pos_y, coordinates.pos_z,
      coordinates.ypr_x, coordinates.ypr_y, coordinates.ypr_z,
      shopItem.spawn_method,
      shopItem.item_type === 'event_rental' ? validatedQuantity : null,
      shopItem.name, shopItem.image_url || null,
      shopItem.item_class, shopItem.item_type || 'item', shopItem.rental_restarts,
      shopItem.custom_json_file || null, shopItem.object_spawner_config || null,
      shopItem.event_name || null,
      shopItem.event_config || {}, shopItem.capability_config || null,
      emoteCaptureConfig,
      Number(shopItem.provisioning_version) || 1,
    ]
  );
  await recalculateCartTotal(db, cart.id);
  const cartItem = await db.get(
    `SELECT * FROM shop_order_items
     WHERE order_id = ? AND shop_item_id = ?
     ORDER BY id DESC LIMIT 1`,
    [cart.id, shopItemId]
  );
  return { data: cartItem };
}

async function updateCartItem(db, cartItemId, body) {
  const { quantity } = body;
  const cartItem = await db.get(
    `SELECT soi.*, so.id AS order_id,
            CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_type_snapshot ELSE si.item_type END AS item_type,
            CASE WHEN soi.snapshot_schema_version = 1 THEN soi.rental_restarts_snapshot ELSE si.rental_restarts END AS rental_restarts
     FROM shop_order_items soi
     JOIN shop_orders so ON so.id = soi.order_id
     JOIN shop_items si ON si.id = soi.shop_item_id
     WHERE soi.id = ? AND so.status = 'cart'
     FOR UPDATE OF so`,
    [cartItemId]
  );
  if (!cartItem) return { status: 409, error: 'Cart item is no longer editable' };
  const quantityResult = validatePurchaseQuantity(cartItem, quantity);
  if (quantityResult.error) return { status: 400, error: quantityResult.error };
  let coordinates;
  try {
    coordinates = normalizeCartCoordinates(body, cartItem);
  } catch (error) {
    return { status: 400, error: error.message };
  }

  await db.run(
    `UPDATE shop_order_items SET
       quantity = ?, pos_x = ?, pos_y = ?, pos_z = ?,
       ypr_x = ?, ypr_y = ?, ypr_z = ?
     WHERE id = ? AND order_id = ?`,
    [
      quantityResult.quantity,
      coordinates.pos_x, coordinates.pos_y, coordinates.pos_z,
      coordinates.ypr_x, coordinates.ypr_y, coordinates.ypr_z,
      cartItemId, cartItem.order_id,
    ]
  );
  await recalculateCartTotal(db, cartItem.order_id);
  return { data: await db.get('SELECT * FROM shop_order_items WHERE id = ?', [cartItemId]) };
}

async function deleteCartItem(db, cartItemId) {
  const cartItem = await db.get(
    `SELECT soi.id, so.id AS order_id FROM shop_order_items soi
     JOIN shop_orders so ON so.id = soi.order_id
     WHERE soi.id = ? AND so.status = 'cart'
     FOR UPDATE OF so`,
    [cartItemId]
  );
  if (!cartItem) return { status: 409, error: 'Cart item is no longer removable' };

  await db.run('DELETE FROM shop_order_items WHERE id = ? AND order_id = ?', [cartItemId, cartItem.order_id]);
  await recalculateCartTotal(db, cartItem.order_id);
  return {};
}

async function recalculateCartTotal(db, orderId) {
  await db.run(
    `UPDATE shop_orders SET total_price = (
       SELECT COALESCE(SUM(unit_price * quantity), 0)
       FROM shop_order_items
       WHERE order_id = ?
     )
     WHERE id = ?`,
    [orderId, orderId]
  );
}

module.exports = {
  addCartItem,
  updateCartItem,
  deleteCartItem,
  recalculateCartTotal,
  validatePurchaseQuantity,
  normalizeRentalRestarts,
  isCatalogItemPurchasable,
};
