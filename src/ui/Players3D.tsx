// The 3D court layer: a transparent WebGPU canvas (three.js) drawn between the court
// and the ball/HUD. GameView drives it from its frame loop through `onReady(render)`.
// If WebGPU or the model is unavailable it reports `onFail` and the game keeps its 2D players.
import React, { useEffect, useRef } from 'react';
import { PixelRatio, StyleSheet } from 'react-native';
import { Canvas } from 'react-native-webgpu';
import type { CanvasRef } from 'react-native-webgpu';
import * as THREE from 'three/webgpu';
import type { Scene3D } from '../game/engine';
import { createPlayersWorld } from '../game/players3d';
import { getGpuDevice } from './gpu';

export type Render3D = (scene: Scene3D, dt: number) => void;

interface Props {
  onReady: (render: Render3D) => void;
  onFail: (err: unknown) => void;
}

// Render below the screen's full density: players are a small part of the picture and this
// keeps the GPU cost low on phones (the court itself stays sharp, it is drawn by Skia).
const MAX_PIXEL_RATIO = 1.5;

export function Players3D({ onReady, onFail }: Props) {
  const ref = useRef<CanvasRef>(null);
  const cb = useRef({ onReady, onFail });
  cb.current = { onReady, onFail };

  useEffect(() => {
    let alive = true;
    let renderer: THREE.WebGPURenderer | null = null;
    let world: Awaited<ReturnType<typeof createPlayersWorld>> | null = null;
    let failed = false;
    const fail = (e: unknown) => {
      if (failed) return;
      failed = true;
      cb.current.onFail(e);
    };

    (async () => {
      const device = await getGpuDevice();
      const context = ref.current?.getContext('webgpu');
      if (!context || !alive) throw new Error('No WebGPU canvas');
      const r = new THREE.WebGPURenderer({
        antialias: true,
        alpha: true,
        canvas: context.canvas as unknown as HTMLCanvasElement,
        context: context as unknown as GPUCanvasContext,
        device,
      });
      renderer = r;
      r.setClearColor(0x000000, 0);
      r.setPixelRatio(Math.min(MAX_PIXEL_RATIO, PixelRatio.get()));
      await r.init();
      world = await createPlayersWorld();
      if (!alive) return;
      let size = '';
      const w = world;
      cb.current.onReady((scene, dt) => {
        if (failed || !alive) return;
        try {
          const key = `${scene.w}x${scene.h}`;
          if (key !== size) { r.setSize(scene.w, scene.h, false); size = key; }
          w.update(scene, dt);
          r.render(w.scene, w.camera);
          context.present();
        } catch (e) {
          fail(e);
        }
      });
    })().catch(fail);

    return () => {
      alive = false;
      try {
        world?.dispose();
        if (renderer) { renderer.setAnimationLoop(null); renderer.dispose(); }
      } catch {
        // tearing down: nothing else to do
      }
    };
  }, []);

  return <Canvas ref={ref} style={StyleSheet.absoluteFill} pointerEvents="none" />;
}
