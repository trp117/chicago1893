// TIMING CONFIRMATION (B3a) — the anchored-role "timing rule" box, made durable.
//
// It used to be a spent one-time gate: rendered unticked on every load, never stored, and
// nothing un-ticked it when the fork's binding moved — so "confirmed at clock 0.75" would
// silently stand for a fork later bound to a scene. Now defining_moment.timing_confirmed is a
// RECORD of the timing it confirmed (at_elapsed_fraction / at_act / at_beat / at_scene /
// fallback_at_elapsed_fraction) and counts only while it equals the block's current timing.
//
// Part 1: the server rule (reconcileTimingConfirmed via preserveStoredRoleBlocks — the path
// both editor saves take). Part 2: no stored role changes shape (nothing has the key yet).
// Part 3: the real editor in jsdom — the box renders from the record, posts through
// collectEdits, and a timing edit un-ticks it. No writes to disk; no model calls.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;
const { JSDOM }  = await import('jsdom');
const admin      = await import(`${ROOT}/engine/admin/adminRouter.js`);
const { preserveStoredRoleBlocks, normalizeForkBinding, forkTimingRecord, timingConfirmedCurrent, reconcileTimingConfirmed } = admin;

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head  = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const clone = o => JSON.parse(JSON.stringify(o));
const quiet = fn => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return fn(); } finally { console.log = l; console.warn = w; } };

const ROLES_DIR = path.join(REPO_DIR, 'engine/data/scenarios/player_roles');
const readRole  = id => JSON.parse(fs.readFileSync(path.join(ROLES_DIR, `${id}.json`), 'utf8'));
const JOAN = readRole('role_joan');
const reposWith = stored => ({ scenarios: { findPlayerRole: () => (stored ? clone(stored) : null) } });
const save = (posted, stored) => quiet(() => preserveStoredRoleBlocks(reposWith(stored), clone(posted)));
const withDm = (role, patch) => ({ ...clone(role), defining_moment: { ...clone(role.defining_moment), ...patch } });

// ═══ 1. the server rule ═══════════════════════════════════════════════════════
head('1. reconcile — what is stored');
{
  check('fixture: Joan has a fork on the clock (0.75), no confirmation stored', JOAN.defining_moment?.at_elapsed_fraction === 0.75 && !('timing_confirmed' in JOAN.defining_moment));
  const ticked = save(withDm(JOAN, { timing_confirmed: true }), JOAN).defining_moment;
  check('box ticked (true) → the record of the saved timing is stored', JSON.stringify(ticked.timing_confirmed) === JSON.stringify(forkTimingRecord(ticked)) && ticked.timing_confirmed.at_elapsed_fraction === 0.75, JSON.stringify(ticked.timing_confirmed));
  check('...and it reads as current', timingConfirmedCurrent(ticked));
  const storedConfirmed = { ...clone(JOAN), defining_moment: ticked };

  check('box unticked (false) → cleared', !('timing_confirmed' in save(withDm(storedConfirmed, { timing_confirmed: false }), storedConfirmed).defining_moment));
  const noKey = withDm(storedConfirmed, {}); delete noKey.defining_moment.timing_confirmed;
  check('no key sent (stale tab / no box), timing unchanged → stored record kept', timingConfirmedCurrent(save(noKey, storedConfirmed).defining_moment));
  check('the record round-tripped as an object, timing unchanged → kept', timingConfirmedCurrent(save(storedConfirmed, storedConfirmed).defining_moment));

  const CHANGES = {
    at_elapsed_fraction: 0.6, at_act: 4, at_beat: '28_may_1431', at_scene: 'scene_28_may', fallback_at_elapsed_fraction: 0.8,
  };
  for (const [k, v] of Object.entries(CHANGES)) {
    const viaKey   = save(withDm(storedConfirmed, { [k]: v }), storedConfirmed).defining_moment;
    const noKeyCh  = withDm(storedConfirmed, { [k]: v }); delete noKeyCh.defining_moment.timing_confirmed;
    const viaNoKey = save(noKeyCh, storedConfirmed).defining_moment;
    check(`${k} changed → confirmation cleared (record sent: ${!('timing_confirmed' in viaKey)}, no key sent: ${!('timing_confirmed' in viaNoKey)})`, !('timing_confirmed' in viaKey) && !('timing_confirmed' in viaNoKey));
  }
  const retick = save(withDm(storedConfirmed, { at_act: 4, timing_confirmed: true }), storedConfirmed).defining_moment;
  check('timing changed AND re-ticked → a fresh record of the NEW timing', timingConfirmedCurrent(retick) && retick.timing_confirmed.at_act === 4);
  const fbBack = withDm(storedConfirmed, { fallback_at_elapsed_fraction: '' });
  check('a blank field that normalizes away is the same timing (no spurious clear)', timingConfirmedCurrent(save(fbBack, storedConfirmed).defining_moment));
  check('junk value (a string) → cleared', !('timing_confirmed' in save(withDm(storedConfirmed, { timing_confirmed: 'yes' }), storedConfirmed).defining_moment));
  const b = { at_elapsed_fraction: 0.5, timing_confirmed: { at_elapsed_fraction: 0.5 } };
  check('a partial record compares missing keys as absent', timingConfirmedCurrent(b) && timingConfirmedCurrent(reconcileTimingConfirmed(b, null)));
}

head('1b. the regenerate route never carries a confirmation over');
{
  const src = fs.readFileSync(path.join(REPO_DIR, 'engine/admin/adminRouter.js'), 'utf8');
  const at  = src.indexOf('normalizeForkBinding(defining_moment, role.id);');
  check('generator strips timing_confirmed right after carrying the binding over', at > 0 && /^\s*(\/\/[^\n]*\n\s*)*delete defining_moment\.timing_confirmed;/.test(src.slice(at + 'normalizeForkBinding(defining_moment, role.id);'.length)));
}

// ═══ 2. nothing stored changes ═══════════════════════════════════════════════
head('2. every stored role saves exactly as before');
{
  const ids = fs.readdirSync(ROLES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  let withFork = 0, changed = [];
  for (const id of ids) {
    let role; try { role = readRole(id); } catch { continue; }
    if (!role?.defining_moment) continue;
    withFork++;
    const before = clone(role); quiet(() => normalizeForkBinding(before.defining_moment, id));
    const after  = save(role, role);
    if (JSON.stringify(after.defining_moment) !== JSON.stringify(before.defining_moment)) changed.push(id);
  }
  check(`all ${withFork} stored forks: the save guard writes the block it wrote before (no timing_confirmed added)`, withFork > 5 && changed.length === 0, changed.join(', '));
}

// ═══ 3. the editor ═══════════════════════════════════════════════════════════
head('3. the editor — render, post, un-tick');
const html = fs.readFileSync(path.join(REPO_DIR, 'engine/admin/index.html'), 'utf8');
const dom  = new JSDOM(html, {
  runScripts: 'dangerously', url: 'http://localhost/admin/', pretendToBeVisual: true,
  beforeParse(w) { w.fetch = async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }); w.confirm = () => true; w.alert = () => {}; },
});
const win = dom.window;
await new Promise(r => win.addEventListener('load', r, { once: true }));
await new Promise(r => setTimeout(r, 200));
check('editor script loaded', typeof win.renderDefiningMomentSection === 'function' && typeof win.collectEdits === 'function' && typeof win.bindDefiningMomentHandlers === 'function');

function mount(role) {
  const data = { scenario: { introduction: { sections: [] } }, playerRoles: [clone(role)], storyArc: null };
  const formEl = win.document.createElement('form');
  formEl.innerHTML = win.renderDefiningMomentSection(data.playerRoles[0], 0, data);
  win.document.body.appendChild(formEl);
  win.bindDefiningMomentHandlers(formEl, data, role.scenarioId);
  return { formEl, data, cb: formEl.querySelector('.dm-timing-cb') };
}
const record = dm => ({ at_elapsed_fraction: dm.at_elapsed_fraction ?? null, at_act: dm.at_act ?? null, at_beat: dm.at_beat ?? null, at_scene: dm.at_scene ?? null, fallback_at_elapsed_fraction: dm.fallback_at_elapsed_fraction ?? null });
{
  const plain = mount(JOAN);
  check('Joan (anchored): the timing box renders, unticked with no record', !!plain.cb && plain.cb.checked === false);
  check('...and carries a data-path, so the save posts it', plain.cb?.dataset.path === 'playerRoles.0.defining_moment.timing_confirmed');
  check('reviewed, no record → amber "not confirmed for the current binding" note', JOAN.defining_moment.reviewed !== true || !!plain.formEl.querySelector('.dm-timing-unconfirmed'));

  const good = withDm(JOAN, { reviewed: true, timing_confirmed: record(JOAN.defining_moment) });
  const g = mount(good);
  check('a CURRENT record → the box renders ticked, no amber note', g.cb?.checked === true && !g.formEl.querySelector('.dm-timing-unconfirmed'));
  const stale = withDm(JOAN, { reviewed: true, timing_confirmed: { ...record(JOAN.defining_moment), at_elapsed_fraction: 0.6 } });
  const s = mount(stale);
  check('a STALE record (confirmed at another timing) → unticked, with the amber note', s.cb?.checked === false && !!s.formEl.querySelector('.dm-timing-unconfirmed'));

  win.collectEdits(g.formEl, g.data);
  check('collectEdits posts the ticked box as true (the server stamps the record)', g.data.playerRoles[0].defining_moment.timing_confirmed === true);

  const fr = g.formEl.querySelector('.dm-fraction-input');
  fr.value = '0.7'; fr.dispatchEvent(new win.Event('input', { bubbles: true }));
  check('editing at_elapsed_fraction un-ticks the box live', g.cb.checked === false);
  win.collectEdits(g.formEl, g.data);
  const posted = clone(g.data.playerRoles[0]);
  check('...so the save posts false', posted.defining_moment.timing_confirmed === false);
  check('...and the server stores no confirmation', !('timing_confirmed' in save(posted, good).defining_moment));

  const g2 = mount(good);
  g2.cb.checked = true;
  const opt = g2.formEl.querySelector('.dm-option-text'); opt.value += ' x'; opt.dispatchEvent(new win.Event('input', { bubbles: true }));
  check('editing a NON-timing field (option text) leaves the box alone', g2.cb.checked === true);
  for (const cls of ['.dm-at-act-input', '.dm-at-beat-input', '.dm-fallback-input']) {
    const m = mount(good); const el = m.formEl.querySelector(cls);
    if (!el) { check(`${cls} present`, false); continue; }
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    check(`a change on ${cls} un-ticks the box`, m.cb.checked === false);
  }

  // Non-anchored role: no box, and the record (if any) round-trips untouched as an object.
  const fic = fs.readdirSync(ROLES_DIR).filter(f => f.endsWith('.json'))
    .map(f => { try { return readRole(f.replace(/\.json$/, '')); } catch { return null; } })
    .find(r => r?.defining_moment && r.character_type !== 'real' && r.fate_mode !== 'anchored');
  if (fic) check(`${fic.id} (not anchored) renders no timing box`, !mount(fic).cb);
  else console.log('      (no non-anchored role with a fork stored — skipped)');
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll timing-confirmation assertions passed.');
process.exit(fails ? 1 : 0);
