I want to add very small instructional text to the existing intro/start screen to improve clarity. These should be minimal UI changes only — do NOT redesign or restructure the page.

Goal:
- Help users understand what to do
- Keep the screen clean and uncluttered
- Preserve current layout, styling, and logic

Do NOT:
- Change layout structure
- Add new sections or containers
- Modify backend or game logic
- Change role cards or their functionality
- Increase vertical spacing significantly

---

### 1. Add instruction above role selection

Add this single line directly ABOVE the role cards:

"Select your role to begin the investigation."

Requirements:
- Use subtle styling (secondary text color)
- Smaller than headers
- Keep spacing tight (minimal margin)

---

### 2. Add clarification under Narrative Style

Under the "NARRATIVE STYLE" label or buttons, add:

"Focused = faster | Cinematic = more descriptive"

Requirements:
- Small font
- Subtle/secondary styling
- Keep inline and compact (no wrapping if possible)

---

### 3. Optional (only if it fits cleanly)

If spacing allows WITHOUT pushing content down significantly, add a small line above the Start button:

"When ready, begin."

If it creates clutter or pushes the button down too much, SKIP this step.

---

### Technical notes

- Likely files:
  - src/index.html
  - src/app.js (if rendered dynamically)
  - src/styles.css (for subtle text styling)

- Prefer reusing existing typography classes if available
- Do NOT create large new CSS blocks — keep changes minimal

---

### Output format

Return:
1. Files changed
2. Exact code snippets (minimal diffs preferred)
3. Any new CSS classes (if added)