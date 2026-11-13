module.exports = {
  preset: '@react-native/jest-preset',
  // shared test helpers, not tests themselves
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/helpers/'],
  // three.js ships ES modules: transform it like React Native's own packages
  transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?|three)/)'],
  // one three.js instance, the WebGPU build, exactly as Metro resolves it (see metro.config.js)
  moduleNameMapper: {
    '^three$': '<rootDir>/node_modules/three/build/three.webgpu.js',
    '^three/webgpu$': '<rootDir>/node_modules/three/build/three.webgpu.js',
  },
};
