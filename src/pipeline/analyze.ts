import type { AmazonAdapter } from '../adapter/amazon';
import { allFeatures, putFeatures } from '../db/store';
import type { Settings } from '../shared/settings';
import type { Features, PhotoItem } from '../shared/types';
import type { WorkerRequest, WorkerResponse } from '../worker/features.worker';
import { nearCandidates } from './group';
import type { OnProgress } from './scan';

const LANES = 3;

function needs(f: Features | undefined, s: { useEmbeddings: boolean; useFaces: boolean }): boolean {
  return !f || (s.useEmbeddings && f.embedding === undefined) || (s.useFaces && f.faces === undefined);
}

/**
 * Fetches a thumbnail for every photo that has a neighbour inside the time
 * window and computes its features in a worker. Thumbnails stay in memory.
 */
export async function analyzeCandidates(adapter: AmazonAdapter, items: PhotoItem[], settings: Settings, onProgress: OnProgress, signal: AbortSignal): Promise<{ analyzed: number; failed: number; warnings: string[] }> {
  const features = await allFeatures();
  const opts = { useEmbeddings: settings.useEmbeddings, useFaces: settings.useFaces };
  const todo = nearCandidates(items, settings.windowSeconds).filter((i) => needs(features.get(i.id), opts));
  const warnings = new Set<string>();
  if (!todo.length) return { analyzed: 0, failed: 0, warnings: [] };

  const worker = new Worker(new URL('../worker/features.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<string, (r: WorkerResponse) => void>();
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => pending.get(ev.data.id)?.(ev.data);
  const extensionBase = chrome.runtime.getURL('/');
  const run = (req: WorkerRequest) =>
    new Promise<WorkerResponse>((resolve) => {
      pending.set(req.id, (r) => {
        pending.delete(req.id);
        resolve(r);
      });
      worker.postMessage(req);
    });

  let next = 0;
  let done = 0;
  let failed = 0;
  const lane = async () => {
    while (next < todo.length && !signal.aborted) {
      const item = todo[next++];
      try {
        const blob = await adapter.fetchThumbnail(item.id);
        const res = await run({ id: item.id, blob, extensionBase, ...opts, existing: features.get(item.id) });
        if (res.error || !res.features) throw new Error(res.error ?? 'no features');
        for (const w of res.warnings ?? []) {
          warnings.add(w);
          // A model that failed to load will fail every time; stop asking for it this run.
          if (w.startsWith('embedding')) opts.useEmbeddings = false;
          if (w.startsWith('face')) opts.useFaces = false;
        }
        await putFeatures(res.features);
      } catch (e) {
        failed++;
        if (failed <= 3) warnings.add(`${item.name}: ${String(e)}`);
        // Several failures in a row usually mean the session or endpoint broke.
        if (failed >= 20 && failed > done / 2) throw new Error(`Too many thumbnail failures (${failed}). Last: ${String(e)}`);
      }
      done++;
      onProgress({ phase: 'Analyzing thumbnails', done, total: todo.length, message: opts.useEmbeddings || opts.useFaces ? 'first photos are slow while models load' : undefined });
    }
  };
  try {
    await Promise.all(Array.from({ length: LANES }, lane));
  } finally {
    worker.terminate();
  }
  if (signal.aborted) throw new DOMException('Scan stopped', 'AbortError');
  return { analyzed: done - failed, failed, warnings: [...warnings] };
}
