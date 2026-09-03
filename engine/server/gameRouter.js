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
  evaluateClosure,
  evaluateDefiningMoment,
  definingMomentDue,
  resolveDefiningMomentBlock,
  closureShouldClose,
  prepareForTts,
  getClueById,
  getArcPosition,
} from '../services/PromptComposer.js';
import { mergeState, buildInitialState, recordDefiningDecision } from '../services/StateManager.js';
import { buildSystemPrompt as buildSystemPromptFromData } from '../promptBuilder.js';
import { SchemaValidator } from '../services/SchemaValidator.js';
import * as appData from '../data.js';
import { AnchorTracker } from '../services/AnchorTracker.js';

// In-memory stores — non-serializable, lost on server restart (acceptable)
const anchorTrackers       = new Map(); // sessionId -> AnchorTracker
const anchorViolationNotes = new Map(); // sessionId -> string

// ID of the primary scenario backed by the flat data/ files
const PRIMARY_SCENARIO_ID = appData.getScenario().id;

// characters is the scenario roster, threaded through so the system prompt can state it
// as a CLOSED SET (buildApprovedCharactersBlock). Both branches receive it: the primary
// scenario builds its own roster block from data.getNPCs(), and the legacy path from the
// repository records passed in here. Defaulted to [] so a caller that omits it composes
// exactly the prompt it composed before.
function selectSystemPrompt(scenarioId, sessionId, scenario, locations, characters = []) {
  if (scenarioId === PRIMARY_SCENARIO_ID) {
    return buildSystemPromptFromData(sessionId);
  }
  return buildSystemPromptLegacy(scenario, locations, characters);
}

const _dir = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = join(_dir, '../data/transcripts');
mkdir(TRANSCRIPTS_DIR, { recursive: true }).catch(() => {});

const ANTHROPIC_URL    = 'https://api.anthropic.com/v1/messages';
const MODEL            = 'claude-sonnet-4-6';
const MAX_HISTORY_MSGS = 8;

// When true, only character_fates with verified:true are passed to the epilogue LLM.
// Default OFF — existing fates have not been human-verified yet. Flip on after the review pass.
const STRICT_FATE_VERIFICATION = process.env.STRICT_FATE_VERIFICATION === 'true';

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

async function getScenarioData(repos, scenarioId) {
  const scenario = await repos.scenarios.findById(scenarioId);
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

function buildEpilogueSummary(state, endResult, scenario) {
  return {
    interacted_characters: state?.introducedNpcs     || [],
    completed_beats:       (state?.resolved_threads  || []).map(t => t.thread_id),
    resolved_threads:      (state?.resolved_threads  || []).map(t => ({ thread_id: t.thread_id })),
    outcome:               endResult || 'unknown',
    // closure_state stays exactly what it was: closure_met / reason mean CLOSURE.
    // The defining moment rides ALONGSIDE as its own sub-object — additive only, so a
    // recorded decision is visible in the log without ever standing in for a met
    // closure. Making decision_made drive the close is a separate, deliberate step.
    closure_state:         { ...evaluateClosure(state, scenario), closureFired: state?.closureFired === true,
                             defining_moment_state: evaluateDefiningMoment(state, scenario) },
  };
}

// Matches "turn 29", "Turn 3", "turn N" etc — must not appear in record-voice prose.
const TURN_META_RE = /\bturn\s+\d+\b/gi;
function scrubTurnMeta(text) {
  if (typeof text !== 'string') return text;
  return text.replace(TURN_META_RE, '').replace(/  +/g, ' ').trim();
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

// Strip {text,source} objects back to plain strings before sending to the prose-generation LLM.
// key_facts and historical_frame may be stored as objects after the schema change; the
// epilogue-text model only needs the text, not the source attribution.
function normalizeEpilogueForLLM(epilogueData) {
  if (!epilogueData) return epilogueData;
  const toText = arr => (arr || []).map(f => (typeof f === 'string' ? f : (f.text || '')));
  return {
    ...epilogueData,
    immediate_outcome: epilogueData.immediate_outcome ? {
      ...epilogueData.immediate_outcome,
      key_facts: toText(epilogueData.immediate_outcome.key_facts),
    } : epilogueData.immediate_outcome,
    historical_frame: toText(epilogueData.historical_frame),
  };
}

function getCompositeDisclosure(epilogueData, summary) {
  const interacted = new Set(summary.interacted_characters || []);
  return (epilogueData?.character_fates || [])
    .filter(f => interacted.has(f.character_id) && f.classification === 'composite')
    .map(f => ({ character_id: f.character_id, name: f.name }));
}

// proximitySession — the role carried NO defining-moment block at all, so there was never
// a fork to answer: a witness/proximity role (the Chronicler). Classified at the CALL SITE,
// where the role and the session state are both in scope, and defaulted false here so that
// every existing caller and every session that is not a proximity session compiles exactly
// the prompt it compiled before.
async function generateEpilogueText(epilogueData, sessionSummary, closingProse, anthropicApiKey, playerHistoricalNote, sessionNpcList = [], proximitySession = false, playedRole = null) {
  // Apply strict verification filter: when on, fates not yet human-verified are withheld from the LLM.
  const fatesForLLM = STRICT_FATE_VERIFICATION
    ? (epilogueData?.character_fates || []).filter(f => f.verified === true)
    : (epilogueData?.character_fates || []);
  const filteredEpilogueData = epilogueData ? { ...epilogueData, character_fates: fatesForLLM } : epilogueData;

  const interactedSet  = new Set(sessionSummary.interacted_characters || []);
  const compositeNames = (epilogueData?.character_fates || [])
    .filter(f => interactedSet.has(f.character_id) && f.classification === 'composite')
    .map(f => f.name);
  const compositeRule = compositeNames.length > 0
    ? `COMPOSITE CHARACTER CONSTRAINT: The following characters are fictional composites — invented figures placed within a documented historical context. They have no individual historical record: ${compositeNames.join(', ')}. Do NOT assign, imply, or speculate about their individual outcomes or fates. Do NOT write phrases such as "their fate is unknown" or "what became of them is unrecorded" — these still imply a real person. If you must reference them, note only the documented role they represented (e.g. a soldier present on Dog Green Sector on June 6, 1944) without any claim about what happened to that individual.`
    : '';

  // ── Call 1: session block ────────────────────────────────────────────────────
  // Inputs: sessionSummary + closingProse ONLY.
  // Must NOT receive epilogueData, playerHistoricalNote, or compositeRule.
  // Decision-aware framing. THE GATE: a defining decision was actually recorded this
  // session. When it was not — every role and scenario carrying no defining moment,
  // every session where the flag is off, and every session where the fork was put but
  // never answered — decisionMade is false and the array below is element-for-element
  // what it was before this change, so the prompt string is byte-identical and those
  // epilogues cannot move. The branch is taken HERE, in the engine, rather than written
  // into the prompt as "when X is true…", precisely so that identity is a property of
  // the code and not something the model has to honour.
  const definingState = sessionSummary?.closure_state?.defining_moment_state || null;
  const decisionMade  = definingState?.met === true;

  // THREE arms, not two. The middle case is the one worth stating explicitly: a role that
  // HAS a fork but never answered it — a crucible that ran out of time before its choice —
  // keeps the honest-timeout framing below. It is NOT presence: a session that was building
  // toward a decision and did not arrive at one was not witnessing, and telling that player
  // they were "present at history" would flatter a session that genuinely fell short.
  // Presence is reserved for a role that never had a fork to answer.
  const proximity = !decisionMade && proximitySession === true;

  const sessionSystemPrompt = [
    'You are writing the "Your Session" block for a completed Living History game session. Return ONLY plain prose — no JSON, no markdown fences, no preamble.',
    '',
    decisionMade
      ? 'Convey who this person was in the room — the human experience of this session, pivoting on the defining decision they made. Name who was there with them, and let the choice carry who they became under pressure.'
      : proximity
      ? 'Convey who this person was in proximity to the event — the quality of their presence: what they attended to, how they bore it, and what being there asked of them. Name who was there with them.'
      : 'Describe what this player did in this session: which characters they encountered, key decisions made, how the session ended for them.',
    '',
    'Length: 60–100 words.',
    'Voice: reported past tense or second person. Not documentary. Not historian\'s record.',
    '',
    'Rules:',
    '- Draw ONLY from the SESSION SUMMARY provided. No other knowledge, no external sources.',
    '- Name characters ONLY from the CHARACTERS PRESENT THIS SESSION list. Never invent a name or substitute a name not on that list.',
    ...(decisionMade ? [
      '- THE DECISION IS THE RESOLUTION. A defining decision was recorded this session (closure_state.defining_moment_state). The choice in decision_text is how this session resolved — it is the crystallizing moment, not a step toward one. Write who this person was in it and what it asked of them. Never say the session ended without resolution.',
      '- THE DECISION OUTRANKS closure_state. Disregard closure_state.reason, closure_state.location, and closure_state.required_locations entirely. Never frame the session as unresolved, incomplete, cut short, or as a shortfall for not reaching somewhere. Reaching a location was never the objective; the human experience was.',
      '- CLOSE CONCRETE, NOT ABSTRACT. End on a definite particular from this session — a thing held, a sound, a gesture, what someone did with their hands — at the same grain as the CLOSING PROSE. The last image must be something that definitely happened. Never close on unknowability: not "nobody could have said", not "what only you knew", not "the night absorbed it", not "no one was left to record it". That the aftermath is undocumented may be true, but it is not the ending. Never close on "the session ended before…" or "they never reached…".',
      '- GROUND IT IN THE TEXTURE OF THIS SESSION. The CLOSING PROSE carries the physical particulars — a thing in the hands, what the light was doing, the sound of the room, the weight of what was carried. Use those particulars. Do not write a close that could belong to any session.',
      '- Ground the choice in its authored language: decision_text is what they chose. Paraphrase it, never quote it verbatim. The options they did not take appear only as internal ids in available_options — never name, translate, or paraphrase those.',
    ] : proximity ? [
      '- PRESENCE IS THE RESOLUTION. This role had no defining decision to make; being there was the whole of it. Write who they were while it happened — what they attended to, how they bore it, and what being present cost them. Never frame the session as unresolved, incomplete, cut short, or as a failure to finish or reach anything. Being present at history is not a task to complete.',
      '- PRESENCE OUTRANKS closure_state. Disregard closure_state.reason, closure_state.location, and closure_state.required_locations entirely. Reaching a location was never the objective, and an outcome of "unknown" is not a shortfall here — there was no task to complete. Never write that time ran out, that they did not finish, or that they failed to reach anywhere.',
      '- WHERE THEY HAD SMALL AGENCY, HONOUR IT. A hand kept steady, a thing recorded, a person steadied, something they did not look away from — the small conduct of someone with no authority over the event is the character of this session. Take it only from the SESSION SUMMARY and the CLOSING PROSE; never invent an intervention they did not make.',
      '- GROUND IT IN THE TEXTURE OF THIS SESSION. The CLOSING PROSE carries the physical particulars — an instrument in the hands, a line held open, the sound of a crowd through concrete, what the light was doing. Use those particulars. Do not write a generic account of witnessing that could belong to any session.',
      '- IF THE EVENT WAS REACHED, HONOUR IT. If the session ended at the threshold with the event not yet arrived, close on the witnessing itself — what it was to be there as it came up to the edge. Never close on "the session ended before…", "they never reached…", or on time running out.',
      '- CLOSE CONCRETE, NOT ABSTRACT. End on a definite particular from this session — a thing held, a sound, a gesture — at the same grain as the CLOSING PROSE. The last image must be something that definitely happened. Never close on unknowability: not "nobody could have said", not "what only you knew", not "the night absorbed it", not "no one was left to record it". That what followed is undocumented may be true, but it is not the ending.',
    ] : [
      '- If outcome is "unknown", state plainly that the session ended without resolution — do not imply, infer, or invent a conclusion.',
    ]),
    '- Never state an outcome the player did not reach. Never import the documented historical ending of the real event, even when the player portrayed a real historical figure.',
    '- Do not write in historian\'s record voice.',
    '- Do not attribute the player\'s choices or actions to real historical people as documented fact.',
    '- Do not reference turn numbers, session identifiers, or game-internal metadata.',
  ].join('\n');

  const npcListSection = sessionNpcList.length > 0
    ? 'CHARACTERS PRESENT THIS SESSION (name characters only from this list — never invent a name):\n' +
      sessionNpcList.map(c => `- ${c.name}${c.role ? ` (${c.role})` : ''}`).join('\n')
    : 'CHARACTERS PRESENT THIS SESSION: none recorded.';

  const sessionUserContent = [
    'SESSION SUMMARY:',
    JSON.stringify(sessionSummary, null, 2),
    '',
    npcListSection,
    '',
    'CLOSING PROSE (draw physical particulars from this — do not copy its phrasing or continue its scene):',
    closingProse,
  ].join('\n');

  const sessionSignal = AbortSignal.timeout(30000);
  const sessionResp = await fetch(ANTHROPIC_URL, {
    method: 'POST', signal: sessionSignal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 200, temperature: 0.5,
      system: sessionSystemPrompt,
      messages: [{ role: 'user', content: sessionUserContent }],
    }),
  });
  if (!sessionResp.ok) throw new Error(`Anthropic API error (session block): ${sessionResp.status}`);
  const sessionData = await sessionResp.json();
  const session_block = (sessionData.content?.[0]?.text?.trim()) || '';
  if (!session_block) throw new Error('No session block text returned');

  // ── Call 2: record block ─────────────────────────────────────────────────────
  // Inputs: epilogueData + playerHistoricalNote + compositeRule +
  //         sessionSummary scoping arrays (interacted_characters, resolved_threads,
  //         completed_beats) for fate/thread/echo filtering only.
  // Must NOT receive closingProse or any player narrative.
  // Layer 0 exists whenever we know WHICH role was played — independent of whether that role
  // carries a historical_record_note. Previously this layer was gated on the note alone, so a
  // role without one (the common case) produced a prompt with no indication of who was played,
  // and the record led with whichever figure the model found most salient. Precedence is now
  // stated explicitly: the played figure comes first, in every case.
  const playedLayer = playedRole
    ? [
        `  Layer 0 — THE PLAYED CHARACTER: the player portrayed ${playedRole.name}. Their record comes FIRST, before any other figure, and gets the most space. Never open on a secondary character.`,
        playedRole.character_type === 'real'
          ? `    ${playedRole.name} is a real documented figure — open with their own documented outcome from character_fates.`
          : playedRole.character_type === 'composite' || playedRole.character_type === 'fictional'
          ? `    ${playedRole.name} is ${playedRole.character_type}${playedRole.represents ? ` (represents: ${playedRole.represents})` : ''}. Say so plainly, then give the documented contextual record for the role they represent. Never invent or imply an individual fate for them.`
          : `    Open with what character_fates documents for them. If character_fates carries no entry for them, say plainly that no individual record exists — never invent one.`,
        playerHistoricalNote
          ? '    The PLAYER CHARACTER NOTE is verified historical fact about them; include it in this layer.'
          : '',
      ].filter(Boolean).join('\n')
    : playerHistoricalNote
    ? '  Layer 0 — Player character: the PLAYER CHARACTER NOTE is verified historical fact about the person the player portrayed. Their record comes FIRST, before any other figure. Never open on a secondary character.'
    : '';

  const recordSystemPrompt = [
    'You are writing the "Historical Record" block for a completed Living History game session. Return ONLY plain prose — no JSON, no markdown fences, no preamble.',
    '',
    'Voice: historian\'s record — precise, unsentimental, no literary reach, no interiority.',
    'Content — follow this concentric circle order:',
    playedLayer,
    '  Layer 1 — Other characters: the documented fate (from character_fates) of every OTHER character whose character_id appears in interacted_characters — that is, every one except the played character already covered in Layer 0. Cover every one. Do not omit any.',
    '  Layer 2 — Outcome: the verified result from immediate_outcome.',
    '  Layer 3 — Frame: up to two facts from historical_frame relevant to what happened in this session.',
    'Length: 100–150 words.',
    'Rules:',
    '- Draw ONLY from the EPILOGUE DATA BLOCK. Do not narrate what this player did, chose, or experienced in the session. This bars recounting the session — it does NOT bar naming the historical figure they portrayed: Layer 0 is required and takes precedence.',
    '- Include open_threads entries only when the matching thread_id appears in SESSION SCOPING resolved_threads.',
    '- Include choice_echoes entries only when the matching beat_id appears in SESSION SCOPING completed_beats.',
    '- Do not invent, extrapolate, or editorialize. Every fact from epilogue data only.',
    '- Do not reference turn numbers, session identifiers, or game-internal metadata.',
    '- Last sentence: a verified historical fact. Not a meaning-statement.',
    compositeRule,
  ].filter(Boolean).join('\n');

  const recordScopingData = {
    interacted_characters: sessionSummary.interacted_characters || [],
    resolved_threads:      sessionSummary.resolved_threads      || [],
    completed_beats:       sessionSummary.completed_beats       || [],
  };

  const recordUserParts = [];
  if (playerHistoricalNote) {
    recordUserParts.push(`PLAYER CHARACTER NOTE:\n${playerHistoricalNote}`, '');
  }
  recordUserParts.push(
    'SESSION SCOPING (use to filter character fates, open_threads, and choice_echoes — do not narrate these values):',
    JSON.stringify(recordScopingData, null, 2),
    '',
    'EPILOGUE DATA BLOCK:',
    JSON.stringify(normalizeEpilogueForLLM(filteredEpilogueData), null, 2),
  );
  const recordUserContent = recordUserParts.join('\n');

  const recordSignal = AbortSignal.timeout(30000);
  const recordResp = await fetch(ANTHROPIC_URL, {
    method: 'POST', signal: recordSignal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 400, temperature: 0.5,
      system: recordSystemPrompt,
      messages: [{ role: 'user', content: recordUserContent }],
    }),
  });
  if (!recordResp.ok) throw new Error(`Anthropic API error (record block): ${recordResp.status}`);
  const recordData = await recordResp.json();
  let record_block = (recordData.content?.[0]?.text?.trim()) || '';
  if (!record_block) throw new Error('No record block text returned');

  // Post-generation guard: strip any surviving turn-number patterns from the record block.
  if (TURN_META_RE.test(record_block)) {
    console.warn('[EPILOGUE] turn-meta pattern detected in record_block — stripping');
    record_block = record_block.replace(TURN_META_RE, '').replace(/  +/g, ' ').trim();
  }

  const interacted = new Set(sessionSummary.interacted_characters || []);
  const sources    = [...new Set(
    (epilogueData.character_fates || [])
      .filter(f => interacted.has(f.character_id) && f.primary_source)
      .map(f => f.primary_source)
  )];

  return { session_block, record_block, label: 'Historical Record', sources, style_hint: 'historian' };
}

// ── Router export ──────────────────────────────────────────────────────────────

export function createGameRouter(repos, config = {}) {
  const { anthropicApiKey, elevenLabsApiKey, elevenLabsVoiceId } = config;
  const r = Router();

  // ── Public scenario listing ────────────────────────────────────────────────
  r.get('/scenarios', async (_, res) => {
    const all = (await repos.scenarios.findAll())
      .filter(s => s.status === 'published')
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
  r.get('/bootstrap', async (req, res) => {
    const scenarioId = req.query.scenarioId;
    if (!scenarioId) return res.status(400).json({ error: 'scenarioId is required.' });
    try {
      const { scenario, playerRoles, characters, locations, clues } = await getScenarioData(repos, scenarioId);
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

      const gameData = await getScenarioData(repos, scenarioId);
      const { scenario, playerRoles, characters, locations, clues } = gameData;

      const role = playerRoles.find(r => r.id === roleId);
      if (!role) return res.status(404).json({ error: `Role "${roleId}" not found.` });

      // Block start if any player alias collides with an NPC in this scenario
      const identityIssues = (await new SchemaValidator(repos).validateIdentityIntegrity())
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

      // Pass approved glossary terms to the client
      initialState.glossary = (scenario.glossary || []).filter(g =>
        g.term?.trim() && g.definition?.trim()
      );
      console.log(`[GLOSSARY] scenario=${scenarioId} total=${(scenario.glossary || []).length} passed=${initialState.glossary.length} terms=[${initialState.glossary.map(g => g.term).join(', ')}]`);

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

      const systemPrompt         = selectSystemPrompt(scenarioId, sessionId, scenario, locations, characters);
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
          model: MODEL, max_tokens: 1600, temperature: 0.8, stream: true,
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

      const nextState = mergeState(seededInitial, output, scenario, clues, '', locations);
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

      const gameData = await getScenarioData(repos, state.scenarioId);
      const { scenario, characters, locations, clues } = gameData;

      // -- Defining moment ----------------------------------------------------
      // (a) An answer to a fork put to the player on an EARLIER turn is recorded before
      //     the prompt is composed, so this turn already sees the decision made and
      //     definingMomentDue goes false - the same fork can never be asked twice.
      const recordedDecision = recordDefiningDecision(state, scenario, {
        definingChoiceId: req.body.definingChoiceId,
        playerInput,
      });
      if (recordedDecision) console.log("[DEFINING] decision recorded: " + recordedDecision);

      // (b) Whether THIS turn presents the fork. Read from the same state the prompt is
      //     composed from, so the injected instruction and the options handed to the
      //     client can never disagree about whether the moment is happening.
      const forkDue       = definingMomentDue(state, scenario);
      const definingBlock = forkDue ? resolveDefiningMomentBlock(state, scenario) : null;
      if (forkDue) console.log("[DEFINING] fork due - moment=" + definingBlock?.principal_transition?.moment + " elapsed=" + state.elapsedMinutes);

      // Save current state so promptBuilder can read session context
      if (sessionId) appData.saveSession(sessionId, state);

      const systemPrompt = selectSystemPrompt(state.scenarioId, sessionId, scenario, locations, characters);
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

      const isEndingTurn  = state.remainingMinutes <= 0;
      const endingSignals = checkEndingReadiness(state, scenario);
      const mightEnd      = endingSignals.readyForClimax;
      const isLateGame    = (state.remainingMinutes <= 7 && state.remainingMinutes > 0) || state.elapsedMinutes >= (scenario.sessionTargetMinutes * 0.75);
      const maxToks       = isEndingTurn ? 2000 : mightEnd ? 1800 : isLateGame ? 1400 : 1600;

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
        // At the time boundary the model naturally writes closing prose rather than
        // structured JSON.  Coerce it into a minimal ending payload so the client
        // receives a `done` event and transitions to /closing-prose normally.
        if (!output && state.remainingMinutes <= 0 && stopReason === 'end_turn') {
          traceTags.push('closing-coerce');
          console.log(`[CLOSING COERCE] time boundary — coercing end_turn prose to ending payload`);
          output = {
            narrative:    text,
            choices:      [],
            npcMoments:   [],
            stateChanges: {},
            location:     state.location,
            endState: {
              isEnding: true,
              outcome:  'session_complete',
              scene:    text,
            },
          };
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

      // The fork turn is authored to cost no clock (defining_moment.time_advance).
      // Engine-owned: it overrides whatever the model emitted, and it must be set before
      // mergeState, which is what reads modelOutput.timeAdvance.
      if (forkDue && typeof definingBlock?.time_advance === 'number') {
        output.timeAdvance = definingBlock.time_advance;
      }

      const prevAct = state.act || 1;
      let nextState = mergeState(state, output, scenario, clues, playerInput, locations);

      if (nextState.act > prevAct) {
        output.actTransition = { from: prevAct, to: nextState.act };
        const existing = anchorViolationNotes.get(sessionId) || '';
        const actNote  = `ACT BOUNDARY: The story has just entered Act ${nextState.act}. Raise the stakes — introduce new pressure, a revelation, or a forced choice. Do not repeat information or beats already covered in Act ${prevAct}.`;
        anchorViolationNotes.set(sessionId, existing ? `${existing}\n\n${actNote}` : actNote);
      }

      // Prevent LLM-generated endings before the FINAL arc threshold (80% elapsed)
      if (arcPosition !== 'final' && nextState.remainingMinutes > 0) {
        // Closure exception — a met arc-resolving transition (or an already-latched
        // close from an earlier turn) permits the ending to stand before 'final'.
        // The latch (closureFired) survives a late model-driven location change that
        // would flip the live check false.
        const closureClosing = nextState.closureFired || closureShouldClose(nextState, scenario);
        if (output.endState?.isEnding && !closureClosing) {
          console.log(`[ARC GUARD] arcPosition=${arcPosition} — suppressed premature isEnding`);
          output.endState.isEnding = false;
        }
      }

      // Hard enforcement: if time has been at zero for 3+ turns and the model hasn't
      // closed, force it — this should not normally fire
      if (nextState.turnsAtZero >= 3 && !output.endState?.isEnding) {
        console.log(`[CLOSING ENFORCE] turnsAtZero=${nextState.turnsAtZero} — forcing session close`);
        output.endState = { isEnding: true, outcome: 'session_complete' };
      }

      if (output.endState?.isEnding) {
        output.endState.performance = {
          timeRemaining: nextState.remainingMinutes,
          turnsPlayed:   nextState.turnCount || 0,
        };
      }

      // Present the fork. The options are ENGINE-owned - ids and text come from the block,
      // never from the model - and they REPLACE whatever choices the model emitted, so the
      // player answers the authored question and nothing else. definingMoment carries the
      // ids alongside so a selection can be mapped back to one.
      if (forkDue) {
        const options = (definingBlock.options || [])
          .filter(o => o?.id && typeof o.text === 'string')
          .map(o => ({ id: o.id, text: o.text }));
        output.choices        = options.map(o => o.text);
        output.definingMoment = {
          momentId: definingBlock.principal_transition?.moment ?? null,
          options,
        };
        // Latch it: the fork has now been asked, and must not be asked again even if the
        // player answers with something that records no decision.
        nextState.definingMomentPresented = true;
        console.log("[DEFINING] fork presented - " + options.length + " options, timeAdvance=" + output.timeAdvance);
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
          chunk.push(`## Session Close`);
          chunk.push(``);
          chunk.push(`**Time remaining:** ${p.timeRemaining ?? '?'} min`);
          chunk.push(`**Turns played:** ${p.turnsPlayed ?? '?'}`);
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
      // loc_out reports the location COMMITTED to state, not the model's raw emit. The two
      // diverge exactly when the reconciliation guard rejects an invented id or a display
      // name — the case this line exists to make visible — and logging the emit made a
      // rejected move read as a successful one. Surface the rejected emit alongside.
      const locEmit  = output.location || "";
      const locHeld  = locEmit && locEmit !== nextState.location ? ` (emit="${locEmit}" rejected, held)` : "";
      console.log(`[TURN] loc_out=${nextState.location}${locHeld} npcs=${JSON.stringify(npcNames)} isEnding=${output.endState?.isEnding ?? false}`);
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
  r.post('/notes', async (req, res) => {
    try {
      const { state } = req.body;
      if (!state?.scenarioId) return res.status(400).json({ error: 'Missing state.scenarioId.' });
      const { characters, locations, clues } = await getScenarioData(repos, state.scenarioId);

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
        'Key questions remained unanswered when time expired.',
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
    const scenarioData  = scenarioId ? await repos.scenarios.findById(scenarioId) : null;
    const role          = roleId ? repos.scenarios.findPlayerRole(roleId) : null;
    const characters    = scenarioId ? repos.characters.findAll().filter(c => (c.scenarioIds || []).includes(scenarioId)) : [];

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
        `Character (the "you" of this prose): ${role.name || roleId}`,
        `Ending type: session close`,
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
        'POINT OF VIEW: Write in SECOND PERSON — "you", "your". The player character is addressed as "you" and is never named and never "he", "she", or "they". Other characters are named and take third person normally. This is fixed: write second person even if the transcript reads otherwise.',
        'Do not mention success or failure explicitly. Do not reference game mechanics.',
        'Write as if this is the last paragraph of a novel.',
        'Write only the prose — no title, no attribution.',
        '',
        'CLOSING PROSE CONSTRAINT: Closing prose may move inward but it may not step back. A physically grounded interior observation is permitted — render what the player character feels in their hands, their boots, their chest. What is prohibited is the sentence that names what the experience meant, what the player character learned, or what the session signified. The physical image is the meaning. Do not label it.',
        'This constraint applies to all narration in the closing prose. If named characters appear in the closing prose, their actions may be described physically but their significance may not be explained. The closing prose ends on a physical image. It does not end on a meaning-statement, a lesson, or a declaration addressed to the player.',
        'PLAYER AGENCY CONSTRAINT: Closing prose may narrate involuntary, momentary physical reactions — a pause, a caught breath, a hand that steadies. It must not narrate the player taking a committed voluntary action they did not choose: moving to a location, speaking a decision, or engaging a character in a way that alters what actually happened in the session. Describe the physical residue of what occurred. Do not invent new decisions.',
      ].join('\n');
    } else {
      closingPrompt = [
        'Based on the session transcript below, write 2-3 sentences of closing interior prose for this character.',
        'This is not a summary of events.',
        'Write in the same voice and tense as the session.',
        'POINT OF VIEW: Write in SECOND PERSON — "you", "your". The player character is addressed as "you" and is never named and never "he", "she", or "they". Other characters are named and take third person normally. This is fixed: write second person even if the transcript reads otherwise.',
        'Do not mention success or failure. Do not reference game mechanics.',
        'Write as if this is the last paragraph of a novel.',
        '',
        'CLOSING PROSE CONSTRAINT: Closing prose may move inward but it may not step back. A physically grounded interior observation is permitted — render what the player character feels in their hands, their boots, their chest. What is prohibited is the sentence that names what the experience meant, what the player character learned, or what the session signified. The physical image is the meaning. Do not label it.',
        'This constraint applies to all narration in the closing prose. If named characters appear in the closing prose, their actions may be described physically but their significance may not be explained. The closing prose ends on a physical image. It does not end on a meaning-statement, a lesson, or a declaration addressed to the player.',
        'PLAYER AGENCY CONSTRAINT: Closing prose may narrate involuntary, momentary physical reactions — a pause, a caught breath, a hand that steadies. It must not narrate the player taking a committed voluntary action they did not choose: moving to a location, speaking a decision, or engaging a character in a way that alters what actually happened in the session. Describe the physical residue of what occurred. Do not invent new decisions.',
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
      let prose = await streamRawText(resp, chunk => sendSse(res, { type: 'chunk', text: chunk }));
      if (characters.length) prose = fixCharacterIdLeaks(prose, characters);

      // Generate historical epilogue and bibliography
      console.log('[EPILOGUE-CLOSE] reached closing-prose route — sessionId:', sessionId);
      let epilogueResult = null;
      let bibliography   = [];
      const sessionState = sessionId ? appData.getSession(sessionId) : null;
      console.log('[EPILOGUE-CLOSE] interacted_characters:', (sessionState?.introducedNpcs || []).length, 'completed_beats:', (sessionState?.resolved_threads || []).length);
      console.log('[EPILOGUE-CLOSE] conditions — generated:', scenarioData?.epilogue?.generated, 'reviewed:', scenarioData?.epilogue?.reviewed);
      if (scenarioData?.epilogue?.generated && scenarioData?.epilogue?.reviewed) {
        const summary = buildEpilogueSummary(sessionState, endResult, scenarioData);
        console.log('[EPILOGUE-CLOSE] session summary — interacted_characters:', summary.interacted_characters?.length, 'completed_beats:', summary.completed_beats?.length, 'outcome:', summary.outcome,
          'closure_met:', summary.closure_state?.met, 'closureFired:', summary.closure_state?.closureFired, 'reason:', summary.closure_state?.reason, 'closure_source:', summary.closure_state?.closure_source,
          'defining_met:', summary.closure_state?.defining_moment_state?.met, 'defining_reason:', summary.closure_state?.defining_moment_state?.reason, 'decision:', summary.closure_state?.defining_moment_state?.decision);

        sendSse(res, { type: 'epilogue_pending' });

        try {
          console.log('[EPILOGUE-CLOSE] calling epilogue API');
          // Resolve interacted_characters to display names, excluding the player's own character.
          // Keyed off state.playerCharacterId (set from role.character_id).
          // No-op when playerCharacterId is null (fictional/composite-player roles).
          const playerCharacterId = sessionState?.playerCharacterId || null;
          const sessionNpcList = (summary.interacted_characters || [])
            .filter(id => !playerCharacterId || id !== playerCharacterId)
            .map(id => {
              const char = characters.find(c => c.id === id);
              return char ? { name: char.name, role: char.role || '' } : null;
            })
            .filter(Boolean);
          console.log('[EPILOGUE-CLOSE] sessionNpcList — count:', sessionNpcList.length, 'playerExcluded:', !!playerCharacterId);

          // PROXIMITY CLASSIFICATION. A role with no defining-moment block in force never
          // had a fork to answer — a witness/proximity session, which gets the presence
          // arm instead of the "ended without resolution" framing. Resolved the same way
          // the engine resolves it during play (resolveDefiningMomentBlock reads
          // state.effectiveDefiningMoment, captured at session start, then falls back to
          // the scenario), with role.defining_moment as a further fallback for a session
          // created before that field existed. Deliberately NOT gated on
          // DEFINING_MOMENT_ENABLED: whether a fork EXISTS for this role is a fact about
          // the role, not about whether the engine is currently allowed to present it.
          const forkBlock = resolveDefiningMomentBlock(sessionState, scenarioData) || role?.defining_moment || null;
          const proximitySession = !forkBlock;
          console.log('[EPILOGUE-CLOSE] epilogue arm —',
            summary.closure_state?.defining_moment_state?.met === true ? 'decision-aware'
              : proximitySession ? 'proximity/presence'
              : 'fork-present-not-fired (unchanged)');

          epilogueResult = await generateEpilogueText(scenarioData.epilogue, summary, scrubTurnMeta(prose), anthropicApiKey, role?.historical_record_note || null, sessionNpcList, proximitySession,
            role ? { id: role.id, name: role.name, character_type: role.character_type || null, represents: role.represents || null } : null);
          if ((epilogueResult?.session_block || epilogueResult?.record_block) && characters.length) {
            epilogueResult = {
              ...epilogueResult,
              session_block: fixCharacterIdLeaks(epilogueResult.session_block || '', characters),
              record_block:  fixCharacterIdLeaks(epilogueResult.record_block  || '', characters),
            };
          }
        } catch (e) {
          console.error('[EPILOGUE]', e.message);
        }
        console.log('[EPILOGUE-CLOSE] epilogue API result — success:', !!epilogueResult, 'session_block:', epilogueResult?.session_block?.length, 'record_block:', epilogueResult?.record_block?.length);

        try {
          bibliography = assembleBibliography(scenarioData, summary, sessionState);
        } catch (e) {
          console.error('[BIBLIOGRAPHY]', e.message);
        }
        console.log('[EPILOGUE-CLOSE] bibliography assembled — entries:', bibliography?.length);

      } else if (scenarioData?.epilogue?.generated && !scenarioData?.epilogue?.reviewed) {
        console.warn(`[EPILOGUE] Skipped for session ${sessionId} — epilogue data not reviewed on scenario "${scenarioId}"`);
      }

      // Epilogue-derived composites (requires a reviewed epilogue block)
      const epilogueComposites = (scenarioData?.epilogue?.generated && scenarioData?.epilogue?.reviewed)
        ? getCompositeDisclosure(scenarioData.epilogue, buildEpilogueSummary(sessionState, endResult, scenarioData))
        : [];

      // Scenario-level fallback: top-level composite_disclosure array produced by the generator.
      // Filter to characters the player interacted with; if session data is missing send the full list.
      // Deduplicate against any epilogue-derived entries by name.
      const interactedNames = new Set(
        (sessionState?.introducedNpcs || [])
          .map(id => { const c = characters.find(ch => ch.id === id); return c?.name || null; })
          .filter(Boolean)
      );
      const epilogueNames = new Set(epilogueComposites.map(c => c.name));
      const scenarioComposites = (scenarioData?.composite_disclosure || [])
        .filter(name => interactedNames.size === 0 || interactedNames.has(name))
        .filter(name => !epilogueNames.has(name))
        .map(name => ({ name }));

      const compositeDisclosure = [...epilogueComposites, ...scenarioComposites];
      console.log('[EPILOGUE-CLOSE] composite_disclosure — count:', compositeDisclosure.length, '(epilogue:', epilogueComposites.length, ', scenario:', scenarioComposites.length, ')');

      sendSse(res, { type: 'done', closing_prose: prose, epilogue: epilogueResult, bibliography, composite_disclosure: compositeDisclosure });
      res.end();

      // Write closing sections to the session transcript
      if (prose) {
        try {
          const withResult = transcript.replace(/^## Result: .+$/m, `## Result: ${endResult || 'unknown'}`);
          await writeFile(transcriptPath, withResult, 'utf8');

          const aftermath = scenarioData?.historical_aftermath || '';
          const lines = ['', '## Closing Prose', '', prose];
          if (aftermath) lines.push('', '## Historical Aftermath', '', aftermath);
          if (epilogueResult?.session_block) {
            lines.push('', '---', '', '## Your Session', '', epilogueResult.session_block);
          }
          if (epilogueResult?.record_block) {
            lines.push('', '---', '', '## Historical Record', '', epilogueResult.record_block);
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
          if (compositeDisclosure.length) {
            const names = compositeDisclosure.map(c => c.name).join(', ');
            lines.push('', '---', '', '## A Note on the Characters', '', `${names} ${compositeDisclosure.length === 1 ? 'is a fictional composite' : 'are fictional composites'} placed within a documented historical context. ${compositeDisclosure.length === 1 ? 'This character is' : 'These characters are'} not based on identified historical individuals.`);
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
