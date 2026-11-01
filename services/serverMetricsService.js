'use strict';

const { applyStaleness, DEFAULT_STALE_AFTER_MS, safeHealthMessage } = require('./serverHealthService');
const { buildScheduledLogSyncPlan } = require('../utils/logSyncScheduling');
const { loadPipelineStatuses, PIPELINES } = require('./pipelineStatusService');
const { sessionView } = require('./sessionStateService');

const PAGE_REFRESH_SECONDS = 30;
const BOT_STALE_AFTER_MS = 90 * 1000;
const SCHEDULE_OVERDUE_GRACE_MS = 60 * 1000;

function scheduleIsOverdue(nextRunAt, nowMs) {
  const nextRunMs = Date.parse(nextRunAt);
  return Number.isFinite(nextRunMs) && nowMs > nextRunMs + SCHEDULE_OVERDUE_GRACE_MS;
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function providerTimestampIso(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return iso(numeric < 1e12 ? numeric * 1000 : numeric);
  }
  return iso(value);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.round(number);
}

function parseAutomationSettings(row) {
  try {
    const value = typeof row?.auto_log_sync === 'string'
      ? JSON.parse(row.auto_log_sync)
      : row?.auto_log_sync;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function buildFullLogSyncStatus(rows, platformServerId, runtime, server, nowMs = Date.now()) {
  const candidates = (rows || []).flatMap(row => {
    const settings = parseAutomationSettings(row);
    if (!settings?.enabled || settings.autoScan !== true) return [];
    const plan = buildScheduledLogSyncPlan(settings);
    if (!plan.serverIds.includes(String(platformServerId))) return [];
    const intervalMinutes = Number(settings.interval || 15);
    const intervalSeconds = Math.round(
      (Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 15) * 60
    );
    const lastAttemptMs = settings.lastAttempt ? Date.parse(settings.lastAttempt) : NaN;
    const lastRunMs = settings.lastRun ? Date.parse(settings.lastRun) : NaN;
    const anchorMs = Math.max(
      Number.isFinite(lastAttemptMs) ? lastAttemptMs : 0,
      Number.isFinite(lastRunMs) ? lastRunMs : 0
    );
    return [{
      intervalSeconds,
      lastAttemptAt: Number.isFinite(lastAttemptMs) ? new Date(lastAttemptMs).toISOString() : null,
      lastSuccessAt: Number.isFinite(lastRunMs) ? new Date(lastRunMs).toISOString() : null,
      nextRunAt: anchorMs ? new Date(anchorMs + intervalSeconds * 1000).toISOString() : new Date(nowMs).toISOString(),
    }];
  }).sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));

  if (!candidates.length) {
    return {
      pipeline: PIPELINES.FULL_LOG_SYNC,
      enabled: false,
      state: 'disabled',
      intervalSeconds: null,
      running: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      completedAt: null,
      durationMs: null,
      nextRunAt: null,
      overdue: false,
      errorCode: null,
      counters: {},
      lastParseSuccessAt: iso(server?.last_sync_at),
      sourceObservedThrough: iso(server?.log_parse_watermark_at),
    };
  }

  const schedule = candidates[0];
  const attemptedAfterSuccess = schedule.lastAttemptAt &&
    (!schedule.lastSuccessAt || Date.parse(schedule.lastAttemptAt) > Date.parse(schedule.lastSuccessAt));
  const base = runtime || {
    pipeline: PIPELINES.FULL_LOG_SYNC,
    enabled: true,
    state: attemptedAfterSuccess ? 'degraded' : 'healthy',
    intervalSeconds: schedule.intervalSeconds,
    running: false,
    lastAttemptAt: schedule.lastAttemptAt,
    lastSuccessAt: schedule.lastSuccessAt,
    lastFailureAt: attemptedAfterSuccess ? schedule.lastAttemptAt : null,
    completedAt: schedule.lastSuccessAt,
    durationMs: null,
    nextRunAt: schedule.nextRunAt,
    overdue: scheduleIsOverdue(schedule.nextRunAt, nowMs),
    errorCode: attemptedAfterSuccess ? 'LAST_ATTEMPT_INCOMPLETE' : null,
    counters: {},
  };
  return {
    ...base,
    enabled: true,
    intervalSeconds: schedule.intervalSeconds,
    lastAttemptAt: base.lastAttemptAt || schedule.lastAttemptAt,
    lastSuccessAt: base.lastSuccessAt || schedule.lastSuccessAt,
    nextRunAt: base.running ? base.nextRunAt : schedule.nextRunAt,
    overdue: !base.running && scheduleIsOverdue(schedule.nextRunAt, nowMs),
    lastParseSuccessAt: iso(server?.last_sync_at),
    sourceObservedThrough: iso(server?.log_parse_watermark_at),
  };
}

function summarizeCeLoop(row) {
  const sampleCount = integer(row?.sample_count) || 0;
  if (!sampleCount) {
    return {
      sampleCount: 0,
      latestAt: null,
      latestDurationSeconds: null,
      averageDurationSeconds: null,
      p95DurationSeconds: null,
      maxDurationSeconds: null,
      latestCounts: { players: null, loot: null, infected: null, animals: null },
    };
  }
  return {
    sampleCount,
    latestAt: iso(row.latest_at),
    latestDurationSeconds: finiteNumber(row.latest_duration_seconds),
    averageDurationSeconds: finiteNumber(row.average_duration_seconds),
    p95DurationSeconds: finiteNumber(row.p95_duration_seconds),
    maxDurationSeconds: finiteNumber(row.max_duration_seconds),
    latestCounts: {
      players: integer(row.latest_players),
      loot: integer(row.latest_loot),
      infected: integer(row.latest_infected),
      animals: integer(row.latest_animals),
    },
  };
}

function healthComponent(row) {
  if (!row) return applyStaleness({
    state: 'unknown', detail: 'unknown', message: safeHealthMessage('unknown'), checkedAt: null,
  }, DEFAULT_STALE_AFTER_MS);
  return applyStaleness({
    state: row.state,
    detail: row.detail,
    message: safeHealthMessage(row.detail),
    checkedAt: row.checked_at,
    lastHealthyAt: row.last_healthy_at,
    errorCode: row.error_code || null,
  }, DEFAULT_STALE_AFTER_MS);
}

function botHealth(row, nowMs) {
  const heartbeat = iso(row?.last_heartbeat);
  const stale = !heartbeat || nowMs - Date.parse(heartbeat) > BOT_STALE_AFTER_MS;
  return {
    state: row?.status === 'online' && !stale ? 'healthy' : row ? 'degraded' : 'unknown',
    lastHeartbeatAt: heartbeat,
    websocketPingMs: integer(row?.websocket_ping_ms),
    uptimeSeconds: integer(row?.process_uptime_seconds),
    stale,
  };
}

function missingPipeline(pipeline, enabled, intervalSeconds, nowMs) {
  return {
    pipeline,
    enabled,
    state: enabled ? 'unknown' : 'disabled',
    intervalSeconds: enabled ? intervalSeconds : null,
    running: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    completedAt: null,
    durationMs: null,
    nextRunAt: enabled ? new Date(nowMs + intervalSeconds * 1000).toISOString() : null,
    overdue: false,
    errorCode: null,
    counters: {},
  };
}

function applyFeedQueueHealth(pipeline, queue, enabled) {
  const result = { ...pipeline, enabled, counters: queue };
  if (enabled && (queue.retrying > 0 || queue.failed > 0) && result.state !== 'failed') {
    result.state = 'degraded';
    result.errorCode = queue.failed > 0 ? 'FEED_DELIVERY_FAILED' : 'FEED_DELIVERY_RETRYING';
  }
  return result;
}

function overallState(components) {
  const states = components.map(component => component?.stale ? 'unknown' : component?.state || 'unknown');
  if (states.includes('failed') || states.includes('offline')) return 'critical';
  if (states.includes('degraded') || states.includes('unknown')) return 'degraded';
  return 'healthy';
}

async function loadServerOverview({
  db,
  authorization,
  tokenResolver,
  nitrado,
  now = () => new Date(),
  lowLatencyIntervalSeconds = 30,
  feedIntervalSeconds = 30,
}) {
  const generated = now();
  const generatedAt = generated.toISOString();
  const serverId = authorization.server.id;
  const guildId = authorization.guild.id;
  const server = await db.get(
    `SELECT id, guild_id, name, platform, platform_server_id, last_sync_at, log_parse_watermark_at
       FROM servers
      WHERE id = ? AND guild_id = ? AND status = 'active'`,
    [serverId, guildId]
  );
  if (!server) return null;

  const [healthRows, pipelineRows, automationRows, feed, bot, ceLoopRow, sessionRow] = await Promise.all([
    db.query(
      `SELECT component, state, detail, checked_at, last_healthy_at, error_code
         FROM server_health_status WHERE server_id = ? AND guild_id = ?`,
      [serverId, guildId]
    ),
    loadPipelineStatuses(db, serverId, generated.getTime()),
    db.query(
      `SELECT DISTINCT a.auto_log_sync
         FROM automation_settings a
        WHERE a.auto_log_sync IS NOT NULL
          AND (
            EXISTS (
              SELECT 1 FROM guild_roles gr
               WHERE gr.user_id = a.user_id AND gr.guild_id = ?
                 AND gr.role IN ('owner', 'admin')
            )
            OR EXISTS (
              SELECT 1 FROM server_role_assignments sra
               WHERE sra.user_id = a.user_id AND sra.server_id = ? AND sra.guild_id = ?
                 AND sra.role = 'admin' AND sra.status = 'active'
            )
          )`,
      [guildId, serverId, guildId]
    ),
    db.get(
      `SELECT
         EXISTS (SELECT 1 FROM discord_feeds WHERE server_id = ? AND enabled = 1) AS enabled,
         EXISTS (SELECT 1 FROM discord_feeds WHERE server_id = ? AND enabled = 1 AND feed_type = 'kill_feed') AS low_latency_enabled,
         COUNT(*) FILTER (WHERE processed = 0 AND attempt_count = 0)::int AS pending,
         COUNT(*) FILTER (WHERE processed = 0 AND attempt_count > 0)::int AS retrying,
         COUNT(*) FILTER (WHERE processed = 3)::int AS leased,
         COUNT(*) FILTER (WHERE processed = 2 AND COALESCE(last_error, '') <> 'feed disabled')::int AS failed,
         MIN(created_at) FILTER (WHERE processed IN (0, 3)) AS oldest_pending_at,
         MAX(processed_at) FILTER (WHERE processed = 1) AS last_delivery_at
       FROM feed_events WHERE server_id = ?`,
      [serverId, serverId, serverId]
    ),
    db.get(
      `SELECT status, last_heartbeat, websocket_ping_ms, process_uptime_seconds
         FROM bot_health WHERE id = 1`
    ),
    db.get(
      `SELECT COUNT(*)::int AS sample_count,
              MAX(observed_at) AS latest_at,
              (ARRAY_AGG(payload->>'durationSeconds' ORDER BY observed_at DESC, source_line DESC))[1] AS latest_duration_seconds,
              AVG((payload->>'durationSeconds')::double precision) AS average_duration_seconds,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY (payload->>'durationSeconds')::double precision) AS p95_duration_seconds,
              MAX((payload->>'durationSeconds')::double precision) AS max_duration_seconds,
              (ARRAY_AGG(payload->>'players' ORDER BY observed_at DESC, source_line DESC))[1] AS latest_players,
              (ARRAY_AGG(payload->>'loot' ORDER BY observed_at DESC, source_line DESC))[1] AS latest_loot,
              (ARRAY_AGG(payload->>'infected' ORDER BY observed_at DESC, source_line DESC))[1] AS latest_infected,
              (ARRAY_AGG(payload->>'animals' ORDER BY observed_at DESC, source_line DESC))[1] AS latest_animals
         FROM rpt_telemetry_events
        WHERE server_id = ? AND event_type = 'dayz.ce.loop' AND deleted_at IS NULL
          AND observed_at >= ?::timestamptz - INTERVAL '24 hours'`,
      [serverId, generatedAt]
    ),
    db.get(
      `SELECT session_started_at, next_restart_at, funded_until, funding_observed_at
         FROM server_session_state WHERE server_id = ?`,
      [serverId]
    ),
  ]);

  const healthByComponent = Object.fromEntries((healthRows || []).map(row => [row.component, healthComponent(row)]));
  const queue = {
    pending: integer(feed?.pending) || 0,
    retrying: integer(feed?.retrying) || 0,
    leased: integer(feed?.leased) || 0,
    failed: integer(feed?.failed) || 0,
    oldestPendingAt: iso(feed?.oldest_pending_at),
    lastDeliveryAt: iso(feed?.last_delivery_at),
  };
  const lowLatencyEnabled = Boolean(feed?.low_latency_enabled);
  const feedEnabled = Boolean(feed?.enabled);
  const lowLatency = pipelineRows[PIPELINES.LOW_LATENCY_ADM]
    || missingPipeline(PIPELINES.LOW_LATENCY_ADM, lowLatencyEnabled, lowLatencyIntervalSeconds, generated.getTime());
  const feedProcessorBase = pipelineRows[PIPELINES.FEED_PROCESSOR]
    || missingPipeline(PIPELINES.FEED_PROCESSOR, feedEnabled, feedIntervalSeconds, generated.getTime());
  const feedProcessor = applyFeedQueueHealth(feedProcessorBase, queue, feedEnabled);
  const fullLogSync = buildFullLogSyncStatus(
    automationRows,
    server.platform_server_id,
    pipelineRows[PIPELINES.FULL_LOG_SYNC],
    server,
    generated.getTime()
  );

  const warnings = [];
  let providerStatus = null;
  try {
    const token = await tokenResolver(db, serverId, guildId);
    if (!token) {
      warnings.push('NITRADO_TOKEN_UNAVAILABLE');
    } else {
      providerStatus = await nitrado.getServerStatus(token, server.platform_server_id);
    }
  } catch (_) {
    warnings.push('NITRADO_UNAVAILABLE');
  }
  const ceLoop = summarizeCeLoop(ceLoopRow);

  // Session uptime / time left / days funded (card t_c1de9125). Persisted by
  // the bot's status loop; the live provider read is the fallback for the
  // session start so a fresh deployment shows the anchor immediately.
  const session = sessionView(sessionRow || null, generated.getTime());
  if (!session.sessionStartedAt && providerStatus?.status === 'started') {
    session.sessionStartedAt = providerTimestampIso(providerStatus.lastStatusChange);
  }

  const components = {
    gameServer: healthByComponent.game_server || healthComponent(null),
    nitrado: healthByComponent.nitrado || healthComponent(null),
    discord: healthByComponent.discord || healthComponent(null),
  };
  const pipelines = { lowLatencyAdm: lowLatency, fullLogSync, feedProcessor };
  const dashboardBot = botHealth(bot, generated.getTime());
  const state = overallState([
    ...Object.values(components),
    ...Object.values(pipelines).filter(item => item.enabled),
    dashboardBot,
  ]);

  return {
    success: true,
    generatedAt,
    refresh: {
      recommendedIntervalSeconds: PAGE_REFRESH_SECONDS,
      nextRefreshAt: new Date(generated.getTime() + PAGE_REFRESH_SECONDS * 1000).toISOString(),
    },
    server: {
      id: Number(server.id),
      name: server.name,
      platform: server.platform,
      status: providerStatus?.status || components.gameServer.detail || 'unknown',
      statusChangedAt: providerTimestampIso(providerStatus?.lastStatusChange),
      map: providerStatus?.map || null,
      version: providerStatus?.version || null,
      players: {
        current: providerStatus ? integer(providerStatus.playerCurrent) : null,
        maximum: providerStatus ? integer(providerStatus.playerMax) : null,
      },
      settings: providerStatus ? {
        whitelist: Boolean(providerStatus.whitelist),
        crosshair: Boolean(providerStatus.crosshair),
        thirdPerson: Boolean(providerStatus.thirdPerson),
      } : null,
      observedAt: providerStatus ? generatedAt : components.gameServer.checkedAt || null,
    },
    health: { overall: state, components },
    session,
    pipelines,
    ceLoop,
    service: {
      api: { state: 'healthy', checkedAt: generatedAt },
      database: { state: 'healthy', checkedAt: generatedAt },
      bot: dashboardBot,
    },
    warnings,
  };
}

module.exports = {
  BOT_STALE_AFTER_MS,
  PAGE_REFRESH_SECONDS,
  applyFeedQueueHealth,
  buildFullLogSyncStatus,
  loadServerOverview,
  providerTimestampIso,
  summarizeCeLoop,
};
