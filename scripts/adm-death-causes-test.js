#!/usr/bin/env node
'use strict';

/*
 * ADM Death Causes (card t_d06e05eb) — parser, fall attribution, PVP body-part
 * enrichment, dedupe, and end-to-end processAdmDeathCauses (ADM files →
 * events table via eventWriter) against a fake db and temp log files.
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const root = path.resolve(__dirname, '..');
const { classifyAdmDeathLine, classifyAdmHitLine } = require(path.join(root, 'utils', 'admDeathCauses.js'));
const { processAdmDeathCauses } = require(path.join(root, 'routes', 'logParser.js'));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + name);
}

// Real sample lines from Events/logs/dayzxb/config (2026-10-23 → 26).
const PVP_KILL = '16:31:00 | Player "FazeAnnFrank411" (DEAD) (id=AB88A8C6E8F868A81AFCF5C72D07E7FCFC0DF236 pos=<13617.7, 12696.9, 205.4>) killed by Player "jay9260" (id=8DFD1E12049E522B028A144A718876A3686C7B98 pos=<13604.6, 12656.8, 204.0>) with KA-M from 42.1596 meters ';
const PVP_KILL_SPACE_WEAPON = '17:26:22 | Player "KHD36215" (DEAD) (id=EDA44874CE054D8D5D8FA7657E7541F6C80B5BEF pos=<7392.5, 6415.7, 199.3>) killed by Player "Frosty1024" (id=366B4BCC01FF278DDBB8F4ABECBB807D2CBC1B82 pos=<7423.7, 6385.2, 198.6>) with Lee Enfield from 43.6803 meters';
const VEHICLE_KILL = '06:10:29 | Player "Porkey9884" (DEAD) (id=350BB79B3E1389666E7F033CE030557EBC65B302 pos=<103.7, 4334.8, 357.2>) killed by NO DRIVER (Motorbike_01_Blue)';
const NPC_KILL = '16:29:18 | Player "Irondavid8a" (DEAD) (id=1A4DB0AB6213FF71B00D6D53512A51E9998E844 pos=<7829.5, 9954.0, 243.5>) killed by ZmbM_takiSoldier_Officer';
const ANIMAL_KILL = '16:30:00 | Player "SomeGuy42" (DEAD) (id=AAAA0000BBBB1111CCCC2222DDDD3333 pos=<100.0, 200.0, 10.0>) killed by Doberman';
const SUICIDE = '14:43:47 | Player "MinecraftKing58" (id=F7B25A36F4858E9635165FF0155A72A90075062D pos=<8816.5, 12587.6, 242.8>) committed suicide';
const BLED_OUT = '19:11:55 | Player "Salt6199" (DEAD) (id=97E97694039D44B22EA09F9D282E101635EC3F5D pos=<7737.1, 12446.7, 242.6>) bled out';
const DROWNED = '01:02:03 | Player "SwimFan77" (DEAD) (id=1111AAAA2222BBBB3333CCCC4444DDDD pos=<50.0, 60.0, -2.0>) drowned. Stats> Water: 0.0 Energy: 500.0 Bleed sources: 0';
const DIED = '08:37:27 | Player "OLSCHELLYBOY" (DEAD) (id=B6796C55CA25C8B47F3A5254BA7F009F227018C3 pos=<10984.4, 10717.5, 169.5>) died. Stats> Water: 961.051 Energy: 762.35 Bleed sources: 1';
const DIED_GARBAGE_POS = '08:38:00 | Player "GlitchVictim" (DEAD) (id=9999EEEE8888FFFF7777AAAA6666BBBB pos=<-3402823466385288598117041832116734636714, 0.0, 0.0>) died. Stats> Water: 100.0 Energy: 100.0 Bleed sources: 0';
const FALL_HIT = '04:11:53 | Player "Lord Monkey 1" (id=B9182B70AAE7B7C14EA122DC1119678B0CD585F2 pos=<4570.3, 5672.8, 240.7>)[HP: 99.2798] hit by FallDamageHealth';
const PVP_HIT_BODY = '06:33:53 | Player "StoneyUser98328" (id=D3870400940969D77231AB811875DE0B72CEEBCC pos=<2844.1, 9236.7, 402.7>)[HP: 97.91] hit by Player "LITTLEJ2033" (id=04D959A5CD2D8427479517C86C7FEB395DA30356 pos=<2843.7, 9238.3, 402.7>) into LeftArm(22) for 20.9 damage (MeleeSharpLight_4) with Combat Knife';
const PVP_HIT_FIST = '05:54:46 | Player "Poepiewoepie129" (id=43380526297606C663DBF0FE497BCD408C2D94AF pos=<158.9, 4339.1, 354.2>)[HP: 97.15] hit by Player "Lord Monkey 1" (id=B9182B70AAE7B7C14EA122DC1119678B0CD585F2 pos=<160.0, 4339.2, 354.2>) into Torso(15) for 2.85 damage (MeleeFist)';
const TRANSPORT_HIT = '04:37:25 | Player "Poepiewoepie129" (id=43380526297606C663DBF0FE497BCD408C2D94AF pos=<3110.5, 5558.4, 458.7>)[HP: 98.6162] hit by Player "Lord Monkey 1" (id=B9182B70AAE7B7C14EA122DC1119678B0CD585F2 pos=<3111.3, 5556.6, 459.2>) with TransportHit (Offroad_02_Beige)';
const CONNECT = '11:00:00 | Player "NewGuy123" (id=ABCDEF1234567890ABCDEF1234567890ABCDEF12 is connecting';
const PLAYERLIST = '11:05:00 | ##### PlayerList log: 3 players';

function createFakeDb(persistedKeys) {
  const appended = [];
  return {
    appended,
    get: async (sql, params) => {
      if (sql.includes('FROM events')) {
        return persistedKeys.has(params[1]) ? { '1': 1 } : null;
      }
      return null;
    },
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO events')) appended.push(params);
      return { rows: [{ seq: 1, uuid: 'uuid-test' }] };
    },
  };
}

(async () => {
  // ── Death line parser ─────────────────────────────────────────────────────
  await check('classifyAdmDeathLine: real PVP kill → pvp + killer + weapon + distance + pos', () => {
    const d = classifyAdmDeathLine(PVP_KILL);
    assert.ok(d, 'line must parse');
    assert.strictEqual(d.cause, 'pvp');
    assert.strictEqual(d.victimName, 'FazeAnnFrank411');
    assert.strictEqual(d.victimId, 'AB88A8C6E8F868A81AFCF5C72D07E7FCFC0DF236');
    assert.strictEqual(d.killerName, 'jay9260');
    assert.strictEqual(d.killerId, '8DFD1E12049E522B028A144A718876A3686C7B98');
    assert.strictEqual(d.weapon, 'KA-M');
    assert.strictEqual(d.distance, 42.1596);
    assert.deepStrictEqual(d.pos, [13617.7, 12696.9, 205.4]);
  });

  await check('classifyAdmDeathLine: multi-word weapon ("Lee Enfield") parses', () => {
    const d = classifyAdmDeathLine(PVP_KILL_SPACE_WEAPON);
    assert.strictEqual(d.cause, 'pvp');
    assert.strictEqual(d.weapon, 'Lee Enfield');
    assert.strictEqual(d.distance, 43.6803);
    assert.strictEqual(d.killerName, 'Frosty1024');
  });

  await check('classifyAdmDeathLine: vehicle kill → vehicle + class', () => {
    const d = classifyAdmDeathLine(VEHICLE_KILL);
    assert.strictEqual(d.cause, 'vehicle');
    assert.strictEqual(d.vehicle, 'Motorbike_01_Blue');
    assert.strictEqual(d.killerName, undefined);
  });

  await check('classifyAdmDeathLine: zombie kill → infected; Doberman → npc', () => {
    assert.strictEqual(classifyAdmDeathLine(NPC_KILL).cause, 'infected');
    assert.strictEqual(classifyAdmDeathLine(NPC_KILL).npcClass, 'ZmbM_takiSoldier_Officer');
    assert.strictEqual(classifyAdmDeathLine(ANIMAL_KILL).cause, 'npc');
    assert.strictEqual(classifyAdmDeathLine(ANIMAL_KILL).npcClass, 'Doberman');
  });

  await check('classifyAdmDeathLine: suicide (no DEAD marker) / bled out / drowned / died', () => {
    assert.strictEqual(classifyAdmDeathLine(SUICIDE).cause, 'suicide');
    assert.strictEqual(classifyAdmDeathLine(BLED_OUT).cause, 'bleed');
    assert.strictEqual(classifyAdmDeathLine(DROWNED).cause, 'drowned');
    assert.strictEqual(classifyAdmDeathLine(DIED).cause, 'unknown');
  });

  await check('classifyAdmDeathLine: garbage coords → pos null, death still classified', () => {
    const d = classifyAdmDeathLine(DIED_GARBAGE_POS);
    assert.strictEqual(d.cause, 'unknown');
    assert.strictEqual(d.pos, null);
    assert.strictEqual(d.victimName, 'GlitchVictim');
  });

  await check('classifyAdmDeathLine: CRLF tolerated; non-death lines → null', () => {
    assert.strictEqual(classifyAdmDeathLine(PVP_KILL + '\r').cause, 'pvp');
    assert.strictEqual(classifyAdmDeathLine(CONNECT), null);
    assert.strictEqual(classifyAdmDeathLine(PLAYERLIST), null);
    assert.strictEqual(classifyAdmDeathLine(FALL_HIT), null);
    assert.strictEqual(classifyAdmDeathLine(''), null);
  });

  // ── Hit line parser (context) ─────────────────────────────────────────────
  await check('classifyAdmHitLine: fall hit + PVP hit body parts', () => {
    const fall = classifyAdmHitLine(FALL_HIT, Date.parse('2026-10-24T04:11:53Z'));
    assert.deepStrictEqual({ kind: fall.kind, playerId: fall.playerId }, { kind: 'fall', playerId: 'B9182B70AAE7B7C14EA122DC1119678B0CD585F2' });
    const pvp = classifyAdmHitLine(PVP_HIT_BODY, Date.parse('2026-10-24T06:33:53Z'));
    assert.strictEqual(pvp.kind, 'pvp_hit');
    assert.strictEqual(pvp.victimId, 'D3870400940969D77231AB811875DE0B72CEEBCC');
    assert.strictEqual(pvp.attackerId, '04D959A5CD2D8427479517C86C7FEB395DA30356');
    assert.strictEqual(pvp.bodyPart, 'LeftArm');
    const fist = classifyAdmHitLine(PVP_HIT_FIST, Date.parse('2026-10-24T05:54:46Z'));
    assert.strictEqual(fist.bodyPart, 'Torso');
    assert.strictEqual(classifyAdmHitLine(TRANSPORT_HIT, Date.parse('2026-10-24T04:37:25Z')), null, 'TransportHit is not a body-part damage line');
    assert.strictEqual(classifyAdmHitLine(CONNECT, Date.parse('2026-10-24T11:00:00Z')), null);
  });

  // ── processAdmDeathCauses (integration, fake db + temp log) ───────────────
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-death-test-'));
  const lines = [
    '23:59:59 | Player "LateNight1" (DEAD) (id=LATE00000000000000000000000000000000 pos=<100.0, 200.0, 10.0>) bled out',
    FALL_HIT,
    '04:11:53 | Player "Lord Monkey 1" (DEAD) (id=B9182B70AAE7B7C14EA122DC1119678B0CD585F2 pos=<4570.3, 5672.8, 240.7>) died. Stats> Water: 300.0 Energy: 200.0 Bleed sources: 0',
    PVP_HIT_BODY,
    '06:33:53 | Player "StoneyUser98328" (DEAD) (id=D3870400940969D77231AB811875DE0B72CEEBCC pos=<2844.1, 9236.7, 402.7>) killed by Player "LITTLEJ2033" (id=04D959A5CD2D8427479517C86C7FEB395DA30356 pos=<2843.7, 9238.3, 402.7>) with Combat Knife from 1.5 meters',
    VEHICLE_KILL,
    NPC_KILL,
    SUICIDE,
    DIED,
  ];
  const admPath = path.join(baseDir, 'DayZServerP_X1_x64_2026-10-24_11-16-37.ADM');
  fs.writeFileSync(admPath, lines.join('\n') + '\n');
  try {
    const db = createFakeDb(new Set());
    const result = await processAdmDeathCauses(db, {
      baseDir,
      admFiles: [admPath],
      serverContext: { id: 42 },
    });

    await check('integration: 7 deaths persisted with correct causes', () => {
      assert.strictEqual(result.persisted, 7, JSON.stringify(result));
      assert.strictEqual(result.duplicates, 0);
      assert.strictEqual(result.errors, 0);
      assert.strictEqual(db.appended.length, 7);
      const causes = db.appended.map(p => JSON.parse(p[4]).cause).sort();
      assert.deepStrictEqual(causes, ['bleed', 'fall', 'infected', 'pvp', 'suicide', 'unknown', 'vehicle'].sort());
    });

    await check('integration: event shape — server id, event type, payload fields', () => {
      for (const params of db.appended) {
        assert.strictEqual(params[0], 42, 'server_id');
        assert.strictEqual(params[2], 'player.death_cause', 'event_type');
        assert.ok(params[4], 'payload json');
      }
      const byCause = {};
      for (const params of db.appended) byCause[JSON.parse(params[4]).cause] = JSON.parse(params[4]);
      assert.strictEqual(byCause.pvp.killerName, 'LITTLEJ2033');
      assert.strictEqual(byCause.pvp.weapon, 'Combat Knife');
      assert.strictEqual(byCause.pvp.distance, 1.5);
      assert.strictEqual(byCause.pvp.bodyPart, 'LeftArm', 'body part from the preceding PVP hit line');
      assert.strictEqual(byCause.vehicle.vehicle, 'Motorbike_01_Blue');
      assert.strictEqual(byCause.infected.npcClass, 'ZmbM_takiSoldier_Officer');
      assert.ok(byCause.fall.dedupeKey.endsWith('|fall'));
    });

    await check('integration: midnight rollover — 23:59:59 death dated on the file date', () => {
      const bleedRow = db.appended.find(p => JSON.parse(p[4]).cause === 'bleed');
      assert.strictEqual(new Date(bleedRow[3]).toISOString(), '2026-10-24T23:59:59.000Z');
    });

    await check('integration: second run re-derives nothing (events-table dedupe)', async () => {
      const keys = new Set(db.appended.map(p => JSON.parse(p[4]).dedupeKey));
      const db2 = createFakeDb(keys);
      const again = await processAdmDeathCauses(db2, {
        baseDir,
        admFiles: [admPath],
        serverContext: { id: 42 },
      });
      assert.strictEqual(again.persisted, 0);
      assert.strictEqual(again.duplicates, 7);
      assert.strictEqual(db2.appended.length, 0);
    });

    await check('integration: fall attribution is per-player (another player died same second, no fall hit → unknown)', () => {
      // DIED line above (OLSCHELLYBOY, 08:37:27) has no fall hit for that player
      const unknownRow = db.appended.find(p => JSON.parse(p[4]).victimName === 'OLSCHELLYBOY');
      assert.ok(unknownRow, 'the unattributed death must persist');
      assert.strictEqual(JSON.parse(unknownRow[4]).cause, 'unknown');
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }

  console.log(`\n✅ adm-death-causes-test: ${passed} checks passed`);
})().catch((err) => {
  console.error('\n❌ adm-death-causes-test failed:', err);
  process.exit(1);
});
