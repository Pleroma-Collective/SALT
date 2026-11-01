const express = require('express');
const router = express.Router();
const dynamicMessagesService = require('../services/dynamicMessagesService');
const missionFileService = require('../services/missionFileService');
const nitradoService = require('../services/nitradoService');
const { ensureAuthenticated } = require('../middleware/auth');
const { getGuildTokenForExactServer } = require('../utils/guildTokens');
const {
  CAPABILITIES,
  authorizePlatformServer,
  authorizePlatformServerMutation,
} = require('../services/authorizationService');

async function getServerAccessContext(db, user, platformServerId, authorize = authorizePlatformServer) {
  const authorization = await authorize(db, user, platformServerId, CAPABILITIES.SERVER_MANAGE);
  if (!authorization) return null;
  return {
    serverDbId: authorization.server.id,
    platformServerId: authorization.server.platformServerId,
    guildId: authorization.guild.id,
  };
}

async function requireAccess(req, res, platformServerId, mutation = false) {
  const context = await getServerAccessContext(
    req.app.locals.db,
    req.user,
    platformServerId,
    mutation ? authorizePlatformServerMutation : authorizePlatformServer
  );
  if (!context) {
    res.status(404).json({ success: false, error: 'Server not found' });
    return null;
  }
  return context;
}

// GET current MVP + config + preview block for a server's dynamic messages
router.get('/dynamic-messages/:serverId', ensureAuthenticated, async (req, res) => {
  const { serverId } = req.params;
  try {
    const access = await requireAccess(req, res, serverId);
    if (!access) return;
    const db = req.app.locals.db;
    const [mvp, config] = await Promise.all([
      dynamicMessagesService.computeMvp(db, access.serverDbId),
      dynamicMessagesService.loadConfig(db, access.serverDbId),
    ]);
    res.json({
      success: true,
      mvp,
      mvpLine: dynamicMessagesService.renderMvpLine(mvp),
      config,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT admin-settable server-update message + dynamic message settings
router.put('/dynamic-messages/:serverId', ensureAuthenticated, async (req, res) => {
  const { serverId } = req.params;
  const { updateMessage, updateRepeatMinutes, mvpEnabled } = req.body || {};

  if (typeof updateMessage !== 'string' || updateMessage.length > dynamicMessagesService.MAX_UPDATE_MESSAGE_LENGTH) {
    return res.status(400).json({
      success: false,
      error: `updateMessage must be a string of at most ${dynamicMessagesService.MAX_UPDATE_MESSAGE_LENGTH} characters`,
    });
  }
  const repeat = Number(updateRepeatMinutes);
  if (updateRepeatMinutes !== undefined && (!Number.isInteger(repeat) || repeat < 1 || repeat > dynamicMessagesService.MAX_UPDATE_REPEAT_MINUTES)) {
    return res.status(400).json({
      success: false,
      error: `updateRepeatMinutes must be an integer 1-${dynamicMessagesService.MAX_UPDATE_REPEAT_MINUTES}`,
    });
  }
  if (mvpEnabled !== undefined && typeof mvpEnabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'mvpEnabled must be a boolean' });
  }

  try {
    const access = await requireAccess(req, res, serverId, true);
    if (!access) return;
    const db = req.app.locals.db;
    const current = await dynamicMessagesService.loadConfig(db, access.serverDbId);
    const next = {
      ...current,
      mvpEnabled: mvpEnabled !== undefined ? mvpEnabled : current.mvpEnabled,
      updateMessage: updateMessage !== undefined ? updateMessage.trim() : current.updateMessage,
      updateRepeatMinutes: updateRepeatMinutes !== undefined ? repeat : current.updateRepeatMinutes,
    };
    // Any explicit admin edit re-activates the feature so the scheduler
    // picks the server up on its next pass.
    await dynamicMessagesService.saveConfig(db, access.serverDbId, next, true);
    res.json({ success: true, config: next });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST regenerate messages.xml from kill data + admin message, write to server
router.post('/dynamic-messages/:serverId/deploy', ensureAuthenticated, async (req, res) => {
  const { serverId } = req.params;
  const { updateMessage, updateRepeatMinutes, mvpEnabled } = req.body || {};

  if (typeof updateMessage !== 'string' || updateMessage.length > dynamicMessagesService.MAX_UPDATE_MESSAGE_LENGTH) {
    return res.status(400).json({
      success: false,
      error: `updateMessage must be a string of at most ${dynamicMessagesService.MAX_UPDATE_MESSAGE_LENGTH} characters`,
    });
  }
  const repeat = Number(updateRepeatMinutes);
  if (updateRepeatMinutes !== undefined && (!Number.isInteger(repeat) || repeat < 1 || repeat > dynamicMessagesService.MAX_UPDATE_REPEAT_MINUTES)) {
    return res.status(400).json({
      success: false,
      error: `updateRepeatMinutes must be an integer 1-${dynamicMessagesService.MAX_UPDATE_REPEAT_MINUTES}`,
    });
  }
  if (mvpEnabled !== undefined && typeof mvpEnabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'mvpEnabled must be a boolean' });
  }

  try {
    const access = await requireAccess(req, res, serverId, true);
    if (!access) return;
    const db = req.app.locals.db;
    const token = await getGuildTokenForExactServer(db, access.serverDbId, access.guildId);
    if (!token) {
      return res.status(409).json({ success: false, error: 'No Nitrado token configured for this server' });
    }
    const result = await dynamicMessagesService.deployDynamicMessages({
      db,
      internalServerId: access.serverDbId,
      platformServerId: access.platformServerId,
      token,
      fileService: missionFileService,
      nitradoService,
      updateMessage: updateMessage !== undefined ? updateMessage.trim() : undefined,
      updateRepeatMinutes: updateRepeatMinutes !== undefined ? repeat : undefined,
      mvpEnabled: mvpEnabled !== undefined ? mvpEnabled : undefined,
      triggeredBy: `user:${req.user.id}`,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error.status || 502;
    res.status(status < 500 ? status : 502).json({
      success: false,
      error: status < 500 ? error.message : 'Dynamic messages deploy failed',
    });
  }
});

module.exports = router;
