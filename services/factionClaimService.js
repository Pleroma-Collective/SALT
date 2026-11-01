/**
 * Faction Wars — settlement flag claims
 *
 * Settlements (nasdara) have boundaries and are claimed by placing flags.
 *
 *   - A flag placed inside a settlement's boundary counts toward that
 *     settlement's claim for its faction.
 *   - Claiming a settlement requires that ONE faction to have placed the
 *     threshold of flags (all flags of the threshold belong to one faction —
 *     majority does NOT count; a split 2+2 on a 4-flag settlement claims
 *     nothing).
 *   - Flag thresholds scale with settlement size (documented below).
 *   - A flag placed OUTSIDE any settlement claims only its own radius circle
 *     — it never contributes to a settlement claim.
 *
 * Conflict rules (documented defaults):
 *   - The settlement belongs to the faction with the MOST flags in its
 *     boundary, provided that count reaches the threshold. Ties keep the
 *     current owner (a faction must strictly out-flag the owner to take the
 *     settlement over).
 *   - Claims never time out: they persist until the owner's flag count drops
 *     below the threshold (flags removed/cleared) or another faction
 *     out-flags them. Wipes are handled by admin clearing flags.
 *
 * Boundaries: the map data ships settlements as named points with no
 * footprint polygon, so the honest boundary is a per-kind radius table
 * (SETTLEMENT_BOUNDARY_RADIUS below), same convention as the illustrative
 * settlement radii on the ops map.
 *
 * Surfaces (one engine, two writers):
 *   - dashboard admin page (/admin/faction-war) via routes/admin.js
 *   - bot command (/faction-war) via bot/commands/faction-war.js
 * Both call placeFlag/removeFlag on this module with a dashboard db adapter
 * (backend: req.app.locals.db; bot: bot/utils/dashboardDbAdapter), so claim
 * recomputation and feed delivery happen exactly once per flag change.
 *
 * Feed wiring: claim transitions (claimed / taken / lost) post to the guild's
 * EXISTING faction war feed — discord_feeds feed_type='faction_feed' set by
 * /setup-feeds faction enable. No new feed type.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { postToDiscord, validateDiscordDestination } = require('../utils/discordPoster');

// Documented size → boundary/threshold mapping (meters / flags).
// capital ≈ the largest settlement (capital city); city ≈ city; village ≈
// every village sub-type (Local/Village/Marine/Hill/Ruin) — the settlement
// data carries kind only, which is all the boundary needs.
const SETTLEMENT_BOUNDARY_RADIUS = Object.freeze({
  capital: 1500,
  city: 800,
  village: 400,
});

const FLAGS_NEEDED = Object.freeze({
  capital: 5,
  city: 3,
  village: 1,
});

// Out-of-settlement flags claim only their own circle.
const DEFAULT_FLAG_RADIUS_M = 100;
const MIN_FLAG_RADIUS_M = 25;
const MAX_FLAG_RADIUS_M = 1000;

const DATA_ROOT = path.join(__dirname, '..', 'data');

/* ─── Pure rules (unit-tested, no I/O) ───────────────────────────────────── */

/** Boundary radius (m) for a settlement kind; unknown kinds fall back to village. */
function boundaryRadiusForKind(kind) {
  return SETTLEMENT_BOUNDARY_RADIUS[String(kind || '').toLowerCase()] ?? SETTLEMENT_BOUNDARY_RADIUS.village;
}

/** Flag threshold for a settlement kind; unknown kinds fall back to village. */
function flagsNeededForKind(kind) {
  return FLAGS_NEEDED[String(kind || '').toLowerCase()] ?? FLAGS_NEEDED.village;
}

/**
 * Which settlement's boundary contains the point (east, north)?
 * @param {Array<{id:string, position:{east:number, north:number}, kind:string}>} settlements
 * @returns {object|null} the containing settlement (closest one when boundaries overlap)
 */
function settlementAt(settlements, east, north) {
  let best = null;
  let bestDist = Infinity;
  for (const s of settlements || []) {
    const pos = s && s.position;
    if (!pos || !Number.isFinite(pos.east) || !Number.isFinite(pos.north)) continue;
    const dx = east - pos.east;
    const dz = north - pos.north;
    const dist2 = dx * dx + dz * dz;
    const r = boundaryRadiusForKind(s.kind);
    if (dist2 <= r * r && dist2 < bestDist) {
      best = s;
      bestDist = dist2;
    }
  }
  return best;
}

/**
 * Pure claim decision for one settlement.
 *
 * @param {object} args
 * @param {number} args.needed             threshold flags
 * @param {object} args.counts             factionId -> flags inside the boundary
 * @param {{factionId:number}|null} args.currentClaim  existing claim row (or null)
 * @returns {{ownerFactionId: number|null, flagsMet: number,
 *            event: {type:'claimed'|'claim_taken'|'claim_lost', factionId:number}|null}}
 */
function computeClaimState({ needed, counts, currentClaim }) {
  const entries = Object.entries(counts || {});
  let topFaction = null;
  let topCount = 0;
  for (const [factionId, count] of entries) {
    if (count > topCount) { topFaction = Number(factionId); topCount = count; }
  }
  // Ties: the current owner keeps a tie at the top (takeover must strictly
  // out-flag the owner, or the owner must drop below the threshold).
  if (currentClaim && topFaction !== null) {
    const ownerCount = Number(counts[currentClaim.factionId] ?? 0);
    if (ownerCount === topCount && ownerCount > 0) {
      topFaction = Number(currentClaim.factionId);
      topCount = ownerCount;
    }
  }

  if (topCount >= needed && topFaction !== null) {
    if (currentClaim && Number(currentClaim.factionId) === topFaction) {
      return { ownerFactionId: topFaction, flagsMet: topCount, event: null };
    }
    return {
      ownerFactionId: topFaction,
      flagsMet: topCount,
      event: currentClaim
        ? { type: 'claim_taken', factionId: topFaction }
        : { type: 'claimed', factionId: topFaction },
    };
  }
  return {
    ownerFactionId: null,
    flagsMet: 0,
    event: currentClaim ? { type: 'claim_lost', factionId: Number(currentClaim.factionId) } : null,
  };
}

/** Color for a faction on the map (deterministic golden-angle hue by id). */
function factionColor(factionId) {
  const id = Number(factionId) || 0;
  const hue = (id * 137.508) % 360;
  return `hsl(${Math.round(hue)}, 72%, 52%)`;
}

/* ─── Settlement data ────────────────────────────────────────────────────── */

/** Load the static settlement list for a map (data/<map>/settlements.json). */
function loadSettlements(mapName) {
  const file = path.join(DATA_ROOT, String(mapName || 'nasdara'), 'settlements.json');
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.settlements)) throw new Error('malformed settlements.json');
  return data.settlements;
}

/* ─── DB layer ───────────────────────────────────────────────────────────── */

function normalizeFlag(row) {
  return {
    id: Number(row.id),
    server_id: Number(row.server_id),
    map_name: row.map_name,
    east: Number(row.east),
    north: Number(row.north),
    settlement_id: row.settlement_id || null,
    faction_id: Number(row.faction_id),
    faction_name: row.faction_name || null,
    faction_tag: row.faction_tag || null,
    placed_by: row.placed_by,
    radius_m: Number(row.radius_m),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function normalizeClaim(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    server_id: Number(row.server_id),
    settlement_id: row.settlement_id,
    faction_id: Number(row.faction_id),
    faction_name: row.faction_name || null,
    faction_tag: row.faction_tag || null,
    flags_needed: Number(row.flags_needed),
    flags_met: Number(row.flags_met),
    claimed_at: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
  };
}

/**
 * Full faction-war state for a server: every flag and every claim, enriched
 * with faction name/tag. Null when the server does not exist.
 */
async function getWarState(db, serverId) {
  const serverRow = await db.get(
    `SELECT s.id, s.name, g.discord_guild_id
     FROM servers s JOIN guilds g ON g.id = s.guild_id
     WHERE s.id = ?`,
    [Number(serverId)]
  );
  if (!serverRow) return null;

  const [flags, claims] = await Promise.all([
    db.query(
      `SELECT f.id, f.server_id, f.map_name, f.east, f.north, f.settlement_id,
              f.faction_id, f.placed_by, f.radius_m, f.created_at,
              fa.name AS faction_name, fa.tag AS faction_tag
       FROM faction_flags f
       JOIN factions fa ON fa.id = f.faction_id
       WHERE f.server_id = ?
       ORDER BY f.created_at ASC, f.id ASC`,
      [Number(serverId)]
    ),
    db.query(
      `SELECT c.id, c.server_id, c.settlement_id, c.faction_id,
              c.flags_needed, c.flags_met, c.claimed_at,
              fa.name AS faction_name, fa.tag AS faction_tag
       FROM faction_claims c
       JOIN factions fa ON fa.id = c.faction_id
       WHERE c.server_id = ?
       ORDER BY c.claimed_at DESC`,
      [Number(serverId)]
    ),
  ]);

  return {
    server: { id: serverRow.id, name: serverRow.name, guildId: serverRow.discord_guild_id },
    flags: flags.map(normalizeFlag),
    claims: claims.map(normalizeClaim),
  };
}

/**
 * Settlement list for a map with per-settlement flags + claim attached
 * (admin page and owner map). Settlements are static per map; flags/claims
 * are per server.
 */
async function getSettlementsForServer(db, serverId, mapName = 'nasdara') {
  const settlements = loadSettlements(mapName);
  const state = await getWarState(db, serverId);
  if (!state) return null;
  const claimBySettlement = new Map(state.claims.map(c => [c.settlement_id, c]));
  const flagsBySettlement = new Map();
  for (const flag of state.flags) {
    if (!flag.settlement_id) continue;
    if (!flagsBySettlement.has(flag.settlement_id)) flagsBySettlement.set(flag.settlement_id, []);
    flagsBySettlement.get(flag.settlement_id).push(flag);
  }
  return settlements.map(s => ({
    id: s.id,
    name: s.names?.en || s.id,
    kind: s.kind,
    east: s.position.east,
    north: s.position.north,
    boundary_radius_m: boundaryRadiusForKind(s.kind),
    flags_needed: flagsNeededForKind(s.kind),
    flags: flagsBySettlement.get(s.id) || [],
    claim: claimBySettlement.get(s.id) || null,
  }));
}

/** Factions available to a server's guild (for the placement UI). */
async function listFactionsForServer(db, serverId) {
  const rows = await db.query(
    `SELECT fa.id, fa.name, fa.tag, fa.emblem
     FROM factions fa
     JOIN guilds g ON g.id = fa.guild_id
     JOIN servers s ON s.guild_id = g.id
     WHERE s.id = ?
     ORDER BY fa.name ASC`,
    [Number(serverId)]
  );
  return rows.map(r => ({ id: Number(r.id), name: r.name, tag: r.tag, emblem: r.emblem || '' }));
}

/* ─── Flag mutations + claim recomputation ───────────────────────────────── */

async function countFlagsByFactionInSettlement(db, serverId, settlementId) {
  const rows = await db.query(
    `SELECT faction_id, COUNT(*)::int AS n
     FROM faction_flags
     WHERE server_id = ? AND settlement_id = ?
     GROUP BY faction_id`,
    [Number(serverId), settlementId]
  );
  const counts = {};
  for (const row of rows) counts[Number(row.faction_id)] = Number(row.n);
  return counts;
}

async function getClaimRow(db, serverId, settlementId) {
  return db.get(
    `SELECT id, faction_id, flags_needed, flags_met FROM faction_claims
     WHERE server_id = ? AND settlement_id = ?`,
    [Number(serverId), settlementId]
  );
}

/**
 * Recompute one settlement's claim from its current flags and apply the
 * decision to the DB. Returns the feed event, if any (claimed / claim_taken /
 * claim_lost).
 */
async function recomputeSettlementClaim(db, serverId, settlement) {
  const needed = flagsNeededForKind(settlement.kind);
  const counts = await countFlagsByFactionInSettlement(db, serverId, settlement.id);
  const current = await getClaimRow(db, serverId, settlement.id);
  const decision = computeClaimState({ needed, counts, currentClaim: current });

  if (decision.ownerFactionId === null) {
    if (current) {
      await db.run(
        'DELETE FROM faction_claims WHERE server_id = ? AND settlement_id = ?',
        [Number(serverId), settlement.id]
      );
      return { type: 'claim_lost', factionId: Number(current.faction_id), flagsMet: 0, settlementId: settlement.id };
    }
    return null;
  }

  if (current && Number(current.faction_id) === decision.ownerFactionId) {
    if (Number(current.flags_met) !== decision.flagsMet) {
      await db.run(
        'UPDATE faction_claims SET flags_met = ? WHERE server_id = ? AND settlement_id = ?',
        [decision.flagsMet, Number(serverId), settlement.id]
      );
    }
    return null;
  }

  await db.run(
    `INSERT INTO faction_claims (server_id, settlement_id, faction_id, flags_needed, flags_met, claimed_at)
     VALUES (?, ?, ?, ?, ?, NOW())
     ON CONFLICT (server_id, settlement_id)
     DO UPDATE SET faction_id = EXCLUDED.faction_id,
                   flags_needed = EXCLUDED.flags_needed,
                   flags_met = EXCLUDED.flags_met,
                   claimed_at = NOW()`,
    [Number(serverId), settlement.id, decision.ownerFactionId, needed, decision.flagsMet]
  );
  return {
    type: current ? 'claim_taken' : 'claimed',
    factionId: decision.ownerFactionId,
    flagsMet: decision.flagsMet,
    settlementId: settlement.id,
  };
}

/**
 * Place a flag for a faction. Settlement membership is decided from the map's
 * settlement data at placement time; the settlement boundary (or the flag's
 * own radius, when outside) is what the map renders.
 *
 * @returns {Promise<{flag: object, settlement: object|null, claimEvent: object|null}>}
 */
async function placeFlag(db, serverId, input = {}, options = {}) {
  const mapName = String(input.mapName || 'nasdara').toLowerCase();
  const east = Number(input.east);
  const north = Number(input.north);
  if (!Number.isFinite(east) || !Number.isFinite(north)) {
    throw new Error('east and north must be finite numbers');
  }
  const factionId = Number(input.factionId);
  if (!Number.isSafeInteger(factionId) || factionId <= 0) throw new Error('factionId must be a positive integer');
  const placedBy = String(input.placedBy || '').trim();
  if (!placedBy || placedBy.length > 200) throw new Error('placedBy must be a 1-200 character label');
  const radiusM = Number(input.radiusM ?? DEFAULT_FLAG_RADIUS_M);
  if (!Number.isFinite(radiusM) || radiusM < MIN_FLAG_RADIUS_M || radiusM > MAX_FLAG_RADIUS_M) {
    throw new Error(`radiusM must be between ${MIN_FLAG_RADIUS_M} and ${MAX_FLAG_RADIUS_M}`);
  }

  // Faction must exist in this server's guild (FK would reject anyway, but
  // validate for a clean error + to fetch the name for the feed).
  const faction = await db.get(
    `SELECT fa.id, fa.name, fa.tag, g.discord_guild_id
     FROM factions fa
     JOIN guilds g ON g.id = fa.guild_id
     JOIN servers s ON s.guild_id = g.id
     WHERE s.id = ? AND fa.id = ?`,
    [Number(serverId), factionId]
  );
  if (!faction) throw new Error('faction not found for this server');

  const settlements = loadSettlements(mapName);
  const settlement = settlementAt(settlements, east, north);

  const row = await db.get(
    `INSERT INTO faction_flags
       (server_id, map_name, east, north, settlement_id, faction_id, placed_by, radius_m, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    [Number(serverId), mapName, east, north, settlement ? settlement.id : null, factionId, placedBy, radiusM, options.nowIso || new Date().toISOString()]
  );

  let claimEvent = null;
  if (settlement) {
    claimEvent = await recomputeSettlementClaim(db, serverId, settlement);
  }

  return {
    flag: {
      id: Number(row.id),
      server_id: Number(serverId),
      map_name: mapName,
      east, north,
      settlement_id: settlement ? settlement.id : null,
      faction_id: factionId,
      faction_name: faction.name,
      faction_tag: faction.tag,
      placed_by: placedBy,
      radius_m: radiusM,
    },
    settlement: settlement ? {
      id: settlement.id,
      name: settlement.names?.en || settlement.id,
      kind: settlement.kind,
      east: settlement.position.east,
      north: settlement.position.north,
      boundary_radius_m: boundaryRadiusForKind(settlement.kind),
      flags_needed: flagsNeededForKind(settlement.kind),
    } : null,
    claimEvent,
  };
}

/**
 * Remove one flag and recompute its settlement's claim (if any).
 * @returns {Promise<{removed: boolean, claimEvent: object|null}>}
 */
async function removeFlag(db, serverId, flagId) {
  const row = await db.get(
    `SELECT id, settlement_id, map_name FROM faction_flags WHERE server_id = ? AND id = ?`,
    [Number(serverId), Number(flagId)]
  );
  if (!row) return { removed: false, claimEvent: null };
  await db.run(
    'DELETE FROM faction_flags WHERE server_id = ? AND id = ?',
    [Number(serverId), Number(flagId)]
  );
  let claimEvent = null;
  if (row.settlement_id) {
    const settlements = loadSettlements(row.map_name || 'nasdara');
    const settlement = settlements.find(s => s.id === row.settlement_id);
    if (settlement) claimEvent = await recomputeSettlementClaim(db, Number(serverId), settlement);
  }
  return { removed: true, claimEvent };
}

/**
 * Clear ALL flags on a settlement (any faction) — releases the claim.
 * @returns {Promise<{removed: number, claimEvent: object|null}>}
 */
async function clearSettlementFlags(db, serverId, settlementId, mapName = 'nasdara') {
  const result = await db.run(
    'DELETE FROM faction_flags WHERE server_id = ? AND settlement_id = ?',
    [Number(serverId), settlementId]
  );
  const removed = result ? Number(result.changes) : 0;
  const settlements = loadSettlements(mapName);
  const settlement = settlements.find(s => s.id === settlementId);
  let claimEvent = null;
  if (settlement) claimEvent = await recomputeSettlementClaim(db, Number(serverId), settlement);
  return { removed, claimEvent };
}

/**
 * Remove ONE faction's flags from a settlement (other factions keep theirs)
 * and recompute the claim.
 * @returns {Promise<{removed: number, claimEvent: object|null}>}
 */
async function removeFactionFlagsFromSettlement(db, serverId, factionId, settlementId, mapName = 'nasdara') {
  const result = await db.run(
    `DELETE FROM faction_flags WHERE server_id = ? AND faction_id = ? AND settlement_id = ?`,
    [Number(serverId), Number(factionId), settlementId]
  );
  const removed = result ? Number(result.changes) : 0;
  const settlements = loadSettlements(mapName);
  const settlement = settlements.find(s => s.id === settlementId);
  let claimEvent = null;
  if (settlement) claimEvent = await recomputeSettlementClaim(db, Number(serverId), settlement);
  return { removed, claimEvent };
}

/* ─── Feed delivery (existing faction war feed) ──────────────────────────── */

function buildClaimMessage(event, settlement, faction) {
  const title = event.type === 'claimed'
    ? `🚩 ${settlement.name} claimed by ${faction.name}`
    : event.type === 'claim_taken'
      ? `⚔️ ${settlement.name} taken by ${faction.name}`
      : `🏳️ ${settlement.name} claim lost`;
  return {
    embeds: [{
      title,
      description: [
        `**${settlement.name}** (${settlement.kind}) — ${event.flagsMet ?? '—'} of ${settlement.flags_needed} flags`,
        `Faction: ${faction.name}${faction.tag ? ` [${faction.tag}]` : ''}`,
        event.type === 'claim_lost'
          ? 'Not enough flags remain in the boundary; territory is unclaimed.'
          : null,
      ].filter(Boolean).join('\n'),
      color: 0xE53935,
      footer: { text: `Faction Wars · ${settlement.flags_needed} flags required` },
    }],
  };
}

/**
 * Post claim events to the guild's enabled faction feed (discord_feeds
 * feed_type='faction_feed'). No-op when the feed is disabled/unconfigured.
 *
 * @returns {Promise<{posted: number}>}
 */
async function deliverClaimEvents(db, serverId, events, options = {}) {
  const post = options.post || postToDiscord;
  const validate = options.validate || validateDiscordDestination;
  let posted = 0;
  for (const event of events || []) {
    if (!event || !event.settlementId) continue;
    const feed = await db.get(
      `SELECT guild_id, channel_id FROM discord_feeds
       WHERE server_id = ? AND feed_type = 'faction_feed' AND enabled = 1`,
      [Number(serverId)]
    );
    if (!feed) continue;
    // discord_feeds.guild_id is the DISCORD guild id (text snowflake) — no
    // guilds lookup needed; it is the validation destination directly.
    const okDest = await validate(String(feed.guild_id), String(feed.channel_id), null);
    // Settlement names live in the static map data, not the DB.
    const settlements = loadSettlements('nasdara');
    const settlement = settlements.find(s => s.id === event.settlementId);
    if (!settlement) continue;
    const faction = await db.get(
      `SELECT name, tag FROM factions WHERE id = ?`,
      [Number(event.factionId)]
    );
    if (!faction) continue;
    if (!okDest) continue;
    const content = buildClaimMessage(event, {
      name: settlement.names?.en || settlement.id,
      kind: settlement.kind,
      flags_needed: flagsNeededForKind(settlement.kind),
    }, { name: faction.name, tag: faction.tag });
    if (await post(String(feed.channel_id), null, content, true)) posted += 1;
  }
  return { posted };
}

module.exports = {
  // pure
  boundaryRadiusForKind,
  flagsNeededForKind,
  settlementAt,
  computeClaimState,
  factionColor,
  buildClaimMessage,
  // data
  loadSettlements,
  // state
  getWarState,
  getSettlementsForServer,
  listFactionsForServer,
  // mutations
  placeFlag,
  removeFlag,
  removeFactionFlagsFromSettlement,
  clearSettlementFlags,
  recomputeSettlementClaim,
  // feed
  deliverClaimEvents,
  _internal: {
    SETTLEMENT_BOUNDARY_RADIUS,
    FLAGS_NEEDED,
    DEFAULT_FLAG_RADIUS_M,
    MIN_FLAG_RADIUS_M,
    MAX_FLAG_RADIUS_M,
    countFlagsByFactionInSettlement,
    getClaimRow,
  },
};
