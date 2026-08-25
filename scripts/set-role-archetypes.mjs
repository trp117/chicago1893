#!/usr/bin/env node
// Set the durable `archetype` property on the labelled player roles.
//
//   node scripts/set-role-archetypes.mjs [--dry-run]
//
// Writes through the SAME store the server uses (DualWriteStore -> role JSON file on disk
// + a scenario_data upsert in Supabase), so the value is durable in both stores and the
// write path is production's, not a bespoke one. Idempotent: a role that already carries
// the target archetype is reported and skipped without a write.
//
// Step 1 of ARCHETYPE-GATED ARTIFACT GENERATION. Nothing gates on these values yet — the
// classifier, the gating table and the confirm UI land in later steps. This script exists
// because the four archetypes were decided by hand against the record (the Lojka lesson:
// the classifier proposes, a human confirms), and those confirmed labels are the fixtures
// every later step is validated against.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DualWriteStore } from '../lib/DualWriteStore.js';
import { ScenarioRepository } from '../engine/repositories/ScenarioRepository.js';
import { ROLE_ARCHETYPES, isRoleArchetype, roleArchetype } from '../engine/admin/adminRouter.js';
import { supabase } from '../lib/supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir   = path.resolve(__dirname, '../engine/data');
const ROLES_DIR = path.join(dataDir, 'scenarios/player_roles');

// The confirmed labels. Each line is a human judgement about the role, not a guess the
// engine made — see the reasoning in the comment beside it.
const ASSIGNMENTS = [
  // Open outcome, real agency, knows what she is deciding. The shipping fork exemplar.
  ['role_trude_harms', 'crucible-open'],
  // Jäger: documented figure, fixed outcome (the gate opens), but the fork is real — the
  // proof that fork + epilogue carries the reflection with no graded endings behind it.
  ['role_gatekeeper',  'crucible-fixed'],
  // Princip: acts WITH foreknowledge — pistol, mission, the positions of all seven
  // conspirators in startingKnowledge. Culpable, therefore a crucible, not an instrument.
  ['role_princip',     'crucible-fixed'],
  // Lojka: same character_type/fate_mode as Princip, opposite archetype. His own
  // roleInitialState says route_change_received:false and his briefing card is the
  // ORIGINAL route only — he acts, but without the foreknowledge a fork requires.
  ['role_lojka',       'instrument'],
  // Mila: "no special knowledge, no authority, and no power over events".
  ['role_mila',        'witness'],
  // The Chronicler: "a professional witness". Conduct is not a hinge.
  ['role_chronicler',  'witness'],
];

const DRY = process.argv.includes('--dry-run');

// Byte-level before/after comparison of the role file. The write must add exactly one key
// and touch exactly one other (updatedAt, stamped by the store on every save) — anything
// else means the whole-object save dropped or rewrote something.
function diffKeys(beforeRaw, afterRaw) {
  const a = JSON.parse(beforeRaw), b = JSON.parse(afterRaw);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const added = [], removed = [], changed = [];
  for (const k of keys) {
    const inA = Object.prototype.hasOwnProperty.call(a, k);
    const inB = Object.prototype.hasOwnProperty.call(b, k);
    if (!inA) { added.push(k); continue; }
    if (!inB) { removed.push(k); continue; }
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k);
  }
  return { added, removed, changed };
}

const store = new DualWriteStore(dataDir);
const repos = { scenarios: new ScenarioRepository(store) };

let failures = 0;

for (const [roleId, archetype] of ASSIGNMENTS) {
  if (!isRoleArchetype(archetype)) {
    console.error(`FAIL ${roleId}: "${archetype}" is not one of ${ROLE_ARCHETYPES.join(', ')}`);
    failures++;
    continue;
  }
  const file = path.join(ROLES_DIR, `${roleId}.json`);
  if (!fs.existsSync(file)) {
    console.error(`FAIL ${roleId}: no such role file (${file})`);
    failures++;
    continue;
  }
  const beforeRaw = fs.readFileSync(file, 'utf8');
  const role = JSON.parse(beforeRaw);

  if (role.archetype === archetype) {
    console.log(`SKIP ${roleId.padEnd(18)} already ${archetype}`);
    continue;
  }
  if (DRY) {
    console.log(`DRY  ${roleId.padEnd(18)} ${roleArchetype(role)} -> ${archetype}`);
    continue;
  }

  repos.scenarios.savePlayerRole({ ...role, archetype });

  const afterRaw = fs.readFileSync(file, 'utf8');
  const after    = JSON.parse(afterRaw);
  const d        = diffKeys(beforeRaw, afterRaw);
  const expectedAdded   = role.archetype === undefined ? ['archetype'] : [];
  const expectedChanged = ['updatedAt', ...(role.archetype === undefined ? [] : ['archetype'])];
  const ok =
    after.archetype === archetype &&
    d.removed.length === 0 &&
    JSON.stringify(d.added.sort())   === JSON.stringify(expectedAdded.sort()) &&
    JSON.stringify(d.changed.sort()) === JSON.stringify(expectedChanged.sort());

  if (ok) {
    console.log(`OK   ${roleId.padEnd(18)} archetype=${after.archetype}  (added:${d.added.join(',') || '-'} changed:${d.changed.join(',')})`);
  } else {
    console.error(`FAIL ${roleId}: unexpected file delta — added:[${d.added}] removed:[${d.removed}] changed:[${d.changed}] archetype=${after.archetype}`);
    failures++;
  }
}

// Supabase is written fire-and-forget by DualWriteStore, so verify it explicitly rather
// than trusting an unawaited promise. A store that is unreachable is REPORTED, never
// silently treated as success — the disk write has already happened either way.
if (!DRY) {
  console.log('\nSupabase verification:');
  await new Promise(r => setTimeout(r, 2000));
  for (const [roleId, archetype] of ASSIGNMENTS) {
    try {
      const { data, error } = await supabase
        .from('scenario_data')
        .select('data')
        .eq('data_type', 'player_role')
        .eq('id', roleId)
        .limit(1);
      if (error) throw error;
      const remote = data?.[0]?.data;
      if (!remote)                          console.warn(`  ??  ${roleId.padEnd(18)} no row returned`);
      else if (remote.archetype === archetype) console.log(`  OK  ${roleId.padEnd(18)} archetype=${remote.archetype}`);
      else                                  { console.error(`  FAIL ${roleId.padEnd(18)} remote archetype=${remote.archetype ?? '(absent)'}`); failures++; }
    } catch (err) {
      console.warn(`  ??  ${roleId.padEnd(18)} unverified — ${err.message}`);
    }
  }
}

console.log(failures ? `\n${failures} failure(s).` : '\nAll assignments verified on disk.');
process.exit(failures ? 1 : 0);
