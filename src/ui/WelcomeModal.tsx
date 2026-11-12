// Shown right after a successful registration: "Account created!" plus the player's
// in-game name and age, then into the game. Same look as the other menus (gameUi).
import React, { useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { Game, UiState } from '../game/engine';
import {
  cleanAge, cleanName, cloneProfile, DEFAULT_NAME, drawPortrait, MAX_AGE, MIN_AGE, saveProfile,
} from '../game/customize';
import { Drawing } from './common';
import { Field, GameButton, Icon, MenuSheet, useUiScale } from './gameUi';
import { C } from './theme';

export function WelcomeModal({ game, ui, email, onDone, short }: {
  game: Game; ui: UiState; email: string; onDone: () => void; short: boolean;
}) {
  void short; // sizing comes from the real screen size
  const scale = useUiScale();
  const { z, landscape } = scale;
  const [name, setName] = useState(ui.profile.name === DEFAULT_NAME ? '' : ui.profile.name);
  const [age, setAge] = useState(ui.profile.age ? String(ui.profile.age) : '');
  const [error, setError] = useState<{ field: 'name' | 'age'; text: string } | null>(null);
  const ageRef = useRef<React.ComponentRef<typeof TextInput>>(null);

  const save = () => {
    const trimmed = name.replace(/\s+/g, ' ').trim();
    if (!trimmed) { setError({ field: 'name', text: 'Enter your player name.' }); return; }
    const cleanedAge = cleanAge(age);
    if (cleanedAge === null) { setError({ field: 'age', text: `Enter your age (${MIN_AGE}–${MAX_AGE}).` }); return; }
    const p = cloneProfile(ui.profile);
    p.name = cleanName(trimmed);
    p.age = cleanedAge;
    saveProfile(p);   // on this phone
    game.setProfile(p); // in the game (menus, name tag); cloud sync uploads it
    onDone();
  };

  const avatarKey = JSON.stringify(ui.profile.avatar);
  const pw = z(52), ph = z(56);
  return (
    <MenuSheet kicker="ACCOUNT CREATED" title="Set up your player" icon="check" ui={scale} maxWidth={landscape ? 560 : 420} zIndex={9}>
      {/* who: avatar, welcome and the account e-mail */}
      <View style={[s.hero, { gap: z(12), padding: z(10), borderRadius: z(14) }]}>
        <Drawing width={pw} height={ph} style={[s.portrait, { borderRadius: z(10) }]} deps={[avatarKey, pw]}
          draw={ctx => drawPortrait(ctx, ui.profile.avatar, pw, ph)} />
        <View style={s.flex1}>
          <Text style={[s.welcome, { fontSize: z(16) }]} numberOfLines={1}>
            Welcome to PickleBall: <Text style={s.lime}>Hyper</Text>
          </Text>
          <View style={[s.mailRow, { gap: z(6), marginTop: z(4) }]}>
            <Icon name="mail" size={z(13)} color={C.muted} />
            <Text style={[s.mail, { fontSize: z(12) }]} numberOfLines={1}>{email}</Text>
          </View>
        </View>
      </View>

      <View style={[landscape ? s.row : null, { gap: z(12) }]}>
        <View style={landscape ? s.nameCol : null}>
          <Field label={`PLAYER NAME · ${name.trim().length}/16`} icon="user" z={z} error={error?.field === 'name'}
            value={name}
            onChangeText={t => { setName(t); setError(null); }}
            placeholder="e.g. Ace Smith" maxLength={16} autoCapitalize="words" autoCorrect={false}
            returnKeyType="next" onSubmitEditing={() => ageRef.current?.focus()} accessibilityLabel="Player name" />
        </View>
        <View style={landscape ? s.ageCol : null}>
          <Field ref={ageRef} label="AGE" icon="lock" z={z} error={error?.field === 'age'}
            value={age}
            onChangeText={t => { setAge(t.replace(/\D/g, '').slice(0, 3)); setError(null); }}
            placeholder="e.g. 25" keyboardType="number-pad" maxLength={3}
            returnKeyType="done" onSubmitEditing={save} accessibilityLabel="Age" />
        </View>
      </View>

      {error && (
        <Text style={[s.error, { fontSize: z(12.5), padding: z(8), borderRadius: z(10) }]}>{error.text}</Text>
      )}
      <GameButton title="LET'S PLAY" sub="Your name shows in menus and on the leaderboard" icon="play" glow z={z} height={64} titleSize={22} onPress={save} />
      <Text style={[s.privacy, { fontSize: z(11) }]}>Your age is private and never shown to other players.</Text>
    </MenuSheet>
  );
}

const s = StyleSheet.create({
  flex1: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row' },
  nameCol: { flex: 1.6, minWidth: 0 },
  ageCol: { flex: 1, minWidth: 0 },
  hero: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(31,92,158,0.35)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.28)',
  },
  portrait: { overflow: 'hidden' },
  welcome: { color: C.text, fontWeight: '900' },
  lime: { color: C.accent },
  mailRow: { flexDirection: 'row', alignItems: 'center' },
  mail: { color: C.muted, fontWeight: '700', flexShrink: 1 },
  error: {
    overflow: 'hidden', backgroundColor: 'rgba(255,93,93,0.1)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.45)',
    color: '#ff8a8a', fontWeight: '800', textAlign: 'center',
  },
  privacy: { color: C.muted, textAlign: 'center', fontWeight: '600' },
});
