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
      .select('id, title, content, updated_at')
      .order('updated_at', { ascending: false })

    if (error) throw error
    if (data && data.length > 0) {
      console.log(`[SCENARIO-STORE] Listed ${data.length} scenarios from Supabase`)
      return data.map(row => row.content)
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
  const { changeNote = 'Admin save', savedBy = 'admin' } = options

  // Write file system backup first
  const filePath = path.join(SCENARIOS_DIR, `${id}.json`)
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8')
  console.log(`[SCENARIO-STORE] Wrote ${id} to file system backup`)

  // Get current version number
  const { data: existing } = await supabase
    .from('scenarios')
    .select('id, current_version')
    .eq('id', id)
    .single()

  const nextVersion = existing ? existing.current_version + 1 : 1

  // Upsert scenario
  const { error: upsertError } = await supabase
    .from('scenarios')
    .upsert({
      id,
      title: content.title || id,
      content,
      current_version: nextVersion,
      updated_at: new Date().toISOString()
    })

  if (upsertError) throw upsertError

  // Write version record
  const { error: versionError } = await supabase
    .from('scenario_versions')
    .insert({
      scenario_id: id,
      version_number: nextVersion,
      content,
      change_note: changeNote,
      saved_by: savedBy
    })

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
