/**
 * scripts/backfill-categories.mjs
 *
 * Sets scenario.category on every scenario currently in CATEGORY_MAP,
 * writing to both disk and Supabase via the normal repos.scenarios.save() path.
 *
 * Usage:
 *   node scripts/backfill-categories.mjs           # dry run
 *   node scripts/backfill-categories.mjs --apply   # write
 *   node scripts/backfill-categories.mjs apollo_13_lifeboat --apply  # single
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

const CATEGORY_MAP = {
  apollo_13_lifeboat:               'space',
  sargasso_deep_three_keys:         'space',
  dog_green_sector:                 'military',
  zero_hour_cantigny:               'military',
  greensboro_four_the_color_line:   'civil-rights',
  lightning_and_the_midnight_coach: 'underground',
  singing_wires:                    'underground',
  midnight_errand_boston:           'underground',
  titanic_final_hours:              'maritime',
  artesian_height_1892:             'industrial',
  dead_reckoning_ninth_ward:        'industrial',
  bornholmer_strasse_first_breach:  'space',
};

const args     = process.argv.slice(2);
const apply    = args.includes('--apply');
const singleId = args.find(a => !a.startsWith('-'));
const ids      = singleId ? [singleId] : Object.keys(CATEGORY_MAP);

console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'} — ${ids.length} scenario(s)\n`);

let changed = 0, skipped = 0, errored = 0;

for (const id of ids) {
  const target = CATEGORY_MAP[id];
  if (!target) { console.warn(`  SKIP  ${id} — not in CATEGORY_MAP`); skipped++; continue; }

  let scenario;
  try {
    scenario = await scenRepo.findById(id);
  } catch (err) {
    console.error(`  ERROR ${id} — load failed: ${err.message}`);
    errored++;
    continue;
  }

  if (!scenario) {
    console.warn(`  SKIP  ${id} — scenario not found`);
    skipped++;
    continue;
  }

  if (scenario.category === target) {
    console.log(`  OK    ${id} — already set to "${target}"`);
    skipped++;
    continue;
  }

  const was = scenario.category || '(unset)';
  console.log(`  ${apply ? 'WRITE' : 'WOULD'} ${id}: "${was}" → "${target}"`);

  if (apply) {
    try {
      await scenRepo.save(
        { ...scenario, category: target },
        { changeNote: 'Backfill category field from CATEGORY_MAP', savedBy: 'backfill-categories' }
      );
      changed++;
    } catch (err) {
      console.error(`  ERROR ${id} — save failed: ${err.message}`);
      errored++;
    }
  } else {
    changed++;
  }
}

console.log(`\nDone. ${changed} ${apply ? 'written' : 'would change'}, ${skipped} skipped, ${errored} errored.`);
if (!apply && changed > 0) console.log('Run with --apply to write changes.');
