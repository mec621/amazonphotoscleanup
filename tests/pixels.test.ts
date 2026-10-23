import { describe, expect, it } from 'vitest';
import { exposureClipping, hamming, laplacianVariance, phash } from '../src/imaging/pixels';

function image(w: number, h: number, f: (x: number, y: number) => number): Float32Array {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = f(x, y);
  return g;
}

function blur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          s += src[yy * w + xx];
          n++;
        }
      out[y * w + x] = s / n;
    }
  return out;
}

const scene = (x: number, y: number) => 128 + 60 * Math.sin(x / 9) * Math.cos(y / 13) + (((x >> 4) + (y >> 4)) % 2 ? 40 : -40);
const other = (x: number, y: number) => 128 + 100 * Math.sin((x + y) / 5);

describe('phash', () => {
  const W = 256;
  const H = 192;
  const a = image(W, H, scene);

  it('is 16 hex chars', () => {
    expect(phash(a, W, H)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('barely changes under brightness shift and mild blur', () => {
    const brighter = a.map((v) => Math.min(255, v + 15));
    expect(hamming(phash(a, W, H), phash(brighter, W, H))).toBeLessThanOrEqual(4);
    expect(hamming(phash(a, W, H), phash(blur(a, W, H, 1), W, H))).toBeLessThanOrEqual(6);
  });

  it('differs a lot for different images', () => {
    expect(hamming(phash(a, W, H), phash(image(W, H, other), W, H))).toBeGreaterThan(16);
  });
});

describe('laplacianVariance', () => {
  it('ranks a sharp image above its blurred copy', () => {
    const a = image(128, 128, scene);
    expect(laplacianVariance(a, 128, 128)).toBeGreaterThan(laplacianVariance(blur(a, 128, 128, 2), 128, 128) * 2);
  });
});

describe('exposureClipping', () => {
  it('counts blown and crushed pixels', () => {
    const g = new Float32Array([255, 255, 0, 128]);
    expect(exposureClipping(g)).toEqual({ clipHigh: 0.5, clipLow: 0.25 });
  });
});

describe('hamming', () => {
  it('counts differing bits', () => {
    expect(hamming('0000000000000000', '000000000000000f')).toBe(4);
    expect(hamming('ffffffffffffffff', 'ffffffffffffffff')).toBe(0);
  });
});
