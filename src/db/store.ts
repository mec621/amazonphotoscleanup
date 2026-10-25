import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Decision, Features, PhotoItem, TrashRun } from '../shared/types';

export interface Partition {
  /** "2019"; "2019-07" when a year is too big for one search range; "2019-desc"/"2019-asc" when it's read from both ends. */
  key: string;
  year: number;
  month?: number;
  /** Read newest-first or oldest-first; only set when a range is read from both ends. */
  sort?: 'ASC' | 'DESC';
  /** Photos to read from this range. */
  count: number;
  /** Photos Amazon reported for the whole range when planned; a change means re-read it. */
  total?: number;
  offset: number;
  done: boolean;
  scannedAt?: number;
}

interface Schema extends DBSchema {
  items: { key: string; value: StoredItem; indexes: { year: number; md5: string; capturedAt: number; partition: string } };
  features: { key: string; value: Features };
  partitions: { key: string; value: Partition };
  decisions: { key: string; value: Decision };
  runs: { key: string; value: TrashRun };
  meta: { key: string; value: unknown };
}

export type DB = IDBPDatabase<Schema>;

/** A PhotoItem plus the search range it was last seen in, so stale items can be pruned. */
export type StoredItem = PhotoItem & { scannedAt: number; partition?: string };

let dbp: Promise<DB> | null = null;

export function db(): Promise<DB> {
  dbp ??= openDB<Schema>('apc', 1, {
    upgrade(d) {
      const items = d.createObjectStore('items', { keyPath: 'id' });
      items.createIndex('year', 'year');
      items.createIndex('md5', 'md5');
      items.createIndex('capturedAt', 'capturedAt');
      items.createIndex('partition', 'partition');
      d.createObjectStore('features', { keyPath: 'id' });
      d.createObjectStore('partitions', { keyPath: 'key' });
      d.createObjectStore('decisions', { keyPath: 'groupId' });
      d.createObjectStore('runs', { keyPath: 'runId' });
      d.createObjectStore('meta');
    },
  });
  return dbp;
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('meta', key)) as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await (await db()).put('meta', value, key);
}

/** Stores photos, keeping album membership learned earlier (a re-scan must not drop protection). */
export async function putItems(items: PhotoItem[], partition?: string): Promise<void> {
  const tx = (await db()).transaction('items', 'readwrite');
  const now = Date.now();
  await Promise.all([
    ...items.map(async (i) => {
      const prev = await tx.store.get(i.id);
      const albumIds = prev ? [...new Set([...prev.albumIds, ...i.albumIds])] : i.albumIds;
      await tx.store.put({ ...i, albumIds, scannedAt: now, partition });
    }),
    tx.done,
  ]);
}

export async function itemIdsInPartition(partition: string): Promise<string[]> {
  return (await db()).getAllKeysFromIndex('items', 'partition', partition);
}

/**
 * Adds crawled album membership to each photo. Only ever adds: a photo once seen in
 * an album stays protected, so a partial or broken crawl can't remove protection.
 */
export async function updateAlbumMembership(membership: Map<string, string[]>): Promise<void> {
  const tx = (await db()).transaction('items', 'readwrite');
  let cursor = await tx.store.openCursor();
  while (cursor) {
    const current = cursor.value.albumIds;
    const added = (membership.get(cursor.value.id) ?? []).filter((a) => !current.includes(a));
    if (added.length) await cursor.update({ ...cursor.value, albumIds: [...current, ...added] });
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function allItems(): Promise<PhotoItem[]> {
  return (await db()).getAll('items');
}

export async function itemsByYear(year: number): Promise<PhotoItem[]> {
  return (await db()).getAllFromIndex('items', 'year', year);
}

export async function itemCount(): Promise<number> {
  return (await db()).count('items');
}

/** Removes photos from the index. Features are kept so a restored photo needn't be re-analyzed. */
export async function deleteItems(ids: string[]): Promise<void> {
  const tx = (await db()).transaction('items', 'readwrite');
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

export async function allFeatures(): Promise<Map<string, Features>> {
  const all = await (await db()).getAll('features');
  return new Map(all.map((f) => [f.id, f]));
}

export async function putFeatures(f: Features): Promise<void> {
  await (await db()).put('features', f);
}

export async function allPartitions(): Promise<Partition[]> {
  return (await db()).getAll('partitions');
}

export async function putPartition(p: Partition): Promise<void> {
  await (await db()).put('partitions', p);
}

export async function allDecisions(): Promise<Map<string, Decision>> {
  const all = await (await db()).getAll('decisions');
  return new Map(all.map((d) => [d.groupId, d]));
}

export async function putDecision(d: Decision): Promise<void> {
  await (await db()).put('decisions', d);
}

export async function deleteDecision(groupId: string): Promise<void> {
  await (await db()).delete('decisions', groupId);
}

export async function putRun(r: TrashRun): Promise<void> {
  await (await db()).put('runs', r);
}

export async function allRuns(): Promise<TrashRun[]> {
  return (await (await db()).getAll('runs')).sort((a, b) => b.startedAt - a.startedAt);
}

export async function clearAll(): Promise<void> {
  const d = await db();
  const tx = d.transaction(['items', 'features', 'partitions', 'decisions', 'meta'], 'readwrite');
  await Promise.all([...(['items', 'features', 'partitions', 'decisions', 'meta'] as const).map((s) => tx.objectStore(s).clear()), tx.done]);
}
