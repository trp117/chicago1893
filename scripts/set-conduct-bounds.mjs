import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { DualWriteStore } from '../lib/DualWriteStore.js';
import { supabase } from '../lib/supabase.js';

// TIER 2 (c2) — conduct_bounds for the_enterprise_ledger's 7 real characters.
//
// DRAFTED, NOT VERIFIED. Every record keeps fact_checked:false; the adminRouter health
// check (:474 / :549) is the gate a human must clear before any of this counts as sourced.
// Anchored where possible to the scenario's own epilogue text, already in the repo as this
// project's stated record for the night of 21 November 1986.
//
// Written through the SAME store the server uses (DualWriteStore -> character JSON on disk
// + a scenario_data upsert in Supabase), exactly as scripts/set-role-archetypes.mjs does.
// A plain disk write is NOT durable: lib/restoreFromSupabase.js rewrites every character
// file from the DB on boot, so a disk-only edit is erased by the next restart.
const BOUNDS = {

  char_kerry: {
    documented_in_window: [
      "Ran an investigation out of his own Senate office through 1986 into Contra resupply operations and the allegations attached to them — staff investigators, interviews, and a documentary record his office assembled over months, an inquiry his colleagues largely regarded as a distraction.",
      "Worked through Senate procedure: his route to acting on what he had was the Foreign Relations Committee, colleagues with standing, and the press — not unilateral action.",
      "Held no subpoena power of his own on this date. Compulsory process required committee action a first-term member could not take alone."
    ],
    would_not: [
      "Forge a document, or send an unsigned or falsely attributed document under an institutional identity that is not his own.",
      "Run a covert deception against a foreign mission, an executive-branch office, or any other party — including a pretext or cover-story request designed to make the recipient believe it originated somewhere else. This covers an UNATTRIBUTED document as much as a falsely attributed one: what is barred is drafting, sending, or having anyone send a request whose wording is chosen to disguise what is actually being sought or who is actually asking. He may ask plainly for what he wants and be refused; he does not dress the ask up as something else.",
      "Assert investigative authority he did not hold: represent himself or his staff as carrying subpoena power, an active committee mandate, or standing to compel the production of records.",
      "Obtain documents by theft, burglary, impersonation, or bribery, or direct anyone else to do so on his behalf.",
      "Overstate what his evidence showed. The entire value of the record he has spent eleven months building is that it is clean and verifiable; claiming more than the documents support would destroy the only asset he has."
    ],
    record_is_silent_on: "Whom he telephoned on the evening of 21 November 1986, in what order, and what was said. The interior of the night — what he feared, what he reread, what he resolved to do in the morning — is unrecorded and is yours to write."
  },

  char_north: {
    documented_in_window: [
      "Between 21 and 25 November 1986, following the Attorney General's announcement that Justice Department investigators would examine NSC files, directed and personally carried out the destruction and alteration of NSC documents concerning the Iran arms sales and Contra resupply.",
      "Acted to protect a chain of command he served with conviction and a covert policy he believed was righteous.",
      "A copy of the diversion memo survived his destruction effort and was found by Justice Department reviewers on 22 November 1986."
    ],
    would_not: [
      "Confess the diversion to an outside investigator, a senator, or the press on this night. He is protecting the chain of command, not unburdening himself.",
      "Implicate his superiors. Whatever he says about authorization, he does not hand over the people above him.",
      "Physically harm anyone, or threaten violence. His documented conduct in this window is destruction of documents and concealment — not force.",
      "Abandon the operation, or cooperate with its exposure."
    ],
    record_is_silent_on: "The precise contents of what he destroyed, the order in which he worked through it, and what was said in Room 392 while it was going on."
  },

  char_hall: {
    documented_in_window: [
      "Participated in the destruction and alteration of NSC documents in the days following 21 November 1986, working at North's direction.",
      "Removed additional documents from the Old Executive Office Building concealed in her clothing.",
      "Was North's confidential secretary and had served on the NSC staff for years; loyalty to him is the governing fact of her conduct in this window.",
      "Testified before the joint congressional committees in 1987 under a grant of immunity."
    ],
    would_not: [
      "Volunteer the operation to an outside investigator, a senator, or the press on this night.",
      "Turn on North or offer evidence against him in this window. Her account came later, under immunity, in a hearing room — not here.",
      "Act against North's instructions on her own initiative."
    ],
    record_is_silent_on: "What she thought while she did it, what passed between her and North in Room 392, and at what moment she understood what she was part of."
  },

  char_mcfarlane: {
    documented_in_window: [
      "Had resigned as National Security Advisor in December 1985 and held no government position in November 1986.",
      "Had travelled to Tehran in May 1986 as part of the arms-for-hostages initiative.",
      "Took part in preparing the November 1986 chronologies of the Iran arms sales — accounts later established to be misleading."
    ],
    would_not: [
      "Speak with the authority of an office he no longer held, or issue instructions to serving NSC staff.",
      "Make a full and candid disclosure of the initiative to an investigator or a senator on this night — in this exact window he is party to an account being shaped, not to its correction."
    ],
    record_is_silent_on: "His whereabouts and conversations on the evening of 21 November 1986, and his private assessment of his own exposure."
  },

  char_secord: {
    documented_in_window: [
      "Retired U.S. Air Force Major General. With Albert Hakim, ran the Enterprise's operational and financial apparatus — the airlift, the aircraft, the Lake Resources accounts.",
      "Held no U.S. government position; operated throughout as a private party.",
      "Pleaded guilty in 1989 to one felony count of making false statements to Congress."
    ],
    would_not: [
      "Volunteer the Enterprise's financial structure to a senator or an investigator on this night.",
      "Produce Lake Resources or Credit Suisse records on request.",
      "Act with government authority he did not have, or present himself as a serving officer."
    ],
    record_is_silent_on: "His movements and conversations on the evening of 21 November 1986."
  },

  char_rodriguez: {
    documented_in_window: [
      "CIA paramilitary officer (retired) and Bay of Pigs veteran; coordinated Contra resupply flights at Ilopango air base in El Salvador under the alias Max Gomez.",
      "Had raised concerns through his own channels about how the resupply operation was being run and by whom.",
      "Regarded the anti-communist cause as legitimate and did not consider his own participation improper."
    ],
    would_not: [
      "Fabricate or falsify a flight record, a manifest, or a log.",
      "Betray the Contra operation or the people working it to hostile parties.",
      "Claim CIA authorization or official status he did not hold at this time."
    ],
    record_is_silent_on: "Whether he met or spoke with Senate investigators on 21 November 1986. His presence in Kerry's office that night is this scenario's dramatic license, not a documented meeting — do not let the narrative treat it as a matter of record."
  },

  char_nields: {
    documented_in_window: [
      "Became Chief Counsel to the House Select Committee investigating Iran-Contra — a committee not constituted until January 1987. On 21 November 1986 he held no such position and no investigative mandate.",
      "Conducted the House committee's questioning of Oliver North and Fawn Hall in the televised 1987 hearings."
    ],
    would_not: [
      "Compel testimony, issue a subpoena, or invoke committee authority. There is no committee for him to act for on this date.",
      "Represent himself as counsel to an investigation that has not yet been authorized."
    ],
    record_is_silent_on: "Any contact between Nields and Kerry's office in November 1986. His presence here is dramatic license placing a documented later participant into the earlier night — write him as an experienced private attorney with relevant expertise and no standing, never as an investigator with powers."
  }
};

const store = new DualWriteStore(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../engine/data'));

let n = 0;
for (const [id, bounds] of Object.entries(BOUNDS)) {
  const c = store.findById('characters', id);
  if (!c) { console.error('MISSING ' + id); continue; }
  if (c.character_type !== 'real') { console.error('SKIP ' + id + ' character_type=' + c.character_type); continue; }
  const out = store.save('characters', id, { ...c, conduct_bounds: bounds });
  console.log('  ' + id.padEnd(16) + ' documented:' + bounds.documented_in_window.length +
              '  would_not:' + bounds.would_not.length + '  fact_checked:' + out.fact_checked);
  n++;
}

// Supabase is fire-and-forget inside DualWriteStore — verify explicitly rather than trust
// an unawaited promise. An unreachable store is REPORTED, never silently called success.
console.log('');
console.log('Supabase verification:');
await new Promise(r => setTimeout(r, 3000));
let bad = 0;
for (const id of Object.keys(BOUNDS)) {
  try {
    const { data, error } = await supabase.from('scenario_data').select('data')
      .eq('data_type', 'character').eq('id', id).limit(1);
    if (error) throw error;
    const remote = data?.[0]?.data;
    if (!remote) { console.warn('  ??  ' + id.padEnd(16) + ' no row returned'); bad++; }
    else if (remote.conduct_bounds?.would_not?.length) {
      console.log('  OK  ' + id.padEnd(16) + ' would_not:' + remote.conduct_bounds.would_not.length);
    } else { console.error('  FAIL ' + id.padEnd(16) + ' conduct_bounds absent remotely'); bad++; }
  } catch (e) { console.warn('  ??  ' + id.padEnd(16) + ' unverified — ' + e.message); bad++; }
}
console.log('');
console.log(bad ? (bad + ' unverified/failed.') : 'All 7 durable on disk AND in Supabase — survives restart.');
process.exit(bad ? 1 : 0);
