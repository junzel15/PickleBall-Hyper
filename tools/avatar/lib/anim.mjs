// Pose solver + the animation clips.
// A pose is described like a coach would: feet on the ground, hips/chest turn and lean,
// where the hands are, which way the paddle points and faces. Arms and legs are solved
// with two-bone IK; the hand's roll is split between a forearm twist bone and the wrist.
import { BONES, B, restLocal } from './rig.mjs';
import {
  add, sub, mul, dot, cross, len, norm, clamp, smooth, DEG,
  qId, qMul, qConj, qNorm, qAxis, qRot, qEuler, qAngle, qPow, frameRot, twistAngle,
} from './math.mjs';

const N = BONES.length;
const P0 = i => BONES[i].pos;
const L_UPARM = len(sub(P0(B.LeftForeArm), P0(B.LeftArm)));
const L_FORE = len(sub(P0(B.LeftHand), P0(B.LeftForeArm)));
const L_THIGH = len(sub(P0(B.LeftLeg), P0(B.LeftUpLeg)));
const L_SHIN = len(sub(P0(B.LeftFoot), P0(B.LeftLeg)));
const BALL = sub(P0(B.LeftToeBase), P0(B.LeftFoot)); // ankle -> ball of the foot
const ANKLE_Y = P0(B.LeftFoot)[1];

function ik2(A, T, L1, L2, pole) {
  const d = sub(T, A);
  const u = norm(d);
  const dist = clamp(len(d), Math.abs(L1 - L2) + 1e-3, (L1 + L2) * 0.999);
  let pp = sub(pole, mul(u, dot(pole, u)));
  if (len(pp) < 1e-5) pp = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
  pp = norm(sub(pp, mul(u, dot(pp, u))));
  const along = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, L1 * L1 - along * along));
  const E = add(A, add(mul(u, along), mul(pp, h)));
  const Tc = add(A, mul(u, dist));
  return { dir1: norm(sub(E, A)), dir2: norm(sub(Tc, E)), n: norm(cross(pp, u)) };
}

/** Pose -> local rotations for every bone + the hips translation. */
export function solvePose(P) {
  const q = Array.from({ length: N }, () => qId());
  const t = restLocal.map(v => [...v]);
  const W = new Array(N);
  const set = (i, qq) => {
    q[i] = qNorm(qq);
    const p = BONES[i].parent;
    W[i] = p < 0 ? { R: q[i], P: t[i] } : { R: qMul(W[p].R, q[i]), P: add(W[p].P, qRot(W[p].R, t[i])) };
  };
  set(B.Root, qId());
  t[B.Hips] = add(P0(B.Hips), P.hip);
  set(B.Hips, qEuler(...P.hipR));
  const fr = [0.3, 0.35, 0.35];
  ['Spine', 'Spine1', 'Spine2'].forEach((n, k) => set(B[n], qEuler(P.sp[0] * fr[k], P.sp[1] * fr[k], P.sp[2] * fr[k])));

  // head: keep the eyes on the look direction, neck takes 40% of it
  let qt = qMul(qConj(W[B.Spine2].R), qEuler(P.look[1], P.look[0], P.look[2]));
  if (qt[3] < 0) qt = qt.map(v => -v);
  const ha = qAngle(qt);
  if (ha > 75 * DEG) qt = qPow(qt, (75 * DEG) / ha);
  const qn = qPow(qt, 0.4);
  set(B.Neck, qn);
  set(B.Head, qMul(qConj(qn), qt));

  for (const S of [1, -1]) {
    const side = S > 0 ? 'Left' : 'Right';
    const h = S > 0 ? P.lh : P.rh;
    const iS = B[`${side}Shoulder`], iA = B[`${side}Arm`], iF = B[`${side}ForeArm`], iT = B[`${side}ForeArmTwist`], iH = B[`${side}Hand`];
    // clavicle shrugs up / forward a little toward where the hand is going
    set(iS, qId());
    set(iA, qId());
    const v = qRot(qConj(W[B.Spine2].R), norm(sub(h.p, W[iA].P)));
    const elev = clamp(Math.asin(clamp(v[1], -1, 1)), 0, Math.PI / 2) * 0.32;
    const prot = clamp(v[2] * 0.18, -0.12, 0.22);
    set(iS, qMul(qAxis([0, 1, 0], -S * prot), qAxis([0, 0, 1], S * elev)));
    set(iA, qId());
    const ik = ik2(W[iA].P, h.p, L_UPARM, L_FORE, h.pole);
    const d0 = [S, 0, 0], n0 = [0, -S, 0];
    set(iA, qMul(qConj(W[iS].R), frameRot(ik.dir1, ik.n, d0, n0)));
    set(iF, qMul(qConj(W[iA].R), frameRot(ik.dir2, ik.n, d0, n0)));
    // hand orientation: right = paddle (tip, hitting-face normal), left = (fingers, palm)
    const Rh = S < 0 ? frameRot(h.tip, h.face, [0, 0, 1], [0, -1, 0]) : frameRot(h.fing, h.palm, [1, 0, 0], [0, -1, 0]);
    const qr = qMul(qConj(W[iF].R), Rh);
    const ax = [S, 0, 0];
    let a = twistAngle(qr, ax);
    let sw = qMul(qConj(qAxis(ax, a)), qr); // qr = twist * swing
    a = clamp(a, -110 * DEG, 110 * DEG);
    const sa = qAngle(sw);
    if (sa > 80 * DEG) sw = qPow(sw, (80 * DEG) / sa);
    set(iT, qAxis(ax, a * 0.6));
    set(iH, qMul(qAxis(ax, a * 0.4), sw));
    if (S < 0) set(B.Paddle, qId());
  }

  for (const S of [1, -1]) {
    const side = S > 0 ? 'Left' : 'Right';
    const f = S > 0 ? P.lf : P.rf;
    const iU = B[`${side}UpLeg`], iL = B[`${side}Leg`], iF = B[`${side}Foot`], iT = B[`${side}ToeBase`];
    const yawQ = qAxis([0, 1, 0], f.yaw * DEG);
    const Rf = qMul(yawQ, qAxis([1, 0, 0], f.heel * DEG));
    // heel raise pivots about the ball of the foot
    const ballFlat = add([f.x, ANKLE_Y, f.z], qRot(yawQ, BALL));
    const ankle = add(sub(ballFlat, qRot(Rf, BALL)), [0, f.lift, 0]);
    set(iU, qId());
    const fwd = qRot(yawQ, [0, 0, 1]);
    const ik = ik2(W[iU].P, ankle, L_THIGH, L_SHIN, norm(add(fwd, [S * 0.12, 0, 0])));
    const d0u = norm(sub(P0(iL), P0(iU))), d0l = norm(sub(P0(iF), P0(iL)));
    set(iU, qMul(qConj(W[B.Hips].R), frameRot(ik.dir1, ik.n, d0u, [1, 0, 0])));
    set(iL, qMul(qConj(W[iU].R), frameRot(ik.dir2, ik.n, d0l, [1, 0, 0])));
    set(iF, qMul(qConj(W[iL].R), Rf));
    set(iT, qAxis([1, 0, 0], f.toe * DEG));
  }
  return { q, hip: t[B.Hips], W };
}

// ---------------------------------------------------------------- pose helpers
const foot = (x, z, yaw, heel = 0, lift = 0, toe = null) => ({ x, z, yaw, heel, lift, toe: toe == null ? (lift < 0.01 ? -heel : 0) : toe });
const clone = o => JSON.parse(JSON.stringify(o));
function merge(base, over) {
  const out = clone(base);
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(out[k], v) : clone(v);
  }
  return out;
}
const flat = o => (Array.isArray(o) ? o.flatMap(flat) : typeof o === 'object' ? Object.keys(o).sort().flatMap(k => flat(o[k])) : [o]);
function unflat(tpl, arr, i = { v: 0 }) {
  if (Array.isArray(tpl)) return tpl.map(x => unflat(x, arr, i));
  if (typeof tpl === 'object') {
    const o = {};
    for (const k of Object.keys(tpl).sort()) o[k] = unflat(tpl[k], arr, i);
    return o;
  }
  return arr[i.v++];
}

/** Time-based Catmull-Rom (Hermite) through keyed poses. Ends ease in/out unless looping. */
function keyed(keys, dur, loop = false) {
  const ts = keys.map(k => k.t);
  const vs = keys.map(k => flat(k.pose));
  const tpl = keys[0].pose;
  const n = keys.length;
  const tan = i => {
    if (!loop && (i === 0 || i === n - 1)) return vs[i].map(() => 0);
    const a = i === 0 ? n - 2 : i - 1, b = i === n - 1 ? 1 : i + 1;
    const ta = i === 0 ? ts[a] - dur : ts[a], tb = i === n - 1 ? ts[b] + dur : ts[b];
    return vs[i].map((_, k) => (vs[b][k] - vs[a][k]) / (tb - ta));
  };
  const M = keys.map((_, i) => tan(i));
  return t => {
    let i = 0;
    while (i < n - 2 && t > ts[i + 1]) i++;
    const h = ts[i + 1] - ts[i];
    const u = clamp((t - ts[i]) / h, 0, 1);
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    return unflat(tpl, vs[i].map((p, k) => h00 * p + h10 * h * M[i][k] + h01 * vs[i + 1][k] + h11 * h * M[i + 1][k]));
  };
}

// ---------------------------------------------------------------- base poses
const READY = {
  hip: [0, -0.1, 0], hipR: [14, 0, 0], sp: [10, 0, 0], look: [0, 4, 0],
  lf: foot(0.2, 0.03, 12, 8), rf: foot(-0.2, 0, -12, 8),
  rh: { p: [-0.16, 1.0, 0.48], pole: [-0.6, -1, -0.3], tip: [-0.15, 0.78, 0.6], face: [0, 0.6, 0.8] },
  lh: { p: [0.03, 0.99, 0.45], pole: [0.6, -1, -0.3], fing: [-0.3, 0.45, 0.85], palm: [-1, 0, 0.15] },
};
const R = over => merge(READY, over);

export const T_POSE = {
  hip: [0, 0, 0], hipR: [0, 0, 0], sp: [0, 0, 0], look: [0, 0, 0],
};

// ---------------------------------------------------------------- clips
const TAU = Math.PI * 2;

function idle(t, dur) {
  const ph = (TAU * t) / dur;
  return R({
    hip: [0.013 * Math.sin(ph), -0.014 + 0.003 * Math.sin(2 * ph), 0.004 * Math.sin(2 * ph)],
    hipR: [3, 3 * Math.sin(ph), -1.6 * Math.sin(ph)],
    sp: [-1.5 + 1.2 * Math.sin(2 * ph), -2 * Math.sin(ph), 1.2 * Math.sin(ph)],
    look: [9 * Math.sin(ph + 1.3), 3 + 2 * Math.sin(2 * ph + 0.5), 1.5 * Math.sin(ph)],
    lf: foot(0.12, 0.0, 9), rf: foot(-0.12, 0.03, -11),
    rh: { p: [-0.255, 0.93 + 0.006 * Math.sin(2 * ph), 0.07 + 0.012 * Math.sin(ph)], pole: [-0.4, 0, -1], tip: [0.05, -0.55, 0.85], face: [1, 0, 0.05] },
    lh: { p: [0.245, 0.93 + 0.005 * Math.sin(2 * ph + 1), 0.03], pole: [0.4, 0, -1], fing: [0.05, -1, 0.12], palm: [-1, 0, 0.1] },
  });
}

function ready(t, dur) {
  const ph = (TAU * t * 4) / dur; // small bounce on the balls of the feet, 2 Hz
  const sway = Math.sin((TAU * t) / dur);
  const b = Math.sin(ph);
  return R({
    hip: [0.006 * sway, -0.1 + 0.009 * b, 0],
    lf: foot(0.2, 0.03, 12, 8 + 4 * b), rf: foot(-0.2, 0, -12, 8 + 4 * b),
    rh: { p: [-0.16 + 0.006 * sway, 1.0 + 0.007 * b, 0.48] },
    lh: { p: [0.03 + 0.006 * sway, 0.99 + 0.007 * b, 0.45] },
    look: [3 * sway, 4, 0],
  });
}

const forehand = keyed([
  { t: 0, pose: R({}) },
  { t: 0.28, pose: R({
    hip: [-0.04, -0.1, -0.02], hipR: [13, -28, 0], sp: [9, -34, -3], look: [-10, 6, 0],
    lf: foot(0.17, 0.1, -5, 12, 0.035, 5), rf: foot(-0.22, -0.03, -30),
    rh: { p: [-0.54, 1.03, -0.17], pole: [-0.3, -1, -0.6], tip: [-0.35, 0.5, -0.8], face: [-0.75, -0.15, 0.55] },
    lh: { p: [-0.1, 1.18, 0.4], pole: [0.3, -1, -0.2], fing: [-0.5, 0.1, 0.85], palm: [-0.2, -0.95, 0.1] },
  }) },
  { t: 0.42, pose: R({
    hip: [-0.01, -0.11, 0.03], hipR: [13, -14, 0], sp: [10, -18, -5], look: [-8, 8, 0],
    lf: foot(0.17, 0.28, 0), rf: foot(-0.22, -0.03, -25, 8),
    rh: { p: [-0.58, 0.93, 0.06], pole: [-0.4, -1, -0.5], tip: [-0.55, 0.15, -0.82], face: [-0.5, 0.1, 0.86] },
    lh: { p: [0.05, 1.15, 0.35], pole: [0.4, -1, -0.3], fing: [0, 0, 1], palm: [-0.4, -0.9, 0] },
  }) },
  { t: 0.5, pose: R({
    hip: [0.02, -0.115, 0.07], hipR: [13, 6, 0], sp: [12, 6, -3], look: [-5, 10, 0],
    lf: foot(0.17, 0.28, 0), rf: foot(-0.22, -0.03, -15, 22),
    rh: { p: [-0.46, 0.95, 0.44], pole: [-0.5, -1, -0.3], tip: [-0.92, 0.3, -0.12], face: [0, 0.1, 1] },
    lh: { p: [0.22, 1.12, 0.2], pole: [0.6, -1, -0.4], fing: [0.5, -0.2, 0.85], palm: [-0.5, -0.8, 0] },
  }) },
  { t: 0.68, pose: R({
    hip: [0.05, -0.085, 0.11], hipR: [11, 32, 0], sp: [10, 36, 2], look: [5, 6, 0],
    lf: foot(0.17, 0.28, 0), rf: foot(-0.2, 0, 10, 45),
    rh: { p: [0.3, 1.3, 0.2], pole: [-0.2, -0.7, -1], tip: [0.35, 0.75, -0.55], face: [0.75, -0.1, 0.65] },
    lh: { p: [0.27, 1.08, -0.02], pole: [0.6, -1, -0.4], fing: [0, -0.4, 0.9], palm: [-0.9, 0, 0.1] },
  }) },
  { t: 0.92, pose: R({
    hip: [0.02, -0.095, 0.05], hipR: [13, 10, 0], sp: [10, 10, 0],
    lf: foot(0.18, 0.13, 6, 0, 0.03, 0), rf: foot(-0.2, 0, -10, 10),
    rh: { p: [0.0, 1.0, 0.46], tip: [0, 0.8, 0.6], face: [0.3, 0.5, 0.8] },
  }) },
  { t: 1.2, pose: R({}) },
], 1.2);

const backhand = keyed([
  { t: 0, pose: R({}) },
  { t: 0.14, pose: R({
    hipR: [14, 12, 0], sp: [10, 16, 1],
    rh: { p: [0.02, 1.08, 0.34], pole: [0.2, -1, 0.2], tip: [0.3, 0.85, 0], face: [0.85, 0, 0.3] },
  }) },
  { t: 0.28, pose: R({
    hip: [0.04, -0.1, -0.02], hipR: [13, 26, 0], sp: [9, 38, 3], look: [12, 6, 0],
    rf: foot(-0.13, 0.12, 5, 12, 0.035, 5), lf: foot(0.22, -0.03, 32),
    rh: { p: [0.26, 1.02, 0.1], pole: [0.4, -1, 0.5], tip: [0.45, 0.55, -0.7], face: [-0.35, -0.1, -0.93] },
    lh: { p: [0.22, 1.1, 0.18], pole: [0.6, -1, -0.2], fing: [-0.6, 0.2, 0.75], palm: [-0.3, -0.3, -0.9] },
  }) },
  { t: 0.42, pose: R({
    hip: [0.01, -0.11, 0.03], hipR: [13, 14, 0], sp: [10, 20, 2], look: [8, 8, 0],
    rf: foot(-0.13, 0.28, -2), lf: foot(0.22, -0.03, 25, 8),
    rh: { p: [0.02, 0.95, 0.3], pole: [0.2, -1, 0.3], tip: [0.65, 0.25, -0.7], face: [-0.3, 0.05, -0.95] },
    lh: { p: [0.26, 1.08, 0.05], pole: [0.6, -1, -0.2], fing: [0, -0.2, 1], palm: [-0.8, -0.4, 0] },
  }) },
  { t: 0.5, pose: R({
    hip: [-0.02, -0.115, 0.07], hipR: [13, -4, 0], sp: [12, -8, 0], look: [5, 10, 0],
    rf: foot(-0.13, 0.28, -2), lf: foot(0.22, -0.03, 15, 20),
    rh: { p: [-0.36, 0.98, 0.46], pole: [-0.2, -1, 0.1], tip: [-0.85, 0.4, -0.15], face: [0, 0.1, -1] },
    lh: { p: [0.3, 1.06, -0.1], pole: [0.5, -1, 0], fing: [0.4, -0.3, -0.8], palm: [-0.6, -0.6, 0.3] },
  }) },
  { t: 0.68, pose: R({
    hip: [-0.04, -0.085, 0.1], hipR: [11, -20, 0], sp: [8, -28, 0], look: [-5, 4, 0],
    rf: foot(-0.13, 0.28, -2), lf: foot(0.2, 0, -5, 40),
    rh: { p: [-0.56, 1.46, 0.22], pole: [-0.2, -0.6, -1], tip: [-0.35, 0.9, 0.05], face: [0.15, 0.05, -1] },
    lh: { p: [0.36, 1.02, -0.22], pole: [0.5, -1, 0], fing: [0.5, -0.4, -0.8], palm: [0, -0.6, 0.6] },
  }) },
  { t: 0.92, pose: R({
    hip: [-0.02, -0.095, 0.05], hipR: [13, -8, 0], sp: [10, -10, 0],
    rf: foot(-0.18, 0.12, -6, 0, 0.03, 0), lf: foot(0.2, 0, 10, 10),
    rh: { p: [-0.22, 1.02, 0.46], tip: [-0.2, 0.85, 0.45], face: [-0.9, 0.1, 0.3] },
  }) },
  { t: 1.2, pose: R({}) },
], 1.2);

// The serve stance, as real players stand behind the baseline: staggered feet (front foot opposite
// the paddle), soft knees, weight a little back, shoulders turned slightly to the paddle side,
// paddle low by the hip, and the ball resting on the open palm in front at waist height.
// The ball hand sits exactly where the game keeps the waiting ball (0.74 ft to the free side,
// 3.2 ft up, 0.7 ft forward), so the ball rests in the palm with no reaching.
const SERVE_SET = {
  hip: [0.02, -0.06, -0.015], hipR: [10, -12, 0], sp: [6, -9, 1], look: [8, 12, 0],
  lf: foot(0.13, 0.22, 14), rf: foot(-0.15, -0.16, -30),
  lh: { p: [0.209, 0.896, 0.145], pole: [0.6, -0.6, -0.5], fing: [0.25, 0, 1], palm: [0, 1, 0] },
  rh: { p: [-0.24, 0.86, 0.02], pole: [-0.3, -0.2, -1], tip: [-0.08, -0.8, 0.6], face: [0.05, 0.6, 0.8] },
};
function serveWait(t, dur) { // settled, breathing, eyes on the target
  const ph = (TAU * t) / dur;
  return R0(merge(SERVE_SET, { sp: [6 + 0.8 * Math.sin(ph), -9, 1], hip: [0.02, -0.06 + 0.004 * Math.sin(ph), -0.015] }));
}
const serve = keyed([
  { t: 0, pose: R(SERVE_SET) },
  { t: 0.5, pose: R(merge(SERVE_SET, {
    hip: [-0.02, -0.06, -0.05], hipR: [8, -24, 0], sp: [8, -26, 0],
    rh: { p: [-0.36, 0.86, -0.32], pole: [-0.3, 0, -1], tip: [0, -0.85, -0.5], face: [0, -0.5, 0.85] },
  })) },
  { t: 0.72, pose: R(merge(SERVE_SET, {
    hip: [0, -0.065, 0.02], hipR: [8, -10, 0], sp: [9, -10, 0], look: [-4, 16, 0],
    lh: { p: [0.03, 0.99, 0.44], fing: [0, -0.2, 1], palm: [0, 0, 1] },
    rh: { p: [-0.3, 0.78, 0.0], pole: [-0.3, -0.3, -1], tip: [-0.15, -0.98, 0], face: [0, -0.1, 1] },
  })) },
  { t: 0.85, pose: R(merge(SERVE_SET, {
    hip: [0.02, -0.065, 0.08], hipR: [8, 4, 0], sp: [10, 4, 0], look: [-3, 18, 0],
    rf: foot(-0.17, -0.15, -18, 18),
    rh: { p: [-0.2, 0.8, 0.36], pole: [-0.3, -0.6, -1], tip: [-0.3, -0.65, 0.7], face: [0, 0.7, 0.7] },
    lh: { p: [0.22, 1.02, 0.26], pole: [0.6, -1, -0.3], fing: [0.5, 0, 0.85], palm: [0, -1, 0] },
  })) },
  { t: 1.15, pose: R(merge(SERVE_SET, {
    hip: [0.03, -0.05, 0.12], hipR: [6, 18, 0], sp: [6, 22, 0], look: [0, 10, 0],
    rf: foot(-0.15, -0.1, -5, 42),
    rh: { p: [-0.1, 1.46, 0.5], pole: [-0.4, -0.8, -0.6], tip: [-0.1, 0.9, 0.4], face: [0, -0.4, 0.9] },
    lh: { p: [0.27, 1.04, 0.04], pole: [0.6, -1, -0.3], fing: [0.1, -0.5, 0.85], palm: [-0.9, 0, 0.2] },
  })) },
  { t: 1.38, pose: R({
    hip: [0.01, -0.08, 0.05], hipR: [11, 6, 0], sp: [8, 8, 0],
    lf: foot(0.15, 0.1, 12), rf: foot(-0.19, -0.06, -15, 0, 0.035, 0),
    rh: { p: [-0.15, 1.03, 0.48], tip: [-0.12, 0.8, 0.55], face: [0, 0.55, 0.85] },
  }) },
  { t: 1.6, pose: R({}) },
], 1.6);

const smash = keyed([
  { t: 0, pose: R({}) },
  { t: 0.18, pose: R({
    hip: [-0.02, -0.07, -0.03], hipR: [8, -22, 0], sp: [0, -18, -3], look: [-5, -15, 0],
    rh: { p: [-0.35, 1.45, 0.05], pole: [-0.8, -0.3, -0.4], tip: [-0.2, 0.6, -0.75], face: [-0.9, 0.1, 0.3] },
    lh: { p: [0.1, 1.6, 0.4], pole: [0.6, -0.6, -0.4], fing: [-0.1, 0.8, 0.5], palm: [-0.3, 0.2, 0.9] },
  }) },
  { t: 0.38, pose: R({
    hip: [-0.04, -0.05, -0.06], hipR: [2, -40, 0], sp: [-10, -32, -6], look: [-10, -32, 0],
    lf: foot(0.18, 0.12, 18, 10), rf: foot(-0.22, -0.2, -50),
    rh: { p: [-0.27, 1.66, -0.14], pole: [-0.8, 0.1, -0.5], tip: [0.1, -0.7, -0.7], face: [-0.7, 0.4, -0.2] },
    lh: { p: [0.06, 1.92, 0.36], pole: [0.6, -0.5, -0.4], fing: [-0.05, 0.9, 0.4], palm: [-0.2, 0.3, 0.9] },
  }) },
  { t: 0.5, pose: R({
    hip: [-0.02, -0.02, -0.02], hipR: [4, -22, 0], sp: [-4, -18, -4], look: [-5, -30, 0],
    lf: foot(0.18, 0.12, 15, 20), rf: foot(-0.22, -0.2, -42, 20),
    rh: { p: [-0.24, 1.85, 0.1], pole: [-0.9, 0.2, -0.4], tip: [-0.75, 0.6, -0.2], face: [-0.3, -0.2, 0.9] },
    lh: { p: [0.12, 1.55, 0.3], pole: [0.6, -0.6, -0.4], fing: [-0.2, 0.5, 0.8], palm: [-0.5, -0.3, 0.6] },
  }) },
  { t: 0.58, pose: R({
    hip: [0, 0, 0.02], hipR: [6, -2, 0], sp: [6, 4, 0], look: [0, -28, 0],
    lf: foot(0.18, 0.12, 12, 28), rf: foot(-0.22, -0.2, -35, 32),
    rh: { p: [-0.18, 1.98, 0.28], pole: [-0.9, 0.1, -0.4], tip: [0, 0.8, 0.6], face: [0, -0.6, 0.8] },
    lh: { p: [0.14, 1.22, 0.22], pole: [0.6, -1, -0.3], fing: [-0.4, 0, 1], palm: [-0.5, -0.6, -0.6] },
  }) },
  { t: 0.82, pose: R({
    hip: [0.03, -0.11, 0.12], hipR: [18, 26, 0], sp: [24, 28, 0], look: [3, 15, 0],
    lf: foot(0.18, 0.12, 10), rf: foot(-0.2, -0.02, -5, 40),
    rh: { p: [0.24, 0.96, 0.3], pole: [-0.3, -0.4, -1], tip: [0.3, -0.75, 0.55], face: [-0.3, -0.6, -0.7] },
    lh: { p: [0.26, 1.06, -0.04], pole: [0.6, -1, -0.3], fing: [0, -0.5, 0.85], palm: [-0.9, 0, 0.2] },
  }) },
  { t: 1.08, pose: R({
    hip: [0.01, -0.1, 0.05], hipR: [14, 8, 0], sp: [12, 8, 0],
    lf: foot(0.19, 0.06, 12), rf: foot(-0.21, -0.06, -15, 0, 0.03, 0),
    rh: { p: [-0.05, 1.12, 0.4], tip: [0.15, 0.2, 0.97], face: [-0.2, 0.95, -0.15] },
  }) },
  { t: 1.4, pose: R({}) },
], 1.4);

// ---------------------------------------------------------------- locomotion
// Every gait is "in place" with an exact treadmill: a planted foot slides backward at exactly
// cycleDist / period, so when the game moves the player at that speed the foot stays put.
// Phase 0 = right foot lands (all gaits share this, so they blend in step).
const ease3 = q => q * q * (3 - 2 * q);
/** 0..1 over the swing, starting and ending with slope m (to match the planted foot's speed). */
const swingCurve = (q, m) => { const q2 = q * q, q3 = q2 * q; return (q2 * 3 - q3 * 2) + (q3 - 2 * q2 + q) * m + (q3 - q2) * m; };
const wrap = x => ((x % 1) + 1) % 1;

/** Forward (dir = 1) or backward (dir = -1) gait. */
function gait(o) {
  const { T, D, duty, lift, kick = 0, lean, crouch, bob, hipYaw, arm, dir = 1, zc = 0.02, width = 0.1, ready = false } = o;
  const Ls = D * duty;
  const footAt = (ph, S) => {
    let z, up = 0, heel, toe;
    if (ph < duty) { // planted: rolls heel to toe, sliding back under the body
      const q = ph / duty;
      z = zc + dir * (Ls / 2 - q * Ls);
      heel = dir > 0 ? lerpN(-6 * (lift > 0.1 ? 1 : 0.5), 38, smooth(0.45, 1, q)) * smooth(0, 0.25, q) + (q < 0.25 ? -6 * (1 - q / 0.25) : 0) : 14;
      toe = -Math.max(0, heel);
    } else { // swing: lift, carry through, reach for the next landing
      const q = (ph - duty) / (1 - duty);
      z = zc + dir * (-Ls / 2 + Ls * swingCurve(q, -(1 - duty) / duty));
      up = lift * Math.sin(Math.PI * q) ** 0.9 + kick * Math.sin(Math.PI * Math.min(1, q * 1.6)) ** 2 * (1 - q);
      heel = dir > 0 ? lerpN(40, -10, smooth(0.15, 0.9, q)) : lerpN(20, 10, q);
      toe = 0;
    }
    return { x: S * width, z, yaw: S * 4, heel, lift: up, toe };
  };
  return (t, dur) => {
    const ph = t / dur;
    const R = footAt(wrap(ph), -1), L = footAt(wrap(ph + 0.5), 1);
    const c = Math.cos(TAU * ph);
    const y = crouch - bob * Math.cos(TAU * 2 * (ph - duty / 2));
    const base = {
      hip: [0.008 * Math.sin(TAU * ph), y, 0],
      hipR: [lean * 0.45, hipYaw * c * dir, -2.5 * Math.sin(TAU * ph)],
      sp: [lean * 0.55, -hipYaw * 1.7 * c * dir, 1.5 * Math.sin(TAU * ph)],
      look: [0, 4, 0],
      rf: R, lf: L,
    };
    if (ready) { // paddle up in front, arms quiet (backpedal: still watching the ball)
      const b = Math.sin(TAU * 2 * ph);
      return R0({ ...base, rh: { p: [-0.16, 1.0 + 0.01 * b, 0.48] }, lh: { p: [0.03, 0.99 + 0.01 * b, 0.45] } });
    }
    return R0({
      ...base,
      rh: { p: [-0.2, 1.04 - arm * 0.25 * c, 0.1 - arm * c], pole: [-0.3, -0.5, -1], tip: [-0.1, 0.55, 0.85], face: [1, 0, -0.1] },
      lh: { p: [0.19, 1.04 + arm * 0.25 * c, 0.1 + arm * c], pole: [0.3, -0.5, -1], fing: [0, -0.35, 0.95], palm: [-1, 0, 0] },
    });
  };
}
const lerpN = (a, b, t) => a + (b - a) * t;
const R0 = over => merge(READY, over);

// Side shuffle: lead foot reaches, trail foot pushes and gathers (never crossing), with a
// short flight. D = +1 moves to the player's left (+X), -1 to the right.
const SHUFFLE = { T: 0.38, D: 0.95 };
function shuffle(Dsign) {
  const Ls = SHUFFLE.D * 0.52;
  const foot = (ph, start, u0) => {
    const q = wrap(ph - start);
    if (q < 0.52) return { u: u0 - (q / 0.52) * Ls, lift: 0, air: false };
    const k = (q - 0.52) / 0.48;
    return { u: u0 - Ls + Ls * swingCurve(k, -0.48 / 0.52), lift: 0.075 * Math.sin(Math.PI * k), air: true };
  };
  return (t, dur) => {
    const ph = t / dur;
    const lead = foot(ph, 0.1, 0.42), trail = foot(ph, 0.4, -0.03);
    const mk = (f, isLeft) => foot0(Dsign * f.u, 0.03, (isLeft ? 1 : -1) * 10 + Dsign * 6, f.air ? 0 : 6, f.lift, f.air ? 6 : -6);
    const leadLeft = Dsign > 0;
    const fly = Math.sin(TAU * (ph - 0.25)); // highest in the flight phase
    return R0({
      hip: [Dsign * 0.02 * Math.sin(TAU * ph), -0.115 + 0.018 * fly, 0],
      hipR: [15, 0, -Dsign * 2.5 * Math.sin(TAU * ph)],
      sp: [11, -Dsign * 3, Dsign * 3],
      look: [Dsign * -3, 5, 0],
      lf: mk(leadLeft ? lead : trail, true),
      rf: mk(leadLeft ? trail : lead, false),
      rh: { p: [-0.16, 1.0 + 0.012 * fly, 0.48] },
      lh: { p: [0.03, 0.99 + 0.012 * fly, 0.45] },
    });
  };
}
const foot0 = (x, z, yaw, heel = 0, lift = 0, toe = null) => ({ x, z, yaw, heel, lift, toe: toe == null ? (lift < 0.01 ? -heel : 0) : toe });

const GAITS = {
  Walk: { T: 1.05, D: 1.5, duty: 0.62, lift: 0.07, lean: 4, crouch: -0.02, bob: 0.018, hipYaw: 6, arm: 0.1, zc: 0.03 },
  Run: { T: 0.7, D: 2.2, duty: 0.4, lift: 0.17, kick: 0.16, lean: 10, crouch: -0.06, bob: 0.024, hipYaw: 8, arm: 0.2 },
  Sprint: { T: 0.62, D: 3.4, duty: 0.32, lift: 0.22, kick: 0.24, lean: 17, crouch: -0.075, bob: 0.03, hipYaw: 10, arm: 0.27, zc: 0.04 },
  Backpedal: { T: 0.62, D: 1.4, duty: 0.45, lift: 0.09, lean: 12, crouch: -0.1, bob: 0.015, hipYaw: 4, arm: 0, dir: -1, zc: 0, width: 0.13, ready: true },
};

// The umpire, seated on the high chair: thighs level, feet on the footrest, hands on the knees.
function refSit(t, dur) {
  const ph = (TAU * t) / dur;
  return R0({
    hip: [0, 0, 0], hipR: [-4, 0, 0], sp: [4 + 1.2 * Math.sin(2 * ph), 0, 0], look: [0, 6, 0],
    lf: foot0(0.13, 0.42, 6, 0, 0.43), rf: foot0(-0.13, 0.42, -6, 0, 0.43),
    rh: { p: [-0.13, 0.99, 0.3], pole: [-0.5, -0.3, -1], tip: [1, 0, 0.2], face: [0, -1, 0] },
    lh: { p: [0.13, 0.99, 0.3], pole: [0.5, -0.3, -1], fing: [0, -0.1, 1], palm: [0, -1, 0] },
  });
}

export const CLIPS = [
  { name: 'TPose', dur: 1 / 30, fn: null },
  { name: 'Idle', dur: 4.0, loop: true, fn: idle },
  { name: 'Ready', dur: 2.0, loop: true, fn: ready },
  { name: 'Forehand', dur: 1.2, fn: forehand },
  { name: 'Backhand', dur: 1.2, fn: backhand },
  { name: 'Serve', dur: 1.6, fn: serve },
  { name: 'Smash', dur: 1.4, fn: smash },
  ...Object.entries(GAITS).map(([name, g]) => ({ name, dur: g.T, loop: true, fn: gait(g), extras: { cycleDist: g.D, speed: g.D / g.T } })),
  { name: 'StrafeLeft', dur: SHUFFLE.T, loop: true, fn: shuffle(1), extras: { cycleDist: SHUFFLE.D, speed: SHUFFLE.D / SHUFFLE.T } },
  { name: 'StrafeRight', dur: SHUFFLE.T, loop: true, fn: shuffle(-1), extras: { cycleDist: SHUFFLE.D, speed: SHUFFLE.D / SHUFFLE.T } },
  { name: 'RefSit', dur: 4.0, loop: true, fn: refSit },
  { name: 'ServeWait', dur: 3.0, loop: true, fn: serveWait },
];

export const FPS = 30;

/** Sample every clip into per-bone rotation tracks + a hips translation track. */
export function bakeClips() {
  return CLIPS.map(c => {
    const frames = Math.max(2, Math.round(c.dur * FPS) + 1);
    const times = [], rot = BONES.map(() => []), hip = [];
    for (let f = 0; f < frames; f++) {
      const t = (c.dur * f) / (frames - 1);
      times.push(t);
      let q, h;
      if (!c.fn) {
        q = BONES.map(() => qId());
        h = P0(B.Hips);
      } else {
        const s = solvePose(c.fn(t, c.dur));
        q = s.q;
        h = s.hip;
      }
      q.forEach((qq, i) => {
        const prev = rot[i][rot[i].length - 1];
        rot[i].push(prev && dot4(prev, qq) < 0 ? qq.map(v => -v) : qq);
      });
      hip.push(h);
    }
    return { name: c.name, loop: !!c.loop, times, rot, hip, extras: c.extras };
  });
}
const dot4 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
