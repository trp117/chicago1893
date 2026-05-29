import { Router } from 'express';
import { Langfuse } from 'langfuse';
import Anthropic from '@anthropic-ai/sdk';
import { readdir, readFile, unlink, stat } from 'fs/promises';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import PipelineOrchestrator from '../services/PipelineOrchestrator.js';
import VersionController from '../services/VersionController.js';

let _anthropicClient = null;
function getAnthropicClient(apiKey) {
  if (!_anthropicClient) _anthropicClient = new Anthropic({ apiKey });
  return _anthropicClient;
}

const _dir = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = join(_dir, '../data/transcripts');
const REVIEWS_DIR     = join(_dir, '../../data/reviews');

const langfuse = (process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY)
  ? new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      publicKey:  process.env.LANGFUSE_PUBLIC_KEY,
      baseUrl:    process.env.LANGFUSE_BASE_URL,
    })
  : null;

function slugify(str) {
  return (str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function notFound(res) { return res.status(404).json({ error: 'Not found.' }); }
function badRequest(res, msg) { return res.status(400).json({ error: msg }); }

// Safely extract briefing as a plain string regardless of how it was stored.
// Older scenario generation returned { who, mission, stakes } objects instead of a flat string.
function getBriefingText(briefing) {
  if (!briefing) return '';
  if (typeof briefing === 'string') return briefing.trim();
  if (Array.isArray(briefing)) return briefing.join(' ').trim();
  if (typeof briefing === 'object') return Object.values(briefing).filter(Boolean).join(' ').trim();
  return String(briefing).trim();
}

// Normalize a player role's briefing field to a plain string in-place.
function normalizeBriefing(role) {
  if (role.briefing && typeof role.briefing !== 'string') {
    role.briefing = getBriefingText(role.briefing);
  }
  return role;
}

// Strip ending_notes sub-objects that have no actual content so that saving
// a preview form never writes empty ending_notes structures into role files.
function stripEmptyEndingNotes(role) {
  if (!role.ending_notes) return role;
  for (const type of ['partial', 'failure']) {
    const notes = role.ending_notes[type];
    if (!notes) continue;
    const hasContent = Object.values(notes).some(v => typeof v === 'string' && v.trim());
    if (!hasContent) delete role.ending_notes[type];
  }
  if (!role.ending_notes.partial && !role.ending_notes.failure) {
    delete role.ending_notes;
  }
  return role;
}

// ── Generation helpers ────────────────────────────────────────────────────────

function extractJson(raw) {
  const trimmed = (raw || '').trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const first = trimmed.indexOf('{'), last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
  throw new Error('No valid JSON found in model response.');
}

function extractAndValidateJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function validateGeneratedScenario(generated) {
  const errors = [];
  const roles = generated.playerRoles || [];

  if (roles.length === 0) errors.push('No playerRoles defined');

  roles.forEach(role => {
    if (getBriefingText(role.briefing).length < 50)
      errors.push(`Role "${role.id}" missing or too-short briefing`);
    if (!role.name)
      errors.push(`Role "${role.id}" missing name`);
    if (!role.description)
      errors.push(`Role "${role.id}" missing description`);
  });

  const sections = generated.scenario?.introduction?.sections;
  if (!sections || sections.length === 0)
    errors.push('Missing introduction sections');

  if (!generated.scenario?.sessionTargetMinutes)
    errors.push('Missing scenario.sessionTargetMinutes');

  return errors;
}

// Validates a scenario + its separately-loaded player roles (stored format).
// Returns { errors: string[], warnings: string[] }
// errors   = blocking (red) — scenario cannot be considered complete
// warnings = non-blocking (yellow) — require human review before publication
function validateStoredScenario(scenario, playerRoles, characters = []) {
  const errors = [];
  const warnings = [];

  if (!playerRoles || playerRoles.length === 0) errors.push('No playerRoles defined');
  (playerRoles || []).forEach(role => {
    if (getBriefingText(role.briefing).length < 50)
      errors.push(`Role "${role.id}" missing or too-short briefing`);
    if (!role.name)        errors.push(`Role "${role.id}" missing name`);
    if (!role.description) errors.push(`Role "${role.id}" missing description`);
  });
  if (!scenario?.introduction?.sections?.length) errors.push('Missing introduction sections');
  if (!scenario?.sessionTargetMinutes)           errors.push('Missing sessionTargetMinutes');

  const entrySection = scenario?.introduction?.sections?.find(s => s.type === 'entry');
  (playerRoles || []).forEach(role => {
    const entry = entrySection?.character_entries?.[role.id];
    if (!entry || entry.trim().length < 50)
      errors.push(`Missing entry paragraph for ${role.name} — click Repair to generate`);
    if (!role.context_sentence || role.context_sentence.trim().length < 10)
      errors.push(`Missing context sentence for ${role.name} — click Repair to generate`);
  });

  // ── Character type declarations ────────────────────────────────────────────
  // Player roles: missing character_type is blocking (red)
  (playerRoles || []).forEach(role => {
    if (!role.character_type) {
      errors.push(
        `Role "${role.name}" missing character_type (real/fictional/composite) — required for Historical Record`
      );
    }
    if ((role.character_type === 'fictional' || role.character_type === 'composite') && !role.represents) {
      errors.push(
        `Role "${role.name}" is ${role.character_type} but missing "represents" field — required for Historical Record generation`
      );
    }
    // fact_checked: false on any role is a yellow warning
    if (role.character_type && role.fact_checked === false) {
      warnings.push(
        `Role "${role.name}" has character_type "${role.character_type}" but fact_checked is false — human verification required before publication`
      );
    }
    // bridge_sentence [DRAFT] prefix = yellow warning (needs author review)
    if (role.bridge_sentence?.startsWith('[DRAFT]')) {
      warnings.push(
        `Role "${role.name}" bridge_sentence is a draft — remove [DRAFT] prefix after author review`
      );
    }
    if (role.entry_paragraph_flags?.length > 0) {
      warnings.push(
        `Role "${role.name}" entry paragraph has ${role.entry_paragraph_flags.length} going-wide flag(s) — review before publishing`
      );
    }
  });

  // NPC characters: Tier 1 (in epilogue) = blocking; Tier 2 (other named) = warning
  const epilogueCharacterIds = new Set(
    (scenario?.epilogue?.character_fates || []).map(f => f.character_id).filter(Boolean)
  );

  characters.forEach(char => {
    const inEpilogue = epilogueCharacterIds.has(char.id);
    if (!char.character_type) {
      if (inEpilogue) {
        errors.push(
          `NPC "${char.name}" appears in Historical Record but missing character_type — blocking (Tier 1)`
        );
      } else {
        warnings.push(
          `NPC "${char.name}" missing character_type (real/fictional/composite) — yellow warning (Tier 2)`
        );
      }
    } else {
      // fact_checked: false is always a yellow warning
      if (char.fact_checked === false) {
        warnings.push(
          `NPC "${char.name}" has character_type "${char.character_type}" but fact_checked is false — needs verification`
        );
      }
    }
  });

  // Glossary warnings (non-blocking)
  if (!scenario.glossary || scenario.glossary.length === 0) {
    warnings.push('Glossary is empty — consider adding period vocabulary definitions. Use "Suggest terms" in the admin.');
  } else if (scenario.glossary.length < 5) {
    warnings.push(`Glossary has only ${scenario.glossary.length} term(s) — run "Suggest terms" to find additional vocabulary.`);
  }

  return { errors, warnings };
}

// Calls the Anthropic API to write a briefing for a single role.
async function generateBriefingText(scenario, role, anthropicApiKey) {
  const introText = (scenario.introduction?.sections || [])
    .map(s => s.text || '').filter(Boolean).join('\n\n');

  const prompt = [
    'Write a character briefing for an immersive historical fiction experience.',
    '',
    `SCENARIO: ${scenario.title}`,
    introText ? `SCENARIO INTRODUCTION:\n${introText}` : '',
    '',
    `CHARACTER: ${role.name}`,
    `DESCRIPTION: ${role.description || ''}`,
    role.perspective ? `PERSPECTIVE: ${role.perspective}` : '',
    '',
    'Write a briefing paragraph of 150-250 words in second person present tense.',
    'Place the player inside this character\'s consciousness at the exact moment the story begins.',
    '',
    'The briefing must:',
    '- Place the character in a specific physical location at the story\'s opening moment',
    '- Reference what this character uniquely knows that others do not',
    '- Establish their emotional and physical state right now — not backstory',
    '- End at the exact threshold of their first choice — the last breath before the player acts',
    '- Match the literary voice of the scenario introduction exactly',
    '',
    'Write only the briefing paragraph. No preamble, no explanation, no quotation marks.',
  ].filter(Boolean).join('\n');

  const msg = await getAnthropicClient(anthropicApiKey).messages.create(
    { model: 'claude-sonnet-4-6', max_tokens: 600, temperature: 0.8, messages: [{ role: 'user', content: prompt }] },
    { timeout: 60_000 }
  );
  const text = msg.content[0]?.text?.trim();
  if (!text) throw new Error('No text returned from Anthropic');
  return text;
}

async function generateCharacterEntry(scenario, role, allRoles, anthropicApiKey) {
  const introText = (scenario.introduction?.sections || [])
    .filter(s => s.type !== 'entry')
    .map(s => s.text || '').filter(Boolean).join('\n\n');

  const otherRoleNames = (allRoles || [])
    .filter(r => r.id !== role.id)
    .map(r => r.name)
    .join(', ');

  const prompt = [
    'Write a character entry paragraph for an immersive historical fiction experience.',
    '150-200 words, second person present tense.',
    '',
    `SCENARIO: ${scenario.title}`,
    introText ? `SCENARIO INTRODUCTION:\n${introText}` : '',
    '',
    `CHARACTER: ${role.name}`,
    `DESCRIPTION: ${role.description || ''}`,
    getBriefingText(role.briefing) ? `CHARACTER BRIEFING (use as foundation):\n${getBriefingText(role.briefing)}` : '',
    role.perspective ? `PERSPECTIVE: ${role.perspective}` : '',
    role.startingKnowledge?.length
      ? `WHAT THIS CHARACTER KNOWS:\n${role.startingKnowledge.map(k => `- ${k}`).join('\n')}`
      : '',
    otherRoleNames ? `OTHER PLAYERS IN THIS SCENARIO: ${otherRoleNames}` : '',
    '',
    'The paragraph must:',
    '- Place this character in a specific physical location at the story\'s opening moment',
    '- Reference what they uniquely know that the others do not',
    '- Establish their emotional and physical state right now — not backstory',
    '- End at the exact threshold of their first choice — the last breath before they act',
    '- Match the literary voice of the scenario introduction exactly',
    '- Second person present tense throughout',
    '',
    'CRITICAL — FIRST LINE RULE:',
    'Never open with "You are [character name]" or any variation that names or introduces the character.',
    'The reader is already inside the character. Begin with physical placement — where they are standing,',
    'what their body is registering, what they can see or hear or smell right now.',
    '',
    'WRONG: "You are Elias Cutter, and you are standing..."',
    'WRONG: "You are a veteran conductor standing..."',
    'WRONG: "As the conductor, you find yourself..."',
    'RIGHT: "You are standing in the dark behind the freight house..."',
    'RIGHT: "The freight house door is ten feet away and..."',
    'RIGHT: "Coal smoke and wet ballast — that is what..."',
    '',
    'The first word should place the reader in a body at a specific location. Never in an identity.',
    '',
    'Write only the paragraph. No preamble, no explanation.',
  ].filter(Boolean).join('\n');

  const msg = await getAnthropicClient(anthropicApiKey).messages.create(
    { model: 'claude-sonnet-4-6', max_tokens: 500, temperature: 0.8, messages: [{ role: 'user', content: prompt }] },
    { timeout: 60_000 }
  );
  const text = msg.content[0]?.text?.trim();
  if (!text) throw new Error('No text returned from Anthropic');
  return text;
}

async function generateContextSentence(scenario, role, anthropicApiKey) {
  const introText = (scenario.introduction?.sections || [])
    .filter(s => s.type !== 'entry')
    .map(s => s.text || '').filter(Boolean).join('\n\n');

  const content = `Write a single context sentence for a character in an immersive historical fiction experience.

SCENARIO: ${scenario.title}
SETTING: ${scenario.setting || ''}
HISTORICAL CONTEXT:
${introText.slice(0, 600)}

CHARACTER NAME: ${role.name}
CHARACTER DESCRIPTION: ${role.description || ''}
CHARACTER BRIEFING: ${getBriefingText(role.briefing) || ''}

Write ONE sentence only. Second person.

CRITICAL — this sentence must place the character in their immediate physical situation. It must not be a biography.

The sentence must answer: who are you and what is happening to you RIGHT NOW. Not who you are in history. Not what led to this moment. What is happening in your immediate situation in this specific second.

WRONG — biographical (do not write this):
"You are Jim Lovell, commander of Apollo 13 and the most traveled astronaut in history with 572 hours in space, whose mission to the Fra Mauro Highlands was aborted on April 13, 1970, after an oxygen tank exploded."

WRONG — too much history (do not write this):
"You are Jack Swigert, who replaced Ken Mattingly three days before launch after a measles exposure scare and is now the Command Module Pilot on humanity's most dangerous spaceflight."

WRONG — psychological or poetic (do not write this):
"You are the one who reads rooms the way others read faces."

RIGHT — immediate placement (write this style):
"You are Jim Lovell, Mission Commander of Apollo 13, and your spacecraft is dying around you."

RIGHT — immediate placement (write this style):
"You are Jack Swigert, the Command Module Pilot, and you have four minutes of power left."

RIGHT — immediate placement (write this style):
"You are Joseph McNeil, one of the four students who sat down at the Woolworth's lunch counter, and the white manager is walking toward you."

PATTERN: "You are [name], [their role in this moment], and [what is happening to them right now]."

Maximum 20 words. One clause describing identity. One clause describing immediate situation. Nothing else. No preamble. No explanation. Just the sentence.`;

  const msg = await getAnthropicClient(anthropicApiKey).messages.create(
    { model: 'claude-sonnet-4-6', max_tokens: 120, temperature: 0.7, messages: [{ role: 'user', content }] },
    { timeout: 30_000 }
  );
  const text = msg.content[0]?.text?.trim();
  if (!text) throw new Error('No text returned from Anthropic');
  return text;
}

function detectGoingWide(text) {
  const patterns = [
    { pattern: /in the way that/gi,                              label: 'pattern explanation' },
    { pattern: /the kind of .{1,30} that/gi,                    label: 'pattern explanation' },
    { pattern: /the sort of .{1,30} that/gi,                    label: 'pattern explanation' },
    { pattern: /you (understand|realize|know) that/gi,          label: 'narrator intrusion' },
    { pattern: /which means/gi,                                  label: 'explanation' },
    { pattern: /that is to say/gi,                               label: 'explanation' },
    { pattern: /in other words/gi,                               label: 'explanation' },
    { pattern: /the (particular|specific) .{1,30} of (a|an|the)/gi, label: 'going wide' },
    { pattern: /as if .{1,40} had/gi,                           label: 'simile explanation' },
  ];

  const flags = [];
  patterns.forEach(({ pattern, label }) => {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach(match => {
        flags.push({
          pattern: label,
          text: match,
          message: `Possible going-wide (${label}): "${match}" — review this sentence`
        });
      });
    }
  });

  return flags;
}

async function generateBridgeSentence(scenario, role, anthropicApiKey) {
  const sceneSection = (scenario.introduction?.sections || []).find(s => s.type === 'scene');
  const sceneParagraph = sceneSection?.text?.trim() || '';
  if (!sceneParagraph) throw new Error('No scene paragraph found in scenario introduction');

  const content = `Write a single bridge sentence for a player role in an immersive historical fiction experience.

SCENARIO: ${scenario.title}

SCENE PARAGRAPH (what the player just read on the previous screen):
${sceneParagraph}

CHARACTER: ${role.name}
CHARACTER DESCRIPTION: ${role.description || ''}
CHARACTER BRIEFING: ${getBriefingText(role.briefing) || ''}

Write ONE sentence only. 15 words or fewer.

This sentence is the first thing the player reads AS this specific character. It picks up ONE physical detail from the scene paragraph above — a detail that this particular character would be most immediately aware of given their position and role. It drops them into the present moment of the character without repeating or summarising the scene.

RULES:
- One sentence. 15 words or fewer. No exceptions.
- Pick ONE specific physical detail from the scene paragraph.
- Present tense.
- Do not name the character.
- Do not summarise the situation.
- Do not repeat the scene paragraph.
- Specific and physical — not emotional, not contextual.

CORRECT examples (study the pattern):
"The master alarm stopped screaming forty seconds ago." (Jack Swigert, Apollo 13)
"The waitress has walked away." (Joseph McNeil, Greensboro sit-in)
"The barn window is dark." (Elias Cole, Underground Railroad)
"The tide is at your elbows now." (Battalion Medic, D-Day)

WRONG examples:
"The situation is desperate and time is running out." (too vague, summarises)
"You are standing at the threshold of history." (poetic, not physical)
"The room is full of tension as everyone waits." (emotional, not specific)

Write only the sentence. No preamble, no explanation, no quotation marks.`;

  const msg = await getAnthropicClient(anthropicApiKey).messages.create(
    { model: 'claude-sonnet-4-6', max_tokens: 60, temperature: 0.7, messages: [{ role: 'user', content }] },
    { timeout: 30_000 }
  );
  const text = msg.content[0]?.text?.trim();
  if (!text) throw new Error('No text returned from Anthropic');
  // Strip any accidentally added quotes
  return text.replace(/^["']|["']$/g, '').trim();
}

async function generatePeriodVocabulary(scenario, characters, anthropicApiKey) {
  const npcList = (characters || [])
    .map(c => `- ${c.name} (${c.role || 'unknown role'})`)
    .join('\n') || '(none listed)';

  const introText = (scenario.introduction?.sections || [])
    .filter(s => s.type !== 'entry')
    .map(s => s.text || '').filter(Boolean).join('\n\n');

  const prompt = [
    'Generate a period_vocabulary object for an immersive historical fiction scenario.',
    'This vocabulary is injected into every AI-generated scene so NPCs and narration use authentic period language.',
    '',
    `SCENARIO: ${scenario.title}`,
    scenario.description ? `DESCRIPTION: ${scenario.description}` : '',
    introText ? `SETTING CONTEXT:\n${introText}` : '',
    `NPCS IN THIS STORY:\n${npcList}`,
    '',
    'Generate 3–5 vocabulary categories. Each category covers one trade, faction, or social group in this story.',
    'Good categories: trade argot, criminal cant, organizational codes, period slang, technical shorthand.',
    'Every term must be historically authentic to the period and location — no generic or modern language.',
    '',
    'Each category:',
    '- name: short label (e.g. "Dockworkers\' Argot", "Police Cant", "Revolutionary Codes")',
    '- context: one sentence — who uses this vocabulary and when',
    '- terms: 5–8 entries: { "term": "the word or phrase", "meaning": "what it means in this world" }',
    '',
    'Return ONLY valid JSON:',
    '{ "period_vocabulary": { "categories": [ { "name": "...", "context": "...", "terms": [ { "term": "...", "meaning": "..." } ] } ] } }',
  ].filter(Boolean).join('\n');

  const msg = await getAnthropicClient(anthropicApiKey).messages.create(
    { model: 'claude-sonnet-4-6', max_tokens: 4000, temperature: 0.7, messages: [{ role: 'user', content: prompt }] },
    { timeout: 90_000 }
  );
  if (msg.stop_reason === 'max_tokens') {
    throw new Error(`Vocabulary response truncated at max_tokens (${msg.usage?.output_tokens} tokens) — JSON will be incomplete`);
  }
  const text = msg.content[0]?.text?.trim();
  if (!text) throw new Error('No text returned from Anthropic');
  let parsed;
  try {
    parsed = extractJson(text);
  } catch (parseErr) {
    console.error(`[VOCAB] extractJson failed — response was ${text.length} chars, last 200: ...${text.slice(-200)}`);
    throw new Error(`Vocabulary JSON parse failed: ${parseErr.message}`);
  }
  if (!Array.isArray(parsed?.period_vocabulary?.categories) || parsed.period_vocabulary.categories.length === 0) {
    throw new Error('Invalid period_vocabulary structure returned — categories missing or not an array');
  }
  return parsed.period_vocabulary;
}

function scalingGuide(minutes) {
  if (minutes <= 10) return { acts: 2, chars: '3–4', locs: '4–5',  clues: '3–4',  roles: 2, tpt: 2 };
  if (minutes <= 15) return { acts: 3, chars: '4–5', locs: '5–6',  clues: '5–6',  roles: 3, tpt: 2 };
  if (minutes <= 30) return { acts: 4, chars: '5–7', locs: '6–8',  clues: '7–9',  roles: 3, tpt: 2 };
  return               { acts: 6, chars: '7–10',locs: '8–12', clues: '10–14', roles: 4, tpt: 3 };
}

function generationMaxTokens(minutes) {
  // Scenario JSON output is larger than scene output — period_vocabulary, aggressionProfiles,
  // role briefings, and opening narratives together exceed the old scene-generation budget.
  if (minutes <= 10) return  8_000;
  if (minutes <= 20) return 14_000;
  if (minutes <= 30) return 24_000;
  if (minutes <= 60) return 32_000;
  return               48_000;
}

function buildGenerationPrompt({ description, playTimeMinutes }) {
  const s = scalingGuide(playTimeMinutes);

  return `You are a professional story designer for an AI-powered interactive mystery game engine.
Read the creator's description and generate a complete, immediately playable story package.

GAME ENGINE:
Players explore locations, question NPCs, discover clues, and solve a mystery before time runs out.
- Players travel between locations; clues are location-specific
- NPCs have suspicion scores that rise as evidence is presented
- The game ends on final accusation, time expiry, or triggered climax

CREATOR'S DESCRIPTION:
${description}

PLAY TIME: ${playTimeMinutes} minutes
TIME PER TURN: ${s.tpt} minutes

REQUIRED SCALE:
- Acts: exactly ${s.acts}
- NPCs: ${s.chars} — at least 1–2 culprits, 1 authority figure, 1 neutral/ally
- Locations: ${s.locs} — 2–3 NPCs per location
- Clues: ${s.clues} — exactly 2 with isKeyEvidence: true
- Player Roles: ${s.roles}

OUTPUT RULES:
1. Return ONLY valid JSON — no markdown, no code fences, no prose
2. Invent a concise story title. Derive scenario_id as its snake_case slug
3. Story arc ID must be: {scenario_id}_main_arc
4. All IDs: lowercase, letters/numbers/underscores only
5. All cross-references must be consistent (linkedCharacterIds, discoveryLocationId, etc.)
6. Exactly 2 clues must have isKeyEvidence: true
7. Every playerRole MUST include briefing, character_hooks, and suggested_secret (rules below)
8. The scenario MUST include an introduction object (rules below)

INTRODUCTION RULES (required on scenario):
Write a 4-section pre-game reading experience in the style of a serious narrative historian — specific, cinematic, grounded in concrete detail. No genre clichés.
- world: The broader context — time, place, the forces in motion. What kind of world this is right now. Specific names, numbers, facts where possible.
- stakes: What hangs on tonight — politically, personally, for the people in this story. Why this moment and not another. What failure costs.
- scene: The immediate environment — this street, this hour, this weather, this smell. Paint the world the player is about to step into.
- entry: The final paragraph. Bring the player to the exact threshold where the interactive story begins. The last sentence should land them at the door, the moment, the decision. Second person ("You are...").
Each section: 3–5 sentences. No section headers in the text. No meta-commentary.

PLAYER BRIEFING RULES (required on every playerRole):
- briefing: 150–250 word entry paragraph, second person present tense.
  Places this character in a specific physical location at the story's opening moment.
  References what this character knows that the others do not.
  Establishes their emotional and physical state right now — not backstory, not history.
  Ends at the exact threshold of their first choice: the last breath before the player acts.
  Written in the same literary voice as the scenario introduction sections.
  Do NOT use the 5-sentence formula. Write as continuous prose, not labelled sentences.
  Example structure (adapt for this character and scenario):
    "You are standing [specific location] with [specific physical detail].
     You have [what this character uniquely knows that others do not].
     [What is at stake for them personally, right now, not historically].
     [The immediate sensory detail anchoring this moment].
     [Final sentence lands them at the threshold of their first action]."
  CRITICAL — FIRST LINE RULE: Never open with "You are [character name]" or any variation
  that names or introduces the character. Begin with physical placement — where they are,
  what their body registers. WRONG: "You are Elias Cutter, and you are standing..."
  RIGHT: "You are standing in the dark behind the freight house..."
  This text appears as the Character Brief on the introduction screen and is written
  to the session transcript. A missing or template-copied briefing will create a blank
  transcript section. Write it specific to this character and this opening moment.
- character_hooks: array of exactly 3 first-person sentences — alternative starting conditions (different debt, different rumour, different relationship). One is picked randomly each session.
- suggested_secret: one sentence. Something nobody in the story knows about this player character.

PERIOD VOCABULARY RULES (required on scenario):
Generate a period_vocabulary object with 3–5 categories of authentic language from this specific world.
Each category covers one trade, faction, or social group central to this story.
Good categories: trade argot, criminal cant, organizational codes, period slang, technical shorthand.
- name: short category label (e.g. "Dockworkers' Language", "Rebel Cipher Codes", "Police Jargon")
- context: one sentence — who uses this vocabulary and in what situations
- terms: 5–8 entries per category — use historically authentic vocabulary specific to the period, location, and world
Each term: { "term": "the word or phrase", "meaning": "what it means in this world" }
Do not use generic or modern slang. Every term should be specific to this era, place, and cast.

REQUIRED JSON STRUCTURE:
{
  "scenario": {
    "id": "your_scenario_slug",
    "version": "1.0.0",
    "title": "Your Story Title",
    "description": "2–3 sentence description",
    "genre": ["genre_word"],
    "historicalRealism": "high | medium | low",
    "freedomLevel": "guided",
    "sessionTargetMinutes": ${playTimeMinutes},
    "storyArcIds": ["your_scenario_slug_main_arc"],
    "playerRoleIds": ["role_id_1"],
    "keyEvidenceClueIds": ["key_clue_1", "key_clue_2"],
    "systems": {
      "timePerTurnDefault": ${s.tpt},
      "scales": {
        "threat":         { "min": 0, "max": 10, "default": 1 },
        "authorityTrust": { "min": -3, "max": 5, "default": 1 }
      },
      "pressureEvents": ["event 1", "event 2", "event 3"]
    },
    "winConditions": ["win condition"],
    "failConditions": ["fail condition"],
    "partialSuccessExamples": ["partial example"],
    "introduction": {
      "enabled": true,
      "skippable": true,
      "sections": [
        { "type": "world",  "text": "World context paragraph." },
        { "type": "stakes", "text": "Stakes paragraph." },
        { "type": "scene",  "text": "Immediate scene paragraph." },
        { "type": "entry",  "text": "Entry paragraph — second person, lands at the threshold." }
      ]
    },
    "period_vocabulary": {
      "categories": [
        {
          "name": "Category Name",
          "context": "Who uses this language and in what situations.",
          "terms": [
            { "term": "example term", "meaning": "what it means in this world" }
          ]
        }
      ]
    },
    "createdAt": "2025-01-01T00:00:00Z",
    "updatedAt": "2025-01-01T00:00:00Z"
  },
  "storyArc": {
    "id": "your_scenario_slug_main_arc",
    "scenarioId": "your_scenario_slug",
    "name": "Arc name",
    "premise": "Central dramatic situation in 1–2 sentences",
    "goal": "What the player must accomplish",
    "openingSituation": "The immediate problem at game start",
    "acts": [
      { "actNumber": 1, "name": "Act name", "minuteRange": [0, ${Math.round(playTimeMinutes / s.acts)}], "beats": ["beat 1", "beat 2"] }
    ],
    "createdAt": "2025-01-01T00:00:00Z",
    "updatedAt": "2025-01-01T00:00:00Z"
  },
  "characters": [
    {
      "id": "character_slug",
      "scenarioIds": ["your_scenario_slug"],
      "name": "Full Name",
      "role": "Official role or occupation",
      "publicFace": "How they appear to strangers",
      "privateGoal": "What they really want",
      "fear": "Their greatest vulnerability",
      "knowledge": ["fact they know 1", "fact they know 2"],
      "voice": "Speaking style in one phrase",
      "trustLogic": "What opens them up or shuts them down",
      "secrets": ["secret 1", "secret 2"],
      "aggressionProfile": {
        "mildPressure": "Reaction when questioned lightly",
        "heavyPressure": "Reaction when directly accused",
        "breakingPoint": "What they will never admit",
        "fleeCondition": "Trigger for flight — empty string if never",
        "fleeStyle": "How they escape — empty string if never",
        "chaseStyle": "Behavior when chased — empty string if never",
        "capturedBehavior": "Behavior if cornered",
        "strikeFirst": null
      },
      "createdAt": "2025-01-01T00:00:00Z",
      "updatedAt": "2025-01-01T00:00:00Z"
    }
  ],
  "locations": [
    {
      "id": "location_slug",
      "scenarioId": "your_scenario_slug",
      "name": "Location Name",
      "description": "Vivid 1–2 sentence description with sensory detail",
      "mood": "comma-separated mood tags",
      "linkedCharacterIds": ["character_id"],
      "atmosphericDetails": ["sensory detail 1", "sensory detail 2", "sensory detail 3"],
      "createdAt": "2025-01-01T00:00:00Z",
      "updatedAt": "2025-01-01T00:00:00Z"
    }
  ],
  "clues": [
    {
      "id": "clue_slug",
      "scenarioId": "your_scenario_slug",
      "title": "Short Clue Name",
      "description": "What the player discovers, from player perspective",
      "category": "documentary | observation | physical | testimony",
      "discoveryLocationId": "location_slug",
      "implicatesCharacterIds": ["character_slug"],
      "unlocks": [],
      "isKeyEvidence": false,
      "createdAt": "2025-01-01T00:00:00Z",
      "updatedAt": "2025-01-01T00:00:00Z"
    }
  ],
  "playerRoles": [
    {
      "id": "role_slug",
      "scenarioId": "your_scenario_slug",
      "name": "Role Name",
      "description": "1–2 sentences shown when choosing this role",
      "startLocationId": "location_slug",
      "startingKnowledge": ["something they know at start"],
      "accessLevel": "worker | staff | director",
      "perspective": "How the AI should write for this role's point of view",
      "briefing": "MUST BE A PLAIN STRING — NOT an object, NOT an array. Write the full briefing paragraph as a single string of 150-250 words. Example: 'You are standing [specific location] with [specific physical detail]. You have [what this character uniquely knows that others do not]. [What is at stake for them personally right now]. [The immediate sensory detail of this moment]. [Final sentence lands them at the threshold of their first action].'",
      "character_hooks": ["First-person hook one.", "First-person hook two.", "First-person hook three."],
      "suggested_secret": "One sentence nobody in the story knows.",
      "opening": {
        "narrative": "4–6 sentence opening establishing time, place, and immediate tension. Do not start mid-action.",
        "npcMoments": [],
        "choices": ["first action", "second action", "third action"]
      },
      "roleInitialState": {
        "inventory": ["starting item"],
        "flags": {},
        "suspicion": {}
      },
      "createdAt": "2025-01-01T00:00:00Z",
      "updatedAt": "2025-01-01T00:00:00Z"
    }
  ]
}`;
}

export function createAdminRouter(repos, config = {}) {
  const { anthropicApiKey } = config;
  const r = Router();

  // ── Dashboard ────────────────────────────────────────────────────────────────
  r.get('/dashboard', async (_, res) => {
    let transcripts = 0;
    try {
      const files = await readdir(TRANSCRIPTS_DIR);
      transcripts = files.filter(f => f.endsWith('.md')).length;
    } catch {}
    res.json({
      characters:  repos.characters.findAll().length,
      locations:   repos.locations.findByScenario().length,
      clues:       repos.clues.findByScenario().length,
      storyArcs:   repos.storyArcs.findByScenario().length,
      playerRoles: repos.scenarios.findPlayerRoles().length,
      players:     repos.players.findAll().length,
      sessions:    repos.sessions.findAll().length,
      transcripts,
    });
  });

  // ── Characters ───────────────────────────────────────────────────────────────
  r.get('/characters',      (_, res) => res.json(repos.characters.findAll()));
  r.get('/characters/:id',  (req, res) => {
    const item = repos.characters.findById(req.params.id);
    return item ? res.json(item) : notFound(res);
  });
  r.post('/characters', (req, res) => {
    if (!req.body.name) return badRequest(res, '"name" is required.');
    const id = slugify(req.body.name);
    if (repos.characters.findById(id))
      return res.status(409).json({ error: `ID "${id}" already exists.` });
    res.status(201).json(repos.characters.save({ ...req.body, id }));
  });
  r.put('/characters/:id', (req, res) => {
    if (!repos.characters.findById(req.params.id)) return notFound(res);
    res.json(repos.characters.save({ ...req.body, id: req.params.id }));
  });
  r.delete('/characters/:id', (req, res) => {
    return repos.characters.delete(req.params.id) ? res.json({ ok: true }) : notFound(res);
  });

  // ── Scenario sensory_opening settings ────────────────────────────────────────
  const SENSORY_DEFAULTS = {
    enabled: true, style: 'cinematic_period',
    elements: ['architecture', 'period_light', 'body_senses', 'exterior_context'],
    target_sentences: 4, tts_pacing_hint: 'slow',
  };

  r.get('/scenarios/:id/sensory-opening', async (req, res) => {
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    res.json({
      ...SENSORY_DEFAULTS,
      ...(scenario.sensory_opening || {}),
      tts_narration_speed: scenario.tts_narration_speed ?? 1.0,
    });
  });

  r.patch('/scenarios/:id/sensory-opening', async (req, res) => {
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const { tts_narration_speed, ...sopFields } = req.body;
    const merged = { ...SENSORY_DEFAULTS, ...(scenario.sensory_opening || {}), ...sopFields };
    const updated = { ...scenario, sensory_opening: merged };
    if (tts_narration_speed !== undefined) updated.tts_narration_speed = Number(tts_narration_speed);
    await repos.scenarios.save(updated, { savedBy: req.adminUser?.email || 'admin' });
    res.json({ ...merged, tts_narration_speed: updated.tts_narration_speed ?? 1.0 });
  });

  // ── Locations ────────────────────────────────────────────────────────────────
  r.get('/scenarios',      async (_, res) => res.json(await repos.scenarios.findAll()));
  r.get('/scenarios/:id/full', async (req, res) => {
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const arcId    = scenario.storyArcIds?.[0];
    const storyArc = arcId ? repos.storyArcs.findById(arcId) : null;
    const characters  = repos.characters.findAll().filter(c => c.scenarioIds?.includes(scenario.id));
    const locations   = repos.locations.findByScenario(scenario.id);
    const clues       = repos.clues.findByScenario(scenario.id);
    const playerRoles = repos.scenarios.findPlayerRoles(scenario.id);
    res.json({ scenario, storyArc: storyArc || null, characters, locations, clues, playerRoles });
  });

  // ── Scenario health check ────────────────────────────────────────────────────
  r.get('/scenarios/:id/health', async (req, res) => {
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const playerRoles  = repos.scenarios.findPlayerRoles(req.params.id);
    const characters   = repos.characters.findAll().filter(c => c.scenarioIds?.includes(req.params.id));
    const { errors: missing, warnings } = validateStoredScenario(scenario, playerRoles, characters);
    const entrySection = scenario.introduction?.sections?.find(s => s.type === 'entry');
    const roles = playerRoles.map(role => ({
      id:                role.id,
      name:              role.name,
      hasBriefing:        getBriefingText(role.briefing).length >= 50,
      hasDescription:     !!role.description,
      hasEntryParagraph:  !!(entrySection?.character_entries?.[role.id]?.trim().length >= 50),
      hasContextSentence: !!(role.context_sentence?.trim().length >= 10),
      hasBridgeSentence:  !!(role.bridge_sentence?.trim().length > 0),
      draftBridgeSentence: !!(role.bridge_sentence?.startsWith('[DRAFT]')),
      hasCharacterType:   !!role.character_type,
      factChecked:        role.fact_checked === true,
    }));
    res.json({
      scenarioId: req.params.id,
      healthy: missing.length === 0,
      missing,
      warnings,
      roles,
      hasPeriodVocabulary: !!(scenario.period_vocabulary?.categories?.length),
    });
  });

  // ── Scenario repair ──────────────────────────────────────────────────────────
  r.post('/scenarios/:id/repair', async (req, res) => {
    if (!anthropicApiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured.' });
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const playerRoles = repos.scenarios.findPlayerRoles(req.params.id);

    const repairs = [];
    const errors  = [];

    // Repair missing briefings
    for (const role of playerRoles.filter(r => getBriefingText(r.briefing).length < 50)) {
      try {
        const briefing = await generateBriefingText(scenario, role, anthropicApiKey);
        repos.scenarios.savePlayerRole({ ...role, briefing });
        repairs.push(`Generated briefing for ${role.name}`);
        console.log(`[REPAIR] ${req.params.id} — briefing written for "${role.name}" (${briefing.length} chars)`);
      } catch (err) {
        errors.push(`Failed to generate briefing for ${role.name}: ${err.message}`);
        console.error(`[REPAIR ERROR] ${role.name}: ${err.message}`);
      }
    }

    // Repair missing character entry paragraphs
    const entrySection = scenario.introduction?.sections?.find(s => s.type === 'entry');
    const missingEntries = playerRoles.filter(role => {
      const entry = entrySection?.character_entries?.[role.id];
      return !entry || entry.trim().length < 50;
    });

    if (missingEntries.length > 0) {
      if (!entrySection) {
        errors.push('No entry section found in scenario introduction — cannot generate character entries');
      } else {
        for (const role of missingEntries) {
          try {
            const entryParagraph = await generateCharacterEntry(scenario, role, playerRoles, anthropicApiKey);
            if (!entrySection.character_entries) entrySection.character_entries = {};
            entrySection.character_entries[role.id] = entryParagraph;

            const wideFlags = detectGoingWide(entryParagraph);
            repos.scenarios.savePlayerRole({ ...role, entry_paragraph_flags: wideFlags.map(f => f.message) });
            if (wideFlags.length > 0) {
              repairs.push(`Generated entry paragraph for ${role.name} — ${wideFlags.length} going-wide pattern(s) detected. Review before publishing.`);
              console.warn(`[REPAIR] ${req.params.id} — entry for "${role.name}" flagged: ${wideFlags.join('; ')}`);
            } else {
              repairs.push(`Generated entry paragraph for ${role.name}`);
              console.log(`[REPAIR] ${req.params.id} — entry written for "${role.name}" (${entryParagraph.length} chars)`);
            }
          } catch (err) {
            errors.push(`Failed to generate entry for ${role.name}: ${err.message}`);
            console.error(`[REPAIR ERROR] entry ${role.name}: ${err.message}`);
          }
        }
        await repos.scenarios.save(scenario, { savedBy: req.adminUser?.email || 'admin' });
      }
    }

    // Repair missing context sentences
    const updatedRolesForContext = repos.scenarios.findPlayerRoles(req.params.id);
    const missingContextSentences = updatedRolesForContext.filter(
      role => !role.context_sentence || role.context_sentence.trim().length < 10
    );
    for (const role of missingContextSentences) {
      try {
        const contextSentence = await generateContextSentence(scenario, role, anthropicApiKey);
        repos.scenarios.savePlayerRole({ ...role, context_sentence: contextSentence });
        repairs.push(`Generated context sentence for ${role.name}`);
        console.log(`[REPAIR] ${req.params.id} — context_sentence written for "${role.name}"`);
      } catch (err) {
        errors.push(`Failed to generate context sentence for ${role.name}: ${err.message}`);
        console.error(`[REPAIR ERROR] context_sentence ${role.name}: ${err.message}`);
      }
    }

    // Repair missing period vocabulary
    if (!Array.isArray(scenario.period_vocabulary?.categories) || scenario.period_vocabulary.categories.length === 0) {
      try {
        const characters = repos.characters.findAll().filter(c => c.scenarioIds?.includes(scenario.id));
        const vocab = await generatePeriodVocabulary(scenario, characters, anthropicApiKey);
        if (!Array.isArray(vocab?.categories) || vocab.categories.length === 0) {
          throw new Error('generatePeriodVocabulary returned invalid structure');
        }
        for (const cat of vocab.categories) {
          if (!Array.isArray(cat.terms)) cat.terms = [];
        }
        scenario.period_vocabulary = vocab;
        console.log(`[REPAIR] Writing vocabulary to ${req.params.id} — ${vocab.categories.length} categories, keys: ${Object.keys(vocab).join(', ')}`);
        await repos.scenarios.save(scenario, { savedBy: req.adminUser?.email || 'admin' });
        repairs.push(`Generated period vocabulary (${vocab.categories.length} categories)`);
        console.log(`[REPAIR] ${req.params.id} — period vocabulary written successfully`);
      } catch (err) {
        errors.push(`Failed to generate period vocabulary: ${err.message}`);
        console.error(`[REPAIR ERROR] period vocabulary: ${err.message}`);
      }
    }

    if (repairs.length === 0 && errors.length === 0) {
      return res.json({ success: true, message: 'Scenario is complete — no repairs needed', repairs: [], errors: [], remaining: [] });
    }

    const updatedRoles = repos.scenarios.findPlayerRoles(req.params.id);
    const { errors: remaining } = validateStoredScenario(scenario, updatedRoles);
    res.json({ success: errors.length === 0, repairs, errors, remaining });
  });

  // Generate a bridge sentence draft for a single player role
  r.post('/scenarios/:id/roles/:roleId/generate-bridge-sentence', async (req, res) => {
    if (!anthropicApiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured.' });
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const roles = repos.scenarios.findPlayerRoles(req.params.id);
    const role   = roles.find(r => r.id === req.params.roleId);
    if (!role) return notFound(res);
    try {
      const sentence = await generateBridgeSentence(scenario, role, anthropicApiKey);
      const draft    = `[DRAFT] ${sentence}`;
      repos.scenarios.savePlayerRole({ ...role, bridge_sentence: draft });
      console.log(`[BRIDGE] ${req.params.id} — bridge_sentence draft written for "${role.name}": ${draft}`);
      res.json({ roleId: role.id, bridge_sentence: draft });
    } catch (err) {
      console.error(`[BRIDGE ERROR] ${role.name}: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/locations',      (req, res) => res.json(
    req.query.scenarioId ? repos.locations.findByScenario(req.query.scenarioId) : repos.locations.findAll()
  ));
  r.get('/locations/:id',  (req, res) => {
    const item = repos.locations.findById(req.params.id, req.query.scenarioId);
    return item ? res.json(item) : notFound(res);
  });
  r.post('/locations', (req, res) => {
    if (!req.body.name) return badRequest(res, '"name" is required.');
    const id = slugify(req.body.name);
    if (repos.locations.findById(id))
      return res.status(409).json({ error: `ID "${id}" already exists.` });
    const payload = { ...req.body, id, scenarioId: req.body.scenarioId || 'chicago_1893_v1' };
    res.status(201).json(repos.locations.save(payload));
  });
  r.put('/locations/:id', (req, res) => {
    if (!repos.locations.findById(req.params.id)) return notFound(res);
    res.json(repos.locations.save({ ...req.body, id: req.params.id }));
  });
  r.delete('/locations/:id', (req, res) => {
    return repos.locations.delete(req.params.id) ? res.json({ ok: true }) : notFound(res);
  });

  // ── Clues ────────────────────────────────────────────────────────────────────
  r.get('/clues',      (req, res) => res.json(
    req.query.scenarioId ? repos.clues.findByScenario(req.query.scenarioId) : repos.clues.findAll()
  ));
  r.get('/clues/:id',  (req, res) => {
    const item = repos.clues.findById(req.params.id, req.query.scenarioId);
    return item ? res.json(item) : notFound(res);
  });
  r.post('/clues', (req, res) => {
    if (!req.body.title) return badRequest(res, '"title" is required.');
    const id = slugify(req.body.title);
    if (repos.clues.findById(id))
      return res.status(409).json({ error: `ID "${id}" already exists.` });
    const payload = { ...req.body, id, scenarioId: req.body.scenarioId || 'chicago_1893_v1' };
    res.status(201).json(repos.clues.save(payload));
  });
  r.put('/clues/:id', (req, res) => {
    if (!repos.clues.findById(req.params.id)) return notFound(res);
    res.json(repos.clues.save({ ...req.body, id: req.params.id }));
  });
  r.delete('/clues/:id', (req, res) => {
    return repos.clues.delete(req.params.id) ? res.json({ ok: true }) : notFound(res);
  });

  // ── Story Arcs ───────────────────────────────────────────────────────────────
  r.get('/story-arcs',      (req, res) => res.json(repos.storyArcs.findByScenario(req.query.scenarioId)));
  r.get('/story-arcs/:id',  (req, res) => {
    const item = repos.storyArcs.findById(req.params.id);
    return item ? res.json(item) : notFound(res);
  });
  r.post('/story-arcs', (req, res) => {
    if (!req.body.name) return badRequest(res, '"name" is required.');
    const id = slugify(req.body.name);
    if (repos.storyArcs.findById(id))
      return res.status(409).json({ error: `ID "${id}" already exists.` });
    const payload = { ...req.body, id, scenarioId: req.body.scenarioId || 'chicago_1893_v1' };
    res.status(201).json(repos.storyArcs.save(payload));
  });
  r.put('/story-arcs/:id', (req, res) => {
    if (!repos.storyArcs.findById(req.params.id)) return notFound(res);
    res.json(repos.storyArcs.save({ ...req.body, id: req.params.id }));
  });
  r.delete('/story-arcs/:id', (req, res) => {
    return repos.storyArcs.delete(req.params.id) ? res.json({ ok: true }) : notFound(res);
  });

  // ── Player Roles ─────────────────────────────────────────────────────────────
  r.get('/player-roles',      (req, res) => res.json(repos.scenarios.findPlayerRoles(req.query.scenarioId)));
  r.get('/player-roles/:id',  (req, res) => {
    const item = repos.scenarios.findPlayerRole(req.params.id);
    return item ? res.json(item) : notFound(res);
  });
  r.post('/player-roles', (req, res) => {
    if (!req.body.name) return badRequest(res, '"name" is required.');
    const id = slugify(req.body.name);
    if (repos.scenarios.findPlayerRole(id))
      return res.status(409).json({ error: `ID "${id}" already exists.` });
    const payload = { ...req.body, id, scenarioId: req.body.scenarioId || 'chicago_1893_v1' };
    res.status(201).json(repos.scenarios.savePlayerRole(payload));
  });
  r.put('/player-roles/:id', (req, res) => {
    if (!repos.scenarios.findPlayerRole(req.params.id)) return notFound(res);
    res.json(repos.scenarios.savePlayerRole({ ...req.body, id: req.params.id }));
  });
  r.patch('/player-roles/:id/ending-notes', (req, res) => {
    const role = repos.scenarios.findPlayerRole(req.params.id);
    if (!role) return notFound(res);
    role.ending_notes = { ...(role.ending_notes || {}), ...req.body };
    res.json(repos.scenarios.savePlayerRole(role));
  });
  r.delete('/player-roles/:id', (req, res) => {
    return repos.scenarios.deletePlayerRole(req.params.id) ? res.json({ ok: true }) : notFound(res);
  });

  // ── Players ──────────────────────────────────────────────────────────────────
  r.get('/players',      (_, res) => res.json(repos.players.findAll()));
  r.get('/players/:id',  (req, res) => {
    const item = repos.players.findById(req.params.id);
    return item ? res.json(item) : notFound(res);
  });
  r.post('/players', (req, res) => {
    if (!req.body.username) return badRequest(res, '"username" is required.');
    if (repos.players.findByUsername(req.body.username))
      return res.status(409).json({ error: `Username "${req.body.username}" already exists.` });
    const id = crypto.randomUUID();
    res.status(201).json(repos.players.save({ ...req.body, id }));
  });
  r.put('/players/:id', (req, res) => {
    if (!repos.players.findById(req.params.id)) return notFound(res);
    res.json(repos.players.save({ ...req.body, id: req.params.id }));
  });
  r.delete('/players/:id', (req, res) => {
    return repos.players.delete(req.params.id) ? res.json({ ok: true }) : notFound(res);
  });

  // ── Sessions (read + delete only) ────────────────────────────────────────────
  r.get('/sessions', (req, res) => {
    const all = req.query.playerId
      ? repos.sessions.findByPlayer(req.query.playerId)
      : repos.sessions.findAll();
    const filtered = req.query.status
      ? all.filter(s => s.status === req.query.status)
      : all;
    // Strip conversationHistory from list view to keep response small
    res.json(filtered.map(({ conversationHistory: _, ...s }) => s));
  });
  r.get('/sessions/:id', (req, res) => {
    const item = repos.sessions.findById(req.params.id);
    return item ? res.json(item) : notFound(res);
  });
  r.delete('/sessions/:id', (req, res) => {
    return repos.sessions.delete(req.params.id) ? res.json({ ok: true }) : notFound(res);
  });

  // ── Story Generator ──────────────────────────────────────────────────────────
  r.post('/generate', async (req, res) => {
    if (!anthropicApiKey) {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured on the engine server.' });
    }
    const { description, playTimeMinutes = 15 } = req.body;
    if (!description) return badRequest(res, '"description" is required.');

    const prompt = buildGenerationPrompt({ description, playTimeMinutes: Number(playTimeMinutes) });
    const toks   = generationMaxTokens(Number(playTimeMinutes));

    console.log(`[GENERATE] playTime=${playTimeMinutes}min tokenBudget=${toks}`);

    const genTrace = langfuse?.trace({ name: 'story-generate', input: { playTimeMinutes, tokenBudget: toks } });
    const genSpan  = genTrace?.generation({ name: 'generate', model: 'claude-sonnet-4-6', modelParameters: { max_tokens: toks, temperature: 0.7 }, input: [{ role: 'user', content: prompt.slice(0, 2000) + '…' }] });

    // streaming is required by the SDK for long requests; timeout covers time-to-first-chunk
    const timeoutMs = 120_000;
    let text = '';
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const stream = getAnthropicClient(anthropicApiKey).messages.stream(
          { model: 'claude-sonnet-4-6', max_tokens: toks, temperature: 0.7, messages: [{ role: 'user', content: prompt }] },
          { timeout: timeoutMs, maxRetries: 0 }
        );

        text = '';
        for await (const chunk of stream) {
          if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
            text += chunk.delta.text;
          }
        }

        const finalMsg = await stream.finalMessage();
        genSpan?.end({ output: `${text.length} chars`, usage: { input: finalMsg.usage?.input_tokens, output: finalMsg.usage?.output_tokens }, metadata: { stop_reason: finalMsg.stop_reason } });
        console.log(`[GENERATE] stream complete stop_reason=${finalMsg.stop_reason} chars=${text.length} input_tokens=${finalMsg.usage?.input_tokens} output_tokens=${finalMsg.usage?.output_tokens}`);

        if (finalMsg.stop_reason === 'max_tokens') {
          console.error(`[GENERATE ERROR] Truncated at max_tokens — ${text.length} chars, budget was ${toks}`);
          genTrace?.update({ tags: ['truncated'] });
          return res.status(500).json({ error: 'Scenario generation failed — response truncated.', lastChars: text.slice(-500) });
        }

        if (!text) {
          genTrace?.update({ tags: ['no-text'] });
          return res.status(500).json({ error: 'No response from Claude.' });
        }

        lastErr = null;
        break; // success
      } catch (err) {
        lastErr = err;
        const isTransient = err?.message === 'terminated' || err?.cause?.message === 'terminated' || err?.code === 'ECONNRESET';
        console.error(`[GENERATE ERROR] attempt=${attempt} name=${err?.name} status=${err?.status} code=${err?.code} message=${err.message}`);
        if (err?.cause) console.error(`[GENERATE ERROR] cause:`, err.cause);
        if (isTransient && attempt < 3) {
          console.log(`[GENERATE] retrying after transient error (attempt ${attempt}/3)...`);
          await new Promise(r => setTimeout(r, 2000 * attempt));
          continue;
        }
        const isTimeout = err?.status === 408 || err?.code === 'ETIMEDOUT' || err?.message?.toLowerCase().includes('timeout') || err?.name === 'APITimeoutError';
        genSpan?.end({ metadata: { error: isTimeout ? 'timeout' : err.message } });
        genTrace?.update({ tags: [isTimeout ? 'timeout' : 'error'] });
        return res.status(500).json({ error: isTimeout ? 'Generation timed out — try a shorter play time.' : err.message });
      }
    }
    if (lastErr) {
      genTrace?.update({ tags: ['error'] });
      return res.status(500).json({ error: lastErr.message });
    }

    const generated = extractAndValidateJson(text);
    if (!generated) {
      console.error('[SCENARIO GEN] JSON truncated or malformed');
      console.error('[SCENARIO GEN] Last 500 chars:', text.slice(-500));
      genTrace?.update({ tags: ['invalid-json'] });
      return res.status(500).json({
        error: 'Scenario generation failed — response truncated. The max_tokens limit may still be too low for this scenario size.',
        lastChars: text.slice(-500)
      });
    }
    const missing = ['scenario','storyArc','characters','locations','clues','playerRoles'].filter(k => !generated[k]);
    if (missing.length) {
      genTrace?.update({ tags: ['missing-keys'] });
      return res.status(500).json({ error: `Generated JSON is missing: ${missing.join(', ')}`, rawText: text.slice(0,500) });
    }
    const completenessErrors = validateGeneratedScenario(generated);
    if (completenessErrors.length > 0) {
      console.error('[SCENARIO GEN] Validation failed:', completenessErrors);
      genTrace?.update({ tags: ['validation-failed'] });
      return res.status(500).json({ error: 'Generated scenario is incomplete', missing: completenessErrors });
    }
    genTrace?.update({ tags: ['success'], output: { scenarioId: generated.scenario?.id, characters: generated.characters?.length, locations: generated.locations?.length, clues: generated.clues?.length } });
    console.log(`[GENERATE] saved scenario=${generated.scenario?.id} chars=${generated.characters?.length} locs=${generated.locations?.length} clues=${generated.clues?.length}`);
    return res.json(generated);
  });

  r.post('/generate/player-briefings', async (req, res) => {
    if (!anthropicApiKey) {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured.' });
    }
    const { playerRoles = [], scenario = {}, characters = [] } = req.body;
    if (!playerRoles.length) return badRequest(res, 'playerRoles array is required.');

    const characterList = characters.map(c => `- ${c.name} (${c.role || 'unknown role'}): ${c.publicFace || ''}`).join('\n') || '(none listed)';
    const rolesBlock = playerRoles.map((role, i) => `
ROLE ${i + 1}: "${role.name}" (id: ${role.id})
Description: ${role.description || 'none'}
Access Level: ${role.accessLevel || 'staff'}
Starting Knowledge: ${(role.startingKnowledge || []).join(', ') || 'none'}
Perspective notes: ${role.perspective || 'none'}`).join('\n');

    const prompt = `You are writing player character briefings for an immersive AI mystery game.

SCENARIO: ${scenario.title || 'unknown'}
PREMISE: ${scenario.description || ''}
TONE: ${(scenario.genre || []).join(', ')}

CHARACTERS IN THIS STORY:
${characterList}

For each player role below, generate three fields:

1. "briefing" — Exactly 5 sentences. Second person (You are...).
   Sentence 1: Who the player is in this world (name, trade, station).
   Sentence 2: One relationship with another character that has tension RIGHT NOW.
   Sentence 3: One thing the player knows that they were not meant to know.
   Sentence 4: One want that has not been acted on yet.
   Sentence 5: One sensory or physical detail that grounds them in the world.
   No backstory. No history lesson. The briefing must make the player feel they are already late for something.

2. "character_hooks" — Array of exactly 3 strings. Alternative personal details that vary between sessions — different things overheard, different debts, different relationships. Same character, different starting condition. Each hook is one sentence in first person.

3. "suggested_secret" — One sentence. Something nobody in the story knows about this player character.

PLAYER ROLES:
${rolesBlock}

Return ONLY valid JSON in this exact structure:
{
  "briefings": [
    {
      "id": "role_id",
      "briefing": "Five sentence second-person briefing text here.",
      "character_hooks": ["First-person hook one.", "First-person hook two.", "First-person hook three."],
      "suggested_secret": "One sentence nobody in the story knows."
    }
  ]
}`;

    console.log(`[BRIEFINGS] Generating for ${playerRoles.length} role(s) in "${scenario.title || 'unknown'}"`);

    let text;
    try {
      const msg = await getAnthropicClient(anthropicApiKey).messages.create(
        { model: 'claude-sonnet-4-6', max_tokens: 4000, temperature: 0.8, messages: [{ role: 'user', content: prompt }] },
        { timeout: 120_000, maxRetries: 0 }
      );
      text = msg.content[0]?.text;
      if (!text) return res.status(500).json({ error: 'No response from Claude.' });
    } catch (err) {
      const isTimeout = err?.status === 408 || err?.code === 'ETIMEDOUT' || err?.message?.toLowerCase().includes('timeout') || err?.name === 'APITimeoutError';
      return res.status(500).json({ error: isTimeout ? 'Briefing generation timed out.' : err.message });
    }

    try {
      const parsed = extractJson(text);
      if (!Array.isArray(parsed.briefings)) return res.status(500).json({ error: 'Response missing briefings array.', rawText: text.slice(0, 400) });
      console.log(`[BRIEFINGS] Generated ${parsed.briefings.length} briefing(s)`);
      return res.json(parsed);
    } catch (err) {
      return res.status(500).json({ error: 'Claude returned invalid JSON for briefings.', rawText: text.slice(0, 400) });
    }
  });

  // ── Transcripts ──────────────────────────────────────────────────────────────
  r.get('/transcripts', async (_, res) => {
    try {
      let files;
      try { files = await readdir(TRANSCRIPTS_DIR); } catch { files = []; }
      const mdFiles = files.filter(f => f.endsWith('.md'));
      const items = await Promise.all(mdFiles.map(async f => {
        const id = f.slice(0, -3);
        const filePath = join(TRANSCRIPTS_DIR, f);
        const [content, stats] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)]);
        const scenario  = content.match(/^## Scenario:\s*(.+)$/m)?.[1]?.trim()
                       || content.match(/^scenario:\s*(.+)$/m)?.[1]?.trim()
                       || '—';
        const character = content.match(/^## Character:\s*(.+)$/m)?.[1]?.trim()
                       || content.match(/^character:\s*(.+)$/m)?.[1]?.trim()
                       || '—';
        const started   = content.match(/^## Date:\s*(.+)$/m)?.[1]?.trim()
                       || content.match(/^started:\s*(.+)$/m)?.[1]?.trim()
                       || null;
        const turns     = (content.match(/^\*\*Player:\*\*/gm) || []).length;
        const endMatch  = content.match(/^## Ending — (.+)$/m);
        const result    = endMatch ? endMatch[1].toLowerCase() : 'in-progress';
        return { id, scenario, character, started, turns, result, size: stats.size, mtime: stats.mtime };
      }));
      items.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/transcripts/:id/download', async (req, res) => {
    const safe = req.params.id.replace(/[^a-zA-Z0-9-]/g, '');
    const filePath = join(TRANSCRIPTS_DIR, `${safe}.md`);
    try {
      const content = await readFile(filePath, 'utf8');
      res.set('Content-Type', 'text/markdown; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="transcript-${safe}.md"`);
      res.send(content);
    } catch {
      res.status(404).json({ error: 'Transcript not found.' });
    }
  });

  r.delete('/transcripts/:id', async (req, res) => {
    const safe = req.params.id.replace(/[^a-zA-Z0-9-]/g, '');
    try {
      await unlink(join(TRANSCRIPTS_DIR, `${safe}.md`));
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: 'Transcript not found.' });
    }
  });

  // ── Reviews (read-only) ───────────────────────────────────────────────────────
  r.get('/reviews/:scenarioId', async (req, res) => {
    const safe = req.params.scenarioId.replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = join(REVIEWS_DIR, `${safe}_review.md`);
    try {
      const content = await readFile(filePath, 'utf8');
      res.json({ scenarioId: safe, content });
    } catch {
      res.json({ scenarioId: safe, content: null });
    }
  });

  r.post('/generate/essential-beats', async (req, res) => {
    if (!anthropicApiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured.' });
    const { title = '', premise = '', world = '', stakes = '', briefings = [] } = req.body;

    const prompt = [
      `SCENARIO TITLE: ${title}`,
      premise  ? `PREMISE: ${premise}`                              : '',
      world    ? `WORLD CONTEXT: ${world}`                         : '',
      stakes   ? `STAKES / GOAL: ${stakes}`                        : '',
      briefings.length
        ? `ROLE BRIEFINGS:\n${briefings.map((b, i) => `Role ${i + 1}: ${b}`).join('\n\n')}`
        : '',
      '',
      'Given the scenario structure provided, generate an essential beats checklist for the dramatic closure system. The checklist must contain between three and six items. Each beat must describe a specific dramatic action that constitutes a complete session — not a topic the player might raise, but a concrete thing that must have occurred in the generated response confirming it. Beats must be ordered by the sequence in which they would naturally occur in the session. The final beat must represent the session\'s natural dramatic conclusion — the moment after which no new dramatic threads need to be opened.',
      'Each beat description must be written in past tense and must describe what the engine confirmed in generated text, not what the player typed.',
      'Return only a JSON array in this exact format with no other text:',
      '[',
      '  { "id": "snake_case_id", "description": "Past tense one sentence description." }',
      ']',
    ].filter(Boolean).join('\n');

    try {
      const msg = await getAnthropicClient(anthropicApiKey).messages.create(
        { model: 'claude-sonnet-4-6', max_tokens: 1000, temperature: 0.7, messages: [{ role: 'user', content: prompt }] },
        { timeout: 60_000, maxRetries: 0 }
      );
      const text = msg.content[0]?.text?.trim();
      if (!text) return res.status(500).json({ error: 'No response from Claude.' });
      const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const beats = JSON.parse(cleaned);
      if (!Array.isArray(beats)) throw new Error('Response is not a JSON array');
      res.json(beats);
    } catch (err) {
      console.error('[ESSENTIAL-BEATS]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/generate/technical-facts', async (req, res) => {
    if (!anthropicApiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured.' });
    const { scenarioId, title = '', world = '', stakes = '', characters = [], clues = [], period_vocabulary = '', essential_beats = [] } = req.body;
    if (!scenarioId) return badRequest(res, 'scenarioId is required.');
    const scenario = await repos.scenarios.findById(scenarioId);
    if (!scenario) return notFound(res);

    const systemPrompt = [
      'You are generating the technical facts block for an immersive historical fiction scenario. This block will be injected into every session turn as verified data. The engine will draw from these facts and will not generate alternative values for anything listed here. Every fact you produce must be historically accurate, specific, and verifiable.',
      '',
      'Generate a list of technical facts covering the following domains where they are relevant to this scenario:',
      'power — electrical specifications, voltage, generator capacity, circuit configurations',
      'flooding — water level measurements, flooding rates, compartment sequences, timing',
      'timing — precise timestamps for key events, durations, sequences',
      'capacity — vessel capacity, lifeboat figures, personnel counts, load specifications',
      'navigation — positions, distances, speeds, bearings, courses',
      'personnel — what named characters actually did, their documented actions and fates during the event depicted',
      'other — any other technical fact a player might trigger the engine to generate incorrectly',
      '',
      'Rules:',
      '- Every fact must be specific and numerical where the historical record provides numbers',
      '- Every fact must have a source reference — a named inquiry, testimony, document, or established historical record',
      '- Do not include facts that are disputed or unverifiable — omit rather than approximate',
      '- Do not include interpretive or analytical statements — facts only',
      '- Generate between 8 and 20 facts depending on the scenario\'s technical complexity',
      '- Each fact_id must be unique and descriptive in snake_case',
      '',
      'Return only a JSON array in this exact format with no other text:',
      '[',
      '  {',
      '    "fact_id": "snake_case_id",',
      '    "content": "The specific verified fact as a complete sentence.",',
      '    "domain": "power|flooding|timing|capacity|navigation|personnel|other",',
      '    "source": "Primary source reference",',
      '    "valid_from": null,',
      '    "valid_until": null',
      '  }',
      ']',
    ].join('\n');

    const userPrompt = [
      `SCENARIO TITLE: ${title}`,
      world   ? `WORLD CONTEXT:\n${world}`   : '',
      stakes  ? `STAKES / GOAL:\n${stakes}`  : '',
      characters.length
        ? `NAMED CHARACTERS:\n${characters.map(c => [
            `- ${c.character_id || c.id}: ${c.name} (${c.role || c.publicFace || ''})`,
            c.startingKnowledge?.length ? `  Known at session start: ${c.startingKnowledge.join('; ')}` : '',
          ].filter(Boolean).join('\n')).join('\n')}`
        : '',
      clues.length
        ? `CLUES / DOCUMENTS:\n${clues.map(cl => `- ${cl.name || cl.id}: ${cl.description || cl.content || ''}`).join('\n')}`
        : '',
      period_vocabulary ? `PERIOD VOCABULARY / TECHNICAL TERMS:\n${period_vocabulary}` : '',
      essential_beats.length
        ? `ESSENTIAL BEATS:\n${essential_beats.map(b => `- id: ${b.id}, description: ${b.description}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n\n');

    try {
      const msg = await getAnthropicClient(anthropicApiKey).messages.create(
        {
          model: 'claude-sonnet-4-6',
          max_tokens: 4000,
          temperature: 0.2,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        },
        { timeout: 90_000, maxRetries: 0 }
      );
      console.log('[TECHNICAL-FACTS] stop_reason:', msg.stop_reason, 'output_tokens:', msg.usage?.output_tokens);
      if (msg.stop_reason === 'max_tokens') {
        return res.status(500).json({ error: 'Technical facts generation truncated — reduce scenario complexity and retry.' });
      }
      const text = msg.content[0]?.text?.trim();
      if (!text) return res.status(500).json({ error: 'No response from Claude.' });
      const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const facts = JSON.parse(cleaned);
      if (!Array.isArray(facts)) throw new Error('Response is not a JSON array');

      const updated = {
        ...scenario,
        technical_facts: {
          generated: true,
          reviewed:  false,
          facts,
        },
      };
      await repos.scenarios.save(updated, { savedBy: req.adminUser?.email || 'admin' });
      console.log(`[TECHNICAL-FACTS] Generated ${facts.length} fact(s) for scenario "${scenarioId}"`);
      res.json(updated.technical_facts);
    } catch (err) {
      console.error('[TECHNICAL-FACTS]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/generate/epilogue-data', async (req, res) => {
    if (!anthropicApiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured.' });
    const { scenarioId, title = '', world = '', stakes = '', characters = [], essential_beats = [] } = req.body;
    if (!scenarioId) return badRequest(res, 'scenarioId is required.');
    const scenario = await repos.scenarios.findById(scenarioId);
    if (!scenario) return notFound(res);

    const systemPrompt = [
      'You are generating the historical epilogue data block for an immersive historical fiction scenario. Your output will be used to generate personalized epilogue text for players after they complete a session. Every fact you produce must be historically accurate and verifiable. Do not invent, approximate, or editorialize.',
      '',
      '══ HISTORICAL RECORD STANDARD ══',
      '',
      'Each character in this scenario has a declared character_type. Apply the correct standard for each:',
      '',
      'FOR REAL HISTORICAL FIGURES (character_type = "real"):',
      'Cover their actual verified post-event fate. What happened to them after this event. What they did next.',
      'How history records them. Be specific — names, dates, outcomes.',
      'Never invent or speculate. If uncertain of a fact, omit it rather than guess.',
      '',
      'FOR FICTIONAL CHARACTERS (character_type = "fictional" or "composite"):',
      'Do not invent a post-event biography for this character. They are not a real person and have no verifiable fate.',
      'Instead write about the category of person they represented (given in the "represents" field):',
      '- What happened to people like them historically',
      '- What the group they represented contributed or suffered',
      '- What the historical record says about people in their position',
      '',
      'WRONG example for a fictional Underground Railroad conductor:',
      '"Elias Cole continued his work as a conductor and moved 47 more people to freedom before retiring in 1862."',
      'RIGHT example:',
      '"The conductors of the Underground Railroad moved an estimated 100,000 people to freedom between 1830 and 1865. Most of their names were never recorded in any document that survived."',
      '',
      'FOR ALL HISTORICAL RECORDS:',
      '- Tone is the last paragraph of a history book — factual, outside the story, neither triumphant nor tragic. Just the record.',
      '- Include the broader historical aftermath of the event itself — what happened, what it meant, how history resolved it.',
      '- Everything stated must be verifiable. If uncertain, omit.',
      '',
      'Generate the following:',
      'character_fates: For every named character in the scenario, apply the correct Historical Record Standard above based on their character_type. Include primary_source for real figures where one exists. Set primary_source to null for fictional/composite characters.',
      'immediate_outcome: Two to three sentences describing the verified historical result of the event the scenario depicts. Then list the key verified facts — dates, figures, outcomes — as an array of strings.',
      'historical_frame: Maximum three facts that place the event in wider historical significance. Verified facts only. No interpretation. No meaning-statements.',
      'open_threads: For each essential beat in the scenario, consider whether that beat corresponds to a historical question that was raised at inquiry, disputed, or never satisfactorily resolved. If so, include an entry with the beat\'s id as thread_id and the historical record of that open question.',
      'choice_echoes: For each essential beat in the scenario, provide the verified historical record of what actually happened at that moment. This is what the epilogue will compare the player\'s choices against.',
      'Return only a JSON object matching this exact schema with no other text, no markdown, no explanation:',
      '{',
      '"character_fates": [{ "character_id": "string", "name": "string", "outcome": "survived|died|unknown", "historical_record": "string", "primary_source": "string|null" }],',
      '"immediate_outcome": { "summary": "string", "key_facts": ["string"] },',
      '"historical_frame": ["string"],',
      '"open_threads": [{ "thread_id": "string", "historical_record": "string" }],',
      '"choice_echoes": [{ "beat_id": "string", "historical_record": "string" }]',
      '}',
    ].join('\n');

    const userPrompt = [
      `SCENARIO TITLE: ${title}`,
      world  ? `WORLD CONTEXT:\n${world}`  : '',
      stakes ? `STAKES / GOAL:\n${stakes}` : '',
      characters.length
        ? `NAMED CHARACTERS:\n${characters.map(c => {
            const typeLabel = c.character_type
              ? `type: ${c.character_type}${(c.character_type === 'fictional' || c.character_type === 'composite') && c.represents ? ` — represents: ${c.represents}` : ''}`
              : 'type: NOT DECLARED';
            return `- ${c.character_id || c.id}: ${c.name} (${c.role || c.publicFace || ''}) [${typeLabel}]`;
          }).join('\n')}`
        : '',
      essential_beats.length
        ? `ESSENTIAL BEATS (use each beat id as thread_id in open_threads and beat_id in choice_echoes):\n${essential_beats.map(b => `- id: ${b.id}, description: ${b.description}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n\n');

    try {
      const msg = await getAnthropicClient(anthropicApiKey).messages.create(
        {
          model: 'claude-sonnet-4-6',
          max_tokens: 8000,
          temperature: 0.3,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        },
        { timeout: 120_000, maxRetries: 0 }
      );
      console.log('[EPILOGUE-DATA] stop_reason:', msg.stop_reason, 'output_tokens:', msg.usage?.output_tokens);
      if (msg.stop_reason === 'max_tokens') {
        return res.status(500).json({ error: 'Epilogue generation truncated — the scenario has too many beats. Reduce to 3–6 essential beats and retry.' });
      }
      const text = msg.content[0]?.text?.trim();
      if (!text) return res.status(500).json({ error: 'No response from Claude.' });
      const cleaned     = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const epilogueData = JSON.parse(cleaned);

      const updated = {
        ...scenario,
        epilogue: {
          generated:        true,
          reviewed:         false,
          character_fates:  epilogueData.character_fates   || [],
          immediate_outcome: epilogueData.immediate_outcome || { summary: '', key_facts: [] },
          historical_frame: epilogueData.historical_frame  || [],
          open_threads:     epilogueData.open_threads      || [],
          choice_echoes:    epilogueData.choice_echoes     || [],
        },
      };
      await repos.scenarios.save(updated, { savedBy: req.adminUser?.email || 'admin' });
      console.log(`[EPILOGUE-DATA] Generated for scenario "${scenarioId}"`);
      res.json(updated.epilogue);
    } catch (err) {
      console.error('[EPILOGUE-DATA]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/generate/save', async (req, res) => {
    const { scenario, storyArc, characters = [], locations = [], clues = [], playerRoles = [] } = req.body;
    if (!scenario?.id) return badRequest(res, 'Missing scenario.');
    try {
      await repos.scenarios.save(scenario, { savedBy: req.adminUser?.email || 'admin' });
      if (storyArc?.id) repos.storyArcs.save(storyArc);
      characters.forEach(c  => repos.characters.save(c));
      locations.forEach(l   => repos.locations.save(l));
      clues.forEach(cl      => repos.clues.save(cl));
      playerRoles.forEach(r => repos.scenarios.savePlayerRole(normalizeBriefing(stripEmptyEndingNotes(r))));
      res.json({ ok: true, scenarioId: scenario.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Simulate (automated play-through) ────────────────────────────────────────
  r.post('/simulate', async (req, res) => {
    const { scenarioId, roleId } = req.body;
    if (!scenarioId || !roleId) return res.status(400).json({ error: 'scenarioId and roleId are required.' });

    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();

    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const BASE     = `http://localhost:${req.socket.localPort}`;
    const MAX_TURNS = 20;

    const SIM_INPUTS = [
      'I take stock of the situation and act on the most urgent thing in front of me.',
      'I focus on what I can control and move carefully.',
      'I speak to whoever is nearest and try to learn more.',
      'I examine the environment closely before deciding.',
      'I act on my best instinct given what I know.',
      'I prioritize the people who need me most right now.',
      'I press forward and deal with the consequences as they come.',
      'I pause, observe, and choose the safest path available.',
    ];
    function pickChoice(n) {
      return SIM_INPUTS[n % SIM_INPUTS.length];
    }

    async function drainSSE(fetchResp) {
      const decoder = new TextDecoder();
      let buf = '';
      let last = null;
      for await (const chunk of fetchResp.body) {
        buf += decoder.decode(chunk, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          const line = part.replace(/^data:\s*/, '').trim();
          if (!line) continue;
          try { last = JSON.parse(line); } catch {}
        }
      }
      return last;
    }

    try {
      send({ type: 'status', message: 'Starting session…' });

      const startResp = await fetch(`${BASE}/game/api/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId, roleId, narrativeStyle: 'immersive' }),
      });
      if (!startResp.ok) throw new Error(`Start failed: ${startResp.status}`);

      const startResult = await drainSSE(startResp);
      if (!startResult?.sessionId) throw new Error('No sessionId from start');

      const { sessionId } = startResult;
      let state   = startResult.nextState;
      let history = startResult.output?.history || [];

      send({ type: 'status', message: `Session ${sessionId} started. Running turns…` });

      let turnCount = 0;
      let finalResult = 'in-progress';

      while (turnCount < MAX_TURNS) {
        const playerInput = pickChoice(turnCount);
        send({ type: 'turn', n: turnCount + 1, playerInput });

        const turnResp = await fetch(`${BASE}/game/api/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state, playerInput, history, sessionId }),
        });
        if (!turnResp.ok) throw new Error(`Turn ${turnCount + 1} failed: ${turnResp.status}`);

        const turnResult = await drainSSE(turnResp);
        turnCount++;

        const narrative = turnResult?.output?.narrative || '';
        send({ type: 'turn_done', n: turnCount, narrative_preview: narrative.slice(0, 120) });

        state   = turnResult?.nextState   || state;
        history = turnResult?.output?.history || history;

        if (turnResult?.output?.endState?.isEnding) {
          finalResult = turnResult?.output?.endState?.result || 'complete';
          break;
        }
      }

      send({ type: 'status', message: 'Fetching closing prose…' });
      await fetch(`${BASE}/game/api/closing-prose?sessionId=${encodeURIComponent(sessionId)}&scenarioId=${encodeURIComponent(scenarioId)}&roleId=${encodeURIComponent(roleId)}`);

      send({ type: 'done', sessionId, turns: turnCount, result: finalResult });
    } catch (err) {
      send({ type: 'error', message: err.message });
    } finally {
      res.end();
    }
  });

  // ── Character Declarations Export ────────────────────────────────────────────
  // Returns a plain-text block formatted for pasting into an external AI
  // fact-checking system. Lists every player role and NPC with their declared
  // character_type, represents field, and fact_checked status.
  r.get('/scenarios/:id/character-declarations', async (req, res) => {
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);

    const playerRoles = repos.scenarios.findPlayerRoles(req.params.id);
    const characters  = repos.characters.findAll().filter(c => c.scenarioIds?.includes(req.params.id));

    const hr = '='.repeat(60);
    const lines = [
      `CHARACTER DECLARATIONS — ${scenario.title}`,
      `Scenario ID: ${req.params.id}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      'Paste this block into an external AI fact-checking system.',
      'Each declaration must be independently verified against the historical record.',
      hr,
      '',
      'PLAYER ROLES:',
      '',
    ];

    playerRoles.forEach(role => {
      lines.push(`CHARACTER: ${role.name}`);
      lines.push(`DECLARED TYPE: ${role.character_type || 'NOT DECLARED'}`);
      if (role.character_type !== 'real' && role.represents) {
        lines.push(`REPRESENTS: ${role.represents}`);
      }
      if (role.historical_record_note) {
        lines.push(`NOTE: ${role.historical_record_note}`);
      }
      lines.push(`FACT CHECKED: ${role.fact_checked === true ? 'yes' : 'no — needs review'}`);
      lines.push('');
    });

    lines.push('NPC CHARACTERS:');
    lines.push('');

    characters.forEach(char => {
      lines.push(`CHARACTER: ${char.name}`);
      lines.push(`DECLARED TYPE: ${char.character_type || 'NOT DECLARED'}`);
      if (char.character_type !== 'real' && char.represents) {
        lines.push(`REPRESENTS: ${char.represents}`);
      }
      lines.push(`FACT CHECKED: ${char.fact_checked === true ? 'yes' : 'no — needs review'}`);
      lines.push('');
    });

    const uncheckedRoles  = playerRoles.filter(r => r.fact_checked !== true).length;
    const uncheckedChars  = characters.filter(c => c.fact_checked !== true).length;
    const undeclaredRoles = playerRoles.filter(r => !r.character_type).length;
    const undeclaredChars = characters.filter(c => !c.character_type).length;

    lines.push(hr);
    lines.push(`SUMMARY: ${playerRoles.length} player roles, ${characters.length} NPCs`);
    lines.push(`Undeclared: ${undeclaredRoles} roles, ${undeclaredChars} NPCs`);
    lines.push(`Unverified: ${uncheckedRoles} roles, ${uncheckedChars} NPCs`);

    res.json({
      scenarioId:    req.params.id,
      scenarioTitle: scenario.title,
      text:          lines.join('\n'),
      stats: {
        playerRoles:    playerRoles.length,
        npcs:           characters.length,
        undeclaredRoles,
        undeclaredNpcs: undeclaredChars,
        uncheckedRoles,
        uncheckedNpcs:  uncheckedChars,
      },
    });
  });

  // ── Name Cascade ──────────────────────────────────────────────────────────
  // Collects all files belonging to a scenario and searches / replaces a name
  // across them. Two endpoints:
  //   GET  /scenarios/:id/name-search?oldName=...  → occurrences list (read-only)
  //   POST /scenarios/:id/name-cascade             → { oldName, newName } replace

  function getScenarioFilePaths(scenarioId) {
    const paths = [];
    const dataRoot = join(_dir, '../data');

    // Root scenario JSON
    paths.push(join(dataRoot, 'scenarios', `${scenarioId}.json`));

    // Main arc JSON
    paths.push(join(dataRoot, 'story_arcs', `${scenarioId}_main_arc.json`));

    // Player role files — roles store scenarioId on themselves, not in root scenario JSON
    const roleDir = join(dataRoot, 'scenarios', 'player_roles');
    try {
      const roleFiles = readdirSync(roleDir).filter(f => f.endsWith('.json'));
      roleFiles.forEach(f => {
        const fPath = join(roleDir, f);
        try {
          const r = JSON.parse(readFileSync(fPath, 'utf8'));
          if (r.scenarioId === scenarioId) paths.push(fPath);
        } catch {}
      });
    } catch {}

    // NPC character files for this scenario
    const charDir = join(dataRoot, 'characters');
    try {
      const charFiles = readdirSync(charDir).filter(f => f.endsWith('.json'));
      charFiles.forEach(f => {
        const fPath = join(charDir, f);
        try {
          const c = JSON.parse(readFileSync(fPath, 'utf8'));
          if (Array.isArray(c.scenarioIds) && c.scenarioIds.includes(scenarioId)) {
            paths.push(fPath);
          }
        } catch {}
      });
    } catch {}

    // Clue files
    const clueDir = join(dataRoot, 'clues', scenarioId);
    try {
      const clueFiles = readdirSync(clueDir).filter(f => f.endsWith('.json'));
      clueFiles.forEach(f => paths.push(join(clueDir, f)));
    } catch {}

    // Location files
    const locDir = join(dataRoot, 'locations', scenarioId);
    try {
      const locFiles = readdirSync(locDir).filter(f => f.endsWith('.json'));
      locFiles.forEach(f => paths.push(join(locDir, f)));
    } catch {}

    return paths;
  }

  r.get('/scenarios/:id/name-search', async (req, res) => {
    const { oldName } = req.query;
    if (!oldName || !oldName.trim()) return badRequest(res, 'oldName query param required');
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);

    const needle = oldName.trim();
    const files = getScenarioFilePaths(req.params.id);
    const results = [];

    for (const fPath of files) {
      try {
        const content = readFileSync(fPath, 'utf8');
        if (!content.includes(needle)) continue;
        const lines = content.split('\n');
        const hits = [];
        lines.forEach((line, idx) => {
          if (line.includes(needle)) {
            hits.push({ lineNumber: idx + 1, text: line.trim() });
          }
        });
        if (hits.length) {
          // Relative path from data root for display
          const dataRoot = join(_dir, '../data');
          const rel = fPath.startsWith(dataRoot)
            ? fPath.slice(dataRoot.length).replace(/\\/g, '/').replace(/^\//, '')
            : fPath;
          results.push({ file: rel, hits });
        }
      } catch {}
    }

    const totalHits = results.reduce((n, r) => n + r.hits.length, 0);
    res.json({ needle, fileCount: results.length, totalHits, results });
  });

  r.post('/scenarios/:id/name-cascade', async (req, res) => {
    const { oldName, newName } = req.body || {};
    if (!oldName || !oldName.trim()) return badRequest(res, 'oldName required');
    if (!newName || !newName.trim()) return badRequest(res, 'newName required');
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);

    const needle = oldName.trim();
    const replacement = newName.trim();
    const files = getScenarioFilePaths(req.params.id);
    const report = [];

    for (const fPath of files) {
      try {
        const content = readFileSync(fPath, 'utf8');
        if (!content.includes(needle)) continue;
        const updated = content.split(needle).join(replacement);
        const count = (content.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        writeFileSync(fPath, updated, 'utf8');
        const dataRoot = join(_dir, '../data');
        const rel = fPath.startsWith(dataRoot)
          ? fPath.slice(dataRoot.length).replace(/\\/g, '/').replace(/^\//, '')
          : fPath;
        report.push({ file: rel, replacements: count });
      } catch (err) {
        report.push({ file: fPath, error: err.message });
      }
    }

    const totalReplacements = report.reduce((n, r) => n + (r.replacements || 0), 0);
    res.json({ oldName: needle, newName: replacement, filesChanged: report.length, totalReplacements, report });
  });

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  TEMPORARY EXPORT ROUTE — REMOVE AFTER EXPORT IS COMPLETE       ║
  // ║  File: engine/admin/adminRouter.js  Line: ~1127                  ║
  // ╚══════════════════════════════════════════════════════════════════╝
  r.get('/export/scenario/:id', async (req, res) => {
    const exportKey = process.env.SCENARIO_EXPORT_KEY;
    if (!exportKey || req.query.export_key !== exportKey) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const scenarioPath = join(_dir, '../../data/scenarios', `${req.params.id}.json`);
    try {
      const contents = await readFile(scenarioPath, 'utf8');
      res.set('Content-Type', 'application/json').status(200).send(contents);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
      res.status(500).json({ error: err.message });
    }
  });
  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  END TEMPORARY EXPORT ROUTE                                      ║
  // ╚══════════════════════════════════════════════════════════════════╝

  // ============================================================
  // PIPELINE ENDPOINTS
  // ============================================================

  // Start a new pipeline for a scenario
  r.post('/pipeline/start', async (req, res) => {
    try {
      const { scenarioId, storyIdea, sessionLength = 30 } = req.body;
      if (!scenarioId || !storyIdea) {
        return res.status(400).json({ error: 'scenarioId and storyIdea are required' });
      }
      const state = await PipelineOrchestrator.startPipeline(scenarioId, storyIdea, sessionLength);
      res.json({ success: true, state });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get current pipeline status
  r.get('/pipeline/status/:scenarioId', async (req, res) => {
    try {
      const state = PipelineOrchestrator.getStatus(req.params.scenarioId);
      if (!state) return res.status(404).json({ error: 'No active pipeline for this scenario' });
      res.json(state);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Approve a step with accepted/rejected/edited corrections
  r.post('/pipeline/approve/:scenarioId/:stepName', async (req, res) => {
    try {
      const { scenarioId, stepName } = req.params;
      const { approvedScenario, changesApplied, changesRejected, manuallyEdited } = req.body;
      if (!approvedScenario && stepName !== 'synopsis') {
        return res.status(400).json({ error: 'approvedScenario is required' });
      }
      const state = PipelineOrchestrator.getStatus(scenarioId);
      if (!state) return res.status(404).json({ error: 'No active pipeline' });
      const step = state.steps[stepName];
      if (step) {
        step.changes_applied = changesApplied || 0;
        step.changes_rejected = changesRejected || 0;
        step.manually_edited = manuallyEdited || false;
      }
      if (stepName === 'synopsis') {
        const pipelineState = PipelineOrchestrator.getStatus(scenarioId);
        if (pipelineState && pipelineState.steps['synopsis']) {
          pipelineState.steps['synopsis'].approvedSynopsis = req.body.approvedSynopsis || req.body.approvedScenario;
          pipelineState.steps['synopsis'].approvedAt = new Date().toISOString();
          pipelineState.steps['synopsis'].status = 'approved';
          await VersionController.saveVersion(scenarioId, { synopsis: pipelineState.steps['synopsis'].approvedSynopsis }, {
            label: 'synopsis_approved',
            pipeline_step: 'synopsis'
          });
        }
      } else {
        await PipelineOrchestrator.approveStep(scenarioId, stepName, approvedScenario);
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get version history for a scenario
  r.get('/pipeline/versions/:scenarioId', async (req, res) => {
    try {
      const history = await VersionController.getHistory(req.params.scenarioId);
      res.json({ versions: history });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Roll back to a specific version
  r.post('/pipeline/rollback/:scenarioId/:versionNumber', async (req, res) => {
    try {
      const { scenarioId, versionNumber } = req.params;
      const restored = await VersionController.rollback(scenarioId, parseInt(versionNumber));
      res.json({ success: true, restored });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Compare two versions
  r.get('/pipeline/diff/:scenarioId/:versionA/:versionB', async (req, res) => {
    try {
      const { scenarioId, versionA, versionB } = req.params;
      const diff = await VersionController.diff(scenarioId, parseInt(versionA), parseInt(versionB));
      res.json({ diff });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get a specific version
  r.get('/pipeline/versions/:scenarioId/:versionNumber', async (req, res) => {
    try {
      const { scenarioId, versionNumber } = req.params;
      const version = await VersionController.getVersion(scenarioId, parseInt(versionNumber));
      res.json(version);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/pipeline/snapshot/:scenarioId', async (req, res) => {
    try {
      const { scenarioId } = req.params;
      const scenario = await repos.scenarios.findById(scenarioId);
      if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
      const version = await VersionController.saveVersion(scenarioId, scenario, {
        label: req.body.label || 'manual_snapshot',
        pipeline_step: req.body.pipeline_step || 'manual',
        changes_applied: req.body.changes_applied || 0,
        changes_rejected: req.body.changes_rejected || 0,
        manually_edited: req.body.manually_edited || false
      });
      res.json({ success: true, version });
    } catch (err) {
      console.error('[snapshot route error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/pipeline/inject-ending-notes/:scenarioId', async (req, res) => {
    try {
      const { scenarioId } = req.params;
      const { ending_notes } = req.body;
      if (!ending_notes || !Array.isArray(ending_notes)) {
        return res.status(400).json({ error: 'ending_notes array is required' });
      }
      const scenario = await repos.scenarios.findById(scenarioId);
      if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
      const playerRoles = repos.scenarios.findPlayerRoles(scenarioId);
      let updated = 0;
      for (const note of ending_notes) {
        const role = playerRoles.find(r => r.name === note.role_name);
        if (role) {
          if (note.briefing)           role.briefing          = note.briefing;
          if (note.starting_knowledge) role.startingKnowledge = note.starting_knowledge;
          if (note.hook_1 || note.hook_2 || note.hook_3) {
            role.character_hooks = [note.hook_1, note.hook_2, note.hook_3].filter(h => h);
          }
          if (note.suggested_secret)  role.suggested_secret  = note.suggested_secret;
          if (note.access_level)      role.accessLevel       = note.access_level;
          if (note.perspective)       role.perspective       = note.perspective;
          if (note.description)       role.description       = note.description;
          if (note.partial || note.failure) {
            role.ending_notes = role.ending_notes || {};
            if (note.partial) role.ending_notes.partial = note.partial;
            if (note.failure) role.ending_notes.failure = note.failure;
          }
          repos.scenarios.savePlayerRole(normalizeBriefing(stripEmptyEndingNotes(role)));
          updated++;
        }
      }
      await VersionController.saveVersion(scenarioId, scenario, {
        label: 'ending_notes_injected',
        pipeline_step: 'ending_notes',
        changes_applied: updated
      });
      res.json({ success: true, rolesUpdated: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Glossary ──────────────────────────────────────────────────────────────────

  r.get('/scenarios/:id/glossary', async (req, res) => {
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    res.json({ glossary: scenario.glossary || [] });
  });

  r.post('/scenarios/:id/suggest-glossary', async (req, res) => {
    if (!anthropicApiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured.' });
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);

    const existingTerms = (scenario.glossary || []).map(g => g.term.toLowerCase());

    // Technical facts — highest-priority source
    const rawFacts = (scenario.technical_facts?.facts || []).map(f => f.content || '').filter(Boolean);
    const techFactsText = rawFacts.length
      ? `TECHNICAL FACTS (verified historical and technical data — primary source for glossary terms):\n${rawFacts.join('\n')}`
      : '';

    // Introduction prose
    const introText = (scenario.introduction?.sections || []).map(s => s.text || '').filter(Boolean).join('\n\n');

    // Period vocabulary labels (avoid duplicating)
    const vocabTerms = (scenario.period_vocabulary?.categories || [])
      .flatMap(c => c.terms || []).map(t => t.term).join(', ');
    const periodVocabText = vocabTerms ? `Period vocabulary already defined (do not duplicate): ${vocabTerms}` : '';

    const contextText = [techFactsText, introText, periodVocabText]
      .filter(Boolean).join('\n\n').slice(0, 4000);

    const prompt = `You are building a player-facing glossary for a historical immersive fiction experience set in: ${scenario.setting || scenario.title || 'historical setting'}.

Read the following content and extract terms that need defining for a general reader — prioritize in this order:

1. TECHNICAL TERMS from the Technical Facts section — spacecraft systems, military equipment, medical terminology, engineering specifications, period-specific procedures. Extract specific named things: systems, components, procedures, equipment.

2. JARGON AND PERIOD PROCEDURE from period vocabulary — terms that sound familiar but have specific historical meanings.

3. HISTORICAL AND LEGAL TERMS from the introduction — acts, organizations, legal frameworks that shaped the moment.

CONTENT:
${contextText}

ALREADY IN GLOSSARY (do not suggest these):
${existingTerms.join(', ') || 'none'}

For each term write a definition in the voice of someone who knows this world giving a reader one quick, specific fact before sending them back into the story. One to two sentences. Period-accurate. Not a dictionary definition.

WRONG: "The fuel cell is an electrochemical device that converts..."
RIGHT: "One of three units that generated all of Odyssey's electricity — when all three died, the Command Module had 45 amp-hours left."

Return JSON only:
{
  "suggestions": [
    {
      "term": "exact term as it appears in prose",
      "definition": "one to two sentence period-specific definition",
      "source_type": "technical",
      "reason": "why a general reader might not know this"
    }
  ]
}

source_type must be one of: "technical", "jargon", "historical".
Maximum 20 suggestions. Prioritize technical terms — aim for at least 10 from the Technical Facts section if available. Skip terms a general reader clearly knows.`;

    try {
      const client = getAnthropicClient(anthropicApiKey);
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3500,
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = msg.content[0]?.text?.trim() || '{}';
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = match ? JSON.parse(match[0]) : { suggestions: [] };
      res.json({ suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [] });
    } catch (err) {
      console.error('[SUGGEST-GLOSSARY]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/scenarios/:id/generate-glossary-term', async (req, res) => {
    if (!anthropicApiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured.' });
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const { term } = req.body;
    if (!term?.trim()) return badRequest(res, 'term is required');

    const rawFacts = (scenario.technical_facts?.facts || []).map(f => f.content || '').filter(Boolean);
    const techFactsText = rawFacts.length
      ? `TECHNICAL FACTS (verified historical and technical data):\n${rawFacts.join('\n')}`
      : '';
    const introText = (scenario.introduction?.sections || []).map(s => s.text || '').filter(Boolean).join('\n\n');

    // Sample up to 5 existing definitions so the LLM can match the scenario's voice
    const existingDefs = (scenario.glossary || []).slice(0, 5)
      .map(g => `"${g.term}": ${g.definition}`).join('\n');
    const voiceSample = existingDefs
      ? `EXISTING GLOSSARY VOICE (match this register and style):\n${existingDefs}`
      : '';

    const contextText = [techFactsText, introText, voiceSample].filter(Boolean).join('\n\n').slice(0, 4000);
    const settingLabel = scenario.setting || scenario.title || 'historical setting';

    const prompt = `You are writing a single glossary entry for a historical immersive fiction experience set in: ${settingLabel}.

Term to define: "${term.trim()}"

${contextText ? `CONTEXT:\n${contextText}\n\n` : ''}Write a definition that:
- Is one to two sentences
- Is historically accurate for the period — no anachronisms, no modern terminology projected backward
- Matches the voice of the existing glossary entries shown above: terse and specific, not a dictionary definition
- Gives the reader one quick, specific fact before sending them back into the story

WRONG: "The fuel cell is an electrochemical device that converts hydrogen and oxygen into electricity..."
RIGHT: "One of three units that generated all of Odyssey's electricity — when all three failed, the Command Module had 45 amp-hours left."

For the source field, provide a citation ONLY if you are highly confident the source exists and supports the specific information you are citing. If uncertain, return an empty string — an empty source is strongly preferred over an uncertain or invented one.

Do NOT invent URLs, page numbers, journal articles, ISBN numbers, or direct quotations.

Accepted citation formats (use these exactly, nothing else):
- Books: "Author Last Name, Title" (no page numbers, no edition)
- Government/agency records: "Agency, Document Type, Year" — e.g. "NASA, Apollo 13 Mission Report, 1970"
- Archives: "Archive Name, Collection Name"
- Newspapers of record: "Publication, Date" (no headline, no URL)

Do NOT cite Wikipedia. Do NOT cite encyclopedia entries. Do NOT include URLs unless you are certain the URL exists. An empty source is the correct response when you are uncertain.

Return JSON only:
{
  "definition": "one to two sentence period-specific definition",
  "source": "citation in accepted format, or empty string if uncertain"
}`;

    try {
      const client = getAnthropicClient(anthropicApiKey);
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = msg.content[0]?.text?.trim() || '{}';
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return res.status(422).json({ error: 'LLM returned unparseable response' });
      const parsed = JSON.parse(match[0]);
      if (!parsed.definition) return res.status(422).json({ error: 'LLM response missing definition field' });
      res.json({ definition: parsed.definition, source: parsed.source || '' });
    } catch (err) {
      console.error('[GENERATE-GLOSSARY-TERM]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/scenarios/:id/glossary', async (req, res) => {
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const { term, definition, source } = req.body;
    if (!term?.trim() || !definition?.trim()) return badRequest(res, 'term and definition required');
    const glossary = scenario.glossary || [];
    if (glossary.some(g => g.term.toLowerCase() === term.trim().toLowerCase()))
      return badRequest(res, `Term "${term}" already exists in glossary`);
    glossary.push({ term: term.trim(), definition: definition.trim(), source: source?.trim() || '', approved: true });
    const updated = { ...scenario, glossary };
    await repos.scenarios.save(updated, { savedBy: req.adminUser?.email || 'admin' });
    res.json({ success: true, glossary: updated.glossary });
  });

  r.put('/scenarios/:id/glossary/:term', async (req, res) => {
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const termName = decodeURIComponent(req.params.term);
    const { definition, source, newTerm } = req.body;
    if (!definition?.trim()) return badRequest(res, 'definition required');
    const existing = scenario.glossary || [];
    if (newTerm !== undefined) {
      if (!newTerm.trim()) return badRequest(res, 'term name cannot be empty');
      const collision = existing.some(g =>
        g.term.toLowerCase() !== termName.toLowerCase() &&
        g.term.toLowerCase() === newTerm.trim().toLowerCase()
      );
      if (collision) return badRequest(res, 'a term with that name already exists');
    }
    const resolvedTerm = newTerm?.trim() || termName;
    const glossary = existing.map(g =>
      g.term.toLowerCase() === termName.toLowerCase()
        ? { ...g, term: resolvedTerm, definition: definition.trim(), source: source?.trim() ?? g.source ?? '' }
        : g
    );
    await repos.scenarios.save({ ...scenario, glossary }, { savedBy: req.adminUser?.email || 'admin' });
    res.json({ success: true, glossary });
  });

  r.delete('/scenarios/:id/glossary/:term', async (req, res) => {
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const termName = decodeURIComponent(req.params.term);
    const glossary = (scenario.glossary || []).filter(g => g.term.toLowerCase() !== termName.toLowerCase());
    await repos.scenarios.save({ ...scenario, glossary }, { savedBy: req.adminUser?.email || 'admin' });
    res.json({ success: true, glossary });
  });

  // ── Image Prompt Studio ───────────────────────────────────────────────────────

  r.post('/scenarios/:id/generate-image-prompt', async (req, res) => {
    if (!anthropicApiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured.' });
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const playerRoles = repos.scenarios.findPlayerRoles(req.params.id);

    const roleNames = playerRoles.map(r => r.name).filter(Boolean).join(', ');
    const genre     = (scenario.genre || []).join(', ');

    const userMessage = [
      `Scenario title: ${scenario.title || ''}`,
      `Historical description: ${scenario.description || ''}`,
      `Genre tags: ${genre}`,
      `Player roles: ${roleNames}`,
      `Cost tracked: ${scenario.costTracked || ''}`,
      `Session length: ${scenario.sessionTargetMinutes || ''} minutes`,
    ].filter(Boolean).join('\n');

    try {
      const msg = await getAnthropicClient(anthropicApiKey).messages.create(
        {
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          system: `You are a professional art director writing image generation prompts for a historical immersive fiction platform. You write scene descriptions that will be appended to a master technical specification and sent to an AI image generator.

Write a 300-400 word scene description for the scenario data provided. The description must include:
- The exact historical moment being depicted (specific time, place, date)
- The figures present: who they are, what they are doing, what they are wearing, their emotional state
- The physical environment in precise detail: architecture, objects, lighting sources, weather/atmosphere
- The specific lighting: quality, direction, color temperature, dramatic effect
- The emotional register: what mood the image should convey, what the viewer should feel

Do not include technical specifications, aspect ratios, file naming, or any reference to the image generation platform. Do not write headers or labels. Write only the scene narrative as flowing prose.

Return only the scene description. No preamble, no closing remarks.`,
          messages: [{ role: 'user', content: userMessage }],
        },
        { timeout: 60_000 }
      );
      const draft = msg.content[0]?.text?.trim();
      if (!draft) return res.status(500).json({ error: 'No text returned from Anthropic' });
      res.json({ draft });
    } catch (err) {
      console.error('[IMG-PROMPT-GEN]', err.message);
      res.status(500).json({ error: 'Draft generation failed', detail: err.message });
    }
  });

  r.put('/scenarios/:id/image-prompt', async (req, res) => {
    const scenario = await repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const { generation_prompt } = req.body;
    const updated = {
      ...scenario,
      image: {
        ...(scenario.image || {}),
        generation_prompt: generation_prompt || '',
      },
    };
    await repos.scenarios.save(updated, { savedBy: req.adminUser?.email || 'admin' });
    res.json({ success: true });
  });

  console.log('[admin] Pipeline routes registered');
  return r;
}
