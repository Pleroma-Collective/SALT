let map = null;
let markers = {};
let allEventData = [];
let eventTypeFilters = {};
let currentTiles = [];
let currentServer = null;
let currentMapName = null;
// Player map mode: user has no moderatable server — the page degrades to
// the loot-finder layer over static terrain (merged map page). Staff-only
// sections stay hidden; staff data endpoints are never requested.
let playerMapMode = false;
let activeMapName = null;
let activeMissionName = null; // Active mission folder from Nitrado, e.g. "ChristmasOffline.ChernarusPlus"
let holidayState = null;      // HolidayWindows.matchState result for the active mission
let holidayMarkersVisible = true;  // Checkbox gate for the holiday marker set
let holidayRowMission = null;      // Mission the holiday row was initialized for
let coordinateGridLayer = null;

let radiusSearchMode = false;
let radiusCircle = null;
let radiusMarker = null;
let lastEventHealth = null;
let eventHealthRequestId = 0;
let mapDiscoveryRequestId = 0;
let mapDataRequestId = 0;
let contextGeneration = 0;
let lootHeatmapRequestId = 0;
const genericHeatmapRequestIds = {};

// Auto-refresh state
let autoRefreshEnabled = true;
let autoRefreshInterval = null;
let refreshCountdown = null;
let refreshSeconds = 30;

// Heatmap state
let heatLayer = null;
let heatmapEnabled = false;
let heatmapFilter = 'all';

// Additional heat layers: kills, deaths, movement
let killHeatLayer = null;
let killHeatmapEnabled = false;
let deathHeatLayer = null;
let deathHeatmapEnabled = false;
let movementHeatLayer = null;
let movementHeatmapEnabled = false;

// Live "recently spawned loot" layer — real runtime spawn data from
// server.log `Adding <Item> at [east,north]`; markers fade with age.
let recentLootLayer = null;
let recentLootEnabled = false;
let recentLootRequestId = 0;

// Staff operations overlay (log-derived, exact-server scoped)
const onlinePlayerAdminState = window.OnlinePlayerAdminState;
let operationsRequestId = 0;
const operationsPlayerMarkers = new Map();
const onlinePlayerNoteDrafts = new Map();
const onlinePlayerNoteSaveCoordinator = onlinePlayerAdminState.createSaveCoordinator();
const operationsLayers = {
  players: null,
  events: null,
  purchases: null,
  territory: null,
  zones: null,
  factions: null,
  factionTerritories: null,
};
// Faction Wars overlay — settlement claims + flags via /api/faction-war
// (DB-derived, so it shows even when the server is down, unlike the ops snapshot).
let factionWarRequestId = 0;
const factionWarLayers = { claims: null, flags: null };
const geographyLayers = {
  settlementLabels: null,
  settlementExtents: null,
  spawnMarkers: null,
};

// Place search (roadmap P0-B) + zoom-bucketed POI layers. Buckets are built
// per map: settlement labels by CfgWorlds kind (catalog) or by extracted
// kind (data/<map>/settlements.json, maps without embedded names), spawn
// groups by mapgroupproto usages (see PlaceSearch.spawnBucketOf). Only the
// buckets active at the current zoom are on the map.
let placeSearchIndex = [];
let placeSearchIndexMap = null;
let spawnMarkerFeatures = null;
let spawnMarkerRequestId = 0;
let spawnMarkersFor = null;      // map the spawn buckets were built for
let spawnBucketLayers = null;    // { city, town, village } -> L.geoJSON layer
let settlementBucketLayers = null; // { city, village } -> L.layerGroup
let settlementLabels = [];      // active-map label entries (catalog or fetched)
let settlementLabelsFor = null; // map those labels were built for
let settlementDataRequestId = 0;

// Stats tracking
let previousStats = {
  spawns: 0,
  events: 0,
  players: 0
};

// Canonical measured map geometry and world transforms.
const mapConfigs = DayzMapCoordinates.MAP_DEFINITIONS;

function gameToLeaflet(east, north, mapName) {
  return DayzMapCoordinates.worldToLeaflet({ east, north }, mapName);
}

// Helper function for event colors - DYNAMIC with localStorage
function getEventColor(eventName) {
  let savedColors = {};
  try {
    savedColors = JSON.parse(localStorage.getItem('eventColors') || '{}');
  } catch {
    savedColors = {};
  }

  if (/^#[0-9a-f]{6}$/i.test(savedColors[eventName] || '')) {
    return savedColors[eventName];
  }
  
  let hash = 0;
  for (let i = 0; i < eventName.length; i++) {
    hash = eventName.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  const hue = Math.abs(hash % 360);
  const saturation = 65 + (Math.abs(hash) % 20);
  const lightness = 50 + (Math.abs(hash >> 8) % 15);
  
  return 'hsl(' + hue + ', ' + saturation + '%, ' + lightness + '%)';
}

function saveEventColor(eventName, color) {
  const savedColors = JSON.parse(localStorage.getItem('eventColors') || '{}');
  savedColors[eventName] = color;
  localStorage.setItem('eventColors', JSON.stringify(savedColors));
}

function resetEventColor(eventName) {
  const savedColors = JSON.parse(localStorage.getItem('eventColors') || '{}');
  delete savedColors[eventName];
  localStorage.setItem('eventColors', JSON.stringify(savedColors));
}

function rgbToHex(color) {
  if (color.startsWith('#')) {
    return color;
  }
  
  if (color.startsWith('hsl')) {
    const temp = document.createElement('div');
    temp.style.color = color;
    document.body.appendChild(temp);
    const rgb = window.getComputedStyle(temp).color;
    document.body.removeChild(temp);
    color = rgb;
  }
  
  const rgb = color.match(/\d+/g);
  if (rgb) {
    const r = parseInt(rgb[0]).toString(16).padStart(2, '0');
    const g = parseInt(rgb[1]).toString(16).padStart(2, '0');
    const b = parseInt(rgb[2]).toString(16).padStart(2, '0');
    return '#' + r + g + b;
  }
  
  return '#8b5cf6';
}

function updateEventColors(eventName, newColor) {
  allEventData.forEach(function(event) {
    if (event.name === eventName) {
      event.color = newColor;
      event.marker.setStyle({
        fillColor: newColor
      });
    }
  });
  
  const dot = document.getElementById('dot_' + eventName);
  if (dot) {
    dot.style.background = newColor;
  }
  
  searchEvents();
}

function resetAllColors() {
  localStorage.removeItem('eventColors');
  
  const uniqueEvents = [...new Set(allEventData.map(e => e.name))];
  
  uniqueEvents.forEach(function(eventName) {
    const autoColor = getEventColor(eventName);
    
    allEventData.forEach(function(event) {
      if (event.name === eventName) {
        event.color = autoColor;
        event.marker.setStyle({
          fillColor: autoColor
        });
      }
    });
    
    const dot = document.getElementById('dot_' + eventName);
    if (dot) {
      dot.style.background = autoColor;
    }
    
    const colorPickers = document.querySelectorAll('input[type="color"]');
    colorPickers.forEach(function(picker) {
      if (picker.getAttribute('data-event') === eventName) {
        picker.value = rgbToHex(autoColor);
      }
    });
  });
  
  console.log('✓ All colors reset to auto-generated');
}

// B1.3 destination mini-map preview (uses public/maps tiles via destination-preview.js)
function updateDestinationPreview(east, north, label) {
  const panel = document.getElementById('destination-preview-panel');
  const slot = document.getElementById('destination-preview-slot');
  const statusEl = document.getElementById('destination-preview-status');
  const coordsEl = document.getElementById('destination-preview-coords');
  if (!panel) return;

  const mapName = (typeof currentMapName !== 'undefined') ? currentMapName : 'enoch';
  const eastN = Number(east);
  const northN = Number(north);
  if (!Number.isFinite(eastN) || !Number.isFinite(northN)) return;

  panel.style.display = 'block';
  if (window.DayzDestinationPreview && DayzDestinationPreview.mapAvailable(mapName)) {
    slot.innerHTML = window.DayzDestinationPreview.previewHtml({ mapName, east: eastN, north: northN, name: label, sizePx: 244 });
    statusEl.textContent = 'Mini-map from ' + (window.DayzDestinationPreview.MAPS[mapName].name) + ' tiles.';
    coordsEl.textContent = 'east ' + Math.round(eastN) + '  north ' + Math.round(northN);
  } else {
    slot.innerHTML = '';
    statusEl.textContent = 'No map tiles available for this map — preview shows coordinates only.';
    coordsEl.textContent = 'east ' + Math.round(eastN) + '  north ' + Math.round(northN);
  }
}

function clearDestinationPreview() {
  const panel = document.getElementById('destination-preview-panel');
  if (panel) panel.style.display = 'none';
}

function bindDestinationPreviewPanel() {
  const btn = document.getElementById('destination-preview-clear');
  if (btn) btn.addEventListener('click', clearDestinationPreview);
  // Any map click marks a destination (independent of radius-search mode).
  if (map) {
    map.on('click', function (e) {
      if (typeof currentMapName !== 'undefined' && DayzMapCoordinates.leafletToWorld) {
        const w = DayzMapCoordinates.leafletToWorld({ lat: e.latlng.lat, lng: e.latlng.lng }, currentMapName);
        updateDestinationPreview(w.east, w.north);
      }
    });
  }
}

// Shared deep-link: ?marker=<east>,<north> drops a marker and zooms there —
// used by the Discord dynamic-events feed links. Applied on every map init;
// out-of-bounds coordinates are silently ignored.
let urlMarker = null;
function applyUrlMarker(mapName) {
  if (!map) return;
  if (urlMarker) {
    urlMarker.remove();
    urlMarker = null;
  }
  const raw = new URLSearchParams(window.location.search).get('marker');
  if (!raw) return;
  const parts = raw.split(',').map(Number);
  const [east, north] = parts;
  if (!Number.isFinite(east) || !Number.isFinite(north)) return;
  const mapDef = mapConfigs[mapName];
  if (!mapDef || east < 0 || east > mapDef.worldWidth || north < 0 || north > mapDef.worldHeight) return;
  const tile = gameToLeaflet(east, north, mapName);
  urlMarker = L.circleMarker(tile, {
    radius: 8,
    fillColor: '#f59e0b',
    color: '#fff',
    weight: 2,
    opacity: 1,
    fillOpacity: 0.9
  })
    .addTo(map)
    .bindPopup('<div class="text-gray-900"><strong>Dynamic event</strong><br>Game: ' + Math.round(east) + ', ' + Math.round(north) + '</div>');
  map.setView(tile, 2);
}

// Initialize map
function initMap(mapName = 'enoch') {
  const resolvedMapName = mapConfigs[mapName] ? mapName : 'enoch';
  const mapConfig = mapConfigs[resolvedMapName];
  // Tiles are decorative (alt="" via Leaflet); the container carries the one
  // name a screen reader hears — re-set on every map switch.
  document.getElementById('map').setAttribute('aria-label',
    mapConfig.name + ' map, ' + mapConfig.gridSize + '×' + mapConfig.gridSize);
  if (map) {
    currentTiles.forEach(tile => tile.remove());
    currentTiles = [];
  } else {
    map = L.map('map', {
      crs: L.CRS.Simple,
      minZoom: -2,
      maxZoom: 3,
      center: [mapConfig.contentHeight / 2, mapConfig.contentWidth / 2],
      zoom: -1,
      zoomControl: true,
      attributionControl: false
    });

    map.on('click', onMapClick);
    map.on('zoomend', function () {
      applySettlementLabelVisibility();
      applySpawnVisibility();
    });
  }

  bindDestinationPreviewPanel();

  // Viewport bounds follow the CONTENT extent (not the full image): bleed
  // re-slices (nasdara) carry a clamped edge band past the real canvas, and
  // that band must stay out of the visible map. Legacy maps have
  // contentWidth == size, so this is a no-op for them.
  const bounds = L.latLngBounds([[0, 0], [mapConfig.contentWidth, mapConfig.contentHeight]]);
  map.setMaxBounds(bounds.pad(0.5));
  map.fitBounds(bounds);
  addCoordinateGrid(resolvedMapName);

  const gridSize = mapConfig.gridSize;
  const physicalTileSize = mapConfig.physicalSize || 512;
  const advancement = mapConfig.advancement || mapConfig.tileSize;

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const flippedY = (gridSize - 1) - y;
      const tileBounds = L.latLngBounds([
        [y * advancement, x * advancement],
        [y * advancement + physicalTileSize, x * advancement + physicalTileSize]
      ]);
      const tileUrl = '/maps/' + resolvedMapName + '/tiles/' + x + '/' + flippedY + '.png';
      const overlay = L.imageOverlay(tileUrl, tileBounds, {
        opacity: 1,
        interactive: false,
        errorOverlayUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
      }).addTo(map);
      currentTiles.push(overlay);
    }
  }
  renderStaticGeography(resolvedMapName);
  applyUrlMarker(resolvedMapName);
}

// Settlement labels come from the static CfgWorlds catalog (Chernarus) or,
// for maps with no embedded names (nasdara), from data/<map>/settlements.json
// (scripts/extract-nasdara-settlements.js — dayzed.gg, game-file-derived).
// 404 (no file) or malformed shape silently means "no labels", same as today.
async function fetchSettlementLabels(mapName) {
  try {
    const res = await fetch('/data/' + mapName + '/settlements.json');
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.map !== mapName || !Array.isArray(data.settlements)) return null;
    return data.settlements.every(function (s) {
      return s && s.names && typeof s.names.en === 'string' && s.names.en.length &&
        s.position && Number.isFinite(s.position.east) && Number.isFinite(s.position.north) &&
        ['capital', 'city', 'village'].includes(s.kind);
    }) ? data.settlements : null;
  } catch (e) { return null; }
}

async function renderStaticGeography(mapName) {
  const requestId = ++settlementDataRequestId;
  if (!geographyLayers.settlementExtents) geographyLayers.settlementExtents = L.layerGroup();
  geographyLayers.settlementExtents.clearLayers();
  if (settlementBucketLayers && map) {
    for (const layer of Object.values(settlementBucketLayers)) {
      if (map.hasLayer(layer)) map.removeLayer(layer);
      layer.clearLayers();
    }
  }
  const staticLayers = DayzMapLayerCatalog.getSettlementLayers(mapName);
  const radiusScale = DayzMapCoordinates.pixelsPerWorldUnit(mapName);
  staticLayers.extents.forEach(function(extent) {
    L.circle(gameToLeaflet(extent.position.east, extent.position.north, mapName), {
      radius: extent.radiusMeters * radiusScale,
      color: '#94a3b8', fillColor: '#64748b', weight: 1, fillOpacity: 0.08,
      dashArray: '5 5', interactive: false,
    }).addTo(geographyLayers.settlementExtents);
  });
  let labels = staticLayers.labels;
  if (!labels.length) {
    const fetched = await fetchSettlementLabels(mapName);
    if (requestId !== settlementDataRequestId) return; // map switched mid-fetch
    if (fetched) labels = fetched;
  }
  settlementLabels = labels;
  settlementLabelsFor = mapName;
  // Village labels sit in their own zoom bucket (hidden at overview);
  // capital/city labels are always shown when the layer is enabled.
  settlementBucketLayers = { city: L.layerGroup(), village: L.layerGroup() };
  labels.forEach(function(settlement) {
    const label = escapeHtml(settlement.names.en) + '<br><span lang="ru">' +
      escapeHtml(settlement.names.cy) + '</span>';
    const bucket = settlement.kind === 'village' ? 'village' : 'city';
    L.marker(gameToLeaflet(settlement.position.east, settlement.position.north, mapName), {
      icon: L.divIcon({ className: '',
        html: '<span style="display:block;text-align:center;color:#fff;font-size:11px;font-weight:600;line-height:1.15;text-shadow:0 1px 3px #000,1px 0 3px #000;white-space:nowrap;">' + label + '</span>',
        iconSize: [120, 30], iconAnchor: [60, 15] }),
      interactive: false,
    }).addTo(settlementBucketLayers[bucket]);
  });
  buildPlaceSearchIndex(mapName);
  applyGeographyLayerVisibility();
}

// Spawn-group markers from the extracted server-economy GeoJSON
// (scripts/extract-dayz-data.js -> data/<map>/markers.geojson). Coordinates are
// already in the map's Leaflet content space, so L.geoJSON lands them on-tile.
const SPAWN_CATEGORY_COLORS = {
  store: '#facc15', farm: '#84cc16', industrial: '#a855f7', police: '#3b82f6',
  fire: '#ef4444', medic: '#ec4899', military: '#22c55e', contaminated: '#a3e635',
  crash: '#f97316', residential: '#94a3b8', coast: '#06b6d4', hunting: '#d97706',
  other: '#64748b',
};
async function loadSpawnMarkers(mapName) {
  if (!map || !mapConfigs[mapName]) return;
  if (spawnBucketLayers && spawnMarkersFor === mapName) return;
  if (spawnBucketLayers) {
    for (const groups of Object.values(spawnBucketLayers)) {
      for (const layer of groups.values()) {
        if (map.hasLayer(layer)) map.removeLayer(layer);
      }
    }
    spawnBucketLayers = null;
    spawnMarkersFor = null;
  }
  const requestId = ++spawnMarkerRequestId;
  let data;
  try {
    const res = await fetch('/data/' + mapName + '/markers.geojson');
    if (!res.ok) return;
    data = await res.json();
  } catch (e) { return; }
  if (requestId !== spawnMarkerRequestId) return;
  if (!data || !Array.isArray(data.features) || !data.features.length) return;
  const renderer = L.canvas({ padding: 0.5 });
  spawnMarkerFeatures = data.features;
  // Pre-bucket BEFORE layer construction: each (zoom-usage, category, tier)
  // cell is its own canvas layer group, so zoomend (P0-B) and filter-rail
  // (P0-C) toggles add/remove whole groups — the 10k+ marker set is never
  // re-rendered or re-fetched. Every feature lands in exactly one
  // (category, tier) cell: that cell is its unique filter path.
  const byUsage = { city: new Map(), town: new Map(), village: new Map() };
  data.features.forEach(function (feature) {
    const p = feature.properties || {};
    const tier = Number(p.lootTier) || 1;
    const cat = p.category || 'other';
    const usage = PlaceSearch.spawnBucketOf(p.usages);
    const key = cat + '|' + tier;
    let group = byUsage[usage].get(key);
    if (!group) { group = L.layerGroup(); byUsage[usage].set(key, group); }
    group.addLayer(L.circleMarker(
      [feature.geometry.coordinates[1], feature.geometry.coordinates[0]], {
      renderer,
      radius: 2 + tier * 1.1,
      color: SPAWN_CATEGORY_COLORS[cat] || SPAWN_CATEGORY_COLORS.other,
      weight: 1,
      fillColor: SPAWN_CATEGORY_COLORS[cat] || SPAWN_CATEGORY_COLORS.other,
      fillOpacity: 0.55,
    }).bindTooltip(
      (p.name || '') + ' · ' + cat + ' · tier ' + tier,
      { direction: 'top' }
    ));
  });
  spawnBucketLayers = { city: byUsage.city, town: byUsage.town, village: byUsage.village };
  spawnMarkersFor = mapName;
  buildPlaceSearchIndex(mapName);
  renderSpawnFilterRail(mapName, data.features);
  applySpawnVisibility();
}

// Zoom-bucket visibility. Settlement labels: the master toggle gates the
// whole group; within an enabled group only the buckets active at the
// current zoom are on the map (cities always, towns from z0, villages from
// z1 — see place-search.js for the roadmap zoom-scale mapping).
function applySettlementLabelVisibility() {
  if (!settlementBucketLayers || !map) return;
  const control = document.getElementById('settlement-label-toggle');
  const zoom = map.getZoom();
  for (const [bucket, layer] of Object.entries(settlementBucketLayers)) {
    const on = control && control.checked && PlaceSearch.bucketVisible(bucket, zoom);
    if (on && !map.hasLayer(layer)) layer.addTo(map);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }
}

// Spawn-marker visibility = zoom bucket (P0-B) AND filter rail (P0-C).
// Only the (usage, category, tier) groups active on both dimensions are on
// the map; toggling either dimension adds/removes whole pre-bucketed groups.
function applySpawnVisibility() {
  if (!spawnBucketLayers || !map) return;
  const zoom = map.getZoom();
  let visible = 0;
  let total = 0;
  for (const [bucket, groups] of Object.entries(spawnBucketLayers)) {
    const zoomOk = PlaceSearch.bucketVisible(bucket, zoom);
    groups.forEach(function (layer, key) {
      const count = layer.getLayers().length;
      total += count;
      const on = zoomOk && spawnFilterPass(key);
      if (on && !map.hasLayer(layer)) layer.addTo(map);
      if (!on && map.hasLayer(layer)) map.removeLayer(layer);
      if (on) visible += count;
    });
  }
  updateSpawnFilterStatus(visible, total);
}

// ── Spawn filter rail (roadmap P0-C) ────────────────────────────────────────
// Semantics: within a group checkboxes OR, across groups they AND. Every
// feature has exactly one category and one loot tier, so its (category, tier)
// cell is its unique filter path. The category dimension drives; the tier row
// refines (nothing checked = pass-all); density levels map tier → level:
// high = tiers 3–4, med = tier 2, low = tier 1. Server-specific rows (P1
// holiday windows) gate their own event marker set via the existing
// holidayMarkersVisible path.
const SPAWN_LEVELS = ['high', 'med', 'low'];
const SPAWN_CATEGORY_ORDER = ['store', 'farm', 'industrial', 'police', 'fire', 'medic', 'military', 'crash', 'coast', 'residential', 'hunting', 'other'];

function spawnLevelOfTier(tier) {
  if (tier >= 3) return 'high';
  if (tier === 2) return 'med';
  return 'low';
}

/** Rail state from the DOM → { levels: Map cat->Set(level), tiers: Set }. */
function collectSpawnRailState() {
  const levels = new Map();
  const tiers = new Set();
  document.querySelectorAll('#spawn-filter-rail input[data-rail]').forEach(function (cb) {
    if (!cb.checked) return;
    const parts = cb.getAttribute('data-rail').split(':');
    if (parts[0] === 'cat') {
      let set = levels.get(parts[1]);
      if (!set) { set = new Set(); levels.set(parts[1], set); }
      set.add(parts[2]);
    } else if (parts[0] === 'tier') {
      tiers.add(parts[1] === 'unique' ? 'unique' : Number(parts[1]));
    }
  });
  return { levels: levels, tiers: tiers };
}

/** Does a pre-bucketed "cat|tier" group pass the rail? */
function spawnFilterPass(key) {
  const state = collectSpawnRailState();
  const sep = key.indexOf('|');
  const levels = state.levels.get(key.slice(0, sep));
  if (!levels || !levels.has(spawnLevelOfTier(Number(key.slice(sep + 1))))) return false;
  return state.tiers.size === 0 || state.tiers.has(Number(key.slice(sep + 1)));
}

/** Enabled rail paths for the ?rail= URL param (DOM order = stable). */
function collectRailPaths() {
  const paths = [];
  document.querySelectorAll('#spawn-filter-rail input[data-rail]').forEach(function (cb) {
    if (cb.checked) paths.push(cb.getAttribute('data-rail'));
  });
  if (holidayState && holidayMarkersVisible) paths.push('evt:' + holidayState.id);
  return paths;
}

function updateSpawnFilterStatus(visible, total) {
  const el = document.getElementById('spawn-filter-status');
  if (!el) return;
  el.textContent = total
    ? 'Showing ' + visible + ' of ' + total + ' spawn markers'
    : 'No spawn markers loaded for this map.';
}

/** One checkbox row for a rail path, with optional color dot + count. */
function makeRailCheckbox(path, label, dotColor, count) {
  const wrap = document.createElement('label');
  wrap.className = 'filter-checkbox';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.setAttribute('data-rail', path);
  cb.setAttribute('aria-label', path);
  wrap.appendChild(cb);
  if (dotColor) {
    const dot = document.createElement('span');
    dot.className = 'color-dot';
    dot.style.background = dotColor;
    wrap.appendChild(dot);
  }
  const text = document.createElement('span');
  text.textContent = label;
  wrap.appendChild(text);
  if (count != null) {
    const n = document.createElement('span');
    n.className = 'rail-count';
    n.textContent = count;
    wrap.appendChild(n);
  }
  return wrap;
}

/** Build the tier + category groups from the active map's features.
     Data-driven: only tiers/categories present in the GeoJSON get rows
     (e.g. no map ships 'contaminated' or animal markers today, so those
     rows never appear; a future extraction adds them with no code change). */
function renderSpawnFilterRail(mapName, features) {
  const tierBox = document.getElementById('spawn-rail-tier-items');
  const catBox = document.getElementById('spawn-rail-cat-items');
  if (!tierBox || !catBox) return;
  tierBox.replaceChildren();
  catBox.replaceChildren();

  const tierCounts = new Map();
  const catCounts = new Map();
  features.forEach(function (f) {
    const p = f.properties || {};
    const tier = Number(p.lootTier) || 1;
    const cat = p.category || 'other';
    tierCounts.set(tier, (tierCounts.get(tier) || 0) + 1);
    catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
  });

  [...tierCounts.keys()].sort(function (a, b) { return a - b; }).forEach(function (tier) {
    tierBox.appendChild(makeRailCheckbox('tier:' + tier, 'Tier ' + tier, null, tierCounts.get(tier)));
  });

  const ordered = SPAWN_CATEGORY_ORDER.filter(function (c) { return catCounts.has(c); })
    .concat([...catCounts.keys()].filter(function (c) { return SPAWN_CATEGORY_ORDER.indexOf(c) === -1; }).sort());
  ordered.forEach(function (cat) {
    catBox.appendChild(makeRailCheckbox('cat:' + cat, cat, SPAWN_CATEGORY_COLORS[cat] || SPAWN_CATEGORY_COLORS.other, catCounts.get(cat)));
    const density = document.createElement('div');
    density.className = 'rail-density';
    SPAWN_LEVELS.forEach(function (level) {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-rail', 'cat:' + cat + ':' + level);
      cb.setAttribute('aria-label', cat + ' ' + level);
      l.appendChild(cb);
      l.appendChild(document.createTextNode(' ' + level.charAt(0).toUpperCase() + level.slice(1)));
      density.appendChild(l);
    });
    catBox.appendChild(density);
  });

  // Shared-URL restore: re-enable the ?rail= paths that exist on this map.
  if (mapUrlState && mapUrlState.rail && mapUrlState.rail.size) {
    [tierBox, catBox].forEach(function (box) {
      box.querySelectorAll('input[data-rail]').forEach(function (cb) {
        if (mapUrlState.rail.has(cb.getAttribute('data-rail'))) cb.checked = true;
      });
    });
  }
}

function applyGeographyLayerVisibility() {
  // Settlement radii stay a plain toggle; labels and spawn groups go
  // through the zoom-bucket visibility above.
  const layer = geographyLayers.settlementExtents;
  const control = document.getElementById('settlement-extent-toggle');
  if (layer && control && map) {
    if (control.checked && !map.hasLayer(layer)) layer.addTo(map);
    if (!control.checked && map.hasLayer(layer)) map.removeLayer(layer);
  }
  applySettlementLabelVisibility();
  applySpawnVisibility();
}

// ── Place search (roadmap P0-B): named locations + raw coordinates ─────────
// Index = named settlements (the CfgWorlds catalog, or the extracted
// data/<map>/settlements.json for maps without embedded names) + one entry
// per distinct spawn-group name from the extracted markers GeoJSON. Entries
// carry DayZ world metres (east/north), so fly-to reuses gameToLeaflet.
function humanizeClassname(name) {
  return String(name).replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPlaceSearchIndex(mapName) {
  const entries = [];
  const settlements = settlementLabelsFor === mapName
    ? settlementLabels
    : DayzMapLayerCatalog.getSettlementLayers(mapName).labels;
  for (const settlement of settlements) {
    const base = { east: settlement.position.east, north: settlement.position.north, sub: settlement.kind };
    entries.push(Object.assign({ label: settlement.names.en }, base));
    if (settlement.names.cy && settlement.names.cy !== settlement.names.en) {
      entries.push(Object.assign({ label: settlement.names.cy }, base));
    }
  }
  const seen = new Map();
  for (const feature of spawnMarkerFeatures || []) {
    if (feature.properties && feature.geometry && !seen.has(feature.properties.name)) {
      seen.set(feature.properties.name, feature);
    }
  }
  for (const feature of seen.values()) {
    const w = DayzMapCoordinates.leafletToWorld({
      lat: feature.geometry.coordinates[1],
      lng: feature.geometry.coordinates[0],
    }, mapName);
    entries.push({
      label: humanizeClassname(feature.properties.name),
      sub: feature.properties.category || '',
      east: w.east,
      north: w.north,
    });
  }
  placeSearchIndex = entries;
  placeSearchIndexMap = mapName;
}

function placeSearchResults(raw) {
  const coords = PlaceSearch.parseCoordinates(raw);
  if (coords) {
    return [{
      label: 'east ' + Math.round(coords.east) + ' · north ' + Math.round(coords.north),
      sub: 'coordinates',
      east: coords.east,
      north: coords.north,
      isCoords: true,
    }];
  }
  return PlaceSearch.matchPlaces(raw, placeSearchIndex, 10);
}

function renderPlaceSearchResults() {
  const input = document.getElementById('place-search');
  const resultsEl = document.getElementById('place-results');
  resultsEl.replaceChildren();
  const raw = input.value.trim();
  if (!raw) return;
  const results = placeSearchResults(raw);
  if (!results.length) {
    const empty = document.createElement('div');
    empty.style.padding = '8px';
    empty.style.color = '#9ca3af';
    empty.textContent = 'No results found';
    resultsEl.appendChild(empty);
    return;
  }
  results.forEach(function (entry) {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.onclick = function () { flyToPlace(entry); };
    const text = document.createElement('span');
    text.textContent = entry.label;
    const coords = document.createElement('span');
    coords.style.fontSize = '11px';
    coords.style.color = '#9ca3af';
    coords.textContent = entry.isCoords
      ? ''
      : ((entry.sub ? entry.sub + ' · ' : '') + Math.round(entry.east) + ', ' + Math.round(entry.north));
    div.appendChild(text);
    div.appendChild(coords);
    resultsEl.appendChild(div);
  });
}

function flyToPlace(entry) {
  if (!map || !placeSearchIndexMap) return;
  map.setView(gameToLeaflet(entry.east, entry.north, placeSearchIndexMap), 1);
  updateDestinationPreview(entry.east, entry.north, entry.label);
}

function addCoordinateGrid(mapName) {
  const cfg = mapConfigs[mapName] || mapConfigs.enoch;
  const worldSpacing = 1000;
  if (coordinateGridLayer) map.removeLayer(coordinateGridLayer);
  coordinateGridLayer = L.layerGroup().addTo(map);

  for (let east = 0; east <= cfg.worldWidth; east += worldSpacing) {
    L.polyline([
      gameToLeaflet(east, 0, mapName),
      gameToLeaflet(east, cfg.worldHeight, mapName),
    ], {
      color: 'rgba(255, 255, 255, 0.2)',
      weight: 1,
      interactive: false
    }).addTo(coordinateGridLayer);

    if (east % 2000 === 0 && east > 0 && east < cfg.worldWidth) {
      L.marker(gameToLeaflet(east, 100, mapName), {
        icon: L.divIcon({
          className: 'grid-label',
          html: '<span style="color: white; font-size: 11px; text-shadow: 1px 1px 3px black; background: rgba(0,0,0,0.6); padding: 2px 5px; border-radius: 3px;">' + east + 'm</span>',
          iconSize: [50, 20]
        }),
        interactive: false
      }).addTo(coordinateGridLayer);
    }
  }

  for (let north = 0; north <= cfg.worldHeight; north += worldSpacing) {
    L.polyline([
      gameToLeaflet(0, north, mapName),
      gameToLeaflet(cfg.worldWidth, north, mapName),
    ], {
      color: 'rgba(255, 255, 255, 0.2)',
      weight: 1,
      interactive: false
    }).addTo(coordinateGridLayer);
  }
}

async function loadServers() {
  try {
    console.log('🔍 [MAP] Loading servers...');

    // Step 1: Get user's guilds
    const guildsRes = await fetch('/api/user/moderatable-guilds');
    console.log('📡 [MAP] Guilds response status:', guildsRes.status);

    const guildsData = await guildsRes.json();
    console.log('📦 [MAP] Guilds data:', guildsData);

    if (!guildsData.success || !guildsData.guilds || guildsData.guilds.length === 0) {
      console.warn('⚠️ [MAP] No guilds available — player map mode');
      await enterPlayerMode();
      return;
    }

    // Step 2: Get servers for each guild
    const allServers = [];

    for (const guild of guildsData.guilds) {
      console.log('🔍 [MAP] Fetching servers for guild:', guild.name, guild.id);

      const serversRes = await fetch(`/api/guilds/${guild.id}/servers?scope=moderate`);
      console.log('📡 [MAP] Servers response status:', serversRes.status);

      const serversData = await serversRes.json();
      console.log('📦 [MAP] Servers data for', guild.name, ':', serversData);

      if (serversData.success && serversData.servers) {
        serversData.servers.forEach(server => {
          server.guildId = guild.id;
          server.guildName = guild.name;
        });
        allServers.push(...serversData.servers);
      }
    }

    console.log('✅ [MAP] Total servers loaded:', allServers.length);

    const data = { servers: allServers, success: true };

    const select = document.getElementById('server-select');
    select.innerHTML = '<option value="">Select Server...</option>';

    if (data.servers && data.servers.length > 0) {
      data.servers.forEach(function(server) {
        const option = document.createElement('option');
        option.value = server.nitrado_server_id;
        option.dataset.guildId = String(server.guildId);
        option.dataset.internalServerId = String(server.id);
        option.textContent = (server.server_name) + ' (' + server.nitrado_server_id + ')';
        select.appendChild(option);
      });
    }

    // Shared-URL restore: ?server=<nitrado id> selects that server through
    // the same path as a manual selection.
    const urlServer = new URLSearchParams(window.location.search).get('server');
    if (urlServer && select.value !== urlServer &&
        Array.from(select.options).some(option => option.value === urlServer)) {
      select.value = urlServer;
      select.dispatchEvent(new Event('change'));
    } else if (!urlServer && select.options.length > 1) {
      // Default to the current server so the page opens on it: prefer the
      // server with the most recent online-player activity, else the first.
      select.value = defaultServerValue(data.servers);
      select.dispatchEvent(new Event('change'));
    }
  } catch (err) {
    console.error('Failed to load servers:', err);
  }
}

// Player map mode: the user moderates no server, so the staff data sources
// (operations overlay, heatmaps, event health, spawn rail) are hidden and
// the page serves the loot-finder layer over static terrain. Servers come
// from the registry (every guild the user belongs to — same source the
// former standalone loot finder used); maps fall back to the known catalog
// when the server-scoped endpoints deny access (403), mirroring that page's
// graceful degradation. Staff endpoints are never requested here.
async function enterPlayerMode() {
  playerMapMode = true;
  document.querySelectorAll('#map-panel section[data-staff-only]').forEach(function (s) { s.hidden = true; });

  const select = document.getElementById('server-select');
  select.innerHTML = '<option value="">Loading servers...</option>';

  let servers = [];
  try {
    const res = await fetch('/api/nitrado/registered-servers');
    const data = await res.json();
    servers = (data && Array.isArray(data.servers)) ? data.servers : [];
  } catch (err) {
    select.innerHTML = '<option value="">Failed to load servers</option>';
    console.error('Failed to load servers:', err);
    return;
  }

  if (servers.length === 0) {
    select.innerHTML = '<option value="">No servers available</option>';
    return;
  }

  // Group servers by guild (same <optgroup> layout as the staff path)
  const guilds = new Map();
  for (const s of servers) {
    const key = String(s.guild_id);
    if (!guilds.has(key)) guilds.set(key, safeTextValue(s.guild_name, 'Unknown Guild'));
  }
  select.innerHTML = '<option value="">Select Server...</option>';
  for (const [guildKey, guildName] of guilds) {
    const group = document.createElement('optgroup');
    group.label = guildName;
    for (const s of servers.filter(sv => String(sv.guild_id) === guildKey)) {
      const option = document.createElement('option');
      option.value = String(s.nitrado_server_id);
      option.textContent = (s.server_name || '') + ' (' + s.nitrado_server_id + ')';
      group.appendChild(option);
    }
    select.appendChild(group);
  }

  // Shared-URL restore, else default to the first registered server.
  const urlServer = new URLSearchParams(window.location.search).get('server');
  if (urlServer && Array.from(select.options).some(o => o.value === urlServer)) {
    select.value = urlServer;
  } else {
    select.value = String(servers[0].nitrado_server_id);
  }
  if (!select.value) return;
  if (window.MapLootLayer) window.MapLootLayer.onServerChange(select.value);
  await loadPlayerMapsForServer(select.value);
}

function safeTextValue(value, fallback) {
  return (value === null || value === undefined) ? fallback : String(value);
}

// Player-mode map select: configured map (Nitrado active mission) preferred,
// available mission directories second, full catalog as the fallback when the
// server-scoped endpoints deny access.
async function loadPlayerMapsForServer(serverId) {
  const select = document.getElementById('map-select');
  select.innerHTML = '<option value="">Loading...</option>';

  let availableMaps = [];
  try {
    const res = await fetch('/api/server-maps/' + encodeURIComponent(serverId));
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.maps)) availableMaps = data.maps;
    }
  } catch (err) {
    console.warn('[MAP] Could not load server maps:', err.message);
  }

  const configuredMap = window.MapLootLayer
    ? await window.MapLootLayer.configuredMapFor(serverId) : null;

  let mapOptions = availableMaps.length > 0 ? availableMaps : Object.keys(mapConfigs);
  if (configuredMap && mapOptions.includes(configuredMap) && mapOptions[0] !== configuredMap) {
    mapOptions = [configuredMap, ...mapOptions.filter(m => m !== configuredMap)];
  }

  select.innerHTML = '<option value="">Select Map...</option>';
  for (const m of mapOptions) {
    const option = document.createElement('option');
    option.value = m;
    option.textContent = (mapConfigs[m] ? mapConfigs[m].name : m) + (m === configuredMap ? ' ⭐ ACTIVE' : '');
    if (m === configuredMap) option.selected = true;
    select.appendChild(option);
  }

  // Shared-URL restore overrides the preselected configured map.
  const urlMap = new URLSearchParams(window.location.search).get('map');
  if (urlMap && select.value !== urlMap &&
      Array.from(select.options).some(o => o.value === urlMap)) {
    select.value = urlMap;
  }
  select.value = select.value || select.options[0].value;
  if (!select.value) return;

  currentMapName = select.value;
  initMap(select.value);
  if (window.MapLootLayer) window.MapLootLayer.onMapChange(select.value);
  if (window.DayzTerrainLayer) window.DayzTerrainLayer.onMapChange(select.value);
}

// Most-recently-active server: the one with the freshest online-player
// observation; the first listed server when none reports players.
function defaultServerValue(servers) {
  if (!servers || servers.length <= 1) return servers && servers.length ? servers[0].nitrado_server_id : '';
  let best = null;
  let bestAt = 0;
  for (const server of servers) {
    for (const player of server.onlinePlayers || []) {
      const at = Date.parse(player.updated_at || player.login_at || '');
      if (!Number.isNaN(at) && at > bestAt) { bestAt = at; best = server; }
    }
  }
  return (best || servers[0]).nitrado_server_id;
}

function selectedServerContext(serverId) {
  const select = document.getElementById('server-select');
  const option = select.options[select.selectedIndex];
  if (!option || String(option.value) !== String(serverId) || String(currentServer) !== String(serverId)) return null;
  return option.dataset.guildId && option.dataset.internalServerId
    ? { guildId: option.dataset.guildId, internalServerId: option.dataset.internalServerId }
    : null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function getActiveMission(serverId, guildId, discoveryRequestId = mapDiscoveryRequestId) {
  try {
    const res = await fetch('/api/server-active-mission/' + serverId + '?guildId=' + encodeURIComponent(guildId));
    const data = await res.json();
    if (discoveryRequestId !== mapDiscoveryRequestId || !selectedServerContext(serverId)) return null;
    
    if (data.success && data.mapName) {
      activeMapName = data.mapName;
      
      document.getElementById('active-badge').style.display = 'inline-block';
      document.getElementById('active-badge').textContent = 'Active: ' + (mapConfigs[data.mapName] ? mapConfigs[data.mapName].name : data.mapName);
      document.getElementById('active-badge').className = 'badge badge-green';
      
      document.getElementById('players-badge').style.display = 'inline-block';
      document.getElementById('players-badge').textContent = data.playerCount + '/' + data.maxPlayers + ' Players';
      
      // Update player stat
      const currentPlayers = data.playerCount;
      document.getElementById('stat-players').textContent = currentPlayers + '/' + data.maxPlayers;
      updateStatTrend('players', currentPlayers, previousStats.players);
      previousStats.players = currentPlayers;

      if (currentMapName && currentMapName !== data.mapName) {
        const mapSelect = document.getElementById('map-select');
        const activeOption = Array.from(mapSelect.options).find(option => option.value === data.mapName);
        if (activeOption) {
          contextGeneration++;
          mapDataRequestId++;
          eventHealthRequestId++;
          clearSelectedContext();
          mapSelect.value = data.mapName;
          loadMapData(serverId, data.mapName);
          loadEnabledHeatmaps();
        }
      }
      
      console.log('✓ Active mission:', data.mission, '→', data.mapName);
      activeMissionName = data.mission || null;
      return data.mapName;
    }
    
    return null;
  } catch (err) {
    console.error('Failed to get active mission:', err);
    return null;
  }
}

async function loadMapsForServer(serverId) {
  const requestId = ++mapDiscoveryRequestId;
  const serverContext = selectedServerContext(serverId);
  if (!serverContext) return;
  try {
    document.getElementById('map-select').innerHTML = '<option value="">Loading...</option>';
    
    const activeMission = await getActiveMission(serverId, serverContext.guildId, requestId);
    if (requestId !== mapDiscoveryRequestId || !selectedServerContext(serverId)) return;
    
    const res = await fetch('/api/server-maps/' + serverId + '?guildId=' + encodeURIComponent(serverContext.guildId));
    const data = await res.json();
    if (requestId !== mapDiscoveryRequestId || !selectedServerContext(serverId)) return;
    
    const select = document.getElementById('map-select');
    select.innerHTML = '<option value="">Select Map...</option>';
    
    if (data.success && data.maps && data.maps.length > 0) {
      data.maps.forEach(function(mapName) {
        const config = mapConfigs[mapName];
        const option = document.createElement('option');
        option.value = mapName;
        
        if (mapName === activeMission) {
          option.textContent = (config ? config.name : mapName) + ' ⭐ ACTIVE';
          option.selected = true;
        } else {
          option.textContent = config ? config.name : mapName;
        }
        
        select.appendChild(option);
      });
      
      if (select.options.length > 0) {
        // Shared-URL restore: ?map=<key> overrides the auto-selected
        // active-mission map through the same path as a manual selection.
        const urlMap = new URLSearchParams(window.location.search).get('map');
        if (urlMap && select.value !== urlMap &&
            Array.from(select.options).some(option => option.value === urlMap)) {
          select.value = urlMap;
          select.dispatchEvent(new Event('change'));
        } else {
          // Default to the server's currently configured map: the active
          // mission was preselected while building the options; otherwise the
          // first map available on that server.
          select.value = select.value || select.options[0].value;
          loadMapData(serverId, select.value);
          loadEnabledHeatmaps();
        }
      }
    } else {
      select.innerHTML = '<option value="">No maps found - Sync server first</option>';
    }
    
  } catch (err) {
    if (requestId !== mapDiscoveryRequestId || !selectedServerContext(serverId)) return;
    console.error('Failed to load maps:', err);
    document.getElementById('map-select').innerHTML = '<option value="">Error loading maps</option>';
  }
}

function eventHealthPriority(event) {
  const priorities = { error: 0, degraded: 1, attempted: 2, warning: 3, spawned: 4, positioned: 5, observed: 6 };
  const namePriority = /train|locked|container/i.test(event.name) ? -2 : 0;
  return namePriority + (priorities[event.status] ?? 7);
}

function renderEventHealth() {
  const results = document.getElementById('event-health-results');
  const summary = document.getElementById('event-health-summary');
  const limit = document.getElementById('event-health-limit');
  results.replaceChildren();
  if (!lastEventHealth || !lastEventHealth.success) return;

  const search = document.getElementById('event-health-search').value.trim().toLowerCase();
  const allEvents = lastEventHealth.events || [];
  const events = allEvents.filter(event => !search || event.name.toLowerCase().includes(search))
    .sort((a, b) => eventHealthPriority(a) - eventHealthPriority(b) || a.name.localeCompare(b.name))
    .slice(0, search ? 50 : 18);
  const counts = allEvents.reduce((result, event) => {
    result[event.status] = (result[event.status] || 0) + 1;
    return result;
  }, {});
  const source = lastEventHealth.sourceFile || 'no RPT retained';
  summary.textContent = `${allEvents.length} with spawn-position/runtime evidence · ${counts.spawned || 0} spawned · ` +
    `${(counts.error || 0) + (counts.degraded || 0)} need attention · source: ${source}`;
  limit.textContent = [
    lastEventHealth.presenceLimitation,
    lastEventHealth.runtimeEvidenceLimitation,
    lastEventHealth.configurationError,
  ].filter(Boolean).join(' ');

  const colors = {
    spawned: '#10b981', degraded: '#f97316', error: '#ef4444', attempted: '#eab308',
    warning: '#f59e0b', positioned: '#6b7280', observed: '#3b82f6',
  };
  for (const event of events) {
    const card = document.createElement('article');
    card.style.cssText = 'border:1px solid #4b5563;border-left:4px solid ' +
      (colors[event.status] || '#6b7280') + ';border-radius:6px;padding:10px;background:#1f2937;';
    const heading = document.createElement('div');
    heading.style.cssText = 'display:flex;justify-content:space-between;gap:8px;font-weight:600;';
    const name = document.createElement('span');
    name.textContent = event.name;
    const status = document.createElement('span');
    status.textContent = event.status;
    status.style.color = colors[event.status] || '#9ca3af';
    heading.append(name, status);

    const evidence = document.createElement('div');
    evidence.className = 'text-xs text-gray-400 mt-1';
    evidence.textContent = `${event.positions || 0} candidate positions · ${event.attempts || 0} attempts · ` +
      `${event.successfulInstances || 0} spawned instances · ${event.refusals || 0} refusals · ` +
      `${event.failures || 0} failures · ` +
      `${event.cleanupObservations || 0} cleanup signals`;
    card.append(heading, evidence);

    const latest = event.lastFailure || event.lastSuccess || event.lastAttempt;
    if (latest) {
      const detail = document.createElement('div');
      detail.className = 'text-xs text-gray-500 mt-1';
      const when = latest.observedAt ? new Date(latest.observedAt).toLocaleString() : latest.clock;
      detail.textContent = `Latest evidence: ${when || 'unknown time'}`;
      card.appendChild(detail);
    }
    if (event.diagnostics && event.diagnostics.length) {
      const diagnostic = document.createElement('div');
      diagnostic.className = 'text-xs mt-1';
      diagnostic.style.color = '#fbbf24';
      diagnostic.textContent = event.diagnostics[event.diagnostics.length - 1].message;
      card.appendChild(diagnostic);
    }
    results.appendChild(card);
  }
  if (!events.length) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-gray-400';
    empty.textContent = 'No matching event evidence.';
    results.appendChild(empty);
  }
}

async function loadEventHealth(serverId, mapName, guildId) {
  const requestId = ++eventHealthRequestId;
  const summary = document.getElementById('event-health-summary');
  if (!guildId || !selectedServerContext(serverId)) {
    summary.textContent = 'Select an exact server to check retained event evidence.';
    return;
  }
  summary.textContent = 'Checking retained RPT event evidence…';
  try {
    const response = await fetch('/api/event-health?serverId=' + encodeURIComponent(serverId) +
      '&map=' + encodeURIComponent(mapName) + '&guildId=' + encodeURIComponent(guildId));
    const result = await response.json();
    if (requestId !== eventHealthRequestId) return;
    lastEventHealth = result;
    if (!response.ok || !lastEventHealth.success) {
      summary.textContent = lastEventHealth.error || 'Event health is unavailable.';
      document.getElementById('event-health-results').replaceChildren();
      return;
    }
    renderEventHealth();
  } catch (error) {
    if (requestId !== eventHealthRequestId) return;
    console.error('Failed to load event health:', error);
    summary.textContent = 'Event health is unavailable.';
    document.getElementById('event-health-results').replaceChildren();
  }
}

async function loadMapData(serverId, mapName, isAutoRefresh = false) {
  const serverContext = selectedServerContext(serverId);
  if (!serverContext) return;
  const requestId = ++mapDataRequestId;
  const requestContextGeneration = contextGeneration;
  if (!isAutoRefresh) {
    document.getElementById('loading').style.display = 'flex';
    document.getElementById('loading-status').textContent = 'Loading map tiles...';
  }

  currentMapName = mapName;
  
  // Per server/map load: reset the holiday marker-window state (see renderHolidayWindowState).
  holidayState = null;
  holidayRowMission = null;
  holidayMarkersVisible = true;
  const holidaySubhead = document.getElementById('holiday-subhead');
  const holidayRow = document.getElementById('holiday-event-row');
  if (holidaySubhead) holidaySubhead.hidden = true;
  if (holidayRow) { holidayRow.hidden = true; holidayRow.innerHTML = ''; }
  if (!isAutoRefresh) {
    initMap(mapName);
    loadSpawnMarkers(mapName);
    loadEventHealth(serverId, mapName, serverContext.guildId);
    loadOperationsOverlay();
    loadFactionWarOverlay();
  } else {
    loadEventHealth(serverId, mapName, serverContext.guildId);
    loadOperationsOverlay();
    loadFactionWarOverlay();
  }

  // Live recently-spawned loot layer (no-op when its toggle is off)
  loadRecentLootSpawns();

  try {
    if (!isAutoRefresh) {
      document.getElementById('loading-status').textContent = 'Loading event spawn locations...';
    }
    
    // Clear existing markers
    Object.values(markers).forEach(function(marker) {
      marker.remove();
    });
    markers = {};
    allEventData = [];

    // Load event spawns
    // Pass the active mission folder so multi-mission maps (base + holiday pack)
    // resolve the ambiguity to the live mission instead of erroring.
    const missionParam = activeMissionName ? '&mission=' + encodeURIComponent(activeMissionName) : '';
    const eventSpawnsRes = await fetch('/api/event-spawns/' + serverId + '/' + mapName +
      '?guildId=' + encodeURIComponent(serverContext.guildId) + missionParam);
    const eventSpawnsData = await eventSpawnsRes.json();
    if (requestId !== mapDataRequestId || requestContextGeneration !== contextGeneration || !selectedServerContext(serverId)) return;

    if (eventSpawnsData.success && eventSpawnsData.events) {
      let markerCount = 0;
      
      const mapConfig = mapConfigs[mapName] || mapConfigs['enoch'];
      const scale = DayzMapCoordinates.pixelsPerWorldUnit(mapName);

      console.log('🗺️  Map: ' + mapName + ', Game size: ' + mapConfig.worldWidth + ', Scale: ' + scale.toFixed(3));
      
      const eventTypes = {};
      
      eventSpawnsData.events.forEach(function(event) {
        const eventName = event.name;
        const color = getEventColor(eventName);
        
        if (!eventTypes[eventName]) {
          eventTypes[eventName] = {
            count: 0,
            color: color
          };
        }
        
        event.positions.forEach(function(pos, i) {
          const latlng = gameToLeaflet(pos.x, pos.z, mapName);
          const tileX = latlng[1];
          const tileZ = latlng[0];
          
          const markerRadius = 8;
          const markerWeight = 2;
          
          const marker = L.circleMarker([tileZ, tileX], {
            radius: markerRadius,
            fillColor: color,
            color: '#fff',
            weight: markerWeight,
            opacity: 1,
            fillOpacity: 0.9
          })
            .addTo(map)
            .bindPopup('<div class="text-gray-900"><strong style="font-size: 14px;">' + escapeHtml(eventName) + '</strong><br>Game XML: ' + pos.x.toFixed(2) + ', ' + pos.z.toFixed(2) + '<br>Tile: ' + tileX.toFixed(2) + ', ' + tileZ.toFixed(2) + '<br>Angle: ' + (pos.a || 0).toFixed(2) + '°</div>');
          
          marker.on('click', function(e) {
            if (!radiusSearchMode) {
              map.setView([tileZ, tileX], 1);
            }
          });
          
          const markerId = 'event_' + eventName + '_' + i;
          markers[markerId] = marker;
          
          allEventData.push({
            id: markerId,
            name: eventName,
            marker: marker,
            tileX: tileX,
            tileZ: tileZ,
            gameX: pos.x,
            gameZ: pos.z,
            color: color
          });
          
          markerCount++;
          eventTypes[eventName].count++;
        });
      });
      
      console.log('✓ Loaded ' + markerCount + ' event spawn locations');
      
      if (!isAutoRefresh) {
        initializeEventTypeFilters(eventTypes);
      } else {
        // Just update the counts in existing filters
        Object.entries(eventTypes).forEach(function([eventName, data]) {
          const checkbox = document.getElementById('filter_' + eventName);
          if (checkbox) {
            const label = checkbox.nextElementSibling;
            if (label) {
              const textNode = label.childNodes[label.childNodes.length - 1];
              if (textNode) {
                textNode.textContent = eventName + ' (' + data.count + ')';
              }
            }
          }
        });
      }
      
      updateFilterStats();
      renderHolidayWindowState(requestId);
      
      // Update stats with trends
      updateStatTrend('spawns', markerCount, previousStats.spawns);
      updateStatTrend('events', eventSpawnsData.events.length, previousStats.events);
      
      previousStats.spawns = markerCount;
      previousStats.events = eventSpawnsData.events.length;
      
      document.getElementById('stat-spawns').textContent = markerCount;
      document.getElementById('stat-events').textContent = eventSpawnsData.events.length;
      
      // Update last refresh time
      const now = new Date();
      document.getElementById('last-update-time').textContent = now.toLocaleTimeString();
    } else {
      document.getElementById('stat-spawns').textContent = '0';
      document.getElementById('stat-events').textContent = '0';
    }

    const mapConfig = mapConfigs[mapName] || mapConfigs.enoch;
    document.getElementById('stat-size').textContent = mapConfig.gameSize + 'm';
    
    const isActive = mapName === activeMapName ? ' (ACTIVE)' : '';
    // Surface API evidence notes (e.g. a holiday pack that is an economy delta
    // with no new markers) instead of a silent zero-marker map.
    const evidenceNote = (!eventSpawnsData.success && eventSpawnsData.message)
      ? ' — ' + eventSpawnsData.message : '';
    document.getElementById('server-info').textContent = mapConfig.name + isActive + ' - High Resolution Satellite View' + evidenceNote;
    
    if (!isAutoRefresh) {
      document.getElementById('loading').style.display = 'none';
    }

  } catch (err) {
    if (requestId !== mapDataRequestId || requestContextGeneration !== contextGeneration || !selectedServerContext(serverId)) return;
    console.error('Failed to load map data:', err);
    if (!isAutoRefresh) {
      document.getElementById('loading').style.display = 'none';
    }
    
    const mapConfig = mapConfigs[mapName] || mapConfigs['enoch'];
    document.getElementById('server-info').textContent = mapConfig.name + ' - Satellite View';
  }
}

function updateStatTrend(statName, currentValue, previousValue) {
  const trendElement = document.getElementById('stat-' + statName + '-trend');
  if (!trendElement) return;
  
  const diff = currentValue - previousValue;
  
  if (diff > 0) {
    trendElement.className = 'stat-trend up';
    trendElement.innerHTML = '▲ +' + diff + ' from last update';
  } else if (diff < 0) {
    trendElement.className = 'stat-trend down';
    trendElement.innerHTML = '▼ ' + diff + ' from last update';
  } else {
    trendElement.className = 'stat-trend neutral';
    trendElement.innerHTML = '— No change';
  }
}

function initializeEventTypeFilters(eventTypes) {
  const container = document.getElementById('event-type-filters');
  container.innerHTML = '';
  
  eventTypeFilters = {};
  
  const sorted = Object.entries(eventTypes).sort((a, b) => b[1].count - a[1].count);
  
  const buttonContainer = document.createElement('div');
  buttonContainer.style.marginBottom = '8px';
  buttonContainer.style.display = 'flex';
  buttonContainer.style.gap = '4px';
  buttonContainer.style.flexWrap = 'wrap';
  
  const selectAllBtn = document.createElement('button');
  selectAllBtn.textContent = '✓ All';
  selectAllBtn.className = 'btn-small btn-success';
  selectAllBtn.onclick = selectAllEventTypes;
  
  const deselectAllBtn = document.createElement('button');
  deselectAllBtn.textContent = '✕ None';
  deselectAllBtn.className = 'btn-small btn-danger';
  deselectAllBtn.onclick = deselectAllEventTypes;
  
  const resetColorsBtn = document.createElement('button');
  resetColorsBtn.textContent = '🎨 Reset Colors';
  resetColorsBtn.className = 'btn-small';
  resetColorsBtn.style.background = '#f59e0b';
  resetColorsBtn.style.color = 'white';
  resetColorsBtn.title = 'Reset all colors to auto-generated';
  resetColorsBtn.onclick = resetAllColors;
  
  buttonContainer.appendChild(selectAllBtn);
  buttonContainer.appendChild(deselectAllBtn);
  buttonContainer.appendChild(resetColorsBtn);
  container.appendChild(buttonContainer);
  
  sorted.forEach(function([eventName, data]) {
    eventTypeFilters[eventName] = true;
    
    const div = document.createElement('div');
    div.className = 'filter-checkbox';
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.gap = '6px';
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'filter_' + eventName;
    checkbox.checked = true;
    checkbox.onchange = function() {
      eventTypeFilters[eventName] = checkbox.checked;
      applyFilters();
    };
    
    const label = document.createElement('label');
    label.htmlFor = 'filter_' + eventName;
    label.style.flex = '1';
    label.style.cursor = 'pointer';
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '6px';
    
    const colorDot = document.createElement('span');
    colorDot.className = 'color-dot';
    colorDot.style.background = data.color;
    colorDot.id = 'dot_' + eventName;
    
    label.appendChild(colorDot);
    label.appendChild(document.createTextNode(eventName + ' (' + data.count + ')'));
    
    const colorPicker = document.createElement('input');
    colorPicker.type = 'color';
    colorPicker.value = rgbToHex(data.color);
    colorPicker.setAttribute('data-event', eventName);
    colorPicker.style.width = '30px';
    colorPicker.style.height = '24px';
    colorPicker.style.border = 'none';
    colorPicker.style.cursor = 'pointer';
    colorPicker.style.borderRadius = '4px';
    colorPicker.title = 'Change color';
    colorPicker.onchange = function() {
      saveEventColor(eventName, colorPicker.value);
      updateEventColors(eventName, colorPicker.value);
    };
    
    const resetBtn = document.createElement('button');
    resetBtn.textContent = '↺';
    resetBtn.title = 'Reset to auto color';
    resetBtn.className = 'btn-small';
    resetBtn.style.padding = '2px 6px';
    resetBtn.style.fontSize = '14px';
    resetBtn.style.background = '#4b5563';
    resetBtn.style.color = 'white';
    resetBtn.style.minWidth = '24px';
    resetBtn.onclick = function() {
      resetEventColor(eventName);
      const autoColor = getEventColor(eventName);
      colorPicker.value = rgbToHex(autoColor);
      updateEventColors(eventName, autoColor);
    };
    
    div.appendChild(checkbox);
    div.appendChild(label);
    div.appendChild(colorPicker);
    div.appendChild(resetBtn);
    container.appendChild(div);
  });

  // Shared-URL restore: ?filters=<hidden event types, comma list>.
  const urlFilters = new URLSearchParams(window.location.search).get('filters');
  if (urlFilters) {
    urlFilters.split(',').map(s => s.trim()).filter(Boolean).forEach(function (name) {
      if (Object.prototype.hasOwnProperty.call(eventTypeFilters, name)) {
        eventTypeFilters[name] = false;
        const checkbox = document.getElementById('filter_' + name);
        if (checkbox) checkbox.checked = false;
      }
    });
    applyFilters();
  }
}

/* Holiday event marker windows (roadmap P1): when the active mission is a
   holiday pack, its marker set defaults to on/off per the live window from
   /data/holiday-windows.json; the row checkbox gates visibility. */
async function renderHolidayWindowState(requestId) {
  const subhead = document.getElementById('holiday-subhead');
  const row = document.getElementById('holiday-event-row');
  if (!subhead || !row) return;
  let state = null;
  try {
    const config = await window.HolidayWindows.load();
    state = window.HolidayWindows.matchState(config.events, activeMissionName);
  } catch (err) {
    console.warn('Holiday window config unavailable:', err.message);
  }
  if (requestId !== mapDataRequestId) return;
  holidayState = state;
  if (!state) {
    subhead.hidden = true;
    row.hidden = true;
    return;
  }
  // First render for this mission: default the gate to the window state.
  if (holidayRowMission !== activeMissionName) {
    holidayRowMission = activeMissionName;
    holidayMarkersVisible = state.live;
    // Shared-URL restore: an explicit ?rail=evt:<id> path forces the event on.
    if (mapUrlState && mapUrlState.rail.has('evt:' + state.id)) holidayMarkersVisible = true;
  }
  subhead.hidden = false;
  row.hidden = false;
  row.innerHTML = ''; // empty reset only; content below is built with textContent
  const div = document.createElement('div');
  div.className = 'filter-checkbox';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = holidayMarkersVisible;
  checkbox.onchange = function() {
    holidayMarkersVisible = checkbox.checked;
    applyFilters();
  };
  const label = document.createElement('label');
  const nextWindow = (state.windows || []).find(w => window.HolidayWindows.dayStartLocal(w[0]) > Date.now());
  label.textContent = state.icon + ' ' + state.label + ' — ' +
    (state.live
      ? 'LIVE (window ' + state.start + ' → ' + state.end + ')'
      : 'expired (' + (nextWindow ? 'next window ' + nextWindow[0] + ' → ' + nextWindow[1] : 'no window configured') + ')');
  div.appendChild(checkbox);
  div.appendChild(label);
  row.appendChild(div);
  if (!holidayMarkersVisible) {
    applyFilters();
  }
}

function applyFilters() {
  let visibleCount = 0;
  let hiddenCount = 0;
  
  allEventData.forEach(function(event) {
    const shouldShow = eventTypeFilters[event.name] && (!holidayState || holidayMarkersVisible);
    
    if (shouldShow) {
      if (!map.hasLayer(event.marker)) {
        event.marker.addTo(map);
      }
      visibleCount++;
    } else {
      if (map.hasLayer(event.marker)) {
        map.removeLayer(event.marker);
      }
      hiddenCount++;
    }
  });
  
  updateFilterStats();
  renderMapLegend();
  syncMapUrl();
}

function updateFilterStats() {
  const total = allEventData.length;
  const visible = allEventData.filter(e => eventTypeFilters[e.name] && (!holidayState || holidayMarkersVisible)).length;
  const hidden = total - visible;
  
  document.getElementById('filter-stat-total').textContent = total;
  document.getElementById('filter-stat-visible').textContent = visible;
  document.getElementById('filter-stat-hidden').textContent = hidden;
}

function selectAllEventTypes() {
  Object.keys(eventTypeFilters).forEach(function(key) {
    eventTypeFilters[key] = true;
    const checkbox = document.getElementById('filter_' + key);
    if (checkbox) checkbox.checked = true;
  });
  applyFilters();
}

function deselectAllEventTypes() {
  Object.keys(eventTypeFilters).forEach(function(key) {
    eventTypeFilters[key] = false;
    const checkbox = document.getElementById('filter_' + key);
    if (checkbox) checkbox.checked = false;
  });
  applyFilters();
}

function searchEvents() {
  const query = document.getElementById('search-input').value.toLowerCase();
  const resultsContainer = document.getElementById('search-results');
  
  if (query.length < 2) {
    resultsContainer.innerHTML = '';
    return;
  }
  
  const matches = allEventData.filter(function(event) {
    return event.name.toLowerCase().includes(query);
  });
  
  if (matches.length === 0) {
    resultsContainer.innerHTML = '<div style="padding: 8px; color: #9ca3af;">No results found</div>';
    return;
  }
  
  resultsContainer.innerHTML = '';
  
  matches.slice(0, 10).forEach(function(event) {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.onclick = function() {
      map.setView([event.tileZ, event.tileX], 1);
      event.marker.openPopup();
    };
    
    const colorDot = document.createElement('span');
    colorDot.className = 'color-dot';
    colorDot.style.background = event.color;
    
    const text = document.createElement('span');
    text.textContent = event.name;
    
    const coords = document.createElement('span');
    coords.style.fontSize = '11px';
    coords.style.color = '#9ca3af';
    coords.textContent = '(' + event.gameX.toFixed(0) + ', ' + event.gameZ.toFixed(0) + ')';
    
    div.appendChild(colorDot);
    div.appendChild(text);
    div.appendChild(coords);
    resultsContainer.appendChild(div);
  });
  
  if (matches.length > 10) {
    const more = document.createElement('div');
    more.style.padding = '8px';
    more.style.color = '#9ca3af';
    more.style.fontSize = '11px';
    more.textContent = '+ ' + (matches.length - 10) + ' more results...';
    resultsContainer.appendChild(more);
  }
}

function startRadiusSearch() {
  radiusSearchMode = true;
  document.getElementById('radius-btn').style.display = 'none';
  document.getElementById('cancel-radius-btn').style.display = 'inline-block';
  document.getElementById('radius-results').textContent = '📍 Click anywhere on the map...';
  map.getContainer().classList.add('radius-mode');
}

function cancelRadiusSearch() {
  radiusSearchMode = false;
  document.getElementById('radius-btn').style.display = 'inline-block';
  document.getElementById('cancel-radius-btn').style.display = 'none';
  document.getElementById('radius-results').textContent = '';
  map.getContainer().classList.remove('radius-mode');
  
  if (radiusCircle) {
    map.removeLayer(radiusCircle);
    radiusCircle = null;
  }
  if (radiusMarker) {
    map.removeLayer(radiusMarker);
    radiusMarker = null;
  }
}

function onMapClick(e) {
  if (!radiusSearchMode) return;
  
  const clickTileX = e.latlng.lng;
  const clickTileZ = e.latlng.lat;
  
  const radius = parseInt(document.getElementById('radius-input').value) || 500;
  
  const scale = DayzMapCoordinates.pixelsPerWorldUnit(currentMapName);
  const radiusTile = radius * scale;
  
  if (radiusCircle) map.removeLayer(radiusCircle);
  if (radiusMarker) map.removeLayer(radiusMarker);
  
  radiusCircle = L.circle([clickTileZ, clickTileX], {
    radius: radiusTile,
    fillColor: '#3b82f6',
    fillOpacity: 0.1,
    color: '#3b82f6',
    weight: 2
  }).addTo(map);
  
  radiusMarker = L.circleMarker([clickTileZ, clickTileX], {
    radius: 8,
    fillColor: '#3b82f6',
    color: '#fff',
    weight: 2,
    fillOpacity: 1
  }).addTo(map);
  
  const eventsInRadius = allEventData.filter(function(event) {
    const dx = event.tileX - clickTileX;
    const dz = event.tileZ - clickTileZ;
    const distance = Math.sqrt(dx * dx + dz * dz);
    return distance <= radiusTile;
  });
  
  const grouped = {};
  eventsInRadius.forEach(function(event) {
    if (!grouped[event.name]) {
      grouped[event.name] = 0;
    }
    grouped[event.name]++;
  });

  const results = document.getElementById('radius-results');
  const summary = document.createElement('span');
  summary.textContent = `✅ Found ${eventsInRadius.length} events:`;
  results.replaceChildren(summary);
  results.appendChild(document.createElement('br'));
  Object.entries(grouped).forEach(function([name, count]) {
    const marker = document.createElement('span');
    marker.style.color = getEventColor(name);
    marker.textContent = '●';
    results.append(marker, document.createTextNode(` ${name} (${count})`), document.createElement('br'));
  });

  radiusSearchMode = false;
  document.getElementById('radius-btn').style.display = 'inline-block';
  document.getElementById('cancel-radius-btn').style.display = 'none';
  map.getContainer().classList.remove('radius-mode');
}

function formatObservationTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : 'unknown time';
}

function operationsPopup(title, lines) {
  return '<strong>' + escapeHtml(title) + '</strong><br>' + lines
    .filter(Boolean)
    .map(line => escapeHtml(line))
    .join('<br>');
}

function addOperationsPoint(group, item, options, title, lines) {
  if (!item.position) return null;
  const marker = L.circleMarker(gameToLeaflet(item.position.east, item.position.north, currentMapName), options);
  marker.bindPopup(operationsPopup(title, lines));
  marker.addTo(group);
  return marker;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function playerMetricLines(player) {
  const stats = player.stats || {};
  const ratio = stats.killDeathRatio === null || stats.killDeathRatio === undefined
    ? '—'
    : Number(stats.killDeathRatio).toFixed(2);
  return [
    `${Number(stats.kills || 0)} kills · ${Number(stats.deaths || 0)} deaths · K/D ${ratio}`,
    `${formatDuration(stats.totalPlaytimeSeconds)} tracked · ${Number(stats.totalSessions || 0)} sessions`,
    `${formatDuration(stats.currentSessionSeconds)} this session`,
  ];
}

function appendPlayerText(parent, text, className) {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function onlinePlayerDraftKey(serverId, identityId) {
  return `${serverId}:${identityId}`;
}

function setOnlinePlayerNoteSaveUi(identityId, saving, message) {
  const textarea = document.getElementById(`online-player-note-${identityId}`);
  const button = document.getElementById(`online-player-note-save-${identityId}`);
  const feedback = document.getElementById(`online-player-note-status-${identityId}`);
  if (textarea) textarea.disabled = saving;
  if (button) button.disabled = saving;
  if (feedback && message) feedback.textContent = message;
}

async function saveOnlinePlayerNote(player, textarea, requestContext) {
  const serverContext = selectedServerContext(currentServer);
  if (!serverContext || String(serverContext.internalServerId) !== String(requestContext.serverId) ||
      contextGeneration !== requestContext.generation) return;
  const draftKey = onlinePlayerDraftKey(requestContext.serverId, player.identityId);
  if (onlinePlayerNoteSaveCoordinator.isPending(draftKey)) return;
  const saveAttempt = onlinePlayerAdminState.captureSaveAttempt({
    serverId: requestContext.serverId,
    identityId: player.identityId,
    generation: requestContext.generation,
    note: textarea.value,
    expectedVersion: player.staffNote.version,
  });
  const isCurrent = () => {
    const currentContext = selectedServerContext(currentServer);
    return onlinePlayerAdminState.isCurrentServer(saveAttempt, currentContext?.internalServerId);
  };
  setOnlinePlayerNoteSaveUi(player.identityId, true, 'Saving…');
  await onlinePlayerNoteSaveCoordinator.run({
    key: draftKey,
    attempt: saveAttempt,
    isCurrent,
    request: async () => {
      const response = await fetchWithCsrf(
        `/api/operations-map/${encodeURIComponent(requestContext.serverId)}/players/` +
          `${encodeURIComponent(player.identityId)}/note`,
        {
          method: 'PATCH',
          body: JSON.stringify({ note: saveAttempt.note, expectedVersion: saveAttempt.expectedVersion }),
        }
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) {
        const error = new Error(result.error || 'Failed to save player note');
        error.refreshRequired = error.message.includes('refresh');
        throw error;
      }
      player.staffNote = result.staffNote;
      const currentDraft = onlinePlayerNoteDrafts.has(draftKey)
        ? onlinePlayerNoteDrafts.get(draftKey)
        : saveAttempt.note;
      if (onlinePlayerAdminState.shouldDiscardDraft(saveAttempt, currentDraft)) {
        onlinePlayerNoteDrafts.delete(draftKey);
      }
    },
    refresh: loadOperationsOverlay,
    onSettled: error => setOnlinePlayerNoteSaveUi(player.identityId, false, error ? error.message : 'Saved'),
  });
}

function renderOnlinePlayerList(players, requestContext) {
  const list = document.getElementById('online-player-list');
  const summary = document.getElementById('online-player-summary');
  list.replaceChildren();
  summary.textContent = `${players.length} online · ${players.filter(player => player.position).length} positioned`;
  if (!players.length) {
    appendPlayerText(list, 'No fresh online-player roster is available.', 'text-sm text-gray-400');
    return;
  }

  for (const player of players) {
    const card = document.createElement('article');
    card.className = 'bg-gray-900 border border-gray-700 rounded p-3';
    const header = document.createElement('div');
    header.className = 'flex justify-between items-start gap-2';
    const name = document.createElement('strong');
    name.textContent = player.gamertag;
    header.appendChild(name);
    if (player.position) {
      const locate = document.createElement('button');
      locate.type = 'button';
      locate.className = 'btn-small btn-primary';
      locate.textContent = 'Locate';
      locate.setAttribute('aria-label', `Locate ${player.gamertag} on map`);
      locate.addEventListener('click', () => {
        document.getElementById('operations-player-toggle').checked = true;
        applyOperationsLayerVisibility();
        map.setView(gameToLeaflet(player.position.east, player.position.north, currentMapName), Math.max(map.getZoom(), 2));
        operationsPlayerMarkers.get(player.identityId)?.openPopup();
      });
      header.appendChild(locate);
    }
    card.appendChild(header);
    for (const line of playerMetricLines(player)) appendPlayerText(card, line, 'text-xs text-gray-300 mt-1');
    appendPlayerText(card, player.position
      ? `${player.positionFresh ? 'Recent' : 'Stale'} position · X ${Math.round(player.position.east)} · Z ${Math.round(player.position.north)}`
      : 'No position observed in the active server session', 'text-xs text-gray-400 mt-1');

    const textarea = document.createElement('textarea');
    const noteInputId = `online-player-note-${player.identityId}`;
    const noteLabel = document.createElement('label');
    noteLabel.className = 'sr-only';
    noteLabel.htmlFor = noteInputId;
    noteLabel.textContent = `Private staff note for ${player.gamertag}`;
    card.appendChild(noteLabel);
    textarea.id = noteInputId;
    textarea.className = 'search-box mt-2';
    textarea.rows = 2;
    textarea.maxLength = 1000;
    textarea.placeholder = 'Private staff note';
    const draftKey = onlinePlayerDraftKey(requestContext.serverId, player.identityId);
    const savePending = onlinePlayerNoteSaveCoordinator.isPending(draftKey);
    textarea.value = onlinePlayerNoteDrafts.has(draftKey)
      ? onlinePlayerNoteDrafts.get(draftKey)
      : (player.staffNote?.text || '');
    textarea.disabled = savePending;
    textarea.addEventListener('input', () => onlinePlayerNoteDrafts.set(draftKey, textarea.value));
    card.appendChild(textarea);
    const controls = document.createElement('div');
    controls.className = 'flex justify-between items-center gap-2 mt-2';
    const feedback = document.createElement('span');
    feedback.className = 'text-xs text-gray-400';
    feedback.id = `online-player-note-status-${player.identityId}`;
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    feedback.textContent = savePending ? 'Saving…' : (player.staffNote?.updatedAt
      ? `Updated ${formatObservationTime(player.staffNote.updatedAt)}${player.staffNote.updatedBy ? ` by ${player.staffNote.updatedBy}` : ''}`
      : 'No staff note');
    const save = document.createElement('button');
    save.type = 'button';
    save.id = `online-player-note-save-${player.identityId}`;
    save.className = 'btn-small btn-success';
    save.textContent = 'Save note';
    save.disabled = savePending;
    save.setAttribute('aria-label', `Save private staff note for ${player.gamertag}`);
    save.addEventListener('click', () => saveOnlinePlayerNote(player, textarea, requestContext));
    controls.append(feedback, save);
    card.appendChild(controls);
    list.appendChild(card);
  }
}

function buildOperationsLayers(snapshot) {
  const next = {
    players: L.layerGroup(), events: L.layerGroup(), purchases: L.layerGroup(),
    territory: L.layerGroup(), zones: L.layerGroup(), factions: L.layerGroup(),
    factionTerritories: L.layerGroup(),
  };

  operationsPlayerMarkers.clear();
  for (const player of snapshot.onlinePlayers || []) {
    if (!player.position) continue;
    const marker = addOperationsPoint(next.players, player, {
      radius: 8, color: player.positionFresh ? '#22c55e' : '#f59e0b', weight: 3,
      fillColor: player.positionFresh ? '#16a34a' : '#d97706', fillOpacity: 0.85,
    }, `Online player: ${player.gamertag}`, [
      player.positionFresh ? 'Recent position evidence' : 'Stale position evidence',
      ...playerMetricLines(player),
      player.staffNote?.text ? `Staff note: ${player.staffNote.text}` : null,
      `Observed: ${formatObservationTime(player.positionObservedAt)}`,
      `X ${Math.round(player.position.east)} · Z ${Math.round(player.position.north)}`,
    ]);
    if (marker) operationsPlayerMarkers.set(player.identityId, marker);
  }

  const eventStyles = {
    kill: { color: '#ef4444', fillColor: '#dc2626' },
    death: { color: '#a855f7', fillColor: '#9333ea' },
    damage: { color: '#f97316', fillColor: '#ea580c' },
  };
  for (const event of snapshot.recentEvents || []) {
    const style = eventStyles[event.type] || eventStyles.damage;
    addOperationsPoint(next.events, event, {
      radius: event.type === 'kill' ? 7 : 5, color: style.color, fillColor: style.fillColor,
      weight: 2, fillOpacity: 0.75,
    }, event.type.toUpperCase(), [
      `${event.actor || 'Unknown'} → ${event.subject || 'Unknown'}`,
      event.detail,
      formatObservationTime(event.timestamp),
    ]);
  }

  for (const purchase of snapshot.purchases || []) {
    addOperationsPoint(next.purchases, purchase, {
      radius: 7, color: '#38bdf8', fillColor: '#0284c7', weight: 2, fillOpacity: 0.8,
    }, `Purchase: ${purchase.itemName}`, [
      `${purchase.gamertag} · quantity ${purchase.quantity}`,
      `${purchase.lifecycleState} · presence unknown`,
      formatObservationTime(purchase.completedAt),
    ]);
  }

  for (const observation of snapshot.territoryObservations || []) {
    addOperationsPoint(next.territory, observation, {
      radius: 6, color: '#facc15', fillColor: '#ca8a04', weight: 2, fillOpacity: 0.75,
    }, `${observation.eventType}: ${observation.structureType}`, [
      observation.gamertag,
      [observation.structurePart, observation.toolUsed].filter(Boolean).join(' · '),
      'Historical observation; current object presence unknown',
      formatObservationTime(observation.timestamp),
    ]);
  }

  const radiusScale = DayzMapCoordinates.pixelsPerWorldUnit(currentMapName);
  for (const zone of snapshot.zones || []) {
    const color = zone.status === 'confirmed' ? '#ef4444' : zone.status === 'pending' ? '#f59e0b' : '#6b7280';
    const circle = L.circle(gameToLeaflet(zone.position.east, zone.position.north, currentMapName), {
      radius: zone.radiusMeters * radiusScale,
      color, fillColor: color, weight: 2, fillOpacity: zone.status === 'dismissed' ? 0.04 : 0.12,
      dashArray: zone.status === 'confirmed' ? null : '6 5',
    });
    circle.bindPopup(operationsPopup(zone.label || 'Review zone', [
      `${zone.status} · ${zone.type}`,
      `${Math.round(zone.radiusMeters)}m radius · ${zone.evidenceCount} evidence records`,
      `Evidence: ${formatObservationTime(zone.evidenceObservedAt)}`,
    ])).addTo(next.zones);
  }

  for (const marker of snapshot.factionMarkers || []) {
    addOperationsPoint(next.factions, marker, {
      radius: 7, color: '#2dd4bf', fillColor: '#0f766e', weight: 2, fillOpacity: 0.8,
    }, `${marker.icon || '📍'} ${marker.title}`, [
      marker.factionName,
      marker.note,
      'Faction annotation; not territory ownership',
    ]);
  }
  for (const territory of snapshot.factionTerritories || []) {
    const colors = { pending: '#f59e0b', approved: '#22c55e', rejected: '#6b7280', revoked: '#ef4444' };
    const color = colors[territory.status] || '#6b7280';
    const latlng = gameToLeaflet(territory.pole.east, territory.pole.north, currentMapName);
    const circle = L.circle(latlng, {
      radius: territory.radiusMeters * radiusScale,
      color, fillColor: color, weight: 2, fillOpacity: territory.status === 'approved' ? 0.14 : 0.06,
      dashArray: territory.status === 'approved' ? null : '6 5',
    });
    let popup = operationsPopup(`🚩 ${territory.factionName}`, [
      `${territory.status} · version ${territory.version}`,
      `${territory.radiusMeters} m flag protection radius`,
      'Explicit submitted flag-pole marker',
      territory.decisionNote,
    ]);
    if (territory.status === 'pending') {
      popup += `<br><button onclick="reviewFactionTerritory(${territory.id}, 'approved', ${territory.version})">Approve</button> ` +
        `<button onclick="reviewFactionTerritory(${territory.id}, 'rejected', ${territory.version})">Reject</button>`;
    } else if (territory.status === 'approved') {
      popup += `<br><button onclick="reviewFactionTerritory(${territory.id}, 'revoked', ${territory.version})">Revoke</button>`;
    }
    circle.bindPopup(popup).addTo(next.factionTerritories);
    L.marker(latlng, {
      icon: L.divIcon({ html: '<span style="font-size:22px">🚩</span>', className: '', iconSize: [24, 24] }),
    }).addTo(next.factionTerritories);
  }
  return next;
}

function applyOperationsLayerVisibility() {
  const controls = {
    players: 'operations-player-toggle', events: 'operations-event-toggle',
    purchases: 'operations-purchase-toggle', territory: 'operations-territory-toggle',
    zones: 'operations-zone-toggle', factions: 'operations-faction-toggle',
    factionTerritories: 'operations-faction-territory-toggle',
  };
  for (const [name, controlId] of Object.entries(controls)) {
    const layer = operationsLayers[name];
    if (!layer || !map) continue;
    const enabled = document.getElementById(controlId).checked;
    if (enabled && !map.hasLayer(layer)) layer.addTo(map);
    if (!enabled && map.hasLayer(layer)) map.removeLayer(layer);
  }
}

function clearOperationsLayers() {
  operationsRequestId++;
  for (const name of Object.keys(operationsLayers)) {
    if (operationsLayers[name] && map && map.hasLayer(operationsLayers[name])) map.removeLayer(operationsLayers[name]);
    operationsLayers[name] = null;
  }
  operationsPlayerMarkers.clear();
  document.getElementById('operations-counts').textContent = '';
  document.getElementById('online-player-list').replaceChildren();
  document.getElementById('online-player-summary').textContent = 'No current roster loaded.';
  document.getElementById('operations-status').textContent = 'Select a server and map to load exact-server log telemetry.';
}

function clearPoiBucketLayers() {
  for (const group of [settlementBucketLayers, spawnBucketLayers]) {
    if (!group) continue;
    for (const layer of Object.values(group)) {
      // spawnBucketLayers values are Maps of (cat|tier) -> L.layerGroup.
      if (layer instanceof Map) {
        for (const sub of layer.values()) {
          if (map && map.hasLayer(sub)) map.removeLayer(sub);
        }
      } else if (map && map.hasLayer(layer)) {
        map.removeLayer(layer);
      }
      layer.clearLayers && layer.clearLayers();
    }
  }
  settlementBucketLayers = null;
  spawnBucketLayers = null;
  spawnMarkersFor = null;
  spawnMarkerFeatures = null;
  spawnMarkerRequestId++;
  placeSearchIndex = [];
  placeSearchIndexMap = null;
  const results = document.getElementById('place-results');
  if (results) results.replaceChildren();
}

async function reviewFactionTerritory(territoryId, decision, expectedVersion) {
  const serverContext = selectedServerContext(currentServer);
  if (!serverContext || !currentMapName) return;
  const generation = contextGeneration;
  const note = decision === 'approved' ? '' : (prompt('Optional decision note:') || '');
  try {
    const response = await fetchWithCsrf(
      `/api/faction-territories/${encodeURIComponent(serverContext.internalServerId)}/${encodeURIComponent(territoryId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ decision, expectedVersion, note }),
      }
    );
    const result = await response.json().catch(() => ({}));
    if (generation !== contextGeneration || !selectedServerContext(currentServer)) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'Territory review failed');
    await loadOperationsOverlay();
  } catch (error) {
    if (generation !== contextGeneration) return;
    alert(error.message);
  }
}
window.reviewFactionTerritory = reviewFactionTerritory;

async function loadOperationsOverlay() {
  const serverContext = selectedServerContext(currentServer);
  if (!serverContext || !currentMapName) return;
  const mapDefinition = window.DayzMapCoordinates.getMapDefinition(currentMapName);
  if (!mapDefinition.verifiedGeometry) {
    clearOperationsLayers();
    document.getElementById('operations-status').textContent =
      'Operations overlay is unavailable because this terrain geometry is not calibrated.';
    return;
  }
  const requestId = ++operationsRequestId;
  const requestContextGeneration = contextGeneration;
  const status = document.getElementById('operations-status');
  status.textContent = 'Refreshing log-derived operations telemetry…';
  try {
    const params = new URLSearchParams({
      map: currentMapName,
      windowMinutes: document.getElementById('operations-window').value,
    });
    const response = await fetch('/api/operations-map/' + encodeURIComponent(serverContext.internalServerId) + '?' + params);
    const result = await response.json().catch(() => ({}));
    if (requestId !== operationsRequestId || requestContextGeneration !== contextGeneration ||
        !selectedServerContext(currentServer)) return;
    if (!response.ok || !result.success) {
      clearOperationsLayers();
      status.textContent = response.status === 403
        ? 'Operations overlay is not available for this role.'
        : (result.error || 'Operations telemetry is unavailable.');
      return;
    }
    if (result.mapName !== currentMapName) {
      clearOperationsLayers();
      status.textContent = 'Operations telemetry no longer matches the selected map.';
      return;
    }

    const nextLayers = buildOperationsLayers(result);
    renderOnlinePlayerList(result.onlinePlayers || [], {
      serverId: serverContext.internalServerId,
      generation: requestContextGeneration,
    });
    for (const name of Object.keys(operationsLayers)) {
      if (operationsLayers[name] && map.hasLayer(operationsLayers[name])) map.removeLayer(operationsLayers[name]);
      operationsLayers[name] = nextLayers[name];
    }
    applyOperationsLayerVisibility();
    const observed = formatObservationTime(result.telemetry.presenceObservedAt);
    const sessionStarted = formatObservationTime(result.telemetry.activeSessionStartedAt);
    status.textContent = result.telemetry.presenceFresh
      ? `Verified active session since ${sessionStarted} · roster observed ${observed} · snapshot ${formatObservationTime(result.generatedAt)}`
      : `Verified active session since ${sessionStarted} · roster evidence is stale or unavailable · snapshot ${formatObservationTime(result.generatedAt)}`;
    document.getElementById('operations-counts').textContent = [
      `${result.onlinePlayers.length} online players`,
      `${result.telemetry.positionedCount} with active-session positions`,
      `${result.recentEvents.length} combat events`,
      `${result.purchases.length} purchases`,
      `${result.territoryObservations.length} build/territory observations`,
      `${result.zones.length} review zones`,
      `${result.factionMarkers.length} faction markers`,
      `${result.factionTerritories.length} governed faction territories`,
    ].join(' · ');
  } catch (error) {
    if (requestId !== operationsRequestId || requestContextGeneration !== contextGeneration) return;
    console.error('Operations map load failed:', error);
    clearOperationsLayers();
    status.textContent = 'Operations telemetry is unavailable.';
  }
}

/* ── Faction Wars overlay (settlement claims + flags) ────────────────────── */

function factionColor(factionId) {
  const hue = ((Number(factionId) || 0) * 137.508) % 360;
  return `hsl(${Math.round(hue)}, 72%, 52%)`;
}

function clearFactionWarLayers() {
  factionWarRequestId++;
  for (const name of Object.keys(factionWarLayers)) {
    if (factionWarLayers[name] && map && map.hasLayer(factionWarLayers[name])) map.removeLayer(factionWarLayers[name]);
    factionWarLayers[name] = null;
  }
}

function buildFactionWarLayers(data) {
  if (!map) return;
  const scale = DayzMapCoordinates.pixelsPerWorldUnit(currentMapName);
  const claims = L.layerGroup();
  const flags = L.layerGroup();
  for (const s of data.settlements || []) {
    if (!s.claim) continue;
    const color = factionColor(s.claim.faction_id);
    const center = gameToLeaflet(s.east, s.north, currentMapName);
    L.circle(center, {
      radius: s.boundary_radius_m * scale,
      color, fillColor: color, weight: 2, fillOpacity: 0.18, interactive: false,
    }).addTo(claims);
    L.marker(center, {
      icon: L.divIcon({
        className: '',
        html: `<span style="display:block;text-align:center;font-size:11px;font-weight:700;line-height:1.15;text-shadow:0 1px 3px #000;white-space:nowrap;color:${color}">🚩 ${escapeHtml(s.claim.faction_name)}</span>`,
        iconSize: [140, 16], iconAnchor: [70, -8],
      }),
      interactive: false,
    }).addTo(claims);
  }
  for (const f of data.flags || []) {
    const color = factionColor(f.faction_id);
    const pos = gameToLeaflet(f.east, f.north, currentMapName);
    L.marker(pos, {
      icon: L.divIcon({ className: '', html: '<span style="font-size:18px">🚩</span>', iconSize: [20, 20] }),
      interactive: false,
    }).addTo(flags);
    if (!f.settlement_id) {
      // Out-of-settlement flag: its territory is its own radius circle only.
      L.circle(pos, {
        radius: f.radius_m * scale,
        color, fillColor: color, weight: 1.5, fillOpacity: 0.12,
        dashArray: '4 4', interactive: false,
      }).addTo(flags);
    }
  }
  for (const name of Object.keys(factionWarLayers)) {
    if (factionWarLayers[name] && map.hasLayer(factionWarLayers[name])) map.removeLayer(factionWarLayers[name]);
    factionWarLayers[name] = name === 'claims' ? claims : flags;
  }
  applyFactionWarLayerVisibility();
}

function applyFactionWarLayerVisibility() {
  const toggle = document.getElementById('faction-war-toggle');
  const enabled = toggle ? toggle.checked : true;
  for (const name of Object.keys(factionWarLayers)) {
    const layer = factionWarLayers[name];
    if (!layer) continue;
    if (enabled && !map.hasLayer(layer)) layer.addTo(map);
    if (!enabled && map.hasLayer(layer)) map.removeLayer(layer);
  }
}

async function loadFactionWarOverlay() {
  const serverContext = selectedServerContext(currentServer);
  if (!serverContext || !currentMapName) { clearFactionWarLayers(); return; }
  if (currentMapName !== 'nasdara') { clearFactionWarLayers(); return; } // settlement data ships for nasdara only
  const requestId = ++factionWarRequestId;
  try {
    const response = await fetch('/api/faction-war/' + encodeURIComponent(serverContext.internalServerId) + '?map=' + encodeURIComponent(currentMapName));
    const result = await response.json().catch(() => ({}));
    if (requestId !== factionWarRequestId) return;
    if (!response.ok || !result.success) { clearFactionWarLayers(); return; }
    buildFactionWarLayers(result);
  } catch (error) {
    if (requestId === factionWarRequestId) {
      console.error('Faction war overlay load failed:', error);
      clearFactionWarLayers();
    }
  }
}

function toggleAutoRefresh() {
  autoRefreshEnabled = document.getElementById('auto-refresh-toggle').checked;
  
  if (autoRefreshEnabled) {
    startAutoRefresh();
    document.getElementById('auto-refresh-badge').style.display = 'inline-flex';
  } else {
    stopAutoRefresh();
    document.getElementById('auto-refresh-badge').style.display = 'none';
  }
  
  localStorage.setItem('autoRefreshEnabled', autoRefreshEnabled);
  syncMapUrl();
}

function startAutoRefresh() {
  stopAutoRefresh();
  
  refreshSeconds = 30;
  updateRefreshTimer();
  
  refreshCountdown = setInterval(function() {
    refreshSeconds--;
    updateRefreshTimer();
    
    if (refreshSeconds <= 0) {
      if (currentServer && currentMapName) {
        console.log('🔄 Auto-refreshing map data...');
        const serverContext = selectedServerContext(currentServer);
        if (serverContext) {
          loadMapData(currentServer, currentMapName, true);
          getActiveMission(currentServer, serverContext.guildId);
        }
      }
      refreshSeconds = 30;
    }
  }, 1000);
}

function stopAutoRefresh() {
  if (refreshCountdown) {
    clearInterval(refreshCountdown);
    refreshCountdown = null;
  }
}

function updateRefreshTimer() {
  document.getElementById('refresh-timer').textContent = 'Auto-refresh in ' + refreshSeconds + 's';
}

function manualRefresh() {
  if (currentServer) {
    loadMapsForServer(currentServer);
    refreshSeconds = 30;
    updateRefreshTimer();
  }
}

function loadEnabledHeatmaps() {
  loadHeatmap();
  loadKillHeatmap();
  loadDeathHeatmap();
  loadMovementHeatmap();
}

function clearSelectedContext() {
  currentMapName = null;
  onlinePlayerNoteDrafts.clear();
  clearOperationsLayers();
  clearPoiBucketLayers();
  for (const layer of Object.values(geographyLayers)) {
    if (layer) {
      layer.clearLayers();
      if (map) map.removeLayer(layer);
    }
  }
  currentTiles.forEach(tile => tile.remove());
  currentTiles = [];
  if (coordinateGridLayer && map) map.removeLayer(coordinateGridLayer);
  coordinateGridLayer = null;
  Object.values(markers).forEach(marker => marker.remove());
  markers = {};
  allEventData = [];
  lastEventHealth = null;
  document.getElementById('event-health-summary').textContent = 'Select a server and map to inspect event evidence.';
  document.getElementById('event-health-results').replaceChildren();
  document.getElementById('event-health-limit').textContent = '';
  for (const layer of [heatLayer, killHeatLayer, deathHeatLayer, movementHeatLayer, recentLootLayer]) {
    if (layer && map) map.removeLayer(layer);
  }
  heatLayer = null;
  killHeatLayer = null;
  deathHeatLayer = null;
  movementHeatLayer = null;
  recentLootLayer = null;
}

// Event listeners
document.getElementById('server-select').addEventListener('change', function(e) {
  contextGeneration++;
  mapDiscoveryRequestId++;
  mapDataRequestId++;
  eventHealthRequestId++;
  currentServer = e.target.value;

  // Live context pill: display the selected server's snapshot (internal id
  // from the option; the shell never infers authorization itself)
  if (window.dzcShellPollServer) {
    var shellOpt = e.target.options[e.target.selectedIndex];
    if (currentServer && shellOpt && shellOpt.dataset.internalServerId) {
      window.dzcShellPollServer(shellOpt.dataset.internalServerId, shellOpt.textContent.split(' (')[0]);
    } else {
      window.dzcShellPollServerStop();
    }
  }
  clearSelectedContext();
  if (currentServer) {
    if (window.MapLootLayer) window.MapLootLayer.onServerChange(currentServer);
    if (playerMapMode) {
      loadPlayerMapsForServer(currentServer);
    } else {
      loadMapsForServer(currentServer);
      if (autoRefreshEnabled) {
        startAutoRefresh();
      }
    }
  }
  syncMapUrl();
});

document.getElementById('map-select').addEventListener('change', function(e) {
  const mapName = e.target.value;
  contextGeneration++;
  mapDataRequestId++;
  eventHealthRequestId++;
  clearSelectedContext();
  if (mapName && currentServer) {
    if (playerMapMode) {
      currentMapName = mapName;
      initMap(mapName);
    } else {
      loadMapData(currentServer, mapName);
      loadEnabledHeatmaps();
    }
    if (window.MapLootLayer) window.MapLootLayer.onMapChange(mapName);
  }
  syncMapUrl();
});

// Initialize
currentMapName = 'enoch';
initMap('enoch');
if (window.MapLootLayer) window.MapLootLayer.init();
loadServers();

document.getElementById('event-health-search').addEventListener('input', renderEventHealth);
document.getElementById('event-health-refresh').addEventListener('click', function() {
  const context = selectedServerContext(currentServer);
  if (currentServer && currentMapName && context) loadEventHealth(currentServer, currentMapName, context.guildId);
});

document.getElementById('server-info').textContent = 'Livonia - High Resolution Satellite View';
document.getElementById('stat-size').textContent = '12800m';

// ─── Card 6/9: shareable URL state, docked panel, legend ───────────────────
// State lives in the URL (see public/js/map-url-state.js for the param
// scheme): server, map, layers, filters, radius, refresh, open, panel.
const mapUrlState = window.MapUrlState ? window.MapUrlState.parse(window.location.search) : null;

if (mapUrlState) {
  const radiusEl = document.getElementById('radius-input');
  if (radiusEl && mapUrlState.radius) radiusEl.value = mapUrlState.radius;

  // Auto-refresh: ?refresh=0 forces off; otherwise the existing localStorage
  // preference (default: on) still applies.
  if (mapUrlState.autoRefresh === false) {
    autoRefreshEnabled = false;
    document.getElementById('auto-refresh-toggle').checked = false;
  } else {
    const savedAutoRefresh = localStorage.getItem('autoRefreshEnabled');
    autoRefreshEnabled = savedAutoRefresh !== null ? savedAutoRefresh === 'true' : true;
    document.getElementById('auto-refresh-toggle').checked = autoRefreshEnabled;
    if (autoRefreshEnabled) {
      document.getElementById('auto-refresh-badge').style.display = 'inline-flex';
    }
  }

  // Layer toggles (defaults: operations overlay + settlement labels on,
  // settlement radii + all heatmaps off).
  // LAYER_CONTROLS lives on the module API, not on the parsed state.
  Object.entries(window.MapUrlState.LAYER_CONTROLS).forEach(function ([key, controlId]) {
    const control = document.getElementById(controlId);
    if (control) control.checked = mapUrlState.layers.has(key);
  });
  heatmapEnabled = document.getElementById('heatmap-toggle').checked;
  document.getElementById('heatmap-controls').style.display = heatmapEnabled ? 'block' : 'none';
  killHeatmapEnabled = document.getElementById('kill-heatmap-toggle').checked;
  deathHeatmapEnabled = document.getElementById('death-heatmap-toggle').checked;
  movementHeatmapEnabled = document.getElementById('movement-heatmap-toggle').checked;
  recentLootEnabled = document.getElementById('recent-loot-toggle').checked;
  document.getElementById('recent-loot-controls').style.display = recentLootEnabled ? 'block' : 'none';

  // Shared-URL restore: ?map=<key> on the initial (server-less) select.
  // When ?server= is also present, loadMapsForServer re-applies the same
  // param after repopulating the server's map list.
  const urlMap = mapUrlState.map;
  const mapSel = document.getElementById('map-select');
  if (urlMap && mapSel.value !== urlMap &&
      Array.from(mapSel.options).some(o => o.value === urlMap)) {
    mapSel.value = urlMap;
    initMap(urlMap);
  }
}

// Section open/closed restore (URL 'open' param; default: all open).
document.querySelectorAll('#map-panel .map-section').forEach(function (section) {
  const head = section.querySelector('.map-section-head');
  const body = section.querySelector('.map-section-body');
  if (!head || !body) return;
  const open = mapUrlState ? mapUrlState.openSections.has(section.dataset.section) : true;
  body.hidden = !open;
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
});

// Whole-panel collapse (desktop) / full-screen sheet (<=780px, toggled by
// the floating Controls button). Mobile starts with the sheet closed so the
// map is full-bleed.
function mapIsMobile() {
  return window.matchMedia ? window.matchMedia('(max-width: 780px)').matches : window.innerWidth <= 780;
}
function setMapPanelOpen(open) {
  const panelEl = document.getElementById('map-panel');
  const fab = document.getElementById('map-panel-fab');
  panelEl.hidden = !open;
  if (fab) {
    fab.classList.toggle('is-visible', !open);
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Mobile sheet: focus follows the sheet (inside while open, back to
    // the trigger when closed) for keyboard + screen-reader access.
    if (mapIsMobile()) {
      if (open) panelEl.focus();
      else fab.focus();
    }
  }
}
setMapPanelOpen(!mapIsMobile() && !!(mapUrlState ? mapUrlState.panelOpen : true));
document.getElementById('map-panel-fab').addEventListener('click', function () {
  setMapPanelOpen(document.getElementById('map-panel').hidden);
  syncMapUrl();
});
document.getElementById('map-panel-collapse').addEventListener('click', function () {
  setMapPanelOpen(false);
  syncMapUrl();
});
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape' && mapIsMobile() && !document.getElementById('map-panel').hidden) {
    setMapPanelOpen(false);
  }
});
document.querySelectorAll('#map-panel .map-section-head').forEach(function (head) {
  head.addEventListener('click', function () {
    const body = document.getElementById(head.getAttribute('aria-controls'));
    if (!body) return;
    const open = body.hidden;
    body.hidden = !open;
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    syncMapUrl();
  });
});

// Legend for active layers (with an explicit "nothing on" empty state).
const LEGEND_ITEMS = [
  ['loot', 'Loot despawn heat', 'grad-loot'],
  ['kill', 'Kill locations', 'grad-kill'],
  ['death', 'Death locations', 'grad-death'],
  ['movement', 'Player movement', 'grad-movement'],
  ['recentloot', 'Recently spawned loot', '#22c55e'],
  ['roster', 'Roster (fresh / stale)', '#22c55e'],
  ['combat', 'Combat events', '#ef4444'],
  ['purchases', 'Purchases', '#38bdf8'],
  ['build', 'Build / territory obs.', '#facc15'],
  ['zones', 'Review zones', '#ef4444'],
  ['factions', 'Faction markers', '#2dd4bf'],
  ['faction-territory', 'Faction territories', '#22c55e'],
  ['settlements', 'Settlement labels', '#94a3b8'],
  ['settlement-radii', 'Settlement radii', '#94a3b8'],
];
function renderMapLegend() {
  const el = document.getElementById('layer-legend');
  if (!el) return;
  el.replaceChildren();
  const active = LEGEND_ITEMS.filter(function ([key]) {
    const control = document.getElementById(mapUrlState ? window.MapUrlState.LAYER_CONTROLS[key] : '');
    return control && control.checked;
  });
  if (!active.length) {
    const empty = document.createElement('p');
    empty.className = 'map-empty';
    empty.textContent = 'No layers active — enable a layer above.';
    el.appendChild(empty);
    return;
  }
  active.forEach(function ([key, label, swatch]) {
    const row = document.createElement('div');
    row.className = 'map-legend-row';
    const s = document.createElement('span');
    const gradient = swatch.indexOf('grad-') === 0;
    s.className = 'map-legend-swatch' + (gradient ? ' ' + swatch : ' sq');
    if (!gradient) s.style.background = swatch;
    const t = document.createElement('span');
    t.textContent = label;
    row.appendChild(s);
    row.appendChild(t);
    el.appendChild(row);
  });
}

// Write the current control state back to the URL (replaceState — no
// history spam). Called from every control handler that changes state.
function syncMapUrl() {
  if (!window.MapUrlState) return;
  const layers = new Set();
  Object.entries(window.MapUrlState.LAYER_CONTROLS).forEach(function ([key, id]) {
    const control = document.getElementById(id);
    if (control && control.checked) layers.add(key);
  });
  const hiddenFilters = Object.keys(eventTypeFilters).filter(function (name) { return !eventTypeFilters[name]; });
  const openSections = new Set();
  document.querySelectorAll('#map-panel .map-section').forEach(function (section) {
    if (!section.querySelector('.map-section-body[hidden]')) openSections.add(section.dataset.section);
  });
  const query = window.MapUrlState.buildSearch({
    server: document.getElementById('server-select').value,
    map: document.getElementById('map-select').value,
    layers: layers,
    hiddenFilters: hiddenFilters,
    radius: parseInt(document.getElementById('radius-input').value, 10) || window.MapUrlState.DEFAULT_RADIUS,
    autoRefresh: autoRefreshEnabled,
    openSections: openSections,
    rail: collectRailPaths(),
    panelOpen: !document.getElementById('map-panel').hidden,
  });
  window.history.replaceState(null, '', window.location.pathname + (query ? '?' + query : ''));
}
renderMapLegend();

// Set up event listeners
document.getElementById('refresh-btn').addEventListener('click', manualRefresh);
document.getElementById('search-input').addEventListener('keyup', searchEvents);
document.getElementById('place-search').addEventListener('keyup', function (ev) {
  renderPlaceSearchResults();
  if (ev.key === 'Enter') {
    const results = placeSearchResults(this.value);
    if (results.length) flyToPlace(results[0]);
  }
});
document.getElementById('radius-btn').addEventListener('click', startRadiusSearch);
document.getElementById('cancel-radius-btn').addEventListener('click', cancelRadiusSearch);
document.getElementById('auto-refresh-toggle').addEventListener('change', toggleAutoRefresh);
document.getElementById('operations-refresh').addEventListener('click', loadOperationsOverlay);
document.getElementById('operations-window').addEventListener('change', loadOperationsOverlay);
for (const id of ['operations-player-toggle', 'operations-event-toggle', 'operations-purchase-toggle',
  'operations-territory-toggle', 'operations-zone-toggle', 'operations-faction-toggle',
  'operations-faction-territory-toggle']) {
  document.getElementById(id).addEventListener('change', function () {
    applyOperationsLayerVisibility();
    renderMapLegend();
    syncMapUrl();
  });
}
document.getElementById('faction-war-toggle').addEventListener('change', applyFactionWarLayerVisibility);
for (const id of ['settlement-label-toggle', 'settlement-extent-toggle']) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener('change', function () {
    applyGeographyLayerVisibility();
    renderMapLegend();
    syncMapUrl();
  });
}
// Spawn filter rail (P0-C): one delegated listener covers item + toggle-all
// checkboxes. Toggling is instant — it only adds/removes pre-bucketed
// layer groups (no re-fetch, no marker re-render).
document.getElementById('spawn-filter-rail').addEventListener('change', function (ev) {
  const target = ev.target;
  if (target.tagName !== 'INPUT' || target.type !== 'checkbox') { syncMapUrl(); return; }
  if (target.hasAttribute('data-rail-all')) {
    const scope = target.getAttribute('data-rail-all');
    const sel = scope === 'evt'
      ? '#holiday-event-row input[type="checkbox"]'
      : '#spawn-filter-rail input[data-rail^="' + scope + '"]';
    document.querySelectorAll(sel).forEach(function (cb) {
      if (cb === target) return;
      cb.checked = target.checked;
      // The P1 holiday checkbox gates its event markers via its own onchange
      // handler, which only runs on a real change event.
      if (scope === 'evt') cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  applySpawnVisibility();
  syncMapUrl();
});
document.getElementById('radius-input').addEventListener('change', syncMapUrl);

// ─── Loot Despawn Heatmap ───────────────────────────────────────────────────

/**
 * Fetch grid-aggregated despawn data and render the heat layer.
 * Converts DayZ game coordinates to Leaflet coordinates via the canonical
 * DayzMapCoordinates.worldToLeaflet (content-extent aware).
 */
async function loadHeatmap() {
  if (!heatmapEnabled || !currentServer) return;

  const requestId = ++lootHeatmapRequestId;
  const serverId = currentServer;
  const mapName = currentMapName;
  const requestContextGeneration = contextGeneration;

  const days     = document.getElementById('heatmap-days').value;
  const gridSize = document.getElementById('heatmap-grid').value;
  const statusEl = document.getElementById('heatmap-status');
  statusEl.textContent = '⏳ Loading…';

  try {
    const params = new URLSearchParams({
      serverId,
      days,
      gridSize,
      filter: heatmapFilter,
    });
    const res  = await fetch('/api/loot/heatmap?' + params);
    const data = await res.json();
    if (requestId !== lootHeatmapRequestId || requestContextGeneration !== contextGeneration ||
        serverId !== currentServer || mapName !== currentMapName) return;

    if (!data.ok) {
      statusEl.textContent = '❌ ' + data.error;
      return;
    }

    const maxCnt = data.points.reduce((m, p) => Math.max(m, p[2]), 1);

    // Convert [gameX, gameZ, count] → [leafletLat, leafletLng, intensity]
    const leafletPoints = data.points.map(function([gx, gz, cnt]) {
      const latlng = gameToLeaflet(gx, gz, mapName);
      return [latlng[0], latlng[1], cnt / maxCnt];
    });

    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }

    if (leafletPoints.length > 0) {
      heatLayer = L.heatLayer(leafletPoints, {
        radius:     25,
        blur:       20,
        maxZoom:    6,
        minOpacity: 0.3,
        gradient:   { 0.0: 'blue', 0.4: 'cyan', 0.65: 'lime', 0.8: 'yellow', 1.0: 'red' },
      }).addTo(map);
    }

    statusEl.textContent = '✅ ' + data.total.toLocaleString() + ' events (' + data.points.length + ' cells)';
    renderHeatmapTopItems(data.topItems);
  } catch (err) {
    if (requestId !== lootHeatmapRequestId || requestContextGeneration !== contextGeneration) return;
    document.getElementById('heatmap-status').textContent = '❌ Failed to load heatmap';
    console.error('Heatmap load error:', err);
  }
}

/** Render the top-10 most despawned item classes in the filter panel. */
function renderHeatmapTopItems(items) {
  const el = document.getElementById('heatmap-top-items');
  if (!items || items.length === 0) { el.innerHTML = ''; return; }

  const max = items[0].cnt;
  el.innerHTML = '<div style="font-size:11px; font-weight:600; color:#9ca3af; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">Top Despawned</div>' +
    items.slice(0, 10).map(function(it) {
      const pct = Math.round((it.cnt / max) * 100);
      return '<div style="margin-bottom:5px;">' +
        '<div style="display:flex; justify-content:space-between; font-size:10px; color:#d1d5db; margin-bottom:2px;">' +
          '<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:130px;">' + escapeHtml(it.item_class) + '</span>' +
          '<span style="color:#9ca3af; flex-shrink:0; margin-left:4px;">' + it.cnt + '</span>' +
        '</div>' +
        '<div style="height:3px; background:#374151; border-radius:2px;">' +
          '<div style="width:' + pct + '%; height:3px; background:#ef4444; border-radius:2px;"></div>' +
        '</div>' +
      '</div>';
    }).join('');
}

/** Toggle the heatmap on/off; reload when turned on. */
function toggleHeatmap() {
  heatmapEnabled = document.getElementById('heatmap-toggle').checked;
  document.getElementById('heatmap-controls').style.display = heatmapEnabled ? 'block' : 'none';

  if (!heatmapEnabled) {
    lootHeatmapRequestId++;
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    document.getElementById('heatmap-status').textContent = '';
    document.getElementById('heatmap-top-items').innerHTML = '';
  } else {
    loadHeatmap();
  }
}

// Heatmap event listeners
document.getElementById('heatmap-toggle').addEventListener('change', function () {
  toggleHeatmap();
  renderMapLegend();
  syncMapUrl();
});
document.getElementById('heatmap-days').addEventListener('change', loadHeatmap);
document.getElementById('heatmap-grid').addEventListener('change', loadHeatmap);
document.querySelectorAll('.heatmap-filter-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.heatmap-filter-btn').forEach(function(b) { b.classList.remove('active'); });
    this.classList.add('active');
    heatmapFilter = this.dataset.filter;
    loadHeatmap();
  });
});

// ─── Live recently-spawned loot layer ────────────────────────────────────────
//
// Renders the most-recent loot spawns (what item, where, when) as circle
// markers that fade with age. Data comes from /api/loot/recent-spawns, which
// parses the coord-bearing "Adding <Item> at [east,north]" lines from the
// current server.log and the newest RPT (deduped across both). This is
// per-event observation, NOT spawn rates/odds.

function clearRecentLootLayer() {
  recentLootRequestId++;
  if (recentLootLayer && map) map.removeLayer(recentLootLayer);
  recentLootLayer = null;
  const status = document.getElementById('recent-loot-status');
  if (status) status.textContent = '';
}

function formatLootAge(ageMs) {
  const secs = Math.max(0, Math.round(ageMs / 1000));
  if (secs < 60) return secs + (secs === 1 ? ' sec ago' : ' secs ago');
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + (mins === 1 ? ' min ago' : ' mins ago');
  const hrs = Math.floor(mins / 60);
  return hrs + (hrs === 1 ? ' hr ago' : ' hrs ago');
}

async function loadRecentLootSpawns() {
  if (!recentLootEnabled || !currentServer || !currentMapName) return;
  const serverId = currentServer;
  const mapName = currentMapName;
  const requestId = ++recentLootRequestId;
  const requestContextGeneration = contextGeneration;
  const statusEl = document.getElementById('recent-loot-status');
  statusEl.textContent = '⏳ Loading…';

  try {
    const windowMinutes = document.getElementById('recent-loot-window').value;
    const params = new URLSearchParams({ serverId, map: mapName, windowMinutes });
    const res = await fetch('/api/loot/recent-spawns?' + params);
    const data = await res.json();
    if (requestId !== recentLootRequestId || requestContextGeneration !== contextGeneration ||
        serverId !== currentServer || mapName !== currentMapName) return;

    if (recentLootLayer) { map.removeLayer(recentLootLayer); recentLootLayer = null; }

    if (!data.ok) {
      statusEl.textContent = '❌ ' + (data.error || 'failed to load');
      return;
    }
    if (!data.spawns || data.spawns.length === 0) {
      statusEl.textContent = data.error ? ('⚠️ ' + data.error) : 'No recent loot spawns in window.';
      return;
    }

    const layer = L.layerGroup();
    const windowMs = data.windowMinutes * 60000;
    for (const s of data.spawns) {
      // Fade with age: newest (ageMs≈0) fully opaque, oldest in window faint.
      const freshness = Math.max(0, Math.min(1, 1 - s.ageMs / windowMs));
      const latlng = gameToLeaflet(s.east, s.north, mapName);
      L.circleMarker(latlng, {
        radius: 4,
        color: '#bbf7d0',
        weight: 1,
        opacity: 0.25 + 0.75 * freshness,
        fillColor: '#22c55e',
        fillOpacity: 0.15 + 0.7 * freshness,
      }).bindPopup(
        '<div class="text-gray-900"><strong>' + escapeHtml(humanizeClassname(s.item)) + '</strong><br>' +
        'Class: ' + escapeHtml(s.item) + '<br>' +
        'Game: ' + Math.round(s.east) + ', ' + Math.round(s.north) + '<br>' +
        formatLootAge(s.ageMs) + '<br>' +
        '<span style="color:#6b7280;font-size:11px;">Spawn observation — presence not guaranteed.</span></div>'
      ).addTo(layer);
    }
    layer.addTo(map);
    recentLootLayer = layer;
    statusEl.textContent = '✅ ' + data.count + ' spawn(s) in last ' + data.windowMinutes + ' min' +
      (data.rejected ? ' · ' + data.rejected + ' rejected (out-of-map)' : '');
  } catch (err) {
    if (requestId !== recentLootRequestId || requestContextGeneration !== contextGeneration) return;
    console.error('Recent loot load error:', err);
    statusEl.textContent = '❌ Failed to load recent loot';
  }
}

function toggleRecentLoot() {
  recentLootEnabled = document.getElementById('recent-loot-toggle').checked;
  document.getElementById('recent-loot-controls').style.display = recentLootEnabled ? 'block' : 'none';
  if (!recentLootEnabled) {
    clearRecentLootLayer();
  } else {
    loadRecentLootSpawns();
  }
}

// Live loot event listeners
document.getElementById('recent-loot-toggle').addEventListener('change', function () {
  toggleRecentLoot();
  renderMapLegend();
  syncMapUrl();
});
document.getElementById('recent-loot-window').addEventListener('change', loadRecentLootSpawns);

// ─── Kill / Death / Movement Heatmaps ───────────────────────────────────────

/**
 * Generic helper: fetch a heatmap endpoint, convert game coords to Leaflet
 * coords, and render an L.heatLayer with the given gradient.
 *
 * @param {string}            endpoint       - API path (e.g. '/api/map/kill-heatmap')
 * @param {Object}            gradient       - Leaflet.heat gradient object
 * @param {L.HeatLayer|null}  existingLayer  - current layer to remove first
 * @param {string}            statusElId     - DOM id for status text
 * @returns {Promise<L.HeatLayer|null>}
 */
async function loadGenericHeatmap(endpoint, gradient, existingLayer, statusElId) {
  if (!currentServer) return null;

  const requestId = (genericHeatmapRequestIds[statusElId] || 0) + 1;
  genericHeatmapRequestIds[statusElId] = requestId;
  const serverId = currentServer;
  const mapName = currentMapName;
  const requestContextGeneration = contextGeneration;

  const days     = document.getElementById('heatmap-days').value;
  const gridSize = document.getElementById('heatmap-grid').value;
  const statusEl = document.getElementById(statusElId);
  if (statusEl) statusEl.textContent = '⏳ Loading…';

  try {
    const params = new URLSearchParams({ serverId, days, gridSize });
    const res  = await fetch(endpoint + '?' + params);
    const data = await res.json();
    if (requestId !== genericHeatmapRequestIds[statusElId] || requestContextGeneration !== contextGeneration ||
        serverId !== currentServer || mapName !== currentMapName) return undefined;

    if (!data.ok) {
      if (statusEl) statusEl.textContent = '❌ ' + data.error;
      return null;
    }

    const maxCnt = data.points.reduce((m, p) => Math.max(m, p[2]), 1);

    // Convert [gameX, gameZ, count] → [leafletLat, leafletLng, intensity]
    const leafletPoints = data.points.map(function([gx, gz, cnt]) {
      const latlng = gameToLeaflet(gx, gz, mapName);
      return [latlng[0], latlng[1], cnt / maxCnt];
    });

    if (existingLayer) map.removeLayer(existingLayer);

    let newLayer = null;
    if (leafletPoints.length > 0) {
      newLayer = L.heatLayer(leafletPoints, {
        radius:     25,
        blur:       20,
        maxZoom:    6,
        minOpacity: 0.3,
        gradient,
      }).addTo(map);
    }

    if (statusEl) {
      statusEl.textContent = '✅ ' + data.total.toLocaleString() + ' events (' + data.points.length + ' cells)';
    }
    return newLayer;
  } catch (err) {
    if (requestId !== genericHeatmapRequestIds[statusElId] || requestContextGeneration !== contextGeneration) return undefined;
    if (statusEl) statusEl.textContent = '❌ Failed to load';
    console.error('Heatmap load error (' + endpoint + '):', err);
    return null;
  }
}

/** Fetch and render the kill-locations heatmap (red-hot gradient). */
async function loadKillHeatmap() {
  if (!killHeatmapEnabled) return;
  const layer = await loadGenericHeatmap(
    '/api/map/kill-heatmap',
    { 0: 'blue', 0.5: 'yellow', 1: 'red' },
    killHeatLayer,
    'kill-heatmap-status'
  );
  if (layer !== undefined) killHeatLayer = layer;
}

/** Fetch and render the death-locations heatmap (purple gradient). */
async function loadDeathHeatmap() {
  if (!deathHeatmapEnabled) return;
  const layer = await loadGenericHeatmap(
    '/api/map/death-heatmap',
    { 0: 'navy', 0.5: 'purple', 1: 'magenta' },
    deathHeatLayer,
    'death-heatmap-status'
  );
  if (layer !== undefined) deathHeatLayer = layer;
}

/** Fetch and render the player-movement heatmap (green gradient). */
async function loadMovementHeatmap() {
  if (!movementHeatmapEnabled) return;
  const layer = await loadGenericHeatmap(
    '/api/map/movement-heatmap',
    { 0: 'darkgreen', 0.5: 'lime', 1: 'white' },
    movementHeatLayer,
    'movement-heatmap-status'
  );
  if (layer !== undefined) movementHeatLayer = layer;
}

// Toggle: kill heatmap
document.getElementById('kill-heatmap-toggle').addEventListener('change', function() {
  killHeatmapEnabled = this.checked;
  if (!killHeatmapEnabled) {
    genericHeatmapRequestIds['kill-heatmap-status'] = (genericHeatmapRequestIds['kill-heatmap-status'] || 0) + 1;
    if (killHeatLayer) { map.removeLayer(killHeatLayer); killHeatLayer = null; }
    const el = document.getElementById('kill-heatmap-status');
    if (el) el.textContent = '';
  } else {
    loadKillHeatmap();
  }
  renderMapLegend();
  syncMapUrl();
});

// Toggle: death heatmap
document.getElementById('death-heatmap-toggle').addEventListener('change', function() {
  deathHeatmapEnabled = this.checked;
  if (!deathHeatmapEnabled) {
    genericHeatmapRequestIds['death-heatmap-status'] = (genericHeatmapRequestIds['death-heatmap-status'] || 0) + 1;
    if (deathHeatLayer) { map.removeLayer(deathHeatLayer); deathHeatLayer = null; }
    const el = document.getElementById('death-heatmap-status');
    if (el) el.textContent = '';
  } else {
    loadDeathHeatmap();
  }
  renderMapLegend();
  syncMapUrl();
});

// Toggle: movement heatmap
document.getElementById('movement-heatmap-toggle').addEventListener('change', function() {
  movementHeatmapEnabled = this.checked;
  if (!movementHeatmapEnabled) {
    genericHeatmapRequestIds['movement-heatmap-status'] = (genericHeatmapRequestIds['movement-heatmap-status'] || 0) + 1;
    if (movementHeatLayer) { map.removeLayer(movementHeatLayer); movementHeatLayer = null; }
    const el = document.getElementById('movement-heatmap-status');
    if (el) el.textContent = '';
  } else {
    loadMovementHeatmap();
  }
  renderMapLegend();
  syncMapUrl();
});

// Reload all three when the shared days/grid selectors change
(function attachHeatmapReloaders() {
  const daysEl = document.getElementById('heatmap-days');
  const gridEl = document.getElementById('heatmap-grid');
  function reloadAll() {
    loadKillHeatmap();
    loadDeathHeatmap();
    loadMovementHeatmap();
  }
  if (daysEl) daysEl.addEventListener('change', reloadAll);
  if (gridEl) gridEl.addEventListener('change', reloadAll);
}());

// ── Keep the Leaflet map in sync with the map container size ───────────────
// Leaflet does not observe the DOM. When the #map element resizes — device
// rotation, window resize, or the mobile full-screen control sheet opening —
// the tile grid must be recomputed, otherwise the map shows a blank or
// misaligned region. This was the "map displays poorly on mobile" bug; no
// resize handler existed. (P4: map mobile display)
(function keepMapSizeInSync() {
  const el = document.getElementById('map');
  if (!el) return;
  let timer;
  const invalidate = () => { if (map) map.invalidateSize(); };
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(invalidate, 120);
    }).observe(el);
  }
  window.addEventListener('resize', invalidate);
  window.addEventListener('orientationchange', invalidate);
})();
