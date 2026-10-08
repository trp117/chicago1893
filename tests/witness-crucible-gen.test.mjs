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
//   Stage 5  generation: the protagonist prompts pinned byte-identical (debriefs only on
//            request), the witness path on the confirmed lever (full shape, lint-gated, bound to
//            the lever's scene), and the embedded exemplars verbatim against their role files
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
    modelQueue.push(JSON.stringify({ declined: true, reason: 'lever does not hold — scripted decline.' }));
    const r = await post(genUrl('role_wc_confirmed'), { overwrite: true });
    const sys = modelCalls.at(-1)?.system || '';
    check('flagged witness, confirmed lever → the WITNESS prompt, never the protagonist one', r.status === 200 && r.body.declined === true && /STEP 1W/.test(sys) && !/WITNESS SCENARIOS MUST DECLINE/.test(sys), `${r.status}`);
    modelCalls.length = 0;   // later stages count calls from zero
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
    ['authoring term "lever" in a debrief',     b => { b.options[0].debrief += ' Your lever was the corridor.'; },          /debrief: authoring vocabulary .*"lever"/],
    ['"the downstream consequence" in a debrief', b => { b.options[1].debrief += ' It was the downstream consequence of that morning.'; }, /authoring vocabulary .*"downstream consequence"/],
    ['snake_case identifier in the setup',      b => { b.setup += ' This is could_have_acted_at_cost.'; },                  /setup: authoring vocabulary .*"could_have_acted_at_cost"/],
    ['"axis" in a label',                       b => { b.options[0].label = 'Choose the axis'; },                            /label: authoring vocabulary .*"axis"/],
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
  {
    // "Word for word" ignores case, whitespace, quote style and a trailing stop — the shape of
    // the first real-model failures (a claim written as its own sentence, run mid-sentence).
    const run = fn => lint.lintCrucibleBlock(mutate(fn), { path: 'witness-crucible', generated: true, lever: LEVER }).errors;
    check('claim differing only in case / spacing / final stop → still found', run(b => { b.options[0].consequence.claim = '  in 1456 you  would TESTIFY at the nullification to how she was held'; }).length === 0);
    check('claim with curly quotes, debrief with straight → still found', run(b => { b.options[0].debrief += ' He said "enough" at the door.'; b.options[0].consequence.claim = 'He said “enough” at the door.'; }).length === 0);
    check('disclaimer differing only in case → still found', run(b => { b.options[0].outcome_disclaimer = DISCLAIMER.toLowerCase(); }).length === 0);
    check('narrative "the Axis" (capitalised) is not authoring vocabulary', run(b => { b.setup += ' The Axis held the coast.'; }).length === 0);
    const prot = lint.lintCrucibleBlock(mutate(b => { b.options[0].debrief += ' Your lever was the corridor.'; }), { path: 'protagonist', generated: true });
    check('protagonist with debriefs: authoring vocabulary is a WARNING', prot.errors.length === 0 && prot.warnings.some(w => /authoring vocabulary/.test(w)), prot.errors.join(' | '));
    const leaky = { ...LEVER, evidence: [LEVER.evidence[0], { claim: 'The lights burn today, the downstream consequence of the vow.', source: 'Parish history' }] };
    check('a lever whose evidence CLAIM carries authoring vocabulary is invalid (it is quoted to the player)',
      admin.validateWitnessLever(leaky, ['scene_a', 'scene_b']).some(e => /evidence 2: .*authoring vocabulary .*"downstream consequence"/.test(e)));
    check('debrief budget widened to 140-250', JSON.stringify(lint.BUDGETS['witness-crucible'].debrief) === '[140,250]');
    check('claim with DIFFERENT words → still an error', run(b => { b.options[0].consequence.claim = 'In 1456 you testified at the nullification to how she was held.'; }).some(e => /consequence.claim does not appear/.test(e)));
  }

  head('2b2. CrucibleLint — source hedges are WARNINGS (adjudicated, never blocking)');
  for (const [label, fn, rx] of [
    ['"according to legend" in an option text', b => { b.options[2].text += ' According to legend, it mattered.'; }, /text: possible authoring language .*"According to legend"/],
    ['"the record hedges" in a debrief',        b => { b.options[0].debrief += ' The record hedges on this.'; },     /debrief: possible authoring language .*"The record hedges"/],
  ]) {
    const r = lint.lintCrucibleBlock(mutate(fn), { path: 'witness-crucible', generated: true, lever: LEVER });
    const f = r.findings.find(x => x.rule === 'source_hedge');
    check(`${label}: a WARNING, not an error`, r.errors.length === 0 && r.warnings.some(w => rx.test(w)), [...r.errors, ...r.warnings].join(' | ').slice(0, 200));
    check(`${label}: carries the adjudication hint`, f?.severity === 'warning' && /may be a legitimate source-hedge — reword into the narrative or accept/.test(f.hint));
  }

  head('2b3. CrucibleLint — structured findings, located on their element');
  {
    const r = lint.lintCrucibleBlock(mutate(b => {
      b.options[0].debrief += ' Your lever was the corridor.';
      b.options[1].label = 'x'.repeat(60);
      b.options[2].consequence.source = 'Nowhere';
      b.setup += ' You could not save her.';
    }), { path: 'witness-crucible', generated: true, lever: LEVER });
    const [o0, o1, o2] = GOOD_BLOCK.options.map(o => o.id);
    const has = (severity, rule, location) => r.findings.some(f => f.severity === severity && f.rule === rule && f.location === location);
    check('every finding has { severity, rule, location, message, hint }', r.findings.length > 0 && r.findings.every(f =>
      ['error', 'warning'].includes(f.severity) && [f.rule, f.location, f.message, f.hint].every(v => typeof v === 'string' && v)), JSON.stringify(r.findings[0]));
    check('authoring term → error on option.<id>.debrief', has('error', 'authoring_term', `option.${o0}.debrief`));
    check('long label → error on option.<id>.label',       has('error', 'label_too_long', `option.${o1}.label`));
    check('bad citation → error on option.<id>.consequence', has('error', 'source_not_in_lever', `option.${o2}.consequence`));
    check('failed rescue in setup → error on setup',        has('error', 'failed_rescue', 'setup'));
    check('text rendering is "<location>: <message>"', r.errors.includes(`setup: ${r.findings.find(f => f.location === 'setup').message}`));
    const dup = lint.lintCrucibleBlock(mutate(b => { b.options[1].id = b.options[0].id; b.options[1].label = 'x'.repeat(60); }), { path: 'witness-crucible', generated: true, lever: LEVER });
    check('a duplicated option id is located by index (option.#<i>)', dup.findings.some(f => f.rule === 'label_too_long' && f.location === 'option.#1.label'));
    const bud = lint.lintCrucibleBlock(mutate(b => { b.setup = 'Too short.'; }), { path: 'witness-crucible', generated: true, lever: LEVER });
    check('budget → warning on setup, with a hint', bud.findings.some(f => f.severity === 'warning' && f.rule === 'budget' && f.location === 'setup' && f.hint));
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
  {
    const p = structuredClone(PROPOSAL);
    p.axis = 'rescue'; p.evidence[1].source = ''; p.evidence[0].claim += ' According to legend, it held.';
    const r = lint.lintWitnessLever(p, ['scene_a', 'scene_b']);
    const at = (rule, location, severity = 'error') => r.findings.some(f => f.rule === rule && f.location === location && f.severity === severity && f.hint);
    check('lever findings are located: bad axis → lever.axis', at('lever_shape', 'lever.axis'));
    check('lever findings are located: missing source → lever.evidence.1.source (0-based)', at('lever_shape', 'lever.evidence.1.source'));
    check('a source hedge in a claim → WARNING on lever.evidence.0.claim', at('source_hedge', 'lever.evidence.0.claim', 'warning'));
    check('validateWitnessLever = the error renderings only (the hedge is not among them)', admin.validateWitnessLever(p, ['scene_a', 'scene_b']).length === r.errors.length && !r.errors.some(e => /legend/.test(e)));
    check('the axes live in CrucibleLint and are re-exported unchanged', admin.WITNESS_LEVER_AXES === lint.WITNESS_LEVER_AXES);
  }

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
    // A proposal that failed the lint comes back unsaved; the reviewer's corrected copy is
    // PATCHed in whole, with no stored lever behind it.
    const part = await patchLever('role_wc_usher', { edits: { statement: 'Only a statement.' }, confirm: true });
    check('no stored lever + a PARTIAL lever → 400 with located findings and the lever echoed back, nothing saved',
      part.status === 400 && part.body.findings?.some(f => f.location === 'lever.axis') && part.body.witness_lever?.statement === 'Only a statement.' && leverOf('role_wc_usher') === undefined);
    const whole = await patchLever('role_wc_usher', { edits: PROPOSAL, from_proposal: true, confirm: true });
    check('no stored lever + the WHOLE lever (from_proposal) → saved, confirmed, generated + edited', whole.status === 200 && leverOf('role_wc_usher')?.confirmed === true && leverOf('role_wc_usher').generated === true && leverOf('role_wc_usher').edited === true && Array.isArray(whole.body.findings), `${whole.status} ${whole.body.error || ''}`);
    await patchLever('role_wc_usher', { clear: true });
    modelQueue.push(JSON.stringify(PROPOSAL));
    await post(leverUrl('role_wc_usher'), {});
    await patchLever('role_wc_usher', { confirm: true });
    check('re-proposed and confirmed for Stage 5', leverOf('role_wc_usher')?.confirmed === true);
  }
  // ═══ STAGE 5 ═══════════════════════════════════════════════════════════════
  const crypto = await import('crypto');
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');

  head('5a. the protagonist prompts are byte-identical to before this build');
  {
    // Frozen from the generator at 0eb0736 (before any witness-crucible change).
    const FROZEN = {
      open:     'c998058d09575a692facf67addd1a0f7ea4e875cec017840b15f06408e1dbda0',
      anchored: '4f796884cb76308c20d81caedd84402d9aa0e6b8b2400fdca5fbcd1d9d68ba01',
      user:     '2e389c42ff0a566b85a420c3662892fae75e0bc7c3023a0c2bee5a1462fd0bcd',
    };
    check('system prompt, open-outcome: unchanged',  sha(admin.buildDefiningMomentSystemPrompt(undefined, false)) === FROZEN.open);
    check('system prompt, anchored: unchanged',      sha(admin.buildDefiningMomentSystemPrompt(undefined, true))  === FROZEN.anchored);
    const role = { id: 'r', name: 'R', character_type: 'real', fate_mode: 'anchored', description: 'd', briefing: 'b' };
    check('user prompt (no witness): unchanged',     sha(admin.buildDefiningMomentUserPrompt({ scenario: { title: 'T' }, role, entryParagraph: 'E' })) === FROZEN.user);
    check('Test 3 still refuses witnesses on the protagonist path', /WITNESS SCENARIOS MUST DECLINE/.test(admin.buildDefiningMomentSystemPrompt(undefined, true)));
  }

  head('5b. protagonist route — old shape unchanged; debriefs only on request');
  repos.scenarios.savePlayerRole({ ...baseRole, id: 'role_wc_protag', name: 'The Captain', archetype: 'crucible-fixed' });
  const OLD_REPLY = { id: 'captain_defining_choice', setup: words(120), options: [{ id: 'hold_the_line', text: words(12) }, { id: 'pull_back', text: words(12) }, { id: 'go_alone', text: words(12) }], time_advance: 0, at_elapsed_fraction: 0.6, principal_transition: { type: 'decision_made', moment: 'captain_defining_choice' } };
  {
    modelQueue.push(JSON.stringify(OLD_REPLY));
    const r = await post(genUrl('role_wc_protag'), {});
    const call = modelCalls.at(-1);
    check('→ 200', r.status === 200, `${r.status} ${r.body.error || ''}`);
    check('system prompt is exactly the protagonist prompt (anchored)', call.system === admin.buildDefiningMomentSystemPrompt(admin.DEFINING_MOMENT_EXEMPLAR, true));
    check('no lever in the user prompt; 8000-token ceiling as before', !/CONFIRMED LEVER/.test(call.user) && call.max_tokens === 8000);
    const dm = repos.scenarios.findPlayerRole('role_wc_protag').defining_moment;
    check('stored block: the old keys exactly', JSON.stringify(Object.keys(dm).sort()) === JSON.stringify(['at_elapsed_fraction', 'generated', 'id', 'options', 'principal_transition', 'reviewed', 'setup', 'time_advance']) && dm.at_elapsed_fraction === 0.6, Object.keys(dm).join(','));
    check('options: id + text only', dm.options.every(o => JSON.stringify(Object.keys(o)) === '["id","text"]'));
    check('response: the old keys exactly (no lint_warnings, no path)', JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['classification', 'defining_moment', 'roleId']), Object.keys(r.body).join(','));
  }
  {
    modelQueue.push(JSON.stringify({ ...OLD_REPLY, options: OLD_REPLY.options.map((o, i) => ({ ...o, label: `Stance ${i + 1}`, debrief: `${words(110)} ${o.id}.` })) }));
    const r = await post(genUrl('role_wc_protag'), { overwrite: true, with_debriefs: true });
    const call = modelCalls.at(-1);
    check('with_debriefs → the protagonist prompt + Step 7, nothing else changed', call.system === admin.buildDefiningMomentSystemPrompt(admin.DEFINING_MOMENT_EXEMPLAR, true) + '\n' + admin.PROTAGONIST_DEBRIEF_STEP);
    const dm = repos.scenarios.findPlayerRole('role_wc_protag').defining_moment;
    check('with_debriefs → saved with labels and debriefs, still on the 0.6 clock', r.status === 200 && dm.options.every(o => o.label && o.debrief) && dm.at_elapsed_fraction === 0.6, `${r.status} ${r.body.error || ''}`);
    modelQueue.push(JSON.stringify(OLD_REPLY));
    const m = await post(genUrl('role_wc_protag'), { overwrite: true, with_debriefs: true });
    check('debriefs requested but missing → 500, not saved', m.status === 500 && /debriefs were requested/.test(m.body.error) && repos.scenarios.findPlayerRole('role_wc_protag').defining_moment.options.every(o => o.debrief));
  }

  head('5c. witness route — the full shape, generated on the confirmed lever');
  const usher = () => repos.scenarios.findPlayerRole('role_wc_usher');
  {
    check('precondition: the usher\'s lever is confirmed, bound to scene_b, and he has no block', usher().witness_lever?.confirmed === true && usher().witness_lever.scene_binding.at_scene === 'scene_b' && !usher().defining_moment);
    // The model tries to set its own timing and provenance; all of it is discarded.
    modelQueue.push(JSON.stringify({ ...GOOD_BLOCK, at_elapsed_fraction: 0.6, at_scene: 'scene_zzz', generated: false, reviewed: true, timing_confirmed: true }));
    const r = await post(genUrl('role_wc_usher'), {});
    const call = modelCalls.at(-1);
    check('→ 200 on the witness-crucible path', r.status === 200 && r.body.path === 'witness-crucible', `${r.status} ${r.body.error || ''}`);
    check('system prompt is the witness prompt (anchored), exemplar Manchon', call.system === admin.buildWitnessCrucibleSystemPrompt(admin.witnessExemplarFor(usher()), true) && call.system.includes('The dress is on her'));
    check('witness prompt: Steps 1W, 3W, 5W, 6W, 7 and the anchored rules', ['STEP 1W', 'STEP 1B', 'STEP 3W', 'STEP 5W', 'STEP 6W', 'STEP 7'].every(s => call.system.includes(s)));
    check('witness prompt: NOT Test 3, NOT the 90-140 budget', !/WITNESS SCENARIOS MUST DECLINE|TEST 3 — CHARACTER-REVEALING AGENCY/.test(call.system) && !/90 to 140/.test(call.system));
    check('witness prompt: the banned phrasings are stated', /could not save her \/ him \/ them/.test(call.system) && /your fault/.test(call.system));
    check('16000-token ceiling', call.max_tokens === 16000);
    check('user prompt carries the confirmed lever: counter-case, both sources, terms, bound scene',
      call.user.includes('CONFIRMED LEVER') && call.user.includes(LEVER.counter_case.assumption) && LEVER.evidence.every(e => call.user.includes(`[source: ${e.source}]`))
      && call.user.includes('INSTRUMENT TERMS (every debrief uses at least one): corridor, testify') && call.user.includes('BOUND SCENE: scene_b — 28 May. The relapse: the judges come to the cell.') && /Step 1W/.test(call.user));
    const dm = usher().defining_moment;
    check('stored: generated:true, reviewed:false (model provenance discarded)', dm.generated === true && dm.reviewed === false);
    check('stored: bound at_scene scene_b from the confirmed lever; no clock fraction; no timing confirmation', dm.at_scene === 'scene_b' && !('at_elapsed_fraction' in dm) && !('timing_confirmed' in dm) && r.body.binding_source === 'the confirmed lever');
    check('stored: every option has label, text, debrief, outcome_disclaimer, cited consequence', dm.options.every(o => o.label && o.text && o.debrief && o.outcome_disclaimer && o.consequence?.source));
    check('stored block passes the crucible lint', lint.lintCrucibleBlock(dm, { path: 'witness-crucible', generated: true, lever: usher().witness_lever }).errors.length === 0);
    check('stored block passes the validator', admin.validateDefiningMomentBlock(dm).length === 0);
  }

  head('5d. witness route — a block that breaks a rule is NOT saved');
  {
    const saved = JSON.stringify(usher().defining_moment);
    for (const [label, fn, rx] of [
      ['"could not save her"',               b => { b.options[0].debrief += ' You could not save her.'; },               /failed-rescue/],
      ['consequence source not in evidence', b => { b.options[1].consequence.source = 'Chronicle of an unnamed monk'; }, /evidence sources/],
      ['debriefs identical',                 b => { for (const o of b.options) o.debrief = b.options[0].debrief; },      /do not branch/],
    ]) {
      modelQueue.push(JSON.stringify(mutate(fn)));
      const r = await post(genUrl('role_wc_usher'), { overwrite: true });
      check(`${label} → 500, errors named, nothing written`, r.status === 500 && r.body.errors?.some(e => rx.test(e)) && JSON.stringify(usher().defining_moment) === saved, `${r.status}`);
    }
    modelQueue.push(JSON.stringify({ declined: true, reason: 'lever does not hold — scripted.' }));
    const d = await post(genUrl('role_wc_usher'), { overwrite: true });
    check('decline → 200 declined, nothing written', d.status === 200 && d.body.declined === true && JSON.stringify(usher().defining_moment) === saved);
  }

  head('5e. witness binding — a regenerate keeps the outgoing binding; exemplar swap');
  {
    repos.scenarios.savePlayerRole({ ...usher(), defining_moment: { ...usher().defining_moment, at_scene: 'scene_a' } });
    const before = fs.existsSync(BACKUP_FILE) ? fs.readFileSync(BACKUP_FILE, 'utf8').length : 0;
    modelQueue.push(JSON.stringify(GOOD_BLOCK));
    const r = await post(genUrl('role_wc_usher'), { overwrite: true });
    check('outgoing at_scene scene_a carried over (not the lever\'s scene_b)', r.status === 200 && usher().defining_moment.at_scene === 'scene_a' && r.body.binding_source === 'carried over from the outgoing block');
    const after = fs.readFileSync(BACKUP_FILE, 'utf8');
    check('the replaced block was backed up first', after.length > before && /generated, unreviewed/.test(after.slice(before)));
    check('exemplar for Manchon himself is Massieu\'s', admin.witnessExemplarFor({ id: 'role_manchon' }).role_id === 'role_massieu');
    check('exemplar for anyone else is Manchon\'s', admin.witnessExemplarFor({ id: 'role_wc_usher' }).role_id === 'role_manchon');
  }

  head('5f. a hand-authored witness crucible is guarded on the witness path too');
  {
    const keep = usher().defining_moment;
    repos.scenarios.savePlayerRole({ ...usher(), defining_moment: AUTHORED_CRUCIBLE });
    const calls = modelCalls.length;
    const r = await post(genUrl('role_wc_usher'), { overwrite: true, confirm: 'REPLACE' });
    check('REPLACE alone → 409 crucible tier, no model call', r.status === 409 && r.body.crucibleAtRisk === true && modelCalls.length === calls);
    repos.scenarios.savePlayerRole({ ...usher(), defining_moment: keep });
  }

  head('5g. exemplars — verbatim from the authored role files, and they meet the generated-block rules');
  for (const ex of admin.WITNESS_CRUCIBLE_EXEMPLARS) {
    const r = lint.lintCrucibleBlock(ex.block, { path: 'witness-crucible', generated: true, lever: ex.lever });
    check(`${ex.role_id}: annotated exemplar passes the GENERATED lint (verbatim disclaimer + cited consequence + lever terms)`, r.errors.length === 0 && r.warnings.length === 0, [...r.errors, ...r.warnings].join(' | '));
    check(`${ex.role_id}: exemplar lever is a valid lever`, admin.validateWitnessLever({ ...ex.lever, reasoning: 'r', scene_binding: { at_scene: null } }, []).length === 0);
    const f = path.join(REPO_DIR, 'engine/data/scenarios/player_roles', `${ex.role_id}.json`);
    if (!fs.existsSync(f)) { console.log(`SKIP  ${ex.role_id} — not restored locally; drift not checked`); continue; }
    const dm = JSON.parse(fs.readFileSync(f, 'utf8')).defining_moment;
    check(`${ex.role_id}: setup, ids, labels, texts, debriefs match the role file verbatim`,
      dm.id === ex.block.id && dm.setup === ex.block.setup && dm.options.length === ex.block.options.length
      && dm.options.every((o, i) => ['id', 'label', 'text', 'debrief'].every(k => o[k] === ex.block.options[i][k])));
  }

  // ═══ DRY RUN ═══════════════════════════════════════════════════════════════
  // The whole first-real-model test must run with NO write: no flag, no lever, no block, no
  // backup. Proof is three-way: the store directory is byte-identical before and after, the
  // backup file is unchanged, and savePlayerRole is never called.
  const snapStore = () => {
    const out = {};
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : (out[p] = fs.readFileSync(p, 'utf8')); } };
    walk(TMP);
    return JSON.stringify(out);
  };
  const backupLen = () => (fs.existsSync(BACKUP_FILE) ? fs.readFileSync(BACKUP_FILE, 'utf8').length : 0);
  let saves = 0;
  const realSave = repos.scenarios.savePlayerRole.bind(repos.scenarios);
  const writesNothing = async (fn) => {
    const s = snapStore(), b = backupLen(), n = saves;
    const r = await fn();
    return { r, clean: snapStore() === s && backupLen() === b && saves === n };
  };
  // An UNFLAGGED witness carrying an authored crucible and no lever: Manchon as prod has him.
  repos.scenarios.savePlayerRole({ ...baseRole, id: 'role_wc_notary', name: 'The Notary', archetype: 'witness', defining_moment: AUTHORED_CRUCIBLE });
  repos.scenarios.savePlayerRole = (role) => { saves++; return realSave(role); };
  const { generated: _lg, confirmed: _lc, ...INLINE_LEVER } = LEVER;
  const proposeUrl = id => `/scenarios/${SCENARIO_ID}/roles/${id}/propose-witness-lever`;

  head('5h. dry run — propose and generate on an unflagged witness, writing NOTHING');
  {
    modelQueue.push(JSON.stringify({ ...INLINE_LEVER, confirmed: true }));
    const { r, clean } = await writesNothing(() => post(proposeUrl('role_wc_notary'), { dry_run: true }));
    check('propose dry_run on an unflagged witness → 200, dry_run, saved:false', r.status === 200 && r.body.dry_run === true && r.body.saved === false, `${r.status} ${r.body.error || ''}`);
    check('  the proposal is returned unconfirmed (the model cannot confirm it)', r.body.witness_lever?.axis === LEVER.axis && r.body.witness_lever.confirmed === false);
    check('  NOTHING written (store bytes, backup, savePlayerRole)', clean);
    check('  without dry_run the unflagged witness is still refused', (await post(proposeUrl('role_wc_notary'), {})).body.code === 'NOT_WITNESS_CRUCIBLE');
  }
  {
    const calls = modelCalls.length;
    modelQueue.push(JSON.stringify(GOOD_BLOCK));
    const { r, clean } = await writesNothing(() => post(genUrl('role_wc_notary'), { dry_run: true, lever: INLINE_LEVER }));
    const call = modelCalls.at(-1);
    check('generate dry_run + inline lever, over an AUTHORED crucible, no tokens → 200', r.status === 200 && r.body.dry_run === true && r.body.saved === false && modelCalls.length === calls + 1, `${r.status} ${r.body.error || ''}`);
    check('  ran on the witness prompt with the inline lever in the user prompt', call.system.includes('STEP 5W') && call.user.includes('CONFIRMED LEVER') && call.user.includes(LEVER.counter_case.assumption));
    check('  returns the block as it would be saved (stamped, linted, bound)', r.body.defining_moment?.generated === true && r.body.defining_moment.reviewed === false && r.body.defining_moment.options.every(o => o.label && o.debrief) && Array.isArray(r.body.lint_warnings) && r.body.lever_source === 'inline (dry run)' && typeof r.body.binding_source === 'string');
    check('  names what a real run would replace', r.body.would_replace?.id === AUTHORED_CRUCIBLE.id && r.body.would_replace.authored_crucible === true);
    check('  NOTHING written: the authored block is untouched, no backup, no save', clean && JSON.stringify(repos.scenarios.findPlayerRole('role_wc_notary').defining_moment) === JSON.stringify(AUTHORED_CRUCIBLE));
  }
  {
    modelQueue.push(JSON.stringify(mutate(b => { b.options[0].debrief += ' You could not save her.'; })));
    const { r, clean } = await writesNothing(() => post(genUrl('role_wc_notary'), { dry_run: true, lever: INLINE_LEVER }));
    check('dry run, lint failure → 500 with the errors, nothing written', r.status === 500 && r.body.errors?.some(e => /failed-rescue/.test(e)) && clean);
    modelQueue.push(JSON.stringify({ declined: true, reason: 'scripted' }));
    const d = await writesNothing(() => post(genUrl('role_wc_notary'), { dry_run: true, lever: INLINE_LEVER }));
    check('dry run, decline → 200 declined, nothing written', d.r.status === 200 && d.r.body.declined === true && d.clean);
  }
  {
    const calls = modelCalls.length;
    const bad = await writesNothing(() => post(genUrl('role_wc_notary'), { dry_run: true, lever: { ...INLINE_LEVER, scene_binding: { at_scene: 'scene_zzz', reasoning: 'r' } } }));
    check('inline lever naming a scene not in the arc → 400, no model call, nothing written', bad.r.status === 400 && /not a scene of this arc/.test(bad.r.body.error) && modelCalls.length === calls && bad.clean);
    const thin = await post(genUrl('role_wc_notary'), { dry_run: true, lever: { ...INLINE_LEVER, evidence: [LEVER.evidence[0]] } });
    check('inline lever with one evidence item → 400', thin.status === 400 && /at least 2 cited/.test(thin.body.error));
    const inst = await post(genUrl('role_wc_instrument'), { dry_run: true, lever: INLINE_LEVER });
    check('inline lever on an INSTRUMENT → 422 refused, no model call', inst.status === 422 && inst.body.refused === true && modelCalls.length === calls);
    const prot = await post(genUrl('role_wc_protag'), { dry_run: true, lever: INLINE_LEVER });
    check('inline lever on a protagonist → 400, no model call', prot.status === 400 && /only to a witness/.test(prot.body.error) && modelCalls.length === calls);
    const live = await writesNothing(() => post(genUrl('role_wc_notary'), { lever: INLINE_LEVER, overwrite: true, confirm: 'REPLACE', confirm_crucible: AUTHORED_CRUCIBLE.id }));
    check('WITHOUT dry_run an inline lever is ignored: the unflagged witness is refused, nothing written', live.r.status === 422 && live.r.body.refused === true && modelCalls.length === calls && live.clean);
  }
  {
    // A stored, confirmed lever also works under dry run, and an authored block is not touched.
    const keep = usher().defining_moment;
    realSave({ ...usher(), defining_moment: AUTHORED_CRUCIBLE });
    modelQueue.push(JSON.stringify(GOOD_BLOCK));
    const { r, clean } = await writesNothing(() => post(genUrl('role_wc_usher'), { dry_run: true }));
    check('flagged witness, stored confirmed lever, dry_run → 200, lever_source stored, nothing written', r.status === 200 && r.body.lever_source === 'stored, confirmed' && clean, `${r.status} ${r.body.error || ''}`);
    realSave({ ...usher(), defining_moment: keep });
    modelQueue.push(JSON.stringify(OLD_REPLY));
    const p = await writesNothing(() => post(genUrl('role_wc_protag'), { dry_run: true }));
    check('protagonist dry_run over an existing block, no overwrite → 200, nothing written', p.r.status === 200 && p.r.body.dry_run === true && p.r.body.path === 'protagonist' && p.clean, `${p.r.status} ${p.r.body.error || ''}`);
  }
  repos.scenarios.savePlayerRole = realSave;

  head('5i. scene binding — the witness binds to the PROTAGONIST\'s defining-moment scene');
  {
    // The protagonist's fork binds to scene_b; a sibling witness is bound to the EARLIER
    // scene_a — the shape of the Manchon miss (an early instance of the lever, not the climax).
    const bound = (id, at_scene) => ({ ...structuredClone(GOOD_BLOCK), id, at_scene, principal_transition: { type: 'decision_made', moment: id } });
    realSave({ ...baseRole, id: 'role_wc_principal', name: 'The Prisoner', archetype: 'crucible-fixed', defining_moment: bound('prisoner_choice', 'scene_b') });
    realSave({ ...baseRole, id: 'role_wc_guard', name: 'The Guard', archetype: 'witness', defining_moment: bound('guard_choice', 'scene_a') });
    check('system prompt: binds to the defining moment, not the earliest lever',
      /fires at the scenario's DEFINING MOMENT/.test(admin.WITNESS_LEVER_SYSTEM_PROMPT) && /bind to that scene/.test(admin.WITNESS_LEVER_SYSTEM_PROMPT)
      && /Do NOT choose the earliest scene in which the lever appears/.test(admin.WITNESS_LEVER_SYSTEM_PROMPT)
      && !/the pressure is highest/.test(admin.WITNESS_LEVER_SYSTEM_PROMPT));

    modelQueue.push(JSON.stringify({ ...INLINE_LEVER, scene_binding: { at_scene: 'scene_a', reasoning: 'earliest instance of the lever' } }));
    const off = await writesNothing(() => post(proposeUrl('role_wc_notary'), { dry_run: true }));
    const user = modelCalls.at(-1).user;
    const listing = user.slice(user.indexOf('DEFINING MOMENTS ALREADY BOUND'));
    check('user prompt lists the bound defining moments, the protagonist\'s first',
      /scene_b: The Prisoner's defining moment \(PROTAGONIST\)/.test(listing) && /scene_a: The Guard's defining moment \(a witness\)/.test(listing)
      && listing.indexOf('The Prisoner') < listing.indexOf('The Guard'));
    check('  the role\'s OWN bound block is not listed (it must not read its own answer back)', !/The Notary's defining moment/.test(user));
    check('proposal off the protagonist\'s scene → returned with scene_warning, nothing written',
      off.r.status === 200 && /not the protagonist's defining-moment scene "scene_b"/.test(off.r.body.scene_warning || '') && off.clean, `${off.r.status} ${off.r.body.error || ''}`);

    modelQueue.push(JSON.stringify({ ...INLINE_LEVER, scene_binding: { at_scene: 'scene_b', reasoning: 'the prisoner\'s defining moment' } }));
    const on = await post(proposeUrl('role_wc_notary'), { dry_run: true });
    check('proposal on the protagonist\'s scene → no scene_warning', on.status === 200 && on.body.witness_lever.scene_binding.at_scene === 'scene_b' && !('scene_warning' in on.body));

    const noBound = admin.buildWitnessLeverUserPrompt({ scenario: { title: 'T' }, role: { name: 'R' }, scenes: [{ id: 's1' }] });
    check('no bound forks → no listing (falls back to the climactic scene by rule)', !/DEFINING MOMENTS ALREADY BOUND/.test(noBound));
  }
} finally {
  await new Promise(r => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(BACKUP_FILE, { force: true });
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll witness-crucible-gen assertions passed.');
process.exitCode = fails ? 1 : 0;
