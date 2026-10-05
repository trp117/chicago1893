// NARRATIVE SALVAGE — keep the model's JSON off the player's screen.
//
// Two shapes reach the player as raw JSON today:
//   A. BROKEN JSON on a closing turn. At remaining <= 0 an unparseable end_turn reply is coerced
//      into an ending payload with narrative = the whole raw text (the CLOSING COERCE path) — on
//      the assumption that the model wrote closing prose. When it actually wrote (malformed) JSON,
//      the player read `{"narrative":"…","npcMoments":…`. Live on prod 2026-10-05: a grace turn
//      whose reply dropped `"npcMoments":[` after the narrative string. Grace turns start at
//      remaining 0, so every one of them goes through that path when the JSON breaks.
//   B. NESTED JSON: a parseable reply whose `narrative` field is itself the model's whole JSON
//      reply, as a string.
//
// Both are repaired from the model's own text: the real narrative is the `"narrative"` string
// literal inside it. Gated on the text looking like a JSON reply — prose (which never opens with
// `{"`) and a normal narrative are returned untouched, so every well-formed turn is byte-identical.

const JSON_REPLY_START = /^\s*(?:```(?:json)?\s*)?\{\s*"/i;
const NARRATIVE_LITERAL = /"narrative"\s*:\s*"((?:[^"\\]|\\.)*)"/;

// Does this text open the way the model's JSON reply opens?
export function looksLikeJsonReply(text) {
  return typeof text === 'string' && JSON_REPLY_START.test(text);
}

// The unescaped value of the first complete "narrative" string literal in a JSON-shaped text, or
// null — for prose, for text with no narrative literal, or when the literal is empty.
export function salvageNarrative(text) {
  if (typeof text !== 'string' || !text.includes('"narrative"')) return null;
  const m = text.match(NARRATIVE_LITERAL);
  if (!m) return null;
  let value;
  try { value = JSON.parse(`"${m[1]}"`); } catch { return null; }
  value = value.trim();
  return value ? value : null;
}

// Shape B, in place. When output.narrative is itself a JSON reply: if it parses to an object with
// a string narrative, that inner reply is the real one and its fields win (the outer object's
// other keys are kept where the inner one has none); otherwise just its narrative literal is
// salvaged. Returns 'object' | 'narrative' when it repaired something, null when output was left
// exactly as it was.
export function unnestNarrative(output) {
  const n = output?.narrative;
  if (!looksLikeJsonReply(n) || !n.includes('"narrative"')) return null;
  const body = n.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let inner = null;
  try { inner = JSON.parse(body); } catch { inner = null; }
  if (inner && typeof inner === 'object' && !Array.isArray(inner) && typeof inner.narrative === 'string' && inner.narrative.trim()) {
    // A doubly-nested reply unwraps all the way down.
    unnestNarrative(inner);
    Object.assign(output, inner);
    return 'object';
  }
  const salvaged = salvageNarrative(n);
  if (!salvaged) return null;
  output.narrative = salvaged;
  return 'narrative';
}
