// Module mocks so the real game engine runs in Jest without a screen, sound or voice.
// Import this file FIRST in a test (jest.mock calls in it are hoisted within it).
jest.mock('@shopify/react-native-skia', () => {
  const fn: unknown = new Proxy(function noop() {}, {
    get: (_t, k) => (k === 'then' ? undefined : fn),
    apply: () => fn,
    construct: () => fn as object,
  });
  return { __esModule: true, Skia: fn, StrokeCap: {}, StrokeJoin: {}, PaintStyle: {}, ClipOp: {}, TileMode: {}, BlendMode: {}, PointMode: {}, FontWeight: {}, FontSlant: {}, FontWidth: {} };
});
jest.mock('../../src/game/audio', () => {
  const noop = () => {};
  return {
    __esModule: true,
    ensureAudio: noop,
    isMuted: () => true,
    setMuted: noop,
    suspendAudio: noop,
    sfx: new Proxy({}, { get: () => noop }),
  };
});
jest.mock('../../src/game/speech', () => ({
  __esModule: true,
  speech: { ok: false, on: false },
  speak: () => {},
  hushSpeech: () => {},
  waitForVoices: async () => {},
}));
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    },
  };
});

export {};
