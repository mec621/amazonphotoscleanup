# Phase 0: Recon checklist

Amazon Photos has no public API. The adapter (`src/adapter/amazon.ts`) uses the
endpoints the `amazon-photos` PyPI library documents (last confirmed Dec 2023).
Before trusting a scan or a trash run, confirm them against your own account.

## 1. Run the built-in self-test

1. Build and load the extension (see README), open https://www.amazon.com/photos and sign in.
2. Click the extension icon. The side panel runs the self-test automatically.
3. Every check should be green. Click **Copy sample response** and paste it below.

| Check | What it proves |
| --- | --- |
| Root node / owner ID | `GET /drive/v1/nodes?filters=isRoot:true` works and returns `ownerId` |
| Photo search | `GET /drive/v1/search?filters=type:(PHOTOS)` returns `{count, data[]}` |
| Checksum (md5) | `contentProperties.md5` exists, so exact dedupe works |
| Capture time | `image.dateTimeOriginal` or `contentProperties.contentDate` exists |
| Dimensions | `image.width` / `image.height` exist |
| Owner on items | items carry `ownerId`, so Family Vault photos can be skipped |
| Year filter | `timeYear:(YYYY)` narrows the search (needed to get past the ~10k offset cap) |
| Thumbnail | `thumbnails-photos.amazon.com/v1/thumbnail/{id}?viewBox=256&ownerId=…` returns an image |
| Album list | `GET /drive/v1/nodes?filters=kind:VISUAL_COLLECTION` works |

## 2. Confirm by hand in DevTools (Network tab)

Things the self-test can't check without changing your library:

- [ ] **Favorite flag.** Favorite a photo in the web UI, then find that node in a search response. Which field changed? The adapter currently checks `settings.favorite`, `isFavorite`, `favorite`, and `labels` containing `FAVORITE`. Fix `normalizeNode` if it's something else.
- [ ] **Move to trash.** Trash one photo in the web UI and record the request. The adapter sends `PATCH /drive/v1/trash` with `{recurse, op: "add", filters: "", conflictResolution: "RENAME", value: [ids], resourceVersion: "V2", ContentType: "JSON"}`.
- [ ] **Restore.** Restore it from Amazon's trash and record the request. The adapter sends the same body with `op: "remove"`.
- [ ] **Trashed status.** After trashing, `GET /drive/v1/nodes/{id}` should report `status: "TRASH"`. The apply step checks this after the first batch and stops if it doesn't match.
- [ ] **Album membership.** Does a photo node's `parentMap.VISUAL_COLLECTION` list its albums? The scan also crawls `/nodes/{album}/children`, so either source is enough.
- [ ] **Trash retention.** How long does Amazon keep trashed items? That sets the undo window.

## 3. Findings

Paste the sample response and anything that differed here, then fix `src/adapter/amazon.ts`.

```json

```
