/* loot-probability-core.js — pure logic for the Loot Probability Calculator
 * tool (roadmap Tools #1). Shared by public/tools/loot-probability.html
 * (browser) and scripts/loot-probability-test.js (node). No DOM, no network.
 *
 * Spawn model (documented on the tool page, transparency over black box):
 *   DayZ groups loot by <usage> tags (Store, Military, Farm, …). For a group G
 *   the engine draws each loot slot from every item tagged with G, weighted by
 *   its chance — DayZ 1.26+ types.xml files declare no per-item chance
 *   elements, so every weight defaults to 10000 (uniform). Hence for item X:
 *
 *       p(X in one loot slot of a G container) = w(X,G) / Σ w(I,G) over I tagged G
 *
 *   with w defaulting to 10000 unless <nominalChance>/<lifetimeChance>/
 *   <minChance> are present. <nominal> is the engine's target copy count per
 *   spawn cycle; <lifetime> is the respawn interval in seconds.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LootProbabilityCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_WEIGHT = 10000;

  /* ------------------------------------------------------------------ *
   * types.xml parsing (BiSTudio-export format: <types><type name="X">…)  *
   * ------------------------------------------------------------------ */
  // Element form <nominal>12</nominal> (this server's files) or attribute
  // form <nominal value="12"/> (older/vanilla exports).
  function numField(block, name) {
    var el = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>').exec(block);
    if (el && el[1].trim() !== '') {
      var n = Number(el[1].trim());
      if (isFinite(n)) return n;
      return null;
    }
    var self = new RegExp('<' + name + '\\b[^>]*value="([^"]*)"[^>]*\\/>').exec(block);
    if (self) {
      var n2 = Number(self[1]);
      if (isFinite(n2)) return n2;
    }
    return null;
  }

  /**
   * parseTypesXml(text) -> { ok, error?, items, duplicates }
   * items: [{ classname, nominal, lifetime, restock, min, quantmin, quantmax,
   *           cost, tier, unique, category, usages, flags,
   *           nominalChance?, lifetimeChance?, minChance? }]
   * Same field shapes as data/<map>/items.json entries (extract-dayz-data.js).
   */
  function parseTypesXml(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'Empty content — paste or drop a types.xml.', code: 'loot-empty', items: [], duplicates: 0 };
    }
    if (text.indexOf('<types') === -1) {
      return { ok: false, error: 'No <types> root — not a DayZ types.xml (did you drop a different file?).', code: 'loot-not-types', items: [], duplicates: 0 };
    }
    var items = [];
    var seen = {};
    var duplicates = 0;
    var re = /<type\s+name="([^"]*)">([\s\S]*?)<\/type>/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var name = m[1];
      if (!/^[A-Za-z0-9_]+$/.test(name)) continue; // house classname rule
      if (seen[name]) { duplicates += 1; continue; } // keep first, like the extractor
      seen[name] = true;
      var block = m[2];
      var usages = [];
      var uRe = /<usage\s+name="([^"]*)"\s*\/>/g;
      var um;
      while ((um = uRe.exec(block)) !== null) usages.push(um[1]);
      var values = [];
      var vRe = /<value\s+name="([^"]*)"\s*\/>/g;
      var vm;
      while ((vm = vRe.exec(block)) !== null) values.push(vm[1]);
      var tier = null;
      var unique = false;
      for (var i = 0; i < values.length; i++) {
        if (values[i] === 'Unique') unique = true;
        else {
          var t = /^Tier(\d+)$/.exec(values[i]);
          if (t) tier = parseInt(t[1], 10);
        }
      }
      var flags = {};
      var flagsMatch = /<flags\b([^>]*?)\/>/.exec(block);
      if (flagsMatch) {
        var fRe = /([a-z_]+)="(\d+)"/g;
        var fm;
        while ((fm = fRe.exec(flagsMatch[1])) !== null) flags[fm[1]] = Number(fm[2]);
      }
      var category = /<category\s+name="([^"]*)"\s*\/>/.exec(block);
      items.push({
        classname: name,
        nominal: numField(block, 'nominal'),
        lifetime: numField(block, 'lifetime'),
        restock: numField(block, 'restock'),
        min: numField(block, 'min'),
        quantmin: numField(block, 'quantmin'),
        quantmax: numField(block, 'quantmax'),
        cost: numField(block, 'cost'),
        tier: tier,
        unique: unique,
        category: category ? category[1] : null,
        usages: usages,
        flags: flags,
        nominalChance: numField(block, 'nominalChance'),
        lifetimeChance: numField(block, 'lifetimeChance'),
        minChance: numField(block, 'minChance')
      });
    }
    if (!items.length) {
      var rootIdx = text.indexOf('<types');
      var rootLine = text.slice(0, rootIdx).split('\n').length;
      return { ok: false, error: 'No <type name="…"> entries found — the file parses as types.xml but has no item definitions.', code: 'loot-no-entries', line: rootLine, items: [], duplicates: duplicates };
    }
    return { ok: true, items: items, duplicates: duplicates };
  }

  /* ------------------------------------------------------------------ *
   * Spawn pools + probability                                           *
   * ------------------------------------------------------------------ */
  /** Chance weight of an item for a spawn cycle ('nominal'|'lifetime'|'min'). */
  function itemWeight(item, cycle) {
    var c = item[cycle + 'Chance'];
    return typeof c === 'number' && isFinite(c) ? c : DEFAULT_WEIGHT;
  }

  /**
   * buildPools(items) -> { pools, hasCustomChances, defaultWeight }
   * pools[G] = { count, weightSum, zeroNominal } over all items tagged G
   * (literal types.xml reading: every tagged item joins the group pool,
   * nominal=0 included — surfaced separately, not silently dropped).
   */
  function buildPools(items) {
    var pools = {};
    var hasCustomChances = false;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var w = itemWeight(it, 'nominal');
      if (w !== DEFAULT_WEIGHT || itemWeight(it, 'lifetime') !== DEFAULT_WEIGHT || itemWeight(it, 'min') !== DEFAULT_WEIGHT) {
        hasCustomChances = true;
      }
      var usages = it.usages || [];
      for (var g = 0; g < usages.length; g++) {
        var p = pools[usages[g]] || (pools[usages[g]] = { count: 0, weightSum: 0, zeroNominal: 0 });
        p.count += 1;
        p.weightSum += w;
        if ((it.nominal || 0) === 0) p.zeroNominal += 1;
      }
    }
    return { pools: pools, hasCustomChances: hasCustomChances, defaultWeight: DEFAULT_WEIGHT };
  }

  /** p(item in one loot slot of group G) for one cycle, or null if the item is
   *  not tagged to G (an untagged item can never spawn in that group). */
  function groupProbability(item, pools, group, cycle) {
    if ((item.usages || []).indexOf(group) === -1) return null;
    var p = pools.pools[group];
    if (!p) return null;
    var w = itemWeight(item, cycle);
    return {
      group: group,
      poolSize: p.count,
      weight: w,
      weightSum: p.weightSum,
      zeroNominal: p.zeroNominal,
      p: w / p.weightSum
    };
  }

  /** Full per-item answer: facts + per-group probability rows. */
  function itemProbability(item, pools) {
    var usages = item.usages || [];
    var groups = [];
    for (var i = 0; i < usages.length; i++) {
      var row = groupProbability(item, pools, usages[i], 'nominal');
      if (row) groups.push(row);
    }
    groups.sort(function (a, b) { return b.p - a.p; });
    return {
      classname: item.classname,
      nominal: item.nominal || 0,
      lifetime: item.lifetime || 0,
      restock: item.restock == null ? null : item.restock,
      min: item.min || 0,
      quantmin: item.quantmin == null ? null : item.quantmin,
      quantmax: item.quantmax == null ? null : item.quantmax,
      tier: item.tier == null ? null : item.tier,
      unique: !!item.unique,
      category: item.category || null,
      usages: usages,
      crafted: !!(item.flags && item.flags.crafted),
      deloot: !!(item.flags && item.flags.deloot),
      spawnable: (item.nominal || 0) > 0,
      groups: groups
    };
  }

  /**
   * compareItems(a, b, pools) -> rows over the union of both items' groups:
   *   { group, pA, pB, ratioAB } — ratioAB = pA/pB ("A is ratioAB× rarer
   *   than B in G" when > 1); null where an item is absent from the group.
   */
  function compareItems(a, b, pools) {
    var names = [];
    function collect(it) {
      for (var i = 0; i < (it.usages || []).length; i++) {
        if (names.indexOf(it.usages[i]) === -1) names.push(it.usages[i]);
      }
    }
    collect(a);
    collect(b);
    var rows = names.map(function (g) {
      var ra = groupProbability(a, pools, g, 'nominal');
      var rb = groupProbability(b, pools, g, 'nominal');
      var ratio = (ra && rb && rb.p > 0) ? ra.p / rb.p : null;
      return { group: g, pA: ra ? ra.p : null, pB: rb ? rb.p : null, ratioAB: ratio };
    });
    rows.sort(function (x, y) {
      var xa = x.pA == null ? -1 : x.pA;
      var xb = y.pA == null ? -1 : y.pA;
      return xb - xa;
    });
    return rows;
  }

  /** Case-insensitive substring match on classname or display name. */
  function searchItems(items, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.classname.toLowerCase().indexOf(q) !== -1 ||
          (it.name || it.classname).toLowerCase().indexOf(q) !== -1) {
        out.push(it);
      }
    }
    return out;
  }

  return {
    DEFAULT_WEIGHT: DEFAULT_WEIGHT,
    parseTypesXml: parseTypesXml,
    buildPools: buildPools,
    itemWeight: itemWeight,
    groupProbability: groupProbability,
    itemProbability: itemProbability,
    compareItems: compareItems,
    searchItems: searchItems
  };
});
