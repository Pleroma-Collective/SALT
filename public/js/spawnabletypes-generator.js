/* spawnabletypes-generator.js — Spawnabletypes Generator page UI (card t_14209206).
 *
 * 100% client-side: the item catalog is fetched from THIS dashboard's own
 * extracted data (/data/<map>/items.json from types.xml, plus
 * /data/<map>/spawnables.json from cfgspawnabletypes.xml for prefilling the
 * current server's damage/hoarder tuning). Nothing is uploaded. All user
 * text reaches the DOM via textContent/DOM construction only (toolkit
 * security contract).
 *
 * Lives in public/js/ (not public/js/tools/) on purpose: the toolkit security
 * scan (scripts/toolkit-client-test.js) bans fetch() in every
 * public/js/tools/ script; this script is the page's data loader, like
 * public/js/loadout-generator.js.
 *
 * Rendering: text/number inputs update state + preview only (focus stays);
 * the editor re-renders on structural changes (add/remove type/section/item).
 */
/* global document, navigator */
(function () {
  'use strict';
  var core = globalThis.SpawnabletypesGeneratorCore;
  var dom = globalThis.DayZToolkitDom;
  if (!core || !dom) return;

  var app = document.getElementById('app');
  dom.mountChrome(app, 'Spawnabletypes Generator',
    'Compose a CE cfgspawnabletypes.xml file — pick entity types from your ' +
    'server\u2019s extracted catalog (or type any classname), set damage, hoarder, ' +
    'cargo presets and part groups, preview the validated XML, download the file. ' +
    'Everything runs locally \u2014 nothing leaves this tab.');

  var state = { types: [] };
  var MAPS = ['nasdara', 'enoch', 'chernarusplus'];

  /* ------------------------------------------------------------------ */
  // Catalog + current-server tuning
  /* ------------------------------------------------------------------ */
  var catalog = { items: null, map: '' };
  var spawnables = {};
  var searchTerm = '';
  var categoryTerm = '';

  var catalogCard = dom.el('section', 'tk-card');
  catalogCard.appendChild(dom.el('h3', 'tk-card-title', 'Entity catalog (your server)'));
  var catalogBody = dom.el('div', 'tk-findings');
  var mapSelect = document.createElement('select');
  mapSelect.className = 'tk-select';
  MAPS.forEach(function (m) {
    var opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m + ' (extracted)';
    mapSelect.appendChild(opt);
  });
  var searchInput = dom.el('input', 'tk-select');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search name or classname…';
  searchInput.setAttribute('aria-label', 'Search catalog');
  var catSelect = document.createElement('select');
  catSelect.className = 'tk-select';
  var catAll = document.createElement('option');
  catAll.value = '';
  catAll.textContent = 'all categories';
  catSelect.appendChild(catAll);
  var catCount = dom.el('span', 'tk-pending', 'loading…');

  catalogBody.appendChild(mapSelect);
  catalogBody.appendChild(searchInput);
  catalogBody.appendChild(catSelect);
  catalogBody.appendChild(catCount);
  var resultsList = dom.el('ul', 'tk-findings');
  catalogBody.appendChild(resultsList);
  catalogCard.appendChild(catalogBody);
  app.appendChild(catalogCard);

  function refreshCategories() {
    var cats = {};
    (catalog.items || []).forEach(function (it) { if (it.category) cats[it.category] = 1; });
    var current = catSelect.value;
    catSelect.innerHTML = '';
    catSelect.appendChild(catAll);
    Object.keys(cats).sort().forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      catSelect.appendChild(opt);
    });
    if (cats[current]) catSelect.value = current;
  }

  function refreshResults() {
    resultsList.innerHTML = '';
    var q = searchTerm.toLowerCase();
    (catalog.items || []).filter(function (it) {
      if (categoryTerm && it.category !== categoryTerm) return false;
      if (!q) return true;
      return it.name.toLowerCase().indexOf(q) !== -1 || it.classname.toLowerCase().indexOf(q) !== -1;
    }).slice(0, 40).forEach(function (it) {
      var li = dom.el('li', 'tk-finding');
      li.appendChild(dom.el('span', 'tk-msg', it.name + '  '));
      li.appendChild(dom.el('code', '', it.classname));
      if (it.tier != null) li.appendChild(dom.el('span', 'tk-size', '  T' + it.tier));
      var btn = dom.el('button', 'tk-btn tk-btn-small', 'Add');
      btn.type = 'button';
      btn.addEventListener('click', function () { addType(it.classname); });
      li.appendChild(btn);
      resultsList.appendChild(li);
    });
    if (!resultsList.childNodes.length) {
      resultsList.appendChild(dom.el('li', 'tk-finding', catalog.items ? 'No items match.' : 'No catalog loaded yet.'));
    }
  }

  function loadCatalog(map) {
    catCount.textContent = 'loading ' + map + '…';
    spawnables = {};
    Promise.all([
      fetch('/data/' + map + '/items.json').then(function (res) {
        if (!res.ok) throw new Error('items.json: HTTP ' + res.status);
        return res.json();
      }),
      fetch('/data/' + map + '/spawnables.json').then(function (res) {
        if (!res.ok) return null; // tuning is optional — the catalog still works
        return res.json();
      }).catch(function () { return null; })
    ]).then(function (pair) {
      catalog.items = pair[0].items;
      catalog.map = map;
      spawnables = (pair[1] && pair[1].types) || {};
      catCount.textContent = pair[0].count + ' items (' + map + ')' + (pair[1] ? ' · ' + pair[1].count + ' tuned' : '');
      refreshCategories();
      refreshResults();
    }).catch(function (err) {
      catalog.items = null;
      catCount.textContent = '';
      resultsList.innerHTML = '';
      resultsList.appendChild(dom.el('li', 'tk-finding tk-finding-error',
        'Could not load the extracted catalog for ' + map + ': ' + err.message +
        ' — you can still type any classname by hand in the “Add type” row.'));
    });
  }

  mapSelect.addEventListener('change', function () { loadCatalog(mapSelect.value); });
  searchInput.addEventListener('input', function () { searchTerm = searchInput.value; refreshResults(); });
  catSelect.addEventListener('change', function () { categoryTerm = catSelect.value; refreshResults(); });

  /* ------------------------------------------------------------------ */
  // Editor
  /* ------------------------------------------------------------------ */
  var editorCard = dom.el('section', 'tk-card');
  editorCard.appendChild(dom.el('h3', 'tk-card-title', 'Spawnable types'));
  var editorBody = dom.el('div', '');
  editorCard.appendChild(editorBody);
  app.appendChild(editorCard);

  // Datalists (built once)
  var classList = dom.el('datalist', '', '');
  classList.id = 'stt-classnames';
  var cargoList = dom.el('datalist', '', '');
  cargoList.id = 'stt-cargo';
  core.CARGO_PRESETS.forEach(function (p) {
    var o = document.createElement('option'); o.value = p; cargoList.appendChild(o);
  });
  var attachList = dom.el('datalist', '', '');
  attachList.id = 'stt-attach';
  core.ATTACH_PRESETS.forEach(function (p) {
    var o = document.createElement('option'); o.value = p; attachList.appendChild(o);
  });

  function addType(name) {
    var t = { name: name || '', sections: [] };
    // Prefill lossless fields from the server's extracted spawnabletypes
    // (data/<map>/spawnables.json). Parts are NOT prefilled: spawnables.json
    // flattens multi-group <attachments> into one list, which would silently
    // merge group chances.
    var s = spawnables[name];
    if (s) {
      if (typeof s.damageMin === 'number' && typeof s.damageMax === 'number') t.damage = { min: s.damageMin, max: s.damageMax };
      if (s.hoarder) t.hoarder = true;
    }
    state.types.push(t);
    renderAll();
  }

  function numberInput(value, min, max, step, label, onValue) {
    var input = document.createElement('input');
    input.type = 'number';
    if (min != null) input.min = String(min);
    if (max != null) input.max = String(max);
    input.step = step;
    input.className = 'tk-number';
    input.value = value == null ? '' : String(value);
    input.setAttribute('aria-label', label);
    input.addEventListener('input', function () { onValue(input.value === '' ? null : parseFloat(input.value)); });
    return input;
  }

  function presetRow(parent, presets, listId, section, onRemove) {
    var row = dom.el('div', 'tk-split-row');
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'tk-select';
    input.placeholder = 'preset (e.g. ' + presets[0] + ')';
    input.setAttribute('list', listId);
    input.setAttribute('aria-label', 'preset');
    input.addEventListener('input', function () { section.preset = input.value; refreshPreview(); });
    row.appendChild(input);
    var rm = dom.el('button', 'tk-btn tk-btn-small', 'Remove');
    rm.type = 'button';
    rm.addEventListener('click', onRemove.remove);
    row.appendChild(rm);
    parent.appendChild(row);
    return input;
  }

  /** Shared editor for an explicit-item group (cargo-items / attach-items). */
  function itemGroupBox(parent, group, groupKind, onRemove) {
    var box = dom.el('div', '');
    box.style.cssText = 'border:1px solid var(--dzc-border);border-radius:8px;padding:8px;margin:8px 0';
    var head = dom.el('div', 'tk-split-row');
    head.appendChild(dom.el('span', '', groupKind === 'cargo-items' ? 'cargo group chance: ' : 'parts group chance: '));
    head.appendChild(numberInput(group.chance, 0, groupKind === 'attach-items' ? 1 : null, 0.05, 'group chance', function (v) { group.chance = v; refreshPreview(); }));
    var rm = dom.el('button', 'tk-btn tk-btn-small', 'Remove group');
    rm.type = 'button';
    rm.addEventListener('click', onRemove);
    head.appendChild(rm);
    box.appendChild(head);
    if (!group.items.length) box.appendChild(dom.el('p', 'tk-pending', 'no items — add one below'));
    group.items.forEach(function (it, j) {
      var row = dom.el('div', 'tk-split-row');
      var name = dom.el('input', 'tk-select', it.name);
      name.setAttribute('list', 'stt-classnames');
      name.setAttribute('aria-label', 'item classname');
      name.addEventListener('input', function () { it.name = name.value; refreshPreview(); });
      row.appendChild(name);
      row.appendChild(dom.el('span', '', ' chance/weight: '));
      row.appendChild(numberInput(it.chance, 0, null, 0.05, 'item chance', function (v) { it.chance = v; refreshPreview(); }));
      var rmIt = dom.el('button', 'tk-btn tk-btn-small', 'Remove');
      rmIt.type = 'button';
      rmIt.addEventListener('click', function () { group.items.splice(j, 1); renderAll(); });
      row.appendChild(rmIt);
      box.appendChild(row);
    });
    var addIt = dom.el('button', 'tk-btn tk-btn-small', 'Add item');
    addIt.type = 'button';
    addIt.addEventListener('click', function () { group.items.push({ name: '' }); renderAll(); });
    box.appendChild(addIt);
    parent.appendChild(box);
  }

  function typeBox(t, idx) {
    var box = dom.el('div', '');
    box.style.cssText = 'border:1px solid var(--dzc-border);border-radius:8px;padding:10px;margin:10px 0';
    var row1 = dom.el('div', 'tk-split-row');
    var name = dom.el('input', 'tk-select', t.name);
    name.style.flex = '1';
    name.setAttribute('list', 'stt-classnames');
    name.setAttribute('aria-label', 'type classname');
    name.addEventListener('input', function () { t.name = name.value; refreshPreview(); });
    row1.appendChild(name);
    var hoarder = document.createElement('label');
    hoarder.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dzc-text-muted)';
    var hcb = document.createElement('input');
    hcb.type = 'checkbox';
    hcb.checked = !!t.hoarder;
    hcb.addEventListener('change', function () { t.hoarder = hcb.checked; renderAll(); });
    hoarder.appendChild(hcb);
    hoarder.appendChild(document.createTextNode(' hoarder only'));
    row1.appendChild(hoarder);
    var tag = dom.el('input', 'tk-select', t.tagValue || '');
    tag.type = 'text';
    tag.style.width = '140px';
    tag.placeholder = 'tag (optional)';
    tag.setAttribute('aria-label', 'tag name');
    tag.addEventListener('input', function () { setSection(t, { kind: 'tag', name: tag.value }); refreshPreview(); });
    row1.appendChild(tag);
    var rmType = dom.el('button', 'tk-btn tk-btn-small', 'Remove type');
    rmType.type = 'button';
    rmType.addEventListener('click', function () { state.types.splice(idx, 1); renderAll(); });
    row1.appendChild(rmType);
    box.appendChild(row1);

    var dmg = dom.el('div', 'tk-split-row');
    dmg.appendChild(dom.el('span', '', 'damage: '));
    var hasDmg = !!t.damage;
    var dmin = numberInput(hasDmg ? t.damage.min : null, 0, 1, 0.05, 'damage min', function (v) { setDamage(t, v, 'min'); });
    var dmax = numberInput(hasDmg ? t.damage.max : null, 0, 1, 0.05, 'damage max', function (v) { setDamage(t, v, 'max'); });
    dmg.appendChild(dom.el('span', '', 'min '));
    dmg.appendChild(dmin);
    dmg.appendChild(dom.el('span', '', ' max '));
    dmg.appendChild(dmax);
    dmg.appendChild(dom.el('span', 'tk-pending', ' (blank = no damage tuning)'));
    box.appendChild(dmg);

    box.appendChild(sectionHead('Cargo presets', function () { addSection(t, { kind: 'cargo-preset', preset: '' }); }));
    var cpresets = sectionsOf(t, 'cargo-preset');
    cpresets.forEach(function (s, i) {
      presetRow(box, core.CARGO_PRESETS, 'stt-cargo', s, function () { removeSection(t, i); }).value = s.preset || '';
    });

    box.appendChild(sectionHead('Cargo groups (explicit items)', function () {
      addSection(t, { kind: 'cargo-items', chance: 1, items: [{ name: '' }] });
    }));
    sectionsOf(t, 'cargo-items').forEach(function (s, i) {
      itemGroupBox(box, s, 'cargo-items', function () { removeSection(t, i); });
    });

    box.appendChild(sectionHead('Attachment presets', function () { addSection(t, { kind: 'attach-preset', preset: '' }); }));
    var apresets = sectionsOf(t, 'attach-preset');
    apresets.forEach(function (s, i) {
      presetRow(box, core.ATTACH_PRESETS, 'stt-attach', s, function () { removeSection(t, i); }).value = s.preset || '';
    });

    box.appendChild(sectionHead('Parts groups (attachments)', function () {
      addSection(t, { kind: 'attach-items', chance: 1, items: [{ name: '' }] });
    }));
    sectionsOf(t, 'attach-items').forEach(function (s, i) {
      itemGroupBox(box, s, 'attach-items', function () { removeSection(t, i); });
    });
    return box;
  }

  function sectionHead(label, onAdd) {
    var head = dom.el('div', 'tk-card-head');
    head.appendChild(dom.el('h4', '', label));
    var add = dom.el('button', 'tk-btn tk-btn-small', 'Add');
    add.type = 'button';
    add.addEventListener('click', function () { onAdd(); renderAll(); });
    head.appendChild(add);
    return head;
  }

  function sectionsOf(t, kind) {
    return (t.sections || []).filter(function (s) { return s.kind === kind; });
  }
  function addSection(t, section) {
    t.sections = t.sections || [];
    t.sections.push(section);
  }
  function removeSection(t, idx) {
    t.sections.splice(idx, 1);
    renderAll();
  }
  function setSection(t, section) {
    t.sections = (t.sections || []).filter(function (s) { return s.kind !== 'tag'; });
    if (section.name) t.sections.push({ kind: 'tag', name: section.name });
  }
  function setDamage(t, v, which) {
    if (t.damage == null && v != null) t.damage = { min: which === 'min' ? v : 0, max: which === 'max' ? v : 0 };
    if (t.damage != null) {
      t.damage[which] = v;
      if (v == null) delete t.damage; // either bound blanked -> drop the whole range
    }
    refreshPreview();
  }

  function renderEditor() {
    editorBody.innerHTML = '';
    editorBody.appendChild(classList);
    editorBody.appendChild(cargoList);
    editorBody.appendChild(attachList);
    var addRow = dom.el('div', 'tk-split-row');
    addRow.appendChild(dom.el('span', '', 'Add type: '));
    var free = dom.el('input', 'tk-select', '');
    free.type = 'text';
    free.style.flex = '1';
    free.placeholder = 'any classname, e.g. WoodenCrate';
    free.setAttribute('aria-label', 'classname to add');
    free.addEventListener('change', function () {
      var v = free.value.trim();
      if (v) { free.value = ''; addType(v); }
    });
    addRow.appendChild(free);
    var addBtn = dom.el('button', 'tk-btn', 'Add type');
    addBtn.type = 'button';
    addBtn.addEventListener('click', function () {
      var v = free.value.trim();
      if (v) { free.value = ''; addType(v); }
    });
    addRow.appendChild(addBtn);
    editorBody.appendChild(addRow);
    if (!state.types.length) {
      editorBody.appendChild(dom.el('p', 'tk-pending', 'No types yet — pick from the catalog above or type a classname.'));
    }
    state.types.forEach(function (t, i) { editorBody.appendChild(typeBox(t, i)); });
  }

  /* ------------------------------------------------------------------ */
  // Preview + export
  /* ------------------------------------------------------------------ */
  var previewCard = dom.el('section', 'tk-card');
  var previewHead = dom.el('div', 'tk-card-head');
  var statusLine = dom.el('span', 'tk-status tk-status-good', 'VALID');
  previewHead.appendChild(statusLine);
  var previewTitle = dom.el('h3', 'tk-card-title', 'Preview — cfgspawnabletypes.xml');
  previewHead.appendChild(previewTitle);
  previewCard.appendChild(previewHead);
  var previewPre = dom.el('pre', '', '');
  previewPre.style.cssText = 'max-height:420px;overflow:auto;font-size:12px;line-height:1.45;padding:10px 12px;background:var(--dzc-bg-tint);border:1px solid var(--dzc-border);border-radius:8px;margin:0'
  previewPre.setAttribute('tabindex', '0');
  previewCard.appendChild(previewPre);
  app.appendChild(previewCard);

  var exportCard = dom.el('section', 'tk-card');
  var exportRow = dom.el('div', 'tk-split-row');
  var downloadBtn = dom.el('button', 'tk-btn', 'Download cfgspawnabletypes.xml');
  downloadBtn.type = 'button';
  downloadBtn.addEventListener('click', function () {
    var v = core.validate(state);
    if (!v.ok) {
      statusLine.textContent = 'INVALID';
      statusLine.className = 'tk-status tk-status-invalid';
      renderErrors(v.errors);
      return;
    }
    dom.downloadText('cfgspawnabletypes.xml', core.toXML(state), 'application/xml;charset=utf-8');
  });
  exportRow.appendChild(downloadBtn);
  var copyBtn = dom.el('button', 'tk-btn tk-btn-small', 'Copy XML');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', function () {
    var text = core.toXML(state);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        copyBtn.textContent = '✓ Copied';
        setTimeout(function () { copyBtn.textContent = 'Copy XML'; }, 1500);
      });
    }
  });
  exportRow.appendChild(copyBtn);
  exportCard.appendChild(exportRow);
  app.appendChild(exportCard);

  var errList = dom.el('ul', 'tk-findings');
  app.appendChild(errList);

  function renderErrors(errors) {
    errList.innerHTML = '';
    errors.slice(0, 20).forEach(function (e) {
      errList.appendChild(dom.el('li', 'tk-finding tk-finding-error', (e.path ? e.path + ': ' : '') + e.message));
    });
    if (errors.length > 20) errList.appendChild(dom.el('li', 'tk-finding tk-finding-error', '… ' + (errors.length - 20) + ' more errors'));
  }

  function refreshPreview() {
    var v = core.validate(state);
    previewPre.textContent = core.toXML(state);
    if (v.ok) {
      statusLine.textContent = 'VALID';
      statusLine.className = 'tk-status tk-status-good';
      errList.innerHTML = '';
    } else {
      statusLine.textContent = 'INVALID';
      statusLine.className = 'tk-status tk-status-invalid';
      renderErrors(v.errors);
    }
    previewTitle.textContent = 'Preview — cfgspawnabletypes.xml (' + state.types.length + ' types)';
  }

  function renderAll() { renderEditor(); refreshPreview(); }

  loadCatalog('nasdara');
  renderAll();
})();
