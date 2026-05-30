import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

import { JsonFileStore }        from '../repositories/JsonFileStore.js';
import { CharacterRepository }  from '../repositories/CharacterRepository.js';
import { LocationRepository }   from '../repositories/LocationRepository.js';
import { ClueRepository }       from '../repositories/ClueRepository.js';
import { ScenarioRepository }   from '../repositories/ScenarioRepository.js';
import { StoryArcRepository }   from '../repositories/StoryArcRepository.js';
import { PlayerRepository }     from '../repositories/PlayerRepository.js';
import { SessionRepository }    from '../repositories/SessionRepository.js';
import { createAdminRouter }    from '../admin/adminRouter.js';
import { createGameRouter }     from './gameRouter.js';
import { SchemaValidator }      from '../services/SchemaValidator.js';
import { checkSupabaseConnection, supabaseAuth } from '../../lib/supabase.js';
import { getScenarioVersions, restoreScenarioVersion } from '../../lib/scenarioStore.js';
import { requireAdminAuth } from '../../lib/adminAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir   = path.resolve(__dirname, '../data');
const adminDir  = path.resolve(__dirname, '../admin');
const gameDir   = path.resolve(__dirname, '../game');
const publicDir = path.resolve(__dirname, '../../public');

const store = new JsonFileStore(dataDir);
const repos = {
  characters: new CharacterRepository(store),
  locations:  new LocationRepository(store),
  clues:      new ClueRepository(store),
  scenarios:  new ScenarioRepository(store),
  storyArcs:  new StoryArcRepository(store),
  players:    new PlayerRepository(store),
  sessions:   new SessionRepository(store),
};

const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(publicDir, { maxAge: '5m' }));

app.use(session({
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
};

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
  bornholmer_strasse_first_breach:  'space',
};
const CATEGORIES = {
  'space':        { displayName: 'Space & Cold War', order: 1, blurb: 'The margin between mission success and catastrophe is measured in fractions. Every decision is made with the whole world watching — and the outcome already written.' },
  'military':     { displayName: 'Military',         order: 2, blurb: 'From the beaches of Normandy to the trenches of the Argonne. The cost was always paid by someone specific, in a moment that history recorded as a number.' },
  'civil-rights': { displayName: 'Civil Rights',     order: 3, blurb: 'Discipline in the face of violence is the hardest decision of all. The ledger measures what it cost to hold the line — physically, psychologically, and politically.' },
  'underground':  { displayName: 'Underground',      order: 4, blurb: 'Secret networks, covert dispatches, and the people who risked everything to move freedom through enemy territory. The ledger measures what secrecy cost and what betrayal would have cost more.' },
  'maritime':     { displayName: 'Maritime',         order: 5, blurb: 'On the water, the margin for error is measured in minutes. Ships and submarines, the cold calculus of survival at sea, and the decisions made when the ocean leaves no room for error.' },
  'industrial':   { displayName: 'Industrial',       order: 6, blurb: 'The infrastructure of civilization, under pressure. Engineers, workers, and the crises that tested what was built to last — when technology met its limit and decisions had to be made in the dark.' },
};
const CATEGORY_LABELS = Object.fromEntries(Object.entries(CATEGORIES).map(([k,v]) => [k, v.displayName]));

app.get('/api/categories', async (req, res) => {
  try {
    const allRoles = repos.scenarios.findPlayerRoles();
    const rolesBy = {};
    allRoles.forEach(r => { rolesBy[r.scenarioId] = (rolesBy[r.scenarioId] || 0) + 1; });
    const scenarios = await repos.scenarios.findAll();
    const countBySlug = {};
    scenarios
      .filter(s => s.status === 'published' && (rolesBy[s.id] || 0) > 0)
      .forEach(s => {
        const slug = CATEGORY_MAP[s.id];
        if (slug) countBySlug[slug] = (countBySlug[slug] || 0) + 1;
      });
    const result = Object.entries(CATEGORIES)
      .sort(([,a],[,b]) => a.order - b.order)
      .map(([slug, c]) => ({ slug, displayName: c.displayName, blurb: c.blurb, order: c.order, count: countBySlug[slug] || 0 }));
    res.json(result);
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
      .filter(s => s.status === 'published' && (rolesBy[s.id] || 0) > 0)
      .map(s => ({
        id:          s.id,
        title:       s.title,
        description: s.description,
        era:         CATEGORY_LABELS[CATEGORY_MAP[s.id]] || deriveEra(s),
        duration:    s.sessionTargetMinutes ? `~${s.sessionTargetMinutes} min` : null,
        category:    CATEGORY_MAP[s.id] || null,
        image_url:   s.image?.url || null,
        roles:       roleNamesBy[s.id] || [],
        cost_tracked: s.costTracked || null,
      }));
    res.json(stories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Keep-warm ping — Railway and uptime monitors hit this to prevent cold starts
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }));

const HTML_HEADERS = { headers: { 'Cache-Control': 'public, max-age=300, must-revalidate' } };

app.get('/',     (_, res) => res.sendFile(path.join(publicDir, 'index.html'), HTML_HEADERS));
app.get('/test', (_, res) => res.sendFile(path.join(publicDir, 'test.html'),  HTML_HEADERS));
app.get('/game', (_, res) => res.sendFile(path.join(gameDir,  'index.html'),   HTML_HEADERS));

app.get('/categories',  (_, res) => res.sendFile(path.join(publicDir, 'categories/index.html'),  HTML_HEADERS));
app.get('/categories/', (_, res) => res.sendFile(path.join(publicDir, 'categories/index.html'),  HTML_HEADERS));
['space','military','civil-rights','underground','maritime','industrial'].forEach(slug => {
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

    req.session.adminUser = {
      id: data.user.id,
      email: data.user.email,
      loginAt: new Date().toISOString()
    }

    console.log(`[AUTH] Login: ${data.user.email}`)

    const redirect = req.session.returnTo || '/admin'
    delete req.session.returnTo

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

new SchemaValidator(repos).report();

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

startServer();
