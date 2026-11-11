// Colour helpers shared by the court renderer and the Customize previews.

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(rgb: number[]): string {
  return '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

export function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
}

// Memoized: the same few colours are shaded every frame
const shadeCache = new Map<string, string>();
export function shade(c: string, amt: number): string {
  const key = c + Math.round(amt * 100) / 100;
  let v = shadeCache.get(key);
  if (v === undefined) {
    v = amt >= 0 ? mix(c, '#ffffff', amt) : mix(c, '#000000', -amt);
    if (shadeCache.size > 2000) shadeCache.clear();
    shadeCache.set(key, v);
  }
  return v;
}

const rgbaCache = new Map<string, string>();
export function rgba(c: string, a: number): string {
  const key = c + '|' + a;
  let v = rgbaCache.get(key);
  if (v === undefined) {
    const [r, g, b] = hexToRgb(c);
    v = `rgba(${r},${g},${b},${a})`;
    if (rgbaCache.size > 2000) rgbaCache.clear();
    rgbaCache.set(key, v);
  }
  return v;
}

/** Small deterministic random generator so patterns look the same every time. */
export function seeded(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
