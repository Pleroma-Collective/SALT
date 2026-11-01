/*
 * DayZ Dashboard — Loot Finder Layer (merged map page)
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * The former standalone /loot-finder page, now a layer on /map. Item
 * search, filters, item detail, and per-item spawn markers render on the
 * shared Leaflet map owned by map.js; the server and map selects are
 * page-owned too (map.js drives them and calls onServerChange /
 * onMapChange here). The Live Loot Feed sub-block is admin-only —
 * enforced server-side at /api/loot/live as well.
 */
(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────

  // Canonical measured map geometry and world transforms.
  const MAP_CONFIGS = DayzMapCoordinates.MAP_DEFINITIONS;

  // Tier badge colors, matching the CSS tier-badge-* classes in map.html
  const TIER_COLORS = {
    Tier1: '#10b981',
    Tier2: '#3b82f6',
    Tier3: '#f97316',
    Tier4: '#ef4444',
  };
  const TIER_BADGE_CLASSES = {
    Tier1: 'tier-badge-Tier1',
    Tier2: 'tier-badge-Tier2',
    Tier3: 'tier-badge-Tier3',
    Tier4: 'tier-badge-Tier4',
  };
  const DEFAULT_MARKER_COLOR   = '#a855f7';
  // Dynamic event items (deloot=1) get a distinct amber marker so they're
  // visually distinguishable from static building loot on the map.
  const DYNAMIC_EVENT_COLOR = '#f59e0b';

  const SEARCH_DEBOUNCE_MS = 300;

  // ─── Module State ─────────────────────────────────────────────────────────

  let currentUser = null;
  let isAdmin = false;
  let currentMapName = 'chernarusplus';
  let currentServerId = null; // Nitrado platform server ID

  // Marker layer group on the shared map (created lazily on first use).
  let lootMarkerLayerGroup = null;

  // Search state
  let searchDebounceId = null;
  let currentSearchAbortController = null;
  let currentDetailAbortController = null;
  let selectedItemName = null;
  let lootContextGeneration = 0;
  let searchRequestId = 0;
  let liveRequestId = 0;
  let dfh = null; // DataFreshness handle (finder results)
  let lastSearchItems = null; // stale results kept visible if a refresh fails
  let initialized = false;

  // Cached DOM references — populated by cacheDomElements()
  const dom = {};

  function invalidateLootContext() {
    lootContextGeneration++;
    clearTimeout(searchDebounceId);
    searchDebounceId = null;
    if (currentSearchAbortController) currentSearchAbortController.abort();
    if (currentDetailAbortController) currentDetailAbortController.abort();
    currentSearchAbortController = null;
    currentDetailAbortController = null;
    return lootContextGeneration;
  }

  // ─── Utility Helpers ─────────────────────────────────────────────────────

  /**
   * Safely convert any value to a display string.
   * Allows 0 and false to render — only skips null/undefined.
   */
  function safeText(value, fallback = '') {
    if (value === null || value === undefined) return fallback;
    return String(value);
  }

  function escapeHtml(value, fallback = '') {
    return safeText(value, fallback).replace(/[&<>'"]/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    })[character]);
  }

  function getTierBadgeClass(value) {
    const tierKey = safeText(value);
    return Object.hasOwn(TIER_BADGE_CLASSES, tierKey)
      ? TIER_BADGE_CLASSES[tierKey]
      : 'bg-gray-700 text-gray-300';
  }

  /**
   * Safely extract a number. Returns fallback for NaN or non-numbers.
   * Ensures values like nominal=0 or healthPct=0 are rendered correctly.
   */
  function safeNumber(value, fallback = 0) {
    if (typeof value === 'number' && !Number.isNaN(value)) return value;
    const n = Number(value);
    return Number.isNaN(n) ? fallback : n;
  }

  /**
   * Remove all child nodes from a DOM element.
   */
  function clearElement(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  /**
   * Convert lifetime/restock seconds to a readable string.
   * Negative values (-1) display as "N/A"; 0 displays as "0s".
   */
  function formatSeconds(s) {
    const n = safeNumber(s, -1);
    if (n < 0) return 'N/A';
    if (n === 0) return '0s';
    if (n < 60) return `${n}s`;
    if (n < 3600) return `${Math.floor(n / 60)}m`;
    return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
  }

  /**
   * Format an ISO 8601 timestamp to a local time string.
   */
  function formatIsoTime(iso) {
    if (!iso) return 'Unknown';
    try {
      return new Date(iso).toLocaleTimeString();
    } catch {
      return 'Unknown';
    }
  }

  // ─── DOM Caching ──────────────────────────────────────────────────────────

  /**
   * Query all DOM elements once and store them in the dom object.
   * Returns false if any critical element is missing.
   */
  function cacheDomElements() {
    const ids = [
      'loot-search-input', 'loot-filter-category', 'loot-filter-usage', 'loot-filter-value',
      'loot-clear-filters', 'loot-result-count', 'loot-item-list', 'loot-item-detail',
      'btnFitMarkers', 'mapLegend',
      'liveRptFile', 'liveLastUpdated', 'btnRefreshLive',
      'liveHealthPct', 'liveHealthBar', 'liveTotalInMap', 'liveTotalNominal',
      'candidateTable', 'candidateCount', 'spawnFeed', 'spawnEventCount',
    ];

    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) {
        console.error(`[loot-layer] Missing required element: #${id}`);
        if (['loot-item-list', 'loot-item-detail'].includes(id)) return false;
      }
      // Store using camelCase key derived from the id
      const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      dom[key] = el;
    }

    return true;
  }

  // ─── Status / Error Helpers ───────────────────────────────────────────────

  function showFinderStatus(msg) {
    if (dom.lootResultCount) dom.lootResultCount.textContent = safeText(msg);
  }

  function showFinderError(msg) {
    if (dom.lootResultCount) dom.lootResultCount.textContent = '⚠ ' + safeText(msg);
  }

  function showLiveStatus(msg) {
    if (dom.liveLastUpdated) dom.liveLastUpdated.textContent = safeText(msg);
  }

  function showLiveError(msg) {
    if (dom.liveLastUpdated) dom.liveLastUpdated.textContent = '⚠ ' + safeText(msg);
  }

  /**
   * Render the item-list area in a loading or error state (real spinner +
   * optional Retry). renderItemList() replaces it on success; a 0-result
   * search renders its own empty message there. `text` is escaped once here.
   */
  function renderListState(kind, text, retryFn) {
    if (!dom.lootItemList) return;
    if (kind === 'loading') {
      dom.lootItemList.innerHTML = '<div class="dzc-empty"><span class="dzc-spinner" role="status" aria-label="Loading"></span>'
        + '<div class="dzc-empty-title">' + escapeHtml(text) + '</div></div>';
      return;
    }
    dom.lootItemList.innerHTML = '<div class="dzc-empty">'
      + '<div class="dzc-empty-title" style="color:var(--dzc-danger,#ef4444)">' + escapeHtml(text) + '</div>'
      + '<div style="padding:12px 0"><button type="button" class="dzc-btn is-primary" id="loot-retry">Retry</button></div></div>';
    if (retryFn) {
      const btn = document.getElementById('loot-retry');
      if (btn) btn.addEventListener('click', () => retryFn());
    }
  }

  // ─── API Wrappers ─────────────────────────────────────────────────────────

  /**
   * Generic fetch helper. Checks HTTP status and parses JSON.
   * Throws a descriptive Error on failure.
   */
  async function fetchJson(url, options = {}) {
    const res = await fetch(url, { credentials: 'same-origin', ...options });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(`Invalid JSON response from ${url}`);
    }
    return body;
  }

  /**
   * Load the current user. Redirects to / on auth failure.
   * Sets isAdmin strictly: only true when user.isAdmin === true.
   */
  async function loadCurrentUser() {
    let data;
    try {
      data = await fetchJson('/api/user');
    } catch {
      window.location.href = '/';
      return;
    }

    if (!data || !data.username) {
      window.location.href = '/';
      return;
    }

    currentUser = data;
    isAdmin = (data.isAdmin === true);

    // Reveal the admin-only live feed block
    if (isAdmin) {
      document.querySelectorAll('[data-admin-only]').forEach(el => {
        el.classList.remove('hidden');
        el.hidden = false;
      });
      refreshLivePanel();
    }
  }

  /**
   * Load filter dropdown options for a map on the selected server.
   * Gracefully handles empty arrays and API errors.
   */
  async function loadCategories(mapName, generation) {
    if (!currentServerId) return;
    let data;
    try {
      data = await fetchJson(`/api/loot/categories?serverId=${encodeURIComponent(currentServerId)}&map=${encodeURIComponent(mapName)}`);
    } catch (err) {
      if (generation !== lootContextGeneration || mapName !== currentMapName) return;
      showFinderError(`Failed to load filters: ${err.message}`);
      renderListState('error', `Failed to load filters: ${err.message}`, () => triggerSearch());
      return;
    }

    if (generation !== lootContextGeneration || mapName !== currentMapName) return;

    if (!data || data.ok === false) {
      const errMsg = `Failed to load filters: ${safeText(data && data.error, 'Unknown error')}`;
      showFinderError(errMsg);
      renderListState('error', errMsg, () => triggerSearch());
      return;
    }

    populateSelect(dom.lootFilterCategory, data.categories || [], 'All categories');
    populateSelect(dom.lootFilterUsage,    data.usages      || [], 'All zones');
    populateSelect(dom.lootFilterValue,    data.values      || [], 'All tiers');
  }

  /**
   * Populate a <select> with an array of string values.
   * Always prepends an "All" option.
   */
  function populateSelect(selectEl, items, allLabel) {
    if (!selectEl) return;
    clearElement(selectEl);
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = allLabel;
    selectEl.appendChild(defaultOpt);

    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item;
      opt.textContent = item;
      selectEl.appendChild(opt);
    }
  }

  /**
   * Search items with current filters. Uses AbortController to cancel stale requests.
   * Returns { count, items } or throws (AbortError is rethrown for caller to ignore).
   */
  async function searchItems(mapName, q, category, usage, value) {
    // Cancel any in-flight search
    if (currentSearchAbortController) {
      currentSearchAbortController.abort();
    }
    currentSearchAbortController = new AbortController();

    const params = new URLSearchParams({ map: mapName, limit: '150' });
    if (currentServerId) params.set('serverId', currentServerId);
    if (q)        params.set('q', q);
    if (category) params.set('category', category);
    if (usage)    params.set('usage', usage);
    if (value)    params.set('value', value);

    const data = await fetchJson(`/api/loot/search?${params}`, {
      signal: currentSearchAbortController.signal,
    });

    if (data.ok === false) {
      throw new Error(safeText(data.error, 'Search failed'));
    }

    return {
      count: safeNumber(data.count, 0),
      items: Array.isArray(data.items) ? data.items : [],
    };
  }

  /**
   * Load full detail for a single item by name.
   */
  async function loadItemDetail(mapName, itemName, signal) {
    const params = new URLSearchParams({ map: mapName });
    if (currentServerId) params.set('serverId', currentServerId);
    const data = await fetchJson(
      `/api/loot/item/${encodeURIComponent(itemName)}?${params}`,
      { signal }
    );

    if (data.ok === false) {
      throw new Error(safeText(data.error, 'Item not found'));
    }

    if (!data.item) {
      throw new Error('Invalid item response from server');
    }

    return data.item;
  }

  /**
   * Load live loot data (admin only).
   * Normalizes missing/null fields to safe defaults.
   */
  async function loadLiveData(mapName, serverId) {
    const data = await fetchJson(`/api/loot/live?serverId=${encodeURIComponent(serverId)}&map=${encodeURIComponent(mapName)}`);

    if (data.ok === false) {
      throw new Error(safeText(data.error, 'Failed to load live data'));
    }

    return {
      candidates:    Array.isArray(data.candidates)  ? data.candidates  : [],
      recentAdds:    Array.isArray(data.recentAdds)  ? data.recentAdds  : [],
      economyHealth: data.economyHealth || null,
      lastUpdated:   data.lastUpdated   || null,
      rptFile:       data.rptFile       || null,
      error:         data.error         || null,
    };
  }

  // ─── Map Functions ────────────────────────────────────────────────────────

  /**
   * Convert DayZ game coords (meters) to a Leaflet [lat, lng] point.
   * In L.CRS.Simple: lat = z-axis (north), lng = x-axis (east).
   */
  function gameToLeaflet(gameX, gameZ, mapName) {
    return DayzMapCoordinates.worldToLeaflet({ east: gameX, north: gameZ }, mapName);
  }

  /**
   * The shared Leaflet instance owned by map.js (top-level `map`). Only
   * reachable after map.js has initialized — every call site runs then.
   */
  function sharedMap() {
    return typeof map === 'undefined' ? null : map;
  }

  function ensureLootMarkerLayer() {
    const m = sharedMap();
    if (!m) return null;
    if (!lootMarkerLayerGroup) {
      lootMarkerLayerGroup = L.layerGroup().addTo(m);
    } else if (!m.hasLayer(lootMarkerLayerGroup)) {
      lootMarkerLayerGroup.addTo(m);
    }
    return lootMarkerLayerGroup;
  }

  /**
   * Switch the layer to a new map name: invalidate pending work, clear
   * markers. Tiles and view are owned by map.js's initMap().
   */
  function resetMapForMapName(mapName) {
    invalidateLootContext();
    currentMapName = mapName;

    if (lootMarkerLayerGroup) lootMarkerLayerGroup.clearLayers();
    if (dom.mapLegend) dom.mapLegend.style.display = 'none';
  }

  /**
   * Plot spawn points for the selected item as circle markers on the map.
   * Clears previous markers first. Hides legend if no spawn points.
   */
  function renderSpawnMarkersForItem(item) {
    const group = ensureLootMarkerLayer();
    if (!group) return;

    group.clearLayers();

    if (!item || !Array.isArray(item.spawnPoints) || item.spawnPoints.length === 0) {
      if (dom.mapLegend) dom.mapLegend.style.display = 'none';
      return;
    }

    // Dynamic event items get a distinct amber color; static loot uses tier color.
    const tierColor = item.isDynamicEvent
      ? DYNAMIC_EVENT_COLOR
      : (item.values && item.values[0])
        ? (TIER_COLORS[item.values[0]] || DEFAULT_MARKER_COLOR)
        : DEFAULT_MARKER_COLOR;

    const popupLabel = item.isDynamicEvent ? 'Dynamic Event Loot' : 'Static Loot';

    for (const sp of item.spawnPoints) {
      const latlng = gameToLeaflet(sp.x, sp.z, currentMapName);
      L.circleMarker(latlng, {
        radius: 5,
        color: tierColor,
        fillColor: tierColor,
        fillOpacity: 0.7,
        weight: 1,
      })
      .bindPopup(`<b>${escapeHtml(item.name)}</b><br><i>${popupLabel}</i><br>x: ${safeNumber(sp.x, 0)}, z: ${safeNumber(sp.z, 0)}`)
      .addTo(group);
    }

    if (dom.mapLegend) dom.mapLegend.style.display = '';
  }

  /**
   * Fit the map view to all current spawn markers.
   */
  function fitMapToMarkers() {
    const m = sharedMap();
    if (!m || !lootMarkerLayerGroup) return;
    if (lootMarkerLayerGroup.getLayers().length === 0) {
      showFinderStatus('No spawn markers to fit.');
      return;
    }
    try {
      const bounds = lootMarkerLayerGroup.getBounds();
      if (bounds.isValid()) m.fitBounds(bounds, { padding: [20, 20] });
    } catch (err) {
      console.error('[loot-layer] fitMapToMarkers error:', err);
    }
  }

  // ─── Item Finder UI ───────────────────────────────────────────────────────

  /**
   * Render item search results as clickable cards in the item list.
   * Uses safeNumber for all numeric fields so 0 renders correctly.
   */
  function renderItemList(items) {
    clearElement(dom.lootItemList);

    if (!Array.isArray(items) || items.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'loot-empty';
      msg.textContent = 'No items match your search and filters.';
      dom.lootItemList.appendChild(msg);
      showFinderStatus('0 items found');
      if (lootMarkerLayerGroup) lootMarkerLayerGroup.clearLayers();
      if (dom.mapLegend) dom.mapLegend.style.display = 'none';
      return;
    }

    showFinderStatus(`${items.length} item${items.length !== 1 ? 's' : ''} found`);

    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'loot-item-card' + (item.name === selectedItemName ? ' is-selected' : '');

      // Tier badges
      const tierBadges = (item.values || []).map(v => {
        const tierClass = getTierBadgeClass(v);
        return `<span class="${tierClass} text-xs px-1.5 py-0.5 rounded font-semibold mr-1">${escapeHtml(v)}</span>`;
      }).join('');

      // Category text
      const cats = (item.category || []).join(', ') || '—';

      card.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <span class="font-medium text-sm truncate">${escapeHtml(item.name)}</span>
        <span class="text-xs whitespace-nowrap" style="color:var(--dzc-text-muted)">×${safeNumber(item.nominal, 0)}</span>
      </div>
      <div class="mt-1 flex flex-wrap items-center gap-1">
        ${tierBadges}
        <span class="text-xs" style="color:var(--dzc-text-faint)">${escapeHtml(cats)}</span>
      </div>`;

      card.addEventListener('click', () => onItemCardClicked(item, card));
      dom.lootItemList.appendChild(card);
    }
  }

  /**
   * Handle click on an item card: select it, fetch full detail, render map markers.
   */
  async function onItemCardClicked(item, cardEl) {
    if (!item || !item.name) return;

    // Update selection visual state
    dom.lootItemList.querySelectorAll('.loot-item-card.is-selected').forEach(el => el.classList.remove('is-selected'));
    cardEl.classList.add('is-selected');
    selectedItemName = item.name;

    // Optimistic: show basic info from search result immediately
    renderItemDetailBasic(item);

    // Fetch full detail (includes all spawn points)
    const mapName = currentMapName;
    const generation = lootContextGeneration;
    if (currentDetailAbortController) currentDetailAbortController.abort();
    const detailAbortController = new AbortController();
    currentDetailAbortController = detailAbortController;
    try {
      const fullItem = await loadItemDetail(mapName, item.name, detailAbortController.signal);
      if (generation !== lootContextGeneration || mapName !== currentMapName ||
          selectedItemName !== item.name) return;
      renderItemDetailFull(fullItem);
      renderSpawnMarkersForItem(fullItem);
      if (fullItem.spawnPoints && fullItem.spawnPoints.length > 0) {
        fitMapToMarkers();
      }
    } catch (err) {
      if (err.name === 'AbortError' || generation !== lootContextGeneration ||
          mapName !== currentMapName || selectedItemName !== item.name) return;
      // Keep the basic detail visible; just show the error below it
      const errEl = document.createElement('div');
      errEl.className = 'loot-detail-error';
      errEl.textContent = '⚠ ' + safeText(err.message, 'Failed to load full item detail');
      dom.lootItemDetail.appendChild(errEl);
    }
  }

  /**
   * Render a placeholder detail panel with the subset of data from search results.
   */
  function renderItemDetailBasic(item) {
    dom.lootItemDetail.innerHTML = `
    <div class="text-xs mb-3" style="color:var(--dzc-text-muted)">Loading full details…</div>
    <h3 class="font-bold mb-2" style="font-size:0.95rem;">${escapeHtml(item.name)}</h3>
    <div class="loot-detail-grid">
      <div><span class="loot-detail-label">Nominal</span><div class="font-semibold">${safeNumber(item.nominal, 0)}</div></div>
      <div><span class="loot-detail-label">Min</span><div class="font-semibold">${safeNumber(item.min, 0)}</div></div>
      <div><span class="loot-detail-label">Spawns</span><div class="font-semibold">${safeNumber(item.spawnCount, 0)}</div></div>
    </div>`;
  }

  /**
   * Render the full item detail panel including all stats from the /item/:name endpoint.
   */
  function renderItemDetailFull(item) {
    const quantMin = safeNumber(item.quantmin, -1);
    const quantMax = safeNumber(item.quantmax, -1);
    const quantDisplay = (quantMin === -1 && quantMax === -1)
      ? 'Unlimited'
      : `${quantMin === -1 ? '∞' : quantMin} – ${quantMax === -1 ? '∞' : quantMax}`;

    const tierBadges = (item.values || []).map(v => {
      const tierClass = getTierBadgeClass(v);
      return `<span class="${tierClass} text-xs px-1.5 py-0.5 rounded font-semibold mr-1">${escapeHtml(v)}</span>`;
    }).join('') || '<span class="text-xs" style="color:var(--dzc-text-faint)">No tier</span>';

    const usageText = (item.usages || []).join(', ') || '—';
    const categoryText = (item.category || []).join(', ') || '—';
    const tagText = (item.tags || []).join(', ') || '—';

    dom.lootItemDetail.innerHTML = `
    <h3 class="font-bold mb-1" style="font-size:0.95rem;">${escapeHtml(item.name)}</h3>
    <div class="flex flex-wrap gap-1 mb-3">${tierBadges}</div>

    <div class="space-y-3 text-sm">
      <div class="loot-detail-grid">
        <div><div class="loot-detail-label">Nominal</div><div class="font-semibold">${safeNumber(item.nominal, 0)}</div></div>
        <div><div class="loot-detail-label">Min</div><div class="font-semibold">${safeNumber(item.min, 0)}</div></div>
        <div><div class="loot-detail-label">Lifetime</div><div class="font-semibold">${formatSeconds(item.lifetime)}</div></div>
        <div><div class="loot-detail-label">Restock</div><div class="font-semibold">${formatSeconds(item.restock)}</div></div>
        <div><div class="loot-detail-label">Quantity</div><div class="font-semibold">${quantDisplay}</div></div>
        <div><div class="loot-detail-label">Spawn pts</div><div class="font-semibold">${safeNumber(item.spawnCount, 0)}</div></div>
      </div>

      <div>
        <div class="loot-detail-label">Category</div>
        <div>${escapeHtml(categoryText)}</div>
      </div>
      <div>
        <div class="loot-detail-label">Usage Zones</div>
        <div>${escapeHtml(usageText)}</div>
      </div>
      ${tagText !== '—' ? `<div>
        <div class="loot-detail-label">Tags</div>
        <div>${escapeHtml(tagText)}</div>
      </div>` : ''}
    </div>`;
  }

  /**
   * Reset item detail panel to the default empty state.
   */
  function renderEmptyItemDetail() {
    dom.lootItemDetail.innerHTML = `
    <div class="text-center mt-4" style="color:var(--dzc-text-faint)">
      <div class="text-3xl mb-2">🎒</div>
      <p class="text-sm" style="margin:0;">Select an item to view details and spawn locations on the map</p>
    </div>`;
  }

  /**
   * Clear all finder UI derived from the selected server and terrain.
   * Called synchronously before discovery/category requests can yield.
   */
  function clearLootContextUi() {
    selectedItemName = null;
    lastSearchItems = null;
    if (dfh) dfh.reset();
    clearElement(dom.lootItemList);
    renderEmptyItemDetail();
    if (lootMarkerLayerGroup) lootMarkerLayerGroup.clearLayers();
    if (dom.mapLegend) dom.mapLegend.style.display = 'none';
    populateSelect(dom.lootFilterCategory, [], 'All categories');
    populateSelect(dom.lootFilterUsage, [], 'All zones');
    populateSelect(dom.lootFilterValue, [], 'All tiers');
    showFinderStatus('Loading…');
    renderListState('loading', 'Loading loot data…');
  }

  // ─── Search Handler ───────────────────────────────────────────────────────

  /**
   * Triggered on any filter change or search input event.
   * Debounces 300ms before firing the search request.
   */
  function handleSearchInputChange() {
    clearTimeout(searchDebounceId);
    searchDebounceId = setTimeout(triggerSearch, SEARCH_DEBOUNCE_MS);
  }

  /**
   * Run a search with current filter values and render the results.
   * On server error (5xx), shows a user-friendly message with a retry hint.
   * Returns { ok, message? } so the DataFreshness wrapper can surface failures.
   */
  async function triggerSearch() {
    const q        = (dom.lootSearchInput     && dom.lootSearchInput.value.trim())     || '';
    const category = (dom.lootFilterCategory  && dom.lootFilterCategory.value)         || '';
    const usage    = (dom.lootFilterUsage     && dom.lootFilterUsage.value)            || '';
    const value    = (dom.lootFilterValue     && dom.lootFilterValue.value)            || '';

    showFinderStatus('Searching…');
    renderListState('loading', 'Searching…');
    const mapName = currentMapName;
    const generation = lootContextGeneration;
    const requestId = ++searchRequestId;

    try {
      const { items } = await searchItems(mapName, q, category, usage, value);
      if (requestId !== searchRequestId || generation !== lootContextGeneration ||
          mapName !== currentMapName) return { ok: true };
      renderItemList(items);
      lastSearchItems = items;
      if (dfh) dfh.markSuccess();
      return { ok: true };
    } catch (err) {
      if (err.name === 'AbortError' || requestId !== searchRequestId ||
          generation !== lootContextGeneration ||
          mapName !== currentMapName) return { ok: true };

      // Server errors (5xx) — factual message + a Retry control (never a
      // "please wait and try again" with no way to act). With previously
      // rendered results, keep the stale list visible and surface the error in
      // the result-count + freshness row; first-search failure renders the
      // in-list error state with Retry.
      const is500 = !!(err.message && err.message.includes('500'));
      const msg = is500
        ? 'Loot data request failed (HTTP 500). The server may still be loading — click Retry to try again.'
        : (err.message || 'Search failed');
      showFinderError(msg);
      if (lastSearchItems) {
        renderItemList(lastSearchItems);
      } else {
        renderListState('error', msg, triggerSearch);
      }
      if (dfh) dfh.markError(msg);
      return { ok: false, message: msg };
    }
  }

  /**
   * Clear all search inputs and filters, then re-trigger a search.
   */
  function handleClearFiltersClick() {
    if (dom.lootSearchInput)    dom.lootSearchInput.value    = '';
    if (dom.lootFilterCategory) dom.lootFilterCategory.value = '';
    if (dom.lootFilterUsage)    dom.lootFilterUsage.value    = '';
    if (dom.lootFilterValue)    dom.lootFilterValue.value    = '';

    selectedItemName = null;
    renderEmptyItemDetail();
    if (lootMarkerLayerGroup) lootMarkerLayerGroup.clearLayers();
    if (dom.mapLegend) dom.mapLegend.style.display = 'none';

    handleSearchInputChange();
  }

  // ─── Live Feed UI ─────────────────────────────────────────────────────────

  /**
   * Render the economy health bar and summary numbers.
   * Handles null economyHealth gracefully (RPT file not found).
   */
  function renderLiveEconomyHealth(economyHealth) {
    if (!economyHealth) {
      if (dom.liveHealthPct)    dom.liveHealthPct.textContent   = 'No data';
      if (dom.liveHealthBar)    dom.liveHealthBar.style.width    = '0%';
      if (dom.liveTotalInMap)   dom.liveTotalInMap.textContent   = '—';
      if (dom.liveTotalNominal) dom.liveTotalNominal.textContent = '—';
      return;
    }

    const pct = Math.min(100, Math.max(0, safeNumber(economyHealth.healthPct, 0)));

    if (dom.liveHealthPct) dom.liveHealthPct.textContent = `${pct}%`;
    if (dom.liveHealthBar) {
      dom.liveHealthBar.style.width = `${pct}%`;
      // Color the bar based on health level
      if (pct >= 70) {
        dom.liveHealthBar.style.background = '#10b981'; // green
      } else if (pct >= 40) {
        dom.liveHealthBar.style.background = '#f59e0b'; // yellow
      } else {
        dom.liveHealthBar.style.background = '#ef4444'; // red
      }
    }
    if (dom.liveTotalInMap)   dom.liveTotalInMap.textContent   = safeText(economyHealth.totalInMap,  '0');
    if (dom.liveTotalNominal) dom.liveTotalNominal.textContent = safeText(economyHealth.nominal, '0');
  }

  /**
   * Render the "items below nominal" table.
   * All numeric cells use safeNumber so 0 counts display correctly.
   */
  function renderLiveCandidates(candidates) {
    clearElement(dom.candidateTable);

    if (!Array.isArray(candidates) || candidates.length === 0) {
      if (dom.candidateCount) dom.candidateCount.textContent = '0 items below nominal';
      const row = dom.candidateTable.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 5;
      cell.className = 'loot-live-empty';
      cell.textContent = 'No items below nominal.';
      return;
    }

    if (dom.candidateCount) {
      dom.candidateCount.textContent = `${candidates.length} item${candidates.length !== 1 ? 's' : ''} below nominal`;
    }

    for (const c of candidates) {
      const row = dom.candidateTable.insertRow();

      const healthPct = safeNumber(c.healthPct, 0);
      const healthColor = healthPct >= 70 ? '#10b981' : healthPct >= 40 ? '#f59e0b' : '#ef4444';

      row.innerHTML = `
      <td class="loot-live-cell font-mono">${escapeHtml(c.item)}</td>
      <td class="loot-live-cell text-right">${safeNumber(c.current, 0)}</td>
      <td class="loot-live-cell text-right">${safeNumber(c.nominal, 0)}</td>
      <td class="loot-live-cell text-right" style="color:var(--dzc-danger)">${safeNumber(c.missing, 0)}</td>
      <td class="loot-live-cell text-right font-semibold" style="color:${healthColor}">${healthPct}%</td>`;
    }
  }

  /**
   * Render the recent spawn events feed.
   */
  function renderLiveSpawnFeed(recentAdds) {
    clearElement(dom.spawnFeed);

    if (!Array.isArray(recentAdds) || recentAdds.length === 0) {
      if (dom.spawnEventCount) dom.spawnEventCount.textContent = '0 recent events';
      const msg = document.createElement('div');
      msg.className = 'loot-live-empty';
      msg.textContent = 'No recent spawn events found in log.';
      dom.spawnFeed.appendChild(msg);
      return;
    }

    if (dom.spawnEventCount) {
      dom.spawnEventCount.textContent = `${recentAdds.length} event${recentAdds.length !== 1 ? 's' : ''}`;
    }

    // Show most recent events at the top
    for (const evt of [...recentAdds].reverse()) {
      const el = document.createElement('div');
      el.className = 'loot-live-row';
      el.innerHTML = `
      <span class="font-mono" style="color:var(--dzc-text)">${escapeHtml(evt.item)}</span>
      <span style="color:var(--dzc-text-muted)">${safeNumber(evt.x, 0)}, ${safeNumber(evt.z, 0)}</span>
      <span style="color:var(--dzc-text-faint)">${escapeHtml(evt.timestamp, '')}</span>`;
      dom.spawnFeed.appendChild(el);
    }
  }

  /** Clear live-panel values belonging to the previous server or terrain. */
  function clearLiveContextUi() {
    if (dom.liveRptFile) dom.liveRptFile.textContent = '';
    if (dom.liveLastUpdated) dom.liveLastUpdated.textContent = '';
    renderLiveEconomyHealth(null);
    renderLiveCandidates([]);
    renderLiveSpawnFeed([]);
    showLiveStatus('Waiting for current server data…');
  }

  /**
   * Fetch and render live loot data. Guards against non-admin access.
   */
  async function refreshLivePanel() {
    if (!isAdmin || !currentServerId) return;

    showLiveStatus('Loading live loot data…');
    if (dom.liveRptFile) dom.liveRptFile.textContent = '';
    const mapName = currentMapName;
    const serverId = currentServerId;
    const generation = lootContextGeneration;
    const requestId = ++liveRequestId;

    try {
      const data = await loadLiveData(mapName, serverId);
      if (requestId !== liveRequestId || generation !== lootContextGeneration ||
          mapName !== currentMapName || serverId !== currentServerId) return;

      if (dom.liveRptFile) dom.liveRptFile.textContent = safeText(data.rptFile, 'No RPT file');
      if (dom.liveLastUpdated) {
        dom.liveLastUpdated.textContent = `Last updated: ${formatIsoTime(data.lastUpdated)}`;
      }

      renderLiveEconomyHealth(data.economyHealth);
      renderLiveCandidates(data.candidates);
      renderLiveSpawnFeed(data.recentAdds);

      // Show a warning if the API returned a partial error (e.g. no RPT found) but still responded
      if (data.error) {
        showLiveError(data.error);
      }
    } catch (err) {
      if (requestId !== liveRequestId || generation !== lootContextGeneration ||
          mapName !== currentMapName || serverId !== currentServerId) return;
      // Keep the stale live data visible; surface the error in the status line.
      showLiveError(err.message || 'Failed to load live data');
    }
  }

  // ─── Page Hooks (driven by map.js) ────────────────────────────────────────

  /**
   * The map select is page-owned. The server's configured map (Nitrado active
   * mission) is preferred over the first available mission directory;
   * non-moderators get a 403 here and fall back to the catalog.
   */
  async function configuredMapFor(serverId) {
    try {
      const active = await fetchJson(`/api/server-active-mission/${encodeURIComponent(serverId)}`);
      return active && active.mapName ? active.mapName : null;
    } catch (err) {
      console.warn('[loot-layer] Could not load active mission:', err.message);
      return null;
    }
  }

  /**
   * Server selection changed on the page: drop stale loot state. map.js
   * resolves the map list next and calls onMapChange when it settles.
   */
  function onServerChange(serverId) {
    invalidateLootContext();
    currentServerId = serverId || null;
    clearLootContextUi();
    clearLiveContextUi();
  }

  /**
   * Map selection settled on the page: repoint the layer at the new terrain,
   * reload the category filters, and fire the initial search.
   */
  async function onMapChange(mapName) {
    if (!mapName) return;
    resetMapForMapName(mapName);
    const generation = lootContextGeneration;
    clearLootContextUi();
    clearLiveContextUi();
    showFinderStatus('Loading filters…');

    await loadCategories(mapName, generation);
    if (generation !== lootContextGeneration || mapName !== currentMapName) return;

    // Re-populate the item list for the new map
    triggerSearch();

    if (isAdmin) {
      refreshLivePanel();
    }
  }

  // ─── Event Wiring ─────────────────────────────────────────────────────────

  function attachEventListeners() {
    dom.lootSearchInput.addEventListener('input', handleSearchInputChange);
    dom.lootFilterCategory.addEventListener('change', handleSearchInputChange);
    dom.lootFilterUsage.addEventListener('change', handleSearchInputChange);
    dom.lootFilterValue.addEventListener('change', handleSearchInputChange);
    dom.lootClearFilters.addEventListener('click', handleClearFiltersClick);
    dom.btnFitMarkers.addEventListener('click', fitMapToMarkers);
    dom.btnRefreshLive.addEventListener('click', refreshLivePanel);
  }

  // ─── Initialization ───────────────────────────────────────────────────────

  /**
   * Main entry point — called by map.js after the shared map exists.
   * Steps run in order; auth failure aborts remaining steps.
   */
  async function init() {
    if (initialized) return;
    initialized = true;

    if (!cacheDomElements()) {
      console.error('[loot-layer] Critical DOM elements missing — aborting initialization.');
      return;
    }

    attachEventListeners();

    // Freshness indicator + Refresh for the finder results. Re-runs the
    // current search (same filters) on click.
    if (window.DataFreshness) {
      dfh = DataFreshness.mount('loot-freshness', async () => {
        const r = await triggerSearch();
        if (r && r.ok === false) throw new Error(r.message);
      }, { auto: false });
    }

    // Authenticate; redirect to / if not logged in
    await loadCurrentUser();
    if (!currentUser) return;
  }

  window.MapLootLayer = {
    init: init,
    onServerChange: onServerChange,
    onMapChange: onMapChange,
    configuredMapFor: configuredMapFor,
    // Exposed for the hermetic XSS-sink regression test (render-path check)
    cacheDomElements: cacheDomElements,
    renderItemList: renderItemList,
    renderItemDetailFull: renderItemDetailFull,
  };
})();
