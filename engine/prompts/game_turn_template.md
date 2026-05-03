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

Narrative style for this session: {{NARRATIVE_STYLE}}

Player input:
{{PLAYER_INPUT}}

⚠️ DIALOGUE CHECK: If any NPC appears in this scene, their spoken words MUST appear in the narrative as quoted dialogue. Body language alone is not acceptable. At minimum one spoken line is required.

⚠️ NPC-TO-NPC CHECK: If two or more NPCs are present and one asks the other a question, the questioned NPC MUST answer before the turn ends.

⚠️ ESCALATION CHECK: For each NPC present, review their aggressionProfile. If an NPC's fleeCondition is met, you MUST output chaseInitiated. If their strikeFirst condition is met, you MUST output physicalConflict with type "npc_struck_first". These are mandatory when conditions are satisfied.

⚠️ BREAKING POINT CHECK: For each NPC with suspicion 2 or higher, locate their breakingPoint. It is a hard ceiling — what this NPC will never reveal regardless of pressure. No NPC dialogue may cross it.

⚠️ NPC_UPDATES REQUIRED: For every NPC who appears in this scene, include their id in npc_updates with trust_delta, aggression_mode, and last_interaction. This is mandatory — do not omit npc_updates if any NPC is present.

{{NPC_INTRO_INSTRUCTION}}

Instructions:
- Apply NPC information tier strictly by suspicion score. Tier 1 (0–1): surface demeanor only. Tier 2 (2–3): partial detail. Tier 3 (4+): specific facts. Tier can only advance mid-scene if the player references a specific discovered clue.
- Stay grounded in the current act and elapsed time.
- Update only the state fields that actually change this turn.
- Only change the top-level `location` field if the player's input explicitly says they are moving somewhere.
- If you change `location` this turn, the narrative must begin at the new location — do NOT include dialogue or reactions from NPCs at the previous location.
- Introduce at most one major new clue unless near the climax.
- If the player is stuck, inject a pressure event from the scenario's pressureEvents list.
- Only include a clue ID in `newClues` if the player's action directly and specifically uncovers it — physical examination, an NPC explicitly revealing it, or direct observation. A confrontation alone does NOT automatically award clues.
- `newClues` must contain only valid clue IDs from the available clues list above.
- If `readyForClimax` is true in the ending signals, steer toward resolution.
- Return valid JSON only, per the output contract.
