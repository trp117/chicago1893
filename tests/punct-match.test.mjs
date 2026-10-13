// INJECTOR — CURRENT matching tolerates punctuation ENCODING (and nothing else).
//
//   LOCATE   ’ ‘ ʼ ≡ '    “ ” „ ≡ "    – — ≡ -   on BOTH sides, the submitted CURRENT and
//            every stored candidate, before comparison
//   WRITE    REPLACE WITH goes in exactly as submitted; the rest of the stored field is
//            left exactly as it was (its own encoding included)
//   GUARD    "exactly one string leaf" is counted on the folded text — two leaves that
//            differ only in encoding are ambiguous, not a silent pick
//
// Pure functions only: the admin page is loaded bare in jsdom, the fixtures are synthetic,
// nothing is read from or written to the data directory.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { JSDOM } = await import('jsdom');

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};

const dom = new JSDOM(fs.readFileSync(path.join(REPO_DIR, 'engine/admin/index.html'), 'utf8'), {
  runScripts: 'dangerously', url: 'http://127.0.0.1/admin/', pretendToBeVisual: true,
  beforeParse(w) {
    w.fetch = async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    w.confirm = () => true; w.alert = () => {}; w.prompt = () => null;
  },
});
await new Promise(r => dom.window.addEventListener('load', r, { once: true }));
const win = dom.window;
const resolve = (data, corr) => win.resolveCrucibleCorrection(data, corr) ?? win.resolveAndApply(data, corr);

const fixture = () => ({
  scenario: { id: 'sc_punct', title: 'T' },
  characters: [
    { id: 'char_straight', name: 'Straight', background: "He didn't stay - not that night." },
    { id: 'char_curly',    name: 'Curly',    background: 'She wouldn’t say — “never” was her word.' },
    { id: 'char_plain',    name: 'Plain',    background: 'He kept the parish registers.' },
  ],
  playerRoles: [{
    id: 'role_punct', scenarioId: 'sc_punct', name: 'Punct Role', briefing: 'You arrive late.',
    defining_moment: { id: 'm', setup: 'The bell’s last stroke — and then quiet.', options: [{ id: 'go', label: 'Go', text: 'You go.' }] },
  }],
  locations: [], clues: [],
});
const corr = (field, current, replacewith, section = 'Characters') => ({ section, field, current, replacewith });

console.log('\n-- 1. curly CURRENT → straight stored');
{
  const d = fixture();
  const r = resolve(d, corr('char_straight.background', 'He didn’t stay — not that night.', 'He didn’t stay — not that week.'));
  check('applied', r.outcome === 'applied', JSON.stringify(r));
  check('REPLACE WITH written exactly as submitted', d.characters[0].background === 'He didn’t stay — not that week.', d.characters[0].background);
}

console.log('\n-- 2. straight CURRENT → curly stored (part of the field)');
{
  const d = fixture();
  const r = resolve(d, corr('', `wouldn't say - "never"`, `wouldn't say - "always"`));  // SECTION-wide, blank FIELD
  check('applied (section-wide search, unique)', r.outcome === 'applied', JSON.stringify(r));
  check('only the located span replaced; the rest keeps its own encoding',
    d.characters[1].background === `She wouldn't say - "always" was her word.`, d.characters[1].background);
}

console.log('\n-- 3. crucible simple field (defining_moment.setup)');
{
  const d = fixture();
  const r = resolve(d, corr('role_punct.defining_moment.setup', "The bell's last stroke - and then quiet.", "The bell's last stroke - and then silence.", 'Defining Moments'));
  check('applied through the crucible branch', r.outcome === 'applied' && r.crucibleRoleId === 'role_punct', JSON.stringify(r));
  check('written as submitted', d.playerRoles[0].defining_moment.setup === "The bell's last stroke - and then silence.");
}

console.log('\n-- 4. a normal correction is unchanged');
{
  const d = fixture();
  const r = resolve(d, corr('char_plain.background', 'parish registers', 'parish ledgers'));
  check('applied', r.outcome === 'applied' && r.detail === 'char_plain.background', JSON.stringify(r));
  check('result', d.characters[2].background === 'He kept the parish ledgers.');
  const before = JSON.stringify(fixture());
  const d2 = fixture();
  const m = resolve(d2, corr('char_plain.background', 'parish rolls', 'x'));
  check('a genuine difference still mismatches, nothing written', m.outcome === 'current-mismatch' && JSON.stringify(d2) === before, m.outcome);
}

console.log('\n-- 5. uniqueness is counted on the folded text');
{
  const d = fixture();
  d.characters[2].background = 'He didn’t stay — not that night.';   // same words as char_straight, other encoding
  const before = JSON.stringify(d);
  const r = resolve(d, corr('', "He didn't stay - not that night.", 'x'));
  check('two leaves equal after folding → ambiguous, none applied', r.outcome === 'ambiguous' && r.count === 2 && JSON.stringify(d) === before, JSON.stringify(r));
}

console.log('\n-- 6. only the three families fold');
{
  check('_normPunct', win._normPunct('‘a’ ʼb “c” „d” e–f—g') === `'a' 'b "c" "d" e-f-g`);
  check('other look-alikes are left alone (prime, minus, non-breaking hyphen)', win._normPunct('′ − ‑') === '′ − ‑');
}

if (fails) { console.log(`\n${fails} check(s) FAILED`); process.exit(1); }
console.log('\nAll checks passed.');
process.exit(0);
