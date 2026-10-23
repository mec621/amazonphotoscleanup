import { cosine, hamming } from '../imaging/pixels';
import type { Settings } from '../shared/settings';
import type { Features, Group, PhotoItem, ScoredMember } from '../shared/types';
import { protectedReason, scoreGroup } from './score';

/** Keeper order for exact copies: favorite, then in an album, then oldest upload. */
export function exactKeeperOrder(a: PhotoItem, b: PhotoItem): number {
  return Number(b.favorite) - Number(a.favorite) || Number(b.albumIds.length > 0) - Number(a.albumIds.length > 0) || a.uploadedAt - b.uploadedAt || a.id.localeCompare(b.id);
}

export function exactGroups(items: PhotoItem[]): Group[] {
  const byMd5 = new Map<string, PhotoItem[]>();
  for (const it of items) {
    if (!it.md5) continue;
    const list = byMd5.get(it.md5);
    if (list) list.push(it);
    else byMd5.set(it.md5, [it]);
  }
  const groups: Group[] = [];
  for (const [md5, copies] of byMd5) {
    if (copies.length < 2) continue;
    const sorted = [...copies].sort(exactKeeperOrder);
    const keeper = sorted[0];
    const why = keeper.favorite ? 'favorite' : keeper.albumIds.length ? 'in an album' : 'oldest upload';
    const members: ScoredMember[] = sorted.map((it, i) => {
      const prot = protectedReason(it);
      const reason = i === 0 ? `Kept: ${why}` : prot ? `Protected (${prot}); exact copy` : 'Exact copy of the keeper';
      return { id: it.id, score: i === 0 ? 100 : 0, reason, protected: prot };
    });
    groups.push({
      id: `exact:${md5}`,
      kind: 'exact',
      members,
      keepIds: members.filter((m, i) => i === 0 || m.protected).map((m) => m.id),
      confidence: 'high',
      capturedAt: keeper.capturedAt,
    });
  }
  return groups;
}

/** IDs of exact copies that are not the first-choice keeper. Near-dupe search skips them. */
function exactExtras(groups: Group[]): Set<string> {
  const s = new Set<string>();
  for (const g of groups) g.members.slice(1).forEach((m) => s.add(m.id));
  return s;
}

function byTime(items: PhotoItem[]): PhotoItem[] {
  return items.filter((i) => i.capturedAt > 0).sort((a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id));
}

/** Photos with at least one other photo within the time window: the only ones that need thumbnails. */
export function nearCandidates(items: PhotoItem[], windowSeconds: number): PhotoItem[] {
  const extras = exactExtras(exactGroups(items));
  const sorted = byTime(items.filter((i) => !extras.has(i.id)));
  const win = windowSeconds * 1000;
  const out: PhotoItem[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const prev = i > 0 && sorted[i].capturedAt - sorted[i - 1].capturedAt <= win;
    const next = i + 1 < sorted.length && sorted[i + 1].capturedAt - sorted[i].capturedAt <= win;
    if (prev || next) out.push(sorted[i]);
  }
  return out;
}

export function isSimilar(a: Features, b: Features, s: Pick<Settings, 'phashMaxBits' | 'cosineMin'>): boolean {
  if (hamming(a.phash, b.phash) <= s.phashMaxBits) return true;
  return a.embedding !== undefined && b.embedding !== undefined && cosine(a.embedding, b.embedding) >= s.cosineMin;
}

/** Union-find over similar pairs inside the time window. A merge that would exceed the cap is skipped. */
export function nearClusters(items: PhotoItem[], features: Map<string, Features>, s: Settings): PhotoItem[][] {
  const sorted = byTime(items).filter((i) => features.has(i.id));
  const parent = sorted.map((_, i) => i);
  const size = sorted.map(() => 1);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const win = s.windowSeconds * 1000;
  for (let i = 0; i < sorted.length; i++) {
    const fi = features.get(sorted[i].id)!;
    for (let j = i + 1; j < sorted.length && sorted[j].capturedAt - sorted[i].capturedAt <= win; j++) {
      const a = find(i);
      const b = find(j);
      if (a === b || size[a] + size[b] > s.groupCap) continue;
      if (!isSimilar(fi, features.get(sorted[j].id)!, s)) continue;
      parent[b] = a;
      size[a] += size[b];
    }
  }
  const clusters = new Map<number, PhotoItem[]>();
  sorted.forEach((it, i) => {
    const r = find(i);
    const c = clusters.get(r);
    if (c) c.push(it);
    else clusters.set(r, [it]);
  });
  return [...clusters.values()].filter((c) => c.length > 1);
}

export function nearGroups(items: PhotoItem[], features: Map<string, Features>, s: Settings, exact: Group[] = exactGroups(items)): Group[] {
  const extras = exactExtras(exact);
  const reps = items.filter((i) => !extras.has(i.id));
  return nearClusters(reps, features, s).map((members) => {
    const scored = scoreGroup(members, features);
    return { id: `near:${members[0].id}`, kind: 'near' as const, ...scored, capturedAt: members[0].capturedAt };
  });
}

export function buildGroups(items: PhotoItem[], features: Map<string, Features>, s: Settings): Group[] {
  const exact = exactGroups(items);
  return [...exact, ...nearGroups(items, features, s, exact)].sort((a, b) => b.capturedAt - a.capturedAt);
}

export function memberKey(g: Group): string {
  return g.members.map((m) => m.id).sort().join(',');
}
