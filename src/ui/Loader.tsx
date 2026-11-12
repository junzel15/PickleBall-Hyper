// Loading screen: an arena backdrop with a court in perspective and a spotlight, the
// PickleBall: Hyper logo, a ball bouncing off a swinging paddle, a glowing progress bar
// driven by the real setup steps (with the percentage and step), and rotating pro tips.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, Line, LinearGradient, Polygon, RadialGradient, Rect, Stop } from 'react-native-svg';
import type { UiState } from '../game/engine';
import { Brand, Icon, SectionTitle, useUiScale } from './gameUi';
import { C } from './theme';

/** The court drawn in perspective behind everything (vanishing toward the top). */
function ArenaCourt() {
  const W = 100, H = 100;
  // court trapezoid: near edge wide at the bottom, far edge narrow near the horizon
  const nearY = 100, farY = 44, nearL = 6, nearR = 94, farL = 36, farR = 64;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const at = (t: number) => ({ y: lerp(nearY, farY, t), l: lerp(nearL, farL, t), r: lerp(nearR, farR, t) });
  const kitchenA = at(0.42), net = at(0.5), kitchenB = at(0.58);
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" pointerEvents="none">
      <Defs>
        <LinearGradient id="ldCourt" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#1f5aa6" stopOpacity="0.05" />
          <Stop offset="1" stopColor="#2458a4" stopOpacity="0.45" />
        </LinearGradient>
      </Defs>
      <Polygon points={`${nearL},${nearY} ${nearR},${nearY} ${farR},${farY} ${farL},${farY}`} fill="url(#ldCourt)" />
      <Polygon points={`${kitchenA.l},${kitchenA.y} ${kitchenA.r},${kitchenA.y} ${kitchenB.r},${kitchenB.y} ${kitchenB.l},${kitchenB.y}`} fill="rgba(47,111,190,0.25)" />
      {[[nearL, nearY, farL, farY], [nearR, nearY, farR, farY], [farL, farY, farR, farY],
        [kitchenA.l, kitchenA.y, kitchenA.r, kitchenA.y], [kitchenB.l, kitchenB.y, kitchenB.r, kitchenB.y],
        [50, nearY, 50, kitchenA.y], [50, kitchenB.y, 50, farY]].map(([x1, y1, x2, y2], i) => (
        <Line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(246,248,251,0.28)" strokeWidth={0.35} />
      ))}
      <Line x1={net.l - 2} y1={net.y - 3.5} x2={net.r + 2} y2={net.y - 3.5} stroke="rgba(255,255,255,0.45)" strokeWidth={0.5} />
      <Rect x={net.l - 2} y={net.y - 3.5} width={net.r - net.l + 4} height={3.5} fill="rgba(8,10,14,0.35)" />
    </Svg>
  );
}

export function Loader({ loader }: { loader: UiState['loader'] }) {
  const { z, tight, landscape } = useUiScale();
  const hop = useRef(new Animated.Value(0)).current;
  const swing = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const stripes = useRef(new Animated.Value(0)).current;
  const sweep = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(0)).current;
  const width = useRef(new Animated.Value(loader.progress)).current;
  const fadeOut = useRef(new Animated.Value(1)).current;
  const tipOpacity = useRef(new Animated.Value(1)).current;
  const intro = useRef(new Animated.Value(0)).current;
  const [pct, setPct] = useState(Math.round(loader.progress * 100));

  useEffect(() => {
    const ease = Easing.bezier(0.45, 0, 0.55, 1);
    const loops = [
      Animated.loop(Animated.sequence([
        Animated.timing(hop, { toValue: 1, duration: 800, easing: ease, useNativeDriver: true }),
        Animated.timing(hop, { toValue: 0, duration: 800, easing: ease, useNativeDriver: true }),
      ])),
      Animated.loop(Animated.timing(swing, { toValue: 1, duration: 1600, easing: Easing.linear, useNativeDriver: true })),
      Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1600, easing: Easing.linear, useNativeDriver: true })),
      Animated.loop(Animated.timing(stripes, { toValue: 1, duration: 700, easing: Easing.linear, useNativeDriver: true })),
      Animated.loop(Animated.sequence([
        Animated.timing(sweep, { toValue: 1, duration: 3600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.delay(600),
      ])),
      Animated.loop(Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(glow, { toValue: 0, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])),
    ];
    loops.forEach(l => l.start());
    Animated.spring(intro, { toValue: 1, friction: 6, tension: 70, useNativeDriver: true }).start();
    return () => loops.forEach(l => l.stop());
  }, [hop, swing, spin, stripes, sweep, glow, intro]);

  useEffect(() => {
    Animated.timing(width, { toValue: loader.progress, duration: 380, easing: Easing.out(Easing.ease), useNativeDriver: false }).start();
    // count the number up to the new value
    const target = Math.round(loader.progress * 100);
    const t = setInterval(() => setPct(p => (p >= target ? (clearInterval(t), p) : Math.min(target, p + 2))), 16);
    return () => clearInterval(t);
  }, [loader.progress, width]);

  useEffect(() => {
    tipOpacity.setValue(0);
    Animated.timing(tipOpacity, { toValue: 1, duration: 320, useNativeDriver: true }).start();
  }, [loader.tip, tipOpacity]);

  useEffect(() => {
    if (loader.done) Animated.timing(fadeOut, { toValue: 0, duration: 550, useNativeDriver: true }).start();
  }, [loader.done, fadeOut]);

  // paddle + ball scene (sizes in design dp)
  const S = tight ? 0.8 : 1; // a smaller scene on tiny screens
  const ballY = hop.interpolate({ inputRange: [0, 1], outputRange: [0, z(42 * S)] });
  const shadowK = hop.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] });
  const shadowO = hop.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.9] });
  const rot = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const paddleRot = swing.interpolate({ inputRange: [0, 0.45, 0.5, 0.6, 1], outputRange: ['-6deg', '-6deg', '4deg', '-4deg', '-6deg'] });
  const paddleY = swing.interpolate({ inputRange: [0, 0.45, 0.5, 0.6, 1], outputRange: [0, 0, -z(6), 0, 0] });
  const stripeX = stripes.interpolate({ inputRange: [0, 1], outputRange: [-z(32), 0] });
  const barW = width.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const introY = intro.interpolate({ inputRange: [0, 1], outputRange: [24, 0] });
  const sweepX = sweep.interpolate({ inputRange: [0, 1], outputRange: [-500, 1500] });
  const spot = glow.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });
  const steps = 6;
  const doneSteps = Math.min(steps, Math.round(loader.progress * steps));
  const scene = { w: z(160 * S), h: z(130 * S) };

  return (
    <Animated.View style={[StyleSheet.absoluteFill, s.root, { opacity: fadeOut }]} pointerEvents={loader.done ? 'none' : 'auto'}>
      {/* arena: deep navy, a blue spotlight from above, the court in perspective */}
      <Svg style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="ldBg" cx="50%" cy="0%" r="95%">
            <Stop offset="0" stopColor="#1d2d44" />
            <Stop offset="0.8" stopColor="#070b12" />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#ldBg)" />
      </Svg>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: spot }]} pointerEvents="none">
        <Svg style={StyleSheet.absoluteFill}>
          <Defs>
            <RadialGradient id="ldSpot" cx="50%" cy="30%" r="55%">
              <Stop offset="0" stopColor="#2e8fe0" stopOpacity="0.42" />
              <Stop offset="1" stopColor="#2e8fe0" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#ldSpot)" />
        </Svg>
      </Animated.View>
      <ArenaCourt />
      <Animated.View pointerEvents="none" style={[s.sweep, { transform: [{ translateX: sweepX }, { rotate: '18deg' }] }]} />

      <Animated.View style={[s.inner, { maxWidth: z(landscape ? 480 : 420), opacity: intro, transform: [{ translateY: introY }] }]}>
        <View style={[s.scene, { width: scene.w, height: scene.h }]}>
          <Animated.View style={[s.shadow, {
            left: z(60 * S), top: z(112 * S), width: z(40 * S), height: z(9 * S),
            opacity: shadowO, transform: [{ scaleX: shadowK }, { scaleY: shadowK }],
          }]} />
          <Animated.View style={[s.paddle, { left: z(80 * S), top: z(88 * S), transform: [{ translateY: paddleY }, { rotate: paddleRot }] }]}>
            <View style={[s.handle, { left: z(26 * S), top: -z(5 * S), width: z(30 * S), height: z(10 * S) }]} />
            <View style={[s.face, { left: -z(30 * S), top: -z(14 * S), width: z(60 * S), height: z(28 * S), borderRadius: z(13 * S) }]}>
              <Svg style={StyleSheet.absoluteFill}>
                <Defs>
                  <LinearGradient id="ldFace" x1="0" y1="0" x2="1" y2="1">
                    <Stop offset="0" stopColor="#0b3d5c" />
                    <Stop offset="1" stopColor="#1fa2b8" />
                  </LinearGradient>
                </Defs>
                <Rect width="100%" height="100%" fill="url(#ldFace)" />
              </Svg>
              <View style={s.faceShine} />
            </View>
          </Animated.View>
          <Animated.View style={[s.ball, {
            left: z(63 * S), width: z(34 * S), height: z(34 * S), borderRadius: z(17 * S),
            transform: [{ translateY: ballY }, { rotate: rot }],
          }]}>
            <View style={[s.dot, { left: z(7 * S), top: z(11 * S), width: z(5 * S), height: z(5 * S), borderRadius: z(3) }]} />
            <View style={[s.dot, { left: z(19 * S), top: z(7 * S), width: z(5 * S), height: z(5 * S), borderRadius: z(3) }]} />
            <View style={[s.dot, { left: z(16 * S), top: z(21 * S), width: z(5 * S), height: z(5 * S), borderRadius: z(3) }]} />
          </Animated.View>
        </View>

        <Brand z={z} size={tight ? 32 : 40} ball={false} line="SPORTS ARCADE" center />

        {/* progress */}
        <View style={{ marginTop: z(tight ? 10 : 16), gap: z(6) }}>
          <View style={[s.row, { justifyContent: 'space-between' }]}>
            <Text style={[s.status, { fontSize: z(13) }]} numberOfLines={1}>{loader.status}</Text>
            <Text style={[s.pct, { fontSize: z(15) }]}>{`${pct}%`}</Text>
          </View>
          <View style={[s.bar, { height: z(14), borderRadius: z(7) }]} accessibilityRole="progressbar">
            <Animated.View style={[s.fill, { width: barW, borderRadius: z(7) }]}>
              <Svg style={StyleSheet.absoluteFill}>
                <Defs>
                  <LinearGradient id="ldFill" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0" stopColor="#1f6fd1" />
                    <Stop offset="0.6" stopColor="#21c7b5" />
                    <Stop offset="1" stopColor={C.accent} />
                  </LinearGradient>
                </Defs>
                <Rect width="100%" height="100%" fill="url(#ldFill)" />
              </Svg>
              <Animated.View style={[s.stripes, { transform: [{ translateX: stripeX }] }]}>
                {Array.from({ length: 40 }, (_, i) => <View key={i} style={[s.stripe, { width: z(8), marginRight: z(8) }]} />)}
              </Animated.View>
              <View style={s.fillShine} />
            </Animated.View>
          </View>
          <View style={[s.row, { gap: z(5) }]}>
            {Array.from({ length: steps }, (_, i) => (
              <View key={i} style={[s.stepDot, i < doneSteps && s.stepDotOn, { height: z(3), borderRadius: z(2) }]} />
            ))}
          </View>
        </View>

        {/* tip */}
        {!tight && (
          <View style={[s.tipCard, { marginTop: z(14), padding: z(10), borderRadius: z(14), gap: z(4) }]}>
            <View style={[s.row, { gap: z(6) }]}>
              <Icon name="bolt" size={z(13)} color={C.accent} />
              <SectionTitle text="PRO TIP" z={z} />
            </View>
            <Animated.Text style={[s.tip, { opacity: tipOpacity, fontSize: z(13), lineHeight: z(18) }]}>
              {loader.tip.replace(/^Tip:\s*/, '')}
            </Animated.Text>
          </View>
        )}
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  root: { zIndex: 1000, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: C.bgDeep },
  inner: { width: '100%', alignItems: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'center' },
  sweep: { position: 'absolute', top: -200, bottom: -200, width: 120, backgroundColor: 'rgba(255,255,255,0.05)' },
  scene: { alignSelf: 'center', marginBottom: 4 },
  ball: {
    position: 'absolute', top: 0, backgroundColor: '#e3f05a',
    borderWidth: 3, borderColor: '#d2e23a', overflow: 'hidden', zIndex: 2, elevation: 8,
  },
  dot: { position: 'absolute', backgroundColor: 'rgba(90,100,0,0.6)' },
  shadow: { position: 'absolute', borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)' },
  paddle: { position: 'absolute', width: 0, height: 0 },
  face: { position: 'absolute', borderWidth: 3, borderColor: '#0b2a40', overflow: 'hidden', elevation: 6 },
  faceShine: { position: 'absolute', left: 0, right: 0, top: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.18)' },
  handle: { position: 'absolute', borderRadius: 4, backgroundColor: '#0f3149' },
  status: { color: C.text, fontWeight: '800', flex: 1 },
  pct: { color: C.accent, fontWeight: '900', fontVariant: ['tabular-nums'] },
  bar: { backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', overflow: 'hidden' },
  fill: { height: '100%', overflow: 'hidden' },
  fillShine: { position: 'absolute', left: 0, right: 0, top: 0, height: '45%', backgroundColor: 'rgba(255,255,255,0.18)' },
  stripes: { position: 'absolute', top: -6, bottom: -6, left: 0, flexDirection: 'row' },
  stripe: { backgroundColor: 'rgba(255,255,255,0.2)', transform: [{ skewX: '-25deg' }] },
  stepDot: { flex: 1, backgroundColor: 'rgba(255,255,255,0.12)' },
  stepDotOn: { backgroundColor: C.accent },
  tipCard: { backgroundColor: 'rgba(20,31,48,0.82)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  tip: { color: '#d3dde8', fontWeight: '600' },
});
