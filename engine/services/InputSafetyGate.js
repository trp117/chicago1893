// Input-safety gate — engine-wide, always on, typed free-form input only (never a choice).
// Runs on /turn before anything reads or changes the turn. Exactly TWO categories:
//
//   self-harm     (CrisisIntercept.js) → 'care'    — the fixed care message (988)
//   child safety  (ChildSafety.js)     → 'refusal' — the fixed out-of-character refusal
//
// Nothing else is intercepted here: adult sexual content, hate, violence and illicit-info
// requests pass straight through to the story model, which deflects them inside the story.
//
// Both stage-1 filters run on every typed input; a classifier is only called for a category whose
// filter matched, and the two calls run in parallel. If both categories fire, care wins: a person
// who may be in danger gets the 988 message.
import { checkCrisis, CARE_MESSAGE } from './CrisisIntercept.js';
import { checkChildSafety, CHILD_SAFETY_REFUSAL, MINOR_SELF_STATEMENT_NOTE } from './ChildSafety.js';

export { CARE_MESSAGE, CHILD_SAFETY_REFUSAL, MINOR_SELF_STATEMENT_NOTE };

// → { action: 'care' | 'refusal' | 'pass', message?, minorSelfStatement, crisis, child }
export async function checkInputSafety(text, opts = {}) {
  const [crisis, child] = await Promise.all([checkCrisis(text, opts), checkChildSafety(text, opts)]);
  const minorSelfStatement = !!child.minorSelfStatement;
  if (crisis.intercept) return { action: 'care', kind: 'care', message: CARE_MESSAGE, minorSelfStatement, crisis, child };
  if (child.block) return { action: 'refusal', kind: 'refusal', message: CHILD_SAFETY_REFUSAL, minorSelfStatement, crisis, child };
  return { action: 'pass', minorSelfStatement, crisis, child };
}
