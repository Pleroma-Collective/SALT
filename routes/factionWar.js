/*
 * DayZ Dashboard — Faction Wars public map endpoint
 *
 * /api/faction-war/:serverId — settlement claims + flags for the owner map
 * overlay (/map). Read-only; the mutation surface is the admin API
 * (routes/admin.js /api/admin/faction-war) and the /faction-war bot command.
 * Auth (ensureAuthenticated) is applied at mount in registerRoutes.js — the
 * /map page that consumes this endpoint is auth-gated the same way.
 */

const express = require('express');
const router = express.Router();
const FactionClaimService = require('../services/factionClaimService');

router.get('/:serverId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const mapName = req.query.map || 'nasdara';
    const settlements = await FactionClaimService.getSettlementsForServer(db, req.params.serverId, mapName);
    if (!settlements) return res.status(404).json({ success: false, error: 'Server not found' });
    const state = await FactionClaimService.getWarState(db, req.params.serverId);
    res.json({
      success: true,
      settlements,
      // Out-of-settlement flags (radius-only claims) ride along; in-settlement
      // flags are already attached per settlement.
      flags: state.flags,
    });
  } catch (err) {
    console.error('❌ /api/faction-war GET error:', err);
    res.status(500).json({ success: false, error: 'Failed to load faction claims' });
  }
});

module.exports = router;
