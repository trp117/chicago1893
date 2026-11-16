// Input-safety gate — engine-wide, always on, typed free-form input only (never a choice).
// Runs on /turn before anything reads or changes the turn. Four checks:
//
//   self-harm         (CrisisIntercept.js)  → 'care'    — the fixed care message (988)
//   victim disclosure (Disclosure.js)       → 'care'    — the fixed disclosure care message
//   child safety      (ChildSafety.js)      → 'refusal' — the fixed out-of-character refusal
//   sexual violence   (SexualViolence.js)   → 'refusal' — its own fixed refusal, same card
//
// Nothing else is intercepted here: adult sexual content, hate, non-sexual violence and
// illicit-info requests pass straight through to the story model, which deflects them in-frame.
//
// Every stage-1 filter runs on every typed input; a classifier is only called for a check whose
// filter matched, and those calls run in parallel. Precedence:
//   1. self-harm care (988) — a person who may be in danger;
//   2. a pure disclosure → disclosure care. "Pure" means the child-safety and sexual-violence
//      classifiers did not judge it a request to depict (their clean 'block' verdict); a message
//      that is both a disclosure and a request to depict is a request, and is refused;
//   3. child safety, then sexual violence → refusal.
import { checkCrisis, CARE_MESSAGE } from './CrisisIntercept.js';
import { checkChildSafety, CHILD_SAFETY_REFUSAL, MINOR_SELF_STATEMENT_NOTE } from './ChildSafety.js';
import { checkSexualViolence, SEXUAL_VIOLENCE_REFUSAL } from './SexualViolence.js';
import { checkDisclosure, DISCLOSURE_CARE_MESSAGE } from './Disclosure.js';

export { CARE_MESSAGE, DISCLOSURE_CARE_MESSAGE, CHILD_SAFETY_REFUSAL, SEXUAL_VIOLENCE_REFUSAL, MINOR_SELF_STATEMENT_NOTE };

// → { action: 'care' | 'refusal' | 'pass', kind?, category?, message?, minorSelfStatement, crisis, disclosure, child, sexualViolence }
export async function checkInputSafety(text, opts = {}) {
  const [crisis, disclosure, child, sexualViolence] = await Promise.all([
    checkCrisis(text, opts), checkDisclosure(text, opts), checkChildSafety(text, opts), checkSexualViolence(text, opts),
  ]);
  const minorSelfStatement = !!child.minorSelfStatement;
  const base = { minorSelfStatement, crisis, disclosure, child, sexualViolence };
  const requestToDepict = child.stage2 === 'block' || sexualViolence.stage2 === 'block';
  if (crisis.intercept)                         return { ...base, action: 'care',    kind: 'care',    category: 'self-harm',       message: CARE_MESSAGE };
  if (disclosure.confirmed && !requestToDepict) return { ...base, action: 'care',    kind: 'care',    category: 'disclosure',      message: DISCLOSURE_CARE_MESSAGE };
  if (child.block)                              return { ...base, action: 'refusal', kind: 'refusal', category: 'child-safety',    message: CHILD_SAFETY_REFUSAL };
  if (sexualViolence.block)                     return { ...base, action: 'refusal', kind: 'refusal', category: 'sexual-violence', message: SEXUAL_VIOLENCE_REFUSAL };
  return { ...base, action: 'pass' };
}
