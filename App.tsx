/**
 * Pickleball Hyper — singles & doubles pickleball vs the CPU.
 * Native React Native port of the Pickleball browser game.
 *
 * Landscape lock, immersive full screen and keep-screen-on are set natively in
 * android/app/src/main/java/com/pickleballhyper/MainActivity.kt.
 */
import React, { useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState, BackHandler, StatusBar, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { createGame } from './src/game/engine';
import { loadProfile } from './src/game/customize';
import { suspendAudio } from './src/game/audio';
import { hushSpeech } from './src/game/speech';
import { GameView } from './src/ui/GameView';
import { MainMenu } from './src/ui/MainMenu';
import { Banner, GameOver, HudMini, PauseMenu } from './src/ui/GameScreens';
import { CustomizeScreen } from './src/ui/CustomizeScreen';
import { Loader } from './src/ui/Loader';
import { C, isShort } from './src/ui/theme';

function Root() {
  const game = useMemo(() => createGame(), []);
  const ui = useSyncExternalStore(game.subscribe, game.getUi);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const short = isShort(height);

  useEffect(() => {
    game.runLoader(loadProfile);
  }, [game]);

  // Android back button steps back through the screens; at the main menu it leaves the app
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => game.goBack());
    return () => sub.remove();
  }, [game]);

  // Going to the background pauses the match and silences sound and voice
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      const hidden = s !== 'active';
      if (hidden) {
        game.autoPause();
        hushSpeech();
      }
      suspendAudio(hidden);
    });
    return () => sub.remove();
  }, [game]);

  const overlayUp = ui.menuOpen || ui.pauseOpen || ui.overOpen || ui.customizeOpen;

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right },
      ]}>
      <StatusBar hidden />
      <View style={styles.stage}>
        <GameView game={game} />
        <Banner banner={ui.banner} />
        {ui.menuOpen && <MainMenu game={game} ui={ui} short={short} />}
        {ui.pauseOpen && <PauseMenu game={game} />}
        {ui.overOpen && <GameOver game={game} ui={ui} />}
        {ui.customizeOpen && <CustomizeScreen game={game} ui={ui} short={short} />}
        <HudMini game={game} ui={ui} overlayUp={overlayUp} />
      </View>
      {ui.loading && <Loader loader={ui.loader} />}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bgDeep },
  stage: { flex: 1, overflow: 'hidden' },
});
