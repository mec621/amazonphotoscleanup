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

/** One search range to read: a year or a month, possibly from one end only. */
export interface RangePlan {
  key: string;
  year: number;
  month?: number;
  sort?: 'ASC' | 'DESC';
  /** Photos to read from this range. */
  count: number;
  /** Photos Amazon reports for the whole range. */
  total: number;
}

function rangeKey(year: number, month?: number): string {
  return month === undefined ? String(year) : `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Splits a range over the offset cap by reading it newest-first and oldest-first.
 * Covers up to twice the cap; the two halves meet in the middle.
 */
function bothEnds(year: number, month: number | undefined, total: number, ascendingSortWorks: boolean): RangePlan[] {
  const key = rangeKey(year, month);
  if (!ascendingSortWorks) throw new Error(`${key} has ${total.toLocaleString()} photos, too many for one search, and Amazon's month filter and oldest-first sort didn't work, so it can't be split. Please report this.`);
  if (total > 2 * SEARCH_OFFSET_CAP) throw new Error(`${key} has ${total.toLocaleString()} photos, more than this scanner can page through. Please report this.`);
  return [
    { key: `${key}-desc`, year, month, sort: 'DESC', count: SEARCH_OFFSET_CAP, total },
    { key: `${key}-asc`, year, month, sort: 'ASC', count: total - SEARCH_OFFSET_CAP, total },
  ];
}

/** Search ranges small enough for the API's offset cap: whole years, months for big years, or both ends of a range. */
export async function plan(adapter: Pick<AmazonAdapter, 'oldestYear' | 'countPhotos' | 'ascendingSortWorks'>, scope: Scope, onProgress: OnProgress): Promise<RangePlan[]> {
  const now = new Date().getUTCFullYear();
  const years = scope.kind === 'year' ? [scope.year] : range(await adapter.oldestYear(), now);
  const out: RangePlan[] = [];
  for (const [i, year] of years.entries()) {
    onProgress({ phase: 'Counting photos', done: i, total: years.length, message: String(year) });
    const count = await adapter.countPhotos(year);
    if (count <= SEARCH_OFFSET_CAP) {
      if (count > 0) out.push({ key: rangeKey(year), year, count, total: count });
      continue;
    }
    const months: number[] = [];
    for (let month = 1; month <= 12; month++) months.push(await adapter.countPhotos(year, month));
    // The month filter is unverified against Amazon: trust it only if the months add up to the year.
    const sum = months.reduce((a, b) => a + b, 0);
    const monthsWork = months.every((c) => c < count) && Math.abs(sum - count) <= Math.max(5, count * 0.01);
    if (!monthsWork) {
      out.push(...bothEnds(year, undefined, count, adapter.ascendingSortWorks));
      continue;
    }
    months.forEach((c, m) => {
      if (c === 0) return;
      if (c <= SEARCH_OFFSET_CAP) out.push({ key: rangeKey(year, m + 1), year, month: m + 1, count: c, total: c });
      else out.push(...bothEnds(year, m + 1, c, adapter.ascendingSortWorks));
    });
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

  for (const { key, year, month, sort, count, total: rangeTotal } of parts) {
    const prev = known.get(key);
    const unchanged = prev !== undefined && (prev.total ?? prev.count) === rangeTotal;
    if (prev?.done && unchanged) {
      done += count;
      continue;
    }
    // Resume an unfinished range only if it hasn't changed underneath us.
    const resume = prev && !prev.done && unchanged ? prev.offset : 0;
    const p: Partition = { key, year, month, sort, count, total: rangeTotal, offset: resume, done: false };
    const seen = new Set<string>();
    done += resume;
    while (p.offset < count) {
      if (signal.aborted) {
        await putPartition(p);
        throw new DOMException('Scan stopped', 'AbortError');
      }
      const page = await adapter.searchPage({ year, month, sort, offset: p.offset });
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
