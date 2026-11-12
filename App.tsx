/**
 * Pickleball Hyper — singles & doubles pickleball vs the CPU.
 * Native React Native port of the Pickleball browser game.
 *
 * Landscape lock, immersive full screen and keep-screen-on are set natively in
 * android/app/src/main/java/com/pickleballhyper/MainActivity.kt.
 */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { AccountScreen, CloudScreen, HistoryScreen, LeaderboardScreen, useAccount } from './src/ui/CloudScreens';
import { startCloud } from './src/backend/cloud';
import { WelcomeModal } from './src/ui/WelcomeModal';
import { TutorialModal } from './src/ui/TutorialModal';
import { StartScreen } from './src/ui/StartScreen';
import { C, isShort } from './src/ui/theme';

function Root() {
  const game = useMemo(() => createGame(), []);
  const ui = useSyncExternalStore(game.subscribe, game.getUi);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const short = isShort(height);

  const acc = useAccount();
  const [cloud, setCloud] = useState<CloudScreen | null>(null);
  // email of a player who just registered: shows the welcome modal (name + age)
  const [welcome, setWelcome] = useState<string | null>(null);
  const welcomeRef = useRef(welcome);
  welcomeRef.current = welcome;
  // new-player tutorial: after the name + age step, or from "How to play"
  const [tutorial, setTutorial] = useState(false);
  const tutorialRef = useRef(tutorial);
  tutorialRef.current = tutorial;
  const cloudRef = useRef(cloud);
  cloudRef.current = cloud;
  // Where the player is entering the game:
  //   pending: still loading / checking for a saved login
  //   start:   "Sign In / Create Account" or "Play Offline"
  //   account: sign-in / registration screen opened from the start screen
  //   menu:    main menu (already signed in players go straight here)
  const [entry, setEntry] = useState<'pending' | 'start' | 'account' | 'menu'>('pending');
  const entryRef = useRef(entry);
  entryRef.current = entry;
  useEffect(() => {
    if (entry !== 'pending' || ui.loading || !acc.ready) return;
    setEntry(acc.userId || !acc.configured ? 'menu' : 'start');
  }, [entry, ui.loading, acc.ready, acc.userId, acc.configured]);

  // Load the profile, then start cloud sync (sign-in, profile, match history)
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    game.runLoader(loadProfile).then(() => {
      if (!cancelled) stop = startCloud(game);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [game]);

  // Android back button steps back through the screens; at the main menu it leaves the app
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (welcomeRef.current) return true; // finish the name + age step first
      if (tutorialRef.current) {
        setTutorial(false); // back skips the tutorial
        return true;
      }
      if (entryRef.current === 'account') {
        setEntry('start'); // back to "Sign In / Create Account" or "Play Offline"
        return true;
      }
      if (entryRef.current === 'start' || entryRef.current === 'pending') return false; // leave the app
      if (cloudRef.current) {
        setCloud(null);
        return true;
      }
      return game.goBack();
    });
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

  // Cloud screens are opened from the main menu only
  const inMenu = entry === 'menu';
  const cloudOpen = inMenu && ui.menuOpen && !ui.customizeOpen ? cloud : null;
  const overlayUp = ui.menuOpen || ui.pauseOpen || ui.overOpen || ui.customizeOpen || !!welcome || tutorial || !inMenu;

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
        {entry === 'start' && (
          <StartScreen short={short} onAccount={() => setEntry('account')} onOffline={() => setEntry('menu')} />
        )}
        {entry === 'account' && (
          <AccountScreen
            onBack={() => setEntry('start')}
            onDone={() => setEntry('menu')}
            onRegistered={email => { setEntry('menu'); setWelcome(email); }}
            playerName={ui.profile.name}
          />
        )}
        {inMenu && ui.menuOpen && !cloudOpen && (
          <MainMenu game={game} ui={ui} short={short} signedIn={!!acc.userId} onOpenCloud={setCloud}
            onOpenTutorial={() => setTutorial(true)} />
        )}
        {cloudOpen === 'account' && (
          <AccountScreen
            onBack={() => setCloud(null)}
            onDone={() => setCloud(null)}
            onRegistered={email => { setCloud(null); setWelcome(email); }}
            playerName={ui.profile.name}
          />
        )}
        {cloudOpen === 'history' && <HistoryScreen onBack={() => setCloud(null)} onOpen={setCloud} />}
        {cloudOpen === 'leaderboard' && <LeaderboardScreen onBack={() => setCloud(null)} onOpen={setCloud} />}
        {ui.pauseOpen && <PauseMenu game={game} ui={ui} />}
        {welcome && (
          <WelcomeModal game={game} ui={ui} email={welcome} short={short} onDone={() => { setWelcome(null); setTutorial(true); }} />
        )}
        {tutorial && (
          <TutorialModal
            short={short}
            onClose={() => setTutorial(false)}
            onPractice={() => {
              setTutorial(false);
              game.setSelectedMode('singles');
              game.setDifficulty('easy');
              game.startGame();
            }}
          />
        )}
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
