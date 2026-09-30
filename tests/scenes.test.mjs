// SCENES (Part B, B1) — data model + admin authoring. STORAGE ONLY.
//
// An act may carry an optional scenes[] array. B1 adds the shape, the Story Arc editor's
// scene cards, and a save-side reference check. It adds NO runtime behaviour: nothing in the
// engine reads scenes[] until B2. So this file asserts three things:
//
//   1. INERTNESS  an arc WITH scenes composes byte-identical prompts, beat rosters, story
//                 positions and fork due-checks to the same arc without them — for every
//                 stored role, and for the story-bound (arc-loaded) path. Plus a static check
//                 that no runtime module mentions scenes at all.
//   2. ROUND TRIP every scene field — dropdowns, role_locations, reorder, removal — survives
//                 the real editor render → collect, and the real PUT → disk → GET routes.
//   3. VALIDATION a location from another scenario, an unknown beat, an unknown role, a
//                 duplicate id, a scene with no end: each rejected by name.
//
// No API calls. Nothing under engine/data is written — the route round trip saves into a
// scratch copy of the arcs directory.

import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import vm from 'vm';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

process.env.DEFINING_MOMENT_ENABLED = 'true';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;

const { JSDOM }              = await import('jsdom');
const express                = (await import('express')).default;
const { JsonFileStore }      = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository } = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { LocationRepository } = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { StoryArcRepository } = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
const { buildInitialState, loadForkStoryArc, recordReachedBeats } =
  await import(`${ROOT}/engine/services/StateManager.js`);
const { composeTurnPrompt, arcBeats, storyPosition, definingMomentDue, forkTimingStatus } =
  await import(`${ROOT}/engine/services/PromptComposer.js`);
const admin = await import(`${ROOT}/engine/admin/adminRouter.js`);
const { validateArcScenes, sceneRefSets, preserveStoredScenes, createAdminRouter } = admin;

const store = new JsonFileStore(path.join(REPO_DIR, 'engine/data'));
const repos = {
  scenarios: new ScenarioRepository(store),
  locations: new LocationRepository(store),
  storyArcs: new StoryArcRepository(store),
};

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head  = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const quiet = fn => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const clone = o => JSON.parse(JSON.stringify(o));

const JOAN_ID  = 'joan_trial_rouen_1431';
// Joan's STORED arc now carries her 7 real scenes (authored 2026-09-30). The fixture every
// test below builds on is that arc with its scenes stripped — the no-scenes shape B1 must
// leave byte-identical — rebuilt in memory, never written. The real scenes are checked on
// their own in section 0.
const JOAN_STORED = repos.storyArcs.findById(`${JOAN_ID}_main_arc`);
const JOAN_ARC    = (() => { const a = JSON.parse(JSON.stringify(JOAN_STORED)); a.acts.forEach(x => { delete x.scenes; }); return a; })();
const JOAN_LOC = repos.locations.findAll().filter(l => l.scenarioId === JOAN_ID);
const JOAN_ROLES = repos.scenarios.findPlayerRoles(JOAN_ID);

// Joan's scenes as the reviewer means to author them — every field populated somewhere,
// role_locations on two scenes, a budget-only scene, a beat-only scene.
const JOAN_SCENES = [
  [ { id: 'hall_feb_sessions', change: 'both', date_label: '21 February 1431', time_label: 'Morning',
      location_id: 'great_hall_rouen_castle', bridge: 'The chapel royal gives way to the great hall.',
      ends_on_beat: '24_feb_1431', budget_minutes: 5 },
    { id: 'hall_voices', change: 'time', date_label: '27 February 1431',
      location_id: 'great_hall_rouen_castle', bridge: 'Three days on, the same benches.',
      ends_on_beat: 'the_voices_are' } ],
  [ { id: 'hall_male_dress', change: 'time', date_label: '3 March 1431', location_id: 'great_hall_rouen_castle',
      bridge: 'The public sessions grind on.', ends_on_beat: '13_mar_1431' },
    { id: 'cell_church_militant', change: 'place', date_label: '17 March 1431', time_label: 'Afternoon',
      location_id: 'joan_prison_cell', bridge: 'The sessions move into her prison.', ends_on_beat: '17_mar_1431',
      role_locations: { role_manchon: 'corridor_castle_rouen' } },
    { id: 'tower_torture', change: 'both', date_label: '9 May 1431', location_id: 'great_tower_rouen',
      bridge: 'They take her to the great tower.', budget_minutes: 4.5 } ],
  [ { id: 'saint_ouen', change: 'both', date_label: '24 May 1431', time_label: 'Morning',
      location_id: 'saint_ouen_cemetery', bridge: 'Carts to Saint-Ouen.', ends_on_beat: '24_may_1431',
      // role_locations keys in the scenario's role order: the editor collects them in the order it
      // renders the roles, so an authored map in another key order comes back reordered (same content).
      role_locations: { role_manchon: 'chapter_room_rouen', role_massieu: 'saint_ouen_cemetery' } } ],
  [],   // act 4 left WITHOUT scenes: posted as [] by the editor, STORED key-absent
];
const withScenes = arc => {
  const a = clone(arc);
  a.acts.forEach((act, i) => { if (JOAN_SCENES[i]?.length) act.scenes = clone(JOAN_SCENES[i]); });
  return a;
};

head('0. fixtures');
check('Joan arc loads with 4 acts', JOAN_ARC?.acts?.length === 4);
check('fixture: Joan arc with scenes stripped carries none', !JOAN_ARC.acts.some(a => 'scenes' in a));
{
  // Live data: whatever scenes the stored arc carries must pass the same check the save routes run.
  const live = JOAN_STORED.acts.flatMap(a => a.scenes || []);
  const errs = validateArcScenes(JOAN_STORED, sceneRefSets(repos, JOAN_ID));
  check(`stored Joan scenes (${live.length}) validate clean against Joan's own locations / beats / roles`, errs.length === 0, errs.slice(0, 3).join(' | '));
}
check('Joan has 7 scenario-scoped locations', JOAN_LOC.length === 7, JOAN_LOC.map(l => l.id).join(', '));
check('Joan has roles joan / manchon / massieu', ['role_joan', 'role_manchon', 'role_massieu'].every(id => JOAN_ROLES.some(r => r.id === id)));

// ═══ 1. INERTNESS ════════════════════════════════════════════════════════════
head('1a. static — no runtime module reads scenes');
{
  const runtimeDirs = ['engine/services', 'engine/server', 'engine/game', 'engine/agents'];
  const hits = [];
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(f.name) && /\.scenes\b|\['scenes'\]|\bscenes\s*[:=]|ends_on_beat|role_locations|budget_minutes/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO_DIR, p));
  } };
  for (const d of runtimeDirs) if (fs.existsSync(path.join(REPO_DIR, d))) walk(path.join(REPO_DIR, d));
  check('engine/{services,server,game,agents} never touch scenes / scene fields', hits.length === 0, hits.join(', '));
}

head('1b. every stored role — prompt identical with a scene-laden arc');
const SCEN_DIR = path.join(REPO_DIR, 'engine/data/scenarios');
const scenarioIds = [...new Set([
  ...fs.readdirSync(SCEN_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')),
  ...fs.readdirSync(path.join(SCEN_DIR, 'player_roles')).filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(SCEN_DIR, 'player_roles', f), 'utf8')).scenarioId; } catch { return null; } })
    .filter(Boolean),
])].sort();
const corpus = [];
for (const id of scenarioIds) {
  const scenario = await repos.scenarios.findById(id);
  if (!scenario) continue;
  corpus.push({ scenario, roles: repos.scenarios.findPlayerRoles(id), locations: repos.locations.findByScenario(id) });
}
// Scenes for ANY arc: one per act, referencing that act's first beat and a scenario location.
const sceneify = (arc, locations) => {
  const a = clone(arc);
  a.acts.forEach((act, i) => {
    act.scenes = [{ id: `s_${i}`, change: 'both', date_label: `Day ${i + 1}`, time_label: 'Noon',
      location_id: locations[i % Math.max(1, locations.length)]?.id || 'x', bridge: `Bridge into act ${i + 1}.`,
      ends_on_beat: act.beats?.[0]?.id || 'x', budget_minutes: 3,
      role_locations: { role_any: locations[0]?.id || 'x' } }];
  });
  return a;
};
const promptFor = (c, st, storyArc) =>
  composeTurnPrompt(st, 'I wait and watch.', { scenario: c.scenario, characters: [], locations: c.locations, clues: [], ...(storyArc ? { storyArc } : {}) });
{
  // The claim is arc vs arc-with-scenes. (Arc vs NO arc legitimately differs for a role whose
  // stored fork is story-bound — McCord and Wills are, at_act:4 — which is Part A, not B1.)
  let compared = 0, bound = 0; const moved = [];
  for (const c of corpus) {
    const arcId = c.scenario.storyArcIds?.[0];
    const arc   = arcId ? repos.storyArcs.findById(arcId) : null;
    if (!arc?.acts?.length) continue;
    const sArc  = sceneify(arc, c.locations);
    const total = c.scenario.sessionTargetMinutes || 15;
    for (const role of c.roles) {
      for (const f of [0, 0.6, 0.8]) {
        const st = quiet(() => buildInitialState(c.scenario, role, c.locations));
        st.elapsedMinutes = total * f; st.remainingMinutes = total - st.elapsedMinutes;
        const p1 = promptFor(c, st, arc);
        if (p1 !== promptFor(c, st, null)) bound++;
        if (p1 !== promptFor(c, st, sArc)) moved.push(`${c.scenario.id}/${role.id}@${f}`);
        compared++;
      }
    }
  }
  check(`${compared} stored role x elapsed prompts byte-identical with scenes on every act`, compared > 0 && moved.length === 0, moved.slice(0, 5).join(', '));
  check(`...including the ${bound} story-bound ones whose prompt the arc does shape`, bound > 0, 'bound roles present, so the arc-reading path was exercised');
}

head('1c. story-bound path (arc IS loaded) — scenes change nothing');
{
  const joanC  = corpus.find(c => c.scenario.id === JOAN_ID);
  check('Joan scenario in corpus', !!joanC);
  const joan   = joanC.roles.find(r => r.id === 'role_joan');
  // Bind Joan's fork to act 4 in memory so the arc loads into play, exactly as a /start would.
  const bound  = { ...joan, defining_moment: { ...joan.defining_moment, at_act: 4 } };
  const plain  = JOAN_ARC, scened = withScenes(JOAN_ARC);
  const total  = joanC.scenario.sessionTargetMinutes || 15;
  let same = true; const diffs = [];
  for (const reached of [[], ['21_feb_1431'], ['21_feb_1431', '17_mar_1431'], ['24_may_1431']]) {
    for (const f of [0, 0.3, 0.6, 0.9]) {
      const st = quiet(() => buildInitialState(joanC.scenario, bound, joanC.locations));
      if (reached.length) st.reachedBeats = [...reached];
      st.elapsedMinutes = total * f; st.remainingMinutes = total - st.elapsedMinutes;
      const eq = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) { same = false; diffs.push(`${label}@${reached.join('+') || '-'}/${f}`); } };
      eq('prompt',   promptFor(joanC, st, plain), promptFor(joanC, st, scened));
      eq('position', storyPosition(st, plain), storyPosition(st, scened));
      eq('due',      definingMomentDue(st, joanC.scenario, plain), definingMomentDue(st, joanC.scenario, scened));
      eq('timing',   forkTimingStatus(st, joanC.scenario, plain), forkTimingStatus(st, joanC.scenario, scened));
      const out = { stateChanges: { beats_reached: ['13_mar_1431', 'nope'] } };
      const s1 = clone(st), s2 = clone(st);
      eq('recorded', quiet(() => recordReachedBeats(s1, out, plain)), quiet(() => recordReachedBeats(s2, out, scened)));
      eq('state',    s1, s2);
    }
  }
  check('bound Joan: prompt / position / due / timing / beat recording identical across 16 states', same, diffs.slice(0, 5).join(', '));
  check('arcBeats identical (the roster the model sees)', JSON.stringify(arcBeats(plain)) === JSON.stringify(arcBeats(scened)));
  // /start loads the arc from the repository — a stored arc WITH scenes loads the same way.
  const fakeRepos = { storyArcs: { findById: () => scened } };
  const st = quiet(() => buildInitialState(joanC.scenario, bound, joanC.locations));
  const loaded = quiet(() => loadForkStoryArc(fakeRepos, joanC.scenario, st));
  check('loadForkStoryArc loads a scene-laden arc and it composes the plain prompt', loaded === scened && promptFor(joanC, st, loaded) === promptFor(joanC, st, plain));
}

// ═══ 2. ROUND TRIP ═══════════════════════════════════════════════════════════
head('2a. editor render → collect (the real admin page functions)');
const html   = fs.readFileSync(path.join(REPO_DIR, 'engine/admin/index.html'), 'utf8');
const script = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/i.exec(html)[1];
const noop = () => {};
const stubEl = new Proxy({}, { get: (t, k) => (k === 'value' ? '' : k === 'style' ? {} : k === 'classList' ? { add: noop, remove: noop } : noop) });
const ctx = vm.createContext({
  document: { addEventListener: noop, getElementById: () => stubEl, querySelector: () => stubEl, querySelectorAll: () => [],
              createElement: () => stubEl, body: stubEl, documentElement: stubEl, head: stubEl },
  window: {}, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { search: '', href: '', pathname: '/admin/' }, navigator: { clipboard: {} },
  fetch: () => new Promise(noop), console,   // never settles: the page's boot-time dashboard load stays parked
  setTimeout: noop, clearTimeout: noop,   // the page's own timers must not fire into the stub DOM mid-test
  alert: noop, confirm: () => false, prompt: () => null, addEventListener: noop, removeEventListener: noop,
  URLSearchParams, JSON, Math, Date, Object, Array, String, Number, Boolean, Set, Map, RegExp,
  Error, Promise, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
});
ctx.window = ctx;
try { vm.runInContext(script, ctx, { filename: 'index.html<script>' }); }
catch (err) { console.log(`      (top-level script threw: ${err.message} — builders may still be defined)`); }
const { renderArcSection, collectEdits, buildSceneCard, sceneRefOptions } = ctx;
check('admin scene builders reachable', [renderArcSection, collectEdits, buildSceneCard, sceneRefOptions].every(f => typeof f === 'function'));

const editorData = arc => ({ scenario: { id: JOAN_ID }, storyArc: clone(arc), locations: clone(JOAN_LOC), playerRoles: clone(JOAN_ROLES) });
const mount = data => {
  const dom = new JSDOM(`<body><div id="c">${renderArcSection(data)}</div></body>`);
  return dom.window.document.getElementById('c');
};
// What the editor would post: collect into a copy of the LOADED data (as handleManualSave does).
const collect = (el, loaded) => { const d = clone(loaded); collectEdits(el, d); return d; };

{
  const loaded = editorData(withScenes(JOAN_ARC));
  const el     = mount(loaded);
  check('one scene list per act', el.querySelectorAll('[data-scene-list]').length === 4);
  check('six scene cards rendered', el.querySelectorAll('.scene-card').length === 6);

  const out = collect(el, loaded);
  out.storyArc.acts.forEach((act, i) => {
    const want = JOAN_SCENES[i];
    if (want.length) check(`act ${i + 1}: every scene field round-trips render → collect`, JSON.stringify(act.scenes) === JSON.stringify(want),
                           JSON.stringify(act.scenes) === JSON.stringify(want) ? `${want.length} scene(s)` : JSON.stringify(act.scenes));
    else check(`act ${i + 1}: no cards → posts an explicit [] (a clear, never an absent key)`, Array.isArray(act.scenes) && act.scenes.length === 0);
  });
  const keep = ['name', 'title', 'actNumber', 'minuteRange', 'beats'];
  check('other act fields untouched by the scene collect', out.storyArc.acts.every((a, i) => keep.every(k => JSON.stringify(a[k]) === JSON.stringify(JOAN_ARC.acts[i][k]))));
  check('arc-level fields untouched', ['id', 'name', 'goal', 'premise', 'opening', 'scenarioId', 'openingSituation'].every(k => out.storyArc[k] === JOAN_ARC[k]));

  // The dropdowns specifically — the timing-checkbox lesson: a control that renders but does
  // not carry its value back is the failure this round trip exists to catch.
  const card = el.querySelector('#scene-rows-act-1 .scene-card:nth-child(2)');
  check('location select shows the stored location', card.querySelector('.scene-location').value === 'joan_prison_cell');
  check('change select shows the stored change', card.querySelector('.scene-change').value === 'place');
  check('ends-on-beat select shows the stored beat', card.querySelector('.scene-ends').value === '17_mar_1431');
  check('role_locations select shows manchon → corridor', card.querySelector('.scene-role-loc[data-role="role_manchon"]').value === 'corridor_castle_rouen');
  check('role_locations: unmoved roles show "with the scene"', card.querySelector('.scene-role-loc[data-role="role_joan"]').value === '');
  const locOpts = [...card.querySelector('.scene-location').options].map(o => o.value).filter(Boolean);
  check('location dropdown offers ONLY Joan\'s 7 locations', locOpts.length === 7 && locOpts.every(id => JOAN_LOC.some(l => l.id === id)), locOpts.join(', '));
  const beatOpts = [...card.querySelector('.scene-ends').options].map(o => o.value).filter(Boolean);
  check('beat dropdown offers every arc beat id', beatOpts.length === arcBeats(JOAN_ARC).length, `${beatOpts.length} beats`);

  // Edit through the controls, then collect.
  card.querySelector('.scene-location').value = 'great_tower_rouen';
  card.querySelector('.scene-change').value   = 'both';
  card.querySelector('.scene-ends').value     = '';
  card.querySelector('.scene-budget').value   = '6';
  card.querySelector('.scene-role-loc[data-role="role_manchon"]').value = '';
  card.querySelector('.scene-role-loc[data-role="role_joan"]').value    = 'old_market_rouen';
  card.querySelector('.scene-time').value     = '';
  const edited = collect(el, loaded).storyArc.acts[1].scenes[1];
  check('edits through every control are collected', JSON.stringify(edited) === JSON.stringify({
    id: 'cell_church_militant', change: 'both', date_label: '17 March 1431', location_id: 'great_tower_rouen',
    bridge: 'The sessions move into her prison.', budget_minutes: 6, role_locations: { role_joan: 'old_market_rouen' } }), JSON.stringify(edited));
}
{
  // Reorder / remove / add, the way the click handler does it (DOM order IS scene order).
  const loaded = editorData(withScenes(JOAN_ARC));
  const el   = mount(loaded);
  const list = el.querySelector('#scene-rows-act-1');
  const [a, b, c] = list.querySelectorAll('.scene-card');
  list.insertBefore(c, a);
  check('reorder: DOM order becomes scene order', collect(el, loaded).storyArc.acts[1].scenes.map(s => s.id).join() === 'tower_torture,hall_male_dress,cell_church_militant');
  b.remove();
  check('remove one: the others keep their fields', JSON.stringify(collect(el, loaded).storyArc.acts[1].scenes) === JSON.stringify([JOAN_SCENES[1][2], JOAN_SCENES[1][0]]));
  el.querySelector('#scene-rows-act-0').querySelectorAll('.scene-card').forEach(n => n.remove());
  const clearedAct = collect(el, loaded).storyArc.acts[0];
  check('remove all in an act → posts [] (the explicit clear the server guard honors)', Array.isArray(clearedAct.scenes) && clearedAct.scenes.length === 0);
  check('...together with the ids it LOADED, fixed at render', JSON.stringify(clearedAct._loaded_scene_ids) === JSON.stringify(JOAN_SCENES[0].map(s => s.id)));
  // Collecting TWICE (the bug a data-derived list would have): the second collect must still
  // report the render-time ids, or a scene deleted here would read as never-seen and come back.
  const twice = clone(loaded); collectEdits(el, twice); collectEdits(el, twice);
  check('a second collect still reports the render-time loaded ids', JSON.stringify(twice.storyArc.acts[0]._loaded_scene_ids) === JSON.stringify(JOAN_SCENES[0].map(s => s.id)));
  const twiceStored = preserveStoredScenes({ storyArcs: { findById: () => withScenes(JOAN_ARC) } }, twice.storyArc);
  check('...so the deletion survives the save guard (act 1 key-absent)', !('scenes' in twiceStored.acts[0]));
  {
    // Same tab: ADD a scene, save, then DELETE it and save again. After the first save the tab
    // has "loaded" its own scene (commitLoadedSceneIds), so the second save may delete it.
    const { commitLoadedSceneIds } = ctx;
    const d0 = editorData(JOAN_ARC), el2 = mount(d0), w = el2.querySelector('#scene-rows-act-3');
    w.insertAdjacentHTML('beforeend', buildSceneCard({ id: 'tmp_scene', change: 'both', location_id: 'joan_prison_cell', ends_on_beat: '28_may_1431' }, 3, sceneRefOptions(d0)));
    const d1 = clone(d0); collectEdits(el2, d1);
    const saved1 = preserveStoredScenes({ storyArcs: { findById: () => JOAN_ARC } }, clone(d1.storyArc));
    check('same tab: added scene saved', saved1.acts[3].scenes?.[0]?.id === 'tmp_scene');
    commitLoadedSceneIds(el2, d1);
    w.querySelector('.scene-card').remove();
    const d2 = clone(d1); collectEdits(el2, d2);
    check('same tab: after a save, the loaded list includes what it saved', JSON.stringify(d2.storyArc.acts[3]._loaded_scene_ids) === '["tmp_scene"]');
    const saved2 = preserveStoredScenes({ storyArcs: { findById: () => saved1 } }, clone(d2.storyArc));
    check('same tab: deleting the scene it just added sticks (key-absent)', !('scenes' in saved2.acts[3]));
  }
  // An added, untouched card is dropped; an added card with content is kept.
  const wrap = el.querySelector('#scene-rows-act-3');
  wrap.insertAdjacentHTML('beforeend', buildSceneCard({}, 3, sceneRefOptions(loaded)));
  check('an empty added card is dropped (act 4 posts [])', collect(el, loaded).storyArc.acts[3].scenes?.length === 0);
  wrap.querySelector('.scene-id').value = 'cell_relapse';
  wrap.querySelector('.scene-location').value = 'joan_prison_cell';
  wrap.querySelector('.scene-ends').value = '28_may_1431';
  check('a filled added card is collected with the default change "both"', JSON.stringify(collect(el, loaded).storyArc.acts[3].scenes) === JSON.stringify([
    { id: 'cell_relapse', change: 'both', date_label: '', location_id: 'joan_prison_cell', bridge: '', ends_on_beat: '28_may_1431' }]));
}
{
  // An arc with NO scenes: the collect must not add a key to any act.
  const loaded = editorData(JOAN_ARC);
  const out = collect(mount(loaded), loaded);
  check('no-scenes arc: collect posts [] on every act', out.storyArc.acts.every(a => Array.isArray(a.scenes) && a.scenes.length === 0));
  // ...which the server guard strips: what lands on disk is the arc exactly as it was.
  const guarded = preserveStoredScenes({ storyArcs: { findById: () => JOAN_ARC } }, out.storyArc);
  check('no-scenes arc: after the save guard, acts byte-identical to the stored arc', JSON.stringify(guarded.acts) === JSON.stringify(JOAN_ARC.acts));
}
{
  // A stored reference that is no longer valid is SHOWN and CARRIED, never silently swapped.
  const bad = withScenes(JOAN_ARC);
  bad.acts[0].scenes[0].location_id  = 'b59_conning_tower';
  bad.acts[0].scenes[0].ends_on_beat = 'deleted_beat';
  bad.acts[0].scenes[0].role_locations = { role_gone: 'joan_prison_cell' };
  const loaded = editorData(bad);
  const out = collect(mount(loaded), loaded).storyArc.acts[0].scenes[0];
  check('orphan location / beat / role are carried through the editor unchanged',
        out.location_id === 'b59_conning_tower' && out.ends_on_beat === 'deleted_beat' && out.role_locations?.role_gone === 'joan_prison_cell', JSON.stringify(out));
}

head('2b. legacy Story Arcs form — its save keeps scenes');
{
  const { extractFormData, buildFormHTML } = ctx;
  const cfg = vm.runInContext('ENTITIES["story-arcs"]', ctx);
  // This form flattens beats to strings and cannot render structured {id, description} beats
  // at all (pre-existing: buildDynamicList escapes each beat as a string), so it is exercised
  // on the legacy string-beat shape it was written for.
  const item = withScenes(JOAN_ARC);
  item.acts.forEach(a => { a.beats = a.beats.map(b => b.description); });
  const form = new JSDOM(`<body>${buildFormHTML(cfg, item, {})}</body>`).window.document.getElementById('entity-form');
  const out  = extractFormData(cfg, form, item);
  check('legacy form save carries every act\'s scenes through', out.acts.every((a, i) => JSON.stringify(a.scenes) === JSON.stringify(item.acts[i].scenes)));
  check('...and act 4 stays key-absent', !('scenes' in out.acts[3]));
}

head('2c. PUT /story-arcs/:id → disk → GET (real router, scratch store)');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-test-'));
  fs.mkdirSync(path.join(tmp, 'story_arcs'));
  // Seed the scratch store with the scenes-stripped fixture (not the live file, which has scenes).
  fs.writeFileSync(path.join(tmp, 'story_arcs', `${JOAN_ARC.id}.json`), JSON.stringify(JOAN_ARC, null, 2));
  const scratch = new JsonFileStore(tmp);
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', createAdminRouter({ ...repos, storyArcs: new StoryArcRepository(scratch) }, {}));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/story-arcs/${JOAN_ARC.id}`;
  try {
    const put = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(withScenes(JOAN_ARC)) });
    check('PUT a valid scene-laden arc → 200', put.status === 200, String(put.status));
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'story_arcs', `${JOAN_ARC.id}.json`), 'utf8'));
    const got = await (await fetch(base)).json();
    for (const [label, doc] of [['disk', onDisk], ['GET', got]]) {
      check(`${label}: every scene field persisted, act 4 key-absent`,
            doc.acts.every((a, i) => JOAN_SCENES[i].length ? JSON.stringify(a.scenes) === JSON.stringify(JOAN_SCENES[i]) : !('scenes' in a)));
      check(`${label}: other act fields persisted`, doc.acts.every((a, i) => ['name', 'title', 'actNumber', 'minuteRange', 'beats'].every(k => JSON.stringify(a[k]) === JSON.stringify(JOAN_ARC.acts[i][k]))));
    }
    // Reload into the editor from what came back, collect, and compare — the load half.
    const reloaded = editorData(got);
    const again = collect(mount(reloaded), reloaded);
    const againGuarded = preserveStoredScenes({ storyArcs: { findById: () => got } }, again.storyArc);
    check('GET → editor → collect → guard reproduces the saved scenes exactly', JSON.stringify(againGuarded.acts) === JSON.stringify(got.acts));

    const bad = withScenes(JOAN_ARC); bad.acts[1].scenes[0].location_id = 'great_hall_watergate';
    const rej = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad) });
    const rejBody = await rej.json();
    check('PUT with an invalid location → 400 SCENES_INVALID', rej.status === 400 && rejBody.code === 'SCENES_INVALID', rejBody.error);
    check('...and the stored arc is unchanged by the rejected PUT', JSON.stringify((await (await fetch(base)).json()).acts) === JSON.stringify(got.acts));
    const none = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(JOAN_ARC) });
    check('PUT an arc with NO scenes keys → 200', none.status === 200);
    const putArc = body => fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const stored = async () => (await (await fetch(base)).json()).acts;
    const sameScenes = acts => acts.every((a, i) => JOAN_SCENES[i].length ? JSON.stringify(a.scenes) === JSON.stringify(JOAN_SCENES[i]) : !('scenes' in a));

    head('4. stale-tab guard — through the real PUT route');
    // (the PUT just above IS the stale case: an old-page tab posts no scenes keys at all)
    check('old-page tab (no scenes keys anywhere) → stored scenes KEPT', sameScenes(await stored()));
    const stale = clone(JOAN_ARC); stale.goal = 'edited in a stale tab';
    await putArc(stale);
    const afterStale = await (await fetch(base)).json();
    check('stale tab OTHER edits still land (goal saved)', afterStale.goal === 'edited in a stale tab');
    check('...while its absent scenes do not erase the stored ones', sameScenes(afterStale.acts));
    // A current tab (loaded WITH the scenes) clears one act ([]), leaves one absent, and edits
    // another. It posts what it loaded, as the editor does.
    const cur = withScenes(JOAN_ARC);
    const loadedIds = n => JOAN_SCENES[n].map(s => s.id);
    cur.acts.forEach((x, n) => { x._loaded_scene_ids = loadedIds(n); });
    cur.acts[0].scenes = [];
    delete cur.acts[1].scenes;
    cur.acts[2].scenes[0].bridge = 'Edited bridge.';
    cur.acts[3].scenes = [];
    const curRes = await putArc(cur);
    const a = await stored();
    check('current-tab save → 200', curRes.status === 200);
    check('explicit [] clears: act 1 scenes gone, key DELETED (not stored as [])', !('scenes' in a[0]));
    check('absent in the same save: act 2 scenes restored', JSON.stringify(a[1].scenes) === JSON.stringify(JOAN_SCENES[1]));
    check('posted scenes honored: act 3 bridge edited', a[2].scenes?.[0]?.bridge === 'Edited bridge.');
    check('[] on an act that never had scenes: stays key-absent', !('scenes' in a[3]));
    check('_loaded_scene_ids is transport only — never stored', a.every(x => !('_loaded_scene_ids' in x)));

    head('4b. a save cannot clear scenes it never loaded');
    await putArc(withScenes(JOAN_ARC));
    // THE GAP: a current-page tab opened BEFORE the scenes existed. It rendered empty lists, so
    // it posts scenes: [] on every act with an EMPTY loaded list.
    const early = clone(JOAN_ARC); early.goal = 'saved from an early tab';
    early.acts.forEach(x => { x.scenes = []; x._loaded_scene_ids = []; });
    const er = await putArc(early);
    const afterEarly = await (await fetch(base)).json();
    check('early current-page tab ([] + nothing loaded) → 200, its other edits land', er.status === 200 && afterEarly.goal === 'saved from an early tab');
    check('...and every stored scene is KEPT', sameScenes(afterEarly.acts));
    // Same tab adds one scene of its own to act 4: it lands, and nobody else's scenes are lost.
    const early2 = clone(JOAN_ARC);
    early2.acts.forEach(x => { x.scenes = []; x._loaded_scene_ids = []; });
    early2.acts[3].scenes = [{ id: 'cell_relapse', change: 'both', date_label: '28 May 1431', location_id: 'joan_prison_cell', bridge: '', ends_on_beat: '28_may_1431' }];
    await putArc(early2);
    const e2 = await stored();
    check('early tab ADDING a scene: its scene lands', e2[3].scenes?.some(s => s.id === 'cell_relapse'));
    check('...and acts 1–3 keep every stored scene', [0, 1, 2].every(n => JSON.stringify(e2[n].scenes) === JSON.stringify(JOAN_SCENES[n])));
    // A tab that loaded [A, B, C] deletes B, while someone else added D since it loaded:
    // B goes (it was loaded), D stays (it was not), appended after the posted scenes.
    const withD = withScenes(JOAN_ARC);
    withD.acts[1].scenes.push({ id: 'added_elsewhere', change: 'time', date_label: '1 April 1431', location_id: 'joan_prison_cell', bridge: '', budget_minutes: 2 });
    await putArc(withD);
    const partial = withScenes(JOAN_ARC);
    partial.acts.forEach((x, n) => { x._loaded_scene_ids = loadedIds(n); });
    partial.acts[1].scenes = partial.acts[1].scenes.filter(s => s.id !== 'cell_church_militant');
    await putArc(partial);
    const pAct = (await stored())[1].scenes.map(s => s.id).join(',');
    check('loaded scene deleted, unseen scene kept & appended', pAct === 'hall_male_dress,tower_torture,added_elsewhere', pAct);
    // No list at all (the console/API, a pre-guard tab): adds and edits, never deletes.
    await putArc(withScenes(JOAN_ARC));
    const noList = withScenes(JOAN_ARC);
    noList.acts[0].scenes = [];
    noList.acts[2].scenes[0].bridge = 'API edit.';
    await putArc(noList);
    const nl = await stored();
    check('no loaded list + [] → nothing deleted', JSON.stringify(nl[0].scenes) === JSON.stringify(JOAN_SCENES[0]));
    check('no loaded list + edit → edit honored', nl[2].scenes?.[0]?.bridge === 'API edit.');
    // Reset to exactly JOAN_SCENES. Since 4b a post can only delete what it loaded, so the
    // reset loads first — the 4b tests left extra scenes behind in acts 2 and 4.
    const resetScenes = async () => {
      const cur = await stored();
      const r = withScenes(JOAN_ARC);
      r.acts.forEach((x, n) => { x._loaded_scene_ids = (cur[n].scenes || []).map(s => s.id); if (!x.scenes) x.scenes = []; });
      await putArc(r);
      check('reset to the fixture scenes', sameScenes(await stored()));
    };
    await resetScenes();
    // Acts matched by actNumber, not position: a payload with acts in another order must not
    // move act 2's scenes onto whatever sits at index 1.
    const shuffled = clone(JOAN_ARC); shuffled.acts = [shuffled.acts[2], shuffled.acts[1], shuffled.acts[0], shuffled.acts[3]];
    await putArc(shuffled);
    const byNum = Object.fromEntries((await stored()).map(x => [x.actNumber, x]));
    check('restored scenes follow actNumber, not array position',
          [1, 2, 3].every(n => JSON.stringify(byNum[n].scenes) === JSON.stringify(JOAN_SCENES[n - 1])) && !('scenes' in byNum[4]));
    // Restored scenes are validated too: a stale tab that deleted the beat a stored scene ends
    // on is refused by name instead of storing a dangling reference.
    await putArc(withScenes(JOAN_ARC));
    const staleBeat = clone(JOAN_ARC); staleBeat.acts[0].beats = staleBeat.acts[0].beats.filter(b => b.id !== '24_feb_1431');
    const sb = await putArc(staleBeat); const sbBody = await sb.json();
    check('stale tab removing a beat a stored scene needs → 400 naming it', sb.status === 400 && /24_feb_1431/.test(sbBody.error || ''), sbBody.error);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══ 3. VALIDATION ═══════════════════════════════════════════════════════════
head('3. validateArcScenes — the check both save routes run');
{
  const refs = sceneRefSets(repos, JOAN_ID);
  check('ref sets are Joan\'s own', refs.locationIds.size === 7 && refs.roleIds.has('role_joan'));
  check('valid Joan scenes → no errors', validateArcScenes(withScenes(JOAN_ARC), refs).length === 0, validateArcScenes(withScenes(JOAN_ARC), refs).join(' | '));
  check('no scenes anywhere → no errors (gated)', validateArcScenes(JOAN_ARC, refs).length === 0);
  check('every stored arc validates clean (scenes included)', repos.storyArcs.findByScenario().every(a => validateArcScenes(a, sceneRefSets(repos, a.scenarioId)).length === 0));

  const foreign = repos.locations.findAll().find(l => l.scenarioId !== JOAN_ID).id;
  const cases = [
    ['location from ANOTHER scenario',   s => { s.location_id = foreign; },               /not a location in this scenario/],
    ['missing location',                 s => { delete s.location_id; },                  /location is required/],
    ['unknown ends_on_beat',             s => { s.ends_on_beat = 'no_such_beat'; },       /not a beat in this arc/],
    ['role_locations → foreign location', s => { s.role_locations = { role_joan: foreign }; }, /role_locations\.role_joan/],
    ['role_locations → unknown role',    s => { s.role_locations = { role_nobody: 'joan_prison_cell' }; }, /not a role in this scenario/],
    ['bad change',                       s => { s.change = 'mood'; },                     /change must be one of/],
    ['non-snake id',                     s => { s.id = 'Hall Feb'; },                     /snake_case/],
    ['no end at all',                    s => { delete s.ends_on_beat; delete s.budget_minutes; }, /needs an end/],
    ['budget as a string',               s => { s.budget_minutes = '5'; },                /budget_minutes must be a positive number/],
    ['zero budget',                      s => { s.budget_minutes = 0; },                  /budget_minutes must be a positive number/],
  ];
  for (const [label, mutate, re] of cases) {
    const arc = withScenes(JOAN_ARC); mutate(arc.acts[0].scenes[0]);
    const errs = validateArcScenes(arc, refs);
    check(`rejects: ${label}`, errs.length > 0 && errs.some(e => re.test(e)), errs.join(' | '));
  }
  const dup = withScenes(JOAN_ARC); dup.acts[2].scenes[0].id = 'hall_feb_sessions';
  check('rejects: duplicate scene id across acts', validateArcScenes(dup, refs).some(e => /used by another scene/.test(e)));
  const notList = clone(JOAN_ARC); notList.acts[0].scenes = { id: 'x' };
  check('rejects: scenes not a list', validateArcScenes(notList, refs).some(e => /must be a list/.test(e)));
  // A location posted in the same bundle (added in this edit, saved after the arc) counts.
  const fresh = withScenes(JOAN_ARC); fresh.acts[0].scenes[0].location_id = 'new_room';
  check('a location posted in the same bundle save is accepted',
        validateArcScenes(fresh, sceneRefSets(repos, JOAN_ID, [{ id: 'new_room', scenarioId: JOAN_ID }])).length === 0);
  const noneStored = { storyArcs: { findById: () => null } };
  check('guard: brand-new arc (nothing stored) is left as posted', JSON.stringify(preserveStoredScenes(noneStored, clone(JOAN_ARC)).acts) === JSON.stringify(JOAN_ARC.acts));
  check('guard: absent key over a stored act with no scenes stays absent',
        preserveStoredScenes({ storyArcs: { findById: () => JOAN_ARC } }, clone(JOAN_ARC)).acts.every(a => !('scenes' in a)));
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll scene assertions passed.');
process.exit(fails ? 1 : 0);
