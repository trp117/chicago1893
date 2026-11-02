// FORK ARMING — `reviewed` (content signed off) is separate from `fires_live` (armed).
//
//   GATE      a fork is due / story-bound-active / nudged only when reviewed === true AND
//             fires_live === true, both strict, both fail closed
//   SAVE      ScenarioRepository.savePlayerRole never stores an armed unreviewed block, and
//             stores a non-boolean fires_live as false
//   HOLD      a reviewed fork carrying fires_live:true (the backfill) is due at exactly the
//             same minutes as the old reviewed-only gate put it — minute by minute
//
// Synthetic fixtures for the gate. The SAVE section writes through a JsonFileStore in a temp dir.

import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).href;
const PC = await import(`${ROOT}/engine/services/PromptComposer.js`);
const { buildInitialState } = await import(`${ROOT}/engine/services/StateManager.js`);
const { ScenarioRepository, enforceForkArming } = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { JsonFileStore } = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const quiet = fn => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return fn(); } finally { console.log = l; console.warn = w; } };

if (!PC.DEFINING_MOMENT_ENABLED) { console.log('SKIP  fork-arming.test — DEFINING_MOMENT_ENABLED is off in this environment.'); process.exit(0); }

const ARC = { id: 'syn_arm_arc', acts: [{ act_number: 1, title: 'One', beats: [{ id: 'syn_b1' }] }, { act_number: 2, title: 'Two', beats: [{ id: 'syn_b2' }] }] };
const SC  = { id: 'syn_arm', sessionTargetMinutes: 30, storyArcIds: [ARC.id] };
const LOCS = [{ id: 'syn_room', name: 'Room' }];
const fork = (moment, extra) => ({ id: moment, setup: 'Frozen.', principal_transition: { type: 'decision_made', moment },
  options: [{ id: 'a', text: 'A.' }, { id: 'b', text: 'B.' }], ...extra });
const CLOCK = fork('m_clock', { at_elapsed_fraction: 0.5 });
const BOUND = fork('m_bound', { at_elapsed_fraction: 0.6, at_beat: 'syn_b2' });   // Augustine's shape

const stateAt = (block, m, beats = []) => {
  const st = quiet(() => buildInitialState(SC, { id: 'syn_role', name: 'Role', defining_moment: block }, LOCS));
  st.elapsedMinutes = m; st.remainingMinutes = 30 - m; st.reachedBeats = beats;
  return st;
};
const everDue = block => {
  for (let m = 0; m <= 30; m += 0.5) {
    if (PC.definingMomentDue(stateAt(block, m), SC, ARC) || PC.definingMomentDue(stateAt(block, m, ['syn_b1', 'syn_b2']), SC, ARC)) return true;
  }
  return false;
};
const everActive = block => PC.storyBoundForkActive(stateAt(block, 10, ['syn_b1']), SC);
const everNudged = block => [18, 20, 22, 24, 25].some(m => PC.storyPacingNudge(stateAt(block, m), SC, ARC) != null);

head('1. the gate — the three combinations');
for (const [label, base] of [['clock fork', CLOCK], ['bound fork', BOUND]]) {
  check(`${label}: reviewed:true + fires_live:false → never due (Monica)`, !everDue({ ...base, reviewed: true, fires_live: false }));
  check(`${label}: reviewed:false + fires_live:true → never due (cannot arm unreviewed)`, !everDue({ ...base, reviewed: false, fires_live: true }));
  check(`${label}: reviewed:true + fires_live:true → due (Augustine)`, everDue({ ...base, reviewed: true, fires_live: true }));
}
check('bound: reviewed-only is not story-bound-active; armed is', !everActive({ ...BOUND, reviewed: true }) && everActive({ ...BOUND, reviewed: true, fires_live: true }));
check('bound: reviewed-only gets no pacing nudge; armed does', !everNudged({ ...BOUND, reviewed: true }) && everNudged({ ...BOUND, reviewed: true, fires_live: true }));

head('2. fail closed — fires_live must be exactly true');
for (const v of [undefined, null, false, 'true', 1, {}]) {
  const b = { ...BOUND, reviewed: true }; if (v !== undefined) b.fires_live = v;
  check(`fires_live ${JSON.stringify(v) ?? 'absent'} → never due, never active`, !everDue(b) && !everActive(b) && !PC.definingMomentArmed(b));
}
check('definingMomentLive needs both halves', PC.definingMomentLive({ reviewed: true, fires_live: true }) === true
  && PC.definingMomentLive({ reviewed: true }) === false && PC.definingMomentLive({ fires_live: true }) === false && PC.definingMomentLive(null) === false);
{
  const sc = { ...SC, defining_moment: { ...CLOCK, reviewed: true } };
  const role = { id: 'syn_none', name: 'None' };
  const due = d => { const s = { ...sc, defining_moment: { ...sc.defining_moment, ...d } }; const st = quiet(() => buildInitialState(s, role, LOCS)); st.elapsedMinutes = 29; st.remainingMinutes = 1; return PC.definingMomentDue(st, s, ARC); };
  check('a scenario-level fallback block is gated the same way', due({ fires_live: true }) === true && due({}) === false && due({ fires_live: false }) === false);
}

head('3. decision hold — armed forks are due at exactly the minutes the reviewed-only gate gave them');
{
  // The old gate, restated: definingMomentDue with arming ignored. A reviewed fork with the
  // backfill's fires_live:true must agree with it at every half-minute, beat reached or not.
  const oldDue = (block, st) => PC.definingMomentDue({ ...st, effectiveDefiningMoment: { ...block, fires_live: true } }, SC, ARC);
  const moved = [];
  for (const base of [CLOCK, BOUND, fork('m_act', { at_elapsed_fraction: 0.6, at_act: 2, fallback_at_elapsed_fraction: 0.9 })]) {
    const reviewedOnly = { ...base, reviewed: true };
    const backfilled   = { ...base, reviewed: true, fires_live: true };
    for (let m = 0; m <= 30; m += 0.5) for (const beats of [[], ['syn_b1'], ['syn_b1', 'syn_b2']]) {
      const st = stateAt(backfilled, m, beats);
      if (PC.definingMomentDue(st, SC, ARC) !== oldDue(reviewedOnly, stateAt(reviewedOnly, m, beats))) moved.push(`${base.id}@${m}[${beats}]`);
    }
  }
  check('no minute moved (3 fork shapes x 61 half-minutes x 3 beat states)', moved.length === 0, moved.slice(0, 5).join(', '));
}

head('4. the save invariant — ScenarioRepository.savePlayerRole');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-arming-'));
  const repo = new ScenarioRepository(new JsonFileStore(dir));
  const save = dm => quiet(() => repo.savePlayerRole({ id: 'syn_save', scenarioId: SC.id, defining_moment: dm })) && repo.findPlayerRole('syn_save').defining_moment;
  check('reviewed + armed → stored armed', save({ ...CLOCK, reviewed: true, fires_live: true }).fires_live === true);
  check('reviewed + not armed → stored not armed', save({ ...CLOCK, reviewed: true, fires_live: false }).fires_live === false);
  check('UNREVIEWED + armed → stored fires_live:false', save({ ...CLOCK, reviewed: false, fires_live: true }).fires_live === false);
  check('reviewed absent + armed → stored fires_live:false', save({ ...CLOCK, fires_live: true }).fires_live === false);
  check('non-boolean fires_live ("true") → stored false', save({ ...CLOCK, reviewed: true, fires_live: 'true' }).fires_live === false);
  check('a block with no fires_live key is stored without one (no key invented)', !('fires_live' in save({ ...CLOCK, reviewed: true })));
  check('a role with no defining_moment passes through untouched', JSON.stringify(enforceForkArming({ id: 'x', name: 'X' })) === '{"id":"x","name":"X"}');
  const input = { id: 'y', defining_moment: { reviewed: false, fires_live: true } };
  enforceForkArming(input);
  check('the caller\'s object is not mutated', input.defining_moment.fires_live === true);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);
