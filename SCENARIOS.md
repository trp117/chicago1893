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
