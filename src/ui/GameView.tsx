// The court: a Skia surface redrawn every frame from the engine, plus a touch
// layer that feeds every finger (stick + buttons at the same time) to the engine.
import React, { useEffect, useRef } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { SkiaPictureView } from '@shopify/react-native-skia';
import type { SkPicture } from '@shopify/react-native-skia';
import type { Game } from '../game/engine';

interface ViewApi {
  setJsiProperty: (nativeId: number, name: string, value: unknown) => void;
  requestRedraw: (nativeId: number) => void;
}

export function GameView({ game }: { game: Game }) {
  const viewRef = useRef<SkiaPictureView>(null);

  useEffect(() => {
    let raf = 0;
    const inFlight: SkPicture[] = [];
    const api = (globalThis as unknown as { SkiaViewApi?: ViewApi }).SkiaViewApi;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const pic = game.frame(now);
      const view = viewRef.current;
      if (view && api) {
        api.setJsiProperty(view.nativeId, 'picture', pic);
        api.requestRedraw(view.nativeId);
      }
      // free old frames promptly instead of waiting for GC (the view keeps its own
      // reference to the picture it is showing; two frames stay in flight)
      inFlight.push(pic);
      if (inFlight.length > 3) inFlight.shift()?.dispose?.();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [game]);

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
