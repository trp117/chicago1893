// DEMO_MODE — the landing page-view tally.
//
//   node tests/demo-pageviews.test.mjs
//
// The demo page guard counts a GET of "/" (fire-and-forget) into public.demo_pageviews under
// the demo's site id (= DEMO_BUDGET_ID). Checked here against the guard mounted the way
// server.js mounts it — ahead of express.static(public/), with stand-ins for /health, /api/*
// and /game/api/* behind it:
//   1. "/" counts once per view, under the right site id ('global' / 'limen');
//   2. bot user agents do not count; HEAD does not count;
//   3. nothing else counts: assets, /health, /api/*, /game, /game/api/*, /og-image.png,
//      redirects, 404s;
//   4. a failing increment — sync throw, rejection, Supabase error — still serves the landing
//      byte-for-byte; a hung increment does not delay it;
//   5. no counter wired (what prod has: the guard is never mounted) counts nothing.
// No network, no Supabase, no model calls. The flag-off server contract (guard not mounted,
// "/" is public/index.html) is demo-mode.test Part A.
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const imp = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const { demoPageGuard, readDemoBranding, isBotUserAgent } = await imp('engine/server/demoMode.js');
const { createSupabaseDemoStore, createMemoryDemoStore, readDemoBudgetId } = await imp('engine/server/demoStore.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
  if (!ok) failed++;
};
const section = t => console.log(`\n${t}`);
const GW_LANDING = fs.readFileSync(path.join(ROOT, 'tests/fixtures/greywitness-landing.html'));
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// Long enough for the guard's setImmediate + the store's promise to have run.
const settle = () => new Promise(r => setTimeout(r, 30));

// The server.js stack, minus Supabase: guard, then static, then the routes behind it.
async function serve({ onLandingView, branding } = {}) {
  const app = express();
  app.use(demoPageGuard({ gameHtmlPath: path.join(ROOT, 'engine/game/index.html'), branding, cacheControl: 'no-store', onLandingView }));
  app.use(express.static(path.join(ROOT, 'public')));
  app.get('/health', (_, res) => res.json({ ok: true }));
  app.get('/api/stories', (_, res) => res.json([]));
  app.get('/game/api/config', (_, res) => res.json({ demoMode: true }));
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://localhost:${srv.address().port}`;
  const req = async (u, { ua = BROWSER, method = 'GET' } = {}) => {
    const r = await fetch(base + u, { method, redirect: 'manual', headers: ua === null ? {} : { 'User-Agent': ua } });
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  };
  return { req, close: () => new Promise(r => { srv.closeAllConnections(); srv.close(r); }) };
}

// A stand-in for the Supabase client: records rpc calls; `fail` picks how demo_pageview_incr fails.
function fakeSupabase({ fail = null } = {}) {
  const rpcs = [];
  return {
    rpcs,
    async rpc(fn, args) {
      rpcs.push({ fn, args });
      if (fail === 'error')  return { data: null, error: { message: 'relation "demo_pageviews" does not exist' } };
      if (fail === 'reject') throw new Error('fetch failed');
      if (fail === 'hang')   return new Promise(() => {});
      return { data: null, error: null };
    },
  };
}

// ── bot check ────────────────────────────────────────────────────────────────
section('bot user agents');
for (const ua of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'facebookexternalhit/1.1',
                  'Slackbot-LinkExpanding 1.0', 'redditbot/1.0', 'Twitterbot/1.0', 'Discordbot/2.0', 'LinkedInBot/1.0', 'AhrefsBot',
                  'Mozilla/5.0 (compatible; YandexSpider)', 'CCBot crawler', 'WhatsApp link preview', 'demo-mode-test-bot']) {
  check(`bot: ${ua.slice(0, 48)}`, isBotUserAgent(ua));
}
for (const ua of [BROWSER, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', '', undefined]) {
  check(`not a bot: ${String(ua).slice(0, 48) || '(empty)'}`, !isBotUserAgent(ua));
}

// ── 1–3. what counts, under which id ────────────────────────────────────────
section('1-3 — only a real GET of "/" counts, under the demo\'s site id');
{
  const db = fakeSupabase();
  const store = createSupabaseDemoStore(db, { budgetId: readDemoBudgetId({}) });   // Grey Witness defaults
  const s = await serve({ onLandingView: () => store.incrPageview() });

  const r = await s.req('/');
  await settle();
  check('GET / serves the landing (byte-identical) …', r.status === 200 && r.body.equals(GW_LANDING));
  check('… and counts exactly once, as demo_pageview_incr({ p_site: "global" })',
    JSON.stringify(db.rpcs) === JSON.stringify([{ fn: 'demo_pageview_incr', args: { p_site: 'global' } }]), JSON.stringify(db.rpcs));

  await s.req('/'); await s.req('/?utm_source=x'); await settle();
  check('three views → three increments', db.rpcs.length === 3, String(db.rpcs.length));

  db.rpcs.length = 0;
  for (const ua of ['Googlebot/2.1', 'facebookexternalhit/1.1', 'Slackbot-LinkExpanding 1.0', 'redditbot/1.0', 'Twitterbot/1.0']) {
    const b = await s.req('/', { ua });
    check(`bot "${ua}" gets the landing but is not counted`, b.status === 200 && b.body.equals(GW_LANDING));
  }
  const head = await s.req('/', { method: 'HEAD' });
  await settle();
  check('HEAD / (uptime probes) is answered, not counted', head.status === 200 && db.rpcs.length === 0, JSON.stringify(db.rpcs));

  for (const u of ['/og-image.png', '/health', '/api/stories', '/game', '/game?scenarioId=tolle_lege_milan_386', '/game/api/config',
                   '/js/scenario-card.js', '/favicon.ico', '/index.html', '/categories', '/test', '/admin', '/nope.css']) {
    await s.req(u);
  }
  await settle();
  check('assets, /health, /api/*, /game, /game/api/*, /og-image.png, redirects, 404s: no increment', db.rpcs.length === 0, JSON.stringify(db.rpcs));
  await s.close();

  // Project Limen counts under its own id.
  const ldb = fakeSupabase();
  const lstore = createSupabaseDemoStore(ldb, { budgetId: readDemoBudgetId({ DEMO_BUDGET_ID: 'limen' }) });
  const l = await serve({ onLandingView: () => lstore.incrPageview(), branding: readDemoBranding({ DEMO_SITE_NAME: 'Project Limen' }) });
  const lr = await l.req('/');
  await settle();
  check('Limen: GET / counts as demo_pageview_incr({ p_site: "limen" })', lr.status === 200 && lr.body.toString().includes('<title>Project Limen</title>')
    && JSON.stringify(ldb.rpcs) === JSON.stringify([{ fn: 'demo_pageview_incr', args: { p_site: 'limen' } }]), JSON.stringify(ldb.rpcs));
  await l.close();

  // The memory store counts too (same interface the game router tests use).
  const mem = createMemoryDemoStore();
  const m = await serve({ onLandingView: () => mem.incrPageview() });
  await m.req('/'); await m.req('/', { ua: 'bingbot' }); await m.req('/health'); await settle();
  check('memory store: one browser view = 1, bot and /health = 0', mem.state.pageviews === 1, String(mem.state.pageviews));
  await m.close();
}

// ── 4. failures never touch the landing ─────────────────────────────────────
section('4 — a failing or hung increment never breaks or delays the landing');
{
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    for (const fail of ['error', 'reject']) {
      const db = fakeSupabase({ fail });
      const store = createSupabaseDemoStore(db);
      const s = await serve({ onLandingView: () => store.incrPageview() });
      const r1 = await s.req('/'); const r2 = await s.req('/');
      await settle();
      check(`Supabase ${fail === 'error' ? 'error response' : 'network rejection'}: landing still 200, byte-identical, twice`,
        r1.status === 200 && r1.body.equals(GW_LANDING) && r2.status === 200 && r2.body.equals(GW_LANDING) && db.rpcs.length === 2);
      await s.close();
    }
    {
      const s = await serve({ onLandingView: () => { throw new Error('sync boom'); } });
      const r = await s.req('/');
      await settle();
      check('counter throws synchronously: landing still 200, byte-identical', r.status === 200 && r.body.equals(GW_LANDING));
      await s.close();
    }
    {
      const db = fakeSupabase({ fail: 'hang' });
      const store = createSupabaseDemoStore(db);
      const s = await serve({ onLandingView: () => store.incrPageview() });
      const t0 = Date.now();
      const r = await s.req('/');
      const ms = Date.now() - t0;
      check(`increment that never resolves: landing served at once (${ms}ms)`, r.status === 200 && r.body.equals(GW_LANDING) && ms < 1000);
      await s.close();
    }
    check('failures are logged at most once per process ([DEMO PAGEVIEW])', warns.filter(w => w.includes('[DEMO PAGEVIEW]')).length === 1, JSON.stringify(warns));
  } finally {
    console.warn = realWarn;
  }
}

// ── 5. no counter wired ─────────────────────────────────────────────────────
section('5 — no counter wired (prod never mounts the guard at all)');
{
  const s = await serve({});
  const r = await s.req('/');
  check('guard without onLandingView serves the landing and has nothing to call', r.status === 200 && r.body.equals(GW_LANDING));
  await s.close();
}

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll demo-pageviews assertions passed.');
process.exitCode = failed ? 1 : 0;   // let the loop drain (process.exit here aborts in libuv on Windows)
