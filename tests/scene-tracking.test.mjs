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
  check('the advance log records from / to / beat / turn / via', st.sceneAdvances.length === 6 && st.sceneAdvances[0].from === 'scene_21_feb' && st.sceneAdvances[0].to === 'scene_24_feb' && st.sceneAdvances[0].beat === '21_feb_1431' && st.sceneAdvances[0].turn === 2 && st.sceneAdvances.every(m => m.via === 'beat'));
  check('last scene: its beat reached → stays (no next scene)', report(st, ['28_may_1431'], 9).length === 0 && st.currentSceneId === 'scene_28_may');
}

head('2b. B3d — a scene ends only on its OWN beat, one step a turn');
{
  // the_voices_are sits after 24_feb_1431 in arc order. Under the old furthest-reached rule,
  // reporting it alone carried the scene past both Act 1 scenes and into the cell.
  const s = startState();
  check('the_voices_are reported in scene_21_feb: recorded, but no scene is skipped', report(s, ['the_voices_are'], 1).length === 0 && s.currentSceneId === 'scene_21_feb' && s.reachedBeats.includes('the_voices_are'));
  const s2 = startState(); report(s2, ['21_feb_1431'], 1);
  check('...and in scene_24_feb: recorded, scene_24_feb holds (it ends on 24_feb_1431)', report(s2, ['the_voices_are'], 2).length === 0 && s2.currentSceneId === 'scene_24_feb');
  report(s2, ['24_feb_1431'], 3);
  check('24_feb_1431 then advances to scene_17_mar', s2.currentSceneId === 'scene_17_mar');
  check('...where a LATER the_voices_are report does not skip further', report(s2, [], 4).length === 0 && s2.currentSceneId === 'scene_17_mar');
  const s3 = startState();
  check('a later scene\'s ending beat (17_mar_1431) reported first: recorded, no scene skipped', report(s3, ['17_mar_1431'], 1).length === 0 && s3.currentSceneId === 'scene_21_feb' && s3.reachedBeats.includes('17_mar_1431'));
  const walk = [];
  for (const [t, b] of [[2, ['21_feb_1431']], [3, ['24_feb_1431']], [4, []]]) { report(s3, b, t); walk.push(s3.currentSceneId); }
  check('...the scenes then advance one at a time; the early-reported scene_17_mar advances on its first turn', walk.join(',') === 'scene_24_feb,scene_17_mar,scene_9_may', walk.join(' → '));
  const s4 = startState(); report(s4, ['21_feb_1431'], 1); report(s4, ['24_feb_1431'], 2);
  const m = report(s4, ['17_mar_1431', '9_may_1431'], 3);
  check('two ending beats in one turn: ONE step (scene_17_mar → scene_9_may)', m.length === 1 && s4.currentSceneId === 'scene_9_may');
  check('...and the next turn takes the second (scene_9_may → scene_23_may)', report(s4, [], 4).length === 1 && s4.currentSceneId === 'scene_23_may');
  const s5 = startState();
  report(s5, ['9_may_1431', '21_feb_1431'], 1);
  check('out-of-order reports in one turn: only the current scene\'s own beat moves it', s5.currentSceneId === 'scene_24_feb');
  check('every scene move stamps sceneEnteredAt with the clock', (() => { const x = startState(); x.elapsedMinutes = 6; report(x, ['21_feb_1431'], 3); return x.sceneEnteredAt === 6; })());
  check('initSceneState starts the scene clock at the session clock', startState().sceneEnteredAt === 0);
}

head('2c. B3d — the fork path: the only one that jumps');
{
  const s = startState(); s.elapsedMinutes = 20;
  const m = quiet(() => advanceScene(s, JOAN_ARC, 9, { forkSceneId: 'scene_28_may' }));
  check('fork put this turn, bound to scene_28_may, from scene_21_feb: jumps straight there', m.length === 1 && m[0].via === 'fork' && m[0].to === 'scene_28_may' && s.currentSceneId === 'scene_28_may' && s.sceneEnteredAt === 20, JSON.stringify(m));
  const back = startState(); report(back, ['21_feb_1431'], 1); report(back, ['24_feb_1431'], 2);
  check('a fork scene BEHIND the current one never moves it back', quiet(() => advanceScene(back, JOAN_ARC, 3, { forkSceneId: 'scene_21_feb' })).length === 0 && back.currentSceneId === 'scene_17_mar');
  const same = startState(); quiet(() => recordReachedBeats(same, { stateChanges: { beats_reached: ['21_feb_1431'] } }, JOAN_ARC));
  const ms = quiet(() => advanceScene(same, JOAN_ARC, 1, { forkSceneId: 'scene_21_feb' }));
  check('a fork scene equal to the current one falls through to the beat path', ms.length === 1 && ms[0].via === 'beat' && same.currentSceneId === 'scene_24_feb');
  const bad = startState();
  check('a fork scene the arc does not have is ignored', quiet(() => advanceScene(bad, JOAN_ARC, 1, { forkSceneId: 'scene_nowhere' })).length === 0 && bad.currentSceneId === 'scene_21_feb');
}
{
  const arc = clone(JOAN_ARC);
  delete arc.acts[0].scenes[1].ends_on_beat;   // scene_24_feb becomes budget-only
  const st = quiet(() => buildInitialState(joanScenario, JOAN_ROLES[0], JOAN_LOCS)); initSceneState(st, arc);
  quiet(() => recordReachedBeats(st, { stateChanges: { beats_reached: ['21_feb_1431', '9_may_1431'] } }, arc));
  quiet(() => advanceScene(st, arc, 1)); quiet(() => advanceScene(st, arc, 2));
  check('a budget-only scene (no ends_on_beat) holds — B3b adds budgets', st.currentSceneId === 'scene_24_feb');
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
  const untracked = clone(tracked); delete untracked.currentSceneId; delete untracked.sceneAdvances; delete untracked.sceneEnteredAt;
  check('currentSceneId / sceneAdvances / sceneEnteredAt are stripped from STATE_JSON (tracked == untracked prompt)', promptFor(tracked, JOAN_ARC) === promptFor(untracked, JOAN_ARC));
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
  quiet(() => recordReachedBeats(n2, { stateChanges: { beats_reached: ['24_feb_1431', 'the_voices_are', '9_may_1431'] } }, JOAN_ARC));
  const mv2 = quiet(() => advanceScene(n2, JOAN_ARC, 2));
  const multi = forkDiagTurnLine({ turn: 2, state: n0, nextState: n2, scenario: joanScenario, storyArc: JOAN_ARC, output: { stateChanges: { beats_reached: ['24_feb_1431', 'the_voices_are', '9_may_1431'] } }, newBeats: ['24_feb_1431', 'the_voices_are', '9_may_1431'], sceneMoves: mv2 });
  check('a turn with ahead-of-sequence beats: one step on its own beat', multi.includes('scene: scene_24_feb → scene_17_mar (advanced on beat 24_feb_1431)'), multi);
  // the_voices_are sits BEFORE 17_mar_1431, so from scene_17_mar it is a late report, not ahead.
  check('...and the DIAG names the beat AHEAD of the new scene\'s ending (not the late one)', multi.includes('ahead: [9_may_1431] recorded, ended no scene (scene_17_mar ends on 17_mar_1431)'), multi);
  const heldAhead = forkDiagTurnLine({ turn: 1, state: n0, nextState: (() => { const x = clone(n0); quiet(() => recordReachedBeats(x, { stateChanges: { beats_reached: ['the_voices_are'] } }, JOAN_ARC)); return x; })(), scenario: joanScenario, storyArc: JOAN_ARC, output: { stateChanges: { beats_reached: ['the_voices_are'] } }, newBeats: ['the_voices_are'], sceneMoves: [] });
  check('an ahead beat on a held turn: "held" plus the ahead segment', heldAhead.includes('scene: scene_24_feb (held) · ahead: [the_voices_are] recorded, ended no scene (scene_24_feb ends on 24_feb_1431)'), heldAhead);
  check('no ahead segment when the turn recorded nothing ahead', !held.includes('ahead:') && !line0.includes('ahead:'));
  const nf = clone(n2); nf.elapsedMinutes = 22;
  const mvf = quiet(() => advanceScene(nf, JOAN_ARC, 3, { forkSceneId: 'scene_28_may' }));
  const forkLine = forkDiagTurnLine({ turn: 3, state: n2, nextState: nf, scenario: joanScenario, storyArc: JOAN_ARC, output: {}, newBeats: [], sceneMoves: mvf });
  check('a fork jump says so', forkLine.includes('scene: scene_17_mar → scene_28_may (jumped by fork)'), forkLine);
  const joanRole = JOAN_ROLES.find(r => r.id === 'role_joan');
  const js = quiet(() => buildInitialState(joanScenario, joanRole, JOAN_LOCS)); initSceneState(js, JOAN_ARC);
  const jl = forkDiagTurnLine({ turn: 1, state: js, nextState: clone(js), scenario: joanScenario, storyArc: JOAN_ARC, output: {}, newBeats: [] });
  check('Joan (clock fork 0.75) is described by her clock, not a fallback', /fork: waiting \(clock: 0\.75 = [\d.]+ of [\d.]+ min\)/.test(jl), jl);

  const transcript = ['intro', '', line0, '', 'narrative', '', held, '', multi, '', forkLine, '', '---'].join('\n');
  const parsed = parseSceneDiag(transcript);
  check('parseSceneDiag reads crossings back from the lines (beat and fork)', parsed.moves.length === 3 && parsed.moves[2].via === 'fork' && parsed.last === 'scene_28_may', JSON.stringify(parsed.moves));
  const sum = forkDiagSummaryLines({ transcript, sessionState: nf, scenario: joanScenario, storyArc: JOAN_ARC });
  check('summary lists every crossing with its turn', sum.some(l => l === `${DIAG_PREFIX}scene advances (3): turn 0 scene_21_feb → scene_24_feb (on 21_feb_1431); turn 2 scene_24_feb → scene_17_mar (on 24_feb_1431); turn 3 scene_17_mar → scene_28_may (by fork)`), sum.find(l => l.includes('scene advances')));
  check('summary names the scene at close', sum.includes(`${DIAG_PREFIX}scene at close: scene_28_may`));
  const old = '> ⚑ DIAG turn 2 · 0→0 min · beats_reached: [] · new: [] · position: no beat → no beat · scene: scene_24_feb → scene_17_mar → scene_9_may (advanced on beats 24_feb_1431, 17_mar_1431) · fork: none';
  check('a pre-B3d multi-hop line still parses', parseSceneDiag(old).moves[0]?.path.length === 3);

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
  { beats: ['the_voices_are'],             want: 'scene_17_mar', move: null },
  { beats: ['17_mar_1431', '9_may_1431'],  want: 'scene_9_may',  move: 'scene_17_mar → scene_9_may (advanced on beat 17_mar_1431)' },
  { beats: [],                             want: 'scene_23_may', move: 'scene_9_may → scene_23_may (advanced on beat 9_may_1431)' },
  { beats: ['24_may_1431'],                want: 'scene_23_may', move: null },
  { beats: ['23_may_1431'],                want: 'scene_24_may', move: 'scene_23_may → scene_24_may (advanced on beat 23_may_1431)' },
  { beats: [],                             want: 'scene_28_may', move: 'scene_24_may → scene_28_may (advanced on beat 24_may_1431)' },
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
  check('e2e: the_voices_are reported late in scene_17_mar: recorded, held, not flagged ahead', (diag[3] || '').includes('new: [the_voices_are]') && (diag[3] || '').includes('scene: scene_17_mar (held) · fork:'), diag[3]);
  check('e2e: 24_may_1431 reported in scene_23_may is logged as ahead, not a skip', (diag[6] || '').includes('scene: scene_23_may (held) · ahead: [24_may_1431]'), diag[6]);
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
