// Shown right after a successful registration: a branded "Account created!" card
// that asks for the player's in-game name and age, then takes them into the game.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type { Game, UiState } from '../game/engine';
import {
  cleanAge, cleanName, cloneProfile, DEFAULT_NAME, drawPortrait, MAX_AGE, MIN_AGE, saveProfile,
} from '../game/customize';
import { Btn, Card, Drawing, Overlay } from './common';
import { C } from './theme';

/** Lime check mark that pops in. */
function SuccessBadge() {
  const pop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(pop, { toValue: 1, friction: 5, tension: 120, useNativeDriver: true }).start();
  }, [pop]);
  const scale = pop.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] });
  return (
    <Animated.View style={[s.badge, { opacity: pop, transform: [{ scale }] }]}>
      <Svg width={54} height={54} viewBox="0 0 54 54">
        <Circle cx={27} cy={27} r={25} fill={C.accent} />
        <Circle cx={27} cy={27} r={25} fill="none" stroke="#ffffff" strokeOpacity={0.35} strokeWidth={2} />
        <Path d="M16 28.5l7.5 7.5L38.5 20" fill="none" stroke="#111111" strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    </Animated.View>
  );
}

export function WelcomeModal({ game, ui, email, onDone, short }: {
  game: Game; ui: UiState; email: string; onDone: () => void; short: boolean;
}) {
  const [name, setName] = useState(ui.profile.name === DEFAULT_NAME ? '' : ui.profile.name);
  const [age, setAge] = useState(ui.profile.age ? String(ui.profile.age) : '');
  const [error, setError] = useState<string | null>(null);
  const ageRef = useRef<React.ComponentRef<typeof TextInput>>(null);

  const save = () => {
    const trimmed = name.replace(/\s+/g, ' ').trim();
    if (!trimmed) { setError('Enter your player name.'); return; }
    const cleanedName = cleanName(trimmed);
    const cleanedAge = cleanAge(age);
    if (cleanedAge === null) { setError(`Enter your age (${MIN_AGE}–${MAX_AGE}).`); return; }
    const p = cloneProfile(ui.profile);
    p.name = cleanedName;
    p.age = cleanedAge;
    saveProfile(p);   // on this phone
    game.setProfile(p); // in the game (menus, name tag); cloud sync uploads it
    onDone();
  };

  const avatarKey = JSON.stringify(ui.profile.avatar);
  return (
    <Overlay z={9}>
      <Card style={[s.card, short && s.cardShort]}>
        <View style={[s.top, short && s.topShort]}>
          <View style={s.hero}>
            <SuccessBadge />
            <Text style={s.title}>Account created!</Text>
            <Text style={s.subtitle}>Welcome to PickleBall: <Text style={s.lime}>Hyper</Text></Text>
            <View style={s.emailPill}>
              <Text style={s.emailText} numberOfLines={1}>✉ {email}</Text>
            </View>
          </View>

          <View style={[s.form, short && s.formShort]}>
            <View style={s.formHead}>
              <Drawing width={46} height={50} style={s.portrait} deps={[avatarKey]}
                draw={ctx => drawPortrait(ctx, ui.profile.avatar, 46, 50)} />
              <View style={{ flex: 1 }}>
                <Text style={s.formTitle}>Set up your player</Text>
                <Text style={s.formSub}>Your name appears in the game menu and on the leaderboard.</Text>
              </View>
            </View>

            <Text style={s.label}>PLAYER NAME</Text>
            <TextInput
              value={name}
              onChangeText={t => { setName(t); setError(null); }}
              placeholder="e.g. Ace Smith"
              placeholderTextColor="rgba(238,243,248,0.4)"
              maxLength={16}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="next"
              onSubmitEditing={() => ageRef.current?.focus()}
              style={s.input}
              accessibilityLabel="Player name"
            />
            <Text style={s.hint}>{name.trim().length}/16</Text>

            <Text style={s.label}>AGE</Text>
            <TextInput
              ref={ageRef}
              value={age}
              onChangeText={t => { setAge(t.replace(/\D/g, '').slice(0, 3)); setError(null); }}
              placeholder="e.g. 25"
              placeholderTextColor="rgba(238,243,248,0.4)"
              keyboardType="number-pad"
              maxLength={3}
              returnKeyType="done"
              onSubmitEditing={save}
              style={[s.input, s.ageInput]}
              accessibilityLabel="Age"
            />

            {error && <Text style={s.error}>{error}</Text>}
            <Btn title="Let's play  ▶" onPress={save} style={s.play} textStyle={s.playText} />
            <Text style={s.privacy}>🔒 Your age is private and never shown to other players.</Text>
          </View>
        </View>
      </Card>
    </Overlay>
  );
}

const s = StyleSheet.create({
  card: { maxWidth: 400, padding: 0, overflow: 'hidden', borderColor: 'rgba(215,242,59,0.35)' },
  cardShort: { maxWidth: 720 },
  top: {},
  topShort: { flexDirection: 'row' },
  hero: {
    alignItems: 'center', paddingVertical: 22, paddingHorizontal: 20,
    backgroundColor: '#1f5c9e', borderBottomWidth: 4, borderBottomColor: C.accent,
  },
  badge: {
    width: 54, height: 54, borderRadius: 27, marginBottom: 12,
    shadowColor: C.accent, shadowOpacity: 0.6, shadowRadius: 16, elevation: 8,
  },
  title: { color: '#ffffff', fontSize: 26, fontWeight: '900', textAlign: 'center' },
  subtitle: { color: '#cfe2f7', fontSize: 14, fontWeight: '700', marginTop: 4, textAlign: 'center' },
  lime: { color: C.accent },
  emailPill: {
    marginTop: 12, paddingVertical: 5, paddingHorizontal: 12, borderRadius: 999, maxWidth: '100%',
    backgroundColor: 'rgba(10,16,26,0.35)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  emailText: { color: '#eef3f8', fontSize: 12, fontWeight: '700' },
  form: { padding: 18 },
  formShort: { flex: 1.3 },
  formHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  portrait: { borderRadius: 9, overflow: 'hidden' },
  formTitle: { color: C.text, fontSize: 17, fontWeight: '900' },
  formSub: { color: C.muted, fontSize: 12, lineHeight: 16, marginTop: 2 },
  label: { fontSize: 12, letterSpacing: 1.2, color: C.muted, marginTop: 10, marginBottom: 6, fontWeight: '700' },
  input: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: C.input, color: C.text, fontSize: 16, fontWeight: '700',
  },
  ageInput: { width: 110 },
  hint: { color: C.muted, fontSize: 11, textAlign: 'right', marginTop: 3 },
  error: {
    marginTop: 10, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 8, overflow: 'hidden',
    backgroundColor: 'rgba(255,93,93,0.1)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.45)',
    color: '#ff8a8a', fontSize: 13, fontWeight: '700', textAlign: 'center',
  },
  play: { marginTop: 14, paddingVertical: 12 },
  playText: { fontSize: 17, fontWeight: '900' },
  privacy: { color: C.muted, fontSize: 11, textAlign: 'center', marginTop: 10 },
});
