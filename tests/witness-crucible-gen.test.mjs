// WITNESS-CRUCIBLE GENERATOR — the defining-moment generator's witness path, built in stages.
//
//   Stage 1  the witness_crucible flag: gate (server + editor mirror), save guard, and the
//            route precondition (no confirmed lever → refused before any model call)
//
// SYNTHETIC FIXTURES ONLY. Every role, scenario and arc here lives in a temp JsonFileStore
// made for this run and deleted after it; no real role file, no Supabase, no tracked file is
// written. api.anthropic.com is never reached in Stage 1.

import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;

const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { CharacterRepository } = await import(`${ROOT}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { ClueRepository }      = await import(`${ROOT}/engine/repositories/ClueRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
const { PlayerRepository }    = await import(`${ROOT}/engine/repositories/PlayerRepository.js`);
const { SessionRepository }   = await import(`${ROOT}/engine/repositories/SessionRepository.js`);
const admin = await import(`${ROOT}/engine/admin/adminRouter.js`);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

// ── fixtures ──────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-gen-'));
const store = new JsonFileStore(TMP);
const SCENARIO_ID = 'wc_fixture_trial';
const SCENARIO = {
  id: SCENARIO_ID, title: 'The Fixture Trial', premise: 'A court sits on a prisoner whose sentence is already decided.',
  sessionTargetMinutes: 30,
  introduction: { sections: [{ type: 'entry', character_entries: {
    role_wc_usher: 'You carry the summons down the corridor, as you have every morning. The prisoner looks up when the door opens.',
  } }] },
};
class FixtureScenarios extends ScenarioRepository {
  async findById(id) { return id === SCENARIO_ID ? structuredClone(SCENARIO) : null; }
}
const repos = {
  scenarios:  new FixtureScenarios(store),
  characters: new CharacterRepository(store),
  locations:  new LocationRepository(store),
  clues:      new ClueRepository(store),
  storyArcs:  new StoryArcRepository(store),
  players:    new PlayerRepository(store),
  sessions:   new SessionRepository(store),
};
const baseRole = { scenarioId: SCENARIO_ID, character_type: 'real', fate_mode: 'anchored', description: 'fixture' };
const ROLES = {
  role_wc_usher:      { ...baseRole, id: 'role_wc_usher',      name: 'The Usher',      archetype: 'witness',    witness_crucible: true },
  role_wc_bystander:  { ...baseRole, id: 'role_wc_bystander',  name: 'The Bystander',  archetype: 'witness' },
  role_wc_instrument: { ...baseRole, id: 'role_wc_instrument', name: 'The Instrument', archetype: 'instrument', witness_crucible: true },
  role_wc_confirmed:  { ...baseRole, id: 'role_wc_confirmed',  name: 'The Clerk',      archetype: 'witness',    witness_crucible: true,
                        witness_lever: { axis: 'documentary_record', confirmed: true } },
};
for (const r of Object.values(ROLES)) repos.scenarios.savePlayerRole(r);

const app = express();
app.use(express.json());
app.use('/admin/api', admin.createAdminRouter(repos, { anthropicApiKey: 'test-key-not-used' }));
const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}/admin/api`;
const post = async (url, body) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const genUrl = id => `/scenarios/${SCENARIO_ID}/roles/${id}/generate-defining-moment`;

// The editor's own copy of the gate, evaluated from index.html the way gating.test does.
const html   = fs.readFileSync(path.join(REPO_DIR, 'engine/admin/index.html'), 'utf8');
const script = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/i.exec(html)[1];
const noop = () => {};
const el = new Proxy({}, { get: (t, k) => (k === 'value' ? '' : k === 'style' ? {} : k === 'classList' ? { add: noop, remove: noop } : noop) });
const ctx = vm.createContext({
  document: { addEventListener: noop, getElementById: () => el, querySelector: () => el, querySelectorAll: () => [], createElement: () => el, body: el, documentElement: el, head: el },
  window: {}, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { search: '', href: '', pathname: '/admin/' }, navigator: { clipboard: {} },
  fetch: async () => ({ ok: true, json: async () => ({}) }), console: { ...console, log: noop }, setTimeout, clearTimeout, alert: noop, confirm: () => false, prompt: () => null,
  URLSearchParams, JSON, Math, Date, Object, Array, String, Number, Boolean, Set, Map, RegExp, Error, Promise, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
});
ctx.window = ctx;
try { vm.runInContext(script, ctx, { filename: 'index.html<script>' }); } catch { /* render fns still defined */ }

try {
  // ═══ STAGE 1 ═══════════════════════════════════════════════════════════════
  head('1a. the gate — server policy');
  const MATRIX = [
    ['flagged witness',                { archetype: 'witness', witness_crucible: true },     true,  'witness-crucible'],
    ['unflagged witness (bystander)',  { archetype: 'witness' },                             false, undefined],
    ['witness, flag false',            { archetype: 'witness', witness_crucible: false },    false, undefined],
    ['witness, flag "true" (string)',  { archetype: 'witness', witness_crucible: 'true' },   false, undefined],
    ['flagged instrument',             { archetype: 'instrument', witness_crucible: true },  false, undefined],
    ['crucible-fixed',                 { archetype: 'crucible-fixed' },                      true,  'protagonist'],
    ['crucible-fixed, stray flag',     { archetype: 'crucible-fixed', witness_crucible: true }, true, 'protagonist'],
    ['unclassified',                   {},                                                   true,  'protagonist'],
  ];
  for (const [label, role, allowed, p] of MATRIX) {
    const g = admin.archetypeAllows(role, 'fork');
    check(`${label.padEnd(30)} fork ${allowed ? `allowed on ${p}` : 'REFUSED'}`, g.allowed === allowed && g.path === p, `${g.allowed} ${g.path ?? ''}`);
  }
  check('flagged witness: graded endings still refused', admin.archetypeAllows({ archetype: 'witness', witness_crucible: true }, 'graded_endings').allowed === false);
  check('bystander refusal names the witness-crucible flag as the way through',
    /witness_crucible/.test(admin.archetypeAllows({ archetype: 'witness' }, 'fork').reason));

  head('1b. the gate — editor mirror agrees with the server');
  check('editor archetypeAllows reachable', typeof ctx.archetypeAllows === 'function' && typeof ctx.isWitnessCrucible === 'function');
  for (const [label, role] of MATRIX) for (const artifact of ['fork', 'graded_endings']) {
    const s = admin.archetypeAllows(role, artifact), c = ctx.archetypeAllows(role, artifact);
    check(`${label.padEnd(30)} ${artifact.padEnd(14)} client == server`,
      s.allowed === c.allowed && s.path === c.path && (s.reason || '') === (c.reason || ''));
  }

  head('1c. editor-save guard — witness_crucible');
  const stubRepos = stored => ({ scenarios: { findPlayerRole: () => stored } });
  const guard = (posted, stored) => admin.preserveStoredRoleBlocks(stubRepos(stored), { id: 'role_x', ...posted });
  check('stale tab (key absent) → stored flag restored', guard({}, { id: 'role_x', witness_crucible: true }).witness_crucible === true);
  check('form posts "true" → stored as boolean true', guard({ witness_crucible: 'true' }, { id: 'role_x' }).witness_crucible === true);
  check('form posts "false" → cleared to NO key', !('witness_crucible' in guard({ witness_crucible: 'false' }, { id: 'role_x', witness_crucible: true })));
  check('form posts false → cleared to NO key', !('witness_crucible' in guard({ witness_crucible: false }, { id: 'role_x', witness_crucible: true })));
  check('never flagged, key absent → still no key', !('witness_crucible' in guard({}, { id: 'role_x' })));

  head('1d. the route — precondition before any model call');
  {
    const r = await post(genUrl('role_wc_usher'), { overwrite: true });
    check('flagged witness, no lever → 422 LEVER_UNCONFIRMED', r.status === 422 && r.body.code === 'LEVER_UNCONFIRMED' && r.body.path === 'witness-crucible', `${r.status} ${r.body.code}`);
  }
  {
    const r = await post(genUrl('role_wc_bystander'), { overwrite: true });
    check('unflagged witness → 422 archetype refusal (unchanged shape)', r.status === 422 && r.body.refused === true && r.body.error === admin.archetypeAllows(ROLES.role_wc_bystander, 'fork').reason && !r.body.code);
  }
  {
    const r = await post(genUrl('role_wc_instrument'), { overwrite: true });
    check('flagged instrument → 422 instrument refusal', r.status === 422 && /^Instrument role/.test(r.body.error || ''));
  }
  {
    const r = await post(genUrl('role_wc_confirmed'), { overwrite: true });
    check('flagged witness, confirmed lever → never reaches the protagonist prompt (501 pending)', r.status === 501 && r.body.code === 'WITNESS_PATH_PENDING', `${r.status}`);
  }
  check('no route call wrote a fixture role', Object.keys(ROLES).every(id => !repos.scenarios.findPlayerRole(id).defining_moment));
} finally {
  await new Promise(r => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll witness-crucible-gen assertions passed.');
process.exitCode = fails ? 1 : 0;
