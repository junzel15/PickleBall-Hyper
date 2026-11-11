/**
 * Logic tests for the ported game modules (no rendering).
 * @format
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { mix, rgba, shade } from '../src/game/colors';
import { cleanName, DEFAULT_AVATAR, DEFAULT_PADDLE, loadProfile, paddleById, PADDLES } from '../src/game/customize';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: async (k: string, v: string) => { store.set(k, v); },
    },
  };
});
// Drawing isn't exercised here; stub the Skia native module.
jest.mock('@shopify/react-native-skia', () => ({
  StrokeCap: {}, StrokeJoin: {}, PaintStyle: {}, ClipOp: {}, TileMode: {}, BlendMode: {},
}));

describe('colors', () => {
  test('shade mixes toward white / black', () => {
    expect(shade('#000000', 1)).toBe('#ffffff');
    expect(shade('#ffffff', -1)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
  test('rgba converts hex', () => {
    expect(rgba('#ff0000', 0.5)).toBe('rgba(255,0,0,0.5)');
  });
});

describe('profile', () => {
  test('names are cleaned like the browser game', () => {
    expect(cleanName('  Ana   Lee  ')).toBe('Ana Lee');
    expect(cleanName('<b>x</b>')).toBe('bx/b');
    expect(cleanName('')).toBe('Player');
    expect(cleanName(42)).toBe('Player');
    expect(cleanName('abcdefghijklmnopqrstuvwxyz')).toHaveLength(16);
  });

  test('unknown paddles fall back to the default', () => {
    expect(paddleById('nope').id).toBe(DEFAULT_PADDLE);
    expect(PADDLES).toHaveLength(12);
  });

  test('a saved profile is loaded and sanitized', async () => {
    await AsyncStorage.setItem(
      'pickleball.profile.v1',
      JSON.stringify({ name: ' Sam ', paddle: 'ember-blaze', avatar: { hair: 'curly', skin: 'not-a-colour' } }),
    );
    const p = await loadProfile();
    expect(p.name).toBe('Sam');
    expect(p.paddle).toBe('ember-blaze');
    expect(p.avatar.hair).toBe('curly');
    expect(p.avatar.skin).toBe(DEFAULT_AVATAR.skin);
  });
});
