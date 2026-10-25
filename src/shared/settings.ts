export interface Settings {
  /** Max seconds between two shots for them to be compared. 2..300. */
  windowSeconds: number;
  /** Max differing bits between perceptual hashes for a pair to count as similar. */
  phashMaxBits: number;
  /** Min cosine similarity between embeddings for a pair to count as similar. */
  cosineMin: number;
  /** Largest allowed near-duplicate group. */
  groupCap: number;
  useEmbeddings: boolean;
  useFaces: boolean;
  /** Ask Claude to pick between the top two shots when their scores are close. Sends only those two thumbnails. */
  claudeTiebreaker: boolean;
  /** Never trash photos that are in an album. */
  protectAlbums: boolean;
  /** Your Anthropic API key, kept in this browser's extension storage. */
  anthropicApiKey: string;
  /** Milliseconds to wait between Amazon API calls. */
  apiDelayMs: number;
  /** Items per trash/restore call. Hard max 50. */
  trashBatchSize: number;
  /** Milliseconds to wait between trash/restore calls. */
  trashDelayMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  windowSeconds: 30,
  phashMaxBits: 10,
  cosineMin: 0.92,
  groupCap: 30,
  useEmbeddings: true,
  useFaces: true,
  claudeTiebreaker: false,
  protectAlbums: true,
  anthropicApiKey: '',
  apiDelayMs: 300,
  trashBatchSize: 50,
  trashDelayMs: 2000,
};

export const MAX_TRASH_BATCH = 50;

export function clampSettings(s: Settings): Settings {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
  return {
    ...s,
    windowSeconds: clamp(s.windowSeconds, 2, 300),
    phashMaxBits: clamp(Math.round(s.phashMaxBits), 0, 32),
    cosineMin: clamp(s.cosineMin, 0.5, 1),
    groupCap: clamp(Math.round(s.groupCap), 2, 200),
    apiDelayMs: clamp(s.apiDelayMs, 100, 10000),
    trashBatchSize: clamp(Math.round(s.trashBatchSize), 1, MAX_TRASH_BATCH),
    trashDelayMs: clamp(s.trashDelayMs, 500, 60000),
  };
}

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  const stored: Partial<Settings> & { windowDefault30?: boolean } = { ...(settings ?? {}) };
  // The default window grew from 10s to 30s; settings saved with the old default move with it.
  if (stored.windowSeconds === 10 && !stored.windowDefault30) stored.windowSeconds = DEFAULT_SETTINGS.windowSeconds;
  return clampSettings({ ...DEFAULT_SETTINGS, ...stored });
}

export async function saveSettings(s: Settings): Promise<Settings> {
  const clean = clampSettings(s);
  // Marks the window as chosen under the 30s default, so a deliberate 10s isn't migrated.
  await chrome.storage.local.set({ settings: { ...clean, windowDefault30: true } });
  return clean;
}
