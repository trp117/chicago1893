// STEP 1 — the archetype property and its editor-save guard.
// Proves the three save-path guards (ending_notes, defining_moment, archetype) survive a
// stale editor tab, that an explicitly sent value is honoured, and that legacy roles with no
// archetype read as 'unclassified' without crashing.
//
// Touches real role files and restores them byte-for-byte. No API calls, no Supabase.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Resolve the repo from this file's own location, so the suite runs from anywhere.
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = pathToFileURL(REPO_DIR).href;

const ROOT = REPO_URL;
const { JsonFileStore }      = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository } = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const admin                  = await import(`${ROOT}/engine/admin/adminRouter.js`);
const { preserveStoredRoleBlocks, stripEmptyEndingNotes, roleArchetype } = admin;

const DATA_DIR  = path.join(REPO_DIR, 'engine/data');
const ROLES_DIR = path.join(DATA_DIR, 'scenarios/player_roles');

// Plain JsonFileStore, not DualWriteStore: the guard is store-agnostic and this test must
// not push throwaway writes to Supabase.
const store = new JsonFileStore(DATA_DIR);
const repos = { scenarios: new ScenarioRepository(store) };

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const fileOf   = id => path.join(ROLES_DIR, `${id}.json`);
const readRole = id => JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));

// Exactly what a STALE editor tab posts: the whole role object rebuilt from a form that
// was rendered before these fields existed, so archetype and defining_moment are ABSENT
// and the ending_notes sub-objects arrive with every string blank.
function staleTabPayload(role) {
  const p = JSON.parse(JSON.stringify(role));
  delete p.archetype;
  delete p.defining_moment;
  p.ending_notes = {
    partial: { what_happened: '', who_present: '', emotional_weight: '', closing_line_override: '' },
    failure: { what_happened: '', who_present: '', emotional_weight: '', closing_line_override: '' },
  };
  return p;
}

function assertIntact(orig, after) {
  const kBefore = Object.keys(orig), kAfter = Object.keys(after);
  check('same key set — nothing dropped or invented',
        JSON.stringify([...kBefore].sort()) === JSON.stringify([...kAfter].sort()));
  const changed = kBefore.filter(k => k !== 'updatedAt' && JSON.stringify(orig[k]) !== JSON.stringify(after[k]));
  check('no value changed except updatedAt', changed.length === 0, changed.length ? changed.join(',') : 'all values identical');
  const reordered = kBefore.filter((k, i) => kAfter[i] !== k);
  console.log(`      note: key ORDER ${reordered.length ? 'shifts (a restored key is re-appended) — pre-existing guard behaviour, meaningless to every reader' : 'unchanged'}`);
}

// ── Test 2a — /generate/save composition, stale tab ──────────────────────────
{
  const ID = 'role_gatekeeper';
  const before = fs.readFileSync(fileOf(ID), 'utf8');
  const orig   = JSON.parse(before);
  console.log(`\n[2a] /generate/save (bulk editor save) — stale tab on ${ID}`);
  console.log(`     stored: archetype=${orig.archetype}  defining_moment=${orig.defining_moment?.id}  ending_notes=[${Object.keys(orig.ending_notes || {})}]`);

  // The exact line from adminRouter.js /generate/save (normalizeBriefing omitted — it only
  // coerces a non-string briefing, and this role's briefing is already a string).
  repos.scenarios.savePlayerRole(stripEmptyEndingNotes(preserveStoredRoleBlocks(repos, staleTabPayload(orig))));

  const after = readRole(ID);
  check('archetype survives',       after.archetype === orig.archetype, `got ${after.archetype}`);
  check('defining_moment survives', after.defining_moment?.id === orig.defining_moment?.id, `got ${after.defining_moment?.id}`);
  check('ending_notes survive',     JSON.stringify(after.ending_notes) === JSON.stringify(orig.ending_notes), `keys=[${Object.keys(after.ending_notes || {})}]`);
  assertIntact(orig, after);
  fs.writeFileSync(fileOf(ID), before, 'utf8');
  store._cache.clear();
}

// ── Test 2b — PUT /player-roles/:id composition, stale tab ───────────────────
{
  const ID = 'role_princip';
  const before = fs.readFileSync(fileOf(ID), 'utf8');
  const orig   = JSON.parse(before);
  console.log(`\n[2b] PUT /player-roles/:id (single-role editor save) — stale tab on ${ID}`);

  // The exact line from adminRouter.js PUT /player-roles/:id.
  repos.scenarios.savePlayerRole(preserveStoredRoleBlocks(repos, { ...staleTabPayload(orig), id: ID }));

  const after = readRole(ID);
  check('archetype survives',       after.archetype === orig.archetype, `got ${after.archetype}`);
  check('defining_moment survives', after.defining_moment?.id === orig.defining_moment?.id, `got ${after.defining_moment?.id}`);
  check('ending_notes survive (all three branches)',
        ['success', 'partial', 'failure'].every(b => JSON.stringify(after.ending_notes?.[b]) === JSON.stringify(orig.ending_notes?.[b])),
        `keys=[${Object.keys(after.ending_notes || {})}]`);
  assertIntact(orig, after);
  fs.writeFileSync(fileOf(ID), before, 'utf8');
  store._cache.clear();
}

// ── Test 2c — a FRESH tab that sends a value is honored, not overwritten ─────
{
  const ID = 'role_mila';
  const before = fs.readFileSync(fileOf(ID), 'utf8');
  const orig   = JSON.parse(before);
  console.log(`\n[2c] fresh tab sends a DIFFERENT archetype on ${ID} (stored=${orig.archetype})`);

  repos.scenarios.savePlayerRole(preserveStoredRoleBlocks(repos, { ...JSON.parse(before), archetype: 'instrument' }));
  check('client value honored — guard did NOT restore stored', readRole(ID).archetype === 'instrument', `got ${readRole(ID).archetype}`);

  fs.writeFileSync(fileOf(ID), before, 'utf8');
  store._cache.clear();
  check('restored to the confirmed value', readRole(ID).archetype === orig.archetype, `got ${readRole(ID).archetype}`);
}

// ── Test 3 — legacy roles with no archetype ─────────────────────────────────
{
  console.log('\n[3] legacy roles (no archetype stored)');
  const all = fs.readdirSync(ROLES_DIR).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(ROLES_DIR, f), 'utf8')));
  const legacy = all.filter(r => r.archetype === undefined);
  check('every legacy role reads as unclassified',
        legacy.every(r => roleArchetype(r) === 'unclassified'), `${legacy.length} legacy roles checked`);
  check('roleArchetype tolerates absent / null / empty / junk / wrong-type',
        [undefined, null, {}, { archetype: null }, { archetype: '' }, { archetype: 'nonsense' }, { archetype: 42 }]
          .every(r => roleArchetype(r) === 'unclassified'));
  check('roleArchetype returns every value in the set verbatim',
        admin.ROLE_ARCHETYPES.every(a => roleArchetype({ archetype: a }) === a));

  const ID = legacy[0].id;
  const before = fs.readFileSync(fileOf(ID), 'utf8');
  repos.scenarios.savePlayerRole(preserveStoredRoleBlocks(repos, JSON.parse(before)));
  const after = readRole(ID);
  check(`legacy save invents no archetype key (${ID})`, !('archetype' in after));
  assertIntact(JSON.parse(before), after);
  fs.writeFileSync(fileOf(ID), before, 'utf8');
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll guard tests passed.');
process.exit(fails ? 1 : 0);
