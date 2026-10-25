// A fake Amazon Photos for driving the built extension in Chromium: a page at
// www.amazon.com/photos, the drive API and the thumbnail host, served by
// Playwright routes. Its responses mirror the shapes seen on a real account.

import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const dist = resolve(import.meta.dirname, '../dist');

// --- tiny PNG encoder for mock thumbnails
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w, h, f) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = Math.max(0, Math.min(255, Math.round(f(x, y)))); raw.fill(v, y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3); }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const scene = (x, y) => 128 + 60 * Math.sin(x / 9) * Math.cos(y / 13) + (((x >> 4) + (y >> 4)) % 2 ? 40 : -40);
const blurred = (x, y) => { let s = 0; for (let d = -3; d <= 3; d++) s += scene(x + d, y); return s / 7; };
const other = (x, y) => 128 + 100 * Math.sin((x * 3 + y) / 7);

// --- mock library: p1..p3 burst (p2 blurry), p4 + p4copy exact dup, p5 in album (copy of p6), p7 lone, x1 shared by someone else
const t = (s) => new Date(Date.UTC(2024, 6, 4, 12, 0, s)).toISOString();
const node = (id, sec, md5, extra = {}) => ({ id, kind: 'FILE', name: `${id}.jpg`, ownerId: 'me', status: 'AVAILABLE', createdDate: t(sec + 100), contentProperties: { md5, size: 2e6, contentType: 'image/jpeg', contentDate: t(sec) }, image: { width: 4000, height: 3000 }, ...extra });
const nodes = [
  // Like the real account: the first photo search returns has no dimensions at all.
  node('p8', 7000, 'h', { image: undefined }),
  // ...and some photos keep image details under contentProperties.
  node('p1', 0, 'a', { image: undefined, contentProperties: { md5: 'a', size: 2e6, contentType: 'image/jpeg', contentDate: t(0), image: { width: 4000, height: 3000 } } }), node('p2', 2, 'b'), node('p3', 4, 'c'), node('p4', 600, 'd'), node('p4copy', 600, 'd', { createdDate: t(9999) }), node('p5', 1200, 'e'), node('p6', 1200, 'e', { createdDate: t(9999) }), node('p7', 3000, 'f'), node('x1', 5, 'g', { ownerId: 'someone-else' })];
const thumbs = { p8: png(256, 192, (x, y) => (x ^ y) & 255), p1: png(256, 192, scene), p2: png(256, 192, blurred), p3: png(256, 192, (x, y) => scene(x, y) + 3), p4: png(256, 192, other), p4copy: png(256, 192, other), p5: png(256, 192, (x, y) => 255 - other(x, y)), p6: png(256, 192, (x, y) => 255 - other(x, y)), p7: png(256, 192, (x, y) => (x * y) % 255), x1: png(256, 192, scene) };


export async function launchWithMockAmazon({ rateLimitFirstSearch = true, rejectBuiltinSearch = false, headless = true } = {}) {
const calls = [];
const searches = [];
const state = { rateLimitedOnce: !rateLimitFirstSearch };
const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
await ctx.route('https://www.amazon.com/**', async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  if (u.pathname.startsWith('/photos')) return route.fulfill({ contentType: 'text/html', body: `<html><body><script>document.cookie="session-id=123-456; path=/";
    // Like the real web app, the page runs its own photo search; the extension should copy its parameters.
    fetch('/drive/v1/search?asset=ALL&filters=type%3A(PHOTOS)&limit=50&offset=0&sort=%5B%27contentProperties.contentDate+DESC%27%5D&webapp=yes');
    </script>Amazon Photos (mock)</body></html>` });
  const f = u.searchParams.get('filters') ?? '';
  calls.push(`${req.method()} ${u.pathname} ${f} sid=${req.headers()['x-amzn-sessionid']}`);
  if (u.pathname === '/drive/v1/search') searches.push(u.searchParams);
  // Like the real account: Amazon rate-limits the extension's first search. It must wait and retry, not fail.
  if (u.pathname === '/drive/v1/search' && req.headers()['x-amzn-sessionid'] && !state.rateLimitedOnce) {
    state.rateLimitedOnce = true;
    return route.fulfill({ status: 429, headers: { 'retry-after': '1' }, contentType: 'application/json', body: '{"message":"Rate exceeded"}' });
  }
  // Like the real account: one style of search parameters can be rejected outright.
  if (rejectBuiltinSearch && u.pathname === '/drive/v1/search' && req.headers()['x-amzn-sessionid'] && u.searchParams.get('webapp') !== 'yes') {
    state.rejected400 = (state.rejected400 ?? 0) + 1;
    return route.fulfill({ status: 400, contentType: 'application/json', body: '{"message":"Invalid parameter"}' });
  }
  const json = (o) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
  if (u.pathname === '/drive/v1/nodes' && f === 'isRoot:true') return json({ data: [{ id: 'root', ownerId: 'me' }] });
  if (u.pathname === '/drive/v1/nodes' && f.startsWith('kind:VISUAL_COLLECTION')) return json({ data: [{ id: 'al1', name: 'Trip', kind: 'VISUAL_COLLECTION' }] });
  if (u.pathname === '/drive/v1/nodes/al1/children') return json({ data: [{ id: 'p5' }] });
  if (u.pathname.startsWith('/drive/v1/nodes/')) return json(nodes.find((n) => n.id === u.pathname.split('/').pop()));
  if (u.pathname === '/drive/v1/search') {
    const year = f.match(/timeYear:\((\d+)\)/)?.[1];
    let live = nodes.filter((n) => n.status === 'AVAILABLE' && (!year || n.contentProperties.contentDate.startsWith(year)));
    if ((u.searchParams.get('sort') ?? '').includes('ASC')) live = [...live].reverse();
    const off = Number(u.searchParams.get('offset')), lim = Number(u.searchParams.get('limit'));
    return json({ count: live.length, data: live.slice(off, off + lim) });
  }
  if (u.pathname === '/drive/v1/trash' && req.method() === 'PATCH') {
    const body = JSON.parse(req.postData());
    calls.push(`  trash body op=${body.op} value=${body.value.join(',')}`);
    for (const id of body.value) nodes.find((n) => n.id === id).status = body.op === 'add' ? 'TRASH' : 'AVAILABLE';
    return json({});
  }
  return route.fulfill({ status: 404, body: 'nope' });
});
await ctx.route('https://thumbnails-photos.amazon.com/**', (route) => {
  const id = new URL(route.request().url()).pathname.split('/').pop();
  return thumbs[id] ? route.fulfill({ contentType: 'image/png', body: thumbs[id] }) : route.fulfill({ status: 404 });
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const ext = `chrome-extension://${new URL(sw.url()).host}`;
return { ctx, ext, nodes, calls, searches, state };
}
