#!/usr/bin/env node
// Run the archetype classifier over player roles and print what it PROPOSES.
//
//   node scripts/propose-archetypes.mjs                    # the six confirmed roles
//   node scripts/propose-archetypes.mjs role_lojka …       # specific role ids
//   node scripts/propose-archetypes.mjs --scenario <id>    # every role in one scenario
//
// READ-ONLY. It calls the classifier and prints. It does not save a role, does not touch
// Supabase, and does not create a pipeline — the classifier itself writes nothing, and this
// harness reads through a plain JsonFileStore so there is no dual-write path to reach.
//
// This is the validation harness for step 2: the six roles below carry archetypes a human
// confirmed by hand against the record, so running the classifier against them measures the
// classifier, not the roles. The one that matters is role_lojka — same character_type and
// fate_mode as role_princip, opposite archetype, and the case the old fork classifier got
// wrong by construction.
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonFileStore } from '../engine/repositories/JsonFileStore.js';
import { ScenarioRepository } from '../engine/repositories/ScenarioRepository.js';
import { classifyRoleArchetype, roleArchetype } from '../engine/admin/adminRouter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir   = path.resolve(__dirname, '../engine/data');

// The confirmed labels from step 1 — what a human decided, and therefore what "correct"
// means here. Absent from this map, a role is simply reported with no verdict.
const CONFIRMED = {
  role_trude_harms: 'crucible-open',
  role_gatekeeper:  'crucible-fixed',
  role_princip:     'crucible-fixed',
  role_lojka:       'instrument',
  role_mila:        'witness',
  role_chronicler:  'witness',
};

const store = new JsonFileStore(dataDir);
const repos = { scenarios: new ScenarioRepository(store) };

const argv = process.argv.slice(2);
const scenarioFlag = argv.indexOf('--scenario');
let roleIds;
if (scenarioFlag !== -1) {
  roleIds = repos.scenarios.findPlayerRoles(argv[scenarioFlag + 1]).map(r => r.id);
} else {
  roleIds = argv.filter(a => !a.startsWith('--'));
  if (!roleIds.length) roleIds = Object.keys(CONFIRMED);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('ANTHROPIC_API_KEY is not set.'); process.exit(1); }

const wrap = (s, indent = 6) => String(s ?? '')
  .split(/\s+/).reduce((lines, w) => {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + w).length <= 92) lines[lines.length - 1] = last + ' ' + w;
    else lines.push(w);
    return lines;
  }, [])
  .map(l => ' '.repeat(indent) + l).join('\n');

const results = [];

for (const roleId of roleIds) {
  const role = repos.scenarios.findPlayerRole(roleId);
  if (!role) { console.error(`\n!! ${roleId}: no such role`); continue; }
  const scenario = await repos.scenarios.findById(role.scenarioId);
  if (!scenario) { console.error(`\n!! ${roleId}: scenario ${role.scenarioId} not found`); continue; }

  let p;
  try {
    p = await classifyRoleArchetype(scenario, role, apiKey);
  } catch (err) {
    console.error(`\n!! ${roleId}: ${err.message}`);
    results.push({ roleId, error: err.message });
    continue;
  }

  const confirmed = CONFIRMED[roleId] ?? roleArchetype(role);
  const known     = CONFIRMED[roleId] !== undefined;
  const verdict   = !known ? '(no confirmed label)' : p.archetype === confirmed ? 'MATCH' : 'MISMATCH';
  results.push({ roleId, proposed: p.archetype, confirmed, verdict, confidence: p.confidence });

  console.log(`\n${'═'.repeat(96)}`);
  console.log(`${p.roleName}  [${roleId}]`);
  console.log(`  proposed : ${p.archetype}`);
  console.log(`  confirmed: ${confirmed}   →  ${verdict}`);
  console.log(`  family=${p.family}  axis=${p.axis} (fate_mode=${p.fate_mode ?? 'unset'})  confidence=${p.confidence}`);
  if (p.axis_note) console.log(`  !! ${p.axis_note}`);
  console.log(`  TEST 1 hinge: ${p.hinge?.passed ? 'PASSED' : 'failed'}${p.hinge?.moment ? ` — ${p.hinge.moment}` : ''}`);
  if (p.hinge?.why) console.log(wrap(p.hinge.why));
  console.log(`  TEST 2 foreknowledge: ${p.foreknowledge?.verdict}`);
  if (p.foreknowledge?.why) console.log(wrap(p.foreknowledge.why));
  for (const e of (p.foreknowledge?.evidence || [])) console.log(wrap('· ' + e, 6));
  console.log('  REASONING:');
  console.log(wrap(p.reasoning));
  console.log('  COUNTER-CASE:');
  console.log(wrap(p.counter_case));
}

console.log(`\n${'═'.repeat(96)}\nSUMMARY (nothing was written)\n`);
for (const r of results) {
  if (r.error) { console.log(`  ERROR     ${r.roleId.padEnd(18)} ${r.error}`); continue; }
  console.log(`  ${r.verdict.padEnd(9)} ${r.roleId.padEnd(18)} proposed=${String(r.proposed).padEnd(15)} confirmed=${String(r.confirmed).padEnd(15)} confidence=${r.confidence}`);
}
const scored = results.filter(r => r.verdict === 'MATCH' || r.verdict === 'MISMATCH');
if (scored.length) console.log(`\n  ${scored.filter(r => r.verdict === 'MATCH').length}/${scored.length} match the confirmed labels.`);
