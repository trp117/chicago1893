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

export function buildNarrativeStyleRules(_cfg = {}) {
  // Builds two narrative style rules injected into every scene generation call:
  //
  // 1. SENSORY OPENING RULE — ensures physical and period detail is woven
  //    into narrative rather than fired as a standalone descriptive block.
  //
  // 2. NARRATIVE DISTANCE RULE — keeps prose inside the player character's
  //    body and immediate experience. Prevents the scene generation from
  //    stepping back to explain, summarize, or editorialize.
  //
  // Both rules apply globally to every story and every character.
  // Inserted at {{SENSORY_OPENING_RULE}} in game_system_prompt.md (line 144)
  // and via buildSystemPromptLegacy() for all scenarios.
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
    '',
    '## NARRATIVE DISTANCE RULE — STAY CLOSE',
    '',
    'Write from inside the body. Never step back to observe, explain, or editorialize.',
    '',
    'NEVER:',
    '- Explain what a character\'s behavior means or reveals',
    '  WRONG: "He has the stillness of a man who has been carrying this question for years"',
    '  RIGHT: "He sets the candle down. Does not speak."',
    '',
    '- Have the player character narrate their own qualities or history',
    '  WRONG: "You have spent years learning to move through rooms without being seen"',
    '  RIGHT: "Your shoulder finds the wall. Your weight shifts forward. No sound."',
    '',
    '- Describe a situation as a type or pattern',
    '  WRONG: "The kind of silence that means a decision has already been made"',
    '  RIGHT: "The candle burns. Neither of you moves."',
    '',
    '- Use abstract nouns where physical detail is possible',
    '  WRONG: "Something shifts in his expression"',
    '  RIGHT: "His hand leaves the newel post"',
    '',
    'ALWAYS:',
    '- Anchor every moment in the body: breath, weight, temperature, smell, sound, the specific object in the specific hand',
    '- Let other characters reveal themselves through what they do and say — never explain them to the reader',
    '- Trust the reader to draw conclusions from physical detail',
    '- When in doubt, go smaller and more specific, not larger and more explanatory',
    '',
    'PATTERNS THAT ARE ALWAYS WRONG — never use these under any circumstances:',
    '',
    '1. EMOTIONAL GLOSS ON DIALOGUE',
    'Never explain the emotional register of what a character just said. The dialogue lands or it doesn\'t. The explanation kills it.',
    '',
    'WRONG: "He says it quietly. Not a condemnation — almost a confession."',
    'WRONG: "The word lands flat, which means he is deciding whether to believe you."',
    'RIGHT: Let the words stand. Move immediately to the next physical beat.',
    '',
    '2. FACE READING WITH INTERPRETATION',
    'Never describe a character\'s expression and then explain what it means. Either describe the expression and trust the reader, or skip the description and go to the action.',
    '',
    'WRONG: "Something moves across his face that is not quite anger and not quite grief — something older than both, the face of a man who has spent years building a wall and just heard it crack."',
    'RIGHT: "His hand leaves the newel post."',
    '',
    '3. THE PLAYER CHARACTER NARRATING THEIR OWN REALIZATION',
    'Never have the player character step outside themselves to observe and explain what they are understanding or feeling.',
    '',
    'WRONG: "You are aware — acutely, in your chest — that your father just told you how to walk past a checkpoint he has never admitted to knowing."',
    'WRONG: "You understand that the next sentence you speak will be the one he remembers."',
    'RIGHT: Stay in the body. Stay in the moment. Let the reader draw the conclusion from what is physically present.',
    '',
    '4. PATTERN EXPLANATION',
    'Never describe a character\'s behavior as an instance of a pattern or type.',
    '',
    'WRONG: "He has the look of a man who has been putting something down and picking it back up for years."',
    'WRONG: "The kind of silence that means a decision has already been made."',
    'RIGHT: Describe only what is present right now. This moment. This room. This specific person.',
    '',
    'THE TEST FOR EVERY SENTENCE:',
    'Is this sentence doing work that the physical action, the dialogue, or the specific detail has not already done?',
    '',
    'If the action already shows it — cut the sentence.',
    'If the dialogue already says it — cut the sentence.',
    'If the reader can conclude it from what is present — cut the sentence and trust the reader.',
    '',
    'THE STANDARD IS THIS LINE:',
    '"You do not look back, because if you look back you will see his face and his face will stop you."',
    '',
    'That sentence is inside a body making a decision. It does not explain. It does not observe from outside. It is the thing itself. Every sentence should reach for that.',
    '',
    'THE TEST: If a sentence could be removed and the scene would still be fully understood from the physical action alone — remove it. If a sentence explains something the action already shows — remove it. Every sentence that remains should be doing work that no other sentence is doing.',
    '',
    'THE STANDARD: The reader should be inside a body in the scene, not reading about one.',
    '',
    '---',
    '',
    '## SENSORY REPETITION RULE',
    '',
    'Every physical sensation, anchor, or environmental detail may appear once per scene — twice at most if the repetition is deliberate and time has passed between uses.',
    '',
    'Never return to the same physical anchor within the same scene or within two consecutive scenes. The dispatch, the cold, a smell, a sound — each one lands once and is replaced by something new.',
    '',
    'The world contains more than two sensations. Find what is specifically present at this exact moment:',
    '- What does this room smell of right now that it did not smell of two minutes ago',
    '- What sound is present now that was not present before',
    '- What has the character\'s body been doing that it has not registered yet — the weight of standing still, a held breath released, the specific texture of a surface under a hand',
    '',
    'When you reach for a physical anchor, ask first: have I used this in the last three turns. If yes — find something else. The reader\'s body learns to ignore repeated sensation the same way it ignores a clock ticking. Variation is what keeps the physical world alive.',
    '',
    'THE STANDARD: each turn should introduce at least one physical or sensory detail that has not appeared before in this session.',
    '',
    'Do not repeat within a single session:',
    '- Any variation of "the dispatch against the ribs"',
    '- Any variation of "the cold finding the gap at [body part]"',
    '- Any variation of "the candle guttering"',
    '- Any variation of "the smell of linseed oil"',
    '',
    'These are the four most overused anchors. Each may appear once per session. After that, find something new.',
    '',
    '---',
  ].join('\n');
}

export function buildSensoryOpeningCheck(_cfg = {}) {
  return '⚠️ SENSORY OPENING CHECK: Do NOT open with a standalone sensory block unless the player just entered a new location (1–2 sentences max). Weave all environmental and period detail into `narrative` through action and attention. Omit `sensory_opening` when continuing within the same scene.';
}
const PRONOUN_RE   = /\b(him|her|them|there)\b/i;
const SPEECH_VERBS = ['says', 'states', 'explains', 'claims', 'adds', 'continues', 'replies', 'notes', 'murmurs', 'answers'];

// ── Period time string ────────────────────────────────────────────────────────

const PERIOD_NUMS = ['','one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen',
  'twenty','twenty-one','twenty-two','twenty-three','twenty-four','twenty-five',
  'twenty-six','twenty-seven','twenty-eight','twenty-nine'];
const PERIOD_HOURS = ['twelve','one','two','three','four','five','six','seven','eight','nine','ten','eleven'];

export function timeToPeriodString(minutesRemaining, sessionTargetMinutes = 30) {
  const elapsed = sessionTargetMinutes - (minutesRemaining ?? 0);
  const total   = 9 * 60 + 30 + Math.max(0, elapsed);
  const h = Math.floor(total / 60) % 12;
  const m = total % 60;
  const hw = PERIOD_HOURS[h], nw = PERIOD_HOURS[(h + 1) % 12];
  if (m === 0)  return `${hw} o'clock`;
  if (m === 15) return `quarter past ${hw}`;
  if (m === 30) return `half past ${hw}`;
  if (m === 45) return `quarter to ${nw}`;
  if (m < 30 && m < PERIOD_NUMS.length)  return `${PERIOD_NUMS[m]} past ${hw}`;
  const rem = 60 - m;
  return rem < PERIOD_NUMS.length ? `${PERIOD_NUMS[rem]} to ${nw}` : hw;
}

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
    .replace('{{SENSORY_OPENING_RULE}}', buildNarrativeStyleRules(scenario.sensory_opening));
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

function buildAliasProtectionBlock(state) {
  if (!Array.isArray(state.playerAliases) || state.playerAliases.length === 0) return '';

  const allNames = [
    state.playerRealName,
    state.playerCoverName,
    ...state.playerAliases.map(a => a.name),
  ].filter((n, i, arr) => n && arr.indexOf(n) === i);

  const knownAsMap   = state.playerKnownAs || {};
  const knownAsLines = Object.entries(knownAsMap)
    .map(([who, name]) => `- ${who.replace(/_/g, ' ')}: ${name}`)
    .join('\n');

  return [
    'IDENTITY PROTECTION — ALL OF THE FOLLOWING REFER TO THE SAME PERSON (THE PLAYER):',
    allNames.join(', '),
    '',
    'This character operates under multiple names. These are not different people. There is one person and they are the player.',
    '',
    'Never write any of these names as an NPC, bystander, or third party in any scene. If any of these names appears in your output as anyone other than the player, rewrite it.',
    ...(knownAsLines ? ['', 'How other characters address the player:', knownAsLines] : []),
  ].join('\n');
}

function buildPlayerRoleSection(state) {
  const roleId      = state.playerRoleId    || 'unknown';
  const roleName    = state.playerRoleName  || 'Investigator';
  const perspective = state.playerPerspective || 'The player is an investigator.';
  const accessLevel = state.playerAccessLevel || 'staff';
  const knowledge   = (state.playerStartingKnowledge || []).join('; ');

  const lines = [
    `Role: ${roleName} (id: ${roleId}) | Access: ${accessLevel}`,
    `Perspective: ${perspective}`,
    `Starting knowledge: ${knowledge || 'none'}`,
    `HARD RULE: The player is ${roleName}. Never address them as a different character. Never have ${roleName} appear as an NPC speaking to the player.`,
  ];

  const aliasBlock = buildAliasProtectionBlock(state);
  if (aliasBlock) lines.push('', aliasBlock);

  return lines.join('\n');
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
  const hasConspirators = (state.namedConspirators || []).length >= 1;
  const isLateTurn      = (state.remainingMinutes ?? 0) <= 5 || state.finalAccusation;
  return {
    readyForClimax: hasConspirators || isLateTurn,
  };
}

export function composeTurnPrompt(state, playerInput, { scenario, characters, locations, clues }) {
  const location      = getLocationById(state.location, locations);
  const relevantChars = getRelevantCharacters(state, location, characters, locations);
  const charRoutes    = buildCharacterRoutes(characters, locations);
  const endingSignals = checkEndingReadiness(state, scenario);

  const refContext    = buildReferenceContext(playerInput, state, locations);
  const resolvedInput = refContext ? `${playerInput}\n${refContext}` : playerInput;

  const finalAccusationNote = state.finalAccusation
    ? '\n\n⚠️ FINAL ACCUSATION: The player has chosen to end the investigation and make their final accusation. This is their last move. You MUST return endState with isEnding: true. Evaluate as strong/partial/weak based on the player\'s reasoning and what they have observed.'
    : '';

  // Replace raw minute count with period-appropriate time language
  const { remainingMinutes, ...stateRest } = state;
  const promptState = {
    ...stateRest,
    timeOfNight: timeToPeriodString(remainingMinutes, scenario.sessionTargetMinutes),
  };

  return turnTemplate
    .replace('{{PLAYER_ROLE_SECTION}}',    buildPlayerRoleSection(state))
    .replace('{{STATE_JSON}}',             JSON.stringify(promptState))
    .replace('{{LOCATION_JSON}}',          JSON.stringify(slimLocation(location)))
    .replace('{{NPC_JSON}}',               JSON.stringify(relevantChars))
    .replace('{{NPC_ROUTES_JSON}}',        JSON.stringify(charRoutes))
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
