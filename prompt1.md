The time extension feature is not working correctly.

Current behavior:
- The countdown reaches 0:00
- The game continues normally
- No extension decision appears
- No overtime consequences are applied

Goal:
Create a proper time-extension/overtime system.

Expected behavior:
When gameState.remainingMinutes <= 0 and the player has not already used an extension:
1. Pause normal gameplay
2. Show a clear decision panel:
   - Continue investigating (+5 minutes, harder conditions)
   - Make final accusation
3. Do not send another normal AI turn until the player chooses one option

If player chooses Continue Investigating:
- Set remainingMinutes to 5
- Set extensionUsed = true
- Set timeExpired = false
- Resume normal play
- Add an overtime/pressure flag if available, such as:
  stateChanges.flags.overtime = true
  or gameState.flags.overtime = true
- Future turns should feel more urgent and less forgiving

If player chooses Make Final Accusation:
- Re-enable the input
- Change placeholder to:
  “Name your suspect and state your case…”
- The next user input should be treated as a solve attempt / final conclusion

Important requirements:
- Only allow one extension for now
- Do not reset the investigation
- Do not erase clues
- Do not restart the game
- Do not change unrelated game logic
- Keep the implementation minimal and safe

Likely files:
- src/app.js
- server/server.js only if time logic is server-side
- data/scenario.json only if initial state needs extensionUsed/timeExpired/flags initialized

Please return:
1. Exact files changed
2. Explanation of why the previous logic failed
3. Updated code snippets
4. How to test it quickly by forcing remainingMinutes to 0