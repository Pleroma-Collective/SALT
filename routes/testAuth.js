'use strict';
/**
 * Dev-only test-login backdoor for the LOCAL testing mode.
 *
 * Lets automated + manual testing obtain a real, persistent admin session
 * without walking the Discord OAuth flow. It issues a genuine `connect.sid`
 * session (via passport req.login) for a synthetic test-admin user, so every
 * auth/role/CSRF check downstream behaves exactly as it would for a real
 * logged-in admin.
 *
 * SECURITY — this must never be live outside the local stack:
 *   1. It is only MOUNTED when DEPLOYMENT_MODE=local && NODE_ENV!=production
 *      (see the conditional in src/app/registerRoutes.js).
 *   2. Even if that guard regressed, the handler re-checks the environment per
 *      request (localTestingEnabled) and 404s.
 *   3. The caller must present ?token= matching process.env.TEST_ADMIN_TOKEN
 *      (>=16 chars), which local:setup generates and is never set in prod.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// Fixed synthetic identity for the local test admin. Kept off any real Discord
// snowflake range so it can never collide with a real user row.
const TEST_DISCORD_ID = '0000000000000000001';
const TEST_USERNAME = 'Local Test Admin';

function localTestingEnabled() {
  return process.env.DEPLOYMENT_MODE === 'local'
    && process.env.NODE_ENV !== 'production'
    && typeof process.env.TEST_ADMIN_TOKEN === 'string'
    && process.env.TEST_ADMIN_TOKEN.length >= 16;
}

/**
 * GET /auth/test-login?token=<TEST_ADMIN_TOKEN>
 * Ensures the synthetic test admin exists (and is admin) then req.login()s as
 * it, setting the real session cookie. Responds with the resolved user.
 */
router.get('/', async (req, res) => {
  if (!localTestingEnabled()) {
    return res.status(404).send('Not found');
  }

  const provided = req.query.token;
  if (typeof provided !== 'string' || provided.length === 0) {
    return res.status(403).json({ ok: false, error: 'missing test token' });
  }
  // Constant-time compare so a wrong token is not distinguishable by timing.
  const expected = Buffer.from(process.env.TEST_ADMIN_TOKEN);
  const got = Buffer.from(provided);
  const valid = got.length === expected.length
    && crypto.timingSafeEqual(got, expected);
  if (!valid) {
    return res.status(403).json({ ok: false, error: 'invalid test token' });
  }

  const db = req.app.locals.db;
  if (!db) {
    return res.status(500).json({ ok: false, error: 'no db on app.locals' });
  }

  try {
    let user = await db.get('SELECT * FROM users WHERE discord_id = ?', [TEST_DISCORD_ID]);
    if (!user) {
      const id = await db.insert('users', {
        discord_id: TEST_DISCORD_ID,
        username: TEST_USERNAME,
        email: 'local-test-admin@invalid',
        is_admin: 1,
        platform_role: 'dashboard_admin',
      });
      user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    } else {
      // Keep the synthetic admin authoritative even if a prior state drifted.
      await db.run(
        'UPDATE users SET is_admin = 1, platform_role = ? WHERE id = ?',
        ['dashboard_admin', user.id]
      );
      user = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
    }

    if (!user) {
      return res.status(500).json({ ok: false, error: 'test admin could not be resolved' });
    }

    req.login(user, (loginErr) => {
      if (loginErr) {
        return res.status(500).json({ ok: false, error: 'login failed', detail: loginErr.message });
      }
      return res.json({
        ok: true,
        mode: 'local-testing',
        sessionCookie: 'connect.sid',
        user: {
          id: user.id,
          username: user.username,
          discord_id: user.discord_id,
          platform_role: user.platform_role,
          is_admin: user.is_admin,
        },
      });
    });
  } catch (err) {
    console.error('❌ test-login error:', err);
    return res.status(500).json({ ok: false, error: 'test-login failed', detail: err.message });
  }
});

module.exports = router;
module.exports.localTestingEnabled = localTestingEnabled;
