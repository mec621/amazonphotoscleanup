import type { AmazonAdapter } from '../adapter/amazon';
import { deleteItems, putItems, putRun } from '../db/store';
import type { Settings } from '../shared/settings';
import type { Decision, Group, PhotoItem, TrashRun, TrashRunItem } from '../shared/types';
import { memberKey } from './group';
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
      if (!item || m.protected || item.favorite || item.albumIds.length || d.keepIds.includes(m.id)) continue;
      out.push({ id: m.id, groupId: g.id, item });
    }
  }
  return out;
}

/** Moves photos to Amazon's trash in throttled batches, logging each batch before and after. Stops on the first error. */
export async function applyTrash(adapter: AmazonAdapter, items: TrashRunItem[], settings: Settings, onProgress: OnProgress): Promise<TrashRun> {
  const run: TrashRun = { runId: `run-${Date.now()}`, startedAt: Date.now(), items, trashedIds: [], status: 'running' };
  await putRun(run);
  const batches = chunks(items, settings.trashBatchSize);
  try {
    for (const [i, batch] of batches.entries()) {
      const ids = batch.map((b) => b.id);
      await adapter.moveToTrash(ids);
      run.trashedIds.push(...ids);
      await putRun(run);
      await deleteItems(ids);
      if (i === 0) {
        // Amazon answering 200 isn't proof; check the first item really went to trash.
        const status = await adapter.nodeStatus(ids[0]);
        if (status !== 'TRASH') throw new Error(`Amazon accepted the trash call but reports ${batch[0].item.name} as ${status}. Stopping.`);
      }
      onProgress({ phase: 'Moving to trash', done: run.trashedIds.length, total: items.length });
      if (i < batches.length - 1) await sleep(settings.trashDelayMs);
    }
    run.status = 'done';
  } catch (e) {
    run.status = 'failed';
    run.error = String(e instanceof Error ? e.message : e);
  }
  run.finishedAt = Date.now();
  await putRun(run);
  return run;
}

/** Restores everything a run trashed, while Amazon still holds it in trash. */
export async function restoreRun(adapter: AmazonAdapter, run: TrashRun, settings: Settings, onProgress: OnProgress): Promise<TrashRun> {
  const byId = new Map(run.items.map((i) => [i.id, i.item]));
  const batches = chunks(run.trashedIds, settings.trashBatchSize);
  let restored = 0;
  try {
    for (const [i, ids] of batches.entries()) {
      await adapter.restoreFromTrash(ids);
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
