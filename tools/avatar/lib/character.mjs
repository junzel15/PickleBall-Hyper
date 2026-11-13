// The modular player: every body part and wardrobe item is its own skinned mesh on the
// shared skeleton, so the game shows exactly the parts a player's avatar settings pick.
//
// Part names (one is shown per slot, see players3d.ts):
//   {g}.head                       head, face, neck              g = m (male) | f (female)
//   {g}.torso.{crew|vneck|polo|tank|raglan}
//   {g}.arms.{sleeve|raglan|polo|bare}
//   {g}.legs.{classic|long|compression|skort}   (with socks)
//   {g}.hair.{short|buzz|curly|ponytail|bun|long}   (bald = none)
//   {g}.knee[_pad|_strap], {g}.elbow[_pad|_strap]   guards
//   m.facial.{stubble|mustache|beard}
//   acc.*                          caps, visors, headbands, glasses (built on the male head and
//                                  fitted per head / hair volume at runtime), wristbands
//   hands, shoes                   shared (the right hand grips the paddle)
//   ref.torso, ref.arms, ref.legs  referee outfit (with m.head, m.hands, shoes, m.hat.cap)
import { B } from './rig.mjs';
import { add, mul, sub, norm, cross, lerp, smooth, gauss, qAxis, qRot, DEG } from './math.mjs';
import { MeshBuilder, loftRings, sampleKeys, sp, tube, ellipsoid, one } from './body.mjs';

// ================================================================ gender shapes
const TORSO = {
  m: [
    { s: 0.835, rx: 0.110, zf: 0.080, zb: 0.078, cz: 0.000, mat: 'shorts' },
    { s: 0.880, rx: 0.166, zf: 0.092, zb: 0.098, cz: -0.004, mat: 'shorts' },
    { s: 0.940, rx: 0.176, zf: 0.097, zb: 0.101, cz: -0.006, mat: 'shorts' },
    { s: 0.985, rx: 0.170, zf: 0.097, zb: 0.098, cz: -0.008, mat: 'shorts' },
    { s: 0.975, rx: 0.184, zf: 0.110, zb: 0.110, cz: -0.008, mat: 'shirt', brk: true, hemMat: 'shirt' },
    { s: 1.010, rx: 0.170, zf: 0.104, zb: 0.103, cz: -0.009, mat: 'shirt' },
    { s: 1.070, rx: 0.153, zf: 0.099, zb: 0.097, cz: -0.011, mat: 'shirt', groove: 0.004 },
    { s: 1.150, rx: 0.162, zf: 0.106, zb: 0.099, cz: -0.013, mat: 'shirt', groove: 0.006 },
    { s: 1.230, rx: 0.177, zf: 0.120, zb: 0.106, cz: -0.015, mat: 'shirt', groove: 0.007 },
    { s: 1.300, rx: 0.187, zf: 0.129, zb: 0.111, cz: -0.016, mat: 'shirt', groove: 0.007 },
    { s: 1.360, rx: 0.192, zf: 0.123, zb: 0.113, cz: -0.017, mat: 'shirt', groove: 0.006 },
    { s: 1.405, rx: 0.188, zf: 0.107, zb: 0.108, cz: -0.018, mat: 'shirt', groove: 0.004 },
    { s: 1.432, rx: 0.172, zf: 0.090, zb: 0.097, cz: -0.019, mat: 'shirt' },
    { s: 1.458, rx: 0.140, zf: 0.075, zb: 0.084, cz: -0.020, mat: 'shirt' },
    { s: 1.478, rx: 0.102, zf: 0.065, zb: 0.073, cz: -0.020, mat: 'shirt' },
  ],
  f: [
    { s: 0.835, rx: 0.114, zf: 0.082, zb: 0.082, cz: 0.000, mat: 'shorts' },
    { s: 0.880, rx: 0.180, zf: 0.094, zb: 0.104, cz: -0.005, mat: 'shorts' },
    { s: 0.940, rx: 0.188, zf: 0.098, zb: 0.108, cz: -0.010, mat: 'shorts' },
    { s: 0.985, rx: 0.176, zf: 0.097, zb: 0.102, cz: -0.009, mat: 'shorts' },
    { s: 0.975, rx: 0.192, zf: 0.110, zb: 0.116, cz: -0.010, mat: 'shirt', brk: true, hemMat: 'shirt' },
    { s: 1.010, rx: 0.176, zf: 0.100, zb: 0.110, cz: -0.010, mat: 'shirt' },
    { s: 1.070, rx: 0.140, zf: 0.090, zb: 0.095, cz: -0.012, mat: 'shirt', groove: 0.004 },
    { s: 1.150, rx: 0.142, zf: 0.094, zb: 0.094, cz: -0.014, mat: 'shirt', groove: 0.005 },
    { s: 1.230, rx: 0.150, zf: 0.104, zb: 0.098, cz: -0.016, mat: 'shirt', groove: 0.005 },
    { s: 1.300, rx: 0.158, zf: 0.108, zb: 0.100, cz: -0.017, mat: 'shirt', groove: 0.005 },
    { s: 1.360, rx: 0.164, zf: 0.104, zb: 0.102, cz: -0.018, mat: 'shirt', groove: 0.004 },
    { s: 1.405, rx: 0.165, zf: 0.094, zb: 0.098, cz: -0.019, mat: 'shirt', groove: 0.003 },
    { s: 1.432, rx: 0.150, zf: 0.080, zb: 0.088, cz: -0.020, mat: 'shirt' },
    { s: 1.458, rx: 0.118, zf: 0.066, zb: 0.074, cz: -0.020, mat: 'shirt' },
    { s: 1.478, rx: 0.088, zf: 0.058, zb: 0.066, cz: -0.020, mat: 'shirt' },
  ],
};
const G = {
  m: { arm: 1, leg: 1, calf: 1, neck: 1.1, bust: 0, headRx: 1, jaw: 1, lip: 1, brow: 1 },
  f: { arm: 0.9, leg: 0.97, calf: 0.92, neck: 0.92, bust: 0.034, headRx: 0.955, jaw: 0.9, lip: 1.3, brow: 0.7 },
};

// ================================================================ torso
function torsoW(p) {
  const y = p[1], ax = Math.abs(p[0]);
  const side = p[0] >= 0 ? 'Left' : 'Right';
  const f1 = smooth(1.0, 1.1, y), f2 = smooth(1.12, 1.22, y), f3 = smooth(1.24, 1.32, y);
  const w = { [B.Hips]: 1 - f1, [B.Spine]: f1 * (1 - f2), [B.Spine1]: f2 * (1 - f3), [B.Spine2]: f3 };
  const sh = smooth(0.1, 0.18, ax) * smooth(1.33, 1.42, y) * 0.45;
  const arm = smooth(0.14, 0.19, ax) * smooth(1.34, 1.42, y) * 0.3;
  const leg = smooth(0.96, 0.84, y) * smooth(0.03, 0.13, ax) * 0.45;
  const neck = smooth(1.45, 1.49, y) * (1 - smooth(0.05, 0.09, ax)) * 0.5;
  const keep = 1 - sh - arm - leg - neck;
  for (const k of Object.keys(w)) w[k] *= keep;
  w[B[`${side}Shoulder`]] = (w[B[`${side}Shoulder`]] || 0) + sh;
  w[B[`${side}Arm`]] = (w[B[`${side}Arm`]] || 0) + arm;
  w[B[`${side}UpLeg`]] = (w[B[`${side}UpLeg`]] || 0) + leg;
  w[B.Neck] = (w[B.Neck] || 0) + neck;
  return w;
}

/** Torso surface helper (front z at a given x, y), used to place collars and plackets. */
function torsoModel(g) {
  const dense = sampleKeys(TORSO[g].filter(k => k.mat === 'shirt' && !k.brk), 4, { groove: 0 });
  const props = y => {
    if (y <= dense[0].s) return dense[0];
    for (let i = 0; i < dense.length - 1; i++) {
      if (y <= dense[i + 1].s) {
        const t = (y - dense[i].s) / (dense[i + 1].s - dense[i].s);
        const o = {};
        for (const k of ['rx', 'zf', 'zb', 'cz']) o[k] = lerp(dense[i][k], dense[i + 1][k], t);
        return o;
      }
    }
    return dense[dense.length - 1];
  };
  return {
    frontZ: (x, y) => {
      const k = props(y);
      const u = Math.min(0.999, Math.abs(x) / k.rx);
      return k.cz + k.zf * (1 - u ** 2.6) ** (1 / 2.5) + bustAt(g, x, y);
    },
  };
}
const bustAt = (g, x, y) => (g === 'f'
  ? G[g].bust * (gauss(x - 0.085, y - 1.27, 0.052, 0.046) + gauss(x + 0.085, y - 1.27, 0.052, 0.046))
  : 0.009 * (gauss(x - 0.072, y - 1.315, 0.055, 0.038) + gauss(x + 0.072, y - 1.315, 0.055, 0.038))); // pecs

const REF_STRIPE = 0.045;
function torso(g, style) {
  const mb = new MeshBuilder();
  // styles whose edges are painted on the surface get a finer mesh, so the edges are smooth curves
  const fine = style === 'tank' || style === 'vneck' || style === 'raglan' || style === 'sleeveless';
  const SEG = fine ? 64 : 40;
  const dense = sampleKeys(TORSO[g], fine ? 6 : 4, { groove: 0 });
  const rings = dense.map(k => {
    const pts = [];
    for (let j = 0; j < SEG; j++) {
      const th = (j / SEG) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      let a = c >= 0 ? sp(c, 2.5) * k.zf : sp(c, 2.3) * k.zb;
      if (c < 0) a += k.groove * Math.exp(-((s / 0.18) ** 2));
      const x = sp(s, 2.6) * k.rx;
      if (c > 0 && k.mat === 'shirt') a += bustAt(g, x, k.s) * c ** 1.5;
      pts.push([x, k.s, k.cz + a]); // U = +Z (front), V = +X: rings advance up
    }
    return { pts, mat: k.mat, brk: k.brk, hemMat: k.hemMat, w: torsoW };
  });
  // shirt-style details painted onto the torso surface
  const front = c => c[2] > 0;
  const triMat = (c, m) => {
    if (style === 'ref' && m === 'shorts') return 'pants';
    if (m !== 'shirt') return m;
    const ax = Math.abs(c[0]), y = c[1];
    if (style === 'vneck' && front(c) && y > 1.372 + 1.45 * ax) return 'skin';
    if (style === 'tank') {
      if (((ax - 0.215) / 0.1) ** 2 + ((y - 1.43) / 0.105) ** 2 < 1) return 'skin';     // oval arm holes
      if (front(c) && ((ax / 0.078) ** 2 + ((y - 1.49) / 0.075) ** 2 < 1)) return 'skin'; // scoop neck
    }
    if (style === 'raglan' && y > 1.31 && ax > 0.075 + (1.475 - y) * 0.62) return 'shirtAccent';
    if (style === 'pro' && y > 0.98 && y < 1.37 && ax > 0.118 && Math.abs(c[2] + 0.012) < 0.078) return 'shirtAccent'; // side panels
    if (style === 'stripe' && y > 1.222 && y < 1.268) return 'shirtAccent';                                            // chest band
    if (style === 'sleeveless' && ((ax - 0.22) / 0.085) ** 2 + ((y - 1.44) / 0.1) ** 2 < 1) return 'skin';          // cut-away shoulders
    if (style === 'ref') return Math.floor((c[0] + 1) / REF_STRIPE) % 2 ? 'refBlack' : 'refWhite';
    return m;
  };
  const top = dense[dense.length - 1];
  loftRings(mb, rings, { capStart: [0, 0.83, 0], capEnd: [0, top.s + 0.004, top.cz], triMat, capEndMat: style === 'ref' ? 'refBlack' : 'shirt' });

  const tm = torsoModel(g);
  const neckLoop = (y0, rx, rz, cz, n = 28) => Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return [Math.sin(t) * rx, y0 + 0.006 * Math.cos(t), cz + Math.cos(t) * rz];
  });
  const collarMat = style === 'ref' ? 'refBlack' : 'shirtAccent';
  if (style === 'crew' || style === 'raglan' || style === 'ref' || style === 'pro' || style === 'stripe' || style === 'sleeveless') {
    const loop = neckLoop(1.479, 0.074 * G[g].neck + 0.008, 0.066 * G[g].neck + 0.006, -0.018);
    tube(mb, loop, loop.map(() => 0.0065), loop.map(() => 0.0065), collarMat, torsoW, { closed: true, seg: 8 });
  }
  if (style === 'vneck') { // trim along the V
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const u = -1 + (2 * i) / 24;
      const ax = Math.abs(u) * 0.072;
      const y = 1.372 + 1.45 * ax;
      pts.push([Math.sign(u) * ax, y, tm.frontZ(ax, y) + 0.002]);
    }
    tube(mb, pts, pts.map(() => 0.005), pts.map(() => 0.005), 'shirtAccent', torsoW, { seg: 8, ref: [0, 0, 1] });
    // back of the neckline
    const back = neckLoop(1.479, 0.08 * G[g].neck, 0.07 * G[g].neck, -0.018).filter(p => p[2] < -0.02);
    tube(mb, back, back.map(() => 0.005), back.map(() => 0.005), 'shirtAccent', torsoW, { seg: 8 });
  }
  if (style === 'polo') {
    // folded collar: stands up from the neckline then folds down over it (open at the front)
    const SEGC = 30;
    const r0x = 0.072 * G[g].neck + 0.012, r0z = 0.064 * G[g].neck + 0.012;
    const prof = [[0, 1.470], [0.004, 1.506], [0.030, 1.492], [0.052, 1.462]];
    const cRings = prof.map(([dr, y]) => {
      const pts = [];
      for (let j = 0; j <= SEGC; j++) {
        const t = (0.17 + (j / SEGC) * (2 - 0.34)) * Math.PI; // leave a gap at the front
        pts.push([Math.sin(t) * (r0x + dr), y, -0.018 + Math.cos(t) * (r0z + dr)]);
      }
      return { pts, mat: 'shirtAccent', w: torsoW };
    });
    loftRings(mb, cRings, { open: true });
    loftRings(mb, [...cRings].reverse(), { open: true }); // inside of the collar
    // placket with two buttons
    const yA = 1.395, yB = 1.47;
    const pl = [];
    for (let i = 0; i <= 6; i++) { const y = lerp(yA, yB, i / 6); pl.push([0, y, tm.frontZ(0, y) + 0.001]); }
    tube(mb, pl, pl.map(() => 0.0035), pl.map(() => 0.014), 'shirtAccent', torsoW, { seg: 8, ref: [0, 0, 1] });
    for (const y of [1.418, 1.448]) ellipsoid(mb, [0, y, tm.frontZ(0, y) + 0.0045], [0.0045, 0.0045, 0.0022], 'button', torsoW, { seg: 10, rings: 5 });
  }
  return mb;
}

// ================================================================ head, face, neck
const HEAD_KEYS = [
  { s: 1.548, rx: 0.022, zf: 0.090, zb: 0.055 },
  { s: 1.560, rx: 0.042, zf: 0.098, zb: 0.030 },
  { s: 1.578, rx: 0.058, zf: 0.101, zb: -0.005 },
  { s: 1.600, rx: 0.066, zf: 0.104, zb: -0.045 },
  { s: 1.625, rx: 0.071, zf: 0.108, zb: -0.072 },
  { s: 1.650, rx: 0.075, zf: 0.106, zb: -0.090 },
  { s: 1.675, rx: 0.077, zf: 0.102, zb: -0.099 },
  { s: 1.700, rx: 0.077, zf: 0.097, zb: -0.101 },
  { s: 1.722, rx: 0.073, zf: 0.088, zb: -0.097 },
  { s: 1.742, rx: 0.063, zf: 0.070, zb: -0.086 },
  { s: 1.760, rx: 0.046, zf: 0.046, zb: -0.064 },
  { s: 1.771, rx: 0.025, zf: 0.022, zb: -0.035 },
];
const HEAD_CENTRE = [0, 1.665, -0.005];
const HEAD_TOP = 1.7705;

function headModel(g) {
  const k = G[g];
  const keys = HEAD_KEYS.map(h => {
    const jaw = lerp(k.jaw, 1, smooth(1.585, 1.64, h.s));
    return { ...h, rx: h.rx * k.headRx * jaw, zf: h.s < 1.585 ? h.zf * (g === 'f' ? 0.985 : 1) : h.zf };
  });
  const D = sampleKeys(keys, 6);
  const props = y => {
    if (y <= D[0].s) return D[0];
    for (let i = 0; i < D.length - 1; i++) {
      if (y <= D[i + 1].s) {
        const t = (y - D[i].s) / (D[i + 1].s - D[i].s);
        return { s: y, rx: lerp(D[i].rx, D[i + 1].rx, t), zf: lerp(D[i].zf, D[i + 1].zf, t), zb: lerp(D[i].zb, D[i + 1].zb, t) };
      }
    }
    return D[D.length - 1];
  };
  const relief = (x, y) => {
    let d = 0;
    for (const s of [1, -1]) {
      d -= 0.0075 * gauss(x - s * 0.032, y - 1.668, 0.014, 0.0095); // eye sockets
      d += 0.0035 * gauss(x - s * 0.030, y - 1.689, 0.022, 0.0055) * k.brow; // brow ridge
      d += 0.0045 * gauss(x - s * 0.050, y - 1.643, 0.014, 0.012); // cheekbones
      d -= 0.0025 * gauss(x - s * 0.027, y - 1.594, 0.006, 0.006); // mouth corners
      d += 0.002 * gauss(x - s * 0.04, y - 1.575, 0.012, 0.01) * k.jaw; // jaw line
    }
    d += 0.004 * gauss(x, y - 1.566, 0.014, 0.009) * k.jaw; // chin
    d -= 0.002 * gauss(x, y - 1.606, 0.004, 0.005); // philtrum
    return d;
  };
  const pt = (th, y) => {
    const p = props(y);
    const cz = (p.zf + p.zb) / 2, rz = (p.zf - p.zb) / 2;
    const c = Math.cos(th), s = Math.sin(th);
    const x = sp(s, c > 0 ? 2.5 : 2.1) * p.rx;
    let z = cz + (c >= 0 ? sp(c, 2.6) : sp(c, 2.1)) * rz;
    if (c > 0) z += relief(x, y) * smooth(0.2, 0.6, c);
    return [x, y, z];
  };
  const faceZ = (x, y) => {
    const p = props(y);
    const cz = (p.zf + p.zb) / 2, rz = (p.zf - p.zb) / 2;
    const u = Math.min(1, Math.abs(x) / p.rx);
    return cz + rz * (1 - u ** 2.5) ** (1 / 2.5) + relief(x, y);
  };
  /** A point `off` metres out from the scalp, along the direction from the head centre. */
  const out = (th, y, off) => {
    const p = pt(th, y);
    return add(p, mul(norm(sub(p, HEAD_CENTRE)), off));
  };
  return { D, props, pt, faceZ, out };
}

const headW = p => {
  const n = p[1] < 1.6 && p[2] < 0.02 ? 0.5 * smooth(1.61, 1.565, p[1]) : 0;
  return { [B.Head]: 1 - n, [B.Neck]: n };
};

function head(g) {
  const mb = new MeshBuilder();
  const hm = headModel(g);
  const k = G[g];
  // neck
  const nk = [
    { s: 1.43, rx: 0.068, rz: 0.066, cz: -0.022 },
    { s: 1.49, rx: 0.058, rz: 0.058, cz: -0.020 },
    { s: 1.55, rx: 0.054, rz: 0.057, cz: -0.014 },
    { s: 1.60, rx: 0.056, rz: 0.058, cz: -0.006 },
    { s: 1.64, rx: 0.048, rz: 0.050, cz: 0.004 },
  ];
  const nW = p => {
    const a = smooth(1.45, 1.51, p[1]), b = smooth(1.57, 1.62, p[1]);
    return { [B.Spine2]: 1 - a, [B.Neck]: a * (1 - b), [B.Head]: b };
  };
  loftRings(mb, sampleKeys(nk, 3).map(n => ({
    pts: Array.from({ length: 24 }, (_, j) => {
      const th = (j / 24) * Math.PI * 2;
      return [Math.sin(th) * n.rx * k.neck, n.s, n.cz + Math.cos(th) * n.rz * k.neck];
    }), mat: 'skin', w: nW,
  })), { capStart: [0, 1.43, -0.022], capEnd: [0, 1.64, 0.004] });
  // skull and face
  const SEG = 40;
  const rings = hm.D.map(d => ({ pts: Array.from({ length: SEG }, (_, j) => hm.pt((j / SEG) * Math.PI * 2, d.s)), mat: 'skin', w: headW }));
  const k0 = hm.D[0];
  loftRings(mb, rings, { capStart: [0, k0.s - 0.003, (k0.zf + k0.zb) / 2], capEnd: [0, 1.7765, -0.006] });
  // eyes, lids, brows, ears, nose, lips
  for (const s of [1, -1]) {
    const ex = s * 0.032, ey = 1.667;
    const ez = hm.faceZ(ex, ey) - 0.0045;
    ellipsoid(mb, [ex, ey, ez], [0.0122, 0.0122, 0.0122], 'eyeWhite', one('Head'), { seg: 16, rings: 10 });
    ellipsoid(mb, [ex, ey, ez + 0.0083], [0.0062, 0.0042, 0.0062], 'iris', one('Head'), { seg: 14, rings: 6, rot: qAxis([1, 0, 0], Math.PI / 2) });
    ellipsoid(mb, [ex, ey, ez + 0.0106], [0.0027, 0.0018, 0.0027], 'pupil', one('Head'), { seg: 10, rings: 4, rot: qAxis([1, 0, 0], Math.PI / 2) });
    ellipsoid(mb, [ex, ey + 0.0006, ez], [0.0135, 0.0132, 0.0137], 'skin', one('Head'), { seg: 16, rings: 6, phiMax: 0.335 * Math.PI, rot: qAxis([1, 0, 0], 0.25) });
    ellipsoid(mb, [ex, ey - 0.0004, ez], [0.0132, 0.013, 0.0134], 'skin', one('Head'), { seg: 16, rings: 5, phiMax: 0.235 * Math.PI, rot: qAxis([1, 0, 0], Math.PI - 0.5) });
    if (g === 'f') { // lash line
      ellipsoid(mb, [ex, ey + 0.0006, ez], [0.0133, 0.013, 0.0135], 'brow', one('Head'), { seg: 16, rings: 8, phiMax: 0.36 * Math.PI, rot: qAxis([1, 0, 0], 0.25) });
    }
    const by = 1.6885 + (g === 'f' ? 0.002 : 0);
    ellipsoid(mb, [s * 0.034, by, hm.faceZ(s * 0.034, by) - 0.001], [0.019, 0.0034 * k.brow, 0.0045], 'brow', one('Head'), { seg: 12, rings: 6, rot: qAxis([0, 0, 1], s * (g === 'f' ? -0.16 : -0.1)) });
    ellipsoid(mb, [s * 0.0765 * k.headRx, 1.655, -0.012], [0.0095, 0.031 * (g === 'f' ? 0.92 : 1), 0.019], 'skin', one('Head'), { seg: 14, rings: 10, rot: qAxis([0, 1, 0], s * -0.35) });
    ellipsoid(mb, [s * 0.0835 * k.headRx, 1.657, -0.010], [0.0035, 0.022, 0.012], 'skin', one('Head'), { seg: 10, rings: 8, rot: qAxis([0, 1, 0], s * -0.35) });
    ellipsoid(mb, [s * 0.0105, 1.6225, hm.faceZ(s * 0.0105, 1.6225) + 0.0025], [0.0066 * (g === 'f' ? 0.9 : 1), 0.0058, 0.0072], 'skin', one('Head'), { seg: 12, rings: 8 });
  }
  const nf = g === 'f' ? 0.88 : 1;
  const nosePath = [[0, 1.684, 0.0915], [0, 1.663, 0.1005], [0, 1.644, 0.1095 - (1 - nf) * 0.02], [0, 1.629, 0.1155 - (1 - nf) * 0.03], [0, 1.6185, 0.1105 - (1 - nf) * 0.02]];
  tube(mb, nosePath, [0.005, 0.0062, 0.0074, 0.0086, 0.0066].map(r => r * nf), [0.0068, 0.0072, 0.0078, 0.0088, 0.0094].map(r => r * nf), 'skin', one('Head'), { seg: 14, ref: [0, 0, 1] });
  ellipsoid(mb, [0, 1.5995, hm.faceZ(0, 1.5995) - 0.004], [0.0235, 0.0052 * k.lip, 0.0085], 'lips', one('Head'), { seg: 16, rings: 8 });
  ellipsoid(mb, [0, 1.5895, hm.faceZ(0, 1.5895) - 0.0045], [0.021, 0.0062 * k.lip, 0.0085], 'lips', one('Head'), { seg: 16, rings: 8 });
  return mb;
}

// ================================================================ hair, hats, facial hair
/**
 * A shell over the scalp: rows from the hairline (per angle) up to the crown, pushed out by
 * thick(v, c, th). Angles run round the head (cos > 0 = front).
 */
function scalpShell(mb, hm, { hairline, thick, mat = 'hair', w = one('Head'), top = HEAD_TOP, rows = 16, seg = 40, capOff = null, triMat = undefined }) {
  const rings = [];
  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    const pts = [];
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      const hl = hairline(th);
      const y = hl + (top - hl) * (1 - (1 - v) ** 1.3);
      pts.push(hm.out(th, y, thick(v, Math.cos(th), th, y)));
    }
    rings.push({ pts, mat, w });
  }
  const off = capOff == null ? thick(1, 1, 0, top) : capOff;
  loftRings(mb, rings, { capEnd: [0, 1.7765 + off, -0.008], triMat });
}
const baseHairline = th => {
  const c = Math.cos(th);
  let h = c > 0 ? lerp(1.688, 1.716, c ** 1.4) : lerp(1.688, 1.592, smooth(0, 0.65, -c));
  h += 0.006 * Math.exp(-(((c - 0.72) / 0.1) ** 2));
  h -= 0.02 * Math.exp(-(((c - 0.2) / 0.09) ** 2));
  return h;
};

function hair(g, style) {
  const mb = new MeshBuilder();
  const hm = headModel(g);
  const fem = g === 'f';
  const hl = fem ? th => baseHairline(th) - 0.004 * Math.max(0, Math.cos(th)) : baseHairline;
  if (style === 'short') {
    scalpShell(mb, hm, { hairline: hl, thick: (v, c) => 0.0012 + 0.0105 * smooth(0, 0.35, v) + 0.0045 * Math.max(0, c) * smooth(0.25, 0.8, v) });
  } else if (style === 'buzz') {
    scalpShell(mb, hm, { hairline: th => baseHairline(th) + 0.002, thick: v => 0.0008 + 0.0022 * smooth(0, 0.2, v) });
  } else if (style === 'curly') {
    const bump = th => 0.5 + 0.25 * Math.sin(th * 9) + 0.25 * Math.sin(th * 14 + 1.3);
    scalpShell(mb, hm, {
      hairline: th => hl(th) - 0.006,
      thick: (v, c, th, y) => 0.002 + smooth(0, 0.3, v) * (0.014 + 0.007 * bump(th) * (0.6 + 0.4 * Math.sin(y * 260))),
      rows: 20, seg: 56,
    });
  } else if (style === 'ponytail' || style === 'bun') {
    scalpShell(mb, hm, { hairline: hl, thick: v => 0.0012 + 0.0062 * smooth(0, 0.3, v) });
    if (style === 'ponytail') {
      const path = [[0, 1.678, -0.098], [0, 1.664, -0.121], [0, 1.636, -0.134], [0, 1.598, -0.135], [0, 1.56, -0.128], [0, 1.525, -0.118], [0, 1.50, -0.111]];
      tube(mb, path, [0.017, 0.02, 0.019, 0.017, 0.014, 0.011, 0.007], [0.019, 0.022, 0.021, 0.019, 0.016, 0.012, 0.008], 'hair', one('Head'), { seg: 12, ref: [1, 0, 0] });
      ellipsoid(mb, [0, 1.676, -0.104], [0.016, 0.009, 0.014], 'hat', one('Head'), { seg: 12, rings: 6, rot: qAxis([1, 0, 0], 0.9) });
    } else {
      ellipsoid(mb, [0, 1.738, -0.084], [0.037, 0.031, 0.034], 'hair', one('Head'), { seg: 18, rings: 12, rot: qAxis([1, 0, 0], -0.5) });
      ellipsoid(mb, [0, 1.722, -0.066], [0.024, 0.008, 0.022], 'hat', one('Head'), { seg: 12, rings: 6, rot: qAxis([1, 0, 0], -0.5) });
    }
  } else if (style === 'long') {
    scalpShell(mb, hm, { hairline: hl, thick: (v, c) => 0.0018 + 0.0125 * smooth(0, 0.35, v) + 0.003 * Math.max(0, c) * v });
    // the length: hair falls from the crown round the sides and back to the shoulders
    const rows = 14, segC = 36;
    const curtain = [];
    const endY = fem ? 1.43 : 1.47;
    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      const y = lerp(1.748, endY, v ** 0.9);
      const pts = [];
      for (let j = 0; j <= segC; j++) {
        const u = j / segC;
        const th = (0.36 + u * 1.28) * Math.PI;           // from behind the right ear round to the left
        const edge = smooth(0, 0.12, u) * smooth(1, 0.88, u); // thin, tapered strands at the front edges
        const onHead = hm.out(th, Math.max(y, 1.585), 0.004 + 0.014 * edge);
        // below the skull the hair drapes round the neck and over the upper back
        const low = smooth(1.62, 1.5, y);
        const nx = Math.sin(th) * (0.075 + 0.045 * smooth(1.58, endY, y)) * (0.6 + 0.4 * edge);
        const nz = -0.03 + Math.cos(th) * (0.1 + 0.03 * smooth(1.58, endY, y));
        const p = [lerp(onHead[0], nx, low), y, lerp(onHead[2], Math.min(nz, onHead[2]), low)];
        pts.push(p);
      }
      // points reversed so the normals face outward
      curtain.push({ pts: pts.reverse(), mat: 'hair', w: p => { const t = smooth(1.6, 1.45, p[1]) * 0.6; return { [B.Head]: 1 - t, [B.Spine2]: t }; } });
    }
    loftRings(mb, curtain, { open: true });
  }
  return mb;
}

/** Caps, visors and headbands, built on the male head over short hair (fitted at runtime). */
function headwear(kind) {
  const mb = new MeshBuilder();
  const hm = headModel('m');
  const band = th => 1.697 + 0.013 * Math.max(0, Math.cos(th)) - 0.004 * Math.max(0, -Math.cos(th));
  const OFF = 0.021;
  if (kind.startsWith('cap')) {
    const crown = kind === 'cap_flat' ? 0.012 : 0.006; // flat-brim caps have a taller, structured crown
    const triMat = kind === 'cap_trucker' ? (c, m) => (c[2] < -0.012 && c[1] < 1.775 ? 'hatTrim' : m) : undefined; // mesh back
    scalpShell(mb, hm, { hairline: band, thick: v => OFF + crown * v, mat: 'hat', rows: 12, triMat });
    bandStrip(mb, hm, band, 0, 0.006, OFF - 0.003, 'hat');
    ellipsoid(mb, [0, 1.7765 + OFF + crown + 0.002, -0.01], [0.009, 0.005, 0.009], kind === 'cap_trucker' ? 'hat' : 'hatTrim', one('Head'), { seg: 10, rings: 5 });
    if (kind === 'cap_flat') brim(mb, hm, band, OFF, 0.082, 'hat', { flat: true });
    else brim(mb, hm, band, OFF, 0.072, 'hat');
  } else if (kind.startsWith('visor')) {
    const h = kind === 'visor_wide' ? 0.046 : kind === 'visor_pro' ? 0.024 : 0.034;
    const len = kind === 'visor_wide' ? 0.078 : kind === 'visor_pro' ? 0.088 : 0.068;
    bandStrip(mb, hm, band, 0, h, 0.019, 'hat');
    brim(mb, hm, band, 0.019, len, 'hat', { curve: kind === 'visor_pro' ? 1.7 : 1 });
  } else {
    const hb = th => 1.708 + 0.01 * Math.max(0, Math.cos(th)) - 0.006 * Math.max(0, -Math.cos(th));
    if (kind === 'band') bandStrip(mb, hm, hb, 0, 0.028, 0.018, 'band');
    if (kind === 'band_thin') bandStrip(mb, hm, hb, 0.007, 0.02, 0.017, 'band');
    if (kind === 'band_tie') {
      bandStrip(mb, hm, hb, 0.002, 0.024, 0.017, 'band');
      for (const S of [1, -1]) { // the two tails, hanging from the knot at the back
        const path = [[S * 0.008, 1.708, -0.119], [S * 0.02, 1.688, -0.131], [S * 0.03, 1.66, -0.139], [S * 0.036, 1.628, -0.142]];
        tube(mb, path, path.map(() => 0.0024), path.map((_, i) => 0.0085 - i * 0.0006), 'band', one('Head'), { seg: 8, ref: [0, 0, 1] });
      }
      ellipsoid(mb, [0, 1.71, -0.115], [0.011, 0.009, 0.007], 'band', one('Head'), { seg: 10, rings: 6 });
    }
  }
  return mb;
}

/** Sports glasses on the male head (fitted at runtime): lenses clear the brows and the nose. */
function glasses(kind) {
  const mb = new MeshBuilder();
  const w = one('Head');
  const frame = 'frame';
  const temples = (x0, y0, z0) => {
    for (const S of [1, -1]) {
      const path = [[S * x0, y0, z0], [S * 0.083, 1.68, 0.035], [S * 0.082, 1.69, -0.008], [S * 0.079, 1.683, -0.036]];
      tube(mb, path, path.map(() => 0.0026), path.map(() => 0.0034), frame, w, { seg: 8 });
    }
  };
  if (kind === 'sport' || kind === 'mirror') {
    const H = kind === 'mirror' ? 0.024 : 0.018;
    const lens = kind === 'mirror' ? 'lensMirror' : 'lens';
    const n = 24, m = 6, T = 0.0028;
    const at = (u, v, dz) => {
      const notch = 1 - 0.6 * Math.exp(-((u / 0.2) ** 2)) * (v < 0 ? 1 : 0); // lift the lower edge over the nose
      const x = u * 0.076, y = 1.668 + v * H * (1 - 0.3 * u * u) * notch;
      return [x, y, 0.114 - 0.03 * u * u - 0.012 * u ** 4 + dz];
    };
    const surf = dz => Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => at(-1 + (2 * j) / n, -1 + (2 * i) / m, dz)));
    const front = surf(T / 2), back = surf(-T / 2);
    loftRings(mb, front.map(pts => ({ pts, mat: lens, w })), { open: true });
    loftRings(mb, back.map(pts => ({ pts: [...pts].reverse(), mat: lens, w })), { open: true });
    const topEdge = front[m].map((_, j) => at(-1 + (2 * j) / n, 1.05, 0));
    tube(mb, topEdge, topEdge.map(() => 0.0024), topEdge.map(() => 0.003), frame, w, { seg: 8 });
    temples(0.075, 1.674, 0.083);
  } else {
    const centres = [0.033, -0.033];
    for (const cx of centres) {
      const S = Math.sign(cx);
      const loop = [];
      for (let i = 0; i < 28; i++) {
        const t = (i / 28) * Math.PI * 2;
        const rx = kind === 'round' ? 0.021 : 0.025, ry = kind === 'round' ? 0.021 : 0.016;
        const c = Math.cos(t), sn = Math.sin(t);
        const sq = kind === 'round' ? 1 : 0.35; // rectangular frames for the clear sport glasses
        const px = Math.sign(c) * Math.abs(c) ** sq, py = Math.sign(sn) * Math.abs(sn) ** sq;
        loop.push([cx + px * rx, 1.667 + py * ry, 0.108 - 0.012 * Math.abs(cx + px * rx) ** 2 * 40]);
      }
      tube(mb, loop, loop.map(() => 0.0027), loop.map(() => (kind === 'clear' ? 0.0036 : 0.0028)), frame, w, { closed: true, seg: 8 });
      if (kind === 'round') ellipsoid(mb, [cx, 1.667, 0.1075], [0.02, 0.02, 0.0022], 'lens', w, { seg: 20, rings: 6, rot: qAxis([1, 0, 0], Math.PI / 2) });
      void S;
    }
    const bridge = [[0.012, 1.671, 0.109], [0, 1.676, 0.111], [-0.012, 1.671, 0.109]];
    tube(mb, bridge, bridge.map(() => 0.0024), bridge.map(() => 0.0024), frame, w, { seg: 8 });
    temples(kind === 'round' ? 0.054 : 0.058, 1.669, 0.1);
  }
  return mb;
}

/** Wristbands round the wrists (skinned like the forearm/hand there). */
function wristband(S, from, to) {
  const mb = new MeshBuilder();
  const side = S > 0 ? 'Left' : 'Right';
  const radAt = x => { // the arm's skin radii at x
    const K = SKIN_ARM;
    for (let i = 0; i < K.length - 1; i++) if (x <= K[i + 1].s) { const t = (x - K[i].s) / (K[i + 1].s - K[i].s); return [lerp(K[i].ry, K[i + 1].ry, t), lerp(K[i].rz, K[i + 1].rz, t)]; }
    return [K[K.length - 1].ry, K[K.length - 1].rz];
  };
  const keys = [[from, 0.003], [from + 0.006, 0.0075], [to - 0.006, 0.0075], [to, 0.003]];
  const rings = keys.map(([x, off]) => {
    const [ry, rz] = radAt(x);
    return {
      pts: Array.from({ length: 24 }, (_, j) => {
        const th = (j / 24) * Math.PI * 2;
        return [S * x, 1.44 + Math.cos(th) * (ry + off), -0.02 + S * Math.sin(th) * (rz + off)];
      }), mat: 'band', w: armW(side),
    };
  });
  loftRings(mb, rings);
  return mb;
}

/** A band round the head between heights b(th)+y0 and b(th)+y1, `off` out from the scalp (both sides). */
function bandStrip(mb, hm, b, y0, y1, off, mat) {
  const seg = 48;
  const ring = (dy, o) => ({ pts: Array.from({ length: seg }, (_, j) => { const th = (j / seg) * Math.PI * 2; return hm.out(th, b(th) + dy, o); }), mat, w: one('Head') });
  loftRings(mb, [ring(y0, off), ring(y1, off)]);
  loftRings(mb, [ring(y1, off - 0.003), ring(y0, off - 0.003)]);
  loftRings(mb, [ring(y0, off - 0.003), ring(y0, off)]);
  loftRings(mb, [ring(y1, off), ring(y1, off - 0.003)]);
}
/** A curved brim sticking out over the forehead (top, underside and rim). */
function brim(mb, hm, b, off, len, mat, opts = {}) {
  const n = 22, m = 6, T = 0.0035;
  const w = one('Head');
  const surf = dy => Array.from({ length: m + 1 }, (_, i) => {
    const v = i / m;
    return Array.from({ length: n + 1 }, (_, j) => {
      const u = -1 + (2 * j) / n;
      const th = u * 1.2;
      const base = hm.out(th, b(th), off - 0.002);
      const reach = len * Math.max(0, 1 - u * u) ** (opts.flat ? 0.32 : 0.5) * 0.92 + 0.006;
      const p = add(base, mul(norm([Math.sin(th) * 0.55, 0, Math.cos(th)]), reach * v));
      const k = opts.curve || 1;
      p[1] += opts.flat ? -0.003 * v + dy : -0.012 * k * v * v - 0.004 * v + dy; // flat brims stay straight
      return p;
    });
  });
  const top = surf(T / 2), bot = surf(-T / 2);
  loftRings(mb, top.map(pts => ({ pts: [...pts].reverse(), mat, w })), { open: true }); // faces up
  loftRings(mb, bot.map(pts => ({ pts, mat, w })), { open: true });                    // faces down
  loftRings(mb, [{ pts: bot[m], mat, w }, { pts: top[m], mat, w }], { open: true });   // rim
}

function facial(style) {
  const mb = new MeshBuilder();
  const hm = headModel('m');
  const mouth = c => Math.abs(c[0]) < 0.03 && c[1] > 1.582 && c[1] < 1.609 && c[2] > 0.06;
  const region = (topY, off, mat) => {
    const rows = 10, seg = 40;
    const rings = [];
    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      const pts = [];
      for (let j = 0; j <= seg; j++) {
        const th = (-0.62 + (j / seg) * 1.24) * Math.PI; // the front and sides of the jaw
        const y = lerp(1.549, topY(th), v);
        pts.push(hm.out(th, y, off(v, th)));
      }
      rings.push({ pts, mat, w: headW });
    }
    loftRings(mb, rings, { open: true, triMat: (c, m) => (mouth(c) ? null : m) });
  };
  const sideTop = th => { const s = Math.abs(Math.sin(th)); return lerp(1.612, 1.652, smooth(0.35, 0.95, s)); };
  if (style === 'stubble') region(sideTop, () => 0.0011, 'stubble');
  if (style === 'beard') region(sideTop, (v, th) => 0.0045 + 0.004 * (1 - v) * Math.cos(th) ** 2, 'brow');
  if (style === 'mustache' || style === 'beard') {
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const u = -1 + (2 * i) / 12;
      const x = u * 0.027, y = 1.6055 - 0.006 * u * u;
      pts.push([x, y, hm.faceZ(x, y) + 0.003]);
    }
    tube(mb, pts, pts.map((_, i) => 0.0034 * (1 - 0.5 * Math.abs(-1 + (2 * i) / 12))), pts.map((_, i) => 0.0052 * (1 - 0.45 * Math.abs(-1 + (2 * i) / 12))), 'brow', one('Head'), { seg: 10, ref: [0, 0, 1] });
  }
  return mb;
}

// ================================================================ arms + hands
function armW(side) {
  return p => {
    const s = Math.abs(p[0]);
    const fA = smooth(0.12, 0.2, s), fF = smooth(0.41, 0.5, s), fT = smooth(0.5, 0.7, s), fH = smooth(0.695, 0.73, s);
    const sp2 = 0.2 * (1 - smooth(0.13, 0.16, s));
    return {
      [B.Spine2]: sp2,
      [B[`${side}Shoulder`]]: (1 - fA) * (1 - sp2),
      [B[`${side}Arm`]]: fA * (1 - fF),
      [B[`${side}ForeArm`]]: fF * (1 - fT),
      [B[`${side}ForeArmTwist`]]: fT * (1 - fH),
      [B[`${side}Hand`]]: fH,
    };
  };
}
const SKIN_ARM = [
  { s: 0.290, ry: 0.055, rz: 0.052, bf: 0.010 },
  { s: 0.340, ry: 0.051, rz: 0.049, bf: 0.010 },
  { s: 0.400, ry: 0.044, rz: 0.043, bf: 0.003 },
  { s: 0.455, ry: 0.038, rz: 0.040 },
  { s: 0.490, ry: 0.043, rz: 0.047 },
  { s: 0.540, ry: 0.042, rz: 0.045 },
  { s: 0.600, ry: 0.035, rz: 0.037 },
  { s: 0.660, ry: 0.028, rz: 0.030 },
  { s: 0.705, ry: 0.019, rz: 0.028 },
  { s: 0.725, ry: 0.018, rz: 0.028 },
];
function armLoft(mb, S, g, style) {
  const side = S > 0 ? 'Left' : 'Right';
  const k = G[g].arm;
  const sleeveMat = style === 'raglan' ? 'shirtAccent' : style === 'ref' ? 'ref' : 'shirt';
  const sc = r => ({ ...r, ry: r.ry * k, rz: r.rz * k, bf: (r.bf || 0) * k });
  let keys;
  if (style === 'bare') {
    keys = [
      { s: 0.140, ry: 0.040, rz: 0.047, dy: -0.022, mat: 'skin' },
      { s: 0.165, ry: 0.056, rz: 0.060, dy: -0.011, mat: 'skin' },
      { s: 0.200, ry: 0.062, rz: 0.062, dy: -0.004, mat: 'skin' },
      { s: 0.245, ry: 0.059, rz: 0.056, dy: -0.002, mat: 'skin' },
      ...SKIN_ARM.map(r => ({ ...r, mat: 'skin' })),
    ].map(sc);
  } else {
    keys = [
      { s: 0.140, ry: 0.040, rz: 0.047, dy: -0.022, mat: sleeveMat },
      { s: 0.165, ry: 0.055, rz: 0.059, dy: -0.012, mat: sleeveMat },
      { s: 0.200, ry: 0.060, rz: 0.061, dy: -0.006, mat: sleeveMat },
      { s: 0.250, ry: 0.061, rz: 0.059, dy: -0.004, mat: sleeveMat },
      { s: 0.252, ry: 0.055, rz: 0.052, mat: 'skin', brk: true, hemMat: sleeveMat },
      ...SKIN_ARM.map(r => ({ ...r, mat: 'skin' })),
    ].map(sc);
  }
  const SEG = 24;
  const rings = sampleKeys(keys, 3, { dy: 0, dz: 0, bf: 0 }).map(r => ({
    pts: Array.from({ length: SEG }, (_, j) => {
      const th = (j / SEG) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const b = s * (r.rz + (S * s > 0 ? r.bf : 0)); // V = S*Z: S*s > 0 is the biceps side
      return [S * r.s, 1.44 + r.dy + c * r.ry, -0.02 + r.dz + S * b];
    }), mat: r.mat, brk: r.brk, hemMat: r.hemMat, w: armW(side),
  }));
  const triMat = style === 'ref' ? (c, m, i, j) => (m === 'ref' ? (Math.floor(j / 3) % 2 ? 'refBlack' : 'refWhite') : m) : undefined;
  loftRings(mb, rings, { capStart: [S * 0.136, 1.416, -0.02], capEnd: [S * 0.728, 1.44, -0.02], triMat, capStartMat: style === 'ref' ? 'refWhite' : undefined });
  if (style === 'polo') { // ribbed cuff in the accent colour
    const pts = Array.from({ length: 24 }, (_, j) => {
      const th = (j / 24) * Math.PI * 2;
      return [S * 0.243, 1.44 + Math.cos(th) * 0.057 * k, -0.02 + S * Math.sin(th) * 0.055 * k];
    });
    tube(mb, pts, pts.map(() => 0.004), pts.map(() => 0.004), 'shirtAccent', armW(side), { closed: true, seg: 6 });
  }
}
function arms(g, style) {
  const mb = new MeshBuilder();
  armLoft(mb, 1, g, style);
  armLoft(mb, -1, g, style);
  return mb;
}
function elbowGuards(g, style = 'sleeve') {
  const mb = new MeshBuilder();
  const k = G[g].arm;
  for (const S of [1, -1]) {
    const side = S > 0 ? 'Left' : 'Right';
    if (style === 'strap') { // a band just below the elbow
      const keys = [{ s: 0.505, r: 0.002 }, { s: 0.51, r: 0.007 }, { s: 0.53, r: 0.007 }, { s: 0.535, r: 0.002 }];
      loftRings(mb, keys.map(q => ({
        pts: Array.from({ length: 24 }, (_, j) => {
          const th = (j / 24) * Math.PI * 2;
          return [S * q.s, 1.44 + Math.cos(th) * (0.04 * k + q.r), -0.02 + S * Math.sin(th) * (0.043 * k + q.r)];
        }), mat: 'elbowGuard', w: armW(side),
      })));
      continue;
    }
    if (style === 'pad') ellipsoid(mb, [S * 0.455, 1.44, -0.02 - 0.043 * k], [0.03, 0.034, 0.014], 'elbowGuard', armW(side), { seg: 14, rings: 8, rot: qAxis([1, 0, 0], Math.PI / 2) });
    const keys = [
      { s: 0.405, ry: 0.046, rz: 0.046 }, { s: 0.415, ry: 0.049, rz: 0.049 }, { s: 0.455, ry: 0.045, rz: 0.047 },
      { s: 0.495, ry: 0.050, rz: 0.053 }, { s: 0.505, ry: 0.047, rz: 0.050 },
    ];
    const rings = sampleKeys(keys, 2).map(r => ({
      pts: Array.from({ length: 24 }, (_, j) => {
        const th = (j / 24) * Math.PI * 2;
        return [S * r.s, 1.44 + Math.cos(th) * r.ry * k, -0.02 + S * Math.sin(th) * r.rz * k];
      }), mat: 'elbowGuard', w: armW(side),
    }));
    loftRings(mb, rings, { capStart: [S * 0.4, 1.44, -0.02], capEnd: [S * 0.51, 1.44, -0.02] });
  }
  return mb;
}

function hands() {
  const mb = new MeshBuilder();
  for (const S of [1, -1]) handFor(mb, S);
  return mb;
}
function handFor(mb, S) {
  const side = S > 0 ? 'Left' : 'Right';
  const grip = S < 0;
  const handW = p => {
    const t = 0.35 * (1 - smooth(0.7, 0.725, Math.abs(p[0])));
    return { [B[`${side}ForeArmTwist`]]: t, [B[`${side}Hand`]]: 1 - t };
  };
  const keys = [
    { s: 0.700, ry: 0.019, rz: 0.029, dy: -0.002, dz: 0.000 },
    { s: 0.730, ry: 0.0175, rz: 0.037, dy: -0.003, dz: 0.002 },
    { s: 0.770, ry: 0.0162, rz: 0.043, dy: -0.003, dz: 0.001 },
    { s: 0.800, ry: 0.0145, rz: 0.0445, dy: -0.002, dz: 0.000 },
    { s: 0.812, ry: 0.012, rz: 0.040, dy: -0.002, dz: 0.000 },
  ];
  const SEG = 20;
  loftRings(mb, sampleKeys(keys, 3).map(r => ({
    pts: Array.from({ length: SEG }, (_, j) => {
      const th = (j / SEG) * Math.PI * 2;
      return [S * r.s, 1.44 + r.dy + sp(Math.cos(th), 3) * r.ry, -0.02 + r.dz + S * sp(Math.sin(th), 3) * r.rz];
    }), mat: 'skin', w: handW,
  })), { capStart: [S * 0.698, 1.438, -0.02], capEnd: [S * 0.815, 1.438, -0.02] });
  const A = [S, 0, 0], N = [0, -1, 0];
  const fingers = [
    { z: 0.027, s0: 0.800, L: [0.042, 0.025, 0.020], r: 0.0086, splay: 4 },
    { z: 0.009, s0: 0.804, L: [0.047, 0.029, 0.021], r: 0.0089, splay: 0 },
    { z: -0.009, s0: 0.801, L: [0.043, 0.027, 0.020], r: 0.0084, splay: -3 },
    { z: -0.026, s0: 0.792, L: [0.034, 0.020, 0.018], r: 0.0073, splay: -7 },
  ];
  fingers.forEach((f, fi) => {
    const curl = grip ? [80, 100, 68] : [16 + fi * 4, 24 + fi * 3, 14 + fi * 2];
    const d0 = qRot(qAxis(N, -S * f.splay * DEG), A);
    const K = norm(cross(d0, N));
    const p0 = [S * f.s0, 1.436, -0.02 + f.z];
    const pts = [p0];
    let acc = 0, p = p0;
    f.L.forEach((L, i) => {
      acc += curl[i];
      const d = qRot(qAxis(K, acc * DEG), d0);
      pts.push(add(p, mul(d, L * 0.5)));
      p = add(p, mul(d, L));
      pts.push(p);
    });
    const Us = pts.map((_, i) => cross(K, norm(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)]))));
    tube(mb, pts, pts.map((_, i) => f.r * 0.9 * (1 - 0.22 * (i / (pts.length - 1)))), pts.map((_, i) => f.r * (1 - 0.2 * (i / (pts.length - 1)))), 'skin', one(`${side}Hand`), { U: Us, seg: 10 });
  });
  const tb = [S * 0.727, 1.432, -0.02 + 0.026];
  const dirs = grip
    ? [[S * 0.62, -0.42, 0.66], [S * 0.5, -0.8, 0.33], [S * 0.15, -0.95, 0.25]]
    : [[S * 0.72, -0.3, 0.62], [S * 0.85, -0.38, 0.36], [S * 0.86, -0.48, 0.18]];
  const Ls = [0.040, 0.032, 0.026];
  const tp = [tb];
  let p = tb;
  dirs.forEach((d, i) => {
    const dn = norm(d);
    tp.push(add(p, mul(dn, Ls[i] * 0.5)));
    p = add(p, mul(dn, Ls[i]));
    tp.push(p);
  });
  const tr = [0.0135, 0.0125, 0.011, 0.0105, 0.0098, 0.0094, 0.0088];
  tube(mb, tp, tr.map(r => r * 0.85), tr, 'skin', one(`${side}Hand`), { ref: [0, 0, 1], seg: 10 });
}

// ================================================================ legs, shorts, shoes
// bare leg: y, half width, front, back depth, x / z offsets
const SKIN_LEG = [
  { s: 1.000, rx: 0.070, rzf: 0.078, rzb: 0.076, dx: 0.000, dz: 0.000 },
  { s: 0.930, rx: 0.078, rzf: 0.080, rzb: 0.078, dx: 0.000, dz: 0.000 },
  { s: 0.850, rx: 0.076, rzf: 0.076, rzb: 0.079, dx: 0.003, dz: 0.004 },
  { s: 0.760, rx: 0.072, rzf: 0.072, rzb: 0.072, dx: 0.004, dz: 0.006 },
  { s: 0.668, rx: 0.068, rzf: 0.068, rzb: 0.068, dx: 0.004, dz: 0.008 },
  { s: 0.620, rx: 0.064, rzf: 0.066, rzb: 0.062, dx: 0.002, dz: 0.010 },
  { s: 0.560, rx: 0.056, rzf: 0.060, rzb: 0.054, dx: 0.000, dz: 0.012 },
  { s: 0.510, rx: 0.051, rzf: 0.056, rzb: 0.052, dx: 0.000, dz: 0.010 },
  { s: 0.470, rx: 0.049, rzf: 0.052, rzb: 0.058, dx: 0.000, dz: 0.002 },
  { s: 0.410, rx: 0.051, rzf: 0.050, rzb: 0.066, dx: 0.000, dz: -0.004 },
  { s: 0.350, rx: 0.049, rzf: 0.047, rzb: 0.060, dx: 0.000, dz: -0.004 },
  { s: 0.280, rx: 0.042, rzf: 0.040, rzb: 0.048, dx: 0.000, dz: -0.002 },
  { s: 0.210, rx: 0.034, rzf: 0.034, rzb: 0.038, dx: 0.000, dz: 0.000 },
  { s: 0.176, rx: 0.031, rzf: 0.032, rzb: 0.034, dx: 0.000, dz: 0.000 },
];
const SOCKS = [
  { s: 0.175, rx: 0.0345, rzf: 0.0355, rzb: 0.0375, dx: 0, dz: 0 },
  { s: 0.140, rx: 0.0335, rzf: 0.0355, rzb: 0.0375, dx: 0, dz: 0 },
  { s: 0.100, rx: 0.0335, rzf: 0.0400, rzb: 0.0400, dx: 0, dz: 0 },
  { s: 0.085, rx: 0.0300, rzf: 0.0380, rzb: 0.0360, dx: 0, dz: 0 },
];
function skinLegAt(y) {
  const K = SKIN_LEG;
  if (y >= K[0].s) return { ...K[0] };
  for (let i = 0; i < K.length - 1; i++) {
    if (y >= K[i + 1].s) {
      const t = (K[i].s - y) / (K[i].s - K[i + 1].s);
      const o = { s: y };
      for (const k of ['rx', 'rzf', 'rzb', 'dx', 'dz']) o[k] = lerp(K[i][k], K[i + 1][k], t);
      return o;
    }
  }
  return { ...K[K.length - 1], s: y };
}
// shorts: hem height and how far the fabric stands off the skin (top -> hem)
const SHORTS = {
  classic: { hem: 0.67, top: 0.022, bottom: 0.022 },
  long: { hem: 0.545, top: 0.022, bottom: 0.02 },
  compression: { hem: 0.52, top: 0.004, bottom: 0.003 },
  skort: { hem: 0.6, top: 0.004, bottom: 0.003 },
  stripe: { hem: 0.67, top: 0.022, bottom: 0.022, stripe: true },
  track: { hem: 0.108, top: 0.022, bottom: 0.018, pants: true, stripe: true },
  jogger: { hem: 0.12, top: 0.022, bottom: 0.006, pants: true, cuff: true },
  tights: { hem: 0.1, top: 0.004, bottom: 0.003, pants: true },
  ref: { hem: 0.108, top: 0.02, bottom: 0.016, pants: true },
};
function legW(side) {
  return p => {
    const y = p[1];
    const fU = smooth(1.0, 0.88, y), fK = smooth(0.56, 0.46, y), fF = smooth(0.13, 0.09, y);
    return { [B.Hips]: 1 - fU, [B[`${side}UpLeg`]]: fU * (1 - fK), [B[`${side}Leg`]]: fK * (1 - fF), [B[`${side}Foot`]]: fF };
  };
}
function legLoft(mb, S, g, style) {
  const side = S > 0 ? 'Left' : 'Right';
  const gk = G[g];
  const sh = SHORTS[style];
  const shape = r => ({ ...r, rx: r.rx * gk.leg * (r.s < 0.5 ? gk.calf : 1), rzf: r.rzf * gk.leg * (r.s < 0.5 ? gk.calf : 1), rzb: r.rzb * gk.leg * (r.s < 0.5 ? gk.calf : 1) });
  const cloth = style === 'ref' ? 'pants' : 'shorts';
  const keys = [];
  const ys = [0.965, 0.93, 0.85, 0.76, 0.668, 0.62, 0.56, 0.51, 0.47, 0.41, 0.35, 0.28, 0.21, 0.15, 0.108].filter(y => y > sh.hem + 0.005);
  for (const y of [...ys, sh.hem]) {
    const r = shape(skinLegAt(y));
    const t = (0.965 - y) / (0.965 - sh.hem);
    const off = lerp(sh.top, sh.bottom, t);
    keys.push({ ...r, rx: r.rx + off, rzf: r.rzf + off, rzb: r.rzb + off, mat: cloth });
  }
  if (!sh.pants) {
    const below = SKIN_LEG.filter(r => r.s < sh.hem - 0.004);
    keys.push({ ...shape(skinLegAt(sh.hem - 0.002)), mat: 'skin', brk: true, hemMat: cloth });
    for (const r of below) keys.push({ ...shape(r), mat: 'skin' });
    keys.push(...SOCKS.map((r, i) => ({ ...r, mat: 'socks', ...(i === 0 ? { brk: true, hemMat: 'socks' } : {}) })));
  } else { // long pants end inside the shoe collar
    keys.push({ s: 0.09, rx: 0.036 + sh.bottom, rzf: 0.042 + sh.bottom, rzb: 0.042 + sh.bottom, dx: 0, dz: 0, mat: cloth });
  }
  const SEG = 28;
  const rings = sampleKeys(keys, 3).map(r => ({
    pts: Array.from({ length: SEG }, (_, j) => {
      const th = (j / SEG) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const a = c >= 0 ? c * r.rzf : c * r.rzb;
      const b = s * r.rx * (S * s > 0 ? 0.94 : 1);
      return [S * (0.095 + r.dx) - b, r.s, r.dz + a]; // advance -Y, U = +Z, V = -X
    }), mat: r.mat, brk: r.brk, hemMat: r.hemMat, w: legW(side),
  }));
  // side stripe down the outside of the leg (shorts and track pants)
  const triMat = sh.stripe ? (c, m, i, j) => (m === cloth && Math.sin(((j + 0.5) / SEG) * Math.PI * 2) * S < -0.93 ? 'shirtAccent' : m) : undefined;
  loftRings(mb, rings, { capStart: [S * 0.095, 0.965, 0], capEnd: [S * 0.095, 0.085, 0], triMat });
  if (sh.cuff) { // jogger cuff gathered at the ankle
    const r = skinLegAt(0.176);
    const loop = Array.from({ length: 24 }, (_, j) => {
      const th = (j / 24) * Math.PI * 2;
      return [S * 0.095 - Math.sin(th) * (r.rx + 0.012), 0.128, Math.cos(th) * (r.rzf + 0.014)];
    });
    tube(mb, loop, loop.map(() => 0.008), loop.map(() => 0.008), cloth, legW(side), { closed: true, seg: 8 });
  }
}
function legs(g, style) {
  const mb = new MeshBuilder();
  legLoft(mb, 1, g, style);
  legLoft(mb, -1, g, style);
  if (style === 'skort') skirt(mb, g);
  return mb;
}
function skirt(mb, g) {
  const keys = [
    { s: 0.985, rx: 0.184, rzf: 0.106, rzb: 0.114 },
    { s: 0.90, rx: 0.205, rzf: 0.118, rzb: 0.13 },
    { s: 0.80, rx: 0.226, rzf: 0.134, rzb: 0.146 },
    { s: 0.70, rx: 0.24, rzf: 0.146, rzb: 0.158 },
  ];
  const w = p => {
    const t = smooth(0.97, 0.72, p[1]) * 0.55 * smooth(0.02, 0.12, Math.abs(p[0]));
    return { [B.Hips]: 1 - t, [B[p[0] >= 0 ? 'LeftUpLeg' : 'RightUpLeg']]: t };
  };
  const SEG = 48;
  const rings = sampleKeys(keys, 3).map(r => ({
    pts: Array.from({ length: SEG }, (_, j) => {
      const th = (j / SEG) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const pleat = 1 + 0.025 * Math.cos(th * 16) * smooth(0.95, 0.75, r.s);
      return [-s * r.rx * pleat, r.s, -0.01 + (c >= 0 ? c * r.rzf : c * r.rzb) * pleat];
    }), mat: 'shorts', w,
  }));
  loftRings(mb, rings);
  loftRings(mb, [...rings].reverse()); // inside
}
function kneeGuards(g, style = 'sleeve') {
  const mb = new MeshBuilder();
  for (const S of [1, -1]) {
    const side = S > 0 ? 'Left' : 'Right';
    if (style === 'strap') { // a patella strap under the kneecap
      const ys = [0.478, 0.474, 0.452, 0.448];
      loftRings(mb, ys.map((y, i) => {
        const r = skinLegAt(y), off = i === 0 || i === 3 ? 0.002 : 0.007;
        return {
          pts: Array.from({ length: 28 }, (_, j) => {
            const th = (j / 28) * Math.PI * 2;
            const c = Math.cos(th), sn = Math.sin(th);
            return [S * (0.095 + r.dx) - sn * (r.rx * G[g].leg + off), y, r.dz + (c >= 0 ? c * (r.rzf * G[g].leg + off) : c * (r.rzb * G[g].leg + off))];
          }), mat: 'kneeGuard', w: legW(side),
        };
      }));
      continue;
    }
    if (style === 'pad') {
      const r = skinLegAt(0.515);
      ellipsoid(mb, [S * 0.095, 0.515, r.dz + r.rzf * G[g].leg + 0.017], [0.045, 0.052, 0.017], 'kneeGuard', legW(side), { seg: 16, rings: 8, rot: qAxis([1, 0, 0], Math.PI / 2) });
    }
    const keys = [0.59, 0.585, 0.55, 0.51, 0.47, 0.44, 0.435].map((y, i, a) => {
      const r = skinLegAt(y);
      const off = i === 0 || i === a.length - 1 ? 0.004 : 0.009 + (y > 0.47 && y < 0.55 ? 0.004 : 0);
      return { ...r, rx: r.rx * G[g].leg + off, rzf: r.rzf * G[g].leg + off + (y > 0.48 && y < 0.55 ? 0.006 : 0), rzb: r.rzb * G[g].leg + off * 0.7 };
    });
    const SEG = 28;
    const rings = keys.map(r => ({
      pts: Array.from({ length: SEG }, (_, j) => {
        const th = (j / SEG) * Math.PI * 2;
        const c = Math.cos(th), s = Math.sin(th);
        return [S * (0.095 + r.dx) - s * r.rx, r.s, r.dz + (c >= 0 ? c * r.rzf : c * r.rzb)];
      }), mat: 'kneeGuard', w: legW(side),
    }));
    loftRings(mb, rings);
  }
  return mb;
}

function shoes() {
  const mb = new MeshBuilder();
  for (const S of [1, -1]) {
    const side = S > 0 ? 'Left' : 'Right';
    const keys = [
      { s: -0.072, w: 0.024, top: 0.055, xo: 0.000 },
      { s: -0.066, w: 0.036, top: 0.085, xo: 0.000 },
      { s: -0.048, w: 0.043, top: 0.100, xo: 0.000 },
      { s: -0.012, w: 0.046, top: 0.104, xo: 0.000 },
      { s: 0.030, w: 0.049, top: 0.088, xo: 0.002 },
      { s: 0.070, w: 0.052, top: 0.070, xo: 0.004 },
      { s: 0.110, w: 0.053, top: 0.054, xo: 0.006 },
      { s: 0.150, w: 0.050, top: 0.044, xo: 0.008 },
      { s: 0.182, w: 0.042, top: 0.037, xo: 0.009 },
      { s: 0.203, w: 0.029, top: 0.030, xo: 0.009 },
      { s: 0.213, w: 0.013, top: 0.025, xo: 0.008 },
    ];
    const w = p => { const t = smooth(0.06, 0.13, p[2]); return { [B[`${side}Foot`]]: 1 - t, [B[`${side}ToeBase`]]: t }; };
    const SEG = 28;
    const dense = sampleKeys(keys, 3);
    const rings = dense.map(r => ({
      pts: Array.from({ length: SEG }, (_, j) => {
        const th = (j / SEG) * Math.PI * 2;
        return [S * (0.095 - r.xo) - sp(Math.sin(th), 3.0) * r.w, r.top / 2 + sp(Math.cos(th), 3.2) * r.top / 2, r.s];
      }), mat: 'shoe', w,
    }));
    const triMat = (c, m, i, j) => {
      const th = ((j + 0.5) / SEG) * Math.PI * 2;
      const cs = Math.cos(th);
      if (cs < -0.62) return 'sole';
      const z = dense[i].s;
      if (Math.abs(Math.sin(th)) > 0.45 && cs > -0.5 && cs < -0.27 && z > -0.045 && z < 0.135) return 'shoeAccent';
      return m;
    };
    loftRings(mb, rings, { triMat, capStart: [S * 0.095, 0.03, -0.074], capEnd: [S * (0.095 - 0.008), 0.014, 0.215], capStartMat: 'shoe', capEndMat: 'shoe' });
  }
  return mb;
}

// ================================================================ all parts
export const SHIRT_STYLES = ['crew', 'vneck', 'polo', 'tank', 'raglan', 'pro', 'stripe', 'sleeveless'];
export const SHORTS_STYLES = ['classic', 'long', 'compression', 'skort', 'stripe', 'track', 'jogger', 'tights'];
export const HAIR_STYLES = ['short', 'buzz', 'curly', 'ponytail', 'bun', 'long'];
export const HEADWEAR = ['cap', 'cap_flat', 'cap_trucker', 'visor', 'visor_wide', 'visor_pro', 'band', 'band_thin', 'band_tie'];
export const GLASSES = ['sport', 'round', 'clear', 'mirror'];

export function buildParts() {
  const parts = [];
  const add2 = (name, mb) => parts.push({ name, mb });
  for (const g of ['m', 'f']) {
    add2(`${g}.head`, head(g));
    for (const st of SHIRT_STYLES) add2(`${g}.torso.${st}`, torso(g, st));
    for (const st of ['sleeve', 'raglan', 'polo', 'bare']) add2(`${g}.arms.${st}`, arms(g, st));
    for (const st of SHORTS_STYLES) add2(`${g}.legs.${st}`, legs(g, st));
    for (const st of HAIR_STYLES) add2(`${g}.hair.${st}`, hair(g, st));
    add2(`${g}.knee`, kneeGuards(g));
    add2(`${g}.knee_pad`, kneeGuards(g, 'pad'));
    add2(`${g}.knee_strap`, kneeGuards(g, 'strap'));
    add2(`${g}.elbow`, elbowGuards(g));
    add2(`${g}.elbow_pad`, elbowGuards(g, 'pad'));
    add2(`${g}.elbow_strap`, elbowGuards(g, 'strap'));
  }
  for (const k of HEADWEAR) add2(`acc.${k}`, headwear(k));
  for (const k of GLASSES) add2(`acc.glasses_${k}`, glasses(k));
  add2('acc.wrist_R', wristband(-1, 0.655, 0.7));
  add2('acc.wrist_L', wristband(1, 0.655, 0.7));
  add2('acc.wristpro_R', wristband(-1, 0.61, 0.7));
  add2('acc.wristpro_L', wristband(1, 0.61, 0.7));
  for (const st of ['stubble', 'mustache', 'beard']) add2(`m.facial.${st}`, facial(st));
  add2('hands', hands());
  add2('shoes', shoes());
  add2('ref.torso', torso('m', 'ref'));
  add2('ref.arms', arms('m', 'ref'));
  add2('ref.legs', legs('m', 'ref'));
  return parts;
}
