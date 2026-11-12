module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // Values from .env, imported as `import { SUPABASE_URL } from '@env'`.
    // After changing .env, restart Metro with `npm start -- --reset-cache`.
    ['module:react-native-dotenv', { moduleName: '@env', path: '.env', safe: false, allowUndefined: true }],
  ],
};
