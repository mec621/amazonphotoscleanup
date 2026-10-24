import { describe, expect, it } from 'vitest';
import { normalizeNode } from '../src/adapter/amazon';
import { rejectsFor } from '../src/pipeline/apply';
import { applyTiebreak, buildGroups, closeCallPair, exactGroups, memberKey, nearCandidates, nearGroups } from '../src/pipeline/group';
import { scoreGroup } from '../src/pipeline/score';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import type { Decision, Features, PhotoItem } from '../src/shared/types';

const T0 = Date.UTC(2024, 6, 4, 12, 0, 0);

function photo(id: string, p: Partial<PhotoItem> = {}): PhotoItem {
  return { id, ownerId: 'me', name: `${id}.jpg`, capturedAt: T0, uploadedAt: T0, width: 4000, height: 3000, size: 3e6, md5: `md5-${id}`, contentType: 'image/jpeg', favorite: false, albumIds: [], year: 2024, ...p };
}

function feat(id: string, p: Partial<Features> = {}): Features {
  return { id, phash: '0000000000000000', sharpness: 100, clipHigh: 0, clipLow: 0, version: 1, ...p };
}

const features = (...fs: Features[]) => new Map(fs.map((f) => [f.id, f]));

describe('exactGroups', () => {
  it('groups by checksum and keeps favorite > album > oldest upload', () => {
    const items = [
      photo('a', { md5: 'x', uploadedAt: 1 }),
      photo('b', { md5: 'x', uploadedAt: 2, albumIds: ['al'] }),
      photo('c', { md5: 'x', uploadedAt: 3 }),
      photo('d', { md5: 'y' }),
    ];
    const [g] = exactGroups(items);
    expect(g.members.map((m) => m.id)).toEqual(['b', 'a', 'c']);
    expect(g.keepIds).toEqual(['b']);

    const [g2] = exactGroups([...items, photo('e', { md5: 'x', uploadedAt: 9, favorite: true })]);
    expect(g2.members[0].id).toBe('e');
    // The album copy is protected even though it is not the keeper.
    expect(g2.keepIds.sort()).toEqual(['b', 'e']);
  });

  it('falls back to the oldest upload', () => {
    const [g] = exactGroups([photo('new', { md5: 'x', uploadedAt: 5 }), photo('old', { md5: 'x', uploadedAt: 1 })]);
    expect(g.keepIds).toEqual(['old']);
    expect(g.members[0].reason).toMatch(/oldest upload/);
  });
});

describe('near-duplicate grouping', () => {
  it('only pairs photos inside the time window', () => {
    const items = [photo('a'), photo('b', { capturedAt: T0 + 5000 }), photo('c', { capturedAt: T0 + 60_000 })];
    expect(nearCandidates(items, 10).map((i) => i.id)).toEqual(['a', 'b']);
    const groups = nearGroups(items, features(feat('a'), feat('b'), feat('c')), DEFAULT_SETTINGS);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });

  it('requires visual similarity by hash or embedding', () => {
    const items = [photo('a'), photo('b', { capturedAt: T0 + 1000 })];
    const far = features(feat('a', { phash: '0000000000000000' }), feat('b', { phash: 'ffffffffffffffff' }));
    expect(nearGroups(items, far, DEFAULT_SETTINGS)).toHaveLength(0);
    const e = new Float32Array([1, 0, 0]);
    const embedded = features(feat('a', { phash: '0000000000000000', embedding: e }), feat('b', { phash: 'ffffffffffffffff', embedding: new Float32Array([0.99, 0.1, 0]) }));
    expect(nearGroups(items, embedded, DEFAULT_SETTINGS)).toHaveLength(1);
  });

  it('caps group size so a long burst is split', () => {
    const items = Array.from({ length: 12 }, (_, i) => photo(`p${String(i).padStart(2, '0')}`, { capturedAt: T0 + i * 1000 }));
    const fs = features(...items.map((i) => feat(i.id)));
    const groups = nearGroups(items, fs, { ...DEFAULT_SETTINGS, groupCap: 5 });
    expect(groups.every((g) => g.members.length <= 5)).toBe(true);
    expect(groups.reduce((s, g) => s + g.members.length, 0)).toBe(12);
  });

  it('collapses exact copies before near grouping', () => {
    const items = [photo('a', { md5: 'x', uploadedAt: 1 }), photo('a2', { md5: 'x', uploadedAt: 2 }), photo('b', { capturedAt: T0 + 2000 })];
    const groups = buildGroups(items, features(feat('a'), feat('a2'), feat('b')), DEFAULT_SETTINGS);
    const near = groups.find((g) => g.kind === 'near')!;
    expect(near.members.map((m) => m.id).sort()).toEqual(['a', 'b']);
    expect(nearCandidates(items, 10).map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('scoreGroup', () => {
  it('keeps the sharpest shot and explains the blurry one', () => {
    const items = [photo('sharp'), photo('blurry')];
    const s = scoreGroup(items, features(feat('sharp', { sharpness: 900 }), feat('blurry', { sharpness: 40 })));
    expect(s.keepIds).toEqual(['sharp']);
    expect(s.members.find((m) => m.id === 'blurry')!.reason).toBe('Blurry');
    expect(s.members.find((m) => m.id === 'sharp')!.reason).toMatch(/sharpest/);
  });

  it('prefers open eyes when faces are present', () => {
    const items = [photo('closed'), photo('open')];
    const s = scoreGroup(
      items,
      features(feat('closed', { sharpness: 120, faces: { count: 1, eyesOpen: 0.1, smile: 0.5 } }), feat('open', { sharpness: 100, faces: { count: 1, eyesOpen: 0.95, smile: 0.5 } })),
    );
    expect(s.keepIds).toEqual(['open']);
    expect(s.members.find((m) => m.id === 'closed')!.reason).toBe('Eyes closed');
  });

  it('always keeps a favorite, and breaks ties by resolution', () => {
    const items = [photo('big', { width: 4000 }), photo('small', { width: 2000 }), photo('fav', { favorite: true })];
    const s = scoreGroup(items, features(feat('big'), feat('small'), feat('fav')));
    expect(s.keepIds.sort()).toEqual(['big', 'fav']);
    expect(s.confidence).toBe('low');
  });
});

describe('rejectsFor', () => {
  it('only trashes accepted, unprotected, non-kept members of unchanged groups', () => {
    const items = [photo('a', { md5: 'x', uploadedAt: 1 }), photo('b', { md5: 'x', uploadedAt: 2 }), photo('c', { md5: 'x', uploadedAt: 3, albumIds: ['al'] })];
    const [g] = exactGroups(items);
    const byId = new Map(items.map((i) => [i.id, i]));
    const ok: Decision = { groupId: g.id, memberKey: memberKey(g), keepIds: g.keepIds, status: 'accepted', decidedAt: 0 };
    expect(rejectsFor([g], new Map([[g.id, ok]]), byId).map((r) => r.id)).toEqual(['a', 'b'].filter((id) => !g.keepIds.includes(id)));
    expect(rejectsFor([g], new Map([[g.id, { ...ok, status: 'skipped' }]]), byId)).toEqual([]);
    expect(rejectsFor([g], new Map([[g.id, { ...ok, memberKey: 'stale' }]]), byId)).toEqual([]);
    // A decision that keeps nothing is ignored rather than trashing the whole group.
    expect(rejectsFor([g], new Map([[g.id, { ...ok, keepIds: [] }]]), byId)).toEqual([]);
  });
});

describe('normalizeNode', () => {
  it('maps the documented node shape', () => {
    const item = normalizeNode({
      id: 'n1',
      name: 'IMG_1.JPG',
      ownerId: 'o',
      createdDate: '2024-07-05T10:00:00.000Z',
      contentProperties: { size: 123, md5: 'abc', contentType: 'image/jpeg', contentDate: '2024-07-04T12:00:00.000Z' },
      image: { width: '4032', height: 3024, dateTimeOriginal: '2024:07:04 11:59:58' },
      settings: { favorite: true },
      parentMap: { FOLDER: ['f'], VISUAL_COLLECTION: ['album1'] },
    });
    expect(item).toMatchObject({ id: 'n1', md5: 'abc', width: 4032, height: 3024, favorite: true, albumIds: ['album1'], year: 2024, size: 123 });
    expect(new Date(item.uploadedAt).toISOString()).toBe('2024-07-05T10:00:00.000Z');
    expect(item.capturedAt).toBeGreaterThan(0);
  });

  it('reads image details nested under contentProperties', () => {
    const item = normalizeNode({ id: 'n3', contentProperties: { md5: 'm', image: { width: 3024, height: 4032, dateTimeOriginal: '2021:01:02 03:04:05' } } });
    expect(item).toMatchObject({ width: 3024, height: 4032, year: 2021 });
  });

  it('falls back to content date when EXIF time is missing', () => {
    const item = normalizeNode({ id: 'n2', contentProperties: { contentDate: '2020-01-02T03:04:05.000Z' } });
    expect(new Date(item.capturedAt).toISOString()).toBe('2020-01-02T03:04:05.000Z');
    expect(item.md5).toBeNull();
  });
});

describe('tiebreak', () => {
  const items = [photo('a'), photo('b', { capturedAt: T0 + 1000 }), photo('c', { capturedAt: T0 + 2000 })];
  // a and b nearly tie; c is clearly blurrier.
  const fs = features(feat('a', { sharpness: 500 }), feat('b', { sharpness: 480 }), feat('c', { sharpness: 20 }));

  it('finds the close call in capture order', () => {
    const [g] = nearGroups(items, fs, DEFAULT_SETTINGS);
    expect(closeCallPair(g)).toEqual(['a', 'b']);
    const [clear] = nearGroups(items.slice(0, 1).concat(items[2]), fs, DEFAULT_SETTINGS);
    expect(closeCallPair(clear)).toBeNull();
  });

  it("makes Claude's pick the keeper and explains both photos", () => {
    const [g] = nearGroups(items, fs, DEFAULT_SETTINGS, undefined, { [`near:a`]: { pair: ['a', 'b'], winnerId: 'b', reason: 'eyes open' } });
    expect(g.keepIds).toEqual(['b']);
    expect(g.members.find((m) => m.id === 'b')!.reason).toBe("Claude's pick: eyes open");
    expect(g.members.find((m) => m.id === 'a')!.reason).toMatch(/Claude preferred the other/);
  });

  it('ignores a stale answer and never drops a protected photo', () => {
    const stale = nearGroups(items, fs, DEFAULT_SETTINGS, undefined, { 'near:a': { pair: ['a', 'c'], winnerId: 'c', reason: 'x' } })[0];
    expect(stale.keepIds).toEqual(['a']);
    const favItems = [photo('a', { favorite: true }), ...items.slice(1)];
    const [g] = nearGroups(favItems, fs, DEFAULT_SETTINGS, undefined, { 'near:a': { pair: ['a', 'b'], winnerId: 'b', reason: 'x' } });
    expect(g.keepIds.sort()).toEqual(['a', 'b']);
    expect(applyTiebreak(g, { pair: ['a', 'b'], winnerId: 'b', reason: 'x' }).keepIds.sort()).toEqual(['a', 'b']);
  });
});
