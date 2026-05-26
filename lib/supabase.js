import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('[SUPABASE] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables')
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})

export async function checkSupabaseConnection() {
  try {
    const { error } = await supabase
      .from('scenarios')
      .select('id')
      .limit(1)
    if (error) throw error
    console.log('[SUPABASE] Connection confirmed.')
    return true
  } catch (err) {
    console.error('[SUPABASE] Connection failed:', err.message)
    return false
  }
}
