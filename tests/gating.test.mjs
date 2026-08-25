// STEP 3 — the artifact gating table (THE SAFEGUARD).
// Proves the policy, the editor's rendered buttons, and both server routes agree, and that
// the archetype gate COMPOSES with the pre-existing hand-authored / overwrite protection
// rather than replacing it.
//
// Read-only against role files. No model calls: the allow-cases are steered at a bogus
// scenario id so they die on the pre-existing not-found before any generator runs.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Resolve the repo from this file's own location, so the suite runs from anywhere.
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = pathToFileURL(REPO_DIR).href;
import vm from 'vm';

const ROOT_URL = REPO_URL;
const ROOT     = REPO_DIR;
const DATA_DIR = path.join(ROOT, 'engine/data');

const express = (await import('express')).default;
const { JsonFileStore }       = await import(`${ROOT_URL}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository }  = await import(`${ROOT_URL}/engine/repositories/ScenarioRepository.js`);
const { CharacterRepository } = await import(`${ROOT_URL}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }  = await import(`${ROOT_URL}/engine/repositories/LocationRepository.js`);
const { ClueRepository }      = await import(`${ROOT_URL}/engine/repositories/ClueRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT_URL}/engine/repositories/StoryArcRepository.js`);
const { PlayerRepository }    = await import(`${ROOT_URL}/engine/repositories/PlayerRepository.js`);
const { SessionRepository }   = await import(`${ROOT_URL}/engine/repositories/SessionRepository.js`);
const admin = await import(`${ROOT_URL}/engine/admin/adminRouter.js`);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};

// Plain JsonFileStore: read-only intent, and no dual-write path to Supabase can be reached
// even if something unexpectedly wrote.
const store = new JsonFileStore(DATA_DIR);
const repos = {
  scenarios:  new ScenarioRepository(store),
  characters: new CharacterRepository(store),
  locations:  new LocationRepository(store),
  clues:      new ClueRepository(store),
  storyArcs:  new StoryArcRepository(store),
  players:    new PlayerRepository(store),
  sessions:   new SessionRepository(store),
};
const roleOf = id => repos.scenarios.findPlayerRole(id);

const LEGACY = repos.scenarios.findPlayerRoles().find(r => r.archetype === undefined && !r.fate_mode);
const LEGACY_WITH_FATE = repos.scenarios.findPlayerRoles().find(r => r.archetype === undefined && r.fate_mode);

const CASES = [
  ['role_trude_harms', 'crucible-open',  { fork: true,  graded_endings: true  }],
  ['role_gatekeeper',  'crucible-fixed', { fork: true,  graded_endings: false }],
  ['role_princip',     'crucible-fixed', { fork: true,  graded_endings: false }],
  ['role_lojka',       'instrument',     { fork: false, graded_endings: false }],
  ['role_mila',        'witness',        { fork: false, graded_endings: false }],
  ['role_chronicler',  'witness',        { fork: false, graded_endings: false }],
  [LEGACY.id,          'unclassified',   { fork: true,  graded_endings: true  }],
];

// ═══ 1. SERVER POLICY ════════════════════════════════════════════════════════
console.log('\n[1] server policy — archetypeAllows()\n');
for (const [id, expectArchetype, expect] of CASES) {
  const role = roleOf(id);
  const f = admin.archetypeAllows(role, 'fork');
  const e = admin.archetypeAllows(role, 'graded_endings');
  check(`${id.padEnd(20)} archetype`, f.archetype === expectArchetype, f.archetype);
  check(`${id.padEnd(20)} fork ${expect.fork ? 'allowed' : 'BLOCKED'}`, f.allowed === expect.fork,
        f.allowed ? 'allowed' : `blocked: ${f.reason.slice(0, 70)}…`);
  check(`${id.padEnd(20)} endings ${expect.graded_endings ? 'allowed' : 'BLOCKED'}`, e.allowed === expect.graded_endings,
        e.allowed ? 'allowed' : `blocked: ${e.reason.slice(0, 70)}…`);
  if (!f.allowed) check(`${id.padEnd(20)} fork refusal states a reason`, !!f.reason && f.reason.length > 40);
  if (!e.allowed) check(`${id.padEnd(20)} endings refusal states a reason`, !!e.reason && e.reason.length > 40);
}

// ═══ 2. CLIENT RENDER ════════════════════════════════════════════════════════
console.log('\n[2] editor UI — rendered HTML from engine/admin/index.html\n');
const html   = fs.readFileSync(path.join(ROOT, 'engine/admin/index.html'), 'utf8');
const script = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/i.exec(html)[1];

// Minimal DOM stub — enough for the script's top level to evaluate. Nothing in it is
// exercised by the render functions under test, which are pure string builders.
const noop = () => {};
const el = new Proxy({}, { get: (t, k) => (k === 'value' ? '' : k === 'style' ? {} : k === 'classList' ? { add: noop, remove: noop } : noop) });
const doc = { addEventListener: noop, getElementById: () => el, querySelector: () => el,
              querySelectorAll: () => [], createElement: () => el, body: el, documentElement: el, head: el };
const ctx = vm.createContext({
  document: doc, window: {}, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { search: '', href: '', pathname: '/admin/' }, navigator: { clipboard: {} },
  fetch: async () => ({ ok: true, json: async () => ({}) }), console, setTimeout, clearTimeout, alert: noop, confirm: () => false, prompt: () => null,
  URLSearchParams, JSON, Math, Date, Object, Array, String, Number, Boolean, Set, Map, RegExp, Error, Promise, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
});
ctx.window = ctx;
try {
  vm.runInContext(script, ctx, { filename: 'index.html<script>' });
} catch (err) {
  console.log(`      (top-level script threw: ${err.message} — render functions may still be defined)`);
}

const renderDM = ctx.renderDefiningMomentSection;
const renderRoles = ctx.renderPlayerRolesSection;
check('render functions reachable', typeof renderDM === 'function' && typeof renderRoles === 'function');

const stubData = { scenario: { introduction: { sections: [] } }, playerRoles: [] };
for (const [id, expectArchetype, expect] of CASES) {
  const role = roleOf(id);
  const dmHtml = renderDM(role, 0, stubData);
  const liveForkBtn = /class="btn [^"]*gen-dm-btn"/.test(dmHtml);
  const blockedNote = dmHtml.includes('Blocked by archetype');
  check(`${id.padEnd(20)} DM section: generate button ${expect.fork ? 'live' : 'DISABLED'}`,
        liveForkBtn === expect.fork, liveForkBtn ? 'live gen-dm-btn present' : 'disabled, no gen-dm-btn');
  check(`${id.padEnd(20)} DM section: reason ${expect.fork ? 'absent' : 'SHOWN'}`, blockedNote === !expect.fork);
  check(`${id.padEnd(20)} DM section: archetype badge shown`, dmHtml.includes(`>${expectArchetype}</span>`));

  const rolesHtml = renderRoles({ ...stubData, playerRoles: [role] });
  const endingsBtn = /class="btn btn-secondary btn-sm regen-endings-btn"[^>]*>/.exec(rolesHtml)?.[0] || '';
  const endingsDisabled = /regen-endings-btn[^>]*\sdisabled/.test(rolesHtml);
  check(`${id.padEnd(20)} endings button ${expect.graded_endings ? 'live' : 'DISABLED'}`,
        endingsDisabled === !expect.graded_endings, endingsBtn ? 'button rendered' : 'button missing');
  const endingsReason = admin.archetypeAllows(role, 'graded_endings').reason;
  if (!expect.graded_endings) {
    check(`${id.padEnd(20)} endings reason shown verbatim`, rolesHtml.includes(endingsReason.slice(0, 60)));
  }
}

// ═══ 3. ENDPOINTS ════════════════════════════════════════════════════════════
console.log('\n[3] endpoints — real routes, called directly (no UI in front)\n');
const app = express();
app.use(express.json());
app.use('/admin/api', admin.createAdminRouter(repos, { anthropicApiKey: 'test-key-not-used' }));
const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}/admin/api`;

const post = async (url, body) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// 3a. Fork route — BLOCKED archetypes must be refused 422 before anything else happens.
for (const id of ['role_lojka', 'role_mila', 'role_chronicler']) {
  const role = roleOf(id);
  const r = await post(`/scenarios/${role.scenarioId}/roles/${id}/generate-defining-moment`, { overwrite: true });
  check(`fork  ${id.padEnd(20)} refused 422`, r.status === 422 && r.body.refused === true, `${r.status} ${r.body.archetype || ''}`);
  check(`fork  ${id.padEnd(20)} reason returned verbatim`, r.body.error === admin.archetypeAllows(role, 'fork').reason);
  check(`fork  ${id.padEnd(20)} overwrite:true did NOT bypass the gate`, r.status === 422);
}

// 3b. Fork route — ALLOWED archetypes fall through to the pre-existing overwrite guard.
//     All three of these carry a stored block, so a 409 here is proof that the archetype
//     gate passed AND that the hand-authored protection still fires. No model call is made.
for (const id of ['role_trude_harms', 'role_gatekeeper', 'role_princip']) {
  const role = roleOf(id);
  const r = await post(`/scenarios/${role.scenarioId}/roles/${id}/generate-defining-moment`, {});
  check(`fork  ${id.padEnd(20)} gate passed → 409 overwrite guard`, r.status === 409, `${r.status}`);
  check(`fork  ${id.padEnd(20)} 409 names the existing block`, (r.body.existing?.id || '') === role.defining_moment.id, r.body.existing?.id);
}

// 3c. THE REGRESSION CHECK. The archetype gate must not grant an exemption from the
//     hand-authored protection: overwrite:true is the ONLY thing that gets past the 409,
//     and it still has to (the typed REPLACE lives in the UI in front of it).
for (const id of ['role_trude_harms', 'role_gatekeeper']) {
  const role = roleOf(id);
  const without = await post(`/scenarios/${role.scenarioId}/roles/${id}/generate-defining-moment`, {});
  check(`REGRESSION ${id.padEnd(18)} hand-authored block still refused without overwrite`,
        without.status === 409 && /already has a defining_moment/.test(without.body.error || ''));
  const stored = roleOf(id);
  check(`REGRESSION ${id.padEnd(18)} block untouched on disk`,
        JSON.stringify(stored.defining_moment) === JSON.stringify(role.defining_moment));
}

// 3d. Endings route — BLOCKED archetypes refused 422. A deliberately bogus scenarioId is
//     used to prove the gate fires on the ROLE before anything else runs, and to guarantee
//     no generation can occur even if the gate failed.
for (const id of ['role_lojka', 'role_mila', 'role_chronicler', 'role_princip', 'role_gatekeeper']) {
  const role = roleOf(id);
  const r = await post(`/pipeline/regenerate-endings/__no_such_scenario__`, { roleId: id });
  check(`ends  ${id.padEnd(20)} refused 422 (before scenario resolution)`, r.status === 422 && r.body.refused === true, `${r.status}`);
  check(`ends  ${id.padEnd(20)} reason returned verbatim`, r.body.error === admin.archetypeAllows(role, 'graded_endings').reason);
}

// 3e. Endings route — ALLOWED archetypes pass the gate. Same bogus scenarioId, so the
//     request falls through to the orchestrator's pre-existing not-found and NO Opus call
//     is made: a 404 here means the archetype gate let it through.
for (const id of ['role_trude_harms', LEGACY.id, ...(LEGACY_WITH_FATE ? [LEGACY_WITH_FATE.id] : [])]) {
  const r = await post(`/pipeline/regenerate-endings/__no_such_scenario__`, { roleId: id });
  check(`ends  ${id.padEnd(20)} gate passed → 404 scenario-not-found`, r.status === 404, `${r.status} ${(r.body.error || '').slice(0, 60)}`);
  check(`ends  ${id.padEnd(20)} not an archetype refusal`, r.body.artifact !== 'graded_endings');
}

// 3f. The pre-existing fate_mode refusal still fires for an allowed archetype.
{
  const r = await post(`/pipeline/regenerate-endings/${LEGACY.scenarioId}`, { roleId: LEGACY.id });
  check(`ends  ${LEGACY.id.padEnd(20)} pre-existing no-fate_mode refusal intact`,
        r.status === 422 && /no fate_mode/.test(r.body.error || ''), `${r.status} ${(r.body.error || '').slice(0, 60)}`);
}

server.close();
console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll gating tests passed.');
process.exit(fails ? 1 : 0);
