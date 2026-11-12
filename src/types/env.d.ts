// Values from .env (react-native-dotenv). Undefined when .env is missing.
declare module '@env' {
  export const SUPABASE_URL: string | undefined;
  export const SUPABASE_PUBLISHABLE_KEY: string | undefined;
}
