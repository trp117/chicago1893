// STEP 5 — the delete route, the hand-authored delete guard, and the reclassification
// cleanup tie-in, plus the three-layer composition check.
//
// Creates and destroys its own scratch role in BOTH stores (needs Supabase credentials).
// The answer keys (Trude, Jäger) are only ever probed with calls that must be REFUSED, and
// are byte-compared before and after.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Resolve the repo from this file's own location, so the suite runs from anywhere.
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = pathToFileURL(REPO_DIR).href;

// STEP 5 — the delete route, the hand-authored delete guard, and the reclassification
// cleanup tie-in. Also the composition check: the archetype gate, the hand-authored
// protection and the delete route must each hold on their own and none may bypass another.
//
// Every destructive assertion runs against a SCRATCH ROLE this test creates and destroys.
// The answer keys (Trude, Jäger) are only ever probed with calls that must be REFUSED, and
// are byte-compared before and after to prove nothing touched them.

const ROOT_URL = REPO_URL;
const ROOT     = REPO_DIR;
const DATA_DIR = path.join(ROOT, 'engine/data');

const { JSDOM, VirtualConsole } = await import('jsdom');
const express   = (await import('express')).default;
const { DualWriteStore }      = await import(`${ROOT_URL}/lib/DualWriteStore.js`);
const { supabase }            = await import(`${ROOT_URL}/lib/supabase.js`);
const { ScenarioRepository }  = await import(`${ROOT_URL}/engine/repositories/ScenarioRepository.js`);
const { CharacterRepository } = await import(`${ROOT_URL}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }  = await import(`${ROOT_URL}/engine/repositories/LocationRepository.js`);
const { ClueRepository }      = await import(`${ROOT_URL}/engine/repositories/ClueRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT_URL}/engine/repositories/StoryArcRepository.js`);
const { PlayerRepository }    = await import(`${ROOT_URL}/engine/repositories/PlayerRepository.js`);
const { SessionRepository }   = await import(`${ROOT_URL}/engine/repositories/SessionRepository.js`);
const admin = await import(`${ROOT_URL}/engine/admin/adminRouter.js`);

let fails = 0;
let openWindow = null;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};

// DualWriteStore, deliberately: the delete route must land in BOTH stores, and the only way
// to prove that is to use the store the server uses. Everything it writes is a scratch role
// this test removes from both stores in its finally block.
const store = new DualWriteStore(DATA_DIR);
const repos = {
  scenarios:  new ScenarioRepository(store),  characters: new CharacterRepository(store),
  locations:  new LocationRepository(store),  clues:      new ClueRepository(store),
  storyArcs:  new StoryArcRepository(store),  players:    new PlayerRepository(store),
  sessions:   new SessionRepository(store),
};
const fileOf   = id => path.join(DATA_DIR, 'scenarios/player_roles', `${id}.json`);
const readRole = id => JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
const remote   = async id => {
  const { data, error } = await supabase.from('scenario_data').select('data')
    .eq('data_type', 'player_role').eq('id', id).limit(1);
  if (error) throw error;
  return data?.[0]?.data ?? null;
};

const app = express();
app.use(express.json());
app.use('/admin/api', admin.createAdminRouter(repos, { anthropicApiKey: 'test-key-not-used' }));
const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}/admin/api`;
const call = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const SCRATCH = 'role_archetype_delete_scratch';
const BLOCK = {
  id: 'scratch_defining_choice',
  setup: 'Authored setup prose for the scratch fixture.',
  options: [
    { id: 'hold',   text: 'Hold the line and say nothing at all about it.' },
    { id: 'speak',  text: 'Speak up now, before the moment closes on you.' },
    { id: 'defer',  text: 'Defer to the man with the clipboard and the orders.' },
  ],
  principal_transition: { type: 'decision_made', moment: 'scratch_defining_choice' },
  time_advance: 0, at_elapsed_fraction: 0.6, generated: true, reviewed: false,
};
const NOTES = {
  partial: { what_happened: 'A partial outcome for the fixture.', who_present: 'nobody', emotional_weight: 'weight' },
  failure: { what_happened: 'A failure outcome for the fixture.', who_present: 'nobody', emotional_weight: 'weight' },
};

try {
  // ═══ 1. Delete a GENERATED block ═══════════════════════════════════════════
  console.log('\n[1] delete a GENERATED defining_moment — additive, both stores\n');
  repos.scenarios.savePlayerRole({
    id: SCRATCH, name: 'Scratch Fixture — Delete Test', scenarioId: 'schiller_corner_1914',
    description: 'Temporary fixture created by tests/delete.test.mjs.',
    fate_mode: 'committed', character_type: 'fictional', archetype: 'crucible-open',
    briefing: 'Fixture briefing.', startingKnowledge: ['one', 'two'],
    defining_moment: JSON.parse(JSON.stringify(BLOCK)), ending_notes: JSON.parse(JSON.stringify(NOTES)),
  });
  store._cache.clear();
  await new Promise(r => setTimeout(r, 1500));

  const before     = readRole(SCRATCH);
  const beforeKeys = Object.keys(before);
  check('fixture created with a generated block', before.defining_moment?.id === BLOCK.id && before.defining_moment.generated === true);
  check('fixture present in Supabase too', (await remote(SCRATCH))?.defining_moment?.id === BLOCK.id);

  const del = await call('PATCH', `/player-roles/${SCRATCH}/defining-moment`, { delete: true });
  check('generated block deleted without a typed token', del.status === 200 && del.body.deleted === true, `${del.status}`);
  check('response names what was removed', del.body.removed === BLOCK.id, del.body.removed);

  store._cache.clear();
  const after = readRole(SCRATCH);
  check('defining_moment gone from disk', after.defining_moment === undefined);
  check('ADDITIVE — every other key intact',
        JSON.stringify(beforeKeys.filter(k => k !== 'defining_moment').sort()) === JSON.stringify(Object.keys(after).sort()),
        Object.keys(after).join(','));
  const changed = Object.keys(after).filter(k => k !== 'updatedAt' && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  check('BYTE-VERIFIED — no other value changed', changed.length === 0, changed.join(',') || 'all identical');
  check('ending_notes survived the fork deletion', JSON.stringify(after.ending_notes) === JSON.stringify(before.ending_notes));

  await new Promise(r => setTimeout(r, 1500));
  check('BOTH STORES — Supabase reflects the removal', (await remote(SCRATCH))?.defining_moment === undefined);

  // ═══ 2. HAND-AUTHORED delete guard — must refuse, must not delete ══════════
  console.log('\n[2] hand-authored blocks (Jäger, Trude) — guard must REFUSE\n');
  for (const id of ['role_gatekeeper', 'role_trude_harms']) {
    const raw = fs.readFileSync(fileOf(id), 'utf8');
    const dm  = JSON.parse(raw).defining_moment;
    check(`${id.padEnd(18)} is hand-authored (no generated flag)`, dm.generated !== true);

    const noToken = await call('PATCH', `/player-roles/${id}/defining-moment`, { delete: true });
    check(`${id.padEnd(18)} REFUSED without the typed token`, noToken.status === 409 && noToken.body.handAuthored === true, `${noToken.status}`);
    check(`${id.padEnd(18)} refusal names the block and the backup file`,
          (noToken.body.error || '').includes(dm.id) && /_defining_moment_blocks\.md/.test(noToken.body.error || ''));

    const wrongToken = await call('PATCH', `/player-roles/${id}/defining-moment`, { delete: true, confirm: 'delete' });
    check(`${id.padEnd(18)} REFUSED with a near-miss token ("delete")`, wrongToken.status === 409);
    const replaceToken = await call('PATCH', `/player-roles/${id}/defining-moment`, { delete: true, confirm: 'REPLACE' });
    check(`${id.padEnd(18)} REFUSED with the regenerate route's token ("REPLACE")`, replaceToken.status === 409);

    check(`${id.padEnd(18)} ANSWER KEY UNTOUCHED — file byte-identical`, fs.readFileSync(fileOf(id), 'utf8') === raw);
  }

  // ═══ 3. Reclassification → cleanup flag → removal, in the real editor ═════
  console.log('\n[3] reclassify to instrument with a fork present — UI flags and removes\n');
  {
    // Put a fresh generated block back on the scratch role.
    const role = readRole(SCRATCH);
    repos.scenarios.savePlayerRole({ ...role, defining_moment: JSON.parse(JSON.stringify(BLOCK)) });
    store._cache.clear();

    const html = fs.readFileSync(path.join(ROOT, 'engine/admin/index.html'), 'utf8');
    const vc = new VirtualConsole();
    vc.on('jsdomError', () => {});
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/admin/', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(w) {
        w.fetch = (url, opts) => fetch(`http://127.0.0.1:${server.address().port}` + String(url), opts);
        w.confirm = () => true;
        w.prompt  = () => 'DELETE';
        w.alert   = () => {};
      } });
    const win = dom.window;
    await new Promise(r => win.addEventListener('load', r, { once: true }));
    await new Promise(r => setTimeout(r, 300));

    const fixture = readRole(SCRATCH);
    const data    = { scenario: { introduction: { sections: [] } }, playerRoles: [fixture] };
    const formEl  = win.document.createElement('form');
    formEl.innerHTML = win.renderArchetypeSection(fixture, 0)
      + win.renderDefiningMomentSection(fixture, 0, data)
      + `<div id="endings-gate-0">${win.renderEndingsGatePanel(fixture, 0)}</div>`;
    win.document.body.appendChild(formEl);
    win.__bindArchetypeHandlers(formEl, data, fixture.scenarioId);
    win.__bindDefiningMomentHandlers(formEl, data, fixture.scenarioId);

    const cleanupText = () => formEl.querySelector('.archetype-cleanup')?.textContent.replace(/\s+/g, ' ').trim() || '';
    check('crucible-open: no cleanup flag while the fork is allowed', cleanupText() === '');

    const sel = formEl.querySelector('.archetype-select');
    sel.value = 'instrument';
    sel.dispatchEvent(new win.Event('change', { bubbles: true }));

    const t = cleanupText();
    check('instrument: cleanup panel appears', /Disallowed artifact still present/.test(t));
    check('cleanup flags the fork in the reviewer\'s words', /This role now has no fork by its archetype/.test(t) && t.includes(BLOCK.id));
    check('cleanup flags the graded endings too', /This role now has no graded endings by its archetype/.test(t));
    check('cleanup offers a Remove button for the fork', !!formEl.querySelector('.archetype-cleanup .remove-dm-btn'));
    check('cleanup offers a Remove button for the endings', !!formEl.querySelector('.archetype-cleanup .remove-endings-btn'));
    check('nothing removed merely by flagging', readRole(SCRATCH).defining_moment?.id === BLOCK.id);

    formEl.querySelector('.archetype-cleanup .remove-dm-btn').click();
    for (let i = 0; i < 60 && readRole(SCRATCH).defining_moment; i++) { store._cache.clear(); await new Promise(r => setTimeout(r, 200)); }
    store._cache.clear();
    check('Remove button actually removed the block via the route', readRole(SCRATCH).defining_moment === undefined);
    check('local editor state mirrors the deletion (no resurrection on next Save)', data.playerRoles[0].defining_moment === undefined);
    check('cleanup panel now flags only the endings', !/no fork by its archetype/.test(cleanupText()) && /no graded endings/.test(cleanupText()));

    formEl.querySelector('.archetype-cleanup .remove-endings-btn').click();
    for (let i = 0; i < 60 && readRole(SCRATCH).ending_notes; i++) { store._cache.clear(); await new Promise(r => setTimeout(r, 200)); }
    store._cache.clear();
    check('ending notes removed via the route', readRole(SCRATCH).ending_notes === undefined);
    check('cleanup panel is gone once nothing disallowed remains', cleanupText() === '');
    openWindow = win;
  }

  // ═══ 4. The three layers compose ══════════════════════════════════════════
  console.log('\n[4] composition — archetype gate / hand-authored guard / delete route\n');
  {
    // (a) The archetype gate blocks GENERATION but never blocks REMOVAL.
    const role = readRole(SCRATCH);
    repos.scenarios.savePlayerRole({ ...role, archetype: 'instrument', defining_moment: JSON.parse(JSON.stringify(BLOCK)) });
    store._cache.clear();
    const gen = await call('POST', `/scenarios/schiller_corner_1914/roles/${SCRATCH}/generate-defining-moment`, { overwrite: true });
    check('(a) instrument: fork GENERATION refused by the archetype gate', gen.status === 422 && gen.body.artifact === 'fork', `${gen.status}`);
    const rm = await call('PATCH', `/player-roles/${SCRATCH}/defining-moment`, { delete: true });
    check('(a) instrument: fork REMOVAL still allowed — the gate does not strand the artifact', rm.status === 200 && rm.body.deleted === true, `${rm.status}`);

    // (b) An ALLOWED archetype does not buy passage past the hand-authored guard.
    const jaeger = fs.readFileSync(fileOf('role_gatekeeper'), 'utf8');
    check('(b) Jäger is crucible-fixed — fork generation permitted by archetype',
          admin.archetypeAllows(readRole('role_gatekeeper'), 'fork').allowed === true);
    const regen = await call('POST', `/scenarios/bornholmer_strasse_first_breach/roles/role_gatekeeper/generate-defining-moment`, {});
    check('(b) …yet regeneration is still refused 409 by the overwrite guard', regen.status === 409, `${regen.status}`);
    const delJ = await call('PATCH', `/player-roles/role_gatekeeper/defining-moment`, { delete: true });
    check('(b) …and deletion is still refused 409 by the hand-authored guard', delJ.status === 409 && delJ.body.handAuthored === true, `${delJ.status}`);
    check('(b) Jäger untouched throughout', fs.readFileSync(fileOf('role_gatekeeper'), 'utf8') === jaeger);

    // (c) A BLOCKED archetype does not weaken the hand-authored guard either: the gate
    //     answers first, and the block is still there afterwards.
    const lojka = fs.readFileSync(fileOf('role_lojka'), 'utf8');
    const genL  = await call('POST', `/scenarios/schiller_corner_1914/roles/role_lojka/generate-defining-moment`, { overwrite: true });
    check('(c) Lojka: overwrite:true does not get past the archetype gate', genL.status === 422 && genL.body.archetype === 'instrument');
    check('(c) Lojka untouched', fs.readFileSync(fileOf('role_lojka'), 'utf8') === lojka);

    // (d) The delete route refuses a role with nothing to delete, and a malformed body.
    const none = await call('PATCH', `/player-roles/${SCRATCH}/defining-moment`, { delete: true });
    check('(d) deleting a block that is not there → 404, not a silent success', none.status === 404 && none.body.deleted === false);
    const bad = await call('PATCH', `/player-roles/${SCRATCH}/defining-moment`, {});
    check('(d) a body without delete:true is refused 400', bad.status === 400);
  }
} finally {
  try { openWindow?.close(); } catch {}
  server.close();
  const existed = repos.scenarios.deletePlayerRole(SCRATCH);
  store._cache.clear();
  await new Promise(r => setTimeout(r, 1500));
  check('scratch fixture removed from disk', existed && !fs.existsSync(fileOf(SCRATCH)));
  try { check('scratch fixture removed from Supabase', (await remote(SCRATCH)) === null); }
  catch (err) { console.log(`  ??  Supabase cleanup unverified — ${err.message}`); }

  for (const id of ['role_trude_harms', 'role_gatekeeper', 'role_princip', 'role_lojka', 'role_mila', 'role_chronicler']) {
    check(`${id.padEnd(18)} untouched`, readRole(id).updatedAt.startsWith('2026-08-24T22:18:26'), readRole(id).archetype);
  }
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll delete / cleanup / composition tests passed.');
process.exit(fails ? 1 : 0);
