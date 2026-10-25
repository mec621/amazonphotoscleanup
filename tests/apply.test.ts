import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AmazonAdapter } from '../src/adapter/amazon';
import { allItems, clearAll, putItems, updateAlbumMembership } from '../src/db/store';
import { applyTrash, rejectsFor, restoreRun, verifyRun } from '../src/pipeline/apply';
import { AmazonError } from '../src/adapter/amazon';
import { exactGroups, memberKey } from '../src/pipeline/group';
import { loadGroups } from '../src/pipeline/library';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import type { Decision, PhotoItem, TrashRunItem } from '../src/shared/types';

const settings = { ...DEFAULT_SETTINGS, trashDelayMs: 0 };

function photo(id: string, p: Partial<PhotoItem> = {}): PhotoItem {
  return { id, ownerId: 'me', name: `${id}.jpg`, capturedAt: 1, uploadedAt: 1, width: 0, height: 0, size: 1, md5: id, contentType: 'image/jpeg', favorite: false, albumIds: [], year: 2024, ...p };
}

/** A fake Amazon that tracks node status, with hooks to make calls fail. */
function fakeAmazon(opts: { failTrashCall?: number; loseReply?: boolean; statusOverride?: string } = {}) {
  const status = new Map<string, string>();
  const calls: string[][] = [];
  let n = 0;
  const adapter = {
    moveToTrash: async (ids: string[]) => {
      n++;
      calls.push(ids);
      if (opts.failTrashCall === n && !opts.loseReply) throw new Error('HTTP 500');
      ids.forEach((id) => status.set(id, 'TRASH'));
      // The call reached Amazon, but the answer never came back.
      if (opts.failTrashCall === n && opts.loseReply) throw new Error('Lost contact with the Amazon Photos tab');
    },
    restoreFromTrash: async (ids: string[]) => ids.forEach((id) => status.set(id, 'AVAILABLE')),
    nodeStatus: async (id: string) => opts.statusOverride ?? status.get(id) ?? 'AVAILABLE',
  };
  return { adapter: adapter as unknown as AmazonAdapter, status, calls };
}

const items = (n: number): TrashRunItem[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, groupId: 'g', item: photo(`p${i}`) }));
const noop = () => {};

beforeEach(async () => {
  await clearAll();
});

describe('applyTrash', () => {
  it('sends a single photo first, checks it, then batches the rest', async () => {
    const { adapter, calls } = fakeAmazon();
    const run = await applyTrash(adapter, items(60), settings, noop);
    expect(run.status).toBe('done');
    expect(calls.map((c) => c.length)).toEqual([1, 50, 9]);
    expect(run.trashedIds).toHaveLength(60);
  });

  it('stops after one photo if Amazon does not report it as trashed', async () => {
    const { adapter, calls } = fakeAmazon({ statusOverride: 'AVAILABLE' });
    const run = await applyTrash(adapter, items(10), settings, noop);
    expect(run.status).toBe('failed');
    expect(calls).toHaveLength(1);
    expect(run.trashedIds).toEqual(['p0']); // still in the undo log
    expect(run.error).toMatch(/Stopped after 1 photo/);
  });

  it('keeps photos in the undo log when the call succeeded but its answer was lost', async () => {
    const { adapter } = fakeAmazon({ failTrashCall: 2, loseReply: true });
    const run = await applyTrash(adapter, items(5), settings, noop);
    expect(run.status).toBe('failed');
    expect(run.trashedIds.sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(run.inFlightIds).toBeUndefined();
  });

  it('leaves out a failed batch that never reached trash', async () => {
    const { adapter } = fakeAmazon({ failTrashCall: 2 });
    const run = await applyTrash(adapter, items(5), settings, noop);
    expect(run.trashedIds).toEqual(['p0']);
  });

  it('restores a run, including a batch left in flight by a closed tab', async () => {
    const { adapter, status } = fakeAmazon();
    const run = await applyTrash(adapter, items(3), settings, noop);
    status.set('p9', 'TRASH');
    run.inFlightIds = ['p9', 'p8']; // p8 never reached trash
    const restored = await restoreRun(adapter, run, settings, noop);
    expect(restored.status).toBe('restored');
    expect([...status.entries()].filter(([, s]) => s === 'TRASH')).toEqual([]);
    expect(restored.trashedIds.sort()).toEqual(['p0', 'p1', 'p2', 'p9']);
  });
});

describe('album protection', () => {
  it('a re-scan or a partial crawl never removes album membership', async () => {
    await putItems([photo('a', { albumIds: ['al1'] }), photo('b')]);
    await updateAlbumMembership(new Map([['b', ['al2']]])); // crawl that missed a's album
    await putItems([photo('a'), photo('b')]); // re-scan whose metadata lacks album info
    const byId = new Map((await allItems()).map((i) => [i.id, i]));
    expect(byId.get('a')!.albumIds).toEqual(['al1']);
    expect(byId.get('b')!.albumIds).toEqual(['al2']);
  });
});

describe('rejectsFor', () => {
  it('never trashes a RAW original, even when accepted', () => {
    const its = [photo('jpg', { md5: 'x', uploadedAt: 1 }), photo('raw', { md5: 'x', uploadedAt: 2, name: 'IMG_1.CR3', contentType: 'image/x-canon-cr3' })];
    const [g] = exactGroups(its);
    const d: Decision = { groupId: g.id, memberKey: memberKey(g), keepIds: ['jpg'], status: 'accepted', decidedAt: 0 };
    expect(rejectsFor([g], new Map([[g.id, d]]), new Map(its.map((i) => [i.id, i])))).toEqual([]);
    expect(g.members.find((m) => m.id === 'raw')!.protected).toBe('RAW original');
  });
});

describe('album protection setting', () => {
  it('protects album photos when on, and ignores albums when off', async () => {
    await putItems([photo('a', { md5: 'x', uploadedAt: 1 }), photo('b', { md5: 'x', uploadedAt: 2, albumIds: ['al1'] })]);
    const on = (await loadGroups({ kind: 'all' }, { ...DEFAULT_SETTINGS, protectAlbums: true })).groups[0];
    expect(on.keepIds).toEqual(['b']); // the album copy is the keeper
    const off = (await loadGroups({ kind: 'all' }, { ...DEFAULT_SETTINGS, protectAlbums: false })).groups[0];
    expect(off.keepIds).toEqual(['a']); // back to oldest upload
    expect(off.members.every((m) => !m.protected)).toBe(true);
  });
});

describe('verifyRun', () => {
  it("records each photo's status as Amazon reports it", async () => {
    const { adapter, status } = fakeAmazon();
    const run = await applyTrash(adapter, items(3), settings, noop);
    status.set('p2', 'AVAILABLE'); // e.g. restored by hand on Amazon's site
    const gone = { ...adapter, nodeStatus: async (id: string) => {
      if (id === 'p1') throw new AmazonError('not found', 404);
      return status.get(id) ?? 'AVAILABLE';
    } } as unknown as AmazonAdapter;
    const checked = await verifyRun(gone, run, noop);
    expect(checked.verified!.status).toEqual({ p0: 'TRASH', p1: 'GONE', p2: 'AVAILABLE' });
  });
});
