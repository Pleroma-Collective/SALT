'use strict';

/* Dynamic messages.xml generator (services/dynamicMessagesService.js).
 *
 * Proves the core guarantees:
 *   MVP — computed from real kill_events data (not random): correct winner,
 *         PVP-only, deterministic tie-break, empty window → null
 *   XML — valid DayZ format: root <messages>, managed block marked by
 *         sentinels, existing admin messages preserved byte-for-byte,
 *         regeneration replaces (never duplicates) the managed block,
 *         no-op when nothing changed, XML-escaping of admin text,
 *         refusal to splice into unrecognized structures
 *   config — per-server upsert in server_features ('dynamic_messages')
 *
 * Run: node scripts/dynamic-messages-test.js */

const assert = require('assert');
const svc = require('../services/dynamicMessagesService');

const SAKHAL_MESSAGES = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<messages>
  <message>
    <deadline>120</deadline>
    <shutdown>1</shutdown>
    <text>SERVER WILL REBOOT IN #tmin MINS</text>
  </message>
  <message>
    <delay>1</delay>
    <onconnect>1</onconnect>
    <text>Welcome to the server</text>
  </message>
  <message>
    <repeat>6</repeat>
    <text>JOIN DISCORD</text>
  </message>
</messages>
`;

// ── buildMessagesXml ──────────────────────────────────────────────────────

function testPreservesExistingMessages() {
  const mvp = { gamertag: 'Lord Monkey 1', kills: 10 };
  const { xml, preservedMessageCount, hadManagedBlock } = svc.buildMessagesXml(SAKHAL_MESSAGES, { mvp, updateMessage: 'Wipe in 2 days' });
  // all three original messages survive, verbatim
  for (const text of ['SERVER WILL REBOOT IN #tmin MINS', 'Welcome to the server', 'JOIN DISCORD']) {
    assert.ok(xml.includes(`<text>${text}</text>`), `preserved message lost: ${text}`);
  }
  assert.strictEqual(preservedMessageCount, 5, '3 preserved + 2 managed');
  assert.strictEqual(hadManagedBlock, false);
  assert.ok(xml.includes('MVP OF THE DAY: Lord Monkey 1 (10 PVP kills, last 24h)'), 'MVP line present');
  assert.ok(xml.includes('<text>Wipe in 2 days</text>'), 'admin update present');
  assert.ok(xml.includes(`<repeat>${svc.DEFAULT_UPDATE_REPEAT_MINUTES}</repeat>`), 'default repeat');
  // valid DayZ structure
  assert.ok(xml.startsWith('<?xml'), 'xml declaration');
  assert.ok(xml.includes('<messages>'), 'root element');
  assert.ok(xml.trim().endsWith('</messages>'), 'closed root');
}

function testRegenerationReplacesNotDuplicates() {
  const first = svc.buildMessagesXml(SAKHAL_MESSAGES, { mvp: { gamertag: 'A', kills: 1 }, updateMessage: 'v1' });
  assert.ok(first.xml.includes(svc.BEGIN_SENTINEL) && first.xml.includes(svc.END_SENTINEL), 'sentinels present');
  const second = svc.buildMessagesXml(first.xml, { mvp: { gamertag: 'B', kills: 2 }, updateMessage: 'v2' });
  assert.ok(second.xml.includes('MVP OF THE DAY: B (2 PVP kills, last 24h)'));
  assert.ok(second.xml.includes('<text>v2</text>'));
  assert.ok(!second.xml.includes('MVP OF THE DAY: A'), 'old MVP removed');
  assert.ok(!second.xml.includes('<text>v1</text>'), 'old update removed');
  assert.strictEqual((second.xml.match(/dynamic-messages:begin/g) || []).length, 1, 'single managed block');
  assert.strictEqual(second.preservedMessageCount, 5, 'still 3 original + 2 managed');
  assert.strictEqual(second.hadManagedBlock, true);
  // idempotent: same input again → byte-identical
  const third = svc.buildMessagesXml(second.xml, { mvp: { gamertag: 'B', kills: 2 }, updateMessage: 'v2' });
  assert.strictEqual(third.xml, second.xml, 'idempotent on own output');
}

function testNoOpIsByteIdentical() {
  const { xml } = svc.buildMessagesXml(SAKHAL_MESSAGES, { mvp: null, updateMessage: '' });
  assert.strictEqual(xml, SAKHAL_MESSAGES, 'untouched file must come back byte-identical');
}

function testManagedBlockRemovedWhenNothingLeft() {
  const withBlock = svc.buildMessagesXml(SAKHAL_MESSAGES, { mvp: { gamertag: 'A', kills: 1 } }).xml;
  const cleared = svc.buildMessagesXml(withBlock, { mvp: null, updateMessage: '' });
  assert.ok(!cleared.xml.includes('dynamic-messages:'), 'managed block removed');
  assert.ok(cleared.xml.includes('SERVER WILL REBOOT IN #tmin MINS'), 'originals intact');
  assert.strictEqual(cleared.preservedMessageCount, 3);
}

function testXmlEscapingAndDayZVariables() {
  const { xml } = svc.buildMessagesXml(SAKHAL_MESSAGES, {
    mvp: null,
    updateMessage: 'New <XP farm> & shops — details on #name',
  });
  assert.ok(xml.includes('<text>New &lt;XP farm&gt; &amp; shops — details on #name</text>'), 'escaped, #name kept');
  assert.ok(!xml.includes('<XP farm>'), 'raw angle brackets must not survive');
}

function testRepeatClamped() {
  const { xml } = svc.buildMessagesXml(SAKHAL_MESSAGES, { mvp: null, updateMessage: 'x', updateRepeatMinutes: 9999 });
  assert.ok(xml.includes(`<repeat>${svc.MAX_UPDATE_REPEAT_MINUTES}</repeat>`), 'clamped to max');
  const low = svc.buildMessagesXml(SAKHAL_MESSAGES, { mvp: null, updateMessage: 'x', updateRepeatMinutes: 0.5 });
  assert.ok(low.xml.includes('<repeat>1</repeat>', 'clamped to min'));
}

function testEmptyInput() {
  const { xml } = svc.buildMessagesXml('', { mvp: { gamertag: 'Z', kills: 3 }, updateMessage: 'hi' });
  assert.ok(xml.startsWith('<?xml'));
  assert.ok(xml.includes('<messages>'));
  assert.ok(xml.trim().endsWith('</messages>'));
  assert.strictEqual(xml.match(/<message[\s>]/g).length, 2);
  const none = svc.buildMessagesXml(null, { mvp: null, updateMessage: '' });
  assert.strictEqual(none.xml.trim(), '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<messages>\n</messages>', 'empty root');
}

function testStockFileWithComments() {
  const stock = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<messages>
  <!-- big doc comment
       <message><text>not real</text></message>
  -->
</messages>`;
  const { xml, preservedMessageCount } = svc.buildMessagesXml(stock, { mvp: { gamertag: 'W', kills: 1 } });
  assert.ok(xml.includes('big doc comment'), 'comment preserved');
  assert.ok(xml.includes('MVP OF THE DAY: W (1 PVP kill, last 24h)'), 'singular form');
  assert.ok(xml.trim().endsWith('</messages>'), 'closed root');
  assert.strictEqual(preservedMessageCount, 2, 'commented example + real mvp');
}

function testUnrecognizedStructureRefused() {
  assert.throws(() => svc.buildMessagesXml('<html><body>?</html>', { mvp: { gamertag: 'A', kills: 1 } }),
    /unrecognized structure/, 'must refuse unknown shapes');
}

function testOrphanedSentinelRegeneratesFresh() {
  const orphan = SAKHAL_MESSAGES.replace('</messages>', '  <!-- dynamic-messages:begin -->\n  <message><text>stale</text></message>\n</messages>');
  const { xml, preservedMessageCount } = svc.buildMessagesXml(orphan, { mvp: null, updateMessage: 'fresh' });
  assert.strictEqual(preservedMessageCount, 1, 'fresh file has only the new update');
  assert.ok(xml.includes('<text>fresh</text>'));
  assert.ok(!xml.includes('<text>stale</text>'));
}

// ── computeMvp (fake db, house pattern) ──────────────────────────────────

function fakeDbWithMvp(row) {
  return {
    async get(sql, params) {
      if (/FROM kill_events/i.test(sql)) {
        assert.strictEqual(params.length, 3, 'server id bound three times');
        assert.strictEqual(params[0], params[1]);
        assert.strictEqual(params[1], params[2]);
        return row || null;
      }
      throw new Error('unexpected SQL in fake db: ' + sql.slice(0, 80));
    },
  };
}

async function testComputeMvp() {
  const winner = await svc.computeMvp(fakeDbWithMvp({
    gamertag: 'Lord Monkey 1', kills: 10, last_kill: '2026-10-28T01:00:00Z', window_start: '2026-10-27T08:00:00Z',
  }), 7);
  assert.deepStrictEqual(winner, {
    gamertag: 'Lord Monkey 1', kills: 10, lastKillAt: '2026-10-28T01:00:00Z', windowStart: '2026-10-27T08:00:00Z',
  });
  assert.strictEqual(await svc.computeMvp(fakeDbWithMvp(null), 7), null, 'no kills → null, not random');
  // SQL guarantees: PVP only (both identities resolved), 24h window, wipe reset
  let capturedSql;
  const captureDb = { async get(q) { capturedSql = q; return null; } };
  await svc.computeMvp(captureDb, 7);
  assert.ok(/killer_identity_id IS NOT NULL/.test(capturedSql), 'PVP: killer identity required');
  assert.ok(/victim_identity_id IS NOT NULL/.test(capturedSql), 'PVP: victim identity required');
  assert.ok(/INTERVAL '24 hours'/.test(capturedSql), '24h window');
  assert.ok(/last_wipe_at/.test(capturedSql), 'wipe resets the window');
  assert.ok(/ORDER BY kills DESC, last_kill DESC, killer_gamertag ASC/.test(capturedSql), 'deterministic tie-break');
}

// ── config persistence (fake db, house pattern) ──────────────────────────

function fakeFeatureDb() {
  const rows = [];
  return {
    rows,
    async get(sql, params) {
      assert.ok(/FROM server_features/i.test(sql));
      assert.strictEqual(params[1], 'dynamic_messages');
      return rows.find(r => r.server_id === params[0]) || null;
    },
    async run(sql, params) {
      assert.ok(/INSERT INTO server_features/i.test(sql) && /ON CONFLICT/i.test(sql));
      const [serverId, featureName, enabled, config] = params;
      const existing = rows.find(r => r.server_id === serverId);
      if (existing) {
        existing.enabled = enabled;
        existing.config = config;
      } else {
        rows.push({ server_id: serverId, feature_name: featureName, enabled, config });
      }
    },
  };
}

async function testConfigRoundTrip() {
  const db = fakeFeatureDb();
  assert.deepStrictEqual(await svc.loadConfig(db, 7), {
    enabled: false, mvpEnabled: true, updateMessage: '',
    updateRepeatMinutes: svc.DEFAULT_UPDATE_REPEAT_MINUTES,
    lastMvp: null, lastDeployedAt: null, lastDeployedXmlHash: null,
  });
  await svc.saveConfig(db, 7, { updateMessage: 'hello', updateRepeatMinutes: 20, mvpEnabled: true }, true);
  const loaded = await svc.loadConfig(db, 7);
  assert.strictEqual(loaded.enabled, true);
  assert.strictEqual(loaded.updateMessage, 'hello');
  assert.strictEqual(loaded.updateRepeatMinutes, 20);
  // upsert, not insert
  await svc.saveConfig(db, 7, { updateMessage: 'world', updateRepeatMinutes: 20, mvpEnabled: false }, true);
  assert.strictEqual(db.rows.length, 1, 'single row per server');
  assert.strictEqual((await svc.loadConfig(db, 7)).updateMessage, 'world');
}

// ── messages path resolution (fake file service) ─────────────────────────

function fakeFileService(files) {
  return {
    async downloadFileFromServer(serverId, filePath, token) {
      void serverId; void token;
      return files[filePath] === undefined ? null : files[filePath];
    },
  };
}

async function testResolveMessagesRelPath() {
  const cfg = `<?xml version="1.0"?><economycore><ce folder="db"><file type="messages" name="msg.xml"/></ce></economycore>`;
  const ok = await svc.resolveMessagesRelPath(
    fakeFileService({ '/noftp/dayzxb/mpmissions/m/cfgeconomycore.xml': cfg }),
    '123', 'token', '/noftp/dayzxb/mpmissions', 'm'
  );
  assert.strictEqual(ok, 'db/msg.xml', 'declared path wins over fallback');

  const none = await svc.resolveMessagesRelPath(fakeFileService({}), '123', 'token', '/noftp/dayzxb/mpmissions', 'm');
  assert.strictEqual(none, 'custom/messages.xml', 'missing core → custom fallback');

  const silent = await svc.resolveMessagesRelPath(
    fakeFileService({ '/noftp/dayzxb/mpmissions/m/cfgeconomycore.xml': '<economycore><ce folder="x"><file type="weapons" name="w.xml"/></ce></economycore>' }),
    '123', 'token', '/noftp/dayzxb/mpmissions', 'm'
  );
  assert.strictEqual(silent, 'custom/messages.xml', 'no messages entry → custom fallback');

  // hostile declared path must be rejected
  await assert.rejects(
    svc.resolveMessagesRelPath(
      fakeFileService({ '/noftp/dayzxb/mpmissions/m/cfgeconomycore.xml': '<economycore><ce folder="../../etc"><file type="messages" name="passwd"/></ce></economycore>' }),
      '123', 'token', '/noftp/dayzxb/mpmissions', 'm'
    ),
    /invalid messages path/, 'path traversal refused'
  );
}

// ── run ──────────────────────────────────────────────────────────────────

(async () => {
  testPreservesExistingMessages();
  testRegenerationReplacesNotDuplicates();
  testNoOpIsByteIdentical();
  testManagedBlockRemovedWhenNothingLeft();
  testXmlEscapingAndDayZVariables();
  testRepeatClamped();
  testEmptyInput();
  testStockFileWithComments();
  testUnrecognizedStructureRefused();
  testOrphanedSentinelRegeneratesFresh();
  await testComputeMvp();
  await testConfigRoundTrip();
  await testResolveMessagesRelPath();
  console.log('✅ dynamic-messages-test: all checks passed');
})().catch(err => {
  console.error('❌ dynamic-messages-test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
