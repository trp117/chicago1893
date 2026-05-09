Build a session-aware anchor violation filter — post-generation enforcement for sensory repetition:
The problem:
The sensory repetition rule in the system prompt is being read but not held across full sessions. The transcript reviewer found candle guttering used 4 times in a single session, dispatch against the ribs used 3-4 times, and spectacles used 4 times — despite explicit one-per-session instructions. Prompt instruction alone cannot enforce session-level memory. A post-generation filter is required.
The architecture:
This follows the same pattern as the existing validateSceneOutput() function used for identity conflict detection. After each scene is generated and before it is streamed to the player, check the generated text against the session's anchor history.
Step 1 — Build the anchor tracker
In gameRouter.js or a new engine/services/AnchorTracker.js, add a session-level anchor tracker:
javascriptclass AnchorTracker {
  constructor(scenarioAnchors = []) {
    this.usedAnchors = new Map();
    this.scenarioAnchors = scenarioAnchors;
    this.universalPatterns = [
      /\b(dispatch|packet|letter|paper)\b.{0,30}\b(ribs?|chest|coat|body)\b/i,
      /\bcandle\b.{0,20}\b(gutter|gutters|guttering|low|stub|nearly gone|almost gone)\b/i,
      /\bspectacles\b.{0,40}\b(not put on|pocket|does not|didn't)\b/i,
      /\bcold\b.{0,20}\b(gap|collar|wrist|neck|finds)\b/i,
      /\b(ink|linseed|tallow)\b.{0,10}\b(smell|scent|odour)\b/i
    ];
  }
  
  check(sceneText) {
    const violations = [];
    
    this.universalPatterns.forEach((pattern, index) => {
      const matches = sceneText.match(pattern);
      if (matches) {
        const key = `universal_${index}`;
        const count = this.usedAnchors.get(key) || 0;
        if (count >= 1) {
          violations.push({
            type: 'universal',
            pattern: pattern.toString(),
            match: matches[0],
            uses: count + 1
          });
        }
        this.usedAnchors.set(key, count + 1);
      }
    });
    
    this.scenarioAnchors.forEach(anchor => {
      const key = anchor.toLowerCase();
      const words = key.split(' ').filter(w => w.length > 3);
      const pattern = new RegExp(words.join('.{0,20}'), 'i');
      const matches = sceneText.match(pattern);
      if (matches) {
        const count = this.usedAnchors.get(key) || 0;
        if (count >= 1) {
          violations.push({
            type: 'scenario',
            anchor: anchor,
            match: matches[0],
            uses: count + 1
          });
        }
        this.usedAnchors.set(key, count + 1);
      }
    });
    
    return violations;
  }
  
  getSummary() {
    return Object.fromEntries(this.usedAnchors);
  }
}
Step 2 — Initialize the tracker per session
When a session starts via /start, create an AnchorTracker instance keyed to the session ID and store it in the session state:
javascriptconst tracker = new AnchorTracker(scenario.overused_anchors || []);
sessionState.anchorTracker = tracker;
Step 3 — Check each generated scene
After each scene is generated and before streaming begins, run the anchor check:
javascriptconst violations = sessionState.anchorTracker.check(generatedText);

if (violations.length > 0) {
  console.warn(`[ANCHOR VIOLATION] Session ${sessionId}:`, 
    violations.map(v => `"${v.match}" (use #${v.uses})`).join(', ')
  );
  
  // On first violation — log and continue
  // The text still reaches the player but the violation is recorded
  // for the transcript reviewer to catch
  
  // On second violation of the same anchor in one session — 
  // append a note to the system prompt for the next turn only:
  sessionState.anchorViolationNote = 
    `IMPORTANT: Do not use these phrases in your next response — ` +
    `they have already appeared in this session: ` +
    violations.map(v => `"${v.anchor || v.pattern}"`).join(', ');
}
Step 4 — Inject violation note into next turn's prompt
In the prompt builder, if anchorViolationNote exists on the session state, append it to the system prompt for the next turn only — then clear it:
javascriptif (sessionState.anchorViolationNote) {
  systemPrompt += `\n\n${sessionState.anchorViolationNote}`;
  sessionState.anchorViolationNote = null;
}
This is a dynamic per-turn injection — not a permanent rule change. It tells the model specifically what it just used that it should not use again. Specific and immediate instruction is more effective than general rules when the model has already drifted.
Step 5 — Log violations to the transcript
When the session ends append the anchor tracker summary to the transcript file:
javascriptconst anchorSummary = sessionState.anchorTracker.getSummary();
const hasViolations = Object.values(anchorSummary).some(v => v > 1);

if (hasViolations) {
  await fs.appendFile(transcriptPath, 
    `\n\n## Anchor Usage\n\`\`\`json\n${JSON.stringify(anchorSummary, null, 2)}\n\`\`\`\n`
  );
}
This gives the transcript reviewer structured data alongside the prose — making its analysis faster and more accurate.
Step 6 — Make it generic
The AnchorTracker class takes scenarioAnchors as a constructor parameter. Any scenario that defines overused_anchors in its config gets scenario-specific tracking automatically. Scenarios without it still get universal pattern tracking. No scenario-specific code anywhere in the engine.
Do not regenerate scenes on violation — log, warn, and correct forward.
Regenerating on anchor violation would add 10-20 seconds to affected turns and the player would notice the delay. The better approach is what Step 4 implements — catch the violation, log it, and inject a specific correction into the next turn's prompt. The violation appears once. It does not repeat.
Confirm after implementation:

A test session shows anchor violations logged to the server console
The anchor usage block appears in the transcript file at session end
The violation note is cleared after one turn — it does not persist into subsequent turns
A scenario without overused_anchors defined does not throw errors
The tracker initializes correctly on /start and persists correctly across turns within a session

Report the first anchor violation log line from a real session so the format can be verified.