// DEMO_READING_LAYOUT — the reading column + cast rail.
//
//   node tests/reading-layout.test.mjs
//
// Part A — config gating, serve-time injection, and the contract with the game page: every global
//          the layout hooks exists, and #story is only ever scrolled through the four APIs the
//          scroll shim maps onto the column.
// Part B — /game (card grid / direct entry) in jsdom against the REAL router, model scripted:
//          the column (one scroller, bottom bar flowing, choices stacked, nothing pinned), the
//          scenario image behind it, the rail ("You are"; "In the scene" = present AND introduced,
//          cap 4 + "+N more", departed dimmed then dropped, click → impression), the clock
//          (sessionStartTime / "Minute N of M"), the scroll shim, wide vs narrow, cost (0 on load,
//          1 per turn), Notes never auto-opened.
// Part C — with the cold open: the scene uses the page's own choices + input inside the column;
//          the structure is identical before and after the first action (no reflow); exactly one
//          model call; the rail's "change role" exists only at the cold open.
// Part D — server boots: /game and / carry the layout exactly when the flag is on; /health; the
//          card grid (/moments) sends a non-baked card to /game, which serves the direct start;
//          / with &roleId= routes a role to its cold open or to the direct start.
// Part E — the direct start (/game with the layout): no native overlay ever shown; Screen 2's
//          character entry in the column with Begin, parity with the native flow (entry texts,
//          /start body); SLOT TIMING — load and reload spend 0 daily slots, each Begin exactly 1;
//          restart re-enters the same role in the layout; ?roleId=; the role panel; the cold
//          open's switcher (layout on: &roleId=; layout off: unchanged).
//
// The flag-OFF byte-identity proof is scripts/cold-open-baseline.mjs (local + live).
import 'dotenv/config';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';
import { JSDOM } from 'jsdom';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = pathToFileURL(REPO_DIR).href;
const p = (...s) => path.join(REPO_DIR, ...s);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
  if (!ok) failed++;
};
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await tick(20); } return false; }

const RL = await import(`${ROOT}/engine/server/readingLayout.js`);
const DM = await import(`${ROOT}/engine/server/demoMode.js`);
const CO = await import(`${ROOT}/engine/server/coldOpen.js`);
const PAGE = fs.readFileSync(p('engine/game/index.html'), 'utf8');
const RL_FILES = RL.readingLayoutFiles();
const DS_FILES = RL.directStartFiles();
// /game as the server serves it with the layout on (DS = direct start; coldOpen = DEMO_COLD_OPEN).
const servedGame = (page, { coldOpen = false, dsJs = DS_FILES.js } = {}) =>
  RL.injectReadingLayoutIntoGameHtml(RL.injectDirectStartIntoGameHtml(DM.injectDemoIntoGameHtml(page), { coldOpen }, { css: DS_FILES.css, js: dsJs }), RL_FILES);
// Test harness only: a script run with `location` shadowed, so a navigation it makes is recorded
// (jsdom cannot navigate). The script text inside is the file, unchanged.
const withNav = js => `(function (location) {\n${js}\n}).call(window, window.__nav);`;

// ── Part A ───────────────────────────────────────────────────────────────────
console.log('\nPart A — gating, injection, contract');
{
  check('off when DEMO_MODE is off, even with DEMO_READING_LAYOUT=true', RL.readReadingLayoutConfig({ DEMO_READING_LAYOUT: 'true' }, { demoMode: false }).enabled === false);
  check('off for unset / "false" / "1" / "TRUE"', ['', 'false', '1', 'TRUE'].every(v => RL.readReadingLayoutConfig({ DEMO_READING_LAYOUT: v }, { demoMode: true }).enabled === false));
  check('on with DEMO_MODE + DEMO_READING_LAYOUT=true', RL.readReadingLayoutConfig({ DEMO_READING_LAYOUT: 'true' }, { demoMode: true }).enabled === true);

  const out = RL.injectReadingLayoutIntoGameHtml(PAGE, RL_FILES);
  check('stylesheet + html.rl boot are in <head>, before the page\'s first script', out.indexOf('id="reading-layout-boot"') < out.indexOf('</head>') && out.indexOf('id="reading-layout-boot"') < out.indexOf('<script>'));
  check('the layout script is after the page script (it hooks its globals)', out.indexOf('id="reading-layout-js"') > out.lastIndexOf('loadGame();'));
  check('nothing else in the page changes', out.replace(/<style id="reading-layout-css">[\s\S]*?<\/script>\n/, '').replace(/<script id="reading-layout-js">[\s\S]*?<\/script>\n/, '') === PAGE);

  const js = RL_FILES.js;
  const hooks = JSON.parse(js.match(/RL_HOOKS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  for (const fn of hooks) check(`function ${fn}() is declared at top level of the game page`, new RegExp(`^(async )?function ${fn}\\(`, 'm').test(PAGE));
  for (const v of ['gameState', 'scenario', 'sessionId', 'storyEl', 'bootstrapData', 'currentScene']) {
    check(`global ${v} is a top-level let/const of the game page, used by name`, new RegExp(`^(let|const) ${v}\\b`, 'm').test(PAGE) && new RegExp(`\\b${v}\\b`).test(js));
  }
  // The scroll shim maps exactly these onto the column; the page must not reach #story's scroll
  // any other way (scrollTo / scrollBy / offsetTop / …) or that call would bypass it.
  const used = new Set([...PAGE.matchAll(/storyEl\.(scroll\w*|client\w*|offset\w*|getBoundingClientRect)/g)].map(m => m[1]));
  const MAPPED = ['scrollTop', 'scrollHeight', 'clientHeight', 'getBoundingClientRect'];
  check(`#story scroll APIs the page uses (${[...used].join(', ')}) are all mapped by the shim`, [...used].every(u => MAPPED.includes(u)));
  check('…and its scroll listener is fed by the column\'s scroll events', /storyEl\.addEventListener\('scroll'/.test(PAGE) && /dispatchEvent\(new Event\('scroll'\)\)/.test(js));
  // The rail's scrim: only behind the rail's own text (its box, feathered at every edge), not the
  // whole right margin; lighter than the column's reading surface; never a card.
  {
    const m = RL_FILES.css.match(/html\.rl\.rl-wide \.rl-rail::before \{([\s\S]*?)\n\}/);
    const rule = m?.[1] || '';
    const alphas = [...rule.matchAll(/rgba\(6, 6, 5, ([\d.]+)\)/g)].map(a => Number(a[1]));
    const surface = Number(RL_FILES.css.match(/html\.rl \.main-column \{[\s\S]*?background: rgba\(14, 13, 11, ([\d.]+)\)/)?.[1]);
    check('rail scrim: behind the rail text only (absolute in the rail box, not fixed to the viewport edge), feathered on every edge', /position: absolute; inset: 0/.test(rule) && !/position: fixed|50vw/.test(rule)
      && /mask-image: linear-gradient\(to right, transparent/.test(rule) && /linear-gradient\(to bottom, transparent/.test(rule) && /mask-composite: intersect/.test(rule)
      && /html\.rl\.rl-wide \.rl-rail \{[^}]*position: relative;[^}]*max-height: 100dvh/.test(RL_FILES.css));
    check('rail scrim: light (≤ 0.5; was 0.7 at the far edge)', alphas.length > 0 && Math.max(...alphas) <= 0.5);
    const introSurface = Number(fs.readFileSync(DM.COLD_OPEN_CSS_PATH, 'utf8').match(/html\.rl #co-overlay::before \{[^}]*background: rgba\(14, 13, 11, ([\d.]+)\)/)?.[1]);
    check(`column surface lightened (${surface}) and the intro's column surface matches it (${introSurface}): no brightness change at the reveal`, surface <= 0.8 && introSurface === surface);
    check(`rail scrim: subtler than the column surface (max ${Math.max(...alphas)} < ${surface})`, Math.max(...alphas) < surface);
    check('rail scrim: not a card (no border, radius or box-shadow)', !/border|radius|box-shadow/.test(rule));
  }
  {
    const out2 = RL.injectDirectStartIntoGameHtml(PAGE, { coldOpen: true }, DS_FILES);
    check('direct start: css + boot in <head> before the page script; script after the page script', out2.indexOf('id="direct-start-boot"') < out2.indexOf('<script>') && out2.indexOf('id="direct-start-js"') > out2.lastIndexOf('loadGame();'));
    check('direct start: boot carries only the per-deployment coldOpen flag', out2.includes('window.__DIRECT_START__ = {"coldOpen":true};') && RL.injectDirectStartIntoGameHtml(PAGE, {}, DS_FILES).includes('window.__DIRECT_START__ = {"coldOpen":false};'));
    check('direct start: nothing else in the page changes', out2.replace(/<style id="direct-start-css">[\s\S]*?<\/script>\n/, '').replace(/<script id="direct-start-js">[\s\S]*?<\/script>\n/, '') === PAGE);
    const dsHooks = JSON.parse(DS_FILES.js.match(/DS_HOOKS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
    for (const fn of dsHooks) check(`direct start: function ${fn}() is declared at top level of the game page`, new RegExp(`^(async )?function ${fn}\\(`, 'm').test(PAGE));
    for (const v of ['gameState', 'scenario', 'currentRoleId', 'storyEl']) check(`direct start: global ${v} is a top-level let/const of the game page`, new RegExp(`^(let|const) ${v}\\b`, 'm').test(PAGE));
    check('the page calls renderStreamlinedScreen1 from loadGame AND restartGame (both re-enter through the hook)', (PAGE.match(/^\s+renderStreamlinedScreen1\(\);/gm) || []).length >= 2);
    check('direct start never sends /start itself (Begin calls the page\'s startGame; no warm start)', !/\/start|fetch\(|warmStart/.test(DS_FILES.js.replace(/^\s*\/\/.*$/gm, '')));
  }
  for (const sel of ['class="app-shell"', 'class="main-column"', 'class="story-feed"', 'class="bottom-bar"', 'id="choices-area-wrap"', 'id="input-form"', 'class="hero"']) {
    check(`the page still has ${sel}`, PAGE.includes(sel));
  }
}

// ── Content + scripted model ─────────────────────────────────────────────────
const SCENARIO_ID = 'dog_green_sector', ROLE_ID = 'role_battalion_medic';
const R = async f => new (await import(`${ROOT}/engine/repositories/${f}.js`))[f](store);
const { JsonFileStore } = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const store = new JsonFileStore(p('engine/data'));
const repos = { characters: await R('CharacterRepository'), locations: await R('LocationRepository'), clues: await R('ClueRepository'),
  scenarios: await R('ScenarioRepository'), storyArcs: await R('StoryArcRepository'), players: await R('PlayerRepository'), sessions: await R('SessionRepository') };
let have = false;
try { have = !!(await repos.scenarios.findById(SCENARIO_ID)) && !!repos.scenarios.findPlayerRoles(SCENARIO_ID).find(r => r.id === ROLE_ID); } catch {}
if (!have || !process.env.SUPABASE_URL) {
  console.log(`\nSKIP  Parts B–D — "${SCENARIO_ID}" content not on disk or no Supabase credentials.`);
  console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll reading-layout assertions passed (A).');
  process.exit(failed ? 1 : 0);
}
const medic = repos.scenarios.findPlayerRoles(SCENARIO_ID).find(r => r.id === ROLE_ID);
const START_LOC = medic.startLocationId || medic.startLocation;
const chars = repos.characters.findAll().filter(c => (c.scenarioIds || []).includes(SCENARIO_ID));
const C = id => chars.find(c => c.id === id);

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
const model = { story: 0, classifier: 0 };
const OPENING = JSON.stringify({ narrative: 'FULL OPENING. The ramp drops into red surf.', choices: ['Engine one', 'Engine two', 'Engine three'], location: START_LOC, timeAdvance: 0 });
const TURN = JSON.stringify({ narrative: 'You crawl through the surf toward the voice.', choices: ['Press the wound', 'Drag him higher'], location: START_LOC, timeAdvance: 2 });
let reply = OPENING;
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  if (body.model?.startsWith('claude-haiku')) { model.classifier++; return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }], usage: {} }), { status: 200 }); }
  model.story++;
  if (!body.stream) return new Response(JSON.stringify({ content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: {} }), { status: 200 });
  const ev = [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(ev, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

const { createGameRouter, coldOpenFingerprintFor } = await import(`${ROOT}/engine/server/gameRouter.js`);
const { createMemoryDemoStore } = await import(`${ROOT}/engine/server/demoStore.js`);
const snapshotDir = dir => { try { return new Set(fs.readdirSync(p(dir))); } catch { return new Set(); } };
const SWEEP = ['engine/data/sessions', 'engine/data/transcripts', 'data/sessions'];
const before = Object.fromEntries(SWEEP.map(d => [d, snapshotDir(d)]));
const servers = [], children = [];
const listen = async app => { const s = app.listen(0); await new Promise(r => s.once('listening', r)); servers.push(s); return `http://127.0.0.1:${s.address().port}`; };
const post = async (base, url, body) => { const r = await realFetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const t = await r.text(); return t.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).find(e => e?.type === 'done'); };

// pinRandom: Math.random = () => 0 before any page script runs. The direct start picks its hook
// when the entry RENDERS (the entry shows the briefing-with-hook, and Begin sends that same
// briefing), so a pin set later, just before Begin, comes too late to make the pick deterministic.
async function openPage(html, base, { wide = true, path: pagePath = "/", pinRandom = false } = {}) {
  const log = { urls: [], turnBodies: [], turnDone: 0, notesOpened: false, starts: [] };
  const dom = new JSDOM(html, { url: `${base}${pagePath}`, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      if (pinRandom) w.Math.random = () => 0;
      w.fetch = async (u, o) => {
        const href = new URL(u, base).href;
        log.urls.push(new URL(href).pathname);
        if (href.includes('/game/api/turn')) log.turnBodies.push(JSON.parse(o.body));
        // A /start is recorded when it is SENT (status/json filled in when it answers).
        const entry = href.includes('/game/api/start') ? { body: JSON.parse(o.body), status: null, json: null } : null;
        if (entry) log.starts.push(entry);
        const r = await realFetch(href, o);
        if (entry) {
          entry.status = r.status;
          if (r.status !== 200) r.clone().json().then(j => { entry.json = j; }, () => {});
        }
        if (href.includes('/game/api/turn')) r.clone().text().then(t => { if (t.includes('"type":"done"')) log.turnDone++; });
        return r;
      };
      w.matchMedia = q => ({ matches: /min-width: 900px/.test(q) ? wide : false, media: q, addEventListener() {}, removeEventListener() {} });
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.__nav = { href: null, replaced: null, search: new URL(`${base}${pagePath}`).search, replace(u) { this.replaced = u; } };
      w.speechSynthesis ??= { getVoices: () => [], cancel() {}, speak() {} };
      w.console.error = () => {};
    } });
  const win = dom.window, doc = win.document;
  // Notes must never open by itself: watch its overlay for the whole run.
  await until(() => doc.getElementById('notes-overlay'), 2000);
  new win.MutationObserver(() => { if (!doc.getElementById('notes-overlay').classList.contains('hidden')) log.notesOpened = true; })
    .observe(doc.getElementById('notes-overlay'), { attributes: true, attributeFilter: ['class'] });
  return { dom, win, doc, log };
}
const cs = (win, sel) => { const n = typeof sel === 'string' ? win.document.querySelector(sel) : sel; return n ? win.getComputedStyle(n) : null; };
// The layout skeleton: the containers the narrative, choices and input live in, and in what order.
function skeleton(win) {
  const d = win.document;
  const chain = n => { const out = []; for (let x = n; x && x !== d.body; x = x.parentElement) out.push(x.id ? `#${x.id}` : `.${String(x.className).split(' ')[0]}`); return out.join(' < '); };
  return JSON.stringify({
    rl: d.documentElement.classList.contains('rl'), wide: d.documentElement.classList.contains('rl-wide'),
    story: chain(d.getElementById('story')), choices: chain(d.getElementById('choices')), input: chain(d.getElementById('input-form')),
    bar: [...d.querySelector('.bottom-bar').children].filter(n => !String(n.className).startsWith('co-')).map(n => n.id || n.className),
    column: cs(win, '.main-column').getPropertyValue('overflow-y'), storyOverflow: cs(win, '#story').getPropertyValue('overflow'),
    barDisplay: cs(win, '.bottom-bar').getPropertyValue('display'), barPosition: cs(win, '.bottom-bar').getPropertyValue('position'),
    choicesDir: cs(win, '#choices').getPropertyValue('flex-direction'), header: cs(win, 'header.hero').getPropertyValue('display'),
    rail: cs(win, '.rl-rail')?.getPropertyValue('display'),
  });
}

try {
  // ── Part B ─────────────────────────────────────────────────────────────────
  console.log('\nPart B — /game with the reading layout (direct / card-grid entry)');
  const routerCfg = { anthropicApiKey: 'rl-test', demoMode: true, demoScenarios: [SCENARIO_ID], demoStore: createMemoryDemoStore(), demoLimits: { dailyStartsPerIp: 50, globalPerMin: 1000, ipPerMin: 1000 } };
  const BASE = await listen(express().use(express.json({ limit: '10mb' })).use('/game/api', createGameRouter(repos, routerCfg)));
  const gameHtml = servedGame(PAGE);
  const B = await openPage(gameHtml, BASE, { path: `/game?scenarioId=${SCENARIO_ID}` });
  const { win, doc } = B;
  await until(() => win.eval('typeof scenario !== "undefined" && !!scenario'), 6000);
  model.story = 0;
  await until(() => doc.querySelector('.ds-entry'), 4000);
  check('page load (bootstrap, character entry) made ZERO model calls', model.story === 0 && !B.log.urls.some(u => /turn|start/.test(u)), B.log.urls.join(','));
  reply = OPENING;
  await win.startGame(ROLE_ID, 'focused', {});
  await until(() => doc.querySelector('#choices .choice-btn'), 6000);
  check('the opening (/start) made exactly one model call', model.story === 1, `story=${model.story}`);
  const root = doc.documentElement;
  check('html.rl + html.rl-wide (wide screen)', root.classList.contains('rl') && root.classList.contains('rl-wide'));
  check('the column is the one scroller; #story no longer scrolls', cs(win, '.main-column').getPropertyValue('overflow-y') === 'auto' && cs(win, '#story').getPropertyValue('overflow') === 'visible');
  check('capped measure: the column is max 720px', cs(win, '.main-column').getPropertyValue('max-width') === '720px');
  check('nothing pinned: the bottom bar is a normal block flowing after the story', cs(win, '.bottom-bar').getPropertyValue('position') === 'static' && doc.getElementById('story').nextElementSibling === doc.querySelector('.bottom-bar'));
  check('choices stacked in the column (vertical, full width, no arrows)', cs(win, '#choices').getPropertyValue('flex-direction') === 'column' && cs(win, '#choices .choice-btn').getPropertyValue('width') === '100%' && cs(win, '.choices-arrow').getPropertyValue('display') === 'none');
  check('order in the column: narrative, then choices, then input', (() => { const bar = [...doc.querySelector('.bottom-bar').children]; const o = n => Number(cs(win, n).getPropertyValue('order') || 0); return o(doc.getElementById('choices-area-wrap')) < o(doc.getElementById('input-form')); })());
  const imgUrl = (await repos.scenarios.findById(SCENARIO_ID)).image?.url;
  check('the scenario\'s own image is set full-bleed behind the column', !!imgUrl && root.style.getPropertyValue('--rl-image').includes(imgUrl));
  check('the top bar slims to the location (subtitle, Begin Again, ← Stories hidden on wide)', cs(win, '#header-subtitle').getPropertyValue('display') === 'none' && cs(win, '#new-game-btn').getPropertyValue('display') === 'none'
    && cs(win, 'header.hero .back-link').getPropertyValue('display') === 'none' && cs(win, '#header-title').getPropertyValue('display') !== 'none' && cs(win, '#notes-btn').getPropertyValue('display') !== 'none');

  // The rail.
  const rail = doc.querySelector('.rl-rail');
  const labels = rail ? [...rail.querySelectorAll('.rl-label')].map(n => n.textContent) : [];
  check('cast rail shown, exactly two blocks: "You are", "In the scene"', !!rail && cs(win, rail).getPropertyValue('display') === 'block' && JSON.stringify(labels) === '["You are","In the scene"]');
  check('"You are": the role, where (location), when, and The history', rail.querySelector('.rl-role').textContent === 'The Battalion Medic' && !!rail.querySelector('.rl-where')?.textContent
    && rail.querySelector('.rl-when').textContent === `Minute 0 of ${(await repos.scenarios.findById(SCENARIO_ID)).sessionTargetMinutes}` && rail.querySelector('.rl-history')?.textContent === 'The history');
  check('no "change role" once the session has started (outside the cold open / pre-Begin entry)', !rail.querySelector('.rl-change'));
  rail.querySelector('.rl-history').click();
  const intro = (await repos.scenarios.findById(SCENARIO_ID)).introduction?.sections?.find(s => s.type === 'world')?.text;
  check('The history opens the scenario\'s real introduction', !!doc.querySelector('.rl-panel') && !!intro && doc.querySelector('.rl-panel').textContent.includes(intro));
  doc.querySelector('.rl-panel .rl-close').click();

  // In the scene: present AND introduced only; cap 4 + "+N more"; tags; impression on click.
  const set = (present, introduced, turn, extra = '') => { win.eval(`gameState.presentNpcs = ${JSON.stringify(present)}; gameState.introducedNpcs = ${JSON.stringify(introduced)}; gameState.turnCount = ${turn}; ${extra}`); win.__readingLayout.update(); };
  const listed = () => [...doc.querySelectorAll('.rl-cast li')].map(li => li.getAttribute('data-npc'));
  const P = ['char_cpl_drennan', 'char_pvt_szymanski', 'char_sgt_kowalski', 'char_lt_hargrove', 'char_medic_calloway', 'char_petty_officer_reed'];
  const I = ['char_cpl_drennan', 'char_sgt_kowalski', 'char_lt_hargrove', 'char_medic_calloway', 'char_petty_officer_reed'];
  set([], [], 1);
  check('nobody present → "No one yet."', doc.querySelector('.rl-empty')?.textContent === 'No one yet.');
  set(P, I, 2);
  check('present but NOT introduced (Szymanski) is never named', !listed().includes('char_pvt_szymanski') && !rail.textContent.includes('Szymanski'));
  check('hard cap: 4 visible, then "+1 more"', listed().length === 4 && doc.querySelector('.rl-more')?.textContent === '+1 more');
  check('one line each: name + short tag (role cut at the first comma)', doc.querySelector('.rl-cast li[data-npc="char_cpl_drennan"] .rl-npc-name').textContent === C('char_cpl_drennan').name
    && doc.querySelector('.rl-cast li[data-npc="char_cpl_drennan"] .rl-npc-tag').textContent === 'Demolitions Specialist');
  check('the long impression is NOT printed inline', !rail.textContent.includes(C('char_cpl_drennan').publicFace.slice(0, 40)));
  doc.querySelector('.rl-more').click();
  check('"+N more" expands in place', listed().length === 5);
  doc.querySelector('.rl-cast li[data-npc="char_cpl_drennan"] .rl-npc').click();
  check('click a name → that NPC\'s impression (the Notes text), one tap deep', doc.querySelector('.rl-cast li[data-npc="char_cpl_drennan"] .rl-npc-more')?.textContent === C('char_cpl_drennan').publicFace
    && doc.querySelector('.rl-cast li[data-npc="char_cpl_drennan"] .rl-npc').getAttribute('aria-expanded') === 'true');
  set(P.filter(id => id !== 'char_sgt_kowalski'), I, 3);
  check('an NPC who leaves is dimmed on the turn they go', doc.querySelector('.rl-cast li[data-npc="char_sgt_kowalski"]')?.classList.contains('rl-gone'));
  set(P.filter(id => id !== 'char_sgt_kowalski'), I, 4);
  check('…and dropped on the next', !listed().includes('char_sgt_kowalski'));
  set([], [], 4, 'scenario.sessionStartTime = "06:30"; gameState.elapsedMinutes = 7;');
  check('clock: sessionStartTime + elapsed → "6:37 a.m."', rail.querySelector('.rl-when').textContent === '6:37 a.m.');
  set([], [], 4, 'scenario.sessionStartTime = "23:50"; gameState.elapsedMinutes = 15;');
  check('clock: past midnight wraps (23:50 + 15 → "12:05 a.m.")', rail.querySelector('.rl-when').textContent === '12:05 a.m.');
  set([], [], 4, 'delete scenario.sessionStartTime; gameState.elapsedMinutes = 0;');

  // The scroll shim, on a minimal page with a simulated layout (jsdom has none): a 60px sticky
  // top bar, #story below it moving with the column's scroll, a probe 500px into the story.
  {
    const mini = new JSDOM(`<!doctype html><html class="rl rl-wide"><head><style>${RL_FILES.css}</style></head><body>
<div class="app-shell"><main class="main-column"><header class="hero"><h1 id="header-title">x</h1></header>
<section id="story" class="story-feed"><div id="probe"></div></section><div class="bottom-bar"></div></main></div>
<script>const storyEl = document.getElementById('story');</script></body></html>`, { runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w) {
        const scrolls = new WeakMap();
        Object.defineProperty(w.HTMLElement.prototype, 'scrollTop', { configurable: true, get() { return scrolls.get(this) || 0; }, set(v) { scrolls.set(this, Math.max(0, v)); } });
        w.Element.prototype.getBoundingClientRect = function () {
          const cs = w.document.querySelector('.main-column')?.scrollTop || 0;
          const R = (t, h) => ({ top: t, bottom: t + h, left: 0, right: 700, width: 700, height: h, x: 0, y: t });
          if (this.classList?.contains('main-column')) return R(0, 800);
          if (this.matches?.('header.hero')) return R(0, 60);
          if (this.id === 'story') return R(60 - cs, 3000);
          if (this.id === 'probe') return R(60 - cs + 500, 40);
          return R(0, 0);
        };
        w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
      } });
    const mw = mini.window, md = mw.document;
    const s = md.createElement('script'); s.textContent = RL_FILES.js; md.body.appendChild(s);
    const col = md.querySelector('.main-column');
    mw.eval('storyEl.scrollTop = 140');
    check('scroll shim: storyEl.scrollTop = n scrolls the column by n (and reads back n)', col.scrollTop === 140 && mw.eval('storyEl.scrollTop') === 140);
    mw.eval('storyEl.scrollTop = 0');
    check('scroll shim: storyEl.scrollTop = 0 → the top of the story (column at 0)', col.scrollTop === 0);
    // The page's own "bring this card into view" formula (feedScrollTop / renderOutput):
    mw.eval(`storyEl.scrollTop = document.getElementById('probe').getBoundingClientRect().top - storyEl.getBoundingClientRect().top + storyEl.scrollTop`);
    check('scroll shim: the page\'s scroll-into-view formula lands the element just under the sticky top bar', md.getElementById('probe').getBoundingClientRect().top === 60 && col.scrollTop === 500, `probe top ${md.getElementById('probe').getBoundingClientRect().top}, column ${col.scrollTop}`);
    let heard = false;
    md.getElementById('story').addEventListener('scroll', () => { heard = true; });
    col.dispatchEvent(new mw.Event('scroll'));
    check('scroll shim: the column\'s scroll events reach #story\'s listeners', heard);
    mw.close();
  }

  // A turn: same skeleton, one model call.
  const sk0 = skeleton(win);
  reply = TURN;
  const n0 = model.story;
  doc.querySelector('#choices .choice-btn').click();
  await until(() => B.log.turnDone === 1 && /crawl through the surf/.test(doc.getElementById('story').textContent), 8000);
  await tick(200);
  check('a turn: exactly one model call', model.story === n0 + 1, `story +${model.story - n0}`);
  check('a turn: the layout skeleton is unchanged', skeleton(win) === sk0, `\n        before ${sk0}\n        after  ${skeleton(win)}`);
  check('Notes never opened by itself (load → opening → turn)', !B.log.notesOpened && doc.getElementById('notes-overlay').classList.contains('hidden'));
  win.close();

  // Narrow: one full-width column, no rail, orientation in the top bar.
  const N = await openPage(gameHtml, BASE, { wide: false, path: `/game?scenarioId=${SCENARIO_ID}` });
  await until(() => N.doc.querySelector('.ds-entry'), 6000);
  check('narrow, before Begin: no rail, so the entry carries an inline "Change role"', cs(N.win, '.rl-rail').getPropertyValue('display') === 'none' && cs(N.win, '.ds-entry .ds-change').getPropertyValue('display') !== 'none');
  reply = OPENING;
  await N.win.startGame(ROLE_ID, 'focused', {});
  await until(() => N.doc.querySelector('#choices .choice-btn'), 6000);
  check('narrow: no html.rl-wide, rail hidden', !N.doc.documentElement.classList.contains('rl-wide') && cs(N.win, '.rl-rail').getPropertyValue('display') === 'none');
  check('narrow: full-width column, 16px gutters', cs(N.win, '.main-column').getPropertyValue('max-width') === 'none' && cs(N.win, '#story').getPropertyValue('padding').includes('16px'));
  check('narrow: orientation stays in the top bar (subtitle not hidden)', cs(N.win, '#header-subtitle').getPropertyValue('display') !== 'none');
  check('narrow: still stacked choices, flowing bar', cs(N.win, '#choices').getPropertyValue('flex-direction') === 'column' && cs(N.win, '.bottom-bar').getPropertyValue('position') === 'static');
  N.win.close();

  // ── Part C ─────────────────────────────────────────────────────────────────
  console.log('\nPart C — with the cold open: native controls, no reflow at the handoff');
  const bakeBase = await listen(express().use(express.json({ limit: '10mb' })).use('/game/api', createGameRouter(repos, { anthropicApiKey: 'rl-test' })));
  reply = OPENING;
  const baked = await post(bakeBase, '/game/api/start', { scenarioId: SCENARIO_ID, roleId: ROLE_ID, narrativeStyle: 'focused', onboardingFlow: 'streamlined' });
  const LEAN = 'The ramp drops. Red water to the knees.\n\n*Someone up the beach is screaming for a medic.*';
  const row = { scenario_id: SCENARIO_ID, role_id: ROLE_ID, status: 'ready', content: {
    intro: { name: 'Dog Green: The Longest Morning', place: 'Omaha Beach', date: 'June 6, 1944', wide: 'The first wave has come apart in the surf.', role: 'Battalion Medic', unit: '116th Infantry', character: 'You have more wounded than you have hands.' },
    lean: { narrative: LEAN, instruction: 'Your move — choose one, or write your own:', choices: ['Crawl to the screaming man', 'Shout for the litter team', 'Check your aid bag'] },
    baked: { state: baked.nextState, output: baked.output, fingerprint: await coldOpenFingerprintFor(repos, SCENARIO_ID, ROLE_ID, baked.nextState), baked_at: new Date().toISOString() } } };
  const cfg = CO.readColdOpenConfig({ DEMO_COLD_OPEN: 'true', DEMO_FEATURED_SCENARIO: SCENARIO_ID, DEMO_FEATURED_ROLE: ROLE_ID }, { demoMode: true, demoScenarios: [SCENARIO_ID] });
  const runtime = CO.createColdOpenRuntime({ config: cfg, store: CO.createColdOpenStore({ fetchRows: async () => [row] }), fingerprintFor: (s, r, st) => coldOpenFingerprintFor(repos, s, r, st) });
  const COBASE = await listen(express().use(express.json({ limit: '10mb' })).use('/game/api', createGameRouter(repos, { ...routerCfg, demoStore: createMemoryDemoStore(), coldOpen: runtime })));
  const FAST = { titleIn: 5, quoteIn: 15, s1out: 30, s2in: 40, charIn: 50, s2out: 60, reveal: 70, skipHint: 5, fade: 10, dissolve: 10 };
  const coHtml = RL.injectReadingLayoutIntoGameHtml(DM.injectColdOpenIntoGameHtml(DM.injectDemoIntoGameHtml(PAGE),
    { scenarioId: SCENARIO_ID, roleId: ROLE_ID, timings: FAST, historyUser: CO.COLD_OPEN_HISTORY_USER },
    { css: fs.readFileSync(DM.COLD_OPEN_CSS_PATH, 'utf8'), js: fs.readFileSync(DM.COLD_OPEN_JS_PATH, 'utf8') }), RL_FILES);
  model.story = 0;
  const K = await openPage(coHtml, COBASE);
  const kd = K.doc;
  await until(() => kd.querySelector('.co-head') && kd.getElementById('co-overlay').hidden, 8000);
  check('cold open + layout: loading the entry made ZERO model calls', model.story === 0 && JSON.stringify(K.log.urls) === '["/game/api/bootstrap","/game/api/cold-open"]', K.log.urls.join(','));
  check('the scene uses the page\'s own choices (3, the lean choices) — no .co-choices', JSON.stringify([...kd.querySelectorAll('#choices .choice-btn')].map(b => b.textContent)) === JSON.stringify(row.content.lean.choices) && !kd.querySelector('.co-choices'));
  check('…and the page\'s own input (in the DOM, shown) — no .co-input', !!kd.getElementById('input-form') && cs(K.win, '#input-form').getPropertyValue('display') !== 'none' && !kd.querySelector('.co-input'));
  check('instruction line directly above the choices', kd.getElementById('choices-area-wrap').firstElementChild?.classList.contains('co-instruction') && kd.querySelector('.co-instruction').textContent === row.content.lean.instruction);
  check('footer last ("Another moment" · "Replay the open")', cs(K.win, '.bottom-bar > .co-foot').getPropertyValue('order') === '5' && kd.querySelector('.bottom-bar > .co-foot a')?.getAttribute('href') === '/moments');
  check('the page header and bottom bar are NOT hidden under the layout', cs(K.win, 'header.hero').getPropertyValue('display') !== 'none' && cs(K.win, '.bottom-bar').getPropertyValue('display') !== 'none');
  check('wide: the rail carries role + history, so the cold open\'s header row steps aside', cs(K.win, '.co-head').getPropertyValue('display') === 'none' && !!kd.querySelector('.rl-rail .rl-history'));
  const ch = kd.querySelector('.rl-rail .rl-change');
  check('rail at the cold open: "The Battalion Medic · change role ▾"', kd.querySelector('.rl-rail .rl-role')?.textContent === 'The Battalion Medic' && ch?.textContent === ' · change role ▾');
  ch.click();
  check('…which opens the cold open\'s role switcher', !!kd.querySelector('.co-panel .co-roles'));
  kd.querySelector('.co-panel .co-close').click();
  check('rail at the cold open: "In the scene" names no one the lean cut has not introduced', !!kd.querySelector('.rl-empty'));
  {
    const coCss = fs.readFileSync(DM.COLD_OPEN_CSS_PATH, 'utf8');
    check('accent token: the layout reads in the demo gold #d6a64c — rail headers, dateline, links (no steel blue)', /html\.rl \{ --demo-accent: #d6a64c; \}/.test(RL_FILES.css)
      && /\.rl-label \{[^}]*color: var\(--demo-accent\)/.test(RL_FILES.css) && /\.rl-when \{ color: var\(--demo-accent\)/.test(RL_FILES.css)
      && /\.rl-rail button:hover \{ color: var\(--demo-accent\)/.test(RL_FILES.css) && !/8198ab/i.test(RL_FILES.css + coCss));
    check('the intro renders inside the reading column (overlay takes the layout grid; screens in the column cell)', /html\.rl\.rl-wide #co-overlay \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 720px\) minmax\(220px, 1fr\); \}/.test(coCss)
      && /html\.rl\.rl-wide #co-overlay::before, html\.rl\.rl-wide #co-overlay > \* \{ grid-column: 2; \}/.test(coCss) && cs(K.win, '#co-overlay').getPropertyValue('display') === 'none');
    check('the intro\'s title screens were in the column page (screen 1 + screen 2 + skip)', !!kd.querySelector('#co-overlay .co-s1 .co-name') && !!kd.querySelector('#co-overlay .co-s2 .co-you-role') && kd.querySelector('#co-overlay .co-you').textContent === 'You are a Battalion Medic, 116th Infantry');
  }
  const coSk = skeleton(K.win);
  reply = TURN;
  kd.querySelector('#choices .choice-btn').click();
  await until(() => K.log.turnDone === 1 && /crawl through the surf/.test(kd.getElementById('story').textContent), 8000);
  await tick(200);
  check('first action: tagged coldOpen, exactly ONE model call', K.log.turnBodies[0]?.coldOpen?.roleId === ROLE_ID && model.story === 1, `story=${model.story}`);
  check('NO REFLOW: the layout skeleton is identical before and after the handoff', skeleton(K.win) === coSk, `\n        cold open ${coSk}\n        live      ${skeleton(K.win)}`);
  check('after the handoff: instruction + footer gone, "change role" gone, live choices in the same #choices', !kd.querySelector('.co-instruction') && !kd.querySelector('.co-foot') && !kd.querySelector('.rl-change')
    && [...kd.querySelectorAll('#choices .choice-btn')].map(b => b.textContent).join('|') === 'Press the wound|Drag him higher');
  check('Notes never opened by itself (cold open → handoff → turn 1)', !K.log.notesOpened);
  K.win.close();

  // ── Part E ─────────────────────────────────────────────────────────────────
  console.log('\nPart E — the direct start (/game, reading layout): entry, parity, slot timing, restart, role switch');
  {
    const FIRST = (await (await realFetch(`${BASE}/game/api/bootstrap?scenarioId=${SCENARIO_ID}`)).json()).scenario.playerRoleOptions;
    const SECOND = FIRST[1];
    const dsNav = servedGame(PAGE, { dsJs: withNav(DS_FILES.js) });
    const dsNavCold = servedGame(PAGE, { coldOpen: true, dsJs: withNav(DS_FILES.js) });

    // ── Parity source: the NATIVE flow (flag off, no layout), Math.random pinned. Screen 1 → tap the
    // first role card (its warm /start is the native /start body); Screen 2's title + paragraphs.
    const nativeBase = await listen(express().use(express.json({ limit: '10mb' })).use('/game/api', createGameRouter(repos, { anthropicApiKey: 'rl-test' })));
    const NV = await openPage(DM.injectDemoIntoGameHtml(PAGE), nativeBase, { path: `/game?scenarioId=${SCENARIO_ID}` });
    await until(() => NV.doc.querySelector('#role-overlay .role-card'), 6000);
    check('native (flag off): the page\'s own entry is the role overlay (Screen 1) — the old format the layout must replace', !NV.doc.getElementById('role-overlay').classList.contains('hidden'));
    NV.win.Math.random = () => 0;
    // The native card unlocks audio (new Audio().play()) first; jsdom has no media playback.
    NV.win.Audio = function () { return { src: '', play: () => Promise.resolve(), pause() {}, duration: NaN }; };
    reply = OPENING;
    NV.doc.querySelector('#role-overlay .role-card').click();
    await until(() => NV.doc.querySelectorAll('#intro-sections p').length > 0 && NV.log.starts.length === 1, 6000);
    const nativeTitle = NV.doc.getElementById('intro-title').textContent;
    const nativeParas = [...NV.doc.querySelectorAll('#intro-sections p')].map(p => p.textContent);
    const nativeStart = NV.log.starts[0]?.body;
    // Let the native warm /start finish (its model call) before anything below counts calls.
    await until(() => NV.log.starts[0]?.status != null, 20000);
    await tick(500);
    NV.win.close();

    // ── Load + reload: zero /start, zero slots. Router with a daily cap of 2.
    const slotCfg = { anthropicApiKey: 'rl-test', demoMode: true, demoScenarios: [SCENARIO_ID], demoStore: createMemoryDemoStore(), demoLimits: { dailyStartsPerIp: 2, globalPerMin: 1000, ipPerMin: 1000 } };
    const SLOT = await listen(express().use(express.json({ limit: '10mb' })).use('/game/api', createGameRouter(repos, slotCfg)));
    model.story = 0;
    const L1 = await openPage(dsNav, SLOT, { path: `/game?scenarioId=${SCENARIO_ID}` });
    await until(() => L1.doc.querySelector('.ds-entry'), 6000);
    await tick(300);
    const L1urls = L1.log.urls.slice();
    L1.win.close();
    // The reload. Math.random pinned from the start, like the native flow above: the entry picks
    // its hook as it renders, so the /start parity check below compares hook 0 with hook 0.
    const E = await openPage(dsNav, SLOT, { path: `/game?scenarioId=${SCENARIO_ID}`, pinRandom: true });
    const { win: ew, doc: ed } = E;
    await until(() => ed.querySelector('.ds-entry'), 6000);
    await tick(300);
    check('SLOT: page load sent NO /start and made no model call', L1urls.length && !L1urls.some(u => /\/start|\/turn/.test(u)), L1urls.join(','));
    check('SLOT: reload sent NO /start and made no model call', !E.log.urls.some(u => /\/start|\/turn/.test(u)) && model.story === 0, E.log.urls.join(','));

    // ── The entry, in the layout.
    const root = ed.documentElement;
    check('entry: html.rl + html.ds-pre; NEITHER native overlay is shown (#role-overlay, #intro-overlay hidden)', root.classList.contains('rl') && root.classList.contains('ds-pre')
      && ed.getElementById('role-overlay').classList.contains('hidden') && cs(ew, '#role-overlay').getPropertyValue('display') === 'none'
      && ed.getElementById('intro-overlay').classList.contains('hidden') && cs(ew, '#intro-overlay').getPropertyValue('display') === 'none');
    const entry = ed.querySelector('.ds-entry');
    check('entry: in the reading column (#story inside .main-column)', entry?.parentElement?.id === 'story' && !!entry.closest('.main-column') && cs(ew, '.main-column').getPropertyValue('max-width') === '720px');
    check(`entry: defaults to the FIRST role in playerRoleOptions (${FIRST[0].id})`, ew.eval('currentRoleId') === FIRST[0].id);
    check('PARITY: the entry\'s heading = native Screen 2\'s title', ed.querySelector('.ds-role')?.textContent === nativeTitle && !!nativeTitle, `${ed.querySelector('.ds-role')?.textContent} | ${nativeTitle}`);
    const dsParas = [...ed.querySelectorAll('.ds-entry .ds-p')].map(p => p.textContent);
    check(`PARITY: the entry's paragraphs = native Screen 2's (${nativeParas.length}: bridge → context → entry)`, nativeParas.length > 0 && JSON.stringify(dsParas) === JSON.stringify(nativeParas), `\n        ds     ${JSON.stringify(dsParas)}\n        native ${JSON.stringify(nativeParas)}`);
    check('entry: Begin in the column; choices + input hidden until Begin', ed.querySelector('.ds-entry .ds-begin')?.textContent === 'Begin' && cs(ew, '.bottom-bar').getPropertyValue('display') === 'none');
    const rail = ed.querySelector('.rl-rail');
    check('rail before Begin: "You are" the first role, "· change role ▾"', rail.querySelector('.rl-role')?.textContent === ew.eval('getCardDisplayName')(FIRST[0]) && rail.querySelector('.rl-change')?.textContent === ' · change role ▾');
    check('wide: the inline "Change role" steps aside (the rail carries it)', cs(ew, '.ds-entry .ds-change').getPropertyValue('display') === 'none');

    // ── The role panel (rail): roles listed, current marked; another role → that role's entry.
    rail.querySelector('.rl-change').click();
    const panelRoles = [...ed.querySelectorAll('.ds-panel .ds-roles button')];
    check('role panel: every role, in playerRoleOptions order, the current one marked', JSON.stringify(panelRoles.map(b => b.getAttribute('data-role'))) === JSON.stringify(FIRST.map(r => r.id))
      && panelRoles[0].getAttribute('aria-current') === 'true' && panelRoles[0].querySelector('.ds-role-tag')?.textContent === 'Current' && !!ed.querySelector('.ds-panel.rl-panel .rl-panel-sheet'));
    panelRoles[0].click();
    check('role panel: picking the current role just closes it', !ed.querySelector('.ds-panel') && ew.__nav.href === null);
    rail.querySelector('.rl-change').click();
    ed.querySelector(`.ds-panel .ds-roles button[data-role="${SECOND.id}"]`).click();
    check('PATH role switcher (direct start, no cold open): another role → /game?scenarioId=…&roleId=…', ew.__nav.href === `/game?scenarioId=${SCENARIO_ID}&roleId=${SECOND.id}`, ew.__nav.href);
    ew.__nav.href = null;
    ed.querySelector('.ds-panel .rl-close')?.click();

    // ── Begin: exactly one /start, the native body; the opening streams into the column.
    ew.Math.random = () => 0;
    reply = OPENING;
    model.story = 0;
    ed.querySelector('.ds-entry .ds-begin').click();
    await until(() => ed.querySelector('#choices .choice-btn') && E.log.starts.length === 1, 8000);
    await tick(150);
    check('SLOT: Begin sent exactly ONE /start (200) and one model call', E.log.starts.length === 1 && E.log.starts[0].status === 200 && model.story === 1, `starts=${E.log.starts.length} story=${model.story}`);
    const pick = b => b && ({ roleId: b.roleId, narrativeStyle: b.narrativeStyle, character_context: b.character_context, player_addition: b.player_addition, active_hook: b.active_hook, onboardingFlow: b.onboardingFlow });
    check('PARITY: the /start body = the native flow\'s (role, style, character_context, active_hook, player_addition, onboardingFlow)', !!nativeStart && JSON.stringify(pick(E.log.starts[0].body)) === JSON.stringify(pick(nativeStart)),
      `\n        ds     ${JSON.stringify(pick(E.log.starts[0].body))}\n        native ${JSON.stringify(pick(nativeStart))}`);
    check('after Begin: the opening is in the column; entry controls, html.ds-pre and "change role" gone; bar shown', /FULL OPENING/.test(ed.getElementById('story').textContent) && !ed.querySelector('.ds-begin')
      && !root.classList.contains('ds-pre') && !rail.querySelector('.rl-change') && cs(ew, '.bottom-bar').getPropertyValue('display') !== 'none');
    check('after Begin: still no native overlay', ed.getElementById('role-overlay').classList.contains('hidden') && ed.getElementById('intro-overlay').classList.contains('hidden'));

    // ── PATH restart ("Begin Again" → confirm → restartGame): the same role, in the layout.
    ed.getElementById('restart-confirm-yes').click();
    await until(() => ed.querySelector('.ds-entry .ds-begin'), 4000);
    check('PATH restart: re-enters the entry in the layout, same role, no overlay, no /start', root.classList.contains('ds-pre') && ew.eval('currentRoleId') === FIRST[0].id
      && ed.getElementById('role-overlay').classList.contains('hidden') && ed.getElementById('intro-overlay').classList.contains('hidden') && E.log.starts.length === 1);
    ed.querySelector('.ds-entry .ds-begin').click();
    await until(() => E.log.starts.length === 2 && ed.querySelector('#choices .choice-btn'), 8000);
    check('SLOT: the second Begin (after restart) plays — slot 2 of 2', E.log.starts[1]?.status === 200);
    ed.getElementById('restart-confirm-yes').click();
    await until(() => ed.querySelector('.ds-entry .ds-begin'), 4000);
    ed.querySelector('.ds-entry .ds-begin').click();
    await until(() => E.log.starts.length === 3 && E.log.starts[2].json, 6000);
    check('SLOT: a third Begin → 403 daily — so load + reload spent 0 and each Begin exactly 1', E.log.starts[2].status === 403 && E.log.starts[2].json?.demoLimit === 'daily', JSON.stringify(E.log.starts[2]));
    check('Notes never opened by itself (direct start)', !E.log.notesOpened);
    ew.close();

    // ── ?roleId=: a known role is used; an unknown one falls back to the first.
    const RQ = await openPage(dsNav, BASE, { path: `/game?scenarioId=${SCENARIO_ID}&roleId=${SECOND.id}` });
    await until(() => RQ.doc.querySelector('.ds-entry'), 6000);
    check('?roleId=<second role> → the entry for that role', RQ.win.eval('currentRoleId') === SECOND.id && RQ.doc.querySelector('.ds-role')?.textContent === RQ.win.eval('buildCharacterHeader')(SECOND));
    RQ.win.close();
    const RU = await openPage(dsNav, BASE, { path: `/game?scenarioId=${SCENARIO_ID}&roleId=no_such_role` });
    await until(() => RU.doc.querySelector('.ds-entry'), 6000);
    check('?roleId=<unknown> → the first role', RU.win.eval('currentRoleId') === FIRST[0].id);
    RU.win.close();

    // ── With DEMO_COLD_OPEN on, the panel routes through / (which picks cold open vs direct start).
    const DC = await openPage(dsNavCold, BASE, { path: `/game?scenarioId=${SCENARIO_ID}` });
    await until(() => DC.doc.querySelector('.ds-entry'), 6000);
    DC.doc.querySelector('.rl-rail .rl-change').click();
    DC.doc.querySelector(`.ds-panel .ds-roles button[data-role="${SECOND.id}"]`).click();
    check('PATH role switcher (direct start, cold open on): another role → /?scenarioId=…&roleId=…', DC.win.__nav.href === `/?scenarioId=${SCENARIO_ID}&roleId=${SECOND.id}`, DC.win.__nav.href);
    DC.win.close();

    // ── The cold open's own switcher: a role with no ready row.
    const coJs = withNav(fs.readFileSync(DM.COLD_OPEN_JS_PATH, 'utf8'));
    const coPage = (layout, js) => {
      const h = DM.injectColdOpenIntoGameHtml(DM.injectDemoIntoGameHtml(PAGE), { scenarioId: SCENARIO_ID, roleId: ROLE_ID, timings: FAST, historyUser: CO.COLD_OPEN_HISTORY_USER },
        { css: fs.readFileSync(DM.COLD_OPEN_CSS_PATH, 'utf8'), js });
      return layout ? RL.injectReadingLayoutIntoGameHtml(h, RL_FILES) : h;
    };
    for (const [layout, want] of [[true, `/game?scenarioId=${SCENARIO_ID}&roleId=${SECOND.id}`], [false, `/game?scenarioId=${SCENARIO_ID}`]]) {
      const K2 = await openPage(coPage(layout, coJs), COBASE);
      await until(() => K2.doc.querySelector('.co-head') && K2.doc.getElementById('co-overlay').hidden, 8000);
      check(`cold open (${layout ? 'layout on' : 'layout off'}): no direct start on the cold-open page`, !K2.doc.querySelector('.ds-entry') && !K2.doc.getElementById('direct-start-js') && !K2.doc.documentElement.classList.contains('ds-pre'));
      K2.doc.querySelector('.co-head .co-role').click();
      K2.doc.querySelectorAll('.co-panel .co-roles button')[[...K2.doc.querySelectorAll('.co-panel .co-roles button')].findIndex(b => b.textContent.startsWith(K2.win.eval('getCardDisplayName')(SECOND)))].click();
      check(`PATH role switcher (cold open, ${layout ? 'layout ON' : 'layout OFF'}): a role with no ready row → ${want}`, K2.win.__nav.href === want, K2.win.__nav.href);
      K2.win.close();
    }
  }

  // ── Part D ─────────────────────────────────────────────────────────────────
  console.log('\nPart D — server boots');
  const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); });
  const LIMEN = { DEMO_MODE: 'true', DEMO_SCENARIOS: 'steel_curtain_cantigny,dog_green_sector', DEMO_SITE_NAME: 'Project Limen', DEMO_SITE_URL: 'https://projectlimen.com',
    DEMO_SITE_TAGLINE: 'Cross the threshold of a turning point in history.', DEMO_OG_IMAGE_FILE: 'projectlimen-og.png', DEMO_BUDGET_ID: 'limen' };
  async function bootServer(label, extra) {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), ELEVENLABS_API_KEY: '', LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '', ...LIMEN, ...extra };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    const child = spawn(process.execPath, ['engine/server/server.js'], { cwd: REPO_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${label} did not boot:\n${out.slice(-1500)}`)), 120000);
      const on = d => { out += d; if (out.includes('Engine running at')) { clearTimeout(t); res(); } };
      child.stdout.on('data', on); child.stderr.on('data', on);
      child.on('exit', c => { clearTimeout(t); rej(new Error(`${label} exited ${c}:\n${out.slice(-1500)}`)); });
    });
    const get = async url => { const r = await realFetch(`http://localhost:${port}${url}`, { redirect: 'manual', headers: { 'User-Agent': 'reading-layout-test-bot' } }); return { status: r.status, location: r.headers.get('location'), text: await r.text() }; };
    return { get, base: `http://localhost:${port}`, log: () => out, stop: () => child.kill() };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-test-'));
  const rowsFile = path.join(tmp, 'rows.json');
  fs.writeFileSync(rowsFile, JSON.stringify([row]));
  const s1 = await bootServer('rl + cold open', { DEMO_READING_LAYOUT: 'true', DEMO_COLD_OPEN: 'true', DEMO_FEATURED_SCENARIO: SCENARIO_ID, DEMO_FEATURED_ROLE: ROLE_ID, DEMO_COLD_OPEN_FILE: rowsFile });
  {
    const g = await s1.get('/game?scenarioId=steel_curtain_cantigny');
    check('/game = game page + demo injection + direct start (coldOpen: true) + reading layout, exactly', g.status === 200 && g.text === servedGame(PAGE, { coldOpen: true }));
    const gr = await s1.get('/game?scenarioId=steel_curtain_cantigny&roleId=role_forward_infantryman');
    check('/game?…&roleId= is the same page (the role is read in the page; /game stays cacheable)', gr.status === 200 && gr.text === g.text);
    // PATH 1 — the card grid, end to end: /moments builds its cards from /api/stories; the baked
    // scenario's card goes to its cold open, the non-baked one to /game (the direct start).
    {
      const m = await s1.get('/moments');
      const base1 = s1.base;
      const mdom = new JSDOM(m.text, { url: `${base1}/moments`, runScripts: 'dangerously', beforeParse(w) { w.fetch = (u, o) => realFetch(new URL(u, base1).href, o); } });
      await until(() => mdom.window.document.querySelectorAll('#stories a.story').length >= 2, 8000);
      const hrefs = Object.fromEntries([...mdom.window.document.querySelectorAll('#stories a.story')].map(a => [new URL(a.href).searchParams.get('scenarioId'), a.getAttribute('href')]));
      mdom.window.close();
      check('PATH card grid: Dog Green (baked) → its cold open; Cantigny (not baked) → /game (the direct start)', hrefs.dog_green_sector === '/?scenarioId=dog_green_sector' && hrefs.steel_curtain_cantigny === '/game?scenarioId=steel_curtain_cantigny', JSON.stringify(hrefs));
      const followed = await s1.get(hrefs.steel_curtain_cantigny);
      check('…and that card\'s page is the direct start in the reading layout', followed.text === g.text && followed.text.includes('id="direct-start-js"') && followed.text.includes('id="reading-layout-js"'));
    }
    check('PATH "Another moment": /moments is the card grid (→ the card-grid path above)', (await s1.get('/moments')).status === 200);
    const nb = await s1.get('/?scenarioId=steel_curtain_cantigny');
    check('/ for a non-baked scenario still redirects to /game?scenarioId=… (unchanged)', nb.status === 302 && nb.location === '/game?scenarioId=steel_curtain_cantigny', JSON.stringify(nb.location));
    const toDirect = await s1.get('/?scenarioId=dog_green_sector&roleId=role_coxswain');
    check('PATH role switcher: / + a role with no ready row → /game?scenarioId=…&roleId=… (the direct start in that role)', toDirect.status === 302 && toDirect.location === '/game?scenarioId=dog_green_sector&roleId=role_coxswain', JSON.stringify(toDirect.location));
    const toCold = await s1.get(`/?scenarioId=dog_green_sector&roleId=${ROLE_ID}`);
    check('PATH role switcher: / + a ready role → that role\'s cold open (served, not redirected)', toCold.status === 200 && toCold.text.includes(`"roleId":"${ROLE_ID}"`) && toCold.text.includes('id="cold-open-js"'));
    const cantRole = await s1.get('/?scenarioId=steel_curtain_cantigny&roleId=role_unknown_x');
    check('/ + a role on a non-baked scenario → the direct start with that role id (the page falls back to the first role if unknown)', cantRole.status === 302 && cantRole.location === '/game?scenarioId=steel_curtain_cantigny&roleId=role_unknown_x');
    const off = await s1.get('/?scenarioId=not_whitelisted&roleId=x');
    check('/ + roleId on a scenario outside the whitelist → the featured entry, as before (no redirect)', off.status === 200 && off.text.includes(`"roleId":"${ROLE_ID}"`));
    const r = await s1.get('/');
    const expected = RL.injectReadingLayoutIntoGameHtml(DM.injectColdOpenIntoGameHtml(DM.injectDemoIntoGameHtml(PAGE),
      { scenarioId: SCENARIO_ID, roleId: ROLE_ID, timings: CO.COLD_OPEN_TIMINGS, historyUser: CO.COLD_OPEN_HISTORY_USER },
      { css: fs.readFileSync(DM.COLD_OPEN_CSS_PATH, 'utf8'), js: fs.readFileSync(DM.COLD_OPEN_JS_PATH, 'utf8') }), RL_FILES);
    check('/ (cold open) = cold-open page + reading layout, exactly', r.status === 200 && r.text === expected);
    const h = JSON.parse((await s1.get('/health')).text);
    check('/health: readingLayout true; boot log says enabled', h.readingLayout === true && /\[READING-LAYOUT\] enabled/.test(s1.log()));
    check('COST (server): page loads logged no model call', !/\[USAGE\]|\[START\]|\[TURN\]/.test(s1.log()));
  }
  s1.stop();
  const s2 = await bootServer('rl off, cold open on', { DEMO_COLD_OPEN: 'true', DEMO_FEATURED_SCENARIO: SCENARIO_ID, DEMO_FEATURED_ROLE: ROLE_ID, DEMO_COLD_OPEN_FILE: rowsFile, DEMO_READING_LAYOUT: undefined });
  {
    const g = await s2.get('/game');
    const r = await s2.get('/');
    const h = JSON.parse((await s2.get('/health')).text);
    check('flag off: /game has no layout and no direct start (demo injection only)', g.text === DM.injectDemoIntoGameHtml(PAGE) && !g.text.includes('direct-start'));
    const gq = await s2.get('/game?scenarioId=dog_green_sector&roleId=role_coxswain');
    check('flag off: /game?…&roleId= is the same plain demo page', gq.text === DM.injectDemoIntoGameHtml(PAGE));
    check('flag off: the cold-open page has no layout', !r.text.includes('reading-layout') && r.text.includes('id="cold-open-js"'));
    check('flag off: /health has no readingLayout key, no boot line', !('readingLayout' in h) && !/READING-LAYOUT/.test(s2.log()));
  }
  s2.stop();
} catch (err) {
  console.error(`\nERROR  ${err.stack || err.message}`);
  failed++;
} finally {
  for (const s of servers) s.close();
  for (const c of children) c.kill();
  globalThis.fetch = realFetch;
  const sweep = () => { for (const d of SWEEP) for (const f of snapshotDir(d)) if (!before[d].has(f)) fs.rmSync(p(d, f), { force: true }); };
  sweep(); await tick(1500); sweep();
}

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll reading-layout assertions passed.');
process.exit(failed ? 1 : 0);
