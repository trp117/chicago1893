const OPENAI_BASE_URL = 'https://api.openai.com/v1/chat/completions';

async function callOpenAI(systemPrompt, userPrompt, options = {}) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const response = await fetch(OPENAI_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENAI_API_KEY
    },
    body: JSON.stringify({
      model: options.model || 'gpt-4o',
      temperature: options.temperature || 0.2,
      max_tokens: options.maxTokens || 8192,
      response_format: options.json ? { type: 'json_object' } : undefined,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('OpenAI API error: ' + response.status + ' ' + err);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned empty response');
  return text;
}

export async function reviewFullScenario(scenarioText, scenarioTitle) {
  const systemPrompt = `You are an independent historical accuracy and continuity editor.
You review interactive historical fiction scenarios for factual errors, timeline inconsistencies,
geographic inaccuracies, and internal contradictions. You are thorough, precise, and only flag
issues you are confident about. You always respond with valid JSON only — no prose before or after.`;

  const userPrompt = `Review the following complete scenario data for ${scenarioTitle}.

Check for:
1. Historical fact accuracy — dates, names, events, quotes
2. Timeline and timing consistency across all sections
3. Geographic accuracy — locations, distances, directions
4. Character detail consistency — no contradictions between sections
5. Internal contradictions — where one section conflicts with another
6. Dramatic license that could mislead players about real history

Respond in the following JSON format exactly:

{
  "corrections": [
    {
      "field_path": "dot-notation path to the field",
      "section": "which section e.g. world, stakes, scene, characters, epilogue",
      "current_text": "exact current text",
      "corrected_text": "the full corrected replacement text",
      "reason": "brief explanation of the error",
      "confidence": "high|medium",
      "type": "factual|continuity|geographic|character|contradiction|dramatic_license",
      "priority": "critical|high|medium|low"
    }
  ],
  "agreements_with_gemini": ["list any corrections that align with prior Gemini review"],
  "new_findings": ["list corrections not previously flagged"],
  "overall_assessment": "brief summary paragraph",
  "historical_accuracy_score": 0.0,
  "continuity_score": 0.0,
  "recommendation": "approve|approve_with_changes|requires_revision"
}

Complete scenario data:
${scenarioText}`;

  const result = await callOpenAI(systemPrompt, userPrompt, { json: true, temperature: 0.2 });
  return JSON.parse(result);
}

export async function reviewEndingNotes(endingNotesText, scenarioTitle, scenarioContext) {
  const systemPrompt = `You are a narrative quality editor for interactive historical fiction.
You review character ending notes for consistency with the scenario, emotional authenticity,
and historical accuracy. You always respond with valid JSON only — no prose before or after.`;

  const userPrompt = `Review the following ending notes for ${scenarioTitle}.

Check for:
1. Consistency with the scenario — do outcomes match what the scenario makes possible
2. Character voice — do the endings match each character's established voice and arc
3. Emotional authenticity — are the emotional weights believable and earned
4. Historical grounding — do endings respect the fixed historical outcome
5. Closing line quality — is each closing line strong and specific

Respond in the following JSON format exactly:

{
  "corrections": [
    {
      "role_name": "the character role this correction applies to",
      "ending_type": "partial|failure",
      "field": "what_happened|who_present|emotional_weight|closing_line",
      "current_text": "exact current text",
      "corrected_text": "the full corrected replacement text",
      "reason": "brief explanation",
      "confidence": "high|medium",
      "priority": "high|medium|low"
    }
  ],
  "overall_assessment": "brief summary of ending notes quality",
  "narrative_consistency_score": 0.0,
  "recommendation": "approve|approve_with_changes|requires_revision"
}

Scenario context:
${scenarioContext}

Ending notes to review:
${endingNotesText}`;

  const result = await callOpenAI(systemPrompt, userPrompt, { json: true, temperature: 0.2 });
  return JSON.parse(result);
}

export default { reviewFullScenario, reviewEndingNotes };
