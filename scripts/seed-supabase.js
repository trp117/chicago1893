#!/usr/bin/env node
// One-time seed: read all entity files from disk and upsert into scenario_data.
// Run once after deploying the DualWriteStore change to populate Supabase
// from the current disk state.
//
//   node scripts/seed-supabase.js
//
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from '../lib/supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.resolve(__dirname, '../engine/data');

function readDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .flatMap(f => {
      try { return [JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]; }
      catch { return []; }
    });
}

function readDirRecursive(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  return fs.readdirSync(baseDir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return readDir(path.join(baseDir, entry.name));
    if (entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
      try { return [JSON.parse(fs.readFileSync(path.join(baseDir, entry.name), 'utf8'))]; }
      catch { return []; }
    }
    return [];
  });
}

async function upsertBatch(rows) {
  const SIZE = 100;
  for (let i = 0; i < rows.length; i += SIZE) {
    const { error } = await supabase.from('scenario_data').upsert(rows.slice(i, i + SIZE));
    if (error) throw error;
  }
}

const COLLECTIONS = [
  { dataType: 'character',   docs: readDir(path.join(DATA_DIR, 'characters')),                       sid: d => d.scenarioIds?.[0] || null },
  { dataType: 'story_arc',   docs: readDir(path.join(DATA_DIR, 'story_arcs')),                       sid: d => d.scenarioId || null },
  { dataType: 'player_role', docs: readDir(path.join(DATA_DIR, 'scenarios', 'player_roles')),        sid: d => d.scenarioId || null },
  { dataType: 'location',    docs: readDirRecursive(path.join(DATA_DIR, 'locations')),               sid: d => d.scenarioId || null },
  { dataType: 'clue',        docs: readDirRecursive(path.join(DATA_DIR, 'clues')),                   sid: d => d.scenarioId || null },
];

const now = new Date().toISOString();
for (const { dataType, docs, sid } of COLLECTIONS) {
  if (!docs.length) { console.log(`[SEED] ${dataType}: 0 records — skipping`); continue; }
  const rows = docs.map(d => ({ id: d.id, data_type: dataType, scenario_id: sid(d), data: d, updated_at: now }));
  try {
    await upsertBatch(rows);
    console.log(`[SEED] ${dataType}: ${rows.length} records upserted`);
  } catch (err) {
    console.error(`[SEED] ${dataType} failed:`, err.message);
  }
}
console.log('[SEED] Done.');
