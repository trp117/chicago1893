// DEMO_MODE Phase 1 — containment.
//
//   node tests/demo-mode.test.mjs
//
// Part A — THE PROD CONTRACT, as durable invariants. With DEMO_MODE unset:
//   (a) the demo page guard is not mounted — /index.html, /test, /categories and the
//       index.backup* files serve exactly as express.static / the page routes serve them;
//   (b) / is public/index.html and /game is engine/game/index.html, byte-for-byte, with no
//       demo injection;
//   (c) /api/stories, /api/categories and /game/api/scenarios apply no demo filter — each
//       matches the unfiltered rule computed here from the same content;
//   (d) /game/api/config is { demoMode: false };
//   (e) /tts is not demo-refused (it answers its own 400 / 503).
// (The one-time byte comparison against the pre-DEMO prod commit 7c44706 was run before this
// landed: 30 routes identical. It is not repeated here — a pinned baseline would fail on every
// later change to those routes.)
//
// Part B — the demo itself, with DEMO_MODE=true and the four vetted scenarios, and none of the
// per-demo env set: the landing is the frozen Grey Witness landing byte-for-byte and the budget
// row is 'global'.
//
// Part C — a second demo from the same code: DEMO_SITE_* / DEMO_OG_IMAGE_FILE / DEMO_BUDGET_ID
// name Project Limen, DEMO_SCENARIOS a different whitelist.
//
// No model or ElevenLabs calls: every request either fails validation, is refused, or is
// a read. ELEVENLABS_API_KEY is blanked so /tts can never reach ElevenLabs, and Langfuse is
// off. Needs Supabase credentials (the servers restore content on boot) — skips without them.
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENV_FILE = path.join(ROOT, '.env');
const DEMO_IDS = ['tolle_lege_milan_386', 'ignatius_loyola_1521', 'steel_curtain_cantigny', 'dog_green_sector'];
// The category pages server.js routes (and CATEGORIES defines) — every one is listed flag-off.
const CATEGORY_SLUGS = ['faith', 'space', 'military', 'civil-rights', 'underground', 'maritime', 'industrial'];

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
  if (!ok) failed++;
};

if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
if (!process.env.SUPABASE_URL) {
  console.log('SKIP  demo-mode.test — no Supabase credentials (the servers restore content on boot).');
  process.exit(0);
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

// Boots engine/server/server.js on a free port. A free port matters: server.js kills
// whatever holds its port on EADDRINUSE.
async function boot(label, cwd, extraEnv) {
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

async function call(base, method, url, body) {
  const resp = await fetch(base + url, {
    method, redirect: 'manual',
    // A bot user agent, so the demo servers booted here (real Supabase) never add test hits
    // to the live demo_pageviews tally. Counting itself is tested in demo-pageviews.test.
    headers: { 'User-Agent': 'demo-mode-test-bot', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: resp.status,
    type: resp.headers.get('content-type'),
    location: resp.headers.get('location'),
    body: Buffer.from(await resp.arrayBuffer()),
  };
}
const file = rel => fs.readFileSync(path.join(ROOT, rel));

const servers = [];
try {
  // ── Part A: flag off — the prod contract ──────────────────────────────────
  console.log('\nPart A — DEMO_MODE unset: no demo behaviour anywhere');
  const prod = await boot('flag-off', ROOT, { DEMO_MODE: undefined, DEMO_SCENARIOS: undefined });
  servers.push(prod);
  const pget  = url => call(prod.base, 'GET', url);
  const ppost = (url, body) => call(prod.base, 'POST', url, body);
  const pjson = r => JSON.parse(r.body.toString());

  check('boot log says [DEMO] mode disabled', prod.log().includes('[DEMO] mode disabled'));
  check('Phase 2: no demo limits/store built (no [DEMO] limits line, no [DEMO BUDGET] / [DEMO LIMIT] activity)',
    !['[DEMO BUDGET]', '[DEMO LIMIT]', '[DEMO TRANSCRIPT]', '[DEMO] limits', '[DEMO PAGEVIEW]', '[DEMO] site'].some(tag => prod.log().includes(tag)));

  // (a) guard not mounted: every path it would intercept reaches the normal handlers.
  {
    const ix = await pget('/index.html');
    check('(a) /index.html serves public/index.html (not redirected)', ix.status === 200 && ix.body.equals(file('public/index.html')), `${ix.status} ${ix.location ?? ''}`);
    for (const [url, rel] of [['/test', 'public/test.html'], ['/test.html', 'public/test.html'], ['/index.backup.html', 'public/index.backup.html'],
                              ['/categories/', 'public/categories/index.html'], ['/categories/faith/', 'public/categories/faith/index.html']]) {
      const r = await pget(url);
      check(`(a) ${url} serves ${rel}`, r.status === 200 && r.body.equals(file(rel)), `${r.status} ${r.location ?? ''}`);
    }
    const c = await pget('/categories');
    check('(a) /categories is the static directory redirect, not the demo redirect to /', c.status === 301 && c.location === '/categories/', `${c.status} ${c.location}`);
    // The admin surface is untouched in prod.
    const login = await pget('/admin/login');
    check('(a) /admin/login still serves the admin login page', login.status === 200 && /html/.test(login.type || ''), `${login.status}`);
    check('(a) /admin-login.html still serves', (await pget('/admin-login.html')).status === 200);
    check('(a) /og-image.png does not exist in prod (404)', (await pget('/og-image.png')).status === 404);
    const unauth = await pget('/admin/api/scenarios');
    check('(a) /admin/api answers its own auth gate (not a demo 404)', unauth.status !== 404 && unauth.status >= 300, `${unauth.status}`);
  }

  // (b) the pages, byte-for-byte, no injection.
  {
    const r = await pget('/');
    check('(b) / is public/index.html byte-for-byte', r.status === 200 && r.body.equals(file('public/index.html')));
    for (const url of ['/game', '/game?scenarioId=steel_curtain_cantigny']) {
      const g = await pget(url);
      check(`(b) ${url} is engine/game/index.html byte-for-byte, no demo injection`,
        g.status === 200 && g.body.equals(file('engine/game/index.html')) && !g.body.toString().includes('id="demo-mode"'));
    }
  }

  // (c) no demo filter: each listing matches its unfiltered rule over the same content.
  {
    const { listScenarios } = await import(pathToFileURL(path.join(ROOT, 'lib/scenarioStore.js')).href);
    const published = (await listScenarios()).filter(s => s.status === 'published').map(s => s.id);
    const listed = pjson(await pget('/game/api/scenarios')).map(s => s.id);
    check(`(c) /game/api/scenarios lists every published scenario (${published.length})`,
      JSON.stringify([...listed].sort()) === JSON.stringify([...published].sort()), `listed ${listed.length}, published ${published.length}`);

    // /api/stories: published AND has a player role. Roles are read from the disk the server
    // just restored — the same store its handler reads.
    const rolesDir = path.join(ROOT, 'engine/data/scenarios/player_roles');
    const withRoles = new Set(fs.readdirSync(rolesDir).filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(rolesDir, f), 'utf8')).scenarioId; } catch { return null; } }));
    const expectStories = published.filter(id => withRoles.has(id)).sort();
    const stories = pjson(await pget('/api/stories'));
    const storyIds = stories.map(s => s.id).sort();
    check(`(c) /api/stories lists every published scenario with roles (${expectStories.length}), not just the demo four`,
      JSON.stringify(storyIds) === JSON.stringify(expectStories) && storyIds.some(id => !DEMO_IDS.includes(id)),
      `got ${storyIds.join(',')} | expected ${expectStories.join(',')}`);

    const cats = pjson(await pget('/api/categories'));
    check('(c) /api/categories lists every category, empty ones included',
      JSON.stringify(cats.map(c => c.slug).sort()) === JSON.stringify([...CATEGORY_SLUGS].sort()), cats.map(c => `${c.slug}:${c.count}`).join(','));
    const counted = cats.reduce((n, c) => n + c.count, 0);
    const categorised = stories.filter(s => s.category && CATEGORY_SLUGS.includes(s.category)).length;
    check('(c) /api/categories counts every categorised story (no whitelist in the count)', counted === categorised, `counted ${counted}, stories with a category ${categorised}`);
  }

  // (d) config.
  {
    const c = await pget('/game/api/config');
    check('(d) /game/api/config is { demoMode: false }', c.status === 200 && c.body.toString() === '{"demoMode":false}', c.body.toString());
    const h = pjson(await pget('/health'));
    check('(d) /health reports demoMode false, no scenarios', h.demoMode === false && Array.isArray(h.demoScenarios) && h.demoScenarios.length === 0, JSON.stringify(h));
  }

  // (e) /tts answers its own validation, never the demo refusal. (No ElevenLabs key here.)
  {
    const empty = await ppost('/game/api/tts', {});
    check('(e) /tts with no text → its own 400, not 403', empty.status === 400 && pjson(empty).error === 'Missing text.', `${empty.status} ${empty.body}`);
    const t = await ppost('/game/api/tts', { text: 'A test line.' });
    check('(e) /tts with text → 503 TTS not configured, not 403', t.status === 503 && pjson(t).error === 'TTS not configured.', `${t.status} ${t.body}`);
  }

  // The scenario routes accept a non-demo scenario (no whitelist 404).
  check('flag off: bootstrap of a non-demo published scenario → 200', (await pget('/game/api/bootstrap?scenarioId=apollo_13_lifeboat')).status === 200);
  check('flag off: notes for a non-demo scenario → 200', (await ppost('/game/api/notes', { state: { scenarioId: 'apollo_13_lifeboat', discoveredClueIds: [], introducedNpcs: [], visitedLocations: [] } })).status === 200);
  for (const s of servers.splice(0)) s.stop();

  // ── Part B: the demo ───────────────────────────────────────────────────────
  console.log(`\nPart B — DEMO_MODE=true, DEMO_SCENARIOS=${DEMO_IDS.join(',')}`);
  const demo = await boot('demo', ROOT, { DEMO_MODE: 'true', DEMO_SCENARIOS: DEMO_IDS.join(', ') });
  servers.push(demo);
  const get  = url => call(demo.base, 'GET', url);
  const post = (url, body) => call(demo.base, 'POST', url, body);
  const json = r => JSON.parse(r.body.toString());

  check('boot log names the whitelist', demo.log().includes(`[DEMO] mode ENABLED scenarios=${DEMO_IDS.join(',')}`));
  check('boot log: Grey Witness branding and budget row "global" by default',
    demo.log().includes('[DEMO] site "Grey Witness" https://greywitness.com og=greywitness-og.png budget=global'));
  check('boot log states the Phase 2 limits (defaults)', demo.log().includes('[DEMO] limits start=$90.00 hard=$98.00 starts/ip/day=2 rate=30/min global, 6/min per ip'));
  {
    const xf = await post('/game/api/extract-facts', { narrative: 'You saw the forged order.', existingFacts: [] });
    check('/extract-facts is off in demo ({ newFacts: [] }, no model call)', xf.status === 200 && xf.body.toString() === '{"newFacts":[]}');
  }
  {
    const h = json(await get('/health'));
    check('/health reports demoMode true and the four ids', h.demoMode === true && JSON.stringify(h.demoScenarios) === JSON.stringify(DEMO_IDS), JSON.stringify(h));
    check('/game/api/config is { demoMode: true }', (await get('/game/api/config')).body.toString() === '{"demoMode":true}');
  }

  // 5 — landing + branding
  {
    const r = await get('/');
    const html = r.body.toString();
    const head = html.slice(0, html.indexOf('</head>'));
    check('/ serves the demo landing (200, html)', r.status === 200 && /text\/html/.test(r.type));
    check('/ with no per-demo env is the frozen Grey Witness landing byte-for-byte', r.body.equals(file('tests/fixtures/greywitness-landing.html')));
    check('/ <title> and og tags say Grey Witness / greywitness.com', /<title>Grey Witness<\/title>/.test(head)
      && /property="og:title" content="Grey Witness"/.test(head) && /property="og:url" content="https:\/\/greywitness\.com"/.test(head));
    check('/ carries no "Ledger 250" or "ledger250" anywhere', !/ledger\s*250/i.test(html));
    check('/ has the preview line', html.includes('This is a preview — interactions may be reviewed to improve it.'));
    check('/ has no Apollo hero, no categories nav', !/apollo/i.test(html) && !html.includes('/categories'));
    check('/ builds cards from /api/stories', html.includes("fetch('/api/stories')"));
    // Link-preview card.
    for (const tag of [
      '<meta property="og:image" content="https://greywitness.com/og-image.png">',
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      '<meta property="og:image:alt" content="Grey Witness — interactive historical fiction">',
      '<meta name="twitter:card" content="summary_large_image">',
      '<meta name="twitter:image" content="https://greywitness.com/og-image.png">',
    ]) check(`/ <head> has ${tag.slice(6, tag.indexOf(' content='))}`, head.includes(tag));
    check('/ <head> keeps one og:type, og:title, og:description, og:url, twitter:title, twitter:description',
      ['property="og:type"', 'property="og:title"', 'property="og:description"', 'property="og:url"', 'name="twitter:title"', 'name="twitter:description"', 'name="twitter:card"']
        .every(a => head.split(a).length === 2));
    const og = await get('/og-image.png');
    check('/og-image.png → 200 image/png, the 1200×630 card byte-for-byte', og.status === 200 && og.type === 'image/png'
      && og.body.equals(file('engine/demo/greywitness-og.png')) && og.body.readUInt32BE(16) === 1200 && og.body.readUInt32BE(20) === 630, `${og.status} ${og.type} ${og.body.length}B`);
  }

  // 2 — whitelist
  {
    const stories = json(await get('/api/stories'));
    const ids = stories.map(s => s.id).sort();
    check('/api/stories returns exactly the four whitelisted stories', JSON.stringify(ids) === JSON.stringify([...DEMO_IDS].sort()), ids.join(','));
    const cats = json(await get('/api/categories'));
    check('/api/categories lists only categories holding a whitelisted story', cats.length > 0 && cats.every(c => c.count > 0), JSON.stringify(cats.map(c => [c.slug, c.count])));
    const listed = json(await get('/game/api/scenarios')).map(s => s.id);
    check('/game/api/scenarios lists only whitelisted ids', listed.length > 0 && listed.every(id => DEMO_IDS.includes(id)), listed.join(','));

    check('bootstrap: whitelisted scenario → 200', (await get('/game/api/bootstrap?scenarioId=steel_curtain_cantigny')).status === 200);
    check('bootstrap: other published scenario → 404', (await get('/game/api/bootstrap?scenarioId=apollo_13_lifeboat')).status === 404);
    check('start: other scenario → 404', (await post('/game/api/start', { scenarioId: 'apollo_13_lifeboat', roleId: 'any' })).status === 404);
    check('turn: other scenario → 404', (await post('/game/api/turn', { state: { scenarioId: 'apollo_13_lifeboat' }, playerInput: 'x' })).status === 404);
    check('notes: other scenario → 404', (await post('/game/api/notes', { state: { scenarioId: 'apollo_13_lifeboat' } })).status === 404);
    check('notes: whitelisted scenario → 200', (await post('/game/api/notes', { state: { scenarioId: 'steel_curtain_cantigny', discoveredClueIds: [], introducedNpcs: [], visitedLocations: [] } })).status === 200);

    // closing-prose: guarded by the session's own scenario, read from its transcript.
    const tdir = path.join(ROOT, 'engine/data/transcripts');
    fs.mkdirSync(tdir, { recursive: true });
    const other = 'demo-test-other-scenario', bare = 'demo-test-no-scenario';
    fs.writeFileSync(path.join(tdir, `${other}.md`), '# x\n## Scenario: apollo_13_lifeboat\n## Session: x\n\n**Player:** hi\n');
    fs.writeFileSync(path.join(tdir, `${bare}.md`), '# x\n\n**Player:** hi\n');
    try {
      check('closing-prose: transcript of another scenario → 404', (await get(`/game/api/closing-prose?sessionId=${other}`)).status === 404);
      check('closing-prose: scenario cannot be resolved → 404', (await get(`/game/api/closing-prose?sessionId=${bare}`)).status === 404);
    } finally {
      fs.rmSync(path.join(tdir, `${other}.md`), { force: true });
      fs.rmSync(path.join(tdir, `${bare}.md`), { force: true });
    }
  }

  // 3 — audio
  {
    const t = await post('/game/api/tts', { text: 'A test line.' });
    check('tts → 403 disabled', t.status === 403 && json(t).error === 'Audio is disabled.', `${t.status} ${t.body}`);
    const g = await get('/game?scenarioId=steel_curtain_cantigny');
    const { injectDemoIntoGameHtml } = await import(pathToFileURL(path.join(ROOT, 'engine/server/demoMode.js')).href);
    const file = fs.readFileSync(path.join(ROOT, 'engine/game/index.html'), 'utf8');
    const html = g.body.toString();
    check('/game is the game page plus the demo injection, nothing else', g.status === 200 && html === injectDemoIntoGameHtml(file));
    check('/game hides the intro Listen button', /\.intro-listen-btn \{ display: none !important; \}|\.intro-listen-btn\s*\{\s*display:\s*none\s*!important/.test(html.slice(0, html.indexOf('</head>'))));
    check('/game silences the speech-synthesis fallback before page scripts', html.indexOf('window.speechSynthesis.speak = function () {}') > -1
      && html.indexOf('window.speechSynthesis.speak = function () {}') < html.indexOf('const synth = window.speechSynthesis'));
  }

  // 4 — leak surfaces
  for (const url of ['/categories', '/categories/', '/categories/faith', '/categories/military/', '/index.html']) {
    const r = await get(url);
    check(`${url} → redirect to /`, r.status === 302 && r.location === '/', `${r.status} ${r.location}`);
  }
  for (const url of ['/test', '/test.html', '/index.backup.html', '/index.backup-ux.html', '/index_backup.html']) {
    check(`${url} → 404`, (await get(url)).status === 404);
  }
  check('other static files still serve (/js/scenario-card.js)', (await get('/js/scenario-card.js')).status === 200);

  // The admin surface is not reachable on the demo domain — any path, any method.
  for (const url of ['/admin', '/admin/', '/admin/login', '/admin/reset-password', '/admin/pipeline.html', '/admin/api/scenarios', '/admin/auth/me', '/admin-login.html', '/admin-reset-password.html']) {
    check(`GET ${url} → 404`, (await get(url)).status === 404);
  }
  for (const url of ['/admin/auth/login', '/admin/auth/forgot-password', '/admin/api/scenarios']) {
    check(`POST ${url} → 404`, (await post(url, { email: 'x@example.com', password: 'x' })).status === 404);
  }
  // Every request above carried the bot user agent, so no page view was counted. (Had one been
  // attempted against a database without the table, it would have logged [DEMO PAGEVIEW].)
  await new Promise(r => setTimeout(r, 300));
  check('test traffic (bot UA) attempted no page-view count', !demo.log().includes('[DEMO PAGEVIEW]'));
  for (const s of servers.splice(0)) s.stop();

  // ── Part C: a second, independently branded demo ─────────────────────────
  const LIMEN_IDS = ['ignatius_loyola_1521', 'tolle_lege_milan_386'];
  console.log(`\nPart C — Project Limen: DEMO_SCENARIOS=${LIMEN_IDS.join(',')}, own branding, budget row "limen"`);
  const limen = await boot('limen', ROOT, {
    DEMO_MODE: 'true', DEMO_SCENARIOS: LIMEN_IDS.join(','),
    DEMO_SITE_NAME: 'Project Limen', DEMO_SITE_URL: 'https://projectlimen.com',
    DEMO_SITE_TAGLINE: 'Cross the threshold of a turning point in history.',
    DEMO_OG_IMAGE_FILE: 'projectlimen-og.png', DEMO_BUDGET_ID: 'limen',
  });
  servers.push(limen);
  {
    const lget = url => call(limen.base, 'GET', url);
    check('boot log: Limen branding and budget row "limen"',
      limen.log().includes('[DEMO] site "Project Limen" https://projectlimen.com og=projectlimen-og.png budget=limen'));
    const r = await lget('/');
    const html = r.body.toString();
    const head = html.slice(0, html.indexOf('</head>'));
    check('/ names Project Limen: title, og:title, twitter:title, h1', r.status === 200 && head.includes('<title>Project Limen</title>')
      && head.includes('<meta property="og:title" content="Project Limen">') && head.includes('<meta name="twitter:title" content="Project Limen">')
      && html.includes('<h1 class="brand">Project Limen</h1>'));
    check('/ tagline is visible and in og/twitter descriptions', html.includes('<p class="lede">Cross the threshold of a turning point in history.</p>')
      && head.includes('<meta property="og:description" content="Cross the threshold of a turning point in history.">')
      && head.includes('<meta name="twitter:description" content="Cross the threshold of a turning point in history.">'));
    check('/ og:url, og:image, twitter:image, canonical on projectlimen.com', head.includes('<meta property="og:url" content="https://projectlimen.com">')
      && head.includes('<meta property="og:image" content="https://projectlimen.com/og-image.png">')
      && head.includes('<meta name="twitter:image" content="https://projectlimen.com/og-image.png">')
      && head.includes('<link rel="canonical" href="https://projectlimen.com">'));
    check('/ carries no Grey Witness / greywitness and no Ledger 250', !/grey ?witness/i.test(html) && !/ledger\s*250/i.test(html));
    const og = await lget('/og-image.png');
    check('/og-image.png → projectlimen-og.png byte-for-byte (image/png)', og.status === 200 && og.type === 'image/png'
      && og.body.equals(file('engine/demo/projectlimen-og.png')), `${og.status} ${og.type} ${og.body.length}B`);
    const ids = JSON.parse((await lget('/api/stories')).body.toString()).map(s => s.id).sort();
    check("/api/stories is filtered by this demo's DEMO_SCENARIOS", JSON.stringify(ids) === JSON.stringify([...LIMEN_IDS].sort()), ids.join(','));
    check('bootstrap: a scenario outside this whitelist is refused (404)', (await lget('/game/api/bootstrap?scenarioId=steel_curtain_cantigny')).status === 404);
    check('/game still carries the demo injection', (await lget('/game')).body.toString().includes('id="demo-mode"'));
    await new Promise(r => setTimeout(r, 300));
    check('test traffic (bot UA) attempted no page-view count', !limen.log().includes('[DEMO PAGEVIEW]'));
  }
} catch (err) {
  console.error(`\nERROR  ${err.message}`);
  failed++;
} finally {
  for (const s of servers) s.stop();
}

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll demo-mode assertions passed.');
process.exit(failed ? 1 : 0);
