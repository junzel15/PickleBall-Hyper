// Customize screen: the real 3D player, live. Drag to turn it, pinch (or double-tap) to zoom
// in on the face; every option the player picks is applied to the model straight away.
// Shows `fallback` (the 2D preview) while loading, and keeps it if 3D can't run here.
import React, { useEffect, useRef, useState } from 'react';
import { GestureResponderEvent, PixelRatio, StyleSheet, View } from 'react-native';
import { Canvas } from 'react-native-webgpu';
import type { CanvasRef } from 'react-native-webgpu';
import * as THREE from 'three/webgpu';
import type { Avatar } from '../game/customize';
import { createShowcaseWorld } from '../game/players3d';
import { getGpuDevice } from './gpu';

interface Props {
  width: number;
  height: number;
  avatar: Avatar;
  paddle: string;
  fallback: React.ReactNode;
}

export function AvatarStage3D({ width, height, avatar, paddle, fallback }: Props) {
  const ref = useRef<CanvasRef>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const look = useRef({ avatar, paddle, dirty: true });
  look.current = { avatar, paddle, dirty: true };
  const view = useRef({ spin: 0.45, spinV: 0, zoom: 0, zoomT: 0, dragging: false, lastX: 0, pinch: 0, lastTap: 0 });

  useEffect(() => {
    if (failed) return;
    let alive = true, raf = 0;
    let renderer: THREE.WebGPURenderer | null = null;
    (async () => {
      const device = await getGpuDevice();
      const context = ref.current?.getContext('webgpu');
      if (!context || !alive) throw new Error('No WebGPU canvas');
      const r = new THREE.WebGPURenderer({
        antialias: true, alpha: true, device,
        canvas: context.canvas as unknown as HTMLCanvasElement,
        context: context as unknown as GPUCanvasContext,
      });
      renderer = r;
      r.setClearColor(0x000000, 0);
      r.setPixelRatio(Math.min(2, PixelRatio.get()));
      r.setSize(width, height, false);
      await r.init();
      const world = await createShowcaseWorld();
      if (!alive) return;
      let last = -1;
      const tick = (now: number) => {
        if (!alive) return;
        raf = requestAnimationFrame(tick);
        const dt = last < 0 ? 1 / 60 : Math.min(0.1, (now - last) / 1000);
        last = now;
        const L = look.current;
        if (L.dirty) { world.setLook(L.avatar, L.paddle); L.dirty = false; }
        const v = view.current;
        if (!v.dragging) { // a flick keeps turning, then it drifts slowly
          v.spin += v.spinV * dt;
          v.spinV *= Math.exp(-dt * 3);
          if (Math.abs(v.spinV) < 0.05) v.spin += dt * 0.25;
        }
        v.zoom += (v.zoomT - v.zoom) * (1 - Math.exp(-dt * 8));
        try {
          world.update(dt, v.spin, v.zoom, width / height);
          r.render(world.scene, world.camera);
          context.present();
        } catch (e) {
          alive = false;
          setFailed(true);
          console.warn('3D preview failed, using the 2D preview:', e);
        }
      };
      raf = requestAnimationFrame(tick);
      setReady(true);
    })().catch(e => {
      if (!alive) return;
      console.warn('3D preview unavailable, using the 2D preview:', e);
      setFailed(true);
    });
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      try { if (renderer) renderer.dispose(); } catch { /* tearing down */ }
    };
  }, [width, height, failed]);

  // ---- gestures: one finger turns the player, two fingers zoom, double-tap toggles a close-up
  const touches = (e: GestureResponderEvent) => e.nativeEvent.touches;
  const onStart = (e: GestureResponderEvent) => {
    const v = view.current;
    const t = touches(e);
    if (t.length >= 2) { v.pinch = Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY); return; }
    const now = Date.now();
    if (now - v.lastTap < 280) v.zoomT = v.zoomT > 0.5 ? 0 : 1;
    v.lastTap = now;
    v.dragging = true;
    v.lastX = t[0].pageX;
    v.spinV = 0;
  };
  const onMove = (e: GestureResponderEvent) => {
    const v = view.current;
    const t = touches(e);
    if (t.length >= 2) {
      const d = Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
      if (v.pinch > 0) v.zoomT = Math.min(1, Math.max(0, v.zoomT + (d - v.pinch) / 220));
      v.pinch = d;
      v.dragging = false;
      return;
    }
    if (!v.dragging) { v.dragging = true; v.lastX = t[0].pageX; return; }
    const dx = t[0].pageX - v.lastX;
    v.lastX = t[0].pageX;
    v.spin += dx * 0.012;
    v.spinV = dx * 0.012 * 60;
  };
  const onEnd = () => { view.current.dragging = false; view.current.pinch = 0; };

  return (
    <View style={{ width, height }}>
      {(!ready || failed) && <View style={StyleSheet.absoluteFill}>{fallback}</View>}
      {!failed && (
        <View
          style={[StyleSheet.absoluteFill, { opacity: ready ? 1 : 0 }]}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={onStart}
          onResponderMove={onMove}
          onResponderRelease={onEnd}
          onResponderTerminate={onEnd}
          accessibilityLabel="3D player preview. Drag to rotate, pinch or double-tap to zoom."
        >
          <Canvas ref={ref} style={StyleSheet.absoluteFill} pointerEvents="none" />
        </View>
      )}
    </View>
  );
}
