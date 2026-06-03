/**
 * scripts/backfill-epilogue.mjs
 *
 * Backfills corrected epilogue content from local JSON files into Supabase,
 * surgical-merge only — non-epilogue fields and epilogue.reviewed /
 * epilogue.generated are never touched.
 *
 * Usage:
 *   node scripts/backfill-epilogue.mjs                    # dry run, all 8
 *   node scripts/backfill-epilogue.mjs dog_green_sector   # dry run, one
 *   node scripts/backfill-epilogue.mjs --apply            # write all 8
 *   node scripts/backfill-epilogue.mjs dog_green_sector --apply
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// ── Load .env BEFORE any module that reads process.env at initialisation time ─
// Dynamic imports resolve (and execute) after this await, so lib/supabase.js
// sees SUPABASE_URL / SUPABASE_SERVICE_KEY already in process.env.
await import('dotenv/config');

const { supabase }           = await import('../lib/supabase.js');
const { JsonFileStore }      = await import('../engine/repositories/JsonFileStore.js');
const { ScenarioRepository } = await import('../engine/repositories/ScenarioRepository.js');

// ── Paths ─────────────────────────────────────────────────────────────────────
const __filename    = fileURLToPath(import.meta.url);
const __dirname     = path.dirname(__filename);
const SCENARIOS_DIR = path.resolve(__dirname, '../engine/data/scenarios');
const dataDir       = path.resolve(__dirname, '../engine/data');

// ── Repository (same construction as engine/server/server.js) ─────────────────
const store    = new JsonFileStore(dataDir);
const scenRepo = new ScenarioRepository(store);

// ── Scope ─────────────────────────────────────────────────────────────────────
const TARGET_IDS = [
  'dog_green_sector',
  'apollo_13_lifeboat',
  'greensboro_four_the_color_line',
  'sargasso_deep_three_keys',
  'titanic_final_hours',
  'zero_hour_cantigny',
  'bornholmer_strasse_first_breach',
  'artesian_height_1892',
];

// Sub-keys taken from local file (corrected content)
const CONTENT_KEYS = [
  'character_fates',
  'immediate_outcome',
  'historical_frame',
  'open_threads',
  'choice_echoes',
];

// ── CLI ───────────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const apply    = args.includes('--apply');
const singleId = args.find(a => !a.startsWith('-'));
const ids      = singleId ? [singleId] : TARGET_IDS;

// ── Diff helpers ──────────────────────────────────────────────────────────────
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function fmtArr(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '(empty)';
  return typeof arr[0] === 'string' ? `${arr.length} strings` : `${arr.length} {text,source} objects`;
}

function describeChange(key, sbVal, locVal) {
  const lines = [];

  if (key === 'character_fates') {
    lines.push(`  character_fates    CHANGED`);
    const sbById  = Object.fromEntries((sbVal  || []).map(f => [f.character_id, f]));
    const locById = Object.fromEntries((locVal || []).map(f => [f.character_id, f]));
    const allIds  = [...new Set([...Object.keys(sbById), ...Object.keys(locById)])];
    for (const cid of allIds) {
      const was = sbById[cid]?.classification ?? '(none)';
      const now = locById[cid]?.classification ?? '(none)';
      if (was !== now) lines.push(`    ${cid.padEnd(42)} ${was} → "${now}"`);
    }
    const sbN = (sbVal || []).length, locN = (locVal || []).length;
    if (sbN !== locN) lines.push(`    count: ${sbN} → ${locN}`);
    return lines.join('\n');
  }

  if (key === 'immediate_outcome') {
    lines.push(`  immediate_outcome  CHANGED`);
    if (!eq(sbVal?.summary, locVal?.summary))
      lines.push(`    summary: text differs`);
    const sbF = sbVal?.key_facts || [], locF = locVal?.key_facts || [];
    if (!eq(sbF, locF))
      lines.push(`    key_facts: ${fmtArr(sbF)} → ${fmtArr(locF)}`);
    return lines.join('\n');
  }

  if (key === 'historical_frame') {
    return `  historical_frame   CHANGED  ${fmtArr(sbVal)} → ${fmtArr(locVal)}`;
  }

  // open_threads / choice_echoes
  const sbN  = Array.isArray(sbVal)  ? sbVal.length  : (sbVal  != null ? 1 : 0);
  const locN = Array.isArray(locVal) ? locVal.length : (locVal != null ? 1 : 0);
  return `  ${key.padEnd(20)} CHANGED  ${sbN} → ${locN} entries`;
}

// ── Per-scenario logic ────────────────────────────────────────────────────────
async function processScenario(id) {
  const HR = '─'.repeat(66);
  console.log(`\n${HR}`);
  console.log(`Scenario: ${id}`);

  // 1. Local file — source of corrected epilogue content
  const localPath = path.join(SCENARIOS_DIR, `${id}.json`);
  if (!fs.existsSync(localPath)) {
    console.log('  SKIP  no local file found');
    return 'skip';
  }
  const localContent  = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  const localEpilogue = localContent.epilogue;
  if (!localEpilogue) {
    console.log('  SKIP  local file has no epilogue block');
    return 'skip';
  }

  // 2. Fetch current Supabase state via direct query.
  //    Using supabase client directly (not findById) because findById falls back
  //    to the local file on any error — we must confirm the record is in Supabase
  //    before treating that data as authoritative base.
  const { data: sbRow, error: sbErr } = await supabase
    .from('scenarios')
    .select('content, current_version')
    .eq('id', id)
    .single();

  if (sbErr || !sbRow) {
    console.warn(`  WARN  no Supabase record found — skipping (never insert)`);
    return 'skip';
  }

  const sbContent  = sbRow.content;
  const sbEpilogue = sbContent.epilogue || {};

  // 3. Explicitly confirm what will be preserved
  console.log(
    `  Supabase v${sbRow.current_version}` +
    `  epilogue.generated=${sbEpilogue.generated}` +
    `  epilogue.reviewed=${sbEpilogue.reviewed}` +
    `  ← both PRESERVED`
  );

  // 4. Compute diff
  const changedKeys   = CONTENT_KEYS.filter(k => !eq(sbEpilogue[k], localEpilogue[k]));
  const unchangedKeys = CONTENT_KEYS.filter(k =>  eq(sbEpilogue[k], localEpilogue[k]));

  if (changedKeys.length === 0) {
    console.log('  NO CHANGES  all content sub-keys already match Supabase');
    return 'no-change';
  }

  for (const k of changedKeys)
    console.log(describeChange(k, sbEpilogue[k], localEpilogue[k]));
  if (unchangedKeys.length)
    console.log(`  UNCHANGED  ${unchangedKeys.join(', ')}`);

  if (!apply) {
    console.log('  DRY RUN  save() not called');
    return 'dry';
  }

  // 5. Build merged object: start from Supabase base, splice in corrected
  //    epilogue content keys only, re-assert reviewed/generated explicitly.
  const merged = {
    ...sbContent,
    epilogue: {
      ...sbEpilogue,
      character_fates:   localEpilogue.character_fates,
      immediate_outcome: localEpilogue.immediate_outcome,
      historical_frame:  localEpilogue.historical_frame,
      open_threads:      localEpilogue.open_threads,
      choice_echoes:     localEpilogue.choice_echoes,
      generated: sbEpilogue.generated,   // belt-and-suspenders re-assertion
      reviewed:  sbEpilogue.reviewed,
    },
  };

  // 6. Write via existing path — upsert + version snapshot + fs backup happen for free
  await scenRepo.save(merged, {
    savedBy:    'epilogue-migration',
    changeNote: 'Backfill: classification flags, D-1 timing, key_facts/historical_frame {text,source} schema',
  });
  console.log('  SAVED  (local file backup also updated to merged state)');
  return 'saved';
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
    process.exit(1);
  }

  const mode = apply ? 'APPLY' : 'DRY RUN (default) — pass --apply to write';
  console.log(`\nEpilogue backfill — ${mode}`);
  console.log(`Scenarios  : ${ids.join(', ')}`);
  console.log(`Replacing  : ${CONTENT_KEYS.join(', ')}`);
  console.log(`Preserving : generated, reviewed  (from Supabase in all cases)`);

  const counts = { saved: 0, dry: 0, 'no-change': 0, skip: 0 };
  for (const id of ids) {
    const r = await processScenario(id);
    counts[r] = (counts[r] || 0) + 1;
  }

  const HR = '─'.repeat(66);
  console.log(`\n${HR}`);
  if (!apply) {
    console.log(`Dry run complete.`);
    console.log(`  ${counts.dry ?? 0} scenario(s) have changes — review above then run with --apply`);
    console.log(`  ${counts['no-change'] ?? 0} already match Supabase`);
    console.log(`  ${counts.skip ?? 0} skipped`);
  } else {
    console.log(`Done.`);
    console.log(`  ${counts.saved ?? 0} saved, ${counts['no-change'] ?? 0} no-change, ${counts.skip ?? 0} skipped`);
  }
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
