// CLOSING LOADER → EPILOGUE HANDOFF (engine/game/index.html, showClosingScreen).
//
// "Composing your session…" used to be removed the instant `done` arrived, while the epilogue
// only faded in later (5.5s on the timer path, after the whole narration on the TTS path), so
// the player sat in front of an empty black screen that read as hung or finished. The loader
// must now stay up until the first section after it is actually appearing, and cross-fade out
// as that section fades in — on the timer path, the narration path, and the failure paths.
//
// Drives the REAL showClosingScreen source in jsdom on a VIRTUAL clock and samples the screen
// after every timer: at no instant may the loader be gone with nothing revealed in its place.
// No server, no model calls, no data writes.
//
//   node tests/closing-loader-handoff.test.mjs                 assertions + trace
//   node tests/closing-loader-handoff.test.mjs --html <file>   trace another index.html (e.g. HEAD's)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlArg  = process.argv.indexOf('--html');
const htmlPath = htmlArg > 0 ? process.argv[htmlArg + 1] : path.join(REPO_DIR, 'engine/game/index.html');
let fails = 0;
const head  = s => console.log(`\n── ${s}`);
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`); if (!ok) fails++; };

const html = fs.readFileSync(htmlPath, 'utf8');
const src  = html.match(/function showClosingScreen\(endState, sessionId\) \{[\s\S]*?\n\}\n/)?.[0];
check('showClosingScreen found in index.html', !!src);
if (!src) process.exit(1);

const DOM_IDS = ['closing-overlay', 'closing-dots', 'closing-prose', 'closing-aftermath', 'closing-epilogue',
  'closing-epilogue-session', 'closing-epilogue-session-text', 'closing-epilogue-record', 'closing-epilogue-record-text',
  'closing-bibliography', 'closing-bibliography-list', 'closing-composite-note', 'closing-composite-note-text',
  'closing-return', 'closing-epilogue-loading', 'closing-wait'];

const IO = { summary: 'He left Loyola for Montserrat.', key_facts: ['In 1540 he founded the Society of Jesus.'] };
const SCENARIO = { id: 's', epilogue: { generated: true, reviewed: true, immediate_outcome: IO } };
const PENDING  = { type: 'epilogue_pending' };
const DONE     = { type: 'done', epilogue: { session_block: 'S.', record_block: 'R.' } };
const SPEAK_MS = 8000;   // each narrated block, TTS path
const HORIZON  = 60000;  // stop before the 75s abort/backstop timers

// events: SSE events to stream, or ['pending-then-reject'] for a network failure after the
// loader is up. Returns the screen's state transitions on the virtual clock, t=0 at `done`.
async function run({ scenario = SCENARIO, events, tts = false }) {
  const dom = new JSDOM(`<body>${DOM_IDS.map(id => `<div id="${id}"></div>`).join('')}</body>`, { runScripts: 'outside-only' });
  const w = dom.window;
  w.TextDecoder = TextDecoder;
  let now = 0, seq = 0;
  const timers = new Map();
  w.setTimeout   = (fn, ms) => { const id = ++seq; timers.set(id, { t: now + (ms || 0), fn, id }); return id; };
  w.clearTimeout = id => timers.delete(id);
  w.__scenario = scenario;
  const reject = events === 'pending-then-reject';
  const sse = reject ? [PENDING] : events;
  w.__fetch = async () => {
    const bytes = new TextEncoder().encode(sse.map(e => `data: ${JSON.stringify(e)}\n`).join(''));
    let sent = false;
    return { body: { getReader: () => ({ read: async () => {
      if (!sent) { sent = true; return { done: false, value: bytes }; }
      if (reject) throw new Error('network down');
      return { done: true };
    } }) } };
  };
  w.eval(`var closingShown = false; var scenario = window.__scenario; var API_BASE = '/game/api';
    var currentRoleId = 'r'; var ttsEnabled = ${tts}; var fetch = window.__fetch;
    function syncClosingNarrationBtn() {}
    function speakAtLeast() { return new Promise(r => setTimeout(r, ${SPEAK_MS})); }
    ${src}
    showClosingScreen(null, 'sess');`);
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
  const $ = id => w.document.getElementById(id);
  const sample = () => {
    const ld = $('closing-epilogue-loading');
    const loader = !ld.classList.contains('visible') ? 'gone' : ld.classList.contains('leaving') ? 'fading out' : 'shown';
    const shown = ['closing-epilogue', 'closing-return'].filter(id => $(id).classList.contains('visible'))
      .map(id => id.replace('closing-', ''));
    return { loader, shown };
  };
  await settle();
  const trace = [];
  let last = '';
  const record = () => {
    const s = sample();
    const key = JSON.stringify(s);
    if (key !== last) { trace.push({ t: now, ...s }); last = key; }
  };
  record();
  while (true) {
    const next = [...timers.values()].sort((a, b) => a.t - b.t || a.id - b.id)[0];
    if (!next || next.t > HORIZON) break;
    timers.delete(next.id);
    now = next.t;
    next.fn();
    await settle();
    record();
  }
  // VOID: the loader has gone (or begun fading) with nothing revealed in its place.
  const voids = trace.filter(s => s.loader !== 'shown' && s.shown.length === 0);
  const loaderWasShown = trace[0].loader === 'shown';
  return { trace, voids, loaderWasShown };
}

const fmt = trace => trace.map(s => `    t=${String(s.t).padStart(6)}ms  loader=${s.loader.padEnd(10)}  revealed=[${s.shown.join(', ')}]`).join('\n');
const firstReveal = trace => trace.find(s => s.shown.length)?.t ?? null;

const CASES = [
  ['timer path (narration off), epilogue, no aftermath',  { events: [PENDING, DONE] }],
  ['timer path, epilogue + historical aftermath',          { events: [PENDING, DONE], scenario: { ...SCENARIO, historical_aftermath: 'Aftermath.' } }],
  ['narration path (TTS on), epilogue',                    { events: [PENDING, DONE], tts: true }],
  ['stream error event after the loader is up → floor',    { events: [PENDING, { type: 'error', message: 'x' }] }],
  ['network failure after the loader is up → floor',       { events: 'pending-then-reject' }],
  ['no epilogue to show (unreviewed) → return takes over', { events: [PENDING, { type: 'done', epilogue: null }], scenario: { id: 's', epilogue: { reviewed: false } } }],
];

for (const [name, opts] of CASES) {
  head(name);
  const r = await run(opts);
  console.log(fmt(r.trace));
  check('loader is up when `done` arrives', r.loaderWasShown, JSON.stringify(r.trace[0]));
  check('never an empty screen — loader stays until something replaces it', r.voids.length === 0, JSON.stringify(r.voids));
  if (!opts.tts && !opts.scenario?.historical_aftermath) {
    const t = firstReveal(r.trace);
    check('first section appears within 500ms of `done`', t !== null && t <= 500, `t=${t}`);
  }
  check('loader is fully removed by the end', r.trace.at(-1).loader === 'gone', JSON.stringify(r.trace.at(-1)));
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll loader-handoff assertions passed.');
process.exit(fails ? 1 : 0);
