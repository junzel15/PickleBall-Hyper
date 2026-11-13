// The indoor hall in 3D: maple floor, the court (surface, lines, stencils), walls with windows,
// banners and padding, the ceiling with trusses and LED panels, divider curtains and benches,
// plus the marks painted on the floor each frame (shadows, rings, landing spot, highlights).
// Court feet like the engine: X = x across, Y = height, Z = y along the court.
// Painted surfaces are drawn with the same Skia/Canvas code as the 2D view, into textures.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AlphaType, ColorType, Skia } from '@shopify/react-native-skia';
import { Ctx2D } from './canvas2d';
import type { Decal3D, Hall3D } from './engine';

const COURT_W = 20, COURT_L = 44, NET_Y = 22, KITCHEN = 7;
const TOP_KITCHEN = NET_Y - KITCHEN, BOT_KITCHEN = NET_Y + KITCHEN;

// ---------------------------------------------------------------- textures from Skia drawings
export function skiaTexture(w: number, h: number, draw: (ctx: Ctx2D) => void, repeat = false): THREE.Texture {
  const surface = Skia.Surface.Make(w, h);
  if (!surface) throw new Error('texture: no surface');
  const ctx = new Ctx2D(surface.getCanvas());
  draw(ctx);
  surface.flush();
  const px = surface.makeImageSnapshot().readPixels(0, 0, { width: w, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
  if (!px) throw new Error('texture: readPixels failed');
  const tex = new THREE.DataTexture(new Uint8Array(px.buffer, px.byteOffset, px.byteLength), w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
/** A soft round spot (alpha falls off to the edge) for shadows and light pools. */
function radialTexture(stops: [number, number][]): THREE.Texture {
  const N = 64, data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const r = Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2) / (N / 2);
    let a = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      const [r0, a0] = stops[i], [r1, a1] = stops[i + 1];
      if (r >= r0 && r <= r1) { a = a0 + ((a1 - a0) * (r - r0)) / (r1 - r0); break; }
    }
    data.set([255, 255, 255, Math.round(255 * a)], (y * N + x) * 4);
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * A flat rectangle with its texture mapped so that image row 0 is at `top` and column 0 at `left`.
 * corners: p00 = (u0, v0) top-left, p10 top-right, p01 bottom-left, p11 bottom-right.
 */
function quad(p00: number[], p10: number[], p01: number[], p11: number[], mat: THREE.Material, uv = [0, 0, 1, 1]): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...p00, ...p10, ...p01, ...p11], 3));
  const [u0, v0, u1, v1] = uv;
  g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u1, v0, u0, v1, u1, v1], 2));
  g.setIndex([0, 2, 1, 1, 2, 3]);
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}
const std = (color: string, rough = 0.8, extra: Record<string, unknown> = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, side: THREE.DoubleSide, ...extra });

// ---------------------------------------------------------------- static batching
const SOLID_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.08, side: THREE.DoubleSide });
const FLAT_MAT = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
/**
 * Bake a static group into as few draw calls as possible, with the same look: every opaque,
 * untextured mesh becomes one vertex-coloured mesh (lit or unlit), meshes sharing a textured or
 * transparent material are merged per material, and line sets per material.
 */
export function bakeStatic(root: THREE.Object3D): THREE.Group {
  root.updateMatrixWorld(true);
  const lit: THREE.BufferGeometry[] = [], flat: THREE.BufferGeometry[] = [];
  const byMat = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; line: boolean; order: number }>();
  const keepAttrs = (g: THREE.BufferGeometry, names: string[]) => {
    for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n);
    return g;
  };
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    const line = (o as THREE.LineSegments).isLineSegments === true;
    if (!mesh.isMesh && !line) return;
    const mat = mesh.material as THREE.Material & { color?: THREE.Color; map?: THREE.Texture | null };
    let g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    if (!line && !mat.map && !mat.transparent && mat.blending === THREE.NormalBlending) {
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      const n = g.getAttribute('position').count, c = mat.color || new THREE.Color(1, 1, 1);
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      (mat.type === 'MeshBasicMaterial' ? flat : lit).push(keepAttrs(g, ['position', 'normal', 'color']));
      return;
    }
    let e = byMat.get(mat);
    if (!e) { e = { geos: [], line, order: mesh.renderOrder }; byMat.set(mat, e); }
    e.geos.push(keepAttrs(g, line ? ['position'] : mat.map ? ['position', 'normal', 'uv'] : ['position', 'normal']));
  });
  const out = new THREE.Group();
  if (lit.length) out.add(new THREE.Mesh(mergeGeometries(lit), SOLID_MAT));
  if (flat.length) out.add(new THREE.Mesh(mergeGeometries(flat), FLAT_MAT));
  for (const [mat, e] of byMat) {
    const g = mergeGeometries(e.geos);
    const obj = e.line ? new THREE.LineSegments(g, mat) : new THREE.Mesh(g, mat);
    obj.renderOrder = e.order;
    out.add(obj);
  }
  return out;
}

// ---------------------------------------------------------------- the court (one painted texture)
const SUR = { x0: -10, y0: -10, x1: COURT_W + 10, y1: COURT_L + 10 }; // the cushioned surround
function courtTexture(): THREE.Texture {
  const ppf = 24; // pixels per foot: 2-inch lines are 4 px wide
  const W = (SUR.x1 - SUR.x0) * ppf, H = (SUR.y1 - SUR.y0) * ppf;
  return skiaTexture(W, H, ctx => {
    ctx.scale(ppf, ppf);
    ctx.translate(-SUR.x0, -SUR.y0);
    ctx.fillStyle = '#2c7353'; ctx.fillRect(SUR.x0, SUR.y0, SUR.x1 - SUR.x0, SUR.y1 - SUR.y0);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(SUR.x0, SUR.y0, SUR.x1 - SUR.x0, 0.25);
    ctx.fillStyle = '#2458a4'; ctx.fillRect(0, 0, COURT_W, COURT_L);
    ctx.fillStyle = '#2f6fbe'; ctx.fillRect(0, TOP_KITCHEN, COURT_W, BOT_KITCHEN - TOP_KITCHEN);
    ctx.fillStyle = 'rgba(10,30,60,0.35)'; // paint edge just outside the lines
    ctx.fillRect(-0.35, -0.35, COURT_W + 0.7, 0.35); ctx.fillRect(-0.35, COURT_L, COURT_W + 0.7, 0.35);
    ctx.fillRect(-0.35, 0, 0.35, COURT_L); ctx.fillRect(COURT_W, 0, 0.35, COURT_L);
    const LW = 2 / 12;
    ctx.fillStyle = '#f6f8fb';
    ctx.fillRect(0, 0, LW, COURT_L); ctx.fillRect(COURT_W - LW, 0, LW, COURT_L);
    ctx.fillRect(0, 0, COURT_W, LW); ctx.fillRect(0, COURT_L - LW, COURT_W, LW);
    ctx.fillRect(0, TOP_KITCHEN - LW / 2, COURT_W, LW); ctx.fillRect(0, BOT_KITCHEN - LW / 2, COURT_W, LW);
    ctx.fillRect(10 - LW / 2, 0, LW, TOP_KITCHEN); ctx.fillRect(10 - LW / 2, BOT_KITCHEN, LW, COURT_L - BOT_KITCHEN);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const text = (t: string, x: number, y: number, size: number, color: string, weight = 900) => {
      ctx.save(); ctx.translate(x, y); ctx.scale(1 / ppf, 1 / ppf);
      ctx.font = `${weight} ${Math.round(size * ppf)}px system-ui, sans-serif`;
      ctx.fillStyle = color; ctx.fillText(t, 0, 0); ctx.restore();
    };
    for (const ky of [TOP_KITCHEN + 3.5, BOT_KITCHEN - 3.5]) text('KITCHEN', 10, ky, 1.4, 'rgba(255,255,255,0.18)', 800);
    text('PICKLEBALL HYPER', 10, -4.2, 2.2, 'rgba(255,255,255,0.55)');
    text('PICKLEBALL HYPER', 10, COURT_L + 4.2, 2.2, 'rgba(255,255,255,0.4)');
  });
}
function woodTexture(): THREE.Texture { // 4.8 ft square of maple, repeated
  const S = 480, ppf = S / 4.8;
  return skiaTexture(S, S, ctx => {
    ctx.fillStyle = '#c89a62'; ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(120,70,30,0.07)';
    for (let x = 0; x < 4.8; x += 2.4) ctx.fillRect(x * ppf, 0, 1.2 * ppf, S);
    ctx.fillStyle = 'rgba(95,55,25,0.18)';
    for (let x = 0; x < 4.8; x += 0.6) ctx.fillRect(x * ppf, 0, 1.2, S);
    // board ends, staggered
    for (let i = 0; i < 8; i++) { const x = i * 0.6, y = ((i * 1.7) % 4.8); ctx.fillRect(x * ppf, y * ppf, 0.6 * ppf, 1.2); }
  }, true);
}

// ---------------------------------------------------------------- the back wall (one painted texture)
function backWallTexture(h: Hall3D): THREE.Texture {
  const ppf = 20, L = h.left, R = h.right, C = h.ceil, pad = h.pad;
  const W = (R - L) * ppf, H = Math.round(C * ppf);
  return skiaTexture(W, H, ctx => {
    ctx.scale(ppf, ppf);
    ctx.translate(-L, C);     // x across; image y = -z (top of the image is the ceiling)
    ctx.scale(1, -1);
    ctx.fillStyle = '#d5dae1'; ctx.fillRect(L, pad, R - L, C - pad);
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    for (let z = pad + 1.35; z < C; z += 1.35) ctx.fillRect(L, z, R - L, 0.05);
    const wz1 = C - 3.5, wz0 = wz1 - 4;
    ctx.fillStyle = '#a6cfeb'; ctx.fillRect(-26, wz0, 72, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(-26, wz1 - 1.4, 72, 1.4);
    ctx.fillStyle = '#5d6b7c';
    for (let x = -26; x <= 46; x += 4) ctx.fillRect(x - 0.1, wz0, 0.2, 4);
    ctx.fillRect(-26, (wz0 + wz1) / 2 - 0.06, 72, 0.12);
    ctx.fillStyle = '#1f3c63'; ctx.fillRect(L, 0, R - L, pad);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    for (let x = L + 5; x < R; x += 5) ctx.fillRect(x, 0.15, 0.06, pad - 0.3);
    ctx.fillStyle = '#2f80ed'; ctx.fillRect(L, pad - 0.45, R - L, 0.45);
    const banner = (x0: number, x1: number, z0: number, z1: number, bg: string, fg: string, t: string) => {
      ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(x0 + 0.15, z0 - 0.15, x1 - x0, z1 - z0);
      ctx.fillStyle = bg; ctx.fillRect(x0, z0, x1 - x0, z1 - z0);
      ctx.save(); ctx.translate((x0 + x1) / 2, (z0 + z1) / 2); ctx.scale(1 / ppf, -1 / ppf);
      ctx.font = `900 ${Math.round(1.25 * ppf)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = fg;
      ctx.fillText(t, 0, 1, (x1 - x0 - 1) * ppf);
      ctx.restore();
    };
    banner(-17, -6, 9.5, 13.2, '#1f3c63', '#d7f23b', 'PICKLEBALL CLUB');
    banner(26, 37, 9.5, 13.2, '#d7f23b', '#1f3c63', 'COURT 1');
  });
}

// ---------------------------------------------------------------- build the hall
export function buildHall(h: Hall3D): THREE.Group {
  const g = new THREE.Group();
  const { left: L, right: R, back: B, ceil: C, pad } = h;
  const N = h.near + 4;
  // floor: maple everywhere, the court and its surround painted on top
  const wood = woodTexture();
  const fw = R - L, fd = N - B;
  g.add(quad([L, -0.01, B], [R, -0.01, B], [L, -0.01, N], [R, -0.01, N], std('#ffffff', 0.45, { map: wood, side: THREE.FrontSide }), [0, 0, fw / 4.8, fd / 4.8]));
  g.add(quad([SUR.x0, 0, SUR.y0], [SUR.x1, 0, SUR.y0], [SUR.x0, 0, SUR.y1], [SUR.x1, 0, SUR.y1], std('#ffffff', 0.62, { map: courtTexture(), side: THREE.FrontSide })));
  // light pools from the ceiling panels
  const pool = radialTexture([[0, 0.07], [0.6, 0.03], [1, 0]]); // soft: just a hint of the lights above
  const poolMat = new THREE.MeshBasicMaterial({ map: pool, color: '#fff3d6', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  for (const l of h.lights) {
    if (l.y > h.near - 6) continue;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), poolMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(l.x, 0.005, l.y);
    m.renderOrder = 1;
    g.add(m);
  }
  // back wall (painted) and side walls
  g.add(quad([L, C, B], [R, C, B], [L, 0, B], [R, 0, B], std('#ffffff', 0.85, { map: backWallTexture(h) })));
  for (const x of [L, R]) {
    g.add(quad([x, C, B], [x, C, N], [x, pad, B], [x, pad, N], std('#c9cfd8', 0.85)));
    g.add(quad([x, pad, B], [x, pad, N], [x, 0, B], [x, 0, N], std('#1b3557', 0.7)));
    const stripe = quad([x, pad, B], [x, pad, N], [x, pad - 0.45, B], [x, pad - 0.45, N], std('#2f80ed', 0.6));
    stripe.position.x = x === L ? 0.01 : -0.01;
    g.add(stripe);
  }
  // ceiling, trusses, LED panels with a soft glow
  g.add(quad([L, C, B], [R, C, B], [L, C, N], [R, C, N], std('#262c36', 0.9)));
  const steel = std('#3b4350', 0.6, { metalness: 0.4 });
  for (let y = B + 5; y < N - 2; y += 10) {
    const truss = new THREE.Mesh(new THREE.BoxGeometry(R - L, 0.25, 0.7), steel);
    truss.position.set((L + R) / 2, C - 0.3, y + 0.35);
    const chord = new THREE.Mesh(new THREE.BoxGeometry(R - L, 0.15, 0.15), steel);
    chord.position.set((L + R) / 2, C - 1.4, y + 0.35);
    g.add(truss, chord);
  }
  const ledMat = new THREE.MeshBasicMaterial({ color: '#fffbea', side: THREE.DoubleSide });
  const glowMat = new THREE.MeshBasicMaterial({ map: radialTexture([[0, 0.45], [1, 0]]), color: '#fff6d8', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  for (const l of h.lights) {
    if (l.y > h.near - 6) continue;
    const led = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.4), ledMat);
    led.rotation.x = Math.PI / 2;
    led.position.set(l.x, C - 0.6, l.y);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), glowMat);
    glow.rotation.x = Math.PI / 2;
    glow.position.set(l.x, C - 0.65, l.y);
    g.add(led, glow);
  }
  // divider curtains
  const y0 = B + 0.5, y1 = h.near - 7, dh = 10;
  const mesh = new THREE.MeshBasicMaterial({ color: '#0e1117', transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
  const hem = new THREE.MeshBasicMaterial({ color: '#080a0e', transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const pipe = std('#9aa3ad', 0.4, { metalness: 0.5 }), postM = std('#7d8793', 0.45, { metalness: 0.5 });
  for (const x of h.dividers) {
    g.add(quad([x, dh, y0], [x, dh, y1], [x, 0, y0], [x, 0, y1], mesh));
    g.add(quad([x, 0.45, y0], [x, 0.45, y1], [x, 0, y0], [x, 0, y1], hem));
    const lp: number[] = [];
    for (let z = 1; z < dh; z += 1) lp.push(x, z, y0, x, z, y1);
    for (let y = y0; y < y1; y += 2) lp.push(x, 0.4, y, x, dh, y);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.06, depthWrite: false })));
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, y1 - y0, 8), pipe);
    top.rotation.x = Math.PI / 2;
    top.position.set(x, dh, (y0 + y1) / 2);
    g.add(top);
    for (let y = y0 + 1; y < y1; y += 14) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, dh + 0.3, 8), postM);
      post.position.set(x, (dh + 0.3) / 2, y);
      g.add(post);
    }
  }
  for (const b of h.benches) g.add(buildBench(b.x, b.y, b.facing));
  return bakeStatic(g);
}

function buildBench(x: number, y: number, facing: number): THREE.Group {
  const g = new THREE.Group();
  const Lh = 3.2, D = 0.7, H = 1.5;
  const wood = std('#9a6a3d', 0.6), dark = std('#5c3c22', 0.7);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(D * 2, 0.16, Lh * 2), wood);
  seat.position.set(x, H - 0.08, y);
  g.add(seat);
  for (const sy of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(D * 1.8, H - 0.16, 0.18), dark);
    leg.position.set(x, (H - 0.16) / 2, y + sy * (Lh - 0.3));
    g.add(leg);
  }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, Lh * 2 - 0.6), dark);
  rail.position.set(x + facing * (D - 0.1), H - 0.4, y);
  g.add(rail);
  const towel = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 1.4), std('#f1f3f6', 0.95));
  towel.position.set(x, H + 0.03, y - 1.1);
  g.add(towel);
  const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.75, 12), std('#2f80ed', 0.3));
  bottle.position.set(x, H + 0.375, y + 1.2);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.15, 12), std('#e8edf3', 0.4));
  cap.position.set(x, H + 0.82, y + 1.2);
  g.add(bottle, cap);
  const bag = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.1, 1.8), std('#20252e', 0.75));
  bag.position.set(x - facing * 1.5, 0.55, y + 0.5);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.12, 1.82), std('#d7f23b', 0.6));
  strip.position.set(x - facing * 1.5, 0.7, y + 0.5);
  g.add(bag, strip);
  return g;
}

// ---------------------------------------------------------------- floor marks (one mesh)
/**
 * Every mark on the floor (shadows, rings, landing spot, highlights) is written into one dynamic
 * mesh each frame: a single draw call. Soft shadows fade out with vertex alpha.
 */
export class Decals {
  group = new THREE.Group();
  private max = 6000;
  private pos = new Float32Array(this.max * 3);
  private col = new Float32Array(this.max * 4);
  private idx = new Uint16Array(this.max * 3);
  private geo = new THREE.BufferGeometry();
  private nv = 0;
  private ni = 0;
  private c = new THREE.Color();
  constructor() {
    const P = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    const C = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    const I = new THREE.BufferAttribute(this.idx, 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', P);
    this.geo.setAttribute('color', C);
    this.geo.setIndex(I);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    this.group.add(mesh);
  }
  private v(x: number, y: number, z: number, a: number) {
    const i = this.nv++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.col[i * 4] = this.c.r; this.col[i * 4 + 1] = this.c.g; this.col[i * 4 + 2] = this.c.b; this.col[i * 4 + 3] = a;
    return i;
  }
  private t(a: number, b: number, c: number) { this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c; }
  /** Concentric rings at radii r[k] (fraction of rx, ry) with alpha al[k]; arcs = optional dashes. */
  private rings(d: Decal3D, y: number, r: number[], al: number[], seg: number, from = 0, span = Math.PI * 2) {
    const base = this.nv, n = seg + (span < Math.PI * 2 ? 1 : 0);
    for (let k = 0; k < r.length; k++) {
      for (let j = 0; j < n; j++) {
        const t = from + (span * j) / seg;
        this.v(d.x + Math.cos(t) * d.rx * r[k], y, d.y + Math.sin(t) * d.ry * r[k], al[k]);
      }
    }
    for (let k = 0; k < r.length - 1; k++) {
      for (let j = 0; j < seg; j++) {
        const j2 = span < Math.PI * 2 ? j + 1 : (j + 1) % seg;
        const a0 = base + k * n + j, a1 = base + k * n + j2, b0 = a0 + n, b1 = a1 + n;
        this.t(a0, b0, a1); this.t(a1, b0, b1);
      }
    }
  }
  update(list: Decal3D[]) {
    this.nv = 0; this.ni = 0;
    for (const d of list) {
      if (this.nv > this.max - 300) break;
      this.c.set(d.c);
      const a = Math.max(0, Math.min(1, d.a));
      if (d.k === 'quad') {
        const x1 = d.x1 as number, y1 = d.y1 as number;
        const i = this.v(d.x, 0.02, d.y, a); this.v(x1, 0.02, d.y, a); this.v(x1, 0.02, y1, a); this.v(d.x, 0.02, y1, a);
        this.t(i, i + 1, i + 2); this.t(i, i + 2, i + 3);
      } else if (d.k === 'disc') {
        const c = this.v(d.x, 0.02, d.y, a);
        const first = this.nv;
        this.rings(d, 0.02, d.soft ? [0.55, 1] : [1], d.soft ? [a * 0.78, 0] : [a], 28);
        for (let j = 0; j < 28; j++) this.t(c, first + j, first + ((j + 1) % 28));
      } else {
        const w = Math.min(0.9, (d.w || 0.1) / d.rx);
        if (d.k === 'ring') this.rings(d, 0.03, [1 - w, 1], [a, a], 48);
        else for (let k = 0; k < 10; k++) this.rings(d, 0.03, [1 - w, 1], [a, a], 4, (d.rot || 0) + (k / 10) * Math.PI * 2, (Math.PI * 2) / 10 * 0.6);
      }
    }
    const P = this.geo.getAttribute('position') as THREE.BufferAttribute, C = this.geo.getAttribute('color') as THREE.BufferAttribute;
    const I = this.geo.getIndex() as THREE.BufferAttribute;
    P.clearUpdateRanges(); P.addUpdateRange(0, this.nv * 3); P.needsUpdate = true;
    C.clearUpdateRanges(); C.addUpdateRange(0, this.nv * 4); C.needsUpdate = true;
    I.clearUpdateRanges(); I.addUpdateRange(0, this.ni); I.needsUpdate = true;
    this.geo.setDrawRange(0, this.ni);
  }
}
