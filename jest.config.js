module.exports = {
  preset: '@react-native/jest-preset',
  // shared test helpers, not tests themselves
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/helpers/'],
};
