// [UNVERIFIED] — the scenario generator's flag for a specific it could not source.
//
// The tag exists for one reader: the human reviewing a draft. So it has to stay visible in
// the admin and must never survive into play. Two halves, one definition of the tag:
//   - admin side: findUnverifiedInBundle feeds the red validation error and the publish gate.
//   - play side:  withUnverifiedStripped / stripUnverifiedDeep / stripUnverifiedFromJson.
//
// The reviewer's ---UNVERIFIED: field--- output format is a different token and never matches.

// The bare tag, or the tag plus a note: [UNVERIFIED: which battalion]. Live generation writes
// the note form unprompted, so the separator is matched loosely (colon or dash).
const TAG = String.raw`\[\s*unverified\s*(?:[:–—-][^\]]*)?\]`;
const TAG_TEST = new RegExp(TAG, 'i');
const TAG_ALL = new RegExp(TAG, 'gi');
// A tag opening a line takes the space AFTER it; anywhere else, the space BEFORE it. Either
// way the sentence closes up as though the tag had never been written.
const TAG_STRIP = new RegExp(String.raw`^[ \t]*${TAG}[ \t]*|[ \t]*${TAG}`, 'gim');

export function hasUnverifiedTag(value) {
  return typeof value === 'string' && TAG_TEST.test(value);
}

export function stripUnverifiedTag(value) {
  return hasUnverifiedTag(value) ? value.replace(TAG_STRIP, '') : value;
}

const isPlain = v => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

// Copy-on-write: anything without a tag comes back as the same reference, so the normal case
// (no tags anywhere) allocates nothing and repository caches are never mutated.
export function stripUnverifiedDeep(value) {
  if (typeof value === 'string') return stripUnverifiedTag(value);
  if (Array.isArray(value)) {
    let out = value;
    value.forEach((item, i) => {
      const next = stripUnverifiedDeep(item);
      if (next !== item) {
        if (out === value) out = value.slice();
        out[i] = next;
      }
    });
    return out;
  }
  if (isPlain(value)) {
    let out = value;
    for (const key of Object.keys(value)) {
      const next = stripUnverifiedDeep(value[key]);
      if (next !== value[key]) {
        if (out === value) out = { ...value };
        out[key] = next;
      }
    }
    return out;
  }
  return value;
}

// One entry per tag: { field: 'characters[2].role', tag: '[UNVERIFIED: which battalion]' }.
// The tag comes back whole, because its note is what tells the author what to check.
export function findUnverifiedEntries(value, path = '') {
  if (typeof value === 'string') return (value.match(TAG_ALL) || []).map(tag => ({ field: path, tag }));
  if (Array.isArray(value)) return value.flatMap((item, i) => findUnverifiedEntries(item, `${path}[${i}]`));
  if (isPlain(value)) {
    return Object.keys(value).flatMap(key => findUnverifiedEntries(value[key], path ? `${path}.${key}` : key));
  }
  return [];
}

// Every string field still carrying a tag, as a readable path.
export function findUnverifiedTags(value) {
  return [...new Set(findUnverifiedEntries(value).map(e => e.field))];
}

export function findUnverifiedInBundle({ scenario, storyArc, characters, locations, clues, playerRoles }) {
  return findUnverifiedEntries({ scenario, storyArc, characters, locations, clues, playerRoles });
}

export function unverifiedTagMessage(entries, lead = '[UNVERIFIED] tag still present') {
  // Uncapped: each note is a specific instruction to the author, and a hidden one goes unchecked.
  const shown = entries.map(e => `${e.field}: ${e.tag}`).join('; ');
  return `${lead} (${entries.length}): ${shown}. Verify each specific against a source and remove the tag, or cut the specific.`;
}

// ── Play-time backstop ───────────────────────────────────────────────────────

// The content stores every play-time read goes through. Sessions and players are deliberately
// absent: they are written back, and a sanitizing read has no business in a read-modify-write.
const CONTENT_REPOS = ['scenarios', 'characters', 'locations', 'clues', 'storyArcs'];

// Applied where the game router receives its repos, so the tag is gone before stored text can
// reach a response, a model prompt, session state or a transcript. Every method's result is
// sanitized, sync or async, so a newly added finder is covered without touching this list.
export function withUnverifiedStripped(repos) {
  const wrapped = { ...repos };
  for (const name of CONTENT_REPOS) {
    if (!repos[name]) continue;
    wrapped[name] = new Proxy(repos[name], {
      get(target, prop) {
        const member = Reflect.get(target, prop);
        if (typeof member !== 'function') return member;
        return (...args) => {
          const result = member.apply(target, args);
          return typeof result?.then === 'function'
            ? result.then(stripUnverifiedDeep)
            : stripUnverifiedDeep(result);
        };
      },
    });
  }
  return wrapped;
}

// Outbound layer for JSON responses on player-facing routes.
export function stripUnverifiedFromJson(_req, res, next) {
  const send = res.json.bind(res);
  res.json = body => send(stripUnverifiedDeep(body));
  next();
}
