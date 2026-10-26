// SILENT-NPC RETRY vs QUOTE STYLE (engine/server/gameRouter.js, hasSpeech).
//
// The silent-npc retry re-asks the model when an NPC is present but the narrative carries no
// spoken line. hasSpeech used to match only straight ASCII double quotes, so narration written
// with typographic quotes (“…”, ‘…’) read as silence and the retry — a full second model call,
// 6-13s on prod — would fire on EVERY turn with an NPC present.
//
//   1. hasSpeech directly: every quote style counts; prose and a lone apostrophe do not.
//   2. through the REAL router (/turn, api.anthropic.com scripted), an NPC present:
//      curly double, curly single, straight → exactly one model call, no silent-npc retry;
//      no dialogue at all → the retry still fires (the control: the guard is not disabled).
//
// No model calls, no Supabase writes; sessions and transcripts the test creates are removed.
//
//   node tests/silent-npc-quotes.test.mjs

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;
const p        = (...s) => path.join(REPO_DIR, ...s);
let fails = 0;
const head  = s => console.log(`\n── ${s}`);
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`); if (!ok) fails++; };

const { hasSpeech, createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);

// ── 1. hasSpeech ──────────────────────────────────────────────────────────────
head('1. hasSpeech — every quote style');
const CURLY_DOUBLE = 'Massieu leans in. “Say only what you know.” The guard shifts.';
const CURLY_SINGLE = 'Massieu leans in. ‘Say only what you know.’ The guard shifts.';
const STRAIGHT     = 'Massieu leans in. "Say only what you know." The guard shifts.';
const SILENT       = 'Massieu leans in and says nothing. The guard shifts.';
const APOSTROPHE   = 'Massieu’s hand rests on the bench; the guard’s keys hang still.';
for (const [name, s, want] of [
  ['curly double quotes “…”', CURLY_DOUBLE, true],
  ['curly single quotes ‘…’', CURLY_SINGLE, true],
  ['straight double quotes (unchanged)', STRAIGHT, true],
  ['a "Name: “…”" line', 'Massieu: “Say only what you know.”', true],
  ['a "Name: ‘…’" line', 'Massieu: ‘Say only what you know.’', true],
  ['a "Name: \'…\'" line (unchanged)', "Massieu: 'Say only what you know.'", true],
  ['prose with no dialogue', SILENT, false],
  ['curly apostrophes alone are not speech', APOSTROPHE, false],
  ['empty / missing narrative', '', false],
]) check(`${name} → ${want}`, hasSpeech(s) === want, `got ${hasSpeech(s)}`);

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
let script = [];   // texts the model returns, in order (the last one repeats)
let calls = [];    // the model calls the router made: 'stream' or the generation's retry prompt
const sse = text => {
  const ev = [`data: ${JSON.stringify({ type: 'content_block_start', index: 0 })}\n\n`, `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`, `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}\n\n`];
  return new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); ev.forEach(x => c.enqueue(e.encode(x))); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  const text = script[Math.min(calls.length, script.length - 1)];
  calls.push(body.stream ? 'stream' : String(body.messages.at(-1)?.content).slice(0, 60));
  return body.stream ? sse(text) : new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/game/api', createGameRouter(repos, { anthropicApiKey: 'silent-npc-test-key' }));
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const events = raw => raw.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
const quietly = async fn => { const l = console.log, w = console.warn, e = console.error; const logs = []; console.log = console.warn = console.error = (...a) => logs.push(a.join(' ')); try { return [await fn(), logs]; } finally { console.log = l; console.warn = w; console.error = e; } };
const call = (route, body) => quietly(async () => {
  const resp = await realFetch(`${BASE}/game/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { done: events(await resp.text()).find(e => e.type === 'done') };
});
const snapshot = dir => new Set(fs.existsSync(p(dir)) ? fs.readdirSync(p(dir)) : []);
// appData.saveSession writes the session state to the repo-root data/sessions (engine/data.js), not engine/data/sessions.
const beforeSessions = snapshot('engine/data/sessions'), beforeTranscripts = snapshot('engine/data/transcripts'), beforeState = snapshot('data/sessions');

const NPC = 'char_cauchon';
const REPLY = (narrative, npcMoments = [{ npc: NPC, action: 'watches' }]) => JSON.stringify({ narrative, npcMoments, choices: ['Answer him', 'Say nothing'], location: 'joan_prison_cell', timeAdvance: 2, stateChanges: {} });
const SPOKEN = 'Cauchon: “You will answer, Brother.”';

try {
  script = [REPLY('The cell is cold.', [])];
  const [st0] = await call('start', { scenarioId: JOAN_ID, roleId: ROLE_ID, narrativeStyle: 'focused' });
  const sid = st0.done?.sessionId, s0 = st0.done?.nextState;
  check('a real Massieu session to play turns in', !!sid && !!s0);
  const mid  = { ...s0, elapsedMinutes: 10, remainingMinutes: 20 };
  const turn = texts => { script = texts; calls = []; return call('turn', { state: mid, sessionId: sid, playerInput: 'I wait by the door.' }); };

  head('2. an NPC present — the silent-npc retry by quote style');
  for (const [name, narr] of [['curly double quotes', CURLY_DOUBLE], ['curly single quotes', CURLY_SINGLE], ['straight quotes', STRAIGHT]]) {
    const [r, logs] = await turn([REPLY(narr), REPLY(SPOKEN)]);
    check(`${name}: one model call, no silent-npc retry, narrative as written`,
      calls.length === 1 && !logs.some(l => l.includes('[RETRY] silent-npc')) && r.done?.output?.narrative === narr,
      `calls=${JSON.stringify(calls)}`);
  }
  const [r, logs] = await turn([REPLY(SILENT), REPLY(SPOKEN)]);
  check('control — no dialogue at all: the silent-npc retry still fires and its reply ships',
    calls.length === 2 && logs.some(l => l.includes('[RETRY] silent-npc')) && r.done?.output?.narrative === SPOKEN,
    `calls=${JSON.stringify(calls)}`);
} finally {
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

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll silent-npc quote assertions passed.');
process.exit(fails ? 1 : 0);
