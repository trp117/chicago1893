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

Ending readiness signals:
{{ENDING_SIGNALS_JSON}}

{{LOCATION_CONSTRAINT}}

{{VERIFIED_FACTS}}

{{OBJECT_STATE}}

{{RESOLVED_THREADS}}

Narrative style for this session: {{NARRATIVE_STYLE}}

Player input:
{{PLAYER_INPUT}}

⚠️ DIALOGUE CHECK: If any NPC appears in this scene, their spoken words MUST appear in the narrative as quoted dialogue. Body language alone is not acceptable. At minimum one spoken line is required.

⚠️ NPC-TO-NPC CHECK: If two or more NPCs are present and one asks the other a question, the questioned NPC MUST answer before the turn ends.

⚠️ ESCALATION CHECK: For each NPC present, review their aggressionProfile. If an NPC's strikeFirst condition is met, you MUST output physicalConflict with type "npc_struck_first". This is mandatory when the condition is satisfied.

⚠️ BREAKING POINT CHECK: For each NPC with suspicion 2 or higher, locate their breakingPoint. It is a hard ceiling — what this person cannot or will not disclose given their role and documented orders. No NPC dialogue may cross it.

⚠️ NPC_UPDATES REQUIRED: For every NPC who appears in this scene, include their id in npc_updates with trust_delta, aggression_mode, and last_interaction. This is mandatory — do not omit npc_updates if any NPC is present.

⚠️ DIALOGUE ATTRIBUTION: Use the character's `name` field for all dialogue tags in the narrative (e.g., "Lovell:" not "char_jim_lovell:"). The `id` field belongs in system output fields (npc_updates, npcMoments) only — never in narrative prose.

{{SENSORY_OPENING_CHECK}}

{{NPC_INTRO_INSTRUCTION}}

Instructions:
- Apply NPC information tier strictly by suspicion score. Tier 1 (0–1): surface professional demeanor — role and observable facts only. Tier 2 (2–3): operational detail shared as the player demonstrates competence and situational awareness. Tier 3 (4+): specific technical facts and the NPC's own doubts or concerns. Tier can only advance mid-scene if the player demonstrates understanding or references specific evidence from earlier in the session.
- Stay grounded in the current act and time of night.
- Update only the state fields that actually change this turn.
- Only change the top-level `location` field if the player's input explicitly says they are moving somewhere.
- If you change `location` this turn, the narrative must begin at the new location — do NOT include dialogue or reactions from NPCs at the previous location.
- If the player is stuck, inject a pressure event from the scenario's pressureEvents list.
{{CLOSING_INSTRUCTION}}
- Return valid JSON only, per the output contract.

⚠️ NARRATION CONSTRAINT: The physical detail is always sufficient. Never write a sentence of narration that explains what a scene means. Never write narration that names what the player character has learned or understood about themselves in abstract terms. If you find yourself writing a sentence that begins with "he understood," "what this meant," "the truth was," or any equivalent formulation, delete it and return to the physical. The image does the work. The sentence that explains the image undoes it.
This constraint applies to narration only — the second-person narration describing what the player character does, feels, and notices. It does not apply to NPC dialogue. A named historical character may say something that carries meaning; that is characterization, not editorializing. What is prohibited is the narration layer explaining or amplifying what an NPC's line meant after the line has been delivered. The dialogue speaks. The narration does not summarize it.
