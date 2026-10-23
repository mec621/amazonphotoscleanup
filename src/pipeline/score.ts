import type { Confidence, Features, PhotoItem, ScoredMember } from '../shared/types';

export const WEIGHTS = { sharpness: 0.35, faces: 0.3, aesthetics: 0.2, exposure: 0.15 } as const;
type Signal = keyof typeof WEIGHTS;

/** Ties within this many points go to the higher-resolution photo. */
const TIE_POINTS = 1;

export function protectedReason(item: PhotoItem): string | null {
  if (item.favorite) return 'favorite';
  if (item.albumIds.length) return 'in an album';
  return null;
}

export function exposureScore(f: Features): number {
  return 1 - Math.min(1, 3 * (f.clipHigh + f.clipLow));
}

export function faceScore(f: Features): number {
  return f.faces ? 0.6 * f.faces.eyesOpen + 0.4 * f.faces.smile : 0;
}

function minMax(values: number[]): number[] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // Differences under 5% of the level are noise; call them equal.
  if (hi - lo < Math.max(1e-6, 0.05 * Math.abs(hi))) return values.map(() => 1);
  return values.map((v) => (v - lo) / (hi - lo));
}

export interface ScoredGroup {
  members: ScoredMember[];
  keepIds: string[];
  confidence: Confidence;
}

/** Scores 2+ near-identical photos 0..100 and picks a keeper. Members missing features score on what's available. */
export function scoreGroup(items: PhotoItem[], features: Map<string, Features>): ScoredGroup {
  const feats = items.map((i) => features.get(i.id));
  const have = (pred: (f: Features) => boolean) => feats.every((f) => f !== undefined && pred(f));

  const signals: Partial<Record<Signal, number[]>> = {};
  if (have(() => true)) {
    signals.sharpness = minMax(feats.map((f) => Math.log1p(f!.sharpness)));
    signals.exposure = feats.map((f) => exposureScore(f!));
  }
  // Faces count only if the model ran on every photo and found a face in at least one.
  if (have((f) => f.faces !== undefined) && feats.some((f) => f!.faces && f!.faces.count > 0)) {
    signals.faces = feats.map((f) => faceScore(f!));
  }
  if (have((f) => f.aesthetic !== undefined)) signals.aesthetics = feats.map((f) => f!.aesthetic!);

  const used = Object.keys(signals) as Signal[];
  const totalW = used.reduce((s, k) => s + WEIGHTS[k], 0);
  const scores = items.map((_, i) => (totalW ? (100 * used.reduce((s, k) => s + WEIGHTS[k] * signals[k]![i], 0)) / totalW : 50));

  const pixels = (i: number) => items[i].width * items[i].height;
  const better = (a: number, b: number) => (Math.abs(scores[a] - scores[b]) <= TIE_POINTS ? pixels(a) - pixels(b) || scores[a] - scores[b] : scores[a] - scores[b]);
  const order = items.map((_, i) => i).sort((a, b) => better(b, a));
  const best = order[0];

  const keep = new Set<string>([items[best].id]);
  items.forEach((it) => protectedReason(it) && keep.add(it.id));

  const margin = order.length > 1 ? scores[best] - scores[order[1]] : 100;
  const confidence: Confidence = !used.length ? 'low' : margin >= 15 ? 'high' : margin >= 5 ? 'medium' : 'low';

  const members = items.map((it, i): ScoredMember => {
    const prot = protectedReason(it);
    let reason: string;
    if (i === best) reason = keeperReason(i, signals, used, Math.abs(scores[best] - scores[order[1]]) <= TIE_POINTS);
    else reason = rejectReason(i, best, signals, used, feats[i], items[i], items[best]);
    if (prot && i !== best) reason = `Protected (${prot}); ${reason}`;
    return { id: it.id, score: Math.round(scores[i]), reason, protected: prot };
  });
  return { members, keepIds: [...keep], confidence };
}

function keeperReason(i: number, signals: Partial<Record<Signal, number[]>>, used: Signal[], tie: boolean): string {
  if (!used.length) return 'Kept: not analyzed yet; highest resolution';
  const strengths: string[] = [];
  const isTop = (k: Signal) => signals[k]![i] >= Math.max(...signals[k]!) - 1e-9;
  if (signals.sharpness && isTop('sharpness') && Math.min(...signals.sharpness) < 1) strengths.push('sharpest');
  if (signals.faces && isTop('faces')) strengths.push('best faces');
  if (signals.exposure && isTop('exposure') && Math.min(...signals.exposure) < signals.exposure[i] - 0.05) strengths.push('best exposure');
  if (signals.aesthetics && isTop('aesthetics')) strengths.push('best composition');
  if (tie) strengths.push('highest resolution of a tie');
  return `Best shot${strengths.length ? `: ${strengths.join(', ')}` : ''}`;
}

function rejectReason(i: number, best: number, signals: Partial<Record<Signal, number[]>>, used: Signal[], f: Features | undefined, item: PhotoItem, keeper: PhotoItem): string {
  if (!used.length || !f) return 'Similar to the keeper (not analyzed)';
  // Name the signal that costs this photo the most weighted points against the keeper.
  let worst: Signal | null = null;
  let worstGap = 0.03;
  for (const k of used) {
    const gap = WEIGHTS[k] * (signals[k]![best] - signals[k]![i]);
    if (gap > worstGap) {
      worstGap = gap;
      worst = k;
    }
  }
  switch (worst) {
    case 'sharpness':
      return signals.sharpness![i] < 0.35 ? 'Blurry' : 'Less sharp than the keeper';
    case 'faces':
      if (!f.faces) return 'Faces turned away or hidden';
      if (f.faces.eyesOpen < 0.4) return 'Eyes closed';
      return 'Less smiling';
    case 'exposure':
      return f.clipHigh >= f.clipLow ? 'Blown-out highlights' : 'Too dark';
    case 'aesthetics':
      return 'Weaker composition';
    default:
      return item.width * item.height < keeper.width * keeper.height ? 'Near-identical; lower resolution' : 'Near-identical to the keeper';
  }
}
