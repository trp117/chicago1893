import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(rootDir, 'src')));

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

function readText(filePath) {
  return fs.readFileSync(path.join(rootDir, filePath), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

const systemPrompt = readText('prompts/system_prompt.md');
const notesSystemPrompt = readText('prompts/notes_system_prompt.md');
const notesTemplate = readText('prompts/notes_prompt_template.md');
const scenario = readJson('data/scenario.json');

const OPENING_NARRATIVE = "Chicago, May 1893. The White City rises from the lakefront mud, its plaster palaces gleaming in the morning haze — ten thousand workers still swarming Jackson Park in the final days before the Exposition opens. But beneath the spectacle, something is wrong. A tension moves through the corridors of the Administration Building that has nothing to do with last-minute preparations.\n\nYou are assistant to Daniel Burnham, Director of Works. When he needs eyes he can trust, he sends for you.\n\nThis morning, a shipping manifest crossed your desk: electrical equipment, diverted from its declared route. The signature authorizing the change does not match any name on Burnham's staff.\n\nBurnham's office door stands open. He is at his desk, jaw set, a telegraph slip folded in his hand. He looks up. \"Shut the door. Tell me what you found in those papers.\"";

app.get('/api/bootstrap', (_, res) => {
  res.json({
    initial_state: scenario.initialState,
    opening: { narrative: OPENING_NARRATIVE }
  });
});

app.post('/api/turn', async (req, res) => {
  try {
    const { state, playerInput } = req.body;
    if (!state || !playerInput) {
      return res.status(400).json({ error: 'Missing state or playerInput.' });
    }

    if (!API_KEY) {
      const mockState = structuredClone(state);
      const firstHidden = mockState.clues.find(c => c.status === 'hidden');
      if (firstHidden) firstHidden.status = 'discovered';
      const burnham = mockState.npcs.find(n => n.name === 'Daniel Burnham');
      if (burnham) burnham.trust = Math.min(100, burnham.trust + 5);

      return res.json({
        narrative: "Burnham narrows his eyes as you speak. Around you, clerks continue their work with the strained efficiency of men who know that every lost minute may become a public embarrassment. Your question touches a nerve: several consignments were rerouted under irregular authority, and one initials mark appears twice in different hands.\n\n\"Find out whether this is incompetence or design,\" Burnham says quietly. \"I confess I no longer assume the better of the two.\"",
        choices: [
          'Inspect the altered memorandum more closely',
          'Head to the freight yards to trace the rerouted delivery',
          'Ask Burnham who had access to the shipping papers'
        ],
        updated_state: mockState,
        mockMode: true
      });
    }

    const prompt = `Current game state:\n${JSON.stringify(state)}\n\nPlayer action:\n${playerInput}`;

    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        temperature: 0.8,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = data?.content?.[0]?.text;
    if (!text) return res.status(500).json({ error: 'No response from AI.', raw: data });

    let output;
    try {
      output = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: 'Model returned invalid JSON.', rawText: text });
    }

    return res.json({
      narrative: output.narrative,
      choices: output.choices || [],
      updated_state: output.updated_state,
      mockMode: false
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.post('/api/notes', async (req, res) => {
  try {
    const { state } = req.body;
    if (!state) return res.status(400).json({ error: 'Missing state.' });

    const discoveredClues = (state.clues || []).filter(c => c.status !== 'hidden');
    const npcContext = (state.npcs || []).map(n => ({
      name: n.name,
      role: n.role,
      trust: n.trust,
      suspicion: n.suspicion
    }));
    const playerConclusions = state.player || {};

    if (!API_KEY) {
      return res.json({ notes: buildMockNotes(discoveredClues, npcContext, playerConclusions) });
    }

    const prompt = notesTemplate
      .replace('{{DISCOVERED_CLUES_JSON}}', JSON.stringify(discoveredClues))
      .replace('{{NPC_JSON}}', JSON.stringify(npcContext))
      .replace('{{PLAYER_CONCLUSIONS_JSON}}', JSON.stringify(playerConclusions));

    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        temperature: 0.7,
        system: notesSystemPrompt,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = data?.content?.[0]?.text;
    if (!text) return res.status(500).json({ error: 'No response from AI.' });

    let notes;
    try {
      notes = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: 'Invalid notes format returned.' });
    }

    return res.json({ notes });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error.' });
  }
});

function buildMockNotes(discoveredClues, npcContext, playerConclusions) {
  const clues = discoveredClues.map(c => ({ title: c.title, significance: c.description }));

  const suspicions = npcContext
    .filter(n => n.suspicion > 20)
    .map(n => ({
      name: n.name,
      level: n.suspicion >= 60 ? 'high' : n.suspicion >= 30 ? 'medium' : 'low',
      reasoning: n.suspicion >= 60
        ? 'Several pieces of evidence now point in their direction.'
        : 'Something in their behavior has not sat right with me.'
    }));

  const characterImpressions = npcContext.slice(0, 3).map(n => ({
    name: n.name,
    impression: n.trust > 20
      ? 'Seems forthcoming so far. Worth trusting with more direct questions.'
      : n.suspicion > 20
        ? 'Evasive when pressed. I should return to them with harder questions.'
        : 'Hard to read. Either uninvolved or very careful.'
  }));

  const openQuestions = [
    discoveredClues.length === 0 && 'I have not yet found any hard evidence.',
    !playerConclusions.identified_culprit && 'I have not yet identified a culprit.',
    !playerConclusions.identified_motive && 'The motive remains unclear.'
  ].filter(Boolean);

  const nextLeads = [
    discoveredClues.length === 0 && "Start with the documents on Burnham's desk.",
    'The freight yards may hold physical evidence.',
    'Machinery Hall should be examined for tampering.'
  ].filter(Boolean).slice(0, 3);

  return { clues, suspicions, characterImpressions, openQuestions, nextLeads };
}

app.listen(PORT, () => {
  console.log(`Chicago 1893 server running on http://localhost:${PORT}`);
});
