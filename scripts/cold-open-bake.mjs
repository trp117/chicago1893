#!/usr/bin/env node
// Bake a DEMO_COLD_OPEN row: run the REAL /start once for a role, capture the opening and the
// engine state it produced, stamp the content fingerprint, and pair it with the display strings.
//
//   node scripts/cold-open-bake.mjs --scenario dog_green_sector --role role_battalion_medic \
//        [--display display.json] [--out row.json] [--status draft|ready] [--write]
//
// --display  JSON { intro: { name, place, date, wide, role, unit?, character }, lean: { narrative, instruction, choices[] } }
//            Without it the row carries the engine's own full opening and choices as a draft.
// --out      write the row as a one-element JSON array (the shape DEMO_COLD_OPEN_FILE reads).
//            Default: <scratch>/cold-open-<scenario>-<role>.json
// --status   draft (default) or ready. Only 'ready' rows are served.
// --write    upsert the row into public.demo_cold_opens. Without it: DRY RUN, nothing written.
//
// Cost: exactly ONE paid model call (the /start), more only if the opening comes back unusable
// and /start's own recovery retries. The local server is booted with DEMO_MODE off, so no demo
// limit applies, and it restores content from Supabase first — the bake is made from prod content.
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i === -1 ? null : (args[i + 1] ?? ''); };
const flag = name => args.includes(`--${name}`);
const scenarioId = opt('scenario'), roleId = opt('role');
const status = opt('status') || 'draft';
if (!scenarioId || !roleId || !['draft', 'ready'].includes(status)) {
  console.error('usage: node scripts/cold-open-bake.mjs --scenario <id> --role <id> [--display file.json] [--out file.json] [--status draft|ready] [--write]');
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_URL) { console.error('needs ANTHROPIC_API_KEY and Supabase credentials'); process.exit(2); }

const imp = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const { coldOpenContentProblem, lintColdOpen } = await imp('engine/server/coldOpen.js');
const { coldOpenFingerprintFor } = await imp('engine/server/gameRouter.js');

// --display is inline JSON (starts with "{") or a path to a JSON file. lean.narrative may be a
// string or an array of paragraphs (joined with a blank line). A paragraph given as
// { text, italic: true } is stored wrapped in *asterisks* — the engine's emphasis mark, which the
// cold-open page renders italic (the call line).
function readDisplay(v) {
  if (!v) return null;
  const d = JSON.parse(v.trim().startsWith('{') ? v : fs.readFileSync(v, 'utf8'));
  const n = d?.lean?.narrative;
  if (Array.isArray(n)) {
    d.lean.narrative = n.map(p => typeof p === 'string' ? p.trim() : (p.italic ? `*${String(p.text).trim()}*` : String(p.text).trim())).join('\n\n');
  }
  return d;
}
const display = readDisplay(opt('display'));

// ── --from-row: write a row already baked (a dry run's --out file) ──────────
// No /start, no model call: the row written is exactly the row that was reviewed. Validated and
// linted again, status taken from --status (default draft). Needs --write to touch Supabase.
async function upsertRow(row) {
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  // updated_at stamped on every write (the column default only covers the first insert).
  const { error: e } = await sb.from('demo_cold_opens').upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'scenario_id,role_id' });
  if (e) throw new Error(`upsert failed: ${e.message}`);
  const { data, error: e2 } = await sb.from('demo_cold_opens').select('scenario_id, role_id, status, updated_at').eq('scenario_id', row.scenario_id).eq('role_id', row.role_id).single();
  if (e2) throw new Error(`read-back failed: ${e2.message}`);
  console.log(`UPSERTED into demo_cold_opens — read back: ${JSON.stringify(data)}`);
}
if (opt('from-row')) {
  const rows = JSON.parse(fs.readFileSync(opt('from-row'), 'utf8'));
  const row = (Array.isArray(rows) ? rows : [rows]).find(r => r.scenario_id === scenarioId && r.role_id === roleId);
  if (!row) { console.error(`no ${scenarioId}/${roleId} row in ${opt('from-row')}`); process.exit(2); }
  row.status = status;
  const problem = coldOpenContentProblem(row.content, { scenarioId, roleId });
  if (problem) { console.error(`row would not be served: ${problem}`); process.exit(1); }
  console.log(`from-row: ${scenarioId}/${roleId} baked ${row.content.baked.baked_at}, fingerprint ${row.content.baked.fingerprint.slice(0, 23)}…, status ${status} — no model call`);
  if (flag('write')) await upsertRow(row);
  else console.log('DRY RUN — nothing written to Supabase. Re-run with --write to upsert.');
  process.exit(0);
}

// ── Boot a local server (prod mode, content restored from Supabase) ─────────
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const port = await freePort();
const env = { ...process.env, PORT: String(port), ELEVENLABS_API_KEY: '', LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '' };
for (const k of ['DEMO_MODE', 'DEMO_SCENARIOS', 'DEMO_COLD_OPEN', 'DEMO_FEATURED_SCENARIO', 'DEMO_FEATURED_ROLE']) delete env[k];
const child = spawn(process.execPath, ['engine/server/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
const stop = () => child.kill();
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not boot in 120s:\n${log.slice(-2000)}`)), 120000);
    const onData = d => { log += d; if (log.includes('Engine running at')) { clearTimeout(t); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => { clearTimeout(t); reject(new Error(`server exited (${code}):\n${log.slice(-2000)}`)); });
  });
  const base = `http://localhost:${port}`;

  // The role's own briefing as character context, no random hook: a bake must be repeatable.
  const boot = await (await fetch(`${base}/game/api/bootstrap?scenarioId=${encodeURIComponent(scenarioId)}`)).json();
  const role = boot?.scenario?.playerRoleOptions?.find(r => r.id === roleId);
  if (!role) throw new Error(`role "${roleId}" not found in "${scenarioId}"`);
  const characterContext = (typeof role.briefing === 'string' && role.briefing.trim()) ? role.briefing.trim() : (role.description || '');

  console.log(`baking ${scenarioId}/${roleId} through the real /start …`);
  const resp = await fetch(`${base}/game/api/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId, roleId, narrativeStyle: 'focused', character_context: characterContext, player_addition: null, active_hook: null, onboardingFlow: 'streamlined' }),
  });
  if (!resp.ok) throw new Error(`/start HTTP ${resp.status}: ${await resp.text()}`);
  let buf = '', done = null, error = null;
  const dec = new TextDecoder();
  for await (const chunk of resp.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let evt; try { evt = JSON.parse(line.slice(6)); } catch { continue; }
      if (evt.type === 'done') done = evt;
      if (evt.type === 'error') error = evt;
    }
  }
  if (!done) throw new Error(`/start delivered no opening: ${JSON.stringify(error)}`);
  // The bake's /start saved a session and a transcript stub; neither is a real playthrough.
  setTimeout(() => {
    for (const f of [path.join(ROOT, 'data/sessions', `${done.sessionId}.json`), path.join(ROOT, 'engine/data/transcripts', `${done.sessionId}.md`)]) fs.rmSync(f, { force: true });
  }, 500);
  const usage = log.split('\n').filter(l => l.includes('[USAGE]'));
  console.log(`model calls: ${usage.length}\n  ${usage.join('\n  ')}`);

  // Fingerprint from the disk the server just restored — the same content it baked from.
  const { JsonFileStore } = await imp('engine/repositories/JsonFileStore.js');
  const store = new JsonFileStore(path.join(ROOT, 'engine/data'));
  const R = async (f, c) => new (await imp(`engine/repositories/${f}.js`))[c](store);
  const repos = {
    characters: await R('CharacterRepository', 'CharacterRepository'), locations: await R('LocationRepository', 'LocationRepository'),
    clues: await R('ClueRepository', 'ClueRepository'), scenarios: await R('ScenarioRepository', 'ScenarioRepository'),
    storyArcs: await R('StoryArcRepository', 'StoryArcRepository'),
  };
  const fingerprint = await coldOpenFingerprintFor(repos, scenarioId, roleId, done.nextState);

  const out = done.output;
  const content = {
    intro: display?.intro ?? { name: boot?.scenario?.title || scenarioId, place: 'PLACE', date: 'DATE', wide: 'WIDE LINE', role: role.name, character: 'CHARACTER LINE' },
    lean: display?.lean ?? { narrative: out.narrative, instruction: 'Your move — choose one, or write your own:', choices: out.choices },
    baked: {
      state: done.nextState,
      output: { narrative: out.narrative, sensory_opening: out.sensory_opening ?? null, choices: out.choices, location: out.location ?? null, scene: out.scene ?? null, npcMoments: out.npcMoments ?? [] },
      fingerprint,
      baked_at: new Date().toISOString(),
      source: '/start',
    },
  };
  const row = { scenario_id: scenarioId, role_id: roleId, status: display ? status : 'draft', content };

  const problem = coldOpenContentProblem(content, { scenarioId, roleId });
  if (problem) throw new Error(`row would not be served: ${problem}`);
  const allChars = repos.characters.findAll().filter(c => (c.scenarioIds || []).includes(scenarioId));
  const lint = lintColdOpen(content, { characters: allChars, clues: repos.clues.findByScenario(scenarioId) });
  console.log(`\nfull opening (${out.narrative.split(/\s+/).length} words):\n${out.narrative}\n\nengine choices:\n${out.choices.map(c => '  - ' + c).join('\n')}`);
  console.log(`\nbaked state: location=${done.nextState.location} turnCount=${done.nextState.turnCount} elapsed=${done.nextState.elapsedMinutes} remaining=${done.nextState.remainingMinutes}`);
  console.log(`  presentNpcs=${JSON.stringify(done.nextState.presentNpcs ?? [])} introducedNpcs=${JSON.stringify(done.nextState.introducedNpcs ?? [])}`);
  console.log(`  reachedBeats=${JSON.stringify(done.nextState.reachedBeats ?? [])} clues=${JSON.stringify(done.nextState.discoveredClueIds ?? [])} scene=${done.nextState.currentSceneId ?? '-'}`);
  console.log(`  fingerprint ${fingerprint}`);
  console.log(lint.length ? `\nlint (${lint.length}):\n${lint.map(l => '  ! ' + l).join('\n')}` : '\nlint: clean');
  if (!display) console.log('\nNo --display given: lean text = the engine\'s full opening, intro lines are placeholders, status forced to draft.');

  const outFile = opt('out') || path.join(os.tmpdir(), `cold-open-${scenarioId}-${roleId}.json`);
  fs.writeFileSync(outFile, JSON.stringify([row], null, 2) + '\n');
  console.log(`\nrow written to ${outFile} (status ${row.status})`);

  if (flag('write')) {
    await upsertRow(row);
  } else {
    console.log('DRY RUN — nothing written to Supabase. Re-run with --write to upsert.');
  }
} catch (e) {
  console.error(`\nBAKE FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  stop();
}
