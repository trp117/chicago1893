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

Player input:
{{PLAYER_INPUT}}

Instructions:
- Stay grounded in the current act and elapsed time.
- Update only the state fields that actually change this turn.
- Only change the top-level `location` field if the player's input explicitly says they are moving somewhere. If the player asks a question or takes an action in the current location, do NOT change `location`.
- Introduce at most one major new clue unless near the climax.
- If the player is stuck, inject a pressure event.
- Preserve continuity with discovered clues and prior accusations — reference them naturally in the narrative.
- Do not reveal or hint at undiscovered clues unless the player's action would reasonably uncover them.
- If the player's action is consistent with discovering an available clue, include its ID in `newClues`.
- `newClues` must contain only valid clue IDs from the available clues list above — never invent new IDs.
- If `readyForClimax` is true in the ending signals, the story should be moving toward resolution.
- Return valid JSON only, per the output contract.
