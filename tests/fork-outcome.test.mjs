// FORK OUTCOME — the authored consequence of a fork option (options[].outcome), the opt-in clause
// ban on later choices, the excludes_in_choices filter, the recap word ceiling, and the admin
// keep-list for the new option keys. No API calls, no writes.
//
//   - a chosen option WITHOUT outcome / excludes_in_choices composes exactly HEAD's directive
//   - with outcome: the answer turn says THIS TURN — REQUIRED + the text; later turns say SETTLED
//   - the clause ban renders only for an opted-in chosen option
//   - the filter drops a not-chosen option's phrases (3 = three, case-insensitive, whole words)
//     and never derives phrases from labels
//   - recap: ≤130 untouched; over → one retry if shorter, then sentence trim ≤130

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

process.env.DEFINING_MOMENT_ENABLED = 'true';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;
const p        = (...s) => path.join(REPO_DIR, ...s);
const PC = await import(`${ROOT}/engine/services/PromptComposer.js`);
const GR = await import(`${ROOT}/engine/server/gameRouter.js`);
const AR = await import(`${ROOT}/engine/admin/adminRouter.js`);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

const SCEN = { id: 'x' };
const OUT_A = 'Beaumont grants it. The guns hold at the wire.';
const plain = () => ({ principal_transition: { type: 'decision_made', moment: 'm' }, options: [
  { id: 'fire', text: 'Fire lift three on the schedule.', label: 'Fire lift three on the schedule' },
  { id: 'susp', text: 'Request an emergency suspension through Captain Beaumont.', label: 'Request a suspension through Beaumont' },
  { id: 'hold', text: 'Hold the guns at the wire.', label: 'Hold the guns at the wire' },
] });
const authored = () => {
  const b = plain();
  b.options[0].outcome = 'The transition fires.';      b.options[0].excludes_in_choices = ['fire lift three', 'fire lift 3'];
  b.options[1].outcome = OUT_A;                         b.options[1].excludes_in_choices = ['emergency suspension', 'request a suspension'];
  b.options[2].outcome = 'You hold the guns.';         b.options[2].excludes_in_choices = ['hold the guns at the wire', 'hold lift three'];
  return b;
};
const st = (block, choice, turn, now) => ({ effectiveDefiningMoment: block, turnCount: now, decisions: { m: { option_id: choice, turn } } });

const headPath = p('engine/services/.__head_PromptComposer.outcome.test.js');
fs.writeFileSync(headPath, execFileSync('git', ['show', 'HEAD:engine/services/PromptComposer.js'], { cwd: REPO_DIR, encoding: 'utf8', maxBuffer: 64e6 }));
try {
  const HEAD_PC = await import(pathToFileURL(headPath).href);

  head('1. no new fields → byte-identical to HEAD');
  for (const [c, t, n] of [['fire', 5, 5], ['susp', 5, 8], ['hold', 2, 9]]) {
    const s = st(plain(), c, t, n);
    check(`${c} turn ${n}: identical`, PC.buildDecisionHoldDirective(s, SCEN) === HEAD_PC.buildDecisionHoldDirective(s, SCEN));
  }
  // bare-string record (no turn) — also identical
  { const s = { effectiveDefiningMoment: plain(), decisions: { m: 'susp' } };
    check('bare-string record: identical', PC.buildDecisionHoldDirective(s, SCEN) === HEAD_PC.buildDecisionHoldDirective(s, SCEN)); }

  head('2. outcome: answer turn vs later turns');
  const ans   = PC.buildDecisionHoldDirective(st(authored(), 'susp', 7, 7), SCEN);
  const later = PC.buildDecisionHoldDirective(st(authored(), 'susp', 7, 9), SCEN);
  check('answer turn: REQUIRED header + text verbatim', ans.includes('⚑ WHAT YOUR CHOICE DOES (THIS TURN — REQUIRED)') && ans.includes('\n' + OUT_A + '\n'));
  check('answer turn: overrides NPC disposition', /no one present refuses it, delays it/.test(ans));
  check('answer turn: not the settled header', !ans.includes('SETTLED'));
  check('later turn: SETTLED header + text verbatim', later.includes('⚑ WHAT THE CHOICE DID (SETTLED — this has happened):') && later.includes('\n' + OUT_A + '\n'));
  check('later turn: nothing reverses it', later.includes('Nothing in this turn or any later turn reverses'));
  check('later turn: not the REQUIRED header', !later.includes('THIS TURN — REQUIRED'));
  check('only the chosen outcome appears', !ans.includes('The transition fires.') && !ans.includes('You hold the guns.'));
  check('order: DECISION MADE → outcome → CHOICES', ans.indexOf('DECISION MADE') < ans.indexOf('WHAT YOUR CHOICE DOES') && ans.indexOf('WHAT YOUR CHOICE DOES') < ans.indexOf('CHOICES:'));
  check('excludes phrases never rendered into the prompt', !ans.includes('fire lift 3') && !later.includes('hold lift three'));

  head('3. clause ban: opt-in only');
  check('authored: clause ban present', ans.includes('not as a second step') && ans.includes('"prepare to …"'));
  check('plain: clause ban absent', !PC.buildDecisionHoldDirective(st(plain(), 'susp', 7, 7), SCEN).includes('not as a second step'));
  { const b = plain(); b.options[1].excludes_in_choices = ['x y'];
    const d = PC.buildDecisionHoldDirective(st(b, 'susp', 7, 7), SCEN);
    check('excludes only (no outcome): clause ban, no outcome block', d.includes('not as a second step') && !d.includes('WHAT YOUR CHOICE')); }
  { const b = plain(); b.options[1].outcome = '   ';
    const s = st(b, 'susp', 7, 7);
    check('whitespace outcome = absent: identical to HEAD', PC.buildDecisionHoldDirective(s, SCEN) === HEAD_PC.buildDecisionHoldDirective(s, SCEN)); }
  { const b = plain(); b.options[0].outcome = 'x'; b.options[0].excludes_in_choices = ['fire lift three'];
    const s = st(b, 'susp', 7, 7);
    check('only a NOT-chosen option authored: directive identical to HEAD', PC.buildDecisionHoldDirective(s, SCEN) === HEAD_PC.buildDecisionHoldDirective(s, SCEN)); }

  head('4. excludes_in_choices filter');
  const ex = PC.forkChoiceExclusions(authored(), 'susp');
  check('exclusions = the not-chosen options\' phrases', JSON.stringify(ex) === JSON.stringify(['fire lift three', 'fire lift 3', 'hold the guns at the wire', 'hold lift three']));
  const choices = [
    'Wait for Beaumont\'s word, then fire Lift 3.',
    'Signal the battery: FIRE LIFT THREE!',
    'Send a runner to Hartney with the suspension.',
    'Watch the wire through the glass.',
    'Hold Lift Three until the observer speaks.',
    'Fire lift thirty rounds of smoke.',
  ];
  const r = PC.filterExcludedChoices(choices, ex);
  check('drops "fire Lift 3" (3 = three)', r.dropped.some(d => d.choice === choices[0]));
  check('drops case-insensitive', r.dropped.some(d => d.choice === choices[1]));
  check('drops "Hold Lift Three"', r.dropped.some(d => d.choice === choices[4]));
  check('keeps the clean ones', JSON.stringify(r.kept) === JSON.stringify([choices[2], choices[3], choices[5]]), JSON.stringify(r.kept));
  check('whole words: "thirty" is not "three"', r.kept.includes(choices[5]));
  check('plain block (no phrases): nothing to exclude', PC.forkChoiceExclusions(plain(), 'susp').length === 0);
  check('no decision: decidedChoiceExclusions = []', PC.decidedChoiceExclusions({ effectiveDefiningMoment: authored() }, SCEN).length === 0);
  check('decided: decidedChoiceExclusions = chosen-excluded phrases', PC.decidedChoiceExclusions(st(authored(), 'fire', 3, 4), SCEN).includes('emergency suspension'));
  check('normalize: punctuation + numbers', PC.normalizeChoiceText("Fire—Lift 3!") === ' fire lift three ');
} finally {
  fs.rmSync(headPath, { force: true });
}

head('5. recap ceiling');
{
  const sent = n => Array.from({ length: n }, (_, i) => `Word${i}`).join(' ');
  const short = sent(9) + '.';
  check('countWords', GR.countWords('  a b\nc ') === 3);
  check('≤150 unchanged, no retry', await GR.enforceRecapCeiling(sent(150), async () => { throw new Error('must not retry'); }) === sent(150));
  // 17 ten-word sentences = 170 words; the last one names the choice.
  const CHOICE = 'Then you held the guns at the wire and gave no order.';
  const body = Array.from({ length: 16 }, (_, i) => `S${i} ` + sent(9) + '.');
  const long = [...body, CHOICE.replace('.', ' now.')].join(' ');
  const choiceLast = long.split(/(?<=\.)\s/).pop();
  let asked = null;
  const viaRetry = await GR.enforceRecapCeiling(long, async w => { asked = w; return body.slice(0, 9).join(' ') + ' ' + choiceLast; });
  check('over: retry asked with the count', asked === GR.countWords(long), String(asked));
  check('over: shorter retry taken', GR.countWords(viaRetry) === 103, String(GR.countWords(viaRetry)));
  const trimmed = await GR.enforceRecapCeiling(long, async () => null);
  check('retry failed: ≤150 and the FINAL sentence (the choice) survives', GR.countWords(trimmed) <= 150 && trimmed.endsWith(choiceLast), String(GR.countWords(trimmed)));
  check('retry failed: the EARLIEST sentences are the ones dropped', !trimmed.startsWith('S0 ') && trimmed.includes('S15 '));
  const longer = await GR.enforceRecapCeiling(long, async () => long + ' ' + long);
  check('retry longer: ignored, original trimmed from the front', GR.countWords(longer) <= 150 && longer.endsWith(choiceLast));
  const paras = await GR.enforceRecapCeiling(body.slice(0, 10).join(' ') + '\n\n' + body.slice(10).join(' ') + ' ' + choiceLast, async () => null);
  check('paragraph break kept when the second paragraph survives', paras.includes('\n\n') ? paras.split('\n\n')[1].endsWith(choiceLast) : paras.endsWith(choiceLast));
  const runOn = sent(200);
  const ro = await GR.enforceRecapCeiling(runOn, async () => null);
  check('no sentence end: keeps the LAST 150 words, opens with an ellipsis', ro.startsWith('…') && ro.endsWith('Word199') && GR.countWords(ro) === 150);
  check('RECAP constants', GR.RECAP_WORDS_MIN === 60 && GR.RECAP_WORDS_TARGET === 110 && GR.RECAP_WORDS_CEILING === 150);
}

head('6. admin keep-list');
{
  const stored = authored(); stored.id = 'm';
  const sent = plain(); sent.id = 'm';
  sent.options[2].outcome = null;               // explicit null removes
  const repos = { scenarios: { findPlayerRole: () => ({ defining_moment: stored }) } };
  const role = AR.preserveStoredForkExtensions(repos, { id: 'r', defining_moment: sent });
  const o = role.defining_moment.options;
  check('absent outcome kept from stored', o[0].outcome === 'The transition fires.' && o[1].outcome === OUT_A);
  check('absent excludes_in_choices kept from stored', JSON.stringify(o[1].excludes_in_choices) === JSON.stringify(['emergency suspension', 'request a suspension']));
  check('explicit null removes', !('outcome' in o[2]));
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll fork-outcome assertions passed.');
process.exit(fails ? 1 : 0);
