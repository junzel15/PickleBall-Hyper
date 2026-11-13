// The court: a Skia surface redrawn every frame from the engine, plus a touch
// layer that feeds every finger (stick + buttons at the same time) to the engine.
// With 3D players the frame is three layers, all updated in the same tick:
//   court + shadows (Skia)  ->  players + net (WebGPU 3D)  ->  ball, effects, HUD (Skia)
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { SkiaPictureView } from '@shopify/react-native-skia';
import type { SkPicture } from '@shopify/react-native-skia';
import type { Game } from '../game/engine';
import type { Players3D as Players3DType, Render3D } from './Players3D';
import { begin3DAttempt, end3DAttempt } from './players3dGuard';

// Loaded only when 3D is allowed, so a failure while loading it can still fall back to 2D.
function loadPlayers3D(): typeof Players3DType | null {
  try {
    return require('./Players3D').Players3D;
  } catch (e) {
    console.warn('3D players failed to load, using 2D players:', e);
    return null;
  }
}

interface ViewApi {
  setJsiProperty: (nativeId: number, name: string, value: unknown) => void;
  requestRedraw: (nativeId: number) => void;
}

export function GameView({ game }: { game: Game }) {
  const viewRef = useRef<SkiaPictureView>(null);
  const frontRef = useRef<SkiaPictureView>(null);
  const render3D = useRef<Render3D | null>(null);
  // null while deciding; the 3D component once allowed; false = 2D players
  const [Layer3D, setLayer3D] = useState<typeof Players3DType | null | false>(null);
  useEffect(() => {
    let alive = true;
    begin3DAttempt().then(ok => {
      if (!alive) return;
      const C = ok ? loadPlayers3D() : null;
      if (ok && !C) end3DAttempt(false);
      setLayer3D(() => C || false); // a component is a function: wrap it so React stores it instead of calling it
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let raf = 0;
    let lastT = -1;
    const inFlight: SkPicture[] = [];
    const api = (globalThis as unknown as { SkiaViewApi?: ViewApi }).SkiaViewApi;
    const show = (view: SkiaPictureView | null, pic: SkPicture) => {
      if (view && api) {
        api.setJsiProperty(view.nativeId, 'picture', pic);
        api.requestRedraw(view.nativeId);
      }
      // free old frames promptly instead of waiting for GC (the view keeps its own
      // reference to the picture it is showing; a few frames stay in flight)
      inFlight.push(pic);
      if (inFlight.length > 6) inFlight.shift()?.dispose?.();
    };
    // frame-time log (logcat "PERF"): JS time per frame for the game + 2D layers and for the 3D layer
    const perf = { t0: 0, n: 0, game: 0, three: 0, worst: 0, slow: 0 };
    const clock = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = lastT < 0 ? 1 / 60 : Math.min(0.1, (now - lastT) / 1000);
      const gap = lastT < 0 ? 16.7 : now - lastT;
      lastT = now;
      const a = clock();
      show(viewRef.current, game.frame(now));
      const b = clock();
      const r = render3D.current;
      if (r && !game.getUi().customizeOpen) { // the customize screen has its own 3D view
        r(game.scene3D(), dt);
        const front = game.overlay();
        if (front) show(frontRef.current, front);
      }
      const c = clock();
      perf.n++; perf.game += b - a; perf.three += c - b;
      perf.worst = Math.max(perf.worst, gap);
      if (gap > 25) perf.slow++;
      if (!perf.t0) perf.t0 = now;
      if (now - perf.t0 >= 5000) {
        const secs = (now - perf.t0) / 1000;
        if (__DEV__) console.log(`PERF fps=${(perf.n / secs).toFixed(1)} game=${(perf.game / perf.n).toFixed(2)}ms 3d=${(perf.three / perf.n).toFixed(2)}ms slowFrames=${perf.slow} worstGap=${perf.worst.toFixed(0)}ms`);
        Object.assign(perf, { t0: now, n: 0, game: 0, three: 0, worst: 0, slow: 0 });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [game]);

  const on3DReady = useCallback((r: Render3D) => {
    let frames = 0;
    render3D.current = (scene, dt) => {
      r(scene, dt);
      if (++frames === 30) end3DAttempt(true); // drew for a moment without crashing
    };
    game.set3D(true);
  }, [game]);
  const on3DFail = useCallback((err: unknown) => {
    console.warn('3D players unavailable, using 2D players:', err);
    render3D.current = null;
    game.set3D(false);
    end3DAttempt(false);
    setLayer3D(false);
  }, [game]);
  useEffect(() => () => { render3D.current = null; game.set3D(false); }, [game]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    game.resize(width, height);
  };

  const each = (e: GestureResponderEvent, fn: (id: number, x: number, y: number) => void) => {
    for (const t of e.nativeEvent.changedTouches) fn(Number(t.identifier), t.locationX, t.locationY);
  };

  return (
    <View style={StyleSheet.absoluteFill} onLayout={onLayout}>
      <SkiaPictureView ref={viewRef} style={StyleSheet.absoluteFill} opaque />
      {Layer3D && <Layer3D onReady={on3DReady} onFail={on3DFail} />}
      {Layer3D && <SkiaPictureView ref={frontRef} style={StyleSheet.absoluteFill} pointerEvents="none" />}
      <View
        style={StyleSheet.absoluteFill}
        onTouchStart={e => each(e, game.touchStart)}
        onTouchMove={e => each(e, game.touchMove)}
        onTouchEnd={e => each(e, id => game.touchEnd(id))}
        onTouchCancel={e => each(e, id => game.touchEnd(id))}
      />
    </View>
  );
}
