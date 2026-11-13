// Minimal glTF 2.0 binary (.glb) writer: many skinned meshes (parts) on one skeleton + animations.
import { BONES, restLocal } from './rig.mjs';
import { hexLinear, cross, sub, add, norm } from './math.mjs';

const FLOAT = 5126, BYTE = 5120, UBYTE = 5121, SHORT = 5122, USHORT = 5123, UINT = 5125;
const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;

export function computeNormals(pos, groups) {
  const n = pos.map(() => [0, 0, 0]);
  for (const idx of groups.values()) {
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      const f = cross(sub(pos[b], pos[a]), sub(pos[c], pos[a])); // area-weighted
      n[a] = add(n[a], f); n[b] = add(n[b], f); n[c] = add(n[c], f);
    }
  }
  return n.map(v => (v[0] || v[1] || v[2] ? norm(v) : [0, 1, 0]));
}

/** parts: [{ name, mb }] — each becomes a mesh node skinned to the shared skeleton. */
export function buildGLB({ parts, materials, clips, name = 'PickleballPlayer' }) {
  const chunks = [];
  let byteLength = 0;
  const bufferViews = [], accessors = [];
  const push = (typed, target, byteStride) => {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); byteLength += pad; }
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, ...(target ? { target } : {}), ...(byteStride ? { byteStride } : {}) });
    chunks.push(bytes);
    byteLength += bytes.byteLength;
    return bufferViews.length - 1;
  };
  const accessor = (typed, type, componentType, count, target, extra = {}, byteStride = 0) => {
    accessors.push({ bufferView: push(typed, target, byteStride), componentType, count, type, ...extra });
    return accessors.length - 1;
  };
  const minmax = (arr, k) => {
    const min = Array(k).fill(Infinity), max = Array(k).fill(-Infinity);
    for (let i = 0; i < arr.length; i++) {
      const c = i % k;
      if (arr[i] < min[c]) min[c] = arr[i];
      if (arr[i] > max[c]) max[c] = arr[i];
    }
    return { min, max };
  };

  // ---- materials (shared by every part)
  const matNames = [...new Set(parts.flatMap(p => [...p.mb.groups.keys()]))];
  for (const m of matNames) if (!materials[m]) throw new Error(`no material "${m}"`);
  const gltfMaterials = matNames.map(m => {
    const def = materials[m];
    return {
      name: m,
      pbrMetallicRoughness: { baseColorFactor: [...hexLinear(def.color), 1], metallicFactor: def.metal || 0, roughnessFactor: def.rough },
      ...(def.doubleSided ? { doubleSided: true } : {}),
    };
  });

  // ---- one mesh per part
  let vertices = 0, triangles = 0;
  const dequant = [];
  const meshes = parts.map(({ name: pname, mb }) => {
    const nv = mb.pos.length;
    vertices += nv;
    const normals = computeNormals(mb.pos, mb.groups);
    // positions: int16, centred on the part, one uniform scale (normals stay correct after skinning)
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of mb.pos) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const off = lo.map((v, k) => (v + hi[k]) / 2);
    const scale = Math.max(...hi.map((v, k) => (v - lo[k]) / 2), 1e-6);
    const P = new Int16Array(nv * 4); // xyz + pad: each vertex on a 4-byte boundary (stride 8)
    const qmin = [32767, 32767, 32767], qmax = [-32767, -32767, -32767];
    mb.pos.forEach((p, i) => {
      for (let k = 0; k < 3; k++) {
        const q = Math.max(-32767, Math.min(32767, Math.round(((p[k] - off[k]) / scale) * 32767)));
        P[i * 4 + k] = q;
        qmin[k] = Math.min(qmin[k], q); qmax[k] = Math.max(qmax[k], q);
      }
    });
    const Nn = new Int8Array(nv * 4); // xyz + pad (stride 4)
    normals.forEach((n, i) => { for (let k = 0; k < 3; k++) Nn[i * 4 + k] = Math.round(n[k] * 127); });
    dequant.push({ off, scale });
    const J = new Uint8Array(nv * 4), Wt = new Uint8Array(nv * 4);
    mb.skin.forEach((ws, i) => {
      // weights as normalised bytes that still sum to exactly 255
      const q = ws.map(([, w]) => Math.round(w * 255));
      const diff = 255 - q.reduce((a, b) => a + b, 0);
      if (q.length) q[0] += diff;
      ws.forEach(([j], k) => { J[i * 4 + k] = j; Wt[i * 4 + k] = q[k]; });
    });
    const attributes = {
      POSITION: accessor(P, 'VEC3', SHORT, nv, ARRAY_BUFFER, { normalized: true, min: qmin, max: qmax }, 8),
      NORMAL: accessor(Nn, 'VEC3', BYTE, nv, ARRAY_BUFFER, { normalized: true }, 4),
      JOINTS_0: accessor(J, 'VEC4', UBYTE, nv, ARRAY_BUFFER),
      WEIGHTS_0: accessor(Wt, 'VEC4', UBYTE, nv, ARRAY_BUFFER, { normalized: true }),
    };
    const primitives = [...mb.groups.keys()].map(m => {
      const idx = mb.groups.get(m);
      triangles += idx.length / 3;
      const big = nv > 65535;
      return {
        attributes,
        indices: accessor(big ? new Uint32Array(idx) : new Uint16Array(idx), 'SCALAR', big ? UINT : USHORT, idx.length, ELEMENT_ARRAY_BUFFER),
        material: matNames.indexOf(m),
      };
    });
    return { name: pname, primitives };
  });

  // ---- skeleton
  const nodes = BONES.map((b, i) => ({
    name: b.name,
    translation: restLocal[i],
    children: BONES.map((c, k) => (c.parent === i ? k : -1)).filter(k => k >= 0),
  }));
  nodes.forEach(n => { if (!n.children.length) delete n.children; });
  // one skin per part: its inverse bind matrices also undo that part's position quantization
  // (KHR_mesh_quantization: IBM' = IBM * T(offset) * S(scale)); joint 0 (Root) has IBM = identity
  const skins = meshes.map((m, i) => {
    const { off, scale } = dequant[i];
    const ibm = new Float32Array(BONES.length * 16);
    BONES.forEach((b, j) => ibm.set([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, off[0] - b.pos[0], off[1] - b.pos[1], off[2] - b.pos[2], 1], j * 16));
    return { name: `${m.name}_skin`, joints: BONES.map((_, j) => j), inverseBindMatrices: accessor(ibm, 'MAT4', FLOAT, BONES.length), skeleton: 0 };
  });
  const partNodes = meshes.map((m, i) => { nodes.push({ name: m.name, mesh: i, skin: i }); return nodes.length - 1; });

  // ---- animations
  const hipIdx = BONES.findIndex(b => b.name === 'Hips');
  const animations = clips.map(c => {
    const input = accessor(new Float32Array(c.times), 'SCALAR', FLOAT, c.times.length, undefined, { min: [c.times[0]], max: [c.times[c.times.length - 1]] });
    const samplers = [], channels = [];
    c.rot.forEach((track, bi) => {
      samplers.push({ input, output: accessor(new Float32Array(track.flat()), 'VEC4', FLOAT, track.length), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: bi, path: 'rotation' } });
    });
    samplers.push({ input, output: accessor(new Float32Array(c.hip.flat()), 'VEC3', FLOAT, c.hip.length), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: hipIdx, path: 'translation' } });
    return { name: c.name, samplers, channels, extras: { loop: c.loop, ...(c.extras || {}) } };
  });

  const json = {
    asset: { version: '2.0', generator: 'PickleBall Hyper procedural avatar builder' },
    extensionsUsed: ['KHR_mesh_quantization'],
    extensionsRequired: ['KHR_mesh_quantization'],
    scene: 0,
    // skinned meshes and the skeleton root all sit at the scene root (glTF best practice)
    scenes: [{ name, nodes: [0, ...partNodes] }],
    nodes,
    meshes,
    materials: gltfMaterials,
    skins,
    animations,
    accessors,
    bufferViews,
    buffers: [{ byteLength: 0 }],
  };
  const pad = (4 - (byteLength % 4)) % 4;
  if (pad) { chunks.push(new Uint8Array(pad)); byteLength += pad; }
  json.buffers[0].byteLength = byteLength;

  let jsonStr = JSON.stringify(json);
  while (Buffer.byteLength(jsonStr) % 4) jsonStr += ' ';
  const jsonBuf = Buffer.from(jsonStr);
  const bin = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return {
    glb: Buffer.concat([head, jh, jsonBuf, bh, bin]),
    stats: { parts: parts.length, vertices, triangles, materials: matNames.length, bones: BONES.length, clips: clips.length },
  };
}
