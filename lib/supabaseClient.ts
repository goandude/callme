// File: /lib/supabaseClient.ts - DEBUGGING VERSION

import { createClient } from '@supabase/supabase-js'

console.log('--- [DEBUG] Initializing Supabase Client ---');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// This will log the values to tell us if Next.js is providing them.
console.log('[DEBUG] NEXT_PUBLIC_SUPABASE_URL:', supabaseUrl);
// For security, we only check if the key exists, we don't print the key itself.
console.log('[DEBUG] NEXT_PUBLIC_SUPABASE_ANON_KEY exists?:', !!supabaseAnonKey);


if (!supabaseUrl || !supabaseAnonKey) {
  console.error('!!! [DEBUG] CRITICAL: Supabase environment variables are MISSING at initialization!');
}

export const supabase = createClient(supabaseUrl!, supabaseAnonKey!);

console.log('--- [DEBUG] Supabase client object has been created. ---');