// CARRIED OBJECTS — an inventory item authored follows_player:true goes with the player when
// they leave the place it lies (StateManager.mergeState), and OBJECT STATE renders it as held.
//
// The bug this guards (tolle_lege_milan_386, 2 Nov): Augustine went into the garden without
// the player explicitly carrying the codex; state only had the string "awareness of the
// codex on the table", so at the fork the narrator wrote "The codex is not beside Alypius.
// It is in the house." and offered "Ask Alypius to bring it here".
//
// Frozen fixtures only: nothing is read from or written to the data directory.

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).href;
const { buildInitialState, mergeState } = await import(`${ROOT}/engine/services/StateManager.js`);
const { composeTurnPrompt } = await import(`${ROOT}/engine/services/PromptComposer.js`);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const quiet = fn => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return fn(); } finally { console.log = l; console.warn = w; } };

const CODEX = "the codex of Paul's letters";
const SC = { id: 'syn_tolle', title: 'Syn Tolle', sessionTargetMinutes: 30, systems: {} };
const LOCS = [
  { id: 'loc_reception_room', name: 'The Reception Room', linkedCharacterIds: ['alypius'] },
  { id: 'loc_garden',         name: 'The Garden',         linkedCharacterIds: ['alypius'] },
  { id: 'loc_monica_room',    name: "Monica's Room",      linkedCharacterIds: [] },
];
const CHARS = [{ id: 'alypius', name: 'Alypius of Thagaste', role: 'Friend', scenarioIds: [SC.id] }];

// Frozen copy of the role fields this fix writes (approved 2 Nov) — not read from live data.
const ROLE = {
  id: 'role_augustine', name: 'Augustine', character_id: 'augustine',
  startLocationId: 'loc_reception_room',
  perspective: 'Deep first-person interiority.',
  roleInitialState: {
    flags: { entered_garden: false },
    inventory: [
      "the memory of Ponticianus's story",
      { object_name: CODEX, holder: 'loc_reception_room', status: 'in_play', turn: 0, follows_player: true },
    ],
  },
  defining_moment: {
    setup: 'You are under the fig tree now, the amber light on the wall gone deeper. The codex of Paul came out into the garden with you — you did not leave it behind; you never do — and it is close enough to reach, patient, as it has been patient with you longer than any person has managed. Alypius followed you and then stopped.',
    options: [
      { id: 'go_for_codex',        text: 'Take up the codex and read until something moves, or nothing does.' },
      { id: 'stay_under_fig_tree', text: 'Stay here, under this tree, in silence — let what is coming come without reaching for it.' },
      { id: 'weep_but_hold_back',  text: 'Let the weeping take you under the tree — but keep one handhold you cannot yet let go.' },
    ],
  },
};

const init  = () => quiet(() => buildInitialState(SC, structuredClone(ROLE), LOCS));
const move  = (st, location, stateChanges = {}) => quiet(() => mergeState(st, { narrative: 'x', location, stateChanges }, SC, [], 'x', LOCS));
const codex = st => st.inventory.find(i => i.object_name === CODEX);
const objectState = st => {
  const p = quiet(() => composeTurnPrompt(st, 'I wait.', { scenario: SC, characters: CHARS, locations: LOCS, clues: [] }));
  const m = p.match(/OBJECT STATE[^\n]*\n(?:[^\n]+\n?)*/);
  return { prompt: p, block: m ? m[0] : '' };
};

head('mixed inventory: string + structured object');
{
  const st = init();
  check('starts in the reception room', st.location === 'loc_reception_room', st.location);
  check('every state item is an object', st.inventory.every(i => i && typeof i === 'object'));
  check('the plain string became a player-held item',
    st.inventory.some(i => i.object_name === "the memory of Ponticianus's story" && i.holder === 'player' && i.status === 'in_play'));
  check('codex starts on the table (held by the reception room)', codex(st)?.holder === 'loc_reception_room');
  check('codex keeps follows_player', codex(st)?.follows_player === true);
  const { prompt, block } = objectState(st);
  check('OBJECT STATE renders', block.includes('OBJECT STATE'), block);
  check('string item renders by name', block.includes("Player holds: the memory of Ponticianus's story"), block);
  check('codex renders with its holder', block.includes(`${CODEX}: holder=loc_reception_room, status=in_play`), block);
  check('no [object Object] anywhere in the turn prompt', !prompt.includes('[object Object]'));
}

head('enter the garden without carrying it');
{
  const st = move(init(), 'loc_garden');
  check('player is in the garden', st.location === 'loc_garden');
  check('codex went with him (holder=player)', codex(st)?.holder === 'player', JSON.stringify(codex(st)));
  check('codex still in play', codex(st)?.status === 'in_play');
  const { block } = objectState(st);
  check('OBJECT STATE: player holds the codex', /Player holds: [^\n]*the codex of Paul's letters/.test(block), block);
  check('OBJECT STATE: no longer on the table', !block.includes('holder=loc_reception_room'), block);
}

head('same-turn "left it on the table" is overridden');
{
  const st = move(init(), 'loc_garden', { inventory_updates: [{ object_name: CODEX, holder: 'loc_reception_room' }] });
  check('codex still follows him', codex(st)?.holder === 'player', JSON.stringify(codex(st)));
}

head('set down in the garden stays in the garden');
{
  let st = move(init(), 'loc_garden');
  st = move(st, 'loc_garden', { inventory_updates: [{ object_name: CODEX, holder: 'loc_garden' }] });
  check('holder is the garden after he sets it down', codex(st)?.holder === 'loc_garden');
  st = move(st, 'loc_garden');
  check('no move, no change', codex(st)?.holder === 'loc_garden');
}

head('items not marked follows_player, or in an NPC\'s hands, are untouched');
{
  const role = structuredClone(ROLE);
  role.roleInitialState.inventory.push({ object_name: 'a lamp', holder: 'loc_reception_room', status: 'in_play', turn: 0 });
  let st = quiet(() => buildInitialState(SC, role, LOCS));
  st = move(st, 'loc_garden');
  check('unmarked item stays in the room', st.inventory.find(i => i.object_name === 'a lamp')?.holder === 'loc_reception_room');

  let s2 = init();
  s2 = move(s2, 'loc_reception_room', { inventory_updates: [{ object_name: CODEX, holder: 'alypius' }] });
  s2 = move(s2, 'loc_garden');
  check('codex in Alypius\'s hands is not moved by the rule', codex(s2)?.holder === 'alypius');

  let s3 = init();
  s3 = move(s3, 'loc_reception_room', { inventory_updates: [{ object_name: CODEX, status: 'lost' }] });
  s3 = move(s3, 'loc_garden');
  check('a lost codex does not follow', codex(s3)?.holder === 'loc_reception_room');
}

head('authored fork text');
{
  const dm = ROLE.defining_moment;
  check('setup no longer says "beside Alypius"', !/beside Alypius/i.test(dm.setup));
  check('setup keeps the patience beat', dm.setup.includes('patient, as it has been patient with you longer than any person has managed'));
  check('go_for_codex has no location clause', !/beside|from where|Alypius/i.test(dm.options[0].text), dm.options[0].text);
}

console.log(fails ? `\n${fails} failure(s).` : '\nAll codex-carry checks passed.');
process.exit(fails ? 1 : 0);
