// Building blocks that match the browser game's CSS components
// (.overlay, .card, .btn, .back-btn, .label, h1 gradient title, canvases).
import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { Canvas, Picture, Skia } from '@shopify/react-native-skia';
import Svg, { Defs, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';
import { Ctx2D } from '../game/canvas2d';
import { C } from './theme';

/** Full-screen dimmed layer with a centred, scrollable card area (.overlay). */
export function Overlay({ children, z = 5 }: { children: React.ReactNode; z?: number }) {
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [fade]);
  return (
    <Animated.View style={[styles.overlay, { zIndex: z, opacity: fade }]}>
      <ScrollView
        contentContainerStyle={styles.overlayScroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        overScrollMode="never">
        {children}
      </ScrollView>
    </Animated.View>
  );
}

/** The menu card, popping in like the CSS cardIn animation. */
export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(a, { toValue: 1, friction: 6, tension: 90, useNativeDriver: true }).start();
  }, [a]);
  const translateY = a.interpolate({ inputRange: [0, 1], outputRange: [24, 0] });
  const scale = a.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] });
  return <Animated.View style={[styles.card, style, { opacity: a, transform: [{ translateY }, { scale }] }]}>{children}</Animated.View>;
}

/** Pressable that shrinks slightly while held (:active transforms in the CSS). */
export function Tap({
  onPress, style, children, scale = 0.96, disabled, accessibilityLabel,
}: {
  onPress?: () => void; style?: StyleProp<ViewStyle>; children: React.ReactNode; scale?: number; disabled?: boolean; accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [style, pressed && { transform: [{ scale }] }]}>
      {children}
    </Pressable>
  );
}

/** .btn (lime) / .btn.secondary (outlined) */
export function Btn({
  title, onPress, secondary, small, style, textStyle,
}: { title: string; onPress?: () => void; secondary?: boolean; small?: boolean; style?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle> }) {
  return (
    <Tap onPress={onPress} style={[styles.btn, secondary && styles.btnSecondary, small && styles.btnSmall, style]}>
      <Text style={[styles.btnText, secondary && { color: C.text }, small && { fontSize: 13 }, textStyle]}>{title}</Text>
    </Tap>
  );
}

/** ‹ Back arrow (same look on every screen). */
export function BackButton({ onPress, inline, label = 'Back' }: { onPress: () => void; inline?: boolean; label?: string }) {
  return (
    <Tap onPress={onPress} scale={0.92} accessibilityLabel={label} style={[styles.back, inline ? null : styles.backAbs]}>
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path d="M15 5l-7 7 7 7" fill="none" stroke={C.text} strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
      <Text style={styles.backText}>Back</Text>
    </Tap>
  );
}

/** The game's title with the lime → mint → blue gradient (h1). */
export function GradientTitle({ text, size }: { text: string; size: number }) {
  const width = text.length * size * 0.62 + 8;
  const height = size * 1.3;
  return (
    <Svg width={width} height={height} style={{ alignSelf: 'center' }}>
      <Defs>
        <LinearGradient id="titleGrad" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#d7f23b" />
          <Stop offset="0.45" stopColor="#7cf2c4" />
          <Stop offset="0.8" stopColor="#3aa0ff" />
          <Stop offset="1" stopColor="#d7f23b" />
        </LinearGradient>
      </Defs>
      <SvgText
        x={width / 2}
        y={size * 1.02}
        fontSize={size}
        fontWeight="bold"
        textAnchor="middle"
        letterSpacing={size * 0.02}
        fill="url(#titleGrad)">
        {text}
      </SvgText>
    </Svg>
  );
}

/** Static drawing made with the Canvas-2D-style API (portraits, paddles, previews). */
export function Drawing({
  width, height, draw, deps, style,
}: { width: number; height: number; draw: (ctx: Ctx2D) => void; deps: unknown[]; style?: StyleProp<ViewStyle> }) {
  const picture = useMemo(() => {
    const rec = Skia.PictureRecorder();
    const canvas = rec.beginRecording(Skia.XYWHRect(0, 0, width, height));
    draw(new Ctx2D(canvas));
    return rec.finishRecordingAsPicture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, ...deps]);
  return (
    <Canvas style={[{ width, height }, style]}>
      <Picture picture={picture} />
    </Canvas>
  );
}

/** Small uppercase section label (.label) */
export function Label({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.label, style]}>{children}</Text>;
}

/** <details>/<summary> */
export function Details({ summary, children }: { summary: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <View style={styles.details}>
      <Pressable onPress={() => setOpen(o => !o)} accessibilityRole="button">
        <Text style={styles.summary}>{open ? '▾' : '▸'} {summary}</Text>
      </Pressable>
      {open ? <View style={styles.list}>{children}</View> : null}
    </View>
  );
}

/** One line in a <details> list; supports **bold** segments. */
export function Li({ text }: { text: string }) {
  const parts = text.split('**');
  return (
    <Text style={styles.li}>
      {parts.map((p, i) => (i % 2 ? <Text key={i} style={styles.bold}>{p}</Text> : p))}
    </Text>
  );
}

export const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: C.overlay },
  overlayScroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 8 },
  card: {
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 16,
    padding: 20,
    maxWidth: 360,
    width: '100%',
    alignItems: 'stretch',
    elevation: 16,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 20 },
  },
  btn: {
    backgroundColor: C.accent,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  btnSmall: { paddingVertical: 7, paddingHorizontal: 12 },
  btnText: { color: '#111', fontWeight: '800', fontSize: 16 },
  back: {
    height: 40,
    paddingLeft: 8,
    paddingRight: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignSelf: 'flex-start',
  },
  backAbs: { position: 'absolute', top: 12, left: 12, zIndex: 1 },
  backText: { color: C.text, fontSize: 14, fontWeight: '800', letterSpacing: 0.3 },
  label: { fontSize: 12, textTransform: 'uppercase', letterSpacing: 1.2, color: C.muted, marginTop: 12, textAlign: 'center' },
  details: { marginTop: 14 },
  summary: { fontWeight: '700', color: C.muted, fontSize: 13 },
  list: { marginTop: 8, gap: 6 },
  li: { color: C.text, fontSize: 13, lineHeight: 18 },
  bold: { fontWeight: '800' },
});
