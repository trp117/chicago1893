// FORK BRANCH FLAG + DEBRIEF VARIANTS — a fork whose debrief depends on something the player did
// or did not bring about (Cantigny: whether Hartney's correction reached the dugout).
//
//   block.branch_flag            { flag, set_when, narrate_if_true, narrate_if_false }
//                                before the fork: a directive to emit the flag the turn set_when
//                                happens; on the fork turn: the ENGINE picks the branch to narrate
//   state.forkFlags              the flags the block reads, frozen when the fork is put
//   decisions[m].flags           …copied onto the decision record, so a later flag change
//                                cannot move the debrief
//   options[].debrief_variants   [{ when: { flag, equals }, debrief }], the plain debrief the fallback
//   admin save                   a stale tab posting the block without these keys keeps them
//
// Gate: a block with none of these keys composes byte-identical prompts (every stored role is
// checked against HEAD in decision-hold / storybound) and records an unchanged decision.
//
// No API calls, no writes.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

process.env.DEFINING_MOMENT_ENABLED = 'true';
process.env.SUPABASE_URL         ||= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_KEY ||= 'test-not-a-key';
process.env.SUPABASE_ANON_KEY    ||= 'test-not-a-key';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;
const p        = (...s) => path.join(REPO_DIR, ...s);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head  = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const quiet = async fn => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const clone = o => JSON.parse(JSON.stringify(o));

const PC = await import(`${ROOT}/engine/services/PromptComposer.js`);
const { recordDefiningDecision, buildInitialState, loadStoryArc, initSceneState } = await import(`${ROOT}/engine/services/StateManager.js`);
const AR = await quiet(() => import(`${ROOT}/engine/admin/adminRouter.js`));
const { lintCrucibleBlock } = await import(`${ROOT}/engine/services/CrucibleLint.js`);

const F = 'correctionReceived';
const BRANCH = { flag: F, set_when: 'the correction reaches the dugout', narrate_if_true: 'TRUE BRANCH: the correction is in hand.', narrate_if_false: 'FALSE BRANCH: the line stays dead.' };
const BLOCK = {
  id: 'm', setup: 'Lift three is at hand.', reviewed: true, fires_live: true, at_elapsed_fraction: 0.5,
  principal_transition: { type: 'decision_made', moment: 'm' },
  branch_flag: BRANCH,
  options: [
    { id: 'fire', text: 'Fire.', debrief: 'BLIND fire.', debrief_variants: [{ when: { flag: F, equals: true }, debrief: '  CORRECTED fire.  ' }] },
    { id: 'hold', text: 'Hold.', debrief: 'BLIND hold.' },
    { id: 'ask',  text: 'Ask.',  debrief: 'BLIND ask.',  debrief_variants: [{ when: { flag: F }, debrief: 'malformed — no equals' }, { when: { flag: F, equals: false }, debrief: 'NOT-CORRECTED ask.' }] },
  ],
};
const SCEN = { id: 's', sessionTargetMinutes: 30 };
const met = id => ({ met: true, decision: id });
const st  = extra => ({ effectiveDefiningMoment: BLOCK, flags: {}, decisions: {}, elapsedMinutes: 2, remainingMinutes: 28, ...extra });

// ── 1. Debrief variants ─────────────────────────────────────────────────────────
head('1. authoredForkDebrief — variant on the FROZEN flag, plain debrief the fallback');
check('frozen true on the decision → the variant, trimmed',
  PC.authoredForkDebrief(BLOCK, met('fire'), st({ decisions: { m: { option_id: 'fire', flags: { [F]: true } } } })) === 'CORRECTED fire.');
check('frozen false beats a live true → the plain (blind) debrief',
  PC.authoredForkDebrief(BLOCK, met('fire'), st({ flags: { [F]: true }, decisions: { m: { option_id: 'fire', flags: { [F]: false } } } })) === 'BLIND fire.');
check('no decision record yet: state.forkFlags is read',
  PC.authoredForkDebrief(BLOCK, met('fire'), st({ forkFlags: { [F]: true } })) === 'CORRECTED fire.');
check('nothing frozen (an old session): the live flag',
  PC.authoredForkDebrief(BLOCK, met('fire'), st({ flags: { [F]: true } })) === 'CORRECTED fire.');
check('no state passed → the plain debrief (the old call shape)',
  PC.authoredForkDebrief(BLOCK, met('fire')) === 'BLIND fire.');
check('option with no variants → its plain debrief, whatever the flag',
  PC.authoredForkDebrief(BLOCK, met('hold'), st({ decisions: { m: { option_id: 'hold', flags: { [F]: true } } } })) === 'BLIND hold.');
check('a malformed variant is skipped; equals:false matches a false flag',
  PC.authoredForkDebrief(BLOCK, met('ask'), st({ decisions: { m: { option_id: 'ask', flags: { [F]: false } } } })) === 'NOT-CORRECTED ask.');
check('…and on a true flag nothing matches → plain',
  PC.authoredForkDebrief(BLOCK, met('ask'), st({ decisions: { m: { option_id: 'ask', flags: { [F]: true } } } })) === 'BLIND ask.');
check('no decision → null, as before', PC.authoredForkDebrief(BLOCK, { met: false }, st({})) === null);

// ── 2. Freeze ───────────────────────────────────────────────────────────────────
head('2. forkBranchSnapshot / recordDefiningDecision — the value is frozen with the decision');
check('frozen names: the branch flag (once) plus every variant flag', JSON.stringify(PC.forkFrozenFlagNames(BLOCK)) === JSON.stringify([F]));
check('snapshot reads the flag as a strict boolean', JSON.stringify(PC.forkBranchSnapshot({ flags: { [F]: 'yes' } }, BLOCK)) === JSON.stringify({ [F]: false })
  && JSON.stringify(PC.forkBranchSnapshot({ flags: { [F]: true } }, BLOCK)) === JSON.stringify({ [F]: true }));
const PLAIN = { ...clone(BLOCK), branch_flag: undefined, options: BLOCK.options.map(({ debrief_variants, ...o }) => o) };
delete PLAIN.branch_flag;
check('a block that reads no flag → null (nothing written to state)', PC.forkBranchSnapshot({ flags: { [F]: true } }, PLAIN) === null);
{
  const s = st({ definingMomentPresented: true, forkFlags: { [F]: true }, flags: { [F]: false }, turnCount: 7, elapsedMinutes: 20, reachedBeats: ['a'] });
  await quiet(() => recordDefiningDecision(s, SCEN, { definingChoiceId: 'fire' }));
  check('the decision record carries the frozen flags', JSON.stringify(s.decisions.m) === JSON.stringify({ option_id: 'fire', turn: 7, elapsed: 20, beats_before: 1, flags: { [F]: true } }), JSON.stringify(s.decisions.m));
  s.forkFlags[F] = false; s.flags[F] = true;
  check('…as a copy: later changes to forkFlags or flags do not move the debrief', PC.authoredForkDebrief(BLOCK, met('fire'), s) === 'CORRECTED fire.');
  const s2 = { effectiveDefiningMoment: PLAIN, definingMomentPresented: true, decisions: {}, turnCount: 7, elapsedMinutes: 20 };
  await quiet(() => recordDefiningDecision(s2, SCEN, { definingChoiceId: 'fire' }));
  check('a fork with no forkFlags records exactly the old shape', JSON.stringify(s2.decisions.m) === JSON.stringify({ option_id: 'fire', turn: 7, elapsed: 20, beats_before: 0 }));
}

// ── 3. Prompt directives ────────────────────────────────────────────────────────
head('3. buildForkBranchFlagDirective / buildDefiningMomentInstruction');
const dir = PC.buildForkBranchFlagDirective(st({}), SCEN);
check('before the fork: a directive to emit the flag the turn set_when happens',
  dir.startsWith('⚑ STORY FLAG: The turn the correction reaches the dugout, you MUST emit stateChanges: { flags: { "correctionReceived": true } }') && dir.includes('not when it is attempted'), dir);
check('flag already true → no directive', PC.buildForkBranchFlagDirective(st({ flags: { [F]: true } }), SCEN) === '');
check('fork due → no directive (the value is being frozen)', PC.buildForkBranchFlagDirective(st({ elapsedMinutes: 20, remainingMinutes: 10 }), SCEN) === '');
check('fork presented → no directive', PC.buildForkBranchFlagDirective(st({ definingMomentPresented: true }), SCEN) === '');
check('decision recorded → no directive', PC.buildForkBranchFlagDirective(st({ decisions: { m: 'fire' } }), SCEN) === '');
check('unarmed fork → no directive', PC.buildForkBranchFlagDirective(st({ effectiveDefiningMoment: { ...BLOCK, fires_live: false } }), SCEN) === '');
check('no branch_flag → no directive', PC.buildForkBranchFlagDirective(st({ effectiveDefiningMoment: PLAIN }), SCEN) === '');
const due = extra => st({ elapsedMinutes: 20, remainingMinutes: 10, ...extra });
const instT = PC.buildDefiningMomentInstruction(due({ flags: { [F]: true } }), SCEN);
const instF = PC.buildDefiningMomentInstruction(due({}), SCEN);
check('fork turn, flag true → the TRUE branch, settled, and not the false one',
  instT.includes('WHAT HAS HAPPENED (engine state, settled') && instT.includes(BRANCH.narrate_if_true) && !instT.includes(BRANCH.narrate_if_false));
check('fork turn, flag false → the FALSE branch only', instF.includes(BRANCH.narrate_if_false) && !instF.includes(BRANCH.narrate_if_true));
const instPlain = PC.buildDefiningMomentInstruction(due({ effectiveDefiningMoment: PLAIN }), SCEN);
check('no branch_flag → no branch line', !instPlain.includes('WHAT HAS HAPPENED'));
check('the branch the turn narrates is the one frozen at presentation (same snapshot)',
  PC.forkBranchSnapshot(due({ flags: { [F]: true } }), BLOCK)[F] === true && instT.includes(BRANCH.narrate_if_true));

// ── 4. A real composed turn (Cantigny's artillery role, branch keys added) ────
head('4. composeTurnPrompt — stored Cantigny role with the branch keys');
{
  const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
  const { CharacterRepository } = await import(`${ROOT}/engine/repositories/CharacterRepository.js`);
  const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
  const { ClueRepository }      = await import(`${ROOT}/engine/repositories/ClueRepository.js`);
  const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
  const { StoryArcRepository }  = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
  const store = new JsonFileStore(p('engine/data'));
  const repos = { characters: new CharacterRepository(store), locations: new LocationRepository(store), clues: new ClueRepository(store), scenarios: new ScenarioRepository(store), storyArcs: new StoryArcRepository(store) };
  const role = repos.scenarios.findPlayerRole?.('role_artillery_commander');
  if (!role?.defining_moment) {
    console.log('SKIP  Cantigny artillery role not on local disk');
  } else {
    const scenario = await repos.scenarios.findById(role.scenarioId);
    const r = clone(role);
    r.defining_moment.branch_flag = { flag: 'hartneysCorrectionReceived', set_when: "Hartney's correction reaches the dugout", narrate_if_true: 'CORRECTION IN HAND.', narrate_if_false: 'LINE STAYS DEAD.' };
    const locations = repos.locations.findByScenario(scenario.id);
    const gd = { scenario, characters: repos.characters.findAll().filter(c => (c.scenarioIds || []).includes(scenario.id)), locations, clues: repos.clues.findByScenario(scenario.id), playerRoles: [r] };
    const base = await quiet(() => buildInitialState(scenario, r, locations));
    const storyArc = await quiet(() => loadStoryArc(repos, scenario, base));
    if (storyArc) await quiet(() => initSceneState(base, storyArc));
    const compose = s => PC.composeTurnPrompt(clone(s), 'I check the line.', { ...gd, storyArc: storyArc ?? null });
    const start = await quiet(() => compose(base));
    check('turn 1 carries the ⚑ STORY FLAG directive for hartneysCorrectionReceived', start.includes('⚑ STORY FLAG: The turn Hartney\'s correction reaches the dugout') && start.includes('"hartneysCorrectionReceived": true'));
    check('the role\'s flag is visible in the state JSON as before', start.includes('"hartneysCorrectionReceived":false'));
    const frozen = await quiet(() => compose({ ...clone(base), definingMomentPresented: true, forkFlags: { hartneysCorrectionReceived: true } }));
    check('forkFlags never reaches the model', !frozen.includes('forkFlags'));
    check('after the fork is put, no STORY FLAG directive', !frozen.includes('⚑ STORY FLAG'));
  }
}

// ── 5. Admin: save guard, structure, lint ───────────────────────────────────────
head('5. admin — stale-tab guard, structure checks, lint on variants');
{
  const stored = { id: 'role_x', defining_moment: clone({ ...BLOCK, debrief_with_recap: true }) };
  const repos = { scenarios: { findPlayerRole: id => (id === 'role_x' ? stored : null) } };
  const stale = { id: 'role_x', defining_moment: { ...clone(PLAIN), setup: 'edited setup' } };
  delete stale.defining_moment.debrief_with_recap;
  AR.preserveStoredForkExtensions(repos, stale);
  const dm = stale.defining_moment;
  check('a stale tab (keys absent) keeps branch_flag and debrief_with_recap', JSON.stringify(dm.branch_flag) === JSON.stringify(BRANCH) && dm.debrief_with_recap === true);
  check('…and each option\'s debrief_variants, matched by option id', JSON.stringify(dm.options[0].debrief_variants) === JSON.stringify(BLOCK.options[0].debrief_variants) && !('debrief_variants' in dm.options[1]));
  check('…as copies, not the stored objects', dm.branch_flag !== stored.defining_moment.branch_flag);
  check('…while the edit itself is kept', dm.setup === 'edited setup');
  const cleared = { id: 'role_x', defining_moment: { ...clone(BLOCK), branch_flag: null, debrief_with_recap: null, options: BLOCK.options.map(o => ({ ...clone(o), debrief_variants: null })) } };
  AR.preserveStoredForkExtensions(repos, cleared);
  check('an explicit null removes each key', !('branch_flag' in cleared.defining_moment) && !('debrief_with_recap' in cleared.defining_moment) && cleared.defining_moment.options.every(o => !('debrief_variants' in o)));
  const other = { id: 'role_x', defining_moment: { ...clone(PLAIN), id: 'other', principal_transition: { type: 'decision_made', moment: 'other' } } };
  AR.preserveStoredForkExtensions(repos, other);
  check('a different block id is a replacement — nothing carried over', !('branch_flag' in other.defining_moment));
  const router = fs.readFileSync(p('engine/admin/adminRouter.js'), 'utf8');
  check('the guard runs inside preserveStoredRoleBlocks (both role save paths)', /preserveStoredDefiningMoment\(shim, role\);\s*\n\s*preserveStoredForkExtensions\(shim, role\);/.test(router));

  const struct = b => AR.checkDefiningMoment({ id: 'role_x' }, b, { path: 'protagonist' }).errors.join(' | ');
  const good = { ...clone(BLOCK), options: BLOCK.options.map(o => ({ ...clone(o), debrief_variants: (o.debrief_variants || []).filter(v => typeof v.when.equals === 'boolean') })) };
  check('a well-formed block passes the structure check', struct(good) === '', struct(good));
  check('variant without equals → error', /variant 1: "when" must be/.test(struct(BLOCK)));
  check('variants without a plain debrief → error', /needs a plain "debrief" as the fallback/.test(struct({ ...clone(good), options: good.options.map((o, i) => (i === 0 ? { ...o, debrief: '' } : o)) })));
  check('branch_flag missing a field → error', /"branch_flag.set_when" is empty/.test(struct({ ...clone(good), branch_flag: { ...BRANCH, set_when: '' } })));
  check('debrief_with_recap not boolean → error', /"debrief_with_recap" must be true or false/.test(struct({ ...clone(good), debrief_with_recap: 'yes' })));

  const lint = lintCrucibleBlock({ ...clone(good), options: good.options.map((o, i) => (i === 0 ? { ...o, debrief_variants: [{ when: { flag: F, equals: true }, debrief: 'You pulled the lever and it was over.' }] } : o)) }, { path: 'protagonist', generated: false });
  check('variant debriefs get the prose rules (authoring term flagged, located on the variant)',
    lint.findings.some(f => f.rule === 'authoring_term' && f.location === 'option.fire.debrief_variants.0.debrief'), JSON.stringify(lint.findings.map(f => [f.rule, f.location])));
  const noVar = lintCrucibleBlock(clone(PLAIN), { path: 'protagonist', generated: false });
  check('a block with no variants lints exactly as before (no variant locations)', !noVar.findings.some(f => String(f.location).includes('debrief_variants')));
}

console.log(`\n${fails ? `FAILED — ${fails} assertion(s)` : 'ALL PASS'}`);
process.exit(fails ? 1 : 0);
