'use strict';

/* eslint-env browser */
/*
 * Theme preflight (card 2/9) — synchronous <head> script that applies the
 * persisted theme (localStorage "dayz-theme") before first paint, so the
 * user's last choice shows instead of the default palette (no flash).
 *
 * This MUST stay an external file, not an inline <script>: the site CSP is
 * script-src 'self', which blocks inline scripts (an inline version of this
 * script was silently dropped by the browser and the persisted theme was
 * never applied on reload). If it is ever inlined again, the CSP must gain
 * a matching hash.
 *
 * The picker (theme-toggle.js, deferred) reads the same key and the same
 * theme list; keep them in sync.
 */

(function () {
  var THEMES = ['livonia', 'chernarus', 'sakhal', 'nasadra', 'high-contrast'];
  var LEGACY_MAP = { dark: 'livonia', light: 'sakhal' };
  try {
    var stored = localStorage.getItem('dayz-theme');
    if (stored) {
      stored = LEGACY_MAP[stored] || stored;
      if (THEMES.indexOf(stored) > -1) {
        document.documentElement.setAttribute('data-theme', stored);
      }
    }
  } catch (e) {
    /* storage unavailable (blocked/private mode) — default palette applies */
  }
})();
