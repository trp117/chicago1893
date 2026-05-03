import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.resolve(__dirname, '../data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), 'utf8'));
}

// SUPABASE: replace body here
export function getScenario() {
  return readJson('scenario.json');
}

// SUPABASE: replace body here
export function getPlayerRoles() {
  return getScenario().playerRoleOptions;
}

// SUPABASE: replace body here
export function getNPCs() {
  return readJson('npcs.json');
}

// SUPABASE: replace body here
export function getNPC(id) {
  return getNPCs().find(n => n.id === id) ?? null;
}

// SUPABASE: replace body here
export function getLocations() {
  return readJson('locations.json');
}

// SUPABASE: replace body here
export function getLocation(id) {
  return getLocations().find(l => l.id === id) ?? null;
}

// SUPABASE: replace body here
export function getClues() {
  return readJson('clues.json');
}

// SUPABASE: replace body here
export function saveSession(sessionId, sessionData) {
  if (!sessionData.npc_states) {
    const npcs = getNPCs();
    sessionData = {
      ...sessionData,
      npc_states: Object.fromEntries(npcs.map(npc => [npc.id, {
        trust_level:       5,
        knows:             [],
        wants:             npc.privateGoal,
        hiding:            npc.secrets?.[0] || null,
        aggression_mode:   'neutral',
        last_interaction:  null,
        trust_logic:       npc.trustLogic,
        aggression_profile: npc.aggressionProfile,
      }])),
    };
  }
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${sessionId}.json`),
    JSON.stringify(sessionData, null, 2),
    'utf8'
  );
  return sessionData;
}

// SUPABASE: replace body here
export function getSession(sessionId) {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// SUPABASE: replace body here
export function updateSession(sessionId, patch) {
  const existing = getSession(sessionId) || {};
  const updated  = { ...existing, ...patch };
  saveSession(sessionId, updated);
  return updated;
}
