// Loading screen: ball bouncing off a swinging paddle, a progress bar driven by
// the real setup steps, and rotating tips (same as the browser game's #loader).
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import type { UiState } from '../game/engine';
import { GradientTitle } from './common';
import { C } from './theme';

export function Loader({ loader }: { loader: UiState['loader'] }) {
  const hop = useRef(new Animated.Value(0)).current;
  const swing = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const stripes = useRef(new Animated.Value(0)).current;
  const width = useRef(new Animated.Value(loader.progress)).current;
  const fadeOut = useRef(new Animated.Value(1)).current;
  const tipOpacity = useRef(new Animated.Value(1)).current;
  const intro = useRef(new Animated.Value(0)).current;

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
    ];
    loops.forEach(l => l.start());
    Animated.spring(intro, { toValue: 1, friction: 6, tension: 80, useNativeDriver: true }).start();
    return () => loops.forEach(l => l.stop());
  }, [hop, swing, spin, stripes, intro]);

  useEffect(() => {
    Animated.timing(width, { toValue: loader.progress, duration: 350, easing: Easing.out(Easing.ease), useNativeDriver: false }).start();
  }, [loader.progress, width]);

  useEffect(() => {
    tipOpacity.setValue(0);
    Animated.timing(tipOpacity, { toValue: 1, duration: 300, useNativeDriver: true }).start();
  }, [loader.tip, tipOpacity]);

  useEffect(() => {
    if (loader.done) Animated.timing(fadeOut, { toValue: 0, duration: 550, useNativeDriver: true }).start();
  }, [loader.done, fadeOut]);

  const ballY = hop.interpolate({ inputRange: [0, 1], outputRange: [0, 42] });
  const shadowK = hop.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] });
  const shadowO = hop.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.9] });
  const rot = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  // keyframes: 0-45% rest, 50% "pock" as the ball lands, 60% recoil
  const paddleRot = swing.interpolate({ inputRange: [0, 0.45, 0.5, 0.6, 1], outputRange: ['-6deg', '-6deg', '4deg', '-4deg', '-6deg'] });
  const paddleY = swing.interpolate({ inputRange: [0, 0.45, 0.5, 0.6, 1], outputRange: [0, 0, -6, 0, 0] });
  const stripeX = stripes.interpolate({ inputRange: [0, 1], outputRange: [-32, 0] });
  const barW = width.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const introY = intro.interpolate({ inputRange: [0, 1], outputRange: [24, 0] });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, s.root, { opacity: fadeOut }]} pointerEvents={loader.done ? 'none' : 'auto'}>
      <Svg style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="ldBg" cx="50%" cy="0%" r="90%">
            <Stop offset="0" stopColor="#1d2d44" />
            <Stop offset="0.75" stopColor="#0b111a" />
          </RadialGradient>
          <RadialGradient id="ldGlow" cx="50%" cy="35%" r="50%">
            <Stop offset="0" stopColor="#2e78c2" stopOpacity="0.35" />
            <Stop offset="1" stopColor="#2e78c2" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#ldBg)" />
        <Rect width="100%" height="100%" fill="url(#ldGlow)" />
      </Svg>
      <Animated.View style={[s.inner, { opacity: intro, transform: [{ translateY: introY }] }]}>
        <View style={s.scene}>
          <Animated.View style={[s.shadow, { opacity: shadowO, transform: [{ scaleX: shadowK }, { scaleY: shadowK }] }]} />
          <Animated.View style={[s.paddle, { transform: [{ translateY: paddleY }, { rotate: paddleRot }] }]}>
            <View style={s.handle} />
            <View style={s.face}>
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
          <Animated.View style={[s.ball, { transform: [{ translateY: ballY }, { rotate: rot }] }]}>
            <View style={[s.dot, { left: 7, top: 11 }]} />
            <View style={[s.dot, { left: 19, top: 7 }]} />
            <View style={[s.dot, { left: 16, top: 21 }]} />
          </Animated.View>
        </View>
        <GradientTitle text="Pickleball" size={40} />
        <View style={s.bar} accessibilityRole="progressbar">
          <Animated.View style={[s.fill, { width: barW }]}>
            <Svg style={StyleSheet.absoluteFill}>
              <Defs>
                <LinearGradient id="ldFill" x1="0" y1="0" x2="1" y2="0">
                  <Stop offset="0" stopColor={C.you} />
                  <Stop offset="1" stopColor={C.accent} />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill="url(#ldFill)" />
            </Svg>
            <Animated.View style={[s.stripes, { transform: [{ translateX: stripeX }] }]}>
              {Array.from({ length: 30 }, (_, i) => <View key={i} style={s.stripe} />)}
            </Animated.View>
          </Animated.View>
        </View>
        <Text style={s.status}>{loader.status}</Text>
        <Animated.Text style={[s.tip, { opacity: tipOpacity }]}>{loader.tip}</Animated.Text>
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  root: { zIndex: 1000, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: C.bgDeep },
  inner: { width: '100%', maxWidth: 320, alignItems: 'stretch' },
  scene: { height: 130, width: 160, alignSelf: 'center', marginBottom: 6 },
  ball: {
    position: 'absolute', left: 63, top: 0, width: 34, height: 34, borderRadius: 17, backgroundColor: '#e3f05a',
    borderWidth: 3, borderColor: '#d2e23a', overflow: 'hidden', zIndex: 2,
    shadowColor: C.accent, shadowOpacity: 0.55, shadowRadius: 22, elevation: 8,
  },
  dot: { position: 'absolute', width: 5, height: 5, borderRadius: 2.5, backgroundColor: 'rgba(90,100,0,0.6)' },
  shadow: { position: 'absolute', left: 60, top: 112, width: 40, height: 9, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.45)' },
  paddle: { position: 'absolute', left: 80, top: 88, width: 0, height: 0 },
  face: {
    position: 'absolute', left: -30, top: -14, width: 60, height: 28,
    borderTopLeftRadius: 14, borderTopRightRadius: 14, borderBottomLeftRadius: 12, borderBottomRightRadius: 12,
    borderWidth: 3, borderColor: '#0b2a40', overflow: 'hidden', elevation: 6,
  },
  faceShine: { position: 'absolute', left: 0, right: 0, top: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.18)' },
  handle: {
    position: 'absolute', left: 26, top: -5, width: 30, height: 10,
    borderTopLeftRadius: 3, borderBottomLeftRadius: 3, borderTopRightRadius: 5, borderBottomRightRadius: 5,
    backgroundColor: '#0f3149',
  },
  bar: {
    height: 12, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', overflow: 'hidden', marginTop: 12,
  },
  fill: { height: '100%', borderRadius: 6, overflow: 'hidden' },
  stripes: { position: 'absolute', top: -6, bottom: -6, left: 0, flexDirection: 'row' },
  stripe: { width: 8, marginRight: 8, backgroundColor: 'rgba(255,255,255,0.22)', transform: [{ skewX: '-25deg' }] },
  status: { marginTop: 10, fontSize: 14, fontWeight: '700', color: C.text, textAlign: 'center', minHeight: 18 },
  tip: { marginTop: 14, minHeight: 36, fontSize: 13, lineHeight: 18, color: C.muted, textAlign: 'center' },
});
