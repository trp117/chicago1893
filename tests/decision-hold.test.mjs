// DECISION HOLD — once a defining-moment decision is recorded, every later turn prompt carries
// "⚑ DECISION MADE: The player chose: <chosen option text>" (buildDecisionHoldDirective), so the
// narration plays the choice the player made rather than drifting back to the role's lean.
//
// Gate: for EVERY stored role, a turn composed without a recorded decision (start of session,
// fork due, fork presented but unanswered, an unknown option id) is byte-identical to the
// committed (HEAD) PromptComposer; with a decision recorded, the prompt differs from HEAD's by
// exactly the directive, which names the chosen option's text and no other option's.
//
// No API calls, no writes outside a HEAD copy of PromptComposer written beside it and removed.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

process.env.DEFINING_MOMENT_ENABLED = 'true';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;
const p        = (...s) => path.join(REPO_DIR, ...s);

const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { CharacterRepository } = await import(`${ROOT}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { ClueRepository }      = await import(`${ROOT}/engine/repositories/ClueRepository.js`);
const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
const { buildInitialState, loadStoryArc, initSceneState } = await import(`${ROOT}/engine/services/StateManager.js`);
const PC = await import(`${ROOT}/engine/services/PromptComposer.js`);

const store = new JsonFileStore(p('engine/data'));
const repos = {
  characters: new CharacterRepository(store), locations: new LocationRepository(store),
  clues: new ClueRepository(store), scenarios: new ScenarioRepository(store), storyArcs: new StoryArcRepository(store),
};

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head  = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const quiet = fn => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; try { return fn(); } finally { console.warn = w; console.log = l; } };
const clone = o => JSON.parse(JSON.stringify(o));

const headPath = p('engine/services/.__head_PromptComposer.test.js');
fs.writeFileSync(headPath, execFileSync('git', ['show', 'HEAD:engine/services/PromptComposer.js'], { cwd: REPO_DIR, encoding: 'utf8', maxBuffer: 64e6 }));
try {
  const HEAD_PC = await import(pathToFileURL(headPath).href);

  // ── the directive alone ─────────────────────────────────────────────────────
  head('1. buildDecisionHoldDirective');
  const SCEN = { id: 'x' };
  const BLOCK = { principal_transition: { type: 'decision_made', moment: 'm' }, options: [{ id: 'a', text: '  Do A.  ' }, { id: 'b', text: 'Do B.' }] };
  const st = extra => ({ effectiveDefiningMoment: BLOCK, ...extra });
  check('no decision → \'\'', PC.buildDecisionHoldDirective(st({}), SCEN) === '');
  check('unknown option id → \'\'', PC.buildDecisionHoldDirective(st({ decisions: { m: { option_id: 'zzz' } } }), SCEN) === '');
  check('no fork at all → \'\'', PC.buildDecisionHoldDirective({}, SCEN) === '');
  check('option with no text → \'\'', PC.buildDecisionHoldDirective({ effectiveDefiningMoment: { ...BLOCK, options: [{ id: 'a' }] }, decisions: { m: 'a' } }, SCEN) === '');
  const d = PC.buildDecisionHoldDirective(st({ decisions: { m: { option_id: 'a' } } }), SCEN);
  const CHOICES_RULE = 'CHOICES: every choice you offer must be a way of carrying out this course or of facing what follows from it. Offer none that takes it back, reverses it, softens it, makes up for it, or does the other thing anyway — not partly, not in secret, not in a note, a draft or a margin, not "just this once", not later.';
  check('recorded → the chosen text (trimmed), the hold instruction, the choices rule and the course NOT chosen',
    d === '⚑ DECISION MADE: The player chose: Do A.\n'
      + 'Play the character as having chosen this — never narrate them acting against it, and do not offer choices that would undo it.\n'
      + 'This choice overrides the role description: where the role\'s stated duty, disposition or choice guidance assumes a different course, the course the player chose is the one this character now takes, in this turn\'s narration and every turn after.\n'
      + CHOICES_RULE + '\n'
      + 'The courses the player did NOT choose — offer no choice that leads toward any of them:\n'
      + '- Do B.', JSON.stringify(d));
  check('the string form of a recorded decision is read too', PC.buildDecisionHoldDirective(st({ decisions: { m: 'b' } }), SCEN).includes('The player chose: Do B.'));
  const LBL = { ...BLOCK, options: [{ id: 'a', label: 'A, short', text: 'Do A.' }, { id: 'b', label: '  B, short ', text: 'Do B.' }, { id: 'c', text: 'Do C.' }] };
  const dl = PC.buildDecisionHoldDirective({ effectiveDefiningMoment: LBL, decisions: { m: 'a' } }, SCEN);
  check('a course not chosen is named by its label (trimmed), or by its text when it has none; never the chosen one',
    dl.endsWith('offer no choice that leads toward any of them:\n- B, short\n- Do C.') && !dl.includes('- A, short') && !dl.includes('Do B.'), JSON.stringify(dl.slice(-120)));
  const d1 = PC.buildDecisionHoldDirective({ effectiveDefiningMoment: { ...BLOCK, options: [{ id: 'a', text: 'Do A.' }] }, decisions: { m: 'a' } }, SCEN);
  check('a single-option fork: the choices rule, and no empty NOT-chosen list', d1.endsWith(CHOICES_RULE) && !d1.includes('did NOT choose'));

  // ── every stored role, against HEAD ─────────────────────────────────────────
  head('2. every stored role — prompts vs the committed (HEAD) code');
  const roleFiles = fs.readdirSync(p('engine/data/scenarios/player_roles')).filter(f => f.endsWith('.json'));
  const ids = [...new Set(roleFiles.map(f => { try { return JSON.parse(fs.readFileSync(p('engine/data/scenarios/player_roles', f), 'utf8')).scenarioId; } catch { return null; } }).filter(Boolean))].sort();
  let roles = 0, forks = 0, decided = 0;
  const notIdentical = [], badDecided = [];
  for (const id of ids) {
    const scenario = await repos.scenarios.findById(id);
    if (!scenario) continue;
    const playerRoles = repos.scenarios.findPlayerRoles(id);
    const characters  = repos.characters.findAll().filter(c => (c.scenarioIds || []).includes(id));
    const locations   = repos.locations.findByScenario(id);
    const clues       = repos.clues.findByScenario(id);
    for (const role of playerRoles) {
      roles++;
      const base = quiet(() => buildInitialState(scenario, role, locations));
      const storyArc = quiet(() => loadStoryArc(repos, scenario, base));
      if (storyArc) quiet(() => initSceneState(base, storyArc));
      const gd = { scenario, characters, locations, clues, playerRoles, storyArc: storyArc ?? null };
      const both = state => [quiet(() => PC.composeTurnPrompt(clone(state), 'I look around.', gd)), quiet(() => HEAD_PC.composeTurnPrompt(clone(state), 'I look around.', gd))];

      // Undecided states: start; late (a clock fork is due); fork presented, unanswered.
      const late = { ...clone(base), elapsedMinutes: Math.round((scenario.sessionTargetMinutes || 30) * 0.9), remainingMinutes: Math.max(1, Math.round((scenario.sessionTargetMinutes || 30) * 0.1)) };
      const states = [['start', base], ['late', late], ['presented', { ...clone(late), definingMomentPresented: true }]];
      const block = role.defining_moment;
      const moment = block?.principal_transition?.moment;
      if (moment) states.push(['unknown option', { ...clone(late), definingMomentPresented: true, decisions: { [moment]: { option_id: '__not_an_option__' } } }]);
      for (const [label, s] of states) {
        const [now, was] = both(s);
        if (now !== was || now.includes('DECISION MADE')) notIdentical.push(`${id}/${role.id} (${label})`);
      }

      // Decided: each option in turn.
      if (!moment || !Array.isArray(block.options) || block.principal_transition.type !== 'decision_made') continue;
      forks++;
      for (const opt of block.options) {
        if (!opt?.id || typeof opt.text !== 'string') continue;
        decided++;
        const s = { ...clone(late), definingMomentPresented: true, decisions: { [moment]: { option_id: opt.id, turn: 9, elapsed: 20 } } };
        const [now, was] = both(s);
        // HEAD already carries a (shorter) directive: the prompt must be HEAD with exactly that
        // directive swapped for the current one, and nothing else moved.
        const directive = PC.buildDecisionHoldDirective(s, scenario);
        const headDir   = HEAD_PC.buildDecisionHoldDirective(s, scenario);
        const others = block.options.filter(o => o !== opt && typeof o?.text === 'string' && o.text.trim());
        const outside = now.replace(directive, '');
        const ok = directive.startsWith(`⚑ DECISION MADE: The player chose: ${opt.text.trim()}\n`)
          && now.split(directive).length === 2 && now === (headDir ? was.replace(headDir, directive) : was)
          && directive.includes('CHOICES: every choice you offer')
          // the courses not taken appear only in the directive's NOT-chosen list
          && others.every(o => directive.includes(`\n- ${(typeof o.label === 'string' && o.label.trim()) || o.text.trim()}`))
          && !others.some(o => outside.includes(o.text.trim()));
        if (!ok) badDecided.push(`${id}/${role.id}:${opt.id}`);
      }
    }
  }
  check(`undecided turns are byte-identical to HEAD and carry no directive (${roles} stored roles × start/late/presented[/unknown])`, roles > 0 && notIdentical.length === 0, notIdentical.slice(0, 8).join(', '));
  check(`decided turns = HEAD with its directive swapped for the current one; the courses not taken appear only in its NOT-chosen list (${forks} forks, ${decided} options)`, forks > 0 && badDecided.length === 0, badDecided.slice(0, 8).join(', '));

  // ── Manchon, in his scene ───────────────────────────────────────────────────
  head('3. Manchon, compliance, in scene_28_may');
  const JOAN = await repos.scenarios.findById('joan_trial_rouen_1431');
  const MANCHON = repos.scenarios.findPlayerRole('role_manchon');
  if (!JOAN || !MANCHON?.defining_moment) {
    console.log('SKIP  Manchon checks — needs restored Joan data.');
  } else {
    const locs = repos.locations.findByScenario(JOAN.id);
    const s = quiet(() => buildInitialState(JOAN, MANCHON, locs));
    const arc = quiet(() => loadStoryArc(repos, JOAN, s));
    quiet(() => initSceneState(s, arc));
    Object.assign(s, { currentSceneId: 'scene_28_may', elapsedMinutes: 28, remainingMinutes: 2, definingMomentPresented: true,
      decisions: { manchon_witnessing_choice: { option_id: 'record_as_required', turn: 13, elapsed: 28 } } });
    const gd = { scenario: JOAN, characters: repos.characters.findAll().filter(c => (c.scenarioIds || []).includes(JOAN.id)), locations: locs, clues: repos.clues.findByScenario(JOAN.id), playerRoles: repos.scenarios.findPlayerRoles(JOAN.id), storyArc: arc };
    const prompt = quiet(() => PC.composeTurnPrompt(s, 'I dip the quill.', gd));
    const COMP = MANCHON.defining_moment.options.find(o => o.id === 'record_as_required');
    check('the compliance text is in the turn prompt as the decision made', prompt.includes(`⚑ DECISION MADE: The player chose: ${COMP.text}`));
    check('...with the hold instruction', prompt.includes('never narrate them acting against it, and do not offer choices that would undo it.'));
    check('...and the fork instruction is gone (no re-asking)', !prompt.includes('DEFINING MOMENT (THIS TURN)'));
    const FINAL = { ...clone(s), remainingMinutes: 0, elapsedMinutes: 30 };
    check('the final turn carries it too (alongside FINAL TURN)', quiet(() => PC.composeTurnPrompt(FINAL, 'I sand the ink.', gd)).includes(`The player chose: ${COMP.text}`));
  }
} finally {
  fs.rmSync(headPath, { force: true });
}
check('HEAD copy removed', !fs.existsSync(headPath));

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll decision-hold assertions passed.');
process.exit(fails ? 1 : 0);
