import { allFeatures, allItems, getMeta } from '../db/store';
import type { Settings } from '../shared/settings';
import type { Features, Group, PhotoItem, Scope } from '../shared/types';
import { buildGroups, nearCandidates, type Tiebreaks } from './group';

export function inScope(scope: Scope): (i: PhotoItem) => boolean {
  if (scope.kind === 'year') return (i) => i.year === scope.year;
  if (scope.kind === 'album') return (i) => i.albumIds.includes(scope.albumId);
  return () => true;
}

export function scopeLabel(scope: Scope): string {
  return scope.kind === 'all' ? 'All photos' : scope.kind === 'year' ? String(scope.year) : `Album: ${scope.name}`;
}

export async function loadScope(scope: Scope): Promise<PhotoItem[]> {
  return (await allItems()).filter(inScope(scope));
}

export async function loadGroups(scope: Scope, settings: Settings): Promise<{ items: PhotoItem[]; features: Map<string, Features>; groups: Group[] }> {
  const [items, features, tiebreaks] = await Promise.all([loadScope(scope), allFeatures(), getMeta<Tiebreaks>('tiebreaks')]);
  return { items, features, groups: buildGroups(items, features, settings, settings.claudeTiebreaker ? (tiebreaks ?? {}) : {}) };
}

export interface Summary {
  exactGroups: number;
  exactCopies: number;
  nearGroups: number;
  nearPhotos: number;
  suggested: number;
}

export function summarize(groups: Group[]): Summary {
  const s: Summary = { exactGroups: 0, exactCopies: 0, nearGroups: 0, nearPhotos: 0, suggested: 0 };
  for (const g of groups) {
    const rejects = g.members.length - g.keepIds.length;
    if (g.kind === 'exact') {
      s.exactGroups++;
      s.exactCopies += g.members.length - 1;
    } else {
      s.nearGroups++;
      s.nearPhotos += g.members.length;
    }
    s.suggested += rejects;
  }
  return s;
}

export interface AnalysisStats {
  /** Photos taken within the time window of another photo: the only ones checked for similarity. */
  candidates: number;
  /** Of those, how many have been analyzed. */
  analyzed: number;
  /** Photos whose capture time is exactly midnight UTC: a sign of date-only timestamps. */
  midnight: number;
  total: number;
}

/** How far the similar-shot analysis got, so "0 similar groups" can be told apart from "never analyzed". */
export function analysisStats(items: PhotoItem[], features: Map<string, Features>, windowSeconds: number): AnalysisStats {
  const candidates = nearCandidates(items, windowSeconds);
  return {
    candidates: candidates.length,
    analyzed: candidates.filter((i) => features.has(i.id)).length,
    midnight: items.filter((i) => i.capturedAt > 0 && i.capturedAt % 86_400_000 === 0).length,
    total: items.length,
  };
}

export async function loadScopeSetting(): Promise<Scope> {
  const { scope } = await chrome.storage.local.get('scope');
  return (scope as Scope) ?? { kind: 'all' };
}

export async function saveScopeSetting(scope: Scope): Promise<void> {
  await chrome.storage.local.set({ scope });
}
