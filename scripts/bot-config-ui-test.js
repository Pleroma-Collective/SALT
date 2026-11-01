'use strict';

/* Bot config admin page UI contract (public/js/admin-bot-config.js).
 * House vm-harness pattern (see admin-onboarding-ui-test.js): the browser
 * script runs in a Node vm context with a fake DOM + stubbed fetch, then we
 * drive the guild picker and a Save button and assert the PUT payload is
 * exactly the partial patch the bot config API expects.
 * Run: node scripts/bot-config-ui-test.js */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GUILD_ID = '123456789012345678';

const SEED_CONFIG = {
  guild: { dbId: 7, discordGuildId: GUILD_ID, name: 'Test Guild' },
  servers: [{ serverId: 11, name: 'Chernarus', platformServerId: '4436' }],
  welcome: { enabled: true, config: { channel_id: '555', message: 'hi {user}' } },
  goodbye: null,
  suggestions: null,
  antispam: { enabled: true, limit: 5, windowSeconds: 10, gapSeconds: 3 },
  ai: null,
  reactions: [{ channel_id: '222', message_id: '333', emoji: '🎮', role_id: '444' }],
  serverConfigs: {
    11: {
      name: 'Chernarus',
      platformServerId: '4436',
      feeds: {
        killFeed: { enabled: true, channelId: '555', settings: { useEmbed: true } },
        factionFeed: { enabled: false, channelId: '666', settings: {} },
        modReports: null,
      },
      serverStatus: { enabled: true, config: { category_id: '1', text_channel_id: '2', players_vc_id: '3', restart_vc_id: '4', pinned_message_id: '5' } },
      alerts: [{ id: 42, threshold: 40, channel_id: '555', mention_target: '888', mention_type: 'role', enabled: true }],
      linkSettings: { verificationMode: 'emote', roles: { assignOnJoin: ['900'], assignOnLink: [], removeOnLink: [], removeOnLeave: [] } },
      wipe: { lastWipeAt: '2026-09-01', nextWipeAt: '2026-12-01', notes: 'holiday wipe' },
    },
  },
};

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    listeners: {},
    style: {},
    className: '',
    _innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    id: '',
    type: '',
    min: '',
    max: '',
    title: '',
    placeholder: '',
    disabled: false,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { el.children.push(c); return c; },
    append(...cs) { cs.forEach(c => el.children.push(c)); },
    remove() {},
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    removeEventListener() {},
    querySelectorAll() { return []; },
    setAttribute() {},
    insertAdjacentHTML(pos, html) { el._innerHTML += html; },
    // fire returns listener results so async handlers can be awaited
    fire(type, ev) {
      return (el.listeners[type] || []).map(fn => fn(ev || {}));
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML; },
    set(v) { el._innerHTML = v; el.children.length = 0; },
  });
  return el;
}

// ── harness ──────────────────────────────────────────────────────────────────

const ids = {};
for (const id of ['guildSelect', 'guild-sections', 'server-sections', 'empty-state', 'bot-config-container']) {
  ids[`#${id}`] = makeEl('div');
}

const getLog = [];
const putLog = [];

function fetchStub(url) {
  getLog.push(url);
  if (url.startsWith('/api/admin/guilds')) {
    return { ok: true, json: async () => ({ guilds: [{ guild_id: GUILD_ID, guildName: 'Test Guild' }] }) };
  }
  if (url === `/api/discord/guilds/${GUILD_ID}/channels`) {
    return { ok: true, json: async () => ({ success: true, channels: [{ id: '555', name: 'killfeed', type: 0 }, { id: '666', name: 'vc-players', type: 2 }] }) };
  }
  if (url === `/api/admin/bot-config/${GUILD_ID}`) {
    return { ok: true, json: async () => ({ ok: true, config: SEED_CONFIG }) };
  }
  throw new Error(`unexpected GET ${url}`);
}

function fetchWithCsrfStub(url, options) {
  putLog.push({ url, options });
  return { ok: true, json: async () => ({ ok: true, applied: ['saved'] }) };
}

const context = vm.createContext({
  document: {
    querySelector: sel => ids[sel] || null,
    createElement: tag => makeEl(tag),
    addEventListener() {},
  },
  window: {},
  console,
  alert: () => {},
  confirm: () => true,
  fetch: fetchStub,
  fetchWithCsrf: fetchWithCsrfStub,
  setTimeout,
  clearTimeout,
  encodeURIComponent,
  JSON,
});

vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin-bot-config.js'), 'utf8'), context, { filename: 'admin-bot-config.js' });

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const c of root.children) {
    const found = findById(c, id);
    if (found) return found;
  }
  return null;
}

function findButton(root, label) {
  if (root.tagName === 'BUTTON' && root.textContent === label) return root;
  for (const c of root.children) {
    const found = findButton(c, label);
    if (found) return found;
  }
  return null;
}

async function main() {
  // guild list loaded into the selector
  await flush();
  assert.ok(ids['#guildSelect'].children.some(o => o.value === GUILD_ID), 'guild option present');

  // pick the guild → config loads and renders all sections
  await ids['#guildSelect'].fire('change', { target: { value: GUILD_ID } });
  await flush();

  const guildCards = ids['#guild-sections'].children;
  const serverCards = ids['#server-sections'].children;
  assert.strictEqual(guildCards.length, 7, `guild cards (got ${guildCards.length})`);
  assert.strictEqual(serverCards.length, 7, `server cards (got ${serverCards.length})`);
  assert.ok(ids['#empty-state'].classList.contains('hidden'));
  assert.ok(!ids['#bot-config-container'].classList.contains('hidden'));

  // welcome card reflects stored state: enabled + channel 555 from the picker
  const welcomeToggle = findById(ids['#guild-sections'], 'welcome-enabled');
  assert.strictEqual(welcomeToggle.checked, true);

  // ── save welcome: PUT must be the exact partial patch ──────────────────────
  await flush();
  putLog.length = 0;
  const welcomeCard = guildCards[1];
  const welcomeBtn = findButton(welcomeCard, 'Save');
  assert.ok(welcomeBtn, 'welcome save button');
  await welcomeBtn.fire('click');
  await flush();
  assert.strictEqual(putLog.length, 1);
  assert.strictEqual(putLog[0].url, `/api/admin/bot-config/${GUILD_ID}`);
  assert.strictEqual(putLog[0].options.method, 'PUT');
  assert.deepStrictEqual(JSON.parse(putLog[0].options.body), {
    welcome: { enabled: true, channelId: '555', message: 'hi {user}' },
  });

  // ── save killfeed (per-server section) ─────────────────────────────────────
  putLog.length = 0;
  const feedsCard = serverCards[0];
  const killBtn = findButton(feedsCard, 'Save killfeed');
  assert.ok(killBtn, 'save killfeed button');
  await killBtn.fire('click');
  await flush();
  assert.strictEqual(putLog.length, 1);
  assert.deepStrictEqual(JSON.parse(putLog[0].options.body), {
    servers: { 11: { killFeed: { enabled: true, channelId: '555' } } },
  });

  // ── keep-alive (per-server section, off by default) ────────────────────────
  putLog.length = 0;
  const keepAliveCard = serverCards[2];
  const keepAliveToggle = keepAliveCard.children[1].children[1];
  assert.strictEqual(keepAliveToggle.checked, false, 'keep-alive defaults to off');
  const keepAliveBtn = findButton(keepAliveCard, 'Save');
  assert.ok(keepAliveBtn, 'keep-alive save button');
  keepAliveToggle.checked = true;
  await keepAliveBtn.fire('click');
  await flush();
  assert.strictEqual(putLog.length, 1);
  assert.deepStrictEqual(JSON.parse(putLog[0].options.body), {
    servers: { 11: { keepAlive: { enabled: true } } },
  });

  // ── AI disable-all with confirm ────────────────────────────────────────────
  putLog.length = 0;
  const aiCard = guildCards[5];
  const disableBtn = findButton(aiCard, 'Disable all AI features');
  assert.ok(disableBtn, 'AI disable button');
  await disableBtn.fire('click');
  await flush();
  assert.strictEqual(putLog.length, 1);
  assert.deepStrictEqual(JSON.parse(putLog[0].options.body), {
    ai: { askEnabled: false, digestEnabled: false, onboardingEnabled: false, opsAlertEnabled: false },
  });

  // channel picker exposes the text channels (type 0 only) + raw-id fallback
  const pickerSelects = [];
  (function collect(el) {
    if (el.tagName === 'SELECT') pickerSelects.push(el);
    el.children.forEach(collect);
  })(ids['#guild-sections']);
  assert.ok(pickerSelects.length > 0, 'channel pickers rendered');
  const first = pickerSelects[0];
  const names = first.children.map(o => o.textContent);
  assert.ok(names.includes('# killfeed'), 'text channel listed');
  assert.ok(!names.includes('vc-players'), 'voice channel excluded');
  assert.ok(names.includes('paste channel ID…'), 'raw-id fallback option');

  console.log('✅ bot-config UI contract: render + save payloads match the API');
}

main().catch(err => {
  console.error('❌ bot-config-ui-test failed:', err);
  process.exit(1);
});
