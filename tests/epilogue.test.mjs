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

const { generateEpilogueText, trimToLastSentence, recordWordBudget } = await import(`${ROOT}/engine/server/gameRouter.js`);

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
  calls.push({ block, max_tokens: body.max_tokens, system: body.system });
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

globalThis.fetch = realFetch;
console.log(fails ? `\n${fails} assertion(s) FAILED.` : '\nAll epilogue assertions passed.');
process.exit(fails ? 1 : 0);
