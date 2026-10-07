// CRUCIBLE LINT — the Layer-1 rules a defining-moment crucible is held to, in ONE place.
//
// These began life as assertions in tests/manchon-crucible.test.mjs and
// tests/massieu-crucible.test.mjs, written against the two hand-authored witness crucibles.
// They live here so the generator's validator (adminRouter.js) and those acceptance suites
// import the SAME rules: a rule tightened here tightens both, and neither can drift.
//
// Pure — no I/O, no model call. Nothing at runtime reads this: the engine plays whatever
// block is stored, and these rules decide only what the generator may store.
//
// Two paths, matching archetypeAllows(role, 'fork').path:
//   'witness-crucible'  debriefs REQUIRED; the prose rules are ERRORS (the block is not saved)
//   'protagonist'       debriefs optional; with none, nothing here applies (the generator's
//                       block is exactly what it always was); with them, the prose rules are
//                       WARNINGS for the reviewer — a protagonist may change an outcome, so the
//                       witness rules are advice there, not law
// Word budgets are always WARNINGS: length is a reviewer judgement, the policy the generator
// already applies to the 90-140 setup budget.
//
// WHAT LAYER 1 CANNOT CATCH. Every rule here is deterministic: a phrase, a field, a verbatim
// match. A debrief that overstates what the record supports ("gave the inquiry its evidentiary
// foundation") passes all of them. Semantic fidelity against the Historical Record is the
// Layer-2 consistency validator's job — scoped, not built; until it is, a human review is the
// only check on it.

// The failed-rescue ban — STRICT, no exceptions on the witness path. Generalised from the
// tests' "her" to her/him/them so it holds for any crucible, not only Joan's.
export const FAILED_RESCUE_PATTERNS = Object.freeze([
  /could\s*n[o']t (have )?save(d)? (her|him|them)\b/i,
  /could not (have )?save(d)? (her|him|them)\b/i,
  /failed to save (her|him|them)\b/i,
]);
// Blame laid on the witness for an outcome that was never theirs.
export const BLAME_PATTERNS = Object.freeze([
  /your fault/i,
  /because of you\b/i,
]);
// The tests' BANNED list, as one array (failed rescue + blame).
export const BANNED_DEBRIEF_PATTERNS = Object.freeze([...FAILED_RESCUE_PATTERNS, ...BLAME_PATTERNS]);

// Affirmative claims that the witness CHANGED the fixed outcome. Deliberately narrow: the
// authored debriefs disclaim the outcome in negated forms ("no word in a corridor … could
// have stayed the fire"), and those must pass. The positive guarantee is the required
// outcome_disclaimer below; this list only catches the plain contradiction.
export const OUTCOME_CLAIM_PATTERNS = Object.freeze([
  /\byou (saved|spared|rescued|freed) (her|him|them)\b/i,
  /\byou (stayed|stopped|prevented|halted) (the )?(fire|burning|execution|sentence|verdict)\b/i,
  /\bbecause of (you|your \w+),? (she|he|they) (lived|survived|was spared|were spared|went free)\b/i,
]);

// AUTHORING VOCABULARY — the words of the generator's own prompt and schema, which are not
// narrative and must never reach a player: the first real-model runs leaked "the downstream
// consequence of the vow" and source-hedging ("introduced with the words 'according to
// legend'") into a debrief. Checked in the setup, every option text and label, and every
// debrief. "axis" is matched lowercase only, so a narrative "the Axis" (1939-45) passes;
// "lever" is banned outright, so a scenario with a literal lever in it will need this
// narrowed. Snake_case catches any schema identifier (could_have_acted_at_cost, outcome_disclaimer).
export const AUTHORING_TERM_PATTERNS = Object.freeze([
  /\blevers?\b/i,
  /\b(downstream|displaced) consequences?\b/i,
  /\baxis\b/,
  /\b[a-z]+(?:_[a-z]+)+\b/,
  /\bcounter-?cases?\b/i,
  /\binstrument terms?\b/i,
  /\boutcome disclaimers?\b/i,
  /\baccording to legend\b/i,
  /\bthe (record|records|source|sources|account|accounts) hedges?\b/i,
]);

// Word budgets — [min, max], warnings only. The witness ranges bracket the two authored
// crucibles (Manchon setup 230 / Massieu 283; debriefs 153-207; option texts ~40-65 words).
// The debrief ceiling is 250, not 230: real-model debriefs carry the verbatim disclaimer and
// the cited claim and settle at ~200-250, and shortening them breaks the verbatim claim.
export const BUDGETS = Object.freeze({
  'witness-crucible': { setup: [180, 300], option_text: [25, 70], debrief: [140, 250] },
  'protagonist':      { setup: [90, 140],  option_text: [8, 18],  debrief: [100, 200] },
});
export const LABEL_MAX_CHARS = 50;   // the tests' `label.length < 50`

export const wordCount = s => (typeof s === 'string' ? s.trim().split(/\s+/).filter(Boolean).length : 0);
const str = v => typeof v === 'string' && v.trim() !== '';
const hits = (patterns, text) => patterns.filter(rx => rx.test(text || '')).map(rx => String(rx));

// The lint. `generated` adds the rules only a GENERATED block can satisfy — the machine-
// checkable provenance (verbatim disclaimer, cited consequence, lever terms) the authored
// blocks were reviewed for by hand and never carried as fields. `lever` is the role's
// CONFIRMED witness_lever: a consequence's source must be one of its evidence sources, and
// every debrief must speak in its instrument_terms.
// Returns { errors, warnings } — errors mean "do not store this block".
export function lintCrucibleBlock(block, { path = 'protagonist', generated = true, lever = null } = {}) {
  const errors = [], warnings = [];
  const witness = path === 'witness-crucible';
  const options = Array.isArray(block?.options) ? block.options : [];
  const anyDebrief = options.some(o => o && o.debrief !== undefined);
  const anyLabel   = options.some(o => o && o.label !== undefined);
  if (!witness && !anyDebrief && !anyLabel) return { errors, warnings };   // the old shape — untouched
  const prose = witness ? errors : warnings;
  const budget = BUDGETS[witness ? 'witness-crucible' : 'protagonist'];

  // ── shape ─────────────────────────────────────────────────────────────────
  options.forEach((o, i) => {
    const at = `option ${i + 1}${o?.id ? ` (${o.id})` : ''}`;
    if (witness || anyLabel) {
      if (!str(o?.label)) (witness ? errors : warnings).push(`${at}: needs a short "label".`);
      else if (o.label.trim().length >= LABEL_MAX_CHARS) errors.push(`${at}: "label" must be under ${LABEL_MAX_CHARS} characters (got ${o.label.trim().length}).`);
    }
    if ((witness || anyDebrief) && !str(o?.debrief)) {
      errors.push(`${at}: needs a "debrief" — ${witness ? 'every witness-crucible option carries one' : 'debriefs are all-or-none, or some choices would get an authored "Your Session" and others a model-written one'}.`);
    }
  });

  // ── prose rules ──────────────────────────────────────────────────────────
  const banSetup = hits(BANNED_DEBRIEF_PATTERNS, block?.setup);
  if (banSetup.length) prose.push(`setup: failed-rescue or blame phrasing (${banSetup.join(', ')}).`);
  options.forEach((o, i) => {
    if (!str(o?.debrief)) return;
    const at = `option ${i + 1}${o?.id ? ` (${o.id})` : ''} debrief`;
    const ban = hits(BANNED_DEBRIEF_PATTERNS, o.debrief);
    if (ban.length) prose.push(`${at}: failed-rescue or blame phrasing (${ban.join(', ')}).`);
    const claim = hits(OUTCOME_CLAIM_PATTERNS, o.debrief);
    if (claim.length) prose.push(`${at}: claims the outcome was changed (${claim.join(', ')}).`);
  });
  // Authoring vocabulary, everywhere the player reads.
  const fields = [['setup', block?.setup], ...options.flatMap((o, i) => {
    const at = `option ${i + 1}${o?.id ? ` (${o.id})` : ''}`;
    return [[`${at} text`, o?.text], [`${at} label`, o?.label], [`${at} debrief`, o?.debrief]];
  })];
  for (const [at, text] of fields) {
    if (!str(text)) continue;
    const found = AUTHORING_TERM_PATTERNS.map(rx => text.match(rx)?.[0]).filter(Boolean);
    if (found.length) prose.push(`${at}: authoring vocabulary in player-facing prose (${found.map(t => `"${t}"`).join(', ')}).`);
  }
  const debriefs = options.map(o => (str(o?.debrief) ? o.debrief.trim() : null)).filter(Boolean);
  if (debriefs.length === options.length && options.length > 1 && new Set(debriefs).size < 2) {
    prose.push('debriefs do not branch: every option carries the same debrief (at least two must differ).');
  }

  // ── generated-only provenance: checkable, not decorative ────────────────────
  // "Word for word" means the same words in the same order. Case, whitespace, curly vs
  // straight quotes and a trailing full stop are not words: a claim written as its own
  // sentence ("The French minute…") is still present when the debrief runs it mid-sentence
  // ("…opened, the French minute…"). The first real-model runs failed on exactly that.
  const norm = t => t.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().replace(/[.!?;:,]+$/, '');
  const verbatimIn = (needle, hay) => norm(hay).includes(norm(needle));
  if (generated && witness) {
    const sources = new Set((Array.isArray(lever?.evidence) ? lever.evidence : []).map(e => (e?.source || '').trim()).filter(Boolean));
    const terms   = (Array.isArray(lever?.instrument_terms) ? lever.instrument_terms : []).filter(str).map(t => t.trim().toLowerCase());
    options.forEach((o, i) => {
      if (!str(o?.debrief)) return;
      const at = `option ${i + 1}${o?.id ? ` (${o.id})` : ''}`;
      const d  = o.debrief;
      if (!str(o.outcome_disclaimer)) errors.push(`${at}: needs an "outcome_disclaimer" (the sentence that says the outcome was never theirs to change).`);
      else if (!verbatimIn(o.outcome_disclaimer, d)) errors.push(`${at}: "outcome_disclaimer" does not appear word for word in the debrief.`);
      const c = o.consequence;
      if (!c || !str(c.claim) || !str(c.source)) errors.push(`${at}: needs a "consequence" { claim, source } — the displaced consequence, cited.`);
      else {
        if (!verbatimIn(c.claim, d)) errors.push(`${at}: consequence.claim does not appear word for word in the debrief.`);
        if (sources.size && !sources.has(c.source.trim())) errors.push(`${at}: consequence.source "${c.source.trim()}" is not one of the confirmed lever's evidence sources.`);
      }
      if (terms.length && !terms.some(t => d.toLowerCase().includes(t))) {
        errors.push(`${at}: debrief never names the lever (none of: ${terms.join(', ')}).`);
      }
    });
    if (!sources.size) errors.push('the confirmed lever carries no evidence sources, so no consequence can be checked against it.');
  }

  // ── budgets (warnings) ───────────────────────────────────────────────────
  const within = (label, n, [lo, hi]) => { if (n < lo || n > hi) warnings.push(`${label}: ${n} words (budget ${lo}-${hi}).`); };
  if (witness) within('setup', wordCount(block?.setup), budget.setup);
  options.forEach((o, i) => {
    const at = `option ${i + 1}${o?.id ? ` (${o.id})` : ''}`;
    if (witness) within(`${at} text`, wordCount(o?.text), budget.option_text);
    if (str(o?.debrief)) within(`${at} debrief`, wordCount(o.debrief), budget.debrief);
  });
  return { errors, warnings };
}
