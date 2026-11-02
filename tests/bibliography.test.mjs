// PRIMARY SOURCES CONSOLIDATION (engine/services/Bibliography.js, called by assembleBibliography).
//
// Frozen fixtures only — the Augustine list is copied from tolle_lege_milan_386 v71 (2 Nov
// 2026) as assembleBibliography produced it before this change (21 exact-deduped entries).

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).href;
const { consolidateBibliography } = await import(`${ROOT}/engine/services/Bibliography.js`);

let fails = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `  — ${detail}`}`); if (!cond) fails++; };
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const E = c => ({ citation: c, url: null, access_note: null });
const cites = list => consolidateBibliography(list.map(x => (typeof x === 'string' ? E(x) : x))).map(e => e.citation);

const AUGUSTINE_BEFORE = [
  "Athanasius, Vita Antonii; Jerome, De Viris Illustribus 125 on Evagrius's translation",
  'Augustine, Confessions III.12.21',
  'Augustine, Confessions III.6.10, V.3.3–7.13',
  'Augustine, Confessions IX.10.23–11.28',
  'Augustine, Confessions IX.2.2–4; De Beata Vita 1.6',
  'Augustine, Confessions IX.3.6; Augustine, Epistulae 3–14 (letters to Nebridius)',
  'Augustine, Confessions IX.4.7, IX.6.14; Possidius, Vita Augustini',
  'Augustine, Confessions IX.6.14; De Beata Vita 1.6',
  'Augustine, Confessions V.13.23',
  'Augustine, Confessions VI.10.16–17',
  'Augustine, Confessions VI.10.17',
  'Augustine, Confessions VI.15.25',
  "Augustine, Confessions VII.9.13–10.16 (the Platonist books); VIII.2.3 (Victorinus's translation); VIII.5.10–12 (the divided will).",
  'Augustine, Confessions VIII; cross-referenced with his birth date of 13 November 354 CE, Possidius, Vita Augustini 1',
  'Augustine, Confessions VIII.12.28',
  'Augustine, Confessions VIII.12.29',
  'Augustine, Confessions VIII.12.29; Romans 13:13–14 (Vulgate and Vetus Latina)',
  'Augustine, Confessions VIII.12.30',
  'Augustine, Confessions VIII.6.14',
  'Augustine, Confessions VIII.6.14–15',
  'Augustine, Confessions VIII.6.15',
];
const AUGUSTINE_AFTER = [
  'Athanasius, Vita Antonii',
  "Augustine, Confessions III.6.10; III.12.21; V.3.3–7.13; V.13.23; VI.10.16–17; VI.15.25; VII.9.13–10.16 (the Platonist books); VIII.2.3 (Victorinus's translation); VIII.5.10–12 (the divided will); VIII.6.14–15; VIII.12.28; VIII.12.29; VIII.12.30; IX.2.2–4; IX.3.6; IX.4.7; IX.6.14; IX.10.23–11.28",
  'Augustine, Confessions VIII; cross-referenced with his birth date of 13 November 354 CE, Possidius, Vita Augustini 1',
  'Augustine, Epistulae 3–14 (letters to Nebridius)',
  'De Beata Vita 1.6',
  "Jerome, De Viris Illustribus 125 on Evagrius's translation",
  'Possidius, Vita Augustini',
  'Romans 13:13–14 (Vulgate and Vetus Latina)',
];

head('Augustine (tolle_lege_milan_386): 21 → 8, approved 2 Nov');
{
  const got = cites(AUGUSTINE_BEFORE);
  check('exact approved output', JSON.stringify(got) === JSON.stringify(AUGUSTINE_AFTER), '\n' + got.join('\n'));
  const out = got.join(' | ');
  const lost = [...new Set(AUGUSTINE_BEFORE.flatMap(c => c.split(/[\s;,]+/)).map(t => t.replace(/[().]+$/, '').replace(/^\(/, '')).filter(t => t && !out.includes(t)))];
  // The only words allowed to disappear are loci folded into a range that covers them.
  check('no word lost except loci folded into a covering range',
    JSON.stringify(lost.sort()) === JSON.stringify(['VI.10.17', 'VIII.6.15']) && out.includes('VI.10.16–17') && out.includes('VIII.6.14–15'), lost.join(' '));
  check('idempotent', JSON.stringify(cites(got)) === JSON.stringify(got));
}

head('loci union');
check('user example: IX.4.7, IX.6.14 + IX.6.14 → one entry',
  JSON.stringify(cites(['Augustine, Confessions IX.4.7, IX.6.14', 'Augustine, Confessions IX.6.14'])) === JSON.stringify(['Augustine, Confessions IX.4.7; IX.6.14']));
check('points fold into a same-depth range', cites(['A, Work VIII.6.14', 'A, Work VIII.6.14–15', 'A, Work VIII.6.15'])[0] === 'A, Work VIII.6.14–15');
check('numeric order, not alphabetical (III < IX < X)', cites(['A, Work X.1', 'A, Work IX.1', 'A, Work III.1'])[0] === 'A, Work III.1; IX.1; X.1');
check('bare book dropped only when a specific locus in it exists', cites(['A, Work VIII', 'A, Work VIII.2'])[0] === 'A, Work VIII.2' && cites(['A, Work VIII', 'A, Work IX.2'])[0] === 'A, Work VIII; IX.2');
check('notes ride with their locus', cites(['A, Work 3–14 (letters)', 'A, Work 5'])[0] === 'A, Work 3–14 (letters)');

head('bounds');
check('all-or-nothing: an unparseable segment keeps the whole citation verbatim',
  cites(['Augustine, Confessions VIII; cross-referenced with his birth date of 13 November 354 CE, Possidius, Vita Augustini 1'])[0]
  === 'Augustine, Confessions VIII; cross-referenced with his birth date of 13 November 354 CE, Possidius, Vita Augustini 1');
check('author never inferred (De Beata Vita stays authorless)', cites(['Augustine, Confessions IX.2.2; De Beata Vita 1.6']).includes('De Beata Vita 1.6'));
check('a year is never a locus', JSON.stringify(cites(["Washington's General Orders, August 1776", "Washington's General Orders, August 1775"]))
  === JSON.stringify(["Washington's General Orders, August 1775", "Washington's General Orders, August 1776"]));
check('a segment with no locus is one exact unit', JSON.stringify(cites(['Congressional Record; NASA Astronaut Biography, JSC']))
  === JSON.stringify(['Congressional Record', 'NASA Astronaut Biography, JSC']));
check('exact units dedupe across citations', cites(['A, Work 1; Possidius, Vita Augustini', 'B, Other 2; Possidius, Vita Augustini']).filter(c => c === 'Possidius, Vita Augustini').length === 1);
check('modern citation with a year in parentheses kept verbatim',
  cites(['Gene Kranz, Failure Is Not an Option (2000); NASA Mission Control shift logs, April 1970'])[0]
  === 'Gene Kranz, Failure Is Not an Option (2000); NASA Mission Control shift logs, April 1970');

head('linked entries and order');
{
  const linked = { citation: 'Augustine, Confessions IX.6.14', url: 'https://example.org/conf', access_note: null };
  const noted  = { citation: 'Archive box 4', url: null, access_note: 'Reading room only' };
  const got = consolidateBibliography([E('Augustine, Confessions IX.6.14'), linked, linked, noted, E('Zeta, Work 1'), E('alpha, Work 2')]);
  check('linked entries come first', got.slice(0, 2).every(e => e.url || e.access_note));
  check('linked entry exact-deduped and untouched', got.filter(e => e.url === linked.url).length === 1 && got.find(e => e.url === linked.url).citation === linked.citation);
  check('access_note entry untouched', got.some(e => e.access_note === 'Reading room only' && e.citation === 'Archive box 4'));
  check('linked entry not merged into the plain group', got.filter(e => e.citation === 'Augustine, Confessions IX.6.14').length === 2);
  check('linked count', got.filter(e => e.url || e.access_note).length === 2);
  const plain = got.filter(e => !e.url && !e.access_note).map(e => e.citation);
  check('plain list case-insensitive alphabetical', JSON.stringify(plain) === JSON.stringify([...plain].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))));
}
check('empty / junk input', consolidateBibliography([]).length === 0 && consolidateBibliography([null, { citation: '' }, E('  ')]).length === 0);

console.log(fails ? `\n${fails} failure(s).` : '\nAll bibliography checks passed.');
process.exit(fails ? 1 : 0);
