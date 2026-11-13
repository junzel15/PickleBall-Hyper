const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const threePackagePath = path.join(__dirname, 'node_modules', 'three'); // three does not export package.json

const config = {
  resolver: {
    // three.js runs on WebGPU (react-native-webgpu): every `three` import, including the
    // ones inside three/addons (GLTFLoader, SkeletonUtils), must resolve to the WebGPU build
    resolveRequest: (context, moduleName, platform) => {
      if (moduleName === 'three' || moduleName === 'three/webgpu') {
        return { filePath: path.resolve(threePackagePath, 'build/three.webgpu.js'), type: 'sourceFile' };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
