/*
 * bot/commands/server-control.js
 *
 * Admin-only command to start, stop, or restart the DayZ server via Nitrado.
 * Actions run through the durable provider mutation journal (the same
 * service as the dashboard Server Control Panel), so every action is
 * snapshotted before the provider call and journaled in provider_mutations.
 */

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const pool = require('../db');
const db = require('../utils/dashboardDbAdapter');
const { controlServerLifecycle } = require('../../services/serverLifecycleMutationService');

/**
 * Resolve the dashboard user row for this Discord user (create on first use,
 * matching the upsert used by the other bot commands), so the mutation
 * journal can attribute the action to a canonical actor.
 */
async function resolveActorUserId(discordUser) {
  const result = await pool.query(
    `INSERT INTO users (discord_id, username, avatar)
     VALUES ($1, $2, $3)
     ON CONFLICT (discord_id) DO UPDATE SET
       username = EXCLUDED.username,
       avatar = EXCLUDED.avatar
     RETURNING id`,
    [String(discordUser.id), discordUser.username ?? null, discordUser.avatar ?? null]
  );
  return result.rows[0]?.id ?? null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('server-control')
    .setDescription('Start, stop, or restart the DayZ game server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
      opt.setName('action')
        .setDescription('What to do with the server')
        .setRequired(true)
        .addChoices(
          { name: '🔄 Restart', value: 'restart' },
          { name: '▶️ Start',   value: 'start'   },
          { name: '⏹️ Stop',    value: 'stop'    }
        )
    )
    .addStringOption(opt => opt
      .setName('server')
      .setDescription('Nitrado service ID (required when this guild has multiple servers)')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const action = interaction.options.getString('action', true);
    if (!['restart', 'start', 'stop'].includes(action)) {
      return interaction.editReply(`❌ Unsupported action: ${action}`);
    }
    const serverId = interaction.authorizedServerId;
    if (!serverId) {
      return interaction.editReply('❌ Select an active server you are authorized to manage.');
    }

    let actorUserId;
    try {
      actorUserId = await resolveActorUserId(interaction.user);
    } catch (err) {
      console.error('server-control actor resolution failed:', err.message);
      return interaction.editReply('❌ Could not resolve your dashboard identity; try again shortly.');
    }
    if (!actorUserId) {
      return interaction.editReply('❌ Could not resolve your dashboard identity; try again shortly.');
    }

    try {
      const result = await controlServerLifecycle({
        db,
        internalServerId: serverId,
        actor: { id: actorUserId },
        action,
      });
      return interaction.editReply(
        `✅ ${result.message} (journal operation #${result.operationId}). Allow 1–3 minutes to take effect.`
      );
    } catch (error) {
      console.error('server-control lifecycle mutation failed:', error.code || error.message, error.stack);
      if (error.code === 'PROVIDER_RECOVERY_PENDING') {
        return interaction.editReply(
          `❌ A provider operation for this server needs recovery first (${error.message}).`
        );
      }
      if (error.code === 'LIFECYCLE_PRECONDITION' || error.code === 'LIFECYCLE_SUSPENDED') {
        return interaction.editReply(`❌ ${error.message}`);
      }
      if (error.code === 'SHOP_BUSY') {
        return interaction.editReply('❌ Another operation is already running on this server. Try again shortly.');
      }
      return interaction.editReply(`❌ ${error.message || 'Server control failed.'}`);
    }
  }
};
