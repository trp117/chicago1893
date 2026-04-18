Current game state:
{{STATE_JSON}}

Current location:
{{LOCATION_JSON}}

Relevant NPCs:
{{NPC_JSON}}

Player input:
{{PLAYER_INPUT}}

Instructions:
- Stay grounded in the current act and elapsed time.
- Update only the state fields that actually change this turn.
- Introduce at most one major new clue unless near the climax.
- If the player is stuck, inject a pressure event.
- Preserve continuity with discovered clues and prior accusations.
- Return valid JSON only, per the output contract.
