const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1/messages';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
// Opus 4.7/4.8 and Fable reject temperature/top_p/top_k (400). Omit sampling params for these.
const NO_SAMPLING_RE = /^claude-(opus-4-(7|8)|fable)/;

async function callClaude(systemPrompt, userPrompt, options = {}) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const model = options.model || DEFAULT_MODEL;
  const body = {
    model,
    max_tokens: options.maxTokens || 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  };
  // Sampling params are unsupported on Opus 4.7/4.8 — sending them is a 400.
  if (!NO_SAMPLING_RE.test(model)) {
    body.temperature = options.temperature ?? 0.3;
  }
  // Effort (GA, no beta header) tunes depth on models that support output_config.
  if (options.effort) {
    body.output_config = { effort: options.effort };
  }

  const response = await fetch(ANTHROPIC_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Claude API error: ' + response.status + ' ' + err);
  }

  const data = await response.json();
  // Pick the text block (thinking-off keeps content[0] as text, but scan to be safe).
  const text = (data.content || []).find(b => b.type === 'text')?.text || data.content?.[0]?.text;
  if (!text) throw new Error('Claude returned empty response');
  return text;
}

export async function fillMissingFields(scenario) {
  const systemPrompt = `You are a schema completion assistant for an interactive historical fiction engine.
You receive a partially complete scenario JSON and fill in missing fields based on the existing content.
You always respond with valid JSON only — no prose, no markdown, no backticks before or after.
You preserve all existing field values exactly — you only add missing fields, never modify existing ones.`;

  const userPrompt = `The following scenario is missing several required fields. Fill them in based on the existing content.

REQUIRED FIELDS TO ADD IF MISSING:

1. Top-level scenario fields:
   - player_goal: string — one sentence describing what players are trying to achieve
   - opening_situation: string — the immediate situation at game start, 2-3 sentences
   - skippable: boolean — true
   - enable_structured_endings: boolean — true

2. For each character in the characters array, add if missing:
   - aggression_profile: object with these exact keys:
     {
       mildPressure: string — how character responds to gentle pressure,
       heavyPressure: string — how character responds to confrontation,
       breakingPoint: string — what they will never admit or do,
       fleeCondition: string — what makes them leave or shut down,
       fleeStyle: string — how they disengage,
       chaseStyle: string — how they pursue goals,
       capturedBehavior: string — how they behave if cornered,
       strikeFirst: boolean — whether they initiate conflict
     }

3. For each player_role in the player_roles array, add if missing:
   - access_level: string — one of: staff, investigator, admin (choose based on role)
   - ending_partial: object with keys: what_happened, who_present, emotional_weight, closing_line
   - ending_failure: object with keys: what_happened, who_present, emotional_weight, closing_line
   Note: if partial and failure exist but use tone instead of emotional_weight, rename tone to emotional_weight

4. For the story_arc, add if missing:
   - arc_name: string — a short evocative title for the arc
   Each beat object should have: id (snake_case), description (string)

5. Add top-level bibliography array if missing:
   - Collect all source citations from character_fates, key_facts, technical_facts throughout the scenario
   - Deduplicate and format as: [{ index: 1, citation: string }]

Return the COMPLETE scenario JSON with all fields filled in. Do not truncate. Do not summarize.

SCENARIO TO COMPLETE:
${JSON.stringify(scenario, null, 2)}`;

  const result = await callClaude(systemPrompt, userPrompt, {
    maxTokens: 16000,
    temperature: 0.2
  });

  try {
    const clean = result.replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();
    return JSON.parse(clean);
  } catch (err) {
    throw new Error('Claude schema fill returned invalid JSON: ' + err.message);
  }
}

// ── Fate generator (Opus) ──────────────────────────────────────────────────────
// Authors the three end-state fates (success / partial / failure) per role, with
// a mode-branched instruction on role-level `fate_mode`. One model (Opus), once
// per scenario at authoring time. Emits the exact `ending_notes` fate contract the
// renderer reads (gameRouter.js:1248-1266) plus `closing_line`. Role-identity
// fields are NOT regenerated here — they are preserved by leaving them untouched
// (the injectors' guards skip undefined keys), so a re-run never clobbers authored
// briefings/hooks/secrets on a published scenario.

const FATE_MODEL = 'claude-opus-4-8';

// Resolve what an anchored role binds to: a documented figure's record, or — for a
// welded composite with no character_id — the scenario's fixed macro-outcome.
function resolveAnchorBinding(scenario, role) {
  const fates = scenario?.epilogue?.character_fates || [];
  if (role.character_id) {
    const fate = fates.find(f => f.character_id === role.character_id);
    if (fate) return { kind: 'documented', fate };
    return { kind: 'documented_unlinked', character_id: role.character_id };
  }
  const macro = scenario?.epilogue?.immediate_outcome || null;
  if (macro && (macro.summary || (macro.key_facts && macro.key_facts.length))) {
    return { kind: 'welded', macro };
  }
  return { kind: 'welded_unbound' };
}

// In-event outcomes that are consistent with a documented survivor surviving the event.
const SURVIVOR_SAFE_OUTCOMES = new Set(['survived', 'incapacitated', 'captured']);

// Deterministic survivor-safety guard. Reads the STRUCTURED in_event_outcome on each
// generated branch — never infers from prose — against the role's anchored documented
// outcome. A documented survivor (character_fates outcome === 'survived', resolved via
// resolveAnchorBinding) must not be killed in-event in ANY branch. Returns structured
// lists for the gate: a 'died' branch is a hard block; an 'unresolved' or missing field
// is a soft warning; survived/incapacitated/captured pass. Non-survivors are silent
// (their in-event death is authorially permitted).
function assertSurvivorSafety(scenario, endingNotes) {
  const blocked = [];
  const warnings = [];
  const notes = (endingNotes && endingNotes.ending_notes) || [];
  const roles = scenario?.player_roles || scenario?.playerRoles || [];
  const roleByName = new Map(roles.map(r => [r.name, r]));

  for (const note of notes) {
    const role = roleByName.get(note.role_name);
    if (!role) continue; // fate has no matching role → cannot bind an anchor; stay silent
    const binding = resolveAnchorBinding(scenario, role);
    // Only a documented figure recorded as having survived the event is guarded.
    if (binding.kind !== 'documented' || binding.fate.outcome !== 'survived') continue;

    for (const branch of ['success', 'partial', 'failure']) {
      const b = note[branch];
      if (!b) continue;
      const outcome = b.in_event_outcome || 'unresolved'; // missing field reads as unresolved
      if (outcome === 'died') {
        blocked.push({ role: note.role_name, branch, type: 'survivor_died' });
      } else if (!SURVIVOR_SAFE_OUTCOMES.has(outcome)) {
        // 'unresolved', missing, or any unrecognized value → soft flag, never a hard block
        warnings.push({ role: note.role_name, branch, type: 'survivor_unresolved' });
      }
    }
  }
  // A blocked role is dropped entirely — the block subsumes any warning on it, so
  // exclude blocked roles from warnings to avoid double-listing the same role.
  const blockedRoles = new Set(blocked.map(v => v.role));
  return { blocked, warnings: warnings.filter(w => !blockedRoles.has(w.role)) };
}

const FATE_OUTPUT_SHAPE = `Return valid JSON only — no prose, no markdown, no backticks. Exactly this shape:
{
  "role_name": "<exact role name>",
  "success": { "what_happened": "...", "who_present": "...", "emotional_weight": "...", "closing_line": "...", "in_event_outcome": "survived|died|incapacitated|captured|unresolved" },
  "partial": { "what_happened": "...", "who_present": "...", "emotional_weight": "...", "closing_line": "...", "in_event_outcome": "survived|died|incapacitated|captured|unresolved" },
  "failure": { "what_happened": "...", "who_present": "...", "emotional_weight": "...", "closing_line": "...", "in_event_outcome": "survived|died|incapacitated|captured|unresolved" }
}
Each end-state commits to its outcome: success = the objective achieved cleanly; partial = achieved at a real toll; failure = not achieved. "who_present" is a comma-separated list of co-located player role names at that resolution. "closing_line" is one punchy standalone thematic sentence — not a generic wrap-up. "emotional_weight" is the precise psychological takeaway.
"in_event_outcome" is a STRUCTURED restatement of what "what_happened" depicts for THIS character — not an independent claim. It is one of exactly: "survived" (alive and not seriously incapacitated at the end of the depicted event), "died" (killed DURING the depicted event — in-event, not later in life), "incapacitated" (alive but seriously wounded / out of action by the event's end), "captured" (taken prisoner during the event — alive, in enemy hands), or "unresolved" (the branch does not commit to a definite in-event fate). Reflect the IN-EVENT outcome only, never the character's later-life fate. Set it to match what the prose actually depicts; you MUST use "unresolved" rather than invent a definite fate the prose does not support.`;

function buildFateBranch(scenario, role) {
  const mode = role.fate_mode;
  if (mode === 'committed') {
    return {
      ok: true,
      instruction: `MODE: COMMITTED (composite figure in jeopardy). Invent a plausible, dramatically-earned outcome across the full fate range. The failure branch MAY commit to this character's death if the scene earns it — death is on the table here.`
    };
  }
  if (mode === 'suspended') {
    return {
      ok: true,
      instruction: `MODE: SUSPENDED (openness-preserving). Do NOT commit to a death in any branch. Keep the character's ultimate fate open; failure is a degraded, unresolved cost, never a death-committed ending.`
    };
  }
  if (mode === 'anchored') {
    const binding = resolveAnchorBinding(scenario, role);
    if (binding.kind === 'documented') {
      const f = binding.fate;
      const survived = f.outcome === 'survived';
      const deathRule = survived
        ? `This figure is a DOCUMENTED SURVIVOR of the depicted event (outcome: survived). NO branch — including failure — may kill, disappear, or strand this person to their death. Failure means a degraded outcome or heavy personal cost at which the documented figure still survives.`
        : `This figure's documented in-event outcome is "${f.outcome}". Stay within that record; do not invent specifics beyond it.`;
      return {
        ok: true,
        instruction: `MODE: ANCHORED — DOCUMENTED FIGURE (${f.name}). Stay within the documented record. ${deathRule} Ground facts ONLY in this record; do not assert undocumented specifics as fact.
DOCUMENTED RECORD:\n${f.historical_record || '(no narrative record provided)'}`
      };
    }
    if (binding.kind === 'welded') {
      const m = binding.macro;
      return {
        ok: true,
        instruction: `MODE: ANCHORED — WELDED COMPOSITE (no documented person record). This invented figure is welded to the scenario's FIXED MACRO-OUTCOME, which is immutable and bounds all three branches. If the macro-outcome is one in which the people involved survive (no violence, no deaths), then NO branch — including failure — may kill this role; failure is a degraded personal cost within that fixed surviving reality, never a contradiction of it.
FIXED MACRO-OUTCOME:\n${m.summary || ''}${(m.key_facts && m.key_facts.length) ? '\nKey facts: ' + m.key_facts.map(k => (typeof k === 'string' ? k : k.text)).filter(Boolean).join(' | ') : ''}`
      };
    }
    if (binding.kind === 'documented_unlinked') {
      return { ok: false, reason: `anchored role's character_id "${binding.character_id}" does not resolve to a character_fates entry` };
    }
    return { ok: false, reason: `anchored welded role has no resolvable macro-outcome (epilogue.immediate_outcome missing)` };
  }
  return { ok: false, reason: `unknown or missing fate_mode (${mode ?? 'unset'})` };
}

/**
 * Generate ending_notes fate blocks for the given roles of a scenario.
 * @param {object} scenario  full scenario object (carries epilogue.character_fates + immediate_outcome)
 * @param {Array}  roles     player-role records, each with name, fate_mode, character_id
 * @returns {{ending_notes: Array, skipped: Array}}
 */
export async function generateEndingNotes(scenario, roles) {
  const scenarioTitle = scenario?.title || scenario?.id || 'this scenario';
  const ending_notes = [];
  const skipped = [];

  for (const role of (roles || [])) {
    const branch = buildFateBranch(scenario, role);
    if (!branch.ok) {
      skipped.push({ role_name: role.name, reason: branch.reason });
      continue;
    }

    const systemPrompt = `You are the structured-endings author for an interactive historical simulation. For ONE player role, write three committed end-states — success, partial, failure — each as ground-level narrative consequence, not melodrama. Outcomes are driven by the tactical environment and the character's choices. Write in tight, sensory, professional prose. ${FATE_OUTPUT_SHAPE}`;

    const otherRoles = (roles || []).filter(r => r.name !== role.name).map(r => r.name);
    const userPrompt = `SCENARIO: ${scenarioTitle}
PREMISE: ${scenario?.premise || scenario?.opening_premise || ''}
DOCUMENTED EVENT OUTCOME: ${scenario?.epilogue?.immediate_outcome?.summary || '(see record below)'}

PLAYER ROLE: ${role.name}
ROLE CONTEXT: ${role.description || role.briefing || ''}
OTHER PLAYER ROLES (for "who_present" cross-reference): ${otherRoles.join(', ') || '(none)'}

${branch.instruction}

Write the success/partial/failure fates for ${role.name} now, as JSON only.`;

    const raw = await callClaude(systemPrompt, userPrompt, {
      model: FATE_MODEL,
      effort: 'high',
      maxTokens: 4096
    });
    let parsed;
    try {
      const clean = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
      parsed = JSON.parse(clean);
    } catch (err) {
      throw new Error(`Opus fate generator returned invalid JSON for role "${role.name}": ${err.message}`);
    }
    ending_notes.push({
      role_name: role.name,
      success: parsed.success,
      partial: parsed.partial,
      failure: parsed.failure
    });
  }

  return { ending_notes, skipped };
}

export { assertSurvivorSafety };
export default { fillMissingFields, generateEndingNotes, assertSurvivorSafety };
