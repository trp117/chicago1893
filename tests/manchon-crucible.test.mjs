// MANCHON WITNESS-CRUCIBLE — Stage 2 acceptance, on Manchon's STORED role (his fork as written
// to prod 2026-10-03: at_scene scene_28_may, default 0.85 fallback, three authored options each
// with a short label and a verbatim debrief).
//
// Drives the REAL router (/start, /turn, /closing-prose) with api.anthropic.com scripted, for
// each of the three choices and at two turn costs (2 and 3 minutes — the local and the suspected
// prod pacing). Checks, per run:
//   1. he reaches scene_28_may and PLAYS it — the fork is put there, and at least one turn is
//      played in it after his answer, before the session closes;
//   2. the fork fires (via its binding, or its fallback);
//   3. the three witnessing-choices are presented with their SHORT labels (full text kept);
//   4. "Your Session" is the chosen option's authored debrief, byte for byte, with no
//      session-block model call — fidelity (1, 3) vs compliance (2) differ;
//   5. the debrief carries no "could(n't) save her" and the compliance path invents no catastrophe;
//   6. the decision HOLDS: every turn prompt from the answer turn on names the chosen option as
//      the decision made (so the narration plays it and the debrief matches); none before it does.
//
// Manchon's stored role is never written. Sessions and transcripts made here are deleted.

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

const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { CharacterRepository } = await import(`${ROOT}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { ClueRepository }      = await import(`${ROOT}/engine/repositories/ClueRepository.js`);
const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
const { PlayerRepository }    = await import(`${ROOT}/engine/repositories/PlayerRepository.js`);
const { SessionRepository }   = await import(`${ROOT}/engine/repositories/SessionRepository.js`);

const store = new JsonFileStore(p('engine/data'));   // never DualWriteStore: no Supabase writes
const repos = {
  characters: new CharacterRepository(store), locations: new LocationRepository(store),
  clues: new ClueRepository(store), scenarios: new ScenarioRepository(store),
  storyArcs: new StoryArcRepository(store), players: new PlayerRepository(store),
  sessions: new SessionRepository(store),
};

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

const JOAN_ID  = 'joan_trial_rouen_1431';
const ROLE_ID  = 'role_manchon';
const scenario = await repos.scenarios.findById(JOAN_ID);
const ROLE     = repos.scenarios.findPlayerRole(ROLE_ID);
const DM       = ROLE?.defining_moment;
if (!scenario || !DM) { console.log('SKIP  manchon-crucible.test — Joan scenario or Manchon\'s fork not available (needs restored data).'); process.exit(0); }
const ROLE_FILE = fs.readFileSync(p('engine/data/scenarios/player_roles', `${ROLE_ID}.json`), 'utf8');

head('0. the stored block');
check('Manchon\'s fork: manchon_witnessing_choice, bound at_scene scene_28_may, default fallback, no clock cost',
  DM.id === 'manchon_witnessing_choice' && DM.at_scene === 'scene_28_may' && DM.fallback_at_elapsed_fraction == null && DM.time_advance === 0);
check('three options, each with a short label, full text and a debrief',
  DM.options.length === 3 && DM.options.every(o => o.label && o.text && o.debrief && o.label.length < 50 && o.text.length > 150));
const [FID, COMP, BREACH] = DM.options;
check('fidelity-plus debrief = the fidelity debrief + the breach sentence', BREACH.debrief.startsWith(FID.debrief) && BREACH.debrief.length > FID.debrief.length);
check('compliance debrief differs from fidelity', COMP.debrief !== FID.debrief && !FID.debrief.includes(COMP.debrief.slice(0, 80)));
const BANNED = [/could\s*n[o']t (have )?save(d)? her/i, /could not (have )?save(d)? her/i, /failed to save her/i, /your fault/i, /because of you/i];
check('no debrief says "could(n\'t) save her" / blames him', DM.options.every(o => !BANNED.some(rx => rx.test(o.debrief))));
check('the compliance debrief keeps the cost uncertain and says the truth survived without him',
  /you will never know/.test(COMP.debrief) && /did not die because of it/.test(COMP.debrief) && /did not need you to survive/.test(COMP.debrief));

// ── scripted Anthropic ────────────────────────────────────────────────────────
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
let nextOutput = null;
let lastTurnPrompt = null;
const modelCalls = [];
function sseStream(text) {
  const events = [`data: ${JSON.stringify({ type: 'content_block_start', index: 0 })}\n\n`];
  for (let i = 0; i < text.length; i += 40) events.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 40) } })}\n\n`);
  events.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 100 } })}\n\n`);
  const body = new ReadableStream({ start(c) { const e = new TextEncoder(); for (const x of events) c.enqueue(e.encode(x)); c.close(); } });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const json = (text) => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  const sys  = typeof body.system === 'string' ? body.system : JSON.stringify(body.system || '');
  const kind = sys.includes('"Your Session"') ? 'session' : sys.includes('"Historical Record"') ? 'record' : 'other';
  modelCalls.push(kind);
  if (kind === 'other') { const m = body.messages?.at(-1)?.content; lastTurnPrompt = typeof m === 'string' ? m : JSON.stringify(m); }
  if (kind === 'session') return json('MODEL-WRITTEN SESSION BLOCK.');
  if (kind === 'record')  return json('Guillaume Manchon survived the trial and testified at the nullification in 1456.');
  const text = nextOutput === 'CLOSING' ? 'The ink dries on the parchment. Outside, the bells of Rouen.' : JSON.stringify(nextOutput);
  return body.stream ? sseStream(text) : json(text);
};
const { createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/game/api', createGameRouter(repos, { anthropicApiKey: 'manchon-crucible-test-key' }));
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const events = raw => raw.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
const quietly = async fn => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
const sse = (route, body) => quietly(async () => {
  const resp = await realFetch(`${BASE}/game/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const evs = events(await resp.text());
  return { done: evs.find(e => e.type === 'done'), error: evs.find(e => e.type === 'error') };
});
const closing = sessionId => quietly(async () => {
  const resp = await realFetch(`${BASE}/game/api/closing-prose?sessionId=${sessionId}&roleId=${ROLE_ID}&endResult=session_complete`);
  return events(await resp.text()).find(e => e.type === 'done');
});
const snapshot = dir => new Set(fs.existsSync(p(dir)) ? fs.readdirSync(p(dir)) : []);
// appData.saveSession writes the session state to the repo-root data/sessions (engine/data.js), not engine/data/sessions.
const beforeSessions = snapshot('engine/data/sessions'), beforeTranscripts = snapshot('engine/data/transcripts'), beforeState = snapshot('data/sessions');

const out = (minutes, extra = {}) => ({ narrative: 'Cauchon speaks; the quills move.', choices: ['Write it down', 'Look up', 'Wait'], location: 'great_hall_rouen_castle', timeAdvance: minutes, stateChanges: {}, ...extra });

async function play(option, minutes) {
  nextOutput = out(minutes);
  const st0 = await sse('start', { scenarioId: JOAN_ID, roleId: ROLE_ID, narrativeStyle: 'focused' });
  let s = st0.done?.nextState; const sid = st0.done?.sessionId;
  if (!s) return { ok: false, error: st0.error };
  const r = { ok: true, sid, fork: null, forkTurn: null, forkAt: null, forkScene: null, afterTurns: [], end: null };
  for (let t = 1; t <= 30; t++) {
    const answering = r.fork && !s.decisions?.[DM.id];
    // The model closes when the engine tells it to: FINAL TURN, at remaining <= 0 (buildClosingInstruction).
    const ending    = s.remainingMinutes <= 0;
    nextOutput = out(minutes, ending ? { endState: { isEnding: true, outcome: 'session_complete' } } : {});
    const body = { state: s, sessionId: sid, playerInput: answering ? option.text : `I write what is said (${t}).`, ...(answering ? { definingChoiceId: option.id } : {}) };
    lastTurnPrompt = null;
    const res = await sse('turn', body);
    if (!res.done) return { ...r, ok: false, error: res.error };
    const o = res.done.output;
    if (o.definingMoment && !r.fork) { r.fork = o; r.forkTurn = t; r.forkAt = s.elapsedMinutes; r.forkScene = s.currentSceneId; }
    else if (r.fork) r.afterTurns.push({ t, scene: s.currentSceneId, start: s.elapsedMinutes, decided: !!res.done.nextState.decisions?.[DM.id], prompt: lastTurnPrompt });
    if (!r.fork || o.definingMoment) (r.beforeTurns ||= []).push(lastTurnPrompt);
    s = res.done.nextState;
    if (o.endState?.isEnding) { r.end = { t, elapsed: s.elapsedMinutes }; break; }
  }
  r.state = s;
  modelCalls.length = 0;
  nextOutput = 'CLOSING';
  r.closing = await closing(sid);
  r.calls = [...modelCalls];
  return r;
}

try {
  for (const minutes of [2, 3]) {
    for (const option of DM.options) {
      head(`${option.id} — ${minutes}-minute turns`);
      const r = await play(option, minutes);
      check('session runs to its close', r.ok && !!r.end, JSON.stringify(r.error || '').slice(0, 200));
      if (!r.ok) continue;
      // In scene_28_may at turn start = the binding was met (a fallback reached elsewhere jumps the scene ON the fork turn).
      const via = r.forkScene === 'scene_28_may' ? 'binding' : 'fallback';
      check(`(2) the fork fires — turn ${r.forkTurn} at ${r.forkAt} min, in ${r.forkScene}, via ${via}`, !!r.fork);
      const opts = r.fork?.definingMoment?.options || [];
      check('(3) three choices, ids in order, SHORT labels on the buttons, full text kept',
        opts.length === 3 && opts.every((o, i) => o.id === DM.options[i].id && o.label === DM.options[i].label && o.text === DM.options[i].text) && !opts.some(o => 'debrief' in o),
        opts.map(o => o.label).join(' | '));
      const decided = r.afterTurns.find(x => x.decided);
      check(`(1) he answers IN scene_28_may and plays on in it — ${r.afterTurns.length} turn(s) after the fork, close at ${r.end?.elapsed} min`,
        !!decided && decided.scene === 'scene_28_may' && r.afterTurns.every(x => x.scene === 'scene_28_may') && r.afterTurns.length >= 1,
        r.afterTurns.map(x => `t${x.t}@${x.start}`).join(', '));
      check('decision recorded as this option', r.state.decisions?.[DM.id]?.option_id === option.id);
      const sb = r.closing?.epilogue?.session_block;
      check('(4) "Your Session" is the authored debrief, byte for byte', sb === option.debrief, (sb || '').slice(0, 80));
      check('(4) ...and no session-block model call was made (record block still written)', !r.calls.includes('session') && r.calls.includes('record') && !!r.closing?.epilogue?.record_block, r.calls.join(','));
      check('(6) the decision holds: every turn from the answer on carries "The player chose: <this option\'s text>"',
        r.afterTurns.length >= 1 && r.afterTurns.every(x => x.prompt?.includes(`⚑ DECISION MADE: The player chose: ${option.text}`) && !DM.options.some(o => o !== option && x.prompt.includes(o.text))),
        r.afterTurns.map(x => `t${x.t}:${x.prompt?.includes('DECISION MADE') ? 'held' : 'MISSING'}`).join(', '));
      check('(6) ...and no turn up to and including the fork carries it', (r.beforeTurns || []).length >= 1 && r.beforeTurns.every(x => typeof x === 'string' && !x.includes('DECISION MADE')));
      check('(5) no "could(n\'t) save her" in what the player reads', !BANNED.some(rx => rx.test(`${r.closing?.closing_prose || ''}\n${sb || ''}`)));
    }
  }
} finally {
  // /closing-prose keeps writing the transcript after it sends `done`: a file removed too early is
  // re-created by that late write. Let the writes land, then sweep twice.
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
  check('Manchon\'s stored role is untouched (byte-identical)', fs.readFileSync(p('engine/data/scenarios/player_roles', `${ROLE_ID}.json`), 'utf8') === ROLE_FILE);
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll manchon-crucible assertions passed.');
process.exit(fails ? 1 : 0);
