const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1/messages';

async function callClaude(systemPrompt, userPrompt, options = {}) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const response = await fetch(ANTHROPIC_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: options.maxTokens || 8192,
      temperature: options.temperature || 0.3,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Claude API error: ' + response.status + ' ' + err);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text;
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

export default { fillMissingFields };
