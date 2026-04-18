# Chicago 1893 — Interactive Story V1

A starter kit for an AI-driven historical thriller set during the 1893 World's Columbian Exposition in Chicago.

## Concept
The player is the assistant to Daniel Burnham. In the days before the fair opens, they uncover signs of a conspiracy to sabotage the exposition so it will not eclipse Paris's 1889 Exposition Universelle.

This V1 is designed as a **30-minute guided narrative** with:
- high historical grounding
- a limited cast of NPCs
- a small set of core locations
- a clear win/lose condition
- dynamic free-text player input

## What is included
- `prompts/system_prompt.md` — Claude-ready world/narrative prompt
- `prompts/turn_prompt_template.md` — per-turn prompt wrapper
- `data/scenario.json` — scenario rules, pacing, victory conditions
- `data/npcs.json` — NPC goals, voice, secrets, suspicion logic
- `data/locations.json` — locations, mood, clues, linked NPCs
- `server/server.js` — Node/Express starter backend for Anthropic API
- `src/index.html` — simple browser UI
- `src/styles.css` — basic styling
- `src/app.js` — frontend game loop
- `.env.example` — environment variable template

## Recommended architecture

### Narrative structure
Use a **guided story with the illusion of openness**.

The player can type anything, but the engine should pace the experience:
- Act I (0–25%): setup, first clue, first suspect
- Act II (25–70%): investigation, pressure, misdirection, stakes rise
- Act III (70–100%): confrontation, sabotage trigger, climax, resolution

### Core gameplay loop
1. Player enters an action or dialogue.
2. Backend composes the full prompt using:
   - world rules
   - current state
   - relevant NPC/location data
   - player input
3. Claude returns structured JSON:
   - narrative text
   - NPC dialogue/actions
   - state updates
   - suggested choices (optional)
4. Frontend updates the UI.
5. Time, threat, and suspicion advance.
6. Trigger events fire when thresholds are met.

## Install

```bash
npm install
```

Then copy `.env.example` to `.env` and add your Anthropic key.

```bash
cp .env.example .env
```

## Run

```bash
node server/server.js
```

Then open `src/index.html` in a browser or serve it locally.

## Anthropic API notes
The backend expects `ANTHROPIC_API_KEY` in `.env`.

This starter uses the Messages API. Adjust the model name in `server/server.js` as needed.

## Output format contract
The system prompt asks Claude to return JSON only:

```json
{
  "narrative": "...",
  "timeAdvance": 4,
  "stateChanges": {
    "threat": 1,
    "trust": { "daniel_burnham": 1 }
  },
  "newClues": ["..."],
  "location": "administration_building",
  "npcMoments": [
    {"npc": "daniel_burnham", "text": "..."}
  ],
  "choices": ["Ask Burnham about the missing manifests", "Go to the French pavilion"]
}
```

## V1 design constraints
- no modern slang
- no graphic violence
- keep the cast small
- every scene must either reveal information, increase tension, or force a decision
- the player must be able to win, fail, or partially succeed within 30 minutes

## First playtest target
A successful first playtest should show:
- believable 1893 tone
- NPCs that feel intentional rather than random
- visible escalation by minute 10–12
- a climax by minute 25–28
- a clean ending by minute 30

## Suggested next build steps
1. Wire up the backend with your Anthropic key.
2. Play through with placeholder choices.
3. Tune pacing thresholds in `scenario.json`.
4. Tighten NPC motives and secrets in `npcs.json`.
5. Add save/load state once the core loop feels right.
