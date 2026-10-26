// SEAMLESS TURN FINISH (engine/game/index.html submitTurn → renderOutput).
//
// A turn's prose streams into a scene card; when `done` arrived the page used to REMOVE that card
// and build a new one from the final output with different markup (every plain line italic,
// dialogue split into speaker + speech, the sensory opening popping in on top), so the prose the
// player had just watched visibly rebuilt itself. Now the streamed card is formatted through the
// same builder as the final render, and `done` REUSES it — rewriting it in place only when the
// final text actually differs from what streamed.
//
// Part 1 drives the REAL page in jsdom (bootstrap stubbed, /turn scripted chunk by chunk).
// Part 2 checks the server's stream extractor: sensory_opening streams, the narrative's end is
// signalled, and an escape split across two reads is decoded whole. No model calls, no data.
//
//   node tests/stream-finish.test.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { JSDOM } from 'jsdom';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const head  = s => console.log(`\n── ${s}`);
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`); if (!ok) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Part 1: the page ──────────────────────────────────────────────────────────
const BOOT = {
  scenario: { id: 'stream_test', title: 'Stream Test', sessionTargetMinutes: 15, playerRoleOptions: [] },
  locations: [{ id: 'loc_a', name: 'Hall A' }, { id: 'loc_b', name: 'Hall B' }],
  characters: [], cluesCatalog: [],
};
const json = o => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });

async function boot() {
  const io = { queue: [] };
  const dom = new JSDOM(fs.readFileSync(path.join(REPO_DIR, 'engine/game/index.html'), 'utf8'), {
    url: 'http://localhost/game?scenarioId=stream_test', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = async u => {
        const url = String(u);
        if (url.includes('/bootstrap')) return json(BOOT);
        if (url.includes('/turn'))      return io.queue.shift()();
        return json({});
      };
      win.scrollTo = () => {};
      win.HTMLElement.prototype.scrollIntoView = () => {};
      win.speechSynthesis ??= { getVoices: () => [], cancel() {}, speak() {} };
      win.TextDecoder ??= TextDecoder;
      win.console.error = () => {};
    },
  });
  const win = dom.window;
  await new Promise(r => win.addEventListener('load', r, { once: true }));
  const ready = () => { try { return !!win.eval('typeof scenario !== "undefined" && scenario'); } catch { return false; } };
  for (let i = 0; i < 100 && !ready(); i++) await sleep(50);
  if (!ready()) throw new Error('stream-finish.test: page never loaded the stubbed bootstrap');
  win.eval(`ttsEnabled = false;
    gameState = { scenarioId: 'stream_test', location: 'loc_a', act: 1, remainingMinutes: 20, elapsedMinutes: 2, turnCount: 1, npc_states: {}, discoveredFacts: [], visitedLocations: ['loc_a'], glossary: [] };
    sessionId = 'stream-finish-test';
    renderOutput({ narrative: 'Opening narration.', choices: ['Wait'] });`);
  return { dom, win, io };
}

// A /turn response the test feeds event by event.
function controlledTurn(io) {
  let ctl;
  const enc  = new TextEncoder();
  const body = new ReadableStream({ start(c) { ctl = c; } });
  io.queue.push(() => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  return {
    send: evt => ctl.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`)),
    close: () => ctl.close(),
  };
}

const LINES = ['*Ignatius sets down the cup.*', 'Inigo: "We leave at first light."', 'The candle gutters in the draught.'];
const NARR  = LINES.join('\n');
const SENSORY = 'Woodsmoke and wet stone.';
const CHOICES = ['Agree', 'Refuse'];
const next = (loc, turnCount) => ({ scenarioId: 'stream_test', location: loc, act: 1, remainingMinutes: 18, elapsedMinutes: 4, turnCount, npc_states: {}, discoveredFacts: [], visitedLocations: [loc], glossary: [] });

// What renderOutput builds for an output, formatted, in a detached card — the reference.
const expectedCard = (win, output) => win.eval(`(() => {
  const el = document.createElement('div');
  el.innerHTML = sceneCardHtml(null, ${JSON.stringify(output.sensory_opening ?? null)}, markupNarrative(${JSON.stringify(output.narrative)}));
  applyRedesignDialogueFormatting(el);
  return el.innerHTML;
})()`);
const lastCard = win => [...win.document.querySelectorAll('#story .scene-card')].pop();

const b = await boot();
try {
  // ── A clean streamed turn ──────────────────────────────────────────────────
  head('clean turn — the streamed card is the final card, untouched by `done`');
  const t = controlledTurn(b.io);
  const output = { narrative: NARR, sensory_opening: SENSORY, choices: CHOICES };
  const pending = b.win.eval(`submitTurn('I agree to go.')`);
  await sleep(450);   // past submitTurn's fade

  t.send({ type: 'chunk', field: 'sensory_opening', text: SENSORY });
  t.send({ type: 'chunk', text: `${LINES[0]}\n${LINES[1].slice(0, 12)}` });   // the dialogue line half-arrived
  await sleep(50);
  const card = lastCard(b.win);
  check('sensory opening streams in at the top of the card', card?.firstElementChild?.className === 'sensory-opening' && card.firstElementChild.textContent === SENSORY, card?.innerHTML.slice(0, 120));
  check('a complete line is formatted while streaming (the italic line)', !!card?.querySelector('.line em') && card.querySelector('.line em').textContent === 'Ignatius sets down the cup.');
  const tail = [...card.querySelectorAll('.line')].pop();
  check('a half-arrived line renders plain — not split, not italic', tail?.textContent === LINES[1].slice(0, 12) && !tail.querySelector('em, .redesign-dialogue-speaker'), tail?.outerHTML);

  t.send({ type: 'chunk', text: `${LINES[1].slice(12)}\n${LINES[2]}` });
  await sleep(50);
  check('once its newline arrives the dialogue line is split into speaker + speech', card.querySelector('.redesign-dialogue-speaker')?.textContent === 'Inigo');
  t.send({ type: 'narrative_end' });
  await sleep(50);
  const streamedHtml = card.innerHTML;
  check('at narrative_end the streamed card already shows the final render', streamedHtml === expectedCard(b.win, output), streamedHtml);

  const mutations = [];
  new b.win.MutationObserver(m => mutations.push(...m)).observe(card, { childList: true, subtree: true, characterData: true, attributes: true });
  t.send({ type: 'done', output, nextState: next('loc_a', 2) }); t.close();
  await pending;
  await sleep(20);
  check('the streamed card is REUSED — same element, still in the feed', lastCard(b.win) === card && card.isConnected);
  check('exactly one scene card for the turn', card.closest('.feed-entry').querySelectorAll('.scene-card').length === 1);
  check('`done` changes nothing in the card (no rebuild, no flash)', mutations.length === 0, `${mutations.length} mutation(s)`);
  check('final content matches the server output', card.innerHTML === expectedCard(b.win, output));
  check('the player\'s line still leads the turn', card.closest('.feed-entry').querySelector('.player-turn')?.textContent === 'I agree to go.');
  check('the choices rendered', b.win.document.querySelectorAll('#choices button').length >= CHOICES.length);

  // ── A turn whose final text differs from the stream (retry / server text fix) ─
  head('final differs from the stream — rewritten in place, same element');
  const t2 = controlledTurn(b.io);
  const p2 = b.win.eval(`submitTurn('I refuse.')`);
  await sleep(450);
  t2.send({ type: 'chunk', text: 'char_inigo: "Then stay."' });
  t2.send({ type: 'narrative_end' });
  await sleep(50);
  const card2 = lastCard(b.win);
  const out2 = { narrative: 'Inigo: "Then stay."', choices: CHOICES };
  t2.send({ type: 'done', output: out2, nextState: next('loc_a', 3) }); t2.close();
  await p2;
  check('same element kept', lastCard(b.win) === card2 && card2.isConnected);
  check('its content is the server\'s final text', card2.innerHTML === expectedCard(b.win, out2) && !card2.textContent.includes('char_inigo'), card2.innerHTML);

  // ── A location change that would have wiped the feed ───────────────────────
  head('location change with a streamed card showing — the feed is not wiped');
  b.win.eval(`feedLocationId = 'loc_elsewhere'`);   // forces the non-transition clear branch
  const t3 = controlledTurn(b.io);
  const p3 = b.win.eval(`submitTurn('I walk on.')`);
  await sleep(450);
  t3.send({ type: 'chunk', text: 'The corridor narrows.' });
  t3.send({ type: 'narrative_end' });
  await sleep(50);
  const card3 = lastCard(b.win);
  t3.send({ type: 'done', output: { narrative: 'The corridor narrows.', choices: CHOICES }, nextState: next('loc_a', 4) }); t3.close();
  await p3;
  check('the streamed card survives', card3.isConnected && lastCard(b.win) === card3);
  check('the player\'s line survives', card3.closest('.feed-entry')?.querySelector('.player-turn')?.textContent === 'I walk on.');
} finally {
  b.dom.window.close();
}

// ── Part 2: the server's stream extractor ─────────────────────────────────────
head('server — collectAnthropicStream');
const { collectAnthropicStream } = await import(`${pathToFileURL(REPO_DIR).href}/engine/server/gameRouter.js`);
function anthropicStream(pieces) {
  const enc = new TextEncoder();
  const lines = pieces.map(t => `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })}\n`);
  lines.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n`);
  return new Response(new ReadableStream({ start(c) { lines.forEach(l => c.enqueue(enc.encode(l))); c.close(); } }));
}
// The dash goes over the wire as a \u escape, as a model may send it.
const reply = JSON.stringify({ sensory_opening: 'Smoke — and rain.', narrative: 'Inigo: "Go."\nHe waits.', choices: ['A'] }).replace('—', '\\u2014');
// Split mid-escape: the cut lands between a backslash and its letter, and inside a \u escape.
const at = [reply.indexOf('\\"') + 1, reply.indexOf('\\u') + 3].sort((x, y) => x - y);
const pieces = [reply.slice(0, at[0]), reply.slice(at[0], at[1]), reply.slice(at[1])];
const got = { narr: '', sens: '', ends: 0, order: [] };
const r = await collectAnthropicStream(anthropicStream(pieces),
  c => { got.narr += c; got.order.push('n'); },
  { onSensoryChunk: c => { got.sens += c; got.order.push('s'); }, onNarrativeEnd: () => { got.ends++; got.order.push('end'); } });
check('narrative streams decoded exactly', got.narr === 'Inigo: "Go."\nHe waits.', JSON.stringify(got.narr));
check('sensory_opening streams decoded exactly', got.sens === 'Smoke — and rain.', JSON.stringify(got.sens));
check('narrative_end fires once, after the last narrative chunk', got.ends === 1 && got.order.at(-1) === 'end', got.order.join(','));
check('the full text is still returned for parsing', r.text === reply && r.stopReason === 'end_turn');
const plain = { narr: '', calls: 0 };
await collectAnthropicStream(anthropicStream([reply]), c => { plain.narr += c; plain.calls++; });
check('without the options (the /start opening) only the narrative streams, as before', plain.narr === 'Inigo: "Go."\nHe waits.');

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll stream-finish assertions passed.');
process.exit(fails ? 1 : 0);
