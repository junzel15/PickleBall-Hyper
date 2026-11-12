/**
 * The main menu renders at real phone and tablet sizes without crashing, keeps every
 * action reachable, and scales its sizes with the screen.
 * @format
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

jest.mock('@shopify/react-native-skia', () => {
  const R = require('react');
  const { View } = require('react-native');
  const any: unknown = new Proxy(function noop() {}, { get: (_t, k) => (k === 'then' ? undefined : any), apply: () => any });
  return {
    __esModule: true, Skia: any, Canvas: (p: object) => R.createElement(View, p), Picture: () => null,
    StrokeCap: {}, StrokeJoin: {}, PaintStyle: {}, ClipOp: {}, TileMode: {}, BlendMode: {}, PointMode: {},
    FontWeight: {}, FontSlant: {}, FontWidth: {},
  };
});
jest.mock('react-native-svg', () => {
  const R = require('react');
  const { View } = require('react-native');
  const C = (p: { children?: unknown }) => R.createElement(View, null, p.children);
  return { __esModule: true, default: C, Svg: C, Circle: C, Defs: C, LinearGradient: C, RadialGradient: C, Path: C, Rect: C, Stop: C, Line: C, Text: C, G: C };
});
jest.mock('../src/game/customize', () => ({
  __esModule: true,
  drawPortrait: () => {},
  paddleById: () => ({ id: 'tidal-wave', brand: 'Tidal', model: 'Wave' }),
}));

import { MainMenu } from '../src/ui/MainMenu';

const SIZES: [string, number, number][] = [
  ['small phone (640x360)', 640, 360],
  ['common phone (800x384)', 800, 384],
  ['tall phone (915x412)', 915, 412],
  ['10" tablet (1280x800)', 1280, 800],
  ['portrait (412x915)', 412, 915],
];

function setScreen(width: number, height: number) {
  const RN = require('react-native');
  jest.spyOn(RN, 'useWindowDimensions').mockReturnValue({ width, height, scale: 2, fontScale: 1 });
}

const ui = {
  profile: { name: 'Hana Host', avatar: {}, paddle: 'tidal-wave' },
  selectedMode: 'singles', difficulty: 'medium', suspended: false, voiceAvailable: true, voiceOn: true,
} as never;
const game = new Proxy({}, { get: () => jest.fn() }) as never;

describe('main menu', () => {
  for (const [label, w, h] of SIZES) {
    test(`renders at ${label} with every action available`, () => {
      setScreen(w, h);
      let r!: ReactTestRenderer.ReactTestRenderer;
      act(() => {
        r = ReactTestRenderer.create(
          <MainMenu game={game} ui={ui} short={h <= 560} signedIn onOpenCloud={jest.fn()} onOpenTutorial={jest.fn()}
            onOpenOnline={jest.fn()} onlineBadge="" onlineCount={3} />,
        );
      });
      const texts = r.root.findAllByType(Text).map(t => [].concat(t.props.children).join(''));
      for (const need of ['PLAY', 'PLAY ONLINE', 'History', 'Leaders', 'Account', 'How to play', 'Customize', 'Rules & controls', '1 vs 1', '2 vs 2', 'Easy', 'Medium', 'Hard']) {
        expect(texts).toContain(need);
      }
      expect(texts.some(t => t.includes('3 online now'))).toBe(true);
      act(() => r.unmount());
    });
  }

  for (const [label, w, h] of SIZES) {
    test(`Rules & controls opens full screen with all three tabs at ${label}`, () => {
      setScreen(w, h);
      let r!: ReactTestRenderer.ReactTestRenderer;
      act(() => {
        r = ReactTestRenderer.create(
          <MainMenu game={game} ui={ui} short={h <= 560} signedIn onOpenCloud={jest.fn()} onOpenTutorial={jest.fn()} onOpenOnline={jest.fn()} />,
        );
      });
      const press = (label2: string) => {
        let n: ReactTestRenderer.ReactTestInstance | null = r.root.findAllByType(Text).find(x => [].concat(x.props.children).join('') === label2) ?? null;
        while (n && !n.props.onPress) n = n.parent;
        expect(n).toBeTruthy();
        act(() => n!.props.onPress());
      };
      const all = () => r.root.findAllByType(Text).map(x => [].concat(x.props.children).join(''));
      press('Rules & controls');
      for (const need of ['HOW THE GAME WORKS', 'Controls', 'Rules', 'Online', 'TOUCH CONTROLS']) expect(all()).toContain(need);
      press('Rules');
      expect(all()).toContain('PICKLEBALL RULES');
      press('Online');
      expect(all()).toContain('PLAYING ONLINE');
      expect(all()).toContain('PLAY ONLINE');
      act(() => r.unmount());
    });
  }

  test('sizes scale with the screen: bigger on a tablet than on a small phone', () => {
    const titleSize = (w: number, h: number) => {
      setScreen(w, h);
      let r!: ReactTestRenderer.ReactTestRenderer;
      act(() => {
        r = ReactTestRenderer.create(
          <MainMenu game={game} ui={ui} short={h <= 560} signedIn onOpenCloud={jest.fn()} onOpenTutorial={jest.fn()} onOpenOnline={jest.fn()} />,
        );
      });
      const t = r.root.findAllByType(Text).find(x => x.props.children === 'PLAY');
      const style = [].concat(t?.props.style).reduce((a: Record<string, number>, b: Record<string, number>) => ({ ...a, ...(b || {}) }), {});
      act(() => r.unmount());
      return style.fontSize as number;
    };
    const phone = titleSize(640, 360), tablet = titleSize(1280, 800);
    expect(tablet).toBeGreaterThan(phone);
    expect(phone).toBeGreaterThanOrEqual(18); // still readable on the smallest phone
  });

  test('paused CPU match: resume banner and NEW GAME', () => {
    setScreen(800, 384);
    let r!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      r = ReactTestRenderer.create(
        <MainMenu game={game} ui={{ ...(ui as object), suspended: true } as never} short signedIn={false}
          onOpenCloud={jest.fn()} onOpenTutorial={jest.fn()} onOpenOnline={jest.fn()} />,
      );
    });
    const texts = r.root.findAllByType(Text).map(t => [].concat(t.props.children).join(''));
    expect(texts).toContain('Match paused');
    expect(texts).toContain('NEW GAME');
    expect(texts).toContain('PLAY ONLINE'); // still offered while a match is paused
    expect(texts).toContain('Sign in');
    act(() => r.unmount());
  });
});
