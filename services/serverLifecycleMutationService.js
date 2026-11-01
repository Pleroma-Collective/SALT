'use strict';

/*
 * services/serverLifecycleMutationService.js
 *
 * Durable provider mutations for server lifecycle actions (start/stop/restart).
 * The server's online state is journaled like any other provider resource:
 * the pre-action state is snapshotted into the provider_mutations journal
 * before the Nitrado call, and rollback/recovery restore that exact state.
 */

const nitradoService = require('./nitradoService');
const { resolveProviderContext } = require('./providerSettingMutationService');
const { CAPABILITIES, authorizeServerMutation } = require('./authorizationService');
const { acquireProviderMutationLock } = require('./shopFileService');
const {
  prepareProviderMutation,
  registerProviderMutationRollback,
  updatePreparedProviderMutation,
} = require('./providerMutationRecoveryService');

const LIFECYCLE_STATE_PATH = '/server-lifecycle/state.json';
const DEFAULT_SETTLE_TIMEOUT_MS = 45000;
const DEFAULT_SETTLE_POLL_MS = 5000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Nitrado reports 'started' while running and 'restarting' while coming back. */
function isOnlineStatus(status) {
  return status === 'started' || status === 'restarting';
}

function stateEnvelope(online) {
  return JSON.stringify({ online: Boolean(online) });
}

function parseStateEnvelope(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    throw new Error('Invalid server lifecycle snapshot');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 || typeof parsed.online !== 'boolean') {
    throw new Error('Invalid server lifecycle snapshot');
  }
  return parsed;
}

function assertLifecycleStatePath(resourcePath) {
  if (String(resourcePath) !== LIFECYCLE_STATE_PATH) {
    throw new Error('Invalid server lifecycle recovery path');
  }
}

function preconditionError(message) {
  const error = new Error(message);
  error.code = 'LIFECYCLE_PRECONDITION';
  error.status = 409;
  return error;
}

/**
 * File-shaped adapter over the gameserver online state so lifecycle
 * operations reuse the durable journal, rollback, and reconciliation
 * machinery built for provider file mutations.
 */
function createServerLifecycleFileService(provider = nitradoService, settle = {}) {
  const settleTimeoutMs = settle.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const settlePollMs = settle.pollMs ?? DEFAULT_SETTLE_POLL_MS;
  return {
    async downloadFileFromServer(platformServerId, resourcePath, token) {
      assertLifecycleStatePath(resourcePath);
      const status = await provider.getServerStatus(token, platformServerId);
      return stateEnvelope(isOnlineStatus(status.status));
    },
    async uploadFileToServer(platformServerId, directory, filename, content, token) {
      const resourcePath = `${String(directory).replace(/\/$/, '')}/${filename}`;
      assertLifecycleStatePath(resourcePath);
      await this.ensureState(platformServerId, parseStateEnvelope(content), token);
      const verified = await this.downloadFileFromServer(platformServerId, resourcePath, token);
      if (verified !== content) throw new Error('Server lifecycle state verification failed');
    },
    async deleteFileFromServer() {
      throw new Error('Server lifecycle recovery cannot delete state');
    },
    /**
     * Drive the provider toward the target state. Issues the start/stop
     * control call at most once (allowControl), then polls until the live
     * status settles or the window expires.
     */
    async ensureState(platformServerId, target, token, { allowControl = true } = {}) {
      const deadline = Date.now() + settleTimeoutMs;
      let controlIssued = false;
      for (;;) {
        const status = await provider.getServerStatus(token, platformServerId);
        if (isOnlineStatus(status.status) === target.online) return;
        if (allowControl && !controlIssued) {
          await provider.controlServer(token, platformServerId, target.online ? 'start' : 'stop');
          controlIssued = true;
        }
        if (Date.now() + settlePollMs > deadline) {
          throw new Error('Server state did not settle within the mutation window');
        }
        await sleep(settlePollMs);
      }
    },
  };
}

async function controlServerLifecycle({
  db,
  internalServerId,
  expectedPlatformServerId,
  actor,
  action,
  settle = {},
  triggeredBy = null,
}) {
  if (!['restart', 'start', 'stop'].includes(action)) {
    const error = new Error(`Unsupported server lifecycle action: ${action}`);
    error.status = 400;
    throw error;
  }
  if (!db || typeof db.transaction !== 'function') {
    throw new Error('Server lifecycle mutations require a database transaction');
  }
  if (!actor?.id) throw new Error('Server lifecycle mutation actor is required');
  const numericServerId = Number(internalServerId);
  if (!Number.isSafeInteger(numericServerId) || numericServerId <= 0) {
    throw new Error('Invalid canonical server ID');
  }

  return db.transaction(async transactionDb => {
    await acquireProviderMutationLock(transactionDb, numericServerId);
    const authorization = await authorizeServerMutation(
      transactionDb, actor, numericServerId, CAPABILITIES.NITRADO_MANAGE
    );
    if (!authorization || Number(authorization.server.id) !== numericServerId) {
      const error = new Error('Server lifecycle authority was revoked');
      error.code = 'SERVER_AUTHORIZATION_MISMATCH';
      error.status = 403;
      throw error;
    }
    const context = await resolveProviderContext(
      transactionDb, numericServerId, expectedPlatformServerId, null
    );
    const fileService = createServerLifecycleFileService(nitradoService, settle);
    const status = await nitradoService.getServerStatus(context.token, context.platformServerId);
    if (status.status === 'suspended') {
      const error = new Error('This server is suspended; lifecycle controls are unavailable');
      error.code = 'LIFECYCLE_SUSPENDED';
      error.status = 409;
      throw error;
    }
    const preImageOnline = isOnlineStatus(status.status);
    if (action === 'stop' && !preImageOnline) throw preconditionError('Server is already stopped');
    if (action === 'start' && preImageOnline) throw preconditionError('Server is already running');
    if (action === 'restart' && !preImageOnline) throw preconditionError('Server is not running; start it first');

    const operationId = await prepareProviderMutation(db, {
      serverId: numericServerId,
      providerServiceId: context.platformServerId,
      workflow: 'server_lifecycle',
      action,
      // context pair must both be NULL: provider_mutations_check requires
      // (context_type IS NULL) = (context_id IS NULL) — workflow carries the type.
      plan: { filePaths: [LIFECYCLE_STATE_PATH] },
      snapshots: new Map([[LIFECYCLE_STATE_PATH, stateEnvelope(preImageOnline)]]),
      triggeredBy: triggeredBy || `user:${actor.id}`,
    });
    const rollbackJournal = {
      rolledBack: false,
      async rollback() {
        if (this.rolledBack) return;
        this.rolledBack = true;
        await fileService.ensureState(context.platformServerId, { online: preImageOnline }, context.token);
      },
    };
    registerProviderMutationRollback(transactionDb, { operationId, journal: rollbackJournal });

    if (action === 'restart') {
      await nitradoService.controlServer(context.token, context.platformServerId, 'restart');
      // Verification only: a stuck restart is compensated by restoring the
      // pre-action online state through the rollback journal below.
      await fileService.ensureState(context.platformServerId, { online: true }, context.token, { allowControl: false });
    } else {
      await fileService.ensureState(context.platformServerId, { online: action === 'start' }, context.token);
    }

    await updatePreparedProviderMutation(transactionDb, operationId, 'completed');
    return { operationId: String(operationId), message: `${action} initiated` };
  });
}

module.exports = {
  LIFECYCLE_STATE_PATH,
  createServerLifecycleFileService,
  controlServerLifecycle,
  isOnlineStatus,
  parseStateEnvelope,
  stateEnvelope,
};
