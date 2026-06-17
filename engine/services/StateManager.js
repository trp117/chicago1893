import { getClueById, getAvailableCluesAt } from './PromptComposer.js';

export function buildInitialState(scenario, role, locations) {
  const scales      = scenario.systems?.scales || {};
  const startLoc    = role.startLocationId || role.startLocation || (locations[0]?.id ?? 'start');
  const startLocData = locations.find(l => l.id === startLoc);
  const linkedChars = startLocData?.linkedCharacterIds || startLocData?.linkedNPCs || [];

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
  };
}

export function mergeState(currentState, modelOutput, scenario, clues, playerInput = '') {
  const next  = structuredClone(currentState);
  const delta = modelOutput.stateChanges || {};

  const advance       = Number(modelOutput.timeAdvance || scenario.systems?.timePerTurnDefault || 3);
  const sessionTarget = currentState.extensionUsed
    ? (scenario.sessionTargetMinutes || 15) + 5
    : (scenario.sessionTargetMinutes || 15);
  next.elapsedMinutes  += advance;
  next.remainingMinutes = Math.max(0, sessionTarget - next.elapsedMinutes);
  next.turnCount   = (currentState.turnCount   || 0) + 1;
  next.turnsAtZero = next.remainingMinutes <= 0 ? (currentState.turnsAtZero || 0) + 1 : 0;

  if (typeof modelOutput.location === 'string' && modelOutput.location) {
    next.location = modelOutput.location;
    if (!next.visitedLocations.includes(modelOutput.location)) {
      next.visitedLocations.push(modelOutput.location);
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

  return next;
}
