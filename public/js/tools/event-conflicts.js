/* global document */
/*
 * Event Conflict Check page (card t_0743c982). Client-side only.
 * Cross-checks cfgeventspawns.xml / cfgeventgroups.xml / events.xml:
 * shadowed names, invalid coordinates, out-of-bounds positions,
 * and lootmin/lootmax inversions.
 */
(function () {
  'use strict';
  var core = globalThis.DayZToolkitCore;
  var dom = globalThis.DayZToolkitDom;
  if (!core || !dom) return;

  var app = document.getElementById('app');
  dom.mountChrome(app, 'Event Conflict Check',
    'Drop cfgeventspawns.xml and/or cfgeventgroups.xml (and events.xml where used). The engine keys ' +
    'events and groups by name — a duplicate silently shadows the first definition. Positions are ' +
    'validated numerically and, when the map is known, checked against real map bounds ' +
    '(Chernarus+ / Sakhal 15 360 m, Livonia / Namalsk / Takistan+ 12 800 m).');

  // Map selection: auto from file names, or explicit.
  var mapSelect = document.createElement('select');
  mapSelect.className = 'tk-select';
  var autoOpt = document.createElement('option');
  autoOpt.value = 'auto';
  autoOpt.textContent = 'Auto (from file name)';
  mapSelect.appendChild(autoOpt);
  Object.keys(core.MAP_BOUNDS).forEach(function (mapId) {
    var opt = document.createElement('option');
    opt.value = mapId;
    opt.textContent = mapId + ' (' + core.MAP_BOUNDS[mapId] + ' m)';
    mapSelect.appendChild(opt);
  });
  var noneOpt = document.createElement('option');
  noneOpt.value = 'none';
  noneOpt.textContent = 'Skip bounds check';
  mapSelect.appendChild(noneOpt);

  var controls = document.createElement('div');
  controls.className = 'tk-split-row';
  controls.appendChild(dom.el('label', '', 'Map:'));
  controls.appendChild(mapSelect);
  app.appendChild(controls);

  var results = document.createElement('div');
  results.className = 'tk-results';

  function detectMapId(fileName) {
    var segments = fileName.split(/[\\/]/);
    for (var i = 0; i < segments.length; i++) {
      var id = core.mapIdFromMissionName(segments[i]);
      if (id) return id;
    }
    return null;
  }

  var EVENT_BASENAMES = { 'cfgeventspawns.xml': 1, 'cfgeventgroups.xml': 1, 'events.xml': 1 };

  function runOn(items) {
    results.textContent = '';
    var eventItems = items.filter(function (item) {
      return EVENT_BASENAMES[item.name.split('/').pop().toLowerCase()];
    });
    var otherItems = items.filter(function (item) {
      return !EVENT_BASENAMES[item.name.split('/').pop().toLowerCase()];
    });
    if (!eventItems.length) {
      otherItems.forEach(function (item) {
        dom.renderSummaryLine(results, item.name + ': not an event definition file (needs cfgeventspawns.xml, cfgeventgroups.xml or events.xml) — skipped.');
      });
      dom.renderSummaryLine(results, 'No event files detected.');
      return;
    }

    // ---- Phase 1: per-file structural + conflict passes ----
    var fileReports = [];
    var okFiles = 0;
    var totalErrors = 0;
    var totalWarnings = 0;
    eventItems.forEach(function (item) {
      var base = item.name.split('/').pop().toLowerCase();
      var mapId;
      if (mapSelect.value === 'auto') mapId = detectMapId(item.name);
      else if (mapSelect.value === 'none') mapId = null;
      else mapId = mapSelect.value;

      var structural = core.validateXml(item.name, item.text, dom.makeXmlParser(), base);
      var reports = [structural];
      var parsed;
      try { parsed = dom.makeXmlParser()(item.text); } catch (err) { parsed = { ok: false }; }
      if (parsed.ok) {
        var conflicts = core.analyzeEvents(base + ' — conflict pass' + (mapId ? ' [' + mapId + ' bounds]' : ' [no bounds]'), parsed.model, mapId);
        reports.push(conflicts);
      }
      reports.forEach(function (r) {
        totalErrors += r.summary.errorCount;
        totalWarnings += r.summary.warningCount;
        fileReports.push(r);
      });
      if (reports.every(function (r) { return r.summary.errorCount === 0; })) okFiles++;
    });

    // ---- Phase 2: banner, skipped files, then cards ----
    dom.renderResultSummary(results, {
      total: eventItems.length + otherItems.length,
      ok: okFiles,
      errors: totalErrors,
      warnings: totalWarnings,
      note: 'all checks ran locally'
    });
    otherItems.forEach(function (item) {
      dom.renderSummaryLine(results, item.name + ': not an event definition file (needs cfgeventspawns.xml, cfgeventgroups.xml or events.xml) — skipped.');
    });
    fileReports.forEach(function (report) {
      dom.renderReport(results, report);
    });
  }

  dom.mountSourceBox(app, {
    multiple: true,
    accept: '.xml,.txt',
    allowPaste: true,
    pastePlaceholder: 'Paste event XML here (single document)…',
    title: 'Drop cfgeventspawns.xml / cfgeventgroups.xml / events.xml here',
    onFiles: function (items) {
      // Pasted content is always validated as the event file matching the paste;
      // give it a neutral name so auto-map detection skips it.
      var renamed = items.map(function (item) {
        if (item.name === 'pasted-document.xml') {
          return { name: 'pasted-event.xml', text: item.text };
        }
        return item;
      });
      runOn(renamed);
    }
  });
  app.appendChild(results);
})();
