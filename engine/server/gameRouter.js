import { Router } from 'express';
import { Langfuse } from 'langfuse';
import { randomUUID } from 'crypto';
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  buildSystemPrompt as buildSystemPromptLegacy,
  composeTurnPrompt,
  checkEndingReadiness,
  prepareForTts,
  getClueById,
  getArcPosition,
} from '../services/PromptComposer.js';
import { mergeState, buildInitialState } from '../services/StateManager.js';
import { buildSystemPrompt as buildSystemPromptFromData } from '../promptBuilder.js';
import { SchemaValidator } from '../services/SchemaValidator.js';
import * as appData from '../data.js';
import { AnchorTracker } from '../services/AnchorTracker.js';

// In-memory stores — non-serializable, lost on server restart (acceptable)
const anchorTrackers       = new Map(); // sessionId -> AnchorTracker
const anchorViolationNotes = new Map(); // sessionId -> string

// ID of the primary scenario backed by the flat data/ files
const PRIMARY_SCENARIO_ID = appData.getScenario().id;

function selectSystemPrompt(scenarioId, sessionId, scenario, locations) {
  if (scenarioId === PRIMARY_SCENARIO_ID) {
    return buildSystemPromptFromData(sessionId);
  }
  return buildSystemPromptLegacy(scenario, locations);
}

const _dir = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = join(_dir, '../data/transcripts');
mkdir(TRANSCRIPTS_DIR, { recursive: true }).catch(() => {});

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

// ── NPC state updater ─────────────────────────────────────────────────────────

function applyNpcUpdates(npcStates, npcUpdates) {
  if (!npcUpdates || !npcStates) return npcStates;
  const updated = { ...npcStates };
  for (const [id, u] of Object.entries(npcUpdates)) {
    if (!updated[id]) continue;
    const s = { ...updated[id] };
    if (u.trust_delta != null)          s.trust_level = Math.max(0, Math.min(10, (s.trust_level ?? 5) + u.trust_delta));
    if (Array.isArray(u.knows_add) && u.knows_add.length) s.knows = [...(s.knows || []), ...u.knows_add];
    if (u.aggression_mode != null)      s.aggression_mode = u.aggression_mode;
    if (u.last_interaction != null)     s.last_interaction = u.last_interaction;
    updated[id] = s;
  }
  return updated;
}

// ── Identity split validator ───────────────────────────────────────────────────

function validateSceneOutput(narrative, state) {
  if (!Array.isArray(state.playerAliases) || state.playerAliases.length === 0) {
    return { valid: true };
  }

  const namesToCheck = [
    state.playerRealName,
    state.playerCoverName,
    ...state.playerAliases.map(a => a.name),
  ].filter((n, i, arr) => n && arr.indexOf(n) === i);

  const npcPatterns = [
    /\b(NAME)\s+(stands|sits|moves|says|speaks|turns|looks|watches|steps|walks|runs|enters|leaves|crosses|approaches|appears|emerges|arrives)/i,
    /\b(NAME)\s*:\s*\S/i,
    /\bnear\s+(NAME)\b/i,
    /\bbeside\s+(NAME)\b/i,
    /\btoward\s+(NAME)\b/i,
    /\b(NAME)\s+is\s+(a|the)\b/i,
  ];

  for (const name of namesToCheck) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const pattern of npcPatterns) {
      const specific = new RegExp(pattern.source.replace('NAME', escaped), pattern.flags);
      if (specific.test(narrative)) {
        return { valid: false, reason: `"${name}" appears to be written as an NPC rather than the player` };
      }
    }
  }

  return { valid: true };
}

// ── Player attribution fixer ───────────────────────────────────────────────────

function fixPlayerAttribution(text) {
  return text.replace(/(?:^|\n)You:\s*(".*?")/gm, (match, quote) => {
    return `\n${quote}`;
  });
}

// ── Character ID leak fixer ────────────────────────────────────────────────────

function fixCharacterIdLeaks(text, characters) {
  const idPattern = /char_[a-z_]+:/gi;
  if (!idPattern.test(text)) return text;

  console.warn('[SCENE VALIDATOR] Character ID leak detected in narrative — auto-fixing');
  let fixed = text;
  for (const char of characters) {
    if (!char.id) continue;
    const idRegex = new RegExp(char.id + ':', 'gi');
    if (idRegex.test(fixed)) {
      console.warn(`[SCENE VALIDATOR] Replacing "${char.id}:" with "${char.name}:"`);
      fixed = fixed.replace(idRegex, char.name + ':');
    }
  }
  return fixed;
}

// ── Retry signal detectors ─────────────────────────────────────────────────────

function hasSpeech(narrative) {
  return narrative && /[""][^""]{4}|:\s*["']/.test(narrative);
}

function endsOnNpcQuestion(narrative, npcMoments) {
  if (!narrative || !Array.isArray(npcMoments) || npcMoments.length < 2) return false;
  const lines = narrative.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const last  = lines[lines.length - 1];
  return /^[A-Z][A-Za-z'\-\s]{1,30}:\s*["""'].+\?["""']\s*$/.test(last);
}

// ── SSE helpers ────────────────────────────────────────────────────────────────

function sendSse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

// Consume an Anthropic streaming response. Calls onChunk(text) for each
// narrative text fragment as it arrives. Returns { text, stopReason, usage }.
async function collectAnthropicStream(fetchResponse, onChunk) {
  const reader  = fetchResponse.body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = '';
  let accumulated = '';
  let stopReason  = null;
  let usage       = null;

  // Narrative extraction state — persists across partial reads
  let narCursor  = -1;    // -1 = "narrative" field not yet found
  let narEscaped = false;
  let narDone    = false;

  function flushNarrative() {
    if (narDone) return;
    if (narCursor === -1) {
      const m = /"narrative"\s*:\s*"/.exec(accumulated);
      if (!m) return;
      narCursor = m.index + m[0].length;
    }
    let chunk = '';
    let i = narCursor;
    while (i < accumulated.length) {
      const ch = accumulated[i];
      if (narEscaped) {
        switch (ch) {
          case 'n':  chunk += '\n'; break;
          case 't':  chunk += '\t'; break;
          case 'r':  chunk += '\r'; break;
          case '"':  chunk += '"';  break;
          case '\\': chunk += '\\'; break;
          case 'u': {
            const hex = accumulated.slice(i + 1, i + 5);
            if (hex.length === 4) { chunk += String.fromCharCode(parseInt(hex, 16)); i += 4; }
            break;
          }
          default: chunk += ch;
        }
        narEscaped = false;
      } else if (ch === '\\') {
        narEscaped = true;
      } else if (ch === '"') {
        narDone = true;
        i++;
        break;
      } else {
        chunk += ch;
      }
      i++;
    }
    narCursor = i;
    if (chunk) onChunk(chunk);
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuffer += decoder.decode(value, { stream: true });
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(raw); } catch { continue; }
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        accumulated += evt.delta.text;
        flushNarrative();
      } else if (evt.type === 'message_delta') {
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage) usage = evt.usage;
      }
    }
  }
  return { text: accumulated, stopReason, usage };
}

async function streamRawText(fetchResponse, onChunk) {
  const reader  = fetchResponse.body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer  = '';
  let accumulated = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuffer += decoder.decode(value, { stream: true });
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(raw); } catch { continue; }
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        accumulated += evt.delta.text;
        onChunk(evt.delta.text);
      }
    }
  }
  return accumulated;
}

// ── Epilogue generation ────────────────────────────────────────────────────────

function buildEpilogueSummary(state, endResult) {
  return {
    interacted_characters: state?.introducedNpcs     || [],
    named_conspirators:    state?.namedConspirators  || [],
    completed_beats:       (state?.resolved_threads  || []).map(t => t.thread_id),
    resolved_threads:      state?.resolved_threads   || [],
    outcome:               endResult || 'unknown',
  };
}

function normSource(val) {
  if (!val) return { citation: '', url: null, access_note: null };
  if (typeof val === 'string') return { citation: val, url: null, access_note: null };
  return { citation: val.citation || '', url: val.url || null, access_note: val.access_note || null };
}

function assembleBibliography(scenarioData, summary, sessionState) {
  const interacted  = new Set(summary.interacted_characters);
  const activeFacts = new Set(
    (sessionState?.technicalFacts || [])
      .filter(f => f.pre_seeded && (f.status === 'current' || f.status === 'stale'))
      .map(f => f.fact_id)
  );
  const bibMap = new Map();
  (scenarioData.epilogue?.character_fates || [])
    .filter(f => interacted.has(f.character_id) && f.primary_source)
    .forEach(f => { const s = normSource(f.primary_source); if (s.citation && !bibMap.has(s.citation)) bibMap.set(s.citation, s); });
  (scenarioData.technical_facts?.facts || [])
    .filter(f => activeFacts.has(f.fact_id) && f.source)
    .forEach(f => { const s = normSource(f.source); if (s.citation && !bibMap.has(s.citation)) bibMap.set(s.citation, s); });
  return [...bibMap.values()].sort((a, b) => {
    if (!!a.url !== !!b.url) return a.url ? -1 : 1;
    return a.citation.localeCompare(b.citation);
  });
}

async function generateEpilogueText(epilogueData, sessionSummary, closingProse, anthropicApiKey, playerHistoricalNote) {
  const playerNoteRule = playerHistoricalNote
    ? 'Layer 0 — The player character: the PLAYER CHARACTER NOTE below is verified fact about the person the player portrayed. Include it. It appears after the character\'s own session ends — do not omit it.'
    : '';

  const systemPrompt = [
    'You are writing the historical epilogue for a completed Living History session. This is not closing prose. It is historical record — a different register entirely: precise, unsentimental, a careful historian\'s final note. The closing prose has already been delivered. Do not repeat it or continue its style.',
    '',
    'You have two inputs: the session summary showing what this specific player did, and the scenario\'s verified historical facts. Select and sequence the relevant facts into an epilogue of 150 to 250 words.',
    '',
    'Follow the concentric circle rule:',
    playerNoteRule,
    'Layer 1 — The room: what happened to the named characters this player interacted with directly. Cover every character whose character_id appears in the session summary\'s interacted_characters list. Do not omit any.',
    'Layer 2 — The immediate event: the verified outcome from immediate_outcome.',
    'Layer 3 — The larger frame: maximum two facts from historical_frame that connect to what this player actually did. Do not reach beyond this.',
    '',
    'Additional rules:',
    'Open with the player\'s last significant action or the immediate consequence of the session\'s closing moment. Do not open with a general historical statement.',
    'Include open_threads entries only when the matching thread_id appears in the session\'s resolved_threads.',
    'Include choice_echoes entries only when the matching beat_id appears in the session\'s completed_beats.',
    'Do not invent, extrapolate, or editorialize. Every fact must come from the epilogue data block or the player character note.',
    'Register: historian\'s record. Precise. Clean. Unsentimental. No literary reach. No interiority.',
    'Last sentence: a verified historical fact. Not a meaning-statement. A fact.',
    'Length: 150 to 250 words exactly.',
  ].filter(Boolean).join('\n');

  const userParts = [];
  if (playerHistoricalNote) {
    userParts.push(`PLAYER CHARACTER NOTE:\n${playerHistoricalNote}`, '');
  }
  userParts.push(
    'SESSION SUMMARY:',
    JSON.stringify(sessionSummary, null, 2),
    '',
    'EPILOGUE DATA BLOCK:',
    JSON.stringify(epilogueData, null, 2),
    '',
    'CLOSING PROSE (do not repeat or continue its style):',
    closingProse,
  );
  const userContent = userParts.join('\n');

  const signal = AbortSignal.timeout(30000);
  const resp   = await fetch(ANTHROPIC_URL, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 400, temperature: 0.5,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic API error: ${resp.status}`);
  const respData = await resp.json();
  const text     = respData.content?.[0]?.text?.trim();
  if (!text) throw new Error('No epilogue text returned');

  const interacted = new Set(sessionSummary.interacted_characters || []);
  const sources    = [...new Set(
    (epilogueData.character_fates || [])
      .filter(f => interacted.has(f.character_id) && f.primary_source)
      .map(f => f.primary_source)
  )];

  return { text, label: 'Historical Record', sources, style_hint: 'historian' };
}

// ── Router export ──────────────────────────────────────────────────────────────

export function createGameRouter(repos, config = {}) {
  const { anthropicApiKey, elevenLabsApiKey, elevenLabsVoiceId } = config;
  const r = Router();

  // ── Public scenario listing ────────────────────────────────────────────────
  r.get('/scenarios', (_, res) => {
    const all = repos.scenarios.findAll()
      .filter(s => !s.hidden)
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
      .map(s => ({
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
        id:               r.id,
        name:             r.name,
        real_name:        r.real_name || null,
        description:      r.description || '',
        accessLevel:      r.accessLevel || 'staff',
        startLocation:    r.startLocationId || r.startLocation,
        perspective:      r.perspective || '',
        startingKnowledge: r.startingKnowledge || [],
        opening:          r.opening || null,
        roleInitialState: r.roleInitialState || {},
        briefing:         r.briefing || null,
        character_hooks:  r.character_hooks || [],
        suggested_secret: r.suggested_secret || null,
        context_sentence: r.context_sentence || null,
        bridge_sentence:  r.bridge_sentence  || null,
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

  // ── Start (engine-generated opening) ──────────────────────────────────────
  r.post('/start', async (req, res) => {
    try {
      const {
        scenarioId, roleId, narrativeStyle, sessionId: clientSessionId,
        character_context, player_addition, active_hook, ttsEnabled,
        onboardingFlow,
      } = req.body;
      if (!scenarioId || !roleId) return res.status(400).json({ error: 'scenarioId and roleId are required.' });
      if (!anthropicApiKey)       return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured.' });

      const gameData = getScenarioData(repos, scenarioId);
      const { scenario, playerRoles, characters, locations, clues } = gameData;

      const role = playerRoles.find(r => r.id === roleId);
      if (!role) return res.status(404).json({ error: `Role "${roleId}" not found.` });

      // Block start if any player alias collides with an NPC in this scenario
      const identityIssues = new SchemaValidator(repos).validateIdentityIntegrity()
        .filter(i => i.id.startsWith(scenarioId + '/') && i.severity === 'error');
      if (identityIssues.length > 0) {
        const detail = identityIssues.map(i => i.note).join(' | ');
        console.error(`[IDENTITY CONFLICT] Blocked start for scenario "${scenarioId}": ${detail}`);
        return res.status(409).json({ error: `Identity conflict detected in scenario data: ${detail}` });
      }

      // Empty introducedNpcs so all start-location NPCs trigger intro anchor injection
      const initialState = buildInitialState(scenario, role, locations);
      initialState.narrativeStyle  = narrativeStyle || 'focused';
      initialState.introducedNpcs  = [];

      // Pre-seed verified technical facts
      if (scenario.technical_facts?.reviewed === true) {
        initialState.technicalFacts = (scenario.technical_facts.facts || []).map(f => ({
          ...f,
          status:                  'current',
          source_character:        'scenario_record',
          pre_seeded:              true,
          turn_stated:             0,
          session_minutes_stated:  0,
        }));
        console.log(`[TECHNICAL-FACTS] Pre-seeded ${initialState.technicalFacts.length} fact(s) for scenario "${scenarioId}"`);
      } else {
        if (scenario.technical_facts?.generated) {
          console.log(`[TECHNICAL-FACTS] Skipped — not reviewed for scenario: ${scenarioId}`);
        }
        initialState.technicalFacts = [];
      }

      // Attach briefing context from the briefing screen
      if (character_context)   initialState.character_context = character_context;
      if (player_addition)     initialState.player_addition   = player_addition;
      if (active_hook)         initialState.active_hook       = active_hook;
      if (ttsEnabled !== undefined) initialState.ttsEnabled   = ttsEnabled;
      if (onboardingFlow)      initialState.onboardingFlow    = onboardingFlow;

      // Persist session so promptBuilder can read it; saveSession seeds npc_states on first save
      const sessionId = clientSessionId || randomUUID();
      const seededInitial = appData.saveSession(sessionId, initialState);

      // Per-session anchor tracker — fresh instance on every /start
      anchorTrackers.set(sessionId, new AnchorTracker(scenario.overused_anchors || []));

      const systemPrompt         = selectSystemPrompt(scenarioId, sessionId, scenario, locations);
      const resolvedSystemPrompt = systemPrompt.replace('{{ARC_POSITION}}', 'opening');

      const openingChoicesText = (role.opening?.choices || [])
        .map(c => `- ${c.text || c}`)
        .join('\n');

      // When the streamlined onboarding is active the player has not seen the world/stakes
      // screens — inject that context into Turn 1 prose so the world reveals itself naturally.
      const introSections = scenario.introduction?.sections || [];
      const worldText  = introSections.find(s => s.type === 'world')?.text  || '';
      const stakesText = introSections.find(s => s.type === 'stakes')?.text || '';
      const worldContextBlock = onboardingFlow === 'streamlined' && (worldText || stakesText)
        ? `WORLD CONTEXT — THIS TURN ONLY:

The player has not read a world introduction. Weave ONE OR TWO specific details from the historical context below into the opening prose — not as a block, not as summary, but as details that exist in the character's immediate awareness.

The details should feel like the character has been living with this knowledge for hours. Not introduced. Already present.

Choose the most specific and resonant details — a number, a temperature, a political fact — and let them arrive as part of the character's physical present. Do not summarize. Do not inventory. One detail from the world context, one from the stakes if it fits naturally. If forcing a second detail breaks the prose rhythm, use only one.

WORLD: ${worldText.slice(0, 400)}

STAKES: ${stakesText.slice(0, 400)}

Do not open with the historical context. Open inside the character's body. Let the context arrive in the second or third sentence, not the first. This applies to THIS TURN ONLY.`
        : '';

      const openingInput = [
        '[GAME_START] Render the opening scene.',
        '',
        'Use this narrative as your foundation (enrich with atmosphere, do not contradict):',
        role.opening?.narrative || `The investigation begins. You are ${role.name}.`,
        '',
        openingChoicesText
          ? `Suggested choices (rephrase so any NPC name has their role in parentheses if unintroduced):\n${openingChoicesText}`
          : 'Generate 3 opening choices appropriate to the role and scene.',
        '',
        'OPENING RULES:',
        '- Return timeAdvance: 0 — the opening consumes no game time.',
        `- Return location: "${initialState.location}"`,
        '- Apply all NPC intro rules: weave introAnchor descriptions into prose before any NPC speaks.',
        '- Do NOT set endState.isEnding: true.',
        worldContextBlock,
      ].join('\n');

      const prompt = composeTurnPrompt(initialState, openingInput, gameData);

      console.log(`[START] scenario=${scenarioId} role=${roleId}`);
      const startTrace = langfuse?.trace({ name: 'start', input: { scenarioId, roleId } });

      res.set({
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();

      const signal = AbortSignal.timeout(55000);
      const resp   = await fetch(ANTHROPIC_URL, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
        body: JSON.stringify({
          model: MODEL, max_tokens: 900, temperature: 0.8, stream: true,
          system: [{ type: 'text', text: resolvedSystemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const { text } = await collectAnthropicStream(
        resp,
        chunk => sendSse(res, { type: 'chunk', text: chunk }),
      );
      startTrace?.update({ output: { text: text?.slice(0, 200) } });

      if (!text) {
        sendSse(res, { type: 'error', error: 'No text returned from Anthropic.' });
        res.end();
        return;
      }

      let output;
      try { output = extractJson(text); } catch {
        sendSse(res, { type: 'error', error: 'Model returned invalid JSON for opening.' });
        res.end();
        return;
      }

      output.timeAdvance = 0;  // guard: opening never advances the clock

      // Fix raw character ID leaks before transcript and client delivery
      if (output.narrative) {
        output.narrative = fixCharacterIdLeaks(output.narrative, characters);
      }

      const nextState = mergeState(seededInitial, output, scenario, clues, '');
      if (output.npc_updates && nextState.npc_states) {
        nextState.npc_states = applyNpcUpdates(nextState.npc_states, output.npc_updates);
      }
      appData.saveSession(sessionId, nextState);

      // Transcript — fire-and-forget (writeFile creates fresh; no stale append risk)
      // introSections already declared above for worldContextBlock — reuse it
      let introText = '';
      for (const section of introSections) {
        const text = section.type === 'entry'
          ? (section.character_entries?.[roleId] || section.text || '')
          : (section.text || '');
        if (text) introText += text + '\n\n';
      }

      const transcriptHeader = [
        `# ${scenario.title || scenarioId}`,
        `## Scenario: ${scenarioId}`,
        `## Character: ${role.name}`,
        `## Session: ${sessionId}`,
        `## Date: ${new Date().toISOString()}`,
        `## Play Time: ${scenario.sessionTargetMinutes || '?'} minutes`,
        ``,
        `---`,
        ``,
        `## Character Brief`,
        ``,
        role.briefing || '',
        ``,
        `---`,
        ``,
        introText.trimEnd()
          ? `## Introduction\n\n${introText.trimEnd()}\n\n---\n\n## Session\n\n`
          : `## Session\n\n`,
        output.narrative || '',
        ``,
        `---`,
        ``,
      ].join('\n');

      const transcriptPath = join(TRANSCRIPTS_DIR, `${sessionId}.md`);
      console.log('[TRANSCRIPT-START] writing — path:', transcriptPath, 'scenario:', scenarioId, 'role:', roleId);
      await writeFile(transcriptPath, transcriptHeader)
        .catch(e => console.error('[TRANSCRIPT-START ERROR]', e.message));

      sendSse(res, { type: 'done', output, nextState, sessionId });
      res.end();
      return;
    } catch (error) {
      const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      const msg = isTimeout ? 'AI request timed out.' : (error.message || 'Server error');
      console.error(`[START ERROR] ${isTimeout ? 'timeout' : error.message}`);
      if (res.headersSent) {
        sendSse(res, { type: 'error', error: msg });
        res.end();
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // ── Turn ───────────────────────────────────────────────────────────────────
  r.post('/turn', async (req, res) => {
    try {
      const { state, playerInput, history = [], sessionId } = req.body;
      if (!state || !playerInput) return res.status(400).json({ error: 'Missing state or playerInput.' });
      if (!state.scenarioId)       return res.status(400).json({ error: 'state.scenarioId is required.' });
      if (!anthropicApiKey)        return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured.' });

      res.set({
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();

      console.log(`[TURN] scenario=${state.scenarioId} loc=${state.location} act=${state.act} input="${playerInput.slice(0, 60)}"`);

      const gameData = getScenarioData(repos, state.scenarioId);
      const { scenario, characters, locations, clues } = gameData;

      // Save current state so promptBuilder can read session context
      if (sessionId) appData.saveSession(sessionId, state);

      const systemPrompt = selectSystemPrompt(state.scenarioId, sessionId, scenario, locations);
      const arcPosition  = getArcPosition(state.remainingMinutes, scenario.sessionTargetMinutes || 15);
      let resolvedSystemPrompt = systemPrompt.replace('{{ARC_POSITION}}', arcPosition);

      // Inject per-turn anchor correction note, then clear it
      if (sessionId && anchorViolationNotes.has(sessionId)) {
        resolvedSystemPrompt += `\n\n${anchorViolationNotes.get(sessionId)}`;
        anchorViolationNotes.delete(sessionId);
      }

      // Ensure tracker exists (survives server restarts mid-session)
      if (sessionId && !anchorTrackers.has(sessionId)) {
        anchorTrackers.set(sessionId, new AnchorTracker(scenario.overused_anchors || []));
      }

      const prompt = composeTurnPrompt(state, playerInput, gameData);

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
        const gen  = turnTrace?.generation({ name: callName, model: MODEL, modelParameters: { max_tokens: toks, temperature: 0.8 }, input: [{ role: 'system', content: resolvedSystemPrompt }, ...messages] });
        const signal = AbortSignal.timeout(55000);
        const resp   = await fetch(ANTHROPIC_URL, {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
          body: JSON.stringify({
            model: MODEL, max_tokens: toks, temperature: 0.8,
            system: [{ type: 'text', text: resolvedSystemPrompt, cache_control: { type: 'ephemeral' } }],
            messages
          })
        });
        const data = await resp.json();
        const text = data?.content?.[0]?.text;
        gen?.end({ output: text, usage: { input: data?.usage?.input_tokens, output: data?.usage?.output_tokens }, metadata: { stop_reason: data?.stop_reason } });
        return { data, text };
      };

      const baseMessages = [...history.slice(-MAX_HISTORY_MSGS), { role: 'user', content: prompt }];

      const streamSignal = AbortSignal.timeout(55000);
      const streamResp   = await fetch(ANTHROPIC_URL, {
        method: 'POST', signal: streamSignal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
        body: JSON.stringify({
          model: MODEL, max_tokens: maxToks, temperature: 0.8, stream: true,
          system: [{ type: 'text', text: resolvedSystemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: baseMessages,
        }),
      });
      const { text, stopReason: streamStopReason } = await collectAnthropicStream(
        streamResp,
        chunk => sendSse(res, { type: 'chunk', text: chunk }),
      );

      if (!text) {
        scoreTrace(0, 'no-text-returned');
        sendSse(res, { type: 'error', error: 'No text returned from Anthropic.' });
        res.end();
        return;
      }

      let output;
      try {
        output = extractJson(text);
      } catch {
        const stopReason = streamStopReason || 'unknown';
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
          sendSse(res, { type: 'error', error: `Model returned invalid JSON (stop_reason: ${stopReason}).` });
          res.end();
          return;
        }
      }

      // Retry: silent NPC
      const npcPresent = Array.isArray(output.npcMoments) && output.npcMoments.length > 0;
      if (npcPresent && !hasSpeech(output.narrative)) {
        traceTags.push('has-retry', 'silent-npc');
        const firstNpcId = output.npcMoments[0]?.npc;
        const firstNpcChar = firstNpcId ? characters.find(c => c.id === firstNpcId) : null;
        const npcName = firstNpcChar?.name || firstNpcId?.replace(/_/g, ' ') || 'the NPC';
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

      // Retry: identity split (player character written as a separate NPC)
      const sceneValidation = validateSceneOutput(output.narrative || '', state);
      if (!sceneValidation.valid) {
        traceTags.push('has-retry', 'identity-split');
        console.warn(`[IDENTITY SPLIT] ${sceneValidation.reason} — retrying`);
        const retryMessages = [
          ...baseMessages,
          { role: 'assistant', content: text },
          { role: 'user', content: `Identity conflict in your response: ${sceneValidation.reason}. That name refers only to the player — remove the conflicting reference and rewrite so no character by that name appears separately from the player's own perspective. Return only valid JSON.` },
        ];
        try {
          const { text: retryText } = await callModel(retryMessages, null, 'retry-identity-split');
          if (retryText) {
            const retryOutput = extractJson(retryText);
            const revalidation = validateSceneOutput(retryOutput.narrative || '', state);
            if (revalidation.valid) {
              output = retryOutput;
              text   = retryText;
            } else {
              traceTags.push('identity-split-unresolved');
              console.error(`[IDENTITY SPLIT] Second failure — flagging for admin review. Session: ${sessionId}`);
            }
          }
        } catch {}
      }

      // Strip any "You:" attribution tags that slipped through generation
      if (output.narrative) {
        const fixed = fixPlayerAttribution(output.narrative);
        if (fixed !== output.narrative) {
          console.warn(`[ATTRIBUTION FIX] "You:" tag stripped — session ${sessionId}`);
          output.narrative = fixed;
        }
      }

      // Fix raw character ID leaks (e.g. "char_jim_lovell:" → "Jim Lovell:")
      if (output.narrative) {
        output.narrative = fixCharacterIdLeaks(output.narrative, characters);
      }

      // Anchor violation check — runs after all retries, before streaming done
      if (sessionId && anchorTrackers.has(sessionId) && output.narrative) {
        const violations = anchorTrackers.get(sessionId).check(output.narrative);
        if (violations.length > 0) {
          console.warn(
            `[ANCHOR VIOLATION] Session ${sessionId}:`,
            violations.map(v => `"${v.match}" (use #${v.uses})`).join(', ')
          );
          anchorViolationNotes.set(
            sessionId,
            `IMPORTANT: Do not use these phrases in your next response — ` +
            `they have already appeared in this session: ` +
            violations.map(v => `"${v.anchor || v.pattern}"`).join(', ')
          );
        }
      }

      const prevAct = state.act || 1;
      let nextState = mergeState(state, output, scenario, clues, playerInput);
      if (state.finalAccusation) nextState.remainingMinutes = 0;

      if (nextState.act > prevAct) {
        output.actTransition = { from: prevAct, to: nextState.act };
        const existing = anchorViolationNotes.get(sessionId) || '';
        const actNote  = `ACT BOUNDARY: The story has just entered Act ${nextState.act}. Raise the stakes — introduce new pressure, a revelation, or a forced choice. Do not repeat information or beats already covered in Act ${prevAct}.`;
        anchorViolationNotes.set(sessionId, existing ? `${existing}\n\n${actNote}` : actNote);
      }

      // Prevent LLM-generated endings before the FINAL arc threshold (80% elapsed)
      if (arcPosition !== 'final' && !state.finalAccusation) {
        if (output.endState?.isEnding) {
          console.log(`[ARC GUARD] arcPosition=${arcPosition} — suppressed premature isEnding`);
          output.endState.isEnding = false;
        }
      }

      if (state.finalAccusation && !output.endState?.isEnding) {
        const failCond = (scenario.failConditions || [])[0] || 'The investigation ends inconclusively.';
        output.endState = {
          isEnding: true, result: 'failure',
          scene: `Time has run out. ${failCond}`,
          conspiracySummary: (scenario.partialSuccessExamples || [])[0] || 'The conspiracy was not fully exposed.',
          whatPlayerDiscovered: 'No conclusion was reached in time.',
          outcome: (scenario.failConditions || [])[0] || 'The case remains unresolved.',
          playerContribution: 'The investigation could not be completed in the time available.',
          authorityResponse: scenario.coreSystems?.failureAuthorityQuote || 'We ran out of time.',
          correctSuspectIdentified: false
        };
      }

      if (output.endState?.isEnding) {
        output.endState.performance = {
          timeRemaining: nextState.remainingMinutes,
          result:        output.endState.result || 'failure'
        };
      }

      if (output.npc_updates && nextState.npc_states) {
        nextState.npc_states = applyNpcUpdates(nextState.npc_states, output.npc_updates);
      }
      if (sessionId) appData.saveSession(sessionId, nextState);

      // Transcript — fire-and-forget on normal turns, awaited on ending turns
      // so the file is on disk before the client immediately calls /closing-prose
      if (sessionId) {
        const locName = locations.find(l => l.id === (output.location || state.location))?.name || (output.location || state.location);
        const chunk = [
          `**Player:** ${playerInput}`,
          ``,
          `> Act ${nextState.act || 1} · ${locName} · ${nextState.remainingMinutes} min remaining`,
          ``,
          output.narrative || '',
          ``,
        ];
        if (output.endState?.isEnding) {
          const p = output.endState.performance || {};
          chunk.push(`## Ending — ${(output.endState.result || 'unknown').toUpperCase()}`);
          chunk.push(``);
          chunk.push(`**Result:** ${output.endState.result || '—'}`);
          chunk.push(`**Time remaining:** ${p.timeRemaining ?? '?'} min`);
          chunk.push(``);
        }
        chunk.push(`---`);
        chunk.push(``);
        const transcriptWrite = appendFile(join(TRANSCRIPTS_DIR, `${sessionId}.md`), chunk.join('\n'))
          .catch(e => console.error('[TRANSCRIPT]', e.message));
        if (output.endState?.isEnding) {
          await transcriptWrite;
          // Anchor usage summary — append only when any anchor was used more than once
          if (sessionId && anchorTrackers.has(sessionId)) {
            const anchorSummary = anchorTrackers.get(sessionId).getSummary();
            const hasViolations = Object.values(anchorSummary).some(v => v > 1);
            if (hasViolations) {
              await appendFile(
                join(TRANSCRIPTS_DIR, `${sessionId}.md`),
                `\n\n## Anchor Usage\n\`\`\`json\n${JSON.stringify(anchorSummary, null, 2)}\n\`\`\`\n`
              ).catch(e => console.error('[TRANSCRIPT ANCHOR]', e.message));
            }
          }
        }
      }

      const npcNames = output.npcMoments?.map(m => {
        const char = characters.find(c => c.id === m.npc);
        return char?.name || m.npc;
      });
      console.log(`[TURN] loc_out=${output.location || state.location} npcs=${JSON.stringify(npcNames)} isEnding=${output.endState?.isEnding ?? false}`);
      turnTrace?.update({ output: { narrative: output.narrative?.slice(0, 300), location: output.location, isEnding: output.endState?.isEnding ?? false } });
      scoreTrace(traceTags.length ? 0 : 1, traceTags.length ? traceTags.join(', ') : undefined);

      sendSse(res, { type: 'done', output, nextState, mockMode: false });
      res.end();
      return;
    } catch (error) {
      const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      const msg = isTimeout ? 'AI request timed out — please try again.' : (error.message || 'Server error');
      console.error(`[TURN ERROR] ${isTimeout ? 'timeout' : error.message}`);
      if (res.headersSent) {
        sendSse(res, { type: 'error', error: msg });
        res.end();
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // ── Notes (server-side aggregation, no LLM call) ──────────────────────────
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

      const visited   = state.visitedLocations || [];
      const unvisited = locations.filter(l => !visited.includes(l.id)).slice(0, 3);
      const nextLeads = unvisited.map(l => `${l.name} has not yet been investigated.`);

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
    const { text, sensory_opening, confirmation, trust_level, narrative_speed } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text.' });
    if (!elevenLabsApiKey) return res.status(503).json({ error: 'TTS not configured.' });

    const voiceId = elevenLabsVoiceId || 'onwK4e9ZLuTAKqWW03F9';

    function trustVoiceSettings(tl) {
      if (tl == null)  return { stability: 0.75, similarity_boost: 0.75, style: 0.30, use_speaker_boost: true, speed: 0.9 };
      if (tl <= 3)     return { stability: 0.25, similarity_boost: 0.75, style: 0.80, use_speaker_boost: true, speed: 0.9 };
      if (tl <= 6)     return { stability: 0.55, similarity_boost: 0.75, style: 0.50, use_speaker_boost: true, speed: 0.9 };
      return             { stability: 0.75, similarity_boost: 0.75, style: 0.30, use_speaker_boost: true, speed: 0.9 };
    }

    async function elevenLabsCall(rawText, speed = null, applyTrust = false) {
      const cleaned       = prepareForTts(rawText);
      const voiceSettings = applyTrust ? trustVoiceSettings(trust_level) : { stability: 0.75, similarity_boost: 0.75, use_speaker_boost: true, speed: 0.9 };
      if (speed != null) voiceSettings.speed = speed;
      const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'Accept': 'audio/mpeg', 'Content-Type': 'application/json', 'xi-api-key': elevenLabsApiKey },
        body: JSON.stringify({ text: cleaned, model_id: 'eleven_flash_v2_5', voice_settings: voiceSettings })
      });
      if (!resp.ok) throw new Error(`ElevenLabs ${resp.status}`);
      return { resp, charCount: cleaned.length };
    }

    // Build ordered segment list: confirmation (0.85) → sensory (0.88) → main (trust-mapped)
    const segments = [];
    if (confirmation)   segments.push({ raw: confirmation,   speed: 0.85, trust: false });
    if (sensory_opening) segments.push({ raw: sensory_opening, speed: 0.88, trust: false });
    segments.push({ raw: text, speed: narrative_speed ?? null, trust: true });

    const totalChars = segments.reduce((n, s) => n + prepareForTts(s.raw).length, 0);
    console.log(`[TTS] chars=${totalChars} segments=${segments.length} confirmation=${!!confirmation} sensory=${!!sensory_opening} est=$${((totalChars / 1000) * 0.15).toFixed(4)}`);

    const ttsTrace = langfuse?.trace({ name: 'tts', input: { chars: totalChars, segments: segments.length, voiceId, model: 'eleven_flash_v2_5' } });

    try {
      res.set('Content-Type', 'audio/mpeg');
      res.set('Cache-Control', 'no-store');

      if (segments.length === 1) {
        const { Readable } = await import('node:stream');
        const { resp } = await elevenLabsCall(text, null, true);
        ttsTrace?.update({ output: { segments: 1 } });
        Readable.fromWeb(resp.body).pipe(res);
      } else {
        const results = await Promise.all(segments.map(s => elevenLabsCall(s.raw, s.speed, s.trust)));
        ttsTrace?.update({ output: { segments: segments.length } });
        const buffers = await Promise.all(results.map(r => r.resp.arrayBuffer()));
        res.send(Buffer.concat(buffers.map(b => Buffer.from(b))));
      }
    } catch (err) {
      console.error(`[TTS ERROR] ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Closing prose ──────────────────────────────────────────────────────────
  r.get('/closing-prose', async (req, res) => {
    const { sessionId, roleId, endResult } = req.query;
    if (!sessionId)       return res.status(400).json({ error: 'sessionId is required.' });
    if (!anthropicApiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured.' });

    const transcriptPath = join(TRANSCRIPTS_DIR, `${sessionId}.md`);
    let transcript;
    try {
      transcript = await readFile(transcriptPath, 'utf8');
    } catch {
      return res.status(404).json({ error: 'Transcript not found.' });
    }

    // Resolve scenario and role for structured endings
    const scenarioMatch = transcript.match(/^##\s+Scenario:\s*(.+)$/m) || transcript.match(/^scenario:\s*(.+)$/m);
    let scenarioId      = scenarioMatch?.[1]?.trim();
    // Fallback: read scenarioId from session state if transcript header is absent
    if (!scenarioId && sessionId) {
      const sess = appData.getSession(sessionId);
      scenarioId = sess?.scenarioId || null;
    }
    const scenarioData  = scenarioId ? repos.scenarios.findAll().find(s => s.id === scenarioId) : null;
    const role          = roleId ? repos.scenarios.findPlayerRole(roleId) : null;

    // Use notes-guided path for partial/failure when the feature is enabled and notes exist
    const useStructured = scenarioData?.structured_endings_enabled
      && role
      && (endResult === 'partial' || endResult === 'failure')
      && role.ending_notes?.[endResult]?.what_happened;

    let closingPrompt;

    if (useStructured) {
      const notes = role.ending_notes[endResult];
      closingPrompt = [
        'You are writing the closing interior prose for a historical interactive fiction session.',
        `Character: ${role.name || roleId}`,
        `Ending type: ${endResult}`,
        '',
        'ENDING NOTES — ground your prose specifically in these details:',
        `What happened: ${notes.what_happened}`,
        `Who was present: ${notes.who_present || '—'}`,
        `Emotional weight: ${notes.emotional_weight || '—'}`,
        '',
        'SESSION TRANSCRIPT (final 2000 characters):',
        transcript.slice(-2000),
        '',
        'Write 2-3 sentences of closing interior prose for this character.',
        'Ground it in the specific ending notes above — what happened, who was there, what it cost.',
        'Write in the same voice and tense as the session transcript.',
        'Do not mention success or failure explicitly. Do not reference game mechanics.',
        'Write as if this is the last paragraph of a novel.',
        'Write only the prose — no title, no attribution.',
        '',
        'CLOSING PROSE CONSTRAINT: Closing prose may move inward but it may not step back. A physically grounded interior observation is permitted — render what the player character feels in their hands, their boots, their chest. What is prohibited is the sentence that names what the experience meant, what the player character learned, or what the session signified. The physical image is the meaning. Do not label it.',
        'This constraint applies to all narration in the closing prose. If named characters appear in the closing prose, their actions may be described physically but their significance may not be explained. The closing prose ends on a physical image. It does not end on a meaning-statement, a lesson, or a declaration addressed to the player.',
      ].join('\n');
    } else {
      closingPrompt = [
        'Based on the session transcript below, write 2-3 sentences of closing interior prose for this character.',
        'This is not a summary of events.',
        'Write in the same voice and tense as the session.',
        'Do not mention success or failure. Do not reference game mechanics.',
        'Write as if this is the last paragraph of a novel.',
        '',
        'CLOSING PROSE CONSTRAINT: Closing prose may move inward but it may not step back. A physically grounded interior observation is permitted — render what the player character feels in their hands, their boots, their chest. What is prohibited is the sentence that names what the experience meant, what the player character learned, or what the session signified. The physical image is the meaning. Do not label it.',
        'This constraint applies to all narration in the closing prose. If named characters appear in the closing prose, their actions may be described physically but their significance may not be explained. The closing prose ends on a physical image. It does not end on a meaning-statement, a lesson, or a declaration addressed to the player.',
        '',
        '---',
        '',
        transcript,
      ].join('\n');
    }

    res.set({
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    try {
      const signal = AbortSignal.timeout(30000);
      const resp = await fetch(ANTHROPIC_URL, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: MODEL, max_tokens: 300, temperature: 0.9, stream: true,
          messages: [{ role: 'user', content: closingPrompt }],
        }),
      });
      const prose = await streamRawText(resp, chunk => sendSse(res, { type: 'chunk', text: chunk }));

      // Generate historical epilogue and bibliography
      console.log('[EPILOGUE-CLOSE] reached closing-prose route — sessionId:', sessionId);
      let epilogueResult = null;
      let bibliography   = [];
      const sessionState = sessionId ? appData.getSession(sessionId) : null;
      console.log('[EPILOGUE-CLOSE] conditions — generated:', scenarioData?.epilogue?.generated, 'reviewed:', scenarioData?.epilogue?.reviewed);
      if (scenarioData?.epilogue?.generated && scenarioData?.epilogue?.reviewed) {
        const summary = buildEpilogueSummary(sessionState, endResult);
        console.log('[EPILOGUE-CLOSE] session summary — interacted_characters:', summary.interacted_characters?.length, 'completed_beats:', summary.completed_beats?.length, 'outcome:', summary.outcome);

        try {
          console.log('[EPILOGUE-CLOSE] calling epilogue API');
          epilogueResult = await generateEpilogueText(scenarioData.epilogue, summary, prose, anthropicApiKey, role?.historical_record_note || null);
        } catch (e) {
          console.error('[EPILOGUE]', e.message);
        }
        console.log('[EPILOGUE-CLOSE] epilogue API result — success:', !!epilogueResult, 'length:', epilogueResult?.text?.length);

        try {
          bibliography = assembleBibliography(scenarioData, summary, sessionState);
        } catch (e) {
          console.error('[BIBLIOGRAPHY]', e.message);
        }
        console.log('[EPILOGUE-CLOSE] bibliography assembled — entries:', bibliography?.length);

      } else if (scenarioData?.epilogue?.generated && !scenarioData?.epilogue?.reviewed) {
        console.warn(`[EPILOGUE] Skipped for session ${sessionId} — epilogue data not reviewed on scenario "${scenarioId}"`);
      }

      sendSse(res, { type: 'done', closing_prose: prose, epilogue: epilogueResult, bibliography });
      res.end();

      // Write closing sections to the session transcript
      if (prose) {
        try {
          const withResult = transcript.replace(/^## Result: .+$/m, `## Result: ${endResult || 'unknown'}`);
          await writeFile(transcriptPath, withResult, 'utf8');

          const aftermath = scenarioData?.historical_aftermath || '';
          const lines = ['', '## Closing Prose', '', prose];
          if (aftermath) lines.push('', '## Historical Aftermath', '', aftermath);
          if (epilogueResult?.text) {
            lines.push('', '---', '', '## Historical Record', '', epilogueResult.text);
          }
          if (bibliography?.length) {
            lines.push('', '---', '', '## Primary Sources', '');
            for (const src of bibliography) {
              if (src.url) {
                lines.push(`- [${src.citation}](${src.url})`);
              } else {
                lines.push(`- ${src.citation}`);
                if (src.access_note) lines.push(`  *(${src.access_note})*`);
              }
            }
          }
          lines.push('');
          await appendFile(transcriptPath, lines.join('\n'));
        } catch (e) {
          console.error('[TRANSCRIPT CLOSING]', e.message);
        }
      }
    } catch (err) {
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      console.error(`[CLOSING-PROSE] ${isTimeout ? 'timeout' : err.message}`);
      if (res.headersSent) {
        sendSse(res, { type: 'error', error: isTimeout ? 'Request timed out.' : err.message });
        res.end();
      } else {
        res.status(500).json({ error: isTimeout ? 'Request timed out.' : err.message });
      }
    }
  });

  r.post('/extract-facts', async (req, res) => {
    const { narrative = '', existingFacts = [] } = req.body || {};
    if (!narrative.trim()) return res.json({ newFacts: [] });
    try {
      const existingList = existingFacts.length
        ? `\nFacts already recorded:\n${existingFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
        : '';
      const prompt = `You are extracting concrete facts learned by a player in a historical immersion game.\n\nNarrative passage:\n"""\n${narrative}\n"""${existingList}\n\nExtract up to 3 NEW concrete facts the player character learned or observed in this passage that are not already in the recorded list. Each fact should be a single sentence, written from the player character's perspective (first person is fine). Focus on actions taken, people met, information discovered, or situations witnessed. Return ONLY a JSON array of strings, no other text. If there are no new facts, return [].`;

      const apiResp = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key':         anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages:   [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!apiResp.ok) return res.json({ newFacts: [] });
      const apiData = await apiResp.json();
      const raw = apiData.content?.[0]?.text?.trim() || '[]';
      const match = raw.match(/\[[\s\S]*\]/);
      const newFacts = match ? JSON.parse(match[0]) : [];
      return res.json({ newFacts: Array.isArray(newFacts) ? newFacts.filter(f => typeof f === 'string') : [] });
    } catch {
      return res.json({ newFacts: [] });
    }
  });

  return r;
}
