// LOCATION RECONCILIATION — the (a)+(b)+(c) fix.
//
//   (a) prompt wording: `location` reports where the narration LEAVES the player,
//       so a scene that carries them somewhere is reported, not swallowed.
//   (b) prompt roster: VALID LOCATIONS lists every id in the scenario, so "use a
//       valid id" is a real choice and not a choice between one id and itself.
//   (c) state guard: mergeState validates the model's emit against that roster and
//       HOLDS position on anything else, instead of writing prose into `location`.
//
// Runs against the real Watergate data through the real repositories. No API calls,
// no Supabase, no writes — every assertion is deterministic.

import 'dotenv/config';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;

const { JsonFileStore }        = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository }   = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { CharacterRepository }  = await import(`${ROOT}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }   = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { ClueRepository }       = await import(`${ROOT}/engine/repositories/ClueRepository.js`);
const { buildInitialState, mergeState } = await import(`${ROOT}/engine/services/StateManager.js`);
const { composeTurnPrompt }             = await import(`${ROOT}/engine/services/PromptComposer.js`);

const SCENARIO_ID = 'watergate_1972_part1_breach';
const ROLE_ID     = 'role_mccord';
const SUITE       = 'loc_suite_600';
const CORRIDOR    = 'loc_sixth_floor_corridor';

const store = new JsonFileStore(path.join(REPO_DIR, 'engine/data'));
const repos = {
  scenarios:  new ScenarioRepository(store),
  characters: new CharacterRepository(store),
  locations:  new LocationRepository(store),
  clues:      new ClueRepository(store),
};

const scenario   = await repos.scenarios.findById(SCENARIO_ID);
const role       = repos.scenarios.findPlayerRoles(SCENARIO_ID).find(r => r.id === ROLE_ID);
const locations  = repos.locations.findByScenario(SCENARIO_ID);
const characters = repos.characters.findAll().filter(c => (c.scenarioIds || []).includes(SCENARIO_ID));
const clues      = repos.clues.findByScenario(SCENARIO_ID);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

// mergeState's reject path warns on console.warn. Capture it so the test can assert the
// operator-visible signal, not just the resulting state.
function withWarnings(fn) {
  const seen = [];
  const real = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try { return { value: fn(), warnings: seen }; } finally { console.warn = real; }
}

// One turn, as the server runs it: the model emits `location`, mergeState decides.
const turn = (state, emitted, input = 'look around') =>
  withWarnings(() => mergeState(state, { location: emitted, narrative: 'x', stateChanges: {} },
                               scenario, clues, input, locations));

const fresh = () => buildInitialState(scenario, role, locations);

console.log(`scenario=${SCENARIO_ID} role=${ROLE_ID} locations=${locations.length} start=${fresh().location}`);

// -- (b) the roster the model actually receives -------------------------------
head('(b) VALID LOCATIONS roster reaches the model');
{
  const prompt = composeTurnPrompt(fresh(), 'look around', { scenario, characters, locations, clues });
  check('turn prompt carries the VALID LOCATIONS header', prompt.includes('VALID LOCATIONS'));
  const missing = locations.map(l => l.id).filter(id => !prompt.includes(id));
  check('every scenario location id is listed', missing.length === 0,
        missing.length ? `missing: ${missing.join(', ')}` : `all ${locations.length} ids present`);
  check('the START location is stated', prompt.includes(`Location at the START of this turn: ${SUITE}`));
  check('the old pin-in-place wording is gone',
        !prompt.includes('Do NOT place the player at a different location unless they explicitly move'));
}

// -- OVER-CORRECTION: holding still must not flip location ---------------------
head('OVER-CORRECTION - three hold turns at Suite 600 must not move');
{
  let state = fresh();
  const seen = [];
  for (const input of ['look around', 'listen at the door', 'ask Barker what he sees']) {
    state = turn(state, SUITE, input).value;   // model correctly re-emits the current id
    seen.push(state.location);
  }
  check('loc_out=loc_suite_600 on all three hold turns',
        seen.every(l => l === SUITE), `seen: ${seen.join(', ')}`);
  check('visitedLocations did not accumulate duplicates',
        state.visitedLocations.filter(l => l === SUITE).length === 1,
        JSON.stringify(state.visitedLocations));
  check('three turns actually elapsed', state.turnCount === 3, `turnCount=${state.turnCount}`);
}

// -- (a)+(c): legitimate movement is committed, and does not stick -------------
head('MOVEMENT - a real move commits, and does not stick');
{
  let state = fresh();
  state = turn(state, CORRIDOR, 'step out into the corridor').value;
  check('move to the corridor is committed', state.location === CORRIDOR, `loc_out=${state.location}`);
  check('corridor recorded in visitedLocations', state.visitedLocations.includes(CORRIDOR));

  // The bug this fix targets: after a move, the next non-movement turn must hold at the
  // NEW location — not snap back, and not stick when the player then moves again.
  state = turn(state, CORRIDOR, 'listen').value;
  check('hold turn after a move stays at the corridor', state.location === CORRIDOR, `loc_out=${state.location}`);
  state = turn(state, SUITE, 'go back into the suite').value;
  check('does NOT stick at the corridor - move back is committed',
        state.location === SUITE, `loc_out=${state.location}`);
}

// -- VALIDATION: bad emits are rejected and position held ----------------------
head('VALIDATION - bad emits rejected and held');
{
  const bad = [
    ['display name instead of an id', 'Sixth Floor Corridor, Watergate Office Building'],
    ['bare display name',             'Sixth Floor Corridor'],
    ['invented slug',                 'loc_sixth_floor_hallway'],
    ['prose phrase',                  'the corridor outside the suite'],
    ['id from another scenario',      'loc_court_of_honor'],
  ];
  for (const [label, emit] of bad) {
    const { value: state, warnings } = turn(fresh(), emit);
    const rejected = warnings.some(w => w.includes('[LOCATION] Rejected') && w.includes(emit));
    check(`${label} - held at ${SUITE}`, state.location === SUITE, `loc_out=${state.location}`);
    check(`${label} - warned [LOCATION] Rejected`, rejected, warnings[0] || 'no warning emitted');
    check(`${label} - not written into visitedLocations`, !state.visitedLocations.includes(emit));
  }
}

// -- back-compat: a caller that passes no roster behaves as before -------------
head('BACK-COMPAT - no roster passed means no guard');
{
  const before = fresh();
  const after  = mergeState(before, { location: 'anything_at_all', stateChanges: {} }, scenario, clues, '');
  check('unguarded caller still writes through', after.location === 'anything_at_all');
}

console.log(`\n${fails ? `${fails} assertion(s) FAILED.` : 'All location-reconciliation assertions passed.'}`);
process.exit(fails ? 1 : 0);
