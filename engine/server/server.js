import express from 'express';
import cors from 'cors';
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

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir   = path.resolve(__dirname, '../data');
const adminDir  = path.resolve(__dirname, '../admin');
const gameDir   = path.resolve(__dirname, '../game');

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
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const gameConfig = {
  anthropicApiKey:    process.env.ANTHROPIC_API_KEY,
  elevenLabsApiKey:   process.env.ELEVENLABS_API_KEY,
  elevenLabsVoiceId:  process.env.ELEVENLABS_VOICE_ID,
};

app.use('/admin/api', createAdminRouter(repos, { anthropicApiKey: process.env.ANTHROPIC_API_KEY }));
app.use('/game/api',  createGameRouter(repos, gameConfig));

app.get('/',     (_, res) => res.sendFile(path.join(gameDir, 'landing.html')));
app.get('/game', (_, res) => res.sendFile(path.join(gameDir, 'index.html')));

app.use('/admin', express.static(adminDir));
app.get('/admin', (_, res) => res.sendFile(path.join(adminDir, 'index.html')));
app.get('/admin/*', (_, res) => res.sendFile(path.join(adminDir, 'index.html')));

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
