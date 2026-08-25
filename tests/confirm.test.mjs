// STEP 4 — the human-confirm archetype UI.
// Drives the REAL engine/admin/index.html in jsdom against a REAL admin router: the select,
// the Propose button, the proposal panel, live re-gating, the override, and the demote.
//
// Makes real classifier calls (needs ANTHROPIC_API_KEY) and writes to one scratch role,
// which it restores byte-for-byte.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Resolve the repo from this file's own location, so the suite runs from anywhere.
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = pathToFileURL(REPO_DIR).href;

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('SKIP  confirm.test — ANTHROPIC_API_KEY is not set (this suite makes real classifier calls).');
  process.exit(0);
}

const ROOT_URL = REPO_URL;
const ROOT     = REPO_DIR;
const DATA_DIR = path.join(ROOT, 'engine/data');

const { JSDOM }  = await import('jsdom');
const express    = (await import('express')).default;
const { JsonFileStore }       = await import(`${ROOT_URL}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository }  = await import(`${ROOT_URL}/engine/repositories/ScenarioRepository.js`);
const { CharacterRepository } = await import(`${ROOT_URL}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }  = await import(`${ROOT_URL}/engine/repositories/LocationRepository.js`);
const { ClueRepository }      = await import(`${ROOT_URL}/engine/repositories/ClueRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT_URL}/engine/repositories/StoryArcRepository.js`);
const { PlayerRepository }    = await import(`${ROOT_URL}/engine/repositories/PlayerRepository.js`);
const { SessionRepository }   = await import(`${ROOT_URL}/engine/repositories/SessionRepository.js`);
const admin = await import(`${ROOT_URL}/engine/admin/adminRouter.js`);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};

// File-only store: nothing in this harness may reach Supabase.
const store = new JsonFileStore(DATA_DIR);
const repos = {
  scenarios:  new ScenarioRepository(store),  characters: new CharacterRepository(store),
  locations:  new LocationRepository(store),  clues:      new ClueRepository(store),
  storyArcs:  new StoryArcRepository(store),  players:    new PlayerRepository(store),
  sessions:   new SessionRepository(store),
};
const fileOf   = id => path.join(DATA_DIR, 'scenarios/player_roles', `${id}.json`);
const readRole = id => JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));

// Real admin API, so the editor's Propose button exercises the actual endpoint.
const app = express();
app.use(express.json());
app.use('/admin/api', admin.createAdminRouter(repos, { anthropicApiKey: process.env.ANTHROPIC_API_KEY }));
const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
const apiBase = `http://127.0.0.1:${server.address().port}`;

// ── Boot the real admin page in jsdom, with fetch pointed at the live API ────
const html = fs.readFileSync(path.join(ROOT, 'engine/admin/index.html'), 'utf8');
const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: 'http://localhost/admin/', pretendToBeVisual: true,
  beforeParse(w) {
    w.fetch = (url, opts) => fetch(apiBase + String(url), opts);
    w.confirm = () => true;
    w.alert = () => {};
  },
});
const win = dom.window;
await new Promise(r => win.addEventListener('load', r, { once: true }));
await new Promise(r => setTimeout(r, 300));

check('editor script loaded', typeof win.renderArchetypeSection === 'function' && typeof win.__bindArchetypeHandlers === 'function');

// Build a form carrying the three gated sections for one role, exactly as the editor does.
function mountRole(role) {
  const data = { scenario: { introduction: { sections: [] } }, playerRoles: [role] };
  const formEl = win.document.createElement('form');
  formEl.innerHTML =
      win.renderArchetypeSection(role, 0)
    + win.renderDefiningMomentSection(role, 0, data)
    + `<div id="endings-gate-0">${win.renderEndingsGatePanel(role, 0)}</div>`;
  win.document.body.appendChild(formEl);
  win.__bindArchetypeHandlers(formEl, data, role.scenarioId);
  return { formEl, data };
}
const sel        = f => f.querySelector('.archetype-select');
const forkLive   = f => !!f.querySelector('.gen-dm-btn');
const endsLive   = f => !f.querySelector('.regen-endings-btn[disabled]');
const panelText  = f => f.querySelector('.archetype-proposal')?.textContent.replace(/\s+/g, ' ').trim() || '';
const waitForProposal = async (id, ms = 180000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = win.__archetypeProposals.get(id);
    if (p) return p;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
};
const setSelect  = (f, v) => { const s = sel(f); s.value = v; s.dispatchEvent(new win.Event('change', { bubbles: true })); };

// The editor's real save path: collectEdits reads the form into `data`, then /generate/save
// runs preserveStoredRoleBlocks -> stripEmptyEndingNotes -> savePlayerRole.
function saveThroughGuardedPath(formEl, data) {
  win.collectEdits(formEl, data);
  const posted = JSON.parse(JSON.stringify(data.playerRoles[0]));   // what the browser would POST
  repos.scenarios.savePlayerRole(
    admin.stripEmptyEndingNotes(admin.preserveStoredRoleBlocks(repos, posted)));
  store._cache.clear();
  return posted;
}

// ═══ 1. Lojka — the select is present, correct, and NOT collapsed ════════════
console.log('\n[1] Lojka — archetype select visible in the main body\n');
{
  const role = readRole('role_lojka');
  const { formEl } = mountRole(role);
  const s = sel(formEl);
  check('select rendered', !!s);
  check('data-path is the role archetype', s.getAttribute('data-path') === 'playerRoles.0.archetype', s.getAttribute('data-path'));
  check('shows the value set in step 1', s.value === 'instrument', s.value);
  check('all five values offered', [...s.options].map(o => o.value).join(',') === 'crucible-open,crucible-fixed,instrument,witness,unclassified',
        [...s.options].map(o => o.value).join(','));
  check('unclassified option carries the LITERAL value, not ""',
        [...s.options].some(o => o.value === 'unclassified') && ![...s.options].some(o => o.value === ''));
  check('NOT inside a collapsed <details>', s.closest('details') === null);
  check('Propose button present', !!formEl.querySelector('.propose-archetype-btn'));
  check('fork button blocked (instrument)', forkLive(formEl) === false);
  check('endings button blocked (instrument)', endsLive(formEl) === false);
  formEl.remove();
}

// ═══ 2. Propose on Lojka — real endpoint, real reasoning in the panel ════════
console.log('\n[2] Lojka — Propose calls the (previously orphaned) endpoint\n');
{
  const role = readRole('role_lojka');
  const { formEl } = mountRole(role);
  const PROPOSE_FOR = 'role_lojka';
  formEl.querySelector('.propose-archetype-btn').click();
  await waitForProposal(PROPOSE_FOR);

  const p = win.__archetypeProposals.get('role_lojka');
  check('proposal received and held ephemerally', !!p, p ? `${p.archetype} / ${p.confidence}` : 'none');
  check('classifier proposes instrument', p?.archetype === 'instrument', p?.archetype);
  const t = panelText(formEl);
  check('panel shows the proposal',        /Classifier proposes/.test(t) && /instrument/.test(t));
  check('panel shows the hinge verdict',   /Test 1 — hinge/.test(t) && /(PASSED|failed)/.test(t));
  check('panel shows the foreknowledge verdict', /Test 2 — foreknowledge/.test(t) && /no_information/.test(t));
  check('panel shows cited evidence',      /Evidence cited/.test(t) && /route_change_received/.test(t));
  check('panel shows the reasoning',       /Reasoning/.test(t) && t.length > 600);
  check('panel shows the counter-case',    /Counter-case/.test(t));
  check('panel says it matches the set value', /matches the value set above/.test(t));
  check('nothing written to the role file', readRole('role_lojka').archetype === 'instrument'
        && JSON.stringify(readRole('role_lojka')) === JSON.stringify(role));
  console.log(`\n      panel excerpt: ${t.slice(0, 300)}…\n`);
  formEl.remove();
}

// ═══ 3–6. An unclassified legacy role: propose, confirm, override, demote ════
const TARGET = 'burnhams_assistant';
const BEFORE = fs.readFileSync(fileOf(TARGET), 'utf8');
try {
  console.log(`\n[3] ${TARGET} (legacy, unclassified) — propose → set → save → persists\n`);
  {
    const role = readRole(TARGET);
    check('starts with no archetype key', role.archetype === undefined);
    const { formEl, data } = mountRole(role);
    check('select defaults to unclassified', sel(formEl).value === 'unclassified', sel(formEl).value);
    check('both artifacts allowed while unclassified', forkLive(formEl) === true && endsLive(formEl) === true);

    const PROPOSE_FOR = TARGET;
    formEl.querySelector('.propose-archetype-btn').click();
    await waitForProposal(PROPOSE_FOR);
    const p = win.__archetypeProposals.get(TARGET);
    check('proposal received', !!p, p ? `${p.archetype} (${p.confidence})` : 'none');
    const t = panelText(formEl);
    check('panel shows reasoning for this role', /Reasoning/.test(t) && t.length > 400);
    check('panel flags that it differs from the set value', /differs from the value set above/.test(t) || p?.archetype === 'unclassified');
    console.log(`\n      proposed: ${p?.archetype} — ${String(p?.reasoning).slice(0, 220)}…\n`);

    // Confirm the proposal via the panel's "Use this value" button, then save.
    const apply = formEl.querySelector('.archetype-apply-btn');
    check('“Use this value” offered when the proposal differs', !!apply || p?.archetype === 'unclassified');
    if (apply) apply.click();
    check('select now carries the proposed value', !!p && sel(formEl).value === p.archetype, sel(formEl).value);

    const posted = saveThroughGuardedPath(formEl, data);
    check('collectEdits put the select value on the posted role', posted.archetype === p.archetype, posted.archetype);
    check('persisted through the guarded save path', readRole(TARGET).archetype === p.archetype, readRole(TARGET).archetype);
    check('gating now applies to the stored value',
          admin.archetypeAllows(readRole(TARGET), 'fork').archetype === p.archetype);
    formEl.remove();
  }

  console.log(`\n[4] OVERRIDE — human picks something the classifier did not propose\n`);
  {
    const role = readRole(TARGET);
    const p = win.__archetypeProposals.get(TARGET);
    const override = ['crucible-open', 'crucible-fixed', 'instrument', 'witness'].find(a => a !== p.archetype);
    const { formEl, data } = mountRole(role);
    setSelect(formEl, override);
    const posted = saveThroughGuardedPath(formEl, data);
    check(`human value "${override}" beats proposal "${p.archetype}" on the posted role`, posted.archetype === override, posted.archetype);
    check('human value persisted', readRole(TARGET).archetype === override, readRole(TARGET).archetype);
    const stored = readRole(TARGET);
    const expect = { 'crucible-open': [true, true], 'crucible-fixed': [true, false], instrument: [false, false], witness: [false, false] }[override];
    check(`gating follows the HUMAN value (fork ${expect[0]}, endings ${expect[1]})`,
          admin.archetypeAllows(stored, 'fork').allowed === expect[0]
          && admin.archetypeAllows(stored, 'graded_endings').allowed === expect[1]);
    formEl.remove();
  }

  console.log('\n[5] LIVE GATING — buttons re-gate on change, with no save\n');
  {
    const role = readRole(TARGET);
    const { formEl } = mountRole(role);
    const onDiskBefore = fs.readFileSync(fileOf(TARGET), 'utf8');
    const seen = [];
    for (const [value, expectFork, expectEnds] of [
      ['crucible-open',  true,  true ],
      ['crucible-fixed', true,  false],
      ['instrument',     false, false],
      ['witness',        false, false],
      ['unclassified',   true,  true ],
    ]) {
      setSelect(formEl, value);
      const f = forkLive(formEl), e = endsLive(formEl);
      seen.push(`${value}: fork=${f ? 'on' : 'OFF'} endings=${e ? 'on' : 'OFF'}`);
      check(`${value.padEnd(15)} fork ${expectFork ? 'enabled' : 'DISABLED'} live`, f === expectFork);
      check(`${value.padEnd(15)} endings ${expectEnds ? 'enabled' : 'DISABLED'} live`, e === expectEnds);
      check(`${value.padEnd(15)} select keeps the chosen value after re-render`, sel(formEl).value === value, sel(formEl).value);
    }
    check('no save occurred during live re-gating', fs.readFileSync(fileOf(TARGET), 'utf8') === onDiskBefore);
    console.log('      ' + seen.join('\n      '));
    formEl.remove();
  }

  console.log('\n[6] DEMOTE — an explicit "unclassified" must STICK past the guard\n');
  {
    const role = readRole(TARGET);
    check('role is classified before the demote', role.archetype !== undefined && role.archetype !== 'unclassified', role.archetype);
    const { formEl, data } = mountRole(role);
    setSelect(formEl, 'unclassified');
    const posted = saveThroughGuardedPath(formEl, data);
    check('the LITERAL string is posted, not an empty value / missing key',
          Object.prototype.hasOwnProperty.call(posted, 'archetype') && posted.archetype === 'unclassified',
          JSON.stringify(posted.archetype));
    check('guard did NOT restore the previous archetype', readRole(TARGET).archetype === 'unclassified', readRole(TARGET).archetype);
    check('demoted role is permissive again',
          admin.archetypeAllows(readRole(TARGET), 'fork').allowed === true
          && admin.archetypeAllows(readRole(TARGET), 'graded_endings').allowed === true);

    // And the guard still does its job for a genuinely stale tab (key absent).
    const stale = JSON.parse(JSON.stringify(readRole(TARGET)));
    stale.archetype = 'witness';
    repos.scenarios.savePlayerRole(stale); store._cache.clear();
    const staleTab = JSON.parse(JSON.stringify(readRole(TARGET)));
    delete staleTab.archetype;
    repos.scenarios.savePlayerRole(admin.preserveStoredRoleBlocks(repos, staleTab)); store._cache.clear();
    check('stale tab (key absent) still has its stored archetype restored', readRole(TARGET).archetype === 'witness', readRole(TARGET).archetype);
    formEl.remove();
  }
} finally {
  fs.writeFileSync(fileOf(TARGET), BEFORE, 'utf8');
  store._cache.clear();
  check(`${TARGET} restored to its original bytes`, fs.readFileSync(fileOf(TARGET), 'utf8') === BEFORE);
}

// The six confirmed roles must be untouched by any of this.
for (const id of ['role_trude_harms', 'role_gatekeeper', 'role_princip', 'role_lojka', 'role_mila', 'role_chronicler']) {
  check(`${id.padEnd(18)} untouched`, readRole(id).updatedAt.startsWith('2026-08-24T22:18:26'), readRole(id).archetype);
}

server.close();
dom.window.close();
console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll human-confirm tests passed.');
process.exit(fails ? 1 : 0);
