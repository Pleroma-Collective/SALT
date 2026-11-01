    'use strict';
    const CATS = [
      ['weapons', '🔫 Weapons'],
      ['ammo', '🎯 Ammo'],
      ['armor', '🦺 Armor'],
      ['vehicles', '🚙 Vehicles'],
    ];
    const state = { data: null, spawnables: {}, cat: 'weapons', view: 'info', q: '', selected: new Set() };
    const $ = (id) => document.getElementById(id);
    const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const tierBadge = (it) => it.unique ? '<span class="tier-badge unique">Unique</span>'
      : it.tier ? '<span class="tier-badge">Tier ' + it.tier + '</span>'
      : '<span class="tier-badge">untiered</span>';
    const hrs = (s) => (s == null ? '—' : (s / 3600).toFixed(s % 3600 === 0 ? 0 : 1) + ' h');
    const storage = (it) => it.storageSlots == null ? '—' : it.storageGrid ? it.storageSlots + ' (' + esc(it.storageGrid) + ')' : it.storageSlots;
    const spawn = (it) => ItemCatalog.spawnInfo(it.classname, state.spawnables);
    const dmg = (it) => { const s = spawn(it); return s && s.damageMin != null ? s.damageMin + '–' + s.damageMax : '—'; };
    const parts = (it) => { const s = spawn(it); return s && s.parts.length ? s.parts.map((p) => esc(p.name) + (p.count > 1 ? ' ×' + p.count : '') + (p.chance != null ? ' (' + Math.round(p.chance * 100) + '%)' : '')).join(', ') : '—'; };

    // Full column set — Info rows and Compare share it so both stay in sync.
    // Vanilla cfg stats (storage/insulation/description) come from the
    // extractor's vanilla join and are identical on every map.
    const COLS = [
      ['Item', (it) => esc(it.name) + '<br><span class="classname">' + esc(it.classname) + '</span>'],
      ['Tier', (it) => tierBadge(it)],
      ['Storage', (it) => storage(it)],
      ['Insulation', (it) => it.insulation == null ? '—' : it.insulation],
      ['Description', (it) => it.description ? esc(it.description) : '—'],
      ['Nominal', (it) => it.nominal ?? '—'],
      ['Min', (it) => it.min ?? '—'],
      ['Lifetime', (it) => hrs(it.lifetime)],
      ['Restock', (it) => it.restock ?? '—'],
      ['Spawns in', (it) => (it.usages || []).length ? it.usages.map(esc).join(', ') : '—'],
      ['Spawn damage', (it) => dmg(it)],
      ['Spawn parts', (it) => parts(it)],
    ];

    function sortCat(items) {
      return [...items].sort((a, b) => {
        const ta = a.tier == null ? 99 : a.tier, tb = b.tier == null ? 99 : b.tier;
        return ta - tb || a.classname.localeCompare(b.classname);
      });
    }

    function infoTable(items, withCheckboxes) {
      let h = '<table><thead><tr>' + (withCheckboxes ? '<th style="width:28px"></th>' : '')
        + COLS.map((c) => '<th>' + c[0] + '</th>').join('') + '</tr></thead><tbody>';
      for (const it of items) {
        h += '<tr>' + (withCheckboxes
          ? '<td><input type="checkbox" class="cmp" data-cn="' + esc(it.classname) + '" aria-label="Compare ' + esc(it.classname) + '"'
            + (state.selected.has(it.classname) ? ' checked' : '')
            + (state.selected.size >= 4 && !state.selected.has(it.classname) ? ' disabled' : '') + '></td>'
          : '')
          + COLS.map((c) => '<td>' + c[1](it) + '</td>').join('');
        h += '</tr>';
      }
      return h + '</tbody></table>';
    }

    function compareTable() {
      const sel = [...state.selected].map((cn) => state.data.items.find((i) => i.classname === cn)).filter(Boolean);
      if (sel.length < 2) return '<div class="empty"><h3>Compare</h3><p>Pick at least two items via the checkboxes in Info view (up to four).</p></div>';
      let h = '<table><thead><tr><th style="min-width:110px"></th>' + sel.map((it) => '<td class="compare-head">' + esc(it.name) + '<br><span class="classname">' + esc(it.classname) + '</span></td>').join('') + '</tr></thead><tbody>';
      for (const c of COLS) {
        if (c[0] === 'Item') continue; // repeated in the header
        h += '<tr><th>' + c[0] + '</th>' + sel.map((it) => '<td>' + c[1](it) + '</td>').join('') + '</tr>';
      }
      return h + '</tbody></table>';
    }

    function emptyState(cat) {
      const msg = cat === 'ammo'
        ? 'This server’s <code>types.xml</code> defines no ammo classes for ' + esc(state.data.map) + ' — if ammo ever stops spawning, this is where it shows up first.'
        : 'Nothing in this category on ' + esc(state.data.map) + '.';
      return '<div class="empty"><h3>' + (CATS.find((c) => c[0] === cat) || [cat, cat])[1] + ' — 0 items</h3><p>' + msg + '</p></div>';
    }

    // Loading / error state for the main content area (shared dzc kit).
    // `retryFn` (error only) re-runs the load; text is escaped once here.
    function renderState(kind, text, retryFn) {
      const content = $('content');
      if (kind === 'loading') {
        content.innerHTML = '<div class="dzc-empty"><span class="dzc-spinner" role="status" aria-label="Loading"></span>'
          + '<div class="dzc-empty-title">' + esc(text) + '</div></div>';
        return;
      }
      content.innerHTML = '<div class="dzc-empty"><div class="dzc-empty-title" style="color:var(--dzc-danger,#ef4444)">'
        + esc(text) + '</div><div style="margin-top:8px"><button type="button" class="dzc-btn is-primary" id="catalog-retry">Retry</button></div></div>';
      const b = $('catalog-retry');
      if (b && retryFn) b.addEventListener('click', retryFn);
    }

    function render() {
      const content = $('content');
      // Classname Finder result overrides the category view while a query is active.
      if (state.q) {
        const hits = ItemCatalog.searchCatalog(state.data.items, state.q);
        content.innerHTML = hits.length
          ? '<table><thead><tr><th>Item</th><th>Category</th><th>Tier</th><th>Nominal</th><th>Spawn damage</th></tr></thead><tbody>'
            + hits.slice(0, 200).map((it) => {
              const cat = state.buckets ? (state.buckets.weapons.includes(it) ? 'weapons' : state.buckets.ammo.includes(it) ? 'ammo' : state.buckets.armor.includes(it) ? 'armor' : state.buckets.vehicles.includes(it) ? 'vehicles' : 'other') : '—';
              return '<tr><td>' + esc(it.name) + '<br><span class="classname">' + esc(it.classname) + '</span></td><td><span class="cat-badge">' + esc(cat) + '</span></td><td>' + tierBadge(it) + '</td><td>' + (it.nominal ?? '—') + '</td><td>' + dmg(it) + '</td></tr>';
            }).join('')
            + '</tbody></table>' + (hits.length > 200 ? '<p class="fineprint">Showing first 200 of ' + hits.length + ' matches.</p>' : '')
          : '<div class="empty"><h3>No matches for “' + esc(state.q) + '”</h3><p>Search covers the full ' + state.data.count + '-item catalog on ' + esc(state.data.map) + ' by display name or classname.</p></div>';
        return;
      }
      const items = sortCat(state.buckets[state.cat] || []);
      content.innerHTML = items.length === 0
        ? emptyState(state.cat)
        : state.view === 'info' ? infoTable(items, true) : compareTable();
    }

    function renderTabs() {
      $('tabs').innerHTML = CATS.map(([key, label]) =>
        '<button class="tab' + (state.cat === key ? ' active' : '') + '" data-cat="' + key + '" type="button">'
        + label + ' <span style="opacity:.7">' + (state.buckets[key] ? state.buckets[key].length : '…') + '</span></button>').join('');
    }

    function syncViewButtons() {
      $('view-info').classList.toggle('active', state.view === 'info');
      $('view-compare').classList.toggle('active', state.view === 'compare');
      $('clear-compare').style.display = state.selected.size ? '' : 'none';
    }

    function refresh() {
      state.buckets = ItemCatalog.categorize(state.data.items);
      renderTabs();
      syncViewButtons();
      render();
    }

    async function loadMap(map) {
      renderState('loading', 'Loading catalog…');
      try {
        const [itemsRes, spawnRes] = await Promise.all([
          fetch('/data/' + map + '/items.json'),
          fetch('/data/' + map + '/spawnables.json'),
        ]);
        if (!itemsRes.ok) throw new Error('items.json: HTTP ' + itemsRes.status);
        state.data = await itemsRes.json();
        state.spawnables = spawnRes.ok ? (await spawnRes.json()).types : {};
        state.selected.clear();
        $('framing').innerHTML = 'What actually spawns on this server — <code>' + esc(state.data.map) + '</code> / <code>' + esc(state.data.event)
          + '</code>, extracted from this mission’s <code>types.xml</code> (' + state.data.count + ' item classes) + <code>cfgspawnabletypes.xml</code>; storage, insulation and description are vanilla cfg values. Nominal/tier are this server’s values, not vanilla defaults.';
        $('fineprint').innerHTML = 'Data: <code>data/' + esc(map) + '/items.json</code> + <code>spawnables.json</code> (regenerate with <code>node scripts/extract-dayz-data.js ' + esc(map) + '</code>). More maps: run the extractor on another event/map and add it to the select above.';
        refresh();
        return { ok: true };
      } catch (err) {
        // With a previously loaded catalog, restore the stale view (the
        // loading spinner replaced it above); the freshness row (dfh)
        // surfaces the error. First-load failure renders the in-content
        // error state with Retry.
        if (state.data) {
          refresh();
          return { ok: false, message: err.message };
        }
        // Retry routes through dfh when present so a successful retry records
        // the last-updated timestamp (the Refresh row alone would stay stale).
        renderState('error', 'Failed to load catalog for ' + map + ': ' + err.message,
          dfh ? dfh.run.bind(dfh) : () => loadMap(map));
        return { ok: false, message: err.message };
      }
    }

    $('tabs').addEventListener('click', (e) => {
      const t = e.target.closest('[data-cat]');
      if (!t) return;
      state.cat = t.dataset.cat;
      state.q = '';
      $('search').value = '';
      refresh();
    });
    $('view-info').addEventListener('click', () => { state.view = 'info'; syncViewButtons(); render(); });
    $('view-compare').addEventListener('click', () => { state.view = 'compare'; syncViewButtons(); render(); });
    $('clear-compare').addEventListener('click', () => { state.selected.clear(); refresh(); });
    $('content').addEventListener('change', (e) => {
      if (!e.target.classList.contains('cmp')) return;
      const cn = e.target.dataset.cn;
      if (e.target.checked) state.selected.add(cn); else state.selected.delete(cn);
      syncViewButtons();
      // Re-render Info to apply the 4-item cap without losing scroll position is acceptable: table is small.
      if (state.view === 'info') render();
    });
    $('search').addEventListener('input', (e) => { state.q = e.target.value; render(); });
    // Freshness indicator + Refresh (shared helper): wraps loadMap so every
    // fetch (initial, map switch, manual refresh) records last-success time.
    const dfh = window.DataFreshness
      ? DataFreshness.mount('catalog-freshness', async () => {
          const r = await loadMap($('map').value);
          if (!r.ok) throw new Error(r.message);
        }, { auto: false })
      : null;

    $('map').addEventListener('change', () => (dfh ? dfh.run() : loadMap($('map').value)));
    if (dfh) dfh.run(); else loadMap('nasdara');
