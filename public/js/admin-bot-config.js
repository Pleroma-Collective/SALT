/* global document, window, fetchWithCsrf */
'use strict';

/**
 * Admin Bot Config page — mirrors the bot's setup* slash commands.
 * Sections map 1:1 to storage the bot already reads (see services/botConfigService.js):
 *   guild:  welcome/goodbye/suggestions/antispam (guild_features),
 *           AI ask/digest/onboarding/ops-alerts (guild_ai_settings),
 *           reaction roles (reaction_roles)
 *   server: kill/faction/mod-report feeds (discord_feeds),
 *           server status channels (server_features 'server_status'),
 *           player-count alerts (player_count_alerts),
 *           player-link settings (server_features 'player_linking'),
 *           wipe info (server_wipe_info)
 */

const state = { guildId: null, cfg: null, channels: [] };

const DEFAULT_WELCOME_MESSAGE = '👋 Welcome {user} to **{guild}**!';
const DEFAULT_GOODBYE_MESSAGE = '👋 **{username}** left **{guild}**.';

const $ = sel => document.querySelector(sel);
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function feed(res, fallback) {
  if (res.ok) return res.json();
  return res.json().then(d => {
    throw new Error(d.error || d.message || `Request failed (${res.status})`);
  });
}

function saveSection(section, body) {
  return fetchWithCsrf(`/api/admin/bot-config/${state.guildId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }).then(feed);
}

function wireSaveButton(btn, bodyBuilder, reload) {
  btn.addEventListener('click', async () => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await saveSection(btn, bodyBuilder());
      btn.textContent = '✓ Saved';
      if (typeof reload === 'function') await reload();
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1200);
    } catch (err) {
      btn.textContent = `Error: ${err.message}`;
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 4000);
    }
  });
}

// ── Channel picker: select of the guild's text channels + raw-id fallback ────
function channelControl(current) {
  const wrap = document.createElement('div');
  const sel = document.createElement('select');
  sel.className = 'bg-gray-700 p-2 rounded w-full';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— none —';
  sel.appendChild(none);
  for (const ch of state.channels) {
    const o = document.createElement('option');
    o.value = ch.id;
    o.textContent = `# ${ch.name}`;
    sel.appendChild(o);
  }
  const rawOpt = document.createElement('option');
  rawOpt.value = '__raw__';
  rawOpt.textContent = 'paste channel ID…';
  sel.appendChild(rawOpt);
  const text = document.createElement('input');
  text.type = 'text';
  text.className = 'bg-gray-700 p-2 rounded w-full hidden';
  text.placeholder = 'channel id (snowflake)';
  const isKnown = state.channels.some(c => c.id === String(current || ''));
  sel.value = current ? (isKnown ? String(current) : '__raw__') : '';
  text.value = current && !isKnown ? String(current) : '';
  sel.addEventListener('change', () => text.classList.toggle('hidden', sel.value !== '__raw__'));
  if (sel.value === '__raw__') text.classList.remove('hidden');
  wrap.append(sel, text);
  wrap.getChannelId = () => (sel.value === '__raw__' ? (text.value.trim() || null) : (sel.value || null));
  return wrap;
}

function fieldRow(label, control, extra) {
  const row = document.createElement('div');
  row.className = 'flex items-end gap-3';
  const lab = document.createElement('label');
  lab.className = 'text-sm text-gray-300 w-40 shrink-0 pb-2';
  lab.textContent = label;
  row.append(lab, control);
  if (extra) row.appendChild(extra);
  return row;
}

function sectionCard(title, subtitle, build) {
  const card = document.createElement('div');
  card.className = 'bg-gray-800 p-6 rounded-lg shadow-lg mb-6';
  const head = document.createElement('div');
  head.className = 'mb-4';
  head.innerHTML = `<h2 class="text-xl font-semibold">${title}</h2><p class="text-gray-400 text-sm mt-1">${subtitle}</p>`;
  card.appendChild(head);
  build(card);
  return card;
}

// ── Guild-level sections ─────────────────────────────────────────────────────

function joinLeaveCard(which, defaultMessage) {
  return sectionCard(`${which === 'welcome' ? 'Welcome' : 'Goodbye'} message`,
    `guild_features · ${which} — mirrors /setup-welcome ${which}`,
    (card) => {
      const cur = state.cfg[which];
      const enabled = !!(cur && cur.enabled);
      const channel = channelControl(cur ? cur.config.channel_id : null);
      const msg = document.createElement('input');
      msg.type = 'text';
      msg.className = 'bg-gray-700 p-2 rounded w-full';
      msg.placeholder = 'Template. Placeholders: {user} {username} {guild} {count}';
      msg.value = (cur && cur.config.message) || defaultMessage;
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.id = `${which}-enabled`;
      toggle.checked = enabled;
      card.appendChild(fieldRow('Enabled', toggle));
      card.appendChild(fieldRow('Channel', channel));
      card.appendChild(fieldRow('Template', msg));
      const btn = document.createElement('button');
      btn.className = 'bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-semibold mt-4';
      btn.textContent = 'Save';
      wireSaveButton(btn, () => ({
        [which]: {
          enabled: toggle.checked,
          channelId: toggle.checked ? channel.getChannelId() : null,
          message: msg.value.trim(),
        },
      }), () => loadConfig());
      card.appendChild(btn);
    });
}

function suggestionsCard() {
  return sectionCard('Suggestions channel', 'guild_features · suggestions — mirrors /suggestions setup',
    (card) => {
      const cur = state.cfg.suggestions;
      const channel = channelControl(cur ? cur.config.channel_id : null);
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !!(cur && cur.enabled);
      card.appendChild(fieldRow('Enabled', toggle));
      card.appendChild(fieldRow('Channel', channel));
      const btn = document.createElement('button');
      btn.className = 'bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-semibold mt-4';
      btn.textContent = 'Save';
      wireSaveButton(btn, () => ({
        suggestions: { enabled: toggle.checked, channelId: toggle.checked ? channel.getChannelId() : null },
      }), () => loadConfig());
      card.appendChild(btn);
    });
}

function antispamCard() {
  return sectionCard('Anti-spam', 'guild_features · antispam — mirrors /setup-antispam (30s bot config cache)',
    (card) => {
      const cur = state.cfg.antispam || {};
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !!cur.enabled;
      const num = (label, key, fallback, hint) => {
        const el = document.createElement('input');
        el.type = 'number';
        el.className = 'bg-gray-700 p-2 rounded w-28';
        el.min = '1';
        el.value = cur[key] ?? fallback;
        el.title = hint;
        return el;
      };
      const limit = num('limit', 'limit', 5, 'Messages per burst (3–15)');
      const win = num('windowSeconds', 'windowSeconds', 10, 'Burst window in seconds (5–120)');
      const gap = num('gapSeconds', 'gapSeconds', 3, 'Max gap between messages in seconds (1–10)');
      card.appendChild(fieldRow('Enabled', toggle));
      card.appendChild(fieldRow('Limit (msgs)', limit, document.createElement('span')));
      limit.title = 'Messages per burst (3–15)';
      const winRow = fieldRow('Window (s)', win);
      const winHint = document.createElement('span');
      winHint.className = 'text-xs text-gray-500 pb-2';
      winHint.textContent = '5–120';
      winRow.appendChild(winHint);
      card.appendChild(winRow);
      const gapRow = fieldRow('Gap (s)', gap);
      const gapHint = document.createElement('span');
      gapHint.className = 'text-xs text-gray-500 pb-2';
      gapHint.textContent = '1–10';
      gapRow.appendChild(gapHint);
      card.appendChild(gapRow);
      const btn = document.createElement('button');
      btn.className = 'bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-semibold mt-4';
      btn.textContent = 'Save';
      wireSaveButton(btn, () => ({
        antispam: {
          enabled: toggle.checked,
          limit: Number(limit.value),
          windowSeconds: Number(win.value),
          gapSeconds: Number(gap.value),
        },
      }), () => loadConfig());
      card.appendChild(btn);
    });
}

function aiCard() {
  return sectionCard('Player-facing AI', 'guild_ai_settings — mirrors /setup-ai (ask, digest, onboarding, ops alerts)',
    (card) => {
      const cur = state.cfg.ai || {};
      const row = (label, build) => {
        const r = document.createElement('div');
        r.className = 'flex items-end gap-3 mb-3';
        const lab = document.createElement('label');
        lab.className = 'text-sm text-gray-300 w-40 shrink-0 pb-2';
        lab.textContent = label;
        r.appendChild(lab);
        const box = document.createElement('div');
        box.className = 'flex items-end gap-2 flex-1';
        build(box);
        r.appendChild(box);
        card.appendChild(r);
      };
      const chk = (id, checked) => {
        const el = document.createElement('input');
        el.type = 'checkbox';
        el.id = id;
        el.checked = checked;
        return el;
      };
      const numIn = (value, min, max) => {
        const el = document.createElement('input');
        el.type = 'number';
        el.className = 'bg-gray-700 p-2 rounded w-24';
        el.min = String(min);
        el.max = String(max);
        el.value = value;
        return el;
      };
      const select = (values, value) => {
        const el = document.createElement('select');
        el.className = 'bg-gray-700 p-2 rounded';
        for (const v of values) {
          const o = document.createElement('option');
          o.value = v;
          o.textContent = v;
          el.appendChild(o);
        }
        el.value = values.includes(value) ? value : values[0];
        return el;
      };

      const askOn = chk('ai-ask', !!cur.ask_enabled);
      const askLimit = numIn(cur.ask_daily_limit ?? 20, 1, 200);
      const askRules = channelControl(cur.ask_rules_channel_id);
      row('Ask the server', (box) => { box.append(askOn, askLimit, askRules); });

      const digestOn = chk('ai-digest', !!cur.digest_enabled);
      const digestInterval = select(['daily', 'weekly'], cur.digest_interval || 'daily');
      const digestChannel = channelControl(cur.digest_channel_id);
      row('Digest', (box) => { box.append(digestOn, digestInterval, digestChannel); });

      const onboardingOn = chk('ai-onboarding', !!cur.onboarding_enabled);
      const onboardingChannel = channelControl(cur.onboarding_channel_id);
      row('Onboarding', (box) => { box.append(onboardingOn, onboardingChannel); });

      const opsOn = chk('ai-ops', !!cur.ops_alert_enabled);
      const opsChannel = channelControl(cur.ops_alert_channel_id);
      row('Ops alerts', (box) => { box.append(opsOn, opsChannel); });

      const read = () => ({
        askEnabled: askOn.checked,
        askDailyLimit: Number(askLimit.value) || 20,
        askRulesChannelId: askRules.getChannelId(),
        digestEnabled: digestOn.checked,
        digestInterval: digestInterval.value,
        digestChannelId: digestOn.checked ? digestChannel.getChannelId() : null,
        onboardingEnabled: onboardingOn.checked,
        onboardingChannelId: onboardingOn.checked ? onboardingChannel.getChannelId() : null,
        opsAlertEnabled: opsOn.checked,
        opsAlertChannelId: opsOn.checked ? opsChannel.getChannelId() : null,
      });

      const btn = document.createElement('button');
      btn.className = 'bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-semibold mt-2';
      btn.textContent = 'Save AI settings';
      wireSaveButton(btn, () => ({ ai: read() }), () => loadConfig());
      card.appendChild(btn);

      const off = document.createElement('button');
      off.className = 'bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded font-semibold mt-2 ml-3';
      off.textContent = 'Disable all AI features';
      off.addEventListener('click', async () => {
        if (!confirm('Turn off ask, digest, onboarding and ops alerts for this guild?')) return;
        try {
          await saveSection(off, { ai: { askEnabled: false, digestEnabled: false, onboardingEnabled: false, opsAlertEnabled: false } });
          await loadConfig();
        } catch (err) {
          alert(err.message);
        }
      });
      card.appendChild(off);
    });
}

function reactionsCard() {
  return sectionCard('Reaction roles', 'reaction_roles — mirrors /setup-reactions (30s bot cache). Bind an emoji to a role on a carrier message.',
    (card) => {
      const list = document.createElement('ul');
      list.className = 'space-y-2 mb-4';
      // innerHTML note: every interpolated value below passes through esc() —
      // static markup only, no raw user/API input.
      for (const b of state.cfg.reactions) {
        const li = document.createElement('li');
        li.className = 'flex items-center gap-3 bg-gray-700/50 p-2 rounded';
        li.innerHTML = `<span class="font-mono">${esc(b.emoji)}</span><span class="text-gray-300 flex-1">→ role ${esc(b.role_id)} (channel ${esc(b.channel_id || '?')}, message ${esc(b.message_id)})</span>`;
        const rm = document.createElement('button');
        rm.className = 'bg-red-700 hover:bg-red-600 px-3 py-1 rounded text-sm';
        rm.textContent = 'Remove';
        rm.addEventListener('click', async () => {
          try {
            await saveSection(rm, { reactions: { remove: [{ emoji: b.emoji, roleId: b.role_id }] } });
            await loadConfig();
          } catch (err) {
            alert(err.message);
          }
        });
        li.appendChild(rm);
        list.appendChild(li);
      }
      card.appendChild(list);

      const add = (label, type, placeholder) => {
        const el = document.createElement('input');
        el.type = type;
        el.className = 'bg-gray-700 p-2 rounded w-40';
        el.placeholder = placeholder;
        el.title = label;
        return el;
      };
      const emoji = add('emoji', 'text', 'emoji');
      const roleId = add('roleId', 'text', 'role id');
      const messageId = add('messageId', 'text', 'message id');
      const channelId = add('channelId', 'text', 'channel id (optional)');
      const row = document.createElement('div');
      row.className = 'flex flex-wrap gap-2 items-end';
      row.innerHTML = `<span class="text-sm text-gray-400 pb-2">Add binding:</span>`;
      row.append(emoji, roleId, messageId, channelId);
      card.appendChild(row);

      const btn = document.createElement('button');
      btn.className = 'bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-semibold mt-3';
      btn.textContent = 'Add binding';
      btn.addEventListener('click', async () => {
        try {
          await saveSection(btn, {
            reactions: { add: [{ emoji: emoji.value.trim(), roleId: roleId.value.trim(), messageId: messageId.value.trim(), channelId: channelId.value.trim() || null }] },
          });
          await loadConfig();
        } catch (err) {
          alert(err.message);
        }
      });
      card.appendChild(btn);
      card.insertAdjacentHTML('beforeend', '<p class="text-xs text-gray-500 mt-2">The carrier message is created by the bot (run /setup-reactions add in Discord), then bind it here by its message id.</p>');
    });
}

// ── Per-server sections ──────────────────────────────────────────────────────

function feedsCard(serverId, view) {
  return sectionCard(`Feeds — ${view.name}`, `discord_feeds — mirrors /setup-feeds + /report setup`,
    (card) => {
      const rows = [
        ['killFeed', 'Killfeed'],
        ['factionFeed', 'Faction war feed'],
        ['modReports', 'Mod reports'],
      ];
      for (const [key, label] of rows) {
        const cur = view.feeds[key] || {};
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = !!cur.enabled;
        const channel = channelControl(cur.channelId);
        const rowEl = fieldRow(`${label} — enabled`, toggle);
        const chanRow = fieldRow(`${label} — channel`, channel);
        card.appendChild(rowEl);
        card.appendChild(chanRow);
        const btn = document.createElement('button');
        btn.className = 'bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-semibold mt-2 mb-3';
        btn.textContent = `Save ${label.toLowerCase()}`;
        wireSaveButton(btn, () => ({
          servers: { [serverId]: { [key]: { enabled: toggle.checked, channelId: toggle.checked ? channel.getChannelId() : null } } },
        }), () => loadConfig());
        card.appendChild(btn);
      }
    });
}

function serverStatusCard(serverId, view) {
  return sectionCard(`Server status channels — ${view.name}`, "server_features · server_status — mirrors /setup-status (bot refreshes the embed every 5 min)",
    (card) => {
      const cur = (view.serverStatus && view.serverStatus.config) || {};
      const enabled = !!(view.serverStatus && view.serverStatus.enabled);
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = enabled;
      const cat = channelControl(cur.category_id);
      const txt = channelControl(cur.text_channel_id);
      const players = channelControl(cur.players_vc_id);
      const restart = channelControl(cur.restart_vc_id);
      const pinned = document.createElement('input');
      pinned.type = 'text';
      pinned.className = 'bg-gray-700 p-2 rounded w-48';
      pinned.placeholder = 'pinned message id (optional)';
      pinned.value = cur.pinned_message_id || '';
      card.appendChild(fieldRow('Enabled', toggle));
      card.appendChild(fieldRow('Category', cat));
      card.appendChild(fieldRow('Status text channel', txt));
      card.appendChild(fieldRow('Players voice channel', players));
      card.appendChild(fieldRow('Restart voice channel', restart));
      card.appendChild(fieldRow('Pinned message id', pinned));
      const btn = document.createElement('button');
      btn.className = 'bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-semibold mt-4';
      btn.textContent = 'Save';
      wireSaveButton(btn, () => ({
        servers: {
          [serverId]: {
            serverStatus: {
              enabled: toggle.checked,
              currentConfig: cur,
              categoryId: cat.getChannelId(),
              textChannelId: txt.getChannelId(),
              playersVcId: players.getChannelId(),
              restartVcId: restart.getChannelId(),
              pinnedMessageId: pinned.value.trim() || null,
            },
          },
        },
      }), () => loadConfig());
      card.appendChild(btn);
    });
}

function alertsCard(serverId, view) {
  return sectionCard(`Player count alerts — ${view.name}`, 'player_count_alerts — mirrors /alert-threshold',
    (card) => {
      const list = document.createElement('ul');
      list.className = 'space-y-2 mb-4';
      for (const a of view.alerts) {
        const li = document.createElement('li');
        li.className = 'flex items-center gap-3 bg-gray-700/50 p-2 rounded';
        li.innerHTML = `<span class="font-semibold">#${a.id}</span><span class="text-gray-300 flex-1">${a.threshold}+ players → ${a.mention_type === 'role' ? '@' : '@'}${esc(a.mention_target)} in channel ${esc(a.channel_id)}</span>${a.enabled ? '' : '<span class="text-xs text-yellow-400">disabled</span>'}`;
        const rm = document.createElement('button');
        rm.className = 'bg-red-700 hover:bg-red-600 px-3 py-1 rounded text-sm';
        rm.textContent = 'Remove';
        rm.addEventListener('click', async () => {
          try {
            await saveSection(rm, { servers: { [serverId]: { alerts: { remove: [a.id] } } } });
            await loadConfig();
          } catch (err) {
            alert(err.message);
          }
        });
        li.appendChild(rm);
        list.appendChild(li);
      }
      card.appendChild(list);

      const threshold = document.createElement('input');
      threshold.type = 'number';
      threshold.min = '1';
      threshold.className = 'bg-gray-700 p-2 rounded w-24';
      threshold.placeholder = 'count';
      const channel = channelControl(null);
      const mentionType = document.createElement('select');
      mentionType.className = 'bg-gray-700 p-2 rounded';
      for (const v of ['role', 'user']) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        mentionType.appendChild(o);
      }
      const mentionTarget = document.createElement('input');
      mentionTarget.type = 'text';
      mentionTarget.className = 'bg-gray-700 p-2 rounded w-40';
      mentionTarget.placeholder = 'role/user id';
      const addRow = document.createElement('div');
      addRow.className = 'flex flex-wrap gap-2 items-end';
      addRow.innerHTML = '<span class="text-sm text-gray-400 pb-2">Add alert:</span>';
      addRow.append(threshold, channel, mentionType, mentionTarget);
      card.appendChild(addRow);

      const btn = document.createElement('button');
      btn.className = 'bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-semibold mt-3';
      btn.textContent = 'Add alert';
      btn.addEventListener('click', async () => {
        try {
          await saveSection(btn, {
            servers: {
              [serverId]: {
                alerts: { add: [{ threshold: Number(threshold.value), channelId: channel.getChannelId(), mentionType: mentionType.value, mentionTarget: mentionTarget.value.trim() }] },
              },
            },
          });
          await loadConfig();
        } catch (err) {
          alert(err.message);
        }
      });
      card.appendChild(btn);
    });
}

function linkSettingsCard(serverId, view) {
  return sectionCard(`Player link settings — ${view.name}`, "server_features · player_linking — mirrors /link-settings",
    (card) => {
      const cur = view.linkSettings;
      const mode = document.createElement('select');
      mode.className = 'bg-gray-700 p-2 rounded';
      for (const v of ['admin_approval', 'emote', 'open']) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v.replace('_', ' ');
        mode.appendChild(o);
      }
      mode.value = cur.verificationMode;
      card.appendChild(fieldRow('Verification', mode));

      const groups = [
        ['assignOnJoin', 'Assign when member joins'],
        ['assignOnLink', 'Assign when player links'],
        ['removeOnLink', 'Remove when player links'],
        ['removeOnLeave', 'Remove when member leaves'],
      ];
      const inputs = {};
      for (const [key, label] of groups) {
        const el = document.createElement('input');
        el.type = 'text';
        el.className = 'bg-gray-700 p-2 rounded w-96';
        el.placeholder = 'role ids, comma-separated';
        el.value = (cur.roles[key] || []).join(', ');
        inputs[key] = el;
        card.appendChild(fieldRow(label, el));
      }

      const btn = document.createElement('button');
      btn.className = 'bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-semibold mt-4';
      btn.textContent = 'Save';
      wireSaveButton(btn, () => ({
        servers: {
          [serverId]: {
            linkSettings: {
              verificationMode: mode.value,
              roles: Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.split(',').map(s => s.trim()).filter(Boolean)])),
            },
          },
        },
      }), () => loadConfig());
      card.appendChild(btn);
    });
}

function keepAliveCard(serverId, view) {
  return sectionCard(`Keep Alive — ${view.name}`,
    'server_features · keep_alive — auto-start this server when it crashes (max 3/hour, 15m cooldown); notices go to the ops-alert channel',
    (card) => {
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !!(view.keepAlive && view.keepAlive.enabled);
      card.appendChild(fieldRow('Enabled', toggle));
      const btn = document.createElement('button');
      btn.className = 'bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-semibold mt-4';
      btn.textContent = 'Save';
      wireSaveButton(btn, () => ({
        servers: { [serverId]: { keepAlive: { enabled: toggle.checked } } },
      }), () => loadConfig());
      card.appendChild(btn);
    });
}

function altAutoBanCard(serverId, view) {
  return sectionCard(`Alt auto-ban — ${view.name}`,
    'server_features · alt_autoban — bans the alt side of a pair after 2 enforced RPT alt-account delays (review-dismissed pairs, shared-ownership pairs and exempted gamertags are never touched; daily cap 3/server)',
    (card) => {
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !!(view.altAutoBan && view.altAutoBan.enabled);
      card.appendChild(fieldRow('Enabled', toggle));
      const btn = document.createElement('button');
      btn.className = 'bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-semibold mt-4';
      btn.textContent = 'Save';
      wireSaveButton(btn, () => ({
        servers: { [serverId]: { altAutoBan: { enabled: toggle.checked } } },
      }), () => loadConfig());
      card.appendChild(btn);
    });
}

function killSwitchesCard() {
  return sectionCard('Kill switches (global)',
    'app_settings — halts bot behavior for every guild/server; the alt auto-ban switch stops all auto-bans immediately, anywhere',
    (card) => {
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !!(state.cfg && state.cfg.killSwitches && state.cfg.killSwitches.altAutoBan);
      card.appendChild(fieldRow('Alt auto-ban (halts all servers)', toggle));
      const hint = document.createElement('span');
      hint.className = 'text-xs text-yellow-400';
      hint.textContent = 'When on, no server can auto-ban, even with its own toggle enabled.';
      card.appendChild(hint);
      const btn = document.createElement('button');
      btn.className = 'bg-red-600 hover:bg-red-500 px-4 py-2 rounded font-semibold mt-4';
      btn.textContent = 'Save kill switch';
      wireSaveButton(btn, () => ({
        killSwitches: { altAutoBan: toggle.checked },
      }), () => loadConfig());
      card.appendChild(btn);
    });
}

function wipeCard(serverId, view) {
  return sectionCard(`Wipe info — ${view.name}`, 'server_wipe_info — mirrors /wipe-info',
    (card) => {
      const cur = view.wipe || {};
      const dateIn = (value) => {
        const el = document.createElement('input');
        el.type = 'date';
        el.className = 'bg-gray-700 p-2 rounded';
        el.value = value || '';
        return el;
      };
      const last = dateIn(cur.lastWipeAt);
      const next = dateIn(cur.nextWipeAt);
      const notes = document.createElement('input');
      notes.type = 'text';
      notes.className = 'bg-gray-700 p-2 rounded w-96';
      notes.placeholder = 'notes';
      notes.value = cur.notes || '';
      card.appendChild(fieldRow('Last wipe', last));
      card.appendChild(fieldRow('Next wipe', next));
      card.appendChild(fieldRow('Notes', notes));
      const btn = document.createElement('button');
      btn.className = 'bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-semibold mt-4';
      btn.textContent = 'Save';
      wireSaveButton(btn, () => ({
        servers: { [serverId]: { wipe: { lastWipeAt: last.value || null, nextWipeAt: next.value || null, notes: notes.value.trim() } } },
      }), () => loadConfig());
      card.appendChild(btn);
    });
}

// ── Loading / rendering ──────────────────────────────────────────────────────

async function loadGuildChannels() {
  state.channels = [];
  try {
    const res = await fetch(`/api/discord/guilds/${state.guildId}/channels`);
    const data = await res.json();
    if (data.success && Array.isArray(data.channels)) {
      state.channels = data.channels.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name }));
    }
  } catch {
    // Channel list is best-effort (needs the admin's Discord session);
    // the raw-ID fallback in every picker keeps the page fully usable.
  }
}

function render() {
  const guildSections = $('#guild-sections');
  const serverSections = $('#server-sections');
  guildSections.innerHTML = '';
  serverSections.innerHTML = '';

  guildSections.appendChild(killSwitchesCard());
  guildSections.appendChild(joinLeaveCard('welcome', DEFAULT_WELCOME_MESSAGE));
  guildSections.appendChild(joinLeaveCard('goodbye', DEFAULT_GOODBYE_MESSAGE));
  guildSections.appendChild(suggestionsCard());
  guildSections.appendChild(antispamCard());
  guildSections.appendChild(aiCard());
  guildSections.appendChild(reactionsCard());

  for (const server of state.cfg.servers) {
    const view = state.cfg.serverConfigs[server.serverId];
    serverSections.appendChild(feedsCard(server.serverId, view));
    serverSections.appendChild(serverStatusCard(server.serverId, view));
    serverSections.appendChild(keepAliveCard(server.serverId, view));
    serverSections.appendChild(altAutoBanCard(server.serverId, view));
    serverSections.appendChild(alertsCard(server.serverId, view));
    serverSections.appendChild(linkSettingsCard(server.serverId, view));
    serverSections.appendChild(wipeCard(server.serverId, view));
  }
}

async function loadConfig() {
  const res = await fetch(`/api/admin/bot-config/${state.guildId}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Failed to load bot config');
  state.cfg = data.config;
  $('#empty-state').classList.add('hidden');
  $('#bot-config-container').classList.remove('hidden');
  await loadGuildChannels();
  render();
}

async function loadGuilds() {
  const res = await fetch('/api/admin/guilds?status=approved');
  const data = await res.json();
  const select = $('#guildSelect');
  select.innerHTML = '<option value="">— select a guild —</option>';
  for (const g of (data.guilds || [])) {
    const o = document.createElement('option');
    o.value = g.guild_id;
    o.textContent = g.guildName || g.name || g.guild_id;
    select.appendChild(o);
  }
  if ((data.guilds || []).length === 1) select.value = data.guilds[0].guild_id;
}

$('#guildSelect').addEventListener('change', async (e) => {
  state.guildId = e.target.value;
  state.cfg = null;
  if (!state.guildId) {
    $('#bot-config-container').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    return;
  }
  $('#empty-state').classList.add('hidden');
  $('#bot-config-container').classList.remove('hidden');
  $('#guild-sections').innerHTML = '<p class="text-gray-400">Loading bot config…</p>';
  $('#server-sections').innerHTML = '';
  try {
    await loadConfig();
  } catch (err) {
    $('#guild-sections').innerHTML = `<p class="text-red-400">${esc(err.message)}</p>`;
  }
});

loadGuilds().catch(err => {
  $('#guildSelect').innerHTML = `<option value="">Failed to load guilds: ${esc(err.message)}</option>`;
});
