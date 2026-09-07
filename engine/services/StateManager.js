import { getClueById, getAvailableCluesAt, closureShouldClose, resolveDefiningMomentBlock, evaluateDefiningMoment } from './PromptComposer.js';

// When an anchor's wall OPENS, as a fraction of the session, for a role that does not say.
//
// 0.0 — the wall is up from the first turn — and the alternative was min(fork_fraction, 0.70).
// That alternative was rejected on evidence, not taste: McCord's fork fires at 0.6, so
// min(0.6, 0.70) = 0.6 would still leave the first eighteen minutes of a thirty-minute
// session wide open, and the bug this exists to fix is a session in which the prose walked
// him into the stairwell at minute six. A default that cannot close the reported bug is not
// a default worth having.
//
// The deeper reason is what the field MEANS. anchored_location is opt-in by presence: an
// author who writes one has asserted "the record fixes this person to this place." Absent a
// stated time, the honest reading of that assertion is the whole session, not its last
// third. A role that genuinely moved before its fixed event is the case that needs authoring
// — and it gets `enforce_from`, which is exactly what that parameter is for.
//
// The two failure directions are not symmetrical, and that settles it. Defaulting EARLY can
// over-constrain a role that should have roamed: visible on the first playthrough, and
// corrected by setting one number. Defaulting LATE reproduces the original bug: invisible
// until an epilogue describes an arrest in a room the prose never staged it in. Prefer the
// failure you can see.
export const ANCHOR_ENFORCE_FROM_DEFAULT = 0.0;

function normalizeEnforceFrom(raw, roleId) {
  const v = raw?.enforce_from;
  // Absent is the common case and is not a warning. The admin form posts every field as a
  // trimmed STRING, so '0.6' has to coerce as readily as 0.6 does.
  if (v === undefined || v === null || v === '') return ANCHOR_ENFORCE_FROM_DEFAULT;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    console.warn(`[ANCHOR] role ${roleId} has enforce_from ${JSON.stringify(v)} outside 0.0–1.0 — using default ${ANCHOR_ENFORCE_FROM_DEFAULT}.`);
    return ANCHOR_ENFORCE_FROM_DEFAULT;
  }
  return n;
}

// The role's ANCHORED LOCATION, normalized. OPT-IN BY PRESENCE: a role that authors no
// `anchored_location` returns null, and every downstream reader then compiles exactly what
// it compiled before. Deliberately NOT derived — not from `fate_mode`, and not from
// `startLocationId` even though all 80 stored roles carry one. 8 of the 9 fork-carrying
// roles declare fate_mode 'anchored', Frank Wills among them, and the record has Wills
// moving between the stairwell, the garage-level door and the security desk all night.
// Binding him to the room he happened to start in would contradict the record this exists
// to protect. The start location is the right DEFAULT to OFFER an author in the editor; it
// is the wrong thing to INFER.
//
// `enforce_from` is the per-role wall timing, the sibling of defining_moment's
// `at_elapsed_fraction` and read the same way: a fraction of sessionTargetMinutes. It is
// what lets a role who genuinely MOVED before their fixed event stay mobile until they
// didn't — set it to the fraction at which the record has them arrive. See
// ANCHOR_ENFORCE_FROM_DEFAULT above for why an unstated one means "from the first turn".
//
// VALIDATED against the scenario's own locations. An id no location carries is treated as
// absent and logged, because the roster-narrowing reader downstream would otherwise hand
// the model a destination list containing an id that does not resolve — a worse failure
// than the one this fixes.
//
// `reviewed` rides along rather than gating, the same convention scenario-level
// anchored_outcome uses (gameRouter.js buildEpilogueSummary): framing may run on an
// unconfirmed anchor, since the cost of being wrong is one misplaced scene. Any future
// ENFORCEMENT gate must require reviewed === true.
export function resolveAnchoredLocation(role, locations = []) {
  const raw = role?.anchored_location;
  const id  = typeof raw?.location_id === 'string' ? raw.location_id.trim() : '';
  if (!id) return null;
  if (Array.isArray(locations) && locations.length && !locations.some(l => l && l.id === id)) {
    console.warn(`[ANCHOR] role ${role?.id} names anchored_location "${id}", which is not a location in this scenario — ignoring.`);
    return null;
  }
  return {
    location_id:  id,
    enforce_from: normalizeEnforceFrom(raw, role?.id),
    reviewed:     raw.reviewed === true,
    rationale:    typeof raw.rationale === 'string' ? raw.rationale.trim() : '',
  };
}

export function buildInitialState(scenario, role, locations) {
  const scales      = scenario.systems?.scales || {};
  const startLoc    = role.startLocationId || role.startLocation || (locations[0]?.id ?? 'start');
  const startLocData = locations.find(l => l.id === startLoc);
  const linkedChars = startLocData?.linkedCharacterIds || startLocData?.linkedNPCs || [];
  const anchoredLocation = resolveAnchoredLocation(role, locations);

  return {
    scenarioId:              scenario.id,
    playerRoleId:            role.id,
    playerCharacterId:       role.character_id || null,
    playerRoleName:          role.name,
    playerRealName:          role.real_name    || null,
    playerCoverName:         role.cover_name   || null,
    playerAliasNote:         role.identity_note || role.alias_note || null,
    playerAliases:           role.aliases      || [],
    playerKnownAs:           role.known_as     || null,
    playerPerspective:       role.perspective || '',
    playerAccessLevel:       role.accessLevel || 'staff',
    playerStartingKnowledge: role.startingKnowledge || [],
    location:                startLoc,
    visitedLocations:        [startLoc],
    elapsedMinutes:          0,
    remainingMinutes:        scenario.sessionTargetMinutes || 15,
    act:                     1,
    threat:                  scales.threat?.default ?? 1,
    authorityTrust:          scales.authorityTrust?.default ?? 1,
    discoveredClueIds:       [],
    introducedNpcs:          linkedChars.filter(id => id !== role.character_id),
    targetNpc:               null,
    suspicion:               { ...(role.roleInitialState?.suspicion || {}) },
    flags:                   { ...(role.roleInitialState?.flags || {}) },
    inventory:               (role.roleInitialState?.inventory || []).map(item =>
      typeof item === 'string'
        ? { object_name: item, holder: 'player', status: 'in_play', turn: 0 }
        : item
    ),
    resolved_threads:        [],
    namedConspirators:       [],
    escapedNpcs:             [],
    physicalConflicts:       [],
    chaseState:              null,
    closureFired:            false,
    // Per-role closure resolved ONCE here (role IS known). Carried on state so the
    // downstream evaluators (mergeState, composeTurnPrompt) — which have no roles
    // array — get the playing role's block without any role plumbing. Falls back to
    // the scenario-level default when the role defines no override.
    effectiveClosure:        role.closure ?? scenario.closure ?? null,
    // True provenance of effectiveClosure — the fallback collapses role vs scenario,
    // so record which one actually supplied the block for honest closure_state reporting.
    effectiveClosureSource:  role.closure ? 'role' : (scenario.closure ? 'scenario' : 'none'),
    // Per-role defining moment resolved ONCE here, for the same reason and by the
    // same rule as effectiveClosure above: role beats scenario, and the downstream
    // evaluators have no role in scope. NOT gated on DEFINING_MOMENT_ENABLED —
    // resolution is inert data; the flag gates the evaluator (Step 3), exactly as
    // CLOSURE_BEATS_ENABLED gates evaluateClosure and not this assignment.
    effectiveDefiningMoment:       role.defining_moment ?? scenario.defining_moment ?? null,
    // True provenance — the fallback collapses role vs scenario, same as closure.
    effectiveDefiningMomentSource: role.defining_moment ? 'role' : (scenario.defining_moment ? 'scenario' : 'none'),
    // Decisions recorded this session, keyed by defining-moment id; the value is the
    // chosen option id (see evaluateDefiningMoment's read contract). Initialized to {}
    // so new sessions carry a real object rather than undefined. Sessions created
    // before this change have no such field and keep working — every reader
    // optional-chains through it.
    decisions:               {},
    // Presentation latch for the defining moment, in the mould of closureFired above:
    // once the fork has been put to the player it must not be put again, and "no
    // decision recorded" alone cannot express that. Read by definingMomentDue; set by
    // whatever presents the fork (Step 5/6). Nothing sets it yet.
    definingMomentPresented: false,
    // Per-role ANCHORED LOCATION, resolved ONCE here for the same reason and by the same
    // mechanism as effectiveClosure and effectiveDefiningMoment above: the role IS in scope
    // here and is NOT in scope downstream (composeTurnPrompt takes { scenario, characters,
    // locations, clues } and never a role). Unlike those two there is NO scenario-level
    // fallback — an anchor is a fact about one person's documented night, not a property a
    // scenario can hold for every seat in it. null for every role without one.
    effectiveAnchoredLocation:       anchoredLocation,
    // True provenance, in the mould of the two Source fields above. There is only one
    // supplier today, but the field is written so a later scenario-level or generated
    // anchor is distinguishable from a hand-authored one without changing any reader.
    effectiveAnchoredLocationSource: anchoredLocation ? 'role' : 'none',
  };
}

// Record the player's answer to a defining moment onto state.decisions, in the shape
// evaluateDefiningMoment reads ({ option_id, turn, elapsed }). ENGINE-OWNED: the id is
// validated against the block's own options, so a selection the block never offered is
// refused rather than recorded — decision_option_unknown stays a genuine anomaly the
// engine never manufactures. Mutates state in place; returns the recorded option id, or
// null when nothing was recorded.
//
// Guarded on definingMomentPresented: a decision can only answer a fork that was
// actually put to the player. That also makes this dark while DEFINING_MOMENT_ENABLED
// is off (the latch is never set, so nothing is ever recorded) and stops a player who
// happens to type an option's wording early from answering a question not yet asked.
// Never overwrites an answer already recorded — the first answer stands.
//
// The client posts the option TEXT back as playerInput (renderChoices sends the label,
// engine/game/index.html:1148), so an explicit definingChoiceId is preferred when the
// client sends one and an exact text match is the fallback that works with the client
// as it stands today.
export function recordDefiningDecision(state, scenario, { definingChoiceId, playerInput } = {}) {
  // Flag gate. DEFINING_MOMENT_ENABLED is private to PromptComposer, so it is read
  // through the evaluator: 'no_defining_moment_block' is exactly what it returns when
  // the flag is off. Without this, a session whose fork was presented while the flag
  // was ON would still record decisions after the flag was turned OFF.
  if (evaluateDefiningMoment(state, scenario).reason === 'no_defining_moment_block') return null;
  if (!state?.definingMomentPresented) return null;
  const block    = resolveDefiningMomentBlock(state, scenario);
  const momentId = block?.principal_transition?.moment;
  if (!momentId || !Array.isArray(block.options)) return null;
  if (state.decisions?.[momentId] != null) return null;

  const byId   = definingChoiceId ? block.options.find(o => o?.id === definingChoiceId) : null;
  const byText = !byId && typeof playerInput === 'string'
    ? block.options.find(o => typeof o?.text === 'string' && o.text.trim() === playerInput.trim())
    : null;
  const chosen = byId || byText;
  if (!chosen) return null;

  state.decisions = {
    ...(state.decisions || {}),
    [momentId]: { option_id: chosen.id, turn: state.turnCount ?? 0, elapsed: state.elapsedMinutes ?? 0 },
  };
  return chosen.id;
}

export function mergeState(currentState, modelOutput, scenario, clues, playerInput = '', locations = []) {
  const next  = structuredClone(currentState);
  const delta = modelOutput.stateChanges || {};

  // An explicit timeAdvance of 0 must survive: a defining-moment turn is authored to
  // cost nothing (defining_moment.time_advance). The old `||` chain treated that 0 as
  // "absent" and silently substituted the 3-minute default. `??` alone would not be
  // safe either — it guards only null/undefined, so '' and non-numeric junk, which
  // `||` used to reject into the default, would slip through as 0 or NaN and corrupt
  // elapsedMinutes. Take the first candidate that is genuinely a finite number; 3
  // stays the final backstop.
  const advance       = [modelOutput.timeAdvance, scenario.systems?.timePerTurnDefault, 3]
    .map(v => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)))
    .find(Number.isFinite) ?? 3;
  const sessionTarget = currentState.extensionUsed
    ? (scenario.sessionTargetMinutes || 15) + 5
    : (scenario.sessionTargetMinutes || 15);
  next.elapsedMinutes  += advance;
  next.remainingMinutes = Math.max(0, sessionTarget - next.elapsedMinutes);
  next.turnCount   = (currentState.turnCount   || 0) + 1;
  next.turnsAtZero = next.remainingMinutes <= 0 ? (currentState.turnsAtZero || 0) + 1 : 0;

  // Location is model-emitted. Validate it against the scenario's own ids before it becomes
  // state: an invented slug, a display name, or a prose phrase used to be written straight
  // through, and every later turn then composed its prose and choices against a location that
  // does not exist. Reject and hold position — same shape as the clue guard below. Skipped
  // when no roster is passed, so a caller without `locations` behaves exactly as before.
  if (typeof modelOutput.location === 'string' && modelOutput.location) {
    const known = (locations || []).length === 0 || locations.some(l => l.id === modelOutput.location);
    if (!known) {
      console.warn(`[LOCATION] Rejected "${modelOutput.location}" — not a location in ${scenario?.id ?? 'this scenario'}; holding at ${next.location}`);
    } else {
      next.location = modelOutput.location;
      if (!next.visitedLocations.includes(modelOutput.location)) {
        next.visitedLocations.push(modelOutput.location);
      }
    }
  }

  if (typeof delta.threat === 'number') {
    const { min = 0, max = 10 } = scenario.systems?.scales?.threat || {};
    next.threat = Math.max(min, Math.min(max, next.threat + delta.threat));
  }

  if (typeof delta.act === 'number') {
    next.act = delta.act;
  } else {
    const total = scenario.sessionTargetMinutes || 15;
    if (next.elapsedMinutes >= total * 0.75)      next.act = 3;
    else if (next.elapsedMinutes >= total * 0.33)  next.act = 2;
    else                                           next.act = 1;
  }

  // authorityTrust (generic) + burnhamTrust (backward compat)
  const trustDelta = delta.authorityTrust ?? delta.burnhamTrust ?? null;
  if (typeof trustDelta === 'number') {
    const { min = -3, max = 5 } = scenario.systems?.scales?.authorityTrust || {};
    next.authorityTrust = Math.max(min, Math.min(max, (next.authorityTrust || 0) + trustDelta));
  }

  if (delta.suspicion && typeof delta.suspicion === 'object') {
    for (const [charId, amount] of Object.entries(delta.suspicion)) {
      next.suspicion[charId] = (next.suspicion[charId] || 0) + Number(amount || 0);
    }
  }

  if (Array.isArray(modelOutput.npcMoments) && modelOutput.npcMoments.length > 0) {
    const last = modelOutput.npcMoments[modelOutput.npcMoments.length - 1];
    if (last?.npc) next.targetNpc = last.npc;
    next.introducedNpcs = next.introducedNpcs || [];
    for (const m of modelOutput.npcMoments) {
      if (!m?.npc) continue;
      if (m.npc === next.playerCharacterId) continue;
      if (!next.introducedNpcs.includes(m.npc)) next.introducedNpcs.push(m.npc);
    }
  }

  // ── Chase resolution ───────────────────────────────────────────────────────
  if (modelOutput.chaseResolved?.npcId) {
    const { npcId, result, clueGained } = modelOutput.chaseResolved;
    next.chaseState = null;
    if (result !== 'capture') {
      next.escapedNpcs = [...(next.escapedNpcs || []), npcId];
      next.threat = Math.min(10, next.threat + 2);
    } else {
      next.threat = Math.min(10, next.threat + 1);
      next.authorityTrust = Math.max(-3, (next.authorityTrust || 0) - 1);
    }
    if (clueGained && typeof clueGained === 'string') {
      const clue = getClueById(clueGained, clues);
      if (clue && !(next.discoveredClueIds || []).includes(clueGained)) {
        next.discoveredClueIds = [...(next.discoveredClueIds || []), clueGained];
        for (const charId of clue.implicatesCharacterIds || clue.implicates || []) {
          next.suspicion[charId] = (next.suspicion[charId] || 0) + 1;
        }
      }
    }
    next.physicalConflicts = [...(next.physicalConflicts || []), { npcId, result, turn: next.elapsedMinutes }];
  } else if (modelOutput.chaseInitiated?.npcId) {
    next.chaseState = { active: true, npcId: modelOutput.chaseInitiated.npcId, turnsRemaining: 3 };
  } else if (next.chaseState?.active) {
    const turnsLeft = next.chaseState.turnsRemaining - 1;
    if (turnsLeft <= 0) {
      const npcId = next.chaseState.npcId;
      next.chaseState  = null;
      next.escapedNpcs = [...(next.escapedNpcs || []), npcId];
      next.threat      = Math.min(10, next.threat + 2);
      next.physicalConflicts = [...(next.physicalConflicts || []), { npcId, result: 'escape_timeout', turn: next.elapsedMinutes }];
    } else {
      next.chaseState = { ...next.chaseState, turnsRemaining: turnsLeft };
    }
  }

  if (typeof modelOutput.npcFled === 'string' && modelOutput.npcFled) {
    next.escapedNpcs = next.escapedNpcs || [];
    if (!next.escapedNpcs.includes(modelOutput.npcFled)) {
      next.escapedNpcs = [...next.escapedNpcs, modelOutput.npcFled];
      next.threat = Math.min(10, next.threat + 1);
    }
  }

  if (modelOutput.physicalConflict?.npcId) {
    next.physicalConflicts = [...(next.physicalConflicts || []), { ...modelOutput.physicalConflict, turn: next.elapsedMinutes }];
    if (modelOutput.physicalConflict.type === 'npc_struck_first') {
      next.suspicion[modelOutput.physicalConflict.npcId] = (next.suspicion[modelOutput.physicalConflict.npcId] || 0) + 2;
      next.authorityTrust = Math.max(-3, (next.authorityTrust || 0) - 1);
    }
  }

  // ── Clue discovery ─────────────────────────────────────────────────────────
  if (Array.isArray(modelOutput.newClues)) {
    const validIds = new Set(getAvailableCluesAt(next.location, [], clues).map(c => c.id));
    for (const clueId of modelOutput.newClues) {
      if (typeof clueId !== 'string') continue;
      if (!validIds.has(clueId)) { console.warn(`[CLUE] Rejected "${clueId}" — not available at ${next.location}`); continue; }
      if (!(next.discoveredClueIds || []).includes(clueId)) {
        next.discoveredClueIds = [...(next.discoveredClueIds || []), clueId];
        const clue = getClueById(clueId, clues);
        if (clue) {
          for (const charId of clue.implicatesCharacterIds || clue.implicates || []) {
            next.suspicion[charId] = (next.suspicion[charId] || 0) + 1;
          }
        }
      }
    }
  }

  if (delta.flags && typeof delta.flags === 'object') next.flags = { ...next.flags, ...delta.flags };
  if (Array.isArray(delta.namedConspirators)) {
    next.namedConspirators = Array.from(new Set([...next.namedConspirators, ...delta.namedConspirators]));
  }

  // ── Inventory updates ──────────────────────────────────────────────────────
  if (Array.isArray(delta.inventory_updates)) {
    next.inventory = next.inventory || [];
    for (const update of delta.inventory_updates) {
      if (!update?.object_name) continue;
      const existing = next.inventory.find(i => i.object_name === update.object_name);
      if (existing) {
        if (update.holder   !== undefined) existing.holder = update.holder;
        if (update.status   !== undefined) existing.status = update.status;
        existing.turn = next.elapsedMinutes;
      } else {
        next.inventory.push({
          object_name: update.object_name,
          holder:      update.holder  || 'player',
          status:      update.status  || 'in_play',
          turn:        next.elapsedMinutes,
        });
      }
    }
  }

  // ── Resolved threads ───────────────────────────────────────────────────────
  if (Array.isArray(delta.resolved_threads)) {
    next.resolved_threads = next.resolved_threads || [];
    for (const thread of delta.resolved_threads) {
      if (!thread?.thread_id) continue;
      const already = next.resolved_threads.find(t => t.thread_id === thread.thread_id);
      if (!already) {
        next.resolved_threads.push({
          thread_id:     thread.thread_id,
          summary:       thread.summary || '',
          turn_resolved: next.elapsedMinutes,
        });
      }
    }
  }

  // Beat-aware close latch — once the arc-resolving transition has fired (met AND
  // past the elapsed floor), remember it so a later model-driven location change
  // cannot un-fire an ending that already correctly triggered. No-op when the
  // closure flag is off (closureShouldClose returns false).
  if (!next.closureFired && closureShouldClose(next, scenario)) {
    next.closureFired = true;
  }

  return next;
}
