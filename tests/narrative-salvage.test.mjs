// NARRATIVE SALVAGE — the model's JSON never reaches the player's screen (NarrativeSalvage.js).
//
//   1. the helpers, alone: salvageNarrative / looksLikeJsonReply / unnestNarrative — escapes
//      decoded, prose and normal narratives untouched (null, no mutation);
//   2. through the REAL router (/turn, api.anthropic.com scripted), on a closing turn
//      (remaining 0 — a grace turn's shape) and a mid-session turn:
//      A. broken JSON on a closing turn, shaped like the prod reply of 2026-10-05 (the narrative
//         string, then `"npcMoments":[` dropped) → the narrative is salvaged, the turn still
//         closes, no JSON on screen;
//      A'. broken JSON with nothing to salvage → not coerced; the existing recovery re-asks;
//      A''. closing-turn PROSE (no JSON) → coerced exactly as before (narrative === the text);
//      B. a valid reply whose narrative is the whole JSON reply → unwrapped, the inner choices used;
//      B'. nested but the inner reply is broken → its narrative literal salvaged;
//      C. degrade path (mid-session, broken JSON, retries broken too) → salvaged narrative;
//      D. a normal turn → narrative exactly as the model wrote it.
//
// Uses a synthetic scenario-free reply; Massieu's stored role only supplies a real session.
// Sessions and transcripts made here are deleted.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';

process.env.DEFINING_MOMENT_ENABLED = 'true';
for (const k of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL']) delete process.env[k];

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;
const p        = (...s) => path.join(REPO_DIR, ...s);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

const { salvageNarrative, looksLikeJsonReply, unnestNarrative } = await import(`${ROOT}/engine/services/NarrativeSalvage.js`);

// ── 1. helpers ────────────────────────────────────────────────────────────────
head('1. helpers');
const STORY = 'The door swings to.\n\nThe corridor. "See that she is kept as she is," Cauchon says — and the latch drops.';
// The prod failure's shape: a complete narrative string, then `"npcMoments":[` dropped.
const BROKEN = `{"narrative":${JSON.stringify(STORY)},{"npc":"pierre_cauchon","text":"See that she is kept as she is."}],"choices":[]}`;
check('the broken reply really is unparseable', (() => { try { JSON.parse(BROKEN); return false; } catch { return true; } })());
check('salvageNarrative: the narrative literal, escapes decoded (\\n, \\", —)', salvageNarrative(BROKEN) === STORY);
check('salvageNarrative: fenced reply too', salvageNarrative('```json\n' + BROKEN + '\n```') === STORY);
check('salvageNarrative: prose → null', salvageNarrative('The bell strikes. You stand at the door.') === null);
check('salvageNarrative: prose that merely mentions "narrative" → null', salvageNarrative('She calls it a "narrative" of the trial.') === null);
check('salvageNarrative: empty narrative literal → null', salvageNarrative('{"narrative":"  ","choices":[') === null);
check('salvageNarrative: unterminated literal (truncated) → null', salvageNarrative('{"narrative":"The door swi') === null);
check('looksLikeJsonReply: JSON reply yes; prose, prose ending in JSON, non-string no',
  looksLikeJsonReply(BROKEN) && looksLikeJsonReply('  ```json\n{"a":1}') && !looksLikeJsonReply('The door. {"narrative":"x"}') && !looksLikeJsonReply(null));
const normal = { narrative: STORY, choices: ['Go'] }; const normalCopy = JSON.stringify(normal);
check('unnestNarrative: a normal narrative → null, object untouched', unnestNarrative(normal) === null && JSON.stringify(normal) === normalCopy);
const braced = { narrative: '{Latin gloss} the clerk reads.', choices: ['Go'] };
check('unnestNarrative: a narrative opening with a brace but not a JSON reply → null, untouched', unnestNarrative(braced) === null && braced.narrative === '{Latin gloss} the clerk reads.');
const nested = { narrative: JSON.stringify({ narrative: STORY, choices: ['Walk beside her', 'Wait'], location: 'joan_prison_cell' }), choices: [], location: 'x', timeAdvance: 2 };
check('unnestNarrative: nested valid reply → the inner reply wins, outer-only keys kept', unnestNarrative(nested) === 'object' && nested.narrative === STORY && nested.choices.length === 2 && nested.location === 'joan_prison_cell' && nested.timeAdvance === 2);
const doubly = { narrative: JSON.stringify({ narrative: JSON.stringify({ narrative: STORY, choices: ['A'] }), choices: [] }) };
check('unnestNarrative: doubly nested → unwrapped all the way', unnestNarrative(doubly) === 'object' && doubly.narrative === STORY && doubly.choices[0] === 'A');
const nestedBroken = { narrative: BROKEN, choices: ['Go'] };
check('unnestNarrative: nested but the inner reply is broken → its narrative literal', unnestNarrative(nestedBroken) === 'narrative' && nestedBroken.narrative === STORY && nestedBroken.choices[0] === 'Go');

// ── 2. through the router ─────────────────────────────────────────────────────
const { JsonFileStore } = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const store = new JsonFileStore(p('engine/data'));   // never DualWriteStore: no Supabase writes
const repos = {};
for (const [k, n] of [['characters', 'CharacterRepository'], ['locations', 'LocationRepository'], ['clues', 'ClueRepository'], ['scenarios', 'ScenarioRepository'], ['storyArcs', 'StoryArcRepository'], ['players', 'PlayerRepository'], ['sessions', 'SessionRepository']]) {
  repos[k] = new (await import(`${ROOT}/engine/repositories/${n}.js`))[n](store);
}
const JOAN_ID = 'joan_trial_rouen_1431', ROLE_ID = 'role_massieu';
if (!(await repos.scenarios.findById(JOAN_ID)) || !repos.scenarios.findPlayerRole(ROLE_ID)) {
  console.log('SKIP  section 2 — Joan scenario not available (needs restored data).');
  process.exit(fails ? 1 : 0);
}

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
let script = [];          // texts the model returns, in order (the last one repeats)
let calls = 0;
const sse = text => {
  const ev = [`data: ${JSON.stringify({ type: 'content_block_start', index: 0 })}\n\n`, `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`, `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}\n\n`];
  return new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); ev.forEach(x => c.enqueue(e.encode(x))); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  const text = script[Math.min(calls, script.length - 1)]; calls++;
  return body.stream ? sse(text) : new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const { createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/game/api', createGameRouter(repos, { anthropicApiKey: 'salvage-test-key' }));
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const events = raw => raw.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
const quietly = async fn => { const l = console.log, w = console.warn, e = console.error; const logs = []; console.log = console.warn = console.error = (...a) => logs.push(a.join(' ')); try { return [await fn(), logs]; } finally { console.log = l; console.warn = w; console.error = e; } };
const call = (route, body) => quietly(async () => {
  const resp = await realFetch(`${BASE}/game/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const evs = events(await resp.text());
  return { done: evs.find(e => e.type === 'done'), error: evs.find(e => e.type === 'error') };
});
const snapshot = dir => new Set(fs.existsSync(p(dir)) ? fs.readdirSync(p(dir)) : []);
// appData.saveSession writes the session state to the repo-root data/sessions (engine/data.js), not engine/data/sessions.
const beforeSessions = snapshot('engine/data/sessions'), beforeTranscripts = snapshot('engine/data/transcripts'), beforeState = snapshot('data/sessions');

const GOOD = (narrative = 'You stand at the door. Cauchon says nothing.', extra = {}) => JSON.stringify({ narrative, choices: ['Stand at the door', 'Look at her'], location: 'joan_prison_cell', timeAdvance: 2, stateChanges: {}, ...extra });
const noJson = s => typeof s === 'string' && !/[{}]|"narrative"|"npcMoments"|"choices"/.test(s);

try {
  script = [GOOD()]; calls = 0;
  const [st0] = await call('start', { scenarioId: JOAN_ID, roleId: ROLE_ID, narrativeStyle: 'focused' });
  const sid = st0.done?.sessionId, s0 = st0.done?.nextState;
  check('a real Massieu session to play turns in', !!sid && !!s0);
  const mid     = { ...s0, elapsedMinutes: 10, remainingMinutes: 20 };
  const closing = { ...s0, elapsedMinutes: 30, remainingMinutes: 0, turnsAtZero: 1 };   // a grace/closing turn's shape
  const turn = (state, texts, input = 'I stand at the door.') => { script = texts; calls = 0; return call('turn', { state, sessionId: sid, playerInput: input }); };

  head('A. broken JSON on a closing turn (the prod failure)');
  let [r, logs] = await turn(closing, [BROKEN]);
  let o = r.done?.output;
  check('the turn completes and still closes (isEnding)', !!o && o.endState?.isEnding === true);
  check('the player reads the salvaged narrative — no JSON on screen', o?.narrative === STORY && noJson(o.narrative), JSON.stringify(o?.narrative).slice(0, 90));
  check('...and the closing scene is the same text', o?.endState?.scene === STORY);
  check('logged as a salvage', logs.some(l => l.includes('[NARRATIVE SALVAGE] closing turn returned broken JSON')));

  head('A\'. broken JSON with nothing to salvage, on a closing turn');
  [r, logs] = await turn(closing, ['{"npcMoments":[{"npc":"x"', GOOD('Recovered on the re-ask.')]);
  o = r.done?.output;
  check('not coerced: the existing recovery re-asks, and the re-asked reply is what ships', o?.narrative === 'Recovered on the re-ask.' && logs.some(l => l.includes('[TURN ERROR] invalid JSON')) && !logs.some(l => l.includes('[CLOSING COERCE]')));

  head('A\'\'. closing-turn PROSE (no JSON) — unchanged');
  const PROSE = 'The latch drops. Your hand is cold from the iron of the door.';
  [r, logs] = await turn(closing, [PROSE]);
  o = r.done?.output;
  check('coerced exactly as before: narrative and scene are the prose, isEnding, no salvage logged',
    o?.narrative === PROSE && o.endState?.scene === PROSE && o.endState.isEnding === true && logs.some(l => l.includes('[CLOSING COERCE]')) && !logs.some(l => l.includes('[NARRATIVE SALVAGE]')));

  head('B. valid reply whose narrative is the whole JSON reply (mid-session)');
  const NESTED = JSON.stringify({ narrative: GOOD(STORY, { choices: ['Walk beside her', 'Say nothing more'] }), choices: [], location: 'joan_prison_cell', timeAdvance: 2, stateChanges: {} });
  [r, logs] = await turn(mid, [NESTED]);
  o = r.done?.output;
  check('unwrapped: the real narrative, the inner reply\'s choices, no retry spent', o?.narrative === STORY && JSON.stringify(o.choices) === JSON.stringify(['Walk beside her', 'Say nothing more']) && calls === 1, `calls=${calls}`);
  check('logged as a salvage', logs.some(l => l.includes('[NARRATIVE SALVAGE] narrative held a nested JSON reply (parse) — unwrapped (object)')));

  head('B\'. nested, but the inner reply is broken');
  [r] = await turn(mid, [JSON.stringify({ narrative: BROKEN, choices: ['Walk beside her', 'Wait'], location: 'joan_prison_cell', timeAdvance: 2, stateChanges: {} })]);
  o = r.done?.output;
  check('its narrative literal is salvaged; the outer choices stand', o?.narrative === STORY && o.choices.length === 2 && noJson(o.narrative));

  head('C. degrade path — mid-session broken JSON, every retry broken too');
  [r, logs] = await turn(mid, [BROKEN]);
  o = r.done?.output;
  check('degrades to the salvaged narrative (not the raw JSON, not a blank card)', o?.narrative === STORY && Array.isArray(o.choices) && o.choices.length === 0 && logs.some(l => l.includes('degrading to prose-only turn')));

  head('D. a normal turn');
  const PLAIN = 'Cauchon turns from her. "We will return tomorrow."';
  [r, logs] = await turn(mid, [GOOD(PLAIN)]);
  o = r.done?.output;
  check('narrative exactly as written, choices as written, no salvage', o?.narrative === PLAIN && o.choices.length === 2 && !logs.some(l => l.includes('[NARRATIVE SALVAGE]')));
} finally {
  // /closing-prose is not called here, but sweep twice anyway, as the other router suites do.
  await new Promise(res => setTimeout(res, 1500));
  server.close();
  globalThis.fetch = realFetch;
  for (let pass = 0; pass < 2; pass++) {
    for (const [dir, before] of [['engine/data/sessions', beforeSessions], ['engine/data/transcripts', beforeTranscripts], ['data/sessions', beforeState]]) {
      for (const f of snapshot(dir)) if (!before.has(f)) { try { fs.rmSync(p(dir, f), { force: true }); } catch {} }
    }
    if (!pass) await new Promise(res => setTimeout(res, 1000));
  }
  check('sessions and transcripts created by this test are removed',
    [...snapshot('engine/data/sessions')].every(f => beforeSessions.has(f)) && [...snapshot('engine/data/transcripts')].every(f => beforeTranscripts.has(f)) && [...snapshot('data/sessions')].every(f => beforeState.has(f)));
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll narrative-salvage assertions passed.');
process.exit(fails ? 1 : 0);
