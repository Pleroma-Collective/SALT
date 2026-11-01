/* global document */
/*
 * Mission Validator page (card t_0743c982). Client-side only.
 * Accepts a mission .zip (via locally vendored JSZip) or a set of loose
 * files / a folder. Every text file is validated locally; nothing is
 * uploaded.
 */
(function () {
  'use strict';
  var core = globalThis.DayZToolkitCore;
  var dom = globalThis.DayZToolkitDom;
  if (!core || !dom) return;

  var app = document.getElementById('app');
  dom.mountChrome(app, 'Mission Validator (ZIP)',
    'Drop a mission .zip — or a folder of loose mission files. The archive is unzipped in memory, ' +
    'every XML / JSON / init.c file is validated with DayZ structure rules, the mission layout is ' +
    'checked (mission.sqm, init.c, db/messages.xml, …), and spawn coordinates are tested against ' +
    'the map bounds when the mission name identifies a map.');

  var results = document.createElement('div');
  results.className = 'tk-results';
  var progress = dom.mountProgress(app);

  var MAX_ENTRIES = 500;

  function relLower(entryPath) {
    // Normalize backslashes from zip archives, strip leading ./
    return entryPath.split('/').filter(Boolean).join('/').toLowerCase();
  }

  function kindFor(name) {
    var lower = name.toLowerCase();
    if (lower === 'init.c') return 'initc';
    if (lower.endsWith('.c')) return 'initc';
    if (lower.endsWith('.xml')) return 'xml';
    if (lower.endsWith('.json')) return 'json';
    return 'skip';
  }

  function detectMapId(paths) {
    // Prefer mission.sqm's basename: 'dayzOffline.chernarusplus.sqm' or 'ChernarusPlus.sqm'
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (p === 'mission.sqm') {
        var folder = p.substring(0, p.lastIndexOf('/'));
        var id = core.mapIdFromMissionName(folder);
        if (id) return id;
      }
    }
    // Fallback: any path segment shaped like a mission name.
    for (var j = 0; j < paths.length; j++) {
      var segments = paths[j].split('/');
      for (var k = 0; k < segments.length; k++) {
        var guess = core.mapIdFromMissionName(segments[k]);
        if (guess) return guess;
      }
    }
    return null;
  }

  function runScan(items) {
    // items: [{ name: relativePath, text }]
    results.textContent = '';
    var start = Date.now();

    var lowerNames = {};
    items.forEach(function (item) { lowerNames[relLower(item.name)] = true; });
    var mapId = detectMapId(Object.keys(lowerNames));

    // 1) Mission structure (rendered as a standard report card)
    var structure = core.missionStructureReport(lowerNames);
    structure.fileName = 'mission layout — ' + items.length + ' files' + (mapId ? ' · map: ' + mapId : '');
    var structureReport = structure;

    // 2) Per-file validation
    var fileReports = [];
    items.forEach(function (item) {
      var kind = kindFor(item.name);
      if (kind === 'skip') return;
      var report;
      if (kind === 'xml') report = core.validateXml(item.name, item.text, dom.makeXmlParser());
      else if (kind === 'json') report = core.validateJson(item.name, item.text);
      else report = core.validateInitC(item.name, item.text);
      fileReports.push(report);
    });

    // 3) Event conflict pass on event files, with the detected map bounds.
    if (mapId) {
      items.forEach(function (item) {
        var kind = kindFor(item.name);
        if (kind !== 'xml') return;
        var base = item.name.split('/').pop().toLowerCase();
        if (base !== 'cfgeventspawns.xml' && base !== 'cfgeventgroups.xml' && base !== 'events.xml') return;
        var parsed;
        try {
          parsed = dom.makeXmlParser()(item.text);
        } catch (err) {
          return;
        }
        if (!parsed.ok) return;
        var ev = core.analyzeEvents(base + ' — conflict pass [' + mapId + ' bounds]', parsed.model, mapId);
        fileReports.push(ev);
      });
    }

    // Sort: invalid first, then good, then excellent; findings by name.
    var rank = { invalid: 0, good: 1, excellent: 2 };
    fileReports.sort(function (a, b) {
      var r = rank[a.summary.status] - rank[b.summary.status];
      return r !== 0 ? r : a.fileName.localeCompare(b.fileName);
    });

    var totalErrors = 0;
    var totalWarnings = 0;
    var okFiles = 0;
    fileReports.forEach(function (report) {
      totalErrors += report.summary.errorCount;
      totalWarnings += report.summary.warningCount;
      if (report.summary.valid) okFiles++;
    });
    totalErrors += structureReport.summary.errorCount;
    totalWarnings += structureReport.summary.warningCount;

    // Banner at the top, then the structure card, then per-file cards.
    dom.renderResultSummary(results, {
      total: fileReports.length + 1,
      ok: okFiles + (structureReport.summary.valid ? 1 : 0),
      errors: totalErrors,
      warnings: totalWarnings,
      note: 'scanned in ' + (Date.now() - start) + ' ms — all processing stayed in this tab'
    });
    dom.renderReport(results, structureReport);
    fileReports.forEach(function (report) {
      dom.renderReport(results, report);
    });
  }

  async function handleZip(file) {
    if (typeof globalThis.JSZip === 'undefined') {
      results.appendChild(dom.el('p', 'tk-err', 'JSZip failed to load — reload the page.'));
      progress.hide();
      return;
    }
    progress.show('Reading ' + file.name, null);
    var buffer = await dom.readAsArrayBuffer(file, function (loaded, total) {
      progress.show('Reading ' + file.name, total ? (loaded / total) * 100 : null);
    });
    var zip;
    try {
      zip = await globalThis.JSZip.loadAsync(buffer, {
        onprogress: function (e) {
          progress.show('Unzipping ' + file.name, e.total ? (e.loaded / e.total) * 100 : null);
        }
      });
    } catch (err) {
      results.appendChild(dom.el('p', 'tk-err', 'Could not open zip: ' + err.message));
      progress.hide();
      return;
    }
    var items = [];
    var totalBytes = 0;
    var aborted = null;
    zip.forEach(function (relPath, entry) {
      if (entry.dir) return;
      if (items.length >= MAX_ENTRIES) { aborted = 'Too many entries (' + MAX_ENTRIES + ' cap)'; return; }
      // Only inspect text-ish DayZ mission files; skip binaries (p3d, paa, sqm internals).
      var lower = relPath.toLowerCase();
      if (!lower.endsWith('.xml') && !lower.endsWith('.json') && lower !== 'init.c' && !lower.endsWith('.c') &&
          !lower.endsWith('mission.sqm') && lower.indexOf('mission.sqm') === -1) {
        // Still record non-text names for the structure check.
        return;
      }
      totalBytes += entry._data ? (entry._data.uncompressedSize || 0) : 0;
      if (totalBytes > core.MAX_SCAN_BYTES) aborted = 'Text content exceeds the ' + (core.MAX_SCAN_BYTES / 1048576) + ' MiB scan budget';
    });
    if (aborted) {
      results.appendChild(dom.el('p', 'tk-err', aborted));
      progress.hide();
      return;
    }
    // Re-walk to read (forEach is synchronous iteration; load lazily here).
    var pending = [];
    zip.forEach(function (relPath, entry) {
      if (entry.dir) return;
      var lower = relPath.toLowerCase();
      if (items.length >= MAX_ENTRIES) return;
      if (lower === 'mission.sqm' || lower.endsWith('.sqm') ||
          lower.endsWith('.xml') || lower.endsWith('.json') || lower === 'init.c' || lower.endsWith('.c')) {
        pending.push({ name: relLower(relPath), entry: entry });
      }
    });
    for (var i = 0; i < pending.length; i++) {
      var p = pending[i];
      progress.show('Extracting ' + p.name + ' (' + (i + 1) + '/' + pending.length + ')');
      if (p.name.endsWith('.sqm')) {
        items.push({ name: p.name, text: '' }); // structure marker only; .sqm is not text-validated
        continue;
      }
      try {
        var text = await p.entry.async('string');
        if (text.length > core.MAX_FILE_BYTES) {
          results.appendChild(dom.el('p', 'tk-err', p.name + ' exceeds the per-file limit — skipped'));
          continue;
        }
        items.push({ name: p.name, text: text });
      } catch (err) {
        results.appendChild(dom.el('p', 'tk-err', 'Failed to read ' + p.name + ': ' + err.message));
      }
    }
    if (items.length === 0) {
      results.appendChild(dom.el('p', 'tk-err', 'No inspectable mission files found in the archive.'));
      progress.hide();
      return;
    }
    progress.show('Validating ' + items.length + ' file(s)');
    runScan(items);
    progress.hide();
  }

  function handleLoose(items) {
    // Loose files: read each file's text, then scan (binary source box).
    var named = [];
    var chain = Promise.resolve();
    items.forEach(function (item) {
      chain = chain.then(function () {
        progress.show('Reading ' + item.name);
        return dom.readAsText(item.file).then(function (text) {
          named.push({ name: item.name, text: text });
        });
      });
    });
    chain.then(function () { progress.hide(); runScan(named); });
  }

  dom.mountSourceBox(app, {
    multiple: true,
    accept: '.zip,.xml,.json,.c',
    allowPaste: false,
    binary: true,
    title: 'Drop a mission .zip — or loose mission files — here',
    onFiles: function (items) {
      var zipItem = null;
      var loose = [];
      items.forEach(function (item) {
        if (item.name.toLowerCase().endsWith('.zip')) zipItem = item;
        else loose.push(item);
      });
      if (zipItem) handleZip(zipItem.file);
      else if (loose.length) handleLoose(loose);
    }
  });
  app.appendChild(results);
})();
