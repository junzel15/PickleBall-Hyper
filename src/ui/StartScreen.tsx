// First screen after loading: Sign In / Create Account, or Play Offline.
// Players who are already signed in skip it (see App.tsx).
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { Card, GradientTitle, Overlay, Tap } from './common';
import { C } from './theme';

function OptionIcon({ kind }: { kind: 'account' | 'offline' }) {
  return (
    <Svg width={30} height={30} viewBox="0 0 24 24">
      {kind === 'account' ? (
        <>
          <Circle cx={12} cy={8} r={4} fill="#111111" />
          <Path d="M4 20c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" fill="#111111" />
        </>
      ) : (
        <Path d="M8 5.5v13l10.5-6.5z" fill="#ffffff" />
      )}
    </Svg>
  );
}

function Option({ kind, title, text, perks, onPress, delay }: {
  kind: 'account' | 'offline'; title: string; text: string; perks: string[]; onPress: () => void; delay: number;
}) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(a, { toValue: 1, delay, friction: 7, tension: 80, useNativeDriver: true }).start();
  }, [a, delay]);
  const y = a.interpolate({ inputRange: [0, 1], outputRange: [18, 0] });
  const account = kind === 'account';
  return (
    <Animated.View style={[s.optWrap, { opacity: a, transform: [{ translateY: y }] }]}>
      <Tap onPress={onPress} scale={0.97} style={[s.opt, account ? s.optAccount : s.optOffline]}
        accessibilityLabel={title}>
        <View style={[s.sym, account ? s.symAccount : s.symOffline]}>
          <OptionIcon kind={kind} />
        </View>
        <Text style={[s.optTitle, account && s.dark]}>{title}</Text>
        <Text style={[s.optText, account && s.darkMuted]}>{text}</Text>
        <View style={s.perks}>
          {perks.map(p => (
            <Text key={p} style={[s.perk, account && s.darkMuted]}>{account ? '✓' : '•'}  {p}</Text>
          ))}
        </View>
      </Tap>
    </Animated.View>
  );
}

export function StartScreen({ short, onAccount, onOffline }: { short: boolean; onAccount: () => void; onOffline: () => void }) {
  return (
    <Overlay z={8}>
      <Card style={[s.card, short && s.cardShort]}>
        <View style={s.head}>
          <GradientTitle text="Pickleball" size={short ? 28 : 34} />
          <View style={s.hyperTag}><Text style={s.hyperText}>HYPER</Text></View>
        </View>
        <Text style={s.tagline}>How do you want to play?</Text>
        <View style={[s.options, short && s.optionsRow]}>
          <Option
            kind="account"
            title="Sign In / Create Account"
            text="Play with your PickleBall: Hyper account."
            perks={['Profile saved online', 'Match history', 'Leaderboard']}
            onPress={onAccount}
            delay={80}
          />
          <Option
            kind="offline"
            title="Play Offline"
            text="Jump straight in, no account needed."
            perks={['Progress stays on this phone', 'Sign in any time later']}
            onPress={onOffline}
            delay={180}
          />
        </View>
      </Card>
    </Overlay>
  );
}

const s = StyleSheet.create({
  card: { maxWidth: 400, paddingVertical: 18, paddingHorizontal: 16 },
  cardShort: { maxWidth: 680, paddingVertical: 14 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  hyperTag: {
    backgroundColor: C.accent, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2,
    transform: [{ rotate: '-6deg' }],
  },
  hyperText: { color: '#111', fontSize: 13, fontWeight: '900', letterSpacing: 1 },
  tagline: { color: C.muted, fontSize: 15, fontWeight: '700', textAlign: 'center', marginTop: 4, marginBottom: 14 },
  options: { gap: 12 },
  optionsRow: { flexDirection: 'row' },
  optWrap: { flex: 1 },
  opt: { flex: 1, alignItems: 'center', borderRadius: 18, paddingVertical: 16, paddingHorizontal: 14 },
  optAccount: {
    backgroundColor: '#d7f23b', shadowColor: C.accent, shadowOpacity: 0.35, shadowRadius: 18, elevation: 8,
  },
  optOffline: {
    backgroundColor: '#183152', borderWidth: 2, borderColor: 'rgba(58,160,255,0.7)',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 18, elevation: 6,
  },
  sym: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  symAccount: { backgroundColor: 'rgba(0,0,0,0.12)' },
  symOffline: { backgroundColor: C.you },
  optTitle: { color: C.text, fontSize: 18, fontWeight: '900', textAlign: 'center' },
  optText: { color: '#cfdcea', fontSize: 13, textAlign: 'center', marginTop: 4, lineHeight: 18 },
  dark: { color: '#111' },
  darkMuted: { color: '#2b3410' },
  perks: { marginTop: 10, alignSelf: 'stretch', gap: 3 },
  perk: { color: '#cfdcea', fontSize: 12, fontWeight: '700', textAlign: 'center' },
});
