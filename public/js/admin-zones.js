'use strict';
/* global document, window, L, DayzMapCoordinates, fetchWithCsrf, api */

// Maps that ship tiles under /maps/<name>/tiles/ — the zone editor only offers
// these (namalsk/takistanplus have no raster tiles in this deploy).
const MAPS_WITH_TILES = ['nasdara', 'chernarusplus', 'enoch', 'sakhal'];
const TILE_ERR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const state = {
  serverId: null,
  channels: [],
  mapName: 'nasdara',
  editingZoneId: null,
};

let map = null;
let previewCircle = null;
const zoneLayers = new Map(); // zoneId -> L.circle

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseJson(res) {
  return res.json().catch(() => ({})).then(data => {
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
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
  const stage = document.getElementById('zone-stage');
  const empty = document.getElementById('empty-state');
  if (!state.serverId) {
    stage.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  stage.classList.remove('hidden');
  resetForm();
  initMap(state.mapName);
  loadZones();
  loadChannels();
}

/* ── Map ──────────────────────────────────────────────────────────────────── */

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
  document.getElementById('mapLabel').textContent = `Map: ${mapName}`;
  if (map) { map.remove(); map = null; }
  zoneLayers.clear();
  previewCircle = null;

  const cfg = mapConfigFor(mapName);
  map = L.map('zoneMap', {
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

  // Tiles: identical layout to the owner operations map (map.js).
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
  // The stage is shown just before this runs; let the layout settle then size.
  setTimeout(() => map.invalidateSize(), 50);
}

function onMapClick(e) {
  const w = DayzMapCoordinates.leafletToWorld({ lat: e.latlng.lat, lng: e.latlng.lng }, state.mapName);
  document.getElementById('zoneEast').value = String(Math.round(w.east));
  document.getElementById('zoneNorth').value = String(Math.round(w.north));
  updatePreview();
}

function formCenter() {
  const east = Number(document.getElementById('zoneEast').value);
  const north = Number(document.getElementById('zoneNorth').value);
  if (!Number.isFinite(east) || !Number.isFinite(north)) return null;
  return { east, north };
}

function updatePreview() {
  if (!map) return;
  if (previewCircle) { map.removeLayer(previewCircle); previewCircle = null; }
  const center = formCenter();
  if (!center) return;
  const radius = Number(document.getElementById('zoneRadius').value) || 400;
  const scale = DayzMapCoordinates.pixelsPerWorldUnit(state.mapName);
  previewCircle = L.circle(gameToLeaflet(center.east, center.north, state.mapName), {
    radius: radius * scale,
    color: '#f59e0b',
    fillColor: '#f59e0b',
    fillOpacity: 0.15,
    weight: 2,
    interactive: false,
  }).addTo(map);
}

function drawZoneCircle(zone) {
  if (!map) return;
  const scale = DayzMapCoordinates.pixelsPerWorldUnit(state.mapName);
  const layer = L.circle(gameToLeaflet(zone.center_x, zone.center_z, state.mapName), {
    radius: zone.radius_m * scale,
    color: zone.enabled ? '#22c55e' : '#64748b',
    fillColor: zone.enabled ? '#22c55e' : '#64748b',
    fillOpacity: zone.enabled ? 0.12 : 0.04,
    weight: 2,
    interactive: false,
  }).addTo(map);
  zoneLayers.set(zone.id, layer);
}

function redrawZoneCircles() {
  zoneLayers.forEach(layer => { if (map.hasLayer(layer)) map.removeLayer(layer); });
  zoneLayers.clear();
  (state.zones || []).forEach(drawZoneCircle);
}

/* ── Zones CRUD ───────────────────────────────────────────────────────────── */

async function loadZones() {
  if (!state.serverId) return;
  const list = document.getElementById('zoneList');
  list.innerHTML = '<p class="text-gray-400 text-sm">Loading…</p>';
  try {
    const data = await parseJson(await fetch(`/api/admin/zones/${state.serverId}`));
    state.zones = data.zones || [];
    renderZoneList();
    redrawZoneCircles();
  } catch (error) {
    list.innerHTML = `<p class="text-red-400 text-sm">${esc(error.message)}</p>`;
  }
}

// All user-controlled values below are escaped with esc() before insertion, so
// the innerHTML is safe (house convention shared with spawn-exclusions.js).
function renderZoneList() {
  const list = document.getElementById('zoneList');
  const zones = state.zones || [];
  if (!zones.length) {
    list.innerHTML = '<p class="text-gray-400 text-sm">No zones yet.</p>';
    return;
  }
  list.innerHTML = `<div class="space-y-2">${zones.map(zone => {
    const filters = (zone.activity_filters || []).join(', ') || '—';
    const last = zone.last_posted_at ? new Date(zone.last_posted_at).toLocaleString() : 'never';
    return `<article class="zone-card" data-zone-id="${esc(zone.id)}">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="font-semibold truncate">${esc(zone.name)}</div>
          <div class="text-xs text-gray-400 mt-0.5">
            ${esc(zone.map_name)} · center ${esc(Math.round(zone.center_x))},${esc(Math.round(zone.center_z))} · r ${esc(Math.round(zone.radius_m))}m
          </div>
          <div class="text-xs text-gray-500 mt-1">
            ${filters} · ch ${esc(zone.channel_id)} · ${zone.enabled ? '<span class="chip bg-green-900 text-green-200">enabled</span>' : '<span class="chip bg-gray-700 text-gray-300">off</span>'}
            · last post ${esc(last)}${zone.last_post_count ? ` (${zone.last_post_count})` : ''}
          </div>
        </div>
        <div class="flex flex-col gap-1 shrink-0">
          <button data-act="edit" class="text-xs bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded">Edit</button>
          <button data-act="delete" class="text-xs bg-red-700 hover:bg-red-600 px-3 py-1 rounded">Delete</button>
        </div>
      </div>
    </article>`;
  }).join('')}</div>`;
}

function resetForm() {
  state.editingZoneId = null;
  document.getElementById('zoneForm').reset();
  document.getElementById('zoneId').value = '';
  document.getElementById('formTitle').textContent = 'New zone';
  document.getElementById('cancelEditBtn').classList.add('hidden');
  document.getElementById('zoneEast').value = '';
  document.getElementById('zoneNorth').value = '';
  document.getElementById('zoneRadius').value = '400';
  document.getElementById('zoneMinInterval').value = '120';
  document.getElementById('zoneEnabled').checked = true;
  document.querySelectorAll('.zone-filter').forEach(cb => { cb.checked = cb.value === 'kill'; });
  document.getElementById('zoneMap').value = state.mapName;
  showFormError('');
  updatePreview();
}

function selectZoneForEdit(zone) {
  state.editingZoneId = zone.id;
  document.getElementById('zoneId').value = zone.id;
  document.getElementById('zoneName').value = zone.name;
  document.getElementById('zoneMap').value = zone.map_name;
  document.getElementById('zoneRadius').value = Math.round(zone.radius_m);
  document.getElementById('zoneEast').value = String(Math.round(zone.center_x));
  document.getElementById('zoneNorth').value = String(Math.round(zone.center_z));
  document.getElementById('zoneChannel').value = zone.channel_id;
  document.getElementById('zoneMinInterval').value = zone.min_interval_seconds;
  document.getElementById('zoneEnabled').checked = !!zone.enabled;
  const filters = new Set(zone.activity_filters || []);
  document.querySelectorAll('.zone-filter').forEach(cb => { cb.checked = filters.has(cb.value); });
  document.getElementById('formTitle').textContent = `Edit: ${zone.name}`;
  document.getElementById('cancelEditBtn').classList.remove('hidden');
  showFormError('');
  updatePreview();
}

function activeFilters() {
  return [...document.querySelectorAll('.zone-filter:checked')].map(cb => cb.value);
}

async function saveZone(e) {
  e.preventDefault();
  const center = formCenter();
  if (!center) { showFormError('Click the map to set the zone center.'); return; }
  const filters = activeFilters();
  const payload = {
    name: document.getElementById('zoneName').value.trim(),
    center_x: center.east,
    center_z: center.north,
    radius_m: Number(document.getElementById('zoneRadius').value),
    activity_filters: filters,
    channel_id: document.getElementById('zoneChannel').value,
    min_interval_seconds: Number(document.getElementById('zoneMinInterval').value),
    enabled: document.getElementById('zoneEnabled').checked,
    map_name: state.mapName,
  };
  if (!filters.length) { showFormError('Select at least one activity type.'); return; }
  if (!payload.channel_id) { showFormError('Choose an output channel.'); return; }

  const isEdit = !!state.editingZoneId;
  try {
    if (isEdit) {
      await parseJson(await fetchWithCsrf(`/api/admin/zones/${state.serverId}/${state.editingZoneId}`, {
        method: 'PATCH', body: JSON.stringify(payload),
      }));
    } else {
      await parseJson(await fetchWithCsrf(`/api/admin/zones/${state.serverId}`, {
        method: 'POST', body: JSON.stringify(payload),
      }));
    }
    showFormError('');
    resetForm();
    await loadZones();
  } catch (error) {
    showFormError(error.message);
  }
}

async function deleteZone(zoneId) {
  if (!confirm('Delete this zone?')) return;
  try {
    await parseJson(await fetchWithCsrf(`/api/admin/zones/${state.serverId}/${zoneId}`, { method: 'DELETE' }));
    if (state.editingZoneId === zoneId) resetForm();
    await loadZones();
  } catch (error) {
    showFormError(error.message);
  }
}

/* ── Channels ─────────────────────────────────────────────────────────────── */

async function loadChannels() {
  const select = document.getElementById('zoneChannel');
  select.innerHTML = '<option value="">Loading channels…</option>';
  try {
    const data = await parseJson(await fetch(`/api/admin/zones/${state.serverId}/channels`));
    state.channels = data.channels || [];
    renderChannelOptions(select);
  } catch (error) {
    state.channels = [];
    renderChannelOptions(select);
    showFormError(`Could not load channels: ${error.message}`);
  }
}

function renderChannelOptions(select) {
  const options = state.channels.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  select.innerHTML = `<option value="">— select a channel —</option>${options}<option value="__raw__">paste channel ID…</option>`;
  select.onchange = () => {
    if (select.value === '__raw__') {
      const raw = prompt('Discord channel ID (snowflake):');
      if (raw && /^\d{1,20}$/.test(raw.trim())) select.value = raw.trim();
      else { select.value = ''; }
    }
  };
}

/* ── Wiring ───────────────────────────────────────────────────────────────── */

function initMapSelect() {
  const select = document.getElementById('zoneMap');
  select.innerHTML = MAPS_WITH_TILES.map(m => `<option value="${m}">${m}</option>`).join('');
  select.value = 'nasdara';
  select.addEventListener('change', e => {
    state.mapName = e.target.value;
    initMap(state.mapName);
    redrawZoneCircles();
    updatePreview();
  });
}

function init() {
  initMapSelect();
  document.getElementById('zoneForm').addEventListener('submit', saveZone);
  document.getElementById('zoneRadius').addEventListener('input', updatePreview);
  document.getElementById('cancelEditBtn').addEventListener('click', resetForm);
  document.getElementById('zoneList').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.zone-card');
    const zoneId = Number(card.dataset.zoneId);
    const zone = (state.zones || []).find(z => z.id === zoneId);
    if (!zone) return;
    if (btn.dataset.act === 'edit') selectZoneForEdit(zone);
    else if (btn.dataset.act === 'delete') deleteZone(zoneId);
  });
  initServers().catch(err => {
    document.getElementById('empty-state').textContent = `Failed to load servers: ${err.message}`;
  });
}

document.addEventListener('DOMContentLoaded', init);
