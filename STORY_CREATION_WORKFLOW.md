# Story Creation Workflow
## How to Build a Scenario at Publication Quality

This document describes the workflow that produced `dog_green_sector`, 
`singing_wires`, and `midnight_errand_boston`. Follow it in order. 
Do not skip steps.

---

## The Standard

Every scenario should meet this test before it is considered complete:

> Play one full session as each role. The closing prose for each 
> character should be specific enough that you could not mistake it 
> for any other character in any other story.

If the closing prose could belong to anyone, the scenario is not finished.

---

## Phase 1 — Historical Research and Source Material

This phase happens before the generation engine is touched.

### 1.1 Choose the moment

Pick a specific historical moment — not a war, not an era, but a 
specific night, morning, or hour. The more specific the better.

Good: *0630 hours, June 6 1944, Dog Green Sector, Omaha Beach*  
Too broad: *World War Two, D-Day*

The moment must have:
- A fixed historical outcome the player cannot change
- Real human stakes that feel personal, not strategic
- At least three distinct vantage points with different information

### 1.2 Research with AI assistance

Use Claude or another AI to research the moment. Ask for:

```
Research [specific moment]. I need:
1. What was actually happening at the ground level — 
   not the strategic picture, the human experience
2. The specific vocabulary professionals used — 
   military, medical, trade, period slang
3. The sensory details — what it smelled like, 
   sounded like, felt like
4. The specific decisions individuals faced and 
   what was at stake in each one
5. What most accounts get wrong or leave out
```

Take notes on everything specific — names, times, distances, 
smells, sounds, technical terms. Specificity is what makes the 
difference between atmosphere and immersion.

### 1.3 Write the source document

Before touching the admin, write a plain text document covering:

**The Historical Backdrop** — 2-3 paragraphs. What is happening 
at the macro level. Real names, real units, real stakes. Written 
like a history book, not a game brief.

**Three Perspectives** — Each perspective must have:
- A specific function in the event (not just "a soldier")
- Information the other two do not have
- A decision only they can make
- A reason they cannot simply leave

**The Tension** — For each perspective: what is the specific 
problem they face right now, at this minute?

**The Decision Point** — For each perspective: what is the 
choice that defines their session?

**Period Vocabulary** — Every specialized term used by people 
in this world. Organized by category. Include:
- Professional jargon (medical, military, trade)
- Period slang
- Code words or euphemisms used by the group
- Technical terms for equipment and procedures

**Potential Outcomes** — Three endings:
- Success with cost
- Partial success with specific loss
- Failure with specific consequence

This document is what you paste into the story generation engine. 
The quality of this document determines the quality of the scenario.

---

## Phase 2 — Story Generation

### 2.1 Generate the scenario

Go to Admin → New Story. Paste your source document into the 
generation prompt. Use these settings:

- Historical Realism: High
- Play Time: Match your source material (30 min for a single 
  tense hour, 60 min for a longer arc)
- Enable Introduction: Yes
- Skippable: Yes

Submit. Generation takes 3-8 minutes for a 30-minute scenario.

### 2.2 Immediate post-generation checks

When generation completes, check these fields before doing 
anything else:

```
[ ] Title and Scenario ID are correct
[ ] World section is historically grounded (not generic)
[ ] Stakes section is personal, not just strategic
[ ] Scene section has specific sensory detail
[ ] Three roles are generated with distinct perspectives
[ ] Characters have specific voices, not generic NPCs
[ ] Locations have atmosphere, not just descriptions
[ ] Period vocabulary was generated (check JSON)
```

If any of these are weak, note them for repair — do not 
regenerate the whole scenario.

### 2.3 Add missing fields manually

These fields are often blank after generation. Fill them in 
the admin before proceeding:

- **Setting** — Format: *City/Location, Year* 
  (e.g. "Sandusky, Ohio, 1853")
- **Premise** — One sentence. What is the situation.
- **Player Goal** — One sentence. What success looks like.
- **Opening Situation** — Two or three sentences. 
  What has already happened before the player enters.
- **Tone** — Comma-separated. 
  (e.g. "tense, moral, dangerous, intimate")

### 2.4 Run the health check

Go to Admin → Stories. Find your scenario. The health dot 
should show the current status:

- 🟢 Green — scenario is complete
- 🔴 Red — required fields are missing

Click the dot to see what is missing. Click Repair to 
generate missing content automatically.

### 2.5 Review and repair entry paragraphs

The entry paragraphs are the most important generated content. 
Read each one carefully.

**The standard:** The first sentence must place the reader 
inside a body at a specific location. It must not begin with 
"You are [character name]."

**Wrong:** *"You are Elias Cutter, a veteran conductor..."*  
**Right:** *"You are standing at the edge of the elm grove 
with the Huron bottomland mud cold through the seams of 
your boots..."*

If any entry paragraph fails this test, clear it in the JSON 
and click Repair to regenerate.

---

## Phase 3 — Authoring the Ending Notes

This phase cannot be automated. You must write it.

### 3.1 Enable Structured Endings

On the scenario edit page, set Structured Endings to Enabled. 
This tells the engine to use your notes for partial and failure 
endings. Success always generates from the session transcript 
and should not have notes.

### 3.2 Write ending notes for each role

Go to each player role edit page. Under Ending Notes, 
fill in Partial and Failure for each role.

**What to write — plain language only:**

You are not writing prose. You are writing notes that the 
engine will turn into prose. Write what happened, who was 
there, and what it cost. Three or four sentences is enough.

**What Happened** — The specific outcome. What did this 
character do or fail to do? Be concrete.

```
Good: "Nathaniel is shot by a soldier before reaching 
      the Green Dragon. A stranger finds him. He passes 
      the dispatch as he is dying."

Too vague: "Nathaniel failed to deliver the dispatch 
           and was captured."
```

**Who Was Present** — Which characters or NPCs were there 
at the end. This affects who appears in the closing scene.

**Emotional Weight** — The specific feeling this ending 
carries. Not "sadness" — what specific thing does the 
character understand or carry forward?

```
Good: "He is not afraid. He is sorry he will not see 
      Benjamin's face when he finds out what his son 
      did tonight."

Too generic: "He feels sad about what happened."
```

**Closing Line Override** — One strong sentence that 
replaces "You were there." Leave blank to use the default.

```
Good: "The dispatch arrived. Nathaniel Gill did not."
Good: "The cold Atlantic rushed in to meet the fire, 
      and then there was only the sound of the waves."
Too generic: "He gave everything he had."
```

### 3.3 The closing line test

Read your closing line override aloud. It should:
- Be specific to this character and this ending
- Not be usable in any other scenario
- Land with weight — like the last line of a novel

If it could appear in any story about any war or any night, 
rewrite it until it could only belong here.

---

## Phase 4 — Period Vocabulary

### 4.1 Add vocabulary to the scenario JSON

Open the scenario root JSON file in VS Code. Add the 
`period_vocabulary` field with categories from your 
research document.

Structure:
```json
{
  "period_vocabulary": {
    "categories": [
      {
        "name": "Category Name",
        "context": "When and how to use these terms — 
                   never explain them directly, let 
                   context carry the meaning.",
        "terms": [
          {
            "term": "the term",
            "meaning": "what it means"
          }
        ]
      }
    ]
  }
}
```

**Guidelines:**
- Create one category per professional world represented 
  (medical, military, trade, period slang, network codes)
- Include terms that characters would use naturally, 
  not terms that need explanation
- The more specific the term, the better — generic period 
  language is less valuable than professional jargon

### 4.2 Validate the JSON

After editing, always validate:

```powershell
node -e "
JSON.parse(require('fs').readFileSync(
  'engine/data/scenarios/[scenario_id].json','utf8'
)); 
console.log('valid')
"
```

If it throws an error, fix the syntax before proceeding.

---

## Phase 5 — Testing

### 5.1 Play each role once before considering the scenario complete

Play all three roles. For each session note:

```
[ ] Entry paragraph placed me inside the character immediately
[ ] Period vocabulary appeared naturally in the prose
[ ] The arc felt shaped — opening breathed, final arc converged
[ ] The closing prose was specific to this character and session
[ ] The closing line landed
[ ] No moment pulled me out of the historical world
```

### 5.2 Specifically test a failure ending

On at least one role, play to a deliberate failure. Make 
choices that logically lead to the failure condition in 
your ending notes. Read the closing screen carefully:

```
[ ] The closing prose reflects your ending notes
[ ] Specific details from your notes appear in the prose
[ ] The closing line override is rendering correctly
[ ] The prose feels different from a success ending — 
    not worse, but different in emotional register
```

### 5.3 Run the transcript reviewer

After 3-5 sessions:

```bash
npm run review [scenario_id]
```

Read the report. If any anchor appears as HIGH PRIORITY, 
add it to `overused_anchors` in the scenario JSON.

### 5.4 Commit when complete

When all three roles pass the test:

```bash
git add engine/data/scenarios/
git commit -m "feat: [scenario_id] — complete with vocabulary, 
              ending notes, and entry paragraphs"
```

---

## Phase 6 — Quality Markers

A scenario is complete when it meets all of these:

**Structural completeness:**
- Health check shows green
- All three entry paragraphs pass the first-sentence test
- Period vocabulary has at least 3 categories and 15 terms
- Ending notes written for partial and failure on all roles
- Setting field populated
- Structured Endings enabled

**Prose quality:**
- Opening scene places the reader inside a body in 
  a specific historical moment within the first paragraph
- Period vocabulary appears naturally in at least 3 turns
- The closing prose for each role is unrepeatable — 
  specific enough that it could not belong to any other 
  character

**Historical integrity:**
- The fixed historical outcome is not changeable
- The human cost is real and specific
- Period details are accurate enough that a reader who 
  knows the history will recognize them

---

## Reference Scenarios

Study these as examples of the standard:

**`midnight_errand_boston`** — The foundational scenario. 
Strong character interiority. Benjamin Gill is the model 
for how NPCs should work. The Dorothy Gill closing prose 
("the measuring was never caution") is the benchmark 
for success endings.

**`singing_wires`** — Best entry paragraphs. Thomas Cole's 
entry ("You pick up the key.") is the model for threshold 
writing. The period vocabulary for 1850s telegraph culture 
is the benchmark for the vocabulary system.

**`dog_green_sector`** — Best overall scenario construction. 
The Medic's clinical language as psychological armor is the 
model for character perspective. The ending notes closing 
lines are the benchmark for the override system.

---

## Common Mistakes

**Generating too quickly** — The source document is the 
most important step. A weak source document produces a 
weak scenario regardless of how good the engine is. 
Spend more time on Phase 1 than any other phase.

**Skipping ending notes** — The structured endings system 
only works when the notes are specific. Generic notes 
produce generic prose. Write the emotional weight as if 
you are writing the last line of the story — because 
with the closing line override, you are.

**Not validating JSON after edits** — A single missing 
comma will break the scenario silently or crash the 
repair tool. Validate after every manual JSON edit.

**Playing to success only** — The failure and partial 
endings are where the most interesting prose lives. 
Test them.

**Adding features before finishing the scenario** — 
The scenario is not done until all three roles have 
been played and the closing prose is specific. 
Do not move to a new scenario until the current one 
meets the standard.

---

*Last updated: May 2026*  
*Reference scenarios: midnight_errand_boston, 
singing_wires, dog_green_sector*
