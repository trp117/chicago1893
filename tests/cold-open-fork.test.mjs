// Cold-open start: role-scoped state comes from the LIVE role, not the bake.
//
//   node tests/cold-open-fork.test.mjs
//
// Regression for the 2026-11-23 Cantigny artillery run (session e6439530): the cold open was
// baked on 2026-11-21, before the role's fork existed, so the baked state carried
// effectiveDefiningMoment:null. buildColdOpenState cloned it, resolveDefiningMomentBlock found
// no block, and definingMomentDue returned false on every turn — the 0.65 fallback was never
// even evaluated. Pure units: no content on disk, no Supabase, no model calls.
process.env.DEFINING_MOMENT_ENABLED = 'true';

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).href;
const CO = await import(`${ROOT}/engine/server/coldOpen.js`);
const PC = await import(`${ROOT}/engine/services/PromptComposer.js`);
const SM = await import(`${ROOT}/engine/services/StateManager.js`);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
  if (!ok) failed++;
};

// The live shape of steel_curtain_cantigny v79 / role_artillery_commander, trimmed.
const FORK = {
  id: 'mccormick_lift_three_choice',
  at_act: 3,
  reviewed: true,
  fires_live: true,
  generated: false,
  time_advance: 0,
  fallback_at_elapsed_fraction: 0.65,
  principal_transition: { type: 'decision_made', moment: 'mccormick_lift_three_choice' },
  options: [
    { id: 'fire_lift_three', text: 'Fire lift three on the schedule.' },
    { id: 'request_emergency_suspension', text: 'Request an emergency suspension through Captain Beaumont.' },
    { id: 'hold_guns_at_the_wire', text: 'Hold the guns at the wire — no transition without the observer\'s word.' },
  ],
};
const scenario = { id: 'steel_curtain_cantigny', status: 'published', sessionTargetMinutes: 30, storyArcIds: ['steel_curtain_cantigny_main_arc'], glossary: [] };
const role     = { id: 'role_artillery_commander', defining_moment: FORK };
const arc = {
  id: 'steel_curtain_cantigny_main_arc',
  acts: [
    { actNumber: 1, beats: [{ id: '0445_am_the' }, { id: 'the_artillery_commander' }, { id: 'the_signaler_exits' }] },
    { actNumber: 2, beats: [{ id: '0520_am_a' }, { id: 'a_runner_from' }] },
    { actNumber: 3, beats: [{ id: '0638_am_a' }, { id: '0645_am_the' }, { id: 'the_artillery_commander' }] },
    { actNumber: 4, beats: [{ id: '0710_am_the' }] },
  ],
};
const repos = { storyArcs: { findById: id => (id === arc.id ? arc : null) } };

// The baked row as it is in prod: no fork, no arc state.
const bakedState = {
  scenarioId: scenario.id, playerRoleId: role.id, location: 'loc_battery_dugout', visitedLocations: ['loc_battery_dugout'],
  elapsedMinutes: 0, remainingMinutes: 30, introducedNpcs: [], presentNpcs: [],
  effectiveClosure: null, effectiveClosureSource: 'none',
  effectiveDefiningMoment: null, effectiveDefiningMomentSource: 'none',
  decisions: {}, definingMomentPresented: false,
};
const content = {
  intro: { name: 'Steel Curtain', place: 'Cantigny', date: '28 May 1918', role: 'Artillery Commander' },
  lean:  { narrative: 'The line has been dead since 0412.', instruction: 'Your move — choose one, or write your own:', choices: ['A', 'B', 'C'] },
  baked: { state: bakedState, output: { narrative: 'The line has been dead since 0412.', choices: ['A', 'B', 'C'], location: 'loc_battery_dugout', scene: null, npcMoments: [] }, fingerprint: 'sha256:x', baked_at: '2026-11-21T20:16:38Z', source: '/start' },
};
const contentBefore = JSON.stringify(content);
const at = (state, elapsed, extra = {}) => ({ ...state, elapsedMinutes: elapsed, remainingMinutes: 30 - elapsed, ...extra });

console.log('\nThe bug, reproduced: the baked state alone');
{
  const { state } = CO.buildColdOpenState(content, { scenario });
  check('no role passed → effectiveDefiningMoment stays the baked null', state.effectiveDefiningMoment === null);
  check('  …the block does not resolve', PC.resolveDefiningMomentBlock(state, scenario) === null);
  check('  …and the fork is never due, even past the 0.65 fallback (minute 21)', PC.definingMomentDue(at(state, 21), scenario, null) === false);
}

console.log('\nThe fix: role-scoped fields from the live role');
const { state } = CO.buildColdOpenState(content, { scenario, role });
{
  check('effectiveDefiningMoment is the live role\'s armed fork', state.effectiveDefiningMoment?.id === FORK.id && state.effectiveDefiningMoment.fires_live === true);
  check('effectiveDefiningMomentSource is "role"', state.effectiveDefiningMomentSource === 'role');
  check('the fork resolves', PC.resolveDefiningMomentBlock(state, scenario)?.id === FORK.id);
  check('the fork is live (reviewed + armed) and story-bound', PC.definingMomentLive(state.effectiveDefiningMoment) && PC.storyBoundForkActive(state, scenario));
  check('closure: none on role or scenario → null / "none"', state.effectiveClosure === null && state.effectiveClosureSource === 'none');
}

console.log('\nStory tracking: the arc now loads from the refreshed state');
{
  const loaded = SM.loadStoryArc(repos, scenario, state);
  check('loadStoryArc returns the fork\'s arc', loaded === arc);
  check('the baked state had no reachedBeats', !('reachedBeats' in bakedState));
  check('seedColdOpenStoryTracking seeds reachedBeats = []', CO.seedColdOpenStoryTracking(state, loaded) === true && Array.isArray(state.reachedBeats) && state.reachedBeats.length === 0);
  check('  …and never overwrites beats already there', (() => { const s = { reachedBeats: ['x'] }; return CO.seedColdOpenStoryTracking(s, arc) === false && s.reachedBeats[0] === 'x'; })());
  check('  …and does nothing without an arc', (() => { const s = {}; return CO.seedColdOpenStoryTracking(s, null) === false && !('reachedBeats' in s); })());
  check('without the fork the arc does NOT load (scene-less arc, nothing to bind)', SM.loadStoryArc(repos, scenario, { ...state, effectiveDefiningMoment: null }) === null);
}

console.log('\nThe fork fires');
{
  check('minute 10, no beats → not yet due', PC.definingMomentDue(at(state, 10), scenario, arc) === false);
  check('minute 19.5 (0.65 × 30), no beats → due by the FALLBACK', PC.definingMomentDue(at(state, 19.5), scenario, arc) === true
    && PC.forkTimingStatus(at(state, 19.5), scenario, arc).via === 'fallback');
  check('minute 21 (turn 10 of e6439530) → due', PC.definingMomentDue(at(state, 21), scenario, arc) === true);
  // Beats the live turns report, through the same function the turn handler calls.
  const s3 = at(state, 12, { reachedBeats: [] });
  SM.recordReachedBeats(s3, { stateChanges: { beats_reached: ['0638_am_a'] } }, arc);
  check('minute 12, act-3 beat reported on a live turn → due by the BINDING', PC.definingMomentDue(s3, scenario, arc) === true
    && PC.forkTimingStatus(s3, scenario, arc).via === 'binding');
  check('once presented → not due again', PC.definingMomentDue(at(state, 21, { definingMomentPresented: true }), scenario, arc) === false);
  check('once decided → not due again', PC.definingMomentDue(at(state, 21, { decisions: { [FORK.id]: { option_id: 'fire_lift_three' } } }), scenario, arc) === false);
}

console.log('\nGates still hold on the refreshed field');
{
  const unarmed = CO.buildColdOpenState(content, { scenario, role: { ...role, defining_moment: { ...FORK, fires_live: false } } }).state;
  check('live role unarmed (fires_live false) → never due', PC.definingMomentDue(at(unarmed, 25), scenario, arc) === false);
  const noFork = CO.buildColdOpenState(content, { scenario, role: { id: role.id } }).state;
  check('live role with no fork → null / "none" (a fork removed after the bake is removed here too)', noFork.effectiveDefiningMoment === null && noFork.effectiveDefiningMomentSource === 'none');
  const scenFork = CO.buildColdOpenState(content, { scenario: { ...scenario, defining_moment: FORK }, role: { id: role.id } }).state;
  check('scenario-level fork, none on the role → "scenario"', scenFork.effectiveDefiningMomentSource === 'scenario' && scenFork.effectiveDefiningMoment?.id === FORK.id);
  const closure = { principal_transition: { type: 'x' } };
  const withClosure = CO.buildColdOpenState(content, { scenario, role: { ...role, closure } }).state;
  check('role closure → effectiveClosure from the live role, source "role"', withClosure.effectiveClosure === closure && withClosure.effectiveClosureSource === 'role');
}

console.log('\nThe opening the player sees is untouched');
{
  check('the row content (intro, lean cut, baked output and state) is not mutated', JSON.stringify(content) === contentBefore);
  check('location is the baked location', state.location === bakedState.location && JSON.stringify(state.visitedLocations) === JSON.stringify(bakedState.visitedLocations));
  const changed = Object.keys(state).filter(k => JSON.stringify(state[k]) !== JSON.stringify(bakedState[k]));
  const allowed = ['narrativeStyle', 'glossary', 'technicalFacts', 'effectiveDefiningMoment', 'effectiveDefiningMomentSource', 'reachedBeats'];
  check('only role-scoped fields (+ the existing glossary/facts/style refresh, + reachedBeats) differ from the bake', changed.every(k => allowed.includes(k)), `changed: ${changed.join(', ')}`);
}

console.log('\nKnown content hazard (logged, not fixed here)');
{
  // the_artillery_commander is a beat id in BOTH act 1 and act 3; storyPosition takes the last
  // arc beat whose id is reached, so the act-1 beat already counts as act 3.
  const s1 = at(state, 4, { reachedBeats: [] });
  SM.recordReachedBeats(s1, { stateChanges: { beats_reached: ['the_artillery_commander'] } }, arc);
  const pos = PC.storyPosition(s1, arc);
  console.log(`  INFO  reporting act-1 "the_artillery_commander" puts story position in act ${pos?.actNumber} → due=${PC.definingMomentDue(s1, scenario, arc)}`);
}

console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
