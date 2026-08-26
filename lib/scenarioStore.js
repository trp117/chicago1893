import { supabase } from './supabase.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCENARIOS_DIR = path.join(__dirname, '../engine/data/scenarios')

export async function getScenario(id) {
  try {
    const { data, error } = await supabase
      .from('scenarios')
      .select('content')
      .eq('id', id)
      .single()

    if (error) throw error
    if (data) {
      console.log(`[SCENARIO-STORE] Loaded ${id} from Supabase`)
      return data.content
    }
  } catch (err) {
    console.warn(`[SCENARIO-STORE] Supabase read failed for ${id}, falling back to file:`, err.message)
  }

  const filePath = path.join(SCENARIOS_DIR, `${id}.json`)
  if (fs.existsSync(filePath)) {
    console.log(`[SCENARIO-STORE] Loaded ${id} from file system fallback`)
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  }

  throw new Error(`Scenario not found: ${id}`)
}

export async function listScenarios() {
  try {
    const { data, error } = await supabase
      .from('scenarios')
      .select('id, title, content, status, updated_at')
      .order('updated_at', { ascending: false })

    if (error) throw error
    if (data && data.length > 0) {
      console.log(`[SCENARIO-STORE] Listed ${data.length} scenarios from Supabase`)
      return data.map(row => ({ ...row.content, status: row.status || 'published' }))
    }
  } catch (err) {
    console.warn('[SCENARIO-STORE] Falling back to file system:', err.message)
  }

  const files = fs.readdirSync(SCENARIOS_DIR).filter(f => f.endsWith('.json'))
  return files.map(f => {
    return JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, f), 'utf8'))
  })
}

export async function saveScenario(id, content, options = {}) {
  const { changeNote = 'Admin save', savedBy = 'admin', baseVersion = null } = options

  const row = {
    id,
    title: content.title || id,
    content,
    status: content.status || 'published',
    updated_at: new Date().toISOString()
  }

  // Get current version number
  const { data: existing } = await supabase
    .from('scenarios')
    .select('id, current_version')
    .eq('id', id)
    .single()

  let nextVersion
  if (baseVersion != null && existing) {
    // Optimistic concurrency: atomic compare-and-swap. Update ONLY if the row's
    // current_version still equals the version the client loaded. If another save
    // landed first, zero rows match and we reject WITHOUT writing — no clobber.
    nextVersion = baseVersion + 1
    const { data: updated, error: casError } = await supabase
      .from('scenarios')
      .update({ ...row, current_version: nextVersion })
      .eq('id', id)
      .eq('current_version', baseVersion)
      .select('id')

    if (casError) throw casError
    if (!updated || updated.length === 0) {
      // Re-read the true current version for an accurate conflict message.
      const { data: fresh } = await supabase
        .from('scenarios').select('current_version').eq('id', id).single()
      const actual = fresh?.current_version ?? null
      const err = new Error(`Version conflict on "${id}": you loaded v${baseVersion}, current is v${actual}. Reload before saving.`)
      err.code = 'VERSION_CONFLICT'
      err.expected = baseVersion
      err.actual = actual
      throw err
    }
  } else {
    // Unguarded path (baseVersion omitted, or brand-new scenario): keep prior behaviour —
    // read-then-increment upsert. Used by the server-side fresh-read routes.
    nextVersion = existing ? existing.current_version + 1 : 1
    const { error: upsertError } = await supabase
      .from('scenarios')
      .upsert({ ...row, current_version: nextVersion })
    if (upsertError) throw upsertError
  }

  // File-system backup AFTER the DB write commits — never leave a stale backup on conflict.
  const filePath = path.join(SCENARIOS_DIR, `${id}.json`)
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8')
  console.log(`[SCENARIO-STORE] Wrote ${id} to file system backup`)

  // Write version record, including the base_version lineage when known. If the
  // base_version column has not been added to scenario_versions yet, retry without it
  // so version history is preserved (self-healing once the column exists).
  const versionRow = {
    scenario_id: id,
    version_number: nextVersion,
    content,
    change_note: changeNote,
    saved_by: savedBy,
    base_version: baseVersion
  }
  let { error: versionError } = await supabase.from('scenario_versions').insert(versionRow)
  if (versionError && /base_version/i.test(versionError.message || '')) {
    const { base_version, ...withoutLineage } = versionRow
    ;({ error: versionError } = await supabase.from('scenario_versions').insert(withoutLineage))
  }
  if (versionError) {
    console.warn(`[SCENARIO-STORE] Version record failed for ${id}:`, versionError.message)
  }

  console.log(`[SCENARIO-STORE] Saved ${id} to Supabase as version ${nextVersion}`)
  return nextVersion
}

export async function getScenarioVersions(id) {
  const { data, error } = await supabase
    .from('scenario_versions')
    .select('version_number, change_note, saved_by, saved_at')
    .eq('scenario_id', id)
    .order('version_number', { ascending: false })

  if (error) throw error
  return data || []
}

export async function restoreScenarioVersion(id, versionNumber, options = {}) {
  const { data, error } = await supabase
    .from('scenario_versions')
    .select('content')
    .eq('scenario_id', id)
    .eq('version_number', versionNumber)
    .single()

  if (error) throw error
  if (!data) throw new Error(`Version ${versionNumber} not found for ${id}`)

  return saveScenario(id, data.content, {
    changeNote: `Restored from version ${versionNumber}`,
    savedBy: options.savedBy || 'admin'
  })
}
