/* loadout-generator-core.js — pure logic for the Loadout Generator
 * (card t_3ed714bd). UMD: in Node it exports via module.exports (used by
 * scripts/loadout-generator-test.js); in the browser it sets
 * globalThis.LoadoutGeneratorCore. No DOM, no network — the toolkit
 * security contract (scripts/toolkit-client-test.js) applies.
 *
 * Emits the exact JSON shape used by
 * dayz-library/community_builds/loadouts/kitty_loadouts/*.json:
 *   { spawnWeight, name, characterTypes,
 *     attachmentSlotItemSets: [{slotName, discreteItemSets:[item]}],
 *     discreteUnsortedItemSets: [{name, spawnWeight, attributes,
 *        complexChildrenTypes:[item], (simpleChildrenTypes,
 *        simpleChildrenUseDefaultAttributes)}],
 *     (simpleChildrenTypes, simpleChildrenUseDefaultAttributes) }
 * item = { itemType, spawnWeight, attributes, quickBarSlot,
 *          (simpleChildrenTypes, simpleChildrenUseDefaultAttributes) }
 * Quantities are repeated entries (the CE convention: one entry = one item).
 * shortcut: item-level complexChildrenTypes (container-inside-container,
 * ~9% of corpus entries, e.g. NVG headstraps) is not modeled — add it here
 * if a real loadout needs it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LoadoutGeneratorCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The 14 slot names observed across all 42 kitty_loadouts files.
  var STANDARD_SLOTS = [
    'Body', 'Legs', 'Feet', 'Headgear', 'Mask', 'Gloves', 'Hands', 'Vest',
    'Back', 'Eyewear', 'Armband', 'Hips', 'shoulderL', 'shoulderR'
  ];

  // The 28 character types observed in the same corpus.
  var KNOWN_CHARACTER_TYPES = [
    'SurvivorF_Baty', 'SurvivorF_Eva', 'SurvivorF_Frida', 'SurvivorF_Gabi',
    'SurvivorF_Helga', 'SurvivorF_Irena', 'SurvivorF_Keiko', 'SurvivorF_Linda',
    'SurvivorF_Maria', 'SurvivorF_Naomi',
    'SurvivorM_Boris', 'SurvivorM_Cyril', 'SurvivorM_Denis', 'SurvivorM_Elias',
    'SurvivorM_Guo', 'SurvivorM_Hassan', 'SurvivorM_Indar', 'SurvivorM_Jose',
    'SurvivorM_Kaito', 'SurvivorM_Manua', 'SurvivorM_Mirek', 'SurvivorM_Niki',
    'SurvivorM_Oliver', 'SurvivorM_Peter', 'SurvivorM_Quinn', 'SurvivorM_Rolf',
    'SurvivorM_Seth', 'SurvivorM_Taiki'
  ];

  var DEFAULT_ATTRIBUTES = { healthMin: 1.0, healthMax: 1.0, quantityMin: 1.0, quantityMax: 1.0 };
  var TOP_LEVEL_KEYS = ['spawnWeight', 'name', 'characterTypes', 'attachmentSlotItemSets', 'discreteUnsortedItemSets', 'simpleChildrenUseDefaultAttributes', 'simpleChildrenTypes'];
  var CARGO_KEYS = ['name', 'spawnWeight', 'attributes', 'complexChildrenTypes', 'simpleChildrenUseDefaultAttributes', 'simpleChildrenTypes'];
  var ITEM_KEYS = ['itemType', 'spawnWeight', 'attributes', 'quickBarSlot', 'simpleChildrenUseDefaultAttributes', 'simpleChildrenTypes', 'complexChildrenTypes'];
  var ATTR_KEYS = ['healthMin', 'healthMax', 'quantityMin', 'quantityMax'];

  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

  // One composed entry -> repeated raw CE item entries (qty = copies).
  function buildItem(entry) {
    var out = [];
    var qty = Math.max(1, Math.floor(entry.qty || 1));
    for (var i = 0; i < qty; i++) {
      var item = {
        itemType: entry.itemType,
        spawnWeight: entry.spawnWeight == null ? 1 : entry.spawnWeight,
        attributes: {
          healthMin: entry.healthMin == null ? 1.0 : entry.healthMin,
          healthMax: entry.healthMax == null ? 1.0 : entry.healthMax,
          quantityMin: 1.0,
          quantityMax: 1.0
        },
        quickBarSlot: -1
      };
      if (entry.simpleChildren && entry.simpleChildren.length) {
        item.simpleChildrenUseDefaultAttributes = false;
        item.simpleChildrenTypes = entry.simpleChildren.slice();
      }
      out.push(item);
    }
    return out;
  }

  /**
   * state = {
   *   name, spawnWeight, characterTypes: [],
   *   slots:  [{ slotName, items: [{itemType, qty, spawnWeight, simpleChildren: []}] }],
   *   cargo:  [{ name, spawnWeight, health, items: [...same shape...], simpleChildren: [] }],
   *   loose:      [{ itemType, qty }]   // top-level simpleChildrenTypes
   * }
   * Returns a kitty/CE loadout document (key order matches the corpus).
   */
  function buildLoadout(state) {
    state = state || {};
    var doc = {
      spawnWeight: state.spawnWeight == null ? 1 : state.spawnWeight,
      name: state.name || 'Player',
      characterTypes: (state.characterTypes || []).slice(),
      attachmentSlotItemSets: (state.slots || []).map(function (s) {
        return {
          slotName: s.slotName,
          discreteItemSets: (s.items || []).reduce(function (acc, e) {
            return acc.concat(buildItem(e));
          }, [])
        };
      }),
      discreteUnsortedItemSets: (state.cargo || []).map(function (c) {
        var health = c.health == null ? 1.0 : c.health;
        var section = {
          name: c.name,
          spawnWeight: c.spawnWeight == null ? 1 : c.spawnWeight,
          attributes: { healthMin: health, healthMax: health, quantityMin: 1.0, quantityMax: 1.0 },
          complexChildrenTypes: (c.items || []).reduce(function (acc, e) {
            return acc.concat(buildItem(e));
          }, [])
        };
        if (c.simpleChildren && c.simpleChildren.length) {
          section.simpleChildrenUseDefaultAttributes = false;
          section.simpleChildrenTypes = c.simpleChildren.slice();
        }
        return section;
      })
    };
    if (state.loose && state.loose.length) {
      var loose = [];
      state.loose.forEach(function (e) {
        for (var i = 0; i < Math.max(1, Math.floor(e.qty || 1)); i++) loose.push(e.itemType);
      });
      doc.simpleChildrenUseDefaultAttributes = false;
      doc.simpleChildrenTypes = loose;
    }
    return doc;
  }

  function checkAttributes(errors, path, attrs) {
    if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) {
      errors.push({ path: path + '.attributes', message: 'attributes must be an object' });
      return;
    }
    ATTR_KEYS.forEach(function (k) {
      if (typeof attrs[k] !== 'number' || !isFinite(attrs[k])) {
        errors.push({ path: path + '.attributes.' + k, message: 'must be a finite number' });
      }
    });
    if (typeof attrs.healthMin === 'number' && typeof attrs.healthMax === 'number' && attrs.healthMin > attrs.healthMax) {
      errors.push({ path: path + '.attributes', message: 'healthMin (' + attrs.healthMin + ') > healthMax (' + attrs.healthMax + ')' });
    }
    if (typeof attrs.quantityMin === 'number' && typeof attrs.quantityMax === 'number' && attrs.quantityMin > attrs.quantityMax) {
      errors.push({ path: path + '.attributes', message: 'quantityMin (' + attrs.quantityMin + ') > quantityMax (' + attrs.quantityMax + ')' });
    }
  }

  function checkSpawnWeight(errors, path, v) {
    if (!isInt(v) || v < 0) errors.push({ path: path, message: 'spawnWeight must be an integer >= 0 (got ' + JSON.stringify(v) + ')' });
  }

  function checkStringList(errors, path, v) {
    if (!Array.isArray(v)) { errors.push({ path: path, message: 'must be an array' }); return; }
    v.forEach(function (s, i) {
      if (typeof s !== 'string' || !s) errors.push({ path: path + '[' + i + ']', message: 'must be a non-empty string' });
    });
  }

  function checkItem(errors, path, item) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push({ path: path, message: 'must be an item object' });
      return;
    }
    Object.keys(item).forEach(function (k) {
      if (ITEM_KEYS.indexOf(k) === -1) errors.push({ path: path + '.' + k, message: 'unknown key in item' });
    });
    if (typeof item.itemType !== 'string' || !item.itemType) {
      errors.push({ path: path + '.itemType', message: 'must be a non-empty string' });
    }
    // quickBarSlot and spawnWeight are optional on items (the corpus omits
    // them on ~half of all item entries; the engine applies defaults).
    if ('spawnWeight' in item) checkSpawnWeight(errors, path + '.spawnWeight', item.spawnWeight);
    checkAttributes(errors, path, item.attributes);
    if ('quickBarSlot' in item && (typeof item.quickBarSlot !== 'number' || !isInt(item.quickBarSlot) || item.quickBarSlot < -1)) {
      errors.push({ path: path + '.quickBarSlot', message: 'must be an integer >= -1 (got ' + JSON.stringify(item.quickBarSlot) + ')' });
    }
    if ('simpleChildrenTypes' in item) checkStringList(errors, path + '.simpleChildrenTypes', item.simpleChildrenTypes);
    if ('simpleChildrenUseDefaultAttributes' in item && typeof item.simpleChildrenUseDefaultAttributes !== 'boolean') {
      errors.push({ path: path + '.simpleChildrenUseDefaultAttributes', message: 'must be a boolean' });
    }
    if ('complexChildrenTypes' in item) {
      if (!Array.isArray(item.complexChildrenTypes)) {
        errors.push({ path: path + '.complexChildrenTypes', message: 'must be an array' });
      } else {
        item.complexChildrenTypes.forEach(function (child, i) {
          checkItem(errors, path + '.complexChildrenTypes[' + i + ']', child);
        });
      }
    }
  }

  /** Structural validation of a parsed kitty/CE loadout document.
   * Returns { ok, errors: [{path, message}] } — precise, path-qualified. */
  function validate(doc) {
    var errors = [];
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      return { ok: false, errors: [{ path: '', message: 'top level must be a JSON object' }] };
    }
    Object.keys(doc).forEach(function (k) {
      if (TOP_LEVEL_KEYS.indexOf(k) === -1) errors.push({ path: k, message: 'unknown top-level key' });
    });
    checkSpawnWeight(errors, 'spawnWeight', doc.spawnWeight);
    if (typeof doc.name !== 'string' || !doc.name) errors.push({ path: 'name', message: 'must be a non-empty string' });
    checkStringList(errors, 'characterTypes', doc.characterTypes);

    if (!Array.isArray(doc.attachmentSlotItemSets)) {
      errors.push({ path: 'attachmentSlotItemSets', message: 'must be an array' });
    } else {
      doc.attachmentSlotItemSets.forEach(function (entry, i) {
        var p = 'attachmentSlotItemSets[' + i + ']';
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          errors.push({ path: p, message: 'must be an object' });
          return;
        }
        if ('slotName' in entry) {
          if (typeof entry.slotName !== 'string' || !entry.slotName) errors.push({ path: p + '.slotName', message: 'must be a non-empty string' });
          if (!Array.isArray(entry.discreteItemSets)) {
            errors.push({ path: p + '.discreteItemSets', message: 'must be an array' });
          } else {
            entry.discreteItemSets.forEach(function (it, j) { checkItem(errors, p + '.discreteItemSets[' + j + ']', it); });
          }
        } else if ('itemType' in entry) {
          // Bare attached item (observed: vests, NVG headstraps).
          checkItem(errors, p, entry);
        } else {
          errors.push({ path: p, message: 'must be a slot ({slotName, discreteItemSets}) or an item ({itemType, …})' });
        }
      });
    }

    if (!Array.isArray(doc.discreteUnsortedItemSets)) {
      errors.push({ path: 'discreteUnsortedItemSets', message: 'must be an array' });
    } else {
      doc.discreteUnsortedItemSets.forEach(function (c, i) {
        var p = 'discreteUnsortedItemSets[' + i + ']';
        if (typeof c !== 'object' || c === null || Array.isArray(c)) {
          errors.push({ path: p, message: 'must be an object' });
          return;
        }
        Object.keys(c).forEach(function (k) {
          if (CARGO_KEYS.indexOf(k) === -1) errors.push({ path: p + '.' + k, message: 'unknown key in cargo section' });
        });
        if (typeof c.name !== 'string' || !c.name) errors.push({ path: p + '.name', message: 'must be a non-empty string' });
        checkSpawnWeight(errors, p + '.spawnWeight', c.spawnWeight);
        checkAttributes(errors, p, c.attributes);
        if (!Array.isArray(c.complexChildrenTypes)) {
          errors.push({ path: p + '.complexChildrenTypes', message: 'must be an array' });
        } else {
          c.complexChildrenTypes.forEach(function (it, j) { checkItem(errors, p + '.complexChildrenTypes[' + j + ']', it); });
        }
        if ('simpleChildrenTypes' in c) checkStringList(errors, p + '.simpleChildrenTypes', c.simpleChildrenTypes);
        if ('simpleChildrenUseDefaultAttributes' in c && typeof c.simpleChildrenUseDefaultAttributes !== 'boolean') {
          errors.push({ path: p + '.simpleChildrenUseDefaultAttributes', message: 'must be a boolean' });
        }
      });
    }

    if ('simpleChildrenTypes' in doc) checkStringList(errors, 'simpleChildrenTypes', doc.simpleChildrenTypes);
    if ('simpleChildrenUseDefaultAttributes' in doc && typeof doc.simpleChildrenUseDefaultAttributes !== 'boolean') {
      errors.push({ path: 'simpleChildrenUseDefaultAttributes', message: 'must be a boolean' });
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /** Validate a raw JSON string; parse errors carry position. */
  function validateText(text) {
    var doc;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      return { ok: false, errors: [{ path: '', message: 'JSON parse error: ' + err.message }] };
    }
    return validate(doc);
  }

  function toJSON(doc) { return JSON.stringify(doc, null, 2) + '\n'; }

  // kitty file-naming convention: loadout<name>.json
  function slugify(name) {
    var slug = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return 'loadout' + (slug || 'custom') + '.json';
  }

  return {
    STANDARD_SLOTS: STANDARD_SLOTS,
    KNOWN_CHARACTER_TYPES: KNOWN_CHARACTER_TYPES,
    DEFAULT_ATTRIBUTES: DEFAULT_ATTRIBUTES,
    buildLoadout: buildLoadout,
    validate: validate,
    validateText: validateText,
    toJSON: toJSON,
    slugify: slugify
  };
});
