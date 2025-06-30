//
// 1. Filename: /lib/supabaseClient.ts
// Description: Initializes and exports the Supabase client (TypeScript version).
//
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

// This check is crucial for TypeScript. It confirms the variables exist
// and are strings, preventing the "is not assignable to type 'string'" error.
if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase URL or Anon Key is missing. Make sure to set them in your .env.local file.");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
