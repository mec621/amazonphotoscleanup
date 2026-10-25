import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { allRuns } from '../../db/store';
import { restoreRun, verifyRun } from '../../pipeline/apply';
import type { Progress } from '../../pipeline/scan';
import { loadSettings } from '../../shared/settings';
import type { TrashRun } from '../../shared/types';
import { Callout, ProgressBar } from '../components';
import { Thumb } from '../thumb';
import { useAdapter } from '../useAdapter';
import '../fonts';
import '../common.css';
import '../review/review.css';
import './history.css';

const AMAZON_TRASH_URL = 'https://www.amazon.com/photos/trash';
/** Small runs are checked with Amazon as soon as the page opens. */
const AUTO_VERIFY_MAX = 60;
const RECHECK_AFTER_MS = 10 * 60 * 1000;

type Tone = 'ok' | 'warn' | 'error' | 'muted';

/** What a photo's status means for this run, in plain words. */
function photoLabel(run: TrashRun, id: string): { text: string; tone: Tone } {
  const sent = run.trashedIds.includes(id) || run.status === 'restored';
  const status = run.verified?.status[id];
  if (!sent) return { text: 'Not sent', tone: 'muted' };
  if (!status) return { text: 'Not checked yet', tone: 'muted' };
  const restored = run.status === 'restored';
  if (status === 'TRASH') return restored ? { text: 'Still in trash', tone: 'warn' } : { text: "In Amazon's trash", tone: 'ok' };
  if (status === 'AVAILABLE') return restored ? { text: 'Back in your library', tone: 'ok' } : { text: 'Still in your library', tone: 'error' };
  if (status === 'GONE') return { text: 'Deleted from trash', tone: 'warn' };
  if (status === 'UNCHECKED') return { text: "Couldn't check", tone: 'muted' };
  return { text: status, tone: 'muted' };
}

function verifySummary(run: TrashRun): { text: string; tone: 'ok' | 'warn' | 'info' } {
  if (!run.verified) return { text: 'Not checked with Amazon yet.', tone: 'info' };
  const sent = run.status === 'restored' ? run.items.map((i) => i.id) : run.trashedIds;
  const expected = run.status === 'restored' ? 'AVAILABLE' : 'TRASH';
  const good = sent.filter((id) => run.verified!.status[id] === expected).length;
  const ago = Math.max(1, Math.round((Date.now() - run.verified.at) / 60000));
  const what = run.status === 'restored' ? 'are back in your library' : "are in its trash";
  return {
    text: `Amazon confirms ${good.toLocaleString()} of ${sent.length.toLocaleString()} ${what} (checked ${ago} min ago).`,
    tone: good === sent.length ? 'ok' : 'warn',
  };
}

const RUN_TITLE: Record<TrashRun['status'], string> = {
  running: 'Interrupted run',
  done: 'Moved to trash',
  failed: 'Stopped part-way',
  restored: 'Restored with Undo',
  'restore-failed': 'Restore stopped part-way',
};

function RunCard({ run, latest, adapter, busy, onVerify, onUndo }: { run: TrashRun; latest: boolean; adapter: ReturnType<typeof useAdapter>; busy: boolean; onVerify: () => void; onUndo: () => void }) {
  const summary = verifySummary(run);
  const canUndo = latest && run.status !== 'restored' && (run.trashedIds.length > 0 || Boolean(run.inFlightIds?.length));
  return (
    <article className="group-card">
      <header className="group-head">
        <div className="group-info">
          <span className="eyebrow">
            {new Date(run.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {RUN_TITLE[run.status]}
          </span>
          <h2>
            {run.trashedIds.length.toLocaleString()} of {run.items.length.toLocaleString()} photos moved to trash
          </h2>
        </div>
        <div className="row">
          {canUndo && (
            <button className="small" onClick={onUndo} disabled={busy}>
              Undo this run
            </button>
          )}
          <button className="small primary" onClick={onVerify} disabled={busy}>
            {run.verified ? 'Check again' : 'Check with Amazon'}
          </button>
        </div>
      </header>
      <div className="stack" style={{ marginBottom: 'var(--s5)' }}>
        <Callout tone={summary.tone}>{summary.text}</Callout>
        {run.error && <Callout tone="error">{run.error}</Callout>}
      </div>
      <div className="tiles">
        {run.items.map(({ id, item }) => {
          const label = photoLabel(run, id);
          return (
            <div key={id} className="tile">
              <div className="thumb-wrap">
                <Thumb id={id} adapter={adapter.current} />
              </div>
              <div className="tile-body">
                <span className={`tag status-${label.tone}`}>{label.text}</span>
                <p className="reason">{item.name}</p>
                <span className="subtle num">
                  {item.capturedAt ? new Date(item.capturedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function App() {
  const adapter = useAdapter();
  const [runs, setRuns] = useState<TrashRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => setRuns(await allRuns()), []);

  const verify = useCallback(
    async (run: TrashRun) => {
      setBusy(true);
      setError(null);
      try {
        await verifyRun(await adapter.current(), run, setProgress);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setProgress(null);
        setBusy(false);
        await reload();
      }
    },
    [adapter.current, reload],
  );

  const undo = async (run: TrashRun) => {
    if (!confirm(`Restore ${run.trashedIds.length} photos from Amazon's trash?`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await restoreRun(await adapter.current(), run, await loadSettings(), setProgress);
      if (r.status !== 'restored') setError(r.error ?? 'Restore failed');
      await chrome.storage.local.set({ dataVersion: Date.now() });
      await verifyRun(await adapter.current(), r, setProgress);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      setBusy(false);
      await reload();
    }
  };

  useEffect(() => {
    (async () => {
      const all = await allRuns();
      setRuns(all);
      // Check the latest small run automatically, so proof is there without a click.
      const latest = all[0];
      if (latest && latest.items.length <= AUTO_VERIFY_MAX && (!latest.verified || Date.now() - latest.verified.at > RECHECK_AFTER_MS)) await verify(latest);
    })();
  }, [verify]);

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div>
            <span className="eyebrow">Undo log</span>
            <h1 className="page-title">Trash history</h1>
          </div>
          <span className="spacer" />
          <a className="button-link" href={AMAZON_TRASH_URL} target="_blank" rel="noreferrer">
            Open Amazon's Trash ↗
          </a>
        </div>
        {(progress || error) && (
          <div className="topbar-status">
            {progress && <ProgressBar progress={progress} />}
            {error && <Callout tone="error">{error}</Callout>}
          </div>
        )}
      </header>
      <main className="review-main">
        <Callout tone="info">
          Every photo the extension moves to trash is listed here. "Check with Amazon" asks Amazon about each photo, one by one, so you can see that it really is in the trash. Amazon's own Trash
          page shows the same photos.
        </Callout>
        {runs === null && <p className="empty">Loading…</p>}
        {runs?.length === 0 && (
          <div className="empty">
            <h2>Nothing has been trashed yet</h2>
            <p className="muted">Runs appear here after you click “Move to trash” on the review page.</p>
          </div>
        )}
        {runs?.map((run, i) => (
          <RunCard key={run.runId} run={run} latest={i === 0} adapter={adapter} busy={busy} onVerify={() => verify(run)} onUndo={() => undo(run)} />
        ))}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
