'use strict';

/* Bot config admin page (services/botConfigService.js).
 * The admin page must read/write the SAME tables the bot's setup* slash
 * commands use — this test proves the read + write paths against an
 * in-memory fake db (house fakeDb pattern):
 *   read  — loadBotConfig assembles every surface (guild features, AI,
 *           reaction roles, per-server feeds/status/alerts/link/wipe)
 *   write — applyBotConfig mirrors each command's storage semantics:
 *           guild_features upsert, discord_feeds upsert+disable,
 *           guild_ai_settings patch, reaction_roles add/remove,
 *           player_count_alerts scoped by (guild, server),
 *           server_features 'player_linking'/'server_status',
 *           server_wipe_info upsert
 *   guard — per-server sections reject servers from another guild;
 *           out-of-range thresholds are rejected, not clamped
 * Run: node scripts/bot-config-test.js */

const assert = require('assert');
const B = require('../services/botConfigService');

const GUILD = { id: 7, name: 'Test Guild', discord_guild_id: '123456789012345678' };
const OTHER_GUILD = { id: 8, name: 'Other', discord_guild_id: '999999999999999999' };
const SERVER = { id: 11, name: 'Chernarus', platform_server_id: '4436', guild_id: 7 };
const FOREIGN_SERVER = { id: 12, name: 'Foreign', platform_server_id: '9999', guild_id: 8 };

/** Fake db over the bot-config tables (house fakeDb pattern). */
function fakeDb(seed = {}) {
  const tables = {
    guilds: seed.guilds || [],
    servers: seed.servers || [],
    guild_features: (seed.guild_features || []).map(r => ({ ...r })),
    guild_ai_settings: (seed.guild_ai_settings || []).map(r => ({ ...r })),
    reaction_roles: (seed.reaction_roles || []).map(r => ({ ...r })),
    discord_feeds: (seed.discord_feeds || []).map(r => ({ ...r })),
    server_features: (seed.server_features || []).map(r => ({ ...r })),
    player_count_alerts: (seed.player_count_alerts || []).map(r => ({ ...r })),
    server_wipe_info: (seed.server_wipe_info || []).map(r => ({ ...r })),
  };
  const db = {
    runs: [],
    nextAlertId: 1000,
    // row arrays exposed for assertions (house fakeDb pattern)
    __guild_features_rows: tables.guild_features,
    __discord_feeds_rows: tables.discord_feeds,
    __server_features_rows: tables.server_features,
    __server_wipe_rows: tables.server_wipe_info,
    __reaction_rows: tables.reaction_roles,
    __ai_rows: tables.guild_ai_settings,
    __alert_rows: tables.player_count_alerts,

    async get(sql, params = []) {
      if (/FROM guilds WHERE discord_guild_id/i.test(sql)) {
        return tables.guilds.find(g => String(g.discord_guild_id) === String(params[0])) || null;
      }
      if (/FROM guild_ai_settings/i.test(sql)) {
        return tables.guild_ai_settings.find(r => r.guild_id === Number(params[0])) || null;
      }
      if (/FROM discord_feeds/i.test(sql)) {
        return tables.discord_feeds.find(r => String(r.guild_id) === String(params[0]) && r.server_id === Number(params[1]) && r.feed_type === params[2]) || null;
      }
      if (/FROM guild_features/i.test(sql)) {
        // two query shapes: (guild_id, feature_name) params, or guild_id + SQL literal
        const name = sql.match(/feature_name = '([a-z_]+)'/i);
        const featureName = name ? name[1] : params[1];
        return tables.guild_features.find(r => r.guild_id === Number(params[0]) && r.feature_name === featureName) || null;
      }
      if (/FROM server_wipe_info/i.test(sql)) {
        return tables.server_wipe_info.find(r => r.server_id === Number(params[0])) || null;
      }
      return null;
    },

    async all(sql, params = []) {
      if (/FROM servers WHERE guild_id/i.test(sql)) return tables.servers.filter(s => s.guild_id === Number(params[0]));
      if (/FROM guild_features WHERE guild_id/i.test(sql)) return tables.guild_features.filter(r => r.guild_id === Number(params[0]));
      if (/FROM reaction_roles WHERE guild_id/i.test(sql)) return tables.reaction_roles
        .filter(r => r.guild_id === Number(params[0]))
        .map(r => ({ channel_id: r.channel_id, message_id: r.message_id, emoji: r.emoji, role_id: r.role_id }));
      if (/FROM discord_feeds WHERE guild_id/i.test(sql)) {
        return tables.discord_feeds.filter(r => String(r.guild_id) === String(params[0]) && r.server_id === Number(params[1]));
      }
      if (/FROM server_features WHERE server_id/i.test(sql)) {
        const names = [...sql.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
        return tables.server_features.filter(r => r.server_id === Number(params[0]) && names.includes(r.feature_name));
      }
      if (/FROM player_count_alerts/i.test(sql)) {
        return tables.player_count_alerts.filter(r => String(r.guild_id) === String(params[0]) && r.server_id === Number(params[1]));
      }
      return [];
    },

    async run(sql, params = []) {
      db.runs.push({ sql, params });
      if (/INSERT INTO guild_features/i.test(sql)) {
        // params: [featureName, enabled, configJson, discordGuildId]
        const guild = tables.guilds.find(g => String(g.discord_guild_id) === String(params[3]));
        if (!guild) return { changes: 0 };
        const row = tables.guild_features.find(r => r.guild_id === guild.id && r.feature_name === params[0]);
        if (row) {
          row.enabled = params[1];
          row.config = params[2];
        } else {
          tables.guild_features.push({ guild_id: guild.id, feature_name: params[0], enabled: params[1], config: params[2] });
        }
        return { changes: 1 };
      }
      if (/UPDATE discord_feeds SET enabled = 0/i.test(sql)) {
        const row = tables.discord_feeds.find(r => String(r.guild_id) === String(params[0]) && r.server_id === Number(params[1]) && r.feed_type === params[2]);
        if (row) row.enabled = 0;
        return { changes: row ? 1 : 0 };
      }
      if (/INSERT INTO discord_feeds/i.test(sql)) {
        // params: [guildId, serverId, feedType, channelId, settingsJson]
        const row = tables.discord_feeds.find(r => r.server_id === Number(params[1]) && r.feed_type === params[2]);
        if (row) {
          row.guild_id = params[0];
          row.enabled = 1;
          row.channel_id = params[3];
          if (params[4] !== null) row.settings = params[4];
        } else {
          tables.discord_feeds.push({ guild_id: params[0], server_id: Number(params[1]), feed_type: params[2], enabled: 1, channel_id: params[3], settings: params[4] });
        }
        return { changes: 1 };
      }
      if (/INSERT INTO guild_ai_settings/i.test(sql)) {
        tables.guild_ai_settings.push({
          guild_id: Number(params[0]),
          ask_enabled: false, ask_daily_limit: 20, ask_rules_channel_id: null,
          digest_enabled: false, digest_channel_id: null, digest_interval: 'daily',
          onboarding_enabled: false, onboarding_channel_id: null,
          ops_alert_enabled: false, ops_alert_channel_id: null,
        });
        return { changes: 1 };
      }
      if (/UPDATE guild_ai_settings SET/i.test(sql)) {
        // params: [patchValues…, guildId]; SET placeholders consumed in order
        const guildId = params[params.length - 1];
        const row = tables.guild_ai_settings.find(r => r.guild_id === Number(guildId));
        if (!row) return { changes: 0 };
        let i = 0;
        for (const m of sql.matchAll(/(\w+) = \?/g)) {
          row[m[1]] = params[i];
          i += 1;
        }
        return { changes: 1 };
      }
      if (/INSERT INTO reaction_roles/i.test(sql)) {
        // params: [guildId, channelId, messageId, emoji, roleId, createdBy]
        tables.reaction_roles.push({
          guild_id: Number(params[0]), channel_id: params[1], message_id: params[2],
          emoji: params[3], role_id: params[4], created_by: params[5],
        });
        return { changes: 1 };
      }
      if (/DELETE FROM reaction_roles/i.test(sql)) {
        for (let i = tables.reaction_roles.length - 1; i >= 0; i--) {
          const r = tables.reaction_roles[i];
          if (r.guild_id === Number(params[0]) && r.emoji === params[1] && r.role_id === params[2]) {
            tables.reaction_roles.splice(i, 1);
          }
        }
        return { changes: 1 };
      }
      if (/INSERT INTO server_features/i.test(sql)) {
        const featureName = /player_linking/.test(sql) ? 'player_linking' : 'server_status';
        const row = tables.server_features.find(r => r.server_id === Number(params[0]) && r.feature_name === featureName);
        if (featureName === 'player_linking') {
          // enabled is a literal 1 in the SQL; params are [serverId, configJson]
          if (row) { row.enabled = 1; row.config = params[1]; }
          else tables.server_features.push({ server_id: Number(params[0]), feature_name: featureName, enabled: 1, config: params[1] });
        } else {
          // params: [serverId, enabled, configJson]
          if (row) { row.enabled = params[1]; row.config = params[2]; }
          else tables.server_features.push({ server_id: Number(params[0]), feature_name: featureName, enabled: params[1], config: params[2] });
        }
        return { changes: 1 };
      }
      if (/INSERT INTO player_count_alerts/i.test(sql)) {
        // params: [guildId, serverId, threshold, channelId, mentionTarget, mentionType, createdBy]
        const id = db.nextAlertId++;
        tables.player_count_alerts.push({
          id, guild_id: params[0], server_id: Number(params[1]), threshold: Number(params[2]),
          channel_id: params[3], mention_target: params[4], mention_type: params[5],
          enabled: true, created_by_discord_id: params[6],
        });
        return { changes: 1, rows: [{ id }] };
      }
      if (/DELETE FROM player_count_alerts/i.test(sql)) {
        let removed = 0;
        for (let i = tables.player_count_alerts.length - 1; i >= 0; i--) {
          const r = tables.player_count_alerts[i];
          if (r.id === Number(params[0]) && String(r.guild_id) === String(params[1]) && r.server_id === Number(params[2])) {
            tables.player_count_alerts.splice(i, 1);
            removed++;
          }
        }
        return { changes: removed, rows: removed ? [{ id: Number(params[0]) }] : [] };
      }
      if (/INSERT INTO server_wipe_info/i.test(sql)) {
        // params: [serverId, lastWipeAt, nextWipeAt, notes, byId, byName]
        const row = tables.server_wipe_info.find(r => r.server_id === Number(params[0]));
        if (row) {
          row.last_wipe_at = params[1];
          row.next_wipe_at = params[2];
          row.notes = params[3];
        } else {
          tables.server_wipe_info.push({ server_id: Number(params[0]), last_wipe_at: params[1], next_wipe_at: params[2], notes: params[3] });
        }
        return { changes: 1 };
      }
      throw new Error(`fakeDb: unhandled run SQL: ${sql.slice(0, 80)}`);
    },
  };
  return db;
}

function seed() {
  return {
    guilds: [GUILD, OTHER_GUILD],
    servers: [SERVER, FOREIGN_SERVER],
    guild_features: [
      { guild_id: 7, feature_name: 'welcome', enabled: 1, config: JSON.stringify({ channel_id: '111', message: 'hi {user}' }) },
      { guild_id: 7, feature_name: 'antispam', enabled: 0, config: JSON.stringify({ limit: 4, windowMs: 20000, gapMs: 2000 }) },
    ],
    guild_ai_settings: [{
      guild_id: 7, ask_enabled: true, ask_daily_limit: 33, ask_rules_channel_id: '777',
      digest_enabled: false, digest_channel_id: null, digest_interval: 'daily',
      onboarding_enabled: false, onboarding_channel_id: null,
      ops_alert_enabled: false, ops_alert_channel_id: null,
    }],
    reaction_roles: [{ guild_id: 7, channel_id: '222', message_id: '333', emoji: '🎮', role_id: '444' }],
    discord_feeds: [
      { guild_id: '123456789012345678', server_id: 11, feed_type: 'kill_feed', enabled: 1, channel_id: '555', settings: JSON.stringify({ useEmbed: true }) },
      { guild_id: '123456789012345678', server_id: 11, feed_type: 'faction_feed', enabled: 0, channel_id: '666', settings: JSON.stringify({ useEmbed: true, embedColor: '#8B0000' }) },
    ],
    server_features: [
      { server_id: 11, feature_name: 'server_status', enabled: 1, config: JSON.stringify({ category_id: '1', text_channel_id: '2', players_vc_id: '3', restart_vc_id: '4', pinned_message_id: '5' }) },
      { server_id: 11, feature_name: 'player_linking', enabled: 1, config: JSON.stringify({ verificationMode: 'emote', roles: { assignOnJoin: ['900'] } }) },
    ],
    player_count_alerts: [{ id: 42, guild_id: '123456789012345678', server_id: 11, threshold: 40, channel_id: '555', mention_target: '888', mention_type: 'role', enabled: true }],
    server_wipe_info: [{ server_id: 11, last_wipe_at: '2026-09-01', next_wipe_at: '2026-12-01', notes: 'holiday wipe' }],
  };
}

async function testLoadPath() {
  const db = fakeDb(seed());
  const cfg = await B.loadBotConfig(db, GUILD.discord_guild_id);

  assert.strictEqual(cfg.guild.dbId, 7);
  assert.strictEqual(cfg.servers.length, 1);
  assert.strictEqual(cfg.servers[0].serverId, 11);

  // guild features
  assert.deepStrictEqual(cfg.welcome, { enabled: true, config: { channel_id: '111', message: 'hi {user}' } });
  assert.strictEqual(cfg.goodbye, null);
  assert.strictEqual(cfg.suggestions, null);
  assert.deepStrictEqual(cfg.antispam, { enabled: false, limit: 4, windowSeconds: 20, gapSeconds: 2 });

  // AI settings
  assert.strictEqual(cfg.ai.ask_enabled, true);
  assert.strictEqual(cfg.ai.ask_daily_limit, 33);
  assert.strictEqual(cfg.ai.ask_rules_channel_id, '777');

  // reaction roles
  assert.deepStrictEqual(cfg.reactions, [{ channel_id: '222', message_id: '333', emoji: '🎮', role_id: '444' }]);

  // per-server surfaces
  const sv = cfg.serverConfigs[11];
  assert.strictEqual(sv.feeds.killFeed.enabled, true);
  assert.strictEqual(sv.feeds.killFeed.channelId, '555');
  assert.deepStrictEqual(sv.feeds.killFeed.settings, { useEmbed: true });
  assert.strictEqual(sv.feeds.factionFeed.enabled, false);
  assert.strictEqual(sv.feeds.modReports, null);
  assert.strictEqual(sv.serverStatus.enabled, true);
  assert.strictEqual(sv.serverStatus.config.text_channel_id, '2');
  assert.strictEqual(sv.alerts.length, 1);
  assert.strictEqual(sv.alerts[0].id, 42);
  assert.deepStrictEqual(sv.linkSettings.verificationMode, 'emote');
  assert.deepStrictEqual(sv.linkSettings.roles.assignOnJoin, ['900']);
  assert.strictEqual(sv.linkSettings.roles.assignOnLink.length, 0);
  assert.deepStrictEqual(sv.wipe, { lastWipeAt: '2026-09-01', nextWipeAt: '2026-12-01', notes: 'holiday wipe' });
}

async function testUnknownGuild() {
  const db = fakeDb(seed());
  await assert.rejects(B.loadBotConfig(db, '111222333444555666'), /Guild not found/);
}

async function testWelcomeGoodbyeWrites() {
  const db = fakeDb(seed());
  const applied = await B.applyBotConfig(db, GUILD.discord_guild_id, {
    welcome: { enabled: true, channelId: '111', message: 'yo {username}' },
    goodbye: { enabled: true, channelId: '222' },
  });
  assert.deepStrictEqual(applied, ['welcome → on', 'goodbye → on']);
  const welcome = db && JSON.parse(seedRows(db).find(r => r.feature_name === 'welcome').config);
  assert.strictEqual(welcome.channel_id, '111');
  assert.strictEqual(welcome.message, 'yo {username}');
  const goodbye = seedRows(db).find(r => r.feature_name === 'goodbye');
  assert.strictEqual(goodbye.enabled, 1);
  assert.deepStrictEqual(JSON.parse(goodbye.config), { channel_id: '222' });

  // disable writes enabled=0 with empty config (mirrors /setup-welcome disable)
  await B.applyBotConfig(db, GUILD.discord_guild_id, { welcome: { enabled: false, channelId: null } });
  const off = seedRows(db).find(r => r.feature_name === 'welcome');
  assert.strictEqual(off.enabled, 0);

  // enabling without a channel is rejected
  await assert.rejects(
    B.applyBotConfig(db, GUILD.discord_guild_id, { welcome: { enabled: true, channelId: null } }),
    /a channel is required/
  );
  // invalid channel id rejected (no write)
  await assert.rejects(
    B.applyBotConfig(db, GUILD.discord_guild_id, { welcome: { enabled: true, channelId: 'abc' } }),
    /invalid channel id/
  );
}

function seedRows(db) {
  // fakeDb keeps tables private; expose via a marker query
  return db.__guild_features_rows;
}

// ── per-server sections ──────────────────────────────────────────────────────

async function testFeedsWrites() {
  const db = fakeDb(seed());
  await B.applyBotConfig(db, GUILD.discord_guild_id, {
    servers: { 11: { killFeed: { enabled: true, channelId: '999' } } },
  });
  const kill = feedRow(db, 'kill_feed');
  assert.strictEqual(kill.enabled, 1);
  assert.strictEqual(kill.channel_id, '999');
  // existing settings are preserved (same as the command's upsert)
  assert.deepStrictEqual(JSON.parse(kill.settings), { useEmbed: true });

  await B.applyBotConfig(db, GUILD.discord_guild_id, {
    servers: { 11: { killFeed: { enabled: false, channelId: null } } },
  });
  assert.strictEqual(feedRow(db, 'kill_feed').enabled, 0);

  // enabling faction feed from scratch writes the command's default settings
  await B.applyBotConfig(db, GUILD.discord_guild_id, {
    servers: { 11: { factionFeed: { enabled: true, channelId: '777' } } },
  });
  const faction = feedRow(db, 'faction_feed');
  assert.strictEqual(faction.channel_id, '777');
  assert.deepStrictEqual(JSON.parse(faction.settings), { useEmbed: true, embedColor: '#8B0000' });

  // mod_reports (mirrors /report setup) — channel only, no settings
  await B.applyBotConfig(db, GUILD.discord_guild_id, {
    servers: { 11: { modReports: { enabled: true, channelId: '888' } } },
  });
  const reports = feedRow(db, 'mod_reports');
  assert.strictEqual(reports.channel_id, '888');
  assert.strictEqual(reports.settings, null);

  await assert.rejects(
    B.applyBotConfig(db, GUILD.discord_guild_id, { servers: { 11: { killFeed: { enabled: true, channelId: null } } } }),
    /a channel is required/
  );
}

function feedRow(db, type) {
  return db.__discord_feeds_rows.find(r => r.feed_type === type);
}

async function testServerStatusAndWipe() {
  const db = fakeDb(seed());
  await B.applyBotConfig(db, GUILD.discord_guild_id, {
    servers: { 11: {
      serverStatus: {
        enabled: true,
        currentConfig: { category_id: '1', text_channel_id: '2', players_vc_id: '3', restart_vc_id: '4', pinned_message_id: '5' },
        textChannelId: '22',
      },
      wipe: { lastWipeAt: '2026-11-11', nextWipeAt: null, notes: 'winter' },
    } },
  });
  const status = serverFeatureRow(db, 'server_status');
  assert.strictEqual(status.enabled, 1);
  const statusCfg = JSON.parse(status.config);
  assert.strictEqual(statusCfg.text_channel_id, '22');
  assert.strictEqual(statusCfg.category_id, '1'); // untouched values kept
  assert.strictEqual(statusCfg.pinned_message_id, '5');

  const wipe = db.__server_wipe_rows.find(r => r.server_id === 11);
  assert.strictEqual(wipe.last_wipe_at, '2026-11-11');
  assert.strictEqual(wipe.next_wipe_at, null); // cleared, mirrors /wipe-info clear next
  assert.strictEqual(wipe.notes, 'winter');

  await assert.rejects(
    B.applyBotConfig(db, GUILD.discord_guild_id, { servers: { 11: { wipe: { lastWipeAt: '2026-13-99' } } } }),
    /YYYY-MM-DD/
  );
  await assert.rejects(
    B.applyBotConfig(db, GUILD.discord_guild_id, { servers: { 11: { serverStatus: { enabled: true, currentConfig: {} } } } }),
    /a text channel is required/
  );
}

function serverFeatureRow(db, name) {
  return db.__server_features_rows.find(r => r.feature_name === name);
}

async function testAlertsScopedByGuildAndServer() {
  const db = fakeDb(seed());
  await B.applyBotConfig(db, GUILD.discord_guild_id, {
    servers: { 11: { alerts: { add: [{ threshold: 30, channelId: '555', mentionTarget: '888', mentionType: 'role' }] } } },
  });
  const added = db.__alert_rows.filter(r => r.threshold === 30);
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0].guild_id, GUILD.discord_guild_id);
  assert.strictEqual(added[0].server_id, 11);

  await B.applyBotConfig(db, GUILD.discord_guild_id, {
    servers: { 11: { alerts: { remove: [42] } } },
  });
  assert.strictEqual(db.__alert_rows.find(r => r.id === 42), undefined);

  // a server that belongs to another guild is rejected (trust boundary)
  await assert.rejects(
    B.applyBotConfig(db, GUILD.discord_guild_id, { servers: { 12: { killFeed: { enabled: true, channelId: '555' } } } }),
    /not in this guild/
  );
  await assert.rejects(
    B.applyBotConfig(db, GUILD.discord_guild_id, { servers: { 11: { alerts: { add: [{ threshold: 0, channelId: '555', mentionTarget: '888', mentionType: 'role' }] } } } }),
    /threshold/
  );
  await assert.rejects(
    B.applyBotConfig(db, GUILD.discord_guild_id, { servers: { 11: { alerts: { add: [{ threshold: 10, channelId: '555', mentionTarget: '888', mentionType: 'both' }] } } } }),
    /mentionType/
  );
}

async function testLinkSettings() {
  const db = fakeDb(seed());
  await B.applyBotConfig(db, GUILD.discord_guild_id, {
    servers: { 11: { linkSettings: { verificationMode: 'open', roles: { assignOnLink: ['501', '501', '502', ''] } } } },
  });
  const row = serverFeatureRow(db, 'player_linking');
  assert.strictEqual(row.enabled, 1);
  const cfg = JSON.parse(row.config);
  assert.strictEqual(cfg.verificationMode, 'open');
  assert.deepStrictEqual(cfg.roles.assignOnLink, ['501', '502']); // deduped, blanks dropped
  // patch is a full-state write (like the command): groups omitted from the
  // patch are reset to their defaults — the page always sends all four
  assert.deepStrictEqual(cfg.roles.assignOnJoin, []);

  await assert.rejects(
    B.applyBotConfig(db, GUILD.discord_guild_id, { servers: { 11: { linkSettings: { verificationMode: 'emote2' } } } }),
    /invalid verificationMode/
  );
  await assert.rejects(
    B.applyBotConfig(db, GUILD.discord_guild_id, { servers: { 11: { linkSettings: { roles: { assignOnJoin: ['nope'] } } } } }),
    /invalid role id/
  );
}

async function testAi() {
  const db = fakeDb(seed());
  // enabling digest without a channel is allowed — the bot skips digests until
  // a channel is set (same as the command, which never required one either)
  await B.applyBotConfig(db, GUILD.discord_guild_id, { ai: { digestEnabled: true } });
  assert.strictEqual(db.__ai_rows.find(r => r.guild_id === 7).digest_enabled, true);

  await B.applyBotConfig(db, GUILD.discord_guild_id, {
    ai: { digestEnabled: true, digestChannelId: '129', digestInterval: 'weekly', askDailyLimit: 77 },
  });
  const row = db.__ai_rows.find(r => r.guild_id === 7);
  assert.strictEqual(row.digest_enabled, true);
  assert.strictEqual(row.digest_channel_id, '129');
  assert.strictEqual(row.digest_interval, 'weekly');
  assert.strictEqual(row.ask_daily_limit, 77);
  assert.strictEqual(row.ask_enabled, true); // untouched field kept

  await assert.rejects(B.applyBotConfig(db, GUILD.discord_guild_id, { ai: { askDailyLimit: 999 } }), /askDailyLimit/);
  await assert.rejects(B.applyBotConfig(db, GUILD.discord_guild_id, { ai: { digestInterval: 'monthly' } }), /digestInterval/);
  await assert.rejects(B.applyBotConfig(db, GUILD.discord_guild_id, { ai: { digestChannelId: 'abc' } }), /invalid channel id/);
  await assert.rejects(B.applyBotConfig(db, GUILD.discord_guild_id, { ai: {} }), /no valid fields/);

  // guild without a row gets one created, then patched
  const db2 = fakeDb(seed());
  await B.applyBotConfig(db2, OTHER_GUILD.discord_guild_id, { ai: { opsAlertEnabled: true, opsAlertChannelId: '555' } });
  const created = db2.__ai_rows.filter(r => r.guild_id === OTHER_GUILD.id);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].ops_alert_enabled, true);
}

async function testAntispam() {
  const db = fakeDb(seed());
  await assert.rejects(
    B.applyBotConfig(db, GUILD.discord_guild_id, { antispam: { enabled: true, limit: 99 } }),
    /between 3 and 15/
  );
  // partial update merges with stored config (command semantics: omitted values keep current)
  await B.applyBotConfig(db, GUILD.discord_guild_id, { antispam: { enabled: true, windowSeconds: 60 } });
  const row = seedRows(db).find(r => r.feature_name === 'antispam');
  assert.strictEqual(row.enabled, 1);
  const cfg = JSON.parse(row.config);
  assert.strictEqual(cfg.limit, 4); // kept
  assert.strictEqual(cfg.windowMs, 60000);
  assert.strictEqual(cfg.gapMs, 2000); // kept
}

async function testReactions() {
  const db = fakeDb(seed());
  // the command normalizes <a:name:id> wrappers down to the name
  await B.applyBotConfig(db, GUILD.discord_guild_id, {
    reactions: {
      add: [{ emoji: '<a:Spooky:12345>', roleId: '600', messageId: '601', channelId: '602' }],
    },
  });
  const rows = db.__reaction_rows.filter(r => r.emoji === 'Spooky');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].role_id, '600');
  assert.strictEqual(rows[0].message_id, '601');
  assert.strictEqual(rows[0].channel_id, '602');

  await B.applyBotConfig(db, GUILD.discord_guild_id, {
    reactions: { remove: [{ emoji: 'Spooky', roleId: '600' }] },
  });
  assert.strictEqual(db.__reaction_rows.filter(r => r.emoji === 'Spooky').length, 0);
  // the original binding survives a targeted removal
  assert.strictEqual(db.__reaction_rows.filter(r => r.emoji === '🎮').length, 1);

  await assert.rejects(
    B.applyBotConfig(db, GUILD.discord_guild_id, { reactions: { add: [{ emoji: 'x', roleId: 'nope', messageId: '1' }] } }),
    /roleId/
  );
  await assert.rejects(B.applyBotConfig(db, GUILD.discord_guild_id, { reactions: {} }), /nothing to do/);
}

async function testPatchGuards() {
  const db = fakeDb(seed());
  await assert.rejects(B.applyBotConfig(db, GUILD.discord_guild_id, { bogus: {} }), /unknown section/);
  await assert.rejects(B.applyBotConfig(db, GUILD.discord_guild_id, {}), /no sections/);
  await assert.rejects(B.applyBotConfig(db, GUILD.discord_guild_id, 'nope'), /JSON object/);
}

async function main() {
  await testLoadPath();
  console.log('✅ load path assembles every surface');
  await testUnknownGuild();
  console.log('✅ unknown guild → 404');
  await testWelcomeGoodbyeWrites();
  console.log('✅ welcome/goodbye write + validation');
  await testFeedsWrites();
  console.log('✅ feeds enable/disable/default-settings + mod_reports');
  await testServerStatusAndWipe();
  console.log('✅ server status + wipe info');
  await testAlertsScopedByGuildAndServer();
  console.log('✅ player-count alerts scoped by (guild, server)');
  await testLinkSettings();
  console.log('✅ player-link settings normalization');
  await testAi();
  console.log('✅ AI settings patch + row bootstrap');
  await testAntispam();
  console.log('✅ antispam merge + range validation');
  await testReactions();
  console.log('✅ reaction-role add/remove');
  await testPatchGuards();
  console.log('✅ patch guards (unknown section / empty / bad shape)');
  console.log('\nAll bot-config tests passed.');
}

main().catch(err => {
  console.error('❌ bot-config-test failed:', err);
  process.exit(1);
});
