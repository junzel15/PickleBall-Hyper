module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // three.js (3D players) uses class static blocks, which Hermes does not support yet
    '@babel/plugin-transform-class-static-block',
    // Values from .env, imported as `import { SUPABASE_URL } from '@env'`.
    // After changing .env, restart Metro with `npm start -- --reset-cache`.
    ['module:react-native-dotenv', { moduleName: '@env', path: '.env', safe: false, allowUndefined: true }],
  ],
};
