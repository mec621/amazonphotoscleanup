// The ONLY module that knows Amazon's endpoints and response shapes.
//
// Amazon Photos has no public API. Everything here mirrors calls the web app
// makes, as documented by the `amazon-photos` PyPI library (last confirmed Dec
// 2023). When Amazon changes something, this is the one file to fix; run the
// self-test from the side panel to see which check broke.

import type { Album, PhotoItem } from '../shared/types';
import type { HelloResponse, RelayRequest, RelayResponse } from './relay';

const AMAZON_TAB_URLS = ['https://www.amazon.com/photos*', 'https://photos.amazon.com/*'];
const THUMB_HOST = 'https://thumbnails-photos.amazon.com/v1/thumbnail';
/** The search API refuses offsets past roughly 10k, so large ranges are split. */
export const SEARCH_OFFSET_CAP = 9000;
export const SEARCH_PAGE_SIZE = 200;
/** Amazon rate-limits search hardest, so searches are spaced further apart than other calls. */
const SEARCH_MIN_INTERVAL_MS = 1000;
/** On HTTP 429, wait this long before each retry (unless Amazon says otherwise): about 7.5 minutes in all. */
const RATE_LIMIT_WAITS_MS = [30_000, 60_000, 120_000, 240_000];
const MAX_API_DELAY_MS = 5000;
const COMMON_PARAMS = { asset: 'ALL', tempLink: 'false', resourceVersion: 'V2', ContentType: 'JSON' };

export class AmazonError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Response normalization (pure; unit-tested)

// Raw node fields we rely on. Anything optional here is a guess to verify in Phase 0.
export interface RawNode {
  id: string;
  name?: string;
  kind?: string;
  ownerId?: string;
  status?: string;
  createdDate?: string;
  parents?: string[];
  parentMap?: Record<string, string[]>;
  contentProperties?: { size?: number; md5?: string; contentType?: string; contentDate?: string; image?: RawImageInfo };
  image?: RawImageInfo;
  settings?: { favorite?: boolean };
  isFavorite?: boolean;
  favorite?: boolean;
  labels?: string[];
}

type RawImageInfo = { width?: number | string; height?: number | string; dateTimeOriginal?: string; dateTime?: string };

function parseTime(...candidates: (string | undefined)[]): number {
  for (const c of candidates) {
    if (!c) continue;
    // EXIF style "2021:07:04 13:22:01" has colons in the date part.
    const fixed = /^\d{4}:\d{2}:\d{2}/.test(c) ? c.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3') : c;
    const t = Date.parse(fixed);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

export function normalizeNode(n: RawNode): PhotoItem {
  const cp = n.contentProperties ?? {};
  // Image details have been seen both at the top level and under contentProperties.
  const img = { ...cp.image, ...n.image };
  const uploadedAt = parseTime(n.createdDate);
  // Amazon's contentDate first: it is ISO with a timezone, while EXIF times are zone-less
  // and would parse in the browser's zone, putting mixed photos hours apart.
  const capturedAt = parseTime(cp.contentDate, img.dateTimeOriginal, img.dateTime, n.createdDate);
  const favorite = Boolean(n.settings?.favorite ?? n.isFavorite ?? n.favorite ?? n.labels?.includes('FAVORITE'));
  const albumIds = n.parentMap?.VISUAL_COLLECTION ?? [];
  return {
    id: n.id,
    ownerId: n.ownerId ?? '',
    name: n.name ?? n.id,
    capturedAt,
    uploadedAt,
    width: Number(img.width ?? 0) || 0,
    height: Number(img.height ?? 0) || 0,
    size: cp.size ?? 0,
    md5: cp.md5 ?? null,
    contentType: cp.contentType ?? '',
    favorite,
    albumIds: [...albumIds],
    year: new Date(capturedAt || uploadedAt).getUTCFullYear(),
  };
}

// ---------------------------------------------------------------------------
// Transport

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function qs(params: Record<string, string | number>): string {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
}

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** A failed optional check is a warning: it degrades results but doesn't block scanning. */
  optional?: boolean;
}

export interface SelfTestResult {
  ok: boolean;
  checks: SelfTestCheck[];
  /** First raw node from search, for Phase 0 notes. */
  sample?: unknown;
}

type ThumbStrategy = 'direct' | 'relay' | 'redirect';

export class AmazonAdapter {
  private lastCall = 0;
  private lastSearch = 0;
  /** Told when a call is waiting out a rate limit (with a message) and when the wait ends (null). */
  onWait: ((message: string | null) => void) | null = null;
  private thumbStrategy: ThumbStrategy | null = null;
  ownerId = '';

  /** Set by the self-test: whether search honours an oldest-first sort. */
  ascendingSortWorks = false;
  /** Query parameters of the web app's own last photo search, when the page has made one. */
  readonly webSearchParams: Record<string, string> | null;

  private constructor(
    readonly tabId: number,
    readonly base: string,
    public apiDelayMs: number,
    readonly webSearchUrl: string | null,
  ) {
    this.webSearchParams = webSearchUrl ? Object.fromEntries(new URL(webSearchUrl).searchParams) : null;
  }

  /** Finds the open Amazon Photos tab and checks the relay is alive. */
  static async connect(apiDelayMs: number): Promise<AmazonAdapter> {
    const tabs = await chrome.tabs.query({ url: AMAZON_TAB_URLS });
    if (!tabs.length) throw new AmazonError('Open Amazon Photos (www.amazon.com/photos) in a tab and sign in first.');
    const tab = tabs.find((t) => t.active) ?? tabs[0];
    let hello: HelloResponse | undefined;
    try {
      hello = await chrome.tabs.sendMessage(tab.id!, { type: 'apc-hello' });
    } catch {
      throw new AmazonError('The Amazon Photos tab was opened before the extension loaded. Reload that tab and try again.');
    }
    if (!hello) throw new AmazonError('No answer from the Amazon Photos tab. Reload it and try again.');
    if (!hello.hasSession) throw new AmazonError('You do not appear to be signed in to Amazon in that tab.');
    // Prefer the API base the web app itself uses for search.
    const webBase = hello.webSearchUrl?.split('/search?')[0];
    return new AmazonAdapter(tab.id!, webBase ?? `${hello.origin}/drive/v1`, apiDelayMs, hello.webSearchUrl ?? null);
  }

  private async relay(req: RelayRequest): Promise<RelayResponse> {
    try {
      const res: RelayResponse | undefined = await chrome.tabs.sendMessage(this.tabId, { type: 'apc-fetch', req });
      if (!res) throw new Error('empty relay response');
      return res;
    } catch (e) {
      throw new AmazonError(`Lost contact with the Amazon Photos tab (${String(e)}). Keep it open and reload it.`);
    }
  }

  /** Throttled API call with retry on 429/5xx. Throws on anything else. */
  private async api<T>(method: RelayRequest['method'], path: string, params: Record<string, string | number> = {}, body?: unknown): Promise<T> {
    const url = `${this.base}${path}?${qs({ ...COMMON_PARAMS, ...params })}`;
    const isSearch = path === '/search';
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(this.lastCall + this.apiDelayMs, isSearch ? this.lastSearch + Math.max(SEARCH_MIN_INTERVAL_MS, this.apiDelayMs) : 0) - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCall = Date.now();
      if (isSearch) this.lastSearch = this.lastCall;
      const res = await this.relay({ url, method, body });
      if (res.ok) return res.json as T;
      const rateLimited = res.status === 429;
      const retryable = rateLimited || res.status >= 500;
      const maxRetries = rateLimited ? RATE_LIMIT_WAITS_MS.length : 3;
      if (!retryable || attempt >= maxRetries) {
        const hint = rateLimited ? ' Amazon is still rate-limiting after waiting about 7 minutes; leave it for 15–30 minutes, then try again.' : '';
        throw new AmazonError(`${method} ${path} failed: HTTP ${res.status} ${res.error ?? ''}${hint}`.trim(), res.status, res.json ?? res.text);
      }
      // Honour Retry-After; otherwise wait 30s, 1m, 2m, 4m on 429, and 5s, 15s, 45s on server errors.
      const retryAfter = Number(res.retryAfter) * 1000;
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : rateLimited ? RATE_LIMIT_WAITS_MS[attempt] : 5000 * 3 ** attempt;
      if (rateLimited) {
        // Stay slower for the rest of this session.
        this.apiDelayMs = Math.min(MAX_API_DELAY_MS, this.apiDelayMs * 2);
        this.onWait?.(`Amazon asked us to slow down. Waiting ${Math.round(backoff / 1000)}s, then retrying (attempt ${attempt + 2} of ${maxRetries + 1})…`);
      }
      await sleep(backoff);
      this.onWait?.(null);
    }
  }

  // -------------------------------------------------------------------------
  // Reads

  async loadOwnerId(): Promise<string> {
    const res = await this.api<{ data?: RawNode[] }>('GET', '/nodes', { filters: 'isRoot:true' });
    const root = res?.data?.[0];
    if (!root?.ownerId) throw new AmazonError('Root node has no ownerId', 0, res);
    this.ownerId = root.ownerId;
    return this.ownerId;
  }

  private photoFilter(year?: number, month?: number): string {
    let f = 'type:(PHOTOS)';
    if (year !== undefined) f += ` AND timeYear:(${year})`;
    if (month !== undefined) f += ` AND timeMonth:(${month})`;
    return f;
  }

  async searchRaw(opts: { year?: number; month?: number; offset: number; limit: number; sort?: 'ASC' | 'DESC' }): Promise<{ count: number; data: RawNode[] }> {
    const res = await this.api<{ count?: number; data?: RawNode[] }>('GET', '/search', this.searchParams(opts));
    if (!res || !Array.isArray(res.data)) throw new AmazonError('Search response has no data array', 0, res);
    return { count: res.count ?? res.data.length, data: res.data };
  }

  /** Our filters and paging on top of the web app's own search parameters when known, else documented defaults. */
  searchParams(opts: { year?: number; month?: number; offset: number; limit: number; sort?: 'ASC' | 'DESC' }): Record<string, string | number> {
    const ours = { filters: this.photoFilter(opts.year, opts.month), offset: opts.offset, limit: opts.limit };
    if (!this.webSearchParams) {
      return { ...ours, lowResThumbnail: 'true', searchContext: 'customer', sort: `['contentProperties.contentDate ${opts.sort ?? 'DESC'}']` };
    }
    const params: Record<string, string | number> = { ...this.webSearchParams, ...ours };
    const sort = this.webSearchParams.sort;
    if (!sort) params.sort = `['contentProperties.contentDate ${opts.sort ?? 'DESC'}']`;
    else if (opts.sort === 'ASC') params.sort = sort.replace(/DESC/g, 'ASC');
    return params;
  }

  async countPhotos(year?: number, month?: number): Promise<number> {
    return (await this.searchRaw({ year, month, offset: 0, limit: 1 })).count;
  }

  /** Year of the oldest photo, from a single ascending search. */
  async oldestYear(): Promise<number> {
    // Without a working oldest-first sort, start early and let empty years count as zero.
    if (!this.ascendingSortWorks) return 1990;
    const { data } = await this.searchRaw({ offset: 0, limit: 1, sort: 'ASC' });
    if (!data.length) return new Date().getUTCFullYear();
    return normalizeNode(data[0]).year;
  }

  /** Photos in one search range, pages of SEARCH_PAGE_SIZE. Skips anything another account owns. */
  async searchPage(opts: { year?: number; month?: number; offset: number; sort?: 'ASC' | 'DESC' }): Promise<{ count: number; items: PhotoItem[]; skippedShared: number }> {
    const { count, data } = await this.searchRaw({ ...opts, limit: SEARCH_PAGE_SIZE });
    const items: PhotoItem[] = [];
    let skippedShared = 0;
    for (const raw of data) {
      if (raw.kind && raw.kind !== 'FILE') continue;
      if (this.ownerId && raw.ownerId && raw.ownerId !== this.ownerId) {
        skippedShared++;
        continue;
      }
      items.push(normalizeNode(raw));
    }
    return { count, items, skippedShared };
  }

  async listAlbums(): Promise<Album[]> {
    const albums: Album[] = [];
    let startToken: string | undefined;
    do {
      const params: Record<string, string | number> = { filters: 'kind:VISUAL_COLLECTION', limit: 200 };
      if (startToken) params.startToken = startToken;
      const res = await this.api<{ data?: (RawNode & { childAssetTypeInfo?: unknown; collectionProperties?: { covers?: unknown } })[]; nextToken?: string; count?: number }>(
        'GET',
        '/nodes',
        params,
      );
      for (const n of res?.data ?? []) albums.push({ id: n.id, name: n.name ?? n.id, count: 0 });
      startToken = res?.nextToken;
    } while (startToken);
    return albums;
  }

  async albumChildIds(albumId: string): Promise<string[]> {
    const ids: string[] = [];
    let startToken: string | undefined;
    do {
      const params: Record<string, string | number> = { filters: 'kind:FILE', limit: 200 };
      if (startToken) params.startToken = startToken;
      const res = await this.api<{ data?: RawNode[]; nextToken?: string }>('GET', `/nodes/${encodeURIComponent(albumId)}/children`, params);
      for (const n of res?.data ?? []) ids.push(n.id);
      startToken = res?.nextToken;
    } while (startToken);
    return ids;
  }

  async getNode(id: string): Promise<RawNode> {
    return this.api<RawNode>('GET', `/nodes/${encodeURIComponent(id)}`);
  }

  /** A ~256 px thumbnail as a Blob, held in memory only. */
  async fetchThumbnail(id: string, size = 256): Promise<Blob> {
    const owner = encodeURIComponent(this.ownerId);
    const direct = `${THUMB_HOST}/${encodeURIComponent(id)}?viewBox=${size}&ownerId=${owner}`;
    const redirect = `${this.base}/nodes/${encodeURIComponent(id)}/contentRedirection?${qs({ querySuffix: `?viewBox=${size}`, ownerId: this.ownerId })}`;
    const attempts: [ThumbStrategy, () => Promise<Blob>][] = [
      ['direct', async () => {
        // Extension pages with host permission can read cross-origin images directly.
        for (let attempt = 0; ; attempt++) {
          const res = await fetch(direct, { credentials: 'include' });
          if (res.ok) return res.blob();
          if (res.status !== 429 || attempt >= 2) throw new AmazonError(`thumbnail HTTP ${res.status}`, res.status);
          await sleep(5000 * (attempt + 1));
        }
      }],
      ['relay', () => this.relayImage(direct)],
      ['redirect', () => this.relayImage(redirect)],
    ];
    const ordered = this.thumbStrategy ? [...attempts.filter(([s]) => s === this.thumbStrategy), ...attempts.filter(([s]) => s !== this.thumbStrategy)] : attempts;
    let lastErr: unknown;
    for (const [strategy, run] of ordered) {
      try {
        const blob = await run();
        if (!blob.type.startsWith('image/') || blob.size < 100) throw new AmazonError(`thumbnail is not an image (${blob.type || 'no type'}, ${blob.size} bytes)`);
        this.thumbStrategy = strategy;
        return blob;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new AmazonError(String(lastErr));
  }

  private async relayImage(url: string): Promise<Blob> {
    const res = await this.relay({ url, responseType: 'base64', headers: { accept: 'image/*' } });
    if (!res.ok || !res.base64) throw new AmazonError(`thumbnail HTTP ${res.status} ${res.error ?? ''}`, res.status);
    return base64ToBlob(res.base64, res.contentType || 'image/jpeg');
  }

  // -------------------------------------------------------------------------
  // Writes. Trash only; this extension never deletes permanently.

  private async patchTrash(op: 'add' | 'remove', ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    if (ids.length > 50) throw new AmazonError('Refusing a trash call with more than 50 items');
    await this.api('PATCH', '/trash', {}, {
      recurse: 'true',
      op,
      filters: '',
      conflictResolution: 'RENAME',
      value: ids,
      resourceVersion: 'V2',
      ContentType: 'JSON',
    });
  }

  moveToTrash(ids: string[]): Promise<void> {
    return this.patchTrash('add', ids);
  }

  restoreFromTrash(ids: string[]): Promise<void> {
    return this.patchTrash('remove', ids);
  }

  /** Node status as Amazon reports it, e.g. AVAILABLE or TRASH. */
  async nodeStatus(id: string): Promise<string> {
    return (await this.getNode(id)).status ?? 'UNKNOWN';
  }

  // -------------------------------------------------------------------------

  /** Read-only checks that every endpoint the scan relies on still answers in the expected shape. */
  async selfTest(): Promise<SelfTestResult> {
    const checks: SelfTestCheck[] = [];
    const run = async <T>(name: string, fn: () => Promise<T>, describe: (v: T) => string): Promise<T | undefined> => {
      try {
        const v = await fn();
        checks.push({ name, ok: true, detail: describe(v) });
        return v;
      } catch (e) {
        const detail = e instanceof AmazonError && e.detail ? `${e.message} — ${JSON.stringify(e.detail).slice(0, 300)}` : String(e);
        checks.push({ name, ok: false, detail });
        return undefined;
      }
    };

    checks.push({
      name: "Web app's own search",
      ok: true,
      detail: this.webSearchParams ? 'seen; copying its parameters' : 'not seen yet (scroll your photos once, then re-run); using built-in parameters',
    });
    await run('Root node / owner ID', () => this.loadOwnerId(), (o) => `ownerId ${o.slice(0, 6)}…`);
    const search = await run('Photo search', () => this.searchRaw({ offset: 0, limit: 3 }), (r) => `${r.count.toLocaleString()} photos reported`);
    const sample = search?.data[0];
    if (sample) {
      const item = normalizeNode(sample);
      checks.push({ name: 'Checksum (md5) in metadata', ok: Boolean(item.md5), detail: item.md5 ? 'present' : 'missing: exact-duplicate detection will not work' });
      checks.push({ name: 'Capture time in metadata', ok: item.capturedAt > 0, detail: item.capturedAt ? new Date(item.capturedAt).toISOString() : 'missing' });
      checks.push({
        name: 'Dimensions in metadata',
        ok: item.width > 0 && item.height > 0,
        detail: item.width > 0 ? `${item.width}×${item.height}` : 'missing; only used to break ties, so scanning can go ahead',
        optional: true,
      });
      checks.push({ name: 'Owner on items', ok: Boolean(sample.ownerId), detail: sample.ownerId === this.ownerId ? 'matches your account' : 'differs or missing' });
      await run(
        'Year filter',
        async () => {
          const c = await this.countPhotos(item.year);
          // If the filter were silently ignored, the year count would equal the whole library.
          if (c === 0 || (c === search!.count && search!.count > 1000)) throw new AmazonError(`timeYear filter looks ignored (${c} of ${search!.count})`);
          return c;
        },
        (c) => `${c.toLocaleString()} photos in ${item.year}`,
      );
      const asc = await run(
        'Oldest-first sort',
        async () => {
          const first = (await this.searchRaw({ offset: 0, limit: 1, sort: 'ASC' })).data[0];
          // The newest-first sample must not come first oldest-first too, unless the library has one photo.
          if (!first || (first.id === sample.id && search!.count > 1) || normalizeNode(first).capturedAt > item.capturedAt) {
            throw new AmazonError('oldest-first sort looks ignored');
          }
          this.ascendingSortWorks = true;
          return normalizeNode(first).capturedAt;
        },
        (t) => `oldest photo ${new Date(t).toISOString().slice(0, 10)}`,
      );
      if (asc === undefined) {
        checks[checks.length - 1].optional = true;
        checks[checks.length - 1].detail += '; scanning still works unless a month has over 9,000 photos';
      }
      await run('Thumbnail', () => this.fetchThumbnail(item.id), (b) => `${b.type}, ${(b.size / 1024).toFixed(1)} KB via ${this.thumbStrategy}`);
    } else if (search) {
      checks.push({ name: 'Sample photo', ok: false, detail: 'search returned no photos' });
    }
    await run('Album list', () => this.listAlbums(), (a) => `${a.length} album${a.length === 1 ? "" : "s"}`);
    return { ok: checks.every((c) => c.ok || c.optional), checks, sample: { webSearchUrl: this.webSearchUrl, node: sample } };
  }
}
