// FORK DEBRIEF + LABEL — per-option authored fields on a defining moment, both optional.
//
//   options[].debrief  the chosen option's reviewed "Your Session" text, shipped VERBATIM
//                      (the session-block model call is not made). Manchon's witness crucible:
//                      fidelity and compliance debriefs are authored, not paraphrased.
//   options[].label    the short button wording; `text` stays the full choice that is posted
//                      back, recorded and paraphrased.
//
// Gate: a block with neither field (Joan's, every generated fork) must behave exactly as before
// — same options payload, same buttons, same session-block prompt as the committed (HEAD) code.
//
// No real API calls, no Supabase, no writes (a HEAD copy of gameRouter is written beside the
// real one for the comparison and removed).

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { JSDOM } from 'jsdom';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const { authoredForkDebrief } = await import(`${ROOT}/engine/services/PromptComposer.js`);
const { generateEpilogueText, forkOptionsPayload } = await import(`${ROOT}/engine/server/gameRouter.js`);

// Joan's live block shape: three options, id + text only.
const JOAN = {
  id: 'joan_defining_choice',
  options: [
    { id: 'promises_not_kept',      text: 'They kept none of what they promised me — the oath they broke first frees mine.' },
    { id: 'voices_call_it_treason', text: 'My saints have shown me the abjuration was a treason; I damn myself to save my life.' },
    { id: 'did_not_understand',     text: 'I never understood the schedule I signed; I will not stand behind words that were not mine.' },
  ],
  principal_transition: { type: 'decision_made', moment: 'joan_defining_choice' },
};
const FIDELITY   = 'Saving her was never your part.\nYou kept it true.';
const COMPLIANCE = 'Saving her was never your part — you kept the record, not her fate.';
const MANCHON = {
  id: 'manchon_witnessing_choice',
  options: [
    { id: 'record_exactly',          label: 'Record it exactly — keep it true',  text: 'Record it exactly — her words, in the form she gave them.', debrief: `  ${FIDELITY}  ` },
    { id: 'record_as_required',      label: 'Record what the court requires',    text: 'Record what the court requires.', debrief: COMPLIANCE },
    { id: 'record_words_and_breach', label: '   ',                               text: 'Record her words — and the breach beside them.', debrief: '   ' },
  ],
  principal_transition: { type: 'decision_made', moment: 'manchon_witnessing_choice' },
};
const met = decision => ({ met: true, reason: 'decision_made', decision });

head('authoredForkDebrief — only a recorded choice with a non-empty debrief');
check('fidelity choice → its debrief, trimmed, inner text intact', authoredForkDebrief(MANCHON, met('record_exactly')) === FIDELITY);
check('compliance choice → the compliance debrief', authoredForkDebrief(MANCHON, met('record_as_required')) === COMPLIANCE);
check('whitespace-only debrief → null (model path)', authoredForkDebrief(MANCHON, met('record_words_and_breach')) === null);
check('no decision recorded → null', authoredForkDebrief(MANCHON, { met: false, reason: 'decision_not_made', decision: null }) === null);
check('flag off / no block shape → null', authoredForkDebrief(MANCHON, { met: false, reason: 'no_defining_moment_block' }) === null);
check('unknown option → null', authoredForkDebrief(MANCHON, { met: true, decision: 'nope' }) === null);
check('Joan (no debrief on any option) → null for every choice', JOAN.options.every(o => authoredForkDebrief(JOAN, met(o.id)) === null));
check('no block / no state → null', authoredForkDebrief(null, met('x')) === null && authoredForkDebrief(MANCHON, null) === null);

head('forkOptionsPayload — label rides along only when authored');
const oldMap = b => (b.options || []).filter(o => o?.id && typeof o.text === 'string').map(o => ({ id: o.id, text: o.text }));
check('Joan payload identical to the pre-change mapping', same(forkOptionsPayload(JOAN), oldMap(JOAN)));
const mp = forkOptionsPayload(MANCHON);
check('labelled options carry label + full text', mp[0].label === 'Record it exactly — keep it true' && mp[0].text === MANCHON.options[0].text);
check('blank label → no label key', !('label' in mp[2]));
check('debrief is never sent to the client', mp.every(o => !('debrief' in o)));

// ── The client button ──────────────────────────────────────────────────────────
head('renderChoices — button shows label, click still sends the full text + id');
const html = fs.readFileSync(path.join(REPO_DIR, 'engine/game/index.html'), 'utf8');
const src  = html.match(/function renderChoices\(choices = \[\], definingMoment = null\) \{[\s\S]*?\n\}\n/)?.[0];
check('renderChoices found in index.html', !!src);
function runRender(dm) {
  const dom = new JSDOM('<div id="c"></div>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(`var choicesEl = document.getElementById('c'); var lastChoices = []; var sent = [];
    function syncArrows() {} function requestAnimationFrame() {} function submitTurn(t, o) { sent.push([t, o]); }
    ${src}`);
  w.eval('renderChoices([], ' + JSON.stringify(dm) + ')');
  const btns = [...w.document.querySelectorAll('button')];
  btns.forEach(b => b.click());
  return { labels: btns.map(b => b.textContent), sent: w.eval('sent') };
}
const r1 = runRender({ momentId: MANCHON.id, options: mp });
check('Manchon buttons show the labels (blank-label option falls back to text)',
  same(r1.labels, ['Record it exactly — keep it true', 'Record what the court requires', MANCHON.options[2].text]), JSON.stringify(r1.labels));
check('clicks send the full text and the id', r1.sent.every(([t, o], i) => t === MANCHON.options[i].text && o.definingChoiceId === MANCHON.options[i].id));
const r2 = runRender({ momentId: JOAN.id, options: forkOptionsPayload(JOAN) });
check('Joan buttons unchanged (text)', same(r2.labels, JOAN.options.map(o => o.text)));

// ── generateEpilogueText against a scripted Anthropic ─────────────────────────
const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes('api.anthropic.com')) return realFetch(url, opts);
  const body  = JSON.parse(opts.body);
  const block = body.system.includes('"Historical Record"') ? 'record' : body.system.includes('"Your Session"') ? 'session' : 'other';
  calls.push({ block, system: body.system, content: JSON.stringify(body.messages) });
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: `Model ${block} text.` }], stop_reason: 'end_turn' }) };
};
const epilogue = { character_fates: [{ character_id: 'guillaume_manchon', name: 'Guillaume Manchon', classification: 'real', historical_record: 'Manchon testified in 1456.' }], immediate_outcome: { summary: 'Joan was burned on 30 May 1431.' }, historical_frame: [] };
const summary  = decision => ({ interacted_characters: ['guillaume_manchon'], resolved_threads: [], completed_beats: [], outcome: 'session_complete',
  closure_state: { met: false, defining_moment_state: { ...met(decision), transition_type: 'decision_made', moment: MANCHON.id, decision_text: 'x', available_options: MANCHON.options.map(o => o.id) } } });
const played = { id: 'role_manchon', name: 'Guillaume Manchon', character_type: 'real' };
const run = async (fn, s, authored) => { calls.length = 0; const out = await fn(epilogue, s, 'Closing prose.', 'k', null, [], false, played, authored); return { out, calls: [...calls] }; };

head('ONE block (debrief_with_recap off — the saints): authored debrief verbatim, no session call');
const A = await run(generateEpilogueText, summary('record_exactly'), FIDELITY);
check('session_block is the authored text, byte for byte', A.out.session_block === FIDELITY);
check('no session-block model call made', A.calls.filter(c => c.block === 'session').length === 0);
check('no session_debrief key on a one-block result', !('session_debrief' in A.out));
check('record block still generated', A.calls.filter(c => c.block === 'record').length === 1 && A.out.record_block === 'Model record text.');
check('debrief text never reaches the record prompt', !A.calls.some(c => c.content.includes('You kept it true')));
{
  const off = { ...summary('record_exactly') };
  calls.length = 0;
  const out = await generateEpilogueText(epilogue, off, 'Closing prose.', 'k', null, [], false, played, FIDELITY, ['I watch.'], [], { recapWithDebrief: false });
  check('recapWithDebrief:false explicitly → the same one-block result', out.session_block === FIDELITY && !('session_debrief' in out) && !calls.some(c => c.block === 'session'));
}

head('TWO blocks (debrief_with_recap on — Cantigny): recap first, authored debrief as capstone');
{
  const ACTIONS = ['I read the needle.', 'I send Wakely to the fault.', 'x', 'I check the stopwatch.'];
  const s = summary('record_exactly');   // decision_text 'x' — the 3rd input is the choice
  calls.length = 0;
  const out = await generateEpilogueText(epilogue, { ...s, anchored_outcome: { id: 'a', description: 'ANCHORED-OUTCOME-TEXT' } },
    'CLOSING-PROSE-TEXT', 'k', null, [{ name: 'Wakely', role: 'linesman' }], false, played, FIDELITY, ACTIONS, ['AFTER-BEAT-TEXT'], { recapWithDebrief: true });
  const sess = calls.filter(c => c.block === 'session');
  check('one recap call is made', sess.length === 1);
  check('session_block is the model recap', out.session_block === 'Model session text.');
  check('session_debrief is the authored debrief, byte for byte', out.session_debrief === FIDELITY);
  check('record block unchanged', out.record_block === 'Model record text.' && calls.filter(c => c.block === 'record').length === 1);
  const sys = sess[0]?.system || '', content = sess[0]?.content || '';
  check('lead-up prompt: about 60–110 words, ceiling 130, ends at the choice, never judges, never tells the outcome',
    sys.includes('Length: about 60–110 words, never more than 130.') && sys.includes('END AT THE CHOICE') && sys.includes('NEVER JUDGE IT') && sys.includes('NEVER TELL THE OUTCOME'));
  check('the debrief text is NOT passed to the recap', !content.includes('You kept it true') && !sys.includes('You kept it true'));
  check('nor the closing prose, AFTER THE CHOICE, or the anchored outcome', !content.includes('CLOSING-PROSE-TEXT') && !content.includes('AFTER-BEAT-TEXT') && !content.includes('ANCHORED-OUTCOME-TEXT'));
  check('no character ids in the recap prompt', !content.includes('guillaume_manchon'));
  check('inputs cut at the choice (marked); later inputs not sent',
    content.includes('3. x   ← THE DEFINING CHOICE') && content.includes('I send Wakely to the fault.') && !content.includes('I check the stopwatch.'));
}
{
  // Recap call fails → the authored debrief alone, i.e. exactly the one-block result.
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.system.includes('"Your Session"')) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }), text: async () => 'boom' };
    return saved(url, opts);
  };
  let out = null;
  try { out = await generateEpilogueText(epilogue, summary('record_exactly'), 'Closing prose.', 'k', null, [], false, played, FIDELITY, [], [], { recapWithDebrief: true }); }
  catch (e) { out = { error: e.message }; }
  globalThis.fetch = saved;
  check('recap call fails → session_block is the authored debrief, no session_debrief', out?.session_block === FIDELITY && !('session_debrief' in out), JSON.stringify(out));
}
{
  calls.length = 0;
  const out = await generateEpilogueText(epilogue, { ...summary('x'), closure_state: { met: false } }, 'Closing prose.', 'k', null, [], false, played, null, [], [], { recapWithDebrief: true });
  check('recapWithDebrief with no authored debrief → the ordinary model session block', out.session_block === 'Model session text.' && !('session_debrief' in out)
    && calls.some(c => c.block === 'session' && c.system.includes('Describe what this player did')));
}

head('client + transcripts carry session_debrief after the recap');
{
  const dom = new JSDOM(html);
  const deb = dom.window.document.getElementById('closing-epilogue-session-debrief');
  check('closing screen: a debrief element sits after the recap text inside "Your Session"',
    !!deb && deb.previousElementSibling?.id === 'closing-epilogue-session-text' && deb.parentElement?.id === 'closing-epilogue-session');
  check('done handler fills it from evt.epilogue.session_debrief',
    /const debriefText = evt\.epilogue\?\.session_debrief \|\| '';/.test(html) && /epSessionDebriefEl\.textContent = debriefText;/.test(html));
  check('narration speaks it after the recap', /speakAtLeast\(epSessionTextEl\.textContent\);\s*\n\s*if \(epSessionDebriefEl\?\.textContent\) await speakAtLeast\(epSessionDebriefEl\.textContent\);/.test(html));
  check('empty debrief element is hidden (one-block sessions look as before)', html.includes('.closing-epilogue-debrief:empty { display: none; }'));
  const router = fs.readFileSync(path.join(REPO_DIR, 'engine/server/gameRouter.js'), 'utf8');
  check('session transcript: debrief follows the recap under ## Your Session', router.includes("if (epilogueResult.session_debrief) lines.push('', epilogueResult.session_debrief);"));
  check('demo transcript stores session_debrief', router.includes('session_debrief: epilogueResult.session_debrief'));
  const exp = fs.readFileSync(path.join(REPO_DIR, 'scripts/export-demo-transcripts.mjs'), 'utf8');
  check('demo export prints it after the recap', exp.includes("if (r.closing.session_debrief) lines.push(r.closing.session_debrief, '');"));
}

head('no debrief → session prompt identical to the committed (HEAD) code');
const headPath = path.join(REPO_DIR, 'engine/server/.__head_gameRouter.test.js');
fs.writeFileSync(headPath, execFileSync('git', ['show', 'HEAD:engine/server/gameRouter.js'], { cwd: REPO_DIR, encoding: 'utf8', maxBuffer: 64e6 }));
try {
  const { generateEpilogueText: headGen } = await import(pathToFileURL(headPath).href);
  {
    const s = { ...summary('x'), closure_state: { met: false } };
    const now = await run(generateEpilogueText, s, null);
    const old = await run(headGen, s, undefined);
    check('no decision: same calls, same prompts, same output', same(now.calls, old.calls) && same(now.out, old.out) && now.calls.some(c => c.block === 'session'));
  }
  {
    // The decision arm's SYSTEM prompt is reworded on purpose (full arc, 2026-11-02 — see
    // epilogue.test). Everything else about the call must still match HEAD: the record call,
    // the session content, the call order, and the output.
    const s = summary('record_exactly');
    const now = await run(generateEpilogueText, s, null);
    const old = await run(headGen, s, undefined);
    const strip = calls => calls.map(c => (c.block === 'session' ? { ...c, system: '<decision arm>' } : c));
    check('decision-aware (Joan-style): same calls, record prompt, session content and output — only the decision-arm system prompt moved',
      same(strip(now.calls), strip(old.calls)) && same(now.out, old.out) && now.calls.some(c => c.block === 'session'));
  }
} finally {
  fs.rmSync(headPath, { force: true });
}
globalThis.fetch = realFetch;

console.log(`\n${fails ? `FAILED — ${fails} assertion(s)` : 'ALL PASS'}`);
process.exit(fails ? 1 : 0);
