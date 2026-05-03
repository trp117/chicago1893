import { Router } from 'express';
import { Langfuse } from 'langfuse';

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

PLAYER BRIEFING RULES (required on every playerRole):
- briefing: exactly 5 sentences, second person (You are...)
  S1: who they are (name, trade, station in this world)
  S2: one relationship with another character that has tension right now
  S3: one thing they know they were not meant to know
  S4: one want they have not yet acted on
  S5: one sensory/physical detail placing them in this world right now
  Must make the player feel already late for something. No backstory, no history lesson.
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
      "briefing": "You are [name]. [Tension sentence]. [Forbidden knowledge]. [Unfulfilled want]. [Sensory anchor right now].",
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
  r.get('/dashboard', (_, res) => {
    res.json({
      characters:  repos.characters.findAll().length,
      locations:   repos.locations.findByScenario().length,
      clues:       repos.clues.findByScenario().length,
      storyArcs:   repos.storyArcs.findByScenario().length,
      playerRoles: repos.scenarios.findPlayerRoles().length,
      players:     repos.players.findAll().length,
      sessions:    repos.sessions.findAll().length,
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

  // ── Locations ────────────────────────────────────────────────────────────────
  r.get('/scenarios',      (_, res) => res.json(repos.scenarios.findAll()));
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

    let text;
    try {
      const signal   = AbortSignal.timeout(300_000);
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
      console.error(`[GENERATE ERROR] ${isTimeout ? 'timeout after 300s' : err.message}`);
      return res.status(500).json({ error: isTimeout ? 'Generation timed out — try a shorter play time.' : err.message });
    }

    try {
      const generated = extractJson(text);
      const missing = ['scenario','storyArc','characters','locations','clues','playerRoles'].filter(k => !generated[k]);
      if (missing.length) {
        genTrace?.update({ tags: ['missing-keys'] });
        return res.status(500).json({ error: `Generated JSON is missing: ${missing.join(', ')}`, rawText: text.slice(0,500) });
      }
      genTrace?.update({ tags: ['success'], output: { scenarioId: generated.scenario?.id, characters: generated.characters?.length, locations: generated.locations?.length, clues: generated.clues?.length } });
      console.log(`[GENERATE] saved scenario=${generated.scenario?.id} chars=${generated.characters?.length} locs=${generated.locations?.length} clues=${generated.clues?.length}`);
      return res.json(generated);
    } catch (err) {
      const tail = text.slice(-200);
      genTrace?.update({ tags: ['invalid-json'] });
      return res.status(500).json({ error: `Claude returned invalid JSON (response may be truncated).\n\nLast 200 chars:\n${tail}` });
    }
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
