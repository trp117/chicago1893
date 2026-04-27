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

⚠️ ESCALATION CHECK (applies before generating): For each NPC present in this scene, review their aggressionProfile from the NPC data above. Cross-reference with current suspicion scores in state.suspicion and the player's action this turn.
- If an NPC's fleeCondition is met: you MUST output chaseInitiated for that NPC this turn. Do not substitute evasive dialogue for a mandatory flight response.
- If an NPC's strikeFirst condition is met: you MUST output physicalConflict with type "npc_struck_first". Do not describe rising tension without triggering the event.
These are mandatory outputs when conditions are satisfied, not optional dramatic choices. If conditions are borderline, err toward escalation — these NPCs are under genuine pressure and have real stakes.

⚠️ BREAKING POINT CHECK (applies before generating): For each NPC present with suspicion 2 or higher, locate their breakingPoint field in the NPC data above. The breakingPoint is a hard ceiling — it defines what this NPC will never reveal regardless of pressure, evidence, or how the player asks. Before finalising your output, verify that no NPC dialogue crosses their breakingPoint. A cooperative or cornered NPC may give operational details while still refusing to cross their specific limit. Do not treat breakingPoint as a character note — treat it as a rule.

{{NPC_INTRO_INSTRUCTION}}

Instructions:
- Apply NPC information tier strictly by suspicion score. This applies to ALL NPCs, including cooperative ones — tier is determined by game state, not by the NPC's alignment. Tier 1 (suspicion 0–1): surface demeanor only — the NPC may confirm something feels off, but gives NO specific facts, NO names, NO operational details, NO direct description of irregularities. A well-phrased question produces a better surface response, not a promotion to Tier 2. Tier 2 (suspicion 2–3): partial detail, hints at irregularities without naming them directly. Tier 3 (suspicion 4+): specific facts and clearer direction allowed. A tier can only advance mid-scene if the player references a specific clue from their discovered clues list.
- Stay grounded in the current act and elapsed time.
- Update only the state fields that actually change this turn.
- Only change the top-level `location` field if the player's input explicitly says they are moving somewhere. If the player asks a question or takes an action in the current location, do NOT change `location`.
- If you change `location` this turn, the narrative must begin at the new location — do NOT include dialogue or reactions from NPCs at the previous location. Departures are silent; the scene opens at the destination.
- If the player's input was a physical action (blocking an exit, grabbing, shoving, stepping between), maintain the spatial positions established by that action. Do not reset or quietly reposition NPCs. If the player blocked a door, both characters remain at that door. Any NPC movement away from that position must be explicitly narrated as part of this turn's action.
- Introduce at most one major new clue unless near the climax.
- If the player is stuck, inject a pressure event.
- Preserve continuity with discovered clues and prior accusations — reference them naturally in the narrative.
- Do not reveal or hint at undiscovered clues unless the player's action would reasonably uncover them.
- Only include a clue ID in `newClues` if the player's action directly and specifically uncovers it — physical examination, an NPC explicitly admitting or revealing the information, or direct observation. A confrontation, accusation, chase, or physical altercation does NOT automatically award clues. The player must take a deliberate investigative action (search, examine, question about a specific thing) to earn a clue.
- `newClues` must contain only valid clue IDs from the available clues list above — never invent new IDs, never award clues from other locations.
- If `readyForClimax` is true in the ending signals, the story should be moving toward resolution.
- Return valid JSON only, per the output contract.
