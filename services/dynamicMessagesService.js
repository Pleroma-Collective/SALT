'use strict';

/**
 * Dynamic messages.xml — per-server generation of the DayZ messages file.
 *
 * Two managed blocks, marked by sentinel XML comments so regeneration
 * replaces them in place without touching any other <message> the admin
 * authored by hand (shutdown countdown, shop links, ...):
 *
 *   <!-- dynamic-messages:begin -->
 *   <message><repeat>30</repeat><text>MVP ...</text></message>
 *   <message><repeat>15</repeat><text>...server update...</text></message>
 *   <!-- dynamic-messages:end -->
 *
 * MVP is computed from real PVP kill data in kill_events (ADM log
 * ingestion); the window is the last 24h, reset to the last wipe when
 * that is more recent. Admin server-update messages come from the
 * server_features config (feature_name 'dynamic_messages').
 */

const crypto = require('crypto');
const path = require('path');
const xml2js = require('xml2js');

const FEATURE_NAME = 'dynamic_messages';
const BEGIN_SENTINEL = 'dynamic-messages:begin';
const END_SENTINEL = 'dynamic-messages:end';
const MVP_REPEAT_MINUTES = 30;
const DEFAULT_UPDATE_REPEAT_MINUTES = 15;
const MAX_UPDATE_REPEAT_MINUTES = 240;
const MAX_UPDATE_MESSAGE_LENGTH = 500;

function escapeXmlText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Compute the MVP of the current day/session for a server from
 * kill_events. PVP only: both killer and victim must have resolved
 * identities (zombie/animal kills carry no killer identity).
 * Ties: most recent kill first, then gamertag (deterministic).
 * Returns { gamertag, kills, lastKillAt, windowStart } or null.
 */
async function computeMvp(db, serverDbId) {
  const row = await db.get(
    `SELECT killer_gamertag AS gamertag,
            COUNT(*)::int AS kills,
            MAX(timestamp) AS last_kill,
            GREATEST(CURRENT_TIMESTAMP - INTERVAL '24 hours',
                     (SELECT last_wipe_at FROM server_wipe_info WHERE server_id = ?)) AS window_start
     FROM kill_events
     WHERE server_id = ?
       AND killer_gamertag IS NOT NULL
       AND killer_identity_id IS NOT NULL
       AND victim_identity_id IS NOT NULL
       AND timestamp >= GREATEST(CURRENT_TIMESTAMP - INTERVAL '24 hours',
                                 (SELECT last_wipe_at FROM server_wipe_info WHERE server_id = ?))
     GROUP BY killer_gamertag
     ORDER BY kills DESC, last_kill DESC, killer_gamertag ASC
     LIMIT 1`,
    [serverDbId, serverDbId, serverDbId]
  );
  if (!row) return null;
  return {
    gamertag: row.gamertag,
    kills: row.kills,
    lastKillAt: row.last_kill,
    windowStart: row.window_start,
  };
}

/**
 * Build the full messages.xml content by surgical text splice on the
 * current provider content: the managed sentinel block is replaced in
 * place (or appended before </messages>), everything else — other
 * <message> entries and comments — is preserved byte-for-byte.
 *
 * mvp: computeMvp() result or null. updateMessage: admin text ('' = none).
 * Returns { xml, preservedMessageCount, hadManagedBlock }.
 */
function buildMessagesXml(existingXml, { mvp = null, updateMessage = '', updateRepeatMinutes = DEFAULT_UPDATE_REPEAT_MINUTES }) {
  const beginRe = new RegExp(`<!--\\s*${BEGIN_SENTINEL}\\s*-->`);
  const endRe = new RegExp(`<!--\\s*${END_SENTINEL}\\s*-->`);
  const managed = renderManagedBlock(mvp, updateMessage, updateRepeatMinutes);

  let raw = typeof existingXml === 'string' ? existingXml : '';

  if (raw) {
    const beginMatch = beginRe.exec(raw);
    const endMatch = endRe.exec(raw);
    if (beginMatch && endMatch && endMatch.index > beginMatch.index) {
      return {
        ...spliceManagedBlock(raw, beginMatch.index, endMatch.index + endMatch[0].length, managed),
        hadManagedBlock: true,
      };
    }
    if (beginMatch || endMatch) {
      // Orphaned sentinel: previous managed block is corrupted. Regenerate
      // fresh; the pre-deploy backup keeps the previous file content.
      console.warn('[dynamic-messages] orphaned managed-block sentinel found; regenerating fresh');
      raw = '';
    }
  }

  if (!raw.trim()) {
    const xml = XML_DECL + '<messages>\n' + (managed ? managed + '\n' : '') + '</messages>\n';
    return { xml, preservedMessageCount: (xml.match(/<message[\s>]/g) || []).length, hadManagedBlock: false };
  }

  if (/^<messages\s*\/>\s*$/.test(raw.trim()) || !/<messages[\s>]/.test(raw) || !/<\/messages>\s*$/.test(raw)) {
    if (/^<messages\s*\/>\s*$/.test(raw.trim())) {
      const xml = XML_DECL + '<messages>\n' + (managed ? managed + '\n' : '') + '</messages>\n';
      return { xml, preservedMessageCount: 0, hadManagedBlock: false };
    }
    // Unrecognized shape (missing root or unclosed root): refuse to
    // splice into something we cannot verify.
    const error = new Error('Existing messages.xml has an unrecognized structure; reload and inspect before deploying');
    error.status = 409;
    throw error;
  }

  if (!managed) {
    // Nothing to manage and no managed block present: byte-identical no-op.
    return { xml: raw, preservedMessageCount: (raw.match(/<message[\s>]/g) || []).length, hadManagedBlock: false };
  }

  // Append the managed block right before the closing root tag.
  const closeIdx = raw.lastIndexOf('</messages>');
  return {
    ...spliceManagedBlock(raw, closeIdx, closeIdx, managed),
    hadManagedBlock: false,
  };
}

function spliceManagedBlock(raw, insertStart, insertEnd, managed) {
  // Strip the existing XML declaration if present; we always emit our own.
  const body = raw.replace(/^<\?xml[^>]*\?>\s*/, '');
  const bodyOffset = raw.length - body.length;
  const keep = body.slice(0, Math.max(0, insertStart - bodyOffset)).replace(/\s+$/, '');
  let tail = raw.slice(insertEnd);
  if (tail.startsWith('\n')) tail = tail.slice(1);
  if (tail && !tail.endsWith('\n')) tail += '\n';
  const xml = XML_DECL + keep + '\n' + (managed ? managed + '\n' : '') + tail;
  return { xml, preservedMessageCount: (xml.match(/<message[\s>]/g) || []).length };
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n';

function renderManagedBlock(mvp, updateMessage, updateRepeatMinutes) {
  const lines = [];
  if (mvp && mvp.gamertag) {
    lines.push(`  <message>`, `    <repeat>${MVP_REPEAT_MINUTES}</repeat>`,
      `    <text>${escapeXmlText(`MVP OF THE DAY: ${mvp.gamertag} (${mvp.kills} PVP kill${mvp.kills === 1 ? '' : 's'}, last 24h)`)}</text>`, `  </message>`);
  }
  const trimmedUpdate = String(updateMessage || '').trim();
  if (trimmedUpdate) {
    const repeat = Math.max(1, Math.min(MAX_UPDATE_REPEAT_MINUTES, Math.floor(Number(updateRepeatMinutes) || DEFAULT_UPDATE_REPEAT_MINUTES)));
    lines.push(`  <message>`, `    <repeat>${repeat}</repeat>`,
      `    <text>${escapeXmlText(trimmedUpdate.slice(0, MAX_UPDATE_MESSAGE_LENGTH))}</text>`, `  </message>`);
  }
  if (!lines.length) return '';
  return `  <!-- ${BEGIN_SENTINEL} -->\n` + lines.join('\n') + `\n  <!-- ${END_SENTINEL} -->`;
}

function renderMvpLine(mvp) {
  if (!mvp || !mvp.gamertag) return null;
  return `MVP of the day (last 24h): ${mvp.gamertag} — ${mvp.kills} PVP kill${mvp.kills === 1 ? '' : 's'}`;
}

/**
 * Read the per-server dynamic-messages config from server_features.
 * Returns a normalized config object (never null).
 */
async function loadConfig(db, serverDbId) {
  const row = await db.get(
    `SELECT enabled, config FROM server_features WHERE server_id = ? AND feature_name = ?`,
    [serverDbId, FEATURE_NAME]
  );
  const config = row?.config ? JSON.parse(row.config) : {};
  return {
    enabled: Boolean(row?.enabled),
    mvpEnabled: config.mvpEnabled !== false,
    updateMessage: typeof config.updateMessage === 'string' ? config.updateMessage : '',
    updateRepeatMinutes: Number.isFinite(config.updateRepeatMinutes) ? config.updateRepeatMinutes : DEFAULT_UPDATE_REPEAT_MINUTES,
    lastMvp: config.lastMvp || null,
    lastDeployedAt: config.lastDeployedAt || null,
    lastDeployedXmlHash: config.lastDeployedXmlHash || null,
  };
}

async function saveConfig(db, serverDbId, config, enabled) {
  await db.run(
    `INSERT INTO server_features (server_id, feature_name, enabled, config, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (server_id, feature_name) DO UPDATE SET
       enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP`,
    [serverDbId, FEATURE_NAME, enabled ? 1 : 0, JSON.stringify(config)]
  );
}

/**
 * Resolve the messages.xml location (relative to the mission folder) the
 * way the bot does: cfgeconomycore.xml declares it; fall back to
 * custom/messages.xml when the core file is missing or silent.
 */
async function resolveMessagesRelPath(fileService, platformServerId, token, missionBasePath, mission) {
  const CUSTOM_FALLBACK = 'custom/messages.xml';
  try {
    const cfgPath = `${missionBasePath}/${mission}/cfgeconomycore.xml`;
    const content = await fileService.downloadFileFromServer(platformServerId, cfgPath, token);
    if (!content) return CUSTOM_FALLBACK;
    const parsed = await xml2js.parseStringPromise(content.trim().replace(/[\r\n]+/g, '\n'), { explicitRoot: true });
    const ceEntries = Array.isArray(parsed.economycore?.ce) ? parsed.economycore.ce : [];
    for (const ce of ceEntries) {
      const folder = ce?.$?.folder || '';
      const files = Array.isArray(ce?.file) ? ce.file : [];
      for (const file of files) {
        if (file?.$?.type === 'messages') {
          const name = file.$?.name || 'messages.xml';
          const result = folder ? `${folder}/${name}` : name;
          return assertMessagesRelPath(result);
        }
      }
    }
  } catch (error) {
    if (error && error.status) throw error; // declared invalid path: fail loudly, never guess
    console.warn(`[dynamic-messages] cfgeconomycore.xml unreadable (${error.message}); using ${CUSTOM_FALLBACK}`);
  }
  return CUSTOM_FALLBACK;
}

function assertMessagesRelPath(relPath) {
  const segments = String(relPath).split('/');
  if (!relPath || segments.some(segment => !segment || segment === '.' || segment === '..') ||
      relPath.startsWith('/') || relPath.includes('\\') || relPath.includes('\0')) {
    throw Object.assign(new Error('cfgeconomycore declared an invalid messages path'), { status: 502 });
  }
  return segments.join('/');
}

/**
 * Generate and deploy the dynamic messages.xml for one server.
 *
 * ctx: { db, internalServerId, platformServerId, token, fileService,
 *        nitradoService, mvpEnabled, updateMessage, updateRepeatMinutes,
 *        triggeredBy }
 *
 * Reads the current file from the provider, rebuilds it (existing
 * messages preserved, managed block replaced), uploads only when the
 * content changed, and records deployment state in the config.
 */
async function deployDynamicMessages(ctx) {
  const { db, internalServerId, platformServerId, token, fileService, nitradoService, triggeredBy } = ctx;

  const gameserver = await nitradoService.getRawGameserver(token, platformServerId);
  const { resolveMissionBasePath } = require('../utils/dayzPlatform');
  const missionBasePath = resolveMissionBasePath(gameserver);
  const mission = gameserver?.settings?.config?.mission || gameserver?.query?.map;
  if (!mission) throw Object.assign(new Error('No active mission reported by the provider'), { status: 502 });

  const messagesRelPath = await resolveMessagesRelPath(fileService, platformServerId, token, missionBasePath, mission);
  const fullMessagesPath = `${missionBasePath}/${mission}/${messagesRelPath}`;

  const config = await loadConfig(db, internalServerId);
  const mvpEnabled = ctx.mvpEnabled !== undefined ? ctx.mvpEnabled : config.mvpEnabled;
  const mvp = mvpEnabled ? await computeMvp(db, internalServerId) : null;

  const existingXml = await fileService.downloadFileFromServer(platformServerId, fullMessagesPath, token);
  const { xml } = await buildMessagesXml(existingXml || '', {
    mvp,
    updateMessage: ctx.updateMessage !== undefined ? ctx.updateMessage : config.updateMessage,
    updateRepeatMinutes: ctx.updateRepeatMinutes !== undefined ? ctx.updateRepeatMinutes : config.updateRepeatMinutes,
  });
  const xmlHash = crypto.createHash('sha256').update(xml).digest('hex');

  if (config.lastDeployedXmlHash === xmlHash) {
    return { deployed: false, unchanged: true, messagesPath: messagesRelPath, mvp, mvpLine: renderMvpLine(mvp) };
  }

  backupPreviousMessagesXml(platformServerId, fileNameOf(messagesRelPath), existingXml);

  const { directory, fileName } = splitPath(fullMessagesPath);
  await fileService.uploadFileToServer(platformServerId, directory, fileName, xml, token);

  const nextConfig = {
    mvpEnabled: config.mvpEnabled,
    updateMessage: ctx.updateMessage !== undefined ? ctx.updateMessage : config.updateMessage,
    updateRepeatMinutes: ctx.updateRepeatMinutes !== undefined ? ctx.updateRepeatMinutes : config.updateRepeatMinutes,
    lastMvp: mvp ? { gamertag: mvp.gamertag, kills: mvp.kills, computedAt: new Date().toISOString() } : null,
    lastDeployedAt: new Date().toISOString(),
    lastDeployedXmlHash: xmlHash,
  };
  await saveConfig(db, internalServerId, nextConfig, true);
  console.log(`✅ [dynamic-messages] deployed ${fileName} for server ${platformServerId} (trigger: ${triggeredBy || 'unknown'}); MVP=${mvp ? mvp.gamertag : 'none'}`);

  return { deployed: true, unchanged: false, messagesPath: messagesRelPath, mvp, mvpLine: renderMvpLine(mvp), hash: xmlHash };
}

function splitPath(fullPath) {
  const idx = fullPath.lastIndexOf('/');
  return { directory: fullPath.slice(0, idx), fileName: fullPath.slice(idx + 1) };
}

function fileNameOf(relPath) {
  return String(relPath).split('/').pop();
}

/**
 * Keep the previous provider content on disk before an overwrite, mirroring
 * the mission editor's backup guard (data/backups). Best-effort: a backup
 * failure must not block the deploy.
 */
function backupPreviousMessagesXml(platformServerId, fileName, previousContent) {
  if (!previousContent) return;
  try {
    const { ensureContainedDirectorySync, normalizeStorageIdentifier, writeContainedFileSync } = require('../utils/safePath');
    const baseDir = path.join(__dirname, '..', 'data', 'backups', 'dynamic-messages');
    const serverDir = normalizeStorageIdentifier(String(platformServerId), 'server storage identifier');
    ensureContainedDirectorySync(baseDir, `server_${serverDir}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeContainedFileSync(baseDir, path.join(`server_${serverDir}`, `${fileName.replace(/[\\/]/g, '_')}.${stamp}.backup`), previousContent, 'utf8');
  } catch (error) {
    console.warn(`[dynamic-messages] pre-deploy backup failed for ${platformServerId}:`, error.message);
  }
}

module.exports = {
  FEATURE_NAME,
  BEGIN_SENTINEL,
  END_SENTINEL,
  DEFAULT_UPDATE_REPEAT_MINUTES,
  MAX_UPDATE_REPEAT_MINUTES,
  MAX_UPDATE_MESSAGE_LENGTH,
  escapeXmlText,
  computeMvp,
  buildMessagesXml,
  renderMvpLine,
  loadConfig,
  saveConfig,
  resolveMessagesRelPath,
  deployDynamicMessages,
};
