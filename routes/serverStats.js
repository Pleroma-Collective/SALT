/*
 * routes/serverStats.js
 *
 * Proxy for Nitrado gameserver statistics (player count, CPU, memory over time).
 * Raw data is downsampled before sending to keep chart rendering fast.
 *
 *   GET /api/stats/:serverId?hours=24  — returns downsampled timeseries data
 *
 * Requires authentication. Token is resolved from the guild that owns the server.
 */

const express = require('express');
const router = express.Router();
const { getGuildTokenForExactServer } = require('../utils/guildTokens');
const { requireServerCapability } = require('../middleware/serverAccess');
const { CAPABILITIES } = require('../services/authorizationService');
const { loadServerOverview } = require('../services/serverMetricsService');
const nitradoService = require('../services/nitradoService');
const { sendExternalApiError } = require('../utils/externalApiResponse');

router.use('/:serverId', requireServerCapability(CAPABILITIES.SERVER_MODERATE));

const MAX_CHART_POINTS = 120;

async function resolveToken(db, authorization) {
  const { id: serverId, platformServerId } = authorization.server;
  const token = await getGuildTokenForExactServer(db, serverId, authorization.guild.id);
  if (!token) return { error: 'No Nitrado token found for this server', status: 403 };

  return { token, platformServerId };
}

/**
 * Evenly downsample an array to at most maxPoints entries.
 * Each entry is [value, unixTimestamp] from the Nitrado stats API.
 */
function downsample(arr, maxPoints) {
  if (!arr || arr.length <= maxPoints) return arr || [];
  const step = Math.ceil(arr.length / maxPoints);
  return arr.filter((_, i) => i % step === 0);
}

/**
 * GET /api/stats/:serverId/overview
 * Return the exact-server operational snapshot. Optional provider failures are
 * represented as warnings so database-backed health remains available.
 */
router.get('/:serverId/overview', async (req, res) => {
  try {
    const overview = await loadServerOverview({
      db: req.app.locals.db,
      authorization: req.authorization,
      tokenResolver: getGuildTokenForExactServer,
      nitrado: nitradoService,
    });
    if (!overview) return res.status(404).json({ error: 'Resource not found' });
    return res.json(overview);
  } catch (error) {
    console.error('Failed to load server health overview:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to load server health overview' });
  }
});

/**
 * GET /api/stats/:serverId
 * Query params: hours=6|12|24|48 (defaults to 24)
 *
 * Returns downsampled timeseries for players, CPU %, and memory %.
 */
router.get('/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { token, platformServerId, error, status } = await resolveToken(db, req.authorization);
  if (error) return res.status(status).json({ success: false, error });

  const hours = Math.min(48, Math.max(1, parseInt(req.query.hours, 10) || 24));

  try {
    const raw = await nitradoService.getStats(token, platformServerId, hours);

    // Each metric from Nitrado is an array of [value, unixTimestampSeconds]
    const players    = downsample(raw.currentPlayers || [], MAX_CHART_POINTS);
    const cpu        = downsample(raw.cpuUsage       || [], MAX_CHART_POINTS);
    const memory     = downsample(raw.memoryUsage    || [], MAX_CHART_POINTS);
    const maxPlayers = downsample(raw.maxPlayers     || [], MAX_CHART_POINTS);

    // Build time labels from whichever metric has data
    const base = players.length ? players : cpu.length ? cpu : memory;
    const labels = base.map(([, ts]) => {
      const d = new Date(ts * 1000);
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    });

    res.json({
      success: true,
      hours,
      labels,
      players:    players.map(([v]) => v),
      cpu:        cpu.map(([v]) => v),
      memory:     memory.map(([v]) => v),
      maxPlayers: maxPlayers.map(([v]) => v),
    });
  } catch (err) {
    sendExternalApiError(res, err, 'Nitrado');
  }
});

/**
 * GET /api/stats/:serverId/death-causes?days=7&bucket=hour|day
 *
 * Death-cause distribution over time, from 'player.death_cause' events in the
 * events table (persisted by the ADM death-cause scanner).
 */
router.get('/:serverId/death-causes', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const serverId = req.authorization.server.id;
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
    const bucket = req.query.bucket === 'hour' ? 'hour' : 'day';
    const format = bucket === 'hour' ? 'YYYY-MM-DD HH24' : 'YYYY-MM-DD';

    const rows = await db.all(
      `SELECT (payload->>'cause') AS cause,
              to_char(date_trunc(?, timestamp), ?) AS bucket,
              COUNT(*)::int AS n
       FROM events
       WHERE server_id = ? AND event_type = 'player.death_cause'
         AND timestamp >= NOW() - (? || ' days')::interval
       GROUP BY 1, 2
       ORDER BY 2, 1`,
      [bucket, format, serverId, String(days)]
    );

    const totals = {};
    for (const row of rows) totals[row.cause] = (totals[row.cause] || 0) + row.n;

    res.json({
      success: true,
      days,
      bucket,
      total: rows.reduce((sum, r) => sum + r.n, 0),
      totals,
      series: rows.map(r => ({ bucket: r.bucket, cause: r.cause, n: r.n })),
    });
  } catch (error) {
    console.error('Failed to load death causes:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load death causes' });
  }
});

/**
 * GET /api/stats/:serverId/pvp-leaderboard?days=30&limit=20
 *
 * PVP leaderboard from 'player.death_cause' events with cause='pvp':
 * top killers by kill count (top weapon + average distance per killer) and
 * the server's most-used kill weapons.
 */
router.get('/:serverId/pvp-leaderboard', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const serverId = req.authorization.server.id;
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    const limit = Math.min(50, Math.max(5, parseInt(req.query.limit, 10) || 20));
    const where = `server_id = ? AND event_type = 'player.death_cause'
       AND payload->>'cause' = 'pvp' AND timestamp >= NOW() - (? || ' days')::interval`;

    const killers = await db.all(
      `SELECT payload->>'killerName' AS killer,
              COUNT(*)::int AS kills,
              AVG((payload->>'distance')::float) AS avg_distance
       FROM events WHERE ${where}
       GROUP BY 1
       ORDER BY kills DESC, killer
       LIMIT ?`,
      [serverId, String(days), limit]
    );

    let weaponRows = [];
    const killerNames = killers.map(k => k.killer).filter(Boolean);
    if (killerNames.length > 0) {
      weaponRows = await db.all(
        `SELECT payload->>'killerName' AS killer, payload->>'weapon' AS weapon, COUNT(*)::int AS n
         FROM events WHERE ${where} AND payload->>'killerName' = ANY(?)
         GROUP BY 1, 2`,
        [serverId, String(days), killerNames]
      );
    }

    // Mode weapon per killer (ties broken alphabetically).
    const weaponsByKiller = new Map();
    for (const row of weaponRows) {
      const list = weaponsByKiller.get(row.killer) || [];
      list.push({ weapon: row.weapon, n: row.n });
    }
    const leaderboard = killers.map(k => {
      let topWeapon = null;
      for (const w of weaponsByKiller.get(k.killer) || []) {
        if (w.n > 0 && (!topWeapon || w.n > topWeapon.n || (w.n === topWeapon.n && w.weapon < topWeapon.weapon))) {
          topWeapon = w;
        }
      }
      return {
        killer: k.killer,
        kills: k.kills,
        avgDistance: k.avg_distance != null ? Math.round(k.avg_distance * 10) / 10 : null,
        topWeapon: topWeapon ? topWeapon.weapon : null,
      };
    });

    const topWeapons = await db.all(
      `SELECT payload->>'weapon' AS weapon, COUNT(*)::int AS kills
       FROM events WHERE ${where} AND payload->>'weapon' IS NOT NULL
       GROUP BY 1
       ORDER BY kills DESC, weapon
       LIMIT 10`,
      [serverId, String(days)]
    );

    res.json({
      success: true,
      days,
      totalKills: leaderboard.reduce((sum, k) => sum + k.kills, 0),
      leaderboard,
      topWeapons,
    });
  } catch (error) {
    console.error('Failed to load PVP leaderboard:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load PVP leaderboard' });
  }
});

module.exports = router;
