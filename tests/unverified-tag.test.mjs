// [UNVERIFIED] TAG + LOAD-BEARING SPECIFICS PROMPT BLOCK.
//
// The tag is the generator's note to a human reviewer. It must stay visible in the admin,
// block publication, and never reach a player. Runs the real routers against in-memory repos
// on localhost: no Supabase, no model calls, nothing written.

import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import {
  stripUnverifiedTag, stripUnverifiedDeep, findUnverifiedTags, findUnverifiedEntries, withUnverifiedStripped,
} from '../engine/services/UnverifiedTag.js';
import { prepareForTts } from '../engine/services/PromptComposer.js';

// Set unconditionally, before the routers load: the Supabase client is built at import time,
// and a dead local address guarantees this test cannot touch the real database.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_KEY = 'test-only';
process.env.SUPABASE_ANON_KEY = 'test-only';
const { createGameRouter } = await import('../engine/server/gameRouter.js');
const { createAdminRouter } = await import('../engine/admin/adminRouter.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const head = s => console.log(`\n── ${s}`);
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
  if (!ok) fails++;
};

head('stripping');
check('mid-sentence closes up', stripUnverifiedTag('Major [UNVERIFIED] of the 5th') === 'Major of the 5th');
check('appended form', stripUnverifiedTag('in May 1918 [UNVERIFIED].') === 'in May 1918.');
check('opening a line', stripUnverifiedTag('[UNVERIFIED] Major') === 'Major');
check('case and inner space', stripUnverifiedTag('a [ unverified ] b') === 'a b');
check('several in one string', stripUnverifiedTag('a [UNVERIFIED] b [UNVERIFIED] c') === 'a b c');
check('newlines survive', stripUnverifiedTag('a [UNVERIFIED]\nb') === 'a\nb');
check('reviewer token untouched', stripUnverifiedTag('---UNVERIFIED: x---') === '---UNVERIFIED: x---');

head('no tag: byte-identical');
for (const text of [
  'Plain sentence.', 'Double  space kept.', 'Trailing space ', ' leading space', 'tab\there', 'crlf\r\nline',
  'trailing newline\n', '', '[DRAFT] other bracket', "[Editor's note] kept", 'Em — dash, “curly”, naïve', 'Word unverified in prose',
]) {
  check(`unchanged: ${JSON.stringify(text)}`, stripUnverifiedTag(text) === text && stripUnverifiedDeep({ t: [text] }).t[0] === text);
}

head('tag removed cleanly: no doubled space, no stray punctuation');
for (const [input, want] of [
  ['A Major [UNVERIFIED] led.', 'A Major led.'],
  ['He was a Major [UNVERIFIED]', 'He was a Major'],
  ['He was a Major [UNVERIFIED].', 'He was a Major.'],
  ['A Major [UNVERIFIED], then', 'A Major, then'],
  ['(a Major [UNVERIFIED])', '(a Major)'],
  ['"a Major [UNVERIFIED]"', '"a Major"'],
  ['first [UNVERIFIED]; second [UNVERIFIED].', 'first; second.'],
  ['one\n[UNVERIFIED] two', 'one\ntwo'],
]) {
  const got = stripUnverifiedTag(input);
  check(`${JSON.stringify(input)} becomes ${JSON.stringify(want)}`, got === want, JSON.stringify(got));
  check('...no doubled space or space before punctuation', !/ {2}| [.,;:)"]/.test(got), JSON.stringify(got));
}
check('non-strings pass through', stripUnverifiedTag(null) === null && stripUnverifiedTag(5) === 5);
check('TTS never speaks it', !/unverified/i.test(prepareForTts('Major [UNVERIFIED] Smith')));
check('TTS tolerates empty', prepareForTts(null) === '');

head('tag with a note: removed whole');
for (const [input, want] of [
  ['He was a Major [UNVERIFIED: rank as of this date].', 'He was a Major.'],
  ['A Major [UNVERIFIED: rank], then', 'A Major, then'],
  ['(a Major [UNVERIFIED: rank])', '(a Major)'],
  ['A Major [UNVERIFIED: see Millett, p. 40; check "rank" (it\'s unclear)] led.', 'A Major led.'],
  ['[UNVERIFIED: rank] Major led.', 'Major led.'],
  ['one\n[UNVERIFIED: x] two', 'one\ntwo'],
  ['a [unverified: x] b [UNVERIFIED] c', 'a b c'],
  ['a [UNVERIFIED - x] b', 'a b'],
  ['a [UNVERIFIED — x] b', 'a b'],
]) {
  const got = stripUnverifiedTag(input);
  check(`${JSON.stringify(input)} becomes ${JSON.stringify(want)}`, got === want, JSON.stringify(got));
  check('...no doubled space or space before punctuation', !/ {2}| [.,;:)"]/.test(got), JSON.stringify(got));
}

// Verbatim from the live claude-sonnet-4-6 run of 2026-11-09: the output that showed the bare
// pattern was not enough. All six got past the strip, the validator and the publish gate.
const LIVE_TAGGED_ROLES = [
  ['Commanding officer, 1st Battalion, 5th Field Artillery, 1st Division', '[UNVERIFIED: precise battalion assignment within the 5th Field Artillery requires archival confirmation]'],
  ['Squad leader, rifle squad, assault company, 28th Infantry Regiment, 1st Division', '[UNVERIFIED: specific company and regiment assignment for a composite character]'],
  ['Forward wire-layer and telephone operator, signals section, 1st Division', '[UNVERIFIED: specific signals unit designation]'],
  ['Forward observation officer, 5th Field Artillery, attached to the assault battalion', '[UNVERIFIED: specific FOO assignment details]'],
  ['Battery telephone operator and fire-direction assistant, 1st Battalion, 5th Field Artillery', '[UNVERIFIED: specific battery designation]'],
  ['Automatic rifle gunner (Chauchat), rifle squad, assault company, 28th Infantry Regiment', '[UNVERIFIED: specific company designation]'],
];

head('live output regression: six noted tags');
LIVE_TAGGED_ROLES.forEach(([text, tag], i) => {
  check(`live tag ${i + 1} stripped whole`, stripUnverifiedTag(`${text} ${tag}`) === text, stripUnverifiedTag(`${text} ${tag}`));
});
const liveEntries = findUnverifiedEntries({ characters: LIVE_TAGGED_ROLES.map(([text, tag]) => ({ role: `${text} ${tag}` })) });
check('scan finds all six', liveEntries.length === 6, String(liveEntries.length));
check('scan keeps each tag whole, note included', LIVE_TAGGED_ROLES.every(([, tag], i) => liveEntries[i].tag === tag));

head('copy-on-write');
const clean = { a: ['x', { b: 'y' }], n: 1 };
check('clean input is the same reference', stripUnverifiedDeep(clean) === clean);
const dirty = { keep: { z: 1 }, list: ['ok', 'bad [UNVERIFIED]'] };
const stripped = stripUnverifiedDeep(dirty);
check('nested value stripped', stripped.list[1] === 'bad');
check('input not mutated', dirty.list[1] === 'bad [UNVERIFIED]');
check('untouched branch shared', stripped.keep === dirty.keep);
check('paths reported', findUnverifiedTags(dirty).join() === 'list[1]');

// ── in-memory content ────────────────────────────────────────────────────────
const ID = 'unverified_tag_test';
const scenario = {
  id: ID, title: 'Title [UNVERIFIED]', description: 'Desc [UNVERIFIED]', status: 'published', genre: [],
  storyArcIds: ['arc1'], sessionTargetMinutes: 30, introduction: { sections: [{ type: 'world', text: 'w' }] },
};
const roles = [{ id: 'r1', name: 'Role', description: 'd', briefing: 'x'.repeat(60) }];
const chars = [
  { id: 'c1', name: 'Smith', role: 'Major [UNVERIFIED]', scenarioIds: [ID], character_type: 'real' },
  ...LIVE_TAGGED_ROLES.map(([text, tag], i) => ({ id: `live${i}`, name: `Live ${i}`, role: `${text} ${tag}`, scenarioIds: [ID], character_type: 'fictional' })),
];
const clues = [{ id: 'k1', title: 'T', description: 'clue [UNVERIFIED]' }];
const arc = { id: 'arc1', premise: 'arc [UNVERIFIED]' };
const saves = [];
const repos = {
  scenarios: {
    findAll: async () => [scenario],
    findById: async () => ({ ...scenario, status: 'draft' }),
    findPlayerRoles: () => roles,
    save: async s => { saves.push(s); return 2; },
  },
  characters: { findAll: () => chars },
  locations: { findByScenario: () => [] },
  clues: { findByScenario: () => clues },
  storyArcs: { findById: () => arc },
  sessions: { marker: 'sessions-untouched' },
};

head('repository wrapper');
const wrapped = withUnverifiedStripped(repos);
check('sync finder stripped', wrapped.characters.findAll()[0].role === 'Major');
check('async finder stripped', (await wrapped.scenarios.findById()).title === 'Title');
check('underlying store untouched', chars[0].role === 'Major [UNVERIFIED]');
check('session repo not wrapped', wrapped.sessions === repos.sessions);

const app = express();
app.use(express.json());
app.use('/game/api', createGameRouter(repos, {}));
app.use('/admin/api', createAdminRouter(repos, {}));
const server = await new Promise(ok => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

try {
  head('player-facing route');
  const listing = await (await fetch(`${base}/game/api/scenarios`)).text();
  check('listing has the title', listing.includes('Title'));
  check('no tag in the response', !listing.toLowerCase().includes('[unverified'), listing);
  const boot = await (await fetch(`${base}/game/api/bootstrap?scenarioId=${ID}`)).text();
  check('bootstrap carries the live role text', boot.includes(LIVE_TAGGED_ROLES[0][0]));
  check('bootstrap has no tag or note', !boot.toLowerCase().includes('[unverified') && !boot.includes('requires archival confirmation'));

  head('admin stays honest');
  const health = await (await fetch(`${base}/admin/api/scenarios/${ID}/health`)).text();
  check('red error names a character field', health.includes('characters[0].role'), health.slice(0, 400));
  check('red error reaches clues', health.includes('clues[0].description'));
  check('red error reaches the story arc', health.includes('storyArc.premise'));
  check('red error shows the note to the author', health.includes('[UNVERIFIED: precise battalion assignment within the 5th Field Artillery requires archival confirmation]'));

  head('publish gate');
  const bundle = { scenario, characters: chars, clues, storyArc: undefined, locations: [], playerRoles: [] };
  const blocked = await fetch(`${base}/admin/api/generate/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bundle),
  });
  const body = await blocked.json();
  check('draft to published refused', blocked.status === 400 && body.code === 'UNVERIFIED_TAGS', JSON.stringify(body).slice(0, 300));
  check('refusal lists the field', (body.fields || []).includes('characters[0].role'));
  check('refusal lists every live tag', LIVE_TAGGED_ROLES.every((_, i) => (body.fields || []).includes(`characters[${i + 1}].role`)));
  check('refusal returns the whole tags', LIVE_TAGGED_ROLES.every(([, tag]) => (body.tags || []).some(e => e.tag === tag)));
  check('nothing saved', saves.length === 0);
} finally {
  await new Promise(ok => server.close(ok));
}

head('prompt text');
const router = fs.readFileSync(path.join(REPO, 'engine/admin/adminRouter.js'), 'utf8');
const between = (a, b) => router.slice(router.indexOf(a), router.indexOf(b, router.indexOf(a)));
const main = between('function buildGenerationPrompt(', 'export function createAdminRouter');
const facts = between("r.post('/generate/technical-facts'", 'const userPrompt');
const epilogue = between("r.post('/generate/epilogue-data'", 'const userPrompt');
check('license phrase gone', !router.includes('or established historical record'));
check('main generator has block + rule 4', main.includes('${LOAD_BEARING_SPECIFICS}') && main.includes('${LOAD_BEARING_UNVERIFIED_RULE}'));
check('technical facts has block, no rule 4', /^\s*LOAD_BEARING_SPECIFICS,/m.test(facts) && !facts.includes('LOAD_BEARING_UNVERIFIED_RULE'));
check('epilogue has block, no rule 4', /^\s*LOAD_BEARING_SPECIFICS,/m.test(epilogue) && !epilogue.includes('LOAD_BEARING_UNVERIFIED_RULE'));
check('fictional-character rule follows rule 4 in the main generator', main.indexOf('${LOAD_BEARING_UNVERIFIED_RULE}') < main.indexOf('${LOAD_BEARING_FICTIONAL_CHARACTERS}') && main.includes('${LOAD_BEARING_FICTIONAL_CHARACTERS}'));
check('...and only there', !facts.includes('LOAD_BEARING_FICTIONAL_CHARACTERS') && !epilogue.includes('LOAD_BEARING_FICTIONAL_CHARACTERS'));
check('fictional-character rule forbids authoring labels', router.includes('Do not write "(fictional)", "composite", or any similar authoring label into the role, name, or other character fields'));
const { REVIEWER_LOAD_BEARING_CHECK } = await import('../engine/services/ReviewerChecks.js');
const adminHtml = fs.readFileSync(path.join(REPO, 'engine/admin/index.html'), 'utf8');
check('reviewer check: admin page and server copies match', REVIEWER_LOAD_BEARING_CHECK.split('\n').every(line => adminHtml.includes(line)));
check('McCormick parenthetical as written', router.includes('promoted to lieutenant colonel only that June and colonel in September.'));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exitCode = fails ? 1 : 0;
