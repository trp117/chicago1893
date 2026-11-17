// GLOSSARY ARTIFACT LINK (engine/game/index.html glossArtifactAttrs + the gloss-term click handler).
//
// Optional per-term fields artifactUrl / artifactLabel / artifactSource. With an http(s)
// artifactUrl the popover shows one line under the definition: "<source> · <link>", the link
// opening in a new tab (target=_blank, rel="noopener noreferrer"), text = label or "View →".
// A term without artifactUrl renders exactly as before — same span bytes, line hidden.
// Non-http(s) URLs are ignored entirely.
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

const BOOT = { scenario: { id: 'art_test', title: 'Art Test', sessionTargetMinutes: 15, playerRoleOptions: [] }, locations: [], characters: [], cluesCatalog: [] };
const GLOSSARY = [
  { term: 'parapet',   definition: 'DEF-parapet' },
  { term: 'Cantigny',  definition: 'DEF-cantigny', artifactUrl: 'https://www.fdmuseum.org/collections/village-of-cantigny-sign/', artifactLabel: 'Village of Cantigny sign, 1918', artifactSource: 'First Division Museum' },
  { term: 'Bangalore', definition: 'DEF-bangalore', artifactUrl: 'https://americanhistory.si.edu/collections/object/nmah_403615' },
  { term: 'hedgehog',  definition: 'DEF-hedgehog', artifactUrl: 'javascript:alert(1)', artifactLabel: 'bad', artifactSource: 'bad' },
  { term: 'Tobruk',    definition: 'DEF-tobruk', artifactUrl: 'https://example.org/x?a=1&b="2"', artifactLabel: '<b>Label</b> "q"', artifactSource: 'Src & <i>Co</i>' },
  { term: 'fire-step', definition: 'DEF-firestep', artifactUrl: '   ', artifactLabel: 'empty url' },
];

const dom = new JSDOM(fs.readFileSync(path.join(REPO_DIR, 'engine/game/index.html'), 'utf8'), {
  url: 'http://localhost/game?scenarioId=art_test', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(win) {
    win.fetch = async u => (String(u).includes('/bootstrap') ? json(BOOT) : json({}));
    win.scrollTo = () => {};
    win.HTMLElement.prototype.scrollIntoView = () => {};
    win.speechSynthesis ??= { getVoices: () => [], cancel() {}, speak() {} };
    win.console.error = () => {};
  },
});
const win = dom.window;
const doc = win.document;
await new Promise(r => win.addEventListener('load', r, { once: true }));
const ready = () => { try { return !!win.eval('typeof scenario !== "undefined" && scenario'); } catch { return false; } };
for (let i = 0; i < 100 && !ready(); i++) await sleep(50);
if (!ready()) { console.error('page never loaded the stubbed bootstrap'); process.exit(1); }
win.eval(`gameState = { glossary: ${JSON.stringify(GLOSSARY)} };`);

const mark = text => win.markupGlossaryTerms(text);
const host = doc.createElement('div');
doc.body.appendChild(host);
const popFor = (text, term) => {
  host.innerHTML = mark(text);
  const span = [...host.querySelectorAll('.gloss-term')].find(s => s.textContent === term);
  if (!span) return null;
  span.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const tt  = doc.getElementById('gloss-tooltip');
  const art = doc.getElementById('gloss-tooltip-artifact');
  const a   = art.querySelector('a');
  return {
    shown: tt.style.display === 'block',
    def: doc.getElementById('gloss-tooltip-def').textContent,
    artHidden: art.hidden,
    artText: art.textContent,
    artChildren: art.children.length,
    href: a?.getAttribute('href') ?? null, target: a?.target ?? null, rel: a?.rel ?? null, linkText: a?.textContent ?? null,
    imgs: tt.querySelectorAll('img, iframe').length,
  };
};

head('markup: a term without artifactUrl is byte-identical to before');
check('plain term span unchanged', mark('the parapet held') === 'the <span class="gloss-term" data-def="DEF-parapet">parapet</span> held', mark('the parapet held'));
check('blank artifactUrl → no extra attributes', !mark('the fire-step').includes('data-art-'), mark('the fire-step'));
check('javascript: URL → no extra attributes', !mark('a hedgehog').includes('data-art-'), mark('a hedgehog'));

head('markup: artifact attributes when artifactUrl is http(s)');
const m = mark('We took Cantigny.');
check('carries url / label / source', m.includes('data-art-url="https://www.fdmuseum.org/collections/village-of-cantigny-sign/"') && m.includes('data-art-label="Village of Cantigny sign, 1918"') && m.includes('data-art-src="First Division Museum"'), m);
const t = mark('a Tobruk');
check('attribute values escaped (no raw quote or tag)', !/data-art-label="[^"]*<b>/.test(t) && t.includes('&lt;b&gt;Label&lt;/b&gt; &quot;q&quot;') && t.includes('&amp;'), t);

head('popover: artifact line');
let p = popFor('We took Cantigny.', 'Cantigny');
check('popover shown with definition', p.shown && p.def === 'DEF-cantigny', JSON.stringify(p));
check('line visible: "<source> · <label>"', !p.artHidden && p.artText === 'First Division Museum · Village of Cantigny sign, 1918', JSON.stringify(p));
check('link opens new tab, noopener noreferrer', p.href === 'https://www.fdmuseum.org/collections/village-of-cantigny-sign/' && p.target === '_blank' && p.rel === 'noopener noreferrer', JSON.stringify(p));
check('text link only — no image or iframe', p.imgs === 0 && p.artChildren === 1);

p = popFor('the Bangalore across your knees', 'Bangalore');
check('no label → "View →", no source → link only', !p.artHidden && p.linkText === 'View →' && p.artText === 'View →', JSON.stringify(p));

p = popFor('a Tobruk', 'Tobruk');
check('label and source rendered as text, not markup', p.linkText === '<b>Label</b> "q"' && p.artText.startsWith('Src & <i>Co</i> · ') && p.artChildren === 1, JSON.stringify(p));

head('popover: terms without a valid artifactUrl look exactly as today');
p = popFor('the parapet held', 'parapet');
check('plain term: line hidden and empty', p.shown && p.def === 'DEF-parapet' && p.artHidden && p.artText === '', JSON.stringify(p));
popFor('We took Cantigny.', 'Cantigny');                // leave a link in the line…
p = popFor('the parapet held', 'parapet');              // …then open a plain term
check('previous term\'s link does not linger', p.artHidden && p.artText === '' && p.href === null, JSON.stringify(p));
p = popFor('a hedgehog', 'hedgehog');
check('javascript: URL: line hidden, no link', p.artHidden && p.href === null, JSON.stringify(p));

head('clicking the link keeps the popover open (link default action proceeds)');
popFor('We took Cantigny.', 'Cantigny');
const a = doc.querySelector('#gloss-tooltip-artifact a');
const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true });
a.dispatchEvent(ev);
check('popover still shown, default not prevented', doc.getElementById('gloss-tooltip').style.display === 'block' && !ev.defaultPrevented);

console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
process.exit(fails ? 1 : 0);
