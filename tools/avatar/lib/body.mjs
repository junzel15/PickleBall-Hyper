// Modelling toolkit: lofted surfaces, tubes and ellipsoids, all skinned with smooth weights.
// The character's parts are built from these in character.mjs.
import { B } from './rig.mjs';
import { add, mul, sub, norm, cross, dot, lerp, qRot, qId } from './math.mjs';

// Colours are defaults only: the game recolours materials per player (see players3d.ts).
export const MATERIALS = {
  skin: { color: '#c08a68', rough: 0.55 },
  lips: { color: '#a5625a', rough: 0.45 },
  brow: { color: '#2b1e15', rough: 0.8 },
  hair: { color: '#2b1e15', rough: 0.75, doubleSided: true },
  stubble: { color: '#5a4334', rough: 0.9 },
  eyeWhite: { color: '#ece8e1', rough: 0.15 },
  iris: { color: '#4d3423', rough: 0.2 },
  pupil: { color: '#0a0a0a', rough: 0.1 },
  shirt: { color: '#1e6db5', rough: 0.82 },
  shirtAccent: { color: '#f5f5f2', rough: 0.8 },
  button: { color: '#f2f2ee', rough: 0.4 },
  shorts: { color: '#23262d', rough: 0.85 },
  socks: { color: '#f3f3f1', rough: 0.95 },
  shoe: { color: '#ebebe8', rough: 0.55 },
  shoeAccent: { color: '#1e6db5', rough: 0.5 },
  sole: { color: '#3a3b3f', rough: 0.9 },
  hat: { color: '#1d4e89', rough: 0.75 },
  hatTrim: { color: '#f2f2ee', rough: 0.7 },
  band: { color: '#f2f2f0', rough: 0.9 },
  frame: { color: '#15171b', rough: 0.35 },
  lens: { color: '#1d2630', rough: 0.1 },
  lensMirror: { color: '#4a63b8', rough: 0.08, metal: 0.4 },
  kneeGuard: { color: '#1b1b1d', rough: 0.7 },
  elbowGuard: { color: '#1b1b1d', rough: 0.7 },
  refWhite: { color: '#f4f4f2', rough: 0.8 },
  refBlack: { color: '#141414', rough: 0.8 },
  pants: { color: '#17191d', rough: 0.85 },
};

// ---------------------------------------------------------------- builder
export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.skin = [];
    this.groups = new Map();
  }
  v(p, w) {
    this.pos.push(p);
    this.skin.push(normWeights(w));
    return this.pos.length - 1;
  }
  tri(mat, a, b, c) {
    if (!this.groups.has(mat)) this.groups.set(mat, []);
    this.groups.get(mat).push(a, b, c);
  }
}

function normWeights(w) {
  const list = Object.entries(w)
    .map(([k, v]) => [Number(k), v])
    .filter(([, v]) => v > 1e-4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const s = list.reduce((acc, [, v]) => acc + v, 0) || 1;
  return list.map(([k, v]) => [k, v / s]);
}

export const one = name => ({ [B[name]]: 1 });
export const blend = (a, b, t) => ({ ...(t < 1 ? { [B[a]]: 1 - t } : {}), ...(t > 0 ? { [B[b]]: t } : {}) });

/**
 * Join rings of equal size into a surface. A ring's points must run counter-clockwise
 * when looking back down the direction the rings advance (U x V = advance), which makes
 * every triangle face outward. `open` leaves the seam between the last and first point open.
 */
export function loftRings(mb, rings, opts = {}) {
  const seg = rings[0].pts.length;
  const ids = rings.map(r => r.pts.map(p => mb.v(p, typeof r.w === 'function' ? r.w(p) : r.w)));
  const matFor = (i, j, a, b, c) => {
    let m = rings[i + 1] && rings[i + 1].brk ? rings[i + 1].hemMat || rings[i].mat : rings[i].mat;
    if (opts.triMat) {
      const P = mb.pos;
      m = opts.triMat(mul(add(add(P[a], P[b]), P[c]), 1 / 3), m, i, j);
    }
    return m;
  };
  const jEnd = opts.open ? seg - 1 : seg;
  const band = (i, i2) => {
    for (let j = 0; j < jEnd; j++) {
      const a = ids[i][j], b = ids[i][(j + 1) % seg], c = ids[i2][j], d = ids[i2][(j + 1) % seg];
      const m1 = matFor(i, j, a, b, d), m2 = matFor(i, j, a, d, c);
      if (m1) mb.tri(m1, a, b, d);
      if (m2) mb.tri(m2, a, d, c);
    }
  };
  for (let i = 0; i < rings.length - 1; i++) band(i, i + 1);
  if (opts.closed) band(rings.length - 1, 0);
  if (opts.capStart) {
    const r = rings[0];
    const c = mb.v(opts.capStart, typeof r.w === 'function' ? r.w(opts.capStart) : r.w);
    for (let j = 0; j < jEnd; j++) mb.tri(opts.capStartMat || r.mat, c, ids[0][(j + 1) % seg], ids[0][j]);
  }
  if (opts.capEnd) {
    const r = rings[rings.length - 1];
    const n = rings.length - 1;
    const c = mb.v(opts.capEnd, typeof r.w === 'function' ? r.w(opts.capEnd) : r.w);
    for (let j = 0; j < jEnd; j++) mb.tri(opts.capEndMat || r.mat, c, ids[n][j], ids[n][(j + 1) % seg]);
  }
  return ids;
}

// Catmull-Rom between keys; `brk` on a key starts a new run (a hem / clothing edge).
const cr = (p0, p1, p2, p3, t) => {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};
export function sampleKeys(keys, per, defaults = {}) {
  const ks = keys.map(k => ({ ...defaults, ...k }));
  const runs = [];
  let cur = [];
  for (const k of ks) {
    if (k.brk && cur.length) { runs.push(cur); cur = []; }
    cur.push(k);
  }
  runs.push(cur);
  const out = [];
  for (const run of runs) {
    const n = run.length;
    for (let i = 0; i < n - 1; i++) {
      const k0 = run[Math.max(0, i - 1)], k1 = run[i], k2 = run[i + 1], k3 = run[Math.min(n - 1, i + 2)];
      for (let j = 0; j < per; j++) {
        const t = j / per;
        const o = { ...k1, brk: j === 0 ? k1.brk : false };
        for (const key of Object.keys(k1)) {
          if (typeof k1[key] !== 'number') continue;
          o[key] = key === 's' ? lerp(k1.s, k2.s, t) : cr(k0[key], k1[key], k2[key], k3[key], t);
        }
        out.push(o);
      }
    }
    out.push({ ...run[n - 1], brk: n === 1 ? run[0].brk : false });
  }
  return out;
}

export const sp = (v, p) => Math.sign(v) * Math.abs(v) ** (2 / p); // superellipse profile

/** Tube along a polyline. U[i] (optional) fixes the ring's "a" axis; ends get rounded caps. */
export function tube(mb, path, radA, radB, mat, w, opts = {}) {
  const seg = opts.seg || 12;
  const n = path.length;
  const tan = path.map((_, i) => {
    if (opts.closed) return norm(sub(path[(i + 1) % n], path[(i - 1 + n) % n]));
    return norm(sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)]));
  });
  const ref = opts.ref || [0, 1, 0];
  const frames = path.map((_, i) => {
    const A = tan[i];
    let U = opts.U ? opts.U[i] : ref;
    U = sub(U, mul(A, dot(U, A)));
    if (Math.hypot(...U) < 1e-6) U = Math.abs(A[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    U = norm(sub(U, mul(A, dot(U, A))));
    return { A, U, V: cross(A, U) };
  });
  const ringAt = (c, f, ra, rb) => {
    const pts = [];
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      pts.push(add(c, add(mul(f.U, Math.cos(th) * ra), mul(f.V, Math.sin(th) * rb))));
    }
    return pts;
  };
  const W = i => (typeof w === 'function' ? w : () => w);
  const rings = [];
  const capSteps = opts.round === false || opts.closed ? 0 : 3;
  for (let k = capSteps; k >= 1; k--) {
    const ph = (k / (capSteps + 1)) * (Math.PI / 2);
    const f = frames[0];
    rings.push({ pts: ringAt(add(path[0], mul(f.A, -Math.sin(ph) * radA[0] * 0.9)), f, radA[0] * Math.cos(ph), radB[0] * Math.cos(ph)), w: W(0), mat });
  }
  path.forEach((c, i) => rings.push({ pts: ringAt(c, frames[i], radA[i], radB[i]), w: W(i), mat }));
  for (let k = 1; k <= capSteps; k++) {
    const ph = (k / (capSteps + 1)) * (Math.PI / 2);
    const f = frames[n - 1];
    rings.push({ pts: ringAt(add(path[n - 1], mul(f.A, Math.sin(ph) * radA[n - 1] * 0.9)), f, radA[n - 1] * Math.cos(ph), radB[n - 1] * Math.cos(ph)), w: W(n - 1), mat });
  }
  if (opts.closed) return loftRings(mb, rings, { closed: true });
  return loftRings(mb, rings, {
    capStart: capSteps ? add(path[0], mul(frames[0].A, -radA[0] * 0.9)) : path[0],
    capEnd: capSteps ? add(path[n - 1], mul(frames[n - 1].A, radA[n - 1] * 0.9)) : path[n - 1],
  });
}

/** Ellipsoid (or a top slice of one when phiMax < PI). */
export function ellipsoid(mb, c, r, mat, w, opts = {}) {
  const seg = opts.seg || 16, nr = opts.rings || 10, phiMax = opts.phiMax || Math.PI;
  const rot = opts.rot || qId();
  const P = l => add(c, qRot(rot, [l[0] * r[0], l[1] * r[1], l[2] * r[2]]));
  const rings = [];
  const ringAt = ph => {
    const pts = [];
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      pts.push(P([Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)]));
    }
    return pts;
  };
  for (let i = 1; i < nr; i++) rings.push({ pts: ringAt((i / nr) * phiMax), w, mat });
  if (phiMax < Math.PI - 1e-6) {
    rings.push({ pts: ringAt(phiMax), w, mat });
    return loftRings(mb, rings, { capStart: P([0, 1, 0]) });
  }
  return loftRings(mb, rings, { capStart: P([0, 1, 0]), capEnd: P([0, -1, 0]) });
}
