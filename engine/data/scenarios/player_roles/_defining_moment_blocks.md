# defining_moment blocks — recovery copies

Authored `defining_moment` blocks for the roles that carry one, kept here as a plain-text
backup. **This file is documentation, not data — nothing reads it at runtime.**

## Why this file exists

`defining_moment` is written directly onto the player-role JSON. The admin role editor
(`engine/admin/index.html` → `renderPlayerRolesSection`) does not render the field, and the
editor save paths — `PUT /admin/api/player-roles/:id` and `POST /admin/api/generate/save` —
write the role as a **whole object** reconstructed from the form. `preserveStoredEndingNotes`
(`engine/admin/adminRouter.js:148`) guards `ending_notes` against exactly this, and guards
nothing else. So opening one of these roles in the admin editor and pressing Save silently
deletes its `defining_moment`, with no role-level version history to recover from — the same
failure mode as the McCormick ending-notes data loss.

Until the editor knows about the field (or the guard is extended to cover it), **this file is
the only backup.**

## How to restore a block

Do NOT hand-edit the JSON on disk alone: `restoreFromSupabase()` runs at boot
(`engine/server/server.js:337`) and overwrites every `player_role` file from the Supabase
`scenario_data` table, so a disk-only fix reverts at the next restart. Write through the
store so both land in one call:

```js
import { DualWriteStore } from './lib/DualWriteStore.js';
const store  = new DualWriteStore('engine/data');
const stored = store.findById('scenarios/player_roles', '<role_id>');
store.save('scenarios/player_roles', '<role_id>', { ...stored, defining_moment: BLOCK });
// disk: atomic tmp+rename. Supabase: upsert, fire-and-forget — let the process live a
// moment before exiting, or poll the row back, or the upsert may not land.
```

The engine reads the role from **disk** at `/start`; Supabase is the durable copy that
mirrors to disk at boot. Both must carry the block.

---

## Harald Jäger — The Gatekeeper

- role id: `role_gatekeeper`
- scenario: `bornholmer_strasse_first_breach`
- moment id: `jaeger_defining_choice`
- fires at: `at_elapsed_fraction 0.6` of the scenario's `sessionTargetMinutes`
- costs no clock: `time_advance: 0`

```json
{
  "id": "jaeger_defining_choice",
  "setup": "The phone is still in your hand — you have held it long enough that the plastic has your temperature, the line open, no one on it. In the logbook, three times in your own hand, the pen bearing down harder each time: Kein Befehl. Kein Befehl. Kein Befehl. In the margin beside it, in pencil, unsigned, the order you drafted twenty minutes ago and could not make yourself commit to. Brenner is on the platform with a loaded weapon and no order from you. Raab waits in the corridor for something to countermand. The crowd is no longer building — it has finished building; you feel it in the concrete through the soles of your boots. Thirty-one years you have waited to be told what to do. The order is not coming.",
  "options": [
    {
      "id": "hold_the_line",
      "text": "The barrier stays down. Until an order comes, you hold the post you were given."
    },
    {
      "id": "make_them_share_it",
      "text": "Keep the crowd processing by hand and force someone above you — Raab, the phone, anyone — to put their name to this first."
    },
    {
      "id": "give_the_order",
      "text": "Open it — say the words aloud, on your own authority, in your own voice, and let the guards hear you own it."
    }
  ],
  "time_advance": 0,
  "at_elapsed_fraction": 0.6,
  "principal_transition": {
    "type": "decision_made",
    "moment": "jaeger_defining_choice"
  }
}
```

## Trude Harms — Resident

- role id: `role_trude_harms`
- scenario: `when_the_walls_grew_warm`
- moment id: `trude_defining_choice`
- fires at: `at_elapsed_fraction 0.6` of the scenario's `sessionTargetMinutes`
- costs no clock: `time_advance: 0`

```json
{
  "id": "trude_defining_choice",
  "setup": "Wachter has stopped talking. The regulation has nothing left to say to a cellar this hot, and he knows it, and the silence where his voice was is worse than the voice. The strip under the door is forge-colored. Lotte is watching you — not her mother, you — because somewhere in the last hour the room decided you were the one who knew the way. You do know the way. One hundred meters north, the water, you could walk it blind. Wachter is still on the bench. He will not make that walk fast, and part of you has known that since the wall first went warm. The question you have carried since the first breath through the rag is not a question anymore. It is a door, and it is open, and you have seconds.",
  "options": [
    {
      "id": "lead_out",
      "text": "Get everyone up the chute now — Wachter comes or he doesn't."
    },
    {
      "id": "hold_for_wachter",
      "text": "You don't leave him. Hold everyone until Wachter moves."
    },
    {
      "id": "force_wachter",
      "text": "Get him on his feet yourself — drag him to the chute if you have to."
    }
  ],
  "time_advance": 0,
  "at_elapsed_fraction": 0.6,
  "principal_transition": {
    "type": "decision_made",
    "moment": "trude_defining_choice"
  }
}
```

---

_Regenerate this file from the stored roles rather than editing it by hand, so it can never
drift from what is actually saved._
