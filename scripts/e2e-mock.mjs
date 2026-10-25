// End-to-end run of the built extension against a mocked Amazon Photos
// (scripts/mock-amazon.mjs), so the real content script, adapter, scan, review
// and trash/undo all run.
// Usage: npm run build && npm run e2e   (needs `npx playwright install chromium` once)

import assert from 'node:assert/strict';
import { launchWithMockAmazon } from './mock-amazon.mjs';

const { ctx, ext, nodes, calls, searches, state } = await launchWithMockAmazon();
const errors = [];
const amazon = await ctx.newPage();
await amazon.goto('https://www.amazon.com/photos/all');

const panel = await ctx.newPage();
panel.on('dialog', (d) => d.accept());
panel.on('pageerror', (e) => errors.push(`panel: ${e}`));
await panel.goto(`${ext}/src/ui/sidepanel/index.html`);
await panel.getByText(/^Connected/).waitFor({ timeout: 20000 });
// CLIP needs the Hugging Face hub; keep this test offline and fast.
await panel.evaluate(() => chrome.storage.local.set({ settings: { useEmbeddings: false } }));
await panel.reload();
await panel.getByText(/^Connected/).waitFor({ timeout: 20000 });
await panel.getByRole('button', { name: /^Scan/ }).click();
await panel.getByRole('button', { name: /Open review/ }).waitFor({ timeout: 60000 });
const panelText = (await panel.locator('body').innerText()).replace(/\s+/g, ' ');
assert.match(panelText, /9 photos indexed/i);
assert.match(panelText, /Connected · 1 warning/);
assert.match(panelText, /Skipped 1 photo uploaded by someone else/);
assert.match(panelText, /2 Exact duplicates 1 Similar groups 3 Photos in similar groups 4 Suggested for trash/);

const review = await ctx.newPage();
review.on('dialog', (d) => d.accept());
review.on('pageerror', (e) => errors.push(`review: ${e}`));
await review.goto(`${ext}/src/ui/review/index.html`);
await review.locator('.group-card').first().waitFor();
assert.equal(await review.locator('.group-card').count(), 3);
const near = review.locator('.group-card', { hasText: 'Similar shots' });
assert.match(await near.innerText(), /Blurry/);
await review.locator('img.thumb').nth(6).waitFor();
await review.getByRole('button', { name: /Approve exact duplicates/ }).click();
await review.selectOption('select >> nth=4', 'all');
await near.getByRole('button', { name: 'Accept' }).click();
await review.getByRole('button', { name: 'Move 4 to trash' }).click();
await review.locator('.callout.ok, .callout.error').first().waitFor({ timeout: 30000 });
assert.equal(await review.locator('.callout.ok, .callout.error').first().innerText(), 'Moved 4 photos to trash.');
const trashed = () => nodes.filter((n) => n.status === 'TRASH').map((n) => n.id).sort();
// p1 (sharpest) stays; p5 is in an album, so its copy p6 goes; x1 belongs to someone else.
assert.deepEqual(trashed(), ['p2', 'p3', 'p4copy', 'p6']);
// The page's own call has no session header (the mock page doesn't send one); every extension call must.
assert.equal(calls.filter((c) => c.includes('sid=undefined')).length, 1);
assert.ok(state.rateLimitedOnce, 'the mock rate-limited one search and the scan recovered');
// Every search after the page's own one reuses the web app's parameters.
assert.ok(searches.length > 2 && searches.slice(1).every((p) => p.get('webapp') === 'yes'), 'extension copies the web app search parameters');

await panel.reload();
await panel.getByRole('button', { name: 'Undo last run' }).click();
await panel.locator('.pill', { hasText: 'Restored' }).waitFor({ timeout: 20000 });
assert.deepEqual(trashed(), []);
assert.deepEqual(errors, []);
await ctx.close();
console.log('e2e: scan → review → trash 4 → undo: all passed');
