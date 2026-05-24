# Scenario Authoring Guide

## briefing (required on every playerRole)

Per-character entry paragraph. 150–250 words, second person present tense. Places the player at the exact threshold of the story's opening moment from this character's perspective.

The briefing must:
- Place the character in a specific physical location at the story's opening moment
- Reference what this character knows that the others do not
- Establish their emotional and physical state right now (not backstory)
- End at the exact threshold of their first choice — the last breath before the player acts
- Match the literary voice of the scenario introduction sections

## Entry paragraph — first line rule

Never open with "You are [character name]" or any variation that names or introduces the character. The reader is already inside the character. Begin with physical placement — where they are standing, what their body is registering, what they can see or hear or smell right now.

WRONG: "You are Elias Cutter, standing in the dark behind the freight house..."
RIGHT: "You are standing in the dark behind the freight house with coal smoke..."

The first word of every entry paragraph should place the reader in a body at a specific location — not in an identity. This rule applies to both the `briefing` field on player roles and the `character_entries` inside the introduction entry section.

This text appears on the character introduction screen before the game begins and is written to the session transcript as the `## Character Brief` section. A missing briefing produces a blank section in every transcript for that character.

**Required for every character in every scenario.** A missing or too-short briefing (`< 50 chars`) will cause the scenario generation validator to reject the output before saving.

See `engine/data/scenarios/player_roles/dorothy_gill_role.json` for a reference implementation.

---

## period_vocabulary (optional but strongly recommended)

Defines period-specific language, slang, codes, and technical terminology that the
scene generation engine should use naturally during play. Terms are injected into the
system prompt and surfaced to the LLM on every turn.

Structure:
- `categories`: array of vocabulary groups
  - `name`: category label (e.g. "Telegraphers' Slang")
  - `context`: instruction for when and how to use these terms
  - `terms`: array of `{ term, meaning }` pairs

Terms should appear naturally in dialogue and prose — never explained directly to the
player. Context carries the meaning.

Add this field whenever a scenario has specialized language that would deepen
immersion. Every period and profession has its own vocabulary. The engine only uses
what is defined here.

A scenario without `period_vocabulary` defined produces no vocabulary block and no
error. A scenario with it defined gets the full block injected on every turn, after
the narrative style rules and before the arc position instruction.

---

## overused_anchors (optional)

A list of setting-specific sensory details and character gestures that are powerful once and deadening when repeated. The engine limits each to one use per session automatically.

Add this field whenever playtesting reveals a sensory detail or character gesture repeating across turns. It is discovered through playtesting, not designed upfront.

Format — plain language descriptions, not regex patterns:
- `"dispatch or packet pressing against the ribs or body"`
- `"smell of ink, linseed oil, tallow, or type metal"`
- `"spectacles picked up and not put on"`

Each future scenario should build its own list through playtesting. A Chicago 1893 scenario will have completely different anchors from a Boston 1775 scenario. The engine handles both through the same mechanism.

---

## Characters with aliases or cover identities

If any character in your scenario operates under more than one name
(undercover agents, characters in disguise, characters known
differently by different people), you MUST use the `aliases` field
in the player role schema.

The engine uses this field to:
1. Prevent the character appearing as two people in the same scene
2. Ensure other characters address the player by the correct name
3. Block NPC roster conflicts at story load time (throws a visible
   error in the admin panel and prevents the game from starting)

See `engine/data/scenarios/player_roles/margaret_vane_role.json`
as the reference implementation.

**Skipping this field for an alias character WILL cause the identity
split bug where the player appears as both themselves and an NPC
simultaneously.**

### Required fields on a player role with aliases

```json
{
  "is_player_character": true,
  "real_name": "The character's true name",
  "cover_name": "The name they use publicly tonight",
  "identity_note": "One sentence stating both names are the same person. Injected into every scene generation call.",
  "aliases": [
    {
      "name": "The alternate name",
      "type": "real_name | cover_name | nickname | title",
      "known_to": ["array of character IDs, 'player', or 'general_public'"]
    }
  ],
  "known_as": {
    "to_player": "How the player knows themselves",
    "to_character_id": "How that character addresses the player",
    "to_general_public": "How strangers know the player"
  }
}
```

### How the engine uses these fields

- **At server startup**: `SchemaValidator.validateIdentityIntegrity()` scans all
  scenarios and logs an error if any alias name appears in the NPC character
  roster. Check server logs on startup.

- **At story load** (`/game/api/start`): The same check runs and blocks the game
  from starting if a conflict exists, returning a 409 error.

- **In the system prompt**: `promptBuilder.js` injects the full verbatim identity
  rule block into every scene generation call when `playerRealName` and
  `playerCoverName` are set.

- **In every turn prompt**: `PromptComposer.buildAliasProtectionBlock()` adds a
  comprehensive identity protection block to every turn, for every scenario.

- **After each LLM response**: `validateSceneOutput()` in `gameRouter.js` scans
  the narrative for patterns that suggest an alias name is being written as a
  separate NPC. If detected, it retries automatically with a strengthened prompt.
  Two consecutive failures are logged for admin review.

### Adding an alias character in the admin UI

In the Player Roles editor, scroll to **ALTERNATE IDENTITIES** (yellow border).
This section is prominent — not collapsed — because missing it for an alias
character causes the identity split bug.

Fill in:
- Real name and cover name
- Check "This is the player character"
- Write a one-sentence identity note
- Add each alternate name with its type and who knows it

### NPC roster integrity

Never add a player character's real name, cover name, or any alias as a
standalone entry in `engine/data/characters/`. If a character IS the player,
they exist only in the player role file — not in the character roster.

The `hannah_cross.json` character file is kept with `"scenarioIds": []` as a
reference of the character's backstory. It is not loaded into any scenario's
NPC roster.

---

## Character type declarations

Every player role and NPC that appears in a Historical Record or epilogue
requires three fields:

```json
"character_type": "real",
"represents": "...",
"fact_checked": false
```

### character_type

One of three values:

- `"real"` — A documented historical person. The Historical Record must state 
  their verified post-event fate only. No invented biography.
- `"fictional"` — An invented character. The Historical Record must state the 
  category of real person they represent — never biography specific to the 
  fictional character.
- `"composite"` — Based on real people but not a specific individual. Treat 
  the same as `"fictional"` in the Historical Record.

### represents

Required for `fictional` and `composite` characters. States what category of 
real person this character represents. The field is used verbatim in Historical 
Record generation.

Write it as a complete phrase: *who* + *where* + *when*. 

**Wrong:** `"A soldier at Cantigny"`  
**Right:** `"Enlisted men of the 28th Infantry Regiment's Company C who participated in the initial assault wave at Cantigny on May 28, 1918"`

Leave blank for `real` characters (they represent themselves).

### fact_checked

`false` by default. Set to `true` after a human has verified the 
`character_type` and `represents` assignments against the historical record.

Use Admin → scenario edit → **Character Declarations** to export all 
character assignments as a formatted block. Paste into an external AI for 
batch verification, then mark each character verified in the admin UI.

### Health check behavior

- Player role missing `character_type`: blocking error (red)
- Fictional/composite role missing `represents`: blocking error (red)
- NPC in epilogue missing `character_type`: blocking error (red, Tier 1)
- Any named NPC missing `character_type`: yellow warning (Tier 2)
- Any character with `fact_checked: false`: yellow warning

---

## bridge_sentence (optional, recommended)

A single sentence — 15 words or fewer — that appears at the top of the
character entry screen (Screen 3) before the context sentence and entry prose.

```json
{
  "bridge_sentence": "The master alarm stopped screaming forty seconds ago."
}
```

**Purpose:** reactivates one specific physical detail from the scene paragraph
the player just read on Screen 2, dropping them into the character's immediate
present without repeating the scene.

Written by the author. Not generated. One physical detail. Present tense.
No explanation. The bridge sentence should be the first thing the player reads
as this character. It should feel like walking through a door.

**WRONG:** `"The situation is desperate and time is running out."` (vague, summarises)  
**WRONG:** `"Houston has just received the news about the oxygen tank."` (context, not physical)  
**RIGHT:** `"The master alarm stopped screaming forty seconds ago."` (specific, physical, immediate)

### Generation

Use Admin → role edit → **Generate draft** button to generate a `[DRAFT]` bridge
sentence via AI. The draft is saved with a `[DRAFT]` prefix. Remove the prefix
after author review to clear the warning.

### Health check behavior

- `bridge_sentence` containing `[DRAFT]` prefix: yellow warning (needs author review)

---

## context_sentence (required)

A single sentence — 20 words or fewer — that appears on the character entry screen (Screen 3) immediately below the bridge sentence and before the entry prose. This is the first moment the player understands who they are.

```json
{
  "context_sentence": "You are Jim Lovell, Mission Commander of Apollo 13, and you are reaching for the transmit switch with stiff, uncertain hands."
}
```

**Purpose:** places the player in an identity and an immediate physical or moral situation simultaneously. It is not a biography. It is not backstory. It is the character's situation in this specific second.

**Pattern:** `You are [name], [their role in this moment], and [what is happening to them right now].`

One clause: identity. One clause: immediate situation. Nothing else.

### What this sentence must NOT do

- Name historical facts about the character's life ("the most traveled astronaut in history")
- Explain what led to this moment ("who replaced Ken Mattingly three days before launch")
- Reference events outside the immediate present ("after the oxygen tank explosion")
- Summarize themes ("facing an impossible choice")

### Benchmark set — nine sentences across three historical registers

Every correct context sentence should be evaluable against this set. The three registers — mechanical crisis, moral stillness, physical survival — demonstrate what the standard looks like when the historical moment changes completely.

---

#### Mechanical crisis — Apollo 13: Lifeboat

```
"You are Jack Swigert, the Command Module Pilot, and you are systematically killing your own ship before it kills you."
```
*Identity: his role aboard the spacecraft. Situation: the controlled power-down — an action that is its own kind of violence.*

```
"You are Gene Kranz, Flight Director, and the loop is waiting for an answer you don't have yet."
```
*Identity: his position in Mission Control. Situation: the open comm loop — twenty engineers waiting in silence.*

```
"You are Jim Lovell, Mission Commander of Apollo 13, and you are reaching for the transmit switch with stiff, uncertain hands."
```
*Identity: his rank and mission. Situation: a single physical gesture — the cold, the hesitation, the weight of what he is about to say.*

---

#### Moral stillness — Greensboro Four: The Color Line

```
"You are Joseph McNeil, seated at the Woolworth's lunch counter, and the floor walker is tightening his orbit around your stool."
```
*Identity: his name and physical location. Situation: a body in space being circled — the floor walker's route has become surveillance.*

```
"You are Franklin McCain, the largest body at this counter, and the man in the brown jacket has just taken another half-step closer."
```
*Identity: his physical presence as its own fact. Situation: a distance closing — the threat is measured in increments.*

```
"You are Ezell Blair Jr., the one who asked for the coffee, and no one has answered you."
```
*Identity: the act that started everything. Situation: the silence that answered it — still ongoing, still unresolved.*

---

#### Physical survival — Dog Green: The Longest Morning

```
"You are the Coxswain of LCA-551, and the ramp is dropping right now into water you know is too deep."
```
*Identity: his vessel and function. Situation: an irreversible mechanical action — the ramp drops whether he is ready or not.*

```
"You are the Ranger Sergeant, and the tide is at your waist with the Bangalore across your knees and fifty yards of open sand ahead."
```
*Identity: his rank and unit. Situation: a body in water holding a tool, with a specific distance between him and the objective.*

```
"You are the Battalion Medic, and the man dying in your hands is not the man you need to reach."
```
*Identity: his role. Situation: a triage choice already made — the wrong man is in his hands and the right one is somewhere else.*

---

**What the benchmark set demonstrates:** the second clause is always a physical or situational fact, never an emotion or a theme. "The ramp is dropping" is an action underway. "No one has answered you" is a condition, not a feeling. "Tightening his orbit" is movement in space. The sentence never tells the player what to feel — it places them in a body, at a specific moment, with something already happening.

### Generation

Use Admin → role edit → **Generate context sentence** button to generate a draft via AI. Review against this benchmark set before publishing. The generated sentence should pass the same test: one identity clause, one immediate-situation clause, no biography, no history.

### Health check behavior

- Empty `context_sentence`: yellow warning

---

## Entry paragraph benchmark — Singing Wires: Elias Cole

The following `briefing` is the quality benchmark for the entry paragraph field. It is included alongside the context sentence benchmarks because it demonstrates what the standard looks like at the prose level — the same three registers (mechanical crisis, moral stillness, physical survival) condensed into a single character at a single threshold.

What makes this paragraph the benchmark:
- Opens with a body in a specific physical position, not an identity
- The character's situational knowledge is shown through what he perceives, not explained
- The threat is embedded in sensory detail (the wire's pitch, the unlit lantern)
- The player inherits a decision already formed — they are at the threshold, not approaching it
- The final sentence is the last breath before the first choice

```
You are standing in the Huron River bottomland with your back against an elm tree and seven people within arm's reach in the dark, the two children pressed against their mother's side and quiet in the way that children learn to be quiet when quiet means survival. The telegraph wire runs along the road thirty yards to your left, and it is singing tonight — a low, tuneless chord in the northeast wind that you have come to read the way other men read weather. Something in the wire's pitch has changed in the last hour, or you have told yourself it has, which amounts to the same thing when you are responsible for seven lives and the shore is still a mile and a half north. You received a warning twenty minutes ago from a gandy dancer's boy on a fast horse — the sheriff is coming, or someone is coming, and the boy did not know more than that. What you know that no one else in this story knows is that the last three groups you moved were watched from inside the network, and that the watching came from someone who knew the departure times exactly. You have said nothing because you had no proof. Tonight you have seven people including two children who are asleep on their feet, a shore road that may be watched, and a barn that may or may not be safe to enter. The lantern in the Voss barn window is not lit, which means either the station is secure and waiting for your signal, or it means something has already gone wrong. You are standing at the edge of the tree line looking at the dark shape of the barn, and you must decide in the next sixty seconds whether to move your passengers forward or take the long way around through the rail yard ballast toward the waterfront path.
```

*Scenario: Singing Wires. Role: Elias Cole — The Conductor. Field: `briefing`.*
