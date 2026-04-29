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

function buildGenerationPrompt({ title, concept, playTimeMinutes, tone, historicalRealism }) {
  const s   = scalingGuide(playTimeMinutes);
  const sid = slugify(title);
  const aid = `${sid}_main_arc`;

  return `You are a professional story designer for an AI-powered interactive mystery game engine.
Generate a complete, playable story package from the parameters and source material below.

GAME ENGINE OVERVIEW:
Players explore locations, question NPCs, and discover clues to solve a mystery before time expires.
Key mechanics:
- Players travel between locations to find clues and encounter NPCs
- Each NPC has a suspicion score that rises as incriminating clues are found
- Clues are location-specific — a player must visit the correct location to discover each one
- NPCs reveal more as their suspicion rises and the player presents evidence
- The game ends when the player makes a final accusation, time expires, or a climax is triggered

STORY PARAMETERS:
- Title: ${title}
- Scenario ID (use exactly): ${sid}
- Story Arc ID (use exactly): ${aid}
- Play Time: ${playTimeMinutes} minutes
- Tone: ${tone}
- Historical Realism: ${historicalRealism}
- Time per turn: ${s.tpt} minutes

SCALING REQUIREMENTS FOR ${playTimeMinutes} MINUTES:
- Acts: exactly ${s.acts} acts covering 0–${playTimeMinutes} minutes
- Characters: ${s.chars} (include at least 1–2 culprits, 1 authority figure, 1 neutral/ally)
- Locations: ${s.locs} (spread characters across locations, 2–3 per location)
- Clues: ${s.clues} (exactly 2 must have isKeyEvidence: true)
- Player Roles: ${s.roles} (different access levels and starting locations)

SOURCE MATERIAL:
${concept}

OUTPUT RULES — READ CAREFULLY:
1. Return ONLY a valid JSON object — no markdown, no code fences, no explanation text
2. All entity IDs must be lowercase slugs (letters, numbers, underscores only)
3. Use the exact scenario ID "${sid}" and story arc ID "${aid}" throughout
4. All cross-references MUST be internally consistent:
   - location.linkedCharacterIds → must match actual character IDs you create
   - clue.discoveryLocationId → must match an actual location ID you create
   - clue.implicatesCharacterIds → must match actual character IDs you create
   - scenario.keyEvidenceClueIds → must match clue IDs where isKeyEvidence: true
   - scenario.playerRoleIds → must match actual player role IDs you create
   - playerRole.startLocationId → must match an actual location ID you create
5. Exactly 2 clues must have isKeyEvidence: true — these unlock the ending
6. Distribute clues across at least 3 different locations
7. The culprit should not be obvious at the start — build misdirection
8. Every NPC needs a distinct voice and a reason to be evasive or helpful
9. Opening narratives should be vivid and immersive — 2–4 sentences minimum

REQUIRED JSON STRUCTURE:

{
  "scenario": {
    "id": "${sid}",
    "version": "1.0.0",
    "title": "${title}",
    "description": "2–3 sentence description of the scenario",
    "genre": ["${tone}"],
    "historicalRealism": "${historicalRealism}",
    "freedomLevel": "guided",
    "sessionTargetMinutes": ${playTimeMinutes},
    "storyArcIds": ["${aid}"],
    "playerRoleIds": ["role_id_1", "role_id_2"],
    "keyEvidenceClueIds": ["clue_id_for_key_evidence_1", "clue_id_for_key_evidence_2"],
    "systems": {
      "timePerTurnDefault": ${s.tpt},
      "scales": {
        "threat":      { "min": 0,  "max": 10, "default": 1 },
        "authorityTrust": { "min": -3, "max": 5,  "default": 1 }
      },
      "pressureEvents": ["pressure event 1", "pressure event 2", "pressure event 3"]
    },
    "winConditions": ["win condition 1", "win condition 2"],
    "failConditions": ["fail condition 1", "fail condition 2"],
    "partialSuccessExamples": ["partial success example"],
    "createdAt": "2025-01-01T00:00:00Z",
    "updatedAt": "2025-01-01T00:00:00Z"
  },
  "storyArc": {
    "id": "${aid}",
    "scenarioId": "${sid}",
    "name": "Arc name",
    "premise": "The central dramatic situation",
    "goal": "What the player must accomplish",
    "openingSituation": "The immediate problem at the very start",
    "acts": [
      { "actNumber": 1, "name": "Act name", "minuteRange": [0, ${Math.round(playTimeMinutes / s.acts)}], "beats": ["beat 1", "beat 2", "beat 3"] }
    ],
    "createdAt": "2025-01-01T00:00:00Z",
    "updatedAt": "2025-01-01T00:00:00Z"
  },
  "characters": [
    {
      "id": "character_slug",
      "scenarioIds": ["${sid}"],
      "name": "Full Name",
      "role": "Their official role or occupation",
      "publicFace": "How they appear to strangers",
      "privateGoal": "What they really want",
      "fear": "Their greatest vulnerability or what they most want to hide",
      "knowledge": ["specific thing they know 1", "specific thing they know 2"],
      "voice": "Speaking style description",
      "trustLogic": "What makes them open up or shut down",
      "secrets": ["secret 1", "secret 2"],
      "aggressionProfile": {
        "mildPressure": "How they react when lightly questioned",
        "heavyPressure": "How they react when directly accused or threatened",
        "breakingPoint": "What they will never admit under any circumstances",
        "fleeCondition": "Exact condition that triggers flight — empty string if they never flee",
        "fleeStyle": "How they escape — empty string if they never flee",
        "chaseStyle": "Behavior when chased — empty string if they never flee",
        "capturedBehavior": "What they do if caught or cornered",
        "strikeFirst": null
      },
      "createdAt": "2025-01-01T00:00:00Z",
      "updatedAt": "2025-01-01T00:00:00Z"
    }
  ],
  "locations": [
    {
      "id": "location_slug",
      "scenarioId": "${sid}",
      "name": "Location Name",
      "description": "Vivid, atmospheric 1–2 sentence description of what the player sees and feels",
      "mood": "comma-separated mood tags",
      "linkedCharacterIds": ["character_id_1", "character_id_2"],
      "atmosphericDetails": ["evocative detail 1", "evocative detail 2", "evocative detail 3"],
      "createdAt": "2025-01-01T00:00:00Z",
      "updatedAt": "2025-01-01T00:00:00Z"
    }
  ],
  "clues": [
    {
      "id": "clue_slug",
      "scenarioId": "${sid}",
      "title": "Short Clue Name",
      "description": "What the player discovers — written from the player's perspective",
      "category": "documentary OR observation OR physical OR testimony",
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
      "scenarioId": "${sid}",
      "name": "Role Name",
      "description": "1–2 sentence description shown to the player when choosing this role",
      "startLocationId": "location_slug",
      "startingKnowledge": ["something they already know at the start"],
      "accessLevel": "worker OR staff OR director",
      "perspective": "Instructions for the narrative AI: how to write from this role's point of view, authority level, and relationship to other characters",
      "opening": {
        "narrative": "Opening in two parts. Part 1 — context (2–3 sentences): establish the time period, place, and historical situation in second person — draw the player into the world before the action starts, making clear what is at stake and why this moment matters. Part 2 — scene entry (2–3 sentences): zoom into the immediate situation, where the player is right now, what surrounds them, and the first hook or tension that opens the investigation. Do NOT start mid-action.",
        "npcMoments": [],
        "choices": ["first action choice", "second action choice", "third action choice"]
      },
      "roleInitialState": {
        "inventory": ["starting item 1", "starting item 2"],
        "flags": {},
        "suspicion": { "culprit_character_id": 1 }
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
    const { title, concept, playTimeMinutes = 15, tone = 'mystery', historicalRealism = 'medium' } = req.body;
    if (!title)   return badRequest(res, '"title" is required.');
    if (!concept) return badRequest(res, '"concept" is required.');

    const prompt = buildGenerationPrompt({ title, concept, playTimeMinutes: Number(playTimeMinutes), tone, historicalRealism });
    const toks   = maxTokens(Number(playTimeMinutes));

    console.log(`[GENERATE] "${title}" playTime=${playTimeMinutes}min tokenBudget=${toks}`);

    const genTrace = langfuse?.trace({ name: 'story-generate', input: { title, concept, playTimeMinutes, tone, historicalRealism, tokenBudget: toks } });
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
