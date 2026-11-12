/**
 * The Play Online screens and the pause menu render at real phone and tablet sizes,
 * with every action present.
 * @format
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

jest.mock('react-native-svg', () => {
  const R = require('react');
  const { View } = require('react-native');
  const C = (p: { children?: unknown }) => R.createElement(View, null, p.children);
  return { __esModule: true, default: C, Svg: C, Circle: C, Defs: C, LinearGradient: C, RadialGradient: C, Path: C, Rect: C, Stop: C, Line: C, Text: C, G: C };
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
jest.mock('../src/backend/cloud', () => ({ __esModule: true, client: jest.fn() }));

let mockState: Record<string, unknown> = {};
jest.mock('../src/backend/online/session', () => {
  const fns = new Proxy({}, { get: (_t, k) => (k === '__esModule' ? true : k === 'onlineStore'
    ? { subscribe: () => () => {}, get: () => mockState }
    : jest.fn()) });
  return fns;
});

import { OnlineScreen } from '../src/ui/OnlineScreens';
import { PauseMenu } from '../src/ui/GameScreens';

const SIZES: [string, number, number][] = [
  ['small phone (640x360)', 640, 360],
  ['common phone (800x384)', 800, 384],
  ['10" tablet (1280x800)', 1280, 800],
  ['portrait tablet (800x1280)', 800, 1280],
];
function setScreen(width: number, height: number) {
  const RN = require('react-native');
  jest.spyOn(RN, 'useWindowDimensions').mockReturnValue({ width, height, scale: 2, fontScale: 1 });
}
const base = {
  userId: 'u0', me: { user_id: 'u0', name: 'Hana', friend_code: 'ABCDEFGH', rating: 1016, played: 3, wins: 2, losses: 1, streak: 2, best_streak: 2, forfeits: 0, longest_rally: 9 },
  room: null, rejoin: null, quick: 'idle', quickMode: 'singles', quickWaiting: 0,
  invites: [{ id: 1, code: 'K7QM2X', mode: 'doubles', from_id: 'u9', from_name: 'Pia', created_at: '' }],
  friends: [], onlineIds: ['u1', 'u2'], toast: null, busy: false, error: null, inMatch: false, found: null,
};
const player = (seat: number, name: string, ready = true) => ({ user_id: `u${seat}`, seat, team: seat % 2, ready, name, avatar: {}, paddle: 'x', rating: 1000 + seat });

function texts(el: React.ReactElement) {
  let r!: ReactTestRenderer.ReactTestRenderer;
  act(() => { r = ReactTestRenderer.create(el); });
  const out = r.root.findAllByType(Text).map(t => [].concat(t.props.children).join(''));
  act(() => r.unmount());
  return out;
}

describe('Play Online screens', () => {
  for (const [label, w, h] of SIZES) {
    test(`hub at ${label}`, () => {
      setScreen(w, h);
      mockState = { ...base };
      const t = texts(<OnlineScreen onBack={jest.fn()} onSignIn={jest.fn()} />);
      for (const need of ['Play online', 'FIND MATCH', 'Create room', 'Join', 'Friends', 'History', 'Ranking', '1 vs 1', '2 vs 2', 'ABCDEFGH', '1016']) {
        expect(t).toContain(need);
      }
      expect(t.some(x => x.includes('Pia'))).toBe(true); // the invite is shown
    });

    test(`2 vs 2 lobby at ${label}`, () => {
      setScreen(w, h);
      mockState = {
        ...base,
        room: { id: 'r', code: 'K7QM2X', kind: 'private', mode: 'doubles', status: 'lobby', capacity: 4, host_id: 'u0', match_id: null, match: null,
          players: [player(0, 'Hana'), player(1, 'Rex', false), player(2, 'Pia')] },
      };
      const t = texts(<OnlineScreen onBack={jest.fn()} onSignIn={jest.fn()} />);
      for (const need of ['K7QM2X', 'TEAM A', 'TEAM B', 'Hana (you)', 'Rex', 'Pia', 'Open spot', 'NOT READY', 'Invite friends', 'Leave room', 'WAITING FOR PLAYERS']) {
        expect(t).toContain(need);
      }
    });

    test(`Quick Match search at ${label}`, () => {
      setScreen(w, h);
      mockState = { ...base, quick: 'searching', quickMode: 'doubles', quickWaiting: 1 };
      const t = texts(<OnlineScreen onBack={jest.fn()} onSignIn={jest.fn()} />);
      expect(t).toContain('Looking for three more players…');
      expect(t).toContain('Cancel search');
    });
  }

  test('signed out: a clear sign-in prompt', () => {
    setScreen(800, 384);
    mockState = { ...base, userId: null };
    const t = texts(<OnlineScreen onBack={jest.fn()} onSignIn={jest.fn()} />);
    expect(t).toContain('SIGN IN');
  });
});

describe('pause menu', () => {
  for (const [label, w, h] of SIZES) {
    test(`big RESUME and no duplicate Customize at ${label}`, () => {
      setScreen(w, h);
      const game = new Proxy({}, { get: () => jest.fn() }) as never;
      const ui = { profile: { name: 'Hana' } } as never;
      let r!: ReactTestRenderer.ReactTestRenderer;
      act(() => { r = ReactTestRenderer.create(<PauseMenu game={game} ui={ui} />); });
      const all = r.root.findAllByType(Text);
      const t = all.map(x => [].concat(x.props.children).join(''));
      expect(t).toContain('RESUME');
      expect(t).toContain('Restart match');
      expect(t).toContain('Main menu');
      expect(t.some(x => /customize/i.test(x))).toBe(false);
      // RESUME is the largest text on the card
      const size = (x: { props: Record<string, unknown> }) =>
        ([] as Record<string, number>[]).concat(x.props.style as never).reduce((a, b) => ({ ...a, ...(b || {}) }), {} as Record<string, number>).fontSize || 0;
      const resume = all.find(x => x.props.children === 'RESUME')!;
      const others = all.filter(x => !['RESUME', 'Match paused', '›'].includes(x.props.children));
      expect(size(resume)).toBeGreaterThanOrEqual(Math.max(...others.map(size)));
      expect(size(resume)).toBeGreaterThanOrEqual(20); // large and easy to read on every phone
      act(() => r.unmount());
    });
  }
});
