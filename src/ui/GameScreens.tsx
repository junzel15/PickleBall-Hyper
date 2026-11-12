// In-game menu, game over card, point banner and the small HUD buttons.
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import type { BannerState, Game, UiState } from '../game/engine';
import { Btn, Card, Overlay, Tap } from './common';
import { C } from './theme';

export function PauseMenu({ game, ui }: { game: Game; ui: UiState }) {
  return (
    <Overlay>
      <Card style={{ maxWidth: 300, alignItems: 'center' }}>
        <Text style={s.h2}>Menu</Text>
        <Text style={s.tagline}>Game paused</Text>
        <View style={s.playerPill}>
          <Text style={s.playerLabel}>PLAYING AS</Text>
          <Text style={s.playerName} numberOfLines={1}>{ui.profile.name}</Text>
        </View>
        <View style={s.menuList}>
          <Btn title="▶ Resume" onPress={() => game.togglePause()} />
          <Btn title="🎨 Customize player" secondary onPress={() => game.openCustomize()} />
          <Btn title="↻ Restart match" secondary onPress={() => game.startGame()} />
          <Btn title="⌂ Main menu" secondary onPress={() => game.openMainMenuFromGame()} />
        </View>
      </Card>
    </Overlay>
  );
}

export function GameOver({ game, ui }: { game: Game; ui: UiState }) {
  return (
    <Overlay>
      <Card style={{ alignItems: 'center' }}>
        <Text style={s.h2}>{ui.gameOver.title}</Text>
        <Text style={s.final}>{ui.gameOver.score}</Text>
        <Text style={s.tagline}>{ui.gameOver.stats}</Text>
        <View style={s.row}>
          <Btn title="Play again" onPress={() => game.startGame()} />
          <Btn title="Menu" secondary onPress={() => game.toMenu()} />
        </View>
      </Card>
    </Overlay>
  );
}

/** Point result banner over your half of the court (.banner with bannerIn). */
export function Banner({ banner }: { banner: BannerState }) {
  const a = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (banner.show) {
      a.setValue(0);
      opacity.setValue(0);
      Animated.parallel([
        Animated.timing(a, { toValue: 1, duration: 450, easing: Easing.bezier(0.2, 1.5, 0.4, 1), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }).start();
    }
  }, [banner.id, banner.show, a, opacity]);
  if (!banner.id) return null;
  const scale = a.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });
  const rotate = a.interpolate({ inputRange: [0, 0.6, 1], outputRange: ['-6deg', '1deg', '0deg'] });
  const border = banner.kind === 'good' ? C.you : banner.kind === 'bad' ? C.cpu : 'rgba(255,255,255,0.12)';
  return (
    <View pointerEvents="none" style={s.bannerWrap}>
      <Animated.View style={[s.banner, { borderColor: border, shadowColor: border, opacity, transform: [{ scale }, { rotate }] }]}>
        <Text style={s.bannerTitle}>{banner.title}</Text>
        <Text style={s.bannerMsg}>{banner.msg}</Text>
      </Animated.View>
    </View>
  );
}

/** ☰ Menu + mute, top-right of the court (.hud-mini). */
export function HudMini({ game, ui, overlayUp }: { game: Game; ui: UiState; overlayUp: boolean }) {
  return (
    <View style={s.hud} pointerEvents="box-none">
      {!overlayUp && (
        <Tap onPress={() => game.menuButton()} scale={0.92} style={[s.iconBtn, s.menuBtn]} accessibilityLabel="Open the game menu">
          <Text style={s.menuText}>☰ Menu</Text>
        </Tap>
      )}
      <Tap onPress={() => game.toggleMute()} scale={0.92} style={s.iconBtn} accessibilityLabel="Mute">
        <Text style={s.iconText}>{ui.muted ? '🔇' : '🔊'}</Text>
      </Tap>
    </View>
  );
}

const s = StyleSheet.create({
  h2: { color: C.text, fontSize: 26, fontWeight: '800', marginBottom: 6, textAlign: 'center' },
  tagline: { color: C.muted, fontSize: 14, marginTop: 4, marginBottom: 8, textAlign: 'center' },
  final: { color: C.text, fontSize: 40, fontWeight: '800', fontVariant: ['tabular-nums'], textAlign: 'center' },
  playerPill: {
    alignSelf: 'stretch', alignItems: 'center', marginTop: 4, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12,
    backgroundColor: 'rgba(215,242,59,0.08)', borderWidth: 1, borderColor: 'rgba(215,242,59,0.35)',
  },
  playerLabel: { color: C.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.4 },
  playerName: { color: C.accent, fontSize: 18, fontWeight: '900', marginTop: 1 },
  menuList: { gap: 10, marginTop: 14, alignSelf: 'stretch' },
  row: { flexDirection: 'row', gap: 10, justifyContent: 'center', marginTop: 14 },
  bannerWrap: { position: 'absolute', left: 0, right: 0, top: '58%', alignItems: 'center', transform: [{ translateY: -36 }] },
  banner: {
    backgroundColor: 'rgba(10,16,26,0.86)', paddingVertical: 12, paddingHorizontal: 22, borderRadius: 12,
    borderWidth: 2, maxWidth: '88%', alignItems: 'center', shadowOpacity: 0.35, shadowRadius: 24, elevation: 10,
  },
  bannerTitle: { color: C.text, fontSize: 22, fontWeight: '800', textAlign: 'center' },
  bannerMsg: { color: C.muted, fontSize: 14, marginTop: 2, textAlign: 'center' },
  hud: { position: 'absolute', top: 8, right: 8, flexDirection: 'row', gap: 6, zIndex: 20 },
  iconBtn: {
    width: 32, height: 32, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    backgroundColor: 'rgba(10,16,26,0.6)', alignItems: 'center', justifyContent: 'center',
  },
  menuBtn: { width: undefined, paddingHorizontal: 10 },
  menuText: { color: C.text, fontSize: 12, fontWeight: '800', letterSpacing: 0.4 },
  iconText: { fontSize: 14 },
});
