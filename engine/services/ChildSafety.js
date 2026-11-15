// Child-safety gate — engine-wide, always on. Second category of the input-safety gate
// (InputSafetyGate.js); the first is self-harm (CrisisIntercept.js).
//
// Blocks a player's TYPED input before it reaches the story model when it (a) tries to bring
// sexual or romantic content involving a minor into the story — someone given an under-18 age,
// a child/minor role word (son, daughter, boy, girl, child, teen…), or a named minor character —
// or (b) comes from a player who says they are under 18 and makes a romantic/sexual request.
//
// Biased hard toward blocking:
//   1. childSafetyPrefilter — regex. Any romantic/sexual term together with any minor indicator
//      (or an under-18 self-statement) sends the text to stage 2. An EXPLICIT sexual term together
//      with an EXPLICIT under-18 indicator (a stated age under 18, "minor", "underage", "teen"…)
//      blocks outright, no classifier needed.
//   2. classifyChildSafety — one Haiku call (temperature 0, strict JSON {"minor_sexual": bool}).
//      Errors, timeouts and anything but a clean boolean BLOCK (fail-closed).
// A player who states an under-18 age with no romantic/sexual request is not blocked; the router
// tells the story model to treat that statement as out of character (MINOR_SELF_STATEMENT_NOTE).

export const CHILD_SAFETY_CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// The fixed refusal. Static — never model-generated, never echoes the player's input.
export const CHILD_SAFETY_REFUSAL = 'I can’t engage with that. I won’t include anyone described as a minor in sexual or romantic content, and I’m not able to continue in that direction. If you’d like to keep going, choose one of the options or type a different action.';

// Appended to the turn's system prompt when the player stated an under-18 age but asked for
// nothing romantic or sexual: play on, but never as the character's own age or words.
export const MINOR_SELF_STATEMENT_NOTE = `## OUT-OF-CHARACTER AGE STATEMENT
The player's typed input this turn includes a statement of their own real-world age (under 18). Treat it as said outside the story: do not have the character say or embody it, and do not have any character react to it as the character's age. Continue the scene normally. Keep all content non-romantic and non-sexual.`;

// ── Stage 1 ───────────────────────────────────────────────────────────────────
// "one" is left out: "I am one with God", "he is one of them".
const UNDER18_WORD = '(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)';
const UNDER18_NUM  = '(?:1[0-7]|[1-9])';
const UNDER18      = `(?:${UNDER18_NUM}|${UNDER18_WORD})`;

// A stated age under 18: "14 years old", "fourteen-year-old", "aged 12", "age 9",
// "he is fourteen", "she's 15", "I am 13".
const AGE_UNDER18 = [
  // "old" is required: "ten years ago" is not an age.
  new RegExp(`\\b${UNDER18}[\\s-]*(?:years?|yrs?)[\\s-]*old\\b`),
  new RegExp(`\\b${UNDER18}\\s*yo\\b`),
  new RegExp(`\\bage[sd]?\\s+(?:of\\s+)?${UNDER18}\\b`),
  new RegExp(`\\b(?:he|she|i|you)(?:'s|'re|'m|\\s+is|\\s+are|\\s+am|\\s+was|\\s+were)\\s+(?:only\\s+|just\\s+|barely\\s+)?${UNDER18}\\b(?!\\s+(?:of|more|times|men|women|people|days|hours|minutes|miles|feet|leagues|paces|yards|steps))`),
];
// Explicit under-18 words (block-worthy with an explicit sexual term).
const EXPLICIT_MINOR_WORD = /\b(?:minors?|under[\s-]?age(?:d)?|under\s+18|under\s+eighteen|pre[\s-]?teens?|teens?|teenagers?|teenaged?|pre[\s-]?pubescent|pubescent|toddlers?|infants?|school\s?(?:girl|boy|child)s?|middle\s+school|high\s+school|grade\s+school|elementary\s+school)\b/;
// Role words that usually (not always) mean a child — enough to send to stage 2, not to block.
const ROLE_MINOR_WORD = /\b(?:sons?|daughters?|boys?|girls?|child|children|childhood|kids?|youths?|lads?|lasses?|little\s+(?:one|ones)|babies|baby|nephews?|nieces?|step(?:son|daughter)s?)\b/;
// Named minor characters in the scenarios.
export const NAMED_MINORS = ['adeodatus'];
const NAMED_MINOR = new RegExp(`\\b(?:${NAMED_MINORS.join('|')})\\b`);

// The player saying they are under 18.
const SELF_UNDER18 = [
  new RegExp(`\\b(?:i'?m|i\\s+am|im)\\s+(?:only\\s+|just\\s+|actually\\s+|really\\s+)?${UNDER18}\\b(?!\\s+(?:of|more|times|men|women|people|days|hours|minutes|miles|feet|leagues|paces|yards|steps))`),
  new RegExp(`\\bmy\\s+(?:real\\s+)?age\\s+is\\s+${UNDER18}\\b`),
  new RegExp(`\\bi\\s+(?:just\\s+)?turned\\s+${UNDER18}\\b`),
  /\b(?:i'?m|i\s+am|im)\s+(?:only\s+|just\s+|actually\s+|really\s+)?(?:a\s+)?(?:minor|under[\s-]?age|under\s+18|kid|child|teen|teenager|pre[\s-]?teen)\b/,
  /\b(?:i'?m|i\s+am|im)\s+(?:in|at)\s+(?:middle|high|grade|elementary)\s+school\b/,
  /\b(?:i'?m|i\s+am|im)\s+(?:in\s+)?(?:\d|1[0-2])(?:st|nd|rd|th)\s+grade\b/,
];

// Explicit sexual terms (block-worthy with an explicit under-18 indicator).
const EXPLICIT_SEXUAL = /\b(?:sex|sexy|sexual\w*|sexually|naked|nude|nudity|erotic\w*|porn\w*|explicit\w*|genital\w*|orgasm\w*|intercourse|molest\w*|fondl\w*|grop\w*|aroused|arousing|arousal|undress\w*|rape\w*|raping)\b/;
// Any romantic or sexual term — enough, with a minor indicator, to go to stage 2.
const ROMANTIC_OR_SEXUAL = /\b(?:love\s+(?:you|him|her)|in\s+love|fall(?:ing)?\s+for|crush\s+on|girlfriend|boyfriend|lover|lovers|romance|romantic\w*|flirt\w*|kiss\w*|cuddl\w*|caress\w*|embrac\w*|seduc\w*|sensual\w*|intimate\w*|intimacy|lust\w*|desir(?:e|es|ed|ing)\s+(?:him|her|them)|make\s+love|sleep\s+with|slept\s+with|bed\s+(?:him|her)|in\s+bed\s+with|take\s+(?:him|her)\s+to\s+bed|marry\s+me|be\s+my\s+(?:wife|husband|bride|girl|boy)|date\s+(?:me|him|her)|go\s+out\s+with|hold\s+my\s+hand|touch\s+(?:me|him|her)|body|bodies|attractive|beautiful|handsome|hot)\b/;

function norm(text) { return String(text).toLowerCase().replace(/[‘’]/g, "'"); }
const any = (res, t) => res.some(re => re.test(t));

// { stage1, autoBlock, minorSelfStatement }
//   stage1             — run stage 2 (or block outright when autoBlock)
//   autoBlock          — explicit sexual term + explicit under-18 indicator: block, no classifier
//   minorSelfStatement — the player said they are under 18 (with or without a romantic request)
export function childSafetyPrefilter(text) {
  const none = { stage1: false, autoBlock: false, minorSelfStatement: false };
  if (typeof text !== 'string' || !text.trim()) return none;
  const t = norm(text);
  const selfUnder18   = any(SELF_UNDER18, t);
  const ageUnder18    = any(AGE_UNDER18, t);
  const explicitMinor = ageUnder18 || selfUnder18 || EXPLICIT_MINOR_WORD.test(t);
  const anyMinor      = explicitMinor || ROLE_MINOR_WORD.test(t) || NAMED_MINOR.test(t);
  const explicitSex   = EXPLICIT_SEXUAL.test(t);
  const romanticOrSex = explicitSex || ROMANTIC_OR_SEXUAL.test(t);
  return {
    stage1: anyMinor && romanticOrSex,
    autoBlock: explicitMinor && explicitSex,
    minorSelfStatement: selfUnder18,
  };
}

// ── Stage 2 ───────────────────────────────────────────────────────────────────
const CLASSIFIER_SYSTEM = `You are a child-safety classifier for an interactive historical fiction game. Players type what their character says or does in scenes set in history.

Decide ONE thing: is this message soliciting or describing sexual or romantic content involving a minor? Answer true if ANY of these hold:
- it asks for, describes, or moves the story toward sexual or romantic content involving anyone under 18 — someone given an under-18 age, a child or teenager, someone referred to as a son, daughter, boy, girl, or child in a way that reads as a minor, or a named character who is a minor (for example Adeodatus, Augustine's teenage son);
- the player says they are under 18 and makes any romantic or sexual request or advance toward anyone.

Answer false for non-sexual, non-romantic references to children (asking about a son, grieving a child, a child's education or health, ordinary family affection such as a parent embracing a child), and for plain factual or historical references that do not ask for romantic or sexual content to be depicted (for example asking about Augustine's relationship with his concubine, or the historical fact of his betrothal). Romantic or sexual content between adults only is false.

If you are unsure, answer true.

Respond with ONLY a JSON object, exactly {"minor_sexual": true} or {"minor_sexual": false}. No other text.`;

// Returns { block: true|false } on a clean answer, or { error } (the caller fails closed).
export async function classifyChildSafety(text, { apiKey, timeoutMs = 8000, onUsage = null, fetchImpl = globalThis.fetch } = {}) {
  try {
    const resp = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CHILD_SAFETY_CLASSIFIER_MODEL,
        max_tokens: 20,
        temperature: 0,
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: `Player's typed message:\n"""\n${text}\n"""` }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return { error: `classifier HTTP ${resp.status}` };
    const data = await resp.json();
    if (onUsage && data?.usage) { try { onUsage(CHILD_SAFETY_CLASSIFIER_MODEL, data.usage); } catch {} }
    const raw = (data?.content?.[0]?.text || '').trim();
    const m = raw.match(/\{[^{}]*\}/);
    let parsed = null;
    try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
    if (!parsed || typeof parsed.minor_sexual !== 'boolean') return { error: `classifier answered ${JSON.stringify(raw.slice(0, 80))}` };
    return { block: parsed.minor_sexual };
  } catch (e) {
    return { error: `classifier ${e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out' : 'threw'}: ${e.message}` };
  }
}

// Both stages. `block` true means: refuse, do not run a story turn.
//   stage2: 'skipped' (stage 1 clean) | 'auto' (blocked without a classifier call)
//           | 'block' | 'clear' | 'error' (failed closed)
export async function checkChildSafety(text, opts = {}) {
  const pre = childSafetyPrefilter(text);
  const base = { stage1: pre.stage1, minorSelfStatement: pre.minorSelfStatement };
  if (pre.autoBlock) return { ...base, stage1: true, block: true, stage2: 'auto' };
  if (!pre.stage1) return { ...base, block: false, stage2: 'skipped' };
  const r = await classifyChildSafety(text, opts);
  if (r.error) return { ...base, block: true, stage2: 'error', error: r.error };
  return { ...base, block: r.block, stage2: r.block ? 'block' : 'clear' };
}
