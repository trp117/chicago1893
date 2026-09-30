// SCENE TRACKING (Part B, B2a) — state + diagnostics only, gated on the arc having scenes.
//
// A scenario whose arc carries scenes[] now: loads its arc for every role (loadStoryArc), puts
// the Part A beat roster in the model prompt (so beats get reported), starts the session in
// its first scene (initSceneState), and moves state.currentSceneId forward as the reported
// beats pass each scene's ends_on_beat (advanceScene). The DIAG line records every crossing.
// NOTHING about scenes reaches the player or the model: no header, bridge, location, and no
// scene id / date / bridge text in any prompt (that is B2b).
//
// THE GATE IS THE POINT, as in Part A: a scenario with no scenes gets no arc it did not get
// before, no scene state, no DIAG line, and a byte-identical prompt. storybound.test and
// scenes.test carry the corpus-wide byte-identity sweeps; this file owns the tracking itself.
//
// Part 1 is pure (repositories + real data, no writes). Part 2 drives the REAL router over a
// real socket with api.anthropic.com scripted (the degradation.test harness), so the wiring in
// gameRouter — /start init, per-turn advance, the DIAG gate — is exercised as it runs. Its
// sessions and transcripts are deleted at the end. Needs Supabase for scenario lookups.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';

process.env.DEFINING_MOMENT_ENABLED = 'true';
// No telemetry from a scripted run.
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
const { buildInitialState, loadStoryArc, loadForkStoryArc, initSceneState, advanceScene, recordReachedBeats } =
  await import(`${ROOT}/engine/services/StateManager.js`);
const { composeTurnPrompt, arcScenes, arcHasScenes, buildStoryPositionDirective, isStoryBoundFork } =
  await import(`${ROOT}/engine/services/PromptComposer.js`);
const { forkDiagTurnLine, forkDiagSummaryLines, forkDiagActive, parseSceneDiag, DIAG_PREFIX } =
  await import(`${ROOT}/engine/services/ForkDiagnostics.js`);

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
if (!joanScenario) { console.log('SKIP  scene-tracking.test — Joan scenario not available (needs Supabase creds).'); process.exit(0); }
const JOAN_ARC   = repos.storyArcs.findById(`${JOAN_ID}_main_arc`);
const JOAN_LOCS  = repos.locations.findByScenario(JOAN_ID);
const JOAN_ROLES = repos.scenarios.findPlayerRoles(JOAN_ID);
const SEQ = ['scene_21_feb', 'scene_24_feb', 'scene_17_mar', 'scene_9_may', 'scene_23_may', 'scene_24_may', 'scene_28_may'];

// ═══ PART 1 — pure ═══════════════════════════════════════════════════════════
head('0. fixture — Joan\'s stored scenes');
check('Joan\'s arc carries the 7 scenes in story order', JSON.stringify(arcScenes(JOAN_ARC).map(s => s.id)) === JSON.stringify(SEQ), arcScenes(JOAN_ARC).map(s => s.id).join(' → '));

head('1. the gate — which sessions load an arc');
{
  const SCEN_DIR = p('engine/data/scenarios');
  const ids = [...new Set(fs.readdirSync(p('engine/data/scenarios/player_roles')).filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(SCEN_DIR, 'player_roles', f), 'utf8')).scenarioId; } catch { return null; } }).filter(Boolean))].sort();
  let roles = 0; const wrong = [];
  for (const id of ids) {
    const scenario = await repos.scenarios.findById(id);
    if (!scenario) continue;
    const arc = scenario.storyArcIds?.[0] ? repos.storyArcs.findById(scenario.storyArcIds[0]) : null;
    const locs = repos.locations.findByScenario(id);
    for (const role of repos.scenarios.findPlayerRoles(id)) {
      roles++;
      const st   = quiet(() => buildInitialState(scenario, role, locs));
      const got  = quiet(() => loadStoryArc(repos, scenario, st));
      const fork = quiet(() => loadForkStoryArc(repos, scenario, st));
      // Expected: the fork arc exactly as Part A decides it; otherwise the arc only if it has scenes.
      const want = fork || (arcHasScenes(arc) ? arc : null);
      if ((got?.id ?? null) !== (want?.id ?? null)) wrong.push(`${id}/${role.id}`);
    }
  }
  check(`loadStoryArc = Part A fork arc, else the arc only when it has scenes (${roles} stored roles)`, roles > 0 && wrong.length === 0, wrong.join(', '));
  for (const role of JOAN_ROLES) {
    const st = quiet(() => buildInitialState(joanScenario, role, JOAN_LOCS));
    check(`Joan ${role.id.padEnd(13)} (fork: ${role.defining_moment ? (isStoryBoundFork(role.defining_moment) ? 'bound' : 'clock') : 'none'}) loads the scene arc`, quiet(() => loadStoryArc(repos, joanScenario, st))?.id === JOAN_ARC.id);
  }
}

head('2. init + advance — the rule');
const startState = () => { const st = quiet(() => buildInitialState(joanScenario, JOAN_ROLES.find(r => r.id === 'role_manchon'), JOAN_LOCS)); initSceneState(st, JOAN_ARC); return st; };
const report = (st, beats, turn) => { quiet(() => recordReachedBeats(st, { stateChanges: { beats_reached: beats } }, JOAN_ARC)); return quiet(() => advanceScene(st, JOAN_ARC, turn)); };
{
  const st = startState();
  check('initSceneState: first scene of Act 1', st.currentSceneId === 'scene_21_feb');
  check('...with an empty advance log', Array.isArray(st.sceneAdvances) && st.sceneAdvances.length === 0);
  check('no beat reported → no advance', report(st, [], 1).length === 0 && st.currentSceneId === 'scene_21_feb');
  const visited = [st.currentSceneId];
  const endBeats = ['21_feb_1431', '24_feb_1431', '17_mar_1431', '9_may_1431', '23_may_1431', '24_may_1431'];
  endBeats.forEach((b, i) => { const m = report(st, [b], i + 2); if (m.length) visited.push(st.currentSceneId); });
  check('each scene\'s ends_on_beat advances to the next, in order', JSON.stringify(visited) === JSON.stringify(SEQ), visited.join(' → '));
  check('the advance log records from / to / beat / turn', st.sceneAdvances.length === 6 && st.sceneAdvances[0].from === 'scene_21_feb' && st.sceneAdvances[0].to === 'scene_24_feb' && st.sceneAdvances[0].beat === '21_feb_1431' && st.sceneAdvances[0].turn === 2);
  check('last scene: its beat reached → stays (no next scene)', report(st, ['28_may_1431'], 9).length === 0 && st.currentSceneId === 'scene_28_may');
  // Story position, as Part A defines it: the_voices_are sits AFTER both 21_feb_1431 and
  // 24_feb_1431 in arc order, so reporting it alone means the story is past both scenes' ends.
  check('a later non-ending beat (the_voices_are) carries the scene past every ending beat before it', (() => { const s = startState(); return report(s, ['the_voices_are'], 1).length === 2 && s.currentSceneId === 'scene_17_mar'; })());
}
{
  const st = startState();
  const m = report(st, ['17_mar_1431'], 1);   // skip: story reported a later beat first
  check('skipped beats: a later beat crosses every scene it is past (multi-hop in one turn)', m.map(x => x.to).join(',') === 'scene_24_feb,scene_17_mar,scene_9_may' && st.currentSceneId === 'scene_9_may', m.map(x => `${x.from}→${x.to}`).join(', '));
  const st2 = startState();
  const m2 = report(st2, ['9_may_1431', '21_feb_1431'], 1);   // out-of-order report in one turn
  check('out-of-order reports resolve by story position', st2.currentSceneId === 'scene_23_may' && m2.length === 4);
}
{
  const arc = clone(JOAN_ARC);
  delete arc.acts[0].scenes[1].ends_on_beat;   // scene_24_feb becomes budget-only
  const st = quiet(() => buildInitialState(joanScenario, JOAN_ROLES[0], JOAN_LOCS)); initSceneState(st, arc);
  quiet(() => recordReachedBeats(st, { stateChanges: { beats_reached: ['9_may_1431'] } }, arc));
  quiet(() => advanceScene(st, arc, 1));
  check('a budget-only scene (no ends_on_beat) holds — B3 adds budgets', st.currentSceneId === 'scene_24_feb');
  const lost = { ...startState(), currentSceneId: 'scene_deleted' };
  check('a current scene no longer in the arc holds, with a warning', quiet(() => advanceScene(lost, JOAN_ARC, 1)).length === 0 && lost.currentSceneId === 'scene_deleted');
}

head('3. inert without scenes');
{
  const WG   = await repos.scenarios.findById('watergate_1972_part1_breach');
  const WGA  = repos.storyArcs.findById(WG.storyArcIds[0]);
  const wgL  = repos.locations.findByScenario(WG.id);
  const mcc  = repos.scenarios.findPlayerRoles(WG.id).find(r => r.id === 'role_mccord');
  const st   = quiet(() => buildInitialState(WG, mcc, wgL));
  const before = JSON.stringify(st);
  check('initSceneState on an arc with no scenes adds nothing', initSceneState(st, WGA) === null && JSON.stringify(st) === before);
  quiet(() => recordReachedBeats(st, { stateChanges: { beats_reached: ['wills_completes_his'] } }, WGA));
  const afterBeats = JSON.stringify(st);
  check('advanceScene on a session without scene state does nothing', advanceScene(st, WGA, 1).length === 0 && JSON.stringify(st) === afterBeats);
  check('a bound-fork session with no scenes is NOT scene-tracked (DIAG via its fork only)', forkDiagActive(st, WG) === true && !('currentSceneId' in st));
  const gb = await repos.scenarios.findById('greensboro_four_the_color_line');
  const gst = quiet(() => buildInitialState(gb, repos.scenarios.findPlayerRoles(gb.id)[0], repos.locations.findByScenario(gb.id)));
  check('an unbound, scene-less session writes no DIAG', forkDiagActive(gst, gb) === false);
}

head('4. nothing about scenes reaches the model prompt');
{
  const promptFor = (st, arc) => composeTurnPrompt(st, 'I wait and watch.', { scenario: joanScenario, characters: [], locations: JOAN_LOCS, clues: [], ...(arc ? { storyArc: arc } : {}) });
  const bare = quiet(() => buildInitialState(joanScenario, JOAN_ROLES.find(r => r.id === 'role_manchon'), JOAN_LOCS));
  const tracked = clone(bare); initSceneState(tracked, JOAN_ARC);
  quiet(() => recordReachedBeats(tracked, { stateChanges: { beats_reached: ['24_feb_1431'] } }, JOAN_ARC)); quiet(() => advanceScene(tracked, JOAN_ARC, 1));
  const untracked = clone(tracked); delete untracked.currentSceneId; delete untracked.sceneAdvances;
  check('currentSceneId / sceneAdvances are stripped from STATE_JSON (tracked == untracked prompt)', promptFor(tracked, JOAN_ARC) === promptFor(untracked, JOAN_ARC));
  const pr = promptFor(tracked, JOAN_ARC);
  // Scene-only content: ids and bridges. (Date labels are not checked here — Joan's beat
  // descriptions start with the same dates, so the roster carries them; the exact check below
  // proves nothing but the roster was added.)
  const leaks = [...SEQ, ...arcScenes(JOAN_ARC).map(s => s.bridge).filter(Boolean).map(b => b.slice(0, 40))]
    .filter(x => pr.includes(x));
  check('no scene id or bridge appears anywhere in the prompt', leaks.length === 0, leaks.slice(0, 3).join(' | '));
  check('the Part A beat roster IS in the prompt (the model needs it to report beats)', pr.includes('⚑ STORY POSITION') && pr.includes('] 24_feb_1431 — '));
  check('...with no PACING nudge (that stays fork-bound)', !pr.includes('⚑ PACING'));
  const d = buildStoryPositionDirective(tracked, joanScenario, JOAN_ARC);
  const withoutRoster = pr.includes('\n\n' + d) ? pr.replace('\n\n' + d, '') : pr.replace(d, '');
  check('removing the roster leaves exactly the no-arc prompt (scenes add the roster and nothing else)', withoutRoster === promptFor(untracked, null));
}

head('5. DIAG — the scene segment and the summary');
{
  const st0 = startState();
  const n0  = clone(st0);
  quiet(() => recordReachedBeats(n0, { stateChanges: { beats_reached: ['21_feb_1431'] } }, JOAN_ARC));
  const mv0 = quiet(() => advanceScene(n0, JOAN_ARC, 0));
  const line0 = forkDiagTurnLine({ turn: 0, opening: true, state: st0, nextState: n0, scenario: joanScenario, storyArc: JOAN_ARC, output: { stateChanges: { beats_reached: ['21_feb_1431'] } }, newBeats: ['21_feb_1431'], sceneMoves: mv0 });
  check('opening line shows the crossing', line0.includes('scene: scene_21_feb → scene_24_feb (advanced on beat 21_feb_1431)'), line0);
  check('Manchon (no fork) is described as having none, not as an unmet binding', line0.includes('fork: none (this role has no fork)'));
  const held = forkDiagTurnLine({ turn: 1, state: n0, nextState: clone(n0), scenario: joanScenario, storyArc: JOAN_ARC, output: { stateChanges: {} }, newBeats: [], sceneMoves: [] });
  check('a turn with no crossing says held', held.includes('scene: scene_24_feb (held)'), held);
  const n2 = clone(n0);
  quiet(() => recordReachedBeats(n2, { stateChanges: { beats_reached: ['17_mar_1431', '9_may_1431'] } }, JOAN_ARC));
  const mv2 = quiet(() => advanceScene(n2, JOAN_ARC, 2));
  const multi = forkDiagTurnLine({ turn: 2, state: n0, nextState: n2, scenario: joanScenario, storyArc: JOAN_ARC, output: { stateChanges: { beats_reached: ['17_mar_1431', '9_may_1431'] } }, newBeats: ['17_mar_1431', '9_may_1431'], sceneMoves: mv2 });
  check('a multi-hop turn shows the whole path and its beats', multi.includes('scene: scene_24_feb → scene_17_mar → scene_9_may → scene_23_may (advanced on beats 24_feb_1431, 17_mar_1431, 9_may_1431)'), multi);
  const joanRole = JOAN_ROLES.find(r => r.id === 'role_joan');
  const js = quiet(() => buildInitialState(joanScenario, joanRole, JOAN_LOCS)); initSceneState(js, JOAN_ARC);
  const jl = forkDiagTurnLine({ turn: 1, state: js, nextState: clone(js), scenario: joanScenario, storyArc: JOAN_ARC, output: {}, newBeats: [] });
  check('Joan (clock fork 0.75) is described by her clock, not a fallback', /fork: waiting \(clock: 0\.75 = [\d.]+ of [\d.]+ min\)/.test(jl), jl);

  const transcript = ['intro', '', line0, '', 'narrative', '', held, '', multi, '', '---'].join('\n');
  const parsed = parseSceneDiag(transcript);
  check('parseSceneDiag reads crossings back from the lines', parsed.moves.length === 2 && parsed.last === 'scene_23_may');
  const sum = forkDiagSummaryLines({ transcript, sessionState: n2, scenario: joanScenario, storyArc: JOAN_ARC });
  check('summary lists every crossing with its turn', sum.some(l => l === `${DIAG_PREFIX}scene advances (4): turn 0 scene_21_feb → scene_24_feb (on 21_feb_1431); turn 2 scene_24_feb → scene_17_mar → scene_9_may → scene_23_may (on 24_feb_1431, 17_mar_1431, 9_may_1431)`), sum.find(l => l.includes('scene advances')));
  check('summary names the scene at close', sum.includes(`${DIAG_PREFIX}scene at close: scene_23_may`));

  // A bound-fork session with no scenes: its line is exactly the Part A line.
  const WG  = await repos.scenarios.findById('watergate_1972_part1_breach');
  const WGA = repos.storyArcs.findById(WG.storyArcIds[0]);
  const mcc = repos.scenarios.findPlayerRoles(WG.id).find(r => r.id === 'role_mccord');
  const ws  = quiet(() => buildInitialState(WG, mcc, repos.locations.findByScenario(WG.id)));
  const wn  = clone(ws); quiet(() => recordReachedBeats(wn, { stateChanges: { beats_reached: ['wills_completes_his'] } }, WGA));
  const args = { turn: 1, state: ws, nextState: wn, scenario: WG, storyArc: WGA, output: { stateChanges: { beats_reached: ['wills_completes_his'] } }, newBeats: ['wills_completes_his'] };
  const a = forkDiagTurnLine(args), b = forkDiagTurnLine({ ...args, sceneMoves: [] });
  check('McCord (bound, no scenes): no scene segment, and the line is unchanged by the new parameter', a === b && !a.includes('scene:') && a.includes('fork: waiting (binding unmet'), a);
  const wsum = forkDiagSummaryLines({ transcript: `x\n${a}\n`, sessionState: wn, scenario: WG, storyArc: WGA });
  check('McCord summary has no scene lines', !wsum.some(l => l.includes('scene')));
}

// ═══ PART 2 — the real router, scripted model ════════════════════════════════
head('6. e2e — Joan through the real /start + /turn');
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
let nextOutput = null;
const sent = [];   // every system+messages text the router sent to the model
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
  sent.push(JSON.stringify(body.system ?? '') + '\n' + JSON.stringify(body.messages ?? ''));
  const text = JSON.stringify(nextOutput);
  return body.stream ? sseStream(text) : new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/game/api', createGameRouter(repos, { anthropicApiKey: 'scene-tracking-test-key' }));
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const snapshot = dir => { try { return new Set(fs.readdirSync(p(dir))); } catch { return new Set(); } };
const beforeSessions = snapshot('engine/data/sessions'), beforeTranscripts = snapshot('engine/data/transcripts');

const sse = async (route, body) => {
  const resp = await realFetch(`${BASE}/game/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const raw  = await resp.text();
  const evs  = raw.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  return { status: resp.status, done: evs.find(e => e.type === 'done'), error: evs.find(e => e.type === 'error') };
};
const out = (beats, loc = 'great_hall_rouen_castle') => ({
  narrative: 'The assessors murmur; the scribes dip their pens.', choices: ['Answer carefully', 'Say nothing', 'Ask for counsel'],
  location: loc, timeAdvance: 2, stateChanges: beats === undefined ? {} : { beats_reached: beats },
});
const TURNS = [
  { beats: [],                             want: 'scene_24_feb', move: null },
  { beats: ['24_feb_1431'],                want: 'scene_17_mar', move: 'scene_24_feb → scene_17_mar (advanced on beat 24_feb_1431)' },
  { beats: ['17_mar_1431', '9_may_1431'],  want: 'scene_23_may', move: 'scene_17_mar → scene_9_may → scene_23_may (advanced on beats 17_mar_1431, 9_may_1431)' },
  { beats: ['24_may_1431'],                want: 'scene_28_may', move: 'scene_23_may → scene_24_may → scene_28_may (advanced on beats 23_may_1431, 24_may_1431)' },
  { beats: ['28_may_1431'],                want: 'scene_28_may', move: null },
];
let joanSession = null;
try {
  nextOutput = out(['21_feb_1431']);
  const st = await sse('start', { scenarioId: JOAN_ID, roleId: 'role_manchon', narrativeStyle: 'focused' });
  check('/start (Joan, Manchon) completes', !!st.done, st.error ? JSON.stringify(st.error).slice(0, 200) : String(st.status));
  let state = st.done?.nextState; joanSession = st.done?.sessionId;
  check('opening: started in scene_21_feb, crossed to scene_24_feb on 21_feb_1431', state?.currentSceneId === 'scene_24_feb' && state?.sceneAdvances?.[0]?.from === 'scene_21_feb', state?.currentSceneId);
  const visible = JSON.stringify(st.done?.output || {});
  check('what the player is sent (output) carries no scene data', !SEQ.some(id => visible.includes(id)));
  for (const [i, t] of TURNS.entries()) {
    nextOutput = out(t.beats);
    const r = await sse('turn', { state, playerInput: `I answer (${i + 1}).`, sessionId: joanSession });
    if (!r.done) { check(`turn ${i + 1} completes`, false, r.error ? JSON.stringify(r.error).slice(0, 200) : String(r.status)); break; }
    state = r.done.nextState;
    check(`turn ${i + 1}: beats ${JSON.stringify(t.beats)} → currentSceneId ${t.want}`, state.currentSceneId === t.want, state.currentSceneId);
  }
  const transcript = fs.readFileSync(p('engine/data/transcripts', `${joanSession}.md`), 'utf8');
  const diag = transcript.split('\n').filter(l => l.startsWith(DIAG_PREFIX));
  check(`transcript carries a DIAG line per turn (opening + ${TURNS.length})`, diag.length === TURNS.length + 1, `${diag.length} lines`);
  check('opening DIAG: the crossing out of the opening scene', diag[0]?.includes('scene: scene_21_feb → scene_24_feb (advanced on beat 21_feb_1431)'), diag[0]);
  TURNS.forEach((t, i) => {
    const l = diag[i + 1] || '';
    check(`turn ${i + 1} DIAG: ${t.move ? 'crossing recorded' : 'held'}`, t.move ? l.includes(`scene: ${t.move}`) : l.includes(`scene: ${t.want} (held)`), l.slice(0, 220));
  });
  const leak = sent.find(s => SEQ.some(id => s.includes(id)) || arcScenes(JOAN_ARC).some(sc => sc.bridge && s.includes(sc.bridge.slice(0, 40))));
  check(`none of the ${sent.length} model requests carries a scene id or bridge`, sent.length > 0 && !leak);
  check('...and the requests DO carry the beat roster', sent.some(s => s.includes('STORY POSITION')));

  // Control: a scenario with no scenes — no scene state, no DIAG, no roster.
  const CH = 'chicago_1893_v1';
  const chRole = repos.scenarios.findPlayerRoles(CH).find(r => r.id === 'daniel_burnham');
  if (chRole) {
    sent.length = 0;
    nextOutput = { ...out(['not_a_beat'], 'administration_building') };
    const cs = await sse('start', { scenarioId: CH, roleId: chRole.id, narrativeStyle: 'focused' });
    const cstate = cs.done?.nextState;
    check('control (Chicago, no scenes): /start completes with no scene state', !!cs.done && !('currentSceneId' in (cstate || {})) && !('sceneAdvances' in (cstate || {})));
    const ct = await sse('turn', { state: cstate, playerInput: 'I look around.', sessionId: cs.done?.sessionId });
    check('control: /turn adds no scene state', !!ct.done && !('currentSceneId' in ct.done.nextState) && !('reachedBeats' in ct.done.nextState));
    const ctr = fs.readFileSync(p('engine/data/transcripts', `${cs.done.sessionId}.md`), 'utf8');
    check('control: transcript has no DIAG line', !ctr.includes(DIAG_PREFIX));
    check('control: no model request carries a beat roster', !sent.some(s => s.includes('STORY POSITION')));
  } else console.log('      (control skipped — daniel_burnham not available)');
} finally {
  server.close();
  globalThis.fetch = realFetch;
  for (const [dir, before] of [['engine/data/sessions', beforeSessions], ['engine/data/transcripts', beforeTranscripts]]) {
    for (const f of snapshot(dir)) if (!before.has(f)) { try { fs.rmSync(p(dir, f), { force: true }); } catch {} }
  }
  const left = [...snapshot('engine/data/sessions')].filter(f => !beforeSessions.has(f)).length + [...snapshot('engine/data/transcripts')].filter(f => !beforeTranscripts.has(f)).length;
  check('sessions and transcripts created by this test are removed', left === 0, `${left} left`);
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll scene-tracking assertions passed.');
process.exit(fails ? 1 : 0);
