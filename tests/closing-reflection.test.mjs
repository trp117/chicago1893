// CLOSING REFLECTION on the closing screen (engine/game/index.html, showClosingScreen).
//
// scenario.closing_reflection = { title, questions: [...] } is authored and optional. When it
// has questions it renders as a collapsed <details> between the epilogue and the sources, on
// every path — including the stream-failure / documented-outcome path. Without questions the
// block stays hidden. Question text goes in via textContent, never as markup.
//
// Drives the REAL showClosingScreen source in jsdom against a scripted /closing-prose stream
// (same harness as outcome-floor.test.mjs). No server, no model calls, no data writes.

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

// The real closing markup, so placement and the collapsed default are checked as shipped.
const markup = html.match(/<div id="closing-overlay"[\s\S]*?\n<\/div>\n/)?.[0];
check('closing overlay markup found in index.html', !!markup);
if (!markup) process.exit(1);

const IO = { summary: 'He left Loyola for Montserrat.', key_facts: ['In 1540 he founded the Society of Jesus.'] };
const REFL = { title: 'Before You Go', questions: ['What did you want, and why?', '  Where did you hesitate?  ', '<b>Not markup</b>'] };
const scenarioWith = closing_reflection => ({ id: 's', epilogue: { generated: true, reviewed: true, immediate_outcome: IO }, closing_reflection });

// events: SSE events to stream, or 'reject' for a network failure.
async function run(scenario, events) {
  const dom = new JSDOM(`<body>${markup}</body>`, { runScripts: 'outside-only' });
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
  const refl = $('closing-reflection');
  return {
    hidden:   refl.hidden,
    visible:  refl.classList.contains('visible'),
    open:     refl.open,
    label:    $('closing-reflection-label').textContent,
    items:    [...$('closing-reflection-list').children].map(li => li.textContent),
    elements: $('closing-reflection-list').querySelectorAll('b').length,
    order:    [...$('closing-reflection').parentElement.children].map(el => el.id),
    returnShown: $('closing-return').classList.contains('visible'),
  };
}

const DONE = [{ type: 'chunk', text: 'Prose.' }, { type: 'done', epilogue: { session_block: 'S.', record_block: 'R.' }, bibliography: [{ citation: 'A source.' }] }];

head('placement in the shipped markup');
let r = await run(scenarioWith(REFL), DONE);
const order = r.order;
check('after #closing-epilogue, immediately before #closing-bibliography',
  order.indexOf('closing-reflection') === order.indexOf('closing-epilogue') + 1
  && order.indexOf('closing-bibliography') === order.indexOf('closing-reflection') + 1, JSON.stringify(order));

head('field present → rendered, collapsed, revealed');
check('block shown and faded in', !r.hidden && r.visible, JSON.stringify(r));
check('collapsed by default (no open attribute)', r.open === false);
check('summary is the authored title', r.label === 'Before You Go', JSON.stringify(r.label));
check('questions in order, trimmed', JSON.stringify(r.items) === JSON.stringify(['What did you want, and why?', 'Where did you hesitate?', '<b>Not markup</b>']), JSON.stringify(r.items));
check('question text is text, not markup', r.elements === 0);

head('title missing → default label');
r = await run(scenarioWith({ questions: ['One?', 'Two?'] }), DONE);
check('summary defaults to "For Reflection"', r.label === 'For Reflection' && !r.hidden && r.items.length === 2, JSON.stringify(r));

head('stream failure / documented-outcome path → still rendered');
r = await run(scenarioWith(REFL), 'reject');
check('block shown on network failure', !r.hidden && r.visible && r.items.length === 3 && r.returnShown, JSON.stringify(r));
r = await run(scenarioWith(REFL), [{ type: 'error', message: 'x' }]);
check('block shown on server error event', !r.hidden && r.visible && r.items.length === 3, JSON.stringify(r));

head('absent or empty → hidden, nothing breaks');
for (const [name, cr] of [['no field', undefined], ['empty questions', { title: 'T', questions: [] }],
  ['blank questions only', { questions: ['', '   ', null] }], ['questions not an array', { questions: 'Why?' }]]) {
  r = await run(scenarioWith(cr), DONE);
  check(`${name}: hidden, not revealed, return still shown`, r.hidden && !r.visible && r.items.length === 0 && r.returnShown, JSON.stringify(r));
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll closing-reflection assertions passed.');
process.exit(fails ? 1 : 0);
