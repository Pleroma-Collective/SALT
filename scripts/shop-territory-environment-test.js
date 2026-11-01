'use strict';

/**
 * Unit tests for cfgenvironment.xml management in shopFileService:
 *   - idempotent one-time registration of a shop-owned custom/<name>.xml
 *   - duplicate avoidance (file declaration + territory mapping)
 *   - species/behavior mapping resolved from the server's own env/ set
 *   - no mutation of env/ vanilla territory file declarations
 *
 * The fake file service replaces missionFileService (same dependency
 * injection pattern as scripts/shop-event-position-test.js).
 */

const assert = require('assert');
const { XMLValidator } = require('fast-xml-parser');
const shop = require('../services/shopFileService');

// Shape mirrors the real Bohemia chernarusplus cfgenvironment.xml (verified
// live on the Nasadara server): one <territories> block holding <file path>
// declarations + <territory> mappings, comments included.  env/ox_territories
// is deliberately NOT declared so "Ox" is a Herd that fails the env/ check.
const FIXTURE = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<env>

	<!-- GENERAL Territories Section -->
	<territories>

		<file path="env/red_deer_territories.xml" />
		<file path="env/wild_boar_territories.xml" />
		<file path="env/wolf_territories.xml" />
		<file path="env/bear_territories.xml" />

		<territory type="Herd" name="Deer" behavior="DZDeerGroupBeh">
			<file usable="red_deer_territories" />
		</territory>
		<territory type="Herd" name="WildBoar" behavior="DZDeerGroupBeh">
			<file usable="wild_boar_territories" />
		</territory>
		<territory type="Herd" name="Wolf" behavior="DZWolfGroupBeh">
			<file usable="wolf_territories" />
		</territory>
		<territory type="Herd" name="Bear" behavior="BlissBearGroupBeh">
			<file usable="bear_territories"/>
		</territory>
		<territory type="Herd" name="Ox" behavior="DZdomesticGroupBeh">
			<file usable="ox_territories" />
		</territory>

		<!-- HEN -->
		<territory type="Ambient" name="AmbientHen" behavior="DZAmbientLifeGroupBeh">
			<file usable="hen_territories" />
			<agent type="Male" chance="1">
				<spawn configName="Animal_GallusGallusDomesticus" chance="1" />
			</agent>
			<item name="globalCountMax" val="50" />
		</territory>

	</territories>
</env>`;

const MISSION_DIR = '/mission';
const ENV_PATH = MISSION_DIR + '/cfgenvironment.xml';

function makeFileService(content = FIXTURE) {
  const state = new Map([[ENV_PATH, content]]);
  const uploads = [];
  return {
    uploads,
    async downloadFileFromServer(_serverId, filePath) {
      return state.has(filePath) ? state.get(filePath) : null;
    },
    async uploadFileToServer(_serverId, dirPath, fileName, content) {
      const filePath = dirPath.replace(/\/$/, '') + '/' + fileName;
      uploads.push(filePath);
      state.set(filePath, content);
    },
    get: filePath => (state.has(filePath) ? state.get(filePath) : null),
  };
}

function countMatches(text, pattern) {
  return (String(text).match(pattern) || []).length;
}

function envFilePaths(content) {
  return [...String(content).matchAll(/<file path="([^"]+)"/g)].map(match => match[1]).sort();
}

async function main() {
  // ── species/behavior mapping ────────────────────────────────────────────
  const species = shop.listEnvironmentSpecies(FIXTURE);
  const byName = new Map(species.map(entry => [entry.name, entry]));
  assert.deepStrictEqual(byName.get('Wolf'), {
    name: 'Wolf', behavior: 'DZWolfGroupBeh', usable: 'wolf_territories',
    envFile: 'env/wolf_territories.xml', envFileDeclared: true,
  }, 'wolf must map to DZWolfGroupBeh with its declared env/ file');
  assert.deepStrictEqual(byName.get('Bear').behavior, 'BlissBearGroupBeh', 'bear behavior comes from the server file');
  assert.deepStrictEqual(byName.get('WildBoar').behavior, 'DZDeerGroupBeh');
  assert.deepStrictEqual(byName.get('Deer').behavior, 'DZDeerGroupBeh');
  assert.strictEqual(byName.get('Ox').envFileDeclared, false, 'undeclared env/ file must be flagged');
  assert.ok(!byName.has('AmbientHen'), 'Ambient entries are not shop Herd species');
  assert.strictEqual(species.length, 5, 'only the five Herd entries are listed');

  // ── first registration: declaration + mapping, env/ untouched ──────────
  const fileService = makeFileService();
  const result = await shop.registerCustomTerritoryInEnvironment(
    'server', 'token', MISSION_DIR,
    { species: 'wolf', fileName: 'custom_wolf_territories' },
    fileService
  );
  assert.deepStrictEqual(result, { changed: true, species: 'Wolf', behavior: 'DZWolfGroupBeh' },
    'registration must resolve the canonical species name and behavior');
  assert.deepStrictEqual(fileService.uploads, [ENV_PATH], 'only cfgenvironment.xml may be uploaded');
  assert.strictEqual(fileService.uploads.length, 1);

  const updated = fileService.get(ENV_PATH);
  assert.strictEqual(XMLValidator.validate(updated), true, 'registered cfgenvironment.xml must stay well-formed');
  assert.strictEqual(countMatches(updated, /<file path="custom\/custom_wolf_territories\.xml"\/>/g), 1,
    'custom file must be declared exactly once under <territories>');
  assert.match(updated,
    /<territory type="Herd" name="Wolf" behavior="DZWolfGroupBeh"><file usable="custom_wolf_territories"\/>/s,
    'territory mapping must carry the server behavior and the custom usable');
  assert.match(updated, /<file usable="wolf_territories"\/>/, 'vanilla wolf mapping must survive');
  assert.strictEqual(countMatches(updated, /usable="wolf_territories"/g), 1, 'no duplicate vanilla wolf mapping');
  assert.ok(updated.includes('<!-- GENERAL Territories Section -->') && updated.includes('<!-- HEN -->'),
    'existing XML comments must be preserved');
  assert.ok(updated.includes('<!-- DayZ Shop territory mapping custom/custom_wolf_territories.xml (Wolf) -->'),
    'shop-owned mapping must carry the house ownership comment');
  assert.deepStrictEqual(envFilePaths(updated),
    [...envFilePaths(FIXTURE), 'custom/custom_wolf_territories.xml'].sort(),
    'env/ vanilla territory file declarations must not be mutated');

  // ── idempotency: same (species, file) again is a no-op without upload ───
  const resultAgain = await shop.registerCustomTerritoryInEnvironment(
    'server', 'token', MISSION_DIR,
    { species: 'WOLF', fileName: 'custom_wolf_territories' },
    fileService
  );
  assert.deepStrictEqual(resultAgain, { changed: false, species: 'Wolf', behavior: 'DZWolfGroupBeh' },
    're-registration must be a no-op (case-insensitive)');
  assert.strictEqual(fileService.uploads.length, 1, 'idempotent registration must not re-upload');
  assert.strictEqual(fileService.get(ENV_PATH), updated, 'file content must be byte-identical after no-op');

  // ── duplicate avoidance: same custom file for a second species ──────────
  const resultBear = await shop.registerCustomTerritoryInEnvironment(
    'server', 'token', MISSION_DIR,
    { species: 'bear', fileName: 'custom_wolf_territories' },
    fileService
  );
  assert.deepStrictEqual(resultBear, { changed: true, species: 'Bear', behavior: 'BlissBearGroupBeh' });
  const afterBear = fileService.get(ENV_PATH);
  assert.strictEqual(countMatches(afterBear, /<file path="custom\/custom_wolf_territories\.xml"\/>/g), 1,
    'a shared custom file must stay declared exactly once');
  assert.match(afterBear, /<territory type="Herd" name="Bear" behavior="BlissBearGroupBeh"><file usable="custom_wolf_territories"\/>/s);
  assert.strictEqual(countMatches(afterBear, /<territory type="Herd" name="Wolf" behavior="DZWolfGroupBeh"><file usable="custom_wolf_territories"\/>/g), 1,
    'a second species must not duplicate the wolf mapping');
  assert.strictEqual(fileService.uploads.length, 2);

  // ── second file for the same species coexists with the first mapping ────
  await shop.registerCustomTerritoryInEnvironment(
    'server', 'token', MISSION_DIR,
    { species: 'wolf', fileName: 'custom_wolf_territories_2' },
    fileService
  );
  const afterSecond = fileService.get(ENV_PATH);
  assert.strictEqual(countMatches(afterSecond, /usable="custom_wolf_territories"\/>/g), 2,
    'the shared file now serves two species');
  assert.strictEqual(countMatches(afterSecond, /<territory type="Herd" name="Wolf" behavior="DZWolfGroupBeh"><file usable="custom_wolf_territories"\/>/g), 1,
    'each (species, file) pair must appear exactly once');
  assert.strictEqual(countMatches(afterSecond, /name="Wolf" behavior="DZWolfGroupBeh"/g), 3,
    'vanilla + two shop mappings now reference the Wolf species');
  assert.strictEqual(XMLValidator.validate(afterSecond), true);

  // ── registration remains after the last zone is removed ─────────────────
  // (no deregistration path exists by design; re-running the purchase-side
  // call after zone removal is the no-op exercised above)
  const { registerCustomTerritoryInEnvironment } = shop;
  assert.ok(!('removeCustomTerritoryFromEnvironment' in shop),
    'registration must not be removable — it stays after the last zone is removed');
  assert.strictEqual(typeof registerCustomTerritoryInEnvironment, 'function');

  // ── rejections ──────────────────────────────────────────────────────────
  const fresh = makeFileService();
  await assert.rejects(
    shop.registerCustomTerritoryInEnvironment('s', 't', MISSION_DIR, { species: 'Tiger', fileName: 'x' }, fresh),
    /not a supported Herd on this server \(available: Deer, WildBoar, Wolf, Bear, Ox\)/,
    'unknown species must be rejected with the available list'
  );
  await assert.rejects(
    shop.registerCustomTerritoryInEnvironment('s', 't', MISSION_DIR, { species: 'Ox', fileName: 'x' }, fresh),
    /not in this server's env\/ set: env\/ox_territories\.xml is not declared/,
    'species whose env/ file is not declared must be rejected'
  );
  await assert.rejects(
    shop.registerCustomTerritoryInEnvironment('s', 't', MISSION_DIR, { species: 'wolf', fileName: '../evil' }, fresh),
    /Invalid custom territory file name/,
    'file names must be plain identifiers (usable has no custom/ prefix)'
  );
  await assert.rejects(
    shop.registerCustomTerritoryInEnvironment('s', 't', MISSION_DIR, { species: 'w olf', fileName: 'x' }, fresh),
    /Invalid territory species name/
  );
  const missingService = {
    uploads: [],
    async downloadFileFromServer() {
      return null;
    },
    async uploadFileToServer() {
      throw new Error('unexpected upload');
    },
  };
  await assert.rejects(
    shop.registerCustomTerritoryInEnvironment('s', 't', MISSION_DIR, { species: 'wolf', fileName: 'x' }, missingService),
    /cfgenvironment\.xml not found/
  );
  assert.strictEqual(fresh.uploads.length, 0, 'rejected registrations must not upload anything');

  // ── malformed / unsupported structures fail closed ──────────────────────
  await assert.rejects(
    async () => shop.listEnvironmentSpecies('<env><territories></territories><stray/></env>'),
    /Unsupported cfgenvironment\.xml child element/,
    'unexpected <env> children must be rejected (fail closed, no guessing)'
  );
  await assert.rejects(
    shop.registerCustomTerritoryInEnvironment('s', 't', MISSION_DIR, { species: 'wolf', fileName: 'x' },
      makeFileService('<?xml version="1.0"?><env><territories><file path="env/wolf_zones.xml"/><territory type="Herd" name="Wolf" behavior="DZWolfGroupBeh"><file usable="wolf"/></territory></territories></env>')),
    /not in this server's env\/ set/,
    'a species whose env file was never declared must fail even with minimal content'
  );

  console.log('shop territory environment contract test passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
