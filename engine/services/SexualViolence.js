// Sexual-violence gate — engine-wide, always on. Third category of the input-safety gate
// (InputSafetyGate.js), after self-harm (CrisisIntercept.js) and child safety (ChildSafety.js).
//
// Blocks a player's TYPED input before it reaches the story model when it solicits sexual
// violence — rape, sexual assault, forcing someone into a sexual act — to be carried out or
// depicted in the story. Non-sexual violence ("I strike him down") is NOT this category: it passes
// through to the story model, which handles it in-frame.
//
// Same shape as the child-safety category, biased toward blocking:
//   1. sexualViolencePrefilter — regex. Any sexual-violence term sends the text to stage 2. A
//      first-person act or a request to depict ("I rape…", "describe her rape") blocks outright.
//   2. classifySexualViolence — one Haiku call (temperature 0, strict JSON
//      {"sexual_violence": bool}). Errors, timeouts and anything but a clean boolean BLOCK.
// Historical mention without a request to depict ("the rape of Lucretia", as Augustine discusses
// it) reaches stage 2 and is the classifier's to clear.

export const SEXUAL_VIOLENCE_CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// The fixed refusal, shown on the same out-of-character refusal card as child safety. Static,
// never model-generated, never echoes the player's input.
export const SEXUAL_VIOLENCE_REFUSAL = 'I can’t engage with that. I won’t depict sexual violence, and I’m not able to continue in that direction. If you’d like to keep going, choose one of the options or type a different action.';

// ── Stage 1 ───────────────────────────────────────────────────────────────────
const RAPE = '(?:rap(?:e|es|ed|ing|ist|ists))';   // not "rapeseed", "grape", "drape"
const SV_TERMS = [
  new RegExp(`\\b${RAPE}\\b`),
  /\bsexual(?:ly)?\s+(?:assault\w*|abus\w*|violen\w*|attack\w*|forc\w*|coerc\w*)/,
  /\bmolest\w*/,
  /\bgrop(?:e|es|ed|ing)\b/,
  /\bravish\w*/,
  /\bnon[\s-]?consensual\w*/,
  /\bforc(?:e|es|ed|ing)\s+(?:my|him|her|them|your)sel(?:f|ves)\s+(?:on|upon|onto)\b/,
  /\bforc(?:e|es|ed|ing)\s+(?:her|him|them|someone|somebody|the\s+\w+|a\s+\w+)\s+(?:to\s+|into\s+)?(?:have\s+sex|sex|sleep\s+with|bed|lie\s+with|undress|strip|submit|kiss|touch|perform)/,
  /\bforcibl[ey]\s+(?:undress\w*|strip\w*|bed\w*|tak\w*|kiss\w*|seduc\w*|have)/,
  /\b(?:take|takes|took|taking)\s+(?:her|him|them)\s+by\s+force\b/,
  /\bhave\s+(?:my|his|their|your)\s+way\s+with\b/,
  /\bagainst\s+(?:her|his|their|my)\s+will\b/,
  /\bviolat(?:e|es|ed|ing)\s+(?:her|him|them)\b/,
];
// A first-person act, or a request that the story depict it: block without a classifier call.
// Active forms only ("rape", "raping"), with no be-verb in the gap, so a disclosure ("I was
// raped") is never auto-refused; it goes to the classifier, which does not treat it as soliciting.
const FIRST_PERSON = `(?:i|i'll|i\\s+will|i'm\\s+going\\s+to|im\\s+going\\s+to|i\\s+want\\s+to|i\\s+wanna|let\\s+me)`;
const GAP = `(?:(?!was\\b|were\\b|been\\b|got\\b|get\\b|being\\b|am\\b|is\\b)\\w+\\s+){0,2}`;
const SV_AUTO = [
  new RegExp(`\\b${FIRST_PERSON}\\s+${GAP}(?:rape|raping)\\b`),
  new RegExp(`\\b(?:describe|show|write|narrate|depict)\\s+(?:\\w+\\s+){0,4}${RAPE}\\b`),
  new RegExp(`\\b${FIRST_PERSON}\\s+${GAP}sexually\\s+assault(?:s|ing)?\\b`),
  /\bforc(?:e|es|ed|ing)\s+(?:my|him|her|them|your)sel(?:f|ves)\s+(?:on|upon|onto)\b/,
];

function norm(text) { return String(text).toLowerCase().replace(/[‘’]/g, "'"); }

// { stage1, autoBlock }
export function sexualViolencePrefilter(text) {
  if (typeof text !== 'string' || !text.trim()) return { stage1: false, autoBlock: false };
  const t = norm(text);
  const autoBlock = SV_AUTO.some(re => re.test(t));
  return { stage1: autoBlock || SV_TERMS.some(re => re.test(t)), autoBlock };
}

// ── Stage 2 ───────────────────────────────────────────────────────────────────
const CLASSIFIER_SYSTEM = `You are a sexual-violence classifier for an interactive historical fiction game. Players type what their character says or does in scenes set in history (wars, sieges, saints' lives, conversions).

Decide ONE thing: does this message solicit sexual violence — rape, sexual assault, or forcing or coercing someone into a sexual act — to be carried out, depicted, or described in the story? Answer true if the player's character does it or tries to, if the player asks for it to happen to anyone, or asks for it to be described.

Answer false for non-sexual violence (combat, striking, killing, torture with no sexual element), for consensual romance between adults, for a player saying that they themselves were assaulted (a disclosure, not a request), and for plain factual or historical references that do not ask for sexual violence to be depicted (for example a question about what a historical text says about a crime, or Augustine's discussion of Lucretia).

If you are unsure, answer true.

Respond with ONLY a JSON object, exactly {"sexual_violence": true} or {"sexual_violence": false}. No other text.`;

// Returns { block: true|false } on a clean answer, or { error } (the caller fails closed).
export async function classifySexualViolence(text, { apiKey, timeoutMs = 8000, onUsage = null, fetchImpl = globalThis.fetch } = {}) {
  try {
    const resp = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: SEXUAL_VIOLENCE_CLASSIFIER_MODEL,
        max_tokens: 20,
        temperature: 0,
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: `Player's typed message:\n"""\n${text}\n"""` }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return { error: `classifier HTTP ${resp.status}` };
    const data = await resp.json();
    if (onUsage && data?.usage) { try { onUsage(SEXUAL_VIOLENCE_CLASSIFIER_MODEL, data.usage); } catch {} }
    const raw = (data?.content?.[0]?.text || '').trim();
    const m = raw.match(/\{[^{}]*\}/);
    let parsed = null;
    try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
    if (!parsed || typeof parsed.sexual_violence !== 'boolean') return { error: `classifier answered ${JSON.stringify(raw.slice(0, 80))}` };
    return { block: parsed.sexual_violence };
  } catch (e) {
    return { error: `classifier ${e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out' : 'threw'}: ${e.message}` };
  }
}

// Both stages. `block` true means: refuse, do not run a story turn.
//   stage2: 'skipped' | 'auto' (blocked without a classifier call) | 'block' | 'clear' | 'error' (failed closed)
export async function checkSexualViolence(text, opts = {}) {
  const pre = sexualViolencePrefilter(text);
  if (pre.autoBlock) return { stage1: true, block: true, stage2: 'auto' };
  if (!pre.stage1) return { stage1: false, block: false, stage2: 'skipped' };
  const r = await classifySexualViolence(text, opts);
  if (r.error) return { stage1: true, block: true, stage2: 'error', error: r.error };
  return { stage1: true, block: r.block, stage2: r.block ? 'block' : 'clear' };
}
