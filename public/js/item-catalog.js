/* item-catalog.js — P2 item catalog classification + search (roadmap P2).
 *
 * Pure logic shared by public/items.html and scripts/item-catalog-test.js.
 * Everything here derives categories from the server's own items.json
 * (P0-A extraction of types.xml) — never from vanilla theory — and joins
 * cfgspawnabletypes spawn tuning (spawnables.json) for damage/parts.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ItemCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Full-vehicle classnames: complete vehicle prefix, minus part/variant
  // classnames (wheels, doors, hoods, trunks, batteries, ruined bits) and
  // wreck/event classnames (Wreck_*, Land_*, StaticObj_* never match).
  // shortcut: prefix list tuned to this server's types.xml; extend per new
  // vanilla vehicle classname that the server adds (UAZ/Volha/Ikarus/Heli...).
  var VEHICLE_PREFIX = /^(Boat|SeaMothership|CivilianSedan|Hatchback_0|SUV|Truck|UAZ|Volha|Ikarus|Heli|Cessna|Sedan|OffroadHatchback|Offroad_0|Motorbike_0)/;
  // Part tokens anywhere (e.g. Hatchback_02_Door_1_1 ends in the door number,
  // not the token), so this is an unanchored contains-check.
  var VEHICLE_PART = /(_Wheel|_WheelDouble|Doors|Hood|Trunk|_Door_|_Shield|Battery|_Ruined)/;

  function isVehicle(classname) {
    return VEHICLE_PREFIX.test(classname) && !VEHICLE_PART.test(classname);
  }

  // This server's Central Economy types.xml spawns ammunition both loose
  // (Ammo_556x45) and pre-packed (AmmoBox_556x45_20Rnd), both tagged
  // category=weapons — so the ammo bucket is Ammo_* + AmmoBox_*, excluding
  // the plain AmmoBox container (category=containers).
  var AMMO_RE = /^Ammo(_|Box_)/;

  // Armor is a subcategory of the server's "clothes" category (vests,
  // helmets, plate carriers) — derived, never an external taxonomy.
  var ARMOR_RE = /Vest|Helmet|PlateCarrier|ChestRig|BodyArmor|Armored/i;

  /**
   * Bucket a full item list (items.json `items`) into catalog categories.
   * weapons/ammo/armor/vehicles are disjoint; `other` is everything else.
   */
  function categorize(items) {
    var out = { weapons: [], ammo: [], armor: [], vehicles: [], other: [] };
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var c = it.category;
      var n = it.classname;
      if (AMMO_RE.test(n)) out.ammo.push(it); // beats c==='weapons': types.xml tags ammo boxes as weapons
      else if (c === 'weapons') out.weapons.push(it);
      else if (c === 'clothes' && ARMOR_RE.test(n)) out.armor.push(it);
      else if (isVehicle(n)) out.vehicles.push(it);
      else out.other.push(it);
    }
    return out;
  }

  /**
   * Classname Finder: match display name OR classname, case-insensitive
   * substring. Searches the whole catalog (all categories).
   */
  function searchCatalog(items, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return items.filter(function (it) {
      return it.classname.toLowerCase().indexOf(q) !== -1 ||
        String(it.name || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  /**
   * Server-tuned spawn info for one item: { spawn: {damageMin, damageMax,
   * parts: [{name, chance, count}], hoarder} | null }.
   * `spawnables` is the spawnables.json `types` map.
   */
  function spawnInfo(classname, spawnables) {
    var e = spawnables && spawnables[classname];
    if (!e) return null;
    var parts = (e.parts || []).map(function (p) {
      return { name: p.name, chance: p.chance, count: 1 };
    });
    // aggregate counts: a part listed 4x at 0.8 = "4x Wheel (80% each)"
    var byName = {};
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!byName[p.name]) { byName[p.name] = p; } else { byName[p.name].count += 1; }
    }
    return {
      damageMin: e.damageMin == null ? null : e.damageMin,
      damageMax: e.damageMax == null ? null : e.damageMax,
      parts: Object.keys(byName).map(function (k) { return byName[k]; }),
      hoarder: !!e.hoarder,
    };
  }

  return {
    categorize: categorize,
    searchCatalog: searchCatalog,
    spawnInfo: spawnInfo,
    isVehicle: isVehicle,
  };
});
