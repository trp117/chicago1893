// Round-trip for scripts/scenario-snapshot.mjs: snapshot → edit live → restore → edit gone.
//
// Runs the REAL CLI against the REAL admin router (in-process, no auth) over a SCRATCH scenario
// this test creates and destroys in both stores. No existing scenario is read or written.
// Not in run.mjs: it creates a scenarios row in Supabase for a few seconds (status draft).
//
//   node tests/snapshot-roundtrip.test.mjs
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT     = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_URL = pathToFileURL(ROOT).href;
const DATA_DIR = path.join(ROOT, 'engine/data');
const CLI      = path.join(ROOT, 'scripts/scenario-snapshot.mjs');

const express = (await import('express')).default;
const { DualWriteStore }      = await import(`${ROOT_URL}/lib/DualWriteStore.js`);
const { supabase }            = await import(`${ROOT_URL}/lib/supabase.js`);
const { ScenarioRepository }  = await import(`${ROOT_URL}/engine/repositories/ScenarioRepository.js`);
const { CharacterRepository } = await import(`${ROOT_URL}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }  = await import(`${ROOT_URL}/engine/repositories/LocationRepository.js`);
const { ClueRepository }      = await import(`${ROOT_URL}/engine/repositories/ClueRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT_URL}/engine/repositories/StoryArcRepository.js`);
const admin = await import(`${ROOT_URL}/engine/admin/adminRouter.js`);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};

const store = new DualWriteStore(DATA_DIR);
const repos = {
  scenarios: new ScenarioRepository(store), characters: new CharacterRepository(store),
  locations: new LocationRepository(store), clues:      new ClueRepository(store),
  storyArcs: new StoryArcRepository(store),
};
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/admin/api', admin.createAdminRouter(repos, { anthropicApiKey: 'test-key-not-used' }));
const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const call = async (method, url, body) => {
  const r = await fetch(`${BASE}/admin/api${url}`, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// Async spawn, never spawnSync: the CLI calls this process's own server, so blocking the
// event loop while it runs is a deadlock.
const cli = (...args) => new Promise(resolve => {
  const env = { ...process.env };
  // Blank, not deleted: the CLI loads dotenv, which would refill deleted keys from .env
  // and log in against this no-auth server (404).
  env.ADMIN_COOKIE = ''; env.ADMIN_EMAIL = ''; env.ADMIN_PASSWORD = '';
  const child = spawn(process.execPath, [CLI, ...args, '--base', BASE], { env });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', code => resolve({ code, out }));
});

const SID = 'zz_snapshot_roundtrip_scratch';
const ARC = 'arc_zz_snapshot_roundtrip', LOC = 'loc_zz_snapshot_roundtrip';
const ROLE = 'role_zz_snapshot_roundtrip', CHAR = 'char_zz_snapshot_roundtrip';
const bundle = () => ({
  scenario: { id: SID, title: 'Scratch — snapshot round-trip', status: 'draft', storyArcIds: [ARC] },
  storyArc: { id: ARC, scenarioId: SID, title: 'Scratch arc', acts: [{ actNumber: 1, title: 'One',
    beats: [{ id: 'beat_one', description: 'b' }],
    scenes: [{ id: 'scene_one', change: 'place', location_id: LOC, budget_minutes: 10 }] }] },
  characters:  [{ id: CHAR, name: 'Scratch Character', scenarioIds: [SID] }],
  locations:   [{ id: LOC, name: 'Scratch Location', scenarioId: SID }],
  clues:       [],
  playerRoles: [{ id: ROLE, name: 'Scratch Role', scenarioId: SID, description: 'ORIGINAL description',
                  briefing: 'Fixture briefing for the snapshot round-trip test.' }],
});
let snapFile = null;

try {
  const pre = await call('GET', `/scenarios/${SID}/full`);
  if (pre.status !== 404) throw new Error(`${SID} already exists — refusing to run over it.`);

  console.log('\n[1] create the scratch scenario\n');
  const created = await call('POST', '/generate/save', bundle());
  check('scratch saved', created.status === 200, JSON.stringify(created.body).slice(0, 200));

  console.log('\n[2] snapshot\n');
  const s = await cli('snapshot', SID);
  console.log(s.out.trim());
  snapFile = s.out.match(/^Wrote (.+\.json)$/m)?.[1];
  check('snapshot exits 0 and names a file', s.code === 0 && !!snapFile);
  check('file is under snapshots/ with <id>_<UTC>.json', !!snapFile && new RegExp(`snapshots[\\\\/]${SID}_\\d{8}T\\d{6}Z\\.json$`).test(snapFile));
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  check('snapshot holds the real bundle', snap.scenario?.id === SID && snap.playerRoles?.[0]?.id === ROLE
    && snap.storyArc?.acts?.[0]?.scenes?.length === 1);

  console.log('\n[3] trivial edits live: title, role description, an added scene\n');
  const live = (await call('GET', `/scenarios/${SID}/full`)).body;
  live.scenario.title = 'EDITED title';
  live.playerRoles[0].description = 'EDITED description';
  live.storyArc.acts[0].scenes.push({ id: 'scene_two', change: 'time', location_id: LOC, budget_minutes: 5 });
  const edited = await call('POST', '/generate/save', { ...live, baseVersion: live.current_version });
  check('edit saved', edited.status === 200, JSON.stringify(edited.body).slice(0, 200));

  console.log('\n[4] restore WITHOUT --yes refuses and writes nothing\n');
  const dry = await cli('restore', snapFile);
  console.log(dry.out.trim());
  check('dry run exits 2', dry.code === 2);
  check('dry run prints a one-line DIFF naming scenario, storyArc, playerRoles',
    /^DIFF: scenario\(title\) \| storyArc\(acts\) \| playerRoles\(1 changed: role_zz_snapshot_roundtrip\)$/m.test(dry.out));
  const still = (await call('GET', `/scenarios/${SID}/full`)).body;
  check('live still edited after dry run', still.scenario.title === 'EDITED title' && still.current_version === edited.body.current_version);

  console.log('\n[5] restore --yes\n');
  const wet = await cli('restore', snapFile, '--yes');
  console.log(wet.out.trim());
  check('restore exits 0 and reports VERIFIED', wet.code === 0 && /VERIFIED/.test(wet.out));
  const after = (await call('GET', `/scenarios/${SID}/full`)).body;
  check('title rolled back', after.scenario.title === 'Scratch — snapshot round-trip', after.scenario.title);
  check('role description rolled back', after.playerRoles[0]?.description === 'ORIGINAL description');
  check('added scene removed', after.storyArc.acts[0].scenes.map(x => x.id).join() === 'scene_one');
  check('version advanced (a real write, guarded)', after.current_version === edited.body.current_version + 1);

  console.log('\n[6] restore again is a no-op\n');
  const again = await cli('restore', snapFile, '--yes');
  console.log(again.out.trim());
  check('second restore finds nothing to do', again.code === 0 && /No differences/.test(again.out));
} catch (err) {
  console.error(err); fails++;
} finally {
  // Both stores, awaited — DualWriteStore.delete's Supabase half is fire-and-forget.
  store.delete('scenarios/player_roles', ROLE);
  store.delete('characters', CHAR);
  store.delete(`locations/${SID}`, LOC);
  store.delete('story_arcs', ARC);
  for (const [t, id] of [['player_role', ROLE], ['character', CHAR], ['location', LOC], ['story_arc', ARC]]) {
    await supabase.from('scenario_data').delete().eq('data_type', t).eq('id', id);
  }
  await supabase.from('scenario_versions').delete().eq('scenario_id', SID);
  await supabase.from('scenarios').delete().eq('id', SID);
  fs.rmSync(path.join(DATA_DIR, 'scenarios', `${SID}.json`), { force: true });
  fs.rmSync(path.join(DATA_DIR, 'scenarios/versions', SID), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'locations', SID), { recursive: true, force: true });
  if (snapFile) fs.rmSync(snapFile, { force: true });
  const { data: left } = await supabase.from('scenarios').select('id').eq('id', SID);
  const { data: leftData } = await supabase.from('scenario_data').select('id').in('id', [ROLE, CHAR, LOC, ARC]);
  check('cleanup: no scratch rows left in Supabase', !left?.length && !leftData?.length);
  server.close();
}
console.log(`\n${fails ? `FAILED (${fails})` : 'ALL PASS'}`);
process.exit(fails ? 1 : 0);
