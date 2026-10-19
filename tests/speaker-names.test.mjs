// SPEAKER NAMES — no code turns a character or role id into a display name.
//
//   LEAK      ignatius: once the household servant (id pedro_de_loyola, approved label
//             "Household servant") has spoken, nothing the model is sent — system prompt, turn
//             prompt, replayed history, retry — and no speaker label the server hands the client
//             carries his prettified id ("Pedro De Loyola", "Pedro"). It shows the label.
//   MISS      an id with no roster entry resolves to UNKNOWN_SPEAKER everywhere — the speaker
//             label, the client's history line, the silent-NPC retry, /notes, and the primary
//             scenario's system prompt — never the raw id or a prettified one
//   ROLE      the player's role id is not printed in either system/turn prompt builder
//
// The bug (16 Oct playtest): the client labelled each history line with prettifyId(m.npc), so
// "Pedro De Loyola: …" sat in the model's own earlier turns and the anonymized servant got his
// name back about one run in four.
//
// The route half drives the REAL createGameRouter /turn over a real socket with a FROZEN
// Ignatius fixture (fake repos — no data directory, no Supabase) and a scripted
// api.anthropic.com. No sessionId is sent, so the route writes no session or transcript file.
// The one disk write is a scratch primary-scenario session for promptBuilder, removed in finally.

import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;
const p        = (...s) => path.join(REPO_DIR, ...s);

const { UNKNOWN_SPEAKER, characterLabel, attachSpeakerNames, relabelHistory, knownAsLines } =
  await import(`${ROOT}/engine/services/SpeakerNames.js`);
const { composeTurnPrompt, buildSystemPrompt } = await import(`${ROOT}/engine/services/PromptComposer.js`);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const PEDRO = /Pedro/;   // case-sensitive: the raw id pedro_de_loyola is a structured key (alias pass), a name is not

// ── Frozen Ignatius fixture (shape of prod, 17 Oct) ─────────────────────────
const SC = {
  id: 'ignatius_loyola_1521', title: 'Loyola, 1521', sessionTargetMinutes: 30, systems: {},
  description: 'A wounded soldier convalesces at Loyola.', genre: ['historical'],
};
const SERVANT = { id: 'pedro_de_loyola', name: 'Household servant', role: 'Younger household servant at Loyola', scenarioIds: [SC.id] };
const CHARS = [
  { id: 'inigo_de_loyola',   name: 'Íñigo López de Loyola', character_type: 'real', scenarioIds: [SC.id] },
  { id: 'martin_garcia',     name: 'Martín García de Oñaz', character_type: 'real', scenarioIds: [SC.id] },
  SERVANT,
];
const LOCS = [{ id: 'the_sickroom', name: 'The sickroom', description: 'A narrow room.', linkedCharacterIds: ['pedro_de_loyola'] }];
const ROLE = { id: 'role_inigo', name: 'Íñigo', character_id: 'inigo_de_loyola', scenarioId: SC.id };

const STATE = {
  scenarioId: SC.id, playerRoleId: 'role_inigo', playerCharacterId: 'inigo_de_loyola', playerRoleName: 'Íñigo',
  location: 'the_sickroom', visitedLocations: ['the_sickroom'], elapsedMinutes: 6, remainingMinutes: 24, act: 1,
  threat: 1, authorityTrust: 1, discoveredClueIds: [], suspicion: {}, flags: {}, inventory: [],
  introducedNpcs: ['pedro_de_loyola'], targetNpc: 'pedro_de_loyola', resolved_threads: [],
  namedConspirators: [], escapedNpcs: [], physicalConflicts: [], chaseState: null, turnCount: 2,
};

// ── 1. Resolution helpers ───────────────────────────────────────────────────
head('1. resolution helpers');
check('roster id → approved label', characterLabel('pedro_de_loyola', CHARS) === 'Household servant');
check('roster miss → UNKNOWN_SPEAKER', characterLabel('ghost_of_azpeitia', CHARS) === UNKNOWN_SPEAKER);
check('missing / blank id → UNKNOWN_SPEAKER', characterLabel(undefined, CHARS) === UNKNOWN_SPEAKER && characterLabel('', CHARS) === UNKNOWN_SPEAKER);
check('nameless roster entry → UNKNOWN_SPEAKER, not the id', characterLabel('x_y', [{ id: 'x_y', name: '  ' }]) === UNKNOWN_SPEAKER);
const stamped = attachSpeakerNames({ npcMoments: [{ npc: 'pedro_de_loyola', text: 'Water, señor.' }, { npc: 'ghost_of_azpeitia', text: 'Hm.' }] }, CHARS);
check('attachSpeakerNames: roster label, id kept as key',
  stamped.npcMoments[0].speaker === 'Household servant' && stamped.npcMoments[0].npc === 'pedro_de_loyola');
check('attachSpeakerNames: miss → UNKNOWN_SPEAKER', stamped.npcMoments[1].speaker === UNKNOWN_SPEAKER);
const ka = knownAsLines({ to_player: 'Íñigo', to_martin_garcia: 'little brother', to_ghost_of_azpeitia: 'sir', pedro_de_loyola: 'señor' }, CHARS);
check('knownAsLines: to_player → "the player", others from the roster, misses dropped',
  JSON.stringify(ka) === JSON.stringify(['- the player: Íñigo', '- Martín García de Oñaz: little brother', '- Household servant: señor']), JSON.stringify(ka));

// ── 2. Client history line (the real page's builder) ────────────────────────
head('2. client history line (engine/game/index.html)');
const html = fs.readFileSync(p('engine/game/index.html'), 'utf8');
const constSrc = html.match(/const UNKNOWN_SPEAKER = [^;]+;/)?.[0];
const fnSrc    = html.match(/function buildAssistantHistoryContent\(output\) \{[\s\S]*?\n\}/)?.[0];
check('page defines UNKNOWN_SPEAKER and buildAssistantHistoryContent', !!constSrc && !!fnSrc);
const buildHistory = new Function(`${constSrc}\n${fnSrc}\nreturn buildAssistantHistoryContent;`)();
check('page constant matches the server constant', new Function(`${constSrc}\nreturn UNKNOWN_SPEAKER;`)() === UNKNOWN_SPEAKER);
check('page never prettifies an id for a history label', !/prettifyId\(m\.npc\)/.test(html));
const line = buildHistory({ narrative: 'The door opens.', npcMoments: stamped.npcMoments.slice(0, 1) });
check('history line uses the server-resolved label', line.includes('\nHousehold servant: Water, señor.') && !PEDRO.test(line), JSON.stringify(line));
const legacy = buildHistory({ narrative: 'x', npcMoments: [{ npc: 'pedro_de_loyola', text: 'Water.' }] });
check('a moment with no resolved name → UNKNOWN_SPEAKER, not the id', legacy.endsWith(`\n${UNKNOWN_SPEAKER}: Water.`) && !/pedro/i.test(legacy), JSON.stringify(legacy));

// ── 3. Relabelling history an older client already built ────────────────────
head('3. legacy history relabelled');
const oldHistory = [
  { role: 'user', content: 'I ask who is there.' },
  { role: 'assistant', content: 'A shape at the door.\nPedro De Loyola: Water, señor.\nMartin Garcia: Drink it.' },
];
const relabelled = relabelHistory(oldHistory, CHARS);
check('prettified-id label → roster label', relabelled[1].content === 'A shape at the door.\nHousehold servant: Water, señor.\nMartín García de Oñaz: Drink it.', JSON.stringify(relabelled[1].content));
check('user turns untouched', relabelled[0] === oldHistory[0]);
check('a history with no legacy labels passes through as the same objects',
  relabelHistory([{ role: 'assistant', content: 'Household servant: hi' }], CHARS)[0].content === 'Household servant: hi');

// ── 4. Prompt builders: no role id, no prettified id ────────────────────────
head('4. prompt builders');
const turnPrompt = composeTurnPrompt(STATE, 'I look at the servant.', { scenario: SC, characters: CHARS, locations: LOCS, clues: [], playerRoles: [ROLE] });
check('turn prompt: role line has no role id', /Role: Íñigo \| Access:/.test(turnPrompt) && !turnPrompt.includes('(id: role_inigo)'));
check('turn prompt: no "Pedro" after the servant spoke', !PEDRO.test(turnPrompt));
const aliasState = { ...STATE, playerRealName: 'Íñigo López', playerCoverName: 'Íñigo', playerAliases: [{ name: 'Íñigo' }],
  playerKnownAs: { to_player: 'Íñigo of Loyola', to_pedro_de_loyola: 'señor', to_ghost_of_azpeitia: 'sir' } };
const aliasPrompt = composeTurnPrompt(aliasState, 'I wait.', { scenario: SC, characters: CHARS, locations: LOCS, clues: [], playerRoles: [ROLE] });
check('turn prompt: known_as labelled from the roster', aliasPrompt.includes('- Household servant: señor'));
check('turn prompt: to_player kept as "the player"', aliasPrompt.includes('- the player: Íñigo of Loyola'));
check('turn prompt: to_<id> not in the roster dropped', !aliasPrompt.includes(': sir\n') && !aliasPrompt.endsWith(': sir'));
check('turn prompt: known_as never prints a key', !/to pedro|pedro de loyola|ghost of azpeitia/i.test(aliasPrompt));

// Primary scenario (promptBuilder.js) — a scratch session on disk, removed in finally.
const { buildSystemPrompt: buildPrimarySystemPrompt } = await import(`${ROOT}/engine/promptBuilder.js`);
const SID = `speaker-names-test-${process.pid}`;
const sessFile = p('data/sessions', `${SID}.json`);
try {
  fs.writeFileSync(sessFile, JSON.stringify({
    playerRoleId: 'role_secret_agent', playerRoleName: 'The Agent',
    playerRealName: 'Ada Brand', playerCoverName: 'Ann Bell',
    playerKnownAs: { to_daniel_burnham: 'Ann Bell', to_ghost_of_azpeitia: 'Ada', to_player: 'Ann' },
    suspicion: { daniel_burnham: 1, ghost_of_azpeitia: 2 }, introducedNpcs: ['daniel_burnham', 'ghost_of_azpeitia'],
    npc_states: { ghost_of_azpeitia: { trust_level: 5, aggression_mode: 'neutral' } },
  }));
  const primary = buildPrimarySystemPrompt(SID);
  check('primary: role line has no role id', primary.includes('Role: The Agent\n') && !primary.includes('role_secret_agent'));
  check('primary: known_as labelled from the roster, misses dropped',
    primary.includes('- Daniel Burnham: Ann Bell') && !/^- (to |ghost|player)/mi.test(primary) && !/: Ada$/m.test(primary));
  check('primary: to_player kept as "the player"', /^- the player: Ann$/m.test(primary));
  check('primary: suspicion miss → UNKNOWN_SPEAKER', primary.includes(`- ${UNKNOWN_SPEAKER}: 2`) && primary.includes('- Daniel Burnham: 1'));
  check('primary: introduced miss → UNKNOWN_SPEAKER', primary.includes(`\n- ${UNKNOWN_SPEAKER}\n`));
  check('primary: npc_states miss → UNKNOWN_SPEAKER', primary.includes(`${UNKNOWN_SPEAKER} — current session state:`));
  check('primary: the unknown id never printed', !primary.includes('ghost_of_azpeitia') && !/ghost of azpeitia/i.test(primary));
} finally {
  fs.rmSync(sessFile, { force: true });
}

// ── 5. The real /turn route ─────────────────────────────────────────────────
head('5. /turn route (frozen Ignatius fixture, scripted model)');
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
let script = [], calls = [];
function sseStream(text) {
  const ev = [`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
              `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`];
  return new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); ev.forEach(x => c.enqueue(e.encode(x))); c.close(); } }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u?.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  calls.push(body);
  const text = script.shift();
  if (text == null) throw new Error('speaker-names.test: unscripted model call');
  return body.stream ? sseStream(text)
    : new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }), { headers: { 'Content-Type': 'application/json' } });
};

const repos = {
  scenarios:  { findById: async id => (id === SC.id ? SC : null), findPlayerRoles: () => [ROLE], findPlayerRole: id => (id === ROLE.id ? ROLE : null) },
  characters: { findAll: () => CHARS },
  locations:  { findByScenario: () => LOCS },
  clues:      { findByScenario: () => [] },
  storyArcs:  { findById: () => null },
};
const { createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/game/api', createGameRouter(repos, { anthropicApiKey: 'speaker-names-test-key' }));
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function turn(history, ...modelReplies) {
  script = [...modelReplies]; calls = [];
  const log = console.log, warn = console.warn, err = console.error;
  console.log = console.warn = console.error = () => {};
  try {
    const r = await realFetch(`${BASE}/game/api/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: STATE, playerInput: 'I ask the servant for water.', history }) });
    const raw = await r.text();
    const done = raw.split('\n\n').map(b => b.replace(/^data: /, '')).filter(Boolean)
      .map(b => { try { return JSON.parse(b); } catch { return null; } }).find(e => e?.type === 'done');
    return { done, calls: [...calls] };
  } finally { console.log = log; console.warn = warn; console.error = err; }
}
const reply = (npc, narrative) => JSON.stringify({
  narrative, location: 'the_sickroom', choices: ['Drink', 'Refuse', 'Ask about Martín'],
  npcMoments: [{ npc, text: 'Water, señor.' }],
});

try {
  // The servant has spoken before: one line from the fixed client, one from an older client.
  const history = [
    { role: 'user', content: 'I call out.' },
    { role: 'assistant', content: 'Footsteps on the stair.\nHousehold servant: You called, señor?' },
    { role: 'user', content: 'I ask for light.' },
    { role: 'assistant', content: 'He brings a candle.\nPedro De Loyola: The candle, señor.' },
  ];
  const a = await turn(history, reply('pedro_de_loyola', 'He sets the cup down. "Water, señor," he says.'));
  const sent = a.calls[0];
  check('one model call (no retry)', a.calls.length === 1, `calls=${a.calls.length}`);
  const sentText = JSON.stringify(sent?.system) + '\n' + (sent?.messages || []).map(m => m.content).join('\n');
  check('nothing sent to the model says "Pedro" (system, turn prompt, replayed history)', !!sent && !PEDRO.test(sentText),
    (sentText.match(/.{0,40}Pedro.{0,40}/) || [''])[0]);
  check('replayed history carries the approved label for both lines',
    sent.messages[1].content.includes('\nHousehold servant: You called') && sent.messages[3].content.includes('\nHousehold servant: The candle'));
  // Role line only: playerRoleId inside STATE_JSON is a structured id field (the alias pass).
  check('turn prompt role line carries no role id', /^Role: Íñigo \| Access: /m.test(sent.messages.at(-1).content) && !/^Role: .*role_inigo/m.test(sent.messages.at(-1).content));
  const m0 = a.done?.output?.npcMoments?.[0];
  check('server-formatted speaker label is the approved label', m0?.speaker === 'Household servant' && !PEDRO.test(m0.speaker), JSON.stringify(m0));
  check('internal id kept for keying', m0?.npc === 'pedro_de_loyola');

  // Roster miss, and a silent NPC so the retry fires.
  const b = await turn([], reply('ghost_of_azpeitia', 'Someone stands at the door.'), reply('ghost_of_azpeitia', 'A voice: "Water."'));
  const retryAsk = b.calls[1]?.messages?.at(-1)?.content || '';
  check('silent-NPC retry fired', b.calls.length === 2, `calls=${b.calls.length}`);
  check('silent-NPC retry names UNKNOWN_SPEAKER, not the id', retryAsk.includes(`dialogue from ${UNKNOWN_SPEAKER}.`) && !/ghost/i.test(retryAsk), retryAsk.slice(0, 120));
  const mb = b.done?.output?.npcMoments?.[0];
  check('roster-miss speaker label → UNKNOWN_SPEAKER', mb?.speaker === UNKNOWN_SPEAKER, JSON.stringify(mb));

  // /notes: a suspicion on an unknown id.
  const n = await (await realFetch(`${BASE}/game/api/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: { ...STATE, suspicion: { ghost_of_azpeitia: 2, pedro_de_loyola: 1 } } }) })).json();
  const names = (n.notes?.suspicions || []).map(s => s.name);
  check('/notes: suspicion names from the roster, miss → UNKNOWN_SPEAKER',
    JSON.stringify(names) === JSON.stringify([UNKNOWN_SPEAKER, 'Household servant']), JSON.stringify(names));
} finally {
  globalThis.fetch = realFetch;
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll speaker-name assertions passed.');
process.exitCode = fails ? 1 : 0;
