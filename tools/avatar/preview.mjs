// Software renderer for the exported GLB (reads the file itself, so it also checks the export).
//   node tools/avatar/preview.mjs [outDir] [sheet,sheet,...]
// sheets: wardrobe, heads, anim (all clips), or clip names (Run, Serve, ...)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const glbPath = resolve(here, '../../assets/3d/pickleball_player.glb');
const outDir = resolve(process.argv[2] || join(tmpdir(), 'pickleball-avatar-preview'));
mkdirSync(outDir, { recursive: true });
const want = process.argv[3] ? process.argv[3].split(',') : ['wardrobe', 'heads', 'anim'];

// ---------------- GLB parse
const buf = readFileSync(glbPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
const jlen = buf.readUInt32LE(12);
const G = JSON.parse(buf.subarray(20, 20 + jlen).toString());
const binStart = 20 + jlen + 8;
const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jlen));
const COMP = { 5126: Float32Array, 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array };
const NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function acc(i) {
  const a = G.accessors[i], bv = G.bufferViews[a.bufferView];
  const T = COMP[a.componentType], n = SIZE[a.type], es = T.BYTES_PER_ELEMENT;
  const stride = bv.byteStride || n * es;
  const base = bin.byteOffset + bv.byteOffset + (a.byteOffset || 0);
  const out = a.normalized ? new Float32Array(a.count * n) : new T(a.count * n);
  const dv = new DataView(bin.buffer);
  const get = { 5126: 'getFloat32', 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32' }[a.componentType];
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) {
    const v = dv[get](base + k * stride + c * es, true);
    out[k * n + c] = a.normalized ? Math.max(-1, v / NORM[a.componentType]) : v;
  }
  return out;
}

// ---------------- math (column-major 4x4)
const m4mul = (a, b) => {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
};
const m4trs = (t = [0, 0, 0], q = [0, 0, 0, 1]) => {
  const [x, y, z, w] = q;
  return Float64Array.from([
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    t[0], t[1], t[2], 1,
  ]);
};
const slerp = (a, b, t) => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map(v => -v); d = -d; }
  const o = a.map((v, i) => v + (b[i] - v) * t);
  const l = Math.hypot(...o);
  return o.map(v => v / l);
};
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };

// ---------------- scene data: one entry per part (mesh node)
const skin = G.skins[0];
const parent = new Array(G.nodes.length).fill(-1);
G.nodes.forEach((n, i) => (n.children || []).forEach(c => { parent[c] = i; }));
const order = [];
const visit = i => { order.push(i); (G.nodes[i].children || []).forEach(visit); };
visit(0);
const PARTS = new Map();
for (const n of G.nodes) {
  if (n.mesh == null) continue;
  const mesh = G.meshes[n.mesh];
  const a = mesh.primitives[0].attributes;
  PARTS.set(n.name, {
    IBM: acc(G.skins[n.skin].inverseBindMatrices),
    POS: acc(a.POSITION), NRM: acc(a.NORMAL), JNT: acc(a.JOINTS_0), WGT: acc(a.WEIGHTS_0),
    prims: mesh.primitives.map(p => ({ idx: acc(p.indices), mat: G.materials[p.material] })),
  });
}
const anims = Object.fromEntries(G.animations.map(a => [a.name, {
  ch: a.channels.map(c => ({ node: c.target.node, path: c.target.path, t: acc(a.samplers[c.sampler].input), v: acc(a.samplers[c.sampler].output) })),
}]));

// ---------------- dressing (mirrors src/game/players3d.ts)
const DEFAULT = {
  gender: 'male', skin: '#d29d74', hair: 'short', hairColor: '#3b2a1f', eyes: '#4a2e1d', facial: 'none', headwear: 'none',
  hatColor: '#1d4e89', shirt: '#2f80ed', shirtStyle: 'crew', shirtAccent: '#f5f5f2', shortsStyle: 'classic', shortsColor: '#1f2a44',
  shoes: 'white', kneeGuard: 'none', elbowGuard: 'none',
};
const SHOES = { white: ['#f4f5f7', '#c9ced6', '#2f80ed'], black: ['#1e2026', '#f1f1f1', '#d7f23b'], neon: ['#d7f23b', '#22262e', '#1e2026'] };
const ARMS = { tank: 'bare', raglan: 'raglan', polo: 'polo' };
function partsFor(a) {
  const g = a.gender === 'female' ? 'f' : 'm';
  const p = [`${g}.head`, 'hands', 'shoes', `${g}.torso.${a.shirtStyle}`, `${g}.arms.${ARMS[a.shirtStyle] || 'sleeve'}`, `${g}.legs.${a.shortsStyle}`];
  if (a.hair !== 'bald') p.push(`${g}.hair.${a.hair}`);
  if (a.headwear !== 'none') p.push(`${g}.hat.${a.headwear}`);
  if (g === 'm' && a.facial !== 'none') p.push(`m.facial.${a.facial}`);
  if (a.kneeGuard !== 'none') p.push(`${g}.knee`);
  if (a.elbowGuard !== 'none') p.push(`${g}.elbow`);
  return p;
}
const REF = ['m.head', 'hands', 'shoes', 'ref.torso', 'ref.arms', 'ref.legs', 'm.hat.cap'];
const hexLin = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); };
const mixHex = (a, b, t) => { const A = hexLin(a), Bc = hexLin(b); return A.map((v, i) => v + (Bc[i] - v) * t); };
function colorsFor(a) {
  const sh = SHOES[a.shoes] || SHOES.white;
  const c = {
    skin: hexLin(a.skin), lips: mixHex(a.skin, '#9e5552', 0.45), brow: hexLin(a.hairColor), hair: hexLin(a.hairColor),
    stubble: mixHex(a.skin, a.hairColor, 0.55), iris: hexLin(a.eyes), shirt: hexLin(a.shirt), shirtAccent: hexLin(a.shirtAccent),
    shorts: hexLin(a.shortsColor), shoe: hexLin(sh[0]), sole: hexLin(sh[1]), shoeAccent: hexLin(sh[2]), hat: hexLin(a.hatColor),
  };
  if (a.kneeGuard !== 'none') c.kneeGuard = hexLin(a.kneeGuard);
  if (a.elbowGuard !== 'none') c.elbowGuard = hexLin(a.elbowGuard);
  return c;
}

// ---------------- pose + skinning
function jointMats(clip, time) {
  const T = G.nodes.map(n => n.translation || [0, 0, 0]);
  const Rq = G.nodes.map(n => n.rotation || [0, 0, 0, 1]);
  if (clip) for (const c of anims[clip].ch) {
    const k = c.path === 'rotation' ? 4 : 3;
    const n = c.t.length;
    let i = 0;
    while (i < n - 2 && time > c.t[i + 1]) i++;
    const u = n < 2 ? 0 : Math.min(1, Math.max(0, (time - c.t[i]) / (c.t[i + 1] - c.t[i])));
    const a = Array.from(c.v.slice(i * k, i * k + k)), b = Array.from(c.v.slice(Math.min(n - 1, i + 1) * k, Math.min(n - 1, i + 1) * k + k));
    if (k === 4) Rq[c.node] = slerp(a, b, u); else T[c.node] = a.map((v, j) => v + (b[j] - v) * u);
  }
  const W = new Array(G.nodes.length);
  for (const i of order) { const L = m4trs(T[i], Rq[i]); W[i] = parent[i] < 0 ? L : m4mul(W[parent[i]], L); }
  return W; // per part: joint matrix = W[joint] * that part's IBM
}
function skinPart(part, W, R) {
  const { POS, NRM, JNT, WGT, IBM } = part;
  const JM = skin.joints.map((j, k) => m4mul(W[j], IBM.subarray(k * 16, k * 16 + 16)));
  const NV = POS.length / 3;
  const P = new Float64Array(NV * 3), N = new Float64Array(NV * 3);
  for (let v = 0; v < NV; v++) {
    const x = POS[v * 3], y = POS[v * 3 + 1], z = POS[v * 3 + 2];
    const nx = NRM[v * 3], ny = NRM[v * 3 + 1], nz = NRM[v * 3 + 2];
    let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0;
    for (let k = 0; k < 4; k++) {
      const w = WGT[v * 4 + k];
      if (!w) continue;
      const M = JM[JNT[v * 4 + k]];
      px += w * (M[0] * x + M[4] * y + M[8] * z + M[12]); py += w * (M[1] * x + M[5] * y + M[9] * z + M[13]); pz += w * (M[2] * x + M[6] * y + M[10] * z + M[14]);
      qx += w * (M[0] * nx + M[4] * ny + M[8] * nz); qy += w * (M[1] * nx + M[5] * ny + M[9] * nz); qz += w * (M[2] * nx + M[6] * ny + M[10] * nz);
    }
    const l = Math.hypot(qx, qy, qz) || 1; // (normals pick up the uniform dequantization scale)
    P.set([R[0] * px + R[4] * py + R[8] * pz + R[12], R[1] * px + R[5] * py + R[9] * pz + R[13], R[2] * px + R[6] * py + R[10] * pz + R[14]], v * 3);
    N.set([(R[0] * qx + R[4] * qy + R[8] * qz) / l, (R[1] * qx + R[5] * qy + R[9] * qz) / l, (R[2] * qx + R[6] * qy + R[10] * qz) / l], v * 3);
  }
  return { P, N };
}
function figure(names, colors, clip, t, root = m4trs()) {
  const JM = jointMats(clip, t);
  return names.map(n => {
    const part = PARTS.get(n);
    if (!part) throw new Error(`missing part ${n}`);
    return { part, geo: skinPart(part, JM, root), colors };
  });
}

// ---------------- rasteriser
const toSRGB = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function render(figs, W, H, eye, target, fov = 30) {
  const img = new Float32Array(W * H * 3), zb = new Float32Array(W * H).fill(Infinity);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const g = 0.93 - 0.12 * (y / H); img.set([g * 0.92, g * 0.95, g], (y * W + x) * 3); }
  const f = norm3(sub3(target, eye)), r = norm3(cross3(f, [0, 1, 0])), u = cross3(r, f);
  const foc = H / 2 / Math.tan((fov * Math.PI) / 360);
  const proj = p => { const d = sub3(p, eye); const z = dot3(d, f); return [W / 2 + (dot3(d, r) * foc) / z, H / 2 - (dot3(d, u) * foc) / z, z]; };
  const L1 = norm3([0.45, 0.8, 0.55]), L2 = norm3([-0.6, 0.3, -0.5]);
  const tri = (a, b, c, ca, cb, cc) => {
    if (a[2] < 0.05 || b[2] < 0.05 || c[2] < 0.05) return;
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (area >= 0) return;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
      const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
      const k = y * W + x;
      if (z >= zb[k]) continue;
      zb[k] = z;
      for (let ch = 0; ch < 3; ch++) img[k * 3 + ch] = w0 * ca[ch] + w1 * cb[ch] + w2 * cc[ch];
    }
  };
  const fl = [0.32, 0.45, 0.55];
  const q = [[-3, 0, -3], [3, 0, -3], [3, 0, 3], [-3, 0, 3]].map(proj);
  tri(q[0], q[3], q[2], fl, fl, fl); tri(q[0], q[2], q[1], fl, fl, fl);
  for (const { part, geo, colors } of figs) {
    for (const p of part.prims) {
      const base = colors[p.mat.name] || p.mat.pbrMetallicRoughness.baseColorFactor;
      const rough = p.mat.pbrMetallicRoughness.roughnessFactor;
      const cache = new Map(), sp = new Map();
      const col = v => {
        if (cache.has(v)) return cache.get(v);
        const n = [geo.N[v * 3], geo.N[v * 3 + 1], geo.N[v * 3 + 2]], pos = [geo.P[v * 3], geo.P[v * 3 + 1], geo.P[v * 3 + 2]];
        const d1 = Math.max(0, dot3(n, L1)), d2 = Math.max(0, dot3(n, L2));
        const vd = norm3(sub3(eye, pos));
        const hl = norm3([L1[0] + vd[0], L1[1] + vd[1], L1[2] + vd[2]]);
        const spec = (1 - rough) * 0.5 * Math.max(0, dot3(n, hl)) ** 30;
        const amb = 0.28 + 0.12 * n[1];
        const c = base.slice(0, 3).map(b => Math.min(1, toSRGB(Math.min(1, b * (amb + 0.95 * d1 + 0.3 * d2) + spec))));
        cache.set(v, c);
        return c;
      };
      const scr = v => { if (!sp.has(v)) sp.set(v, proj([geo.P[v * 3], geo.P[v * 3 + 1], geo.P[v * 3 + 2]])); return sp.get(v); };
      for (let i = 0; i < p.idx.length; i += 3) {
        const a = p.idx[i], b = p.idx[i + 1], c = p.idx[i + 2];
        tri(scr(a), scr(b), scr(c), col(a), col(b), col(c));
        if (p.mat.doubleSided) tri(scr(a), scr(c), scr(b), col(a), col(c), col(b));
      }
    }
  }
  return img;
}

// ---------------- PNG
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = b => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function png(file, img, W, H) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W * 3; x++) raw[y * (W * 3 + 1) + 1 + x] = Math.round(Math.min(1, Math.max(0, img[y * W * 3 + x])) * 255);
  const chunk = (type, data) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
    return Buffer.concat([l, td, c]);
  };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
function sheet(file, cells, cw, ch, cols) {
  const rows = Math.ceil(cells.length / cols), W = cw * cols, H = ch * rows;
  const img = new Float32Array(W * H * 3).fill(1);
  cells.forEach((c, i) => {
    const ox = (i % cols) * cw, oy = Math.floor(i / cols) * ch;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) for (let k = 0; k < 3; k++) img[((oy + y) * W + ox + x) * 3 + k] = c[(y * cw + x) * 3 + k];
  });
  png(join(outDir, file), img, W, H);
  console.log('wrote', file);
}

// ---------------- sheets
const look = over => ({ ...DEFAULT, ...over });
const dress = (a, clip = 'Idle', t = 0) => figure(partsFor(a), colorsFor(a), clip, t);
const FRONT = { eye: [-1.5, 1.3, 3.0], target: [0, 0.92, 0] };
const BACK = { eye: [1.2, 1.4, -3.0], target: [0, 0.92, 0] };
const SIDE = { eye: [-3.4, 1.1, 0.3], target: [0, 0.92, 0.1] };

if (want.includes('wardrobe')) {
  const cells = [];
  for (const gender of ['male', 'female']) {
    for (const shirtStyle of ['crew', 'vneck', 'polo', 'tank', 'raglan']) {
      cells.push(render(dress(look({ gender, shirtStyle, shirt: '#d64545', shirtAccent: '#1b1b1b' })), 220, 300, FRONT.eye, FRONT.target));
    }
    for (const shortsStyle of ['classic', 'long', 'compression', 'skort']) {
      cells.push(render(dress(look({ gender, shortsStyle, shortsColor: '#b9a27a', kneeGuard: shortsStyle === 'long' ? '#2f6fd6' : 'none', elbowGuard: shortsStyle === 'compression' ? '#c0392b' : 'none' })), 220, 300, FRONT.eye, FRONT.target));
    }
    cells.push(render(dress(look({ gender, shoes: 'neon' })), 220, 300, BACK.eye, BACK.target));
  }
  sheet('wardrobe.png', cells, 220, 300, 10);
  sheet('referee.png', [
    render(figure(REF, { hat: hexLin('#141414'), shoe: hexLin('#1e2026'), sole: hexLin('#1e2026'), shoeAccent: hexLin('#1e2026') }, 'RefSit', 0), 300, 340, [-1.6, 1.4, 2.6], [0, 0.95, 0.1]),
    render(figure(REF, { hat: hexLin('#141414') }, 'Idle', 0), 300, 340, [1.2, 1.4, 2.8], [0, 0.95, 0]),
  ], 300, 340, 2);
}
if (want.includes('heads')) {
  const cells = [];
  const H = (a, eye = [0.32, 1.7, 0.8]) => render(dress(look(a), 'TPose', 0), 200, 220, eye, [0, 1.66, 0], 20);
  for (const gender of ['male', 'female']) {
    for (const hair of ['short', 'buzz', 'curly', 'ponytail', 'bun', 'long', 'bald']) cells.push(H({ gender, hair, hairColor: '#8e4527' }, [0.55, 1.72, 0.55]));
    for (const headwear of ['cap', 'visor', 'headband']) cells.push(H({ gender, headwear, hatColor: '#c0392b' }));
  }
  for (const facial of ['stubble', 'mustache', 'beard']) cells.push(H({ facial, hairColor: '#1d1815' }, [0.12, 1.66, 0.75]));
  cells.push(H({ gender: 'female', hair: 'long' }, [-0.6, 1.66, -0.5]));
  sheet('heads.png', cells, 200, 220, 10);
}
if (want.includes('body')) { // physique check: front, side, back, idle + T-pose
  const a = look({ shirtStyle: 'tank', shortsStyle: 'compression' });
  const f = look({ gender: 'female', shirtStyle: 'tank', shortsStyle: 'compression', hair: 'ponytail' });
  sheet('body.png', [
    render(dress(a, 'Idle'), 280, 380, [0, 1.1, 3.6], [0, 0.92, 0]), render(dress(a, 'Idle'), 280, 380, [-3.6, 1.1, 0.2], [0, 0.92, 0]),
    render(dress(a, 'Idle'), 280, 380, [0.4, 1.3, -3.6], [0, 0.92, 0]), render(dress(f, 'Idle'), 280, 380, [0, 1.1, 3.6], [0, 0.92, 0]),
    render(dress(f, 'Idle'), 280, 380, [-3.6, 1.1, 0.2], [0, 0.92, 0]), render(dress(look({}), 'Idle'), 280, 380, [-1.6, 1.3, 3.0], [0, 0.92, 0]),
  ], 280, 380, 6);
}
const clipsWanted = want.includes('anim') ? G.animations.map(a => a.name).filter(n => n !== 'TPose') : want.filter(n => anims[n]);
for (const name of clipsWanted) {
  const tmax = anims[name].ch[0].t.at(-1);
  const K = 6, cells = [];
  const a = look({ headwear: 'cap' });
  for (const v of [FRONT, SIDE, BACK]) for (let k = 0; k < K; k++) cells.push(render(dress(a, name, (tmax * k) / K), 220, 300, v.eye, v.target));
  sheet(`${name}.png`, cells, 220, 300, K);
}
if (want.includes('torso')) { // close-up of the upper body (proportions, armholes, collars)
  const cells = [];
  for (const shirtStyle of ['tank', 'crew', 'polo', 'vneck']) {
    cells.push(render(dress(look({ shirtStyle, shirt: '#2f80ed', shirtAccent: '#f5f5f2' })), 300, 330, [-0.5, 1.35, 1.9], [0, 1.2, 0], 26));
  }
  cells.push(render(dress(look({ shirtStyle: 'tank' })), 300, 330, [0.6, 1.4, -1.9], [0, 1.2, 0], 26));
  cells.push(render(dress(look({ gender: 'female', shirtStyle: 'tank', hair: 'ponytail' })), 300, 330, [-0.5, 1.35, 1.9], [0, 1.2, 0], 26));
  sheet('torso.png', cells, 300, 330, 6);
}
if (want.includes('hairlong')) {
  const cells = [];
  for (const gender of ['female', 'male']) for (const eye of [[0.32, 1.7, 0.8], [0.9, 1.6, 0.1], [0.4, 1.65, -0.8]]) {
    cells.push(render(dress(look({ gender, hair: 'long', hairColor: '#6b4a31', shirtStyle: 'tank' }), 'Idle', 0), 240, 260, eye, [0, 1.6, 0], 26));
  }
  cells.push(render(dress(look({ gender: 'female', hair: 'short' }), 'TPose', 0), 240, 260, [0.12, 1.68, 0.6], [0, 1.665, 0], 16));
  cells.push(render(dress(look({ gender: 'female', headwear: 'visor', hatColor: '#c0392b', hair: 'ponytail' }), 'TPose', 0), 240, 260, [0.6, 1.7, 0.6], [0, 1.67, 0], 20));
  sheet('hairlong.png', cells, 240, 260, 4);
}
