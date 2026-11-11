// Customize: player name, look, outfit and paddle (the browser game's #settings screen).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { Game, UiState } from '../game/engine';
import {
  AVATAR_KEYS, Avatar, AvatarKey, cleanName, cloneProfile, DEFAULT_NAME, drawBodyPreview, drawPaddleUpright,
  drawPortrait, OPTIONS, PADDLES, paddleById, Profile, saveProfile, SHAPE_NAMES, SHOES,
} from '../game/customize';
import { BackButton, Btn, Card, Drawing, Overlay, Tap } from './common';
import { C } from './theme';

type GroupType = 'chip' | 'swatch' | 'shoe' | 'guard';
const GROUPS: { key: AvatarKey; label: string; type: GroupType; panel: 'avatar' | 'outfit' }[] = [
  { key: 'gender', label: 'Gender', type: 'chip', panel: 'avatar' },
  { key: 'skin', label: 'Skin tone', type: 'swatch', panel: 'avatar' },
  { key: 'hair', label: 'Hair style', type: 'chip', panel: 'avatar' },
  { key: 'hairColor', label: 'Hair color', type: 'swatch', panel: 'avatar' },
  { key: 'eyes', label: 'Eye color', type: 'swatch', panel: 'avatar' },
  { key: 'facial', label: 'Facial hair', type: 'chip', panel: 'avatar' },
  { key: 'headwear', label: 'Headwear', type: 'chip', panel: 'avatar' },
  { key: 'hatColor', label: 'Headwear color', type: 'swatch', panel: 'avatar' },
  { key: 'shirtStyle', label: 'T-shirt style', type: 'chip', panel: 'outfit' },
  { key: 'shirt', label: 'T-shirt color', type: 'swatch', panel: 'outfit' },
  { key: 'shirtAccent', label: 'Trim / sleeve color', type: 'swatch', panel: 'outfit' },
  { key: 'shortsStyle', label: 'Shorts style', type: 'chip', panel: 'outfit' },
  { key: 'shortsColor', label: 'Shorts color', type: 'swatch', panel: 'outfit' },
  { key: 'shoes', label: 'Shoes', type: 'shoe', panel: 'outfit' },
  { key: 'kneeGuard', label: 'Knee guards', type: 'guard', panel: 'outfit' },
  { key: 'elbowGuard', label: 'Elbow guards', type: 'guard', panel: 'outfit' },
];

type Tab = 'avatar' | 'outfit' | 'paddle';

export function CustomizeScreen({ game, ui, short }: { game: Game; ui: UiState; short: boolean }) {
  const [draft, setDraft] = useState<Profile>(() => cloneProfile(ui.profile));
  const [nameText, setNameText] = useState(ui.profile.name === DEFAULT_NAME ? '' : ui.profile.name);
  const [tab, setTab] = useState<Tab>('avatar');

  // Back (on screen or Android) keeps your changes, like the browser game
  const latest = useRef({ draft, nameText });
  latest.current = { draft, nameText };
  const saveAndClose = useCallback(() => {
    const p = cloneProfile(latest.current.draft);
    p.name = cleanName(latest.current.nameText);
    saveProfile(p);
    game.closeCustomize(p);
  }, [game]);
  useEffect(() => {
    game.setCustomizeSaver(saveAndClose);
    return () => game.setCustomizeSaver(null);
  }, [game, saveAndClose]);

  const setAvatar = (key: AvatarKey, v: string) => {
    setDraft(d => {
      const avatar: Avatar = { ...d.avatar, [key]: v };
      if (key === 'gender' && v === 'female') avatar.facial = 'none'; // keep the look consistent
      return { ...d, avatar };
    });
  };
  const randomLook = () => {
    setDraft(d => {
      const avatar = { ...d.avatar };
      for (const k of AVATAR_KEYS) {
        const opts = OPTIONS[k];
        avatar[k] = opts[(Math.random() * opts.length) | 0].v;
      }
      if (avatar.gender === 'female') avatar.facial = 'none';
      // guards are optional gear: leave them off most of the time
      if (Math.random() < 0.6) avatar.kneeGuard = 'none';
      if (Math.random() < 0.7) avatar.elbowGuard = 'none';
      return { ...d, avatar };
    });
  };

  const avatarKey = JSON.stringify(draft.avatar);
  const pd = paddleById(draft.paddle);

  const groups = (panel: 'avatar' | 'outfit') => (
    <View style={[s.optGroups, short && panel === 'avatar' && s.twoCol]}>
      {GROUPS.filter(g => g.panel === panel && !(g.key === 'facial' && draft.avatar.gender === 'female')).map(g => (
        <View key={g.key} style={[s.optGroup, short && panel === 'avatar' && s.half]}>
          <Text style={s.optLabel}>{g.label}</Text>
          <View style={s.wrapRow}>
            {OPTIONS[g.key].map(o => {
              const active = draft.avatar[g.key] === o.v;
              const label = `${g.label}: ${o.n}`;
              if (g.type === 'swatch') {
                return (
                  <Tap key={o.v} onPress={() => setAvatar(g.key, o.v)} scale={1.08} accessibilityLabel={label}
                    style={[s.swatch, { backgroundColor: o.v }, active && s.swatchActive]}>
                    <View style={s.swatchShade} />
                  </Tap>
                );
              }
              if (g.type === 'shoe') {
                const sh = SHOES[o.v];
                return (
                  <Tap key={o.v} onPress={() => setAvatar(g.key, o.v)} scale={1.08} accessibilityLabel={label}
                    style={[s.swatch, s.shoe, active && s.swatchActive]}>
                    <View style={{ flex: 62, backgroundColor: sh.upper }} />
                    <View style={{ flex: 10, backgroundColor: sh.accent }} />
                    <View style={{ flex: 28, backgroundColor: sh.sole }} />
                  </Tap>
                );
              }
              return (
                <Tap key={o.v} onPress={() => setAvatar(g.key, o.v)} scale={0.95} accessibilityLabel={label}
                  style={[s.chip, active && s.chipActive]}>
                  {g.type === 'guard' && o.v !== 'none' && <View style={[s.chipDot, { backgroundColor: o.v }]} />}
                  <Text style={[s.chipText, active && { color: '#111' }]}>{o.n}</Text>
                </Tap>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );

  return (
    <Overlay z={6}>
      <Card style={[s.card, short && s.cardShort]}>
        <View style={s.head}>
          <BackButton inline onPress={saveAndClose} label="Back (keeps your changes)" />
          <Text style={s.h2}>Customize</Text>
        </View>
        <View style={[s.tabs, short && { marginVertical: 8 }]}>
          {([['avatar', 'Player'], ['outfit', 'Outfit'], ['paddle', 'Paddle']] as [Tab, string][]).map(([t, n]) => (
            <Tap key={t} onPress={() => setTab(t)} scale={0.97} style={[s.tab, tab === t && s.tabActive]}>
              <Text style={[s.tabText, tab === t && { color: '#111' }]}>{n}</Text>
            </Tap>
          ))}
        </View>

        {tab === 'avatar' && (
          <View>
            <View style={s.avatarTop}>
              <Drawing width={150} height={165} style={s.portrait} deps={[avatarKey]}
                draw={ctx => drawPortrait(ctx, draft.avatar, 150, 165)} />
              <View style={s.nameField}>
                <Text style={s.fieldLabel}>PLAYER NAME</Text>
                <TextInput
                  value={nameText}
                  onChangeText={setNameText}
                  placeholder={DEFAULT_NAME}
                  placeholderTextColor="rgba(238,243,248,0.4)"
                  maxLength={16}
                  autoCorrect={false}
                  autoCapitalize="words"
                  returnKeyType="done"
                  onSubmitEditing={saveAndClose}
                  style={s.input}
                />
                <Btn title="🎲 Random look" secondary small onPress={randomLook} style={{ alignSelf: 'flex-start' }} />
              </View>
            </View>
            {groups('avatar')}
          </View>
        )}

        {tab === 'outfit' && (
          <View style={s.outfitWrap}>
            <Drawing width={120} height={260} style={s.portrait} deps={[avatarKey, draft.paddle]}
              draw={ctx => drawBodyPreview(ctx, draft.avatar, pd, 120, 260)} />
            <View style={{ flex: 1, minWidth: 0 }}>{groups('outfit')}</View>
          </View>
        )}

        {tab === 'paddle' && (
          <View>
            <View style={s.paddleFeature}>
              <Drawing width={110} height={190} deps={[pd.id]} draw={ctx => drawPaddleUpright(ctx, pd, 110, 190, 100)} />
              <View style={s.pdInfo}>
                <Text style={s.pdBrand}>{pd.brand}</Text>
                <Text style={s.pdModel}>{pd.model}</Text>
                <Stat label="Power" value={pd.power} />
                <Stat label="Control" value={pd.control} />
                <Text style={s.pdShape}>{SHAPE_NAMES[pd.shape]}</Text>
              </View>
            </View>
            <View style={s.paddleGrid}>
              {PADDLES.map(p => (
                <Tap key={p.id} onPress={() => setDraft(d => ({ ...d, paddle: p.id }))} scale={0.97}
                  accessibilityLabel={`${p.brand} ${p.model}`}
                  style={[s.pcard, p.id === draft.paddle && s.pcardActive]}>
                  <Drawing width={64} height={104} deps={[p.id]} draw={ctx => drawPaddleUpright(ctx, p, 64, 104, 56)} />
                  <Text style={s.pcBrand}>{p.brand}</Text>
                  <Text style={s.pcModel}>{p.model}</Text>
                </Tap>
              ))}
            </View>
          </View>
        )}

        <View style={s.row}>
          <Btn title="Save" onPress={saveAndClose} />
        </View>
      </Card>
    </Overlay>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <View style={s.statTrack}>
        <View style={[s.statFill, { width: `${value * 10}%` }]}>
          <View style={[s.statFillEnd]} />
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { maxWidth: 440, padding: 16 },
  cardShort: { maxWidth: 760, paddingVertical: 12, paddingHorizontal: 14 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  h2: { color: C.text, fontSize: 26, fontWeight: '800' },
  tabs: { flexDirection: 'row', gap: 6, marginVertical: 12, backgroundColor: 'rgba(0,0,0,0.25)', padding: 4, borderRadius: 10 },
  tab: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  tabActive: { backgroundColor: C.accent },
  tabText: { color: C.muted, fontWeight: '800', fontSize: 14 },
  avatarTop: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  portrait: { borderRadius: 14, overflow: 'hidden' },
  nameField: { flex: 1, minWidth: 0, gap: 6 },
  fieldLabel: { fontSize: 12, letterSpacing: 1.2, color: C.muted },
  input: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: C.input, color: C.text, fontSize: 16, fontWeight: '700',
  },
  optGroups: { gap: 10, marginTop: 14 },
  twoCol: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16 },
  half: { width: '47%' },
  optGroup: {},
  optLabel: { fontSize: 12, color: C.muted, marginBottom: 5, fontWeight: '700' },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  swatch: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)', overflow: 'hidden' },
  swatchShade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 6, backgroundColor: 'rgba(0,0,0,0.18)' },
  swatchActive: { borderColor: C.accent, shadowColor: C.accent, shadowOpacity: 1, shadowRadius: 2, elevation: 3, transform: [{ scale: 1.08 }] },
  shoe: { width: 34, borderTopLeftRadius: 10, borderTopRightRadius: 10, borderBottomLeftRadius: 6, borderBottomRightRadius: 6 },
  chip: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  chipActive: { backgroundColor: C.accent, borderColor: C.accent },
  chipText: { color: C.text, fontSize: 13, fontWeight: '700' },
  chipDot: { width: 10, height: 10, borderRadius: 5, marginRight: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  outfitWrap: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  paddleFeature: { flexDirection: 'row', gap: 14, alignItems: 'center', padding: 10, borderRadius: 14, backgroundColor: '#1d2b3e' },
  pdInfo: { flex: 1, minWidth: 0 },
  pdBrand: { color: C.text, fontSize: 22, fontWeight: '900', letterSpacing: 1.8 },
  pdModel: { color: C.muted, fontSize: 14, marginBottom: 10 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 5 },
  statLabel: { width: 52, color: C.muted, fontSize: 12 },
  statTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.1)', overflow: 'hidden' },
  statFill: { height: '100%', borderRadius: 4, backgroundColor: C.you, overflow: 'hidden' },
  statFillEnd: { position: 'absolute', right: 0, top: 0, bottom: 0, width: '50%', backgroundColor: C.accent, opacity: 0.85 },
  pdShape: { color: C.muted, fontSize: 12, marginTop: 8 },
  paddleGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  pcard: {
    width: 86, alignItems: 'center', gap: 2, paddingVertical: 6, paddingHorizontal: 4, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', backgroundColor: 'rgba(255,255,255,0.03)',
  },
  pcardActive: { borderColor: C.accent, backgroundColor: 'rgba(215,242,59,0.08)' },
  pcBrand: { color: C.text, fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  pcModel: { color: C.muted, fontSize: 10, textAlign: 'center' },
  row: { flexDirection: 'row', gap: 10, justifyContent: 'center', marginTop: 14 },
});
