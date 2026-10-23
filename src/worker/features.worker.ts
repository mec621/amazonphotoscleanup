/// <reference lib="webworker" />
// Turns one thumbnail Blob into Features. Runs off the UI thread; models load on first use.

import { exposureClipping, laplacianVariance, phash, toGray } from '../imaging/pixels';
import type { Features } from '../shared/types';

export const FEATURES_VERSION = 1;
const SIZE = 256;

export type WorkerRequest = {
  id: string;
  blob: Blob;
  extensionBase: string;
  useEmbeddings: boolean;
  useFaces: boolean;
  /** Features already computed for this photo; only missing parts are filled in. */
  existing?: Features;
};
export type WorkerResponse = { id: string; features?: Features; error?: string; warnings?: string[] };

async function analyze(req: WorkerRequest): Promise<WorkerResponse> {
  const bitmap = await createImageBitmap(req.blob);
  const scale = SIZE / Math.max(bitmap.width, bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, w, h).data;

  let f: Features = req.existing ?? (() => {
    const gray = toGray(rgba, w, h);
    return { id: req.id, phash: phash(gray, w, h), sharpness: laplacianVariance(gray, w, h), ...exposureClipping(gray), version: FEATURES_VERSION };
  })();

  const warnings: string[] = [];
  if (req.useEmbeddings && f.embedding === undefined) {
    try {
      const { clipFeatures } = await import('./clip');
      f = { ...f, ...(await clipFeatures(rgba, w, h)) };
    } catch (e) {
      warnings.push(`embedding model: ${String(e)}`);
    }
  }
  if (req.useFaces && f.faces === undefined) {
    try {
      const { faceStats } = await import('./faces');
      f = { ...f, faces: await faceStats(req.extensionBase, canvas) };
    } catch (e) {
      warnings.push(`face model: ${String(e)}`);
    }
  }
  return { id: req.id, features: f, warnings };
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  let res: WorkerResponse;
  try {
    res = await analyze(ev.data);
  } catch (e) {
    res = { id: ev.data.id, error: String(e) };
  }
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(res);
};
