// DEMO_MODE — per-demo branding and per-demo budget row.
//
//   node tests/demo-branding.test.mjs
//
// One codebase serves several independent demos; each names itself through env
// (DEMO_SITE_NAME / DEMO_SITE_URL / DEMO_SITE_TAGLINE / DEMO_OG_IMAGE_FILE) and meters against
// its own demo_budget row (DEMO_BUDGET_ID). Every default is Grey Witness's.
//
//   1. no env  -> the landing is byte-identical to the frozen Grey Witness landing
//                 (tests/fixtures/greywitness-landing.html), /og-image.png is greywitness-og.png,
//                 the budget row is 'global' and the RPC call is the one-argument call it was;
//   2. Limen env -> the landing names Project Limen everywhere Grey Witness was, /og-image.png
//                 is projectlimen-og.png, budget reads/writes go to the 'limen' row;
//   3. isolation -> two stores on one (simulated) demo_budget table never touch each other's
//                 row, and Grey Witness's existing spend stays intact;
//   4. bad config fails at boot (image name traversal, malformed budget id).
//
// No network, no Supabase, no model calls. (The live SQL is in
// supabase/migrations/20261116_demo_budget_per_demo.sql; the end-to-end server boots for
// both brandings are in demo-mode.test.mjs.)
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const imp = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const { readDemoBranding, renderDemoLanding, demoPageGuard, DEMO_LANDING_PATH, DEMO_BRANDING_DEFAULTS } = await imp('engine/server/demoMode.js');
const { createSupabaseDemoStore, readDemoBudgetId, DEFAULT_DEMO_BUDGET_ID } = await imp('engine/server/demoStore.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
  if (!ok) failed++;
};
const section = t => console.log(`\n${t}`);
const file = rel => fs.readFileSync(path.join(ROOT, rel));
const template = fs.readFileSync(DEMO_LANDING_PATH, 'utf8');
const GW_LANDING = file('tests/fixtures/greywitness-landing.html');

const LIMEN_ENV = {
  DEMO_SITE_NAME: 'Project Limen',
  DEMO_SITE_URL: 'https://projectlimen.com',
  DEMO_SITE_TAGLINE: 'Cross the threshold of a turning point in history.',
  DEMO_OG_IMAGE_FILE: 'projectlimen-og.png',
  DEMO_BUDGET_ID: 'limen',
};

// ── 1. defaults ──────────────────────────────────────────────────────────────
section('1 — no new env: Grey Witness, unchanged');
{
  const b = readDemoBranding({});
  check('defaults are the Grey Witness values', JSON.stringify(b) === JSON.stringify(DEMO_BRANDING_DEFAULTS), JSON.stringify(b));
  check('blank env values also take the defaults', JSON.stringify(readDemoBranding({ DEMO_SITE_NAME: '  ', DEMO_SITE_URL: '', DEMO_OG_IMAGE_FILE: '' })) === JSON.stringify(DEMO_BRANDING_DEFAULTS));
  const html = renderDemoLanding(template, b);
  check('rendered landing is byte-identical to the frozen Grey Witness landing', Buffer.from(html).equals(GW_LANDING),
    `rendered ${Buffer.byteLength(html)}B vs fixture ${GW_LANDING.length}B`);
  check('the template on disk has no Grey Witness text left (all of it comes from branding)', !/grey ?witness/i.test(template));
  check('no placeholder survives rendering', !/\{\{[A-Z_]+\}\}/.test(html));
  check('budget id defaults to the current row, "global"', readDemoBudgetId({}) === 'global' && DEFAULT_DEMO_BUDGET_ID === 'global');
}

// ── 2. Limen ─────────────────────────────────────────────────────────────────
section('2 — Project Limen env');
{
  const b = readDemoBranding(LIMEN_ENV);
  const html = renderDemoLanding(template, b);
  const head = html.slice(0, html.indexOf('</head>'));
  for (const tag of [
    '<title>Project Limen</title>',
    '<meta name="description" content="Project Limen — cross the threshold of a turning point in history.">',
    '<meta property="og:site_name" content="Project Limen">',
    '<meta property="og:title" content="Project Limen">',
    '<meta property="og:description" content="Cross the threshold of a turning point in history.">',
    '<meta property="og:url" content="https://projectlimen.com">',
    '<meta property="og:image" content="https://projectlimen.com/og-image.png">',
    '<meta property="og:image:alt" content="Project Limen — interactive historical fiction">',
    '<meta name="twitter:title" content="Project Limen">',
    '<meta name="twitter:description" content="Cross the threshold of a turning point in history.">',
    '<meta name="twitter:image" content="https://projectlimen.com/og-image.png">',
    '<link rel="canonical" href="https://projectlimen.com">',
  ]) check(`<head> has ${tag.slice(0, 60)}`, head.includes(tag));
  check('visible brand + tagline', html.includes('<h1 class="brand">Project Limen</h1>') && html.includes('<p class="lede">Cross the threshold of a turning point in history.</p>'));
  check('no trace of Grey Witness anywhere', !/grey ?witness/i.test(html));
  check('story grid still built from /api/stories (unchanged script)', html.includes("fetch('/api/stories')")
    && html.slice(html.indexOf('<script>')) === GW_LANDING.toString().slice(GW_LANDING.toString().indexOf('<script>')));
  check('trailing slash on DEMO_SITE_URL is dropped', readDemoBranding({ DEMO_SITE_URL: 'https://projectlimen.com/' }).siteUrl === 'https://projectlimen.com');
  check('budget id from env', readDemoBudgetId(LIMEN_ENV) === 'limen');

  const x = renderDemoLanding(template, { ...b, siteName: 'A <b>"&\'', tagline: '<script>x</script>' });
  check('values are HTML-escaped (no markup injection through env)', !x.includes('<b>') && !x.includes('<script>x') && x.includes('A &lt;b&gt;&quot;&amp;&#39;'));
}

// ── 4. bad config ────────────────────────────────────────────────────────────
section('4 — bad config refuses to boot');
for (const bad of ['../.env', '../demo/x.png', 'sub/x.png', 'x.jpg', '.png', 'x.png/']) {
  let threw = false; try { readDemoBranding({ DEMO_OG_IMAGE_FILE: bad }); } catch { threw = true; }
  check(`DEMO_OG_IMAGE_FILE="${bad}" throws`, threw);
}
for (const bad of ['a b', 'x;drop', 'é', 'a'.repeat(65)]) {
  let threw = false; try { readDemoBudgetId({ DEMO_BUDGET_ID: bad }); } catch { threw = true; }
  check(`DEMO_BUDGET_ID="${bad.slice(0, 12)}" throws`, threw);
}

// ── the guard: / and /og-image.png per branding ─────────────────────────────
section('guard — / and /og-image.png follow the branding');
async function serve(branding) {
  const app = express();
  app.use(demoPageGuard({ gameHtmlPath: path.join(ROOT, 'engine/game/index.html'), branding, cacheControl: 'no-store' }));
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://localhost:${srv.address().port}`;
  const get = async u => { const r = await fetch(base + u); return { status: r.status, type: r.headers.get('content-type'), body: Buffer.from(await r.arrayBuffer()) }; };
  return { get, close: () => new Promise(r => { srv.closeAllConnections(); srv.close(r); }) };
}
{
  const gw = await serve(undefined);   // what a caller that passes no branding gets
  const root = await gw.get('/');
  check('no branding passed: / is the Grey Witness landing byte-for-byte (text/html)', root.status === 200 && /text\/html/.test(root.type) && root.body.equals(GW_LANDING));
  const og = await gw.get('/og-image.png');
  check('no branding passed: /og-image.png is greywitness-og.png', og.status === 200 && og.type === 'image/png' && og.body.equals(file('engine/demo/greywitness-og.png')));
  await gw.close();

  const gw2 = await serve(readDemoBranding({}));
  check('empty env: / is the Grey Witness landing byte-for-byte', (await gw2.get('/')).body.equals(GW_LANDING));
  await gw2.close();

  const lm = await serve(readDemoBranding(LIMEN_ENV));
  const lroot = await lm.get('/');
  check('Limen: / names Project Limen', lroot.status === 200 && lroot.body.toString().includes('<title>Project Limen</title>'));
  const log = await lm.get('/og-image.png');
  check('Limen: /og-image.png is projectlimen-og.png (1200×630)', log.status === 200 && log.type === 'image/png'
    && log.body.equals(file('engine/demo/projectlimen-og.png')) && !log.body.equals(file('engine/demo/greywitness-og.png'))
    && log.body.readUInt32BE(16) === 1200 && log.body.readUInt32BE(20) === 630, `${log.status} ${log.body.length}B`);
  await lm.close();
}

// ── 3. budget routing + isolation ───────────────────────────────────────────
// A stand-in for the Supabase client over one in-memory demo_budget table. rpc implements
// demo_budget_add as the migration defines it: p_id defaults to 'global'; a new id's row is
// created on its first add. It also records the exact calls the store makes.
function fakeSupabase(rows) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, filters: {} };
      const api = {
        select(cols) { q.select = cols; return api; },
        eq(col, v)   { q.filters[col] = v; return api; },
        async maybeSingle() {
          calls.push({ op: 'select', table, filters: { ...q.filters } });
          const r = rows.get(q.filters.id);
          return { data: r === undefined ? null : { spent_cents: r }, error: null };
        },
      };
      return api;
    },
    async rpc(fn, args) {
      calls.push({ op: 'rpc', fn, args: { ...args } });
      if (fn !== 'demo_budget_add') return { data: null, error: { message: 'unknown fn' } };
      const id = args.p_id ?? 'global';
      rows.set(id, (rows.get(id) ?? 0) + args.p_cents);
      return { data: rows.get(id), error: null };
    },
  };
}

section('3 — budget row per demo, isolated');
{
  const rows = new Map([['global', 4321.5]]);   // Grey Witness's existing spend
  const db = fakeSupabase(rows);
  const gw = createSupabaseDemoStore(db);                                      // as server.js builds it with no env…
  const gwEnv = createSupabaseDemoStore(db, { budgetId: readDemoBudgetId({}) }); // …and with DEMO_BUDGET_ID unset
  const lm = createSupabaseDemoStore(db, { budgetId: readDemoBudgetId(LIMEN_ENV) });

  check('default store reads the "global" row (existing history intact)', await gw.readBudget() === 4321.5 && await gwEnv.readBudget() === 4321.5);
  check('new demo with no row yet reads 0', await lm.readBudget() === 0);

  db.calls.length = 0;
  await gwEnv.addBudget(10);
  check('default store calls demo_budget_add with only p_cents — the exact pre-change call', JSON.stringify(db.calls) === JSON.stringify([{ op: 'rpc', fn: 'demo_budget_add', args: { p_cents: 10 } }]), JSON.stringify(db.calls));

  db.calls.length = 0;
  const t1 = await lm.addBudget(25);
  check('Limen store calls demo_budget_add with p_id "limen"', JSON.stringify(db.calls) === JSON.stringify([{ op: 'rpc', fn: 'demo_budget_add', args: { p_cents: 25, p_id: 'limen' } }]), JSON.stringify(db.calls));
  check('first Limen write creates its row (25)', t1 === 25 && rows.get('limen') === 25);
  await lm.addBudget(5);

  check('Limen spend never reaches Grey Witness: global = 4321.5 + 10 only', rows.get('global') === 4331.5, String(rows.get('global')));
  check('Grey Witness spend never reaches Limen: limen = 30', rows.get('limen') === 30, String(rows.get('limen')));
  db.calls.length = 0;
  check('each store reads its own row back', await gw.readBudget() === 4331.5 && await lm.readBudget() === 30);
  check('…by id: "global" and "limen"', db.calls.map(c => c.filters.id).join(',') === 'global,limen', JSON.stringify(db.calls));
  check('store reports its budget id', gw.budgetId === 'global' && lm.budgetId === 'limen');
}

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll demo-branding assertions passed.');
process.exitCode = failed ? 1 : 0;   // let the loop drain (process.exit here aborts in libuv on Windows)
