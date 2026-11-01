/*
 * Canonical DayZ world-to-map definitions and transformations.
 *
 * WorldPosition uses semantic axes:
 *   east      = DayZ world X
 *   north     = DayZ world Z
 *   elevation = DayZ world Y
 *
 * ADM logs serialize those values as <east, north, elevation>; use the ADM
 * adapter before rendering instead of interpreting legacy pos_* names as
 * semantic DayZ axis names.
 */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.DayzMapCoordinates = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function definition(name, worldSize, options = {}) {
    const gridSize = options.gridSize || 32;
    const physicalTileSize = options.physicalTileSize || 512;
    const tileAdvancement = options.tileAdvancement || 480;
    const imageSize = options.imageSize || (gridSize - 1) * tileAdvancement + physicalTileSize;
    // contentWidth/Height: the extent (in image pixels) that corresponds to
    // the full world extent [0, worldSize]. Tile grids sliced with a bleed
    // carry a clamped edge band past the real canvas; the band is map margin,
    // not world content, so world<->image transforms scale by the content
    // extent, not the full image extent. Defaults to imageSize, which keeps
    // every existing map byte-for-byte identical (their 32px bleed band was
    // always mapped as harmless margin).
    const contentWidth = options.contentWidth || imageSize;
    const contentHeight = options.contentHeight || imageSize;
    // pixel -> world transform. Defaults preserve the legacy uniform scale
    // (the full content extent maps to [0, worldSize]). Calibrated maps set
    // an explicit per-pixel scale + offset to match the true lco raster
    // geometry — some maps (nasdara) carry a large edge bleed the uniform
    // worldSize/imageSize scale cannot represent.
    const pixelScaleEast = options.pixelScaleEast || worldSize / contentWidth;
    const pixelScaleNorth = options.pixelScaleNorth || worldSize / contentHeight;
    const pixelOffsetEast = options.pixelOffsetEast || 0;
    const pixelOffsetNorth = options.pixelOffsetNorth || 0;
    return Object.freeze({
      id: name,
      name: options.name || name,
      worldMinEast: 0,
      worldMaxEast: worldSize,
      worldMinNorth: 0,
      worldMaxNorth: worldSize,
      worldWidth: worldSize,
      worldHeight: worldSize,
      imageWidth: imageSize,
      imageHeight: imageSize,
      contentWidth,
      contentHeight,
      pixelScaleEast,
      pixelScaleNorth,
      pixelOffsetEast,
      pixelOffsetNorth,
      gridSize,
      physicalTileSize,
      tileAdvancement,
      tileOverlap: physicalTileSize - tileAdvancement,
      verifiedGeometry: options.verifiedGeometry !== false,

      // Compatibility aliases for existing Leaflet consumers.
      size: imageSize,
      gameSize: worldSize,
      physicalSize: physicalTileSize,
      advancement: tileAdvancement,
      tileSize: tileAdvancement,
      overlap: physicalTileSize - tileAdvancement,
    });
  }

  const MAP_DEFINITIONS = Object.freeze({
    chernarusplus: definition('chernarusplus', 15360, { name: 'Chernarus+' }),
    enoch: definition('enoch', 12800, { name: 'Livonia' }),
    sakhal: definition('sakhal', 15360, { name: 'Sakhal' }),

    // Nasdara (DayZ 1.30 / Badlands). World extent 16350 is authoritative from
    // the navmesh header (worlds_nasdara_nav.pbo: 327x327 cells at 50.0 units).
    // Source is the game's 43x43 lco terrain tiles (worlds_nasdara_data.pbo),
    // row 0 = north. Each lco tile is a physical 512px canvas whose content
    // advances only 384px: every tile overlaps its right and lower neighbor
    // by exactly 128px (verified 2026-10-22: max pixel diff over all 3444
    // adjacent pairs at the 384 advance is 0.0, so raw tiles are seamless and
    // no cross-fade is needed). The full 43x43 atlas is the world:
    // 42*384 + 512 = 16640 px vs 16350 world units (1.018 px/unit, matching
    // the other maps' ~1.0 scale). Tile files map 1:1 to the source
    // (file tiles/{a}/{b}.png == s_{a}_{b}_lco.png, byte-identical).
    // (Supersedes the 2026-10-21 32x32/512-advance + cross-fade build, which
    // was based on a wrong no-overlap measurement taken at a 32px window.)
    nasdara: definition('nasdara', 16384, {
      name: 'Nasdara',
      gridSize: 43,
      tileAdvancement: 384,
      physicalTileSize: 512,
      verifiedGeometry: true,
      // Calibrated against an in-game (izurvive) ground-truth point: the
      // 16640px lco raster carries a large edge bleed, so world = pixel at
      // 1:1 with a constant offset (east -65, north -193) — NOT the uniform
      // worldSize/imageSize scale the smaller-bleed maps use.
      pixelScaleEast: 1,
      pixelScaleNorth: 1,
      pixelOffsetEast: -65,
      pixelOffsetNorth: -193,
    }),

    // These definitions preserve existing behavior until matching raster assets
    // and authoritative terrain bounds are available for calibration.
    namalsk: definition('namalsk', 12800, {
      name: 'Namalsk',
      imageSize: 15424,
      tileAdvancement: 482,
      verifiedGeometry: false,
    }),
    takistanplus: definition('takistanplus', 12800, {
      name: 'Takistan+',
      imageSize: 12800,
      tileAdvancement: 400,
      verifiedGeometry: false,
    }),
  });

  function finiteNumber(value, fieldName) {
    if (value === null || value === undefined || value === '') {
      throw new TypeError(`${fieldName} must be a finite number`);
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`${fieldName} must be a finite number`);
    return number;
  }


  function getMapDefinition(mapName, fallbackMapName = 'chernarusplus') {
    return MAP_DEFINITIONS[mapName] || MAP_DEFINITIONS[fallbackMapName] || MAP_DEFINITIONS.chernarusplus;
  }

  function worldToLeaflet(position, mapName) {
    const map = getMapDefinition(mapName);
    const east = finiteNumber(position.east, 'east');
    const north = finiteNumber(position.north, 'north');
    return [
      (north - map.pixelOffsetNorth) / map.pixelScaleNorth,
      (east - map.pixelOffsetEast) / map.pixelScaleEast,
    ];
  }

  function leafletToWorld(position, mapName) {
    const map = getMapDefinition(mapName);
    const lat = finiteNumber(position.lat, 'lat');
    const lng = finiteNumber(position.lng, 'lng');
    return {
      east: map.pixelOffsetEast + lng * map.pixelScaleEast,
      north: map.pixelOffsetNorth + lat * map.pixelScaleNorth,
    };
  }

  // World meters -> image pixels. Use this for radii/lengths drawn on the
  // map (circles, ranges); it equals the world<->image scale the
  // transforms above use.
  function pixelsPerWorldUnit(mapName) {
    const map = getMapDefinition(mapName);
    return 1 / map.pixelScaleEast;
  }


  function tileBounds(x, y, mapName) {
    const map = getMapDefinition(mapName);
    const tileX = finiteNumber(x, 'tile x');
    const tileY = finiteNumber(y, 'tile y');
    return [
      [tileY * map.tileAdvancement, tileX * map.tileAdvancement],
      [tileY * map.tileAdvancement + map.physicalTileSize,
        tileX * map.tileAdvancement + map.physicalTileSize],
    ];
  }

  function tileFileCoordinates(x, y, mapName) {
    const map = getMapDefinition(mapName);
    const tileX = finiteNumber(x, 'tile x');
    const tileY = finiteNumber(y, 'tile y');
    if (!Number.isInteger(tileX) || !Number.isInteger(tileY) ||
        tileX < 0 || tileY < 0 || tileX >= map.gridSize || tileY >= map.gridSize) return null;
    return { x: tileX, y: (map.gridSize - 1) - tileY };
  }

  return Object.freeze({
    MAP_DEFINITIONS,
    getMapDefinition,
    worldToLeaflet,
    leafletToWorld,
    pixelsPerWorldUnit,

    tileBounds,
    tileFileCoordinates,
  });
}));
