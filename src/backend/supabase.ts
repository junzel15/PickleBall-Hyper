// The Supabase client. The login session is kept in AsyncStorage, so players
// stay signed in between launches.
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { cloudConfigured, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config';
import type { Database } from './types';

export type Client = SupabaseClient<Database>;

export const supabase: Client | null = cloudConfigured
  ? createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null;
