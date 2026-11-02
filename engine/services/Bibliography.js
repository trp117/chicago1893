// Primary Sources consolidation — the closing screen's list and the transcript's
// "## Primary Sources" both print what assembleBibliography (gameRouter.js) returns, and it
// returns consolidateBibliography(entries).
//
// WHY. The list aggregates one source per character fate and per technical fact, so a classical
// scenario repeats the same work dozens of times: Tolle Lege showed 21 entries, 18 of them
// "Augustine, Confessions …", with VIII.6.14, VIII.6.15 and VIII.6.14–15 as three lines.
//
// Input and output: [{ citation, url, access_note }] — the shape the client already renders.
//
// BOUNDS — arbitrary citation strings cannot be parsed perfectly, so parsing is narrow and every
// failure falls back to the author's own text:
//  - Entries carrying a url or access_note pass through untouched (exact-deduped only): merging
//    would detach a link from the locus it points at.
//  - A citation is split on ";". A segment is parsed only in the shape
//      [Author, ]Work Locus[, Locus…]              "Augustine, Confessions IX.4.7, IX.6.14"
//    or as a bare locus continuing the previous segment's work ("VIII.2.3 (Victorinus's …)").
//  - ALL OR NOTHING per citation: if any segment fails to parse, the WHOLE citation is kept
//    verbatim, so a fragment never loses the context its neighbours gave it ("…cross-referenced
//    with his birth date…" keeps the "Confessions VIII" in front of it).
//  - A segment with no locus is one exact unit, deduped by its text — never split into
//    author/work ("NASA Astronaut Biography, JSC" is not an author and a work).
//  - A plain four-digit year is a date, never a locus ("August 1776", "(1878)").
//  - Author is never inferred: "De Beata Vita 1.6" after "Augustine, Confessions …" stays
//    authorless, because the same inference would make Augustine the author of Romans.
//  - Loci of one work are unioned: exact duplicates collapse; a point inside a same-depth range
//    collapses into the range (VIII.6.14 into VIII.6.14–15); a bare book (VIII) is dropped when a
//    more specific locus in that book is cited; parenthetical notes ride with their locus; loci
//    sort numerically (III before IX — plain alphabetical sorting gets that wrong).
//  - Order: linked entries first (as before), then ONE case-insensitive alphabetical list of
//    everything else, so the order never depends on which entries happened to parse.

const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };
const romanToInt = s => {
  let n = 0;
  for (let i = 0; i < s.length; i++) { const v = ROMAN[s[i]], w = ROMAN[s[i + 1]] || 0; n += v < w ? -v : v; }
  return n;
};
const parseNum = p => (/^\d+$/.test(p) ? +p : romanToInt(p));

const PART  = '(?:[IVXLC]+|\\d+)';
const LOCUS = `${PART}(?:[.:]\\d+)*(?:[–-]${PART}?(?:[.:]?\\d+)*)?`;
const LOCUS_RE = new RegExp(`^(?!(?:1\\d|20)\\d\\d(?![.:\\d–-]))(${LOCUS})(?=$|[\\s,(])`);
const AUTHOR_RE = /^[A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,2}$/;
const TITLE_RE  = /^(?:[A-Z][\w'’-]*|de|of|the|in|ad|et)(?:\s+(?:[A-Z][\w'’-]*|de|of|the|in|ad|et))*$/;

// "IX.4.7, IX.6.14" / "3–14 (letters to Nebridius)" / "125 on Evagrius's translation"
function splitLoci(text) {
  const out = [];
  let s = text.trim().replace(/\.$/, '');
  while (s) {
    const m = s.match(LOCUS_RE);
    if (!m) return null;
    const tail = s.slice(m[1].length);
    const next = tail.search(/,\s*(?=[IVXLC\d])/);
    out.push({ locus: m[1], note: (next >= 0 ? tail.slice(0, next) : tail).trim() });
    s = next >= 0 ? tail.slice(next).replace(/^,\s*/, '') : '';
  }
  return out;
}

function parseSegment(seg, prev) {
  const t = seg.trim().replace(/\.$/, '');
  if (!t) return null;
  if (prev?.work && LOCUS_RE.test(t)) {
    const loci = splitLoci(t);
    if (loci) return { author: prev.author, work: prev.work, loci };
  }
  let author = '', body = t;
  const comma = t.indexOf(',');
  if (comma > 0) {
    const a = t.slice(0, comma).trim();
    if (!AUTHOR_RE.test(a)) return null;
    author = a; body = t.slice(comma + 1).trim();
  }
  const words = body.split(/\s+/);
  let i = 0;
  while (i < words.length && !LOCUS_RE.test(words.slice(i).join(' '))) i++;
  const work = words.slice(0, i).join(' ');
  if (!work || /\d/.test(work) || work.split(/\s+/).length > 5 || !TITLE_RE.test(work)) return null;
  const rest = words.slice(i).join(' ');
  const loci = rest ? splitLoci(rest) : [];
  if (loci == null) return null;
  if (!loci.length) return { unit: t };
  return { author, work, loci };
}

const cmp = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? -1) - (b[i] ?? -1); if (d) return d; }
  return 0;
};
const locusKey = l => l.split(/[–-]/)[0].split(/[.:]/).map(parseNum);
function rangeOf(l) {
  const [s, e] = l.split(/[–-]/);
  const start = s.split(/[.:]/).map(parseNum);
  if (!e) return { start, end: start };
  const ep = e.split(/[.:]/).map(parseNum);
  return { start, end: [...start.slice(0, start.length - ep.length), ...ep] };
}

function unionLoci(list) {
  const notes = new Map();
  for (const { locus, note } of list) {
    if (!notes.has(locus)) notes.set(locus, new Set());
    if (note) notes.get(locus).add(note);
  }
  let loci = [...notes.keys()];
  const ranges = loci.filter(l => /[–-]/.test(l)).map(l => ({ l, ...rangeOf(l) }));
  loci = loci.filter(l => {
    if (/[–-]/.test(l)) return true;
    const p = l.split(/[.:]/).map(parseNum);
    const host = ranges.find(r => r.start.length === p.length && cmp(r.start, p) <= 0 && cmp(p, r.end) <= 0);
    if (!host) return true;
    for (const n of notes.get(l)) notes.get(host.l).add(n);
    return false;
  });
  loci = loci.filter(l => !(/^[IVXLC]+$/.test(l) && notes.get(l).size === 0 && loci.some(o => o.startsWith(l + '.'))));
  loci.sort((a, b) => cmp(locusKey(a), locusKey(b)));
  return loci.map(l => [l, ...notes.get(l)].join(' '));
}

export function consolidateBibliography(entries) {
  const linked = [], seenLinked = new Set();
  const verbatim = new Set(), units = new Set(), groups = new Map();
  for (const e of entries || []) {
    if (!e?.citation || typeof e.citation !== 'string') continue;
    if (e.url || e.access_note) {
      const k = `${e.citation}\u0000${e.url}\u0000${e.access_note}`;
      if (!seenLinked.has(k)) { seenLinked.add(k); linked.push(e); }
      continue;
    }
    const parsed = [];
    let prev = null, failed = false;
    for (const seg of e.citation.split(';')) {
      if (!seg.trim()) continue;
      const p = parseSegment(seg, prev);
      if (!p) { failed = true; break; }
      parsed.push(p); prev = p;
    }
    if (failed) { verbatim.add(e.citation.trim().replace(/\s+/g, ' ')); continue; }
    for (const p of parsed) {
      if (p.unit) { units.add(p.unit.replace(/\s+/g, ' ')); continue; }
      const key = p.work.toLowerCase();
      const g = groups.get(key) || { author: '', work: p.work, loci: [] };
      if (!g.author && p.author) g.author = p.author;
      g.loci.push(...p.loci);
      groups.set(key, g);
    }
  }
  const grouped = [...groups.values()].map(g => `${g.author ? g.author + ', ' : ''}${g.work} ${unionLoci(g.loci).join('; ')}`);
  const rest = [...new Set([...grouped, ...units, ...verbatim])]
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
    .map(citation => ({ citation, url: null, access_note: null }));
  linked.sort((a, b) => a.citation.localeCompare(b.citation));
  return [...linked, ...rest];
}
