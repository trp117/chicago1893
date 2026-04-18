# Sample Opening Playthrough

This is a tone sample for the first few minutes.

## Opening scene
Chicago wakes under a low gray sky and a restless wind from the lake. Inside the Administration Building, messengers move at a near-run, telegraph slips change hands without ceremony, and Daniel Burnham stands over a desk scattered with shipping papers. He does not look up at once. When he finally does, there is strain in his face beneath the command.

"Something is wrong with the electrical consignments," he says. "And I do not mean delay. I mean interference."

He slides a memorandum toward you. Several crate numbers have been corrected in one hand and initialed in another.

## Player input
Examine the shipping memorandum and ask Burnham who last handled it.

## Expected response style
The paper still smells faintly of damp wool and lamp smoke. One set of initials is firm and angular; the other attempts the same strokes but crowds the letters, as if copied in haste. A clerk's correction would more likely have been neat. This feels imitative.

Burnham glances toward the outer office before answering.

**Daniel Burnham:** "It passed through procurement, then through electrical receiving. I should like to know why it returned to me altered. Quietly, if you please. This fair has survived delay, mud, and ridicule. I will not have it undone by intrigue."

### State movement
- time +3
- Burnham trust +1
- clue added: duplicated initials in different hands
- suggested next actions:
  - question the clerk who logged the document
  - go to the freight yards and compare crate numbers
  - inspect the electrical receiving logs in Machinery Hall

---

## Player input
Go to the freight yards and compare the crate numbers against the wagons that arrived this morning.

## Expected response style
The polish of the White City falls away once you reach the service lines. Here the fair is all mud, timber, curses, and iron. Wagons stand in ruts deep enough to hold last night's rain. A foreman pretends not to see you until your credential catches his eye.

One wagon ledger shows a corrected destination. The crate in question should have gone to Machinery Hall. Instead, for two hours, it vanished into a service lane with no countersign.

A watchman nearby grows still when you mention the number.

**Watchman:** "I only opened the gate. Paper looked proper. There was a gentleman with a French way of speaking, that is all I know."

### State movement
- time +4
- threat +1
- clue added: crate temporarily diverted through an unauthorized service lane
- flag: heardFrenchConversation = true
- suggested next actions:
  - press the watchman for a physical description
  - go to Machinery Hall and inspect the electrical equipment
  - seek out Clara Hale to learn whether foreign delegates have been meeting off the grounds
