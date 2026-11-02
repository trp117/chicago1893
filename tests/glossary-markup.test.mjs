// GLOSSARY MARKUP (engine/game/index.html markupGlossaryTerms + applyRedesignDialogueFormatting).
//
// Two fixes, 2 Nov 2026:
//   DIALOGUE  the redesign rebuilt each dialogue line from textContent AFTER markup, wiping the
//             gloss spans (5 of 44 Ignatius hits never underlined). The speech is re-marked.
//   FORMS     a term also matches its bounded forms: curly/straight apostrophe, any whitespace
//             between words, a parenthetical term's base form, and the LAST word's plural /
//             possessive (4+ letters). Never stemming down, verb forms, or a lone word of a
//             multi-word term — the "chair" problem.
//
// Drives the REAL page in jsdom (bootstrap stubbed). No model calls, no data.

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

const BOOT = { scenario: { id: 'gloss_test', title: 'Gloss Test', sessionTargetMinutes: 15, playerRoleOptions: [] }, locations: [], characters: [], cluesCatalog: [] };
const GLOSSARY = [
  { term: 'codex',                  definition: 'DEF-codex' },
  { term: "Paul's letters",         definition: 'DEF-paul' },
  { term: 'Flos Sanctorum',         definition: 'DEF-flos' },
  { term: 'chief notary (notaire)', definition: 'DEF-notary' },
  { term: 'the formal question',    definition: 'DEF-question' },
  { term: 'Torre de Loyola',        definition: 'DEF-torre' },
  { term: 'sermon',                 definition: 'DEF-sermon' },
  { term: 'litany',                 definition: 'DEF-litany' },
  { term: 'bascule',                definition: 'DEF-bascule' },
  { term: 'oar',                    definition: 'DEF-oar' },
  { term: 'bascule span',           definition: 'DEF-span' },
  { term: 'cathedra',               definition: 'DEF-cathedra $\' $& injected' },
];

const dom = new JSDOM(fs.readFileSync(path.join(REPO_DIR, 'engine/game/index.html'), 'utf8'), {
  url: 'http://localhost/game?scenarioId=gloss_test', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(win) {
    win.fetch = async u => (String(u).includes('/bootstrap') ? json(BOOT) : json({}));
    win.scrollTo = () => {};
    win.HTMLElement.prototype.scrollIntoView = () => {};
    win.speechSynthesis ??= { getVoices: () => [], cancel() {}, speak() {} };
    win.console.error = () => {};
  },
});
const win = dom.window;
await new Promise(r => win.addEventListener('load', r, { once: true }));
const ready = () => { try { return !!win.eval('typeof scenario !== "undefined" && scenario'); } catch { return false; } };
for (let i = 0; i < 100 && !ready(); i++) await sleep(50);
if (!ready()) { console.error('page never loaded the stubbed bootstrap'); process.exit(1); }
win.eval(`gameState = { glossary: ${JSON.stringify(GLOSSARY)} };`);

const mark = text => win.markupGlossaryTerms(text);
const spans = html => [...html.matchAll(/<span class="gloss-term" data-def="([^"]*)">([^<]*)<\/span>/g)].map(m => ({ def: m[1], text: m[2] }));
const hit = (text, want, defWant) => {
  const s = spans(mark(text));
  return s.some(x => x.text === want && (!defWant || x.def === defWant));
};
const none = text => spans(mark(text)).length === 0;

head('unchanged: exact, case-insensitive, every occurrence, whole word');
check('exact term', hit('He lifts the codex.', 'codex', 'DEF-codex'));
check('case-insensitive', hit('The Codex lies open.', 'Codex', 'DEF-codex'));
check('every occurrence', spans(mark('codex, codex, codex')).length === 3);
check('no substring hit', none('a codexed volume') && none('a sermonizer'));
check('no hyphen neighbour', none('pre-codex era'));
check('longest first: "bascule span" beats "bascule"', hit('the bascule span rose', 'bascule span', 'DEF-span'));

head('plural / possessive on the last word');
check('-s', hit('three sermons that winter', 'sermons', 'DEF-sermon'));
check('-ex → -ices', hit('the codices of the house', 'codices', 'DEF-codex'));
check('consonant-y → -ies', hit('the litanies went on', 'litanies', 'DEF-litany'));
check("possessive 's", hit("the codex's binding", "codex's", 'DEF-codex'));
check('multi-word: last word only', hit('the bascule spans', 'bascule spans', 'DEF-span'));

head('apostrophes and whitespace');
check('curly apostrophe', hit('Paul’s letters lay there', 'Paul’s letters', 'DEF-paul'));
check('straight apostrophe', hit("Paul's letters lay there", "Paul's letters", 'DEF-paul'));
check('line break inside a multi-word term', hit('the Flos\nSanctorum', 'Flos\nSanctorum', 'DEF-flos'));
check('across a stashed tag edge', hit('<em>Flos Sanctorum</em>', 'Flos Sanctorum', 'DEF-flos'));

head('parenthetical term → base form');
check('base form matches', hit('the chief notary rose', 'chief notary', 'DEF-notary'));
check('full form still matches', hit('the chief notary (notaire) rose', 'chief notary (notaire)', 'DEF-notary'));

head('bounded — the "chair" problem');
check('a lone word of a multi-word term does not match ("question")', none('He asked the question again.'));
check('"Loyola" alone does not match "Torre de Loyola"', none('Iñigo de Loyola lay still.'));
check('no verb forms: -ed / -ing', none('they sermoned') && none('sermoning'));
check('no stemming down', none('a codi of law') && none('Paul was there'));
check('short last word (<4 letters) gets no plural', none('two oars dipped') && hit('the oar dipped', 'oar', 'DEF-oar'));
check('full term plural',hit('the formal questions', 'the formal questions', 'DEF-question'));

head('definition is inert in the attribute');
{
  const out = mark('the cathedra at Milan');
  check('definition escaped, no $-splice', out.includes(`data-def="DEF-cathedra $' $&amp; injected"`) && out.endsWith('</span> at Milan'), out);
}

head('dialogue lines keep their underlines (redesign rebuild)');
{
  const card = win.document.createElement('div');
  card.innerHTML = win.sceneCardHtml(null, '', win.markupNarrative('Ponticianus: "I saw the codex on your table, and the Flos Sanctorum beside it."\n*The light holds.*'));
  check('markup ran before the rebuild', card.querySelectorAll('.line.dialogue .gloss-term').length === 2);
  win.applyRedesignDialogueFormatting(card);
  const speech = card.querySelector('.redesign-dialogue-text');
  check('dialogue was reformatted', !!speech && !!card.querySelector('.redesign-dialogue-speaker'));
  const terms = [...(speech?.querySelectorAll('.gloss-term') || [])].map(e => e.textContent);
  check('both terms still underlined in the speech', terms.includes('codex') && terms.includes('Flos Sanctorum'), JSON.stringify(terms));
  check('speaker text intact', card.querySelector('.redesign-dialogue-speaker')?.textContent === 'Ponticianus');
  check('speech text intact', speech?.textContent === '"I saw the codex on your table, and the Flos Sanctorum beside it."', speech?.textContent);
  win.applyRedesignDialogueFormatting(card);
  check('re-running is a no-op (no nested spans)', card.querySelectorAll('.gloss-term .gloss-term').length === 0 && card.querySelectorAll('.redesign-dialogue-text .gloss-term').length === 2);
}
{
  const card = win.document.createElement('div');
  card.innerHTML = win.markupNarrative('Ambrose: "Bread & salt <b>now</b>, then the codex."');
  win.applyRedesignDialogueFormatting(card);
  const speech = card.querySelector('.redesign-dialogue-text');
  check('ampersand and angle brackets stay text', speech?.textContent === '"Bread & salt now, then the codex."' || speech?.textContent === '"Bread & salt <b>now</b>, then the codex."', speech?.textContent);
  check('no injected element from speech text', !speech?.querySelector('b'));
}

console.log(fails ? `\n${fails} failure(s).` : '\nAll glossary-markup checks passed.');
process.exit(fails ? 1 : 0);
