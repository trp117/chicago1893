// Input-safety gate — engine-wide, always on, typed free-form input only (never a choice).
// Runs on /turn before anything reads or changes the turn. Exactly THREE categories:
//
//   self-harm         (CrisisIntercept.js)  → 'care'    — the fixed care message (988)
//   child safety      (ChildSafety.js)      → 'refusal' — the fixed out-of-character refusal
//   sexual violence   (SexualViolence.js)   → 'refusal' — its own fixed refusal, same card
//
// Nothing else is intercepted here: adult sexual content, hate, non-sexual violence and
// illicit-info requests pass straight through to the story model, which deflects them in-frame.
//
// Every stage-1 filter runs on every typed input; a classifier is only called for a category
// whose filter matched, and those calls run in parallel. Precedence when more than one fires:
// care first (a person who may be in danger gets 988), then child safety, then sexual violence.
import { checkCrisis, CARE_MESSAGE } from './CrisisIntercept.js';
import { checkChildSafety, CHILD_SAFETY_REFUSAL, MINOR_SELF_STATEMENT_NOTE } from './ChildSafety.js';
import { checkSexualViolence, SEXUAL_VIOLENCE_REFUSAL } from './SexualViolence.js';

export { CARE_MESSAGE, CHILD_SAFETY_REFUSAL, SEXUAL_VIOLENCE_REFUSAL, MINOR_SELF_STATEMENT_NOTE };

// → { action: 'care' | 'refusal' | 'pass', kind?, category?, message?, minorSelfStatement, crisis, child, sexualViolence }
export async function checkInputSafety(text, opts = {}) {
  const [crisis, child, sexualViolence] = await Promise.all([
    checkCrisis(text, opts), checkChildSafety(text, opts), checkSexualViolence(text, opts),
  ]);
  const minorSelfStatement = !!child.minorSelfStatement;
  const base = { minorSelfStatement, crisis, child, sexualViolence };
  if (crisis.intercept)     return { ...base, action: 'care',    kind: 'care',    category: 'self-harm',       message: CARE_MESSAGE };
  if (child.block)          return { ...base, action: 'refusal', kind: 'refusal', category: 'child-safety',    message: CHILD_SAFETY_REFUSAL };
  if (sexualViolence.block) return { ...base, action: 'refusal', kind: 'refusal', category: 'sexual-violence', message: SEXUAL_VIOLENCE_REFUSAL };
  return { ...base, action: 'pass' };
}
