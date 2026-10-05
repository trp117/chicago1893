// SESSION TERMINATION — the grace margin.
//
// A session PACES to its soft target (scenario.sessionTargetMinutes): scene budgets, nudges, the
// fork's fallback fraction, arc position and the "time remaining" the model sees are all computed
// against the target, and remainingMinutes stays floored at 0 when the target is reached. None of
// that machinery imports this module or knows the ceiling below — if pacing ever saw the ceiling,
// the story would spread to fill it and the squeeze would just move to a bigger number.
//
// This module is consulted ONLY at the target line, after a turn that reached it without ending:
// if the session's crucible is still in progress there — the player answered the fork on that very
// turn (the consequence has not played), or the fork was put and is still unanswered — the session
// gets ONE more turn to finish it, provided that turn fits under the ceiling. Grace is latched
// (granted once per session), and the grace turn always closes: it is the existing FINAL TURN
// (remainingMinutes is 0) carrying the decision hold, and the engine forces isEnding if the model
// does not set it. A session with no fork, or whose crucible finished before the target, never
// gets grace and never carries the graceActive/graceUsed keys — its state is byte-identical.
//
// Every use is logged ([GRACE]) and written to the transcript as a DIAG line: frequent use means
// the crucible is arriving late, which is a pacing bug to fix, not a normal way to end.

import { evaluateDefiningMoment } from './PromptComposer.js';

export const GRACE_CEILING_FACTOR = 1.2;

export function graceCeilingMinutes(scenario) {
  return Math.round((scenario?.sessionTargetMinutes || 15) * GRACE_CEILING_FACTOR);
}

// Why the crucible is still in progress at the target, or null when it is not.
//  - decision_just_recorded: the player answered the fork on the turn that reached the target, so
//    its consequence has not played. The grace turn plays it and closes.
//  - fork_unanswered: the fork was put on the turn that reached the target, so its options are on
//    the player's screen. The grace turn is the answer turn: FINAL TURN + the decision hold plays
//    the choice and closes. Only THIS turn's fork counts — a fork put earlier and answered with
//    free text is latched as asked and never re-presented, so grace could not finish it.
//    (Every stored fork costs 0 minutes, so today this needs a fork authored with time_advance > 0.)
function crucibleInProgress(nextState, scenario, decisionRecordedThisTurn, forkPresentedThisTurn) {
  if (decisionRecordedThisTurn) return 'decision_just_recorded';
  if (forkPresentedThisTurn && !evaluateDefiningMoment(nextState, scenario).met) return 'fork_unanswered';
  return null;
}

// Called once per turn, after mergeState and after the fork is put, on the turn's nextState.
// Grants the grace turn when it applies (sets graceActive + the graceUsed latch) and returns a
// description of the grant, or null — in which case nextState is not touched.
export function grantGrace(nextState, scenario, { decisionRecordedThisTurn = false, forkPresentedThisTurn = false, isEnding = false } = {}) {
  if (isEnding || (nextState?.remainingMinutes ?? 1) > 0 || nextState.graceUsed) return null;
  const reason = crucibleInProgress(nextState, scenario, decisionRecordedThisTurn, forkPresentedThisTurn);
  if (!reason) return null;
  const target  = scenario?.sessionTargetMinutes || 15;
  const ceiling = graceCeilingMinutes(scenario);
  const tpt     = scenario?.systems?.timePerTurnDefault;
  const turnMin = typeof tpt === 'number' && Number.isFinite(tpt) && tpt > 0 ? tpt : 3;
  const elapsed = nextState.elapsedMinutes ?? 0;
  if (elapsed + turnMin > ceiling) {
    console.log(`[GRACE] refused — ${reason} at ${elapsed} min, but one more turn (~${turnMin} min) passes the ceiling ${ceiling}; closing at target ${target}`);
    return null;
  }
  nextState.graceActive = true;
  nextState.graceUsed   = true;
  const grant = { reason, elapsed, target, ceiling };
  console.log(`[GRACE] used — ${reason} at ${elapsed} min (target ${target}, ceiling ${ceiling}): one closing turn past the target`);
  return grant;
}

// Called on the grace turn itself (the turn whose incoming state carries graceActive). The
// grace turn always closes: isEnding is forced if the model did not set it, and graceActive is
// cleared so nothing reads the session as still in grace. Returns 'model' | 'forced', or null
// when this is not a grace turn.
export function closeGraceTurn(state, nextState, output) {
  if (!state?.graceActive) return null;
  delete nextState.graceActive;
  const by = output.endState?.isEnding ? 'model' : 'forced';
  if (by === 'forced') output.endState = { ...(output.endState || {}), isEnding: true, outcome: output.endState?.outcome || 'session_complete' };
  console.log(`[GRACE] closing turn — ended at ${nextState.elapsedMinutes} min, isEnding by ${by}`);
  return by;
}

export function graceDiagLine(prefix, { grant = null, closedBy = null, nextState = null, scenario = null } = {}) {
  if (grant) return `${prefix}grace: USED — ${grant.reason} at ${grant.elapsed} min (target ${grant.target}, ceiling ${grant.ceiling}); one closing turn granted`;
  if (closedBy) return `${prefix}grace: closing turn — ended at ${nextState?.elapsedMinutes} min (target ${scenario?.sessionTargetMinutes || 15}, ceiling ${graceCeilingMinutes(scenario)}), isEnding by ${closedBy}`;
  return null;
}
