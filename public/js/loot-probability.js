/* loot-probability.js — Loot Probability Calculator page UI (roadmap Tools #1).
 *
 * 100% client-side: user files (types.xml) are read in the browser and never
 * uploaded. The "quick answer" catalog is fetched from THIS dashboard's own
 * extracted data (/data/<map>/items.json, scripts/extract-dayz-data.js) — same
 * posture as the public /items catalog. All user text reaches the DOM via
 * textContent/DOM construction only (toolkit security contract).
 *
 * Lives in public/js/ (not public/js/tools/) on purpose: the toolkit security
 * scan (scripts/toolkit-client-test.js) bans fetch() in every public/js/tools/
 * script; this script is the page's data loader, like public/js/item-catalog.js.
 */
/* global document, fetch, console */
(function () {
  'use strict';
  var core = globalThis.DayZToolkitCore;
  var dom = globalThis.DayZToolkitDom;
  var lp = globalThis.LootProbabilityCore;
  if (!core || !dom || !lp) return;

  var app = document.getElementById('app');
  dom.mountChrome(app, 'Loot Probability Calculator',
    'Chance to find an item, per building category, from YOUR server economy. ' +
    'Pick a map below for quick answers from the dashboard\u2019s extracted types.xml, ' +
    'or drop/paste any types.xml to recompute from it. Everything runs locally — ' +
    'your file never leaves this tab.');

  /* ------------------------------------------------------------------ */
  // Model legend — the math, stated up front (transparency > black box).
  var legend = dom.el('div', 'tk-card', '');
  var legendHead = dom.el('div', 'tk-card-head');
  legendHead.appendChild(dom.el('h3', 'tk-card-title', 'How the odds are computed'));
  legend.appendChild(legendHead);
  var legendBody = dom.el('div', 'tk-findings');
  [
    'DayZ fills each loot slot by drawing from every item tagged with that building\u2019s usage group (Store, Military, Farm, \u2026), weighted by spawn chance.',
    'p(item X in one loot slot of group G) = weight(X) \u00f7 \u03a3 weights of all items tagged G.',
    'DayZ 1.26+ types.xml files declare no per-item chance, so every weight is the engine default 10000 — the pool is uniform and p = 1 \u00f7 (items tagged G). Files that DO set nominalChance/lifetimeChance are honored.',
    'nominal = copies the engine targets per spawn cycle; lifetime = respawn interval (seconds).',
    'Pool = every item tagged with the group, literal types.xml reading — items tagged but nominal=0 are counted and flagged per row, not silently dropped.'
  ].forEach(function (line) {
    legendBody.appendChild(dom.el('li', 'tk-finding', line));
  });
  legend.appendChild(legendBody);
  app.appendChild(legend);

  /* ------------------------------------------------------------------ */
  // Data source: extracted catalog (this server) or an uploaded types.xml.
  var MAPS = ['nasdara', 'enoch', 'chernarusplus'];
  var state = { items: null, pools: null, source: '', queryItem: null };

  var sourceRow = dom.el('div', 'tk-split-row');
  sourceRow.appendChild(dom.el('label', '', 'Quick-answer data (this server):'));
  var mapSelect = document.createElement('select');
  mapSelect.className = 'tk-select';
  MAPS.forEach(function (m) {
    var opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m + ' (extracted)';
    mapSelect.appendChild(opt);
  });
  sourceRow.appendChild(mapSelect);
  var sourceNote = dom.el('span', 'tk-pending', 'loading\u2026');
  sourceRow.appendChild(sourceNote);
  app.appendChild(sourceRow);

  function loadExtracted(map) {
    state.queryItem = null;
    results.textContent = '';
    sourceNote.textContent = 'loading ' + map + '\u2026';
    fetch('/data/' + map + '/items.json')
      .then(function (res) {
        if (!res.ok) throw new Error('items.json: HTTP ' + res.status);
        return res.json();
      })
      .then(function (doc) {
        state.items = doc.items;
        state.pools = lp.buildPools(state.items);
        state.source = map + ' (data/' + map + '/items.json)';
        sourceNote.textContent = doc.count + ' items loaded from data/' + map + '/items.json';
      })
      .catch(function (err) {
        sourceNote.textContent = '';
        showError('Could not load the extracted catalog for ' + map + ': ' + err.message +
          ' — drop a types.xml below, or re-run scripts/extract-dayz-data.js ' + map + '.');
      });
  }

  mapSelect.addEventListener('change', function () { loadExtracted(mapSelect.value); });

  /* ------------------------------------------------------------------ */
  // Upload / paste a types.xml (single document).
  function showError(msg) {
    var p = dom.el('p', 'tk-err', msg);
    results.appendChild(p);
  }

  /** types.xml parse failure as a standard report card (code + location). */
  function showParseError(item, parsed) {
    dom.renderReport(results, {
      fileName: item.name,
      inputBytes: typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(item.text).length : null,
      summary: { status: 'invalid', errorCount: 1, warningCount: 0 },
      errors: [{
        severity: 'error',
        code: parsed.code || 'loot-parse',
        line: parsed.line,
        message: parsed.error
      }],
      warnings: [],
      info: []
    });
  }

  var results = dom.el('div', 'tk-results');
  app.appendChild(results);

  dom.mountSourceBox(app, {
    multiple: false,
    accept: '.xml,.txt',
    allowPaste: true,
    title: 'Or drop your own types.xml here',
    onFiles: function (items) {
      items.forEach(function (item) {
        var parsed = lp.parseTypesXml(item.text);
        if (!parsed.ok) { showParseError(item, parsed); return; }
        state.items = parsed.items;
        state.pools = lp.buildPools(parsed.items);
        state.source = item.name + ' (uploaded — ' + parsed.items.length + ' types' +
          (parsed.duplicates ? ', ' + parsed.duplicates + ' duplicate classname(s) ignored' : '') + ')';
        state.queryItem = null;
        results.textContent = '';
        sourceNote.textContent = parsed.items.length + ' types from ' + item.name;
        showSourceSwitchNote(item.name);
      });
    }
  });

  function showSourceSwitchNote(name) {
    var note = dom.el('p', 'tk-summary-line',
      'Now computing from ' + name + '. Choose a map above to switch back to the extracted catalog.');
    results.appendChild(note);
  }

  /* ------------------------------------------------------------------ */
  // Query + compare controls.
  var queryRow = dom.el('div', 'tk-split-row');
  queryRow.appendChild(dom.el('label', '', 'Item:'));
  var queryInput = document.createElement('input');
  queryInput.className = 'tk-number';
  queryInput.placeholder = 'classname or name, e.g. AK101';
  queryInput.spellcheck = false;
  queryRow.appendChild(queryInput);
  var queryBtn = dom.el('button', 'tk-btn', 'Query');
  queryBtn.type = 'button';
  queryRow.appendChild(queryBtn);
  queryRow.appendChild(dom.el('label', '', 'Compare with:'));
  var compareInput = document.createElement('input');
  compareInput.className = 'tk-number';
  compareInput.placeholder = 'optional second item';
  compareInput.spellcheck = false;
  queryRow.appendChild(compareInput);
  var compareBtn = dom.el('button', 'tk-btn', 'Compare');
  compareBtn.type = 'button';
  queryRow.appendChild(compareBtn);
  app.appendChild(queryRow);

  /* ------------------------------------------------------------------ */
  // Rendering helpers (textContent only).
  function fmtP(p) {
    if (p == null) return '—';
    var pct = p * 100;
    return (pct >= 10 ? pct.toFixed(1) : pct >= 1 ? pct.toFixed(2) : pct.toFixed(3)) + '%';
  }
  function oneIn(p) {
    if (p == null || p <= 0) return '—';
    var n = Math.round(1 / p);
    return '1 in ' + n.toLocaleString('en-US');
  }
  function hours(sec) {
    if (sec == null || sec <= 0) return '—';
    var h = sec / 3600;
    return (h >= 1 ? h.toFixed(1).replace(/\.0$/, '') : (sec / 60).toFixed(0) + ' min') + (h >= 1 ? ' h' : '');
  }

  function table(headers, rows) {
    var t = document.createElement('table');
    t.className = 'tk-table';
    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    headers.forEach(function (h) { htr.appendChild(dom.el('th', '', h)); });
    thead.appendChild(htr);
    t.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function (cells) {
      var tr = document.createElement('tr');
      cells.forEach(function (c) {
        var td = document.createElement('td');
        if (typeof c === 'object' && c !== null) {
          td.appendChild(c.node);
          if (c.cls) td.className = c.cls;
        } else {
          td.textContent = String(c);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    return t;
  }

  function renderItem(ans) {
    var card = dom.el('section', 'tk-card tk-excellent');
    var head = dom.el('div', 'tk-card-head');
    head.appendChild(dom.el('span', 'tk-status tk-status-excellent', ans.spawnable ? 'SPAWNS' : 'NO SPAWN'));
    head.appendChild(dom.el('h3', 'tk-card-title', ans.classname +
      (ans.tier != null ? '  ·  Tier ' + ans.tier : '') +
      (ans.unique ? '  ·  Unique' : '') +
      (ans.category ? '  ·  ' + ans.category : '')));
    card.appendChild(head);

    var body = dom.el('div', 'tk-findings');
    var facts = [
      'nominal ' + ans.nominal + ' copies per spawn cycle',
      'lifetime ' + hours(ans.lifetime) + ' respawn interval'
    ];
    if (ans.restock != null) facts.push('restock ' + ans.restock + ' s');
    facts.push('min ' + ans.min + (ans.quantmin != null && ans.quantmin >= 0 ? ', qty ' + ans.quantmin + '–' + (ans.quantmax == null || ans.quantmax < 0 ? '∞' : ans.quantmax) : ''));
    body.appendChild(dom.el('li', 'tk-finding', facts.join('  ·  ')));
    if (ans.unique) body.appendChild(dom.el('li', 'tk-finding', 'Marked Unique — one-of-a-kind on the map.'));
    if (ans.crafted && !ans.spawnable) {
      body.appendChild(dom.el('li', 'tk-finding', 'Not spawned naturally (nominal=0)' +
        (ans.crafted ? ' — obtainable by crafting (flags.crafted=1).' : '.')));
    }
    if (ans.deloot) body.appendChild(dom.el('li', 'tk-finding', 'deloot flag: copies are removed permanently when looted (no respawn at that spot).'));

    if (ans.groups.length) {
      var rows = ans.groups.map(function (g) {
        var math = 'p = ' + g.weight.toLocaleString('en-US') + ' ÷ ' + g.weightSum.toLocaleString('en-US') +
          ' = ' + fmtP(g.p) + '  (' + oneIn(g.p) + ')';
        var note = '';
        if (g.zeroNominal > 0) note = ' · ' + g.zeroNominal + ' of the pool are nominal=0';
        return [
          { node: dom.el('strong', '', g.group) },
          g.poolSize.toLocaleString('en-US') + ' tagged',
          g.weight.toLocaleString('en-US'),
          { node: dom.el('strong', '', fmtP(g.p) + '  (' + oneIn(g.p) + ')'), cls: 'tk-prob' },
          math + note
        ];
      });
      body.appendChild(table(['Building group', 'Items tagged', 'Weight (X)', 'Chance per slot', 'Math'], rows));
      body.appendChild(dom.el('li', 'tk-finding',
        'Expected nominal copies in a group ≈ nominal × (its share of the pool draws); the per-slot chance above is the number to plan raids around.'));
    } else {
      body.appendChild(dom.el('li', 'tk-finding',
        ans.nominal > 0
          ? 'No usage groups in types.xml — this item spawns outside named building pools (general/map-wide containers). ' +
            'Per-group odds are not derivable from types.xml alone; nominal ' + ans.nominal + ' still bounds total copies per cycle.'
          : 'No usage groups and nominal=0 — not placed by the spawn system.'));
    }
    card.appendChild(body);
    return card;
  }

  function renderCompare(ansA, ansB, rows) {
    var card = dom.el('section', 'tk-card tk-good');
    var head = dom.el('div', 'tk-card-head');
    head.appendChild(dom.el('span', 'tk-status tk-status-good', 'COMPARE'));
    head.appendChild(dom.el('h3', 'tk-card-title', ansA.classname + ' vs ' + ansB.classname));
    card.appendChild(head);
    var body = dom.el('div', 'tk-findings');
    if (!rows.length) {
      body.appendChild(dom.el('li', 'tk-finding', 'Neither item is tagged to any spawn group.'));
    } else {
      var trs = rows.map(function (r) {
        var verdict;
        if (r.pA == null) verdict = 'A not in ' + r.group;
        else if (r.pB == null) verdict = 'B not in ' + r.group;
        else if (r.ratioAB > 1.001) verdict = 'A is ' + (r.ratioAB >= 10 ? r.ratioAB.toFixed(0) : r.ratioAB.toFixed(1)) + '× rarer than B in ' + r.group;
        else if (r.ratioAB < 0.999) verdict = 'B is ' + (1 / r.ratioAB >= 10 ? (1 / r.ratioAB).toFixed(0) : (1 / r.ratioAB).toFixed(1)) + '× rarer than A in ' + r.group;
        else verdict = 'same odds in ' + r.group;
        return [
          r.group,
          r.pA == null ? '—' : fmtP(r.pA) + ' (' + oneIn(r.pA) + ')',
          r.pB == null ? '—' : fmtP(r.pB) + ' (' + oneIn(r.pB) + ')',
          verdict
        ];
      });
      body.appendChild(table(['Building group', 'A chance per slot', 'B chance per slot', 'Verdict'], trs));
    }
    card.appendChild(body);
    return card;
  }

  function runQuery() {
    if (!state.items) { showError('No data loaded yet — pick a map or drop a types.xml first.'); return; }
    var q = queryInput.value;
    var matches = lp.searchItems(state.items, q);
    if (!matches.length) { showError('No item matches "' + q + '" in ' + state.source + '.'); return; }
    if (matches.length > 1) {
      var listCard = dom.el('section', 'tk-card tk-good');
      listCard.appendChild(dom.el('div', 'tk-card-head'));
      listCard.querySelector('.tk-card-head').appendChild(
        dom.el('h3', 'tk-card-title', matches.length + ' matches for "' + q + '" — click one:'));
      var list = dom.el('ul', 'tk-findings');
      matches.slice(0, 25).forEach(function (it) {
        var li = dom.el('li', 'tk-finding');
        var btn = dom.el('button', 'tk-btn tk-btn-small', it.classname);
        btn.type = 'button';
        btn.addEventListener('click', function () { queryInput.value = it.classname; renderOne(it); });
        li.appendChild(btn);
        list.appendChild(li);
      });
      if (matches.length > 25) list.appendChild(dom.el('li', 'tk-finding', '…and ' + (matches.length - 25) + ' more (refine the search).'));
      listCard.appendChild(list);
      results.textContent = '';
      results.appendChild(listCard);
      return;
    }
    renderOne(matches[0]);
  }

  function renderOne(item) {
    state.queryItem = item;
    results.textContent = '';
    var title = dom.el('p', 'tk-results-title', 'Result — computed from ' + state.source);
    results.appendChild(title);
    results.appendChild(renderItem(lp.itemProbability(item, state.pools)));
    if (compareInput.value.trim()) {
      var cmp = lp.searchItems(state.items, compareInput.value);
      if (cmp.length === 1) {
        var ansA = lp.itemProbability(item, state.pools);
        var ansB = lp.itemProbability(cmp[0], state.pools);
        results.appendChild(renderCompare(ansA, ansB, lp.compareItems(item, cmp[0], state.pools)));
      } else if (cmp.length > 1) {
        showError('Compare target "' + compareInput.value + '" is ambiguous (' + cmp.length + ' matches).');
      }
    }
  }

  function runCompare() {
    if (!state.queryItem) { showError('Query an item first — compare works relative to the queried item.'); return; }
    renderOne(state.queryItem); // re-renders with the compare input included
  }

  queryBtn.addEventListener('click', runQuery);
  queryInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') runQuery(); });
  compareBtn.addEventListener('click', runCompare);
  compareInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') runCompare(); });

  // Default: nasdara, out of the box.
  loadExtracted('nasdara');
})();
