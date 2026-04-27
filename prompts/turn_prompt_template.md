PLAYER ROLE (maintain this perspective for the entire turn — do not override):
{{PLAYER_ROLE_SECTION}}

Current game state:
{{STATE_JSON}}

Current location:
{{LOCATION_JSON}}

Relevant NPCs:
{{NPC_JSON}}

NPC locations (use to set the top-level location field when the player moves to find someone):
{{NPC_ROUTES_JSON}}

Clues the player has already discovered:
{{DISCOVERED_CLUES_JSON}}

Clues available at this location (not yet discovered):
{{AVAILABLE_CLUES_JSON}}

Ending readiness signals:
{{ENDING_SIGNALS_JSON}}

{{LOCATION_CONSTRAINT}}

{{PREV_CONTEXT}}

Narrative style for this session: {{NARRATIVE_STYLE}}

Player input:
{{PLAYER_INPUT}}

⚠️ DIALOGUE CHECK (applies before generating): If any NPC appears in this scene, their spoken words MUST appear in the narrative as quoted dialogue — e.g. Burnham: "Get to the point." Body language alone (*he looks up*, *his jaw tightens*) is not acceptable. At minimum one spoken line is required.

⚠️ NPC-TO-NPC CHECK (applies before generating): If two or more NPCs are present and one asks the other a question, the questioned NPC MUST answer before the turn ends. Never end the turn on an unanswered NPC-to-NPC question — the player must not be left waiting for an exchange that has no resolution. Structure: question → answer → player choices. One exchange only.

{{NPC_INTRO_INSTRUCTION}}

Instructions:
- Stay grounded in the current act and elapsed time.
- Update only the state fields that actually change this turn.
- Only change the top-level `location` field if the player's input explicitly says they are moving somewhere. If the player asks a question or takes an action in the current location, do NOT change `location`.
- If you change `location` this turn, the narrative must begin at the new location — do NOT include dialogue or reactions from NPCs at the previous location. Departures are silent; the scene opens at the destination.
- Introduce at most one major new clue unless near the climax.
- If the player is stuck, inject a pressure event.
- Preserve continuity with discovered clues and prior accusations — reference them naturally in the narrative.
- Do not reveal or hint at undiscovered clues unless the player's action would reasonably uncover them.
- Only include a clue ID in `newClues` if the player's action directly and specifically uncovers it — physical examination, an NPC explicitly admitting or revealing the information, or direct observation. A confrontation, accusation, chase, or physical altercation does NOT automatically award clues. The player must take a deliberate investigative action (search, examine, question about a specific thing) to earn a clue.
- `newClues` must contain only valid clue IDs from the available clues list above — never invent new IDs, never award clues from other locations.
- If `readyForClimax` is true in the ending signals, the story should be moving toward resolution.
- Return valid JSON only, per the output contract.
