/*
 * DayZ Dashboard — Terrain & Object-Placement layer
 *
 * Wires the two extracted nasdara datasets onto the shared Leaflet map:
 *   1. floor_grid.json     — per-tile ground (floor) heights, median measure,
 *                            reverse-engineered from the navmesh (.nm TESM),
 *                            calibrated against mapgrouppos.xml (signed ~0 m).
 *   2. object_dims.jsonl   — validated local bounding boxes (dx, dy, dz) for
 *                            every model in the nasdara world PAKs.
 *
 * Provides: a toggleable elevation heat-map overlay ("where is the floor"),
 * click-to-query ground height, and object placement (pick a model, click to
 * drop its true footprint, snap to ground, export the coordinates).
 *
 * Coordinate convention (matches dayz-map-coordinates.js): east = DayZ X,
 * north = DayZ Z, elevation = DayZ Y. The floor grid is grid[northRow][eastCol],
 * northRow 0 = south, eastCol 0 = west, cells 50 m, origin 25 m.
 */
(function () {
  'use strict';

  // ── module state ─────────────────────────────────────────────────────────
  let currentMapName = 'enoch';
  let controlEl = null;
  let heatOverlay = null;        // L.imageOverlay (elevation)
  let placementGroup = null;     // L.layerGroup (footprints + query marker)
  let queryMarker = null;
  let grid = null;               // {size,x0,z0,cell,grid[n][e]}
  let objects = null;            // parsed object_dims.jsonl
  let heatOn = false;
  let placeMode = false;
  let selectedObject = null;
  let rotationDeg = 0;
  let placements = [];
  let clickBound = false;

  const dom = {};

  // ── shared map (owned by map.js, same global lexical scope) ──────────────
  function sharedMap() { return typeof map === 'undefined' ? null : map; }

  function isNasdara() { return currentMapName === 'nasdara'; }

  // world (east,north) -> leaflet latlng
  function w2l(east, north) {
    return DayzMapCoordinates.worldToLeaflet({ east: east, north: north }, currentMapName);
  }
  function scale() {
    return DayzMapCoordinates.getMapDefinition(currentMapName).contentWidth /
           DayzMapCoordinates.getMapDefinition(currentMapName).worldWidth;
  }

  // ground height (median floor) at a world point; null if no data
  function groundHeight(east, north) {
    if (!grid) return null;
    const e = Math.round((east - grid.x0) / grid.cell);
    const n = Math.round((north - grid.z0) / grid.cell);
    if (e < 0 || e >= grid.size || n < 0 || n >= grid.size) return null;
    const v = grid.grid[n] && grid.grid[n][e];
    return (v == null) ? null : v;
  }

  // ── data loaders (lazy, cached) ──────────────────────────────────────────
  async function loadGrid() {
    if (grid) return grid;
    const res = await fetch('/data/nasdara/floor_grid.json');
    if (!res.ok) throw new Error('floor_grid.json ' + res.status);
    grid = await res.json();
    return grid;
  }
  async function loadObjects() {
    if (objects) return objects;
    const res = await fetch('/data/nasdara/object_dims.jsonl');
    if (!res.ok) throw new Error('object_dims.jsonl ' + res.status);
    const text = await res.text();
    objects = text.split('\n').filter(Boolean).map(function (line) {
      try {
        const o = JSON.parse(line);
        o.name = (o.model || '').split('\\').pop().replace(/\.p3d$/i, '');
        return o;
      } catch (e) { return null; }
    }).filter(Boolean);
    return objects;
  }

  // ── elevation overlay ────────────────────────────────────────────────────
  function rebuildHeatOverlay() {
    const m = sharedMap();
    if (heatOverlay && m && m.hasLayer(heatOverlay)) m.removeLayer(heatOverlay);
    heatOverlay = null;
    if (!isNasdara() || !heatOn) return;
    if (!m) return;
    const s = scale();
    const e0 = 25 * s, e1 = 16325 * s;  // east  -> lng
    const n0 = 25 * s, n1 = 16325 * s;  // north -> lat
    heatOverlay = L.imageOverlay('/data/nasdara/floor_elevation.png',
      [[n0, e0], [n1, e1]], { opacity: 0.55, interactive: false }).addTo(m);
  }

  // ── object picker ────────────────────────────────────────────────────────
  function modelLabel(o) { return o.name; }
  function renderObjectList(query) {
    if (!dom.objectList) return;
    dom.objectList.innerHTML = '';
    if (!objects) return;
    const q = (query || '').toLowerCase().trim();
    const matches = q
      ? objects.filter(function (o) {
          return (o.name || '').toLowerCase().indexOf(q) >= 0 ||
                 (o.pak || '').toLowerCase().indexOf(q) >= 0 ||
                 (o.model || '').toLowerCase().indexOf(q) >= 0;
        })
      : objects;
    const top = matches.slice(0, 40);
    const frag = document.createDocumentFragment();
    top.forEach(function (o) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dzt-obj' + (selectedObject === o ? ' active' : '');
      b.textContent = modelLabel(o) + '  ·  ' +
        o.dims[0].toFixed(2) + '×' + o.dims[2].toFixed(2) + ' m (' +
        o.dims[1].toFixed(2) + ' h)';
      b.title = o.model + '  [' + o.pak + ']';
      b.addEventListener('click', function () { selectObject(o); });
      frag.appendChild(b);
    });
    if (matches.length > 40) {
      const more = document.createElement('div');
      more.className = 'dzt-more';
      more.textContent = '+' + (matches.length - 40) + ' more…';
      frag.appendChild(more);
    }
    dom.objectList.appendChild(frag);
  }

  function selectObject(o) {
    selectedObject = o;
    placeMode = true;
    setMode();
    renderObjectList(dom.objectSearch ? dom.objectSearch.value : '');
    setReadout('Selected ' + modelLabel(o) + ' — click the map to place it.');
  }

  // ── placement ────────────────────────────────────────────────────────────
  function footprintCorners(o, east, north, rotDeg) {
    const dx = o.dims[0], dz = o.dims[2];
    const rad = rotDeg * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
    return [[-dx/2,-dz/2],[dx/2,-dz/2],[dx/2,dz/2],[-dx/2,dz/2]].map(function (p) {
      const lx = p[0], lz = p[1];
      const rx = lx * c - lz * s;
      const ry = lx * s + lz * c;
      return { east: east + rx, north: north + ry };
    });
  }

  function ensurePlacementGroup() {
    const m = sharedMap();
    if (!m) return null;
    if (!placementGroup) placementGroup = L.layerGroup().addTo(m);
    else if (!m.hasLayer(placementGroup)) placementGroup.addTo(m);
    return placementGroup;
  }

  function clearPlacements() {
    if (placementGroup) placementGroup.clearLayers();
  }

  function placeAt(east, north) {
    const g = groundHeight(east, north);
    const ground = (g == null) ? 0 : g;
    if (selectedObject) {
      const g = ensurePlacementGroup();
      if (g) {
        const corners = footprintCorners(selectedObject, east, north, rotationDeg).map(w2l);
        L.polygon(corners, { color: '#22d3ee', weight: 2, fillColor: '#22d3ee', fillOpacity: 0.28 })
          .bindPopup('<b>' + escapeHtml(modelLabel(selectedObject)) + '</b><br>x:' +
            east.toFixed(1) + ' y:' + ground.toFixed(1) + ' z:' + north.toFixed(1) +
            '<br>ground ' + ground.toFixed(1) + ' m · h ' + selectedObject.dims[1].toFixed(2) + ' m')
          .addTo(g);
      }
      placements.push({
        model: selectedObject.model, pak: selectedObject.pak,
        east: +east.toFixed(3), north: +north.toFixed(3),
        ground: +ground.toFixed(3),
        base_y: +ground.toFixed(3), top_y: +(ground + selectedObject.dims[1]).toFixed(3),
        dims: selectedObject.dims, rotation_deg: rotationDeg
      });
      setReadout('Placed ' + modelLabel(selectedObject) + ' at x' + east.toFixed(0) +
        ' z' + north.toFixed(0) + ' — ground ' + ground.toFixed(1) + ' m (' +
        placements.length + ' total)');
      updateCount();
    }
  }

  function onMapClick(e) {
    const w = DayzMapCoordinates.leafletToWorld({ lat: e.latlng.lat, lng: e.latlng.lng }, currentMapName);
    const east = w.east, north = w.north;
    if (!isNasdara()) return;
    loadGrid().then(function () {
      const g = groundHeight(east, north);
      if (selectedObject && placeMode) {
        placeAt(east, north);
      } else if (sharedMap() && (queryMarker || true)) {
        // query readout
        const m = sharedMap();
        if (m) {
          if (queryMarker) m.removeLayer(queryMarker);
          queryMarker = L.circleMarker([e.latlng.lat, e.latlng.lng], {
            radius: 4, color: '#f97316', fillColor: '#f97316', fillOpacity: 0.9, weight: 1
          }).bindPopup('x:' + east.toFixed(1) + ' z:' + north.toFixed(1) +
            '<br>ground ' + (g == null ? 'n/a' : g.toFixed(1) + ' m')).addTo(m);
        }
        setReadout('x' + east.toFixed(1) + '  z' + north.toFixed(1) +
          '  ·  ground ' + (g == null ? 'n/a' : g.toFixed(1) + ' m'));
      }
    }).catch(function () { setReadout('Failed to load floor grid.'); });
  }

  function setMode() {
    dom.modeBtn.textContent = selectedObject
      ? 'Placing: ' + modelLabel(selectedObject).slice(0, 18)
      : 'Click map to query height';
    dom.modeBtn.classList.toggle('active', !!selectedObject);
    if (!selectedObject && queryMarker) {
      const m = sharedMap();
      if (m) m.removeLayer(queryMarker);
      queryMarker = null;
    }
  }

  function exportPlacements() {
    if (!placements.length) { setReadout('No placements yet.'); return; }
    const out = JSON.stringify(placements, null, 2);
    const done = function () { setReadout('Exported ' + placements.length + ' placements to clipboard.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(out).then(done, fallback);
    } else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = out; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* clipboard fallback unavailable */ }
      document.body.removeChild(ta); done();
    }
  }

  function updateCount() {
    if (dom.count) dom.count.textContent = placements.length;
  }

  function setReadout(msg) { if (dom.readout) dom.readout.textContent = msg; }

  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>'"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c];
    });
  }

  // ── control UI ───────────────────────────────────────────────────────────
  function buildControl() {
    const m = sharedMap();
    if (!m) return;
    if (controlEl && controlEl.parentNode) controlEl.parentNode.removeChild(controlEl);
    controlEl = document.createElement('div');
    controlEl.className = 'dzt-control';
    controlEl.innerHTML =
      '<div class="dzt-title">Terrain &amp; placement</div>' +
      (isNasdara()
        ? '<label class="dzt-row"><input type="checkbox" id="dzt-heat"> Elevation heat-map</label>' +
          '<div class="dzt-legend" id="dzt-legend" style="display:none">' +
            '<span style="background:rgb(16,52,110)"></span><span style="background:rgb(120,150,90)"></span>' +
            '<span style="background:rgb(180,150,70)"></span><span style="background:rgb(200,200,235)"></span>' +
            '<small>0 → 1300 m</small></div>' +
          '<div class="dzt-sep"></div>' +
          '<div class="dzt-row" style="cursor:pointer" id="dzt-modebtn-wrap">' +
            '<button type="button" class="dzt-mode" id="dzt-mode">Click map to query height</button></div>' +
          '<div class="dzt-sep"></div>' +
          '<input type="search" class="dzt-search" id="dzt-search" placeholder="Search model to place…">' +
          '<div class="dzt-objs" id="dzt-objs"></div>' +
          '<div class="dzt-row"><label>Rot ° <input type="number" id="dzt-rot" value="0" min="-360" max="360" step="5" style="width:64px"></label></div>' +
          '<div class="dzt-row"><button type="button" class="dzt-btn" id="dzt-export">Export (<span id="dzt-count">0</span>)</button>' +
            '<button type="button" class="dzt-btn ghost" id="dzt-clear">Clear</button></div>' +
          '<div class="dzt-readout" id="dzt-readout">Toggle heat-map or search a model.</div>'
        : '<div class="dzt-note">Elevation + placement available for <b>Nasdara</b>.<br>(Other maps: terrain EBO is encrypted; no nav grid shipped yet.)</div>');

    // Append the panel directly to the map container (synchronous, no L.Control
    // onAdd timing). The map container is position:relative so absolute works.
    const wrap = document.createElement('div');
    wrap.className = 'dzt-wrap';
    wrap.style.cssText = 'position:absolute;right:14px;bottom:14px;z-index:1000;pointer-events:auto;';
    wrap.appendChild(controlEl);
    m.getContainer().appendChild(wrap);
    wireDom();
  }

  function wireDom() {
    dom.heat = controlEl.querySelector('#dzt-heat');
    dom.legend = controlEl.querySelector('#dzt-legend');
    dom.modeBtn = controlEl.querySelector('#dzt-mode');
    dom.search = controlEl.querySelector('#dzt-search');
    dom.objectList = controlEl.querySelector('#dzt-objs');
    dom.rot = controlEl.querySelector('#dzt-rot');
    dom.exportBtn = controlEl.querySelector('#dzt-export');
    dom.clearBtn = controlEl.querySelector('#dzt-clear');
    dom.count = controlEl.querySelector('#dzt-count');
    dom.readout = controlEl.querySelector('#dzt-readout');

    if (dom.heat) dom.heat.addEventListener('change', function () {
      heatOn = dom.heat.checked;
      if (dom.legend) dom.legend.style.display = heatOn ? 'flex' : 'none';
      rebuildHeatOverlay();
    });
    if (dom.modeBtn) dom.modeBtn.addEventListener('click', function () {
      if (selectedObject) { selectedObject = null; }
      setMode();
    });
    if (dom.search) {
      let deb = null;
      dom.search.addEventListener('input', function () {
        clearTimeout(deb);
        deb = setTimeout(function () {
          if (!isNasdara()) return;
          loadObjects().then(function () { renderObjectList(dom.search.value); }).catch(function () {});
        }, 220);
      });
      dom.search.addEventListener('focus', function () {
        if (!isNasdara()) return;
        loadObjects().then(function () { renderObjectList(dom.search.value); }).catch(function () {});
      });
    }
    if (dom.rot) dom.rot.addEventListener('input', function () {
      rotationDeg = Number(dom.rot.value) || 0;
    });
    if (dom.exportBtn) dom.exportBtn.addEventListener('click', exportPlacements);
    if (dom.clearBtn) dom.clearBtn.addEventListener('click', function () {
      placements = []; updateCount(); clearPlacements(); setReadout('Cleared.');
    });
  }

  // ── public API (called by map.js) ────────────────────────────────────────
  function onMapChange(mapName) {
    currentMapName = mapName;
    // reset per-map state
    heatOn = false; placeMode = false; selectedObject = null; placements = [];
    grid = null;  // re-fetch (cheap; only nasdara serves it)
    if (sharedMap()) {
      if (heatOverlay) sharedMap().removeLayer(heatOverlay);
      heatOverlay = null;
      clearPlacements();
    }
    buildControl();
    setMode();
    updateCount();
    // bind the map click handler once (map instance persists across map switches)
    const mm = sharedMap();
    if (mm && !clickBound) { mm.on('click', onMapClick); clickBound = true; }
    setReadout(isNasdara() ? 'Toggle heat-map or search a model.' : 'Nasdara only for terrain/placement.');
  }

  // expose; map.js calls onMapChange after initMap on load + on every switch.
  window.DayzTerrainLayer = { onMapChange: onMapChange };
})();
