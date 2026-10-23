import { AmazonAdapter, SEARCH_OFFSET_CAP, SEARCH_PAGE_SIZE } from '../adapter/amazon';
import { allPartitions, deleteItems, itemIdsInPartition, putItems, putPartition, setMeta, updateAlbumMembership, type Partition } from '../db/store';
import type { Album, Scope } from '../shared/types';

export interface Progress {
  phase: string;
  done: number;
  total: number;
  message?: string;
}

export type OnProgress = (p: Progress) => void;

function partitionKey(year: number, month?: number): string {
  return month === undefined ? String(year) : `${year}-${String(month).padStart(2, '0')}`;
}

/** Search ranges small enough for the API's offset cap: whole years, or months for big years. */
async function plan(adapter: AmazonAdapter, scope: Scope, onProgress: OnProgress): Promise<{ year: number; month?: number; count: number }[]> {
  const now = new Date().getUTCFullYear();
  const years = scope.kind === 'year' ? [scope.year] : range(await adapter.oldestYear(), now);
  const out: { year: number; month?: number; count: number }[] = [];
  for (const [i, year] of years.entries()) {
    onProgress({ phase: 'Counting photos', done: i, total: years.length, message: String(year) });
    const count = await adapter.countPhotos(year);
    if (count <= SEARCH_OFFSET_CAP) {
      if (count > 0) out.push({ year, count });
      continue;
    }
    for (let month = 1; month <= 12; month++) {
      const c = await adapter.countPhotos(year, month);
      if (c > SEARCH_OFFSET_CAP) throw new Error(`${year}-${month} has ${c} photos, more than one search range can return.`);
      if (c > 0) out.push({ year, month, count: c });
    }
  }
  return out;
}

function range(a: number, b: number): number[] {
  return Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
}

/**
 * Indexes photo metadata. Resumable: each search range records its offset as it goes.
 * Ranges whose photo count hasn't changed since they last finished are skipped.
 */
export async function scanMetadata(adapter: AmazonAdapter, scope: Scope, onProgress: OnProgress, signal: AbortSignal): Promise<{ indexed: number; skippedShared: number }> {
  await setMeta('ownerId', adapter.ownerId || (await adapter.loadOwnerId()));
  const parts = await plan(adapter, scope, onProgress);
  const known = new Map((await allPartitions()).map((p) => [p.key, p]));
  const total = parts.reduce((s, p) => s + p.count, 0);
  let done = 0;
  let indexed = 0;
  let skippedShared = 0;

  for (const { year, month, count } of parts) {
    const key = partitionKey(year, month);
    const prev = known.get(key);
    if (prev?.done && prev.count === count) {
      done += count;
      continue;
    }
    // Resume an unfinished range only if it hasn't changed underneath us.
    const resume = prev && !prev.done && prev.count === count ? prev.offset : 0;
    const p: Partition = { key, year, month, count, offset: resume, done: false };
    const seen = new Set<string>();
    done += resume;
    while (p.offset < count) {
      if (signal.aborted) {
        await putPartition(p);
        throw new DOMException('Scan stopped', 'AbortError');
      }
      const page = await adapter.searchPage({ year, month, offset: p.offset });
      if (page.items.length === 0 && page.skippedShared === 0) break;
      await putItems(page.items, key);
      page.items.forEach((i) => seen.add(i.id));
      skippedShared += page.skippedShared;
      indexed += page.items.length;
      p.offset += SEARCH_PAGE_SIZE;
      done += Math.min(SEARCH_PAGE_SIZE, count - (p.offset - SEARCH_PAGE_SIZE));
      await putPartition(p);
      onProgress({ phase: 'Indexing metadata', done, total, message: key });
    }
    // A range read start to finish in one go tells us exactly what's there; drop what's gone.
    if (resume === 0) {
      const stale = (await itemIdsInPartition(key)).filter((id) => !seen.has(id));
      if (stale.length) await deleteItems(stale);
    }
    await putPartition({ ...p, offset: count, done: true, scannedAt: Date.now() });
  }
  await setMeta('lastScanAt', Date.now());
  return { indexed, skippedShared };
}

/** Maps every photo to the albums it's in. Album photos are protected from trash. */
export async function scanAlbums(adapter: AmazonAdapter, onProgress: OnProgress, signal: AbortSignal): Promise<Album[]> {
  const albums = await adapter.listAlbums();
  const membership = new Map<string, string[]>();
  for (const [i, album] of albums.entries()) {
    if (signal.aborted) throw new DOMException('Scan stopped', 'AbortError');
    onProgress({ phase: 'Reading albums', done: i, total: albums.length, message: album.name });
    const ids = await adapter.albumChildIds(album.id);
    album.count = ids.length;
    for (const id of ids) membership.set(id, [...(membership.get(id) ?? []), album.id]);
  }
  await updateAlbumMembership(membership);
  await setMeta('albums', albums);
  return albums;
}
