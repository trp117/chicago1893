// Conversation-prefix caching (CONV_CACHE_ENABLED) — BILLING ONLY, output-neutral.
//
//   node tests/conv-cache.test.mjs
//
// Part 1 — buildSystemBlocks over the REAL system prompts of the demo scenarios, at every arc
// position, with and without an appended anchor-correction note:
//   OFF: exactly the single block the play path has always sent;
//   ON:  the concatenated text is identical to OFF; ≤ 4 breakpoints; the head is the same bytes
//        at every arc position (so it is a stable cached prefix); both halves cacheable-sized.
// Part 2 — the REQUEST BODIES on the wire. /start and two /turns through the real router with
// api.anthropic.com scripted, captured three ways:
//   BASE: the pre-change router (git HEAD's gameRouter.js, or DEMO… CONV_CACHE_BASE_REF), loaded
//         from a temporary file beside the real one;
//   OFF:  the new router, flag off  → every body byte-identical to BASE;
//   ON:   the new router, flag on   → every body identical to OFF once the system blocks are
//         joined; the messages[] arrays byte-identical; only `system` differs, and only in
//         where its text is cut.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;
const p        = (...s) => path.join(REPO_DIR, ...s);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n          ${detail}` : ''}`);
  if (!ok) failed++;
};

const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { CharacterRepository } = await import(`${ROOT}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { ClueRepository }      = await import(`${ROOT}/engine/repositories/ClueRepository.js`);
const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
const { PlayerRepository }    = await import(`${ROOT}/engine/repositories/PlayerRepository.js`);
const { SessionRepository }   = await import(`${ROOT}/engine/repositories/SessionRepository.js`);
const PC = await import(`${ROOT}/engine/services/PromptComposer.js`);

const store = new JsonFileStore(p('engine/data'));
const repos = {
  characters: new CharacterRepository(store), locations: new LocationRepository(store), clues: new ClueRepository(store),
  scenarios: new ScenarioRepository(store), storyArcs: new StoryArcRepository(store), players: new PlayerRepository(store),
  sessions: new SessionRepository(store),
};
const DEMO_IDS = ['tolle_lege_milan_386', 'ignatius_loyola_1521', 'steel_curtain_cantigny', 'dog_green_sector'];
const SCENARIO_ID = 'steel_curtain_cantigny', ROLE_ID = 'role_artillery_commander';
let haveData = false;
try { haveData = !!(await repos.scenarios.findById(SCENARIO_ID)) && !!repos.scenarios.findPlayerRoles(SCENARIO_ID).find(r => r.id === ROLE_ID); } catch {}
if (!haveData) { console.log(`SKIP  conv-cache.test — "${SCENARIO_ID}" not available (needs restored data + Supabase creds).`); process.exit(0); }

const { buildSystemBlocks, createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);
const joined = blocks => blocks.map(b => b.text).join('');
const SINGLE = text => JSON.stringify([{ type: 'text', text, cache_control: { type: 'ephemeral' } }]);

// ── Part 1 ───────────────────────────────────────────────────────────────────
console.log('\n── Part 1: buildSystemBlocks over the real demo system prompts');
for (const id of DEMO_IDS) {
  const scenario = await repos.scenarios.findById(id);
  if (!scenario) { console.log(`   (skip ${id}: not on disk)`); continue; }
  const raw = PC.buildSystemPrompt(scenario, repos.locations.findByScenario(id), repos.characters.findAll().filter(c => (c.scenarioIds || []).includes(id)));
  const variants = [];
  for (const arc of ['opening', 'middle', 'late', 'final']) for (const note of ['', '\n\nANCHOR NOTE: do not reuse the guttering lamp.']) variants.push(raw.replace('{{ARC_POSITION}}', arc) + note);
  const offOk = variants.every(v => JSON.stringify(buildSystemBlocks(raw, v, { convCache: false })) === SINGLE(v));
  const on = variants.map(v => buildSystemBlocks(raw, v, { convCache: true }));
  const heads = new Set(on.map(b => b[0].text));
  check(`${id}: OFF is the single legacy block for all 8 variants`, offOk);
  check(`${id}: ON splits in two, ≤ 4 breakpoints, every block cache_control ephemeral`, on.every(b => b.length === 2 && b.every(x => x.cache_control?.type === 'ephemeral')));
  check(`${id}: ON joined text === OFF text (output-neutral), all 8 variants`, on.every((b, i) => joined(b) === variants[i]));
  check(`${id}: ON head is the same bytes at every arc position and note (stable prefix)`, heads.size === 1, `${heads.size} distinct heads`);
  check(`${id}: head ends before "## ARC POSITION RULE"; tail starts with it`, on.every(b => !b[0].text.includes('{{ARC_POSITION}}') && b[1].text.startsWith('## ARC POSITION RULE')));
  check(`${id}: both halves cacheable-sized (head ${on[0][0].text.length} / tail ${on[0][1].text.length} chars)`, on.every(b => b.every(x => x.text.length >= 4500)));
}
{
  const plain = 'x'.repeat(20000);
  check('fallback: a prompt with no {{ARC_POSITION}} stays one block even when ON', SINGLE(plain) === JSON.stringify(buildSystemBlocks(plain, plain, { convCache: true })));
  const short = 'a'.repeat(100) + '\n## ARC POSITION RULE\n{{ARC_POSITION}}' + 'b'.repeat(20000);
  check('fallback: a head too short to cache stays one block', JSON.stringify(buildSystemBlocks(short, short.replace('{{ARC_POSITION}}', 'late'), { convCache: true })).length === SINGLE(short.replace('{{ARC_POSITION}}', 'late')).length);
}

// ── Part 2 ───────────────────────────────────────────────────────────────────
console.log('\n── Part 2: request bodies on the wire — BASE (pre-change) vs OFF vs ON');
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
const OPENING = JSON.stringify({ narrative: 'The line hums under your hand.', choices: ['Read the test set', 'Send Wakely'], location: 'loc_battery_dugout', timeAdvance: 0 });
const TURN    = JSON.stringify({ narrative: 'The needle settles.', choices: ['Check the log', 'Wait'], location: 'loc_battery_dugout', timeAdvance: 9 });
let reply = OPENING, captured = [];
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  captured.push(opts.body);
  const body = JSON.parse(opts.body);
  if (!body.stream) return new Response(JSON.stringify({ content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: {} }), { status: 200 });
  const ev = [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }]
    .map(e => `data: ${JSON.stringify(e)}\n\n`);
  return new Response(new ReadableStream({ start(c) { const enc = new TextEncoder(); ev.forEach(e => c.enqueue(enc.encode(e))); c.close(); } }), { status: 200 });
};

const snapshot = dir => { try { return new Set(fs.readdirSync(p(dir))); } catch { return new Set(); } };
const before = { 'engine/data/sessions': snapshot('engine/data/sessions'), 'engine/data/transcripts': snapshot('engine/data/transcripts'), 'data/sessions': snapshot('data/sessions') };
const servers = [];
const BASE_REF = process.env.CONV_CACHE_BASE_REF || 'HEAD';
const baseFile = p('engine/server', `_conv_cache_base_${process.pid}.tmp.js`);

// The same three calls every run. The second /turn crosses the 25% mark (9-minute turns on a
// 30-minute session), so the arc position — and with it the system prompt's tail — changes.
let runNo = 0;
async function capture(makeRouter) {
  // A distinct session per run: gameRouter keeps pending anchor / act-boundary notes in a
  // module-level map keyed by session id, so a shared id would carry run A's note into run B.
  const sid = `conv-cache-test-session-${++runNo}`;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/game/api', makeRouter());
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}/game/api`;
  const sse = async (route, body) => {
    const t = await (await realFetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).text();
    return t.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))).find(e => e.type === 'done');
  };
  captured = [];
  reply = OPENING;
  const s = await sse('/start', { scenarioId: SCENARIO_ID, roleId: ROLE_ID, narrativeStyle: 'focused', sessionId: sid });
  reply = TURN;
  const t1 = await sse('/turn', { state: s.nextState, playerInput: 'Read the test set', sessionId: sid, history: [] });
  const history = [{ role: 'user', content: 'Read the test set' }, { role: 'assistant', content: 'The needle settles.' }];
  await sse('/turn', { state: t1.nextState, playerInput: 'Check the log', sessionId: sid, history });
  return captured.map(b => JSON.parse(b));
}

try {
  fs.writeFileSync(baseFile, execFileSync('git', ['show', `${BASE_REF}:engine/server/gameRouter.js`], { cwd: REPO_DIR, maxBuffer: 64 << 20 }));
  const { createGameRouter: createBaseRouter } = await import(pathToFileURL(baseFile).href);

  const BASE = await capture(() => createBaseRouter(repos, { anthropicApiKey: 'k' }));
  const OFF  = await capture(() => createGameRouter(repos, { anthropicApiKey: 'k', convCache: false }));
  const ON   = await capture(() => createGameRouter(repos, { anthropicApiKey: 'k', convCache: true }));
  const label = i => ['/start opening', '/turn 1', '/turn 2'][i] || `call ${i}`;

  check(`3 model calls captured each way (BASE ${BASE.length}, OFF ${OFF.length}, ON ${ON.length})`, BASE.length === 3 && OFF.length === 3 && ON.length === 3);
  // Normalise only what differs run to run whatever the code: the clock-derived fields.
  const stable = b => JSON.stringify(b).replace(/conv-cache-test-session-\d+/g, '<sid>').replace(/"(sessionStartTime|startedAt|createdAt|updatedAt|lastUpdated)":"[^"]*"/g, '"$1":"<t>"').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<iso>');
  BASE.forEach((b, i) => check(`OFF ${label(i)} body is byte-identical to BASE (pre-change code)`, stable(b) === stable(OFF[i]),
    `first difference at char ${[...stable(b)].findIndex((c, k) => c !== stable(OFF[i])[k])}`));
  ON.forEach((b, i) => {
    const off = OFF[i];
    check(`ON ${label(i)}: messages[] byte-identical to OFF`, stable(b.messages) === stable(off.messages));
    check(`ON ${label(i)}: every other request field identical to OFF`, stable({ ...b, system: null }) === stable({ ...off, system: null }));
    const sOn = joined(b.system), sOff = joined(off.system);
    const at = [...sOff].findIndex((c, k) => c !== sOn[k]);
    check(`ON ${label(i)}: system text joined === OFF system text (what the model reads is unchanged)`, sOn === sOff,
      `lengths OFF ${sOff.length} / ON ${sOn.length}; first difference at ${at}; ON-only tail: ${JSON.stringify(sOn.length > sOff.length && sOn.startsWith(sOff) ? sOn.slice(sOff.length) : '')}\n          OFF: ${JSON.stringify(sOff.slice(Math.max(0, at - 40), at + 160))}\n          ON:  ${JSON.stringify(sOn.slice(Math.max(0, at - 40), at + 160))}`);
    const all = [joined(b.system), ...b.messages.map(m => typeof m.content === 'string' ? m.content : m.content.map(c => c.text).join(''))].join('\u0000');
    const allOff = [joined(off.system), ...off.messages.map(m => typeof m.content === 'string' ? m.content : m.content.map(c => c.text).join(''))].join('\u0000');
    check(`ON ${label(i)}: ALL content sent (system + every message) concatenated is identical to OFF`, stable(all) === stable(allOff));
    const breakpoints = JSON.stringify(b).split('"cache_control"').length - 1;
    check(`ON ${label(i)}: ${breakpoints} cache breakpoints (≤ 4), system in ${b.system.length} blocks`, breakpoints <= 4 && b.system.length === 2);
  });
  check('ON: the cached head is the same bytes on all three calls (opening → turn → arc change)', new Set(ON.map(b => b.system[0].text)).size === 1);
  check('ON: the tail did change across the arc boundary (so the split is doing work)', new Set(ON.map(b => b.system[1].text)).size > 1);
} catch (err) {
  console.error(`\nERROR  ${err.stack || err.message}`);
  failed++;
} finally {
  try { fs.unlinkSync(baseFile); } catch {}
  await new Promise(r => setTimeout(r, 800));
  for (const [dir, had] of Object.entries(before)) for (const name of snapshot(dir)) if (!had.has(name)) { try { fs.unlinkSync(p(dir, name)); } catch {} }
  for (const s of servers) s.close();
  globalThis.fetch = realFetch;
}

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll conv-cache assertions passed.');
process.exit(failed ? 1 : 0);
