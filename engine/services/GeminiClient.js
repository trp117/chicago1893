const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

async function callGemini(prompt, options = {}) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const response = await fetch(GEMINI_BASE_URL + '?key=' + GEMINI_API_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: options.temperature || 0.3,
        maxOutputTokens: options.maxTokens || 8192,
        responseMimeType: options.json ? 'application/json' : 'text/plain'
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Gemini API error: ' + response.status + ' ' + err);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

export async function generateSynopsis(storyIdea, sessionLength = 30) {
  const systemPrompt = `You are a core systems architect and high-literary script editor for an interactive, multi-character historical simulation engine. Your job is to execute Step 1: Narrative Detail and Historical Framework for specified historical events.

CRITICAL DESIGN PRINCIPLES:
1. FIXED HISTORY CEILING: The overall historical event has an immutable outcome. Players cannot alter macro-history. They are solely competing against the environment to determine personal, professional, or squad-level survival metrics.
2. MECHANICAL TECHNICAL INTIMACY: Avoid generic, melodramatic summaries. Focus entirely on the arithmetic of survival — the mechanical realities, logistical failures, spatial layouts, technical tolerances, and explicit data values unique to that specific historical moment.
3. LOGICAL COHESION: The separate character perspectives must occupy the exact same physical space and time. A choice made by one character must mathematically or logically impact the environmental constraints of the others via a shared simulation ledger.

REQUIRED OUTPUT STRUCTURE — return clean formatted text, not JSON:

## Step 1: Narrative Detail & Historical Framework

### 1. The Historical Anchor
- Location: [Highly precise primary-source coordinates, facilities, or specific sectors]
- Time/Date: [Exact start and end hour/minute, day, and year of the simulation window]
- The Fixed Outcome: [The rigid macro-historical constraint that cannot be broken. Specify the absolute logistical ceiling — distances of rescue ships, rates of destruction, hard numerical limits — that traps the players]

### 2. The Shared Fact Ledger
Exactly three quantifiable, fluctuating environmental variables that change dynamically based on character decisions. Do not list static plot descriptions.
- [Variable Name 1]: [A tracking metric managing structural integrity, physical ceilings/floors, or capacity limits — with specific numbers]
- [Variable Name 2]: [A tracking metric managing resource depletion, equipment status, or physical hazards — with specific numbers]
- [Variable Name 3]: [A tracking metric managing visibility, communication, or environmental friction — with specific numbers]

### 3. The Narrative Arcs

#### Perspective A: [Role Title]
- The Tension: [The visceral, immediate psychological and sensory reality of this role, centered on their tools, gauges, environments, or duties. Use specific numbers, distances, temperatures, pressures.]
- The Decision Point: [A severe professional compromise or technical trade-off. Completely avoid generic survive-or-flee binaries. The decision must choose between competing historical priorities where choosing one directly penalizes the Shared Fact Ledger or another player role.]

#### Perspective B: [Role Title]
- The Tension: [Same standard — visceral, specific, numbered]
- The Decision Point: [Same standard — professional trade-off with cross-character consequences]

#### Perspective C: [Role Title]
- The Tension: [Same standard]
- The Decision Point: [Same standard]

### 4. Natural Flow & Structural Milestones

#### Act I: [Name] ([time range])
- Shared Ledger State: [Values of the 3 variables at opening]
- Narrative Pulse: [What is happening across all three perspectives in this act]

#### Act II: [Name] ([time range])
- Shared Ledger State: [Values — showing change from Act I]
- Narrative Pulse: [Escalation across all three perspectives]

#### Act III: [Name] ([time range])
- Shared Ledger State: [Values — crisis point]
- Narrative Pulse: [Terminal decisions for all three perspectives]

### 5. Period-Accurate Vocabulary
Minimum 8 primary-source terms, slang words, technical parts, or historic designations specific to this scene. Each must act as sensory shorthand for the prose generator.
- [Term]: [Precise historical context — not a dictionary definition, a sensory anchor]

Session length: ${sessionLength} minutes`;

  const userPrompt = `Execute Step 1 for the following historical scenario:\n\n${storyIdea}`;

  const result = await callGemini(systemPrompt + '\n\n' + userPrompt, { json: false, temperature: 0.4, maxTokens: 4096 });
  return result;
}

export async function factCheckEpilogue(epilogueText, scenarioTitle) {
  const prompt = `You are a historical fact-checker for an interactive fiction engine called ${scenarioTitle}.

Review the following historical epilogue data for factual accuracy. Be precise. If you are not certain a fact is wrong, do not flag it.

For each correction needed, respond in the following JSON format exactly. No prose before or after. JSON only.

{
  \"corrections\": [
    {
      \"field_path\": \"the dot-notation path to the field e.g. immediate_outcome.key_facts.0\",
      \"current_text\": \"exact current text\",
      \"corrected_text\": \"the full corrected replacement text\",
      \"reason\": \"brief explanation of the error\",
      \"confidence\": \"high|medium\",
      \"source\": \"citation or source for the correction\"
    }
  ],
  \"confirmed_accurate\": [\"list of sections that are factually sound\"],
  \"unable_to_verify\": [\"list of claims that could not be verified\"]
}

Epilogue data to review:
${epilogueText}`;

  const result = await callGemini(prompt, { json: true, temperature: 0.2 });
  return JSON.parse(result);
}

export async function reviewFullScenario(scenarioText, scenarioTitle) {
  const prompt = `You are a continuity and accuracy editor for an interactive historical fiction engine.

Review the following complete scenario data for ${scenarioTitle}. Check for:
1. Historical fact accuracy
2. Timeline and timing consistency
3. Geographic accuracy
4. Character detail consistency
5. Internal contradictions between sections

Respond in the following JSON format exactly. No prose before or after. JSON only.

{
  \"corrections\": [
    {
      \"field_path\": \"dot-notation path to the field\",
      \"section\": \"which section this appears in e.g. world, stakes, characters\",
      \"current_text\": \"exact current text\",
      \"corrected_text\": \"the full corrected replacement text\",
      \"reason\": \"brief explanation\",
      \"confidence\": \"high|medium\",
      \"type\": \"factual|continuity|geographic|character|contradiction\"
    }
  ],
  \"overall_assessment\": \"brief summary of scenario quality\",
  \"historical_accuracy_score\": 0.0,
  \"continuity_score\": 0.0
}

Complete scenario data:
${scenarioText}`;

  const result = await callGemini(prompt, { json: true, temperature: 0.2 });
  return JSON.parse(result);
}

export async function generateEndingNotes(scenarioText, scenarioTitle, playerRoles) {
  const roleNames = playerRoles.map(r => r.name).join(', ');

  const systemPrompt = `You are a core systems architect and simulation state editor for an interactive, multi-character historical simulation engine. Your job is to execute Step 2: Player Roles and Structured Endings Packet based on an established Step 1 Narrative Detail and Historical Framework.

CRITICAL DESIGN PRINCIPLES:
1. SPATIAL AND CHRONOLOGICAL COHESION: All player roles must occupy the exact same physical space and time slice. Under the Who Was Present fields for partial and failure endings, you must accurately cross-reference which other player roles are co-located in that specific sub-scene.
2. LOCALIZED TECHNICAL KNOWLEDGE: Starting Knowledge must consist entirely of objective, professional, and historical realities specific to that role's technical domain — dial readings, logistical distances, structural parameters, or regulations. Do not write generic plot descriptions.
3. THE ANTI-MELODRAMA MANDATE: Briefings must be exactly 5 sentences long, written in the second person. They must focus heavily on the tactical environment and sensory thresholds — fusing sensory details with professional duties without descending into generic heroism or villainy.
4. METRIC-BASED FAILURE: Ending notes must describe outcomes driven purely by environmental breakdown or technical compromises — short-circuits, asphyxiation, structural collapses, or systemic failure to move.

CRITICAL OUTPUT RULES:
- Return valid JSON only — no prose, no markdown, no backticks before or after
- Map exactly to the schema below
- Player roles to cover: ${roleNames}

Return this exact JSON structure:

{
  "ending_notes": [
    {
      "role_name": "exact role name matching the scenario",
      "description": "data-dense one-sentence summary of the role professional background and immediate operational context",
      "access_level": "staff or investigator or admin based on data oversight requirements",
      "perspective": "first-person sensory or third-person analytical",
      "starting_knowledge": [
        "unique technical or logistical or historical fact 1",
        "unique technical or logistical or historical fact 2",
        "unique technical or logistical or historical fact 3"
      ],
      "briefing": "exactly 5 sentences in second person establishing the toolset immediate sensory stakes and structural threshold of the role",
      "hook_1": "the immediate raw sensory or mechanical trigger initializing their opening scene",
      "hook_2": "the secondary localized environmental threat or calibration drift",
      "hook_3": "the primary structural societal or technical obstacle confronting the role",
      "suggested_secret": "one hidden historical medical legal or mechanical liability unknown to other players that threatens their operational capacity",
      "partial": {
        "what_happened": "narrative of fulfilling the objective but incurring a devastating personal physical or moral toll directly caused by their choices",
        "who_present": "comma-separated role names present at this resolution",
        "emotional_weight": "the precise psychological takeaway or moral injury intended for the player",
        "closing_line": "one punchy standalone thematic signature sentence tracking the personal cost — not a generic wrap-up"
      },
      "failure": {
        "what_happened": "specific narrative detailing exactly which component broke how they succumbed to the environment or the mechanics of how the role was removed from the timeline",
        "who_present": "comma-separated role names present at failure",
        "emotional_weight": "the precise psychological feeling of futility catastrophic exposure or systemic paralysis",
        "closing_line": "one punchy standalone thematic signature sentence executing the final tragedy — not a generic wrap-up"
      }
    }
  ]
}`;

  const userPrompt = `Generate the Step 2 Player Roles and Structured Endings Packet for this scenario:\n\n${scenarioText}`;

  const result = await callGemini(systemPrompt + '\n\n' + userPrompt, { json: true, temperature: 0.5, maxTokens: 8192 });

  try {
    const clean = result.replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();
    return JSON.parse(clean);
  } catch (err) {
    throw new Error('Gemini ending notes returned invalid JSON: ' + err.message);
  }
}

export default { generateSynopsis, factCheckEpilogue, reviewFullScenario, generateEndingNotes };
