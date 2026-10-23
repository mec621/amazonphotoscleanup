// Pure pixel math on thumbnails: perceptual hash, sharpness, exposure.
// Inputs are plain arrays so this runs in a worker and in unit tests.

/** RGBA bytes to luminance 0..255. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  return g;
}

/** Box-filter resize of a grayscale image. */
export function resizeGray(src: Float32Array, w: number, h: number, ow: number, oh: number): Float32Array {
  const out = new Float32Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor((y * h) / oh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / oh));
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor((x * w) / ow);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / ow));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src[yy * w + xx];
      out[y * ow + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

const N = 32;
const DCT_COS = (() => {
  const c = new Float64Array(N * N);
  for (let u = 0; u < N; u++) for (let x = 0; x < N; x++) c[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  return c;
})();

/** 64-bit DCT perceptual hash (pHash) as 16 hex chars. */
export function phash(gray: Float32Array, w: number, h: number): string {
  const small = resizeGray(gray, w, h, N, N);
  // Only the top-left 8x8 block of the 2-D DCT is needed.
  const rows = new Float64Array(8 * N);
  for (let u = 0; u < 8; u++)
    for (let y = 0; y < N; y++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += small[y * N + x] * DCT_COS[u * N + x];
      rows[u * N + y] = s;
    }
  const coef = new Float64Array(64);
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rows[u * N + y] * DCT_COS[v * N + y];
      coef[v * 8 + u] = s;
    }
  const median = [...coef.slice(1)].sort((a, b) => a - b)[31];
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    let nib = 0;
    for (let b = 0; b < 4; b++) nib = (nib << 1) | (coef[i + b] > median ? 1 : 0);
    hex += nib.toString(16);
  }
  return hex;
}

const POPCOUNT = Array.from({ length: 16 }, (_, n) => (n & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1));

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POPCOUNT[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}

/** Variance of the 4-neighbour Laplacian. Higher = sharper. */
export function laplacianVariance(gray: Float32Array, w: number, h: number): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
      sum += l;
      sumSq += l * l;
      n++;
    }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Share of pixels blown out to white and crushed to black. */
export function exposureClipping(gray: Float32Array): { clipHigh: number; clipLow: number } {
  let hi = 0;
  let lo = 0;
  for (const v of gray) {
    if (v >= 250) hi++;
    else if (v <= 5) lo++;
  }
  return { clipHigh: hi / gray.length, clipLow: lo / gray.length };
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
