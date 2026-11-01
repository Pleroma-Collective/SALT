/* loadout-generator.js — Loadout Generator page UI (card t_3ed714bd).
 *
 * 100% client-side: the item catalog is fetched from THIS dashboard's own
 * extracted data (/data/<map>/items.json) — same posture as the public /items
 * catalog and loot-probability. Nothing is uploaded. All user text reaches the
 * DOM via textContent/DOM construction only (toolkit security contract).
 *
 * Lives in public/js/ (not public/js/tools/) on purpose: the toolkit security
 * scan (scripts/toolkit-client-test.js) bans fetch() in every
 * public/js/tools/ script; this script is the page's data loader, like
 * public/js/loot-probability.js.
 */
/* global document, fetch, console */
(function () {
  'use strict';
  var core = globalThis.LoadoutGeneratorCore;
  var dom = globalThis.DayZToolkitDom;
  if (!core || !dom) return;

  var app = document.getElementById('app');
  dom.mountChrome(app, 'Loadout Generator',
    'Compose a player spawn config in the kitty_loadouts / CE format — pick items from your ' +
    'server\u2019s extracted catalog (or type any classname), set quantities and weights, ' +
    'preview the JSON, download the file. Everything runs locally — nothing leaves this tab.');

  var state = {
    name: 'Player',
    spawnWeight: 1,
    characterTypes: [],
    slots: [
      { slotName: 'Body', items: [] },
      { slotName: 'Legs', items: [] },
      { slotName: 'Feet', items: [] },
      { slotName: 'Headgear', items: [] }
    ],
    cargo: [],
    loose: []
  };

  var catalog = { items: null, map: '' };
  var results = [];
  var searchTerm = '';
  var categoryTerm = '';

  /* ------------------------------------------------------------------ */
  // Helpers
  /* ------------------------------------------------------------------ */
  function freshItem(type) {
    return { itemType: type, qty: 1, spawnWeight: 1, simpleChildren: [] };
  }

  function currentDoc() { return core.buildLoadout(state); }

  function targetOptions() {
    var out = [];
    state.slots.forEach(function (s, i) { out.push(['slot:' + i, 'Slot: ' + s.slotName]); });
    state.cargo.forEach(function (c, i) { out.push(['cargo:' + i, 'Cargo: ' + c.name]); });
    out.push(['loose', 'Loose items (simple children)']);
    return out;
  }

  function resolveTarget(value) {
    if (value === 'loose') return state.loose;
    var kind = value.slice(0, value.indexOf(':'));
    var idx = parseInt(value.slice(value.indexOf(':') + 1), 10);
    var list = kind === 'slot' ? state.slots : state.cargo;
    return list[idx] ? list[idx].items : state.loose;
  }

  function itemCount() {
    var n = state.loose.length;
    state.slots.forEach(function (s) { n += s.items.length; });
    state.cargo.forEach(function (c) { n += c.items.length; });
    return n;
  }

  /* ------------------------------------------------------------------ */
  // Catalog (extracted items per map — the item source)
  /* ------------------------------------------------------------------ */
  var catalogCard = dom.el('section', 'tk-card');
  catalogCard.appendChild(dom.el('h3', 'tk-card-title', 'Item catalog (your server)'));
  var catalogBody = dom.el('div', 'tk-findings');
  var MAPS = ['nasdara', 'enoch', 'chernarusplus'];

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
    results = (catalog.items || []).filter(function (it) {
      if (categoryTerm && it.category !== categoryTerm) return false;
      if (!q) return true;
      return it.name.toLowerCase().indexOf(q) !== -1 || it.classname.toLowerCase().indexOf(q) !== -1;
    }).slice(0, 40);
    results.forEach(function (it) {
      var li = dom.el('li', 'tk-finding');
      li.appendChild(dom.el('span', 'tk-msg', it.name + '  '));
      li.appendChild(dom.el('code', '', it.classname));
      if (it.tier != null) li.appendChild(dom.el('span', 'tk-size', '  T' + it.tier));
      var btn = dom.el('button', 'tk-btn tk-btn-small', 'Add');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        resolveTarget(targetSelect.value).push(freshItem(it.classname));
        renderAll();
      });
      li.appendChild(btn);
      resultsList.appendChild(li);
    });
    if (!results.length) resultsList.appendChild(dom.el('li', 'tk-finding', catalog.items ? 'No items match.' : 'No catalog loaded yet.'));
  }

  function loadCatalog(map) {
    catCount.textContent = 'loading ' + map + '…';
    fetch('/data/' + map + '/items.json')
      .then(function (res) {
        if (!res.ok) throw new Error('items.json: HTTP ' + res.status);
        return res.json();
      })
      .then(function (doc) {
        catalog.items = doc.items;
        catalog.map = map;
        catCount.textContent = doc.count + ' items (' + map + ')';
        refreshCategories();
        refreshResults();
      })
      .catch(function (err) {
        catalog.items = null;
        catCount.textContent = '';
        resultsList.innerHTML = '';
        resultsList.appendChild(dom.el('li', 'tk-finding tk-finding-error',
          'Could not load the extracted catalog for ' + map + ': ' + err.message +
          ' — you can still type any classname by hand in the item rows.'));
      });
  }

  mapSelect.addEventListener('change', function () { loadCatalog(mapSelect.value); });
  searchInput.addEventListener('input', function () { searchTerm = searchInput.value; refreshResults(); });
  catSelect.addEventListener('change', function () { categoryTerm = catSelect.value; refreshResults(); });

  /* ------------------------------------------------------------------ */
  // Editor
  /* ------------------------------------------------------------------ */
  var editorCard = dom.el('section', 'tk-card');
  editorCard.appendChild(dom.el('h3', 'tk-card-title', 'Loadout'));
  var editorBody = dom.el('div', '');
  editorCard.appendChild(editorBody);
  app.appendChild(editorCard);

  var targetSelect = document.createElement('select');
  targetSelect.className = 'tk-select';
  targetSelect.setAttribute('aria-label', 'Target for “Add”');

  function itemRow(parent, items, index, looseOnly) {
    var e = items[index];
    var row = dom.el('div', 'tk-split-row');
    var type = dom.el('input', 'tk-select', e.itemType);
    type.setAttribute('aria-label', 'item classname');
    type.addEventListener('input', function () { e.itemType = type.value; renderAll(); });
    row.appendChild(type);
    if (!looseOnly) {
      var qty = document.createElement('input');
      qty.type = 'number'; qty.min = '1'; qty.max = '99'; qty.className = 'tk-number';
      qty.value = String(e.qty);
      qty.setAttribute('aria-label', 'quantity');
      qty.addEventListener('change', function () {
        e.qty = Math.min(99, Math.max(1, parseInt(qty.value, 10) || 1));
        qty.value = String(e.qty);
        renderAll();
      });
      row.appendChild(qty);
      var weight = document.createElement('input');
      weight.type = 'number'; weight.min = '0'; weight.max = '99'; weight.className = 'tk-number';
      weight.value = String(e.spawnWeight);
      weight.setAttribute('aria-label', 'spawn weight');
      weight.addEventListener('change', function () {
        e.spawnWeight = Math.min(99, Math.max(0, parseInt(weight.value, 10) || 0));
        weight.value = String(e.spawnWeight);
        renderAll();
      });
      row.appendChild(weight);
    }
    var simp = dom.el('input', 'tk-select', e.simpleChildren.join(', '));
    simp.type = 'text';
    simp.placeholder = 'simple children (comma-separated), optional';
    simp.setAttribute('aria-label', 'simple children');
    simp.addEventListener('change', function () {
      e.simpleChildren = simp.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      renderAll();
    });
    row.appendChild(simp);
    var rm = dom.el('button', 'tk-btn tk-btn-small', 'Remove');
    rm.type = 'button';
    rm.addEventListener('click', function () { items.splice(index, 1); renderAll(); });
    row.appendChild(rm);
    parent.appendChild(row);
  }

  function render() {
    /* target select */
    var currentTarget = targetSelect.value;
    targetSelect.innerHTML = '';
    targetOptions().forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t[0];
      opt.textContent = t[1];
      targetSelect.appendChild(opt);
    });
    if ([].concat.apply([], targetOptions().map(function (t) { return [t[0]]; })).indexOf(currentTarget) !== -1) {
      targetSelect.value = currentTarget;
    }

    editorBody.innerHTML = '';
    var basics = dom.el('div', 'tk-split-row');
    var nameLabel = dom.el('span', '', 'Name: ');
    var nameInput = dom.el('input', 'tk-select', state.name);
    nameInput.addEventListener('input', function () { state.name = nameInput.value; renderAll(); });
    basics.appendChild(nameLabel);
    basics.appendChild(nameInput);
    basics.appendChild(dom.el('span', '', ' spawnWeight: '));
    var weightInput = document.createElement('input');
    weightInput.type = 'number'; weightInput.min = '0'; weightInput.max = '99';
    weightInput.className = 'tk-number';
    weightInput.value = String(state.spawnWeight);
    weightInput.addEventListener('change', function () {
      state.spawnWeight = Math.min(99, Math.max(0, parseInt(weightInput.value, 10) || 0));
      renderAll();
    });
    basics.appendChild(weightInput);
    basics.appendChild(dom.el('span', '', ' add to: '));
    basics.appendChild(targetSelect);
    editorBody.appendChild(basics);

    /* character types */
    var charsHead = dom.el('div', 'tk-card-head');
    charsHead.appendChild(dom.el('h4', '', 'Character types (spawn as)'));
    editorBody.appendChild(charsHead);
    var chars = dom.el('div', 'tk-split-row');
    core.KNOWN_CHARACTER_TYPES.forEach(function (ct) {
      var label = document.createElement('label');
      label.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dzc-text-muted)';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.characterTypes.indexOf(ct) !== -1;
      cb.addEventListener('change', function () {
        state.characterTypes = cb.checked
          ? state.characterTypes.concat([ct])
          : state.characterTypes.filter(function (x) { return x !== ct; });
        renderAll();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + ct));
      chars.appendChild(label);
    });
    editorBody.appendChild(chars);

    /* slots */
    var slotsHead = dom.el('div', 'tk-card-head');
    slotsHead.appendChild(dom.el('h4', '', 'Worn slots (attachmentSlotItemSets)'));
    var addSlot = dom.el('button', 'tk-btn tk-btn-small', 'Add slot');
    addSlot.type = 'button';
    addSlot.addEventListener('click', function () {
      state.slots.push({ slotName: 'Custom', items: [] });
      renderAll();
    });
    slotsHead.appendChild(addSlot);
    editorBody.appendChild(slotsHead);
    var slotList = dom.el('datalist', '', '');
    core.STANDARD_SLOTS.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s;
      slotList.appendChild(opt);
    });
    state.slots.forEach(function (slot, i) {
      var box = dom.el('div', '');
      box.style.cssText = 'border:1px solid var(--dzc-border);border-radius:8px;padding:8px;margin:8px 0';
      var head = dom.el('div', 'tk-split-row');
      var slotName = dom.el('input', 'tk-select', slot.slotName);
      slotName.setAttribute('list', 'lg-slots');
      slotName.addEventListener('input', function () { slot.slotName = slotName.value; renderAll(); });
      head.appendChild(slotName);
      var rmSlot = dom.el('button', 'tk-btn tk-btn-small', 'Remove slot');
      rmSlot.type = 'button';
      rmSlot.addEventListener('click', function () { state.slots.splice(i, 1); renderAll(); });
      head.appendChild(rmSlot);
      box.appendChild(head);
      slotList.setAttribute('id', 'lg-slots');
      if (!slot.items.length) box.appendChild(dom.el('p', 'tk-pending', 'no items'));
      slot.items.forEach(function (e, j) { itemRow(box, slot.items, j, false); });
      editorBody.appendChild(box);
    });

    /* cargo */
    var cargoHead = dom.el('div', 'tk-card-head');
    cargoHead.appendChild(dom.el('h4', '', 'Cargo sections (discreteUnsortedItemSets)'));
    var addCargo = dom.el('button', 'tk-btn tk-btn-small', 'Add cargo');
    addCargo.type = 'button';
    addCargo.addEventListener('click', function () {
      state.cargo.push({
        name: 'Cargo' + (state.cargo.length + 1),
        spawnWeight: 1,
        health: 1.0,
        items: []
      });
      renderAll();
    });
    cargoHead.appendChild(addCargo);
    editorBody.appendChild(cargoHead);
    state.cargo.forEach(function (c, i) {
      var box = dom.el('div', '');
      box.style.cssText = 'border:1px solid var(--dzc-border);border-radius:8px;padding:8px;margin:8px 0';
      var head = dom.el('div', 'tk-split-row');
      var cargoName = dom.el('input', 'tk-select', c.name);
      cargoName.addEventListener('input', function () { c.name = cargoName.value; renderAll(); });
      head.appendChild(cargoName);
      var health = document.createElement('select');
      health.className = 'tk-select';
      [1.0, 0.8].forEach(function (v) {
        var opt = document.createElement('option');
        opt.value = String(v);
        opt.textContent = 'health ' + v.toFixed(1);
        if (c.health === v) opt.selected = true;
        health.appendChild(opt);
      });
      health.addEventListener('change', function () { c.health = parseFloat(health.value); renderAll(); });
      head.appendChild(health);
      var rmCargo = dom.el('button', 'tk-btn tk-btn-small', 'Remove');
      rmCargo.type = 'button';
      rmCargo.addEventListener('click', function () { state.cargo.splice(i, 1); renderAll(); });
      head.appendChild(rmCargo);
      box.appendChild(head);
      if (!c.items.length) box.appendChild(dom.el('p', 'tk-pending', 'no items'));
      c.items.forEach(function (e, j) { itemRow(box, c.items, j, false); });
      editorBody.appendChild(box);
    });

    /* loose items */
    var looseHead = dom.el('div', 'tk-card-head');
    looseHead.appendChild(dom.el('h4', '', 'Loose items (top-level simple children, e.g. glass bottles)'));
    editorBody.appendChild(looseHead);
    if (!state.loose.length) editorBody.appendChild(dom.el('p', 'tk-pending', 'none — use “Add” with target “Loose items”'));
    state.loose.forEach(function (e, j) { itemRow(editorBody, state.loose, j, true); });
  }

  /* ------------------------------------------------------------------ */
  // Preview + export
  /* ------------------------------------------------------------------ */
  var previewCard = dom.el('section', 'tk-card');
  var previewHead = dom.el('div', 'tk-card-head');
  var statusLine = dom.el('span', 'tk-status tk-status-good', 'VALID');
  previewHead.appendChild(statusLine);
  previewHead.appendChild(dom.el('h3', 'tk-card-title', 'Preview — ' + core.slugify(state.name)));
  previewCard.appendChild(previewHead);
  var previewPre = dom.el('pre', '', '');
  previewPre.style.cssText = 'max-height:420px;overflow:auto;font-size:12px;line-height:1.45;padding:10px 12px;background:var(--dzc-bg-tint);border:1px solid var(--dzc-border);border-radius:8px;margin:0'
  previewPre.setAttribute('tabindex', '0');
  previewCard.appendChild(previewPre);
  app.appendChild(previewCard);

  var exportCard = dom.el('section', 'tk-card');
  var exportRow = dom.el('div', 'tk-split-row');
  var fileName = core.slugify(state.name);
  var downloadBtn = dom.el('button', 'tk-btn', 'Download ' + fileName);
  downloadBtn.type = 'button';
  downloadBtn.addEventListener('click', function () {
    var doc = currentDoc();
    var v = core.validate(doc);
    if (!v.ok) {
      statusLine.textContent = 'INVALID';
      statusLine.className = 'tk-status tk-status-invalid';
      renderErrors(v.errors);
      return;
    }
    dom.downloadText(fileName, core.toJSON(doc), 'application/json;charset=utf-8');
  });
  exportRow.appendChild(downloadBtn);
  var copyBtn = dom.el('button', 'tk-btn tk-btn-small', 'Copy JSON');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', function () {
    var text = core.toJSON(currentDoc());
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        copyBtn.textContent = '✓ Copied';
        setTimeout(function () { copyBtn.textContent = 'Copy JSON'; }, 1500);
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
    var doc = currentDoc();
    var v = core.validate(doc);
    previewPre.textContent = core.toJSON(doc);
    if (v.ok) {
      statusLine.textContent = 'VALID';
      statusLine.className = 'tk-status tk-status-good';
      errList.innerHTML = '';
    } else {
      statusLine.textContent = 'INVALID';
      statusLine.className = 'tk-status tk-status-invalid';
      renderErrors(v.errors);
    }
    previewHead.children[1].textContent = 'Preview — ' + core.slugify(state.name) + ' (' + itemCount() + ' item entries)';
    downloadBtn.textContent = 'Download ' + core.slugify(state.name);
  }

  function renderAll() { render(); refreshPreview(); }

  loadCatalog('nasdara');
  renderAll();
})();
