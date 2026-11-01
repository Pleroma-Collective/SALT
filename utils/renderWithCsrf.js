const fs = require('fs');
const themeService = require('../services/themeService');

const htmlCache = new Map();
const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Read an HTML file, inject the CSRF token as a <meta> tag, and send it.
 * In production the file is cached after the first read; in development it
 * is re-read on every request so changes are picked up immediately.
 *
 * Also injects the resolved theme (B1.2) when the theme middleware set
 * `req.theme`: a `data-theme` attribute on <html>, a no-flash preflight
 * script (/js/theme-preflight.js — external, because the site CSP blocks
 * inline scripts) that applies the user's persisted theme before first
 * paint, and (when present) a `<style data-theme-override>` block carrying the holiday/accent
 * token values. The override is emitted AFTER the page's own <link> tags so
 * it wins the cascade for the tokens it redeclares.
 *
 * @param {string} filePath - Absolute path to the HTML file
 * @param {import('express').Request} req - Express request (must have csrfToken())
 * @param {import('express').Response} res - Express response
 */
function renderWithCsrf(filePath, req, res) {
  let html;

  if (!isDevelopment && htmlCache.has(filePath)) {
    html = htmlCache.get(filePath);
  } else {
    html = fs.readFileSync(filePath, 'utf8');
    if (!isDevelopment) {
      htmlCache.set(filePath, html);
    }
  }

  res.send(applyPageChromes(html, req));
}

/**
 * Apply the shared per-request page "chromes" to an already-fully-assembled
 * HTML document: the `data-theme` attribute on <html>, the no-flash
 * preflight script + floating theme toggle, the (optional) holiday/accent override
 * <style> block, and the CSRF <meta> token. This is the same injection
 * `renderWithCsrf` performs; it is exported so the route-aware app shell
 * (utils/appShell.js) can build a composed document and hand it back through
 * the exact same injection path.
 *
 * @param {string} html - A complete HTML document string.
 * @param {import('express').Request} req - Express request (must have csrfToken()).
 * @returns {string} The document with all chromes injected.
 */
function applyPageChromes(html, req) {
  const csrfToken = req.csrfToken ? req.csrfToken() : '';
  const escapedToken = csrfToken
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const overrideCss = req.theme && typeof req.theme.overrideCss === 'string'
    ? req.theme.overrideCss
    : '';
  const baseTheme = req.theme && themeService.normalizeThemeName(req.theme.baseTheme)
    ? themeService.normalizeThemeName(req.theme.baseTheme)
    : themeService.DEFAULT_BASE_THEME;

  // Command palette access flags (client-side page index — no round-trip).
  // Mirrors middleware/auth.js ensureAdmin + the ensureAuthenticated gate.
  const authed = typeof req.isAuthenticated === 'function' && req.isAuthenticated();
  const admin = !!(authed && req.user && (req.user.is_admin ||
    req.user.platform_role === 'dashboard_admin' ||
    req.user.platform_role === 'dashboard_owner'));
  const themeAttr = `<html data-theme="${baseTheme}" data-cmdk-auth="${authed ? '1' : '0'}" data-cmdk-admin="${admin ? '1' : '0'}"`;

  const headInjection = `  <meta name="csrf-token" content="${escapedToken}">
  <script src="/js/theme-preflight.js"></script>
  <script src="/js/overlay-a11y.js"></script>
  <script defer src="/js/theme-toggle.js"></script>
  <link rel="stylesheet" href="/css/palette.css">
  <script defer src="/js/command-palette.js"></script>
${overrideCss ? `  <style data-theme-override>\n${overrideCss}\n  </style>` : ''}
`;

  return html
    .replace(/<html(\s[^>]*)?>/i, `${themeAttr}$1>`)
    .replace('</head>', `${headInjection}</head>`);
}

module.exports = { renderWithCsrf, applyPageChromes };
