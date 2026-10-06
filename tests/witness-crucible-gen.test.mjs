// WITNESS-CRUCIBLE GENERATOR — the defining-moment generator's witness path, built in stages.
//
//   Stage 1  the witness_crucible flag: gate (server + editor mirror), save guard, and the
//            route precondition (no confirmed lever → refused before any model call)
//   Stage 2  CrucibleLint: the shared rules pass a full generated witness crucible, catch
//            each violation, leave the old protagonist shape untouched, and pass the two
//            stored authored crucibles (positive control, skipped without restored data)
//   Stage 3  the overwrite guard's third tier: a hand-authored crucible needs its own moment
//            id (confirm_crucible) on top of REPLACE / DELETE, and the 409 names what is lost
//   Stage 4  the lever, axis-first: propose (lever + counter-case + cited evidence + scene,
//            written confirmed:false), confirm/edit/clear via PATCH (the only writer of
//            confirmed:true), the editor can never write one, generate stays closed until confirmed
//
// SYNTHETIC FIXTURES ONLY. Every role, scenario and arc here lives in a temp JsonFileStore
// made for this run and deleted after it; no real role file, no Supabase, no tracked file is
// written. api.anthropic.com is scripted: no network call is ever made, and the backup file
// the destroying routes append to is redirected to a temp file.

import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;

// ── scripted Anthropic ────────────────────────────────────────────────────────
// Installed BEFORE the router is imported, so the SDK client it builds sends here. Each test
// queues the model's reply text; every call is recorded (system + user) for assertions. An
// unqueued call fails loudly rather than reaching the network.
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
const modelQueue = [];
const modelCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  modelCalls.push({ system: typeof body.system === 'string' ? body.system : JSON.stringify(body.system), user: body.messages?.at(-1)?.content, max_tokens: body.max_tokens });
  const text = modelQueue.length ? modelQueue.shift() : '__UNQUEUED_MODEL_CALL__';
  return new Response(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const BACKUP_FILE = path.join(os.tmpdir(), `wc-gen-backup-${process.pid}.md`);
process.env.DEFINING_MOMENT_BACKUP_FILE = BACKUP_FILE;   // never the tracked _defining_moment_blocks.md

const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { CharacterRepository } = await import(`${ROOT}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { ClueRepository }      = await import(`${ROOT}/engine/repositories/ClueRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
const { PlayerRepository }    = await import(`${ROOT}/engine/repositories/PlayerRepository.js`);
const { SessionRepository }   = await import(`${ROOT}/engine/repositories/SessionRepository.js`);
const admin = await import(`${ROOT}/engine/admin/adminRouter.js`);
const lint  = await import(`${ROOT}/engine/services/CrucibleLint.js`);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

// A confirmed lever and a full generated witness crucible built on it — the shape the
// witness path must produce. Reused as scripted model output in later stages.
const LEVER = {
  axis: 'human_presence',
  statement: 'The usher cannot change the sentence; his power is his presence beside her in the corridors, and what he carries out of them to testify.',
  reasoning: 'He escorts her daily between cell and court, unrecorded, and he testified to her treatment twenty-five years later.',
  counter_case: { assumption: 'You would assume the usher, holding the keys and the corridor, could get her out.', why_wrong: 'He has no authority over the sentence and no means of escape; his office is to bring her, and the record shows only his later testimony.' },
  evidence: [
    { claim: 'He escorted the prisoner between cell and court every day of the trial.', source: 'Trial record, sessions of February-May 1431' },
    { claim: 'He testified at the nullification to how she was held.',               source: 'Nullification testimony, 1456' },
  ],
  instrument_terms: ['corridor', 'testify'],
  scene_binding: { at_scene: 'scene_b', reasoning: 'The relapse visit is the last morning he walks her before the sentence; it precedes the documented execution.' },
  generated: true,
  confirmed: true,
};
const words = n => Array.from({ length: n }, (_, i) => ['the', 'corridor', 'stone', 'door', 'light', 'morning', 'step', 'quiet'][i % 8]).join(' ');
const DISCLAIMER = 'Changing her sentence was never your office.';
const CLAIM      = 'In 1456 you would testify at the nullification to how she was held.';
const debrief = (stance, extra = 110) => `${DISCLAIMER} You were the usher; you brought her and you stood at the door. ${stance} ${CLAIM} ${words(extra)}.`;
const GOOD_BLOCK = {
  id: 'usher_witnessing_choice',
  setup: `You carried the summons again this morning. ${words(200)}. The word relapse is in the room, and the corridor is yours.`,
  options: [
    { id: 'keep_your_place', label: 'Keep your place',      text: `Do your office and no more. ${words(30)}.`,
      debrief: debrief('You kept your place in every corridor and let yourself see nothing there.'),
      outcome_disclaimer: DISCLAIMER, consequence: { claim: CLAIM, source: 'Nullification testimony, 1456' } },
    { id: 'see_her',         label: 'Let yourself see her', text: `Let yourself see her in the corridor. ${words(30)}.`,
      debrief: debrief('You saw her, in the corridor no one wrote down, and carried it with you.'),
      outcome_disclaimer: DISCLAIMER, consequence: { claim: CLAIM, source: 'Nullification testimony, 1456' } },
    { id: 'mark_it',         label: 'Mark it to testify',   text: `Mark what is done, to testify one day. ${words(30)}.`,
      debrief: debrief('You saw her, in the corridor no one wrote down, and carried it with you.'),
      outcome_disclaimer: DISCLAIMER, consequence: { claim: CLAIM, source: 'Trial record, sessions of February-May 1431' } },
  ],
  time_advance: 0,
  principal_transition: { type: 'decision_made', moment: 'usher_witnessing_choice' },
};
const mutate = (fn) => { const b = structuredClone(GOOD_BLOCK); fn(b); return b; };

// ── fixtures ──────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-gen-'));
const store = new JsonFileStore(TMP);
const SCENARIO_ID = 'wc_fixture_trial';
const SCENARIO = {
  id: SCENARIO_ID, title: 'The Fixture Trial', premise: 'A court sits on a prisoner whose sentence is already decided.',
  sessionTargetMinutes: 30,
  storyArcIds: ['wc_fixture_arc'],
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
repos.storyArcs.save({ id: 'wc_fixture_arc', scenarioId: SCENARIO_ID, acts: [{ actNumber: 1, beats: [], scenes: [
  { id: 'scene_a', change: 'both', location_id: 'loc_court', budget_minutes: 10, date_label: '21 February', bridge: 'The first public examination.' },
  { id: 'scene_b', change: 'both', location_id: 'loc_cell',  budget_minutes: 10, date_label: '28 May',      bridge: 'The relapse: the judges come to the cell.' },
] }] });

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
  // ═══ STAGE 2 ═══════════════════════════════════════════════════════════════
  head('2a. CrucibleLint — a full generated witness crucible passes');
  {
    const r = lint.lintCrucibleBlock(GOOD_BLOCK, { path: 'witness-crucible', generated: true, lever: LEVER });
    check('no errors', r.errors.length === 0, r.errors.join(' | '));
    check('no budget warnings', r.warnings.length === 0, r.warnings.join(' | '));
    check('validator (structure) passes too', admin.validateDefiningMomentBlock(GOOD_BLOCK).length === 0);
  }

  head('2b. CrucibleLint — each violation is caught (witness path → ERROR)');
  const VIOLATIONS = [
    ['"could not save her" in a debrief',       b => { b.options[0].debrief += ' You could not save her.'; },                /failed-rescue/],
    ['"couldn\'t have saved him" in the setup', b => { b.setup += " You couldn't have saved him."; },                     /setup: failed-rescue/],
    ['blame: "because of you"',                 b => { b.options[1].debrief += ' She burned because of you.'; },             /blame/],
    ['outcome claim: "you saved her"',          b => { b.options[2].debrief += ' In the end you saved her.'; },              /claims the outcome/],
    ['debriefs do not branch',                  b => { for (const o of b.options) o.debrief = b.options[0].debrief; },       /do not branch/],
    ['missing debrief',                         b => { delete b.options[1].debrief; },                                        /needs a "debrief"/],
    ['missing label',                           b => { delete b.options[0].label; },                                          /needs a short "label"/],
    ['label too long',                          b => { b.options[0].label = 'x'.repeat(50); },                                /under 50 characters/],
    ['disclaimer not in the debrief',           b => { b.options[0].outcome_disclaimer = 'It was never yours.'; },           /outcome_disclaimer" does not appear/],
    ['no disclaimer field',                     b => { delete b.options[0].outcome_disclaimer; },                            /needs an "outcome_disclaimer"/],
    ['consequence claim not in the debrief',    b => { b.options[0].consequence.claim = 'Something else happened later.'; }, /consequence.claim does not appear/],
    ['consequence source not lever evidence',   b => { b.options[0].consequence.source = 'A source the lever never cited'; }, /not one of the confirmed lever's evidence sources/],
    ['no consequence',                          b => { delete b.options[2].consequence; },                                    /needs a "consequence"/],
    ['debrief never names the lever',           b => { b.options[0].debrief = b.options[0].debrief.replace(/corridors?/g, 'hall').replace(/testify/g, 'speak'); }, /never names the lever/],
  ];
  for (const [label, fn, rx] of VIOLATIONS) {
    const r = lint.lintCrucibleBlock(mutate(fn), { path: 'witness-crucible', generated: true, lever: LEVER });
    check(`caught: ${label}`, r.errors.some(e => rx.test(e)), r.errors.join(' | ').slice(0, 160));
  }
  {
    const r = lint.lintCrucibleBlock(GOOD_BLOCK, { path: 'witness-crucible', generated: true, lever: { ...LEVER, evidence: [] } });
    check('caught: a lever with no evidence cannot vouch for any citation', r.errors.some(e => /no evidence sources/.test(e)));
  }
  {
    const r = lint.lintCrucibleBlock(mutate(b => { b.setup = 'Too short.'; b.options[0].debrief = `${DISCLAIMER} ${CLAIM} corridor.`; }), { path: 'witness-crucible', generated: true, lever: LEVER });
    check('budgets are WARNINGS, not errors', r.errors.length === 0 && r.warnings.some(w => /^setup: \d+ words/.test(w)) && r.warnings.some(w => /debrief: \d+ words/.test(w)), `${r.errors.join(' | ')}`);
  }
  {
    const r = lint.lintCrucibleBlock(mutate(b => { for (const o of b.options) { delete o.outcome_disclaimer; delete o.consequence; } }), { path: 'witness-crucible', generated: false });
    check('authored (generated:false): provenance fields not required, prose rules still apply', r.errors.length === 0);
  }
  {
    const negated = mutate(b => { b.options[0].debrief += ' No word in a corridor could have stayed the fire.'; });
    check('a NEGATED outcome statement is not an outcome claim', lint.lintCrucibleBlock(negated, { path: 'witness-crucible', generated: true, lever: LEVER }).errors.length === 0);
  }

  head('2c. CrucibleLint — protagonist path');
  {
    const OLD = { id: 'x_defining_choice', setup: words(120), options: [{ id: 'a', text: words(12) }, { id: 'b', text: words(12) }, { id: 'c', text: words(12) }], time_advance: 0, at_elapsed_fraction: 0.6, principal_transition: { type: 'decision_made', moment: 'x_defining_choice' } };
    const r = lint.lintCrucibleBlock(OLD, { path: 'protagonist', generated: true });
    check('the old shape (no label, no debrief): nothing applies', r.errors.length === 0 && r.warnings.length === 0);
    const partial = structuredClone(OLD); partial.options[0].debrief = words(120);
    check('debriefs are all-or-none (partial → error)', lint.lintCrucibleBlock(partial, { path: 'protagonist' }).errors.some(e => /all-or-none/.test(e)));
    const banned = structuredClone(OLD); for (const o of banned.options) { o.debrief = `${words(110)} ${o.id}. It was your fault.`; o.label = o.id; }
    const rb = lint.lintCrucibleBlock(banned, { path: 'protagonist' });
    check('prose rules are WARNINGS on the protagonist path', rb.errors.length === 0 && rb.warnings.some(w => /blame/.test(w)), rb.errors.join(' | '));
    check('protagonist: provenance fields never required', !rb.errors.some(e => /outcome_disclaimer|consequence/.test(e)));
  }

  head('2d. positive control — the stored authored crucibles pass');
  for (const id of ['role_manchon', 'role_massieu']) {
    const f = path.join(REPO_DIR, 'engine/data/scenarios/player_roles', `${id}.json`);
    if (!fs.existsSync(f)) { console.log(`SKIP  ${id} — not restored locally`); continue; }
    const dm = JSON.parse(fs.readFileSync(f, 'utf8')).defining_moment;
    const r = lint.lintCrucibleBlock(dm, { path: 'witness-crucible', generated: false });
    check(`${id}: no lint errors`, r.errors.length === 0, r.errors.join(' | '));
    check(`${id}: inside the witness budgets (no warnings)`, r.warnings.length === 0, r.warnings.join(' | '));
    check(`${id}: validator (structure) passes`, admin.validateDefiningMomentBlock(dm).length === 0);
  }
  // ═══ STAGE 3 ═══════════════════════════════════════════════════════════════
  head('3a. isAuthoredCrucible — the third tier, server and editor agree');
  const AUTHORED_CRUCIBLE = { ...structuredClone(GOOD_BLOCK), generated: false, reviewed: true, at_scene: 'scene_b' };
  for (const o of AUTHORED_CRUCIBLE.options) { delete o.outcome_disclaimer; delete o.consequence; }
  const TRUDE_LIKE = { id: 'trude_like_choice', setup: 's', options: [{ id: 'a', text: 't' }, { id: 'b', text: 't' }, { id: 'c', text: 't' }], principal_transition: { type: 'decision_made', moment: 'trude_like_choice' } };
  const JOAN_LIKE  = { ...structuredClone(TRUDE_LIKE), id: 'joan_like_choice', generated: true, reviewed: true };
  const GEN_WITH_DEBRIEFS = { ...structuredClone(GOOD_BLOCK), generated: true, reviewed: true };
  for (const [label, block, expect] of [
    ['hand-authored crucible (Manchon/Massieu shape)', AUTHORED_CRUCIBLE, true],
    ['hand-authored, no debriefs (Trude/Jäger)',       TRUDE_LIKE,        false],
    ['generated + reviewed, no debriefs (Joan)',       JOAN_LIKE,         false],
    ['generated + reviewed, with debriefs',            GEN_WITH_DEBRIEFS, false],
    ['no block',                                       undefined,         false],
  ]) {
    check(`${label.padEnd(48)} → ${expect ? 'CRUCIBLE tier' : 'not'}`, admin.isAuthoredCrucible(block) === expect && ctx.isAuthoredCrucible(block) === expect);
  }
  for (const id of ['role_manchon', 'role_massieu']) {
    const f = path.join(REPO_DIR, 'engine/data/scenarios/player_roles', `${id}.json`);
    if (fs.existsSync(f)) check(`${id}: stored block is on the crucible tier`, admin.isAuthoredCrucible(JSON.parse(fs.readFileSync(f, 'utf8')).defining_moment));
  }

  head('3b. regenerate — an authored crucible needs the moment id on top of REPLACE');
  const protag = id => ({ ...baseRole, id, name: id, archetype: 'crucible-fixed' });
  repos.scenarios.savePlayerRole({ ...protag('role_wc_crucible'), defining_moment: AUTHORED_CRUCIBLE });
  repos.scenarios.savePlayerRole({ ...protag('role_wc_trude'),    defining_moment: TRUDE_LIKE });
  repos.scenarios.savePlayerRole({ ...protag('role_wc_joan'),     defining_moment: JOAN_LIKE });
  const DECLINE = JSON.stringify({ declined: true, reason: 'observer or witness role — scripted decline, nothing is written.' });
  {
    const steps = [
      [{},                                                                   409, b => /already has a defining_moment/.test(b.error)],
      [{ overwrite: true },                                                  409, b => b.atRisk === true],
      [{ overwrite: true, confirm: 'REPLACE' },                              409, b => b.crucibleAtRisk === true],
      [{ overwrite: true, confirm: 'REPLACE', confirm_crucible: 'REPLACE' }, 409, b => b.crucibleAtRisk === true],
      [{ overwrite: true, confirm_crucible: AUTHORED_CRUCIBLE.id },          409, b => b.atRisk === true],
    ];
    for (const [body, status, ok] of steps) {
      const r = await post(genUrl('role_wc_crucible'), body);
      check(`regenerate ${JSON.stringify(body).padEnd(78)} → ${status}`, r.status === status && ok(r.body), `${r.status} ${(r.body.error || '').slice(0, 70)}`);
    }
    const r = await post(genUrl('role_wc_crucible'), { overwrite: true, confirm: 'REPLACE' });
    const L = r.body.would_lose || {};
    check('409 names what would be lost', L.moment_id === AUTHORED_CRUCIBLE.id && L.debriefs === 3 && L.distinct_debriefs === 2 && L.labels === 3 && L.binding?.at_scene === 'scene_b' && L.debrief_words?.length === 3, JSON.stringify(L));
    check('409 text names the backup file and the token', /_defining_moment_blocks\.md/.test(r.body.error) && r.body.error.includes(`"confirm_crucible": "${AUTHORED_CRUCIBLE.id}"`));
    check('no model call was made by any refused request', modelCalls.length === 0);
    modelQueue.push(DECLINE);
    const ok = await post(genUrl('role_wc_crucible'), { overwrite: true, confirm: 'REPLACE', confirm_crucible: AUTHORED_CRUCIBLE.id });
    check('all three tokens → passes every guard (reaches the model; scripted decline)', ok.status === 200 && ok.body.declined === true && modelCalls.length === 1, `${ok.status}`);
    check('authored crucible untouched on disk (a decline writes nothing)', JSON.stringify(repos.scenarios.findPlayerRole('role_wc_crucible').defining_moment) === JSON.stringify(AUTHORED_CRUCIBLE));
  }
  for (const id of ['role_wc_trude', 'role_wc_joan']) {
    modelQueue.push(DECLINE);
    const r = await post(genUrl(id), { overwrite: true, confirm: 'REPLACE' });
    check(`${id}: REPLACE tier unchanged — no crucible token asked`, r.status === 200 && r.body.declined === true, `${r.status} ${r.body.error || ''}`);
  }

  head('3c. delete — same third token, backup written before the removal');
  {
    const url = '/player-roles/role_wc_crucible/defining-moment';
    const patch = async body => {
      const r = await fetch(base + url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const a = await patch({ delete: true });
    check('delete without DELETE → 409 hand-authored', a.status === 409 && a.body.handAuthored === true && !a.body.crucibleAtRisk);
    const b = await patch({ delete: true, confirm: 'DELETE' });
    check('delete with DELETE only → 409 crucible tier', b.status === 409 && b.body.crucibleAtRisk === true && b.body.would_lose?.debriefs === 3);
    check('still on disk after both refusals', !!repos.scenarios.findPlayerRole('role_wc_crucible').defining_moment);
    const before = fs.existsSync(BACKUP_FILE) ? fs.readFileSync(BACKUP_FILE, 'utf8') : '';
    const c = await patch({ delete: true, confirm: 'DELETE', confirm_crucible: AUTHORED_CRUCIBLE.id });
    check('delete with DELETE + moment id → removed', c.status === 200 && !repos.scenarios.findPlayerRole('role_wc_crucible').defining_moment, `${c.status}`);
    const after = fs.existsSync(BACKUP_FILE) ? fs.readFileSync(BACKUP_FILE, 'utf8') : '';
    check('the removed crucible was appended to the (redirected) backup first', after.length > before.length && after.includes(AUTHORED_CRUCIBLE.options[0].debrief.slice(0, 60)) && /state when replaced: hand-authored/.test(after));
  }
  // ═══ STAGE 4 ═══════════════════════════════════════════════════════════════
  const leverUrl = id => `/scenarios/${SCENARIO_ID}/roles/${id}/propose-witness-lever`;
  const patchLever = async (id, body) => {
    const r = await fetch(`${base}/player-roles/${id}/witness-lever`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const leverOf = id => repos.scenarios.findPlayerRole(id).witness_lever;
  const { generated: _g, confirmed: _c, ...PROPOSAL } = LEVER;   // what the model returns

  head('4a. validateWitnessLever');
  check('the fixture lever is valid against the arc', admin.validateWitnessLever(PROPOSAL, ['scene_a', 'scene_b']).length === 0, admin.validateWitnessLever(PROPOSAL, ['scene_a', 'scene_b']).join(' | '));
  for (const [label, fn, rx] of [
    ['unknown axis',             p => { p.axis = 'rescue'; },                                 /"axis" must be one of/],
    ['no counter-case',          p => { delete p.counter_case; },                             /counter_case/],
    ['one evidence item',        p => { p.evidence = p.evidence.slice(0, 1); },               /at least 2 cited items/],
    ['evidence without source',  p => { p.evidence[1].source = ''; },                         /evidence 2: needs both/],
    ['six instrument terms',     p => { p.instrument_terms = ['a', 'b', 'c', 'd', 'e', 'f']; }, /instrument_terms/],
    ['scene not in the arc',     p => { p.scene_binding.at_scene = 'scene_zzz'; },            /is not a scene of this arc/],
    ['scene without reasoning',  p => { p.scene_binding.reasoning = ''; },                    /scene_binding.reasoning/],
  ]) {
    const p = structuredClone(PROPOSAL); fn(p);
    check(`rejects: ${label}`, admin.validateWitnessLever(p, ['scene_a', 'scene_b']).some(e => rx.test(e)));
  }
  check('no scenes in the arc → at_scene may be null', admin.validateWitnessLever({ ...structuredClone(PROPOSAL), scene_binding: { at_scene: null } }, []).length === 0);

  head('4b. propose — gate, prompt, and what is written');
  {
    const calls = modelCalls.length;
    const r = await post(leverUrl('role_wc_bystander'), {});
    check('unflagged witness → 422 NOT_WITNESS_CRUCIBLE, no model call', r.status === 422 && r.body.code === 'NOT_WITNESS_CRUCIBLE' && modelCalls.length === calls);
    const i = await post(leverUrl('role_wc_instrument'), {});
    check('flagged instrument → 422 NOT_WITNESS_CRUCIBLE', i.status === 422 && i.body.code === 'NOT_WITNESS_CRUCIBLE');
  }
  {
    // The model tries to pre-confirm its own proposal and smuggle a key in; both are dropped.
    modelQueue.push('Thinking it over first.\n```json\n' + JSON.stringify({ ...PROPOSAL, confirmed: true, generated: false, sneaky: 1 }) + '\n```');
    const r = await post(leverUrl('role_wc_usher'), {});
    const call = modelCalls.at(-1);
    check('propose → 200 with the lever', r.status === 200 && r.body.witness_lever?.axis === 'human_presence', `${r.status} ${r.body.error || ''}`);
    check('system prompt is the lever prompt (axes, counter-case, cited evidence, scene, decline)',
      call.system === admin.WITNESS_LEVER_SYSTEM_PROMPT && /THE COUNTER-CASE — REQUIRED/.test(call.system) && /documentary_record/.test(call.system) && /no lever/.test(call.system));
    check('user prompt lists the arc\'s scenes in order, and the documented record', /scene_a[\s\S]*scene_b/.test(call.user) && /DOCUMENTED RECORD|ANCHORED/.test(call.user), call.user.slice(0, 80));
    const L = leverOf('role_wc_usher');
    check('stored: generated:true, confirmed:false — the model cannot pre-confirm', L.generated === true && L.confirmed === false && !!L.proposed_at);
    check('stored: only lever fields (no smuggled key)', !('sneaky' in L));
    check('stored: counter-case, cited evidence, instrument terms, scene', !!L.counter_case?.assumption && L.evidence.length === 2 && L.evidence.every(e => e.source) && L.instrument_terms.length === 2 && L.scene_binding.at_scene === 'scene_b');
    check('response lists the arc scenes for the reviewer', JSON.stringify(r.body.scenes?.map(s => s.id)) === '["scene_a","scene_b"]');
  }
  {
    const before = JSON.stringify(leverOf('role_wc_usher'));
    modelQueue.push(JSON.stringify({ ...PROPOSAL, scene_binding: { at_scene: 'scene_zzz', reasoning: 'r' } }));
    const r = await post(leverUrl('role_wc_usher'), {});
    check('invalid proposal (scene not in arc) → 500, nothing saved', r.status === 500 && /not a scene of this arc/.test(r.body.error) && JSON.stringify(leverOf('role_wc_usher')) === before);
    modelQueue.push(JSON.stringify({ declined: true, reason: 'no lever: a bystander in the crowd.' }));
    const d = await post(leverUrl('role_wc_usher'), {});
    check('decline → 200 declined, nothing saved', d.status === 200 && d.body.declined === true && JSON.stringify(leverOf('role_wc_usher')) === before);
  }
  {
    const r = await post(genUrl('role_wc_usher'), {});
    check('generate before confirmation → 422 LEVER_UNCONFIRMED', r.status === 422 && r.body.code === 'LEVER_UNCONFIRMED');
  }

  head('4c. the editor can never write a lever');
  {
    const put = async body => (await fetch(`${base}/player-roles/role_wc_usher`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status;
    const role = repos.scenarios.findPlayerRole('role_wc_usher');
    const { witness_lever, ...stale } = role;
    await put(stale);
    check('stale tab (no key) → stored lever kept', JSON.stringify(leverOf('role_wc_usher')) === JSON.stringify(witness_lever));
    await put({ ...stale, witness_lever: { ...witness_lever, confirmed: true, axis: 'testimony' } });
    check('a posted { confirmed: true } is ignored → stored lever kept, still unconfirmed', leverOf('role_wc_usher').confirmed === false && leverOf('role_wc_usher').axis === 'human_presence');
    const c = await fetch(`${base}/player-roles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'role wc created', scenarioId: SCENARIO_ID, witness_lever: { ...PROPOSAL, confirmed: true } }) });
    const created = await c.json();
    check('create route strips a posted lever', c.status === 201 && !('witness_lever' in created) && !('witness_lever' in repos.scenarios.findPlayerRole(created.id)));
  }

  head('4d. PATCH — the only writer of confirmed:true');
  {
    const r0 = await patchLever('role_wc_usher', {});
    check('{} → 400', r0.status === 400);
    const r1 = await patchLever('role_wc_usher', { edits: { scene_binding: { at_scene: 'scene_zzz', reasoning: 'x' } }, confirm: true });
    check('an invalid edit → 400, nothing saved, still unconfirmed', r1.status === 400 && leverOf('role_wc_usher').confirmed === false && leverOf('role_wc_usher').scene_binding.at_scene === 'scene_b');
    const r2 = await patchLever('role_wc_usher', { confirm: true });
    check('{ confirm: true } → confirmed, with confirmed_at', r2.status === 200 && leverOf('role_wc_usher').confirmed === true && !!leverOf('role_wc_usher').confirmed_at && leverOf('role_wc_usher').generated === true);
    const r3 = await patchLever('role_wc_usher', { edits: { statement: 'A corrected statement of his power.' } });
    check('an edit without confirm UN-confirms, and marks edited', r3.status === 200 && leverOf('role_wc_usher').confirmed === false && leverOf('role_wc_usher').edited === true && !leverOf('role_wc_usher').confirmed_at);
    const r4 = await patchLever('role_wc_usher', { edits: { scene_binding: { at_scene: 'scene_a', reasoning: 'The first examination, earlier.' }, confirmed: false, generated: false }, confirm: true });
    check('edit + confirm → confirmed on the edited lever; provenance keys in edits are ignored', r4.status === 200 && leverOf('role_wc_usher').confirmed === true && leverOf('role_wc_usher').scene_binding.at_scene === 'scene_a' && leverOf('role_wc_usher').generated === true);
    const r5 = await patchLever('role_wc_bystander', { confirm: true });
    check('no lever on the role → 404', r5.status === 404);
  }

  head('4e. a confirmed lever is protected; clear removes it');
  {
    const calls = modelCalls.length;
    const r = await post(leverUrl('role_wc_usher'), {});
    check('propose over a CONFIRMED lever without overwrite → 409, no model call', r.status === 409 && r.body.existing?.confirmed === true && modelCalls.length === calls);
    modelQueue.push(JSON.stringify(PROPOSAL));
    const o = await post(leverUrl('role_wc_usher'), { overwrite: true });
    check('with overwrite → fresh proposal, UNconfirmed (re-closes the generator)', o.status === 200 && leverOf('role_wc_usher').confirmed === false);
    const g = await post(genUrl('role_wc_usher'), {});
    check('…so generate is refused again', g.status === 422 && g.body.code === 'LEVER_UNCONFIRMED');
    await patchLever('role_wc_usher', { confirm: true });
    const c = await patchLever('role_wc_usher', { clear: true });
    check('{ clear: true } → lever removed', c.status === 200 && leverOf('role_wc_usher') === undefined);
    modelQueue.push(JSON.stringify(PROPOSAL));
    await post(leverUrl('role_wc_usher'), {});
    await patchLever('role_wc_usher', { confirm: true });
    check('re-proposed and confirmed for Stage 5', leverOf('role_wc_usher')?.confirmed === true);
  }
} finally {
  await new Promise(r => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(BACKUP_FILE, { force: true });
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll witness-crucible-gen assertions passed.');
process.exitCode = fails ? 1 : 0;
