'use strict';

// Startup self-check contract: verifyAllTokens() must flag guilds whose stored
// token was encrypted with a DIFFERENT ENCRYPTION_KEY (bogus-key case), return
// the failing guild ids, and never surface a token value in the returned list
// or in any console output. No Discord, provider, environment or DB access.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// encryption.js reads ENCRYPTION_KEY at require time; set it before loading.
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
const { verifyAllTokens } = require('../utils/guildTokens');

function encWithKey(hexKey, token) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(hexKey, 'hex'), iv);
  return iv.toString('hex') + ':' + cipher.update(token, 'utf8', 'hex') + cipher.final('hex');
}

function captureConsole() {
  const captured = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => captured.push(a.join(' '));
  return {
    captured,
    restore: () => { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; },
  };
}

(async () => {
  const GOOD_KEY = 'a'.repeat(64);
  const BOGUS_KEY = 'b'.repeat(64);
  const goodHash = encWithKey(GOOD_KEY, 'ntr-good-token-value');
  const badHash = encWithKey(BOGUS_KEY, 'ntr-bogus-token-value');

  // 1. Bogus-key token is flagged; good token and null-hash rows are not.
  {
    const rows = [
      { token_hash: goodHash, discord_guild_id: '111', id: 1 },
      { token_hash: badHash, discord_guild_id: '222', id: 2 },
      { token_hash: badHash, discord_guild_id: '222', id: 3 }, // same guild, second token
      { token_hash: null, discord_guild_id: '333', id: 4 },
    ];
    const db = { all: async () => rows };
    const { captured, restore } = captureConsole();
    let failing;
    try {
      failing = await verifyAllTokens(db);
    } finally {
      restore();
    }
    assert.deepEqual(failing, ['222']); // one entry per failing guild, deduped
    const out = captured.join('\n');
    assert(!out.includes('ntr-good-token-value'), 'token value leaked into logs');
    assert(!out.includes('ntr-bogus-token-value'), 'token value leaked into logs');
    assert(/⚠️.*\[TOKEN-VERIFY\].*222/.test(out), 'loud warning with guild id missing: ' + out);
  }

  // 2. Missing discord_guild_id falls back to guild#<id>, still no token value.
  {
    const rows = [{ token_hash: badHash, discord_guild_id: null, id: 42 }];
    const db = { all: async () => rows };
    const { captured, restore } = captureConsole();
    let failing;
    try {
      failing = await verifyAllTokens(db);
    } finally {
      restore();
    }
    assert.deepEqual(failing, ['guild#42']);
    assert(!captured.join('\n').includes('ntr-bogus-token-value'));
  }

  // 3. All good -> empty list, success line, no warning.
  {
    const rows = [{ token_hash: goodHash, discord_guild_id: '111', id: 1 }];
    const db = { all: async () => rows };
    const { captured, restore } = captureConsole();
    let failing;
    try {
      failing = await verifyAllTokens(db);
    } finally {
      restore();
    }
    assert.deepEqual(failing, []);
    assert(captured.some((l) => l.includes('✅') && l.includes('decrypt OK')));
    assert(!captured.some((l) => l.includes('⚠️')));
  }

  // 4. Corrupt (non-iv:hex) hash is flagged, not thrown.
  {
    const rows = [{ token_hash: 'not-an-encrypted-token', discord_guild_id: '555', id: 5 }];
    const db = { all: async () => rows };
    const { captured, restore } = captureConsole();
    let failing;
    try {
      failing = await verifyAllTokens(db);
    } finally {
      restore();
    }
    assert.deepEqual(failing, ['555']);
    assert(!captured.join('\n').includes('not-an-encrypted-token'));
  }

  // 5. DB failure propagates (caught by the .catch in server.js) — never a token.
  {
    const db = { all: async () => { throw new Error('db down'); } };
    const { captured, restore } = captureConsole();
    let threw = false;
    try {
      await verifyAllTokens(db);
    } catch (err) {
      threw = true;
      assert.match(err.message, /db down/);
    } finally {
      restore();
    }
    assert(threw, 'db failure should reject so server.js .catch can handle it');
    assert(!captured.join('\n').includes('ntr-'));
  }

  console.log('✅ guild-token-verify-test: all checks passed');
})().catch((err) => {
  console.error('❌ guild-token-verify-test failed:', err);
  process.exit(1);
});
