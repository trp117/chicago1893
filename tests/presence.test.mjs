// PRESENCE — who is physically with the player NOW (state.presentNpcs).
//
//   STATE    mergeState holds the list the model reports (stateChanges.npcs_present) until the
//            narrative changes it; a move clears it unless that turn reports who came along;
//            a fled NPC drops out; the player character is never listed
//   PROMPT   buildPresenceBlock names the present people (by name, never an id as a name) and
//            puts their sheets in Relevant NPCs wherever their linked locations are; the list
//            itself leaves STATE_JSON
//   SAME     a session that never reports presence carries no presentNpcs key and composes a
//            turn prompt byte-identical to one composed without the feature
//
// The bug this guards (ignatius_loyola_1521, 16–17 Oct): Martín came up to the sickroom and
// argued across several turns, but nothing in state said he was there — his linked locations
// are the great hall and Pamplona — so the narrator wrote "Martín is not in the sickroom".
//
// Synthetic fixtures only: nothing is read from or written to the data directory.

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).href;
const { mergeState } = await import(`${ROOT}/engine/services/StateManager.js`);
const { composeTurnPrompt, buildPresenceBlock } = await import(`${ROOT}/engine/services/PromptComposer.js`);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const quiet = fn => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return fn(); } finally { console.log = l; console.warn = w; } };

const SC = { id: 'syn_presence', title: 'Presence', sessionTargetMinutes: 30, systems: {} };
const LOCS = [
  { id: 'syn_sickroom', name: 'Sickroom', linkedCharacterIds: ['syn_sister', 'syn_servant'] },
  { id: 'syn_hall',     name: 'Hall',     linkedCharacterIds: ['syn_brother'] },
];
const CHARS = [
  { id: 'syn_brother', name: 'The Brother', role: 'Head of the house', scenarioIds: [SC.id] },
  { id: 'syn_sister',  name: 'The Sister',  role: 'Keeps the sickroom', scenarioIds: [SC.id] },
  { id: 'syn_servant', name: 'Household servant', role: 'Carries things', scenarioIds: [SC.id] },
  { id: 'syn_player',  name: 'The Patient', role: 'The player', scenarioIds: [SC.id] },
];
const base = () => ({ scenarioId: SC.id, location: 'syn_sickroom', visitedLocations: ['syn_sickroom'], elapsedMinutes: 0, remainingMinutes: 30, act: 1,
  threat: 1, authorityTrust: 0, suspicion: {}, introducedNpcs: [], playerCharacterId: 'syn_player', playerRoleId: 'syn_role', playerRoleName: 'The Patient' });
const merge = (st, out) => quiet(() => mergeState(st, out, SC, [], '', LOCS));
const prompt = st => quiet(() => composeTurnPrompt(st, 'I look up.', { scenario: SC, characters: CHARS, locations: LOCS, clues: [] }));
const relevant = p => { const a = p.indexOf('Relevant NPCs:') + 'Relevant NPCs:'.length; return JSON.parse(p.slice(a, p.indexOf('NPC locations')).trim()).map(c => c.name); };

head('STATE — held until the narrative changes it');
let s = merge(base(), { stateChanges: { npcs_present: ['syn_brother'] } });
check('an arrival is recorded', JSON.stringify(s.presentNpcs) === '["syn_brother"]');
s = merge(s, { npc_updates: { syn_brother: { trust_delta: -1 } } });
check('a turn that reports nothing keeps him present', JSON.stringify(s.presentNpcs) === '["syn_brother"]');
s = merge(s, {});
check('...and so does a turn where he says nothing at all', JSON.stringify(s.presentNpcs) === '["syn_brother"]');
s = merge(s, { stateChanges: { npcs_present: [] } });
check('he leaves → [] (the key stays, empty)', Array.isArray(s.presentNpcs) && s.presentNpcs.length === 0);
s = merge(base(), { stateChanges: { npcs_present: ['syn_brother', 'syn_brother', 'syn_player', '', 7] } });
check('deduped; the player character, blanks and non-strings dropped', JSON.stringify(s.presentNpcs) === '["syn_brother"]', JSON.stringify(s.presentNpcs));
s = merge(merge(base(), { stateChanges: { npcs_present: ['syn_brother', 'syn_sister'] } }), { npcFled: 'syn_brother' });
check('a fled NPC drops out', JSON.stringify(s.presentNpcs) === '["syn_sister"]');
s = merge(merge(base(), { stateChanges: { npcs_present: ['syn_sister'] } }), { location: 'syn_hall' });
check('a move clears the list', Array.isArray(s.presentNpcs) && s.presentNpcs.length === 0);
s = merge(merge(base(), { stateChanges: { npcs_present: ['syn_sister'] } }), { location: 'syn_hall', stateChanges: { npcs_present: ['syn_sister', 'syn_brother'] } });
check('...unless the moving turn reports who came along', JSON.stringify(s.presentNpcs) === '["syn_sister","syn_brother"]');
s = merge(base(), { npc_updates: { syn_brother: {} }, npcMoments: [{ npc: 'syn_brother', text: 'Hm.' }] });
check('nothing reported → no presentNpcs key at all (speaking alone does not make someone present)', !('presentNpcs' in s));

head('PROMPT — the present are named, and their sheets travel with them');
let p = prompt({ ...base(), presentNpcs: ['syn_brother'] });
const block = buildPresenceBlock({ ...base(), presentNpcs: ['syn_brother'] }, CHARS);
check('the block is in the turn prompt', block && p.includes(block));
check('it names him (id: name) and says a doorway counts', block.includes('- syn_brother: The Brother') && /doorway or threshold counts as here/.test(block));
check('it carries the id-is-never-a-name guard', /the id is a system key, never a name/.test(block) && /a role \("Household servant"\) stays a role/.test(block));
check('it forbids writing him absent, and outranks the NPC locations table', /never write any of them as absent, elsewhere, or not in the room/.test(block) && /this list wins/.test(block));
check('it keeps the unlisted absent (no "everyone is here")', /Anyone not listed is not in the room unless this turn's narrative brings them in/.test(block));
check('his sheet is in Relevant NPCs though the sickroom is not one of his locations', relevant(p).includes('The Brother'), relevant(p).join(', '));
check('presentNpcs is not duplicated into STATE_JSON', !p.includes('"presentNpcs"'));
check('an unknown id is dropped, never printed', buildPresenceBlock({ ...base(), presentNpcs: ['syn_ghost'] }, CHARS) === '' && !buildPresenceBlock({ ...base(), presentNpcs: ['syn_ghost', 'syn_sister'] }, CHARS).includes('syn_ghost'));
p = prompt(base());
check('nobody present → the brother is not in Relevant NPCs in the sickroom', !relevant(p).includes('The Brother'), relevant(p).join(', '));

head('SAME — a session that never reports presence');
check('no key → no block, and [] → the same prompt, byte for byte', !prompt(base()).includes('PRESENT IN THIS SCENE') && prompt(base()) === prompt({ ...base(), presentNpcs: [] }));

console.log(fails ? `\n${fails} assertion(s) FAILED.` : '\nAll presence assertions passed.');
process.exit(fails ? 1 : 0);
