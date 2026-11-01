'use strict';
/* global document, L, DayzMapCoordinates, fetchWithCsrf, alert, confirm */

// Faction War admin map — place/clear flags, watch settlement claims.
// Boundary radii + thresholds come from the API (services/factionClaimService
// keeps the single source of truth; the client only draws).
// All user-controlled values are escaped with esc() before insertion, so the
// innerHTML is safe (house convention shared with admin-zones.js).
const state = {
  serverId: null,
  mapName: 'nasdara',
  settlements: [],
  factions: [],
  flags: [],
  claimBySettlement: new Map(),
};

let map = null;
const layerGroups = { boundaries: null, claims: null, flags: null };

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function factionColor(factionId) {
  const hue = ((Number(factionId) || 0) * 137.508) % 360;
  return `hsl(${Math.round(hue)}, 72%, 52%)`;
}

function parseJson(res) {
  return res.json().catch(() => ({})).then(data => {
    if (!res.ok) throw new Error((data && (data.error || data.message)) || `Request failed (${res.status})`);
    return data;
  });
}

function showFormError(msg) {
  const el = document.getElementById('formError');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

/* ── Servers ──────────────────────────────────────────────────────────────── */

async function initServers() {
  const select = document.getElementById('serverSelect');
  const data = await parseJson(await fetch('/api/admin/servers'));
  const servers = data.servers || [];
  if (!servers.length) {
    select.innerHTML = '<option value="">No servers found</option>';
    return;
  }
  select.innerHTML = servers.map(s =>
    `<option value="${esc(s.id)}">${esc(s.name || s.server_name || `Server ${s.id}`)} · ${esc(s.guildName || '—')}</option>`
  ).join('');
  select.addEventListener('change', e => selectServer(e.target.value || null));
}

function selectServer(serverId) {
  state.serverId = serverId ? Number(serverId) : null;
  document.getElementById('fw-stage').classList.toggle('hidden', !state.serverId);
  document.getElementById('empty-state').classList.toggle('hidden', !!state.serverId);
  if (state.serverId) {
    initMap(state.mapName);
    loadWarState();
  }
}

/* ── Map ─────────────────────────────────────────────────────────────────── */

function mapConfigFor(mapName) {
  const cfg = DayzMapCoordinates.getMapDefinition(mapName);
  return {
    contentWidth: cfg.contentWidth,
    contentHeight: cfg.contentHeight,
    gridSize: cfg.gridSize,
    physicalSize: cfg.physicalSize || 512,
    advancement: cfg.advancement || 480,
  };
}

function gameToLeaflet(east, north, mapName) {
  return DayzMapCoordinates.worldToLeaflet({ east, north }, mapName);
}

function initMap(mapName) {
  state.mapName = mapName;
  document.getElementById('fwMapLabel').textContent = `Map: ${mapName}`;
  if (map) { map.remove(); map = null; }
  for (const key of Object.keys(layerGroups)) layerGroups[key] = null;

  const cfg = mapConfigFor(mapName);
  map = L.map('fwMap', {
    crs: L.CRS.Simple,
    minZoom: -2,
    maxZoom: 3,
    center: [cfg.contentHeight / 2, cfg.contentWidth / 2],
    zoom: -1,
    zoomControl: true,
    attributionControl: false,
  });
  const bounds = L.latLngBounds([[0, 0], [cfg.contentWidth, cfg.contentHeight]]);
  map.setMaxBounds(bounds.pad(0.5));
  map.fitBounds(bounds);

  const TILE_ERR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  for (let y = 0; y < cfg.gridSize; y++) {
    for (let x = 0; x < cfg.gridSize; x++) {
      const flippedY = (cfg.gridSize - 1) - y;
      const tileBounds = L.latLngBounds([
        [y * cfg.advancement, x * cfg.advancement],
        [y * cfg.advancement + cfg.physicalSize, x * cfg.advancement + cfg.physicalSize],
      ]);
      const tileUrl = `/maps/${mapName}/tiles/${x}/${flippedY}.png`;
      L.imageOverlay(tileUrl, tileBounds, { interactive: false, errorOverlayUrl: TILE_ERR }).addTo(map);
    }
  }

  map.on('click', onMapClick);
  setTimeout(() => map.invalidateSize(), 50);
}

function onMapClick(e) {
  // Exact-position flag: fill the settlement select from what the point is in.
  const w = DayzMapCoordinates.leafletToWorld({ lat: e.latlng.lat, lng: e.latlng.lng }, state.mapName);
  const east = Math.round(w.east);
  const north = Math.round(w.north);
  const inSettlement = state.settlements.find(s => {
    const dx = east - s.east, dz = north - s.north;
    return dx * dx + dz * dz <= s.boundary_radius_m * s.boundary_radius_m;
  });
  const select = document.getElementById('flagSettlement');
  select.value = inSettlement ? inSettlement.id : '__point__';
  select.dataset.pointEast = east;
  select.dataset.pointNorth = north;
  updatePreviewCircle(east, north, inSettlement);
}

let previewCircle = null;
function updatePreviewCircle(east, north, inSettlement) {
  if (!map) return;
  if (previewCircle) { map.removeLayer(previewCircle); previewCircle = null; }
  const scale = DayzMapCoordinates.pixelsPerWorldUnit(state.mapName);
  const radius = inSettlement
    ? inSettlement.boundary_radius_m
    : Number(document.getElementById('flagRadius').value) || 100;
  previewCircle = L.circle(gameToLeaflet(east, north, state.mapName), {
    radius: radius * scale,
    color: '#f59e0b', fillColor: '#f59e0b',
    fillOpacity: 0.1, weight: 2, dashArray: '6 5', interactive: false,
  }).addTo(map);
}

/* ── War state ───────────────────────────────────────────────────────────── */

async function loadWarState() {
  if (!state.serverId) return;
  try {
    const data = await parseJson(await fetch(`/api/admin/faction-war/${state.serverId}?map=${state.mapName}`));
    state.settlements = data.settlements || [];
    state.factions = data.factions || [];
    state.flags = data.flags || [];
    state.claimBySettlement = new Map();
    for (const s of state.settlements) {
      if (s.claim) state.claimBySettlement.set(s.id, s.claim);
    }
    renderFactionOptions();
    renderSettlementOptions();
    renderSettlementList();
    renderClaimList();
    renderFlagList();
    redrawLayers();
  } catch (error) {
    showFormError(error.message);
  }
}

function renderFactionOptions() {
  const select = document.getElementById('flagFaction');
  select.innerHTML = `<option value="">— select a faction —</option>` +
    state.factions.map(f => `<option value="${esc(f.id)}">${esc(f.emblem)} ${esc(f.name)} [${esc(f.tag)}]</option>`).join('');
}

function renderSettlementOptions() {
  const select = document.getElementById('flagSettlement');
  select.innerHTML = '<option value="">— click the map instead —</option>' +
    state.settlements
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(s => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.kind)}, needs ${s.flags_needed})</option>`).join('');
}

function renderClaimList() {
  const list = document.getElementById('claimList');
  const claims = [...state.claimBySettlement.entries()]
    .map(([id, c]) => ({ id, c, settlement: state.settlements.find(s => s.id === id) }))
    .filter(x => x.settlement)
    .sort((a, b) => a.settlement.name.localeCompare(b.settlement.name));
  if (!claims.length) {
    list.innerHTML = '<p class="text-gray-400 text-sm">No claims yet.</p>';
    return;
  }
  list.innerHTML = `<div class="space-y-2">${claims.map(({ id, c, settlement }) => `
    <article class="fw-card">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="font-semibold truncate">
            <span class="fw-flag-dot" style="background:${factionColor(c.faction_id)}"></span>${esc(c.faction_name)}
          </div>
          <div class="text-xs text-gray-400 mt-0.5">${esc(settlement.name)} (${esc(settlement.kind)}) · ${c.flags_met}/${c.flags_needed} flags</div>
        </div>
        <button data-clear="${esc(id)}" class="text-xs bg-red-700 hover:bg-red-600 px-3 py-1 rounded shrink-0">Clear</button>
      </div>
    </article>`).join('')}</div>`;
  list.querySelectorAll('[data-clear]').forEach(btn => {
    btn.addEventListener('click', () => clearSettlement(btn.dataset.clear));
  });
}

function renderSettlementList() {
  const list = document.getElementById('settlementList');
  const rows = state.settlements
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(s => {
      const claim = state.claimBySettlement.get(s.id);
      const byFaction = new Map();
      for (const f of state.flags) {
        if (f.settlement_id === s.id) byFaction.set(f.faction_id, (byFaction.get(f.faction_id) || 0) + 1);
      }
      const flagText = [...byFaction.entries()]
        .map(([fid, n]) => `<span class="fw-flag-dot" style="background:${factionColor(fid)}"></span>${n}`)
        .join(' ');
      return `<div class="fw-sett-row flex items-center justify-between gap-2 px-2 py-1.5 rounded" data-sett="${esc(s.id)}">
        <div class="min-w-0">
          <div class="text-sm truncate">${claim ? `<span class="fw-flag-dot" style="background:${factionColor(claim.faction_id)}"></span>` : ''}${esc(s.name)}</div>
          <div class="text-xs text-gray-500">${esc(s.kind)} · needs ${s.flags_needed}</div>
        </div>
        <div class="text-xs text-gray-300 shrink-0 flex items-center gap-2">${flagText || '<span class="text-gray-600">0 flags</span>'}</div>
      </div>`;
    });
  list.innerHTML = rows.join('');
  list.querySelectorAll('[data-sett]').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.sett;
      const s = state.settlements.find(x => x.id === id);
      if (!s) return;
      document.getElementById('flagSettlement').value = id;
      document.getElementById('flagSettlement').dataset.pointEast = Math.round(s.east);
      document.getElementById('flagSettlement').dataset.pointNorth = Math.round(s.north);
      updatePreviewCircle(Math.round(s.east), Math.round(s.north), s);
      if (map) {
        map.setView(gameToLeaflet(s.east, s.north, state.mapName), Math.max(map.getZoom(), 0));
      }
    });
  });
}

function renderFlagList() {
  const list = document.getElementById('flagList');
  const loose = state.flags.filter(f => !f.settlement_id);
  if (!loose.length) {
    list.innerHTML = '<p class="text-gray-400 text-sm">No out-of-settlement flags.</p>';
    return;
  }
  list.innerHTML = `<div class="space-y-2 max-h-72 overflow-y-auto pr-1">${loose.map(f => `
    <article class="fw-card">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm truncate"><span class="fw-flag-dot" style="background:${factionColor(f.faction_id)}"></span>${esc(f.faction_name)}</div>
          <div class="text-xs text-gray-500">📍 ${Math.round(f.east)}, ${Math.round(f.north)} · r ${Math.round(f.radius_m)}m · by ${esc(f.placed_by)}</div>
        </div>
        <button data-rmflag="${esc(f.id)}" class="text-xs bg-red-700 hover:bg-red-600 px-3 py-1 rounded shrink-0">Remove</button>
      </div>
    </article>`).join('')}</div>`;
  list.querySelectorAll('[data-rmflag]').forEach(btn => {
    btn.addEventListener('click', () => removeFlag(Number(btn.dataset.rmflag)));
  });
}

/* ── Layers ──────────────────────────────────────────────────────────────── */

function redrawLayers() {
  if (!map) return;
  const scale = DayzMapCoordinates.pixelsPerWorldUnit(state.mapName);
  for (const key of Object.keys(layerGroups)) {
    if (layerGroups[key] && map.hasLayer(layerGroups[key])) map.removeLayer(layerGroups[key]);
    layerGroups[key] = L.layerGroup();
  }

  for (const s of state.settlements) {
    L.circle(gameToLeaflet(s.east, s.north, state.mapName), {
      radius: s.boundary_radius_m * scale,
      color: '#94a3b8', fillColor: '#64748b', weight: 1, fillOpacity: 0.05,
      dashArray: '5 5', interactive: false,
    }).addTo(layerGroups.boundaries);
  }

  for (const [id, claim] of state.claimBySettlement.entries()) {
    const s = state.settlements.find(x => x.id === id);
    if (!s) continue;
    const color = factionColor(claim.faction_id);
    L.circle(gameToLeaflet(s.east, s.north, state.mapName), {
      radius: s.boundary_radius_m * scale,
      color, fillColor: color, weight: 2, fillOpacity: 0.18, interactive: false,
    }).addTo(layerGroups.claims);
    L.marker(gameToLeaflet(s.east, s.north, state.mapName), {
      icon: L.divIcon({ className: '',
        html: `<span style="display:block;text-align:center;font-size:11px;font-weight:700;line-height:1.15;text-shadow:0 1px 3px #000;white-space:nowrap;color:${color}">🚩 ${esc(claim.faction_name)}</span>`,
        iconSize: [140, 16], iconAnchor: [70, -8] }),
      interactive: false,
    }).addTo(layerGroups.claims);
  }

  for (const f of state.flags) {
    const color = factionColor(f.faction_id);
    const pos = gameToLeaflet(f.east, f.north, state.mapName);
    L.marker(pos, {
      icon: L.divIcon({ className: '', html: `<span style="font-size:18px">🚩</span>`, iconSize: [20, 20] }),
      interactive: false,
    }).addTo(layerGroups.flags);
    if (!f.settlement_id) {
      // Out-of-settlement flag: territory is its own radius circle.
      L.circle(pos, {
        radius: f.radius_m * scale,
        color, fillColor: color, weight: 1.5, fillOpacity: 0.12,
        dashArray: '4 4', interactive: false,
      }).addTo(layerGroups.flags);
    }
  }

  applyLayerVisibility();
}

function applyLayerVisibility() {
  if (!map) return;
  const controls = {
    boundaries: document.getElementById('fwShowBoundaries').checked,
    claims: document.getElementById('fwShowClaims').checked,
    flags: document.getElementById('fwShowFlags').checked,
  };
  for (const [name, enabled] of Object.entries(controls)) {
    const layer = layerGroups[name];
    if (!layer) continue;
    if (enabled && !map.hasLayer(layer)) layer.addTo(map);
    if (!enabled && map.hasLayer(layer)) map.removeLayer(layer);
  }
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

async function placeFlag(e) {
  e.preventDefault();
  const factionId = Number(document.getElementById('flagFaction').value);
  if (!factionId) { showFormError('Pick a faction.'); return; }
  const select = document.getElementById('flagSettlement');
  let east, north;
  if (select.value === '__point__') {
    east = Number(select.dataset.pointEast);
    north = Number(select.dataset.pointNorth);
  } else if (select.value) {
    const s = state.settlements.find(x => x.id === select.value);
    if (!s) { showFormError('Pick a settlement.'); return; }
    east = Math.round(s.east);
    north = Math.round(s.north);
  } else if (select.dataset.pointEast !== undefined) {
    east = Number(select.dataset.pointEast);
    north = Number(select.dataset.pointNorth);
  } else {
    showFormError('Pick a settlement or click the map for an exact position.');
    return;
  }
  if (!Number.isFinite(east) || !Number.isFinite(north)) { showFormError('Invalid position.'); return; }

  const radiusM = Number(document.getElementById('flagRadius').value);
  try {
    const data = await parseJson(await fetchWithCsrf(`/api/admin/faction-war/${state.serverId}/flags`, {
      method: 'POST',
      body: JSON.stringify({ mapName: state.mapName, east, north, factionId, radiusM }),
    }));
    showFormError('');
    if (data.claimEvent) {
      const s = data.settlement || state.settlements.find(x => x.id === data.claimEvent.settlementId);
      const name = s ? s.name : data.claimEvent.settlementId;
      const who = data.flag.faction_name;
      const verb = data.claimEvent.type === 'claimed' ? 'claimed' : data.claimEvent.type === 'claim_taken' ? 'taken' : 'lost';
      alert(`${name}: ${verb} — ${who} ${data.claimEvent.flagsMet ?? ''} flags`);
    }
    await loadWarState();
  } catch (error) {
    showFormError(error.message);
  }
}

async function removeFlag(flagId) {
  try {
    await parseJson(await fetchWithCsrf(`/api/admin/faction-war/${state.serverId}/flags/${flagId}`, { method: 'DELETE' }));
    await loadWarState();
  } catch (error) {
    showFormError(error.message);
  }
}

async function clearSettlement(settlementId) {
  if (!confirm('Clear ALL flags on this settlement?')) return;
  try {
    await parseJson(await fetchWithCsrf(`/api/admin/faction-war/${state.serverId}/settlements/${encodeURIComponent(settlementId)}/clear`, { method: 'POST' }));
    await loadWarState();
  } catch (error) {
    showFormError(error.message);
  }
}

/* ── Wiring ──────────────────────────────────────────────────────────────── */

function init() {
  document.getElementById('flagForm').addEventListener('submit', placeFlag);
  for (const id of ['fwShowBoundaries', 'fwShowClaims', 'fwShowFlags']) {
    document.getElementById(id).addEventListener('change', applyLayerVisibility);
  }
  initServers().catch(err => {
    document.getElementById('empty-state').textContent = `Failed to load servers: ${err.message}`;
  });
}

document.addEventListener('DOMContentLoaded', init);
