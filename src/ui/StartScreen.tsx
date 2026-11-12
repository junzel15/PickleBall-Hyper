// First screen after loading: Sign In / Create Account, or Play Offline.
// Players who are already signed in skip it (see App.tsx).
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Backdrop, Brand, GameButton, Icon, IconName, Panel, RichList, useUiScale } from './gameUi';
import { C } from './theme';

const FEATURES: [IconName, string][] = [
  ['users', '1 vs 1 & 2 vs 2'],
  ['globe', 'Online play'],
  ['bolt', 'Hyper skill'],
  ['trophy', 'Ranked ladder'],
];

export function StartScreen({ short, onAccount, onOffline }: { short: boolean; onAccount: () => void; onOffline: () => void }) {
  void short; // sizing comes from the real screen size
  const { z, landscape, tight } = useUiScale();
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 560, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [enter]);
  const leftIn = { opacity: enter, transform: [{ translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [-40, 0] }) }] };
  const rightIn = { opacity: enter, transform: [{ translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }] };

  const left = (
    <Animated.View style={[landscape ? s.leftCol : null, { gap: z(tight ? 10 : 16) }, leftIn]}>
      <Brand z={z} size={tight ? 32 : 40} line="SPORTS ARCADE" />
      <Text style={[s.tagline, { fontSize: z(15), lineHeight: z(21) }]}>
        Fast, arcade pickleball on a real tournament court. Play the computer, your friends, or anyone online.
      </Text>
      <View style={[s.chips, { gap: z(8) }]}>
        {FEATURES.map(([icon, label]) => (
          <View key={label} style={[s.chip, { gap: z(6), paddingHorizontal: z(10), paddingVertical: z(6), borderRadius: z(10) }]}>
            <Icon name={icon} size={z(14)} color={C.accent} />
            <Text style={[s.chipText, { fontSize: z(12) }]}>{label}</Text>
          </View>
        ))}
      </View>
    </Animated.View>
  );

  const right = (
    <Animated.View style={[landscape ? s.rightCol : null, rightIn]}>
      <Panel z={z} title="HOW DO YOU WANT TO PLAY?" style={{ padding: z(14), gap: z(12) }}>
        <GameButton title="SIGN IN / CREATE ACCOUNT" icon="user" glow z={z} height={66}
          sub="Save your player · play online · climb the ranking" onPress={onAccount} />
        <GameButton title="PLAY OFFLINE" icon="play" color="blue" z={z} height={60}
          sub="Jump straight in · no account needed" onPress={onOffline} />
        <RichList z={z} size={12} items={[
          '**With an account:** your look, match history and online rating are saved and follow you to any phone.',
          '**Offline:** everything stays on this phone. You can sign in any time from the main menu.',
        ]} />
      </Panel>
    </Animated.View>
  );

  return (
    <View style={[StyleSheet.absoluteFill, s.screen]}>
      <Backdrop sweep={!tight} strength={1.08} />
      <ScrollView contentContainerStyle={[s.scroll, { padding: z(18) }]} showsVerticalScrollIndicator={false} bounces={false}>
        <View style={[landscape ? s.row : null, s.content, { gap: z(22), maxWidth: z(980) }]}>
          {left}
          {right}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { zIndex: 8 },
  scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  content: { width: '100%' },
  row: { flexDirection: 'row', alignItems: 'center' },
  leftCol: { flex: 1, minWidth: 0 },
  rightCol: { flex: 1.05, minWidth: 0 },
  tagline: { color: '#cfdcea', fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(20,31,48,0.85)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.3)',
  },
  chipText: { color: C.text, fontWeight: '800' },
});
