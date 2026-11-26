// DEMO_COLD_OPEN — the pre-baked entry.
//
//   node tests/cold-open.test.mjs
//
// Part A — contract: every game-page global the injection hooks still exists in
//          engine/game/index.html, and the two call paths it relies on are intact.
// Part B — coldOpen.js units: config gating, row validation, cache + read-error fallback,
//          the handoff state (NPC re-introduction, review-gated glossary), history seed,
//          fingerprint.
// Part C — the real router + the real page in jsdom, api.anthropic.com scripted:
//          COST: loading the entry (page + bootstrap + cold-open) makes 0 model calls; the first
//          action makes exactly 1. HANDOFF: that turn runs on the server-held baked state with the
//          lean-cut history, is metered as a start (daily slot, refunded on failure), opens the
//          transcript; later turns are ordinary. UI: the two title screens (intro), dissolve, scene, choices, input,
//          role switcher, the history, Another moment, Replay, reduced motion.
// Part D — server boots (DEMO_COLD_OPEN_FILE): / is the entry, /moments is today's landing
//          byte-for-byte, /game is unchanged, /health reports staleness; every fail-safe
//          (featured outside the whitelist, unreadable source, un-ready row) serves the landing.
//
// The flag-OFF byte-identity proof against master 00b222b is scripts/cold-open-baseline.mjs.
// Needs restored content (Dog Green on disk) and Supabase credentials; skips without them.
import 'dotenv/config';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';
import { JSDOM } from 'jsdom';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = pathToFileURL(REPO_DIR).href;
const p = (...s) => path.join(REPO_DIR, ...s);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
  if (!ok) failed++;
};
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await tick(20); } return false; }

const CO = await import(`${ROOT}/engine/server/coldOpen.js`);
const DM = await import(`${ROOT}/engine/server/demoMode.js`);

// ── Part A: contract ─────────────────────────────────────────────────────────
console.log('\nPart A — the game-page globals the injection hooks');
{
  const page = fs.readFileSync(p('engine/game/index.html'), 'utf8');
  const js = fs.readFileSync(p('engine/demo/cold-open.js'), 'utf8');
  const hooks = JSON.parse(js.match(/COLD_OPEN_HOOKS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  for (const name of ['renderStreamlinedScreen1', 'gameState', 'sessionId', 'renderOutput', 'renderChoices', 'submitTurn', 'buildIntroPanelEl']) {
    check(`required hook "${name}" is in the injection's checked set or lexical set`, hooks.includes(name) || ['gameState', 'sessionId'].includes(name));
  }
  for (const fn of hooks) check(`function ${fn}() is declared at top level of the game page`, new RegExp(`^(async )?function ${fn}\\(`, 'm').test(page));
  // let/const globals the injection reads or assigns.
  for (const v of ['gameState', 'sessionId', 'conversationHistory', 'currentRoleId', 'scenario', 'storyEl', 'choicesAreaWrapEl', 'streamOptionsDots', 'submitBtn', 'inputEl', 'formEl', 'scrollHintEl']) {
    check(`global ${v} is a top-level let/const of the game page`, new RegExp(`^(let|const) ${v}\\b`, 'm').test(page));
    check(`  …and the injection uses it by that name`, new RegExp(`\\b${v}\\b`).test(js));
  }
  const body = (fn) => { const i = page.search(new RegExp(`^(async )?function ${fn}\\(`, 'm')); return page.slice(i, page.indexOf('\n}\n', i)); };
  check('loadGame() enters through renderStreamlinedScreen1() (the streamlined flag is on)', /USE_STREAMLINED_ONBOARDING = true/.test(page) && /renderStreamlinedScreen1\(\)/.test(body('loadGame')));
  check('restartGame() re-enters through renderStreamlinedScreen1()', /renderStreamlinedScreen1\(\)/.test(body('restartGame')));
  check('submitTurn() posts { state, playerInput, history, sessionId } to `${API_BASE}/turn` with fetch', /fetch\(`\$\{API_BASE\}\/turn`/.test(body('submitTurn')) && /state: gameState, playerInput, history: conversationHistory, sessionId/.test(body('submitTurn')));
  check('buildIntroPanelEl() builds .intro-panel-content / .intro-panel-close', /intro-panel-content/.test(body('buildIntroPanelEl')) && /intro-panel-close/.test(body('buildIntroPanelEl')));
  check('the page has the elements the chrome attaches to (.bottom-bar, header.hero .back-link, #role-overlay)', /class="bottom-bar"/.test(page) && /class="back-link"/.test(page) && /id="role-overlay"/.test(page));
}

// ── Part B: coldOpen.js ──────────────────────────────────────────────────────
console.log('\nPart B — coldOpen.js');
{
  const on = { DEMO_COLD_OPEN: 'true', DEMO_FEATURED_SCENARIO: 'dog_green_sector', DEMO_FEATURED_ROLE: 'role_battalion_medic' };
  check('off when DEMO_MODE is off, even with DEMO_COLD_OPEN=true', CO.readColdOpenConfig(on, { demoMode: false, demoScenarios: ['dog_green_sector'] }).enabled === false);
  check('off for DEMO_COLD_OPEN unset / "false" / "1"', ['', 'false', '1', 'TRUE'].every(v => CO.readColdOpenConfig({ ...on, DEMO_COLD_OPEN: v }, { demoMode: true, demoScenarios: ['dog_green_sector'] }).enabled === false));
  const c = CO.readColdOpenConfig(on, { demoMode: true, demoScenarios: ['steel_curtain_cantigny', 'dog_green_sector'] });
  check('on with DEMO_MODE + DEMO_COLD_OPEN=true; featured read; no entry problem', c.enabled && c.featuredScenario === 'dog_green_sector' && c.featuredRole === 'role_battalion_medic' && !c.entryProblem);
  check('featured scenario outside DEMO_SCENARIOS → entryProblem (landing)', /not in DEMO_SCENARIOS/.test(CO.readColdOpenConfig(on, { demoMode: true, demoScenarios: ['steel_curtain_cantigny'] }).entryProblem || ''));
  check('featured role unset → entryProblem (landing)', !!CO.readColdOpenConfig({ ...on, DEMO_FEATURED_ROLE: '' }, { demoMode: true, demoScenarios: ['dog_green_sector'] }).entryProblem);

  // DEMO_VISIBLE_ROLES — parse, predicate, featured-role check.
  const quietLog = { warn() {} };
  check('visible roles: unset / empty → {}', JSON.stringify(DM.readDemoVisibleRoles({})) === '{}' && JSON.stringify(DM.readDemoVisibleRoles({ DEMO_VISIBLE_ROLES: ' , ' })) === '{}');
  const vr = DM.readDemoVisibleRoles({ DEMO_VISIBLE_ROLES: ' steel_curtain_cantigny/role_artillery_commander, dog_green_sector/role_battalion_medic,dog_green_sector/role_coxswain, nonsense, a/b/c, /x, y/ ,dog_green_sector/role_coxswain' }, { log: quietLog });
  check('visible roles: "scenario/role" pairs grouped per scenario; malformed and duplicate entries dropped', JSON.stringify(vr) === JSON.stringify({ steel_curtain_cantigny: ['role_artillery_commander'], dog_green_sector: ['role_battalion_medic', 'role_coxswain'] }));
  const vis = DM.makeIsVisibleRole({ demoMode: true, visibleRoles: vr });
  check('visible roles: a listed scenario shows only its listed roles', vis('steel_curtain_cantigny', 'role_artillery_commander') && !vis('steel_curtain_cantigny', 'role_forward_infantryman') && !vis('steel_curtain_cantigny', 'role_indigenous_signaler'));
  check('visible roles: a scenario the list does not name shows every role', vis('tolle_lege_milan_386', 'anything'));
  check('visible roles: DEMO_MODE off → every role, list or not', DM.makeIsVisibleRole({ demoMode: false, visibleRoles: vr })('steel_curtain_cantigny', 'role_forward_infantryman'));
  check('visible roles: no list → every role', DM.makeIsVisibleRole({ demoMode: true })('steel_curtain_cantigny', 'role_forward_infantryman') && DM.makeIsVisibleRole({ demoMode: true, visibleRoles: {} })('x', 'y'));
  check('visible roles: an inherited key ("constructor") is not a listing', DM.makeIsVisibleRole({ demoMode: true, visibleRoles: {} })('constructor', 'r'));
  check('featured role hidden by DEMO_VISIBLE_ROLES → entryProblem (landing)', /not in DEMO_VISIBLE_ROLES/.test(CO.readColdOpenConfig(on, { demoMode: true, demoScenarios: ['dog_green_sector'], visibleRoles: { dog_green_sector: ['role_coxswain'] } }).entryProblem || ''));
  check('featured role listed → no entry problem', !CO.readColdOpenConfig(on, { demoMode: true, demoScenarios: ['dog_green_sector'], visibleRoles: { dog_green_sector: ['role_battalion_medic'] } }).entryProblem);

  // The runtime: ready rows of hidden roles are never offered.
  {
    const fakeRow = { content: { baked: { fingerprint: 'sha256:x', state: {} } } };
    const fakeStore = { get: async () => fakeRow, readyRoles: async sid => sid === 'dog_green_sector' ? ['role_battalion_medic', 'role_coxswain'] : sid === 'other_s' ? ['role_b', 'role_a'] : [] };
    const mk = visibleRoles => CO.createColdOpenRuntime({
      config: CO.readColdOpenConfig(on, { demoMode: true, demoScenarios: ['dog_green_sector', 'other_s', 'bare_s'], visibleRoles }),
      store: fakeStore, fingerprintFor: async () => 'sha256:x', log: quietLog,
    });
    const off = mk({}), only = mk({ dog_green_sector: ['role_battalion_medic'], other_s: ['role_b'] });
    check('runtime, no list: readyRoles unchanged', JSON.stringify(await off.readyRoles('dog_green_sector')) === '["role_battalion_medic","role_coxswain"]');
    check('runtime, list: readyRoles drops the hidden role', JSON.stringify(await only.readyRoles('dog_green_sector')) === '["role_battalion_medic"]');
    check('runtime, no list: ?roleId=<other ready role> opens that role', (await off.entryFor('dog_green_sector', 'role_coxswain'))?.roleId === 'role_coxswain');
    check('runtime, list: ?roleId=<hidden role> on the featured scenario → the featured entry', (await only.entryFor('dog_green_sector', 'role_coxswain'))?.roleId === 'role_battalion_medic');
    check('runtime, list: ?roleId=<hidden role> never becomes a direct-start redirect', !(await only.entryFor('dog_green_sector', 'role_coxswain'))?.redirect);
    check('runtime, list: another scenario\'s default open skips its hidden ready role', (await off.entryFor('other_s'))?.roleId === 'role_a' && (await only.entryFor('other_s'))?.roleId === 'role_b');
    check('runtime, list: a hidden ?roleId= on another scenario → that scenario\'s first visible role', (await only.entryFor('other_s', 'role_a'))?.roleId === 'role_b');
    check('runtime: a scenario with no ready row still goes to its normal start', (await only.entryFor('bare_s', 'r'))?.redirect === '/game?scenarioId=bare_s&roleId=r');
    const onlyHidden = mk({ other_s: ['role_z'] });
    check('runtime, list: a scenario whose only ready rows are hidden → its normal start, and off /moments\' ready list', (await onlyHidden.entryFor('other_s'))?.redirect === '/game?scenarioId=other_s' && !(await onlyHidden.readyScenarios()).includes('other_s'));
  }

  const good = {
    intro: { name: 'N', place: 'P', date: 'D', wide: 'w', role: 'R', unit: 'U', character: 'c' },
    lean: { narrative: 'n', instruction: 'i', choices: ['a', 'b', 'c'] },
    baked: { state: { scenarioId: 's', playerRoleId: 'r' }, fingerprint: 'sha256:x' },
  };
  check('a complete row is servable', CO.coldOpenContentProblem(good, { scenarioId: 's', roleId: 'r' }) === null);
  check('old two-beat row (no intro) → not servable', !!CO.coldOpenContentProblem({ beats: [{ header: 'A', line: 'x' }, { header: 'R', line: 'y' }], lean: good.lean, baked: good.baked }));
  check('intro missing a required field (wide) → not servable', /intro\.wide/.test(CO.coldOpenContentProblem({ ...good, intro: { ...good.intro, wide: '' } }) || ''));
  const { unit, ...noUnit } = good.intro;
  check('intro.unit is optional', CO.coldOpenContentProblem({ ...good, intro: noUnit }, { scenarioId: 's', roleId: 'r' }) === null);
  check('intro display: trimmed, empty unit left out', JSON.stringify(CO.coldOpenIntroDisplay({ ...noUnit, name: ' N ', unit: '  ' })) === JSON.stringify({ name: 'N', place: 'P', date: 'D', wide: 'w', role: 'R', character: 'c' }));
  check('no choices → not servable', !!CO.coldOpenContentProblem({ ...good, lean: { ...good.lean, choices: [] } }));
  check('baked state of another role → not servable', !!CO.coldOpenContentProblem(good, { scenarioId: 's', roleId: 'other' }));
  check('no fingerprint → not servable', !!CO.coldOpenContentProblem({ ...good, baked: { state: good.baked.state } }));

  let reads = 0, t = 0, fail = false;
  const quiet = { warn() {} };
  const store = CO.createColdOpenStore({ fetchRows: async () => { reads++; if (fail) throw new Error('down'); return [{ role_id: 'r', content: good }, { role_id: 'bad', content: { beats: [] } }]; }, now: () => t, log: quiet });
  check('store returns the ready, valid row', !!(await store.get('s', 'r')));
  check('store skips an invalid row', (await store.get('s', 'bad')) === null && JSON.stringify(await store.readyRoles('s')) === '["r"]');
  check('cached: one read for repeated gets inside 60s', reads === 1);
  t = 61_000; fail = true;
  check('read error → nothing ready (landing), no throw', (await store.get('s', 'r')) === null && reads === 2);
  t = 61_000 + 6_000; fail = false;
  check('error result held only briefly (5s), then re-read', !!(await store.get('s', 'r')) && reads === 3);

  const characters = [{ id: 'c1', name: 'T/5 Raymond Calloway' }, { id: 'c2', name: 'Staff Sergeant Thomas Kowalski' }, { id: 'c3', name: 'Private Olek Szymanski', aliases: ['Ollie'] }];
  check('namesCharacter: surname matches', CO.namesCharacter('Calloway is down.', characters[0]));
  check('namesCharacter: alias matches', CO.namesCharacter('Ollie screams.', characters[2]));
  check('namesCharacter: no partial-word match', !CO.namesCharacter('Kowalskis', characters[1]));
  const content = {
    ...good,
    lean: { ...good.lean, narrative: 'Kowalski drags you behind the hedgehog. Ollie is screaming.' },
    baked: { ...good.baked, state: { scenarioId: 's', playerRoleId: 'r', introducedNpcs: ['c1', 'c2', 'c3', 'c_unknown'], presentNpcs: ['c1', 'c2'], narrativeStyle: 'cinematic', glossary: ['stale'] } },
  };
  const scenario = { status: 'published', glossary: [{ term: 'LCA', definition: 'landing craft', approved: true }, { term: 'Draft', definition: 'x' }], technical_facts: { reviewed: true, facts: [{ id: 'f1' }] } };
  const { state, unseen } = CO.buildColdOpenState(content, { scenario, characters });
  check('NPC introduced by the full opening but not named in the lean cut is re-introduced', JSON.stringify(unseen) === '["c1"]' && !state.introducedNpcs.includes('c1'));
  check('  …named ones (surname, alias) and unknown ids are kept', ['c2', 'c3', 'c_unknown'].every(id => state.introducedNpcs.includes(id)));
  check('  …and the NPC stays present in the scene', state.presentNpcs.includes('c1'));
  check('glossary re-gated from the CURRENT scenario (approved only)', state.glossary.length === 1 && state.glossary[0].term === 'LCA');
  check('technical facts re-seeded from the reviewed record', state.technicalFacts.length === 1 && state.technicalFacts[0].pre_seeded === true);
  check('narrativeStyle forced to focused', state.narrativeStyle === 'focused');
  check('the baked row itself is not mutated', content.baked.state.introducedNpcs.length === 4 && content.baked.state.glossary[0] === 'stale');
  const seed = CO.coldOpenHistorySeed('  The lean cut.  ');
  check('history seed: [GAME_START] user line + the lean cut as the assistant turn', seed.length === 2 && seed[0].role === 'user' && seed[0].content === CO.COLD_OPEN_HISTORY_USER && seed[1].role === 'assistant' && seed[1].content === 'The lean cut.');
  const fpA = CO.fingerprintScenarioData({ scenario: { id: 's', a: 1, b: 2 }, role: { id: 'r' }, characters: [{ id: 'y' }, { id: 'x' }], locations: [], clues: [] });
  const fpB = CO.fingerprintScenarioData({ scenario: { b: 2, id: 's', a: 1 }, role: { id: 'r' }, characters: [{ id: 'x' }, { id: 'y' }], locations: [], clues: [] });
  const fpC = CO.fingerprintScenarioData({ scenario: { id: 's', a: 1, b: 3 }, role: { id: 'r' }, characters: [{ id: 'x' }, { id: 'y' }], locations: [], clues: [] });
  check('fingerprint: key order and list order do not matter', fpA === fpB);
  check('fingerprint: a content edit changes it', fpA !== fpC);
  const lint = CO.lintColdOpen(content, { characters });
  check('lint names the NPC the lean cut drops', lint.some(l => l.includes('Calloway')));
}

// ── Shared: content on disk ──────────────────────────────────────────────────
const SCENARIO_ID = 'dog_green_sector';
const ROLE_ID = 'role_battalion_medic';
const OTHER_ROLE = 'role_coxswain';
const { JsonFileStore } = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const R = async (f) => new (await import(`${ROOT}/engine/repositories/${f}.js`))[f](store);
const store = new JsonFileStore(p('engine/data'));
const repos = {
  characters: await R('CharacterRepository'), locations: await R('LocationRepository'), clues: await R('ClueRepository'),
  scenarios: await R('ScenarioRepository'), storyArcs: await R('StoryArcRepository'), players: await R('PlayerRepository'), sessions: await R('SessionRepository'),
};
let haveContent = false;
try { haveContent = !!(await repos.scenarios.findById(SCENARIO_ID)) && !!repos.scenarios.findPlayerRoles(SCENARIO_ID).find(r => r.id === ROLE_ID) && !!repos.scenarios.findPlayerRoles(SCENARIO_ID).find(r => r.id === OTHER_ROLE); } catch {}
if (!haveContent || !process.env.SUPABASE_URL) {
  console.log(`\nSKIP  Parts C–D — "${SCENARIO_ID}" content not on disk or no Supabase credentials.`);
  console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll cold-open assertions passed (A–B).');
  process.exit(failed ? 1 : 0);
}
const medic = repos.scenarios.findPlayerRoles(SCENARIO_ID).find(r => r.id === ROLE_ID);
const START_LOC = medic.startLocationId || medic.startLocation;

// ── Scripted api.anthropic.com ───────────────────────────────────────────────
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
const model = { story: [], classifier: [], throwNext: false };
const OPENING = JSON.stringify({ narrative: 'FULL ENGINE OPENING. The ramp drops into red surf. Men fall around you.', choices: ['Engine choice one', 'Engine choice two', 'Engine choice three'], location: START_LOC, timeAdvance: 0 });
const TURN = JSON.stringify({ narrative: 'You crawl through the surf toward the nearest man.', choices: ['Press the wound', 'Drag him higher'], location: START_LOC, timeAdvance: 1 });
let reply = OPENING;
function sse(text) {
  const ev = [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    ...Array.from({ length: Math.ceil(text.length / 40) }, (_, i) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i * 40, i * 40 + 40) } })),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`);
  return new Response(new ReadableStream({ start(c) { const enc = new TextEncoder(); ev.forEach(e => c.enqueue(enc.encode(e))); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  if (body.model?.startsWith('claude-haiku')) { model.classifier.push(body); return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }], usage: {} }), { status: 200 }); }
  model.story.push(body);
  if (model.throwNext) { model.throwNext = false; throw new Error('scripted model failure'); }
  return body.stream ? sse(reply) : new Response(JSON.stringify({ content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200 });
};

const { createGameRouter, coldOpenFingerprintFor } = await import(`${ROOT}/engine/server/gameRouter.js`);
const { createMemoryDemoStore } = await import(`${ROOT}/engine/server/demoStore.js`);
const snapshot = dir => { try { return new Set(fs.readdirSync(p(dir))); } catch { return new Set(); } };
const SWEEP = ['engine/data/sessions', 'engine/data/transcripts', 'data/sessions'];
const before = Object.fromEntries(SWEEP.map(d => [d, snapshot(d)]));
const servers = [], children = [];
const listen = async app => { const s = app.listen(0); await new Promise(r => s.once('listening', r)); servers.push(s); return `http://127.0.0.1:${s.address().port}`; };
async function post(base, url, body) {
  const resp = await realFetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await resp.text();
  const events = text.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: resp.status, events, json, done: events.find(e => e.type === 'done') || null };
}

let rowsFile = null;
try {
  // ── Part C ─────────────────────────────────────────────────────────────────
  console.log('\nPart C — router + page: cost, handoff, UI');

  // Bake through the real /start (a prod-mode router), exactly as scripts/cold-open-bake.mjs does.
  const bakeBase = await listen(express().use(express.json({ limit: '10mb' })).use('/game/api', createGameRouter(repos, { anthropicApiKey: 'cold-open-test-key' })));
  const bake = async roleId => {
    reply = OPENING;
    const r = await post(bakeBase, '/game/api/start', { scenarioId: SCENARIO_ID, roleId, narrativeStyle: 'focused', onboardingFlow: 'streamlined' });
    if (!r.done) throw new Error(`bake of ${roleId} failed: ${JSON.stringify(r.events.slice(-1))}`);
    return r.done;
  };
  const bakedMedic = await bake(ROLE_ID), bakedCox = await bake(OTHER_ROLE);
  check('bake: one real /start per role (2 story calls)', model.story.length === 2);
  const LEAN = 'The ramp drops. Red water to the knees.\n\n*Someone up the beach is screaming for a medic.*';
  const row = async (roleId, baked, extra = {}) => ({
    scenario_id: SCENARIO_ID, role_id: roleId, status: 'ready',
    content: {
      intro: roleId === ROLE_ID
        ? { name: 'Dog Green: The Longest Morning', place: 'Omaha Beach', date: 'June 6, 1944', wide: '“The first wave has come apart in the surf.”', role: 'Battalion Medic', unit: '116th Infantry', character: 'You have more wounded than you have hands.' }
        : { name: 'Dog Green: The Longest Morning', place: 'Omaha Beach', date: 'June 6, 1944', wide: 'The ramp drops at 06:36.', role: 'Assault Boat Coxswain', character: 'Every man you land costs you another.' },
      lean: { narrative: LEAN, instruction: 'Your move — choose one, or write your own:', choices: ['Crawl to the screaming man', 'Shout for the litter team', 'Check your aid bag'] },
      baked: { state: baked.nextState, output: baked.output, fingerprint: await coldOpenFingerprintFor(repos, SCENARIO_ID, roleId, baked.nextState), baked_at: new Date().toISOString(), source: '/start' },
      ...extra,
    },
  });
  const rows = [await row(ROLE_ID, bakedMedic), await row(OTHER_ROLE, bakedCox)];
  const bakedTurnCount = bakedMedic.nextState.turnCount;

  const demoStore = createMemoryDemoStore();
  const cfg = CO.readColdOpenConfig({ DEMO_COLD_OPEN: 'true', DEMO_FEATURED_SCENARIO: SCENARIO_ID, DEMO_FEATURED_ROLE: ROLE_ID }, { demoMode: true, demoScenarios: [SCENARIO_ID] });
  const runtime = CO.createColdOpenRuntime({
    config: cfg,
    store: CO.createColdOpenStore({ fetchRows: async sid => rows.filter(r => r.scenario_id === sid && r.status === 'ready') }),
    fingerprintFor: (s, r, st) => coldOpenFingerprintFor(repos, s, r, st),
  });
  const routerCfg = { anthropicApiKey: 'cold-open-test-key', demoMode: true, demoScenarios: [SCENARIO_ID], demoStore, demoLimits: { dailyStartsPerIp: 3, globalPerMin: 1000, ipPerMin: 1000 }, coldOpen: runtime };
  const BASE = await listen(express().use(express.json({ limit: '10mb' })).use('/game/api', createGameRouter(repos, routerCfg)));

  // The entry page, as the guard builds it — with fast pacing so the test does not wait seconds.
  const FAST = { titleIn: 10, quoteIn: 300, s1out: 600, s2in: 700, charIn: 950, s2out: 1200, reveal: 1300, skipHint: 150, fade: 20, dissolve: 20 };
  const pageHtml = timings => DM.injectColdOpenIntoGameHtml(DM.injectDemoIntoGameHtml(fs.readFileSync(p('engine/game/index.html'), 'utf8')),
    { scenarioId: SCENARIO_ID, roleId: ROLE_ID, timings, historyUser: CO.COLD_OPEN_HISTORY_USER },
    { css: fs.readFileSync(DM.COLD_OPEN_CSS_PATH, 'utf8'), js: fs.readFileSync(DM.COLD_OPEN_JS_PATH, 'utf8') });

  async function openPage({ timings = FAST, reducedMotion = false, base = BASE } = {}) {
    const log = { urls: [], turnBodies: [], turnDone: [] };
    const dom = new JSDOM(pageHtml(timings), {
      url: `${base}/`, runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(win) {
        win.fetch = async (u, o) => {
          const href = new URL(u, base).href;
          log.urls.push(new URL(href).pathname);
          if (href.includes('/game/api/turn')) log.turnBodies.push(JSON.parse(o.body));
          const resp = await realFetch(href, o);
          if (href.includes('/game/api/turn')) resp.clone().text().then(t => { for (const l of t.split('\n')) if (l.startsWith('data: ')) { try { const e = JSON.parse(l.slice(6)); if (e.type === 'done') log.turnDone.push(e); } catch {} } });
          return resp;
        };
        win.matchMedia = q => ({ matches: reducedMotion && /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
        win.scrollTo = () => {};
        win.HTMLElement.prototype.scrollIntoView = () => {};
        win.speechSynthesis ??= { getVoices: () => [], cancel() {}, speak() {} };
        win.console.error = () => {};
      },
    });
    const win = dom.window, doc = win.document;
    await until(() => doc.querySelector('.co-head'), 8000);
    return { dom, win, doc, log };
  }

  // C1 — COST: loading the entry.
  model.story.length = 0; model.classifier.length = 0;
  const { win, doc, log } = await openPage();
  check('page reached the scene (header row rendered)', !!doc.querySelector('.co-head'));
  check(`entry load fetched only bootstrap + cold-open (${log.urls.join(', ')})`, JSON.stringify(log.urls) === JSON.stringify(['/game/api/bootstrap', '/game/api/cold-open']));
  check('COST: entry load made ZERO model calls', model.story.length === 0 && model.classifier.length === 0, `story=${model.story.length} classifier=${model.classifier.length}`);
  check('the URL carries the featured scenario for the page script', new win.URL(win.location.href).searchParams.get('scenarioId') === SCENARIO_ID);

  // C2 — the two title screens → dissolve.
  const ov = doc.getElementById('co-overlay');
  const q = sel => ov.querySelector(sel);
  const coCss = fs.readFileSync(DM.COLD_OPEN_CSS_PATH, 'utf8');
  check('screen 1: the story name (large), then place · date beneath it', q('.co-s1 .co-title .co-name').textContent === 'Dog Green: The Longest Morning'
    && q('.co-s1 .co-title .co-dateline').textContent === 'Omaha Beach · June 6, 1944' && q('.co-title').firstElementChild === q('.co-name'));
  check('screen 1: the wide line below the title, NO quotation marks (even if the row has them), italic', q('.co-s1 .co-wide').textContent === 'The first wave has come apart in the surf.'
    && q('.co-title').nextElementSibling === q('.co-wide') && win.getComputedStyle(q('.co-wide')).fontStyle === 'italic');
  check('screen 2: "You are a Battalion Medic, 116th Infantry" — role noun and unit in their own spans', q('.co-s2 .co-you').textContent === 'You are a Battalion Medic, 116th Infantry'
    && q('.co-you .co-you-role').textContent === 'Battalion Medic' && q('.co-you .co-you-unit').textContent === ', 116th Infantry');
  check('screen 2: the character line below it, WITH quotation marks', q('.co-s2 .co-character').textContent === '“You have more wounded than you have hands.”' && q('.co-you').nextElementSibling === q('.co-character'));
  check('accent: place · date and the role noun read in the demo gold #d6a64c', /--demo-accent: #d6a64c/.test(coCss)
    && /\.co-dateline \{[^}]*color: var\(--demo-accent/.test(coCss) && /\.co-you-role \{ color: var\(--demo-accent/.test(coCss) && /\.co-you-unit \{ color: #a89f8d/.test(coCss));
  check('overlay up at load; skip hint present', !ov.hidden && q('.co-skip').textContent === 'Tap to skip');
  check('title block fades in first (opacity transition), before the wide line', await until(() => q('.co-title').style.opacity === '1', 2000) && /opacity 20ms/.test(q('.co-title').style.transition) && q('.co-wide').style.opacity !== '1');
  check('then the wide line', await until(() => q('.co-wide').style.opacity === '1', 2000));
  check('skip hint fades in', await until(() => q('.co-skip').style.opacity === '1', 2000));
  check('screen 1 fades out before screen 2 comes in', await until(() => q('.co-s1').style.opacity === '0', 2000) && q('.co-you').style.opacity !== '1');
  check('screen 2: "You are …", then the character line', await until(() => q('.co-you').style.opacity === '1', 2000) && q('.co-character').style.opacity !== '1' && await until(() => q('.co-character').style.opacity === '1', 2000));
  check('overlay dissolves away onto the scene', await until(() => ov.hidden, 3000));

  // C3 — the scene.
  const story = doc.getElementById('story');
  check('lean narrative on screen (both paragraphs), not the engine\'s full opening', /The ramp drops\. Red water/.test(story.textContent) && /screaming for a medic/.test(story.textContent) && !/FULL ENGINE OPENING/.test(doc.body.textContent));
  const choiceBtns = [...doc.querySelectorAll('.co-choices .choice-btn')];
  const lineEls = [...story.querySelectorAll('.scene-card .line')];
  check('a *wholly emphasised* paragraph (the call line) is tagged italic; plain narration is not', lineEls.length === 2 && !lineEls[0].classList.contains('co-em') && lineEls[1].classList.contains('co-em')
    && win.getComputedStyle(lineEls[1].querySelector('em')).fontStyle === 'italic' && win.getComputedStyle(lineEls[0].querySelector('em')).fontStyle === 'normal');
  check('the three starting choices', JSON.stringify(choiceBtns.map(b => b.textContent)) === JSON.stringify(['Crawl to the screaming man', 'Shout for the litter team', 'Check your aid bag']));
  check('instruction line above the choices', doc.querySelector('#story > .co-instruction')?.textContent === 'Your move — choose one, or write your own:');
  // The page's native screen-1 input ("Your move." textarea + Submit) must not be on the cold open.
  check('native screen-1 input ABSENT from the DOM (no #input-form, no #player-input, no "Your move." / Submit)',
    !doc.getElementById('input-form') && !doc.getElementById('player-input') && !doc.querySelector('textarea[placeholder="Your move."]')
    && ![...doc.querySelectorAll('button')].some(b => b.textContent.trim() === 'Submit' && b.isConnected));
  check('native "↓" scroll hint not shown while the cold open is the screen', win.getComputedStyle(doc.querySelector('.scroll-hint')).display === 'none');
  const coInput = doc.querySelector('.co-input');
  check('the cold open\'s own free-text input + Send button, enabled', !!coInput && !!coInput.querySelector('textarea') && coInput.querySelector('button[type="submit"]')?.textContent === 'Send');
  // The target: ONE flowing column in the story feed, in exactly this order.
  const order = [...story.children].filter(n => win.getComputedStyle(n).display !== 'none').map(n =>
    n.classList.contains('co-head') ? 'header' : n.querySelector?.('.scene-card') ? 'narrative' : n.classList.contains('co-instruction') ? 'instruction'
    : n.classList.contains('co-choices') ? 'choices' : n.classList.contains('co-input') ? 'input' : n.classList.contains('co-foot') ? 'footer' : n.className);
  check(`scene column order: header → narrative → instruction → choices → input → footer (got ${order.join(' → ')})`,
    JSON.stringify(order) === JSON.stringify(['header', 'narrative', 'instruction', 'choices', 'input', 'footer']));
  check('the scene does NOT use the pinned bottom bar (hidden), no choices/input/footer in it', win.getComputedStyle(doc.querySelector('.bottom-bar')).display === 'none'
    && !doc.querySelector('.bottom-bar .co-instruction, .bottom-bar .co-input, .bottom-bar .co-foot, .bottom-bar .co-choices'));
  check('native game chrome hidden: title bar, location subtitle, Begin Again, Notes, ← Stories', win.getComputedStyle(doc.querySelector('header.hero')).display === 'none'
    && ['header-title', 'header-subtitle', 'new-game-btn', 'notes-btn'].every(id => doc.getElementById(id)?.closest('header.hero')) && !!doc.querySelector('header.hero .back-link'));
  check('first-paint guard released once the scene is built (no co-pending)', !doc.documentElement.classList.contains('co-pending') && doc.documentElement.classList.contains('co-active'));
  const head = doc.querySelector('.co-head');
  check('header row: role on the left, "The history" on the right, in ONE row', head.firstElementChild.classList.contains('co-role') && /Battalion Medic/.test(head.firstElementChild.textContent) && head.lastElementChild.textContent === 'The history' && head.children.length === 2);
  check('role switcher reads as changeable: "The Battalion Medic · change role ▾"', head.firstElementChild.textContent === 'The Battalion Medic · change role ▾');
  check('header row is the top of the view (first in the feed, page header hidden)', story.firstElementChild === head);
  const foot = doc.querySelector('#story > .co-foot');
  check('footer: "Another moment" → /moments, "Replay the open"', foot?.querySelector('a')?.getAttribute('href') === '/moments' && foot?.querySelector('a')?.textContent === 'Another moment' && foot?.querySelector('button')?.textContent === 'Replay the open');
  check('header back link leads to /moments, not back into the entry', doc.querySelector('header.hero .back-link').getAttribute('href') === '/moments');
  check('role-selection overlay never shown', doc.getElementById('role-overlay').classList.contains('hidden'));
  check('client display state carries no baked state (no npc_states)', !win.eval('gameState').npc_states && win.eval('gameState.__coldOpen') === true);

  // C4 — the history panel: the scenario's real introduction.
  const scen = await repos.scenarios.findById(SCENARIO_ID);
  const introTexts = ['world', 'stakes', 'scene'].map(t => (scen.introduction?.sections || []).find(s => s.type === t)?.text).filter(Boolean);
  head.lastElementChild.click();
  let panel = doc.querySelector('.co-panel');
  check('"The history" opens a panel with the scenario\'s real introduction', !!panel && introTexts.length > 0 && introTexts.every(t => panel.textContent.includes(t)));
  panel.querySelector('.co-close').click();
  check('  …which closes', !doc.querySelector('.co-panel'));

  // C5 — the role switcher: the scenario's real roles.
  head.firstElementChild.click();
  panel = doc.querySelector('.co-panel');
  const roles = repos.scenarios.findPlayerRoles(SCENARIO_ID);
  const items = panel ? [...panel.querySelectorAll('.co-roles button')] : [];
  check(`role switcher lists the scenario's ${roles.length} real roles with descriptions`, items.length === roles.length && roles.every(r => items.some(b => b.textContent.includes(r.description?.slice(0, 30) || ''))));
  check('  …current role marked', items.filter(b => b.getAttribute('aria-current') === 'true').length === 1 && /Battalion Medic/.test(panel.querySelector('[aria-current="true"]').textContent) && /Current/.test(panel.querySelector('[aria-current="true"]').textContent));
  const coxBtn = items.find(b => /Coxswain/.test(b.textContent));
  log.urls.length = 0;
  coxBtn.click();
  check('choosing a role with its own cold open re-opens the entry from that role', await until(() => /Coxswain/.test(doc.querySelector('.co-head .co-role')?.textContent || ''), 4000) && log.urls.includes('/game/api/cold-open'));
  check('  …the intro replays for it: "You are an Assault Boat Coxswain" (an, no unit)', ov.querySelector('.co-you').textContent === 'You are an Assault Boat Coxswain' && !ov.querySelector('.co-you-unit'));
  check('  …and it made no model call', model.story.length === 0);
  await until(() => ov.hidden, 3000);
  // Back to the medic for the handoff.
  doc.querySelector('.co-head .co-role').click();
  [...doc.querySelectorAll('.co-roles button')].find(b => /Battalion Medic/.test(b.textContent)).click();
  await until(() => /Battalion Medic/.test(doc.querySelector('.co-head .co-role')?.textContent || ''), 4000);
  await until(() => ov.hidden, 3000);

  // C6 — Replay the open.
  doc.querySelector('.co-foot button').click();
  check('"Replay the open" brings the overlay back', await until(() => !ov.hidden, 2000));
  await until(() => ov.hidden && doc.querySelector('.co-head'), 4000);
  check('  …and lands on the same scene again, still zero model calls', !!doc.querySelector('.co-choices .choice-btn') && model.story.length === 0);

  // C7 — HANDOFF + COST: the first action.
  reply = TURN;
  const sid = win.eval('sessionId');
  doc.querySelector('.co-choices .choice-btn').click();
  check('first action: one /turn request', await until(() => log.turnDone.length === 1, 8000), `turns=${log.turnBodies.length}`);
  check('COST: the first action made EXACTLY ONE model call', model.story.length === 1 && model.classifier.length === 0, `story=${model.story.length} classifier=${model.classifier.length}`);
  const tb = log.turnBodies[0];
  check('the request is tagged coldOpen { scenario, role }', tb.coldOpen?.scenarioId === SCENARIO_ID && tb.coldOpen?.roleId === ROLE_ID && tb.playerInput === 'Crawl to the screaming man');
  const msgs = model.story[0].messages;
  check('model history begins with the lean cut the player read', msgs[0].role === 'user' && msgs[0].content === CO.COLD_OPEN_HISTORY_USER && msgs[1].role === 'assistant' && msgs[1].content === LEAN);
  check('model was not shown the engine\'s full opening', !JSON.stringify(msgs).includes('FULL ENGINE OPENING'));
  const done1 = log.turnDone[0];
  check(`turn ran on the server-held BAKED state (turnCount ${bakedTurnCount} → ${bakedTurnCount + 1}, client state had none)`, done1.nextState.turnCount === bakedTurnCount + 1 && done1.nextState.scenarioId === SCENARIO_ID && done1.nextState.playerRoleId === ROLE_ID);
  check('baked engine state carried through (npc_states present)', !!done1.nextState.npc_states && !('__coldOpen' in done1.nextState));
  check('the story continues on screen; the page adopted the live state', /crawl through the surf/.test(story.textContent) && await until(() => win.eval('gameState.__coldOpen') === undefined, 2000));
  check('cold-open chrome gone once live (instruction, footer, own input)', !doc.querySelector('.co-instruction') && !doc.querySelector('.co-foot') && !doc.querySelector('.co-input'));
  check('once live, the page\'s native input is back in place (above the choices) and working', !!doc.getElementById('input-form') && !!doc.getElementById('player-input')
    && doc.getElementById('input-form').nextElementSibling?.id === 'stream-options-dots' && !doc.documentElement.classList.contains('co-active'));
  check('once live, the normal chrome is back: page header + bottom bar shown, column gone, turn 1 choices in the page\'s own #choices',
    win.getComputedStyle(doc.querySelector('header.hero')).display !== 'none' && win.getComputedStyle(doc.querySelector('.bottom-bar')).display !== 'none'
    && !doc.querySelector('.co-choices') && [...doc.querySelectorAll('#choices .choice-btn')].map(b => b.textContent).join('|') === 'Press the wound|Drag him higher');
  const tpath = p('engine/data/transcripts', `${sid}.md`);
  check('transcript opened like /start: header, scenario line, lean opening, then the turn', await until(() => fs.existsSync(tpath) && /## Scenario: dog_green_sector/.test(fs.readFileSync(tpath, 'utf8')) && fs.readFileSync(tpath, 'utf8').includes(LEAN) && /## Entry: cold open/.test(fs.readFileSync(tpath, 'utf8')), 3000));
  check('demo transcript row: one row, opening = the lean cut as a cold open, role set, turn 1 appended', await until(() => {
    const t = demoStore.state.transcripts.get(sid);
    return t && t.opening?.entry === 'cold_open' && t.opening.narrative === LEAN && t.role_id === ROLE_ID && t.turns.length === 1;
  }, 3000));

  // C8 — the next action is an ordinary turn.
  reply = TURN;
  doc.querySelector('#choices .choice-btn').click();
  await until(() => log.turnDone.length === 2, 8000);
  check('second action: no coldOpen tag, an ordinary /turn on the live state', log.turnBodies.length === 2 && !log.turnBodies[1].coldOpen && log.turnBodies[1].state.turnCount === bakedTurnCount + 1);
  check('second action: one more model call (2 total)', model.story.length === 2);
  check('second action: history still carries the opening then turn 1', log.turnBodies[1].history[1].content === LEAN && log.turnBodies[1].history.length === 4);
  win.close();

  // C9 — metering: the first action is a START (daily cap 3 here), refunded when not delivered.
  const coBody = (extra = {}) => ({ playerInput: 'Crawl to the screaming man', sessionId: crypto.randomUUID(), state: { scenarioId: SCENARIO_ID, junk: true }, coldOpen: { scenarioId: SCENARIO_ID, roleId: ROLE_ID }, ...extra });
  const n0 = model.story.length;
  model.throwNext = true;
  const failedTurn = await post(BASE, '/game/api/turn', coBody());
  await tick(100);
  check('a failed first action delivers no turn (error event)', !failedTurn.done && failedTurn.events.some(e => e.type === 'error'));
  reply = TURN;
  const typed = await post(BASE, '/game/api/turn', coBody({ playerInput: 'I keep my head down and look for the loudest wound.', player_action: 'I keep my head down and look for the loudest wound.' }));
  check('typed first action: delivered, exactly one model call (benign text: no classifier)', !!typed.done && model.story.length === n0 + 2 && model.classifier.length === 0, `story +${model.story.length - n0} classifier ${model.classifier.length}`);
  const third = await post(BASE, '/game/api/turn', coBody());
  check('a third cold-open start today is still allowed (the failed one was refunded)', !!third.done);
  const before4 = model.story.length;
  const fourth = await post(BASE, '/game/api/turn', coBody());
  check('the fourth is refused by the daily start cap, with no model call', fourth.status === 403 && fourth.json?.demoLimit === 'daily' && model.story.length === before4);
  const ordinary = await post(BASE, '/game/api/turn', { playerInput: 'Keep going', sessionId: crypto.randomUUID(), state: done1.nextState });
  check('an ordinary turn is NOT start-metered (allowed past the daily cap)', !!ordinary.done);
  check('a junk client state on the first action was ignored (baked state used)', third.done.nextState.turnCount === bakedTurnCount + 1 && !('junk' in third.done.nextState));
  const missingRow = await post(BASE, '/game/api/turn', coBody({ coldOpen: { scenarioId: SCENARIO_ID, roleId: 'role_ranger_sergeant' } }));
  check('first action for a role with no ready row → 404, no model call', missingRow.status === 404 && model.story.length === before4 + 1);

  // C10 — display endpoint leaks no state.
  const disp = await realFetch(`${BASE}/game/api/cold-open?scenarioId=${SCENARIO_ID}&roleId=${ROLE_ID}`).then(r => r.json());
  check('GET /cold-open returns display fields only (no baked state, no fingerprint)', disp.narrative === LEAN && disp.choices.length === 3 && !JSON.stringify(disp).includes('npc_states') && !JSON.stringify(disp).includes('fingerprint') && JSON.stringify(disp.readyRoles.sort()) === JSON.stringify([OTHER_ROLE, ROLE_ID].sort()));
  check('GET /cold-open for a non-whitelisted scenario → 404', (await realFetch(`${BASE}/game/api/cold-open?scenarioId=apollo_13_lifeboat&roleId=x`)).status === 404);

  // C11 — reduced motion: no fades.
  const rm = await openPage({ reducedMotion: true });
  const rq = sel => rm.doc.querySelector('#co-overlay ' + sel);
  check('prefers-reduced-motion: screen 1 whole at once, no fade (0ms transitions)', await until(() => rq('.co-title').style.opacity === '1' && rq('.co-wide').style.opacity === '1', 2000)
    && /opacity 0ms/.test(rq('.co-title').style.transition) && /opacity 0ms/.test(rq('.co-wide').style.transition));
  check('  …and the overlay clears to the scene', await until(() => rm.doc.getElementById('co-overlay').hidden, 3000));
  check('  …without staging screen 2', rq('.co-you').style.opacity !== '1' && rq('.co-character').style.opacity !== '1');
  rm.win.close();

  // C12 — tap to skip.
  const sk = await openPage({ timings: { ...CO.COLD_OPEN_TIMINGS, dissolve: 20 } });
  sk.doc.getElementById('co-overlay').click();
  check('tap anywhere skips the intro straight to the scene', await until(() => sk.doc.getElementById('co-overlay').hidden, 1500));
  sk.win.close();

  // C12b — first paint: only the overlay can be painted before the scene exists.
  {
    const html = pageHtml(FAST);
    const css = fs.readFileSync(DM.COLD_OPEN_CSS_PATH, 'utf8');
    check('first paint: the co-pending class is set in <head>, before <body> is parsed', html.indexOf("classList.add('co-boot', 'co-pending', 'co-active')") > -1 && html.indexOf("classList.add('co-boot', 'co-pending', 'co-active')") < html.indexOf('<body'));
    check('first paint: the cold-open stylesheet (with the co-pending blackout) is in <head>', html.indexOf('id="cold-open-css"') < html.indexOf('</head>') && /html\.co-pending body > :not\(#co-overlay\) \{ visibility: hidden !important; \}/.test(css));
    // Before the page script's loadGame resolves, nothing but the overlay is visible.
    const early = new JSDOM(html, { url: `${BASE}/`, runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w) { w.fetch = () => new Promise(() => {}); w.scrollTo = () => {}; w.speechSynthesis ??= { getVoices: () => [], cancel() {}, speak() {} }; w.console.error = () => {}; } });
    const ed = early.window.document;
    const vis = n => early.window.getComputedStyle(n).visibility;
    check('before the scene is built: page header hidden, overlay showing, html still co-pending', ed.documentElement.classList.contains('co-pending') && vis(ed.querySelector('header.hero')) === 'hidden' && vis(ed.getElementById('input-form')) === 'hidden' && !ed.getElementById('co-overlay').hidden && vis(ed.getElementById('co-overlay')) !== 'hidden');
    early.window.close();
  }

  // C12c — a typed first action through the cold open's own input (fresh router: own daily cap).
  {
    const typedBase = await listen(express().use(express.json({ limit: '10mb' })).use('/game/api', createGameRouter(repos, { ...routerCfg, demoStore: createMemoryDemoStore() })));
    const tp = await openPage({ base: typedBase });
    await until(() => tp.doc.getElementById('co-overlay').hidden, 3000);
    const n0 = model.story.length;
    reply = TURN;
    tp.doc.getElementById('co-player-input').value = 'I keep low and crawl toward the voice.';
    tp.doc.querySelector('.co-input').requestSubmit();
    check('typed first action through the cold open\'s input: one tagged /turn, sent as player_action', await until(() => tp.log.turnDone.length === 1, 8000)
      && tp.log.turnBodies[0].coldOpen?.roleId === ROLE_ID && tp.log.turnBodies[0].player_action === 'I keep low and crawl toward the voice.' && model.story.length === n0 + 1);
    check('  …then the native input is back and the cold-open input gone', !!tp.doc.getElementById('input-form') && !tp.doc.querySelector('.co-input'));
    tp.win.close();
  }

  // C13 — flag off at the router: no route, /turn ignores a coldOpen tag.
  const offBase = await listen(express().use(express.json({ limit: '10mb' })).use('/game/api', createGameRouter(repos, { ...routerCfg, coldOpen: undefined, demoStore: createMemoryDemoStore() })));
  check('router without the cold open: GET /cold-open → 404', (await realFetch(`${offBase}/game/api/cold-open?scenarioId=${SCENARIO_ID}&roleId=${ROLE_ID}`)).status === 404);
  const clientState = { ...done1.nextState, turnCount: 41 };
  reply = TURN;
  const offTurn = await post(offBase, '/game/api/turn', { playerInput: 'x', sessionId: crypto.randomUUID(), state: clientState, coldOpen: { scenarioId: SCENARIO_ID, roleId: ROLE_ID } });
  check('router without the cold open: a coldOpen tag is ignored (client state used, 41 → 42)', offTurn.done?.nextState.turnCount === 42);

  // C14 — DEMO_VISIBLE_ROLES: the coxswain hidden, the medic the only role on offer.
  {
    const visibleRoles = { [SCENARIO_ID]: [ROLE_ID] };
    const vCfg = CO.readColdOpenConfig({ DEMO_COLD_OPEN: 'true', DEMO_FEATURED_SCENARIO: SCENARIO_ID, DEMO_FEATURED_ROLE: ROLE_ID }, { demoMode: true, demoScenarios: [SCENARIO_ID], visibleRoles });
    const vRuntime = CO.createColdOpenRuntime({
      config: vCfg,
      store: CO.createColdOpenStore({ fetchRows: async sid => rows.filter(r => r.scenario_id === sid && r.status === 'ready') }),
      fingerprintFor: (s, r, st) => coldOpenFingerprintFor(repos, s, r, st),
    });
    const vStore = createMemoryDemoStore();
    const vBase = await listen(express().use(express.json({ limit: '10mb' })).use('/game/api', createGameRouter(repos, { ...routerCfg, coldOpen: vRuntime, demoStore: vStore, demoVisibleRoles: visibleRoles })));
    const bootRoles = async base => ((await (await realFetch(`${base}/game/api/bootstrap?scenarioId=${SCENARIO_ID}`)).json()).scenario?.playerRoleOptions || []).map(r => r.id);
    const allRoles = repos.scenarios.findPlayerRoles(SCENARIO_ID).map(r => r.id);
    check('visible roles: bootstrap lists only the visible role', JSON.stringify(await bootRoles(vBase)) === JSON.stringify([ROLE_ID]));
    check('visible roles: without the list, bootstrap lists every role (unchanged)', JSON.stringify(await bootRoles(BASE)) === JSON.stringify(allRoles) && allRoles.length > 1);
    const prodBase = await listen(express().use(express.json({ limit: '10mb' })).use('/game/api', createGameRouter(repos, { anthropicApiKey: 'cold-open-test-key', demoVisibleRoles: visibleRoles })));
    check('visible roles: ignored with DEMO_MODE off (prod router lists every role)', JSON.stringify(await bootRoles(prodBase)) === JSON.stringify(allRoles));

    const n0 = model.story.length;
    const hiddenStart = await post(vBase, '/game/api/start', { scenarioId: SCENARIO_ID, roleId: OTHER_ROLE, narrativeStyle: 'focused' });
    check('visible roles: /start with a hidden role → 404, no model call', hiddenStart.status === 404 && model.story.length === n0);
    check('visible roles: …refused before the demo limits run (no budget read, no transcript)', !vStore.state.calls.includes('readBudget') && !vStore.state.calls.includes('startTranscript'), vStore.state.calls.join(','));
    const forged = await post(vBase, '/game/api/turn', { playerInput: 'x', sessionId: crypto.randomUUID(), state: { ...done1.nextState, playerRoleId: OTHER_ROLE } });
    check('visible roles: /turn on a hand-made state naming a hidden role → 404, no model call', forged.status === 404 && model.story.length === n0);
    check('visible roles: GET /cold-open for the hidden role → 404', (await realFetch(`${vBase}/game/api/cold-open?scenarioId=${SCENARIO_ID}&roleId=${OTHER_ROLE}`)).status === 404);
    const vis = await (await realFetch(`${vBase}/game/api/cold-open?scenarioId=${SCENARIO_ID}&roleId=${ROLE_ID}`)).json();
    check('visible roles: the visible role\'s cold open is served, readyRoles lists only it', vis.roleId === ROLE_ID && JSON.stringify(vis.readyRoles) === JSON.stringify([ROLE_ID]));
    const hiddenFirst = await post(vBase, '/game/api/turn', { playerInput: 'x', sessionId: crypto.randomUUID(), state: {}, coldOpen: { scenarioId: SCENARIO_ID, roleId: OTHER_ROLE } });
    check('visible roles: a cold-open first turn tagged with the hidden role → 404, no model call', hiddenFirst.status === 404 && model.story.length === n0);
    check('visible roles: ?roleId=<hidden> at / → the featured entry', (await vRuntime.entryFor(SCENARIO_ID, OTHER_ROLE))?.roleId === ROLE_ID);

    // The page: one role on offer → no switcher in the header (and so none on the rail).
    const vp = await openPage({ base: vBase });
    await until(() => vp.doc.getElementById('co-overlay').hidden, 3000);
    const vHead = vp.doc.querySelector('.co-head');
    check('visible roles: header shows the role name with no switcher', !vHead.querySelector('.co-role') && /Battalion Medic/.test(vHead.querySelector('.co-role-static')?.textContent || '') && !/change role/.test(vHead.textContent));
    check('visible roles: "The history" still in the header', /The history/.test(vHead.textContent));
    vp.win.close();
  }

  // ── Part D: server boots ───────────────────────────────────────────────────
  console.log('\nPart D — server boots: /, /moments, /health, fail-safes');
  const MANIFEST = JSON.parse(fs.readFileSync(p('tests/fixtures/cold-open-baseline/manifest.json'), 'utf8'));
  const LIMEN_LANDING_SHA = MANIFEST.shapes.limen['GET /'].sha256;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-open-test-'));
  rowsFile = path.join(tmp, 'rows.json');
  const stale = await row(OTHER_ROLE, bakedCox);
  stale.content.baked.fingerprint = 'sha256:' + '0'.repeat(64);
  fs.writeFileSync(rowsFile, JSON.stringify([rows[0], stale]));
  const draftFile = path.join(tmp, 'draft.json');
  fs.writeFileSync(draftFile, JSON.stringify([{ ...rows[0], status: 'draft' }]));

  const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); });
  const LIMEN = { DEMO_MODE: 'true', DEMO_SCENARIOS: 'steel_curtain_cantigny,dog_green_sector', DEMO_SITE_NAME: 'Project Limen', DEMO_SITE_URL: 'https://projectlimen.com',
    DEMO_SITE_TAGLINE: 'Cross the threshold of a turning point in history.', DEMO_OG_IMAGE_FILE: 'projectlimen-og.png', DEMO_BUDGET_ID: 'limen' };
  async function bootServer(label, extra) {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), ELEVENLABS_API_KEY: '', LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '', ...LIMEN,
      DEMO_COLD_OPEN: 'true', DEMO_FEATURED_SCENARIO: SCENARIO_ID, DEMO_FEATURED_ROLE: ROLE_ID, ...extra };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    const child = spawn(process.execPath, ['engine/server/server.js'], { cwd: REPO_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${label} did not boot:\n${out.slice(-1500)}`)), 120000);
      const on = d => { out += d; if (out.includes('Engine running at')) { clearTimeout(t); res(); } };
      child.stdout.on('data', on); child.stderr.on('data', on);
      child.on('exit', c => { clearTimeout(t); rej(new Error(`${label} exited ${c}:\n${out.slice(-1500)}`)); });
    });
    const base = `http://localhost:${port}`;
    const get = async url => { const r = await realFetch(base + url, { redirect: 'manual', headers: { 'User-Agent': 'cold-open-test-bot' } }); const b = Buffer.from(await r.arrayBuffer()); return { status: r.status, location: r.headers.get('location'), cc: r.headers.get('cache-control'), body: b, text: b.toString(), sha: crypto.createHash('sha256').update(b).digest('hex') }; };
    return { get, log: () => out, stop: () => child.kill() };
  }

  const s1 = await bootServer('ready', { DEMO_COLD_OPEN_FILE: rowsFile });
  {
    const root = await s1.get('/');
    const expected = DM.injectColdOpenIntoGameHtml(DM.injectDemoIntoGameHtml(fs.readFileSync(p('engine/game/index.html'), 'utf8')),
      { scenarioId: SCENARIO_ID, roleId: ROLE_ID, timings: CO.COLD_OPEN_TIMINGS, historyUser: CO.COLD_OPEN_HISTORY_USER },
      { css: fs.readFileSync(DM.COLD_OPEN_CSS_PATH, 'utf8'), js: fs.readFileSync(DM.COLD_OPEN_JS_PATH, 'utf8') });
    check('/ is the cold-open entry: the game page + demo injection + cold-open injection, exactly', root.status === 200 && root.text === expected);
    check('/ entry is never cached (no-store)', root.cc === 'no-store');
    check('/ entry boots with the default pacing constants', root.text.includes(JSON.stringify(CO.COLD_OPEN_TIMINGS)));
    const moments = await s1.get('/moments');
    const momentsScript = moments.text.match(/<script id="cold-open-moments">[\s\S]*?<\/script>\n/)?.[0] || '';
    const momentsBase = crypto.createHash('sha256').update(moments.text.replace(momentsScript, '')).digest('hex');
    check('"Another moment": /moments is today\'s card landing byte-for-byte, plus only the card-link script', moments.status === 200 && !!momentsScript && momentsBase === LIMEN_LANDING_SHA);
    check('/moments knows which scenarios have a ready cold open (dog_green_sector only)', /var ready = \["dog_green_sector"\];/.test(momentsScript));
    // The card links, as the landing's own script builds them from /api/stories.
    {
      const dom = new JSDOM(moments.text, { url: 'http://demo.test/moments', runScripts: 'dangerously',
        beforeParse(w) { w.fetch = async () => new Response(JSON.stringify([{ id: 'dog_green_sector', title: 'Dog Green' }, { id: 'steel_curtain_cantigny', title: 'Cantigny' }]), { status: 200 }); } });
      await until(() => dom.window.document.querySelectorAll('#stories a.story').length === 2, 3000);
      const hrefs = Object.fromEntries([...dom.window.document.querySelectorAll('#stories a.story')].map(a => [a.querySelector('.story-title').textContent, a.getAttribute('href')]));
      check(`/moments card for a baked scenario → its cold open; unbaked → normal start (${JSON.stringify(hrefs)})`, hrefs['Dog Green'] === '/?scenarioId=dog_green_sector' && hrefs['Cantigny'] === '/game?scenarioId=steel_curtain_cantigny');
      dom.window.close();
    }
    const dgOpen = await s1.get('/?scenarioId=dog_green_sector');
    check('/?scenarioId=dog_green_sector (from a card) → the Dog Green cold open (black fade → scene)', dgOpen.status === 200 && dgOpen.text.includes('window.__COLD_OPEN__ = {"scenarioId":"dog_green_sector","roleId":"role_battalion_medic"'));
    const unbaked = await s1.get('/?scenarioId=steel_curtain_cantigny');
    check('/?scenarioId=<no ready row> → 302 to its normal start', unbaked.status === 302 && unbaked.location === '/game?scenarioId=steel_curtain_cantigny', `${unbaked.status} ${unbaked.location}`);
    const outside = await s1.get('/?scenarioId=apollo_13_lifeboat');
    check('/?scenarioId=<not in this demo> → the featured cold open (no leak)', outside.status === 200 && outside.text.includes('"scenarioId":"dog_green_sector"'));
    const game = await s1.get('/game?scenarioId=dog_green_sector');
    check('/game is unchanged (demo injection only, no cold-open code)', game.text === DM.injectDemoIntoGameHtml(fs.readFileSync(p('engine/game/index.html'), 'utf8')));
    const disp1 = JSON.parse((await s1.get(`/game/api/cold-open?scenarioId=${SCENARIO_ID}&roleId=${ROLE_ID}`)).text);
    check('GET /game/api/cold-open serves the row (file source)', disp1.narrative === LEAN);
    await s1.get(`/game/api/bootstrap?scenarioId=${SCENARIO_ID}`);
    await s1.get(`/game/api/cold-open?scenarioId=${SCENARIO_ID}&roleId=${OTHER_ROLE}`);
    await tick(300);
    const h = JSON.parse((await s1.get('/health')).text);
    check('/health: coldOpen.entry is the cold open, featured named', h.coldOpen?.entry === 'cold-open' && h.coldOpen?.featured === `${SCENARIO_ID}/${ROLE_ID}`);
    check('/health: the fresh featured bake is not stale; the tampered one is', !h.coldOpen.stale.includes(`${SCENARIO_ID}/${ROLE_ID}`) && h.coldOpen.stale.includes(`${SCENARIO_ID}/${OTHER_ROLE}`), JSON.stringify(h.coldOpen));
    check('stale bake: logged, and still served', /\[COLD-OPEN\] dog_green_sector\/role_coxswain is STALE/.test(s1.log()) && (await s1.get(`/game/api/cold-open?scenarioId=${SCENARIO_ID}&roleId=${OTHER_ROLE}`)).status === 200);
    check('boot log: cold open enabled, / serves the cold open', /\[COLD-OPEN\] enabled featured=dog_green_sector\/role_battalion_medic source=file/.test(s1.log()) && /\[COLD-OPEN\] \/ serves the cold open/.test(s1.log()));
    check('COST (server): entry + bootstrap + cold-open loads logged no model call', !/\[USAGE\]|\[START\]|\[TURN\]/.test(s1.log()));
  }
  s1.stop();

  for (const [label, extra, reason] of [
    ['featured outside DEMO_SCENARIOS', { DEMO_COLD_OPEN_FILE: rowsFile, DEMO_SCENARIOS: 'steel_curtain_cantigny' }, /not in DEMO_SCENARIOS/],
    ['row source unreadable', { DEMO_COLD_OPEN_FILE: path.join(tmp, 'missing.json') }, /no ready row/],
    ['featured row not ready (draft)', { DEMO_COLD_OPEN_FILE: draftFile }, /no ready row/],
  ]) {
    const s = await bootServer(label, extra);
    const root = await s.get('/');
    check(`fail-safe — ${label}: / is today's card landing, byte-identical`, root.status === 200 && root.sha === LIMEN_LANDING_SHA);
    const h = JSON.parse((await s.get('/health')).text);
    check(`fail-safe — ${label}: /health says landing, with the reason`, h.coldOpen?.entry === 'landing' && reason.test(h.coldOpen?.reason || ''), JSON.stringify(h.coldOpen));
    s.stop();
  }
} catch (err) {
  console.error(`\nERROR  ${err.stack || err.message}`);
  failed++;
} finally {
  for (const s of servers) s.close();
  for (const c of children) c.kill();
  globalThis.fetch = realFetch;
  // Sweep every session/transcript file this run created (twice: some land after the response).
  const sweep = () => { for (const d of SWEEP) for (const f of snapshot(d)) if (!before[d].has(f)) fs.rmSync(p(d, f), { force: true }); };
  sweep(); await tick(1500); sweep();
}

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll cold-open assertions passed.');
process.exit(failed ? 1 : 0);
