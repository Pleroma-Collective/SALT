/* global document, window */
'use strict';

/*
 * Command palette — Ctrl/Cmd+K global page navigation (QOL card t_d37bee95).
 *
 * Fully client-side: a static page index with no server round-trip. Access
 * flags come from data attributes stamped by utils/renderWithCsrf.js
 * (applyPageChromes): data-cmdk-auth (session) and data-cmdk-admin — the
 * palette lists only pages the current user is allowed to open (admin-tier
 * pages for admins, auth-tier pages for signed-in users, public for everyone).
 *
 * Keyboard: Ctrl/Cmd+K open/close, Arrow up/down to move, Enter to navigate,
 * Esc to close. Opens from any page; the app-shell topbar carries a visible
 * trigger (utils/appShell.js topbarHtml).
 */
(function () {
  'use strict';

  /* ── Static index: label, path, section, tier ──────────────────────────
   * tier: 'public' = anonymous, 'auth' = signed in, 'admin' = platform admin.
   * Mirrors the middleware on each route in src/app/registerRoutes.js. */
  var PAGES = [
    /* Public */
    { label: 'Home (Splash)', path: '/', section: 'Public', tier: 'public' },
    { label: 'Loadout Browser', path: '/loadouts', section: 'Public', tier: 'public' },
    { label: 'Item Catalog', path: '/items', section: 'Public', tier: 'public' },
    /* Player */
    { label: 'Player Portal', path: '/player', section: 'Player', tier: 'auth' },
    { label: 'Player Shop', path: '/shop', section: 'Player', tier: 'auth' },
    { label: 'Player Map', path: '/player-map', section: 'Player', tier: 'auth' },
    /* Dashboard (owner/operator) */
    { label: 'Dashboard', path: '/dashboard', section: 'Dashboard', tier: 'auth' },
    { label: 'Economy', path: '/dashboard/economy', section: 'Dashboard', tier: 'auth' },
    { label: 'Economy Leaderboard', path: '/dashboard/economy-leaderboard', section: 'Dashboard', tier: 'auth' },
    { label: 'Economy Transactions', path: '/dashboard/economy-transactions', section: 'Dashboard', tier: 'auth' },
    { label: 'Economy Settings', path: '/dashboard/economy-settings', section: 'Dashboard', tier: 'auth' },
    { label: 'Shop Admin', path: '/dashboard/shop-admin', section: 'Dashboard', tier: 'auth' },
    { label: 'Feeds', path: '/dashboard/feeds', section: 'Dashboard', tier: 'auth' },
    { label: 'Roles', path: '/dashboard/roles', section: 'Dashboard', tier: 'auth' },
    { label: 'Server Players', path: '/server-players', section: 'Dashboard', tier: 'auth' },
    { label: 'Server Lists', path: '/server-lists', section: 'Dashboard', tier: 'auth' },
    { label: 'Map & Loot', path: '/map', section: 'Dashboard', tier: 'auth' },
    { label: 'Server Stats', path: '/dashboard/server-stats', section: 'Dashboard', tier: 'auth' },
    { label: 'Deaths & PVP', path: '/dashboard/death-causes', section: 'Dashboard', tier: 'auth' },
    { label: 'Dynamic Event Rates', path: '/dashboard/dynamic-event-rates', section: 'Dashboard', tier: 'auth' },
    { label: 'Automation', path: '/dashboard/automation', section: 'Dashboard', tier: 'auth' },
    { label: 'Tasks', path: '/dashboard/tasks', section: 'Dashboard', tier: 'auth' },
    { label: 'Server Control', path: '/dashboard/server-control', section: 'Dashboard', tier: 'auth' },
    { label: 'Spawn Exclusions', path: '/dashboard/spawn-exclusions', section: 'Dashboard', tier: 'auth' },
    { label: 'Backups', path: '/dashboard/backups', section: 'Dashboard', tier: 'auth' },
    { label: 'Rotation', path: '/dashboard/rotation', section: 'Dashboard', tier: 'auth' },
    { label: 'AI Assistant', path: '/dashboard/ai-assistant', section: 'Dashboard', tier: 'auth' },
    { label: 'Activity Log', path: '/dashboard/activity-log', section: 'Dashboard', tier: 'auth' },
    { label: 'Console', path: '/dashboard/console', section: 'Dashboard', tier: 'auth' },
    { label: 'Boost', path: '/dashboard/boost', section: 'Dashboard', tier: 'auth' },
    { label: 'Support', path: '/dashboard/support', section: 'Dashboard', tier: 'auth' },
    { label: 'Nitrado Server Settings', path: '/dashboard/settings', section: 'Dashboard', tier: 'auth' },
    { label: 'Mission Editor', path: '/mission-editor', section: 'Dashboard', tier: 'auth' },
    { label: 'Logs', path: '/logs', section: 'Dashboard', tier: 'auth' },
    { label: 'Casino', path: '/dashboard/casino', section: 'Dashboard', tier: 'admin' },
    /* Admin (platform) */
    { label: 'Admin Dashboard', path: '/admin', section: 'Admin', tier: 'admin' },
    { label: 'Discord Server Management', path: '/admin/guilds', section: 'Admin', tier: 'admin' },
    { label: 'Bot Config', path: '/admin/bot-config', section: 'Admin', tier: 'admin' },
    { label: 'Activity Zones', path: '/admin/zones', section: 'Admin', tier: 'admin' },
    { label: 'Faction War', path: '/admin/faction-war', section: 'Admin', tier: 'admin' },
    { label: 'Guild Approval', path: '/admin/guilds-approval', section: 'Admin', tier: 'admin' },
    { label: 'All Servers', path: '/admin/servers', section: 'Admin', tier: 'admin' },
    { label: 'Holiday Events', path: '/admin/holiday-events', section: 'Admin', tier: 'admin' },
    { label: 'Users', path: '/admin/users', section: 'Admin', tier: 'admin' },
    { label: 'Admin Roles', path: '/admin/roles', section: 'Admin', tier: 'admin' },
    { label: 'Audit Log', path: '/admin/audit', section: 'Admin', tier: 'admin' },
    { label: 'Database', path: '/admin/database', section: 'Admin', tier: 'admin' },
    { label: 'Reports', path: '/admin/reports', section: 'Admin', tier: 'admin' },
    { label: 'Supply Monitor', path: '/admin/supply-monitor', section: 'Admin', tier: 'admin' },
    { label: 'Economy Analytics', path: '/admin/economy-analytics', section: 'Admin', tier: 'admin' },
    { label: 'Theme', path: '/admin/theme', section: 'Admin', tier: 'admin' },
    { label: 'Loot Probability', path: '/tools/loot-probability', section: 'Tools', tier: 'admin' },
    /* Tools (public toolkit) */
    { label: 'DayZ Toolkit', path: '/tools', section: 'Tools', tier: 'public' },
    { label: 'XML Validator', path: '/tools/xml-validator', section: 'Tools', tier: 'public' },
    { label: 'JSON Validator', path: '/tools/json-validator', section: 'Tools', tier: 'public' },
    { label: 'Mission Validator', path: '/tools/mission-validator', section: 'Tools', tier: 'public' },
    { label: 'Duplicate Checker', path: '/tools/duplicate-checker', section: 'Tools', tier: 'public' },
    { label: 'Event Conflicts', path: '/tools/event-conflicts', section: 'Tools', tier: 'public' },
    { label: 'PAA Converter', path: '/tools/paa-converter', section: 'Tools', tier: 'public' },
    { label: 'Loadout Generator', path: '/tools/loadout-generator', section: 'Tools', tier: 'public' },
    { label: 'Spawnabletypes Generator', path: '/tools/spawnabletypes-generator', section: 'Tools', tier: 'public' }
  ];

  var SECTION_ORDER = ['Public', 'Player', 'Dashboard', 'Admin', 'Tools'];

  /* ── Pure helpers (exported for scripts/command-palette-test.js) ───── */

  /** Keep only the pages the current user may open. */
  function accessible(pages, auth, admin) {
    return pages.filter(function (p) {
      if (p.tier === 'public') return true;
      if (p.tier === 'auth') return !!auth;
      return !!admin; // 'admin'
    });
  }

  /** Score a page against a query: lower is better, -1 = no match.
   * Substring on label first, then path, then in-order subsequence on label. */
  function match(page, rawQuery) {
    var q = String(rawQuery || '').trim().toLowerCase();
    if (!q) return 0;
    var label = page.label.toLowerCase();
    var path = page.path.toLowerCase();
    var li = label.indexOf(q);
    var pi = path.indexOf(q);
    var score = -1;
    if (li === 0) score = 1;
    else if (li > 0 && (label[li - 1] === ' ' || label[li - 1] === '-')) score = 2;
    else if (li > 0) score = 3;
    if (pi >= 0) {
      var pScore = pi === 0 ? 4 : 5;
      if (score === -1 || pScore < score) score = pScore;
    }
    if (score === -1 && label.indexOf(q) === -1) {
      // In-order subsequence ("conso" → Console) for fuzzy fallback.
      var i = 0;
      for (var c = 0; c < label.length && i < q.length; c++) {
        if (label[c] === q[i]) i++;
      }
      if (i === q.length) score = 6;
    }
    return score;
  }

  /** Filter + rank + group. Returns [{section, items:[{page, score}]}] in
   * section order; empty groups omitted. */
  function filterAndGroup(pages, query) {
    var q = String(query || '').trim();
    var scored = [];
    for (var i = 0; i < pages.length; i++) {
      var s = match(pages[i], q);
      if (s !== -1) scored.push({ page: pages[i], score: s });
    }
    scored.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      return a.page.label.localeCompare(b.page.label);
    });
    var bySection = {};
    scored.forEach(function (entry) {
      var sec = entry.page.section;
      (bySection[sec] = bySection[sec] || []).push(entry);
    });
    return SECTION_ORDER
      .filter(function (sec) { return bySection[sec]; })
      .map(function (sec) { return { section: sec, items: bySection[sec] }; });
  }

  /* Node: export the pure helpers for scripts/command-palette-test.js. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PAGES: PAGES, accessible: accessible, match: match, filterAndGroup: filterAndGroup };
  }

  /* ── Browser wiring (no-op outside a DOM) ──────────────────────────── */
  if (typeof document === 'undefined') return;

  var root = document.documentElement;
  var overlay = null; // built lazily on first open
  var input = null, list = null;
  var results = [];   // current flat items in display order
  var activeIndex = 0;
  var lastFocused = null;
  var isOpen = false;

  function flags() {
    return {
      auth: root.getAttribute('data-cmdk-auth') === '1',
      admin: root.getAttribute('data-cmdk-admin') === '1'
    };
  }

  function build() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'dzc-cmdk';
    overlay.setAttribute('hidden', '');
    overlay.innerHTML =
      '<div class="dzc-cmdk-panel" role="dialog" aria-modal="true" aria-label="Search pages">' +
      '  <input class="dzc-cmdk-input" type="text" placeholder="Jump to a page…" autocomplete="off" spellcheck="false" aria-label="Search pages" aria-controls="dzc-cmdk-list">' +
      '  <ul id="dzc-cmdk-list" class="dzc-cmdk-list" role="listbox"></ul>' +
      '  <div class="dzc-cmdk-hint" aria-hidden="true"><span>↑↓</span> navigate&nbsp;·&nbsp;<span>↵</span> open&nbsp;·&nbsp;<span>esc</span> close</div>' +
      '</div>';
    document.body.appendChild(overlay);
    input = overlay.querySelector('.dzc-cmdk-input');
    list = overlay.querySelector('.dzc-cmdk-list');

    overlay.addEventListener('mousedown', function (ev) {
      if (ev.target === overlay) close();
    });
    input.addEventListener('input', function () { render(); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
      else if (ev.key === 'Enter') { ev.preventDefault(); go(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      else if (ev.key === 'Tab') { ev.preventDefault(); /* keep focus in the input */ }
    });
    list.addEventListener('click', function (ev) {
      var item = ev.target.closest('.dzc-cmdk-item');
      if (item && overlay.contains(item)) {
        window.location.href = item.getAttribute('data-path');
      }
    });
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function render() {
    var f = flags();
    var groups = filterAndGroup(accessible(PAGES, f.auth, f.admin), input ? input.value : '');
    results = [];
    var html = '';
    groups.forEach(function (group) {
      html += '<li class="dzc-cmdk-group" aria-hidden="true">' + esc(group.section) + '</li>';
      group.items.forEach(function (entry) {
        results.push(entry.page);
        html += '<li class="dzc-cmdk-item" role="option" data-path="' + esc(entry.page.path) + '" aria-selected="false">' +
          '<span class="dzc-cmdk-item-label">' + esc(entry.page.label) + '</span>' +
          '<span class="dzc-cmdk-item-path">' + esc(entry.page.path) + '</span></li>';
      });
    });
    if (!results.length) {
      html = '<li class="dzc-cmdk-empty" role="option" aria-selected="false">No matching pages</li>';
    }
    // html is built only from the static PAGES index + esc()-escaped values;
    // the user query is never inserted into markup.
    list.innerHTML = html;
    activeIndex = 0;
    updateActive();
  }

  function move(dir) {
    if (!results.length) return;
    activeIndex = (activeIndex + dir + results.length) % results.length;
    updateActive();
  }

  function updateActive() {
    var items = list.querySelectorAll('.dzc-cmdk-item');
    items.forEach(function (el, i) {
      var on = i === activeIndex;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function go() {
    var item = results[activeIndex];
    if (item) window.location.href = item.path;
  }

  function open() {
    build();
    if (isOpen) { input.focus(); return; }
    isOpen = true;
    lastFocused = document.activeElement;
    overlay.removeAttribute('hidden');
    input.value = '';
    render();
    input.focus();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    overlay.setAttribute('hidden', '');
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    lastFocused = null;
  }

  function onDocumentKeydown(ev) {
    var mod = ev.ctrlKey || ev.metaKey;
    if (mod && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      if (isOpen) close(); else open();
      return;
    }
    // Esc from anywhere closes the open palette.
    if (ev.key === 'Escape' && isOpen && !overlay.contains(document.activeElement)) {
      ev.preventDefault();
      close();
    }
  }

  document.addEventListener('keydown', onDocumentKeydown);
  document.addEventListener('click', function (ev) {
    var trigger = ev.target.closest && ev.target.closest('[data-cmdk-trigger]');
    if (trigger && isOpen === false) open();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { /* no-op; handlers are document-level */ });
  }
})();
