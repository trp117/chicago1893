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
const scenario = readJson('data/scenario.json');
const locations = readJson('data/locations.json');
const npcs = readJson('data/npcs.json');

function getLocationById(id) {
  return locations.find((loc) => loc.id === id) || null;
}

function slimLocation(loc) {
  if (!loc) return null;
  return { id: loc.id, name: loc.name, description: loc.description, clues: loc.possibleClues };
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

  return turnTemplate
    .replace('{{STATE_JSON}}', JSON.stringify(state))
    .replace('{{LOCATION_JSON}}', JSON.stringify(slimLocation(location)))
    .replace('{{NPC_JSON}}', JSON.stringify(relevantNpcs))
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
    if (next.elapsedMinutes >= 22) next.act = 3;
    else if (next.elapsedMinutes >= 9) next.act = 2;
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
    for (const clue of modelOutput.newClues) {
      if (!next.clues.includes(clue)) next.clues.push(clue);
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

app.get('/api/bootstrap', (_, res) => {
  res.json({
    scenario,
    state: scenario.initialState,
    opening: {
      narrative:
        "Chicago wakes under a low gray sky and a restless wind from the lake. Inside the Administration Building, messengers move at a near-run, telegraph slips change hands without ceremony, and Daniel Burnham stands over a desk scattered with shipping papers. He does not look up at once. When he finally does, there is strain in his face beneath the command. 'Something is wrong with the electrical consignments,' he says. 'And I do not mean delay. I mean interference.'",
      npcMoments: [
        {
          npc: 'daniel_burnham',
          text: "'I have no time for panic, and less for gossip. Bring me facts.'"
        }
      ],
      choices: [
        'Examine the shipping memorandum on Burnham\'s desk',
        'Ask Burnham who had access to the consignments',
        'Go at once to the freight yards'
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
        newClues: [
          'A shipping document contains duplicated initials in different handwriting.'
        ],
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
    return res.json({ output, nextState, mockMode: false });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Chicago 1893 server running on http://localhost:${PORT}`);
});
