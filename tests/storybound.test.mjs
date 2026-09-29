// STORY-BOUND FORKS (Part A) — the opt-in gate, and what it gates.
//
// A defining moment that sets at_act or at_beat is bound to STORY POSITION instead of the
// clock. Everything Part A adds hangs off that one opt-in:
//
//   A1  the scenario's story arc is loaded into play (it never was before)
//   A2  the beat roster goes into the turn prompt, and the beats the model reports are
//       recorded on state.reachedBeats (the closure-flag pattern, for story position)
//   A3  the fork is due when its beat/act is reached — or at its fallback fraction if it
//       never is — instead of at at_elapsed_fraction
//
// THE GATE IS THE POINT. A fork without those fields — every fork stored today — must load no
// arc and compose exactly the prompt it composed before. Most assertions below are about that
// inertness; the rest prove the opted-in path actually does what it says.
//
// Runs against the real scenario data through the real repositories (the scenario repository
// reads through Supabase when it is configured). No API calls, no writes — opted-in roles are
// built IN MEMORY from a stored role, so nothing on disk is touched and no live fork is
// re-bound.

import 'dotenv/config';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

// The gate reads DEFINING_MOMENT_ENABLED at module load. Pin it ON for this process so the
// fork paths are exercised; the flag-OFF half runs in a child process below.
process.env.DEFINING_MOMENT_ENABLED = 'true';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;

const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
const { buildInitialState, loadForkStoryArc, recordReachedBeats, mergeState } =
  await import(`${ROOT}/engine/services/StateManager.js`);
const { isStoryBoundFork, storyBoundForkActive, composeTurnPrompt, arcBeats, storyPosition,
        definingMomentDue, FORK_FALLBACK_FRACTION_DEFAULT } =
  await import(`${ROOT}/engine/services/PromptComposer.js`);

const store = new JsonFileStore(path.join(REPO_DIR, 'engine/data'));
const repos = {
  scenarios: new ScenarioRepository(store),
  locations: new LocationRepository(store),
  storyArcs: new StoryArcRepository(store),
};

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const quiet = fn => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

// Every scenario any stored role plays in, plus every scenario file on disk. Roles are the
// source that matters: some scenarios (Joan's among them) have no file on disk and are read
// through the repository, and a corpus built from files alone silently skipped them.
const fs       = await import('fs');
const SCEN_DIR = path.join(REPO_DIR, 'engine/data/scenarios');
const scenarioIds = [...new Set([
  ...fs.readdirSync(SCEN_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')),
  ...fs.readdirSync(path.join(SCEN_DIR, 'player_roles')).filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(SCEN_DIR, 'player_roles', f), 'utf8')).scenarioId; } catch { return null; } })
    .filter(Boolean),
])].sort();
const corpus = [];
for (const id of scenarioIds) {
  const scenario = await repos.scenarios.findById(id);
  if (!scenario) continue;
  corpus.push({ scenario, roles: repos.scenarios.findPlayerRoles(id), locations: repos.locations.findByScenario(id) });
}

// WATERGATE is the clean opted-in case: continuous time, a 4-act arc, and McCord's fork, which
// belongs in Act 4 ("Suite 600, 2:10 AM") and today fires on the clock at 0.6.
const WG        = corpus.find(c => c.scenario.id === 'watergate_1972_part1_breach');
const mccord    = WG.roles.find(r => r.id === 'role_mccord');
const bound     = (fields) => ({ ...mccord, defining_moment: { ...mccord.defining_moment, ...fields } });
const stateFor  = (role) => quiet(() => buildInitialState(WG.scenario, role, WG.locations));

head('THE GATE — isStoryBoundFork');
check('no block → not bound',                         isStoryBoundFork(null) === false);
check('clock-only block (today\'s shape) → not bound', isStoryBoundFork(mccord.defining_moment) === false);
check('at_act number → bound',                        isStoryBoundFork({ at_act: 4 }) === true);
check('at_beat id → bound',                           isStoryBoundFork({ at_beat: 'officers_reach_the' }) === true);
check('at_act as a STRING does not opt in',           isStoryBoundFork({ at_act: '4' }) === false);
check('blank at_beat does not opt in',                isStoryBoundFork({ at_beat: '  ' }) === false);
check('null at_act / at_beat do not opt in',          isStoryBoundFork({ at_act: null, at_beat: null }) === false);
check('fallback fraction ALONE does not opt in',      isStoryBoundFork({ fallback_at_elapsed_fraction: 0.85 }) === false);

head('A1 INERTNESS — no stored role opts in, so no session loads an arc');
let storedForks = 0, loaded = [];
for (const { scenario, roles, locations } of corpus) {
  for (const role of roles) {
    if (role.defining_moment) storedForks++;
    const st = quiet(() => buildInitialState(scenario, role, locations));
    if (storyBoundForkActive(st, scenario) || loadForkStoryArc(repos, scenario, st)) loaded.push(`${scenario.id}/${role.id}`);
  }
}
check(`all ${corpus.reduce((n, c) => n + c.roles.length, 0)} stored roles (${storedForks} with a fork) load no arc`, loaded.length === 0, loaded.join(', '));
for (const id of ['greensboro_four_the_color_line', 'dog_green_sector']) {
  const c = corpus.find(x => x.scenario.id === id);
  const any = c.roles.some(r => loadForkStoryArc(repos, c.scenario, quiet(() => buildInitialState(c.scenario, r, c.locations))));
  check(`${id}: no role loads the arc`, c && !any);
}

head('A1 OPT-IN — a bound fork loads the arc');
const arcAct = loadForkStoryArc(repos, WG.scenario, stateFor(bound({ at_act: 4 })));
check('McCord at_act:4 → Watergate arc loaded', arcAct?.id === WG.scenario.storyArcIds[0], arcAct?.id);
check('the loaded arc carries its 4 acts', arcAct?.acts?.length === 4);
const arcBeat = loadForkStoryArc(repos, WG.scenario, stateFor(bound({ at_beat: 'officers_reach_the' })));
check('McCord at_beat → Watergate arc loaded', arcBeat?.id === WG.scenario.storyArcIds[0]);
const noArc = quiet(() => loadForkStoryArc(repos, { ...WG.scenario, storyArcIds: [] }, stateFor(bound({ at_act: 4 }))));
check('bound fork with NO arc on the scenario → null (falls back to the clock)', noArc === null);

head('A1 FLAG OFF — a bound fork loads nothing');
{
  const probe = `
    process.env.DEFINING_MOMENT_ENABLED = 'false';
    const { JsonFileStore } = await import('${ROOT}/engine/repositories/JsonFileStore.js');
    const { ScenarioRepository } = await import('${ROOT}/engine/repositories/ScenarioRepository.js');
    const { LocationRepository } = await import('${ROOT}/engine/repositories/LocationRepository.js');
    const { StoryArcRepository } = await import('${ROOT}/engine/repositories/StoryArcRepository.js');
    const { buildInitialState, loadForkStoryArc } = await import('${ROOT}/engine/services/StateManager.js');
    console.log = () => {}; console.warn = () => {};
    const store = new JsonFileStore(${JSON.stringify(path.join(REPO_DIR, 'engine/data'))});
    const repos = { scenarios: new ScenarioRepository(store), locations: new LocationRepository(store), storyArcs: new StoryArcRepository(store) };
    const scenario = await repos.scenarios.findById('watergate_1972_part1_breach');
    const role = repos.scenarios.findPlayerRoles(scenario.id).find(r => r.id === 'role_mccord');
    const st = buildInitialState(scenario, { ...role, defining_moment: { ...role.defining_moment, at_act: 4 } }, repos.locations.findByScenario(scenario.id));
    process.stdout.write(String(loadForkStoryArc(repos, scenario, st)));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', env: { ...process.env, DEFINING_MOMENT_ENABLED: 'false', DOTENV_CONFIG_OVERRIDE: 'false' } });
  check('DEFINING_MOMENT_ENABLED=false → bound fork loads no arc', r.stdout.trim().endsWith('null'), (r.stdout + r.stderr).trim().slice(-200));
}

// A composed turn prompt for a state, with or without an arc in the game data.
const promptFor = (c, st, storyArc) =>
  composeTurnPrompt(st, 'I wait and watch.', { scenario: c.scenario, characters: [], locations: c.locations, clues: [], ...(storyArc ? { storyArc } : {}) });
const arcOf = c => (c.scenario.storyArcIds?.[0] ? repos.storyArcs.findById(c.scenario.storyArcIds[0]) : null);

head('A2 INERTNESS — the gate is the fork fields, not the arc being available');
{
  // Hand EVERY stored role its scenario's arc anyway. Not one is story-bound, so not one
  // prompt may change: the directive keys on the fork, and an arc in the game data is inert.
  let compared = 0; const moved = [];
  for (const c of corpus) {
    const arc = arcOf(c);
    if (!arc) continue;
    const total = c.scenario.sessionTargetMinutes || 15;
    for (const role of c.roles) {
      for (const f of [0, 0.6, 0.8]) {
        const st = quiet(() => buildInitialState(c.scenario, role, c.locations));
        st.elapsedMinutes = total * f; st.remainingMinutes = total - st.elapsedMinutes;
        if (promptFor(c, st, arc) !== promptFor(c, st, null)) moved.push(`${c.scenario.id}/${role.id}@${f}`);
        compared++;
      }
    }
  }
  check(`${compared} stored role x elapsed prompts identical with and without the arc`, moved.length === 0, moved.slice(0, 5).join(', '));

  const gb  = corpus.find(c => c.scenario.id === 'greensboro_four_the_color_line');
  const gst = quiet(() => buildInitialState(gb.scenario, gb.roles[0], gb.locations));
  check('Greensboro prompt carries no STORY POSITION block', !promptFor(gb, gst, arcOf(gb)).includes('STORY POSITION'));
  check('recordReachedBeats with no arc records nothing', recordReachedBeats(gst, { stateChanges: { beats_reached: ['the_request'] } }, null).length === 0);
  check('...and adds no reachedBeats key', !('reachedBeats' in gst));
  const merged = mergeState(gst, { timeAdvance: 2, stateChanges: { beats_reached: ['x'] } }, gb.scenario, [], 'wait', gb.locations);
  check('mergeState ignores beats_reached (no reachedBeats key)', !('reachedBeats' in merged));
  check('no stored state carries reachedBeats at start', corpus.every(c => c.roles.every(r => !('reachedBeats' in quiet(() => buildInitialState(c.scenario, r, c.locations))))));
}

head('A2 OPT-IN — Watergate/McCord bound at_act:4: roster in, beats tracked');
const WG_ARC = arcOf(WG);
const beats  = arcBeats(WG_ARC);
{
  const st = stateFor(bound({ at_act: 4 }));
  const p0 = promptFor(WG, st, WG_ARC);
  check('prompt carries the STORY POSITION block', p0.includes('⚑ STORY POSITION'));
  check(`all ${beats.length} beat ids are in the roster`, beats.every(b => p0.includes(`] ${b.id} — `)));
  check('act headers carry the authored titles', p0.includes('ACT 3 — The Call and the Sweep') && p0.includes('ACT 4 — Suite 600, 2:10 AM'));
  check('NEXT BEAT is the first beat before anything is reached', p0.includes(`NEXT BEAT (${beats[0].id})`));
  check('the report instruction names beats_reached', p0.includes('beats_reached'));
  check('the beat block sits in the closure-directive slot, before the anchored directives', p0.indexOf('⚑ STORY POSITION') < p0.indexOf('- Return valid JSON only'));
  check('the same role unbound gets no block', !promptFor(WG, stateFor(mccord), WG_ARC).includes('STORY POSITION'));

  // A scripted play-through: the model reports beats turn by turn; the engine records them.
  const turns = [
    ['wills_completes_his', 'mccord_and_the'],
    'baldwin_is_at',                                   // single string form
    ['wills_finds_fresh', 'not_a_beat', 'wills_finds_fresh'], // unknown + duplicate
    ['wills_logs_the', 'three_plainclothes_officers'],
    ['officers_reach_the'],
  ];
  const acts = [];
  for (const reported of turns) {
    quiet(() => recordReachedBeats(st, { stateChanges: { beats_reached: reported } }, WG_ARC));
    acts.push(storyPosition(st, WG_ARC)?.actNumber ?? 0);
  }
  check('reached beats recorded in arrival order', st.reachedBeats.join(',') === 'wills_completes_his,mccord_and_the,baldwin_is_at,wills_finds_fresh,wills_logs_the,three_plainclothes_officers,officers_reach_the', st.reachedBeats.join(','));
  check('unknown beat id refused', !st.reachedBeats.includes('not_a_beat'));
  check('duplicate report recorded once', st.reachedBeats.filter(b => b === 'wills_finds_fresh').length === 1);
  check('story position advances act 1 → 1 → 2 → 3 → 4', acts.join('') === '11234', acts.join(''));

  const p1 = promptFor(WG, st, WG_ARC);
  check('reached beats are ticked in the roster', p1.includes('[x] officers_reach_the') && p1.includes('[ ] mccord_barker_martinez'));
  check('NEXT BEAT advances past the furthest reached beat', p1.includes('NEXT BEAT (mccord_barker_martinez)'));
  check('reachedBeats is not duplicated into STATE_JSON', !p1.includes('"reachedBeats"'));

  // Gaps are expected — an off-screen beat may never be reported. Position is the MAX.
  const gap = stateFor(bound({ at_act: 4 }));
  quiet(() => recordReachedBeats(gap, { stateChanges: { beats_reached: ['the_officers_begin'] } }, WG_ARC));
  check('a skipped-to beat sets position without the earlier ones', storyPosition(gap, WG_ARC)?.actNumber === 3);
}

head('A3 INERTNESS — every stored fork keeps its clock timing, minute by minute');
{
  // The pre-Part-A predicate, restated: due from total * at_elapsed_fraction on.
  const clockDue = (st, c) => {
    const b = st.effectiveDefiningMoment;
    return !!b && typeof b.at_elapsed_fraction === 'number' && !!b.principal_transition?.moment
      && st.elapsedMinutes >= (c.scenario.sessionTargetMinutes || 15) * b.at_elapsed_fraction;
  };
  let forks = 0, points = 0; const moved = [];
  for (const c of corpus) {
    const arc = arcOf(c);
    for (const role of c.roles.filter(r => r.defining_moment)) {
      forks++;
      const total = c.scenario.sessionTargetMinutes || 15;
      for (let m = 0; m <= total; m += 0.5) {
        const st = quiet(() => buildInitialState(c.scenario, role, c.locations));
        st.elapsedMinutes = m; st.remainingMinutes = total - m;
        const want = clockDue(st, c);
        if (definingMomentDue(st, c.scenario) !== want || definingMomentDue(st, c.scenario, arc) !== want) moved.push(`${role.id}@${m}`);
        points++;
      }
    }
  }
  check(`all ${forks} stored forks: due exactly at at_elapsed_fraction (${points} half-minute points, arc passed or not)`, forks === 15 && moved.length === 0, moved.slice(0, 5).join(', '));
}

head('A3 WATERGATE — McCord bound at_act:4 fires in Act 4, never in Act 3');
// A scripted night, two minutes a turn. Each entry: the beats the model reports that turn.
// The fork is checked at the START of each turn, against the state the previous turns left.
const NIGHT = [
  ['wills_completes_his', 'mccord_and_the', 'baldwin_is_at'],   // ends at 2
  [], ['wills_finds_fresh'], [], ['mccord_registers_a'],        // 4..10   Act 2
  ['wills_logs_the'], ['three_plainclothes_officers'],          // 12..14  Act 3
  ['baldwin_transmits_his'], [], ['the_officers_begin'], [],    // 16..22  Act 3, past 0.6 (18 min)
  ['officers_reach_the'],                                        // 24      Act 4 begins
];
const playNight = (role, night, arc = WG_ARC) => {
  const st = stateFor(role);
  const total = WG.scenario.sessionTargetMinutes || 15;
  const log = [];
  for (const reported of night) {
    log.push({ elapsed: st.elapsedMinutes, act: storyPosition(st, arc)?.actNumber ?? 0, due: definingMomentDue(st, WG.scenario, arc) });
    quiet(() => recordReachedBeats(st, { stateChanges: { beats_reached: reported } }, arc));
    st.elapsedMinutes += 2; st.remainingMinutes = total - st.elapsedMinutes;
  }
  log.push({ elapsed: st.elapsedMinutes, act: storyPosition(st, arc)?.actNumber ?? 0, due: definingMomentDue(st, WG.scenario, arc) });
  return { st, log };
};
{
  const total  = WG.scenario.sessionTargetMinutes;
  const today  = playNight(mccord, NIGHT).log;
  const firstToday = today.find(t => t.due);
  check('CONTRAST: unbound (today) McCord fork fires in Act 3, at 0.6', firstToday?.act === 3 && firstToday.elapsed === total * 0.6, JSON.stringify(firstToday));

  const { log } = playNight(bound({ at_act: 4 }), NIGHT);
  const inAct3 = log.filter(t => t.act === 3);
  check(`bound: NOT due on any of the ${inAct3.length} Act 3 turns (elapsed ${inAct3.map(t => t.elapsed).join(',')})`, inAct3.length >= 5 && inAct3.every(t => !t.due));
  check('bound: not due anywhere before Act 4', log.filter(t => t.act < 4).every(t => !t.due));
  const first = log.find(t => t.due);
  check('bound: due on the first turn after Act 4 begins, before the fallback', first?.act === 4 && first.elapsed < total * FORK_FALLBACK_FRACTION_DEFAULT, JSON.stringify(first));

  const byBeat = playNight(bound({ at_beat: 'officers_reach_the' }), NIGHT).log.find(t => t.due);
  check('at_beat officers_reach_the: fires on the same turn', byBeat?.elapsed === first?.elapsed && byBeat?.act === 4);
  const skip = playNight(bound({ at_beat: 'officers_reach_the' }), [...NIGHT.slice(0, -1), ['mccord_barker_martinez']]).log.find(t => t.due);
  check('at_beat: a LATER beat reported instead still fires it (the story is past it)', skip?.act === 4 && skip.elapsed === first?.elapsed);
  const early = playNight(bound({ at_beat: 'the_officers_begin', at_act: 4 }), NIGHT).log.find(t => t.due);
  check('at_beat wins over at_act when both are set', early?.act === 3);

  // The payload is untouched: the prompt on the due turn carries the same instruction as today.
  const dueState = playNight(bound({ at_act: 4 }), NIGHT).st;
  const pDue = promptFor(WG, dueState, WG_ARC);
  check('the due turn\'s prompt carries the DEFINING MOMENT instruction + authored setup', pDue.includes('⚑ DEFINING MOMENT (THIS TURN)') && pDue.includes(mccord.defining_moment.setup.trim().slice(0, 60)));
  const act3State = playNight(bound({ at_act: 4 }), NIGHT.slice(0, 9)).st;
  check('an Act 3 turn past 0.6 carries NO defining-moment instruction', act3State.elapsedMinutes >= total * 0.6 && !promptFor(WG, act3State, WG_ARC).includes('⚑ DEFINING MOMENT'));
}

head('A3 FALLBACK — a binding never met still gets the fork');
{
  const total   = WG.scenario.sessionTargetMinutes;
  const stalled = [...NIGHT.slice(0, -1), [], [], [], []];           // the story never reaches Act 4
  const dflt    = playNight(bound({ at_act: 4 }), stalled).log;
  const f1      = dflt.find(t => t.due);
  check(`default fallback ${FORK_FALLBACK_FRACTION_DEFAULT}: fires at the first turn ≥ ${total * FORK_FALLBACK_FRACTION_DEFAULT} min, still in Act 3`, f1?.act === 3 && f1.elapsed >= total * FORK_FALLBACK_FRACTION_DEFAULT && !dflt.some(t => t.due && t.elapsed < total * FORK_FALLBACK_FRACTION_DEFAULT), JSON.stringify(f1));
  const custom = playNight(bound({ at_act: 4, fallback_at_elapsed_fraction: 0.9 }), stalled).log.find(t => t.due);
  check('authored fallback 0.9: fires at the first turn ≥ 27 min (turns land on even minutes)', custom?.elapsed >= total * 0.9 && custom.elapsed < total * 0.9 + 2, JSON.stringify(custom));
  const unknownBeat = playNight(bound({ at_beat: 'no_such_beat' }), NIGHT.concat([[], []])).log.find(t => t.due);
  check('an at_beat naming no beat of the arc waits for the fallback', unknownBeat?.elapsed >= total * FORK_FALLBACK_FRACTION_DEFAULT, JSON.stringify(unknownBeat));
  const noArc = playNight(bound({ at_act: 4 }), NIGHT.concat([[], []]), null).log.find(t => t.due);
  check('a bound fork whose arc did not load fires at the fallback only', noArc?.elapsed >= total * FORK_FALLBACK_FRACTION_DEFAULT, JSON.stringify(noArc));
  const st = stateFor(bound({ at_act: 4 }));
  st.elapsedMinutes = total; st.definingMomentPresented = true;
  check('the presented latch still wins — a bound fork is asked once', definingMomentDue(st, WG.scenario, WG_ARC) === false);
}

console.log(fails ? `\n${fails} assertion(s) FAILED.` : '\nAll story-bound assertions passed.');
process.exit(fails ? 1 : 0);
