# amazonphotoscleanup

A personal Chrome extension that cleans up an Amazon Photos library in place. It
finds exact duplicates and bursts of near-identical shots, picks the best photo in
each group, and moves the rest to Amazon's trash after you review them. Nothing is
downloaded to disk. Rejects go to Amazon's trash, never to permanent deletion, and
an undo log can restore them.

> Amazon Photos has no public API. This extension uses the same undocumented web
> endpoints the website uses, and they can change without notice. Start with
> [docs/phase0-recon.md](docs/phase0-recon.md).

## Build and load

```sh
npm install --ignore-scripts   # skips onnxruntime-node's binary download, which isn't needed
npm run build                  # outputs dist/
npm test
```

1. Go to `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick `dist/`.
2. Open https://www.amazon.com/photos and sign in. If the tab was already open, reload it.
3. Click the extension icon to open the side panel.

Run `npm run watch` while developing, then click reload on the extension card.

## Using it

1. **Side panel.** The self-test runs on open and has to pass before anything can scan or trash.
2. Pick a scope (all photos, a year, or an album) and click **Scan**. The scan is resumable, and later scans skip unchanged years.
3. **Review** opens a full-page tab with one group per row. The suggested keeper is outlined in green, and each photo has a reason underneath.
   - **Accept** takes the suggestion. Click photos to keep several or swap the keeper. **Keep all** and **Skip** are also there.
   - **Approve all exact duplicates** accepts every undecided checksum group at once.
4. **Move N to trash** runs the self-test again, then trashes in batches of up to 50 with a pause between calls. It stops on the first error.
5. **Undo last run**, in the side panel or the review tab, restores everything from that run while it is still in Amazon's trash.

## Safety rules (enforced in code)

- Favorites and photos in albums are never trashed, whatever the review says.
- Photos uploaded by someone else (Family Vault) are skipped at scan time.
- A group is never trashed in full: a decision that keeps nothing is ignored.
- Each trash batch is logged before the next starts, and the first batch is checked against Amazon's reported status.

## How it works

| Piece | Where |
| --- | --- |
| Amazon API adapter and self-test (the only code that knows Amazon's endpoints) | `src/adapter/amazon.ts` |
| Fetch relay inside the signed-in tab, so calls use your normal session | `src/content/index.ts` |
| IndexedDB index of metadata, features, decisions, and the undo log | `src/db/store.ts` |
| Paged, resumable metadata scan and album crawl | `src/pipeline/scan.ts` |
| Thumbnail fetch and feature extraction, only for photos with a neighbour in the time window | `src/pipeline/analyze.ts`, `src/worker/` |
| Exact groups (checksum), near groups (time window + pHash/embedding, union-find with a size cap) | `src/pipeline/group.ts` |
| Best-of-N scoring: sharpness 35%, faces 30%, aesthetics 20%, exposure 15% | `src/pipeline/score.ts` |
| Trash, verify, and restore | `src/pipeline/apply.ts` |

Models load lazily inside a Web Worker:

- **CLIP** (`Xenova/clip-vit-base-patch32`, about 90 MB, cached after the first download) via Transformers.js, using WebGPU when available. The aesthetic score is zero-shot: the embedding's similarity to good-photo vs bad-photo prompts, so there are no extra weights.
- **MediaPipe Face Landmarker** for eye openness and smiles, from its blendshapes.

Both can be turned off in Settings. Scoring then uses sharpness and exposure only, and grouping uses pHash only.

## Not done yet

- Claude tiebreaker for close calls (Phase 5).
- Videos.
- Regions other than amazon.com.
