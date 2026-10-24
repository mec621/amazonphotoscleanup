/** One photo from the library, as stored in the local index. */
export interface PhotoItem {
  id: string;
  ownerId: string;
  name: string;
  /** Capture time (EXIF original, falling back to content date, then upload date), ms since epoch. */
  capturedAt: number;
  /** When the file was uploaded to Amazon, ms since epoch. */
  uploadedAt: number;
  width: number;
  height: number;
  size: number;
  md5: string | null;
  contentType: string;
  favorite: boolean;
  albumIds: string[];
  year: number;
}

export interface FaceStats {
  count: number;
  /** 0..1, averaged over faces; 1 = both eyes fully open. */
  eyesOpen: number;
  /** 0..1, averaged over faces. */
  smile: number;
}

/** Pixel-derived features computed from a ~256 px thumbnail. Never the full image. */
export interface Features {
  id: string;
  /** 64-bit perceptual hash as 16 hex chars. */
  phash: string;
  /** Variance of the Laplacian on the grayscale thumbnail. */
  sharpness: number;
  /** 0..1, share of pixels clipped to near-white. */
  clipHigh: number;
  /** 0..1, share of pixels crushed to near-black. */
  clipLow: number;
  /** L2-normalized CLIP image embedding, when the embedding model is on. */
  embedding?: Float32Array;
  /** 0..1 aesthetic estimate from the embedding. */
  aesthetic?: number;
  /** null = face model ran and found no faces; undefined = model not run. */
  faces?: FaceStats | null;
  version: number;
}

export type GroupKind = 'exact' | 'near';
export type Confidence = 'high' | 'medium' | 'low';

export interface ScoredMember {
  id: string;
  score: number;
  reason: string;
  protected: string | null;
}

export interface Group {
  id: string;
  kind: GroupKind;
  members: ScoredMember[];
  /** Suggested keepers (always includes protected members). */
  keepIds: string[];
  confidence: Confidence;
  capturedAt: number;
}

export type DecisionStatus = 'accepted' | 'skipped';

export interface Decision {
  groupId: string;
  /** Sorted member IDs at decision time; a decision is void if membership changes. */
  memberKey: string;
  keepIds: string[];
  status: DecisionStatus;
  decidedAt: number;
}

export interface TrashRunItem {
  id: string;
  groupId: string;
  /** Snapshot so a restore can put the photo back in the local index. */
  item: PhotoItem;
}

export interface TrashRun {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  items: TrashRunItem[];
  /** IDs Amazon confirmed as trashed. */
  trashedIds: string[];
  /** A batch sent to Amazon whose outcome isn't known yet (e.g. the tab closed mid-call). */
  inFlightIds?: string[];
  status: 'running' | 'done' | 'failed' | 'restored' | 'restore-failed';
  error?: string;
  restoredAt?: number;
}

export type Scope = { kind: 'all' } | { kind: 'year'; year: number } | { kind: 'album'; albumId: string; name: string };

export interface Album {
  id: string;
  name: string;
  count: number;
}
