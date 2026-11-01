/* spawnabletypes-generator-core.js — pure logic for the Spawnabletypes
 * Generator (card t_14209206). UMD: in Node it exports via module.exports
 * (used by scripts/spawnabletypes-generator-test.js); in the browser it sets
 * globalThis.SpawnabletypesGeneratorCore. No DOM, no network — the toolkit
 * security contract (scripts/toolkit-client-test.js) applies.
 *
 * Emits the exact cfgspawnabletypes.xml format that CE missions ship
 * (audited against all six real mission files in the DayZ-Central-Economy
 * baseline + the live nasdara mission): root <spawnabletypes>; per type
 * <type name="Class"> with any subset of <tag name=/> (emitted first),
 * <damage min= max=/>, <cargo preset=/> (repeatable), <cargo> with explicit
 * <item> children, <attachments preset=/> or <attachments chance=> with
 * <item> children (repeatable groups), <hoarder /> (emitted last); empty
 * types are legal (the corpus carries 56).
 *
 * State model (one object per type):
 *   { name: 'Foo',
 *     hoarder: false,
 *     damage: { min, max } | null,
 *     sections: [ { kind: 'cargo-preset', preset }
 *               | { kind: 'cargo-items', chance?, items: [item] }
 *               | { kind: 'attach-preset', preset }
 *               | { kind: 'attach-items', chance, items: [item] }
 *               | { kind: 'tag', name } ] }
 * item = { name, chance?, damage?: { min, max }, cargo?: [ cargo-section ] }
 * — cargo-section is the same shape as a cargo-items/cargo-preset section.
 * Nested item tuning (damage + explicit cargo on an item that spawns inside
 * a container) appears in the real corpus (event-pack trucks/storage boxes,
 * 85 nested entries); nesting is exactly two levels in every corpus file.
 *
 * Serializer conventions (byte-level, matched to the corpus): XML 1.0
 * declaration + blank line, tab indentation, self-closing tags with a
 * space before "/>", damage numbers trimmed to <=2 decimals (at least one),
 * attachment/item chances always 2 decimals ("0.85", "1.00"), explicit
 * cargo chance bare when integral ("1").
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SpawnabletypesGeneratorCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CLASSNAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
  var SECTION_KINDS = ['cargo-preset', 'cargo-items', 'attach-preset', 'attach-items', 'tag'];
  var ROOT_TAG = 'spawnabletypes';
  var TYPE_CHILD_TAGS = ['damage', 'cargo', 'attachments', 'hoarder', 'tag'];

  // Preset names observed across the six corpus files (datalists for the UI;
  // free-text presets remain legal).
  var CARGO_PRESETS = [
    'mixArmy', 'mixVillage', 'mixHunter', 'foodArmy', 'foodCity', 'foodVillage',
    'foodHermit', 'toolsArmy', 'toolsCity', 'toolsVillage', 'toolsIndustrial',
    'toolsMedic', 'toolsPolice', 'toolsHermit', 'ammoArmy', 'ammoPolice',
    'ContaminatedCargo'
  ];
  var ATTACH_PRESETS = [
    'bagsArmy', 'bagsCity', 'bagsVillage', 'bagsHunter',
    'glassesCity', 'glassesVillage',
    'hatsArmy', 'hatsCity', 'hatsCitySkate', 'hatsIndustrial', 'hatsVillage',
    'hatsFarm', 'hatsHunter', 'hatsPolice', 'hatsFirefighter', 'hatsMedic',
    'hatsPrisoner', 'hatsMotorbike',
    'vestsArmy', 'vestsCity', 'vestsIndustrial', 'vestsPolice', 'vestsHunter',
    'headtorches', 'HeavyArmorArmy', 'HeavyHelmetArmy'
  ];

  var XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';

  function isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }
  function isProba(v) { return isFiniteNumber(v) && v >= 0 && v <= 1; }
  function isClassname(v) { return typeof v === 'string' && CLASSNAME_RE.test(v); }

  function fmtDamage(n) { return n.toFixed(2).replace(/0$/, ''); } // 0.1, 0.32, 0.0
  function fmtChance(n) { return n.toFixed(2); }                 // 0.85, 1.00
  // Corpus writes explicit-cargo chance bare when integral ("1"), trimmed
  // otherwise ("0.8") — same rule as damage, but integers stay bare.
  function fmtCargoChance(n) { return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''); }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  /**
   * state -> complete standalone cfgspawnabletypes.xml text.
   * Child order: tag, damage, cargo (presets then explicit), attachments
   * (presets then explicit groups), hoarder — the order every corpus file
   * uses (the one attachments-before-cargo file is normalized).
   */
  function toXML(state) {
    state = state || { types: [] };
    var lines = [XML_DECL, '', '<' + ROOT_TAG + '>'];
    (state.types || []).forEach(function (t) {
      lines.push('\t<type name="' + escAttr(t.name) + '">');
      var body = [];
      var sections = t.sections || [];
      sections.forEach(function (s) {
        if (s.kind === 'tag') body.push('\t\t<tag name="' + escAttr(s.name) + '" />');
      });
      if (t.damage) body.push('\t\t<damage min="' + fmtDamage(t.damage.min) + '" max="' + fmtDamage(t.damage.max) + '" />');
      sections.forEach(function (s) {
        if (s.kind === 'cargo-preset') body.push('\t\t<cargo preset="' + escAttr(s.preset) + '" />');
      });
      sections.forEach(function (s) {
        if (s.kind === 'cargo-items') body.push(cargoItemsXml(s, '\t\t'));
      });
      sections.forEach(function (s) {
        if (s.kind === 'attach-preset') body.push('\t\t<attachments preset="' + escAttr(s.preset) + '" />');
      });
      sections.forEach(function (s) {
        if (s.kind === 'attach-items') body.push(attachItemsXml(s, '\t\t'));
      });
      if (t.hoarder) body.push('\t\t<hoarder />');
      body.forEach(function (l) { lines.push(l); });
      lines.push('\t</type>');
    });
    lines.push('</' + ROOT_TAG + '>');
    return lines.join('\n') + '\n';
  }

  function itemXml(it, indent) {
    var hasChildren = !!(it.damage || (it.cargo && it.cargo.length));
    if (!hasChildren) {
      var a = ' name="' + escAttr(it.name) + '"';
      if (it.chance != null) a += ' chance="' + fmtChance(it.chance) + '"';
      return indent + '<item' + a + ' />';
    }
    var head = ' name="' + escAttr(it.name) + '"';
    if (it.chance != null) head += ' chance="' + fmtChance(it.chance) + '"';
    var lines = [indent + '<item' + head + '>'];
    if (it.damage) lines.push(indent + '\t<damage min="' + fmtDamage(it.damage.min) + '" max="' + fmtDamage(it.damage.max) + '" />');
    (it.cargo || []).forEach(function (c) {
      lines.push(c.kind === 'cargo-preset' ? indent + '\t<cargo preset="' + escAttr(c.preset) + '" />' : cargoItemsXml(c, indent + '\t'));
    });
    lines.push(indent + '</item>');
    return lines.join('\n');
  }

  function cargoItemsXml(s, indent) {
    var head = indent + '<cargo' + (s.chance != null ? ' chance="' + fmtCargoChance(s.chance) + '"' : '') + '>';
    var lines = [head];
    (s.items || []).forEach(function (it) { lines.push(itemXml(it, indent + '\t')); });
    lines.push(indent + '</cargo>');
    return lines.join('\n');
  }

  function attachItemsXml(s, indent) {
    var lines = [indent + '<attachments chance="' + fmtChance(s.chance) + '">'];
    (s.items || []).forEach(function (it) { lines.push(itemXml(it, indent + '\t')); });
    lines.push(indent + '</attachments>');
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ */
  // Validation — path-qualified errors, mirrors the corpus schema.
  /* ------------------------------------------------------------------ */
  function checkSection(errors, path, s) {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      errors.push({ path: path, message: 'section must be an object' });
      return;
    }
    var known = ['kind', 'preset', 'chance', 'items', 'name'];
    Object.keys(s).forEach(function (k) {
      if (known.indexOf(k) === -1) errors.push({ path: path + '.' + k, message: 'unknown key in section' });
    });
    if (typeof s.kind !== 'string' || SECTION_KINDS.indexOf(s.kind) === -1) {
      errors.push({ path: path + '.kind', message: 'must be one of ' + SECTION_KINDS.join(', ') + ' (got ' + JSON.stringify(s.kind) + ')' });
      return;
    }
    if (s.kind === 'cargo-preset' || s.kind === 'attach-preset') {
      if (typeof s.preset !== 'string' || !s.preset) errors.push({ path: path + '.preset', message: 'must be a non-empty preset name' });
    } else if (s.kind === 'tag') {
      if (typeof s.name !== 'string' || !s.name) errors.push({ path: path + '.name', message: 'must be a non-empty tag name' });
    } else { // cargo-items / attach-items
      if (s.chance != null && !isProba(s.chance)) {
        errors.push({ path: path + '.chance', message: 'must be a number in 0..1 (got ' + JSON.stringify(s.chance) + ')' });
      }
      if (s.kind === 'attach-items' && s.chance == null) {
        errors.push({ path: path + '.chance', message: 'required on explicit attachment groups (the corpus always carries it)' });
      }
      if (!Array.isArray(s.items) || !s.items.length) {
        errors.push({ path: path + '.items', message: 'must be a non-empty array of items' });
      } else {
        s.items.forEach(function (it, i) {
          checkItem(errors, path + '.items[' + i + ']', it);
        });
      }
    }
  }

  function checkDamage(errors, path, d) {
    if (typeof d !== 'object' || d === null || Array.isArray(d)) {
      errors.push({ path: path, message: 'must be { min, max } or null' });
      return;
    }
    if (!isFiniteNumber(d.min)) errors.push({ path: path + '.min', message: 'must be a finite number' });
    if (!isFiniteNumber(d.max)) errors.push({ path: path + '.max', message: 'must be a finite number' });
    if (isFiniteNumber(d.min) && (d.min < 0 || d.min > 1)) errors.push({ path: path + '.min', message: 'must be in 0..1 (got ' + d.min + ')' });
    if (isFiniteNumber(d.max) && (d.max < 0 || d.max > 1)) errors.push({ path: path + '.max', message: 'must be in 0..1 (got ' + d.max + ')' });
    if (isFiniteNumber(d.min) && isFiniteNumber(d.max) && d.min > d.max) {
      errors.push({ path: path, message: 'min (' + d.min + ') > max (' + d.max + ')' });
    }
  }

  function checkNestedCargo(errors, path, cargo) {
    if (!Array.isArray(cargo)) {
      errors.push({ path: path, message: 'must be an array of cargo sections' });
      return;
    }
    cargo.forEach(function (c, i) {
      var cp = path + '[' + i + ']';
      if (typeof c !== 'object' || c === null || Array.isArray(c)) {
        errors.push({ path: cp, message: 'must be a cargo section' });
        return;
      }
      if (c.kind === 'cargo-preset') {
        if (typeof c.preset !== 'string' || !c.preset) errors.push({ path: cp + '.preset', message: 'must be a non-empty preset name' });
      } else if (c.kind === 'cargo-items') {
        checkSection(errors, cp, c);
      } else {
        errors.push({ path: cp + '.kind', message: 'nested item cargo may only be cargo-preset or cargo-items (got ' + JSON.stringify(c.kind) + ')' });
      }
    });
  }

  function checkItem(errors, path, it) {
    if (typeof it !== 'object' || it === null || Array.isArray(it)) {
      errors.push({ path: path, message: 'item must be an object' });
      return;
    }
    var known = ['name', 'chance', 'damage', 'cargo'];
    Object.keys(it).forEach(function (k) {
      if (known.indexOf(k) === -1) errors.push({ path: path + '.' + k, message: 'unknown key in item' });
    });
    if (!isClassname(it.name)) {
      errors.push({ path: path + '.name', message: 'must be a valid classname (letters/digits/underscore, starting with a letter) — got ' + JSON.stringify(it.name) });
    }
    if (it.chance != null && (!isFiniteNumber(it.chance) || it.chance < 0)) {
      errors.push({ path: path + '.chance', message: 'must be a number >= 0 (got ' + JSON.stringify(it.chance) + ')' });
    }
    if ('damage' in it) checkDamage(errors, path + '.damage', it.damage);
    if ('cargo' in it) checkNestedCargo(errors, path + '.cargo', it.cargo);
  }

  /** Structural validation of a state. Returns { ok, errors: [{path, message}] }. */
  function validate(state) {
    var errors = [];
    if (typeof state !== 'object' || state === null || Array.isArray(state)) {
      return { ok: false, errors: [{ path: '', message: 'top level must be a state object with types[]' }] };
    }
    if (!Array.isArray(state.types)) {
      return { ok: false, errors: [{ path: 'types', message: 'must be an array' }] };
    }
    var seen = {};
    state.types.forEach(function (t, i) {
      var p = 'types[' + i + ']';
      if (typeof t !== 'object' || t === null || Array.isArray(t)) {
        errors.push({ path: p, message: 'must be a type object' });
        return;
      }
      Object.keys(t).forEach(function (k) {
        if (['name', 'hoarder', 'damage', 'sections'].indexOf(k) === -1) {
          errors.push({ path: p + '.' + k, message: 'unknown key in type' });
        }
      });
      if (!isClassname(t.name)) {
        errors.push({ path: p + '.name', message: 'must be a valid classname — got ' + JSON.stringify(t.name) });
      } else if (seen[t.name] != null) {
        errors.push({ path: p + '.name', message: 'duplicate type name (first used at types[' + seen[t.name] + '])' });
      } else {
        seen[t.name] = i;
      }
      if ('hoarder' in t && typeof t.hoarder !== 'boolean') {
        errors.push({ path: p + '.hoarder', message: 'must be a boolean' });
      }
      if ('damage' in t) {
        checkDamage(errors, p + '.damage', t.damage);
      }
      if ('sections' in t) {
        if (!Array.isArray(t.sections)) {
          errors.push({ path: p + '.sections', message: 'must be an array' });
        } else {
          t.sections.forEach(function (s, j) { checkSection(errors, p + '.sections[' + j + ']', s); });
        }
      }
    });
    return { ok: errors.length === 0, errors: errors };
  }

  /* ------------------------------------------------------------------ */
  // Parsing a generic element model {tag, attrs, children} -> state.
  // This is the format contract against real mission files: stateFromModel
  // on a real cfgspawnabletypes.xml must succeed with zero errors, and
  // toXML(stateFromModel(real)) must re-parse to the same state.
  /* ------------------------------------------------------------------ */
  function numAttr(attrs, key, p, errors, required) {
    if (key in attrs) {
      var v = Number(attrs[key]);
      if (!isFiniteNumber(v)) {
        errors.push({ path: p + '.' + key, message: 'invalid number "' + attrs[key] + '"' });
        return undefined;
      }
      return v;
    }
    if (required) errors.push({ path: p + '.' + key, message: 'attribute is required' });
    return undefined;
  }

  /** Parse one <item> node (recursively — items may carry their own
   *  <damage> and <cargo> children). Returns the item object, or null when
   *  the name is unusable. Errors go to the shared `errors` array. */
  function parseItemNode(ic, ip, errors) {
    if (ic.text) errors.push({ path: ip, message: '<item> must not contain text' });
    Object.keys(ic.attrs).forEach(function (a) {
      if (a !== 'name' && a !== 'chance') errors.push({ path: ip + '.' + a, message: 'unknown attribute on <item>' });
    });
    var iname = ic.attrs.name;
    var ichance = ic.attrs.chance != null ? Number(ic.attrs.chance) : undefined;
    if (!isClassname(iname)) errors.push({ path: ip + '.name', message: 'invalid or missing item name ' + JSON.stringify(iname) });
    if (ic.attrs.chance != null && !isFiniteNumber(ichance)) errors.push({ path: ip + '.chance', message: 'invalid number "' + ic.attrs.chance + '"' });
    // Item chances are relative weights in the real corpus (observed up to 50
    // in the Walpurgis sakhal pack); only group chances must sit in 0..1.
    if (ichance != null && ichance < 0) errors.push({ path: ip + '.chance', message: 'must be >= 0 (got ' + ichance + ')' });
    var item = { name: isClassname(iname) ? iname : '', chance: ichance };
    ic.children.forEach(function (gc) {
      if (gc.tag !== 'damage' && gc.tag !== 'cargo') {
        errors.push({ path: ip + '.children', message: '<item> may only contain <damage> and <cargo> children (got <' + gc.tag + '>)' });
        return;
      }
      if (gc.text) errors.push({ path: ip, message: '<' + gc.tag + '> must not contain text' });
      Object.keys(gc.attrs).forEach(function (a) {
        if (knownAttrsFor(gc.tag).indexOf(a) === -1) errors.push({ path: ip + '.' + gc.tag + '.' + a, message: 'unknown attribute on <' + gc.tag + '>' });
      });
      if (gc.tag === 'damage') {
        if (gc.children.length) { errors.push({ path: ip + '.damage', message: '<damage> must be self-closing' }); return; }
        var min = numAttr(gc.attrs, 'min', ip + '.damage', errors, true);
        var max = numAttr(gc.attrs, 'max', ip + '.damage', errors, true);
        if (min != null && (min < 0 || min > 1)) errors.push({ path: ip + '.damage.min', message: 'must be in 0..1 (got ' + min + ')' });
        if (max != null && (max < 0 || max > 1)) errors.push({ path: ip + '.damage.max', message: 'must be in 0..1 (got ' + max + ')' });
        if (min != null && max != null && min > max) errors.push({ path: ip + '.damage', message: 'min (' + min + ') > max (' + max + ')' });
        if (min != null && max != null) item.damage = { min: min, max: max };
      } else {
        if ('preset' in gc.attrs) {
          if (gc.children.length) errors.push({ path: ip + '.cargo', message: '<cargo preset=> must be self-closing' });
          (item.cargo = item.cargo || []).push({ kind: 'cargo-preset', preset: gc.attrs.preset });
        } else {
          var nitems = [];
          gc.children.forEach(function (nic, k) {
            if (nic.tag !== 'item') { errors.push({ path: ip + '.cargo', message: '<cargo> may only contain <item> children (got <' + nic.tag + '>)' }); return; }
            var np = parseItemNode(nic, ip + '.cargo.items[' + k + ']', errors);
            if (np) nitems.push(np);
          });
          var nchance = gc.attrs.chance != null ? Number(gc.attrs.chance) : undefined;
          if (gc.attrs.chance != null && (nchance == null || nchance < 0 || nchance > 1)) errors.push({ path: ip + '.cargo.chance', message: 'must be in 0..1 (got "' + gc.attrs.chance + '")' });
          if (!nitems.length) errors.push({ path: ip + '.cargo', message: 'explicit <cargo> needs at least one <item>' });
          if (nitems.length) (item.cargo = item.cargo || []).push({ kind: 'cargo-items', chance: nchance, items: nitems });
        }
      }
    });
    return item.name ? item : null;
  }

  function stateFromModel(model) {
    var errors = [];
    if (!model || typeof model !== 'object' || model.tag !== ROOT_TAG) {
      return { ok: false, errors: [{ path: '', message: 'root element must be <' + ROOT_TAG + '> (got ' + (model && model.tag) + ')' }] };
    }
    var types = [];
    model.children.forEach(function (child, i) {
      var p = 'types[' + i + ']';
      if (child.tag !== 'type') {
        errors.push({ path: p, message: 'unexpected element <' + child.tag + '> under <' + ROOT_TAG + '>' });
        return;
      }
      var name = child.attrs.name;
      // Real corpus files DO carry duplicate <type name=> entries (identical
      // or conflicting — e.g. ScientificBriefcase in the sakhal packs); the
      // engine tolerates them, so the parser keeps both. Composed states are
      // stricter: validate() rejects duplicates.
      if (!isClassname(name)) {
        errors.push({ path: p + '.name', message: 'invalid or missing type name ' + JSON.stringify(name) });
      }
      var t = { name: name, sections: [] };
      var hasDamage = false;
      child.children.forEach(function (gc, j) {
        var gp = p + '.children[' + j + ']';
        if (TYPE_CHILD_TAGS.indexOf(gc.tag) === -1) {
          errors.push({ path: gp, message: 'unexpected element <' + gc.tag + '> inside <type> (allowed: ' + TYPE_CHILD_TAGS.join(', ') + ')' });
          return;
        }
        if (gc.text) errors.push({ path: gp, message: 'element <' + gc.tag + '> must not contain text' });
        var known = knownAttrsFor(gc.tag);
        Object.keys(gc.attrs).forEach(function (a) {
          if (known.indexOf(a) === -1) errors.push({ path: gp + '.' + a, message: 'unknown attribute on <' + gc.tag + '>' });
        });
        if (gc.tag === 'hoarder') {
          if (gc.children.length) errors.push({ path: gp, message: '<hoarder> must be self-closing' });
          t.hoarder = true;
        } else if (gc.tag === 'tag') {
          var tag = gc.attrs.name;
          if (typeof tag !== 'string' || !tag) errors.push({ path: gp + '.name', message: 'tag name attribute is required' });
          if (gc.children.length) errors.push({ path: gp, message: '<tag> must be self-closing' });
          t.sections.push({ kind: 'tag', name: tag || '' });
        } else if (gc.tag === 'damage') {
          if (gc.children.length) errors.push({ path: gp, message: '<damage> must be self-closing' });
          var min = numAttr(gc.attrs, 'min', gp, errors, true);
          var max = numAttr(gc.attrs, 'max', gp, errors, true);
          if (min != null && (min < 0 || min > 1)) errors.push({ path: gp + '.min', message: 'must be in 0..1 (got ' + min + ')' });
          if (max != null && (max < 0 || max > 1)) errors.push({ path: gp + '.max', message: 'must be in 0..1 (got ' + max + ')' });
          if (min != null && max != null && min > max) errors.push({ path: gp, message: 'min (' + min + ') > max (' + max + ')' });
          if (min != null && max != null) { t.damage = { min: min, max: max }; hasDamage = true; }
        } else if (gc.tag === 'cargo' || gc.tag === 'attachments') {
          var items = [];
          var itErrors = [];
          var itemsOk = !gc.children.length || gc.children.every(function (ic) { return ic.tag === 'item'; });
          if (!itemsOk) errors.push({ path: gp, message: '<' + gc.tag + '> may only contain <item> children' });
          gc.children.forEach(function (ic, k) {
            if (ic.tag !== 'item') return;
            var parsed = parseItemNode(ic, gp + '.items[' + k + ']', itErrors);
            if (parsed) items.push(parsed);
          });
          errors = errors.concat(itErrors);
          if (gc.tag === 'cargo') {
            if (!('preset' in gc.attrs)) {
              if (!items.length) errors.push({ path: gp, message: 'explicit <cargo> needs at least one <item>' });
              var cchance = gc.attrs.chance != null ? Number(gc.attrs.chance) : undefined;
              if (gc.attrs.chance != null && (cchance == null || cchance < 0 || cchance > 1)) errors.push({ path: gp + '.chance', message: 'must be in 0..1 (got "' + gc.attrs.chance + '")' });
              t.sections.push({ kind: 'cargo-items', chance: cchance, items: items });
            } else {
              if (gc.children.length) errors.push({ path: gp, message: '<cargo preset=> must be self-closing' });
              t.sections.push({ kind: 'cargo-preset', preset: gc.attrs.preset });
            }
          } else { // attachments
            if (!('preset' in gc.attrs)) {
              if (!('chance' in gc.attrs)) errors.push({ path: gp + '.chance', message: 'explicit <attachments> requires chance (the corpus always carries it)' });
              var achance = gc.attrs.chance != null ? Number(gc.attrs.chance) : undefined;
              if (gc.attrs.chance != null && (achance == null || achance < 0 || achance > 1)) errors.push({ path: gp + '.chance', message: 'must be in 0..1 (got "' + gc.attrs.chance + '")' });
              if (!items.length) errors.push({ path: gp, message: 'explicit <attachments> needs at least one <item>' });
              if (achance != null && items.length) t.sections.push({ kind: 'attach-items', chance: achance, items: items });
            } else {
              if (gc.children.length) errors.push({ path: gp, message: '<attachments preset=> must be self-closing' });
              t.sections.push({ kind: 'attach-preset', preset: gc.attrs.preset });
            }
          }
        }
      });
      if (!hasDamage) delete t.damage;
      if (!t.sections.length) delete t.sections;
      if (t.name) types.push(t);
    });
    return { ok: errors.length === 0, state: { types: types }, errors: errors };
  }

  function knownAttrsFor(tag) {
    if (tag === 'type') return ['name'];
    if (tag === 'damage') return ['min', 'max'];
    if (tag === 'cargo') return ['preset', 'chance'];
    if (tag === 'attachments') return ['preset', 'chance'];
    if (tag === 'hoarder') return [];
    if (tag === 'tag') return ['name'];
    if (tag === 'item') return ['name', 'chance'];
    return [];
  }

  return {
    CLASSNAME_RE: CLASSNAME_RE,
    SECTION_KINDS: SECTION_KINDS,
    ROOT_TAG: ROOT_TAG,
    TYPE_CHILD_TAGS: TYPE_CHILD_TAGS,
    CARGO_PRESETS: CARGO_PRESETS,
    ATTACH_PRESETS: ATTACH_PRESETS,
    XML_DECL: XML_DECL,
    toXML: toXML,
    validate: validate,
    stateFromModel: stateFromModel
  };
});
