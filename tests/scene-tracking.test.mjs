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
const { buildInitialState, loadStoryArc, loadForkStoryArc, initSceneState, advanceScene, recordReachedBeats, holdSceneLocation } =
  await import(`${ROOT}/engine/services/StateManager.js`);
const { composeTurnPrompt, arcScenes, arcHasScenes, buildStoryPositionDirective, isStoryBoundFork, scenePacingStatus, storyPacingNudge, sceneFramingDirective, sceneFraming } =
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
// The minimum scene time (B2b-MODEL): a beat ends its scene only within half a turn of the
// scene's budget. spend() puts the clock there (budget − 1 min; no scenario → 3-minute turns),
// so these B3d checks still test WHICH beat ends a scene, not when. Not spent: no budget advance.
const spend  = st => { const sc = arcScenes(JOAN_ARC).find(x => x.id === st.currentSceneId); if (sc?.budget_minutes) st.elapsedMinutes = (st.sceneEnteredAt ?? 0) + sc.budget_minutes - 1; return st; };
const report = (st, beats, turn) => { quiet(() => recordReachedBeats(st, { stateChanges: { beats_reached: beats } }, JOAN_ARC)); spend(st); return quiet(() => advanceScene(st, JOAN_ARC, turn)); };
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
  check('every scene move stamps sceneEnteredAt with the clock', (() => { const x = startState(); report(x, ['21_feb_1431'], 3); return x.currentSceneId === 'scene_24_feb' && x.sceneEnteredAt === x.elapsedMinutes && x.elapsedMinutes > 0; })());
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
  spend(same);
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
  st.elapsedMinutes = 2; quiet(() => advanceScene(st, arc, 1)); quiet(() => advanceScene(st, arc, 2));
  check('a budget-only scene (no ends_on_beat) holds — B3b adds budgets', st.currentSceneId === 'scene_24_feb');
  const lost = { ...startState(), currentSceneId: 'scene_deleted' };
  check('a current scene no longer in the arc holds, with a warning', quiet(() => advanceScene(lost, JOAN_ARC, 1)).length === 0 && lost.currentSceneId === 'scene_deleted');
}

head('2d. B3b — per-scene budget: the nudge threshold');
{
  // Joan: 2 minutes a turn. scene_21_feb budget 3, scene_17_mar budget 4, scene_28_may budget 5.
  check('fixture: Joan plays 2-minute turns', joanScenario.systems?.timePerTurnDefault === 2);
  const at = (scene, entered, now, beats = []) => { const s = startState(); s.currentSceneId = scene; s.sceneEnteredAt = entered; s.elapsedMinutes = now; s.reachedBeats = beats; return scenePacingStatus(s, joanScenario, JOAN_ARC); };
  check('3-min scene, first turn (0 in): no nudge', at('scene_21_feb', 0, 0).nudge === false);
  check('3-min scene, second turn (2 in, 1 left ≤ 1 turn): nudged toward 21_feb_1431', (p => p.nudge && p.target.id === '21_feb_1431')(at('scene_21_feb', 0, 2)));
  check('4-min scene, first turn: no nudge', at('scene_17_mar', 8, 8).nudge === false);
  check('4-min scene, second turn (2 left = 1 turn): nudged', at('scene_17_mar', 8, 10).nudge === true);
  check('5-min scene: not at 2 in (3 left), nudged at 4 in (1 left)', at('scene_28_may', 20, 22).nudge === false && at('scene_28_may', 20, 24).nudge === true);
  check('own beat already reported → never nudged', at('scene_21_feb', 0, 2, ['21_feb_1431']).nudge === false);
  check('the nudge lists the unreached beats before the target, in order', JSON.stringify(at('scene_17_mar', 8, 10, ['21_feb_1431', '24_feb_1431']).between.map(b => b.id)) === JSON.stringify(['the_voices_are', '13_mar_1431']));
  check('a scene session predating sceneEnteredAt reads 0 minutes in (no nudge, no backstop)', (() => { const s = startState(); delete s.sceneEnteredAt; s.elapsedMinutes = 14; const p = scenePacingStatus(s, joanScenario, JOAN_ARC); return p.inScene === 0 && !p.nudge && !p.exhausted; })());
  check('a session without scenes has no scene pacing', scenePacingStatus({ elapsedMinutes: 20 }, joanScenario, JOAN_ARC) === null);

  const promptAt = (now, beats = []) => { const s = startState(); s.currentSceneId = 'scene_17_mar'; s.sceneEnteredAt = 8; s.elapsedMinutes = now; s.remainingMinutes = 30 - now; s.reachedBeats = beats; return composeTurnPrompt(s, 'I wait.', { scenario: joanScenario, characters: [], locations: JOAN_LOCS, clues: [], storyArc: JOAN_ARC }); };
  const nudged = promptAt(10, ['21_feb_1431', '24_feb_1431']);
  check('the nudged turn\'s prompt carries ⚑ SCENE PACING toward the scene\'s own beat', nudged.includes('⚑ SCENE PACING') && nudged.includes('beat 17_mar_1431 — move toward it') && nudged.includes('Move through the_voices_are, 13_mar_1431, in that order, and reach 17_mar_1431'));
  check('...the un-nudged turn\'s prompt does not', !promptAt(8, ['21_feb_1431', '24_feb_1431']).includes('SCENE PACING'));
  check('...and the nudge names no scene id or bridge (scenes stay invisible until B2b)', !SEQ.some(id => nudged.includes(id)) && !arcScenes(JOAN_ARC).some(sc => sc.bridge && nudged.includes(sc.bridge.slice(0, 40))));
  // Part A's fork nudge is suppressed in a scene session: two nudges, two beats.
  // (A bound fork in a scene session is B3c; the guard is the first line of storyPacingNudge.)
  const bound = startState(); bound.elapsedMinutes = 24;
  check('Part A fork nudge is off for a scene session (the scene budgets pace it)', storyPacingNudge(bound, joanScenario, JOAN_ARC) === null);
}

head('2e. B3b — the hard-advance backstop');
{
  const st = (scene, entered, now, beats = []) => { const s = startState(); s.currentSceneId = scene; s.sceneEnteredAt = entered; s.elapsedMinutes = now; s.reachedBeats = beats; return s; };
  const a = st('scene_24_feb', 4, 6);
  check('budget not yet spent (2/3 min) → holds', quiet(() => advanceScene(a, JOAN_ARC, 3)).length === 0 && a.currentSceneId === 'scene_24_feb');
  const b = st('scene_24_feb', 4, 8);
  const mb = quiet(() => advanceScene(b, JOAN_ARC, 4));
  check('budget spent (4/3 min), beat unreported → ONE step, via budget', mb.length === 1 && mb[0].via === 'budget' && b.currentSceneId === 'scene_17_mar' && mb[0].minutes === 4 && mb[0].budget === 3 && mb[0].missed === '24_feb_1431', JSON.stringify(mb));
  check('...the missed beat is NOT marked reached', !(b.reachedBeats || []).includes('24_feb_1431'));
  check('...and the new scene\'s clock starts now', b.sceneEnteredAt === 8);
  const c = st('scene_24_feb', 4, 8, ['24_feb_1431']);
  check('budget spent but the beat WAS reported → via beat (the beat wins)', quiet(() => advanceScene(c, JOAN_ARC, 4))[0]?.via === 'beat');
  const d = st('scene_28_may', 20, 40);
  check('the last scene never advances, however long it runs', quiet(() => advanceScene(d, JOAN_ARC, 9)).length === 0 && d.currentSceneId === 'scene_28_may');
  const e = st('scene_21_feb', 0, 12); delete e.sceneEnteredAt;
  check('a session predating sceneEnteredAt: stamped now, no instant backstop', quiet(() => advanceScene(e, JOAN_ARC, 5)).length === 0 && e.sceneEnteredAt === 12);
  const arc = clone(JOAN_ARC); delete arc.acts[0].scenes[1].ends_on_beat;
  const f = st('scene_24_feb', 4, 8);
  check('a scene with no ends_on_beat: never nudged, advances on its budget', !scenePacingStatus(f, joanScenario, arc).nudge && quiet(() => advanceScene(f, arc, 4))[0]?.via === 'budget');
  const g = st('scene_23_may', 16, 30);
  check('a budget overrun of several turns still moves ONE scene', quiet(() => advanceScene(g, JOAN_ARC, 9)).length === 1 && g.currentSceneId === 'scene_24_may');

  // DIAG
  const s0 = st('scene_24_feb', 4, 6), n0 = clone(s0); n0.elapsedMinutes = 8;
  const mv = quiet(() => advanceScene(n0, JOAN_ARC, 4));
  const line = forkDiagTurnLine({ turn: 4, state: s0, nextState: n0, scenario: joanScenario, storyArc: JOAN_ARC, output: {}, newBeats: [], sceneMoves: mv });
  check('DIAG: a budget advance says so, with the minutes and the missed beat', line.includes('scene: scene_24_feb → scene_17_mar (advanced on budget 4/3 min, 24_feb_1431 not reached)'), line);
  check('DIAG: the budget of the scene the turn was played in', line.includes('budget: 4/3 min'), line);
  check('DIAG: the turn\'s prompt was nudged (state at turn start: 2 in, 1 left)', line.includes('scene pacing: nudged toward 24_feb_1431'), line);
  const s1 = st('scene_24_feb', 4, 4), n1 = clone(s1); n1.elapsedMinutes = 6;
  const l1 = forkDiagTurnLine({ turn: 3, state: s1, nextState: n1, scenario: joanScenario, storyArc: JOAN_ARC, output: {}, newBeats: [], sceneMoves: [] });
  check('DIAG: an un-nudged held turn shows its budget and no nudge', l1.includes('scene: scene_24_feb (held) · budget: 2/3 min · fork:') && !l1.includes('scene pacing'), l1);
  const parsed = parseSceneDiag(line);
  check('parseSceneDiag reads a budget move back', parsed.moves[0]?.via === 'budget' && parsed.moves[0]?.budget === '4/3 min, 24_feb_1431 not reached', JSON.stringify(parsed.moves));
  const sum = forkDiagSummaryLines({ transcript: `${line}\n`, sessionState: n0, scenario: joanScenario, storyArc: JOAN_ARC });
  check('summary: the budget move, and the count by kind', sum.includes(`${DIAG_PREFIX}scene advances by: 0 beat, 1 budget, 0 fork`) && sum.some(l => l.includes('turn 4 scene_24_feb → scene_17_mar (on budget 4/3 min, 24_feb_1431 not reached)')), sum.filter(l => l.includes('scene')).join(' | '));
}

head('2f. B2b-MODEL — the model is told the scene; the engine holds its place');
{
  const L = JOAN_LOCS;
  const st = (scene, turnCount, extra = {}) => { const s = startState(); Object.assign(s, { currentSceneId: scene, turnCount }, extra); return s; };
  // An advance at the end of turn 3 stamps sceneEnteredTurn 3 — the count turn 4 starts from.
  const s = startState(); s.turnCount = 3; s.elapsedMinutes = 6; s.currentSceneId = 'scene_24_feb';
  quiet(() => recordReachedBeats(s, { stateChanges: { beats_reached: ['24_feb_1431'] } }, JOAN_ARC)); quiet(() => advanceScene(s, JOAN_ARC, 3));
  check('an advance stamps sceneEnteredTurn with the count the next turn starts from', s.currentSceneId === 'scene_17_mar' && s.sceneEnteredTurn === 3);
  const first = sceneFramingDirective(s, joanScenario, JOAN_ARC, L);
  const bridge17 = arcScenes(JOAN_ARC).find(x => x.id === 'scene_17_mar').bridge;
  check('the new scene\'s FIRST turn: SCENE CHANGE, the date and place, and its bridge', first.startsWith('⚑ SCENE CHANGE: Since the last turn the story has moved on — it is now 17 March 1431 — Joan\'s Cell') && first.includes(bridge17) && first.includes('⚑ SCENE: 17 March 1431'), first.slice(0, 160));
  const later = sceneFramingDirective({ ...s, turnCount: 4 }, joanScenario, JOAN_ARC, L);
  check('the scene\'s next turn: framing only — no change line, no bridge', later.startsWith('⚑ SCENE: 17 March 1431') && !later.includes('SCENE CHANGE') && !later.includes(bridge17));
  check('a time-only change (scene_24_feb, same hall) still announces the new date', sceneFramingDirective(st('scene_24_feb', 2, { sceneEnteredTurn: 2 }), joanScenario, JOAN_ARC, L).includes('it is now 24 February 1431 — Great Hall'));
  check('no framing names a scene id', !SEQ.some(id => first.includes(id) || later.includes(id)));

  // The fork turn: the setup IS the transition. Joan bound at_scene scene_28_may, entering it on
  // its predecessor's budget: the fork is due on the scene's first turn — no bridge.
  const joan = JOAN_ROLES.find(r => r.id === 'role_joan');
  const bound = { ...clone(joan.defining_moment), at_scene: 'scene_28_may' };
  const ft = st('scene_28_may', 11, { sceneEnteredTurn: 11, elapsedMinutes: 24, effectiveDefiningMoment: bound, playerRoleId: 'role_joan' });
  const fFork = sceneFraming(ft, joanScenario, JOAN_ARC, L);
  const dFork = sceneFramingDirective(ft, joanScenario, JOAN_ARC, L);
  const bridge28 = arcScenes(JOAN_ARC).find(x => x.id === 'scene_28_may').bridge;
  check('fork due on the scene\'s first turn: change announced, NO bridge — the setup is the transition', fFork.forkNow && fFork.transition === '' && dFork.includes('SCENE CHANGE') && dFork.includes('The defining moment below is the transition') && !dFork.includes(bridge28.slice(0, 40)));
  const fj = st('scene_28_may', 9, { sceneEnteredTurn: 9, elapsedMinutes: 16, effectiveDefiningMoment: bound, definingMomentPresented: true,
    sceneAdvances: [{ from: 'scene_23_may', to: 'scene_28_may', beat: null, turn: 9, via: 'fork' }] });
  const dJump = sceneFramingDirective(fj, joanScenario, JOAN_ARC, L);
  check('scene reached by the fork\'s jump: framing only — no change line, no bridge (the fork already moved the story)', dJump.startsWith('⚑ SCENE: 28 May 1431') && !dJump.includes('SCENE CHANGE') && !dJump.includes(bridge28.slice(0, 40)));

  // The location hold.
  const h = st('scene_17_mar', 4, { location: 'great_hall_rouen_castle' });
  const hold = holdSceneLocation(h, JOAN_ARC);
  check('the engine holds the scene\'s place over the model\'s choice', hold.model === 'great_hall_rouen_castle' && hold.held === 'joan_prison_cell' && h.location === 'joan_prison_cell' && h.visitedLocations.includes('joan_prison_cell'));
  const same = st('scene_17_mar', 4, { location: 'joan_prison_cell' });
  check('...and leaves it alone when the model already had it', JSON.stringify(holdSceneLocation(same, JOAN_ARC)) === JSON.stringify({ model: 'joan_prison_cell', held: 'joan_prison_cell' }));
  const arcRL = clone(JOAN_ARC); arcRL.acts[1].scenes[0].role_locations = { role_manchon: 'great_hall_rouen_castle' };
  const rl = st('scene_17_mar', 4, { location: 'joan_prison_cell' });
  check('role_locations: a role with its own place for the scene is held there', holdSceneLocation(rl, arcRL).held === 'great_hall_rouen_castle' && rl.location === 'great_hall_rouen_castle');
  check('...and the framing names that place for that role', sceneFramingDirective(rl, joanScenario, arcRL, L).includes('17 March 1431 — Great Hall'));
  check('a session without scenes is never held', holdSceneLocation({ location: 'x' }, JOAN_ARC) === null);
  const arcStart = clone(JOAN_ARC); arcStart.acts[0].scenes[0].location_id = 'joan_prison_cell';
  const s0 = quiet(() => buildInitialState(joanScenario, JOAN_ROLES.find(r => r.id === 'role_manchon'), JOAN_LOCS)); initSceneState(s0, arcStart);
  check('a session starts at its first scene\'s place', s0.location === 'joan_prison_cell' && JSON.stringify(s0.visitedLocations) === '["joan_prison_cell"]');
  const s1 = quiet(() => buildInitialState(joanScenario, JOAN_ROLES.find(r => r.id === 'role_manchon'), JOAN_LOCS)); const before1 = JSON.stringify(s1.visitedLocations); initSceneState(s1, JOAN_ARC);
  check('...and a role already starting there keeps its initial location state exactly', s1.location === 'great_hall_rouen_castle' && JSON.stringify(s1.visitedLocations) === before1);

  // DIAG
  const n = clone(s); n.turnCount = 4; n.elapsedMinutes = 8;
  const hl = clone(n); hl.location = 'great_hall_rouen_castle'; const hh = holdSceneLocation(hl, JOAN_ARC);
  const line = forkDiagTurnLine({ turn: 4, state: s, nextState: hl, scenario: joanScenario, storyArc: JOAN_ARC, output: {}, newBeats: [], sceneMoves: [], locationHold: hh });
  check('DIAG: the turn whose prompt opened a scene says so', line.includes('framing: scene change + bridge'), line);
  check('DIAG: where the model put the player vs where the engine held them', line.includes('location: model said great_hall_rouen_castle, held at joan_prison_cell'), line);
  const fline = forkDiagTurnLine({ turn: 12, state: ft, nextState: clone(ft), scenario: joanScenario, storyArc: JOAN_ARC, output: {}, newBeats: [], sceneMoves: [] });
  check('DIAG: a fork turn opening a scene — no bridge, and why', fline.includes('framing: scene change (fork turn — the setup is the transition, no bridge)'), fline);
}

head('2g. B2b-MODEL — minimum scene time: a beat ends its scene only near the budget');
{
  // Joan: 2-minute turns, so a beat may end a scene once less than 1 minute of its budget is left.
  const at = (scene, entered, now, beats) => { const s = startState(); Object.assign(s, { currentSceneId: scene, sceneEnteredAt: entered, elapsedMinutes: now, reachedBeats: beats }); return s; };
  const adv = s => quiet(() => advanceScene(s, JOAN_ARC, 9, { scenario: joanScenario }));
  check('beat played on ARRIVAL (4-min scene, 2 in): the scene holds', adv(at('scene_17_mar', 8, 10, ['17_mar_1431'])).length === 0);
  check('...and ends on that beat after its second turn (4 in, budget spent)', adv(at('scene_17_mar', 8, 12, ['17_mar_1431']))[0]?.via === 'beat');
  check('3-min scene, beat on arrival (2 in, 1 left — not under half a turn): holds', adv(at('scene_24_feb', 4, 6, ['24_feb_1431'])).length === 0);
  check('5-min scene: holds at 2 in, still at 4 in (1 left), ends on its beat at 6 in', adv(at('scene_28_may', 20, 22, ['28_may_1431'])).length === 0 && adv(at('scene_28_may', 20, 24, ['28_may_1431'])).length === 0);
  const p = (scene, entered, now, beats = []) => scenePacingStatus(at(scene, entered, now, beats), joanScenario, JOAN_ARC);
  check('the scene\'s length in turns and the turn number (4-min scene: 2 turns)', p('scene_17_mar', 8, 8).turns === 2 && p('scene_17_mar', 8, 8).turnNo === 1 && p('scene_17_mar', 8, 10).turnNo === 2);
  const fr = (scene, entered, now, beats = []) => sceneFramingDirective(at(scene, entered, now, beats), joanScenario, JOAN_ARC, JOAN_LOCS);
  check('turn 1: the model is told the scene\'s length and to land the beat on its LAST turn', fr('scene_17_mar', 8, 8).includes('This scene runs about 2 turns; this is turn 1. Its ending beat (17_mar_1431) belongs on its LAST turn'));
  check('the last turn: the beat belongs here', fr('scene_17_mar', 8, 10).includes('This is the scene\'s last turn: its ending beat (17_mar_1431) belongs here.'));
  check('beat already played: let the scene play out — do not move on', fr('scene_17_mar', 8, 10, ['17_mar_1431']).includes('has happened. Let the scene play out its remaining time in this place'));
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

head('4. what reaches the model prompt — the roster and the scene framing (B2b-MODEL), never a scene id');
{
  // B2a kept scenes out of the prompt entirely; that is what let the narration lag the scene
  // position. B2b-MODEL adds exactly one thing for a scene session: the framing directive (date,
  // place, and on a scene's first turn the move and its bridge). Still no scene id anywhere.
  const promptFor = (st, arc) => composeTurnPrompt(st, 'I wait and watch.', { scenario: joanScenario, characters: [], locations: JOAN_LOCS, clues: [], ...(arc ? { storyArc: arc } : {}) });
  const bare = quiet(() => buildInitialState(joanScenario, JOAN_ROLES.find(r => r.id === 'role_manchon'), JOAN_LOCS));
  const tracked = clone(bare); initSceneState(tracked, JOAN_ARC);
  quiet(() => recordReachedBeats(tracked, { stateChanges: { beats_reached: ['24_feb_1431'] } }, JOAN_ARC)); quiet(() => advanceScene(tracked, JOAN_ARC, 1));
  const untracked = clone(tracked); for (const k of ['currentSceneId', 'sceneAdvances', 'sceneEnteredAt', 'sceneEnteredTurn']) delete untracked[k];
  const pr = promptFor(tracked, JOAN_ARC);
  const fr = sceneFramingDirective(tracked, joanScenario, JOAN_ARC, JOAN_LOCS);
  check('a scene-session prompt carries the framing: date and place', fr.startsWith('⚑ SCENE: 21 February 1431 — Great Hall, Rouen Castle') && pr.includes(fr), fr.slice(0, 120));
  const SEP = '\n\n';
  check('scene bookkeeping is stripped from STATE_JSON (tracked minus framing == untracked prompt)', pr.replace(SEP + fr, '') === promptFor(untracked, JOAN_ARC));
  check('no scene id appears anywhere in the prompt', !SEQ.some(id => pr.includes(id)));
  check('no bridge on a turn that does not open a scene', !arcScenes(JOAN_ARC).some(sc => sc.bridge && pr.includes(sc.bridge.slice(0, 40))) && !pr.includes('SCENE CHANGE'));
  check('the Part A beat roster IS in the prompt (the model needs it to report beats)', pr.includes('⚑ STORY POSITION') && pr.includes('] 24_feb_1431 — '));
  check('...with no PACING nudge (that stays fork-bound)', !pr.includes('⚑ PACING'));
  const d = buildStoryPositionDirective(tracked, joanScenario, JOAN_ARC);
  const noFr = pr.replace(SEP + fr, '');
  const bareOfBoth = noFr.includes(SEP + d) ? noFr.replace(SEP + d, '') : noFr.replace(d, '');   // the roster may lead its slot
  check('removing the roster and the framing leaves exactly the no-arc prompt (scenes add those two and nothing else)', bareOfBoth === promptFor(untracked, null));
  check('a session that does not track scenes gets no framing', sceneFramingDirective(untracked, joanScenario, JOAN_ARC, JOAN_LOCS) === '');
}

head('5. DIAG — the scene segment and the summary');
{
  const st0 = startState();
  const n0  = clone(st0);
  quiet(() => recordReachedBeats(n0, { stateChanges: { beats_reached: ['21_feb_1431'] } }, JOAN_ARC));
  spend(n0);
  const mv0 = quiet(() => advanceScene(n0, JOAN_ARC, 0));
  const line0 = forkDiagTurnLine({ turn: 0, opening: true, state: st0, nextState: n0, scenario: joanScenario, storyArc: JOAN_ARC, output: { stateChanges: { beats_reached: ['21_feb_1431'] } }, newBeats: ['21_feb_1431'], sceneMoves: mv0 });
  check('opening line shows the crossing', line0.includes('scene: scene_21_feb → scene_24_feb (advanced on beat 21_feb_1431)'), line0);
  check('Manchon (no fork) is described as having none, not as an unmet binding', line0.includes('fork: none (this role has no fork)'));
  const held = forkDiagTurnLine({ turn: 1, state: n0, nextState: clone(n0), scenario: joanScenario, storyArc: JOAN_ARC, output: { stateChanges: {} }, newBeats: [], sceneMoves: [] });
  check('a turn with no crossing says held', held.includes('scene: scene_24_feb (held)'), held);
  const n2 = clone(n0);
  quiet(() => recordReachedBeats(n2, { stateChanges: { beats_reached: ['24_feb_1431', 'the_voices_are', '9_may_1431'] } }, JOAN_ARC));
  spend(n2);
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
// 2-minute turns. With the minimum scene time (B2b-MODEL) every 3- and 4-minute scene runs two
// turns whatever the beats do; the beats decide whether it ends 'beat' or 'budget', and which
// reports are flagged ahead. The opening reports 21_feb_1431 on arrival — it no longer ends the
// opening scene.
const TURNS = [
  { beats: [],                             want: 'scene_21_feb', move: null },
  { beats: [],                             want: 'scene_24_feb', move: 'scene_21_feb → scene_24_feb (advanced on beat 21_feb_1431)' },
  { beats: ['the_voices_are'],             want: 'scene_24_feb', move: null },
  { beats: ['24_feb_1431'],                want: 'scene_17_mar', move: 'scene_24_feb → scene_17_mar (advanced on beat 24_feb_1431)' },
  { beats: ['17_mar_1431', '9_may_1431'],  want: 'scene_17_mar', move: null },
  { beats: [],                             want: 'scene_9_may',  move: 'scene_17_mar → scene_9_may (advanced on beat 17_mar_1431)' },
  { beats: [],                             want: 'scene_9_may',  move: null },
  { beats: [],                             want: 'scene_23_may', move: 'scene_9_may → scene_23_may (advanced on beat 9_may_1431)' },
  { beats: ['24_may_1431'],                want: 'scene_23_may', move: null },
  { beats: [],                             want: 'scene_24_may', move: 'scene_23_may → scene_24_may (advanced on budget 4/4 min, 23_may_1431 not reached)' },
  { beats: ['23_may_1431'],                want: 'scene_24_may', move: null },
  { beats: [],                             want: 'scene_28_may', move: 'scene_24_may → scene_28_may (advanced on beat 24_may_1431)' },
  { beats: ['28_may_1431'],                want: 'scene_28_may', move: null },
];
let joanSession = null;
try {
  nextOutput = out(['21_feb_1431']);
  const st = await sse('start', { scenarioId: JOAN_ID, roleId: 'role_manchon', narrativeStyle: 'focused' });
  check('/start (Joan, Manchon) completes', !!st.done, st.error ? JSON.stringify(st.error).slice(0, 200) : String(st.status));
  let state = st.done?.nextState; joanSession = st.done?.sessionId;
  check('opening: 21_feb_1431 reported on arrival — recorded, but the opening scene holds (minimum scene time)', state?.currentSceneId === 'scene_21_feb' && state?.reachedBeats?.includes('21_feb_1431') && !state?.sceneAdvances?.length, state?.currentSceneId);
  const visible = JSON.stringify(st.done?.output || {});
  check('what the player is sent (output) carries no scene data', !SEQ.some(id => visible.includes(id)));
  const perTurn = [];   // B2b-MODEL: what each turn's request told the model, and the state it started from
  for (const [i, t] of TURNS.entries()) {
    nextOutput = out(t.beats);
    const before = sent.length, startState = state;
    const r = await sse('turn', { state, playerInput: `I answer (${i + 1}).`, sessionId: joanSession });
    if (!r.done) { check(`turn ${i + 1} completes`, false, r.error ? JSON.stringify(r.error).slice(0, 200) : String(r.status)); break; }
    perTurn.push({ start: startState, prompt: sent.slice(before).join('\n') });
    state = r.done.nextState;
    check(`turn ${i + 1}: beats ${JSON.stringify(t.beats)} → currentSceneId ${t.want}`, state.currentSceneId === t.want, state.currentSceneId);
  }
  const transcript = fs.readFileSync(p('engine/data/transcripts', `${joanSession}.md`), 'utf8');
  const diag = transcript.split('\n').filter(l => l.startsWith(DIAG_PREFIX));
  check(`transcript carries a DIAG line per turn (opening + ${TURNS.length})`, diag.length === TURNS.length + 1, `${diag.length} lines`);
  check('opening DIAG: the opening scene, held', diag[0]?.includes('scene: scene_21_feb (opening scene)'), diag[0]);
  TURNS.forEach((t, i) => {
    const l = diag[i + 1] || '';
    check(`turn ${i + 1} DIAG: ${t.move ? 'crossing recorded' : 'held'}`, t.move ? l.includes(`scene: ${t.move}`) : l.includes(`scene: ${t.want} (held)`), l.slice(0, 220));
  });
  check('e2e: the_voices_are reported in scene_24_feb is logged as ahead, not a skip', (diag[3] || '').includes('scene: scene_24_feb (held) · ahead: [the_voices_are]'), diag[3]);
  check('e2e: 24_may_1431 reported in scene_23_may is logged as ahead, not a skip', (diag[9] || '').includes('scene: scene_23_may (held) · ahead: [24_may_1431]'), diag[9]);
  check('e2e: 23_may_1431 reported late in scene_24_may: recorded, held, not flagged ahead', (diag[11] || '').includes('new: [23_may_1431]') && (diag[11] || '').includes('scene: scene_24_may (held) · ') && !(diag[11] || '').includes('ahead:'), diag[11]);
  check('e2e: a beat played on arrival holds its scene (17_mar_1431 on the first turn of scene_17_mar)', (diag[5] || '').includes('new: [17_mar_1431, 9_may_1431]') && (diag[5] || '').includes('scene: scene_17_mar (held)'), diag[5]);
  check(`none of the ${sent.length} model requests carries a scene id`, sent.length > 0 && !sent.some(s => SEQ.some(id => s.includes(id))));
  check('...and the requests DO carry the beat roster', sent.some(s => s.includes('STORY POSITION')));
  // B2b-MODEL e2e: every turn names its scene; a scene's FIRST turn — and only that turn —
  // carries the change and the scene's bridge.
  const SCN = Object.fromEntries(arcScenes(JOAN_ARC).map(sc => [sc.id, sc]));
  const opens = perTurn.map(x => x.start.sceneEnteredTurn === x.start.turnCount);
  check('e2e: every turn\'s request carries the date of the scene it plays in', perTurn.every(x => x.prompt.includes(`⚑ SCENE: ${SCN[x.start.currentSceneId].date_label}`)), perTurn.map(x => x.start.currentSceneId).join(','));
  check('e2e: the change + bridge appear exactly on the turns that open a scene', perTurn.every((x, i) => {
    const b = SCN[x.start.currentSceneId].bridge;
    return opens[i] ? x.prompt.includes('SCENE CHANGE') && (!b || x.prompt.includes(JSON.stringify(b).slice(1, 41))) : !x.prompt.includes('SCENE CHANGE');
  }), `opening turns: ${opens.map((o, i) => (o ? i + 1 : null)).filter(Boolean).join(',')}`);
  check('e2e: turn 3 opens scene_24_feb — the time-only change, with its bridge', opens[2] && perTurn[2].prompt.includes('it is now 24 February 1431') && !opens[0] && !opens[1]);
  const cellTurn = perTurn.findIndex(x => x.start.currentSceneId === 'scene_17_mar');
  check('e2e: in scene_17_mar the session is HELD in the cell though the scripted model keeps saying the hall', cellTurn >= 0 && perTurn[cellTurn].start.location === 'joan_prison_cell', perTurn[cellTurn]?.start.location);
  check('e2e DIAG: the override is logged', diag.some(l => l.includes('location: model said great_hall_rouen_castle, held at joan_prison_cell')));

  // B3b e2e: a model that NEVER reports a beat. The budgets alone must carry the story through
  // every scene — one scene per spent budget, the nudge on each scene's last turn — and land
  // it in scene_28_may at 24 minutes (each 3- or 4-minute budget takes two 2-minute turns),
  // before Joan's 0.75 clock fork (22.5 min) would matter for a binding and before the
  // default fallback (25.5).
  {
    nextOutput = out(undefined);
    const st2 = await sse('start', { scenarioId: JOAN_ID, roleId: 'role_manchon', narrativeStyle: 'focused' });
    let s = st2.done?.nextState; const sid = st2.done?.sessionId;
    check('B3b e2e: /start (no beats reported) holds in the opening scene', s?.currentSceneId === 'scene_21_feb' && s?.sceneEnteredAt === 0);
    const path = [], nudgedTurns = [], plainTurns = [];
    for (let t = 1; t <= 12 && s; t++) {
      nextOutput = out(undefined);
      const before = sent.length;
      const r = await sse('turn', { state: s, playerInput: `I hold my tongue (${t}).`, sessionId: sid });
      if (!r.done) { check(`B3b e2e turn ${t} completes`, false, r.error ? JSON.stringify(r.error).slice(0, 200) : ''); break; }
      const prompt = sent.slice(before).join('\n');
      (prompt.includes('SCENE PACING') ? nudgedTurns : plainTurns).push(t);
      if (r.done.nextState.currentSceneId !== s.currentSceneId) path.push(`${r.done.nextState.currentSceneId}@${r.done.nextState.elapsedMinutes}`);
      s = r.done.nextState;
    }
    check('B3b e2e: every scene left on its budget, one per two turns, reaching scene_28_may at 24 min',
      path.join(',') === 'scene_24_feb@4,scene_17_mar@8,scene_9_may@12,scene_23_may@16,scene_24_may@20,scene_28_may@24', path.join(' → '));
    check('B3b e2e: all moves via budget, none via beat', (s?.sceneAdvances || []).length === 6 && s.sceneAdvances.every(m => m.via === 'budget'));
    check('B3b e2e: the nudge was in the prompt on each scene\'s last turn (2,4,6,8,10,12) and no other', nudgedTurns.join(',') === '2,4,6,8,10,12', `nudged: ${nudgedTurns.join(',')}`);
    check('B3b e2e: no beat was fabricated by the backstop', !(s?.reachedBeats || []).length);
    const tr = fs.readFileSync(p('engine/data/transcripts', `${sid}.md`), 'utf8');
    const dl = tr.split('\n').filter(l => l.startsWith(DIAG_PREFIX));
    check('B3b e2e DIAG: turn 2 is nudged and advances on budget', (dl[2] || '').includes('scene: scene_21_feb → scene_24_feb (advanced on budget 4/3 min, 21_feb_1431 not reached)') && (dl[2] || '').includes('scene pacing: nudged toward 21_feb_1431'), dl[2]);
  }

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
