// The 3D layer: modular player avatars, umpires, net, ball and paddles drawn with three.js on
// WebGPU, between the court (Skia, behind) and the HUD (Skia, in front).
// Court units are feet like the engine: x across, y along the court, z up. In three.js that is
// X = x, Y = z (up), Z = y, and the camera reproduces the engine's proj() exactly.
// The avatar model (tools/avatar) is in metres, facing +Z with its left at +X.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { AlphaType, ColorType, Skia } from '@shopify/react-native-skia';
import type { Athlete3D, Ball3D, Ref3D, Scene3D } from './engine';
import { Ctx2D } from './canvas2d';
import { Avatar, drawPaddle, paddleById, SHAPES, SHOES } from './customize';
import { PLAYER_GLB_BASE64 } from './player3dModel';
import { bakeStatic, buildHall, Decals } from './hall3d';

const FT = 3.28084;          // metres -> feet
const COURT_W = 20;
const NET_Y = 22;
const POST_H = 3.0;
const CENTER_H = 34 / 12;
const BALL_R = 0.2;          // ft: a real ball is 0.12; this reads clearly on a phone and stays in proportion
const PADDLE_UNIT = 0.25;    // metres per unit of the paddle artwork (standard face 25 x 20 cm)

// ================================================================ the model
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64ToBuffer(b64: string): ArrayBuffer {
  const lut = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) lut[B64.charCodeAt(i)] = i;
  let n = b64.length;
  while (n > 0 && b64.charCodeAt(n - 1) === 61) n--;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    const a = lut[b64.charCodeAt(i)], b = lut[b64.charCodeAt(i + 1)];
    const c = i + 2 < n ? lut[b64.charCodeAt(i + 2)] : 0, d = i + 3 < n ? lut[b64.charCodeAt(i + 3)] : 0;
    const v = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (v >> 16) & 255;
    if (i + 2 < n) out[o++] = (v >> 8) & 255;
    if (i + 3 < n) out[o++] = v & 255;
  }
  return out.buffer;
}

const UPPER = new Set(['Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'Paddle',
  ...['Left', 'Right'].flatMap(s => ['Shoulder', 'Arm', 'ForeArm', 'ForeArmTwist', 'Hand'].map(b => s + b))]);
const boneOf = (track: THREE.KeyframeTrack) => track.name.split('.')[0];

/** One primitive of a model part: shared geometry, its material name and default colour. */
export interface PartPrim { geo: THREE.BufferGeometry; mat: string; base: THREE.Color; hair: boolean; dq: THREE.Matrix4 }
export interface PlayerAsset {
  gltf: GLTF;
  clips: Map<string, THREE.AnimationClip>;      // full body
  upper: Map<string, THREE.AnimationClip>;      // spine, arms, head only
  lower: Map<string, THREE.AnimationClip>;      // hips and legs only
  parts: Map<string, PartPrim[]>;               // every wardrobe/body part, by name
  boneRoot: THREE.Object3D;                     // the skeleton (cloned per avatar)
  boneNames: string[];                          // skin joint order
  boneInverses: THREE.Matrix4[];
}
let assetPromise: Promise<PlayerAsset> | null = null;
/** Parses the embedded GLB once; every 3D view shares it. */
export function loadPlayerAsset(): Promise<PlayerAsset> {
  if (!assetPromise) {
    assetPromise = new Promise<GLTF>((resolve, reject) => {
      new GLTFLoader().parse(base64ToBuffer(PLAYER_GLB_BASE64), '', resolve, reject);
    }).then(gltf => {
      const clips = new Map(gltf.animations.map(c => [c.name, c]));
      const sub = (keep: (b: string) => boolean, suffix: string) => new Map(gltf.animations.map(c => [c.name,
        new THREE.AnimationClip(c.name + suffix, c.duration, c.tracks.filter(t => keep(boneOf(t))))]));
      // part sources: geometry stays shared; avatars merge the parts they show into one mesh
      const parts = new Map<string, PartPrim[]>();
      let skel: THREE.Skeleton | null = null;
      let boneRoot: THREE.Object3D | null = null;
      for (const child of gltf.scene.children) {
        if ((child as THREE.Bone).isBone) { boneRoot = child; continue; }
        const prims: PartPrim[] = [];
        child.traverse(o => {
          const m = o as THREE.SkinnedMesh;
          if (!m.isMesh) return;
          if (m.isSkinnedMesh && !skel) skel = m.skeleton;
          const mat = m.material as THREE.MeshStandardMaterial;
          // quantized positions: the part's skin folds the dequantization into its inverse bind
          // matrices; joint 0 (Root) has identity bind, so its matrix is exactly that transform
          const dq = m.isSkinnedMesh ? m.skeleton.boneInverses[0].clone() : new THREE.Matrix4();
          prims.push({ geo: m.geometry, mat: mat.name, base: mat.color.clone(), hair: mat.side === THREE.DoubleSide, dq });
        });
        // GLTFLoader strips dots from node names; the original name is kept in userData
        parts.set((child.userData && child.userData.name) || child.name, prims);
      }
      if (!skel || !boneRoot) throw new Error('3D player: no skeleton');
      const sk = skel as THREE.Skeleton;
      return {
        gltf, clips, upper: sub(b => UPPER.has(b), '_upper'), lower: sub(b => !UPPER.has(b), '_lower'),
        // the real bind pose (without any part's quantization): inverse of each bone's rest transform
        parts, boneRoot: boneRoot as THREE.Object3D, boneNames: sk.bones.map(b => b.name),
        boneInverses: (() => { (boneRoot as THREE.Object3D).updateMatrixWorld(true); return sk.bones.map(b => (gltf.scene.getObjectByName(b.name) as THREE.Object3D).matrixWorld.clone().invert()); })(),
      };
    });
    assetPromise.catch(() => { assetPromise = null; });
  }
  return assetPromise;
}

// ================================================================ paddles (true shape + printed design)
const paddleCache = new Map<string, { geo: THREE.BufferGeometry; tex: THREE.Texture; grip: string; edge: string }>();
function paddleParts(id: string) {
  const hit = paddleCache.get(id);
  if (hit) return hit;
  const p = paddleById(id);
  const sh = SHAPES[p.shape] || SHAPES.standard;
  const { L, W, r } = sh;
  // the face outline, the same path the artwork is clipped to
  const shape = new THREE.Shape();
  const x0 = -L / 2, x1 = L / 2, y0 = -W / 2, y1 = W / 2, rb = r * 0.7;
  shape.moveTo(x0 + rb, y0);
  shape.lineTo(x1 - r, y0);
  shape.quadraticCurveTo(x1, y0, x1, y0 + r);
  shape.lineTo(x1, y1 - r);
  shape.quadraticCurveTo(x1, y1, x1 - r, y1);
  shape.lineTo(x0 + rb, y1);
  shape.quadraticCurveTo(x0, y1, x0, y1 - rb);
  shape.lineTo(x0, y0 + rb);
  shape.quadraticCurveTo(x0, y0, x0 + rb, y0);
  const T = 0.013 / PADDLE_UNIT;
  const geo = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: true, bevelThickness: 0.002 / PADDLE_UNIT, bevelSize: 0.003 / PADDLE_UNIT, bevelSegments: 2, curveSegments: 10 });
  // UVs: map the artwork's box onto the face (both sides)
  const pad = 0.03, bx0 = x0 - pad, by0 = y0 - pad, bw = L + 2 * pad, bh = W + 2 * pad;
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) { uv[i * 2] = (pos.getX(i) - bx0) / bw; uv[i * 2 + 1] = (pos.getY(i) - by0) / bh; }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  // artwork x (long axis) -> paddle +Z, artwork y -> X, thickness -> Y; face centred 0.075 m past the grip
  geo.translate(0, 0, -T / 2);
  geo.scale(PADDLE_UNIT, PADDLE_UNIT, PADDLE_UNIT);
  const m = new THREE.Matrix4().set( // [X Y Z] = [artwork y, thickness, artwork x] (a rotation, det +1)
    0, 1, 0, 0,
    0, 0, 1, 0,
    1, 0, 0, 0,
    0, 0, 0, 1);
  geo.applyMatrix4(m);
  geo.translate(0, 0, 0.075 + (L * PADDLE_UNIT) / 2);
  geo.computeVertexNormals();
  const tex = paddleTexture(p, sh, bx0, by0, bw, bh);
  const out = { geo, tex, grip: p.grip, edge: p.edge };
  paddleCache.set(id, out);
  return out;
}
function paddleTexture(p: ReturnType<typeof paddleById>, sh: { L: number; W: number }, bx0: number, by0: number, bw: number, bh: number): THREE.Texture {
  const S = 360; // pixels per artwork unit
  const w = Math.round(bw * S), h = Math.round(bh * S);
  const surface = Skia.Surface.Make(w, h);
  if (!surface) throw new Error('paddle texture: no surface');
  const canvas = surface.getCanvas();
  const ctx = new Ctx2D(canvas);
  ctx.translate(-bx0 * S, -by0 * S);
  drawPaddle(ctx, p, S, true);
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: w, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
  if (!px) throw new Error('paddle texture: readPixels failed');
  const tex = new THREE.DataTexture(new Uint8Array(px.buffer, px.byteOffset, px.byteLength), w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
function buildPaddle(id: string): THREE.Group {
  const { geo, tex, grip, edge } = paddleParts(id);
  const g = new THREE.Group();
  const faceMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.38, metalness: 0.05 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: edge, roughness: 0.5 });
  g.add(new THREE.Mesh(geo, [faceMat, edgeMat]));
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.0165, 0.0155, 0.135, 12), new THREE.MeshStandardMaterial({ color: grip, roughness: 0.95 }));
  handle.rotation.x = Math.PI / 2;
  handle.position.z = 0.0125;
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.008, 12), new THREE.MeshStandardMaterial({ color: '#111111', roughness: 0.6 }));
  butt.rotation.x = Math.PI / 2;
  butt.position.z = -0.058;
  g.add(handle, butt);
  g.userData.paddleId = id;
  return g;
}

// ================================================================ avatars (modular parts)
const ARMS: Record<string, string> = { tank: 'bare', sleeveless: 'bare', raglan: 'raglan', polo: 'polo', pro: 'polo' };
function partsFor(a: Avatar): string[] {
  const g = a.gender === 'female' ? 'f' : 'm';
  const p = [`${g}.head`, 'hands', 'shoes', `${g}.torso.${a.shirtStyle}`, `${g}.arms.${ARMS[a.shirtStyle] || 'sleeve'}`, `${g}.legs.${a.shortsStyle}`];
  if (a.hair !== 'bald') p.push(`${g}.hair.${a.hair}`);
  if (a.headwear && a.headwear !== 'none') p.push(a.headwear === 'cap_back' ? 'acc.cap' : `acc.${a.headwear}`);
  if (a.headband && a.headband !== 'none') p.push(`acc.${a.headband}`);
  if (a.eyewear && a.eyewear !== 'none') p.push(`acc.glasses_${a.eyewear}`);
  if (a.wristband === 'single') p.push('acc.wrist_R');
  else if (a.wristband === 'pair') p.push('acc.wrist_R', 'acc.wrist_L');
  else if (a.wristband === 'pro') p.push('acc.wristpro_R', 'acc.wristpro_L');
  if (g === 'm' && a.facial !== 'none') p.push(`m.facial.${a.facial}`);
  const sfx = (s: string) => (!s || s === 'sleeve' ? '' : '_' + s);
  if (a.kneeGuard !== 'none') p.push(`${g}.knee${sfx(a.kneeStyle)}`);
  if (a.elbowGuard !== 'none') p.push(`${g}.elbow${sfx(a.elbowStyle)}`);
  return p;
}
const mixHex = (a: string, b: string, t: number) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString();
function colorsFor(a: Avatar): Record<string, string> {
  const shoe = SHOES[a.shoes] || SHOES.white;
  return {
    skin: a.skin, lips: mixHex(a.skin, a.gender === 'female' ? '#b23a48' : '#9e5552', a.gender === 'female' ? 0.5 : 0.42),
    brow: a.hairColor, hair: a.hairColor, stubble: mixHex(a.skin, a.hairColor, 0.55), iris: a.eyes,
    shirt: a.shirt, shirtAccent: a.shirtAccent, shorts: a.shortsColor, pants: a.shortsColor,
    shoe: shoe.upper, sole: shoe.sole, shoeAccent: shoe.accent, hat: a.hatColor, hatTrim: mixHex(a.hatColor, '#ffffff', 0.6),
    band: a.bandColor || '#f2f2f0',
    kneeGuard: a.kneeGuard === 'none' ? '#1b1b1d' : a.kneeGuard, elbowGuard: a.elbowGuard === 'none' ? '#1b1b1d' : a.elbowGuard,
  };
}
/** Head accessories are built for the male head with short hair: fit them to this look. */
const HEAD_C = new THREE.Vector3(0, 1.665, -0.005);
const BIG_HAIR = new Set(['curly', 'bun', 'long']);
function aboutPoint(c: THREE.Vector3, m: THREE.Matrix4) {
  return new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(m).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
}
function accessoryXf(look: Avatar): PartXf | undefined {
  const fem = look.gender === 'female';
  const big = BIG_HAIR.has(look.hair);
  const cache = new Map<string, THREE.Matrix4 | null>();
  return (part: string) => {
    if (cache.has(part)) return cache.get(part)!;
    let m: THREE.Matrix4 | null = null;
    if (part.startsWith('acc.')) {
      const k = part.slice(4);
      if (k.startsWith('wrist')) {
        if (fem) m = aboutPoint(new THREE.Vector3(0, 1.44, -0.02), new THREE.Matrix4().makeScale(1, 0.9, 0.9));
      } else {
        const hat = k.startsWith('cap') || k.startsWith('visor');
        const band = k.startsWith('band');
        const hs = big ? (hat ? 1.06 : band ? 1.08 : 1) : 1;
        const s = new THREE.Matrix4().makeScale((fem ? 0.955 : 1) * hs, hs, (fem ? 0.985 : 1) * hs);
        if (k === 'cap' && look.headwear === 'cap_back' && hat) s.premultiply(new THREE.Matrix4().makeRotationY(Math.PI));
        const isId = s.equals(new THREE.Matrix4());
        m = isId ? null : aboutPoint(HEAD_C, s);
      }
    }
    cache.set(part, m);
    return m;
  };
}
export const REF_LOOK_PARTS = ['m.head', 'hands', 'shoes', 'ref.torso', 'ref.arms', 'ref.legs', 'acc.cap'];

const BASE_CLIPS = ['Idle', 'Ready', 'ServeWait'] as const;
const GAIT_CLIPS = ['Walk', 'Run', 'Sprint', 'Backpedal', 'StrafeLeft', 'StrafeRight'] as const;
const STROKE_CLIPS = ['Forehand', 'Backhand', 'Serve', 'Smash'] as const;
const STROKE_TIME: Record<string, { contact: number; end: number; back: number }> = {
  Forehand: { contact: 0.5, end: 0.95, back: 0.28 },
  Backhand: { contact: 0.5, end: 0.95, back: 0.28 },
  Serve: { contact: 0.85, end: 1.35, back: 0.5 },
  Smash: { contact: 0.58, end: 1.05, back: 0.38 },
};
const GAME_CONTACT = 0.45; // the engine's strokes meet the ball ~45% through
const clipForStroke = (kind: string) => (kind === 'serve' ? 'Serve' : kind === 'smash' ? 'Smash' : kind.endsWith('_bh') ? 'Backhand' : 'Forehand');
const strokeClipTime = (clip: string, u: number) => {
  const s = STROKE_TIME[clip];
  return u < GAME_CONTACT ? (u / GAME_CONTACT) * s.contact : s.contact + ((u - GAME_CONTACT) / (1 - GAME_CONTACT)) * (s.end - s.contact);
};
const approach = (cur: number, tgt: number, rate: number, dt: number) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const angDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// Every avatar draws with these two materials: colours live in the merged mesh's vertex colours.
const BODY_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.66 });
const HAIR_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.74, side: THREE.DoubleSide });
/** Optional per-part placement (e.g. head accessories fitted to a smaller head or bigger hair). */
export type PartXf = (part: string) => THREE.Matrix4 | null;

/**
 * Merge the shown parts into one geometry (plus one for double-sided hair): one draw call and one
 * skeleton per character instead of dozens. Vertices shared by two materials are split so colour
 * edges stay crisp.
 */
function mergeParts(asset: PlayerAsset, names: string[], colors: Record<string, string>, xf?: PartXf) {
  const acc = () => ({ pos: [] as number[], nrm: [] as number[], si: [] as number[], sw: [] as number[], col: [] as number[], idx: [] as number[] });
  const body = acc(), hair = acc();
  const c = new THREE.Color(), v = new THREE.Vector3(), nm = new THREE.Matrix3();
  for (const name of names) {
    const prims = asset.parts.get(name);
    if (!prims) continue;
    const px = xf ? xf(name) : null;
    for (const pr of prims) {
      const m = px ? px.clone().multiply(pr.dq) : pr.dq; // dequantize, then place
      nm.getNormalMatrix(m);
      const t = pr.hair ? hair : body;
      const P = pr.geo.getAttribute('position'), N = pr.geo.getAttribute('normal');
      const SI = pr.geo.getAttribute('skinIndex'), SW = pr.geo.getAttribute('skinWeight');
      const I = pr.geo.getIndex();
      if (!I) continue;
      if (colors[pr.mat]) c.set(colors[pr.mat]); else c.copy(pr.base);
      const remap = new Int32Array(P.count).fill(-1);
      for (let k = 0; k < I.count; k++) {
        const o = I.getX(k);
        let n = remap[o];
        if (n < 0) {
          n = remap[o] = t.pos.length / 3;
          v.fromBufferAttribute(P, o).applyMatrix4(m); t.pos.push(v.x, v.y, v.z);
          v.fromBufferAttribute(N, o).applyMatrix3(nm).normalize(); t.nrm.push(v.x, v.y, v.z);
          t.si.push(SI.getX(o), SI.getY(o), SI.getZ(o), SI.getW(o));
          t.sw.push(SW.getX(o), SW.getY(o), SW.getZ(o), SW.getW(o));
          t.col.push(c.r, c.g, c.b);
        }
        t.idx.push(n);
      }
    }
  }
  const build = (a: ReturnType<typeof acc>) => {
    if (!a.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(a.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(a.nrm, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(a.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(a.sw, 4));
    g.setAttribute('color', new THREE.Float32BufferAttribute(a.col, 3));
    g.setIndex(a.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(a.idx, 1) : new THREE.Uint16BufferAttribute(a.idx, 1));
    return g;
  };
  return { body: build(body), hair: build(hair) };
}

/** One rigged character: merged parts, paddle, animation layers and IK. */
export class Avatar3D {
  root: THREE.Object3D;
  /** The parts currently shown (names from the model). */
  shownParts: string[] = [];
  private skeleton: THREE.Skeleton;
  private body: THREE.SkinnedMesh | null = null;
  private hairMesh: THREE.SkinnedMesh | null = null;
  private lastLook: Avatar | null = null;
  private bones = new Map<string, THREE.Bone>();
  private mixer: THREE.AnimationMixer;
  private act = new Map<string, THREE.AnimationAction>();
  private w = new Map<string, number>();
  private lookKey = '';
  private paddle: THREE.Group | null = null;
  private phase = 0;
  yaw = 0;
  private holdW = 0;
  private flags: THREE.Object3D[] = [];
  readonly asset: PlayerAsset;

  constructor(asset: PlayerAsset) {
    this.asset = asset;
    // only the bones are cloned: the parts are merged into this avatar's own mesh when dressed
    this.root = new THREE.Group();
    const bones = asset.boneRoot.clone(true);
    this.root.add(bones);
    bones.traverse(o => { if ((o as THREE.Bone).isBone) this.bones.set(o.name, o as THREE.Bone); });
    this.skeleton = new THREE.Skeleton(asset.boneNames.map(n => this.bones.get(n) as THREE.Bone), asset.boneInverses);
    this.mixer = new THREE.AnimationMixer(this.root);
    const add = (key: string, clip: THREE.AnimationClip | undefined, timeScale = 0) => {
      if (!clip) throw new Error(`3D player: missing clip ${key}`);
      const a = this.mixer.clipAction(clip);
      a.setEffectiveWeight(0);
      a.timeScale = timeScale;
      a.play();
      this.act.set(key, a);
      this.w.set(key, 0);
    };
    for (const n of BASE_CLIPS) { add(n, asset.clips.get(n), 1); add(n + '_lower', asset.lower.get(n), 1); }
    for (const n of GAIT_CLIPS) { add(n, asset.clips.get(n)); add(n + '_lower', asset.lower.get(n)); }
    for (const n of STROKE_CLIPS) { add(n, asset.clips.get(n)); add(n + '_upper', asset.upper.get(n)); }
    add('RefSit', asset.clips.get('RefSit'), 1);
  }

  bone(name: string) { return this.bones.get(name) as THREE.Bone; }

  /** Show the parts and colours for this look (free when nothing changed). */
  dress(look: Avatar, paddleId: string | null) {
    if (look !== this.lastLook) { // the game keeps the same object until the look changes
      const key = JSON.stringify(look);
      this.lastLook = look;
      if (key !== this.lookKey) {
        this.lookKey = key;
        this.showParts(partsFor(look), colorsFor(look), accessoryXf(look));
      }
    }
    this.setPaddle(paddleId);
  }
  showParts(names: string[], colors: Record<string, string>, xf?: PartXf) {
    this.shownParts = names.slice();
    const { body, hair } = mergeParts(this.asset, names, colors, xf);
    this.body = this.setMesh(this.body, body, BODY_MAT);
    this.hairMesh = this.setMesh(this.hairMesh, hair, HAIR_MAT);
  }
  private setMesh(old: THREE.SkinnedMesh | null, geo: THREE.BufferGeometry | null, mat: THREE.Material) {
    if (old) { this.root.remove(old); old.geometry.dispose(); }
    if (!geo) return null;
    const m = new THREE.SkinnedMesh(geo, mat);
    m.frustumCulled = false; // skinned bounds don't follow the animation
    this.root.add(m);
    m.bind(this.skeleton, new THREE.Matrix4());
    return m;
  }
  setPaddle(id: string | null) {
    if (this.paddle && this.paddle.userData.paddleId === id) return;
    if (this.paddle) { this.paddle.removeFromParent(); this.paddle = null; }
    if (!id) return;
    this.paddle = buildPaddle(id);
    this.bone('Paddle').add(this.paddle);
  }
  /** Small coloured flags in the umpire's hands. */
  addFlags() {
    for (const side of ['Left', 'Right']) {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.36, 6), new THREE.MeshStandardMaterial({ color: '#d0d4da', metalness: 0.5, roughness: 0.4 }));
      pole.position.y = 0.14;
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.12), new THREE.MeshStandardMaterial({ color: '#ff3b3b', side: THREE.DoubleSide, roughness: 0.8 }));
      cloth.position.set(0.09, 0.26, 0);
      g.add(pole, cloth);
      g.position.set(side === 'Left' ? 0.085 : -0.085, -0.02, 0.01);
      g.visible = false;
      this.bone(`${side}Hand`).add(g);
      this.flags.push(g);
    }
  }
  setFlag(side: 0 | 1, color: string | null) {
    const f = this.flags[side];
    if (!f) return;
    f.visible = !!color;
    if (color) ((f.children[1] as THREE.Mesh).material as THREE.MeshStandardMaterial).color.set(color);
  }

  // ------------------------------------------------------------ animation
  private setW(key: string, w: number) { (this.act.get(key) as THREE.AnimationAction).setEffectiveWeight(w); }
  private smoothW(key: string, tgt: number, rate: number, dt: number) {
    const v = approach(this.w.get(key) || 0, tgt, rate, dt);
    this.w.set(key, v);
    return v;
  }

  /**
   * Drive the layers from a player's state.
   * vLocal = velocity in the model's frame (m/s; x = its left, z = forward).
   */
  animatePlayer(a: Athlete3D, vLocal: { x: number; z: number }, dt: number) {
    // ---- strokes (or the early backswing / the serve stance)
    let strokeClip: string | null = null, strokeTgt = 0;
    if (a.stroke) {
      strokeClip = clipForStroke(a.stroke);
      strokeTgt = 1;
      const act = this.act.get(strokeClip) as THREE.AnimationAction;
      const t = Math.min(strokeClipTime(strokeClip, a.strokeT), act.getClip().duration - 0.001);
      act.time = t;
      (this.act.get(strokeClip + '_upper') as THREE.AnimationAction).time = t;
    } else if (a.prep > 0.03 && a.inRally) {
      strokeClip = clipForStroke(a.prepKind);
      strokeTgt = a.prep * 0.9;
      const t = STROKE_TIME[strokeClip].back * Math.min(1, a.prep) * (a.prepKind.startsWith('dink') ? 0.5 : 1);
      (this.act.get(strokeClip) as THREE.AnimationAction).time = t;
      (this.act.get(strokeClip + '_upper') as THREE.AnimationAction).time = t;
    }
    // ---- locomotion blend: direction (forward / back / left / right) and speed
    const v = Math.hypot(vLocal.x, vLocal.z);
    const move = smooth(0.25, 1.1, v);
    const cf = Math.max(0, vLocal.z), cb = Math.max(0, -vLocal.z), cl = Math.max(0, vLocal.x), cr = Math.max(0, -vLocal.x);
    const n2 = cf * cf + cb * cb + cl * cl + cr * cr || 1;
    // forward family by speed
    const sp = v;
    const wWalk = sp < 1.6 ? 1 : sp < 2.4 ? 1 - (sp - 1.6) / 0.8 : 0;
    const wSprint = sp > 4.2 ? Math.min(1, (sp - 4.2) / 1.0) : 0;
    const wRun = 1 - wWalk - wSprint;
    const tgt: Record<string, number> = {
      Walk: (cf * cf / n2) * wWalk, Run: (cf * cf / n2) * wRun, Sprint: (cf * cf / n2) * wSprint,
      Backpedal: cb * cb / n2, StrafeLeft: cl * cl / n2, StrafeRight: cr * cr / n2,
    };
    // shared step phase so every gait lands its feet together; planted feet move at the real speed
    let dEff = 0, wSum = 0;
    for (const n of GAIT_CLIPS) { dEff += tgt[n] * CYCLE[n]; wSum += tgt[n]; }
    dEff = wSum > 0 ? dEff / wSum : 2;
    this.phase = (this.phase + (dt * v) / dEff) % 1;
    for (const n of GAIT_CLIPS) {
      const d = (this.act.get(n) as THREE.AnimationAction).getClip().duration;
      (this.act.get(n) as THREE.AnimationAction).time = this.phase * d * 0.9999;
      (this.act.get(n + '_lower') as THREE.AnimationAction).time = this.phase * d * 0.9999;
    }
    // ---- weights: strokes on top; when moving, the legs keep running under a stroke
    const base = a.serving ? 'ServeWait' : a.inRally ? 'Ready' : 'Idle';
    let gsum = 0;
    for (const n of GAIT_CLIPS) gsum += this.smoothW(n, tgt[n] * move, 10, dt);
    let bsum = 0;
    for (const n of BASE_CLIPS) bsum += this.smoothW(n, n === base ? 1 - move : 0, 8, dt);
    const locoSum = gsum + bsum || 1;
    let sw = 0;
    for (const n of STROKE_CLIPS) {
      const t = n === strokeClip ? strokeTgt : 0;
      const cur = this.w.get(n) || 0;
      sw += this.smoothW(n, t, t > cur ? 30 : 9, dt);
    }
    sw = Math.min(1, sw);
    const m = move;
    for (const n of STROKE_CLIPS) {
      const ws = this.w.get(n) || 0;
      this.setW(n, ws * (1 - m));
      this.setW(n + '_upper', ws * m);
    }
    const locoK = (k: number) => k / locoSum;
    for (const n of [...GAIT_CLIPS, ...BASE_CLIPS]) {
      const k = locoK(this.w.get(n) || 0);
      this.setW(n, k * (1 - sw));
      this.setW(n + '_lower', k * sw * m);
    }
    this.setW('RefSit', 0);
    this.mixer.update(dt);
  }
  animateRef(dt: number) {
    for (const [k, a] of this.act) a.setEffectiveWeight(k === 'RefSit' ? 1 : 0);
    this.mixer.update(dt);
  }
  /** A still pose for the customize screen. */
  animateShowcase(clip: string, dt: number) {
    for (const [k, a] of this.act) a.setEffectiveWeight(k === clip ? 1 : 0);
    const a = this.act.get(clip);
    if (a && a.timeScale === 0) a.time = (a.time + dt) % a.getClip().duration;
    this.mixer.update(dt);
  }

  // ------------------------------------------------------------ IK (in the model's own frame, metres)
  private tmpM = new THREE.Matrix4();
  private rootInv = new THREE.Matrix4();
  private local(o: THREE.Object3D, out = new THREE.Vector3()) { return out.setFromMatrixPosition(o.matrixWorld).applyMatrix4(this.rootInv); }
  private localQ(o: THREE.Object3D) {
    const q = new THREE.Quaternion();
    this.tmpM.multiplyMatrices(this.rootInv, o.matrixWorld).decompose(new THREE.Vector3(), q, new THREE.Vector3());
    return q;
  }
  private setLocalQ(o: THREE.Object3D, q: THREE.Quaternion) {
    const pq = this.localQ(o.parent as THREE.Object3D);
    o.quaternion.copy(pq.invert().multiply(q));
    o.updateMatrixWorld(true);
  }
  /** World point (feet) -> the model's frame (metres, unmirrored). */
  toLocal(p: THREE.Vector3) { return p.clone().applyMatrix4(this.rootInv); }
  beginIK() {
    this.root.updateMatrixWorld(true);
    this.rootInv.copy(this.root.matrixWorld).invert();
  }
  /** Two-bone arm IK to `target` (model frame), keeping the current bend plane; optional hand orientation. */
  reach(side: 'Left' | 'Right', target: THREE.Vector3, weight: number, handQ?: THREE.Quaternion) {
    if (weight <= 0.001) return;
    const upper = this.bone(`${side}Arm`), lower = this.bone(`${side}ForeArm`), hand = this.bone(`${side}Hand`);
    const keepHand = handQ || this.localQ(hand);
    const A = this.local(upper), E = this.local(lower), H = this.local(hand);
    const L1 = A.distanceTo(E), L2 = E.distanceTo(H);
    const goal = H.clone().lerp(target, weight);
    const d = goal.clone().sub(A);
    const dist = clamp(d.length(), Math.abs(L1 - L2) + 1e-3, (L1 + L2) * 0.999);
    const u = d.normalize();
    // bend plane from the current elbow
    let pole = E.clone().sub(A);
    pole.sub(u.clone().multiplyScalar(pole.dot(u)));
    if (pole.lengthSq() < 1e-8) pole = new THREE.Vector3(0, -1, -0.3);
    pole.normalize();
    const along = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, L1 * L1 - along * along));
    const E2 = A.clone().add(u.clone().multiplyScalar(along)).add(pole.multiplyScalar(h));
    const T2 = A.clone().add(u.clone().multiplyScalar(dist));
    // swing the upper arm onto the new elbow, then the forearm onto the target
    const rotU = new THREE.Quaternion().setFromUnitVectors(E.clone().sub(A).normalize(), E2.clone().sub(A).normalize());
    this.setLocalQ(upper, rotU.multiply(this.localQ(upper)));
    const E3 = this.local(lower), H3 = this.local(hand);
    const rotL = new THREE.Quaternion().setFromUnitVectors(H3.clone().sub(E3).normalize(), T2.clone().sub(E3).normalize());
    this.setLocalQ(lower, rotL.multiply(this.localQ(lower)));
    this.setLocalQ(hand, keepHand);
  }
  /** Hold the ball in the free (left) hand: palm up under it. */
  holdBall(ballLocal: THREE.Vector3, dt: number, holding: boolean) {
    this.holdW = approach(this.holdW, holding ? 1 : 0, holding ? 30 : 22, dt); // let go cleanly at the drop
    if (this.holdW < 0.01) return;
    const fwd = new THREE.Vector3(0.25, 0, 1).normalize();
    // hand frame: fingers forward-out, palm up (rest: fingers +X, palm -Y)
    const x = fwd, yN = new THREE.Vector3(0, -1, 0); // palm normal (-Y local) must point up -> local -Y = world up
    const zAxis = new THREE.Vector3().crossVectors(x, yN.clone().negate()).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, x).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, yAxis.negate(), zAxis.negate()));
    // wrist so the ball rests on the palm: palm centre ~7 cm along the fingers, ball radius above it
    const r = BALL_R / FT;
    const wrist = ballLocal.clone().sub(x.clone().multiplyScalar(0.07)).add(new THREE.Vector3(0, -(r + 0.018), 0));
    this.reach('Left', wrist, this.holdW, q);
  }
  /** Bring the paddle face to the contact point around the moment of contact. */
  reachContact(contactLocal: THREE.Vector3, strokeT: number) {
    const w = Math.exp(-(((strokeT - GAME_CONTACT) / 0.17) ** 2)) * 0.9;
    if (w < 0.02) return;
    const paddle = this.bone('Paddle');
    const face = new THREE.Vector3(0, 0, 0.21).applyMatrix4(paddle.matrixWorld).applyMatrix4(this.rootInv);
    const delta = contactLocal.clone().sub(face);
    if (delta.length() > 0.7) delta.setLength(0.7);
    const hand = this.local(this.bone('RightHand'));
    this.reach('Right', hand.add(delta), w);
  }
  /** Turn the head toward a point (model frame), within natural limits. */
  lookAt(p: THREE.Vector3, weight: number) {
    const head = this.bone('Head');
    const H = this.local(head);
    const d = p.clone().sub(H);
    const yaw = clamp(Math.atan2(d.x, d.z), -1.0, 1.0) * weight;
    const pitch = clamp(-Math.atan2(d.y, Math.hypot(d.x, d.z)), -0.5, 0.6) * weight;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * 0.7, yaw * 0.7, 0, 'YXZ'));
    this.setLocalQ(head, q.multiply(this.localQ(head)));
  }
}
const CYCLE: Record<string, number> = { Walk: 1.5, Run: 2.2, Sprint: 3.4, Backpedal: 1.4, StrafeLeft: 0.95, StrafeRight: 0.95 };

// ================================================================ court camera
/** Pinhole camera with the engine's projection: screen = (cx, hor) + f * (dx, -dz) / depth. */
class CourtCamera extends THREE.PerspectiveCamera {
  pin?: { w: number; h: number; f: number; cx: number; hor: number };
  set(c: Scene3D['cam'], w: number, h: number) {
    this.pin = { w, h, f: c.f, cx: c.cx, hor: c.hor };
    this.position.set(c.x, c.h, c.y);
    this.updateProjectionMatrix();
  }
  updateProjectionMatrix() {
    if (!this.pin) { super.updateProjectionMatrix(); return; }
    const { w, h, f, cx, hor } = this.pin;
    const n = 0.5;
    this.near = n;
    this.far = 400;
    this.projectionMatrix.makePerspective((-cx * n) / f, ((w - cx) * n) / f, (hor * n) / f, (-(h - hor) * n) / f, n, this.far, this.coordinateSystem, this.reversedDepth);
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }
}

// ================================================================ net, ball, umpire chairs
function buildNet(): THREE.Group {
  const g = new THREE.Group();
  const topAt = (fx: number) => CENTER_H + (POST_H - CENTER_H) * ((fx - COURT_W / 2) / (COURT_W / 2 + 1)) ** 2;
  const strip = (z0: (fx: number) => number, z1: (fx: number) => number, mat: THREE.Material) => {
    const pos: number[] = [], idx: number[] = [];
    for (let i = 0; i <= 44; i++) {
      const fx = -1 + i * 0.5;
      pos.push(fx, z0(fx), NET_Y, fx, z1(fx), NET_Y);
      if (i) { const k = i * 2; idx.push(k - 2, k, k - 1, k - 1, k, k + 1); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return new THREE.Mesh(geo, mat);
  };
  g.add(strip(() => 0.05, fx => topAt(fx) - 0.02, new THREE.MeshBasicMaterial({ color: 0x080a0e, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide })));
  const lp: number[] = [];
  for (let fx = -1; fx <= COURT_W + 1; fx += 0.5) lp.push(fx, 0.12, NET_Y, fx, topAt(fx) - 0.1, NET_Y);
  for (let z = 0.3; z < CENTER_H; z += 0.4) lp.push(-1, z, NET_Y, COURT_W + 1, z, NET_Y);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xd2dae6, transparent: true, opacity: 0.22, depthWrite: false })));
  const solid = (hex: number) => new THREE.MeshBasicMaterial({ color: hex, side: THREE.DoubleSide });
  g.add(strip(() => 0.03, () => 0.13, solid(0x141820)));
  g.add(strip(fx => topAt(fx) - 0.2, fx => topAt(fx) + 0.02, solid(0xffffff)));
  const strap = new THREE.Mesh(new THREE.PlaneGeometry(0.17, CENTER_H), solid(0xf4f6f9));
  strap.position.set(COURT_W / 2, CENTER_H / 2, NET_Y + 0.01);
  g.add(strap);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x151a21, roughness: 0.5, metalness: 0.3 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0xc9d0d8, roughness: 0.35, metalness: 0.6 });
  for (const x of [-1, COURT_W + 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, POST_H + 0.12, 16), postMat);
    post.position.set(x, (POST_H + 0.12) / 2, NET_Y);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.1, 16), capMat);
    cap.position.set(x, POST_H + 0.17, NET_Y);
    g.add(post, cap);
  }
  return g;
}

function buildBall(): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(BALL_R, 4);
  // 26 holes spread evenly (Fibonacci sphere), darker where the holes are
  const holes: THREE.Vector3[] = [];
  const N = 26, ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y);
    holes.push(new THREE.Vector3(Math.cos(i * ga) * r, y, Math.sin(i * ga) * r));
  }
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const base = new THREE.Color('#dff03a'), hole = new THREE.Color('#7d8a12');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let k = 0;
    for (const h of holes) k = Math.max(k, smooth(0.965, 0.985, v.dot(h)));
    const c = base.clone().lerp(hole, k);
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, emissive: '#2a3000', emissiveIntensity: 0.25 }));
}

/** A glowing arrow pointing down at the server (lime, like the HUD), with a dark rim so it reads on any background. */
function buildServeArrow(): THREE.Group {
  const g = new THREE.Group();
  const lime = new THREE.MeshStandardMaterial({ color: '#d7f23b', emissive: '#b8d61c', emissiveIntensity: 0.55, roughness: 0.35 });
  const rim = new THREE.MeshBasicMaterial({ color: '#14213d', side: THREE.BackSide });
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.55, 28), lime);
  head.rotation.x = Math.PI; // tip down
  head.position.y = 0.275;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.5, 20), lime);
  shaft.position.y = 0.8;
  const headRim = new THREE.Mesh(new THREE.ConeGeometry(0.39, 0.64, 28), rim);
  headRim.rotation.x = Math.PI;
  headRim.position.y = 0.3;
  const shaftRim = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.56, 20), rim);
  shaftRim.position.y = 0.8;
  g.add(headRim, shaftRim, head, shaft);
  g.visible = false;
  return g;
}

const SEAT_Z = 4.2; // ft: the umpire's seat
function buildChair(): THREE.Group {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: '#8a94a3', metalness: 0.6, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: '#4d5866', roughness: 0.6 });
  const bar = (a: THREE.Vector3, b: THREE.Vector3, r = 0.06) => {
    const d = b.clone().sub(a);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 8), metal);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    g.add(m);
  };
  // chair space: x = across the seat, y = up, z = toward the court (the umpire faces +z)
  for (const sx of [-1, 1]) {
    bar(new THREE.Vector3(sx * 0.95, 0, -0.75), new THREE.Vector3(sx * 0.7, SEAT_Z, -0.45));
    bar(new THREE.Vector3(sx * 0.95, 0, 0.85), new THREE.Vector3(sx * 0.7, SEAT_Z, 0.55));
  }
  for (let z = 0.9; z < SEAT_Z - 0.3; z += 0.9) {
    const k = z / SEAT_Z;
    const xw = 0.95 - 0.25 * k;
    bar(new THREE.Vector3(-xw, z, 0.85 - 0.3 * k), new THREE.Vector3(xw, z, 0.85 - 0.3 * k), 0.045);
    bar(new THREE.Vector3(-xw, z, -0.75 + 0.3 * k), new THREE.Vector3(xw, z, -0.75 + 0.3 * k), 0.045);
  }
  const foot = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.35), dark); // footrest
  foot.position.set(0, 2.62, 0.95);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.16, 1.3), dark);
  seat.position.set(0, SEAT_Z + 0.08, 0.05);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.9, 0.12), dark);
  back.position.set(0, SEAT_Z + 1.1, -0.62);
  bar(new THREE.Vector3(-0.7, SEAT_Z, 0.55), new THREE.Vector3(-0.7, 2.62, 0.95), 0.04);
  bar(new THREE.Vector3(0.7, SEAT_Z, 0.55), new THREE.Vector3(0.7, 2.62, 0.95), 0.04);
  g.add(foot, seat, back);
  return g;
}

// ================================================================ the court world
export interface PlayersWorld {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  update(s: Scene3D, dt: number): void;
  dispose(): void;
}
function addLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xe8eeff, 0x6a5844, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.3);
  key.position.set(COURT_W / 2 + 8, 40, 80);
  key.target.position.set(COURT_W / 2, 0, NET_Y);
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0xcfe0ff, 0.75);
  rim.position.set(COURT_W / 2 - 10, 25, -30);
  rim.target.position.set(COURT_W / 2, 0, NET_Y);
  scene.add(rim, rim.target);
}

const REF_SKINS = ['#c58c6a', '#8d5a3b'];
const FLAG: Record<string, string> = { out: '#ff3b3b', kitchen: '#ffd60a', fault: '#ffd60a' };

export async function createPlayersWorld(): Promise<PlayersWorld> {
  const asset = await loadPlayerAsset();
  const scene = new THREE.Scene();
  const camera = new CourtCamera();
  addLights(scene);
  scene.add(bakeStatic(buildNet()));
  const ball = buildBall();
  scene.add(ball);
  const decals = new Decals();
  scene.add(decals.group);
  const arrow = buildServeArrow();
  scene.add(arrow);
  let hall: THREE.Group | null = null, hallKey = '';

  const players = new Map<string, Avatar3D>();
  const refs: { av: Avatar3D; chair: THREE.Group }[] = [];
  const v3 = new THREE.Vector3();

  const makeRef = (i: number) => {
    const av = new Avatar3D(asset);
    av.showParts(REF_LOOK_PARTS, { skin: REF_SKINS[i % 2], lips: mixHex(REF_SKINS[i % 2], '#9e5552', 0.42), brow: '#1d1815', hair: '#1d1815', hat: '#141414', shoe: '#1e2026', sole: '#1e2026', shoeAccent: '#1e2026' });
    av.addFlags();
    const chair = new THREE.Group();
    chair.add(buildChair());
    scene.add(av.root, chair);
    return { av, chair };
  };

  function updateRef(r: Ref3D, i: number, clock: number, dt: number) {
    if (!refs[i]) refs[i] = makeRef(i);
    const { av, chair } = refs[i];
    const yaw = Math.PI / 2 - r.face; // the umpire looks along +x (left chair) or -x (right chair)
    if (chair.userData.at !== r.x + ',' + r.y + ',' + yaw) { // place once, then bake to one mesh
      const c = chair.children[0];
      c.position.set(r.x, 0, r.y);
      c.rotation.y = yaw;
      const baked = bakeStatic(c);
      chair.clear();
      chair.add(baked);
      chair.userData.at = r.x + ',' + r.y + ',' + yaw;
    }
    av.root.position.set(r.x, SEAT_Z - 0.9 * FT, r.y);
    av.root.rotation.set(0, yaw, 0);
    av.root.scale.setScalar(FT);
    av.animateRef(dt);
    av.beginIK();
    // eyes on the ball (engine gives a court-plane angle)
    const lookDir = new THREE.Vector3(Math.cos(r.look), 0, Math.sin(r.look)); // court (x, y) -> three (X, Z)
    const lookAt = av.toLocal(v3.set(r.x + lookDir.x * 10, 3, r.y + lookDir.z * 10));
    av.lookAt(lookAt, 0.8);
    // gestures: arms reach toward the call
    const shoulderY = 1.38;
    let tgt: THREE.Vector3 | null = null;
    if (r.target) tgt = av.toLocal(v3.set(r.target.x, 0.5, r.target.y));
    const point = (side: 'Left' | 'Right') => {
      const sh = new THREE.Vector3(side === 'Left' ? 0.17 : -0.17, shoulderY, 0);
      const d = (tgt ? tgt.clone() : new THREE.Vector3(0, 0, 3)).sub(sh).normalize();
      av.reach(side, sh.add(d.multiplyScalar(0.58)), 1);
    };
    const up = (side: 'Left' | 'Right') => av.reach(side, new THREE.Vector3((side === 'Left' ? 0.2 : -0.2) + Math.sin(clock * 9) * 0.04, 1.98, 0.08), 1);
    const out = (side: 'Left' | 'Right', wave = 0) => av.reach(side, new THREE.Vector3(side === 'Left' ? 0.68 : -0.68, 1.3 + wave, 0.1), 1);
    const toward: 'Left' | 'Right' = tgt && tgt.x < 0 ? 'Right' : 'Left';
    const other: 'Left' | 'Right' = toward === 'Left' ? 'Right' : 'Left';
    av.setFlag(0, null); av.setFlag(1, null);
    const flagOn = (side: 'Left' | 'Right', c: string) => av.setFlag(side === 'Left' ? 0 : 1, c);
    switch (r.pose) {
      case 'in': { const w = Math.sin(clock * 16) * 0.08; out('Left', w); out('Right', w); break; }
      case 'out': point(toward); out(other); flagOn(toward, FLAG.out); break;
      case 'kitchen': point(toward); flagOn(toward, FLAG.kitchen); break;
      case 'fault': up(r.x < COURT_W / 2 ? 'Right' : 'Left'); flagOn(r.x < COURT_W / 2 ? 'Right' : 'Left', FLAG.fault); break;
      case 'score': up(other); point(toward); break;
      case 'point': point(toward); break;
      default: break;
    }
  }

  function updatePlayer(a: Athlete3D, b: Ball3D, dt: number) {
    let av = players.get(a.id);
    if (!av) { av = new Avatar3D(asset); players.set(a.id, av); scene.add(av.root); }
    av.root.visible = true;
    av.dress(a.avatar, a.paddle);
    // facing: square to the net in a rally / at the serve, otherwise toward where they walk
    const netYaw = a.team === 'player' ? Math.PI : 0;
    const sp = Math.hypot(a.vx, a.vy);
    const travelYaw = Math.atan2(a.vx, a.vy); // court (x, y) -> three (X, Z): yaw from +Z
    const faceTravel = !a.inRally && !a.serving && sp > 3;
    const wantYaw = faceTravel ? travelYaw : netYaw;
    av.yaw += angDiff(wantYaw, av.yaw) * (1 - Math.exp(-dt * (faceTravel ? 8 : 6)));
    av.root.position.set(a.x, a.lift, a.y);
    av.root.rotation.set(0, av.yaw, 0);
    av.root.scale.set(FT * (a.lefty ? -1 : 1), FT, FT).multiplyScalar(a.avatar.gender === 'female' ? 0.96 : 1);
    // velocity in the model's frame (m/s): z forward, x = its left (mirrored for left-handers)
    const cy = Math.cos(av.yaw), sy = Math.sin(av.yaw);
    const vz = (a.vx * sy + a.vy * cy) / FT, vxl = (a.vx * cy - a.vy * sy) / FT;
    av.animatePlayer(a, { x: a.lefty ? -vxl : vxl, z: vz }, dt);
    // IK: ball in the free hand while held, paddle to the ball at contact, eyes on the ball
    av.beginIK();
    const ballLocal = av.toLocal(v3.set(b.x, b.z, b.y));
    av.holdBall(ballLocal, dt, b.holder === a.id);
    if (a.contact && a.stroke) av.reachContact(av.toLocal(v3.set(a.contact.x, a.contact.z, a.contact.y)), a.strokeT);
    if (a.inRally) av.lookAt(ballLocal, 0.55);
  }

  return {
    scene,
    camera,
    update(s: Scene3D, dt: number) {
      camera.set(s.cam, s.w, s.h);
      const hk = JSON.stringify([s.hall.left, s.hall.right, s.hall.back, s.hall.ceil, s.hall.near]);
      if (hk !== hallKey) { // the hall follows the camera's framing (tall screens get a higher roof)
        if (hall) scene.remove(hall);
        hall = buildHall(s.hall);
        scene.add(hall);
        hallKey = hk;
      }
      decals.update(s.decals);
      const d = s.paused ? 0 : dt;
      const seen = new Set<string>();
      for (const a of s.athletes) { seen.add(a.id); updatePlayer(a, s.ball, d); }
      for (const [id, av] of players) if (!seen.has(id)) av.root.visible = false;
      s.refs.forEach((r, i) => updateRef(r, i, s.clock, d));
      // the serving arrow floats over the server until the serve is struck
      const server = s.athletes.find(a => a.serverMark);
      arrow.visible = !!server;
      if (server) {
        arrow.position.set(server.x, 7.45 + server.lift + 0.16 * Math.sin(s.clock * 4.2), server.y);
        arrow.rotation.y = s.clock * 1.6;
      }
      ball.visible = s.ball.visible;
      ball.position.set(s.ball.x, s.ball.z, s.ball.y);
      ball.rotation.set(s.ball.spin, s.ball.spin * 0.7, 0);
      ball.scale.set(1 + 0.4 * s.ball.squash, 1 - 0.35 * s.ball.squash, 1 + 0.4 * s.ball.squash);
    },
    dispose() {
      scene.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.geometry && !(m.parent && m.parent.userData.paddleId)) m.geometry.dispose();
      });
    },
  };
}

// ================================================================ the customize-screen showcase
export interface ShowcaseWorld {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  setLook(a: Avatar, paddle: string): void;
  /** spin = turntable angle (radians), zoom 0..1 (full body .. close-up). */
  update(dt: number, spin: number, zoom: number, aspect: number): void;
}
export async function createShowcaseWorld(): Promise<ShowcaseWorld> {
  const asset = await loadPlayerAsset();
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x4a4036, 1.7));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(1.5, 3, 3);
  const rim = new THREE.DirectionalLight(0x9cc8ff, 1.2);
  rim.position.set(-2.5, 2, -2);
  scene.add(key, rim);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(0.75, 48), new THREE.MeshStandardMaterial({ color: '#1f6aa5', roughness: 0.85 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const av = new Avatar3D(asset);
  av.root.position.set(0, 0, 0);
  scene.add(av.root);
  const camera = new THREE.PerspectiveCamera(28, 0.6, 0.05, 50);
  let female = false;
  return {
    scene,
    camera,
    setLook(a, paddle) { av.dress(a, paddle); female = a.gender === 'female'; av.root.scale.setScalar(female ? 0.96 : 1); },
    update(dt, spin, zoom, aspect) {
      av.root.rotation.y = spin;
      av.animateShowcase('Idle', dt);
      camera.aspect = aspect;
      const dist = 3.9 - 2.5 * zoom, ty = 0.92 + 0.62 * zoom;
      camera.position.set(0, ty + 0.12, dist);
      camera.lookAt(0, ty, 0);
      camera.updateProjectionMatrix();
    },
  };
}
