'use strict';

/**
 * Bot config admin page — services/botConfigService.js
 *
 * Read/write half of the "Bot Config" admin page. Mirrors the bot's
 * setup* slash commands by touching the SAME tables they use — no parallel
 * storage:
 *
 *   guild-level (guild_id = guilds.id):
 *     guild_features   — welcome / goodbye / antispam / suggestions
 *                        (written exactly like bot/utils/guildFeatureSettings.js)
 *     guild_ai_settings— ask / digest / onboarding / ops-alert (setup-ai.js)
 *     reaction_roles   — reaction-role bindings (setup-reactions.js)
 *   server-level (server_id = servers.id):
 *     discord_feeds    — kill_feed / faction_feed (setup-feeds.js) and
 *                        mod_reports (report.js `setup`)
 *     server_features  — 'server_status' (setup-status.js),
 *                        'player_linking' (link-settings.js),
 *                        'keep_alive' (crash auto-restart, read by
 *                        bot/services/serverHealthMonitor.js) and
 *                        'alt_autoban' (enforced-wait auto-ban, read by
 *                        services/altAutoBanService.js at log ingestion)
 *     player_count_alerts — alert-threshold.js
 *     server_wipe_info — wipe-info.js
 *   global (app_settings) — kill switches (alt auto-ban kill switch)
 *
 * The bot picks changes up on its normal read cadence (30s config cache for
 * antispam/reactions, per-event reads elsewhere, 5-minute status cycle).
 */

const { parseLinkSettings } = require('../utils/linkPolicy');

const FEED_TYPES = Object.freeze({
  killFeed: 'kill_feed',
  factionFeed: 'faction_feed',
  modReports: 'mod_reports',
});

const KILLFEED_DEFAULT_SETTINGS = Object.freeze({ showPlayers: true, minDistance: 0, useEmbed: true, embedColor: '#FF0000' });
const FACTION_DEFAULT_SETTINGS = Object.freeze({ useEmbed: true, embedColor: '#8B0000' });

// Same ranges the slash commands enforce (setup-antispam.js / antiSpamService.js).
const ANTISPAM_LIMITS = Object.freeze({ limit: [3, 15], windowSeconds: [5, 120], gapSeconds: [1, 10] });
const ASK_DAILY_LIMIT = Object.freeze([1, 200]);
const DIGEST_INTERVALS = Object.freeze(['daily', 'weekly']);
const VERIFICATION_MODES = Object.freeze(['admin_approval', 'emote', 'open']);
const MENTION_TYPES = Object.freeze(['role', 'user']);
const ID_RE = /^\d{1,20}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    throw httpError(400, 'Dates must be YYYY-MM-DD');
  }
  const ts = Date.parse(value + 'T00:00:00Z');
  if (Number.isNaN(ts)) throw httpError(400, 'Dates must be YYYY-MM-DD');
  return value;
}

// Same normalization as bot/commands/setup-reactions.js.
function normalizeEmoji(input) {
  const raw = String(input || '');
  const m = raw.match(/^<a?:([a-z0-9_]+):\d+>$/i);
  return m ? m[1] : raw;
}

async function resolveGuild(db, discordGuildId) {
  const guild = await db.get(
    'SELECT id, name, discord_guild_id FROM guilds WHERE discord_guild_id = ?',
    [String(discordGuildId)]
  );
  if (!guild) throw httpError(404, 'Guild not found');
  return guild;
}

async function resolveServers(db, guildDbId) {
  const rows = await db.all(
    'SELECT id, name, platform_server_id FROM servers WHERE guild_id = ? ORDER BY id',
    [guildDbId]
  );
  return rows;
}

function parseJsonField(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Load every bot-config surface for one guild.
 * @returns {Promise<object>}
 */
async function loadBotConfig(db, discordGuildId) {
  const guild = await resolveGuild(db, discordGuildId);
  const servers = await resolveServers(db, guild.id);

  const featureRows = await db.all(
    'SELECT feature_name, enabled, config FROM guild_features WHERE guild_id = ?',
    [guild.id]
  );
  const features = {};
  for (const row of featureRows) features[row.feature_name] = row;
  const featureView = (name) => {
    const row = features[name];
    if (!row) return null;
    return {
      enabled: Boolean(row.enabled),
      config: parseJsonField(row.config, {}),
    };
  };

  const antispamRow = featureView('antispam');
  const antispam = antispamRow ? {
    enabled: antispamRow.enabled,
    limit: antispamRow.config.limit ?? null,
    windowSeconds: antispamRow.config.windowMs != null ? Math.round(antispamRow.config.windowMs / 1000) : null,
    gapSeconds: antispamRow.config.gapMs != null ? Math.round(antispamRow.config.gapMs / 1000) : null,
  } : null;

  const aiRow = await db.get(
    `SELECT ask_enabled, ask_daily_limit, ask_rules_channel_id,
            digest_enabled, digest_channel_id, digest_interval,
            onboarding_enabled, onboarding_channel_id,
            ops_alert_enabled, ops_alert_channel_id
       FROM guild_ai_settings WHERE guild_id = ?`,
    [guild.id]
  );

  const reactionRows = await db.all(
    'SELECT channel_id, message_id, emoji, role_id FROM reaction_roles WHERE guild_id = ? ORDER BY emoji',
    [guild.id]
  );

  const serverViews = {};
  for (const server of servers) {
    const feedRows = await db.all(
      "SELECT feed_type, enabled, channel_id, settings FROM discord_feeds WHERE guild_id = ? AND server_id = ? ORDER BY feed_type",
      [String(guild.discord_guild_id), server.id]
    );
    const feeds = {};
    for (const [key] of Object.entries(FEED_TYPES)) feeds[key] = null;
    for (const row of feedRows) {
      const key = Object.keys(FEED_TYPES).find(k => FEED_TYPES[k] === row.feed_type);
      if (!key) continue;
      feeds[key] = {
        enabled: Boolean(row.enabled),
        channelId: row.channel_id || null,
        settings: parseJsonField(row.settings, {}),
      };
    }

    const featureServerRows = await db.all(
      "SELECT feature_name, enabled, config FROM server_features WHERE server_id = ? AND feature_name IN ('server_status', 'player_linking', 'keep_alive', 'alt_autoban')",
      [server.id]
    );
    const serverFeatures = {};
    for (const row of featureServerRows) serverFeatures[row.feature_name] = row;

    const statusRow = serverFeatures.server_status;
    const statusConfig = statusRow ? parseJsonField(statusRow.config, {}) : {};

    const alertRows = await db.all(
      'SELECT id, threshold, channel_id, mention_target, mention_type, enabled FROM player_count_alerts WHERE guild_id = ? AND server_id = ? ORDER BY threshold ASC, id ASC',
      [String(guild.discord_guild_id), server.id]
    );

    const linkRow = serverFeatures.player_linking;
    const linkSettings = parseLinkSettings(linkRow ? (linkRow.enabled ? linkRow.config : null) : null);

    const wipeRow = await db.get(
      'SELECT last_wipe_at, next_wipe_at, notes FROM server_wipe_info WHERE server_id = ?',
      [server.id]
    );

    serverViews[server.id] = {
      name: server.name,
      platformServerId: server.platform_server_id,
      feeds,
      serverStatus: statusRow ? { enabled: Boolean(statusRow.enabled), config: statusConfig } : null,
      keepAlive: { enabled: Boolean(serverFeatures.keep_alive?.enabled) },
      altAutoBan: { enabled: Boolean(serverFeatures.alt_autoban?.enabled) },
      alerts: alertRows,
      linkSettings,
      wipe: wipeRow ? {
        lastWipeAt: wipeRow.last_wipe_at || null,
        nextWipeAt: wipeRow.next_wipe_at || null,
        notes: wipeRow.notes || null,
      } : null,
    };
  }

  const killSwitchRow = await db.get(
    "SELECT value FROM app_settings WHERE key = 'alt_auto_ban_disabled'"
  );

  return {
    guild: { dbId: guild.id, discordGuildId: String(guild.discord_guild_id), name: guild.name },
    servers: servers.map(s => ({ serverId: s.id, name: s.name, platformServerId: s.platform_server_id })),
    killSwitches: { altAutoBan: String(killSwitchRow?.value || '') === 'true' },
    welcome: featureView('welcome'),
    goodbye: featureView('goodbye'),
    suggestions: featureView('suggestions'),
    antispam,
    ai: aiRow || null,
    reactions: reactionRows,
    serverConfigs: serverViews,
  };
}

// ─── Writers ─────────────────────────────────────────────────────────────────

async function writeGuildFeature(db, discordGuildId, featureName, config, enabled) {
  await db.run(
    `INSERT INTO guild_features (guild_id, feature_name, enabled, config, updated_at)
     SELECT g.id, ?, ?, ?, NOW()
     FROM guilds g
     WHERE g.discord_guild_id = ?
     ON CONFLICT (guild_id, feature_name)
     DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = NOW()`,
    [featureName, enabled ? 1 : 0, JSON.stringify(config || {}), String(discordGuildId)]
  );
}

async function applyChannelFeature(db, discordGuildId, featureName, section) {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw httpError(400, `${featureName} must be an object`);
  }
  const enabled = Boolean(section.enabled);
  const channelId = section.channelId === undefined ? null : (section.channelId === null || section.channelId === '' ? null : String(section.channelId));
  if (channelId !== null && !isId(channelId)) throw httpError(400, `${featureName}: invalid channel id`);
  if (enabled && !channelId) throw httpError(400, `${featureName}: a channel is required to enable it`);
  return { featureName, enabled, channelId };
}

async function applyWelcomeOrGoodbye(db, discordGuildId, featureName, section) {
  const { enabled, channelId } = await applyChannelFeature(db, discordGuildId, featureName, section);
  const message = section.message === undefined ? null : (section.message === null || section.message === '' ? null : String(section.message));
  if (message !== null && message.length > 500) throw httpError(400, `${featureName}: message must be 500 characters or fewer`);
  const config = channelId !== null ? { channel_id: channelId, ...(message !== null ? { message } : {}) } : {};
  await writeGuildFeature(db, discordGuildId, featureName, config, enabled);
  return `${featureName} → ${enabled ? 'on' : 'off'}`;
}

async function applyAntispam(db, discordGuildId, section, current) {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw httpError(400, 'antispam must be an object');
  }
  const enabled = Boolean(section.enabled);
  const currentConfig = (current && current.config) || {};
  const merged = { ...currentConfig };
  for (const [field, key] of [['limit', 'limit'], ['windowSeconds', 'windowMs'], ['gapSeconds', 'gapMs']]) {
    if (section[field] === undefined) continue;
    const [min, max] = field === 'limit' ? ANTISPAM_LIMITS.limit : field === 'windowSeconds' ? ANTISPAM_LIMITS.windowSeconds : ANTISPAM_LIMITS.gapSeconds;
    const n = Number(section[field]);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw httpError(400, `antispam: ${field} must be an integer between ${min} and ${max}`);
    }
    merged[key] = field === 'limit' ? n : n * 1000;
  }
  await writeGuildFeature(db, discordGuildId, 'antispam', merged, enabled);
  return `antispam → ${enabled ? 'on' : 'off'}`;
}

async function applyAi(db, discordGuildId, section) {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw httpError(400, 'ai must be an object');
  }
  const patch = {};
  if (section.askEnabled !== undefined) patch.ask_enabled = Boolean(section.askEnabled);
  if (section.askDailyLimit !== undefined) {
    const n = Number(section.askDailyLimit);
    if (!Number.isInteger(n) || n < ASK_DAILY_LIMIT[0] || n > ASK_DAILY_LIMIT[1]) {
      throw httpError(400, `ai: askDailyLimit must be between ${ASK_DAILY_LIMIT[0]} and ${ASK_DAILY_LIMIT[1]}`);
    }
    patch.ask_daily_limit = n;
  }
  const channelFields = [
    ['askRulesChannelId', 'ask_rules_channel_id', null],
    ['digestChannelId', 'digest_channel_id', 'digestEnabled'],
    ['onboardingChannelId', 'onboarding_channel_id', 'onboardingEnabled'],
    ['opsAlertChannelId', 'ops_alert_channel_id', 'opsAlertEnabled'],
  ];
  for (const [field, column, enableKey] of channelFields) {
    if (section[field] === undefined) continue;
    const value = section[field] === null || section[field] === '' ? null : String(section[field]);
    if (value !== null && !isId(value)) throw httpError(400, `ai: invalid channel id for ${field}`);
    if (enableKey && section[enableKey] === true && !value) {
      throw httpError(400, `ai: a channel is required to enable ${field.replace('ChannelId', '').replace(/^./, c => c.toLowerCase())}`);
    }
    patch[column] = value;
  }
  if (section.digestEnabled !== undefined) patch.digest_enabled = Boolean(section.digestEnabled);
  if (section.onboardingEnabled !== undefined) patch.onboarding_enabled = Boolean(section.onboardingEnabled);
  if (section.opsAlertEnabled !== undefined) patch.ops_alert_enabled = Boolean(section.opsAlertEnabled);
  if (section.digestInterval !== undefined) {
    if (!DIGEST_INTERVALS.includes(section.digestInterval)) {
      throw httpError(400, 'ai: digestInterval must be daily or weekly');
    }
    patch.digest_interval = section.digestInterval;
  }
  if (Object.keys(patch).length === 0) throw httpError(400, 'ai: no valid fields to update');

  const guild = await resolveGuild(db, discordGuildId);
  const existing = await db.get('SELECT guild_id FROM guild_ai_settings WHERE guild_id = ?', [guild.id]);
  if (!existing) {
    await db.run(
      'INSERT INTO guild_ai_settings (guild_id, updated_at) VALUES (?, NOW()) ON CONFLICT (guild_id) DO NOTHING',
      [guild.id]
    );
  }
  const sets = [];
  const params = [guild.id];
  for (const [column, value] of Object.entries(patch)) {
    params.push(value);
    sets.push(`${column} = ?`);
  }
  await db.run(
    `UPDATE guild_ai_settings SET ${sets.join(', ')}, updated_at = NOW() WHERE guild_id = ?`,
    [...params.slice(1), guild.id]
  );
  return `ai → ${Object.keys(patch).join(', ')}`;
}

async function applyReactions(db, discordGuildId, section) {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw httpError(400, 'reactions must be an object');
  }
  const guild = await resolveGuild(db, discordGuildId);
  const applied = [];
  if (Array.isArray(section.remove)) {
    for (const entry of section.remove) {
      if (typeof entry !== 'object' || entry === null) throw httpError(400, 'reactions.remove entries must be objects');
      const emoji = normalizeEmoji(entry.emoji);
      const roleId = entry.roleId ? String(entry.roleId) : '';
      if (!emoji || !isId(roleId)) throw httpError(400, 'reactions.remove needs emoji and roleId');
      await db.run(
        'DELETE FROM reaction_roles WHERE guild_id = ? AND emoji = ? AND role_id = ?',
        [guild.id, emoji, roleId]
      );
      applied.push(`removed ${emoji} → role ${roleId}`);
    }
  }
  if (Array.isArray(section.add)) {
    for (const entry of section.add) {
      if (typeof entry !== 'object' || entry === null) throw httpError(400, 'reactions.add entries must be objects');
      const emoji = normalizeEmoji(entry.emoji);
      const roleId = entry.roleId ? String(entry.roleId) : '';
      const messageId = entry.messageId ? String(entry.messageId) : '';
      const channelId = entry.channelId ? String(entry.channelId) : '';
      if (!emoji || !isId(roleId) || !isId(messageId) || (channelId && !isId(channelId))) {
        throw httpError(400, 'reactions.add needs emoji, roleId, messageId (and channelId when given)');
      }
      await db.run(
        `INSERT INTO reaction_roles (guild_id, channel_id, message_id, emoji, role_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, message_id, emoji, role_id) DO NOTHING`,
        [guild.id, channelId || null, messageId, emoji, roleId, null]
      );
      applied.push(`added ${emoji} → role ${roleId}`);
    }
  }
  if (!applied.length) throw httpError(400, 'reactions: nothing to do (use add or remove)');
  return `reactions → ${applied.join('; ')}`;
}

async function applyFeed(db, guild, server, feedKey, section) {
  const feedType = FEED_TYPES[feedKey];
  if (!feedType) throw httpError(400, `unknown feed type: ${feedKey}`);
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw httpError(400, `${feedKey} must be an object`);
  }
  const enabled = Boolean(section.enabled);
  const channelId = section.channelId === undefined ? null : (section.channelId === null || section.channelId === '' ? null : String(section.channelId));
  if (channelId !== null && !isId(channelId)) throw httpError(400, `${feedKey}: invalid channel id`);
  if (enabled && !channelId) throw httpError(400, `${feedKey}: a channel is required to enable it`);

  if (!enabled) {
    await db.run(
      'UPDATE discord_feeds SET enabled = 0, updated_at = NOW() WHERE guild_id = ? AND server_id = ? AND feed_type = ?',
      [String(guild.discord_guild_id), server.id, feedType]
    );
    return `${feedType} → off`;
  }

  // Same upsert + default settings the /setup-feeds command writes.
  const existing = await db.get(
    'SELECT settings FROM discord_feeds WHERE guild_id = ? AND server_id = ? AND feed_type = ?',
    [String(guild.discord_guild_id), server.id, feedType]
  );
  const defaults = feedType === 'kill_feed' ? KILLFEED_DEFAULT_SETTINGS : feedType === 'faction_feed' ? FACTION_DEFAULT_SETTINGS : null;
  const settings = existing?.settings ? parseJsonField(existing.settings, {}) : (defaults ? { ...defaults } : null);
  await db.run(
    `INSERT INTO discord_feeds (guild_id, server_id, feed_type, enabled, channel_id, settings, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, NOW())
     ON CONFLICT (server_id, feed_type) DO UPDATE SET
       guild_id = EXCLUDED.guild_id, enabled = 1, channel_id = EXCLUDED.channel_id,
       settings = COALESCE(EXCLUDED.settings, discord_feeds.settings), updated_at = NOW()`,
    [String(guild.discord_guild_id), server.id, feedType, channelId, settings ? JSON.stringify(settings) : null]
  );
  return `${feedType} → on in ${channelId}`;
}

async function applyServerStatus(db, guild, server, section) {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw httpError(400, 'serverStatus must be an object');
  }
  const enabled = Boolean(section.enabled);
  const current = (section.currentConfig && typeof section.currentConfig === 'object') ? section.currentConfig : {};
  const config = {
    category_id: section.categoryId ?? current.category_id ?? null,
    text_channel_id: section.textChannelId ?? current.text_channel_id ?? null,
    players_vc_id: section.playersVcId ?? current.players_vc_id ?? null,
    restart_vc_id: section.restartVcId ?? current.restart_vc_id ?? null,
    pinned_message_id: section.pinnedMessageId ?? current.pinned_message_id ?? null,
  };
  for (const [key, value] of Object.entries(config)) {
    if (value === null || value === '') continue;
    if (!isId(value)) throw httpError(400, `serverStatus: invalid channel id for ${key}`);
  }
  if (enabled && !config.text_channel_id) {
    throw httpError(400, 'serverStatus: a text channel is required to enable it');
  }
  await db.run(
    `INSERT INTO server_features (server_id, feature_name, enabled, config, updated_at)
     VALUES (?, 'server_status', ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (server_id, feature_name) DO UPDATE SET
       enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP`,
    [server.id, enabled ? 1 : 0, JSON.stringify(config)]
  );
  return `server_status → ${enabled ? 'on' : 'off'}`;
}

async function applyKeepAlive(db, guild, server, section) {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw httpError(400, 'keepAlive must be an object');
  }
  const enabled = Boolean(section.enabled);
  await db.run(
    `INSERT INTO server_features (server_id, feature_name, enabled, config, updated_at)
     VALUES (?, 'keep_alive', ?, NULL, CURRENT_TIMESTAMP)
     ON CONFLICT (server_id, feature_name) DO UPDATE SET
       enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP`,
    [server.id, enabled ? 1 : 0]
  );
  return `keep_alive → ${enabled ? 'on' : 'off'}`;
}

async function applyAltAutoBan(db, guild, server, section) {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw httpError(400, 'altAutoBan must be an object');
  }
  const enabled = Boolean(section.enabled);
  await db.run(
    `INSERT INTO server_features (server_id, feature_name, enabled, config, updated_at)
     VALUES (?, 'alt_autoban', ?, NULL, CURRENT_TIMESTAMP)
     ON CONFLICT (server_id, feature_name) DO UPDATE SET
       enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP`,
    [server.id, enabled ? 1 : 0]
  );
  return `alt_autoban → ${enabled ? 'on' : 'off'}`;
}

async function applyKillSwitches(db, guild, section) {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw httpError(400, 'killSwitches must be an object');
  }
  if (section.altAutoBan !== undefined && typeof section.altAutoBan !== 'boolean') {
    throw httpError(400, 'killSwitches.altAutoBan must be a boolean');
  }
  if (section.altAutoBan !== undefined) {
    await db.run(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('alt_auto_ban_disabled', ?, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [section.altAutoBan ? 'true' : 'false']
    );
  }
  return `killSwitches.altAutoBan → ${section.altAutoBan === undefined ? 'unchanged' : section.altAutoBan ? 'ON' : 'off'}`;
}

async function applyAlerts(db, guild, server, section) {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw httpError(400, 'alerts must be an object');
  }
  const applied = [];
  if (Array.isArray(section.remove)) {
    for (const id of section.remove) {
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'alerts.remove: invalid alert id');
      await db.run(
        'DELETE FROM player_count_alerts WHERE id = ? AND guild_id = ? AND server_id = ? RETURNING id',
        [n, String(guild.discord_guild_id), server.id]
      );
      applied.push(`removed alert #${n}`);
    }
  }
  if (Array.isArray(section.add)) {
    for (const entry of section.add) {
      if (typeof entry !== 'object' || entry === null) throw httpError(400, 'alerts.add entries must be objects');
      const threshold = Number(entry.threshold);
      if (!Number.isInteger(threshold) || threshold < 1) throw httpError(400, 'alerts: threshold must be an integer >= 1');
      const channelId = entry.channelId ? String(entry.channelId) : '';
      const mentionTarget = entry.mentionTarget ? String(entry.mentionTarget) : '';
      if (!isId(channelId) || !isId(mentionTarget)) throw httpError(400, 'alerts: channelId and mentionTarget must be valid ids');
      const mentionType = entry.mentionType;
      if (!MENTION_TYPES.includes(mentionType)) throw httpError(400, "alerts: mentionType must be 'role' or 'user'");
      await db.run(
        `INSERT INTO player_count_alerts
           (guild_id, server_id, threshold, channel_id, mention_target, mention_type, created_by_discord_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [String(guild.discord_guild_id), server.id, threshold, channelId, mentionTarget, mentionType, null]
      );
      applied.push(`added ${threshold}+ alert`);
    }
  }
  if (!applied.length) throw httpError(400, 'alerts: nothing to do (use add or remove)');
  return `alerts → ${applied.join('; ')}`;
}

async function applyLinkSettings(db, guild, server, section) {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw httpError(400, 'linkSettings must be an object');
  }
  if (section.verificationMode !== undefined && !VERIFICATION_MODES.includes(section.verificationMode)) {
    throw httpError(400, 'linkSettings: invalid verificationMode');
  }
  const current = section.currentSettings && typeof section.currentSettings === 'object' ? section.currentSettings : null;
  const normalized = parseLinkSettings(current ? JSON.parse(JSON.stringify(current)) : {});
  if (section.verificationMode) normalized.verificationMode = section.verificationMode;
  if (section.roles && typeof section.roles === 'object') {
    for (const key of ['assignOnJoin', 'assignOnLink', 'removeOnLink', 'removeOnLeave']) {
      if (section.roles[key] === undefined) continue;
      if (!Array.isArray(section.roles[key])) throw httpError(400, `linkSettings.roles.${key} must be an array of role ids`);
      const ids = [...new Set(section.roles[key].map(String).filter(Boolean))];
      if (ids.some(id => !isId(id))) throw httpError(400, `linkSettings.roles.${key}: invalid role id`);
      normalized.roles[key] = ids;
    }
  }
  await db.run(
    `INSERT INTO server_features (server_id, feature_name, enabled, config, updated_at)
     VALUES (?, 'player_linking', 1, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (server_id, feature_name) DO UPDATE SET
       enabled = 1, config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP`,
    [server.id, JSON.stringify(normalized)]
  );
  return 'player_linking → saved';
}

async function applyWipe(db, guild, server, section) {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw httpError(400, 'wipe must be an object');
  }
  const current = (await db.get(
    'SELECT last_wipe_at, next_wipe_at, notes FROM server_wipe_info WHERE server_id = ?',
    [server.id]
  )) || {};
  const lastWipeAt = section.lastWipeAt === undefined ? (current.last_wipe_at || null) : parseDate(section.lastWipeAt);
  const nextWipeAt = section.nextWipeAt === undefined ? (current.next_wipe_at || null) : parseDate(section.nextWipeAt);
  const notes = section.notes === undefined ? (current.notes || null) : (section.notes === null || section.notes === '' ? null : String(section.notes));
  if (notes !== null && notes.length > 1000) throw httpError(400, 'wipe: notes must be 1000 characters or fewer');
  await db.run(
    `INSERT INTO server_wipe_info
       (server_id, last_wipe_at, next_wipe_at, notes, updated_at, updated_by_discord_id, updated_by_discord_name)
     VALUES (?, ?, ?, ?, NOW(), ?, ?)
     ON CONFLICT (server_id) DO UPDATE SET
       last_wipe_at = EXCLUDED.last_wipe_at, next_wipe_at = EXCLUDED.next_wipe_at,
       notes = EXCLUDED.notes, updated_at = NOW(),
       updated_by_discord_id = EXCLUDED.updated_by_discord_id,
       updated_by_discord_name = EXCLUDED.updated_by_discord_name`,
    [server.id, lastWipeAt, nextWipeAt, notes, null, 'dashboard-admin']
  );
  return 'wipe info → saved';
}

/**
 * Apply a partial bot-config patch for one guild. Only sections present in
 * `patch` are written; unknown/empty sections are rejected, not ignored.
 * @returns {Promise<string[]>} human-readable list of applied changes
 */
async function applyBotConfig(db, discordGuildId, patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw httpError(400, 'request body must be a JSON object of sections');
  }
  const known = new Set(['welcome', 'goodbye', 'suggestions', 'antispam', 'ai', 'reactions', 'servers', 'killSwitches']);
  const present = Object.keys(patch).filter(k => patch[k] !== undefined);
  for (const key of present) {
    if (!known.has(key)) throw httpError(400, `unknown section: ${key}`);
  }
  if (!present.length) throw httpError(400, 'no sections to update');

  const guild = await resolveGuild(db, discordGuildId);
  const applied = [];
  const serversById = new Map();
  if (present.includes('servers')) {
    for (const s of await resolveServers(db, guild.id)) serversById.set(String(s.id), s);
  }

  if (patch.welcome !== undefined) applied.push(await applyWelcomeOrGoodbye(db, discordGuildId, 'welcome', patch.welcome));
  if (patch.goodbye !== undefined) applied.push(await applyWelcomeOrGoodbye(db, discordGuildId, 'goodbye', patch.goodbye));

  if (patch.suggestions !== undefined) applied.push(await applyChannelFeatureWrite(db, discordGuildId, 'suggestions', patch.suggestions));
  if (patch.antispam !== undefined) {
    const current = (await db.get(
      "SELECT enabled, config FROM guild_features WHERE guild_id = ? AND feature_name = 'antispam'",
      [guild.id]
    ));
    applied.push(await applyAntispam(db, discordGuildId, patch.antispam, current ? { config: parseJsonField(current.config, {}) } : null));
  }
  if (patch.ai !== undefined) applied.push(await applyAi(db, discordGuildId, patch.ai));
  if (patch.reactions !== undefined) applied.push(await applyReactions(db, discordGuildId, patch.reactions));
  if (patch.killSwitches !== undefined) applied.push(await applyKillSwitches(db, guild, patch.killSwitches));

  if (present.includes('servers')) {
    const serverSections = patch.servers;
    if (typeof serverSections !== 'object' || serverSections === null || Array.isArray(serverSections)) {
      throw httpError(400, 'servers must be an object keyed by server id');
    }
    for (const [serverId, serverSection] of Object.entries(serverSections)) {
      const server = serversById.get(String(serverId));
      if (!server) throw httpError(400, `server ${serverId} is not in this guild`);
      if (typeof serverSection !== 'object' || serverSection === null || Array.isArray(serverSection)) {
        throw httpError(400, `servers.${serverId} must be an object`);
      }
      for (const feedKey of Object.keys(FEED_TYPES)) {
        if (serverSection[feedKey] !== undefined) {
          applied.push(await applyFeed(db, guild, server, feedKey, serverSection[feedKey]));
        }
      }
      if (serverSection.serverStatus !== undefined) applied.push(await applyServerStatus(db, guild, server, serverSection.serverStatus));
      if (serverSection.keepAlive !== undefined) applied.push(await applyKeepAlive(db, guild, server, serverSection.keepAlive));
      if (serverSection.altAutoBan !== undefined) applied.push(await applyAltAutoBan(db, guild, server, serverSection.altAutoBan));
      if (serverSection.alerts !== undefined) applied.push(await applyAlerts(db, guild, server, serverSection.alerts));
      if (serverSection.linkSettings !== undefined) applied.push(await applyLinkSettings(db, guild, server, serverSection.linkSettings));
      if (serverSection.wipe !== undefined) applied.push(await applyWipe(db, guild, server, serverSection.wipe));
    }
  }

  return applied;
}

// writeGuildFeature wrapper for the channel-only features (goodbye/suggestions)
async function applyChannelFeatureWrite(db, discordGuildId, featureName, section) {
  const { enabled, channelId } = await applyChannelFeature(db, discordGuildId, featureName, section);
  await writeGuildFeature(db, discordGuildId, featureName, channelId !== null ? { channel_id: channelId } : {}, enabled);
  return `${featureName} → ${enabled ? 'on' : 'off'}`;
}

module.exports = {
  loadBotConfig,
  applyBotConfig,
  FEED_TYPES,
  DIGEST_INTERVALS,
  VERIFICATION_MODES,
};
