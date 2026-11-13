/**
 * The 3D players: the real model and animation system, checked numerically (no GPU needed).
 * @format
 */
import * as THREE from 'three/webgpu';
import { Avatar3D, createPlayersWorld, loadPlayerAsset, PlayerAsset } from '../src/game/players3d';
import { Avatar, DEFAULT_AVATAR, OPTIONS, PADDLES } from '../src/game/customize';
import type { Athlete3D, Scene3D } from '../src/game/engine';

jest.mock('@shopify/react-native-skia', () => {
  const fn: unknown = new Proxy(function noop() {}, {
    get: (_t, k) => (k === 'then' ? undefined : fn),
    apply: () => fn,
    construct: () => fn as object,
  });
  // surfaces hand back real pixels so the paddle artwork -> texture path runs
  const Surface = {
    Make: (w: number, h: number) => ({
      getCanvas: () => fn,
      flush: () => {},
      makeImageSnapshot: () => ({ readPixels: () => new Uint8Array(w * h * 4).fill(200) }),
    }),
  };
  const Skia = new Proxy({ Surface }, { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : fn) });
  return {
    __esModule: true, Skia, matchFont: () => fn, ColorType: { RGBA_8888: 4 }, AlphaType: { Unpremul: 3 },
    StrokeCap: {}, StrokeJoin: {}, PaintStyle: {}, ClipOp: {}, TileMode: {}, BlendMode: {}, PointMode: {}, FontWeight: {}, FontSlant: {}, FontWidth: {},
  };
});
// painting needs a real Skia canvas: drawing calls become no-ops, the texture upload path still runs
jest.mock('../src/game/canvas2d', () => {
  const actual = jest.requireActual('../src/game/canvas2d');
  class Ctx2D {
    constructor() {
      return new Proxy(this, { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : () => undefined), set: () => true });
    }
  }
  return { ...actual, Ctx2D };
});
// the paddle artwork needs a real Skia canvas; the texture path itself still runs
jest.mock('../src/game/customize', () => ({ ...jest.requireActual('../src/game/customize'), drawPaddle: () => {} }));
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: { getItem: async () => null, setItem: async () => {} } }));

const FT = 3.28084;
let asset: PlayerAsset;
beforeAll(async () => { asset = await loadPlayerAsset(); }, 60000);

const athlete = (over: Partial<Athlete3D> = {}): Athlete3D => ({
  id: 'p', team: 'player', lefty: false, x: 10, y: 40, vx: 0, vy: 0, lift: 0,
  stroke: null, strokeT: 0, prep: 0, prepKind: 'drive_fh', inRally: true, cheer: false,
  avatar: { ...DEFAULT_AVATAR }, paddle: PADDLES[0].id, serving: false, serverMark: false, contact: null, ...over,
});
const visibleParts = (av: Avatar3D) => av.shownParts.slice().sort();
/** The colours baked into an avatar's merged meshes, as sRGB hex. */
const bakedColors = (av: Avatar3D) => {
  const out = new Set<string>();
  av.root.children.forEach(o => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const c = m.geometry.getAttribute('color');
    const col = new THREE.Color();
    for (let i = 0; i < c.count; i++) out.add('#' + col.setRGB(c.getX(i), c.getY(i), c.getZ(i)).getHexString(THREE.SRGBColorSpace));
  });
  return out;
};
const worldPos = (o: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);

describe('model', () => {
  test('has every clip the game uses', () => {
    for (const n of ['Idle', 'Ready', 'Forehand', 'Backhand', 'Serve', 'Smash', 'Walk', 'Run', 'Sprint', 'Backpedal', 'StrafeLeft', 'StrafeRight', 'RefSit']) {
      expect(asset.clips.get(n)).toBeDefined();
    }
  });

  test('every customisation option shows its own 3D part', () => {
    const av = new Avatar3D(asset);
    const check = (a: Avatar, expected: string[]) => {
      av.dress(a, PADDLES[0].id);
      const vis = visibleParts(av);
      for (const e of expected) expect(vis).toContain(e);
    };
    for (const gender of ['male', 'female']) {
      const g = gender === 'female' ? 'f' : 'm';
      const base: Avatar = { ...DEFAULT_AVATAR, gender, facial: 'none', headwear: 'none' };
      check(base, [`${g}.head`, 'hands', 'shoes']);
      for (const o of OPTIONS.shirtStyle) check({ ...base, shirtStyle: o.v }, [`${g}.torso.${o.v}`]);
      for (const o of OPTIONS.shortsStyle) check({ ...base, shortsStyle: o.v }, [`${g}.legs.${o.v}`]);
      for (const o of OPTIONS.hair) if (o.v !== 'bald') check({ ...base, hair: o.v }, [`${g}.hair.${o.v}`]);
      for (const o of OPTIONS.headwear) if (o.v !== 'none') check({ ...base, headwear: o.v }, [o.v === 'cap_back' ? 'acc.cap' : `acc.${o.v}`]);
      for (const o of OPTIONS.headband) if (o.v !== 'none') check({ ...base, headband: o.v }, [`acc.${o.v}`]);
      for (const o of OPTIONS.eyewear) if (o.v !== 'none') check({ ...base, eyewear: o.v }, [`acc.glasses_${o.v}`]);
      check({ ...base, wristband: 'single' }, ['acc.wrist_R']);
      check({ ...base, wristband: 'pair' }, ['acc.wrist_R', 'acc.wrist_L']);
      check({ ...base, wristband: 'pro' }, ['acc.wristpro_R', 'acc.wristpro_L']);
      // everything at once (mix and match)
      check({ ...base, headwear: 'visor', headband: 'band', eyewear: 'sport', wristband: 'pair', kneeGuard: '#2f6fd6', elbowGuard: '#c0392b', kneeStyle: 'pad', elbowStyle: 'strap' },
        ['acc.visor', 'acc.band', 'acc.glasses_sport', 'acc.wrist_L', `${g}.knee_pad`, `${g}.elbow_strap`]);
      for (const s of ['sleeve', 'pad', 'strap']) {
        const sx = s === 'sleeve' ? '' : '_' + s;
        check({ ...base, kneeGuard: '#2f6fd6', elbowGuard: '#c0392b', kneeStyle: s, elbowStyle: s }, [`${g}.knee${sx}`, `${g}.elbow${sx}`]);
      }
    }
    for (const o of OPTIONS.facial) if (o.v !== 'none') check({ ...DEFAULT_AVATAR, gender: 'male', facial: o.v }, [`m.facial.${o.v}`]);
    // exactly one head, torso, arms and legs at a time
    av.dress({ ...DEFAULT_AVATAR, gender: 'female', shirtStyle: 'tank', hair: 'bald', headwear: 'none' }, null);
    const vis = visibleParts(av);
    expect(vis.filter(n => n.includes('.torso.'))).toEqual(['f.torso.tank']);
    expect(vis.filter(n => n.includes('.arms.'))).toEqual(['f.arms.bare']);
    expect(vis.some(n => n.includes('.hair.'))).toBe(false);
  });

  test('colours follow the avatar settings', () => {
    const av = new Avatar3D(asset);
    av.dress({ ...DEFAULT_AVATAR, shirt: '#d64545', shortsColor: '#b9a27a', hatColor: '#2e8b57', headwear: 'cap' }, null);
    const colors = bakedColors(av);
    expect(colors.has('#d64545')).toBe(true); // shirt
    expect(colors.has('#b9a27a')).toBe(true); // shorts
    expect(colors.has('#2e8b57')).toBe(true); // cap
  });

  test('a character is one skinned mesh (plus hair): one skeleton, few draw calls', () => {
    const av = new Avatar3D(asset);
    av.dress({ ...DEFAULT_AVATAR, hair: 'long', headwear: 'cap', kneeGuard: '#1b1b1d' }, PADDLES[0].id);
    const skinned = av.root.children.filter(o => (o as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh[];
    expect(skinned.length).toBe(2); // body + double-sided hair
    expect(skinned[0].skeleton).toBe(skinned[1].skeleton);
    // the same look again costs nothing: the meshes are kept
    const before = skinned[0].geometry;
    av.dress(av['lastLook'] as never, PADDLES[0].id);
    expect((av.root.children.find(o => (o as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh).geometry).toBe(before);
  });

  test('every paddle builds a 3D paddle in the right hand', () => {
    const av = new Avatar3D(asset);
    for (const p of PADDLES) {
      av.setPaddle(p.id);
      const paddleBone = av.bone('Paddle');
      expect(paddleBone.children.length).toBe(1);
      expect(paddleBone.children[0].userData.paddleId).toBe(p.id);
    }
  });
});

describe('animation', () => {
  const place = (av: Avatar3D, a: Athlete3D) => {
    av.root.position.set(a.x, a.lift, a.y);
    av.root.rotation.set(0, Math.PI, 0);
    av.root.scale.setScalar(FT);
    av.root.updateMatrixWorld(true);
  };

  test('waiting to serve, the ball rests on the open palm', () => {
    const av = new Avatar3D(asset);
    const a = athlete({ serving: true, inRally: false });
    av.dress(a.avatar, a.paddle);
    place(av, a);
    // the engine's held-ball spot: 0.74 ft to the free-hand side (your team faces -y, so that is -x), 3.2 ft up, 0.7 ft toward the net
    const ball = new THREE.Vector3(a.x - 0.74, 3.2, a.y - 0.7);
    for (let i = 0; i < 20; i++) {
      av.animatePlayer(a, { x: 0, z: 0 }, 1 / 60);
      av.beginIK();
      av.holdBall(av.toLocal(ball), 1 / 60, true);
    }
    av.root.updateMatrixWorld(true);
    const hand = worldPos(av.bone('LeftHand'));
    const gap = hand.distanceTo(ball) / FT; // metres from the wrist to the ball centre
    expect(gap).toBeLessThan(0.13);
    expect(gap).toBeGreaterThan(0.04);
    expect(hand.y).toBeLessThan(ball.y); // the hand is under the ball, holding it up
  });

  test('the serve stance already holds the ball out: no reaching or twisting', () => {
    const av = new Avatar3D(asset);
    const a = athlete({ serving: true, inRally: false });
    av.dress(a.avatar, a.paddle);
    place(av, a);
    const ball = new THREE.Vector3(a.x - 0.74, 3.2, a.y - 0.7); // where the game keeps the waiting ball
    for (let i = 0; i < 60; i++) av.animatePlayer(a, { x: 0, z: 0 }, 1 / 60);
    av.root.updateMatrixWorld(true);
    const before = worldPos(av.bone('LeftHand'));
    av.beginIK();
    for (let i = 0; i < 30; i++) av.holdBall(av.toLocal(ball), 1 / 60, true);
    av.root.updateMatrixWorld(true);
    const after = worldPos(av.bone('LeftHand'));
    expect(before.distanceTo(after) / FT).toBeLessThan(0.05); // the IK only fine-tunes (< 5 cm)
  });

  test('the paddle face meets the ball at contact', () => {
    const av = new Avatar3D(asset);
    // your team faces -y, so the right-handed forehand side is +x
    const contact = { x: 10 + 2.2, y: 40 - 1.2, z: 2.6 };
    const a = athlete({ stroke: 'drive_fh', strokeT: 0.45, contact });
    av.dress(a.avatar, a.paddle);
    place(av, a);
    const faceDist = (ik: boolean) => {
      for (let i = 0; i < 3; i++) av.animatePlayer(a, { x: 0, z: 0 }, 1 / 60);
      av.beginIK();
      if (ik) av.reachContact(av.toLocal(new THREE.Vector3(contact.x, contact.z, contact.y)), a.strokeT);
      av.root.updateMatrixWorld(true);
      const face = new THREE.Vector3(0, 0, 0.21).applyMatrix4(av.bone('Paddle').matrixWorld);
      return face.distanceTo(new THREE.Vector3(contact.x, contact.z, contact.y)) / FT;
    };
    const before = faceDist(false);
    const after = faceDist(true);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(0.15);
  });

  /** Moves the root at `speed` (m/s) along the model's own direction and measures how fast a planted foot slides. */
  const footSkate = (clip: 'Run' | 'StrafeLeft' | 'StrafeRight' | 'Backpedal', speed: number) => {
    const av = new Avatar3D(asset);
    const a = athlete();
    av.dress(a.avatar, null);
    av.root.scale.setScalar(FT);
    const dir = clip === 'Run' ? new THREE.Vector3(0, 0, 1) : clip === 'Backpedal' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(clip === 'StrafeLeft' ? 1 : -1, 0, 0);
    const dt = 1 / 120;
    let worst = 0;
    let prev: THREE.Vector3[] | null = null;
    const pos = new THREE.Vector3();
    for (let i = 0; i < 240; i++) {
      pos.addScaledVector(dir, speed * dt * FT);
      av.root.position.copy(pos);
      av.animatePlayer(a, { x: dir.x * speed, z: dir.z * speed }, dt);
      av.root.updateMatrixWorld(true);
      const feet = ['LeftToeBase', 'RightToeBase'].map(n => worldPos(av.bone(n)));
      if (prev && i > 120) { // after the blend has settled
        feet.forEach((f, k) => {
          const was = (prev as THREE.Vector3[])[k];
          // planted = the ball of the foot on the floor in both frames (rest height 0.022 m)
          if (f.y / FT < 0.0235 && was.y / FT < 0.0235) worst = Math.max(worst, f.distanceTo(was) / FT / dt);
        });
      }
      prev = feet;
    }
    return worst; // m/s a planted foot slides
  };
  test.each([['Run', 3.2], ['StrafeLeft', 2.5], ['StrafeRight', 2.5], ['Backpedal', 2.2]] as const)('%s keeps planted feet planted', (clip, speed) => {
    expect(footSkate(clip, speed)).toBeLessThan(0.6); // vs 2-3 m/s of body speed
  });

  test('moving sideways plays the side shuffle, not the forward run', () => {
    const av = new Avatar3D(asset);
    const a = athlete();
    av.dress(a.avatar, null);
    for (let i = 0; i < 60; i++) av.animatePlayer(a, { x: 3, z: 0 }, 1 / 60);
    const act = (av as unknown as { act: Map<string, THREE.AnimationAction> }).act;
    const w = (n: string) => (act.get(n) as THREE.AnimationAction).getEffectiveWeight();
    expect(w('StrafeLeft')).toBeGreaterThan(0.8);
    expect(w('Run') + w('Walk') + w('Sprint')).toBeLessThan(0.05);
  });
});

describe('the 3D court world', () => {
  test('builds the hall, players, umpires, ball and floor marks from a game scene', async () => {
    const world = await createPlayersWorld();
    const scene: Scene3D = {
      w: 915, h: 412, cam: { x: 10, y: 76, h: 26, f: 640, cx: 457, hor: 120 }, paused: false, clock: 1.2,
      hall: { left: -30, right: 50, back: -16, ceil: 35, pad: 7, near: 73, lights: [{ x: 1, y: 2 }, { x: 19, y: 26 }], dividers: [-12, 32], benches: [{ x: -9.8, y: 13, facing: 1 }, { x: 29.8, y: 33, facing: -1 }] },
      decals: [
        { k: 'disc', soft: true, x: 10, y: 40, rx: 1, ry: 0.7, c: '#000000', a: 0.4 },
        { k: 'ring', x: 10, y: 40, rx: 1.35, ry: 1.35, w: 0.09, c: '#ffffff', a: 0.7 },
        { k: 'dash', x: 8, y: 30, rx: 0.7, ry: 0.7, w: 0.09, c: '#ffffff', a: 0.55, rot: 0.3 },
        { k: 'quad', x: 0, y: 22, x1: 20, y1: 29, rx: 0, ry: 0, c: '#ff5050', a: 0.15 },
      ],
      ball: { x: 10.7, y: 39.3, z: 3.2, spin: 0, squash: 0, visible: true, holder: 'p' },
      refs: [{ x: -5.3, y: 22, face: 0, pose: 'out', look: 0, target: { x: 3, y: 10 } }, { x: 25.3, y: 22, face: Math.PI, pose: 'idle', look: Math.PI, target: null }],
      athletes: [athlete({ serving: true, serverMark: true, inRally: false }), athlete({ id: 'ai', team: 'ai', y: 4, vx: 8, avatar: { ...DEFAULT_AVATAR, gender: 'female', hair: 'long' } })],
    };
    for (let i = 0; i < 30; i++) world.update(scene, 1 / 60);
    // draw calls: every visible mesh or line set is one; the whole court must stay within budget
    let draws = 0, textured = 0;
    world.scene.traverseVisible(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh && !(o as THREE.LineSegments).isLineSegments) return;
      const mats = Array.isArray(m.material) ? m.material.length : 1;
      draws += mats;
      if (!Array.isArray(m.material) && (m.material as THREE.MeshStandardMaterial).map) textured++;
    });
    expect(draws).toBeLessThan(50);        // was ~300 before batching
    expect(textured).toBeGreaterThan(3);   // court, wood, wall, paddle faces
    // waiting to serve: the ball rests on the server's palm and the arrow floats over their head
    const ballMesh = world.scene.children.find(o => (o as THREE.Mesh).geometry instanceof THREE.IcosahedronGeometry) as THREE.Mesh;
    expect(ballMesh.visible).toBe(true);
    const arrowGroup = world.scene.children.find(o => o.type === 'Group' && o.children.some(c => (c as THREE.Mesh).geometry instanceof THREE.ConeGeometry)) as THREE.Object3D;
    expect(arrowGroup.visible).toBe(true);
    expect(arrowGroup.position.x).toBeCloseTo(10);
    expect(arrowGroup.position.y).toBeGreaterThan(7);    // above the name tag (6.35 ft)
    // the ball is a touch over 1.6x a real one (radius 0.12 ft): clear on a phone, still in proportion
    const r = (ballMesh.geometry as THREE.IcosahedronGeometry).parameters.radius;
    expect(r).toBeGreaterThan(0.18);
    expect(r).toBeLessThan(0.23);
    // once the rally is on, the arrow goes
    world.update({ ...scene, ball: { ...scene.ball, holder: null }, athletes: scene.athletes.map(a => ({ ...a, serving: false, serverMark: false })) }, 1 / 60);
    expect(arrowGroup.visible).toBe(false);
    expect(ballMesh.visible).toBe(true);
    // a changed roof height rebuilds the hall instead of stacking a second one
    const count = () => { let n = 0; world.scene.traverse(() => { n++; }); return n; };
    const before = count();
    world.update({ ...scene, hall: { ...scene.hall, ceil: 30 } }, 1 / 60);
    expect(Math.abs(count() - before)).toBeLessThan(5);
    world.dispose();
  }, 60000);
});
