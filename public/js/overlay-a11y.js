/* global document, window */
'use strict';

/*
 * Overlay a11y — shared keyboard/focus management for modals and menus
 * (card t_6cca8223). Extracted from the app-shell drawer trap
 * (public/js/app-shell.js), the only correct focus-trap implementation in
 * the codebase; every modal/menu now uses this one.
 *
 * Wiring from a page's own open/close code:
 *   // after the overlay is made visible:
 *   window.DzcOverlayFocus.open(overlayEl, { onClose: closeFn, focusEl: el });
 *   // in the page's close path:
 *   window.DzcOverlayFocus.close(overlayEl);
 *
 * Behavior:
 *   - open: remembers the trigger (current focus) and moves focus inside
 *     (focusEl, else first focusable, else the overlay itself); sets
 *     aria-modal. The focus move is deferred one tick so the caller's
 *     same-tick unhide applies first (focusing display:none is a no-op).
 *   - while open: Tab/Shift+Tab cycle within the overlay; Esc closes the
 *     topmost overlay (its onClose, or a plain close).
 *   - close: restores focus to the trigger, but only when the closed
 *     overlay was the topmost — with nested overlays (e.g. the shop map
 *     picker above the Add-to-Cart modal) closing the top returns focus
 *     into the still-open overlay below.
 */
(function () {
  var TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var stack = []; // { overlay, trigger, onClose } — bottom to top
  var listenerOn = false;

  function focusables(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll(TABBABLE),
      function (el) { return el.offsetParent !== null || getComputedStyle(el).display !== 'none'; }
    );
  }

  function onKeydown(ev) {
    var top = stack[stack.length - 1];
    if (!top) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof top.onClose === 'function') top.onClose();
      else close(top.overlay);
      return;
    }
    if (ev.key === 'Tab') {
      var items = focusables(top.overlay);
      if (!items.length) { ev.preventDefault(); return; }
      var first = items[0], last = items[items.length - 1];
      var cur = document.activeElement;
      if (ev.shiftKey && (cur === first || !top.overlay.contains(cur))) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && (cur === last || !top.overlay.contains(cur))) {
        ev.preventDefault();
        first.focus();
      }
    }
  }

  function open(overlay, opts) {
    opts = opts || {};
    if (!overlay || typeof overlay.contains !== 'function') return;
    var entry = { overlay: overlay, trigger: document.activeElement, onClose: opts.onClose || null, focusEl: opts.focusEl || null };
    stack.push(entry);
    if (!overlay.hasAttribute('tabindex')) overlay.setAttribute('tabindex', '-1');
    overlay.setAttribute('aria-modal', 'true');
    var target = entry.focusEl && overlay.contains(entry.focusEl)
      ? entry.focusEl
      : (focusables(overlay)[0] || overlay);
    setTimeout(function () {
      if (stack[stack.length - 1] === entry && typeof target.focus === 'function') target.focus();
    }, 0);
    if (!listenerOn) { document.addEventListener('keydown', onKeydown, true); listenerOn = true; }
  }

  function close(overlay) {
    var idx = -1;
    for (var i = stack.length - 1; i >= 0; i--) {
      if (!overlay || stack[i].overlay === overlay) { idx = i; break; }
    }
    if (idx === -1) return;
    var entry = stack.splice(idx, 1)[0];
    if (idx === stack.length) {
      var t = entry.trigger;
      if (t && document.contains(t) && typeof t.focus === 'function') t.focus();
    }
    if (overlay) overlay.removeAttribute('aria-modal');
    if (!stack.length && listenerOn) { document.removeEventListener('keydown', onKeydown, true); listenerOn = false; }
  }

  if (typeof document !== 'undefined') {
    window.DzcOverlayFocus = { open: open, close: close };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { open: open, close: close };
})();
