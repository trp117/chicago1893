Audit and fix initial load performance — the app loads too slowly:
Step 1 — Diagnose first, fix second.
Run a performance audit and identify the actual bottlenecks before changing anything. Check for:

Bundle size — Run npm run build and report the output chunk sizes. Flag any chunk over 100kb uncompressed. Identify what is in the largest chunks.
API calls on load — Trace what happens from the moment the page loads to when the user sees the role selection screen. List every API or database call that fires, in order, and whether any are sequential (waterfall) when they could be parallel.
LLM warm-up — Is the first Claude API call happening before the user even makes a choice? If the app is pre-generating anything on load, report what and why.
Railway cold starts — The app is hosted on Railway. Check if the server is sleeping between requests (free/hobby tier cold start). Report whether this is likely a cold start issue vs. a runtime performance issue — they have different fixes.
Fonts and assets — Check if custom fonts (likely a serif for the game aesthetic) are blocking render. Check if any images or audio assets are loading eagerly that could be lazy-loaded.
Scenario data loading — How and when is the scenario config loaded? Is it blocking the initial render?


Step 2 — Apply fixes based on findings, likely candidates:

Parallelize any sequential API calls on load — scenario config, user session, and any initial data fetches should fire simultaneously with Promise.all, not one after another
Add a loading state immediately — the UI should render a skeleton or styled loading screen within 200ms so the user knows something is happening, even if data isn't ready
Lazy load the game engine — the scenario selection screen and the game engine are separate phases; don't load game engine code until a scenario is selected
Pre-warm the LLM connection — if the first Claude API call is slow, consider sending a minimal warm-up request (or streaming the first scene generation) as soon as the user hits Begin, not after
Cache scenario config — scenario JSON/config should be cached at the edge or in memory after first load, not fetched fresh every session
Check Railway tier — if on a hobby plan, upgrade to a paid instance or configure the app to stay warm with a simple ping endpoint. Cold starts on Railway hobby can add 3–8 seconds to first load.
Code split by route — ensure the stories list page, role selection page, and game page are separate chunks so the browser only loads what it needs for the current screen

Report what you find in Step 1 before applying fixes so the changes are targeted, not speculative.You said: the mobile interface brings up the submit and options and cuts the narrative copy off upon load.the mobile interface brings up the submit and options and cuts the narrative copy off upon load.  see attached.  give prompt to fix2:40 PMClaude responded: Here's your Claude Code prompt:Here's your Claude Code prompt:

Fix mobile layout — narrative text is being cut off by the input/action area on load:
The problem:
On mobile, when the game screen loads, the "YOUR MOVE" input, Submit button, and "OR CHOOSE" action options are visible but the narrative text above is cut off mid-sentence. The player cannot read the scene before being prompted to act. The input/action area is consuming too much of the viewport on load.
The fix:
The game screen should load with the narrative text as the primary focus. The input and action options should be accessible but should not dominate or obscure the story content on initial load.
Specific changes:

Narrative text area should be the default scroll position — on load, scroll position should be at the top of the narrative, not at the input field. Do not auto-focus the input on mobile as this triggers the keyboard and pushes content up.
Remove auto-focus on the text input on mobile — detect if the user is on a mobile device and suppress autofocus on the "What do you say or do?" field. Auto-focus on mobile pulls the keyboard up immediately and collapses the visible viewport, burying the narrative.
The action area (YOUR MOVE + OR CHOOSE) should be collapsed or minimal on load — consider one of these approaches:

Make the action area a sticky footer that sits at the bottom at a fixed/minimal height on load, and expands when the user taps it
Or simply ensure the narrative text area takes up the majority of the screen and the user naturally scrolls down to the input when ready
The OR CHOOSE options should not be visible until the user scrolls to them or taps to expand — they should not push content off screen on load


On load, scroll the narrative container to the most recent text — the newest narrative paragraph should be visible, not cut off. After new content is added, scroll the narrative div to show the latest content from the top of that addition, not from the input field upward.
Viewport height fix — use height: 100dvh (not 100vh) on the main game container to account for mobile browser chrome (address bar, bottom nav). This prevents the layout from being taller than the actual visible area.
Test at 390px width (iPhone 14) and 360px width (Android) — at both sizes, on load the user should see at minimum 3–4 lines of narrative text before any UI chrome. The input and action options should require a deliberate scroll or tap to reach.

Do not change the desktop layout. Apply all mobile fixes within @media (max-width: 768px) or equivalent mobile breakpoint.You said: the story leaves very little context as to what is happening and drops right an interactive moment.the story leaves very little context as to what is happening and drops right an interactive moment.  I would like an introduction to each story, that sets the stage, think of as if this was historical fiction click citizen washington or colorfully written history like Joseph Ellis or David McCullough.  What is happening in the world that brought the characters to their scene, why is what they are doing important, dangerous, romantic, thrilling, etc.  This intro will not have interaction, but create the place, tension and feeling.  What is Boston in 1773, what is at stake  This introdocution Act or chapter should have an option to skip.  How can we do this?2:48 PMClaude responded: Here's your Claude Code prompt:Here's your Claude Code prompt:

Add a non-interactive story introduction — a narrative "prologue" screen before gameplay begins:
The concept:
Before the player makes any choices, they experience a rich, authored introduction — written in the style of David McCullough or Joseph Ellis — that establishes the world, the stakes, the danger, and the feeling of the moment. This is not gameplay. It is the opening chapter of a book. It ends with a "Begin" button (and a "Skip" option for returning players).

Part 1: The introduction screen itself
Create a new screen/route that appears after role selection and before the first interactive scene. It should:

Display as a full-page reading experience — black background, serif font, generous line height, comfortable reading width (max ~680px centered)
Have a subtle header with the story title and year (e.g. Midnight Errand — Boston, 1775)
Render the introduction text in paragraphs, styled like a book page — no UI chrome, no input, no choices
Have a fixed bottom bar with two options: a prominent "Begin" button and a smaller "Skip introduction" link
On mobile, the text should be scrollable and the Begin/Skip bar should be sticky at the bottom
Optionally: fade each paragraph in sequentially as the user scrolls or after a short delay, for a cinematic feel


Part 2: The introduction content — what it must cover
The introduction for each scenario should be stored in the scenario config file (not hardcoded in the engine). It should be a structured object like this:
json{
  "introduction": {
    "enabled": true,
    "skippable": true,
    "sections": [
      {
        "type": "world",
        "text": "The world context paragraph — what is happening historically, what forces are in motion, what year and place and why it matters. Written like McCullough: specific, vivid, grounded in real detail."
      },
      {
        "type": "stakes",
        "text": "What is at stake in this moment — politically, personally, for the city, for the people in this story. Why does tonight matter. What could go wrong and what it would cost."
      },
      {
        "type": "scene",
        "text": "The immediate world — Boston in this season, this hour. The streets, the occupation, the tension in the air. Paint the city before the player steps into it."
      },
      {
        "type": "entry",
        "text": "The final paragraph that brings the player to the threshold of the scene — the last sentence should land them at the exact moment the interactive story begins."
      }
    ]
  }
}

Part 3: Generate the introduction content for midnight_errand_boston
Write the actual introduction content for this scenario in the style of David McCullough or Joseph Ellis — specific, cinematic, historically grounded. It should cover:

What Boston is in 1775 — occupied, tense, a city of 16,000 people under British garrison, the harbor still smelling of the tea thrown overboard two years prior, a city where a man's politics can cost him his livelihood or his freedom
What the Regulars' march means — why Lexington and Concord matter, what is moving through the city tonight and why the Sons of Liberty are running messages in the dark
Why a printer's shop is dangerous — how broadsheets and pamphlets are the information warfare of the revolution, why Benjamin Gill's careful neutrality is both protection and a lie
Why tonight specifically is the hinge point — what is in that dispatch, what happens if it doesn't move, what happens if it's intercepted
Land the player at the door of the print shop, candle in hand, with everything they need to feel the weight of the moment


Part 4: Make it fully generic for future stories
The introduction screen component should be entirely story-agnostic. Any future scenario that includes an introduction object in its config will automatically get this screen. Scenarios without it skip directly to role selection or gameplay. The engine never needs to be touched — only the scenario data file.
In the admin story creation/edit page, add an "Introduction" section with:

Toggle: Enable introduction screen
Toggle: Allow skip
A rich text or markdown editor for each section (World / Stakes / Scene / Entry)
A preview button that renders it exactly as the player will see it
You said: can i post this entire prompt, all 4 parts in one prompt1.can i post this entire prompt, all 4 parts in one [prompt1.md](http://prompt1.md) file for Claude2:50 PMClaude responded: Yes, absolutely.Yes, absolutely. Here's exactly how to do it:

Create a file called prompt1.md and paste this into it:
markdown# Story Introduction Screen — Full Implementation

## Part 1: The introduction screen itself

Create a new screen/route that appears after role selection and before the first interactive scene. It should:

- Display as a full-page reading experience — black background, serif font, generous line height, comfortable reading width (max ~680px centered)
- Have a subtle header with the story title and year (e.g. *Midnight Errand — Boston, 1775*)
- Render the introduction text in paragraphs, styled like a book page — no UI chrome, no input, no choices
- Have a fixed bottom bar with two options: a prominent **"Begin"** button and a smaller **"Skip introduction"** link
- On mobile, the text should be scrollable and the Begin/Skip bar should be sticky at the bottom
- Optionally: fade each paragraph in sequentially as the user scrolls or after a short delay, for a cinematic feel

## Part 2: The introduction content structure

The introduction for each scenario should be stored in the scenario config file (not hardcoded in the engine). It should be a structured object like this:

```json
{
  "introduction": {
    "enabled": true,
    "skippable": true,
    "sections": [
      {
        "type": "world",
        "text": "The world context paragraph — what is happening historically, what forces are in motion, what year and place and why it matters. Written like McCullough: specific, vivid, grounded in real detail."
      },
      {
        "type": "stakes",
        "text": "What is at stake in this moment — politically, personally, for the city, for the people in this story. Why does tonight matter. What could go wrong and what it would cost."
      },
      {
        "type": "scene",
        "text": "The immediate world — Boston in this season, this hour. The streets, the occupation, the tension in the air. Paint the city before the player steps into it."
      },
      {
        "type": "entry",
        "text": "The final paragraph that brings the player to the threshold of the scene — the last sentence should land them at the exact moment the interactive story begins."
      }
    ]
  }
}
```

## Part 3: Generate the introduction content for `midnight_errand_boston`

Write the actual introduction content for this scenario in the style of David McCullough or Joseph Ellis — specific, cinematic, historically grounded. It should cover:

- What Boston is in 1775 — occupied, tense, a city of 16,000 people under British garrison, the harbor still smelling of the tea thrown overboard two years prior, a city where a man's politics can cost him his livelihood or his freedom
- What the Regulars' march means — why Lexington and Concord matter, what is moving through the city tonight and why the Sons of Liberty are running messages in the dark
- Why a printer's shop is dangerous — how broadsheets and pamphlets are the information warfare of the revolution, why Benjamin Gill's careful neutrality is both protection and a lie
- Why tonight specifically is the hinge point — what is in that dispatch, what happens if it doesn't move, what happens if it's intercepted
- Land the player at the door of the print shop, candle in hand, with everything they need to feel the weight of the moment

## Part 4: Make it fully generic for future stories

The introduction screen component should be entirely story-agnostic. Any future scenario that includes an `introduction` object in its config will automatically get this screen. Scenarios without it skip directly to role selection or gameplay. The engine never needs to be touched — only the scenario data file.

In the admin story creation/edit page, add an **"Introduction"** section with:
- Toggle: `Enable introduction screen`
- Toggle: `Allow skip`
- A rich text or markdown editor for each section (World / Stakes / Scene / Entry)
- A preview button that renders it exactly as the player will see it

Then in Claude Code, run:
claude < prompt1.md
Or if you prefer to reference it directly:
claude "$(cat prompt1.md)"

A few tips for using .md files with Claude Code:

You can build a library of these — prompt_intro_screen.md, prompt_mobile_fixes.md, prompt_sensory_narrative.md — and run them individually or chain them
Add a ## Context section at the top of each file describing what already exists so Claude Code doesn't duplicate work
If a prompt has dependencies (Part 2 must exist before Part 3 runs), note that explicitly in the file with a ## Prerequisites section
Keep each .md file focused on one feature — the multi-part structure within a single file is fine, but mixing two unrelated features in one file tends to produce incomplete results on both
