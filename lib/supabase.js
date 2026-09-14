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

// Last result of checkSupabaseConnection, recorded so GET /health can report the same
// thing the [SUPABASE] boot line printed. false until the boot check actually succeeds —
// a /health read before boot finishes reports false, which is the honest answer.
let supabaseConnected = false
export function isSupabaseConnected() { return supabaseConnected }

export async function checkSupabaseConnection() {
  try {
    const { error } = await supabase
      .from('scenarios')
      .select('id')
      .limit(1)
    if (error) throw error
    supabaseConnected = true
    console.log('[SUPABASE] Connection confirmed.')
    return true
  } catch (err) {
    supabaseConnected = false
    console.error('[SUPABASE] Connection failed:', err.message)
    return false
  }
}
