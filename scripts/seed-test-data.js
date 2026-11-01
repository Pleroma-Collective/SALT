#!/usr/bin/env node
'use strict';
/**
 * Seed the LOCAL testing DB with a small, deterministic fixture set so the
 * dashboard can be exercised without depending on whatever data happens to be
 * in the local postgres. Idempotent: every row is keyed by a stable
 * discord_guild_id / discord_id and left untouched if it already exists.
 *
 *   npm run local:seed
 *   # or: node scripts/seed-test-data.js
 *
 * Creates a synthetic test admin + three named test guilds (approved / disabled
 * / pending), a server + owner role on the approved one. The test admin is the
 * same identity that /auth/test-login logs you in as.
 */
const { localHostEnv } = require('./local-host-env');
Object.assign(process.env, localHostEnv());

const { initializeDatabase, closeDatabase } = require('../db/abstraction');

const TEST_DISCORD_ID = '0000000000000000001';

const FIXTURES = [
  {
    discord_guild_id: '9900000000000000001',
    name: 'LOCAL TEST Approved',
    status: 'approved',
    server: { name: 'LOCAL TEST Server A', platform: 'nitrado', platform_server_id: '999000001' },
  },
  {
    discord_guild_id: '9900000000000000002',
    name: 'LOCAL TEST Disabled',
    status: 'disabled',
    server: null,
  },
  {
    discord_guild_id: '9900000000000000003',
    name: 'LOCAL TEST Pending',
    status: 'pending',
    server: null,
  },
];

async function ensureTestAdmin(db) {
  let user = await db.get('SELECT id FROM users WHERE discord_id = ?', [TEST_DISCORD_ID]);
  if (!user) {
    const id = await db.insert('users', {
      discord_id: TEST_DISCORD_ID,
      username: 'Local Test Admin',
      email: 'local-test-admin@invalid',
      is_admin: 1,
      platform_role: 'dashboard_admin',
    });
    console.log(`  + created test admin user id=${id}`);
    return id;
  }
  await db.run('UPDATE users SET is_admin = 1, platform_role = ? WHERE id = ?', ['dashboard_admin', user.id]);
  console.log(`  ~ refreshed test admin user id=${user.id}`);
  return user.id;
}

async function ensureGuild(db, fx, adminUserId) {
  let guild = await db.get('SELECT id FROM guilds WHERE discord_guild_id = ?', [fx.discord_guild_id]);
  if (!guild) {
    const id = await db.insert('guilds', {
      discord_guild_id: fx.discord_guild_id,
      name: fx.name,
      status: fx.status,
    });
    guild = { id };
    console.log(`  + created guild "${fx.name}" id=${id} (${fx.status})`);
  } else {
    await db.run('UPDATE guilds SET status = ? WHERE id = ?', [fx.status, guild.id]);
    console.log(`  ~ refreshed guild "${fx.name}" id=${guild.id} (${fx.status})`);
  }

  if (fx.server) {
    const existing = await db.get(
      'SELECT id FROM servers WHERE guild_id = ? AND platform_server_id = ?',
      [guild.id, fx.server.platform_server_id]
    );
    if (!existing) {
      const sid = await db.insert('servers', {
        guild_id: guild.id,
        name: fx.server.name,
        platform: fx.server.platform,
        platform_server_id: fx.server.platform_server_id,
        status: 'active',
      });
      console.log(`    + created server "${fx.server.name}" id=${sid}`);
    }
  }

  const role = await db.get('SELECT id FROM guild_roles WHERE guild_id = ? AND user_id = ?', [guild.id, adminUserId]);
  if (!role) {
    await db.run('INSERT INTO guild_roles (guild_id, user_id, role) VALUES (?, ?, ?)', [guild.id, adminUserId, 'owner']);
    console.log(`    + test admin is owner of "${fx.name}"`);
  }
}

async function main() {
  const db = await initializeDatabase();
  try {
    console.log('Seeding LOCAL testing fixtures against '
      + `${process.env.POSTGRES_USER}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}/${process.env.POSTGRES_DB}...`);
    const adminId = await ensureTestAdmin(db);
    for (const fx of FIXTURES) await ensureGuild(db, fx, adminId);

    const summary = await db.query(
      `SELECT g.discord_guild_id, g.name, g.status,
              (SELECT count(*) FROM servers s WHERE s.guild_id = g.id)::int AS servers
       FROM guilds g
       WHERE g.discord_guild_id IN (?,?,?)
       ORDER BY g.status`,
      FIXTURES.map((f) => f.discord_guild_id)
    );
    console.log('\nSeeded test fixtures:');
    for (const row of summary) {
      console.log(`  ${row.status.padEnd(10)} ${row.name}  (guild ${row.discord_guild_id}, ${row.servers} server(s))`);
    }
    console.log(`\nTest admin user id=${adminId} (discord_id=${TEST_DISCORD_ID}).`);
    console.log('Log in with:  /auth/test-login?token=<TEST_ADMIN_TOKEN>');
  } finally {
    await closeDatabase();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exitCode = 1;
});
