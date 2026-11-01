/**
 * DataFreshness — "Last updated HH:MM:SS" indicator + Refresh control for
 * live-data pages. One shared client-side helper; each page opts in with a
 * plain anchor element near the top of its data area:
 *
 *   <div id="my-freshness"></div>
 *   const dfh = DataFreshness.mount('my-freshness', async () => {
 *     const r = await loadMyData();      // page's fetch; must keep stale data on error
 *     if (!r.ok) throw new Error(r.message);
 *   });
 *
 * - While a refresh is in flight the button shows a spinner and is disabled.
 * - On failure the indicator shows a brief error; the page's data area keeps
 *   its stale content (the loader must not blank it on error).
 * - For fetches triggered elsewhere (server switch, membership change, …)
 *   call dfh.reset() first, then mark the outcome: markSuccess() / markError(msg).
 */
(function () {
  'use strict';

  function fmtTime(ts) {
    const d = ts ? new Date(ts) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function mount(anchorId, refreshFn, opts) {
    const anchor = document.getElementById(anchorId);
    if (!anchor || typeof refreshFn !== 'function') return null;
    opts = opts || {};

    let lastSuccess = null;
    let inFlight = false;
    let error = '';

    const row = document.createElement('div');
    row.className = 'dzc-data-freshness flex items-center gap-2';
    const label = document.createElement('span');
    label.className = 'dzc-freshness text-xs';
    label.setAttribute('aria-live', 'polite');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dzc-btn';
    btn.setAttribute('aria-label', 'Refresh data');
    row.append(label, btn);
    anchor.replaceChildren(row);

    function render() {
      if (inFlight) {
        label.textContent = 'Refreshing…';
        label.classList.remove('dzc-danger');
        btn.disabled = true;
        // Static spinner markup only — no user content, safe for innerHTML.
        btn.innerHTML = '<span class="dzc-spinner" style="width:12px;height:12px" aria-hidden="true"></span> Refreshing…';
      } else {
        btn.disabled = false;
        btn.textContent = '↻ Refresh';
        if (error) {
          label.textContent = error;
          label.classList.add('dzc-danger');
        } else if (lastSuccess) {
          label.textContent = 'Last updated ' + fmtTime(lastSuccess);
          label.classList.remove('dzc-danger');
        } else {
          label.textContent = 'Last updated —';
          label.classList.remove('dzc-danger');
        }
      }
    }

    async function run() {
      if (inFlight) return;
      inFlight = true;
      error = '';
      render();
      try {
        await refreshFn();
        lastSuccess = Date.now();
      } catch (err) {
        error = 'Refresh failed' + (err && err.message ? ': ' + String(err.message).slice(0, 80) : '');
      }
      inFlight = false;
      render();
    }

    function markSuccess() {
      if (inFlight) return;
      lastSuccess = Date.now();
      error = '';
      render();
    }

    function markError(msg) {
      if (inFlight) return;
      error = String(msg || 'Refresh failed').slice(0, 100);
      render();
    }

    function reset() {
      if (inFlight) return;
      lastSuccess = null;
      error = '';
      render();
    }

    btn.addEventListener('click', run);
    render();
    if (opts.auto !== false) run();
    return { run, markSuccess, markError, reset };
  }

  window.DataFreshness = { mount, fmtTime };
})();
