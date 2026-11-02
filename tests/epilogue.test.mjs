// EPILOGUE TRUNCATION — the Historical Record must never render a cut-off sentence.
//
// The Watergate/McCord play-test closed on a Historical Record ending "…at approximately 1":
// the record call ran out of tokens (max_tokens 400) and nothing looked at stop_reason. This
// drives the REAL generateEpilogueText against a scripted api.anthropic.com (the degradation.test
// technique: globalThis.fetch replaced for the duration), forcing stop_reason 'max_tokens', and
// asserts the retry, the trim, the logging, and the word budget that replaced the prompt's
// "100–150 words, but cover every character" conflict.
//
// No real API calls, no Supabase, no writes.

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

const { generateEpilogueText, trimToLastSentence, recordWordBudget, extractPlayerActions, beatsAfterChoice, choiceInputIndex } = await import(`${ROOT}/engine/server/gameRouter.js`);

head('trimToLastSentence');
check('the McCord cut: back to the last complete sentence', trimToLastSentence('James McCord was arrested inside the DNC offices. The officers entered Suite 600 at approximately 1') === 'James McCord was arrested inside the DNC offices.');
check('a time is not a boundary', trimToLastSentence('Wills called at 1:47 a.m. He logged') === 'Wills called at 1:47 a.m.');
check('a decimal is not a boundary', trimToLastSentence('It ran 3.5 hours. Then') === 'It ran 3.5 hours.');
check('closing quotes stay with their sentence', trimToLastSentence('He said "stop." Then the') === 'He said "stop."');
check('already complete text is unchanged', trimToLastSentence('One. Two!') === 'One. Two!');
check('no complete sentence → empty', trimToLastSentence('never finished') === '');

head('recordWordBudget — scaled, not in conflict with "cover every one"');
const b = n => { const r = recordWordBudget(n); return `${r.min}–${r.max}${r.capped ? ' capped' : ''}`; };
check('0 Layer-1 fates → exactly the old 100–150', b(0) === '100–150');
check('2 → 140–210', b(2) === '140–210');
check('6 → 220–330', b(6) === '220–330');
check('10 → capped at 330, floor kept 50 below', b(10) === '280–330 capped');

// ── A scripted Anthropic ───────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let script = {};
const calls = [];
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes('api.anthropic.com')) return realFetch(url, opts);
  const body  = JSON.parse(opts.body);
  const block = body.system.includes('"Historical Record"') ? 'record' : body.system.includes('"Your Session"') ? 'session' : 'other';
  calls.push({ block, max_tokens: body.max_tokens, system: body.system, content: body.messages?.[0]?.content });
  const next = (script[block] || []).shift() || { text: 'Fallback text.', stop: 'end_turn' };
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: next.text }], stop_reason: next.stop }) };
};

const CUT  = 'James McCord was arrested inside the DNC offices. Frank Wills logged the tape at 1:47 a.m. The officers entered Suite 600 at approximately 1';
const FULL = 'James McCord was arrested inside the DNC offices. Frank Wills logged the tape at 1:47 a.m. The officers entered Suite 600 at approximately 2:10 a.m.';
const fates = n => Array.from({ length: n }, (_, i) => ({ character_id: `c${i}`, name: `Figure ${i}`, classification: 'real', historical_record: `Figure ${i} was recorded.` }));
const epilogue = n => ({ character_fates: fates(n), immediate_outcome: { summary: 'Five men were arrested.' }, historical_frame: [] });
const summary  = n => ({ interacted_characters: fates(n).map(f => f.character_id), resolved_threads: [], completed_beats: [] });
const played   = { id: 'role_mccord', name: 'James McCord', character_type: 'real' };
const run = async (n = 2) => {
  calls.length = 0;
  const quietLog = console.log, quietWarn = console.warn; const logs = [];
  console.log = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' '));
  try { return { out: await generateEpilogueText(epilogue(n), summary(n), 'Closing prose.', 'test-key', null, [], false, played), logs }; }
  finally { console.log = quietLog; console.warn = quietWarn; }
};

head('record block — max_tokens then a clean retry');
script = { session: [{ text: 'You held the housing.', stop: 'end_turn' }], record: [{ text: CUT, stop: 'max_tokens' }, { text: FULL, stop: 'end_turn' }] };
{
  const { out, logs } = await run(2);
  const rec = calls.filter(c => c.block === 'record');
  check('the record call is retried once after max_tokens', rec.length === 2);
  check('first cap ≥ 800, the retry doubles it', rec[0].max_tokens >= 800 && rec[1].max_tokens === rec[0].max_tokens * 2, rec.map(c => c.max_tokens).join(' → '));
  check('the retry\'s complete text is what renders', out.record_block === FULL);
  check('stop_reason and length are logged for both blocks', logs.some(l => l.includes('[EPILOGUE] record block stop_reason=max_tokens')) && logs.some(l => l.includes('[EPILOGUE] session block stop_reason=end_turn')));
}

head('record block — cut on both attempts → trimmed, never mid-sentence');
script = { session: [{ text: 'You held the housing.', stop: 'end_turn' }], record: [{ text: CUT, stop: 'max_tokens' }, { text: CUT, stop: 'max_tokens' }] };
{
  const { out, logs } = await run(2);
  check('renders only complete sentences', out.record_block === 'James McCord was arrested inside the DNC offices. Frank Wills logged the tape at 1:47 a.m.', out.record_block);
  check('"approximately 1" never reaches the player', !out.record_block.includes('approximately 1'));
  check('the trim is logged', logs.some(l => l.includes('record block still at max_tokens — trimmed')));
}

head('session block — same guard');
script = { session: [{ text: 'You seated the screw. You closed the', stop: 'max_tokens' }, { text: 'You seated the screw. You closed the', stop: 'max_tokens' }], record: [{ text: FULL, stop: 'end_turn' }] };
{
  const { out } = await run(0);
  const ses = calls.filter(c => c.block === 'session');
  check('session call: 400, retried at 800', ses.map(c => c.max_tokens).join(',') === '400,800');
  check('session block trimmed to its last complete sentence', out.session_block === 'You seated the screw.');
}

head('the record prompt carries the scaled budget');
script = {};
{
  await run(0); const p0 = calls.find(c => c.block === 'record').system;
  await run(6); const p6 = calls.find(c => c.block === 'record').system;
  await run(10); const p10 = calls.find(c => c.block === 'record');
  check('no Layer-1 fates: "Length: 100–150 words." exactly as before', p0.includes('\nLength: 100–150 words.\n'));
  check('6 fates: "Length: 220–330 words."', p6.includes('\nLength: 220–330 words.\n'));
  check('10 fates: capped, with one-sentence-each guidance', p10.system.includes('Length: 280–330 words. That is tight for this many figures: give each Layer 1 figure one short sentence, and cover every one.'));
  check('max_tokens follows the budget (330 words → 825)', p10.max_tokens === 825);
  check('"cover every one. Do not omit any" is still in the prompt', p10.system.includes('Cover every one. Do not omit any.'));
}

// The session call with the post-fork beats (beatsAfterChoice) as the last argument.
const sessAfter = async (s, actions, after) => {
  calls.length = 0; script = {};
  const l = console.log, w = console.warn; console.log = console.warn = () => {};
  try { await generateEpilogueText(epilogue(1), { ...summary(1), ...s }, 'Closing prose.', 'test-key', null, [], false, played, null, actions, after); }
  finally { console.log = l; console.warn = w; }
  return calls.find(c => c.block === 'session');
};

head('session block — what the player did (flaw C: the crucible label wrote the whole session)');
{
  const T = '## Session\n\n**Player:** I call Martín up.\n\n> Act 1 · x\n\nHe comes.\n\n**Player:**   I tell him about the limp.  \n\nNarration **Player:** not a line.\n\n**Player:** \n';
  check('extractPlayerActions: the player lines, in order, trimmed; nothing else', JSON.stringify(extractPlayerActions(T)) === JSON.stringify(['I call Martín up.', 'I tell him about the limp.']));
  check('extractPlayerActions: no transcript → []', extractPlayerActions(undefined).length === 0);
  const many = Array.from({ length: 50 }, (_, i) => `**Player:** act ${i} ${'x'.repeat(i === 49 ? 500 : 0)}`).join('\n');
  const got  = extractPlayerActions(many);
  check('capped at the 40 most recent, long inputs cut', got.length === 40 && got[0] === 'act 10' && got[39].length === 401 && got[39].endsWith('…'));

  const DM = { closure_state: { defining_moment_state: { met: true, decision: 'hold', decision_text: 'Say nothing yet.' } } };
  const sess = async (s, actions) => {
    calls.length = 0; script = {};
    const l = console.log, w = console.warn; console.log = console.warn = () => {};
    try { await generateEpilogueText(epilogue(1), { ...summary(1), ...s }, 'Closing prose.', 'test-key', null, [], false, played, null, actions); }
    finally { console.log = l; console.warn = w; }
    return calls.find(c => c.block === 'session');
  };
  const none = await sess(DM), empty = await sess(DM, []);
  check('no actions → session prompt and content unchanged (no WHAT THE PLAYER DID)', none.system === empty.system && none.content === empty.content
    && !none.system.includes('WHAT THE PLAYER DID') && !none.content.includes('WHAT THE PLAYER DID') && none.system.includes('- Draw ONLY from the SESSION SUMMARY provided.'));
  const withA = await sess(DM, ['I call Martín up.', 'I tell him about the limp.']);
  check('actions → listed, in order, in the session content', withA.content.includes('WHAT THE PLAYER DID') && withA.content.includes('1. I call Martín up.\n2. I tell him about the limp.'));
  check('decision + actions → the full-arc rule', withA.system.includes('FOLLOW THE WHOLE ARC — THE CHOICE IS ITS CRUCIBLE, NOT ITS LAST WORD.') && withA.system.includes('FOLLOW WHAT THE PLAYER ACTUALLY DID.'));
  check('...and the choice is no longer "the last one", nor "how this session resolved"', !withA.system.includes('the last one') && !withA.system.includes('how this session resolved') && !withA.system.includes('THE CHOICE CLOSES THE SESSION'));
  check('the session block still gets no character ids', !withA.content.includes('"interacted_characters"') && !withA.content.includes('"c0"'));
  const noDm = await sess({}, ['I read.']);
  check('no decision + actions → follow rule, but no choice rule', noDm.system.includes('FOLLOW WHAT THE PLAYER ACTUALLY DID.') && !noDm.system.includes('FOLLOW THE WHOLE ARC') && !noDm.content.includes('THE DEFINING CHOICE'));
  check('the record call never receives the actions', !calls.find(c => c.block === 'record').content.includes('I read.'));
  check('no decision + afterChoice passed → no AFTER THE CHOICE section (decision sessions only)', !(await sessAfter({}, ['I read.'], ['Something happened.'])).content.includes('AFTER THE CHOICE'));
}

head('session block — the full arc (1 Nov Augustine: held back at the fork, then crossed)');
{
  // The 1 Nov run's own inputs, in order; the fork button sends the option text as the input.
  const CHOSEN = 'Let the weeping take you under the tree — but keep one handhold you cannot yet let go.';
  const INPUTS = ['Go into the garden — the room is too small for what is in it.', 'Call back to Alypius — ask him how he crossed it, the thing you cannot cross.',
    CHOSEN, 'Listen toward the wall — the child\'s voice is almost forming words.', 'Rise. The codex is where you left it.', 'Open it. Wherever it falls.', 'Show him the page without speaking.'];
  const DMA = { closure_state: { defining_moment_state: { met: true, moment: 'augustine_defining_choice', decision: 'weep_but_hold_back', decision_text: CHOSEN } } };
  const ARC = { acts: [{ actNumber: 3, beats: [
    { id: 'under_the_fig', description: 'Under the fig tree' },
    { id: 'a_childs_voice', description: 'A child\'s voice from the neighbouring house: tolle lege' },
    { id: 'romans_131314', description: 'Romans 13:13–14 — put on the Lord Jesus Christ' },
    { id: 'he_reads_no', description: 'He reads no further; the divided will resolves' },
  ] }, { actNumber: 4, beats: [{ id: 'augustine_and_alypius', description: 'Augustine and Alypius return to the house' }] }] };
  const STATE = { reachedBeats: ['under_the_fig', 'a_childs_voice', 'romans_131314', 'he_reads_no', 'augustine_and_alypius'],
    decisions: { augustine_defining_choice: { option_id: 'weep_but_hold_back', turn: 7, elapsed: 17, beats_before: 1 } } };

  const after = beatsAfterChoice(STATE, 'augustine_defining_choice', ARC);
  check('beatsAfterChoice: the beats reached from the choice on, as authored descriptions, in order',
    JSON.stringify(after) === JSON.stringify(['A child\'s voice from the neighbouring house: tolle lege', 'Romans 13:13–14 — put on the Lord Jesus Christ', 'He reads no further; the divided will resolves', 'Augustine and Alypius return to the house']), JSON.stringify(after));
  check('beatsAfterChoice: a decision recorded before beats_before existed → []', beatsAfterChoice({ ...STATE, decisions: { augustine_defining_choice: { option_id: 'x', turn: 7 } } }, 'augustine_defining_choice', ARC).length === 0);
  check('beatsAfterChoice: string-form decision, no arc, no moment → []', beatsAfterChoice({ ...STATE, decisions: { augustine_defining_choice: 'x' } }, 'augustine_defining_choice', ARC).length === 0
    && beatsAfterChoice(STATE, 'augustine_defining_choice', null).length === 0 && beatsAfterChoice(STATE, null, ARC).length === 0);
  check('choiceInputIndex: finds the input that answered the fork', choiceInputIndex(INPUTS, CHOSEN) === 2 && choiceInputIndex(INPUTS, 'Not an input.') === -1 && choiceInputIndex(INPUTS, null) === -1);

  const s = await sessAfter(DMA, INPUTS, after);
  check('the choice input is marked, and only it', s.content.includes(`3. ${CHOSEN}   ← THE DEFINING CHOICE`) && (s.content.match(/THE DEFINING CHOICE/g) || []).length === 1);
  check('the POST-fork inputs are in the input, after the marked one', ['4. Listen toward the wall', '5. Rise. The codex is where you left it.', '6. Open it. Wherever it falls.', '7. Show him the page without speaking.'].every(x => s.content.includes(x))
    && s.content.indexOf('THE DEFINING CHOICE') < s.content.indexOf('7. Show him the page'));
  check('AFTER THE CHOICE carries the post-fork beats (Romans, the will resolving), after WHAT THE PLAYER DID and before the CLOSING PROSE',
    s.content.includes('AFTER THE CHOICE') && s.content.includes('- Romans 13:13–14 — put on the Lord Jesus Christ') && s.content.includes('- He reads no further; the divided will resolves')
    && s.content.indexOf('WHAT THE PLAYER DID') < s.content.indexOf('AFTER THE CHOICE') && s.content.indexOf('AFTER THE CHOICE') < s.content.indexOf('CLOSING PROSE'));
  check('the prompt carries the full-arc instruction: before, the choice, after; honour what they actually did; end where they ended',
    s.system.includes('FOLLOW THE WHOLE ARC') && s.system.includes('held back, then crossed') && s.system.includes('honour what they actually did')
    && s.system.includes('End on where they actually ended, not on the choice.') && s.system.includes('the mark is for you — never write it') && s.system.includes('AFTER THE CHOICE, which says what the story did from there'));
  check('the source rule names AFTER THE CHOICE as a source', s.system.includes('- Draw ONLY from the SESSION SUMMARY, WHAT THE PLAYER DID, AFTER THE CHOICE, and the CLOSING PROSE provided.'));
  check('the decision keeps its weight — the crucible, still never "unresolved"', s.system.includes('THE DECISION IS THE CRUCIBLE.') && s.system.includes('Never say the session ended without resolution.'));
  const noAfter = await sessAfter(DMA, INPUTS, []);
  check('no post-fork beats → no AFTER THE CHOICE section, and the rule does not mention one', !noAfter.content.includes('AFTER THE CHOICE') && !noAfter.system.includes('AFTER THE CHOICE'));
}

globalThis.fetch = realFetch;
console.log(fails ? `\n${fails} assertion(s) FAILED.` : '\nAll epilogue assertions passed.');
process.exit(fails ? 1 : 0);
