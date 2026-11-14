// DEMO_MODE Phase 2 — spend cap, per-IP daily cap, rate limit, /extract-facts, demo transcripts.
//
//   node tests/demo-limits.test.mjs
//
// In-process: the REAL createGameRouter on a real socket, with api.anthropic.com replaced by a
// scripted stand-in (the degradation.test idiom) that reports a known usage block, and the demo
// store replaced by the in-memory twin of the Supabase store. No model, no Supabase table.
//
// Flag OFF: no demo store is touched, nothing is metered or limited, /extract-facts still calls
// its model, transcripts still go to disk.
// Flag ON: budget refuses a new /start at the start ceiling and a /turn at the hard ceiling;
// the 3rd /start from one IP is refused; the rate limiter 429s over its ceiling; a demo session
// writes its transcript row with the free-form input captured; metering adds the right cents.
// Plus the client half: the injected demo script shows the limit copy (jsdom).
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
const { createMemoryDemoStore } = await import(`${ROOT}/engine/server/demoStore.js`);
const { costCents, DEMO_LIMIT_COPY, createBudget } = await import(`${ROOT}/engine/server/demoLimits.js`);
const { injectDemoIntoGameHtml } = await import(`${ROOT}/engine/server/demoMode.js`);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n          ${detail}` : ''}`);
  if (!ok) failed++;
};
const section = t => console.log(`\n── ${t}`);
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));

const SCENARIO_ID = 'chicago_1893_v1';
const ROLE_ID     = 'daniel_burnham';

// ── Scripted api.anthropic.com ───────────────────────────────────────────────
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
const USAGE = { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 4000, output_tokens: 100 };
let calls = [];
let reply = null;
const OPENING = JSON.stringify({ narrative: 'The telegraph key is still warm under your palm.', choices: ['Study the signature', 'Send for security'], location: 'administration_building', timeAdvance: 0 });
const TURN    = JSON.stringify({ narrative: 'You lean in over the order.', choices: ['Read it again', 'Call your assistant'], location: 'administration_building', timeAdvance: 2 });

function sse(text) {
  const ev = [
    { type: 'message_start', message: { usage: { ...USAGE, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0 },
    ...Array.from({ length: Math.ceil(text.length / 40) }, (_, i) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i * 40, i * 40 + 40) } })),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: USAGE.output_tokens } },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`);
  return new Response(new ReadableStream({ start(c) { const enc = new TextEncoder(); ev.forEach(e => c.enqueue(enc.encode(e))); c.close(); } }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  calls.push({ model: body.model, stream: !!body.stream });
  if (body.model?.startsWith('claude-haiku')) {
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '["You learned something."]' }], stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 10 } }), { status: 200 });
  }
  // The reply is set by the driver: start() -> OPENING, turn() -> TURN.
  return body.stream ? sse(reply)
                     : new Response(JSON.stringify({ content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: USAGE }), { status: 200 });
};

// ── Repos (disk only — never Supabase) ───────────────────────────────────────
const store = new JsonFileStore(p('engine/data'));
const repos = {
  characters: new CharacterRepository(store), locations: new LocationRepository(store), clues: new ClueRepository(store),
  scenarios: new ScenarioRepository(store), storyArcs: new StoryArcRepository(store), players: new PlayerRepository(store),
  sessions: new SessionRepository(store),
};
let scenarioOk = false;
try { scenarioOk = !!(await repos.scenarios.findById(SCENARIO_ID)) && !!repos.scenarios.findPlayerRoles(SCENARIO_ID).find(r => r.id === ROLE_ID); } catch {}
if (!scenarioOk) {
  console.log(`SKIP  demo-limits.test — scenario "${SCENARIO_ID}" / role "${ROLE_ID}" not available (needs restored data + Supabase creds).`);
  globalThis.fetch = realFetch;
  process.exit(0);
}
const { createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);

// Snapshot dirs: every /start writes a session file and a transcript; remove what we add.
const snapshot = dir => { try { return new Set(fs.readdirSync(p(dir))); } catch { return new Set(); } };
const before = { 'engine/data/sessions': snapshot('engine/data/sessions'), 'engine/data/transcripts': snapshot('engine/data/transcripts'), 'data/sessions': snapshot('data/sessions') };

const servers = [];
async function mount(config) {
  const app = express();
  app.set('trust proxy', 1);    // as server.js — req.ip from X-Forwarded-For
  app.use(express.json({ limit: '10mb' }));
  app.use('/game/api', createGameRouter(repos, { anthropicApiKey: 'demo-limits-test-key', ...config }));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/game/api`;
}
async function req(base, method, route, body, ip = '203.0.113.1') {
  const resp = await realFetch(base + route, {
    method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await resp.text();
  const events = raw.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  let json = null; try { json = JSON.parse(raw); } catch {}
  return { status: resp.status, json, events, done: events.find(e => e.type === 'done') };
}
const start = (base, ip, extra = {}) => (reply = OPENING, req(base, 'POST', '/start', { scenarioId: SCENARIO_ID, roleId: ROLE_ID, narrativeStyle: 'focused', ...extra }, ip));
const turn  = (base, ip, s, input, extra = {}) => (reply = TURN, req(base, 'POST', '/turn', { state: s.nextState, playerInput: input, sessionId: s.sessionId, history: [], ...extra }, ip));

// A spy with the store interface: any call at all is a failure when the flag is off.
const spy = { calls: [] };
for (const m of ['readBudget', 'addBudget', 'startTranscript', 'appendTurn', 'patchTranscript']) spy[m] = async () => { spy.calls.push(m); return 0; };

const DEMO = { demoMode: true, demoScenarios: [SCENARIO_ID] };
const BIG  = { globalPerMin: 1000, ipPerMin: 1000, dailyStartsPerIp: 1000, budgetRefreshMs: 0 };

try {
  // ── Pricing ────────────────────────────────────────────────────────────────
  section('pricing');
  check('Sonnet 4.6: 1000 in + 2000 cw + 4000 cr + 100 out = 1.32¢', Math.abs(costCents('claude-sonnet-4-6', USAGE) - 1.32) < 1e-9, costCents('claude-sonnet-4-6', USAGE));
  check('Haiku 4.5: 50 in + 10 out = 0.01¢', Math.abs(costCents('claude-haiku-4-5-20251001', { input_tokens: 50, output_tokens: 10 }) - 0.01) < 1e-9);
  check('unknown model is priced as Sonnet, never free', costCents('claude-new-model', USAGE) === costCents('claude-sonnet-4-6', USAGE));

  // ── Flag OFF ───────────────────────────────────────────────────────────────
  section('flag OFF — nothing demo happens');
  {
    const base = await mount({ demoStore: spy, demoLimits: { ipPerMin: 1, dailyStartsPerIp: 1, globalPerMin: 1 } });
    calls = [];
    const starts = [];
    for (let i = 0; i < 4; i++) starts.push(await start(base, '198.51.100.7'));
    check('4 /start from one IP all succeed (no daily cap, no rate limit)', starts.every(s => s.status === 200 && s.done), starts.map(s => s.status).join(','));
    const t = await turn(base, '198.51.100.7', starts[0].done, 'I look around the office.', { player_action: 'I look around the office.' });
    check('/turn succeeds', t.status === 200 && !!t.done);
    const xf = await req(base, 'POST', '/extract-facts', { narrative: 'You saw the forged order.', existingFacts: [] });
    check('/extract-facts still calls its Haiku model and returns its facts', xf.status === 200 && xf.json?.newFacts?.[0] === 'You learned something.' && calls.some(c => c.model.startsWith('claude-haiku')));
    await tick(150);
    check('no demo store method was called (no budget table, no demo transcript)', spy.calls.length === 0, spy.calls.join(','));
    const sid = starts[0].done.sessionId;
    const disk = p('engine/data/transcripts', `${sid}.md`);
    check('transcripts still go to disk (and carry the turn)', fs.existsSync(disk) && fs.readFileSync(disk, 'utf8').includes('**Player:** I look around the office.'));
    const tts = await req(base, 'POST', '/tts', { text: 'x' });
    check('/tts is not demo-refused (503 not configured)', tts.status === 503);
  }

  // ── Budget ─────────────────────────────────────────────────────────────────
  section('flag ON — budget');
  {
    const mem = createMemoryDemoStore({ spentCents: 0 });
    const base = await mount({ ...DEMO, demoStore: mem, demoLimits: BIG });
    calls = [];
    const s = await start(base, '192.0.2.10');
    await tick();
    check('/start under the ceiling plays', s.status === 200 && !!s.done);
    check('the opening call was metered at its real cost (1.32¢)', Math.abs(mem.state.spentCents - 1.32) < 1e-9, mem.state.spentCents);

    mem.state.spentCents = 9000;   // $90.00 — the start ceiling
    calls = [];
    const refused = await start(base, '192.0.2.11');
    check('/start at $90 → 403 budget, the friendly copy, no model call', refused.status === 403 && refused.json?.demoLimit === 'budget'
      && refused.json?.error === DEMO_LIMIT_COPY.budget && refused.json?.retryable === false && calls.length === 0, JSON.stringify(refused.json));
    const midTurn = await turn(base, '192.0.2.10', s.done, 'Keep going.');
    check('/turn at $90 still plays (in-progress sessions finish)', midTurn.status === 200 && !!midTurn.done);

    mem.state.spentCents = 9800;   // $98.00 — the hard ceiling
    calls = [];
    const hard = await turn(base, '192.0.2.10', s.done, 'One more.');
    check('/turn at $98 → 403 budget, no model call', hard.status === 403 && hard.json?.demoLimit === 'budget' && calls.length === 0, JSON.stringify(hard.json));
    const closing = await req(base, 'GET', `/closing-prose?sessionId=${s.done.sessionId}`, null, '192.0.2.10');
    check('/closing-prose at $98 → the SSE error the client turns into the authored closing', closing.events.length === 1
      && closing.events[0].type === 'error' && closing.events[0].demoLimit === 'budget' && calls.length === 0, JSON.stringify(closing.events));

    const noStore = await mount({ ...DEMO, demoLimits: BIG });
    calls = [];
    const closed = await start(noStore, '192.0.2.12');
    check('no demo store → budget fails closed (403), no model call', closed.status === 403 && closed.json?.demoLimit === 'budget' && calls.length === 0);
  }
  {
    // Concurrency + durability, against the store contract directly.
    const mem = createMemoryDemoStore({ spentCents: 50 });
    const b = createBudget({ store: mem, refreshMs: 0 });
    for (let i = 0; i < 20; i++) b.record('claude-sonnet-4-6', USAGE);
    await b.flush();
    check('20 concurrent records all land (no lost increment)', Math.abs(mem.state.spentCents - (50 + 20 * 1.32)) < 1e-9, mem.state.spentCents);
    let fail = true;
    const flaky = { readBudget: async () => mem.state.spentCents, addBudget: async c => { if (fail) throw new Error('blip'); mem.state.spentCents += c; return mem.state.spentCents; } };
    const b2 = createBudget({ store: flaky, refreshMs: 0, log: { error() {} } });
    const before2 = mem.state.spentCents;
    b2.record('claude-sonnet-4-6', USAGE); await b2.flush();
    check('a failed add keeps the amount queued (still counted in checks)', mem.state.spentCents === before2 && Math.abs((await b2.spentCents()) - (before2 + 1.32)) < 1e-9);
    fail = false;
    b2.record('claude-sonnet-4-6', USAGE); await b2.flush();
    check('…and the next flush commits both', Math.abs(mem.state.spentCents - (before2 + 2.64)) < 1e-9, mem.state.spentCents);
    const fresh = createBudget({ store: mem, refreshMs: 0 });
    check('a new process (restart) starts from the committed total', Math.abs((await fresh.spentCents()) - mem.state.spentCents) < 1e-9);
  }

  // ── Per-IP daily cap ───────────────────────────────────────────────────────
  section('flag ON — 2 playthroughs per IP per day');
  {
    const mem = createMemoryDemoStore();
    const base = await mount({ ...DEMO, demoStore: mem, demoLimits: { ...BIG, dailyStartsPerIp: 2 } });
    const a1 = await start(base, '203.0.113.50');
    const a2 = await start(base, '203.0.113.50');
    calls = [];
    const a3 = await start(base, '203.0.113.50');
    check('1st and 2nd /start from an IP play', a1.status === 200 && a2.status === 200);
    check('3rd /start from that IP → 403 daily, friendly copy, no model call', a3.status === 403 && a3.json?.demoLimit === 'daily' && a3.json?.error === DEMO_LIMIT_COPY.daily && calls.length === 0, JSON.stringify(a3.json));
    check('another IP is unaffected', (await start(base, '203.0.113.51')).status === 200);
    check('turns are not counted against the daily cap', (await turn(base, '203.0.113.50', a1.done, 'Go on.')).status === 200);
  }
  {
    // Refund: a /start that never delivers an opening gives the slot back.
    const base = await mount({ ...DEMO, demoStore: createMemoryDemoStore(), demoLimits: { ...BIG, dailyStartsPerIp: 1 } });
    const ip = '203.0.113.60';
    calls = [];
    const failed1 = await (reply = 'I cannot write that scene as JSON.', req(base, 'POST', '/start', { scenarioId: SCENARIO_ID, roleId: ROLE_ID, narrativeStyle: 'focused' }, ip));
    await tick();
    check('an unrecoverable opening degrades to the friendly error (1 attempt + 2 retries)', failed1.events.some(e => e.type === 'error' && e.stage === 'opening') && !failed1.done && calls.length === 3, `${calls.length} calls`);
    const badRole = await (reply = OPENING, req(base, 'POST', '/start', { scenarioId: SCENARIO_ID, roleId: 'no_such_role', narrativeStyle: 'focused' }, ip));
    await tick();
    check('an unknown role (404 after the slot was taken) is refunded too', badRole.status === 404);
    const ok = await start(base, ip);
    check('…so the IP still has its one slot: the next /start plays', ok.status === 200 && !!ok.done, `${ok.status}`);
    check('…and once an opening is delivered the slot is spent: the next /start → 403 daily', (await start(base, ip)).json?.demoLimit === 'daily');
  }

  // ── Rate limit ─────────────────────────────────────────────────────────────
  section('flag ON — rate limit');
  {
    const base = await mount({ ...DEMO, demoStore: createMemoryDemoStore(), demoLimits: { ...BIG, ipPerMin: 3, globalPerMin: 5 } });
    const r = [];
    for (let i = 0; i < 4; i++) r.push(await start(base, '198.51.100.20'));
    check('per-IP: 3 in a minute play, the 4th → 429 rate (retryable)', r.slice(0, 3).every(x => x.status === 200) && r[3].status === 429
      && r[3].json?.demoLimit === 'rate' && r[3].json?.retryable === true && r[3].json?.error === DEMO_LIMIT_COPY.rate, r.map(x => x.status).join(','));
    const g = [await start(base, '198.51.100.21'), await start(base, '198.51.100.22'), await start(base, '198.51.100.23')];
    check('global: the 6th paid request in a minute → 429 even from a fresh IP', g[0].status === 200 && g[1].status === 200 && g[2].status === 429, g.map(x => x.status).join(','));
  }

  // ── /extract-facts + transcripts ───────────────────────────────────────────
  section('flag ON — /extract-facts off, demo transcript captured');
  {
    const mem = createMemoryDemoStore();
    const base = await mount({ ...DEMO, demoStore: mem, demoLimits: BIG });
    calls = [];
    const xf = await req(base, 'POST', '/extract-facts', { narrative: 'You saw the forged order.', existingFacts: [] });
    check('/extract-facts → { newFacts: [] } with no model call', xf.status === 200 && JSON.stringify(xf.json) === '{"newFacts":[]}' && calls.length === 0);

    const s = await start(base, '192.0.2.77');
    const typed = 'I ask the clerk who signed this order.';
    const t1 = await turn(base, '192.0.2.77', s.done, typed, { player_action: typed });
    const t2 = await turn(base, '192.0.2.77', { ...s.done, nextState: t1.done.nextState }, 'Read it again');
    await tick(150);
    const row = mem.state.transcripts.get(s.done.sessionId);
    check('a demo_transcripts row exists for the session, with scenario + role', !!row && row.scenario_id === SCENARIO_ID && row.role_id === ROLE_ID);
    check('the opening is recorded (narrative + choices)', row?.opening?.narrative?.includes('telegraph key') && row?.opening?.choices?.length === 2);
    check('two turns, in order, each timestamped', row?.turns?.length === 2 && row.turns.every(t => !Number.isNaN(Date.parse(t.at))) && Date.parse(row.turns[0].at) <= Date.parse(row.turns[1].at));
    check('the free-form input is captured verbatim and flagged free-form', row?.turns?.[0]?.input === typed && row.turns[0].free_form === true);
    check('a choice is captured and flagged not free-form', row?.turns?.[1]?.input === 'Read it again' && row.turns[1].free_form === false);
    check('each turn carries the response the player read', row?.turns?.[0]?.response?.narrative === 'You lean in over the order.' && row.turns[0].response.choices.length === 2);
    check('transcripts still also go to disk (closing-prose reads them)', fs.existsSync(p('engine/data/transcripts', `${s.done.sessionId}.md`)));
  }

  // ── Client: the injected demo script ───────────────────────────────────────
  section('client — injected demo script shows limit copy (jsdom)');
  {
    const run = async (status, payload, url = '/game/api/start') => {
      const html = injectDemoIntoGameHtml('<!doctype html><html><head></head><body></body></html>');
      const dom = new JSDOM(html, { runScripts: 'outside-only' });
      const fake = { status, clone() { return fake; }, json: async () => payload };
      dom.window.fetch = async () => fake;
      const script = dom.window.document.getElementById('demo-mode-js').textContent;
      dom.window.eval(script);
      let settled = false;
      dom.window.fetch(url, { method: 'POST' }).then(() => { settled = true; }, () => { settled = true; });
      await tick(50);
      const doc = dom.window.document;
      return { settled, overlay: doc.getElementById('demo-limit-overlay')?.textContent, toast: doc.getElementById('demo-limit-toast')?.textContent };
    };
    {
      const budget = await run(403, { error: DEMO_LIMIT_COPY.budget, demoLimit: 'budget', retryable: false });
      check('budget refusal → full-page notice with the copy; the page request never settles (no retry card)', budget.overlay === DEMO_LIMIT_COPY.budget && !budget.settled, JSON.stringify(budget));
      const rate = await run(429, { error: DEMO_LIMIT_COPY.rate, demoLimit: 'rate', retryable: true }, '/game/api/turn');
      check('rate refusal → short notice; the response passes through to the page', rate.toast === DEMO_LIMIT_COPY.rate && rate.settled && !rate.overlay, JSON.stringify(rate));
      const plain = await run(404, { error: 'Scenario not found.' });
      check('a non-demo error is left to the page', !plain.overlay && !plain.toast && plain.settled);
    }
  }
} catch (err) {
  console.error(`\nERROR  ${err.stack || err.message}`);
  failed++;
} finally {
  await tick(1200);   // let fire-and-forget transcript writes land before the sweep
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const [dir, had] of Object.entries(before)) for (const name of snapshot(dir)) if (!had.has(name)) { try { fs.unlinkSync(p(dir, name)); } catch {} }
    if (!sweep) await tick(800);
  }
  for (const s of servers) s.close();
  globalThis.fetch = realFetch;
}

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll demo-limits assertions passed.');
process.exit(failed ? 1 : 0);
