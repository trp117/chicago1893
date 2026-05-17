import express from 'express';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
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

dotenv.config();

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
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(publicDir, { maxAge: '5m' }));

const gameConfig = {
  anthropicApiKey:    process.env.ANTHROPIC_API_KEY,
  elevenLabsApiKey:   process.env.ELEVENLABS_API_KEY,
  elevenLabsVoiceId:  process.env.ELEVENLABS_VOICE_ID,
};

app.use('/admin/api', createAdminRouter(repos, { anthropicApiKey: process.env.ANTHROPIC_API_KEY }));
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
app.get('/api/stories', (req, res) => {
  try {
    const allRoles = repos.scenarios.findPlayerRoles();
    const rolesBy  = {};
    allRoles.forEach(r => { rolesBy[r.scenarioId] = (rolesBy[r.scenarioId] || 0) + 1; });
    const stories = repos.scenarios.findAll()
      .filter(s => s.hidden !== true && (rolesBy[s.id] || 0) > 0)
      .map(s => ({
        id:          s.id,
        title:       s.title,
        description: s.description,
        era:         deriveEra(s),
        duration:    s.sessionTargetMinutes ? `~${s.sessionTargetMinutes} min` : null,
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
app.get('/game', (_, res) => res.sendFile(path.join(gameDir,  'index.html'),   HTML_HEADERS));

app.use('/admin', express.static(adminDir, { maxAge: '5m' }));
app.get('/admin',   (_, res) => res.sendFile(path.join(adminDir, 'index.html'), HTML_HEADERS));
app.get('/admin/*', (_, res) => res.sendFile(path.join(adminDir, 'index.html'), HTML_HEADERS));

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
