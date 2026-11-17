// GLOSSARY UNDERLINE CAP (engine/game/index.html capGlossaryUnderlines, GLOSSARY_UNDERLINE_CAP).
//
// Each glossary term is underlined only its first CAP occurrences across the whole playthrough,
// counted in display order over every turn; later occurrences are plain, untappable text.
// Matching is unchanged. The tally is rebuilt from scratch on every render (no drift on
// re-render) and is reset by Begin Again / a new session.
//
// Drives the REAL page in jsdom (bootstrap stubbed; turns through renderOutput and through the
// real streamed submitTurn path). No model calls, no data.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const head  = s => console.log(`\n── ${s}`);
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`); if (!ok) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json  = o => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });

const GLOSSARY = [
  { term: 'codex',        definition: 'DEF-codex' },
  { term: 'oar',          definition: 'DEF-oar' },
  { term: 'bascule',      definition: 'DEF-bascule' },
  { term: 'bascule span', definition: 'DEF-span' },
  { term: 'Cantigny',     definition: 'DEF-cantigny', artifactUrl: 'https://www.fdmuseum.org/collections/village-of-cantigny-sign/', artifactLabel: 'Sign', artifactSource: 'FDM' },
];
const BOOT = { scenario: { id: 'cap_test', title: 'Cap Test', sessionTargetMinutes: 30, playerRoleOptions: [] }, locations: [{ id: 'loc_a', name: 'A' }], characters: [], cluesCatalog: [] };
const SOURCE = fs.readFileSync(path.join(REPO_DIR, 'engine/game/index.html'), 'utf8');

async function boot(source = SOURCE) {
  const io = { queue: [] };
  const dom = new JSDOM(source, {
    url: 'http://localhost/game?scenarioId=cap_test', runScripts: 'dangerously', pretendToBeVisual: true,
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
  if (!ready()) throw new Error('page never loaded the stubbed bootstrap');
  return { win, io };
}

const state = (turnCount = 1) => ({ scenarioId: 'cap_test', location: 'loc_a', act: 1, remainingMinutes: 25, elapsedMinutes: 5, turnCount, npc_states: {}, discoveredFacts: [], visitedLocations: ['loc_a'], glossary: GLOSSARY });
function fresh(win) {
  win.eval(`ttsEnabled = false; sessionId = 'cap-test'; gameState = ${JSON.stringify(state())};`);
}
// A turn rendered the way the opening is: renderOutput with a fresh card.
const render = (win, narrative) => win.eval(`renderOutput(${JSON.stringify({ narrative, choices: ['Go on'] })}); [...document.querySelectorAll('#story .scene-card')].pop()`);
// A turn through the real streamed path: submitTurn → chunks → done.
async function streamed(b, narrative, n) {
  const enc = new TextEncoder();
  let ctl;
  const body = new ReadableStream({ start(c) { ctl = c; } });
  b.io.queue.push(() => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  const pending = b.win.eval(`submitTurn('Go on')`);
  await sleep(420);
  const send = e => ctl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
  const half = Math.floor(narrative.length / 2);
  send({ type: 'chunk', text: narrative.slice(0, half) });
  await sleep(30);
  send({ type: 'chunk', text: narrative.slice(half) });
  send({ type: 'narrative_end' });
  await sleep(30);
  const streamedHtml = [...b.win.document.querySelectorAll('#story .scene-card')].pop().innerHTML;
  send({ type: 'done', output: { narrative, choices: ['Go on'] }, nextState: state(n) });
  ctl.close();
  await pending;
  await sleep(30);
  return { card: [...b.win.document.querySelectorAll('#story .scene-card')].pop(), streamedHtml };
}
// Each glossary-looking occurrence in a card, in order: U = underlined, P = plain (capped).
const pattern = card => [...card.querySelectorAll('.gloss-term, .gloss-capped')].map(s => (s.classList.contains('gloss-term') ? 'U' : 'P')).join('');
const words   = card => [...card.querySelectorAll('.gloss-term, .gloss-capped')].map(s => `${s.textContent}:${s.classList.contains('gloss-term') ? 'U' : 'P'}`);

const b = await boot();
const win = b.win;

head('cumulative across turns — 5 occurrences, first 3 underlined');
fresh(win);
const c0 = render(win, 'The codex lay open beside a second codex.');
const k0 = c0.innerHTML;
const c1 = render(win, 'He closed the codex. Another codex waited.');
const c2 = render(win, 'One more codex.');
check('turn 1 (2 occurrences): both underlined', pattern(c0) === 'UU', pattern(c0));
check('turn 2 (2 more): first underlined, second plain', pattern(c1) === 'UP', pattern(c1));
check('turn 3: plain', pattern(c2) === 'P', pattern(c2));
const capped = c1.querySelector('.gloss-capped');
check('capped occurrence is plain text: only class="gloss-capped", no data-*', capped.attributes.length === 1 && capped.className === 'gloss-capped' && capped.textContent === 'codex', capped.outerHTML);
check('turn 1 card unchanged by later turns', c0.innerHTML === k0);

head('popover: underlined term unchanged, capped term not tappable');
c0.querySelector('.gloss-term').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const tt = win.document.getElementById('gloss-tooltip');
check('underlined term opens its popover with the definition', tt.style.display === 'block' && win.document.getElementById('gloss-tooltip-def').textContent === 'DEF-codex');
win.document.body.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
c2.querySelector('.gloss-capped').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
check('clicking a capped occurrence opens nothing', tt.style.display === 'none', tt.style.display);

head('re-render safe — identical however many times it re-renders');
const keysBefore = JSON.stringify(win.eval('glossTurnKeys'));
const snap = [c0, c1, c2].map(c => c.innerHTML);
for (let i = 0; i < 5; i++) {
  win.eval(`(() => { const cs = [...document.querySelectorAll('#story .scene-card')]; cs.forEach(c => capGlossaryUnderlines(c, glossTurnOfCard.get(c))); })()`);
}
check('re-running the cap on every card 5× changes nothing', [c0, c1, c2].every((c, i) => c.innerHTML === snap[i]));
// Rebuild turn 2's card from scratch (fresh, uncapped markup) and render it again, twice.
for (let i = 0; i < 2; i++) {
  win.eval(`(() => { const c = [...document.querySelectorAll('#story .scene-card')][1];
    c.innerHTML = sceneCardHtml(null, null, markupNarrative('He closed the codex. Another codex waited.'));
    applyRedesignDialogueFormatting(c); capGlossaryUnderlines(c, glossTurnOfCard.get(c)); })()`);
}
check('a re-rendered middle turn comes out the same', c1.innerHTML === snap[1], c1.innerHTML);
check('tally inputs unchanged (no double count)', JSON.stringify(win.eval('glossTurnKeys')) === keysBefore, JSON.stringify(win.eval('glossTurnKeys')));
const c3 = render(win, 'And the codex again.');
check('the next turn still continues the true count (6th → plain)', pattern(c3) === 'P', pattern(c3));

head('rare terms (≤ cap) underline every time, as before');
const r1 = render(win, 'An oar slipped.');
const r2 = render(win, 'He found the oar. The oar held.');
check('oar ×3 across turns: all underlined', pattern(r1) + pattern(r2) === 'UUU', pattern(r1) + pattern(r2));
const r3 = render(win, 'A fourth oar.');
check('4th oar: plain', pattern(r3) === 'P');

head('matching rules unchanged — longest wins, whole word, inflections count as the term');
fresh(win);
win.eval('restartGame()');
fresh(win);
const m1 = render(win, 'The bascule span rose. The bascule creaked. Codices and a codex.');
check('longest wins: "bascule span" is one span, "bascule" another', JSON.stringify(words(m1)) === JSON.stringify(['bascule span:U', 'bascule:U', 'Codices:U', 'codex:U']), JSON.stringify(words(m1)));
check('"bascule span" keeps its own definition', m1.querySelector('.gloss-term').dataset.def === 'DEF-span');
const m2 = render(win, 'The bascule  span, the bascule span. The codexes, codex; codexed oars.');
check('multi-word with extra whitespace still matches; inflections count toward the canonical term',
  JSON.stringify(words(m2)) === JSON.stringify(['bascule  span:U', 'bascule span:U', 'codexes:U', 'codex:P']),
  JSON.stringify(words(m2)));
check('"oars" not matched (plural only for 4+ letter words — existing rule)', !words(m2).some(w => w.startsWith('oars')));
check('"codexed" (verb form) is not matched', !words(m2).some(w => w.startsWith('codexed')));
const m3 = render(win, 'One more bascule span.');
check('4th "bascule span" plain, independent of "bascule" count', pattern(m3) === 'P', JSON.stringify(words(m3)));
const m4 = render(win, 'And the bascule, twice: bascule.');
check('"bascule" counts separately (2nd and 3rd underlined)', pattern(m4) === 'UU', JSON.stringify(words(m4)));

head('Begin Again resets the tally');
win.eval('restartGame()');
fresh(win);
const a1 = render(win, 'codex codex codex');
check('after restart: first 3 codex underlined again', pattern(a1) === 'UUU', pattern(a1));
check('startGame also resets (both reset points present)', (SOURCE.match(/glossTurnKeys\s+= \[\];\s+\/\/ underline-cap tally is per session/g) || []).length === 2);

head('streamed turns — capped while streaming, and the final render matches');
win.eval('restartGame()');
fresh(win);
render(win, 'Cantigny lay ahead. Cantigny.');
const s1 = await streamed(b, 'They reached Cantigny. Beyond Cantigny, smoke.', 2);
check('streamed turn continues the count: 3rd underlined, 4th plain', pattern(s1.card) === 'UP', pattern(s1.card));
check('the streamed card was already capped before done (no flicker)', s1.streamedHtml === s1.card.innerHTML, s1.streamedHtml);
const s2 = await streamed(b, 'Cantigny again.', 3);
check('next streamed turn: plain', pattern(s2.card) === 'P');
check('underlined Cantigny still carries its artifact link data', s1.card.querySelector('.gloss-term')?.dataset.artUrl === 'https://www.fdmuseum.org/collections/village-of-cantigny-sign/');

head('dialogue lines count in display order');
win.eval('restartGame()');
fresh(win);
const d1 = render(win, 'The codex sat there.\nInigo: "Bring the codex. And that codex."\nA last codex.');
check('narration, then 2 in speech, then narration: UUUP', pattern(d1) === 'UUUP', JSON.stringify(words(d1)));
check('speech occurrences sit inside the redesign speech span', d1.querySelectorAll('.redesign-dialogue-text .gloss-term, .redesign-dialogue-text .gloss-capped').length === 2);

head('the constant works — cap 2');
const b2 = await boot(SOURCE.replace('const GLOSSARY_UNDERLINE_CAP = 3;', 'const GLOSSARY_UNDERLINE_CAP = 2;'));
check('patched page uses cap 2', b2.win.eval('GLOSSARY_UNDERLINE_CAP') === 2);
fresh(b2.win);
const x1 = render(b2.win, 'codex codex');
const x2 = render(b2.win, 'codex oar oar oar');
check('cap 2: codex UU then P; oar UUP', pattern(x1) === 'UU' && pattern(x2) === 'PUUP', pattern(x1) + ' ' + pattern(x2));

console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
process.exit(fails ? 1 : 0);
