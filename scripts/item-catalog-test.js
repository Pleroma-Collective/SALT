'use strict';

/* item-catalog-test.js — P2 item catalog logic, asserted against real
 * extracted data (data/<map>/items.json + spawnables.json from
 * scripts/extract-dayz-data.js). Run: node scripts/item-catalog-test.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ItemCatalog = require('../public/js/item-catalog.js');

const ROOT = path.resolve(__dirname, '..');
const maps = ['nasdara', 'chernarusplus'];

for (const map of maps) {
  const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', map, 'items.json'), 'utf8')).items;
  const spawnables = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', map, 'spawnables.json'), 'utf8')).types;
  const buckets = ItemCatalog.categorize(items);

  // Category counts: server reality, not vanilla theory.
  assert(buckets.weapons.length > 100, `${map}: expected many weapon classes, got ${buckets.weapons.length}`);
  // This server spawns ammo both loose (Ammo_*) and in boxes (AmmoBox_*),
  // both tagged weapons: the ammo bucket must be exactly those classnames.
  const expectedAmmo = items.filter((i) => /^Ammo(_|Box_)/.test(i.classname));
  assert(expectedAmmo.length > 0, `${map}: expected ammo classes in types.xml`);
  assert.deepStrictEqual(
    buckets.ammo.map((i) => i.classname).sort(),
    expectedAmmo.map((i) => i.classname).sort(),
    `${map}: ammo bucket must be exactly the Ammo_* / AmmoBox_* classes`);
  // The plain AmmoBox container is not ammo.
  assert(!buckets.ammo.some((i) => i.classname === 'AmmoBox'), `${map}: plain AmmoBox container must not be in the ammo bucket`);
  assert(buckets.armor.length > 0, `${map}: expected armor derived from clothes (vests/helmets)`);
  assert(buckets.vehicles.length > 5, `${map}: expected drivable vehicles, got ${buckets.vehicles.length}`);

  // Buckets are disjoint and cover the catalog.
  const total = buckets.weapons.length + buckets.ammo.length + buckets.armor.length + buckets.vehicles.length + buckets.other.length;
  assert.equal(total, items.length, `${map}: buckets must partition the full catalog`);
  const seen = new Set();
  for (const bucket of Object.values(buckets)) {
    for (const it of bucket) {
      assert(!seen.has(it.classname), `${map}: ${it.classname} in two buckets`);
      seen.add(it.classname);
    }
  }

  // Vehicles: complete vehicles only — no parts, no wrecks.
  for (const it of buckets.vehicles) {
    assert(!/(Wheel|Doors|Hood|Trunk|_Door_|Battery|Ruined)/.test(it.classname), `${map}: part classname ${it.classname} classified as vehicle`);
    assert(!/^Wreck_/.test(it.classname), `${map}: wreck ${it.classname} classified as vehicle`);
  }
  const vehicleNames = buckets.vehicles.map((v) => v.classname);
  assert(vehicleNames.includes('Hatchback_02'), `${map}: Hatchback_02 must be a vehicle`);
  assert(vehicleNames.includes('Truck_01_Covered'), `${map}: Truck_01_Covered must be a vehicle`);

  // Vehicle spawn tuning join (cfgspawnabletypes): Hatchback_02 has parts.
  // This server's cfgspawnabletypes sets no spawn-damage range on complete
  // vehicles (they spawn clean); the damage path is proven via TruckBattery.
  const hatch = ItemCatalog.spawnInfo('Hatchback_02', spawnables);
  assert(hatch && hatch.parts.length >= 4, `${map}: Hatchback_02 must expose spawn part attachments`);
  const wheel = hatch.parts.find((p) => p.name === 'Hatchback_02_Wheel');
  assert(wheel && wheel.count === 5, `${map}: Hatchback_02 wheel part must aggregate to 5 slots`);
  const plug = ItemCatalog.spawnInfo('TruckBattery', spawnables);
  assert(plug && plug.damageMin === 0 && plug.damageMax === 0.35, `${map}: TruckBattery must expose its 0-0.35 spawn damage range`);

  // Armor rows are a subset of the server's clothes category.
  for (const it of buckets.armor) {
    assert.equal(it.category, 'clothes', `${map}: armor row ${it.classname} must come from the clothes category`);
  }

  // Classname Finder: any catalog item found by classname or display name.
  const sample = items[Math.floor(items.length / 2)];
  assert(ItemCatalog.searchCatalog(items, sample.classname).length >= 1, `${map}: search by classname must find ${sample.classname}`);
  assert(ItemCatalog.searchCatalog(items, sample.name).length >= 1, `${map}: search by display name must find ${sample.name}`);
  assert(ItemCatalog.searchCatalog(items, 'ak101').some((i) => i.classname === 'AK101'), `${map}: 'ak101' must match AK101 case-insensitively`);
  assert.equal(ItemCatalog.searchCatalog(items, 'zz-no-such-classname-zz').length, 0, `${map}: nonsense query must match nothing`);
  assert.equal(ItemCatalog.searchCatalog(items, '   ').length, 0, `${map}: blank query must match nothing`);

  // Vanilla cfg join (extractor --vanilla): storage grid, insulation,
  // in-game description. The local stringtable only resolves a subset of
  // descriptions (~10%), so that bound stays low by design.
  const withStorage = items.filter((i) => i.storageSlots != null).length;
  const withInsulation = items.filter((i) => i.insulation != null).length;
  const withDescription = items.filter((i) => typeof i.description === 'string' && i.description).length;
  assert(withStorage > items.length * 0.5, `${map}: expected majority of items with storage slots, got ${withStorage}/${items.length}`);
  assert(withInsulation > items.length * 0.4, `${map}: expected most items with insulation, got ${withInsulation}/${items.length}`);
  assert(withDescription > 50, `${map}: expected >50 resolvable in-game descriptions, got ${withDescription}`);
  // Spot-checked vanilla values (console cfg, resolved through inheritance).
  const gorka = items.find((i) => i.classname === 'GorkaEJacket_Winter');
  assert(gorka, `${map}: GorkaEJacket_Winter must be in the catalog`);
  assert.equal(gorka.insulation, 0.6, `${map}: GorkaEJacket_Winter insulation`);
  assert.equal(gorka.storageSlots, 12, `${map}: GorkaEJacket_Winter storage (4x3 grid)`);
  assert.equal(gorka.storageGrid, '4x3', `${map}: GorkaEJacket_Winter storage grid`);
  const bandage = items.find((i) => i.classname === 'BandageDressing');
  assert(bandage, `${map}: BandageDressing must be in the catalog`);
  assert.equal(bandage.storageSlots, 2, `${map}: BandageDressing storage (1x2 grid)`);
  const ammo = items.find((i) => i.classname === 'Ammo_556x45');
  assert(ammo, `${map}: Ammo_556x45 must be in the catalog`);
  assert.equal(ammo.storageSlots, 1, `${map}: Ammo_556x45 storage (1x1 grid)`);
}

console.log('✓ item-catalog: all assertions passed (nasdara, chernarusplus)');
