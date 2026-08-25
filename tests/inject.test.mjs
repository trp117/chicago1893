// STEP 5b — the bulk "Apply to All Roles" path (POST /pipeline/inject-ending-notes).
// The legacy Gemini copy-paste route, reached from the AI Response Injector panel at the
// foot of the scenario editor. It writes ending_notes straight to role files with no review
// gate, so it must respect the same ARCHETYPE_ARTIFACTS policy as the per-role button.
//
// Runs against schiller_corner_1914, which already holds one role of each forbidden
// archetype (Lojka instrument, Princip crucible-fixed, Mila witness). Two scratch roles are
// added to the same scenario to supply the ALLOWED cases and are destroyed afterwards. The
// three real roles are byte-compared before and after: they must not be written to at all.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Resolve the repo from this file's own location, so the suite runs from anywhere.
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = pathToFileURL(REPO_DIR).href;

const DATA_DIR = path.join(REPO_DIR, 'engine/data');
const SCENARIO = 'schiller_corner_1914';

const express = (await import('express')).default;
const { JsonFileStore }       = await import(`${REPO_URL}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository }  = await import(`${REPO_URL}/engine/repositories/ScenarioRepository.js`);
const { CharacterRepository } = await import(`${REPO_URL}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }  = await import(`${REPO_URL}/engine/repositories/LocationRepository.js`);
const { ClueRepository }      = await import(`${REPO_URL}/engine/repositories/ClueRepository.js`);
const { StoryArcRepository }  = await import(`${REPO_URL}/engine/repositories/StoryArcRepository.js`);
const { PlayerRepository }    = await import(`${REPO_URL}/engine/repositories/PlayerRepository.js`);
const { SessionRepository }   = await import(`${REPO_URL}/engine/repositories/SessionRepository.js`);
const admin = await import(`${REPO_URL}/engine/admin/adminRouter.js`);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};

// File-only store: this test asserts on role files, and nothing here should reach Supabase.
const store = new JsonFileStore(DATA_DIR);
const repos = {
  scenarios:  new ScenarioRepository(store),  characters: new CharacterRepository(store),
  locations:  new LocationRepository(store),  clues:      new ClueRepository(store),
  storyArcs:  new StoryArcRepository(store),  players:    new PlayerRepository(store),
  sessions:   new SessionRepository(store),
};
const fileOf   = id => path.join(DATA_DIR, 'scenarios/player_roles', `${id}.json`);
const readRole = id => JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
const rawOf    = id => fs.readFileSync(fileOf(id), 'utf8');

const app = express();
app.use(express.json());
app.use('/admin/api', admin.createAdminRouter(repos, { anthropicApiKey: 'test-key-not-used' }));
const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}/admin/api`;

const OPEN_ID  = 'role_inject_scratch_open';
const UNCL_ID  = 'role_inject_scratch_unclassified';
const OPEN_NM  = 'Scratch Open — Inject Test';
const UNCL_NM  = 'Scratch Unclassified — Inject Test';

// One note shape for every role, so the only thing separating them is the archetype.
const noteFor = name => ({
  role_name: name,
  partial: { what_happened: `INJECTED partial for ${name}.`, who_present: 'nobody', emotional_weight: 'weight', closing_line: 'A line.' },
  failure: { what_happened: `INJECTED failure for ${name}.`, who_present: 'nobody', emotional_weight: 'weight', closing_line: 'A line.' },
});

const FORBIDDEN = [
  ['role_lojka',      'instrument'],
  ['role_princip',    'crucible-fixed'],
  ['role_mila',       'witness'],
];

const versionsDir = path.join(DATA_DIR, 'scenarios/versions', SCENARIO);
const versionsBefore = fs.existsSync(versionsDir) ? new Set(fs.readdirSync(versionsDir)) : new Set();

try {
  console.log('\n[1] fixtures — a mixed-archetype scenario\n');
  for (const [id, name, archetype] of [[OPEN_ID, OPEN_NM, 'crucible-open'], [UNCL_ID, UNCL_NM, undefined]]) {
    const role = { id, name, scenarioId: SCENARIO, description: 'Temporary fixture created by tests/inject.test.mjs.',
                   fate_mode: 'committed', character_type: 'fictional' };
    if (archetype) role.archetype = archetype;
    repos.scenarios.savePlayerRole(role);
  }
  store._cache.clear();
  check('scratch crucible-open role created', admin.roleArchetype(readRole(OPEN_ID)) === 'crucible-open');
  check('scratch unclassified role created (no archetype key)', readRole(UNCL_ID).archetype === undefined);
  for (const [id, expect] of FORBIDDEN) {
    check(`${id.padEnd(14)} is ${expect}`, admin.roleArchetype(readRole(id)) === expect, admin.roleArchetype(readRole(id)));
    check(`${id.padEnd(14)} graded endings forbidden by policy`, admin.archetypeAllows(readRole(id), 'graded_endings').allowed === false);
  }

  const rawBefore = Object.fromEntries(FORBIDDEN.map(([id]) => [id, rawOf(id)]));

  console.log('\n[2] "Apply to All Roles" against the whole scenario\n');
  const payload = {
    ending_notes: [
      noteFor('Leopold Lojka — The Chauffeur'),
      noteFor('Gavrilo Princip — The Assassin'),
      noteFor('Mila Vidaković — The Witness'),
      noteFor(OPEN_NM),
      noteFor(UNCL_NM),
      noteFor('A Role That Does Not Exist'),     // the pre-existing unmatched path
    ],
  };
  const r = await fetch(`${base}/pipeline/inject-ending-notes/${SCENARIO}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await r.json();
  check('request succeeded', r.status === 200 && body.success === true, `${r.status}`);
  store._cache.clear();

  console.log('\n[3] ALLOWED roles were written\n');
  for (const id of [OPEN_ID, UNCL_ID]) {
    const en = readRole(id).ending_notes;
    check(`${id.padEnd(34)} received ending_notes`, !!en?.partial?.what_happened && /^INJECTED/.test(en.partial.what_happened));
  }
  check('rolesUpdated counts only the allowed roles', body.rolesUpdated === 2, String(body.rolesUpdated));

  console.log('\n[4] FORBIDDEN roles were NOT written — byte-verified\n');
  for (const [id, archetype] of FORBIDDEN) {
    check(`${id.padEnd(14)} (${archetype}) file byte-identical`, rawOf(id) === rawBefore[id]);
    const en = readRole(id).ending_notes;
    check(`${id.padEnd(14)} carries no INJECTED prose`,
          !en || !JSON.stringify(en).includes('INJECTED'),
          en ? 'pre-existing ending_notes untouched' : 'no ending_notes');
  }
  check('Lojka (instrument) NOT written to',   rawOf('role_lojka')   === rawBefore['role_lojka']);
  check('Princip (crucible-fixed) NOT written to', rawOf('role_princip') === rawBefore['role_princip']);

  console.log('\n[5] the response reports the skips, beside the unmatched names\n');
  const skipped = body.skipped || [];
  check('three roles reported skipped', skipped.length === 3, String(skipped.length));
  for (const [id, archetype] of FORBIDDEN) {
    const name = readRole(id).name;
    const row  = skipped.find(sk => sk.role_name === name);
    check(`${id.padEnd(14)} reported with its archetype`, row?.archetype === archetype, row?.archetype);
    check(`${id.padEnd(14)} reported with the policy's own reason`,
          row?.reason === admin.archetypeAllows(readRole(id), 'graded_endings').reason);
  }
  check('the pre-existing unmatched report still works',
        (body.unmatched || []).length === 1 && body.unmatched[0] === 'A Role That Does Not Exist',
        (body.unmatched || []).join(','));

  console.log('\n[6] a note with no ending fields is not skipped by this gate\n');
  {
    // The gate governs GRADED ENDINGS. A note that carries none is not an endings write, so
    // it must pass even on a forbidden role — otherwise the filter would quietly become a
    // ban on editing those roles at all.
    const before = rawOf('role_mila');
    const r2 = await fetch(`${base}/pipeline/inject-ending-notes/${SCENARIO}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ending_notes: [{ role_name: 'Mila Vidaković — The Witness', suggested_secret: 'A test secret.' }] }),
    });
    const b2 = await r2.json();
    store._cache.clear();
    check('a non-endings note is applied to a witness role', b2.rolesUpdated === 1 && (b2.skipped || []).length === 0);
    check('…and it really landed', readRole('role_mila').suggested_secret === 'A test secret.');
    // Put Mila back exactly as she was.
    fs.writeFileSync(fileOf('role_mila'), before, 'utf8');
    store._cache.clear();
    check('Mila restored byte-for-byte', rawOf('role_mila') === before);
  }
} finally {
  server.close();
  for (const id of [OPEN_ID, UNCL_ID]) repos.scenarios.deletePlayerRole(id);
  store._cache.clear();
  check('scratch fixtures removed', !fs.existsSync(fileOf(OPEN_ID)) && !fs.existsSync(fileOf(UNCL_ID)));

  // applyEndingNotesToRoles snapshots the scenario on every call; drop the snapshots this
  // test caused so a test run does not silently grow the version history.
  if (fs.existsSync(versionsDir)) {
    for (const file of fs.readdirSync(versionsDir)) {
      if (!versionsBefore.has(file)) fs.unlinkSync(path.join(versionsDir, file));
    }
    check('version snapshots created by this test cleaned up',
          fs.readdirSync(versionsDir).every(f => versionsBefore.has(f)));
  }

  for (const id of ['role_trude_harms', 'role_gatekeeper', 'role_princip', 'role_lojka', 'role_mila', 'role_chronicler']) {
    check(`${id.padEnd(18)} untouched`, readRole(id).updatedAt.startsWith('2026-08-24T22:18:26'), readRole(id).archetype);
  }
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll bulk-inject gating tests passed.');
process.exit(fails ? 1 : 0);
