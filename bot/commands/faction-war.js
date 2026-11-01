/*
 * bot/commands/faction-war.js
 *
 * /faction-war — Faction Wars settlement flag claims
 *
 * Subcommands:
 *   /faction-war flag place <faction> [settlement] [east] [north]
 *     Place a faction flag. Settlement by name places it at the settlement
 *     center; east/north place it at an exact world position (a position
 *     inside a settlement boundary counts for that settlement, otherwise the
 *     flag claims only its own radius circle).
 *   /faction-war flag clear <faction> <settlement>
 *     Remove this faction's flags from a settlement (other factions keep
 *     theirs); the claim recomputes.
 *   /faction-war list
 *     Show the server's claims and flag counts per settlement.
 *
 * Claim engine + feed delivery: services/factionClaimService.js (shared with
 * the /admin/faction-war dashboard page). Claim transitions post to the
 * guild's existing faction war feed (/setup-feeds faction enable).
 */

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const path = require('path');
const pool = require('../db');
const dashboardDb = require('../utils/dashboardDbAdapter');
const FactionClaimService = require('../../services/factionClaimService');

const MAP_NAME = 'nasdara';
const SETTLEMENTS_FILE = path.join(__dirname, '..', '..', 'data', MAP_NAME, 'settlements.json');

let settlementsCache = null;
function getSettlements() {
  if (!settlementsCache) {
    settlementsCache = JSON.parse(require('fs').readFileSync(SETTLEMENTS_FILE, 'utf8')).settlements;
  }
  return settlementsCache;
}

/** Case-insensitive settlement match by display name or id suffix. */
function findSettlement(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { error: 'settlement is required' };
  const exact = getSettlements().find(s =>
    (s.names?.en || '').toLowerCase() === q || s.id.toLowerCase() === q
  );
  if (exact) return { settlement: exact };
  const partial = getSettlements().filter(s =>
    (s.names?.en || '').toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
  );
  if (partial.length === 1) return { settlement: partial[0] };
  if (partial.length > 1) {
    return { error: `Ambiguous settlement "${query}" — did you mean: ${partial.slice(0, 5).map(s => s.names?.en).join(', ')}?` };
  }
  return { error: `Unknown settlement "${query}" (try /faction-war list for names, or east/north for an exact position).` };
}

/** Case-insensitive faction match by tag (preferred) or name. */
async function findFaction(guildDbId, query) {
  const q = String(query || '').trim();
  const res = await pool.query(
    `SELECT id, name, tag FROM factions WHERE guild_id = $1`,
    [guildDbId]
  );
  if (!res.rows.length) return { error: 'No factions exist in this server yet (create one with the faction tools).' };
  const ql = q.toLowerCase();
  const byTag = res.rows.find(f => f.tag.toLowerCase() === ql);
  if (byTag) return { faction: byTag };
  const byName = res.rows.filter(f => f.name.toLowerCase() === ql || f.name.toLowerCase().includes(ql));
  if (byName.length === 1) return { faction: byName[0] };
  if (byName.length > 1) {
    return { error: `Ambiguous faction "${q}" — did you mean: ${byName.slice(0, 5).map(f => f.name).join(', ')}?` };
  }
  return { error: `Unknown faction "${q}" (factions here: ${res.rows.map(f => f.tag).join(', ')}).` };
}

/** Internal servers.id for the authorized Nitrado platform server id. */
async function internalServerId(platformServerId) {
  const res = await pool.query('SELECT id FROM servers WHERE platform_server_id = $1 LIMIT 1', [String(platformServerId)]);
  return res.rows.length ? res.rows[0].id : null;
}

async function guildDbIdFor(guildDiscordId) {
  const res = await pool.query('SELECT id FROM guilds WHERE discord_guild_id = $1 LIMIT 1', [String(guildDiscordId)]);
  return res.rows.length ? res.rows[0].id : null;
}

function claimLine(claim) {
  return `🚩 **${claim.settlementName}** (${claim.kind}) — ${claim.factionName} · ${claim.flagsMet}/${claim.flagsNeeded} flags`;
}

async function handleFlagPlace(interaction, serverId) {
  const guildDbId = await guildDbIdFor(interaction.guild.id);
  if (!guildDbId) return interaction.editReply('❌ No guild record found for this server.');
  const factionMatch = await findFaction(guildDbId, interaction.options.getString('faction'));
  if (factionMatch.error) return interaction.editReply(`❌ ${factionMatch.error}`);
  const faction = factionMatch.faction;

  const settlementQuery = interaction.options.getString('settlement');
  const east = interaction.options.getInteger('east');
  const north = interaction.options.getInteger('north');

  let placeEast, placeNorth, placement;
  if (settlementQuery) {
    const match = findSettlement(settlementQuery);
    if (match.error) return interaction.editReply(`❌ ${match.error}`);
    placeEast = Math.round(match.settlement.position.east);
    placeNorth = Math.round(match.settlement.position.north);
    placement = `at ${match.settlement.names?.en} (settlement center)`;
  } else if (Number.isFinite(east) && Number.isFinite(north)) {
    placeEast = east;
    placeNorth = north;
    placement = `at ${east}, ${north}`;
  } else {
    return interaction.editReply('❌ Provide a settlement name **or** east/north coordinates.');
  }

  const internalId = await internalServerId(serverId);
  if (!internalId) return interaction.editReply('❌ Could not resolve this server internally.');

  const result = await FactionClaimService.placeFlag(dashboardDb, internalId, {
    mapName: MAP_NAME,
    east: placeEast,
    north: placeNorth,
    factionId: faction.id,
    radiusM: 100,
    placedBy: `discord:${interaction.user.username} (${interaction.user.id})`,
  });

  const settlement = result.settlement;
  const lines = [
    `🚩 Placed a ${faction.name} flag ${placement}.`,
    settlement
      ? `Counts for **${settlement.name}** — ${settlement.flags_needed} flags required to claim.`
      : `Outside any settlement — claims only its 100m radius circle.`,
  ];
  if (result.claimEvent) {
    const c = result.claimEvent;
    const who = c.type === 'claim_lost' ? '' : ` by **${faction.name}**`;
    const verb = c.type === 'claimed' ? 'claimed' : c.type === 'claim_taken' ? 'taken' : 'lost';
    lines.push(`⚔️ **${settlement ? settlement.name : c.settlementId}** ${verb}${who} (${c.flagsMet ?? '—'} flags).`);
  }
  if (result.claimEvent) {
    await FactionClaimService.deliverClaimEvents(dashboardDb, internalId, [result.claimEvent]);
  }
  return interaction.editReply(lines.join('\n'));
}

async function handleFlagClear(interaction, serverId) {
  const guildDbId = await guildDbIdFor(interaction.guild.id);
  if (!guildDbId) return interaction.editReply('❌ No guild record found for this server.');
  const factionMatch = await findFaction(guildDbId, interaction.options.getString('faction'));
  if (factionMatch.error) return interaction.editReply(`❌ ${factionMatch.error}`);
  const match = findSettlement(interaction.options.getString('settlement'));
  if (match.error) return interaction.editReply(`❌ ${match.error}`);
  const settlement = match.settlement;

  const internalId = await internalServerId(serverId);
  if (!internalId) return interaction.editReply('❌ Could not resolve this server internally.');

  const { removed, claimEvent } = await FactionClaimService.removeFactionFlagsFromSettlement(
    dashboardDb, internalId, factionMatch.faction.id, settlement.id
  );
  if (claimEvent) await FactionClaimService.deliverClaimEvents(dashboardDb, internalId, [claimEvent]);
  const lines = [removed
    ? `🏳️ Removed ${removed} ${factionMatch.faction.name} flag(s) from **${settlement.names?.en}**.`
    : `No ${factionMatch.faction.name} flags on **${settlement.names?.en}**.`,
  ];
  if (claimEvent) {
    const c = claimEvent;
    const verb = c.type === 'claimed' ? 'claimed' : c.type === 'claim_taken' ? 'taken' : 'lost';
    lines.push(`⚔️ **${settlement.names?.en}** ${verb} (${c.flagsMet ?? '—'} flags).`);
  }
  return interaction.editReply(lines.join('\n'));
}

async function handleList(interaction, serverId) {
  const internalId = await internalServerId(serverId);
  if (!internalId) return interaction.editReply('❌ Could not resolve this server internally.');
  const settlements = await FactionClaimService.getSettlementsForServer(dashboardDb, internalId, MAP_NAME);
  if (!settlements) return interaction.editReply('❌ No server record found.');
  const claimed = settlements.filter(s => s.claim);
  const contested = settlements.filter(s => !s.claim && s.flags.length > 0);
  const state = await FactionClaimService.getWarState(dashboardDb, internalId);
  const looseFlags = (state.flags || []).filter(f => !f.settlement_id);

  const lines = [];
  if (claimed.length) {
    lines.push('**Claimed:**');
    for (const s of claimed.slice(0, 20)) {
      lines.push(claimLine({
        settlementName: s.name, kind: s.kind,
        factionName: s.claim.faction_name,
        flagsMet: s.claim.flags_met, flagsNeeded: s.flags_needed,
      }));
    }
  }
  if (contested.length) {
    lines.push('**Contested (flags placed, no claim):**');
    for (const s of contested.slice(0, 20)) {
      const counts = s.flags.reduce((acc, f) => {
        acc[f.faction_name || `faction ${f.faction_id}`] = (acc[f.faction_name || `faction ${f.faction_id}`] || 0) + 1;
        return acc;
      }, {});
      lines.push(`- **${s.name}** (${s.kind}, needs ${s.flags_needed}): ${Object.entries(counts).map(([n, c]) => `${n} ${c}`).join(', ')}`);
    }
  }
  if (looseFlags.length) {
    lines.push(`**Out-of-settlement flags:** ${looseFlags.length}`);
    for (const f of looseFlags.slice(0, 10)) {
      lines.push(`- 🚩 ${f.faction_name} at ${Math.round(f.east)}, ${Math.round(f.north)} (r ${Math.round(f.radius_m)}m)`);
    }
  }
  if (!lines.length) lines.push('No flags or claims on this server yet.');
  return interaction.editReply(lines.slice(0, 25).join('\n').slice(0, 4000));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('faction-war')
    .setDescription('Faction Wars: settlement flag claims')
    .setDefaultMemberPermissions(8)
    .addSubcommandGroup(group =>
      group
        .setName('flag')
        .setDescription('Place or clear faction flags')
        .addSubcommand(sub =>
          sub
            .setName('place')
            .setDescription('Place a faction flag (settlement name or east/north)')
            .addStringOption(opt => opt.setName('faction').setDescription('Faction tag or name').setRequired(true))
            .addStringOption(opt => opt.setName('settlement').setDescription('Settlement name (flag placed at its center)'))
            .addIntegerOption(opt => opt.setName('east').setDescription('Exact world east (with north)'))
            .addIntegerOption(opt => opt.setName('north').setDescription('Exact world north (with east)'))
            .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
        )
        .addSubcommand(sub =>
          sub
            .setName('clear')
            .setDescription("Remove this faction's flags from a settlement")
            .addStringOption(opt => opt.setName('faction').setDescription('Faction tag or name').setRequired(true))
            .addStringOption(opt => opt.setName('settlement').setDescription('Settlement name').setRequired(true))
            .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('List claims and flags on this server')
        .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const serverId = interaction.authorizedServerId;
    if (!serverId) return interaction.editReply('❌ Select an active server you are authorized to manage.');
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();
    if (group === 'flag') {
      if (sub === 'place') return handleFlagPlace(interaction, serverId);
      if (sub === 'clear') return handleFlagClear(interaction, serverId);
    }
    if (sub === 'list') return handleList(interaction, serverId);
  },
};
