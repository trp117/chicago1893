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

// Compact, immutable roster of every real person's documented fate, injected into the
// fate prompt so the generator can honor the universal law across ALL roles — not just
// the target role's own anchor. A role's ending may not kill another documented survivor
// (or resurrect a documented casualty); this block is what makes that enforceable at
// generation. One line per fate: outcome + a short manner clause (the first sentence of
// the record), never the full paragraph.
function buildDocumentedFatesRoster(scenario) {
  const fates = scenario?.epilogue?.character_fates || [];
  if (!fates.length) return '';
  const lines = fates.map(f => {
    const name = f.name || f.character_id || 'Unknown';
    const outcome = f.outcome || 'unknown';
    const rec = (f.historical_record || '').trim();
    const clause = rec ? rec.split(/(?<=[.!?])\s/)[0].trim() : '';
    return clause ? `- ${name}: ${outcome} — ${clause}` : `- ${name}: ${outcome}`;
  });
  return `DOCUMENTED FATES OF REAL PEOPLE (immutable — no branch of any role may contradict these: survivors survive, casualties die, in every branch):\n${lines.join('\n')}`;
}

// The immutability law + failure redefinition, prepended to every mode's instruction so
// each generated ending is bound by it regardless of the role's fate_mode.
const UNIVERSAL_LAW = `UNIVERSAL LAW — THE RECORD IS IMMUTABLE IN EVERY DIRECTION. The documented historical record is fixed for every real person, across all roles and all three branches. No ending may narrate: a documented survivor dying, a documented casualty surviving, or any change to the macro-historical outcome or to the documented manner of and relationships between real people. This holds EVEN WHEN the ending belongs to a different character than the one whose fate would be altered — a commander's failure branch may NOT kill the crew; a witness's failure may not change what they witnessed. Consult the DOCUMENTED FATES OF REAL PEOPLE block above: every name there is fixed in the direction stated.

FAILURE, REDEFINED FOR FIXED HISTORY. Failure is NOT a different outcome — it is the costliest human path to the SAME fixed outcome. The fixed events land where they landed; what the success/partial/failure gradient changes is cost, method, and self — at what price the fixed outcome was reached, through whose error, and what the character carries out of it.
- SUCCESS = the fixed outcome reached cleanly; the character was equal to the moment.
- PARTIAL = the fixed outcome reached, but at cost — haunted, a near-miss, a price paid.
- FAILURE = the fixed outcome STILL reached (history holds), but through the character's errors, by luck rather than skill, at the maximal personal / professional / moral cost. The character fails HIMSELF and those around him — never history. The fixed result arrives DESPITE the character, who is left with the corrosive knowledge that he was lucky, not good. Failure never undoes the fixed result.`;

// In-event outcomes that are consistent with a documented survivor surviving the event.
const SURVIVOR_SAFE_OUTCOMES = new Set(['survived', 'incapacitated', 'captured']);

// Single source of truth for which violation types are HARD BLOCKS (drop the role
// pre-persist + disable Approve at the gate) vs soft warnings. Consumed by the guard's
// own partition below, by the regenerate-path filter (PipelineOrchestrator, via the named
// import), and — through the per-violation `blocking` flag set in _applySurvivorGuard —
// by the gate UI. No consumer hardcodes these strings; they all key off this set / flag.
const BLOCK_TYPES = new Set(['survivor_died', 'survivor_killed', 'casualty_spared']);

// Tolerant name match between the generator's self-report and character_fates.
function normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Deterministic fate-consistency guard. Bidirectional and cross-character: no ending,
// from ANY role, may contradict a real documented person's in-event fate. Two signals,
// both structured (never a prose scan):
//   (1) Own-character survivor check (existing subset): the role's own anchored documented
//       survivor must not carry in_event_outcome 'died' in any branch — kept intact so
//       there is no regression even if the generator omits itself from the self-report.
//   (2) Cross-character check (the Kranz gap): the generator self-reports, per branch, the
//       in-event fate its prose depicts for each real documented person (real_people_depicted).
//       A documented survivor depicted as 'died' → survivor_killed; a documented casualty
//       depicted as 'survived' → casualty_spared — BLOCK in either direction, even when the
//       person is NOT this role's own character. 'unknown'/unmatched names impose nothing
//       (fictional characters are not in character_fates, so their deaths are never flagged).
function assertSurvivorSafety(scenario, endingNotes) {
  const violations = [];
  const notes = (endingNotes && endingNotes.ending_notes) || [];
  const roles = scenario?.player_roles || scenario?.playerRoles || [];
  const roleByName = new Map(roles.map(r => [r.name, r]));

  // Documented-fate lookup by name for the cross-character check — only definite outcomes
  // constrain (survived/died); 'unknown' and anything else impose no constraint.
  const fateByName = new Map();
  for (const f of (scenario?.epilogue?.character_fates || [])) {
    if ((f.outcome === 'survived' || f.outcome === 'died') && f.name) {
      fateByName.set(normName(f.name), { outcome: f.outcome, name: f.name });
    }
  }

  for (const note of notes) {
    for (const branch of ['success', 'partial', 'failure']) {
      const b = note[branch];
      if (!b) continue;

      // (1) Own-character survivor check (structured, reliable) — unchanged subset.
      const role = roleByName.get(note.role_name);
      if (role) {
        const binding = resolveAnchorBinding(scenario, role);
        if (binding.kind === 'documented' && binding.fate.outcome === 'survived') {
          const outcome = b.in_event_outcome || 'unresolved'; // missing → unresolved
          if (outcome === 'died') {
            violations.push({ role: note.role_name, branch, type: 'survivor_died' });
          } else if (!SURVIVOR_SAFE_OUTCOMES.has(outcome)) {
            violations.push({ role: note.role_name, branch, type: 'survivor_unresolved' });
          }
        }
      }

      // (2) Bidirectional cross-character check against the self-report.
      for (const dep of (b.real_people_depicted || [])) {
        const rec = fateByName.get(normName(dep && dep.name));
        if (!rec) continue; // fictional / unmatched → no documented fate to contradict
        if (rec.outcome === 'survived' && dep.in_event_fate === 'died') {
          violations.push({ role: note.role_name, branch, type: 'survivor_killed', person: rec.name });
        } else if (rec.outcome === 'died' && dep.in_event_fate === 'survived') {
          violations.push({ role: note.role_name, branch, type: 'casualty_spared', person: rec.name });
        }
      }
    }
  }

  // Dedup — the own-character check and the self-report can flag the same branch/person.
  const seen = new Set();
  const deduped = [];
  for (const v of violations) {
    const key = [v.role, v.branch, v.type, v.person || ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(v);
  }

  const blocked = deduped.filter(v => BLOCK_TYPES.has(v.type));
  const warnings = deduped.filter(v => !BLOCK_TYPES.has(v.type));
  // A blocked role is dropped entirely — the block subsumes any warning on it, so
  // exclude blocked roles from warnings to avoid double-listing the same role.
  const blockedRoles = new Set(blocked.map(v => v.role));
  return { blocked, warnings: warnings.filter(w => !blockedRoles.has(w.role)) };
}

const FATE_OUTPUT_SHAPE = `Return valid JSON only — no prose, no markdown, no backticks. Exactly this shape:
{
  "role_name": "<exact role name>",
  "success": { "what_happened": "...", "who_present": "...", "emotional_weight": "...", "closing_line": "...", "in_event_outcome": "survived|died|incapacitated|captured|unresolved", "real_people_depicted": [ { "name": "<exact roster name>", "in_event_fate": "survived|died" } ] },
  "partial": { "what_happened": "...", "who_present": "...", "emotional_weight": "...", "closing_line": "...", "in_event_outcome": "survived|died|incapacitated|captured|unresolved", "real_people_depicted": [ { "name": "<exact roster name>", "in_event_fate": "survived|died" } ] },
  "failure": { "what_happened": "...", "who_present": "...", "emotional_weight": "...", "closing_line": "...", "in_event_outcome": "survived|died|incapacitated|captured|unresolved", "real_people_depicted": [ { "name": "<exact roster name>", "in_event_fate": "survived|died" } ] }
}
Each end-state commits to its outcome: success = the objective achieved cleanly; partial = achieved at a real toll; failure = not achieved. "who_present" is a comma-separated list of co-located player role names at that resolution. "closing_line" is one punchy standalone thematic sentence — not a generic wrap-up. "emotional_weight" is the precise psychological takeaway.
"in_event_outcome" is a STRUCTURED restatement of what "what_happened" depicts for THIS character — not an independent claim. It is one of exactly: "survived" (alive and not seriously incapacitated at the end of the depicted event), "died" (killed DURING the depicted event — in-event, not later in life), "incapacitated" (alive but seriously wounded / out of action by the event's end), "captured" (taken prisoner during the event — alive, in enemy hands), or "unresolved" (the branch does not commit to a definite in-event fate). Reflect the IN-EVENT outcome only, never the character's later-life fate. Set it to match what the prose actually depicts; you MUST use "unresolved" rather than invent a definite fate the prose does not support.
"real_people_depicted" is a STRUCTURED audit signal: list every real documented person whose in-event living or dying THIS BRANCH's prose depicts — use the exact names from the DOCUMENTED FATES roster, and INCLUDE the role's own character if they are documented. "in_event_fate" is what THIS branch depicts for that person ("survived" or "died"), which may differ per branch — record what the prose actually SHOWS, not the historical record (e.g. if a failure branch's prose depicts a crew dying, list them as "died" here even if history says they lived; that is exactly the contradiction this field surfaces). OMIT fictional or composite characters (they are not on the roster) and OMIT anyone merely mentioned without a depicted in-event fate. Use [] if the branch depicts no real person's in-event fate.`;

function buildFateBranch(scenario, role) {
  const mode = role.fate_mode;
  if (mode === 'committed') {
    return {
      ok: true,
      instruction: `${UNIVERSAL_LAW}

MODE: COMMITTED (fictional / composite figure — full range on the table). This character MAY die in a failure branch, OR may live bearing the burden of failure — the whole range is available for THIS character. BUT their death or failure is SELF-CONTAINED: it may affect only this fictional character and OTHER FICTIONAL characters. It may NOT kill or alter the documented fate of any real person, and may NOT change the macro-outcome. (A fictional Ranger may die pushing the Bangalore; his death may NOT make the fixed draw "never taken" or kill a real documented officer.) Within those bounds, invent a plausible, dramatically-earned outcome.`
    };
  }
  if (mode === 'suspended') {
    return {
      ok: true,
      instruction: `${UNIVERSAL_LAW}

MODE: SUSPENDED (fictional; no death by authorial choice). Do NOT commit to this character's death in any branch — their ultimate fate is kept open by authorial choice, not by the record. Failure is cost and burden only: a degraded, unresolved personal price, never a death-committed ending. The same no-altering-history constraint applies — nothing in any branch may change a real person's documented fate or the macro-outcome.`
    };
  }
  if (mode === 'anchored') {
    const binding = resolveAnchorBinding(scenario, role);
    if (binding.kind === 'documented') {
      const f = binding.fate;
      let ownFateRule;
      if (f.outcome === 'survived') {
        ownFateRule = `THIS CHARACTER'S OWN FATE — DOCUMENTED SURVIVOR (outcome: survived). This person does NOT die in any branch; the record says they lived. NO branch — including failure — may kill, disappear, or strand this person to their death. Failure means the maximal personal / professional / moral cost WITHIN their survival — they live, but they live having failed themselves.`;
      } else if (f.outcome === 'died') {
        ownFateRule = `THIS CHARACTER'S OWN FATE — DOCUMENTED CASUALTY (outcome: died). This person DIES in EVERY branch — success, partial, AND failure — because the record says they died; the player cannot prevent it. Success/partial/failure is NOT whether they die but the MEANING, DIGNITY, and COST of how they meet the fixed death, honoring the documented manner and relationships. Success = the documented, meaningful death met with intentions intact; partial = the fixed death, but shadowed by a price or a near-betrayal; failure = a death that squanders its meaning — panic, or a betrayal of the character's own principles. Do not invent a manner of death that contradicts the record.`;
      } else {
        ownFateRule = `THIS CHARACTER'S OWN FATE — INDETERMINATE (documented outcome: "${f.outcome}"). The record does not fix a definite in-event fate. Stay within the record; do not invent a definite in-event death or survival the record does not support. Failure is cost and burden within that documented ambiguity.`;
      }
      return {
        ok: true,
        instruction: `${UNIVERSAL_LAW}

MODE: ANCHORED — DOCUMENTED FIGURE (${f.name}). Stay within the documented record; ground facts ONLY in it and do not assert undocumented specifics as fact. ${ownFateRule}
DOCUMENTED RECORD:\n${f.historical_record || '(no narrative record provided)'}`
      };
    }
    if (binding.kind === 'welded') {
      const m = binding.macro;
      return {
        ok: true,
        instruction: `${UNIVERSAL_LAW}

MODE: ANCHORED — WELDED COMPOSITE (no documented person record). This invented figure is welded to the scenario's FIXED MACRO-OUTCOME, which is immutable and bounds all three branches. The macro-outcome and every real person's documented fate hold in every branch. If the macro-outcome is one in which the people involved survive (no violence, no deaths), then NO branch — including failure — may kill this role; failure is the maximal personal cost WITHIN that fixed surviving reality, never a contradiction of it.
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
    const fatesRoster = buildDocumentedFatesRoster(scenario);
    const userPrompt = `SCENARIO: ${scenarioTitle}
PREMISE: ${scenario?.premise || scenario?.opening_premise || ''}
DOCUMENTED EVENT OUTCOME: ${scenario?.epilogue?.immediate_outcome?.summary || '(see record below)'}
${fatesRoster ? '\n' + fatesRoster + '\n' : ''}
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

export { assertSurvivorSafety, BLOCK_TYPES };
export default { fillMissingFields, generateEndingNotes, assertSurvivorSafety, BLOCK_TYPES };
