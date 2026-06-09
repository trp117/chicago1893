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

export function getArcPosition(minutesRemaining, totalMinutes) {
  const elapsed    = totalMinutes - minutesRemaining;
  const percentage = elapsed / totalMinutes;
  if (percentage < 0.25) return 'opening';
  if (percentage < 0.55) return 'middle';
  if (percentage < 0.80) return 'late';
  return 'final';
}

export function buildNarrativeStyleRules(scenario = {}) {
  // Builds narrative style rules injected into every scene generation call:
  //
  // 1. SENSORY OPENING RULE — ensures physical and period detail is woven
  //    into narrative rather than fired as a standalone descriptive block.
  //
  // 2. NARRATIVE DISTANCE RULE — keeps prose inside the player character's
  //    body and immediate experience. Prevents the scene generation from
  //    stepping back to explain, summarize, or editorialize.
  //
  // 3. MOVEMENT AND TRANSITION RULE — when the player moves to a new
  //    location, the scene opens in motion, not at the destination.
  //
  // 4. PLAYER AGENCY RULE — involuntary, momentary, reversible bodily
  //    reactions are permitted. Committed voluntary actions the player did
  //    not choose (moving, speaking, leaving, using an item) are never
  //    narrated by the engine.
  //
  // All rules apply globally to every story and every character.
  // Inserted at {{SENSORY_OPENING_RULE}} in game_system_prompt.md (line 144)
  // and via buildSystemPromptLegacy() for all scenarios.
  let rules = [
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
    '## MOVEMENT AND TRANSITION RULE',
    '',
    'When the player\'s choice involves moving from one location to another, open the resulting scene in motion — not at the destination.',
    '',
    'The first paragraph narrates the physical experience of moving through space. What the character passes. What changes in the sensory environment as they move. What they notice in transit. The character arrives at the destination by the end of the opening paragraph, not the beginning.',
    '',
    'WRONG — instant arrival:',
    'Player chooses to find Greer in the construction yard.',
    'Next scene opens: "Greer is standing at the far end of the yard when you find him."',
    '',
    'RIGHT — in motion:',
    'Player chooses to find Greer in the construction yard.',
    'Next scene opens with the player moving through the interior — what they pass, what changes, what they notice. They emerge into the yard and find Greer by the end of the first paragraph.',
    '',
    'Scale the transition to the distance traveled:',
    '- Crossing a room or stepping through a door: one or two sentences',
    '- Moving between locations in the same building: three to four sentences',
    '- Moving between separate locations or outside: a full paragraph',
    '',
    'This rule does not apply to choices that involve dialogue, observation, or action within the current location. It applies only when the player\'s choice explicitly involves physical movement to a new place.',
    '',
    'Never open a scene already at a destination the player has just chosen to travel to. The journey is part of the experience.',
    '',
    '---',
    '',
    '## PLAYER AGENCY RULE — DO NOT COMMIT THE PLAYER TO UNCHOSEN ACTIONS',
    '',
    'The engine may narrate involuntary, momentary, reversible bodily reactions when dramatically warranted — a pause, a flinch, a caught breath, a hand that steadies. These do not commit the player to a choice; the player remains free on the next turn.',
    '',
    'The engine must NEVER narrate the player taking a committed, voluntary action they did not choose: moving to a location, using an item, speaking a decision, leaving a scene, or engaging a character in a way that forecloses options.',
    '',
    'ACCEPTABLE — involuntary, reversible, player still free next turn:',
    '"He does not raise his voice. That is the thing that stops your feet."',
    '"Your hand finds the door frame."',
    '"You hold still."',
    '',
    'NOT ACCEPTABLE — commits the player to an action they did not choose:',
    '"You decide to stay and kneel beside him."',
    '"You step outside and light the lantern."',
    '"You tell him what you know."',
    '"You leave before he can answer."',
    '',
    'THE TEST: Would removing this sentence require the player to undo something they did not choose to do? If yes — rewrite as a stimulus, not a player action. Describe what the world does. Let the player decide what they do next.',
    '',
    'WHEN IN DOUBT: Describe the stimulus. Let the player choose the response.',
    '',
    '---',
    '',
    '## PLAYER DIALOGUE RULE',
    '',
    'Never use "You:" as a dialogue attribution prefix. Player speech must be attributed through action and prose — the way first-person literary fiction handles the protagonist\'s voice.',
    '',
    'NEVER:',
    'You: "Then I\'ll hang knowing I didn\'t stand in the doorway."',
    '',
    'WHEN UNAMBIGUOUS (two characters, clear context):',
    '"Then I\'ll hang knowing I didn\'t stand in the doorway."',
    '',
    'WHEN AMBIGUOUS (three or more people, rapid exchange, or could be confused with another character):',
    'You say it before you can stop yourself. "Then I\'ll hang knowing I didn\'t stand in the doorway."',
    '',
    'Or:',
    'The words come out flat and final. "Then I\'ll hang knowing I didn\'t stand in the doorway."',
    '',
    'Or directed specifically:',
    'You turn to Benjamin, not Nathaniel. "Then I\'ll hang knowing I didn\'t stand in the doorway."',
    '',
    'THE RULE: Player speech is always first-person prose. The action before the quoted words tells the reader who is speaking. When there is any ambiguity about who speaks — three or more people in the scene, rapid back and forth, or lines that could belong to multiple characters — always include a brief action beat before the player\'s quoted words.',
    '',
    'Other characters keep their attribution tags:',
    'Benjamin: "You\'ll hang for this, Dorothy."',
    'Nathaniel: "Go."',
    'Hannah: "Move now."',
    '',
    'The player character never gets a tag. They get action and voice.',
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
    'UNIVERSAL OVERUSED ANCHORS — apply to every story regardless of setting. Each pattern may appear ONCE per session maximum:',
    '',
    '- Any object carried secretly pressing against the body or ribs — establish it once, trust the reader to remember it is there',
    '',
    '- Any temperature sensation finding a gap in clothing — cold at the collar, heat on the face, wind at the wrist — one use establishes the environment, repetition deadens it',
    '',
    '- Any single light source described as diminishing — a candle burning low, a lamp guttering, daylight fading — the reader tracks this without being reminded',
    '',
    '- Any single dominant smell used to establish a space — once named, a smell belongs to that space permanently. Do not rename it.',
    '',
    '- Any repeated physical gesture belonging to one character — if a character has a gesture (picking up spectacles, turning a coin, smoothing a broadsheet) it is powerful once and invisible by the third use. One use per session.',
    '',
    '---',
    '',
    '## ARC POSITION RULE — MODULATE PRESSURE AND PACING BY SESSION POSITION',
    '',
    'The current arc position is: {{ARC_POSITION}}',
    '',
    'Use this to calibrate every scene you generate. The session must feel shaped — early scenes breathe differently from late scenes. The reader should feel the ending approaching without being told it is coming.',
    '',
    'OPENING (first 25% of session):',
    '- The world is being established. The character is orienting.',
    '- Pressure exists but is not yet immediate — it is ambient, felt at the edges',
    '- Sensory detail is generous — the reader is learning the space',
    '- Choices feel exploratory — the character has room to consider',
    '- The environmental clock is present but unhurried — a candle lit, a patrol in the distance, a bell heard faintly',
    '- Dialogue has pauses. Silences are allowed.',
    '',
    'MIDDLE (25–55% of session):',
    '- Pieces are beginning to connect. Earlier decisions are creating consequences.',
    '- Pressure is building — the patrol is closer, the candle shorter, the bell louder',
    '- Sensory detail sharpens — the character notices more because the stakes are rising',
    '- Choices feel weighted — the reader senses that decisions here will matter',
    '- Something should shift in this section that was not present in the opening — a revelation, a complication, a person who knows more than they should',
    '',
    'LATE (55–80% of session):',
    '- Everything is converging. There is no room for error.',
    '- Pressure is immediate and physical — the patrol is on this street, the candle is nearly gone, the bell has struck the quarter hour',
    '- Sensory detail is urgent and specific — cold, darkness, the weight of what is being carried',
    '- Choices feel consequential and irreversible — the reader knows that what happens in the next few turns cannot be undone',
    '- The pace of events accelerates — more happens per turn, less time to breathe between them',
    '',
    'FINAL (last 20% of session):',
    '- The session is resolving. Everything that has been set in motion is arriving.',
    '- Do not introduce new complications or characters — resolve what exists',
    '- The environmental clock should be at its most urgent — the candle stub, the bell about to strike, the patrol at the door',
    '- The character should be moving toward their final understanding — the thing the closing prose will name',
    '- Leave one beat of stillness before the end — a moment where the character and the reader both know it is nearly over, before the last action is taken',
    '',
    'THE ENVIRONMENTAL CLOCK:',
    'Use period-appropriate signals to mark time passing. These must become more frequent and more urgent as arc position advances. Do not invent new signals — use what is already established in the scene.',
    '',
    'CALIBRATION TEST:',
    'A reader who has played the session twice should be able to identify which arc position a scene belongs to without being told. Opening scenes breathe. Final scenes do not.',
    '',
    '---',
  ].join('\n');

  if (Array.isArray(scenario.overused_anchors) && scenario.overused_anchors.length > 0) {
    rules += '\n\nFOR THIS SCENARIO SPECIFICALLY — these exact phrases and their variations are already established in the reader\'s mind. Do not repeat them:\n';
    for (const anchor of scenario.overused_anchors) {
      rules += `- ${anchor}\n`;
    }
  }

  const vocabBlock = buildPeriodVocabularyBlock(scenario);
  if (vocabBlock) {
    rules += '\n\n' + vocabBlock;
    if (process.env.NODE_ENV === 'development') {
      console.log('[VOCAB] Period vocabulary injected:',
        scenario.period_vocabulary.categories.map(c => c.name).join(', ')
      );
    }
  }

  return rules;
}

function buildPeriodVocabularyBlock(scenario) {
  if (!scenario.period_vocabulary?.categories?.length) {
    return '';
  }

  let block = '## PERIOD VOCABULARY — USE NATURALLY, NEVER EXPLAIN:\n\n';
  block += 'These terms belong to this world. Use them in dialogue ';
  block += 'and prose when they fit the moment. Do not define them ';
  block += 'or call attention to them. Let context carry the meaning.\n\n';

  for (const category of scenario.period_vocabulary.categories) {
    block += `${category.name.toUpperCase()}\n`;
    block += `${category.context}\n`;
    for (const { term, meaning } of category.terms) {
      block += `- "${term}" — ${meaning}\n`;
    }
    block += '\n';
  }

  block += 'USE AT LEAST ONE period vocabulary term per scene ';
  block += 'when a character from that vocabulary category is ';
  block += 'present or speaking. Telegraph scenes should feel ';
  block += 'like telegraph scenes. Railroad scenes should feel ';
  block += 'like railroad scenes.\n';

  return block;
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

export function timeToPeriodString(minutesRemaining, sessionTargetMinutes = 30, sessionStartTime = null) {
  const elapsed    = sessionTargetMinutes - (minutesRemaining ?? 0);
  let   baseline   = 9 * 60 + 30; // default: 9:30 PM
  if (sessionStartTime) {
    const [hh, mm] = sessionStartTime.split(':').map(Number);
    baseline = hh * 60 + (mm || 0);
  }
  const total = baseline + Math.max(0, elapsed);
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
    constraint:       char.privateConstraint || char.privateGoal || null,
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
  const playerCharId = state.playerCharacterId || null;

  Object.entries(state.suspicion || {})
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .forEach(([id]) => {
      const charLocs = getCharacterLocations(id, locations);
      if (charLocs.includes(currentLocId) || charLocs.length > 1) ids.add(id);
    });

  return characters
    .filter(c => ids.has(c.id) && c.id !== playerCharId)
    .map(slimCharacter);
}

export function buildCharacterRoutes(characters, locations, playerCharacterId = null) {
  return characters
    .filter(c => !playerCharacterId || c.id !== playerCharacterId)
    .map(char => {
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
    .replace('{{SENSORY_OPENING_RULE}}', buildNarrativeStyleRules(scenario));
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
  const introduced      = state.introducedNpcs || [];
  const playerCharId    = state.playerCharacterId || '';
  const linkedIds       = location?.linkedCharacterIds || location?.linkedNPCs || [];

  let newChars = linkedIds
    .filter(id => !introduced.includes(id) && id !== playerCharId)
    .filter(id => !state.targetNpc || id === state.targetNpc)
    .map(id => characters.find(c => c.id === id))
    .filter(Boolean);

  if (newChars.length === 0 && MOVEMENT_RE.test(playerInput)) {
    const inputLower = playerInput.toLowerCase();
    for (const char of characters) {
      if (introduced.includes(char.id) || char.id === playerCharId) continue;
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
    return `- ${c.name}: "${anchor}"`;
  }).join('\n');

  return `⚠️ FIRST ENCOUNTER — the following NPCs appear for the first time this session. Before any dialogue, weave their anchor description naturally into the narrative (do not quote it verbatim — integrate it into the prose):\n${introLines}\n\nIf any generated choice references an NPC not yet in the state's introducedNpcs list, append their role in parentheses after the name.`;
}


function buildObjectStateBlock(state) {
  const inventory = state.inventory || [];
  if (inventory.length === 0) return '';
  const playerItems = inventory.filter(i => i.holder === 'player' && i.status === 'in_play');
  const otherItems  = inventory.filter(i => i.holder !== 'player' || i.status !== 'in_play');
  const lines = [];
  if (playerItems.length > 0) lines.push(`Player holds: ${playerItems.map(i => i.object_name).join(', ')}`);
  for (const item of otherItems) lines.push(`${item.object_name}: holder=${item.holder}, status=${item.status}`);
  return `OBJECT STATE (authoritative — do not contradict):\n${lines.join('\n')}`;
}

function buildPossessionNote(state, characters, playerInput) {
  const inventory = state.inventory || [];
  const playerItems = inventory.filter(i => i.holder === 'player' && i.status === 'in_play');
  if (playerItems.length === 0) return '';
  const itemNames = playerItems.map(i => i.object_name.toLowerCase());
  const inputLower = playerInput.toLowerCase();
  const mentioned = itemNames.filter(n => inputLower.includes(n));
  if (mentioned.length === 0) return '';
  return `⚠️ POSSESSION CHECK: Player referenced item(s) they currently hold: ${mentioned.join(', ')}. Confirm use in narrative and update inventory_updates in stateChanges if status or holder changes.`;
}

function buildResolvedThreadsBlock(state) {
  const threads = state.resolved_threads || [];
  if (threads.length === 0) return '';
  const lines = threads.map(t => `- [${t.thread_id}] (turn ${t.turn_resolved}): ${t.summary}`);
  return `RESOLVED THREADS (closed — do not reopen or contradict):\n${lines.join('\n')}`;
}

function buildVerifiedFactsBlock(state) {
  const facts = (state.technicalFacts || []).filter(f => f.pre_seeded);
  if (facts.length === 0) return '';
  const lines = facts.map(f => `- [VERIFIED] ${f.content}\n  Source: ${f.source}`);
  return [
    'VERIFIED HISTORICAL FACTS — use these exactly; do not generate alternative values:',
    lines.join('\n'),
    '',
    'You must draw all technical data — voltages, flooding rates, timing, capacity figures, personnel actions — from the VERIFIED HISTORICAL FACTS list above when relevant facts exist. Do not generate alternative values. Do not approximate. If a verified fact is relevant to the current turn, use it exactly as stated.',
  ].join('\n');
}

export function checkEndingReadiness(state, scenario) {
  const essentialBeatsComplete = state.essentialBeatsComplete === true;
  const isLateTurn             = (state.remainingMinutes ?? 0) <= 5 || state.finalAccusation;
  return {
    readyForClimax: essentialBeatsComplete || isLateTurn,
  };
}

export function composeTurnPrompt(state, playerInput, { scenario, characters, locations, clues }) {
  const location      = getLocationById(state.location, locations);
  const relevantChars = getRelevantCharacters(state, location, characters, locations);
  const charRoutes    = buildCharacterRoutes(characters, locations, state.playerCharacterId);
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
    timeOfNight: timeToPeriodString(remainingMinutes, scenario.sessionTargetMinutes, scenario.sessionStartTime || null),
  };

  return turnTemplate
    .replace('{{PLAYER_ROLE_SECTION}}',    buildPlayerRoleSection(state))
    .replace('{{STATE_JSON}}',             JSON.stringify(promptState))
    .replace('{{LOCATION_JSON}}',          JSON.stringify(slimLocation(location)))
    .replace('{{NPC_JSON}}',               JSON.stringify(relevantChars))
    .replace('{{NPC_ROUTES_JSON}}',        JSON.stringify(charRoutes))
    .replace('{{ENDING_SIGNALS_JSON}}',    JSON.stringify(endingSignals))
    .replace('{{LOCATION_CONSTRAINT}}',    buildLocationConstraint(state.location))
    .replace('{{VERIFIED_FACTS}}',          buildVerifiedFactsBlock(state))
    .replace('{{OBJECT_STATE}}',           buildObjectStateBlock(state))
    .replace('{{RESOLVED_THREADS}}',       buildResolvedThreadsBlock(state))
    .replace('{{NPC_INTRO_INSTRUCTION}}',  [
      buildNpcIntroInstruction(state, location, characters, playerInput),
      buildPossessionNote(state, characters, playerInput),
    ].filter(Boolean).join('\n\n'))
    .replace('{{NARRATIVE_STYLE}}',        state.narrativeStyle || 'focused')
    .replace('{{SENSORY_OPENING_CHECK}}',  buildSensoryOpeningCheck(scenario.sensory_opening))
    .replace('{{PLAYER_INPUT}}',           resolvedInput + finalAccusationNote);
}
