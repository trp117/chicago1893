import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCENARIOS_DIR = path.join(__dirname, '../engine/data/scenarios')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

async function migrate() {
  const files = fs.readdirSync(SCENARIOS_DIR).filter(f => f.endsWith('.json'))
  console.log(`Found ${files.length} scenario files to migrate`)

  let succeeded = 0
  let failed = 0
  let skipped = 0

  for (const file of files) {
    const id = file.replace('.json', '')
    const filePath = path.join(SCENARIOS_DIR, file)

    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'))

      const { data: existing } = await supabase
        .from('scenarios')
        .select('id')
        .eq('id', id)
        .single()

      if (existing) {
        console.log(`  SKIP ${id} — already in Supabase`)
        skipped++
        continue
      }

      const { error: insertError } = await supabase
        .from('scenarios')
        .insert({
          id,
          title: content.title || id,
          content,
          current_version: 1
        })

      if (insertError) throw insertError

      const { error: versionError } = await supabase
        .from('scenario_versions')
        .insert({
          scenario_id: id,
          version_number: 1,
          content,
          change_note: 'Initial migration from file system',
          saved_by: 'migration-script'
        })

      if (versionError) {
        console.warn(`  WARN ${id} — version record failed: ${versionError.message}`)
      }

      console.log(`  OK   ${id}`)
      succeeded++

    } catch (err) {
      console.error(`  FAIL ${id} — ${err.message}`)
      failed++
    }
  }

  console.log(`\nMigration complete: ${succeeded} succeeded, ${skipped} skipped, ${failed} failed`)

  if (failed > 0) {
    console.error('Some scenarios failed. Check errors above before proceeding.')
    process.exit(1)
  }
}

migrate()
