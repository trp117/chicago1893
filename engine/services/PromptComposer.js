import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.resolve(__dirname, '../prompts');

const systemPromptTemplate = fs.readFileSync(path.join(promptsDir, 'game_system_prompt.md'), 'utf8');
const turnTemplate         = fs.readFileSync(path.join(promptsDir, 'game_turn_template.md'), 'utf8');

const MOVEMENT_RE  = /\b(go|head|return|walk|travel|back|leave|move)\b/i;

// ── Sensory opening config ─────────────────────────────────────────────────────

const SENSORY_ELEMENT_DESCRIPTIONS = {
  architecture:     '**ARCHITECTURE & SPACE** — The room or exterior structure: ceiling height, materials (plaster, timber, brick, stone, iron, glass), the size and feel of the space, what is worn or broken or well-kept. The player must be able to close their eyes and see the walls.',
  period_light:     '**PERIOD LIGHT** — The quality and source of light specific to the era: candles, gaslight, electric arc bulbs, firelight, moonlight. Light defines what is visible and what lies in shadow.',
  body_senses:      '**BODY & SENSES** — What the character physically feels: temperature, textures underfoot, the smell of the space, the sounds the building makes.',
  exterior_context: "**EXTERIOR CONTEXT** (when near a window, door, or outside) — What the city looks like at this hour, grounded in the scenario's setting and period.",
};

const SENSORY_STYLE_NOTES = {
  cinematic_period: 'Write with the specificity of a production designer. Concrete nouns, no vague adjectives. The reader must feel they are standing there in that era.',
  sparse_tense:     'Write with minimal precision — choose the one or two details that carry maximum atmospheric weight. No decoration.',
  action_first:     'Open briefly — one or two sensory beats only — then let the narrative launch immediately.',
};

const SENSORY_ELEMENT_NAMES = {
  architecture:     'architecture and materials of the space',
  period_light:     'period light source and quality',
  body_senses:      'physical sensation, smell, and sound',
  exterior_context: 'exterior context (if near door, window, or outside)',
};

const SENSORY_DEFAULTS = {
  enabled:          true,
  style:            'cinematic_period',
  elements:         ['architecture', 'period_light', 'body_senses', 'exterior_context'],
  target_sentences: 4,
  tts_pacing_hint:  'slow',
};

export function buildSensoryOpeningRule(_cfg = {}) {
  return [
    '## SENSORY OPENING RULE',
    '',
    'Do not open each response with a dedicated sensory description block. Instead, weave physical, environmental, and period detail continuously throughout the narrative — embedded in action, in what the character notices, in how other characters appear, in what the body registers while moving through the space.',
    '',
    'The model is literary fiction, not stage directions:',
    '- NOT: "The room smells of tallow and old paper." [standalone block]',
    '- YES: "You set the candle down on the counter beside his spectacles and the smell of tallow mingles with the cold sizing from the press."',
    '',
    'Sensory detail must:',
    '- Emerge from what the character is doing or looking at in that moment',
    '- Reveal character interiority — what she notices tells us who she is',
    '- Advance or complicate the scene — the creak below is both atmosphere and information',
    '- Never stop the narrative to describe — describe while the narrative moves',
    '',
    '`sensory_opening` is optional. Populate it ONLY when the player enters a new location or the scene context shifts significantly — and even then, 1–2 sentences before action begins. When continuing within the same scene or responding to a chosen action, omit `sensory_opening` entirely. All environmental texture belongs inside `narrative`.',
    '',
    '---',
  ].join('\n');
}

export function buildSensoryOpeningCheck(_cfg = {}) {
  return '⚠️ SENSORY OPENING CHECK: Do NOT open with a standalone sensory block unless the player just entered a new location (1–2 sentences max). Weave all environmental and period detail into `narrative` through action and attention. Omit `sensory_opening` when continuing within the same scene.';
}
const PRONOUN_RE   = /\b(him|her|them|there)\b/i;
const SPEECH_VERBS = ['says', 'states', 'explains', 'claims', 'adds', 'continues', 'replies', 'notes', 'murmurs', 'answers'];

// ── Data query helpers (also used by StateManager) ─────────────────────────────

export function getLocationById(id, locations) {
  return locations.find(l => l.id === id) || null;
}

export function getClueById(id, clues) {
  return clues.find(c => c.id === id) || null;
}

export function getAvailableCluesAt(locationId, discoveredIds, clues) {
  return clues
    .filter(c => (c.discoveryLocationId || c.source) === locationId && !discoveredIds.includes(c.id))
    .map(c => ({ id: c.id, title: c.title, category: c.category }));
}

// ── Slim helpers ───────────────────────────────────────────────────────────────

export function slimLocation(loc) {
  if (!loc) return null;
  return {
    id:                 loc.id,
    name:               loc.name,
    description:        loc.description,
    atmosphericDetails: loc.atmosphericDetails || loc.possibleClues || []
  };
}

export function slimCharacter(char) {
  return {
    id:               char.id,
    name:             char.name,
    voice:            char.voice,
    goal:             char.privateGoal,
    knowledge:        char.knowledge,
    aggressionProfile: char.aggressionProfile || null,
    introAnchor:      char.introAnchor || null
  };
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

export function buildCharacterRoutes(characters, locations) {
  return characters.map(char => {
    const locs = locations
      .filter(l => (l.linkedCharacterIds || l.linkedNPCs || []).includes(char.id))
      .map(l => l.id);
    return { npc: char.id, name: char.name, locations: locs };
  });
}

// ── TTS ────────────────────────────────────────────────────────────────────────

export function prepareForTts(text) {
  return (text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/#+\s*/g, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/[_~]/g, '')
    // Name: "speech" → Name says, speech  (verb chosen by terminal punctuation)
    .replace(/^([A-Z][^:\n]{0,30}):\s*[""'](.+?)[""']\s*$/gm, (_, name, speech) => {
      const t = speech.trim();
      const verb = t.endsWith('!') ? 'exclaims'
                 : t.endsWith('?') ? 'asks'
                 : SPEECH_VERBS[Math.floor(Math.random() * SPEECH_VERBS.length)];
      return `${name} ${verb}, ${t}`;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// ── System prompt ──────────────────────────────────────────────────────────────

export function buildSystemPrompt(scenario, locations) {
  const locList = locations
    .map(l => `- ${l.id}: ${l.name} — ${(l.description || '').slice(0, 100)}`)
    .join('\n');

  const winConds  = (scenario.winConditions        || []).join('\n- ');
  const failConds = (scenario.failConditions       || []).join('\n- ');
  const partial   = (scenario.partialSuccessExamples || []).join('\n- ');
  const pressure  = (scenario.systems?.pressureEvents || []).join('\n- ');

  const context = [
    `## Scenario: ${scenario.title}`,
    '',
    scenario.description || scenario.premise || '',
    '',
    `**Genre:** ${(scenario.genre || scenario.tone || []).join(', ')}`,
    `**Historical Realism:** ${scenario.historicalRealism || ''}`,
    `**Session Target:** ${scenario.sessionTargetMinutes || ''} minutes`,
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

  return systemPromptTemplate
    .replace('{{SCENARIO_CONTEXT}}', context)
    .replace('{{SENSORY_OPENING_RULE}}', buildSensoryOpeningRule(scenario.sensory_opening));
}

// ── Turn prompt builders ───────────────────────────────────────────────────────

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
  const roleId      = state.playerRoleId    || 'unknown';
  const roleName    = state.playerRoleName  || 'Investigator';
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

  const introLines = newChars.map(c => {
    const anchor = c.introAnchor || c.publicFace || c.role || '';
    return `- ${c.name} (id: ${c.id}): "${anchor}"`;
  }).join('\n');

  return `⚠️ FIRST ENCOUNTER — the following NPCs appear for the first time this session. Before any dialogue, weave their anchor description naturally into the narrative (do not quote it verbatim — integrate it into the prose):\n${introLines}\n\nIf any generated choice references an NPC not yet in the state's introducedNpcs list, append their role in parentheses after the name.`;
}

function buildChaseInstruction(state, characters) {
  if (!state.chaseState?.active) return '';
  const { npcId, turnsRemaining } = state.chaseState;
  const char = characters.find(c => c.id === npcId);
  const name = char?.name || npcId;
  const chaseStyle = char?.aggressionProfile?.chaseStyle || 'panicked and unpredictable';
  return `⚠️ CHASE IN PROGRESS — ${name} is fleeing. ${turnsRemaining} turn(s) remaining before escape is guaranteed. Chase style: ${chaseStyle}. Present exactly 2 pursuit choices. Narrative must be short and kinetic — no dialogue, no reflection. Signal resolution via chaseResolved.`;
}

export function checkEndingReadiness(state, scenario) {
  const ids    = state.discoveredClueIds || [];
  const keyIds = scenario.keyEvidenceClueIds || [];
  const hasKey = keyIds.some(id => ids.includes(id));
  const allKey = keyIds.length > 0 && keyIds.every(id => ids.includes(id));
  const hasConspirators = (state.namedConspirators || []).length >= 1;
  return {
    keyEvidenceFound:    hasKey,
    allKeyEvidenceFound: allKey,
    readyForClimax:      allKey || (hasKey && hasConspirators),
    totalCluesFound:     ids.length,
    keyEvidenceNeeded:   keyIds.length
  };
}

export function composeTurnPrompt(state, playerInput, { scenario, characters, locations, clues }) {
  const location        = getLocationById(state.location, locations);
  const relevantChars   = getRelevantCharacters(state, location, characters, locations);
  const charRoutes      = buildCharacterRoutes(characters, locations);
  const discoveredClues = (state.discoveredClueIds || []).map(id => getClueById(id, clues)).filter(Boolean);
  const availableClues  = getAvailableCluesAt(state.location, state.discoveredClueIds || [], clues);
  const endingSignals   = checkEndingReadiness(state, scenario);

  const refContext    = buildReferenceContext(playerInput, state, locations);
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
    .replace('{{SENSORY_OPENING_CHECK}}',  buildSensoryOpeningCheck(scenario.sensory_opening))
    .replace('{{PLAYER_INPUT}}',           resolvedInput + finalAccusationNote);
}
