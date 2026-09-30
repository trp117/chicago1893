// PERSISTENT ADMIN SESSIONS — lib/SupabaseSessionStore.js against the real admin_sessions table.
//
// The default MemoryStore lost every admin session on each deploy, and an open editor's next
// Save failed with 401 — Joan's scenes were lost that way. This asserts the store half of the
// fix: a session written by one store instance is readable by a FRESH instance (a restart),
// expiry and destroy behave, failures degrade the way the store promises, and the public anon
// key cannot read the table at all.
//
// Writes only rows whose sid starts with the test prefix, and deletes them at the end.
// Needs Supabase credentials (skips without them). The server-restart half is
// tests/session-restart.e2e.mjs (run on its own — it boots the real server twice).

import 'dotenv/config';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).href;

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.log('SKIP  no Supabase credentials — session-store test needs the real table');
  process.exit(0);
}

const { supabase, supabaseAuth } = await import(`${ROOT}/lib/supabase.js`);
const { SupabaseSessionStore }   = await import(`${ROOT}/lib/SupabaseSessionStore.js`);

const PREFIX = `test_sessstore_${process.pid}_`;
const p      = fn => new Promise((res, rej) => fn((err, v) => (err ? rej(err) : res(v))));
const quiet  = async fn => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const sessWith = (ms, extra = {}) => ({
  cookie: { originalMaxAge: ms, expires: new Date(Date.now() + ms).toISOString(), secure: false, httpOnly: true, path: '/' },
  ...extra,
});
const rowOf = async sid => (await supabase.from('admin_sessions').select('sid, sess, expire').eq('sid', sid).maybeSingle()).data;

const stores = [];
const mk = opts => { const s = new SupabaseSessionStore({ client: supabase, pruneMs: 0, ...opts }); stores.push(s); return s; };

try {
  head('1. survives a restart — a FRESH store instance reads what another wrote');
  const sid = `${PREFIX}login`;
  const a = mk();
  const sess = sessWith(24 * 60 * 60 * 1000, { adminUser: { id: 'u1', email: 'admin@test.local', loginAt: '2026-09-30T00:00:00.000Z' } });
  await p(cb => a.set(sid, sess, cb));
  const row = await rowOf(sid);
  check('set writes a row', !!row && row.sess.adminUser?.email === 'admin@test.local');
  check('row expiry = the cookie\'s expiry', row && Math.abs(new Date(row.expire).getTime() - new Date(sess.cookie.expires).getTime()) < 1000);
  const b = mk();   // cold cache: nothing in memory — exactly the state after a deploy
  const got = await p(cb => b.get(sid, cb));
  check('a fresh store (cold cache, as after a restart) returns the session', got?.adminUser?.email === 'admin@test.local', JSON.stringify(got?.adminUser));
  check('...cookie preserved', got?.cookie?.httpOnly === true && got?.cookie?.originalMaxAge === 24 * 60 * 60 * 1000);

  head('2. expiry, touch, destroy, prune');
  const before = (await rowOf(sid)).expire;
  await p(cb => b.touch(sid, got, cb));
  check('touch does not extend the row past the browser cookie', (await rowOf(sid)).expire === before);

  const expSid = `${PREFIX}expired`;
  await supabase.from('admin_sessions').insert({ sid: expSid, sess: sessWith(1000), expire: new Date(Date.now() - 60000).toISOString() });
  check('an expired row reads as no session', (await p(cb => mk().get(expSid, cb))) === null);
  await new Promise(r => setTimeout(r, 800));
  check('...and is deleted on read', (await rowOf(expSid)) === null);

  const prSid = `${PREFIX}prune`;
  await supabase.from('admin_sessions').insert({ sid: prSid, sess: sessWith(1000), expire: new Date(Date.now() - 60000).toISOString() });
  await mk().prune();
  check('prune deletes expired rows', (await rowOf(prSid)) === null);
  check('...and leaves live ones', (await rowOf(sid)) !== null);

  await p(cb => a.destroy(sid, cb));
  check('destroy (logout) deletes the row', (await rowOf(sid)) === null);
  check('...and a destroyed session reads as none — in the same store (cache cleared) and a fresh one',
        (await p(cb => a.get(sid, cb))) === null && (await p(cb => mk().get(sid, cb))) === null);
  check('get of a sid that never existed → no session', (await p(cb => mk().get(`${PREFIX}never`, cb))) === null);

  head('3. failures degrade as promised');
  const broken = { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: new Error('db down') }) }) }),
    upsert: async () => ({ error: new Error('db down') }),
  }) };
  const bs = new SupabaseSessionStore({ client: broken, pruneMs: 0 });
  const readRes = await quiet(() => p(cb => bs.get(`${PREFIX}x`, cb)));
  check('read failure → signed out (null), never an error that 500s the site', readRes === null);
  let writeErr = null;
  await quiet(() => new Promise(r => bs.set(`${PREFIX}x`, sessWith(1000), err => { writeErr = err; r(); })));
  check('write failure → error returned (a login that cannot persist fails visibly)', writeErr instanceof Error);

  head('4. security — the public anon key cannot read sessions');
  const probeSid = `${PREFIX}probe`;
  await p(cb => mk().set(probeSid, sessWith(60000, { adminUser: { id: 'u2', email: 'probe@test.local' } }), cb));
  const anon = await supabaseAuth.from('admin_sessions').select('sid').eq('sid', probeSid);
  check('anon client sees no session rows', !(anon.data && anon.data.length), anon.error ? `refused: ${anon.error.message}` : `rows=${anon.data?.length ?? 0}`);
  const anonWrite = await supabaseAuth.from('admin_sessions').insert({ sid: `${PREFIX}anon`, sess: {}, expire: new Date(Date.now() + 60000).toISOString() });
  check('anon client cannot insert a session', !!anonWrite.error && (await rowOf(`${PREFIX}anon`)) === null, anonWrite.error?.message);
} finally {
  stores.forEach(s => s.close());
  await supabase.from('admin_sessions').delete().like('sid', `${PREFIX}%`);
  const { data } = await supabase.from('admin_sessions').select('sid').like('sid', `${PREFIX}%`);
  check('test rows cleaned up', (data || []).length === 0);
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll session-store assertions passed.');
process.exit(fails ? 1 : 0);
