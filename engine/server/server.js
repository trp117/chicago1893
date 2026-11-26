import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

import { DualWriteStore }       from '../../lib/DualWriteStore.js';
import { restoreFromSupabase, getRestoredCounts } from '../../lib/restoreFromSupabase.js';
import { CharacterRepository }  from '../repositories/CharacterRepository.js';
import { LocationRepository }   from '../repositories/LocationRepository.js';
import { ClueRepository }       from '../repositories/ClueRepository.js';
import { ScenarioRepository }   from '../repositories/ScenarioRepository.js';
import { StoryArcRepository }   from '../repositories/StoryArcRepository.js';
import { PlayerRepository }     from '../repositories/PlayerRepository.js';
import { SessionRepository }    from '../repositories/SessionRepository.js';
import { createAdminRouter }    from '../admin/adminRouter.js';
import { createGameRouter, coldOpenFingerprintFor } from './gameRouter.js';
import { stripUnverifiedFromJson } from '../services/UnverifiedTag.js';
import { SchemaValidator }      from '../services/SchemaValidator.js';
import { checkSupabaseConnection, isSupabaseConnected, supabaseAuth, supabase as supabaseService } from '../../lib/supabase.js';
import { SupabaseSessionStore } from '../../lib/SupabaseSessionStore.js';
import { CLOSURE_BEATS_ENABLED, DEFINING_MOMENT_ENABLED } from '../services/PromptComposer.js';
import { getScenarioVersions, restoreScenarioVersion } from '../../lib/scenarioStore.js';
import { requireAdminAuth } from '../../lib/adminAuth.js';
import { makeIsAllowedScenario, demoPageGuard, readDemoBranding, readDemoVisibleRoles } from './demoMode.js';
import { createSupabaseDemoStore, readDemoBudgetId } from './demoStore.js';
import { readDemoLimitConfig } from './demoLimits.js';
import { readColdOpenConfig, createColdOpenStore, createColdOpenRuntime, supabaseColdOpenRows, fileColdOpenRows } from './coldOpen.js';
import { readReadingLayoutConfig } from './readingLayout.js';
import { createDemoPreview } from './demoPreview.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir   = path.resolve(__dirname, '../data');
const adminDir  = path.resolve(__dirname, '../admin');
const gameDir   = path.resolve(__dirname, '../game');
const publicDir = path.resolve(__dirname, '../../public');

const store = new DualWriteStore(dataDir);
const repos = {
  characters: new CharacterRepository(store),
  locations:  new LocationRepository(store),
  clues:      new ClueRepository(store),
  scenarios:  new ScenarioRepository(store),
  storyArcs:  new StoryArcRepository(store),
  players:    new PlayerRepository(store),
  sessions:   new SessionRepository(store),
};

// DEMO_MODE (engine/server/demoMode.js) — default OFF. Read here, ahead of the app, because
// the page guard has to be mounted before express.static. Self-reported at boot, beside the
// [CLOSURE] / [DEFINING] lines, and echoed in GET /health.
const DEMO_MODE      = process.env.DEMO_MODE === 'true';
const DEMO_SCENARIOS = (process.env.DEMO_SCENARIOS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAllowedScenario = makeIsAllowedScenario({ demoMode: DEMO_MODE, demoScenarios: DEMO_SCENARIOS });
console.log(`[DEMO] mode ${DEMO_MODE ? 'ENABLED' : 'disabled'}${DEMO_MODE ? ` scenarios=${DEMO_SCENARIOS.join(',') || '(none)'}` : ''}`);
if (DEMO_MODE && !DEMO_SCENARIOS.length) console.warn('[DEMO] DEMO_MODE is on but DEMO_SCENARIOS is empty — every scenario will be refused.');
// DEMO_VISIBLE_ROLES (demoMode.js) — read only in demo mode; unset or empty = every role.
const DEMO_VISIBLE_ROLES = DEMO_MODE ? readDemoVisibleRoles(process.env) : {};
const HAS_VISIBLE_ROLES  = Object.keys(DEMO_VISIBLE_ROLES).length > 0;
if (HAS_VISIBLE_ROLES) console.log(`[DEMO] visible roles ${Object.entries(DEMO_VISIBLE_ROLES).map(([s, rs]) => rs.map(r => `${s}/${r}`).join(',')).join(',')} (scenarios not listed: every role)`);
// Which demo this is: its landing branding and its own spend-counter row. Read only in demo
// mode; every default is Grey Witness's, so an unset deployment is the Grey Witness demo.
const DEMO_BRANDING  = DEMO_MODE ? readDemoBranding() : null;
const DEMO_BUDGET_ID = DEMO_MODE ? readDemoBudgetId() : null;
if (DEMO_MODE) console.log(`[DEMO] site "${DEMO_BRANDING.siteName}" ${DEMO_BRANDING.siteUrl} og=${DEMO_BRANDING.ogImageFile} budget=${DEMO_BUDGET_ID}`);
// Phase 2 store (spend counter, transcripts, landing page views). Built only in demo mode —
// with the flag off no demo table is ever touched.
const DEMO_STORE = DEMO_MODE ? createSupabaseDemoStore(supabaseService, { budgetId: DEMO_BUDGET_ID }) : null;
// DEMO_COLD_OPEN (coldOpen.js) — default OFF, and inert without DEMO_MODE. Built only when on:
// otherwise nothing is constructed, no route is added and no boot line is printed.
const COLD_OPEN_CONFIG = readColdOpenConfig(process.env, { demoMode: DEMO_MODE, demoScenarios: DEMO_SCENARIOS, visibleRoles: DEMO_VISIBLE_ROLES });
const COLD_OPEN = COLD_OPEN_CONFIG.enabled ? createColdOpenRuntime({
  config: COLD_OPEN_CONFIG,
  store:  createColdOpenStore({ fetchRows: COLD_OPEN_CONFIG.file ? fileColdOpenRows(COLD_OPEN_CONFIG.file) : supabaseColdOpenRows(supabaseService) }),
  fingerprintFor: (scenarioId, roleId, state) => coldOpenFingerprintFor(repos, scenarioId, roleId, state),
}) : null;
// DEMO_READING_LAYOUT (readingLayout.js) — default OFF, inert without DEMO_MODE. Layout only.
const READING_LAYOUT = readReadingLayoutConfig(process.env, { demoMode: DEMO_MODE }).enabled;
if (READING_LAYOUT) console.log('[READING-LAYOUT] enabled — /game and the cold open use the reading column + cast rail');
if (COLD_OPEN) {
  console.log(`[COLD-OPEN] enabled featured=${COLD_OPEN_CONFIG.featuredScenario || '(none)'}/${COLD_OPEN_CONFIG.featuredRole || '(none)'} source=${COLD_OPEN_CONFIG.file ? 'file' : 'supabase'}`);
  if (COLD_OPEN_CONFIG.entryProblem) console.warn(`[COLD-OPEN] entry unavailable, / serves the card landing: ${COLD_OPEN_CONFIG.entryProblem}`);
}

const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
// DEMO_PREVIEW_KEY (demoPreview.js) — a private tester bypass of the daily cap only. Null
// (nothing mounted) unless DEMO_MODE is on and the key is set.
const DEMO_PREVIEW = createDemoPreview({ demoMode: DEMO_MODE, key: process.env.DEMO_PREVIEW_KEY, secureCookie: process.env.NODE_ENV === 'production' });
if (DEMO_PREVIEW) { console.log('[DEMO] preview-key daily-cap bypass ENABLED'); app.use(DEMO_PREVIEW.middleware); }
// Mounted only in demo mode, so prod's middleware stack is exactly what it was.
if (DEMO_MODE) {
  app.use(demoPageGuard({
    gameHtmlPath: path.join(gameDir, 'index.html'),
    branding:     DEMO_BRANDING,
    onLandingView: () => DEMO_STORE.incrPageview(),
    cacheControl: 'public, max-age=300, must-revalidate',
    ...(COLD_OPEN ? { coldOpen: COLD_OPEN } : {}),
    ...(READING_LAYOUT ? { readingLayout: true } : {}),
  }));
}
app.use(express.static(publicDir, { maxAge: '5m' }));

// Sessions persist in Supabase (public.admin_sessions) so a deploy/restart no longer signs
// every admin out mid-edit — see lib/SupabaseSessionStore.js. A persistent session is only
// as stable as the secret that signs its cookie, so warn if production runs on the fallback.
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.warn('[SESSION] SESSION_SECRET is not set — cookies are signed with the built-in fallback. Set it in the environment.');
}
app.use(session({
  store: new SupabaseSessionStore({ client: supabaseService }),
  secret: process.env.SESSION_SECRET || 'ledger250-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

const gameConfig = {
  anthropicApiKey:    process.env.ANTHROPIC_API_KEY,
  elevenLabsApiKey:   process.env.ELEVENLABS_API_KEY,
  elevenLabsVoiceId:  process.env.ELEVENLABS_VOICE_ID,
  demoMode:           DEMO_MODE,
  demoScenarios:      DEMO_SCENARIOS,
  // Phase 2: the durable spend counter + demo transcripts, and the limits. Constructed only in
  // demo mode — with the flag off no demo table is ever touched.
  ...(DEMO_MODE ? { demoStore: DEMO_STORE, demoLimits: readDemoLimitConfig() } : {}),
  ...(COLD_OPEN ? { coldOpen: COLD_OPEN } : {}),
  ...(HAS_VISIBLE_ROLES ? { demoVisibleRoles: DEMO_VISIBLE_ROLES } : {}),
  ...(DEMO_PREVIEW ? { demoHasBypass: DEMO_PREVIEW.hasBypass } : {}),
};
if (DEMO_MODE) {
  const l = gameConfig.demoLimits;
  console.log(`[DEMO] limits start=$${(l.startCeilingCents / 100).toFixed(2)} hard=$${(l.hardCeilingCents / 100).toFixed(2)} starts/ip/day=${l.dailyStartsPerIp} rate=${l.globalPerMin}/min global, ${l.ipPerMin}/min per ip`);
}

app.use('/admin/api', requireAdminAuth, createAdminRouter(repos, { anthropicApiKey: process.env.ANTHROPIC_API_KEY }));
app.use('/game/api',  createGameRouter(repos, gameConfig));

// Public scenario listing — no auth required
const ERA_TAG = { war: 'World War II', 'crisis-simulation': 'Space Race', maritime: 'Maritime', 'civil-war': 'American Civil War', sail: 'Age of Sail', space: 'Space Race' };
function deriveEra(s) {
  for (const t of (s.genre || [])) if (ERA_TAG[t]) return ERA_TAG[t];
  const title = (s.title || '').toLowerCase();
  if (title.includes('titanic') || title.includes('marconi')) return 'Maritime';
  if (title.includes('apollo') || title.includes('space'))    return 'Space Race';
  const rest = (s.genre || []).filter(g => !['historical','drama','survival'].includes(g));
  return rest[0] || 'Historical';
}
const CATEGORY_MAP = {
  apollo_13_lifeboat:               'space',
  sargasso_deep_three_keys:         'space',
  dog_green_sector:                 'military',
  zero_hour_cantigny:               'military',
  greensboro_four_the_color_line:   'civil-rights',
  lightning_and_the_midnight_coach: 'underground',
  singing_wires:                    'underground',
  midnight_errand_boston:           'underground',
  titanic_final_hours:              'maritime',
  artesian_height_1892:             'industrial',
  dead_reckoning_ninth_ward:        'industrial',
  bornholmer_strasse_first_breach:  'space',
};
const CATEGORIES = {
  'faith':        { displayName: 'Faith',            order: 0, blurb: 'Belief meeting consequence, and a life turning on it. The ledger measures what conviction cost the ones who could not unsee what they had seen.' },
  'space':        { displayName: 'Space & Cold War', order: 1, blurb: 'The margin between mission success and catastrophe is measured in fractions. Every decision is made with the whole world watching — and the outcome already written.' },
  'military':     { displayName: 'Military',         order: 2, blurb: 'From the beaches of Normandy to the trenches of the Argonne. The cost was always paid by someone specific, in a moment that history recorded as a number.' },
  'civil-rights': { displayName: 'Civil Rights',     order: 3, blurb: 'Discipline in the face of violence is the hardest decision of all. The ledger measures what it cost to hold the line — physically, psychologically, and politically.' },
  'underground':  { displayName: 'Underground',      order: 4, blurb: 'Secret networks, covert dispatches, and the people who risked everything to move freedom through enemy territory. The ledger measures what secrecy cost and what betrayal would have cost more.' },
  'maritime':     { displayName: 'Maritime',         order: 5, blurb: 'On the water, the margin for error is measured in minutes. Ships and submarines, the cold calculus of survival at sea, and the decisions made when the ocean leaves no room for error.' },
  'industrial':   { displayName: 'Industrial',       order: 6, blurb: 'The infrastructure of civilization, under pressure. Engineers, workers, and the crises that tested what was built to last — when technology met its limit and decisions had to be made in the dark.' },
};
const CATEGORY_LABELS = Object.fromEntries(Object.entries(CATEGORIES).map(([k,v]) => [k, v.displayName]));

app.use(['/api/categories', '/api/stories'], stripUnverifiedFromJson);

app.get('/api/categories', async (req, res) => {
  try {
    const allRoles = repos.scenarios.findPlayerRoles();
    const rolesBy = {};
    allRoles.forEach(r => { rolesBy[r.scenarioId] = (rolesBy[r.scenarioId] || 0) + 1; });
    const scenarios = await repos.scenarios.findAll();
    const countBySlug = {};
    scenarios
      .filter(s => s.status === 'published' && (rolesBy[s.id] || 0) > 0 && isAllowedScenario(s.id))
      .forEach(s => {
        const slug = s.category || CATEGORY_MAP[s.id];
        if (slug) countBySlug[slug] = (countBySlug[slug] || 0) + 1;
      });
    const result = Object.entries(CATEGORIES)
      .sort(([,a],[,b]) => a.order - b.order)
      .map(([slug, c]) => ({ slug, displayName: c.displayName, blurb: c.blurb, order: c.order, count: countBySlug[slug] || 0 }));
    // Demo: only the categories that hold a whitelisted story. Prod keeps every category.
    res.json(DEMO_MODE ? result.filter(c => c.count > 0) : result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stories', async (req, res) => {
  try {
    const allRoles = repos.scenarios.findPlayerRoles();
    const rolesBy      = {};
    const roleNamesBy  = {};
    allRoles.forEach(r => {
      rolesBy[r.scenarioId] = (rolesBy[r.scenarioId] || 0) + 1;
      if (!roleNamesBy[r.scenarioId]) roleNamesBy[r.scenarioId] = [];
      roleNamesBy[r.scenarioId].push(r.name);
    });
    const scenarios = await repos.scenarios.findAll();
    const stories = scenarios
      .filter(s => s.status === 'published' && (rolesBy[s.id] || 0) > 0 && isAllowedScenario(s.id))
      .map(s => ({
        id:          s.id,
        title:       s.title,
        description: s.description,
        era:         CATEGORY_LABELS[s.category || CATEGORY_MAP[s.id]] || deriveEra(s),
        duration:    s.sessionTargetMinutes ? `~${s.sessionTargetMinutes} min` : null,
        category:    s.category || CATEGORY_MAP[s.id] || null,
        image_url:    s.image?.url || null,
        roles:        roleNamesBy[s.id] || [],
        cost_tracked: s.costTracked || null,
        displayOrder: s.displayOrder ?? 99,
        featured:     s.featured ?? false,
      }));
    res.json(stories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Keep-warm ping — Railway and uptime monitors hit this to prevent cold starts
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }));

// Deploy verification — answers "is prod running the commit I just pushed, with the flags
// I expect?" without a Railway dashboard login. Deliberately UNAUTHENTICATED: the whole
// point is to check it in one curl, and an auth gate would defeat that.
//
// The flags come from PromptComposer's own exported bindings, NOT a fresh read of
// process.env, so this endpoint and the [CLOSURE]/[DEFINING] boot lines can never
// disagree. supabaseConnected and restoredCounts likewise mirror the [SUPABASE] and
// [RESTORE] boot lines from the modules that print them.
//
// KEEP THIS TO OPERATIONAL FACTS ONLY. It is world-readable, so it must never carry
// env values, connection strings, keys, paths, scenario content, or session data. A SHA,
// two booleans, restore counts and an uptime are safe; anything describing configuration
// or data is not.
app.get('/health', (_, res) => {
  // Railway injects RAILWAY_GIT_COMMIT_SHA; it is absent on localhost, hence the fallback.
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown';
  const restoredCounts = getRestoredCounts();
  res.set('Cache-Control', 'no-store').json({
    commit,
    closureBeatsEnabled:   CLOSURE_BEATS_ENABLED,
    definingMomentEnabled: DEFINING_MOMENT_ENABLED,
    demoMode:              DEMO_MODE,
    demoScenarios:         DEMO_SCENARIOS,
    supabaseConnected:     isSupabaseConnected(),
    // Omitted entirely when the restore never reached its write loop, per the spec.
    ...(restoredCounts ? { restoredCounts } : {}),
    // DEMO_COLD_OPEN only: which entry / serves, and any stale rows. Absent otherwise.
    ...(COLD_OPEN ? { coldOpen: COLD_OPEN.health() } : {}),
    // DEMO_READING_LAYOUT only. Absent otherwise.
    ...(READING_LAYOUT ? { readingLayout: true } : {}),
    // DEMO_VISIBLE_ROLES only. Absent otherwise.
    ...(HAS_VISIBLE_ROLES ? { visibleRoles: DEMO_VISIBLE_ROLES } : {}),
    uptime: process.uptime(),
  });
});

const HTML_HEADERS = { headers: { 'Cache-Control': 'public, max-age=300, must-revalidate' } };

app.get('/',     (_, res) => res.sendFile(path.join(publicDir, 'index.html'), HTML_HEADERS));
app.get('/test', (_, res) => res.sendFile(path.join(publicDir, 'test.html'),  HTML_HEADERS));
app.get('/game', (_, res) => res.sendFile(path.join(gameDir,  'index.html'),   HTML_HEADERS));

app.get('/categories',  (_, res) => res.sendFile(path.join(publicDir, 'categories/index.html'),  HTML_HEADERS));
app.get('/categories/', (_, res) => res.sendFile(path.join(publicDir, 'categories/index.html'),  HTML_HEADERS));
['faith','space','military','civil-rights','underground','maritime','industrial'].forEach(slug => {
  app.get(`/categories/${slug}`,  (_, res) => res.sendFile(path.join(publicDir, `categories/${slug}/index.html`), HTML_HEADERS));
  app.get(`/categories/${slug}/`, (_, res) => res.sendFile(path.join(publicDir, `categories/${slug}/index.html`), HTML_HEADERS));
});

// ── Auth routes — public, no requireAdminAuth ──────────────────────────────

// Serve login page
app.get('/admin/login', (req, res) => {
  if (req.session && req.session.adminUser) {
    return res.redirect('/admin')
  }
  res.sendFile(path.join(publicDir, 'admin-login.html'))
});

// Handle login form submission
app.post('/admin/auth/login', async (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.json({ success: false, error: 'Email and password are required.' })
  }

  try {
    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password
    })

    if (error || !data.user) {
      console.warn(`[AUTH] Failed login attempt for ${email}`)
      return res.json({ success: false, error: 'Invalid email or password.' })
    }

    // A fresh session id at the moment of login (session-fixation hardening — it matters more
    // now that sessions persist), then an explicit save BEFORE replying: the client navigates
    // straight into the admin on success, and a login the store could not persist must fail
    // here rather than look successful and bounce at the next request.
    const redirect = req.session.returnTo || '/admin'
    const adminUser = {
      id: data.user.id,
      email: data.user.email,
      loginAt: new Date().toISOString()
    }
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()))
    req.session.adminUser = adminUser
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()))

    console.log(`[AUTH] Login: ${data.user.email}`)

    return res.json({ success: true, redirect })

  } catch (err) {
    console.error('[AUTH] Login error:', err.message)
    return res.json({ success: false, error: 'Login failed. Please try again.' })
  }
});

// Send password reset email
app.post('/admin/auth/forgot-password', async (req, res) => {
  const { email } = req.body
  if (!email) return res.json({ success: false, error: 'Email is required.' })

  const resetUrl = (process.env.PUBLIC_URL || 'http://localhost:' + (process.env.PORT || 3002)) + '/admin/reset-password'

  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: resetUrl
    })
    if (error) throw error
    console.log(`[AUTH] Password reset requested for ${email}`)
    res.json({ success: true })
  } catch (err) {
    console.error('[AUTH] Reset error:', err.message)
    res.json({ success: false, error: err.message || 'Could not send reset email.' })
  }
});

// Handle logout
app.post('/admin/auth/logout', (req, res) => {
  const email = req.session.adminUser?.email
  req.session.destroy(() => {
    console.log(`[AUTH] Logout: ${email}`)
    res.json({ success: true })
  })
});

// Password reset page — public, Supabase redirects here after reset email link
app.get('/admin/reset-password', (req, res) => {
  res.sendFile(path.join(publicDir, 'admin-reset-password.html'))
});

// Update password using Supabase recovery token (called from reset page)
app.post('/admin/auth/update-password', async (req, res) => {
  const { accessToken, password } = req.body
  if (!accessToken || !password) return res.json({ success: false, error: 'Missing token or password.' })
  try {
    const { error } = await supabaseAuth.auth.setSession({ access_token: accessToken, refresh_token: '' })
    if (error) throw error
    const { error: updateError } = await supabaseAuth.auth.updateUser({ password })
    if (updateError) throw updateError
    res.json({ success: true })
  } catch (err) {
    console.error('[AUTH] Update password error:', err.message)
    res.json({ success: false, error: 'Could not update password. The link may have expired.' })
  }
});

// Who am I — returns current logged-in user for the admin UI
app.get('/admin/auth/me', requireAdminAuth, (req, res) => {
  res.json({
    email: req.adminUser.email,
    loginAt: req.adminUser.loginAt
  })
});

// ── Protected admin routes ─────────────────────────────────────────────────

// Version history endpoints — protected, must be before /admin/* catch-all
app.get('/admin/scenario/:id/versions', requireAdminAuth, async (req, res) => {
  try {
    const versions = await getScenarioVersions(req.params.id);
    res.json(versions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/admin/scenario/:id/restore/:version', requireAdminAuth, async (req, res) => {
  try {
    const newVersion = await restoreScenarioVersion(
      req.params.id,
      parseInt(req.params.version, 10),
      { savedBy: req.adminUser.email }
    );
    res.json({ success: true, version: newVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ADMIN_HEADERS = { headers: { 'Cache-Control': 'no-store' } };
app.use('/admin', requireAdminAuth, express.static(adminDir, { maxAge: 0, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));
app.get('/admin',              requireAdminAuth, (_, res) => res.sendFile(path.join(adminDir, 'index.html'), ADMIN_HEADERS));
app.get('/admin/pipeline.html', requireAdminAuth, (_, res) => res.sendFile(path.join(adminDir, 'pipeline.html'), ADMIN_HEADERS));
app.get('/admin/*',            requireAdminAuth, (_, res) => res.sendFile(path.join(adminDir, 'index.html'), ADMIN_HEADERS));

const PORT = process.env.PORT || process.env.ENGINE_PORT || 3002;

function killPort(port) {
  try { execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' }); } catch {}
  try { execSync(`powershell -NoProfile -Command "Get-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess | Stop-Process -Force"`, { stdio: 'ignore' }); } catch {}
}

function startServer() {
  const server = app.listen(PORT, () => {
    console.log(`Engine running at http://localhost:${PORT}`);
    console.log(`  Stories: http://localhost:${PORT}/`);
    console.log(`  Admin:   http://localhost:${PORT}/admin`);
    console.log(`  Game:    http://localhost:${PORT}/game?scenarioId=YOUR_ID`);
    checkSupabaseConnection();
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} in use — killing old process and retrying…`);
      killPort(PORT);
      setTimeout(startServer, 800);
    } else {
      throw err;
    }
  });
}

(async () => {
  await restoreFromSupabase();
  new SchemaValidator(repos).report().catch(e => console.error('[SCHEMA]', e.message));
  // DEMO_COLD_OPEN only: check the featured row once content is restored, so a stale bake
  // shows in the boot log and /health before the first visitor.
  if (COLD_OPEN) COLD_OPEN.entryRow().then(row => console.log(`[COLD-OPEN] / serves ${row ? 'the cold open' : 'the card landing'}${row ? '' : ` (${COLD_OPEN.health().reason})`}`));
  startServer();
})().catch(err => {
  console.error('[STARTUP] Fatal init error:', err.message);
  process.exit(1);
});
