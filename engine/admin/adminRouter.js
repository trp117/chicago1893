import { Router } from 'express';
import { Langfuse } from 'langfuse';
import { readdir, readFile, unlink, stat } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

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
    if (!role.briefing || role.briefing.trim().length < 50)
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
function validateStoredScenario(scenario, playerRoles) {
  const errors = [];
  if (!playerRoles || playerRoles.length === 0) errors.push('No playerRoles defined');
  (playerRoles || []).forEach(role => {
    if (!role.briefing || role.briefing.trim().length < 50)
      errors.push(`Role "${role.id}" missing or too-short briefing`);
    if (!role.name)        errors.push(`Role "${role.id}" missing name`);
    if (!role.description) errors.push(`Role "${role.id}" missing description`);
  });
  if (!scenario?.introduction?.sections?.length) errors.push('Missing introduction sections');
  if (!scenario?.sessionTargetMinutes)           errors.push('Missing sessionTargetMinutes');
  return errors;
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

  const signal = AbortSignal.timeout(30_000);
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, temperature: 0.8,
      messages: [{ role: 'user', content: prompt }] })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Anthropic API error (${resp.status}): ${data?.error?.message || JSON.stringify(data)}`);
  const text = data?.content?.[0]?.text?.trim();
  if (!text) throw new Error('No text returned from Anthropic');
  return text;
}

function scalingGuide(minutes) {
  if (minutes <= 10) return { acts: 2, chars: '3–4', locs: '4–5',  clues: '3–4',  roles: 2, tpt: 2 };
  if (minutes <= 15) return { acts: 3, chars: '4–5', locs: '5–6',  clues: '5–6',  roles: 3, tpt: 2 };
  if (minutes <= 30) return { acts: 4, chars: '5–7', locs: '6–8',  clues: '7–9',  roles: 3, tpt: 2 };
  return               { acts: 6, chars: '7–10',locs: '8–12', clues: '10–14', roles: 4, tpt: 3 };
}

function maxTokens(minutes) {
  if (minutes <= 10) return 8000;
  if (minutes <= 15) return 12000;
  if (minutes <= 30) return 16000;
  return 20000;
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
  This text appears as the Character Brief on the introduction screen and is written
  to the session transcript. A missing or template-copied briefing will create a blank
  transcript section. Write it specific to this character and this opening moment.
- character_hooks: array of exactly 3 first-person sentences — alternative starting conditions (different debt, different rumour, different relationship). One is picked randomly each session.
- suggested_secret: one sentence. Something nobody in the story knows about this player character.

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
      "briefing": "You are standing [specific location] with [specific physical detail]. You have [what this character uniquely knows that others do not]. [What is at stake for them personally right now]. [The immediate sensory detail of this moment]. [Final sentence lands them at the threshold of their first action].",
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

  r.get('/scenarios/:id/sensory-opening', (req, res) => {
    const scenario = repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    res.json({
      ...SENSORY_DEFAULTS,
      ...(scenario.sensory_opening || {}),
      tts_narration_speed: scenario.tts_narration_speed ?? 1.0,
    });
  });

  r.patch('/scenarios/:id/sensory-opening', (req, res) => {
    const scenario = repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const { tts_narration_speed, ...sopFields } = req.body;
    const merged = { ...SENSORY_DEFAULTS, ...(scenario.sensory_opening || {}), ...sopFields };
    const updated = { ...scenario, sensory_opening: merged };
    if (tts_narration_speed !== undefined) updated.tts_narration_speed = Number(tts_narration_speed);
    repos.scenarios.save(updated);
    res.json({ ...merged, tts_narration_speed: updated.tts_narration_speed ?? 1.0 });
  });

  // ── Locations ────────────────────────────────────────────────────────────────
  r.get('/scenarios',      (_, res) => res.json(repos.scenarios.findAll()));
  r.get('/scenarios/:id/full', (req, res) => {
    const scenario = repos.scenarios.findById(req.params.id);
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
  r.get('/scenarios/:id/health', (req, res) => {
    const scenario = repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const playerRoles = repos.scenarios.findPlayerRoles(req.params.id);
    const missing = validateStoredScenario(scenario, playerRoles);
    const roles = playerRoles.map(role => ({
      id:             role.id,
      name:           role.name,
      hasBriefing:    !!(role.briefing && role.briefing.trim().length >= 50),
      hasDescription: !!role.description,
    }));
    res.json({ scenarioId: req.params.id, healthy: missing.length === 0, missing, roles });
  });

  // ── Scenario repair ──────────────────────────────────────────────────────────
  r.post('/scenarios/:id/repair', async (req, res) => {
    if (!anthropicApiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured.' });
    const scenario = repos.scenarios.findById(req.params.id);
    if (!scenario) return notFound(res);
    const playerRoles = repos.scenarios.findPlayerRoles(req.params.id);

    const repairs = [];
    const errors  = [];

    const rolesMissingBriefing = playerRoles.filter(
      r => !r.briefing || r.briefing.trim().length < 50
    );

    if (rolesMissingBriefing.length === 0) {
      return res.json({ success: true, message: 'Scenario is complete — no repairs needed', repairs: [], errors: [], remaining: [] });
    }

    for (const role of rolesMissingBriefing) {
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

    const updatedRoles = repos.scenarios.findPlayerRoles(req.params.id);
    const remaining    = validateStoredScenario(scenario, updatedRoles);

    res.json({ success: errors.length === 0, repairs, errors, remaining });
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
    const toks   = maxTokens(Number(playTimeMinutes));

    console.log(`[GENERATE] playTime=${playTimeMinutes}min tokenBudget=${toks}`);

    const genTrace = langfuse?.trace({ name: 'story-generate', input: { playTimeMinutes, tokenBudget: toks } });
    const genSpan  = genTrace?.generation({ name: 'generate', model: 'claude-sonnet-4-6', modelParameters: { max_tokens: toks, temperature: 0.7 }, input: [{ role: 'user', content: prompt.slice(0, 2000) + '…' }] });

    const timeoutMs = Math.max(480_000, toks * 25);  // ~25ms/token + headroom
    const signal    = AbortSignal.timeout(timeoutMs);
    let text;
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: toks,
          temperature: 0.7,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await response.json();
      if (!response.ok) {
        const apiErr = data?.error?.message || data?.error || JSON.stringify(data);
        genSpan?.end({ metadata: { error: apiErr, status: response.status } });
        genTrace?.update({ tags: ['api-error'] });
        return res.status(500).json({ error: `Anthropic API error (${response.status}): ${apiErr}` });
      }
      text = data?.content?.[0]?.text;
      genSpan?.end({ output: `${text?.length ?? 0} chars`, usage: { input: data?.usage?.input_tokens, output: data?.usage?.output_tokens }, metadata: { stop_reason: data?.stop_reason } });
      console.log(`[GENERATE] response received stop_reason=${data?.stop_reason} input_tokens=${data?.usage?.input_tokens} output_tokens=${data?.usage?.output_tokens}`);
      if (!text) {
        genTrace?.update({ tags: ['no-text'] });
        return res.status(500).json({ error: 'No response from Claude.', raw: data });
      }
    } catch (err) {
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      genSpan?.end({ metadata: { error: isTimeout ? 'timeout' : err.message } });
      genTrace?.update({ tags: [isTimeout ? 'timeout' : 'error'] });
      console.error(`[GENERATE ERROR] ${isTimeout ? `timeout after ${timeoutMs / 1000}s` : err.message}`);
      return res.status(500).json({ error: isTimeout ? 'Generation timed out — try a shorter play time.' : err.message });
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
      const signal   = AbortSignal.timeout(120_000);
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, temperature: 0.8, messages: [{ role: 'user', content: prompt }] })
      });
      const data = await response.json();
      if (!response.ok) return res.status(500).json({ error: `Anthropic API error (${response.status}): ${data?.error?.message || JSON.stringify(data?.error)}` });
      text = data?.content?.[0]?.text;
      if (!text) return res.status(500).json({ error: 'No response from Claude.' });
    } catch (err) {
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
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
        const scenario  = content.match(/^scenario: (.+)$/m)?.[1]?.trim() || '—';
        const character = content.match(/^character: (.+)$/m)?.[1]?.trim() || '—';
        const started   = content.match(/^started: (.+)$/m)?.[1]?.trim() || null;
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

  r.post('/generate/save', (req, res) => {
    const { scenario, storyArc, characters = [], locations = [], clues = [], playerRoles = [] } = req.body;
    if (!scenario?.id) return badRequest(res, 'Missing scenario.');
    try {
      repos.scenarios.save(scenario);
      repos.storyArcs.save(storyArc);
      characters.forEach(c  => repos.characters.save(c));
      locations.forEach(l   => repos.locations.save(l));
      clues.forEach(cl      => repos.clues.save(cl));
      playerRoles.forEach(r => repos.scenarios.savePlayerRole(r));
      res.json({ ok: true, scenarioId: scenario.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
}
