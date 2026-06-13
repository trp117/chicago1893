/**
 * scripts/backfill-display-order.mjs
 *
 * Sets displayOrder on scenarios to match the original homepage card sequence.
 * Scenarios not in the ORDER_MAP receive displayOrder: 99.
 *
 * Usage:
 *   node scripts/backfill-display-order.mjs           # dry run
 *   node scripts/backfill-display-order.mjs --apply   # write
 *   node scripts/backfill-display-order.mjs dog_green_sector --apply  # single
 */

import { fileURLToPath } from 'url';
import path from 'path';

await import('dotenv/config');

const { JsonFileStore }      = await import('../engine/repositories/JsonFileStore.js');
const { ScenarioRepository } = await import('../engine/repositories/ScenarioRepository.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir   = path.resolve(__dirname, '../engine/data');

const store    = new JsonFileStore(dataDir);
const scenRepo = new ScenarioRepository(store);

const ORDER_MAP = {
  dog_green_sector:               1,
  apollo_13_lifeboat:             2,
  greensboro_four_the_color_line: 3,
  sargasso_deep_three_keys:       4,
  zero_hour_cantigny:             5,
  titanic_final_hours:            6,
  high_water_reckoning:           7,
};
const DEFAULT_ORDER = 99;

const args     = process.argv.slice(2);
const apply    = args.includes('--apply');
const singleId = args.find(a => !a.startsWith('-'));

let scenarios;
try {
  scenarios = await scenRepo.findAll();
} catch (err) {
  console.error('Failed to load scenarios:', err.message);
  process.exit(1);
}

const targets = singleId ? scenarios.filter(s => s.id === singleId) : scenarios;

console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'} — ${targets.length} scenario(s)\n`);

let changed = 0, skipped = 0, errored = 0;

for (const scenario of targets) {
  const target = ORDER_MAP[scenario.id] ?? DEFAULT_ORDER;
  const current = scenario.displayOrder ?? null;

  if (current === target) {
    console.log(`  OK    ${scenario.id} — already ${target}`);
    skipped++;
    continue;
  }

  console.log(`  ${apply ? 'WRITE' : 'WOULD'} ${scenario.id}: ${current ?? '(unset)'} → ${target}`);

  if (apply) {
    try {
      await scenRepo.save(
        { ...scenario, displayOrder: target },
        { changeNote: 'Backfill displayOrder for homepage Open Now grid', savedBy: 'backfill-display-order' }
      );
      changed++;
    } catch (err) {
      console.error(`  ERROR ${scenario.id} — save failed: ${err.message}`);
      errored++;
    }
  } else {
    changed++;
  }
}

console.log(`\nDone. ${changed} ${apply ? 'written' : 'would change'}, ${skipped} skipped, ${errored} errored.`);
if (!apply && changed > 0) console.log('Run with --apply to write changes.');
