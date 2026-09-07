// GRACEFUL DEGRADATION ON UNUSABLE MODEL OUTPUT — the /start (opening) half.
//
// Covers the three shapes of "unusable" the opening can come back in, and the two ways each
// one can end:
//
//   bad JSON        → retry recovers  |  retries exhaust → friendly retry screen
//   empty choices   → retry recovers  |  retries exhaust → friendly retry screen
//   no text at all  → same path
//   normal opening  → UNTOUCHED (exactly one model call, no spurious retry)
//
// WHY THIS TEST EXISTS AND WHY IT IS SHAPED LIKE THIS. Both fixes in this area shipped bugs
// that unit tests could not have caught, because the bugs lived in the seams:
//   - a recovery block inserted into the wrong handler,
//   - a TypeError swallowed by a catch,
//   - a retry button whose click handler did nothing because the state it read
//     (lastPlayerInput) is empty at the opening.
// Every one of those passes a unit test of the function in isolation and fails a real run.
// So this test drives the REAL Express app, the REAL createGameRouter, the REAL on-disk
// scenario data, real SSE over a real socket, and the REAL engine/game/index.html in jsdom —
// and asserts on what a player would actually SEE on screen and what happens when they press
// the button. The only thing replaced is api.anthropic.com, because a specific malformed
// opening cannot be forced from the live model.
//
// No writes to production data survive: the sessions and transcripts /start creates are
// deleted at the end. Reads go through the normal repositories, so Supabase credentials are
// needed for the scenario lookup — the test skips itself cleanly without them.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';
import { JSDOM } from 'jsdom';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;
const p        = (...s) => path.join(REPO_DIR, ...s);

const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { CharacterRepository } = await import(`${ROOT}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { ClueRepository }      = await import(`${ROOT}/engine/repositories/ClueRepository.js`);
const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
const { PlayerRepository }    = await import(`${ROOT}/engine/repositories/PlayerRepository.js`);
const { SessionRepository }   = await import(`${ROOT}/engine/repositories/SessionRepository.js`);

const SCENARIO_ID = 'chicago_1893_v1';
const ROLE_ID     = 'daniel_burnham';

// ── Scripted stand-in for api.anthropic.com ──────────────────────────────────
// The router resolves `fetch` from the global scope at call time, so replacing it here
// intercepts the model calls without the router knowing anything has changed.
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;

let script = [];   // queue of directives, one consumed per model call
let calls  = [];   // what the router actually asked for, for assertions

function sseStream(text, stopReason = 'end_turn') {
  const events = [`data: ${JSON.stringify({ type: 'content_block_start', index: 0 })}\n\n`];
  // Chunked, so the streaming/accumulating path is genuinely exercised rather than
  // handed one convenient whole-message delta.
  for (let i = 0; i < text.length; i += 40) {
    events.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 40) } })}\n\n`);
  }
  events.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 100 } })}\n\n`);
  const body = new ReadableStream({
    start(c) { const enc = new TextEncoder(); for (const e of events) c.enqueue(enc.encode(e)); c.close(); },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonMessage(text, stopReason = 'end_turn') {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text }], stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 20 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  const directive = script.shift();
  calls.push({
    stream:          !!body.stream,
    messageRoles:    body.messages.map(m => m.role).join(','),
    lastUserContent: [...body.messages].reverse().find(m => m.role === 'user')?.content || '',
  });
  // An unscripted call is itself a failure: it means the retry ceiling was breached.
  if (!directive) throw new Error('degradation.test: model called more times than the script allows');
  if (directive.throw) throw new Error(directive.throw);
  return body.stream ? sseStream(directive.text, directive.stopReason)
                     : jsonMessage(directive.text, directive.stopReason);
};

// ── The app ──────────────────────────────────────────────────────────────────
// JsonFileStore, not DualWriteStore: this test must never write to Supabase.
const store = new JsonFileStore(p('engine/data'));
const repos = {
  characters: new CharacterRepository(store),
  locations:  new LocationRepository(store),
  clues:      new ClueRepository(store),
  scenarios:  new ScenarioRepository(store),
  storyArcs:  new StoryArcRepository(store),
  players:    new PlayerRepository(store),
  sessions:   new SessionRepository(store),
};

let scenarioOk = false;
try { scenarioOk = !!(await repos.scenarios.findById(SCENARIO_ID))
                   && !!repos.scenarios.findPlayerRoles(SCENARIO_ID).find(r => r.id === ROLE_ID); } catch { scenarioOk = false; }
if (!scenarioOk) {
  console.log(`SKIP  degradation.test — scenario "${SCENARIO_ID}" / role "${ROLE_ID}" not available (needs restored data + Supabase creds).`);
  process.exit(0);
}

const { createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);

const app = express();
app.use(express.json({ limit: '10mb' }));
// Must match the client's API_BASE ('/game/api') so the real index.html can talk to it.
app.use('/game/api', createGameRouter(repos, { anthropicApiKey: 'degradation-test-key' }));
app.use('/game', express.static(p('engine/game')));

const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// Every /start seeds a session and (on success) a transcript. A DEGRADED run seeds a session
// but never emits a sessionId, so tracking the ids from the SSE stream would leak those files.
// Snapshot the directories instead and remove whatever is new at the end.
const snapshot = dir => { try { return new Set(fs.readdirSync(p(dir))); } catch { return new Set(); } };
const beforeSessions    = snapshot('engine/data/sessions');
const beforeTranscripts = snapshot('engine/data/transcripts');

// ── Drivers ──────────────────────────────────────────────────────────────────
async function runStart() {
  const resp = await realFetch(`${BASE}/game/api/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: SCENARIO_ID, roleId: ROLE_ID, narrativeStyle: 'focused' }),
  });
  const raw = await resp.text();
  const events = raw.split('\n').filter(l => l.startsWith('data: '))
    .map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  return { status: resp.status, events, chunks: events.filter(e => e.type === 'chunk').map(e => e.text).join('') };
}

async function runClient() {
  const html = fs.readFileSync(p('engine/game/index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: `${BASE}/game?scenarioId=${SCENARIO_ID}`,
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = (u, o) => realFetch(new URL(u, BASE).href, o);
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollIntoView = () => {};
      win.speechSynthesis ??= { getVoices: () => [], cancel() {}, speak() {} };
      win.console.error = () => {};   // the failure paths log loudly on purpose; keep output readable
    },
  });
  const win = dom.window;
  await new Promise(r => win.addEventListener('load', r, { once: true }));
  // `scenario` is a top-level `let`, so it is not a window property — eval sees the lexical scope.
  const ready = () => { try { return !!win.eval('typeof scenario !== "undefined" && scenario'); } catch { return false; } };
  for (let i = 0; i < 100 && !ready(); i++) await new Promise(r => setTimeout(r, 100));
  if (!ready()) throw new Error('degradation.test: client never loaded scenario via /bootstrap');
  return { dom, win };
}

// What the player can actually see and press.
function screen(win) {
  const story   = win.document.getElementById('story');
  const choices = win.document.getElementById('choices');
  return {
    text:      (story?.textContent || '').replace(/\s+/g, ' ').trim(),
    errorCard: story?.querySelector('.scene-error')?.textContent?.trim() || null,
    buttons:   [...(choices?.querySelectorAll('button') || [])].map(b => b.textContent.trim()),
    submitDisabled: win.document.querySelector('#input-form button[type="submit"]').disabled,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const GOOD = JSON.stringify({
  narrative: 'The telegraph key is still warm under your palm. Outside, the White City hums.',
  choices: ['Study the forged signature', 'Send for fair security', 'Go to the freight yards'],
  location: 'administration_building', timeAdvance: 0,
});
const GOOD_RETRY = JSON.stringify({
  narrative: 'Recovered opening: the transfer order lies on the desk, ink barely dry.',
  choices: ['Read the order again', 'Call for your assistant'],
  location: 'administration_building', timeAdvance: 0,
});
// Prose with no balanced JSON span anywhere in it — extractJson's fence-stripping and
// first-brace-to-last-brace slicing both have nothing to find, which is the real-world shape.
const MALFORMED  = 'I apologize, but I need to think about this scene differently. Let me describe it in prose instead of the requested format.';
const NO_CHOICES = JSON.stringify({ narrative: 'A valid object, but nothing to press.', choices: [], location: 'administration_building', timeAdvance: 0 });

const FRIENDLY = 'This scenario had trouble loading — please try again.';

// ── Assertions ───────────────────────────────────────────────────────────────
let pass = 0; const failures = [];
const ck = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`   PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`   FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};
const banner = t => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

// ── (c) the normal opening must be completely untouched ──────────────────────
banner('(c) NORMAL opening — untouched, no spurious retry');
script = [{ text: GOOD }]; calls = [];
{
  const r = await runStart();
  const done = r.events.find(e => e.type === 'done');
  ck('exactly ONE model call (no spurious retry)', calls.length === 1, `got ${calls.length}`);
  ck('that call was the streaming opening', calls[0]?.stream === true);
  ck('emitted type:done', !!done);
  ck('emitted no type:error', !r.events.some(e => e.type === 'error'));
  ck('choices delivered intact', JSON.stringify(done?.output?.choices) === JSON.stringify(JSON.parse(GOOD).choices));
  ck('narrative streamed to the client as chunks', r.chunks.includes('telegraph key'));
  ck('timeAdvance forced to 0', done?.output?.timeAdvance === 0);
  ck('nextState + sessionId promoted', !!done?.nextState && !!done?.sessionId);
}

// ── (a) malformed opening ────────────────────────────────────────────────────
banner('(a1) MALFORMED opening → retry recovers');
script = [{ text: MALFORMED }, { text: GOOD_RETRY }]; calls = [];
{
  const r = await runStart();
  const done = r.events.find(e => e.type === 'done');
  ck('retried exactly once', calls.length === 2, `got ${calls.length}`);
  ck('the retry was NON-streaming', calls[1]?.stream === false);
  ck('retry echoed the bad attempt back as an assistant turn', calls[1]?.messageRoles === 'user,assistant,user', calls[1]?.messageRoles);
  ck('retry carried the corrective instruction', /not usable/.test(calls[1]?.lastUserContent || '') && /ONLY a single valid JSON object/.test(calls[1]?.lastUserContent || ''));
  ck('recovered — emitted type:done', !!done);
  ck('emitted NO type:error', !r.events.some(e => e.type === 'error'));
  ck('the recovered narrative is the one shipped', /Recovered opening/.test(done?.output?.narrative || ''));
  ck('recovered choices are non-empty', (done?.output?.choices || []).length === 2);
}

banner('(a2) MALFORMED opening → retries exhaust → friendly degrade');
script = [{ text: MALFORMED }, { text: MALFORMED }, { text: MALFORMED }]; calls = [];
{
  const r = await runStart();
  const err = r.events.find(e => e.type === 'error');
  ck('1 attempt + 2 retries = 3 calls, then stop', calls.length === 3, `got ${calls.length}`);
  ck('emitted a type:error', !!err);
  ck('NEVER the raw "Model returned invalid JSON for opening"', !JSON.stringify(r.events).includes('Model returned invalid JSON for opening'));
  ck('player-facing copy is the friendly one', err?.error === FRIENDLY, JSON.stringify(err?.error));
  ck('marked stage:opening + retryable', err?.stage === 'opening' && err?.retryable === true);
  ck('technical reason quarantined in detail', /not valid JSON/.test(err?.detail || ''), err?.detail);
  ck('no stop_reason or JSON braces in the player copy', !/stop_reason|[{}]/.test(err?.error || ''));
}

// ── (b) empty choices — the opening twin of the turn handler's Symptom A ─────
banner('(b1) EMPTY-CHOICES opening → retry recovers (must not dead-end at the door)');
script = [{ text: NO_CHOICES }, { text: GOOD_RETRY }]; calls = [];
{
  const r = await runStart();
  const done = r.events.find(e => e.type === 'done');
  ck('empty choices triggered a retry', calls.length === 2, `got ${calls.length}`);
  ck('the corrective named the choices problem', /no "choices" for the player/.test(calls[1]?.lastUserContent || ''));
  ck('recovered — emitted type:done', !!done);
  ck('the opening now HAS choices', (done?.output?.choices || []).length > 0);
  ck('the choice-less narrative was NOT shipped', !/nothing to press/.test(done?.output?.narrative || ''));
}

banner('(b2) EMPTY-CHOICES opening → retries also choice-less → friendly degrade');
script = [{ text: NO_CHOICES }, { text: NO_CHOICES }, { text: NO_CHOICES }]; calls = [];
{
  const r = await runStart();
  const err = r.events.find(e => e.type === 'error');
  ck('3 calls, then degrade', calls.length === 3, `got ${calls.length}`);
  ck('friendly error rather than a dead-ended done', err?.error === FRIENDLY);
  ck('no type:done with an empty choices array was shipped', !r.events.some(e => e.type === 'done' && (e.output?.choices || []).length === 0));
}

// ── (d) the recovery itself failing must still degrade ───────────────────────
banner('(d) the retry call itself throws → still degrades, never a 500');
script = [{ text: MALFORMED }, { throw: 'socket hang up' }, { throw: 'socket hang up' }]; calls = [];
{
  const r = await runStart();
  const err = r.events.find(e => e.type === 'error');
  ck('HTTP still 200 (the SSE stream was already open)', r.status === 200, `got ${r.status}`);
  ck('degraded to the friendly retry screen', err?.error === FRIENDLY);
  ck('the exception text did not leak to the player', !/socket hang up/.test(err?.error || ''));
}

// ── CLIENT: the real page, in a browser, pressing the real buttons ───────────
banner('CLIENT (c) NORMAL opening — the player sees the scene and its choices');
script = [{ text: GOOD }]; calls = [];
{
  const { dom, win } = await runClient();
  await win.startGame(ROLE_ID, 'focused', {});
  const s = screen(win);
  ck('scene prose is on screen', /telegraph key/.test(s.text), s.text.slice(0, 120));
  ck('no error card', s.errorCard === null, s.errorCard);
  ck('three real choice buttons', s.buttons.length === 3, JSON.stringify(s.buttons));
  ck('no "Try again" button', !s.buttons.some(b => /try again/i.test(b)));
  ck('submit is enabled', s.submitDisabled === false);
  dom.window.close();
}

banner('CLIENT (a) UNRECOVERABLE opening — friendly card + a retry that WORKS');
script = [{ text: MALFORMED }, { text: MALFORMED }, { text: MALFORMED }]; calls = [];
{
  const { dom, win } = await runClient();
  await win.startGame(ROLE_ID, 'focused', {});
  const s = screen(win);
  ck('friendly card is shown', /trouble loading/.test(s.errorCard || ''), s.errorCard);
  ck('the raw "invalid JSON" string is NOT on screen', !/invalid JSON/i.test(s.text), s.text.slice(0, 200));
  ck('no stop_reason on screen', !/stop_reason/i.test(s.text));
  ck('exactly one action, and it is "Try again"', s.buttons.length === 1 && /try again/i.test(s.buttons[0]), JSON.stringify(s.buttons));
  ck('submit disabled (no opened session to submit against)', s.submitDisabled === true);

  // The regression that unit tests miss: the button exists but its handler reads
  // lastPlayerInput, which is '' at the opening — so it must carry its own action instead.
  console.log('   -- pressing "Try again" --');
  script = [{ text: GOOD }]; calls = [];
  win.document.getElementById('choices').querySelectorAll('button')[0]
     .dispatchEvent(new win.Event('click', { bubbles: true }));
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 50));
    if (/telegraph key/.test(screen(win).text)) break;
  }
  const s2 = screen(win);
  ck('the retry actually re-called /start', calls.length === 1, `model calls: ${calls.length}`);
  ck('the retry rendered the real scene', /telegraph key/.test(s2.text), s2.text.slice(0, 160));
  ck('the error card was removed, not stacked', s2.errorCard === null, s2.errorCard);
  ck('real choices restored', s2.buttons.length === 3, JSON.stringify(s2.buttons));
  ck('submit re-enabled after a successful retry', s2.submitDisabled === false);
  dom.window.close();
}

banner('CLIENT (b) EMPTY-CHOICES opening that recovers — no choice-less screen is ever shown');
script = [{ text: NO_CHOICES }, { text: GOOD_RETRY }]; calls = [];
{
  const { dom, win } = await runClient();
  await win.startGame(ROLE_ID, 'focused', {});
  const s = screen(win);
  ck('the recovered scene is shown', /Recovered opening/.test(s.text), s.text.slice(0, 160));
  ck('no error card', s.errorCard === null, s.errorCard);
  ck('the player has pressable choices', s.buttons.length === 2 && !/try again/i.test(s.buttons[0]), JSON.stringify(s.buttons));
  dom.window.close();
}

// ── Cleanup — leave no session or transcript behind ──────────────────────────
let removed = 0;
for (const [dir, before] of [['engine/data/sessions', beforeSessions], ['engine/data/transcripts', beforeTranscripts]]) {
  for (const name of snapshot(dir)) {
    if (before.has(name)) continue;
    try { fs.unlinkSync(p(dir, name)); removed++; } catch {}
  }
}
server.close();
globalThis.fetch = realFetch;

console.log(`\n${'═'.repeat(78)}`);
console.log(`degradation.test — ${pass} passed, ${failures.length} failed  (cleaned up ${removed} file(s))`);
for (const f of failures) console.log(`  FAILED: ${f}`);
process.exit(failures.length ? 1 : 0);
