// Main menu: a full-screen, two-column landscape layout that scales with the screen
// (small phones up to tablets) and never needs scrolling on a normal phone.
//
//   ┌──────────────────────────────┬──────────────────────────────────┐
//   │  ● PICKLEBALL                 │  [ ▶ PLAY            vs computer ]│
//   │    HYPER                      │  [ 🌐 PLAY ONLINE   N online now ]│
//   │  [portrait  Name  Customize]  │  [History][Leaders][Account][How]│
//   │  MATCH SETUP                  │                                   │
//   │  [ 1 vs 1 | 2 vs 2 ]          │  voice ◯   Rules & controls   v21 │
//   │  [ Easy | Medium | Hard ]     │                                   │
//   └──────────────────────────────┴──────────────────────────────────┘
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Difficulty, Game, Mode, UiState } from '../game/engine';
import { drawPortrait, paddleById } from '../game/customize';
import { Drawing, Tap } from './common';
import { Backdrop, Brand, GameButton, Icon, Panel, RichList, ScreenFrame, Segments, Tile, useUiScale } from './gameUi';
import type { CloudScreen } from './CloudScreens';
import { C } from './theme';

const VERSION = 'v21';

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
  '**Computer opponents** each have a playing style (Power Hitter, Soft Touch, Moonballer, Speed Demon, All-Rounder). On Medium and Hard they charge and use their own Hyper.',
  "The referees call close balls **“Inside”**, **“Out”**, faults and kitchen violations, and announce the score (server's score first) before every serve.",
];
const ONLINE_RULES = [
  '**Play online** against real people (sign in first): **1 vs 1** or **2 vs 2** with three other players.',
  '**Quick Match:** pick 1 vs 1 or 2 vs 2 and search. When enough players are found you see **Opponent Found!** and a 3-2-1 countdown. 2 vs 2 teams are balanced by rating.',
  '**Rooms:** create a room and share its 6-letter code, or invite friends (add them with their 8-letter friend code). In 2 vs 2 rooms everyone picks a team with **Sit here**; the host starts when everyone is ready.',
  '**In the match:** the same controls and rules as against the computer. Every player has their own **Hyper** bar. Team B sees the court turned around, so everyone plays from the bottom of the screen.',
  '**Fair play:** the server checks every result: all players\' apps must agree on every point, or the match doesn\'t count. Wins and losses change your **online rating** (Elo) on the online leaderboard.',
  '**Disconnects:** if someone loses connection the match waits for them ("Waiting for …"). If they are gone for about 40 seconds, the other side can win by forfeit. **Leave match** in the ☰ menu counts as a loss.',
];

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------
function Switch({ on, onToggle, label, z }: { on: boolean; onToggle: () => void; label: string; z: (n: number) => number }) {
  const x = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(x, { toValue: on ? 1 : 0, duration: 200, useNativeDriver: false }).start();
  }, [on, x]);
  const w = z(38), h = z(21), k = h - 6;
  const left = x.interpolate({ inputRange: [0, 1], outputRange: [3, w - k - 3] });
  const bg = x.interpolate({ inputRange: [0, 1], outputRange: ['rgba(255,255,255,0.18)', C.accent] });
  const knob = x.interpolate({ inputRange: [0, 1], outputRange: ['#ffffff', '#111111'] });
  return (
    <Pressable onPress={onToggle} style={[s.toggle, { gap: z(8) }]} accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={label}>
      <Icon name="voice" size={z(16)} color={on ? C.accent : C.muted} />
      <Animated.View style={{ width: w, height: h, borderRadius: h / 2, backgroundColor: bg }}>
        <Animated.View style={{ position: 'absolute', top: 3, width: k, height: k, borderRadius: k / 2, left, backgroundColor: knob }} />
      </Animated.View>
    </Pressable>
  );
}

/** Rules & controls in a tabbed sheet (instead of long text inside the menu). */
function RulesSheet({ onClose, onOnline }: { onClose: () => void; onOnline?: () => void }) {
  const ui = useUiScale();
  const { z } = ui;
  const [tab, setTab] = useState<'controls' | 'rules' | 'online'>('controls');
  const items = tab === 'controls' ? CONTROLS : tab === 'rules' ? RULES : ONLINE_RULES;
  const caption = tab === 'controls' ? 'TOUCH CONTROLS' : tab === 'rules' ? 'PICKLEBALL RULES' : 'PLAYING ONLINE';
  return (
    <ScreenFrame title="Rules & controls" kicker="HOW THE GAME WORKS" onBack={onClose} ui={ui} zIndex={30} fill>
      <View style={[s.flex1, { gap: z(10) }]}>
        <Segments z={z} value={tab} onPick={setTab}
          options={[{ v: 'controls', label: 'Controls' }, { v: 'rules', label: 'Rules' }, { v: 'online', label: 'Online' }]} />
        <Panel z={z} title={caption} flex>
          <ScrollView style={s.flex1} showsVerticalScrollIndicator={false}>
            <RichList items={items} z={z} size={14} />
          </ScrollView>
          {tab === 'online' && onOnline && (
            <GameButton title="PLAY ONLINE" icon="globe" color="blue" z={z} compact onPress={() => { onClose(); onOnline(); }} sub="1 vs 1 · 2 vs 2 · real players" />
          )}
        </Panel>
      </View>
    </ScreenFrame>
  );
}

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------
export function MainMenu({ game, ui, short, signedIn, onOpenCloud, onOpenTutorial, onOpenOnline, onlineBadge = '', onlineCount = null }: {
  game: Game; ui: UiState; short: boolean; signedIn: boolean; onOpenCloud: (c: CloudScreen) => void;
  onOpenTutorial: () => void; onOpenOnline?: () => void; onlineBadge?: string; onlineCount?: number | null;
}) {
  void short; // sizing now comes from the real screen size (useMenuScale)
  const { u, landscape, tight, z } = useUiScale();
  const [rules, setRules] = useState(false);
  const pd = paddleById(ui.profile.paddle);

  // entrance: the columns slide in from the sides
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [enter]);
  const leftIn = { opacity: enter, transform: [{ translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [-40, 0] }) }] };
  const rightIn = { opacity: enter, transform: [{ translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }] };

  const diffLabel = ui.difficulty[0].toUpperCase() + ui.difficulty.slice(1);
  const playSub = `vs computer · ${ui.selectedMode === 'doubles' ? 'Doubles' : 'Singles'} · ${diffLabel}`;
  const portraitW = z(48), portraitH = z(52);
  const colGap = z(18);

  const left = (
    <Animated.View style={[s.col, landscape ? s.leftCol : null, { gap: z(tight ? 8 : 12) }, leftIn]}>
      {/* brand (shared with the loading, start and account screens) */}
      <Brand z={z} size={tight ? 25 : 30} ball={!tight} line={tight ? undefined : 'First to 11 · win by 2'} />

      {/* player card */}
      <Tap onPress={() => game.openCustomize()} scale={0.98} accessibilityLabel="Customize your player and paddle"
        style={[s.glass, s.row, { gap: z(10), padding: z(7), borderRadius: z(14) }]}>
        <Drawing
          width={portraitW}
          height={portraitH}
          style={[s.portrait, { borderRadius: z(10) }]}
          deps={[JSON.stringify(ui.profile.avatar), portraitW]}
          draw={ctx => drawPortrait(ctx, ui.profile.avatar, portraitW, portraitH)}
        />
        <View style={s.flex1}>
          <Text style={[s.kicker, { fontSize: z(9.5) }]}>PLAYER</Text>
          <Text style={[s.name, { fontSize: z(16) }]} numberOfLines={1}>{ui.profile.name}</Text>
          <Text style={[s.paddle, { fontSize: z(11.5) }]} numberOfLines={1}>{`${pd.brand} ${pd.model}`}</Text>
        </View>
        <View style={[s.editPill, s.row, { gap: z(4), paddingHorizontal: z(9), paddingVertical: z(6), borderRadius: z(10) }]}>
          <Icon name="edit" size={z(13)} color="#111" />
          <Text style={[s.editText, { fontSize: z(11.5) }]}>Customize</Text>
        </View>
      </Tap>

      {/* match setup */}
      <Panel z={z} title="MATCH SETUP · VS COMPUTER" style={{ padding: z(tight ? 8 : 10), gap: z(tight ? 6 : 8) }}>
        <Segments
          z={z}
          value={ui.selectedMode}
          onPick={(v: Mode) => game.setSelectedMode(v)}
          options={[{ v: 'singles', label: '1 vs 1', sub: 'SINGLES' }, { v: 'doubles', label: '2 vs 2', sub: 'DOUBLES' }]}
        />
        <Segments
          z={z}
          value={ui.difficulty}
          onPick={(v: Difficulty) => game.setDifficulty(v)}
          options={[{ v: 'easy', label: 'Easy', level: 1 }, { v: 'medium', label: 'Medium', level: 2 }, { v: 'hard', label: 'Hard', level: 3 }]}
        />
      </Panel>
    </Animated.View>
  );

  const right = (
    <Animated.View style={[s.col, landscape ? s.rightCol : null, { gap: z(tight ? 8 : 11) }, rightIn]}>
      {ui.suspended && (
        <View style={[s.paused, s.row, { gap: z(10), paddingVertical: z(6), paddingLeft: z(12), paddingRight: z(6), borderRadius: z(14) }]}>
          <Icon name="pause" size={z(18)} color={C.accent} />
          <Text style={[s.pausedText, { fontSize: z(14) }]} numberOfLines={1}>Match paused</Text>
          <Tap onPress={() => game.goBack()} scale={0.95} accessibilityLabel="Resume your paused match"
            style={[s.resumeBtn, s.row, { gap: z(6), minHeight: z(40), paddingHorizontal: z(16), borderRadius: z(11) }]}>
            <Icon name="play" size={z(16)} color="#0b111a" />
            <Text style={[s.resume, { fontSize: z(16) }]}>RESUME</Text>
          </Tap>
        </View>
      )}
      <GameButton title={ui.suspended ? 'NEW GAME' : 'PLAY'} sub={playSub} icon="play" onPress={() => game.startGame()} glow={!tight} z={z} height={68} titleSize={24} />
      {/* always available, also while a CPU match is paused behind this menu */}
      {onOpenOnline && (
        <GameButton title="PLAY ONLINE" icon="globe" color="blue" onPress={onOpenOnline} glow={!tight} z={z} height={62}
          live={onlineCount !== null} badge={onlineBadge || undefined}
          sub={onlineCount === null ? '1 vs 1 · 2 vs 2 · real players' : `1 vs 1 · 2 vs 2 · ${onlineCount} online now`} />
      )}
      <View style={[s.row, { gap: z(8) }]}>
        <Tile icon="history" label="History" onPress={() => onOpenCloud('history')} z={z} />
        <Tile icon="trophy" label="Leaders" onPress={() => onOpenCloud('leaderboard')} z={z} />
        <Tile icon="user" label={signedIn ? 'Account' : 'Sign in'} onPress={() => onOpenCloud('account')} z={z} />
        <Tile icon="book" label="How to play" onPress={onOpenTutorial} z={z} />
      </View>
      <View style={[s.row, s.footer, { gap: z(12) }]}>
        {ui.voiceAvailable && <Switch on={ui.voiceOn} onToggle={() => game.setVoice(!ui.voiceOn)} label="Referee voice" z={z} />}
        <Tap onPress={() => setRules(true)} scale={0.95} accessibilityLabel="Rules and controls"
          style={[s.row, s.linkBtn, { gap: z(6), paddingVertical: z(6), paddingHorizontal: z(10), borderRadius: z(10) }]}>
          <Icon name="list" size={z(15)} color={C.text} />
          <Text style={[s.linkText, { fontSize: z(12) }]}>Rules & controls</Text>
        </Tap>
        <View style={s.flex1} />
        <Text style={[s.version, { fontSize: z(10.5) }]}>{VERSION}</Text>
      </View>
    </Animated.View>
  );

  return (
    <View style={s.screen}>
      {/* readable backdrop over the live court: dark on the left, lighter on the right */}
      <Backdrop sweep={!tight} />
      <ScrollView
        contentContainerStyle={[s.scroll, { padding: z(16), paddingTop: z(tight ? 10 : 14) }]}
        showsVerticalScrollIndicator={false}
        overScrollMode="never"
        bounces={false}>
        <View style={[landscape ? s.rowStretch : null, s.content, { gap: colGap, maxWidth: 1180 * Math.min(1, u) + 260 * Math.max(0, u - 1) }]}>
          {left}
          {right}
        </View>
      </ScrollView>
      {rules && <RulesSheet onClose={() => setRules(false)} onOnline={onOpenOnline} />}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { ...StyleSheet.absoluteFill, zIndex: 5, backgroundColor: 'transparent' },
  scroll: { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
  content: { width: '100%' },
  rowStretch: { flexDirection: 'row', alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  col: { minWidth: 0 },
  leftCol: { flex: 0.92 },
  rightCol: { flex: 1.08, paddingTop: 26 }, // keeps clear of the mute button in the top-right corner
  flex1: { flex: 1, minWidth: 0 },
  sweep: {
    position: 'absolute', top: -120, bottom: -120, width: 90,
    backgroundColor: 'rgba(255,255,255,0.045)',
  },
  logoBall: {
    position: 'absolute', backgroundColor: '#e3f05a', overflow: 'hidden',
    borderWidth: 2, borderColor: '#d2e23a', elevation: 6,
  },
  dot: { position: 'absolute', backgroundColor: 'rgba(90,100,0,0.6)' },
  logoShadow: { backgroundColor: 'rgba(0,0,0,0.45)' },
  hyperTag: { backgroundColor: C.accent, transform: [{ skewX: '-12deg' }] },
  hyperText: { color: '#0b111a', fontWeight: '900', letterSpacing: 2.5, fontStyle: 'italic' },
  tagline: { color: C.muted, fontWeight: '700' },
  glass: {
    backgroundColor: 'rgba(20,31,48,0.82)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    borderTopColor: 'rgba(255,255,255,0.18)',
  },
  portrait: { overflow: 'hidden' },
  kicker: { color: C.muted, fontWeight: '900', letterSpacing: 1.4 },
  name: { color: C.text, fontWeight: '900' },
  paddle: { color: C.muted, fontWeight: '600' },
  editPill: { backgroundColor: C.accent },
  editText: { color: '#111', fontWeight: '900' },
  seg: { flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.32)' },
  segBtn: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: C.accent },
  segRow: { flexDirection: 'row', alignItems: 'center' },
  bars: { flexDirection: 'row', alignItems: 'flex-end' },
  segText: { color: C.text, fontWeight: '900', letterSpacing: 0.3 },
  segSub: { color: C.muted, fontWeight: '800', letterSpacing: 1.1 },
  segTextOn: { color: '#111' },
  btnWrap: { justifyContent: 'center' },
  bigBtn: { flexDirection: 'row', alignItems: 'center', overflow: 'hidden', elevation: 8 },
  playBtn: { borderWidth: 2, borderColor: 'rgba(255,255,255,0.55)' },
  playGlow: { ...StyleSheet.absoluteFill, backgroundColor: C.accent },
  btnIcon: { alignItems: 'center', justifyContent: 'center' },
  playIcon: { backgroundColor: '#0b111a' },
  playTitle: { color: '#0b111a', fontWeight: '900', letterSpacing: 2 },
  playSub: { color: 'rgba(11,17,26,0.75)', fontWeight: '800' },
  onlineBtn: { borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)' },
  onlineGlow: { ...StyleSheet.absoluteFill, backgroundColor: '#1b9fd6', transform: [{ scaleX: 1.03 }, { scaleY: 1.12 }] },
  onlineIcon: { backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  onlineTitle: { color: '#fff', fontWeight: '900', letterSpacing: 1.4 },
  onlineSub: { color: 'rgba(255,255,255,0.9)', fontWeight: '700', flexShrink: 1 },
  liveDot: { backgroundColor: '#3ddc84', borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)' },
  badge: { backgroundColor: C.accent },
  badgeText: { color: '#111', fontWeight: '900' },
  chev: { color: '#fff', fontWeight: '300', marginTop: -4 },
  tile: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(23,34,51,0.85)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  tileIcon: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(215,242,59,0.12)' },
  tileText: { color: C.text, fontWeight: '800' },
  footer: { flexWrap: 'wrap' },
  toggle: { flexDirection: 'row', alignItems: 'center' },
  linkBtn: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', backgroundColor: 'rgba(255,255,255,0.05)' },
  linkText: { color: C.text, fontWeight: '800' },
  version: { color: C.muted, opacity: 0.7, fontWeight: '700' },
  paused: { backgroundColor: 'rgba(215,242,59,0.1)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.4)' },
  pausedText: { color: C.text, fontWeight: '800', flex: 1 },
  resume: { color: '#0b111a', fontWeight: '900', letterSpacing: 1.2 },
  resumeBtn: { backgroundColor: C.accent },
  sheet: { maxWidth: 620 },
  sheetTitle: { color: C.text, fontWeight: '900' },
  close: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  closeText: { color: C.muted, fontWeight: '900' },
  sheetList: {},
});
