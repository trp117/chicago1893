// NARRATIVE STYLE LOCK — the Focused/Cinematic choice is hidden and every player runs Focused.
//
// SHOW_NARRATIVE_STYLE_TOGGLE (engine/game/index.html) is committed as false: the pills are
// not rendered and the role click hard-sets 'focused'. The cinematic mode itself still exists
// in the backend; re-enabling is a one-line flip of that constant. This test guards both:
//
//   flag false (committed) → role cards render, NO style buttons visible anywhere,
//                            /start gets 'focused', game state + model prompt are 'focused'
//   flag true  (forced here, in the page text loaded into jsdom — never on disk)
//                          → both pills render, choosing Cinematic carries 'cinematic' to /start
//
// Hermetic: the REAL engine/game/index.html in jsdom, the REAL createGameRouter over a real
// local socket, on-disk scenario data via JsonFileStore. api.anthropic.com is scripted with a
// canned reply. Supabase gets placeholder credentials (never the real ones — dotenv is not
// loaded) and an offline placeholder that answers 400 at once, so the scenario store falls back
// to disk; any other outbound request is refused and fails the test. Sessions and transcripts
// the run creates are deleted at the end.

// Placeholders BEFORE any engine import: lib/supabase.js constructs a client at import time.
process.env.SUPABASE_URL         = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_KEY = 'narrative-style-lock-test';
process.env.SUPABASE_ANON_KEY    = 'narrative-style-lock-test';
delete process.env.LANGFUSE_PUBLIC_KEY;
delete process.env.LANGFUSE_SECRET_KEY;

import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';
import { JSDOM } from 'jsdom';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;
const p        = (...s) => path.join(REPO_DIR, ...s);

const SCENARIO_ID = 'chicago_1893_v1';
const FLAG_OFF    = 'const SHOW_NARRATIVE_STYLE_TOGGLE = false;';
const FLAG_ON     = 'const SHOW_NARRATIVE_STYLE_TOGGLE = true;';

// ── Network: scripted model, everything else non-local refused ───────────────
const ANTHROPIC = 'https://api.anthropic.com/';
const GOOD = JSON.stringify({
  narrative: 'The telegraph key is still warm under your palm.',
  choices: ['Study the signature', 'Send for security', 'Go to the yards'],
  location: 'administration_building', timeAdvance: 0,
});
const realFetch = globalThis.fetch;
const prompts = [];   // serialized system + messages of every model call
const refused = [];   // any outbound request that is neither local nor the scripted model

function modelReply(stream) {
  if (!stream) {
    return new Response(JSON.stringify({ content: [{ type: 'text', text: GOOD }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'Content-Type': 'application/json' } });
  }
  const events = [
    { type: 'content_block_start', index: 0 },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: GOOD } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(events, { headers: { 'Content-Type': 'text/event-stream' } });
}

// Only the test's own server is reachable. The placeholder Supabase answers at once with a
// PostgREST-shaped 400, so the scenario store falls back to disk immediately — a thrown network
// error is retried with backoff by supabase-js and costs ~14s per /start. Anything else is refused.
const SUPABASE_ORIGIN = new URL(process.env.SUPABASE_URL).origin;
let appOrigin = null;   // set once the server is listening
const supabaseReads = [];
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : (url?.href || url?.url || String(url));
  if (u.startsWith(ANTHROPIC)) {
    const body = JSON.parse(opts.body);
    prompts.push(JSON.stringify(body.system || '') + JSON.stringify(body.messages || []));
    return modelReply(!!body.stream);
  }
  const origin = (() => { try { return new URL(u).origin; } catch { return null; } })();
  if (origin && origin === appOrigin) return realFetch(url, opts);
  if (origin === SUPABASE_ORIGIN) {
    supabaseReads.push(u);
    return new Response(JSON.stringify({ code: 'PGRST000', message: 'offline in narrative-style-lock.test' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  refused.push(u);
  throw new Error(`narrative-style-lock.test: outbound request refused: ${u}`);
};

// ── The app ──────────────────────────────────────────────────────────────────
const repoMods = {
  characters: 'CharacterRepository', locations: 'LocationRepository', clues: 'ClueRepository',
  scenarios: 'ScenarioRepository', storyArcs: 'StoryArcRepository', players: 'PlayerRepository',
  sessions: 'SessionRepository',
};
const { JsonFileStore } = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const store = new JsonFileStore(p('engine/data'));
const repos = {};
for (const [key, mod] of Object.entries(repoMods)) {
  const Cls = (await import(`${ROOT}/engine/repositories/${mod}.js`))[mod];
  repos[key] = new Cls(store);
}

let scenarioOk = false;
try { scenarioOk = !!(await repos.scenarios.findById(SCENARIO_ID))
                   && (repos.scenarios.findPlayerRoles(SCENARIO_ID) || []).length > 0; } catch { scenarioOk = false; }
if (!scenarioOk) {
  console.log(`SKIP  narrative-style-lock.test — scenario "${SCENARIO_ID}" not on disk (needs restored engine/data).`);
  process.exit(0);
}

const { createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);
const starts = [];   // narrativeStyle of every /start the client sends
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/game/api', (req, _res, next) => { if (req.path === '/start') starts.push(req.body?.narrativeStyle); next(); });
app.use('/game/api', createGameRouter(repos, { anthropicApiKey: 'narrative-style-lock-test' }));
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
appOrigin = new URL(BASE).origin;

const snapshot = dir => { try { return new Set(fs.readdirSync(p(dir))); } catch { return new Set(); } };
const DIRS   = ['engine/data/sessions', 'engine/data/transcripts', 'data/sessions'];
const before = Object.fromEntries(DIRS.map(d => [d, snapshot(d)]));

// ── Assertions ───────────────────────────────────────────────────────────────
let pass = 0;
const failures = [];
function ck(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else    { failures.push(name); console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}
const banner = s => console.log(`\n── ${s}`);
const wait   = ms => new Promise(r => setTimeout(r, ms));

// Rendered = connected and no ancestor computes to display:none.
function rendered(win, el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (win.getComputedStyle(n).display === 'none') return false;
  }
  return el.isConnected;
}

const PAGE = fs.readFileSync(p('engine/game/index.html'), 'utf8');

async function loadPage(html) {
  const dom = new JSDOM(html, {
    url: `${BASE}/game?scenarioId=${SCENARIO_ID}`,
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = (u, o) => globalThis.fetch(new URL(u, BASE).href, o);
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollIntoView = () => {};
      win.speechSynthesis ??= { getVoices: () => [], cancel() {}, speak() {} };
      win.Audio = class { play() { return Promise.resolve(); } pause() {} };
      win.console.error = () => {};
      win.console.warn  = () => {};
    },
  });
  const doc = dom.window.document;
  for (let i = 0; i < 100 && !doc.querySelector('#role-cards .role-card'); i++) await wait(100);
  return dom;
}

// Click the first role (streamlined screen 1), then Enter on screen 2; wait for the opening.
async function playFirstRole(dom) {
  const doc = dom.window.document;
  doc.querySelector('#role-cards .role-card').click();
  await wait(300);
  const intro = doc.getElementById('intro-overlay');
  if (intro && !intro.classList.contains('hidden')) doc.getElementById('intro-begin-btn')?.click();
  // Wait for the opening to land on screen — closing the window mid-startGame crashes jsdom.
  const landed = () => /telegraph key is still warm/.test(doc.getElementById('story')?.textContent || '');
  for (let i = 0; i < 300 && !landed(); i++) await wait(100);
  await wait(300);
  return dom.window.eval('typeof gameState !== "undefined" && gameState ? gameState.narrativeStyle : null');
}

// ── 1. Committed default ─────────────────────────────────────────────────────
banner('flag at its committed default (false)');
ck('engine/game/index.html commits SHOW_NARRATIVE_STYLE_TOGGLE = false', PAGE.includes(FLAG_OFF));
{
  starts.length = 0; prompts.length = 0;
  const dom = await loadPage(PAGE);
  const win = dom.window, doc = win.document;
  const overlay = doc.getElementById('role-overlay');
  const cards   = [...doc.querySelectorAll('#role-cards .role-card')];
  ck('role screen is shown', overlay && rendered(win, overlay));
  ck('role cards render', cards.length > 0 && cards.every(c => rendered(win, c)), `${cards.length} card(s)`);

  const styleControls = [...doc.querySelectorAll('[data-style], .ns-btn, .style-btn, .style-zone, .style-selector, .narrative-style-options')];
  const visible = styleControls.filter(el => rendered(win, el));
  ck('no narrative-style control is rendered anywhere', visible.length === 0,
     visible.map(el => el.outerHTML.slice(0, 80)).join(' | '));
  ck('no .ns-btn pills were created', doc.querySelectorAll('.ns-btn').length === 0);
  const cinematicText = [...doc.querySelectorAll('body *')]
    .filter(el => [...el.childNodes].some(n => n.nodeType === 3 && /cinematic/i.test(n.textContent)) && rendered(win, el));
  ck('no visible text offers "Cinematic"', cinematicText.length === 0,
     cinematicText.map(el => el.outerHTML.slice(0, 80)).join(' | '));

  const state = await playFirstRole(dom);
  ck('/start was called', starts.length > 0);
  ck('every /start sent narrativeStyle "focused"', starts.length > 0 && starts.every(s => s === 'focused'), JSON.stringify(starts));
  ck('game state narrativeStyle is "focused"', state === 'focused', String(state));
  ck('the model was called', prompts.length > 0);
  ck('the prompt sent to the model says the session is focused',
     prompts.some(t => t.includes('Narrative style for this session: focused')));
  ck('no prompt names a cinematic session', !prompts.some(t => /Narrative style for this session: cinematic/.test(t)));
  dom.window.close();
}

// ── 2. Re-enable path (flag forced true in the loaded page only) ─────────────
banner('flag forced true in test setup — the one-line re-enable still works');
{
  starts.length = 0; prompts.length = 0;
  const dom = await loadPage(PAGE.replace(FLAG_OFF, FLAG_ON));
  const win = dom.window, doc = win.document;
  const pills = [...doc.querySelectorAll('.ns-btn')];
  ck('exactly two style pills render', pills.length === 2 && pills.every(b => rendered(win, b)), `${pills.length} pill(s)`);
  ck('pills are Focused and Cinematic, Focused active by default',
     pills.map(b => b.dataset.style).join(',') === 'focused,cinematic' && pills[0].classList.contains('active'));
  doc.querySelector('.ns-btn[data-style="cinematic"]').click();
  const state = await playFirstRole(dom);
  ck('choosing Cinematic sends narrativeStyle "cinematic" to /start',
     starts.length > 0 && starts.every(s => s === 'cinematic'), JSON.stringify(starts));
  ck('game state narrativeStyle is "cinematic"', state === 'cinematic', String(state));
  ck('the prompt sent to the model says the session is cinematic',
     prompts.some(t => t.includes('Narrative style for this session: cinematic')));
  dom.window.close();
}

banner('hermetic');
ck('no outbound request beyond the scripted model and the offline Supabase placeholder',
   refused.length === 0, refused.join(', '));
ck('committed flag on disk is still false after the run',
   fs.readFileSync(p('engine/game/index.html'), 'utf8').includes(FLAG_OFF));

// ── Cleanup — leave no session or transcript behind ──────────────────────────
// /closing-prose-style late writes can re-create a file; let writes land, then sweep twice.
let removed = 0;
await wait(1500);
for (let sweep = 0; sweep < 2; sweep++) {
  for (const dir of DIRS) {
    for (const name of snapshot(dir)) {
      if (before[dir].has(name)) continue;
      try { fs.rmSync(p(dir, name), { recursive: true, force: true }); removed++; } catch {}
    }
  }
  if (!sweep) await wait(1000);
}
server.close();
globalThis.fetch = realFetch;

console.log(`\n${'═'.repeat(78)}`);
console.log(`narrative-style-lock.test — ${pass} passed, ${failures.length} failed  (cleaned up ${removed} file(s))`);
for (const f of failures) console.log(`  FAILED: ${f}`);
process.exit(failures.length ? 1 : 0);
