// First-person victim disclosure — fourth check of the input-safety gate (InputSafetyGate.js).
//
// A player saying that THEY were abused or assaulted ("I was raped", "my uncle molested me when I
// was nine", "someone did this to me when I was…") is a disclosure, not a request for content. It
// must never get a hard-refusal card, and it must not go to the story model either: played in
// character, a disclosure was denied ("That is not what happened to you"), overwritten, called out
// of its century, or ignored (story-model test, 2026-11-15). So a confirmed disclosure gets a
// fixed, out-of-character care message (DISCLOSURE_CARE_MESSAGE), like the self-harm path.
//
// Two stages:
//   1. victimDisclosure — regex for first-person victimization markers. Over-matches on purpose.
//      It is also read by the child-safety and sexual-violence categories: when it matches they
//      never block outright on their regex, they defer to their classifier.
//   2. classifyDisclosure — one Haiku call (temperature 0, strict JSON {"disclosure": bool}): true
//      only for the player's own disclosure of abuse or assault that does NOT also ask for it to be
//      depicted. Error, timeout or a non-boolean answer counts as a disclosure (fail toward care).
// A message that is a disclosure AND a request to depict is a request: the gate refuses it.

export const DISCLOSURE_CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// The fixed care message. Static — never model-generated, never echoes the player's input.
export const DISCLOSURE_CARE_MESSAGE = [
  "What you've shared is real and it matters, and what happened to you was not your fault. This is a story, but I'm not going to move past that.",
  "If you'd like to talk with someone, there are people ready to listen, any time:\n- RAINN, the National Sexual Assault Hotline — call 800-656-4673\n- Childhelp, for abuse in childhood — call or text 1-800-422-4453",
  "When you're ready, the story will still be here.",
].join('\n\n');

// ── Stage 1 ───────────────────────────────────────────────────────────────────
const VICTIM_VERB = '(?:rap(?:ed)|abused|molested|assaulted|attacked|violated|forced|touched|groped|fondled|hurt|groomed|trafficked|beaten|interfered\\s+with|taken\\s+advantage\\s+of)';

const DISCLOSURE = [
  // "I was raped", "I was sexually abused", "I got groped", "I had been molested for years"
  new RegExp(`\\bi\\s+(?:was|got|had\\s+been|have\\s+been|was\\s+being|used\\s+to\\s+be)\\s+(?:\\w+\\s+){0,2}?${VICTIM_VERB}\\b`),
  // "I've been abused"
  new RegExp(`\\bi'?ve\\s+been\\s+(?:\\w+\\s+){0,2}?${VICTIM_VERB}\\b`),
  // "a man hurt me", "my uncle molested me", "someone abused me", "my father used to beat me"
  new RegExp(`\\b(?:someone|somebody|a\\s+\\w+|an\\s+\\w+|my\\s+\\w+|his\\s+\\w+|her\\s+\\w+|he|she|they|people|men|the\\s+\\w+)\\s+(?:\\w+\\s+){0,2}?(?:raped|abused|molested|assaulted|attacked|violated|forced|touched|groped|fondled|hurt|groomed|beat|interfered\\s+with|took\\s+advantage\\s+of)\\s+me\\b`),
  // "someone did this to me", "it happened to me"
  /\b(?:did|done)\s+(?:this|that|it|things|something)\s+to\s+me\b/,
  /\b(?:it|this|that|abuse|rape|assault|what\s+happened)\s+happened\s+to\s+me\b/,
  // "I'm a survivor", "I am a victim of…"
  /\b(?:i'?m|i\s+am)\s+a\s+(?:survivor|victim)\b/,
];

export function victimDisclosure(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const t = text.toLowerCase().replace(/[‘’]/g, "'");
  return DISCLOSURE.some(re => re.test(t));
}

// The sentence the child-safety and sexual-violence classifiers carry, so a disclosure is never
// read by them as a request — and a request to depict always is.
export const DISCLOSURE_CLASSIFIER_RULE = 'A player disclosing that they themselves were abused or sexually assaulted — at any age, including as a child ("I was raped", "I was abused as a child", "when I was twelve a man hurt me") — is a disclosure, not a request: answer false. Answer true only if the same message ALSO asks for the abuse or assault to be depicted, described, or played out.';

// ── Stage 2 ───────────────────────────────────────────────────────────────────
const CLASSIFIER_SYSTEM = `You are a disclosure classifier for an interactive historical fiction game. Players type what their character says or does in scenes set in history (wars, sieges, saints' lives, conversions).

Decide ONE thing: is this message the player disclosing that they themselves were sexually abused, sexually assaulted, raped, molested, or abused as a child — and NOT also asking for it to be depicted?

Answer true when the message reads as a person telling of abuse or assault done to them, at any age, including as a child ("I was raped", "I was abused as a child", "when I was twelve a man hurt me", "my uncle molested me when I was nine"), and asks for nothing to be depicted.

Answer false when:
- the same message also asks for the abuse or assault to be described, depicted, shown, or played out (that is a request, not a disclosure);
- the hurt is an ordinary in-story event with no abuse — a battle wound, a surgery, a fall, a fight ("I was wounded at Pamplona and the surgeon hurt me", "I was attacked by the French");
- it recalls the historical character's documented life within the story rather than abuse (Augustine recalling being beaten by his schoolmasters for neglecting his lessons);
- it is about someone else, or a question.

If you are unsure whether it is a real disclosure of abuse or assault, answer true.

Respond with ONLY a JSON object, exactly {"disclosure": true} or {"disclosure": false}. No other text.`;

// Returns { disclosure: true|false } on a clean answer, or { error }.
export async function classifyDisclosure(text, { apiKey, timeoutMs = 8000, onUsage = null, fetchImpl = globalThis.fetch } = {}) {
  try {
    const resp = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: DISCLOSURE_CLASSIFIER_MODEL,
        max_tokens: 20,
        temperature: 0,
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: `Player's typed message:\n"""\n${text}\n"""` }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return { error: `classifier HTTP ${resp.status}` };
    const data = await resp.json();
    if (onUsage && data?.usage) { try { onUsage(DISCLOSURE_CLASSIFIER_MODEL, data.usage); } catch {} }
    const raw = (data?.content?.[0]?.text || '').trim();
    const m = raw.match(/\{[^{}]*\}/);
    let parsed = null;
    try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
    if (!parsed || typeof parsed.disclosure !== 'boolean') return { error: `classifier answered ${JSON.stringify(raw.slice(0, 80))}` };
    return { disclosure: parsed.disclosure };
  } catch (e) {
    return { error: `classifier ${e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out' : 'threw'}: ${e.message}` };
  }
}

// Both stages. `confirmed` true means: a disclosure (subject to the gate's request-to-depict check).
//   stage2: 'skipped' (stage 1 clean) | 'disclosure' | 'clear' | 'error' (counted as a disclosure)
export async function checkDisclosure(text, opts = {}) {
  if (!victimDisclosure(text)) return { stage1: false, confirmed: false, stage2: 'skipped' };
  const r = await classifyDisclosure(text, opts);
  if (r.error) return { stage1: true, confirmed: true, stage2: 'error', error: r.error };
  return { stage1: true, confirmed: r.disclosure, stage2: r.disclosure ? 'disclosure' : 'clear' };
}
