// Crisis interception — engine-wide, always on.
//
// A player's TYPED input that expresses real self-harm or suicidal intent must never be absorbed
// into the story (where a character may deny or dramatise the risk). It is caught before the
// turn prompt is composed and answered with a fixed, out-of-character care message instead of a
// story turn. Applies only to free-form input — never to a pre-authored choice.
//
// Two stages, so the death and martyrdom language these scenarios are full of does not trigger:
//   1. crisisPrefilter — a cheap regex over the raw text. Deliberately over-matches; it only
//      decides whether stage 2 runs. Benign input never costs a model call.
//   2. classifyCrisis  — one small Haiku call (temperature 0, strict JSON {"crisis": bool}) that
//      decides whether the message is the PLAYER'S OWN present, real-world intent, as opposed to
//      in-character roleplay, historical or religious references to death, or a question about a
//      character's death.
// Fail-closed: if stage 2 errors, times out, or answers anything but a clean boolean, the care
// response is shown — stage 1 has already matched concerning language.

export const CRISIS_CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// The fixed care message. Static — never model-generated. No assessment questions, no methods,
// no confidentiality promises.
export const CARE_MESSAGE = [
  'It sounds like you may be carrying something painful and real. This is a story, but I’m not going to play past that.',
  'If you’re thinking about harming yourself or ending your life, please reach out to someone who can help right now. In the US, you can call or text 988 — the Suicide and Crisis Lifeline — any time, day or night. If you’re outside the US, your local emergency number or a trusted person near you is a good place to start.',
  'You matter, and you don’t have to carry this alone. When you’re ready, the story will still be here.',
].join('\n\n');

// Stage 1. Curly apostrophes are folded to straight ones first; matching is case-insensitive.
// Over-matching is fine (stage 2 sorts it out); missing a real phrasing is not.
export const CRISIS_PATTERNS = [
  /\bkill(?:s|ed|ing)?\s+my\s*self\b/,
  /\bkms\b/,
  /\b(?:end|ending|take|taking)\s+(?:my\s+(?:own\s+)?life|it\s+all)\b/,
  /\bsuicid\w*/,
  // "ready to die" is deliberately absent: it is the commonest martyrdom phrasing in these
  // scenarios ("ready to die for my faith"), not a crisis phrasing.
  /\b(?:want|wanna|wanted|going|gonna|trying|try)\s+(?:to\s+)?die\b/,
  /\bwish\s+i\s+(?:was|were|had\s+been)\s+dead\b/,
  /\bwish\s+i\s+(?:had\s+)?never\s+(?:been\s+born|existed)\b/,
  /\bbetter\s+off\s+dead\b/,
  /\bbetter\s+off\s+without\s+me\b/,
  /\b(?:hurt|harm|cut|injure)(?:ing)?\s+my\s*self\b/,
  /\bself[\s-]?harm\w*/,
  /\bno\s+(?:reason|point|purpose)\s+(?:to|in)\s+(?:live|living|go\s+on|going\s+on|being\s+alive)\b/,
  /\bnot\s+worth\s+living\b/,
  /\b(?:don'?t|do\s+not|no\s+longer)\s+want\s+to\s+(?:live|be\s+alive|exist|be\s+here)\b/,
  /\bcan'?t\s+(?:go\s+on|take\s+(?:it|this)\s+any\s*more)\b/,
  /\boverdose\b/,
  /\bend\s+(?:it|things)\s+(?:all\s+)?(?:now|tonight|today)\b/,
];
export function crisisPrefilter(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const t = text.toLowerCase().replace(/[‘’]/g, "'");
  return CRISIS_PATTERNS.some(re => re.test(t));
}

const CLASSIFIER_SYSTEM = `You are a safety classifier for an interactive historical fiction game. Players type what their character says or does, in scenes set in history (wars, sieges, saints' lives, conversions, martyrdoms). Death, dying, martyrdom, sacrifice, and religious language about dying to sin or to the old self are common and legitimate there — for example "I am ready to die for my faith", "I would rather die than surrender", "the old man in me must die", "tell me how he died".

Decide ONE thing: does the message express the PLAYER'S OWN present, real-world intent or wish to harm themselves or end their life — including first-person hopelessness about their own life such as "there's no point in living" or "I'd be better off dead"?

Answer true when the message reads as the real person speaking about themselves and their own life now, including when it is phrased in the first person without a clear historical or in-story frame.
Answer false for in-character roleplay of the historical figure, religious or historical references to death or martyrdom, willingness to die for a cause inside the story, or questions about a character's death.

Respond with ONLY a JSON object, exactly {"crisis": true} or {"crisis": false}. No other text.`;

// Stage 2. Returns { crisis: true|false } on a clean answer, or { error } when the call failed or
// the answer was not a clean boolean (the caller fails closed). `onUsage` receives the API usage
// block so a spend meter can count the call.
export async function classifyCrisis(text, { apiKey, timeoutMs = 8000, onUsage = null, fetchImpl = globalThis.fetch } = {}) {
  try {
    const resp = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CRISIS_CLASSIFIER_MODEL,
        max_tokens: 20,
        temperature: 0,
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: `Player's typed message:\n"""\n${text}\n"""` }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return { error: `classifier HTTP ${resp.status}` };
    const data = await resp.json();
    if (onUsage && data?.usage) { try { onUsage(CRISIS_CLASSIFIER_MODEL, data.usage); } catch {} }
    const raw = (data?.content?.[0]?.text || '').trim();
    const m = raw.match(/\{[^{}]*\}/);
    let parsed = null;
    try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
    if (!parsed || typeof parsed.crisis !== 'boolean') return { error: `classifier answered ${JSON.stringify(raw.slice(0, 80))}` };
    return { crisis: parsed.crisis };
  } catch (e) {
    return { error: `classifier ${e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out' : 'threw'}: ${e.message}` };
  }
}

// Both stages. `intercept` true means: show the care response, do not run a story turn.
//   stage2: 'skipped' (stage 1 clean) | 'crisis' | 'clear' | 'error' (failed closed)
export async function checkCrisis(text, opts = {}) {
  if (!crisisPrefilter(text)) return { intercept: false, stage1: false, stage2: 'skipped' };
  const r = await classifyCrisis(text, opts);
  if (r.error) return { intercept: true, stage1: true, stage2: 'error', error: r.error };
  return { intercept: r.crisis, stage1: true, stage2: r.crisis ? 'crisis' : 'clear' };
}
