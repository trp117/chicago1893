// One playthrough, one session id.
//
//   node tests/session-id.test.mjs
//
// /start is pre-warmed the moment a role is tapped, before startGame mints the browser's own
// id, so the server mints the id the opening is written under and returns it in `done`. The
// browser used to keep its own id anyway: the opening landed under one id and every /turn and
// /closing-prose under another — two disk transcripts per playthrough in prod, two
// demo_transcripts rows in the demo. The browser now adopts the id /start returns.
//
// Drives the REAL engine/game/index.html in jsdom against the REAL createGameRouter (the
// degradation.test idiom), with api.anthropic.com scripted. Checks, flag off and flag on:
//   - the browser's sessionId after the opening is the one /start returned;
//   - the /turn it sends carries that id;
//   - prod: the turn is appended to the SAME disk transcript as the opening (one file);
//   - demo: the session writes ONE demo_transcripts row holding the opening, its role and the turn.
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

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n          ${detail}` : ''}`);
  if (!ok) failed++;
};
const tick = (ms = 100) => new Promise(r => setTimeout(r, ms));

const SCENARIO_ID = 'chicago_1893_v1';
const ROLE_ID     = 'daniel_burnham';

// ── Scripted api.anthropic.com: the opening, then turns ──────────────────────
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
const OPENING = JSON.stringify({ narrative: 'The telegraph key is still warm under your palm.', choices: ['Study the signature', 'Send for security'], location: 'administration_building', timeAdvance: 0 });
const TURN    = JSON.stringify({ narrative: 'You lean in over the order.', choices: ['Read it again', 'Call your assistant'], location: 'administration_building', timeAdvance: 2 });
let reply = OPENING;
function sse(text) {
  const ev = [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    ...Array.from({ length: Math.ceil(text.length / 40) }, (_, i) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i * 40, i * 40 + 40) } })),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`);
  return new Response(new ReadableStream({ start(c) { const enc = new TextEncoder(); ev.forEach(e => c.enqueue(enc.encode(e))); c.close(); } }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  if (body.model?.startsWith('claude-haiku')) return new Response(JSON.stringify({ content: [{ type: 'text', text: '[]' }], usage: {} }), { status: 200 });
  return body.stream ? sse(reply) : new Response(JSON.stringify({ content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: {} }), { status: 200 });
};

// ── Repos (disk only) ────────────────────────────────────────────────────────
const store = new JsonFileStore(p('engine/data'));
const repos = {
  characters: new CharacterRepository(store), locations: new LocationRepository(store), clues: new ClueRepository(store),
  scenarios: new ScenarioRepository(store), storyArcs: new StoryArcRepository(store), players: new PlayerRepository(store),
  sessions: new SessionRepository(store),
};
let scenarioOk = false;
try { scenarioOk = !!(await repos.scenarios.findById(SCENARIO_ID)) && !!repos.scenarios.findPlayerRoles(SCENARIO_ID).find(r => r.id === ROLE_ID); } catch {}
if (!scenarioOk) {
  console.log(`SKIP  session-id.test — scenario "${SCENARIO_ID}" / role "${ROLE_ID}" not available (needs restored data + Supabase creds).`);
  globalThis.fetch = realFetch;
  process.exit(0);
}
const { createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);

const snapshot = dir => { try { return new Set(fs.readdirSync(p(dir))); } catch { return new Set(); } };
const before = { 'engine/data/sessions': snapshot('engine/data/sessions'), 'engine/data/transcripts': snapshot('engine/data/transcripts'), 'data/sessions': snapshot('data/sessions') };
const servers = [];

// One playthrough through the real page: open the role, then click the first choice.
async function playOneTurn(label, config) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/game/api', createGameRouter(repos, { anthropicApiKey: 'session-id-test-key', ...config }));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  servers.push(server);
  const BASE = `http://127.0.0.1:${server.address().port}`;

  const seen = { startDoneIds: [], turnIds: [], turnFinished: null };
  const dom = new JSDOM(fs.readFileSync(p('engine/game/index.html'), 'utf8'), {
    url: `${BASE}/game?scenarioId=${SCENARIO_ID}`,
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = async (u, o) => {
        const href = new URL(u, BASE).href;
        if (href.includes('/game/api/turn')) seen.turnIds.push(JSON.parse(o.body).sessionId);
        const resp = await realFetch(href, o);
        if (href.includes('/game/api/start')) {
          // Read the server's `done` from a copy, so the page still gets the untouched stream.
          resp.clone().text().then(t => {
            for (const l of t.split('\n')) if (l.startsWith('data: ')) { try { const e = JSON.parse(l.slice(6)); if (e.type === 'done') seen.startDoneIds.push(e.sessionId); } catch {} }
          });
        }
        if (href.includes('/game/api/turn')) seen.turnFinished = resp.clone().text();
        return resp;
      };
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollIntoView = () => {};
      win.speechSynthesis ??= { getVoices: () => [], cancel() {}, speak() {} };
      win.console.error = () => {};
    },
  });
  const win = dom.window;
  await new Promise(r => win.addEventListener('load', r, { once: true }));
  const ready = () => { try { return !!win.eval('typeof scenario !== "undefined" && scenario'); } catch { return false; } };
  for (let i = 0; i < 100 && !ready(); i++) await tick();
  if (!ready()) throw new Error(`${label}: client never loaded the scenario`);

  const clientIdBefore = win.eval('sessionId');
  reply = OPENING;
  await win.startGame(ROLE_ID, 'focused', {});
  await tick(200);
  const clientIdAfter = win.eval('sessionId');

  reply = TURN;
  const btn = win.document.querySelector('#choices button');
  if (!btn) throw new Error(`${label}: no choice button after the opening`);
  btn.click();
  for (let i = 0; i < 100 && !seen.turnFinished; i++) await tick(50);
  await seen.turnFinished;
  await tick(400);   // the disk append and demo writes land after `done`
  dom.window.close();
  return { clientIdBefore, clientIdAfter, ...seen };
}

try {
  console.log('\n── flag OFF (prod): one disk transcript per playthrough');
  {
    const r = await playOneTurn('prod', {});
    const sid = r.startDoneIds[0];
    check('/start returned a session id', typeof sid === 'string' && sid.length > 0, JSON.stringify(r.startDoneIds));
    check('the browser adopted it (its own pre-start id is replaced)', r.clientIdAfter === sid && r.clientIdBefore !== sid, `before=${r.clientIdBefore} after=${r.clientIdAfter} start=${sid}`);
    check('the /turn it sent carries the same id', r.turnIds.length === 1 && r.turnIds[0] === sid, JSON.stringify(r.turnIds));
    const file = p('engine/data/transcripts', `${sid}.md`);
    const md = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    check('ONE disk transcript holds the header, the opening AND the turn', md.includes('## Scenario: chicago_1893_v1') && md.includes('telegraph key') && md.includes('**Player:** Study the signature'));
    const newTranscripts = [...snapshot('engine/data/transcripts')].filter(n => !before['engine/data/transcripts'].has(n));
    check('no second transcript file was created for the playthrough', newTranscripts.length === 1, newTranscripts.join(','));
  }

  console.log('\n── flag ON (demo): one demo_transcripts row per playthrough');
  {
    const mem = createMemoryDemoStore();
    const r = await playOneTurn('demo', { demoMode: true, demoScenarios: [SCENARIO_ID], demoStore: mem,
      demoLimits: { globalPerMin: 1000, ipPerMin: 1000, dailyStartsPerIp: 1000, budgetRefreshMs: 0 } });
    const sid = r.startDoneIds[0];
    check('the /turn carries the id /start returned', r.turnIds[0] === sid && r.clientIdAfter === sid, JSON.stringify({ sid, turn: r.turnIds, client: r.clientIdAfter }));
    const rows = [...mem.state.transcripts.values()];
    check('exactly ONE demo_transcripts row', rows.length === 1, rows.map(x => x.session_id).join(','));
    const row = rows[0];
    check('…holding the opening, its role, and the turn', row?.session_id === sid && row.role_id === ROLE_ID && row.opening?.narrative?.includes('telegraph key')
      && row.turns.length === 1 && row.turns[0].input === 'Study the signature', JSON.stringify({ role: row?.role_id, turns: row?.turns?.length }));
  }
} catch (err) {
  console.error(`\nERROR  ${err.stack || err.message}`);
  failed++;
} finally {
  await tick(1200);
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const [dir, had] of Object.entries(before)) for (const name of snapshot(dir)) if (!had.has(name)) { try { fs.unlinkSync(p(dir, name)); } catch {} }
    if (!sweep) await tick(800);
  }
  for (const s of servers) s.close();
  globalThis.fetch = realFetch;
}

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll session-id assertions passed.');
process.exit(failed ? 1 : 0);
