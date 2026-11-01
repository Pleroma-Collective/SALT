/* Place search + POI zoom-bucket rules for the map page (roadmap P0-B).
 *
 * Pure module: no DOM, no network. map.js owns the input, the result
 * rendering, and the Leaflet layers; this module owns query parsing,
 * fuzzy match ranking, and the zoom-bucket visibility rules.
 *
 * Zoom thresholds: the roadmap's "villages < z8, towns < z6, cities
 * always" is written on a standard web-mercator zoom scale; this map
 * uses L.CRS.Simple spanning zoom -2..3, so the same intent maps to
 * towns visible from z>=0 and villages from z>=1.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlaceSearch = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var POI_BUCKET_MIN_ZOOM = { city: -Infinity, town: 0, village: 1 };

  /**
   * Raw input that is exactly two numbers -> { east, north } (DayZ world
   * X/Z metres). Full-string match only, so place names that contain
   * digits can never parse as coordinates; anything else is a name query.
   */
  function parseCoordinates(raw) {
    var m = String(raw == null ? '' : raw)
      .trim()
      .match(/^(\d+(?:\.\d+)?)\s*[,\s]+\s*(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    return { east: Number(m[1]), north: Number(m[2]) };
  }

  // Spawn-group bucket from mapgroupproto usages: Town outranks Village;
  // everything without a Town/Village usage is city-tier (always visible).
  function spawnBucketOf(usages) {
    var u = usages || [];
    if (u.indexOf('Town') !== -1) return 'town';
    if (u.indexOf('Village') !== -1) return 'village';
    return 'city';
  }

  function bucketVisible(bucket, zoom) {
    var minZoom = POI_BUCKET_MIN_ZOOM[bucket];
    return minZoom !== undefined && Number(zoom) >= minZoom;
  }

  /**
   * Fuzzy match a query against an index of { label } entries:
   * exact > prefix > substring. Returns at most `limit` ranked entries.
   */
  function matchPlaces(query, index, limit) {
    var q = String(query == null ? '' : query).toLowerCase().trim();
    if (!q) return [];
    var out = [];
    for (var i = 0; i < (index || []).length; i++) {
      var label = (index[i] || {}).label;
      var hay = String(label == null ? '' : label).toLowerCase();
      var score;
      if (hay === q) score = 3;
      else if (hay.indexOf(q) === 0) score = 2;
      else if (hay.indexOf(q) !== -1) score = 1;
      else continue;
      out.push({ entry: index[i], score: score });
    }
    out.sort(function (a, b) {
      return b.score - a.score ||
        String(a.entry.label).localeCompare(String(b.entry.label));
    });
    return out.slice(0, limit || 10).map(function (s) { return s.entry; });
  }

  return {
    POI_BUCKET_MIN_ZOOM: POI_BUCKET_MIN_ZOOM,
    parseCoordinates: parseCoordinates,
    spawnBucketOf: spawnBucketOf,
    bucketVisible: bucketVisible,
    matchPlaces: matchPlaces,
  };
});
