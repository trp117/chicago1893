import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from './supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.resolve(__dirname, '../engine/data');

function collectionDir(dataType, data) {
  switch (dataType) {
    case 'character':   return path.join(DATA_DIR, 'characters');
    case 'location':    return path.join(DATA_DIR, 'locations',  data.scenarioId || 'chicago1893');
    case 'clue':        return path.join(DATA_DIR, 'clues',      data.scenarioId || 'chicago1893');
    case 'story_arc':   return path.join(DATA_DIR, 'story_arcs');
    case 'player_role': return path.join(DATA_DIR, 'scenarios',  'player_roles');
    default:            return null;
  }
}

// Counts from the last restore, recorded so GET /health can report what the [RESTORE]
// boot line printed. null means the restore never reached the write loop — a failed
// scenario_data query, or an empty table — both of which return early below.
let restoredCounts = null;
export function getRestoredCounts() { return restoredCounts; }

export async function restoreFromSupabase() {
  let rows;
  try {
    const { data, error } = await supabase.from('scenario_data').select('data_type, data');
    if (error) throw error;
    rows = data || [];
  } catch (err) {
    console.warn('[RESTORE] Could not query scenario_data:', err.message, '— continuing with existing disk files');
    return;
  }

  if (rows.length === 0) {
    console.log('[RESTORE] scenario_data is empty — nothing to restore');
    return;
  }

  const counts = {};
  for (const { data_type, data } of rows) {
    const dir = collectionDir(data_type, data);
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${data.id}.json`), JSON.stringify(data, null, 2), 'utf8');
      counts[data_type] = (counts[data_type] || 0) + 1;
    } catch (err) {
      console.error(`[RESTORE] Failed to write ${data_type}/${data.id}:`, err.message);
    }
  }

  restoredCounts = counts;
  const summary = Object.entries(counts).map(([t, n]) => `${n} ${t}s`).join(', ');
  console.log(`[RESTORE] Restored ${summary}`);
}
