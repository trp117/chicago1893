import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('[SUPABASE] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables')
}

// Service client — for database operations, bypasses RLS
export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})

// Auth client — for user authentication operations
export const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    storage: undefined // handled server-side via sessions
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
