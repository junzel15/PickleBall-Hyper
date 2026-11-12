import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Game, UiState } from '../game/engine';
import { drawPortrait, paddleById } from '../game/customize';
import { BackButton, Btn, Card, Details, Drawing, GradientTitle, Label, Li, Overlay, Tap } from './common';
import type { CloudScreen } from './CloudScreens';
import { C } from './theme';

const CONTROLS = [
  '**Left stick** moves your player',
  '**DRIVE** hits hard and low (and serves), **DINK** drops it soft into the kitchen, **LOB** goes high and deep, **SMASH** hits as hard as possible (best on high balls)',
  'Push the stick left/right while you hit to aim at a sideline',
  'Tap a shot as the ball comes toward you: your player swings when it reaches the paddle (and waits for the bounce when the rules need it)',
  '**HYPER** (above SMASH): your special skill, ready when its ring is full',
];
const RULES = [
  'Serve diagonally into the opposite service box. Landing in the kitchen is a fault.',
  "**Two-bounce rule:** the serve and the return must each bounce before being hit.",
  "**Kitchen:** you can't volley (hit before the bounce) while standing in the non-volley zone.",
  'Only the server scores. Lose the rally while serving = side out.',
  'Serve from the right when your score is even, the left when odd.',
  "**Hyper ⚡ (special skill):** the HYPER bar fills during rallies, faster each time you hit the ball (+7%) and when your team wins a point (+12%). At **100%** tap **HYPER**: for **5 seconds** you glow and every Drive, Lob, Dink and Smash is faster, more accurate and much harder to return. If the bar isn't full, nothing happens. Hyper shots still follow the two-bounce and kitchen rules.",
  '**Doubles (2 vs 2):** you team up with a computer partner against two computer opponents (each game they get new names). Both partners serve before a side out, except at the start, which is called “0-0-2”. Partners switch sides only after winning a point on their serve. The score is called as server – receiver – server number.',
  "The referees call close balls **“Inside”**, **“Out”**, faults and kitchen violations, and announce the score (server's score first) before every serve.",
];

function LogoBall() {
  const hop = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([
      Animated.timing(hop, { toValue: 1, duration: 900, easing: Easing.bezier(0.5, 0, 0.5, 1), useNativeDriver: true }),
      Animated.timing(hop, { toValue: 0, duration: 900, easing: Easing.bezier(0.5, 0, 0.5, 1), useNativeDriver: true }),
    ]));
    const s = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1800, easing: Easing.linear, useNativeDriver: true }));
    a.start(); s.start();
    return () => { a.stop(); s.stop(); };
  }, [hop, spin]);
  const ty = hop.interpolate({ inputRange: [0, 1], outputRange: [0, 22] });
  const sh = hop.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const rot = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <View style={s.logo}>
      <Animated.View style={[s.logoShadow, { transform: [{ scaleX: sh }, { scaleY: sh }], opacity: sh }]} />
      <Animated.View style={[s.logoBall, { transform: [{ translateY: ty }, { rotate: rot }] }]}>
        <View style={[s.dot, { left: 9, top: 13 }]} />
        <View style={[s.dot, { left: 23, top: 9 }]} />
        <View style={[s.dot, { left: 19, top: 25 }]} />
      </Animated.View>
    </View>
  );
}

function Choice<T extends string>({ value, options, onPick, big }: {
  value: T; options: { v: T; label: string; sub?: string }[]; onPick: (v: T) => void; big?: boolean;
}) {
  return (
    <View style={[s.diff, big && s.diffCompact]}>
      {options.map(o => {
        const active = o.v === value;
        return (
          <Tap key={o.v} onPress={() => onPick(o.v)} scale={0.95} style={[s.diffBtn, o.sub ? s.modeBtn : null, active && s.diffActive]}>
            {o.sub ? (
              <>
                <Text style={[s.bigLabel, active && s.activeText]}>{o.label}</Text>
                <Text style={[s.modeSub, active && s.activeText]}>{o.sub}</Text>
              </>
            ) : (
              <Text style={[s.diffText, active && s.activeText]}>{o.label}</Text>
            )}
          </Tap>
        );
      })}
    </View>
  );
}

function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  const x = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(x, { toValue: on ? 1 : 0, duration: 200, useNativeDriver: false }).start();
  }, [on, x]);
  const left = x.interpolate({ inputRange: [0, 1], outputRange: [3, 21] });
  const bg = x.interpolate({ inputRange: [0, 1], outputRange: ['rgba(255,255,255,0.18)', C.accent] });
  const knob = x.interpolate({ inputRange: [0, 1], outputRange: ['#ffffff', '#111111'] });
  return (
    <Pressable onPress={onToggle} style={s.toggle} accessibilityRole="switch" accessibilityState={{ checked: on }}>
      <Animated.View style={[s.switch, { backgroundColor: bg }]}>
        <Animated.View style={[s.switchKnob, { left, backgroundColor: knob }]} />
      </Animated.View>
      <Text style={s.toggleText}>{label}</Text>
    </Pressable>
  );
}

export function MainMenu({ game, ui, short, signedIn, onOpenCloud, onOpenTutorial }: {
  game: Game; ui: UiState; short: boolean; signedIn: boolean; onOpenCloud: (c: CloudScreen) => void;
  onOpenTutorial: () => void;
}) {
  const pd = paddleById(ui.profile.paddle);
  const top = (
    <>
      {!short && <LogoBall />}
      <GradientTitle text="Pickleball" size={short ? 26 : 34} />
      <Text style={[s.tagline, short && { fontSize: 12, marginTop: 2, marginBottom: 4 }]}>Play computer opponents · First to 11, win by 2</Text>
      {ui.suspended && (
        <Text style={s.resumeNote}>⏸ Your match is paused. Tap ‹ Back to return to it and resume.</Text>
      )}
      <Tap onPress={() => game.openCustomize()} scale={0.98} style={[s.chip, short && { marginTop: 6 }]} accessibilityLabel="Customize your player and paddle">
        <Drawing
          width={46}
          height={50}
          style={s.chipPortrait}
          deps={[JSON.stringify(ui.profile.avatar)]}
          draw={ctx => drawPortrait(ctx, ui.profile.avatar, 46, 50)}
        />
        <View style={s.chipText}>
          <Text style={s.chipName} numberOfLines={1}>{ui.profile.name}</Text>
          <Text style={s.chipPaddle} numberOfLines={1}>{`${pd.brand} ${pd.model}`}</Text>
        </View>
        <Text style={s.chipEdit}>Customize ✎</Text>
      </Tap>
      <Label style={short ? { marginTop: 8 } : null}>Mode</Label>
      <Choice
        big={short}
        value={ui.selectedMode}
        onPick={v => game.setSelectedMode(v)}
        options={[{ v: 'singles', label: '1 vs 1', sub: 'SINGLES' }, { v: 'doubles', label: '2 vs 2', sub: 'DOUBLES' }]}
      />
      <Label style={short ? { marginTop: 8 } : null}>Difficulty</Label>
      <Choice
        big={short}
        value={ui.difficulty}
        onPick={v => game.setDifficulty(v)}
        options={[{ v: 'easy', label: 'Easy' }, { v: 'medium', label: 'Medium' }, { v: 'hard', label: 'Hard' }]}
      />
    </>
  );
  const bottom = (
    <>
      {ui.voiceAvailable && <Switch on={ui.voiceOn} onToggle={() => game.setVoice(!ui.voiceOn)} label="Referee voice" />}
      <PlayButton title={ui.suspended ? 'New game' : 'Play'} onPress={() => game.startGame()} animate={!short} />
      <View style={s.cloudRow}>
        <Btn title="📜 History" secondary small onPress={() => onOpenCloud('history')} style={s.cloudBtn} />
        <Btn title="🏆 Leaders" secondary small onPress={() => onOpenCloud('leaderboard')} style={s.cloudBtn} />
        <Btn title={signedIn ? '👤 Account' : '👤 Sign in'} secondary small onPress={() => onOpenCloud('account')} style={s.cloudBtn} />
      </View>
      <Btn title="🎓 How to play" secondary small onPress={onOpenTutorial} style={s.howTo} />
      <Details summary="Controls">{CONTROLS.map(t => <Li key={t} text={t} />)}</Details>
      <Details summary="Rules">{RULES.map(t => <Li key={t} text={t} />)}</Details>
      <Text style={s.version}>Version 20</Text>
    </>
  );

  return (
    <Overlay>
      <Card style={[short ? s.cardShort : null, ui.suspended && { paddingTop: 62 }]}>
        {ui.suspended && <BackButton onPress={() => game.goBack()} />}
        {short ? (
          <View style={s.columns}>
            <View style={s.col}>{top}</View>
            <View style={[s.col, { justifyContent: 'center' }]}>{bottom}</View>
          </View>
        ) : (
          <>
            {top}
            {bottom}
          </>
        )}
      </Card>
    </Overlay>
  );
}

function PlayButton({ title, onPress, animate }: { title: string; onPress: () => void; animate: boolean }) {
  const glow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!animate) return;
    const a = Animated.loop(Animated.timing(glow, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, [animate, glow]);
  const scale = glow.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.12, 1.12] });
  const opacity = glow.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.45, 0, 0] });
  return (
    <View style={s.playWrap}>
      {animate && <Animated.View pointerEvents="none" style={[s.playGlow, { opacity, transform: [{ scaleX: scale }, { scaleY: scale }] }]} />}
      <Btn title={title} onPress={onPress} style={s.playBtn} textStyle={{ fontSize: 18 }} />
    </View>
  );
}

const s = StyleSheet.create({
  cardShort: { maxWidth: 660, paddingVertical: 12, paddingHorizontal: 16 },
  columns: { flexDirection: 'row', gap: 22 },
  col: { flex: 1 },
  logo: { height: 64, alignItems: 'center' },
  logoBall: {
    position: 'absolute', top: 0, width: 40, height: 40, borderRadius: 20, backgroundColor: '#e3f05a',
    shadowColor: C.accent, shadowOpacity: 0.5, shadowRadius: 18, elevation: 6, overflow: 'hidden',
    borderWidth: 3, borderColor: '#d2e23a',
  },
  dot: { position: 'absolute', width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(90,100,0,0.6)' },
  logoShadow: { position: 'absolute', bottom: 0, width: 36, height: 8, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.45)' },
  tagline: { color: C.muted, fontSize: 14, marginTop: 4, marginBottom: 8, textAlign: 'center' },
  resumeNote: {
    marginTop: 6, marginBottom: 2, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8,
    backgroundColor: 'rgba(215,242,59,0.1)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.35)',
    color: C.accent, fontSize: 12, fontWeight: '700', textAlign: 'center',
  },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, marginBottom: 2,
    paddingVertical: 6, paddingLeft: 6, paddingRight: 10, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', backgroundColor: 'rgba(255,255,255,0.04)',
  },
  chipPortrait: { borderRadius: 9, overflow: 'hidden' },
  chipText: { flex: 1, minWidth: 0 },
  chipName: { color: C.text, fontSize: 15, fontWeight: '800' },
  chipPaddle: { color: C.muted, fontSize: 12 },
  chipEdit: { color: C.accent, fontSize: 12, fontWeight: '700' },
  diff: { flexDirection: 'row', gap: 6, justifyContent: 'center', marginTop: 8, marginBottom: 16 },
  diffCompact: { marginTop: 6, marginBottom: 8 },
  diffBtn: {
    flex: 1, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', borderRadius: 8, paddingVertical: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  modeBtn: { paddingVertical: 5 },
  diffActive: { backgroundColor: C.accent, borderColor: C.accent },
  diffText: { color: C.text, fontWeight: '700', fontSize: 14 },
  activeText: { color: '#111' },
  bigLabel: { color: C.text, fontSize: 18, fontWeight: '900', letterSpacing: 0.4 },
  modeSub: { color: C.text, fontSize: 11, fontWeight: '600', opacity: 0.75, letterSpacing: 0.9 },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 4, marginBottom: 10 },
  toggleText: { color: C.muted, fontSize: 14 },
  switch: { width: 40, height: 22, borderRadius: 11 },
  switchKnob: { position: 'absolute', top: 3, width: 16, height: 16, borderRadius: 8 },
  playWrap: { justifyContent: 'center' },
  playGlow: { ...StyleSheet.absoluteFill, borderRadius: 12, backgroundColor: C.accent },
  cloudRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  howTo: { marginTop: 6 },
  cloudBtn: { flex: 1, paddingHorizontal: 4 },
  playBtn: { paddingVertical: 12, paddingHorizontal: 44, alignSelf: 'stretch' },
  version: { marginTop: 10, fontSize: 11, color: C.muted, opacity: 0.7, textAlign: 'center' },
});
