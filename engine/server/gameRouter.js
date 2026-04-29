import { Router } from 'express';
import { Langfuse } from 'langfuse';

import {
  buildSystemPrompt,
  composeTurnPrompt,
  checkEndingReadiness,
  prepareForTts,
  getClueById,
} from '../services/PromptComposer.js';
import { mergeState, buildInitialState } from '../services/StateManager.js';

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
        id:               r.id,
        name:             r.name,
        description:      r.description || '',
        accessLevel:      r.accessLevel || 'staff',
        startLocation:    r.startLocationId || r.startLocation,
        perspective:      r.perspective || '',
        startingKnowledge: r.startingKnowledge || [],
        opening:          r.opening || null,
        roleInitialState: r.roleInitialState || {},
        briefing:         r.briefing || null
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
      const { scenarioId, roleId, narrativeStyle } = req.body;
      if (!scenarioId || !roleId) return res.status(400).json({ error: 'scenarioId and roleId are required.' });
      if (!anthropicApiKey)       return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured.' });

      const gameData = getScenarioData(repos, scenarioId);
      const { scenario, playerRoles, characters, locations, clues } = gameData;

      const role = playerRoles.find(r => r.id === roleId);
      if (!role) return res.status(404).json({ error: `Role "${roleId}" not found.` });

      // Empty introducedNpcs so all start-location NPCs trigger intro anchor injection
      const initialState = buildInitialState(scenario, role, locations);
      initialState.narrativeStyle  = narrativeStyle || 'focused';
      initialState.introducedNpcs  = [];

      const systemPrompt = buildSystemPrompt(scenario, locations);

      const openingChoicesText = (role.opening?.choices || [])
        .map(c => `- ${c.text || c}`)
        .join('\n');

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
      ].join('\n');

      const prompt = composeTurnPrompt(initialState, openingInput, gameData);

      console.log(`[START] scenario=${scenarioId} role=${roleId}`);
      const startTrace = langfuse?.trace({ name: 'start', input: { scenarioId, roleId } });

      const signal = AbortSignal.timeout(55000);
      const resp   = await fetch(ANTHROPIC_URL, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
        body: JSON.stringify({
          model: MODEL, max_tokens: 900, temperature: 0.8,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await resp.json();
      const text = data?.content?.[0]?.text;
      startTrace?.update({ output: { text: text?.slice(0, 200) } });

      if (!text) return res.status(500).json({ error: 'No text returned from Anthropic.' });

      let output;
      try { output = extractJson(text); } catch {
        return res.status(500).json({ error: 'Model returned invalid JSON for opening.' });
      }

      output.timeAdvance = 0;  // guard: opening never advances the clock
      const nextState = mergeState(initialState, output, scenario, clues, '');

      return res.json({ output, nextState });
    } catch (error) {
      const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      console.error(`[START ERROR] ${isTimeout ? 'timeout' : error.message}`);
      return res.status(500).json({ error: isTimeout ? 'AI request timed out.' : (error.message || 'Server error') });
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

      const systemPrompt = buildSystemPrompt(scenario, locations);
      const prompt       = composeTurnPrompt(state, playerInput, gameData);

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

      const prevAct = state.act || 1;
      let nextState = mergeState(state, output, scenario, clues, playerInput);
      if (state.finalAccusation) nextState.remainingMinutes = 0;

      if (nextState.act > prevAct) {
        output.actTransition = { from: prevAct, to: nextState.act };
      }

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
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text.' });
    if (!elevenLabsApiKey) return res.status(503).json({ error: 'TTS not configured.' });

    const cleaned          = prepareForTts(text);
    const charCount        = cleaned.length;
    const estimatedCostUsd = (charCount / 1000) * 0.15;
    console.log(`[TTS] chars=${charCount} est=$${estimatedCostUsd.toFixed(4)}`);

    const ttsTrace = langfuse?.trace({ name: 'tts', input: { chars: charCount, voiceId: elevenLabsVoiceId, model: 'eleven_flash_v2_5' } });
    const ttsGen   = ttsTrace?.generation({ name: 'tts-request', model: 'eleven_flash_v2_5', modelParameters: { stability: 0.5, similarity_boost: 0.75 }, input: cleaned, usage: { totalCost: estimatedCostUsd } });

    try {
      const { Readable } = await import('node:stream');
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
