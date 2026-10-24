// Screenshots of the side panel and review page against the mocked Amazon,
// in light and dark mode, for checking the UI by eye.
// Usage: npm run build && node scripts/screenshots.mjs [outDir]

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithMockAmazon } from './mock-amazon.mjs';

const out = resolve(process.argv[2] ?? 'screenshots');
mkdirSync(out, { recursive: true });
const { ctx, ext } = await launchWithMockAmazon({ rateLimitFirstSearch: false });
await (await ctx.newPage()).goto('https://www.amazon.com/photos/all');

const panel = await ctx.newPage();
await panel.setViewportSize({ width: 380, height: 900 });
await panel.goto(`${ext}/src/ui/sidepanel/index.html`);
await panel.evaluate(() => chrome.storage.local.set({ settings: { useEmbeddings: false }, scope: { kind: 'year', year: 2024 } }));
await panel.reload();
await panel.getByText(/^Connected/).waitFor({ timeout: 20000 });
await panel.screenshot({ path: `${out}/panel-before-scan.png`, fullPage: true });
await panel.getByRole('button', { name: /^Scan/ }).click();
await panel.getByRole('button', { name: /Open review/ }).waitFor({ timeout: 60000 });

const review = await ctx.newPage();
await review.setViewportSize({ width: 1280, height: 900 });
await review.goto(`${ext}/src/ui/review/index.html`);
await review.locator('img.thumb').nth(6).waitFor();
for (const scheme of ['light', 'dark']) {
  for (const p of [panel, review]) await p.emulateMedia({ colorScheme: scheme });
  await panel.screenshot({ path: `${out}/panel-${scheme}.png`, fullPage: true });
  await review.screenshot({ path: `${out}/review-${scheme}.png`, fullPage: true });
}
// Expanded connection check and settings.
await panel.emulateMedia({ colorScheme: 'light' });
for (const d of await panel.locator('details').all()) await d.evaluate((el) => el.setAttribute('open', ''));
await panel.screenshot({ path: `${out}/panel-expanded.png`, fullPage: true });
await ctx.close();
console.log(`screenshots in ${out}`);
