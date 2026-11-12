/**
 * The redesigned sections (loading, start, account / sign in / create account, the
 * account welcome step, match history, leaderboard and How to play) render at real
 * phone and tablet sizes with every action present.
 * @format
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

jest.mock('react-native-svg', () => {
  const R = require('react');
  const { View } = require('react-native');
  const C = (p: { children?: unknown }) => R.createElement(View, null, p.children);
  return {
    __esModule: true, default: C, Svg: C, Circle: C, Defs: C, LinearGradient: C, RadialGradient: C, Path: C, Rect: C,
    Stop: C, Line: C, Text: C, G: C, Polygon: C, Ellipse: C,
  };
});
jest.mock('@shopify/react-native-skia', () => {
  const R = require('react');
  const { View } = require('react-native');
  const any: unknown = new Proxy(function noop() {}, { get: (_t, k) => (k === 'then' ? undefined : any), apply: () => any });
  return {
    __esModule: true, Skia: any, Canvas: (p: object) => R.createElement(View, p), Picture: () => null,
    StrokeCap: any, StrokeJoin: any, PaintStyle: any, ClipOp: any, TileMode: any, BlendMode: any, PointMode: any,
    FontWeight: any, FontSlant: any, FontWidth: any,
  };
});

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

// Screens render their canvases as plain views here; drawing itself is checked below with a strict fake canvas.
jest.mock('../src/ui/common', () => {
  const actual = jest.requireActual('../src/ui/common');
  const R = require('react');
  const { View } = require('react-native');
  return { ...actual, Drawing: (p: { style?: unknown }) => R.createElement(View, { style: p.style }) };
});

let mockAccount = { configured: true, ready: true, userId: null as string | null, email: null as string | null, pending: 0 };
jest.mock('../src/backend/cloud', () => ({
  __esModule: true,
  client: () => ({}),
  account: { subscribe: () => () => {}, get: () => mockAccount },
}));
jest.mock('../src/backend/api', () => {
  const actual = jest.requireActual('../src/backend/api');
  return {
    ...actual,
    listMatches: jest.fn(async () => [
      { id: 1, user_id: 'u0', mode: 'singles', difficulty: 'hard', player_score: 11, ai_score: 7, won: true, rallies_won: 11, longest_rally: 14, opponent: 'Moonballer', played_at: '2026-11-10T10:00:00Z' },
      { id: 2, user_id: 'u0', mode: 'doubles', difficulty: 'medium', player_score: 9, ai_score: 11, won: false, rallies_won: 9, longest_rally: 6, opponent: null, played_at: '2026-11-11T10:00:00Z' },
    ]),
    getLeaderboard: jest.fn(async () => [
      { rank: 1, name: 'Pia', wins: 12, played: 14, best_rally: 22, is_me: false },
      { rank: 2, name: 'Hana', wins: 8, played: 10, best_rally: 15, is_me: true },
      { rank: 3, name: 'Kai', wins: 5, played: 9, best_rally: 11, is_me: false },
    ]),
  };
});
jest.mock('../src/backend/online/session', () => new Proxy({}, {
  get: (_t, k) => (k === '__esModule' ? true : k === 'onlineStore' ? { subscribe: () => () => {}, get: () => ({}) } : jest.fn()),
}));

import { Loader } from '../src/ui/Loader';
import { StartScreen } from '../src/ui/StartScreen';
import { AccountScreen, HistoryScreen, LeaderboardScreen } from '../src/ui/CloudScreens';
import { WelcomeModal } from '../src/ui/WelcomeModal';
import { TutorialModal } from '../src/ui/TutorialModal';
import { DEFAULT_AVATAR } from '../src/game/customize';

const SIZES: [string, number, number][] = [
  ['small phone (640x360)', 640, 360],
  ['common phone (800x384)', 800, 384],
  ['10" tablet (1280x800)', 1280, 800],
  ['portrait phone (412x915)', 412, 915],
];
function setScreen(width: number, height: number) {
  const RN = require('react-native');
  jest.spyOn(RN, 'useWindowDimensions').mockReturnValue({ width, height, scale: 2, fontScale: 1 });
}

async function render(el: React.ReactElement) {
  let r!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => { r = ReactTestRenderer.create(el); });
  await act(async () => { await Promise.resolve(); }); // let async loads settle
  return r;
}
const textsOf = (r: ReactTestRenderer.ReactTestRenderer) => r.root.findAllByType(Text).map(t => [].concat(t.props.children).join(''));
function press(r: ReactTestRenderer.ReactTestRenderer, label: string) {
  let n: ReactTestRenderer.ReactTestInstance | null = r.root.findAllByType(Text).find(x => [].concat(x.props.children).join('') === label) ?? null;
  while (n && !n.props.onPress) n = n.parent;
  if (!n) throw new Error(`no button "${label}"`);
  act(() => n!.props.onPress());
}
function expectAll(t: string[], need: string[]) {
  for (const x of need) expect(t.some(s => s.includes(x)) ? x : `missing "${x}" in ${JSON.stringify(t)}`).toBe(x);
}

describe('redesigned sections', () => {
  for (const [label, w, h] of SIZES) {
    describe(label, () => {
      beforeEach(() => setScreen(w, h));

      test('loading screen', async () => {
        const r = await render(<Loader loader={{ progress: 0.54, status: 'Building the court…', tip: 'Dinks win at the kitchen.', done: false }} />);
        expectAll(textsOf(r), ['HYPER', 'SPORTS ARCADE', '54%', 'Building the court', 'Dinks win at the kitchen.']);
        act(() => r.unmount());
      });

      test('start screen', async () => {
        const onAccount = jest.fn(), onOffline = jest.fn();
        const r = await render(<StartScreen short={h <= 560} onAccount={onAccount} onOffline={onOffline} />);
        expectAll(textsOf(r), ['HYPER', 'HOW DO YOU WANT TO PLAY?', 'SIGN IN / CREATE ACCOUNT', 'PLAY OFFLINE']);
        press(r, 'PLAY OFFLINE');
        expect(onOffline).toHaveBeenCalled();
        act(() => r.unmount());
      });

      test('create account and sign in', async () => {
        mockAccount = { ...mockAccount, userId: null, email: null };
        const r = await render(<AccountScreen onBack={jest.fn()} onDone={jest.fn()} onRegistered={jest.fn()} playerName="Hana" />);
        expectAll(textsOf(r), ['Create account', 'Sign in', 'EMAIL', 'PASSWORD', 'Play online']);
        press(r, 'Sign in');
        expectAll(textsOf(r), ['EMAIL', 'PASSWORD']);
        act(() => r.unmount());
      });

      test('signed-in account', async () => {
        mockAccount = { ...mockAccount, userId: 'u0', email: 'hana@example.com' };
        const r = await render(<AccountScreen onBack={jest.fn()} onDone={jest.fn()} onRegistered={jest.fn()} playerName="Hana" />);
        expectAll(textsOf(r), ['hana@example.com', 'Sign out']);
        act(() => r.unmount());
      });

      test('welcome step after creating an account', async () => {
        const game = { setProfile: jest.fn() } as never;
        const ui = { profile: { name: 'Player', age: null, avatar: DEFAULT_AVATAR, paddle: 'tidal-wave' } } as never;
        const r = await render(<WelcomeModal game={game} ui={ui} email="hana@example.com" onDone={jest.fn()} short={h <= 560} />);
        const t = textsOf(r);
        expectAll(t, ['ACCOUNT CREATED', 'Set up your player', 'PLAYER NAME', 'AGE', "LET'S PLAY", 'hana@example.com']);
        press(r, "LET'S PLAY"); // empty name: refused with a message, not saved
        expectAll(textsOf(r), ['Enter your player name.']);
        act(() => r.unmount());
      });

      test('match history', async () => {
        mockAccount = { ...mockAccount, userId: 'u0', email: 'hana@example.com' };
        const r = await render(<HistoryScreen onBack={jest.fn()} onOpen={jest.fn()} />);
        expectAll(textsOf(r), ['Match history', 'PLAYED', 'WON', 'WIN RATE', 'BEST RALLY', '50%', '11 – 7', 'Moonballer', 'Delete all']);
        act(() => r.unmount());
      });

      test('history asks to sign in when signed out', async () => {
        mockAccount = { ...mockAccount, userId: null, email: null };
        const r = await render(<HistoryScreen onBack={jest.fn()} onOpen={jest.fn()} />);
        expectAll(textsOf(r), ['Match history', 'SIGN IN']);
        act(() => r.unmount());
      });

      test('leaderboard', async () => {
        mockAccount = { ...mockAccount, userId: 'u0', email: 'hana@example.com' };
        const r = await render(<LeaderboardScreen onBack={jest.fn()} onOpen={jest.fn()} />);
        expectAll(textsOf(r), ['Pia', 'Hana', 'Kai']);
        act(() => r.unmount());
      });

      test('how to play: walks every step to the end', async () => {
        const onPractice = jest.fn();
        const r = await render(<TutorialModal short={h <= 560} onClose={jest.fn()} onPractice={onPractice} />);
        expectAll(textsOf(r), ['How to play', 'Skip']);
        for (let i = 0; i < 20 && !textsOf(r).some(x => x.includes('PRACTICE MATCH')); i++) {
          const next = textsOf(r).find(x => x === 'NEXT' || x === 'START TOUR');
          if (!next) break;
          press(r, next);
        }
        expectAll(textsOf(r), ['PRACTICE MATCH', "You're ready!"]);
        press(r, 'PRACTICE MATCH');
        expect(onPractice).toHaveBeenCalled();
        act(() => r.unmount());
      });
    });
  }
});

describe('customize player & paddles', () => {
  test('every paddle design draws with finite coordinates in every finish', () => {
    const { PADDLES, drawPaddle, drawPaddleUpright, drawBodyPreview } = require('../src/game/customize');
    const bad: string[] = [];
    let calls = 0;
    const grad = { addColorStop: (o: number) => { if (!(o >= 0 && o <= 1)) bad.push(`stop ${o}`); } };
    const ctx: Record<string, unknown> = new Proxy({}, {
      get: (_t, k) => {
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
        if (k === 'measureText') return () => ({ width: 10 });
        return (...args: unknown[]) => {
          calls++;
          for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) bad.push(`${String(k)}(${args.join(',')})`);
        };
      },
      set: () => true,
    });
    expect(PADDLES.length).toBeGreaterThanOrEqual(26);
    expect(new Set(PADDLES.map((p: { id: string }) => p.id)).size).toBe(PADDLES.length); // unique ids
    for (const p of PADDLES) {
      expect(p.id.length).toBeLessThanOrEqual(40); // fits the profiles.paddle column
      expect(p.power).toBeGreaterThanOrEqual(1); expect(p.power).toBeLessThanOrEqual(10);
      expect(p.control).toBeGreaterThanOrEqual(1); expect(p.control).toBeLessThanOrEqual(10);
      drawPaddle(ctx, p, 60, true);
      drawPaddleUpright(ctx, p, 96, 150, 86);
      drawBodyPreview(ctx, require('../src/game/customize').DEFAULT_AVATAR, p, 90, 196);
    }
    expect(calls).toBeGreaterThan(1000);
    expect(bad).toEqual([]);
  });

  for (const [label, w, h] of SIZES) {
    test(`customize screen at ${label}: tabs, paddle line-up, and the chosen paddle is saved`, () => {
      setScreen(w, h);
      const { DEFAULT_AVATAR: av, PADDLES } = require('../src/game/customize');
      const { CustomizeScreen } = require('../src/ui/CustomizeScreen');
      const closeCustomize = jest.fn();
      const game = { closeCustomize, setCustomizeSaver: jest.fn() } as never;
      const ui = { profile: { name: 'Hana', age: 30, avatar: av, paddle: 'tidal-wave' } } as never;
      let r!: ReactTestRenderer.ReactTestRenderer;
      act(() => { r = ReactTestRenderer.create(<CustomizeScreen game={game} ui={ui} short={h <= 560} />); });
      expectAll(textsOf(r), ['Customize player', 'YOUR PLAYER', 'LIVE PREVIEW', 'PLAYER NAME', 'EQUIPPED PADDLE', 'TIDAL', 'Player', 'Outfit', 'Paddle', 'SAVE & BACK', 'SKIN TONE']);
      press(r, 'Outfit');
      expectAll(textsOf(r), ['T-SHIRT STYLE', 'SHOES']);
      press(r, 'Paddle');
      const t = textsOf(r);
      expectAll(t, ['POWER', 'CONTROL', 'All', 'Pro', 'Signature', 'Classic', 'HEXA', 'PRISM', 'GRAND PRIX']);
      press(r, 'Pro');
      const pro = textsOf(r);
      expect(pro).toContain('HEXA');
      expect(pro).not.toContain('GRAND PRIX'); // classic line filtered out
      // pick a new pro paddle: it becomes the featured & equipped one, and is saved
      let n: ReactTestRenderer.ReactTestInstance | null = r.root.findAll(x => x.props.accessibilityLabel === 'HEXA Honeycomb T700')[0];
      while (n && !n.props.onPress) n = n.parent;
      act(() => n!.props.onPress());
      expect(textsOf(r)).toContain('Raw carbon grit');
      press(r, 'SAVE & BACK');
      expect(closeCustomize).toHaveBeenCalledWith(expect.objectContaining({ paddle: 'hexa-honeycomb', name: 'Hana' }));
      expect(PADDLES.some((p: { id: string }) => p.id === 'hexa-honeycomb')).toBe(true);
      act(() => r.unmount());
    });
  }
});
