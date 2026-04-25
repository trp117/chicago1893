import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(rootDir, 'src')));

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_HISTORY_MESSAGES = 8; // 4 turns × 2 (user + assistant)

function readText(filePath) {
  return fs.readFileSync(path.join(rootDir, filePath), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

const systemPrompt = readText('prompts/system_prompt.md');
const turnTemplate = readText('prompts/turn_prompt_template.md');
const notesSystemPrompt = readText('prompts/notes_system_prompt.md');
const notesTemplate = readText('prompts/notes_prompt_template.md');
const scenario = readJson('data/scenario.json');
const locations = readJson('data/locations.json');
const npcs = readJson('data/npcs.json');
const cluesCatalog = readJson('data/clues.json');

function extractJson(raw) {
  if (typeof raw !== 'string') {
    throw new Error('Model response is not text.');
  }

  const trimmed = raw.trim();

  if (!trimmed) {
    throw new Error('Model response text is empty.');
  }

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim());
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  throw new Error('No valid JSON object found in model response.');
}

function getLocationById(id) {
  return locations.find((loc) => loc.id === id) || null;
}

function getClueById(id) {
  return cluesCatalog.find((c) => c.id === id) || null;
}

function slimLocation(loc) {
  if (!loc) return null;
  return {
    id: loc.id,
    name: loc.name,
    description: loc.description,
    atmosphericClues: loc.possibleClues
  };
}

function slimClue(clue) {
  return {
    id: clue.id,
    title: clue.title,
    description: clue.description,
    category: clue.category,
    implicates: clue.implicates,
    unlocks: clue.unlocks
  };
}

function getAvailableCluesAtLocation(locationId, discoveredClueIds) {
  return cluesCatalog
    .filter((c) => c.source === locationId && !discoveredClueIds.includes(c.id))
    .map((c) => ({ id: c.id, title: c.title, category: c.category }));
}

function checkEndingReadiness(state) {
  const ids = state.discoveredClueIds || [];
  const hasMethod = state.knownSabotageMethod;
  const hasKeyEvidence =
    ids.includes('tampered_wiring_diagrams') ||
    ids.includes('opening_night_note');
  const hasConspirators = (state.namedConspirators || []).length >= 2;
  const escapedNpcs = state.escapedNpcs || [];
  const mercierEscaped = escapedNpcs.includes('emile_mercier');
  const hasConsequentialInfo = hasMethod || hasKeyEvidence;

  return {
    keyEvidenceFound: hasKeyEvidence,
    readyForClimax: hasMethod || (hasKeyEvidence && hasConspirators),
    mercierEscaped,
    partialVictoryPossible: mercierEscaped && hasConsequentialInfo,
    failureRisk: mercierEscaped && !hasConsequentialInfo && ids.length < 2
  };
}

function slimNpc(npc) {
  return {
    id: npc.id,
    name: npc.name,
    voice: npc.voice,
    goal: npc.privateGoal,
    knowledge: npc.knowledge,
    aggressionProfile: npc.aggressionProfile || null
  };
}

function getNpcLocations(npcId) {
  return locations.filter((l) => l.linkedNPCs?.includes(npcId)).map((l) => l.id);
}

function getRelevantNpcs(state, location) {
  const ids = new Set();

  if (location?.linkedNPCs) {
    location.linkedNPCs.forEach((id) => ids.add(id));
  }

  // Only pull high-suspicion NPCs if they can plausibly be at the current location
  // (i.e. they are linked to the current location OR they appear in multiple locations)
  const currentLocId = location?.id;
  Object.entries(state.suspicion || {})
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .forEach(([id]) => {
      const npcLocs = getNpcLocations(id);
      if (npcLocs.includes(currentLocId) || npcLocs.length > 1) {
        ids.add(id);
      }
    });

  return npcs.filter((npc) => ids.has(npc.id)).map(slimNpc);
}

const PRONOUN_RE = /\b(him|her|them|there)\b/i;

function buildReferenceContext(input, state) {
  if (!PRONOUN_RE.test(input)) return null;
  const parts = [];
  if (/\b(him|her|them)\b/i.test(input) && state.targetNpc) {
    const npc = npcs.find((n) => n.id === state.targetNpc);
    const npcLocs = getNpcLocations(state.targetNpc);
    // Only resolve if the player isn't already at that NPC's location —
    // if they are, "him/her" must refer to someone mentioned in the narrative, not the NPC they're with.
    if (npc && !npcLocs.includes(state.location)) {
      parts.push(`"him"/"her" = ${npc.name}`);
    }
  }
  if (/\bthere\b/i.test(input) && state.location) {
    const loc = getLocationById(state.location);
    if (loc) parts.push(`"there" = ${loc.name}`);
  }
  return parts.length ? `[Reference context: ${parts.join(', ')}]` : null;
}

function buildNpcRoutes() {
  return npcs.map((npc) => {
    const locs = locations
      .filter((l) => l.linkedNPCs?.includes(npc.id))
      .map((l) => l.id);
    return { npc: npc.id, name: npc.name, locations: locs };
  });
}

function buildNpcIntroInstruction(state, location, playerInput = '') {
  const introduced = state.introducedNpcs || [];
  const playerRoleId = state.playerRoleId || 'burnhams_assistant';

  // Check current location for un-introduced NPCs
  const linkedNpcs = location?.linkedNPCs || [];
  let newNpcs = linkedNpcs
    .filter((id) => !introduced.includes(id) && id !== playerRoleId)
    .map((id) => npcs.find((n) => n.id === id))
    .filter(Boolean);

  // On movement turns, also check if the player is heading toward an un-introduced NPC
  if (newNpcs.length === 0 && MOVEMENT_RE.test(playerInput)) {
    const inputLower = playerInput.toLowerCase();
    for (const npc of npcs) {
      if (introduced.includes(npc.id) || npc.id === playerRoleId) continue;
      const lastName = npc.name.split(' ').pop().toLowerCase();
      const firstName = npc.name.split(' ')[0].toLowerCase();
      if (inputLower.includes(lastName) || inputLower.includes(firstName)) {
        const npcLocs = getNpcLocations(npc.id);
        if (npcLocs.length > 0) newNpcs.push(npc);
      }
    }
  }

  if (newNpcs.length === 0) return '';

  const names = newNpcs.map((n) => n.name).join(' and ');
  return `First encounter this session: ${names}. Apply the first encounter introduction rule from the system prompt.`;
}

function buildChaseInstruction(state) {
  if (!state.chaseState?.active) return '';
  const { npcId, turnsRemaining } = state.chaseState;
  const npc = npcs.find((n) => n.id === npcId);
  const name = npc?.name || npcId;
  const chaseStyle = npc?.aggressionProfile?.chaseStyle || 'panicked and unpredictable';
  return `⚠️ CHASE IN PROGRESS — ${name} is fleeing. ${turnsRemaining} turn(s) remaining before escape is guaranteed regardless of player action. Chase style: ${chaseStyle}. This turn: present exactly 2 pursuit choices specific to the current location. Narrative must be short and kinetic — no dialogue, no reflection. Signal resolution via chaseResolved when the chase ends.`;
}

function buildPlayerRoleSection(state) {
  const roleId = state.playerRoleId || state.playerRole || 'burnhams_assistant';
  const roleName = state.playerRoleName || "Burnham's Assistant";
  const perspective = state.playerPerspective || "The player is assistant to Daniel Burnham.";
  const accessLevel = state.playerAccessLevel || 'staff';
  const knowledge = (state.playerStartingKnowledge || state.startingKnowledge || []).join('; ');
  return `Role: ${roleName} (id: ${roleId}) | Access: ${accessLevel}
Perspective: ${perspective}
Starting knowledge: ${knowledge || 'none'}
HARD RULE: The player is ${roleName}. Never address the player as a different character. Never have ${roleName} appear as an NPC speaking to the player.`;
}

function buildLocationConstraint(locationId, state = {}) {
  const roleId = state.playerRoleId || state.playerRole || 'burnhams_assistant';
  if (locationId === 'administration_building') {
    if (roleId === 'daniel_burnham') {
      return `Current location (authoritative): ${locationId}\nThe player is Daniel Burnham, in his own office. He is the authority here. Do NOT write Burnham as an NPC addressing the player — the player IS Burnham.`;
    }
    return `Current location (authoritative): ${locationId}\nThe player is in Burnham's office. Burnham is present and available.`;
  }
  if (roleId === 'daniel_burnham') {
    return `Current location (authoritative): ${locationId}\nThe player (Daniel Burnham) is at ${locationId}. Write from Burnham's perspective throughout. Do NOT revert to Burnham's office.`;
  }
  return `Current location (authoritative): ${locationId}\n⚠️ The player is at ${locationId}, NOT at administration_building. Do NOT place the player in Burnham's office. Do NOT introduce Daniel Burnham unless the player explicitly travels to administration_building.`;
}

function composeTurnPrompt(state, playerInput) {
  const location = getLocationById(state.location);
  const relevantNpcs = getRelevantNpcs(state, location);
  const discoveredClues = (state.discoveredClueIds || [])
    .map(getClueById)
    .filter(Boolean)
    .map(slimClue);
  const availableClues = getAvailableCluesAtLocation(
    state.location,
    state.discoveredClueIds || []
  );
  const endingSignals = checkEndingReadiness(state);
  const npcRoutes = buildNpcRoutes();

  const refContext = buildReferenceContext(playerInput, state);
  const resolvedInput = refContext ? `${playerInput}\n${refContext}` : playerInput;

  const finalAccusationNote = state.finalAccusation
    ? '\n\n⚠️ FINAL ACCUSATION: The player has chosen to end the investigation and make their final accusation. This is their last move. You MUST return endState with isEnding: true. Evaluate as strong/partial/weak based on discovered clues, but the case ends here regardless. Do not redirect them to gather more evidence.'
    : '';

  return turnTemplate
    .replace('{{PLAYER_ROLE_SECTION}}', buildPlayerRoleSection(state))
    .replace('{{STATE_JSON}}', JSON.stringify(state))
    .replace('{{LOCATION_JSON}}', JSON.stringify(slimLocation(location)))
    .replace('{{NPC_JSON}}', JSON.stringify(relevantNpcs))
    .replace('{{NPC_ROUTES_JSON}}', JSON.stringify(npcRoutes))
    .replace('{{DISCOVERED_CLUES_JSON}}', JSON.stringify(discoveredClues))
    .replace('{{AVAILABLE_CLUES_JSON}}', JSON.stringify(availableClues))
    .replace('{{ENDING_SIGNALS_JSON}}', JSON.stringify(endingSignals))
    .replace('{{LOCATION_CONSTRAINT}}', buildLocationConstraint(state.location, state))
    .replace('{{PREV_CONTEXT}}', '')
    .replace('{{NPC_INTRO_INSTRUCTION}}', [
      buildNpcIntroInstruction(state, location, playerInput),
      buildChaseInstruction(state)
    ].filter(Boolean).join('\n\n'))
    .replace('{{NARRATIVE_STYLE}}', state.narrativeStyle || 'focused')
    .replace('{{PLAYER_INPUT}}', resolvedInput + finalAccusationNote);
}

const MOVEMENT_RE = /\b(go|head|return|walk|travel|back|leave|move)\b/i;
const BURNHAM_RE = /\b(burnham|administration|office)\b/i;

function isValidLocationMove(newLoc, currentLoc, playerInput) {
  if (newLoc === currentLoc) return true;
  if (newLoc === 'administration_building' && currentLoc !== 'administration_building') {
    return MOVEMENT_RE.test(playerInput) && BURNHAM_RE.test(playerInput);
  }
  return true;
}

function mergeState(currentState, modelOutput, playerInput = '') {
  const next = structuredClone(currentState);
  const delta = modelOutput.stateChanges || {};

  const advance = Number(
    modelOutput.timeAdvance || scenario.coreSystems.timePerTurnDefault || 3
  );
  const sessionTarget = currentState.extensionUsed
    ? scenario.sessionTargetMinutes + 5
    : scenario.sessionTargetMinutes;
  next.elapsedMinutes += advance;
  next.remainingMinutes = Math.max(0, sessionTarget - next.elapsedMinutes);

  if (typeof modelOutput.location === 'string' && modelOutput.location) {
    if (isValidLocationMove(modelOutput.location, currentState.location, playerInput)) {
      next.location = modelOutput.location;
      if (!next.visitedLocations.includes(modelOutput.location)) {
        next.visitedLocations.push(modelOutput.location);
      }
    }
  }

  if (typeof delta.threat === 'number') {
    next.threat = Math.max(0, Math.min(10, next.threat + delta.threat));
  }

  if (typeof delta.act === 'number') {
    next.act = delta.act;
  } else {
    if (next.elapsedMinutes >= 11) next.act = 3;
    else if (next.elapsedMinutes >= 5) next.act = 2;
    else next.act = 1;
  }

  if (typeof delta.burnhamTrust === 'number') {
    next.burnhamTrust = Math.max(
      -3,
      Math.min(5, next.burnhamTrust + delta.burnhamTrust)
    );
  }

  if (delta.suspicion && typeof delta.suspicion === 'object') {
    for (const [npcId, amount] of Object.entries(delta.suspicion)) {
      const current = next.suspicion[npcId] || 0;
      next.suspicion[npcId] = current + Number(amount || 0);
    }
  }

  if (Array.isArray(modelOutput.npcMoments) && modelOutput.npcMoments.length > 0) {
    const last = modelOutput.npcMoments[modelOutput.npcMoments.length - 1];
    if (last?.npc) next.targetNpc = last.npc;

    next.introducedNpcs = next.introducedNpcs || [];
    for (const moment of modelOutput.npcMoments) {
      if (moment?.npc && !next.introducedNpcs.includes(moment.npc)) {
        next.introducedNpcs.push(moment.npc);
      }
    }
  }

  // ── Chase and physical conflict state ──────────────────────────────────────

  if (modelOutput.chaseResolved?.npcId) {
    // Chase ended this turn — process outcome before anything else
    const { npcId, result, clueGained } = modelOutput.chaseResolved;
    next.chaseState = null;
    if (result !== 'capture') {
      next.escapedNpcs = [...(next.escapedNpcs || []), npcId];
      next.threat = Math.min(10, next.threat + 2);
    } else {
      next.threat = Math.min(10, next.threat + 1);
      next.burnhamTrust = Math.max(-3, next.burnhamTrust - 1);
    }
    if (clueGained && typeof clueGained === 'string') {
      const clue = getClueById(clueGained);
      if (clue && !(next.discoveredClueIds || []).includes(clueGained)) {
        next.discoveredClueIds = next.discoveredClueIds || [];
        next.discoveredClueIds.push(clueGained);
        for (const nid of clue.implicates || []) {
          next.suspicion[nid] = (next.suspicion[nid] || 0) + 1;
        }
      }
    }
    next.physicalConflicts = [...(next.physicalConflicts || []), { npcId, result, turn: next.elapsedMinutes }];
  } else if (modelOutput.chaseInitiated?.npcId) {
    // New chase started this turn
    next.chaseState = { active: true, npcId: modelOutput.chaseInitiated.npcId, turnsRemaining: 3 };
  } else if (next.chaseState?.active) {
    // Chase ongoing — decrement turns
    const turnsLeft = next.chaseState.turnsRemaining - 1;
    if (turnsLeft <= 0) {
      // Hard cap: force escape
      const npcId = next.chaseState.npcId;
      next.chaseState = null;
      next.escapedNpcs = [...(next.escapedNpcs || []), npcId];
      next.threat = Math.min(10, next.threat + 2);
      next.physicalConflicts = [...(next.physicalConflicts || []), { npcId, result: 'escape_timeout', turn: next.elapsedMinutes }];
    } else {
      next.chaseState = { ...next.chaseState, turnsRemaining: turnsLeft };
    }
  }

  // NPC fled without a chase sequence
  if (typeof modelOutput.npcFled === 'string' && modelOutput.npcFled) {
    next.escapedNpcs = next.escapedNpcs || [];
    if (!next.escapedNpcs.includes(modelOutput.npcFled)) {
      next.escapedNpcs = [...next.escapedNpcs, modelOutput.npcFled];
      next.threat = Math.min(10, next.threat + 1);
    }
  }

  // Physical conflict tracking
  if (modelOutput.physicalConflict?.npcId) {
    next.physicalConflicts = [...(next.physicalConflicts || []), { ...modelOutput.physicalConflict, turn: next.elapsedMinutes }];
    if (modelOutput.physicalConflict.type === 'npc_struck_first') {
      const npcId = modelOutput.physicalConflict.npcId;
      next.suspicion[npcId] = (next.suspicion[npcId] || 0) + 2;
      next.burnhamTrust = Math.max(-3, next.burnhamTrust - 1);
    }
  }

  if (Array.isArray(modelOutput.newClues)) {
    for (const clueId of modelOutput.newClues) {
      if (typeof clueId !== 'string') continue;

      if (!(next.discoveredClueIds || []).includes(clueId)) {
        next.discoveredClueIds = next.discoveredClueIds || [];
        next.discoveredClueIds.push(clueId);

        const clue = getClueById(clueId);
        if (clue) {
          for (const npcId of clue.implicates || []) {
            next.suspicion[npcId] = (next.suspicion[npcId] || 0) + 1;
          }
        }
      }
    }
  }

  if (delta.flags && typeof delta.flags === 'object') {
    next.flags = { ...next.flags, ...delta.flags };
  }

  if (typeof delta.knownSabotageMethod === 'boolean') {
    next.knownSabotageMethod = delta.knownSabotageMethod;
  }

  if (Array.isArray(delta.namedConspirators)) {
    next.namedConspirators = Array.from(
      new Set([...next.namedConspirators, ...delta.namedConspirators])
    );
  }

  return next;
}

function buildMockNotes(state, discoveredClues, suspicionContext) {
  const clues = discoveredClues.map((c) => ({
    title: c.title,
    significance: c.description
  }));

  const suspicions = suspicionContext.map(({ name, score }) => ({
    name,
    level: score >= 3 ? 'high' : score >= 2 ? 'medium' : 'low',
    reasoning:
      score >= 3
        ? 'Several pieces of evidence now point in their direction.'
        : 'Something in their behavior has not sat right with me.'
  }));

  const impressions = (state.introducedNpcs || [])
    .map((id) => {
      const npc = npcs.find((n) => n.id === id);
      if (!npc) return null;
      return { name: npc.name, impression: npc.publicFace };
    })
    .filter(Boolean);

  const openQuestions = [
    !state.knownSabotageMethod &&
      'I still do not know exactly how the sabotage is meant to work.',
    (state.namedConspirators || []).length < 2 &&
      'There are people behind this I have not yet identified.',
    discoveredClues.length < 3 &&
      'I have not found all the physical evidence — there is more out there.'
  ].filter(Boolean);

  const visited = state.visitedLocations || [];
  const nextLeads = [
    !visited.includes('freight_yards') &&
      'The freight yards may hold physical evidence of the diverted crates.',
    !visited.includes('machinery_hall') &&
      'Machinery Hall should be examined for tampering.',
    !visited.includes('midway_plaisance') &&
      'The Midway is full of loose talk — worth a visit.',
    discoveredClues.length === 0 &&
      'Start with the documents Burnham has on his desk.'
  ]
    .filter(Boolean)
    .slice(0, 3);

  return {
    clues,
    suspicions,
    characterImpressions: impressions,
    openQuestions,
    nextLeads
  };
}

app.post('/api/notes', async (req, res) => {
  try {
    const { state } = req.body;
    if (!state) {
      return res.status(400).json({ error: 'Missing state.' });
    }

    const discoveredClues = (state.discoveredClueIds || [])
      .map(getClueById)
      .filter(Boolean)
      .map(slimClue);

    const suspicionContext = Object.entries(state.suspicion || {})
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => {
        const npc = npcs.find((n) => n.id === id);
        return { id, name: npc?.name || id, score };
      });

    if (!API_KEY) {
      return res.json({
        notes: buildMockNotes(state, discoveredClues, suspicionContext)
      });
    }

    const introducedNpcsContext = (state.introducedNpcs || [])
      .map((id) => {
        const npc = npcs.find((n) => n.id === id);
        return npc ? { name: npc.name, role: npc.role, publicFace: npc.publicFace } : null;
      })
      .filter(Boolean);

    const prompt = notesTemplate
      .replace('{{DISCOVERED_CLUES_JSON}}', JSON.stringify(discoveredClues))
      .replace('{{INTRODUCED_NPCS_JSON}}', JSON.stringify(introducedNpcsContext))
      .replace('{{SUSPICION_JSON}}', JSON.stringify(suspicionContext))
      .replace(
        '{{NAMED_CONSPIRATORS}}',
        JSON.stringify(state.namedConspirators || [])
      )
      .replace(
        '{{VISITED_LOCATIONS}}',
        JSON.stringify(state.visitedLocations || [])
      )
      .replace('{{ACT}}', String(state.act || 1))
      .replace('{{ELAPSED}}', String(state.elapsedMinutes || 0));

    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        temperature: 0.7,
        system: notesSystemPrompt,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = data?.content?.[0]?.text;

    if (!text) {
      return res.status(500).json({ error: 'No response from AI.' });
    }

    let notes;
    try {
      notes = extractJson(text);
    } catch (parseError) {
      console.error('INVALID NOTES JSON RAW TEXT:', text);
      return res.status(500).json({
        error: 'Invalid notes format returned.',
        rawText: text
      });
    }

    return res.json({ notes });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error.' });
  }
});

app.get('/api/bootstrap', (_, res) => {
  res.json({
    scenario,
    cluesCatalog,
    locations,
    state: scenario.initialState,
    roleOpenings: scenario.roleOpenings || {},
    opening: {
      narrative:
        "Chicago, May 1893. The White City rises from the lakefront mud, its plaster palaces gleaming in the morning haze — ten thousand workers still swarming Jackson Park in the final days before the Exposition opens. But beneath the spectacle, something is wrong. A tension moves through the corridors of the Administration Building that has nothing to do with last-minute preparations.\n\nYou are assistant to Daniel Burnham, Director of Works. When he needs eyes he can trust, he sends for you.\n\nThis morning, a shipping manifest crossed your desk: electrical equipment, diverted from its declared route. The signature authorizing the change does not match any name on Burnham's staff.\n\nBurnham's office door stands open. He is at his desk, jaw set, a telegraph slip folded in his hand. He looks up.",
      npcMoments: [
        {
          npc: 'daniel_burnham',
          text: "'Shut the door. Tell me what you found in those papers.'"
        }
      ],
      choices: [
        'Show Burnham the mismatched signature on the manifest',
        'Ask Burnham what he already suspects',
        'Request permission to go directly to the freight yards'
      ]
    }
  });
});

app.post('/api/turn', async (req, res) => {
  try {
    const { state, playerInput, history = [] } = req.body;

    if (!state || !playerInput) {
      return res.status(400).json({ error: 'Missing state or playerInput.' });
    }

    if (!API_KEY) {
      const fallback = {
        narrative:
          "Burnham narrows his eyes as you speak. Around you, clerks continue their work with the strained efficiency of men who know that every lost minute may become a public embarrassment. Your question touches a nerve: several consignments were rerouted under irregular authority, and one initials mark appears twice in different hands.",
        timeAdvance: 3,
        location: state.location,
        stateChanges: {
          threat: 1,
          burnhamTrust: 1
        },
        newClues: ['forged_initials_memo'],
        npcMoments: [
          {
            npc: 'daniel_burnham',
            text:
              "'Find out whether this is incompetence or design. I confess I no longer assume the better of the two.'"
          }
        ],
        choices: [
          'Inspect the altered memorandum more closely',
          'Question a clerk about who carried the papers',
          'Head to Machinery Hall to verify the electrical delivery'
        ],
        endState: {
          isEnding: false,
          result: 'ongoing'
        }
      };

      return res.json({
        output: fallback,
        nextState: mergeState(state, fallback, playerInput),
        mockMode: true
      });
    }

    console.log('[TURN] location_in:', state.location, '| input:', playerInput.slice(0, 60));

    let prompt;
    try {
      prompt = composeTurnPrompt(state, playerInput);
      console.log('[DEBUG] composeTurnPrompt completed, prompt length:', prompt?.length);
    } catch (promptError) {
      console.error('[ERROR] composeTurnPrompt failed:', promptError.message, promptError.stack);
      return res.status(500).json({ error: 'Failed to build prompt: ' + promptError.message });
    }

    const callModel = (messages) =>
      fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 900,
          temperature: 0.8,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages
        })
      });

    const hasSpeech = (narrative) => narrative && /[""][^""]{4}|:\s*["']/.test(narrative);

    const baseMessages = [...history.slice(-MAX_HISTORY_MESSAGES), { role: 'user', content: prompt }];
    let response = await callModel(baseMessages);
    let data = await response.json();
    let text = data?.content?.[0]?.text;

    if (!text) {
      return res.status(500).json({ error: 'No text returned from Anthropic.', raw: data });
    }

    let output;
    try {
      output = extractJson(text);
    } catch (parseError) {
      console.error('INVALID TURN JSON RAW TEXT:', text);
      return res.status(500).json({ error: 'Model returned invalid JSON.', rawText: text });
    }

    // Retry once if NPC is present but narrative contains no spoken dialogue
    const npcPresent = Array.isArray(output.npcMoments) && output.npcMoments.length > 0;
    if (npcPresent && !hasSpeech(output.narrative)) {
      const npcName = output.npcMoments[0]?.npc?.replace(/_/g, ' ') || 'the NPC';
      console.log('[RETRY] Silent NPC response detected — retrying with dialogue correction');
      const retryMessages = [
        ...baseMessages,
        { role: 'assistant', content: text },
        {
          role: 'user',
          content: `Your response contained no spoken dialogue from ${npcName}. Rewrite the narrative so that ${npcName} delivers at least one spoken line — e.g. ${npcName}: "..." — before presenting choices. Return only valid JSON.`
        }
      ];
      const retryResponse = await callModel(retryMessages);
      const retryData = await retryResponse.json();
      const retryText = retryData?.content?.[0]?.text;
      if (retryText) {
        try {
          output = extractJson(retryText);
        } catch (_) {
          // retry parse failed — keep original output
        }
      }
    }

    console.log('[TURN] location_out:', output.location, '| npcMoments:', JSON.stringify(output.npcMoments?.map(m => m.npc)));

    let nextState;
    try {
      nextState = mergeState(state, output, playerInput);
      if (state.finalAccusation) nextState.remainingMinutes = 0;
      console.log('[TURN] location_final:', nextState.location);
    } catch (mergeError) {
      console.error('[ERROR] mergeState failed:', mergeError.message, mergeError.stack);
      return res.status(500).json({ error: 'Failed to merge state: ' + mergeError.message });
    }

    if (state.finalAccusation && !output.endState?.isEnding) {
      output.endState = {
        isEnding: true,
        result: 'failure',
        scene: 'Time has run out. Without a clear accusation, the investigation ends here.',
        conspiracySummary: 'The conspiracy was never fully exposed.',
        whatPlayerDiscovered: `${nextState.discoveredClueIds?.length || 0} clue(s) were found, but no conclusion was reached.`,
        outcome: 'The fair opened under a cloud of unresolved suspicion.',
        playerContribution: 'The investigation was abandoned before a suspect could be named.',
        burnhamResponse: '"I needed a name. You gave me nothing."',
        correctSuspectIdentified: false
      };
    }

    if (output.endState?.isEnding) {
      output.endState.performance = {
        cluesDiscovered: nextState.discoveredClueIds?.length || 0,
        totalClues: cluesCatalog.length,
        timeRemaining: nextState.remainingMinutes,
        result: output.endState.result || 'failure'
      };
    }

    return res.json({ output, nextState, mockMode: false });
  } catch (error) {
    console.error('[ERROR] /api/turn failed:', error.message, error.stack);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Chicago 1893 server running on http://localhost:${PORT}`);
});