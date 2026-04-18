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
const turnTemplate = readText('prompts/turn_prompt_template.md');
const notesSystemPrompt = readText('prompts/notes_system_prompt.md');
const notesTemplate = readText('prompts/notes_prompt_template.md');
const scenario = readJson('data/scenario.json');
const locations = readJson('data/locations.json');
const npcs = readJson('data/npcs.json');
const cluesCatalog = readJson('data/clues.json');

function getLocationById(id) {
  return locations.find((loc) => loc.id === id) || null;
}

function getClueById(id) {
  return cluesCatalog.find((c) => c.id === id) || null;
}

function slimLocation(loc) {
  if (!loc) return null;
  return { id: loc.id, name: loc.name, description: loc.description, atmosphericClues: loc.possibleClues };
}

function slimClue(clue) {
  return { id: clue.id, title: clue.title, description: clue.description, category: clue.category, implicates: clue.implicates, unlocks: clue.unlocks };
}

function getAvailableCluesAtLocation(locationId, discoveredClueIds) {
  return cluesCatalog
    .filter((c) => c.source === locationId && !discoveredClueIds.includes(c.id))
    .map((c) => ({ id: c.id, title: c.title, category: c.category }));
}

function checkEndingReadiness(state) {
  const ids = state.discoveredClueIds || [];
  const hasMethod = state.knownSabotageMethod;
  const hasKeyEvidence = ids.includes('tampered_wiring_diagrams') || ids.includes('opening_night_note');
  const hasConspirators = (state.namedConspirators || []).length >= 2;
  return {
    keyEvidenceFound: hasKeyEvidence,
    readyForClimax: hasMethod || (hasKeyEvidence && hasConspirators)
  };
}

function slimNpc(npc) {
  return { id: npc.id, name: npc.name, voice: npc.voice, goal: npc.privateGoal, knowledge: npc.knowledge };
}

function getRelevantNpcs(state, location) {
  const ids = new Set();
  if (location?.linkedNPCs) {
    location.linkedNPCs.forEach((id) => ids.add(id));
  }
  Object.entries(state.suspicion || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .forEach(([id]) => ids.add(id));
  return npcs.filter((npc) => ids.has(npc.id)).map(slimNpc);
}

function composeTurnPrompt(state, playerInput) {
  const location = getLocationById(state.location);
  const relevantNpcs = getRelevantNpcs(state, location);
  const discoveredClues = (state.discoveredClueIds || []).map(getClueById).filter(Boolean).map(slimClue);
  const availableClues = getAvailableCluesAtLocation(state.location, state.discoveredClueIds || []);
  const endingSignals = checkEndingReadiness(state);

  return turnTemplate
    .replace('{{STATE_JSON}}', JSON.stringify(state))
    .replace('{{LOCATION_JSON}}', JSON.stringify(slimLocation(location)))
    .replace('{{NPC_JSON}}', JSON.stringify(relevantNpcs))
    .replace('{{DISCOVERED_CLUES_JSON}}', JSON.stringify(discoveredClues))
    .replace('{{AVAILABLE_CLUES_JSON}}', JSON.stringify(availableClues))
    .replace('{{ENDING_SIGNALS_JSON}}', JSON.stringify(endingSignals))
    .replace('{{PLAYER_INPUT}}', playerInput);
}

function mergeState(currentState, modelOutput) {
  const next = structuredClone(currentState);
  const delta = modelOutput.stateChanges || {};

  const advance = Number(modelOutput.timeAdvance || scenario.coreSystems.timePerTurnDefault || 3);
  next.elapsedMinutes += advance;
  next.remainingMinutes = Math.max(0, scenario.sessionTargetMinutes - next.elapsedMinutes);

  if (typeof modelOutput.location === 'string' && modelOutput.location) {
    next.location = modelOutput.location;
    if (!next.visitedLocations.includes(modelOutput.location)) {
      next.visitedLocations.push(modelOutput.location);
    }
  }

  if (typeof delta.threat === 'number') {
    next.threat = Math.max(0, Math.min(10, next.threat + delta.threat));
  }

  if (typeof delta.act === 'number') {
    next.act = delta.act;
  } else {
    if (next.elapsedMinutes >= 8) next.act = 3;
    else if (next.elapsedMinutes >= 4) next.act = 2;
    else next.act = 1;
  }

  if (typeof delta.burnhamTrust === 'number') {
    next.burnhamTrust = Math.max(-3, Math.min(5, next.burnhamTrust + delta.burnhamTrust));
  }

  if (delta.suspicion && typeof delta.suspicion === 'object') {
    for (const [npcId, amount] of Object.entries(delta.suspicion)) {
      const current = next.suspicion[npcId] || 0;
      next.suspicion[npcId] = current + Number(amount || 0);
    }
  }

  if (Array.isArray(modelOutput.newClues)) {
    for (const clueId of modelOutput.newClues) {
      if (typeof clueId !== 'string') continue;
      if (!(next.discoveredClueIds || []).includes(clueId)) {
        next.discoveredClueIds = next.discoveredClueIds || [];
        next.discoveredClueIds.push(clueId);
        const clue = getClueById(clueId);
        if (clue) {
          for (const npcId of (clue.implicates || [])) {
            next.suspicion[npcId] = (next.suspicion[npcId] || 0) + 1;
          }
        }
      }
    }
  }

  if (delta.flags && typeof delta.flags === 'object') {
    next.flags = { ...next.flags, ...delta.flags };
  }

  if (typeof delta.knownSabotageMethod === 'boolean') {
    next.knownSabotageMethod = delta.knownSabotageMethod;
  }

  if (Array.isArray(delta.namedConspirators)) {
    next.namedConspirators = Array.from(new Set([...next.namedConspirators, ...delta.namedConspirators]));
  }

  return next;
}

function buildMockNotes(state, discoveredClues, suspicionContext) {
  const clues = discoveredClues.map((c) => ({
    title: c.title,
    significance: c.description
  }));

  const suspicions = suspicionContext.map(({ name, score }) => ({
    name,
    level: score >= 3 ? 'high' : score >= 2 ? 'medium' : 'low',
    reasoning: score >= 3
      ? 'Several pieces of evidence now point in their direction.'
      : 'Something in their behavior has not sat right with me.'
  }));

  const impressions = suspicionContext.slice(0, 3).map(({ name, score }) => ({
    name,
    impression: score > 1
      ? 'Evasive when pressed. I should return to them with harder questions.'
      : 'Hard to read so far. Either uninvolved or very careful.'
  }));

  const openQuestions = [
    !state.knownSabotageMethod && 'I still do not know exactly how the sabotage is meant to work.',
    (state.namedConspirators || []).length < 2 && 'There are people behind this I have not yet identified.',
    discoveredClues.length < 3 && 'I have not found all the physical evidence — there is more out there.'
  ].filter(Boolean);

  const visited = state.visitedLocations || [];
  const nextLeads = [
    !visited.includes('freight_yards') && 'The freight yards may hold physical evidence of the diverted crates.',
    !visited.includes('machinery_hall') && 'Machinery Hall should be examined for tampering.',
    !visited.includes('midway_plaisance') && 'The Midway is full of loose talk — worth a visit.',
    discoveredClues.length === 0 && 'Start with the documents Burnham has on his desk.'
  ].filter(Boolean).slice(0, 3);

  return { clues, suspicions, characterImpressions: impressions, openQuestions, nextLeads };
}

app.post('/api/notes', async (req, res) => {
  try {
    const { state } = req.body;
    if (!state) return res.status(400).json({ error: 'Missing state.' });

    const discoveredClues = (state.discoveredClueIds || []).map(getClueById).filter(Boolean).map(slimClue);
    const suspicionContext = Object.entries(state.suspicion || {})
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => {
        const npc = npcs.find((n) => n.id === id);
        return { id, name: npc?.name || id, score };
      });

    if (!API_KEY) {
      return res.json({ notes: buildMockNotes(state, discoveredClues, suspicionContext) });
    }

    const prompt = notesTemplate
      .replace('{{DISCOVERED_CLUES_JSON}}', JSON.stringify(discoveredClues))
      .replace('{{SUSPICION_JSON}}', JSON.stringify(suspicionContext))
      .replace('{{NAMED_CONSPIRATORS}}', JSON.stringify(state.namedConspirators || []))
      .replace('{{VISITED_LOCATIONS}}', JSON.stringify(state.visitedLocations || []))
      .replace('{{ACT}}', String(state.act || 1))
      .replace('{{ELAPSED}}', String(state.elapsedMinutes || 0));

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

app.get('/api/bootstrap', (_, res) => {
  res.json({
    scenario,
    cluesCatalog,
    state: scenario.initialState,
    opening: {
      narrative:
        "Chicago, May 1893. The White City rises from the lakefront mud, its plaster palaces gleaming in the morning haze — ten thousand workers still swarming Jackson Park in the final days before the Exposition opens. But beneath the spectacle, something is wrong. A tension moves through the corridors of the Administration Building that has nothing to do with last-minute preparations.\n\nYou are assistant to Daniel Burnham, Director of Works. When he needs eyes he can trust, he sends for you.\n\nThis morning, a shipping manifest crossed your desk: electrical equipment, diverted from its declared route. The signature authorizing the change does not match any name on Burnham's staff.\n\nBurnham's office door stands open. He is at his desk, jaw set, a telegraph slip folded in his hand. He looks up.",
      npcMoments: [
        {
          npc: 'daniel_burnham',
          text: "'Shut the door. Tell me what you found in those papers.'"
        }
      ],
      choices: [
        'Show Burnham the mismatched signature on the manifest',
        'Ask Burnham what he already suspects',
        'Request permission to go directly to the freight yards'
      ]
    }
  });
});

app.post('/api/turn', async (req, res) => {
  try {
    const { state, playerInput } = req.body;
    if (!state || !playerInput) {
      return res.status(400).json({ error: 'Missing state or playerInput.' });
    }

    if (!API_KEY) {
      const fallback = {
        narrative:
          "Burnham narrows his eyes as you speak. Around you, clerks continue their work with the strained efficiency of men who know that every lost minute may become a public embarrassment. Your question touches a nerve: several consignments were rerouted under irregular authority, and one initials mark appears twice in different hands.",
        timeAdvance: 3,
        location: state.location,
        stateChanges: {
          threat: 1,
          burnhamTrust: 1
        },
        newClues: ['forged_initials_memo'],
        npcMoments: [
          {
            npc: 'daniel_burnham',
            text: "'Find out whether this is incompetence or design. I confess I no longer assume the better of the two.'"
          }
        ],
        choices: [
          'Inspect the altered memorandum more closely',
          'Question a clerk about who carried the papers',
          'Head to Machinery Hall to verify the electrical delivery'
        ],
        endState: {
          isEnding: false,
          result: 'ongoing'
        }
      };

      return res.json({ output: fallback, nextState: mergeState(state, fallback), mockMode: true });
    }

    const prompt = composeTurnPrompt(state, playerInput);

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
        max_tokens: 900,
        temperature: 0.8,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    const data = await response.json();
    const text = data?.content?.[0]?.text;

    if (!text) {
      return res.status(500).json({ error: 'No text returned from Anthropic.', raw: data });
    }

    let output;
    try {
      output = JSON.parse(text);
    } catch (parseError) {
      return res.status(500).json({ error: 'Model returned invalid JSON.', rawText: text });
    }

    const nextState = mergeState(state, output);

    if (output.endState?.isEnding) {
      output.endState.performance = {
        cluesDiscovered: nextState.discoveredClueIds?.length || 0,
        totalClues: cluesCatalog.length,
        timeRemaining: nextState.remainingMinutes,
        result: output.endState.result || 'failure'
      };
    }

    return res.json({ output, nextState, mockMode: false });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Chicago 1893 server running on http://localhost:${PORT}`);
});
