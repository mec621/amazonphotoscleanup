// Runs inside the signed-in Amazon Photos tab. It is a thin fetch relay: the
// adapter (src/adapter/amazon.ts) decides what to call, and this script makes
// the call from the page's origin so Amazon sees the normal web session.
// Keep this file free of runtime imports: content scripts can't load chunks.

import type { RelayRequest, RelayResponse } from '../adapter/relay';

const ALLOWED_HOSTS = /^(www\.amazon\.com|photos\.amazon\.com|thumbnails-photos\.amazon\.com)$/;

function sessionId(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)session-id=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function relay(req: RelayRequest): Promise<RelayResponse> {
  const url = new URL(req.url, location.href);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.test(url.hostname)) {
    return { ok: false, status: 0, error: `Blocked non-Amazon URL: ${url.hostname}` };
  }
  const headers: Record<string, string> = { accept: 'application/json, */*', ...(req.headers ?? {}) };
  const sid = sessionId();
  if (sid && url.pathname.startsWith('/drive/')) headers['x-amzn-sessionid'] = sid;
  if (req.body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await fetch(url, {
      method: req.method ?? 'GET',
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      credentials: 'include',
    });
    const contentType = res.headers.get('content-type') ?? '';
    const retryAfter = res.headers.get('retry-after') ?? undefined;
    if (req.responseType === 'base64') {
      return { ok: res.ok, status: res.status, contentType, retryAfter, base64: res.ok ? toBase64(await res.arrayBuffer()) : undefined };
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = undefined;
    }
    return { ok: res.ok, status: res.status, contentType, retryAfter, json, text: json === undefined ? text.slice(0, 2000) : undefined };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'apc-hello') {
    sendResponse({
      origin: location.origin,
      href: location.href,
      hasSession: sessionId() !== null,
      // The page's own latest photo search, left on the DOM by recorder.ts from the page's world.
      webSearchUrl: document.documentElement.dataset.apcSearchUrl ?? null,
    });
    return false;
  }
  if (msg?.type === 'apc-fetch') {
    relay(msg.req as RelayRequest).then(sendResponse);
    return true;
  }
  return false;
});
