// Small vector / quaternion helpers (quaternions are [x, y, z, w], glTF order).

export const DEG = Math.PI / 180;

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = a => Math.hypot(a[0], a[1], a[2]);
export const norm = a => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const lerp = (a, b, t) => a + (b - a) * t;
export const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const gauss = (dx, dy, sx, sy) => Math.exp(-0.5 * ((dx / sx) ** 2 + (dy / sy) ** 2));

// ---------- quaternions ----------
export const qId = () => [0, 0, 0, 1];

export function qMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
export const qConj = q => [-q[0], -q[1], -q[2], q[3]];
export function qNorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function qAxis(axis, ang) {
  const n = norm(axis);
  const s = Math.sin(ang / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(ang / 2)];
}
export function qRot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}
/** Degrees. Applied as yaw (Y) * pitch (X) * roll (Z). +pitch tips +Y toward +Z (lean forward). */
export function qEuler(pitch, yaw, roll) {
  return qMul(qMul(qAxis([0, 1, 0], yaw * DEG), qAxis([1, 0, 0], pitch * DEG)), qAxis([0, 0, 1], roll * DEG));
}
/** Rotation matrix given as three columns -> quaternion. */
export function qFromCols(c0, c1, c2) {
  const m00 = c0[0], m10 = c0[1], m20 = c0[2];
  const m01 = c1[0], m11 = c1[1], m21 = c1[2];
  const m02 = c2[0], m12 = c2[1], m22 = c2[2];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  return qNorm([x, y, z, w]);
}
/** Orientation whose X axis is `d` and Y axis is `n` (orthogonalised against d). */
export function basisQ(d, n) {
  const x = norm(d);
  const y = norm(sub(n, mul(x, dot(n, x))));
  return qFromCols(x, y, cross(x, y));
}
/** Rotation that carries the rest frame (d0, n0) onto (d, n). */
export function frameRot(d, n, d0, n0) {
  return qMul(basisQ(d, n), qConj(basisQ(d0, n0)));
}
export function qAngle(q) {
  return 2 * Math.acos(clamp(Math.abs(q[3]), 0, 1));
}
/** Scale a rotation's angle by t (shortest arc). */
export function qPow(q, t) {
  let p = q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
  const ang = 2 * Math.acos(clamp(p[3], -1, 1));
  const s = Math.sin(ang / 2);
  if (Math.abs(s) < 1e-8) return [0, 0, 0, 1];
  return qAxis([p[0] / s, p[1] / s, p[2] / s], ang * t);
}
/** Twist of q about unit `axis`, as a signed angle (radians). q = twist * swing = swing' * twist. */
export function twistAngle(q, axis) {
  const p = dot([q[0], q[1], q[2]], axis);
  let a = 2 * Math.atan2(p, q[3]);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
export function qSlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { d = -d; bb = b.map(v => -v); }
  if (d > 0.9995) return qNorm(a.map((v, i) => v + (bb[i] - v) * t));
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return a.map((v, i) => v * wa + bb[i] * wb);
}

// sRGB (0-1) -> linear, for glTF baseColorFactor
export const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const hexLinear = hex => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => srgbToLinear(v / 255));
};
