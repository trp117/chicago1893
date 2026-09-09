// ANCHOR DROPDOWN — scenario scoping, and the None option that clears.
//
// Two bugs, one control. The Anchored Location select was fed the GLOBAL location list —
// every location in the project, 222 across 29 scenarios — so a Watergate role was offered
// "B-59 Conning Tower" and an Enterprise Ledger role was offered Cantigny. Nothing downstream
// refused it: the editor's PUT validates only that location_id is a non-empty string, so a
// cross-scenario anchor saved clean and then silently did nothing at runtime, leaving the
// editor claiming "anchored — historical faithfulness enforced" over an unanchored session.
//
// And the blank option at the top of that select — the thing that CLEARS an anchor — read
// "Choose…", which looks like an empty slot rather than the un-anchor action the help text
// promises.
//
// This file asserts the fix from both ends: the select offers only the role's own scenario,
// and choosing None genuinely deletes the block rather than the save guard putting it back.
//
// Runs against the real admin page, the real ENTITIES config and the real adminRouter guard.
// No API calls, no Supabase, NO WRITES — every assertion is deterministic and nothing on
// disk is touched.

import 'dotenv/config';
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;

const { JSDOM }              = await import('jsdom');
const { JsonFileStore }      = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository } = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { LocationRepository } = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { resolveAnchoredLocation } = await import(`${ROOT}/engine/services/StateManager.js`);
const admin = await import(`${ROOT}/engine/admin/adminRouter.js`);

const store = new JsonFileStore(path.join(REPO_DIR, 'engine/data'));
const repos = {
  scenarios: new ScenarioRepository(store),
  locations: new LocationRepository(store),
};

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

// ── Load the real admin script, the way gating.test.mjs does ──────────────────
const html   = fs.readFileSync(path.join(REPO_DIR, 'engine/admin/index.html'), 'utf8');
const script = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/i.exec(html)[1];

const noop = () => {};
const stubEl = new Proxy({}, { get: (t, k) => (k === 'value' ? '' : k === 'style' ? {} : k === 'classList' ? { add: noop, remove: noop } : noop) });
const doc = { addEventListener: noop, getElementById: () => stubEl, querySelector: () => stubEl,
              querySelectorAll: () => [], createElement: () => stubEl, body: stubEl, documentElement: stubEl, head: stubEl };
const ctx = vm.createContext({
  document: doc, window: {}, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { search: '', href: '', pathname: '/admin/' }, navigator: { clipboard: {} },
  fetch: async () => ({ ok: true, json: async () => ({}) }), console, setTimeout, clearTimeout,
  alert: noop, confirm: () => false, prompt: () => null, addEventListener: noop, removeEventListener: noop,
  URLSearchParams, JSON, Math, Date, Object, Array, String, Number, Boolean, Set, Map, RegExp,
  Error, Promise, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
});
ctx.window = ctx;
// `function` declarations land on the context object; `const` ones (ENTITIES) stay in the
// script's lexical scope and never do. Append an assignment so the config comes out too —
// the test asserts against the REAL field config, not a copy that could drift from it.
try { vm.runInContext(`${script}\n;globalThis.__ENTITIES = ENTITIES;`, ctx, { filename: 'index.html<script>' }); }
catch (err) { console.log(`      (top-level script threw: ${err.message} — builders may still be defined)`); }

const { scopeLocationsToItem, buildFormHTML, extractFormData, __ENTITIES: ENTITIES } = ctx;
check('admin builders reachable',
  [scopeLocationsToItem, buildFormHTML, extractFormData].every(f => typeof f === 'function') && !!ENTITIES);

const ROLE_CFG  = ENTITIES['player-roles'];
const ANCHOR_KEY = 'anchored_location.location_id';
const NONE_LABEL = '— None (role roams free) —';

// The GLOBAL list — exactly what the dropdown used to be fed.
const allLocations = repos.locations.findAll();

// ═══ 1. THE SCOPE ════════════════════════════════════════════════════════════
head('1. scenario scoping — the global list is never offered');

check('global list is the whole project', allLocations.length > 200,
      `${allLocations.length} locations across all scenarios`);

// Two roles from two different scenarios, both real, both anchored.
const CASES = [
  { roleId: 'role_wills', scenarioId: 'watergate_1972_part1_breach' },
  { roleId: 'role_north', scenarioId: 'the_enterprise_ledger' },
];

for (const { roleId, scenarioId } of CASES) {
  const role = repos.scenarios.findPlayerRoles(scenarioId).find(r => r.id === roleId);
  check(`${roleId.padEnd(12)} loaded`, !!role, role ? `scenarioId=${role.scenarioId}` : 'NOT FOUND');
  if (!role) continue;

  const scoped   = scopeLocationsToItem(allLocations, role);
  const onDisk   = fs.readdirSync(path.join(REPO_DIR, 'engine/data/locations', scenarioId))
                     .filter(f => f.endsWith('.json'));
  const foreign  = scoped.filter(l => l.scenarioId !== scenarioId);

  check(`${roleId.padEnd(12)} scoped list matches the scenario's own directory`,
        scoped.length === onDisk.length, `${scoped.length} offered, ${onDisk.length} on disk`);
  check(`${roleId.padEnd(12)} NO foreign locations survive the filter`,
        foreign.length === 0, foreign.length ? foreign.map(l => l.id).join(', ') : 'none');
  check(`${roleId.padEnd(12)} the global list is genuinely narrowed`,
        scoped.length < allLocations.length, `${allLocations.length} → ${scoped.length}`);

  // The rendered control, not just the array feeding it.
  const formHtml = buildFormHTML(ROLE_CFG, role, { characters: [], locations: scoped });
  const selectEl = new JSDOM(`<body>${formHtml}</body>`).window.document
                     .querySelector(`select[name="${ANCHOR_KEY}"]`);
  check(`${roleId.padEnd(12)} anchor select rendered`, !!selectEl);
  if (!selectEl) continue;

  const values = [...selectEl.options].map(o => o.value);
  const realValues = values.filter(Boolean);
  const strays = realValues.filter(v => !scoped.some(l => l.id === v));
  check(`${roleId.padEnd(12)} select offers ONLY this scenario's locations`,
        strays.length === 0, strays.length ? `stray: ${strays.join(', ')}` : `${realValues.length} options`);

  // A location from a DIFFERENT scenario must not be reachable at all.
  const alien = allLocations.find(l => l.scenarioId !== scenarioId);
  check(`${roleId.padEnd(12)} a foreign id ("${alien.id}") is not selectable`,
        !values.includes(alien.id));
}

// ═══ 2. THE NONE OPTION ══════════════════════════════════════════════════════
head('2. the None option — present, named, and pre-selected only when unset');

const wills  = repos.scenarios.findPlayerRoles('watergate_1972_part1_breach').find(r => r.id === 'role_wills');
const scopedWills = scopeLocationsToItem(allLocations, wills);

function anchorSelect(role) {
  const formHtml = buildFormHTML(ROLE_CFG, role, { characters: [], locations: scopeLocationsToItem(allLocations, role) });
  return new JSDOM(`<body>${formHtml}</body>`).window.document.querySelector(`select[name="${ANCHOR_KEY}"]`);
}

const unsetRole = { ...wills, anchored_location: undefined };
const unsetSel  = anchorSelect(unsetRole);
check('None is the FIRST option', unsetSel.options[0].value === '');
check('None is named, not "Choose…"', unsetSel.options[0].textContent.trim() === NONE_LABEL,
      unsetSel.options[0].textContent.trim());
check('None is selected when no anchor is set', unsetSel.options[0].selected && unsetSel.value === '');

const pinned    = { ...wills, anchored_location: { location_id: scopedWills[0].id, reviewed: true, enforce_from: 0 } };
const pinnedSel = anchorSelect(pinned);
check('None is NOT selected when an anchor IS set', !pinnedSel.options[0].selected,
      `selected = ${pinnedSel.value}`);
check('the stored anchor is the selected option', pinnedSel.value === scopedWills[0].id);

// ═══ 3. NONE ACTUALLY CLEARS ═════════════════════════════════════════════════
head('3. choosing None deletes the block — through the real save guard');

// Render the form for a role that IS anchored, pick None, extract exactly what the browser
// would POST, then run the real server-side guard over it. This is the whole round trip
// except the wire.
// Snapshot the stored anchor BEFORE rendering. extractFormData shallow-copies the item it is
// given, so setDeep writes through to the item's own nested anchored_location object — take
// the "what the server already has" copy first or it gets emptied along with the form.
const storedAnchor = structuredClone(pinned.anchored_location);

const dom = new JSDOM(`<body><form id="entity-form">${
  buildFormHTML(ROLE_CFG, pinned, { characters: [], locations: scopedWills })
}</form></body>`);
const formEl = dom.window.document.getElementById('entity-form');
const sel    = formEl.querySelector(`select[name="${ANCHOR_KEY}"]`);

check('form starts anchored', sel.value === scopedWills[0].id, sel.value);
sel.value = '';                                    // ← the reviewer chooses "— None —"
check('None is selectable (value survives assignment)', sel.value === '');

const posted = extractFormData(ROLE_CFG, formEl, pinned);
check('POST body carries an EMPTY location_id (not a missing key)',
      posted.anchored_location !== undefined && posted.anchored_location.location_id === '',
      JSON.stringify(posted.anchored_location));

// The guard that preserves a stale tab's field must NOT preserve this one.
const shimRepos = { scenarios: { findPlayerRole: () => ({ ...pinned, anchored_location: structuredClone(storedAnchor) }) } };
const guarded = admin.preserveStoredAnchoredLocation(shimRepos, { ...posted });

check('guard DELETES anchored_location on an empty id',
      guarded.anchored_location === undefined, JSON.stringify(guarded.anchored_location));
check('the role now roams free', resolveAnchoredLocation(guarded, scopedWills) === null);

// The other half of the guard's contract, unchanged: a STALE tab (key absent entirely) is
// still restored, so this fix did not turn the preserve behaviour off.
const staleTab = { ...posted };
delete staleTab.anchored_location;
const restored = admin.preserveStoredAnchoredLocation(shimRepos, staleTab);
check('a STALE tab (key absent) still has its anchor RESTORED',
      restored.anchored_location?.location_id === scopedWills[0].id,
      JSON.stringify(restored.anchored_location));

// ═══ 4. THE BACKSTOP STAYS ═══════════════════════════════════════════════════
head('4. fail-safe intact — a bad anchor still no-ops with a warning');

const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(' '));
const phantom = resolveAnchoredLocation(
  { id: 'role_test', anchored_location: { location_id: 'loc_not_in_this_scenario', reviewed: true } },
  scopedWills,
);
console.warn = realWarn;

check('out-of-scenario anchor resolves to null', phantom === null);
check('and says so on the way out', warnings.some(w => w.includes('[ANCHOR]') && w.includes('not a location in this scenario')),
      warnings[0] || '(no warning)');

// ═══ 5. NORTH IS NOT A PHANTOM ═══════════════════════════════════════════════
head('5. regression guard — role_north/loc_room_392 is VALID, do not "fix" it');

const north = repos.scenarios.findPlayerRoles('the_enterprise_ledger').find(r => r.id === 'role_north');
const scopedNorth = scopeLocationsToItem(allLocations, north);
const northAnchorId = north.anchored_location?.location_id;

check('North still carries his anchor', northAnchorId === 'loc_room_392', String(northAnchorId));
check('loc_room_392 IS in the_enterprise_ledger',
      scopedNorth.some(l => l.id === 'loc_room_392'),
      scopedNorth.map(l => l.id).join(', '));
check('it is also his startLocationId', north.startLocationId === 'loc_room_392');
check('so it survives the new scoped dropdown', anchorSelect(north).value === 'loc_room_392');
check('and it ENFORCES at runtime (not a silent no-op)',
      resolveAnchoredLocation(north, scopedNorth)?.location_id === 'loc_room_392');

console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`}\n`);
process.exit(fails === 0 ? 0 : 1);
