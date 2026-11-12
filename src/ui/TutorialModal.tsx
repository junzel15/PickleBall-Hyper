// New-player tutorial: a guided, step-by-step tour of the controls and rules with
// small animated demos. Opens automatically after registration (once the name and
// age are set) and any time from "How to play" on the main menu.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, Line, RadialGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { Columns, GameButton, GhostButton, Panel, RichList, ScreenFrame, useUiScale } from './gameUi';
import { C } from './theme';

// ---------------------------------------------------------------------------
// Animated demos
// ---------------------------------------------------------------------------
function useLoop(duration: number, native = true) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.timing(v, { toValue: 1, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: native }));
    a.start();
    return () => a.stop();
  }, [v, duration, native]);
  return v;
}

/** A shot button exactly like the one on court, gently pulsing as if tapped. */
function ShotButton({ label, c0, c1, size = 92 }: { label: string; c0: string; c1: string; size?: number }) {
  const t = useLoop(1400);
  const scale = t.interpolate({ inputRange: [0, 0.45, 0.55, 1], outputRange: [1, 1, 0.92, 1] });
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Svg width={size} height={size + 8}>
        <Defs>
          <RadialGradient id={`g-${label}`} cx="35%" cy="30%" r="75%">
            <Stop offset="0" stopColor={c0} />
            <Stop offset="1" stopColor={c1} />
          </RadialGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2 + 6} r={size / 2 - 2} fill="rgba(0,0,0,0.35)" />
        <Circle cx={size / 2} cy={size / 2} r={size / 2 - 2} fill={`url(#g-${label})`} />
        <SvgText x={size / 2} y={size / 2 + size * 0.07} fontSize={size * 0.19} fontWeight="900" fill="#111" textAnchor="middle">
          {label}
        </SvgText>
      </Svg>
    </Animated.View>
  );
}

/** Joystick with the knob sweeping around, like a thumb steering. */
function JoystickDemo() {
  const t = useLoop(2600);
  const x = t.interpolate({ inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [0, 30, 0, -30, 0] });
  const y = t.interpolate({ inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [-30, 0, 30, 0, -30] });
  return (
    <View style={s.demoBox}>
      <View style={s.joyBase}>
        <View style={s.joyRing} />
        <Animated.View style={[s.joyKnob, { transform: [{ translateX: x }, { translateY: y }] }]} />
      </View>
      <Text style={s.demoCaption}>push to walk · push further to run</Text>
    </View>
  );
}

/** Ball dropping onto a dashed landing ring, then a paddle-ready flash. */
function HitDemo() {
  const t = useLoop(1600);
  const y = t.interpolate({ inputRange: [0, 0.6, 0.8, 1], outputRange: [-46, 22, 8, 22] });
  const ring = t.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0.5, 1, 0.5] });
  return (
    <View style={s.demoBox}>
      <View style={{ width: 150, height: 110, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View style={[s.landRing, { opacity: ring }]} />
        <Animated.View style={[s.ball, { transform: [{ translateY: y }] }]} />
      </View>
      <Text style={s.demoCaption}>the dashed ring shows where it lands</Text>
    </View>
  );
}

/** HYPER button: ring fills to 100%, then 5 seconds of Hyper mode count down. */
function HyperDemo() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(n => (n + 1) % 90), 100);
    return () => clearInterval(id);
  }, []);
  const charging = tick < 40;
  const pct = charging ? tick / 40 : 1 - (tick - 40) / 50; // fill, then drain during Hyper
  const secs = Math.max(1, Math.ceil(5 * pct));
  const size = 104, r = 44, c = 2 * Math.PI * r;
  return (
    <View style={s.demoBox}>
      <Svg width={size} height={size}>
        {!charging && <Circle cx={52} cy={52} r={50} fill="rgba(124,242,255,0.18)" />}
        <Circle cx={52} cy={52} r={r} stroke="rgba(255,255,255,0.14)" strokeWidth={9} fill="none" />
        <Circle cx={52} cy={52} r={r} stroke="#7cf2ff" strokeWidth={9} fill="none"
          strokeDasharray={`${c * pct} ${c}`} rotation={-90} originX={52} originY={52} strokeLinecap="round" />
        <Circle cx={52} cy={52} r={36} fill={charging && pct < 1 ? '#1f2733' : '#19b7d6'} />
        <SvgText x={52} y={58} fontSize={16} fontWeight="900" textAnchor="middle" fill={charging ? '#9fb0c3' : '#06222a'}>
          {charging ? 'HYPER' : `${secs}s`}
        </SvgText>
      </Svg>
      <Text style={[s.demoCaption, !charging && { color: '#7cf2ff' }]}>
        {charging ? `charging… ${Math.round(pct * 100)}%` : 'HYPER MODE: stronger shots!'}
      </Text>
    </View>
  );
}

/** Mini court seen from above: kitchen highlighted, two-bounce dots. */
function RulesDemo() {
  const t = useLoop(2000, false);
  const op = t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.35, 0.8, 0.35] });
  const AnimatedRect = useRef(Animated.createAnimatedComponent(Rect)).current;
  return (
    <View style={s.demoBox}>
      <Svg width={200} height={120} viewBox="0 0 200 120">
        <Rect x={10} y={10} width={180} height={100} rx={4} fill="#2458a4" stroke="#f4f7fb" strokeWidth={2} />
        <AnimatedRect x={66} y={10} width={68} height={100} fill="#ff5d5d" opacity={op as unknown as number} />
        <Line x1={100} y1={6} x2={100} y2={114} stroke="#ffffff" strokeWidth={3} />
        <Line x1={10} y1={60} x2={66} y2={60} stroke="#f4f7fb" strokeWidth={1.5} />
        <Line x1={134} y1={60} x2={190} y2={60} stroke="#f4f7fb" strokeWidth={1.5} />
        <SvgText x={100} y={64} fontSize={10} fontWeight="900" fill="#ffffff" textAnchor="middle" opacity={0.9}>KITCHEN</SvgText>
        <Circle cx={160} cy={32} r={5} fill="#d7f23b" />
        <Circle cx={40} cy={86} r={5} fill="#d7f23b" />
        <SvgText x={160} y={50} fontSize={9} fontWeight="800" fill="#d7f23b" textAnchor="middle">bounce 1</SvgText>
        <SvgText x={40} y={78} fontSize={9} fontWeight="800" fill="#d7f23b" textAnchor="middle">bounce 2</SvgText>
      </Svg>
      <Text style={s.demoCaption}>no volleys from the red zone</Text>
    </View>
  );
}

/** "Opponent Found!" style card: your side VS the other side, pulsing. */
function OnlineDemo() {
  const t = useLoop(1600);
  const scale = t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.08, 1] });
  const side = (label: string, names: string[], color: string) => (
    <View style={[s.olSide, { borderColor: color }]}>
      <Text style={[s.olLabel, { color }]}>{label}</Text>
      {names.map(n => <Text key={n} style={s.olName}>{n}</Text>)}
    </View>
  );
  return (
    <View style={s.demoBox}>
      <Animated.Text style={[s.olTitle, { transform: [{ scale }] }]}>Opponent Found!</Animated.Text>
      <View style={s.olRow}>
        {side('YOUR TEAM', ['You', 'Partner'], '#3aa0ff')}
        <Text style={s.olVs}>VS</Text>
        {side('OPPONENTS', ['Player 3', 'Player 4'], '#ff5d5d')}
      </View>
      <Text style={s.demoCaption}>1 vs 1 or 2 vs 2 · real players</Text>
    </View>
  );
}

/** A room code being shared, with friends joining. */
function RoomDemo() {
  const t = useLoop(2400, false);
  const dots = [0, 1, 2].map(i => t.interpolate({ inputRange: [0, 0.25 + i * 0.2, 0.3 + i * 0.2, 1], outputRange: [0.25, 0.25, 1, 1] }));
  return (
    <View style={s.demoBox}>
      <Text style={s.olCodeLabel}>ROOM CODE</Text>
      <Text style={s.olCode}>K7QM2X</Text>
      <View style={s.olRow}>
        {dots.map((o, i) => (
          <Animated.View key={i} style={[s.olSeat, { opacity: o }]}>
            <Text style={s.olSeatText}>{['Friend 1', 'Friend 2', 'Friend 3'][i]}</Text>
          </Animated.View>
        ))}
      </View>
      <Text style={s.demoCaption}>share the code · friends join · pick teams</Text>
    </View>
  );
}

function CourtDemo() {
  const t = useLoop(1800);
  const x = t.interpolate({ inputRange: [0, 0.5, 1], outputRange: [-60, 60, -60] });
  const y = t.interpolate({ inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [0, -26, 0, -26, 0] });
  return (
    <View style={s.demoBox}>
      <View style={{ width: 190, height: 100, alignItems: 'center', justifyContent: 'flex-end' }}>
        <View style={s.miniCourt} />
        <Animated.View style={[s.ball, { position: 'absolute', bottom: 40, transform: [{ translateX: x }, { translateY: y }] }]} />
      </View>
      <Text style={s.demoCaption}>first to 11, win by 2</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
interface Step { title: string; kicker: string; body: string[]; demo: React.ReactNode }
const STEPS: Step[] = [
  {
    kicker: 'WELCOME', title: 'How to play',
    body: [
      'A quick tour of the controls and rules. It takes about a minute.',
      'Play pickleball against computer opponents, or online against real people: singles (1 vs 1) or doubles (2 vs 2).',
    ],
    demo: <CourtDemo />,
  },
  {
    kicker: 'CONTROLS', title: 'Move with the stick',
    body: [
      'Put your left thumb anywhere in the lower-left of the screen: the stick appears under it.',
      'Push a little to walk, push further to run. Get to where the ball will bounce, a step behind it.',
    ],
    demo: <JoystickDemo />,
  },
  {
    kicker: 'BALL HANDLING', title: 'Hitting the ball',
    body: [
      'Tap a shot button as the ball comes toward you. A lime ring shows your shot is ready, and your player swings when the ball reaches the paddle.',
      'Push the stick left or right while you tap to aim at a sideline.',
      'The dashed ring on the court shows where the ball will land.',
    ],
    demo: <HitDemo />,
  },
  {
    kicker: 'SHOT 1 OF 4', title: 'Drive',
    body: [
      'Your main shot: hard and low over the net.',
      'Also used to serve. Tap DRIVE when it says "TAP DRIVE TO SERVE".',
    ],
    demo: <ShotButton label="DRIVE" c0="#f1ff8a" c1="#c5dc1b" />,
  },
  {
    kicker: 'SHOT 2 OF 4', title: 'Dink',
    body: [
      'A soft shot that drops into the other side\'s kitchen.',
      'It forces opponents to hit up, giving you the chance to attack.',
    ],
    demo: <ShotButton label="DINK" c0="#9ef0b6" c1="#3fbf6b" />,
  },
  {
    kicker: 'SHOT 3 OF 4', title: 'Lob',
    body: [
      'High and deep, over opponents standing at the net.',
      'Great for buying time when you\'re out of position.',
    ],
    demo: <ShotButton label="LOB" c0="#c8a6ff" c1="#8d5cf0" />,
  },
  {
    kicker: 'SHOT 4 OF 4', title: 'Smash',
    body: [
      'Hits the ball as hard as you can, straight down into their court.',
      'Best on high balls: watch the ball\'s shadow to judge its height. On low balls it\'s riskier and can fly wide.',
    ],
    demo: <ShotButton label="SMASH" c0="#ffc59a" c1="#ff5a1f" />,
  },
  {
    kicker: 'RULES', title: 'Two rules to remember',
    body: [
      'Two-bounce rule: the serve and the return must each bounce before anyone hits them.',
      'Kitchen: you can\'t hit the ball before it bounces while standing in the kitchen (next to the net).',
      'Only the serving side scores a point.',
    ],
    demo: <RulesDemo />,
  },
  {
    kicker: 'SPECIAL SKILL', title: 'Hyper',
    body: [
      'The HYPER bar (top-left) fills as you play, faster when you hit the ball and win points.',
      'When it\'s full, tap HYPER (above SMASH): for 5 seconds every Drive, Lob, Dink and Smash is faster, more accurate and much harder to return.',
    ],
    demo: <HyperDemo />,
  },
  {
    kicker: 'PLAY ONLINE 1 OF 2', title: 'Quick Match',
    body: [
      'Sign in, then tap PLAY ONLINE on the main menu. Choose 1 vs 1 or 2 vs 2 and tap Quick Match.',
      'When players are found you see "Opponent Found!" with everyone\'s rating and a 3-2-1 countdown. 2 vs 2 teams are balanced by rating.',
      'Same controls and rules as against the computer, and every player has their own Hyper bar. Your side always plays from the bottom of the screen.',
    ],
    demo: <OnlineDemo />,
  },
  {
    kicker: 'PLAY ONLINE 2 OF 2', title: 'Rooms, friends & fair play',
    body: [
      'Create a room and share its 6-letter code, or invite friends you added with their friend code. In 2 vs 2, everyone picks a team; the host starts when all are ready.',
      'The server checks every result, and wins and losses change your online rating. If a player drops out, the match waits for them; leaving early counts as a loss.',
    ],
    demo: <RoomDemo />,
  },
  {
    kicker: 'ALL SET', title: 'You\'re ready!',
    body: [
      'Try it in a practice match against an easy opponent, or head to the main menu and tap PLAY ONLINE.',
      'You can open this tour again any time from "How to play" on the main menu.',
    ],
    demo: <ShotButton label="PLAY" c0="#f1ff8a" c1="#c5dc1b" size={84} />,
  },
];

export function TutorialModal({ short, onClose, onPractice }: { short: boolean; onClose: () => void; onPractice: () => void }) {
  void short; // sizing comes from the real screen size
  const ui = useUiScale();
  const { z, landscape } = ui;
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [i, fade]);
  const slide = fade.interpolate({ inputRange: [0, 1], outputRange: [18, 0] });
  const anim = { opacity: fade, transform: [{ translateY: slide }] };

  const left = (
    <Panel z={z} flex={landscape} style={s.demoPanel}>
      <Animated.View style={[s.demoInner, anim]}>{step.demo}</Animated.View>
    </Panel>
  );
  const right = (
    <Panel z={z} flex={landscape} style={{ padding: z(14), gap: z(10) }}>
      {/* step progress */}
      <View style={[s.progress, { gap: z(4) }]}>
        {STEPS.map((_, n) => <View key={n} style={[s.dot, { height: z(4), borderRadius: z(2) }, n <= i && s.dotOn, n === i && s.dotNow]} />)}
      </View>
      <Animated.View style={[s.textCol, { gap: z(8) }, anim]}>
        <Text style={[s.kicker, { fontSize: z(11) }]}>{step.kicker}</Text>
        <Text style={[s.title, { fontSize: z(25) }]}>{step.title}</Text>
        <ScrollView style={s.textScroll} showsVerticalScrollIndicator={false}>
          <RichList items={step.body} z={z} size={14} />
        </ScrollView>
      </Animated.View>
      {last ? (
        <View style={{ gap: z(8) }}>
          <GameButton title="PRACTICE MATCH" sub="Singles vs an easy opponent" icon="play" glow z={z} onPress={onPractice} titleSize={22} />
          <GhostButton title="Main menu" icon="door" z={z} onPress={onClose} />
        </View>
      ) : (
        <View style={[s.nav, { gap: z(10) }]}>
          {i > 0 && <GhostButton title="Back" icon="back" z={z} onPress={() => setI(n => Math.max(0, n - 1))} style={s.navBtn} />}
          <View style={s.navBtnMain}>
            <GameButton title={i === 0 ? 'START TOUR' : 'NEXT'} icon="play" z={z} height={52} compact
              onPress={() => setI(n => Math.min(STEPS.length - 1, n + 1))} />
          </View>
        </View>
      )}
    </Panel>
  );

  return (
    <ScreenFrame title="How to play" kicker={`TUTORIAL · STEP ${i + 1} OF ${STEPS.length}`} onBack={onClose} ui={ui} zIndex={10} fill
      right={!last ? <GhostButton title="Skip" small z={z} onPress={onClose} /> : undefined}>
      <Columns ui={ui} left={left} right={right} ratio={0.85} />
    </ScreenFrame>
  );
}

const s = StyleSheet.create({
  card: { maxWidth: 420, padding: 18 },
  cardShort: { maxWidth: 720, paddingVertical: 14 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepCount: { color: C.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1.4 },
  skip: { paddingVertical: 4, paddingHorizontal: 8 },
  skipText: { color: C.muted, fontSize: 13, fontWeight: '800' },
  progress: { flexDirection: 'row' },
  demoPanel: { alignItems: 'center', justifyContent: 'center' },
  demoInner: { alignItems: 'center', justifyContent: 'center' },
  textScroll: { flexGrow: 0 },
  dot: { flex: 1, backgroundColor: 'rgba(255,255,255,0.12)' },
  dotOn: { backgroundColor: 'rgba(215,242,59,0.55)' },
  dotNow: { backgroundColor: C.accent },
  bodyRow: { flexDirection: 'row', gap: 18, alignItems: 'center' },
  demoArea: {
    alignItems: 'center', justifyContent: 'center', minHeight: 150, borderRadius: 14, marginBottom: 12,
    backgroundColor: '#1d2b3e', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
  },
  demoAreaShort: { width: 230, marginBottom: 0 },
  textCol: { flex: 1, minHeight: 0 },
  demoBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  demoCaption: { color: C.muted, fontSize: 11, fontWeight: '700', marginTop: 8 },
  olTitle: { color: C.accent, fontSize: 18, fontWeight: '900', marginBottom: 8 },
  olRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  olSide: { borderWidth: 1, borderRadius: 10, paddingVertical: 6, paddingHorizontal: 10, alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.04)' },
  olLabel: { fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  olName: { color: C.text, fontSize: 12, fontWeight: '800' },
  olVs: { color: C.accent, fontSize: 15, fontWeight: '900', fontStyle: 'italic' },
  olCodeLabel: { color: C.muted, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  olCode: { color: C.accent, fontSize: 26, fontWeight: '900', letterSpacing: 5, marginBottom: 8 },
  olSeat: { borderRadius: 8, paddingVertical: 5, paddingHorizontal: 8, backgroundColor: 'rgba(58,160,255,0.18)', borderWidth: 1, borderColor: 'rgba(58,160,255,0.55)' },
  olSeatText: { color: C.text, fontSize: 11, fontWeight: '800' },
  kicker: { color: C.accent, fontWeight: '900', letterSpacing: 1.6 },
  title: { color: C.text, fontWeight: '900' },
  bullet: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  bulletDot: { color: C.accent, fontSize: 14, lineHeight: 20, fontWeight: '900' },
  bodyText: { flex: 1, color: '#d3dde8', fontSize: 14, lineHeight: 20 },
  nav: { flexDirection: 'row', alignItems: 'center' },
  navBtn: { flex: 1 },
  navBtnMain: { flex: 2 },
  hidden: { opacity: 0 },
  navCol: { gap: 10, marginTop: 14 },
  joyBase: {
    width: 110, height: 110, borderRadius: 55, borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)',
    backgroundColor: 'rgba(10,16,26,0.35)', alignItems: 'center', justifyContent: 'center',
  },
  joyRing: {
    position: 'absolute', width: 62, height: 62, borderRadius: 31, borderWidth: 1,
    borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.18)',
  },
  joyKnob: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#4fa8f0', borderWidth: 2, borderColor: '#7cc2ff' },
  ball: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#e3f05a', borderWidth: 2, borderColor: '#c6d81c' },
  landRing: {
    position: 'absolute', bottom: 18, width: 54, height: 22, borderRadius: 27, borderWidth: 2,
    borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.75)',
  },
  miniCourt: { width: 190, height: 46, borderRadius: 4, backgroundColor: '#1f5c9e', borderWidth: 2, borderColor: '#f4f7fb' },
});
