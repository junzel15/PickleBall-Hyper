// Supabase settings from the .env file (see .env.example), built into the app
// by react-native-dotenv.
//
// Only PUBLIC values belong here: the project URL and the publishable (anon)
// key, which only allows what the Row Level Security rules in
// supabase/migrations allow. Never use the secret / service_role key in the app.
import { SUPABASE_PUBLISHABLE_KEY as ENV_KEY, SUPABASE_URL as ENV_URL } from '@env';

/** Accepts the project URL with or without a trailing `/rest/v1/` (supabase-js adds it). */
export function normalizeUrl(url: string | undefined): string {
  return (url ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
}

export const SUPABASE_URL = normalizeUrl(ENV_URL);
export const SUPABASE_PUBLISHABLE_KEY = (ENV_KEY ?? '').trim();

/** Refuse anything that looks like a secret key, so it can never ship in the app. */
const looksSecret = /^sb_secret_/.test(SUPABASE_PUBLISHABLE_KEY) || /service_role/.test(SUPABASE_PUBLISHABLE_KEY);

/** Cloud features stay off (the game still works) until both values are set. */
export const cloudConfigured = /^https:\/\/.+/.test(SUPABASE_URL) && SUPABASE_PUBLISHABLE_KEY.length > 20 && !looksSecret;
