// B2b-PLAYER — what the player SEES of scenes, on the REAL engine/game/index.html in jsdom.
//
// The page talks to a real game router for /bootstrap (real scenario + locations); /turn is
// scripted here — SSE events exactly as the router sends them (scene, chunk, done) — and /tts
// is captured, so each turn's header, reading flow, model history and narration request can be
// checked without a model.
//
//   1. A scene session (Joan): header "date · place" from the NARRATED scene (never a turn
//      early), a time-only jump changes the date, the bridge leads the turn on entry turns
//      only (not the opening, not the fork turn), streams in ahead of the narration, reaches
//      /tts and the model history; the collapsed bar and "Where You Are" follow the scene;
//      a restart clears it.
//   2. A session without scenes: the same turns rendered by this page and by the committed
//      (HEAD) page must be byte-identical — DOM, header, bar, notes, /tts body, history.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { execFileSync } from 'child_process';
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
const { arcScenes }           = await import(`${ROOT}/engine/services/PromptComposer.js`);

const JOAN_ID = 'joan_trial_rouen_1431';
const CH_ID   = 'chicago_1893_v1';
const store = new JsonFileStore(p('engine/data'));
const repos = {
  characters: new CharacterRepository(store), locations: new LocationRepository(store), clues: new ClueRepository(store),
  scenarios: new ScenarioRepository(store), storyArcs: new StoryArcRepository(store), players: new PlayerRepository(store),
  sessions: new SessionRepository(store),
};
const JOAN_ARC = repos.storyArcs.findById(`${JOAN_ID}_main_arc`);
if (!JOAN_ARC || !arcScenes(JOAN_ARC).length || !(await repos.scenarios.findById(CH_ID))) {
  console.log('SKIP  scene-player.test — Joan scenes / Chicago scenario not available (needs restored data).');
  process.exit(0);
}

let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  — ${detail}` : ''}`); };
const head  = t => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 74 - t.length))}`);

const { createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/game/api', createGameRouter(repos, { anthropicApiKey: 'scene-player-test-key' }));
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const realFetch = globalThis.fetch;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The page, with /turn scripted and /tts captured ─────────────────────────
async function boot(html, scenarioId) {
  const io = { tts: [], turns: [], queue: [] };
  const dom = new JSDOM(html, {
    url: `${BASE}/game?scenarioId=${scenarioId}`, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = async (u, o = {}) => {
        const url = String(u);
        if (url.includes('/game/api/tts'))  { io.tts.push(JSON.parse(o.body)); return new Response('audio'); }
        if (url.includes('/game/api/turn')) { io.turns.push(JSON.parse(o.body)); return io.queue.shift()(); }
        if (url.includes('/extract-facts') || url.includes('/notes')) return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
        return realFetch(new URL(url, BASE).href, o);
      };
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollIntoView = () => {};
      win.speechSynthesis ??= { getVoices: () => [], cancel() {}, speak() {} };
      win.TextDecoder ??= TextDecoder;
      win.URL.createObjectURL = () => 'blob:test';
      win.URL.revokeObjectURL = () => {};
      win.console.error = () => {};
    },
  });
  const win = dom.window;
  await new Promise(r => win.addEventListener('load', r, { once: true }));
  const ready = () => { try { return !!win.eval('typeof scenario !== "undefined" && scenario'); } catch { return false; } };
  for (let i = 0; i < 100 && !ready(); i++) await sleep(100);
  if (!ready()) throw new Error('scene-player.test: client never loaded via /bootstrap');
  // Narration on, audio "unlocked": every rendered turn asks /tts for its audio.
  win.eval(`ttsEnabled = true; audioUnlocked = true; audioEl = { play: async () => {}, pause() {}, src: '', playbackRate: 1 };`);
  return { dom, win, io };
}

const sse = evs => () => new Response(evs.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });

// The opening, as startGame applies it (state, header, render) — without a model.
function open(win, state, output) {
  win.eval(`gameState = ${JSON.stringify(state)}; sessionId = 'scene-player-test';
    document.querySelector('header.hero').classList.add('game-active');
    renderSidebar(); updateLocationDisplay(gameState.location); renderOutput(${JSON.stringify(output)});`);
}

async function turn(b, output, nextState, { stream = null } = {}) {
  b.io.queue.push(stream || sse([...(output.scene ? [{ type: 'scene', scene: output.scene }] : []), { type: 'chunk', text: output.narrative }, { type: 'done', output, nextState }]));
  await b.win.eval(`submitTurn(${JSON.stringify('I answer.')})`);
  // /tts fires 300ms after the render — wait for THIS turn's request (by its narration).
  const mine = () => b.io.tts.findLastIndex(t => t.text === output.narrative);
  for (let i = 0; i < 30 && mine() < 0; i++) await sleep(50);
  return snap(b, mine());
}

// Everything the player can see or hear of the latest turn, plus what the model will be sent.
function snap(b, ttsAt = -1) {
  const d = b.win.document;
  const cards = [...d.querySelectorAll('#story .scene-card')];
  const card = cards[cards.length - 1];
  b.win.eval('renderNotes({})');
  return {
    title:   d.getElementById('header-title').textContent,
    sub:     d.getElementById('header-subtitle').textContent,
    bar:     d.getElementById('slim-scene-label').textContent,
    story:   d.getElementById('story').innerHTML,
    first:   card?.firstElementChild?.className || '',
    bridges: [...(card?.querySelectorAll('.scene-bridge') || [])].map(e => e.textContent),
    notes:   d.getElementById('notes-content').innerHTML,
    tts:     ttsAt >= 0 ? b.io.tts[ttsAt] : null,
    history: b.win.eval('JSON.stringify(conversationHistory)'),
  };
}

const NARR = n => `The assessors murmur; the scribes dip their pens (${n}).`;
const CHOICES = ['Answer carefully', 'Say nothing', 'Ask for counsel'];
const base = (loc, turnCount, scenarioId) => ({ scenarioId, location: loc, act: 1, remainingMinutes: 30 - 2 * turnCount, elapsedMinutes: 2 * turnCount, turnCount, npc_states: {}, discoveredFacts: [], visitedLocations: [loc], glossary: [] });

try {
  // ═══ 1. A SCENE SESSION ═══════════════════════════════════════════════════
  head('1. Joan — header, lead paragraph, stream, tts, history, notes');
  const html = fs.readFileSync(p('engine/game/index.html'), 'utf8');
  const b = await boot(html, JOAN_ID);
  const LOCS = JSON.parse(b.win.eval('JSON.stringify(locationsList)'));
  const SC   = Object.fromEntries(arcScenes(JOAN_ARC).map(s => [s.id, s]));
  const name = id => LOCS.find(l => l.id === id)?.name || id;
  const short = id => name(id).split(' — ')[0];
  const scene = (id, bridge = false) => ({ id, date: SC[id].date_label, place: name(SC[id].location_id), location_id: SC[id].location_id, ...(bridge ? { bridge: SC[id].bridge } : {}) });
  const HALL = 'great_hall_rouen_castle', CELL = 'joan_prison_cell';
  check('fixture: the hall and cell names carry a " — " gloss; scene_24_feb / 17_mar / 28_may have bridges', name(HALL).includes(' — ') && name(CELL).includes(' — ') && !!SC.scene_24_feb.bridge && !!SC.scene_17_mar.bridge && !!SC.scene_28_may.bridge && !SC.scene_21_feb.bridge);

  open(b.win, base(HALL, 0, JOAN_ID), { narrative: 'Opening narration.', choices: CHOICES, scene: scene('scene_21_feb') });
  let s = snap(b);
  check('opening: title is the full location name', s.title === name(HALL), s.title);
  check('opening: subtitle is "21 February 1431 · Great Hall, Rouen Castle"', s.sub === `21 February 1431 · ${short(HALL)}`, s.sub);
  check('opening: the collapsed bar shows the subtitle alone', s.bar === s.sub, s.bar);
  check('opening: scene_21_feb shows no lead paragraph', s.bridges.length === 0 && !s.story.includes('scene-bridge'));

  s = await turn(b, { narrative: NARR(1), choices: CHOICES, scene: scene('scene_21_feb') }, base(HALL, 1, JOAN_ID));
  check('turn 1 (scene_21_feb): no bridge, header unchanged', s.bridges.length === 0 && s.sub === `21 February 1431 · ${short(HALL)}`, s.sub);
  check('turn 1: /tts carries no bridge', !!s.tts && !('bridge' in s.tts), JSON.stringify(s.tts));

  s = await turn(b, { narrative: NARR(2), choices: CHOICES, scene: scene('scene_21_feb') }, base(HALL, 2, JOAN_ID));
  s = await turn(b, { narrative: NARR(3), choices: CHOICES, scene: scene('scene_24_feb', true) }, base(HALL, 3, JOAN_ID));
  check('turn 3 opens scene_24_feb — a TIME-ONLY jump: same title, the subtitle\'s date changes', s.title === name(HALL) && s.sub === `24 February 1431 · ${short(HALL)}`, s.sub);
  check('turn 3: the bridge is the lead paragraph — the first element of the turn, verbatim', s.first === 'scene-bridge' && s.bridges.length === 1 && s.bridges[0] === SC.scene_24_feb.bridge, s.first);
  check('turn 3: ...above the narration, in the same reading flow (one scene-card, no button)', s.story.indexOf('scene-bridge') < s.story.indexOf(NARR(3)) && !/<button[^>]*>[^<]*<\/button>/.test(s.story.slice(s.story.indexOf('scene-bridge'), s.story.indexOf(NARR(3)))));
  check('turn 3: /tts carries the bridge (spoken before the narration)', s.tts?.bridge === SC.scene_24_feb.bridge && s.tts.text === NARR(3), JSON.stringify(s.tts).slice(0, 120));
  check('turn 3: the model history carries the bridge ahead of the narration', s.history.includes(JSON.stringify(`${SC.scene_24_feb.bridge}\n\n${NARR(3)}`).slice(1, -1)));
  check('turn 3: the collapsed bar follows the date', s.bar === s.sub, s.bar);

  // Turn 4 ends scene_24_feb: the engine already holds the NEXT scene's place (the cell) in
  // nextState — but the narration is still in the hall, and so is the header.
  s = await turn(b, { narrative: NARR(4), choices: CHOICES, scene: scene('scene_24_feb') }, base(CELL, 4, JOAN_ID));
  check('turn 4: no turn-early place — state already held in the cell, header still the hall', s.title === name(HALL) && s.sub === `24 February 1431 · ${short(HALL)}`, `${s.title} | ${s.sub}`);
  check('turn 4: "Where You Are" follows the narrated scene (the hall), not the held state', s.notes.includes(name(HALL)) && !s.notes.includes(name(CELL)));
  check('turn 4: not an entry turn — no bridge, none in /tts', s.bridges.length === 0 && !('bridge' in (s.tts || {})));

  // Turn 5 opens scene_17_mar, streamed: the bridge must lead the text while it streams in.
  let ctl; const enc = new TextEncoder();
  const body = new ReadableStream({ start(c) { ctl = c; } });
  const out5 = { narrative: NARR(5), choices: CHOICES, scene: scene('scene_17_mar', true) };
  const pending = turn(b, out5, base(CELL, 5, JOAN_ID), { stream: () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }) });
  for (let i = 0; i < 40 && !ctl; i++) await sleep(25);
  await sleep(450);   // past submitTurn's fade
  const hdr = () => { const d = b.win.document; return { title: d.getElementById('header-title').textContent, sub: d.getElementById('header-subtitle').textContent, bar: d.getElementById('slim-scene-label').textContent }; };
  const hdr4 = hdr();
  check('turn 5 WAITING: before the scene event the header still shows the scene in play (the hall)', hdr4.title === name(HALL) && !hdr4.sub.startsWith('17 March'), hdr4.sub);
  // The scene event arrives on its own, before any prose.
  ctl.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'scene', scene: out5.scene })}\n\n`));
  await sleep(100);
  const hdrEarly = hdr();
  const proseYet = [...b.win.document.querySelectorAll('#story .scene-card')].length;
  check('turn 5 SCENE EVENT: the header flips to the cell and 17 March BEFORE any narration has streamed', proseYet === 0 && hdrEarly.title === name(CELL) && hdrEarly.sub === `17 March 1431 · ${short(CELL)}` && hdrEarly.bar === hdrEarly.sub, `${proseYet} card(s) | ${hdrEarly.title} | ${hdrEarly.sub}`);
  ctl.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'chunk', text: 'The cell is' })}\n\n`));
  await sleep(100);
  const hdrStreaming = hdr();
  check('turn 5 STREAMING: the header stays on the new scene while the narration streams beneath it', JSON.stringify(hdrStreaming) === JSON.stringify(hdrEarly), hdrStreaming.sub);
  const streaming = [...b.win.document.querySelectorAll('#story .scene-card')].pop();
  check('turn 5 STREAMING: the bridge leads the card while the narration streams in under it', streaming?.firstElementChild?.className === 'scene-bridge' && streaming.textContent.startsWith(SC.scene_17_mar.bridge) && streaming.textContent.endsWith('The cell is'), streaming?.textContent?.slice(0, 60));
  ctl.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'done', output: out5, nextState: base(CELL, 5, JOAN_ID) })}\n\n`)); ctl.close();
  s = await pending;
  check('turn 5 opens scene_17_mar: title and subtitle move to the cell and its date', s.title === name(CELL) && s.sub === `17 March 1431 · ${short(CELL)}`, `${s.title} | ${s.sub}`);
  check('turn 5: the final render keeps exactly one lead paragraph', s.first === 'scene-bridge' && s.bridges.length === 1 && s.bridges[0] === SC.scene_17_mar.bridge);

  // A turn whose scene event arrives but which then FAILS: the header goes back to the scene in play.
  const before = hdr();
  b.io.queue.push(sse([{ type: 'scene', scene: scene('scene_28_may') }, { type: 'error', error: 'model unavailable' }]));
  await b.win.eval(`submitTurn('I answer.')`);
  const after = hdr();
  check('failed turn: the early header flip is rolled back to the scene still in play (17 March, the cell)', JSON.stringify(after) === JSON.stringify(before) && b.win.eval('currentScene.id') === 'scene_17_mar', `${after.sub} / ${b.win.eval('currentScene.id')}`);

  // The fork turn opens scene_28_may with NO bridge (the server omits it; the setup is the transition).
  const fork = { narrative: NARR(6), choices: ['A', 'B', 'C'], definingMoment: { momentId: 'joan_defining_choice', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }] }, scene: scene('scene_28_may') };
  s = await turn(b, fork, base(CELL, 6, JOAN_ID));
  check('fork turn: the header moves to 28 May, no lead paragraph, no bridge in /tts', s.sub === `28 May 1431 · ${short(CELL)}` && s.bridges.length === 0 && !('bridge' in (s.tts || {})), s.sub);

  // Narration speed (6e6f61b): the scenario's set speed rides on every /tts; unset sends nothing,
  // so the server's 0.9 plays; a speed set to 1.0 sends 1.0 (it used to be dropped as "the
  // default" and play at 0.9). Joan's own speed is whatever the scenario stores — read, not assumed.
  const joanSpeed = b.win.eval('scenario.tts_narration_speed ?? null');
  check(`the scenario's narration speed (${joanSpeed}) is what /tts carries`, b.io.tts.length > 0 && b.io.tts.every(t => joanSpeed == null ? !('narrative_speed' in t) : t.narrative_speed === joanSpeed), JSON.stringify(b.io.tts.map(t => t.narrative_speed)));
  b.win.eval('ttsNarrationSpeed = null');
  const ttsBefore = b.io.tts.length;
  s = await turn(b, { narrative: NARR(8), choices: CHOICES, scene: scene('scene_28_may') }, base(CELL, 7, JOAN_ID));
  check('unset narration speed: /tts carries no narrative_speed', b.io.tts.length > ttsBefore && b.io.tts.slice(ttsBefore).every(t => !('narrative_speed' in t)));
  b.win.eval('ttsNarrationSpeed = 1.0');
  s = await turn(b, { narrative: NARR(7), choices: CHOICES, scene: scene('scene_28_may') }, base(CELL, 7, JOAN_ID));
  check('narration speed set to 1.0: /tts carries narrative_speed 1 (1.0 in admin plays 1.0)', s.tts?.narrative_speed === 1, JSON.stringify(s.tts?.narrative_speed));
  b.win.eval('ttsNarrationSpeed = null');

  // Every /turn request the page sent carried the plain state — nothing presentational.
  check('the page never posts its scene back to /turn', b.io.turns.every(t => !JSON.stringify(t.state).includes('"scene"')));

  b.win.eval('restartGame()');
  check('restart clears the scene (and its last bridge) — a new session starts without one', b.win.eval('currentScene === null && lastRenderedBridge === null'));
  b.dom.window.close();

  // ═══ 2. A SESSION WITHOUT SCENES — byte-identical to the committed page ═══
  head('2. Chicago (no scenes) — this page vs HEAD, byte for byte');
  const headHtml = execFileSync('git', ['show', 'HEAD:engine/game/index.html'], { cwd: REPO_DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
  const LOC_A = 'administration_building', LOC_B = 'manufactures_building';
  async function playPlain(pageHtml) {
    const pb = await boot(pageHtml, CH_ID);
    const snaps = [];
    open(pb.win, base(LOC_A, 0, CH_ID), { narrative: 'Opening narration.', choices: CHOICES, sensory_opening: 'Coal smoke and lake wind.' });
    snaps.push(snap(pb));
    snaps.push(await turn(pb, { narrative: NARR(1), choices: CHOICES }, base(LOC_A, 1, CH_ID)));
    snaps.push(await turn(pb, { narrative: NARR(2), choices: CHOICES, sensory_opening: 'The hall is cavernous.' }, base(LOC_B, 2, CH_ID)));
    snaps.push(await turn(pb, { narrative: NARR(3), choices: CHOICES }, base(LOC_B, 3, CH_ID)));
    pb.dom.window.close();
    return snaps;
  }
  const now = await playPlain(html), was = await playPlain(headHtml);
  for (const k of ['title', 'sub', 'bar', 'story', 'notes', 'tts', 'history']) {
    const same = now.every((x, i) => JSON.stringify(x[k]) === JSON.stringify(was[i][k]));
    check(`no scenes: ${k} identical to HEAD on the opening and every turn`, same, same ? '' : `${JSON.stringify(now.map(x => x[k])).slice(0, 160)} vs ${JSON.stringify(was.map(x => x[k])).slice(0, 160)}`);
  }
  check('no scenes: the page rendered real turns (sanity)', now[3].story.includes(NARR(3)) && !!now[3].tts && now[2].title !== now[0].title);
} finally {
  server.close();
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll scene-player assertions passed.');
process.exit(fails ? 1 : 0);
