// CHOICE REGISTER — the authored steer on what KIND of choices a role is offered.
//
// Three properties, each one the reason the feature is safe to ship:
//
//   (1) BACKWARD-COMPATIBLE. A role with no register (absent, or blank) composes a turn
//       prompt byte-identical to the call shape that existed before the field did.
//
//   (2) ONE COPY, IN THE ROLE SECTION. A set register appears exactly once, as a
//       CHOICE REGISTER line inside the PLAYER ROLE section, and never in STATE_JSON.
//
//   (3) READ FRESH. The register is read from the role record each turn, not copied onto
//       state at /start, so a session already in flight picks up an edited register.
//
// Runs against the real scenario data through the real repositories. No API calls, no
// writes — every role change is made to an in-memory copy.

import 'dotenv/config';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;

const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { CharacterRepository } = await import(`${ROOT}/engine/repositories/CharacterRepository.js`);
const { buildInitialState }   = await import(`${ROOT}/engine/services/StateManager.js`);
const { composeTurnPrompt, buildSystemPrompt } =
  await import(`${ROOT}/engine/services/PromptComposer.js`);

const SCENARIO_ID = 'joan_trial_rouen_1431';
const ROLE_ID     = 'role_joan';
const REGISTER    = 'Choices of conviction and conscience, not legal or procedural tactics.';

const store = new JsonFileStore(path.join(REPO_DIR, 'engine/data'));
const repos = {
  scenarios:  new ScenarioRepository(store),
  locations:  new LocationRepository(store),
  characters: new CharacterRepository(store),
};

const scenario   = await repos.scenarios.findById(SCENARIO_ID);
const roles      = repos.scenarios.findPlayerRoles(SCENARIO_ID);
const stored     = roles.find(r => r.id === ROLE_ID);
const locations  = repos.locations.findByScenario(SCENARIO_ID);
const characters = repos.characters.findAll().filter(c => (c.scenarioIds || []).includes(SCENARIO_ID));

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

// The stored role with its register replaced in memory. `undefined` removes the key.
function roleWith(register) {
  const { choice_register, ...rest } = stored;
  return register === undefined ? rest : { ...rest, choice_register: register };
}
function rolesWith(register) {
  return roles.map(r => (r.id === ROLE_ID ? roleWith(register) : r));
}
function stateFrom(role) {
  const real = console.warn;
  console.warn = () => {};   // an unreviewed anchor warns; not what is under test here
  try { return buildInitialState(scenario, role, locations); } finally { console.warn = real; }
}
const compose = (state, playerRoles) =>
  composeTurnPrompt(state, 'wait', { scenario, characters, locations, clues: [], ...(playerRoles ? { playerRoles } : {}) });

const roleSection = p => p.slice(0, p.indexOf('Current game state:'));
const stateJson   = p => p.slice(p.indexOf('Current game state:'), p.indexOf('Current location:'));
const count       = (s, sub) => s.split(sub).length - 1;

// ── (1) backward-compatible ─────────────────────────────────────────────────
head('no register: byte-identical to the pre-field call shape');
{
  const state    = stateFrom(roleWith(undefined));
  const baseline = compose(state, undefined);   // no playerRoles at all: the old call shape
  for (const [label, reg] of [['absent', undefined], ['empty string', ''], ['whitespace only', '   \n ']]) {
    const p = compose(state, rolesWith(reg));
    check(`${label}: turn prompt byte-identical`, p === baseline);
    check(`${label}: no CHOICE REGISTER line`, !p.includes('CHOICE REGISTER'));
  }
}

// ── (2) one copy, in the role section ───────────────────────────────────────
head('register set: one line, in the role section, not in STATE_JSON');
{
  const role = roleWith(REGISTER);
  const p    = compose(stateFrom(role), rolesWith(REGISTER));
  check('CHOICE REGISTER line in the PLAYER ROLE section', roleSection(p).includes(`CHOICE REGISTER: ${REGISTER}`));
  check('register text appears exactly once in the whole prompt', count(p, REGISTER) === 1, `found ${count(p, REGISTER)}`);
  check('not in STATE_JSON', !stateJson(p).includes(REGISTER) && !stateJson(p).includes('choice_register'));
  // The turn template may carry CRLF endings, so the line may end \r\n; either is a trimmed register.
  check('register is trimmed', /CHOICE REGISTER: Choices of conviction[^\n]*tactics\.\r?\n/.test(
    compose(stateFrom(role), rolesWith(`  ${REGISTER}\n`))));
}

// ── (3) read fresh ──────────────────────────────────────────────────────────
head('read fresh: an in-flight session picks up an edited register');
{
  const state = stateFrom(roleWith(undefined));   // session started before any register existed
  check('buildInitialState carries no copy of the register',
    !JSON.stringify(stateFrom(roleWith(REGISTER))).includes(REGISTER));
  check('register set after /start reaches the next turn', compose(state, rolesWith(REGISTER)).includes(`CHOICE REGISTER: ${REGISTER}`));
  check('register edited mid-session: new text wins, old text gone', (() => {
    const p = compose(state, rolesWith('Edited register.'));
    return p.includes('CHOICE REGISTER: Edited register.') && !p.includes(REGISTER);
  })());
  check("another role's register never leaks in",
    !compose(state, roles.map(r => (r.id === ROLE_ID ? roleWith(undefined) : { ...r, choice_register: REGISTER }))).includes('CHOICE REGISTER'));
}

// ── the override the line exists for ────────────────────────────────────────
head('system prompt: RULE 8 defers to a CHOICE REGISTER');
{
  const sys = buildSystemPrompt(scenario, locations, characters);
  const r8  = sys.indexOf('## RULE 8');
  const cr  = sys.indexOf('### Choice register (overrides the escalation default):');
  check('override section present, after RULE 8', r8 >= 0 && cr > r8);
  check('override names CHOICE REGISTER and OVERRIDES', /CHOICE REGISTER[\s\S]{0,200}OVERRIDES the escalation rule/.test(sys.slice(cr)));
}

console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
process.exit(fails ? 1 : 0);
