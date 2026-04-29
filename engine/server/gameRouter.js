import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'node:stream';
import { Langfuse } from 'langfuse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.resolve(__dirname, '../prompts');

const ANTHROPIC_URL    = 'https://api.anthropic.com/v1/messages';
const MODEL            = 'claude-sonnet-4-6';
const MAX_HISTORY_MSGS = 8;

const langfuse = (process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY)
  ? new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      publicKey:  process.env.LANGFUSE_PUBLIC_KEY,
      baseUrl:    process.env.LANGFUSE_BASE_URL,
    })
  : null;

['SIGTERM', 'SIGINT'].forEach(sig =>
  process.on(sig, () => langfuse?.shutdownAsync().finally(() => process.exit(0)))
);

const systemPromptTemplate = fs.readFileSync(path.join(promptsDir, 'game_system_prompt.md'), 'utf8');
const turnTemplate         = fs.readFileSync(path.join(promptsDir, 'game_turn_template.md'), 'utf8');

// ── Data helpers ───────────────────────────────────────────────────────────────

function getScenarioData(repos, scenarioId) {
  const scenario = repos.scenarios.findAll().find(s => s.id === scenarioId);
  if (!scenario) throw new Error(`Scenario "${scenarioId}" not found.`);
  const playerRoles = repos.scenarios.findPlayerRoles(scenarioId);
  const characters  = repos.characters.findAll().filter(c => (c.scenarioIds || []).includes(scenarioId));
  const locations   = repos.locations.findByScenario(scenarioId);
  const clues       = repos.clues.findByScenario(scenarioId);
  return { scenario, playerRoles, characters, locations, clues };
}

// ── System prompt builder ──────────────────────────────────────────────────────

function buildSystemPrompt(scenario, locations) {
  const locList = locations
    .map(l => `- ${l.id}: ${l.name} — ${(l.description || '').slice(0, 100)}`)
    .join('\n');

  const winConds  = (scenario.winConditions  || ['Identify the culprit and present key evidence.']).join('\n- ');
  const failConds = (scenario.failConditions || ['Time expires before action.', 'Wrong accusation.']).join('\n- ');
  const partial   = (scenario.partialSuccessExamples || ['Immediate threat stopped but conspirators escape.']).join('\n- ');
  const pressure  = (scenario.systems?.pressureEvents || ['A witness disappears.', 'A key document goes missing.']).join('\n- ');

  const context = [
    `## Scenario: ${scenario.title}`,
    '',
    scenario.description || '',
    '',
    `**Genre:** ${(scenario.genre || ['mystery']).join(', ')}`,
    `**Historical Realism:** ${scenario.historicalRealism || 'medium'}`,
    `**Session Target:** ${scenario.sessionTargetMinutes || 15} minutes`,
    '',
    '## Approved Locations (use only these IDs and names in your narrative)',
    locList,
    '',
    '## Win Conditions',
    `- ${winConds}`,
    '',
    '## Fail Conditions',
    `- ${failConds}`,
    '',
    '## Partial Success',
    `- ${partial}`,
    '',
    '## Pressure Events (inject when player is stuck or pacing lags)',
    `- ${pressure}`,
  ].join('\n');

  return systemPromptTemplate.replace('{{SCENARIO_CONTEXT}}', context);
}

// ── TTS text preparation ───────────────────────────────────────────────────────

const SPEECH_VERBS = ['says', 'states', 'explains', 'claims', 'adds', 'continues', 'replies', 'notes', 'murmurs', 'answers'];

function prepareForTts(text) {
  return (text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/#+\s*/g, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/[_~]/g, '')
    // Name: "speech" → Name says, speech  (verb chosen by terminal punctuation)
    .replace(/^([A-Z][^:\n]{0,30}):\s*[“"'](.+?)[”"']\s*$/gm, (_, name, speech) => {
      const t = speech.trim();
      const verb = t.endsWith('!') ? 'exclaims'
                 : t.endsWith('?') ? 'asks'
                 : SPEECH_VERBS[Math.floor(Math.random() * SPEECH_VERBS.length)];
      return `${name} ${verb}, ${t}`;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// ── JSON extraction ────────────────────────────────────────────────────────────

function extractJson(raw) {
  const trimmed = (raw || '').trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const first = trimmed.indexOf('{'), last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
  throw new Error('No valid JSON found in model response.');
}

// ── Slim helpers (use new field names) ─────────────────────────────────────────

function slimLocation(loc) {
  if (!loc) return null;
  return {
    id:               loc.id,
    name:             loc.name,
    description:      loc.description,
    atmosphericDetails: loc.atmosphericDetails || loc.possibleClues || []
  };
}

function slimCharacter(char) {
  return {
    id:               char.id,
    name:             char.name,
    voice:            char.voice,
    goal:             char.privateGoal,
    knowledge:        char.knowledge,
    aggressionProfile: char.aggressionProfile || null
  };
}

function getLocationById(id, locations) {
  return locations.find(l => l.id === id) || null;
}

function getClueById(id, clues) {
  return clues.find(c => c.id === id) || null;
}

function getAvailableCluesAt(locationId, discoveredIds, clues) {
  return clues
    .filter(c => (c.discoveryLocationId || c.source) === locationId && !discoveredIds.includes(c.id))
    .map(c => ({ id: c.id, title: c.title, category: c.category }));
}

function getCharacterLocations(charId, locations) {
  return locations
    .filter(l => (l.linkedCharacterIds || l.linkedNPCs || []).includes(charId))
    .map(l => l.id);
}

function getRelevantCharacters(state, location, characters, locations) {
  const ids = new Set(location?.linkedCharacterIds || location?.linkedNPCs || []);
  const currentLocId = location?.id;

  Object.entries(state.suspicion || {})
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .forEach(([id]) => {
      const charLocs = getCharacterLocations(id, locations);
      if (charLocs.includes(currentLocId) || charLocs.length > 1) ids.add(id);
    });

  return characters.filter(c => ids.has(c.id)).map(slimCharacter);
}

function buildCharacterRoutes(characters, locations) {
  return characters.map(char => {
    const locs = locations
      .filter(l => (l.linkedCharacterIds || l.linkedNPCs || []).includes(char.id))
      .map(l => l.id);
    return { npc: char.id, name: char.name, locations: locs };
  });
}

// ── Prompt composition ─────────────────────────────────────────────────────────

const MOVEMENT_RE = /\b(go|head|return|walk|travel|back|leave|move)\b/i;
const PRONOUN_RE  = /\b(him|her|them|there)\b/i;

function buildReferenceContext(input, state, locations) {
  if (!PRONOUN_RE.test(input)) return null;
  const parts = [];
  if (/\b(him|her|them)\b/i.test(input) && state.targetNpc) {
    const charLocs = getCharacterLocations(state.targetNpc, locations);
    if (!charLocs.includes(state.location)) {
      parts.push(`"him"/"her"/"them" likely refers to the last NPC the player was with (id: ${state.targetNpc})`);
    }
  }
  if (/\bthere\b/i.test(input) && state.location) {
    const loc = locations.find(l => l.id === state.location);
    if (loc) parts.push(`"there" = ${loc.name}`);
  }
  return parts.length ? `[Reference context: ${parts.join(', ')}]` : null;
}

function buildPlayerRoleSection(state) {
  const roleId    = state.playerRoleId    || 'unknown';
  const roleName  = state.playerRoleName  || 'Investigator';
  const perspective = state.playerPerspective || 'The player is an investigator.';
  const accessLevel = state.playerAccessLevel || 'staff';
  const knowledge   = (state.playerStartingKnowledge || []).join('; ');
  return `Role: ${roleName} (id: ${roleId}) | Access: ${accessLevel}
Perspective: ${perspective}
Starting knowledge: ${knowledge || 'none'}
HARD RULE: The player is ${roleName}. Never address them as a different character. Never have ${roleName} appear as an NPC speaking to the player.`;
}

function buildLocationConstraint(locationId) {
  return `Current location (authoritative): ${locationId}\n⚠️ The player is at ${locationId}. Do NOT place the player at a different location unless they explicitly move.`;
}

function buildNpcIntroInstruction(state, location, characters, playerInput = '') {
  const introduced  = state.introducedNpcs || [];
  const playerRoleId = state.playerRoleId || '';
  const linkedIds   = location?.linkedCharacterIds || location?.linkedNPCs || [];

  let newChars = linkedIds
    .filter(id => !introduced.includes(id) && id !== playerRoleId)
    .filter(id => !state.targetNpc || id === state.targetNpc)
    .map(id => characters.find(c => c.id === id))
    .filter(Boolean);

  if (newChars.length === 0 && MOVEMENT_RE.test(playerInput)) {
    const inputLower = playerInput.toLowerCase();
    for (const char of characters) {
      if (introduced.includes(char.id) || char.id === playerRoleId) continue;
      const lastName  = char.name.split(' ').pop().toLowerCase();
      const firstName = char.name.split(' ')[0].toLowerCase();
      if (inputLower.includes(lastName) || inputLower.includes(firstName)) {
        const charLocs = getCharacterLocations(char.id, []);
        if (charLocs.length > 0) newChars.push(char);
      }
    }
  }

  if (newChars.length === 0) return '';
  const names = newChars.map(c => c.name).join(' and ');
  return `First encounter this session: ${names}. Apply the first encounter introduction rule from the system prompt.`;
}

function buildChaseInstruction(state, characters) {
  if (!state.chaseState?.active) return '';
  const { npcId, turnsRemaining } = state.chaseState;
  const char = characters.find(c => c.id === npcId);
  const name = char?.name || npcId;
  const chaseStyle = char?.aggressionProfile?.chaseStyle || 'panicked and unpredictable';
  return `⚠️ CHASE IN PROGRESS — ${name} is fleeing. ${turnsRemaining} turn(s) remaining before escape is guaranteed. Chase style: ${chaseStyle}. Present exactly 2 pursuit choices. Narrative must be short and kinetic — no dialogue, no reflection. Signal resolution via chaseResolved.`;
}

function checkEndingReadiness(state, scenario) {
  const ids         = state.discoveredClueIds || [];
  const keyIds      = scenario.keyEvidenceClueIds || [];
  const hasKey      = keyIds.some(id => ids.includes(id));
  const allKey      = keyIds.length > 0 && keyIds.every(id => ids.includes(id));
  const hasConspirators = (state.namedConspirators || []).length >= 1;
  return {
    keyEvidenceFound:   hasKey,
    allKeyEvidenceFound: allKey,
    readyForClimax:     allKey || (hasKey && hasConspirators),
    totalCluesFound:    ids.length,
    keyEvidenceNeeded:  keyIds.length
  };
}

function composeTurnPrompt(state, playerInput, { scenario, characters, locations, clues }) {
  const location      = getLocationById(state.location, locations);
  const relevantChars = getRelevantCharacters(state, location, characters, locations);
  const charRoutes    = buildCharacterRoutes(characters, locations);
  const discoveredClues = (state.discoveredClueIds || []).map(id => getClueById(id, clues)).filter(Boolean);
  const availableClues  = getAvailableCluesAt(state.location, state.discoveredClueIds || [], clues);
  const endingSignals   = checkEndingReadiness(state, scenario);

  const refContext = buildReferenceContext(playerInput, state, locations);
  const resolvedInput = refContext ? `${playerInput}\n${refContext}` : playerInput;

  const finalAccusationNote = state.finalAccusation
    ? '\n\n⚠️ FINAL ACCUSATION: The player has chosen to end the investigation and make their final accusation. This is their last move. You MUST return endState with isEnding: true. Evaluate as strong/partial/weak based on discovered clues.'
    : '';

  return turnTemplate
    .replace('{{PLAYER_ROLE_SECTION}}',    buildPlayerRoleSection(state))
    .replace('{{STATE_JSON}}',             JSON.stringify(state))
    .replace('{{LOCATION_JSON}}',          JSON.stringify(slimLocation(location)))
    .replace('{{NPC_JSON}}',               JSON.stringify(relevantChars))
    .replace('{{NPC_ROUTES_JSON}}',        JSON.stringify(charRoutes))
    .replace('{{DISCOVERED_CLUES_JSON}}',  JSON.stringify(discoveredClues))
    .replace('{{AVAILABLE_CLUES_JSON}}',   JSON.stringify(availableClues))
    .replace('{{ENDING_SIGNALS_JSON}}',    JSON.stringify(endingSignals))
    .replace('{{LOCATION_CONSTRAINT}}',    buildLocationConstraint(state.location))
    .replace('{{NPC_INTRO_INSTRUCTION}}',  [
      buildNpcIntroInstruction(state, location, characters, playerInput),
      buildChaseInstruction(state, characters)
    ].filter(Boolean).join('\n\n'))
    .replace('{{NARRATIVE_STYLE}}',        state.narrativeStyle || 'focused')
    .replace('{{PLAYER_INPUT}}',           resolvedInput + finalAccusationNote);
}

// ── State merging ──────────────────────────────────────────────────────────────

function isValidLocationMove(newLoc, currentLoc) {
  return newLoc !== currentLoc ? true : true;
}

function mergeState(currentState, modelOutput, scenario, clues, playerInput = '') {
  const next  = structuredClone(currentState);
  const delta = modelOutput.stateChanges || {};

  const advance       = Number(modelOutput.timeAdvance || scenario.systems?.timePerTurnDefault || 3);
  const sessionTarget = currentState.extensionUsed
    ? (scenario.sessionTargetMinutes || 15) + 5
    : (scenario.sessionTargetMinutes || 15);
  next.elapsedMinutes  += advance;
  next.remainingMinutes = Math.max(0, sessionTarget - next.elapsedMinutes);

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
    if (next.elapsedMinutes >= total * 0.75) next.act = 3;
    else if (next.elapsedMinutes >= total * 0.33) next.act = 2;
    else next.act = 1;
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
      if (m?.npc && !next.introducedNpcs.includes(m.npc)) next.introducedNpcs.push(m.npc);
    }
  }

  // Chase state
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

  return next;
}

// ── NPC dialogue check ─────────────────────────────────────────────────────────

function hasSpeech(narrative) {
  return narrative && /[""][^""]{4}|:\s*["']/.test(narrative);
}

function endsOnNpcQuestion(narrative, npcMoments) {
  if (!narrative || !Array.isArray(npcMoments) || npcMoments.length < 2) return false;
  const lines = narrative.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const last  = lines[lines.length - 1];
  return /^[A-Z][A-Za-z'\-\s]{1,30}:\s*["""'].+\?["""']\s*$/.test(last);
}

// ── Initial state builder ──────────────────────────────────────────────────────

function buildInitialState(scenario, role, locations) {
  const scales = scenario.systems?.scales || {};
  const startLoc = role.startLocationId || role.startLocation || (locations[0]?.id ?? 'start');
  const startLocData = locations.find(l => l.id === startLoc);
  const linkedChars = startLocData?.linkedCharacterIds || startLocData?.linkedNPCs || [];

  return {
    scenarioId:              scenario.id,
    playerRoleId:            role.id,
    playerRoleName:          role.name,
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
    introducedNpcs:          linkedChars.filter(id => id !== role.id),
    targetNpc:               null,
    suspicion:               { ...(role.roleInitialState?.suspicion || {}) },
    flags:                   { ...(role.roleInitialState?.flags || {}) },
    inventory:               [...(role.roleInitialState?.inventory || [])],
    namedConspirators:       [],
    escapedNpcs:             [],
    physicalConflicts:       [],
    chaseState:              null,
  };
}

// ── Router export ──────────────────────────────────────────────────────────────

export function createGameRouter(repos, config = {}) {
  const { anthropicApiKey, elevenLabsApiKey, elevenLabsVoiceId } = config;
  const r = Router();

  // ── Public scenario listing ────────────────────────────────────────────────
  r.get('/scenarios', (_, res) => {
    const all = repos.scenarios.findAll().map(s => ({
      id:                   s.id,
      title:                s.title,
      description:          s.description,
      genre:                s.genre || [],
      sessionTargetMinutes: s.sessionTargetMinutes,
      historicalRealism:    s.historicalRealism,
    }));
    res.json(all);
  });

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  r.get('/bootstrap', (req, res) => {
    const scenarioId = req.query.scenarioId;
    if (!scenarioId) return res.status(400).json({ error: 'scenarioId is required.' });
    try {
      const { scenario, playerRoles, characters, locations, clues } = getScenarioData(repos, scenarioId);
      console.log(`[BOOTSTRAP] scenario=${scenarioId} roles=${playerRoles.length} locs=${locations.length} clues=${clues.length}`);

      const playerRoleOptions = playerRoles.map(r => ({
        id:           r.id,
        name:         r.name,
        description:  r.description || '',
        accessLevel:  r.accessLevel || 'staff',
        startLocation: r.startLocationId || r.startLocation,
        perspective:  r.perspective || '',
        startingKnowledge: r.startingKnowledge || [],
        opening:      r.opening || null,
        roleInitialState: r.roleInitialState || {}
      }));

      res.json({
        scenario:    { ...scenario, playerRoleOptions },
        cluesCatalog: clues,
        locations,
        characters,
      });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // ── Turn ───────────────────────────────────────────────────────────────────
  r.post('/turn', async (req, res) => {
    try {
      const { state, playerInput, history = [], sessionId } = req.body;
      if (!state || !playerInput) return res.status(400).json({ error: 'Missing state or playerInput.' });
      if (!state.scenarioId)       return res.status(400).json({ error: 'state.scenarioId is required.' });
      if (!anthropicApiKey)        return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured.' });

      console.log(`[TURN] scenario=${state.scenarioId} loc=${state.location} act=${state.act} input="${playerInput.slice(0, 60)}"`);

      const gameData = getScenarioData(repos, state.scenarioId);
      const { scenario, characters, locations, clues } = gameData;

      const systemPrompt  = buildSystemPrompt(scenario, locations);
      const prompt        = composeTurnPrompt(state, playerInput, gameData);

      const isEndingTurn  = !!(state.finalAccusation || state.remainingMinutes <= 0);
      const endingSignals = checkEndingReadiness(state, scenario);
      const mightEnd      = endingSignals.readyForClimax || (state.namedConspirators || []).length >= 1;
      const isLateGame    = (state.remainingMinutes <= 7 && state.remainingMinutes > 0) || state.elapsedMinutes >= (scenario.sessionTargetMinutes * 0.75);
      const maxToks       = isEndingTurn ? 2000 : mightEnd ? 1800 : isLateGame ? 1400 : 900;

      const turnTrace  = langfuse?.trace({ name: 'turn', sessionId, input: { playerInput, location: state.location, act: state.act, elapsedMinutes: state.elapsedMinutes, scenarioId: state.scenarioId } });
      const traceTags  = [];
      const scoreTrace = (value, comment) => {
        if (!turnTrace) return;
        if (traceTags.length) turnTrace.update({ tags: traceTags });
        turnTrace.score({ name: 'quality', value, dataType: 'BOOLEAN', comment });
      };

      const callModel = async (messages, tokenOverride, callName = 'call') => {
        const toks = tokenOverride || maxToks;
        const gen  = turnTrace?.generation({ name: callName, model: MODEL, modelParameters: { max_tokens: toks, temperature: 0.8 }, input: [{ role: 'system', content: systemPrompt }, ...messages] });
        const signal = AbortSignal.timeout(55000);
        const resp   = await fetch(ANTHROPIC_URL, {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
          body: JSON.stringify({
            model: MODEL, max_tokens: toks, temperature: 0.8,
            system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
            messages
          })
        });
        const data = await resp.json();
        const text = data?.content?.[0]?.text;
        gen?.end({ output: text, usage: { input: data?.usage?.input_tokens, output: data?.usage?.output_tokens }, metadata: { stop_reason: data?.stop_reason } });
        return { data, text };
      };

      const baseMessages = [...history.slice(-MAX_HISTORY_MSGS), { role: 'user', content: prompt }];
      let { data, text } = await callModel(baseMessages, null, 'initial');

      if (!text) {
        scoreTrace(0, 'no-text-returned');
        return res.status(500).json({ error: 'No text returned from Anthropic.', raw: data });
      }

      let output;
      try {
        output = extractJson(text);
      } catch {
        const stopReason = data?.stop_reason || 'unknown';
        const truncatedEnding = stopReason === 'max_tokens' && /"isEnding"\s*:\s*true/.test(text);
        if (truncatedEnding && maxToks < 2000) {
          traceTags.push('has-retry', 'truncated-ending');
          console.log(`[RETRY] truncated-ending stop_reason=${stopReason} — retrying at 2000`);
          try {
            const { text: retryText } = await callModel(baseMessages, 2000, 'retry-truncated-ending');
            if (retryText) output = extractJson(retryText);
          } catch {}
        }
        if (!output) {
          traceTags.push('json-error');
          scoreTrace(0, `invalid-json stop_reason=${stopReason}`);
          console.error(`[TURN ERROR] invalid JSON stop_reason=${stopReason} len=${text.length}`);
          return res.status(500).json({ error: `Model returned invalid JSON (stop_reason: ${stopReason}).` });
        }
      }

      // Retry: silent NPC
      const npcPresent = Array.isArray(output.npcMoments) && output.npcMoments.length > 0;
      if (npcPresent && !hasSpeech(output.narrative)) {
        traceTags.push('has-retry', 'silent-npc');
        const npcName = output.npcMoments[0]?.npc?.replace(/_/g, ' ') || 'the NPC';
        console.log(`[RETRY] silent-npc — ${npcName}`);
        const retryMessages = [
          ...baseMessages,
          { role: 'assistant', content: text },
          { role: 'user', content: `Your response contained no spoken dialogue from ${npcName}. Rewrite so ${npcName} delivers at least one spoken line — e.g. ${npcName}: "..." — before presenting choices. Return only valid JSON.` }
        ];
        try {
          const { text: retryText } = await callModel(retryMessages, null, 'retry-silent-npc');
          if (retryText) { output = extractJson(retryText); text = retryText; }
        } catch {}
      }

      // Retry: NPC-to-NPC unanswered question
      if (endsOnNpcQuestion(output.narrative, output.npcMoments)) {
        traceTags.push('has-retry', 'npc-question');
        console.log('[RETRY] npc-to-npc unanswered question');
        const retryMessages = [
          ...baseMessages,
          { role: 'assistant', content: text },
          { role: 'user', content: `The turn ended with one NPC asking another NPC a question, leaving it unanswered. Continue immediately: the questioned NPC must reply, then give the player choices. Return only valid JSON.` }
        ];
        try {
          const { text: retryText } = await callModel(retryMessages, null, 'retry-npc-question');
          if (retryText) output = extractJson(retryText);
        } catch {}
      }

      let nextState = mergeState(state, output, scenario, clues, playerInput);
      if (state.finalAccusation) nextState.remainingMinutes = 0;

      if (state.finalAccusation && !output.endState?.isEnding) {
        output.endState = {
          isEnding: true, result: 'failure',
          scene: 'Time has run out. The investigation ends without a clear accusation.',
          conspiracySummary: 'The conspiracy was never fully exposed.',
          whatPlayerDiscovered: `${nextState.discoveredClueIds?.length || 0} clue(s) found, but no conclusion reached.`,
          outcome: 'The case remains open.',
          playerContribution: 'The investigation was abandoned before a suspect could be named.',
          authorityResponse: 'I needed a name. You gave me nothing.',
          correctSuspectIdentified: false
        };
      }

      if (output.endState?.isEnding) {
        output.endState.performance = {
          cluesDiscovered: nextState.discoveredClueIds?.length || 0,
          totalClues:      clues.length,
          timeRemaining:   nextState.remainingMinutes,
          result:          output.endState.result || 'failure'
        };
      }

      console.log(`[TURN] loc_out=${output.location || state.location} npcs=${JSON.stringify(output.npcMoments?.map(m => m.npc))} newClues=${JSON.stringify(output.newClues)} isEnding=${output.endState?.isEnding ?? false}`);
      turnTrace?.update({ output: { narrative: output.narrative?.slice(0, 300), location: output.location, isEnding: output.endState?.isEnding ?? false } });
      scoreTrace(traceTags.length ? 0 : 1, traceTags.length ? traceTags.join(', ') : undefined);

      return res.json({ output, nextState, mockMode: false });
    } catch (error) {
      const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      console.error(`[TURN ERROR] ${isTimeout ? 'timeout' : error.message}`);
      return res.status(500).json({ error: isTimeout ? 'AI request timed out — please try again.' : (error.message || 'Server error') });
    }
  });

  // ── Notes (server-side aggregation, no extra LLM call) ────────────────────
  r.post('/notes', (req, res) => {
    try {
      const { state } = req.body;
      if (!state?.scenarioId) return res.status(400).json({ error: 'Missing state.scenarioId.' });
      const { characters, locations, clues } = getScenarioData(repos, state.scenarioId);

      const discoveredClues = (state.discoveredClueIds || [])
        .map(id => getClueById(id, clues))
        .filter(Boolean)
        .map(c => ({ title: c.title, significance: c.description }));

      const suspicions = Object.entries(state.suspicion || {})
        .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
        .map(([id, score]) => {
          const char = characters.find(c => c.id === id);
          return {
            name:      char?.name || id,
            level:     score >= 3 ? 'high' : score >= 2 ? 'medium' : 'low',
            reasoning: score >= 3 ? 'Several pieces of evidence point in their direction.' : 'Something about their behavior has not sat right.'
          };
        });

      const impressions = (state.introducedNpcs || [])
        .map(id => { const c = characters.find(ch => ch.id === id); return c ? { name: c.name, impression: c.publicFace || '' } : null; })
        .filter(Boolean);

      const visited     = state.visitedLocations || [];
      const unvisited   = locations.filter(l => !visited.includes(l.id)).slice(0, 3);
      const nextLeads   = unvisited.map(l => `${l.name} has not yet been investigated.`);

      const openQuestions = [
        discoveredClues.length === 0 && 'No physical evidence has been found yet.',
        (state.namedConspirators || []).length === 0 && 'No suspects have been formally identified.',
        !discoveredClues.some(() => true) && 'The method and motive remain unclear.'
      ].filter(Boolean);

      res.json({ notes: { clues: discoveredClues, suspicions, characterImpressions: impressions, openQuestions, nextLeads } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── TTS ────────────────────────────────────────────────────────────────────
  r.post('/tts', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text.' });
    if (!elevenLabsApiKey) return res.status(503).json({ error: 'TTS not configured.' });

    const cleaned   = prepareForTts(text);
    const charCount = cleaned.length;
    const estimatedCostUsd = (charCount / 1000) * 0.15;
    console.log(`[TTS] chars=${charCount} est=$${estimatedCostUsd.toFixed(4)}`);

    const ttsTrace = langfuse?.trace({ name: 'tts', input: { chars: charCount, voiceId: elevenLabsVoiceId, model: 'eleven_flash_v2_5' } });
    const ttsGen   = ttsTrace?.generation({ name: 'tts-request', model: 'eleven_flash_v2_5', modelParameters: { stability: 0.5, similarity_boost: 0.75 }, input: cleaned, usage: { totalCost: estimatedCostUsd } });

    try {
      const voiceId  = elevenLabsVoiceId || 'onwK4e9ZLuTAKqWW03F9';
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'Accept': 'audio/mpeg', 'Content-Type': 'application/json', 'xi-api-key': elevenLabsApiKey },
        body: JSON.stringify({ text: cleaned, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
      });
      if (!response.ok) {
        ttsGen?.end({ metadata: { status: response.status } });
        return res.status(502).json({ error: 'TTS upstream error.' });
      }
      ttsGen?.end({ metadata: { status: 200 } });
      res.set('Content-Type', 'audio/mpeg');
      res.set('Cache-Control', 'no-store');
      Readable.fromWeb(response.body).pipe(res);
    } catch (err) {
      console.error(`[TTS ERROR] ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}
