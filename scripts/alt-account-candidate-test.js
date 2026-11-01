const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  parseRPTLoginWaitFile,
  parseRPTLoginWaits,
} = require('../routes/logParser');
const {
  buildAltCandidates,
  loadAltCandidates,
  normalizeReviewStatus,
} = require('../services/altAccountCandidateService');
const missionFileService = require('../services/missionFileService');
const nitradoService = require('../services/nitradoService');

function session(identityId, loginAt, logoutAt) {
  return { identity_id: identityId, login_at: loginAt, logout_at: logoutAt };
}

async function run() {
  const rptWaits = parseRPTLoginWaits([
    '14:30:00.500 [Login]: Adding player Alpha One (12345678) to login queue at position 0',
    '14:30:01.125 [StateMachine]: Player Alpha One (dpnid 12345678 uid AABBCCDDEEFF0011) Entering DBWaitLoginTimeLoginState',
    '14:33:27.139 [StateMachine]: Player Alpha One (dpnid 12345678 uid AABBCCDDEEFF0011) Entering DBGetCharacterLoginState',
    '14:40:00.000 [StateMachine]: Player Incomplete Two (dpnid 87654321 uid 0011AABBCCDDEEFF) Entering DBWaitLoginTimeLoginState',
  ], '2026-09-07', 'xbox', 'fixture.RPT');
  assert.deepStrictEqual(rptWaits, [{
    playerGamertag: 'Alpha One',
    platformUserId: 'AABBCCDDEEFF0011',
    queueEnteredAt: '2026-09-07T14:30:00.500Z',
    waitStartedAt: '2026-09-07T14:30:01.125Z',
    waitEndedAt: '2026-09-07T14:33:27.139Z',
    waitDurationMs: 206014,
    sourceFile: 'fixture.RPT',
    sourceLine: 2,
  }], 'RPT wait parsing must preserve names with spaces, milliseconds, and ignore incomplete waits');

  const oversizedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-wait-'));
  const oversizedPath = path.join(oversizedDir, 'DayZServer_X1_x64_2026-09-07_23-50-00.RPT');
  try {
    fs.writeFileSync(oversizedPath, [
      '23:59:55.000 [Login]: Adding player Midnight Alt (22222222) to login queue at position 0\n',
      '23:59:56.000 [StateMachine]: Player Midnight Alt (dpnid 22222222 uid ABCDEF0011223344) Entering DBWaitLoginTimeLoginState\n',
      `${'x'.repeat(20 * 1024 * 1024 + 1024)}\n`,
      '00:01:06.000 [StateMachine]: Player Midnight Alt (dpnid 22222222 uid ABCDEF0011223344) Entering DBGetCharacterLoginState\n',
    ].join(''));
    const oversizedWaits = await parseRPTLoginWaitFile(
      oversizedPath,
      '2026-09-07',
      'xbox',
      { rootDir: oversizedDir }
    );
    assert.strictEqual(oversizedWaits.length, 1,
      'oversized active RPT files must retain waits that begin before the moving tail');
    assert.strictEqual(oversizedWaits[0].sourceLine, 2,
      'RPT evidence must retain an absolute source line as the file grows');
    assert.strictEqual(oversizedWaits[0].waitEndedAt, '2026-09-08T00:01:06.000Z',
      'RPT evidence must preserve midnight rollover from the complete chronology');
    assert.strictEqual(oversizedWaits[0].waitDurationMs, 70000);
  } finally {
    fs.rmSync(oversizedDir, { recursive: true, force: true });
  }

  const accounts = [
    { identity_id: 1, gamertag: 'Alpha', platform: 'xbox', linked_user_id: 10, verification_method: 'emote_challenge' },
    { identity_id: 2, gamertag: 'Bravo', platform: 'xbox', linked_user_id: 10, verification_method: 'admin_approved' },
    { identity_id: 3, gamertag: 'Charlie', platform: 'xbox', linked_user_id: 11, verification_method: 'self_asserted' },
  ];

  const confirmed = buildAltCandidates({ accounts, sessions: [], reviews: [] });
  assert.strictEqual(confirmed.length, 1);
  assert.strictEqual(confirmed[0].confidence, 'confirmed');
  assert.deepStrictEqual(confirmed[0].identityIds, [1, 2]);
  assert.ok(confirmed[0].evidence.some(item => item.type === 'verified_discord_owner'));

  const behavioralAccounts = accounts.map(account => ({ ...account, linked_user_id: null, verification_method: null }));
  const behavioralSessions = [
    session(1, '2026-08-01T10:00:00Z', '2026-08-01T10:10:00Z'),
    session(2, '2026-08-01T10:11:00Z', '2026-08-01T10:20:00Z'),
    session(1, '2026-08-02T11:00:00Z', '2026-08-02T11:10:00Z'),
    session(2, '2026-08-02T11:11:30Z', '2026-08-02T11:20:00Z'),
    session(2, '2026-08-03T12:00:00Z', '2026-08-03T12:10:00Z'),
    session(1, '2026-08-03T12:11:00Z', '2026-08-03T12:20:00Z'),
  ];
  const behavioral = buildAltCandidates({ accounts: behavioralAccounts, sessions: behavioralSessions, reviews: [] });
  assert.strictEqual(behavioral.length, 1);
  assert.strictEqual(behavioral[0].confidence, 'likely');
  assert.strictEqual(Object.hasOwn(behavioral[0], 'enforcementEligible'), false,
    'candidate API must not imply that detection alone authorizes enforcement');
  assert.strictEqual(behavioral[0].evidence.find(item => item.type === 'rapid_switches').count, 3);
  assert.strictEqual(behavioral[0].evidence.find(item => item.type === 'distinct_days').count, 3);

  const oneCycleSessions = [
    session(1, '2026-09-07T14:00:00Z', '2026-09-07T14:10:00Z'),
    session(2, '2026-09-07T14:11:00Z', '2026-09-07T14:20:00Z'),
    session(1, '2026-09-07T14:21:00Z', '2026-09-07T14:30:00Z'),
  ];
  const oneCycle = buildAltCandidates({ accounts: behavioralAccounts, sessions: oneCycleSessions, reviews: [] });
  assert.strictEqual(oneCycle.length, 1,
    'a bidirectional account-switch cycle within two minutes must surface for moderator review');
  assert.strictEqual(oneCycle[0].confidence, 'possible',
    'one-day behavioral evidence must remain possible rather than likely');
  assert.strictEqual(oneCycle[0].evidence.find(item => item.type === 'rapid_switches').strictCount, 2);
  const oneCycleDays = oneCycle[0].evidence.find(item => item.type === 'distinct_days');
  assert.strictEqual(oneCycleDays.count, 1);
  assert.match(oneCycleDays.label, /one day/i);
  assert.doesNotMatch(oneCycleDays.label, /separate days/i);

  const oneDirectionOnly = [
    session(1, '2026-09-07T10:00:00Z', '2026-09-07T10:10:00Z'),
    session(2, '2026-09-07T10:11:00Z', '2026-09-07T10:20:00Z'),
    session(1, '2026-09-07T11:00:00Z', '2026-09-07T11:10:00Z'),
    session(2, '2026-09-07T11:11:00Z', '2026-09-07T11:20:00Z'),
  ];
  assert.strictEqual(
    buildAltCandidates({ accounts: behavioralAccounts, sessions: oneDirectionOnly, reviews: [] }).length,
    0,
    'repeated one-way handoffs alone must not create an alt candidate'
  );
  const enforcedDelayCandidate = buildAltCandidates({
    accounts: behavioralAccounts,
    sessions: [],
    reviews: [],
    behaviorCandidates: [{
      identity_id_low: 1,
      identity_id_high: 2,
      event_count: 1,
      strict_count: 1,
      distinct_days: 1,
      strict_distinct_days: 1,
      direction_count: 1,
      strict_direction_count: 1,
      enforced_wait_count: 1,
      minimum_delay_seconds: 91.899,
      minimum_wait_duration_ms: 206014,
      maximum_wait_duration_ms: 206014,
    }],
  });
  assert.strictEqual(enforcedDelayCandidate.length, 1,
    'one correlated RPT-enforced login delay must flag the account pair');
  assert.strictEqual(enforcedDelayCandidate[0].confidence, 'confirmed',
    'the enforced alt-account delay must be a definitive alt flag');
  assert.match(
    enforcedDelayCandidate[0].evidence.find(item => item.type === 'rapid_switches').label,
    /handoff within/i,
    'a single delay must not be described as repeated handoffs'
  );
  assert.ok(!enforcedDelayCandidate[0].evidence.some(item => item.type === 'bidirectional_switches'),
    'one enforced delay must not claim a bidirectional switch cycle');
  assert.ok(!enforcedDelayCandidate[0].evidence.some(item => item.type === 'never_concurrent'),
    'enforced-delay candidates must not claim concurrency was disproven when that check was bypassed');
  const mergedEnforcedDelayCandidate = buildAltCandidates({
    accounts: behavioralAccounts,
    sessions: oneCycleSessions,
    reviews: [],
    behaviorCandidates: [{
      identity_id_low: 1,
      identity_id_high: 2,
      event_count: 1,
      strict_count: 1,
      distinct_days: 1,
      strict_distinct_days: 1,
      direction_count: 1,
      strict_direction_count: 1,
      enforced_wait_count: 1,
      minimum_delay_seconds: 60,
      minimum_wait_duration_ms: 70000,
      maximum_wait_duration_ms: 70000,
    }],
  });
  assert.strictEqual(mergedEnforcedDelayCandidate[0].confidence, 'confirmed',
    'enforced-delay evidence must upgrade an existing behavioral candidate');
  assert.strictEqual(Object.hasOwn(enforcedDelayCandidate[0], 'enforcementEligible'), false,
    'an RPT delay flag must not silently become automatic enforcement');

  const overlapping = behavioralSessions.concat([
    session(1, '2026-08-04T10:00:00Z', '2026-08-04T11:00:00Z'),
    session(2, '2026-08-04T10:30:00Z', '2026-08-04T10:45:00Z'),
  ]);
  assert.strictEqual(buildAltCandidates({ accounts: behavioralAccounts, sessions: overlapping, reviews: [] }).length, 0);

  const reviewed = buildAltCandidates({
    accounts: behavioralAccounts,
    sessions: behavioralSessions,
    reviews: [{ identity_id_low: 1, identity_id_high: 2, status: 'dismissed', notes: 'Known siblings' }],
  });
  assert.strictEqual(reviewed[0].review.status, 'dismissed');
  assert.strictEqual(reviewed[0].review.notes, 'Known siblings');

  const staleReview = buildAltCandidates({
    accounts: behavioralAccounts,
    sessions: [],
    reviews: [{ identity_id_low: 1, identity_id_high: 2, status: 'confirmed', notes: 'Previously reviewed' }],
  });
  assert.strictEqual(staleReview.length, 1, 'persisted reviews must remain manageable after evidence ages out');
  assert.strictEqual(staleReview[0].review.status, 'confirmed');
  assert.ok(staleReview[0].evidence.some(item => item.type === 'persisted_review'));

  const strictOnOneDay = behavioralSessions.map((item, index) =>
    index === 4 || index === 5
      ? { ...item, login_at: item.login_at.replace('2026-08-03', '2026-08-02'), logout_at: item.logout_at.replace('2026-08-03', '2026-08-02') }
      : item
  );
  strictOnOneDay[3] = session(2, '2026-08-02T11:14:00Z', '2026-08-02T11:20:00Z');
  const oneDayLikely = buildAltCandidates({ accounts: behavioralAccounts, sessions: strictOnOneDay, reviews: [] });
  assert.ok(oneDayLikely.every(candidate => candidate.confidence !== 'likely'),
    'likely confidence requires strict switches on separate days');

  assert.strictEqual(normalizeReviewStatus('confirmed'), 'confirmed');
  assert.strictEqual(normalizeReviewStatus('dismissed'), 'dismissed');
  assert.strictEqual(normalizeReviewStatus('pending'), 'pending');
  assert.throws(() => normalizeReviewStatus('banned'), /Invalid review status/);

  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('AS event_count')) return [{
        identity_id_low: 1,
        identity_id_high: 2,
        event_count: 3,
        strict_count: 3,
        distinct_days: 3,
        strict_distinct_days: 3,
        direction_count: 2,
        strict_direction_count: 2,
        minimum_delay_seconds: 60,
        enforced_wait_count: 2,
        minimum_wait_duration_ms: 206014,
        maximum_wait_duration_ms: 837021,
      }];
      if (sql.includes('FROM alt_account_reviews')) return [];
      return behavioralAccounts;
    },
  };
  const loadedCandidates = await loadAltCandidates(db, 44);
  assert.strictEqual(loadedCandidates[0].confidence, 'confirmed',
    'persisted enforced-delay evidence must return a definitive alt flag');
  const waitEvidence = loadedCandidates[0].evidence.find(item => item.type === 'rpt_login_wait');
  assert.deepStrictEqual(waitEvidence, {
    type: 'rpt_login_wait',
    label: 'RPT login-state waits observed: 3m 26s–13m 57s',
    count: 2,
    minimumWaitSeconds: 206.014,
    maximumWaitSeconds: 837.021,
  });
  assert.ok(calls.length >= 3);
  calls.forEach(call => assert.ok(call.params.includes(44), 'every candidate query must bind the exact server'));
  assert.ok(calls.some(call => /spm\.server_id = \?/.test(call.sql)), 'linked ownership must be exact-server scoped');
  const behaviorCall = calls.find(call => call.sql.includes('AS event_count'));
  assert.ok(behaviorCall, 'behavioral correlation must run in bounded SQL');
  assert.match(behaviorCall.sql, /FROM player_sessions starting[\s\S]*FROM player_sessions ending[\s\S]*ORDER BY ending\.logout_at DESC[\s\S]*LIMIT 1/,
    'each login must correlate only to its nearest preceding different-account logout');
  assert.doesNotMatch(behaviorCall.sql, /starting\.logout_at IS NOT NULL/,
    'an open starting session with enforced RPT delay must remain eligible');
  assert.match(behaviorCall.sql, /JOIN LATERAL/,
    'rapid-switch correlation must use an indexable range lookup');
  assert.doesNotMatch(behaviorCall.sql, /WITH recent_sessions/,
    'request-time correlation must not self-join a materialized session CTE');
  assert.match(behaviorCall.sql, /tstzrange\(newer\.login_at, newer\.logout_at, '\[\)'\)\s*&&\s*tstzrange\(older\.login_at, older\.logout_at, '\[\)'\)/,
    'historical overlap exclusion must use PostgreSQL range overlap');
  assert.doesNotMatch(behaviorCall.sql, /older\.login_at < newer\.logout_at/,
    'historical overlap exclusion must not use a quadratic interval inequality join');
  assert.doesNotMatch(behaviorCall.sql, /LIMIT\s+\?/, 'candidate correctness must not depend on truncating sessions');
  assert.match(behaviorCall.sql, /HAVING COUNT\(login_wait_duration_ms\) >= 1[\s\S]*OR/,
    'one correlated enforced RPT wait must flag the account pair without requiring a bidirectional cycle');
  assert.match(behaviorCall.sql, /login_wait\.wait_duration_ms >= 60000/,
    'ordinary approximately six-second database login work must not be classified as an enforced delay');
  assert.match(behaviorCall.sql, /COUNT\(\*\) FILTER \(WHERE delay_seconds <= 120\) >= 2/,
    'possible candidates require a strict bidirectional switch cycle');
  assert.match(behaviorCall.sql, /COUNT\(DISTINCT direction\) FILTER \(WHERE delay_seconds <= 120\) >= 2/,
    'both directions must occur inside the strict two-minute window');
  assert.match(behaviorCall.sql, /LEFT JOIN LATERAL[\s\S]*FROM rpt_login_wait_events login_wait[\s\S]*login_wait\.server_id = starting\.server_id[\s\S]*login_wait\.identity_id = starting\.identity_id/,
    'RPT waits must correlate to the starting identity on the same exact server');
  assert.match(behaviorCall.sql, /login_wait\.queue_entered_at BETWEEN starting\.login_at - INTERVAL '5 seconds'[\s\S]*starting\.login_at \+ INTERVAL '5 seconds'/,
    'RPT waits must correlate to the matching ADM login rather than arbitrary account history');
  assert.match(behaviorCall.sql, /WHERE \( aggregated\.enforced_wait_count >= 1 OR NOT EXISTS \( SELECT 1 FROM player_sessions older/,
    'authoritative enforced-delay evidence must remain flagged despite contradictory session history');
  assert.match(behaviorCall.sql, /AND \( aggregated\.enforced_wait_count >= 1 OR NOT EXISTS \( SELECT 1 FROM player_position_snapshots first_sighting/,
    'authoritative enforced-delay evidence must remain flagged despite stale position co-presence');
  assert.match(behaviorCall.sql, /FROM player_position_snapshots first_sighting[\s\S]*second_sighting\.timestamp = first_sighting\.timestamp/,
    'same-snapshot co-presence must suppress behavior-only candidates');
  assert.ok(calls.some(call => /aar\.server_id = \?/.test(call.sql)), 'reviews must be exact-server scoped');

  const ownerSource = fs.readFileSync(path.join(ROOT, 'routes/ownerDashboard.js'), 'utf8');
  assert.doesNotMatch(ownerSource, /async function runAutoBanForServer/,
    'obsolete device-based automatic banning must be removed');
  assert.match(ownerSource, /router\.post\('\/servers\/:id\/alts\/review'/,
    'review mutation endpoint must exist');
  const reviewArea = ownerSource.slice(ownerSource.indexOf("router.post('/servers/:id/alts/review'"));
  assert.match(reviewArea, /ensureServerOwner/);
  assert.match(reviewArea, /identity_id_low/);
  assert.match(reviewArea, /identity_id_high/);
  assert.match(reviewArea, /existingReview/,
    'persisted decisions must be mutable without recalculating behavioral evidence');

  const migration = fs.readFileSync(path.join(ROOT, 'db/migrations/061_alt_account_reviews.js'), 'utf8');
  assert.match(migration, /UNIQUE\(server_id, identity_id_low, identity_id_high\)/);
  assert.match(migration, /CHECK \(identity_id_low < identity_id_high\)/);
  assert.match(migration, /status IN \('pending', 'confirmed', 'dismissed'\)/);
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS btree_gist/,
    'combined scalar/range GiST indexing requires btree_gist');
  assert.match(migration, /USING GIST \(\s*server_id,\s*identity_id,\s*tstzrange\(login_at, logout_at, '\[\)'\)\s*\)/,
    'completed-session overlap checks need an exact-server, exact-identity range index');
  assert.match(migration, /WHERE logout_at IS NOT NULL/,
    'session range index must exclude incomplete sessions');
  assert.match(migration, /UPDATE server_settings SET auto_ban_alts = 0/,
    'upgrade must fail closed by disabling legacy automatic enforcement');

  const waitMigration = fs.readFileSync(path.join(ROOT, 'db/migrations/087_rpt_login_wait_evidence.js'), 'utf8');
  assert.match(waitMigration, /CREATE TABLE IF NOT EXISTS rpt_login_wait_events/);
  assert.match(waitMigration, /server_id INTEGER NOT NULL REFERENCES servers\(id\) ON DELETE CASCADE/);
  assert.match(waitMigration, /identity_id INTEGER NOT NULL REFERENCES player_identities\(id\) ON DELETE CASCADE/);
  assert.match(waitMigration, /UNIQUE \(server_id, source_file, source_line\)/,
    'RPT wait rescans must be idempotent per exact source line');
  assert.match(waitMigration, /CHECK \(wait_ended_at >= wait_started_at\)/);
  assert.match(
    waitMigration,
    /CREATE INDEX IF NOT EXISTS idx_player_sessions_server_logout_alt_lookup[\s\S]*ON player_sessions \(server_id, logout_at DESC\)[\s\S]*INCLUDE \(identity_id\)[\s\S]*WHERE logout_at IS NOT NULL/,
    'nearest preceding logout correlation requires a matching partial index'
  );

  const parserSource = fs.readFileSync(path.join(ROOT, 'routes/logParser.js'), 'utf8');
  assert.match(parserSource, /await parseRPTFileObservations\(logPath, rptDate, platform, \{ rootDir: baseDir \}\)/,
    'the production RPT scan must stream complete login-wait and telemetry chronology with absolute source lines');
  assert.match(parserSource, /saveRPTLoginWaitEvents\(db, serverId, allLoginWaitEvents, platform, serverContext\.id\)/,
    'the production RPT scan must persist login-wait evidence after identities exist');

  const html = fs.readFileSync(path.join(ROOT, 'public/server-players.html'), 'utf8');
  assert.doesNotMatch(html, /Auto-Ban Alts/);
  assert.match(html, /Possible Alt Review/);
  const browserSource = fs.readFileSync(path.join(ROOT, 'public/js/server-players.js'), 'utf8');
  assert.doesNotMatch(browserSource, /Ban All|data-alt-group|autoBanToggleBtn/);
  assert.match(browserSource, /data\.canReview \?/);
  assert.match(browserSource, /dataset\.reviewNotes/,
    'status changes must preserve existing moderator notes');
  assert.match(browserSource, /data-review-status/);

  // ── Alt auto-ban policy + execution (services/altAutoBanService.js) ────────
  // Detection above stays review-only; the enforcement policy below decides
  // when a definitive signal becomes an action. Every case asserts the
  // acceptance contract: definitive → auto-ban with audit; candidate-only →
  // never; kill-switch → off.

  function requireFresh(rel) {
    const resolved = require.resolve(rel);
    delete require.cache[resolved];
    return require(resolved);
  }

  const unlinkedAccounts = [
    { identity_id: 1, gamertag: 'Alpha', platform: 'xbox', linked_user_id: null, verification_method: null },
    { identity_id: 2, gamertag: 'Bravo', platform: 'xbox', linked_user_id: null, verification_method: null },
  ];
  const sameOwnerAccounts = [
    { identity_id: 1, gamertag: 'Alpha', platform: 'xbox', linked_user_id: 10, verification_method: 'emote_challenge' },
    { identity_id: 2, gamertag: 'Bravo', platform: 'xbox', linked_user_id: 10, verification_method: 'emote_challenge' },
  ];
  const definitiveBehaviorRows = [{
    identity_id_low: 1, identity_id_high: 2, event_count: 2, strict_count: 2, distinct_days: 2,
    strict_distinct_days: 2, direction_count: 1, strict_direction_count: 1, enforced_wait_count: 2,
    minimum_delay_seconds: 60, minimum_wait_duration_ms: 90000, maximum_wait_duration_ms: 120000,
  }];

  function makeAutoBanDb({
    accounts = unlinkedAccounts,
    behaviorRows = definitiveBehaviorRows,
    waitRows = [{ identity_id: 2, wait_count: 2 }],
    reviewRows = [],
    reviewId = null,
    capCount = 0,
    killSwitch = false,
    featureEnabled = true,
    exemptGamertags = [],
  } = {}) {
    const { encryptToken } = require('../utils/encryption');
    const tokenHash = encryptToken('test-token');
    return {
      state: { auditRows: [] },
      async transaction(cb) { return cb(this); },
      async get(sql, params) {
        if (sql.includes('FROM app_settings')) return killSwitch ? { value: 'true' } : null;
        if (sql.includes('FROM server_features sf')) return { enabled: featureEnabled ? 1 : 0 };
        if (sql.includes('FROM alt_auto_bans')) return { n: capCount };
        if (sql.includes('FOR NO KEY UPDATE')) return { token_hash: tokenHash };
        if (sql.includes('JOIN guild_tokens gt')) return { id: 44, platform_server_id: '9001', token_hash: tokenHash };
        if (sql.includes('FROM alt_ban_exemptions')) {
          const wanted = String(params?.[1] || '').toLowerCase();
          return exemptGamertags.some(g => g.toLowerCase() === wanted) ? { id: 1 } : null;
        }
        if (sql.includes('SELECT id FROM alt_account_reviews')) return reviewId ? { id: reviewId } : null;
        if (sql.includes('FROM player_gamertags')) {
          const account = accounts.find(item => item.identity_id === Number(params?.[0]));
          return account ? { gamertag: account.gamertag } : null;
        }
        return null;
      },
      async run(sql, params) {
        if (sql.includes('INSERT INTO alt_auto_bans')) this.state.auditRows.push({ sql, params });
        return { changes: 1 };
      },
      async all() { return []; },
      async query(sql) {
        if (sql.includes('AS wait_count')) return waitRows;
        if (sql.includes('AS event_count')) return behaviorRows;
        if (sql.includes('FROM alt_account_reviews aar')) return reviewRows;
        return accounts;
      },
    };
  }

  const shopStub = requireFresh('../services/shopFileService');
  const lockCalls = [];
  shopStub.acquireProviderMutationLock = async (db, serverId) => { lockCalls.push(serverId); };
  const journals = [];
  shopStub.createFileMutationJournal = () => {
    const journal = {
      uploads: [],
      async uploadFileToServer(psid, dir, filename, content) {
        journal.uploads.push({ psid, dir, filename, content });
      },
    };
    journals.push(journal);
    return journal;
  };
  const recoveryStub = requireFresh('../services/providerMutationRecoveryService');
  recoveryStub.prepareProviderMutation = async (db, details) => {
    recoveryStub.__prepared.push(details);
    return 999;
  };
  recoveryStub.__prepared = [];
  recoveryStub.updatePreparedProviderMutation = async (db, operationId, status) => {
    recoveryStub.__status.push(status);
  };
  recoveryStub.__status = [];
  recoveryStub.registerProviderMutationRollback = () => {};
  const realDownload = missionFileService.downloadFileFromServer;
  missionFileService.downloadFileFromServer = async () => 'Alpha\n';
  const realRawGameserver = nitradoService.getRawGameserver;
  nitradoService.getRawGameserver = async () => ({
    game: 'dayzxb',
    game_specific: { path: '/games/abc123/noftp/dayzxb' },
  });
  delete require.cache[require.resolve('../services/providerListMutationService')];
  const altAutoBan = requireFresh('../services/altAutoBanService');
  const { CONFIRMED_WAITS_REQUIRED, AUTO_BAN_DAILY_CAP } = altAutoBan;

  // Policy: a single confirmed wait stays review-only (2 correlated waits required)
  assert.strictEqual(CONFIRMED_WAITS_REQUIRED, 2, 'policy default: two correlated enforced waits');
  const singleWaitTargets = await altAutoBan.findAutoBanTargets(
    makeAutoBanDb({ waitRows: [{ identity_id: 2, wait_count: 1 }] }), 44);
  assert.deepStrictEqual(singleWaitTargets, [],
    'one confirmed enforced wait must stay in the review queue, not auto-ban');

  // Policy: waits on BOTH sides = shared-ownership pattern → review only
  const bothSidesTargets = await altAutoBan.findAutoBanTargets(
    makeAutoBanDb({ waitRows: [{ identity_id: 1, wait_count: 2 }, { identity_id: 2, wait_count: 2 }] }), 44);
  assert.deepStrictEqual(bothSidesTargets, [],
    'enforced waits observed on both sides must never pick an auto-ban target');

  // Policy: same verified Discord owner → the alt is legitimately owned
  const sameOwnerTargets = await altAutoBan.findAutoBanTargets(
    makeAutoBanDb({ accounts: sameOwnerAccounts }), 44);
  assert.deepStrictEqual(sameOwnerTargets, [],
    'pairs with a verified shared Discord owner must never auto-ban');

  // Policy: review-dismissed pairs are off-limits even with definitive evidence
  const dismissedTargets = await altAutoBan.findAutoBanTargets(
    makeAutoBanDb({ reviewRows: [{ identity_id_low: 1, identity_id_high: 2, status: 'dismissed', notes: 'Known siblings' }] }), 44);
  assert.deepStrictEqual(dismissedTargets, [],
    'a dismissed owner review must override definitive enforcement evidence');

  // Policy: exempted gamertags are never touched
  const exemptTargets = await altAutoBan.findAutoBanTargets(
    makeAutoBanDb({ exemptGamertags: ['Bravo'] }), 44);
  assert.deepStrictEqual(exemptTargets, [], 'exempted gamertags must never auto-ban');

  // Policy: behavioral-only candidate (likely, no enforced waits) never auto-bans:
  // three strict switches on two days is a 'likely' candidate with no wait
  // evidence at all — detection without the definitive signal.
  const likelyOnlyDb = makeAutoBanDb({
    waitRows: [],
    behaviorRows: [{
      identity_id_low: 1, identity_id_high: 2, event_count: 3, strict_count: 3, distinct_days: 2,
      strict_distinct_days: 2, direction_count: 2, strict_direction_count: 2, enforced_wait_count: 0,
      minimum_delay_seconds: 60,
    }],
  });
  const likelyOnlyTargets = await altAutoBan.findAutoBanTargets(likelyOnlyDb, 44);
  assert.deepStrictEqual(likelyOnlyTargets, [],
    'a likely candidate without enforced waits must never auto-ban');
  assert.strictEqual((await altAutoBan.evaluateAltAutoBan(likelyOnlyDb, 44)).banned.length, 0,
    'candidate-only evidence must never auto-ban');

  // Gate: kill switch halts the feature everywhere
  const killSwitched = await altAutoBan.evaluateAltAutoBan(makeAutoBanDb({ killSwitch: true }), 44);
  assert.deepStrictEqual(killSwitched.banned, []);
  assert.strictEqual(killSwitched.skipped, 'kill_switch',
    'the global kill switch must halt auto-ban even with the server toggle on');
  // Gate: per-server toggle off halts this server only
  const disabled = await altAutoBan.evaluateAltAutoBan(makeAutoBanDb({ featureEnabled: false }), 44);
  assert.deepStrictEqual(disabled.banned, []);
  assert.strictEqual(disabled.skipped, 'disabled');

  // Simulated definitive-alt flow: two enforced waits on Bravo → auto-ban
  {
    const flowDb = makeAutoBanDb({ reviewId: 77 });
    const summary = await altAutoBan.evaluateAltAutoBan(flowDb, 44);
    assert.deepStrictEqual(summary.banned, [{ gamertag: 'Bravo', identityId: 2 }],
      'the simulated definitive-alt flow must auto-ban the alt side');
    assert.deepStrictEqual(summary.skipped, []);

    // Ban file was edited through the provider-mutation journal
    assert.strictEqual(journals.length, 1, 'one provider mutation journal per auto-ban');
    const upload = journals[0].uploads[0];
    assert.strictEqual(upload.psid, '9001');
    assert.match(upload.dir, /\/games\/abc123\/noftp\/dayzxb\//);
    assert.strictEqual(upload.filename, 'ban.txt');
    assert.strictEqual(upload.content, 'Alpha\nBravo\n',
      'the ban file gains exactly the auto-banned gamertag');
    assert.deepStrictEqual(lockCalls, [44], 'the provider mutation lock must be taken per exact server');

    // Provider mutation was prepared and completed, attributed to the policy
    assert.strictEqual(recoveryStub.__prepared.length, 1);
    assert.strictEqual(recoveryStub.__prepared[0].serverId, 44);
    assert.strictEqual(recoveryStub.__prepared[0].triggeredBy, 'autoban:alt_policy');
    assert.deepStrictEqual(recoveryStub.__status, ['completed']);

    // Audit row: which signal, which candidate pair, which review row
    assert.strictEqual(flowDb.state.auditRows.length, 1, 'every auto-ban must write exactly one audit row');
    const auditParams = flowDb.state.auditRows[0].params;
    assert.deepStrictEqual([auditParams[0], auditParams[1], auditParams[2]], [44, 2, 'Bravo']);
    const auditEvidence = JSON.parse(auditParams[3]);
    assert.deepStrictEqual(auditEvidence.pair, [1, 2]);
    assert.deepStrictEqual(auditEvidence.waitsBySide, { 1: 0, 2: 2 });
    assert.strictEqual(auditEvidence.enforcedWaits, 2);
    assert.strictEqual(auditParams[4], 77, 'the audit row must reference the candidate review row');
    assert.strictEqual(auditParams[5], 'autoban:alt_policy');
  }

  // Already-banned gamertag: no file change, no audit row, no cap consumed
  {
    missionFileService.downloadFileFromServer = async () => 'Alpha\nBravo\n';
    const journalCountBefore = journals.length;
    const existsDb = makeAutoBanDb({ reviewId: 77 });
    const existsSummary = await altAutoBan.evaluateAltAutoBan(existsDb, 44);
    assert.deepStrictEqual(existsSummary.banned, []);
    assert.deepStrictEqual(existsSummary.skipped, [{ gamertag: 'Bravo', reason: 'already_banned' }]);
    assert.strictEqual(existsDb.state.auditRows.length, 0,
      'an already-banned gamertag must not produce an audit row');
    assert.strictEqual(journals.length, journalCountBefore,
      'an unchanged ban file must not be uploaded');
    missionFileService.downloadFileFromServer = realDownload;
  }

  // Daily cap: reached under the provider mutation lock → no upload, no audit row
  {
    missionFileService.downloadFileFromServer = async () => 'Alpha\n';
    const completedBefore = recoveryStub.__status.filter(s => s === 'completed').length;
    const journalCountBefore = journals.length;
    const cappedDb = makeAutoBanDb({ capCount: AUTO_BAN_DAILY_CAP, reviewId: 77 });
    const capSummary = await altAutoBan.evaluateAltAutoBan(cappedDb, 44);
    assert.deepStrictEqual(capSummary.banned, []);
    assert.deepStrictEqual(capSummary.skipped, [{ gamertag: 'Bravo', reason: 'AUTO_BAN_DAILY_CAP' }]);
    assert.strictEqual(cappedDb.state.auditRows.length, 0, 'a capped ban must not write an audit row');
    assert.strictEqual(journals.length, journalCountBefore,
      'a capped ban must not upload the ban file');
    assert.strictEqual(recoveryStub.__status.filter(s => s === 'completed').length, completedBefore,
      'a capped ban must not complete a provider mutation');
    missionFileService.downloadFileFromServer = realDownload;
    nitradoService.getRawGameserver = realRawGameserver;
  }

  console.log('Alt account candidate tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
