#!/usr/bin/env node
// Flag-off byte-identity proof for DEMO_COLD_OPEN.
//
//   node scripts/cold-open-baseline.mjs capture   # run ON THE BASELINE COMMIT (master 00b222b)
//   node scripts/cold-open-baseline.mjs compare   # run on the cold-open branch
//
// capture boots the server in each deployment shape (prod, Grey Witness demo, Project Limen
// demo) and records, per route: status, content-type, location, cache-control and a sha256 of
// the body. The manifest (tests/fixtures/cold-open-baseline/manifest.json) holds hashes only —
// several routes return scenario content, which is gitignored and must not enter the repo.
// The bodies themselves are written to a scratch dir so a mismatch can be diffed.
//
// compare boots the same shapes on the current tree — with DEMO_COLD_OPEN unset, and again with
// the cold-open env present but the flag off/inert — and requires every route to match the
// manifest exactly. /health is compared with `uptime` removed (it is a clock).
//
// Both runs restore content from Supabase on boot, so they compare like with like only when no
// prod content was edited in between; run them back to back.
//
// No model, ElevenLabs or Langfuse calls: every request is a read or fails validation.
// A bot user agent keeps these boots out of the live page-view tally.
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'tests/fixtures/cold-open-baseline/manifest.json');
const BODY_DIR = path.join(os.tmpdir(), 'cold-open-baseline');
const ENV_FILE = path.join(ROOT, '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

// Every cold-open env var, so a shape can say "none of these" explicitly.
const COLD_OPEN_VARS = ['DEMO_COLD_OPEN', 'DEMO_FEATURED_SCENARIO', 'DEMO_FEATURED_ROLE'];
const unsetAll = Object.fromEntries(COLD_OPEN_VARS.map(k => [k, undefined]));

const LIMEN = {
  DEMO_MODE: 'true', DEMO_SCENARIOS: 'steel_curtain_cantigny,dog_green_sector',
  DEMO_SITE_NAME: 'Project Limen', DEMO_SITE_URL: 'https://projectlimen.com',
  DEMO_SITE_TAGLINE: 'Cross the threshold of a turning point in history.',
  DEMO_OG_IMAGE_FILE: 'projectlimen-og.png', DEMO_BUDGET_ID: 'limen',
};
export const SHAPES = {
  prod:  { DEMO_MODE: undefined, DEMO_SCENARIOS: undefined },
  gw:    { DEMO_MODE: 'true', DEMO_SCENARIOS: 'tolle_lege_milan_386,ignatius_loyola_1521' },
  limen: LIMEN,
};
// compare only: the same shapes with cold-open env present that must still be inert.
const INERT_VARIANTS = {
  prod:  [{ DEMO_COLD_OPEN: 'true', DEMO_FEATURED_SCENARIO: 'dog_green_sector', DEMO_FEATURED_ROLE: 'battalion_medic' }],
  gw:    [{ DEMO_COLD_OPEN: 'false' }],
  limen: [{ DEMO_FEATURED_SCENARIO: 'dog_green_sector', DEMO_FEATURED_ROLE: 'battalion_medic' },
          { DEMO_COLD_OPEN: 'false', DEMO_FEATURED_SCENARIO: 'dog_green_sector', DEMO_FEATURED_ROLE: 'battalion_medic' }],
};

export const ROUTES = [
  ['GET', '/'], ['GET', '/?scenarioId=dog_green_sector'], ['GET', '/index.html'],
  ['GET', '/game'], ['GET', '/game?scenarioId=dog_green_sector'],
  ['GET', '/moments'], ['GET', '/og-image.png'], ['GET', '/test'], ['GET', '/categories'],
  ['GET', '/admin/login'], ['GET', '/js/scenario-card.js'],
  ['GET', '/api/stories'], ['GET', '/api/categories'],
  ['GET', '/game/api/config'], ['GET', '/game/api/scenarios'],
  ['GET', '/game/api/bootstrap?scenarioId=dog_green_sector'],
  ['GET', '/game/api/bootstrap?scenarioId=tolle_lege_milan_386'],
  ['GET', '/game/api/cold-open?scenarioId=dog_green_sector&roleId=battalion_medic'],
  ['GET', '/game/api/cold-open/turn'],
  ['POST', '/game/api/cold-open/turn', {}],
  ['POST', '/game/api/start', {}],
  ['POST', '/game/api/turn', {}],
  ['POST', '/game/api/turn', { coldOpen: { scenarioId: 'dog_green_sector', roleId: 'battalion_medic' } }],
  ['GET', '/health'],
];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

export async function boot(label, extraEnv, cwd = ROOT) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), ELEVENLABS_API_KEY: '', LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '', ...extraEnv };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const child = spawn(process.execPath, ['engine/server/server.js'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} did not boot in 120s:\n${log.slice(-2000)}`)), 120000);
    const onData = d => { log += d; if (log.includes('Engine running at')) { clearTimeout(t); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => { clearTimeout(t); reject(new Error(`${label} exited (${code}) before booting:\n${log.slice(-2000)}`)); });
  });
  return { base: `http://localhost:${port}`, stop: () => child.kill(), log: () => log };
}

async function record(base, [method, url, body]) {
  // Retried: a live host waking up can miss fetch's 10s connect timeout.
  let resp;
  for (let attempt = 1; ; attempt++) {
    try {
      resp = await fetch(base + url, {
        method, redirect: 'manual',
        headers: { 'User-Agent': 'cold-open-baseline-bot', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (e) { if (attempt >= 4) throw e; await new Promise(r => setTimeout(r, 2000 * attempt)); }
  }
  let buf = Buffer.from(await resp.arrayBuffer());
  let commit = null;
  if (url === '/health') {
    const j = JSON.parse(buf.toString());
    delete j.uptime;
    // Railway stamps the deployed SHA; a local boot says 'unknown'. Reported, never compared.
    commit = j.commit ?? null;
    j.commit = 'unknown';
    buf = Buffer.from(JSON.stringify(j));
  }
  if (commit && commit !== 'unknown') record.lastCommit = commit;
  return {
    entry: {
      status: resp.status,
      type: resp.headers.get('content-type'),
      location: resp.headers.get('location'),
      cacheControl: resp.headers.get('cache-control'),
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
    },
    buf,
  };
}
const key = ([m, u, b]) => `${m} ${u}${b ? ' ' + JSON.stringify(b) : ''}`;
const safe = s => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);

async function snapshot(shape, env, tag) {
  const srv = await boot(`${shape}${tag}`, { ...unsetAll, ...SHAPES[shape], ...env });
  const out = {};
  try {
    fs.mkdirSync(path.join(BODY_DIR, tag || 'baseline', shape), { recursive: true });
    for (const r of ROUTES) {
      const { entry, buf } = await record(srv.base, r);
      out[key(r)] = entry;
      fs.writeFileSync(path.join(BODY_DIR, tag || 'baseline', shape, safe(key(r))), buf);
    }
  } finally { srv.stop(); }
  return out;
}

const mode = process.argv[2];
if (!process.env.SUPABASE_URL) { console.error('needs Supabase credentials (servers restore content on boot)'); process.exit(2); }

if (mode === 'capture') {
  const { execSync } = await import('child_process');
  const commit = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
  const dirty = execSync('git status --porcelain -- engine lib public', { cwd: ROOT }).toString().trim();
  if (dirty) { console.error('engine/lib/public have uncommitted changes — capture only from a clean commit'); process.exit(2); }
  const manifest = { commit, capturedAt: new Date().toISOString(), shapes: {} };
  for (const shape of Object.keys(SHAPES)) {
    console.log(`capture ${shape}`);
    manifest.shapes[shape] = await snapshot(shape, {}, '');
  }
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${path.relative(ROOT, MANIFEST)} (${commit.slice(0, 7)}), bodies in ${BODY_DIR}`);
} else if (mode === 'compare') {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  console.log(`baseline ${manifest.commit.slice(0, 7)} captured ${manifest.capturedAt}`);
  let failed = 0, checked = 0;
  for (const shape of Object.keys(SHAPES)) {
    for (const [i, env] of [{}, ...INERT_VARIANTS[shape]].entries()) {
      const tag = `compare-${i}`;
      const label = `${shape} ${Object.keys(env).length ? JSON.stringify(env) : '(cold-open env unset)'}`;
      const got = await snapshot(shape, env, tag);
      let bad = 0;
      for (const [k, want] of Object.entries(manifest.shapes[shape])) {
        checked++;
        const g = got[k];
        const same = g && ['status', 'type', 'location', 'cacheControl', 'sha256'].every(f => g[f] === want[f]);
        if (!same) { bad++; failed++; console.log(`  FAIL  ${label}  ${k}\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(g)}`); }
      }
      console.log(`  ${bad ? 'FAIL' : 'PASS'}  ${label}: ${Object.keys(manifest.shapes[shape]).length - bad}/${Object.keys(manifest.shapes[shape]).length} routes byte-identical`);
    }
  }
  console.log(failed ? `\n${failed} of ${checked} route checks differ.` : `\nAll ${checked} route checks byte-identical to ${manifest.commit.slice(0, 7)}.`);
  process.exit(failed ? 1 : 0);
} else if (mode === 'capture-live') {
  // The deployed services' own before-picture: --prod/--gw/--limen <url> --manifest <file>.
  // A live host is not comparable to a local boot byte-for-byte (a Windows checkout serves CRLF,
  // Railway serves git's LF; each service has its own branding env), so a live proof compares
  // the services against themselves before and after a deploy.
  const argOf = name => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? null : process.argv[i + 1]; };
  const out = argOf('manifest');
  if (!out) { console.error('capture-live needs --manifest <file>'); process.exit(2); }
  const live = { commit: null, capturedAt: new Date().toISOString(), live: true, shapes: {}, deployed: {} };
  for (const shape of Object.keys(SHAPES)) {
    const base = argOf(shape)?.replace(/\/+$/, '');
    if (!base) continue;
    record.lastCommit = null;
    live.shapes[shape] = {};
    for (const r of ROUTES) live.shapes[shape][key(r)] = (await record(base, r)).entry;
    live.deployed[shape] = { base, commit: record.lastCommit };
    console.log(`captured ${shape} ${base} (deployed ${record.lastCommit?.slice(0, 7) ?? '?'})`);
  }
  live.commit = Object.values(live.deployed)[0]?.commit || 'unknown';
  fs.writeFileSync(out, JSON.stringify(live, null, 2) + '\n');
  console.log(`wrote ${out}`);
} else if (mode === 'compare-live') {
  // The deployed services, as they run: --prod <url> --gw <url> --limen <url>, against
  // --manifest <file> (default: the local-boot manifest). Read-only GETs and validation-failing
  // POSTs only (no paid call); bot user agent (no page-view count).
  const mi = process.argv.indexOf('--manifest');
  const manifest = JSON.parse(fs.readFileSync(mi === -1 ? MANIFEST : process.argv[mi + 1], 'utf8'));
  const urlOf = name => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? null : process.argv[i + 1].replace(/\/+$/, ''); };
  console.log(`baseline ${manifest.commit.slice(0, 7)} captured ${manifest.capturedAt}`);
  let failed = 0, checked = 0;
  for (const shape of Object.keys(SHAPES)) {
    const base = urlOf(shape);
    if (!base) { console.log(`  SKIP  ${shape}: no --${shape} url`); continue; }
    record.lastCommit = null;
    let bad = 0;
    for (const r of ROUTES) {
      const k = key(r), want = manifest.shapes[shape][k];
      const { entry } = await record(base, r);
      checked++;
      if (!['status', 'type', 'location', 'cacheControl', 'sha256'].every(f => entry[f] === want[f])) {
        bad++; failed++;
        console.log(`  FAIL  ${shape} ${base}  ${k}\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(entry)}`);
      }
    }
    console.log(`  ${bad ? 'FAIL' : 'PASS'}  ${shape} ${base} (deployed ${record.lastCommit ? record.lastCommit.slice(0, 7) : '?'}): ${ROUTES.length - bad}/${ROUTES.length} routes byte-identical`);
  }
  console.log(failed ? `\n${failed} of ${checked} route checks differ.` : `\nAll ${checked} route checks byte-identical to ${manifest.commit.slice(0, 7)}.`);
  process.exit(failed ? 1 : 0);
} else {
  console.error('usage: node scripts/cold-open-baseline.mjs capture|compare|compare-live --prod <url> --gw <url> --limen <url>');
  process.exit(2);
}
