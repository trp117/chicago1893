// SOFT TARGET + GRACE MARGIN — the session paces to its target and may run ONE closing turn past
// it, under a ceiling, only to finish a crucible in progress at the target (SessionTermination.js).
//
//   1. the grant rule, on a synthetic scenario: when grace is granted, refused, latched, bounded;
//      a refusal touches nothing (no graceActive/graceUsed keys) — the byte-identical gate;
//   2. PACING ISOLATION: the ceiling symbols live only in SessionTermination.js and the router's
//      termination block; PromptComposer/StateManager never reference grace; the pacing functions
//      and the whole model request are identical with and without the grace keys on state;
//   3. the client's two close rules — and only those — read graceActive;
//   4. end to end through the REAL router (api.anthropic.com scripted), on Manchon's stored role:
//      a. an answer turn that crosses the target → one grace turn → FINAL TURN + decision hold →
//         closes (by the model, or forced) under the ceiling; DIAG logged; debrief still verbatim;
//      b. a fork PUT on the turn that crosses the target → the grace turn is the answer turn and
//         closes on it (answer + consequence in one turn);
//      c. a crucible finished before the target → no grace, no grace keys, ever.
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

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const quietly = async fn => { const l = console.log, w = console.warn; const logs = []; console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; try { return [await fn(), logs]; } finally { console.log = l; console.warn = w; } };

const { grantGrace, closeGraceTurn, graceCeilingMinutes, graceDiagLine } = await import(`${ROOT}/engine/services/SessionTermination.js`);
const PC = await import(`${ROOT}/engine/services/PromptComposer.js`);
const { mergeState } = await import(`${ROOT}/engine/services/StateManager.js`);

// ── 1. the grant rule (synthetic) ─────────────────────────────────────────────
head('1. grant rule');
const SYN = {
  id: 'syn', sessionTargetMinutes: 30, systems: { timePerTurnDefault: 3 },
  defining_moment: { principal_transition: { type: 'decision_made', moment: 'm' }, at_elapsed_fraction: 0.6, time_advance: 0,
    options: [{ id: 'a', text: 'Do A.' }, { id: 'b', text: 'Do B.' }] },
};
const at = (elapsed, extra = {}) => ({ elapsedMinutes: elapsed, remainingMinutes: Math.max(0, 30 - elapsed), decisions: {}, ...extra });
const grant = (s, o) => quietly(() => grantGrace(s, SYN, o)).then(([g]) => g);
const untouched = s => !('graceActive' in s) && !('graceUsed' in s);

check('ceiling = round(target × 1.2) = 36', graceCeilingMinutes(SYN) === 36 && graceCeilingMinutes({ sessionTargetMinutes: 15 }) === 18);
let s = at(28);
check('time left → no grace, state untouched', (await grant(s, { decisionRecordedThisTurn: true })) === null && untouched(s));
s = at(30);
check('at target, no crucible (no decision this turn, no fork this turn) → none', (await grant(s, {})) === null && untouched(s));
s = at(30, { decisions: { m: { option_id: 'a' } }, definingMomentPresented: true });
check('at target, crucible finished earlier (decided on an earlier turn) → none', (await grant(s, {})) === null && untouched(s));
s = at(30, { definingMomentPresented: true });
check('at target, fork put EARLIER and answered with free text → none (it is never re-presented)', (await grant(s, {})) === null && untouched(s));
s = at(30);
check('at target but the turn is ending → none', (await grant(s, { decisionRecordedThisTurn: true, isEnding: true })) === null && untouched(s));
s = at(30, { decisions: { m: { option_id: 'a' } } });
let g = await grant(s, { decisionRecordedThisTurn: true });
check('decision recorded on the turn that reached the target → grace', g?.reason === 'decision_just_recorded' && s.graceActive === true && s.graceUsed === true, JSON.stringify(g));
s = at(31, { definingMomentPresented: true });
g = await grant(s, { forkPresentedThisTurn: true });
check('fork put on the turn that reached the target → grace (fork_unanswered)', g?.reason === 'fork_unanswered' && s.graceActive === true);
s = at(32, { decisions: { m: { option_id: 'a' } }, graceUsed: true });
check('latched: a session that already used grace never gets it again', (await grant(s, { decisionRecordedThisTurn: true })) === null && !('graceActive' in s));
s = at(34, { decisions: { m: { option_id: 'a' } } });
check('ceiling: no grace when one more turn (3 min) would pass 36', (await grant(s, { decisionRecordedThisTurn: true })) === null && untouched(s));
s = at(33, { decisions: { m: { option_id: 'a' } } });
check('...but 33 + 3 = 36 fits', (await grant(s, { decisionRecordedThisTurn: true }))?.reason === 'decision_just_recorded');

let ns = { elapsedMinutes: 33, graceActive: true, graceUsed: true }, out = { narrative: 'x' };
let [by] = await quietly(() => closeGraceTurn({ graceActive: true }, ns, out));
check('grace turn: the engine forces isEnding when the model did not set it', by === 'forced' && out.endState?.isEnding === true && out.endState.outcome === 'session_complete' && !('graceActive' in ns) && ns.graceUsed === true);
ns = { graceActive: true }; out = { endState: { isEnding: true, outcome: 'x' } };
[by] = await quietly(() => closeGraceTurn({ graceActive: true }, ns, out));
check('grace turn: a model close is kept as is', by === 'model' && out.endState.outcome === 'x');
ns = { elapsedMinutes: 20 }; out = { narrative: 'x' };
[by] = await quietly(() => closeGraceTurn({ elapsedMinutes: 18 }, ns, out));
check('not a grace turn → null, nothing touched', by === null && !out.endState && Object.keys(ns).length === 1);
check('DIAG line only when grace is used or closes', graceDiagLine('> ⚑ DIAG ', {}) === null
  && /grace: USED — decision_just_recorded at 30 min \(target 30, ceiling 36\)/.test(graceDiagLine('> ⚑ DIAG ', { grant: { reason: 'decision_just_recorded', elapsed: 30, target: 30, ceiling: 36 } })));

// ── 2. pacing isolation ───────────────────────────────────────────────────────
head('2. pacing isolation');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (['data', 'node_modules'].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const code = [...walk(p('engine')), ...walk(p('lib'))].filter(f => /\.(m?js|html)$/.test(f));
const users = rx => code.filter(f => rx.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(REPO_DIR, f).replace(/\\/g, '/')).sort();
const ceilingUsers = users(/graceCeilingMinutes|GRACE_CEILING_FACTOR/);
check('the ceiling is defined and used only in SessionTermination.js', JSON.stringify(ceilingUsers) === JSON.stringify(['engine/services/SessionTermination.js']), ceilingUsers.join(', '));
const importers = users(/from ['"][./]*(services\/)?SessionTermination\.js['"]/);
check('...which only the router imports (its termination block: grantGrace / closeGraceTurn / graceDiagLine)', JSON.stringify(importers) === JSON.stringify(['engine/server/gameRouter.js']), importers.join(', '));
const graceUsers = users(/graceActive|graceUsed/);
check('grace state is touched only by SessionTermination.js, the router, the client close rule and PromptComposer\'s strip list',
  JSON.stringify(graceUsers) === JSON.stringify(['engine/game/index.html', 'engine/server/gameRouter.js', 'engine/services/PromptComposer.js', 'engine/services/SessionTermination.js']), graceUsers.join(', '));
const pcLines = fs.readFileSync(p('engine/services/PromptComposer.js'), 'utf8').split('\n').filter(l => /grace/i.test(l)).map(l => l.trim());
check('PromptComposer mentions grace ONLY to strip the keys from the model\'s state block (+ its comment)',
  pcLines.length === 3 && pcLines.includes('graceActive, graceUsed,') && pcLines.filter(l => l.startsWith('//')).length === 2, pcLines.join(' | '));
for (const f of ['engine/services/StateManager.js', 'engine/services/ForkDiagnostics.js']) {
  check(`${f} knows nothing of grace`, !/grace/i.test(fs.readFileSync(p(f), 'utf8')));
}

const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const store = new JsonFileStore(p('engine/data'));   // never DualWriteStore: no Supabase writes
const repoNames = [['characters', 'CharacterRepository'], ['locations', 'LocationRepository'], ['clues', 'ClueRepository'], ['scenarios', 'ScenarioRepository'], ['storyArcs', 'StoryArcRepository'], ['players', 'PlayerRepository'], ['sessions', 'SessionRepository']];
const repos = {};
for (const [k, n] of repoNames) repos[k] = new (await import(`${ROOT}/engine/repositories/${n}.js`))[n](store);

const JOAN_ID = 'joan_trial_rouen_1431', ROLE_ID = 'role_manchon';
const joan = await repos.scenarios.findById(JOAN_ID);
const ROLE = repos.scenarios.findPlayerRole(ROLE_ID);
const DM   = ROLE?.defining_moment;
if (!joan || !DM) { console.log('SKIP  sections 2b–4 — Joan scenario or Manchon\'s fork not available (needs restored data).'); process.exit(fails ? 1 : 0); }
const ROLE_FILE = fs.readFileSync(p('engine/data/scenarios/player_roles', `${ROLE_ID}.json`), 'utf8');
const arc = repos.storyArcs.findById(joan.storyArcIds?.[0]);

// The pacing functions, called on the same state with and without the grace keys.
const pacing = st => JSON.stringify([
  PC.getArcPosition(st.remainingMinutes, joan.sessionTargetMinutes),
  PC.timeToPeriodString(st.remainingMinutes, joan.sessionTargetMinutes, joan.sessionStartTime || null),
  PC.checkEndingReadiness(st, joan),
  PC.scenePacingStatus(st, joan, arc),
  PC.definingMomentDue(st, joan, arc),
  PC.buildDefiningMomentInstruction(st, joan, arc),
  PC.buildDecisionHoldDirective(st, joan),
  (({ elapsedMinutes, remainingMinutes, turnsAtZero, currentSceneId }) => ({ elapsedMinutes, remainingMinutes, turnsAtZero, currentSceneId }))(mergeState(st, { timeAdvance: 3, stateChanges: {} }, joan, [], '', [])),
]);

// ── scripted Anthropic + the real router ──────────────────────────────────────
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
let nextOutput = null, turnReqs = [];
const sse = text => {
  const ev = [`data: ${JSON.stringify({ type: 'content_block_start', index: 0 })}\n\n`, `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`, `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}\n\n`];
  return new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); ev.forEach(x => c.enqueue(e.encode(x))); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
const json = text => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  const sys  = JSON.stringify(body.system || '');
  if (sys.includes('"Your Session"')) return json('MODEL-WRITTEN SESSION BLOCK.');
  if (sys.includes('"Historical Record"')) return json('Guillaume Manchon survived the trial.');
  turnReqs.push(body);
  const text = nextOutput === 'CLOSING' ? 'The ink dries.' : JSON.stringify(nextOutput);
  return body.stream ? sse(text) : json(text);
};
const { createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/game/api', createGameRouter(repos, { anthropicApiKey: 'grace-test-key' }));
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const events = raw => raw.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
const call = (route, body) => quietly(async () => {
  const resp = await realFetch(`${BASE}/game/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const evs = events(await resp.text());
  return { done: evs.find(e => e.type === 'done'), error: evs.find(e => e.type === 'error') };
});
const snapshot = dir => new Set(fs.existsSync(p(dir)) ? fs.readdirSync(p(dir)) : []);
// appData.saveSession writes the session state to the repo-root data/sessions (engine/data.js).
const beforeSessions = snapshot('engine/data/sessions'), beforeTranscripts = snapshot('engine/data/transcripts'), beforeState = snapshot('data/sessions');
const out3 = (m, extra = {}) => ({ narrative: 'Cauchon speaks; the quills move.', choices: ['Write it down', 'Look up', 'Wait'], location: 'great_hall_rouen_castle', timeAdvance: m, stateChanges: {}, ...extra });

// Plays Manchon to his close, closing exactly as the client does: at remaining <= 0 unless the
// server granted grace. `forkCost` re-authors the fork's clock cost on the CLIENT-HELD state only
// (state.effectiveDefiningMoment), so the stored role is never written.
async function play({ minutes, option, modelCloses = true, forkCost = null }) {
  nextOutput = out3(minutes);
  const [st0] = await call('start', { scenarioId: JOAN_ID, roleId: ROLE_ID, narrativeStyle: 'focused' });
  let s = st0.done?.nextState; const sid = st0.done?.sessionId;
  if (!s) return { ok: false, error: st0.error };
  if (forkCost != null) s.effectiveDefiningMoment = { ...s.effectiveDefiningMoment, time_advance: forkCost };
  const r = { ok: true, sid, turns: [], everGraceKey: false };
  let last = st0.done.output;
  for (let t = 1; t <= 30; t++) {
    if (s.remainingMinutes <= 0 && !s.graceActive) { r.closedBy = 'client-time'; break; }
    const fork = last.definingMoment;
    const zero = s.remainingMinutes <= 0;
    nextOutput = out3(minutes, zero && modelCloses ? { endState: { isEnding: true, outcome: 'session_complete' } } : {});
    turnReqs = [];
    const body = { state: s, sessionId: sid, playerInput: fork ? option.text : `I write what is said (${t}).`, ...(fork ? { definingChoiceId: option.id } : {}) };
    const [res, logs] = await call('turn', body);
    if (!res.done) return { ...r, ok: false, error: res.error };
    const o = res.done.output, n = res.done.nextState;
    r.turns.push({ t, startElapsed: s.elapsedMinutes, endElapsed: n.elapsedMinutes, forkPut: !!o.definingMoment, answered: !!fork, grace: !!n.graceActive, wasGrace: !!s.graceActive,
      prompt: turnReqs[0]?.messages?.at(-1)?.content, req: turnReqs[0], logs: logs.filter(l => l.includes('[GRACE]')), isEnding: !!o.endState?.isEnding, body });
    if ('graceActive' in n || 'graceUsed' in n) r.everGraceKey = true;
    s = n; last = o;
    if (o.endState?.isEnding) { r.closedBy = 'isEnding'; break; }
  }
  r.state = s;
  nextOutput = 'CLOSING';
  const [cl] = await quietly(async () => {
    const resp = await realFetch(`${BASE}/game/api/closing-prose?sessionId=${sid}&roleId=${ROLE_ID}&endResult=session_complete`);
    return events(await resp.text()).find(e => e.type === 'done');
  });
  r.closing = cl;
  // /closing-prose sends `done` before its transcript rewrite lands — wait for the closing sections.
  const tf = p('engine/data/transcripts', `${sid}.md`);
  for (let i = 0; i < 50; i++) {
    r.transcript = fs.existsSync(tf) ? fs.readFileSync(tf, 'utf8') : '';
    if (r.transcript.includes('## Session Close')) break;
    await new Promise(res => setTimeout(res, 100));
  }
  return r;
}

const COMP = DM.options.find(o => o.id === 'record_as_required');
const CEILING = graceCeilingMinutes(joan);
try {
  // ── 4a. answer turn crosses the target ──────────────────────────────────────
  head('4a. answer turn crosses the target (3-minute turns) — model closes');
  const a = await play({ minutes: 3, option: COMP });
  const ans = a.turns.find(x => x.answered), gt = a.turns.find(x => x.wasGrace);
  check('the answer turn reaches the target and grace is granted on it', !!ans && ans.endElapsed >= joan.sessionTargetMinutes && ans.grace && ans.logs.some(l => /\[GRACE\] used — decision_just_recorded/.test(l)), `answer ${ans?.startElapsed}→${ans?.endElapsed}`);
  check('exactly ONE grace turn, and it closes the session', a.turns.filter(x => x.wasGrace).length === 1 && gt?.isEnding && a.closedBy === 'isEnding' && gt === a.turns.at(-1));
  check('the grace turn is the FINAL TURN and carries the decision hold', gt?.prompt?.includes('FINAL TURN') && gt.prompt.includes(`⚑ DECISION MADE: The player chose: ${COMP.text}`));
  check(`it ends under the ceiling (${CEILING})`, a.state.elapsedMinutes <= CEILING && a.state.elapsedMinutes > joan.sessionTargetMinutes, `${a.state.elapsedMinutes} min`);
  check('graceActive is cleared on close; graceUsed latched', !('graceActive' in a.state) && a.state.graceUsed === true);
  check('DIAG: grace used + closing turn written to the transcript', /> ⚑ DIAG grace: USED — decision_just_recorded/.test(a.transcript) && /> ⚑ DIAG grace: closing turn — ended at \d+ min .*isEnding by model/.test(a.transcript));
  check('"Your Session" is still the compliance debrief, byte for byte', a.closing?.epilogue?.session_block === COMP.debrief);

  // pacing isolation on the live state at the target: same request, with and without grace keys
  const at30 = ans.body.state;   // the answer turn's incoming state is a real mid-crucible state
  const withKeys = { ...at30, graceActive: true, graceUsed: true };
  check('pacing functions identical with/without grace keys (answer-turn state)', pacing(at30) === pacing(withKeys));
  const zeroState = gt.body.state, zeroBare = { ...zeroState }; delete zeroBare.graceActive; delete zeroBare.graceUsed;
  check('pacing functions identical with/without grace keys (state at the target)', pacing(zeroState) === pacing(zeroBare));
  const reqOf = async st => { turnReqs = []; nextOutput = out3(3); await call('turn', { ...gt.body, state: st, sessionId: undefined }); return JSON.stringify(turnReqs[0] ? { system: turnReqs[0].system, messages: turnReqs[0].messages } : null); };
  const rq1 = await reqOf(zeroState), rq2 = await reqOf(zeroBare);
  check('the whole model request (system + prompt) is byte-identical with/without the grace keys', rq1 === rq2 && rq1 !== 'null');

  head('4a\'. same, but the model does not close on the grace turn');
  const a2 = await play({ minutes: 3, option: COMP, modelCloses: false });
  const gt2 = a2.turns.find(x => x.wasGrace);
  check('the engine forces the close on the grace turn — no runaway', gt2?.isEnding && a2.closedBy === 'isEnding' && a2.turns.filter(x => x.wasGrace).length === 1 && gt2.logs.some(l => /isEnding by forced/.test(l)), `${a2.state.elapsedMinutes} min`);

  // ── 4b. fork put on the turn that crosses the target ────────────────────────
  head('4b. fork PUT on the turn that crosses the target (fork re-authored to cost 3 min, client-side)');
  const b = await play({ minutes: 3, option: COMP, forkCost: 3 });
  const fput = b.turns.find(x => x.forkPut), bans = b.turns.find(x => x.answered);
  check('the fork is put on the turn that reaches the target, and grace is granted (fork_unanswered)', !!fput && fput.endElapsed >= joan.sessionTargetMinutes && fput.grace && fput.logs.some(l => /fork_unanswered/.test(l)), `fork ${fput?.startElapsed}→${fput?.endElapsed}`);
  check('the grace turn IS the answer turn: decision recorded, FINAL TURN + decision hold, closes on it', bans?.wasGrace && bans.isEnding && bans.prompt?.includes('FINAL TURN') && bans.prompt.includes(`⚑ DECISION MADE: The player chose: ${COMP.text}`) && b.state.decisions?.[DM.id]?.option_id === COMP.id && bans === b.turns.at(-1));
  check('...under the ceiling, and the debrief is the compliance debrief', b.state.elapsedMinutes <= CEILING && b.closing?.epilogue?.session_block === COMP.debrief, `${b.state.elapsedMinutes} min`);

  // ── 4c. crucible finished before the target ─────────────────────────────────
  head('4c. crucible finished before the target (2-minute turns)');
  const c = await play({ minutes: 2, option: COMP });
  const cans = c.turns.find(x => x.answered);
  check('decision recorded with time left; the session closes at the target as today', !!cans && cans.endElapsed < joan.sessionTargetMinutes && c.closedBy === 'client-time' && c.state.elapsedMinutes === joan.sessionTargetMinutes, `answer at ${cans?.startElapsed}, close at ${c.state.elapsedMinutes}`);
  check('no grace key ever appears on its state; no [GRACE] log; no grace DIAG', !c.everGraceKey && c.turns.every(x => !x.logs.length) && !/DIAG grace/.test(c.transcript));
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
}

// ── 3. the client close rules ──────────────────────────────────────────────────
head('3. client close rules');
const html = fs.readFileSync(p('engine/game/index.html'), 'utf8');
const closes = html.match(/if \(gameState\??\.remainingMinutes <= 0[^)]*\)/g) || [];
check('both client close rules (submit guard + post-turn expiry) skip a granted grace turn, and there is no other',
  closes.length === 2 && closes.every(x => /&& !gameState\??\.graceActive\)$/.test(x)), closes.join(' | '));

check('sessions and transcripts created by this test are removed',
  [...snapshot('engine/data/sessions')].every(f => beforeSessions.has(f)) && [...snapshot('engine/data/transcripts')].every(f => beforeTranscripts.has(f)) && [...snapshot('data/sessions')].every(f => beforeState.has(f)));
check('Manchon\'s stored role is untouched (byte-identical)', fs.readFileSync(p('engine/data/scenarios/player_roles', `${ROLE_ID}.json`), 'utf8') === ROLE_FILE);

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll grace assertions passed.');
process.exit(fails ? 1 : 0);
