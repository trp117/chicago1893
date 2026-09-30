// PERSISTENT ADMIN SESSIONS — end to end: does an admin session survive a SERVER RESTART?
//
// The thing that failed before: deploy → every admin signed out → the open editor's next Save
// 401s. This boots the real engine/server/server.js, presents a signed admin session cookie
// (exactly what a login leaves in the browser), restarts the server, and checks the same
// cookie is still signed in — for a read (/admin/auth/me) and for an authenticated WRITE route
// (PUT /admin/api/story-arcs/<missing id> → 404 means auth passed; 401 means signed out; the
// id does not exist, so nothing is written). Then logout, and a bad login.
//
// The session is created through the real store with the server's SESSION_SECRET rather than
// by a real password login (no credentials here); the login route's own behaviour is covered
// by the bad-login check and by a real login in production.
//
// Slow (boots the server twice), so NOT part of `npm test`:  node tests/session-restart.e2e.mjs

import 'dotenv/config';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;
const PORT     = Number(process.env.E2E_PORT || 3017);
const BASE     = `http://127.0.0.1:${PORT}`;

const { supabase }             = await import(`${ROOT}/lib/supabase.js`);
const { SupabaseSessionStore } = await import(`${ROOT}/lib/SupabaseSessionStore.js`);
const signature                = (await import('cookie-signature')).default;

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head  = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let server = null;
async function boot() {
  server = spawn(process.execPath, ['engine/server/server.js'], {
    cwd: REPO_DIR, env: { ...process.env, PORT: String(PORT), ENGINE_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    if (server.exitCode !== null) throw new Error(`server exited during boot:\n${log.slice(-1500)}`);
    await sleep(1000);
  }
  throw new Error(`server did not come up on ${PORT}:\n${log.slice(-1500)}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(r => server.once('exit', r));
  server.kill();
  await Promise.race([exited, sleep(10000)]);
}

const sid    = `e2e_${crypto.randomBytes(18).toString('base64url')}`;
const secret = process.env.SESSION_SECRET || 'ledger250-dev-secret';
const cookie = `connect.sid=${encodeURIComponent('s:' + signature.sign(sid, secret))}`;
// redirect:'manual' — /admin/auth/me is not under /admin/api, so signed-out is a 302 to the
// login page, which fetch would otherwise follow into a 200.
const me     = (withCookie = true) => fetch(`${BASE}/admin/auth/me`, { headers: withCookie ? { cookie } : {}, redirect: 'manual' });
const signedOut = r => r.status === 302 && (r.headers.get('location') || '').includes('/admin/login');
const save   = (withCookie = true) => fetch(`${BASE}/admin/api/story-arcs/__e2e_no_such_arc__`, {
  method: 'PUT', headers: { 'content-type': 'application/json', ...(withCookie ? { cookie } : {}) }, body: JSON.stringify({ name: 'e2e' }),
});
const rowCount = async () => (await supabase.from('admin_sessions').select('sid', { count: 'exact', head: true })).count;

const store = new SupabaseSessionStore({ client: supabase, pruneMs: 0 });
try {
  head('boot #1');
  await boot();
  const ms = 24 * 60 * 60 * 1000;
  await new Promise((res, rej) => store.set(sid, {
    cookie: { originalMaxAge: ms, expires: new Date(Date.now() + ms).toISOString(), secure: false, httpOnly: true, path: '/' },
    adminUser: { id: 'e2e', email: 'e2e-session@test.local', loginAt: new Date().toISOString() },
  }, e => (e ? rej(e) : res())));

  let r = await me();
  check('signed in before the restart (/admin/auth/me 200)', r.status === 200 && (await r.json()).email === 'e2e-session@test.local', String(r.status));
  check('...an authenticated save route is reachable (404 = auth passed, nothing written)', (await save()).status === 404);
  check('...and without the cookie the same route is 401', (await save(false)).status === 401);

  head('RESTART — stop the server, boot a new process');
  await stop();
  check('server #1 stopped', server.exitCode !== null || server.killed);
  await boot();

  r = await me();
  const body = r.status === 200 ? await r.json() : null;
  check('STILL signed in after the restart (/admin/auth/me 200)', r.status === 200 && body?.email === 'e2e-session@test.local', String(r.status));
  check('...and a save route still passes auth after the restart (404, not 401)', (await save()).status === 404);

  head('logout, bad login');
  const out = await fetch(`${BASE}/admin/auth/logout`, { method: 'POST', headers: { cookie } });
  check('logout succeeds', out.ok && (await out.json()).success === true);
  const after = await me();
  check('...then the cookie is signed out (/me → 302 to /admin/login)', signedOut(after), `${after.status} ${after.headers.get('location') || ''}`);
  check('control: no cookie at all is signed out the same way', signedOut(await me(false)));
  const { data: gone } = await supabase.from('admin_sessions').select('sid').eq('sid', sid);
  check('...and the session row is deleted', (gone || []).length === 0);

  const nBefore = await rowCount();
  const bad = await fetch(`${BASE}/admin/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@test.local', password: 'wrong-password' }) });
  const badBody = await bad.json();
  check('a bad login is refused', badBody.success === false, badBody.error);
  check('...and creates no session row (saveUninitialized stays false)', (await rowCount()) === nBefore);
} catch (err) {
  console.log(`FAIL  e2e aborted: ${err.message}`);
  fails++;
} finally {
  await stop();
  store.close();
  await supabase.from('admin_sessions').delete().eq('sid', sid);
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nSession survives restart — all e2e assertions passed.');
process.exit(fails ? 1 : 0);
