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
// Word budgets and source hedges are always WARNINGS: length is a reviewer judgement, the
// policy the generator already applies to the 90-140 setup budget, and a hedge may be honest.
// Every problem is a FINDING located on its element (see RULE_HINTS below).
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
// consequence of the vow" into a debrief. Checked in the setup, every option text and label,
// and every debrief. "axis" is matched lowercase only, so a narrative "the Axis" (1939-45)
// passes; "lever" is banned outright, so a scenario with a literal lever in it will need this
// narrowed. Snake_case catches any schema identifier (could_have_acted_at_cost, outcome_disclaimer).
// ERRORS on the witness path; warnings on the protagonist path, like every prose rule.
export const AUTHORING_TERM_PATTERNS = Object.freeze([
  /\blevers?\b/i,
  /\b(downstream|displaced) consequences?\b/i,
  /\baxis\b/,
  /\b[a-z]+(?:_[a-z]+)+\b/,
  /\bcounter-?cases?\b/i,
  /\binstrument terms?\b/i,
  /\boutcome disclaimers?\b/i,
]);
// SOURCE HEDGES — the same leak in a gentler form (the first runs "introduced" a story "with
// the words 'according to legend'"), but one a narrative can also use honestly: a story that
// IS legend may say so. WARNINGS on every path — flagged for a human to adjudicate, never
// blocking.
export const SOURCE_HEDGE_PATTERNS = Object.freeze([
  /\baccording to legend\b/i,
  /\bthe (record|records|source|sources|account|accounts) hedges?\b/i,
]);

// THE FINDING — one problem, located on the element it concerns, so the review UI can flag
// that element (not just list strings at the top):
//   { severity: 'error'|'warning', rule, location, message, hint }
// location: 'block' (structure) | 'setup' | 'options' (block-wide) | 'option.<id>.<field>'
//   (text, label, debrief, outcome_disclaimer, consequence) | 'lever' | 'lever.<field>' |
//   'lever.evidence.<n>.<claim|source>' (n counts from 0, as the array does).
// An option with a missing or duplicated id is located as 'option.#<index>' instead.
// `hint` says what to do about it; for a warning it carries the context to adjudicate.
export const RULE_HINTS = Object.freeze({
  structure:               'Fix the field so the engine can play the block.',
  failed_rescue:           'A witness never failed to save anyone — the outcome was never theirs. Say what the choice cost or carried instead.',
  blame:                   'Lay no blame for an outcome that was never the witness\'s. Say what the choice cost or carried instead.',
  outcome_claim:           'The fixed outcome stands whatever the player chose. Reword so the choice changes what it touched, not the outcome.',
  authoring_term:          'This is the generator\'s own vocabulary, not narrative. Say it in the scene\'s words.',
  source_hedge:            'Flagged as authoring language; may be a legitimate source-hedge — reword into the narrative or accept.',
  label_missing:           'Give the option a short button label (under 50 characters).',
  label_too_long:          'Shorten the label to under 50 characters — it is the button text.',
  debrief_missing:         'Write the "Your Session" debrief this choice ships.',
  debriefs_identical:      'At least two debriefs must differ — the choice has to matter to what the player is told.',
  disclaimer_missing:      'Add the sentence that says the outcome was never the player\'s to change.',
  disclaimer_not_verbatim: 'The disclaimer must appear word for word in the debrief — edit the debrief or the disclaimer so they match.',
  consequence_missing:     'Add the consequence this choice carried, with the lever evidence source it rests on.',
  claim_not_verbatim:      'The cited claim must appear word for word in the debrief — edit the debrief or the claim so they match.',
  source_not_in_lever:     'Cite one of the confirmed lever\'s evidence sources, or correct the lever first.',
  lever_terms_absent:      'Name what the witness actually held, in one of the lever\'s own words, somewhere in the debrief.',
  lever_no_sources:        'Confirm a lever with cited evidence before generating on it.',
  budget:                  'Length is a judgement call — trim or accept.',
  lever_shape:             'Complete the lever field before confirming.',
});

export const finding = (severity, rule, location, message, hint = RULE_HINTS[rule] || '') =>
  ({ severity, rule, location, message, hint });
// The plain-text rendering, for logs and test assertions: "<location>: <message>".
export const formatFinding  = f => `${f.location}: ${f.message}`;
export const formatFindings = fs => (fs || []).map(formatFinding);
// { findings, errors, warnings } — errors/warnings are the text renderings, split by severity.
export const lintResult = findings => ({
  findings,
  errors:   formatFindings(findings.filter(f => f.severity === 'error')),
  warnings: formatFindings(findings.filter(f => f.severity === 'warning')),
});
// Where an option is: by id when its id is present and unique, by index otherwise.
export function optionLocator(options) {
  const ids = (options || []).map(o => (typeof o?.id === 'string' ? o.id.trim() : ''));
  return (i, field) => {
    const id = ids[i];
    const base = id && ids.indexOf(id) === ids.lastIndexOf(id) ? `option.${id}` : `option.#${i}`;
    return field ? `${base}.${field}` : base;
  };
}

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
// Returns { findings, errors, warnings } (lintResult) — any finding of severity 'error'
// means "do not store this block"; errors/warnings are the text renderings of the findings.
export function lintCrucibleBlock(block, { path = 'protagonist', generated = true, lever = null } = {}) {
  const findings = [];
  const add = (severity, rule, location, message) => findings.push(finding(severity, rule, location, message));
  const witness = path === 'witness-crucible';
  const options = Array.isArray(block?.options) ? block.options : [];
  const anyDebrief = options.some(o => o && o.debrief !== undefined);
  const anyLabel   = options.some(o => o && o.label !== undefined);
  if (!witness && !anyDebrief && !anyLabel) return lintResult(findings);   // the old shape — untouched
  const prose = witness ? 'error' : 'warning';
  const budget = BUDGETS[witness ? 'witness-crucible' : 'protagonist'];
  const loc = optionLocator(options);

  // ── shape ─────────────────────────────────────────────────────────────────
  options.forEach((o, i) => {
    if (witness || anyLabel) {
      if (!str(o?.label)) add(witness ? 'error' : 'warning', 'label_missing', loc(i, 'label'), 'needs a short "label".');
      else if (o.label.trim().length >= LABEL_MAX_CHARS) add('error', 'label_too_long', loc(i, 'label'), `"label" must be under ${LABEL_MAX_CHARS} characters (got ${o.label.trim().length}).`);
    }
    if ((witness || anyDebrief) && !str(o?.debrief)) {
      add('error', 'debrief_missing', loc(i, 'debrief'), `needs a "debrief" — ${witness ? 'every witness-crucible option carries one' : 'debriefs are all-or-none, or some choices would get an authored "Your Session" and others a model-written one'}.`);
    }
  });

  // ── prose rules ──────────────────────────────────────────────────────────
  const banned = (location, text) => {
    const rescue = hits(FAILED_RESCUE_PATTERNS, text), blame = hits(BLAME_PATTERNS, text);
    if (rescue.length) add(prose, 'failed_rescue', location, `failed-rescue phrasing (${rescue.join(', ')}).`);
    if (blame.length)  add(prose, 'blame', location, `blame phrasing (${blame.join(', ')}).`);
  };
  banned('setup', block?.setup);
  options.forEach((o, i) => {
    if (!str(o?.debrief)) return;
    banned(loc(i, 'debrief'), o.debrief);
    const claim = hits(OUTCOME_CLAIM_PATTERNS, o.debrief);
    if (claim.length) add(prose, 'outcome_claim', loc(i, 'debrief'), `claims the outcome was changed (${claim.join(', ')}).`);
  });
  // Authoring vocabulary and source hedges, everywhere the player reads.
  const fields = [['setup', block?.setup], ...options.flatMap((o, i) =>
    [[loc(i, 'text'), o?.text], [loc(i, 'label'), o?.label], [loc(i, 'debrief'), o?.debrief]])];
  const quoted = found => found.map(t => `"${t}"`).join(', ');
  for (const [at, text] of fields) {
    if (!str(text)) continue;
    const terms  = AUTHORING_TERM_PATTERNS.map(rx => text.match(rx)?.[0]).filter(Boolean);
    if (terms.length) add(prose, 'authoring_term', at, `authoring vocabulary in player-facing prose (${quoted(terms)}).`);
    const hedges = SOURCE_HEDGE_PATTERNS.map(rx => text.match(rx)?.[0]).filter(Boolean);
    if (hedges.length) add('warning', 'source_hedge', at, `possible authoring language in player-facing prose (${quoted(hedges)}).`);
  }
  const debriefs = options.map(o => (str(o?.debrief) ? o.debrief.trim() : null)).filter(Boolean);
  if (debriefs.length === options.length && options.length > 1 && new Set(debriefs).size < 2) {
    add(prose, 'debriefs_identical', 'options', 'debriefs do not branch: every option carries the same debrief (at least two must differ).');
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
      const d = o.debrief;
      if (!str(o.outcome_disclaimer)) add('error', 'disclaimer_missing', loc(i, 'outcome_disclaimer'), 'needs an "outcome_disclaimer" (the sentence that says the outcome was never theirs to change).');
      else if (!verbatimIn(o.outcome_disclaimer, d)) add('error', 'disclaimer_not_verbatim', loc(i, 'outcome_disclaimer'), '"outcome_disclaimer" does not appear word for word in the debrief.');
      const c = o.consequence;
      if (!c || !str(c.claim) || !str(c.source)) add('error', 'consequence_missing', loc(i, 'consequence'), 'needs a "consequence" { claim, source } — what the choice carried, cited.');
      else {
        if (!verbatimIn(c.claim, d)) add('error', 'claim_not_verbatim', loc(i, 'consequence'), 'consequence.claim does not appear word for word in the debrief.');
        if (sources.size && !sources.has(c.source.trim())) add('error', 'source_not_in_lever', loc(i, 'consequence'), `consequence.source "${c.source.trim()}" is not one of the confirmed lever's evidence sources.`);
      }
      if (terms.length && !terms.some(t => d.toLowerCase().includes(t))) {
        add('error', 'lever_terms_absent', loc(i, 'debrief'), `debrief never names the lever (none of: ${terms.join(', ')}).`);
      }
    });
    if (!sources.size) add('error', 'lever_no_sources', 'lever', 'the confirmed lever carries no evidence sources, so no consequence can be checked against it.');
  }

  // ── budgets (warnings) ───────────────────────────────────────────────────
  const within = (location, n, [lo, hi]) => { if (n < lo || n > hi) add('warning', 'budget', location, `${n} words (budget ${lo}-${hi}).`); };
  if (witness) within('setup', wordCount(block?.setup), budget.setup);
  options.forEach((o, i) => {
    if (witness) within(loc(i, 'text'), wordCount(o?.text), budget.option_text);
    if (str(o?.debrief)) within(loc(i, 'debrief'), wordCount(o.debrief), budget.debrief);
  });
  return lintResult(findings);
}
