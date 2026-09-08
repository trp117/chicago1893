// ANCHORED LOCATION — the verify-before-enforce gate, and the proposer that depends on it.
//
// Two halves, and the first is why the second is safe to write:
//
//   (1) THE GATE. A role's anchored_location narrows nothing — not the location roster, not
//       the prose directive — unless reviewed === true. Enforcement keys on human
//       confirmation, never on the field being present, which is the same law an unreviewed
//       epilogue and unreviewed technical_facts already work under.
//
//   (2) THE PROPOSER. adminRouter's proposeAnchoredLocation drafts an anchor for the roles
//       declared character_type 'real' AND fate_mode 'anchored', lands it reviewed:false,
//       skips everyone else, and never overwrites an anchor that already exists.
//
// Runs against the real scenario data through the real repositories. No API calls, no
// Supabase, no writes — every assertion is deterministic and nothing on disk is touched.

import 'dotenv/config';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;

const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { buildInitialState }   = await import(`${ROOT}/engine/services/StateManager.js`);
const { buildAnchoredLocationDirective, composeTurnPrompt } =
  await import(`${ROOT}/engine/services/PromptComposer.js`);
const { proposeAnchoredLocation } = await import(`${ROOT}/engine/admin/adminRouter.js`);

const SCENARIO_ID = 'watergate_1972_part1_breach';
const ROLE_ID     = 'role_mccord';
const SUITE       = 'loc_suite_600';

const store = new JsonFileStore(path.join(REPO_DIR, 'engine/data'));
const repos = {
  scenarios: new ScenarioRepository(store),
  locations: new LocationRepository(store),
};

const scenario  = await repos.scenarios.findById(SCENARIO_ID);
const roles     = repos.scenarios.findPlayerRoles(SCENARIO_ID);
const role      = roles.find(r => r.id === ROLE_ID);
const locations = repos.locations.findByScenario(SCENARIO_ID);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

// resolveAnchoredLocation warns on an unreviewed anchor. Silence it where a test builds one
// on purpose, and capture it where the warning itself is the thing under test.
function withWarnings(fn) {
  const seen = [];
  const real = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try { return { value: fn(), warnings: seen }; } finally { console.warn = real; }
}

// A state built from a role whose anchor has been overridden in memory. Nothing is written.
function stateFor(anchor, { elapsed = 0 } = {}) {
  const r = anchor === null
    ? { ...role, anchored_location: undefined }
    : { ...role, anchored_location: anchor };
  const { value: state } = withWarnings(() => buildInitialState(scenario, r, locations));
  state.elapsedMinutes = elapsed;
  return state;
}

// The VALID LOCATIONS roster, read back out of the composed turn prompt. Roster entries are
// the indented `  <id> — <name>` lines that follow the header; the block ends at the first
// line that is not one.
const rosterIds = state => {
  const prompt = composeTurnPrompt(state, 'wait', { scenario, characters: [], locations, clues: [] });
  const lines = prompt.split('\n');
  const at = lines.findIndex(l => l.startsWith('VALID LOCATIONS'));
  if (at < 0) return [];
  const ids = [];
  for (let i = at + 1; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}(\S+) — /);
    if (!m) break;
    ids.push(m[1]);
  }
  return ids;
};

head('fixtures');
check('scenario, role and locations load', !!scenario && !!role && locations.length > 1,
  `${locations.length} locations`);
check('McCord is the anchored fixture, verified in the stored file',
  role.anchored_location?.location_id === SUITE && role.anchored_location?.reviewed === true);

// ── (1) THE GATE ─────────────────────────────────────────────────────────────
head('the gate: reviewed:true enforces');
{
  const state = stateFor({ location_id: SUITE, enforce_from: 0, reviewed: true });
  const ids   = rosterIds(state);
  check('roster narrows to the anchor alone', ids.length === 1 && ids[0] === SUITE, ids.join(','));
  check('the prose directive is injected',
    buildAnchoredLocationDirective(state, scenario, locations).includes('THE SCENE IS ANCHORED'));
}

head('the gate: reviewed:false is inert — a proposal pins nobody');
{
  const state = stateFor({ location_id: SUITE, enforce_from: 0, reviewed: false });
  const ids   = rosterIds(state);
  check('roster is the FULL scenario roster, not the anchor alone',
    ids.length === locations.length, `${ids.length} of ${locations.length}`);
  check('no prose directive is injected',
    buildAnchoredLocationDirective(state, scenario, locations) === '');
  check('the anchor still resolves onto state (framing may read it)',
    state.effectiveAnchoredLocation?.location_id === SUITE
      && state.effectiveAnchoredLocation.reviewed === false);
}

head('the gate: the unenforced anchor is logged, once, by name');
{
  const { warnings } = withWarnings(() =>
    buildInitialState(scenario, { ...role, anchored_location: { location_id: SUITE, reviewed: false } }, locations));
  const hit = warnings.filter(w => w.includes('UNREVIEWED anchored_location'));
  check('exactly one [ANCHOR] warning naming the role', hit.length === 1 && hit[0].includes(role.id),
    hit[0] || 'no warning');
}

head('the gate: an absent anchor is untouched by any of this');
{
  const ids = rosterIds(stateFor(null));
  check('unanchored role keeps the full roster', ids.length === locations.length);
  check('unanchored role gets no directive',
    buildAnchoredLocationDirective(stateFor(null), scenario, locations) === '');
}

head('the gate: enforce_from still holds a reviewed anchor open');
{
  const total = scenario.sessionTargetMinutes || 15;
  const early = stateFor({ location_id: SUITE, enforce_from: 0.6, reviewed: true }, { elapsed: 0 });
  const late  = stateFor({ location_id: SUITE, enforce_from: 0.6, reviewed: true }, { elapsed: total });
  check('before the fraction: full roster', rosterIds(early).length === locations.length);
  check('after the fraction: narrowed', rosterIds(late).length === 1);
}

// ── (2) THE PROPOSER ─────────────────────────────────────────────────────────
head('the proposer: who gets a draft');
{
  // McCord already carries a verified anchor — never overwritten.
  const mccord = proposeAnchoredLocation(scenario, role, locations);
  check('a role with an anchor already is skipped, not redrafted',
    mccord.proposed === false && /already carries/.test(mccord.reason), mccord.reason);
  check('the skip reports the existing anchor as verified',
    mccord.existing?.location_id === SUITE && mccord.existing.reviewed === true);

  // Same role, anchor stripped — the eligible case.
  const bare = proposeAnchoredLocation(scenario, { ...role, anchored_location: undefined }, locations);
  check('real + anchored is drafted', bare.proposed === true);
  check('drafted at the role start location', bare.anchored_location?.location_id === role.startLocationId);
  check('drafted reviewed:FALSE', bare.anchored_location?.reviewed === false);
  check('drafted enforce_from 0.0', bare.anchored_location?.enforce_from === 0);
  check('stamped generated:true', bare.anchored_location?.generated === true);
  check('carries a rationale that says it is unverified',
    /PROPOSED — NOT VERIFIED/.test(bare.anchored_location?.rationale || ''));
  check('the rationale names the case for clearing it (a role who moved)',
    /MOVED/.test(bare.anchored_location?.rationale || ''));

  const stripped = { ...role, anchored_location: undefined };
  const notReal = proposeAnchoredLocation(scenario, { ...stripped, character_type: 'fictional' }, locations);
  check('fictional + anchored is NOT drafted', notReal.proposed === false, notReal.reason);
  const notAnchored = proposeAnchoredLocation(scenario, { ...stripped, fate_mode: 'committed' }, locations);
  check('real + committed is NOT drafted', notAnchored.proposed === false, notAnchored.reason);
  const undeclared = proposeAnchoredLocation(scenario, { ...stripped, fate_mode: undefined, character_type: undefined }, locations);
  check('an undeclared role is NOT drafted', undeclared.proposed === false, undeclared.reason);
  const badStart = proposeAnchoredLocation(scenario, { ...stripped, startLocationId: 'loc_not_here' }, locations);
  check('a start location outside the scenario is NOT drafted', badStart.proposed === false, badStart.reason);
}

head('the proposer: a draft does not enforce when it lands');
{
  const bare  = proposeAnchoredLocation(scenario, { ...role, anchored_location: undefined }, locations);
  const state = stateFor(bare.anchored_location);
  check('roster is untouched by the fresh proposal', rosterIds(state).length === locations.length);
  check('no directive from the fresh proposal',
    buildAnchoredLocationDirective(state, scenario, locations) === '');
  // ...and the same block, approved, does bind.
  const approved = stateFor({ ...bare.anchored_location, reviewed: true });
  check('the same block with Verified ticked binds', rosterIds(approved).length === 1);
}

head('the proposer: no epilogue dependency');
{
  const noEpilogue = { ...scenario, epilogue: undefined };
  const draft = proposeAnchoredLocation(noEpilogue, { ...role, anchored_location: undefined }, locations);
  check('drafts with no historical record generated', draft.proposed === true);
  check('and says so in the rationale',
    /no documented fate/.test(draft.anchored_location?.rationale || ''));
}

head('the proposer: across a whole multi-role scenario');
{
  for (const s of ['watergate_1972_part1_breach', 'schiller_corner_1914', 'apollo_13_lifeboat']) {
    const sc   = await repos.scenarios.findById(s);
    const rs   = repos.scenarios.findPlayerRoles(s);
    const locs = repos.locations.findByScenario(s);
    if (!sc || !rs.length) { check(`${s} loads`, false); continue; }
    const out  = rs.map(r => proposeAnchoredLocation(sc, r, locs));
    const drafted = out.filter(o => o.proposed);
    const wrong   = drafted.filter(o => !(o.character_type === 'real' && o.fate_mode === 'anchored'));
    const unsafe  = drafted.filter(o => o.anchored_location.reviewed !== false);
    check(`${s}: every draft is real + anchored`, wrong.length === 0, `${drafted.length} drafted of ${rs.length}`);
    check(`${s}: no draft lands reviewed:true`, unsafe.length === 0);
    check(`${s}: every skip states a reason`,
      out.filter(o => !o.proposed).every(o => typeof o.reason === 'string' && o.reason.length > 10));
  }
}


// ── (3) THE ROUTES, END TO END ───────────────────────────────────────────────
// The two admin routes driven directly against the real repositories, over a SCRATCH role
// created for this section and deleted at the end of it. No stored role is written: the
// scratch role is the only file that moves, and the assertions are about what lands in it.
//
// The router is invoked as the plain (req, res, next) function express routers are, with a
// minimal response object. That keeps the test on the real handler — the validation, the
// stamps, the 409 — without a listening server or an admin session.
head('the routes: propose is read-only, apply lands a proposal');
{
  const { createAdminRouter } = await import(`${ROOT}/engine/admin/adminRouter.js`);
  const fullRepos = {
    ...repos,
    characters: { findAll: () => [], findById: () => null },
    clues:      { findAll: () => [], findByScenario: () => [] },
    storyArcs:  { findByScenario: () => [] },
    players:    { findAll: () => [] },
    sessions:   { findAll: () => [] },
  };
  const router = createAdminRouter(fullRepos, {});

  const call = (method, url, body) => new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router({ method, url, body: body || {}, query: {}, headers: {} }, res,
      err => err ? reject(err) : resolve({ status: 404, body: { error: 'no route matched' } }));
  });

  const PROBE = 'role_zz_anchor_probe';
  const probe = {
    id: PROBE,
    scenarioId: SCENARIO_ID,
    name: 'Anchor Probe (scratch)',
    character_type: 'real',
    fate_mode: 'anchored',
    startLocationId: SUITE,
  };
  repos.scenarios.savePlayerRole(probe);

  try {
    const proposeUrl = `/scenarios/${SCENARIO_ID}/propose-anchored-locations`;
    const first = await call('POST', proposeUrl);
    const mine  = (first.body.proposals || []).find(p => p.role_id === PROBE);
    check('propose returns a draft for the scratch role', first.status === 200 && !!mine);
    check('propose writes nothing', first.body.persisted === false
      && repos.scenarios.findPlayerRole(PROBE).anchored_location === undefined);
    check('propose returns the scenario locations for the select',
      (first.body.locations || []).length === locations.length);
    check('propose reports skips as well as drafts', (first.body.skipped || []).length > 0);

    const applyUrl = `/scenarios/${SCENARIO_ID}/roles/${PROBE}/anchored-location`;
    const bad = await call('POST', applyUrl, { location_id: 'loc_not_in_this_scenario' });
    check('apply refuses a location outside the scenario', bad.status === 400, bad.body.error);
    const badFrom = await call('POST', applyUrl, { location_id: SUITE, enforce_from: '2' });
    check('apply refuses an out-of-range enforce_from', badFrom.status === 400, badFrom.body.error);

    const applied = await call('POST', applyUrl, {
      location_id: mine.anchored_location.location_id,
      enforce_from: mine.anchored_location.enforce_from,
      rationale: mine.anchored_location.rationale,
      reviewed: true,             // a client trying to approve its own draft
      generated: false,
    });
    check('apply succeeds', applied.status === 200, JSON.stringify(applied.body).slice(0, 120));

    const stored = repos.scenarios.findPlayerRole(PROBE);
    check('the proposal LANDED in the role file',
      stored.anchored_location?.location_id === SUITE);
    check('it landed reviewed:FALSE — a posted reviewed:true cannot approve it',
      stored.anchored_location.reviewed === false);
    check('it landed generated:true', stored.anchored_location.generated === true);
    check('it landed enforce_from 0 as a number',
      stored.anchored_location.enforce_from === 0);
    check('it carries the rationale', (stored.anchored_location.rationale || '').length > 50);

    // The whole point: it is in the file, and it does nothing.
    const { value: liveState } = withWarnings(() => buildInitialState(scenario, stored, locations));
    check('the landed proposal does not narrow the roster',
      rosterIds(liveState).length === locations.length);
    check('the landed proposal injects no directive',
      buildAnchoredLocationDirective(liveState, scenario, locations) === '');

    // Approval — the reviewer's tick, simulated on the stored block.
    const approvedRole = { ...stored, anchored_location: { ...stored.anchored_location, reviewed: true } };
    const approvedState = withWarnings(() => buildInitialState(scenario, approvedRole, locations)).value;
    check('once Verified is ticked, the same block binds', rosterIds(approvedState).length === 1);

    const again = await call('POST', applyUrl, { location_id: SUITE });
    check('apply refuses to overwrite an existing anchor (409)', again.status === 409, again.body.error);

    const second = await call('POST', proposeUrl);
    check('propose now skips the role it already drafted for',
      !(second.body.proposals || []).some(p => p.role_id === PROBE)
      && (second.body.skipped || []).some(s => s.role_id === PROBE && s.existing?.reviewed === false));
  } finally {
    repos.scenarios.deletePlayerRole(PROBE);
    check('scratch role removed', repos.scenarios.findPlayerRole(PROBE) === null);
  }
}

console.log(fails ? `\n${fails} check(s) failed.` : '\nAll checks passed.');
process.exit(fails ? 1 : 0);
