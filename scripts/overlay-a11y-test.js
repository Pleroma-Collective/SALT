/* global console, process, require */
'use strict';

/*
 * overlay-a11y-test — keyboard/focus a11y pass (card t_6cca8223).
 *
 * Source-contract suite in the house style (the helper itself is DOM-only,
 * so behavior is verified live in the browser; this pins the wiring so a
 * future modal/menus change can't quietly drop focus management):
 *   1. the shared helper exists, parses, and exports open/close;
 *   2. the head injection ships the helper on every rendered page;
 *   3. the kit carries the blanket :focus-visible ring;
 *   4. every known modal is wired (open → focus in, close → focus back);
 *   5. the theme menu + shell drawer use the shared helper (no forked trap);
 *   6. the mission-editor id reset can't swallow the keyboard ring.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// 1. The helper itself.
console.log('overlay-a11y helper');
const helper = read('public/js/overlay-a11y.js');
ok(helper.includes('window.DzcOverlayFocus = { open: open, close: close }'), 'exposes window.DzcOverlayFocus {open, close}');
ok(helper.includes("document.addEventListener('keydown', onKeydown, true)"), 'traps with a capture-phase keydown (wins over page listeners)');
ok(helper.includes('aria-modal'), 'marks overlays aria-modal');
ok(helper.includes('ev.key === \'Escape\''), 'closes on Esc');
ok(helper.includes('ev.key === \'Tab\''), 'contains Tab');
const m = require(path.join(ROOT, 'public/js/overlay-a11y.js'));
ok(typeof m.open === 'function' && typeof m.close === 'function', 'loads under node (module contract)');

// 2. Head injection — every rendered page (renderWithCsrf + renderShellPage
//    both go through applyPageChromes) gets the helper before page scripts.
console.log('head injection');
const rwc = read('utils/renderWithCsrf.js');
const injIdx = rwc.indexOf('<script src="/js/overlay-a11y.js"></script>');
ok(injIdx !== -1, 'headInjection ships overlay-a11y.js');
if (injIdx !== -1) {
  ok(injIdx < rwc.indexOf('<script defer src="/js/command-palette.js">'), 'loads before the deferred page-chrome scripts');
}

// 3. Kit blanket focus ring.
console.log('kit focus ring');
const kit = read('public/css/components.css');
for (const sel of ['button:focus-visible', 'input:focus-visible', 'select:focus-visible',
  '[tabindex]:not([tabindex="-1"]):focus-visible', '[role="menuitemradio"]:focus-visible']) {
  ok(new RegExp(sel.replace(/[[\]"-]/g, '\\$&') + '\\b').test(kit) || kit.includes(sel), `blanket rule covers ${sel}`);
}
ok(kit.includes('outline: 2px solid var(--dzc-accent)'), 'ring is token-driven (works under all 5 themes)');

// 4. Modal wiring — every overlay: open registers it, every close path
//    releases it. [file, element id, close sites expected]
console.log('modal wiring');
const MODALS = [
  ['public/js/player-portal.js', 'linkModal', 1],
  ['public/js/shop.js', 'atc-modal', 1],
  ['public/js/shop.js', 'map-picker-modal', 1],
  ['public/js/mission-editor.js', 'conflictModal', 2],
  ['public/js/rotation.js', 'snippetModal', 2],
  ['public/js/rotation.js', 'presetModal', 2],
  ['public/js/rotation.js', 'addSnippetModal', 2],
  ['public/js/admin-guilds.js', 'deleteModal', 1],
  ['public/js/admin-servers.js', 'deleteModal', 1],
  ['public/js/admin-users.js', 'role-modal', 1],
  ['public/js/admin-reports.js', 'resolveModal', 1],
  ['public/js/admin-guilds-approval.js', 'confirmModal', 1],
  ['public/js/ai-assistant.js', 'aiProviderModal', 1],
  ['public/js/ai-assistant.js', 'connectModal', 1],
  ['public/js/ai-assistant.js', 'diffModal', 1],
  ['public/js/backupManager.js', 'confirmModal', 1],
  ['public/js/economy-dashboard-init.js', 'depositModal', 2],
  ['public/js/economy-dashboard-init.js', 'withdrawModal', 2],
  ['public/js/player-portal.js', 'depositModal', 1],
  ['public/js/player-portal.js', 'withdrawModal', 1],
  ['public/js/player-portal.js', 'transferModal', 1],
  ['public/js/player-portal.js', 'transferHistoryModal', 1],
  ['public/js/components/transactionList.js', 'txDetailModal', 1],
];
for (const [file, id, closeSites] of MODALS) {
  const src = read(file);
  // Open/close sites may reference the element via document.getElementById(id)
  // or via the page's local (player-portal names its locals after the id).
  const openRe = new RegExp(`DzcOverlayFocus\\.open\\(\\s*(?:document\\.getElementById\\('${id}'\\)|(?<![a-zA-Z])${id})[),\\s]`, 'g');
  const opens = (src.match(openRe) || []).length
    + (src.match(new RegExp(`DzcOverlayFocus\\.open\\(\\s*modal`, 'g')) || []).length;
  const closeRe = new RegExp(`DzcOverlayFocus\\.close\\(\\s*(?:document\\.getElementById\\('${id}'\\)|(?<![a-zA-Z])${id})[),\\s]`, 'g');
  const closes = (src.match(closeRe) || []).length;
  ok(opens >= 1, `${path.basename(file)}: ${id} registers on open`);
  ok(closes >= closeSites, `${path.basename(file)}: ${id} released on ${closeSites} close path(s) (found ${closes})`);
}

// 5. Theme menu + shell drawer — shared helper, no forked trap logic left.
console.log('menu + drawer');
const theme = read('public/js/theme-toggle.js');
ok(theme.includes('DzcOverlayFocus.open(menuEl'), 'theme menu registers with the shared helper');
ok(theme.includes('ArrowDown'), 'theme menu supports arrow keys');
const shell = read('public/js/app-shell.js');
ok(shell.includes('DzcOverlayFocus.open(sidebar'), 'mobile drawer uses the shared helper');
ok(!shell.includes('function onKeydown') && !shell.includes('lastFocused'), 'drawer\'s old trap/lastFocused removed (single source of truth)');

// 6. Mission editor id-level reset must not swallow the keyboard ring.
console.log('page-level resets');
const me = read('public/mission-editor.html');
ok(me.includes('#editor:focus:not(:focus-visible)'), '#editor only suppresses the ring for mouse focus');

// 7. Toolkit dropzone is a keyboard control (ring via the kit's blanket rule).
console.log('toolkit dropzone');
const tkd = read('public/js/tools/toolkit-dom.js');
ok(tkd.includes("drop.setAttribute('tabindex', '0')"), 'dropzone is focusable');
ok(tkd.includes("drop.setAttribute('role', 'button')"), 'dropzone advertises role=button');
ok(tkd.includes("e.key === 'Enter'") && tkd.includes("input.click()"), 'dropzone opens the picker on Enter/Space');

console.log(`\noverlay-a11y suite: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
