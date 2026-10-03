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
        definingMomentDue, FORK_FALLBACK_FRACTION_DEFAULT, arcHasScenes, buildStoryPositionDirective } =
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
// McCord's STORED fork is now live-bound (at_act:4, authored in the admin). The unbound
// baseline every contrast below needs is the same block with the binding keys removed —
// exactly the clock-only shape it had before Part A — rebuilt in memory, never written.
const BINDING_KEYS = ['at_act', 'at_beat', 'fallback_at_elapsed_fraction'];
const unbind    = role => ({ ...role, defining_moment: Object.fromEntries(Object.entries(role.defining_moment).filter(([k]) => !BINDING_KEYS.includes(k))) });
const mccordStored = WG.roles.find(r => r.id === 'role_mccord');
const mccord    = unbind(mccordStored);
const bound     = (fields) => ({ ...mccord, defining_moment: { ...mccord.defining_moment, ...fields } });
const stateFor  = (role) => quiet(() => buildInitialState(WG.scenario, role, WG.locations));

// The roles whose STORED fork is story-bound. Explicit, so a new live binding is a deliberate
// test update rather than something the inertness sweeps silently absorb. Everything else in
// the corpus must stay byte-identical to pre-Part-A behaviour.
// role_joan: bound at_scene scene_28_may since B3c (her relapse fork, live in prod).
const EXPECTED_BOUND = ['role_joan', 'role_mccord', 'role_wills'];
const isBoundRole    = r => isStoryBoundFork(r.defining_moment);

head('THE GATE — isStoryBoundFork');
check('no block → not bound',                         isStoryBoundFork(null) === false);
check('clock-only block (today\'s shape) → not bound', isStoryBoundFork(mccord.defining_moment) === false);
const boundIds = corpus.flatMap(c => c.roles.filter(isBoundRole).map(r => r.id)).sort();
check(`stored story-bound roles are exactly ${EXPECTED_BOUND.join(', ')}`, JSON.stringify(boundIds) === JSON.stringify([...EXPECTED_BOUND].sort()), boundIds.join(', ') || 'none');
check('stored McCord is bound at_act:4 (the live binding this file now models)', mccordStored.defining_moment.at_act === 4 && isStoryBoundFork(mccordStored.defining_moment));
check('at_act number → bound',                        isStoryBoundFork({ at_act: 4 }) === true);
check('at_beat id → bound',                           isStoryBoundFork({ at_beat: 'officers_reach_the' }) === true);
check('at_act as a STRING does not opt in',           isStoryBoundFork({ at_act: '4' }) === false);
check('blank at_beat does not opt in',                isStoryBoundFork({ at_beat: '  ' }) === false);
check('null at_act / at_beat do not opt in',          isStoryBoundFork({ at_act: null, at_beat: null }) === false);
check('fallback fraction ALONE does not opt in',      isStoryBoundFork({ fallback_at_elapsed_fraction: 0.85 }) === false);

head('A1 INERTNESS — no UNBOUND stored role loads an arc; each bound one loads its own');
let storedForks = 0, unboundRoles = 0; const loaded = [], boundMissed = [];
for (const { scenario, roles, locations } of corpus) {
  for (const role of roles) {
    if (role.defining_moment) storedForks++;
    const st  = quiet(() => buildInitialState(scenario, role, locations));
    const arc = quiet(() => loadForkStoryArc(repos, scenario, st));
    if (isBoundRole(role)) {
      if (!storyBoundForkActive(st, scenario) || arc?.id !== scenario.storyArcIds?.[0]) boundMissed.push(`${scenario.id}/${role.id}`);
      continue;
    }
    unboundRoles++;
    if (storyBoundForkActive(st, scenario) || arc) loaded.push(`${scenario.id}/${role.id}`);
  }
}
check(`all ${unboundRoles} unbound stored roles (of ${corpus.reduce((n, c) => n + c.roles.length, 0)}; ${storedForks} with a fork) load no arc`, unboundRoles > 0 && loaded.length === 0, loaded.join(', '));
check(`each bound stored role (${EXPECTED_BOUND.join(', ')}) loads its scenario's arc`, boundMissed.length === 0, boundMissed.join(', '));
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
  // Hand EVERY unbound stored role its scenario's arc anyway. None is story-bound, so not one
  // prompt may change: the directive keys on the fork, and an arc in the game data is inert.
  // The bound roles are the opposite case — the arc must SHAPE their prompt (a STORY POSITION
  // block), which is what their binding asks for.
  // Scene scenarios (B2a) are a third case: every role gets the roster — exactly the roster,
  // nothing else — because scenes advance on reported beats. Asserted as such below.
  let compared = 0, sceneRoles = 0; const moved = [], boundFlat = [], sceneMoved = [];
  for (const c of corpus) {
    const arc = arcOf(c);
    if (!arc) continue;
    const total = c.scenario.sessionTargetMinutes || 15;
    for (const role of c.roles) {
      for (const f of [0, 0.6, 0.8]) {
        const st = quiet(() => buildInitialState(c.scenario, role, c.locations));
        st.elapsedMinutes = total * f; st.remainingMinutes = total - st.elapsedMinutes;
        if (isBoundRole(role)) {
          if (!promptFor(c, st, arc).includes('⚑ STORY POSITION')) boundFlat.push(`${c.scenario.id}/${role.id}@${f}`);
          continue;
        }
        if (arcHasScenes(arc)) {
          const withArc = promptFor(c, st, arc), d = buildStoryPositionDirective(st, c.scenario, arc);
          const stripped = withArc.includes('\n\n' + d) ? withArc.replace('\n\n' + d, '') : withArc.replace(d, '');
          if (!d.includes('⚑ STORY POSITION') || d.includes('⚑ PACING') || stripped !== promptFor(c, st, null)) sceneMoved.push(`${c.scenario.id}/${role.id}@${f}`);
          sceneRoles++;
          continue;
        }
        if (promptFor(c, st, arc) !== promptFor(c, st, null)) moved.push(`${c.scenario.id}/${role.id}@${f}`);
        compared++;
      }
    }
  }
  check(`${compared} UNBOUND stored role x elapsed prompts (scenarios without scenes) identical with and without the arc`, compared > 0 && moved.length === 0, moved.slice(0, 5).join(', '));
  check(`${sceneRoles} scene-scenario role x elapsed prompts: the arc adds the beat roster and NOTHING else (no nudge)`, sceneRoles > 0 && sceneMoved.length === 0, sceneMoved.slice(0, 5).join(', '));
  check('every BOUND stored role\'s prompt carries STORY POSITION when its arc is loaded', boundFlat.length === 0, boundFlat.slice(0, 5).join(', '));

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
  // A BOUND fork with no beat reached (a fresh state) is due at its fallback fraction only —
  // never at at_elapsed_fraction, which the binding ignores. Same minute sweep, its own rule.
  const fallbackDue = (st, c) => {
    const b = st.effectiveDefiningMoment;
    const frac = typeof b?.fallback_at_elapsed_fraction === 'number' ? b.fallback_at_elapsed_fraction : FORK_FALLBACK_FRACTION_DEFAULT;
    return !!b && !!b.principal_transition?.moment && st.elapsedMinutes >= (c.scenario.sessionTargetMinutes || 15) * frac;
  };
  let forks = 0, boundForks = 0, points = 0; const moved = [], boundMoved = [];
  for (const c of corpus) {
    const arc = arcOf(c);
    for (const role of c.roles.filter(r => r.defining_moment)) {
      forks++;
      const isB = isBoundRole(role);
      if (isB) boundForks++;
      const total = c.scenario.sessionTargetMinutes || 15;
      for (let m = 0; m <= total; m += 0.5) {
        const st = quiet(() => buildInitialState(c.scenario, role, c.locations));
        st.elapsedMinutes = m; st.remainingMinutes = total - m;
        const want = isB ? fallbackDue(st, c) : clockDue(st, c);
        if (definingMomentDue(st, c.scenario) !== want || definingMomentDue(st, c.scenario, arc) !== want) (isB ? boundMoved : moved).push(`${role.id}@${m}`);
        points++;
      }
    }
  }
  check(`all ${forks - boundForks} UNBOUND stored forks: due exactly at at_elapsed_fraction (half-minute sweep, arc passed or not)`, forks === 15 && moved.length === 0, moved.slice(0, 5).join(', '));
  check(`all ${boundForks} BOUND stored forks: with no beat reached, due only at the fallback fraction (${points} points total)`, boundForks === EXPECTED_BOUND.length && boundMoved.length === 0, boundMoved.slice(0, 5).join(', '));
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

head('ADMIN — the editor\'s binding fields, and the save guard behind them');
{
  // The real admin page script in a VM (the anchor-scope.test harness), the real
  // collectEdits, and the real adminRouter save guard. Nothing is saved.
  const { JSDOM } = await import('jsdom');
  const vm        = await import('vm');
  const admin     = await import(`${ROOT}/engine/admin/adminRouter.js`);
  const html   = fs.readFileSync(path.join(REPO_DIR, 'engine/admin/index.html'), 'utf8');
  const script = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/i.exec(html)[1];
  const noop   = () => {};
  const stubEl = new Proxy({}, { get: (t, k) => (k === 'value' ? '' : k === 'style' ? {} : k === 'classList' ? { add: noop, remove: noop } : noop) });
  const ctx = vm.createContext({
    document: { addEventListener: noop, getElementById: () => stubEl, querySelector: () => stubEl, querySelectorAll: () => [], createElement: () => stubEl, body: stubEl, documentElement: stubEl, head: stubEl },
    window: {}, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { search: '', href: '', pathname: '/admin/' }, navigator: { clipboard: {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }), console: { ...console, log: noop, warn: noop }, setTimeout, clearTimeout,
    alert: noop, confirm: () => false, prompt: () => null, addEventListener: noop, removeEventListener: noop,
    URLSearchParams, JSON, Math, Date, Object, Array, String, Number, Boolean, Set, Map, RegExp,
    Error, Promise, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
  });
  ctx.window = ctx;
  try { vm.runInContext(script, ctx, { filename: 'index.html<script>' }); } catch { /* builders may still be defined */ }
  const { renderDefiningMomentSection, collectEdits } = ctx;
  check('admin builders reachable', typeof renderDefiningMomentSection === 'function' && typeof collectEdits === 'function');

  // Render McCord's section, let the test drive the controls, collect, then run the guard.
  const edit = (role, drive = () => {}) => {
    const data = { scenario: WG.scenario, storyArc: WG_ARC, playerRoles: [structuredClone(role)] };
    const dom  = new JSDOM(`<div id="c">${renderDefiningMomentSection(data.playerRoles[0], 0, data)}</div>`);
    const c    = dom.window.document.getElementById('c');
    drive(c);
    collectEdits(c, data);
    return { dom: c, saved: quiet(() => admin.preserveStoredRoleBlocks(repos, data.playerRoles[0])) };
  };

  const { dom, saved } = edit(mccord);
  const actSel  = dom.querySelector('.dm-at-act-input');
  const beatSel = dom.querySelector('.dm-at-beat-input');
  check('"Fires in act" offers the arc\'s 4 acts plus blank', actSel?.options.length === 5 && actSel.options[4].textContent.includes('Suite 600, 2:10 AM'));
  check('"After beat" offers all 15 beat ids plus blank', beatSel?.querySelectorAll('option').length === 16);
  check('unbound role: every binding control renders blank', actSel.value === '' && beatSel.value === '' && dom.querySelector('.dm-fallback-input').value === '');
  const bindingKeys = Object.keys(saved.defining_moment).filter(k => ['at_act', 'at_beat', 'fallback_at_elapsed_fraction'].includes(k));
  check('opening and saving an unbound role adds NO binding key to its block', bindingKeys.length === 0, bindingKeys.join(','));
  check('...and the block is otherwise what was stored', JSON.stringify(saved.defining_moment) === JSON.stringify(mccord.defining_moment));

  const { saved: s2 } = edit(mccord, c => {
    c.querySelector('.dm-at-act-input').value = '4';
    c.querySelector('.dm-at-beat-input').value = 'officers_reach_the';
    c.querySelector('.dm-fallback-input').value = '0.9';
  });
  const d2 = s2.defining_moment;
  check('binding set in the editor saves with engine types', d2.at_act === 4 && d2.at_beat === 'officers_reach_the' && d2.fallback_at_elapsed_fraction === 0.9, JSON.stringify({ a: d2.at_act, b: d2.at_beat, f: d2.fallback_at_elapsed_fraction }));
  check('...and the saved block opts in to the engine gate', isStoryBoundFork(d2));

  const { dom: d3 } = edit(bound({ at_act: 4, at_beat: 'gone_beat' }));
  check('a stored at_beat the arc lacks renders as a flagged, selected option', d3.querySelector('.dm-at-beat-input').value === 'gone_beat' && d3.textContent.includes('not a beat of this arc'));
  check('a bound block shows at_elapsed_fraction as ignored', d3.textContent.includes('ignored — story-bound'));

  const n = b => quiet(() => admin.normalizeForkBinding({ ...b }));
  check('normalize: "4" → 4, " beat " → "beat", "0.9" → 0.9', JSON.stringify(n({ at_act: '4', at_beat: ' beat ', fallback_at_elapsed_fraction: '0.9' })) === '{"at_act":4,"at_beat":"beat","fallback_at_elapsed_fraction":0.9}');
  check('normalize: blanks, 0, 3.5, and fallback 1.5 / 0 are all dropped', JSON.stringify(n({ at_act: 3.5, at_beat: '', fallback_at_elapsed_fraction: 1.5 })) === '{}' && JSON.stringify(n({ at_act: 0, fallback_at_elapsed_fraction: 0 })) === '{}' && JSON.stringify(n({ at_act: null, at_beat: null, fallback_at_elapsed_fraction: null })) === '{}');
  check('normalize: a block with no binding keys is untouched', JSON.stringify(n(mccord.defining_moment)) === JSON.stringify(mccord.defining_moment));
  const movedBlocks = corpus.flatMap(c => c.roles.filter(r => r.defining_moment))
    .filter(r => JSON.stringify(quiet(() => admin.preserveStoredRoleBlocks(repos, structuredClone(r))).defining_moment) !== JSON.stringify(r.defining_moment))
    .map(r => r.id);
  check('the save guard leaves all 15 stored defining_moment blocks byte-identical', movedBlocks.length === 0, movedBlocks.join(', '));
}

head('TRANSCRIPT DIAGNOSTICS — durable beat/fork evidence, invisible to the closing model');
{
  const { forkTimingStatus } = await import(`${ROOT}/engine/services/PromptComposer.js`);
  const { forkDiagTurnLine, forkDiagSummaryLines, stripForkDiagnostics, parseForkDiagLines, DIAG_PREFIX } =
    await import(`${ROOT}/engine/services/ForkDiagnostics.js`);

  // forkTimingStatus explains definingMomentDue; it must never disagree with it.
  let pts = 0; const disagree = [];
  for (const c of corpus) {
    const arc = arcOf(c);
    for (const role of c.roles.filter(r => r.defining_moment)) {
      const total = c.scenario.sessionTargetMinutes || 15;
      for (let m = 0; m <= total; m += 1) {
        const st = quiet(() => buildInitialState(c.scenario, role, c.locations));
        st.elapsedMinutes = m;
        const s = forkTimingStatus(st, c.scenario, arc);
        // Fresh state, no beat reached: an unbound fork is due via the clock, a bound one via
        // its fallback — never 'binding', since no beat has been reported.
        const wantVia = isBoundRole(role) ? 'fallback' : 'clock';
        if (s.due !== definingMomentDue(st, c.scenario, arc) || (s.due && s.via !== wantVia)) disagree.push(`${role.id}@${m}`);
        pts++;
      }
    }
  }
  check(`forkTimingStatus.due === definingMomentDue on ${pts} stored-fork points (unbound via 'clock', bound via 'fallback')`, disagree.length === 0, disagree.slice(0, 5).join(', '));

  // A transcript written exactly as gameRouter writes one (the /start header's tail, then each
  // /turn chunk), with or without the diagnostic lines — so the strip can be checked for exact
  // restoration. The fork is presented the way gameRouter presents it: verdict from the state
  // the turn starts from, 0 minutes on the fork turn, the latch set, the answer recorded next turn.
  const simulate = (role, night, { diag, answer = 'close_the_housing', arc = WG_ARC } = {}) => {
    let st = stateFor(role);
    const total = WG.scenario.sessionTargetMinutes;
    const parts = [];
    const opening = { stateChanges: { beats_reached: night[0] } };
    const next0 = structuredClone(st);
    const nb0 = quiet(() => recordReachedBeats(next0, opening, arc));
    parts.push(['## Session\n\n', 'Opening narrative.', '',
      ...(diag ? [forkDiagTurnLine({ turn: 0, opening: true, state: st, nextState: next0, scenario: WG.scenario, storyArc: arc, output: opening, newBeats: nb0 }), ''] : []),
      '---', ''].join('\n'));
    st = next0;
    let pendingFork = false;
    for (let i = 1; i < night.length; i++) {
      const out = { stateChanges: night[i] === undefined ? {} : { beats_reached: night[i] } };
      let decided = null;
      if (pendingFork && answer) { st.decisions = { mccord_defining_choice: { option_id: answer, turn: st.turnCount, elapsed: st.elapsedMinutes } }; decided = answer; pendingFork = false; }
      const due  = definingMomentDue(st, WG.scenario, arc);
      const next = structuredClone(st);
      next.elapsedMinutes += due ? 0 : 2; next.remainingMinutes = total - next.elapsedMinutes; next.turnCount = (st.turnCount || 0) + 1;
      const nb = quiet(() => recordReachedBeats(next, out, arc));
      if (due) { next.definingMomentPresented = true; pendingFork = true; }
      parts.push([`**Player:** input ${i}`, '', `> Act ${next.act} · Suite 600 · ${next.remainingMinutes} min remaining`, '', `Narrative ${i}.`, '',
        ...(diag ? [forkDiagTurnLine({ turn: next.turnCount, state: st, nextState: next, scenario: WG.scenario, storyArc: arc, output: out, newBeats: nb, decisionRecorded: decided }), ''] : []),
        '---', ''].join('\n'));
      st = next;
    }
    // /closing-prose: `lines` ends with '' and the summary is pushed onto it before the join.
    const text    = parts.join('');
    const closing = ['', '## Closing Prose', '', 'Closing.', '', '---', '', '## Historical Record', '', 'Record.', ''];
    const summary = diag ? forkDiagSummaryLines({ transcript: text, sessionState: st, scenario: WG.scenario, storyArc: arc }) : [];
    return { text: text + [...closing, ...(summary.length ? [...summary, ''] : [])].join('\n'), state: st, plain: text + closing.join('\n') };
  };

  // A McCord-like night: beats through Act 3, never Act 4, one turn with a bad id, one with none.
  const LIVE = [
    ['wills_completes_his', 'mccord_and_the'], [], ['baldwin_is_at'], undefined, ['wills_finds_fresh', 'the_arrest'],
    [], ['mccord_registers_a'], ['wills_logs_the'], [], ['three_plainclothes_officers'], [], ['the_officers_begin'],
    [], [], [], [],
  ];
  const withDiag = simulate(bound({ at_act: 4 }), LIVE, { diag: true });
  const without  = simulate(bound({ at_act: 4 }), LIVE, { diag: false });
  check('strip(diagnosed transcript) === the transcript without diagnostics, exactly', stripForkDiagnostics(withDiag.text) === without.plain);
  check('every diagnostic line carries the DIAG prefix', withDiag.text.split('\n').filter(l => l.includes('⚑ DIAG')).every(l => l.startsWith(DIAG_PREFIX)));

  const lines = withDiag.text.split('\n').filter(l => l.startsWith(DIAG_PREFIX + 'turn'));
  check(`one diagnostic line per turn (${LIVE.length})`, lines.length === LIVE.length);
  check('turn 0 states the binding and the loaded arc', lines[0].includes('binding: at_act 4 · fallback 0.85 (default) = 25.5 of 30 min') && lines[0].includes('arc: watergate_1972_part1_breach_main_arc (15 beats)'));
  check('a turn with no beats_reached key reads "(absent)"', lines[3].includes('beats_reached: (absent)'), lines[3]);
  check('a turn with an empty list reads "[]"', lines[1].includes('beats_reached: [] · new: []'), lines[1]);
  check('a bad id is shown as rejected', lines[4].includes('rejected: [the_arrest]') && lines[4].includes('new: [wills_finds_fresh]'), lines[4]);
  const forkLine = lines.find(l => l.includes('PRESENTED'));
  check('the fork line says it fired via fallback, and why — judged at turn start', /fork: PRESENTED this turn via fallback \(26 ≥ 25\.5 min; binding unmet at turn start\)/.test(forkLine || ''), forkLine);
  check('the answer is recorded on the following turn', lines.some(l => l.includes('fork: answered this turn: close_the_housing')));

  const sum = withDiag.text.split('\n').filter(l => l.startsWith(DIAG_PREFIX) && !l.startsWith(DIAG_PREFIX + 'turn'));
  check('summary: beats listed with act, turn and clock', sum.some(l => l.startsWith(`${DIAG_PREFIX}beats reached (8): wills_completes_his [Act 1] (turn 0, 0 min)`) && l.includes('the_officers_begin [Act 3]')), sum.find(l => l.includes('beats reached')));
  check('summary: position at close is Act 3 (never reached Act 4)', sum.some(l => l.includes('position at close: Act 3 (the_officers_begin)')));
  check('summary: fork presented via fallback', sum.some(l => /fork: presented turn \d+ at 26 min via fallback/.test(l)));
  check('summary: decision with turn and clock', sum.some(l => /decision: close_the_housing \(turn \d+, 26 min\)/.test(l)));

  const bindingNight = simulate(bound({ at_act: 4 }), [...LIVE.slice(0, 12), ['officers_reach_the'], [], []], { diag: true }).text;
  check('a night that reaches Act 4 records the fork via binding', /fork: PRESENTED this turn via binding \(at_act 4 met at turn start\)/.test(bindingNight));

  // FIX 1 — the position column shows BEFORE → AFTER, so a verdict taken at turn start can be
  // read against both. The McCord shape: the fork turn's own output reports the Act 4 beat.
  const forkTurnNight = simulate(bound({ at_act: 4 }), [...LIVE.slice(0, 14), ['officers_reach_the'], []], { diag: true }).text;
  const ftl = forkTurnNight.split('\n').find(l => l.includes('PRESENTED'));
  check('fork-turn line: "Act 3 (…) → Act 4 (officers_reach_the)" beside "binding unmet at turn start"',
    /position: Act 3 \(the_officers_begin\) → Act 4 \(officers_reach_the\)/.test(ftl || '') && ftl.includes('binding unmet at turn start'), ftl);
  check('turn 0 position starts from "no beat"', lines[0].includes('position: no beat → Act 1 (mccord_and_the)'), lines[0]);

  // EARLY REACH — the story gets to Act 4 at minute 16; the binding fires at 18, far before 25.5.
  const EARLY = [['wills_completes_his', 'mccord_and_the', 'baldwin_is_at'], ['wills_finds_fresh'], [], ['mccord_registers_a'],
    ['wills_logs_the'], [], ['three_plainclothes_officers'], ['the_officers_begin'], [], ['officers_reach_the'], [], [], []];
  const early = simulate(bound({ at_act: 4 }), EARLY, { diag: true }).text;
  const el    = early.split('\n').find(l => l.includes('PRESENTED'));
  check('EARLY: Act 4 reached by minute 16 (turn 9 ends at 18 min) — beat recorded that turn', early.includes('turn 9 · 16→18 min') && /turn 9 · 16→18 min .*new: \[officers_reach_the\]/.test(early));
  check('EARLY: fork fires via BINDING at 18 min, far before the 25.5 fallback', /^> ⚑ DIAG turn 10 · 18→18 min .*fork: PRESENTED this turn via binding \(at_act 4 met at turn start\)/.test(el || ''), el);
  check('EARLY: footer reports it', early.includes('fork: presented turn 10 at 18 min via binding'));
  check('EARLY: no pacing nudge was ever needed', !early.includes('pacing: nudged'));

  // STALL — the story never reaches Act 4: the nudge runs, then the fallback still fires.
  const stall = simulate(bound({ at_act: 4 }), LIVE.slice(0, 13).concat([[], [], []]), { diag: true }).text;
  const sl    = stall.split('\n').filter(l => l.startsWith(DIAG_PREFIX + 'turn'));
  check('STALL: nudge lines appear from 19.5 min and only while the binding is unmet', sl.filter(l => l.includes('pacing: nudged toward officers_reach_the')).every(l => /· (2\d|19\.5|20)(\.\d)?→/.test(l)) && sl.some(l => l.includes('pacing: nudged')));
  check('STALL: fallback still fires the fork at 26 min', sl.some(l => /turn \d+ · 26→26 min .*PRESENTED this turn via fallback/.test(l)));
  check('STALL: no nudge on or after the fork turn', !sl.some(l => l.includes('PRESENTED') && l.includes('pacing:')));
  const silent = simulate(bound({ at_act: 4 }), LIVE.map(() => undefined), { diag: true }).text;
  check('a model that never reports: summary says NONE, every line (absent)', silent.includes('beats reached: NONE') && parseForkDiagLines(silent).beats.length === 0 && !/beats_reached: \[/.test(silent));
  const gone = forkDiagSummaryLines({ transcript: withDiag.text, sessionState: null, scenario: WG.scenario, storyArc: WG_ARC });
  check('summary still built with session state gone (from the transcript alone)', gone.some(l => l.includes('beats reached (8)')) && gone.some(l => l.includes('(session state gone')));
  check('no diagnostic lines → no summary', forkDiagSummaryLines({ transcript: without.plain, sessionState: withDiag.state, scenario: WG.scenario, storyArc: WG_ARC }).length === 0);

  // PACING NUDGE in the prompt — the threshold, the target, and when it stays silent.
  const { storyPacingNudge, PACING_NUDGE_TURNS } = await import(`${ROOT}/engine/services/PromptComposer.js`);
  const at = (role, elapsed, reached = ['wills_completes_his', 'mccord_and_the', 'baldwin_is_at', 'wills_finds_fresh', 'wills_logs_the']) => {
    const st = stateFor(role); st.elapsedMinutes = elapsed; st.remainingMinutes = 30 - elapsed; st.reachedBeats = [...reached]; return st;
  };
  const boundM = bound({ at_act: 4 });
  const start  = 30 * 0.85 - PACING_NUDGE_TURNS * WG.scenario.systems.timePerTurnDefault;
  check(`nudge window opens at ${start} min (fallback 25.5 − ${PACING_NUDGE_TURNS} turns × ${WG.scenario.systems.timePerTurnDefault} min)`, start === 19.5);
  const pBelow = promptFor(WG, at(boundM, 19), WG_ARC);
  const pAbove = promptFor(WG, at(boundM, 20), WG_ARC);
  check('below the threshold: no PACING line', pBelow.includes('⚑ STORY POSITION') && !pBelow.includes('⚑ PACING'));
  const { buildStoryPositionDirective } = await import(`${ROOT}/engine/services/PromptComposer.js`);
  const dBelow = buildStoryPositionDirective(at(boundM, 19), WG.scenario, WG_ARC);
  const dAbove = buildStoryPositionDirective(at(boundM, 20), WG.scenario, WG_ARC);
  check('past it, the directive is the below-threshold directive + the PACING lines, nothing else', dAbove.startsWith(dBelow + '\n⚑ PACING:') && dAbove.split('\n').length === dBelow.split('\n').length + 2);
  check('past the threshold: names the bound act\'s first beat', pAbove.includes('It should now be reaching ACT 4 — Suite 600, 2:10 AM, beat officers_reach_the — move toward it.'));
  check('...and walks the unreached beats AHEAD of the position in order (never back to skipped Act 2 beats)', pAbove.includes('Move through three_plainclothes_officers, baldwin_watches_three, baldwin_transmits_his, the_officers_begin, in that order, and reach officers_reach_the') && !pAbove.includes('Move through the_decision_point'));
  check('...with the turns left before the fallback (20 → 25.5 at 2 min/turn = 3)', pAbove.includes('About 3 turns remain'));
  check('at_beat binding: the nudge targets that beat', storyPacingNudge(at(bound({ at_beat: 'mccord_barker_martinez' }), 22), WG.scenario, WG_ARC)?.target.id === 'mccord_barker_martinez');
  check('binding already met → no nudge', storyPacingNudge(at(boundM, 22, ['officers_reach_the']), WG.scenario, WG_ARC) === null);
  check('fork due (fallback reached) → no nudge', storyPacingNudge(at(boundM, 26), WG.scenario, WG_ARC) === null && !promptFor(WG, at(boundM, 26), WG_ARC).includes('⚑ PACING'));
  const presentedSt = at(boundM, 22); presentedSt.definingMomentPresented = true;
  check('fork already presented → no nudge', storyPacingNudge(presentedSt, WG.scenario, WG_ARC) === null);
  check('unbound McCord past the threshold → no nudge, no STORY POSITION', storyPacingNudge(at(mccord, 22), WG.scenario, WG_ARC) === null && !promptFor(WG, at(mccord, 22), WG_ARC).includes('⚑ PACING'));

  // Every real transcript on disk comes back as the same string.
  const tdir = path.join(REPO_DIR, 'engine/data/transcripts');
  const files = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter(f => f.endsWith('.md')) : [];
  const changed = files.filter(f => { const t = fs.readFileSync(path.join(tdir, f), 'utf8'); return stripForkDiagnostics(t) !== t; });
  check(`strip is the identity on all ${files.length} stored transcripts`, changed.length === 0, changed.slice(0, 3).join(', '));
}

console.log(fails ? `\n${fails} assertion(s) FAILED.` : '\nAll story-bound assertions passed.');
process.exit(fails ? 1 : 0);
