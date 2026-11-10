// RESTORE VERSION GUARD (scripts/scenario-snapshot.mjs).
//
// A restore writes the WHOLE bundle back, so any admin save made between the snapshot and the
// write used to be silently reverted (the Xavier draft→published revert): the only guard was
// the write-time baseVersion, taken from the live version at write time. Now the snapshot
// records its base_version and the restore refuses (exit 4, nothing written) when live has
// moved past it, unless --force. The write-time guard stays.
//
// Runs the REAL script as a child process against a mock admin API on localhost — no prod,
// no Supabase, no model calls. Snapshot files it writes are deleted at the end.

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT   = path.join(REPO_DIR, 'scripts', 'scenario-snapshot.mjs');
const SNAP_DIR = path.join(REPO_DIR, 'snapshots');
const ID = 'restore_guard_test_scenario';

let fails = 0;
const head  = s => console.log(`\n── ${s}`);
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`); if (!ok) fails++; };

// ── mock admin API ───────────────────────────────────────────────────────────
const S = { version: 0, bundle: null, saves: [] };
const reset = (title = 'Draft') => {
  S.version = 10; S.saves = [];
  S.bundle = {
    scenario: { id: ID, title, status: 'draft' },
    storyArc: { id: `${ID}_arc`, acts: [] },
    characters: [{ id: 'c1', name: 'One' }], locations: [], clues: [],
    playerRoles: [{ id: 'r1', name: 'Role', perspective: 'P0' }],
  };
};
const full = () => ({ ...JSON.parse(JSON.stringify(S.bundle)), current_version: S.version });
// An admin save made from the editor, outside the restore.
const adminSave = mutate => { mutate(S.bundle); S.version++; };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === `/admin/api/scenarios/${ID}/full`) return send(200, full());
    if (req.method === 'POST' && req.url === '/admin/api/generate/save') {
      const p = JSON.parse(body);
      S.saves.push(p);
      if (p.baseVersion !== S.version) return send(409, { error: `version conflict: base ${p.baseVersion}, live ${S.version}` });
      const { baseVersion: _b, ...rest } = p;
      for (const a of rest.storyArc?.acts || []) delete a._loaded_scene_ids;
      S.bundle = rest; S.version++;
      return send(200, { current_version: S.version });
    }
    send(404, { error: 'not found' });
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const run = args => new Promise(resolve => {
  const env = { ...process.env, ADMIN_COOKIE: 'connect.sid=test', ADMIN_BASE_URL: BASE };
  const p = spawn(process.execPath, [SCRIPT, ...args, '--base', BASE], { cwd: REPO_DIR, env });
  let out = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  p.on('close', code => resolve({ code, out }));
});

const created = [];
const takeSnapshot = async () => {
  const r = await run(['snapshot', ID]);
  const m = r.out.match(/Wrote (.+\.json)/);
  if (m) created.push(m[1].trim());
  return { ...r, file: m?.[1]?.trim() };
};
// An edit file built from a snapshot — what the content-edit workflow restores.
const editFile = (snapFile, perspective) => {
  const s = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  s.playerRoles[0].perspective = perspective;
  const f = path.join(os.tmpdir(), `restore-guard-${process.pid}-${created.length}.json`);
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
  created.push(f);
  return f;
};

try {
  head('snapshot records its base version');
  reset();
  const s0 = await takeSnapshot();
  const meta = s0.file && JSON.parse(fs.readFileSync(s0.file, 'utf8'))._snapshot;
  check('snapshot written', s0.code === 0 && !!s0.file, s0.out);
  check('_snapshot.base_version = live current_version at snapshot time', meta?.base_version === 10, JSON.stringify(meta));

  head('versions match → write proceeds as today');
  {
    const f = editFile(s0.file, 'P1');
    const r = await run(['restore', f, '--yes']);
    check('exit 0', r.code === 0, r.out);
    check('one save posted', S.saves.length === 1);
    check('write-time guard still sent: baseVersion = live version', S.saves[0]?.baseVersion === 10);
    check('edit landed', S.bundle.playerRoles[0].perspective === 'P1' && S.version === 11);
    check('verified after write', /VERIFIED/.test(r.out), r.out);
  }

  head('live advanced past the snapshot base → refused, nothing written');
  reset();
  {
    const snap = await takeSnapshot();
    const f = editFile(snap.file, 'P1');
    adminSave(b => { b.scenario.status = 'published'; });          // the Xavier case
    const r = await run(['restore', f, '--yes']);
    check('exit 4 (non-zero)', r.code === 4, `exit ${r.code}\n${r.out}`);
    check('clear message', r.out.includes(`Scenario ${ID} changed since snapshot (snapshot v10, live v11) — re-snapshot, re-diff, and retry.`), r.out);
    check('nothing written (no save posted)', S.saves.length === 0);
    check('intervening save intact', S.bundle.scenario.status === 'published' && S.version === 11);
    const dry = await run(['restore', f]);
    check('dry run refuses the same way', dry.code === 4 && dry.out.includes('changed since snapshot') && S.saves.length === 0, dry.out);

    head('--force on a mismatch → writes anyway');
    const forced = await run(['restore', f, '--yes', '--force']);
    check('exit 0', forced.code === 0, forced.out);
    check('announces the override', /FORCE: .*changed since snapshot \(snapshot v10, live v11\)/.test(forced.out), forced.out);
    check('one save, still carrying the write-time guard (baseVersion = live v11)', S.saves.length === 1 && S.saves[0].baseVersion === 11);
    check('snapshot written over the intervening save', S.bundle.scenario.status === 'draft' && S.bundle.playerRoles[0].perspective === 'P1');
    adminSave(b => { b.scenario.status = 'published'; });          // give the dry run a real difference
    const dryForce = await run(['restore', f, '--force']);
    check('--force without --yes is still a dry run', dryForce.code === 2 && /Dry run/.test(dryForce.out) && S.saves.length === 1 && S.bundle.scenario.status === 'published', dryForce.out);
  }

  head('re-snapshot after the refusal → proceeds');
  reset();
  {
    const old = await takeSnapshot();
    adminSave(b => { b.scenario.status = 'published'; });
    check('stale edit refused', (await run(['restore', editFile(old.file, 'P1'), '--yes'])).code === 4 && S.saves.length === 0);
    const fresh = await takeSnapshot();
    const r = await run(['restore', editFile(fresh.file, 'P1'), '--yes']);
    check('fresh edit writes and keeps the intervening save', r.code === 0 && S.bundle.scenario.status === 'published' && S.bundle.playerRoles[0].perspective === 'P1', r.out);
  }

  head('older snapshots (no base_version) fall back to the bundle current_version');
  reset();
  {
    const snap = await takeSnapshot();
    const legacy = JSON.parse(fs.readFileSync(snap.file, 'utf8'));
    delete legacy._snapshot.base_version;
    legacy.playerRoles[0].perspective = 'P1';
    const f = path.join(os.tmpdir(), `restore-guard-${process.pid}-legacy.json`);
    fs.writeFileSync(f, JSON.stringify(legacy)); created.push(f);
    check('match → writes', (await run(['restore', f, '--yes'])).code === 0 && S.saves.length === 1);
    const r = await run(['restore', f, '--yes']);                   // live is now v11, file says v10
    check('mismatch → refused', r.code === 4 && r.out.includes('(snapshot v10, live v11)') && S.saves.length === 1, r.out);
    delete legacy.current_version;
    fs.writeFileSync(f, JSON.stringify(legacy));
    const nov = await run(['restore', f, '--yes']);
    check('no version at all → refused', nov.code === 4 && nov.out.includes('records no base version') && S.saves.length === 1, nov.out);
  }

  head('write-time guard: a save landing after the check is a 409, even with --force');
  reset();
  {
    const snap = await takeSnapshot();
    const f = editFile(snap.file, 'P1');
    // Bump the version on the first save attempt's arrival, i.e. after the script read /full.
    const orig = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', (req, res) => { if (req.method === 'POST') adminSave(b => { b.scenario.status = 'published'; }); orig(req, res); });
    const r = await run(['restore', f, '--yes', '--force']);
    server.removeAllListeners('request'); server.on('request', orig);
    check('409 → non-zero, intervening save intact', r.code !== 0 && /409/.test(r.out) && S.bundle.scenario.status === 'published', r.out);
  }
} finally {
  for (const f of created) { try { fs.unlinkSync(f); } catch {} }
  server.close();
}

console.log(fails ? `\n${fails} failure(s).` : '\nAll restore-guard checks passed.');
process.exit(fails ? 1 : 0);
