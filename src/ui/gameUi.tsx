// Shared building blocks for the full-screen menus (main menu, Play Online):
// one scale factor from the screen size, vector icons, segmented buttons, the
// backdrop over the live court, panels and a full-screen frame with a header.
import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated, Easing, ScrollView, StyleProp, StyleSheet, Text, TextInput, TextInputProps, useWindowDimensions, View, ViewStyle,
} from 'react-native';
import Svg, { Circle, Defs, LinearGradient as SvgGradient, Path, Rect, Stop } from 'react-native-svg';
import { GradientTitle as GradientTitleShared, Tap } from './common';
import { C } from './theme';

// ---------------------------------------------------------------------------
// Sizing: one scale factor from the screen, applied to every size
// ---------------------------------------------------------------------------
export interface UiScale {
  u: number; landscape: boolean; tight: boolean; width: number; height: number;
  /** a size in "design dp" scaled to this screen */
  z: (n: number) => number;
}
export function useUiScale(): UiScale {
  const { width, height } = useWindowDimensions();
  return useMemo(() => {
    const landscape = width >= height;
    // designed for a 760 x 400 dp landscape phone; tablets get bigger, tiny phones smaller
    const u = Math.max(0.74, Math.min(1.55, Math.min(width / 760, height / 400)));
    // only really tiny screens drop decorative extras
    const tight = landscape && height < 340;
    return { u, landscape, tight, width, height, z: (n: number) => Math.round(n * u) };
  }, [width, height]);
}

// ---------------------------------------------------------------------------
// Vector icons
// ---------------------------------------------------------------------------
export type IconName =
  | 'play' | 'globe' | 'history' | 'trophy' | 'user' | 'users' | 'book' | 'list' | 'edit' | 'voice' | 'pause'
  | 'back' | 'search' | 'plus' | 'enter' | 'door' | 'check' | 'bolt' | 'close' | 'mail' | 'refresh' | 'crown' | 'lock';
export function Icon({ name, size, color = '#fff', fill }: { name: IconName; size: number; color?: string; fill?: string }) {
  const p = { stroke: color, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'play' && <Path d="M8 5l11 7-11 7z" fill={fill ?? color} stroke="none" />}
      {name === 'pause' && <><Rect x="6" y="5" width="4" height="14" rx="1" fill={color} /><Rect x="14" y="5" width="4" height="14" rx="1" fill={color} /></>}
      {name === 'globe' && <><Circle cx="12" cy="12" r="9" {...p} /><Path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" {...p} /></>}
      {name === 'history' && <><Circle cx="12" cy="12" r="9" {...p} /><Path d="M12 7v5l3.5 2" {...p} /></>}
      {name === 'trophy' && <Path d="M7 4h10v4a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3.5 4M17 6h3a3 3 0 0 1-3.5 4M12 13v4M8 20h8M10 17h4" {...p} />}
      {name === 'user' && <><Circle cx="12" cy="8" r="4" {...p} /><Path d="M4 21a8 8 0 0 1 16 0" {...p} /></>}
      {name === 'users' && <><Circle cx="9" cy="8" r="3.5" {...p} /><Path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" {...p} /></>}
      {name === 'book' && <Path d="M3 5.5A2.5 2.5 0 0 1 5.5 3H11v17H5.5A2.5 2.5 0 0 0 3 22.5zM21 5.5A2.5 2.5 0 0 0 18.5 3H13v17h5.5a2.5 2.5 0 0 1 2.5 2.5z" {...p} />}
      {name === 'list' && <><Path d="M9 6h11M9 12h11M9 18h11" {...p} /><Circle cx="4.5" cy="6" r="1.2" fill={color} /><Circle cx="4.5" cy="12" r="1.2" fill={color} /><Circle cx="4.5" cy="18" r="1.2" fill={color} /></>}
      {name === 'edit' && <Path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" {...p} />}
      {name === 'voice' && <Path d="M4 9h4l5-4v14l-5-4H4zM16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11" {...p} />}
      {name === 'back' && <Path d="M15 5l-7 7 7 7" {...p} strokeWidth={2.6} />}
      {name === 'search' && <><Circle cx="11" cy="11" r="7" {...p} /><Path d="M16.5 16.5L21 21" {...p} /></>}
      {name === 'plus' && <Path d="M12 5v14M5 12h14" {...p} strokeWidth={2.6} />}
      {name === 'enter' && <Path d="M10 17l5-5-5-5M15 12H3M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" {...p} />}
      {name === 'door' && <Path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h8M10 12h11M18 9l3 3-3 3" {...p} />}
      {name === 'check' && <Path d="M5 12.5l4.5 4.5L19 7" {...p} strokeWidth={2.6} />}
      {name === 'bolt' && <Path d="M13 2L4 14h7l-1 8 9-12h-7z" fill={fill ?? color} stroke="none" />}
      {name === 'close' && <Path d="M6 6l12 12M18 6L6 18" {...p} strokeWidth={2.6} />}
      {name === 'mail' && <><Rect x="3" y="5" width="18" height="14" rx="2" {...p} /><Path d="M3.5 6.5l8.5 6 8.5-6" {...p} /></>}
      {name === 'refresh' && <Path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" {...p} />}
      {name === 'lock' && <><Rect x="5" y="11" width="14" height="10" rx="2" {...p} /><Path d="M8 11V8a4 4 0 0 1 8 0v3" {...p} /></>}
      {name === 'crown' && <Path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z" {...p} />}
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
/** A segmented control (mode / difficulty / tabs). */
export function Segments<T extends string>({ value, options, onPick, z }: {
  value: T; options: { v: T; label: string; sub?: string; level?: number }[]; onPick: (v: T) => void; z: (n: number) => number;
}) {
  return (
    <View style={[s.seg, { padding: z(3), borderRadius: z(12), gap: z(4) }]}>
      {options.map(o => {
        const on = o.v === value;
        return (
          <Tap key={o.v} onPress={() => onPick(o.v)} scale={0.95}
            style={[s.segBtn, { paddingVertical: z(o.sub ? 6 : 9), borderRadius: z(9) }, on && s.segOn]}>
            <View style={s.row}>
              {o.level !== undefined && (
                <View style={[s.bars, { gap: z(2), height: z(12), marginRight: z(6) }]}>
                  {[1, 2, 3].map(n => (
                    <View key={n} style={{
                      width: z(3.5), height: z(3 + n * 3), borderRadius: z(1.5),
                      backgroundColor: n <= (o.level as number) ? (on ? '#111' : C.accent) : (on ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.22)'),
                    }} />
                  ))}
                </View>
              )}
              <Text style={[s.segText, { fontSize: z(o.sub ? 17 : 14) }, on && s.segTextOn]}>{o.label}</Text>
            </View>
            {o.sub ? <Text style={[s.segSub, { fontSize: z(9.5) }, on && s.segTextOn]}>{o.sub}</Text> : null}
          </Tap>
        );
      })}
    </View>
  );
}

const GRADS = {
  lime: ['#f0ff7a', '#b9d313'],
  blue: ['#1f6fd1', '#21c7b5'],
  red: ['#e05050', '#b62f2f'],
} as const;

/**
 * A big gradient action button (PLAY, QUICK MATCH, START…) with an icon in a disc,
 * a title and an optional line under it.
 */
export function GameButton({ title, sub, icon, color = 'lime', onPress, disabled, glow, z, height = 60, compact, badge, live, titleSize }: {
  title: string; sub?: string; icon: IconName; color?: keyof typeof GRADS; onPress?: () => void; disabled?: boolean;
  glow?: boolean; z: (n: number) => number; height?: number; compact?: boolean;
  /** small pill on the right (e.g. "2 invites", "Rejoin"); otherwise a › chevron */
  badge?: string;
  /** green "live" dot before the subtitle */
  live?: boolean;
  /** title size in design dp (default 20; the main actions PLAY / RESUME use 24) */
  titleSize?: number;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!glow || disabled) return;
    const a = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    a.start();
    return () => a.stop();
  }, [glow, disabled, pulse]);
  const [c0, c1] = GRADS[color];
  const dark = color === 'lime';
  const id = `gb-${color}`;
  return (
    <View style={s.btnWrap}>
      {glow && !disabled && (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, {
          borderRadius: z(18), backgroundColor: c1, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.5] }),
          transform: [{ scaleX: 1.03 }, { scaleY: 1.12 }],
        }]} />
      )}
      <Tap onPress={disabled ? undefined : onPress} disabled={disabled} scale={0.97} accessibilityLabel={title}
        style={[s.bigBtn, { minHeight: z(compact ? height - 12 : height), borderRadius: z(15), paddingHorizontal: z(14), gap: z(12) },
          disabled && s.disabled]}>
        <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none" viewBox="0 0 100 100">
          <Defs>
            <SvgGradient id={id} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={c0} />
              <Stop offset="1" stopColor={c1} />
            </SvgGradient>
          </Defs>
          <Rect x="0" y="0" width="100" height="100" fill={`url(#${id})`} />
        </Svg>
        <View style={[s.btnDisc, dark ? s.btnDiscDark : s.btnDiscLight, { width: z(compact ? 34 : 42), height: z(compact ? 34 : 42), borderRadius: z(21) }]}>
          <Icon name={icon} size={z(compact ? 17 : 21)} color={dark ? C.accent : '#fff'} />
        </View>
        <View style={s.flex1}>
          <Text style={[s.btnTitle, { fontSize: z(titleSize ?? (compact ? 16 : 20)), color: dark ? '#0b111a' : '#fff' }]} numberOfLines={1}>{title}</Text>
          {sub ? (
            <View style={[s.row, { gap: z(6) }]}>
              {live && <View style={[s.liveDot, { width: z(8), height: z(8), borderRadius: z(4) }]} />}
              <Text style={[s.btnSub, { fontSize: z(11), color: dark ? 'rgba(11,17,26,0.75)' : 'rgba(255,255,255,0.9)' }]} numberOfLines={1}>{sub}</Text>
            </View>
          ) : null}
        </View>
        {badge ? (
          <View style={[s.btnBadge, dark ? s.btnBadgeDark : null, { borderRadius: z(10), paddingHorizontal: z(8), paddingVertical: z(4) }]}>
            <Text style={[s.btnBadgeText, dark ? s.btnBadgeTextDark : null, { fontSize: z(11) }]}>{badge}</Text>
          </View>
        ) : !disabled ? (
          <Text style={[s.chev, { fontSize: z(30), color: dark ? 'rgba(11,17,26,0.55)' : 'rgba(255,255,255,0.85)' }]}>›</Text>
        ) : null}
        {/* glossy top highlight */}
        <View pointerEvents="none" style={[s.gloss, { height: '45%', borderTopLeftRadius: z(13), borderTopRightRadius: z(13) }]} />
      </Tap>
    </View>
  );
}

/** Outlined secondary button with an icon. */
export function GhostButton({ title, icon, onPress, z, danger, style, small }: {
  title: string; icon?: IconName; onPress?: () => void; z: (n: number) => number; danger?: boolean;
  style?: StyleProp<ViewStyle>; small?: boolean;
}) {
  const color = danger ? '#ff8a8a' : C.text;
  return (
    <Tap onPress={onPress} scale={0.96} accessibilityLabel={title}
      style={[s.ghost, danger && s.ghostDanger, { gap: z(7), paddingVertical: z(small ? 7 : 10), paddingHorizontal: z(small ? 10 : 14), borderRadius: z(12) }, style]}>
      {icon && <Icon name={icon} size={z(small ? 14 : 16)} color={color} />}
      <Text style={[s.ghostText, { fontSize: z(small ? 12 : 13.5), color }]} numberOfLines={1}>{title}</Text>
    </Tap>
  );
}

/** Square-ish icon tile. */
export function Tile({ icon, label, onPress, z, badge }: { icon: IconName; label: string; onPress: () => void; z: (n: number) => number; badge?: string }) {
  return (
    <Tap onPress={onPress} scale={0.94} accessibilityLabel={label}
      style={[s.tile, { paddingVertical: z(8), borderRadius: z(14), gap: z(4) }]}>
      <View style={[s.tileIcon, { width: z(30), height: z(30), borderRadius: z(10) }]}>
        <Icon name={icon} size={z(17)} color={C.accent} />
      </View>
      <Text style={[s.tileText, { fontSize: z(11.5) }]} numberOfLines={1}>{label}</Text>
      {badge ? (
        <View style={[s.tileBadge, { top: z(4), right: z(6), paddingHorizontal: z(6), borderRadius: z(8) }]}>
          <Text style={[s.tileBadgeText, { fontSize: z(10) }]}>{badge}</Text>
        </View>
      ) : null}
    </Tap>
  );
}

/** A frosted panel with an optional small caption. */
export function Panel({ title, right, children, z, style, flex }: {
  title?: string; right?: React.ReactNode; children: React.ReactNode; z: (n: number) => number;
  style?: StyleProp<ViewStyle>; flex?: boolean;
}) {
  // A stretching panel fills the space left in landscape; in a scrolling portrait page
  // it gets a sensible height instead (flex would collapse it to nothing there).
  const { landscape } = useUiScale();
  const grow = flex ? (landscape ? s.flexPanel : { minHeight: z(220) }) : null;
  return (
    <View style={[s.panel, { padding: z(10), borderRadius: z(14), gap: z(8) }, grow, style]}>
      <View pointerEvents="none" style={[s.panelEdge, { borderTopLeftRadius: z(14), borderTopRightRadius: z(14) }]} />
      {title || right ? (
        <View style={[s.row, { justifyContent: 'space-between', gap: z(8) }]}>
          {title ? <SectionTitle text={title} z={z} /> : <View />}
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** Small uppercase section caption with a lime accent tick (used by every menu). */
export function SectionTitle({ text, z }: { text: string; z: (n: number) => number }) {
  return (
    // flexShrink (not flex: 1): inside a column (screen headers, sheets) flex: 1 squeezed the
    // caption to zero height, so it was drawn half cut off over the title.
    <View style={[s.row, s.capRow, { gap: z(6) }]}>
      <View style={[s.tick, { width: z(3), height: z(11), borderRadius: z(2) }]} />
      <Text style={[s.kicker, s.capText, { fontSize: z(9.5), lineHeight: z(14) }]} numberOfLines={1}>{text}</Text>
    </View>
  );
}

/**
 * A centred panel over the (paused) game, with the same backdrop and look as the
 * full-screen menus. Slides up into place.
 */
export function MenuSheet({ kicker, title, icon, children, ui, maxWidth = 400, zIndex = 6 }: {
  kicker: string; title: string; icon: IconName; children: React.ReactNode; ui: UiScale; maxWidth?: number; zIndex?: number;
}) {
  const { z } = ui;
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(enter, { toValue: 1, friction: 7, tension: 80, useNativeDriver: true }).start();
  }, [enter]);
  const anim = {
    opacity: enter,
    transform: [
      { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [30, 0] }) },
      { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1] }) },
    ],
  };
  return (
    <View style={[StyleSheet.absoluteFill, s.sheetWrap, { zIndex }]}>
      <Backdrop sweep={!ui.tight} strength={0.9} />
      <ScrollView contentContainerStyle={[s.sheetScroll, { padding: z(16) }]} showsVerticalScrollIndicator={false} bounces={false}>
        <Animated.View style={[s.panel, s.sheet, { maxWidth: z(maxWidth), padding: z(16), borderRadius: z(20), gap: z(12) }, anim]}>
          <View pointerEvents="none" style={[s.panelEdge, { borderTopLeftRadius: z(20), borderTopRightRadius: z(20) }]} />
          <View style={[s.row, { gap: z(12) }]}>
            <View style={[s.sheetIcon, { width: z(44), height: z(44), borderRadius: z(22) }]}>
              <Icon name={icon} size={z(20)} color={C.accent} />
            </View>
            <View style={s.flex1}>
              <SectionTitle text={kicker} z={z} />
              <Text style={[s.title, { fontSize: z(25), lineHeight: z(31) }]} numberOfLines={1}>{title}</Text>
            </View>
          </View>
          {children}
        </Animated.View>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Brand, inputs, rich text
// ---------------------------------------------------------------------------
/** The bouncing, spinning pickleball of the logo. */
export function LogoBall({ size }: { size: number }) {
  const hop = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([
      Animated.timing(hop, { toValue: 1, duration: 900, easing: Easing.bezier(0.5, 0, 0.5, 1), useNativeDriver: true }),
      Animated.timing(hop, { toValue: 0, duration: 900, easing: Easing.bezier(0.5, 0, 0.5, 1), useNativeDriver: true }),
    ]));
    const sp = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1800, easing: Easing.linear, useNativeDriver: true }));
    a.start(); sp.start();
    return () => { a.stop(); sp.stop(); };
  }, [hop, spin]);
  const ty = hop.interpolate({ inputRange: [0, 1], outputRange: [-size * 0.28, size * 0.06] });
  const sh = hop.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const rot = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const d = size * 0.15;
  return (
    <View style={{ width: size * 1.1, height: size * 1.25, alignItems: 'center', justifyContent: 'flex-end' }}>
      <Animated.View style={[s.logoShadow, { width: size * 0.9, height: size * 0.2, borderRadius: size, opacity: sh, transform: [{ scaleX: sh }] }]} />
      <Animated.View style={[s.logoBall, { width: size, height: size, borderRadius: size / 2, bottom: size * 0.12, transform: [{ translateY: ty }, { rotate: rot }] }]}>
        <View style={[s.logoDot, { width: d, height: d, borderRadius: d, left: size * 0.22, top: size * 0.32 }]} />
        <View style={[s.logoDot, { width: d, height: d, borderRadius: d, left: size * 0.58, top: size * 0.22 }]} />
        <View style={[s.logoDot, { width: d, height: d, borderRadius: d, left: size * 0.48, top: size * 0.62 }]} />
      </Animated.View>
    </View>
  );
}

/**
 * The PickleBall: Hyper wordmark: gradient PICKLEBALL, a slanted lime HYPER tag and an
 * optional line beside it. `size` is the title size in design dp.
 */
export function Brand({ z, size = 30, ball = true, line, center }: {
  z: (n: number) => number; size?: number; ball?: boolean; line?: string; center?: boolean;
}) {
  return (
    <View style={[s.row, { gap: z(8) }, center && s.centerRow]}>
      {ball && <LogoBall size={z(size * 1.1)} />}
      <View style={center ? s.centerCol : null}>
        <GradientTitleShared text="PICKLEBALL" size={z(size)} />
        <View style={[s.row, { gap: z(8), marginTop: -z(size * 0.14) }, center && s.centerRow]}>
          <View style={[s.hyperTag, { paddingHorizontal: z(size * 0.28), paddingVertical: z(2), borderRadius: z(6) }]}>
            <Text style={[s.hyperText, { fontSize: z(size * 0.44) }]}>HYPER</Text>
          </View>
          {line ? <Text style={[s.brandLine, { fontSize: z(size * 0.38) }]}>{line}</Text> : null}
        </View>
      </View>
    </View>
  );
}

/** A text field with an icon, a caption, a focus glow and (for passwords) a show/hide eye. */
type FieldProps = { label: string; icon: IconName; z: (n: number) => number; secure?: boolean; error?: boolean }
  & Omit<TextInputProps, 'secureTextEntry' | 'style'>;
export const Field = React.forwardRef<React.ComponentRef<typeof TextInput>, FieldProps>(function Field({ label, icon, z, secure, error, ...input }, ref) {
  const [focused, setFocused] = React.useState(false);
  const [show, setShow] = React.useState(false);
  return (
    <View style={{ gap: z(5) }}>
      <Text style={[s.kicker, { fontSize: z(9.5) }]}>{label}</Text>
      <View style={[s.field, focused && s.fieldFocus, error && s.fieldError, { borderRadius: z(12), paddingHorizontal: z(10), gap: z(8), minHeight: z(46) }]}>
        <Icon name={icon} size={z(17)} color={focused ? C.accent : C.muted} />
        <TextInput
          ref={ref}
          {...input}
          secureTextEntry={secure && !show}
          placeholderTextColor="rgba(238,243,248,0.35)"
          onFocus={e => { setFocused(true); input.onFocus?.(e); }}
          onBlur={e => { setFocused(false); input.onBlur?.(e); }}
          style={[s.fieldInput, { fontSize: z(15.5), paddingVertical: z(8) }]}
        />
        {secure && (
          <Tap onPress={() => setShow(v => !v)} scale={0.9} accessibilityLabel={show ? 'Hide password' : 'Show password'}
            style={[s.eye, { paddingHorizontal: z(8), paddingVertical: z(5), borderRadius: z(8) }]}>
            <Text style={[s.eyeText, { fontSize: z(11) }]}>{show ? 'HIDE' : 'SHOW'}</Text>
          </Tap>
        )}
      </View>
    </View>
  );
});

/** Bullet list; **bold** segments are highlighted. */
export function RichList({ items, z, size = 13.5 }: { items: string[]; z: (n: number) => number; size?: number }) {
  return (
    <View style={{ gap: z(8) }}>
      {items.map(t => (
        <View key={t} style={[s.richRow, { gap: z(9) }]}>
          <View style={[s.richDot, { width: z(6), height: z(6), borderRadius: z(3), marginTop: z(size * 0.5) }]} />
          <Text style={[s.richText, { fontSize: z(size), lineHeight: z(size * 1.45) }]}>
            {t.split('**').map((p, i) => (i % 2 ? <Text key={i} style={s.richBold}>{p}</Text> : p))}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Backdrop and full-screen frame
// ---------------------------------------------------------------------------
/** Dark shade over the live court (left darker), a soft colour wash and a slow light sweep. */
export function Backdrop({ sweep = true, strength = 1 }: { sweep?: boolean; strength?: number }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!sweep) return;
    const a = Animated.loop(Animated.sequence([
      Animated.timing(t, { toValue: 1, duration: 5200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.delay(1800),
    ]));
    a.start();
    return () => a.stop();
  }, [sweep, t]);
  const x = t.interpolate({ inputRange: [0, 1], outputRange: [-400, 1500] });
  const o = (n: number) => String(Math.min(0.97, n * strength));
  return (
    <>
      <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none" viewBox="0 0 100 100" pointerEvents="none">
        <Defs>
          <SvgGradient id="bdShade" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#060a12" stopOpacity={o(0.93)} />
            <Stop offset="0.55" stopColor="#0a1220" stopOpacity={o(0.8)} />
            <Stop offset="1" stopColor="#0a1220" stopOpacity={o(0.62)} />
          </SvgGradient>
          <SvgGradient id="bdGlow" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#1b9fd6" stopOpacity="0.14" />
            <Stop offset="0.5" stopColor="#1b9fd6" stopOpacity="0" />
            <Stop offset="1" stopColor="#d7f23b" stopOpacity="0.1" />
          </SvgGradient>
        </Defs>
        <Rect x="0" y="0" width="100" height="100" fill="url(#bdShade)" />
        <Rect x="0" y="0" width="100" height="100" fill="url(#bdGlow)" />
      </Svg>
      {sweep && <Animated.View pointerEvents="none" style={[s.sweep, { transform: [{ translateX: x }, { rotate: '18deg' }] }]} />}
    </>
  );
}

/**
 * A full-screen page: backdrop, a header (‹ Back pill, small caption, title, right
 * slot) and a body that fills the rest of the screen. In landscape the body is laid
 * out by the page (two columns that fit); in portrait it scrolls as one column.
 */
export function ScreenFrame({ title, kicker, onBack, right, children, ui, zIndex = 7, fill }: {
  title: string; kicker?: string; onBack: () => void; right?: React.ReactNode; children: React.ReactNode;
  ui: UiScale; zIndex?: number;
  /** list pages: the body always fills the screen (lists scroll inside their panel) */
  fill?: boolean;
}) {
  const { z, landscape, tight } = ui;
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [enter]);
  const anim = { opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] };
  const body = landscape || fill
    ? <View style={[s.body, !landscape && { gap: z(10) }]}>{children}</View>
    : <ScrollView style={s.body} contentContainerStyle={{ gap: z(10), paddingBottom: z(10) }} showsVerticalScrollIndicator={false}>{children}</ScrollView>;
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex }]}>
      <Backdrop sweep={!tight} strength={1.05} />
      <Animated.View style={[s.frame, { paddingHorizontal: z(16), paddingTop: z(tight ? 6 : 10), paddingBottom: z(tight ? 8 : 12) }, anim]}>
        {/* header; leaves room for the mute button in the top-right corner */}
        <View style={[s.row, { gap: z(12), marginBottom: z(tight ? 6 : 10), paddingRight: 46 }]}>
          <Tap onPress={onBack} scale={0.92} accessibilityLabel="Back"
            style={[s.back, { gap: z(4), height: z(38), paddingLeft: z(8), paddingRight: z(12), borderRadius: z(12) }]}>
            <Icon name="back" size={z(18)} color={C.text} />
            <Text style={[s.backText, { fontSize: z(13) }]}>Back</Text>
          </Tap>
          <View style={s.flex1}>
            {kicker ? <SectionTitle text={kicker} z={z} /> : null}
            <Text style={[s.title, { fontSize: z(22), lineHeight: z(28) }]} numberOfLines={1}>{title}</Text>
          </View>
          {right}
        </View>
        {body}
      </Animated.View>
    </View>
  );
}

/** Two columns in landscape (left ~45%), stacked in portrait. */
export function Columns({ left, right, ui, ratio = 0.9 }: { left: React.ReactNode; right: React.ReactNode; ui: UiScale; ratio?: number }) {
  const { z, landscape } = ui;
  if (!landscape) return <View style={[s.stack, { gap: z(10) }]}>{left}{right}</View>;
  return (
    <View style={[s.cols, { gap: z(14) }]}>
      <View style={[s.colL, { flex: ratio, gap: z(10) }]}>{left}</View>
      <View style={[s.colR, { gap: z(10) }]}>{right}</View>
    </View>
  );
}

export const shared = StyleSheet.create({
  kicker: { color: C.muted, fontWeight: '900', letterSpacing: 1.4 },
});

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex1: { flex: 1, minWidth: 0 },
  frame: { flex: 1 },
  body: { flex: 1, minHeight: 0 },
  cols: { flex: 1, flexDirection: 'row', minHeight: 0 },
  stack: { flexGrow: 1 },
  colL: { minWidth: 0, minHeight: 0 },
  colR: { flex: 1.1, minWidth: 0, minHeight: 0 },
  sweep: { position: 'absolute', top: -120, bottom: -120, width: 90, backgroundColor: 'rgba(255,255,255,0.045)' },
  back: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', backgroundColor: 'rgba(255,255,255,0.07)',
  },
  backText: { color: C.text, fontWeight: '800', letterSpacing: 0.3 },
  title: { color: C.text, fontWeight: '900', includeFontPadding: false },
  capRow: { flexShrink: 1, minWidth: 0 },
  capText: { flexShrink: 1, includeFontPadding: false },
  kicker: { color: C.muted, fontWeight: '900', letterSpacing: 1.4 },
  seg: { flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.32)' },
  segBtn: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: C.accent },
  bars: { flexDirection: 'row', alignItems: 'flex-end' },
  segText: { color: C.text, fontWeight: '900', letterSpacing: 0.3 },
  segSub: { color: C.muted, fontWeight: '800', letterSpacing: 1.1 },
  segTextOn: { color: '#111' },
  btnWrap: { justifyContent: 'center' },
  bigBtn: { flexDirection: 'row', alignItems: 'center', overflow: 'hidden', elevation: 8, borderWidth: 2, borderColor: 'rgba(255,255,255,0.4)' },
  disabled: { opacity: 0.45 },
  btnDisc: { alignItems: 'center', justifyContent: 'center' },
  btnDiscDark: { backgroundColor: '#0b111a' },
  btnDiscLight: { backgroundColor: 'rgba(255,255,255,0.2)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.45)' },
  btnTitle: { fontWeight: '900', letterSpacing: 1.4 },
  btnSub: { fontWeight: '800' },
  ghost: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', backgroundColor: 'rgba(255,255,255,0.06)',
  },
  ghostDanger: { borderColor: 'rgba(255,93,93,0.5)', backgroundColor: 'rgba(255,93,93,0.08)' },
  ghostText: { fontWeight: '800' },
  tile: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(23,34,51,0.85)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  tileIcon: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(215,242,59,0.12)' },
  tileText: { color: C.text, fontWeight: '800' },
  tileBadge: { position: 'absolute', backgroundColor: C.accent },
  tileBadgeText: { color: '#111', fontWeight: '900' },
  logoBall: { position: 'absolute', backgroundColor: '#e3f05a', overflow: 'hidden', borderWidth: 2, borderColor: '#d2e23a', elevation: 6 },
  logoDot: { position: 'absolute', backgroundColor: 'rgba(90,100,0,0.6)' },
  logoShadow: { backgroundColor: 'rgba(0,0,0,0.45)' },
  hyperTag: { backgroundColor: C.accent, transform: [{ skewX: '-12deg' }] },
  hyperText: { color: '#0b111a', fontWeight: '900', letterSpacing: 2.5, fontStyle: 'italic' },
  brandLine: { color: C.muted, fontWeight: '700' },
  centerRow: { justifyContent: 'center' },
  centerCol: { alignItems: 'center' },
  field: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(8,13,22,0.75)',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.16)',
  },
  fieldFocus: { borderColor: C.accent, backgroundColor: 'rgba(215,242,59,0.06)' },
  fieldError: { borderColor: 'rgba(255,93,93,0.7)' },
  fieldInput: { flex: 1, color: C.text, fontWeight: '700' },
  eye: { backgroundColor: 'rgba(255,255,255,0.08)' },
  eyeText: { color: C.muted, fontWeight: '900', letterSpacing: 1 },
  richRow: { flexDirection: 'row', alignItems: 'flex-start' },
  richDot: { backgroundColor: C.accent },
  richText: { flex: 1, color: '#d3dde8', fontWeight: '500' },
  richBold: { color: C.text, fontWeight: '900' },
  panel: { backgroundColor: 'rgba(20,31,48,0.82)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', overflow: 'hidden' },
  panelEdge: { position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.16)' },
  tick: { backgroundColor: C.accent },
  liveDot: { backgroundColor: '#3ddc84', borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)' },
  btnBadge: { backgroundColor: C.accent },
  btnBadgeDark: { backgroundColor: '#0b111a' },
  btnBadgeText: { color: '#111', fontWeight: '900' },
  btnBadgeTextDark: { color: C.accent },
  chev: { fontWeight: '300', marginTop: -4 },
  gloss: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: 'rgba(255,255,255,0.1)' },
  sheetWrap: { },
  sheetScroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  sheet: { width: '100%', borderColor: 'rgba(215,242,59,0.3)', elevation: 16 },
  sheetIcon: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(215,242,59,0.12)', borderWidth: 2, borderColor: 'rgba(215,242,59,0.5)' },
  flexPanel: { flex: 1, minHeight: 0 },
});
