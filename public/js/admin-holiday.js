/* global document, window, fetchWithCsrf */
/* Admin Holiday Events — per-server holiday window management.
   API: /api/admin/holiday-events* (ensureAdmin). DB-persisted per server;
   servers without a row run the default set from /data/holiday-windows.json. */
(function () {
  'use strict';

  const els = {
    serverSelect: document.getElementById('server-select'),
    masterToggle: document.getElementById('master-toggle'),
    applyDefaults: document.getElementById('apply-defaults-btn'),
    packNote: document.getElementById('pack-note'),
    sourceNote: document.getElementById('event-source-note'),
    rows: document.getElementById('event-rows'),
    defaultsList: document.getElementById('defaults-list'),
    pageError: document.getElementById('page-error'),
  };

  const state = { detail: null };

  function showError(msg) {
    els.pageError.textContent = msg;
    els.pageError.hidden = !msg;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function stateBadge(event) {
    const s = event.state || {};
    const label = s.state === 'live' ? 'live'
      : s.state === 'upcoming' ? `upcoming · ${s.nextWindow?.[0] || ''}`
      : 'expired';
    return `<span class="state-badge state-${s.state}">${escapeHtml(label)}</span>`;
  }

  function windowText(event) {
    // All dynamic fields below are escapeHtml()'d; windows are validated
    // YYYY-MM-DD strings server-side before they can reach the DOM.
    return (event.windows || []).map(w => `${escapeHtml(w[0])} → ${escapeHtml(w[1])}`).join('<br>');
  }

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function mutate(url, options) {
    const res = await fetchWithCsrf(url, options);
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function loadDefaults() {
    try {
      const data = await getJson('/api/admin/holiday-events');
      els.defaultsList.innerHTML = data.defaults.map(ev =>
        `<div>${escapeHtml(ev.icon || '📅')} <strong>${escapeHtml(ev.label)}</strong> — ` +
        `${(ev.windows || []).map(w => `${w[0]} → ${w[1]}`).join(', ')}` +
        ` ${stateBadge(ev)}</div>`).join('');
      await loadServers(data.servers);
    } catch (err) {
      showError(`Failed to load holiday configs: ${err.message}`);
    }
  }

  async function loadServers(servers) {
    els.serverSelect.innerHTML = '<option value="">Select a server…</option>' +
      (servers || []).map(s =>
        `<option value="${s.serverId}">${escapeHtml(`${s.guildName} — ${s.serverName} (${s.platformServerId})`)}</option>`
      ).join('');
  }

  async function loadDetail() {
    const serverId = els.serverSelect.value;
    if (!serverId) {
      state.detail = null;
      els.rows.innerHTML = '';
      els.sourceNote.textContent = 'Select a server to manage its holiday events.';
      els.packNote.textContent = '';
      return;
    }
    try {
      const data = await getJson(`/api/admin/holiday-events/${serverId}`);
      state.detail = data;
      els.masterToggle.checked = data.config.enabled;
      els.sourceNote.innerHTML = data.config.source === 'default'
        ? 'This server is running the <strong>default set</strong> (no per-server override yet).'
        : 'This server has a <strong>per-server override</strong> stored in the database.';
      const missing = data.packs.missing || {};
      if (!data.packs.known) {
        els.packNote.textContent = 'Pack check: no download directory for this server yet (packs not verified).';
      } else if (missing.missing?.length) {
        els.packNote.innerHTML = `<span class="pack-missing">Packs missing on this server: ${escapeHtml(missing.missing.map(m => m.mission).join(', '))}</span>` +
          ` — available: ${escapeHtml((data.packs.folders || []).join(', ') || 'none')}`;
      } else {
        els.packNote.innerHTML = `All configured packs found on this server.`;
      }
      renderRows();
      showError('');
    } catch (err) {
      showError(`Failed to load server holiday config: ${err.message}`);
    }
  }

  function missionCell(event) {
    const missingSet = new Set((state.detail?.packs?.missing?.missing || []).map(m => m.mission));
    const known = state.detail?.packs?.known;
    return (event.missions || []).map(m =>
      `<span class="${known && missingSet.has(m) ? 'pack-missing' : known ? 'pack-ok' : ''}">${escapeHtml(m)}${known ? (missingSet.has(m) ? ' ✗' : ' ✓') : ''}</span>`
    ).join('<br>');
  }

  function renderRows() {
    const events = state.detail?.config?.events || [];
    els.rows.innerHTML = events.map(ev =>
      `<tr data-event-id="${escapeHtml(ev.id)}" class="border-b border-gray-700/60">
        <td class="py-3 pr-4"><span class="text-xl">${escapeHtml(ev.icon || '📅')}</span> <strong>${escapeHtml(ev.label)}</strong> <span class="text-gray-500">(${escapeHtml(ev.id)})</span></td>
        <td class="py-3 pr-4">${missionCell(ev)}</td>
        <td class="py-3 pr-4">${windowText(ev)}</td>
        <td class="py-3 pr-4">${stateBadge(ev)}</td>
        <td class="py-3"><button class="edit-btn bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded" data-id="${escapeHtml(ev.id)}">Edit</button></td>
      </tr>`).join('');
  }

  function editFormRow(event) {
    const windows = (event.windows || []).map((w, i) =>
      `<label class="flex items-center gap-1">
        <input type="date" class="win-start bg-gray-700 p-1 rounded" data-i="${i}" value="${w[0]}">
        →
        <input type="date" class="win-end bg-gray-700 p-1 rounded" data-i="${i}" value="${w[1]}">
      </label>`).join('');
    return `<tr class="bg-gray-800/60">
      <td colspan="5" class="p-3">
        <div class="text-xs text-gray-400 mb-2">Edit “${escapeHtml(event.label)}”</div>
        <div class="flex flex-col gap-2">
          <label class="text-sm text-gray-400">Missions (prefixes, comma-separated)
            <input type="text" class="missions-input bg-gray-700 p-2 rounded w-full ml-0" value="${escapeHtml((event.missions || []).join(', '))}">
          </label>
          <div class="text-sm text-gray-400">Windows (start → end, inclusive days)
            <div class="flex flex-col gap-1 mt-1">${windows}</div>
          </div>
          <div class="flex gap-2">
            <button class="save-btn bg-green-700 hover:bg-green-600 px-3 py-1 rounded" data-id="${escapeHtml(event.id)}">Save</button>
            <button class="cancel-btn bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded" data-id="${escapeHtml(event.id)}">Cancel</button>
          </div>
          <p class="save-error text-red-400 text-sm" hidden></p>
        </div>
      </td>
    </tr>`;
  }

  function startEdit(eventId) {
    const ev = (state.detail?.config?.events || []).find(e => e.id === eventId);
    if (!ev) return;
    const row = els.rows.querySelector(`tr[data-event-id="${eventId}"]`);
    if (!row) return;
    row.insertAdjacentHTML('afterend', editFormRow(ev));
    els.rows.querySelector(`tr[data-event-id="${eventId}"] button.edit-btn`)?.closest('tr').classList.add('hidden');
  }

  function endEdit(eventId) {
    const form = els.rows.querySelector(`tr .save-btn[data-id="${eventId}"]`)?.closest('tr');
    if (form) form.remove();
    els.rows.querySelector(`tr[data-event-id="${eventId}"]`)?.classList.remove('hidden');
  }

  async function saveEdit(eventId) {
    const form = els.rows.querySelector(`tr .save-btn[data-id="${eventId}"]`)?.closest('tr');
    const errorEl = form?.querySelector('.save-error');
    if (!form) return;
    const missions = [...form.querySelectorAll('.missions-input')].map(i =>
      i.value.split(',').map(s => s.trim()).filter(Boolean));
    const starts = [...form.querySelectorAll('.win-start')].map(i => i.value);
    const ends = [...form.querySelectorAll('.win-end')].map(i => i.value);
    const windows = starts.map((s, i) => [s, ends[i]]);
    const events = (state.detail.config.events || []).map(e => e.id === eventId
      ? { ...e, missions, windows }
      : e);

    if (errorEl) { errorEl.textContent = 'Saving…'; errorEl.hidden = false; }
    try {
      await mutate(`/api/admin/holiday-events/${state.detail.server.serverId}`, {
        method: 'PUT',
        body: JSON.stringify({ events }),
      });
      await loadDetail();
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message;
      showError(err.message);
    }
  }

  els.serverSelect?.addEventListener('change', loadDetail);

  els.masterToggle?.addEventListener('change', async () => {
    if (!state.detail) return;
    try {
      await mutate(`/api/admin/holiday-events/${state.detail.server.serverId}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ enabled: els.masterToggle.checked }),
      });
      state.detail.config.enabled = els.masterToggle.checked;
      showError('');
    } catch (err) {
      els.masterToggle.checked = !els.masterToggle.checked;
      showError(err.message);
    }
  });

  els.applyDefaults?.addEventListener('click', async () => {
    if (!state.detail) return;
    if (!window.confirm(`Apply the default BiSTudio schedule to ${state.detail.server.name}? This replaces its current windows.`)) return;
    try {
      await mutate(`/api/admin/holiday-events/${state.detail.server.serverId}/apply-defaults`, { method: 'POST', body: '{}' });
      await loadDetail();
      showError('');
    } catch (err) {
      showError(err.message);
    }
  });

  els.rows?.addEventListener('click', (e) => {
    const edit = e.target.closest('button.edit-btn');
    if (edit) { startEdit(edit.dataset.id); return; }
    const cancel = e.target.closest('button.cancel-btn');
    if (cancel) { endEdit(cancel.dataset.id); return; }
    const save = e.target.closest('button.save-btn');
    if (save) saveEdit(save.dataset.id);
  });

  loadDefaults().catch(err => showError(err.message));
})();
