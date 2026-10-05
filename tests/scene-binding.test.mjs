// FORK at_scene BINDING (B3c) — a defining moment bound to a SCENE.
//
// Joan's relapse fork is written for 28 May, in her cell. Part A could bind it to an act or a
// beat, but both wait on the model reporting beats; a scene is entered on the scene before it
// ending OR on that scene's budget running out (B3b), so a scene binding arrives even when no
// beat is ever reported. at_scene wins over at_beat and at_act. If the scene is never reached
// the fork fires at its fallback, and on that turn the session jumps to the fork's scene (B3d's
// fork path) — the setup takes the story to 28 May, and the scene follows it there.
//
// Part 1 is pure. Part 2 is the editor in jsdom. Part 3 drives the REAL router with
// api.anthropic.com scripted: the binding is applied to the session state the client posts
// (state.effectiveDefiningMoment, captured from the role at /start), so Joan's stored role is
// never written. Sessions and transcripts made here are deleted at the end.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';

process.env.DEFINING_MOMENT_ENABLED = 'true';
for (const k of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL']) delete process.env[k];

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;
const p        = (...s) => path.join(REPO_DIR, ...s);

const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { CharacterRepository } = await import(`${ROOT}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { ClueRepository }      = await import(`${ROOT}/engine/repositories/ClueRepository.js`);
const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
const { PlayerRepository }    = await import(`${ROOT}/engine/repositories/PlayerRepository.js`);
const { SessionRepository }   = await import(`${ROOT}/engine/repositories/SessionRepository.js`);
const { buildInitialState, initSceneState } = await import(`${ROOT}/engine/services/StateManager.js`);
const { isStoryBoundFork, definingMomentDue, forkTimingStatus, storyPacingNudge, arcScenes } = await import(`${ROOT}/engine/services/PromptComposer.js`);
const { describeBinding, DIAG_PREFIX } = await import(`${ROOT}/engine/services/ForkDiagnostics.js`);
const admin = await import(`${ROOT}/engine/admin/adminRouter.js`);

const store = new JsonFileStore(p('engine/data'));   // never DualWriteStore: no Supabase writes
const repos = {
  characters: new CharacterRepository(store), locations: new LocationRepository(store),
  clues: new ClueRepository(store), scenarios: new ScenarioRepository(store),
  storyArcs: new StoryArcRepository(store), players: new PlayerRepository(store),
  sessions: new SessionRepository(store),
};

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head  = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const quiet = fn => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; try { return fn(); } finally { console.warn = w; console.log = l; } };
const clone = o => JSON.parse(JSON.stringify(o));

const JOAN_ID = 'joan_trial_rouen_1431';
const joanScenario = await repos.scenarios.findById(JOAN_ID);
if (!joanScenario) { console.log('SKIP  scene-binding.test — Joan scenario not available (needs Supabase creds).'); process.exit(0); }
const JOAN_ARC  = repos.storyArcs.findById(`${JOAN_ID}_main_arc`);
const JOAN_LOCS = repos.locations.findByScenario(JOAN_ID);
const JOAN_STORED_ROLE = repos.scenarios.findPlayerRoles(JOAN_ID).find(r => r.id === 'role_joan');
const JOAN_STORED_FILE = fs.readFileSync(p('engine/data/scenarios/player_roles/role_joan.json'), 'utf8');
// The UNBOUND baseline these checks contrast against: Joan's fork on the clock (0.75), as it
// was before B3c. Rebuilt in memory from the stored block (never written) — her live fork is
// now bound at_scene scene_28_may, which is exactly BOUND below.
const FORK      = Object.fromEntries(Object.entries(clone(JOAN_STORED_ROLE.defining_moment)).filter(([k]) => !['at_scene', 'timing_confirmed'].includes(k)));
const JOAN_ROLE = { ...clone(JOAN_STORED_ROLE), defining_moment: FORK };
const BOUND     = { ...clone(FORK), at_scene: 'scene_28_may' };

// ═══ PART 1 — pure ═══════════════════════════════════════════════════════════
head('1. the gate and the due-check');
check('fixture: Joan\'s fork rebuilt on the clock (0.75), unbound', FORK.at_elapsed_fraction === 0.75 && !isStoryBoundFork(FORK));
check('stored Joan: bound at_scene scene_28_may (the BOUND shape these tests play)', JOAN_STORED_ROLE.defining_moment?.at_scene === 'scene_28_may' && isStoryBoundFork(JOAN_STORED_ROLE.defining_moment));
check('at_scene opts a fork in', isStoryBoundFork({ at_scene: 'scene_28_may' }) && !isStoryBoundFork({ at_scene: '  ' }) && !isStoryBoundFork({ at_scene: 3 }));

const sess = (scene, elapsed, block = BOUND, extra = {}) => {
  const s = quiet(() => buildInitialState(joanScenario, JOAN_ROLE, JOAN_LOCS));
  initSceneState(s, JOAN_ARC);
  return Object.assign(s, { currentSceneId: scene, elapsedMinutes: elapsed, effectiveDefiningMoment: block }, extra);
};
const due = s => definingMomentDue(s, joanScenario, JOAN_ARC);
check('in scene_24_may at 20 min: not due (binding unmet, before the 25.5 fallback)', !due(sess('scene_24_may', 20)));
check('in scene_28_may at 24 min: DUE via binding — with no beat ever reported', due(sess('scene_28_may', 24)) && forkTimingStatus(sess('scene_28_may', 24), joanScenario, JOAN_ARC).via === 'binding');
check('in scene_23_may at 25.5 min: due via fallback', forkTimingStatus(sess('scene_23_may', 25.5), joanScenario, JOAN_ARC).via === 'fallback');
check('at_scene wins over at_beat (an unmet beat binding does not hold it back)', due(sess('scene_28_may', 24, { ...BOUND, at_beat: '29_may_1431' })));
check('at_scene wins over at_beat (a met beat binding does not bring it forward)', !due(sess('scene_9_may', 12, { ...BOUND, at_beat: '21_feb_1431' }, { reachedBeats: ['21_feb_1431'] })));
check('a scene the arc does not have: fallback only', !due(sess('scene_28_may', 24, { ...BOUND, at_scene: 'scene_gone' })) && due(sess('scene_28_may', 25.5, { ...BOUND, at_scene: 'scene_gone' })));
check('a session that does not track scenes: fallback only', (() => { const s = sess('scene_28_may', 24); delete s.currentSceneId; return !due(s); })());
check('already presented / answered: never due again', !due(sess('scene_28_may', 24, BOUND, { definingMomentPresented: true })));
const st = forkTimingStatus(sess('scene_24_may', 20), joanScenario, JOAN_ARC);
check('forkTimingStatus carries at_scene', st.at_scene === 'scene_28_may' && st.bound === true);
check('DIAG binding wording', describeBinding(st) === 'at_scene scene_28_may · fallback 0.85 (default) = 25.5 of 30 min', describeBinding(st));
check('a bound fork in a scene session gets NO Part A fork nudge (scene budgets pace it)', storyPacingNudge(sess('scene_24_may', 22), joanScenario, JOAN_ARC) === null);
check('...nor does an at_beat-bound fork in a scene session, inside its nudge window', storyPacingNudge(sess('scene_24_may', 22, { ...clone(FORK), at_beat: '28_may_1431' }), joanScenario, JOAN_ARC) === null);
check('...nor an at_scene fork in a session without scenes (no beat to nudge toward)', (() => { const s = sess('scene_24_may', 22); delete s.currentSceneId; return storyPacingNudge(s, joanScenario, JOAN_ARC) === null; })());

head('2. the server keeps at_scene, like at_beat');
{
  const n = b => quiet(() => admin.normalizeForkBinding(clone(b), 'role_joan'));
  check('at_scene kept, trimmed', n({ ...FORK, at_scene: ' scene_28_may ' }).at_scene === 'scene_28_may');
  check('blank at_scene dropped (no new key on an unbound role)', !('at_scene' in n({ ...FORK, at_scene: '' })) && !('at_scene' in n({ ...FORK, at_scene: null })));
  const src = fs.readFileSync(p('engine/admin/adminRouter.js'), 'utf8');
  check('regenerate carries at_scene over with the rest of the binding (FORK_BINDING_KEYS)', /const FORK_BINDING_KEYS = \[[^\]]*'at_scene'[^\]]*\]/.test(src));
  const stored = { ...clone(JOAN_ROLE), defining_moment: { ...clone(FORK), timing_confirmed: { at_elapsed_fraction: 0.75, at_act: null, at_beat: null, at_scene: null, fallback_at_elapsed_fraction: null } } };
  const posted = { ...clone(stored), defining_moment: { ...clone(stored.defining_moment), at_scene: 'scene_28_may' } };
  const saved  = quiet(() => admin.preserveStoredRoleBlocks({ scenarios: { findPlayerRole: () => clone(stored) } }, posted)).defining_moment;
  check('binding Joan to scene_28_may clears her clock-0.75 timing confirmation (B3a)', saved.at_scene === 'scene_28_may' && !('timing_confirmed' in saved));
}

// ═══ PART 2 — the editor ═════════════════════════════════════════════════════
head('3. the editor — "Fires in scene"');
{
  const { JSDOM } = await import('jsdom');
  const html = fs.readFileSync(p('engine/admin/index.html'), 'utf8');
  const dom  = new JSDOM(html, {
    runScripts: 'dangerously', url: 'http://localhost/admin/', pretendToBeVisual: true,
    beforeParse(w) { w.fetch = async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }); w.confirm = () => true; w.alert = () => {}; },
  });
  const win = dom.window;
  await new Promise(r => win.addEventListener('load', r, { once: true }));
  await new Promise(r => setTimeout(r, 200));
  const mount = (role, arc = JOAN_ARC) => {
    const data = { scenario: { introduction: { sections: [] } }, playerRoles: [clone(role)], storyArc: clone(arc) };
    const formEl = win.document.createElement('form');
    formEl.innerHTML = win.renderDefiningMomentSection(data.playerRoles[0], 0, data);
    win.document.body.appendChild(formEl);
    win.bindDefiningMomentHandlers(formEl, data, role.scenarioId);
    return { formEl, data, sel: formEl.querySelector('.dm-at-scene-input'), cb: formEl.querySelector('.dm-timing-cb') };
  };
  const m = mount(JOAN_ROLE);
  const vals = m.sel ? [...m.sel.options].map(o => o.value) : [];
  check('Joan: "Fires in scene" lists her 7 scenes in story order, blank first', JSON.stringify(vals) === JSON.stringify(['', 'scene_21_feb', 'scene_24_feb', 'scene_17_mar', 'scene_9_may', 'scene_23_may', 'scene_24_may', 'scene_28_may']), vals.join(','));
  check('...grouped by act, labelled with the date', m.sel?.querySelectorAll('optgroup').length === 4 && [...m.sel.options].some(o => o.textContent.includes('scene_28_may — 28 May 1431')));
  check('unbound: nothing selected', m.sel?.value === '');
  m.sel.value = 'scene_28_may';
  m.cb.checked = true;
  m.sel.dispatchEvent(new win.Event('change', { bubbles: true }));
  check('choosing a scene un-ticks the timing box (B3a)', m.cb.checked === false);
  win.collectEdits(m.formEl, m.data);
  check('the save posts at_scene', m.data.playerRoles[0].defining_moment.at_scene === 'scene_28_may');
  const b = mount({ ...JOAN_ROLE, defining_moment: BOUND });
  check('a bound role renders its scene selected, and the clock fraction marked ignored', b.sel?.value === 'scene_28_may' && b.formEl.textContent.includes('ignored — story-bound'));
  const o = mount({ ...JOAN_ROLE, defining_moment: { ...BOUND, at_scene: 'scene_gone' } });
  check('a stored scene the arc lacks is kept, flagged', o.sel?.value === 'scene_gone' && o.sel.selectedOptions[0].textContent.includes('⚠'));
  const noScenes = clone(JOAN_ARC); for (const a of noScenes.acts) delete a.scenes;
  check('an arc with no scenes: no "Fires in scene" field', !mount(JOAN_ROLE, noScenes).sel);
}

// ═══ PART 3 — the real router ════════════════════════════════════════════════
head('4. e2e — Joan bound to scene_28_may, through /start + /turn');
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
let nextOutput = null;
function sseStream(text) {
  const events = [`data: ${JSON.stringify({ type: 'content_block_start', index: 0 })}\n\n`];
  for (let i = 0; i < text.length; i += 40) events.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 40) } })}\n\n`);
  events.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 100 } })}\n\n`);
  const body = new ReadableStream({ start(c) { const e = new TextEncoder(); for (const x of events) c.enqueue(e.encode(x)); c.close(); } });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  const text = JSON.stringify(nextOutput);
  return body.stream ? sseStream(text) : new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const { createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/game/api', createGameRouter(repos, { anthropicApiKey: 'scene-binding-test-key' }));
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const snapshot = dir => { try { return new Set(fs.readdirSync(p(dir))); } catch { return new Set(); } };
// appData.saveSession writes the session state to the repo-root data/sessions (engine/data.js), not engine/data/sessions.
const beforeSessions = snapshot('engine/data/sessions'), beforeTranscripts = snapshot('engine/data/transcripts'), beforeState = snapshot('data/sessions');
const sse = async (route, body) => {
  const resp = await realFetch(`${BASE}/game/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const raw  = await resp.text();
  const evs  = raw.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  return { status: resp.status, done: evs.find(e => e.type === 'done'), error: evs.find(e => e.type === 'error') };
};
const out = () => ({ narrative: 'The assessors murmur; the scribes dip their pens.', choices: ['Answer carefully', 'Say nothing', 'Ask for counsel'], location: 'great_hall_rouen_castle', timeAdvance: 2, stateChanges: {} });

// Plays a Joan session with the given fork block until the fork is presented (or maxTurns).
async function play(block, maxTurns) {
  nextOutput = out();
  const st0 = await sse('start', { scenarioId: JOAN_ID, roleId: 'role_joan', narrativeStyle: 'focused' });
  let s = st0.done?.nextState; const sid = st0.done?.sessionId;
  if (!s) return { ok: false, error: st0.error };
  s.effectiveDefiningMoment = block;
  let forkTurn = null, forkAt = null, fork = null;
  for (let t = 1; t <= maxTurns; t++) {
    nextOutput = out();
    const r = await sse('turn', { state: s, playerInput: `I answer as I must (${t}).`, sessionId: sid });
    if (!r.done) return { ok: false, error: r.error };
    if (r.done.nextState.definingMomentPresented && !s.definingMomentPresented) { forkTurn = t; forkAt = s.elapsedMinutes; fork = r.done.output; }
    s = r.done.nextState;
    if (forkTurn) break;
  }
  const diag = fs.readFileSync(p('engine/data/transcripts', `${sid}.md`), 'utf8').split('\n').filter(l => l.startsWith(DIAG_PREFIX));
  return { ok: true, s, sid, forkTurn, forkAt, fork, diag };
}

try {
  // A. Binding met: a model that never reports a beat. The budgets carry the story into
  //    scene_28_may at 24 min (B3b); the fork is put on the next turn, via the binding.
  const a = await play(BOUND, 16);
  check('A: session runs', a.ok, JSON.stringify(a.error || '').slice(0, 200));
  if (a.ok) {
    check('A: the fork is put in scene_28_may at 24 min (turn 13) — after the scene is entered, before the 25.5 fallback', a.forkTurn === 13 && a.forkAt === 24 && a.s.currentSceneId === 'scene_28_may', `turn ${a.forkTurn} at ${a.forkAt} min, scene ${a.s.currentSceneId}`);
    const line = a.diag[a.diag.length - 1] || '';
    check('A DIAG: PRESENTED via binding (at_scene met at turn start)', line.includes('fork: PRESENTED this turn via binding (at_scene scene_28_may met at turn start)'), line);
    check('A: no fork jump (the scene was reached on budget, not by the fork)', !a.s.sceneAdvances.some(m => m.via === 'fork'));
    check('A: the fork turn costs no clock', a.s.elapsedMinutes === 24, `${a.s.elapsedMinutes}`);
    // B2b-PLAYER: the fork turn plays in scene_28_may, which it opens — and shows no bridge:
    // the fork's setup is the transition.
    const sc28 = arcScenes(JOAN_ARC).find(x => x.id === 'scene_28_may');
    check('A PLAYER: the fork turn\'s output.scene is scene_28_may (the scene it opens)', a.fork?.scene?.id === 'scene_28_may' && a.fork.scene.date === sc28.date_label, JSON.stringify(a.fork?.scene));
    check('A PLAYER: ...with NO bridge, though scene_28_may has one', !!sc28.bridge && !('bridge' in (a.fork?.scene || {})));
    check('A: the fork\'s options reach the client', Array.isArray(a.fork?.definingChoices) ? a.fork.definingChoices.length === 3 : JSON.stringify(a.fork || {}).includes(FORK.options[0].id), Object.keys(a.fork || {}).join(','));
  }

  // B. Binding NOT met in time: fallback 0.5 (15 min). The fork fires at the turn starting at
  //    16 min, in scene_23_may — and the session jumps straight to scene_28_may with it.
  const b = await play({ ...BOUND, fallback_at_elapsed_fraction: 0.5 }, 16);
  check('B: session runs', b.ok, JSON.stringify(b.error || '').slice(0, 200));
  if (b.ok) {
    check('B: the fork fires on its fallback at 16 min (turn 9)', b.forkTurn === 9 && b.forkAt === 16, `turn ${b.forkTurn} at ${b.forkAt} min`);
    const last = b.s.sceneAdvances[b.s.sceneAdvances.length - 1];
    check('B: on that turn the scene jumps to the fork\'s scene, via fork', last?.via === 'fork' && last.from === 'scene_23_may' && last.to === 'scene_28_may' && b.s.currentSceneId === 'scene_28_may', JSON.stringify(last));
    const line = b.diag[b.diag.length - 1] || '';
    check('B DIAG: PRESENTED via fallback, and "jumped by fork"', line.includes('fork: PRESENTED this turn via fallback') && line.includes('scene: scene_23_may → scene_28_may (jumped by fork)'), line);
    check('B: the jump skipped scene_24_may (the fork path is the only one that skips)', !b.s.sceneAdvances.some(m => m.to === 'scene_24_may'));
    // B2b-PLAYER: the fork turn shows the scene it played in (scene_23_may, opened turns
    // earlier — no bridge); the turn after the jump plays in scene_28_may, also with no bridge.
    check('B PLAYER: the fork turn shows scene_23_may, no bridge', b.fork?.scene?.id === 'scene_23_may' && !('bridge' in b.fork.scene), JSON.stringify(b.fork?.scene));
    nextOutput = out();
    const after = await sse('turn', { state: b.s, playerInput: 'I keep silent.', sessionId: b.sid });
    check('B PLAYER: the turn after the fork jump shows scene_28_may with NO bridge (reached by the fork)', after.done?.output?.scene?.id === 'scene_28_may' && !('bridge' in after.done.output.scene), JSON.stringify(after.done?.output?.scene));
  }
} finally {
  // /closing-prose keeps writing the transcript after it sends `done`: a file removed too early is
  // re-created by that late write. Let the writes land, then sweep twice.
  await new Promise(res => setTimeout(res, 1500));
  server.close();
  globalThis.fetch = realFetch;
  for (let pass = 0; pass < 2; pass++) {
    for (const [dir, before] of [['engine/data/sessions', beforeSessions], ['engine/data/transcripts', beforeTranscripts], ['data/sessions', beforeState]]) {
      for (const f of snapshot(dir)) if (!before.has(f)) { try { fs.rmSync(p(dir, f), { force: true }); } catch {} }
    }
    if (!pass) await new Promise(res => setTimeout(res, 1000));
  }
  const left = [...snapshot('engine/data/sessions')].filter(f => !beforeSessions.has(f)).length + [...snapshot('engine/data/transcripts')].filter(f => !beforeTranscripts.has(f)).length + [...snapshot('data/sessions')].filter(f => !beforeState.has(f)).length;
  check('sessions and transcripts created by this test are removed', left === 0, `${left} left`);
  check('Joan\'s stored role is untouched (byte-identical to the start of the run)', fs.readFileSync(p('engine/data/scenarios/player_roles/role_joan.json'), 'utf8') === JOAN_STORED_FILE);
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll scene-binding assertions passed.');
process.exit(fails ? 1 : 0);
