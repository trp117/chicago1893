import { JsonFileStore } from '../engine/repositories/JsonFileStore.js';
import { supabase } from './supabase.js';

// Only back up these five entity types — sessions/players are ephemeral and stay disk-only
const DATA_TYPES = new Map([
  ['characters',  'character'],
  ['locations',   'location'],
  ['clues',       'clue'],
  ['story_arcs',  'story_arc'],
  ['scenarios',   'player_role'],  // collection is 'scenarios/player_roles'
]);

export class DualWriteStore extends JsonFileStore {
  save(collection, id, doc) {
    const out = super.save(collection, id, doc);
    const dataType = DATA_TYPES.get(collection.split('/')[0]);
    if (dataType) {
      const scenarioId = out.scenarioId || out.scenarioIds?.[0] || null;
      supabase
        .from('scenario_data')
        .upsert({
          id:          out.id,
          data_type:   dataType,
          scenario_id: scenarioId,
          data:        out,
          updated_at:  new Date().toISOString(),
        })
        .then(({ error }) => {
          if (error) console.error(`[DUAL-WRITE] Failed to upsert ${dataType}/${id}:`, error.message);
        });
    }
    return out;
  }

  delete(collection, id) {
    const existed = super.delete(collection, id);
    const dataType = DATA_TYPES.get(collection.split('/')[0]);
    if (existed && dataType) {
      supabase
        .from('scenario_data')
        .delete()
        .eq('data_type', dataType)
        .eq('id', id)
        .then(({ error }) => {
          if (error) console.error(`[DUAL-WRITE] Failed to delete ${dataType}/${id}:`, error.message);
        });
    }
    return existed;
  }
}
