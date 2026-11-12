// Customize Player: name, look, outfit and paddle, full screen in the same premium
// style as the other menus (gameUi). The live preview shows the player holding the
// chosen paddle, exactly as they appear on court.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Game, UiState } from '../game/engine';
import {
  AVATAR_KEYS, Avatar, AvatarKey, cleanName, cloneProfile, DEFAULT_NAME, drawBodyPreview, drawPaddleUpright,
  FINISH_NAMES, OPTIONS, Paddle, PADDLES, paddleById, Profile, saveProfile, SHAPE_NAMES, SHOES,
} from '../game/customize';
import { Drawing, Tap } from './common';
import { Columns, Field, GameButton, GhostButton, Icon, Panel, ScreenFrame, Segments, useUiScale } from './gameUi';
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
type Line = 'all' | 'PRO SERIES' | 'SIGNATURE' | 'CLASSIC';
const lineOf = (p: Paddle): Exclude<Line, 'all'> => p.series ?? 'CLASSIC';

export function CustomizeScreen({ game, ui, short }: { game: Game; ui: UiState; short: boolean }) {
  void short; // sizing comes from the real screen size
  const scale = useUiScale();
  const { z, landscape } = scale;
  const [draft, setDraft] = useState<Profile>(() => cloneProfile(ui.profile));
  const [nameText, setNameText] = useState(ui.profile.name === DEFAULT_NAME ? '' : ui.profile.name);
  const [tab, setTab] = useState<Tab>('avatar');
  const [line, setLine] = useState<Line>('all');

  // Back (on screen or Android) keeps your changes, like Save
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
  const shown = useMemo(() => PADDLES.filter(p => line === 'all' || lineOf(p) === line), [line]);

  // ---- left: live preview, name, selected paddle, save ----
  const bodyH = z(landscape ? 196 : 210), bodyW = Math.round((bodyH * 120) / 260);
  const left = (
    <Panel z={z} title="YOUR PLAYER" flex={landscape} style={{ padding: z(12), gap: z(10) }}>
      <ScrollView style={landscape ? s.flex1 : null} contentContainerStyle={{ gap: z(10) }} showsVerticalScrollIndicator={false} bounces={false} scrollEnabled={landscape}>
        <View style={[s.row, { gap: z(12) }]}>
          <View style={[s.stage, { borderRadius: z(14), padding: z(4) }]}>
            <Drawing width={bodyW} height={bodyH} style={{ borderRadius: z(11) }} deps={[avatarKey, pd.id, bodyW, bodyH]}
              draw={ctx => drawBodyPreview(ctx, draft.avatar, pd, bodyW, bodyH)} />
            <View style={[s.stageTag, { borderRadius: z(8), paddingHorizontal: z(7), paddingVertical: z(2), bottom: z(8) }]}>
              <Text style={[s.stageTagText, { fontSize: z(9) }]}>LIVE PREVIEW</Text>
            </View>
          </View>
          <View style={[s.flex1, { gap: z(9) }]}>
            <Field label="PLAYER NAME" icon="user" z={z} value={nameText} onChangeText={setNameText}
              placeholder={DEFAULT_NAME} maxLength={16} autoCorrect={false} autoCapitalize="words"
              returnKeyType="done" accessibilityLabel="Player name" />
            {/* equipped paddle: tap to jump to the paddle tab */}
            <Tap onPress={() => setTab('paddle')} scale={0.97} accessibilityLabel="Change paddle"
              style={[s.equipped, { borderRadius: z(12), padding: z(6), gap: z(8) }]}>
              <Drawing width={z(30)} height={z(48)} deps={[pd.id, z(30)]} draw={ctx => drawPaddleUpright(ctx, pd, z(30), z(48), z(26))} />
              <View style={s.flex1}>
                <Text style={[s.kickerText, { fontSize: z(9) }]}>EQUIPPED PADDLE</Text>
                <Text style={[s.eqBrand, { fontSize: z(13.5) }]} numberOfLines={1}>{pd.brand}</Text>
                <Text style={[s.muted, { fontSize: z(11) }]} numberOfLines={1}>{pd.model}</Text>
              </View>
              <Icon name="edit" size={z(15)} color={C.accent} />
            </Tap>
            <GhostButton title="Random look" icon="refresh" small z={z} onPress={randomLook} />
          </View>
        </View>
      </ScrollView>
      <GameButton title="SAVE & BACK" sub="Your look is used in every match" icon="check" glow z={z} height={58} onPress={saveAndClose} />
    </Panel>
  );

  // ---- right: the editor ----
  const groups = (panel: 'avatar' | 'outfit') => (
    <View style={[s.groups, { gap: z(12) }]}>
      {GROUPS.filter(g => g.panel === panel && !(g.key === 'facial' && draft.avatar.gender === 'female')).map(g => (
        <View key={g.key} style={{ gap: z(6) }}>
          <Text style={[s.kickerText, { fontSize: z(10) }]}>{g.label.toUpperCase()}</Text>
          <View style={[s.wrap, { gap: z(7) }]}>
            {OPTIONS[g.key].map(o => {
              const active = draft.avatar[g.key] === o.v;
              const label = `${g.label}: ${o.n}`;
              if (g.type === 'swatch') {
                const d = z(32);
                return (
                  <Tap key={o.v} onPress={() => setAvatar(g.key, o.v)} scale={1.08} accessibilityLabel={label}
                    style={[s.swatch, { width: d, height: d, borderRadius: d / 2, backgroundColor: o.v }, active && s.swatchOn]}>
                    <View style={s.swatchShade} />
                    {active && <View style={s.swatchCheck}><Icon name="check" size={z(14)} color="#fff" /></View>}
                  </Tap>
                );
              }
              if (g.type === 'shoe') {
                const sh = SHOES[o.v];
                return (
                  <Tap key={o.v} onPress={() => setAvatar(g.key, o.v)} scale={1.08} accessibilityLabel={label}
                    style={[s.swatch, s.shoe, { width: z(38), height: z(30), borderTopLeftRadius: z(12), borderTopRightRadius: z(12) }, active && s.swatchOn]}>
                    <View style={[s.shoePart, { flex: 62, backgroundColor: sh.upper }]} />
                    <View style={[s.shoePart, { flex: 10, backgroundColor: sh.accent }]} />
                    <View style={[s.shoePart, { flex: 28, backgroundColor: sh.sole }]} />
                  </Tap>
                );
              }
              return (
                <Tap key={o.v} onPress={() => setAvatar(g.key, o.v)} scale={0.95} accessibilityLabel={label}
                  style={[s.chip, { paddingVertical: z(7), paddingHorizontal: z(12), borderRadius: z(10), gap: z(6) }, active && s.chipOn]}>
                  {g.type === 'guard' && o.v !== 'none' && <View style={[s.chipDot, { width: z(10), height: z(10), borderRadius: z(5), backgroundColor: o.v }]} />}
                  <Text style={[s.chipText, { fontSize: z(12.5) }, active && s.chipTextOn]}>{o.n}</Text>
                </Tap>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );

  const featH = z(150);
  const paddles = (
    <View style={{ gap: z(12) }}>
      {/* featured: the selected paddle, big */}
      <View style={[s.feature, { borderRadius: z(16), padding: z(10), gap: z(12) }]}>
        <View style={[s.featureStage, { borderRadius: z(12), width: z(96), height: featH }]}>
          <Drawing width={z(96)} height={featH} deps={[pd.id, featH]} draw={ctx => drawPaddleUpright(ctx, pd, z(96), featH, z(86))} />
        </View>
        <View style={[s.flex1, { gap: z(5) }]}>
          <View style={[s.row, { gap: z(6) }]}>
            <View style={[s.series, { borderRadius: z(6), paddingHorizontal: z(6), paddingVertical: z(2) }]}>
              <Text style={[s.seriesText, { fontSize: z(9) }]}>{lineOf(pd)}</Text>
            </View>
            <Text style={[s.muted, { fontSize: z(10.5) }]} numberOfLines={1}>{FINISH_NAMES[pd.finish ?? 'gloss']}</Text>
          </View>
          <Text style={[s.fBrand, { fontSize: z(22) }]} numberOfLines={1}>{pd.brand}</Text>
          <Text style={[s.muted, { fontSize: z(13), marginTop: -z(4) }]} numberOfLines={1}>{pd.model}</Text>
          <Stat label="POWER" value={pd.power} z={z} color={C.accent} />
          <Stat label="CONTROL" value={pd.control} z={z} color={C.you} />
          <Text style={[s.muted, { fontSize: z(11) }]} numberOfLines={1}>{SHAPE_NAMES[pd.shape]}</Text>
        </View>
      </View>

      <Segments z={z} value={line} onPick={setLine} options={[
        { v: 'all', label: 'All' }, { v: 'PRO SERIES', label: 'Pro' }, { v: 'SIGNATURE', label: 'Signature' }, { v: 'CLASSIC', label: 'Classic' },
      ]} />

      <View style={[s.wrap, { gap: z(8) }]}>
        {shown.map(p => {
          const on = p.id === draft.paddle;
          const cw = z(84), dh = z(84);
          return (
            <Tap key={p.id} onPress={() => setDraft(d => ({ ...d, paddle: p.id }))} scale={0.95}
              accessibilityLabel={`${p.brand} ${p.model}`}
              style={[s.pcard, { width: cw, borderRadius: z(12), paddingVertical: z(6), paddingHorizontal: z(4) }, on && s.pcardOn]}>
              <Drawing width={z(60)} height={dh} deps={[p.id, dh]} draw={ctx => drawPaddleUpright(ctx, p, z(60), dh, z(46))} />
              <Text style={[s.pcBrand, { fontSize: z(10.5) }]} numberOfLines={1}>{p.brand}</Text>
              <Text style={[s.pcModel, { fontSize: z(9.5) }]} numberOfLines={1}>{p.model}</Text>
              <View style={[s.miniBars, { gap: z(2), marginTop: z(3) }]}>
                <View style={[s.miniTrack, { height: z(3) }]}><View style={[s.miniFill, { width: `${p.power * 10}%`, backgroundColor: C.accent }]} /></View>
                <View style={[s.miniTrack, { height: z(3) }]}><View style={[s.miniFill, { width: `${p.control * 10}%`, backgroundColor: C.you }]} /></View>
              </View>
              {on && (
                <View style={[s.pcCheck, { top: z(4), right: z(4), width: z(18), height: z(18), borderRadius: z(9) }]}>
                  <Icon name="check" size={z(12)} color="#111" />
                </View>
              )}
            </Tap>
          );
        })}
      </View>
    </View>
  );

  const right = (
    <Panel z={z} flex={landscape} style={{ padding: z(12), gap: z(10) }}>
      <Segments z={z} value={tab} onPick={setTab} options={[
        { v: 'avatar', label: 'Player' }, { v: 'outfit', label: 'Outfit' }, { v: 'paddle', label: 'Paddle' },
      ]} />
      {landscape ? (
        <ScrollView style={s.flex1} contentContainerStyle={{ paddingBottom: z(6) }} showsVerticalScrollIndicator={false}>
          {tab === 'paddle' ? paddles : groups(tab)}
        </ScrollView>
      ) : (tab === 'paddle' ? paddles : groups(tab))}
    </Panel>
  );

  return (
    <ScreenFrame title="Customize player" kicker="LOOK · OUTFIT · PADDLE" onBack={saveAndClose} ui={scale} zIndex={7}>
      <Columns left={left} right={right} ui={scale} ratio={0.82} />
    </ScreenFrame>
  );
}

function Stat({ label, value, z, color }: { label: string; value: number; z: (n: number) => number; color: string }) {
  return (
    <View style={[s.row, { gap: z(8) }]}>
      <Text style={[s.kickerText, { fontSize: z(9), width: z(56) }]}>{label}</Text>
      <View style={[s.statTrack, { height: z(7), borderRadius: z(4) }]}>
        <View style={[s.statFill, { width: `${value * 10}%`, backgroundColor: color, borderRadius: z(4) }]} />
      </View>
      <Text style={[s.statNum, { fontSize: z(12), width: z(18) }]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  flex1: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  groups: {},
  muted: { color: C.muted, fontWeight: '700' },
  kickerText: { color: C.muted, fontWeight: '900', letterSpacing: 1.2 },
  stage: {
    alignItems: 'center', backgroundColor: 'rgba(8,13,22,0.55)',
    borderWidth: 1, borderColor: 'rgba(215,242,59,0.28)',
  },
  stageTag: { position: 'absolute', backgroundColor: 'rgba(11,17,26,0.8)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.4)' },
  stageTagText: { color: C.accent, fontWeight: '900', letterSpacing: 1 },
  equipped: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(20,31,48,0.85)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  eqBrand: { color: C.text, fontWeight: '900', letterSpacing: 0.8 },
  swatch: { borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  swatchShade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '22%', backgroundColor: 'rgba(0,0,0,0.18)' },
  swatchCheck: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
  swatchOn: { borderColor: C.accent, shadowColor: C.accent, shadowOpacity: 1, shadowRadius: 4, elevation: 4 },
  shoe: { borderBottomLeftRadius: 6, borderBottomRightRadius: 6 },
  shoePart: { alignSelf: 'stretch' },
  chip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(20,31,48,0.85)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
  },
  chipOn: { backgroundColor: C.accent, borderColor: C.accent },
  chipText: { color: C.text, fontWeight: '800' },
  chipTextOn: { color: '#111' },
  chipDot: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  feature: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(31,92,158,0.28)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.3)',
  },
  featureStage: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(8,13,22,0.5)', overflow: 'hidden' },
  series: { backgroundColor: C.accent },
  seriesText: { color: '#111', fontWeight: '900', letterSpacing: 0.8 },
  fBrand: { color: C.text, fontWeight: '900', letterSpacing: 1.6 },
  statTrack: { flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', overflow: 'hidden' },
  statFill: { height: '100%' },
  statNum: { color: C.text, fontWeight: '900', textAlign: 'right' },
  pcard: {
    alignItems: 'center',
    backgroundColor: 'rgba(20,31,48,0.85)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  pcardOn: { borderColor: C.accent, borderWidth: 2, backgroundColor: 'rgba(215,242,59,0.1)' },
  pcBrand: { color: C.text, fontWeight: '900', letterSpacing: 0.5 },
  pcModel: { color: C.muted, fontWeight: '700' },
  miniBars: { alignSelf: 'stretch', paddingHorizontal: 6 },
  miniTrack: { borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.1)', overflow: 'hidden' },
  miniFill: { height: '100%' },
  pcCheck: { position: 'absolute', backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
});
