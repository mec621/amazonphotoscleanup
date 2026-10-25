import { AmazonError, type AmazonAdapter } from '../adapter/amazon';
import { deleteItems, putItems, putRun } from '../db/store';
import type { Settings } from '../shared/settings';
import type { Decision, Group, PhotoItem, TrashRun, TrashRunItem } from '../shared/types';
import { memberKey } from './group';
import { protectedReason } from './score';
import type { OnProgress } from './scan';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Photos to trash: members of accepted groups that the decision doesn't keep.
 * Protected photos never make the list, whatever the decision says.
 */
export function rejectsFor(groups: Group[], decisions: Map<string, Decision>, items: Map<string, PhotoItem>): TrashRunItem[] {
  const out: TrashRunItem[] = [];
  for (const g of groups) {
    const d = decisions.get(g.id);
    if (!d || d.status !== 'accepted' || d.memberKey !== memberKey(g)) continue;
    // Never trash a whole group: something must survive.
    if (!g.members.some((m) => d.keepIds.includes(m.id))) continue;
    for (const m of g.members) {
      const item = items.get(m.id);
      if (!item || m.protected || protectedReason(item) || d.keepIds.includes(m.id)) continue;
      out.push({ id: m.id, groupId: g.id, item });
    }
  }
  return out;
}

/** Of the given IDs, those Amazon reports as in trash. IDs it can't check are kept, to err toward restoring. */
async function confirmTrashed(adapter: AmazonAdapter, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    try {
      if ((await adapter.nodeStatus(id)) === 'TRASH') out.push(id);
    } catch {
      out.push(id);
    }
  }
  return out;
}

/**
 * Moves photos to Amazon's trash in throttled batches, logging each batch before and after.
 * The first batch is a single photo, checked against Amazon before anything else is sent.
 * Stops on the first error.
 */
export async function applyTrash(adapter: AmazonAdapter, items: TrashRunItem[], settings: Settings, onProgress: OnProgress): Promise<TrashRun> {
  const run: TrashRun = { runId: `run-${Date.now()}`, startedAt: Date.now(), items, trashedIds: [], status: 'running' };
  await putRun(run);
  const batches = items.length ? [items.slice(0, 1), ...chunks(items.slice(1), settings.trashBatchSize)] : [];
  try {
    for (const [i, batch] of batches.entries()) {
      const ids = batch.map((b) => b.id);
      // Logged before the call: if the call succeeds but its answer is lost, undo still knows about these.
      run.inFlightIds = ids;
      await putRun(run);
      await adapter.moveToTrash(ids);
      run.trashedIds.push(...ids);
      run.inFlightIds = undefined;
      await putRun(run);
      await deleteItems(ids);
      if (i === 0) {
        // Amazon answering 200 isn't proof; check the first photo really went to trash.
        const status = await adapter.nodeStatus(ids[0]).catch((e) => `unreadable (${e instanceof Error ? e.message : e})`);
        if (status !== 'TRASH') {
          throw new Error(`Amazon accepted the trash call but reports ${batch[0].item.name} as ${status}. Stopped after 1 photo; check Amazon's trash, and use Undo to restore it.`);
        }
      }
      onProgress({ phase: 'Moving to trash', done: run.trashedIds.length, total: items.length });
      if (i < batches.length - 1) await sleep(settings.trashDelayMs);
    }
    run.status = 'done';
  } catch (e) {
    run.status = 'failed';
    run.error = String(e instanceof Error ? e.message : e);
    if (run.inFlightIds?.length) {
      // The failed call may still have trashed some of the batch; ask Amazon which.
      const trashed = await confirmTrashed(adapter, run.inFlightIds);
      run.trashedIds.push(...trashed);
      await deleteItems(trashed);
      run.inFlightIds = undefined;
    }
  }
  run.finishedAt = Date.now();
  await putRun(run);
  return run;
}

/** Restores everything a run trashed, while Amazon still holds it in trash. */
export async function restoreRun(adapter: AmazonAdapter, run: TrashRun, settings: Settings, onProgress: OnProgress): Promise<TrashRun> {
  // A run interrupted mid-call (tab closed) left a batch in flight: restore whatever of it reached trash.
  if (run.inFlightIds?.length) {
    run.trashedIds.push(...(await confirmTrashed(adapter, run.inFlightIds)));
    run.inFlightIds = undefined;
    await putRun(run);
  }
  const byId = new Map(run.items.map((i) => [i.id, i.item]));
  const batches = chunks(run.trashedIds, settings.trashBatchSize);
  let restored = 0;
  try {
    for (const [i, ids] of batches.entries()) {
      await adapter.restoreFromTrash(ids);
      if (i === 0) {
        const status = await adapter.nodeStatus(ids[0]).catch(() => 'unreadable');
        if (status === 'TRASH') throw new Error(`Amazon accepted the restore call but ${byId.get(ids[0])?.name ?? ids[0]} is still in trash. Restore it from Amazon's Trash page.`);
      }
      await putItems(ids.map((id) => byId.get(id)!).filter(Boolean));
      restored += ids.length;
      onProgress({ phase: 'Restoring', done: restored, total: run.trashedIds.length });
      if (i < batches.length - 1) await sleep(settings.trashDelayMs);
    }
    run.status = 'restored';
    run.restoredAt = Date.now();
    run.error = undefined;
  } catch (e) {
    run.status = 'restore-failed';
    run.error = `Restored ${restored} of ${run.trashedIds.length}: ${String(e instanceof Error ? e.message : e)}`;
    // Keep only what still needs restoring, so retrying picks up where this stopped.
    run.trashedIds = run.trashedIds.slice(restored);
  }
  await putRun(run);
  return run;
}

/**
 * Asks Amazon for the current status of every photo in a run (e.g. TRASH or AVAILABLE)
 * and stores the answers on the run, so the history page can show what really happened.
 * A photo Amazon no longer knows (HTTP 404) is reported as GONE.
 */
export async function verifyRun(adapter: AmazonAdapter, run: TrashRun, onProgress: OnProgress): Promise<TrashRun> {
  const status: Record<string, string> = {};
  for (const [i, { id }] of run.items.entries()) {
    try {
      status[id] = await adapter.nodeStatus(id);
    } catch (e) {
      status[id] = e instanceof AmazonError && e.status === 404 ? 'GONE' : 'UNCHECKED';
    }
    onProgress({ phase: 'Checking with Amazon', done: i + 1, total: run.items.length });
  }
  run.verified = { at: Date.now(), status };
  await putRun(run);
  return run;
}
