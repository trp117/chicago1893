// CHOICE REGISTER — the authored steer on what KIND of choices a role is offered, and the
// generate-review-approve component that drafts it.
//
//   (1) BACKWARD-COMPATIBLE. A role with no register, a blank one, or an UNREVIEWED one
//       composes a turn prompt byte-identical to the call shape that existed before the
//       field did. Drafts are inert.
//
//   (2) REVIEWED STEERS, ONE COPY, IN THE ROLE SECTION. choice_register_reviewed === true
//       and non-blank text: exactly one CHOICE REGISTER line, in the PLAYER ROLE section,
//       never in STATE_JSON.
//
//   (3) READ FRESH. Read from the role record each turn, never copied onto state, so an
//       approval or an edit reaches a session already in flight.
//
//   (4) THE EDITOR-SAVE GUARD restores the keys a stale tab omits and honors a clear.
//
//   (5) THE PROPOSER never drafts over — and the write route never writes over — approved
//       or hand-authored text; its prompt carries the role and never the fork's options.
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
const {
  preserveStoredChoiceRegister, preserveStoredRoleBlocks,
  choiceRegisterSkip, choiceRegisterWriteRefusal,
  buildChoiceRegisterUserPrompt, validateChoiceRegisterProposal, CHOICE_REGISTER_SYSTEM_PROMPT,
  proposeChoiceRegister,
} = await import(`${ROOT}/engine/admin/adminRouter.js`);

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

// The stored role with its register keys replaced in memory. `undefined` text removes all
// three keys; `flags` sets choice_register_reviewed / choice_register_generated.
const REVIEWED = { choice_register_reviewed: true };
function roleWith(register, flags = {}) {
  const { choice_register, choice_register_reviewed, choice_register_generated, ...rest } = stored;
  return register === undefined ? rest : { ...rest, choice_register: register, ...flags };
}
function rolesWith(register, flags = {}) {
  return roles.map(r => (r.id === ROLE_ID ? roleWith(register, flags) : r));
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

// ── (1) backward-compatible; drafts inert ───────────────────────────────────
head('no register, blank, or unreviewed: byte-identical to the pre-field call shape');
{
  const state    = stateFrom(roleWith(undefined));
  const baseline = compose(state, undefined);   // no playerRoles at all: the old call shape
  for (const [label, reg, flags] of [
    ['absent',                                   undefined, {}],
    ['empty string',                             '',        REVIEWED],
    ['whitespace only, reviewed',                '   \n ',  REVIEWED],
    ['text, no reviewed flag (pre-gate register)', REGISTER, {}],
    ['text, reviewed:false',                     REGISTER,  { choice_register_reviewed: false }],
    ['generated draft, reviewed:false',          REGISTER,  { choice_register_reviewed: false, choice_register_generated: true }],
    ['reviewed:"true" (a string is not approval)', REGISTER, { choice_register_reviewed: 'true' }],
  ]) {
    const p = compose(state, rolesWith(reg, flags));
    check(`${label}: turn prompt byte-identical`, p === baseline);
    check(`${label}: no CHOICE REGISTER line`, !p.includes('CHOICE REGISTER'));
  }
}

// ── (2) reviewed steers: one line, in the role section ──────────────────────
head("reviewed register (Joan's case): one line, in the role section, not in STATE_JSON");
{
  const role = roleWith(REGISTER, REVIEWED);
  const p    = compose(stateFrom(role), rolesWith(REGISTER, REVIEWED));
  check('CHOICE REGISTER line in the PLAYER ROLE section', roleSection(p).includes(`CHOICE REGISTER: ${REGISTER}`));
  check('register text appears exactly once in the whole prompt', count(p, REGISTER) === 1, `found ${count(p, REGISTER)}`);
  check('not in STATE_JSON', !stateJson(p).includes(REGISTER) && !stateJson(p).includes('choice_register'));
  // The turn template may carry CRLF endings, so the line may end \r\n; either is a trimmed register.
  check('register is trimmed', /CHOICE REGISTER: Choices of conviction[^\n]*tactics\.\r?\n/.test(
    compose(stateFrom(role), rolesWith(`  ${REGISTER}\n`, REVIEWED))));
  check('a reviewed GENERATED register steers the same as a hand-authored one',
    compose(stateFrom(role), rolesWith(REGISTER, { ...REVIEWED, choice_register_generated: true })) === p);
}

// ── (3) read fresh ──────────────────────────────────────────────────────────
head('read fresh: an in-flight session picks up an approval or an edit');
{
  const state = stateFrom(roleWith(undefined));   // session started before any register existed
  check('buildInitialState carries no copy of the register',
    !JSON.stringify(stateFrom(roleWith(REGISTER, REVIEWED))).includes(REGISTER));
  check('draft approved after /start steers the next turn', (() => {
    const before = compose(state, rolesWith(REGISTER, { choice_register_reviewed: false }));
    const after  = compose(state, rolesWith(REGISTER, REVIEWED));
    return !before.includes('CHOICE REGISTER') && after.includes(`CHOICE REGISTER: ${REGISTER}`);
  })());
  check('register edited mid-session: new text wins, old text gone', (() => {
    const p = compose(state, rolesWith('Edited register.', REVIEWED));
    return p.includes('CHOICE REGISTER: Edited register.') && !p.includes(REGISTER);
  })());
  check("another role's reviewed register never leaks in",
    !compose(state, roles.map(r => (r.id === ROLE_ID ? roleWith(undefined)
      : { ...r, choice_register: REGISTER, choice_register_reviewed: true }))).includes('CHOICE REGISTER'));
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

// ── (4) the editor-save guard ───────────────────────────────────────────────
head('editor-save guard: restores what a stale tab omits, honors a clear');
{
  const storedRole = { id: 'r1', name: 'R', choice_register: REGISTER, choice_register_reviewed: true, choice_register_generated: true };
  const fakeRepos  = { scenarios: { findPlayerRole: () => storedRole } };
  const guard = incoming => preserveStoredChoiceRegister(fakeRepos, { id: 'r1', name: 'R', ...incoming });

  const stale = guard({});
  check('stale tab (no keys): all three restored', stale.choice_register === REGISTER
    && stale.choice_register_reviewed === true && stale.choice_register_generated === true);
  const noFlag = guard({ choice_register: REGISTER });
  check('tab that predates the flag: approval restored, not dropped', noFlag.choice_register_reviewed === true);
  const untick = guard({ choice_register: REGISTER, choice_register_reviewed: false });
  check('current tab unticks Reviewed: honored', untick.choice_register_reviewed === false);
  const edited = guard({ choice_register: 'New text.', choice_register_reviewed: true });
  check('current tab edits text: honored, provenance carried', edited.choice_register === 'New text.' && edited.choice_register_generated === true);
  const cleared = guard({ choice_register: '   ', choice_register_reviewed: true });
  check('blank register clears all three keys (no husk)', !('choice_register' in cleared)
    && !('choice_register_reviewed' in cleared) && !('choice_register_generated' in cleared));
  check('string "true" from a select is stored as boolean', guard({ choice_register: REGISTER, choice_register_reviewed: 'true' }).choice_register_reviewed === true);
  check('string "false" from a select is stored as boolean', guard({ choice_register: REGISTER, choice_register_reviewed: 'false' }).choice_register_reviewed === false);
  const noStored = preserveStoredChoiceRegister({ scenarios: { findPlayerRole: () => null } }, { id: 'x' });
  check('role with no register anywhere: nothing added', !Object.keys(noStored).some(k => k.startsWith('choice_register')));
  check('guard is in the chain both editor saves run', preserveStoredRoleBlocks(fakeRepos, { id: 'r1', name: 'R' }).choice_register_reviewed === true);
}

// ── (5) the proposer's rules ────────────────────────────────────────────────
head('proposer: never drafts over, never writes over, approved or hand-authored text');
{
  const cases = [
    ['blank role',                          {},                                                                                          false],
    ['whitespace register',                 { choice_register: '  ' },                                                                  false],
    ['unreviewed machine draft',            { choice_register: REGISTER, choice_register_generated: true, choice_register_reviewed: false }, false],
    ['hand-authored, unreviewed (Joan now)', { choice_register: REGISTER },                                                               true],
    ['approved',                            { choice_register: REGISTER, choice_register_reviewed: true },                               true],
    ['approved machine draft',              { choice_register: REGISTER, choice_register_generated: true, choice_register_reviewed: true },  true],
  ];
  for (const [label, fields, protectedText] of cases) {
    const role = { id: 'r1', name: 'R', ...fields };
    check(`${label}: ${protectedText ? 'skipped by proposer' : 'proposable'}`, !!choiceRegisterSkip(role) === protectedText);
    check(`${label}: ${protectedText ? 'write refused (409)' : 'write allowed'}`, !!choiceRegisterWriteRefusal(role) === protectedText);
  }
  const skip = choiceRegisterSkip({ id: 'r1', choice_register: ` ${REGISTER} ` });
  check('skip carries the protected text for the panel', skip?.existing?.choice_register === REGISTER && skip.existing.reviewed === false);
}

head('proposer prompt: the role in, the fork options out');
{
  const character = characters.find(c => c.id === stored.character_id) || null;
  const user = buildChoiceRegisterUserPrompt({ scenario, role: stored, character });
  check('names the role', user.includes(stored.name));
  check('carries the scenario title', user.includes(scenario.title));
  check('carries the dilemma setup', user.includes(stored.defining_moment.setup.trim().slice(0, 60)));
  check('never carries a defining-moment option',
    (stored.defining_moment.options || []).every(o => !user.includes(o.text)));
  check('conduct bounds included for a real person with bounds',
    !(character?.character_type === 'real' && character?.conduct_bounds) || user.includes('CONDUCT BOUNDS'));
  const sys = CHOICE_REGISTER_SYSTEM_PROMPT;
  check('system prompt: posture from the situation, not the person',
    sys.includes('POSTURE COMES FROM THE SITUATION, NOT THE PERSON') && sys.includes('ESCALATION IS SOMETIMES CORRECT'));
  check('system prompt asks for the axis, OFFER, AVOID and BOLDNESS',
    ['THE AXIS', 'OFFER', 'AVOID', 'BOLDNESS'].every(k => sys.includes(k)));
  check('system prompt asks for evidence, counter-case and confidence',
    ['CITE EVIDENCE', 'STATE THE COUNTER-CASE', 'CONFIDENCE'].every(k => sys.includes(k)));
  check('system prompt JSON carries all six fields',
    ['"posture"', '"confidence"', '"choice_register"', '"rationale"', '"counter_case"', '"evidence"'].every(k => sys.includes(k)));
  check('neutral example: no Joan, no real trial', !/Joan|voices|canon law|Cauchon/i.test(sys));
  check('forbids naming the dilemma answer, even as boldness', sys.includes('Never say which way this person decides at the dilemma'));
}

head('proposal validator: the full classifier shape is required');
{
  const good = { posture: 'conviction', confidence: 'medium', choice_register: 'x'.repeat(200),
    rationale: 'why', counter_case: 'what was ruled out', evidence: ['briefing line'] };
  check('complete proposal passes', validateChoiceRegisterProposal(good).length === 0);
  for (const [label, patch] of [
    ['missing register',     { choice_register: undefined }],
    ['too-short register',   { choice_register: 'Be moral.' }],
    ['too-long register',    { choice_register: 'x'.repeat(2500) }],
    ['missing posture',      { posture: '' }],
    ['confidence not in set', { confidence: 'certain' }],
    ['empty rationale',      { rationale: ' ' }],
    ['missing counter-case', { counter_case: undefined }],
    ['empty evidence',       { evidence: [] }],
    ['evidence not a list',  { evidence: 'briefing' }],
  ]) check(`${label} fails`, validateChoiceRegisterProposal({ ...good, ...patch }).length > 0);
  check('non-object fails', validateChoiceRegisterProposal('text').length > 0);
}

// ── the proposal's shape, end to end, with the model scripted ───────────────
// proposeChoiceRegister resolves `fetch` from the global scope at call time (as
// degradation.test relies on), so a canned api.anthropic.com reply exercises the real parse,
// validate and return path with no network call.
head('proposeChoiceRegister: returns the full classifier shape (scripted model)');
{
  const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
  const realFetch = globalThis.fetch;
  let reply = null, sent = null;
  globalThis.fetch = async (url, opts) => {
    const u = typeof url === 'string' ? url : url?.url;
    if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
    sent = JSON.parse(opts.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: reply }], stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const character = characters.find(c => c.id === stored.character_id) || null;
  try {
    reply = '```json\n' + JSON.stringify({
      posture: 'Conviction', confidence: 'high', choice_register: REGISTER.repeat(3),
      rationale: 'The scenario is a trial.', counter_case: 'A non-expert might offer legal fencing.',
      evidence: ['briefing: the chapel is cold', ''],
    }) + '\n```';
    const role = { ...stored, choice_register: 'Hand text.', choice_register_reviewed: true };
    const p = await proposeChoiceRegister(scenario, role, character, 'test-key');
    check('returns register, posture, confidence, rationale, counter-case, evidence',
      p.proposed === true && p.choice_register === REGISTER.repeat(3) && p.posture === 'conviction'
      && p.confidence === 'high' && p.rationale && p.counter_case && p.evidence.length === 1,
      JSON.stringify({ posture: p.posture, evidence: p.evidence }));
    check('carries the existing register for comparison, never overwriting it',
      p.existing?.choice_register === 'Hand text.' && p.existing.reviewed === true && role.choice_register === 'Hand text.');
    check('sent the classifier-shape system prompt', sent?.system === CHOICE_REGISTER_SYSTEM_PROMPT);
    check('sent this role in the user prompt', sent?.messages?.[0]?.content?.includes(stored.name));

    reply = JSON.stringify({ choice_register: REGISTER.repeat(3), rationale: 'bare text, no reasoning' });
    let threw = null;
    try { await proposeChoiceRegister(scenario, stored, character, 'test-key'); } catch (err) { threw = err.message; }
    check('a proposal without the reasoning fields is refused, not returned', /malformed/.test(threw || ''), threw || 'did not throw');
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
process.exit(fails ? 1 : 0);
