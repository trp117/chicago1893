// DOCUMENTED-OUTCOME FLOOR on the closing screen (engine/game/index.html, showClosingScreen).
//
// The Historical Record is model-written and can be absent: the epilogue call throws, the
// stream errors or aborts, or the server's reviewed guard skips the epilogue. In every one of
// those cases the scenario's reviewed immediate_outcome must still reach the screen. A
// generated record, when it arrives, suppresses the floor (behaviour unchanged).
//
// Drives the REAL showClosingScreen source in jsdom against a scripted /closing-prose stream.
// No server, no model calls, no data writes.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const head  = s => console.log(`\n── ${s}`);
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`); if (!ok) fails++; };

const html = fs.readFileSync(path.join(REPO_DIR, 'engine/game/index.html'), 'utf8');
const src  = html.match(/function showClosingScreen\(endState, sessionId\) \{[\s\S]*?\n\}\n/)?.[0];
check('showClosingScreen found in index.html', !!src);
if (!src) process.exit(1);

const DOM_IDS = ['closing-overlay', 'closing-dots', 'closing-prose', 'closing-aftermath', 'closing-epilogue',
  'closing-epilogue-session', 'closing-epilogue-session-text', 'closing-epilogue-record', 'closing-epilogue-record-text',
  'closing-bibliography', 'closing-bibliography-list', 'closing-composite-note', 'closing-composite-note-text',
  'closing-return', 'closing-epilogue-loading', 'closing-wait'];

const IO = {
  summary: 'He left Loyola for Montserrat.',
  key_facts: [{ text: 'Wounded at Pamplona, 20 May 1521.', source: 'x' }, 'In 1540 he founded the Society of Jesus.'],
};
const scenarioWith = reviewed => ({ id: 's', epilogue: { generated: true, reviewed, immediate_outcome: IO } });
const FLOOR = 'He left Loyola for Montserrat.\n\nWounded at Pamplona, 20 May 1521.\n\nIn 1540 he founded the Society of Jesus.';

// events: SSE events to stream, or 'reject' for a network failure.
async function run(scenario, events) {
  const dom = new JSDOM(`<body>${DOM_IDS.map(id => `<div id="${id}"></div>`).join('')}</body>`, { runScripts: 'outside-only' });
  const w = dom.window;
  w.TextDecoder = TextDecoder;
  // Closing-sequence reveals fire at once; the long abort/backstop timers never fire.
  w.setTimeout = (fn, ms) => { if ((ms || 0) <= 20000) fn(); return 0; };
  w.__scenario = scenario;
  w.__fetch = async () => {
    if (events === 'reject') throw new Error('network down');
    const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n`).join(''));
    let sent = false;
    return { body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }) }) } };
  };
  w.eval(`var closingShown = false; var scenario = window.__scenario; var API_BASE = '/game/api';
    var currentRoleId = 'r'; var ttsEnabled = false; var fetch = window.__fetch;
    function syncClosingNarrationBtn() {} function speakAtLeast() { return Promise.resolve(); }
    ${src}
    showClosingScreen(null, 'sess');`);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const $ = id => w.document.getElementById(id);
  return {
    record:      $('closing-epilogue-record-text').textContent,
    recordShown: $('closing-epilogue-record').classList.contains('visible'),
    epilogueShown: $('closing-epilogue').classList.contains('visible'),
    returnShown: $('closing-return').classList.contains('visible'),
  };
}

head('generated record arrives → shown as-is, floor suppressed');
let r = await run(scenarioWith(true), [{ type: 'chunk', text: 'Prose.' }, { type: 'done', epilogue: { session_block: 'S.', record_block: 'Model record.' } }]);
check('record block is the model text', r.record === 'Model record.', JSON.stringify(r.record));
check('epilogue visible', r.epilogueShown && r.recordShown);

head('done with no epilogue (guard false / epilogue call threw) → floor');
r = await run(scenarioWith(true), [{ type: 'chunk', text: 'Prose.' }, { type: 'done', epilogue: null }]);
check('record block is immediate_outcome verbatim', r.record === FLOOR, JSON.stringify(r.record));
check('epilogue + record visible, return shown', r.epilogueShown && r.recordShown && r.returnShown);

head('done with session block but no record block → floor fills the record only');
r = await run(scenarioWith(true), [{ type: 'done', epilogue: { session_block: 'S.', record_block: '' } }]);
check('record block is the floor', r.record === FLOOR, JSON.stringify(r.record));

head('server error event → floor');
r = await run(scenarioWith(true), [{ type: 'error', message: 'x' }]);
check('record block is the floor, epilogue visible', r.record === FLOOR && r.epilogueShown && r.returnShown, JSON.stringify(r));

head('network failure / abort → floor');
r = await run(scenarioWith(true), 'reject');
check('record block is the floor, epilogue visible', r.record === FLOOR && r.epilogueShown && r.returnShown, JSON.stringify(r));

head('unreviewed epilogue → no floor (same reviewed gate as the server)');
r = await run(scenarioWith(false), [{ type: 'done', epilogue: null }]);
check('record block empty, epilogue hidden, return still shown', r.record === '' && !r.epilogueShown && r.returnShown, JSON.stringify(r));

head('no epilogue data at all → no floor, nothing breaks');
r = await run({ id: 's' }, 'reject');
check('record block empty, return still shown', r.record === '' && !r.epilogueShown && r.returnShown, JSON.stringify(r));

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll outcome-floor assertions passed.');
process.exit(fails ? 1 : 0);
