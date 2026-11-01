/*
 * routes/ceDynamicEventRates.js
 *
 * CE Dynamic Event spawn-rate monitor (admin analytics).
 *
 *   GET /api/dynamic-event-rates/:serverId?days=30
 *
 * Reads the `events` rows persisted by the [CE][DE] log parser
 * (routes/logParser.js, eventType 'ce.dynamic_event') and returns per-type
 * spawn counts, per-day rate, and a zero-filled daily trend series for the
 * requested window. Gated to server admins or above (guild owner/admin or an
 * exact active server-admin assignment) via serverAccess.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { CAPABILITIES, requireServerCapability } = require('../middleware/serverAccess');
const { humanNameForDeType } = require('../utils/ceDynamicEvents');

const MAX_WINDOW_DAYS = 365;

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Pure aggregation: raw (de_type, day, last_seen, count) rows → monitor payload.
 * Zero-fills every UTC calendar day in the window so the trend stays
 * continuous. Rows outside the window are dropped (defensive).
 *
 * @param {Array<{de_type:string, day:string, last_seen:Date|string, count:number}>} rows
 * @param {{days:number, now?:Date}} opts
 */
function aggregateDeRateRows(rows, { days, now = new Date() } = {}) {
  const windowDays = Math.min(Math.max(1, Math.floor(Number(days) || 30)), MAX_WINDOW_DAYS);
  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));

  const dayIndex = new Map();
  const daily = [];
  for (let i = 0; i < windowDays; i++) {
    const day = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    dayIndex.set(day, i);
    daily.push({ day, total: 0, byType: {} });
  }

  const types = new Map();
  let total = 0;
  for (const row of rows) {
    const dayKey = (row.day instanceof Date ? row.day.toISOString() : String(row.day)).slice(0, 10);
    const idx = dayIndex.get(dayKey);
    if (idx === undefined) continue;
    const count = Math.max(0, Math.floor(Number(row.count) || 0));
    if (count === 0) continue;
    total += count;
    daily[idx].total += count;
    daily[idx].byType[row.de_type] = (daily[idx].byType[row.de_type] || 0) + count;
    let t = types.get(row.de_type);
    if (!t) {
      t = { deType: row.de_type, count: 0, lastSeen: null };
      types.set(row.de_type, t);
    }
    t.count += count;
    const seen = row.last_seen;
    if (seen && (!t.lastSeen || new Date(seen) > new Date(t.lastSeen))) t.lastSeen = seen;
  }

  const perType = [...types.values()]
    .sort((a, b) => b.count - a.count || a.deType.localeCompare(b.deType))
    .map(t => ({
      deType: t.deType,
      humanName: humanNameForDeType(t.deType),
      count: t.count,
      perDay: round2(t.count / windowDays),
      lastSeen: t.lastSeen ? new Date(t.lastSeen).toISOString() : null,
    }));

  return {
    windowDays,
    generatedAt: new Date(now).toISOString(),
    total,
    activeDays: daily.filter(d => d.total > 0).length,
    avgPerDay: round2(total / windowDays),
    perType,
    daily,
  };
}

/**
 * GET /:serverId?days=30 — per-type CE dynamic event spawn rates + daily trend.
 */
router.get('/:serverId', requireServerCapability(CAPABILITIES.SERVER_MANAGE), async (req, res) => {
  try {
    const db = req.app.locals.db;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), MAX_WINDOW_DAYS);
    const rows = await db.query(
      `SELECT payload->>'deType' AS de_type,
              to_char((date_trunc('day', timestamp)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              MAX(timestamp) AS last_seen,
              COUNT(*) AS count
       FROM events
       WHERE server_id = ? AND event_type = 'ce.dynamic_event'
         AND deleted_at IS NULL
         AND timestamp >= NOW() - make_interval(days => ?)
       GROUP BY 1, 2
       ORDER BY 1, 2`,
      [req.authorization.server.id, days]
    );
    const result = aggregateDeRateRows(rows, { days, now: new Date() });
    return res.json({ success: true, serverId: req.authorization.server.id, ...result });
  } catch (err) {
    console.error('❌ /api/dynamic-event-rates error:', err.message);
    return res.status(500).json({ success: false, error: 'Database error' });
  }
});

module.exports = router;
module.exports.aggregateDeRateRows = aggregateDeRateRows;
module.exports.MAX_WINDOW_DAYS = MAX_WINDOW_DAYS;
