// MASSIEU WITNESS-CRUCIBLE — the second witness crucible, on Massieu's STORED role (his fork as
// written to prod 2026-10-05: at_scene scene_28_may, default 0.85 fallback, three authored
// options each with a short label and a verbatim debrief; two options share the witness debrief).
//
// Drives the REAL router (/start, /turn, /closing-prose) with api.anthropic.com scripted, for each
// of the three choices and at two turn costs (2 and 3 minutes), closing exactly as the client
// does (at remaining <= 0 unless the server granted grace). Checks, per run:
//   1. he reaches scene_28_may and PLAYS it — at least one turn after his answer, all in it;
//   2. the fork fires (via its binding, or its fallback);
//   3. the three choices are presented with their SHORT labels (full text kept, no debrief sent);
//   4. "Your Session" is the chosen option's authored debrief, byte for byte, with no
//      session-block model call — see_her / mark_what_is_done → witness, do_your_office → detached;
//   5. no debrief or setup says "could(n't) save her" (strict: no exceptions) or blames him;
//   6. the decision HOLDS from the answer turn on, naming only the chosen option's text;
//   7. grace is role-agnostic: an answer turn that reaches the target gets exactly one closing
//      turn under the ceiling; an answer with time left gets none, and no grace keys at all.
//
// Massieu's, Manchon's and Joan's stored roles are never written. Sessions and transcripts made
// here are deleted.

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
const store = new JsonFileStore(p('engine/data'));   // never DualWriteStore: no Supabase writes
const repos = {};
for (const [k, n] of [['characters', 'CharacterRepository'], ['locations', 'LocationRepository'], ['clues', 'ClueRepository'], ['scenarios', 'ScenarioRepository'], ['storyArcs', 'StoryArcRepository'], ['players', 'PlayerRepository'], ['sessions', 'SessionRepository']]) {
  repos[k] = new (await import(`${ROOT}/engine/repositories/${n}.js`))[n](store);
}
const { graceCeilingMinutes } = await import(`${ROOT}/engine/services/SessionTermination.js`);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

const JOAN_ID  = 'joan_trial_rouen_1431';
const ROLE_ID  = 'role_massieu';
const scenario = await repos.scenarios.findById(JOAN_ID);
const ROLE     = repos.scenarios.findPlayerRole(ROLE_ID);
const DM       = ROLE?.defining_moment;
if (!scenario || !DM) { console.log('SKIP  massieu-crucible.test — Joan scenario or Massieu\'s fork not available (needs restored data).'); process.exit(0); }
const roleFile = id => p('engine/data/scenarios/player_roles', `${id}.json`);
const STORED   = Object.fromEntries(['role_massieu', 'role_manchon', 'role_joan'].map(id => [id, fs.readFileSync(roleFile(id), 'utf8')]));

head('0. the stored block');
check('Massieu\'s fork: massieu_witnessing_choice, decision_made, bound at_scene scene_28_may, default fallback, no clock cost',
  DM.id === 'massieu_witnessing_choice' && DM.principal_transition?.type === 'decision_made' && DM.principal_transition?.moment === DM.id
  && DM.at_scene === 'scene_28_may' && DM.fallback_at_elapsed_fraction == null && DM.time_advance === 0 && DM.generated === false && DM.reviewed === true
  && DM.timing_confirmed?.at_scene === 'scene_28_may');
check('three options, each with a short label, full text and a debrief',
  DM.options?.length === 3 && DM.options.every(o => o.label && o.text && o.debrief && o.label.length < 50 && o.text.length > 150));
const OPT = Object.fromEntries(DM.options.map(o => [o.id, o]));
check('options in order: do_your_office, see_her, mark_what_is_done', DM.options.map(o => o.id).join(',') === 'do_your_office,see_her,mark_what_is_done');
const WITNESS = OPT.see_her?.debrief, DETACHED = OPT.do_your_office?.debrief;
check('see_her and mark_what_is_done share the witness debrief; do_your_office has the detached one',
  !!WITNESS && OPT.mark_what_is_done.debrief === WITNESS && DETACHED !== WITNESS);
const BANNED = [/could\s*n[o']t (have )?save(d)? her/i, /could not (have )?save(d)? her/i, /failed to save her/i, /your fault/i, /because of you/i];
check('STRICT: no debrief and no setup says "could(n\'t) save her" or blames him — no exceptions',
  [DM.setup, ...DM.options.map(o => o.debrief)].every(t => !BANNED.some(rx => rx.test(t))));
check('witness debrief: "Saving her was never yours to do" … "You were one."', WITNESS.includes('Saving her was never yours to do. But you could see her') && WITNESS.endsWith('That is what a witness is for. You were one.'));
check('detached debrief: "less to tell than a man who had stood so close should have" … "You chose not to be."',
  DETACHED.includes('you had less to tell than a man who had stood so close should have, because you had decided') && DETACHED.endsWith('You chose not to be.') && !/least to say/.test(DETACHED));

// ── scripted Anthropic ────────────────────────────────────────────────────────
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
let nextOutput = null, lastTurnPrompt = null;
const modelCalls = [];
function sseStream(text) {
  const events = [`data: ${JSON.stringify({ type: 'content_block_start', index: 0 })}\n\n`];
  for (let i = 0; i < text.length; i += 40) events.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 40) } })}\n\n`);
  events.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 100 } })}\n\n`);
  const body = new ReadableStream({ start(c) { const e = new TextEncoder(); for (const x of events) c.enqueue(e.encode(x)); c.close(); } });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const json = text => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  const sys  = typeof body.system === 'string' ? body.system : JSON.stringify(body.system || '');
  const kind = sys.includes('"Your Session"') ? 'session' : sys.includes('"Historical Record"') ? 'record' : 'other';
  modelCalls.push(kind);
  if (kind === 'other') { const m = body.messages?.at(-1)?.content; lastTurnPrompt = typeof m === 'string' ? m : JSON.stringify(m); }
  if (kind === 'session') return json('MODEL-WRITTEN SESSION BLOCK.');
  if (kind === 'record')  return json('Jean Massieu survived the trial and testified at the nullification in 1456.');
  const text = nextOutput === 'CLOSING' ? 'The door closes. Footsteps in the corridor.' : JSON.stringify(nextOutput);
  return body.stream ? sseStream(text) : json(text);
};
const { createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/game/api', createGameRouter(repos, { anthropicApiKey: 'massieu-crucible-test-key' }));
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const events = raw => raw.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
const quietly = async fn => { const l = console.log, w = console.warn; const logs = []; console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; try { return [await fn(), logs]; } finally { console.log = l; console.warn = w; } };
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

const out = (minutes, extra = {}) => ({ narrative: 'Massieu stands at the door; the bolt is drawn.', choices: ['Stand at the door', 'Look at her', 'Wait'], location: 'joan_prison_cell', timeAdvance: minutes, stateChanges: {}, ...extra });

async function play(option, minutes) {
  nextOutput = out(minutes);
  const [st0] = await sse('start', { scenarioId: JOAN_ID, roleId: ROLE_ID, narrativeStyle: 'focused' });
  let s = st0.done?.nextState; const sid = st0.done?.sessionId;
  if (!s) return { ok: false, error: st0.error };
  const r = { ok: true, sid, fork: null, forkTurn: null, forkAt: null, forkScene: null, afterTurns: [], beforeTurns: [], end: null, everGraceKey: false, graceLogs: [] };
  for (let t = 1; t <= 30; t++) {
    // The client's close rule (index.html): at remaining <= 0, unless the server granted grace.
    if (s.remainingMinutes <= 0 && !s.graceActive) { r.end = { t, elapsed: s.elapsedMinutes, by: 'client-time' }; break; }
    const answering = r.fork && !s.decisions?.[DM.id];
    nextOutput = out(minutes, s.remainingMinutes <= 0 ? { endState: { isEnding: true, outcome: 'session_complete' } } : {});
    const body = { state: s, sessionId: sid, playerInput: answering ? option.text : `I stand at the door (${t}).`, ...(answering ? { definingChoiceId: option.id } : {}) };
    lastTurnPrompt = null;
    const [res, logs] = await sse('turn', body);
    if (!res.done) return { ...r, ok: false, error: res.error };
    const o = res.done.output, n = res.done.nextState;
    r.graceLogs.push(...logs.filter(l => l.includes('[GRACE]')));
    if ('graceActive' in n || 'graceUsed' in n) r.everGraceKey = true;
    if (o.definingMoment && !r.fork) { r.fork = o; r.forkTurn = t; r.forkAt = s.elapsedMinutes; r.forkScene = s.currentSceneId; r.beforeTurns.push(lastTurnPrompt); }
    else if (r.fork) r.afterTurns.push({ t, scene: s.currentSceneId, start: s.elapsedMinutes, end: n.elapsedMinutes, answered: answering, decided: !!n.decisions?.[DM.id], grace: !!n.graceActive, wasGrace: !!s.graceActive, prompt: lastTurnPrompt });
    else r.beforeTurns.push(lastTurnPrompt);
    s = n;
    if (o.endState?.isEnding) { r.end = { t, elapsed: s.elapsedMinutes, by: 'isEnding' }; break; }
  }
  r.state = s;
  modelCalls.length = 0;
  nextOutput = 'CLOSING';
  [r.closing] = await closing(sid);
  r.calls = [...modelCalls];
  return r;
}

const CEILING = graceCeilingMinutes(scenario);
let graceRuns = 0, noGraceRuns = 0;
try {
  for (const minutes of [2, 3]) {
    for (const option of DM.options) {
      head(`${option.id} — ${minutes}-minute turns`);
      const r = await play(option, minutes);
      check('session runs to its close', r.ok && !!r.end, JSON.stringify(r.error || '').slice(0, 200));
      if (!r.ok) continue;
      const via = r.forkScene === 'scene_28_may' ? 'binding' : 'fallback';
      check(`(2) the fork fires — turn ${r.forkTurn} at ${r.forkAt} min, in ${r.forkScene}, via ${via}`, !!r.fork);
      const opts = r.fork?.definingMoment?.options || [];
      check('(3) three choices, ids in order, SHORT labels on the buttons, full text kept, no debrief sent',
        opts.length === 3 && opts.every((o, i) => o.id === DM.options[i].id && o.label === DM.options[i].label && o.text === DM.options[i].text) && !opts.some(o => 'debrief' in o),
        opts.map(o => o.label).join(' | '));
      const answer = r.afterTurns.find(x => x.answered);
      check(`(1) he answers IN scene_28_may and plays on in it — ${r.afterTurns.length} turn(s) after the fork, close at ${r.end?.elapsed} min (${r.end?.by})`,
        !!answer && answer.decided && answer.scene === 'scene_28_may' && r.afterTurns.every(x => x.scene === 'scene_28_may') && r.afterTurns.length >= 1,
        r.afterTurns.map(x => `t${x.t}@${x.start}${x.wasGrace ? '(grace)' : ''}`).join(', '));
      check('decision recorded as this option', r.state.decisions?.[DM.id]?.option_id === option.id);
      const sb = r.closing?.epilogue?.session_block;
      const want = option.id === 'do_your_office' ? DETACHED : WITNESS;
      check(`(4) "Your Session" is the ${option.id === 'do_your_office' ? 'DETACHED' : 'WITNESS'} debrief, byte for byte`, sb === want && sb === option.debrief, (sb || '').slice(0, 70));
      check('(4) ...and no session-block model call was made (record block still written)', !r.calls.includes('session') && r.calls.includes('record') && !!r.closing?.epilogue?.record_block, r.calls.join(','));
      check('(5) no "could(n\'t) save her" in what the player reads', !BANNED.some(rx => rx.test(`${r.closing?.closing_prose || ''}\n${sb || ''}`)));
      const others = DM.options.filter(o => o !== option);
      check('(6) the decision holds: every turn from the answer on carries "The player chose: <this option\'s text>", never another option\'s text',
        r.afterTurns.length >= 1 && r.afterTurns.every(x => x.prompt?.includes(`⚑ DECISION MADE: The player chose: ${option.text}`) && !others.some(o => x.prompt.includes(o.text))),
        r.afterTurns.map(x => `t${x.t}:${x.prompt?.includes('DECISION MADE') ? 'held' : 'MISSING'}`).join(', '));
      check('(6) ...the courses not taken are listed by label as what NOT to offer',
        r.afterTurns.every(x => others.every(o => x.prompt.includes(`\n- ${o.label}`))));
      check('(6) ...and no turn up to and including the fork carries it', r.beforeTurns.length >= 1 && r.beforeTurns.every(x => typeof x === 'string' && !x.includes('DECISION MADE')));
      // (7) grace — no Massieu-specific code anywhere; the same rule as every role.
      if (answer && answer.end >= (scenario.sessionTargetMinutes || 15)) {
        graceRuns++;
        const g = r.afterTurns.filter(x => x.wasGrace);
        check(`(7) answer reached the target (${answer.start}→${answer.end}) → grace: ONE closing turn, ends under the ceiling ${CEILING}`,
          answer.grace && g.length === 1 && r.end.by === 'isEnding' && r.end.elapsed <= CEILING && r.graceLogs.some(l => /\[GRACE\] used — decision_just_recorded/.test(l)) && !('graceActive' in r.state) && r.state.graceUsed === true,
          `close at ${r.end.elapsed}`);
        check('(7) ...and the grace turn is the FINAL TURN carrying the decision hold', g[0]?.prompt?.includes('FINAL TURN') && g[0].prompt.includes('⚑ DECISION MADE'));
      } else {
        noGraceRuns++;
        check(`(7) answer with time left (${answer?.start}→${answer?.end}) → no grace, no grace keys, closes at the target`, !r.everGraceKey && !r.graceLogs.length && r.end.by === 'client-time' && r.end.elapsed === (scenario.sessionTargetMinutes || 15));
      }
    }
  }
  check(`both grace paths were exercised (${graceRuns} run(s) with grace, ${noGraceRuns} without)`, graceRuns > 0 && noGraceRuns > 0);
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
  check('Massieu\'s, Manchon\'s and Joan\'s stored roles are untouched (byte-identical)', Object.entries(STORED).every(([id, txt]) => fs.readFileSync(roleFile(id), 'utf8') === txt));
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll massieu-crucible assertions passed.');
process.exit(fails ? 1 : 0);
